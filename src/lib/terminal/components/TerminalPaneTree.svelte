<script lang="ts">
  import TerminalPaneTree from "./TerminalPaneTree.svelte";
  import { countPaneLeaves, type PaneDropZone, type PaneTree, type SplitDirection } from "$lib/terminal/panes";
  import type { TerminalPane, TerminalTab } from "$lib/terminal/tabs";

  type Props = {
    tab: TerminalTab;
    tree: PaneTree;
    activePaneId: string;
    activatePane: (paneId: string) => void | Promise<void>;
    closePane: (paneId: string) => void | Promise<void>;
    openPaneContextMenu: (event: MouseEvent, paneId: string) => void | Promise<void>;
    startResize: (event: PointerEvent, firstPaneId: string, secondPaneId: string, direction: SplitDirection) => void;
    startPanePointerDrag: (event: PointerEvent, paneId: string) => void;
    dragActive: boolean;
    dropTarget: { paneId: string; zone: PaneDropZone } | null;
  };

  let {
    tab,
    tree,
    activePaneId,
    activatePane,
    closePane,
    openPaneContextMenu,
    startResize,
    startPanePointerDrag,
    dragActive,
    dropTarget,
  }: Props = $props();

  const showPaneChrome = $derived(countPaneLeaves(tab.tree) > 1);

  function paneById(paneId: string): TerminalPane {
    const pane = tab.panes.find((item) => item.id === paneId);
    if (!pane) throw new Error(`pane ${paneId} not found in tab ${tab.id}`);
    return pane;
  }

  function splitStyle(direction: SplitDirection, ratios: number[]) {
    const tracks = ratios.map((ratio) => `${Math.max(ratio, 0.001)}fr`).join(" minmax(0, 5px) ");
    return direction === "row" ? `grid-template-columns: ${tracks};` : `grid-template-rows: ${tracks};`;
  }

  function splitterClass(direction: SplitDirection) {
    return direction === "row" ? "vertical-splitter" : "horizontal-splitter";
  }

  function firstPaneId(node: PaneTree): string {
    if (node.kind === "leaf") return node.paneId;
    const first = node.children[0];
    if (!first) throw new Error("split node has no first pane");
    return firstPaneId(first);
  }

  function lastPaneId(node: PaneTree): string {
    if (node.kind === "leaf") return node.paneId;
    const last = node.children.at(-1);
    if (!last) throw new Error("split node has no last pane");
    return lastPaneId(last);
  }

  function treeKey(node: PaneTree): string {
    if (node.kind === "leaf") return `leaf:${node.paneId}`;
    return `split:${node.direction}:${node.children.map(treeKey).join("|")}`;
  }

  function activate(event: MouseEvent, paneId: string) {
    event.stopPropagation();
    void activatePane(paneId);
  }

  function close(event: MouseEvent, paneId: string) {
    event.preventDefault();
    event.stopPropagation();
    void closePane(paneId);
  }

  function stopPointer(event: PointerEvent) {
    event.stopPropagation();
  }

  function stopBubble(event: Event) {
    event.stopPropagation();
  }

  function context(event: MouseEvent, paneId: string) {
    event.preventDefault();
    void openPaneContextMenu(event, paneId);
  }

  function dropClass(paneId: string, zone: PaneDropZone) {
    return dropTarget?.paneId === paneId && dropTarget.zone === zone;
  }

</script>

{#if tree.kind === "leaf"}
  {@const pane = paneById(tree.paneId)}
  <section
    class:active={pane.id === activePaneId}
    class:drag-active={dragActive}
    class:with-chrome={showPaneChrome}
    class="pane-leaf"
    data-pane-id={pane.id}
    data-testid="terminal-pane"
    role="group"
    aria-label={pane.title}
    oncontextmenu={(event) => context(event, pane.id)}
  >
    {#if showPaneChrome}
      <header
        class="pane-titlebar"
        data-testid="pane-titlebar"
        role="toolbar"
        tabindex="-1"
        aria-label={`Pane controls for ${pane.title}`}
        onmousedown={(event) => activate(event, pane.id)}
      >
        <div
          class="pane-drag-surface"
          data-testid="pane-drag-handle"
          draggable="false"
          role="button"
          tabindex="-1"
          aria-label={`Drag ${pane.title}`}
          onpointerdown={(event) => {
            startPanePointerDrag(event, pane.id);
            event.stopPropagation();
          }}
          onmousedown={stopBubble}
        >
          <span
            class="pane-handle"
            aria-hidden="true"
          ></span>
          <span class="pane-title" title={pane.title}>
            {pane.title}
          </span>
        </div>
        <button
          class="pane-action"
          data-testid="pane-close"
          type="button"
          aria-label={`Close ${pane.title}`}
          title="Close pane"
          draggable="false"
          onpointerdown={stopPointer}
          onpointerup={stopPointer}
          onmousedown={(event) => event.stopPropagation()}
          onclick={(event) => close(event, pane.id)}
        >
          &times;
        </button>
        <button
          class="pane-action"
          data-testid="pane-menu"
          type="button"
          aria-label={`Pane menu for ${pane.title}`}
          title="Pane menu"
          draggable="false"
          onpointerdown={stopPointer}
          onpointerup={stopPointer}
          onmousedown={(event) => event.stopPropagation()}
          onclick={(event) => context(event, pane.id)}
        >
          ...
        </button>
      </header>
    {/if}
    <div class="terminal-host" data-testid="terminal-host" role="presentation" onmousedown={(event) => activate(event, pane.id)}>
      <div class="terminal-mount" data-testid="terminal-mount" bind:this={pane.container}></div>
    </div>
    <div
      class:target={dropClass(pane.id, "up")}
      class="drop-zone drop-top"
      data-drop-zone="up"
      aria-hidden="true"
    ></div>
    <div
      class:target={dropClass(pane.id, "right")}
      class="drop-zone drop-right"
      data-drop-zone="right"
      aria-hidden="true"
    ></div>
    <div
      class:target={dropClass(pane.id, "down")}
      class="drop-zone drop-bottom"
      data-drop-zone="down"
      aria-hidden="true"
    ></div>
    <div
      class:target={dropClass(pane.id, "left")}
      class="drop-zone drop-left"
      data-drop-zone="left"
      aria-hidden="true"
    ></div>
    <div
      class:target={dropClass(pane.id, "center")}
      class="drop-zone drop-center"
      data-drop-zone="center"
      aria-hidden="true"
    ></div>
    {#if pane.error}
      <p class="terminal-error">{pane.error}</p>
    {/if}
  </section>
{:else}
  <div class:column={tree.direction === "column"} class:row={tree.direction === "row"} class="pane-split" style={splitStyle(tree.direction, tree.ratios)}>
    {#each tree.children as child, index (treeKey(child))}
      <TerminalPaneTree
        {tab}
        tree={child}
        {activePaneId}
        {activatePane}
        {closePane}
        {openPaneContextMenu}
        {startResize}
        {startPanePointerDrag}
        {dragActive}
        {dropTarget}
      />
      {#if index < tree.children.length - 1}
        {@const next = tree.children[index + 1]}
        {#if next}
          <div
            class={`pane-splitter ${splitterClass(tree.direction)}`}
            role="separator"
            aria-orientation={tree.direction === "row" ? "vertical" : "horizontal"}
            onpointerdown={(event) => startResize(event, lastPaneId(child), firstPaneId(next), tree.direction)}
          ></div>
        {/if}
      {/if}
    {/each}
  </div>
{/if}

<style>
  .pane-split,
  .pane-leaf {
    min-width: 0;
    min-height: 0;
    width: 100%;
    height: 100%;
  }

  .pane-split {
    display: grid;
    overflow: hidden;
  }

  .pane-leaf {
    position: relative;
    display: grid;
    grid-template-rows: minmax(0, 1fr);
    background: var(--terminal-bg);
    overflow: hidden;
  }

  .pane-leaf.with-chrome {
    grid-template-rows: 24px minmax(0, 1fr);
  }

  .pane-titlebar {
    min-width: 0;
    min-height: 24px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 24px 28px;
    align-items: center;
    border-bottom: 1px solid color-mix(in srgb, var(--terminal-fg) 12%, transparent);
    background: color-mix(in srgb, var(--terminal-bg) 90%, var(--terminal-fg));
    color: color-mix(in srgb, var(--terminal-fg) 76%, transparent);
    user-select: none;
    -webkit-user-select: none;
  }

  .pane-drag-surface {
    min-width: 0;
    height: 24px;
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr);
    align-items: center;
    cursor: grab;
    user-select: none;
    -webkit-user-select: none;
  }

  .pane-drag-surface:active {
    cursor: grabbing;
  }

  .pane-leaf.active .pane-titlebar {
    color: var(--terminal-fg);
    background: color-mix(in srgb, var(--terminal-bg) 82%, var(--terminal-selection));
  }

  .pane-handle {
    width: 18px;
    height: 100%;
    background:
      radial-gradient(circle, currentColor 1px, transparent 1.5px) 6px 8px / 6px 6px no-repeat,
      radial-gradient(circle, currentColor 1px, transparent 1.5px) 6px 14px / 6px 6px no-repeat;
    opacity: 0.5;
  }

  .pane-handle:active {
    opacity: 0.8;
  }

  button {
    appearance: none;
    border: 0;
    color: inherit;
    font: inherit;
    background: transparent;
  }

  .pane-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
    font-size: 11px;
    line-height: 24px;
  }

  .pane-action {
    width: 100%;
    height: 24px;
    display: grid;
    place-items: center;
    font-size: 14px;
    line-height: 1;
    color: color-mix(in srgb, currentColor 72%, transparent);
  }

  .pane-action:active {
    background: color-mix(in srgb, var(--terminal-selection) 38%, transparent);
  }

  .terminal-host {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    padding: var(--terminal-padding-top) var(--terminal-padding-right) var(--terminal-padding-bottom) var(--terminal-padding-left);
    overflow: hidden;
  }

  .terminal-mount {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .terminal-error {
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: 10px;
    margin: 0;
    padding: 6px 8px;
    border-radius: 6px;
    background: color-mix(in srgb, #551818 78%, transparent);
    color: #ffd0d0;
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .pane-splitter {
    min-width: 0;
    min-height: 0;
    background: color-mix(in srgb, var(--terminal-fg) 10%, transparent);
  }

  .pane-splitter.vertical-splitter {
    cursor: col-resize;
  }

  .pane-splitter.horizontal-splitter {
    cursor: row-resize;
  }

  .drop-zone {
    position: absolute;
    z-index: 4;
    pointer-events: none;
  }

  .pane-leaf.drag-active .drop-zone {
    pointer-events: auto;
  }

  .drop-zone::after {
    content: "";
    position: absolute;
    inset: 2px;
    border: 1px solid color-mix(in srgb, var(--terminal-selection) 80%, var(--terminal-fg));
    background: color-mix(in srgb, var(--terminal-selection) 20%, transparent);
    opacity: 0;
    pointer-events: none;
  }

  .pane-leaf.drag-active .drop-zone.target::after {
    opacity: 1;
  }

  .drop-top {
    inset: 0 22% auto 22%;
    height: 24%;
  }

  .drop-right {
    inset: 22% 0 22% auto;
    width: 24%;
  }

  .drop-bottom {
    inset: auto 22% 0 22%;
    height: 24%;
  }

  .drop-left {
    inset: 22% auto 22% 0;
    width: 24%;
  }

  .drop-center {
    inset: 24%;
  }
</style>
