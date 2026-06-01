<script lang="ts">
  import type { ConnectionHostIcon, TabBarOrientation } from "$lib/bindings";
  import HostIcon from "$lib/hosts/HostIcon.svelte";
  import type { TerminalTab } from "$lib/terminal/tabs";

  type Props = {
    tabs: TerminalTab[];
    activeId: string;
    placement: TabBarOrientation;
    integratedTitlebar?: boolean;
    showHostIcons?: boolean;
    hostIconById?: Map<string, ConnectionHostIcon>;
    activateTab: (id: string) => void | Promise<void>;
    closeTab: (id: string) => void | Promise<void>;
    newSession: () => void | Promise<void>;
    openHostPicker: (event: MouseEvent) => void | Promise<void>;
    handleNewSessionSecondaryClick: (event: MouseEvent) => void | Promise<void>;
    openContextMenu: (event: MouseEvent) => void | Promise<void>;
    startTabPointerDrag: (event: PointerEvent, tabId: string) => void;
  };

  let {
    tabs,
    activeId,
    placement,
    integratedTitlebar = false,
    showHostIcons = false,
    hostIconById = new Map(),
    activateTab,
    closeTab,
    newSession,
    openHostPicker,
    handleNewSessionSecondaryClick,
    openContextMenu,
    startTabPointerDrag,
  }: Props = $props();

  const isVertical = $derived(placement !== "horizontal");

  function activePane(tab: TerminalTab) {
    const pane = tab.panes.find((item) => item.id === tab.activePaneId);
    if (!pane) throw new Error(`active pane ${tab.activePaneId} not found in tab ${tab.id}`);
    return pane;
  }

  function hostIconForPane(connectionHostId: string): ConnectionHostIcon | null {
    if (!showHostIcons || !connectionHostId) return null;
    return hostIconById.get(connectionHostId) ?? null;
  }

  function close(event: MouseEvent, id: string) {
    event.preventDefault();
    event.stopPropagation();
    void closeTab(id);
  }

  function stopPointer(event: PointerEvent) {
    event.stopPropagation();
  }

  function activate(event: MouseEvent, id: string) {
    event.preventDefault();
    event.stopPropagation();
    void activateTab(id);
  }

  function pointerDragStart(event: PointerEvent, id: string) {
    startTabPointerDrag(event, id);
  }

  function openPicker(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    void openHostPicker(event);
  }
</script>

<nav
  class:vertical-tabs={isVertical}
  class:integrated-titlebar={integratedTitlebar}
  class:horizontal={!isVertical}
  class="tabbar"
  aria-label="Terminal sessions"
  data-placement={placement}
  data-tauri-drag-region={integratedTitlebar ? "deep" : undefined}
  oncontextmenu={openContextMenu}
  data-testid="terminal-tabbar"
>
  <div class="tabs">
    {#each tabs as tab (tab.id)}
      {@const pane = activePane(tab)}
      {@const hostIcon = hostIconForPane(pane.connectionHostId)}
      <div
        class:active={tab.id === activeId}
        class:error={pane.status === "error"}
        class:exited={pane.status === "exited"}
        class="tab-item"
        data-tab-id={tab.id}
        data-testid="terminal-tab"
        role="listitem"
      >
        <button
          class="tab-activate"
          data-testid="tab-activate"
          type="button"
          onpointerdown={(event) => pointerDragStart(event, tab.id)}
          onclick={(event) => activate(event, tab.id)}
        >
          {#if hostIcon}
            <HostIcon icon={hostIcon} size="small" title={tab.title} />
          {/if}
          <span class="tab-copy">
            <span>{tab.title}</span>
            <small>{pane.command}</small>
          </span>
        </button>
        <button
          class="close-tab"
          data-testid="tab-close"
          type="button"
          aria-label={`Close ${tab.title}`}
          title="Close tab"
          draggable="false"
          onpointerdown={stopPointer}
          onpointerup={stopPointer}
          onmousedown={(event) => event.stopPropagation()}
          onclick={(event) => close(event, tab.id)}
        >
          &times;
        </button>
      </div>
    {/each}
  </div>
  <div class="new-actions">
    <button
      class="new-session"
      data-testid="new-session"
      data-host-picker-trigger="true"
      type="button"
      aria-label="New session"
      title="New session"
      onclick={newSession}
      oncontextmenu={handleNewSessionSecondaryClick}
    >
      <span>+</span>
      <small>Session</small>
    </button>
  </div>
</nav>

<style>
  .tabbar {
    user-select: none;
    -webkit-user-select: none;
    border-color: var(--app-border);
    background: color-mix(in srgb, var(--app-bg) 88%, var(--app-control));
  }

  .tabbar.horizontal {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 56px;
    align-items: stretch;
    border-bottom: 1px solid var(--app-border);
  }

  .tabbar.integrated-titlebar {
    grid-template-columns: minmax(0, 1fr) 50px;
    column-gap: 6px;
    padding: 5px 8px 5px 84px;
  }

  .vertical-tabs {
    display: grid;
    grid-template-rows: minmax(0, 1fr) 40px;
    border-inline: 1px solid var(--app-border);
  }

  .tabs {
    min-width: 0;
    min-height: 0;
    display: flex;
    overflow: auto;
    scrollbar-width: none;
  }

  .tabs::-webkit-scrollbar {
    display: none;
  }

  .vertical-tabs .tabs {
    flex-direction: column;
  }

  button {
    appearance: none;
    border: 0;
    color: inherit;
    font: inherit;
    background: transparent;
  }

  .tab-item {
    min-width: 162px;
    max-width: 240px;
    height: 39px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 28px;
    align-items: stretch;
    border-right: 1px solid var(--app-border);
  }

  .integrated-titlebar .tab-item {
    height: 30px;
    min-width: 152px;
    border: 1px solid color-mix(in srgb, var(--app-border) 80%, transparent);
    border-radius: 6px;
    margin-right: 6px;
    overflow: hidden;
  }

  .vertical-tabs .tab-item {
    width: 100%;
    max-width: none;
    border-right: 0;
    border-bottom: 1px solid var(--app-border);
  }

  .tab-item.active {
    background: var(--app-control);
  }

  .tab-item.exited {
    color: color-mix(in srgb, var(--app-fg) 62%, transparent);
  }

  .tab-item.error {
    color: var(--app-danger);
  }

  .tab-activate {
    min-width: 0;
    height: 39px;
    display: flex;
    align-items: center;
    gap: 1px;
    padding: 4px 4px 4px 12px;
    text-align: left;
  }

  .tab-activate > :global(.host-icon) {
    margin-right: 7px;
  }

  .integrated-titlebar .tab-activate {
    height: 28px;
    gap: 0;
    padding: 2px 4px 2px 10px;
  }

  .tab-copy {
    min-width: 0;
    display: grid;
    align-content: center;
    gap: 1px;
  }

  .integrated-titlebar .tab-copy {
    gap: 0;
  }

  .tab-copy span,
  .tab-activate small {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tab-copy span {
    font-size: 12px;
    line-height: 1.1;
  }

  .integrated-titlebar .tab-copy span {
    line-height: 14px;
  }

  .tab-activate small {
    font-size: 10px;
    line-height: 1.1;
    color: color-mix(in srgb, var(--app-fg) 64%, transparent);
  }

  .integrated-titlebar .tab-activate small {
    font-size: 9px;
    line-height: 10px;
  }

  .close-tab {
    width: 28px;
    height: 39px;
    display: grid;
    place-items: center;
    color: color-mix(in srgb, var(--app-fg) 58%, transparent);
    font-size: 16px;
    line-height: 1;
  }

  .integrated-titlebar .close-tab {
    width: 28px;
    height: 28px;
  }

  .close-tab:active,
  .new-session:active,
  .tab-activate:active {
    background: var(--app-active);
  }

  .close-tab:hover {
    color: var(--app-fg);
  }

  .new-actions {
    display: flex;
  }

  .new-actions button {
    width: 56px;
    min-width: 56px;
    height: 39px;
    display: grid;
    align-content: center;
    justify-items: center;
    gap: 1px;
  }

  .integrated-titlebar .new-actions button {
    width: 50px;
    min-width: 50px;
    height: 30px;
    border-radius: 6px;
  }

  .new-session {
    border-left: 1px solid var(--app-border);
  }

  .integrated-titlebar .new-session {
    border: 1px solid color-mix(in srgb, var(--app-border) 80%, transparent);
  }

  .new-actions span {
    font-size: 15px;
    line-height: 1;
  }

  .new-actions small {
    color: color-mix(in srgb, var(--app-fg) 62%, transparent);
    font-size: 9px;
    line-height: 1;
  }

  .integrated-titlebar .new-actions small {
    display: none;
  }

  .vertical-tabs .new-actions {
    display: grid;
  }

  .vertical-tabs .new-session {
    width: 100%;
    min-width: 0;
    border-left: 0;
    border-top: 1px solid var(--app-border);
  }

  @media (max-width: 720px) {
    .tab-item {
      min-width: 138px;
    }

    .integrated-titlebar .tab-item {
      min-width: 118px;
    }

    .tab-activate {
      padding-left: 10px;
    }
  }
</style>
