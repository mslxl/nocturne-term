#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies that dragging the Files ToolTab from a left side Dock group into
 * the middle Terminal content Dock group does not leave stale source-group
 * activation or collapse events behind.
 *
 * Operation:
 * Starts the shared Vite dev server, starts tauri-driver, launches the Tauri
 * application provided by TAURI_TEST_APPLICATION, waits for the default Local
 * Workspace, drags the Files ToolTab from the left rail onto the center of the
 * Terminal group's content surface, releases the pointer, and then dispatches
 * the click event that real browsers may emit at the end of a pointer drag on
 * the original tab element.
 *
 * Expected:
 * The drag shows a group drop preview for the Terminal Dock group, Files moves
 * into the same content Dock group as Terminal, Terminal can be reactivated and
 * remains mounted with non-empty xterm text, and the page never displays a
 * stale error such as "dock group group-files-* not found".
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";
import { test } from "vitest";

test("dragging Files into the Terminal group ignores stale source tab click", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("tooltab-drag-files-into-terminal-group-stale-click");
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

    await waitUntil(async () => {
      const state = await dockState();
      return state.groups.some((group) => group.placement === "left" && group.kinds.includes("files")) &&
        state.groups.some((group) => group.role === "content" && group.kinds.includes("terminal"));
    }, async () => `default Files side group and Terminal content group did not mount\n${await pageSummary()}`);
    await ensureTerminalLive("initial terminal");

    const terminalGroupBeforeDrop = groupForKind(await dockState(), "terminal");
    if (!terminalGroupBeforeDrop) {
      throw new Error(`Terminal Dock group disappeared before drag\n${await pageSummary()}`);
    }
    const preview = await dragFilesIntoTerminalContentAndClickSource();
    assertPreview(preview, "group");
    if (preview.targetGroupId !== terminalGroupBeforeDrop.id) {
      throw new Error(
        `Files drag preview targeted ${preview.targetGroupId}, expected Terminal group ${terminalGroupBeforeDrop.id}\n${await pageSummary()}`,
      );
    }

    await waitUntil(async () => {
      const state = await dockState();
      const terminalGroup = groupForKind(state, "terminal");
      return Boolean(
        terminalGroup &&
          terminalGroup.role === "content" &&
          terminalGroup.kinds.includes("files") &&
          !state.groups.some((group) => group.id.startsWith("group-files-") && !group.kinds.includes("terminal")),
      );
    }, async () => `Files did not move into the Terminal content Dock group\n${await pageSummary()}`);

    await assertNoDockGroupMissingError();
    await clickToolKind("terminal");
    await assertNoDockGroupMissingError();
    await ensureTerminalLive("terminal after Files drop and stale source click");
  } finally {
    if (sessionId) {
      await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
    }
    stopProcess(tauriDriver);
    await devServer.close();
    await isolatedAppConfig.cleanup();
  }

  async function dragFilesIntoTerminalContentAndClickSource() {
    const state = await dockState();
    const files = toolSlot(state, "files");
    const terminalGroup = groupForKind(state, "terminal");
    if (!files) throw new Error(`Files ToolTab was not visible\n${formatState(state)}`);
    if (!terminalGroup) throw new Error(`Terminal Dock group was not visible\n${formatState(state)}`);
    const end = terminalContentCenter(terminalGroup.rect);
    await execute(`
      const [start, end] = arguments;
      const source = document.elementFromPoint(start.x, start.y)?.closest('[data-tool-slot-id]');
      if (!source) throw new Error('No ToolTab element at drag start point');
      window.__nocturneFilesIntoTerminalStaleClickTest = {
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
          pointerId: 173,
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
    `, [center(files.rect), end]);

    await delay(120);
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
      const state = window.__nocturneFilesIntoTerminalStaleClickTest;
      if (!state?.source) throw new Error('No active ToolTab drag test state');
      const dispatchPointer = (target, type, point, buttons) => {
        target.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 173,
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
        dispatchPointer(state.source, 'pointerup', state.end, 0);
        state.source.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          composed: true,
          button: 0,
          clientX: state.end.x,
          clientY: state.end.y,
          view: window,
        }));
      } finally {
        HTMLElement.prototype.setPointerCapture = state.originalSetPointerCapture;
        HTMLElement.prototype.hasPointerCapture = state.originalHasPointerCapture;
        HTMLElement.prototype.releasePointerCapture = state.originalReleasePointerCapture;
        delete window.__nocturneFilesIntoTerminalStaleClickTest;
      }
    `);
    await delay(600);
    return preview;
  }

  async function ensureTerminalLive(label) {
    const dock = await dockState();
    const terminalSlot = dock.toolSlots.find((slot) => slot.kind === "terminal");
    if (!terminalSlot?.active) {
      await clickToolKind("terminal");
    }
    await waitUntil(async () => {
      const state = await terminalState();
      return state.visibleSurfaceCount === 1 &&
        state.visibleXterms === 1 &&
        state.surfaceRect.width >= 160 &&
        state.surfaceRect.height >= 80 &&
        state.rowsText.trim().length > 0 &&
        !state.activeTerminalError &&
        !state.activePlaceholderText;
    }, async () => `${label} is not live\n${await pageSummary()}`);
  }

  async function clickToolKind(kind) {
    await execute(`
      const [kind] = arguments;
      const slot = [...document.querySelectorAll('.workspace-body [data-tool-slot-id]')]
        .find((item) => item.getAttribute('data-tool-kind') === kind);
      if (!slot) throw new Error(\`ToolTab \${kind} not found\`);
      slot.click();
    `, [kind]);
    await delay(300);
  }

  async function assertNoDockGroupMissingError() {
    const bodyText = await execute("return document.body?.innerText ?? '';");
    if (/dock group group-files-[^\\s]* not found/i.test(bodyText) || /Missing:\\s*dock group/i.test(bodyText)) {
      throw new Error(`stale Dock group error is visible after drop\n${bodyText}`);
    }
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

  function terminalContentCenter(rect) {
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + Math.max(96, rect.height / 2)),
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
      const bodyRect = rect(workspaceBody);
      const groups = [...document.querySelectorAll('.workspace-body [data-dock-group-id]')].map((group) => ({
        id: group.getAttribute('data-dock-group-id') ?? '',
        role: group.getAttribute('data-dock-group-role') ?? '',
        placement: group.getAttribute('data-tool-tabbar-placement') ?? '',
        collapsed: group.getAttribute('data-dock-group-collapsed') === 'true',
        rect: rect(group),
        kinds: [...group.querySelectorAll('[data-tool-kind]')]
          .map((slot) => slot.getAttribute('data-tool-kind') ?? '')
          .filter(Boolean),
        slotIds: [...group.querySelectorAll('[data-tool-slot-id]')]
          .map((slot) => slot.getAttribute('data-tool-slot-id') ?? '')
          .filter(Boolean),
      }));
      const toolSlots = [...document.querySelectorAll('.workspace-body [data-tool-slot-id]')].map((slot) => ({
        id: slot.getAttribute('data-tool-slot-id') ?? '',
        kind: slot.getAttribute('data-tool-kind') ?? '',
        title: slot.getAttribute('title') ?? '',
        active: slot.classList.contains('active'),
        visible: visible(slot),
        rect: rect(slot),
        groupId: slot.closest('[data-dock-group-id]')?.getAttribute('data-dock-group-id') ?? '',
        groupPlacement: slot.closest('[data-dock-group-id]')?.getAttribute('data-tool-tabbar-placement') ?? '',
        groupRole: slot.closest('[data-dock-group-id]')?.getAttribute('data-dock-group-role') ?? '',
      }));
      return {
        workspaceBodyRect: bodyRect,
        groups,
        toolSlots,
        bodyText: document.body?.innerText?.slice(0, 1600) ?? '',
      };
    `);
  }

  async function terminalState() {
    return await execute(`
      const allSurfaces = [...document.querySelectorAll('[data-testid="terminal-surface"]')];
      const visibleSurfaces = allSurfaces.filter((item) => {
        const rect = item.getBoundingClientRect();
        const pane = item.closest('.tool-pane');
        return rect.width >= 1 && rect.height >= 1 && !pane?.hidden && pane?.getAttribute('aria-hidden') !== 'true';
      });
      const surface = visibleSurfaces[0];
      const activePane = surface?.closest('.tool-pane');
      const rows = surface?.querySelector('.xterm .xterm-rows');
      const rect = (element) => {
        if (!element) return { width: 0, height: 0, top: 0, left: 0 };
        const value = element.getBoundingClientRect();
        return {
          width: Math.round(value.width),
          height: Math.round(value.height),
          top: Math.round(value.top),
          left: Math.round(value.left),
        };
      };
      return {
        visibleSurfaceCount: visibleSurfaces.length,
        visibleXterms: surface?.querySelectorAll('.xterm').length ?? 0,
        surfaceRect: rect(surface),
        rowsText: rows?.textContent ?? '',
        activeTerminalError: surface?.querySelector('.terminal-error')?.textContent ?? '',
        activePlaceholderText: activePane?.querySelector('.placeholder')?.textContent ?? '',
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
      return `${formatState(await dockState())}\n${formatState(await terminalState())}\n${driverOutput}`;
    } catch (error) {
      return `${error instanceof Error ? error.message : String(error)}\n${driverOutput}`;
    }
  }

  async function waitUntil(predicate, message, timeoutMs = 35_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      if (tauriDriver.exitCode !== null) {
        throw new Error(`tauri-driver exited early with code ${tauriDriver.exitCode}\n${driverOutput}`);
      }
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopProcess(child) {
  if (child.exitCode !== null || child.killed) return;
  child.kill();
}
