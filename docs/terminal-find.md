# Terminal Find

This document defines Nocturne's Terminal ToolTab find behavior.

## Goals

Terminal find is a compact, keyboard-first way to search the active Terminal ToolTab's visible buffer and scrollback. It should feel like a native terminal find affordance, not a web page search field.

The first implementation searches only the active Terminal ToolTab. It does not search every Terminal ToolTab in a Workspace, inactive Workspaces, Files content, transfer logs, export scrollback, save session output, or copy ANSI-styled text.

## Scope

Search scope:

- current active Terminal ToolTab only
- visible screen plus scrollback
- plain text content, not ANSI escape/control sequences

Out of scope:

- all-terminal search
- all-workspace search
- persistent session transcript recording
- scrollback export or save-to-file flows
- copying with ANSI styling
- multi-line regular expression matching

These can be added later as separate features, but should not be hidden inside the find bar.

## Find Bar

The find bar is an overlay or compact toolbar attached to the active Terminal ToolTab content area. It should remain visually restrained and should not resize Dock groups or terminal containers.

Controls:

- text input
- match count, shown as `current / total` or `0`
- previous match button
- next match button
- match-case toggle
- regular-expression toggle
- copy matching line button, with tooltip `Copy matching line`
- close button

Behavior:

- `Cmd+F` on macOS and `Ctrl+F` on Windows/Linux are the default values for `terminal.find`.
- `Cmd+G` / `Ctrl+G` and `Cmd+Shift+G` / `Ctrl+Shift+G` are the default values for `terminal.findNext` and `terminal.findPrevious`.
- The frontend keyboard handler routes these through the shared keybinding registry.
- Native menu Find commands emit the same command path so menu and keyboard behavior stay aligned.
- Opening the find bar seeds the query from the active terminal selection when the selection is not empty.
- Input changes update highlights without moving keyboard focus out of the input.
- `Enter` moves to the next match.
- `Shift+Enter` moves to the previous match.
- `Esc` closes the find bar, clears find highlights, and returns focus to the terminal.
- Closing the find bar clears both `SearchAddon` decorations and xterm's active selection.
- Previous/next buttons move the active match and return focus to the terminal.
- The close button closes the bar, clears highlights, and returns focus to the terminal.

The find input disables spellcheck and browser text assistance. It should support IME composition naturally at the input caret.

## Search Semantics

Search defaults:

- case-insensitive
- literal text, not regular expression
- no whole-word mode in the first implementation

Case-sensitive mode passes the query through as an exact case match.

Regular-expression mode treats the query as a JavaScript regular expression pattern. Invalid regular expressions must show an error state and must not silently fall back to literal search. Regular expressions are line-oriented in the product contract; they should not be presented as cross-line search.

Whitespace in the query is meaningful. An empty query clears highlights and disables previous, next, copy, and count output.

## Match Count

The find bar shows a match position and total count when the query is valid and at least one match exists.

Counting must not make typing feel slow. If an exact total is too expensive for very large scrollback, the UI may cap the count and show a capped total such as `1000+`, but the first implementation should verify performance before adding a cap indicator.

The active match count should update after:

- query changes
- case/regex toggles change
- previous/next navigation
- active Terminal ToolTab changes while the find bar is open
- new terminal output arrives while the find bar is open

## Copy Matching Line

The copy button copies the logical terminal line containing the active match.

Rules:

- copy plain text only
- do not copy ANSI styling or control sequences
- prefer the logical wrapped line rather than the visual row when a command or output line soft-wraps
- trim trailing terminal padding spaces, but preserve meaningful leading indentation
- disabled when there is no active match, no valid query, or no terminal instance

The button tooltip is exactly `Copy matching line`.

## State

The query and find options are workspace/window-level state so the user can keep searching for the same term after switching Terminal ToolTabs.

The active match belongs to the current Terminal ToolTab. Switching Terminal ToolTabs while the find bar is open applies the same query/options to the new active terminal and resets navigation to that terminal's first match.

Closing the find bar clears find decorations for the active terminal. If later implementations keep decorations on inactive terminals, they must clear all decorated terminals when the bar closes.

Mirror display uses the shared terminal business state, but find overlay focus and scroll behavior are view-local.

## Native Feel Caveats

- Keep the find bar compact. Do not create a modal overlay.
- Do not add decorative motion. Opening and closing can be immediate.
- Use icon buttons for previous, next, copy, toggles, and close, with accessible labels and tooltips.
- Use platform menu commands for find, find next, find previous, use selection for find, and hide find bar.
- Keep focus behavior predictable: input while editing the query, terminal after navigation or closing.
- Avoid browser-specific affordances such as spellcheck underlines, link previews, or page-search wording.

## Implementation Notes

Each Terminal ToolTab owns an xterm `SearchAddon` and `SerializeAddon`. The find bar should use the active terminal's `SearchAddon` for highlighting and navigation.

The active-terminal-only scope should stay explicit in helper names and docs so future all-terminal search does not accidentally overload the current state.

Match counting and copying the matching logical line need access to plain terminal buffer text. Prefer xterm buffer APIs when possible instead of parsing serialized ANSI output.

If helper modules are introduced, keep them under `src/lib/terminal/` and cover line extraction, query validation, and match counting with focused tests.

## Tauri Verification Checklist

After implementation, run the real Tauri app and verify:

- native menu Find opens the find bar
- `Enter` and `Shift+Enter` navigate matches from the input
- previous and next buttons navigate and return focus to the terminal
- match-case toggle changes results
- regex toggle accepts valid regex and reports invalid regex
- copy matching line writes the active match's logical line to the system clipboard
- `Esc` closes the find bar, clears highlights, and returns focus to the terminal
- search includes scrollback, not only visible rows
- switching Terminal ToolTabs while find is open searches only the newly active terminal
- Dock split and floating terminal layouts keep find usable
- dark and light themes keep the find bar legible

Record any Tauri-specific caveats found during verification in this document before considering the feature complete.

## Tauri Verification Notes

- Multiple Nocturne worktrees can try to bind the default Vite port `1420`. Use `NOCTURNE_DEV_PORT` together with a matching temporary Tauri `build.devUrl` override when testing a second worktree.
- On macOS, multiple running dev instances with the same bundle identifier can make Accessibility, window focusing, and the application menu target the wrong Nocturne process. Use a temporary unique Tauri `identifier` when verifying menu/shortcut behavior while another Nocturne is already running.
- WKWebView may not deliver `Cmd+F` as a normal page `keydown` event because the native menu system handles command-key shortcuts first. The frontend still keeps a capture-phase fallback for platforms and cases where the key event reaches the WebView, but macOS verification must include the native menu command path.
- xterm search highlighting depends on the xterm decoration API, so terminals must be constructed with `allowProposedApi: true`. Without it, match counting and navigation can appear to work while highlights fail to render.
- Real macOS automation can be confused by multiple dev windows sharing the executable/process name `nocturne`, even when the Tauri product name and identifier are unique. Verify the window title in screenshots before trusting keyboard automation.
- IME composition can intercept scripted typing into the find input. Paste test query text from the clipboard or cancel composition with `Esc` before continuing scripted verification.
