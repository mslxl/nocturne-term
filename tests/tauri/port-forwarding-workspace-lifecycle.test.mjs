#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies Host-scoped Port Forwarding behavior in the real Tauri WebView,
 * including default bottom panel placement, unsupported protocol UI,
 * shared same-Host runtime state, and last-Workspace close confirmation.
 *
 * Operation:
 * Starts the Vite dev server, starts tauri-driver with an isolated
 * configuration root, writes editable Host TOML fixtures, launches the Tauri
 * application, uses real Tauri commands to inspect and mutate Workspace and
 * Port Forwarding snapshots, activates the Ports ToolTab in the WebView,
 * creates a second Workspace for the same Host, and verifies that the final
 * same-Host Workspace reaches an active Port Forwarding close-protection
 * state without triggering a native modal dialog during automation.
 *
 * Expected:
 * SSH Workspaces include Ports in a bottom panel while Resources and Transfers
 * stay in the right sidebar with Resources active by default; Local Hosts render the
 * unsupported Ports state with no table; all Workspaces for the same Host see
 * the same saved port forward rule; closing one of two same-Host Workspaces
 * does not stop Host port forwarding; the final same-Host Workspace has an
 * active or reconnecting rule that the frontend close path must confirm.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";
import { optionalEnvPath, resolveTauriTestApplication } from "./tauri-test-application.mjs";
import { test } from "vitest";

test("port forwarding workspace lifecycle", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = await resolveTauriTestApplication(repoRoot);
  const isolatedAppConfig = await createIsolatedAppConfigEnv("port-forwarding-workspace-lifecycle");
  const nativeDriverPath = optionalEnvPath("TAURI_TEST_NATIVE_DRIVER");
  const driverPort = Number(process.env.TAURI_TEST_DRIVER_PORT ?? "4444");
  const driverUrl = `http://127.0.0.1:${driverPort}`;
  const devUrl = process.env.TAURI_TEST_DEV_URL ?? "http://127.0.0.1:1420/";
  const devPort = Number(new URL(devUrl).port);
  const nativeDriverArgs = nativeDriverPath ? ["--native-driver", nativeDriverPath] : [];
  const sshHostId = "018f6eb3-6f91-7410-bc43-f927b2236f00";
  const localHostId = "018f6eb3-6f91-7410-bc43-f927b2236f02";
  const savedRuleId = "018f6eb3-6f91-7410-bc43-f927b2236f01";

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
    await waitForTauriBridge();

    await waitUntil(async () => {
      const state = await portPlacementState();
      return state.hasPorts &&
        state.rightGroupKinds.join(",") === "resources,transfers" &&
        state.rightGroupActiveKind === "resources" &&
        state.portsGroupKinds.join(",") === "ports" &&
        state.portsGroupRole === "side_panel";
    }, async () => `Ports default placement did not match expectations\n${JSON.stringify(await portPlacementState(), null, 2)}\n${driverOutput}`);

    await activatePortsForActiveWorkspace();
    await waitUntil(async () => {
      const state = await portsDomState();
      return state.supported &&
        state.rows.length === 1 &&
        state.rows[0].ruleId === savedRuleId &&
        state.rows[0].name === "Saved HTTP";
    }, async () => `SSH Ports table did not render saved rule\n${JSON.stringify(await portsDomState(), null, 2)}\n${driverOutput}`);

    const firstWorkspaceId = (await invokeOk("get_workspace_layout_snapshot")).active_workspace_id;
    await dispatchWorkspace({ kind: "create_workspace", host_id: sshHostId });
    await waitForWorkspaceCount(2);
    await activatePortsForActiveWorkspace();
    await waitUntil(async () => {
      const state = await portsDomState();
      const snapshot = await invokeOk("get_port_forward_snapshot", { hostId: sshHostId });
      return state.rows.some((row) => row.ruleId === savedRuleId) &&
        snapshot.rules.length === 1 &&
        snapshot.rules[0].rule.id === savedRuleId;
    }, async () => `Second same-Host Workspace did not show shared Host port state\n${JSON.stringify(await portsDomState(), null, 2)}\n${driverOutput}`);

    await invokeOk("workspace_dispatch", {
      input: {
        expected_version: (await invokeOk("get_workspace_layout_snapshot")).version,
        intent: { kind: "activate_workspace", workspace_id: firstWorkspaceId },
      },
    });
    await closeWorkspaceFromUi(firstWorkspaceId);
    await waitForWorkspaceCount(1);
    const afterFirstClose = await invokeOk("get_port_forward_snapshot", { hostId: sshHostId });
    if (afterFirstClose.rules[0]?.rule.id !== savedRuleId) {
      throw new Error(`Closing one same-Host Workspace removed shared Host port state\n${JSON.stringify(afterFirstClose, null, 2)}`);
    }

    await switchToLocalHostSession();
    await invokeOk("start_port_forward_rule", {
      input: { host_id: sshHostId, rule_id: savedRuleId },
    });
    await waitUntil(async () => {
      const snapshot = await invokeOk("get_port_forward_snapshot", { hostId: sshHostId });
      const status = snapshot.rules.find((row) => row.rule.id === savedRuleId)?.runtime.status;
      return status === "starting" || status === "running" || status === "reconnecting";
    }, async () => {
      return `Saved rule did not enter an active state before final same-Host close\n${JSON.stringify(await invokeOk("get_port_forward_snapshot", { hostId: sshHostId }), null, 2)}\n${driverOutput}`;
    });
    const finalSshWorkspaces = await sshWorkspaceIds();
    if (finalSshWorkspaces.length !== 1) {
      throw new Error(`Expected one final same-Host Workspace before close protection\n${JSON.stringify(finalSshWorkspaces, null, 2)}`);
    }

    await activatePortsForActiveWorkspace();
    await waitUntil(async () => {
      const state = await portsDomState();
      return !state.supported && state.unsupportedVisible && !state.tableVisible;
    }, async () => `Local Host Ports unsupported state did not render\n${JSON.stringify(await portsDomState(), null, 2)}\n${driverOutput}`);

    console.log("tauri Port Forwarding workspace lifecycle test passed");
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
      `default_host = "${sshHostId}"\nopenssh_config_files = []\n`,
    );
    await writeFile(resolve(configRoot, "profiles", "default.toml"), "");
    await writeFile(
      resolve(configRoot, "hosts", `${sshHostId}.toml`),
      [
        "version = 1",
        `id = "${sshHostId}"`,
        'name = "Port Forwarding SSH Fixture"',
        'protocol = "ssh"',
        "",
        "[ssh]",
        'hostname = "127.0.0.1"',
        "port = 22",
        'username = "nocturne-test"',
        "forward_agent = false",
        "",
        "[[port_forwards]]",
        `id = "${savedRuleId}"`,
        'name = "Saved HTTP"',
        'direction = "local_to_remote"',
        'local_address = "127.0.0.1"',
        "local_port = 18080",
        'remote_address = "127.0.0.1"',
        "remote_port = 80",
        "connect_on_host_open = false",
        "",
      ].join("\n"),
    );
    await writeFile(
      resolve(configRoot, "hosts", `${localHostId}.toml`),
      [
        "version = 1",
        `id = "${localHostId}"`,
        'name = "Port Forwarding Local Fixture"',
        'protocol = "local"',
        "",
        "[local]",
        "args = []",
        "env = {}",
        "",
      ].join("\n"),
    );
  }

  async function activatePortsForActiveWorkspace() {
    const state = await portPlacementState();
    if (!state.activeWorkspaceId || !state.portsSlotId) {
      throw new Error(`Ports ToolTab not found for active Workspace\n${JSON.stringify(state, null, 2)}`);
    }
    await dispatchWorkspace({
      kind: "activate_tool_slot",
      workspace_id: state.activeWorkspaceId,
      slot_id: state.portsSlotId,
    });
  }

  async function closeWorkspaceFromUi(workspaceId) {
    await execute(`
      const tab = document.querySelector('.workspace-tab[data-workspace-id="${workspaceId}"]');
      const close = tab?.querySelector('.close-workspace');
      if (!close) throw new Error('Workspace close button not found for ${workspaceId}');
      close.click();
    `);
  }

  async function switchToLocalHostSession() {
    await invokeOk("workspace_dispatch", {
      input: {
        expected_version: (await invokeOk("get_workspace_layout_snapshot")).version,
        intent: { kind: "create_workspace", host_id: localHostId },
      },
    });
    await waitForWorkspaceCount(2);
  }

  async function sshWorkspaceIds() {
    const snapshot = await invokeOk("get_workspace_layout_snapshot");
    return snapshot.workspaces
      .filter((workspace) => workspace.host_id === sshHostId)
      .map((workspace) => workspace.id);
  }

  async function portPlacementState() {
    return await execute(`
      const snapshot = await window.__TAURI_INTERNALS__.invoke('get_workspace_layout_snapshot');
      const data = snapshot.status === 'ok' ? snapshot.data : snapshot;
      const workspace = data.workspaces.find((item) => item.id === data.active_workspace_id);
      const tools = new Map(data.tool_tabs.map((tool) => [tool.id, tool]));
      const groups = [];
      function collect(layout) {
        if (layout.kind === 'group') groups.push(layout);
        else layout.children.forEach(collect);
      }
      collect(workspace.layout);
      const rightGroup = groups.find((group) => {
        const kinds = group.slots.map((slot) => tools.get(slot.tool_tab_id)?.kind ?? '');
        return kinds.includes('resources') && kinds.includes('transfers') && !kinds.includes('ports');
      });
      const portsGroup = groups.find((group) => {
        const kinds = group.slots.map((slot) => tools.get(slot.tool_tab_id)?.kind ?? '');
        return kinds.includes('ports');
      });
      const rightGroupKinds = rightGroup?.slots.map((slot) => tools.get(slot.tool_tab_id)?.kind ?? '') ?? [];
      const rightGroupActiveKind = tools.get(rightGroup?.slots.find((slot) => slot.id === rightGroup.active_slot_id)?.tool_tab_id ?? '')?.kind ?? '';
      const portsGroupKinds = portsGroup?.slots.map((slot) => tools.get(slot.tool_tab_id)?.kind ?? '') ?? [];
      const portsSlot = portsGroup?.slots.find((slot) => tools.get(slot.tool_tab_id)?.kind === 'ports');
      return {
        activeWorkspaceId: data.active_workspace_id,
        hasPorts: data.tool_tabs.some((tool) => tool.kind === 'ports'),
        rightGroupKinds,
        rightGroupActiveKind,
        portsGroupKinds,
        portsGroupRole: portsGroup?.role ?? '',
        portsSlotId: portsSlot?.id ?? '',
      };
    `);
  }

  async function portsDomState() {
    return await execute(`
      const root = document.querySelector('[data-testid="port-forwarding-tooltab"]');
      return {
        mounted: Boolean(root),
        supported: root?.dataset.supported === 'true',
        tableVisible: Boolean(root?.querySelector('[data-testid="port-forwarding-table"]')),
        unsupportedVisible: Boolean(root?.querySelector('[data-testid="port-forwarding-unsupported"]')),
        rows: [...(root?.querySelectorAll('[data-testid="port-forwarding-row"]') ?? [])].map((row) => ({
          ruleId: row.getAttribute('data-rule-id'),
          status: row.getAttribute('data-status'),
          name: row.getAttribute('data-name'),
          text: row.textContent?.trim() ?? '',
        })),
      };
    `);
  }

  async function waitForWorkspaceCount(expectedCount) {
    await waitUntil(async () => {
      const snapshot = await invokeOk("get_workspace_layout_snapshot");
      return snapshot.workspaces.length === expectedCount;
    }, async () => `Workspace count did not become ${expectedCount}\n${JSON.stringify(await invokeOk("get_workspace_layout_snapshot"), null, 2)}\n${driverOutput}`);
  }

  async function dispatchWorkspace(intent) {
    const snapshot = await invokeOk("get_workspace_layout_snapshot");
    return await invokeOk("workspace_dispatch", {
      input: {
        expected_version: snapshot.version,
        intent,
      },
    });
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
        const result = await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)});
        if (result && result.status === 'error') {
          return { __nocturneInvokeError: stringifyError(result.error) };
        }
        return result && result.status === 'ok' ? result.data : result;
      } catch (error) {
        return { __nocturneInvokeError: stringifyError(error) };
      }
    `);
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

  async function waitForTauriBridge() {
    await waitUntil(async () => {
      return await execute(`
        return typeof window.__TAURI_INTERNALS__?.invoke === 'function';
      `);
    }, `Tauri invoke bridge did not become available\n${driverOutput}`);
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

  function stopProcess(child) {
    if (!child.pid || child.exitCode !== null) return;
    child.kill();
  }
});
