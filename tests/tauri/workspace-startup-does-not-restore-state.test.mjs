#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies that application startup does not restore previously persisted
 * Workspace layout state. A new app process should always begin from the
 * default Workspace template, even if an earlier process saved additional
 * Workspaces to workspace-state.toml.
 *
 * Operation:
 * Starts the dev server, starts tauri-driver with an isolated configuration
 * root, launches the Tauri application, creates a second Workspace so runtime
 * Workspace state is persisted, closes that WebDriver session, then launches a
 * fresh Tauri application session with the same isolated configuration root.
 *
 * Expected:
 * The first session reaches two Workspace tabs after the user action. The
 * second session starts with exactly one Workspace tab, proving startup ignored
 * the previously saved Workspace state instead of restoring it.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";
import { test } from "vitest";

test("workspace startup does not restore state", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("startup-no-restore");
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
    await waitForWorkspaceCount(1, "initial startup did not show the default Workspace");
    await createWorkspace();
    await waitForWorkspaceCount(2, "first session did not persistently create a second Workspace");
    await closeSession();

    sessionId = await createSession();
    await waitForWorkspaceCount(1, "fresh startup restored persisted Workspace state");

    console.log("tauri workspace startup no-restore unit test passed");
  } finally {
    await closeSession().catch(() => undefined);
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

  async function waitForWorkspaceCount(expectedCount, reason) {
    await waitUntil(async () => {
      const state = await workspaceState();
      return state.workspaceIds.length === expectedCount;
    }, async () => `${reason}\n${await pageSummary()}`);
  }

  async function workspaceState() {
    return await execute(`
      return {
        activeWorkspaceId: document.querySelector('.workspace-tab.active')?.getAttribute('data-workspace-id') ?? '',
        workspaceIds: [...document.querySelectorAll('.workspace-tab')]
          .map((tab) => tab.getAttribute('data-workspace-id'))
          .filter(Boolean),
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

  async function closeSession() {
    if (!sessionId) return;
    const id = sessionId;
    sessionId = "";
    await webdriver("DELETE", `/session/${id}`);
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
        workspaceState: {
          activeWorkspaceId: document.querySelector('.workspace-tab.active')?.getAttribute('data-workspace-id') ?? '',
          workspaceIds: [...document.querySelectorAll('.workspace-tab')]
            .map((tab) => tab.getAttribute('data-workspace-id'))
            .filter(Boolean),
        },
      };
    `).then((summary) => JSON.stringify(summary, null, 2));
  }

  function stopProcess(child) {
    if (!child.pid || child.exitCode !== null) return;
    child.kill();
  }

});
