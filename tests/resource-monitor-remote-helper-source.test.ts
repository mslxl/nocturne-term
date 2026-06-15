/*
 * Test content:
 *
 * Feature:
 * Verifies the Resource Monitor remote helper backend wiring in source code.
 *
 * Operation:
 * Reads the Rust Resource Monitor and Files providers without launching a
 * platform-specific application binary or opening a real SSH connection.
 *
 * Expected:
 * `collect_resource_monitor_snapshot` runs blocking provider work off the
 * Tauri command thread, SSH Workspaces no longer return the old placeholder
 * provider, remote collection resolves a target, loads bundled helper bytes or
 * a same-tag download plan when the configured provider allows the managed
 * agent, reads remote provider mode from Host resource config, applies the
 * unified remote helper policy before deployment, deploys the helper over SFTP
 * only after policy approval, executes the helper, parses NDJSON, and reuses
 * the Files SSH command helpers instead of duplicating command execution code.
 * When Host `resources.remote_provider` is `system_commands`, remote collection
 * returns the system-command snapshot before helper bytes are loaded or
 * uploaded.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Resource Monitor remote helper source", () => {
  it("runs SSH collection through the helper deployment path off the command thread", () => {
    const resources = readFileSync(resolve("src-tauri/src/resources.rs"), "utf8");
    const files = readFileSync(resolve("src-tauri/src/files.rs"), "utf8");

    assert.match(resources, /pub\(crate\) async fn collect_resource_monitor_snapshot/);
    assert.match(resources, /tauri::async_runtime::spawn_blocking/);
    assert.doesNotMatch(resources, /remote resource provider is not connected yet/);
    assert.match(resources, /ConnectionProtocol::Ssh => collect_remote_resource_snapshot/);
    assert.match(resources, /detect_remote_resource_target/);
    assert.match(resources, /remote_provider_mode_for_host_resources\(host\.document\.resources\.as_ref\(\)\)/);
    assert.match(resources, /ResourceRemoteProviderMode::SystemCommands/);
    assert.match(resources, /return collect_remote_system_resource_snapshot\(&connection, target_os\)/);
    assert.match(resources, /LINUX_NVIDIA_SMI_QUERY_COMMAND/);
    assert.match(resources, /load_resource_helper_bytes_from_app/);
    assert.match(resources, /download_resource_helper_after_confirmation/);
    assert.match(resources, /resource_helper_policy\(&app\)\?/);
    assert.match(resources, /fn confirm_resource_helper_upload\(app: &AppHandle, prompt: &ResourceHelperPrompt\)/);
    assert.match(resources, /ResourceHelperPolicy::Ask/);
    assert.match(resources, /if !confirm_resource_helper_upload\(app, &prompt\)/);
    assert.match(resources, /Resource Monitor helper upload was canceled by the user/);
    assert.match(resources, /deploy_resource_helper_if_needed/);
    assert.match(resources, /parse_resource_monitor_agent_ndjson/);
    assert.match(resources, /metrics_from_resource_monitor_agent_events/);
    assert.match(resources, /nocturne-resource-monitor-agent on remote/);
    assert.match(resources, /GITHUB_RELEASE_REPOSITORY: &str = "mslxl\/nocturne-term"/);
    assert.match(resources, /releases\/download\/\{\}\/\{\}/);
    assert.doesNotMatch(resources, /latest/);
    assert.match(files, /pub\(crate\) fn run_remote_command/);
    assert.match(files, /pub\(crate\) fn shell_quote/);
  });
});
