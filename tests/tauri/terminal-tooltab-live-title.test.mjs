#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies that a Terminal ToolTab title in the Workspace Dock tab bar uses
 * the live terminal runtime title instead of the static Workspace/host default
 * title stored in the Workspace snapshot.
 *
 * Operation:
 * Starts the Vite dev server, starts tauri-driver, launches the Tauri
 * application provided by the TAURI_TEST_APPLICATION environment variable,
 * waits for the default Local Workspace terminal to mount in the real Tauri
 * WebView, and inspects the active Terminal ToolTab title shown in the Dock tab
 * bar.
 *
 * Expected:
 * The visible Terminal ToolTab title updates to the terminal runtime title
 * exposed by the mounted terminal surface. It must not remain equal to the
 * static Workspace title or the default `Local Shell` ToolTab title.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";
import { test } from "vitest";

test("terminal tooltab live title", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("terminal-tooltab-live-title");
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
      const state = await terminalTitleState();
      return state.hosts === 1 &&
        state.xterms === 1 &&
        state.surfaceRuntimeTitle.length > 0 &&
        state.toolTabTitle.length > 0;
    }, async () => `default terminal ToolTab did not mount\n${await pageSummary()}`);

    await waitUntil(async () => {
      const state = await terminalTitleState();
      return state.toolTabTitle === state.surfaceRuntimeTitle &&
        state.toolTabTitle !== state.workspaceTitle &&
        state.toolTabTitle !== "Local Shell";
    }, async () => `Terminal ToolTab title did not use the live runtime title\n${await pageSummary()}`);

    console.log("tauri terminal ToolTab live-title unit test passed");
  } finally {
    if (sessionId) {
      await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
    }
    stopProcess(tauriDriver);
    await devServer.close();
    await isolatedAppConfig.cleanup();
  }

  async function terminalTitleState() {
    return await execute(`
      const activeWorkspace = document.querySelector('.workspace-tab.active');
      const activeTerminalSlot = document.querySelector('[data-tool-kind="terminal"].active');
      const surface = document.querySelector('[data-testid="terminal-surface"]');
      return {
        workspaceTitle: activeWorkspace?.querySelector('.workspace-activate span')?.textContent?.trim() ?? '',
        toolTabTitle: activeTerminalSlot?.querySelector('.tool-title')?.textContent?.trim() ?? '',
        slotTitleAttribute: activeTerminalSlot?.getAttribute('title') ?? '',
        snapshotToolTitle: activeTerminalSlot?.getAttribute('data-tool-snapshot-title') ?? '',
        surfaceRuntimeTitle: surface?.getAttribute('data-terminal-runtime-title') ?? '',
        hosts: document.querySelectorAll('[data-testid="terminal-host"]').length,
        xterms: document.querySelectorAll('.xterm').length,
        rowsText: document.querySelector('.xterm .xterm-rows')?.textContent ?? '',
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
    return JSON.stringify(await terminalTitleState(), null, 2);
  }

  function stopProcess(child) {
    if (!child.pid || child.exitCode !== null) return;
    child.kill();
  }

});
