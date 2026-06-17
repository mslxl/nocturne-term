#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies that Finder-style Files Columns file preview uses the third visible
 * column instead of adding a fourth column in a real Tauri WebView.
 *
 * Operation:
 * Creates a temporary local fixture with nested alpha, beta, and gamma
 * directories and a previewable leaf file, configures an isolated Local
 * Workspace, launches the Tauri application provided by
 * TAURI_TEST_APPLICATION through tauri-driver, switches Files to Columns view,
 * navigates to a three-directory window, opens gamma, then selects leaf.txt.
 *
 * Expected:
 * Selecting a file in a three-column Columns window keeps exactly three visible
 * columns: the first column shows the containing directory's parent listing,
 * the second column shows the file's containing directory, and the third column
 * is the read-only Preview column. No fourth file-column is rendered.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";
import { test } from "vitest";

test("files columns file preview third column", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("files-columns-file-preview-third-column");
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
    await waitUntil(async () => await execute("return document.querySelector('.files-tooltab .files-toolbar') !== null;"), pageSummary);
    await execute(`
      const button = document.querySelector('.files-toolbar button[aria-label="Columns view"]');
      if (!button) throw new Error('Columns view button missing');
      button.click();
      return true;
    `);
    await waitUntil(async () => await columnsIncludeRows([["alpha"]]), pageSummary);
    await clickColumnDirectory("alpha", 0);
    await waitUntil(async () => await columnsIncludeRows([["alpha"], ["beta"]]), pageSummary);
    await clickColumnDirectory("beta", 1);
    await waitUntil(async () => await columnsIncludeRows([["alpha"], ["beta"], ["gamma"]]), pageSummary);
    await clickColumnDirectory("gamma", 2);
    await waitUntil(async () => await columnsIncludeRows([["beta"], ["gamma"], ["leaf.txt"]]), pageSummary);
    await clickColumnFile("leaf.txt", 2);
    await waitUntil(async () => {
      const measurement = await measureColumnsView();
      return measurement.previewColumnVisibleWidth >= 40;
    }, pageSummary);

    const measurement = await measureColumnsView();
    const previewColumnIndex = measurement.columns.findIndex((column) => column.label === "Preview");
    const ok = measurement.columnCount === 3 &&
      previewColumnIndex === 2 &&
      measurement.previewColumnVisibleWidth >= 40 &&
      measurement.columns[0]?.rowNames.includes("gamma") &&
      measurement.columns[1]?.rowNames.includes("leaf.txt") &&
      !measurement.columns[2]?.rowNames.includes("leaf.txt");

    if (!ok) {
      const screenshotPath = await saveScreenshot("files-columns-file-preview-third-column.png");
      throw new Error(`Selecting a file did not render preview as the third Columns column\n${JSON.stringify({ previewColumnIndex, measurement }, null, 2)}\nscreenshot: ${screenshotPath}`);
    }

    console.log(
      `tauri files Columns file preview third-column test passed\n${JSON.stringify(
        {
          columnCount: measurement.columnCount,
          previewColumnIndex,
          previewColumnVisibleWidth: measurement.previewColumnVisibleWidth,
          firstColumnText: measurement.columns[0]?.firstRowText ?? "",
          secondColumnText: measurement.columns[1]?.firstRowText ?? "",
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
    const root = await mkdtemp(join(tmpdir(), "nocturne-files-columns-preview-"));
    await mkdir(join(root, "alpha", "beta", "gamma"), { recursive: true });
    await writeFile(join(root, "alpha", "beta", "gamma", "leaf.txt"), "leaf content\n");
    await writeFile(join(root, "alpha", "beta", "beta-note.txt"), "beta content\n");
    await writeFile(join(root, "alpha", "readme.txt"), "alpha content\n");
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
      `version = 1\nid = "${fixtureHostId}"\nname = "Columns Preview Fixture"\nprotocol = "local"\n\n[files]\ndefault_path = ${JSON.stringify(fixtureRoot)}\n\n[local]\nargs = []\nenv = {}\n`,
    );
  }

  async function columnsIncludeRows(expectedRowsByColumn) {
    const measurement = await measureColumnsView();
    return expectedRowsByColumn.every((expectedRows, index) => expectedRows.every((row) => measurement.columns[index]?.rowNames.includes(row)));
  }

  async function measureColumnsView() {
    return await execute(`
      const columnsView = document.querySelector('.columns-view');
      const currentPane = columnsView?.querySelector('.columns-pane.current') ?? columnsView;
      const viewRect = columnsView?.getBoundingClientRect();
      const columns = [...(currentPane?.querySelectorAll('.file-column') ?? [])].map((column) => {
        const rect = column.getBoundingClientRect();
        const rows = [...column.querySelectorAll('.column-row')].filter((row) => row.offsetParent !== null);
        const rowNames = rows.map((row) => row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? '');
        const visibleWidth = viewRect
          ? Math.max(0, Math.min(rect.right, viewRect.right) - Math.max(rect.left, viewRect.left))
          : 0;
        return {
          label: column.getAttribute('aria-label'),
          width: rect.width,
          visibleWidth,
          rowCount: rows.length,
          rowNames,
          firstRowText: rows[0]?.textContent?.trim() ?? '',
        };
      });
      const previewColumn = columns.find((column) => column.label === 'Preview');
      return {
        columnCount: columns.length,
        previewColumnVisibleWidth: previewColumn?.visibleWidth ?? 0,
        columns,
      };
    `);
  }

  async function clickColumnDirectory(name, columnIndex) {
    const clicked = await execute(columnRowScript(name, columnIndex, "directory"));
    if (!clicked.clicked) {
      throw new Error(`Columns view column ${columnIndex} did not contain directory ${name}: ${JSON.stringify(clicked, null, 2)}`);
    }
  }

  async function clickColumnFile(name, columnIndex) {
    const clicked = await execute(columnRowScript(name, columnIndex, "file"));
    if (!clicked.clicked) {
      throw new Error(`Columns view column ${columnIndex} did not contain file ${name}: ${JSON.stringify(clicked, null, 2)}`);
    }
  }

  function columnRowScript(name, columnIndex, kind) {
    return `
      const currentPane = document.querySelector('.columns-view .columns-pane.current') ?? document.querySelector('.columns-view');
      const column = currentPane?.querySelectorAll('.file-column')[${columnIndex}];
      const rows = [...(column?.querySelectorAll('.column-row') ?? [])]
        .filter((row) => row.offsetParent !== null);
      const row = rows.find((item) =>
        item.getAttribute('data-entry-kind') === ${JSON.stringify(kind)} &&
        item.querySelector('.name-cell')?.textContent?.trim() === ${JSON.stringify(name)}
      );
      if (!row) {
        return {
          clicked: false,
          rows: rows.map((item) => ({
            kind: item.getAttribute('data-entry-kind'),
            text: item.querySelector('.name-cell')?.textContent?.trim() ?? item.textContent?.trim() ?? '',
          })),
        };
      }
      row.click();
      return { clicked: true };
    `;
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
      return {
        title: document.title,
        url: location.href,
        columnsViewExists: document.querySelector('.columns-view') !== null,
        filesText: document.querySelector('.files-tooltab')?.textContent?.slice(0, 1000) ?? '',
      };
    `).then((summary) => JSON.stringify(summary, null, 2));
  }

  function stopProcess(child) {
    if (!child.pid || child.exitCode !== null) return;
    child.kill();
  }

});
