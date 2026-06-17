#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies Finder-style Files Columns navigation motion for nested directory
 * traversal in a real Tauri WebView.
 *
 * Operation:
 * Creates a temporary local fixture with alpha, beta, gamma, and delta
 * directories, configures an isolated Local Workspace, launches the Tauri
 * application provided by TAURI_TEST_APPLICATION through tauri-driver, switches
 * Files to Columns view, opens nested directories to the fourth level, performs
 * at least 50 unique two-column root-directory switches while the root column is
 * scrolled, clicks a middle-column sibling directory while three columns are
 * visible, then clicks visible parent directory rows to return one level at a
 * time while sampling animation frames. It also switches between sibling
 * directory and file rows in the same column.
 *
 * Expected:
 * Opening or returning within an already full three-column window uses
 * directional horizontal motion, changing between one, two, and three visible
 * columns uses a width-resize animation without horizontal content travel,
 * replacing the right-side column from a middle-column sibling selection does
 * not animate, two-column root-directory switching preserves the root column
 * scroll position across at least 50 unique switches, backward motion starts
 * from the old deeper pane without a visible wrong-direction preparation slide,
 * no sampled frame loses all visible columns or rows, each step settles into
 * the expected three-column window, and same-level directory or file selection
 * does not run a horizontal Columns navigation animation.
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

test("files columns nested navigation motion", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("files-columns-nested-motion");
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
    await execute(`
      const button = document.querySelector('.files-toolbar button[aria-label="Columns view"]');
      if (!button) throw new Error('Columns view button missing');
      button.click();
      return true;
    `);
    await waitUntil(async () => await columnsIncludeRows([["alpha", "omega", "root-note.txt"]]), pageSummary);
    await clickColumnDirectory("alpha", 0);
    await waitUntil(async () => await columnsIncludeRows([["alpha"], ["beta"]]), pageSummary);
    await waitUntil(columnsMotionIdle, pageSummary);

    const twoColumnSwitchStress = await stressTwoColumnRootSwitching();
    await assertMotionOk("stress two-column root switching", twoColumnSwitchStress);
    await clickColumnDirectory("alpha", 0);
    await waitUntil(async () => await columnsIncludeRows([["alpha"], ["beta"]]), pageSummary);
    await waitUntil(columnsMotionIdle, pageSummary);

    const siblingDirectoryMotion = await captureColumnEntryMotion({
      name: "omega",
      columnIndex: 0,
      expectedDirection: "none",
      expectedRowsByColumn: [["alpha", "omega", "root-note.txt"], ["omega-leaf.txt"]],
    });
    await assertMotionOk("select sibling directory", siblingDirectoryMotion);

    await scrollRootColumnNear("branch-42");
    const siblingFileMotion = await captureColumnEntryMotion({
      name: "opaque.bin",
      columnIndex: 0,
      expectedDirection: "resize",
      expectedRowsByColumn: [["alpha", "omega", "root-note.txt", "opaque.bin"]],
    });
    await assertMotionOk("select sibling file", siblingFileMotion);

    await scrollRootColumnNear("branch-42");
    const oneToTwoResizeMotion = await captureColumnEntryMotion({
      name: "alpha",
      columnIndex: 0,
      expectedDirection: "resize",
      expectedRowsByColumn: [["alpha", "omega", "root-note.txt", "opaque.bin"], ["beta"]],
    });
    await assertMotionOk("open alpha from one column", oneToTwoResizeMotion);
    await waitUntil(async () => await columnsIncludeRows([["alpha"], ["beta"]]), pageSummary);
    await waitUntil(columnsMotionIdle, pageSummary);

    await scrollRootColumnNear("branch-42");
    const betaMotion = await captureColumnEntryMotion({
      name: "beta",
      columnIndex: 1,
      expectedDirection: "resize",
      expectedRowsByColumn: [["alpha"], ["beta"], ["gamma"]],
    });
    await assertMotionOk("open beta", betaMotion);

    const middleColumnSiblingMotion = await captureColumnEntryMotion({
      name: "theta",
      columnIndex: 1,
      expectedDirection: "none",
      expectedRowsByColumn: [["alpha"], ["beta", "theta", "readme.txt"], ["theta-leaf.txt"]],
    });
    await assertMotionOk("replace right column from middle sibling", middleColumnSiblingMotion);

    await clickColumnDirectory("beta", 1);
    await waitUntil(async () => await columnsIncludeRows([["alpha"], ["beta"], ["gamma"]]), pageSummary);
    await waitUntil(columnsMotionIdle, pageSummary);

    await scrollRootColumnNear("branch-42");
    const rootBranchReturnMotion = await captureColumnEntryMotion({
      name: "omega",
      columnIndex: 0,
      expectedDirection: "resize",
      expectedRowsByColumn: [["alpha", "omega", "root-note.txt", "opaque.bin"], ["omega-leaf.txt"]],
    });
    await assertMotionOk("return from beta to root branch", rootBranchReturnMotion);

    await clickColumnDirectory("alpha", 0);
    await waitUntil(async () => await columnsIncludeRows([["alpha"], ["beta"]]), pageSummary);
    await waitUntil(columnsMotionIdle, pageSummary);
    await clickColumnDirectory("beta", 1);
    await waitUntil(async () => await columnsIncludeRows([["alpha"], ["beta"], ["gamma"]]), pageSummary);
    await waitUntil(columnsMotionIdle, pageSummary);

    const gammaMotion = await captureColumnEntryMotion({
      name: "gamma",
      columnIndex: 2,
      expectedDirection: "forward",
      expectedRowsByColumn: [["beta"], ["gamma"], ["delta"]],
    });
    await assertMotionOk("open gamma", gammaMotion);

    const deltaMotion = await captureColumnEntryMotion({
      name: "delta",
      columnIndex: 2,
      expectedDirection: "forward",
      expectedRowsByColumn: [["gamma"], ["delta"], ["leaf.txt"]],
    });
    await assertMotionOk("open delta", deltaMotion);

    const gammaReturnMotion = await captureColumnEntryMotion({
      name: "gamma",
      columnIndex: 0,
      expectedDirection: "backward",
      expectedRowsByColumn: [["beta"], ["gamma"], ["delta"]],
    });
    await assertMotionOk("return to gamma", gammaReturnMotion);

    const betaReturnMotion = await captureColumnEntryMotion({
      name: "beta",
      columnIndex: 0,
      expectedDirection: "backward",
      expectedRowsByColumn: [["alpha"], ["beta"], ["gamma"]],
    });
    await assertMotionOk("return to beta", betaReturnMotion);

    console.log(
      `tauri files Columns nested navigation motion test passed\n${JSON.stringify(
        {
          openBetaTravel: betaMotion.horizontalTravel,
          openGammaTravel: gammaMotion.horizontalTravel,
          openDeltaTravel: deltaMotion.horizontalTravel,
          oneToTwoResizeTravel: oneToTwoResizeMotion.horizontalTravel,
          oneToTwoResizeWidthDelta: oneToTwoResizeMotion.resizeWidthDelta,
          oneToTwoResizeIntermediateFrameCount: oneToTwoResizeMotion.resizeIntermediateFrameCount,
          oneToTwoResizeRootScrollDelta: oneToTwoResizeMotion.rootScrollDelta,
          openBetaResizeTravel: betaMotion.horizontalTravel,
          openBetaResizeWidthDelta: betaMotion.resizeWidthDelta,
          openBetaResizeIntermediateFrameCount: betaMotion.resizeIntermediateFrameCount,
          openBetaResizeRootScrollDelta: betaMotion.rootScrollDelta,
          returnRootBranchResizeTravel: rootBranchReturnMotion.horizontalTravel,
          returnRootBranchResizeWidthDelta: rootBranchReturnMotion.resizeWidthDelta,
          returnRootBranchResizeIntermediateFrameCount: rootBranchReturnMotion.resizeIntermediateFrameCount,
          returnRootBranchResizeRootScrollDelta: rootBranchReturnMotion.rootScrollDelta,
          returnGammaTravel: gammaReturnMotion.horizontalTravel,
          returnBetaTravel: betaReturnMotion.horizontalTravel,
          middleColumnSiblingTravel: middleColumnSiblingMotion.horizontalTravel,
          twoColumnSwitchMaxScrollDelta: twoColumnSwitchStress.maxScrollDelta,
          twoColumnSwitchHorizontalTravel: twoColumnSwitchStress.horizontalTravel,
          twoColumnSwitchUniqueCount: twoColumnSwitchStress.uniqueSwitchCount,
          siblingDirectoryTravel: siblingDirectoryMotion.horizontalTravel,
          siblingFileResizeTravel: siblingFileMotion.horizontalTravel,
          siblingFileResizeWidthDelta: siblingFileMotion.resizeWidthDelta,
          siblingFileResizeIntermediateFrameCount: siblingFileMotion.resizeIntermediateFrameCount,
          siblingFileResizeRootScrollDelta: siblingFileMotion.rootScrollDelta,
          sampleCounts: [
            siblingDirectoryMotion.sampleCount,
            siblingFileMotion.sampleCount,
            oneToTwoResizeMotion.sampleCount,
            twoColumnSwitchStress.sampleCount,
            betaMotion.sampleCount,
            middleColumnSiblingMotion.sampleCount,
            rootBranchReturnMotion.sampleCount,
            gammaMotion.sampleCount,
            deltaMotion.sampleCount,
            gammaReturnMotion.sampleCount,
            betaReturnMotion.sampleCount,
          ],
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
    const root = await mkdtemp(join(tmpdir(), "nocturne-files-columns-motion-"));
    await mkdir(join(root, "alpha", "beta", "gamma", "delta"), { recursive: true });
    await mkdir(join(root, "alpha", "theta"), { recursive: true });
    await mkdir(join(root, "omega"), { recursive: true });
    for (let index = 0; index < 64; index += 1) {
      const name = `branch-${String(index).padStart(2, "0")}`;
      await mkdir(join(root, name, "level-a", "level-b"), { recursive: true });
      await writeFile(join(root, name, "level-a", "level-b", "leaf.txt"), `${name} leaf\n`);
    }
    await writeFile(join(root, "alpha", "beta", "gamma", "delta", "leaf.txt"), "leaf content\n");
    await writeFile(join(root, "alpha", "beta", "gamma", "gamma-note.txt"), "gamma content\n");
    await writeFile(join(root, "alpha", "beta", "beta-note.txt"), "beta content\n");
    await writeFile(join(root, "alpha", "theta", "theta-leaf.txt"), "theta content\n");
    await writeFile(join(root, "alpha", "readme.txt"), "alpha content\n");
    await writeFile(join(root, "omega", "omega-leaf.txt"), "omega content\n");
    await writeFile(join(root, "root-note.txt"), "root content\n");
    await writeFile(join(root, "opaque.bin"), Buffer.from([0, 255, 17, 34, 51, 68, 85, 102]));
    await writeFile(join(root, "sibling.txt"), "sibling content\n");
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
      `version = 1\nid = "${fixtureHostId}"\nname = "Columns Motion Fixture"\nprotocol = "local"\n\n[files]\ndefault_path = ${JSON.stringify(fixtureRoot)}\n\n[local]\nargs = []\nenv = {}\n`,
    );
  }

  async function assertMotionOk(step, motion) {
    if (motion.ok) return;
    const screenshotPath = await saveScreenshot(`files-columns-nested-navigation-motion-${step.replaceAll(" ", "-")}.png`);
    throw new Error(`${step}: ${motion.reason}\n${JSON.stringify(motion, null, 2)}\nscreenshot: ${screenshotPath}`);
  }

  async function columnsIncludeRows(expectedRowsByColumn) {
    const measurement = await measureCurrentColumns();
    return expectedRowsByColumn.every((expectedRows, index) => expectedRows.every((row) => measurement.columns[index]?.rowNames.includes(row)));
  }

  async function columnsMotionIdle() {
    return await execute(`
      const content = document.querySelector('.columns-view .columns-content');
      if (!content) return false;
      const className = content.className ?? '';
      return !className.includes('motion-forward') &&
        !className.includes('motion-backward') &&
        !className.includes('motion-resize') &&
        !className.includes('motion-active') &&
        !className.includes('motion-preparing') &&
        !className.includes('motion-settling');
    `);
  }

  async function measureCurrentColumns() {
    return await execute(`
      const columnsView = document.querySelector('.columns-view');
      const currentPane = columnsView?.querySelector('.columns-pane.current') ?? columnsView;
      const viewRect = columnsView?.getBoundingClientRect();
      const columns = [...(currentPane?.querySelectorAll('.file-column') ?? [])].map((column) => {
        const rect = column.getBoundingClientRect();
        const rowNames = [...column.querySelectorAll('.column-row')].map((row) => {
          const nameCell = row.querySelector('.name-cell');
          return nameCell?.textContent?.trim() ?? row.textContent?.trim() ?? '';
        });
        return {
          label: column.getAttribute('aria-label'),
          left: rect.left,
          right: rect.right,
          rowNames,
          visibleWidth: viewRect
            ? Math.max(0, Math.min(rect.right, viewRect.right) - Math.max(rect.left, viewRect.left))
            : 0,
        };
      });
      return { columns };
    `);
  }

  async function clickColumnDirectory(name, columnIndex) {
    const clicked = await execute(clickColumnDirectoryScript(name, columnIndex));
    if (!clicked.clicked) {
      throw new Error(`Columns view column ${columnIndex} did not contain directory ${name}: ${JSON.stringify(clicked, null, 2)}`);
    }
  }

  async function scrollRootColumnNear(name) {
    const scrolled = await execute(`
      const currentPane = document.querySelector('.columns-view .columns-pane.current') ?? document.querySelector('.columns-view');
      const rootColumn = currentPane?.querySelectorAll('.file-column')[0] ?? null;
      const rows = [...(rootColumn?.querySelectorAll('.column-row') ?? [])]
        .filter((row) => row.offsetParent !== null);
      const row = rows.find((item) => item.querySelector('.name-cell')?.textContent?.trim() === ${JSON.stringify(name)});
      if (!rootColumn || !row) {
        return {
          ok: false,
          reason: 'Could not find a root column row to scroll into view',
          rows: rows.map((item) => item.querySelector('.name-cell')?.textContent?.trim() ?? item.textContent?.trim() ?? ''),
        };
      }
      const canWriteScrollTop = (element) => {
        if (!element || element.scrollHeight <= element.clientHeight + 4) return false;
        const original = element.scrollTop;
        element.scrollTop = Math.min(32, element.scrollHeight - element.clientHeight);
        const writable = element.scrollTop > 0;
        element.scrollTop = original;
        return writable;
      };
      const columnScrollViewport = (column) => {
        const list = column.querySelector('.column-list');
        if (!list) return null;
        const overlayViewport = list.matches('[data-overlayscrollbars-viewport]')
          ? list
          : list.querySelector('[data-overlayscrollbars-viewport]');
        if (overlayViewport && canWriteScrollTop(overlayViewport)) return overlayViewport;
        const candidates = [list, ...list.querySelectorAll('*')];
        return candidates.find((element) => canWriteScrollTop(element)) ?? null;
      };
      const visibleRows = () => {
        const rootRect = rootColumn.getBoundingClientRect();
        return rows.filter((item) => {
          const rect = item.getBoundingClientRect();
          return rect.bottom > rootRect.top + 32 && rect.top < rootRect.bottom - 4;
        }).map((item) => item.querySelector('.name-cell')?.textContent?.trim() ?? item.textContent?.trim() ?? '');
      };
      const scrollRowIntoColumnView = () => {
        const viewport = columnScrollViewport(rootColumn);
        if (!viewport) return false;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const rootRect = rootColumn.getBoundingClientRect();
          const rowRect = row.getBoundingClientRect();
          if (rowRect.top > rootRect.top + 36 && rowRect.bottom < rootRect.bottom - 8) return true;
          const delta = rowRect.top - rootRect.top - Math.max(48, rootColumn.clientHeight / 2) + rowRect.height / 2;
          viewport.scrollTop += delta;
          viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
        }
        return false;
      };
      const scrolled = scrollRowIntoColumnView();
      const rootRect = rootColumn.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const visible = visibleRows();
      return {
        ok: scrolled && rowRect.top > rootRect.top + 32 && rowRect.bottom < rootRect.bottom - 4 && visible[0] !== 'alpha',
        rowTop: rowRect.top,
        rootTop: rootRect.top,
        viewport: columnScrollViewport(rootColumn)?.getAttribute('data-overlayscrollbars-viewport') ?? null,
        visibleRows: visible.slice(0, 8),
      };
    `);
    if (!scrolled.ok) {
      throw new Error(`Could not prepare root column scroll: ${JSON.stringify(scrolled, null, 2)}`);
    }
    await delay(80);
  }

  function clickColumnDirectoryScript(name, columnIndex) {
    return `
      const currentPane = document.querySelector('.columns-view .columns-pane.current') ?? document.querySelector('.columns-view');
      const column = currentPane?.querySelectorAll('.file-column')[${columnIndex}];
      const rows = [...(column?.querySelectorAll('.column-row') ?? [])]
        .filter((row) => row.offsetParent !== null);
      const directory = rows.find((row) =>
        row.getAttribute('data-entry-kind') === 'directory' &&
        row.querySelector('.name-cell')?.textContent?.trim() === ${JSON.stringify(name)}
      );
      if (!directory) {
        return {
          clicked: false,
          rowCount: rows.length,
          rows: rows.slice(0, 10).map((row) => ({
            text: row.textContent?.trim() ?? '',
            kind: row.getAttribute('data-entry-kind'),
            path: row.getAttribute('data-entry-path'),
          })),
        };
      }
      directory.click();
      return {
        clicked: true,
        text: directory.textContent?.trim() ?? '',
        path: directory.getAttribute('data-entry-path'),
      };
    `;
  }

  async function stressTwoColumnRootSwitching() {
    return await executeAsync(`
      const done = arguments[arguments.length - 1];
      const switchNames = Array.from({ length: 50 }, (_, index) =>
        "branch-" + String(12 + index).padStart(2, "0")
      );
      const samples = [];
      const topJumpFrames = [];
      const started = performance.now();

      const currentPane = () => document.querySelector('.columns-view .columns-pane.current') ?? document.querySelector('.columns-view');
      const rootColumn = () => currentPane()?.querySelectorAll('.file-column')[0] ?? null;
      const visibleRows = () => [...(rootColumn()?.querySelectorAll('.column-row') ?? [])]
        .filter((row) => row.offsetParent !== null);
      const visibleRootRowNames = () => {
        const column = rootColumn();
        const rootRect = column?.getBoundingClientRect();
        if (!rootRect) return [];
        return visibleRows()
          .filter((row) => {
            const rect = row.getBoundingClientRect();
            return rect.bottom > rootRect.top + 32 && rect.top < rootRect.bottom - 4;
          })
          .map((row) => row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? '');
      };
      const rowNamed = (name) => visibleRows().find((row) => row.querySelector('.name-cell')?.textContent?.trim() === name);
      const canWriteScrollTop = (element) => {
        if (!element || element.scrollHeight <= element.clientHeight + 4) return false;
        const original = element.scrollTop;
        element.scrollTop = Math.min(32, element.scrollHeight - element.clientHeight);
        const writable = element.scrollTop > 0;
        element.scrollTop = original;
        return writable;
      };
      const columnScrollViewport = (column) => {
        const list = column.querySelector('.column-list');
        if (!list) return null;
        const overlayViewport = list.matches('[data-overlayscrollbars-viewport]')
          ? list
          : list.querySelector('[data-overlayscrollbars-viewport]');
        if (overlayViewport && canWriteScrollTop(overlayViewport)) return overlayViewport;
        const candidates = [list, ...list.querySelectorAll('*')];
        return candidates.find((element) => canWriteScrollTop(element)) ?? null;
      };
      const setRootScrollNear = (name) => {
        const row = rowNamed(name);
        if (!row) return false;
        const column = rootColumn();
        if (!column) return false;
        const viewport = columnScrollViewport(column);
        if (!viewport) return false;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const columnRect = column.getBoundingClientRect();
          const rowRect = row.getBoundingClientRect();
          if (rowRect.top > columnRect.top + 36 && rowRect.bottom < columnRect.bottom - 8) break;
          const delta = rowRect.top - columnRect.top - Math.max(48, column.clientHeight / 2) + rowRect.height / 2;
          viewport.scrollTop += delta;
          viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
        }
        const visible = visibleRootRowNames();
        return visible.includes(name) && visible[0] !== "alpha";
      };
      const sample = () => {
        const columnsView = document.querySelector('.columns-view');
        const content = columnsView?.querySelector('.columns-content');
        const contentRect = content?.getBoundingClientRect();
        const viewRect = columnsView?.getBoundingClientRect();
        const columns = [...(columnsView?.querySelectorAll('.file-column') ?? [])].map((column) => {
          const rect = column.getBoundingClientRect();
          const rowNames = [...column.querySelectorAll('.column-row')].map((row) =>
            row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? ''
          );
          return {
            label: column.getAttribute('aria-label'),
            left: rect.left,
            right: rect.right,
            visibleWidth: viewRect
              ? Math.max(0, Math.min(rect.right, viewRect.right) - Math.max(rect.left, viewRect.left))
              : 0,
            rowCount: rowNames.length,
            rowNames,
          };
        });
        samples.push({
          elapsed: performance.now() - started,
          contentClassName: content?.className ?? '',
          contentLeft: contentRect?.left ?? null,
          columnCount: columns.length,
          visibleColumnCount: columns.filter((item) => item.visibleWidth >= 24).length,
          rowTotal: columns.reduce((total, item) => total + item.rowCount, 0),
          rootVisibleRows: visibleRootRowNames().slice(0, 8),
          columns,
        });
      };

      const waitFor = (predicate, timeoutMs = 2000) => new Promise((resolve) => {
        const start = performance.now();
        const tick = () => {
          if (predicate()) {
            resolve(true);
            return;
          }
          if (performance.now() - start >= timeoutMs) {
            resolve(false);
            return;
          }
          requestAnimationFrame(tick);
        };
        tick();
      });

      (async () => {
        if (!setRootScrollNear("branch-42")) {
          done({ ok: false, reason: "Could not prepare a scrolled root column for switching" });
          return;
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const baselineVisibleRows = visibleRootRowNames();
        if (baselineVisibleRows[0] === "alpha" || !baselineVisibleRows.includes("branch-42")) {
          done({ ok: false, reason: "Root column did not scroll to the prepared branch before switching", baselineVisibleRows });
          return;
        }
        const uniqueSwitchCount = new Set(switchNames).size;
        if (uniqueSwitchCount !== switchNames.length) {
          done({ ok: false, reason: "Stress switching must use unique directory selections", switchCount: switchNames.length, uniqueSwitchCount });
          return;
        }

        sample();
        for (const name of switchNames) {
          if (!setRootScrollNear(name)) {
            done({ ok: false, reason: "Could not scroll a stress switch target into view", name });
            return;
          }
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const beforeVisibleRows = visibleRootRowNames();
          const row = rowNamed(name);
          if (!row) {
            done({
              ok: false,
              reason: "A stress switch target row was not available",
              name,
              beforeVisibleRows,
              rows: visibleRows().map((item) => item.querySelector('.name-cell')?.textContent?.trim() ?? item.textContent?.trim() ?? ''),
            });
            return;
          }
          row.click();
          sample();
          const settled = await waitFor(() => {
            const pane = currentPane();
            const secondColumn = pane?.querySelectorAll('.file-column')[1];
            return secondColumn?.getAttribute('aria-label')?.endsWith(name) &&
              [...secondColumn.querySelectorAll('.column-row')].some((rowItem) =>
                rowItem.querySelector('.name-cell')?.textContent?.trim() === "level-a"
              );
          });
          sample();
          if (!settled) {
            done({ ok: false, reason: "A stress switch did not settle into the selected directory", name, samples: samples.slice(-8) });
            return;
          }
          const afterVisibleRows = visibleRootRowNames();
          if (beforeVisibleRows[0] !== "alpha" && (afterVisibleRows[0] === "alpha" || afterVisibleRows[0] === "branch-00")) {
            topJumpFrames.push({ name, beforeVisibleRows, afterVisibleRows });
          }
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }

        const lefts = samples.map((item) => item.contentLeft).filter((value) => typeof value === 'number');
        const horizontalTravel = lefts.length ? Math.max(...lefts) - Math.min(...lefts) : 0;
        const emptyFrame = samples.find((item) => item.columnCount === 0 || item.visibleColumnCount === 0 || item.rowTotal === 0);
        const topJumpFrame = topJumpFrames[0] ?? null;
        const unexpectedMotionFrame = samples.find((item) =>
          item.contentClassName.includes('motion-forward') ||
          item.contentClassName.includes('motion-backward') ||
          Math.abs(item.contentLeft ?? 0) >= 8
        );
        done({
          ok: horizontalTravel < 8 && !emptyFrame && !unexpectedMotionFrame && !topJumpFrame,
          reason: topJumpFrame
            ? "Root column visible rows jumped back to the top while switching two-column directories"
            : horizontalTravel >= 8
              ? "Two-column root switching produced horizontal Columns motion"
              : emptyFrame
                ? "Two-column root switching flickered through an empty frame"
                : unexpectedMotionFrame
                  ? "Two-column root switching applied a Columns navigation motion class"
                  : "",
          expectedDirection: "none",
          horizontalTravel,
          topJumpFrame,
          switchCount: switchNames.length,
          uniqueSwitchCount,
          sampleCount: samples.length,
          emptyFrame: emptyFrame ?? null,
          unexpectedMotionFrame: unexpectedMotionFrame ?? null,
          final: samples[samples.length - 1],
          samples: samples.slice(0, 8).concat(samples.slice(-8)),
        });
      })().catch((error) => {
        done({ ok: false, reason: error instanceof Error ? error.message : String(error) });
      });
    `);
  }

  async function captureColumnEntryMotion({ name, columnIndex, expectedDirection, expectedRowsByColumn }) {
    return await executeAsync(`
      const done = arguments[arguments.length - 1];
      const currentPane = document.querySelector('.columns-view .columns-pane.current') ?? document.querySelector('.columns-view');
      const column = currentPane?.querySelectorAll('.file-column')[${columnIndex}];
      const rows = [...(column?.querySelectorAll('.column-row') ?? [])]
        .filter((row) => row.offsetParent !== null);
      const target = rows.find((row) =>
        row.querySelector('.name-cell')?.textContent?.trim() === ${JSON.stringify(name)}
      );
      if (!target) {
        done({
          ok: false,
          reason: 'Columns motion target row was not available before sampling',
          rows: rows.map((row) => row.textContent?.trim() ?? ''),
        });
        return;
      }

      const expectedRowsByColumn = ${JSON.stringify(expectedRowsByColumn)};
      const expectedDirection = ${JSON.stringify(expectedDirection)};
      const samples = [];
      const started = performance.now();
      const rootVisibleRows = () => {
        const pane = document.querySelector('.columns-view .columns-pane.current') ?? document.querySelector('.columns-view');
        const rootColumn = pane?.querySelectorAll('.file-column')[0] ?? null;
        const rootRect = rootColumn?.getBoundingClientRect();
        if (!rootRect) return [];
        return [...rootColumn.querySelectorAll('.column-row')]
          .filter((row) => row.offsetParent !== null)
          .filter((row) => {
            const rect = row.getBoundingClientRect();
            return rect.bottom > rootRect.top + 32 && rect.top < rootRect.bottom - 4;
          })
          .map((row) => row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? '');
      };
      const mapColumn = (item, viewRect) => {
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
          width: rect.width,
          visibleWidth,
          rowCount: rowNames.length,
          rowNames,
        };
      };
      const sample = () => {
        const columnsView = document.querySelector('.columns-view');
        const content = columnsView?.querySelector('.columns-content');
        const currentPane = columnsView?.querySelector('.columns-pane.current') ?? columnsView;
        const viewRect = columnsView?.getBoundingClientRect();
        const contentRect = content?.getBoundingClientRect();
        const columns = [...(columnsView?.querySelectorAll('.file-column') ?? [])].map((item) => mapColumn(item, viewRect));
        const currentColumns = [...(currentPane?.querySelectorAll('.file-column') ?? [])].map((item) => mapColumn(item, viewRect));
        samples.push({
          elapsed: performance.now() - started,
          viewExists: Boolean(columnsView),
          viewWidth: viewRect?.width ?? 0,
          contentClassName: content?.className ?? '',
          contentTransform: content ? getComputedStyle(content).transform : '',
          contentLeft: contentRect?.left ?? null,
          columnCount: columns.length,
          visibleColumnCount: columns.filter((item) => item.visibleWidth >= 24).length,
          rowTotal: columns.reduce((total, item) => total + item.rowCount, 0),
          currentColumnCount: currentColumns.length,
          currentVisibleColumnCount: currentColumns.filter((item) => item.visibleWidth >= 24).length,
          currentRowTotal: currentColumns.reduce((total, item) => total + item.rowCount, 0),
          rootVisibleRows: rootVisibleRows().slice(0, 8),
          currentColumns,
          columns,
        });
      };

      sample();
      target.click();
      sample();

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
          item.columnCount === 0 ||
          item.visibleColumnCount === 0 ||
          item.rowTotal === 0
        );
        const isResize = expectedDirection === 'resize';
        const isNone = expectedDirection === 'none';
        const directionSamples = isNone
          ? []
          : samples.filter((item) => item.contentClassName.includes("motion-" + expectedDirection));
        const activeDirectionSamples = directionSamples.filter((item) => item.contentClassName.includes("motion-active"));
        const firstActive = activeDirectionSamples[0];
        const lastActive = activeDirectionSamples[activeDirectionSamples.length - 1];
        const directionIsCorrect = isNone || isResize
          ? true
          : expectedDirection === 'forward'
            ? firstActive && lastActive && firstActive.contentLeft > lastActive.contentLeft
            : firstActive && lastActive && firstActive.contentLeft < lastActive.contentLeft;
        const backwardPreparationSlide = expectedDirection === 'backward'
          ? directionSamples.find((item) =>
              !item.contentClassName.includes('motion-active') &&
              item.viewWidth > 0 &&
              typeof item.contentLeft === 'number' &&
              item.contentLeft > -item.viewWidth + 12
            )
          : null;
        const unexpectedMotionFrame = isNone || isResize
          ? samples.find((item) =>
              item.contentClassName.includes('motion-forward') ||
              item.contentClassName.includes('motion-backward') ||
              Math.abs(item.contentLeft ?? 0) >= 8
            )
          : null;
        const final = samples[samples.length - 1];
        const expectedColumnCount = expectedRowsByColumn.length;
        const finalColumns = final?.currentColumns ?? final?.columns ?? [];
        const finalColumnCount = final?.currentColumnCount ?? final?.columnCount;
        const finalColumnCountMatches = isNone
          ? finalColumnCount >= expectedColumnCount
          : finalColumnCount === expectedColumnCount;
        const finalStable = finalColumnCountMatches &&
          expectedRowsByColumn.every((expectedRows, index) =>
            expectedRows.every((rowName) => finalColumns[index]?.rowNames.includes(rowName))
          );
        const currentFirstColumnWidths = samples
          .map((item) => item.currentColumns[0]?.visibleWidth)
          .filter((value) => typeof value === 'number' && value > 0);
        const resizeWidthDelta = currentFirstColumnWidths.length
          ? Math.max(...currentFirstColumnWidths) - Math.min(...currentFirstColumnWidths)
          : 0;
        const activeResizeWidths = activeDirectionSamples
          .map((item) => item.currentColumns[0]?.visibleWidth)
          .filter((value) => typeof value === 'number' && value > 0);
        const roundedActiveResizeWidths = [...new Set(activeResizeWidths.map((value) => Math.round(value)))];
        const initialWidth = currentFirstColumnWidths[0] ?? 0;
        const finalWidth = currentFirstColumnWidths[currentFirstColumnWidths.length - 1] ?? 0;
        const resizeIntermediateFrameCount = activeResizeWidths.filter((value) =>
          Math.abs(value - initialWidth) >= 2 && Math.abs(value - finalWidth) >= 2
        ).length;
        const shouldPreserveRootScroll = isNone || isResize;
        const initialRootVisibleRows = samples[0]?.rootVisibleRows ?? [];
        const initialRootWasNotTop = initialRootVisibleRows.length > 0 && initialRootVisibleRows[0] !== 'alpha' && initialRootVisibleRows[0] !== 'branch-00';
        const rootScrolledToTop = shouldPreserveRootScroll && initialRootWasNotTop && samples.some((item) =>
          item.rootVisibleRows?.[0] === 'alpha' || item.rootVisibleRows?.[0] === 'branch-00'
        );
        const motionAmountMatches = isNone || isResize
          ? horizontalTravel < 8
          : horizontalTravel >= 24;
        const resizeAmountMatches = !isResize || resizeWidthDelta >= 24;
        const resizeAnimatedThroughIntermediateFrames = !isResize || (resizeIntermediateFrameCount >= 3 && roundedActiveResizeWidths.length >= 4);
        const directionClassMatches = isNone
          ? true
          : isResize
            ? directionSamples.length > 0
            : directionSamples.length > 0;
        done({
          ok: motionAmountMatches &&
            resizeAmountMatches &&
            resizeAnimatedThroughIntermediateFrames &&
            !emptyFrame &&
            directionClassMatches &&
            directionIsCorrect &&
            !backwardPreparationSlide &&
            !unexpectedMotionFrame &&
            !rootScrolledToTop &&
            finalStable,
          reason: (isNone || isResize) && horizontalTravel >= 8
            ? 'Columns view animated while selecting a same-level row'
            : isResize && resizeWidthDelta < 24
            ? 'Columns view did not produce measurable column width resize motion'
            : isResize && !resizeAnimatedThroughIntermediateFrames
            ? 'Columns view resize did not animate through measurable intermediate width frames'
            : !isNone && !isResize && horizontalTravel < 24
            ? 'Columns view did not produce measurable horizontal slide motion'
            : emptyFrame
              ? 'Columns view flickered through an empty or missing frame'
              : !isNone && directionSamples.length === 0
                ? 'Columns view did not apply the expected motion direction class'
                : !directionIsCorrect
                  ? 'Columns view moved in the wrong direction during active motion'
                  : backwardPreparationSlide
                    ? 'Columns backward motion visibly prepared from the wrong pane position'
                    : unexpectedMotionFrame
                      ? 'Columns view applied navigation motion while selecting a same-level row'
                    : rootScrolledToTop
                      ? 'Columns root column scrolled back to the top during selection'
                    : !finalStable
                      ? 'Columns view did not settle into the expected three-column state'
                      : '',
          expectedDirection,
          horizontalTravel,
          resizeWidthDelta,
          resizeIntermediateFrameCount,
          roundedActiveResizeWidths,
          initialRootVisibleRows,
          rootScrolledToTop,
          shouldPreserveRootScroll,
          sampleCount: samples.length,
          emptyFrame: emptyFrame ?? null,
          backwardPreparationSlide: backwardPreparationSlide ?? null,
          unexpectedMotionFrame: unexpectedMotionFrame ?? null,
          firstActive: firstActive ?? null,
          lastActive: lastActive ?? null,
          final,
          samples: samples.slice(0, 10).concat(samples.slice(-10)),
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
