# Terminal ToolTabs And Dock Splits

This document defines Nocturne's terminal model after the Host Workspace and Dock architecture.

## Goals

Terminal sessions are ToolTabs inside a Host Workspace. The shared Dock system owns layout splitting, floating windows, mirrors, tab groups, and restore. Terminal code owns terminal process/session lifecycle, xterm rendering, terminal input/output, and terminal-specific commands.

The target model is:

- one Terminal ToolTab owns one terminal session
- top-level tabs are Host Workspaces
- inner dock groups contain ToolTabs
- split commands create Dock splits with additional Terminal ToolTabs
- terminal sessions do not own layout trees

See [Workspace Tabs](workspace-tabs.md) and [Dock Layout](dock-layout.md).

## Terminology

- Workspace: a top-level host-bound tab.
- ToolTab: a dockable tool inside a Workspace.
- Terminal ToolTab: a ToolTab that owns one terminal session.
- Dock group: a group of ToolTabs in the shared Dock layout.
- Dock split: a row or column split in the shared Dock layout.
- Active terminal: the Terminal ToolTab that receives keyboard input.
- Transport session: the backend local PTY process, SSH channel, or future protocol connection.

Keep these concepts separate:

- Workspace state: host id, title, owned tool tabs, dock layout.
- Dock state: group/split layout, slot placement, floating displays, active slot ids.
- Terminal tool state: terminal session id, title/alias, cwd/status, output queue, resize bookkeeping.
- Terminal view state: one mounted xterm renderer, DOM focus, scrollback viewport, selection, find UI, context menu, hover, and temporary renderer details for a specific display location.
- Transport state: backend local PTY, SSH channel, or future terminal transport.

## Split Commands

Terminal split commands are Dock operations.

Commands:

- `Split Right`
- `Split Down`
- `Split Left`
- `Split Up`

Running a split command while a Terminal ToolTab is active should:

1. create a new terminal transport session for the workspace host
2. create a new Terminal ToolTab for that session
3. insert the new ToolTab into the Dock layout at the requested side
4. focus the new Terminal ToolTab

Generic split commands use the workspace host. Choosing a different host is a Workspace creation action, not a Terminal ToolTab action, because ToolTabs cannot move across host ownership.

Local terminal ToolTabs may inherit the active terminal's current working directory when known. The configured terminal cwd remains the default for new sessions, and a split can pass the source cwd as a runtime override without mutating settings.

## Titles

Terminal ToolTabs may have a user alias, but the title must still show live context.

Examples:

```text
zsh ~/Projects/nocturne
Build · zsh ~/Projects/nocturne
Deploy · bash /var/www
```

The alias is a prefix or primary label. It must not fully replace the running program or current directory.

Workspace title owns host identity. Terminal ToolTabs should avoid repeating host/user identity unless shown as a mirror in another workspace.

## Closing

Closing a Terminal ToolTab whose session is still running asks for confirmation by default:

```toml
[terminal]
confirm_close = true
```

When set to `false`, running Terminal ToolTabs close immediately. Exited or errored Terminal ToolTabs may close without confirmation.

The confirmation should use the platform dialog path so focus and keyboard handling remain native.

Closing a Workspace must aggregate running Terminal ToolTabs in its risk summary. If the user confirms closing the Workspace, all owned Terminal ToolTabs close according to the Workspace close operation.

Mirrors of a closed Terminal ToolTab become closed-source placeholders. Closing a mirror does not close the owner terminal session.

## Resizing

Dock split sizes are stored as ratios. Terminal rendering measures the actual container size after the Dock layout renders.

Practical rules:

- measure terminal containers after Svelte has updated the Dock group
- normalize measured fit sizes before sending backend resize commands
- never pass `null`, `undefined`, `NaN`, or infinite values to `create_host_terminal_session` or `resize_terminal`
- clamp columns, rows, pixel width, and pixel height before serialization
- treat missing layout measurements as temporary UI state

This prevents errors such as:

```text
invalid args input for command resize_terminal: invalid type: null, expected u16
```

The frontend size helpers are the boundary. Avoid duplicating ad hoc normalization at call sites.

## Context Menus

Terminal context menus belong to terminal content actions. Dock and ToolTab menus belong to Dock/Workspace actions.

Terminal content menu actions:

- Copy
- Paste
- Paste Selection
- Select All
- Reset Terminal
- Toggle Terminal Read-only
- Find

ToolTab/Dock menu actions:

- Split Left
- Split Right
- Split Up
- Split Down
- Float
- Close
- Close Others
- Close to the Right

Use native Tauri popup menus where possible. Do not draw browser-style context menus over terminal content.

## Keyboard Commands

Terminal commands should be backed by command IDs so keyboard shortcuts, settings, menus, and the command palette share action paths.

Terminal-specific command IDs include:

- `terminal.newSession`
- `terminal.copy`
- `terminal.paste`
- `terminal.pasteSelection`
- `terminal.selectAll`
- `terminal.find`
- `terminal.findNext`
- `terminal.findPrevious`
- `terminal.hideFindBar`
- `terminal.resetFontSize`
- `terminal.increaseFontSize`
- `terminal.decreaseFontSize`
- `terminal.toggleReadOnly`

Dock split/focus/float/close commands use Dock or Tool command IDs, not terminal-layout-specific IDs. See [Dock Layout](dock-layout.md).

## Drag And Drop

Terminal content must not start Dock drag operations. Terminal applications use mouse input, so drag handles and tab dragging must stay on ToolTab chrome and Dock surfaces.

Dock movement uses pointer capture and geometry hit testing. Do not use HTML5 drag-and-drop for Dock operations.

Pointer rules:

- start Dock drag only from ToolTab chrome
- capture the pointer as soon as drag starts
- listen for `pointermove`, `pointerup`, and `pointercancel` in capture phase
- calculate drop targets from geometry, not HTML5 DnD events
- clear drag state on pointer cancel, window blur, and document hide
- keep WebKit native drag disabled on ToolTab chrome

## Terminal Lifecycle

Creating a Terminal ToolTab:

1. create one backend terminal session
2. create one frontend terminal tool object for that session
3. insert one ToolSlot into the Dock layout
4. mount xterm after the Dock group is visible
5. fit and resize after the DOM has settled

Moving a Terminal ToolTab between Dock groups:

- does not create or close backend sessions
- may remount the xterm instance into a different container
- must refit after mount

Floating a Terminal ToolTab:

- keeps the owner Workspace unchanged
- creates a floating Terminal mirror display
- leaves the owner Terminal ToolTab visible in its original Dock slot
- closes only the floating mirror display when the floating window closes

Mirror display:

- shares terminal business state and backend session
- receives the same output stream
- follows the Terminal mirror target design below

If the owner closes, mirrors become closed-source placeholders and stop accepting input.

## Terminal Mirror Target Design

This section is the target design and acceptance criteria for Terminal mirrors. If the current implementation has not yet shipped every item, update the implementation toward these rules rather than changing the product contract.

Terminal mirrors are special because a single backend PTY can have multiple visible xterm views. The backend session is shared, while each rendered xterm view keeps its own view-local UI.

Shared Terminal session state:

- backend session id and transport session
- PTY process state: running, exited, reconnecting, disconnected, or error
- output buffer and alternate screen content
- ToolTab title, shell title, cwd, and session metadata
- backend status and reconnect/error state
- input effects after keyboard or mouse events are written to the backend

View-local Terminal UI state:

- DOM focus ring for the actual focused xterm element
- scrollback viewport
- xterm selection
- find UI, query, active match, and find highlights
- context menu state and position
- hover, drag, drop, resize, and other temporary visual state
- renderer instance details such as canvas/WebGL state

Input rules:

- Terminal mirrors are editable by default.
- A view must have real DOM focus or be the real pointer event target before it can send keyboard or mouse input.
- Only one actual xterm view sends any given keyboard or mouse event to the backend session.
- Input from a mirror still runs on the owner Terminal's host, not on the current workspace host.
- Mirror UI must make the owner Workspace and Host visible through a badge, chip, tooltip, or equivalent source indicator.

Scroll, selection, and find rules:

- Do not synchronize scrollback viewport between views.
- If a terminal application consumes wheel or mouse events, only the real event target sends those events to the backend. The resulting program output or alternate-screen change is shared naturally through the backend session.
- Do not synchronize xterm selection between views.
- Do not synchronize find UI, query, active match, or find highlights between views.
- Search implementations may reuse the shared session buffer as a data source.

PTY size rules:

- The backend PTY size is computed from all visible, mounted, fitted, and usable Terminal views for that shared session.
- Hidden Workspaces, background views, collapsed groups, unmounted views, and not-yet-fitted views do not participate.
- A visible floating Terminal mirror participates when it is mounted, fitted, and usable.
- The chosen PTY size is the minimum usable `cols` and minimum usable `rows` across participating views.
- Resize updates are sent in real time, but must be coalesced to an animation frame or short debounce and sent only when the computed `cols` or `rows` changes.
- Each Terminal view has a minimum participating size. A view below that threshold shows a compact placeholder such as `Terminal too small` and does not participate in PTY size calculation.
- If every visible view is below the minimum participating size, keep the last valid PTY size and do not send a new resize. For a new session without a last valid size, use the default terminal size such as `80x24`.
- Views that constrain the current PTY size may be tracked internally for diagnostics and testing, but the Terminal UI should not show a visible size-source indicator during normal use.

Lifecycle rules:

- Creating a mirror slot does not affect PTY size until the mirror is actually mounted, visible, fitted, and above the minimum participating size.
- Closing a mirror removes only that display slot. It does not prompt for terminal session close and does not dispose the backend session.
- Closing a mirror can change the visible participant set, so PTY size must be recalculated afterward.
- Closing the owner Terminal ToolTab follows the normal Terminal close confirmation and backend dispose flow. Mirrors become closed-source placeholders.
- Closed-source placeholders do not accept input and do not participate in PTY size calculation.
- Terminal mirror slots are not persisted across app restarts.
- Terminal mirrors may appear in floating windows. Closing a floating mirror does not close the backend session. Mirror-only floating windows are not restored after app restart.

## Failure Handling

Terminal/session failures must stay scoped to the Terminal ToolTab.

An SSH connection can fail and remove `term-x` while the frontend still has queued backlog, resize, or write work for that id. The resulting `terminal session term-x not found` is a stale terminal-session condition. It should be ignored if the ToolTab is already gone, or translated into that ToolTab's disconnected/error presentation if the ToolTab still exists.

Stale terminal-session errors must never be written into global page or settings error state because they can obscure unrelated Workspaces and future local sessions.

## Scrollbars

Terminal scrollbars are a Nocturne-owned overlay inside the terminal mount, not a proxy scrolling container. xterm still owns scroll offset, wheel handling, selection behavior, and fit measurements.

Reattach or update the Nocturne-owned scrollbar DOM whenever an existing xterm element is remounted into a new Dock group or floating window container.

## Find Integration

Terminal find is scoped to the active Terminal ToolTab. See [Terminal Find](terminal-find.md).

Closing terminal find clears xterm decorations/selection and changes focus while overlay DOM is being removed. It must explicitly refresh terminal presentation and scrollbar after the DOM has settled. Do not rely on `ResizeObserver` for this path because the find bar is fixed-position and intentionally does not resize the terminal container.

## Validation

Vitest unit tests should cover pure terminal and Dock frontend logic that can run without a real Tauri runtime:

- terminal size normalization
- terminal title derivation with aliases
- terminal session stale-error classification
- command registry mapping for terminal and Dock split commands
- close confirmation decisions

Rust unit tests should cover Rust-side terminal command and service logic that does not require a real WebView, PTY process, or native window.

Tauri unit tests should cover real-app workflows that require the real Tauri app, WebView, PTY, native input, or window lifecycle:

- creating a default Workspace with Terminal ToolTab
- splitting a Terminal ToolTab through Dock split
- moving a Terminal ToolTab between Dock groups
- floating and restoring a Terminal ToolTab
- displaying a Terminal ToolTab mirror
- source close turning mirrors into closed-source placeholders
- typing goes to the active Terminal ToolTab
- resizing Dock groups refits xterm
- terminal context menu actions still work
- dark and light themes keep terminal chrome legible
