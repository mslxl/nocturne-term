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

The first implementation keeps an application-local clipboard of provider endpoint references, not file bytes. Copy may cross local/SFTP providers and hosts by creating Transfer Service tasks. Cut/paste performs same-provider moves through rename. Cross-provider or cross-host moves must not delete the source until the transfer service can atomically mark copy completion and then remove the source; until then, the UI should ask the user to copy first and delete manually after completion.

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

Files supports remote recursive search in the first release. The initial implementation provides recursive name search through `local scan` and `SFTP scan`. Content search is layered onto the same UI and command contract through ripgrep providers.

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
- `find on remote`
- `grep on remote`
- `SFTP scan`
- `local scan`
- `local ripgrep`

When using `rg --json`, show matching lines and highlight ranges. Fallback providers should at least show matching lines when content search is supported. Scan providers return file/path matches only and must label themselves clearly.

The first release does not ship a full uploadable helper manager. `remote_helper_policy` only gates whether Nocturne may try a remote `rg` check before falling back to `SFTP scan`. If the remote host has `rg`, the provider label is `ripgrep on remote`; otherwise the UI falls back to `SFTP scan` after an explicit user confirmation when policy is `ask`.

Search defaults follow ripgrep:

- respect ignore files
- do not search hidden files

Search UI includes toggles:

- Include hidden
- Ignore ignore files
- Follow symlinks

## Remote Helper

The helper manager is a provider-level abstraction. The first release only ships a ripgrep helper for remote search.

Helper policy is configurable:

- Ask, default
- Never
- Allow

If remote `rg` is unavailable and policy permits, Nocturne can upload a managed `rg` helper after clear user confirmation or automatically under Allow.

First-release behavior is narrower than the long-term helper design: Nocturne probes for `rg` on the remote host first. It does not upload a helper binary yet.

Remote helper paths:

```text
$TMPDIR/nocturne/helpers/<version>/rg
/tmp/nocturne-$USER/helpers/<version>/rg
~/.cache/nocturne/helpers/<version>/rg
```

Use a same-directory `manifest.json` recording helper name, version, target OS, target architecture, checksum, and upload time. Before execution, validate the manifest and helper. If validation fails, upload again.

Helpers may remain in the remote temp directory for reuse. Nocturne does not need to clean them after each search.
