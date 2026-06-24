# Dock Layout

This document defines Nocturne's IDE-style dock system as the shared layout engine for Files, Terminal, Transfers, Resource Monitor, and future tool tabs.

## Goals

The dock system should feel like a native desktop IDE layout:

- dock groups with inner tool tab bars
- split groups in rows and columns
- drag tool tabs between groups
- drag to edges to split
- drag to other workspaces to mirror
- drag out into floating windows
- keep runtime Workspace state authoritative without restoring old Workspaces on startup
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

Pure layout operations and hit testing must have focused Vitest unit-test coverage. Use Vitest for deterministic TypeScript/Svelte state, model operations, hit-testing math, validation, and persistence serialization that do not require a real Tauri runtime.

Use Rust unit tests for Rust-side Tauri command and service logic, including workspace snapshot validation, persistence decisions, and command intent handling that do not require a real WebView or native window.

Use Tauri unit tests for workflows that launch the real Tauri app and depend on the real desktop shell: WebView rendering, native pointer/keyboard dispatch, Tauri window lifecycle, floating windows, startup behavior across app sessions, or IPC behavior visible through the running app.

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
  | { kind: "group"; id: string; role: "content" | "side_panel"; slots: ToolSlot[]; activeSlotId: string; collapsed: boolean };

type ToolSlot =
  | { kind: "owned"; id: string; toolTabId: string }
  | { kind: "mirror"; id: string; toolTabId: string; ownerWorkspaceId: string }
  | { kind: "floating-placeholder"; id: string; toolTabId: string; floatingWindowId: string }
  | { kind: "closed-source"; id: string; previousTitle: string; ownerWorkspaceTitle: string };
```

Ratios are positive finite values normalized per split node. Persist ratios, not pixels. Every group and split child must have a minimum size.

`collapsed` is dock group display/layout state. It belongs to one rendered group
inside one Workspace or floating layout; it is not ToolTab business state and is
not shared with mirrors of the same ToolTab in other Workspaces. Collapsing an
owner group must not collapse a mirror group, and collapsing a mirror group must
not affect the owner group.

Every dock group has an explicit role. The role is spatial layout state, not a value inferred from the ToolTabs inside the group:

- `content`: primary editor/terminal/content area. A content group may be empty and show an empty content surface.
- `side_panel`: auxiliary dock area on the left, right, or bottom edge. Files, Resources, Transfers, Ports, and future auxiliary tools may live here.

Do not infer group role from a terminal, files, transfers, mirror, closed-source slot, or current window edge. The explicit group role is authoritative. `content` groups always render a top ToolTab bar even when a split places them against the left, right, or bottom workspace edge. `side_panel` groups choose their ToolTab bar placement from the edge they touch; bottom placement wins over left/right when a side-panel group touches multiple edges. Rust must create and return layouts with explicit roles, and frontend/tests should fail on role-less layouts instead of migrating them. Rust accepts old `sidebar` and `panel` snapshot values as `side_panel` for migration only.

## Split Resizing

Every visible split boundary between dock groups is a pointer resize handle. Row splits use horizontal resize behavior and column splits use vertical resize behavior. Dragging a handle updates the split node's ratios, not pixel sizes, and terminal content refits after the Dock layout changes.

## Drag And Drop

Dock drag uses pointer capture and geometry hit testing. Do not use HTML5 drag-and-drop for dock operations.

Supported drop targets:

- group tab bar: add to that group
- group center: add to or activate within that group
- group left/right/top/bottom: split around the target group. By default the inserted group inherits the target group's role. When an auxiliary ToolTab such as Files, Resources, Transfers, or Ports is dropped on the left, right, or bottom edge of a `content` group, the inserted group becomes a local `side_panel` adjacent to that target group. This restores the native auxiliary-tool placement without docking to the whole Workspace edge. Dropping above a content group stays `content`.
- workspace edge left/right/top/bottom: create an edge dock area with `side_panel` role when the resulting ToolTab bar is left, right, or bottom; top-edge groups become `content`
- another workspace: create a mirror slot
- floating window: add to that floating window's dock layout
- outside any window: create a floating window

Dragging a mirror moves the mirror display slot only. Dragging an owned tool tab to a floating window or outside a window creates a floating mirror and leaves the source slot in place.

Dragging an owned tool tab to another workspace is not a move. It creates a mirror slot. Tool tabs cannot change owner workspace.

Hit testing must keep both workspace-edge drops and group-edge splits reachable. When a dock group already touches the window edge, the outermost narrow band is reserved for workspace-edge docking, but the group's own left/right/top/bottom split zones inside that band must remain reachable. Do not let a broad workspace-edge hit test run before group hit testing, because it makes the corresponding group-edge split direction impossible to trigger after a role-preserving drag.

Dragging an auxiliary ToolTab onto a content group's left, right, or bottom
group-edge split zone must create a local side-panel beside that content group.
For example, dragging Files into the Terminal group and then dropping Files on
Terminal's left edge restores Files as a local left side-panel in the same upper
split, not as a full-height global Workspace-left dock and not as a `content`
group with a top ToolTab bar.

## Floating Windows

A floating window owns a dock layout of display slots, not tool tab ownership. Floating windows contain mirror ToolTabs only. All floating-window dock groups use `content` role.

When a floating window closes:

- mirrors are removed
- closed-source placeholders are removed with the window

Floating mirror slots are not persisted across app restart.

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
- sits at the top for content groups; for side-panel groups, it sits on the bottom edge for bottom groups and on the left or right edge for side groups
- uses vertical title text when placed on the left or right edge
- clicking the active ToolTab in a left, right, or bottom group toggles that
  group's collapsed display state
- collapsed groups keep only their ToolTab bar visible and do not show a
  placeholder surface
- collapsed side and bottom groups do not expose the adjacent split resize
  handle, because the collapsed rail has a fixed size and is not resizable
- collapsed side and bottom groups remain valid group drop targets. Dragging a
  ToolTab onto the collapsed rail previews the rail as the target group, drops
  the ToolTab into that group, activates it, and expands the group.
- clicking a different ToolTab in a collapsed group activates that ToolTab and
  expands the group
- top ToolTab bars are not collapsible; content groups must always show their
  content surface

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

The first implementation exposes close, close others, close to the right, mirror, float, restore, pointer move-to-group, pointer split, drag-to-workspace mirror, and drag-out floating actions. Floating windows display mirror ToolTabs only, so drag-out floating actions leave the source ToolTab visible in its owner Workspace and closing the floating window removes only the floating mirror display.

Follow-up work should complete floating-window-internal multi-ToolTab drag composition, full keyboard-only group focus/move commands, and richer native context menus for split left/right/up/down.

## Tests

Vitest unit tests should cover:

- split insertion
- ratio normalization
- minimum-size clamping
- moving slots between groups
- creating mirrors
- preventing duplicate mirrors in one target workspace
- floating mirror creation
- floating window mirror cleanup
- closed-source placeholder creation
- close others and close to the right
- invalid layout rejection

Single-module Vitest unit tests may live beside the module as `*.test.ts`. Dock tests that cover multiple modules, source contracts, generated artifacts, or cross-feature behavior must live under `/tests`.

Tauri unit tests should cover real-app workflows such as:

- drag to split targets
- drag to another workspace creates a mirror
- drag out creates a floating window
- floating close removes mirror slots without affecting source slots
- mirror visual badge and border
- keyboard split and focus commands
- persistence and restore
- dark and light themes
- narrow desktop sizes
