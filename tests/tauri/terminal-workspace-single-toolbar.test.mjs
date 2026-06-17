#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies that the default Local Workspace terminal renders correctly inside a
 * real Tauri window. The Terminal ToolTab must use the Workspace/Dock ToolTab
 * toolbar as its only toolbar, must not render the legacy TerminalTabBar
 * session toolbar, and must mount a working xterm surface instead of a blank
 * content area.
 *
 * Operation:
 * Starts the dev server, starts tauri-driver, launches the Tauri application
 * provided by the TAURI_TEST_APPLICATION environment variable, waits for the
 * Terminal ToolTab to appear in the live Tauri WebView, and inspects the
 * terminal dock group's DOM for Dock ToolTab toolbar, legacy TerminalTabBar,
 * terminal host, and .xterm mount counts.
 *
 * Expected:
 * The terminal dock group contains exactly one Dock ToolTab toolbar, contains
 * zero legacy TerminalTabBar session toolbars, contains at least one terminal
 * host, and contains at least one mounted .xterm element.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";
import { test } from "vitest";

test("terminal workspace single toolbar", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("single-toolbar");
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
      return await execute("return document.querySelector('.terminal-tool-area') !== null;");
    }, async () => `terminal ToolTab did not render\n${await pageSummary()}`);

    await waitUntil(async () => {
      const result = await terminalGroupState();
      return result.ok && result.terminalHosts >= 1 && result.xterms >= 1;
    }, async () => `terminal xterm did not mount\n${await pageSummary()}`);

    const result = await terminalGroupState();

    if (!result.ok) {
      throw new Error(result.reason);
    }
    if (result.toolTabBars !== 1) {
      throw new Error(`expected exactly one ToolTab toolbar, found ${result.toolTabBars}`);
    }
    if (result.legacyTerminalTabBars !== 0) {
      throw new Error(`expected no legacy terminal session toolbar, found ${result.legacyTerminalTabBars}`);
    }

    console.log("tauri terminal workspace single-toolbar unit test passed");
  } finally {
    if (sessionId) {
      await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
    }
    stopProcess(tauriDriver);
    await devServer.close();
    await isolatedAppConfig.cleanup();
  }

  async function terminalGroupState() {
    return await execute(`
      const terminalArea = document.querySelector('.terminal-tool-area');
      const terminalGroup = terminalArea?.closest('.workspace-dock-group');
      if (!terminalGroup) return { ok: false, reason: 'terminal dock group missing' };
      return {
        ok: true,
        groupId: terminalGroup.getAttribute('data-dock-group-id'),
        toolTabBars: terminalGroup.querySelectorAll('.tool-tabbar').length,
        legacyTerminalTabBars: terminalGroup.querySelectorAll('[data-testid="terminal-tabbar"]').length,
        terminalHosts: terminalGroup.querySelectorAll('[data-testid="terminal-host"]').length,
        xterms: terminalGroup.querySelectorAll('.xterm').length,
        text: terminalGroup.textContent,
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
    return await execute(`
      return {
        title: document.title,
        url: location.href,
        bodyText: document.body?.innerText?.slice(0, 1000) ?? '',
        dockGroups: [...document.querySelectorAll('.workspace-dock-group')].map((group) => ({
          id: group.getAttribute('data-dock-group-id'),
          text: group.textContent?.slice(0, 300),
          hasTerminalArea: group.querySelector('.terminal-tool-area') !== null,
          legacyTerminalTabBars: group.querySelectorAll('[data-testid="terminal-tabbar"]').length,
          terminalHosts: group.querySelectorAll('[data-testid="terminal-host"]').length,
          xterms: group.querySelectorAll('.xterm').length,
        })),
      };
    `).then((summary) => JSON.stringify(summary, null, 2));
  }

  function stopProcess(child) {
    if (!child.pid || child.exitCode !== null) return;
    child.kill();
  }

});
