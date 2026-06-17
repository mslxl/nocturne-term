<script lang="ts">
  import { onMount } from "svelte";
  import { OverlayScrollbarsComponent } from "overlayscrollbars-svelte";
  import {
    commands,
    type ConnectionHostDocument,
    type ConnectionHostEntry,
    type ResourceRemoteProviderMode,
    type WorkspaceToolTab,
  } from "$lib/bindings";
  import {
    buildResourceMonitorViewModel,
    type ResourceMetricRow,
  } from "$lib/resources/view-model";
  import type { ResourceMetricId, ResourceMonitorState } from "$lib/resources/store";
  import { defaultResourceMetricOrder, reorderResourceMetricOrder } from "$lib/resources/metric-order";
  import {
    beginResourceMonitorProviderSwitch,
    endResourceMonitorProviderSwitch,
    registerResourceMonitorView,
    resourceMonitorHistoryForView,
    resourceMonitorStateForOwner,
    tickResourceMonitorView,
    unregisterResourceMonitorView,
  } from "$lib/resources/runtime";
  import { unwrapCommand } from "$lib/terminal/commands";
  import Activity from "~icons/lucide/activity";
  import ChevronRight from "~icons/lucide/chevron-right";
  import Cpu from "~icons/lucide/cpu";
  import Database from "~icons/lucide/database";
  import HardDrive from "~icons/lucide/hard-drive";
  import MemoryStick from "~icons/lucide/memory-stick";
  import MonitorCog from "~icons/lucide/monitor-cog";

  type Props = {
    toolTab: WorkspaceToolTab;
    workspaceId: string;
    viewId: string;
  };

  type MetricPointerDrag = {
    metric: ResourceMetricId;
    pointerId: number;
    startX: number;
    startY: number;
    target: HTMLElement;
    active: boolean;
    hoverMetric: ResourceMetricId | null;
  };

  type SuppressedMetricClick = {
    metric: ResourceMetricId;
    until: number;
  };

  let { toolTab, workspaceId, viewId }: Props = $props();

  const overlayResourceOptions = {
    overflow: {
      x: "hidden",
      y: "scroll",
    },
    scrollbars: {
      autoHide: "scroll",
    },
  } as const;

  let monitorState = $state<ResourceMonitorState | null>(null);
  let metricOrder = $state<ResourceMetricId[]>([...defaultResourceMetricOrder]);
  let expandedGroups = $state<Set<ResourceMetricId>>(new Set());
  let pointerDrag = $state<MetricPointerDrag | null>(null);
  let suppressedMetricClick = $state<SuppressedMetricClick | null>(null);
  let stopPointerDragListeners: (() => void) | null = null;
  let hostEntry = $state<ConnectionHostEntry | null>(null);
  let remoteProviderMode = $state<ResourceRemoteProviderMode>("auto");
  let providerModeSaving = $state(false);
  let providerModeLoading = $state(false);
  let providerModeError = $state("");

  const LOCAL_HOST_ID = "00000000-0000-0000-0000-000000000001";

  const canEditRemoteProvider = $derived(
    !!hostEntry && hostEntry.document.protocol === "ssh" && !hostEntry.read_only,
  );
  const showRemoteProviderControl = $derived(hostEntry?.document.protocol === "ssh");

  const model = $derived(
    buildResourceMonitorViewModel({
      snapshot: monitorState?.latest ?? null,
      historyForMetric: (metric) => resourceMonitorHistoryForView(viewId, metric),
      metricOrder,
      expandedMetrics: expandedGroups,
      stale: monitorState?.stale ?? false,
      warning: monitorState?.warning ?? null,
    }),
  );

  onMount(() => {
    let disposed = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const refreshState = () => {
      monitorState = resourceMonitorStateForOwner(toolTab.id);
    };
    const tickView = async () => {
      await tickResourceMonitorView(viewId);
      if (!disposed) {
        refreshState();
      }
    };

    monitorState = registerResourceMonitorView({
      viewId,
      workspaceId,
      ownerToolTabId: toolTab.id,
      visible: true,
    });
    void tickView();
    void refreshHostProviderMode();
    intervalId = setInterval(() => {
      void tickView();
    }, 2000);

    return () => {
      disposed = true;
      if (intervalId) {
        clearInterval(intervalId);
      }
      cancelMetricPointerDrag();
      unregisterResourceMonitorView(viewId);
    };
  });

  async function refreshHostProviderMode() {
    if (toolTab.host_id === LOCAL_HOST_ID) {
      hostEntry = null;
      remoteProviderMode = "auto";
      providerModeError = "";
      return;
    }
    try {
      hostEntry = await unwrapCommand(commands.readConnectionHost(toolTab.host_id));
      remoteProviderMode = hostEntry.document.resources?.remote_provider ?? "auto";
      providerModeError = "";
    } catch (error) {
      providerModeError = error instanceof Error ? error.message : String(error);
    }
  }

  async function updateRemoteProviderMode(value: ResourceRemoteProviderMode) {
    if (!hostEntry || !canEditRemoteProvider) {
      return;
    }
    providerModeSaving = true;
    providerModeLoading = true;
    providerModeError = "";
    remoteProviderMode = value;
    monitorState = beginResourceMonitorProviderSwitch(toolTab.id);
    try {
      const document = cloneHostDocument(hostEntry.document);
      document.resources = {
        target_os: document.resources?.target_os ?? null,
        target_arch: document.resources?.target_arch ?? null,
        remote_provider: value,
      };
      hostEntry = await unwrapCommand(commands.updateConnectionHost({
        id: hostEntry.id,
        directory: null,
        folder: document.folder,
        document,
      }));
      remoteProviderMode = hostEntry.document.resources?.remote_provider ?? "auto";
      monitorState = endResourceMonitorProviderSwitch(toolTab.id);
      await tickResourceMonitorView(viewId);
      monitorState = resourceMonitorStateForOwner(toolTab.id);
    } catch (error) {
      providerModeError = error instanceof Error ? error.message : String(error);
      remoteProviderMode = hostEntry.document.resources?.remote_provider ?? "auto";
      monitorState = endResourceMonitorProviderSwitch(toolTab.id);
    } finally {
      providerModeSaving = false;
      providerModeLoading = false;
    }
  }

  function clickMetricRow(row: ResourceMetricRow) {
    if (suppressedMetricClick && suppressedMetricClick.metric === row.metric && performance.now() < suppressedMetricClick.until) {
      suppressedMetricClick = null;
      return;
    }
    suppressedMetricClick = null;
    toggleGroup(row);
  }

  function toggleGroup(row: ResourceMetricRow) {
    if (!row.collapsible) {
      return;
    }
    const next = new Set(expandedGroups);
    if (next.has(row.metric)) {
      next.delete(row.metric);
    } else {
      next.add(row.metric);
    }
    expandedGroups = next;
  }

  function startMetricPointerDrag(metric: ResourceMetricId, event: PointerEvent) {
    if (event.button !== 0) {
      return;
    }
    if ((event.target as Element | null)?.closest("button")) {
      return;
    }
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    pointerDrag = {
      metric,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      target,
      active: false,
      hoverMetric: null,
    };
    target.setPointerCapture(event.pointerId);
    startPointerDragListeners();
  }

  function moveMetricPointerDrag(event: PointerEvent) {
    const drag = pointerDrag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.active && distance >= 4) {
      drag.active = true;
    }
    if (!drag.active) {
      return;
    }
    event.preventDefault();
    const targetMetric = metricAtPoint(event.clientX, event.clientY);
    pointerDrag = {
      ...drag,
      hoverMetric: targetMetric && targetMetric !== drag.metric ? targetMetric : null,
    };
  }

  function dropMetricPointer(event: PointerEvent) {
    const drag = pointerDrag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    if (drag.target.hasPointerCapture(event.pointerId)) {
      drag.target.releasePointerCapture(event.pointerId);
    }
    stopPointerDragListeners?.();
    stopPointerDragListeners = null;
    pointerDrag = null;
    if (!drag.active) {
      return;
    }
    event.preventDefault();
    const targetMetric = drag.hoverMetric ?? metricAtPoint(event.clientX, event.clientY);
    suppressedMetricClick = { metric: drag.metric, until: performance.now() + 350 };
    reorderMetric(drag.metric, targetMetric);
  }

  function cancelMetricPointerDrag(event?: PointerEvent) {
    const drag = pointerDrag;
    if (drag && event && drag.pointerId === event.pointerId && drag.target.hasPointerCapture(event.pointerId)) {
      drag.target.releasePointerCapture(event.pointerId);
    }
    stopPointerDragListeners?.();
    stopPointerDragListeners = null;
    pointerDrag = null;
  }

  function cancelMetricPointerDragOnBlur() {
    cancelMetricPointerDrag();
  }

  function startPointerDragListeners() {
    stopPointerDragListeners?.();
    window.addEventListener("pointermove", moveMetricPointerDrag, { capture: true });
    window.addEventListener("pointerup", dropMetricPointer, { capture: true });
    window.addEventListener("pointercancel", cancelMetricPointerDrag, { capture: true });
    document.addEventListener("pointermove", moveMetricPointerDrag, { capture: true });
    document.addEventListener("pointerup", dropMetricPointer, { capture: true });
    document.addEventListener("pointercancel", cancelMetricPointerDrag, { capture: true });
    window.addEventListener("blur", cancelMetricPointerDragOnBlur);
    stopPointerDragListeners = () => {
      window.removeEventListener("pointermove", moveMetricPointerDrag, { capture: true });
      window.removeEventListener("pointerup", dropMetricPointer, { capture: true });
      window.removeEventListener("pointercancel", cancelMetricPointerDrag, { capture: true });
      document.removeEventListener("pointermove", moveMetricPointerDrag, { capture: true });
      document.removeEventListener("pointerup", dropMetricPointer, { capture: true });
      document.removeEventListener("pointercancel", cancelMetricPointerDrag, { capture: true });
      window.removeEventListener("blur", cancelMetricPointerDragOnBlur);
    };
  }

  function reorderMetric(dragged: ResourceMetricId | null, target: ResourceMetricId | null) {
    if (!dragged || !target) {
      return;
    }
    metricOrder = reorderResourceMetricOrder(metricOrder, dragged, target);
  }

  function isResourceMetricId(value: string): value is ResourceMetricId {
    return value === "cpu" || value === "memory" || value === "swap" || value === "gpu" || value === "disk";
  }

  function metricAtPoint(clientX: number, clientY: number): ResourceMetricId | null {
    const element = document.elementFromPoint(clientX, clientY);
    const row = element?.closest<HTMLElement>('[data-testid="resource-monitor-row"]');
    const metric = row?.dataset.metric ?? "";
    return isResourceMetricId(metric) ? metric : null;
  }

  function historyPolyline(points: number[]): string {
    if (points.length === 0) {
      return "";
    }
    if (points.length === 1) {
      const y = 30 - (points[0] / 100) * 28;
      return `0,${y.toFixed(2)} 100,${y.toFixed(2)}`;
    }
    const step = 100 / (points.length - 1);
    return points
      .map((point, index) => {
        const x = index * step;
        const y = 30 - (point / 100) * 28;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  }

  function cloneHostDocument(document: ConnectionHostDocument): ConnectionHostDocument {
    return {
      version: document.version,
      id: document.id,
      name: document.name,
      folder: document.folder,
      icon: document.icon ? { ...document.icon } : null,
      files: document.files ? { ...document.files } : null,
      resources: document.resources ? { ...document.resources } : null,
      protocol: document.protocol,
      local: document.local ? { ...document.local } : null,
      ssh: document.ssh ? { ...document.ssh } : null,
      telnet: document.telnet ? { ...document.telnet } : null,
    };
  }
</script>

<section class="resource-monitor-tooltab" class:provider-loading={providerModeLoading} aria-label="Resource Monitor" data-testid="resource-monitor-tooltab">
  <header class="resource-monitor-header">
    <div class="resource-monitor-title">
      <Activity aria-hidden="true" />
      <strong>{toolTab.title}</strong>
    </div>
    <div class="resource-monitor-provider-row" data-testid="resource-monitor-provider-row">
      {#if showRemoteProviderControl}
        <label class="resource-monitor-provider-mode" title={canEditRemoteProvider ? "Remote resource provider for this Host" : "Remote provider is editable only on Nocturne user hosts"}>
          <span class="sr-only">Remote resource provider</span>
          <select
            aria-label="Remote resource provider"
            data-testid="resource-monitor-provider-mode"
            value={remoteProviderMode}
            disabled={!canEditRemoteProvider || providerModeSaving}
            onchange={(event) => updateRemoteProviderMode(event.currentTarget.value as ResourceRemoteProviderMode)}
          >
            <option value="auto">Auto</option>
            <option value="agent">Agent</option>
            <option value="system_commands">Commands</option>
          </select>
        </label>
      {/if}
    </div>
  </header>

  {#if providerModeError}
    <div class="resource-monitor-warning" role="status">{providerModeError}</div>
  {:else if model.warning}
    <div class="resource-monitor-warning" role="status">{model.warning}</div>
  {/if}

  <OverlayScrollbarsComponent element="div" class="resource-monitor-body" role="list" options={overlayResourceOptions} defer>
    {#if providerModeLoading}
      <div class="resource-monitor-loading" data-testid="resource-monitor-loading" role="status" aria-label="Loading resource metrics"></div>
    {:else}
      {#each model.rows as row (row.id)}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions (Metric rows use pointer drag sorting; row clicks are ignored after a drag so sorting does not trigger another action.) -->
      <section
        class="resource-monitor-row"
        data-testid="resource-monitor-row"
        data-metric={row.metric}
        role="listitem"
        onpointerdown={(event) => startMetricPointerDrag(row.metric, event)}
        onpointermove={moveMetricPointerDrag}
        onpointerup={dropMetricPointer}
        onpointercancel={cancelMetricPointerDrag}
        onclick={() => clickMetricRow(row)}
        class:pointer-drag-source={pointerDrag?.metric === row.metric}
        class:pointer-drop-target={pointerDrag?.hoverMetric === row.metric}
      >
        <div class="resource-monitor-row-main">
          {#if row.collapsible}
            <button
              class="resource-monitor-detail-toggle"
              class:expanded={row.expanded}
              data-testid="resource-monitor-detail-toggle"
              aria-label={`${row.expanded ? "Collapse" : "Expand"} ${row.label}`}
              aria-expanded={row.expanded}
              onclick={(event) => {
                event.stopPropagation();
                toggleGroup(row);
              }}
            >
              <ChevronRight aria-hidden="true" />
            </button>
          {:else}
            <span class="resource-monitor-detail-spacer" aria-hidden="true"></span>
          {/if}

          <div class="resource-monitor-metric-icon" aria-hidden="true">
            {#if row.metric === "cpu"}
              <Cpu />
            {:else if row.metric === "memory"}
              <MemoryStick />
            {:else if row.metric === "swap"}
              <HardDrive />
            {:else if row.metric === "gpu"}
              <MonitorCog />
            {:else}
              <Database />
            {/if}
          </div>

          <div class="resource-monitor-metric-text">
            <div class="resource-monitor-metric-line">
              <span class="resource-monitor-label">{row.label}</span>
              <span class:unavailable={row.status === "unavailable"} class="resource-monitor-primary">{row.primary}</span>
            </div>
            {#if row.auxiliary}
              <div class="resource-monitor-auxiliary">{row.auxiliary}</div>
            {/if}
            {#if row.reason}
              <div class="resource-monitor-reason">{row.reason}</div>
            {/if}
            {#if row.progressPercent !== undefined}
              <div class="resource-monitor-progress" aria-hidden="true">
                <span style={`width: ${Math.max(0, Math.min(100, row.progressPercent))}%`}></span>
              </div>
            {/if}
          </div>

        </div>

        {#if row.history}
          <div class="resource-monitor-history" data-testid="resource-monitor-history">
            <svg viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">
              {#if row.history.points.length > 0}
                <polyline points={historyPolyline(row.history.points)} />
              {/if}
            </svg>
          </div>
        {/if}

        {#if row.expanded && row.children.length > 0}
          <div class="resource-monitor-children">
            {#each row.children as child}
              <div class="resource-monitor-child-row">
                <div class="resource-monitor-child-summary">
                  <span>{child.label}</span>
                  <span>{child.primary}</span>
                  {#if child.auxiliary}
                    <small>{child.auxiliary}</small>
                  {/if}
                  {#if child.progressPercent !== undefined}
                    <div class="resource-monitor-progress child" aria-hidden="true">
                      <span style={`width: ${Math.max(0, Math.min(100, child.progressPercent))}%`}></span>
                    </div>
                  {/if}
                </div>
                {#if child.history}
                  <div class="resource-monitor-child-history" data-testid="resource-monitor-child-history">
                    <svg viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
                      {#if child.history.points.length > 0}
                        <polyline points={historyPolyline(child.history.points)} />
                      {/if}
                    </svg>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}

      </section>
      {/each}
    {/if}
  </OverlayScrollbarsComponent>
</section>

<style>
  .resource-monitor-tooltab {
    min-width: 0;
    min-height: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--app-bg);
    color: var(--app-fg);
    font-size: 12px;
  }

  .resource-monitor-header {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 7px 9px;
    border-bottom: 1px solid var(--app-border);
  }

  .resource-monitor-title,
  .resource-monitor-provider-row,
  .resource-monitor-metric-line,
  .resource-monitor-child-row {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .resource-monitor-title :global(svg),
  .resource-monitor-metric-icon :global(svg),
  .resource-monitor-detail-toggle :global(svg) {
    width: 13px;
    height: 13px;
    flex: 0 0 auto;
  }

  .resource-monitor-title strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .resource-monitor-provider-row {
    display: flex;
    flex-wrap: wrap;
    justify-content: normal;
    align-items: center;
    gap: 5px;
    color: var(--app-muted);
    line-height: 1.35;
  }

  .resource-monitor-provider-row span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .resource-monitor-provider-mode {
    flex: 0 0 auto;
    min-width: 0;
    display: inline-flex;
    align-items: center;
  }

  .resource-monitor-provider-mode select {
    width: auto;
    max-width: 104px;
    min-height: 22px;
    border: 1px solid var(--app-border);
    border-radius: 5px;
    padding: 1px 20px 1px 6px;
    background: var(--app-bg);
    color: var(--app-fg);
    font: inherit;
    font-size: 11px;
  }

  .resource-monitor-provider-mode select:disabled {
    color: color-mix(in srgb, var(--app-muted) 70%, transparent);
    background: color-mix(in srgb, var(--app-bg) 86%, var(--app-fg));
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }

  .resource-monitor-warning {
    color: var(--app-warning-fg, #b56a00);
  }

  .resource-monitor-warning {
    padding: 6px 9px;
    border-bottom: 1px solid var(--app-border);
    line-height: 1.35;
  }

  :global(.resource-monitor-body) {
    min-width: 0;
    min-height: 0;
    flex: 1 1 auto;
    overflow-x: hidden;
    overflow-y: hidden;
    padding: 4px 0;
  }

  .resource-monitor-row {
    min-width: 0;
    border-bottom: 1px solid color-mix(in srgb, var(--app-border) 70%, transparent);
    user-select: none;
    touch-action: none;
  }

  .resource-monitor-row.pointer-drag-source {
    opacity: 0.72;
  }

  .resource-monitor-row.pointer-drop-target {
    box-shadow: inset 0 2px 0 var(--app-accent, #4f8cff);
    background: color-mix(in srgb, var(--app-accent, #4f8cff) 8%, transparent);
  }

  .resource-monitor-loading {
    min-height: 42px;
    padding: 6px 9px;
    position: relative;
    overflow: hidden;
  }

  .resource-monitor-loading::before {
    content: "";
    position: absolute;
    left: 9px;
    right: 9px;
    top: 16px;
    height: 3px;
    border-radius: 999px;
    background:
      linear-gradient(
        90deg,
        transparent 0%,
        color-mix(in srgb, var(--app-accent, #4f8cff) 58%, transparent) 45%,
        transparent 100%
      ),
      color-mix(in srgb, var(--app-muted) 18%, transparent);
    animation: resource-monitor-loading-pulse 900ms ease-in-out infinite;
  }

  @keyframes resource-monitor-loading-pulse {
    0% {
      opacity: 0.42;
      transform: translateX(-16%);
    }

    50% {
      opacity: 1;
      transform: translateX(0);
    }

    100% {
      opacity: 0.42;
      transform: translateX(16%);
    }
  }

  .resource-monitor-row-main {
    min-width: 0;
    display: grid;
    grid-template-columns: 18px 16px minmax(0, 1fr);
    align-items: start;
    gap: 4px;
    padding: 6px 5px 6px 2px;
  }

  .resource-monitor-detail-toggle {
    width: 18px;
    height: 20px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 4px;
    padding: 0;
    background: transparent;
    color: var(--app-muted);
  }

  .resource-monitor-detail-spacer {
    width: 18px;
    height: 20px;
  }

  .resource-monitor-detail-toggle:hover {
    background: var(--app-hover-bg);
    color: var(--app-fg);
  }

  .resource-monitor-detail-toggle.expanded :global(svg) {
    transform: rotate(90deg);
  }

  .resource-monitor-metric-icon {
    width: 16px;
    height: 20px;
    display: grid;
    place-items: center;
    color: var(--app-muted);
  }

  .resource-monitor-metric-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .resource-monitor-metric-line {
    justify-content: flex-start;
    gap: 8px;
  }

  .resource-monitor-label,
  .resource-monitor-primary {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .resource-monitor-label {
    font-weight: 600;
  }

  .resource-monitor-primary {
    flex: 0 1 auto;
    color: var(--app-fg);
    text-align: left;
  }

  .resource-monitor-primary.unavailable,
  .resource-monitor-reason,
  .resource-monitor-auxiliary,
  .resource-monitor-auxiliary {
    color: var(--app-muted);
  }

  .resource-monitor-auxiliary,
  .resource-monitor-reason {
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .resource-monitor-progress {
    width: 100%;
    height: 4px;
    margin-top: 5px;
    overflow: hidden;
    border-radius: 999px;
    background: color-mix(in srgb, var(--app-muted) 18%, transparent);
  }

  .resource-monitor-progress.child {
    flex: 0 0 100%;
    margin-top: 2px;
  }

  .resource-monitor-progress span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: color-mix(in srgb, var(--app-accent, #4f8cff) 72%, transparent);
  }

  .resource-monitor-history {
    min-width: 0;
    display: block;
    padding: 0 5px 8px 22px;
    color: var(--app-muted);
    line-height: 1.35;
  }

  .resource-monitor-history svg {
    width: 100%;
    display: block;
    border: 1px solid color-mix(in srgb, var(--app-border) 82%, transparent);
    border-radius: 3px;
    background: color-mix(in srgb, var(--app-bg) 94%, var(--app-fg));
  }

  .resource-monitor-history svg {
    height: 32px;
  }

  .resource-monitor-history polyline {
    fill: none;
    stroke: var(--app-accent, #4f8cff);
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }

  .resource-monitor-children {
    min-width: 0;
    padding: 0 5px 8px 22px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .resource-monitor-child-row {
    align-items: stretch;
    flex-direction: column;
    gap: 3px;
  }

  .resource-monitor-child-summary {
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    line-height: 1.35;
  }

  .resource-monitor-child-summary span,
  .resource-monitor-child-summary small {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .resource-monitor-child-summary small {
    color: var(--app-muted);
  }

  .resource-monitor-child-history {
    min-width: 0;
  }

  .resource-monitor-child-history svg {
    width: 100%;
    height: 24px;
    display: block;
    border: 1px solid color-mix(in srgb, var(--app-border) 82%, transparent);
    border-radius: 3px;
    background: color-mix(in srgb, var(--app-bg) 94%, var(--app-fg));
  }

  .resource-monitor-child-history polyline {
    fill: none;
    stroke: var(--app-accent, #4f8cff);
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }

</style>
