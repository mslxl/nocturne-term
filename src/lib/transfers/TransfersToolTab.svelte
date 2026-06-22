<script lang="ts">
  import { onMount } from "svelte";
  import {
    createTable,
    getCoreRowModel,
    type Cell,
    type ColumnDef,
    type Header,
    type Row,
  } from "@tanstack/table-core";
  import { OverlayScrollbarsComponent } from "overlayscrollbars-svelte";
  import "overlayscrollbars/overlayscrollbars.css";
  import { commands, type TransferTask, type WorkspaceTabState } from "$lib/bindings";
  import { refreshTransferQueue, transferQueueState } from "$lib/transfers/queue.svelte";
  import { hasTauriRuntime } from "$lib/tauri/runtime";
  import { unwrapCommand } from "$lib/terminal/commands";

  type Props = {
    workspace: WorkspaceTabState | null;
    active?: boolean;
  };

  type TransferColumnId = "status" | "source" | "destination" | "progress" | "actions";

  let { workspace, active = true }: Props = $props();
  const queueData = $derived(transferQueueState.snapshot);
  const visibleTasks = $derived(
    (queueData?.tasks ?? []).filter((task) => {
      if (!workspace) return true;
      return task.related_workspace_ids.includes(workspace.id) || task.initiator_workspace_id === workspace.id;
    }),
  );

  const transferColumns: ColumnDef<TransferTask, unknown>[] = [
    {
      id: "status",
      header: "Status",
      accessorFn: (task) => statusLabel(task),
      cell: ({ row }) => statusLabel(row.original),
    },
    {
      id: "source",
      header: "Source",
      accessorFn: (task) => task.source.path,
      cell: ({ row }) => row.original.source.path,
    },
    {
      id: "destination",
      header: "Destination",
      accessorFn: (task) => task.destination.path,
      cell: ({ row }) => row.original.destination.path,
    },
    {
      id: "progress",
      header: "Progress",
      accessorFn: (task) => progressLabel(task),
      cell: ({ row }) => progressLabel(row.original),
    },
    {
      id: "actions",
      header: "Actions",
      cell: () => "",
    },
  ];

  const transferTable = $derived(
    createTable<TransferTask>({
      data: visibleTasks,
      columns: transferColumns,
      getCoreRowModel: getCoreRowModel(),
      getRowId: (task) => task.id,
      state: {
        columnPinning: {
          left: [],
          right: [],
        },
      },
      onStateChange: () => undefined,
      renderFallbackValue: "",
    }),
  );

  const headerGroups = $derived(transferTable.getHeaderGroups());
  const transferRows = $derived(transferTable.getRowModel().rows);
  const overlayOptions = {
    overflow: {
      x: "hidden",
      y: "scroll",
    },
    scrollbars: {
      autoHide: "leave",
      autoHideDelay: 420,
      theme: "os-theme-nocturne",
    },
  } as const;

  onMount(() => {
    void refreshTransferQueue();
  });

  $effect(() => {
    if (!active || !hasTauriRuntime()) return;
    void refreshTransferQueue();
  });

  async function cancelTask(task: TransferTask) {
    await unwrapCommand(commands.cancelTransferTask({ task_id: task.id }));
    await refreshTransferQueue();
  }

  async function retryTask(task: TransferTask) {
    await unwrapCommand(commands.retryTransferTask({ task_id: task.id }));
    await refreshTransferQueue();
  }

  function headerLabel(header: Header<TransferTask, unknown>) {
    return typeof header.column.columnDef.header === "string" ? header.column.columnDef.header : "";
  }

  function cellLabel(cell: Cell<TransferTask, unknown>) {
    const value = cell.getValue();
    return typeof value === "string" || typeof value === "number" ? String(value) : "";
  }

  function columnId(cell: Cell<TransferTask, unknown> | Header<TransferTask, unknown>) {
    return cell.column.id as TransferColumnId;
  }

  function statusLabel(task: TransferTask) {
    return task.status.charAt(0).toUpperCase() + task.status.slice(1);
  }

  function progressLabel(task: TransferTask) {
    if (!task.bytes_total) return task.bytes_done;
    return `${task.bytes_done} / ${task.bytes_total}`;
  }

  function progressPercent(task: TransferTask) {
    if (!task.bytes_total) return 0;
    const done = Number(task.bytes_done);
    const total = Number(task.bytes_total);
    if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return 0;
    return Math.max(0, Math.min(100, (done / total) * 100));
  }

  function rowStatusClass(row: Row<TransferTask>) {
    return `status-${row.original.status}`;
  }
</script>

<section class="transfers-tooltab" aria-label="Transfers">
  <header>
    <strong>Transfers</strong>
    <span>{visibleTasks.length}</span>
  </header>

  {#if !hasTauriRuntime()}
    <div class="transfer-status" data-testid="transfers-demo-placeholder">No transfers</div>
  {:else if transferQueueState.loading && !queueData}
    <div class="transfer-status">Loading...</div>
  {:else if transferQueueState.error}
    <div class="transfer-status error">{transferQueueState.error}</div>
  {:else if visibleTasks.length === 0}
    <div class="transfer-status">No transfers</div>
  {:else}
    <OverlayScrollbarsComponent element="div" class="transfer-table-scroll" options={overlayOptions} defer>
      <table class="transfer-table" data-testid="transfers-table" aria-label="Transfer queue">
        <thead>
          {#each headerGroups as group (group.id)}
            <tr>
              {#each group.headers as header (header.id)}
                <th class={`column-${columnId(header)}`} scope="col">{headerLabel(header)}</th>
              {/each}
            </tr>
          {/each}
        </thead>
        <tbody>
          {#each transferRows as row (row.id)}
            <tr class={rowStatusClass(row)} data-testid="transfer-row" data-transfer-status={row.original.status}>
              {#each row.getVisibleCells() as cell (cell.id)}
                {@const id = columnId(cell)}
                <td class={`column-${id}`}>
                  {#if id === "status"}
                    <span class="status-pill">{statusLabel(row.original)}</span>
                  {:else if id === "source" || id === "destination"}
                    <span class="path-cell" title={cellLabel(cell)}>{cellLabel(cell)}</span>
                  {:else if id === "progress"}
                    <span class="progress-cell">
                      <span class="progress-bar" aria-hidden="true">
                        <span style={`width: ${progressPercent(row.original)}%;`}></span>
                      </span>
                      <span>{progressLabel(row.original)}</span>
                    </span>
                  {:else}
                    <span class="action-cell">
                      <button type="button" disabled={row.original.status === "completed" || row.original.status === "canceled"} onclick={() => void cancelTask(row.original)}>
                        Cancel
                      </button>
                      <button type="button" disabled={row.original.status !== "failed" && row.original.status !== "canceled"} onclick={() => void retryTask(row.original)}>
                        Retry
                      </button>
                    </span>
                  {/if}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </OverlayScrollbarsComponent>
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
    padding: 12px;
    text-align: center;
  }

  .transfer-status.error {
    color: var(--app-danger);
  }

  :global(.transfer-table-scroll) {
    min-width: 0;
    min-height: 0;
  }

  .transfer-table {
    width: 100%;
    min-width: 0;
    border-collapse: collapse;
    table-layout: fixed;
  }

  th,
  td {
    min-width: 0;
    height: 30px;
    padding: 0 8px;
    border-bottom: 1px solid color-mix(in srgb, var(--app-border) 68%, transparent);
    text-align: left;
    vertical-align: middle;
  }

  th {
    position: sticky;
    top: 0;
    z-index: 1;
    height: 28px;
    background: color-mix(in srgb, var(--app-bg) 92%, var(--app-control));
    color: color-mix(in srgb, var(--app-fg) 66%, transparent);
    font-weight: 600;
  }

  tbody tr:nth-child(even) {
    background: color-mix(in srgb, var(--app-control) 22%, transparent);
  }

  tbody tr:hover {
    background: color-mix(in srgb, var(--app-active) 45%, transparent);
  }

  .column-status {
    width: 82px;
  }

  .column-source,
  .column-destination {
    width: 28%;
  }

  .column-progress {
    width: 118px;
  }

  .column-actions {
    width: 112px;
  }

  .status-pill {
    display: inline-flex;
    align-items: center;
    max-width: 100%;
    min-height: 18px;
    border-radius: 999px;
    padding: 0 7px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    background: color-mix(in srgb, var(--app-control) 74%, transparent);
    color: color-mix(in srgb, var(--app-fg) 78%, transparent);
  }

  tr.status-completed .status-pill {
    background: color-mix(in srgb, #3fb950 18%, transparent);
    color: color-mix(in srgb, var(--app-fg) 88%, #3fb950);
  }

  tr.status-failed .status-pill {
    background: color-mix(in srgb, #f85149 18%, transparent);
    color: color-mix(in srgb, var(--app-fg) 88%, #f85149);
  }

  .path-cell {
    display: block;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: color-mix(in srgb, var(--app-fg) 72%, transparent);
  }

  .progress-cell {
    min-width: 0;
    display: grid;
    gap: 3px;
    color: color-mix(in srgb, var(--app-fg) 68%, transparent);
  }

  .progress-bar {
    height: 4px;
    overflow: hidden;
    border-radius: 999px;
    background: color-mix(in srgb, var(--app-border) 70%, transparent);
  }

  .progress-bar span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: color-mix(in srgb, var(--app-accent, var(--app-fg)) 72%, transparent);
  }

  .action-cell {
    display: flex;
    min-width: 0;
    gap: 4px;
    align-items: center;
  }

  button {
    min-width: 0;
    min-height: 22px;
    border: 0;
    border-radius: 5px;
    padding: 0 6px;
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
