<script lang="ts">
  import { onMount, tick } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import "@xterm/xterm/css/xterm.css";
  import { commands, type TabBarOrientation, type TerminalSettings } from "$lib/bindings";
  import { appThemeFromConfig, applyAppPreferences, readValue, resolveTheme } from "$lib/config/document";
  import { hasTauriRuntime } from "$lib/tauri/runtime";
  import TerminalTabBar from "$lib/terminal/components/TerminalTabBar.svelte";
  import { unwrapCommand } from "$lib/terminal/commands";
  import { syncSettingsVariables, xtermOptions } from "$lib/terminal/settings";
  import {
    createTerminalTab,
    createTerminalTabController,
    disposeTerminalTab,
    measureTerminalFit,
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
  let terminalMeasureContainer: HTMLDivElement;
  let appTheme: "light" | "dark" = "dark";

  let activeTab = $derived(tabs.find((tab) => tab.id === activeId));
  let isVertical = $derived(tabBarOrientation !== "horizontal");
  let tabsOnLeft = $derived(tabBarOrientation === "vertical_left");
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
    appTheme = resolveTheme(appThemeFromConfig(readValue(snapshot.effective_config.root, ["ui", "theme"])));
    const next = await unwrapCommand(commands.getTerminalSettingsForTheme({ resolved_theme: appTheme }));
    settings = next;
    tabBarOrientation = next.tab_bar_orientation;
    syncSettingsVariables(next);
    for (const tab of tabs) {
      if (tab.term) tab.term.options = xtermOptions(next);
      terminalTabs.scheduleFit(tab.id);
    }
  }

  async function newSession() {
    try {
      if (!settings) await loadSettings();
      if (!settings) throw new Error("Terminal settings are not loaded");
      await tick();
      const measuredSize = measureTerminalFit(terminalMeasureContainer, settings, { cols: initialCols, rows: initialRows });
      const info = await unwrapCommand(
        commands.createTerminalSession({
          cols: measuredSize.cols,
          rows: measuredSize.rows,
          pixel_width: measuredSize.pixelWidth,
          pixel_height: measuredSize.pixelHeight,
          resolved_theme: appTheme,
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

  async function tabContextMenu(event: MouseEvent) {
    event.preventDefault();
    if (!hasTauriRuntime()) return;
    await unwrapCommand(
      commands.showTabBarContextMenu({
        x: event.clientX,
        y: event.clientY,
      }),
    ).catch((error) => {
      settingsError = error instanceof Error ? error.message : String(error);
    });
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

<main class:left-tabs={tabsOnLeft} class:vertical={isVertical} class="workspace">
  <div class="terminal-measure-host" aria-hidden="true">
    <div class="terminal-mount" bind:this={terminalMeasureContainer}></div>
  </div>

  {#if !isVertical || tabsOnLeft}
    <TerminalTabBar
      {tabs}
      {activeId}
      placement={tabBarOrientation}
      {activateTab}
      {closeTab}
      {newSession}
      openContextMenu={tabContextMenu}
    />
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
          <div class="terminal-host">
            <div class="terminal-mount" bind:this={tab.container}></div>
          </div>
          {#if tab.error}
            <p class="terminal-error">{tab.error}</p>
          {/if}
        </div>
      {/each}
    {/if}
  </section>

  {#if isVertical && !tabsOnLeft}
    <TerminalTabBar
      {tabs}
      {activeId}
      placement={tabBarOrientation}
      {activateTab}
      {closeTab}
      {newSession}
      openContextMenu={tabContextMenu}
    />
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
    overflow: hidden;
  }

  .workspace {
    width: 100vw;
    height: 100vh;
    display: grid;
    grid-template-rows: 40px minmax(0, 1fr);
    background: color-mix(in srgb, var(--app-bg) 94%, var(--app-fg));
  }

  .terminal-measure-host {
    position: fixed;
    inset: 0 208px 0 0;
    z-index: -1;
    padding: var(--terminal-padding-top) var(--terminal-padding-right) var(--terminal-padding-bottom) var(--terminal-padding-left);
    overflow: hidden;
    visibility: hidden;
    pointer-events: none;
  }

  .workspace:not(.vertical) .terminal-measure-host {
    inset: 40px 0 0 0;
  }

  .workspace.vertical.left-tabs .terminal-measure-host {
    inset: 0 0 0 208px;
  }

  .workspace.vertical {
    grid-template-columns: minmax(0, 1fr) 208px;
    grid-template-rows: minmax(0, 1fr);
  }

  .workspace.vertical.left-tabs {
    grid-template-columns: 208px minmax(0, 1fr);
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
    color: color-mix(in srgb, var(--app-fg) 72%, transparent);
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
    color: var(--app-danger);
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
    overflow: hidden;
  }

  .terminal-pane.active {
    display: block;
  }

  .terminal-host {
    width: 100%;
    height: 100%;
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
    background: color-mix(in srgb, var(--app-danger) 22%, transparent);
    color: var(--app-danger);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  :global(.xterm) {
    width: 100%;
    height: 100%;
    box-sizing: content-box;
  }

  :global(.xterm *) {
    box-sizing: content-box;
  }

  :global(.xterm .xterm-viewport) {
    background-color: transparent;
  }

  :global(.xterm .xterm-screen) {
    overflow: hidden;
  }

  :global(.xterm .xterm-rows) {
    position: absolute;
    inset: 0 auto auto 0;
  }

  :global(.xterm .xterm-rows > div) {
    display: block;
  }

  @media (max-width: 720px) {
    .workspace.vertical {
      grid-template-columns: minmax(0, 1fr) 160px;
    }

    .workspace.vertical.left-tabs {
      grid-template-columns: 160px minmax(0, 1fr);
    }

    .workspace.vertical .terminal-measure-host {
      inset: 0 160px 0 0;
    }

    .workspace.vertical.left-tabs .terminal-measure-host {
      inset: 0 0 0 160px;
    }
  }
</style>
