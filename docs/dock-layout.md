# Dock Layout

This document defines Nocturne's IDE-style dock system as the shared layout engine for Files, Terminal, Transfers, and future tool tabs.

## Goals

The dock system should feel like a native desktop IDE layout:

- dock groups with inner tool tab bars
- split groups in rows and columns
- drag tool tabs between groups
- drag to edges to split
- drag to other workspaces to mirror
- drag out into floating windows
- restore the last window state automatically
- keep the model testable outside the UI

The dock system is a standalone feature module, not a terminal feature.

## Module Boundary

The implementation should live under a dedicated workspace/dock module. The exact file paths may change, but the boundary should stay clear:

```text
src/lib/workspace/dock/
  model.ts
  operations.ts
  hit-testing.ts
  persistence.ts
  components/
```

Pure layout operations and hit testing must have focused Vitest coverage. Use Vitest for deterministic TypeScript/Svelte state, model operations, hit-testing math, validation, and persistence serialization that do not require a real Tauri runtime.

Use Tauri end-to-end tests for behavior that depends on the real desktop shell: WebView rendering, native pointer/keyboard dispatch, Tauri window lifecycle, floating windows, persisted restore across app windows, or IPC with Rust-owned state.

## Authority And State

Rust/Tauri state is the authority for workspace, tool tab, floating-window, and backend-session lifecycle. This avoids multiple WebViews racing to write layout state.

Frontend TypeScript owns:

- pure model helpers
- rendering components
- pointer hit testing
- view-local state

Frontend operations submit layout intents to Rust/Tauri state. Rust validates, updates authoritative state, persists when needed, and broadcasts snapshots to all windows.

TanStack Query may cache file/provider data inside a WebView, but it must not become the cross-window authority for dock layout or tool lifecycle.

## Layout Model

The dock layout is a tree:

```ts
type DockLayout =
  | { kind: "split"; direction: "row" | "column"; children: DockLayout[]; ratios: number[] }
  | { kind: "group"; id: string; slots: ToolSlot[]; activeSlotId: string };

type ToolSlot =
  | { kind: "owned"; id: string; toolTabId: string }
  | { kind: "mirror"; id: string; toolTabId: string; ownerWorkspaceId: string }
  | { kind: "floating-placeholder"; id: string; toolTabId: string; floatingWindowId: string }
  | { kind: "closed-source"; id: string; previousTitle: string; ownerWorkspaceTitle: string };
```

Ratios are positive finite values normalized per split node. Persist ratios, not pixels. Every group and split child must have a minimum size.

## Drag And Drop

Dock drag uses pointer capture and geometry hit testing. Do not use HTML5 drag-and-drop for dock operations.

Supported drop targets:

- group tab bar: add to that group
- group center: add to or activate within that group
- group left/right/top/bottom: split around the target group
- workspace edge left/right/top/bottom: create an edge dock area
- another workspace: create a mirror slot
- floating window: add to that floating window's dock layout
- outside any window: create a floating window

Dragging a mirror moves the mirror display slot only. Dragging an owned tool tab to a floating window or outside a window turns the source slot into a floating placeholder.

Dragging an owned tool tab to another workspace is not a move. It creates a mirror slot. Tool tabs cannot change owner workspace.

## Floating Windows

A floating window owns a dock layout of display slots, not tool tab ownership. A floating window may contain multiple owned floating displays and mirrors.

When a floating window closes:

- owned floating displays restore to their original workspace slots
- mirrors are removed
- closed-source placeholders are removed with the window

Floating windows containing owned tool tabs are persisted. Floating windows containing only mirrors are not restored.

## Tool Tab Bars

The outer workspace tab bar and inner tool tab bars must have distinct visual hierarchy.

Workspace tab bar:

- sits at the top level
- shows host/workspace identity
- has stronger active styling
- contains a New Workspace entry point

Tool tab bar:

- sits inside each dock group
- is compact
- shows tool kind icons and titles
- shows mirror badges and mirror border styling
- does not use subtitles

Do not use `cursor: pointer` on rows or tabs. Use native-feeling hover and pressed states appropriate to the control kind.

## Commands And Keyboard

Dock commands must be registered as command IDs so menus, keybindings, and the command palette share one action path.

First-release command coverage:

- switch previous/next workspace
- switch previous/next tool tab in group
- close current tool tab
- close other tool tabs in the group
- close tool tabs to the right in the group
- close current workspace
- close other workspaces
- close workspaces to the right
- split current tool tab left/right/up/down
- move tool tab to previous/next group
- focus group left/right/up/down
- float current tool tab
- restore floating tool tab
- open command palette

Keyboard shortcuts must be editable in settings.

Full keyboard-only docking can come later. The first release must still support core switching, closing, and splitting from keyboard and command palette.

## Context Menus

Workspace tab context menu:

- close
- close others
- close to the right
- rename workspace
- new workspace

Tool tab context menu:

- close
- close others
- close to the right
- float
- restore when floating
- reveal source workspace for mirrors

Menu actions must follow the same lifecycle rules as direct UI actions.

The first implementation exposes close, close others, close to the right, mirror, float, restore, pointer move-to-group, pointer split, drag-to-workspace mirror, and drag-out floating actions. Floating windows can display owned Files/Transfers ToolTabs and restore them to the source placeholder.

Follow-up work should complete floating-window-internal multi-ToolTab drag composition, full keyboard-only group focus/move commands, and richer native context menus for split left/right/up/down.

## Tests

Vitest tests should cover:

- split insertion
- ratio normalization
- minimum-size clamping
- moving slots between groups
- creating mirrors
- preventing duplicate mirrors in one target workspace
- floating placeholder creation
- floating window restore
- closed-source placeholder creation
- close others and close to the right
- invalid layout rejection

Tauri end-to-end tests should cover:

- drag to split targets
- drag to another workspace creates a mirror
- drag out creates a floating window
- floating close restores source slots
- mirror visual badge and border
- keyboard split and focus commands
- persistence and restore
- dark and light themes
- narrow desktop sizes
