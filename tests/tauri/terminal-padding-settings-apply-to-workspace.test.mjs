#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies that terminal padding settings affect the Workspace Terminal
 * ToolTab surface rendered in the real Tauri WebView.
 *
 * Operation:
 * Starts the Vite dev server, starts tauri-driver, launches the Tauri
 * application provided by the TAURI_TEST_APPLICATION environment variable,
 * writes a real terminal.padding configuration into the isolated app config
 * root, waits for the default Local Workspace terminal to mount, reads the CSS
 * variables written by the settings loader, and measures the terminal surface,
 * host, and mount rectangles in the Workspace surface.
 *
 * Expected:
 * The Workspace terminal host uses the configured padding variables, and the
 * mounted xterm surface is inset from all four visible Terminal surface edges
 * by the configured padding values. The right and bottom padding must reduce
 * the mount size rather than merely overflowing outside the surface and being
 * clipped.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";
import { test } from "vitest";

test("terminal padding settings apply to workspace", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("terminal-padding-settings-apply-to-workspace");
  const configuredPadding = { top: 3, right: 17, bottom: 5, left: 19 };
  const nativeDriverPath = optionalEnvPath("TAURI_TEST_NATIVE_DRIVER");
  const driverPort = Number(process.env.TAURI_TEST_DRIVER_PORT ?? "4444");
  const driverUrl = `http://127.0.0.1:${driverPort}`;
  const devUrl = process.env.TAURI_TEST_DEV_URL ?? "http://localhost:1420/";
  const devPort = Number(new URL(devUrl).port);
  const nativeDriverArgs = nativeDriverPath ? ["--native-driver", nativeDriverPath] : [];

  process.chdir(repoRoot);
  process.env.NOCTURNE_DEV_PORT = String(devPort);
  isolatedAppConfig.env.NOCTURNE_DEV_PORT = String(devPort);
  await writeTerminalPaddingConfig(isolatedAppConfig.env.NOCTURNE_CONFIG_ROOT, configuredPadding);

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
      const state = await terminalPaddingState();
      return state.hosts === 1 && state.mounts === 1 && state.xterms === 1;
    }, async () => `default terminal did not mount\n${await pageSummary()}`);

    await waitUntil(async () => {
      const state = await terminalPaddingState();
      return state.rootPaddingTop === `${configuredPadding.top}px` &&
        state.rootPaddingRight === `${configuredPadding.right}px` &&
        state.rootPaddingBottom === `${configuredPadding.bottom}px` &&
        state.rootPaddingLeft === `${configuredPadding.left}px` &&
        state.paddingTop === `${configuredPadding.top}px` &&
        state.paddingRight === `${configuredPadding.right}px` &&
        state.paddingBottom === `${configuredPadding.bottom}px` &&
        state.paddingLeft === `${configuredPadding.left}px`;
    }, async () => `configured terminal padding settings were not applied\n${await pageSummary()}`);

    await waitUntil(async () => {
      const state = await terminalPaddingState();
      return state.mountInsetTop === configuredPadding.top &&
        state.mountInsetLeft === configuredPadding.left &&
        state.mountInsetRight === configuredPadding.right &&
        state.mountInsetBottom === configuredPadding.bottom &&
        state.mountWidthDelta === configuredPadding.left + configuredPadding.right &&
        state.mountHeightDelta === configuredPadding.top + configuredPadding.bottom &&
        state.surfaceInsetTop === configuredPadding.top &&
        state.surfaceInsetLeft === configuredPadding.left &&
        state.surfaceInsetRight === configuredPadding.right &&
        state.surfaceInsetBottom === configuredPadding.bottom &&
        state.hostOverflowRight === 0 &&
        state.hostOverflowBottom === 0;
    }, async () => `terminal mount was not inset by configured padding\n${await pageSummary()}`);

    console.log("tauri terminal padding settings apply to Workspace unit test passed");
  } finally {
    if (sessionId) {
      await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
    }
    stopProcess(tauriDriver);
    await devServer.close();
    await isolatedAppConfig.cleanup();
  }

  async function terminalPaddingState() {
    return await execute(`
      const surface = document.querySelector('[data-testid="terminal-surface"]');
      const host = document.querySelector('[data-testid="terminal-host"]');
      const mount = document.querySelector('[data-testid="terminal-mount"]');
      const style = host ? getComputedStyle(host) : null;
      const rootStyle = getComputedStyle(document.documentElement);
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
      const surfaceRect = rect(surface);
      const hostRect = rect(host);
      const mountRect = rect(mount);
      return {
        hosts: document.querySelectorAll('[data-testid="terminal-host"]').length,
        mounts: document.querySelectorAll('[data-testid="terminal-mount"]').length,
        xterms: document.querySelectorAll('.xterm').length,
        boxSizing: style?.boxSizing ?? '',
        paddingTop: style?.paddingTop ?? '',
        paddingRight: style?.paddingRight ?? '',
        paddingBottom: style?.paddingBottom ?? '',
        paddingLeft: style?.paddingLeft ?? '',
        rootPaddingTop: rootStyle.getPropertyValue('--terminal-padding-top').trim(),
        rootPaddingRight: rootStyle.getPropertyValue('--terminal-padding-right').trim(),
        rootPaddingBottom: rootStyle.getPropertyValue('--terminal-padding-bottom').trim(),
        rootPaddingLeft: rootStyle.getPropertyValue('--terminal-padding-left').trim(),
        surfaceRect,
        hostRect,
        mountRect,
        mountInsetTop: mountRect.top - hostRect.top,
        mountInsetRight: hostRect.right - mountRect.right,
        mountInsetBottom: hostRect.bottom - mountRect.bottom,
        mountInsetLeft: mountRect.left - hostRect.left,
        mountWidthDelta: hostRect.width - mountRect.width,
        mountHeightDelta: hostRect.height - mountRect.height,
        surfaceInsetTop: mountRect.top - surfaceRect.top,
        surfaceInsetRight: surfaceRect.right - mountRect.right,
        surfaceInsetBottom: surfaceRect.bottom - mountRect.bottom,
        surfaceInsetLeft: mountRect.left - surfaceRect.left,
        hostOverflowRight: Math.max(0, hostRect.right - surfaceRect.right),
        hostOverflowBottom: Math.max(0, hostRect.bottom - surfaceRect.bottom),
        rowsText: document.querySelector('.xterm .xterm-rows')?.textContent ?? '',
        bodyText: document.body?.innerText?.slice(0, 1000) ?? '',
      };
    `);
  }

  async function writeTerminalPaddingConfig(configRoot, padding) {
    if (!configRoot) throw new Error("NOCTURNE_CONFIG_ROOT was not set for the isolated app config");
    await mkdir(configRoot, { recursive: true });
    await writeFile(
      join(configRoot, "config.toml"),
      [
        "[terminal.padding]",
        `top = ${padding.top}`,
        `right = ${padding.right}`,
        `bottom = ${padding.bottom}`,
        `left = ${padding.left}`,
        "",
      ].join("\n"),
      "utf8",
    );
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
    return JSON.stringify(await terminalPaddingState(), null, 2);
  }

  function stopProcess(child) {
    if (!child.pid || child.exitCode !== null) return;
    child.kill();
  }

});
