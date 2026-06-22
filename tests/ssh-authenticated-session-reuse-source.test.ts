/*
 * Test content:
 *
 * Feature:
 * Verifies that SSH-backed subsystems reuse the shared authenticated SSH
 * session helper instead of duplicating host-key trust, ProxyJump, and
 * credential authentication policy.
 *
 * Operation:
 * Reads the Rust Terminal and Files sources and checks that Terminal defines
 * `connect_authenticated_ssh_session`, Terminal session preparation delegates
 * to it, and Files SFTP setup calls the same helper without directly invoking
 * lower-level authentication or host-key verification primitives.
 *
 * Expected:
 * Terminal, Files, and future Port Forwarding runtime work can share one SSH
 * authentication/trust policy path, preventing drift between ToolTabs.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Authenticated SSH session helper reuse", () => {
  it("keeps Files SFTP connection setup on the shared Terminal SSH helper", () => {
    const terminal = readFileSync(resolve("src-tauri/src/terminal.rs"), "utf8");
    const files = readFileSync(resolve("src-tauri/src/files.rs"), "utf8");

    assert.match(terminal, /pub\(crate\) struct AuthenticatedSshSession/);
    assert.match(terminal, /pub\(crate\) fn connect_authenticated_ssh_session/);
    assert.match(
      terminal,
      /fn prepare_ssh_session\([^)]*\)[\s\S]*?connect_authenticated_ssh_session\(input\)\?/
    );

    assert.match(files, /connect_authenticated_ssh_session/);
    assert.match(
      files,
      /fn connect_sftp_session\([^)]*\)[\s\S]*?connect_authenticated_ssh_session\(input\)\?/
    );
    assert.doesNotMatch(files, /verify_ssh_host_key\(/);
    assert.doesNotMatch(files, /authenticate_ssh_session\(/);
    assert.doesNotMatch(files, /connect_proxy_jump_chain\(/);
    assert.doesNotMatch(files, /parse_sftp_proxy_jump_chain/);
  });

  it("keeps Port Forwarding on a Host runtime verification scope", () => {
    const portForwarding = readFileSync(resolve("src-tauri/src/port_forwarding.rs"), "utf8");

    assert.match(portForwarding, /connect_authenticated_ssh_session/);
    assert.match(portForwarding, /workspace_id:\s*format!\("host-port-forward:\{\}", host\.id\)/);
    assert.match(portForwarding, /verification_scope:\s*crate::terminal::SshVerificationScope::HostPortForward/);
    assert.doesNotMatch(portForwarding, /workspace_ssh_coordinator\(\)\.request_verification/);
  });
});
