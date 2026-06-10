#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies that refreshing a Files ToolTab keeps the current browse path, Tree
 * expansion state, selected file, and visible preview in a real Tauri WebView.
 *
 * Operation:
 * Creates a temporary local file fixture with nested alpha and beta
 * directories and a previewable leaf.txt file, configures a temporary Local
 * Host as the default Workspace host, launches the Tauri application through
 * tauri-driver, expands alpha and beta in Tree view, selects leaf.txt, clicks
 * the Files Refresh toolbar action, samples the Files DOM during refresh, and
 * inspects the settled Tree and preview state.
 *
 * Expected:
 * Refresh does not replace the populated Files view with a Loading-only status,
 * the address path remains on the fixture root, alpha and beta stay expanded,
 * leaf.txt remains selected, and the preview panel stays visible after the
 * refreshed directory data settles.
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
const isolatedAppConfig = await createIsolatedAppConfigEnv("files-refresh-tree-state");
const fixtureRoot = await createFilesFixture();
const fixtureHostId = "018f6eb3-6f91-7410-bc43-f927b2236d95";
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
  await waitUntil(async () => await execute("return document.querySelector('.files-tooltab .files-toolbar') !== null;"), pageSummary);
  await waitUntil(async () => {
    const state = await treeState();
    return state.addressPath === fixtureRoot && state.rows.some((row) => row.name.includes("alpha"));
  }, pageSummary);

  await toggleTreeDirectory("alpha");
  await waitUntil(async () => {
    const state = await treeState();
    return state.rows.some((row) => row.name.includes("beta"));
  }, pageSummary);

  await toggleTreeDirectory("beta");
  await waitUntil(async () => {
    const state = await treeState();
    return state.rows.some((row) => row.name.includes("leaf.txt"));
  }, pageSummary);

  await clickTreeRow("leaf.txt");
  await waitUntil(async () => {
    const state = await treeState();
    return state.selectedRows.some((row) => row.name.includes("leaf.txt")) && state.previewVisible;
  }, pageSummary);

  const refresh = await captureRefreshState();
  if (!refresh.ok) {
    const screenshotPath = await saveScreenshot("files-refresh-lost-tree-state.png");
    throw new Error(`${refresh.reason}\n${JSON.stringify(refresh, null, 2)}\nscreenshot: ${screenshotPath}`);
  }

  console.log(
    `tauri files refresh preserves tree state test passed\n${JSON.stringify(
      {
        addressPath: refresh.final.addressPath,
        expandedRows: refresh.final.expandedRows,
        selectedRows: refresh.final.selectedRows,
        previewVisible: refresh.final.previewVisible,
        sampleCount: refresh.sampleCount,
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
  const root = await mkdtemp(join(tmpdir(), "nocturne-files-refresh-"));
  await mkdir(join(root, "alpha", "beta"), { recursive: true });
  await writeFile(join(root, "alpha", "beta", "leaf.txt"), "leaf content\n");
  await writeFile(join(root, "alpha", "note.txt"), "alpha content\n");
  await writeFile(join(root, "root.txt"), "root content\n");
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
    `version = 1\nid = "${fixtureHostId}"\nname = "Refresh Fixture"\nprotocol = "local"\n\n[files]\ndefault_path = ${JSON.stringify(fixtureRoot)}\n\n[local]\nargs = []\nenv = {}\n`,
  );
}

async function clickTreeRow(name) {
  const target = await execute(`
    const rows = [...document.querySelectorAll('.files-row[data-file-entry="true"]')];
    const row = rows.find((item) =>
      item.querySelector('.name-cell')?.textContent?.trim().includes(${JSON.stringify(name)})
    );
    if (!row) {
      return {
        clicked: false,
        rows: rows.map((item) => ({
          text: item.textContent?.trim() ?? '',
          kind: item.getAttribute('data-entry-kind'),
          path: item.getAttribute('data-entry-path'),
        })),
      };
    }
    const rect = row.getBoundingClientRect();
    return {
      found: true,
      x: Math.round(rect.left + Math.min(24, rect.width / 2)),
      y: Math.round(rect.top + rect.height / 2),
      text: row.textContent?.trim() ?? '',
      path: row.getAttribute('data-entry-path'),
    };
  `);
  if (!target.found) {
    throw new Error(`Tree view did not contain ${name}: ${JSON.stringify(target, null, 2)}`);
  }
  await pointerClick(target.x, target.y);
}

async function toggleTreeDirectory(name) {
  const target = await executeAsync(`
    const done = arguments[arguments.length - 1];
    const rows = [...document.querySelectorAll('.files-row[data-file-entry="true"]')];
    const row = rows.find((item) =>
      item.querySelector('.name-cell')?.textContent?.trim().includes(${JSON.stringify(name)})
    );
    const disclosure = row?.querySelector('.tree-disclosure:not(.placeholder)');
    if (!row || !disclosure) {
      done({
        clicked: false,
        rows: rows.map((item) => ({
          text: item.textContent?.trim() ?? '',
          expanded: item.getAttribute('aria-expanded'),
          path: item.getAttribute('data-entry-path'),
        })),
      });
      return;
    }
    disclosure.click();
    setTimeout(() => {
      done({
        found: true,
        text: row.textContent?.trim() ?? '',
        expanded: row.getAttribute('aria-expanded'),
        path: row.getAttribute('data-entry-path'),
        rows: [...document.querySelectorAll('.files-row[data-file-entry="true"]')].map((item) => ({
          text: item.textContent?.trim() ?? '',
          expanded: item.getAttribute('aria-expanded'),
          path: item.getAttribute('data-entry-path'),
        })),
      });
    }, 250);
  `);
  if (!target.found) {
    throw new Error(`Tree view did not contain expandable directory ${name}: ${JSON.stringify(target, null, 2)}`);
  }
  if (!target.rows.some((row) => row.text.includes(name) && row.expanded === "true")) {
    throw new Error(`Tree directory ${name} did not expand after click: ${JSON.stringify(target, null, 2)}`);
  }
}

async function captureRefreshState() {
  return await executeAsync(`
    const done = arguments[arguments.length - 1];
    const refreshButton = document.querySelector('.files-toolbar button[aria-label="Refresh"]');
    if (!refreshButton) {
      done({ ok: false, reason: 'Refresh toolbar button missing' });
      return;
    }

    const samples = [];
    const started = performance.now();
    const sample = () => {
      const files = document.querySelector('.files-tooltab');
      const rows = [...document.querySelectorAll('.files-row[data-file-entry="true"]')].map((row) => {
        const name = row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? '';
        return {
          name,
          kind: row.getAttribute('data-entry-kind'),
          path: row.getAttribute('data-entry-path'),
          selected: row.classList.contains('selected'),
          expanded: row.getAttribute('aria-expanded'),
        };
      });
      samples.push({
        elapsed: performance.now() - started,
        loadingOnly: document.querySelector('.files-status')?.textContent?.trim() === 'Loading...',
        addressPath: document.querySelector('.path-field')?.textContent?.trim() ?? '',
        filesText: files?.textContent?.slice(0, 300) ?? '',
        rowCount: rows.length,
        rows,
        expandedRows: rows.filter((row) => row.expanded === 'true').map((row) => row.name),
        selectedRows: rows.filter((row) => row.selected).map((row) => row.name),
        previewVisible: document.querySelector('.tree-preview[aria-label="Preview"]') !== null,
      });
    };

    sample();
    refreshButton.click();

    const capture = () => {
      sample();
      if (performance.now() - started < 900) {
        requestAnimationFrame(capture);
        return;
      }

      const loadingOnlyFrame = samples.find((item) => item.loadingOnly);
      const emptyRowsFrame = samples.find((item) => item.rowCount === 0);
      const final = samples[samples.length - 1];
      const finalKeepsState = final.addressPath === ${JSON.stringify(fixtureRoot)} &&
        final.rows.some((row) => row.name.includes('alpha') && row.expanded === 'true') &&
        final.rows.some((row) => row.name.includes('beta') && row.expanded === 'true') &&
        final.rows.some((row) => row.name.includes('leaf.txt') && row.selected) &&
        final.previewVisible;

      done({
        ok: !loadingOnlyFrame && !emptyRowsFrame && finalKeepsState,
        reason: loadingOnlyFrame
          ? 'Refresh flashed a Loading-only Files status'
          : emptyRowsFrame
            ? 'Refresh produced an empty Tree frame'
            : !finalKeepsState
              ? 'Refresh did not preserve path, expansion, selected file, and preview state'
              : '',
        sampleCount: samples.length,
        loadingOnlyFrame: loadingOnlyFrame ?? null,
        emptyRowsFrame: emptyRowsFrame ?? null,
        first: samples[0],
        middle: samples[Math.floor(samples.length / 2)],
        final,
        samples: samples.slice(0, 8).concat(samples.slice(-8)),
      });
    };

    requestAnimationFrame(capture);
  `);
}

async function treeState() {
  return await execute(`
    const rows = [...document.querySelectorAll('.files-row[data-file-entry="true"]')].map((row) => {
      const name = row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? '';
      return {
        name,
        kind: row.getAttribute('data-entry-kind'),
        path: row.getAttribute('data-entry-path'),
        selected: row.classList.contains('selected'),
        expanded: row.getAttribute('aria-expanded'),
      };
    });
    return {
      addressPath: document.querySelector('.path-field')?.textContent?.trim() ?? '',
      rows,
      expandedRows: rows.filter((row) => row.expanded === 'true'),
      selectedRows: rows.filter((row) => row.selected),
      previewVisible: document.querySelector('.tree-preview[aria-label="Preview"]') !== null,
      statusText: document.querySelector('.files-status')?.textContent?.trim() ?? '',
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

async function execute(script) {
  const response = await webdriver("POST", `/session/${sessionId}/execute/sync`, {
    script,
    args: [],
  });
  return response.value;
}

async function executeAsync(script) {
  const response = await webdriver("POST", `/session/${sessionId}/execute/async`, {
    script,
    args: [],
  });
  return response.value;
}

async function pointerClick(x, y) {
  await webdriver("POST", `/session/${sessionId}/actions`, {
    actions: [
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, origin: "viewport", x, y },
          { type: "pointerDown", button: 0 },
          { type: "pointerUp", button: 0 },
        ],
      },
    ],
  });
  await webdriver("DELETE", `/session/${sessionId}/actions`).catch(() => undefined);
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
  return await treeState().then((summary) => JSON.stringify(summary, null, 2));
}

function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill();
}
