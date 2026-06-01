<script lang="ts">
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { commands, type TransferTask, type WorkspaceTabState } from "$lib/bindings";
  import { hasTauriRuntime } from "$lib/tauri/runtime";
  import { unwrapCommand } from "$lib/terminal/commands";

  type Props = {
    workspace: WorkspaceTabState | null;
  };

  let { workspace }: Props = $props();
  const queryClient = useQueryClient();
  const queueQuery = createQuery(() => ({
    queryKey: ["transfers", "queue"],
    enabled: hasTauriRuntime(),
    queryFn: () => unwrapCommand(commands.getTransferQueueSnapshot()),
    refetchInterval: 2_000,
  }));

  const visibleTasks = $derived(
    (queueQuery.data?.tasks ?? []).filter((task) => {
      if (!workspace) return true;
      return task.related_workspace_ids.includes(workspace.id) || task.initiator_workspace_id === workspace.id;
    }),
  );

  async function cancelTask(task: TransferTask) {
    await unwrapCommand(commands.cancelTransferTask({ task_id: task.id }));
    await queryClient.invalidateQueries({ queryKey: ["transfers", "queue"] });
  }

  async function retryTask(task: TransferTask) {
    await unwrapCommand(commands.retryTransferTask({ task_id: task.id }));
    await queryClient.invalidateQueries({ queryKey: ["transfers", "queue"] });
  }

  function endpointLabel(task: TransferTask) {
    return `${task.source.path} → ${task.destination.path}`;
  }
</script>

<section class="transfers-tooltab" aria-label="Transfers">
  <header>
    <strong>Transfers</strong>
    <span>{visibleTasks.length}</span>
  </header>

  {#if !hasTauriRuntime()}
    <div class="transfer-status" data-testid="transfers-demo-placeholder">No transfers</div>
  {:else if queueQuery.isPending}
    <div class="transfer-status">Loading...</div>
  {:else if visibleTasks.length === 0}
    <div class="transfer-status">No transfers</div>
  {:else}
    <div class="transfer-list">
      {#each visibleTasks as task (task.id)}
        <article class="transfer-row">
          <div>
            <strong>{task.status}</strong>
            <span title={endpointLabel(task)}>{endpointLabel(task)}</span>
          </div>
          <small>{task.bytes_done}{task.bytes_total ? ` / ${task.bytes_total}` : ""}</small>
          <footer>
            <button type="button" disabled={task.status === "completed" || task.status === "canceled"} onclick={() => void cancelTask(task)}>
              Cancel
            </button>
            <button type="button" disabled={task.status !== "failed" && task.status !== "canceled"} onclick={() => void retryTask(task)}>
              Retry
            </button>
          </footer>
        </article>
      {/each}
    </div>
  {/if}
</section>

<style>
  .transfers-tooltab {
    min-width: 0;
    min-height: 0;
    display: grid;
    grid-template-rows: 30px minmax(0, 1fr);
    border-top: 1px solid var(--app-border);
    background: color-mix(in srgb, var(--app-bg) 95%, var(--app-control));
    color: var(--app-fg);
    font-size: 12px;
  }

  header {
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 10px;
    border-bottom: 1px solid var(--app-border);
  }

  .transfer-status {
    display: grid;
    place-items: center;
    color: color-mix(in srgb, var(--app-fg) 58%, transparent);
  }

  .transfer-list {
    min-width: 0;
    overflow: auto;
  }

  .transfer-row {
    min-width: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 10px;
    align-items: center;
    padding: 7px 10px;
    border-bottom: 1px solid color-mix(in srgb, var(--app-border) 65%, transparent);
  }

  .transfer-row div {
    min-width: 0;
    display: grid;
    gap: 2px;
  }

  .transfer-row span,
  .transfer-row small {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: color-mix(in srgb, var(--app-fg) 66%, transparent);
  }

  footer {
    display: flex;
    gap: 6px;
  }

  button {
    min-height: 24px;
    border: 0;
    border-radius: 6px;
    padding: 0 8px;
    color: inherit;
    background: transparent;
    font: inherit;
  }

  button:active:not(:disabled) {
    background: var(--app-active);
  }

  button:disabled {
    color: color-mix(in srgb, var(--app-fg) 30%, transparent);
  }
</style>
