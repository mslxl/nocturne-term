# Settings Page

Nocturne exposes settings through native menu entries and dedicated windows.

## Entry Points

- `File -> Settings...` opens the main settings window and edits `config.toml`.
- `File -> Profile -> Edit...` opens the same settings window in profile mode and edits the active profile file.
- `File -> Profile -> New...` opens a small dialog window for profile creation.
- `File -> Profile -> Delete...` opens a small dialog window for profile deletion.
- `File -> Profile -> <profile name>` switches the active profile directly.

The settings window uses the label `settings`. If it already exists, menu actions focus it and emit `settings://navigate` so the frontend changes mode without opening a duplicate window.

Profile dialogs use stable labels (`dialog-profile-new`, `dialog-profile-delete`) so repeated menu actions focus the existing dialog instead of creating another one.

## Layout

The settings page uses a native-feeling split layout:

- wide windows show categories on the left and setting rows on the right
- narrow windows show only categories first, then navigate into a category detail view
- categories are compact list rows, not web-style cards
- rows use native-feeling controls: segmented buttons, checkboxes/switches, inputs, textareas, selects, and list controls for repeated values

Avoid page transitions and decorative effects. Native settings windows should cut between views and keep interaction immediate.

## Main Settings vs Profile Settings

Main settings edit `config.toml`.

Profile settings edit the active profile TOML file. The profile page shows the same standard setting rows as the main page, but each row can be either:

- inherited: the profile does not define that key, so the effective value comes from main settings or built-in defaults
- overridden: the profile defines that key

Inherited rows are visually muted. Overridden rows expose a `Use Default` button. `Use Default` calls `remove_config_key`, which removes the leaf key from the profile document. Empty parent tables are removed by Rust so the profile file does not accumulate table shells.

Do not show main/profile/effective values as three separate columns. The menu entry determines the editing context.

The Profiles category shows the current configuration root directory from `ConfigRootInfo.root_dir`. The row is read-only and includes an Open button that uses the platform file manager through the Tauri opener plugin. Keep this as a native open action, not an in-app file browser.

## Theme

The app-level theme is stored at:

```toml
[ui]
theme = "system" # system | light | dark
```

`system` follows `prefers-color-scheme`. The frontend applies the resolved theme to `document.documentElement.dataset.theme`, and windows listen for config changes so the main terminal, settings window, and profile dialogs refresh immediately.

The app theme owns shared chrome: settings pages, profile dialogs, workspace tab bars, dock groups, tool tab bars, section backgrounds, and error surfaces use the shared app palette. Terminal content uses a theme-specific terminal color scheme.

## Terminal Color Schemes

Terminal color schemes are stored separately from app theme settings and are mapped by app theme:

```toml
[terminal.color_scheme]
light = "builtin:nocturne-light"
dark = "builtin:nocturne-dark"
```

The built-in schemes are:

- `builtin:nocturne-light`
- `builtin:nocturne-dark`

User-created schemes are stored under the app config directory in `terminal-color-schemes/` as individual TOML files. The settings page lets users:

- preview a scheme before saving
- create a new scheme from a blank or copied template
- edit existing user schemes
- export a scheme to a chosen file path
- map the light and dark app themes to different schemes

The terminal preview should include the palette, foreground/background, and a small ANSI swatch set so the user can see what they are editing before saving.

## Language

The app-level language is stored at:

```toml
[ui]
language = "en" # en | zh
```

On first use, the frontend defaults to Chinese when `navigator.language` starts with `zh`; otherwise it defaults to English. Once the user selects a language, the setting is saved in config.

User-facing frontend text should use the lightweight dictionary under `src/lib/i18n/`.

## Integrated Title Bar

Desktop Workspace windows can place the horizontal Workspace tab bar in the
native title bar:

```toml
[ui]
integrated_titlebar = true
integrated_titlebar_single_row = false # Windows/Linux only
```

The setting defaults to `true` and is available on desktop platforms. It is only
applied when the Workspace tab bar is horizontal; vertical tab layouts keep the
standard system title bar.

macOS uses the native overlay title bar and traffic-light positioning already
used by the app. Windows and Linux use `tauri-plugin-decorum` with
platform-default controls so Snap Layout and native window interactions remain
available. If decorum fails to create its overlay, the app logs a warning and
keeps the standard system title bar.

On Windows and Linux, decorum's overlay can replace the visual space where a
traditional menu bar would normally sit. To keep the integrated visual effect
without losing app-menu behavior, the integrated title bar renders only the
root menu buttons (`File`, `Edit`, `View`, `Window`) in the WebView. Activating
one of those roots calls the Rust app shell, which opens the corresponding
native Tauri popup menu at the button location. Do not replace this with a
WebView-drawn menu overlay; menu actions should continue through the same
native menu IDs handled by the app shell.

The Windows/Linux titlebar menu layout is controlled by:

```toml
[ui]
integrated_titlebar_single_row = false
```

This setting defaults to `false`. When it is off, the Windows/Linux integrated
titlebar follows a Zotero-style layout: `File`, `Edit`, `View`, and `Window`
occupy the first titlebar row with the window controls, and Workspace tabs use
the row below. When it is on, the app menu roots and Workspace tabs share one
row, matching the earlier compact layout. This setting is shown only on Windows
and Linux. On macOS it is always treated as off because macOS uses the native
menu bar and native traffic-light overlay behavior.

Integrated title bars apply only to Workspace windows: the main Workspace
window, additional Workspace windows, and floating Workspace/ToolTab mirror
windows. Settings, Host Manager, profile dialogs, SSH prompts, and utility
dialogs keep standard native title bars.

The integrated tab bar must leave safe empty drag zones around controls.
Workspace tab buttons, close buttons, Host picker buttons, ToolTab chrome, Dock
resize handles, Terminal content, Files selection surfaces, and context-menu
targets must remain normal interactive controls.

## Immediate Refresh

Config writes emit `config://changed`. Windows should listen for that event and refresh their config snapshot or terminal settings.

The main terminal window refreshes:

- app theme
- terminal settings
- xterm options for existing Terminal ToolTabs where xterm supports live option updates
- workspace, dock, and Files settings that are designed for live refresh

Some settings, such as terminal command, args, cwd, and environment-related values, only affect new terminal sessions because existing PTY processes cannot be safely mutated.

## Reusable Controls

Settings rows use small reusable Svelte components under `src/lib/settings/components/`:

- `SettingRow.svelte` owns the label/help/inheritance layout for a single row.
- `SegmentedControl.svelte` is for compact mutually exclusive choices such as theme, renderer, and view modes.
- Language uses a native select so the control scales better as more locales are added.
- `SwitchControl.svelte` is for boolean settings.
- `HostDirsControl.svelte` is for editable path lists, with `+` opening the native file/directory picker and `-` removing the selected row. It is used for host directories and OpenSSH config files.
- `TerminalColorSchemeManager.svelte` manages terminal palette schemes, previews, and light/dark theme mapping.

Keep these controls visually restrained. They should feel like compact desktop settings controls, not web cards. Add focus-visible states for keyboard users and keep pressed/selected states distinct.

## Connection Hosts

The Hosts category manages connection hosts. See `docs/connection-hosts.md` for the full storage, security, and protocol contract.

Connection host CRUD is not part of the settings window. The settings Hosts category only manages host-directory, OpenSSH config file, and display preferences. Default host selection belongs in Host Manager as a per-host switch backed by the single `default_host` config value.

OpenSSH and editable Nocturne host entries are managed in the dedicated Host Manager window. The Host Manager should explain that configured OpenSSH files are shared by other tools and are therefore read-only in Nocturne. It should offer a copy action that creates an editable Nocturne host in a selected writable host directory.

The OpenSSH config file list defaults to `~/.ssh/config`. Users may add or remove files in settings. These files are read-only inputs; Nocturne never rewrites them.

Duplicate UUIDs are configuration errors; show them persistently in Host Manager and disable connection until repaired. Settings may also surface a terse warning when host directories contain blocking diagnostics.

The Host Manager can be opened from the command palette and from the host picker used when creating a new workspace.

Host Manager's left side is a TreeView over virtual host folders, not grouped sections. Host rows should show only the display name and connection address subtitle; storage path/source details belong in the inspector or diagnostics, not the list row.

## Workspace And Dock

The main window uses Host Workspace tabs and a shared IDE-style Dock system. See [Workspace Tabs](workspace-tabs.md) and [Dock Layout](dock-layout.md).

Settings should expose:

- workspace reconnect strategy: visible auto reconnect, manual reconnect, safe auto restore
- dock and workspace keybindings
- desktop integrated title bar behavior
- default Resource Monitor refresh interval

Top-level Workspace tabs represent host-bound workspaces. Inner Tool tabs represent Files, Terminal, Resources, and Transfers surfaces. Do not add settings that describe top-level tabs as terminal sessions.

## Files And Transfers

Files and transfer settings belong in a dedicated Files or File Transfer category. See [Files ToolTab](files-tooltab.md) and [File Transfers](file-transfers.md).

Settings should expose:

- default Files view mode: Tree or Columns
- show hidden files default
- delete behavior: direct delete or try remote Trash
- copy/cut/paste mode: Windows-style or Finder-style
- remote helper policy: Ask, Never, Allow
- remote helper policy controls managed helper upload decisions, including Resource Monitor's `nocturne-resource-monitor-agent` and Files search's managed `rg` helper after probing for an existing remote `rg`
- text preview size threshold, default 1 MiB
- image preview size threshold, default 10 MiB
- toolbar action visibility and order as one action id per line: `up`, `refresh`, `new_folder`, `paste`, `upload_files`, `upload_folder`, `search`, `view_mode`, `path`; selection-scoped file actions such as rename, permissions, delete, copy, cut, and download belong to the Files context menu and are ignored in toolbar settings
- global transfer concurrency, default 3
- per-host transfer concurrency, default 2

Host-specific Files default paths belong in Host Manager as `[files].default_path`, not in global Files settings.

## Resource Monitor

Resource Monitor settings belong with Workspace/Tools or the peer tool settings category, not inside Files settings. See [Resource Monitor ToolTab](resource-monitor.md).

Settings should expose:

- `Default resource refresh interval`: 1s, 2s, 5s, or 10s; default 2s

ToolTab-local refresh interval changes are temporary and do not write this default setting.

## Workspace Tab Bar

Host icons in top-level workspace tabs are controlled by:

```toml
[workspace]
show_host_icons_in_tabs = false
```

The setting defaults to `false`. When enabled, workspace tab items show the saved-host icon for their bound host. Tool tabs do not show host icons unless they are mirrors and need source identity.

Right-clicking the workspace tab bar opens a native Tauri popup menu, not a WebView-drawn menu. This preserves native context-menu behavior and avoids browser-style chrome.

## Terminal Close Confirmation

Closing a running Terminal ToolTab asks for confirmation by default:

```toml
[terminal]
confirm_close = true
```

When set to `false`, running Terminal ToolTabs close immediately. Exited or errored terminal sessions already close without confirmation. The confirmation uses the platform dialog path so close behavior keeps native focus and keyboard handling.

## Implementation Notes

- Frontend settings use typed config documents, not raw TOML.
- Raw TOML remains isolated inside Rust config storage.
- `src/lib/bindings.ts` is generated by Tauri Specta. Do not edit it manually.
- When adding Tauri commands or exported types, run the debug Tauri dev flow to regenerate bindings.
- Menu construction depends on config paths, so the initial menu is installed in `setup` after `ensure_layout`.
- On macOS, Tauri's default menu must be disabled and a lightweight bootstrap app menu must be installed through the builder before the first window is created. AppKit treats the first root menu as the application menu; without the bootstrap, a later `setup` menu install can leave File/Edit/View/Window showing system defaults or move File content under the app-name menu.
- When validating macOS menus with System Events, multiple running apps named `nocturne` can make process lookup ambiguous even when a PID appears to be used. Launch the debug build with a unique window title and locate the process by that window title before reading menu bar items.
