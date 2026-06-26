/*
 * Test content:
 *
 * Feature:
 * Verifies Terminal Agent helper packaging for persistent terminal sessions.
 *
 * Operation:
 * Reads package scripts, the Tauri config, the release workflow, the Go
 * Terminal Agent module, and the terminal runtime source without executing
 * platform-specific binaries.
 *
 * Expected:
 * The repository defines a standalone Go tool at
 * `tools/nocturne-terminal-agent`, builds target-specific helper binaries into
 * bundled Tauri resources through Go cross-compilation, and keeps the runtime
 * resource path matrix aligned with the build and release workflow. The helper
 * scaffold records the persistent-session daemon contract: one daemon owns one
 * terminal session, Nocturne passes a JSON launch spec on stdin, registry files
 * are named by `session_id`, include `host_id` as the Nocturne connection
 * identity, use protocol versions, list sessions as NDJSON filtered by host,
 * and serve request_id-correlated NDJSON protocol messages over the recorded
 * endpoint through the helper client for both local and SSH-backed sessions.
 * Long-lived helper subscriptions send 30-second pings on the same connection,
 * accept follow-up NDJSON requests on stdin, forward live-view write/resize
 * controls through the subscription instead of opening a new helper process,
 * do the same for SSH-backed live ToolTabs through the existing remote
 * subscribe exec channel, detach closes the helper subscription after the
 * correlated response, the daemon removes attached clients after 90 seconds
 * without a request, and heartbeat responses stay internal to the helper
 * stream.
 * The workflow and helper script keep CGO disabled by default, with any future
 * Windows ConPTY or PTY exception required to show up explicitly in CI and
 * docs rather than being inferred from the build environment.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Terminal Agent packaging", () => {
  it("defines Go helper build script and bundle resources", () => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    const tauriConfig = JSON.parse(readFileSync(resolve("src-tauri/tauri.conf.json"), "utf8"));
    const releaseWorkflow = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
    const buildScript = readFileSync(resolve("scripts/build-terminal-agents.mjs"), "utf8");
    const validateScript = readFileSync(resolve("scripts/validate-helper-resources.mjs"), "utf8");
    const goMod = readFileSync(resolve("tools/nocturne-terminal-agent/go.mod"), "utf8");
    const mainSource = readFileSync(resolve("tools/nocturne-terminal-agent/cmd/nocturne-terminal-agent/main.go"), "utf8");
    const registrySource = readFileSync(resolve("tools/nocturne-terminal-agent/internal/agent/registry.go"), "utf8");
    const clientSource = readFileSync(resolve("tools/nocturne-terminal-agent/internal/agent/client.go"), "utf8");
    const daemonSource = readFileSync(resolve("tools/nocturne-terminal-agent/internal/agent/daemon.go"), "utf8");
    const daemonTestSource = readFileSync(resolve("tools/nocturne-terminal-agent/internal/agent/daemon_test.go"), "utf8");
    const protocolSource = readFileSync(resolve("tools/nocturne-terminal-agent/internal/agent/protocol.go"), "utf8");
    const windowsTransport = readFileSync(resolve("tools/nocturne-terminal-agent/internal/agent/transport_windows.go"), "utf8");
    const windowsPty = readFileSync(resolve("tools/nocturne-terminal-agent/internal/agent/pty_windows.go"), "utf8");
    const terminalDaemonDoc = readFileSync(resolve("docs/terminal-daemon.md"), "utf8");
    const terminalRuntime = readFileSync(resolve("src-tauri/src/terminal.rs"), "utf8");
    const tauriLib = readFileSync(resolve("src-tauri/src/lib.rs"), "utf8");
    const pageSource = readFileSync(resolve("src/routes/+page.svelte"), "utf8");

    assert.equal(packageJson.scripts["build:terminal-agents"], "node scripts/build-terminal-agents.mjs");
    assert.ok(tauriConfig.bundle.resources.includes("resources/nocturne-terminal-agent/**/*"));
    assert.ok(existsSync(resolve("src-tauri/resources/nocturne-terminal-agent/.gitkeep")));
    assert.match(goMod, /module github\.com\/mslxl\/nocturne-term\/tools\/nocturne-terminal-agent/);
    assert.doesNotMatch(goMod, /tauri|nocturne_lib|nocturne\s*=/);
    assert.match(buildScript, /resolve\(repoRoot, "tools", "nocturne-terminal-agent"\)/);
    assert.match(buildScript, /CGO_ENABLED: "0"/);
    assert.match(releaseWorkflow, /CGO_ENABLED: 0/);
    assert.match(releaseWorkflow, /go-version: "1\.23\.x"/);
    assert.match(buildScript, /Windows ever needs a ConPTY/);
    assert.match(buildScript, /GOOS: target\.goos/);
    assert.match(buildScript, /GOARCH: target\.goarch/);
    assert.match(buildScript, /go", \[/);
    assert.match(buildScript, /NOCTURNE_TERMINAL_AGENT_TARGETS/);
    assert.match(releaseWorkflow, /build_terminal_agents:/);
    assert.match(releaseWorkflow, /actions\/setup-go@v5/);
    assert.match(releaseWorkflow, /NOCTURNE_TERMINAL_AGENT_TARGETS: \$\{\{ matrix\.agent-target \}\}/);
    assert.match(releaseWorkflow, /Upload Terminal Agent release asset/);
    assert.match(releaseWorkflow, /Download Terminal Agents/);
    assert.match(validateScript, /"src-tauri"[\s\S]*"resources"[\s\S]*"nocturne-terminal-agent"/);
    assert.match(validateScript, /linux\/x86_64\/nocturne-terminal-agent/);
    assert.match(validateScript, /windows\/x86_64\/nocturne-terminal-agent\.exe/);
    assert.match(mainSource, /daemon requires --launch-spec-stdin/);
    assert.match(mainSource, /json\.NewDecoder\(stdin\)\.Decode\(&spec\)/);
    assert.match(mainSource, /agent\.RunDaemon\(spec\)/);
    assert.match(mainSource, /client list requires --host-id/);
    assert.match(mainSource, /case "delete"/);
    assert.match(mainSource, /"history"/);
    assert.match(mainSource, /case "rename", "title_change"/);
    assert.match(mainSource, /client command requires --session-id/);
    assert.match(mainSource, /client rename --title requires a non-empty value/);
    assert.match(registrySource, /writeRegistryAtomic/);
    assert.match(registrySource, /registry filename does not match session_id/);
    assert.match(registrySource, /validateTranscriptPath/);
    assert.match(registrySource, /Cols:\s+spec\.Cols/);
    assert.match(registrySource, /Rows:\s+spec\.Rows/);
    assert.match(registrySource, /PixelWidth:\s+spec\.PixelWidth/);
    assert.match(registrySource, /PixelHeight:\s+spec\.PixelHeight/);
    assert.match(registrySource, /DeleteSessionFiles/);
    assert.match(registrySource, /remove transcript/);
    assert.match(registrySource, /Endpoint:\s+Endpoint/);
    assert.match(registrySource, /ProbeSessionInfo\(registry\)/);
    assert.match(protocolSource, /RequestID string\s+`json:"request_id"`/);
    assert.match(clientSource, /LoadRegistry\(sessionID\)/);
    assert.match(clientSource, /dialEndpoint\(registry\.Endpoint\.Path\)/);
    assert.match(clientSource, /func ProbeSessionInfo/);
    assert.match(clientSource, /info returned session_id/);
    assert.match(clientSource, /func DeleteSession/);
    assert.match(clientSource, /ProxySessionRequest\(output, sessionID, "close"/);
    assert.doesNotMatch(clientSource, /--endpoint/);
    assert.match(protocolSource, /type eventLine/);
    assert.match(daemonSource, /RunDaemon\(spec LaunchSpec\)/);
    assert.match(daemonSource, /transcriptFlushInterval = 2 \* time\.Second/);
    assert.match(daemonSource, /transcriptFlushBytes = 64 \* 1024/);
    assert.match(daemonSource, /defaultTranscriptMaxBytes int64 = 64 \* 1024 \* 1024/);
    assert.match(daemonSource, /defaultClientHeartbeatInterval = 30 \* time\.Second/);
    assert.match(daemonSource, /defaultClientHeartbeatTimeout = 90 \* time\.Second/);
    assert.match(daemonSource, /monitorClientHeartbeat/);
    assert.match(daemonSource, /markRequestSeen\(time\.Now\(\)\)/);
    assert.match(daemonSource, /retainTranscriptTail/);
    assert.match(daemonSource, /transcriptBytesAfterClear/);
    assert.match(daemonSource, /hasCursorHomeImmediatelyBefore/);
    assert.match(terminalDaemonDoc, /creates its session registry root and Unix socket runtime directory on\s+demand/);
    assert.match(daemonTestSource, /TestTranscriptTruncatesToCapKeepingNewestChunks/);
    assert.match(daemonTestSource, /TestTranscriptClearScreenDropsHistoryBeforeClear/);
    assert.match(daemonTestSource, /"\\x1b\[H\\x1b\[J"/);
    assert.match(daemonTestSource, /TestAttachedClientTimesOutWithoutHeartbeat/);
    assert.match(daemonTestSource, /TestStreamProxyHeartbeatKeepsSubscriptionAlive/);
    assert.match(daemonTestSource, /TestDaemonInfoReportsLiveAttachedCount/);
    assert.match(daemonTestSource, /TestClientListProbesLiveDaemonStatusAndAttachedCount/);
    assert.match(daemonSource, /request_id is required/);
    assert.match(daemonSource, /liveListedSession/);
    assert.match(daemonSource, /attachedClientCount/);
    assert.match(daemonSource, /case "rename", "title_change"/);
    assert.match(daemonSource, /rewriteRegistry\(state\.registry\)/);
    assert.match(daemonSource, /case "detach":[\s\S]*state\.detachClient\(client\)[\s\S]*client\.writeResponse\(okResponse\(request\.RequestID\)\)[\s\S]*client\.close\(\)/);
    assert.match(daemonSource, /Event:\s+"history"/);
    assert.match(daemonTestSource, /TestClientHistoryReadsExitedTranscriptWithoutDaemon/);
    assert.match(daemonSource, /MarkRegistryExited/);
    assert.match(clientSource, /streamHeartbeat/);
    assert.match(clientSource, /func ProxySessionRequestWithInput\(writer io\.Writer, input io\.Reader/);
    assert.match(clientSource, /proxyInputRequests/);
    assert.match(mainSource, /runClient\(args\[1:\], stdin, stdout\)/);
    assert.match(mainSource, /ProxySessionRequestWithInput\(stdout, stdin/);
    assert.match(clientSource, /WriteSessionHistory\(writer, sessionID, request\.RequestID\)/);
    assert.match(clientSource, /Name:\s+"ping"/);
    assert.match(clientSource, /isHeartbeatResponseLine/);
    assert.match(daemonTestSource, /TestStreamProxyForwardsInputRequestsOnSubscriptionConnection/);
    assert.match(daemonTestSource, /expected detach to close the subscription connection/);
    assert.match(windowsTransport, /github\.com\/Microsoft\/go-winio/);
    assert.match(windowsTransport, /SecurityDescriptor:\s+"D:P\(A;;GA;;;OW\)"/);
    assert.match(windowsPty, /github\.com\/qsocket\/conpty-go/);
    assert.match(windowsPty, /syscall\.EscapeArg/);
    assert.match(terminalDaemonDoc, /CGO stays disabled by default/);
    assert.match(terminalDaemonDoc, /Windows PTY path uses the ConPTY API without CGO/);
    assert.match(terminalDaemonDoc, /One daemon owns exactly one terminal session/);
    assert.match(terminalDaemonDoc, /Every request must include `request_id`/);
    assert.match(terminalDaemonDoc, /Operational client\s+commands take `--session-id`/);
    assert.match(terminalDaemonDoc, /attached_count/);
    assert.match(terminalDaemonDoc, /never written back to the registry/);
    assert.match(terminalDaemonDoc, /client delete --session-id/);
    assert.match(terminalDaemonDoc, /removes both the transcript and registry/);
    assert.match(terminalDaemonDoc, /both local and SSH-backed sessions/);
    assert.match(terminalDaemonDoc, /native system confirmation dialog/);
    assert.match(terminalDaemonDoc, /Nocturne forwards interactive terminal title changes as `title_change`/);
    assert.match(terminalRuntime, /run_local_go_agent_client/);
    assert.match(terminalRuntime, /run_local_go_agent_list/);
    assert.match(terminalRuntime, /run_remote_go_agent_list/);
    assert.match(terminalRuntime, /parse_go_agent_session_list/);
    assert.match(terminalRuntime, /attach_registry_terminal_session/);
    assert.match(terminalRuntime, /open_detached_terminal_session_history/);
    assert.match(terminalRuntime, /spawn_local_go_agent_history_reader/);
    assert.match(terminalRuntime, /spawn_remote_go_agent_history_reader/);
    assert.match(terminalRuntime, /delete_registry_terminal_session/);
    assert.match(terminalRuntime, /prepare_remote_terminal_agent_runtime/);
    assert.match(terminalRuntime, /delete_detached_terminal_session/);
    assert.match(terminalRuntime, /RemoteAgentCommand::Delete/);
    assert.match(terminalRuntime, /RemoteAgentCommand::TitleChange/);
    assert.match(terminalRuntime, /spawn_local_go_agent_history_then_reader/);
    assert.match(terminalRuntime, /spawn_remote_go_agent_history_then_reader/);
    assert.match(terminalRuntime, /spawn_local_go_agent_terminal_reader/);
    assert.match(terminalRuntime, /LocalAgentControlCommand/);
    assert.match(terminalRuntime, /send_local_agent_control_request/);
    assert.match(terminalRuntime, /write_agent_control_request/);
    assert.match(terminalRuntime, /stdin\(Stdio::piped\(\)\)/);
    assert.match(terminalRuntime, /handle_go_agent_response_line/);
    assert.match(terminalRuntime, /agent_write_request/);
    assert.match(terminalRuntime, /agent_resize_request/);
    assert.match(terminalRuntime, /RemoteAgentCommand::Write\(bytes, sender\),[\s\S]*\|\| agent_write_request\(&local_bytes\),[\s\S]*"write"/);
    assert.match(terminalRuntime, /go_terminal_agent_client_command/);
    assert.doesNotMatch(terminalRuntime, /--endpoint/);
    assert.doesNotMatch(terminalRuntime, /--key/);
    assert.doesNotMatch(terminalRuntime, /remote registry attach is not available yet/);
    assert.doesNotMatch(terminalRuntime, /remote registry delete is not available yet/);
    assert.match(tauriLib, /terminal::delete_detached_terminal_session/);
    assert.match(tauriLib, /terminal::update_terminal_title/);
    assert.match(tauriLib, /terminal::rename_terminal_session/);
    assert.match(pageSource, /terminal\.deleteDetached:/);
    assert.match(pageSource, /commands\.deleteDetachedTerminalSession/);
    assert.match(pageSource, /Delete this terminal session and its saved transcript\?/);
    assert.match(pageSource, /session\.detached/);
    assert.match(terminalDaemonDoc, /Events never include `request_id`/);
    assert.match(terminalDaemonDoc, /2 seconds or 64 KiB/);
    assert.match(terminalDaemonDoc, /capped at 64 MiB/);
    assert.match(terminalDaemonDoc, /cursor\s+home followed by `ESC \[ J`/);
    assert.match(terminalDaemonDoc, /clears transcript\s+history through that point/);
    assert.match(terminalDaemonDoc, /keeps the same connection alive by\s+sending\s+`ping` every 30 seconds/);
    assert.match(terminalDaemonDoc, /accept follow-up NDJSON requests on stdin/);
    assert.match(terminalDaemonDoc, /forward them to the same daemon\s+socket\/pipe connection/);
    assert.match(terminalDaemonDoc, /live Terminal\s+ToolTab control channel/);
    assert.match(terminalDaemonDoc, /SSH live ToolTabs write the same NDJSON requests\s+to the stdin side of the existing remote helper `client subscribe` SSH exec\s+channel/);
    assert.match(terminalDaemonDoc, /Remote live control must tolerate temporary SSH\s+backpressure by keeping unsent NDJSON bytes queued/);
    assert.match(terminalDaemonDoc, /closes the helper connection so the Terminal ToolTab's client process exits/);
    assert.match(terminalDaemonDoc, /no request arrives for\s+90\s+seconds/);
    assert.match(terminalDaemonDoc, /not forwarded to Nocturne's terminal event reader/);
    assert.match(terminalRuntime, /load_terminal_agent_bytes_from_app/);
    assert.match(terminalRuntime, /remote_live_control/);
    assert.match(terminalRuntime, /send_remote_agent_backend_request/);
    assert.match(terminalRuntime, /poll_remote_agent_control_requests/);
    assert.match(terminalRuntime, /serialize_agent_control_request/);
    assert.match(terminalRuntime, /drain_remote_agent_pending_writes/);
    assert.match(terminalRuntime, /fail_all_remote_live_control_pending/);
    assert.match(terminalRuntime, /spawn_remote_agent_terminal_reader\([\s\S]*live_control_slot/);
    assert.match(terminalRuntime, /spawn_remote_go_agent_history_then_reader\([\s\S]*live_control_slot/);
    assert.doesNotMatch(terminalRuntime, /remote nocturne-terminal-agent packaging and upload are not implemented yet/);
  });

  it("keeps the Go Terminal Agent target matrix aligned with runtime resource paths", () => {
    const buildScript = readFileSync(resolve("scripts/build-terminal-agents.mjs"), "utf8");
    const releaseWorkflow = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
    const terminalRuntime = readFileSync(resolve("src-tauri/src/terminal.rs"), "utf8");

    const expectedTargets = [
      { os: "linux", arch: "x86_64", goos: "linux", goarch: "amd64", binary: "nocturne-terminal-agent" },
      { os: "linux", arch: "aarch64", goos: "linux", goarch: "arm64", binary: "nocturne-terminal-agent" },
      { os: "linux", arch: "armv7", goos: "linux", goarch: "arm", binary: "nocturne-terminal-agent" },
      { os: "macos", arch: "x86_64", goos: "darwin", goarch: "amd64", binary: "nocturne-terminal-agent" },
      { os: "macos", arch: "aarch64", goos: "darwin", goarch: "arm64", binary: "nocturne-terminal-agent" },
      { os: "windows", arch: "x86_64", goos: "windows", goarch: "amd64", binary: "nocturne-terminal-agent.exe" },
      { os: "windows", arch: "i686", goos: "windows", goarch: "386", binary: "nocturne-terminal-agent.exe" },
    ];

    for (const target of expectedTargets) {
      assert.match(buildScript, new RegExp(`os: "${target.os}"[\\s\\S]*arch: "${target.arch}"[\\s\\S]*goos: "${target.goos}"[\\s\\S]*goarch: "${target.goarch}"[\\s\\S]*binary: "${escapeRegex(target.binary)}"`));
      assert.match(releaseWorkflow, new RegExp(`agent-target: ${target.os}/${target.arch}[\\s\\S]*artifact-path: ${target.os}/${target.arch}`));
    }

    assert.match(buildScript, /goarm: "7"/);
    assert.match(terminalRuntime, /"nocturne-terminal-agent\/\{\}\/\{\}\/\{\}"/);
    assert.match(terminalRuntime, /RemoteResourceTargetArch::Armv7\s*=>\s*"armv7"/);
    assert.match(terminalRuntime, /RemoteResourceTargetOs::Windows\s*=>\s*"nocturne-terminal-agent\.exe"/);
    assert.match(terminalRuntime, /RemoteResourceTargetOs::Linux \| RemoteResourceTargetOs::Macos\s*=>\s*"nocturne-terminal-agent"/);
  });
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
