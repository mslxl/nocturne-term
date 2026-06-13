# Resource Monitor ToolTab

This document defines the Resource Monitor ToolTab, its host-scoped metrics model, visibility-driven refresh behavior, remote provider strategy, helper deployment rules, settings, and testing expectations.

## Goals

Resource Monitor is a Workspace ToolTab for inspecting resource usage on the Host bound to the current Workspace.

It monitors:

- overall CPU usage
- per-core CPU usage
- memory usage
- swap usage
- GPU memory usage by device
- GPU compute usage by device

Resource Monitor is not a process manager. Process listing and process actions belong to a separate Processes ToolTab that the user opens manually.

## Workspace And ToolTab Model

Resource Monitor is an ordinary ToolTab owned by a Workspace:

```ts
type ResourceToolTab = {
  kind: "resources";
  ownerWorkspaceId: string;
  hostId: string;
};
```

Rules:

- It monitors the owner Workspace's Host.
- Local Workspaces monitor the local machine.
- SSH Workspaces monitor the remote Host.
- A Workspace may own at most one Resource Monitor ToolTab.
- Opening Resource Monitor again in the same Workspace focuses the existing owned ToolTab.
- Closing Resource Monitor does not require confirmation.
- Closing the owner Resource Monitor stops sampling, stops any remote stream, discards in-memory history, and turns mirrors into closed-source placeholders.
- Closing a Resource Monitor mirror removes only that mirror display.

New Workspaces include Resource Monitor by default. The default layout places Files on the left, Terminal in the content area, and Resource Monitor plus Transfer Queue in a right-side dock group. Resource Monitor is the active ToolTab in that right-side group for a brand-new Workspace.

Workspace layout memory is not Resource Monitor-specific. User layout choices are respected for every non-Terminal ToolTab, including Files, Transfers, and Resources. If a user closes, moves, or reorders a non-Terminal ToolTab, restored runtime layout should preserve that choice instead of force-adding the default ToolTab again. Terminal remains governed by its own session and reconnect rules.

## Mirrors And Floating Windows

Resource Monitor follows the standard ToolTab mirror rules:

- Owned ToolTab business state is shared with mirrors.
- Mirror view-local preferences are not shared.
- Floating windows contain mirror ToolTabs only.
- Mirror slots and floating mirror slots are not persisted across app restart.

For Resource Monitor, shared business state includes:

- latest metrics snapshot
- provider status
- stale/warning state
- short history buffers
- active remote provider stream for the owner ToolTab

View-local state includes:

- expanded/collapsed CPU core groups
- expanded/collapsed GPU device groups
- scroll position
- focused control
- hover state

If the same Resource Monitor is visible in its owner Workspace, another Workspace mirror, and a floating mirror, Nocturne must still run only one collection loop or stream for that owner ToolTab.

## Refresh And Visibility

Resource Monitor uses frontend visibility-driven refresh orchestration with backend collection providers.

Rules:

- Collection starts only when at least one view of the owner Resource Monitor ToolTab is truly visible.
- Hidden Workspaces, hidden dock groups, inactive ToolTabs, and closed/floating-hidden views do not count as visible.
- Multiple visible mirrors of the same owner ToolTab are deduplicated into one collection loop or provider stream.
- Collection stops when no visible view remains.
- The default refresh interval is 2 seconds.
- ToolTab UI may temporarily switch interval to 1s, 2s, 5s, or 10s.
- The Settings page exposes `Default resource refresh interval` with the same fixed choices: 1s, 2s, 5s, and 10s.
- A collection tick must not start while the previous collection request for that owner ToolTab is still in flight. If a tick arrives during an in-flight collection, skip that tick instead of queueing or running concurrently.
- Provider operations use a 5 second hard timeout constant.
- After 3 consecutive failures, show an inline warning.
- Keep the last successful data visible after failures, but mark it as stale.
- Clear stale and warning state after a successful sample.

## Metrics Model

Each metric reports availability independently. A missing GPU provider must not make CPU or memory unavailable.

Use a common shape for capacity metrics:

```ts
type CapacityMetric = {
  used: number;
  total: number;
  percent: number;
  auxiliary?: {
    available?: number;
    free?: number;
  };
};
```

Memory and swap use `used / total / percent`, with available or free values as auxiliary text when known. Swap disabled is a normal available state with `total = 0`, not an error.

CPU display:

- top-level overall CPU percent
- expandable per-core CPU percent rows
- overall CPU and each visible core show current value plus a short history curve
- CPU history charts include a bordered plot area without a top max label.

GPU display:

- grouped by GPU device
- the top-level GPU row summarizes device count, aggregate memory, and average compute usage
- each GPU device row shows compute percent, VRAM used / total, and a short compute history curve
- unsupported providers display unavailable with a reason

Unavailable metrics must show an explicit reason, such as:

- `Unsupported platform`
- `Provider command not found`
- `Permission denied`
- `Timed out while collecting metrics`
- `Target OS/architecture unknown`

## History

Resource Monitor keeps short history curves in frontend memory.

Rules:

- History is shared between owner and mirror views of the same Resource Monitor ToolTab.
- History is not persisted.
- History is discarded when the owner Resource Monitor ToolTab closes.
- Each metric keeps the most recent 5 minutes.
- Each metric keeps at most 300 samples.
- History stores actual sample points rather than synthesized fixed intervals.

Current value and history curve are shown together. There is no per-metric Current/History toggle in the first version because the dense panel is more useful when it always shows trend context.

## UI

The UI should be dense, clear, and native-feeling rather than a large dashboard.

Layout:

- compact status row at the top
- provider label
- refresh interval control
- last updated state
- inline warning area
- sections for CPU, Memory, Swap, and GPU
- small value rows and bordered sparklines

The right dock group may be narrow. The Resource Monitor must stay readable in a single column:

- no horizontal scrollbar
- expanded content scrolls vertically
- long auxiliary text may wrap
- non-essential auxiliary columns can be hidden at narrow widths
- CPU core and GPU device details are collapsible and collapsed by default
- non-collapsible metrics such as Memory and Swap do not show expand icons
- clicking a collapsible CPU or GPU row expands or collapses details, while pointer dragging the row reorders metrics without toggling details

Provider labels should be explicit, for example:

- `local provider`
- `system commands on remote`
- `nocturne-resource-monitor-agent on remote`

## Provider Strategy

Local Workspaces use a Rust local provider directly. Local collection must not start an external helper process. The local provider may reuse the same Rust collection modules that are compiled into `nocturne-resource-monitor-agent`; for matching OS/architecture this avoids maintaining separate metric logic for the app and the helper.

Local GPU collection in the app must use in-process provider code or return an explicit unavailable metric. It must not shell out to vendor or system command wrappers such as `nvidia-smi` or PowerShell. Helper GPU collection follows the same rule: once Nocturne uploads `nocturne-resource-monitor-agent`, GPU information must come from provider code inside the helper process.

Current `nocturne-resource-monitor-agent` GPU providers:

- Linux: reads DRM/sysfs device data under `/sys/class/drm`, including AMD/Intel-style VRAM files such as `mem_info_vram_used` and `mem_info_vram_total`. This can report VRAM used/total without running external commands. Compute utilization remains `0` unless a stable in-process provider is added.
- Windows: uses Windows APIs in-process. DXGI enumerates adapters, display names, LUIDs, and dedicated video memory totals; PDH reads `GPU Engine(*)\Utilization Percentage` for compute usage and `GPU Adapter Memory(*)\Dedicated Usage` for current VRAM usage. Samples are grouped by GPU LUID. It must not call PowerShell.
- macOS: returns GPU unavailable with an explicit reason because stable public helper APIs do not expose the desired utilization data reliably.

Future provider additions should prefer direct OS APIs, kernel interfaces, or vendor libraries loaded in-process, such as NVML through dynamic loading for NVIDIA. They must not reintroduce command wrappers for `nvidia-smi`, PowerShell GPU queries, or similar external process probes inside local or helper GPU providers.

Remote Workspaces use this order:

1. Collect with existing target-host commands when they can provide reliable metrics. The command provider may cover CPU, memory, and swap, but it must not pretend a vendor-specific GPU command is universal GPU support.
2. If existing commands cannot reliably cover key metrics such as GPU details, follow the unified remote helper policy.
3. If permitted, upload and run `nocturne-resource-monitor-agent`.
4. If not permitted or unsupported, keep affected metrics unavailable with reasons.

The remote helper policy is shared with other remote helper decisions:

- `Ask`
- `Never`
- `Allow`

The prompt must clearly display:

- helper name: `nocturne-resource-monitor-agent`
- purpose: Resource Monitor metrics
- target Host
- target OS
- target architecture
- upload path
- checksum/hash

`nocturne-resource-monitor-agent` is a single-purpose Resource Monitor helper. It is not a general remote automation agent. Its stream protocol still includes capabilities so the app knows which Resource Monitor metrics this build and platform can provide.

## Remote OS And Architecture

Connection host configuration may optionally include target OS and architecture fields for helper selection:

```toml
[resources]
target_os = "linux"       # optional: linux | macos | windows
target_arch = "x86_64"    # optional: x86_64 | aarch64 | armv7 | i686
```

These fields may both be empty. If only one field is set, the target is incomplete and Nocturne must ask the Workspace to choose instead of guessing.

When fields are empty:

1. Run remote commands to detect OS and architecture.
2. If detection succeeds, select the matching bundled helper.
3. If detection fails, ask the user to choose OS and architecture.
4. If the user cancels or refuses, helper-backed metrics are unavailable with `Target OS/architecture unknown`.

Nocturne must not guess an OS or architecture and must not upload a helper when the target is unknown.

## Helper Packaging And Deployment

`nocturne-resource-monitor-agent` is implemented as an independent Rust crate at `crates/nocturne-resource-monitor-agent`. It must not be built as a `src-tauri` binary and must not depend on the Tauri application crate, because helper builds need to avoid Tauri build scripts, app resources, generated bindings, and native windowing dependencies.

Packaging rules:

- The application bundle must include helper binaries for supported target OS and architecture combinations.
- Packaging must not include only the app's current build platform because SSH targets are runtime-dependent.
- Linux helpers should use musl static linking where practical.
- Windows, macOS, and Linux helpers are selected at runtime by detected or configured target OS/architecture.
- The helper crate may share protocol and metric-shape concepts with the app, but it must stay buildable without depending on Tauri.
- `pnpm build:resource-monitor-agents` builds `nocturne-resource-monitor-agent` release binaries into `src-tauri/resources/nocturne-resource-monitor-agent/<os>/<arch>/`.
- Tauri bundles `resources/nocturne-resource-monitor-agent/**/*` so helper binaries are available as app resources at runtime.

Supported helper bundle targets:

- Linux x86_64: `x86_64-unknown-linux-musl` -> `linux/x86_64/nocturne-resource-monitor-agent`
- Linux aarch64: `aarch64-unknown-linux-musl` -> `linux/aarch64/nocturne-resource-monitor-agent`
- Linux armv7: `armv7-unknown-linux-musleabihf` -> `linux/armv7/nocturne-resource-monitor-agent`
- macOS x86_64: `x86_64-apple-darwin` -> `macos/x86_64/nocturne-resource-monitor-agent`
- macOS aarch64: `aarch64-apple-darwin` -> `macos/aarch64/nocturne-resource-monitor-agent`
- Windows x86_64: `x86_64-pc-windows-msvc` -> `windows/x86_64/nocturne-resource-monitor-agent.exe`
- Windows i686: `i686-pc-windows-msvc` -> `windows/i686/nocturne-resource-monitor-agent.exe`

Release CI builds every supported helper target before building application bundles, uploads each helper as an artifact, downloads all helper artifacts into `src-tauri/resources/nocturne-resource-monitor-agent`, and then lets Tauri include that resource tree in every app bundle. Linux ARM helper builds use `cross` so CI does not depend on the runner CPU architecture. Windows helper builds request static CRT linking so uploaded helpers do not require separate Visual C++ runtime files on the target Host. Linux helpers use musl targets to avoid glibc version coupling on remote Hosts.

Release CI also uploads each helper binary as a GitHub Release asset with this deterministic name:

```text
nocturne-resource-monitor-agent-<tag>-<os>-<arch>[.exe]
```

At runtime, Nocturne first looks for the bundled helper in the Tauri app resources. If that file is missing and the current application build has an exact Git tag embedded, Nocturne may ask the user whether to download the matching helper from the same GitHub Release tag. It must not use `latest`, a different tag, or a guessed version. If the app build has no embedded tag, Nocturne does not download a helper and reports the helper as unavailable.

The Tauri build embeds the current commit id and the exact current tag into the application binary. The commit id is always recorded for diagnostics. The tag is empty for untagged development builds, and an empty tag disables same-release helper downloads.

Deployment rules:

- Helper deployment status and hash validation are remembered per Host.
- Authentication never reuses credentials across Workspaces; deployment still uses the current Workspace's encrypted temporary credentials.
- Closing a Workspace does not delete an uploaded helper.
- If a remote helper's manifest or hash does not match the bundled helper, Nocturne validates and uploads again according to helper policy.
- The uploaded helper may remain on the remote Host for reuse.
- Upload planning is created from bundled helper bytes. The plan records the selected app-resource path, remote deployment directory, remote helper path, remote `manifest.json` path, executable mode, SHA-256 hash, capabilities, serialized manifest JSON, verification command, and NDJSON streaming launch command before any SFTP upload is attempted.
- Deployment creates the remote helper directory, uploads the helper binary and manifest, applies executable permissions on Unix-like targets, verifies the uploaded helper hash, and then launches `nocturne-resource-monitor-agent --stream`.

Remote helper paths use the per-version cache directory:

```text
~/.cache/nocturne/helpers/<version>/nocturne-resource-monitor-agent
~/.cache/nocturne/helpers/<version>/manifest.json
```

Use a same-directory `manifest.json` recording helper name, purpose, version, target OS, target architecture, remote upload path, checksum, and capabilities.

## Streaming Protocol

`nocturne-resource-monitor-agent` uses long-lived NDJSON streaming.

Rules:

- one complete JSON event per line
- stdout carries protocol events
- stderr carries diagnostics
- the backend parses, validates, and forwards typed snapshots/status to the frontend
- stopping visibility stops the remote helper process
- stream interruptions count as collection failures

Event kinds:

```json
{"type":"hello","version":"0.1.0","os":"linux","arch":"x86_64","capabilities":["resource.cpu","resource.memory","resource.swap","resource.gpu"]}
{"type":"snapshot","timestamp":"2026-06-12T00:00:00Z","metrics":{}}
{"type":"warning","code":"gpu_unavailable","message":"Linux DRM sysfs did not report VRAM metrics"}
{"type":"error","code":"collection_failed","message":"Timed out while collecting metrics"}
```

The exact metric payload should be typed in Rust and exported through Specta. Do not hand-write generated TypeScript bindings.

## Settings

Resource settings belong with Workspace/Tools or the peer tool settings category.

Required setting:

```toml
[resources]
default_refresh_interval = "2s" # 1s | 2s | 5s | 10s
```

The setting label is `Default resource refresh interval`.

ToolTab-local interval changes are temporary and do not write this default setting.

## Commands And Entry Points

Resource Monitor opens from the Workspace ToolTab new/open menu, not a global app menu.

Command IDs:

```text
tool.openResources
```

Command behavior:

- if the current Workspace has no owned Resource Monitor, create one
- place it according to the current layout rules
- if one already exists, focus it
- do not create duplicates in one Workspace

The command palette may expose Resource Monitor through the same command path. It must not implement separate layout logic.

## Testing

Use Vitest unit tests for:

- visibility deduplication across owner view and mirrors
- in-flight tick skipping
- stale state after consecutive failures
- history retention by time and sample count
- per-metric unavailable handling
- one-owned-Resource-Monitor-per-Workspace behavior in pure frontend/domain helpers

Use Rust unit tests for:

- local provider parsing and normalization
- remote command output parsing for Linux, macOS, and Windows where command providers exist
- OS/architecture detection parsing
- helper manifest validation
- NDJSON event parsing and validation
- timeout and stream lifecycle state machines that do not require a real WebView

Use Tauri unit tests for:

- Resource Monitor appears by default in a new Workspace
- Resource Monitor and Transfer Queue default to the right dock group
- reopening Resource Monitor focuses the existing ToolTab
- visible Resource Monitor starts collection and hidden Resource Monitor stops collection
- mirrored Resource Monitor views do not duplicate collection
- helper upload prompt behavior when policy is Ask

Every test file must live under `tests/` and start with an English comment describing feature, operation, and expected result.
