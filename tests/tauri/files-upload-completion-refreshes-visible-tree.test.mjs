#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies that a completed upload transfer actively refreshes the visible
 * Files Tree without remounting the Files ToolTab or losing current view-local
 * state.
 *
 * Operation:
 * Creates isolated local source and destination fixtures, launches the real
 * Tauri application through tauri-driver, expands the destination Tree,
 * selects an existing file, scrolls the Tree, creates a local-to-local upload
 * transfer through the Tauri command API, waits for the transfer to complete,
 * activates the Transfers ToolTab, and inspects the Files Tree and Transfers
 * table.
 *
 * Expected:
 * The newly uploaded file appears in the expanded destination directory without
 * a manual Files refresh, the Files ToolTab DOM instance remains mounted, the
 * selected file remains selected, the expanded directory remains open, the
 * Tree scroll position is not reset, and Transfers is rendered as a visible
 * table with the completed
 * task row.
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

test("files upload completion refreshes visible tree", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("files-upload-completion-refresh");
  const fixtureRoot = await createDestinationFixture();
  const fixtureRootName = pathBasename(fixtureRoot);
  const uploadSourceRoot = await mkdtemp(join(tmpdir(), "nocturne-upload-source-"));
  const uploadSourcePath = join(uploadSourceRoot, "uploaded-from-transfer.txt");
  const uploadDestinationPath = join(fixtureRoot, "alpha", "uploaded-from-transfer.txt");
  const alphaPath = join(fixtureRoot, "alpha");
  const selectedExistingPath = join(fixtureRoot, "alpha", "existing.txt");
  const fixtureHostId = "018f6eb3-6f91-7410-bc43-f927b2236d96";
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
  await writeFile(uploadSourcePath, "uploaded content\n");
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
    await waitUntil(async () => (await treeState()).rows.some((row) => sameTestPath(row.path, alphaPath)), pageSummary);
    await ensureTreePathExpanded(alphaPath);
    await waitUntil(async () => (await treeState()).rows.some((row) => sameTestPath(row.path, selectedExistingPath)), pageSummary);
    await clickTreeRow(selectedExistingPath);
    await waitUntil(async () => {
      const state = await treeState();
      return state.selectedRows.some((name) => name.includes("existing.txt"));
    }, pageSummary);
    const scrolled = await scrollTreeToRow("branch-32");
    if (!scrolled.ok) {
      throw new Error(`Tree did not scroll before upload completion\n${JSON.stringify(scrolled, null, 2)}`);
    }

    const upload = await createUploadTransfer();
    if (!upload.ok) {
      throw new Error(`Failed to create upload transfer\n${JSON.stringify(upload, null, 2)}`);
    }

    const completion = await waitForUploadCompletionRefresh();
    if (!completion.ok) {
      const screenshotPath = await saveScreenshot("files-upload-completion-refresh-failed.png");
      throw new Error(`${completion.reason}\n${JSON.stringify(completion, null, 2)}\nscreenshot: ${screenshotPath}`);
    }

    await activateToolTab("Transfers");
    await waitUntil(async () => (await transfersTableState()).ok, transferSummary, 15_000);
    const transfersTable = await transfersTableState();
    if (!transfersTable.ok) {
      const screenshotPath = await saveScreenshot("transfers-table-missing-after-upload.png");
      throw new Error(`Transfers table did not show the completed upload\n${JSON.stringify(transfersTable, null, 2)}\nscreenshot: ${screenshotPath}`);
    }

    console.log(
      `tauri files upload completion refresh test passed\n${JSON.stringify(
        {
          uploadedVisible: completion.final.rows.some((row) => row.name.includes("uploaded-from-transfer.txt")),
          selectedRows: completion.final.selectedRows,
          treeScrollAnchor: completion.final.treeScrollAnchor,
          transferRows: transfersTable.rows,
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
    await rm(uploadSourceRoot, { recursive: true, force: true });
  }

  async function createDestinationFixture() {
    const root = await mkdtemp(join(tmpdir(), "nocturne-files-upload-refresh-"));
    await mkdir(join(root, "alpha"), { recursive: true });
    await writeFile(join(root, "alpha", "existing.txt"), "existing content\n");
    for (let index = 0; index < 48; index += 1) {
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
      `version = 1\nid = "${fixtureHostId}"\nname = "Upload Refresh Fixture"\nprotocol = "local"\n\n[files]\ndefault_path = ${JSON.stringify(fixtureRoot)}\n\n[local]\nargs = []\nenv = {}\n`,
    );
  }

  async function createUploadTransfer() {
    return await executeAsync(`
      const done = arguments[arguments.length - 1];
      const invoke = window.__TAURI_INTERNALS__?.invoke;
      if (!invoke) {
        done({ ok: false, reason: 'Tauri invoke API missing' });
        return;
      }
      invoke('create_transfer_task', {
        input: {
          source: {
            kind: 'local',
            provider_kind: null,
            host_id: null,
            path: ${JSON.stringify(uploadSourcePath)},
          },
          destination: {
            kind: 'provider',
            provider_kind: 'local',
            host_id: ${JSON.stringify(fixtureHostId)},
            path: ${JSON.stringify(uploadDestinationPath)},
          },
          initiator_workspace_id: document.querySelector('.workspace-tab.active')?.getAttribute('data-workspace-id') ?? null,
          related_workspace_ids: [document.querySelector('.workspace-tab.active')?.getAttribute('data-workspace-id') ?? ''],
        },
      }).then((snapshot) => {
        done({ ok: true, snapshot });
      }).catch((error) => {
        done({
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
          error,
        });
      });
    `);
  }

  async function waitForUploadCompletionRefresh() {
    return await executeAsync(`
      const done = arguments[arguments.length - 1];
      const files = document.querySelector('.files-tooltab');
      if (!files) {
        done({ ok: false, reason: 'Files ToolTab missing before transfer completion' });
        return;
      }
      if (!files.getAttribute('data-test-instance-id')) {
        files.setAttribute('data-test-instance-id', String(Math.random()));
      }
      const beforeInstanceId = files.getAttribute('data-test-instance-id');
      const samples = [];
      const started = performance.now();
      const sample = async () => {
        const invoke = window.__TAURI_INTERNALS__?.invoke;
        let queue = null;
        if (invoke) {
          queue = await invoke('get_transfer_queue_snapshot').catch((error) => ({ error: String(error) }));
        }
        const rows = [...document.querySelectorAll('.files-row[data-file-entry="true"]')].map((row) => {
          const name = row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? '';
          return {
            name,
            selected: row.classList.contains('selected'),
            expanded: row.getAttribute('aria-expanded'),
          };
        });
        return {
          elapsed: performance.now() - started,
          filesInstanceId: document.querySelector('.files-tooltab')?.getAttribute('data-test-instance-id') ?? null,
          addressPath: document.querySelector('.path-field')?.textContent?.trim() ?? '',
          rows,
          expandedRows: rows.filter((row) => row.expanded === 'true').map((row) => row.name),
          selectedRows: rows.filter((row) => row.selected).map((row) => row.name),
          treeScrollTop: treeScrollTop(),
          treeScrollAnchor: firstVisibleTreeRowName(),
          queue,
        };
      };

      const capture = async () => {
        samples.push(await sample());
        const final = samples[samples.length - 1];
        const uploadedVisible = final.rows.some((row) => row.name.includes('uploaded-from-transfer.txt'));
        const completed = final.queue?.tasks?.some((task) =>
          task.destination?.path === ${JSON.stringify(uploadDestinationPath)} && task.status === 'completed'
        );
        if (uploadedVisible && completed) {
          const remountedFrame = samples.find((item) => item.filesInstanceId !== beforeInstanceId);
          const scrollResetFrame = samples.find((item) =>
            item.treeScrollTop < 8 ||
            item.treeScrollAnchor === 'alpha' ||
            item.treeScrollAnchor === ${JSON.stringify(fixtureRootName)}
          );
          const keepsState = normalizePath(final.addressPath) === normalizePath(${JSON.stringify(alphaPath)}) &&
            final.rows.some((row) => row.name.includes('alpha') && row.expanded === 'true') &&
            final.rows.some((row) => row.name.includes('existing.txt') && row.selected) &&
            final.treeScrollTop > 8 &&
            final.treeScrollAnchor !== 'alpha' &&
            final.treeScrollAnchor !== ${JSON.stringify(fixtureRootName)};
          done({
            ok: !remountedFrame && !scrollResetFrame && keepsState,
            reason: remountedFrame
              ? 'Upload completion remounted the Files ToolTab'
              : scrollResetFrame
                ? 'Upload completion reset Tree scroll position'
                : !keepsState
                  ? 'Upload completion did not preserve Files expanded, selected, address, and scroll state'
                  : '',
            beforeInstanceId,
            remountedFrame: remountedFrame ?? null,
            scrollResetFrame: scrollResetFrame ?? null,
            sampleCount: samples.length,
            final,
            samples: samples.slice(0, 8).concat(samples.slice(-8)),
          });
          return;
        }
        if (performance.now() - started > 20_000) {
          done({
            ok: false,
            reason: 'Uploaded file did not appear after transfer completion',
            beforeInstanceId,
            sampleCount: samples.length,
            final,
            samples: samples.slice(0, 8).concat(samples.slice(-8)),
          });
          return;
        }
        setTimeout(capture, 150);
      };
      void capture();

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

  async function transfersTableState() {
    return await execute(`
      const table = document.querySelector('[data-testid="transfers-table"]');
      const rows = [...document.querySelectorAll('[data-testid="transfer-row"]')].map((row) => row.textContent?.trim() ?? '');
      return {
        ok: Boolean(table) && rows.some((row) => row.includes('uploaded-from-transfer.txt') && row.toLowerCase().includes('completed')),
        hasTable: Boolean(table),
        headers: [...document.querySelectorAll('[data-testid="transfers-table"] th')].map((cell) => cell.textContent?.trim() ?? ''),
        rows,
      };
    `);
  }

  async function transferSummary() {
    return await execute(`
      const invoke = window.__TAURI_INTERNALS__?.invoke;
      const queue = invoke ? await invoke('get_transfer_queue_snapshot').catch((error) => ({ error: String(error) })) : null;
      const workspaceSnapshot = invoke ? await invoke('get_workspace_layout_snapshot').catch((error) => ({ error: String(error) })) : null;
      return JSON.stringify({
        bodyText: document.body.textContent?.slice(0, 1800) ?? '',
        transferText: document.querySelector('.transfers-tooltab')?.textContent?.trim() ?? '',
        transferHtml: document.querySelector('.transfers-tooltab')?.innerHTML?.slice(0, 1200) ?? '',
        hasTable: Boolean(document.querySelector('[data-testid="transfers-table"]')),
        rows: [...document.querySelectorAll('[data-testid="transfer-row"]')].map((row) => row.textContent?.trim() ?? ''),
        toolTabs: [...document.querySelectorAll('[role="tab"]')].map((tab) => ({
          text: tab.textContent?.trim() ?? '',
          kind: tab.getAttribute('data-tool-kind'),
          selected: tab.getAttribute('aria-selected'),
          slot: tab.getAttribute('data-tool-slot-id'),
          group: tab.closest('.workspace-dock-group')?.getAttribute('data-dock-group-id'),
        })),
        groups: [...document.querySelectorAll('.workspace-dock-group')].map((group) => ({
          id: group.getAttribute('data-dock-group-id'),
          role: group.getAttribute('data-dock-group-role'),
          active: group.getAttribute('data-active-tool-slot-id'),
          text: group.textContent?.trim().slice(0, 500) ?? '',
          html: group.innerHTML.slice(0, 1000),
        })),
        workspaceId: document.querySelector('.workspace-tab.active')?.getAttribute('data-workspace-id') ?? null,
        frontendWorkspaceDebug: window.__NOCTURNE_WORKSPACE_DEBUG__ ?? null,
        lastToolActivation: window.__NOCTURNE_LAST_TOOL_ACTIVATION__ ?? null,
        workspaceBody: {
          activeId: document.querySelector('.workspace-body')?.getAttribute('data-workspace-active-id') ?? null,
          renderedId: document.querySelector('.workspace-body')?.getAttribute('data-workspace-rendered-id') ?? null,
          snapshotCount: document.querySelector('.workspace-body')?.getAttribute('data-workspace-snapshot-count') ?? null,
          activeToolSlotRevision: document.querySelector('.workspace-body')?.getAttribute('data-active-tool-slot-revision') ?? null,
          activeToolSlotSignature: document.querySelector('.workspace-body')?.getAttribute('data-active-tool-slot-signature') ?? null,
        },
        testErrors: window.__NOCTURNE_TEST_ERRORS__ ?? [],
        runtime: Boolean(window.__TAURI_INTERNALS__),
        location: location.href,
        queue,
        workspaceSnapshot,
      }, null, 2);
    `);
  }

  async function activateToolTab(label) {
    await execute(`
      window.__NOCTURNE_TEST_ERRORS__ = [];
      if (!window.__NOCTURNE_TEST_ERROR_PROBE__) {
        window.__NOCTURNE_TEST_ERROR_PROBE__ = true;
        window.addEventListener('error', (event) => {
          window.__NOCTURNE_TEST_ERRORS__.push({
            kind: 'error',
            message: event.message,
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno,
            stack: event.error?.stack ?? '',
          });
        });
        window.addEventListener('unhandledrejection', (event) => {
          window.__NOCTURNE_TEST_ERRORS__.push({
            kind: 'unhandledrejection',
            message: event.reason instanceof Error ? event.reason.message : String(event.reason),
            stack: event.reason instanceof Error ? event.reason.stack : '',
          });
        });
      }
    `);
    const target = await execute(`
      const tabs = [...document.querySelectorAll('[role="tab"]')];
      const tab = ${JSON.stringify(label)} === 'Transfers'
        ? tabs.find((item) => item.getAttribute('data-tool-kind') === 'transfers')
        : tabs.find((item) => (item.textContent ?? '').trim() === ${JSON.stringify(label)});
      if (!tab) {
        return {
          ok: false,
          labels: tabs.map((item) => ({
            label: (item.textContent ?? '').trim(),
            kind: item.getAttribute('data-tool-kind'),
            active: item.getAttribute('aria-selected'),
          })),
        };
      }
      const rect = tab.getBoundingClientRect();
      return {
        ok: true,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        slot: tab.getAttribute('data-tool-slot-id'),
      };
    `);
    if (!target.ok) {
      throw new Error(`ToolTab ${label} was not available: ${JSON.stringify(target, null, 2)}`);
    }
    await pointerClick(target.x, target.y);
    const result = await executeAsync(`
      const done = arguments[arguments.length - 1];
      setTimeout(async () => {
        const tab = document.querySelector('[data-tool-slot-id="${target.slot}"]');
        const invoke = window.__TAURI_INTERNALS__?.invoke;
        const workspaceSnapshot = invoke ? await invoke('get_workspace_layout_snapshot').catch((error) => ({ error: String(error) })) : null;
        done({
          ok: true,
          slot: tab?.getAttribute('data-tool-slot-id') ?? ${JSON.stringify(target.slot)},
          domGroupActive: tab?.closest('.workspace-dock-group')?.getAttribute('data-active-tool-slot-id') ?? null,
          domSelected: tab?.getAttribute('aria-selected') ?? null,
          workspaceBodyRenderRevision: document.querySelector('.workspace-body')?.getAttribute('data-workspace-render-revision') ?? null,
          errors: window.__NOCTURNE_TEST_ERRORS__ ?? [],
          workspaceSnapshot,
        });
      }, 120);
    `);
    if (!result.ok) {
      throw new Error(`ToolTab ${label} was not available: ${JSON.stringify(result, null, 2)}`);
    }
  }

  async function treeState() {
    return await execute(`
      const rows = [...document.querySelectorAll('.files-row[data-file-entry="true"]')].map((row) => ({
        name: row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? '',
        path: row.getAttribute('data-entry-path') ?? '',
        kind: row.getAttribute('data-entry-kind') ?? '',
        selected: row.classList.contains('selected'),
        expanded: row.getAttribute('aria-expanded'),
      }));
      return {
        addressPath: document.querySelector('.path-field')?.textContent?.trim() ?? '',
        rows,
        selectedRows: rows.filter((row) => row.selected).map((row) => row.name),
      };
    `);
  }

  async function clickTreeRow(path) {
    const target = await executeAsync(`
      const done = arguments[arguments.length - 1];
      const rows = [...document.querySelectorAll('.files-row[data-file-entry="true"]')];
      const row = rows.find((item) => samePath(item.getAttribute('data-entry-path') ?? '', ${JSON.stringify(path)}));
      if (!row) {
        done({ found: false, rows: rows.map((item) => ({ text: item.textContent?.trim() ?? '', path: item.getAttribute('data-entry-path') ?? '' })) });
        return;
      }
      row.scrollIntoView({ block: 'center', inline: 'nearest' });
      requestAnimationFrame(() => {
        const rect = row.getBoundingClientRect();
        done({
          found: true,
          x: Math.round(rect.left + Math.min(24, rect.width / 2)),
          y: Math.round(rect.top + rect.height / 2),
        });
      });
      function samePath(left, right) {
        return normalizePath(left) === normalizePath(right);
      }
      function normalizePath(value) {
        return value.replace(/\\\\/g, '/').replace(/\\/+$/, '');
      }
    `);
    if (!target.found) {
      throw new Error(`Tree view did not contain ${path}: ${JSON.stringify(target, null, 2)}`);
    }
    await pointerClick(target.x, target.y);
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

  async function clickTreeRowBody(path) {
    const target = await executeAsync(`
      const done = arguments[arguments.length - 1];
      const rows = [...document.querySelectorAll('.files-row[data-file-entry="true"]')];
      const row = rows.find((item) => samePath(item.getAttribute('data-entry-path') ?? '', ${JSON.stringify(path)}));
      if (!row) {
        done({ found: false, rows: rows.map((item) => ({ text: item.textContent?.trim() ?? '', path: item.getAttribute('data-entry-path') ?? '' })) });
        return;
      }
      if (row.getAttribute('aria-expanded') === 'true') {
        done({ found: true, alreadyExpanded: true, path: row.getAttribute('data-entry-path') ?? '' });
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
      setTimeout(() => done({ found: true }), 80);
      function samePath(left, right) {
        return normalizePath(left) === normalizePath(right);
      }
      function normalizePath(value) {
        return value.replace(/\\\\/g, '/').replace(/\\/+$/, '');
      }
    `);
    if (!target.found) {
      throw new Error(`Tree view did not contain directory ${path}: ${JSON.stringify(target, null, 2)}`);
    }
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

  async function pointerClick(x, y) {
    await webdriver("POST", `/session/${sessionId}/actions`, {
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            { type: "pointerMove", duration: 0, x, y, origin: "viewport" },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
    await delay(80);
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

  async function pageSummary() {
    return await execute(`
      return JSON.stringify({
        title: document.title,
        bodyText: document.body.textContent?.slice(0, 1600) ?? '',
        rows: [...document.querySelectorAll('.files-row[data-file-entry="true"]')]
          .map((row) => row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? ''),
        transfers: [...document.querySelectorAll('[data-testid="transfer-row"]')]
          .map((row) => row.textContent?.trim() ?? ''),
      }, null, 2);
    `);
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
    if (!existsSync(path)) return "";
    return path;
  }

  function stopProcess(child) {
    if (!child || child.exitCode !== null) return;
    child.kill();
  }
});
