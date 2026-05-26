# Application Config Storage

This document describes the storage model, runtime behavior, and implementation notes for Nocturne's application configuration system.

The goal is to give future maintainers one clear reference for how config is stored, merged, observed, and exposed to the UI.

## Summary

Nocturne stores configuration as TOML files inside Tauri's application config directory. The system is split into:

- Main application config
- Profile config
- Host config

Main config and profile config together form the application config. The effective application config is produced by deep-merging the main config and the active profile config, with the profile winning on conflicts.

Host config is stored separately as individual TOML files. Host files are identified by a content hash, and the hash is intentionally independent of TOML key order.

The Rust backend owns all file I/O. The Svelte frontend only talks to Rust through Tauri commands and reacts to file changes through TanStack Query plus a config-changed event.

## Storage Layout

All files live under the Tauri app config directory, inside a Nocturne root folder:

`<app_config_dir>/nocturne`

The current layout is:

- `config.toml` - main application config
- `state.toml` - startup state, currently only the active profile
- `profiles/default.toml` - default profile
- `profiles/<name>.toml` - additional profiles
- `hosts/<hash>.toml` - host configs when using the default host directory
- `terminal-color-schemes/<id>.toml` - user terminal color schemes

The system also supports additional host directories through application config.

## Requirements Implemented

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

### 4. Host config directories

Application config may specify one or more host config directories through `host_dirs`.

Because main config and profile config are deep-merged, `host_dirs` may be defined in either file. If both define it, the active profile wins because arrays are replaced by the profile value.

If no custom host directory is stored, the default is:

- `hosts/`

relative to the application config root.

Each host is stored in its own TOML file inside one of the configured host directories.

Terminal color schemes are stored separately from app config under `terminal-color-schemes/`.
Built-in schemes are provided by Rust and do not live on disk. User schemes are individual TOML files
that can be previewed, edited, copied, and exported from the settings window.

### 5. Hash-based host identity

Host IDs are computed from the host config content.

Important detail:

- the hash must not depend on TOML key order
- two TOML documents with the same logical content but different key order should produce the same ID

The current implementation hashes a normalized TOML value after parsing.

## Typed Documents

The on-disk format is TOML, but raw TOML text is not part of the frontend contract.

Rust parses TOML into typed document objects before returning data to the Svelte layer:

- `MainConfigDocument`
- `ProfileConfigDocument`
- `HostConfigDocument`
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

Raw TOML is allowed only inside the Rust storage layer for parse, merge, hash, and serialization work. Do not send raw TOML file contents to the frontend.

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
- `read_host`
- `list_hosts`
- `create_host`
- `update_host`
- `delete_host`
- `set_host_dirs_command`
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

If you change config storage later, keep this file conceptually separate from application config. It prevents startup ambiguity and keeps host directory configuration persistent.

Host directories are not stored in `state.toml`; they belong to application config and are read from the effective deep-merged document.

### 2. Host update changes the ID

Because host IDs are content hashes, editing a host can change its ID and therefore its filename.

This is expected.

Do not assume host IDs are stable across edits.

### 3. File watching is required

External edits should not require an app restart.

The app must watch:

- `config.toml`
- `state.toml`
- `profiles/`
- all configured host directories

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
```

### Profile config

`profiles/default.toml`

```toml
[editor]
tab_width = 4
```

### Terminal padding

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

### Terminal tab bar placement

Terminal tab placement is configured under `terminal.tab_bar_orientation`:

```toml
[terminal]
tab_bar_orientation = "horizontal" # horizontal | vertical_left | vertical_right
```

Older configs that use `"vertical"` remain valid. Rust treats that value as `"vertical_right"` when producing typed settings.

### Effective config

```toml
[ui]
theme = "system"
language = "en"

[editor]
tab_width = 4
```

### Host config

```toml
[host]
name = "production"
url = "https://example.com"
```

The host file name is derived from the content hash, not the host name.

## Things to Watch Carefully

- Do not make host IDs depend on raw file text formatting.
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
