#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies that Workspace ToolTab pointer dragging can dock a ToolTab to the
 * outer Workspace edges, not only move it between the existing content and
 * bottom Dock groups.
 *
 * Operation:
 * Starts the Vite dev server, starts tauri-driver, launches the Tauri
 * application provided by the TAURI_TEST_APPLICATION environment variable,
 * waits for the default Local Workspace, drags the Files ToolTab into the
 * content Dock group, drags that Files ToolTab to the left Workspace edge, and
 * drags the bottom Transfers ToolTab directly to the right Workspace edge using
 * real WebView pointer events in the launched Tauri application. During each
 * drag, the test inspects the hover drop preview before releasing the pointer.
 *
 * Expected:
 * After the left-edge drag, Files is docked in a left sidebar group before the
 * content group. After the right-edge drag, Transfers is docked in a right-side
 * group after the content group. The hover preview must be visible and must
 * mark the area that will receive the ToolTab before the pointer is released.
 * Edge docking must work even when the pointer is over a Dock group's surface
 * rather than directly over an existing tab.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
const isolatedAppConfig = await createIsolatedAppConfigEnv("tooltab-edge-docking");
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
    const state = await dockState();
    return state.groups.some((group) => group.role === "sidebar" && group.kinds.includes("files")) &&
      state.groups.some((group) => group.role === "content" && group.kinds.includes("terminal")) &&
      state.groups.some((group) => group.role === "panel" && group.kinds.includes("transfers"));
  }, async () => `default Dock layout did not mount\n${await pageSummary()}`);

  const groupPreview = await dragToolKindToGroupSurface("files", "content");
  assertPreview(groupPreview, "group");
  await waitUntil(async () => {
    const state = await dockState();
    const content = contentGroup(state);
    return Boolean(content?.kinds.includes("files")) && !state.groups.some((group) => group.role === "sidebar");
  }, async () => `Files ToolTab did not move into the content Dock group\n${await pageSummary()}`);

  const leftEdgePreview = await dragToolKindToWorkspaceEdge("files", "left");
  assertPreview(leftEdgePreview, "workspace_edge", "left");
  await waitUntil(async () => {
    const state = await dockState();
    const sidebar = state.groups.find((group) => group.role === "sidebar" && group.kinds.includes("files"));
    const content = contentGroup(state);
    return Boolean(sidebar && content && sidebar.rect.left < content.rect.left && !content.kinds.includes("files"));
  }, async () => `Files ToolTab did not dock to the left Workspace edge\n${await pageSummary()}`);

  const rightEdgePreview = await dragToolKindToWorkspaceEdge("transfers", "right");
  assertPreview(rightEdgePreview, "workspace_edge", "right");
  await waitUntil(async () => {
    const state = await dockState();
    const content = contentGroup(state);
    const rightPanel = state.groups.find((group) => group.role === "panel" && group.kinds.includes("transfers"));
    return Boolean(content && rightPanel && rightPanel.rect.left > content.rect.left && !content.kinds.includes("transfers"));
  }, async () => `Transfers ToolTab did not dock to the right Workspace edge\n${await pageSummary()}`);

  console.log("tauri ToolTab edge docking unit test passed");
} finally {
  if (sessionId) {
    await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
  }
  stopProcess(tauriDriver);
  await devServer.close();
  await isolatedAppConfig.cleanup();
}

async function dragToolKindToGroupSurface(kind, role) {
  const state = await dockState();
  const source = toolSlot(state, kind);
  const target = state.groups.find((group) => group.role === role);
  if (!source) throw new Error(`ToolTab ${kind} was not visible\n${formatState(state)}`);
  if (!target) throw new Error(`Dock group role ${role} was not visible\n${formatState(state)}`);
  return await pointerDrag(center(source.rect), {
    x: Math.round(target.rect.left + target.rect.width / 2),
    y: Math.round(target.rect.top + Math.max(46, target.rect.height / 2)),
  });
}

async function dragToolKindToWorkspaceEdge(kind, side) {
  const state = await dockState();
  const source = toolSlot(state, kind);
  const targetGroup = side === "left"
    ? contentGroup(state)
    : contentGroup(state) ?? state.groups.find((group) => group.kinds.includes(kind));
  if (!source) throw new Error(`ToolTab ${kind} was not visible\n${formatState(state)}`);
  if (!targetGroup) throw new Error(`No target group was visible for ${side} edge docking\n${formatState(state)}`);
  const body = state.workspaceBodyRect;
  return await pointerDrag(center(source.rect), {
    x: side === "left" ? Math.round(body.left + 4) : Math.round(body.right - 4),
    y: Math.round(targetGroup.rect.top + targetGroup.rect.height / 2),
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
        pointerId: 77,
        pointerType: 'mouse',
        isPrimary: true,
        button: type === 'pointerup' ? 0 : 0,
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
        pointerId: 77,
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

function assertPreview(preview, kind, side = "") {
  if (!preview) throw new Error(`expected ${kind} drop preview before pointer release`);
  if (preview.kind !== kind) {
    throw new Error(`expected ${kind} drop preview, got ${preview.kind}\n${JSON.stringify(preview, null, 2)}`);
  }
  if (side && preview.side !== side) {
    throw new Error(`expected ${side} drop preview side, got ${preview.side}\n${JSON.stringify(preview, null, 2)}`);
  }
  if (!preview.visible || preview.rect.width < 24 || preview.rect.height < 24) {
    throw new Error(`drop preview was not visibly sized\n${JSON.stringify(preview, null, 2)}`);
  }
}

function contentGroup(state) {
  return state.groups.find((group) => group.role === "content") ?? null;
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

async function dockState() {
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
    const groups = [...document.querySelectorAll('[data-dock-group-id]')].map((group) => ({
      id: group.getAttribute('data-dock-group-id') ?? '',
      role: group.getAttribute('data-dock-group-role') ?? '',
      rect: rect(group),
      kinds: [...group.querySelectorAll('[data-tool-kind]')]
        .map((slot) => slot.getAttribute('data-tool-kind') ?? '')
        .filter(Boolean),
      slotIds: [...group.querySelectorAll('[data-tool-slot-id]')]
        .map((slot) => slot.getAttribute('data-tool-slot-id') ?? '')
        .filter(Boolean),
    }));
    const toolSlots = [...document.querySelectorAll('[data-tool-slot-id]')].map((slot) => ({
      id: slot.getAttribute('data-tool-slot-id') ?? '',
      kind: slot.getAttribute('data-tool-kind') ?? '',
      title: slot.getAttribute('title') ?? '',
      visible: visible(slot),
      rect: rect(slot),
      groupId: slot.closest('[data-dock-group-id]')?.getAttribute('data-dock-group-id') ?? '',
      groupRole: slot.closest('[data-dock-group-id]')?.getAttribute('data-dock-group-role') ?? '',
    }));
    return {
      workspaceBodyRect: rect(document.querySelector('.workspace-body')),
      groups,
      toolSlots,
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
  const state = await dockState();
  return JSON.stringify(state, null, 2);
}

function formatState(state) {
  return JSON.stringify(state, null, 2);
}

function stopProcess(child) {
  if (!child.pid || child.exitCode !== null) return;
  child.kill();
}
