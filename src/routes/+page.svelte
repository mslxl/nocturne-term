<script lang="ts">
  import { onMount, tick } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import "@xterm/xterm/css/xterm.css";
  import { commands, type TabBarOrientation, type TerminalSettings } from "$lib/bindings";
  import { applyAppPreferences } from "$lib/config/document";
  import { hasTauriRuntime } from "$lib/tauri/runtime";
  import { unwrapCommand } from "$lib/terminal/commands";
  import { syncSettingsVariables, xtermOptions } from "$lib/terminal/settings";
  import {
    createTerminalTab,
    createTerminalTabController,
    disposeTerminalTab,
    type TerminalExitEvent,
    type TerminalOutputEvent,
    type TerminalTab,
  } from "$lib/terminal/tabs";

  const initialCols = 80;
  const initialRows = 24;

  let settings = $state<TerminalSettings | null>(null);
  let settingsError = $state("");
  let tabs = $state<TerminalTab[]>([]);
  let activeId = $state("");
  let tabBarOrientation = $state<TabBarOrientation>("horizontal");
  let outputUnlisten: undefined | (() => void);
  let exitUnlisten: undefined | (() => void);
  let configUnlisten: undefined | (() => void);

  let activeTab = $derived(tabs.find((tab) => tab.id === activeId));
  let isVertical = $derived(tabBarOrientation === "vertical");
  const terminalTabs = createTerminalTabController({
    settings: () => settings,
    tabs: () => tabs,
    setGlobalError: (message) => {
      settingsError = message;
    },
  });

  async function loadSettings() {
    settingsError = "";
    const snapshot = await unwrapCommand(commands.getConfigSnapshot());
    applyAppPreferences(snapshot.effective_config.root);
    const next = await unwrapCommand(commands.getTerminalSettings());
    settings = next;
    tabBarOrientation = next.tab_bar_orientation;
    syncSettingsVariables(next);
    for (const tab of tabs) {
      if (tab.term) tab.term.options = { ...tab.term.options, ...xtermOptions(next) };
      terminalTabs.scheduleFit(tab.id);
    }
  }

  async function newSession() {
    try {
      if (!settings) await loadSettings();
      const info = await unwrapCommand(
        commands.createTerminalSession({
          cols: initialCols,
          rows: initialRows,
        }),
      );
      tabs = [...tabs, createTerminalTab(info)];
      activeId = info.id;
      await tick();
      await terminalTabs.mountTerminal(info.id);
    } catch (error) {
      settingsError = error instanceof Error ? error.message : String(error);
    }
  }

  async function activateTab(id: string) {
    activeId = id;
    await tick();
    await terminalTabs.mountTerminal(id);
    terminalTabs.scheduleFit(id);
    tabs.find((tab) => tab.id === id)?.term?.focus();
  }

  async function closeTab(id: string) {
    const tab = tabs.find((item) => item.id === id);
    if (!tab) return;
    disposeTerminalTab(tab);
    if (tab.status === "running") {
      await unwrapCommand(commands.closeTerminalSession(id)).catch((error) => {
        settingsError = error instanceof Error ? error.message : String(error);
      });
    }
    const index = tabs.findIndex((item) => item.id === id);
    tabs = tabs.filter((item) => item.id !== id);
    if (activeId === id) {
      activeId = tabs[Math.max(0, index - 1)]?.id ?? tabs[0]?.id ?? "";
      if (activeId) await activateTab(activeId);
    }
  }

  function toggleTabBarOrientation() {
    tabBarOrientation = tabBarOrientation === "horizontal" ? "vertical" : "horizontal";
    requestAnimationFrame(() => {
      if (activeId) terminalTabs.scheduleFit(activeId);
    });
  }

  function tabContextMenu(event: MouseEvent) {
    event.preventDefault();
    toggleTabBarOrientation();
  }

  function handleKeyboard(event: KeyboardEvent) {
    const isMac = navigator.platform.toLowerCase().includes("mac");
    const newTab = isMac ? event.metaKey && event.key.toLowerCase() === "t" : event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "t";
    if (newTab) {
      event.preventDefault();
      void newSession();
      return;
    }
    const closeActiveTab = isMac ? event.metaKey && event.key.toLowerCase() === "w" : event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "w";
    if (closeActiveTab && activeId) {
      event.preventDefault();
      void closeTab(activeId);
    }
  }

  onMount(() => {
    void loadSettings().catch((error) => {
      settingsError = error instanceof Error ? error.message : String(error);
    });
    if (hasTauriRuntime()) {
      void listen<TerminalOutputEvent>("terminal://output", (event) => terminalTabs.enqueueOutput(event.payload)).then((dispose) => {
        outputUnlisten = dispose;
      });
      void listen<TerminalExitEvent>("terminal://exit", (event) => terminalTabs.markExited(event.payload)).then((dispose) => {
        exitUnlisten = dispose;
      });
      void listen("config://changed", () => {
        void loadSettings().catch((error) => {
          settingsError = error instanceof Error ? error.message : String(error);
        });
      }).then((dispose) => {
        configUnlisten = dispose;
      });
    }
    window.addEventListener("keydown", handleKeyboard);
    return () => {
      window.removeEventListener("keydown", handleKeyboard);
      outputUnlisten?.();
      exitUnlisten?.();
      configUnlisten?.();
      for (const tab of tabs) {
        disposeTerminalTab(tab);
        if (tab.status === "running") void unwrapCommand(commands.closeTerminalSession(tab.id));
      }
    };
  });

  $effect(() => {
    if (activeId) {
      void tick().then(() => {
        void terminalTabs.mountTerminal(activeId);
        terminalTabs.scheduleFit(activeId);
      });
    }
  });
</script>

<main class:vertical={isVertical} class="workspace">
  {#if !isVertical}
    <nav class="tabbar horizontal" aria-label="Terminal sessions" oncontextmenu={tabContextMenu}>
      <div class="tabs">
        {#each tabs as tab}
          <button class:active={tab.id === activeId} class:error={tab.status === "error"} class:exited={tab.status === "exited"} type="button" onclick={() => activateTab(tab.id)}>
            <span>{tab.title}</span>
            <small>{tab.command}</small>
          </button>
        {/each}
      </div>
      <button class="new-session" type="button" aria-label="New session" title="New session" onclick={newSession}>+</button>
    </nav>
  {/if}

  <section class="content" aria-label="Terminal content">
    {#if settingsError}
      <div class="placeholder error-state">
        <img src="/favicon.png" alt="" />
        <h1>Nocturne</h1>
        <p>{settingsError}</p>
      </div>
    {:else if tabs.length === 0}
      <div class="placeholder">
        <img src="/favicon.png" alt="" />
        <h1>Nocturne</h1>
      </div>
    {:else}
      {#each tabs as tab}
        <div class:active={tab.id === activeId} class="terminal-pane">
          <div class="terminal-host" bind:this={tab.container}></div>
          {#if tab.error}
            <p class="terminal-error">{tab.error}</p>
          {/if}
        </div>
      {/each}
    {/if}
  </section>

  {#if isVertical}
    <nav class="tabbar vertical-tabs" aria-label="Terminal sessions" oncontextmenu={tabContextMenu}>
      <div class="tabs">
        {#each tabs as tab}
          <button class:active={tab.id === activeId} class:error={tab.status === "error"} class:exited={tab.status === "exited"} type="button" onclick={() => activateTab(tab.id)}>
            <span>{tab.title}</span>
            <small>{tab.command}</small>
          </button>
        {/each}
      </div>
      <button class="new-session" type="button" aria-label="New session" title="New session" onclick={newSession}>+</button>
    </nav>
  {/if}
</main>

<style>
  :global(:root) {
    --terminal-bg: #101113;
    --terminal-fg: #eef1f6;
    --terminal-selection: #36506f;
    --terminal-padding-top: 8px;
    --terminal-padding-right: 10px;
    --terminal-padding-bottom: 8px;
    --terminal-padding-left: 10px;
  }

  :global(body) {
    margin: 0;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: var(--terminal-bg);
    color: var(--terminal-fg);
    overflow: hidden;
  }

  :global(*) {
    box-sizing: border-box;
  }

  .workspace {
    width: 100vw;
    height: 100vh;
    display: grid;
    grid-template-rows: 40px minmax(0, 1fr);
    background: color-mix(in srgb, var(--terminal-bg) 94%, black);
  }

  .workspace.vertical {
    grid-template-columns: minmax(0, 1fr) 208px;
    grid-template-rows: minmax(0, 1fr);
  }

  .tabbar {
    user-select: none;
    -webkit-user-select: none;
    border-color: color-mix(in srgb, var(--terminal-fg) 16%, transparent);
    background: color-mix(in srgb, var(--terminal-bg) 88%, var(--terminal-fg));
  }

  .tabbar.horizontal {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 36px;
    align-items: stretch;
    border-bottom: 1px solid color-mix(in srgb, var(--terminal-fg) 16%, transparent);
  }

  .vertical-tabs {
    display: grid;
    grid-template-rows: minmax(0, 1fr) 40px;
    border-left: 1px solid color-mix(in srgb, var(--terminal-fg) 16%, transparent);
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

  .tabs button,
  .new-session {
    appearance: none;
    border: 0;
    color: inherit;
    font: inherit;
    background: transparent;
  }

  .tabs button {
    min-width: 148px;
    max-width: 220px;
    height: 39px;
    display: grid;
    align-content: center;
    gap: 1px;
    padding: 4px 12px;
    border-right: 1px solid color-mix(in srgb, var(--terminal-fg) 12%, transparent);
    text-align: left;
  }

  .vertical-tabs .tabs button {
    width: 100%;
    max-width: none;
    border-right: 0;
    border-bottom: 1px solid color-mix(in srgb, var(--terminal-fg) 12%, transparent);
  }

  .tabs button.active {
    background: var(--terminal-bg);
  }

  .tabs button.exited {
    color: color-mix(in srgb, var(--terminal-fg) 62%, transparent);
  }

  .tabs button.error {
    color: #ffb4b4;
  }

  .tabs span,
  .tabs small {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tabs span {
    font-size: 12px;
    line-height: 1.1;
  }

  .tabs small {
    font-size: 10px;
    line-height: 1.1;
    color: color-mix(in srgb, var(--terminal-fg) 64%, transparent);
  }

  .new-session {
    width: 36px;
    min-width: 36px;
    height: 39px;
    display: grid;
    place-items: center;
    font-size: 21px;
    line-height: 1;
    border-left: 1px solid color-mix(in srgb, var(--terminal-fg) 12%, transparent);
  }

  .vertical-tabs .new-session {
    width: 100%;
    border-left: 0;
    border-top: 1px solid color-mix(in srgb, var(--terminal-fg) 12%, transparent);
  }

  .new-session:active,
  .tabs button:active {
    background: color-mix(in srgb, var(--terminal-selection) 38%, transparent);
  }

  .content {
    min-width: 0;
    min-height: 0;
    position: relative;
    background: var(--terminal-bg);
  }

  .placeholder {
    height: 100%;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 12px;
    color: color-mix(in srgb, var(--terminal-fg) 72%, transparent);
    user-select: none;
    -webkit-user-select: none;
  }

  .placeholder img {
    width: 74px;
    height: 74px;
    image-rendering: auto;
  }

  .placeholder h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 600;
    line-height: 1.2;
  }

  .placeholder p {
    max-width: min(560px, calc(100vw - 48px));
    margin: 0;
    color: #ffb4b4;
    text-align: center;
    overflow-wrap: anywhere;
  }

  .terminal-pane {
    position: absolute;
    inset: 0;
    display: none;
    min-width: 0;
    min-height: 0;
    background: var(--terminal-bg);
  }

  .terminal-pane.active {
    display: block;
  }

  .terminal-host {
    width: 100%;
    height: 100%;
    padding: var(--terminal-padding-top) var(--terminal-padding-right) var(--terminal-padding-bottom) var(--terminal-padding-left);
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

  :global(.xterm) {
    height: 100%;
  }

  :global(.xterm .xterm-viewport) {
    background-color: transparent;
  }

  @media (max-width: 720px) {
    .workspace.vertical {
      grid-template-columns: minmax(0, 1fr) 160px;
    }

    .tabs button {
      min-width: 124px;
      padding-inline: 10px;
    }
  }
</style>
