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
 * activates the Files ToolTab explicitly, Ctrl-clicks and Shift-clicks rows,
 * opens the context menu on a selected row, and inspects the rendered menu
 * actions and disabled states.
 *
 * Expected:
 * Selection-scoped file actions are absent from the toolbar, Ctrl and Shift
 * selection produce multi-selected row sets in the real WebView, right-clicking
 * an already selected row preserves that set, Rename is disabled for
 * multi-selection, Permissions remains present as a capability-gated action,
 * and Delete, Copy, Cut, and Download remain enabled from the context menu.
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

test("files context menu multi selection", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("files-context-menu-multi-selection");
  const fixtureRoot = await createFilesFixture();
  const alphaPath = join(fixtureRoot, "alpha.txt");
  const betaPath = join(fixtureRoot, "beta.txt");
  const gammaPath = join(fixtureRoot, "gamma.txt");
  const deltaPath = join(fixtureRoot, "delta.txt");
  const fixtureHostId = "018f6eb3-6f91-7410-bc43-f927b2236d97";
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
    const fixtureExpand = await ensureTreePathExpanded(fixtureRoot);
    await waitUntil(async () => {
      const rows = await treeRows();
      return [alphaPath, betaPath, gammaPath, deltaPath].every((path) => rows.some((row) => sameTestPath(row.path, path)));
    }, async () => `${await pageSummary()}\nfixture expand result: ${JSON.stringify(fixtureExpand, null, 2)}`);

    const toolbar = await toolbarActions();
    const forbidden = ["Rename", "Permissions", "Delete", "Copy", "Cut", "Download"].filter((label) => toolbar.includes(label));
    if (forbidden.length > 0) {
      const screenshotPath = await saveScreenshot("files-context-menu-toolbar-actions.png");
      throw new Error(`Selection-scoped actions are still in the toolbar: ${forbidden.join(", ")}\n${JSON.stringify(toolbar, null, 2)}\nscreenshot: ${screenshotPath}`);
    }

    await clickTreeRow(alphaPath);
    await clickTreeRow(gammaPath, { ctrlKey: true });
    let selected = await selectedTreeRowNames();
    if (!sameSet(selected, ["alpha.txt", "gamma.txt"])) {
      const screenshotPath = await saveScreenshot("files-context-menu-ctrl-selection.png");
      throw new Error(`Ctrl-click did not produce the expected selection\n${JSON.stringify(selected, null, 2)}\nscreenshot: ${screenshotPath}`);
    }

    await clickTreeRow(deltaPath, { shiftKey: true });
    selected = await selectedTreeRowNames();
    if (!sameSet(selected, ["gamma.txt", "delta.txt"])) {
      const screenshotPath = await saveScreenshot("files-context-menu-shift-selection.png");
      throw new Error(`Shift-click did not select the expected visible range\n${JSON.stringify(selected, null, 2)}\nscreenshot: ${screenshotPath}`);
    }

    const menu = await openContextMenuOnTreeRow(gammaPath);
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
    const root = await mkdtemp(join(tmpdir(), "zzzz-nocturne-files-context-menu-"));
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

  async function treeRows() {
    return await execute(`
      return [...document.querySelectorAll('.files-table [data-file-entry="true"]:not(.sticky-row)')]
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
      return [...document.querySelectorAll('.files-table [data-file-entry="true"].selected:not(.sticky-row)')]
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
    if (row.expanded === "true") return { found: true, alreadyExpanded: true, path: row.path };
    return await expandTreeDirectory(path);
  }

  async function expandTreeDirectory(path) {
    const result = await execute(`
      const rows = [...document.querySelectorAll('.files-table [data-file-entry="true"]:not(.sticky-row)')]
        .filter((row) => row.offsetParent !== null);
      const row = rows.find((candidate) =>
        candidate.getAttribute('data-entry-kind') === 'directory' &&
        samePath(candidate.getAttribute('data-entry-path') ?? '', ${JSON.stringify(path)})
      );
      if (!row) {
        return {
          found: false,
          rows: rows.map((candidate) => ({
            name: basename(candidate.getAttribute('data-entry-path') ?? candidate.querySelector('.name-cell')?.textContent?.trim() ?? candidate.textContent?.trim() ?? ''),
            path: candidate.getAttribute('data-entry-path') ?? '',
          })),
        };
      }
      const disclosure = row.querySelector('.tree-disclosure:not(.placeholder)');
      if (!disclosure) {
        return { found: false, reason: 'Directory disclosure was not available', rows: rows.map((candidate) => ({ name: basename(candidate.getAttribute('data-entry-path') ?? ''), path: candidate.getAttribute('data-entry-path') ?? '' })) };
      }
      const before = row.getAttribute('aria-expanded');
      disclosure.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', button: 0 }));
      disclosure.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, button: 0 }));
      disclosure.click();
      return {
        found: true,
        before,
        after: row.getAttribute('aria-expanded'),
        text: row.textContent?.trim() ?? '',
        path: row.getAttribute('data-entry-path') ?? '',
        rows: rows.map((candidate) => ({
          name: basename(candidate.getAttribute('data-entry-path') ?? candidate.querySelector('.name-cell')?.textContent?.trim() ?? candidate.textContent?.trim() ?? ''),
          expanded: candidate.getAttribute('aria-expanded'),
          kind: candidate.getAttribute('data-entry-kind'),
        })),
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
    `);
    if (!result.found) {
      throw new Error(`Tree directory ${path} was not found: ${JSON.stringify(result, null, 2)}`);
    }
    return result;
  }

  async function clickTreeRow(path, options = {}) {
    const result = await execute(treeRowScript(path, "click", options));
    if (!result.found) {
      throw new Error(`Tree row ${path} was not found: ${JSON.stringify(result, null, 2)}`);
    }
  }

  async function openContextMenuOnTreeRow(path) {
    const result = await execute(treeRowScript(path, "contextmenu", {}));
    if (!result.found) {
      throw new Error(`Tree row ${path} was not found for context menu: ${JSON.stringify(result, null, 2)}`);
    }
    await waitUntil(async () => await execute("return document.querySelector('.files-context-menu') !== null;"), pageSummary);
    return await execute(`
      return [...document.querySelectorAll('.files-context-menu [role="menuitem"]')].map((item) => ({
        label: item.textContent?.trim() ?? '',
        disabled: item.disabled === true,
      }));
    `);
  }

  async function dragMarqueeOverTreeRows(firstPath, lastPath) {
    const drag = await execute(`
      const root = document.querySelector('.files-table');
      const surface = document.querySelector('.files-table .files-selection-surface');
      const rows = [...document.querySelectorAll('.files-table [data-file-entry="true"]:not(.sticky-row)')]
        .filter((row) => row.offsetParent !== null);
      const first = rows.find((candidate) => samePath(candidate.getAttribute('data-entry-path') ?? '', ${JSON.stringify(firstPath)}));
      const last = rows.find((candidate) => samePath(candidate.getAttribute('data-entry-path') ?? '', ${JSON.stringify(lastPath)}));
      if (!root || !surface || !first || !last) {
        return {
          found: false,
          hasRoot: Boolean(root),
          hasSurface: Boolean(surface),
          rows: rows.map((candidate) => ({
            name: basename(candidate.getAttribute('data-entry-path') ?? candidate.querySelector('.name-cell')?.textContent?.trim() ?? candidate.textContent?.trim() ?? ''),
            path: candidate.getAttribute('data-entry-path') ?? '',
          })),
        };
      }
      const scrolled = scrollRowsIntoFilesViewport(root, [first, last]);
      const rootRect = root.getBoundingClientRect();
      const surfaceRect = surface.getBoundingClientRect();
      const firstRect = first.getBoundingClientRect();
      const lastRect = last.getBoundingClientRect();
      const firstPath = first.getAttribute('data-entry-path') ?? '';
      const parentPath = dirname(firstPath);
      const siblingRows = rows.filter((row) => dirname(row.getAttribute('data-entry-path') ?? '') === parentPath && row.getAttribute('data-entry-kind') === 'file');
      const siblingRowsBottom = siblingRows.reduce((bottom, row) => Math.max(bottom, row.getBoundingClientRect().bottom), Math.max(firstRect.bottom, lastRect.bottom));
      const emptyStartY = Math.min(rootRect.bottom - 8, Math.max(lastRect.bottom, siblingRowsBottom) + 24);
      if (emptyStartY <= Math.max(lastRect.bottom, siblingRowsBottom) + 4) {
        return {
          found: false,
          reason: "Tree surface does not expose empty space below visible rows for marquee start",
          rootRect: rect(rootRect),
          surfaceRect: rect(surfaceRect),
          firstRect: rect(firstRect),
          lastRect: rect(lastRect),
          siblingRowsBottom,
          parentPath,
          scrolled,
        };
      }
      const startX = Math.round(Math.min(rootRect.right - 8, Math.max(rootRect.left + 8, firstRect.left + 16)));
      const startY = Math.round(emptyStartY);
      return {
        found: true,
        startX,
        startY,
        endX: Math.round(Math.min(rootRect.right - 8, firstRect.left + 180)),
        endY: Math.round(firstRect.top + 2),
        hitTest: hitTest(startX, startY),
        firstRect: rect(firstRect),
        lastRect: rect(lastRect),
        rootRect: rect(rootRect),
        surfaceRect: rect(surfaceRect),
        scrolled,
      };
      function rect(value) {
        return { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height };
      }
      function basename(value) {
        const normalized = value.replace(/\\\\/g, '/').replace(/\\/+$/, '');
        return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
      }
      function dirname(value) {
        const normalized = value.replace(/\\\\/g, '/').replace(/\\/+$/, '');
        const index = normalized.lastIndexOf('/');
        return index <= 0 ? normalized.slice(0, index + 1) || '/' : normalized.slice(0, index);
      }
      function samePath(left, right) {
        return normalizePath(left) === normalizePath(right);
      }
      function normalizePath(value) {
        return value.replace(/\\\\/g, '/').replace(/\\/+$/, '');
      }
      function scrollRowsIntoFilesViewport(root, targetRows) {
        const candidates = [
          ...document.querySelectorAll('[data-overlayscrollbars-viewport], .files-table, .files-selection-surface'),
          document.scrollingElement,
        ].filter(Boolean).filter((element, index, list) =>
          list.indexOf(element) === index &&
          element.scrollHeight > element.clientHeight
        );
        const changes = [];
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const rootRect = root.getBoundingClientRect();
          const firstRect = targetRows[0].getBoundingClientRect();
          const lastRect = targetRows[targetRows.length - 1].getBoundingClientRect();
          const desiredTop = rootRect.top + 64;
          const desiredBottom = rootRect.bottom - 96;
          const delta = firstRect.top < desiredTop
            ? firstRect.top - desiredTop
            : lastRect.bottom > desiredBottom
              ? lastRect.bottom - desiredBottom
              : 0;
          if (Math.abs(delta) < 1) break;
          let moved = false;
          for (const candidate of candidates) {
            const before = candidate.scrollTop;
            candidate.scrollTop += delta;
            if (candidate.scrollTop !== before) {
              moved = true;
              changes.push({
                className: candidate.className?.toString?.() ?? candidate.tagName,
                before,
                after: candidate.scrollTop,
                delta,
              });
            }
          }
          if (!moved) break;
        }
        return changes;
      }
      function hitTest(x, y) {
        const element = document.elementFromPoint(x, y);
        return {
          tagName: element?.tagName ?? '',
          className: element?.className?.toString?.() ?? '',
          entryPath: element?.closest?.('[data-file-entry="true"]')?.getAttribute('data-entry-path') ?? '',
          inSurface: Boolean(element?.closest?.('.files-selection-surface')),
          inTable: Boolean(element?.closest?.('.files-table')),
        };
      }
    `);
    if (!drag.found) {
      throw new Error(`Rows for marquee drag were not found: ${JSON.stringify(drag, null, 2)}`);
    }
    await execute(`
      window.__NOCTURNE_TEST_MARQUEE_LOG__ = [];
      return true;
    `);
    await pointerDrag(drag.startX, drag.startY, drag.endX, drag.endY);
    return drag;
  }

  async function pointerDrag(startX, startY, endX, endY) {
    await webdriver("POST", `/session/${sessionId}/actions`, {
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            { type: "pointerMove", duration: 0, origin: "viewport", x: startX, y: startY },
            { type: "pointerDown", button: 0 },
            { type: "pointerMove", duration: 80, origin: "viewport", x: endX, y: endY },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
    await webdriver("DELETE", `/session/${sessionId}/actions`).catch(() => undefined);
  }

  function treeRowScript(path, operation, options) {
    return `
      const rows = [...document.querySelectorAll('.files-table [data-file-entry="true"]:not(.sticky-row)')]
        .filter((row) => row.offsetParent !== null);
      const row = rows.find((candidate) => samePath(candidate.getAttribute('data-entry-path') ?? '', ${JSON.stringify(path)}));
      if (!row) {
        return {
          found: false,
          rows: rows.map((candidate) => ({
            name: basename(candidate.getAttribute('data-entry-path') ?? candidate.querySelector('.name-cell')?.textContent?.trim() ?? candidate.textContent?.trim() ?? ''),
            path: candidate.getAttribute('data-entry-path') ?? '',
          })),
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

  function sameTestPath(left, right) {
    return normalizeTestPath(left) === normalizeTestPath(right);
  }

  function normalizeTestPath(value) {
    return value.replace(/\\/g, "/").replace(/\/+$/, "");
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

});
