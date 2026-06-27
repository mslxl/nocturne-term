#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies a representative matrix of Workspace ToolTab drag moves between
 * side, content, and bottom Dock groups while preserving a live Terminal view.
 *
 * Operation:
 * Starts the shared Vite dev server, starts tauri-driver, launches the Tauri
 * application provided by TAURI_TEST_APPLICATION, waits for the default Local
 * Workspace, drags Files from the left side group into the existing Terminal
 * content group, drags Files to the top Workspace edge and back into content,
 * drags Terminal to the left Workspace edge and then back into the content
 * group, verifies a ToolTab can still target the left split edge of a
 * side-panel group that touches the Workspace edge, drags Files from a side
 * group onto the left edge of the Terminal content group to verify target-role
 * split inheritance, drags Transfer Queue from the right group into content and
 * back to the right edge, and drags Ports from the bottom group into content
 * and back to the bottom edge. Each drag inspects the hover drop preview before
 * release.
 *
 * Expected:
 * Group drops show group previews, workspace-edge drops show the requested
 * edge preview, group-edge split previews show the requested side, top-edge
 * docking creates a content group with a top ToolTab bar, group-edge split
 * inherits the target group's role even when the target group touches a
 * Workspace edge, left/right/bottom edge docking creates side-panel groups, the
 * original side/bottom group orientation can be restored, and the Terminal
 * ToolTab can be activated with a mounted, non-blank xterm after each move.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";
import { test } from "vitest";

test("ToolTab drag matrix keeps Terminal live", { timeout: 240_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("tooltab-drag-matrix-keeps-terminal-live");
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
        state.groups.some((group) => group.placement === "top" && group.kinds.includes("terminal")) &&
        state.groups.some((group) => group.placement === "right" && group.kinds.includes("transfers")) &&
        state.groups.some((group) => group.placement === "bottom" && group.kinds.includes("ports"));
    }, async () => `default Dock matrix layout did not mount\n${await pageSummary()}`);
    await ensureTerminalLive("initial terminal");

    const filesToContent = await dragToolKindToGroup("files", groupIdForKind(await dockState(), "terminal"));
    assertPreview(filesToContent, "group");
    await waitForKindInPlacement("files", "top", "Files did not move into the Terminal content group");
    await ensureTerminalLive("after Files moved into content");

    const filesToTopEdge = await dragToolKindToWorkspaceEdge("files", "up");
    assertPreview(filesToTopEdge, "workspace_edge", "up");
    await waitForKindGroupRoleAndPlacement(
      "files",
      "content",
      "top",
      "Files did not move to a top Workspace-edge content group",
    );
    await waitForKindAtWorkspaceEdge("files", "top", "Files top-edge content group did not touch the Workspace top edge");
    await ensureTerminalLive("after Files moved to top edge");

    const filesBackToContent = await dragToolKindToGroup("files", groupIdForKind(await dockState(), "terminal"));
    assertPreview(filesBackToContent, "group");
    await waitForKindsInSameGroup(["terminal", "files"], "Files did not return to the content group containing Terminal");
    await ensureTerminalLive("after Files returned from top edge");

    const terminalToLeft = await dragToolKindToWorkspaceEdge("terminal", "left");
    assertPreview(terminalToLeft, "workspace_edge", "left");
    await waitForKindGroupRoleAndPlacement("terminal", "side_panel", "left", "Terminal did not move to a left side-panel group");
    await waitForKindAtWorkspaceEdge("terminal", "left", "Terminal left-edge group did not touch the Workspace left edge");
    await ensureTerminalLive("after Terminal moved to left edge");

    const terminalToContent = await dragToolKindToGroup("terminal", groupIdForKind(await dockState(), "files"));
    assertPreview(terminalToContent, "group");
    await waitForKindsInSameGroup(["terminal", "files"], "Terminal did not return to the content group containing Files");
    await ensureTerminalLive("after Terminal returned to content");

    const filesToSideAgain = await dragToolKindToWorkspaceEdge("files", "left");
    assertPreview(filesToSideAgain, "workspace_edge", "left");
    await waitForKindGroupRoleAndPlacement("files", "side_panel", "left", "Files did not move back to a left side-panel group");
    await waitForKindAtWorkspaceEdge("files", "left", "Files left-edge group did not touch the Workspace left edge");
    await ensureTerminalLive("after Files moved back to left edge");

    const terminalToFilesLeftSplit = await dragToolKindToGroupEdge(
      "terminal",
      groupIdForKind(await dockState(), "files"),
      "left",
      { distanceFromEdge: 30 },
    );
    assertPreview(terminalToFilesLeftSplit, "split", "left");
    await waitForKindGroupRoleAndPlacement(
      "terminal",
      "side_panel",
      "left",
      "Terminal split into a left side-panel edge did not inherit the Files side-panel role",
    );
    await waitForKindLeftOfKind("terminal", "files", "Terminal side-panel split did not land to the left of Files");
    await ensureTerminalDockedWithoutError("after Terminal split into Files side edge");

    const terminalBackToContentFromSideSplit = await dragToolKindToGroup("terminal", contentGroupId(await dockState()));
    assertPreview(terminalBackToContentFromSideSplit, "group");
    await waitForKindGroupRoleAndPlacement("terminal", "content", "top", "Terminal did not return to an explicit content group");
    await ensureTerminalLive("after Terminal returned from Files side split");

    const filesToTerminalLeftSplit = await dragToolKindToGroupEdge("files", groupIdForKind(await dockState(), "terminal"), "left");
    assertPreview(filesToTerminalLeftSplit, "split", "left");
    await waitForKindGroupRoleAndPlacement(
      "files",
      "side_panel",
      "left",
      "Files group-edge split did not restore a local left side-panel next to Terminal content",
    );
    await waitForKindLeftOfKind("files", "terminal", "Files group-edge split did not land to the left of Terminal");
    await ensureTerminalLive("after Files split into Terminal content edge");

    const filesAfterSplitBackToContent = await dragToolKindToGroup("files", groupIdForKind(await dockState(), "terminal"));
    assertPreview(filesAfterSplitBackToContent, "group");
    await waitForKindsInSameGroup(["terminal", "files"], "Files did not rejoin Terminal content after split");
    await ensureTerminalLive("after Files rejoined content after split");

    const transfersToContent = await dragToolKindToGroup("transfers", groupIdForKind(await dockState(), "terminal"));
    assertPreview(transfersToContent, "group");
    await waitForKindsInSameGroup(["terminal", "transfers"], "Transfers did not move into content");
    await ensureTerminalLive("after Transfers moved into content");

    const transfersToRight = await dragToolKindToWorkspaceEdge("transfers", "right");
    assertPreview(transfersToRight, "workspace_edge", "right");
    await waitForKindGroupRoleAndPlacement("transfers", "side_panel", "right", "Transfers did not move back to a right side-panel group");
    await waitForKindAtWorkspaceEdge("transfers", "right", "Transfers right-edge group did not touch the Workspace right edge");
    await ensureTerminalLive("after Transfers moved back to right edge");

    const portsToContent = await dragToolKindToGroup("ports", groupIdForKind(await dockState(), "terminal"));
    assertPreview(portsToContent, "group");
    await waitForKindsInSameGroup(["terminal", "ports"], "Ports did not move into content");
    await ensureTerminalLive("after Ports moved into content");

    const portsToBottom = await dragToolKindToWorkspaceEdge("ports", "down");
    assertPreview(portsToBottom, "workspace_edge", "down");
    await waitForKindGroupRoleAndPlacement("ports", "side_panel", "bottom", "Ports did not move back to a bottom side-panel group");
    await waitForKindAtWorkspaceEdge("ports", "bottom", "Ports bottom-edge group did not touch the Workspace bottom edge");
    await ensureTerminalLive("after Ports moved back to bottom edge");

    console.log("tauri ToolTab drag matrix terminal-live unit test passed");
  } finally {
    if (sessionId) {
      await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
    }
    stopProcess(tauriDriver);
    await devServer.close();
    await isolatedAppConfig.cleanup();
  }

  async function waitForKindInPlacement(kind, placement, message) {
    await waitUntil(async () => {
      const state = await dockState();
      const group = groupForKind(state, kind);
      return Boolean(group && group.placement === placement);
    }, async () => `${message}\n${await pageSummary()}`);
  }

  async function waitForKindGroupRoleAndPlacement(kind, role, placement, message) {
    await waitUntil(async () => {
      const state = await dockState();
      const group = groupForKind(state, kind);
      return Boolean(group && group.role === role && group.placement === placement);
    }, async () => `${message}\n${await pageSummary()}`);
  }

  async function waitForKindAtWorkspaceEdge(kind, edge, message) {
    await waitUntil(async () => {
      const state = await dockState();
      const group = groupForKind(state, kind);
      return Boolean(group && group.edge[edge] <= 2);
    }, async () => `${message}\n${await pageSummary()}`);
  }

  async function waitForKindLeftOfKind(leftKind, rightKind, message) {
    await waitUntil(async () => {
      const state = await dockState();
      const left = groupForKind(state, leftKind);
      const right = groupForKind(state, rightKind);
      return Boolean(left && right && left.id !== right.id && left.rect.right <= right.rect.left + 6);
    }, async () => `${message}\n${await pageSummary()}`);
  }

  async function waitForKindsInSameGroup(kinds, message) {
    await waitUntil(async () => {
      const state = await dockState();
      return state.groups.some((group) => kinds.every((kind) => group.kinds.includes(kind)));
    }, async () => `${message}\n${await pageSummary()}`);
  }

  async function dragToolKindToGroup(kind, targetGroupId) {
    const state = await dockState();
    const source = toolSlot(state, kind);
    const target = state.groups.find((group) => group.id === targetGroupId);
    if (!source) throw new Error(`ToolTab ${kind} was not visible\n${formatState(state)}`);
    if (!target) throw new Error(`target Dock group ${targetGroupId} was not visible\n${formatState(state)}`);
    const targetPoint = groupCenterDropPoint(target);
    return await pointerDrag(center(source.rect), targetPoint);
  }

  async function dragToolKindToWorkspaceEdge(kind, side) {
    const state = await dockState();
    const source = toolSlot(state, kind);
    if (!source) throw new Error(`ToolTab ${kind} was not visible\n${formatState(state)}`);
    const body = state.workspaceBodyRect;
    const anchorGroup = groupForKind(state, kind) ?? contentGroup(state) ?? state.groups[0];
    if (!anchorGroup) throw new Error(`No anchor group visible for ${kind} edge docking\n${formatState(state)}`);
    const target = {
      left: { x: Math.round(body.left + 4), y: Math.round(anchorGroup.rect.top + anchorGroup.rect.height / 2) },
      right: { x: Math.round(body.right - 4), y: Math.round(anchorGroup.rect.top + anchorGroup.rect.height / 2) },
      up: { x: Math.round(anchorGroup.rect.left + anchorGroup.rect.width / 2), y: Math.round(body.top + 4) },
      down: { x: Math.round(anchorGroup.rect.left + anchorGroup.rect.width / 2), y: Math.round(body.bottom - 4) },
    }[side];
    return await pointerDrag(center(source.rect), target);
  }

  async function dragToolKindToGroupEdge(kind, targetGroupId, side, options = {}) {
    const state = await dockState();
    const source = toolSlot(state, kind);
    const target = state.groups.find((group) => group.id === targetGroupId);
    if (!source) throw new Error(`ToolTab ${kind} was not visible\n${formatState(state)}`);
    if (!target) throw new Error(`target Dock group ${targetGroupId} was not visible\n${formatState(state)}`);
    const body = state.workspaceBodyRect;
    const edgeInset = Math.min(54, Math.max(30, Math.min(target.rect.width, target.rect.height) * 0.18));
    const distanceFromEdge = Number.isFinite(options.distanceFromEdge) ? options.distanceFromEdge : edgeInset * 0.5;
    const point = {
      left: {
        x: Math.round(Math.min(target.rect.right - 6, Math.max(target.rect.left + distanceFromEdge, body.left + 6))),
        y: Math.round(target.rect.top + target.rect.height / 2),
      },
      right: {
        x: Math.round(Math.max(target.rect.left + 6, Math.min(target.rect.right - distanceFromEdge, body.right - 6))),
        y: Math.round(target.rect.top + target.rect.height / 2),
      },
      up: {
        x: Math.round(target.rect.left + target.rect.width / 2),
        y: Math.round(Math.min(target.rect.bottom - 6, Math.max(target.rect.top + distanceFromEdge, body.top + 6))),
      },
      down: {
        x: Math.round(target.rect.left + target.rect.width / 2),
        y: Math.round(Math.max(target.rect.top + 6, Math.min(target.rect.bottom - distanceFromEdge, body.bottom - 6))),
      },
    }[side];
    return await pointerDrag(center(source.rect), point);
  }

  async function ensureTerminalLive(label) {
    const dock = await dockState();
    const terminalGroup = groupForKind(dock, "terminal");
    const terminalSlot = dock.toolSlots.find((slot) => slot.kind === "terminal");
    if (!terminalSlot?.active || terminalGroup?.collapsed) {
      await clickToolKind("terminal");
    }
    await waitUntil(async () => {
      const state = await terminalState();
      return state.visibleSurfaceCount === 1 &&
        state.visibleHosts === 1 &&
        state.visibleXterms === 1 &&
        state.surfaceRect.width >= 180 &&
        state.surfaceRect.height >= 90 &&
        state.hostRect.width >= 180 &&
        state.hostRect.height >= 90 &&
        state.rowsRect.width >= 120 &&
        state.rowsRect.height >= 16 &&
        state.rowsText.trim().length > 0 &&
        !state.activeTerminalError &&
        !state.activePlaceholderText;
    }, async () => `${label} is not live\n${await pageSummary()}`);
  }

  async function ensureTerminalDockedWithoutError(label) {
    const dock = await dockState();
    const terminalSlot = dock.toolSlots.find((slot) => slot.kind === "terminal");
    if (!terminalSlot?.active) {
      await clickToolKind("terminal");
    }
    await waitUntil(async () => {
      const state = await terminalState();
      return state.visibleSurfaceCount === 1 &&
        state.visibleHosts === 1 &&
        state.visibleXterms === 1 &&
        state.surfaceRect.width >= 48 &&
        state.surfaceRect.height >= 90 &&
        !state.activeTerminalError;
    }, async () => `${label} is not docked without error\n${await pageSummary()}`);
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

  async function pointerDrag(start, end) {
    await execute(`
      const [start, end] = arguments;
      const source = document.elementFromPoint(start.x, start.y)?.closest('[data-tool-slot-id]');
      if (!source) throw new Error('No ToolTab element at drag start point');
      window.__nocturneToolTabDragMatrixTest = {
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
          pointerId: 149,
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
    await delay(120);
    const preview = await execute(`
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
    await execute(`
      const state = window.__nocturneToolTabDragMatrixTest;
      if (!state?.source) throw new Error('No active ToolTab drag test state');
      const dispatch = (target, type, point, buttons) => {
        target.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 149,
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
        delete window.__nocturneToolTabDragMatrixTest;
      }
    `);
    await delay(450);
    return preview;
  }

  function groupCenterDropPoint(group) {
    const x = Math.round(group.rect.left + group.rect.width / 2);
    const y = Math.round(group.rect.top + group.rect.height / 2);
    return {
      x: Math.min(Math.max(x, group.rect.left + 84), group.rect.right - 84),
      y: Math.min(Math.max(y, group.rect.top + 84), group.rect.bottom - 84),
    };
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

  function groupIdForKind(state, kind) {
    const group = groupForKind(state, kind);
    if (!group) throw new Error(`Dock group containing ${kind} not found\n${formatState(state)}`);
    return group.id;
  }

  function groupForKind(state, kind) {
    return state.groups.find((group) => group.kinds.includes(kind)) ?? null;
  }

  function contentGroup(state) {
    return state.groups.find((group) => group.role === "content") ?? null;
  }

  function contentGroupId(state) {
    const group = contentGroup(state);
    if (!group) throw new Error(`content Dock group not found\n${formatState(state)}`);
    return group.id;
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
          workspaceBodyRect: rect(null),
          groups: [],
          toolSlots: [],
          bodyText: document.body?.innerText?.slice(0, 1400) ?? '',
        };
      }
      const bodyRect = rect(workspaceBody);
      const groups = [...workspaceBody.querySelectorAll('[data-dock-group-id]')].map((group) => {
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
      const toolSlots = [...workspaceBody.querySelectorAll('[data-tool-slot-id]')].map((slot) => ({
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
        bodyText: document.body?.innerText?.slice(0, 1400) ?? '',
      };
    `);
  }

  async function terminalState() {
    return await execute(`
      const allSurfaces = [...document.querySelectorAll('[data-testid="terminal-surface"]')];
      const visibleSurfaces = allSurfaces.filter((item) => {
        const rect = item.getBoundingClientRect();
        const slot = item.closest('.tool-slot-surface');
        return rect.width >= 1 && rect.height >= 1 && !slot?.hidden && slot?.getAttribute('aria-hidden') !== 'true';
      });
      const surface = visibleSurfaces[0];
      const activeSlot = surface?.closest('.tool-slot-surface');
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
        visibleHosts: surface?.querySelectorAll('[data-testid="terminal-host"]').length ?? 0,
        visibleXterms: surface?.querySelectorAll('.xterm').length ?? 0,
        surfaceRect: rect(surface),
        hostRect: rect(host),
        rowsRect: rect(rows),
        rowsText: rows?.textContent ?? '',
        activeTerminalError: surface?.querySelector('.terminal-error')?.textContent ?? '',
        activePlaceholderText: activeSlot?.querySelector('.placeholder')?.textContent ?? '',
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
      const terminal = await terminalState();
      return `${formatState({ dock: state, terminal })}\n${driverOutput}`;
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

async function waitUntil(predicate, message, timeoutMs = 35_000) {
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
