#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies the Terminal Sessions ToolTab, displayed as Terminals, stays usable in a narrow side panel
 * without exposing a native scrollbar when the registry list is long.
 *
 * Operation:
 * Starts the shared Tauri dev server, seeds an isolated app config root with a
 * large set of exited terminal-session registries for the local host, launches
 * the real app, opens the Terminal Sessions ToolTab, narrows the right dock
 * group in the live DOM, and measures the session list viewport and rows.
 *
 * Expected:
 * The Terminal Sessions ToolTab renders the list inside an OverlayScrollbars
 * viewport, the list stays within the narrow dock bounds, and the browser does
 * not expose a native vertical scrollbar on the right sidebar.
 */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";
import { optionalEnvPath, resolveTauriTestApplication } from "./tauri-test-application.mjs";
import { test } from "vitest";

test("terminal sessions narrow scrollbar", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = await resolveTauriTestApplication(repoRoot);
  const isolatedAppConfig = await createIsolatedAppConfigEnv("terminal-sessions-narrow-scrollbar");
  const fixtureHostId = "018f6eb3-6f91-7410-bc43-f927b2236d98";
  const isolatedStateRoot = process.platform === "win32"
    ? join(isolatedAppConfig.root, "localappdata")
    : join(isolatedAppConfig.root, "xdg-state");
  if (process.platform === "win32") {
    isolatedAppConfig.env.LOCALAPPDATA = isolatedStateRoot;
  } else {
    isolatedAppConfig.env.XDG_STATE_HOME = isolatedStateRoot;
  }
  const nativeDriverPath = optionalEnvPath("TAURI_TEST_NATIVE_DRIVER");
  const nativeDriverPort = process.env.TAURI_TEST_NATIVE_DRIVER_PORT ?? "";
  const driverPort = Number(process.env.TAURI_TEST_DRIVER_PORT ?? "4444");
  const driverUrl = `http://127.0.0.1:${driverPort}`;
  const devUrl = process.env.TAURI_TEST_DEV_URL ?? "http://127.0.0.1:1420/";
  const devPort = Number(new URL(devUrl).port);
  const nativeDriverArgs = [
    ...(nativeDriverPath ? ["--native-driver", nativeDriverPath] : []),
    ...(nativeDriverPort ? ["--native-port", nativeDriverPort] : []),
  ];

  process.chdir(repoRoot);
  process.env.NOCTURNE_DEV_PORT = String(devPort);
  isolatedAppConfig.env.NOCTURNE_DEV_PORT = String(devPort);

  await configureFixtureHost();

  const devServer = await createServer({
    server: {
      host: "127.0.0.1",
      port: devPort,
      strictPort: true,
    },
    envDir: repoRoot,
    logLevel: "silent",
  });
  await devServer.listen();

  const tauriDriver = spawn("tauri-driver", ["--port", String(driverPort), ...nativeDriverArgs], {
    cwd: repoRoot,
    env: isolatedAppConfig.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let driverOutput = "";
  tauriDriver.stdout.on("data", (chunk) => {
    driverOutput += chunk.toString();
  });
  tauriDriver.stderr.on("data", (chunk) => {
    driverOutput += chunk.toString();
  });

  let sessionId = "";

  try {
    await waitForDevServer();
    await waitForDriver();
    sessionId = await createSession();
    await waitUntil(async () => await hasTestHooks(), async () => `Nocturne test hooks were not published\n${await pageSummary()}`);
    await openTerminalSessionsViaTestHook();
    await waitUntil(async () => (await terminalSessionsState()).text.includes("No sessions"), async () => `Terminals did not show the empty state\n${JSON.stringify(await terminalSessionsState(), null, 2)}\n${await pageSummary()}`);

    const emptyMeasurement = await measureNarrowSessionsPane();
    if (!emptyMeasurement.ok) {
      throw new Error(`${emptyMeasurement.reason}\n${JSON.stringify(emptyMeasurement, null, 2)}\n${await pageSummary()}\n${driverOutput}`);
    }
    if (
      emptyMeasurement.usesNativeScrollbar ||
      emptyMeasurement.pageHasNativeScrollbar ||
      emptyMeasurement.dockGroupHasNativeScrollbar ||
      emptyMeasurement.tabbarHasNativeScrollbar
    ) {
      throw new Error(`Terminals empty state exposed a scrollbar\n${JSON.stringify(emptyMeasurement, null, 2)}\n${await pageSummary()}\n${driverOutput}`);
    }
    if (emptyMeasurement.usesOverlayScrollbars) {
      throw new Error(`Terminals empty state should not create an overlay scrollbar host\n${JSON.stringify(emptyMeasurement, null, 2)}\n${await pageSummary()}\n${driverOutput}`);
    }

    await seedLocalTerminalSessions(isolatedAppConfig.root);
    await clickRefreshTerminalSessions();
    await waitUntil(async () => (await terminalSessionsState()).rowCount >= 10, async () => `Terminals did not render registry rows\n${JSON.stringify(await terminalSessionsState(), null, 2)}\n${await pageSummary()}`);
    await waitUntil(async () => {
      const state = await terminalSessionsState();
      return state.overflow === "true" && state.usesOverlayScrollbars;
    }, async () => `Terminals did not switch to overlay scrolling after overflow\n${JSON.stringify(await terminalSessionsState(), null, 2)}\n${await pageSummary()}`);

    const measurement = await measureNarrowSessionsPane();
    if (!measurement.ok) {
      throw new Error(`${measurement.reason}\n${JSON.stringify(measurement, null, 2)}\n${await pageSummary()}\n${driverOutput}`);
    }
    if (measurement.usesNativeScrollbar) {
      throw new Error(`Terminals exposed a native scrollbar in the narrow side panel\n${JSON.stringify(measurement, null, 2)}\n${await pageSummary()}\n${driverOutput}`);
    }
    if (measurement.pageHasNativeScrollbar || measurement.dockGroupHasNativeScrollbar || measurement.tabbarHasNativeScrollbar) {
      throw new Error(`Terminals narrow side panel leaked a native outer scrollbar\n${JSON.stringify(measurement, null, 2)}\n${await pageSummary()}\n${driverOutput}`);
    }
    if (!measurement.verticalTabTitles.includes("Terms")) {
      throw new Error(`Terminals vertical rail did not use the compact title\n${JSON.stringify(measurement, null, 2)}\n${await pageSummary()}\n${driverOutput}`);
    }

    console.log("tauri terminal sessions narrow-scrollbar unit test passed");
  } finally {
    if (sessionId) {
      await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
    }
    stopProcess(tauriDriver);
    await devServer.close();
    await isolatedAppConfig.cleanup();
  }

  async function seedLocalTerminalSessions(rootDir) {
    const stateRoot = terminalAgentStateRoot();
    await rm(stateRoot, { recursive: true, force: true });
    await mkdir(stateRoot, { recursive: true });
    const sessionCount = 18;
    for (let index = 0; index < sessionCount; index += 1) {
      const sessionId = `terminal-session-${String(index + 1).padStart(2, "0")}`;
      const registry = {
        version: 1,
        session_id: sessionId,
        host_id: fixtureHostId,
        title: `Session ${index + 1}`,
        command: "bash",
        cwd: "/workspace",
        created_at: "2026-06-25T00:00:00Z",
        agent_version: "0.1.0",
        protocol_version: 1,
        cols: 80,
        rows: 24,
        endpoint: {
          kind: "unix_socket",
          path: `/tmp/${sessionId}.sock`,
        },
        transcript: `${sessionId}.ndjson`,
        exit: {
          code: 0,
          reason: "closed",
          exited_at: "2026-06-25T00:00:00Z",
        },
      };
      await writeFile(join(stateRoot, `${sessionId}.toml`), toToml(registry));
      await writeFile(join(stateRoot, `${sessionId}.ndjson`), "");
    }
  }

  function terminalAgentStateRoot() {
    if (process.platform === "win32") {
      return join(isolatedStateRoot, "Nocturne", "terminal-sessions");
    }
    return join(isolatedStateRoot, "nocturne", "terminal-sessions");
  }

  async function configureFixtureHost() {
    const configRoot = isolatedAppConfig.env.NOCTURNE_CONFIG_ROOT;
    const hostsDir = resolve(configRoot, "hosts");
    const profilesDir = resolve(configRoot, "profiles");
    await mkdir(hostsDir, { recursive: true });
    await mkdir(profilesDir, { recursive: true });
    await writeFile(
      resolve(configRoot, "config.toml"),
      `default_host = "${fixtureHostId}"\nopenssh_config_files = []\n\n[files]\ndefault_view_mode = "tree"\n`,
    );
    await writeFile(resolve(profilesDir, "default.toml"), "");
    await writeFile(
      resolve(hostsDir, `${fixtureHostId}.toml`),
      `version = 1\nid = "${fixtureHostId}"\nname = "Session Host"\nprotocol = "local"\n\n[local]\nargs = []\nenv = {}\n`,
    );
  }

  function toToml(registry) {
    return [
      `version = ${registry.version}`,
      `session_id = "${registry.session_id}"`,
      `host_id = "${registry.host_id}"`,
      `title = "${registry.title}"`,
      `command = "${registry.command}"`,
      `cwd = "${registry.cwd}"`,
      `created_at = "${registry.created_at}"`,
      `agent_version = "${registry.agent_version}"`,
      `protocol_version = ${registry.protocol_version}`,
      `cols = ${registry.cols}`,
      `rows = ${registry.rows}`,
      `transcript = "${registry.transcript}"`,
      `[endpoint]`,
      `kind = "${registry.endpoint.kind}"`,
      `path = "${registry.endpoint.path.replace(/\\/g, "\\\\")}"`,
      `[exit]`,
      `code = ${registry.exit.code}`,
      `reason = "${registry.exit.reason}"`,
      `exited_at = "${registry.exit.exited_at}"`,
      "",
    ].join("\n");
  }

  async function hasTestHooks() {
    return await execute(`
      return Boolean(window.__NOCTURNE_TEST_HOOKS__);
    `);
  }

  async function openTerminalSessionsViaTestHook() {
    return await execute(`
      const hooks = window.__NOCTURNE_TEST_HOOKS__;
      if (!hooks) throw new Error('Nocturne test hooks not found');
      hooks.openTerminalSessions();
    `);
  }

  async function clickRefreshTerminalSessions() {
    return await execute(`
      const button = document.querySelector('[data-testid="terminal-sessions-tooltab"] button[aria-label="Refresh terminals"]');
      if (!button) throw new Error('Terminals refresh button not found');
      button.click();
    `);
  }

  async function terminalSessionsToolVisible() {
    return await execute(`
      return Boolean(document.querySelector('[data-testid="terminal-sessions-tooltab"]'));
    `);
  }

  async function measureNarrowSessionsPane() {
    return await execute(`
      return (() => {
        const tooltab = document.querySelector('[data-testid="terminal-sessions-tooltab"]');
        const dockGroup = tooltab?.closest('.workspace-dock-group');
        const sessionsBody = tooltab?.querySelector('.sessions-body');
        const scrollBody = tooltab?.querySelector('.sessions-body-scroll');
        const viewport = scrollBody?.matches('[data-overlayscrollbars-viewport]')
          ? scrollBody
          : scrollBody?.querySelector('[data-overlayscrollbars-viewport]');
        const verticalTabbar = dockGroup?.querySelector('.tool-tabbar');
        const verticalTabs = [...(dockGroup?.querySelectorAll('.tool-tab') ?? [])];
        const rows = [...(tooltab?.querySelectorAll('[data-testid="terminal-session-row"]') ?? [])];
        const tooltabRect = tooltab?.getBoundingClientRect();
        const dockGroupRect = dockGroup?.getBoundingClientRect();
        const tabbarRect = verticalTabbar?.getBoundingClientRect();
        const bodyRect = sessionsBody?.getBoundingClientRect();
        const scrollBodyRect = scrollBody?.getBoundingClientRect();
        const viewportRect = viewport?.getBoundingClientRect();
        const pageElements = [
          document.documentElement,
          document.body,
          document.querySelector('.workspace'),
          document.querySelector('.workspace-body'),
        ].filter(Boolean);
        const requiresOverlay = rows.length >= 10;
        return {
          ok: Boolean(tooltab && dockGroup && sessionsBody && tooltabRect && bodyRect && (!requiresOverlay || (scrollBody && viewport && viewportRect))),
          reason: !tooltab ? 'Terminals ToolTab missing'
            : !dockGroup ? 'Terminals dock group missing'
            : !sessionsBody ? 'Terminals body missing'
            : requiresOverlay && !scrollBody ? 'Terminals scroll body missing'
            : requiresOverlay && !viewport ? 'Terminals overlay viewport missing'
          : '',
          usesOverlayScrollbars: Boolean(scrollBody?.closest('.os-host, [data-overlayscrollbars]') || scrollBody?.querySelector('[data-overlayscrollbars-viewport]')),
          usesNativeScrollbar: Boolean(scrollBody && scrollBody.scrollHeight > scrollBody.clientHeight + 1 && getComputedStyle(scrollBody).overflowY !== 'hidden'),
          pageHasNativeScrollbar: pageElements.some((element) => (
            element.scrollHeight > element.clientHeight + 1 ||
            element.scrollWidth > element.clientWidth + 1
          ) && getComputedStyle(element).overflow !== 'hidden'),
          dockGroupHasNativeScrollbar: Boolean(dockGroup && (
            dockGroup.scrollHeight > dockGroup.clientHeight + 1 ||
            dockGroup.scrollWidth > dockGroup.clientWidth + 1
          ) && getComputedStyle(dockGroup).overflow !== 'hidden'),
          tabbarHasNativeScrollbar: Boolean(verticalTabbar && (
            (verticalTabbar.scrollHeight > verticalTabbar.clientHeight + 1 && getComputedStyle(verticalTabbar).overflowY !== 'hidden') ||
            (verticalTabbar.scrollWidth > verticalTabbar.clientWidth + 1 && getComputedStyle(verticalTabbar).overflowX !== 'hidden')
          )),
          verticalTabTitles: verticalTabs.map((tab) => tab.querySelector('.tool-title')?.textContent?.trim() ?? ''),
          verticalTabMaxHeight: verticalTabs.reduce((max, tab) => Math.max(max, Math.round(tab.getBoundingClientRect().height)), 0),
          tooltabRect: tooltabRect ? { width: Math.round(tooltabRect.width), height: Math.round(tooltabRect.height) } : null,
          dockGroupRect: dockGroupRect ? { width: Math.round(dockGroupRect.width), height: Math.round(dockGroupRect.height) } : null,
          tabbarRect: tabbarRect ? { width: Math.round(tabbarRect.width), height: Math.round(tabbarRect.height) } : null,
          bodyRect: bodyRect ? { width: Math.round(bodyRect.width), height: Math.round(bodyRect.height) } : null,
          scrollBodyRect: scrollBodyRect ? { width: Math.round(scrollBodyRect.width), height: Math.round(scrollBodyRect.height) } : null,
          viewportRect: viewportRect ? { width: Math.round(viewportRect.width), height: Math.round(viewportRect.height) } : null,
          rowCount: rows.length,
          firstRow: rows[0]?.textContent?.trim() ?? '',
        };
      })();
    `);
  }

  async function terminalSessionsState() {
    return await execute(`
      const tooltab = document.querySelector('[data-testid="terminal-sessions-tooltab"]');
      return {
        visible: Boolean(tooltab),
        rowCount: tooltab?.querySelectorAll('[data-testid="terminal-session-row"]').length ?? 0,
        overflow: tooltab?.querySelector('.sessions-body')?.dataset.sessionsOverflow ?? '',
        usesOverlayScrollbars: Boolean(tooltab?.querySelector('[data-overlayscrollbars-viewport]')),
        text: tooltab?.textContent?.trim() ?? '',
      };
    `);
  }

  async function createSession() {
    const response = await webdriver("POST", "/session", {
      capabilities: {
        alwaysMatch: {
          browserName: "wry",
          "tauri:options": {
            application: appPath,
          },
        },
      },
    });
    const id = response.value?.sessionId ?? response.sessionId;
    if (!id) throw new Error(`WebDriver did not return a session id: ${JSON.stringify(response)}`);
    return id;
  }

  async function execute(script, args = []) {
    const response = await webdriver("POST", `/session/${sessionId}/execute/sync`, {
      script,
      args,
    });
    return response.value;
  }

  async function webdriver(method, path, body) {
    const response = await fetch(`${driverUrl}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(`WebDriver ${method} ${path} failed: ${response.status} ${text}\n${driverOutput}`);
    }
    return json;
  }

  async function waitForDriver() {
    await waitUntil(async () => {
      try {
        const response = await fetch(`${driverUrl}/status`);
        return response.ok;
      } catch {
        return false;
      }
    }, `tauri-driver did not start\n${driverOutput}`);
  }

  async function waitForDevServer() {
    await waitUntil(async () => {
      try {
        const response = await fetch(devUrl);
        return response.ok;
      } catch {
        return false;
      }
    }, "Vite dev server did not start");
  }

  async function waitUntil(check, errorMessage, timeoutMs = 30_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (tauriDriver.exitCode !== null) {
        throw new Error(`tauri-driver exited early with code ${tauriDriver.exitCode}\n${driverOutput}`);
      }
      if (await check()) return;
      await delay(250);
    }
    throw new Error(typeof errorMessage === "function" ? await errorMessage() : errorMessage);
  }

  function delay(ms) {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
  }

  async function pageSummary() {
    if (!sessionId) return "no WebDriver session";
    return await execute(`
      return {
        title: document.title,
        url: location.href,
        bodyText: document.body?.innerText?.slice(0, 1000) ?? '',
        workspaceDebug: window.__NOCTURNE_WORKSPACE_DEBUG__ ?? null,
        terminalSessions: document.querySelector('[data-testid="terminal-sessions-tooltab"]')?.textContent?.slice(0, 400) ?? '',
      };
    `).then((summary) => JSON.stringify(summary, null, 2));
  }

  function stopProcess(child) {
    if (!child.pid || child.exitCode !== null) return;
    child.kill();
  }
});
