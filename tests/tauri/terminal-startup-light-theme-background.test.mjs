#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies that the startup Terminal ToolTab uses the resolved light terminal
 * color scheme when the application chrome is configured for the light theme.
 *
 * Operation:
 * Starts the Vite dev server, starts tauri-driver, launches the Tauri
 * application provided by the TAURI_TEST_APPLICATION environment variable with
 * an isolated config that sets ui.theme to light, waits for the default Local
 * Workspace terminal, and reads the computed app and xterm background colors
 * from the live WebView.
 *
 * Expected:
 * The document theme is light, the app background is a light color, the xterm
 * background is a light color, and the xterm background is not the built-in
 * dark terminal background. This prevents a white startup Workspace from
 * mounting a black terminal surface.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";
import { test } from "vitest";

test("terminal startup light theme background", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("startup-light-theme-background");
  await writeFile(
    resolve(isolatedAppConfig.env.NOCTURNE_CONFIG_ROOT, "config.toml"),
    "[ui]\ntheme = \"light\"\n",
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
      const state = await startupThemeState();
      return state.terminalHosts === 1 && state.xterms === 1 && state.xtermRect.width >= 200 && state.xtermRect.height >= 120;
    }, async () => `startup terminal did not mount with a visible xterm\n${await pageSummary()}`);

    const state = await startupThemeState();
    assertEqual(state.documentTheme, "light", `expected document theme to be light\n${formatState(state)}`);
    assertLightColor(state.appBackground, `expected app background to be light\n${formatState(state)}`);
    assertLightCssColor(state.terminalBackgroundVariable, `expected terminal theme background to be light\n${formatState(state)}`);
    assertNotEqual(
      normalizeCssColor(state.terminalBackgroundVariable),
      "#101113",
      `terminal used the built-in dark startup background\n${formatState(state)}`,
    );

    console.log("tauri terminal startup light-theme background unit test passed");
  } finally {
    if (sessionId) {
      await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
    }
    stopProcess(tauriDriver);
    await devServer.close();
    await isolatedAppConfig.cleanup();
  }

  async function startupThemeState() {
    return await execute(`
      const app = document.body;
      const host = document.querySelector('[data-testid="terminal-host"]');
      const xterm = document.querySelector('.xterm');
      const screen = document.querySelector('.xterm .xterm-screen');
      const rows = document.querySelector('.xterm .xterm-rows');
      const rect = (element) => {
        if (!element) return { width: 0, height: 0 };
        const value = element.getBoundingClientRect();
        return {
          width: Math.round(value.width),
          height: Math.round(value.height),
        };
      };
      const style = (element) => {
        if (!element) return '';
        return getComputedStyle(element).backgroundColor;
      };
      return {
        documentTheme: document.documentElement.dataset.theme ?? '',
        appBackground: style(app),
        terminalBackgroundVariable: getComputedStyle(document.documentElement).getPropertyValue('--terminal-bg').trim(),
        terminalHosts: document.querySelectorAll('[data-testid="terminal-host"]').length,
        xterms: document.querySelectorAll('.xterm').length,
        hostBackground: style(host),
        xtermBackground: style(xterm),
        screenBackground: style(screen),
        xtermRect: rect(xterm),
        screenRect: rect(screen),
        rowsText: rows?.textContent ?? '',
        terminalError: document.querySelector('.terminal-error')?.textContent ?? '',
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
    const state = await startupThemeState();
    return JSON.stringify({
      title: await execute("return document.title;"),
      url: await execute("return location.href;"),
      startupTheme: state,
    }, null, 2);
  }

  function assertLightColor(value, message) {
    const rgb = rgbChannels(value);
    const average = (rgb.red + rgb.green + rgb.blue) / 3;
    if (average < 200) {
      throw new Error(message);
    }
  }

  function assertLightCssColor(value, message) {
    const rgb = cssColorChannels(value);
    const average = (rgb.red + rgb.green + rgb.blue) / 3;
    if (average < 200) {
      throw new Error(message);
    }
  }

  function assertEqual(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(message);
    }
  }

  function assertNotEqual(actual, expected, message) {
    if (actual === expected) {
      throw new Error(message);
    }
  }

  function rgbChannels(value) {
    const normalized = normalizeRgb(value);
    const match = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(normalized);
    if (!match) throw new Error(`expected an rgb() color, got ${value}`);
    return {
      red: Number(match[1]),
      green: Number(match[2]),
      blue: Number(match[3]),
    };
  }

  function cssColorChannels(value) {
    const normalized = normalizeCssColor(value);
    if (normalized.startsWith("#")) {
      if (!/^#[0-9a-f]{6}$/.test(normalized)) throw new Error(`expected a six-digit CSS hex color, got ${value}`);
      return {
        red: Number.parseInt(normalized.slice(1, 3), 16),
        green: Number.parseInt(normalized.slice(3, 5), 16),
        blue: Number.parseInt(normalized.slice(5, 7), 16),
      };
    }
    return rgbChannels(normalized);
  }

  function normalizeCssColor(value) {
    const trimmed = value.trim().toLowerCase();
    if (/^#[0-9a-f]{3}$/.test(trimmed)) {
      return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
    }
    return trimmed;
  }

  function normalizeRgb(value) {
    const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*(?:\d*\.)?\d+)?\)$/.exec(value.trim());
    if (!match) return value.trim();
    return `rgb(${Number(match[1])}, ${Number(match[2])}, ${Number(match[3])})`;
  }

  function formatState(state) {
    return JSON.stringify(state, null, 2);
  }

  function stopProcess(child) {
    if (!child.pid || child.exitCode !== null) return;
    child.kill();
  }

});
