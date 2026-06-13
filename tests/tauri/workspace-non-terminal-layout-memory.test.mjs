#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies current-process runtime layout memory for non-Terminal Workspace
 * ToolTabs through the real Tauri WebView.
 *
 * Operation:
 * Starts the Vite dev server, starts tauri-driver, launches the Tauri
 * application provided by the TAURI_TEST_APPLICATION environment variable,
 * closes the default Resource Monitor ToolTab, drags the Transfer Queue ToolTab
 * into the content dock group, creates a new Workspace, and inspects the active
 * Workspace's visible ToolTabs and dock group placement.
 *
 * Expected:
 * The newly created Workspace keeps exactly one Terminal ToolTab, does not
 * force-add the Resource Monitor ToolTab the user closed in this running app
 * process, and places Transfer Queue according to the remembered non-Terminal
 * layout instead of the original right-side default group.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
const isolatedAppConfig = await createIsolatedAppConfigEnv("workspace-non-terminal-layout-memory");
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
    const state = await activeWorkspaceDockState();
    return state.workspaceCount === 1 &&
      state.toolSlots.some((slot) => slot.kind === "resources" && slot.groupRole === "sidebar") &&
      state.toolSlots.some((slot) => slot.kind === "transfers" && slot.groupRole === "sidebar") &&
      state.toolSlots.some((slot) => slot.kind === "terminal" && slot.groupRole === "content");
  }, async () => `initial Resource Monitor default layout did not mount\n${await pageSummary()}`);

  await closeActiveToolKind("resources");
  await waitUntil(async () => {
    const state = await activeWorkspaceDockState();
    return !state.toolSlots.some((slot) => slot.kind === "resources");
  }, async () => `Resource Monitor ToolTab did not close\n${await pageSummary()}`);

  const preview = await dragToolKindToGroupSurface("transfers", "content");
  assertPreview(preview, "group");
  await waitUntil(async () => {
    const state = await activeWorkspaceDockState();
    return state.toolSlots.some((slot) => slot.kind === "transfers" && slot.groupRole === "content");
  }, async () => `Transfer Queue did not move into content\n${await pageSummary()}`);

  await createWorkspace();
  await waitUntil(async () => {
    const state = await activeWorkspaceDockState();
    const kinds = state.toolSlots.map((slot) => slot.kind).filter(Boolean);
    return state.workspaceCount === 2 &&
      kinds.filter((kind) => kind === "terminal").length === 1 &&
      !kinds.includes("resources") &&
      state.toolSlots.some((slot) => slot.kind === "transfers" && slot.groupRole === "content");
  }, async () => `new Workspace did not preserve non-Terminal layout memory\n${await pageSummary()}`);

  console.log("tauri Workspace non-Terminal layout memory unit test passed");
} finally {
  if (sessionId) {
    await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
  }
  stopProcess(tauriDriver);
  await devServer.close();
  await isolatedAppConfig.cleanup();
}

async function closeActiveToolKind(kind) {
  await execute(`
    const [kind] = arguments;
    const tab = [...document.querySelectorAll('.workspace-tab.active ~ * [data-tool-slot-id], .workspace-body [data-tool-slot-id]')]
      .find((slot) => slot.getAttribute('data-tool-kind') === kind);
    const close = tab?.querySelector('.tool-close');
    if (!tab) throw new Error(\`ToolTab \${kind} not found\`);
    if (!tab.classList.contains('active')) tab.click();
    const activeClose = tab.querySelector('.tool-close') ?? document.querySelector(\`.tool-tab.active[data-tool-kind="\${kind}"] .tool-close\`);
    if (!activeClose) throw new Error(\`Close button for ToolTab \${kind} not found\`);
    activeClose.click();
  `, [kind]);
  await delay(250);
}

async function createWorkspace() {
  await execute(`
    const button = document.querySelector('.new-workspace');
    if (!button) throw new Error('New workspace button not found');
    button.click();
  `);
}

async function dragToolKindToGroupSurface(kind, role) {
  const state = await activeWorkspaceDockState();
  const source = toolSlot(state, kind);
  const target = state.groups.find((group) => group.role === role);
  if (!source) throw new Error(`ToolTab ${kind} was not visible\n${formatState(state)}`);
  if (!target) throw new Error(`Dock group role ${role} was not visible\n${formatState(state)}`);
  return await pointerDrag(center(source.rect), {
    x: Math.round(target.rect.left + target.rect.width / 2),
    y: Math.round(target.rect.top + Math.max(46, target.rect.height / 2)),
  });
}

async function pointerDrag(start, end) {
  await execute(`
    const [start, end] = arguments;
    const source = document.elementFromPoint(start.x, start.y)?.closest('[data-tool-slot-id]');
    if (!source) throw new Error('No ToolTab element at drag start point');
    window.__nocturneToolTabDragTest = {
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
  `, [start, end]);
  await delay(80);
  const preview = await execute(`
    const preview = document.querySelector('[data-tooltab-drop-preview]');
    const previewRect = preview?.getBoundingClientRect();
    return preview && previewRect ? {
      kind: preview.getAttribute('data-drop-kind') ?? '',
      side: preview.getAttribute('data-drop-side') ?? '',
      visible: previewRect.width > 0 && previewRect.height > 0,
      rect: {
        left: Math.round(previewRect.left),
        top: Math.round(previewRect.top),
        right: Math.round(previewRect.right),
        bottom: Math.round(previewRect.bottom),
        width: Math.round(previewRect.width),
        height: Math.round(previewRect.height),
      },
    } : null;
  `);
  await execute(`
    const state = window.__nocturneToolTabDragTest;
    if (!state?.source) throw new Error('No active ToolTab drag test state');
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
      delete window.__nocturneToolTabDragTest;
    }
  `);
  await delay(250);
  return preview;
}

function assertPreview(preview, kind) {
  if (!preview) throw new Error(`expected ${kind} drop preview before pointer release`);
  if (preview.kind !== kind) {
    throw new Error(`expected ${kind} drop preview, got ${preview.kind}\n${JSON.stringify(preview, null, 2)}`);
  }
  if (!preview.visible || preview.rect.width < 24 || preview.rect.height < 24) {
    throw new Error(`drop preview was not visibly sized\n${JSON.stringify(preview, null, 2)}`);
  }
}

function toolSlot(state, kind) {
  return state.toolSlots.find((slot) => slot.kind === kind && slot.visible) ?? null;
}

function center(rect) {
  return {
    x: Math.round(rect.left + Math.min(Math.max(rect.width * 0.35, 12), Math.max(12, rect.width - 18))),
    y: Math.round(rect.top + rect.height / 2),
  };
}

async function activeWorkspaceDockState() {
  return await execute(`
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
    const activeWorkspaceId = document.querySelector('.workspace-tab.active')?.getAttribute('data-workspace-id') ?? '';
    const workspaceBody = document.querySelector('.workspace-body');
    if (!workspaceBody) {
      return {
        activeWorkspaceId,
        workspaceCount: document.querySelectorAll('.workspace-tab').length,
        groups: [],
        toolSlots: [],
        bodyText: document.body?.innerText?.slice(0, 1200) ?? '',
      };
    }
    const groups = [...workspaceBody.querySelectorAll('[data-dock-group-id]')].map((group) => ({
      id: group.getAttribute('data-dock-group-id') ?? '',
      role: group.getAttribute('data-dock-group-role') ?? '',
      rect: rect(group),
      kinds: [...group.querySelectorAll('[data-tool-kind]')]
        .map((slot) => slot.getAttribute('data-tool-kind') ?? '')
        .filter(Boolean),
    }));
    const toolSlots = [...workspaceBody.querySelectorAll('[data-tool-slot-id]')].map((slot) => ({
      id: slot.getAttribute('data-tool-slot-id') ?? '',
      kind: slot.getAttribute('data-tool-kind') ?? '',
      title: slot.getAttribute('title') ?? '',
      visible: visible(slot),
      active: slot.classList.contains('active'),
      rect: rect(slot),
      groupId: slot.closest('[data-dock-group-id]')?.getAttribute('data-dock-group-id') ?? '',
      groupRole: slot.closest('[data-dock-group-id]')?.getAttribute('data-dock-group-role') ?? '',
    }));
    return {
      activeWorkspaceId,
      workspaceCount: document.querySelectorAll('.workspace-tab').length,
      groups,
      toolSlots,
      bodyText: document.body?.innerText?.slice(0, 1200) ?? '',
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
  return JSON.stringify(await activeWorkspaceDockState(), null, 2);
}

function formatState(state) {
  return JSON.stringify(state, null, 2);
}

function stopProcess(child) {
  if (!child.pid || child.exitCode !== null) return;
  child.kill();
}
