#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies that closing the active Terminal ToolTab in a Workspace with
 * multiple Terminal ToolTabs switches to another live Terminal ToolTab without
 * showing stale terminal errors or losing the mounted xterm surface.
 *
 * Operation:
 * Starts the dev server, starts tauri-driver, launches the Tauri application
 * provided by the TAURI_TEST_APPLICATION environment variable, waits for the
 * default Local Workspace terminal, creates a second Terminal ToolTab through
 * the keyboard command path, clicks the active ToolTab close button, and
 * inspects the Workspace Dock, terminal DOM, and page text after the automatic
 * active-slot switch.
 *
 * Expected:
 * Exactly one Terminal ToolTab remains in the content dock group, it stays
 * active, its backend session id is still a term-* id distinct from the closed
 * session id, the visible terminal surface and xterm are mounted for that
 * remaining session, and the page does not contain stale messages such as
 * "The operation completed successfully" or "did not mount a container".
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
const isolatedAppConfig = await createIsolatedAppConfigEnv("close-active-terminal-switches-live");
await writeFile(
  resolve(isolatedAppConfig.env.NOCTURNE_CONFIG_ROOT, "config.toml"),
  "[terminal]\nconfirm_close = false\n",
);
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

  await waitUntil(async () => {
    const state = await terminalToolTabState();
    return state.terminalToolTabs.length === 1 && state.visibleSessionIds.length === 1 && state.xterms === 1;
  }, async () => `default terminal ToolTab did not mount once\n${await pageSummary()}`);

  await triggerNewTerminalCommand();

  await waitUntil(async () => {
    const state = await terminalToolTabState();
    return state.terminalToolTabs.length === 2 &&
      state.visibleSessionIds.length === 1 &&
      state.xterms === 1 &&
      new Set(state.toolSessionIds).size === 2;
  }, async () => `second Terminal ToolTab did not mount\n${await pageSummary()}`);

  const beforeClose = await terminalToolTabState();
  const closedToolTabId = beforeClose.activeToolTabId;
  const closedSessionId = beforeClose.activeSessionId;
  if (!closedToolTabId) throw new Error(`active Terminal ToolTab is missing before close\n${await pageSummary()}`);
  if (!closedSessionId) throw new Error(`active terminal session is missing before close\n${await pageSummary()}`);

  await closeActiveToolTab();

  await waitUntil(async () => {
    const state = await terminalToolTabState();
    return state.terminalToolTabs.length === 1 &&
      state.contentGroupTerminalSlots === 1 &&
      state.visibleSessionIds.length === 1 &&
      state.xterms === 1 &&
      state.activeToolTabId &&
      state.activeToolTabId !== closedToolTabId &&
      state.activeSessionId &&
      state.activeSessionId !== closedSessionId &&
      !state.bodyText.includes("The operation completed successfully") &&
      !state.bodyText.includes("did not mount a container");
  }, async () => `closing active Terminal ToolTab did not switch to a live terminal\n${await pageSummary()}`);

  const afterClose = await terminalToolTabState();
  if (!afterClose.activeSessionId.startsWith("term-")) {
    throw new Error(`remaining active backend session id is not term-*: ${afterClose.activeSessionId}`);
  }
  if (afterClose.visibleSessionIds[0] !== afterClose.activeSessionId) {
    throw new Error(`visible terminal session ${afterClose.visibleSessionIds[0]} does not match active ${afterClose.activeSessionId}`);
  }
  if (afterClose.bodyText.includes("Terminal: The operation completed successfully")) {
    throw new Error(`stale terminal success error is visible after close\n${await pageSummary()}`);
  }

  console.log("tauri terminal workspace close-active switches-to-live-session unit test passed");
} finally {
  if (sessionId) {
    await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
  }
  stopProcess(tauriDriver);
  await devServer.close();
  await isolatedAppConfig.cleanup();
}

async function triggerNewTerminalCommand() {
  await execute(`
    const press = (init) => {
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'T',
        code: 'KeyT',
        ...init,
      });
      window.dispatchEvent(event);
      document.dispatchEvent(event);
    };
    press({ ctrlKey: true, shiftKey: true });
    press({ metaKey: true });
  `);
}

async function closeActiveToolTab() {
  const closed = await execute(`
    const active = document.querySelector('[data-dock-group-role="content"] [data-tool-kind="terminal"][aria-selected="true"]');
    const close = active?.querySelector('.tool-close');
    if (!close) return false;
    close.click();
    return true;
  `);
  if (!closed) throw new Error(`active Terminal ToolTab close button was not available\n${await pageSummary()}`);
}

async function terminalToolTabState() {
  return await execute(`
    const contentGroup = document.querySelector('[data-dock-group-role="content"]');
    const terminalSlots = [...document.querySelectorAll('[data-tool-kind="terminal"]')];
    const activeTerminalSlot = contentGroup?.querySelector('[data-tool-kind="terminal"][aria-selected="true"]') ?? null;
    const surfaces = [...document.querySelectorAll('[data-testid="terminal-surface"]')];
    return {
      terminalToolTabs: terminalSlots.map((slot) => slot.getAttribute('data-tool-tab-id')).filter(Boolean),
      terminalSlotIds: terminalSlots.map((slot) => slot.getAttribute('data-tool-slot-id')).filter(Boolean),
      contentGroupTerminalSlots: contentGroup?.querySelectorAll('[data-tool-kind="terminal"]').length ?? 0,
      toolSessionIds: terminalSlots.map((slot) => slot.getAttribute('data-session-id')).filter(Boolean),
      activeToolTabId: activeTerminalSlot?.getAttribute('data-tool-tab-id') ?? '',
      activeSessionId: activeTerminalSlot?.getAttribute('data-session-id') ?? '',
      visibleSessionIds: surfaces.map((surface) => surface.getAttribute('data-session-id')).filter(Boolean),
      terminalHosts: document.querySelectorAll('[data-testid="terminal-host"]').length,
      xterms: document.querySelectorAll('.xterm').length,
      terminalErrors: [...document.querySelectorAll('.terminal-error')].map((node) => node.textContent ?? ''),
      contentGroupText: contentGroup?.innerText?.slice(0, 1000) ?? '',
      contentGroupHtml: contentGroup?.innerHTML?.slice(0, 1600) ?? '',
      bodyText: document.body?.innerText?.slice(0, 1600) ?? '',
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
  const state = await terminalToolTabState();
  return JSON.stringify({
    title: await execute("return document.title;"),
    url: await execute("return location.href;"),
    terminalToolTabState: state,
  }, null, 2);
}

function stopProcess(child) {
  if (!child.pid || child.exitCode !== null) return;
  child.kill();
}
