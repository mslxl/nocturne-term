# Command Palette

This document defines Nocturne's app-local command palette contract.

## Goals

The command palette is a fast app-local entry point for commands and dynamic actions that are slow to reach through menus alone:

- create or switch profiles
- switch app theme
- create or switch host workspaces
- split or move tool tabs in the Dock layout
- open Files, Terminal, Resource Monitor, and Transfers tool tabs
- open settings
- jump to a workspace or tool tab
- search remote files

The palette follows the native-feel rule T3: adopt the platform; do not compete with it. It is an app command window, not a system launcher. It must feel like a lightweight macOS or Windows command surface rather than a web modal.

## Entry Points

- macOS: `Meta+Shift+P`
- Windows/Linux: `Ctrl+Shift+P`
- native menu: `Command Palette...`
- scope: only while a Nocturne main window is active

The keyboard shortcut is the default value for `app.openCommandPalette` in the shared keybinding registry. Users can remap it from settings, and the frontend keyboard handler must route it through that registry instead of a page-local hard-coded shortcut.

Do not bind global shortcuts such as `Meta+Space`, `Alt+Space`, or other OS launcher muscle-memory keys.

## Window Behavior

The palette is drawn in the main window as a lightweight command window:

- compact width, around 560-640px on desktop
- no page backdrop, no blurred overlay, no full-window modal treatment
- input is focused when opened
- `Escape` closes the palette
- `Enter` runs the selected result
- `ArrowUp` and `ArrowDown` move selection
- executing a result closes the palette by default
- closing restores focus to the previously active tool surface when possible

Actions that open a native window or dialog, such as settings or new profile, close the palette and then focus the target window.

## Result Types

The palette returns both static commands and dynamic objects:

- `command`: workspace, dock, file, terminal, transfer, window, and app commands
- `workspace`: a concrete host workspace
- `tool-tab`: a concrete tool tab
- `profile`: a concrete profile
- `theme`: a concrete app theme choice
- `connection-host`: a concrete local, SSH, or future protocol host
- `transfer-task`: a concrete transfer task

Dynamic results should be first-class items, not second-level menus. A user can type a profile name and switch directly to that profile, type a workspace title and jump directly to that workspace, or type a tool tab title and focus that tool. Dynamic object results must include the action in the visible title so they read as commands, not bare objects.

Workspace results show the one-based workspace number without mutating the workspace title:

```text
Switch Workspace: 2  Production      Workspace
```

The workspace number is searchable by `2`, `workspace 2`, `tab 2`, and localized workspace/tab labels.

Profile results follow the same pattern:

```text
Switch Profile: default              Profile
```

Connection host results create host-bound workspaces. They follow the same action-first pattern and must include the action in the title:

```text
Open Workspace: Local Shell          Local
Open Workspace: Production API       SSH
Open Workspace: prod                 ~/.ssh/config
```

Files and transfer results follow the same action-first pattern:

```text
Open Files: Production API           SSH
Search Files: /var/www               Files
Show Transfer: upload assets         Transfer
```

## Command IDs

Menu items, keyboard shortcuts, and palette results should converge on stable command IDs. Do not create palette-only action logic when an existing command path can be reused.

Initial IDs:

```text
app.openCommandPalette
settings.open
hosts.openManager
profile.new
profile.switch:<profileName>
ui.theme.system
ui.theme.light
ui.theme.dark
workspace.new:<connectionHostId>
workspace.switchTo:<workspaceId>
workspace.close
workspace.closeOthers
workspace.closeToRight
workspace.rename
dock.splitLeft
dock.splitRight
dock.splitUp
dock.splitDown
dock.floatToolTab
dock.restoreFloatingToolTab
dock.focusGroupLeft
dock.focusGroupRight
dock.focusGroupUp
dock.focusGroupDown
tool.openFiles
tool.openTerminal
tool.openResources
tool.openTransfers
tool.close
tool.closeOthers
tool.closeToRight
terminal.newSession
files.search
transfers.show
```

Terminal split commands should be implemented through Dock split commands. Do not add terminal-layout-only command IDs.

## Search Contract

Search is language-wide, not only current-language:

- current UI language title
- English title
- current UI language keywords
- English keywords
- Chinese pinyin full spelling
- Chinese pinyin initials
- dynamic workspace title, host name, host address, and workspace number
- dynamic tool tab title, current directory, provider path, command, and group context
- dynamic profile name
- dynamic connection host display name, configured hostname, username, protocol, folder path, and tags when available
- transfer task source, destination, file names, status, and related host names

Examples:

- `split`, `拆分`, `chaifen`, and `cf` can find split commands
- `dark` can find dark theme while the UI is Chinese
- `2`, `tab 2`, and `workspace 2` can find the second workspace
- `prod`, `deploy`, and `ssh` can find an SSH connection host when those values are part of its metadata
- `local`, `shell`, and configured command names can find local hosts
- `upload`, `assets`, or a host name can find an active transfer task

The search index can be hand-authored for the small command set. It does not need a general Chinese segmentation engine.

## Ranking

Ranking should be stable enough for muscle memory:

- exact match
- prefix match
- ordered fuzzy match
- current-context boost
- small recent-use boost

Static command results must not be permanently buried by dynamic workspace/tool/profile results. Preserve flows like `Meta+Shift+P`, `spl`, `Enter`.

Connection host result IDs must use stable connection host UUIDs for user hosts. OpenSSH config results should use a stable derived source key from the config path and host alias. Connection host scopes should include folder metadata; Nocturne user host folders come from host file paths, while OpenSSH folders come from the read-only config file stem. Visible host subtitles should stay to the connection address shape defined in `docs/connection-hosts.md`, not storage paths or source labels.

Unavailable actions are hidden by default. If the user searches for a very specific unavailable action, it may appear disabled with a short reason. Keep disabled reasons terse.

## Native-Feel Notes

- Use system fonts and app theme tokens.
- Do not use `cursor: pointer` on result rows.
- Result rows may have subtle hover/selection backgrounds like native lists.
- Keep copy sparse: title, scope, optional shortcut, optional short disabled reason.
- Avoid transitions that delay input. Opening and filtering should feel immediate.
- Do not embed profile creation or settings editing inside the palette. Use existing native-feeling windows and dialogs.
- Use OverlayScrollbars for the result list when the list overflows. Keep the thumb subtle and overlay-style so it behaves like a native command surface instead of a web scroll box.

## Implementation Notes

- Put reusable search and ranking logic in a small library module with direct tests.
- Single-module Vitest unit tests may live beside the module as `*.test.ts`; command-palette tests that cover multiple modules or source contracts must live under `/tests`.
- Keep Svelte UI as a thin renderer over palette items and execution callbacks.
- Profile and theme changes write config through typed Tauri commands and then refresh app menu/config state.
- Settings and profile creation should use existing app shell commands or generated command helpers rather than duplicating window creation behavior in the frontend.
- Workspace, Dock, Files, and Transfers commands should use the shared command registry. The palette should not own layout or file-operation business logic.
- Tauri command/type changes require regenerating `src/lib/bindings.ts` through the debug dev flow. Do not hand-edit generated bindings.

## Validation

After implementation:

1. Run `pnpm test`.
2. Run `pnpm check`.
3. Run `cargo check`.
4. Run a real Tauri debug session and verify:
   - `Meta+Shift+P` or `Ctrl+Shift+P` opens the palette
   - `Escape` closes and focus returns to the active terminal
   - workspace results switch workspaces
   - tool tab results focus tool tabs
   - split commands create Dock splits
   - Files search opens the active Files search panel
   - Transfers results focus transfer tasks
   - settings opens the settings window
   - new profile opens the profile dialog
   - profile results switch active profile and refresh configuration
   - theme results update all visible app chrome
   - workspace and tool tab results can be found by title and by number where applicable
   - English search works in Chinese UI and Chinese/pinyin search works in English UI

Record any Tauri-specific behavior discovered during testing in this document before considering the feature complete.

## Tauri Testing Notes

- Tauri menu accelerators can fire while a settings/dialog window is frontmost. Menu actions that emit to the main WebView must focus the target main window before emitting so the palette appears above the right window and accepts keyboard input.
- Frontend `listen(...)` handlers should not add an extra `target` filter when listening inside the current WebView. The Rust side already emits to the intended webview window label; adding a mismatched target filter can silently drop menu events.
- macOS UI automation can become ambiguous when multiple debug builds share the same process name (`nocturne`). Prefer closing unrelated Nocturne debug instances before validating menu items with System Events, or use screenshots/window titles to confirm the target instance.
