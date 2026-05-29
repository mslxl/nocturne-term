# Command Palette

This document defines Nocturne's app-local command palette contract.

## Goals

The command palette is a fast app-local entry point for commands and dynamic actions that are slow to reach through menus alone:

- create or switch profiles
- switch app theme
- split panes
- move panes
- open settings
- jump to a tab
- toggle pane zoom

The palette follows the native-feel rule T3: adopt the platform; do not compete with it. It is an app command window, not a system launcher. It must feel like a lightweight macOS or Windows command surface rather than a web modal.

## Entry Points

- macOS: `Meta+Shift+P`
- Windows/Linux: `Ctrl+Shift+P`
- native menu: `Command Palette...`
- scope: only while a Nocturne main window is active

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
- closing restores focus to the previously active terminal pane when possible

Actions that open a native window or dialog, such as settings or new profile, close the palette and then focus the target window.

## Result Types

The palette returns both static commands and dynamic objects:

- `command`: terminal, pane, window, and app commands
- `tab`: a concrete terminal tab
- `profile`: a concrete profile
- `theme`: a concrete app theme choice

Dynamic results should be first-class items, not second-level menus. A user can type a profile name and switch directly to that profile, or type a tab title and jump directly to that tab. Dynamic object results must include the action in the visible title so they read as commands, not bare objects.

Tab results show the one-based tab number without mutating the tab title:

```text
Switch to Tab: 2  server             Tab
```

The tab number is searchable by `2`, `tab 2`, and localized tab labels.

Profile results follow the same pattern:

```text
Switch Profile: default              Profile
```

## Command IDs

Menu items, keyboard shortcuts, and palette results should converge on stable command IDs. Do not create palette-only action logic when an existing command path can be reused.

Initial IDs:

```text
app.openCommandPalette
settings.open
profile.new
profile.switch:<profileName>
ui.theme.system
ui.theme.light
ui.theme.dark
terminal.newTab
terminal.splitLeft
terminal.splitRight
terminal.splitUp
terminal.splitDown
terminal.movePaneLeft
terminal.movePaneRight
terminal.movePaneUp
terminal.movePaneDown
terminal.togglePaneZoom
tab.switchTo:<tabId>
```

`terminal.togglePaneZoom` is a real toggle. Running it while a pane is zoomed restores the previous split layout. Running it while no pane is zoomed zooms the active pane.

## Search Contract

Search is language-wide, not only current-language:

- current UI language title
- English title
- current UI language keywords
- English keywords
- Chinese pinyin full spelling
- Chinese pinyin initials
- dynamic tab title, current directory, command, and tab number
- dynamic profile name

Examples:

- `split`, `拆分`, `chaifen`, and `cf` can find split commands
- `dark` can find dark theme while the UI is Chinese
- `2` and `tab 2` can find the second tab

The search index can be hand-authored for the small command set. It does not need a general Chinese segmentation engine.

## Ranking

Ranking should be stable enough for muscle memory:

- exact match
- prefix match
- ordered fuzzy match
- current-context boost
- small recent-use boost

Static command results must not be permanently buried by dynamic tab/profile results. Preserve flows like `Meta+Shift+P`, `spl`, `Enter`.

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
- Keep Svelte UI as a thin renderer over palette items and execution callbacks.
- Profile and theme changes write config through typed Tauri commands and then refresh app menu/config state.
- Settings and profile creation should use existing app shell commands or generated command helpers rather than duplicating window creation behavior in the frontend.
- Tauri command/type changes require regenerating `src/lib/bindings.ts` through the debug dev flow. Do not hand-edit generated bindings.

## Validation

After implementation:

1. Run `pnpm test`.
2. Run `pnpm check`.
3. Run `cargo check`.
4. Run a real Tauri debug session and verify:
   - `Meta+Shift+P` or `Ctrl+Shift+P` opens the palette
   - `Escape` closes and focus returns to the active terminal
   - split commands create panes
   - move-pane commands move the active pane in all four directions when multiple panes exist
   - `Toggle Pane Zoom` zooms and restores the active pane
   - settings opens the settings window
   - new profile opens the profile dialog
   - profile results switch active profile and refresh configuration
   - theme results update all visible app chrome
   - tab results can be found by title and by number
   - English search works in Chinese UI and Chinese/pinyin search works in English UI

Record any Tauri-specific behavior discovered during testing in this document before considering the feature complete.

## Tauri Testing Notes

- Tauri menu accelerators can fire while a settings/dialog window is frontmost. Menu actions that emit to the main WebView must focus the target main window before emitting so the palette appears above the right window and accepts keyboard input.
- Frontend `listen(...)` handlers should not add an extra `target` filter when listening inside the current WebView. The Rust side already emits to the intended webview window label; adding a mismatched target filter can silently drop menu events.
- macOS UI automation can become ambiguous when multiple debug builds share the same process name (`nocturne`). Prefer closing unrelated Nocturne debug instances before validating menu items with System Events, or use screenshots/window titles to confirm the target instance.
