#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies that floating a Workspace ToolTab into a real Tauri floating window
 * leaves both the floating window and the main window responsive.
 *
 * Operation:
 * Starts the Vite dev server, starts tauri-driver, launches the Tauri
 * application provided by the TAURI_TEST_APPLICATION environment variable,
 * waits for the default Local Workspace, opens the Files ToolTab context menu,
 * clicks Float ToolTab, waits for a second native WebView window handle,
 * switches into the floating window to execute script and inspect its Files
 * ToolTab mirror surface, verifies the floating mirror window does not expose
 * a Restore action, switches back to the main window and activates the Terminal
 * ToolTab, closes the floating window, and verifies the original main Workspace
 * Files ToolTab was never moved.
 *
 * Expected:
 * The floating window opens, responds to WebView script execution, renders the
 * floating Files ToolTab mirror surface, the original Files slot remains a
 * live owned ToolTab in the main Workspace, the floating mirror has no Restore
 * action because it is only another mirror display, the main window remains
 * responsive to WebView script execution and user interaction, activating
 * Terminal still renders the Terminal surface instead of leaving the app
 * unresponsive, and closing the floating window removes only the floating mirror.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";
import { test } from "vitest";

test("floating window open keeps main responsive", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("floating-window-open-keeps-main-responsive");
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
      const state = await pageState(12_000);
      return state.toolSlots.some((slot) => slot.kind === "files" && slot.visible) &&
        state.toolSlots.some((slot) => slot.kind === "terminal" && slot.visible) &&
        state.toolSlots.some((slot) => slot.kind === "transfers" && slot.visible);
    }, pageSummary);

    await floatFilesToolTab();

    await waitUntil(async () => {
      const handles = await windowHandles();
      return handles.length >= 2;
    }, async () => `Floating window handle was not created\n${await pageSummary()}`, 20_000);

    let floatingHandle = "";
    await waitUntil(async () => {
      floatingHandle = await findFloatingWindowHandle(mainHandle);
      return floatingHandle !== "";
    }, async () => `Floating window did not render app content\n${JSON.stringify(await describeWindowHandles(), null, 2)}`, 20_000);
    await waitUntil(async () => {
      const state = await floatingWindowState(8_000);
      return state.bodyResponsiveMarker === "ok" &&
        state.shellVisible &&
        state.filesSurfaceVisible &&
        state.toolSlots.some((slot) => slot.kind === "files" && slot.mirror && slot.visible) &&
        state.headerText.includes("Floating ToolTabs") &&
        !state.restoreActionVisible;
    }, async () => `Floating window did not respond after opening\n${await floatingWindowSummary()}`, 20_000);

    await switchToWindow(mainHandle);
    await waitUntil(async () => {
      const state = await pageState(8_000);
      return state.floatingPlaceholders.length === 0 &&
        state.toolSlots.some((slot) => slot.kind === "files" && slot.visible && !slot.placeholder && !slot.mirror);
    }, async () => `Main Workspace Files ToolTab was moved when floating should create a mirror\n${await pageSummary()}`, 20_000);

    await activateToolTab("terminal");
    await waitUntil(async () => {
      const state = await pageState(4_000);
      return state.activeToolKinds.includes("terminal") &&
        state.terminalSurfaceVisible &&
        !state.toolTabContextMenuVisible &&
        state.bodyResponsiveMarker === "ok";
    }, async () => `Main window stopped responding after opening a floating window\n${await pageSummary()}`, 20_000);

    await switchToWindow(floatingHandle);
    await closeCurrentWindow();
    await switchToWindow(mainHandle);
    await waitUntil(async () => {
      const state = await pageState(8_000);
      return state.floatingPlaceholders.length === 0 &&
        state.toolSlots.some((slot) => slot.kind === "files" && slot.visible && !slot.placeholder && !slot.mirror);
    }, async () => `Closing the floating window affected the original Files ToolTab\n${await pageSummary()}`, 20_000);

    console.log("tauri floating window open responsiveness unit test passed");
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

  async function findFloatingWindowHandle(mainHandle) {
    const handles = await windowHandles();
    for (const handle of handles) {
      if (handle === mainHandle) continue;
      await switchToWindow(handle);
      const state = await floatingWindowState(8_000);
      if (state.shellVisible || state.headerText.includes("Floating ToolTabs")) return handle;
    }
    await switchToWindow(mainHandle);
    return "";
  }

  async function describeWindowHandles() {
    const current = await currentWindowHandle().catch(() => "");
    const descriptions = [];
    for (const handle of await windowHandles()) {
      await switchToWindow(handle);
      descriptions.push({ handle, state: await floatingWindowState(8_000).catch((error) => ({ error: String(error) })) });
    }
    if (current) await switchToWindow(current).catch(() => undefined);
    return descriptions;
  }

  async function floatingWindowState(timeoutMs = 10_000) {
    return await execute(`
      window.__NOCTURNE_FLOATING_WINDOW_RESPONSIVE_MARKER__ = 'ok';
      const visible = (element) => {
        const value = element?.getBoundingClientRect();
        return Boolean(value && value.width > 0 && value.height > 0);
      };
      return {
        bodyResponsiveMarker: window.__NOCTURNE_FLOATING_WINDOW_RESPONSIVE_MARKER__,
        href: window.location.href,
        readyState: document.readyState,
        title: document.title,
        shellVisible: visible(document.querySelector('.floating-window-shell')),
        filesSurfaceVisible: visible(document.querySelector('.files-tooltab')),
        headerText: document.querySelector('.floating-window-shell > header')?.textContent?.trim() ?? '',
        restoreActionVisible: [...document.querySelectorAll('.floating-window-shell > header button')]
          .some((button) => button.textContent?.trim() === 'Restore' && visible(button)),
        toolSlots: [...document.querySelectorAll('[data-tool-slot-id]')].map((slot) => ({
          id: slot.getAttribute('data-tool-slot-id') ?? '',
          kind: slot.getAttribute('data-tool-kind') ?? '',
          title: slot.getAttribute('title') ?? '',
          mirror: slot.classList.contains('mirror'),
          visible: visible(slot),
        })),
        htmlLength: document.documentElement?.outerHTML?.length ?? 0,
        bodyText: document.body?.innerText?.slice(0, 1200) ?? '',
      };
    `, [], timeoutMs);
  }

  async function pageState(timeoutMs = 10_000) {
    return await execute(`
      window.__NOCTURNE_FLOATING_RESPONSIVE_MARKER__ = 'ok';
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
      const visible = (element) => {
        const value = element.getBoundingClientRect();
        return value.width > 0 && value.height > 0;
      };
      const toolSlots = [...document.querySelectorAll('[data-tool-slot-id]')].map((slot) => ({
        id: slot.getAttribute('data-tool-slot-id') ?? '',
        kind: slot.getAttribute('data-tool-kind') ?? '',
        title: slot.getAttribute('title') ?? '',
        active: slot.getAttribute('aria-selected') === 'true',
        placeholder: slot.classList.contains('placeholder'),
        mirror: slot.classList.contains('mirror'),
        visible: visible(slot),
        rect: rect(slot),
      }));
      const floatingPlaceholders = [...document.querySelectorAll('.tool-tab.placeholder')].map((slot) => ({
        id: slot.getAttribute('data-tool-slot-id') ?? '',
        kind: slot.getAttribute('data-tool-kind') ?? '',
        title: slot.getAttribute('title') ?? '',
        visible: visible(slot),
      }));
      return {
        activeToolKinds: toolSlots.filter((slot) => slot.active).map((slot) => slot.kind),
        bodyResponsiveMarker: window.__NOCTURNE_FLOATING_RESPONSIVE_MARKER__,
        floatingPlaceholders,
        terminalSurfaceVisible: document.querySelector('.terminal-surface')?.getBoundingClientRect().height > 0,
        toolTabContextMenuVisible: document.querySelector('[data-tooltab-menu="true"]') !== null,
        toolSlots,
        bodyText: document.body?.innerText?.slice(0, 1200) ?? '',
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

  async function closeCurrentWindow() {
    await webdriver("DELETE", `/session/${sessionId}/window`, undefined, 4_000);
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
    return JSON.stringify(await pageState(12_000), null, 2);
  }

  async function floatingWindowSummary() {
    if (!sessionId) return "no WebDriver session";
    return JSON.stringify(await floatingWindowState(12_000), null, 2);
  }

  function stopProcess(child) {
    if (!child.pid || child.exitCode !== null) return;
    child.kill();
  }

});
