#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies Terminal Sessions deletion removes a stale Terminal Agent registry
 * whose daemon endpoint is already gone.
 *
 * Operation:
 * Builds the current-platform Terminal Agent helper, seeds an isolated local
 * Host with a registry and transcript that have no exit metadata and point at
 * a missing endpoint, launches the real Tauri app, opens Terminals, invokes
 * delete_detached_terminal_session through the same Tauri command used by the
 * ToolTab, and inspects the registry state.
 *
 * Expected:
 * Explicit deletion succeeds even when the daemon endpoint cannot be reached,
 * both registry and transcript files are removed, and Terminals no longer
 * lists the stale session after refresh.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";
import { optionalEnvPath, resolveTauriTestApplication } from "./tauri-test-application.mjs";
import { test } from "vitest";

test("terminal sessions delete stale registry", { timeout: 420_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = await resolveTauriTestApplication(repoRoot);
  const isolatedAppConfig = await createIsolatedAppConfigEnv("terminal-sessions-delete-stale-registry");
  const fixtureHostId = "018f6eb3-6f91-7410-bc43-f927b2236d98";
  const fixtureSessionId = "terminal-session-stale-delete";
  const isolatedStateRoot = process.platform === "win32"
    ? join(isolatedAppConfig.root, "localappdata")
    : join(isolatedAppConfig.root, "xdg-state");
  if (process.platform === "win32") {
    isolatedAppConfig.env.LOCALAPPDATA = isolatedStateRoot;
  } else {
    isolatedAppConfig.env.XDG_STATE_HOME = isolatedStateRoot;
  }

  const nativeDriverPath = optionalEnvPath("TAURI_TEST_NATIVE_DRIVER");
  const nativeDriverPort = process.env.TAURI_TEST_NATIVE_DRIVER_PORT ?? "";
  const driverPort = Number(process.env.TAURI_TEST_DRIVER_PORT ?? "4444");
  const driverUrl = `http://127.0.0.1:${driverPort}`;
  const nativeDriverArgs = [
    ...(nativeDriverPath ? ["--native-driver", nativeDriverPath] : []),
    ...(nativeDriverPort ? ["--native-port", nativeDriverPort] : []),
  ];

  process.chdir(repoRoot);
  process.env.NOCTURNE_DEV_PORT = String(new URL(process.env.TAURI_TEST_DEV_URL ?? "http://127.0.0.1:1420/").port);
  isolatedAppConfig.env.NOCTURNE_DEV_PORT = process.env.NOCTURNE_DEV_PORT;

  await configureFixtureHost();
  await seedStaleLocalTerminalSession();

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
    await waitForDriver();
    sessionId = await createSession();
    await waitUntil(async () => await hasTestHooks(), async () => `Nocturne test hooks were not published\n${await pageSummary()}`);
    await openTerminalSessionsViaTestHook();
    await waitUntil(
      async () => {
        const state = await terminalSessionsState();
        return state.fixtureRowCount === 1 && state.text.includes("Stale Delete") && state.text.includes("Detached");
      },
      async () => `Terminals did not render the stale registry row\n${JSON.stringify(await terminalSessionsState(), null, 2)}\n${await pageSummary()}`,
    );

    await deleteFixtureSession();
    await waitUntil(async () => !(await pathExists(registryPath())) && !(await pathExists(transcriptPath())), async () => {
      return `Stale registry/transcript were not removed\n${JSON.stringify(await registryFiles(), null, 2)}\n${await pageSummary()}\n${driverOutput}`;
    });
    await clickRefreshTerminalSessions();
    await waitUntil(
      async () => (await terminalSessionsState()).fixtureRowCount === 0,
      async () => `Terminals still listed the deleted stale session\n${JSON.stringify(await terminalSessionsState(), null, 2)}\n${await pageSummary()}`,
    );

    console.log("tauri terminal sessions stale-delete test passed");
  } finally {
    if (sessionId) {
      await deleteRemainingRegistrySessions().catch(() => undefined);
      await waitUntil(
        async () => (await registryFiles()).length === 0,
        async () => `terminal agent sessions remained after stale-delete test cleanup\n${JSON.stringify(await registryFiles(), null, 2)}\n${await pageSummary()}\n${driverOutput}`,
        10_000,
      ).catch(() => undefined);
    }
    if (sessionId) {
      await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
    }
    stopProcess(tauriDriver);
    await isolatedAppConfig.cleanup();
  }

  async function seedStaleLocalTerminalSession() {
    const stateRoot = terminalAgentStateRoot();
    await rm(stateRoot, { recursive: true, force: true });
    await mkdir(stateRoot, { recursive: true });
    const registry = {
      version: 1,
      session_id: fixtureSessionId,
      host_id: fixtureHostId,
      title: "Stale Delete",
      command: "bash",
      cwd: "/workspace",
      created_at: "2026-06-25T00:00:00Z",
      agent_version: "0.1.0",
      protocol_version: 1,
      cols: 80,
      rows: 24,
      endpoint: {
        kind: process.platform === "win32" ? "windows_named_pipe" : "unix_socket",
        path: process.platform === "win32" ? String.raw`\\.\pipe\nocturne-terminal-stale-delete-missing` : "/tmp/nocturne-terminal-stale-delete-missing.sock",
      },
      transcript: `${fixtureSessionId}.ndjson`,
    };
    await writeFile(registryPath(), toToml(registry));
    await writeFile(transcriptPath(), "stale transcript\n");
  }

  function terminalAgentStateRoot() {
    if (process.platform === "win32") {
      return join(isolatedStateRoot, "Nocturne", "terminal-sessions");
    }
    return join(isolatedStateRoot, "nocturne", "terminal-sessions");
  }

  function registryPath() {
    return join(terminalAgentStateRoot(), `${fixtureSessionId}.toml`);
  }

  function transcriptPath() {
    return join(terminalAgentStateRoot(), `${fixtureSessionId}.ndjson`);
  }

  async function pathExists(path) {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async function registryFiles() {
    const root = terminalAgentStateRoot();
    try {
      const names = await readdir(root);
      const tomlNames = names.filter((name) => name.endsWith(".toml")).sort();
      return await Promise.all(tomlNames.map(async (name) => ({
        name,
        content: await readFile(join(root, name), "utf8"),
      })));
    } catch {
      return [];
    }
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
      `version = 1\nid = "${fixtureHostId}"\nname = "Session Host"\nprotocol = "local"\n\n[local]\nargs = []\nenv = {}\n\n[terminal]\nagent_mode = "enabled"\n`,
    );
  }

  function toToml(registry) {
    return [
      `version = ${registry.version}`,
      `session_id = "${registry.session_id}"`,
      `host_id = "${registry.host_id}"`,
      `title = "${registry.title}"`,
      `command = "${registry.command}"`,
      `cwd = "${registry.cwd}"`,
      `created_at = "${registry.created_at}"`,
      `agent_version = "${registry.agent_version}"`,
      `protocol_version = ${registry.protocol_version}`,
      `cols = ${registry.cols}`,
      `rows = ${registry.rows}`,
      `transcript = "${registry.transcript}"`,
      `[endpoint]`,
      `kind = "${registry.endpoint.kind}"`,
      `path = "${registry.endpoint.path.replace(/\\/g, "\\\\")}"`,
      "",
    ].join("\n");
  }

  async function hasTestHooks() {
    return await execute(`
      return Boolean(window.__NOCTURNE_TEST_HOOKS__);
    `);
  }

  async function openTerminalSessionsViaTestHook() {
    return await execute(`
      const hooks = window.__NOCTURNE_TEST_HOOKS__;
      if (!hooks) throw new Error('Nocturne test hooks not found');
      hooks.openTerminalSessions();
    `);
  }

  async function clickRefreshTerminalSessions() {
    return await execute(`
      const button = document.querySelector('[data-testid="terminal-sessions-tooltab"] button[aria-label="Refresh terminals"]');
      if (!button) throw new Error('Terminals refresh button not found');
      button.click();
    `);
  }

  async function deleteFixtureSession() {
    const input = await execute(`
      const tooltab = document.querySelector('[data-testid="terminal-sessions-tooltab"]');
      const toolTabId = tooltab?.getAttribute('data-tool-tab-id') ?? '';
      const snapshot = window.__NOCTURNE_WORKSPACE_DEBUG__?.snapshot;
      const workspaceId = snapshot?.active_workspace_id ?? '';
      if (!workspaceId || !toolTabId) {
        return { error: 'missing workspace or Terminals ToolTab id', snapshot, toolTabId };
      }
      return {
        workspace_id: workspaceId,
        tool_tab_id: toolTabId,
        detached_session_id: arguments[0],
      };
    `, [fixtureSessionId]);
    if (input.error) {
      throw new Error(`Cannot build terminal delete input: ${JSON.stringify(input, null, 2)}`);
    }
    await invokeOk("delete_detached_terminal_session", { input });
  }

  async function deleteRemainingRegistrySessions() {
    const remaining = await registryFiles();
    for (const registry of remaining) {
      const registrySessionId = registry.name.replace(/\.toml$/, "");
      const input = await buildDeleteInput(registrySessionId);
      if (input.error) continue;
      await invokeOk("delete_detached_terminal_session", { input });
    }
  }

  async function buildDeleteInput(registrySessionId) {
    return await execute(`
      const tooltab = document.querySelector('[data-testid="terminal-sessions-tooltab"]');
      const terminal = document.querySelector('[data-testid="terminal-surface"]');
      const toolTabId = tooltab?.getAttribute('data-tool-tab-id') ?? terminal?.getAttribute('data-tool-tab-id') ?? '';
      const snapshot = window.__NOCTURNE_WORKSPACE_DEBUG__?.snapshot;
      const workspaceId = snapshot?.active_workspace_id ?? '';
      if (!workspaceId || !toolTabId) {
        return { error: 'missing workspace or ToolTab id', snapshot, toolTabId };
      }
      return {
        workspace_id: workspaceId,
        tool_tab_id: toolTabId,
        detached_session_id: arguments[0],
      };
    `, [registrySessionId]);
  }

  async function terminalSessionsState() {
    return await execute(`
      const tooltab = document.querySelector('[data-testid="terminal-sessions-tooltab"]');
      return {
        visible: Boolean(tooltab),
        rowCount: tooltab?.querySelectorAll('[data-testid="terminal-session-row"]').length ?? 0,
        fixtureRowCount: tooltab?.querySelectorAll('[data-testid="terminal-session-row"][data-session-id="' + arguments[0] + '"]').length ?? 0,
        text: tooltab?.textContent?.trim() ?? '',
      };
    `, [fixtureSessionId]);
  }

  async function invokeOk(command, args = {}) {
    const value = await execute(`
      const stringifyError = (error) => {
        if (error instanceof Error) return error.message;
        try {
          const serialized = JSON.stringify(error);
          return serialized === undefined ? String(error) : serialized;
        } catch {
          return String(error);
        }
      };
      try {
        const result = await window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]);
        if (result && result.status === 'error') {
          return { __nocturneInvokeError: stringifyError(result.error) };
        }
        return result && result.status === 'ok' ? result.data : result;
      } catch (error) {
        return { __nocturneInvokeError: stringifyError(error) };
      }
    `, [command, args]);
    if (value && typeof value === "object" && "__nocturneInvokeError" in value) {
      throw new Error(`Tauri command ${command} failed: ${value.__nocturneInvokeError}`);
    }
    return value;
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

  async function execute(script, args = []) {
    const response = await webdriver("POST", `/session/${sessionId}/execute/sync`, {
      script,
      args,
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

  async function pageSummary() {
    if (!sessionId) return "no WebDriver session";
    return await execute(`
      return {
        title: document.title,
        url: location.href,
        bodyText: document.body?.innerText?.slice(0, 1000) ?? '',
        workspaceDebug: window.__NOCTURNE_WORKSPACE_DEBUG__ ?? null,
        terminalSessions: document.querySelector('[data-testid="terminal-sessions-tooltab"]')?.textContent?.slice(0, 400) ?? '',
      };
    `).then((summary) => JSON.stringify(summary, null, 2));
  }

  function stopProcess(child) {
    if (!child.pid || child.exitCode !== null) return;
    child.kill();
  }
});
