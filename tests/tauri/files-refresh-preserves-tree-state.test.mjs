#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies that refreshing a Files ToolTab keeps the current browse path, Tree
 * expansion state, selected file, visible preview, and Tree scroll position in
 * a real Tauri WebView. It also verifies that unrelated Workspace layout
 * updates do not remount the visible Files ToolTab.
 *
 * Operation:
 * Creates a temporary local file fixture with nested alpha and beta
 * directories and a previewable leaf.txt file, configures a temporary Local
 * Host as the default Workspace host, launches the Tauri application through
 * tauri-driver, expands alpha and beta in Tree view, selects leaf.txt, clicks
 * scrolls the Tree, clicks the Files Refresh toolbar action, samples the Files
 * DOM during refresh, closes the default Resource Monitor ToolTab to trigger a
 * Workspace snapshot update, and inspects the settled Tree and preview state.
 *
 * Expected:
 * Refresh does not replace the populated Files view with a Loading-only status,
 * the address path remains on the current focus directory, alpha and beta stay
 * expanded, leaf.txt remains selected, the preview panel stays visible, the
 * Tree scroll anchor remains stable, and the Files ToolTab DOM instance stays
 * mounted after unrelated Workspace layout updates.
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

test("files refresh preserves tree state", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("files-refresh-tree-state");
  const fixtureRoot = await createFilesFixture();
  const fixtureRootName = pathBasename(fixtureRoot);
  const alphaPath = join(fixtureRoot, "alpha");
  const betaPath = join(fixtureRoot, "alpha", "beta");
  const leafPath = join(fixtureRoot, "alpha", "beta", "leaf.txt");
  const leafParentPath = join(fixtureRoot, "alpha", "beta");
  const fixtureHostId = "018f6eb3-6f91-7410-bc43-f927b2236d95";
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
    await waitUntil(async () => await execute("return document.querySelector('.files-tooltab .files-toolbar') !== null;"), pageSummary);
    await waitUntil(async () => {
      const state = await treeState();
      return normalizeTestPath(state.addressPath) === normalizeTestPath(fixtureRoot) && state.rows.some((row) => sameTestPath(row.path, fixtureRoot));
    }, pageSummary);

    await ensureTreePathExpanded(fixtureRoot);
    await waitUntil(async () => {
      const state = await treeState();
      return state.rows.some((row) => sameTestPath(row.path, alphaPath));
    }, pageSummary);

    await ensureTreePathExpanded(alphaPath);
    await waitUntil(async () => {
      const state = await treeState();
      return state.rows.some((row) => sameTestPath(row.path, betaPath));
    }, pageSummary);

    await ensureTreePathExpanded(betaPath);
    await waitUntil(async () => {
      const state = await treeState();
      return state.rows.some((row) => sameTestPath(row.path, leafPath));
    }, pageSummary);

    await clickTreeRow(leafPath);
    await waitUntil(async () => {
      const state = await treeState();
      return state.selectedRows.some((row) => sameTestPath(row.path, leafPath)) && state.previewVisible;
    }, pageSummary);

    const scrolled = await scrollTreeToRow("branch-38");
    if (!scrolled.ok) {
      throw new Error(`Tree did not scroll to branch-38 before refresh\n${JSON.stringify(scrolled, null, 2)}`);
    }

    const refresh = await captureRefreshState();
    if (!refresh.ok) {
      const screenshotPath = await saveScreenshot("files-refresh-lost-tree-state.png");
      throw new Error(`${refresh.reason}\n${JSON.stringify(refresh, null, 2)}\nscreenshot: ${screenshotPath}`);
    }

    const workspaceUpdate = await captureWorkspaceUpdateState();
    if (!workspaceUpdate.ok) {
      const screenshotPath = await saveScreenshot("files-workspace-update-lost-tree-state.png");
      throw new Error(`${workspaceUpdate.reason}\n${JSON.stringify(workspaceUpdate, null, 2)}\nscreenshot: ${screenshotPath}`);
    }

    console.log(
      `tauri files refresh preserves tree state test passed\n${JSON.stringify(
        {
          addressPath: refresh.final.addressPath,
          expandedRows: refresh.final.expandedRows,
          selectedRows: refresh.final.selectedRows,
          previewVisible: refresh.final.previewVisible,
          treeScrollAnchor: refresh.final.treeScrollAnchor,
          workspaceUpdateTreeScrollAnchor: workspaceUpdate.final.treeScrollAnchor,
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
    for (let index = 0; index < 64; index += 1) {
      const name = `branch-${String(index).padStart(2, "0")}`;
      await mkdir(join(root, name), { recursive: true });
      await writeFile(join(root, name, "note.txt"), `${name} content\n`);
    }
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

  async function clickTreeRow(path) {
    const target = await execute(`
      const rows = [...document.querySelectorAll('.files-row[data-file-entry="true"]')];
      const row = rows.find((item) => samePath(item.getAttribute('data-entry-path') ?? '', ${JSON.stringify(path)}));
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
      row.scrollIntoView({ block: 'center', inline: 'nearest' });
      void row.getBoundingClientRect();
      const rect = row.getBoundingClientRect();
      return {
        found: true,
        x: Math.round(rect.left + Math.min(24, rect.width / 2)),
        y: Math.round(rect.top + rect.height / 2),
        text: row.textContent?.trim() ?? '',
        path: row.getAttribute('data-entry-path'),
      };

      function samePath(left, right) {
        return left.replace(/\\\\/g, '/').replace(/\\/+$/, '') === right.replace(/\\\\/g, '/').replace(/\\/+$/, '');
      }
    `);
    if (!target.found) {
      throw new Error(`Tree view did not contain ${path}: ${JSON.stringify(target, null, 2)}`);
    }
    await pointerClick(target.x, target.y);
  }

  async function clickTreeRowBody(path) {
    const target = await executeAsync(`
      const done = arguments[arguments.length - 1];
      const rows = [...document.querySelectorAll('.files-row[data-file-entry="true"]')];
      const row = rows.find((item) => samePath(item.getAttribute('data-entry-path') ?? '', ${JSON.stringify(path)}));
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
      if (row.getAttribute('aria-expanded') === 'true') {
        done({
          found: true,
          alreadyExpanded: true,
          text: row.textContent?.trim() ?? '',
          expanded: row.getAttribute('aria-expanded'),
          path: row.getAttribute('data-entry-path'),
        });
        return;
      }
      const rect = row.getBoundingClientRect();
      const nameCell = row.querySelector('.name-cell');
      const nameRect = nameCell?.getBoundingClientRect();
      const x = Math.round(Math.min(rect.right - 8, Math.max(rect.left + 28, (nameRect?.left ?? rect.left) + Math.min(48, (nameRect?.width ?? rect.width) / 2))));
      const y = Math.round(rect.top + rect.height / 2);
      row.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        button: 0,
      }));
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

      function samePath(left, right) {
        return left.replace(/\\\\/g, '/').replace(/\\/+$/, '') === right.replace(/\\\\/g, '/').replace(/\\/+$/, '');
      }
    `);
    if (!target.found) {
      throw new Error(`Tree view did not contain expandable directory ${path}: ${JSON.stringify(target, null, 2)}`);
    }
    return target;
  }

  async function ensureTreePathExpanded(path) {
    const state = await treeState();
    const row = state.rows.find((candidate) => sameTestPath(candidate.path, path));
    if (!row) {
      throw new Error(`Tree view did not contain expandable directory ${path}: ${await pageSummary()}`);
    }
    if (row.expanded === "true") return;
    await clickTreeRowBody(path);
  }

  async function captureRefreshState() {
    return await executeAsync(`
      const done = arguments[arguments.length - 1];
      const refreshButton = document.querySelector('.files-toolbar button[aria-label="Refresh"]');
      if (!refreshButton) {
        done({ ok: false, reason: 'Refresh toolbar button missing' });
        return;
      }

      ensureFilesInstanceMarker();
      const beforeInstanceId = document.querySelector('.files-tooltab')?.getAttribute('data-test-instance-id') ?? null;
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
          filesInstanceId: files?.getAttribute('data-test-instance-id') ?? null,
          loadingOnly: document.querySelector('.files-status')?.textContent?.trim() === 'Loading...',
          addressPath: document.querySelector('.path-field')?.textContent?.trim() ?? '',
          filesText: files?.textContent?.slice(0, 300) ?? '',
          rowCount: rows.length,
          rows,
          expandedRows: rows.filter((row) => row.expanded === 'true').map((row) => row.name),
          selectedRows: rows.filter((row) => row.selected).map((row) => row.name),
          treeScrollTop: treeScrollTop(),
          treeScrollAnchor: firstVisibleTreeRowName(),
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
        const remountedFrame = samples.find((item) => item.filesInstanceId !== beforeInstanceId);
        const scrollResetFrame = samples.find((item) =>
          item.treeScrollTop < 8 ||
          item.treeScrollAnchor === 'alpha' ||
          item.treeScrollAnchor === ${JSON.stringify(fixtureRootName)}
        );
        const final = samples[samples.length - 1];
        const finalKeepsState = normalizePath(final.addressPath) === normalizePath(${JSON.stringify(leafParentPath)}) &&
          final.rows.some((row) => row.name.includes('alpha') && row.expanded === 'true') &&
          final.rows.some((row) => row.name.includes('beta') && row.expanded === 'true') &&
          final.rows.some((row) => row.name.includes('leaf.txt') && row.selected) &&
          final.treeScrollTop > 8 &&
          final.treeScrollAnchor !== 'alpha' &&
          final.treeScrollAnchor !== ${JSON.stringify(fixtureRootName)} &&
          final.previewVisible;

        done({
          ok: !loadingOnlyFrame && !emptyRowsFrame && !remountedFrame && !scrollResetFrame && finalKeepsState,
          reason: loadingOnlyFrame
            ? 'Refresh flashed a Loading-only Files status'
            : emptyRowsFrame
              ? 'Refresh produced an empty Tree frame'
              : remountedFrame
                ? 'Refresh remounted the Files ToolTab'
                : scrollResetFrame
                  ? 'Refresh reset the Tree scroll position'
              : !finalKeepsState
                ? 'Refresh did not preserve path, expansion, selected file, and preview state'
                : '',
          sampleCount: samples.length,
          loadingOnlyFrame: loadingOnlyFrame ?? null,
          emptyRowsFrame: emptyRowsFrame ?? null,
          remountedFrame: remountedFrame ?? null,
          scrollResetFrame: scrollResetFrame ?? null,
          first: samples[0],
          middle: samples[Math.floor(samples.length / 2)],
          final,
          samples: samples.slice(0, 8).concat(samples.slice(-8)),
        });
      };

        requestAnimationFrame(capture);

        function normalizePath(value) {
          return value.replace(/\\\\/g, '/').replace(/\\/+$/, '');
        }

        function ensureFilesInstanceMarker() {
          const files = document.querySelector('.files-tooltab');
          if (!files) return;
          if (!files.getAttribute('data-test-instance-id')) {
            files.setAttribute('data-test-instance-id', String(Math.random()));
          }
        }

        function treeViewport() {
          const table = document.querySelector('.files-table');
          if (!table) return null;
          if (table.matches('[data-overlayscrollbars-viewport]')) return table;
          return table.querySelector('[data-overlayscrollbars-viewport]') ?? table;
        }

        function treeScrollTop() {
          return treeViewport()?.scrollTop ?? 0;
        }

        function firstVisibleTreeRowName() {
          const table = document.querySelector('.files-table');
          const tableRect = table?.getBoundingClientRect();
          if (!tableRect) return '';
          const rows = [...document.querySelectorAll('.files-row[data-file-entry="true"]:not(.sticky-row)')];
          const row = rows.find((item) => {
            const rect = item.getBoundingClientRect();
            return rect.bottom > tableRect.top + 30 && rect.top < tableRect.bottom - 4;
          });
          return row?.querySelector('.name-cell')?.textContent?.trim() ?? row?.textContent?.trim() ?? '';
        }
    `);
  }

  async function captureWorkspaceUpdateState() {
    return await executeAsync(`
      const done = arguments[arguments.length - 1];
      const files = document.querySelector('.files-tooltab');
      if (!files) {
        done({ ok: false, reason: 'Files ToolTab missing before Workspace update' });
        return;
      }
      if (!files.getAttribute('data-test-instance-id')) {
        files.setAttribute('data-test-instance-id', String(Math.random()));
      }
      const beforeInstanceId = files.getAttribute('data-test-instance-id');
      const resourceSlot = document.querySelector('[data-tool-kind="resources"]');
      if (!resourceSlot) {
        done({ ok: false, reason: 'Resource Monitor ToolTab missing before Workspace update' });
        return;
      }
      if (!resourceSlot.classList.contains('active')) resourceSlot.click();
      awaitFrame(() => {
        const closeButton = document.querySelector('.tool-tab.active[data-tool-kind="resources"] .tool-close');
        if (!closeButton) {
          done({ ok: false, reason: 'Resource Monitor close button missing before Workspace update' });
          return;
        }

        const samples = [];
        const started = performance.now();
        const sample = () => {
          const nextFiles = document.querySelector('.files-tooltab');
          const rows = [...document.querySelectorAll('.files-row[data-file-entry="true"]')].map((row) => {
            const name = row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? '';
            return {
              name,
              selected: row.classList.contains('selected'),
              expanded: row.getAttribute('aria-expanded'),
            };
          });
          samples.push({
            elapsed: performance.now() - started,
            filesMounted: Boolean(nextFiles),
            filesInstanceId: nextFiles?.getAttribute('data-test-instance-id') ?? null,
            resourceVisible: document.querySelector('[data-tool-kind="resources"]') !== null,
            addressPath: document.querySelector('.path-field')?.textContent?.trim() ?? '',
            rowCount: rows.length,
            rows,
            expandedRows: rows.filter((row) => row.expanded === 'true').map((row) => row.name),
            selectedRows: rows.filter((row) => row.selected).map((row) => row.name),
            treeScrollTop: treeScrollTop(),
            treeScrollAnchor: firstVisibleTreeRowName(),
            previewVisible: document.querySelector('.tree-preview[aria-label="Preview"]') !== null,
          });
        };

        sample();
        closeButton.click();
        const capture = () => {
          sample();
          if (performance.now() - started < 900) {
            requestAnimationFrame(capture);
            return;
          }

          const unmountedFrame = samples.find((item) => !item.filesMounted);
          const remountedFrame = samples.find((item) => item.filesInstanceId !== beforeInstanceId);
          const scrollResetFrame = samples.find((item) =>
            item.treeScrollTop < 8 ||
            item.treeScrollAnchor === 'alpha' ||
            item.treeScrollAnchor === ${JSON.stringify(fixtureRootName)}
          );
          const final = samples[samples.length - 1];
          const finalKeepsState = normalizePath(final.addressPath) === normalizePath(${JSON.stringify(leafParentPath)}) &&
            final.rows.some((row) => row.name.includes('alpha') && row.expanded === 'true') &&
            final.rows.some((row) => row.name.includes('beta') && row.expanded === 'true') &&
            final.rows.some((row) => row.name.includes('leaf.txt') && row.selected) &&
            final.treeScrollTop > 8 &&
            final.treeScrollAnchor !== 'alpha' &&
            final.treeScrollAnchor !== ${JSON.stringify(fixtureRootName)} &&
            final.previewVisible &&
            !final.resourceVisible;

          done({
            ok: !unmountedFrame && !remountedFrame && !scrollResetFrame && finalKeepsState,
            reason: unmountedFrame
              ? 'Workspace update unmounted the visible Files ToolTab'
              : remountedFrame
                ? 'Workspace update remounted the visible Files ToolTab'
                : scrollResetFrame
                  ? 'Workspace update reset the Tree scroll position'
                  : !finalKeepsState
                    ? 'Workspace update did not preserve Files path, expansion, selected file, preview, and scroll state'
                    : '',
            beforeInstanceId,
            sampleCount: samples.length,
            unmountedFrame: unmountedFrame ?? null,
            remountedFrame: remountedFrame ?? null,
            scrollResetFrame: scrollResetFrame ?? null,
            first: samples[0],
            middle: samples[Math.floor(samples.length / 2)],
            final,
            samples: samples.slice(0, 8).concat(samples.slice(-8)),
          });
        };
        requestAnimationFrame(capture);
      });

      function awaitFrame(callback) {
        requestAnimationFrame(() => requestAnimationFrame(callback));
      }

      function normalizePath(value) {
        return value.replace(/\\\\/g, '/').replace(/\\/+$/, '');
      }

      function treeViewport() {
        const table = document.querySelector('.files-table');
        if (!table) return null;
        if (table.matches('[data-overlayscrollbars-viewport]')) return table;
        return table.querySelector('[data-overlayscrollbars-viewport]') ?? table;
      }

      function treeScrollTop() {
        return treeViewport()?.scrollTop ?? 0;
      }

      function firstVisibleTreeRowName() {
        const table = document.querySelector('.files-table');
        const tableRect = table?.getBoundingClientRect();
        if (!tableRect) return '';
        const rows = [...document.querySelectorAll('.files-row[data-file-entry="true"]:not(.sticky-row)')];
        const row = rows.find((item) => {
          const rect = item.getBoundingClientRect();
          return rect.bottom > tableRect.top + 30 && rect.top < tableRect.bottom - 4;
        });
        return row?.querySelector('.name-cell')?.textContent?.trim() ?? row?.textContent?.trim() ?? '';
      }
    `);
  }

  async function scrollTreeToRow(name) {
    return await execute(`
      const table = document.querySelector('.files-table');
      const viewport = table?.matches('[data-overlayscrollbars-viewport]')
        ? table
        : table?.querySelector('[data-overlayscrollbars-viewport]') ?? table;
      const rows = [...document.querySelectorAll('.files-row[data-file-entry="true"]:not(.sticky-row)')];
      const row = rows.find((item) =>
        item.querySelector('.name-cell')?.textContent?.trim().includes(${JSON.stringify(name)})
      );
      if (!table || !viewport || !row) {
        return {
          ok: false,
          reason: 'Tree row or viewport missing',
          hasTable: Boolean(table),
          hasViewport: Boolean(viewport),
          rows: rows.map((item) => item.querySelector('.name-cell')?.textContent?.trim() ?? item.textContent?.trim() ?? '').slice(0, 80),
        };
      }
      row.scrollIntoView({ block: 'center', inline: 'nearest' });
      return {
        ok: viewport.scrollTop > 8,
        scrollTop: viewport.scrollTop,
        target: row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? '',
      };
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

  function normalizeTestPath(value) {
    return value.replace(/\\/g, "/").replace(/\/+$/, "");
  }

  function sameTestPath(left, right) {
    return normalizeTestPath(left) === normalizeTestPath(right);
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

});
