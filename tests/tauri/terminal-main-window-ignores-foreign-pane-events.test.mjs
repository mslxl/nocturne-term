#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies that the main Tauri window Terminal ToolTab ignores terminal pane
 * events that belong to another WebView runtime or to a stale backend session.
 *
 * Operation:
 * Starts the Vite dev server, starts tauri-driver, launches the Tauri
 * application provided by the TAURI_TEST_APPLICATION environment variable,
 * waits for the default Local Workspace terminal, opens a floating Files
 * ToolTab mirror window to create a second WebView that receives the same
 * global terminal backend events, switches back to the main window, activates
 * the Terminal ToolTab, and inspects the visible page text and terminal error
 * element.
 *
 * Expected:
 * The main window remains responsive, the Terminal ToolTab still has one
 * visible xterm surface, and neither the page body nor the terminal error
 * region displays "tab for pane ... not found" after cross-window terminal
 * events have been delivered.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";
import { test } from "vitest";

test("terminal main window ignores foreign pane events", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("terminal-main-window-ignores-foreign-pane-events");
  const nativeDriverPath = optionalEnvPath("TAURI_TEST_NATIVE_DRIVER");
  const nativeDriverPort = process.env.TAURI_TEST_NATIVE_DRIVER_PORT ?? "";
  const driverPort = Number(process.env.TAURI_TEST_DRIVER_PORT ?? "4444");
  const driverUrl = `http://127.0.0.1:${driverPort}`;
  const devUrl = process.env.TAURI_TEST_DEV_URL ?? "http://localhost:1420/";
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
    const mainHandle = await currentWindowHandle();

    await waitUntil(async () => {
      const state = await mainWindowState();
      return state.terminalSurfaceVisible && state.xterms === 1 && !state.hasPaneLookupError;
    }, async () => `Main Terminal did not start cleanly\n${await pageSummary()}`);

    await floatFilesToolTab();
    await waitUntil(async () => (await windowHandles()).length >= 2, async () => `Floating window did not open\n${await pageSummary()}`);
    await switchToWindow(mainHandle);
    await activateToolTab("terminal");

    await waitUntil(async () => {
      const state = await mainWindowState();
      return state.bodyResponsiveMarker === "ok" &&
        state.terminalSurfaceVisible &&
        state.xterms === 1 &&
        !state.hasPaneLookupError;
    }, async () => `Main Terminal displayed a foreign pane lookup error\n${await pageSummary()}`);

    console.log("tauri terminal main-window foreign pane event unit test passed");
  } finally {
    if (sessionId) {
      await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
    }
    stopProcess(tauriDriver);
    await devServer.close();
    await isolatedAppConfig.cleanup();
  }

  async function floatFilesToolTab() {
    await execute(`
      const files = [...document.querySelectorAll('[data-tool-kind="files"]')]
        .find((slot) => slot.getBoundingClientRect().width > 0 && slot.getBoundingClientRect().height > 0);
      if (!files) throw new Error('Files ToolTab was not visible');
      const rect = files.getBoundingClientRect();
      files.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: Math.round(rect.left + rect.width / 2),
        clientY: Math.round(rect.top + rect.height / 2),
        view: window,
      }));
    `);
    await waitUntil(async () => {
      const menuItems = await execute(`
        return [...document.querySelectorAll('[data-tooltab-menu="true"] [role="menuitem"]')]
          .map((item) => item.textContent?.trim() ?? '');
      `);
      return menuItems.includes("Float ToolTab");
    }, pageSummary);
    await execute(`
      const button = [...document.querySelectorAll('[data-tooltab-menu="true"] [role="menuitem"]')]
        .find((item) => item.textContent?.trim() === 'Float ToolTab');
      if (!button) throw new Error('Float ToolTab menu item was not visible');
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window }));
    `);
  }

  async function activateToolTab(kind) {
    await execute(`
      const kind = arguments[0];
      const slot = [...document.querySelectorAll('[data-tool-kind]')]
        .find((item) => item.getAttribute('data-tool-kind') === kind && item.getBoundingClientRect().width > 0 && item.getBoundingClientRect().height > 0);
      if (!slot) throw new Error(\`ToolTab \${kind} was not visible\`);
      slot.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window }));
    `, [kind]);
  }

  async function mainWindowState(timeoutMs = 8_000) {
    return await execute(`
      window.__NOCTURNE_MAIN_FOREIGN_PANE_EVENT_MARKER__ = 'ok';
      const bodyText = document.body?.innerText ?? '';
      const terminalError = document.querySelector('.terminal-error')?.textContent ?? '';
      const paneLookupPattern = /tab for pane term-\\d+ not found/;
      return {
        bodyResponsiveMarker: window.__NOCTURNE_MAIN_FOREIGN_PANE_EVENT_MARKER__,
        terminalSurfaceVisible: document.querySelector('.terminal-surface')?.getBoundingClientRect().height > 0,
        xterms: document.querySelectorAll('.xterm').length,
        terminalError,
        bodyText: bodyText.slice(0, 1200),
        hasPaneLookupError: paneLookupPattern.test(bodyText) || paneLookupPattern.test(terminalError),
      };
    `, [], timeoutMs);
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

  async function currentWindowHandle() {
    const response = await webdriver("GET", `/session/${sessionId}/window`, undefined, 4_000);
    return response.value;
  }

  async function windowHandles() {
    const response = await webdriver("GET", `/session/${sessionId}/window/handles`, undefined, 4_000);
    return response.value ?? [];
  }

  async function switchToWindow(handle) {
    await webdriver("POST", `/session/${sessionId}/window`, { handle }, 4_000);
  }

  async function execute(script, args = [], timeoutMs = 6_000) {
    const response = await webdriver("POST", `/session/${sessionId}/execute/sync`, {
      script,
      args,
    }, timeoutMs);
    return response.value;
  }

  async function webdriver(method, path, body, timeoutMs = 10_000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${driverUrl}${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      const json = text ? JSON.parse(text) : {};
      if (!response.ok) {
        throw new Error(`WebDriver ${method} ${path} failed: ${response.status} ${text}\n${driverOutput}`);
      }
      return json;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`WebDriver ${method} ${path} timed out after ${timeoutMs}ms\n${driverOutput}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
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
    return JSON.stringify(await mainWindowState(12_000), null, 2);
  }

  function stopProcess(child) {
    if (!child.pid || child.exitCode !== null) return;
    child.kill();
  }

});
