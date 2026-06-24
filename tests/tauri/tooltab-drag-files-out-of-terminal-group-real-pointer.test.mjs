#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies that a ToolTab moved into the Terminal content Dock group remains
 * draggable with real WebDriver pointer actions and can be split to the left
 * of the Terminal group without turning into a global left Workspace sidebar.
 *
 * Operation:
 * Starts the Vite dev server, starts tauri-driver, launches the Tauri
 * application provided by TAURI_TEST_APPLICATION, waits for the default Local
 * Workspace, drags Files from the left side Dock group into the Terminal
 * content group, reactivates Terminal in that shared group, then drags the
 * inactive Files tab from that top content tab bar onto the Terminal Dock
 * group's left split zone using WebDriver pointer actions instead of manually
 * dispatched DOM PointerEvents.
 *
 * Expected:
 * Both drags show visible drop previews before release. The second drag is a
 * group-edge split preview on the Terminal group, not a Workspace-edge preview.
 * Files first joins the Terminal content Dock group, then becomes a separate
 * local side-panel Dock group immediately to the left of Terminal in the same
 * upper split. It must not become a full-height global Workspace-left dock,
 * because this operation is "split Terminal left", not "dock to Workspace
 * left edge". Terminal remains in a content Dock group and the page never
 * shows a stale Dock group error.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";
import { test } from "vitest";

test("Files can be dragged out of the Terminal Dock group with real pointer actions", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("tooltab-drag-files-out-of-terminal-group-real-pointer");
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
        state.groups.some((group) => group.role === "content" && group.kinds.includes("terminal"));
    }, async () => `default Files side group and Terminal content group did not mount\n${await pageSummary()}`);

    const filesIntoTerminalPreview = await dragToolKindToGroupCenter("files", groupIdForKind(await dockState(), "terminal"));
    assertPreview(filesIntoTerminalPreview, "group");
    await waitUntil(async () => {
      const state = await dockState();
      const terminalGroup = groupForKind(state, "terminal");
      return Boolean(terminalGroup?.role === "content" && terminalGroup.kinds.includes("files"));
    }, async () => `Files did not move into the Terminal content group\n${await pageSummary()}`);
    await assertNoDockGroupMissingError();

    await clickToolKind("terminal");
    await waitUntil(async () => {
      const state = await dockState();
      const terminal = state.toolSlots.find((slot) => slot.kind === "terminal");
      const files = state.toolSlots.find((slot) => slot.kind === "files");
      return Boolean(terminal?.active && files && !files.active && terminal.groupId === files.groupId);
    }, async () => `Terminal did not become the active ToolTab before dragging Files back out\n${await pageSummary()}`);

    const filesToTerminalLeftPreview = await dragToolKindToTerminalLeftSplitZone("files");
    assertPreview(filesToTerminalLeftPreview, "split", "left");
    await waitUntil(async () => {
      const state = await dockState();
      const filesGroup = groupForKind(state, "files");
      const terminalGroup = groupForKind(state, "terminal");
      return Boolean(
        filesGroup &&
          terminalGroup &&
          filesGroup.id !== terminalGroup.id &&
          filesGroup.role === "side_panel" &&
          terminalGroup.role === "content" &&
          filesGroup.placement === "left" &&
          terminalGroup.placement === "top" &&
          filesGroup.rect.right <= terminalGroup.rect.left + 6 &&
          Math.abs(filesGroup.rect.top - terminalGroup.rect.top) <= 2 &&
          Math.abs(filesGroup.rect.bottom - terminalGroup.rect.bottom) <= 2 &&
          filesGroup.rect.bottom < state.workspaceBodyRect.bottom - 24 &&
          !terminalGroup.kinds.includes("files"),
      );
    }, async () => `Files did not split immediately to the left of Terminal as a local side-panel\n${await pageSummary()}`);
    await assertNoDockGroupMissingError();
  } finally {
    if (sessionId) {
      await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
    }
    stopProcess(tauriDriver);
    await devServer.close();
    await isolatedAppConfig.cleanup();
  }

  async function dragToolKindToGroupCenter(kind, targetGroupId) {
    const state = await dockState();
    const source = await draggableToolSlotPoint(kind);
    const target = state.groups.find((group) => group.id === targetGroupId);
    if (!source) throw new Error(`ToolTab ${kind} was not visible\n${formatState(state)}`);
    if (!target) throw new Error(`target Dock group ${targetGroupId} was not visible\n${formatState(state)}`);
    return await pointerDragWithPreview(source.point, groupCenterDropPoint(target));
  }

  async function dragToolKindToTerminalLeftSplitZone(kind) {
    const state = await dockState();
    const source = await draggableToolSlotPoint(kind);
    const terminalGroup = groupForKind(state, "terminal");
    if (!source) throw new Error(`ToolTab ${kind} was not visible after moving into content\n${formatState(state)}`);
    if (!terminalGroup) throw new Error(`Terminal group was not visible\n${formatState(state)}`);
    return await pointerDragWithPreview(source.point, {
      x: Math.round(terminalGroup.rect.left + Math.min(56, Math.max(32, terminalGroup.rect.width * 0.12))),
      y: Math.round(terminalGroup.rect.top + terminalGroup.rect.height / 2),
    });
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
            if (element.closest('[data-tool-slot-id]') === slot) {
              return {
                point: { x, y },
                rect: {
                  left: Math.round(rect.left),
                  top: Math.round(rect.top),
                  right: Math.round(rect.right),
                  bottom: Math.round(rect.bottom),
                  width: Math.round(rect.width),
                  height: Math.round(rect.height),
                },
                hitTag: element.tagName,
                hitClass: element.className?.toString?.() ?? '',
              };
            }
          }
        }
      }
      return null;
    `, [kind]);
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
      const targetGroup = document.querySelector('[data-dock-group-id].drop-target');
      const splitTarget = document.querySelector('[data-tool-slot-id].split-target');
      return preview && previewRect ? {
        kind: preview.getAttribute('data-drop-kind') ?? '',
        side: preview.getAttribute('data-drop-side') ?? '',
        targetGroupId: targetGroup?.getAttribute('data-dock-group-id') ?? '',
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

  async function assertNoDockGroupMissingError() {
    const bodyText = await execute("return document.body?.innerText ?? '';");
    if (/dock group group-files-[^\\s]* not found/i.test(bodyText) || /Missing:\\s*dock group/i.test(bodyText)) {
      throw new Error(`stale Dock group error is visible\n${bodyText}`);
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

  function groupCenterDropPoint(group) {
    return {
      x: Math.round(group.rect.left + group.rect.width / 2),
      y: Math.round(group.rect.top + Math.max(96, group.rect.height / 2)),
    };
  }

  function groupForKind(state, kind) {
    return state.groups.find((group) => group.kinds.includes(kind)) ?? null;
  }

  function groupIdForKind(state, kind) {
    const group = groupForKind(state, kind);
    if (!group) throw new Error(`Dock group containing ${kind} not found\n${formatState(state)}`);
    return group.id;
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
      const groups = [...document.querySelectorAll('.workspace-body [data-dock-group-id]')].map((group) => {
        const groupRect = rect(group);
        return {
          id: group.getAttribute('data-dock-group-id') ?? '',
          role: group.getAttribute('data-dock-group-role') ?? '',
          placement: group.getAttribute('data-tool-tabbar-placement') ?? '',
          collapsed: group.getAttribute('data-dock-group-collapsed') === 'true',
          rect: groupRect,
          edge: {
            left: Math.abs(groupRect.left - bodyRect.left),
            right: Math.abs(groupRect.right - bodyRect.right),
            top: Math.abs(groupRect.top - bodyRect.top),
            bottom: Math.abs(groupRect.bottom - bodyRect.bottom),
          },
          kinds: [...group.querySelectorAll('[data-tool-kind]')]
            .map((slot) => slot.getAttribute('data-tool-kind') ?? '')
            .filter(Boolean),
          slotIds: [...group.querySelectorAll('[data-tool-slot-id]')]
            .map((slot) => slot.getAttribute('data-tool-slot-id') ?? '')
            .filter(Boolean),
        };
      });
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
        bodyText: document.body?.innerText?.slice(0, 1800) ?? '',
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
      return `${formatState(await dockState())}\n${driverOutput}`;
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
