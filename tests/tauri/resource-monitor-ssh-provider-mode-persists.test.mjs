#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies that an editable SSH Workspace Resource Monitor can switch its
 * Host-scoped provider mode to `agent` in the real Tauri WebView without using
 * browser-only cloning behavior that fails on generated Tauri binding objects.
 *
 * Operation:
 * Starts the real Tauri app in an isolated configuration with a user SSH Host
 * pointed at localhost, opens the default Resource Monitor ToolTab, changes the
 * compact provider mode select from `auto` to `agent`, and reads the isolated
 * Host TOML file from disk after the UI update.
 *
 * Expected:
 * The provider mode select remains on `agent`, no structuredClone error is
 * shown in the Resource Monitor warning area, and the Host TOML persists
 * `[resources].remote_provider = "agent"` without requiring the test to
 * hard-code a machine-specific SSH credential.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
const isolatedAppConfig = await createIsolatedAppConfigEnv("resource-monitor-ssh-provider-mode-persists");
const nativeDriverPath = optionalEnvPath("TAURI_TEST_NATIVE_DRIVER");
const driverPort = Number(process.env.TAURI_TEST_DRIVER_PORT ?? "4444");
const driverUrl = `http://127.0.0.1:${driverPort}`;
const devUrl = process.env.TAURI_TEST_DEV_URL ?? "http://localhost:1420/";
const devPort = Number(new URL(devUrl).port);
const nativeDriverArgs = nativeDriverPath ? ["--native-driver", nativeDriverPath] : [];
const fixtureHostId = "018f6eb3-6f91-7410-bc43-f927b2236d98";
const hostFilePath = resolve(isolatedAppConfig.env.NOCTURNE_CONFIG_ROOT, "hosts", `${fixtureHostId}.toml`);

process.chdir(repoRoot);
process.env.NOCTURNE_DEV_PORT = String(devPort);
isolatedAppConfig.env.NOCTURNE_DEV_PORT = String(devPort);

await writeFixtureConfig();

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

const tauriDriver = spawn(
  "tauri-driver",
  ["--port", String(driverPort), ...nativeDriverArgs],
  {
    cwd: repoRoot,
    env: isolatedAppConfig.env,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

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

  await waitUntil(async () => {
    const state = await providerModeState();
    return state.visible &&
      state.selectVisible &&
      !state.selectDisabled &&
      state.value === "auto";
  }, async () => `Resource Monitor provider mode select did not mount\n${JSON.stringify(await providerModeState(), null, 2)}\n${driverOutput}`);

  await setProviderMode("agent");

  await waitUntil(async () => {
    const state = await providerModeState();
    const hostFile = await readFile(hostFilePath, "utf8");
    return state.value === "agent" &&
      !state.warningText.includes("structuredClone") &&
      hostFile.includes("[resources]") &&
      hostFile.includes('remote_provider = "agent"');
  }, async () => {
    const hostFile = await readFile(hostFilePath, "utf8").catch((error) => String(error));
    return `Resource Monitor provider mode did not persist agent\n${JSON.stringify(await providerModeState(), null, 2)}\n${hostFile}\n${driverOutput}`;
  });

  console.log("tauri Resource Monitor SSH provider mode persistence test passed");
} finally {
  if (sessionId) {
    await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
  }
  stopProcess(tauriDriver);
  await devServer.close();
  await isolatedAppConfig.cleanup();
}

async function writeFixtureConfig() {
  const configRoot = isolatedAppConfig.env.NOCTURNE_CONFIG_ROOT;
  await mkdir(resolve(configRoot, "hosts"), { recursive: true });
  await mkdir(resolve(configRoot, "profiles"), { recursive: true });
  await writeFile(
    resolve(configRoot, "config.toml"),
    `default_host = "${fixtureHostId}"\nopenssh_config_files = []\n`,
  );
  await writeFile(resolve(configRoot, "profiles", "default.toml"), "");
  await writeFile(
    hostFilePath,
    [
      "version = 1",
      `id = "${fixtureHostId}"`,
      'name = "Local SSH Resource Fixture"',
      'protocol = "ssh"',
      "",
      "[ssh]",
      'hostname = "127.0.0.1"',
      "port = 22",
      'username = "nocturne-test"',
      "forward_agent = false",
      "",
      "[resources]",
      'remote_provider = "auto"',
      "",
    ].join("\n"),
  );
}

async function setProviderMode(value) {
  await execute(`
    const select = document.querySelector('[data-testid="resource-monitor-provider-mode"]');
    if (!select) {
      throw new Error("provider mode select not found");
    }
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event("change", { bubbles: true }));
  `);
}

async function providerModeState() {
  return await execute(`
    const root = document.querySelector('[data-testid="resource-monitor-tooltab"]');
    const select = root?.querySelector('[data-testid="resource-monitor-provider-mode"]');
    const warning = root?.querySelector('.resource-monitor-warning');
    return {
      visible: Boolean(root),
      selectVisible: Boolean(select),
      selectDisabled: Boolean(select?.disabled),
      value: select?.value ?? "",
      warningText: warning?.textContent?.trim() ?? "",
      providerLabel: root?.querySelector('[data-testid="resource-monitor-provider-label"]')?.textContent?.trim() ?? "",
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

function stopProcess(child) {
  if (!child.killed) {
    child.kill();
  }
}
