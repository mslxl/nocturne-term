<script lang="ts">
  import type { Snippet } from "svelte";
  import type { WorkspaceDockLayout, WorkspaceTabState, WorkspaceToolSlot, WorkspaceToolTab } from "$lib/bindings";

  type WorkspaceDockGroupLayout = Extract<WorkspaceDockLayout, { kind: "group" }>;

  type Props = {
    layout: WorkspaceDockGroupLayout;
    workspace: WorkspaceTabState | null;
    activeSlotId: string;
    activeSlotRevision: number;
    tabbarPlacement?: "top" | "left" | "right" | "bottom";
    visualRole?: string;
    dropTargetGroupId: string | null;
    splitTargetSlotId: string | null;
    draggingSlotId: string | null;
    slotTool: (slot: WorkspaceToolSlot) => WorkspaceToolTab | null;
    slotTitle: (slot: WorkspaceToolSlot) => string;
    ownerWorkspaceTitle: (slot: WorkspaceToolSlot) => string;
    terminalSessionId: (tool: WorkspaceToolTab | null) => string | undefined;
    onActivate: (slotId: string) => void;
    onClose: (slotId: string) => void;
    onContextMenu: (event: MouseEvent, layout: WorkspaceDockGroupLayout, slot: WorkspaceToolSlot) => void;
    onPointerDown: (event: PointerEvent, slot: WorkspaceToolSlot) => void;
    children: Snippet<[WorkspaceToolSlot | null, boolean]>;
  };

  let {
    layout,
    workspace,
    activeSlotId,
    activeSlotRevision,
    tabbarPlacement = "top",
    visualRole = layout.role,
    dropTargetGroupId,
    splitTargetSlotId,
    draggingSlotId,
    slotTool,
    slotTitle,
    ownerWorkspaceTitle,
    terminalSessionId,
    onActivate,
    onClose,
    onContextMenu,
    onPointerDown,
    children,
  }: Props = $props();

  let localActiveSlotIdOverride = $state<string | null>(null);

  const localActiveSlotId = $derived.by(() => {
    activeSlotRevision;
    if (localActiveSlotIdOverride && layout.slots.some((slot) => slot.id === localActiveSlotIdOverride)) {
      return localActiveSlotIdOverride;
    }
    if (layout.slots.some((slot) => slot.id === activeSlotId)) return activeSlotId;
    return layout.slots[0]?.id ?? "";
  });

  $effect(() => {
    if (!localActiveSlotIdOverride) return;
    if (!layout.slots.some((slot) => slot.id === localActiveSlotIdOverride)) {
      localActiveSlotIdOverride = null;
    }
  });

  function isActive(slot: WorkspaceToolSlot) {
    return slot.id === localActiveSlotId;
  }

  function activate(slotId: string) {
    localActiveSlotIdOverride = slotId;
    onActivate(slotId);
  }

  function shouldMountSlot(slot: WorkspaceToolSlot) {
    const tool = slotTool(slot);
    return tool?.kind !== "terminal" || isActive(slot);
  }
</script>

<section
  class:drop-target={dropTargetGroupId === layout.id}
  class="workspace-dock-group"
  class:tabbar-bottom={tabbarPlacement === "bottom"}
  class:tabbar-left={tabbarPlacement === "left"}
  class:tabbar-right={tabbarPlacement === "right"}
  class:tabbar-top={tabbarPlacement === "top"}
  aria-label="Tool tabs"
  data-dock-group-id={layout.id}
  data-dock-group-role={layout.role}
  data-dock-group-visual-role={visualRole}
  data-dock-group-model-role={layout.role}
  data-tool-tabbar-placement={tabbarPlacement}
  data-active-tool-slot-id={localActiveSlotId}
  data-active-tool-slot-revision={activeSlotRevision}
  data-testid={`dock-group-${layout.id}`}
  data-workspace-id={workspace?.id ?? ""}
>
  <div class="tool-tabbar">
    {#each layout.slots as slot (slot.id)}
      {@const tool = slotTool(slot)}
      <div
        class="tool-tab"
        class:active={isActive(slot)}
        class:closed={slot.kind === "closed_source"}
        class:dragging={draggingSlotId === slot.id}
        class:mirror={slot.kind === "mirror"}
        class:placeholder={slot.kind === "floating_placeholder"}
        class:split-target={splitTargetSlotId === slot.id}
        data-testid={`tool-slot-${slot.id}`}
        data-session-id={terminalSessionId(tool)}
        data-tool-snapshot-title={tool?.title ?? ""}
        data-tool-kind={tool?.kind ?? ""}
        data-tool-slot-id={slot.id}
        data-tool-tab-id={tool?.id ?? ""}
        role="tab"
        tabindex="0"
        aria-selected={isActive(slot)}
        title={slotTitle(slot)}
        onclick={() => workspace ? activate(slot.id) : undefined}
        onkeydown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          if (workspace) activate(slot.id);
        }}
        oncontextmenu={(event) => workspace ? onContextMenu(event, layout, slot) : undefined}
        onpointerdown={(event) => workspace ? onPointerDown(event, slot) : undefined}
      >
        <span class="tool-title">{slotTitle(slot)}</span>
        {#if slot.kind === "mirror"}
          <small>{ownerWorkspaceTitle(slot)}</small>
        {:else if slot.kind === "floating_placeholder"}
          <small>Floating</small>
        {:else if slot.kind === "closed_source"}
          <small>Closed</small>
        {/if}
        {#if workspace && isActive(slot)}
          <button
            class="tool-close"
            type="button"
            aria-label={`Close ${slotTitle(slot)}`}
            title="Close ToolTab"
            onpointerdown={(event) => event.stopPropagation()}
            onclick={(event) => {
              event.stopPropagation();
              onClose(slot.id);
            }}
          >
            ×
          </button>
        {/if}
      </div>
    {/each}
  </div>
  <div class="tool-surface">
    {#each layout.slots as slot (slot.id)}
      {#if shouldMountSlot(slot)}
        <div
          class="tool-pane"
          class:active={isActive(slot)}
          data-tool-pane-slot-id={slot.id}
          hidden={!isActive(slot)}
          aria-hidden={!isActive(slot)}
        >
          {@render children(slot, isActive(slot))}
        </div>
      {/if}
    {/each}
  </div>
</section>

<style>
  .workspace-dock-group {
    min-width: 0;
    min-height: 0;
    height: 100%;
    display: grid;
    grid-template-rows: 31px minmax(0, 1fr);
    overflow: hidden;
    border-right: 1px solid var(--app-border);
    border-bottom: 1px solid var(--app-border);
    background: color-mix(in srgb, var(--app-bg) 96%, var(--app-control));
  }

  .workspace-dock-group.tabbar-bottom {
    grid-template-rows: minmax(0, 1fr) 31px;
  }

  .workspace-dock-group.tabbar-left,
  .workspace-dock-group.tabbar-right {
    grid-template-rows: minmax(0, 1fr);
    grid-template-columns: 32px minmax(0, 1fr);
  }

  .workspace-dock-group.tabbar-right {
    grid-template-columns: minmax(0, 1fr) 32px;
  }

  .workspace-dock-group.drop-target {
    outline: 2px solid color-mix(in srgb, var(--app-accent) 62%, transparent);
    outline-offset: -3px;
  }

  .tool-tabbar {
    min-width: 0;
    display: flex;
    align-items: end;
    gap: 2px;
    overflow-x: auto;
    overflow-y: hidden;
    border-bottom: 1px solid var(--app-border);
    padding: 3px 5px 0;
  }

  .workspace-dock-group.tabbar-bottom .tool-tabbar {
    grid-row: 2;
    border-top: 1px solid var(--app-border);
    border-bottom: 0;
    padding: 0 5px 3px;
    align-items: start;
  }

  .workspace-dock-group.tabbar-left .tool-tabbar,
  .workspace-dock-group.tabbar-right .tool-tabbar {
    min-height: 0;
    flex-direction: column;
    align-items: stretch;
    overflow-x: hidden;
    overflow-y: auto;
    border-bottom: 0;
    padding: 5px 0;
  }

  .workspace-dock-group.tabbar-left .tool-tabbar {
    grid-column: 1;
    border-right: 1px solid var(--app-border);
  }

  .workspace-dock-group.tabbar-right .tool-tabbar {
    grid-column: 2;
    border-left: 1px solid var(--app-border);
  }

  .tool-tab {
    position: relative;
    box-sizing: border-box;
    flex: 0 0 auto;
    min-width: 0;
    max-width: 180px;
    height: 28px;
    display: flex;
    align-items: center;
    gap: 6px;
    border: 1px solid transparent;
    border-bottom: 0;
    border-radius: 6px 6px 0 0;
    padding: 0 9px;
    background: transparent;
    color: color-mix(in srgb, var(--app-fg) 72%, transparent);
    font: inherit;
    font-size: 12px;
    line-height: 1;
    user-select: none;
    -webkit-user-select: none;
  }

  .workspace-dock-group.tabbar-bottom .tool-tab {
    border-top: 0;
    border-bottom: 1px solid transparent;
    border-radius: 0 0 6px 6px;
  }

  .workspace-dock-group.tabbar-left .tool-tab,
  .workspace-dock-group.tabbar-right .tool-tab {
    width: 31px;
    max-width: none;
    height: 120px;
    min-height: 72px;
    justify-content: center;
    border: 1px solid transparent;
    padding: 8px 0;
    writing-mode: vertical-rl;
    text-orientation: mixed;
  }

  .workspace-dock-group.tabbar-left .tool-tab {
    border-left: 0;
    border-radius: 0 6px 6px 0;
  }

  .workspace-dock-group.tabbar-right .tool-tab {
    border-right: 0;
    border-radius: 6px 0 0 6px;
  }

  .workspace-dock-group.tabbar-left .tool-close,
  .workspace-dock-group.tabbar-right .tool-close {
    width: 22px;
    height: 22px;
    max-width: 22px;
    writing-mode: horizontal-tb;
  }

  .tool-close {
    flex: none;
    width: 24px;
    height: 22px;
    max-width: 24px;
    justify-content: center;
    align-items: center;
    display: inline-flex;
    border: 0;
    border-radius: 4px;
    padding: 0;
    background: transparent;
    color: color-mix(in srgb, var(--app-fg) 48%, transparent);
    font: inherit;
    font-size: 13px;
  }

  .tool-close:hover {
    color: var(--app-fg);
    background: var(--app-hover);
  }

  .tool-tab.active {
    background: color-mix(in srgb, var(--app-control) 58%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--app-fg) 7%, transparent);
  }

  .tool-tab.active::after {
    content: "";
    position: absolute;
    pointer-events: none;
    border-radius: 999px;
    background: color-mix(in srgb, var(--app-accent) 52%, transparent);
  }

  .workspace-dock-group.tabbar-top .tool-tab.active::after {
    left: 8px;
    right: 8px;
    bottom: 2px;
    height: 1px;
  }

  .workspace-dock-group.tabbar-bottom .tool-tab.active::after {
    left: 8px;
    right: 8px;
    top: 2px;
    height: 1px;
  }

  .workspace-dock-group.tabbar-left .tool-tab.active::after {
    top: 8px;
    bottom: 8px;
    right: 2px;
    width: 1px;
  }

  .workspace-dock-group.tabbar-right .tool-tab.active::after {
    top: 8px;
    bottom: 8px;
    left: 2px;
    width: 1px;
  }

  .tool-tab:focus-visible {
    outline: 1px solid color-mix(in srgb, var(--app-accent) 76%, transparent);
    outline-offset: -2px;
  }

  .tool-tab.dragging {
    opacity: 0.45;
  }

  .tool-tab.split-target {
    border-color: color-mix(in srgb, var(--app-accent) 72%, var(--app-border));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--app-accent) 45%, transparent);
  }

  .tool-tab.mirror {
    border-color: color-mix(in srgb, var(--app-accent) 58%, var(--app-border));
  }

  .tool-tab.closed,
  .tool-tab.placeholder {
    color: color-mix(in srgb, var(--app-fg) 54%, transparent);
  }

  .tool-tab .tool-title {
    display: block;
    min-width: 0;
    overflow: hidden;
    line-height: 1;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tool-tab small {
    flex: none;
    border: 1px solid color-mix(in srgb, var(--app-fg) 16%, transparent);
    border-radius: 999px;
    padding: 0 5px;
    color: color-mix(in srgb, var(--app-fg) 60%, transparent);
    font-size: 10px;
  }

  .tool-surface {
    min-width: 0;
    min-height: 0;
    height: 100%;
    display: grid;
    grid-template-rows: minmax(0, 1fr);
    overflow: hidden;
  }

  .workspace-dock-group.tabbar-bottom .tool-surface {
    grid-row: 1;
  }

  .workspace-dock-group.tabbar-left .tool-surface {
    grid-column: 2;
    grid-row: 1;
  }

  .workspace-dock-group.tabbar-right .tool-surface {
    grid-column: 1;
    grid-row: 1;
  }

  .tool-pane {
    min-width: 0;
    min-height: 0;
    height: 100%;
    display: grid;
    grid-template-rows: minmax(0, 1fr);
    overflow: hidden;
  }

  .tool-pane[hidden] {
    display: none;
  }
</style>
