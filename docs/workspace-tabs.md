# Workspace Tabs

This document defines Nocturne's host workspace model, nested tool tabs, mirror slots, floating windows, and restore behavior.

## Goals

Nocturne's top-level tab is a host workspace, not a terminal session. A workspace binds to exactly one connection host and contains the tools used to work with that host: files, terminals, transfers, and resource monitoring.

The first implementation targets desktop. Android and iOS remain product targets, but the full IDE-style dock system, floating windows, and file drag-and-drop are desktop-first.

## Model

Top-level tabs are `WorkspaceTab` objects:

```ts
type WorkspaceTab = {
  id: string;
  hostId: string;
  title: string;
  ownedToolTabIds: string[];
  layout: DockLayout;
};
```

Rules:

- A workspace must bind to one and only one host.
- Local hosts are valid workspace hosts.
- The workspace title defaults to the host display name and can be renamed without changing the host.
- Creating a workspace must never create a duplicate visible workspace title. If the default host display name is already used, the new workspace is created with the next numeric suffix, such as `Local Shell 2`.
- A new workspace is created from the unified host picker. The default layout contains one Files tool tab, one Terminal tool tab, one Resource Monitor tool tab, and one Transfers tool tab.
- SSH workspaces use an SFTP-backed Files provider. Local workspaces use a local filesystem provider.

Tool tabs are the tabs inside a workspace dock layout:

```ts
type ToolTab =
  | { kind: "files"; ownerWorkspaceId: string; hostId: string }
  | { kind: "terminal"; ownerWorkspaceId: string; hostId: string }
  | { kind: "terminal_sessions"; ownerWorkspaceId: string; hostId: string }
  | { kind: "transfers"; ownerWorkspaceId: string; hostId: string }
  | { kind: "resources"; ownerWorkspaceId: string; hostId: string };
```

The first release includes `files`, `terminal`, `terminal_sessions`, `transfers`, `resources`, and `ports`.

## Tool Tab Ownership

Tool tabs belong to the workspace that created them. A tool tab cannot be moved to another workspace because the tool's host identity is inherited from its owner workspace.

Moving a tool tab between dock groups in the same workspace changes layout only. Dragging a tool tab to another workspace creates a mirror slot, not a move.

## Mirror Slots

A workspace may display a tool tab owned by another workspace through a mirror slot.

Mirror rules:

- The original tool tab has one owner workspace.
- A mirror does not copy or migrate the tool tab.
- A mirror operates against the original tool tab's host and backend sessions.
- Business state is shared between the owner and mirrors.
- View-local state is not shared.
- The same destination workspace may contain only one live mirror of a given tool tab. Re-dragging the same tool tab focuses the existing mirror.
- Mirror slots are not persisted across app restarts.

Shared business state includes Files current path, selection, sorting, provider state, search task, transfer actions, and Terminal backend session state.

View-local state includes scroll position, focused control, hover state, Tree view expansion, Columns view column widths, preview panel width, find UI, selection UI, local panel sizing inside a rendered control, and the collapsed display state of the dock group that contains the rendered slot. Collapsing a group in one workspace must not collapse a mirror of the same ToolTab in another workspace, and collapsing a mirror group must not affect the owner workspace.

Terminal mirrors have additional rules because one backend PTY can be displayed by multiple xterm views. The target Terminal mirror design is defined in [Terminal ToolTabs](terminal-split-panes.md#terminal-mirror-target-design). If the current implementation has not yet shipped every Terminal mirror rule, treat that section as the acceptance criteria for future work. A Terminal ToolTab maps to a single terminal session; terminal views are the only multiplicity layer.

Resource Monitor mirrors share sampling business state and history buffers, but each mirror keeps its own display preferences. The target Resource Monitor design is defined in [Resource Monitor ToolTab](resource-monitor.md).

Mirror UI must show a source badge such as `from Production` and use a distinct border style so the user can tell it does not belong to the current workspace host. When the mirror's owner host differs from the current workspace host, the badge or tooltip must expose the owner Workspace and Host identity clearly enough to prevent accidental commands against the wrong host.

If the owner tool tab or owner workspace closes, live mirrors remain as closed-source placeholders. The placeholder explains that the source workspace or tool tab was closed. The user closes that placeholder manually.

## Floating Windows

Tool tabs can be dragged into floating Tauri windows.

Floating rules:

- A floating window can contain a full dock layout with multiple tool tabs.
- Floating windows contain mirror ToolTabs only.
- Dragging an owned tool tab to a floating window keeps the owned ToolTab visible in its original Workspace.
- Floating mirrors follow the same business-state and view-local-state rules as Workspace mirror slots.
- Closing a floating window closes only the floating mirror display slots.
- Closing a floating mirror never closes the owner ToolTab, backend terminal session, Files session, or transfer state.
- Floating mirror slots are not persisted across app restart.

The floating window is a display location, not a new owner. Nocturne does not support "Move to New Workspace" for tool tabs.

## Closing

Closing semantics:

- Closing an owned live terminal ToolTab sends `close_view` for Terminal Agent sessions. The daemon removes the current client/view, pings any remaining attached clients, and closes the PTY/run only when no other reachable attached view remains. Direct local, SSH, and non-Agent terminal sessions close their backend session directly. Mirrors become closed-source placeholders. The `Close` and `Detach` actions belong to the dock group tab-button right-click menu, not the terminal content menu.
- Closing a mirror slot only removes that mirror display.
- Closing a floating window removes its mirror display slots.
- Closing a workspace closes all owned tool tabs after confirmation. Terminal ToolTabs still follow the same ToolTab close semantics.
- Closing a Nocturne window or exiting Nocturne detaches owned Terminal Agent views by default so their runs survive; it does not imply ToolTab Close. The optional application-close auto-detach setting only applies to Terminal Agent sessions and has host override support.
- Closing a workspace also turns mirrors of its owned tool tabs in other workspaces into closed-source placeholders.
- Workspace itself is never mirrored.

Workspace close confirmation must include running terminals, active Files sessions, visible floating mirrors of owned tool tabs, and related transfer tasks. If the user confirms closing a workspace with related running, queued, or paused transfers, those application-level transfer tasks are canceled before the workspace closes.

Top-level workspace tabs and inner tool tab bars support `Close Others` and `Close to the Right`. These commands must use the same close rules and confirmation paths as direct close actions.

## Restore

Nocturne does not restore previously persisted Workspace tabs on application startup.
Each new app process starts from the default Workspace template for the default host.
Floating windows are mirror-only display locations. Closing a floating window
removes only that floating mirror display; there is no separate floating-window
restore action because the owner ToolTab never leaves its Workspace.

Nocturne may still write a lightweight full Workspace snapshot during runtime so
commands, diagnostics, and the current process have a single authoritative state
file. Startup treats that file as disposable runtime state and overwrites it with
the default Workspace snapshot instead of restoring it.

Runtime snapshot state includes:

- workspace order
- active workspace
- workspace title
- workspace host id
- owned tool tabs
- dock layout
- split ratios
- dock group collapsed display state
- active dock groups and active tool tabs
- floating windows containing mirror display slots for the current process

Runtime snapshot state excludes:

- mirror slots
- floating mirror slots
- scroll position
- hover and focus
- file Tree expansion
- temporary drag state
- local preview panel sizing
- transient search scroll state

Reconnect strategy is configurable for views that are created or made visible in
the current process:

- visible auto reconnect, the default
- manual reconnect
- safe auto restore

With visible auto reconnect, terminal, Files, and transfer views reconnect or
open when their display location becomes visible. Floating windows follow the
same strategy when their mirror display is visible.

Terminal reconnect starts a new terminal session. It does not resurrect a
previous process.

## Titles

Workspace titles:

- default to the host display name
- are made unique on creation by appending the next numeric suffix when needed
- can be renamed by the user
- do not mutate host configuration

Files tool tab titles:

- show only the path, because the workspace already identifies the host
- do not show username or host
- do not show the view mode
- cannot be manually renamed

Terminal tool tab titles:

- may have a user alias
- must still show the running program or current directory after the alias
- should avoid repeating host identity unless displayed as a mirror in another workspace

Transfers tool tab titles should be concise, normally `Transfers`.

Terminal Sessions is the internal ToolTab concept for the host-level registry
view. Its normal user-facing display title is `Terminals`. When the tab is
shown in a narrow vertical rail, the compact display title may shrink to
`Terms` to avoid forcing a native scrollbar before the list itself needs to
scroll. It lists every registry-backed terminal session for the Workspace Host.
Running or detached rows attach into a normal Terminal ToolTab; exited rows open
a read-only Terminal ToolTab that shows the saved transcript history and does
not start a new command. The list supports an explicit selection mode with
Select All, invert selection, and selected-session deletion through one native
confirmation. It does not show restore-only PTY dimensions in each row, and
truncated row text must expose full details through tooltips.

Resource Monitor tool tab titles should be concise, normally `Resources`.

## Default Workspace Template

The default workspace template contains:

- Files tool tab, docked on the left
- Terminal tool tab, docked in the main content area
- Terminal Sessions tool tab, displayed as `Terminals`, docked in a right-side dock group and active by default
- Resource Monitor tool tab, docked in the same right-side dock group
- Transfers tool tab, docked in the same right-side dock group

Files, Terminal, Resources, and Transfers are ordinary dock group ToolTabs. The template chooses their initial placement; the model does not make the left or right areas special.

Runtime layout memory should respect user changes for non-Terminal ToolTabs generally, not only for one specific feature. If the user closes, moves, or reorders Files, Resources, Transfers, or future non-Terminal tools, the current process's runtime snapshot preserves that choice. Startup still creates a fresh default Workspace instead of restoring old Workspaces.
