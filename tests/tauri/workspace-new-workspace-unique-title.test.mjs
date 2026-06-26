#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies that creating additional Workspaces from the same default host does
 * not create duplicate visible Workspace titles.
 *
 * Operation:
 * Starts the Vite dev server, starts tauri-driver, launches the Tauri
 * application provided by the TAURI_TEST_APPLICATION environment variable,
 * reads the initial Workspace title, clicks the New Workspace button twice,
 * and reads the visible Workspace tab titles after each creation.
 *
 * Expected:
 * Each new Workspace is created and activated with a unique title. The first
 * duplicate title receives the ` 2` suffix and the next duplicate receives the
 * ` 3` suffix, while the original Workspace title remains unchanged.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";
import { test } from "vitest";

test("workspace new workspace unique title", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("workspace-new-workspace-unique-title");
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

    await waitUntil(async () => (await workspaceState()).titles.length === 1, async () => `initial Workspace did not mount\n${await pageSummary()}`);
    const initial = await workspaceState();
    const baseTitle = initial.titles[0];
    if (!baseTitle) throw new Error(`initial Workspace title was empty\n${await pageSummary()}`);

    await createWorkspace();
    await waitUntil(async () => {
      const state = await workspaceState();
      return state.titles.length === 2 && state.activeTitle === `${baseTitle} 2`;
    }, async () => `second Workspace did not receive the expected unique title\n${await pageSummary()}`);

    await createWorkspace();
    await waitUntil(async () => {
      const state = await workspaceState();
      return state.titles.length === 3 && state.activeTitle === `${baseTitle} 3`;
    }, async () => `third Workspace did not receive the expected unique title\n${await pageSummary()}`);

    const finalState = await workspaceState();
    const uniqueTitles = new Set(finalState.titles);
    if (uniqueTitles.size !== finalState.titles.length) {
      throw new Error(`Workspace titles were not unique\n${JSON.stringify(finalState, null, 2)}`);
    }
    if (finalState.titles[0] !== baseTitle) {
      throw new Error(`original Workspace title changed\n${JSON.stringify(finalState, null, 2)}`);
    }

    console.log("tauri Workspace new Workspace unique-title unit test passed");
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

  async function workspaceState() {
    return await execute(`
      const tabs = [...document.querySelectorAll('.workspace-tab')];
      const active = document.querySelector('.workspace-tab.active');
      return {
        titles: tabs.map((tab) => tab.querySelector('.workspace-activate span')?.textContent?.trim() ?? ''),
        activeTitle: active?.querySelector('.workspace-activate span')?.textContent?.trim() ?? '',
        activeWorkspaceId: active?.getAttribute('data-workspace-id') ?? '',
        workspaceIds: tabs.map((tab) => tab.getAttribute('data-workspace-id') ?? ''),
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

  async function execute(script, args = []) {
    const response = await webdriver("POST", `/session/${sessionId}/execute/sync`, {
      script,
      args,
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
    return JSON.stringify(await workspaceState(), null, 2);
  }

  function stopProcess(child) {
    if (!child.pid || child.exitCode !== null) return;
    child.kill();
  }

});
