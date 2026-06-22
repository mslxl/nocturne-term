<script lang="ts">
  import { ask } from "@tauri-apps/plugin-dialog";
  import { tick } from "svelte";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { OverlayScrollbarsComponent } from "overlayscrollbars-svelte";
  import "overlayscrollbars/overlayscrollbars.css";
  import {
    commands,
    type ConnectionHostEntry,
    type PortForwardPersistence,
    type PortForwardRuleSnapshot_Deserialize,
    type PortForwardSnapshot,
    type WorkspaceToolTab,
  } from "$lib/bindings";
  import {
    addNonLoopbackConfirmation,
    buildRuleInput,
    canDeleteWithoutConfirmation,
    draftFromEditModel,
    editModelFromDraft,
    editModelFromSnapshot,
    editModelsEqual,
    PortForwardEditError,
    type PortForwardEditModel,
    type PortForwardEditValidation,
  } from "$lib/ports/editing";
  import {
    directionLabel,
    formatEndpoint,
    clearPortForwardSort,
    nextPortForwardSorting,
    portForwardColumns,
    setPortForwardSecondarySort,
    setPortForwardSortDirection,
    sortPortForwardRows,
    connectionCellText,
    type PortForwardSortKey,
    type PortForwardSortRule,
    type PortForwardTableRow,
  } from "$lib/ports/table";
  import { hasTauriRuntime } from "$lib/tauri/runtime";
  import { unwrapCommand } from "$lib/terminal/commands";

  type Props = {
    host: ConnectionHostEntry | null;
    toolTab: WorkspaceToolTab;
  };

  let { host, toolTab }: Props = $props();
  const queryClient = useQueryClient();
  let supported = $derived(host?.document.protocol === "ssh");
  let readOnly = $derived(host?.read_only ?? false);
  const snapshotQuery = createQuery(() => ({
    queryKey: portForwardSnapshotQueryKey(host?.id ?? "no-host"),
    enabled: hasTauriRuntime() && !!host,
    queryFn: () => {
      if (!host) throw new Error("Host is required to load port forwards.");
      return unwrapCommand(commands.getPortForwardSnapshot(host.id));
    },
    refetchInterval: 750,
    refetchIntervalInBackground: true,
  }));
  let snapshot = $derived(snapshotQuery.data ?? null);
  let loading = $derived(snapshotQuery.isPending && !snapshot);
  let actionError = $state("");
  let error = $derived(actionError || (!snapshot && snapshotQuery.error ? errorMessage(snapshotQuery.error) : ""));
  let editing = $state<Record<string, PortForwardEditModel>>({});
  let baselines = $state<Record<string, PortForwardEditModel>>({});
  let validation = $state<Record<string, PortForwardEditValidation>>({});
  let openMenuRowId = $state<string | null>(null);
  let openMenuStyle = $state("");
  let openHeaderMenu = $state<string | null>(null);
  let expandedEvents = $state<Record<string, boolean>>({});
  let sorting = $state<PortForwardSortRule[]>([]);
  let rows = $state<PortForwardTableRow[]>([]);
  let draftActive = $state(false);
  let draftNameInput = $state<HTMLInputElement | null>(null);
  let sortedRows = $derived(sortPortForwardRows(rows, sorting));
  let draftModel = $derived(editing.draft ?? editModelFromDraft(snapshot?.draft ?? null));
  let draftChanged = $derived(!editModelsEqual(draftModel, editModelFromDraft(null)));
  let draftIsEditing = $derived(draftActive || draftChanged || !!snapshot?.draft || !!validation.draft);
  const overlayPortsOptions = {
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

  $effect(() => {
    if (!snapshot) {
      rows = [];
      return;
    }
    rows = snapshot.rules.map((item) => tableRowFromSnapshot(item));
  });

  $effect(() => {
    const draft = snapshot?.draft ?? null;
    if (draft && !editing.draft) {
      editing = { ...editing, draft: editModelFromDraft(draft) };
      baselines = { ...baselines, draft: editModelFromDraft(draft) };
    }
  });

  function tableRowFromSnapshot(item: PortForwardRuleSnapshot_Deserialize): PortForwardTableRow {
    return {
      id: item.rule.id,
      name: item.rule.name,
      direction: item.rule.direction,
      local: {
        address: item.rule.local_address,
        port: item.runtime.effective_local_port ?? item.rule.local_port,
      },
      remote: {
        address: item.rule.remote_address,
        port: item.runtime.effective_remote_port ?? item.rule.remote_port,
      },
      status: item.runtime.status,
      activeConnections: item.runtime.active_connections,
      error: item.runtime.error,
      warning: item.runtime.warning,
      persistence: item.runtime.persistence,
      draft: false,
    };
  }

  function snapshotRow(rowId: string): PortForwardRuleSnapshot_Deserialize | null {
    return snapshot?.rules.find((item) => item.rule.id === rowId) ?? null;
  }

  function beginEdit(row: PortForwardRuleSnapshot_Deserialize) {
    const model = editModelFromSnapshot(row);
    editing = { ...editing, [row.rule.id]: model };
    baselines = { ...baselines, [row.rule.id]: model };
    validation = clearRowValidation(validation, row.rule.id);
  }

  function updateEdit(rowId: string, patch: Partial<PortForwardEditModel>) {
    const current = rowId === "draft" ? draftModel : editing[rowId];
    if (!current) return;
    if (rowId === "draft") draftActive = true;
    const next = { ...current, ...patch };
    editing = { ...editing, [rowId]: next };
    void persistDraftIfNeeded(rowId, next);
  }

  async function beginDraftEdit() {
    draftActive = true;
    await tick();
    draftNameInput?.focus();
  }

  async function persistDraftIfNeeded(rowId: string, model: PortForwardEditModel) {
    if (rowId !== "draft" || !host || !hasTauriRuntime()) return;
    try {
      applySnapshot(await unwrapCommand(commands.updatePortForwardDraft({ host_id: host.id, draft: draftFromEditModel(model) })));
      actionError = "";
    } catch (cause) {
      actionError = errorMessage(cause);
    }
  }

  async function saveRow(rowId: string) {
    if (!host) return;
    const model = rowId === "draft" ? draftModel : editing[rowId];
    if (!model) return;
    const existing = rowId === "draft" ? null : snapshotRow(rowId)?.rule ?? null;
    try {
      const input = await ruleInputWithRiskConfirmation(buildRuleInput(host.id, model, existing));
      if (!input) return;
      applySnapshot(await unwrapCommand(commands.createOrUpdatePortForwardRule(input)));
      editing = removeKey(editing, rowId);
      baselines = removeKey(baselines, rowId);
      validation = clearRowValidation(validation, rowId);
      if (rowId === "draft") draftActive = false;
      actionError = "";
    } catch (cause) {
      if (cause instanceof PortForwardEditError) {
        validation = { ...validation, [rowId]: cause.validation };
      } else {
        validation = {
          ...validation,
          [rowId]: { fieldErrors: { name: errorMessage(cause) } },
        };
      }
    }
  }

  async function cancelRow(rowId: string) {
    if (rowId === "draft" && host && hasTauriRuntime()) {
      try {
        applySnapshot(await unwrapCommand(commands.clearPortForwardDraft(host.id)));
      } catch (cause) {
        actionError = errorMessage(cause);
      }
    }
    editing = removeKey(editing, rowId);
    baselines = removeKey(baselines, rowId);
    validation = clearRowValidation(validation, rowId);
    if (rowId === "draft") draftActive = false;
  }

  async function startRow(row: PortForwardTableRow) {
    if (!host) return;
    const source = snapshotRow(row.id);
    if (!source) return;
    try {
      const confirmed = await ensureSavedRiskConfirmation(source);
      if (!confirmed) return;
      applySnapshot(await unwrapCommand(commands.startPortForwardRule({ host_id: host.id, rule_id: row.id })));
      actionError = "";
    } catch (cause) {
      actionError = errorMessage(cause);
    }
  }

  async function stopRow(row: PortForwardTableRow) {
    if (!host) return;
    try {
      applySnapshot(await unwrapCommand(commands.stopPortForwardRule({ host_id: host.id, rule_id: row.id })));
      actionError = "";
    } catch (cause) {
      actionError = errorMessage(cause);
    }
  }

  async function deleteRow(rowId: string) {
    if (!host) return;
    const row = snapshotRow(rowId);
    if (!row) return;
    if (!canDeleteWithoutConfirmation(row)) {
      const confirmed = await ask(`Delete ${row.rule.name || formatEndpoint({ address: row.rule.local_address, port: row.rule.local_port })}? Active connections will be disconnected.`, {
        title: "Delete Port Forward",
        kind: "warning",
      });
      if (!confirmed) return;
    }
    try {
      applySnapshot(await unwrapCommand(commands.deletePortForwardRule({ host_id: host.id, rule_id: rowId })));
      editing = removeKey(editing, rowId);
      actionError = "";
    } catch (cause) {
      actionError = errorMessage(cause);
    } finally {
      openMenuRowId = null;
      openMenuStyle = "";
    }
  }

  async function changePersistence(rowId: string, persistence: PortForwardPersistence) {
    const row = snapshotRow(rowId);
    const model = editing[rowId] ?? (row ? editModelFromSnapshot(row) : null);
    if (!model || !row) return;
    const next = { ...model, persistence };
    try {
      const input = await ruleInputWithRiskConfirmation(buildRuleInput(toolTab.host_id, next, row.rule));
      if (!input) return;
      applySnapshot(await unwrapCommand(commands.createOrUpdatePortForwardRule(input)));
      openMenuRowId = null;
      openMenuStyle = "";
      actionError = "";
    } catch (cause) {
      actionError = errorMessage(cause);
    }
  }

  async function toggleConnectOnHostOpen(rowId: string) {
    const row = snapshotRow(rowId);
    if (!row || row.runtime.persistence !== "saved") return;
    const model = { ...editModelFromSnapshot(row), connectOnHostOpen: !row.rule.connect_on_host_open };
    try {
      const input = await ruleInputWithRiskConfirmation(buildRuleInput(toolTab.host_id, model, row.rule));
      if (!input) return;
      applySnapshot(await unwrapCommand(commands.createOrUpdatePortForwardRule(input)));
      openMenuRowId = null;
      openMenuStyle = "";
      actionError = "";
    } catch (cause) {
      actionError = errorMessage(cause);
    }
  }

  function sortHeader(columnId: string, event: MouseEvent) {
    if (columnId === "actions") return;
    sorting = nextPortForwardSorting(sorting, columnId as PortForwardSortKey, event.shiftKey);
  }

  function sortMenuKey(columnId: string): PortForwardSortKey | null {
    return columnId === "actions" ? null : columnId as PortForwardSortKey;
  }

  function setHeaderSort(columnId: string, command: "asc" | "desc" | "primary" | "secondary" | "clear") {
    const key = sortMenuKey(columnId);
    if (!key) return;
    if (command === "asc") sorting = setPortForwardSortDirection(sorting, key, false);
    if (command === "desc") sorting = setPortForwardSortDirection(sorting, key, true);
    if (command === "primary") sorting = setPortForwardSortDirection(sorting, key, sorting.find((rule) => rule.key === key)?.desc ?? false);
    if (command === "secondary") sorting = setPortForwardSecondarySort(sorting, key);
    if (command === "clear") sorting = clearPortForwardSort(sorting, key);
    openHeaderMenu = null;
  }

  function toggleEvents(rowId: string) {
    expandedEvents = { ...expandedEvents, [rowId]: !expandedEvents[rowId] };
  }

  function toggleMoreMenu(rowId: string, event: MouseEvent) {
    if (openMenuRowId === rowId) {
      openMenuRowId = null;
      openMenuStyle = "";
      return;
    }
    const anchor = event.currentTarget as HTMLElement;
    openMenuStyle = menuStyleForAnchor(anchor.getBoundingClientRect());
    openMenuRowId = rowId;
  }

  function menuStyleForAnchor(rect: DOMRect): string {
    const width = 184;
    const margin = 8;
    const estimatedHeight = 210;
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const opensAbove = spaceBelow < estimatedHeight && rect.top > spaceBelow;
    const left = Math.max(margin, Math.min(window.innerWidth - width - margin, rect.right - width));
    const top = opensAbove
      ? Math.max(margin, rect.top - estimatedHeight - 4)
      : Math.min(window.innerHeight - margin, rect.bottom + 4);
    return `--menu-left: ${left}px; --menu-top: ${top}px;`;
  }

  async function ruleInputWithRiskConfirmation(input: ReturnType<typeof buildRuleInput>) {
    if (!hasTauriRuntime()) return input;
    const risk = await unwrapCommand(commands.checkPortForwardNonLoopbackRisk({ rule: input.rule }));
    if (!risk.requires_confirmation) return input;
    const confirmed = await ask(`Listen on ${risk.listen_address}? This can expose the forwarded port beyond loopback.\n\n${risk.reasons.join("\n")}`, {
      title: "Confirm Port Listen Address",
      kind: "warning",
    });
    if (!confirmed) return null;
    return {
      ...input,
      rule: addNonLoopbackConfirmation(input.rule, String(Date.now())),
    };
  }

  async function ensureSavedRiskConfirmation(row: PortForwardRuleSnapshot_Deserialize): Promise<boolean> {
    if (!host || !hasTauriRuntime()) return true;
    const risk = await unwrapCommand(commands.checkPortForwardNonLoopbackRisk({ rule: row.rule }));
    if (!risk.requires_confirmation) return true;
    const confirmed = await ask(`Listen on ${risk.listen_address}? This can expose the forwarded port beyond loopback.\n\n${risk.reasons.join("\n")}`, {
      title: "Confirm Port Listen Address",
      kind: "warning",
    });
    if (!confirmed) return false;
    applySnapshot(await unwrapCommand(commands.createOrUpdatePortForwardRule({
      host_id: host.id,
      persistence: row.runtime.persistence,
      rule: addNonLoopbackConfirmation(row.rule, String(Date.now())),
    })));
    return true;
  }

  function isChanged(rowId: string): boolean {
    const current = rowId === "draft" ? draftModel : editing[rowId];
    const baseline = rowId === "draft" ? (baselines.draft ?? editModelFromDraft(null)) : baselines[rowId];
    return !!current && !!baseline && !editModelsEqual(current, baseline);
  }

  function removeKey<T>(record: Record<string, T>, key: string): Record<string, T> {
    const next = { ...record };
    delete next[key];
    return next;
  }

  function clearRowValidation(record: Record<string, PortForwardEditValidation>, key: string) {
    return removeKey(record, key);
  }

  function applySnapshot(next: PortForwardSnapshot) {
    queryClient.setQueryData(portForwardSnapshotQueryKey(next.host_id), next);
  }

  function portForwardSnapshotQueryKey(hostId: string): readonly ["port-forwarding", "snapshot", string] {
    return ["port-forwarding", "snapshot", hostId] as const;
  }

  function errorMessage(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
  }
</script>

<section class="ports-tooltab" aria-label={toolTab.title} data-testid="port-forwarding-tooltab" data-supported={supported}>
  {#if supported}
    <OverlayScrollbarsComponent element="div" class="ports-table-shell" options={overlayPortsOptions} defer>
      {#if error}
        <div class="ports-banner">{error}</div>
      {:else if loading}
        <div class="ports-banner">Loading</div>
      {/if}
      <table class="ports-table" data-testid="port-forwarding-table">
        <colgroup>
          <col class="connections-col" />
          <col class="name-col" />
          <col class="endpoint-col" />
          <col class="direction-col" />
          <col class="endpoint-col" />
          <col class="actions-col" />
        </colgroup>
        <thead>
          <tr>
            {#each portForwardColumns as column}
              <th class="header-cell">
                {#if column.id === "direction"}
                  <button type="button" class="direction-header" aria-label="Sort Direction" onclick={(event) => sortHeader(String(column.id), event)}>
                    {#if sorting.findIndex((rule) => rule.key === column.id) >= 0}
                      <span>{sorting.findIndex((rule) => rule.key === column.id) + 1}</span>
                    {/if}
                  </button>
                {:else}
                  <button type="button" onclick={(event) => sortHeader(String(column.id), event)}>
                    {column.header}
                    {#if sorting.findIndex((rule) => rule.key === column.id) >= 0}
                      <span>{sorting.findIndex((rule) => rule.key === column.id) + 1}</span>
                    {/if}
                  </button>
                {/if}
                {#if column.id !== "direction" && column.id !== "actions"}
                  <button type="button" aria-label={`Sort ${column.header}`} onclick={() => openHeaderMenu = openHeaderMenu === column.id ? null : String(column.id)}>...</button>
                  {#if openHeaderMenu === column.id}
                    <div class="header-menu" role="menu">
                      <button type="button" role="menuitem" onclick={() => setHeaderSort(String(column.id), "asc")}>Sort Ascending</button>
                      <button type="button" role="menuitem" onclick={() => setHeaderSort(String(column.id), "desc")}>Sort Descending</button>
                      <button type="button" role="menuitem" onclick={() => setHeaderSort(String(column.id), "primary")}>Set as Primary Sort</button>
                      <button type="button" role="menuitem" onclick={() => setHeaderSort(String(column.id), "secondary")}>Set as Secondary Sort</button>
                      <button type="button" role="menuitem" onclick={() => setHeaderSort(String(column.id), "clear")}>Clear Sort</button>
                    </div>
                  {/if}
                {/if}
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each sortedRows as row (row.id)}
            {@const source = snapshotRow(row.id)}
            {@const model = editing[row.id]}
            <tr data-testid="port-forwarding-row" data-rule-id={row.id} data-status={row.status} data-name={row.name}>
              <td class="connections-cell" data-testid="port-forwarding-connections-cell">
                {#if row.status === "failed" && row.error}
                  <span class="error-overlay">{row.error}</span>
                {:else if row.warning}
                  <span class="warning-overlay">{row.warning}</span>
                {:else if row.status === "running"}
                  {row.activeConnections}
                {:else}
                  {connectionCellText(row)}
                {/if}
              </td>
              {#if model}
                <td>
                  <input value={model.name} aria-label="Port forward name" oninput={(event) => updateEdit(row.id, { name: event.currentTarget.value })} />
                  {#if validation[row.id]?.fieldErrors.name}<span class="cell-error">{validation[row.id].fieldErrors.name}</span>{/if}
                </td>
                <td>
                  <div class="endpoint-edit">
                    <input value={model.localAddress} aria-label="Local address" oninput={(event) => updateEdit(row.id, { localAddress: event.currentTarget.value })} />
                    <input value={model.localPort} aria-label="Local port" inputmode="numeric" oninput={(event) => updateEdit(row.id, { localPort: event.currentTarget.value })} />
                  </div>
                  {#if validation[row.id]?.fieldErrors.localAddress}<span class="cell-error">{validation[row.id].fieldErrors.localAddress}</span>{/if}
                  {#if validation[row.id]?.fieldErrors.localPort}<span class="cell-error">{validation[row.id].fieldErrors.localPort}</span>{/if}
                </td>
                <td class="direction-cell">
                  <button type="button" class="direction-toggle" onclick={() => updateEdit(row.id, { direction: model.direction === "local_to_remote" ? "remote_to_local" : "local_to_remote" })}>
                    {directionLabel(model.direction)}
                  </button>
                </td>
                <td>
                  <div class="endpoint-edit">
                    <input value={model.remoteAddress} aria-label="Remote address" oninput={(event) => updateEdit(row.id, { remoteAddress: event.currentTarget.value })} />
                    <input value={model.remotePort} aria-label="Remote port" inputmode="numeric" oninput={(event) => updateEdit(row.id, { remotePort: event.currentTarget.value })} />
                  </div>
                  {#if validation[row.id]?.fieldErrors.remoteAddress}<span class="cell-error">{validation[row.id].fieldErrors.remoteAddress}</span>{/if}
                  {#if validation[row.id]?.fieldErrors.remotePort}<span class="cell-error">{validation[row.id].fieldErrors.remotePort}</span>{/if}
                </td>
                <td class="actions-cell">
                  <button type="button" disabled={!isChanged(row.id)} onclick={() => void saveRow(row.id)}>Save</button>
                  <button type="button" onclick={() => void cancelRow(row.id)}>Cancel</button>
                </td>
              {:else}
                <td ondblclick={() => source && beginEdit(source)}>{row.name}</td>
                <td ondblclick={() => source && beginEdit(source)}>{formatEndpoint(row.local)}</td>
                <td class="direction-cell">{directionLabel(row.direction)}</td>
                <td ondblclick={() => source && beginEdit(source)}>{formatEndpoint(row.remote)}</td>
                <td class="actions-cell menu-anchor">
                  {#if row.status === "running"}
                    <button type="button" onclick={() => void stopRow(row)}>Stop</button>
                  {:else}
                    <button type="button" onclick={() => void startRow(row)}>Start</button>
                  {/if}
                  <button type="button" aria-label="More port actions" onclick={(event) => toggleMoreMenu(row.id, event)}>...</button>
                  {#if openMenuRowId === row.id && source}
                    <div class="more-menu" role="menu" style={openMenuStyle}>
                      <button type="button" role="menuitem" onclick={() => beginEdit(source)}>Edit</button>
                      <div class="submenu">
                        <button type="button" role="menuitem" aria-haspopup="menu">Persistence</button>
                        <div class="submenu-panel" role="menu">
                          <button type="button" role="menuitemradio" aria-checked={row.persistence === "just_this_time"} onclick={() => void changePersistence(row.id, "just_this_time")}>仅本次</button>
                          <button type="button" role="menuitemradio" aria-checked={row.persistence === "saved"} disabled={readOnly} title={readOnly ? "Saved persistence is unavailable for read-only OpenSSH hosts." : ""} onclick={() => void changePersistence(row.id, "saved")}>Saved</button>
                        </div>
                      </div>
                      <button type="button" role="menuitemcheckbox" aria-checked={source.rule.connect_on_host_open} disabled={row.persistence !== "saved"} title={row.persistence !== "saved" ? "Available only when Persistence is Saved." : ""} onclick={() => void toggleConnectOnHostOpen(row.id)}>Connect on Host Open</button>
                      <button type="button" role="menuitemcheckbox" aria-checked={expandedEvents[row.id]} onclick={() => toggleEvents(row.id)}>Events</button>
                      <button type="button" role="menuitem" class="danger" onclick={() => void deleteRow(row.id)}>Delete</button>
                    </div>
                  {/if}
                </td>
              {/if}
            </tr>
            {#if source && expandedEvents[row.id]}
              <tr class="events-row">
                <td></td>
                <td colspan="5">
                  {#if source.runtime.events.length > 0}
                    <ol>
                      {#each source.runtime.events as event}
                        <li><span>{event.level}</span>{event.message}</li>
                      {/each}
                    </ol>
                  {:else}
                    <span>No events</span>
                  {/if}
                </td>
              </tr>
            {/if}
          {/each}
          <tr class={draftIsEditing ? "draft" : "draft draft-idle"} data-testid="port-forwarding-draft-row">
            {#if draftIsEditing}
              <td></td>
              <td>
                <input bind:this={draftNameInput} value={draftModel.name} aria-label="Draft port forward name" oninput={(event) => updateEdit("draft", { name: event.currentTarget.value })} />
              </td>
              <td>
                <div class="endpoint-edit">
                  <input value={draftModel.localAddress} aria-label="Draft local address" oninput={(event) => updateEdit("draft", { localAddress: event.currentTarget.value })} />
                  <input value={draftModel.localPort} aria-label="Draft local port" inputmode="numeric" oninput={(event) => updateEdit("draft", { localPort: event.currentTarget.value })} />
                </div>
                {#if validation.draft?.fieldErrors.localAddress}<span class="cell-error">{validation.draft.fieldErrors.localAddress}</span>{/if}
                {#if validation.draft?.fieldErrors.localPort}<span class="cell-error">{validation.draft.fieldErrors.localPort}</span>{/if}
              </td>
              <td class="direction-cell">
                <button type="button" class="direction-toggle" onclick={() => updateEdit("draft", { direction: draftModel.direction === "local_to_remote" ? "remote_to_local" : "local_to_remote" })}>
                  {directionLabel(draftModel.direction)}
                </button>
              </td>
              <td>
                <div class="endpoint-edit">
                  <input value={draftModel.remoteAddress} aria-label="Draft remote address" oninput={(event) => updateEdit("draft", { remoteAddress: event.currentTarget.value })} />
                  <input value={draftModel.remotePort} aria-label="Draft remote port" inputmode="numeric" oninput={(event) => updateEdit("draft", { remotePort: event.currentTarget.value })} />
                </div>
                {#if validation.draft?.fieldErrors.remoteAddress}<span class="cell-error">{validation.draft.fieldErrors.remoteAddress}</span>{/if}
                {#if validation.draft?.fieldErrors.remotePort}<span class="cell-error">{validation.draft.fieldErrors.remotePort}</span>{/if}
              </td>
              <td class="actions-cell">
                {#if draftChanged}
                  <button type="button" onclick={() => void saveRow("draft")}>Save</button>
                  <button type="button" onclick={() => void cancelRow("draft")}>Cancel</button>
                {/if}
                <span class="menu-anchor">
                  <button type="button" aria-label="More draft port actions" onclick={(event) => toggleMoreMenu("draft", event)}>...</button>
                  {#if openMenuRowId === "draft"}
                    <div class="more-menu" role="menu" style={openMenuStyle}>
                      <div class="submenu">
                        <button type="button" role="menuitem" aria-haspopup="menu">Persistence</button>
                        <div class="submenu-panel" role="menu">
                          <button type="button" role="menuitemradio" aria-checked={draftModel.persistence === "just_this_time"} onclick={() => updateEdit("draft", { persistence: "just_this_time" })}>仅本次</button>
                          <button type="button" role="menuitemradio" aria-checked={draftModel.persistence === "saved"} disabled={readOnly} title={readOnly ? "Saved persistence is unavailable for read-only OpenSSH hosts." : ""} onclick={() => updateEdit("draft", { persistence: "saved" })}>Saved</button>
                        </div>
                      </div>
                      <button type="button" role="menuitemcheckbox" aria-checked={draftModel.connectOnHostOpen} disabled={draftModel.persistence !== "saved"} title={draftModel.persistence !== "saved" ? "Available only when Persistence is Saved." : ""} onclick={() => updateEdit("draft", { connectOnHostOpen: !draftModel.connectOnHostOpen })}>Connect on Host Open</button>
                    </div>
                  {/if}
                </span>
              </td>
            {:else}
              <td class="draft-seed-cell">
                <button type="button" class="draft-seed-icon" aria-label="Start editing draft port forward" onclick={() => void beginDraftEdit()}>+</button>
              </td>
              <td>
                <button type="button" class="draft-seed draft-seed-name" aria-label="Start editing draft port forward" onclick={() => void beginDraftEdit()}></button>
              </td>
              <td>
                <button type="button" class="draft-seed draft-seed-endpoint" aria-label="Start editing draft local endpoint" onclick={() => void beginDraftEdit()}>
                  {draftModel.localAddress}:{draftModel.localPort}
                </button>
              </td>
              <td class="direction-cell">
                <button type="button" class="draft-seed draft-seed-direction" aria-label="Start editing draft direction" onclick={() => void beginDraftEdit()}>
                  {directionLabel(draftModel.direction)}
                </button>
              </td>
              <td>
                <button type="button" class="draft-seed draft-seed-endpoint" aria-label="Start editing draft remote endpoint" onclick={() => void beginDraftEdit()}>
                  {draftModel.remoteAddress}:{draftModel.remotePort}
                </button>
              </td>
              <td class="actions-cell">
                <span class="menu-anchor">
                  <button type="button" class="draft-seed-more" aria-label="More draft port actions" onclick={(event) => toggleMoreMenu("draft", event)}>...</button>
                  {#if openMenuRowId === "draft"}
                    <div class="more-menu" role="menu" style={openMenuStyle}>
                      <div class="submenu">
                        <button type="button" role="menuitem" aria-haspopup="menu">Persistence</button>
                        <div class="submenu-panel" role="menu">
                          <button type="button" role="menuitemradio" aria-checked={draftModel.persistence === "just_this_time"} onclick={() => updateEdit("draft", { persistence: "just_this_time" })}>仅本次</button>
                          <button type="button" role="menuitemradio" aria-checked={draftModel.persistence === "saved"} disabled={readOnly} title={readOnly ? "Saved persistence is unavailable for read-only OpenSSH hosts." : ""} onclick={() => updateEdit("draft", { persistence: "saved" })}>Saved</button>
                        </div>
                      </div>
                      <button type="button" role="menuitemcheckbox" aria-checked={draftModel.connectOnHostOpen} disabled={draftModel.persistence !== "saved"} title={draftModel.persistence !== "saved" ? "Available only when Persistence is Saved." : ""} onclick={() => updateEdit("draft", { connectOnHostOpen: !draftModel.connectOnHostOpen })}>Connect on Host Open</button>
                    </div>
                  {/if}
                </span>
              </td>
            {/if}
          </tr>
        </tbody>
      </table>
    </OverlayScrollbarsComponent>
  {:else}
    <div class="ports-empty unsupported" data-testid="port-forwarding-unsupported">
      <strong>Ports unavailable</strong>
      <span>Port forwarding is supported for SSH hosts.</span>
    </div>
  {/if}
</section>

<style>
  .ports-tooltab {
    min-width: 0;
    min-height: 0;
    height: 100%;
    display: grid;
    grid-template-rows: minmax(0, 1fr);
    overflow: hidden;
    background: color-mix(in srgb, var(--app-bg) 96%, var(--app-control));
  }

  .ports-empty {
    min-width: 0;
    min-height: 0;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 5px;
    padding: 16px;
    color: color-mix(in srgb, var(--app-fg) 58%, transparent);
    font-size: 12px;
    text-align: center;
  }

  :global(.ports-table-shell) {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .ports-table {
    width: 100%;
    min-width: 0;
    table-layout: fixed;
    border-collapse: collapse;
    font-size: 12px;
  }

  .connections-col {
    width: clamp(58px, 15%, 94px);
  }

  .name-col {
    width: clamp(54px, 17%, 118px);
  }

  .endpoint-col {
    width: auto;
  }

  .direction-col {
    width: 38px;
  }

  .actions-col {
    width: clamp(78px, 19%, 116px);
  }

  .ports-banner {
    min-height: 28px;
    display: flex;
    align-items: center;
    padding: 0 8px;
    border-bottom: 1px solid color-mix(in srgb, var(--app-fg) 10%, transparent);
    color: color-mix(in srgb, var(--app-fg) 62%, transparent);
    font-size: 12px;
  }

  .ports-table th,
  .ports-table td {
    height: 30px;
    border-bottom: 1px solid color-mix(in srgb, var(--app-fg) 10%, transparent);
    padding: 0 8px;
    text-align: left;
    white-space: nowrap;
    vertical-align: middle;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ports-table th {
    color: color-mix(in srgb, var(--app-fg) 62%, transparent);
    font-weight: 600;
    user-select: none;
    -webkit-user-select: none;
  }

  .ports-table th button,
  .actions-cell button,
  .direction-toggle,
  .header-menu button,
  .more-menu button {
    height: 24px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: inherit;
    font: inherit;
  }

  .ports-table th button {
    font-weight: inherit;
    color: inherit;
  }

  .ports-table th button.direction-header {
    width: 100%;
    padding: 0;
  }

  .ports-table th span {
    margin-left: 4px;
    color: var(--app-accent);
  }

  .ports-table th.header-cell {
    position: relative;
    overflow: visible;
  }

  .header-menu {
    position: absolute;
    z-index: 5;
    top: 26px;
    left: 8px;
    min-width: 172px;
    display: grid;
    gap: 2px;
    padding: 6px;
    border: 1px solid color-mix(in srgb, var(--app-fg) 12%, transparent);
    border-radius: 6px;
    background: var(--app-bg);
    box-shadow: 0 8px 24px color-mix(in srgb, black 20%, transparent);
  }

  .header-menu button {
    width: 100%;
    text-align: left;
    padding: 0 8px;
  }

  .ports-table td.connections-cell {
    position: relative;
    overflow: visible;
  }

  .error-overlay {
    position: absolute;
    inset: 3px 5px;
    display: flex;
    align-items: center;
    overflow: hidden;
    border-radius: 4px;
    padding: 0 6px;
    background: color-mix(in srgb, var(--app-danger) 16%, var(--app-bg));
    color: var(--app-danger);
    text-overflow: ellipsis;
  }

  .warning-overlay {
    position: absolute;
    inset: 3px 5px;
    display: flex;
    align-items: center;
    overflow: hidden;
    border-radius: 4px;
    padding: 0 6px;
    background: color-mix(in srgb, var(--app-warning-fg, #b56a00) 18%, var(--app-bg));
    color: var(--app-warning-fg, #b56a00);
    text-overflow: ellipsis;
  }

  .direction-cell {
    overflow: visible;
    text-align: center;
    font-family: ui-monospace, "SF Mono", Consolas, monospace;
  }

  .endpoint-edit {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(42px, 54px);
    gap: 4px;
    align-items: center;
  }

  input {
    width: 100%;
    min-width: 0;
    height: 23px;
    border: 1px solid color-mix(in srgb, var(--app-fg) 14%, transparent);
    border-radius: 5px;
    padding: 0 6px;
    background: color-mix(in srgb, var(--app-bg) 90%, var(--app-control));
    color: var(--app-fg);
    font: inherit;
  }

  .cell-error {
    display: block;
    max-width: 190px;
    overflow: hidden;
    color: var(--app-danger);
    text-overflow: ellipsis;
  }

  .ports-table td.actions-cell {
    position: relative;
    overflow: visible;
    z-index: 2;
  }

  .ports-table td.actions-cell.menu-anchor {
    z-index: 6;
  }

  .actions-cell button {
    min-width: 0;
    max-width: 100%;
    margin-right: 4px;
    padding: 0 6px;
  }

  .actions-cell button:disabled {
    opacity: 0.45;
  }

  .actions-cell button:active,
  .direction-toggle:active,
  .more-menu button:active {
    background: var(--app-active);
  }

  .menu-anchor {
    position: relative;
  }

  .more-menu {
    position: fixed;
    z-index: 80;
    top: var(--menu-top);
    left: var(--menu-left);
    min-width: 184px;
    display: grid;
    gap: 2px;
    padding: 6px;
    border: 1px solid color-mix(in srgb, var(--app-fg) 12%, transparent);
    border-radius: 6px;
    background: var(--app-bg);
    box-shadow: 0 8px 24px color-mix(in srgb, black 20%, transparent);
  }

  .more-menu button {
    width: 100%;
    text-align: left;
    padding: 0 8px;
  }

  .more-menu button[aria-checked="true"]::before {
    content: "✓ ";
  }

  .submenu {
    position: relative;
  }

  .submenu-panel {
    position: absolute;
    top: -6px;
    right: calc(100% + 6px);
    min-width: 132px;
    display: none;
    gap: 2px;
    padding: 6px;
    border: 1px solid color-mix(in srgb, var(--app-fg) 12%, transparent);
    border-radius: 6px;
    background: var(--app-bg);
    box-shadow: 0 8px 24px color-mix(in srgb, black 20%, transparent);
  }

  .submenu:hover .submenu-panel,
  .submenu:focus-within .submenu-panel {
    display: grid;
  }

  .danger {
    color: var(--app-danger);
  }

  .ports-table tr.draft {
    color: color-mix(in srgb, var(--app-fg) 66%, transparent);
  }

  .ports-table tr.draft-idle td {
    height: 32px;
    background: color-mix(in srgb, var(--app-control) 13%, transparent);
    border-bottom-color: color-mix(in srgb, var(--app-fg) 8%, transparent);
  }

  .draft-seed-cell {
    text-align: center;
  }

  .draft-seed,
  .draft-seed-icon,
  .draft-seed-more {
    height: 23px;
    min-width: 0;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: color-mix(in srgb, var(--app-fg) 42%, transparent);
    font: inherit;
  }

  .draft-seed {
    width: 100%;
    display: block;
    overflow: hidden;
    padding: 0;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .draft-seed-icon {
    width: 23px;
    padding: 0;
    color: color-mix(in srgb, var(--app-accent) 72%, var(--app-fg));
    font-size: 15px;
    line-height: 21px;
  }

  .draft-seed-name::before {
    content: "";
    display: block;
    width: min(72px, 82%);
    height: 1px;
    margin-top: 11px;
    border-top: 1px dashed color-mix(in srgb, var(--app-fg) 22%, transparent);
  }

  .draft-seed-endpoint,
  .draft-seed-direction {
    color: color-mix(in srgb, var(--app-fg) 36%, transparent);
  }

  .draft-seed-direction {
    text-align: center;
    font-family: ui-monospace, "SF Mono", Consolas, monospace;
  }

  .draft-seed-more {
    width: 24px;
    padding: 0;
    opacity: 0.58;
  }

  .draft-idle:focus-within td,
  .draft-idle:hover td {
    background: color-mix(in srgb, var(--app-control) 20%, transparent);
  }

  .draft-seed:focus-visible,
  .draft-seed-icon:focus-visible,
  .draft-seed-more:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--app-accent) 68%, transparent);
    outline-offset: -2px;
  }

  .events-row td {
    height: auto;
    padding-block: 6px;
    color: color-mix(in srgb, var(--app-fg) 58%, transparent);
    background: color-mix(in srgb, var(--app-control) 20%, transparent);
  }

  .events-row ol {
    display: grid;
    gap: 3px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .events-row li {
    display: flex;
    gap: 8px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .events-row li span {
    width: 42px;
    flex: 0 0 auto;
    color: color-mix(in srgb, var(--app-fg) 46%, transparent);
  }

  .ports-empty strong,
  .ports-empty span {
    min-width: 0;
    overflow-wrap: anywhere;
  }
</style>
