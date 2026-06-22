#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Finder-style Files ToolTab toolbar, upload target sheet, Tree sticky rows,
 * bottom selection summary, context-menu order, Tree filesystem root
 * focus behavior, and drag/drop affordance wiring in a real Tauri WebView.
 *
 * Operation:
 * Creates a nested temporary local fixture, configures an isolated Local
 * Workspace, launches the Tauri application provided by TAURI_TEST_APPLICATION
 * through tauri-driver, verifies that the Tree starts at the filesystem root
 * while focusing the configured default path, expands the focused fixture root
 * and deep Tree directories, scrolls the Tree to expose sticky ancestor rows,
 * selects a file, inspects the toolbar, confirms no compact top selection
 * action bar is rendered, checks the bottom selection summary and context
 * menu order, clears selection, clicks
 * the unified Upload toolbar button, inspects the Finder-style upload target
 * sheet, verifies directory rows and sticky rows expose lightweight drop-target
 * hooks, and confirms clicking a file row does not start marquee selection.
 *
 * Expected:
 * The real Files UI shows only directory/global toolbar actions, selection
 * actions stay out of the permanent chrome while the full object-action set
 * remains in the context menu, the bottom selection summary reflects the
 * selected item, Upload has one unified entry and opens a target
 * sheet when no target is explicit in Tree view, sticky rows represent visible
 * ancestors, directory rows and sticky rows have directory drop-target metadata
 * for Tauri file drops, and row clicks do not create a marquee selection
 * rectangle.
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

test("files finder toolbar upload drop affordances", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("files-finder-toolbar-upload-drop");
  const fixtureRoot = await createFilesFixture();
  const alphaPath = join(fixtureRoot, "alpha");
  const betaPath = join(fixtureRoot, "alpha", "beta");
  const gammaPath = join(fixtureRoot, "alpha", "beta", "gamma");
  const leafPath = join(fixtureRoot, "alpha", "beta", "gamma", "leaf.txt");
  const rootNotePath = join(fixtureRoot, "root-note.txt");
  const fixtureHostId = "018f6eb3-6f91-7410-bc43-f927b2236d98";
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
      const rows = await treeRows();
      return rows.some((row) => sameTestPath(row.path, fixtureRoot));
    }, pageSummary);
    await ensureTreePathExpanded(fixtureRoot);
    await waitUntil(async () => {
      const rows = await treeRows();
      return rows.some((row) => sameTestPath(row.path, alphaPath)) && rows.some((row) => sameTestPath(row.path, rootNotePath));
    }, pageSummary);

    const toolbar = await toolbarActions();
    assertEqualArray(toolbar, ["Upload", "New folder", "Refresh", "Tree view", "Columns view"], "Files toolbar action order");
    const duplicateUploadCount = toolbar.filter((label) => label === "Upload").length;
    if (duplicateUploadCount !== 1) {
      await throwWithScreenshot(`Files toolbar should expose exactly one Upload action, saw ${duplicateUploadCount}`, "files-upload-entry-count.png", { toolbar });
    }
    const forbiddenToolbar = ["Rename", "Permissions", "Delete", "Copy", "Cut", "Download", "Upload Files", "Upload Folder"].filter((label) =>
      toolbar.includes(label),
    );
    if (forbiddenToolbar.length > 0) {
      await throwWithScreenshot("Selection-scoped or split-upload actions are still in the toolbar", "files-toolbar-wrong-actions.png", {
        toolbar,
        forbiddenToolbar,
      });
    }

    await ensureTreePathExpanded(alphaPath);
    await ensureTreePathExpanded(betaPath);
    await ensureTreePathExpanded(gammaPath);
    await waitUntil(async () => (await treeRows()).some((row) => sameTestPath(row.path, leafPath)), pageSummary);
    await clickTreeRow(leafPath);
    await waitUntil(async () => {
      const selected = await selectedTreeRowNames();
      return selected.includes("leaf.txt");
    }, pageSummary);

    const selectionChrome = await filesSelectionChrome();
    assertEqualArray(selectionChrome.actionLabels, [], "Selection action bar should not be rendered");
    if (selectionChrome.summary !== "1 item selected") {
      await throwWithScreenshot("Files bottom selection summary did not describe the selected file", "files-selection-summary.png", selectionChrome);
    }
    const menu = await openContextMenuOnTreeRow(leafPath);
    assertEqualArray(menu.map((item) => item.label), ["Download", "Rename", "Copy", "Cut", "Permissions", "Copy Path", "Delete"], "Context menu order");

    await scrollTreeToRow(leafPath);
    await waitUntil(async () => (await stickyRows()).length >= 2, pageSummary);
    const sticky = await stickyRows();
    if (!sticky.some((row) => row.name === "beta") || !sticky.some((row) => row.name === "gamma")) {
      await throwWithScreenshot("Tree sticky rows did not expose visible parent directories", "files-tree-sticky-rows.png", { sticky });
    }

    const dropHooks = await directoryDropHooks();
    if (!dropHooks.normalRows.some((row) => row.name === "gamma") || !dropHooks.stickyRows.some((row) => row.name === "gamma")) {
      await throwWithScreenshot("Directory row and sticky row drop-target metadata were not both available", "files-directory-drop-hooks.png", dropHooks);
    }

    await closeContextMenu();
    await clearSelectionWithEscape();
    await waitUntil(async () => (await selectedTreeRowNames()).length === 0, pageSummary);
    await clickToolbarButton("Upload");
    await waitUntil(async () => await execute("return document.querySelector('.name-dialog[aria-label=\"Upload Target\"]') !== null;"), pageSummary);
    const uploadSheet = await uploadTargetSheet();
    if (
      uploadSheet.title !== "Upload Target" ||
      uploadSheet.label !== "Target folder" ||
      !normalizeTestPath(uploadSheet.value).startsWith(normalizeTestPath(fixtureRoot))
    ) {
      await throwWithScreenshot("Unified Upload did not open a Finder-style target sheet initialized near the current focus", "files-upload-target-sheet.png", {
        uploadSheet,
        fixtureRoot,
      });
    }

    await closeNameDialog();
    await clickTreeRow(rootNotePath);
    const marqueeAfterRowClick = await execute("return document.querySelector('.marquee-selection') !== null;");
    if (marqueeAfterRowClick) {
      await throwWithScreenshot("Clicking a file row started marquee selection", "files-row-click-marquee.png", {
        errors: await capturedErrors(),
      });
    }

    const errors = await capturedErrors();
    if (errors.length > 0) {
      await throwWithScreenshot("Files Finder toolbar/upload/drop affordance test saw browser errors", "files-finder-ui-errors.png", { errors });
    }

    console.log(
      `tauri files Finder toolbar/upload/drop affordances test passed\n${JSON.stringify(
        {
          toolbar,
          selectionChrome,
          sticky,
          uploadSheet,
          dropHooks,
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
    const root = await mkdtemp(join(tmpdir(), "nocturne-files-finder-ui-"));
    await mkdir(join(root, "alpha", "beta", "gamma"), { recursive: true });
    for (let index = 0; index < 80; index += 1) {
      await writeFile(join(root, "alpha", "beta", "gamma", `item-${String(index).padStart(2, "0")}.txt`), `item ${index}\n`);
    }
    await writeFile(join(root, "alpha", "beta", "gamma", "leaf.txt"), "leaf content\n");
    await writeFile(join(root, "alpha", "beta", "beta-note.txt"), "beta content\n");
    await writeFile(join(root, "alpha", "alpha-note.txt"), "alpha content\n");
    await writeFile(join(root, "root-note.txt"), "root content\n");
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
      `default_host = "${fixtureHostId}"\nopenssh_config_files = []\n\n[files]\ndefault_view_mode = "tree"\ntree_sticky_enabled = true\ntree_sticky_max_levels = 3\n`,
    );
    await writeFile(resolve(profilesDir, "default.toml"), "");
    await writeFile(
      resolve(hostsDir, `${fixtureHostId}.toml`),
      `version = 1\nid = "${fixtureHostId}"\nname = "Files Finder UI Fixture"\nprotocol = "local"\n\n[files]\ndefault_path = ${JSON.stringify(fixtureRoot)}\n\n[local]\nargs = []\nenv = {}\n`,
    );
  }

  async function activateFilesToolTab() {
    await waitUntil(async () => {
      const result = await execute(`
        const button = document.querySelector('[data-tool-kind="files"]');
        if (!button) return { found: false };
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

  async function toolbarActions() {
    return await execute(`
      return [...document.querySelectorAll('.files-toolbar button')]
        .filter((button) => button.offsetParent !== null)
        .map((button) => button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent?.trim() || '');
    `);
  }

  async function filesSelectionChrome() {
    return await execute(`
      return {
        actionLabels: [...document.querySelectorAll('.selection-action-bar button')]
          .filter((button) => button.offsetParent !== null)
          .map((button) => button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent?.trim() || ''),
        actionBarPresent: document.querySelector('.selection-action-bar') !== null,
        summary: document.querySelector('.files-selection-summary')?.textContent?.trim() ?? '',
      };
    `);
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

  async function selectedTreeRowNames() {
    return await execute(`
      return [...document.querySelectorAll('.files-table .files-row[data-file-entry="true"].selected:not(.sticky-row)')]
        .filter((row) => row.offsetParent !== null)
        .map((row) => basename(row.getAttribute('data-entry-path') ?? row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? ''));

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
      if (!row) {
        return { found: false, rows: rowNames() };
      }
      const disclosure = row.querySelector('.tree-disclosure:not(.placeholder)');
      if (!disclosure) {
        return { found: false, reason: 'Directory disclosure was not available', rows: rowNames() };
      }
      disclosure.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', button: 0 }));
      disclosure.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, button: 0 }));
      disclosure.click();
      return { found: true, expanded: row.getAttribute('aria-expanded') };

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
    await waitUntil(async () => {
      const rows = await treeRows();
      if (sameTestPath(path, alphaPath)) return rows.some((row) => sameTestPath(row.path, betaPath));
      if (sameTestPath(path, betaPath)) return rows.some((row) => sameTestPath(row.path, gammaPath));
      if (sameTestPath(path, gammaPath)) return rows.some((row) => sameTestPath(row.path, leafPath));
      return true;
    }, pageSummary);
  }

  async function clickTreeRow(path) {
    const result = await execute(treeRowScript(path, "click"));
    if (!result.found) throw new Error(`Tree row ${path} was not found: ${JSON.stringify(result, null, 2)}`);
  }

  async function openContextMenuOnTreeRow(path) {
    const result = await execute(treeRowScript(path, "contextmenu"));
    if (!result.found) throw new Error(`Tree row ${path} was not found for context menu: ${JSON.stringify(result, null, 2)}`);
    await waitUntil(async () => await execute("return document.querySelector('.files-context-menu') !== null;"), pageSummary);
    const menu = await execute(`
      return [...document.querySelectorAll('.files-context-menu [role="menuitem"]')].map((item) => ({
        label: item.textContent?.trim() ?? '',
        disabled: item.disabled === true,
        dangerous: item.classList.contains('dangerous'),
      }));
    `);
    if (menu.length === 0) {
      throw new Error(`Context menu opened without menu items: ${JSON.stringify({ result, summary: await pageSummary() }, null, 2)}`);
    }
    return menu;
  }

  function treeRowScript(path, operation) {
    return `
      const rows = [...document.querySelectorAll('.files-table .files-row[data-file-entry="true"]:not(.sticky-row)')]
        .filter((row) => row.offsetParent !== null);
      const row = rows.find((candidate) => samePath(candidate.getAttribute('data-entry-path') ?? '', ${JSON.stringify(path)}));
      if (!row) {
        return {
          found: false,
          rows: rows.map((candidate) => ({ name: basename(candidate.getAttribute('data-entry-path') ?? candidate.querySelector('.name-cell')?.textContent?.trim() ?? candidate.textContent?.trim() ?? ''), path: candidate.getAttribute('data-entry-path') ?? '' })),
        };
      }
      row.scrollIntoView({ block: 'center', inline: 'nearest' });
      void row.getBoundingClientRect();
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent(${JSON.stringify(operation)}, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + Math.min(24, rect.width / 2),
        clientY: rect.top + rect.height / 2,
        button: ${JSON.stringify(operation === "contextmenu" ? 2 : 0)},
      }));
      return {
        found: true,
        path: row.getAttribute('data-entry-path') ?? '',
        selected: row.classList.contains('selected'),
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      };

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
    `;
  }

  async function scrollTreeToRow(path) {
    const result = await execute(`
      const table = document.querySelector('.files-table');
      const viewport = table?.matches('[data-overlayscrollbars-viewport]')
        ? table
        : table?.querySelector('[data-overlayscrollbars-viewport]');
      const row = [...document.querySelectorAll('.files-table .files-row[data-file-entry="true"]:not(.sticky-row)')]
        .find((item) => samePath(item.getAttribute('data-entry-path') ?? '', ${JSON.stringify(path)}));
      if (!viewport || !row) return { found: false };
      viewport.scrollTop = Math.max(0, row.offsetTop - 24);
      viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
      return { found: true, scrollTop: viewport.scrollTop };

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
    if (!result.found) throw new Error(`Could not scroll Tree to ${path}: ${JSON.stringify(result, null, 2)}`);
  }

  async function stickyRows() {
    return await execute(`
      return [...document.querySelectorAll('.tree-sticky-rows .sticky-row')]
        .filter((row) => row.offsetParent !== null)
        .map((row) => ({
          name: basename(row.getAttribute('data-entry-path') ?? row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? ''),
          path: row.getAttribute('data-entry-path') ?? '',
          kind: row.getAttribute('data-entry-kind') ?? '',
        }));

      function basename(value) {
        const normalized = value.replace(/\\\\/g, '/').replace(/\\/+$/, '');
        return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
      }
    `);
  }

  async function directoryDropHooks() {
    return await execute(`
      const mapRows = (selector) => [...document.querySelectorAll(selector)]
        .filter((row) => row.offsetParent !== null && row.getAttribute('data-entry-kind') === 'directory')
        .map((row) => ({
          name: basename(row.getAttribute('data-entry-path') ?? row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? ''),
          path: row.getAttribute('data-entry-path') ?? '',
          hasDropClass: row.classList.contains('drop-target'),
        }));
      return {
        normalRows: mapRows('.files-table .files-row[data-file-entry="true"]:not(.sticky-row)'),
        stickyRows: mapRows('.tree-sticky-rows .sticky-row[data-file-entry="true"]'),
      };

      function basename(value) {
        const normalized = value.replace(/\\\\/g, '/').replace(/\\/+$/, '');
        return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
      }
    `);
  }

  async function closeContextMenu() {
    await execute("document.querySelector('.context-menu-backdrop')?.click(); return true;");
  }

  async function clearSelectionWithEscape() {
    const result = await execute(`
      const rows = [...document.querySelectorAll('.files-table .files-row[data-file-entry="true"].selected:not(.sticky-row)')];
      const firstSelected = rows[0];
      if (!firstSelected) return { found: true, clicked: false };
      const rect = firstSelected.getBoundingClientRect();
      firstSelected.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + Math.min(24, rect.width / 2),
        clientY: rect.top + rect.height / 2,
        ctrlKey: true,
        button: 0,
      }));
      return { found: true, clicked: true };
    `);
    if (!result.found) throw new Error(`Could not clear Files selection: ${JSON.stringify(result, null, 2)}`);
  }

  async function clickToolbarButton(label) {
    const result = await execute(`
      const button = [...document.querySelectorAll('.files-toolbar button')]
        .find((item) => (item.getAttribute('aria-label') || item.getAttribute('title') || item.textContent?.trim() || '') === ${JSON.stringify(label)});
      if (!button) return { found: false, labels: [...document.querySelectorAll('.files-toolbar button')].map((item) => item.getAttribute('aria-label') || item.textContent?.trim() || '') };
      button.click();
      return { found: true };
    `);
    if (!result.found) throw new Error(`Toolbar button ${label} was not found: ${JSON.stringify(result, null, 2)}`);
  }

  async function uploadTargetSheet() {
    return await execute(`
      const dialog = document.querySelector('.name-dialog[aria-label="Upload Target"]');
      return {
        title: dialog?.querySelector('h2')?.textContent?.trim() ?? '',
        label: dialog?.querySelector('label span')?.textContent?.trim() ?? '',
        value: dialog?.querySelector('input')?.value ?? '',
      };
    `);
  }

  async function closeNameDialog() {
    await execute("document.querySelector('.dialog-backdrop')?.click(); return true;");
  }

  async function capturedErrors() {
    return await execute("return window.__NOCTURNE_TEST_ERRORS__ ?? [];");
  }

  async function throwWithScreenshot(messageText, screenshotName, details) {
    const screenshotPath = await saveScreenshot(screenshotName);
    throw new Error(`${messageText}\n${JSON.stringify(details, null, 2)}\nscreenshot: ${screenshotPath}`);
  }

  function assertEqualArray(actual, expected, label) {
    const ok = actual.length === expected.length && expected.every((item, index) => actual[index] === item);
    if (!ok) {
      throw new Error(`${label} mismatch\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(actual)}`);
    }
  }

  function normalizeTestPath(value) {
    return value.replace(/\\/g, "/").replace(/\/+$/, "");
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

  function sameTestPath(left, right) {
    return normalizeTestPath(left) === normalizeTestPath(right);
  }

  async function pageSummary() {
    if (!sessionId) return "no WebDriver session";
    return await execute(`
      return {
        title: document.title,
        url: location.href,
        bodyText: document.body?.textContent?.slice(0, 1200) ?? '',
        errors: window.__NOCTURNE_TEST_ERRORS__ ?? [],
        filesToolbarExists: document.querySelector('.files-tooltab .files-toolbar') !== null,
        filesText: document.querySelector('.files-tooltab')?.textContent?.slice(0, 1000) ?? '',
        selectedRows: [...document.querySelectorAll('.files-table .files-row[data-file-entry="true"].selected:not(.sticky-row)')]
          .map((row) => row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? ''),
        stickyRows: [...document.querySelectorAll('.tree-sticky-rows .sticky-row')]
          .map((row) => row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? ''),
      };
    `).then((summary) => JSON.stringify(summary, null, 2));
  }

  function stopProcess(child) {
    if (!child.pid || child.exitCode !== null) return;
    child.kill();
  }
});
