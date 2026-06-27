<script lang="ts">
  import { tick } from "svelte";
  import { ask } from "@tauri-apps/plugin-dialog";
  import { OverlayScrollbarsComponent } from "overlayscrollbars-svelte";
  import "overlayscrollbars/overlayscrollbars.css";
  import RefreshCw from "~icons/lucide/refresh-cw";
  import Trash2 from "~icons/lucide/trash-2";
  import PlugZap from "~icons/lucide/plug-zap";
  import ScrollText from "~icons/lucide/scroll-text";
  import SquareCheck from "~icons/lucide/square-check";
  import SquareMousePointer from "~icons/lucide/square-mouse-pointer";
  import ListChecks from "~icons/lucide/list-checks";
  import RotateCcwSquare from "~icons/lucide/rotate-ccw-square";
  import { commands, type TerminalDetachedSessionInfo, type WorkspaceToolTab } from "$lib/bindings";
  import { hasTauriRuntime } from "$lib/tauri/runtime";
  import { unwrapCommand } from "$lib/terminal/commands";
  import {
    compactTerminalPathTitle,
    compactTerminalTitle,
    isGeneratedSessionTitle,
    isPathLikeTitle,
  } from "$lib/terminal/tab-title";

  type Props = {
    active?: boolean;
    revision?: number;
    toolTab: WorkspaceToolTab;
    workspaceId: string;
    onAttach: (sessionId: string, sourceToolTabId: string) => Promise<void>;
    onOpenHistory: (sessionId: string, sourceToolTabId: string) => Promise<void>;
    onDeleted?: () => void | Promise<void>;
  };

  let { active = true, revision = 0, toolTab, workspaceId, onAttach, onOpenHistory, onDeleted }: Props = $props();
  let sessions = $state<TerminalDetachedSessionInfo[]>([]);
  let loading = $state(false);
  let error = $state("");
  let sessionsBody = $state<HTMLDivElement>();
  let sessionsList = $state<HTMLUListElement>();
  let sessionsOverflow = $state(false);
  let selectedSessionIds = $state(new Set<string>());
  let selecting = $state(false);
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
      error = "";
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading = false;
    }
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
    selectedSessionIds = withoutSelectedSessions(deletedIds);
    selecting = false;
    await onDeleted?.();
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
    const cwd = session.cwd?.trim() ?? "";
    if (title && !isGeneratedSessionTitle(title) && !isPathLikeTitle(title)) return title;
    if (cwd) return compactTerminalPathTitle(cwd);
    if (title && !isGeneratedSessionTitle(title)) return compactTerminalTitle(title);
    return session.command.trim() || session.session_id;
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
      >
        {#if selecting}
          <label class="session-select" aria-label={`Select ${sessionDisplayTitle(session)}`}>
            <input
              type="checkbox"
              checked={selectedSessionIds.has(session.session_id)}
              onchange={(event) => toggleSessionSelection(session.session_id, event.currentTarget.checked)}
            />
          </label>
        {/if}
        <div class="session-main">
          <strong title={sessionTooltip(session)}>{sessionDisplayTitle(session)}</strong>
          <span title={sessionSubtitle(session)}>{sessionSubtitle(session)}</span>
        </div>
        <div class="session-meta">
          <span title={statusLabel(session)}>{statusLabel(session)}</span>
        </div>
        <div class="session-actions">
          {#if selecting}
            <button
              type="button"
              aria-label={`Select only ${sessionDisplayTitle(session)}`}
              title="Select Only"
              onclick={() => enterSelectionMode(session.session_id)}
            >
              <SquareMousePointer />
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
          <button
            type="button"
            class="danger"
            aria-label={`Delete ${sessionDisplayTitle(session)}`}
            title="Delete"
            onclick={() => void deleteSession(session)}
          >
            <Trash2 />
          </button>
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
    {:else if sessionsOverflow}
      <OverlayScrollbarsComponent element="div" class="sessions-body-scroll" options={overlayOptions} defer>
        <div class="sessions-scroll-body">
          {@render sessionRows()}
        </div>
      </OverlayScrollbarsComponent>
    {:else}
      <div class="sessions-list-frame">
        {@render sessionRows()}
      </div>
    {/if}
  </div>
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

  .sessions-list-frame {
    min-width: 0;
    min-height: 0;
    height: 100%;
    overflow: hidden;
    display: grid;
    align-content: start;
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
    grid-template-columns: minmax(0, 1fr) auto 56px;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    border-bottom: 1px solid color-mix(in srgb, var(--app-border) 70%, transparent);
    padding: 6px 7px 6px 9px;
  }

  li[data-selecting="true"] {
    grid-template-columns: 18px minmax(0, 1fr) auto 56px;
  }

  .session-select {
    width: 18px;
    height: 22px;
    display: grid;
    place-items: center;
  }

  .session-select input {
    width: 13px;
    height: 13px;
    margin: 0;
    accent-color: var(--app-accent);
  }

  li[data-detached="false"] {
    color: color-mix(in srgb, var(--app-fg) 62%, transparent);
  }

  .session-main {
    min-width: 0;
    display: grid;
    gap: 2px;
  }

  .session-main strong,
  .session-main span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .session-main span,
  .session-meta {
    color: color-mix(in srgb, var(--app-fg) 56%, transparent);
  }

  .session-meta {
    min-width: 48px;
    display: grid;
    justify-items: end;
  }

  .session-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 3px;
  }

  .danger {
    color: var(--app-danger);
  }
</style>
