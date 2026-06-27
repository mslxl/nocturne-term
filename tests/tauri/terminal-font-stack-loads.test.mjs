#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies that the real Tauri WebView terminal uses the bundled default font
 * stack with Maple Mono first and the official Nerd Fonts Symbols-only
 * fallback second.
 *
 * Operation:
 * Starts the Vite dev server, starts tauri-driver, launches the Tauri
 * application, waits for the default Local Workspace terminal xterm surface to
 * mount, and reads the computed font family from the visible xterm element.
 *
 * Expected:
 * The visible terminal renders with a CSS font-family whose first family is
 * Maple Mono, whose second family is Symbols Nerd Font Mono, and whose stack
 * still ends with monospace fallbacks. The xterm surface remains visible and
 * contains terminal rows while the font stack is applied.
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";
import { optionalEnvPath, resolveTauriTestApplication } from "./tauri-test-application.mjs";
import { test } from "vitest";

test("terminal font stack loads in workspace", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = await resolveTauriTestApplication(repoRoot);
  const isolatedAppConfig = await createIsolatedAppConfigEnv("terminal-font-stack-loads");
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

    await waitUntil(async () => {
      const state = await terminalFontState();
      return state.visibleSurfaceCount === 1 && state.xterms === 1 && state.rowsText.trim().length > 0;
    }, async () => `default terminal did not render before font inspection\n${await pageSummary()}`);

    const state = await terminalFontState();
    if (!state.fontFamily.includes("Maple Mono")) {
      throw new Error(`terminal font stack did not include Maple Mono first\n${await pageSummary()}`);
    }
    if (!state.fontFamily.includes("Symbols Nerd Font Mono")) {
      throw new Error(`terminal font stack did not include Symbols Nerd Font Mono fallback\n${await pageSummary()}`);
    }
    if (!state.fontFamily.trim().endsWith("monospace")) {
      throw new Error(`terminal font stack did not keep monospace fallback\n${await pageSummary()}`);
    }
    if (state.fontFamily.indexOf("Maple Mono") > state.fontFamily.indexOf("Symbols Nerd Font Mono")) {
      throw new Error(`terminal font stack did not prefer Maple Mono before Nerd Fonts\n${await pageSummary()}`);
    }

    console.log("tauri terminal font stack loads unit test passed");
  } finally {
    if (sessionId) {
      await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
    }
    stopProcess(tauriDriver);
    await devServer.close();
    await isolatedAppConfig.cleanup();
  }

  async function terminalFontState() {
    return await execute(`
      const surfaces = [...document.querySelectorAll('[data-testid="terminal-surface"]')].filter((item) => {
        const rect = item.getBoundingClientRect();
        const slot = item.closest('.tool-slot-surface');
        return rect.width >= 1 && rect.height >= 1 && !slot?.hidden && slot?.getAttribute('aria-hidden') !== 'true';
      });
      const surface = surfaces[0];
      const xterm = surface?.querySelector('.xterm');
      const rows = surface?.querySelector('.xterm .xterm-rows');
      const rect = xterm?.getBoundingClientRect();
      return {
        visibleSurfaceCount: surfaces.length,
        xterms: surface?.querySelectorAll('.xterm').length ?? 0,
        fontFamily: xterm ? getComputedStyle(xterm).fontFamily : '',
        width: Math.round(rect?.width ?? 0),
        height: Math.round(rect?.height ?? 0),
        rowsText: rows?.textContent ?? '',
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

  async function pageSummary() {
    if (!sessionId) return "no WebDriver session";
    return JSON.stringify(await terminalFontState(), null, 2);
  }

  function stopProcess(child) {
    if (!child.pid || child.exitCode !== null) return;
    child.kill();
  }
});
