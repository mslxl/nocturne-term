# Terminal Split Panes

This document defines Nocturne's terminal split-pane model, interaction rules, and implementation notes.

## Goals

Split panes let one terminal tab contain multiple terminal sessions in an i3-like tree layout. The tab remains the unit shown in the tab bar. Panes are the terminals inside that tab.

The implementation should prioritize a stable tree model, predictable focus, native-feeling menus, resize behavior, drag-and-drop rules that do not conflict with terminal mouse input, and strong tests.

The feature is not just a visual split of one terminal element. It changes the terminal model from one tab owning one terminal session to one tab owning a pane tree, where each leaf owns its own terminal session and xterm instance.

## Terminology

- Tab: the tab bar item. A tab owns one pane tree.
- Pane: one terminal session inside a tab.
- Split node: an internal tree node with a direction and child ratios.
- Leaf node: a pane/session leaf.
- Active pane: the pane that receives keyboard input and supplies the tab title.

Keep these concepts separate in code:

- Tab state: `id`, title, active pane id, pane list, and tree.
- Pane state: PTY session id, xterm instance, mount container, cwd/title/status, output queue, and resize bookkeeping.
- Tree state: layout only. It stores pane ids and split ratios, not terminal instances.
- Native session state: the backend PTY process and its session id.

Most split-pane bugs come from accidentally treating one of these as another. A tree reorder must not recreate terminal sessions. A pane move must update the owning tab and pane `tabId`. A tab title refresh must read the active pane, not the first pane.

The tree shape is:

```ts
type PaneTree = SplitNode | PaneLeaf;
type SplitNode = {
  kind: "split";
  direction: "row" | "column";
  children: PaneTree[];
  ratios: number[];
};
type PaneLeaf = {
  kind: "leaf";
  paneId: string;
};
```

`row` lays children left-to-right. `column` lays children top-to-bottom.

## Split Commands

Use direction commands instead of ambiguous horizontal/vertical wording:

- `Split Right`
- `Split Down`
- `Split Left`
- `Split Up`

The native context menu exposes all four directions.

Splitting a pane creates a new shell session. The new session should inherit the source pane's current working directory when known. The first implementation can inherit configured environment plus application process environment; inheriting shell-local dynamic environment variables requires shell integration and is not part of the current contract.

After split creation, focus moves to the new pane.

The backend command accepts a runtime cwd override for this reason. The configured terminal cwd remains the default, but split creation can pass the source pane cwd without mutating global settings.

## Titles

Tab bar titles should prefer the active pane title:

```text
server | 3 panes
```

Rules:

- Single-pane tabs use the existing pane title with no suffix.
- Multi-pane tabs use `<active pane title> | <n> panes`.
- Pane title bars show each pane's own terminal title/cwd/program-derived title.

## Pane Title Bars

Pane title bars are visible only when a tab has more than one pane. Single-pane tabs must not spend space on pane chrome.

Title bars should be compact, around 22-26px tall. They should contain:

- a drag handle area
- the pane title
- a close button
- a more/menu button when more pane actions exist

The terminal content area must not start pane drag operations. Many terminal applications use mouse input, so split interactions must stay on title bars and splitters.

## Closing

Closing the final pane closes the tab.

Closing a pane whose terminal is still running requires confirmation. Use a native OS confirmation dialog when possible. Exited or errored panes may close immediately.

When removing a pane leaves a split node with only one child, collapse that node automatically. Ratios should be normalized after removal.

## Resizing

Split sizes are stored as ratios, not pixels. Window resizing recomputes pixel sizes from ratios.

Splitter drag updates ratios for the two adjacent children. Every pane has a minimum size so dragging cannot collapse a pane to zero width or height.

Recommended initial minimums:

- width: 160px
- height: 96px

Resize handlers must schedule xterm fits for the affected panes after the Svelte layout has updated. Do not send backend resize commands from raw DOM measurements until dimensions have been normalized. During mount, split, tab switch, or hidden-pane transitions, xterm can briefly report missing, zero, or non-finite dimensions.

## Context Menus

Pane split actions should be opened from a native context menu on the terminal/pane surface.

Native menu items:

- `Split Right`
- `Split Down`
- `Split Left`
- `Split Up`
- later: `Move Pane to New Tab`, `Close Pane`

Do not use a WebView-drawn context menu for this interaction. The terminal is a desktop surface and should preserve native menu behavior.

## Keyboard Commands

Split panes should be backed by command IDs so keyboard shortcuts and settings can use the same actions:

- `terminal.newTab`
- `terminal.closeTab`
- `terminal.splitLeft`
- `terminal.splitRight`
- `terminal.splitUp`
- `terminal.splitDown`
- `terminal.closePane`
- `terminal.focusPaneLeft`
- `terminal.focusPaneRight`
- `terminal.focusPaneUp`
- `terminal.focusPaneDown`
- `terminal.resizePaneLeft`
- `terminal.resizePaneRight`
- `terminal.resizePaneUp`
- `terminal.resizePaneDown`
- `terminal.movePaneToNewTab`

Shortcuts are backed by a keybinding registry and exposed on the settings page under `Keybindings`.

Default shortcuts:

- macOS: `Meta+T`, `Meta+W`, `Meta+Alt+D`, `Meta+D`, `Meta+Alt+Shift+D`, `Meta+Shift+D`, `Meta+Shift+W`
- Windows/Linux: `Ctrl+Shift+T`, `Ctrl+Shift+W`, `Ctrl+Alt+Left`, `Ctrl+Shift+D`, `Ctrl+Alt+Up`, `Ctrl+Alt+D`, `Ctrl+Alt+W`

Config path:

```toml
[keybindings.terminal]
newTab = "Meta+T"
closeTab = "Meta+W"
splitLeft = "Meta+Alt+D"
splitRight = "Meta+D"
splitUp = "Meta+Alt+Shift+D"
splitDown = "Meta+Shift+D"
closePane = "Meta+Shift+W"
```

## Drag-And-Drop Contract

Drag-and-drop behavior:

- Drag from tab bar: `TabDrag`.
- Drag from pane title bar: `PaneDrag`.
- Drag from splitter: `ResizeDrag`.
- Terminal content never starts split drag.

Drop target regions:

- edge regions (`left`, `right`, `top`, `bottom`) move the dragged object into a split at that side
- center region swaps panes without creating a new split
- dragging a pane title to the tab bar detaches it into a standalone tab

These drag modes must be mutually exclusive so tab dragging, pane dragging, splitter resizing, and terminal mouse input do not conflict.

Terminal content does not start split drag. Drop zones are pointer-inactive unless a pane or tab drag is active, so terminal mouse applications keep receiving normal input.

Pane dragging is pointer-driven. Do not reintroduce HTML5 drag-and-drop for pane movement. In Tauri/WKWebView, HTML5 DnD, WebKit native drag gestures, xterm mouse handling, and Svelte event propagation interact poorly. Symptoms include intermittent drop-target highlighting, panes remaining in a dragging state after mouseup, terminal mouse input being stolen, or a second click being required to finish a drop.

Important pointer rules:

- Start pane drag only from the pane title bar drag handle.
- Capture the pointer as soon as a pane or tab drag starts.
- Listen for `pointermove`, `pointerup`, and `pointercancel` in the capture phase so nested terminal DOM cannot swallow the event.
- Calculate drop targets from pointer coordinates and visible pane rectangles, not from HTML5 DnD events.
- Avoid relying on `elementsFromPoint` for complex nested split layouts; overlays, splitters, xterm internals, and title bars can change the DOM hit-test result.
- Clear drag state on pointer cancel, window blur, and document hide.
- Keep WebKit native drag disabled on pane title controls. A visual drag handle is fine; `-webkit-user-drag: element` is not.

Drop target geometry should prefer the smallest visible pane rectangle containing the pointer. This keeps nested row/column layouts stable when panes overlap in the DOM tree or when title bars and splitters sit above the terminal surface.

Dragging to the tab bar to detach a pane is part of the product contract, but it should still be implemented through the same pointer model. Do not add a second drag system just for this case.

## Terminal Lifecycle

Pane layout changes must preserve terminal sessions and xterm instances.

When splitting:

- create one backend terminal session
- create one frontend pane object for that session
- insert a leaf into the pane tree
- set the new pane active
- mount and fit all panes in the active tab after Svelte has rendered

When moving or swapping panes:

- do not create or close backend sessions
- update `tab.panes`, `tab.tree`, `tab.activePaneId`, and moved pane `tabId`
- remount existing xterm instances into their current containers
- refit panes after the DOM has settled

When closing:

- confirm if any affected pane is still running
- dispose xterm resources before removing the pane object
- close the backend PTY session for running panes
- collapse split nodes that are left with a single child
- close the tab if no pane remains

Hidden inactive tabs keep their pane state but should not receive pointer events. When switching tabs, mount and fit that tab's panes after the tab becomes visible. This avoids stale wrapping and blank panes.

## Size Normalization

Terminal sizes cross the Tauri command boundary and eventually reach backend PTY resize calls. They must always be finite integers within backend limits.

Practical rules:

- Normalize measured fit sizes before creating sessions or resizing sessions.
- Never pass `null`, `undefined`, `NaN`, or infinite values to `create_terminal_session` or `resize_terminal`.
- Clamp columns, rows, pixel width, and pixel height before serialization.
- Treat missing layout measurements as a temporary UI state, not as a valid backend size.

This prevents errors such as:

```text
invalid args input for command resize_terminal: invalid type: null, expected u16
```

The frontend size helpers are the boundary. Avoid duplicating ad hoc normalization at call sites.

## Settings And Menus

Terminal commands are shared by keyboard handling and settings. When adding a terminal action, update the command registry first, then wire UI and native menus to that command.

Native menu behavior:

- Tab bar context menus belong to tab-bar actions and settings such as tab placement.
- Pane context menus belong to pane actions such as split direction.
- Native menu item selection emits a typed event back to the main window.
- `src/lib/bindings.ts` is generated from Rust Specta exports. Do not edit it manually.

Settings behavior:

- Keybindings live under `keybindings.terminal`.
- Defaults are platform-aware.
- Existing shortcuts should be represented in the settings page instead of living as hard-coded keyboard checks in the terminal page.

## Persistence

Nocturne does not need to restore split layouts after app restart at this stage.

Closing a tab discards its pane tree and terminates its pane sessions according to the normal close-confirmation rules.

## Implementation Risks

This area is high-risk because it sits at the boundary between layout, process lifecycle, xterm rendering, native menus, and pointer input.

Common regressions:

- A pane frame appears but has no xterm content because the existing terminal was not remounted.
- A pane cannot receive input because focus still points to a removed or inactive pane.
- Resize sends invalid dimensions to Rust because a hidden or not-yet-mounted container was measured.
- A tab close or pane close button does nothing because pointer drag handlers stole the click.
- Drop target highlighting flickers in mixed row/column layouts because hit-testing depends on overlay DOM order.
- Drag state remains active after mouseup because the event was swallowed by nested content.
- A new split steals terminal mouse input because dragging can start from terminal content instead of chrome.
- Tab titles become stale because active pane changes do not refresh the tab title.

If a bug involves one of these symptoms, check event capture, pointer capture, pane mount state, and size normalization before changing tree algorithms.

## Testing Notes

The tree manipulation layer should have focused tests for:

- creating a root leaf
- splitting right/down/left/up
- preserving and normalizing ratios
- collapse after pane removal
- active pane title derivation
- finding panes and counting leaves
- ratio updates with minimum sizes

UI-level testing should verify:

- single-pane tabs hide pane title bars
- multi-pane tabs show title bars
- splitters resize without producing zero-size panes
- closing running panes asks for confirmation
- xterm fit/resize events still reach the correct backend session
- tab close and pane close buttons are not intercepted by drag handling
- multiple splits leave every pane mounted with xterm content
- typing goes to the active pane after split, move, close, and tab switch
- drag targets are stable in mixed horizontal and vertical layouts
- pointerup clears drag state and completes the drop without a second click
- new tabs and split panes do not show spurious white bars or unnecessary scrollbars

Before merging changes in this area, run:

```sh
pnpm check
pnpm test
```

For UI behavior changes, also run Playwright coverage against a dev server. At minimum cover:

- split right/down/left/up
- repeated split in the same direction
- mixed row/column split layout
- splitter resize
- pane drag to another pane edge
- pane drag to center swap
- pane close and tab close
- new tab activation

Real Tauri validation is still important because WKWebView and native menus can differ from browser behavior. When automated system drag injection is unreliable, verify at least that the Tauri window can create mixed split layouts through real commands and manually test pane dragging before release.

## Maintenance Checklist

When changing split panes, ask these questions:

- Am I changing tree layout, terminal session lifecycle, or pointer interaction?
- Does the change preserve pane ids and backend session ids?
- Does every path update `tab.panes`, `tab.tree`, `tab.activePaneId`, and pane `tabId` consistently?
- Does the active pane still own keyboard focus after the operation?
- Are all backend size inputs normalized?
- Can xterm still use normal mouse input inside terminal content?
- Does the change avoid HTML5 DnD for pane movement?
- Are native menus and keybindings still backed by shared command ids?
- Do existing pane title bars remain hidden for single-pane tabs?
- Did tests cover the exact behavior being changed?
