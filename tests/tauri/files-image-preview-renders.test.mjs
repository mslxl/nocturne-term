#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies that the Files ToolTab can preview image files in a real Tauri
 * WebView.
 *
 * Operation:
 * Creates a temporary local file fixture with a tiny PNG image, configures a
 * temporary Local Host as the default Workspace host, launches the Tauri
 * application through tauri-driver, selects the PNG in Tree view, waits for the
 * preview request to complete, and inspects the rendered preview image.
 *
 * Expected:
 * Selecting the PNG creates a Preview region with an image preview, the image
 * uses a data:image/png base64 URL returned by the backend preview command, and
 * the browser decodes it to a non-zero natural size.
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

test("files image preview renders", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const isolatedAppConfig = await createIsolatedAppConfigEnv("files-image-preview");
  const fixtureRoot = await createFilesFixture();
  const fixtureHostId = "018f6eb3-6f91-7410-bc43-f927b2236d96";
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
    await waitUntil(async () => {
      const rows = await visibleTreeRowNames();
      return rows.includes("pixel.png");
    }, pageSummary);

    await clickTreeRow("pixel.png");
    await waitUntil(async () => {
      const preview = await imagePreviewState();
      return preview.ok;
    }, pageSummary);

    const preview = await imagePreviewState();
    console.log(`tauri files image preview render test passed\n${JSON.stringify(preview.summary, null, 2)}`);
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
    const root = await mkdtemp(join(tmpdir(), "nocturne-files-image-preview-"));
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    await writeFile(join(root, "pixel.png"), Buffer.from(pngBase64, "base64"));
    await writeFile(join(root, "note.txt"), "text file\n");
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
      `version = 1\nid = "${fixtureHostId}"\nname = "Image Preview Fixture"\nprotocol = "local"\n\n[files]\ndefault_path = ${JSON.stringify(fixtureRoot)}\n\n[local]\nargs = []\nenv = {}\n`,
    );
  }

  async function visibleTreeRowNames() {
    return await execute(`
      return [...document.querySelectorAll('.files-table [data-file-entry="true"]')]
        .filter((row) => row.offsetParent !== null)
        .map((row) => row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? '');
    `);
  }

  async function clickTreeRow(name) {
    const result = await execute(`
      const rows = [...document.querySelectorAll('.files-table [data-file-entry="true"]')]
        .filter((row) => row.offsetParent !== null);
      const row = rows.find((candidate) => candidate.querySelector('.name-cell')?.textContent?.trim() === ${JSON.stringify(name)});
      if (!row) {
        return {
          found: false,
          rows: rows.map((candidate) => candidate.querySelector('.name-cell')?.textContent?.trim() ?? candidate.textContent?.trim() ?? ''),
        };
      }
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + Math.min(24, rect.width / 2),
        clientY: rect.top + rect.height / 2,
        button: 0,
      }));
      return { found: true };
    `);
    if (!result.found) {
      throw new Error(`Tree row ${name} was not found: ${JSON.stringify(result, null, 2)}`);
    }
  }

  async function imagePreviewState() {
    return await execute(`
      const preview = document.querySelector('.tree-preview[aria-label="Preview"], .preview-column[aria-label="Preview"]');
      const image = preview?.querySelector('.image-preview img');
      return {
        ok: Boolean(
          preview &&
          image &&
          image.currentSrc.startsWith('data:image/png;base64,') &&
          image.complete &&
          image.naturalWidth > 0 &&
          image.naturalHeight > 0
        ),
        summary: {
          previewVisible: Boolean(preview),
          imageVisible: Boolean(image),
          srcPrefix: image?.currentSrc.slice(0, 22) ?? "",
          complete: image?.complete ?? false,
          naturalWidth: image?.naturalWidth ?? 0,
          naturalHeight: image?.naturalHeight ?? 0,
        },
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
        bodyText: document.body?.innerText?.slice(0, 1000) ?? '',
        rows: [...document.querySelectorAll('.files-table [data-file-entry="true"]')]
          .map((row) => row.querySelector('.name-cell')?.textContent?.trim() ?? row.textContent?.trim() ?? ''),
        preview: document.querySelector('.tree-preview[aria-label="Preview"]')?.textContent?.slice(0, 500) ?? '',
        imageCount: document.querySelectorAll('.image-preview img').length,
      };
    `).then((summary) => JSON.stringify(summary, null, 2));
  }

  function stopProcess(child) {
    if (child.exitCode !== null) return;
    child.kill();
  }

});
