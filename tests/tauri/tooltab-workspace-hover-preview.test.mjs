#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies that dragging a Workspace ToolTab over another Workspace tab shows
 * a clear hover preview on the target Workspace tab button before the pointer
 * is released.
 *
 * Operation:
 * Starts the Vite dev server, starts tauri-driver, launches the Tauri
 * application provided by the TAURI_TEST_APPLICATION environment variable,
 * creates a second Workspace, returns to the first Workspace, drags the
 * visible Files ToolTab over the second Workspace tab, and inspects the target
 * tab while the drag is still hovering.
 *
 * Expected:
 * The target Workspace tab button exposes a workspace drop preview marker and
 * remains visibly sized while hovered. The preview communicates that releasing
 * the ToolTab will mirror it into the target Workspace instead of moving
 * ownership out of the source Workspace.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
const isolatedAppConfig = await createIsolatedAppConfigEnv("tooltab-workspace-hover-preview");
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
    const state = await workspaceState();
    return state.workspaceIds.length === 1 && state.visibleToolKinds.includes("files");
  }, async () => `default Workspace did not mount\n${await pageSummary()}`);
  const ownerWorkspaceId = (await workspaceState()).activeWorkspaceId;

  await createWorkspace();
  await waitUntil(async () => {
    const state = await workspaceState();
    return state.workspaceIds.length === 2 && state.activeWorkspaceId !== ownerWorkspaceId;
  }, async () => `second Workspace did not become active\n${await pageSummary()}`);
  const targetWorkspaceId = (await workspaceState()).activeWorkspaceId;

  await activateWorkspace(ownerWorkspaceId);
  const preview = await hoverFilesToolTabOverWorkspace(targetWorkspaceId);
  if (!preview) {
    throw new Error(`expected target Workspace hover preview, got none\n${await pageSummary()}`);
  }
  if (preview.workspaceId !== targetWorkspaceId) {
    throw new Error(`preview marked ${preview.workspaceId}, expected ${targetWorkspaceId}`);
  }
  if (preview.marker !== "true") {
    throw new Error(`target Workspace button did not expose drop preview marker\n${JSON.stringify(preview, null, 2)}`);
  }
  if (preview.rect.width < 80 || preview.rect.height < 20) {
    throw new Error(`target Workspace preview button was not visibly sized\n${JSON.stringify(preview, null, 2)}`);
  }

  console.log("tauri ToolTab Workspace hover preview unit test passed");
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

async function hoverFilesToolTabOverWorkspace(targetWorkspaceId) {
  const points = await execute(`
    const source = document.querySelector('[data-tool-kind="files"]');
    const target = document.querySelector('[data-testid="workspace-tab-${targetWorkspaceId}"] .workspace-activate');
    if (!source) throw new Error('Files ToolTab source not found');
    if (!target) throw new Error('target Workspace button not found');
    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    return {
      start: {
        x: Math.round(sourceRect.left + Math.min(Math.max(sourceRect.width * 0.35, 12), Math.max(12, sourceRect.width - 18))),
        y: Math.round(sourceRect.top + sourceRect.height / 2),
      },
      end: {
        x: Math.round(targetRect.left + targetRect.width / 2),
        y: Math.round(targetRect.top + targetRect.height / 2),
      },
    };
  `);
  await execute(`
    const [start, end] = arguments;
    const source = document.elementFromPoint(start.x, start.y)?.closest('[data-tool-slot-id]');
    if (!source) throw new Error('No ToolTab element at drag start point');
    window.__nocturneToolTabWorkspaceHoverTest = {
      source,
      end,
      originalSetPointerCapture: HTMLElement.prototype.setPointerCapture,
      originalHasPointerCapture: HTMLElement.prototype.hasPointerCapture,
      originalReleasePointerCapture: HTMLElement.prototype.releasePointerCapture,
    };
    HTMLElement.prototype.setPointerCapture = function () {};
    HTMLElement.prototype.hasPointerCapture = function () { return true; };
    HTMLElement.prototype.releasePointerCapture = function () {};
    const dispatch = (target, type, point, buttons) => {
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 91,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons,
        clientX: point.x,
        clientY: point.y,
        view: window,
      }));
    };
    dispatch(source, 'pointerdown', start, 1);
    dispatch(source, 'pointermove', {
      x: Math.round((start.x + end.x) / 2),
      y: Math.round((start.y + end.y) / 2),
    }, 1);
    dispatch(source, 'pointermove', end, 1);
  `, [points.start, points.end]);
  await delay(80);
  const preview = await execute(`
    const button = document.querySelector('[data-testid="workspace-tab-${targetWorkspaceId}"] .workspace-activate');
    const rect = button?.getBoundingClientRect();
    return button && rect ? {
      workspaceId: button.closest('[data-workspace-id]')?.getAttribute('data-workspace-id') ?? '',
      marker: button.getAttribute('data-workspace-drop-preview') ?? '',
      className: button.className,
      rect: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    } : null;
  `);
  await execute(`
    const state = window.__nocturneToolTabWorkspaceHoverTest;
    if (!state?.source) throw new Error('No active ToolTab Workspace hover test state');
    const dispatch = (target, type, point, buttons) => {
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 91,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons,
        clientX: point.x,
        clientY: point.y,
        view: window,
      }));
    };
    try {
      dispatch(state.source, 'pointerup', state.end, 0);
    } finally {
      HTMLElement.prototype.setPointerCapture = state.originalSetPointerCapture;
      HTMLElement.prototype.hasPointerCapture = state.originalHasPointerCapture;
      HTMLElement.prototype.releasePointerCapture = state.originalReleasePointerCapture;
      delete window.__nocturneToolTabWorkspaceHoverTest;
    }
  `);
  await delay(160);
  return preview;
}

async function workspaceState() {
  return await execute(`
    return {
      activeWorkspaceId: document.querySelector('.workspace-tab.active')?.getAttribute('data-workspace-id') ?? '',
      workspaceIds: [...document.querySelectorAll('.workspace-tab')]
        .map((tab) => tab.getAttribute('data-workspace-id'))
        .filter(Boolean),
      workspaceTitles: [...document.querySelectorAll('.workspace-tab .workspace-activate span')]
        .map((span) => span.textContent?.trim() ?? ''),
      visibleToolKinds: [...document.querySelectorAll('[data-tool-kind]')]
        .map((slot) => slot.getAttribute('data-tool-kind') ?? '')
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
