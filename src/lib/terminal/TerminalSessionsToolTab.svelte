<script lang="ts">
  import { tick } from "svelte";
  import { ask } from "@tauri-apps/plugin-dialog";
  import { OverlayScrollbarsComponent } from "overlayscrollbars-svelte";
  import "overlayscrollbars/overlayscrollbars.css";
  import RefreshCw from "~icons/lucide/refresh-cw";
  import Trash2 from "~icons/lucide/trash-2";
  import Check from "~icons/lucide/check";
  import PlugZap from "~icons/lucide/plug-zap";
  import ScrollText from "~icons/lucide/scroll-text";
  import SquareCheck from "~icons/lucide/square-check";
  import Circle from "~icons/lucide/circle";
  import X from "~icons/lucide/x";
  import ListChecks from "~icons/lucide/list-checks";
  import RotateCcwSquare from "~icons/lucide/rotate-ccw-square";
  import { commands, type TerminalDetachedSessionInfo, type WorkspaceToolTab } from "$lib/bindings";
  import { hasTauriRuntime } from "$lib/tauri/runtime";
  import { unwrapCommand } from "$lib/terminal/commands";
  import { compactTerminalPathTitle } from "$lib/terminal/tab-title";

  type Props = {
    active?: boolean;
    revision?: number;
    toolTab: WorkspaceToolTab;
    workspaceId: string;
    onAttach: (sessionId: string, sourceToolTabId: string) => Promise<void>;
    onOpenHistory: (sessionId: string, sourceToolTabId: string) => Promise<void>;
    onDeleted?: () => void | Promise<void>;
    onSessionsChanged?: (sessions: TerminalDetachedSessionInfo[]) => void | Promise<void>;
  };

  let { active = true, revision = 0, toolTab, workspaceId, onAttach, onOpenHistory, onDeleted, onSessionsChanged }: Props = $props();
  let sessions = $state<TerminalDetachedSessionInfo[]>([]);
  let loading = $state(false);
  let error = $state("");
  let sessionsBody = $state<HTMLDivElement>();
  let sessionsList = $state<HTMLUListElement>();
  let sessionsOverflow = $state(false);
  let selectedSessionIds = $state(new Set<string>());
  let selecting = $state(false);
  let renamingSessionId = $state("");
  let renameDraft = $state("");
  let sessionContextMenu = $state<{ sessionId: string; left: number; top: number } | null>(null);
  let lastLoadedRevision = -1;
  let wasActive = false;
  const overlayOptions = {
    overflow: {
      x: "hidden",
      y: "scroll",
    },
    scrollbars: {
      visibility: "auto",
      autoHide: "leave",
      autoHideDelay: 420,
      theme: "os-theme-nocturne",
    },
  } as const;

  $effect(() => {
    if (!active) {
      wasActive = false;
      return;
    }
    if (wasActive && revision === lastLoadedRevision) return;
    wasActive = true;
    lastLoadedRevision = revision;
    void refreshSessions();
  });

  $effect(() => {
    if (!sessionContextMenu) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-session-context-menu]")) return;
      closeSessionContextMenu();
    };
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSessionContextMenu();
    };
    document.addEventListener("pointerdown", close, { capture: true });
    document.addEventListener("keydown", closeOnKey, { capture: true });
    return () => {
      document.removeEventListener("pointerdown", close, { capture: true });
      document.removeEventListener("keydown", closeOnKey, { capture: true });
    };
  });

  $effect(() => {
    sessions.length;
    loading;
    error;
    pruneSelectedSessions();
    void tick().then(measureSessionsOverflow);
  });

  $effect(() => {
    const body = sessionsBody;
    const list = sessionsList;
    if (!body || !list) return;
    if (typeof ResizeObserver === "undefined") {
      measureSessionsOverflow();
      return;
    }
    const resizeObserver = new ResizeObserver(() => measureSessionsOverflow());
    resizeObserver.observe(body);
    resizeObserver.observe(list);
    return () => resizeObserver.disconnect();
  });

  async function refreshSessions() {
    if (!hasTauriRuntime()) {
      sessions = [];
      void notifySessionsChanged(sessions);
      return;
    }
    loading = true;
    try {
      sessions = await unwrapCommand(
        commands.listDetachedTerminalSessions({
          workspace_id: workspaceId,
          tool_tab_id: toolTab.id,
        }),
      );
      void notifySessionsChanged(sessions);
      error = "";
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading = false;
    }
  }

  async function notifySessionsChanged(nextSessions: TerminalDetachedSessionInfo[]) {
    await onSessionsChanged?.(nextSessions);
  }

  async function attachSession(session: TerminalDetachedSessionInfo) {
    if (!session.detached) return;
    await onAttach(session.session_id, toolTab.id);
    await refreshSessions();
  }

  async function openSessionHistory(session: TerminalDetachedSessionInfo) {
    if (session.detached) return;
    await onOpenHistory(session.session_id, toolTab.id);
    await refreshSessions();
  }

  async function deleteSession(session: TerminalDetachedSessionInfo) {
    const confirmed = await ask("Delete this terminal session and its saved transcript?", {
      title: "Delete Terminal Session",
      kind: "warning",
      okLabel: "Delete",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;
    await unwrapCommand(
      commands.deleteDetachedTerminalSession({
        workspace_id: workspaceId,
        tool_tab_id: toolTab.id,
        detached_session_id: session.session_id,
      }),
    );
    sessions = sessions.filter((item) => item.session_id !== session.session_id);
    void notifySessionsChanged(sessions);
    selectedSessionIds = withoutSelectedSessions(new Set([session.session_id]));
    await onDeleted?.();
  }

  async function deleteSelectedSessions() {
    const sessionsToDelete = sessions.filter((session) => selectedSessionIds.has(session.session_id));
    if (sessionsToDelete.length === 0) return;
    const confirmed = await ask(`Delete ${sessionsToDelete.length} terminal sessions and their saved transcripts?`, {
      title: "Delete Terminal Sessions",
      kind: "warning",
      okLabel: "Delete",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;
    for (const session of sessionsToDelete) {
      await unwrapCommand(
        commands.deleteDetachedTerminalSession({
          workspace_id: workspaceId,
          tool_tab_id: toolTab.id,
          detached_session_id: session.session_id,
        }),
      );
    }
    const deletedIds = new Set(sessionsToDelete.map((session) => session.session_id));
    sessions = sessions.filter((item) => !deletedIds.has(item.session_id));
    void notifySessionsChanged(sessions);
    selectedSessionIds = withoutSelectedSessions(deletedIds);
    selecting = false;
    await onDeleted?.();
  }

  function openSessionContextMenu(event: MouseEvent, session: TerminalDetachedSessionInfo) {
    if (selecting) return;
    event.preventDefault();
    event.stopPropagation();
    sessionContextMenu = {
      sessionId: session.session_id,
      left: event.clientX,
      top: event.clientY,
    };
  }

  function closeSessionContextMenu() {
    sessionContextMenu = null;
  }

  function contextMenuSession() {
    const sessionId = sessionContextMenu?.sessionId;
    return sessionId ? (sessions.find((session) => session.session_id === sessionId) ?? null) : null;
  }

  function renameSessionFromContextMenu(session: TerminalDetachedSessionInfo) {
    closeSessionContextMenu();
    startRenamingSession(session);
  }

  async function deleteSessionFromContextMenu(session: TerminalDetachedSessionInfo) {
    closeSessionContextMenu();
    await deleteSession(session);
  }

  function startRenamingSession(session: TerminalDetachedSessionInfo) {
    renamingSessionId = session.session_id;
    renameDraft = sessionDisplayTitle(session);
  }

  function cancelRenamingSession() {
    renamingSessionId = "";
    renameDraft = "";
  }

  async function commitRenamingSession(session: TerminalDetachedSessionInfo) {
    if (renamingSessionId !== session.session_id) return;
    const title = renameDraft.trim();
    if (!title) {
      cancelRenamingSession();
      return;
    }
    if (title !== session.title.trim()) {
      await unwrapCommand(
        commands.renameDetachedTerminalSession({
          workspace_id: workspaceId,
          tool_tab_id: toolTab.id,
          detached_session_id: session.session_id,
          title,
        }),
      );
      sessions = sessions.map((item) => (item.session_id === session.session_id ? { ...item, title } : item));
      void notifySessionsChanged(sessions);
      await refreshSessions();
    }
    cancelRenamingSession();
  }

  function handleRenameKeydown(event: KeyboardEvent, session: TerminalDetachedSessionInfo) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelRenamingSession();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void commitRenamingSession(session);
    }
  }

  function focusRenameInput(node: HTMLInputElement) {
    void tick().then(() => node.focus());
    return {};
  }

  function statusLabel(session: TerminalDetachedSessionInfo) {
    if (!session.detached) return "Exited";
    return session.attached_count > 0 ? `Attached ${session.attached_count}` : "Detached";
  }

  function measureSessionsOverflow() {
    if (!sessionsBody || !sessionsList || sessions.length === 0 || loading || error) {
      sessionsOverflow = false;
      return;
    }
    sessionsOverflow = sessionsList.scrollHeight > sessionsBody.clientHeight + 1;
  }

  function toggleSessionSelection(sessionId: string, selected: boolean) {
    const nextSelection = new Set(selectedSessionIds);
    if (selected) {
      nextSelection.add(sessionId);
    } else {
      nextSelection.delete(sessionId);
    }
    selectedSessionIds = nextSelection;
  }

  function toggleSessionSelected(sessionId: string) {
    toggleSessionSelection(sessionId, !selectedSessionIds.has(sessionId));
  }

  function enterSelectionMode(sessionId?: string) {
    selecting = true;
    if (sessionId) selectedSessionIds = new Set([sessionId]);
  }

  function exitSelectionMode() {
    selecting = false;
    selectedSessionIds = new Set();
  }

  function selectAllSessions() {
    selectedSessionIds = new Set(sessions.map((session) => session.session_id));
  }

  function invertSelectedSessions() {
    const nextSelection = new Set<string>();
    for (const session of sessions) {
      if (!selectedSessionIds.has(session.session_id)) nextSelection.add(session.session_id);
    }
    selectedSessionIds = nextSelection;
  }

  function pruneSelectedSessions() {
    const visibleIds = new Set(sessions.map((session) => session.session_id));
    const nextSelection = new Set([...selectedSessionIds].filter((sessionId) => visibleIds.has(sessionId)));
    if (nextSelection.size !== selectedSessionIds.size) {
      selectedSessionIds = nextSelection;
    }
  }

  function withoutSelectedSessions(sessionIds: Set<string>) {
    const nextSelection = new Set(selectedSessionIds);
    for (const sessionId of sessionIds) {
      nextSelection.delete(sessionId);
    }
    return nextSelection;
  }

  function sessionDisplayTitle(session: TerminalDetachedSessionInfo) {
    const title = session.title.trim();
    return title || session.session_id;
  }

  function sessionSubtitle(session: TerminalDetachedSessionInfo) {
    const cwd = session.cwd?.trim() ?? "";
    return cwd ? compactTerminalPathTitle(cwd) : session.command.trim() || session.session_id;
  }

  function sessionTooltip(session: TerminalDetachedSessionInfo) {
    return [
      sessionDisplayTitle(session),
      session.cwd?.trim() ? `cwd: ${session.cwd.trim()}` : "",
      session.command.trim() ? `command: ${session.command.trim()}` : "",
      statusLabel(session),
    ]
      .filter(Boolean)
      .join("\n");
  }
</script>

{#snippet sessionRows()}
  <ul class="sessions-list" bind:this={sessionsList}>
    {#each sessions as session (session.session_id)}
      <li
        data-testid="terminal-session-row"
        data-session-id={session.session_id}
        data-detached={session.detached}
        data-selecting={selecting}
        data-selected={selectedSessionIds.has(session.session_id)}
        oncontextmenu={(event) => openSessionContextMenu(event, session)}
      >
        {#if selecting}
          <button
            type="button"
            class="session-select-indicator"
            aria-label={`${selectedSessionIds.has(session.session_id) ? "Deselect" : "Select"} ${sessionDisplayTitle(session)}`}
            aria-pressed={selectedSessionIds.has(session.session_id)}
            title={selectedSessionIds.has(session.session_id) ? "Selected" : "Select"}
            onclick={() => toggleSessionSelected(session.session_id)}
          >
            {#if selectedSessionIds.has(session.session_id)}
              <Check />
            {:else}
              <Circle />
            {/if}
          </button>
        {/if}
        {#if renamingSessionId === session.session_id}
          <div class="session-main">
            <input
              class="session-rename-input"
              aria-label={`Rename ${sessionDisplayTitle(session)}`}
              bind:value={renameDraft}
              onkeydown={(event) => handleRenameKeydown(event, session)}
              onblur={() => void commitRenamingSession(session)}
              use:focusRenameInput
            />
            <span title={sessionSubtitle(session)}>{sessionSubtitle(session)}</span>
          </div>
        {:else if selecting}
          <button
            type="button"
            class="session-main"
            onclick={() => toggleSessionSelected(session.session_id)}
          >
            <strong title={sessionTooltip(session)}>{sessionDisplayTitle(session)}</strong>
            <span title={sessionSubtitle(session)}>{sessionSubtitle(session)}</span>
          </button>
        {:else}
          <div class="session-main">
            <strong title={sessionTooltip(session)}>{sessionDisplayTitle(session)}</strong>
            <span title={sessionSubtitle(session)}>{sessionSubtitle(session)}</span>
          </div>
        {/if}
        <div class="session-meta">
          <span title={statusLabel(session)}>{statusLabel(session)}</span>
        </div>
        <div class="session-actions">
          {#if renamingSessionId === session.session_id}
            <button
              type="button"
              aria-label={`Save ${sessionDisplayTitle(session)}`}
              title="Save"
              onclick={() => void commitRenamingSession(session)}
            >
              <Check />
            </button>
            <button type="button" aria-label="Cancel rename" title="Cancel" onclick={cancelRenamingSession}>
              <X />
            </button>
          {:else if session.detached}
            <button
              type="button"
              aria-label={`Attach ${sessionDisplayTitle(session)}`}
              title="Attach"
              onclick={() => void attachSession(session)}
            >
              <PlugZap />
            </button>
          {:else}
            <button
              type="button"
              aria-label={`View history for ${sessionDisplayTitle(session)}`}
              title="View History"
              onclick={() => void openSessionHistory(session)}
            >
              <ScrollText />
            </button>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
{/snippet}

<section class="terminal-sessions-tooltab" aria-label="Terminal sessions" data-testid="terminal-sessions-tooltab" data-tool-tab-id={toolTab.id}>
  <header data-selecting={selecting}>
    <strong>Terminals</strong>
    <span>{selecting ? `${selectedSessionIds.size}/${sessions.length}` : sessions.length}</span>
    {#if selecting}
      <button type="button" aria-label="Select all terminal sessions" title="Select All" onclick={selectAllSessions}>
        <ListChecks />
      </button>
      <button type="button" aria-label="Invert terminal session selection" title="Invert Selection" onclick={invertSelectedSessions}>
        <RotateCcwSquare />
      </button>
      <button
        type="button"
        class="danger"
        aria-label="Delete selected terminal sessions"
        title="Delete Selected"
        disabled={selectedSessionIds.size === 0}
        onclick={() => void deleteSelectedSessions()}
      >
        <Trash2 />
      </button>
      <button type="button" aria-label="Done selecting terminal sessions" title="Done" onclick={exitSelectionMode}>
        <SquareCheck />
      </button>
    {:else}
      <button type="button" aria-label="Select terminal sessions" title="Select" onclick={() => enterSelectionMode()}>
        <SquareCheck />
      </button>
      <button type="button" aria-label="Refresh terminals" title="Refresh" onclick={() => void refreshSessions()}>
        <RefreshCw />
      </button>
    {/if}
  </header>

  <div class="sessions-body" bind:this={sessionsBody} data-sessions-overflow={sessionsOverflow ? "true" : "false"}>
    {#if error}
      <div class="sessions-status error">{error}</div>
    {:else if loading && sessions.length === 0}
      <div class="sessions-status">Loading</div>
    {:else if sessions.length === 0}
      <div class="sessions-status">No sessions</div>
    {:else}
      <OverlayScrollbarsComponent element="div" class="sessions-body-scroll" options={overlayOptions} defer>
        <div class="sessions-scroll-body">
          {@render sessionRows()}
        </div>
      </OverlayScrollbarsComponent>
    {/if}
  </div>
  {#if sessionContextMenu}
    {@const menuSession = contextMenuSession()}
    {#if menuSession}
      <div
        class="session-context-menu"
        style={`left: ${sessionContextMenu.left}px; top: ${sessionContextMenu.top}px;`}
        role="menu"
        data-session-context-menu="true"
      >
        <button type="button" role="menuitem" onclick={() => renameSessionFromContextMenu(menuSession)}>Rename</button>
        <button type="button" role="menuitem" class="danger" onclick={() => void deleteSessionFromContextMenu(menuSession)}>Delete</button>
      </div>
    {/if}
  {/if}
</section>

<style>
  .terminal-sessions-tooltab {
    min-width: 0;
    min-height: 0;
    height: 100%;
    display: grid;
    grid-template-rows: 28px minmax(0, 1fr);
    box-sizing: border-box;
    overflow: hidden;
    background: color-mix(in srgb, var(--app-bg) 96%, var(--app-control));
    color: var(--app-fg);
    font-size: 12px;
    container-type: inline-size;
  }

  header {
    min-width: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto repeat(2, 24px);
    align-items: center;
    gap: 8px;
    padding: 0 8px 0 9px;
    border-bottom: 1px solid var(--app-border);
    user-select: none;
    -webkit-user-select: none;
  }

  header strong,
  header span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  header[data-selecting="true"] {
    grid-template-columns: minmax(0, 1fr) auto repeat(4, 24px);
  }

  header span {
    color: color-mix(in srgb, var(--app-fg) 54%, transparent);
  }

  button {
    width: 22px;
    height: 22px;
    display: inline-grid;
    place-items: center;
    border: 0;
    border-radius: 5px;
    padding: 0;
    background: transparent;
    color: inherit;
  }

  button:active:not(:disabled) {
    background: var(--app-active);
  }

  button:disabled {
    color: color-mix(in srgb, var(--app-fg) 28%, transparent);
  }

  button :global(svg) {
    width: 14px;
    height: 14px;
  }

  :global(.sessions-body-scroll) {
    min-width: 0;
    min-height: 0;
    height: 100%;
    box-sizing: border-box;
    overflow: hidden;
    display: grid;
  }

  .sessions-body {
    min-width: 0;
    min-height: 0;
    height: 100%;
    display: grid;
    grid-template-rows: minmax(0, 1fr);
    overflow: hidden;
  }

  .sessions-scroll-body {
    min-width: 0;
    min-height: 0;
    height: 100%;
    overflow: hidden;
    display: grid;
    grid-template-rows: minmax(0, 1fr);
  }

  .sessions-status {
    min-width: 0;
    min-height: 0;
    display: grid;
    place-items: center;
    padding: 12px;
    color: color-mix(in srgb, var(--app-fg) 58%, transparent);
    text-align: center;
  }

  .sessions-status.error {
    color: var(--app-danger);
  }

  .sessions-list {
    min-width: 0;
    display: grid;
    grid-auto-rows: minmax(44px, max-content);
    align-content: start;
    gap: 0;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    min-width: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    grid-template-areas: "main meta actions";
    align-items: center;
    gap: 8px;
    min-height: 44px;
    border-bottom: 1px solid color-mix(in srgb, var(--app-border) 70%, transparent);
    padding: 6px 7px 6px 9px;
  }

  li[data-selecting="true"] {
    grid-template-columns: 22px minmax(0, 1fr) auto 0;
    grid-template-areas: "select main meta actions";
    padding-left: 7px;
  }

  li[data-selected="true"] {
    background: color-mix(in srgb, var(--app-accent) 13%, transparent);
  }

  .session-select-indicator {
    grid-area: select;
    width: 20px;
    height: 22px;
    display: grid;
    place-items: center;
    color: color-mix(in srgb, var(--app-fg) 40%, transparent);
  }

  .session-select-indicator[aria-pressed="true"] {
    color: var(--app-accent);
  }

  .session-select-indicator :global(svg) {
    width: 13px;
    height: 13px;
  }

  li[data-detached="false"] {
    color: color-mix(in srgb, var(--app-fg) 62%, transparent);
  }

  .session-main {
    grid-area: main;
    min-width: 0;
    display: grid;
    gap: 2px;
    width: 100%;
    height: auto;
    place-items: stretch;
    text-align: left;
    border-radius: 4px;
    color: inherit;
    cursor: default;
  }

  .session-main strong,
  .session-main span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .session-main:disabled {
    opacity: 1;
  }

  .session-main:active:not(:disabled) {
    background: transparent;
  }

  .session-main span,
  .session-rename-input,
  .session-meta {
    color: color-mix(in srgb, var(--app-fg) 56%, transparent);
  }

  .session-rename-input {
    min-width: 0;
    height: 20px;
    border: 1px solid color-mix(in srgb, var(--app-accent) 58%, var(--app-border));
    border-radius: 5px;
    padding: 0 6px;
    outline: none;
    background: color-mix(in srgb, var(--app-bg) 82%, var(--app-control));
    color: var(--app-fg);
    font: inherit;
  }

  .session-meta {
    grid-area: meta;
    min-width: 48px;
    display: grid;
    justify-items: end;
  }

  .session-actions {
    grid-area: actions;
    min-width: 22px;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 3px;
  }

  li[data-selecting="true"] .session-actions {
    width: 0;
    overflow: hidden;
  }

  @container (max-width: 190px) {
    li {
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas:
        "main actions"
        "meta actions";
      row-gap: 2px;
    }

    li[data-selecting="true"] {
      grid-template-columns: 22px minmax(0, 1fr);
      grid-template-areas:
        "select main"
        "select meta";
    }

    .session-meta {
      min-width: 0;
      justify-items: start;
    }

    .session-actions {
      align-self: center;
    }
  }

  .danger {
    color: var(--app-danger);
  }

  .session-context-menu {
    position: fixed;
    z-index: 200;
    min-width: 132px;
    display: grid;
    gap: 2px;
    padding: 5px;
    border: 1px solid var(--app-border);
    border-radius: 6px;
    background: color-mix(in srgb, var(--app-bg) 96%, var(--app-control));
    box-shadow: 0 14px 32px color-mix(in srgb, #000 24%, transparent);
  }

  .session-context-menu button {
    width: 100%;
    height: 26px;
    justify-content: start;
    padding: 0 8px;
    text-align: left;
  }

  .session-context-menu button:hover {
    background: var(--app-hover);
  }
</style>
