# Port Forwarding ToolTab

This document defines Nocturne's Host-scoped port forwarding model, SSH runtime lifecycle, persistence rules, table UI, confirmation behavior, and testing expectations.

## Goals

Port Forwarding lets an SSH Host expose TCP tunnels in both directions:

- local to remote: listen on the Nocturne machine and forward through SSH to a target reachable from the remote Host
- remote to local: listen on the remote Host and forward through SSH to a target reachable from the Nocturne machine

Port forwarding is a Host capability, not a Terminal session feature. It must keep running when a Workspace is backgrounded, and it must be shared by every open Workspace for the same Host.

The first implementation supports SSH Hosts. Local Hosts, Telnet Hosts, and future unsupported protocols show an unsupported state in the Ports ToolTab and do not allow rule creation or execution.

## Terminology

- Port forward rule: the user-visible configuration row.
- Host port forward runtime: the in-memory runtime state for one connection Host in the current app process.
- Current run state: whether a rule is stopped, starting, running, reconnecting, failed, or waiting for confirmation.
- Persistence: whether a rule is `Just This Time` or `Saved`.
- Connect on Host Open: whether a saved rule automatically starts when any Workspace for the Host opens.
- Listen endpoint: the side that accepts incoming client connections.
- Target endpoint: the side the tunnel connects to after accepting a client connection.
- Effective endpoint: the actual runtime endpoint after dynamic port assignment.

## Host Scope And Workspace Lifecycle

Port forwarding state is Host-scoped:

- every Workspace opened for the same Host shows the same rules, runtime state, active connection counts, warnings, and event logs
- switching a Workspace to the background does not stop its Host's port forwards
- closing one Workspace does not stop Host port forwards while another Workspace for the same Host remains open
- closing the last Workspace for a Host must check that Host's port forward runtime

When closing the last Workspace for a Host:

- if any rule is `starting`, `running`, or `reconnecting`, ask for confirmation before closing
- if any rule is waiting for an SSH credential, host-key decision, or non-loopback confirmation as part of startup, treat it as `starting`
- `failed` and `stopped` rules do not block close
- if the user confirms, cancel pending prompts/startup work, stop all active port forwards for that Host, and then close the Workspace

This close protection is separate from Terminal and Transfer close protection, but the Workspace close UI should present all relevant blocking work together.

## Persistence

Rules have a `persistence` value:

- `just_this_time`: current app process only, scoped to the Host runtime
- `saved`: written into the editable Nocturne Host TOML

UI labels:

- field: `Persistence` / `保存方式`
- `just_this_time`: `仅本次`
- `saved`: `已保存`
- auto-start menu item: `Connect on Host Open` / `打开 Host 时连接`

OpenSSH-derived read-only Hosts may create only `just_this_time` rules. The `saved` persistence option is disabled with a short explanation. Nocturne does not write port forwarding overlays for OpenSSH-derived Hosts and does not modify `~/.ssh/config`.

Saved rules live inside the editable Nocturne Host TOML:

```toml
[[port_forwards]]
id = "018f6eb3-6f91-7410-bc43-f927b2236d94"
name = "Postgres"
direction = "local_to_remote"
local_address = "127.0.0.1"
local_port = 15432
remote_address = "db.internal"
remote_port = 5432
connect_on_host_open = true
```

Port forward configuration may remain in a Host document even if the Host protocol is changed to an unsupported protocol. Unsupported protocols do not execute the rules and show an unsupported ToolTab state. If the Host later switches back to a supported protocol, the saved rules become available again.

Changing persistence must not restart a running tunnel when the connection semantics are unchanged:

- `saved` to `just_this_time`: remove the Host TOML entry and keep the current runtime rule running
- `just_this_time` to `saved`: write the Host TOML entry and keep the current runtime rule running
- when creating a new `saved` rule, `connect_on_host_open` defaults to true
- when converting an existing rule to `saved`, preserve its existing `connect_on_host_open` value

Deleting a rule means stop then delete. Running, starting, reconnecting, or actively connected rules require confirmation before deletion. Stopped and failed rules delete directly. If stopping succeeds but persistent deletion fails, keep the rule visible as stopped with a save error.

## Rule Identity And Validation

Rule names are labels only. They are not part of duplicate detection.

Two rules are duplicates when these fields match for the same Host:

- direction
- local address
- local port
- remote address
- remote port

Creating or editing a duplicate rule is rejected. The UI must keep the row editable and locate or highlight the existing rule.

Addresses must be explicit. Do not encode empty strings as defaults:

- local address defaults to `127.0.0.1`
- remote address defaults to `127.0.0.1`
- target addresses may be arbitrary hostnames or IP addresses
- listen addresses may be arbitrary hostnames or IP addresses
- ports may be `0` only when requesting dynamic port assignment

Validation and runtime errors must name the endpoint and direction so the user can tell which side failed.

## Direction Model

The table uses local-left and remote-right semantics:

- `Local` column always represents the Nocturne machine side
- `Remote` column always represents the SSH Host side
- `Direction` shows only an arrow
- `->` means the Local endpoint listens and forwards to the Remote endpoint
- `<-` means the Remote endpoint listens and forwards to the Local endpoint

Display mode shows endpoints as `host:port`; IPv6 endpoints use bracket formatting such as `[::1]:8080`.

Edit mode splits each endpoint into separate address and port inputs. This avoids ambiguous parsing and lets validation attach errors to the correct field.

## Dynamic Ports

Both local and remote listen ports support `0`.

For local-to-remote:

- local port `0` asks the local OS to assign a listen port
- after assignment, the current Host runtime continues using the assigned port for reconnects
- `just_this_time` rules keep the assigned port only in runtime
- `saved` rules write the assigned port back to the Host TOML after first successful assignment

For remote-to-local:

- remote port `0` asks the SSH server to assign a remote listen port
- after assignment, the current Host runtime continues using the assigned port for reconnects
- `just_this_time` rules keep the assigned port only in runtime
- `saved` rules write the assigned port back to the Host TOML after first successful assignment

If a saved dynamic-port rule starts successfully but writing the assigned port back to Host TOML fails, keep the tunnel running and show a warning state in the Connections cell: `port was assigned but could not be saved`. The warning is also recorded in the lightweight per-rule event log. The user can keep using the assigned runtime port, then edit/save the row or restart the rule after fixing the Host TOML write failure.

## Non-Loopback Confirmation

Both directions default listen addresses to loopback. Users may edit listen addresses.

Non-loopback listen addresses are allowed, including `0.0.0.0`, `::`, concrete non-loopback IP addresses, and hostnames. They require an explicit risk confirmation before saving or starting.

Risk detection uses both input and best-effort resolution:

- `127.0.0.1`, `::1`, and `localhost` are safe without confirmation
- `0.0.0.0` and `::` require confirmation
- concrete non-loopback IP addresses require confirmation
- ordinary hostnames require confirmation unless they are `localhost`
- if resolution succeeds and any resolved address is non-loopback, require confirmation
- if resolution fails, saving may proceed, but startup fails if the runtime cannot bind

For auto-start saved rules, the first Host open that needs a non-loopback risk confirmation should show a focused application-level confirmation prompt. If the user confirms, subsequent auto-starts do not ask again for the same connection semantics. If the user cancels, the rule does not start.

Confirmation records are persisted in Host TOML and bound to the current connection semantics: direction, local endpoint, and remote endpoint. Changing any semantic field invalidates the confirmation.

## SSH Runtime

Each Host port forward runtime owns at most one shared SSH connection for all active rules on that Host. libssh2 channel multiplexing carries the forward channels.

Runtime rules:

- opening any Workspace for a Host starts all saved rules with `connect_on_host_open = true`
- startup does not depend on the Ports ToolTab being visible or mounted
- all running rules for the Host share one SSH session
- each accepted local connection or remote forwarded connection uses its own SSH channel
- concurrent connections are allowed and the active count is shown; the first version does not expose a user-configurable connection limit
- stopping a rule closes its listener and immediately disconnects all active connections for that rule
- editing a semantic field stops the old tunnel and starts the new tunnel after save
- editing non-semantic fields such as name or persistence does not restart
- when all Host rules are stopped or failed and no rule is still intended to run, close the shared SSH connection
- do not keep the shared SSH connection warm with no active or intended-active rules

Single-rule failures do not stop other rules on the same Host:

- local port in use fails only that local rule
- remote listen rejected fails only that remote rule
- target connection failures are logged for the affected rule or connection
- shared SSH authentication failure, host-key change, or SSH disconnect affects every rule that should be running on the Host

If the SSH connection drops, only rules that are still intended to run reconnect. Use finite backoff, for example 1s, 2s, 5s, 10s, then 30s capped. User-initiated Stop disables reconnect for that rule. Failed rows can be started again with the ordinary Start action. Authentication and host-key failures must stop and fail visibly instead of retrying blindly.

During reconnect, release local listen ports and request them again only after SSH reconnects. If another process takes the port while Nocturne is reconnecting, the affected rule becomes failed with a port-in-use error.

## Host Runtime Credentials

Port forwarding uses a Host-level runtime credential scope, not a Workspace-level temporary credential scope.

Reasons:

- port forwarding is Host-scoped and shared across Workspaces
- closing one Workspace must not invalidate a tunnel still used by another Workspace for the same Host
- prompts and runtime state must make sense even when the ToolTab that created the rule is gone

Credential rules:

- prompt-provided credentials for port forwarding are stored only in Rust memory
- plaintext is not exposed to the frontend and is not written to TOML
- in-memory credentials are encrypted like Workspace temporary credentials, but keyed to the Host port forward runtime
- when the last Workspace for a Host closes and the Host port forwards are stopped, destroy the Host port forwarding credential scope
- keyring may still be used as an optional source according to the existing SSH authentication policy
- SSH host-key trust continues to use Nocturne's private trust store

Port Forwarding surfaces interactive SSH credential and host-key verification through a Host-scoped verification event. Credential prompts write temporary credentials into the Host port forwarding runtime scope, not into a Workspace scope. Host-key prompts update the shared Nocturne SSH trust store after the user accepts the unknown or changed key. Closing the final Workspace for a Host cancels pending Host port forwarding verification requests before the runtime is stopped.

## Ports ToolTab

Ports is an ordinary Workspace ToolTab, but it displays Host-scoped state.

New SSH Workspaces include Ports by default in a bottom auxiliary panel. Resources and Transfers remain in the right-side auxiliary dock group, while Ports gets the horizontal space its table needs without stealing the primary Terminal/Files content area. Unsupported Host protocols still show the Ports ToolTab as an unsupported state with no rule creation affordance.

The ToolTab uses a dense table. Add `@tanstack/table-core` and wrap it in a Svelte component so sorting and row models stay in pure TypeScript while UI remains native-feeling.

The Ports table must not expose a horizontal scrollbar in its bottom panel. Its scroll viewport uses OverlayScrollbars with horizontal overflow hidden and vertical scrolling enabled. Column content should compress, truncate, or split into the existing inline edit controls instead of requiring sideways scrolling.

Default columns:

- `Connections`
- `Name`
- `Local`
- `Direction`
- `Remote`
- `Actions`

`Connections` also shows compact runtime status:

- running: active connection count
- running with a warning: show the warning overlay instead of the count
- starting, reconnecting, stopped, or needs confirmation: compact status text or icon
- failed: show the error summary as an overlay in this cell

The table supports user-selected first and second sorting keys:

- click a header to set or toggle the primary sort
- Shift-click another header to set the secondary sort
- header menus provide Sort Ascending, Sort Descending, Set as Primary Sort, Set as Secondary Sort, and Clear Sort
- headers show sort priority markers `1` and `2`
- at most two sort keys are active

Rules are edited inline. Do not use popup forms for add/edit operations inside the Ports ToolTab.

Inline editing rules:

- display endpoint cells as one `host:port` string
- edit endpoint cells as address and port inputs
- row edits are saved as a row, not per-cell on blur
- changed rows show Save and Cancel controls in `Actions`
- Enter saves and Esc cancels where that does not conflict with text input behavior
- save/validation/persistence failures keep the row editable and show errors in the relevant cells
- save success followed by runtime start failure closes edit mode and shows the rule as failed in the table
- semantic changes restart a running tunnel after save

The table keeps a permanent blank draft row at the bottom:

- the draft row does not participate in sorting
- partial draft input is retained in the current Host runtime until the user clears it, cancels it, or completes it
- every Workspace for the same Host sees the same draft
- after a draft saves successfully, it becomes a real rule and the blank draft row is reset

Actions column:

- visible controls: Start or Stop, plus a more menu
- when a row has unsaved changes, show Save and Cancel controls
- use icon buttons with tooltips where appropriate
- do not provide a separate copy-address button in the first version

More menu:

```text
Persistence
  Just This Time
  Saved
Connect on Host Open
Delete
```

`Connect on Host Open` is a checkable menu item. It is available only when Persistence is `Saved`; otherwise it is disabled with a short explanation. Start and Stop control only the current runtime state. They do not change Persistence or Connect on Host Open.

Event logs are per rule, record only lightweight runtime events, and are collapsed by default. Record events such as started, stopped, listener failed, SSH channel failed, connection opened, connection closed, server rejected remote listen, port in use, reconnect scheduled, and non-loopback confirmation accepted. Do not record transferred data, HTTP paths, headers, database payloads, credentials, tokens, or other traffic content. Keep a bounded ring buffer, such as the latest 50 events per rule.

## Commands And Events

Port forwarding needs typed Tauri commands and generated TypeScript bindings through tauri-specta. Do not hand-edit generated bindings.

Implemented command surface:

- get Host port forwarding snapshot
- create, update, and delete a rule
- update and clear the Host-scoped draft row
- check non-loopback listen risk
- start/stop a rule
- start a failed rule again using the same Start command
- persist non-loopback confirmation by saving the rule with an updated confirmation record

The frontend refreshes snapshots after commands. A future push event can further reduce polling/manual refresh needs across every Workspace and floating window, but the current command responses already carry the updated Host-scoped snapshot.

## Implementation Notes

Current implementation status:

- `ConnectionHostDocument` supports `[[port_forwards]]` for editable Host TOML, and validation preserves those rules even when the Host protocol is Local or Telnet.
- Duplicate detection uses only connection semantics: direction, local endpoint, and remote endpoint. Rule names are labels and are not part of the duplicate key.
- Non-loopback risk detection is centralized in Rust through `check_port_forward_non_loopback_risk`. It first classifies the user-entered listen address string (`localhost` and loopback IPs are safe, wildcard/non-loopback IPs and ordinary hostnames require confirmation), then best-effort resolves the address and adds a risk reason if any resolved address is non-loopback. Resolution failure does not block saving by itself. Saving or starting an unconfirmed non-loopback listen address is rejected by the backend, so the UI confirmation is not the only safety boundary.
- Non-loopback confirmation records are stored on each saved rule and are bound to direction plus local/remote endpoint semantics. Editing any semantic endpoint field invalidates the existing confirmation because the persisted semantic key no longer matches.
- Host-open auto-start marks saved non-loopback rules without confirmation as `NeedsConfirmation`. The main Workspace shell scans Host-scoped port snapshots after startup, shows a focused native confirmation once per rule semantics in the current app process, writes the persisted confirmation into the Host TOML when accepted, and then starts the rule.
- Ports is a Workspace ToolTab kind and appears in a bottom auxiliary panel by default. Resources and Transfers remain in the right auxiliary dock group, and Resources remains the active right-side tab by default so Ports does not steal focus.
- The Rust port forwarding service now owns a typed Host-scoped runtime. It exposes snapshot/create-or-update/update-draft/clear-draft/check-risk/start/stop/delete commands, keeps temporary rules and draft state in process memory, supports command-level persistence transitions, and bounds per-rule events to the latest 50 entries. Opening a Workspace for an SSH Host starts saved rules with `connect_on_host_open = true` independent of the Ports ToolTab being visible.
- Each Host runtime starts a background worker with at most one shared authenticated SSH session. The worker reuses the Terminal/Files SSH connection helper for ProxyJump resolution, host-key trust, keyring lookup, agent auth, private-key auth, and password/key-passphrase auth policy. SSH verification prompts are routed through a Host-scoped Port Forwarding event so a Host runtime never borrows a Workspace-scoped Terminal/Files prompt.
- Local-to-remote rules bind a local `TcpListener` and create one libssh2 `channel_direct_tcpip` channel per accepted TCP connection. Remote-to-local rules use libssh2 `channel_forward_listen` and bridge each accepted remote channel to a local TCP target. The bridge reuses the nonblocking TCP/SSH channel pump from the Terminal proxy-jump implementation. Per-rule listener failures update only that rule, while the shared Host SSH session and other rules remain alive.
- Startup failures for rules that are still intended to run enter `Reconnecting` with finite backoff of 1s, 2s, 5s, 10s, then 30s capped. Stop commands cancel the reconnect wait and clear intended-running state. The worker drops listeners and the shared SSH session before retrying, so local ports are released during reconnect. If a later local bind reports the port is already occupied, the affected rule becomes `Failed` instead of retrying forever. The current classification recognizes common Windows, macOS, and Linux bind-error text.
- Host port forwarding now owns a Host-level encrypted temporary credential scope in Rust memory. The storage uses the same ChaCha20-Poly1305 encrypted-at-rest-in-memory pattern as Workspace temporary credentials, but the scope key is the Host runtime rather than a Workspace id. Closing one Workspace does not destroy the scope while another Workspace for the same Host remains open; after the final same-Host Workspace close is confirmed, the Host runtime is stopped and the credential scope is destroyed.
- Workspace close handling checks active Host port forwarding state before closing the final Workspace for a Host. If another Workspace for the same Host remains open, Host forwards stay alive. If the closing Workspace is the last same-Host Workspace and any rule is `starting`, `running`, or `reconnecting`, the Svelte shell shows a native confirmation dialog before dispatching the close. After the close succeeds, Rust clears the Host port forwarding runtime.
- Dynamic listen-port behavior is wired into the real local and remote listener startup paths. Local port `0` is replaced with the OS-assigned listener port; remote port `0` is replaced with the SSH server-assigned remote port. Saved rules write the assigned port back to Host TOML. If that writeback fails, the tunnel remains `Running` with a warning: `port was assigned but could not be saved`, and the warning is visible in the Connections cell.
- The current Svelte Ports ToolTab renders unsupported protocol state and a dense table backed by `@tanstack/table-core` helper logic. It uses OverlayScrollbars for a vertical-only table viewport and avoids horizontal scrolling with fixed table layout and truncating cells. It supports inline endpoint editing, row Save/Cancel, a Host-runtime blank draft row, Start/Stop actions, a more menu with Persistence, Connect on Host Open, Events and Delete, disabled Saved persistence for read-only OpenSSH Hosts, failed and warning overlays, primary/secondary sorting through header click and Shift-click, header sort menus, focused first-open non-loopback confirmation, and collapsed-by-default event logs.
- Real SSH behavior has ignored Rust integration tests for local forwards, remote forwards, dynamic remote ports, shared SSH session multiplexing, and per-rule failure isolation. They default to an SSH target on `127.0.0.1:22` and can be pointed at another test host with `NOCTURNE_PORT_FORWARD_TEST_SSH_HOST`, `NOCTURNE_PORT_FORWARD_TEST_SSH_PORT`, `NOCTURNE_PORT_FORWARD_TEST_SSH_USER`, `NOCTURNE_PORT_FORWARD_TEST_SSH_PASSWORD`, and/or `NOCTURNE_PORT_FORWARD_TEST_SSH_IDENTITY_FILE`.

## Testing

Use Vitest unit tests for pure frontend/domain behavior:

- table column rendering model
- first and second sort state with TanStack table-core
- draft row retention per Host runtime
- duplicate rule detection in frontend helpers, if mirrored there for fast UI feedback
- inline editing save/cancel state
- endpoint display formatting, including IPv6 bracket formatting

Use Rust unit tests for backend logic:

- Host TOML parsing and writing for `[[port_forwards]]`
- persistence transitions between `just_this_time` and `saved`
- duplicate semantic rule validation
- address and port validation, including port `0`
- non-loopback risk classification by input string
- confirmation invalidation after semantic changes
- dynamic assigned port writeback and warning-on-save-failure behavior
- Host-scoped credential scope lifecycle
- shared SSH runtime state transitions that do not require a real SSH server
- last-Workspace close protection decisions for starting/running/reconnecting versus failed/stopped

Current SSH integration coverage lives in ignored Rust tests because it needs a real SSH server. By default the tests target the local machine (`127.0.0.1:22`); set `NOCTURNE_PORT_FORWARD_TEST_SSH_HOST`, `NOCTURNE_PORT_FORWARD_TEST_SSH_PORT`, `NOCTURNE_PORT_FORWARD_TEST_SSH_USER`, `NOCTURNE_PORT_FORWARD_TEST_SSH_PASSWORD`, and/or `NOCTURNE_PORT_FORWARD_TEST_SSH_IDENTITY_FILE` to use another Host. The remote-to-local assertions execute `nc` on the SSH target to prove the remote listener is reachable from that Host.

- local-to-remote forwarding with multiple concurrent connections
- remote-to-local forwarding
- remote dynamic port assignment
- shared SSH connection carrying multiple rules
- one rule failing without stopping another rule

Additional real-SSH fixture coverage to consider:

- reconnect after an established SSH session disconnects
- remote listen rejected by the server

Current Tauri/source coverage for real-app behavior includes:

- SSH Workspace includes Ports by default in the bottom auxiliary panel
- unsupported Local Host Ports ToolTab shows unsupported state and no add affordance
- same Host opened in two Workspaces shows shared port forward state
- closing one of two same-Host Workspaces does not stop running forwards
- closing the last same-Host Workspace prompts when rules are starting/running/reconnecting
- Ports table supports inline editing without popup forms
- risk confirmation appears on first auto-start of a non-loopback saved rule
- failed start after successful save closes edit mode and shows failed in the Connections cell

The Port Forwarding real Tauri WebView lifecycle test can use `TAURI_TEST_APPLICATION` when provided. If it is absent, the test builds the debug Tauri application with `pnpm tauri build --debug --no-bundle` and uses the platform-specific binary from `src-tauri/target/debug`.

Every test file under `/tests` must begin with an English comment describing the feature, operation, and expected result.
