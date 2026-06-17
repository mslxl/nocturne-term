#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies that the default Local Workspace terminal renders visible terminal
 * content in a real Tauri window. A mounted xterm shell is not enough; the
 * terminal surface must have measurable layout and must display text rows from
 * the backend PTY so the user does not see a blank white content area.
 *
 * Operation:
 * Starts the dev server, starts tauri-driver, launches the Tauri application
 * provided by the TAURI_TEST_APPLICATION environment variable, waits for the
 * default Terminal ToolTab in the live Tauri WebView, and inspects terminal
 * host, mount, viewport, screen, and row DOM state.
 *
 * Expected:
 * Exactly one terminal host and one xterm are mounted, the terminal host,
 * xterm viewport, and xterm row layer all have non-zero visible dimensions,
 * and the xterm rows contain non-empty text from the running local terminal.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";
import { test } from "vitest";

test("terminal workspace visible content", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("visible-content");
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
      const state = await terminalVisibilityState();
      return state.hosts === 1 && state.xterms === 1;
    }, async () => `default terminal did not mount exactly once\n${await pageSummary()}`);

    await waitUntil(async () => {
      const state = await terminalVisibilityState();
      return state.hostRect.width >= 200 &&
        state.hostRect.height >= 120 &&
        state.viewportRect.width >= 180 &&
        state.viewportRect.height >= 100 &&
        state.rowsRect.width >= 180 &&
        state.rowsRect.height >= 16;
    }, async () => `terminal mounted without a visible layout\n${await pageSummary()}`);

    await waitUntil(async () => {
      const state = await terminalVisibilityState();
      return state.rowsText.trim().length > 0;
    }, async () => `terminal rendered a blank xterm surface\n${await pageSummary()}`);

    console.log("tauri terminal workspace visible-content unit test passed");
  } finally {
    if (sessionId) {
      await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
    }
    stopProcess(tauriDriver);
    await devServer.close();
    await isolatedAppConfig.cleanup();
  }

  async function terminalVisibilityState() {
    return await execute(`
      const host = document.querySelector('[data-testid="terminal-host"]');
      const mount = document.querySelector('[data-testid="terminal-mount"]');
      const xterm = document.querySelector('.xterm');
      const viewport = document.querySelector('.xterm .xterm-viewport');
      const screen = document.querySelector('.xterm .xterm-screen');
      const rows = document.querySelector('.xterm .xterm-rows');
      const rect = (element) => {
        if (!element) return { width: 0, height: 0, top: 0, left: 0 };
        const value = element.getBoundingClientRect();
        return {
          width: Math.round(value.width),
          height: Math.round(value.height),
          top: Math.round(value.top),
          left: Math.round(value.left),
        };
      };
      const style = (element) => {
        if (!element) return {};
        const value = getComputedStyle(element);
        return {
          display: value.display,
          visibility: value.visibility,
          color: value.color,
          backgroundColor: value.backgroundColor,
        };
      };
      return {
        hosts: document.querySelectorAll('[data-testid="terminal-host"]').length,
        mounts: document.querySelectorAll('[data-testid="terminal-mount"]').length,
        xterms: document.querySelectorAll('.xterm').length,
        rowCount: document.querySelectorAll('.xterm .xterm-rows > div').length,
        hostRect: rect(host),
        mountRect: rect(mount),
        xtermRect: rect(xterm),
        viewportRect: rect(viewport),
        screenRect: rect(screen),
        rowsRect: rect(rows),
        hostStyle: style(host),
        xtermStyle: style(xterm),
        viewportStyle: style(viewport),
        rowsStyle: style(rows),
        rowsText: rows?.textContent ?? '',
        terminalError: document.querySelector('.terminal-error')?.textContent ?? '',
        placeholderText: document.querySelector('.placeholder')?.textContent ?? '',
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
    const state = await terminalVisibilityState();
    return JSON.stringify({
      title: await execute("return document.title;"),
      url: await execute("return location.href;"),
      bodyText: await execute("return document.body?.innerText?.slice(0, 1000) ?? '';"),
      terminalVisibility: state,
    }, null, 2);
  }

  function stopProcess(child) {
    if (!child.pid || child.exitCode !== null) return;
    child.kill();
  }

});
