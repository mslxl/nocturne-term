<script lang="ts">
  import type { TabBarOrientation } from "$lib/bindings";
  import type { TerminalTab } from "$lib/terminal/tabs";

  type Props = {
    tabs: TerminalTab[];
    activeId: string;
    placement: TabBarOrientation;
    activateTab: (id: string) => void | Promise<void>;
    closeTab: (id: string) => void | Promise<void>;
    newSession: () => void | Promise<void>;
    openContextMenu: (event: MouseEvent) => void | Promise<void>;
  };

  let { tabs, activeId, placement, activateTab, closeTab, newSession, openContextMenu }: Props = $props();

  const isVertical = $derived(placement !== "horizontal");

  function close(event: MouseEvent, id: string) {
    event.stopPropagation();
    void closeTab(id);
  }
</script>

<nav
  class:vertical-tabs={isVertical}
  class:horizontal={!isVertical}
  class="tabbar"
  aria-label="Terminal sessions"
  data-placement={placement}
  oncontextmenu={openContextMenu}
>
  <div class="tabs">
    {#each tabs as tab}
      <div
        class:active={tab.id === activeId}
        class:error={tab.status === "error"}
        class:exited={tab.status === "exited"}
        class="tab-item"
      >
        <button class="tab-activate" type="button" onclick={() => activateTab(tab.id)}>
          <span>{tab.title}</span>
          <small>{tab.command}</small>
        </button>
        <button
          class="close-tab"
          type="button"
          aria-label={`Close ${tab.title}`}
          title="Close tab"
          onclick={(event) => close(event, tab.id)}
        >
          &times;
        </button>
      </div>
    {/each}
  </div>
  <button class="new-session" type="button" aria-label="New session" title="New session" onclick={newSession}>+</button>
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
    grid-template-columns: minmax(0, 1fr) 36px;
    align-items: stretch;
    border-bottom: 1px solid var(--app-border);
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
    display: grid;
    align-content: center;
    gap: 1px;
    padding: 4px 4px 4px 12px;
    text-align: left;
  }

  .tab-activate span,
  .tab-activate small {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tab-activate span {
    font-size: 12px;
    line-height: 1.1;
  }

  .tab-activate small {
    font-size: 10px;
    line-height: 1.1;
    color: color-mix(in srgb, var(--app-fg) 64%, transparent);
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

  .close-tab:active,
  .new-session:active,
  .tab-activate:active {
    background: var(--app-active);
  }

  .close-tab:hover {
    color: var(--app-fg);
  }

  .new-session {
    width: 36px;
    min-width: 36px;
    height: 39px;
    display: grid;
    place-items: center;
    font-size: 21px;
    line-height: 1;
    border-left: 1px solid var(--app-border);
  }

  .vertical-tabs .new-session {
    width: 100%;
    border-left: 0;
    border-top: 1px solid var(--app-border);
  }

  @media (max-width: 720px) {
    .tab-item {
      min-width: 138px;
    }

    .tab-activate {
      padding-left: 10px;
    }
  }
</style>
