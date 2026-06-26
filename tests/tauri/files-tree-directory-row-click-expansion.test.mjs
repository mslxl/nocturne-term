#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies Finder-style Files Tree directory row activation in a real Tauri
 * WebView.
 *
 * Operation:
 * Creates a nested temporary local fixture with sibling directories at every
 * ancestor level, configures an isolated Local Workspace whose default Files
 * path starts deep inside that fixture, launches the Tauri application through
 * tauri-driver, verifies the initial root-to-default-path expansion shows real
 * ancestor siblings before any manual collapse/expand action, expands and
 * toggles real directory rows through ordinary single-click activation,
 * toggles each of the first four real directory levels at least three times,
 * scrolls the Tree deep into a long sibling list and toggles a visible
 * directory without changing the user's scroll position,
 * and on Windows toggles the virtual root drive row that contains the fixture
 * path.
 *
 * Expected:
 * The initial Tree shows the filesystem root as the model root while the deep
 * default path is only focused, every expanded ancestor lists its real siblings
 * instead of only the synthetic focus-chain child, every ordinary row-body
 * click toggles directory expansion and selection, child rows appear and
 * disappear with that toggle on every repeated cycle, clicking a parent after
 * selecting a deeper child leaves the Files view responsive for subsequent
 * clicks, expanding or collapsing a visible directory preserves the Tree
 * scroll offset instead of jumping to the top or initial focus row, and the
 * Windows drive row can be collapsed and expanded repeatedly without making
 * the WebView stop responding.
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

test("files tree directory row click expansion", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("files-tree-directory-row-click-expansion");
  const fixtureRoot = await createFilesFixture();
  const fixtureDefaultPath = join(fixtureRoot, "alpha", "beta", "gamma");
  const fixtureRootName = pathBasename(fixtureRoot);
  const fixtureDriveName = driveNameForPath(fixtureRoot);
  const fixtureHostId = "018f6eb3-6f91-7410-bc43-f927b2236da0";
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
    await waitUntil(async () => await execute("return document.querySelector('.files-tooltab .files-toolbar') !== null;"), pageSummary);
    await waitUntil(initialFocusedAncestorSiblingsAreVisible, pageSummary);

    await toggleRealDirectoryLevelsRepeatedly([
      { name: fixtureRootName, childName: "alpha", ancestorNames: [], siblingName: "root-sibling-a" },
      { name: "alpha", childName: "beta", ancestorNames: [fixtureRootName], siblingName: "alpha-sibling-a" },
      { name: "beta", childName: "gamma", ancestorNames: [fixtureRootName, "alpha"], siblingName: "beta-sibling-a" },
      { name: "gamma", childName: "delta", ancestorNames: [fixtureRootName, "alpha", "beta"], siblingName: "gamma-sibling-a" },
    ], 3);
    await assertVisibleDirectoryTogglePreservesTreeScroll("scroll-target-42");

    if (fixtureDriveName) {
      await dispatchTreeRowClick(fixtureDriveName, 1);
      await assertWebViewResponsive("after collapsing the current Windows drive");
      await waitUntil(async () => {
        const rows = await treeRows();
        return rows.some((row) => row.name === fixtureDriveName && row.expanded === "false" && row.selected) &&
          !rows.some((row) => row.name === fixtureRootName);
      }, pageSummary);

      await delay(650);
      await dispatchTreeRowClick(fixtureDriveName, 1);
      await assertWebViewResponsive("after re-expanding the current Windows drive");
      await waitUntil(async () => {
        const rows = await treeRows();
        return rows.some((row) => row.name === fixtureDriveName && row.expanded === "true" && row.selected) &&
          rows.some((row) => row.name === fixtureRootName);
      }, pageSummary);

      await delay(650);
      await dispatchTreeRowClick(fixtureDriveName, 1);
      await assertWebViewResponsive("after collapsing the current Windows drive again");
      await waitUntil(async () => {
        const rows = await treeRows();
        return rows.some((row) => row.name === fixtureDriveName && row.expanded === "false" && row.selected);
      }, pageSummary);
    }

    console.log(
      `tauri files tree directory row click expansion test passed\n${JSON.stringify(
        {
          fixtureRootName,
          rows: await treeRows(),
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
    const root = await mkdtemp(join(tmpdir(), "nocturne-files-tree-row-click-"));
    await mkdir(join(root, "root-sibling-a"), { recursive: true });
    await mkdir(join(root, "root-sibling-b"), { recursive: true });
    await mkdir(join(root, "alpha", "alpha-sibling-a"), { recursive: true });
    await mkdir(join(root, "alpha", "alpha-sibling-b"), { recursive: true });
    await mkdir(join(root, "alpha", "beta", "beta-sibling-a"), { recursive: true });
    await mkdir(join(root, "alpha", "beta", "beta-sibling-b"), { recursive: true });
    await mkdir(join(root, "alpha", "beta", "gamma", "gamma-sibling-a"), { recursive: true });
    await mkdir(join(root, "alpha", "beta", "gamma", "gamma-sibling-b"), { recursive: true });
    await mkdir(join(root, "alpha", "beta", "gamma", "delta", "epsilon"), { recursive: true });
    for (let index = 0; index < 64; index += 1) {
      const name = `scroll-target-${String(index).padStart(2, "0")}`;
      await mkdir(join(root, name, "child"), { recursive: true });
    }
    await writeFile(join(root, "alpha", "beta", "gamma", "delta", "epsilon", "leaf.txt"), "leaf content\n");
    await writeFile(join(root, "alpha", "note.txt"), "alpha content\n");
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
      `version = 1\nid = "${fixtureHostId}"\nname = "Files Tree Row Click Fixture"\nprotocol = "local"\n\n[files]\ndefault_path = ${JSON.stringify(fixtureDefaultPath)}\n\n[local]\nargs = []\nenv = {}\n`,
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
      return [...document.querySelectorAll('.files-table [data-file-entry="true"]:not(.sticky-row)')]
        .filter((row) => row.offsetParent !== null)
        .map((row) => ({
          name: basename(row.getAttribute('data-entry-path') ?? row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? ''),
          path: row.getAttribute('data-entry-path') ?? '',
          kind: row.getAttribute('data-entry-kind') ?? '',
          expanded: row.getAttribute('aria-expanded'),
          selected: row.classList.contains('selected'),
          depth: Number(row.getAttribute('aria-level') ?? '1') - 1,
        }));

      function basename(value) {
        const normalized = value.replace(/\\\\/g, '/').replace(/\\/+$/, '');
        return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
      }
    `);
  }

  async function dispatchTreeRowClick(name, detail = 1) {
    const result = await execute(treeRowClickScript(name, [detail]));
    if (!result.found) {
      throw new Error(`Tree directory row ${name} was not found: ${JSON.stringify(result, null, 2)}`);
    }
  }

  async function initialFocusedAncestorSiblingsAreVisible() {
    const rows = await treeRows();
    return hasExpandedDirectoryWithChild(rows, fixtureRootName, "alpha") &&
      hasExpandedDirectoryWithChild(rows, fixtureRootName, "root-sibling-a") &&
      hasExpandedDirectoryWithChild(rows, "alpha", "beta") &&
      hasExpandedDirectoryWithChild(rows, "alpha", "alpha-sibling-a") &&
      hasExpandedDirectoryWithChild(rows, "beta", "gamma") &&
      hasExpandedDirectoryWithChild(rows, "beta", "beta-sibling-a") &&
      hasExpandedDirectoryWithChild(rows, "gamma", "delta") &&
      hasExpandedDirectoryWithChild(rows, "gamma", "gamma-sibling-a");
  }

  function hasExpandedDirectoryWithChild(rows, parentName, childName) {
    const parentIndex = rows.findIndex((row) => row.name === parentName && row.kind === "directory");
    if (parentIndex < 0 || rows[parentIndex].expanded !== "true") return false;
    const parentDepth = rows[parentIndex].depth;
    return rows.slice(parentIndex + 1).some((row) => {
      if (row.depth <= parentDepth) return false;
      return row.depth === parentDepth + 1 && row.name === childName;
    });
  }

  async function toggleRealDirectoryLevelsRepeatedly(levels, repeatCount) {
    for (const level of levels) {
      for (let cycle = 1; cycle <= repeatCount; cycle += 1) {
        await ensureTreePathExpanded([...level.ancestorNames, level.name], level.childName);

        await dispatchTreeRowClick(level.name, 1);
        await assertWebViewResponsive(`after collapsing ${level.name} on cycle ${cycle}`);
        await waitUntil(async () => {
          const rows = await treeRows();
          return rows.some((row) => row.name === level.name && row.expanded === "false" && row.selected) &&
            !rows.some((row) => row.name === level.childName);
        }, async () => `directory ${level.name} did not collapse on cycle ${cycle}\n${await pageSummary()}`);

        await delay(120);
        await dispatchTreeRowClick(level.name, 1);
        await assertWebViewResponsive(`after expanding ${level.name} on cycle ${cycle}`);
        await waitUntil(async () => {
          const rows = await treeRows();
          return rows.some((row) => row.name === level.name && row.expanded === "true" && row.selected) &&
            rows.some((row) => row.name === level.childName) &&
            rows.some((row) => row.name === level.siblingName);
        }, async () => `directory ${level.name} did not expand on cycle ${cycle}\n${await pageSummary()}`);
      }
    }
  }

  async function assertVisibleDirectoryTogglePreservesTreeScroll(name) {
    const scrolled = await scrollTreeToRow(name);
    if (!scrolled.ok) {
      throw new Error(`Tree did not scroll to ${name} before toggle preservation check\n${JSON.stringify(scrolled, null, 2)}`);
    }
    const beforeExpand = await treeScrollState();
    if (beforeExpand.scrollTop <= 8 || beforeExpand.firstVisibleName === fixtureRootName || beforeExpand.firstVisibleName === "alpha") {
      throw new Error(`Tree was not prepared in a deep scroll position before expanding ${name}\n${JSON.stringify(beforeExpand, null, 2)}`);
    }

    await dispatchTreeRowClick(name, 1);
    await assertWebViewResponsive(`after expanding ${name} in a scrolled Tree`);
    await waitUntil(async () => {
      const rows = await treeRows();
      return rows.some((row) => row.name === name && row.expanded === "true" && row.selected) &&
        rows.some((row) => row.name === "child");
    }, async () => `directory ${name} did not expand during scroll preservation check\n${await pageSummary()}`);
    await delay(450);
    const afterExpand = await treeScrollState();
    assertTreeScrollPreserved(beforeExpand, afterExpand, `expanding ${name}`);

    await dispatchTreeRowClick(name, 1);
    await assertWebViewResponsive(`after collapsing ${name} in a scrolled Tree`);
    await waitUntil(async () => {
      const rows = await treeRows();
      return rows.some((row) => row.name === name && row.expanded === "false" && row.selected);
    }, async () => `directory ${name} did not collapse during scroll preservation check\n${await pageSummary()}`);
    await delay(450);
    const afterCollapse = await treeScrollState();
    assertTreeScrollPreserved(beforeExpand, afterCollapse, `collapsing ${name}`);
  }

  function assertTreeScrollPreserved(before, after, operation) {
    const delta = Math.abs(after.scrollTop - before.scrollTop);
    if (
      after.scrollTop <= 8 ||
      after.firstVisibleName === fixtureRootName ||
      after.firstVisibleName === "alpha" ||
      after.firstVisibleName === "beta" ||
      delta > 80
    ) {
      throw new Error(
        `Tree scroll position was not preserved after ${operation}\n${JSON.stringify(
          {
            before,
            after,
            delta,
          },
          null,
          2,
        )}`,
      );
    }
  }

  async function ensureTreePathExpanded(pathNames, finalChildName) {
    for (const name of pathNames) {
      const rows = await treeRows();
      const row = rows.find((candidate) => candidate.name === name && candidate.kind === "directory");
      if (!row) {
        throw new Error(`Cannot expand missing Tree directory ${name}\n${await pageSummary()}`);
      }
      if (row.expanded !== "true") {
        await dispatchTreeRowClick(name, 1);
        await waitUntil(async () => {
          const nextRows = await treeRows();
          return nextRows.some((candidate) => candidate.name === name && candidate.expanded === "true");
        }, async () => `directory ${name} did not expand while preparing nested toggle\n${await pageSummary()}`);
      }
    }
    await waitUntil(async () => (await treeRows()).some((row) => row.name === finalChildName), pageSummary);
  }

  function treeRowClickScript(name, details) {
    return `
      const rows = [...document.querySelectorAll('.files-table [data-file-entry="true"]:not(.sticky-row)')]
        .filter((row) => row.offsetParent !== null);
      const row = rows.find((candidate) =>
        candidate.getAttribute('data-entry-kind') === 'directory' &&
        basename(candidate.getAttribute('data-entry-path') ?? candidate.querySelector('.name-cell')?.textContent?.trim() ?? '') === ${JSON.stringify(name)}
      );
      if (!row) {
        return {
          found: false,
          rows: rows.map((candidate) => basename(candidate.getAttribute('data-entry-path') ?? candidate.querySelector('.name-cell')?.textContent?.trim() ?? candidate.textContent?.trim() ?? '')),
        };
      }
      const rect = row.getBoundingClientRect();
      const x = Math.round(rect.left + Math.min(24, rect.width / 2));
      const y = Math.round(rect.top + rect.height / 2);
      for (const detail of ${JSON.stringify(details)}) {
        row.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
          button: 0,
          detail,
        }));
      }
      return { found: true };

      function basename(value) {
        const normalized = value.replace(/\\\\/g, '/').replace(/\\/+$/, '');
        return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
      }
    `;
  }

  async function assertWebViewResponsive(label) {
    const result = await execute(`
      window.__nocturneFilesTreeResponsivenessProbe = (window.__nocturneFilesTreeResponsivenessProbe ?? 0) + 1;
      return {
        marker: window.__nocturneFilesTreeResponsivenessProbe,
        rows: document.querySelectorAll('.files-table [data-file-entry="true"]:not(.sticky-row)').length,
      };
    `);
    if (!result || typeof result.marker !== "number") {
      throw new Error(`WebView did not respond ${label}: ${JSON.stringify(result)}`);
    }
  }

  async function scrollTreeToRow(name) {
    return await execute(`
      const table = document.querySelector('.files-table');
      const viewport = treeViewport();
      const row = treeRowByName(${JSON.stringify(name)});
      if (!table || !viewport || !row) {
        return {
          ok: false,
          reason: 'Tree row or viewport missing',
          hasTable: Boolean(table),
          hasViewport: Boolean(viewport),
          hasRow: Boolean(row),
          rows: [...document.querySelectorAll('.files-table [data-file-entry="true"]:not(.sticky-row)')]
            .map((candidate) => basename(candidate.getAttribute('data-entry-path') ?? candidate.textContent?.trim() ?? '')),
        };
      }
      row.scrollIntoView({ block: 'center', inline: 'nearest' });
      viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
      return {
        ok: viewport.scrollTop > 8,
        scrollTop: viewport.scrollTop,
        firstVisibleName: firstVisibleTreeRowName(),
      };

      function treeViewport() {
        if (!table) return null;
        if (table.matches('[data-overlayscrollbars-viewport]')) return table;
        return table.querySelector('[data-overlayscrollbars-viewport]') ?? table;
      }

      function treeRowByName(value) {
        const rows = [...document.querySelectorAll('.files-table [data-file-entry="true"]:not(.sticky-row)')]
          .filter((candidate) => candidate.offsetParent !== null);
        return rows.find((candidate) =>
          candidate.getAttribute('data-entry-kind') === 'directory' &&
          basename(candidate.getAttribute('data-entry-path') ?? candidate.querySelector('.name-cell')?.textContent?.trim() ?? '') === value
        );
      }

      function firstVisibleTreeRowName() {
        const root = treeViewport();
        if (!root) return '';
        const rootRect = root.getBoundingClientRect();
        const rows = [...document.querySelectorAll('.files-table .files-row[data-file-entry="true"]:not(.sticky-row)')]
          .filter((candidate) => candidate.offsetParent !== null);
        const row = rows.find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          return rect.bottom > rootRect.top + 2 && rect.top < rootRect.bottom - 2;
        });
        return row ? basename(row.getAttribute('data-entry-path') ?? row.textContent?.trim() ?? '') : '';
      }

      function basename(value) {
        const normalized = value.replace(/\\\\/g, '/').replace(/\\/+$/, '');
        return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
      }
    `);
  }

  async function treeScrollState() {
    return await execute(`
      const table = document.querySelector('.files-table');
      const viewport = treeViewport();
      return {
        scrollTop: viewport?.scrollTop ?? 0,
        firstVisibleName: firstVisibleTreeRowName(),
      };

      function treeViewport() {
        if (!table) return null;
        if (table.matches('[data-overlayscrollbars-viewport]')) return table;
        return table.querySelector('[data-overlayscrollbars-viewport]') ?? table;
      }

      function firstVisibleTreeRowName() {
        const root = treeViewport();
        if (!root) return '';
        const rootRect = root.getBoundingClientRect();
        const rows = [...document.querySelectorAll('.files-table .files-row[data-file-entry="true"]:not(.sticky-row)')]
          .filter((candidate) => candidate.offsetParent !== null);
        const row = rows.find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          return rect.bottom > rootRect.top + 2 && rect.top < rootRect.bottom - 2;
        });
        return row ? basename(row.getAttribute('data-entry-path') ?? row.textContent?.trim() ?? '') : '';
      }

      function basename(value) {
        const normalized = value.replace(/\\\\/g, '/').replace(/\\/+$/, '');
        return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
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

  function driveNameForPath(value) {
    const normalized = value.replace(/\\/g, "/");
    const match = normalized.match(/^([A-Za-z]):\//);
    return match ? `${match[1].toUpperCase()}:` : "";
  }

  async function pageSummary() {
    if (!sessionId) return "no WebDriver session";
    return await treeRows().then((rows) => JSON.stringify(rows, null, 2));
  }

  function stopProcess(child) {
    if (!child.pid || child.exitCode !== null) return;
    child.kill();
  }
});
