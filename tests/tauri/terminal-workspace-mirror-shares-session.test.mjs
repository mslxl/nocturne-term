/*
 * Test content:
 *
 * Feature:
 * Verifies that mirroring a Terminal ToolTab into another Workspace displays
 * the same backend terminal session through a mirror view instead of creating
 * a new terminal session or moving the owner ToolTab.
 *
 * Operation:
 * Starts the dev server, starts tauri-driver, launches the Tauri application
 * provided by the TAURI_TEST_APPLICATION environment variable, waits for the
 * default Local Workspace terminal to render text, creates a second Workspace,
 * returns to the first Workspace, uses the ToolTab context menu to mirror the
 * first Workspace Terminal ToolTab into the second Workspace, activates the
 * second Workspace, and inspects the rendered mirror Terminal surface.
 *
 * Expected:
 * The second Workspace contains a visible Terminal mirror surface with a
 * mirror source indicator, a distinct display view id, the same term-* backend
 * session id as the owner Terminal ToolTab, and non-empty xterm row text. The
 * owner Workspace still owns the original tool-terminal-* ToolTab.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
const isolatedAppConfig = await createIsolatedAppConfigEnv("terminal-mirror-shares-session");
const nativeDriverPath = optionalEnvPath("TAURI_TEST_NATIVE_DRIVER");
const driverPort = Number(process.env.TAURI_TEST_DRIVER_PORT ?? "4444");
const driverUrl = `http://127.0.0.1:${driverPort}`;
const devUrl = process.env.TAURI_TEST_DEV_URL ?? "http://localhost:1420/";
const devPort = Number(new URL(devUrl).port);
const nativeDriverArgs = nativeDriverPath ? ["--native-driver", nativeDriverPath] : [];

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

  await waitForVisibleTerminal("owner Workspace terminal did not render text");
  const owner = await activeWorkspaceTerminalState();

  await createWorkspace();
  await waitUntil(async () => {
    const state = await workspaceState();
    return state.workspaceIds.length >= 2 && state.activeWorkspaceId !== owner.workspaceId;
  }, async () => `second Workspace did not become active\n${await pageSummary()}`);
  const target = await activeWorkspaceTerminalState();
  if (target.workspaceId === owner.workspaceId) {
    throw new Error(`expected a second Workspace, got ${target.workspaceId}`);
  }

  await activateWorkspace(owner.workspaceId);
  await waitForVisibleTerminal("owner Workspace terminal disappeared before mirroring");
  await mirrorActiveTerminalToWorkspace(target.workspaceTitle);
  await activateWorkspace(target.workspaceId);

  await waitUntil(async () => {
    const state = await mirrorState();
    return state.mirrorSurfaces.length === 1 &&
      state.mirrorSurfaces[0].sessionId === owner.sessionId &&
      state.mirrorSurfaces[0].toolTabId === owner.toolTabId &&
      state.mirrorSurfaces[0].viewId !== owner.viewId &&
      state.mirrorSurfaces[0].sourceText.includes(owner.workspaceTitle) &&
      state.mirrorSurfaces[0].rowsText.trim().length > 0 &&
      state.mirrorSurfaces[0].xterms === 1;
  }, async () => `Terminal mirror did not share the owner session\n${await pageSummary()}`);

  if (!owner.toolTabId.startsWith("tool-terminal-")) {
    throw new Error(`owner ToolTab id should stay a Workspace ToolTab id, got ${owner.toolTabId}`);
  }
  if (!owner.sessionId.startsWith("term-")) {
    throw new Error(`owner backend session id should stay term-*, got ${owner.sessionId}`);
  }

  console.log("tauri terminal Workspace mirror shares session unit test passed");
} finally {
  if (sessionId) {
    await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
  }
  stopProcess(tauriDriver);
  await devServer.close();
  await isolatedAppConfig.cleanup();
}

async function createWorkspace() {
  await execute(`
    const button = document.querySelector('.new-workspace');
    if (!button) throw new Error('New workspace button not found');
    button.click();
  `);
}

async function activateWorkspace(workspaceId) {
  await execute(`
    const button = document
      .querySelector('[data-testid="workspace-tab-${workspaceId}"] .workspace-activate');
    if (!button) throw new Error('Workspace tab ${workspaceId} not found');
    button.click();
  `);
  await waitUntil(async () => {
    const state = await workspaceState();
    return state.activeWorkspaceId === workspaceId;
  }, async () => `Workspace ${workspaceId} did not become active\n${await pageSummary()}`);
}

async function mirrorActiveTerminalToWorkspace(targetWorkspaceTitle) {
  await execute(`
    const terminalSlot = document.querySelector('[data-tool-kind="terminal"].active');
    if (!terminalSlot) throw new Error('active Terminal ToolTab slot not found');
    const rect = terminalSlot.getBoundingClientRect();
    terminalSlot.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2),
      button: 2,
      buttons: 2,
      view: window,
    }));
  `);
  await waitUntil(async () => {
    const labels = await toolTabMenuLabels();
    return labels.some((label) => label === `Mirror to ${targetWorkspaceTitle}`);
  }, async () => `Mirror menu item for ${targetWorkspaceTitle} did not appear\n${await pageSummary()}`);
  await execute(`
    const expected = ${JSON.stringify(`Mirror to ${targetWorkspaceTitle}`)};
    const item = [...document.querySelectorAll('[data-tooltab-menu="true"] button')]
      .find((button) => button.textContent.trim() === expected);
    if (!item) throw new Error('Mirror menu item not found: ' + expected);
    item.click();
  `);
  await waitUntil(async () => {
    return await execute(`return document.querySelector('[data-tooltab-menu="true"]') === null;`);
  }, async () => `Mirror menu did not close after dispatch\n${await pageSummary()}`);
}

async function toolTabMenuLabels() {
  return await execute(`
    return [...document.querySelectorAll('[data-tooltab-menu="true"] button')]
      .map((button) => button.textContent.trim());
  `);
}

async function waitForVisibleTerminal(reason) {
  await waitUntil(async () => {
    const state = await activeWorkspaceTerminalState();
    return state.hosts === 1 &&
      state.xterms === 1 &&
      state.sessionId.startsWith("term-") &&
      state.toolTabId.startsWith("tool-terminal-") &&
      state.rowsText.trim().length > 0;
  }, async () => `${reason}\n${await pageSummary()}`);
}

async function activeWorkspaceTerminalState() {
  return await execute(`
    const activeWorkspace = document.querySelector('.workspace-tab.active');
    const surface = document.querySelector('[data-testid="terminal-surface"]');
    const activeTerminalSlot = document.querySelector('[data-tool-kind="terminal"].active');
    return {
      workspaceId: activeWorkspace?.getAttribute('data-workspace-id') ?? '',
      workspaceTitle: activeWorkspace?.querySelector('.workspace-activate span')?.textContent?.trim() ?? '',
      toolTabId: surface?.getAttribute('data-tool-tab-id') ?? activeTerminalSlot?.getAttribute('data-tool-tab-id') ?? '',
      viewId: surface?.getAttribute('data-terminal-view-id') ?? '',
      sessionId: surface?.getAttribute('data-session-id') ?? activeTerminalSlot?.getAttribute('data-session-id') ?? '',
      rowsText: surface?.querySelector('.xterm .xterm-rows')?.textContent ?? '',
      hosts: document.querySelectorAll('[data-testid="terminal-host"]').length,
      xterms: document.querySelectorAll('.xterm').length,
    };
  `);
}

async function mirrorState() {
  return await execute(`
    const activeWorkspace = document.querySelector('.workspace-tab.active');
    const activeWorkspaceId = activeWorkspace?.getAttribute('data-workspace-id') ?? '';
    const mirrorSurfaces = [...document.querySelectorAll('[data-testid="terminal-surface"][data-terminal-mirror="true"]')]
      .map((surface) => ({
        sessionId: surface.getAttribute('data-session-id') ?? '',
        toolTabId: surface.getAttribute('data-tool-tab-id') ?? '',
        viewId: surface.getAttribute('data-terminal-view-id') ?? '',
        sourceText: surface.querySelector('[data-testid="terminal-mirror-source"]')?.textContent?.trim() ?? '',
        rowsText: surface.querySelector('.xterm .xterm-rows')?.textContent ?? '',
        xterms: surface.querySelectorAll('.xterm').length,
      }));
    return {
      activeWorkspaceId,
      mirrorSurfaces,
      allTerminalSlots: [...document.querySelectorAll('[data-tool-kind="terminal"]')].map((slot) => ({
        className: slot.className,
        toolTabId: slot.getAttribute('data-tool-tab-id') ?? '',
        sessionId: slot.getAttribute('data-session-id') ?? '',
        title: slot.getAttribute('title') ?? '',
      })),
      bodyText: document.body?.innerText?.slice(0, 1200) ?? '',
    };
  `);
}

async function workspaceState() {
  return await execute(`
    return {
      activeWorkspaceId: document.querySelector('.workspace-tab.active')?.getAttribute('data-workspace-id') ?? '',
      workspaceIds: [...document.querySelectorAll('.workspace-tab')]
        .map((tab) => tab.getAttribute('data-workspace-id'))
        .filter(Boolean),
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

async function execute(script) {
  const response = await webdriver("POST", `/session/${sessionId}/execute/sync`, {
    script,
    args: [],
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
  return JSON.stringify({
    title: await execute("return document.title;"),
    url: await execute("return location.href;"),
    workspaceState: await workspaceState(),
    activeTerminal: await activeWorkspaceTerminalState().catch((error) => ({ error: String(error) })),
    mirrorState: await mirrorState().catch((error) => ({ error: String(error) })),
  }, null, 2);
}

function stopProcess(child) {
  if (!child.pid || child.exitCode !== null) return;
  child.kill();
}
