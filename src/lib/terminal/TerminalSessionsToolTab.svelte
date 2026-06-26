<script lang="ts">
  import { onMount, tick } from "svelte";
  import { ask } from "@tauri-apps/plugin-dialog";
  import { OverlayScrollbarsComponent } from "overlayscrollbars-svelte";
  import "overlayscrollbars/overlayscrollbars.css";
  import RefreshCw from "~icons/lucide/refresh-cw";
  import Trash2 from "~icons/lucide/trash-2";
  import PlugZap from "~icons/lucide/plug-zap";
  import ScrollText from "~icons/lucide/scroll-text";
  import { commands, type TerminalDetachedSessionInfo, type WorkspaceToolTab } from "$lib/bindings";
  import { hasTauriRuntime } from "$lib/tauri/runtime";
  import { unwrapCommand } from "$lib/terminal/commands";

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
  let lastLoadedRevision = -1;
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

  onMount(() => {
    void refreshSessions();
  });

  $effect(() => {
    if (!active || revision === lastLoadedRevision) return;
    lastLoadedRevision = revision;
    void refreshSessions();
  });

  $effect(() => {
    sessions.length;
    loading;
    error;
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
</script>

{#snippet sessionRows()}
  <ul class="sessions-list" bind:this={sessionsList}>
    {#each sessions as session (session.session_id)}
      <li data-testid="terminal-session-row" data-session-id={session.session_id} data-detached={session.detached}>
        <div class="session-main">
          <strong title={session.title}>{session.title}</strong>
          <span title={session.command}>{session.command}</span>
        </div>
        <div class="session-meta">
          <span>{statusLabel(session)}</span>
          <span>{session.cols}x{session.rows}</span>
        </div>
        <div class="session-actions">
          {#if session.detached}
            <button
              type="button"
              aria-label={`Attach ${session.title}`}
              title="Attach"
              onclick={() => void attachSession(session)}
            >
              <PlugZap />
            </button>
          {:else}
            <button
              type="button"
              aria-label={`View history for ${session.title}`}
              title="View History"
              onclick={() => void openSessionHistory(session)}
            >
              <ScrollText />
            </button>
          {/if}
          <button
            type="button"
            class="danger"
            aria-label={`Delete ${session.title}`}
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

<section class="terminal-sessions-tooltab" aria-label="Terminals" data-testid="terminal-sessions-tooltab">
  <header>
    <strong>Terminals</strong>
    <span>{sessions.length}</span>
    <button type="button" aria-label="Refresh terminals" title="Refresh" onclick={() => void refreshSessions()}>
      <RefreshCw />
    </button>
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
    grid-template-columns: minmax(0, 1fr) auto 24px;
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
    grid-auto-rows: minmax(36px, max-content);
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
    min-height: 36px;
    border-bottom: 1px solid color-mix(in srgb, var(--app-border) 70%, transparent);
    padding: 3px 7px 3px 8px;
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
    min-width: 54px;
    display: grid;
    justify-items: end;
    gap: 2px;
    font-variant-numeric: tabular-nums;
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
