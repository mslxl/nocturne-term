<script lang="ts">
  import { onMount } from "svelte";
  import { OverlayScrollbarsComponent } from "overlayscrollbars-svelte";
  import type { WorkspaceToolTab } from "$lib/bindings";
  import {
    buildResourceMonitorViewModel,
    type ResourceMetricRow,
  } from "$lib/resources/view-model";
  import type { ResourceMetricId, ResourceMonitorState } from "$lib/resources/store";
  import { defaultResourceMetricOrder, reorderResourceMetricOrder } from "$lib/resources/metric-order";
  import {
    registerResourceMonitorView,
    resourceMonitorHistoryForView,
    resourceMonitorStateForOwner,
    tickResourceMonitorView,
    unregisterResourceMonitorView,
  } from "$lib/resources/runtime";
  import Activity from "~icons/lucide/activity";
  import ChevronRight from "~icons/lucide/chevron-right";
  import Cpu from "~icons/lucide/cpu";
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

  let expandedGroups = $state<Set<string>>(new Set());
  let monitorState = $state<ResourceMonitorState | null>(null);
  let metricOrder = $state<ResourceMetricId[]>([...defaultResourceMetricOrder]);
  let pointerDrag = $state<MetricPointerDrag | null>(null);
  let suppressedMetricClick = $state<SuppressedMetricClick | null>(null);
  let stopPointerDragListeners: (() => void) | null = null;

  const model = $derived(
    buildResourceMonitorViewModel({
      snapshot: monitorState?.latest ?? null,
      expandedGroups,
      historyForMetric: (metric) => resourceMonitorHistoryForView(viewId, metric),
      metricOrder,
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

  function toggleGroup(row: ResourceMetricRow) {
    if (!row.collapsible) {
      return;
    }
    const next = new Set(expandedGroups);
    if (next.has(row.id)) {
      next.delete(row.id);
    } else {
      next.add(row.id);
    }
    expandedGroups = next;
  }

  function clickMetricRow(row: ResourceMetricRow) {
    if (suppressedMetricClick && suppressedMetricClick.metric === row.metric && performance.now() < suppressedMetricClick.until) {
      suppressedMetricClick = null;
      return;
    }
    suppressedMetricClick = null;
    toggleGroup(row);
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
    return value === "cpu" || value === "memory" || value === "swap" || value === "gpu";
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
</script>

<section class="resource-monitor-tooltab" aria-label="Resource Monitor" data-testid="resource-monitor-tooltab">
  <header class="resource-monitor-header">
    <div class="resource-monitor-title">
      <Activity aria-hidden="true" />
      <strong>{toolTab.title}</strong>
    </div>
    <div class="resource-monitor-provider-row" data-testid="resource-monitor-provider-row">
      <span data-testid="resource-monitor-provider-label">{model.providerLabel}</span>
      {#if model.statusLabel}
        <span class:stale={model.warning !== null} data-testid="resource-monitor-status">{model.statusLabel}</span>
      {/if}
    </div>
  </header>

  {#if model.warning}
    <div class="resource-monitor-warning" role="status">{model.warning}</div>
  {/if}

  <OverlayScrollbarsComponent element="div" class="resource-monitor-body" role="list" options={overlayResourceOptions} defer>
    {#each model.rows as row (row.id)}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions (Metric rows use pointer drag sorting; collapsible rows also support row-click expansion while the visible toggle button remains the explicit keyboard target.) -->
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
            {:else}
              <MonitorCog />
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
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    justify-content: normal;
    color: var(--app-muted);
    line-height: 1.35;
  }

  .resource-monitor-provider-row span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .resource-monitor-provider-row .stale,
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
  .resource-monitor-child-row small {
    color: var(--app-muted);
  }

  .resource-monitor-auxiliary,
  .resource-monitor-reason {
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .resource-monitor-children {
    min-width: 0;
    display: flex;
    flex-direction: column;
    padding: 0 5px 7px 22px;
    gap: 7px;
  }

  .resource-monitor-history {
    min-width: 0;
    display: block;
    padding: 0 5px 8px 22px;
    color: var(--app-muted);
    line-height: 1.35;
  }

  .resource-monitor-child-history {
    min-width: 0;
    display: block;
  }

  .resource-monitor-history svg,
  .resource-monitor-child-history svg {
    width: 100%;
    display: block;
    border: 1px solid color-mix(in srgb, var(--app-border) 82%, transparent);
    border-radius: 3px;
    background: color-mix(in srgb, var(--app-bg) 94%, var(--app-fg));
  }

  .resource-monitor-history svg {
    height: 32px;
  }

  .resource-monitor-child-history svg {
    height: 24px;
  }

  .resource-monitor-history polyline,
  .resource-monitor-child-history polyline {
    fill: none;
    stroke: var(--app-accent, #4f8cff);
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }

  .resource-monitor-child-row {
    display: grid;
    grid-template-columns: minmax(0, 0.42fr) minmax(0, 0.58fr);
    align-items: start;
    gap: 7px;
    color: var(--app-fg);
    line-height: 1.35;
  }

  .resource-monitor-child-summary {
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }

  .resource-monitor-child-row span,
  .resource-monitor-child-row small {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
