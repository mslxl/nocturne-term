#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies that Files Tree rows keep Size, Modified, and Permissions columns
 * aligned when a file name is longer than the available Name column width in a
 * real Tauri WebView.
 *
 * Operation:
 * Creates an isolated local Files fixture containing one very long file name
 * and one short file name, launches the Tauri application through
 * tauri-driver, opens the Files ToolTab, expands the fixture directory, and
 * measures the rendered cell rectangles for both rows.
 *
 * Expected:
 * The long file name is clipped inside the Name cell, the file-name text does
 * not overlap the Size cell, and the metadata cells for the long-name row and
 * short-name row share the same left positions.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename as pathBasename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";
import { test } from "vitest";

test("files tree long name column alignment", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("files-tree-long-name-column-alignment");
  const longFileName = "workspace-storage-with-a-very-long-file-name-that-should-not-shift-metadata-columns.json";
  const fixtureRoot = await createFilesFixture();
  const longFilePath = join(fixtureRoot, longFileName);
  const shortFilePath = join(fixtureRoot, "short.json");
  const fixtureHostId = "018f6eb3-6f91-7410-bc43-f927b2236d99";
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
  let devServer = null;

  process.chdir(repoRoot);
  process.env.NOCTURNE_DEV_PORT = String(devPort);
  isolatedAppConfig.env.NOCTURNE_DEV_PORT = String(devPort);
  await configureFixtureHost();

  if (!(await isDevServerReady())) {
    devServer = await createServer({
      server: {
        host: "127.0.0.1",
        port: devPort,
        strictPort: true,
      },
      envDir: repoRoot,
      logLevel: "silent",
    });
    await devServer.listen();
  }

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
    await activateFilesToolTab();
    await waitUntil(async () => await execute("return document.querySelector('.files-tooltab .files-toolbar') !== null;"), pageSummary);
    await waitUntil(async () => (await treeRows()).some((row) => sameTestPath(row.path, fixtureRoot)), pageSummary);
    await ensureTreePathExpanded(fixtureRoot);
    await waitUntil(async () => {
      const rows = await treeRows();
      return rows.some((row) => sameTestPath(row.path, shortFilePath)) && rows.some((row) => sameTestPath(row.path, longFilePath));
    }, pageSummary);

    const measurement = await measureRows();
    if (!measurement.ok) {
      const screenshotPath = await saveScreenshot("files-tree-long-name-column-alignment.png");
      throw new Error(
        `Long Files Tree row misaligned metadata columns\n${JSON.stringify(
          { ...measurement, screenshotPath },
          null,
          2,
        )}`,
      );
    }

    console.log(`tauri files tree long name column alignment test passed\n${JSON.stringify(measurement, null, 2)}`);
  } finally {
    if (sessionId) {
      await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
    }
    stopProcess(tauriDriver);
    await devServer?.close();
    await isolatedAppConfig.cleanup();
    await rm(fixtureRoot, { recursive: true, force: true });
  }

  async function createFilesFixture() {
    const root = await mkdtemp(join(tmpdir(), "nocturne-files-tree-long-name-"));
    await writeFile(join(root, longFileName), "long-name content\n");
    await writeFile(join(root, "short.json"), "short content\n");
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
      `version = 1\nid = "${fixtureHostId}"\nname = "Files Tree Long Name Fixture"\nprotocol = "local"\n\n[files]\ndefault_path = ${JSON.stringify(fixtureRoot)}\n\n[local]\nargs = []\nenv = {}\n`,
    );
  }

  async function activateFilesToolTab() {
    await waitUntil(async () => {
      const result = await execute(`
        const button = document.querySelector('[data-tool-kind="files"]');
        if (!button) return { found: false };
        const group = button.closest('[data-dock-group-id]');
        const active = button.classList.contains('active');
        const collapsed = group?.getAttribute('data-dock-group-collapsed') === 'true';
        if (!active || collapsed) {
          button.click();
          return { found: true, clicked: true, active, collapsed };
        }
        return { found: true, clicked: false, active, collapsed };
      `);
      return result.found === true;
    }, pageSummary);
  }

  async function treeRows() {
    return await execute(`
      return [...document.querySelectorAll('.files-table .files-row[data-file-entry="true"]:not(.sticky-row)')]
        .filter((row) => row.offsetParent !== null)
        .map((row) => ({
          name: basename(row.getAttribute('data-entry-path') ?? row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? ''),
          path: row.getAttribute('data-entry-path') ?? '',
          kind: row.getAttribute('data-entry-kind') ?? '',
          expanded: row.getAttribute('aria-expanded'),
        }));

      function basename(value) {
        const normalized = value.replace(/\\\\/g, '/').replace(/\\/+$/, '');
        return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
      }
    `);
  }

  async function ensureTreePathExpanded(path) {
    const rows = await treeRows();
    const row = rows.find((candidate) => sameTestPath(candidate.path, path));
    if (!row) {
      throw new Error(`Tree directory ${path} was not found: ${await pageSummary()}`);
    }
    if (row.expanded === "true") return;
    await expandTreeDirectory(path);
  }

  async function expandTreeDirectory(path) {
    const result = await execute(`
      const row = treeRow(${JSON.stringify(path)});
      if (!row) return { found: false, rows: rowNames() };
      const disclosure = row.querySelector('.tree-disclosure:not(.placeholder)');
      if (!disclosure) return { found: false, reason: 'Directory disclosure was not available', rows: rowNames() };
      disclosure.click();
      return { found: true };

      function treeRow(path) {
        return [...document.querySelectorAll('.files-table .files-row[data-file-entry="true"]:not(.sticky-row)')]
          .filter((item) => item.offsetParent !== null)
          .find((item) => item.getAttribute('data-entry-kind') === 'directory' && samePath(item.getAttribute('data-entry-path') ?? '', path));
      }
      function rowNames() {
        return [...document.querySelectorAll('.files-table .files-row[data-file-entry="true"]:not(.sticky-row)')]
          .map((item) => ({ name: basename(item.getAttribute('data-entry-path') ?? item.querySelector('.name-cell')?.textContent?.trim() ?? item.textContent?.trim() ?? ''), path: item.getAttribute('data-entry-path') ?? '' }));
      }
      function basename(value) {
        const normalized = value.replace(/\\\\/g, '/').replace(/\\/+$/, '');
        return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
      }
      function samePath(left, right) {
        return normalizePath(left) === normalizePath(right);
      }
      function normalizePath(value) {
        return value.replace(/\\\\/g, '/').replace(/\\/+$/, '');
      }
    `);
    if (!result.found) throw new Error(`Tree directory ${path} was not found: ${JSON.stringify(result, null, 2)}`);
  }

  async function measureRows() {
    return await execute(`
      const longName = ${JSON.stringify(longFileName)};
      const longRow = rowForPath(${JSON.stringify(longFilePath)});
      const shortRow = rowForPath(${JSON.stringify(shortFilePath)});
      if (!longRow || !shortRow) {
        return { ok: false, reason: 'Rows were not both visible', rows: rowNames() };
      }

      const longCells = measureRow(longRow);
      const shortCells = measureRow(shortRow);
      const tolerance = 1;
      const metadataAligned =
        Math.abs(longCells.size.left - shortCells.size.left) <= tolerance &&
        Math.abs(longCells.modified.left - shortCells.modified.left) <= tolerance &&
        Math.abs(longCells.permissions.left - shortCells.permissions.left) <= tolerance;
      const nameClippedInsideNameCell = longCells.fileNameText.right <= longCells.name.right + tolerance;
      const nameDoesNotOverlapSize = longCells.fileNameText.right <= longCells.size.left - 2;
      const nameActuallyTruncated = longCells.fileNameText.scrollWidth > longCells.fileNameText.clientWidth;

      return {
        ok: metadataAligned && nameClippedInsideNameCell && nameDoesNotOverlapSize && nameActuallyTruncated,
        metadataAligned,
        nameClippedInsideNameCell,
        nameDoesNotOverlapSize,
        nameActuallyTruncated,
        longCells,
        shortCells,
      };

      function rowForPath(path) {
        return [...document.querySelectorAll('.files-table .files-row[data-file-entry="true"]:not(.sticky-row)')]
          .filter((row) => row.offsetParent !== null)
          .find((row) => samePath(row.getAttribute('data-entry-path') ?? '', path));
      }
      function rowNames() {
        return [...document.querySelectorAll('.files-table .files-row[data-file-entry="true"]:not(.sticky-row)')]
          .map((row) => basename(row.getAttribute('data-entry-path') ?? row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? ''));
      }
      function measureRow(row) {
        const cells = [...row.children];
        return {
          row: rect(row),
          name: rect(cells[0]),
          size: rect(cells[1]),
          modified: rect(cells[2]),
          permissions: rect(cells[3]),
          fileNameText: {
            ...rect(row.querySelector('.file-name-text')),
            scrollWidth: row.querySelector('.file-name-text')?.scrollWidth ?? 0,
            clientWidth: row.querySelector('.file-name-text')?.clientWidth ?? 0,
          },
        };
      }
      function rect(element) {
        if (!element) return { left: 0, right: 0, width: 0 };
        const value = element.getBoundingClientRect();
        return { left: value.left, right: value.right, width: value.width };
      }
      function basename(value) {
        const normalized = value.replace(/\\\\/g, '/').replace(/\\/+$/, '');
        return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
      }
      function samePath(left, right) {
        return normalizePath(left) === normalizePath(right);
      }
      function normalizePath(value) {
        return value.replace(/\\\\/g, '/').replace(/\\/+$/, '');
      }
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
    await waitUntil(isDevServerReady, "Vite dev server did not start");
  }

  async function isDevServerReady() {
    try {
      const response = await fetch(devUrl);
      return response.ok;
    } catch {
      return false;
    }
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

  function sameTestPath(left, right) {
    return normalizeTestPath(left) === normalizeTestPath(right);
  }

  function normalizeTestPath(value) {
    return value.replace(/\\/g, "/").replace(/\/+$/, "");
  }

  async function pageSummary() {
    if (!sessionId) return "no WebDriver session";
    return await execute(`
      return {
        title: document.title,
        bodyText: document.body?.textContent?.slice(0, 1200) ?? '',
        rows: [...document.querySelectorAll('.files-table .files-row[data-file-entry="true"]:not(.sticky-row)')]
          .map((row) => row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? ''),
      };
    `).then((summary) => JSON.stringify(summary, null, 2));
  }

  function stopProcess(child) {
    if (!child.pid || child.exitCode !== null) return;
    child.kill();
  }
});
