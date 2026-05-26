# Terminal Split Panes

This document defines Nocturne's terminal split-pane model, interaction rules, and implementation notes.

## Goals

Split panes let one terminal tab contain multiple terminal sessions in an i3-like tree layout. The tab remains the unit shown in the tab bar. Panes are the terminals inside that tab.

The implementation should prioritize a stable tree model, predictable focus, native-feeling menus, resize behavior, drag-and-drop rules that do not conflict with terminal mouse input, and strong tests.

## Terminology

- Tab: the tab bar item. A tab owns one pane tree.
- Pane: one terminal session inside a tab.
- Split node: an internal tree node with a direction and child ratios.
- Leaf node: a pane/session leaf.
- Active pane: the pane that receives keyboard input and supplies the tab title.

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

## Persistence

Nocturne does not need to restore split layouts after app restart at this stage.

Closing a tab discards its pane tree and terminates its pane sessions according to the normal close-confirmation rules.

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
