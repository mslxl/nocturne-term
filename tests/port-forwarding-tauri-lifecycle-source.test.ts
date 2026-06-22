/*
 * Test content:
 *
 * Feature:
 * Verifies the Port Forwarding real Tauri WebView lifecycle test source.
 *
 * Operation:
 * Reads the Tauri test file that launches Nocturne through tauri-driver and
 * inspects it for the Host-scoped Port Forwarding lifecycle scenarios:
 * default bottom panel placement, unsupported Local Host state, shared same-Host
 * state, and final same-Host close-protection state.
 *
 * Expected:
 * The repository keeps a runnable Tauri WebView test for the Port Forwarding
 * lifecycle and the test uses real Tauri commands plus DOM assertions rather
 * than only checking static source strings in the application code.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

describe("Port Forwarding Tauri lifecycle test source", () => {
  it("covers Host-scoped Ports placement, unsupported state, sharing, and close protection", async () => {
    const source = await readFile(
      new URL("./tauri/port-forwarding-workspace-lifecycle.test.mjs", import.meta.url),
      "utf8",
    );

    assert.match(source, /tauri-driver/);
    assert.match(source, /resolveTauriTestApplication/);
    assert.match(source, /createIsolatedAppConfigEnv/);
    assert.match(source, /get_workspace_layout_snapshot/);
    assert.match(source, /workspace_dispatch/);
    assert.match(source, /get_port_forward_snapshot/);
    assert.match(source, /tools\.get\(slot\.tool_tab_id\)\?\.kind === 'ports'/);
    assert.match(source, /start_port_forward_rule/);
    assert.match(source, /rightGroupKinds\.join\(","\) === "resources,transfers"/);
    assert.match(source, /rightGroupActiveKind === "resources"/);
    assert.match(source, /portsGroupKinds\.join\(","\) === "ports"/);
    assert.match(source, /portsGroupRole === "side_panel"/);
    assert.match(source, /port-forwarding-unsupported/);
    assert.match(source, /Second same-Host Workspace did not show shared Host port state/);
    assert.match(source, /Closing one same-Host Workspace removed shared Host port state/);
    assert.match(source, /Expected one final same-Host Workspace before close protection/);
    const pageSource = await readFile(new URL("../src/routes/+page.svelte", import.meta.url), "utf8");
    assert.match(pageSource, /confirmWorkspacePortForwardClose/);
    assert.match(pageSource, /Close this workspace and stop/);
  });
});
