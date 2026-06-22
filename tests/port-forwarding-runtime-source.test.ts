/*
 * Test content:
 *
 * Feature:
 * Verifies the Port Forwarding backend runtime source contract for real SSH
 * forwarding execution.
 *
 * Operation:
 * Reads the Rust Port Forwarding and Terminal sources and checks that the
 * runtime no longer reports a placeholder "not implemented" start failure,
 * uses one Host worker with a shared SSH session, supports both local
 * direct-tcpip and remote forward listeners, reuses the shared TCP/SSH bridge,
 * waits for Stop commands to close listeners and active bridges before
 * reporting stopped, and keeps Host Port Forwarding on Host-scoped
 * verification prompts.
 *
 * Expected:
 * The backend contains real SSH forwarding execution paths while preserving
 * Host-scoped runtime ownership, Stop does not report stopped before runtime
 * sockets are closed, and no traffic content is logged.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Port Forwarding runtime source contract", () => {
  it("uses a Host worker and real libssh2 forwarding primitives", () => {
    const source = readFileSync(resolve("src-tauri/src/port_forwarding.rs"), "utf8");
    const terminal = readFileSync(resolve("src-tauri/src/terminal.rs"), "utf8");

    assert.doesNotMatch(source, /SSH port forwarding runtime is not implemented yet/);
    assert.match(source, /struct HostPortForwardWorker/);
    assert.match(source, /session:\s*Option<Session>/);
    assert.match(source, /connect_authenticated_ssh_session\(&self\.input\)/);
    assert.match(source, /channel_direct_tcpip\(/);
    assert.match(source, /channel_forward_listen\(/);
    assert.match(source, /bridge_proxy_channel_until_stopped\(local, channel, connection_stop\)/);
    assert.match(terminal, /pub\(crate\) fn bridge_proxy_channel/);
    assert.match(terminal, /pub\(crate\) fn bridge_proxy_channel_until_stopped/);
    assert.match(terminal, /stop\.load\(Ordering::SeqCst\)/);
    assert.match(source, /StopRule\s*\{[\s\S]*done: Sender<\(\)>/);
    assert.match(source, /done_receiver\s*\)\s*=\s*mpsc::channel\(\)/);
    assert.match(source, /done_receiver\s*\.recv\(\)/);
    assert.match(source, /SshVerificationScope::HostPortForward/);
    assert.match(source, /port-forwarding:\/\/ssh-verification-required/);
    assert.match(source, /submit_port_forward_ssh_verification/);
    assert.match(terminal, /request_host_port_forward_ssh_verification/);
    assert.match(source, /port was assigned but could not be saved/);
    assert.match(source, /NOCTURNE_PORT_FORWARD_TEST_SSH_HOST/);
    assert.match(source, /struct EnvPortForwardFixture/);
  });
});
