# Terminal Daemon

This document describes the Go Terminal Agent daemon that backs persistent terminal sessions.

## Intent

The daemon is a host-level session service, not a transient helper. It keeps one PTY per session alive across:

- Nocturne exit
- window close
- SSH disconnect
- Nocturne restart

It does not promise recovery across OS reboot.

## Build Model

The daemon lives in `tools/nocturne-terminal-agent` and is built from Go source so Nocturne can cross-compile it easily.

Build rules:

- CGO stays disabled by default
- default to `CGO_ENABLED=0`
- use cross-compilation for shipped targets
- only enable CGO when a Windows ConPTY or PTY dependency truly requires it
- document any CGO exception in this file and in CI before enabling it

Current implementation note: the Windows endpoint uses named pipes through a
pure-Go package, and the Windows PTY path uses the ConPTY API without CGO. CI
and local build scripts therefore keep `CGO_ENABLED=0` for every shipped
Terminal Agent target. If that changes, the release workflow must show the exact
target exception instead of inheriting a machine default.

## Session Model

One daemon owns exactly one terminal session. A terminal that needs a persistent
PTY starts one daemon. This keeps lifecycle, transcript, socket/named-pipe
permissions, and process ownership easy to reason about; Nocturne discovers all
sessions by reading registry files, not by asking a single global daemon for its
in-memory session table.

Each daemon/session has:

- `session_id`
- `host_id`
- terminal launch metadata
- registry state
- transcript path

Nocturne generates the launch spec and sends it as JSON on stdin with `daemon --launch-spec-stdin`.
The daemon does not read Nocturne host configuration. For SSH hosts, the helper
runs on the destination host after Nocturne uploads or locates the
target-platform binary there.

`host_id` is the Nocturne connection identity, not a machine fingerprint. It is
kept because two Nocturne hosts can represent the same OS user on the same
machine while still being distinct app-side connection records. `session_id` is
the stable session identity and is also the registry filename stem. Nocturne
generates it as `term-{uuid}` with no embedded process-local counter or ordering
semantics, so a new Terminal ToolTab cannot collide with an exited registry
retained from an earlier app process. Any per-process terminal number is display
metadata only and must not be used as daemon or registry identity.

## Registry

The daemon writes one TOML registry file per session.

Rules:

- registry filename is `<session_id>.toml`
- transcript path is relative and stored in the registry
- file writes use atomic replacement
- transcript output is appended with debounce flushing
- exit state stays in the registry until the user deletes it
- endpoint kind is stored for display only; Nocturne still chooses the platform
  transport from the current OS

Registry writes are intentionally sparse in V1: creation, explicit registry
rename, and normal exit. The daemon writes `[exit]` and then exits. Registry and
transcript files remain until the user explicitly removes the session from
Nocturne; removing the registry also removes its transcript.
Nocturne sets the registry title to a generated session codename such as
`BraveBeacon` when the user has not named the session. The registry title is the
user-visible Terminal Sessions row name; cwd and command are supporting details
only. Nocturne sends user row renames as `rename` through the helper client, so
the registry title tracks the session name users can later search. Interactive
terminal title changes still flow as `title_change` for the live ToolTab
display, but they must not overwrite the registry title. Terminal ToolTabs do
not have a separate editable alias: their label is always derived from the live
program title or current directory plus the registry title suffix for Agent
sessions.

Nocturne exposes removal through the Terminal command palette for sessions on
the current Host and through the Terminal Sessions ToolTab, displayed to users
as `Terminals`. The ToolTab is the host-level registry view: it shows every
registry-backed session for the same Host whether or not a Terminal ToolTab is
currently attached. It refreshes when opened, when it becomes active, after
terminal detach/exit/delete/attach/history events, and when the user presses its
Refresh button. It does not poll on a timer in V1. The UI uses the native system
confirmation dialog before calling the backend delete command. Single-session
rename and delete live in each row context menu; primary rows stay focused on
attach/history. Multi-select is an explicit selection mode so normal rows stay
compact: the user enters Select, then can select individual sessions, Select
All, invert the selection, delete the selected registry/transcript pairs with
one confirmation, or leave selection mode. Row sizes such as `80x24` are not
shown because they are restore metadata, not useful list identity. Rows use
tooltip text for truncated title, cwd, command, and status details. Running or
detached sessions are closed and then removed; exited sessions are removed
directly. Exited sessions stay visible for history browsing until this explicit
delete step and are not attachable or continuable in V1. Terminal ToolTab
tooltips for already opened agent sessions show the same registry title used by
the Terminal Sessions row, but do not expose the session id.

The Terminal Sessions ToolTab must stay usable in narrow dock groups without
showing a native scrollbar if the list can be compressed instead. When the list
contains sessions it uses OverlayScrollbars as the list scroll host, and the
surrounding layout keeps the body area tightly constrained so the overlay
scrollbar is the only scrollbar the user sees in normal use. Empty, loading, and
error states stay unwrapped. In narrow dock groups, the registry title has
priority over status and actions; status can wrap below the title, and actions
should occupy only their icon width. Prefer shrinking row height, action
buttons, and vertical rail width before widening the panel. Vertical side rails
should use compact display titles such as `Terms` instead of the full
`Terminals` label to avoid creating an outer native scrollbar before content
scrolling is necessary.

Opening an exited session creates a normal Terminal ToolTab in read-only history
mode. Nocturne requests `history`, displays the saved transcript in that
Terminal ToolTab, and keeps the session disconnected instead of subscribing to live
output or starting a replacement command. If the user later chooses to restart
from that history view, the keystroke or paste that triggered the restart prompt
is discarded and is not replayed into the new run. The Terminal surface exposes
stable diagnostic attributes for Tauri tests, including the view-local session
id, registry `agent.session_id`, read-only flag, terminal status, and `History`
exit text, so regressions can prove whether a history view accidentally became
live or writable.

Terminal ToolTabs opened from the registry use a view-local Terminal session id
so the same registry session can be attached or viewed from multiple ToolTabs at
once without overwriting another view. The stable daemon/registry identity stays
in `agent.session_id` and is the value used for helper-client operations.
New code and docs should stick to sessions, ToolTabs, views, and clients.
Closing a Terminal ToolTab sends `close_view`, which removes only the current
attached client first. The daemon then pings the remaining attached clients; if
none are still reachable, it closes the PTY/run, writes `[exit]`, and exits.
Explicit `detach` only removes the current attached client and keeps the run
alive. Explicit `close_run` always ends the PTY/run. Explicit `delete` removes
registry and transcript files after the run is exited. Closing a Nocturne
window, exiting Nocturne, or using the explicit Detach command only detaches
owned Terminal Agent views unless the user chose Close for that ToolTab. When a
view detaches, Nocturne also stops its helper-client subscription so the daemon
can remove that attached client immediately instead of waiting for heartbeat
timeout.
When multiple live Terminal ToolTabs are attached to one daemon, Nocturne tracks
each view-local size in memory and sends the daemon the smallest attached
`cols`/`rows` and pixel dimensions so every attached view can render the PTY
without clipping.

The helper client owns explicit removal. `client delete --session-id` loads the
registry, sends `close_run` first when the session has not written `[exit]`,
waits for the daemon to persist exit, then removes both the transcript and
registry files. Already exited sessions delete without contacting a daemon. If a
session has no `[exit]` but its registry endpoint is already gone, explicit
delete treats the registry as stale and still removes both files. Other
connection failures, such as permission or protocol errors, still fail instead
of silently removing files for a possibly live PTY.

Transcript lines are NDJSON chunks:

```json
{"seq":0,"timestamp":"2026-06-25T00:00:00Z","data":"base64-output"}
```

`seq` is byte-oriented within the transcript. `data` is the raw output chunk
encoded with base64. Transcript appends are flushed after 2 seconds or 64 KiB,
whichever comes first. The transcript is capped at 64 MiB by trimming complete
oldest NDJSON chunks and keeping the newest valid history. When daemon output
contains a full-screen clear sequence such as `ESC [ 2 J`, `ESC [ 3 J`, cursor
home followed by `ESC [ J`, or RIS (`ESC c`), the daemon clears transcript
history through that point, then continues appending output that follows the
clear. Live subscribers still receive the original output chunk, including the
clear sequence.

Registry files include the last launch size (`cols`, `rows`, and optional pixel
dimensions) so Nocturne can restore a detached Terminal ToolTab without guessing
the initial PTY shape. Older registry files that lack these fields are displayed
with the UI default of 80x24 until they are recreated.

## Protocol

The daemon accepts NDJSON over Unix sockets on Linux/macOS and Windows named
pipes on Windows. Connections can be short-lived or long-lived. A client can
attach or subscribe and then send `ping`, `info`, `history`, `write`, `resize`,
`close_view`, `close_run`, `delete`, and `detach` over the same connection.

Long-lived `attach` and `subscribe` helper clients emit daemon NDJSON to stdout,
accept follow-up NDJSON requests on stdin, and forward them to the same daemon
socket/pipe connection. Nocturne uses that stdin stream as the live Terminal
ToolTab control channel for Agent-backed `write`, `resize`, `rename`,
`title_change`, `close_view`, `close_run`, `delete`, and `detach` requests
instead of starting a new helper client per keystroke or resize. Local live
ToolTabs write those requests to the bundled helper process stdin. SSH live
ToolTabs write the same NDJSON requests to the stdin side of the existing remote
helper `client subscribe` SSH exec channel, so live remote input and resize do
not open a separate SSH exec or helper-client process. Remote live control must
tolerate temporary SSH
backpressure by keeping unsent NDJSON bytes queued and retrying them on the same
subscription channel instead of treating `WouldBlock` as a fatal disconnect.
The helper keeps the same connection alive by sending
`ping` every 30 seconds. The daemon records the timestamp of the last request on
each attached client and removes the client if no request arrives for 90
seconds. Normal socket, pipe, read, and write errors still remove the client
immediately; the heartbeat timeout covers cases where the OS does not surface a
broken connection promptly. Heartbeat responses are internal to the helper
client and are not forwarded to Nocturne's terminal event reader. A `detach`
request removes that attached client, returns the correlated response, and then
closes the helper connection so the Terminal ToolTab's client process exits
without waiting for heartbeat timeout.
A `close_view` request also removes the current attached client and returns only
after the daemon has pinged any remaining attached clients. If the current view
was the last reachable attached client, `close_view` closes the PTY/run before
responding. Unreachable attached clients are removed during that check, the same
as heartbeat timeout cleanup.

The helper CLI also follows the registry-first rule. Operational client
commands take `--session-id`; they load `<session_id>.toml`, read the endpoint
from that registry, and then proxy one NDJSON request to the daemon. They do not
take endpoint paths, host config, or transport credentials on the command line.
Nocturne uses this helper client path for both local and SSH-backed sessions.
For local sessions it starts the bundled helper directly; for SSH sessions it
executes the same helper client on the destination host over SSH. The daemon IPC
transport remains host-local even when Nocturne is connected over SSH.

Nocturne lists persistent sessions from the helper client's registry list
output. The helper treats the registry as the discovery source and, for
non-exited entries, probes the daemon endpoint to enrich the NDJSON session line
with live display-only state such as `status = "running"` and
`attached_count`; those runtime fields are never written back to the registry.
Nocturne still probes an individual session through `client ping --session-id`
before re-attaching. The Terminal Sessions ToolTab also uses this list path for
display, so local and remote hosts share the same helper-client behavior.
Local hosts run the bundled helper directly. SSH hosts first
enter through the Workspace SSH verification and helper deployment context, then
run the same helper client on the destination host. Re-attach first requests
`history` so the Terminal ToolTab shows the transcript recorded while Nocturne
was closed, then subscribes to live events. Exited sessions stay visible in the
registry list for history browsing; opening one reads only its transcript and
does not attach. V1 attach rejects exited sessions instead of starting a new
command in the same view. Registry-backed delete also uses the helper client on
the session's host, so removing a remote registry removes the remote transcript
beside it.

Every request must include `request_id`, and the final response echoes the same
value:

```json
{"type":"request","request_id":"1","name":"write","payload":{"data":"SGVsbG8="}}
{"type":"response","request_id":"1","ok":true}
```

Events never include `request_id`; they use `type = "event"`:

```json
{"type":"event","event":"output","seq":0,"timestamp":"2026-06-25T00:00:00Z","data":"SGVsbG8="}
```

`history` is one request that returns zero or more `history` events followed by
one response/complete line carrying the original `request_id`. Closed but not
deleted sessions are still readable by opening the registry and transcript.
When the registry has `[exit]`, the helper client does not connect to the daemon
endpoint because that socket or named pipe belongs to a process that has already
exited. It serves `history` directly from the transcript, serves `info` from the
registry, updates the registry title for `rename`, accepts `title_change`
without changing the saved session name, deletes registry/transcript files for
`delete`, treats `close_view`, `close_run`, and `detach` as already satisfied,
and returns a normal `ok = false` protocol response for live-only commands such
as `ping`, `attach`, `subscribe`, `write`, and `resize`.

## Platform Storage

Session state follows OS storage conventions:

- Windows: `%LOCALAPPDATA%`
- Linux/macOS: XDG state/runtime locations

The daemon creates its session registry root and Unix socket runtime directory on
demand before listening. Socket permissions on Unix-like systems and named-pipe
ACLs on Windows are the access boundary.
