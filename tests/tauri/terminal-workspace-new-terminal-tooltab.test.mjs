#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies that New Terminal creates a new Workspace-owned Terminal ToolTab,
 * not a legacy terminal-internal tab or pane. The new ToolTab must use an
 * independent Workspace ToolTab id while its backend terminal session keeps a
 * separate term-* id.
 *
 * Operation:
 * Starts the dev server, starts tauri-driver, launches the Tauri application
 * provided by the TAURI_TEST_APPLICATION environment variable, waits for the
 * default Local Workspace terminal, triggers the New Terminal command through
 * the keyboard command path, and inspects the Workspace Dock and terminal DOM.
 *
 * Expected:
 * The active Workspace contains two owned Terminal ToolTabs in the content
 * dock group, each Terminal ToolTab has a distinct tool-terminal-* id, each
 * ToolTab is mapped to a distinct term-* backend session id, the active
 * Terminal ToolTab has a mounted surface, and there are no legacy
 * terminal-internal tab bars or multi-pane title bars.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
const isolatedAppConfig = await createIsolatedAppConfigEnv("new-terminal-tooltab");
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
    return state.terminalToolTabs.length === 1 && state.toolSessionIds.length === 1 && state.visibleSessionIds.length === 1;
  }, async () => `default terminal ToolTab did not mount once\n${await pageSummary()}`);

  await triggerNewTerminalCommand();

  await waitUntil(async () => {
    const state = await terminalToolTabState();
    return state.terminalToolTabs.length === 2 &&
      state.contentGroupTerminalSlots === 2 &&
      state.toolSessionIds.length === 2 &&
      state.visibleSessionIds.length === 1 &&
      new Set(state.terminalToolTabs).size === 2 &&
      new Set(state.toolSessionIds).size === 2;
  }, async () => `New Terminal did not create a second Workspace Terminal ToolTab\n${await pageSummary()}`);

  const state = await terminalToolTabState();
  if (state.legacyTerminalTabBars !== 0) {
    throw new Error(`expected no legacy terminal tab bars, found ${state.legacyTerminalTabBars}`);
  }
  if (state.paneTitleBars !== 0) {
    throw new Error(`expected no terminal pane title bars, found ${state.paneTitleBars}`);
  }
  for (const toolTabId of state.terminalToolTabs) {
    if (!toolTabId.startsWith("tool-terminal-")) {
      throw new Error(`expected Workspace Terminal ToolTab id, got ${toolTabId}`);
    }
  }
  for (const sessionIdValue of state.toolSessionIds) {
    if (!sessionIdValue.startsWith("term-")) {
      throw new Error(`expected backend terminal session id, got ${sessionIdValue}`);
    }
  }

  console.log("tauri terminal workspace new-terminal ToolTab unit test passed");
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

async function terminalToolTabState() {
  return await execute(`
    const terminalSlots = [...document.querySelectorAll('[data-tool-kind="terminal"]')];
    const activeContentGroup = document.querySelector('[data-dock-group-role="content"]');
    return {
      terminalToolTabs: terminalSlots.map((slot) => slot.getAttribute('data-tool-tab-id')).filter(Boolean),
      terminalSlotIds: terminalSlots.map((slot) => slot.getAttribute('data-tool-slot-id')).filter(Boolean),
      contentGroupTerminalSlots: activeContentGroup?.querySelectorAll('[data-tool-kind="terminal"]').length ?? 0,
      toolSessionIds: terminalSlots.map((slot) => slot.getAttribute('data-session-id')).filter(Boolean),
      visibleSessionIds: [...document.querySelectorAll('[data-testid="terminal-surface"]')]
        .map((surface) => surface.getAttribute('data-session-id'))
        .filter(Boolean),
      terminalHosts: document.querySelectorAll('[data-testid="terminal-host"]').length,
      xterms: document.querySelectorAll('.xterm').length,
      legacyTerminalTabBars: document.querySelectorAll('[data-testid="terminal-tabbar"]').length,
      paneTitleBars: document.querySelectorAll('[data-testid="pane-titlebar"]').length,
      bodyText: document.body?.innerText?.slice(0, 1000) ?? '',
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
    bodyText: await execute("return document.body?.innerText?.slice(0, 1200) ?? '';"),
    terminalToolTabState: state,
  }, null, 2);
}

function stopProcess(child) {
  if (!child.pid || child.exitCode !== null) return;
  child.kill();
}
