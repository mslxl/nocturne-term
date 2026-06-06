#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Files ToolTab selection-scoped actions move out of the toolbar and into the
 * row context menu while Ctrl/Shift multi-selection works in a real Tauri
 * WebView.
 *
 * Operation:
 * Creates a temporary local fixture with several files, configures an isolated
 * Local Workspace, launches the Tauri application provided by
 * TAURI_TEST_APPLICATION through tauri-driver, verifies the Files toolbar does
 * not render Rename, Permissions, Delete, Copy, Cut, or Download actions,
 * activates the Files ToolTab explicitly, drags a marquee rectangle across
 * visible Tree rows, Ctrl-clicks and Shift-clicks rows, opens the context menu
 * on a selected row, and inspects the rendered menu actions and disabled
 * states.
 *
 * Expected:
 * Selection-scoped file actions are absent from the toolbar, Ctrl and Shift
 * marquee, Ctrl, and Shift selection produce multi-selected row sets in the
 * real WebView, right-clicking an already selected row preserves that set,
 * Rename is disabled for multi-selection, and Permissions, Delete, Copy, Cut,
 * and Download remain enabled from the context menu.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
const isolatedAppConfig = await createIsolatedAppConfigEnv("files-context-menu-multi-selection");
const fixtureRoot = await createFilesFixture();
const fixtureHostId = "018f6eb3-6f91-7410-bc43-f927b2236d97";
const nativeDriverPath = optionalEnvPath("TAURI_TEST_NATIVE_DRIVER");
const driverPort = Number(process.env.TAURI_TEST_DRIVER_PORT ?? "4444");
const driverUrl = `http://127.0.0.1:${driverPort}`;
const devUrl = process.env.TAURI_TEST_DEV_URL ?? "http://localhost:1420/";
const devPort = Number(new URL(devUrl).port);
const nativeDriverArgs = nativeDriverPath ? ["--native-driver", nativeDriverPath] : [];

process.chdir(repoRoot);
process.env.NOCTURNE_DEV_PORT = String(devPort);
isolatedAppConfig.env.NOCTURNE_DEV_PORT = String(devPort);
await configureFixtureHost();

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
  await installErrorCapture();
  await activateFilesToolTab();
  await waitUntil(async () => await execute("return document.querySelector('.files-tooltab .files-toolbar') !== null;"), pageSummary);
  await waitUntil(async () => {
    const rows = await treeRowNames();
    return rows.includes("alpha.txt") && rows.includes("beta.txt") && rows.includes("gamma.txt") && rows.includes("delta.txt");
  }, pageSummary);

  const toolbar = await toolbarActions();
  const forbidden = ["Rename", "Permissions", "Delete", "Copy", "Cut", "Download"].filter((label) => toolbar.includes(label));
  if (forbidden.length > 0) {
    const screenshotPath = await saveScreenshot("files-context-menu-toolbar-actions.png");
    throw new Error(`Selection-scoped actions are still in the toolbar: ${forbidden.join(", ")}\n${JSON.stringify(toolbar, null, 2)}\nscreenshot: ${screenshotPath}`);
  }

  await dragMarqueeOverTreeRows("alpha.txt", "beta.txt");
  await waitUntil(async () => sameSet(await selectedTreeRowNames(), ["alpha.txt", "beta.txt"]), pageSummary);
  let selected = await selectedTreeRowNames();
  if (!sameSet(selected, ["alpha.txt", "beta.txt"])) {
    const screenshotPath = await saveScreenshot("files-context-menu-marquee-selection.png");
    const marqueeLog = await execute("return window.__NOCTURNE_TEST_MARQUEE_LOG__ ?? [];");
    const marqueeState = await execute(`
      const surface = document.querySelector('.files-table .files-selection-surface');
      const rect = surface?.getBoundingClientRect();
      return {
        errors: window.__NOCTURNE_TEST_ERRORS__ ?? [],
        surfaceRect: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } : null,
        marqueeVisible: document.querySelector('.marquee-selection') !== null,
        selectedRows: [...document.querySelectorAll('.files-table [data-file-entry="true"].selected')]
          .map((row) => row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? ''),
      };
    `);
    throw new Error(`Mouse marquee drag did not produce the expected selection\n${JSON.stringify({ selected, marqueeLog, marqueeState }, null, 2)}\nscreenshot: ${screenshotPath}`);
  }

  await clickTreeRow("alpha.txt");
  await clickTreeRow("gamma.txt", { ctrlKey: true });
  selected = await selectedTreeRowNames();
  if (!sameSet(selected, ["alpha.txt", "gamma.txt"])) {
    const screenshotPath = await saveScreenshot("files-context-menu-ctrl-selection.png");
    throw new Error(`Ctrl-click did not produce the expected selection\n${JSON.stringify(selected, null, 2)}\nscreenshot: ${screenshotPath}`);
  }

  await clickTreeRow("delta.txt", { shiftKey: true });
  selected = await selectedTreeRowNames();
  if (!sameSet(selected, ["gamma.txt", "delta.txt"])) {
    const screenshotPath = await saveScreenshot("files-context-menu-shift-selection.png");
    throw new Error(`Shift-click did not select the expected visible range\n${JSON.stringify(selected, null, 2)}\nscreenshot: ${screenshotPath}`);
  }

  const menu = await openContextMenuOnTreeRow("gamma.txt");
  const expectedDisabled = {
    Rename: true,
    Delete: false,
    Copy: false,
    Cut: false,
    Download: false,
  };
  if (!sameMenuState(menu, expectedDisabled)) {
    const screenshotPath = await saveScreenshot("files-context-menu-actions.png");
    throw new Error(`Files context menu state was not correct for multi-selection\n${JSON.stringify({ menu, expectedDisabled }, null, 2)}\nscreenshot: ${screenshotPath}`);
  }

  selected = await selectedTreeRowNames();
  if (!sameSet(selected, ["gamma.txt", "delta.txt"])) {
    const screenshotPath = await saveScreenshot("files-context-menu-preserve-selection.png");
    throw new Error(`Right-clicking a selected row did not preserve multi-selection\n${JSON.stringify(selected, null, 2)}\nscreenshot: ${screenshotPath}`);
  }

  console.log(
    `tauri files context menu multi-selection test passed\n${JSON.stringify(
      {
        toolbarActionCount: toolbar.length,
        selectedRows: selected,
        menu,
      },
      null,
      2,
    )}`,
  );
} finally {
  if (sessionId) {
    await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
  }
  stopProcess(tauriDriver);
  await devServer.close();
  await isolatedAppConfig.cleanup();
  await rm(fixtureRoot, { recursive: true, force: true });
}

async function createFilesFixture() {
  const root = await mkdtemp(join(tmpdir(), "nocturne-files-context-menu-"));
  await writeFile(join(root, "alpha.txt"), "alpha\n");
  await writeFile(join(root, "beta.txt"), "beta\n");
  await writeFile(join(root, "gamma.txt"), "gamma\n");
  await writeFile(join(root, "delta.txt"), "delta\n");
  return root;
}

async function configureFixtureHost() {
  const configRoot = isolatedAppConfig.env.NOCTURNE_CONFIG_ROOT;
  const hostsDir = resolve(configRoot, "hosts");
  const profilesDir = resolve(configRoot, "profiles");
  await mkdir(hostsDir, { recursive: true });
  await mkdir(profilesDir, { recursive: true });
  await writeFile(
    resolve(configRoot, "config.toml"),
    `default_host = "${fixtureHostId}"\nopenssh_config_files = []\n\n[files]\ndefault_view_mode = "tree"\n`,
  );
  await writeFile(resolve(profilesDir, "default.toml"), "");
  await writeFile(
    resolve(hostsDir, `${fixtureHostId}.toml`),
    `version = 1\nid = "${fixtureHostId}"\nname = "Files Context Menu Fixture"\nprotocol = "local"\n\n[files]\ndefault_path = ${JSON.stringify(fixtureRoot)}\n\n[local]\nargs = []\nenv = {}\n`,
  );
}

async function toolbarActions() {
  return await execute(`
    return [...document.querySelectorAll('.files-toolbar button')]
      .filter((button) => button.offsetParent !== null)
      .map((button) => button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent?.trim() || '');
  `);
}

async function activateFilesToolTab() {
  await waitUntil(async () => {
    const result = await execute(`
      const button = document.querySelector('[data-tool-kind="files"]');
      if (!button) {
        return {
          found: false,
          toolTabs: [...document.querySelectorAll('[data-tool-kind]')].map((item) => ({
            kind: item.getAttribute('data-tool-kind'),
            title: item.getAttribute('data-tool-snapshot-title') || item.textContent?.trim() || '',
          })),
        };
      }
      button.click();
      return { found: true };
    `);
    return result.found === true;
  }, pageSummary);
}

async function installErrorCapture() {
  await execute(`
    window.__NOCTURNE_TEST_ERRORS__ = [];
    window.addEventListener('error', (event) => {
      window.__NOCTURNE_TEST_ERRORS__.push({
        kind: 'error',
        message: event.message,
        stack: event.error?.stack ?? '',
      });
    });
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      window.__NOCTURNE_TEST_ERRORS__.push({
        kind: 'unhandledrejection',
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack ?? '' : '',
      });
    });
    return true;
  `);
}

async function treeRowNames() {
  return await execute(`
    return [...document.querySelectorAll('.files-table [data-file-entry="true"]')]
      .filter((row) => row.offsetParent !== null)
      .map((row) => row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? '');
  `);
}

async function selectedTreeRowNames() {
  return await execute(`
    return [...document.querySelectorAll('.files-table [data-file-entry="true"].selected')]
      .filter((row) => row.offsetParent !== null)
      .map((row) => row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? '');
  `);
}

async function clickTreeRow(name, options = {}) {
  const result = await execute(treeRowScript(name, "click", options));
  if (!result.found) {
    throw new Error(`Tree row ${name} was not found: ${JSON.stringify(result, null, 2)}`);
  }
}

async function openContextMenuOnTreeRow(name) {
  const result = await execute(treeRowScript(name, "contextmenu", {}));
  if (!result.found) {
    throw new Error(`Tree row ${name} was not found for context menu: ${JSON.stringify(result, null, 2)}`);
  }
  await waitUntil(async () => await execute("return document.querySelector('.files-context-menu') !== null;"), pageSummary);
  return await execute(`
    return [...document.querySelectorAll('.files-context-menu [role="menuitem"]')].map((item) => ({
      label: item.textContent?.trim() ?? '',
      disabled: item.disabled === true,
    }));
  `);
}

async function dragMarqueeOverTreeRows(firstName, lastName) {
  const drag = await execute(`
    const root = document.querySelector('.files-table');
    const rows = [...document.querySelectorAll('.files-table [data-file-entry="true"]')]
      .filter((row) => row.offsetParent !== null);
    const first = rows.find((candidate) => candidate.querySelector('.name-cell')?.textContent?.trim() === ${JSON.stringify(firstName)});
    const last = rows.find((candidate) => candidate.querySelector('.name-cell')?.textContent?.trim() === ${JSON.stringify(lastName)});
    if (!root || !first || !last) {
      return {
        found: false,
        rows: rows.map((candidate) => candidate.querySelector('.name-cell')?.textContent?.trim() ?? candidate.textContent?.trim() ?? ''),
      };
    }
    const rootRect = root.getBoundingClientRect();
    const firstRect = first.getBoundingClientRect();
    const lastRect = last.getBoundingClientRect();
    return {
      found: true,
      startX: Math.round(firstRect.left + 8),
      startY: Math.round(firstRect.top + 2),
      endX: Math.round(Math.min(rootRect.right - 8, firstRect.left + 180)),
      endY: Math.round(lastRect.bottom - 2),
    };
  `);
  if (!drag.found) {
    throw new Error(`Rows for marquee drag were not found: ${JSON.stringify(drag, null, 2)}`);
  }
  await execute(`
    const points = ${JSON.stringify(drag)};
    const log = [];
    window.__NOCTURNE_TEST_MARQUEE_LOG__ = log;
    for (const type of ["mousedown", "mousemove", "mousemove", "mouseup"]) {
      const clientX = type === "mousedown" ? points.startX : points.endX;
      const clientY = type === "mousedown" ? points.startY : points.endY;
      const target = document.elementFromPoint(clientX, clientY);
      log.push({ type, ...hit(clientX, clientY) });
      target?.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0,
        buttons: type === "mouseup" ? 0 : 1,
        clientX,
        clientY,
      }));
    }
    function hit(clientX, clientY) {
      const target = document.elementFromPoint(clientX, clientY);
      return {
        targetTag: target?.tagName ?? "",
        targetClass: target?.className?.toString?.() ?? "",
        targetName: target?.querySelector?.(".name-cell")?.textContent?.trim?.() ?? target?.textContent?.trim?.().slice(0, 40) ?? "",
      };
    }
  `);
}

function treeRowScript(name, operation, options) {
  return `
    const rows = [...document.querySelectorAll('.files-table [data-file-entry="true"]')]
      .filter((row) => row.offsetParent !== null);
    const row = rows.find((candidate) => candidate.querySelector('.name-cell')?.textContent?.trim() === ${JSON.stringify(name)});
    if (!row) {
      return {
        found: false,
        rows: rows.map((candidate) => candidate.querySelector('.name-cell')?.textContent?.trim() ?? candidate.textContent?.trim() ?? ''),
      };
    }
    const rect = row.getBoundingClientRect();
    const eventOptions = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + Math.min(24, rect.width / 2),
      clientY: rect.top + rect.height / 2,
      ctrlKey: ${JSON.stringify(options.ctrlKey === true)},
      metaKey: ${JSON.stringify(options.metaKey === true)},
      shiftKey: ${JSON.stringify(options.shiftKey === true)},
      button: ${JSON.stringify(operation === "contextmenu" ? 2 : 0)},
    };
    row.dispatchEvent(new MouseEvent(${JSON.stringify(operation)}, eventOptions));
    return { found: true };
  `;
}

function sameSet(actual, expected) {
  return actual.length === expected.length && expected.every((item) => actual.includes(item));
}

function sameMenuState(menu, expectedDisabled) {
  return Object.entries(expectedDisabled).every(([label, disabled]) => menu.some((item) => item.label === label && item.disabled === disabled))
    && menu.some((item) => item.label === "Permissions");
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

async function saveScreenshot(name) {
  const response = await webdriver("GET", `/session/${sessionId}/screenshot`);
  const dir = resolve(repoRoot, "test-results");
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, name);
  await writeFile(path, Buffer.from(response.value, "base64"));
  return path;
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
  return await execute(`
    const backendSnapshot = await window.__TAURI_INTERNALS__?.invoke?.('get_workspace_layout_snapshot').catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    return {
      title: document.title,
      url: location.href,
      bodyText: document.body?.textContent?.slice(0, 1200) ?? '',
      mainHtml: document.querySelector('main')?.innerHTML?.slice(0, 2400) ?? '',
      errors: window.__NOCTURNE_TEST_ERRORS__ ?? [],
      workspaceBodyText: document.querySelector('.workspace-body')?.textContent?.slice(0, 1200) ?? '',
      workspaceBodyHtml: document.querySelector('.workspace-body')?.innerHTML?.slice(0, 1200) ?? '',
      workspaceBodyState: document.querySelector('.workspace-body')
        ? {
            activeId: document.querySelector('.workspace-body').getAttribute('data-workspace-active-id'),
            renderedId: document.querySelector('.workspace-body').getAttribute('data-workspace-rendered-id'),
            snapshotCount: document.querySelector('.workspace-body').getAttribute('data-workspace-snapshot-count'),
          }
        : null,
      dockGroupCount: document.querySelectorAll('[data-dock-group-id]').length,
      toolTabs: [...document.querySelectorAll('[data-tool-kind]')].map((item) => ({
        kind: item.getAttribute('data-tool-kind'),
        title: item.getAttribute('data-tool-snapshot-title') || item.textContent?.trim() || '',
        slot: item.getAttribute('data-tool-slot-id') || '',
      })),
      backendSnapshot: backendSnapshot
        ? {
            activeWorkspaceId: backendSnapshot.active_workspace_id,
            workspaceCount: backendSnapshot.workspaces?.length ?? 0,
            toolTabs: backendSnapshot.tool_tabs?.map((tool) => ({ id: tool.id, kind: tool.kind, title: tool.title })) ?? [],
          }
        : null,
      filesToolbarExists: document.querySelector('.files-tooltab .files-toolbar') !== null,
      filesText: document.querySelector('.files-tooltab')?.textContent?.slice(0, 1000) ?? '',
      selectedRows: [...document.querySelectorAll('.files-table [data-file-entry="true"].selected')]
        .map((row) => row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? ''),
    };
  `).then((summary) => JSON.stringify(summary, null, 2));
}

function stopProcess(child) {
  if (!child.pid || child.exitCode !== null) return;
  child.kill();
}
