# Files ToolTab

This document defines Nocturne's Files tool tab, file-provider abstraction, Tree and Columns views, preview, search, and file operations.

## Goals

Files is a host-bound tool tab used by both local and SSH workspaces.

- Local workspace: Files uses a local filesystem provider.
- SSH workspace: Files uses an SFTP provider.

The UI above the provider is shared. Tree, Columns, preview, search, selection, copy/paste, and transfer entry points should not be implemented twice for local and SFTP.

## Provider Abstraction

Files tool tabs talk to a file-provider abstraction:

```ts
type FileProviderKind = "local" | "sftp";

type FileProviderCapabilities = {
  canRead: boolean;
  canWrite: boolean;
  canRename: boolean;
  canDelete: boolean;
  canTrash: boolean;
  canChmod: boolean;
  canSymlink: boolean;
  canWatch: boolean;
  canSearchByName: boolean;
  canSearchContent: boolean;
  canUploadHelper: boolean;
  supportsServerSideCopy: boolean;
  supportsAtomicRename: boolean;
  supportsMetadataOwnerGroup: boolean;
};
```

The UI must branch on capabilities rather than hard-coding local/SFTP checks.

Provider operations include list, stat, mkdir, rename, delete, trash when supported, chmod when supported, read preview, and search.

Every Files Tauri command must receive `workspace_id` and `tool_tab_id`, not a
frontend-supplied host id. The Rust backend validates that the ToolTab is an
owned Files ToolTab in that Workspace and derives the Host from authoritative
Workspace state before opening a Local or SFTP provider session. This keeps
Files, mirrors, and future floating displays from accidentally authenticating
against the wrong Host.

For SFTP, credential and host-key verification challenges are emitted as
Workspace-owned structured SSH verification events. While the backend waits for
the Workspace prompt result, Files should remain in a loading or prompt state
instead of converting the challenge into a final provider error.

## Host Defaults

Hosts may define a default file path:

```toml
[files]
default_path = "~/Projects"
```

For local hosts, an empty default opens the local home directory. For SSH hosts, an empty default opens the remote home directory.

The default path is only a starting path. It is not a jail. Local and SFTP providers may navigate to any path allowed by user or server permissions.

Files tool tabs cannot switch to another host or provider. Cross-host operations use Transfers, mirrors, or another workspace.

## Sessions And Cache

Directory browsing sessions belong to the Files tool tab.

- Closing the owner Files tool tab closes its browsing session.
- Mirrors display the same browsing session.
- Application-level transfers and searches may use their own background sessions.

Directory data uses `@tanstack/svelte-query`.

Rules:

- key by provider session and normalized path
- use short stale times
- allow explicit refresh
- invalidate current, parent, and destination directories after mutations
- do not persist directory cache across app restarts

Large directories are read fully for the current directory, then rendered with virtualization. SFTP directory pagination is not part of the first release. Very large reads should show progress, allow cancellation where supported, and warn when the directory is unusually large.

## Table And Virtualization

Use TanStack Table for headless table state and TanStack Virtual for large directory rendering.

Table state:

- sorting is business state and mirrors sync it
- selection is business state and mirrors sync it
- column widths and scroll offsets are view-local
- Tree expansion is view-local

Default columns:

- Name
- Size
- Modified
- Permissions

Optional columns:

- Owner
- Group

Permissions display as both symbolic and octal, such as `rw-r--r-- 644`.

## Views

Files supports two view modes on every desktop platform:

- Tree
- Columns

The names and behavior stay consistent across macOS, Windows, and Linux.

View mode is Files tool business state and mirrors sync it. View-local details such as Tree expansion, scroll positions, and column widths do not sync.

### Tree

Tree view is a Finder-style outline table:

- files and directories are rows in one virtualized table
- directories can expand lazily
- child rows are indented
- all table columns remain available
- selection and file operations work on visible rows

Directory expansion is lazy and uses the shared directory cache.

### Columns

Columns view is a Finder-style column browser:

- each column represents one path level
- selecting a directory opens the next column
- selecting a file opens the preview as the third visible column by keeping the file's containing directory in the middle column
- double-clicking a directory keeps the current Columns window instead of entering that path
- Enter opens a directory or preview
- Backspace or Left moves toward the parent path

Column widths and horizontal scroll are view-local.

The first implementation may ship a basic Columns view that shows the current path stack and the active directory's children, with full lazy sibling-column loading and preview-column behavior layered in after the core provider, transfer, and search paths are stable.

## Selection

Selection supports:

- single select
- multi-select
- Shift range selection
- Cmd/Ctrl toggle selection
- mouse marquee selection in the active visible list
- keyboard up/down movement
- Space toggle
- Enter open directory or preview
- Cmd/Ctrl+A select all

Selection, active preview path, and range anchor are business state because they affect operations and mirror behavior. Scroll position, focus, hover, and the temporary marquee rectangle remain view-local.

Right-clicking an already selected row preserves the current multi-selection and opens a context menu for that selection. Right-clicking an unselected row selects only that row before opening the context menu. Right-clicking empty space opens directory-level actions without changing the current selection.

## Toolbar

The Files toolbar includes navigation, view, and directory-level actions:

- Up
- Refresh
- New Folder
- Upload Files
- Upload Folder
- Paste
- Search
- View mode toggle
- Path
- show hidden toggle

Selection-scoped object actions do not belong in the toolbar. Rename, Permissions, Delete, Copy, Cut, and Download are exposed through the Files context menu and keyboard command paths instead.

Use icon buttons with tooltips. Enable actions based on provider capabilities and selection state.

The global Files setting `files.toolbar_actions` controls which toolbar actions are shown and the display order. The setting is an ordered list of action ids. Unknown, repeated, or context-menu-only ids are ignored, and Nocturne uses the built-in default order when no configured id is usable. `view_mode` and `path` are toolbar items in the same ordered flow, so users can place or hide them like other toolbar controls.

The breadcrumb/path control is a core toolbar control. It supports clickable path segments, manual path entry, and path copying.

Hidden files are shown by default because remote and developer workflows often depend on dotfiles. The setting and toolbar can hide them.

## File Operations

Files supports native dialogs, drag-and-drop, and application-local copy/cut/paste.

Default copy/cut/paste semantics are Windows-style:

- Copy marks references for copy.
- Cut marks references for move.
- Paste performs copy or move.

Settings can switch to Finder-style semantics.

The first implementation keeps an application-local clipboard of provider endpoint references, not file bytes. Copy may cross local/SFTP providers and hosts by creating Transfer Service tasks. Transfer SFTP authentication uses the initiating Workspace scope, so a task can reuse only that Workspace's encrypted temporary credential and must not cross into another Workspace's temporary credential scope. Cut/paste performs same-provider moves through rename. Cross-provider or cross-host moves must not delete the source until the transfer service can atomically mark copy completion and then remove the source; until then, the UI should ask the user to copy first and delete manually after completion.

Operations:

- upload files
- upload folder
- download
- rename
- new folder
- delete
- copy
- move
- chmod where supported

Rename only supports one selected item. Delete, Copy, Cut, Download, and Permissions support multi-selection. Multi-delete asks once for the whole selection. Multi-download asks for a destination directory and creates one transfer per selected item. Multi-permissions opens one dialog seeded from the first selected item and applies the chosen mode to every selected item.

The first release does not support Open Locally, Open Copy, or remote editing.

Input operations such as New Folder, Rename, and Chmod use small Tauri dialog windows. Dangerous confirmations use native dialogs. Transfer conflicts are handled in the Transfers tool tab.

## Delete And Trash

Default delete directly removes remote or local files after a strong confirmation.

Settings may enable "try remote trash" for providers that support or can discover trash. For SFTP, Nocturne detects an XDG Trash structure under the login user's home directory. When found, delete asks whether to move to Trash, delete directly, or cancel. If Trash is not found or cannot be used, the operation falls back to direct delete with strong confirmation.

Nocturne should not silently create remote Trash directories in the first release.

Settings copy must explain that remote Trash is a best-effort server convention and is not equivalent to the local Finder trash.

Deleting a symlink deletes the link itself, not the target.

## Symlinks

Symlink rules:

- show a symlink indicator and target when available
- do not follow directory symlinks in Tree expansion or recursive search unless Follow symlinks is enabled
- double-click resolves or enters when the provider can prove the target is a directory
- otherwise show metadata and allow explicit resolve
- chmod on symlinks is disabled in the first release

## Preview

Preview is read-only.

Default thresholds:

- text preview: 1 MiB
- image preview: 10 MiB

Thresholds are configurable in settings. Larger files show metadata and download actions only.

Preview content should avoid horizontal scrollbars. Text previews wrap long lines inside the preview column, and image previews fit within the available width.

Preview requests should be cancellable. Changing selection cancels stale preview requests.

Preview cache is short-lived and keyed by provider, path, mtime, and size. It is not persisted across app restarts and is invalidated by writes affecting the file.

Preview supports:

- directory summary
- text/code snippets
- image preview
- binary metadata
- owner/group/permissions/size/modified metadata when available

## Search

Files supports recursive name and content search in the first release. Name search can use provider scans or ripgrep. Content search uses ripgrep and shows line-level matches from `rg --json`; scan fallbacks only provide name/path matches unless the local provider can safely scan text files directly.

Search UI lives inside the Files tool tab. Results are a temporary result view for that tool tab. Search business state syncs to mirrors; panel scroll and sizing are view-local.

Search must:

- be cancellable
- show provider label
- show progress or active path where available
- collect permission errors as diagnostics
- cap results or ask the user to continue when needed

Provider labels include:

- `ripgrep on remote`
- `Nocturne ripgrep helper`
- `SFTP scan`
- `local scan`
- `local ripgrep`

When using `rg --json`, show matching lines and highlight ranges. Local content scan may show matching lines when local `rg` is unavailable. SFTP scan returns file/path matches only; if the user asks for content search and no remote `rg` provider is available because policy blocks helper deployment, the result is empty with a diagnostic instead of pretending that a name scan searched file contents.

The first release ships uploadable ripgrep helper binaries. `remote_helper_policy` gates whether Nocturne may upload a managed `rg` helper after checking the target Host for an existing `rg`. If the remote Host already has `rg`, the provider label is `ripgrep on remote`. If not, Nocturne uses the bundled `rg` helper when policy permits. If the bundled helper is missing, Nocturne may ask the user to download the official ripgrep archive for the locked helper version, extract `rg` or `rg.exe`, and then upload the extracted helper. If policy is `ask`, the Workspace prompt must identify the helper name, purpose, Host, target OS, target architecture, upload path, and SHA-256 hash before upload. If policy is `never` or the user refuses, name search may fall back to `SFTP scan`; content search reports that ripgrep is required.

Search defaults follow ripgrep:

- respect ignore files
- do not search hidden files

Search UI includes toggles:

- Include hidden
- Ignore ignore files
- Follow symlinks

## Ripgrep Helper Packaging And Deployment

The helper manager is a provider-level abstraction. Files search first probes for an existing remote `rg`; when it is unavailable, Files search must deploy a managed ripgrep helper if policy permits.

Helper policy is configurable:

- Ask, default
- Never
- Allow

The prompt must clearly display:

- helper name: `rg`
- purpose: Files recursive search
- target Host
- target OS
- target architecture
- upload path
- checksum/hash

The application bundle must include `rg` helper binaries for supported target OS and architecture combinations. Packaging must not include only the app's current platform because SSH targets are runtime-dependent.

Supported helper bundle targets:

- Linux x86_64: `ripgrep/rg-<rg-version>-linux-x86_64`
- Linux aarch64: `ripgrep/rg-<rg-version>-linux-aarch64`
- Linux armv7: `ripgrep/rg-<rg-version>-linux-armv7`
- macOS x86_64: `ripgrep/rg-<rg-version>-macos-x86_64`
- macOS aarch64: `ripgrep/rg-<rg-version>-macos-aarch64`
- Windows x86_64: `ripgrep/rg-<rg-version>-windows-x86_64.exe`
- Windows i686: `ripgrep/rg-<rg-version>-windows-i686.exe`

Release CI must fetch or build every supported `rg` target before building app bundles. Because managed `rg` helpers come from upstream prebuilt archives, CI prepares all supported targets in one job, uploads one workflow artifact containing every flat `rg-*` file, downloads that artifact into `src-tauri/resources/ripgrep`, and lets Tauri include that resource tree in every app bundle. CI does not upload `rg` binaries to Nocturne GitHub Releases.

At runtime, Nocturne first looks for the bundled `rg` helper in app resources. If that file is missing, Nocturne may ask the user whether to download the official ripgrep archive for the locked helper version from `BurntSushi/ripgrep`. It extracts the `rg` or `rg.exe` binary from that archive before upload. It must not use `latest`, a Nocturne app tag, a different ripgrep version, or a guessed version.

Deployment status and hash validation are remembered per Host, but authentication still uses only the current Workspace's encrypted temporary credentials. Closing a Workspace does not delete an uploaded `rg` helper. If a remote helper's manifest or hash does not match the bundled helper, Nocturne validates and uploads again according to helper policy.

Remote helper paths:

```text
~/.cache/nocturne/helpers/<app-version>/rg-<rg-version>/rg
~/.cache/nocturne/helpers/<app-version>/rg-<rg-version>/rg.exe
~/.cache/nocturne/helpers/<app-version>/rg-<rg-version>/rg.manifest.json
```

Use a same-directory `rg.manifest.json` recording helper name, purpose, app version plus rg version, target OS, target architecture, remote upload path, checksum, and capabilities. Before execution, validate the manifest and helper. If validation fails, upload again.

Helpers may remain in the remote temp directory for reuse. Nocturne does not need to clean them after each search.
