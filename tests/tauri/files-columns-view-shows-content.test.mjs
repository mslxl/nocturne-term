#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies that the Finder-style Files Columns view starts from the filesystem
 * root, focuses the configured home/default directory, and keeps a stable
 * three-column window with visible content in a real Tauri WebView.
 *
 * Operation:
 * Creates a temporary local file fixture with nested alpha, beta, and gamma
 * directories, configures a temporary Local Host as the default Workspace host,
 * starts the Vite dev server, starts tauri-driver, launches the Tauri
 * application provided by TAURI_TEST_APPLICATION, switches the Files ToolTab to
 * Columns view, verifies that earlier root/path columns exist before the
 * fixture directory column, verifies that the parent directory column includes
 * both the fixture directory and a sibling directory, clicks alpha, beta, and
 * gamma wherever those directories appear in the current column chain while
 * sampling animation frames, measures the rendered Columns view, and captures
 * a screenshot if the measurement or motion sampling fails.
 *
 * Expected:
 * Columns view opens from root instead of using home as the model root, keeps
 * Windows drive roots and parent directory siblings visible instead of
 * collapsing the model to the configured default path, opens directory
 * children to the right, shifts the visible window on the first directory
 * click and after deeper clicks with measurable horizontal motion, never
 * renders an empty or missing column frame during the shift, and settles with
 * three useful directory columns visibly inside the Columns viewport.
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

test("files columns view shows content", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("files-columns-view-content");
  const fixture = await createFilesFixture();
  const fixtureRoot = fixture.root;
  const fixtureHostId = "018f6eb3-6f91-7410-bc43-f927b2236d94";
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
    await waitUntil(async () => await execute("return document.querySelector('.columns-view') !== null;"), pageSummary);
    await waitUntil(async () => {
      const measurement = await measureColumnsView();
      return measurement.columnCount >= 2 && measurement.columns.some((column) => column.rowNames.includes("alpha"));
    }, pageSummary);
    const initialMeasurement = await measureColumnsView();
    if (initialMeasurement.columns[0]?.rowNames.includes("alpha")) {
      throw new Error(`Columns view used the fixture home/default directory as the root column instead of showing the filesystem root chain\n${JSON.stringify(initialMeasurement, null, 2)}`);
    }
    const rootChain = await assertRootChainContainsParentSibling();
    if (!rootChain.hasVirtualRoot) {
      throw new Error(`Columns view did not keep the filesystem virtual root as the first model column\n${JSON.stringify(rootChain, null, 2)}`);
    }
    if (!rootChain.hasDriveColumn) {
      throw new Error(`Columns view did not show a Windows drive-root column such as C: or D:\n${JSON.stringify(rootChain, null, 2)}`);
    }
    if (!rootChain.driveColumnHasRootSiblings) {
      throw new Error(`Columns view did not keep real drive-root children visible between the virtual root and default path\n${JSON.stringify(rootChain, null, 2)}`);
    }
    const firstMotion = await captureColumnDirectoryMotion("alpha", {
      expectedRowsByColumn: [],
      requireHorizontalTravel: true,
    });
    if (!firstMotion.ok) {
      const screenshotPath = await saveScreenshot("files-columns-view-first-click-motion.png");
      throw new Error(`${firstMotion.reason}\n${JSON.stringify(firstMotion, null, 2)}\nscreenshot: ${screenshotPath}`);
    }
    await waitUntil(async () => {
      const measurement = await measureColumnsView();
      return measurement.columns.some((column) => column.rowNames.includes("beta"));
    }, pageSummary);
    await clickColumnDirectory("beta");
    await waitUntil(async () => {
      const measurement = await measureColumnsView();
      return measurement.columns.some((column) => column.rowNames.includes("gamma"));
    }, pageSummary);
    const motion = await captureColumnDirectoryMotion("gamma");
    if (!motion.ok) {
      const screenshotPath = await saveScreenshot("files-columns-view-motion.png");
      throw new Error(`${motion.reason}\n${JSON.stringify(motion, null, 2)}\nscreenshot: ${screenshotPath}`);
    }
    await waitUntil(async () => {
      const measurement = await measureColumnsView();
      const visibleColumns = measurement.columns.filter((column) => column.visibleWidth >= 40);
      return visibleColumns.length >= 3 && visibleColumns.at(-1)?.rowNames.includes("leaf.txt");
    }, pageSummary);

    const measurement = await measureColumnsView();
    if (!measurement.ok) {
      const screenshotPath = await saveScreenshot("files-columns-view-empty.png");
      throw new Error(`${measurement.reason}\n${JSON.stringify(measurement, null, 2)}\nscreenshot: ${screenshotPath}`);
    }
    console.log(
      `tauri files Columns view content test passed\n${JSON.stringify(
        {
          ...measurement.summary,
          rootChain,
          firstClickHorizontalTravel: firstMotion.horizontalTravel,
          horizontalTravel: motion.horizontalTravel,
          motionSampleCount: motion.sampleCount,
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
    await rm(fixture.parent, { recursive: true, force: true });
  }

  async function createFilesFixture() {
    const parent = await mkdtemp(join(tmpdir(), "nocturne-files-columns-parent-"));
    const root = join(parent, "focus-root");
    const sibling = join(parent, "parent-sibling");
    await mkdir(root, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await mkdir(join(root, "alpha", "beta", "gamma"), { recursive: true });
    await writeFile(join(root, "alpha", "beta", "gamma", "leaf.txt"), "leaf content\n");
    await writeFile(join(root, "alpha", "beta", "beta-note.txt"), "beta content\n");
    await writeFile(join(root, "alpha", "readme.txt"), "alpha content\n");
    await writeFile(join(root, "sibling.txt"), "sibling content\n");
    return {
      parent,
      root,
      rootName: "focus-root",
      siblingName: "parent-sibling",
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
      `version = 1\nid = "${fixtureHostId}"\nname = "Columns Fixture"\nprotocol = "local"\n\n[files]\ndefault_path = ${JSON.stringify(fixtureRoot)}\n\n[local]\nargs = []\nenv = {}\n`,
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
      if (!columnsView) return { ok: false, reason: 'Columns view missing' };
      const currentPane = columnsView.querySelector('.columns-pane.current') ?? columnsView;
      const columns = [...currentPane.querySelectorAll('.file-column')].map((column) => {
        const viewRect = columnsView.getBoundingClientRect();
        const rect = column.getBoundingClientRect();
        const rows = [...column.querySelectorAll('.column-row')].filter((row) => row.offsetParent !== null);
        const visibleWidth = Math.max(0, Math.min(rect.right, viewRect.right) - Math.max(rect.left, viewRect.left));
        const rowNames = rows.map((row) => {
          const nameCell = row.querySelector('.name-cell');
          return nameCell?.textContent?.trim() ?? row.textContent?.trim() ?? '';
        });
        return {
          label: column.getAttribute('aria-label'),
          width: rect.width,
          left: rect.left,
          right: rect.right,
          visibleWidth,
          visiblyInsideViewport: visibleWidth >= 40,
          rowCount: rows.length,
          rowNames,
          firstRowText: rows[0]?.textContent?.trim() ?? '',
          selectedRows: rows.filter((row) => row.classList.contains('selected')).map((row) => ({
            text: row.textContent?.trim() ?? '',
            kind: row.getAttribute('data-entry-kind'),
            path: row.getAttribute('data-entry-path'),
          })),
        };
      });
      const visibleRows = columns.reduce((count, column) => count + column.rowCount, 0);
      const visibleColumns = columns.filter((column) => column.visiblyInsideViewport);
      const previewColumn = columns.find((column) => column.label === 'Preview');
      return {
        ok: columns.length >= 3 &&
          visibleRows > 0 &&
          visibleColumns.length >= 3 &&
          visibleColumns.at(-3)?.rowNames.includes('beta') &&
          visibleColumns.at(-2)?.rowNames.includes('gamma') &&
          visibleColumns.at(-1)?.rowNames.includes('leaf.txt'),
        reason: columns.length === 0
          ? 'Columns view has no file-column sections'
          : columns.length < 3
            ? 'Columns view did not show three directory columns'
          : visibleRows === 0
            ? 'Columns view has no visible rows'
            : visibleColumns.length < 3
              ? 'Columns view does not keep three directory columns visibly inside the viewport'
            : !visibleColumns.at(-3)?.rowNames.includes('beta')
              ? 'Columns view did not shift the first visible column to alpha children'
              : !visibleColumns.at(-2)?.rowNames.includes('gamma')
                ? 'Columns view did not shift the second visible column to beta children'
                : !visibleColumns.at(-1)?.rowNames.includes('leaf.txt')
                  ? 'Columns view did not open gamma children in the third column'
              : '',
        columnCount: columns.length,
        previewColumnVisibleWidth: previewColumn?.visibleWidth ?? 0,
        summary: {
          columnCount: columns.length,
          visibleColumnCount: visibleColumns.length,
          visibleRows,
          firstColumnRows: visibleColumns.at(-3)?.rowCount ?? 0,
          firstColumnText: visibleColumns.at(-3)?.firstRowText ?? '',
          secondColumnRows: visibleColumns.at(-2)?.rowCount ?? 0,
          secondColumnText: visibleColumns.at(-2)?.firstRowText ?? '',
          thirdColumnRows: visibleColumns.at(-1)?.rowCount ?? 0,
          thirdColumnText: visibleColumns.at(-1)?.firstRowText ?? '',
          previewColumnWidth: previewColumn?.width ?? 0,
          previewColumnVisibleWidth: previewColumn?.visibleWidth ?? 0,
          firstColumnSelected: columns[0]?.selectedRows ?? [],
        },
        columns,
      };
    `);
  }

  async function clickColumnDirectory(name) {
    const clicked = await execute(`
      const currentPane = document.querySelector('.columns-view .columns-pane.current') ?? document.querySelector('.columns-view');
      const columns = [...(currentPane?.querySelectorAll('.file-column') ?? [])];
      const rowsByColumn = columns.map((column, index) => ({
        index,
        label: column.getAttribute('aria-label'),
        rows: [...column.querySelectorAll('.column-row')].filter((row) => row.offsetParent !== null),
      }));
      let directory = null;
      let matchedColumn = null;
      for (const column of rowsByColumn) {
        directory = column.rows.find((row) =>
          row.getAttribute('data-entry-kind') === 'directory' &&
          row.querySelector('.name-cell')?.textContent?.trim() === ${JSON.stringify(name)}
        );
        if (directory) {
          matchedColumn = column;
          break;
        }
      }
      if (!directory) {
        return {
          clicked: false,
          columns: rowsByColumn.map((column) => ({
            index: column.index,
            label: column.label,
            rows: column.rows.slice(0, 10).map((row) => ({
              text: row.textContent?.trim() ?? '',
              kind: row.getAttribute('data-entry-kind'),
              path: row.getAttribute('data-entry-path'),
            })),
          })),
        };
      }
      directory.click();
      return {
        clicked: true,
        columnIndex: matchedColumn?.index ?? -1,
        columnLabel: matchedColumn?.label ?? '',
        text: directory.textContent?.trim() ?? '',
        path: directory.getAttribute('data-entry-path'),
      };
    `);
    if (!clicked.clicked) {
      throw new Error(`Columns view did not contain directory ${name}: ${JSON.stringify(clicked, null, 2)}`);
    }
  }

  async function assertRootChainContainsParentSibling() {
    await waitUntil(async () => {
      const measurement = await measureColumnsView();
      return measurement.columns.some((column) =>
        column.rowNames.includes(fixture.rootName) &&
        column.rowNames.includes(fixture.siblingName)
      );
    }, pageSummary);
    const measurement = await measureColumnsView();
    const parentColumn = measurement.columns.find((column) =>
      column.rowNames.includes(fixture.rootName) &&
      column.rowNames.includes(fixture.siblingName)
    );
    if (!parentColumn) {
      throw new Error(`Columns view did not preload the default path parent siblings\n${JSON.stringify(measurement, null, 2)}`);
    }
    const hasDriveColumn = measurement.columns.some((column) =>
      column.rowNames.some((name) => /^[A-Z]:$/i.test(name))
    );
    const driveColumn = measurement.columns.find((column) => /^[A-Z]:$/i.test(String(column.label ?? "")));
    return {
      hasVirtualRoot: measurement.columns[0]?.label === "/",
      hasDriveColumn,
      driveColumnHasRootSiblings: Boolean(driveColumn && driveColumn.rowNames.length > 1 && !driveColumn.rowNames.includes(fixture.rootName)),
      driveColumnRows: driveColumn?.rowNames.slice(0, 20) ?? [],
      parentColumnRows: parentColumn.rowNames,
      columnLabels: measurement.columns.map((column) => column.label),
    };
  }

  async function captureColumnDirectoryMotion(name, options = {}) {
    return await executeAsync(`
      const done = arguments[arguments.length - 1];
      const expectedRowsByColumn = ${JSON.stringify(options.expectedRowsByColumn ?? [["beta"], ["gamma"], ["leaf.txt"]])};
      const requireHorizontalTravel = ${JSON.stringify(options.requireHorizontalTravel ?? true)};
      const view = document.querySelector('.columns-view');
      const currentPane = document.querySelector('.columns-view .columns-pane.current') ?? document.querySelector('.columns-view');
      const rows = [...(currentPane?.querySelectorAll('.column-row') ?? [])]
        .filter((row) => row.offsetParent !== null);
      const directory = rows.find((row) =>
        row.getAttribute('data-entry-kind') === 'directory' &&
        row.querySelector('.name-cell')?.textContent?.trim() === ${JSON.stringify(name)}
      );
      if (!view || !directory) {
        done({
          ok: false,
          reason: 'Columns motion target directory was not available before sampling',
          rows: rows.map((row) => row.textContent?.trim() ?? ''),
        });
        return;
      }

      const samples = [];
      const started = performance.now();
      const sample = () => {
        const columnsView = document.querySelector('.columns-view');
        const content = columnsView?.querySelector('.columns-content');
        const viewRect = columnsView?.getBoundingClientRect();
        const contentRect = content?.getBoundingClientRect();
        const mapColumn = (item) => {
          const rect = item.getBoundingClientRect();
          const visibleWidth = viewRect
            ? Math.max(0, Math.min(rect.right, viewRect.right) - Math.max(rect.left, viewRect.left))
            : 0;
          const rowNames = [...item.querySelectorAll('.column-row')].map((row) => {
            const nameCell = row.querySelector('.name-cell');
            return nameCell?.textContent?.trim() ?? row.textContent?.trim() ?? '';
          });
          return {
            label: item.getAttribute('aria-label'),
            left: rect.left,
            right: rect.right,
            visibleWidth,
            rowCount: rowNames.length,
            rowNames,
          };
        };
        const currentPane = columnsView?.querySelector('.columns-pane.current') ?? columnsView;
        const columns = [...(currentPane?.querySelectorAll('.file-column') ?? [])].map(mapColumn);
        const allColumns = [...(columnsView?.querySelectorAll('.file-column') ?? [])].map(mapColumn);
        samples.push({
          elapsed: performance.now() - started,
          viewExists: Boolean(columnsView),
          reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
          contentClassName: content?.className ?? "",
          contentTransform: content ? getComputedStyle(content).transform : "",
          motionDuration: content ? getComputedStyle(content).getPropertyValue("--columns-motion-duration").trim() : "",
          contentLeft: contentRect?.left ?? null,
          contentRight: contentRect?.right ?? null,
          columnCount: columns.length,
          visibleColumnCount: columns.filter((item) => item.visibleWidth >= 24).length,
          rowTotal: columns.reduce((total, item) => total + item.rowCount, 0),
          allColumnCount: allColumns.length,
          allVisibleColumnCount: allColumns.filter((item) => item.visibleWidth >= 24).length,
          allRowTotal: allColumns.reduce((total, item) => total + item.rowCount, 0),
          labels: columns.map((item) => item.label),
          columns,
          allColumns,
        });
      };

      sample();
      directory.click();

      const capture = () => {
        sample();
        if (performance.now() - started < 800) {
          requestAnimationFrame(capture);
          return;
        }

        const lefts = samples
          .map((item) => item.contentLeft)
          .filter((value) => typeof value === 'number');
        const horizontalTravel = lefts.length
          ? Math.max(...lefts) - Math.min(...lefts)
          : 0;
        const emptyFrame = samples.find((item) =>
          !item.viewExists ||
          item.allColumnCount === 0 ||
          item.allVisibleColumnCount === 0 ||
          item.allRowTotal === 0
        );
        const final = samples[samples.length - 1];
        const finalColumns = final?.columns ?? [];
        const finalVisibleColumns = finalColumns.filter((column) => column.visibleWidth >= 24);
        const finalColumnsForExpectation = finalVisibleColumns.length >= 3 ? finalVisibleColumns.slice(-3) : finalColumns.slice(-3);
        const finalStable = expectedRowsByColumn.length === 0 || (
          finalColumnsForExpectation.length >= expectedRowsByColumn.length &&
          expectedRowsByColumn.every((expectedNames, index) => {
            const column = finalColumnsForExpectation[finalColumnsForExpectation.length - expectedRowsByColumn.length + index];
            return expectedNames.every((expectedName) => column?.rowNames.includes(expectedName));
          })
        );
        const motionOk = !requireHorizontalTravel || horizontalTravel >= 24;
        done({
          ok: motionOk && !emptyFrame && finalStable,
          reason: !motionOk
            ? 'Columns view did not produce measurable horizontal slide motion'
            : emptyFrame
              ? 'Columns view flickered through an empty or missing frame'
              : !finalStable
                ? 'Columns view did not settle into the expected three-column state'
                : '',
          horizontalTravel,
          sampleCount: samples.length,
          emptyFrame: emptyFrame ?? null,
          first: samples[0],
          middle: samples[Math.floor(samples.length / 2)],
          final,
          samples: samples.slice(0, 8).concat(samples.slice(-8)),
        });
      };

      requestAnimationFrame(capture);
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
