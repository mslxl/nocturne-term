#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies an exited Terminal Agent registry session opens from the Terminal Sessions
 * ToolTab as a read-only history Terminal ToolTab.
 *
 * Operation:
 * Starts the shared Tauri dev server, seeds an isolated local registry and
 * transcript for an exited session, launches the real app, opens Terminal Sessions,
 * clicks View History, and inspects the opened Terminal ToolTab.
 *
 * Expected:
 * The saved transcript appears in a Terminal ToolTab, the pane is disconnected
 * and read-only/history-only, and Nocturne does not start or attach a live PTY
 * for the registry session.
 */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";
import { optionalEnvPath, resolveTauriTestApplication } from "./tauri-test-application.mjs";
import { test } from "vitest";

test("terminal sessions history opens read-only terminal tooltab", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = await resolveTauriTestApplication(repoRoot);
  const isolatedAppConfig = await createIsolatedAppConfigEnv("terminal-sessions-history-tooltab");
  const fixtureHostId = "018f6eb3-6f91-7410-bc43-f927b2236d98";
  const fixtureSessionId = "terminal-session-history";
  const fixtureTranscriptText = "history transcript from exited registry";
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
  await seedExitedLocalTerminalSession();

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
    await waitUntil(
      async () => {
        const state = await terminalSessionsState();
        return state.fixtureRowCount === 1 && state.text.includes("Exited History") && state.text.includes("Exited");
      },
      async () => `Terminals did not render the exited registry row\n${JSON.stringify(await terminalSessionsState(), null, 2)}\n${await pageSummary()}`,
    );

    const before = await terminalHistoryState();
    await clickViewHistory(fixtureSessionId);
    await waitUntil(
      async () => {
        const state = await terminalHistoryState();
        return state.historySurfaceCount === before.historySurfaceCount + 1 &&
          state.historyText.includes(fixtureTranscriptText) &&
          state.historyPanes.some((pane) =>
            pane.agentSessionId === fixtureSessionId &&
            pane.readOnly === "true" &&
            pane.status === "disconnected" &&
            pane.exitText === "History"
          );
      },
      async () => `Terminal history ToolTab did not open read-only history mode\n${JSON.stringify(await terminalHistoryState(), null, 2)}\n${await pageSummary()}\n${driverOutput}`,
    );

    const after = await terminalHistoryState();
    if (after.runningAgentPaneCount !== 0) {
      throw new Error(`History mode started or attached a live Terminal Agent pane\n${JSON.stringify(after, null, 2)}\n${await pageSummary()}\n${driverOutput}`);
    }
    if (after.fixtureRegistryRows !== 1 || !after.sessionsText.includes("Exited History")) {
      throw new Error(`Opening history should not remove the exited registry row\n${JSON.stringify(after, null, 2)}\n${await pageSummary()}\n${driverOutput}`);
    }

    console.log("tauri terminal sessions history ToolTab test passed");
  } finally {
    if (sessionId) {
      await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
    }
    stopProcess(tauriDriver);
    await devServer.close();
    await isolatedAppConfig.cleanup();
  }

  async function seedExitedLocalTerminalSession() {
    const stateRoot = terminalAgentStateRoot();
    await rm(stateRoot, { recursive: true, force: true });
    await mkdir(stateRoot, { recursive: true });
    const registry = {
      version: 1,
      session_id: fixtureSessionId,
      host_id: fixtureHostId,
      title: "Exited History",
      command: "bash",
      cwd: "/workspace",
      created_at: "2026-06-25T00:00:00Z",
      agent_version: "0.1.0",
      protocol_version: 1,
      cols: 80,
      rows: 24,
      endpoint: {
        kind: process.platform === "win32" ? "windows_named_pipe" : "unix_socket",
        path: process.platform === "win32" ? String.raw`\\.\pipe\nocturne-terminal-session-history` : "/tmp/nocturne-terminal-session-history.sock",
      },
      transcript: `${fixtureSessionId}.ndjson`,
      exit: {
        code: 0,
        reason: "closed",
        exited_at: "2026-06-25T00:00:00Z",
      },
    };
    const transcriptLine = JSON.stringify({
      seq: 0,
      timestamp: "2026-06-25T00:00:01Z",
      data: Buffer.from(fixtureTranscriptText).toString("base64"),
    });
    await writeFile(join(stateRoot, `${fixtureSessionId}.toml`), toToml(registry));
    await writeFile(join(stateRoot, registry.transcript), `${transcriptLine}\n`);
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
      `version = 1\nid = "${fixtureHostId}"\nname = "Session Host"\nprotocol = "local"\n\n[local]\nargs = []\nenv = {}\n\n[terminal]\nagent_mode = "enabled"\n`,
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

  async function clickViewHistory(sessionIdValue) {
    return await execute(`
      const row = document.querySelector('[data-testid="terminal-session-row"][data-session-id="' + arguments[0] + '"]');
      if (!row) throw new Error('Terminal session row not found');
      const button = row.querySelector('button[title="View History"]');
      if (!button) throw new Error('View History button not found');
      button.click();
    `, [sessionIdValue]);
  }

  async function terminalSessionsState() {
    return await execute(`
      const tooltab = document.querySelector('[data-testid="terminal-sessions-tooltab"]');
      return {
        visible: Boolean(tooltab),
        rowCount: tooltab?.querySelectorAll('[data-testid="terminal-session-row"]').length ?? 0,
        fixtureRowCount: tooltab?.querySelectorAll('[data-testid="terminal-session-row"][data-session-id="terminal-session-history"]').length ?? 0,
        text: tooltab?.textContent?.trim() ?? '',
      };
    `);
  }

  async function terminalHistoryState() {
    return await execute(`
      return (() => {
        const rows = [...document.querySelectorAll('[data-testid="terminal-session-row"]')];
        const surfaces = [...document.querySelectorAll('[data-testid="terminal-surface"]')];
        const historyPanes = surfaces.map((surface) => {
          const terminalText = surface.querySelector('.xterm-rows')?.textContent ?? surface.textContent ?? '';
          return {
            sessionId: surface.getAttribute('data-session-id') ?? '',
            runtimeTitle: surface.getAttribute('data-terminal-runtime-title') ?? '',
            terminalText,
            readOnly: surface.getAttribute('data-terminal-read-only') ?? '',
            status: surface.getAttribute('data-terminal-status') ?? '',
            exitText: surface.getAttribute('data-terminal-exit-text') ?? '',
            agentSessionId: surface.getAttribute('data-agent-session-id') ?? '',
          };
        });
        return {
          registryRows: rows.length,
          fixtureRegistryRows: rows.filter((row) => row.getAttribute('data-session-id') === 'terminal-session-history').length,
          sessionsText: document.querySelector('[data-testid="terminal-sessions-tooltab"]')?.textContent?.trim() ?? '',
          surfaceCount: surfaces.length,
          historySurfaceCount: historyPanes.filter((pane) => pane.agentSessionId === 'terminal-session-history').length,
          historyText: historyPanes.map((pane) => pane.terminalText).join('\\n'),
          historyPanes,
          runningAgentPaneCount: historyPanes.filter((pane) => pane.agentSessionId === 'terminal-session-history' && pane.status === 'running').length,
        };
      })();
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
        dockGroups: [...document.querySelectorAll('[data-dock-group-id]')].map((item) => ({
          id: item.getAttribute('data-dock-group-id'),
          role: item.getAttribute('data-dock-group-role'),
          activeSlotId: item.getAttribute('data-active-tool-slot-id'),
          panes: [...item.querySelectorAll('[data-tool-pane-slot-id]')].map((pane) => ({
            slotId: pane.getAttribute('data-tool-pane-slot-id'),
            hidden: pane.hasAttribute('hidden'),
            text: pane.textContent?.slice(0, 120) ?? '',
          })),
          tabs: [...item.querySelectorAll('[data-tool-slot-id]')].map((tab) => ({
            slotId: tab.getAttribute('data-tool-slot-id'),
            toolTabId: tab.getAttribute('data-tool-tab-id'),
            kind: tab.getAttribute('data-tool-kind'),
            active: tab.getAttribute('aria-selected'),
          })),
        })),
        terminals: [...document.querySelectorAll('[data-testid="terminal-surface"]')].map((item) => ({
          sessionId: item.getAttribute('data-session-id'),
          title: item.getAttribute('aria-label'),
          text: item.textContent?.slice(0, 300) ?? '',
        })),
      };
    `).then((summary) => JSON.stringify(summary, null, 2));
  }

  function stopProcess(child) {
    if (!child.pid || child.exitCode !== null) return;
    child.kill();
  }
});
