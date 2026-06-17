#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies that Terminal ToolTab content survives switching between two
 * Workspaces. Each Workspace owns its own Terminal ToolTab and backend
 * terminal session, and returning to a Workspace must remount the same xterm
 * content instead of showing a blank terminal surface.
 *
 * Operation:
 * Starts the dev server, starts tauri-driver, launches the Tauri application
 * provided by the TAURI_TEST_APPLICATION environment variable, waits for the
 * initial Local Workspace terminal to render text, creates a second Workspace,
 * waits for its terminal to render text, switches back to the first Workspace,
 * switches again to the second Workspace, and inspects terminal session ids and
 * visible xterm row text after each switch.
 *
 * Expected:
 * Both Workspaces keep distinct Terminal ToolTab ids and distinct term-*
 * backend session ids. Switching away and back keeps each Workspace's visible
 * terminal row text non-empty, keeps the original session id for that
 * Workspace, and never renders a blank terminal surface.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";
import { test } from "vitest";

test("terminal workspace switch preserves content", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("switch-preserves-content");
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

    await waitForVisibleTerminal("initial Workspace terminal did not render text");
    const first = await activeWorkspaceTerminalState();

    await createWorkspace();
    await waitUntil(async () => {
      const state = await workspaceState();
      return state.workspaceIds.length >= 2 && state.activeWorkspaceId !== first.workspaceId;
    }, async () => `second Workspace did not become active\n${await pageSummary()}`);
    await waitForVisibleTerminal("second Workspace terminal did not render text");
    const second = await activeWorkspaceTerminalState();

    if (first.workspaceId === second.workspaceId) {
      throw new Error(`expected a second Workspace, still active on ${first.workspaceId}`);
    }
    if (first.toolTabId === second.toolTabId) {
      throw new Error(`expected distinct Terminal ToolTabs, got ${first.toolTabId}`);
    }
    if (first.sessionId === second.sessionId) {
      throw new Error(`expected distinct backend terminal sessions, got ${first.sessionId}`);
    }

    await activateWorkspace(first.workspaceId);
    await waitForVisibleTerminal("first Workspace terminal became blank after switching back");
    const firstAfterSwitch = await activeWorkspaceTerminalState();
    assertSameTerminal(first, firstAfterSwitch, "first Workspace");

    await activateWorkspace(second.workspaceId);
    await waitForVisibleTerminal("second Workspace terminal became blank after switching back");
    const secondAfterSwitch = await activeWorkspaceTerminalState();
    assertSameTerminal(second, secondAfterSwitch, "second Workspace");

    console.log("tauri terminal workspace switch preserves content unit test passed");
  } finally {
    if (sessionId) {
      await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
    }
    stopProcess(tauriDriver);
    await devServer.close();
    await isolatedAppConfig.cleanup();
  }

  function assertSameTerminal(expected, actual, label) {
    if (actual.workspaceId !== expected.workspaceId) {
      throw new Error(`${label} active Workspace changed: expected ${expected.workspaceId}, got ${actual.workspaceId}`);
    }
    if (actual.toolTabId !== expected.toolTabId) {
      throw new Error(`${label} Terminal ToolTab changed: expected ${expected.toolTabId}, got ${actual.toolTabId}`);
    }
    if (actual.sessionId !== expected.sessionId) {
      throw new Error(`${label} backend session changed: expected ${expected.sessionId}, got ${actual.sessionId}`);
    }
    if (actual.rowsText.trim().length === 0) {
      throw new Error(`${label} terminal rows are blank after Workspace switch`);
    }
  }

  async function createWorkspace() {
    await execute(`
      const button = document.querySelector('.new-workspace');
      if (!button) throw new Error('New workspace button not found');
      button.click();
    `);
  }

  async function activateWorkspace(workspaceId) {
    await execute(`
      const button = document
        .querySelector('[data-testid="workspace-tab-${workspaceId}"] .workspace-activate');
      if (!button) throw new Error('Workspace tab ${workspaceId} not found');
      button.click();
    `);
    await waitUntil(async () => {
      const state = await workspaceState();
      return state.activeWorkspaceId === workspaceId;
    }, async () => `Workspace ${workspaceId} did not become active\n${await pageSummary()}`);
  }

  async function waitForVisibleTerminal(reason) {
    await waitUntil(async () => {
      const state = await activeWorkspaceTerminalState();
      return state.hosts === 1 &&
        state.xterms === 1 &&
        state.sessionId.startsWith("term-") &&
        state.toolTabId.startsWith("tool-terminal-") &&
        state.rowsText.trim().length > 0;
    }, async () => `${reason}\n${await pageSummary()}`);
  }

  async function activeWorkspaceTerminalState() {
    return await execute(`
      const activeWorkspace = document.querySelector('.workspace-tab.active');
      const surface = document.querySelector('[data-testid="terminal-surface"]');
      const activeTerminalSlot = document.querySelector('[data-tool-kind="terminal"].active');
      return {
        workspaceId: activeWorkspace?.getAttribute('data-workspace-id') ?? '',
        toolTabId: surface?.getAttribute('data-tool-tab-id') ?? activeTerminalSlot?.getAttribute('data-tool-tab-id') ?? '',
        sessionId: surface?.getAttribute('data-session-id') ?? activeTerminalSlot?.getAttribute('data-session-id') ?? '',
        rowsText: document.querySelector('.xterm .xterm-rows')?.textContent ?? '',
        hosts: document.querySelectorAll('[data-testid="terminal-host"]').length,
        xterms: document.querySelectorAll('.xterm').length,
      };
    `);
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
        bodyText: document.body?.innerText?.slice(0, 1200) ?? '',
        workspaceState: {
          activeWorkspaceId: document.querySelector('.workspace-tab.active')?.getAttribute('data-workspace-id') ?? '',
          workspaceIds: [...document.querySelectorAll('.workspace-tab')]
            .map((tab) => tab.getAttribute('data-workspace-id'))
            .filter(Boolean),
        },
        terminalState: {
          surface: document.querySelector('[data-testid="terminal-surface"]')?.outerHTML?.slice(0, 500) ?? '',
          terminalSlots: [...document.querySelectorAll('[data-tool-kind="terminal"]')].map((slot) => ({
            active: slot.classList.contains('active'),
            toolTabId: slot.getAttribute('data-tool-tab-id'),
            sessionId: slot.getAttribute('data-session-id'),
          })),
          hosts: document.querySelectorAll('[data-testid="terminal-host"]').length,
          xterms: document.querySelectorAll('.xterm').length,
          rowsText: document.querySelector('.xterm .xterm-rows')?.textContent?.slice(0, 1000) ?? '',
        },
      };
    `).then((summary) => JSON.stringify(summary, null, 2));
  }

  function stopProcess(child) {
    if (!child.pid || child.exitCode !== null) return;
    child.kill();
  }

});
