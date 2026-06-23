# Application Config Storage

This document describes the storage model, runtime behavior, and implementation notes for Nocturne's application configuration system.

The goal is to give future maintainers one clear reference for how config is stored, merged, observed, and exposed to the UI.

## Summary

Nocturne stores configuration as TOML files inside Tauri's application config directory. The system is split into:

- Main application config
- Profile config
- Host/session config
- Runtime Workspace/window state
- File transfer state
- Private SSH trust store

Main config and profile config together form the application config. The effective application config is produced by deep-merging the main config and the active profile config, with the profile winning on conflicts.

Host config is stored separately as individual TOML files in configured host directories. User-created hosts use stable UUIDs, not content hashes, because connection history, keyring records, trust repair, default-host selection, and command palette entries need durable identity across edits.

Runtime Workspace/window state is separate from user-authored application config.
It can store the current process's workspaces, owned tool tabs, Dock layout,
floating windows, and active selections while the app is running. Application
startup does not restore previously persisted Workspace tabs; startup creates
the default Workspace template and overwrites stale runtime Workspace state.
The runtime snapshot does not store transient view state such as scroll
positions, hover, focus, or mirror slots.

OpenSSH config entries from configured OpenSSH config files are read as separate read-only sources. They do not live under the Nocturne config root and Nocturne must not write them. The default configured OpenSSH file is `~/.ssh/config`.

The Rust backend owns all file I/O. The Svelte frontend only talks to Rust through Tauri commands and reacts to file changes through TanStack Query plus a config-changed event.

## Storage Layout

All files live under the Tauri app config directory, inside a Nocturne root folder:

`<app_config_dir>/nocturne`

The current layout is:

- `config.toml` - main application config
- `state.toml` - startup state, including the active profile and whether the virtual default local host was removed
- `profiles/default.toml` - default profile
- `profiles/<name>.toml` - additional profiles
- `hosts/<uuid>.toml` - user-created hosts when using the default host directory
- `hosts/<folder>/<uuid>.toml` - user-created hosts organized into nested folders
- `known-hosts.toml` - private SSH host-key trust store for connection hosts
- `terminal-color-schemes/<id>.toml` - user terminal color schemes
- `workspace-state.toml` - disposable runtime Workspace, Dock, and floating-window snapshot; startup overwrites it with the default Workspace template instead of restoring old Workspaces
- `transfer-state.toml` - recoverable transfer task state when needed

The system also supports additional connection host directories through application config.

Configured OpenSSH config files and files reached through their supported `Include` directives are read-only external sources. They are not copied into this layout unless the user explicitly copies an OpenSSH entry into a Nocturne host directory.

## Storage Requirements

### 1. TOML storage

All config files are TOML.

### 2. Main config and profile config

Main config and profile config share the same schema.

When both define the same keys, the profile value wins.

This is a deep merge, not a shallow overwrite:

- nested tables are merged recursively
- scalar values are replaced by the profile
- arrays are replaced by the profile

### 3. Profile selection

The user must have an active profile.

The active profile is stored in `state.toml`.

If nothing has been selected yet, the system defaults to `profiles/default.toml`.

### 4. Connection host directories

Application config may specify one or more connection host directories through `host_dirs`.

Because main config and profile config are deep-merged, `host_dirs` may be defined in either file. If both define it, the active profile wins because arrays are replaced by the profile value.

If no custom host directory is stored, the default is:

- `hosts/`

relative to the application config root.

Each user-created connection host is stored in its own TOML file inside one of the configured host directories.

User-created host folders are represented by file location, not by a TOML field. For example, `hosts/work/prod/<uuid>.toml` appears in folder `work/prod`. Editing a folder in Host Manager moves the TOML file under the same configured host directory, and the backend creates missing directories automatically. Absolute paths and `..` segments are invalid folder values.

User-created host TOML may include an optional `[icon]` table. `folder` is part of the typed frontend-facing document so the UI can display and edit it, but Rust skips it during TOML serialization. Host icon storage, custom image/SVG handling, and OpenSSH read-only icon rules are defined in [Host Icons](host-icons.md).

User-created host TOML may include a host-level `[files]` table:

```toml
[files]
default_path = "~/Projects"
```

The default path is used by the Files tool tab. For local hosts it resolves on the local filesystem. For SSH hosts it resolves on the remote filesystem. It is an initial path only, not an access restriction.

Application config may also specify one or more OpenSSH config files through `openssh_config_files`.

If no custom OpenSSH config file list is stored, the default is:

- `~/.ssh/config`

Nocturne reads these files as read-only sources and expands their supported `Include` directives. Users can add or remove files from settings, similar to host directories. OpenSSH-derived hosts get a read-only `folder` value from the config file stem, for example `~/.ssh/config` becomes `config`; Nocturne must not persist folder edits back into OpenSSH files.

Application config may specify a default host through `default_host`. Nocturne exposes a virtual default local host as the initial default. If the user removes that virtual host, Nocturne stores `default_local_host_removed = true` in `state.toml` and stops showing it.

Terminal color schemes are stored separately from app config under `terminal-color-schemes/`.
Built-in schemes are provided by Rust and do not live on disk. User schemes are individual TOML files
that can be previewed, edited, copied, and exported from the settings window.

Workspace state and transfer state are automatic runtime files. They may change frequently and should not be hand-edited.

### 5. Stable connection host identity

User-created connection hosts use stable UUIDs stored in each host TOML file. The virtual default local host uses a reserved stable UUID but does not live on disk and is not editable.

Important detail:

- editing a host must not change its identity
- duplicate UUIDs are configuration errors
- duplicate display names are allowed
- the filename should match the UUID, for example `hosts/018f6eb3-6f91-7410-bc43-f927b2236d94.toml`
- a filename/document UUID mismatch is a diagnostic that must be shown in settings

Nocturne may offer a repair action that regenerates a duplicate UUID, but it must warn and ask before changing identity because related history and keyring records can be affected.

## Typed Documents

The on-disk format is TOML, but raw TOML text is not part of the frontend contract.

Rust parses TOML into typed document objects before returning data to the Svelte layer:

- `MainConfigDocument`
- `ProfileConfigDocument`
- `ConnectionHostDocument`
- `EffectiveConfigDocument`

Each document has a `root: ConfigTable`. A `ConfigTable` contains keyed `ConfigValue` entries. `ConfigValue` is a tagged union covering TOML-compatible values:

- string
- integer
- float
- boolean
- datetime
- array
- table

Integer values are transported over the Tauri/Specta TypeScript boundary as decimal strings, not JavaScript numbers. Rust converts them back to TOML signed 64-bit integers when writing documents. This avoids silent precision loss for TOML integers larger than JavaScript's safe integer range.

Empty TOML files are valid. They deserialize to the corresponding empty typed document:

```ts
{ root: { values: {} } }
```

This gives the frontend a stable typed shape even before a schema-specific editor exists.

Raw TOML is allowed only inside the Rust storage layer for parse, merge, validation, and serialization work. Do not send raw TOML file contents to the frontend.

## Backend API

Rust exposes the config layer through Tauri commands, exported with Tauri Specta.

The important commands are:

- `get_config_root`
- `get_config_snapshot`
- `list_profiles`
- `read_profile`
- `create_profile`
- `update_profile`
- `delete_profile`
- `set_active_profile`
- `read_main_config`
- `update_main_config`
- `read_connection_host`
- `list_connection_hosts`
- `create_connection_host`
- `update_connection_host`
- `delete_connection_host`
- `repair_connection_host_id`
- `set_host_dirs_command`
- `set_openssh_config_files_command`
- `set_default_host_command`
- `watch_config_command`
- `list_terminal_color_schemes`
- `read_terminal_color_scheme`
- `create_terminal_color_scheme`
- `update_terminal_color_scheme`
- `delete_terminal_color_scheme`
- `export_terminal_color_scheme_to_path`

### Command behavior notes

- Read commands return typed document objects, never raw TOML strings.
- Write commands accept typed document objects and serialize them to TOML internally.
- CRUD operations emit `config://changed` after successful writes.
- `watch_config_command` installs filesystem watchers so external edits also trigger refreshes.
- Connection host commands work with typed connection host documents and never expose raw TOML as the primary frontend contract.
- Session creation should prefer host IDs over protocol-specific commands. Local, SSH, and future Telnet hosts share the same host/session surface.

## Frontend Integration

The Svelte frontend uses TanStack Query for all config reads and writes.

Pattern:

- `createQuery` for reads
- `createMutation` for writes
- `invalidateQueries({ queryKey: ["config"] })` after mutations
- listen for `config://changed` and invalidate the same query group

The frontend should never read or write config files directly.

Terminal color scheme commands manage the standalone scheme files in `terminal-color-schemes/`.
The app theme to scheme mapping lives in config under `terminal.color_scheme.light` and
`terminal.color_scheme.dark`. The terminal content area uses the mapped scheme, while the app
chrome, settings window, and profile dialogs keep following `ui.theme`.

The workspace tab bar can optionally show saved-host icons:

```toml
[workspace]
show_host_icons_in_tabs = false
```

The default is `false`; when absent, workspace tabs remain text-only.

## Frontend Data Contract

The frontend must treat typed documents as the primary data model.

Do not use raw TOML strings as the main payload for UI state, form state, or mutation input. The Rust backend owns TOML parsing and serialization, and the Svelte layer works only with typed documents.

Practical rules:

- read commands return typed documents, not TOML text
- write commands accept typed documents, not TOML text
- UI state should be derived from typed documents
- save operations should send typed documents back through Tauri commands
- empty files must round-trip as empty typed documents, not as missing values

This keeps the frontend stable even when the on-disk TOML changes, and it keeps the storage contract localized to Rust.

## Important Implementation Notes

### 1. `state.toml` is part of the contract

`state.toml` is not optional bookkeeping.

It currently stores:

- `active_profile`
- `default_local_host_removed`

If you change config storage later, keep this file conceptually separate from application config. It prevents startup ambiguity and keeps host directory configuration persistent.

Host directories are not stored in `state.toml`; they belong to application config and are read from the effective deep-merged document.

OpenSSH config file lists and the default host are also application config, not state.

### 2. Connection host IDs are stable

Connection host IDs must not depend on TOML content, key order, filename casing, or display name.

The UUID in the document is the identity. It must remain stable across ordinary edits so recent connections, keyring records, trust repair, command palette entries, and protocol transports can refer to the same host.

Duplicate UUIDs, missing UUIDs, and filename/document UUID mismatches are diagnostics. Duplicate UUIDs should trigger an OS notification at startup and remain visible in settings until repaired. See `docs/connection-hosts.md`.

### 3. File watching is required

External edits should not require an app restart.

The app must watch:

- `config.toml`
- `state.toml`
- `profiles/`
- all configured host directories
- all configured OpenSSH config files that exist
- `known-hosts.toml`

When any of these change, emit `config://changed` and refresh the TanStack Query cache.

### 4. Bindings are generated

`src/lib/bindings.ts` is generated from Tauri Specta.

Do not treat it as hand-written source of truth.

If commands change, regenerate bindings from Rust rather than editing the file by hand.

### 5. Typed documents are serialized on write

Write paths should fail fast if the typed document cannot be serialized into TOML-compatible values.

That keeps bad config from being written to disk and makes contract errors visible immediately.

### 6. Empty documents are valid documents

An empty config file is not an error by itself.

It should deserialize to the empty typed shape for that document type, so the UI can open it, inspect it, and fill it in later.

### 7. Deep merge is the authoritative config rule

The effective application config is not a shallow overlay.

If a nested section is present in both main config and profile config, merge recursively.

This is the rule that enables fast profile switching without duplicating the entire config file.

## Practical Examples

### Main config

`config.toml`

```toml
[ui]
theme = "system"
language = "en"

[editor]
tab_width = 2

host_dirs = ["hosts"]
openssh_config_files = ["~/.ssh/config"]
default_host = "00000000-0000-0000-0000-000000000001"

[hosts]
show_address = true

[files]
default_view_mode = "tree" # tree | columns
show_hidden = true
delete_behavior = "direct" # direct | try_remote_trash
clipboard_semantics = "windows" # windows | finder
remote_helper_policy = "ask" # ask | never | allow
text_preview_limit_bytes = 1048576
image_preview_limit_bytes = 10485760
toolbar_actions = ["upload", "new_folder", "refresh", "view_mode"]
tree_sticky_enabled = true
tree_sticky_max_levels = 3

[resources]
default_refresh_interval = "2s" # 1s | 2s | 5s | 10s

[transfers]
global_concurrency = 3
per_host_concurrency = 2

[workspace]
restore_strategy = "visible_auto_reconnect" # visible_auto_reconnect | manual | safe_auto_restore
show_host_icons_in_tabs = false
```

### Profile config

`profiles/default.toml`

```toml
[editor]
tab_width = 4
```

### Terminal padding

Terminal text uses the npm-packaged Maple Mono font first and the vendored
`SymbolsNerdFontMono-Regular.ttf` from the official
`ryanoasis/nerd-fonts` Symbols-only release second. Users can override the full
xterm font stack with `terminal.font_family`:

```toml
[terminal]
font_family = "\"Maple Mono\", \"Symbols Nerd Font Mono\", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
```

The value is passed to xterm as CSS `font-family`, so family names containing
spaces must stay quoted inside the string. The Settings window exposes this as
Font Family.

Terminal content padding is configured under `terminal.padding`. A single numeric value applies to all sides:

```toml
[terminal]
padding = 6
```

For per-edge control, use a nested table. `horizontal` applies to left and right, `vertical` applies to top and bottom, and explicit edge values win over axis values:

```toml
[terminal.padding]
horizontal = 10
vertical = 8
left = 12
```

### Workspace and Dock state

Workspace and Dock layout are not configured through profile TOML. They are
runtime state stored separately in `workspace-state.toml`.

Startup does not restore `workspace-state.toml`. A fresh app process creates the
default Workspace template for the default host and writes that snapshot over
any stale runtime Workspace state. Runtime commands can still update the file
after startup.

The runtime state can store:

- workspace order and active workspace
- workspace host ids and user-renamed workspace titles
- owned tool tabs
- Dock layout tree and split ratios
- floating windows that contain mirror display slots for the current process
- active dock groups and active tool tabs

It does not store:

- mirror slots
- floating mirror slots
- scroll positions
- hover or focus state
- Tree expansion state
- temporary drag state

### Desktop integrated title bar

Desktop Workspace windows can use an integrated title bar so the horizontal
Workspace tab bar shares the native title-bar line:

```toml
[ui]
integrated_titlebar = true
integrated_titlebar_single_row = false
```

This defaults to `true` when absent. The setting applies only on desktop
platforms and only while the Workspace tab bar is horizontal. Vertical tab
layouts keep the standard system title bar.

macOS uses the existing native overlay title bar and positions the traffic-light
controls around the Workspace tabs. Windows and Linux use
`tauri-plugin-decorum` with platform-default window controls. Workspace windows
are created without the standard visual titlebar decoration when integrated
chrome is active, then decorum injects the window control buttons into the
Workspace titlebar slot. In dev URL / HMR runs such as `pnpm tauri dev`, the
Workspace slot also asks decorum to re-run its page-load bootstrap after the
Svelte titlebar has mounted so the controls do not disappear due to load-order
timing. If decorum cannot create its overlay title bar, Nocturne logs a warning
and falls back to the standard system title bar without blocking startup.

Windows and Linux integrated title bars keep app menu functionality by showing
only the `File`, `Edit`, `View`, and `Window` root buttons in the WebView
titlebar line. Clicking a root asks the Rust app shell to show the matching
native Tauri popup menu with `popup_menu_at`, reusing the same menu item IDs as
the app menu. This preserves the decorum visual chrome while keeping menu
selection, focus, and platform popup behavior native.

`ui.integrated_titlebar_single_row` is a Windows/Linux-only layout preference
and defaults to `false`. With the default off state, the integrated titlebar
uses a Zotero-style two-row layout: app menu roots sit on the first row beside
the decorum window controls, and Workspace tabs sit on the second row. When set
to `true`, Windows/Linux place app menu roots and Workspace tabs on the same
row. macOS always treats this setting as off and does not show it in Settings,
because macOS keeps the native menu bar and native overlay traffic-light
behavior.

Integrated chrome is limited to Workspace windows: the main window, additional
Workspace windows, and floating Workspace/ToolTab mirror windows. Settings,
Host Manager, profile dialogs, SSH prompts, and other utility dialogs keep
standard title bars.

### Effective config

```toml
[ui]
theme = "system"
language = "en"
integrated_titlebar = true
integrated_titlebar_single_row = false

[editor]
tab_width = 4
```

### Connection host config

Local host:

```toml
version = 1
id = "018f6eb4-3da8-73c8-9b2d-fca30a256196"
name = "Project Shell"
protocol = "local"

[icon]
type = "catalog"
name = "lucide:terminal"

[local]
command = "zsh"
args = ["-l"]
cwd = "~/Projects/nocturne"
```

SSH host:

```toml
version = 1
id = "018f6eb3-6f91-7410-bc43-f927b2236d94"
name = "Production API"
protocol = "ssh"

[icon]
type = "catalog"
name = "devicon:amazonwebservices"

[ssh]
hostname = "prod.example.com"
port = 22
username = "deploy"
identity_file = "~/.ssh/id_ed25519"
proxy_jump = "bastion"
forward_agent = true

[files]
default_path = "/var/www"
```

The host file name is derived from the stable UUID, not the host name.

### Private SSH trust store

```toml
version = 1

[[ssh]]
target = "prod.example.com:22"
keys = [
  "ssh-ed25519 SHA256:abc123",
]
```

## Things to Watch Carefully

- Do not make connection host IDs depend on raw file text formatting or document content.
- Do not allow duplicate connection host UUIDs to connect before repair.
- Do not store passwords or private-key passphrases in TOML.
- Do not write Nocturne trust decisions into `~/.ssh/known_hosts`.
- Do not write configured OpenSSH config files; they are read-only external inputs.
- Do not keep local shell creation as a separate app path from host/session creation.
- Do not pass raw TOML contents to the frontend.
- Do not silently fall back to an arbitrary profile if the active profile is missing.
- Do not bypass the Rust backend from the frontend.
- Do not mix application config and application state into one file.
- Do not remove the config-changed event unless the frontend invalidation strategy changes with it.
- Do not hand-edit `src/lib/bindings.ts`; regenerate it from Tauri/Specta after Rust command or type changes.
- Do not show main/profile/effective settings as three simultaneous editing columns. Use the menu entry to select the edit target.

## Current Source Locations

- Rust storage and commands: `src-tauri/src/config.rs`
- Native menu and settings/dialog windows: `src-tauri/src/app_shell.rs`
- Tauri command bindings: `src/lib/bindings.ts`
- Query-driven UI: `src/routes/+page.svelte`
- Reusable settings controls: `src/lib/settings/components/`
- Settings UI: `src/routes/settings/+page.svelte`

This document should be updated whenever the storage contract changes.
