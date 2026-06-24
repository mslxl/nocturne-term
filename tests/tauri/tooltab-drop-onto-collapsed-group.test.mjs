#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies that a collapsed side Dock group remains a valid ToolTab drop
 * target in the real Tauri WebView.
 *
 * Operation:
 * Starts the shared Vite dev server, starts tauri-driver, launches the Tauri
 * application provided by TAURI_TEST_APPLICATION, waits for the default
 * Workspace, collapses the left Files Dock group, drags the Transfer Queue
 * ToolTab over the collapsed Files rail, inspects the hover drop preview, and
 * releases the pointer on that rail.
 *
 * Expected:
 * The collapsed Files rail is hit-tested as a Dock group target, not as the
 * outer Workspace edge or a split target. The hover preview highlights the
 * collapsed group area. Releasing the ToolTab adds it to the collapsed group,
 * expands that group, and activates the dropped ToolTab.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";
import { test } from "vitest";

test("collapsed Dock groups accept dropped ToolTabs", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("tooltab-drop-onto-collapsed-group");
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

    await waitUntil(async () => {
      const state = await dockState();
      return state.groups.some((group) => group.placement === "left" && group.kinds.includes("files")) &&
        state.groups.some((group) => group.placement === "right" && group.kinds.includes("transfers"));
    }, async () => `default side Dock groups did not mount\n${await pageSummary()}`);

    await clickToolKind("files");
    await waitUntil(async () => {
      const state = await dockState();
      const group = groupForKind(state, "files");
      return Boolean(group?.collapsed && group.placement === "left" && group.rect.width <= 40 && group.tabbarVisible);
    }, async () => `left Files Dock group did not collapse\n${await pageSummary()}`);

    const preview = await dragToolKindOntoCollapsedGroup("transfers", "files");
    assertPreview(preview, "group", "");
    if (preview.targetGroupId !== groupForKind(await dockState(), "files")?.id) {
      throw new Error(`collapsed group preview did not target Files group\n${JSON.stringify(preview, null, 2)}\n${await pageSummary()}`);
    }

    await waitUntil(async () => {
      const state = await dockState();
      const filesGroup = groupForKind(state, "files");
      const transfers = state.toolSlots.find((slot) => slot.kind === "transfers");
      return Boolean(
        filesGroup &&
        !filesGroup.collapsed &&
        filesGroup.kinds.includes("files") &&
        filesGroup.kinds.includes("transfers") &&
        transfers?.active &&
        transfers.groupId === filesGroup.id,
      );
    }, async () => `dropped ToolTab did not expand and join the collapsed Files group\n${await pageSummary()}`);

    console.log("tauri ToolTab collapsed group drop unit test passed");
  } finally {
    if (sessionId) {
      await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
    }
    stopProcess(tauriDriver);
    await devServer.close();
    await isolatedAppConfig.cleanup();
  }

  async function clickToolKind(kind) {
    await execute(`
      const [kind] = arguments;
      const slot = [...document.querySelectorAll('.workspace-body [data-tool-slot-id]')]
        .find((item) => item.getAttribute('data-tool-kind') === kind);
      if (!slot) throw new Error(\`ToolTab \${kind} not found\`);
      slot.click();
    `, [kind]);
    await delay(250);
  }

  async function dragToolKindOntoCollapsedGroup(sourceKind, targetKind) {
    const state = await dockState();
    const source = toolSlot(state, sourceKind);
    const targetGroup = groupForKind(state, targetKind);
    if (!source) throw new Error(`ToolTab ${sourceKind} was not visible\n${formatState(state)}`);
    if (!targetGroup) throw new Error(`target ToolTab group ${targetKind} was not visible\n${formatState(state)}`);
    if (!targetGroup.collapsed) throw new Error(`target ToolTab group ${targetKind} was not collapsed\n${formatState(state)}`);
    return await pointerDrag(center(source.rect), {
      x: Math.round(targetGroup.rect.left + targetGroup.rect.width / 2),
      y: Math.round(targetGroup.rect.top + targetGroup.rect.height / 2),
    });
  }

  async function pointerDrag(start, end) {
    await execute(`
      const [start, end] = arguments;
      const source = document.elementFromPoint(start.x, start.y)?.closest('[data-tool-slot-id]');
      if (!source) throw new Error('No ToolTab element at drag start point');
      window.__nocturneToolTabCollapsedGroupDropTest = {
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
          pointerId: 137,
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
    await delay(100);
    const preview = await execute(`
      const preview = document.querySelector('[data-tooltab-drop-preview]');
      const previewRect = preview?.getBoundingClientRect();
      const targetGroup = document.querySelector('[data-dock-group-id].drop-target');
      return preview && previewRect ? {
        kind: preview.getAttribute('data-drop-kind') ?? '',
        side: preview.getAttribute('data-drop-side') ?? '',
        targetGroupId: targetGroup?.getAttribute('data-dock-group-id') ?? '',
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
      const state = window.__nocturneToolTabCollapsedGroupDropTest;
      if (!state?.source) throw new Error('No active ToolTab drag test state');
      const dispatch = (target, type, point, buttons) => {
        target.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 137,
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
        delete window.__nocturneToolTabCollapsedGroupDropTest;
      }
    `);
    await delay(300);
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

  function groupForKind(state, kind) {
    return state.groups.find((group) => group.kinds.includes(kind)) ?? null;
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
        if (!element) return false;
        const value = element.getBoundingClientRect();
        return value.width > 0 && value.height > 0;
      };
      const workspaceBody = document.querySelector('.workspace-body');
      if (!workspaceBody) {
        return {
          groups: [],
          toolSlots: [],
          bodyText: document.body?.innerText?.slice(0, 1200) ?? '',
        };
      }
      const groups = [...workspaceBody.querySelectorAll('[data-dock-group-id]')].map((group) => ({
        id: group.getAttribute('data-dock-group-id') ?? '',
        role: group.getAttribute('data-dock-group-role') ?? '',
        placement: group.getAttribute('data-tool-tabbar-placement') ?? '',
        collapsed: group.getAttribute('data-dock-group-collapsed') === 'true',
        rect: rect(group),
        tabbarVisible: visible(group.querySelector('.tool-tabbar')),
        kinds: [...group.querySelectorAll('[data-tool-kind]')]
          .map((slot) => slot.getAttribute('data-tool-kind') ?? '')
          .filter(Boolean),
      }));
      const toolSlots = [...workspaceBody.querySelectorAll('[data-tool-slot-id]')].map((slot) => ({
        id: slot.getAttribute('data-tool-slot-id') ?? '',
        kind: slot.getAttribute('data-tool-kind') ?? '',
        active: slot.classList.contains('active'),
        visible: visible(slot),
        rect: rect(slot),
        groupId: slot.closest('[data-dock-group-id]')?.getAttribute('data-dock-group-id') ?? '',
      }));
      return {
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
    }, () => `tauri-driver did not start\n${driverOutput}`);
  }

  async function waitForDevServer() {
    await waitUntil(async () => {
      try {
        const response = await fetch(devUrl);
        return response.ok;
      } catch {
        return false;
      }
    }, () => `Vite dev server did not start at ${devUrl}`);
  }

  async function pageSummary() {
    if (!sessionId) return driverOutput;
    try {
      const state = await dockState();
      return `${formatState(state)}\n${driverOutput}`;
    } catch (error) {
      return `${error instanceof Error ? error.message : String(error)}\n${driverOutput}`;
    }
  }
});

function requiredEnvPath(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for Tauri tests`);
  }
  if (!existsSync(value)) {
    throw new Error(`${name} does not exist: ${value}`);
  }
  return value;
}

function optionalEnvPath(name) {
  const value = process.env[name];
  if (!value) return "";
  if (!existsSync(value)) {
    throw new Error(`${name} does not exist: ${value}`);
  }
  return value;
}

function formatState(state) {
  return JSON.stringify(state, null, 2);
}

async function waitUntil(predicate, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  const details = typeof message === "function" ? await message() : message;
  throw new Error(`${details}${lastError ? `\nLast error: ${lastError.message ?? lastError}` : ""}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopProcess(child) {
  if (child.exitCode !== null || child.killed) return;
  child.kill();
}
