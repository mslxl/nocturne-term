#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies the shortest real-pointer drag path for moving the default Files
 * ToolTab from the initial left Dock group directly onto the left edge of the
 * default Terminal content Dock group.
 *
 * Operation:
 * Starts the Vite dev server, starts tauri-driver, launches the Tauri
 * application provided by TAURI_TEST_APPLICATION, waits for the default Local
 * Workspace, installs an async browser error probe, then uses WebDriver
 * pointer actions to drag Files from the initial left side-panel group to the
 * Terminal group's left split zone without first activating Terminal.
 *
 * Expected:
 * The hover preview is a left group-edge split preview. After release, Files
 * is a local left side-panel immediately beside Terminal in the same upper
 * split, not a full-height global Workspace-left dock. Terminal remains a
 * content group with exactly one visible terminal surface, a mounted xterm,
 * visible terminal rows, and no "terminal pane ... did not mount a visible
 * container" error.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";
import { test } from "vitest";

test("Dragging initial Files directly to the left of Terminal keeps Terminal mounted", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("tooltab-drag-files-initial-left-of-terminal-keeps-terminal-mounted");
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
    await installTerminalMountErrorProbe();

    await waitUntil(async () => {
      const state = await dockState();
      return state.groups.some((group) => group.role === "side_panel" && group.placement === "left" && group.kinds.includes("files")) &&
        state.groups.some((group) => group.role === "content" && group.placement === "top" && group.kinds.includes("terminal"));
    }, async () => `default Files side group and Terminal content group did not mount\n${await pageSummary()}`, 8_000);
    const preview = await dragFilesToTerminalLeftSplitZone();
    assertPreview(preview, "split", "left");

    await waitUntil(async () => {
      const state = await dockState();
      const filesGroup = groupForKind(state, "files");
      const terminalGroup = groupForKind(state, "terminal");
      return Boolean(
        filesGroup &&
          terminalGroup &&
          filesGroup.id !== terminalGroup.id &&
          filesGroup.role === "side_panel" &&
          filesGroup.placement === "left" &&
          terminalGroup.role === "content" &&
          terminalGroup.placement === "top" &&
          filesGroup.rect.right <= terminalGroup.rect.left + 6 &&
          Math.abs(filesGroup.rect.top - terminalGroup.rect.top) <= 2 &&
          Math.abs(filesGroup.rect.bottom - terminalGroup.rect.bottom) <= 2 &&
          filesGroup.rect.bottom < state.workspaceBodyRect.bottom - 24,
      );
    }, async () => `Files did not land as a local left side-panel beside Terminal\n${await pageSummary()}`);
    await ensureTerminalLive("terminal immediately after Files split to its left", { activate: false });
    await delay(2_500);
    await ensureTerminalLive("terminal remained live after Files split to its left", { activate: false });
    await assertNoTerminalMountErrors();
  } finally {
    if (sessionId) {
      await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
    }
    stopProcess(tauriDriver);
    await devServer.close();
    await isolatedAppConfig.cleanup();
  }

  async function dragFilesToTerminalLeftSplitZone() {
    const state = await dockState();
    const source = await draggableToolSlotPoint("files");
    const terminalGroup = groupForKind(state, "terminal");
    if (!source) throw new Error(`Files ToolTab was not visible\n${formatState(state)}`);
    if (!terminalGroup) throw new Error(`Terminal group was not visible\n${formatState(state)}`);
    return await pointerDragWithPreview(source.point, {
      x: Math.round(terminalGroup.rect.left + Math.min(56, Math.max(32, terminalGroup.rect.width * 0.12))),
      y: Math.round(terminalGroup.rect.top + terminalGroup.rect.height / 2),
    });
  }

  async function installTerminalMountErrorProbe() {
    await execute(`
      window.__nocturneTerminalMountErrors = [];
      window.addEventListener('error', (event) => {
        window.__nocturneTerminalMountErrors.push(String(event.error?.message ?? event.message ?? ''));
      });
      window.addEventListener('unhandledrejection', (event) => {
        window.__nocturneTerminalMountErrors.push(String(event.reason?.message ?? event.reason ?? ''));
      });
    `);
  }

  async function assertNoTerminalMountErrors() {
    const errors = await execute(`
      return (window.__nocturneTerminalMountErrors ?? []).filter((message) =>
        /terminal pane .* did not mount/i.test(message) ||
        /did not mount a visible container/i.test(message)
      );
    `);
    if (errors.length > 0) {
      throw new Error(`terminal mount errors were reported\n${JSON.stringify(errors, null, 2)}\n${await pageSummary()}`);
    }
  }

  async function draggableToolSlotPoint(kind) {
    return await execute(`
      const [kind] = arguments;
      const slots = [...document.querySelectorAll('.workspace-body [data-tool-slot-id]')]
        .filter((slot) => slot.getAttribute('data-tool-kind') === kind);
      const visibleSlots = slots.filter((slot) => {
        const rect = slot.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      for (const slot of visibleSlots) {
        const rect = slot.getBoundingClientRect();
        const xFractions = [0.18, 0.32, 0.5, 0.68, 0.82];
        const yFractions = [0.18, 0.32, 0.5, 0.68, 0.82];
        for (const yFraction of yFractions) {
          for (const xFraction of xFractions) {
            const x = Math.round(rect.left + rect.width * xFraction);
            const y = Math.round(rect.top + rect.height * yFraction);
            const element = document.elementFromPoint(x, y);
            if (!element || element.closest('.tool-close')) continue;
            if (element.closest('[data-tool-slot-id]') === slot) return { point: { x, y } };
          }
        }
      }
      return null;
    `, [kind]);
  }

  async function pointerDragWithPreview(start, end) {
    const pointerId = "mouse";
    await webdriver("POST", `/session/${sessionId}/actions`, {
      actions: [
        {
          type: "pointer",
          id: pointerId,
          parameters: { pointerType: "mouse" },
          actions: [
            { type: "pointerMove", duration: 0, origin: "viewport", x: start.x, y: start.y },
            { type: "pointerDown", button: 0 },
            {
              type: "pointerMove",
              duration: 180,
              origin: "viewport",
              x: Math.round((start.x + end.x) / 2),
              y: Math.round((start.y + end.y) / 2),
            },
            { type: "pointerMove", duration: 180, origin: "viewport", x: end.x, y: end.y },
            { type: "pause", duration: 160 },
          ],
        },
      ],
    });
    await delay(200);
    const preview = await dropPreview();
    await webdriver("POST", `/session/${sessionId}/actions`, {
      actions: [
        {
          type: "pointer",
          id: pointerId,
          parameters: { pointerType: "mouse" },
          actions: [{ type: "pointerUp", button: 0 }],
        },
      ],
    });
    await webdriver("DELETE", `/session/${sessionId}/actions`).catch(() => undefined);
    await delay(650);
    return preview;
  }

  async function dropPreview() {
    return await execute(`
      const preview = document.querySelector('[data-tooltab-drop-preview]');
      const previewRect = preview?.getBoundingClientRect();
      const splitTarget = document.querySelector('[data-tool-slot-id].split-target');
      return preview && previewRect ? {
        kind: preview.getAttribute('data-drop-kind') ?? '',
        side: preview.getAttribute('data-drop-side') ?? '',
        targetSlotId: splitTarget?.getAttribute('data-tool-slot-id') ?? '',
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
  }

  async function ensureTerminalLive(label) {
    await waitUntil(async () => {
      const state = await terminalState();
      return state.visibleSurfaceCount === 1 &&
        state.visibleXterms === 1 &&
        state.surfaceRect.width >= 160 &&
        state.surfaceRect.height >= 80 &&
        state.hostRect.width >= 120 &&
        state.hostRect.height >= 40 &&
        state.rowsRect.width >= 80 &&
        state.rowsRect.height >= 16 &&
        state.rowsText.trim().length > 0 &&
        !/terminal pane .* did not mount/i.test(state.bodyText) &&
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
    await delay(350);
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
      const workspaceBody = document.querySelector('.workspace-body');
      const bodyRect = rect(workspaceBody);
      const groups = [...document.querySelectorAll('.workspace-body [data-dock-group-id]')].map((group) => {
        const groupRect = rect(group);
        return {
          id: group.getAttribute('data-dock-group-id') ?? '',
          role: group.getAttribute('data-dock-group-role') ?? '',
          placement: group.getAttribute('data-tool-tabbar-placement') ?? '',
          collapsed: group.getAttribute('data-dock-group-collapsed') === 'true',
          rect: groupRect,
          kinds: [...group.querySelectorAll('[data-tool-kind]')]
            .map((slot) => slot.getAttribute('data-tool-kind') ?? '')
            .filter(Boolean),
        };
      });
      return {
        workspaceBodyRect: bodyRect,
        groups,
        bodyText: document.body?.innerText?.slice(0, 1800) ?? '',
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
      const host = surface?.querySelector('[data-testid="terminal-host"]');
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
        hostRect: rect(host),
        rowsRect: rect(rows),
        rowsText: rows?.textContent ?? '',
        activeTerminalError: surface?.querySelector('.terminal-error')?.textContent ?? '',
        activePlaceholderText: activePane?.querySelector('.placeholder')?.textContent ?? '',
        bodyText: document.body?.innerText ?? '',
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
      return `${formatState({ dock: await dockState(), terminal: await terminalState() })}\n${driverOutput}`;
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
