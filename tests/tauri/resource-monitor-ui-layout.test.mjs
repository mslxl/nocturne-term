#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies the Resource Monitor ToolTab layout inside the real Tauri WebView.
 *
 * Operation:
 * Starts the Vite dev server, starts tauri-driver, launches the Tauri
 * application provided by `TAURI_TEST_APPLICATION`, waits for the default
 * Resource Monitor ToolTab, measures its mounted DOM in the active Workspace,
 * clicks collapsible metric rows to expand/collapse details, verifies
 * non-collapsible metrics do not show expand icons, and uses WebDriver pointer
 * actions to drag one metric panel before another.
 *
 * Expected:
 * The Resource Monitor ToolTab is visible in the real WebView, collects a real
 * local provider sample instead of staying in the empty waiting state, exposes
 * the provider/status row, metric rows, collapsed detail toggles, default history charts,
 * and OverlayScrollbars scroll host, does not render useless stable labels,
 * chart max labels, or
 * display-mode controls, and keeps its narrow dock layout inside the ToolTab
 * without compressing labels into vertical one-letter columns or wasting the
 * narrow right sidebar width on large left insets. Memory and Swap do not render
 * expand icons, CPU and GPU expand/collapse when their rows are clicked, and
 * real pointer dragging one metric row over another shows a drop target preview
 * and changes the visible metric order without also toggling details.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
const isolatedAppConfig = await createIsolatedAppConfigEnv("resource-monitor-ui-layout");
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
    const state = await resourceMonitorLayoutState();
    return state.visible &&
      state.providerRows === 1 &&
      state.statusRows === 0 &&
      state.providerLabel === "local provider" &&
      state.statusLabel === "" &&
      state.usesOverlayScrollbars &&
      state.metricRows >= 4 &&
      state.historyRows >= 1 &&
      state.historyMaxLabels === 0 &&
      state.childHistoryRows === 0 &&
      state.detailToggleMetrics.includes("cpu") &&
      state.detailToggleMetrics.includes("gpu") &&
      !state.detailToggleMetrics.includes("memory") &&
      !state.detailToggleMetrics.includes("swap") &&
      state.displayModeGroups === 0 &&
      !state.horizontalOverflow &&
      state.compactInsets.historyLeft <= 24 &&
      state.compactInsets.historyRight <= 6 &&
      state.compactInsets.textLeft <= 44 &&
      state.rowOverflows.length === 0 &&
      state.verticalizedLabels.length === 0;
  }, async () => `Resource Monitor layout did not mount cleanly\n${JSON.stringify(await resourceMonitorLayoutState(), null, 2)}\n${driverOutput}`);

  const cpuToggle = await clickMetricRowTwice("cpu");
  if (!cpuToggle.expandedOnce || !cpuToggle.collapsedAgain) {
    throw new Error(`CPU row click did not expand and collapse details\n${JSON.stringify(cpuToggle, null, 2)}\n${driverOutput}`);
  }

  const gpuToggle = await clickMetricRowTwice("gpu");
  if (!gpuToggle.expandedOnce || !gpuToggle.collapsedAgain) {
    throw new Error(`GPU row click did not expand and collapse details\n${JSON.stringify(gpuToggle, null, 2)}\n${driverOutput}`);
  }

  const reorderResult = await pointerDragMetricBefore("gpu", "cpu");
  if (!reorderResult.preview.sourceHasDragClass || !reorderResult.preview.targetHasPreview) {
    throw new Error(`Resource Monitor drag sorting did not show a live drop preview\n${JSON.stringify(reorderResult, null, 2)}\n${driverOutput}`);
  }
  if (JSON.stringify(reorderResult.after.slice(0, 2)) !== JSON.stringify(["gpu", "cpu"])) {
    throw new Error(`Resource Monitor drag sorting did not reorder rows\n${JSON.stringify(reorderResult, null, 2)}\n${driverOutput}`);
  }
  if (reorderResult.expandedAfterDrag.length > 0) {
    throw new Error(`Resource Monitor drag sorting also toggled metric details\n${JSON.stringify(reorderResult, null, 2)}\n${driverOutput}`);
  }

  console.log("tauri Resource Monitor UI layout unit test passed");
} finally {
  if (sessionId) {
    await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
  }
  stopProcess(tauriDriver);
  await devServer.close();
  await isolatedAppConfig.cleanup();
}

async function pointerDragMetricBefore(draggedMetric, targetMetric) {
  const geometry = await execute(`
    const before = [...document.querySelectorAll('[data-testid="resource-monitor-row"]')]
      .map((row) => row.getAttribute('data-metric'));
    const dragged = document.querySelector('[data-testid="resource-monitor-row"][data-metric="' + ${JSON.stringify(draggedMetric)} + '"]');
    const target = document.querySelector('[data-testid="resource-monitor-row"][data-metric="' + ${JSON.stringify(targetMetric)} + '"]');
    if (!dragged || !target) {
      return { found: false, before };
    }
    const draggedRect = dragged.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    return {
      found: true,
      before,
      start: {
        x: Math.round(draggedRect.left + Math.min(64, Math.max(32, draggedRect.width / 2))),
        y: Math.round(draggedRect.top + draggedRect.height / 2),
      },
      mid: {
        x: Math.round((draggedRect.left + targetRect.left) / 2 + 20),
        y: Math.round((draggedRect.top + targetRect.top) / 2),
      },
      end: {
        x: Math.round(targetRect.left + Math.min(64, Math.max(32, targetRect.width / 2))),
        y: Math.round(targetRect.top + targetRect.height / 2),
      },
    };
  `);
  if (!geometry.found) {
    throw new Error(`Resource Monitor drag test rows not found\n${JSON.stringify({ draggedMetric, targetMetric, geometry }, null, 2)}`);
  }

  await webdriver("POST", `/session/${sessionId}/actions`, {
    actions: [
      {
        type: "pointer",
        id: "resource-monitor-mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, origin: "viewport", x: geometry.start.x, y: geometry.start.y },
          { type: "pointerDown", button: 0 },
          { type: "pause", duration: 80 },
          { type: "pointerMove", duration: 180, origin: "viewport", x: geometry.mid.x, y: geometry.mid.y },
          { type: "pointerMove", duration: 180, origin: "viewport", x: geometry.end.x, y: geometry.end.y },
          { type: "pause", duration: 80 },
        ],
      },
    ],
  });
  const preview = await execute(`
    const target = document.querySelector('[data-testid="resource-monitor-row"][data-metric="' + ${JSON.stringify(targetMetric)} + '"]');
    return {
      targetHasPreview: target?.classList.contains('pointer-drop-target') ?? false,
      sourceHasDragClass: document.querySelector('[data-testid="resource-monitor-row"][data-metric="' + ${JSON.stringify(draggedMetric)} + '"]')?.classList.contains('pointer-drag-source') ?? false,
      classes: [...document.querySelectorAll('[data-testid="resource-monitor-row"]')].map((row) => ({
        metric: row.getAttribute('data-metric'),
        className: row.className,
      })),
    };
  `);
  await webdriver("POST", `/session/${sessionId}/actions`, {
    actions: [
      {
        type: "pointer",
        id: "resource-monitor-mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerUp", button: 0 },
        ],
      },
    ],
  });
  await webdriver("DELETE", `/session/${sessionId}/actions`).catch(() => undefined);
  await delay(250);
  const after = await execute(`
    return [...document.querySelectorAll('[data-testid="resource-monitor-row"]')]
      .map((row) => row.getAttribute('data-metric'));
  `);
  const expandedAfterDrag = await expandedMetricRows();
  return {
    before: geometry.before,
    preview,
    after,
    expandedAfterDrag,
  };
}

async function clickMetricRowTwice(metric) {
  const before = await metricDetailState(metric);
  await clickMetricRow(metric);
  await delay(250);
  const afterFirstClick = await metricDetailState(metric);
  await clickMetricRow(metric);
  await delay(250);
  const afterSecondClick = await metricDetailState(metric);
  return {
    before,
    afterFirstClick,
    afterSecondClick,
    expandedOnce: before.childRows === 0 && afterFirstClick.childRows > 0,
    collapsedAgain: afterFirstClick.childRows > 0 && afterSecondClick.childRows === 0,
  };
}

async function clickMetricRow(metric) {
  const target = await execute(`
    const row = document.querySelector('[data-testid="resource-monitor-row"][data-metric="' + ${JSON.stringify(metric)} + '"]');
    if (!row) {
      return { found: false };
    }
    const rect = row.getBoundingClientRect();
    return {
      found: true,
      x: Math.round(rect.left + Math.min(96, Math.max(48, rect.width / 2))),
      y: Math.round(rect.top + 14),
    };
  `);
  if (!target.found) {
    throw new Error(`Resource Monitor metric row not found: ${metric}`);
  }
  await webdriver("POST", `/session/${sessionId}/actions`, {
    actions: [
      {
        type: "pointer",
        id: "resource-monitor-click-mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, origin: "viewport", x: target.x, y: target.y },
          { type: "pointerDown", button: 0 },
          { type: "pointerUp", button: 0 },
        ],
      },
    ],
  });
  await webdriver("DELETE", `/session/${sessionId}/actions`).catch(() => undefined);
}

async function metricDetailState(metric) {
  return await execute(`
    const row = document.querySelector('[data-testid="resource-monitor-row"][data-metric="' + ${JSON.stringify(metric)} + '"]');
    return {
      found: Boolean(row),
      hasToggle: Boolean(row?.querySelector('[data-testid="resource-monitor-detail-toggle"]')),
      expanded: row?.querySelector('[data-testid="resource-monitor-detail-toggle"]')?.getAttribute('aria-expanded') ?? '',
      childRows: row?.querySelectorAll('.resource-monitor-child-row').length ?? 0,
    };
  `);
}

async function expandedMetricRows() {
  return await execute(`
    return [...document.querySelectorAll('[data-testid="resource-monitor-row"]')]
      .filter((row) => row.querySelector('[data-testid="resource-monitor-detail-toggle"]')?.getAttribute('aria-expanded') === 'true')
      .map((row) => row.getAttribute('data-metric'));
  `);
}

async function resourceMonitorLayoutState() {
  return await execute(`
    return (() => {
    const root = document.querySelector('[data-testid="resource-monitor-tooltab"]');
    const body = root?.querySelector('.resource-monitor-body');
    const rect = root?.getBoundingClientRect();
    const bodyRect = body?.getBoundingClientRect();
    const rowOverflows = [...(root?.querySelectorAll('[data-testid="resource-monitor-row"]') ?? [])]
      .map((row) => {
        const rowRect = row.getBoundingClientRect();
        return {
          metric: row.getAttribute('data-metric'),
          rowWidth: Math.round(rowRect.width),
          scrollWidth: row.scrollWidth,
          clientWidth: row.clientWidth,
        };
      })
      .filter((row) => row.scrollWidth > row.clientWidth + 1);
    const verticalizedLabels = [...(root?.querySelectorAll('.resource-monitor-label, .resource-monitor-primary') ?? [])]
      .map((label) => {
        const labelRect = label.getBoundingClientRect();
        return {
          text: label.textContent?.trim() ?? '',
          width: Math.round(labelRect.width),
          height: Math.round(labelRect.height),
        };
      })
      .filter((label) => label.text.length > 3 && label.width < 24 && label.height > 40);
    const rootRectValue = root?.getBoundingClientRect();
    const firstHistoryRect = root?.querySelector('[data-testid="resource-monitor-history"] svg')?.getBoundingClientRect();
    const firstTextRect = root?.querySelector('.resource-monitor-metric-text')?.getBoundingClientRect();
    const compactInsets = rootRectValue ? {
      historyLeft: firstHistoryRect ? Math.round(firstHistoryRect.left - rootRectValue.left) : 0,
      historyRight: firstHistoryRect ? Math.round(rootRectValue.right - firstHistoryRect.right) : 0,
      textLeft: firstTextRect ? Math.round(firstTextRect.left - rootRectValue.left) : 0,
    } : {
      historyLeft: 999,
      historyRight: 999,
      textLeft: 999,
    };
    return {
      visible: Boolean(root && rect && rect.width > 0 && rect.height > 0),
      rootRect: rect ? {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      } : null,
      bodyRect: bodyRect ? {
        width: Math.round(bodyRect.width),
        height: Math.round(bodyRect.height),
      } : null,
      providerRows: root?.querySelectorAll('[data-testid="resource-monitor-provider-row"]').length ?? 0,
      statusRows: root?.querySelectorAll('[data-testid="resource-monitor-status"]').length ?? 0,
      providerLabel: root?.querySelector('[data-testid="resource-monitor-provider-label"]')?.textContent?.trim() ?? '',
      statusLabel: root?.querySelector('[data-testid="resource-monitor-status"]')?.textContent?.trim() ?? '',
      usesOverlayScrollbars: Boolean(root?.querySelector('.resource-monitor-body.os-host, .resource-monitor-body[data-overlayscrollbars]')),
      metricRows: root?.querySelectorAll('[data-testid="resource-monitor-row"]').length ?? 0,
      historyRows: root?.querySelectorAll('[data-testid="resource-monitor-history"]').length ?? 0,
      historyMaxLabels: root?.querySelectorAll('[data-testid="resource-monitor-history-max"]').length ?? 0,
      childHistoryRows: root?.querySelectorAll('[data-testid="resource-monitor-child-history"]').length ?? 0,
      historyText: root?.querySelector('[data-testid="resource-monitor-history"]')?.textContent?.trim() ?? '',
      detailToggles: root?.querySelectorAll('[data-testid="resource-monitor-detail-toggle"]').length ?? 0,
      detailToggleMetrics: [...(root?.querySelectorAll('[data-testid="resource-monitor-detail-toggle"]') ?? [])]
        .map((toggle) => toggle.closest('[data-testid="resource-monitor-row"]')?.getAttribute('data-metric') ?? '')
        .filter(Boolean),
      displayModeGroups: root?.querySelectorAll('[data-testid="resource-monitor-display-mode"]').length ?? 0,
      horizontalOverflow: body ? body.scrollWidth > body.clientWidth + 1 : true,
      rowOverflows,
      verticalizedLabels,
      compactInsets,
      scrollWidth: body?.scrollWidth ?? 0,
      clientWidth: body?.clientWidth ?? 0,
    };
    })();
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

function stopProcess(child) {
  if (!child.killed) {
    child.kill();
  }
}
