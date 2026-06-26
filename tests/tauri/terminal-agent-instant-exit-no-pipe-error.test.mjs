#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies a local Terminal Agent session whose command exits immediately is
 * shown as a disconnected terminal instead of surfacing a missing daemon pipe.
 *
 * Operation:
 * Seeds an isolated local host with Terminal Agent mode enabled and an
 * immediate-exit command, launches the real Tauri app, and inspects the first
 * Terminal ToolTab and registry created by startup.
 *
 * Expected:
 * The app creates a Terminal ToolTab, the daemon registry is retained with
 * exit metadata, and the visible terminal output does not include the low-level
 * helper-client "connect daemon endpoint" / named-pipe error.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";
import { optionalEnvPath, resolveTauriTestApplication } from "./tauri-test-application.mjs";
import { test } from "vitest";

test("terminal agent instant exit does not surface missing pipe error", { timeout: 420_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = await resolveTauriTestApplication(repoRoot);
  const isolatedAppConfig = await createIsolatedAppConfigEnv("terminal-agent-instant-exit-no-pipe-error");
  const fixtureHostId = "018f6eb3-6f91-7410-bc43-f927b2236d98";
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
  await rm(terminalAgentStateRoot(), { recursive: true, force: true });

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
    await waitUntil(
      async () => {
        const state = await terminalState();
        return state.surfaceCount === 1 && state.agentSessionIds.length === 1;
      },
      async () => `Terminal Agent ToolTab did not mount\n${await pageSummary()}\n${driverOutput}`,
    );

    let registrySessionId = "";
    await waitUntil(
      async () => {
        const registries = await registryFiles();
        if (registries.length !== 1 || !registries[0].content.includes("[exit]")) return false;
        registrySessionId = registries[0].name.replace(/\.toml$/, "");
        return true;
      },
      async () => `Terminal Agent registry did not record immediate exit\n${JSON.stringify(await registryFiles(), null, 2)}\n${await pageSummary()}\n${driverOutput}`,
    );
    if (!registrySessionId.startsWith("term-") || registrySessionId === "term-1") {
      throw new Error(`Terminal Agent registry session id must be globally unique, got ${registrySessionId}`);
    }

    const state = await terminalState();
    const text = `${state.bodyText}\n${state.terminalText}`;
    if (/terminal agent client failed/i.test(text) || /connect daemon endpoint/i.test(text) || /pipe\\nocturne-terminal-agent/i.test(text)) {
      throw new Error(`Immediate-exit Terminal Agent exposed a low-level endpoint error\n${JSON.stringify(state, null, 2)}\n${await pageSummary()}\n${driverOutput}`);
    }
    if (state.statuses.some((status) => status === "failed")) {
      throw new Error(`Immediate-exit Terminal Agent should not leave a failed terminal status\n${JSON.stringify(state, null, 2)}\n${await pageSummary()}\n${driverOutput}`);
    }
    await deleteDetachedSession(registrySessionId);
    await waitUntil(
      async () => (await registryFiles()).length === 0,
      async () => `Exited Terminal Agent session was not deleted\n${JSON.stringify(await registryFiles(), null, 2)}\n${await pageSummary()}\n${driverOutput}`,
    );

    console.log("tauri terminal agent instant-exit test passed");
  } finally {
    if (sessionId) {
      await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
    }
    stopProcess(tauriDriver);
    await isolatedAppConfig.cleanup();
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
      [
        "version = 1",
        `id = "${fixtureHostId}"`,
        `name = "Instant Exit Host"`,
        `protocol = "local"`,
        "",
        "[local]",
        `command = ${JSON.stringify(immediateExitCommand())}`,
        `args = ${tomlStringArray(immediateExitArgs())}`,
        "env = {}",
        "",
        "[terminal]",
        `agent_mode = "enabled"`,
        "",
      ].join("\n"),
    );
  }

  function immediateExitCommand() {
    return process.platform === "win32" ? "cmd.exe" : "/bin/sh";
  }

  function immediateExitArgs() {
    return process.platform === "win32" ? ["/d", "/c", "exit 0"] : ["-c", "exit 0"];
  }

  function tomlStringArray(values) {
    return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
  }

  function terminalAgentStateRoot() {
    if (process.platform === "win32") {
      return join(isolatedStateRoot, "Nocturne", "terminal-sessions");
    }
    return join(isolatedStateRoot, "nocturne", "terminal-sessions");
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

  async function deleteDetachedSession(registrySessionId) {
    const args = await execute(`
      const surface = document.querySelector('[data-testid="terminal-surface"]');
      const toolTabId = surface?.getAttribute('data-tool-tab-id') ?? '';
      const snapshot = window.__NOCTURNE_WORKSPACE_DEBUG__?.snapshot;
      const workspaceId = snapshot?.active_workspace_id ?? '';
      if (!workspaceId || !toolTabId) {
        return { error: 'missing workspace or terminal ToolTab id', snapshot, toolTabId };
      }
      return {
        input: {
          workspace_id: workspaceId,
          tool_tab_id: toolTabId,
          detached_session_id: arguments[0],
        },
      };
    `, [registrySessionId]);
    if (args.error) {
      throw new Error(`Cannot build delete input: ${JSON.stringify(args, null, 2)}`);
    }
    await withTimeout(
      invokeOk("delete_detached_terminal_session", { input: args.input }),
      15_000,
      async () => `delete_detached_terminal_session did not return\n${await pageSummary()}\n${driverOutput}`,
    );
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

  async function terminalState() {
    return await execute(`
      const surfaces = [...document.querySelectorAll('[data-testid="terminal-surface"]')];
      return {
        surfaceCount: surfaces.length,
        agentSessionIds: surfaces.map((surface) => surface.getAttribute('data-agent-session-id') ?? '').filter(Boolean),
        statuses: surfaces.map((surface) => surface.getAttribute('data-terminal-status') ?? ''),
        readOnly: surfaces.map((surface) => surface.getAttribute('data-terminal-read-only') ?? ''),
        exitText: surfaces.map((surface) => surface.getAttribute('data-terminal-exit-text') ?? ''),
        terminalText: surfaces.map((surface) => surface.querySelector('.xterm-rows')?.textContent ?? surface.textContent ?? '').join('\\n'),
        bodyText: document.body?.innerText ?? '',
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

  async function execute(script, args = []) {
    const response = await withTimeout(
      webdriver("POST", `/session/${sessionId}/execute/sync`, {
        script,
        args,
      }),
      20_000,
      () => `WebDriver execute timed out\n${driverOutput}`,
    );
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

  async function withTimeout(promise, timeoutMs, errorMessage) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(async () => {
        reject(new Error(typeof errorMessage === "function" ? await errorMessage() : errorMessage));
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function pageSummary() {
    if (!sessionId) return "no WebDriver session";
    return await execute(`
      return {
        title: document.title,
        url: location.href,
        bodyText: document.body?.innerText?.slice(0, 1200) ?? '',
        terminals: [...document.querySelectorAll('[data-testid="terminal-surface"]')].map((item) => ({
          sessionId: item.getAttribute('data-session-id'),
          agentSessionId: item.getAttribute('data-agent-session-id'),
          status: item.getAttribute('data-terminal-status'),
          readOnly: item.getAttribute('data-terminal-read-only'),
          exitText: item.getAttribute('data-terminal-exit-text'),
          text: item.textContent?.slice(0, 500) ?? '',
        })),
      };
    `).then((summary) => JSON.stringify(summary, null, 2));
  }

  function stopProcess(child) {
    if (!child.pid || child.exitCode !== null) return;
    child.kill();
  }
});
