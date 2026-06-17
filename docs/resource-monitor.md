# Resource Monitor ToolTab

This document defines the Resource Monitor ToolTab, its host-scoped metrics model, visibility-driven refresh behavior, remote provider strategy, helper deployment rules, settings, and testing expectations.

## Goals

Resource Monitor is a Workspace ToolTab for inspecting resource usage on the Host bound to the current Workspace.

It monitors:

- overall CPU usage
- memory usage
- swap usage
- overall GPU memory usage
- overall GPU compute usage

Providers may collect per-core CPU or per-device GPU samples internally for
normalization and drill-down details. The Resource Monitor ToolTab shows only
one overall CPU row and one overall GPU row by default, but CPU and GPU rows are
expandable so the user can inspect per-core CPU and per-device GPU details on
demand. It must not flood multi-core or multi-GPU servers with one always-visible
row per core or device.

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

- scroll position
- focused control
- hover state
- compact provider mode control focus state
- expanded/collapsed CPU and GPU detail rows

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
- compact auxiliary text may show core count when known
- overall CPU shows current value plus a short history curve
- CPU rows with per-core details are collapsed by default and can be expanded in place
- CPU history charts include a bordered plot area without a top max label.

GPU display:

- one overall GPU row
- compact auxiliary text may show device count and aggregate VRAM used / total
- primary value is aggregate or averaged compute percent, depending on provider capability
- GPU history charts show the overall compute trend
- GPU rows with per-device details are collapsed by default and can be expanded in place
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
- compact Host-scoped remote provider mode control for SSH Workspaces
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
- CPU/GPU rows are expandable; Memory and Swap are not expandable and must not show expand controls
- pointer dragging a metric row reorders metric panels without triggering a secondary row action

Provider labels remain part of the backend snapshot for diagnostics and tests,
but the Resource Monitor ToolTab does not render provider/status text in the
header. The visible provider control is enough; extra labels such as
`nocturne-resource-monitor-agent on remote` add noise in the narrow dock group.

When the user switches between `Auto`, `Agent`, and `Commands`, the panel must
enter a loading state immediately, clear old provider samples and history, and
skip refresh ticks until the Host provider mode has been saved. This prevents
showing stale metrics from the previous provider while the new provider is being
selected or while a helper upload prompt is pending.

## Provider Strategy

Local Workspaces use a Rust local provider directly. Local collection must not start an external helper process. The local provider may reuse the same Rust collection modules that are compiled into `nocturne-resource-monitor-agent`; for matching OS/architecture this avoids maintaining separate metric logic for the app and the helper.

Local GPU collection in the app must use in-process provider code or return an explicit unavailable metric. It must not shell out to vendor or system command wrappers such as `nvidia-smi` or PowerShell. Helper GPU collection follows the same rule: once Nocturne uploads `nocturne-resource-monitor-agent`, GPU information must come from provider code inside the helper process.

Current `nocturne-resource-monitor-agent` GPU providers:

- Linux: first reads DRM/sysfs device data under `/sys/class/drm`, including AMD/Intel-style VRAM files such as `mem_info_vram_used` / `mem_info_vram_total`, byte-suffixed variants such as `mem_info_vram_used_bytes` / `mem_info_vram_total_bytes`, visible VRAM files, and GTT memory files when VRAM-specific files are unavailable. If DRM/sysfs does not expose usable memory metrics, it tries an in-process NVML provider by dynamically loading `libnvidia-ml.so.1` / `libnvidia-ml.so` at runtime. NVML is never linked at helper build time, so the helper can still start on Linux hosts without NVIDIA libraries. This covers NVIDIA hosts without shelling out to `nvidia-smi`. If neither provider works, GPU is unavailable with the collected reasons.
- Windows: uses Windows APIs in-process. DXGI enumerates adapters, display names, LUIDs, and dedicated video memory totals; PDH reads `GPU Engine(*)\Utilization Percentage` for compute usage and `GPU Adapter Memory(*)\Dedicated Usage` for current VRAM usage. Samples are grouped by GPU LUID. It must not call PowerShell.
- macOS: returns GPU unavailable with an explicit reason because stable public helper APIs do not expose the desired utilization data reliably.

Future provider additions should prefer direct OS APIs, kernel interfaces, or vendor libraries loaded in-process, such as NVML through dynamic loading for NVIDIA. They must not reintroduce command wrappers for `nvidia-smi`, PowerShell GPU queries, or similar external process probes inside local or helper GPU providers.

Remote Workspaces use the current Host's `[resources].remote_provider` value.
The compact provider control in the Resource Monitor ToolTab edits that Host
setting directly for editable Nocturne user hosts. OpenSSH-derived and virtual
hosts are read-only, so the ToolTab shows the effective mode without rewriting
the source host.

Local Workspaces use the virtual Local Host directly. Resource Monitor must not
try to read or update the virtual Local Host through the persisted Host file
path because the default Local Host has no on-disk Host document. The Local
Resource Monitor therefore must not show errors such as `connection host
00000000-0000-0000-0000-000000000001 not found`.

When editing an SSH Host's provider mode, the frontend must clone the generated
Host document with explicit plain-object copying. Do not use browser
`structuredClone` on generated Tauri binding objects; those objects may contain
values that cannot be cloned in a WebView and can fail before the Host setting is
saved.

Remote Workspaces use this order when the Host provider mode is `auto`:

1. In `auto`, collect with existing target-host commands when they can provide reliable metrics. The command provider may cover CPU, memory, swap, and NVIDIA GPU via `nvidia-smi`, but it must not pretend a vendor-specific GPU command is universal GPU support.
2. If existing commands cannot reliably cover key metrics such as GPU details, follow the unified remote helper policy.
3. If permitted, upload and run `nocturne-resource-monitor-agent`.
4. If not permitted or unsupported, keep affected metrics unavailable with reasons.

When the user selects `system_commands`, step 2 and step 3 are skipped entirely. The app must not download, upload, install, or run the managed Resource Monitor agent in that mode. It may still run target-host commands such as `nvidia-smi`; if those commands are missing or not applicable, only the affected metrics are unavailable.

Host provider modes:

- `auto`: try target-host commands first. If those commands produce all required metrics, use them. If they cannot cover key metrics, especially GPU, continue to the managed Resource Monitor agent path and apply the unified remote helper policy before any upload.
- `agent`: use `nocturne-resource-monitor-agent` according to the unified remote helper policy.
- `system_commands`: only run commands that already exist on the target Host. This mode never downloads, uploads, installs, or runs Nocturne's managed Resource Monitor agent. On Linux it may use `nvidia-smi` when present to report NVIDIA GPU metrics. If `nvidia-smi` is missing or the Host is not NVIDIA-backed, GPU is unavailable with an explicit reason while CPU, memory, and swap can still display from system commands.

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
remote_provider = "auto"  # optional: auto | agent | system_commands
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
- If the remote helper policy is `Ask` and the user cancels an upload prompt,
  Nocturne remembers that cancellation for the current Host and helper hash so
  visibility-driven refresh ticks do not reopen the same dialog indefinitely.
  Changing the helper hash or Host may prompt again.
- If the remote helper policy is `Ask` and an upload prompt is already open,
  Nocturne remembers that pending prompt for the current Host and helper hash.
  Later refresh ticks must report that helper upload confirmation is pending
  instead of opening additional dialogs while the user has not answered the
  first one.
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

Required global setting:

```toml
[resources]
default_refresh_interval = "2s" # 1s | 2s | 5s | 10s
```

The setting label is `Default resource refresh interval`.

ToolTab-local interval changes are temporary and do not write this default setting.

Remote provider selection is not a global Settings page value. It belongs to
the current Workspace Host under `[resources].remote_provider` and is edited
from a compact control in the Resource Monitor ToolTab so changing it is close
to the provider status it affects.

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
- Local Resource Monitor does not show a missing virtual Local Host warning
- SSH Resource Monitor provider mode can be changed and persisted without `structuredClone` errors
- CPU/GPU detail rows can expand in the real WebView while Memory/Swap remain non-expandable
- mirrored Resource Monitor views do not duplicate collection
- helper upload prompt behavior when policy is Ask

Every test file must live under `tests/` and start with an English comment describing feature, operation, and expected result.
