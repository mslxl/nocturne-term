#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies that the Files toolbar action controls stay inside the Files
 * ToolTab when the Files dock group is narrow in a real Tauri WebView.
 *
 * Operation:
 * Starts the Vite dev server, starts tauri-driver, launches the Tauri
 * application provided by TAURI_TEST_APPLICATION, narrows the Files dock group
 * inside the real DOM, measures the Files toolbar and every visible toolbar
 * action button with getBoundingClientRect(), and captures a screenshot if the
 * measurement fails.
 *
 * Expected:
 * The Files toolbar does not have horizontal overflow, every visible toolbar
 * action button stays within the measured toolbar and ToolTab width, and the
 * toolbar actions may wrap to additional rows instead of clipping past the
 * ToolTab edge.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";
import { test } from "vitest";

test("files toolbar actions do not overflow narrow tooltab", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("files-toolbar-actions-narrow");
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

    const measurement = await measureNarrowFilesToolbar();
    if (!measurement.ok) {
      const screenshotPath = await saveScreenshot("files-toolbar-actions-overflow.png");
      throw new Error(`${measurement.reason}\n${JSON.stringify(measurement, null, 2)}\nscreenshot: ${screenshotPath}`);
    }

    console.log(`tauri files toolbar actions narrow ToolTab overflow test passed\n${JSON.stringify(measurement.summary, null, 2)}`);
  } finally {
    if (sessionId) {
      await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
    }
    stopProcess(tauriDriver);
    await devServer.close();
    await isolatedAppConfig.cleanup();
  }

  async function measureNarrowFilesToolbar() {
    return await execute(`
      const files = document.querySelector('.files-tooltab');
      const toolbar = files?.querySelector('.files-toolbar');
      const dockGroup = files?.closest('.workspace-dock-group');
      const split = dockGroup?.parentElement;
      if (!files || !toolbar || !dockGroup || !split) {
        return { ok: false, reason: 'Files ToolTab, toolbar, or dock group missing' };
      }

      split.style.gridTemplateColumns = '150px 5px minmax(0, 1fr)';
      split.style.width = '100%';
      dockGroup.style.minWidth = '0';
      files.style.minWidth = '0';

      const toolbarRect = toolbar.getBoundingClientRect();
      const filesRect = files.getBoundingClientRect();
      const buttons = [...toolbar.querySelectorAll('button')]
        .filter((button) => button.offsetParent !== null)
        .map((button) => {
          const rect = button.getBoundingClientRect();
          return {
            label: button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent,
            left: rect.left,
            right: rect.right,
            width: rect.width,
            overflowsRight: rect.right > toolbarRect.right + 0.5,
            overflowsLeft: rect.left < toolbarRect.left - 0.5,
            overflowsToolTabRight: rect.right > filesRect.right + 0.5,
            overflowsToolTabLeft: rect.left < filesRect.left - 0.5,
          };
        });
      const overflowingButtons = buttons.filter((button) =>
        button.overflowsRight ||
        button.overflowsLeft ||
        button.overflowsToolTabRight ||
        button.overflowsToolTabLeft
      );
      const toolbarOverflows = toolbar.scrollWidth > toolbar.clientWidth + 1;
      const toolbarOverflowsToolTab = toolbarRect.right > filesRect.right + 0.5 || toolbarRect.left < filesRect.left - 0.5;

      return {
        ok: !toolbarOverflows && !toolbarOverflowsToolTab && overflowingButtons.length === 0,
        reason: toolbarOverflows
          ? 'Files toolbar has horizontal overflow'
          : toolbarOverflowsToolTab
            ? 'Files toolbar overflows the Files ToolTab bounds'
            : overflowingButtons.length
              ? 'Files toolbar buttons overflow toolbar bounds'
              : '',
        filesWidth: filesRect.width,
        toolbarClientWidth: toolbar.clientWidth,
        toolbarScrollWidth: toolbar.scrollWidth,
        toolbarOverflowsToolTab,
        summary: {
          filesWidth: filesRect.width,
          toolbarClientWidth: toolbar.clientWidth,
          toolbarScrollWidth: toolbar.scrollWidth,
          toolbarWidth: toolbarRect.width,
          visibleButtonCount: buttons.length,
          maxButtonRight: buttons.reduce((max, button) => Math.max(max, button.right), 0),
        },
        toolbarRect: { left: toolbarRect.left, right: toolbarRect.right, width: toolbarRect.width },
        buttons,
        overflowingButtons,
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
        filesToolbarExists: document.querySelector('.files-tooltab .files-toolbar') !== null,
        dockGroups: [...document.querySelectorAll('.workspace-dock-group')].map((group) => ({
          id: group.getAttribute('data-dock-group-id'),
          role: group.getAttribute('data-dock-group-role'),
          text: group.textContent?.slice(0, 300),
        })),
      };
    `).then((summary) => JSON.stringify(summary, null, 2));
  }

  function stopProcess(child) {
    if (!child.pid || child.exitCode !== null) return;
    child.kill();
  }

});
