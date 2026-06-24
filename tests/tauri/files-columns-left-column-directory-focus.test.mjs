#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies Finder-style Files Columns navigation when a directory that belongs
 * to the left visible column is selected in a real Tauri WebView.
 *
 * Operation:
 * Creates a temporary local fixture, configures that fixture as the Local
 * Workspace default path, launches the Tauri application through tauri-driver,
 * switches Files to Columns view, horizontally scrolls the Windows-style
 * virtual-root chain so a parent directory column from the fixture path is the
 * left visible column, clicks the next fixture directory in that left column,
 * and then immediately switches to Tree view and back to Columns view.
 *
 * Expected:
 * Selecting the left-column directory recenters the Columns window so the
 * clicked column's parent context is on the left, the clicked column itself is
 * in the middle, and the selected directory's contents column is visible on
 * the right while a backward slide animation is observed. Selecting a directory
 * in the right visible column then focuses that directory and shows its child
 * contents instead of leaving stale ancestor contents behind. The Columns
 * motion state must not trap the toolbar: switching to Tree view and back to
 * Columns view remains responsive after the recentering operation.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { test } from "vitest";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";

test("files columns left-column directory focus remains switchable", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("files-columns-left-focus");
  const fixture = await createFilesFixture();
  const fixtureHostId = "018f6eb3-6f91-7410-bc43-f927b2236da7";
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
    await activateFilesToolTab();
    await switchToColumnsView();
    await waitUntil(async () => {
      const measurement = await measureColumnsView();
      return measurement.visibleColumns.some((column) => column.rowNames.includes(fixture.rootName));
    }, pageSummary);
    await delay(800);

    const recentered = await scrollParentColumnToLeftAndClickFixtureDirectory();
    if (!recentered.clicked) {
      throw new Error(`Columns view did not expose the fixture directory in the left visible column\n${JSON.stringify(recentered, null, 2)}`);
    }
    if (!recentered.backwardMotionObserved) {
      throw new Error(`Columns view did not play the expected backward motion after clicking the left visible column\n${JSON.stringify(recentered, null, 2)}`);
    }

    await waitUntil(async () => {
      const measurement = await measureColumnsView();
      const middleColumn = measurement.visibleColumns.at(-2);
      const rightColumn = measurement.visibleColumns.at(-1);
      return measurement.visibleColumns.length >= 3 &&
        measurement.visibleColumns.at(-3)?.label === recentered.expectedLeftColumnLabel &&
        middleColumn?.label === recentered.columnLabel &&
        middleColumn?.rowNames.includes(recentered.clickedName) &&
        rightColumn?.label === recentered.clickedPath &&
        rightColumn?.rowNames.includes(recentered.focusedChildName);
    }, async () => {
      const screenshotPath = await saveScreenshot("files-columns-left-column-focus.png");
      const measurement = await measureColumnsView();
      return `Columns view did not recenter the clicked left-column directory\n${JSON.stringify({ recentered, measurement }, null, 2)}\nscreenshot: ${screenshotPath}`;
    });

    const rightColumnFocus = await clickRightVisibleColumnDirectory(recentered);
    if (!rightColumnFocus.clicked) {
      throw new Error(`Columns view did not expose the right-column fixture directory for clicking\n${JSON.stringify(rightColumnFocus, null, 2)}`);
    }
    await waitUntil(async () => {
      const measurement = await measureColumnsView();
      return measurement.visibleColumns.length >= 3 &&
        measurement.visibleColumns.at(-1)?.label === rightColumnFocus.clickedPath &&
        measurement.visibleColumns.at(-1)?.rowNames.includes(rightColumnFocus.focusedChildName);
    }, async () => {
      const screenshotPath = await saveScreenshot("files-columns-right-column-focus.png");
      const measurement = await measureColumnsView();
      return `Columns view did not focus and show contents for the clicked right-column directory\n${JSON.stringify({ rightColumnFocus, measurement }, null, 2)}\nscreenshot: ${screenshotPath}`;
    });

    const switchResult = await switchTreeAndColumns();
    if (!switchResult.ok) {
      const screenshotPath = await saveScreenshot("files-columns-left-column-view-switch.png");
      throw new Error(`${switchResult.reason}\n${JSON.stringify(switchResult, null, 2)}\nscreenshot: ${screenshotPath}`);
    }

    const driveRootFocus = await clickRootDriveAndMeasureContents();
    if (!driveRootFocus.clicked) {
      throw new Error(`Columns view did not expose the fixture drive in the root column\n${JSON.stringify(driveRootFocus, null, 2)}`);
    }
    await waitUntil(async () => {
      const measurement = await measureColumnsView();
      return measurement.visibleColumns.length >= 2 &&
        measurement.visibleColumns.at(-2)?.label === driveRootFocus.rootLabel &&
        measurement.visibleColumns.at(-1)?.label === driveRootFocus.driveLabel &&
        measurement.visibleColumns.at(-1)?.rowNames.includes(driveRootFocus.driveChildName);
    }, async () => {
      const screenshotPath = await saveScreenshot("files-columns-drive-root-focus.png");
      const measurement = await measureColumnsView();
      return `Columns view did not refresh the right column after clicking a drive/root entry\n${JSON.stringify({ driveRootFocus, measurement }, null, 2)}\nscreenshot: ${screenshotPath}`;
    });
  } finally {
    if (sessionId) {
      await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
    }
    stopProcess(tauriDriver);
    await devServer.close();
    await isolatedAppConfig.cleanup();
    await rm(fixture.parent, { recursive: true, force: true });
  }

  async function createFilesFixture() {
    const parent = await mkdtemp(join(tmpdir(), "nocturne-files-columns-left-parent-"));
    const root = join(parent, "focus-root");
    await mkdir(join(root, "alpha"), { recursive: true });
    await writeFile(join(root, "alpha", "leaf.txt"), "leaf content\n");
    await writeFile(join(root, "root-note.txt"), "root content\n");
    const columnsNavigationTarget = columnsNavigationTargetForPath(root);
    return {
      columnsNavigationTarget,
      parent,
      root,
      rootName: "focus-root",
    };
  }

  function columnsNavigationTargetForPath(targetPath) {
    const normalized = targetPath.replace(/\\/g, "/").replace(/\/+$/, "");
    const windowsMatch = normalized.match(/^([A-Za-z]:)\/(.+)$/);
    const segments = windowsMatch ? windowsMatch[2].split("/").filter(Boolean) : normalized.split("/").filter(Boolean);
    if (windowsMatch) {
      if (segments.length < 2) {
        throw new Error(`Fixture path must contain at least two segments below the drive root: ${normalized}`);
      }
      return {
        columnLabel: windowsMatch[1],
        clickedName: segments[0],
        clickedPath: `${windowsMatch[1]}/${segments[0]}`,
        expectedLeftColumnLabel: "/",
        focusedChildName: segments[1],
        focusedPath: `${windowsMatch[1]}/${segments[0]}/${segments[1]}`,
        nextFocusedChildName: segments[2],
      };
    }
    if (segments.length < 3) {
      throw new Error(`Fixture path must contain at least three segments below root: ${normalized}`);
    }
    return {
      columnLabel: "/",
      clickedName: segments[0],
      clickedPath: `/${segments[0]}`,
      expectedLeftColumnLabel: "/",
      focusedChildName: segments[1],
      focusedPath: `/${segments[0]}/${segments[1]}`,
      nextFocusedChildName: segments[2],
    };
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
      `version = 1\nid = "${fixtureHostId}"\nname = "Columns Left Focus Fixture"\nprotocol = "local"\n\n[files]\ndefault_path = ${JSON.stringify(fixture.root)}\n\n[local]\nargs = []\nenv = {}\n`,
    );
  }

  async function scrollParentColumnToLeftAndClickFixtureDirectory() {
    const fixtureNavigation = fixture.columnsNavigationTarget;
    return await executeAsync(`
      const done = arguments[arguments.length - 1];
      const target = ${JSON.stringify(fixtureNavigation)};
      const columnsView = document.querySelector('.columns-view');
      const currentPane = columnsView?.querySelector('.columns-pane.current') ?? columnsView;
      const canWriteScrollLeft = (element) => {
        if (!element || element.scrollWidth <= element.clientWidth + 4) return false;
        const original = element.scrollLeft;
        element.scrollLeft = Math.min(32, element.scrollWidth - element.clientWidth);
        const writable = element.scrollLeft > 0;
        element.scrollLeft = original;
        return writable;
      };
      const horizontalScrollTarget = () => {
        const candidates = [
          columnsView,
          ...(columnsView?.matches('[data-overlayscrollbars-viewport]') ? [] : [...(columnsView?.querySelectorAll('[data-overlayscrollbars-viewport]') ?? [])]),
          ...(columnsView ? [...columnsView.querySelectorAll('*')].filter((element) => element.scrollWidth > element.clientWidth + 4) : []),
        ].filter(Boolean);
        return candidates.find(canWriteScrollLeft) ?? null;
      };
      const scrollCandidateSummaries = () => {
        const candidates = [
          columnsView,
          ...(columnsView?.querySelectorAll('*') ?? []),
        ].filter(Boolean);
        return candidates.map((element) => ({
          tag: element.tagName,
          className: String(element.className ?? ''),
          role: element.getAttribute?.('role') ?? null,
          dataset: Object.fromEntries(Object.entries(element.dataset ?? {})),
          scrollLeft: element.scrollLeft,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          overflowX: getComputedStyle(element).overflowX,
        })).filter((item) =>
          item.scrollLeft !== 0 ||
          item.dataset.overlayscrollbarsViewport ||
          item.dataset.overlayscrollbars ||
          item.className.includes('columns-content') ||
          item.className.includes('columns-pane')
        );
      };
      const mapColumns = () => {
        const viewRect = columnsView?.getBoundingClientRect();
        return [...(currentPane?.querySelectorAll('.file-column') ?? [])].map((column, index) => {
        const rect = column.getBoundingClientRect();
        const visibleWidth = viewRect
          ? Math.max(0, Math.min(rect.right, viewRect.right) - Math.max(rect.left, viewRect.left))
          : 0;
        return {
          element: column,
          index,
          label: column.getAttribute('aria-label'),
          left: rect.left,
          right: rect.right,
          visibleWidth,
          rows: [...column.querySelectorAll('.column-row')].filter((row) => row.offsetParent !== null),
        };
      });
      };
      let columns = mapColumns();
      const targetColumn = columns.find((column) => column.label === target.columnLabel);
      const targetRow = targetColumn?.rows.find((row) =>
        row.getAttribute('data-entry-kind') === 'directory' &&
        row.querySelector('.name-cell')?.textContent?.trim() === target.clickedName
      );
      if (!targetColumn || !targetRow) {
        done({
          clicked: false,
          columns: columns.map((column) => ({
            index: column.index,
            label: column.label,
            rowNames: column.rows.map((row) => row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? ''),
          })),
        });
        return;
      }
      const clickedName = targetRow.querySelector('.name-cell')?.textContent?.trim() ?? '';
      const clickedPath = (targetRow.getAttribute('data-entry-path') ?? '').replace(/\\\\/g, '/').replace(/\\/+$/, '');
      const focusedChildName = target.focusedChildName;
      const focusedPath = target.focusedPath;
      const nextFocusedChildName = target.nextFocusedChildName;
      const started = performance.now();
      const waitVisible = () => {
        const scrollTarget = horizontalScrollTarget();
        const latestTargetColumn = mapColumns().find((column) => column.label === targetColumn.label) ?? targetColumn;
        const targetScrollLeft = Math.max(0, (scrollTarget?.scrollLeft ?? 0) + latestTargetColumn.left - (columnsView?.getBoundingClientRect().left ?? 0));
        if (scrollTarget) scrollTarget.scrollLeft = targetScrollLeft;
        columns = mapColumns();
        const visibleColumns = columns.filter((column) => column.visibleWidth >= 40);
        const visibleTarget = visibleColumns[0]?.label === targetColumn.label
          ? visibleColumns[0]
          : null;
        if (visibleTarget) {
          targetRow.click();
          const motionStarted = performance.now();
          const waitMotion = (observed = false) => {
            const content = document.querySelector('.columns-view .columns-content');
            const className = String(content?.className ?? '');
            const nextObserved = observed || className.includes('motion-backward') || className.includes('motion-active') || className.includes('motion-preparing');
            if (nextObserved || performance.now() - motionStarted > 1400) {
              done({
                clicked: true,
                clickedName,
                clickedPath,
                focusedChildName,
                focusedPath,
                nextFocusedChildName,
                columnIndex: targetColumn.index,
                columnLabel: targetColumn.label,
                expectedLeftColumnLabel: target.expectedLeftColumnLabel,
                backwardMotionObserved: nextObserved,
                motionClassName: className,
                visibleLabelsBeforeClick: visibleColumns.map((column) => column.label),
              });
              return;
            }
            requestAnimationFrame(() => waitMotion(nextObserved));
          };
          requestAnimationFrame(() => waitMotion(false));
          return;
        }
        if (performance.now() - started > 8000) {
          done({
            clicked: false,
            reason: 'Fixture parent column did not become the left visible column before click',
            targetScrollLeft: scrollTarget ? scrollTarget.scrollLeft : null,
            scrollLefts: scrollTarget ? [scrollTarget.scrollLeft] : [],
            scrollTarget: scrollTarget ? {
              className: scrollTarget.className,
              scrollWidth: scrollTarget.scrollWidth,
              clientWidth: scrollTarget.clientWidth,
            } : null,
            scrollCandidates: scrollCandidateSummaries(),
            visibleColumns: visibleColumns.map((column) => ({
              index: column.index,
              label: column.label,
              visibleWidth: column.visibleWidth,
            })),
          });
          return;
        }
        requestAnimationFrame(waitVisible);
      };
      requestAnimationFrame(waitVisible);
    `);
  }

  async function clickRootDriveAndMeasureContents() {
    const target = fixture.columnsNavigationTarget;
    return await executeAsync(`
      const done = arguments[arguments.length - 1];
      const target = ${JSON.stringify(target)};
      const columnsView = document.querySelector('.columns-view');
      const currentPane = columnsView?.querySelector('.columns-pane.current') ?? columnsView;
      const rootColumn = [...(currentPane?.querySelectorAll('.file-column') ?? [])].find((column) => column.getAttribute('aria-label') === target.expectedLeftColumnLabel);
      const driveRow = [...(rootColumn?.querySelectorAll('.column-row') ?? [])].find((row) =>
        row.getAttribute('data-entry-kind') === 'directory' &&
        row.querySelector('.name-cell')?.textContent?.trim() === target.columnLabel
      );
      if (!rootColumn || !driveRow) {
        done({
          clicked: false,
          target,
          columns: [...(currentPane?.querySelectorAll('.file-column') ?? [])].map((column) => ({
            label: column.getAttribute('aria-label'),
            rowNames: [...column.querySelectorAll('.column-row')].map((row) => row.querySelector('.name-cell')?.textContent?.trim() ?? ''),
          })),
        });
        return;
      }
      driveRow.click();
      done({
        clicked: true,
        rootLabel: target.expectedLeftColumnLabel,
        driveLabel: target.columnLabel,
        driveChildName: target.clickedName,
      });
    `);
  }

  async function clickRightVisibleColumnDirectory(recentered) {
    const target = {
      columnLabel: recentered.clickedPath,
      clickedName: recentered.focusedChildName,
      focusedPath: recentered.focusedPath,
      focusedChildName: recentered.nextFocusedChildName,
    };
    return await executeAsync(`
      const done = arguments[arguments.length - 1];
      const target = ${JSON.stringify(target)};
      const columnsView = document.querySelector('.columns-view');
      const currentPane = columnsView?.querySelector('.columns-pane.current') ?? columnsView;
      const viewRect = columnsView?.getBoundingClientRect();
      const columns = [...(currentPane?.querySelectorAll('.file-column') ?? [])].map((column) => {
        const rect = column.getBoundingClientRect();
        const visibleWidth = viewRect
          ? Math.max(0, Math.min(rect.right, viewRect.right) - Math.max(rect.left, viewRect.left))
          : 0;
        return {
          element: column,
          label: column.getAttribute('aria-label'),
          visibleWidth,
          rows: [...column.querySelectorAll('.column-row')].filter((row) => row.offsetParent !== null),
        };
      });
      const targetColumn = columns.find((column) => column.label === target.columnLabel && column.visibleWidth >= 40);
      const targetRow = targetColumn?.rows.find((row) =>
        row.getAttribute('data-entry-kind') === 'directory' &&
        row.querySelector('.name-cell')?.textContent?.trim() === target.clickedName
      );
      if (!targetColumn || !targetRow) {
        done({
          clicked: false,
          target,
          columns: columns.map((column) => ({
            label: column.label,
            visibleWidth: column.visibleWidth,
            rowNames: column.rows.map((row) => row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? ''),
          })),
        });
        return;
      }
      const clickedPath = (targetRow.getAttribute('data-entry-path') ?? '').replace(/\\\\/g, '/').replace(/\\/+$/, '');
      targetRow.click();
      done({
        clicked: true,
        clickedName: target.clickedName,
        clickedPath,
        focusedPath: target.focusedPath,
        focusedChildName: target.focusedChildName,
      });
    `);
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
    await waitUntil(async () => await execute("return document.querySelector('.files-tooltab .files-toolbar') !== null;"), pageSummary);
  }

  async function switchToColumnsView() {
    await waitUntil(async () => await execute("return document.querySelector('.files-toolbar button[aria-label=\"Columns view\"]') !== null;"), pageSummary);
    await execute(`
      const button = document.querySelector('.files-toolbar button[aria-label="Columns view"]');
      if (!button) throw new Error('Columns view button missing');
      button.click();
      return true;
    `);
  }

  async function measureColumnsView() {
    return await execute(`
      const columnsView = document.querySelector('.columns-view');
      if (!columnsView) return { ok: false, reason: 'Columns view missing', columns: [], visibleColumns: [] };
      const currentPane = columnsView.querySelector('.columns-pane.current') ?? columnsView;
      const viewRect = columnsView.getBoundingClientRect();
      const columns = [...currentPane.querySelectorAll('.file-column')].map((column) => {
        const rect = column.getBoundingClientRect();
        const visibleWidth = Math.max(0, Math.min(rect.right, viewRect.right) - Math.max(rect.left, viewRect.left));
        const rows = [...column.querySelectorAll('.column-row')].filter((row) => row.offsetParent !== null);
        const rowNames = rows.map((row) => row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? '');
        return {
          label: column.getAttribute('aria-label'),
          left: rect.left,
          right: rect.right,
          visibleWidth,
          rowNames,
        };
      });
      return {
        ok: true,
        scrollLeft: columnsView.scrollLeft,
        columns,
        visibleColumns: columns.filter((column) => column.visibleWidth >= 40),
      };
    `);
  }

  async function switchTreeAndColumns() {
    return await executeAsync(`
      const done = arguments[arguments.length - 1];
      const treeButton = document.querySelector('.files-toolbar button[aria-label="Tree view"]');
      const columnsButton = document.querySelector('.files-toolbar button[aria-label="Columns view"]');
      if (!treeButton || !columnsButton) {
        done({ ok: false, reason: 'View mode buttons missing' });
        return;
      }
      treeButton.click();
      const started = performance.now();
      const waitTree = () => {
        if (document.querySelector('.files-table')) {
          columnsButton.click();
          waitColumns();
          return;
        }
        if (performance.now() - started > 8000) {
          done({ ok: false, reason: 'Tree view did not appear after clicking its toolbar button', text: document.body.innerText.slice(0, 1000) });
          return;
        }
        setTimeout(waitTree, 80);
      };
      const waitColumns = () => {
        if (document.querySelector('.columns-view')) {
          done({ ok: true });
          return;
        }
        if (performance.now() - started > 12000) {
          done({ ok: false, reason: 'Columns view did not reappear after clicking its toolbar button', text: document.body.innerText.slice(0, 1000) });
          return;
        }
        setTimeout(waitColumns, 80);
      };
      waitTree();
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
        bodyText: document.body?.innerText?.slice(0, 1000) ?? '',
        columnsViewExists: document.querySelector('.columns-view') !== null,
        filesToolbarExists: document.querySelector('.files-tooltab .files-toolbar') !== null,
        filesText: document.querySelector('.files-tooltab')?.textContent?.slice(0, 1000) ?? '',
      };
    `).then((summary) => JSON.stringify(summary, null, 2));
  }

  function stopProcess(child) {
    if (!child.pid || child.exitCode !== null) return;
    child.kill();
  }
});
