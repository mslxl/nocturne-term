#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies ToolTab bar collapse behavior for side and bottom Dock groups in
 * the real Tauri WebView.
 *
 * Operation:
 * Starts the shared Vite dev server, starts tauri-driver, launches the Tauri
 * application provided by TAURI_TEST_APPLICATION, waits for the default
 * Workspace, clicks the active Files ToolTab in the left group, the active
 * Resource Monitor ToolTab in the right group, the active Ports ToolTab in the
 * bottom group, clicks the inactive Transfers ToolTab in the collapsed right
 * group, and clicks the active Terminal ToolTab in the top content group.
 *
 * Expected:
 * Active side and bottom ToolTab clicks collapse only their own Dock group and
 * leave the ToolTab bar visible without a placeholder or an unusable adjacent
 * resize handle. Clicking a different ToolTab in a collapsed group expands that
 * group and restores the resize handle. Clicking the active top ToolTab does
 * not collapse the content group.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";
import { test } from "vitest";

test("side and bottom ToolTab bars collapse their Dock group", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("tooltab-side-bottom-collapse");
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

  const tauriDriver = spawn(
    "tauri-driver",
    ["--port", String(driverPort), ...nativeDriverArgs],
    {
      cwd: repoRoot,
      env: isolatedAppConfig.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

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

    await waitUntil(async () => {
      const state = await dockState();
      return state.groups.some((group) => group.placement === "left" && group.kinds.includes("files")) &&
        state.groups.some((group) => group.placement === "right" && group.kinds.includes("resources") && group.kinds.includes("transfers")) &&
        state.groups.some((group) => group.placement === "bottom" && group.kinds.includes("ports")) &&
        state.groups.some((group) => group.placement === "top" && group.kinds.includes("terminal"));
    }, async () => `default Dock groups did not mount\n${await pageSummary()}`);

    await clickToolKind("files");
    await waitUntil(async () => {
      const state = await dockState();
      const group = groupForKind(state, "files");
      return Boolean(
        group?.collapsed &&
        group.surfaceVisible === false &&
        group.rect.width <= 40 &&
        group.visibleTitles.includes("Files") &&
        group.edge.left <= 2 &&
        adjacentResizersForGroup(state, group.id).length === 0,
      );
    }, async () => `left Files group did not collapse\n${await pageSummary()}`);

    await clickToolKind("resources");
    await waitUntil(async () => {
      const state = await dockState();
      const group = groupForKind(state, "resources");
      return Boolean(
        group?.collapsed &&
        group.surfaceVisible === false &&
        group.rect.width <= 40 &&
        group.visibleTitles.includes("Resources") &&
        group.edge.right <= 2 &&
        adjacentResizersForGroup(state, group.id).length === 0,
      );
    }, async () => `right Resources group did not collapse\n${await pageSummary()}`);

    await clickToolKind("transfers");
    await waitUntil(async () => {
      const state = await dockState();
      const group = groupForKind(state, "transfers");
      const transfers = state.toolSlots.find((slot) => slot.kind === "transfers");
      return Boolean(group && !group.collapsed && group.surfaceVisible && transfers?.active && adjacentResizersForGroup(state, group.id).length > 0);
    }, async () => `inactive Transfers ToolTab did not expand the right group\n${await pageSummary()}`);

    await clickToolKind("ports");
    await waitUntil(async () => {
      const state = await dockState();
      const group = groupForKind(state, "ports");
      return Boolean(
        group?.collapsed &&
        group.surfaceVisible === false &&
        group.rect.height <= 39 &&
        group.visibleTitles.includes("Ports") &&
        group.edge.bottom <= 2 &&
        adjacentResizersForGroup(state, group.id).length === 0,
      );
    }, async () => `bottom Ports group did not collapse\n${await pageSummary()}`);

    const terminalBefore = groupForKind(await dockState(), "terminal");
    if (!terminalBefore) throw new Error(`Terminal group not found\n${await pageSummary()}`);
    await clickToolKind("terminal");
    await delay(400);
    const terminalAfter = groupForKind(await dockState(), "terminal");
    if (!terminalAfter) throw new Error(`Terminal group disappeared\n${await pageSummary()}`);
    if (terminalAfter.collapsed || terminalAfter.surfaceVisible === false || terminalAfter.rect.height < terminalBefore.rect.height - 20) {
      throw new Error(`top Terminal group collapsed unexpectedly\n${await pageSummary()}`);
    }

    console.log("tauri ToolTab side and bottom collapse unit test passed");
  } finally {
    if (sessionId) {
      await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
    }
    stopProcess(tauriDriver);
    await devServer.close();
    await isolatedAppConfig.cleanup();
  }

  async function clickToolKind(kind) {
    await execute(`
      const [kind] = arguments;
      const slot = [...document.querySelectorAll('.workspace-body [data-tool-slot-id]')]
        .find((item) => item.getAttribute('data-tool-kind') === kind);
      if (!slot) throw new Error(\`ToolTab \${kind} not found\`);
      slot.click();
    `, [kind]);
    await delay(250);
  }

  function groupForKind(state, kind) {
    return state.groups.find((group) => group.kinds.includes(kind)) ?? null;
  }

  function adjacentResizersForGroup(state, groupId) {
    return state.resizers.filter((resizer) => resizer.beforeGroupId === groupId || resizer.afterGroupId === groupId);
  }

  async function dockState() {
    return await execute(`
      const rect = (element) => {
        if (!element) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
        const value = element.getBoundingClientRect();
        return {
          left: Math.round(value.left),
          top: Math.round(value.top),
          right: Math.round(value.right),
          bottom: Math.round(value.bottom),
          width: Math.round(value.width),
          height: Math.round(value.height),
        };
      };
      const visible = (element) => {
        if (!element) return false;
        const value = element.getBoundingClientRect();
        return value.width > 0 && value.height > 0;
      };
      const workspaceBody = document.querySelector('.workspace-body');
      if (!workspaceBody) {
        return {
          groups: [],
          toolSlots: [],
          bodyText: document.body?.innerText?.slice(0, 1200) ?? '',
        };
      }
      const bodyRect = rect(workspaceBody);
      const groups = [...workspaceBody.querySelectorAll('[data-dock-group-id]')].map((group) => {
        const groupRect = rect(group);
        return ({
        id: group.getAttribute('data-dock-group-id') ?? '',
        role: group.getAttribute('data-dock-group-role') ?? '',
        placement: group.getAttribute('data-tool-tabbar-placement') ?? '',
        collapsed: group.getAttribute('data-dock-group-collapsed') === 'true',
        rect: groupRect,
        edge: {
          left: Math.abs(groupRect.left - bodyRect.left),
          right: Math.abs(groupRect.right - bodyRect.right),
          top: Math.abs(groupRect.top - bodyRect.top),
          bottom: Math.abs(groupRect.bottom - bodyRect.bottom),
        },
        surfaceVisible: visible(group.querySelector('.tool-surface')),
        tabbarVisible: visible(group.querySelector('.tool-tabbar')),
        visibleTitles: [...group.querySelectorAll('.tool-tab .tool-title')]
          .filter((title) => visible(title))
          .map((title) => title.textContent?.trim() ?? '')
          .filter(Boolean),
        kinds: [...group.querySelectorAll('[data-tool-kind]')]
          .map((slot) => slot.getAttribute('data-tool-kind') ?? '')
          .filter(Boolean),
        });
      });
      const toolSlots = [...workspaceBody.querySelectorAll('[data-tool-slot-id]')].map((slot) => ({
        id: slot.getAttribute('data-tool-slot-id') ?? '',
        kind: slot.getAttribute('data-tool-kind') ?? '',
        active: slot.classList.contains('active'),
        visible: visible(slot),
        groupId: slot.closest('[data-dock-group-id]')?.getAttribute('data-dock-group-id') ?? '',
      }));
      const resizers = [...workspaceBody.querySelectorAll('.workspace-dock-resizer')].map((resizer) => ({
        direction: resizer.classList.contains('row') ? 'row' : 'column',
        beforeGroupId: resizer.previousElementSibling?.getAttribute('data-dock-group-id') ?? '',
        afterGroupId: resizer.nextElementSibling?.getAttribute('data-dock-group-id') ?? '',
        visible: visible(resizer),
        rect: rect(resizer),
      })).filter((resizer) => resizer.visible);
      return {
        groups,
        toolSlots,
        resizers,
        bodyText: document.body?.innerText?.slice(0, 1200) ?? '',
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

  function requiredEnvPath(name) {
    const value = process.env[name];
    if (!value) {
      throw new Error(`${name} must point to the Tauri application binary for this Tauri unit test.`);
    }
    const path = resolve(value);
    if (!existsSync(path)) {
      throw new Error(`${name} points to a missing file: ${path}`);
    }
    return path;
  }

  function optionalEnvPath(name) {
    const value = process.env[name];
    if (!value) return "";
    const path = resolve(value);
    if (!existsSync(path)) {
      throw new Error(`${name} points to a missing file: ${path}`);
    }
    return path;
  }

  async function pageSummary() {
    if (!sessionId) return "no WebDriver session";
    return JSON.stringify(await dockState(), null, 2);
  }

  function stopProcess(child) {
    if (!child.pid || child.exitCode !== null) return;
    child.kill();
  }
});
