<script lang="ts">
  import { onMount, tick } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import { ask } from "@tauri-apps/plugin-dialog";
  import "@xterm/xterm/css/xterm.css";
  import { commands, type TabBarOrientation, type TerminalSettings } from "$lib/bindings";
  import { appThemeFromConfig, applyAppPreferences, readValue, resolveTheme } from "$lib/config/document";
  import { hasTauriRuntime } from "$lib/tauri/runtime";
  import TerminalPaneTree from "$lib/terminal/components/TerminalPaneTree.svelte";
  import TerminalTabBar from "$lib/terminal/components/TerminalTabBar.svelte";
  import { unwrapCommand } from "$lib/terminal/commands";
  import { eventMatchesBinding, readKeybindingMap, type KeybindingMap, type TerminalCommandId } from "$lib/terminal/keybindings";
  import {
    movePaneIntoSplit,
    removePane,
    replacePane,
    resizeAdjacentPanes,
    splitPane,
    swapPanes,
    clonePaneTree,
    type PaneDropZone,
    type SplitDirection,
    type SplitSide,
  } from "$lib/terminal/panes";
  import { syncSettingsVariables, xtermOptions } from "$lib/terminal/settings";
  import {
    createTerminalPane,
    createTerminalTab,
    createTerminalTabController,
    disposeTerminalPane,
    disposeTerminalTab,
    measureTerminalFit,
    refreshTerminalTabTitle,
    terminalPaneById,
    createTerminalTabFromPane,
    type TerminalExitEvent,
    type TerminalOutputEvent,
    type TerminalPane,
    type TerminalTab,
  } from "$lib/terminal/tabs";
  import { toTerminalSessionSizeInput } from "$lib/terminal/sizes";

  const initialCols = 80;
  const initialRows = 24;
  const minPaneWidth = 160;
  const minPaneHeight = 96;
  type PaneMenuEvent = {
    action: "split_left" | "split_right" | "split_up" | "split_down";
    pane_id: string;
  };

  let settings = $state<TerminalSettings | null>(null);
  let keybindings = $state<KeybindingMap | null>(null);
  let settingsError = $state("");
  let tabs = $state<TerminalTab[]>([]);
  let activeId = $state("");
  let tabBarOrientation = $state<TabBarOrientation>("horizontal");
  let outputUnlisten: undefined | (() => void);
  let exitUnlisten: undefined | (() => void);
  let configUnlisten: undefined | (() => void);
  let paneMenuUnlisten: undefined | (() => void);
  let terminalMeasureContainer: HTMLDivElement;
  let appTheme: "light" | "dark" = "dark";
  let resizeDrag = $state<{
    tabId: string;
    baseTree: TerminalTab["tree"];
    firstPaneId: string;
    secondPaneId: string;
    direction: SplitDirection;
    startClient: number;
    containerPixels: number;
  } | null>(null);
  let dragState = $state<{ kind: "pane" | "tab"; id: string } | null>(null);
  let dropTarget = $state<{ paneId: string; zone: PaneDropZone } | null>(null);
  let pointerDrag = $state<{
    kind: "pane" | "tab";
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
    target: HTMLElement;
  } | null>(null);

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
    keybindings = readKeybindingMap(snapshot.effective_config.root, navigator.platform.toLowerCase().includes("mac"));
    const next = await unwrapCommand(commands.getTerminalSettingsForTheme({ resolved_theme: appTheme }));
    settings = next;
    tabBarOrientation = next.tab_bar_orientation;
    syncSettingsVariables(next);
    for (const tab of tabs) {
      for (const pane of tab.panes) {
        if (pane.term) pane.term.options = xtermOptions(next);
        terminalTabs.scheduleFit(pane.id);
      }
    }
  }

  function measureNewTerminal(cwd: string | null = null) {
    if (!settings) throw new Error("Terminal settings are not loaded");
    const measuredSize = measureTerminalFit(terminalMeasureContainer, settings, { cols: initialCols, rows: initialRows });
    return {
      ...toTerminalSessionSizeInput(measuredSize),
      resolved_theme: appTheme,
      cwd,
    };
  }

  async function newSession() {
    try {
      if (!settings) await loadSettings();
      await tick();
      const info = await unwrapCommand(commands.createTerminalSession(measureNewTerminal()));
      const tab = createTerminalTab(info);
      tabs = [...tabs, tab];
      activeId = tab.id;
      await tick();
      await terminalTabs.mountTerminal(tab.activePaneId);
      terminalPaneById(tab, tab.activePaneId)?.term?.focus();
    } catch (error) {
      settingsError = error instanceof Error ? error.message : String(error);
    }
  }

  async function activateTab(id: string) {
    activeId = id;
    const tab = tabs.find((item) => item.id === id);
    if (!tab) return;
    await tick();
    await mountAndFitTabPanes(tab);
    terminalPaneById(tab, tab.activePaneId)?.term?.focus();
  }

  async function activatePane(paneId: string) {
    const tab = tabs.find((item) => item.panes.some((pane) => pane.id === paneId));
    if (!tab) return;
    tab.activePaneId = paneId;
    refreshTerminalTabTitle(tab);
    await tick();
    await terminalTabs.mountTerminal(paneId);
    terminalTabs.scheduleFit(paneId);
    terminalPaneById(tab, paneId)?.term?.focus();
  }

  async function closeTab(id: string) {
    const tab = tabs.find((item) => item.id === id);
    if (!tab) return;
    const shouldClose = await confirmRunningPanes(tab.panes);
    if (!shouldClose) return;
    disposeTerminalTab(tab);
    for (const pane of tab.panes) {
      if (pane.status === "running") {
        await unwrapCommand(commands.closeTerminalSession(pane.id)).catch((error) => {
          settingsError = error instanceof Error ? error.message : String(error);
        });
      }
    }
    const index = tabs.findIndex((item) => item.id === id);
    tabs = tabs.filter((item) => item.id !== id);
    if (activeId === id) {
      activeId = tabs[Math.max(0, index - 1)]?.id ?? tabs[0]?.id ?? "";
      if (activeId) await activateTab(activeId);
    }
  }

  function findTabByPaneId(paneId: string): TerminalTab {
    const tab = tabs.find((item) => item.panes.some((pane) => pane.id === paneId));
    if (!tab) throw new Error(`tab for pane ${paneId} not found`);
    return tab;
  }

  async function splitActivePane(side: SplitSide) {
    const tab = activeTab;
    if (!tab) return;
    await splitPaneById(tab.activePaneId, side);
  }

  async function splitPaneById(paneId: string, side: SplitSide) {
    try {
      const tab = tabs.find((item) => item.panes.some((pane) => pane.id === paneId));
      if (!tab) throw new Error(`tab for pane ${paneId} not found`);
      const sourcePane = terminalPaneById(tab, paneId);
      if (!sourcePane) throw new Error(`pane ${paneId} not found`);
      if (!settings) await loadSettings();
      await tick();
      const cwd = sourcePane.currentDirectory.trim() || null;
      const info = await unwrapCommand(commands.createTerminalSession(measureNewTerminal(cwd)));
      const nextPane = createTerminalPane(info, tab.id);
      tab.panes = [...tab.panes, nextPane];
      tab.tree = splitPane(tab.tree, paneId, nextPane.id, side);
      tab.activePaneId = nextPane.id;
      refreshTerminalTabTitle(tab);
      await tick();
      await terminalTabs.mountTerminal(nextPane.id);
      await mountAndFitTabPanes(tab);
      nextPane.term?.focus();
    } catch (error) {
      settingsError = error instanceof Error ? error.message : String(error);
    }
  }

  async function closePane(paneId: string) {
    const tab = findTabByPaneId(paneId);
    const pane = terminalPaneById(tab, paneId);
    if (!pane) return;
    const shouldClose = await confirmRunningPanes([pane]);
    if (!shouldClose) return;

    if (tab.panes.length === 1) {
      await closeTab(tab.id);
      return;
    }

    disposeTerminalPane(pane);
    if (pane.status === "running") {
      await unwrapCommand(commands.closeTerminalSession(pane.id)).catch((error) => {
        settingsError = error instanceof Error ? error.message : String(error);
      });
    }
    const nextTree = removePane(tab.tree, pane.id);
    if (!nextTree) {
      await closeTab(tab.id);
      return;
    }
    tab.tree = nextTree;
    tab.panes = tab.panes.filter((item) => item.id !== pane.id);
    if (tab.activePaneId === pane.id) {
      tab.activePaneId = tab.panes[0]?.id ?? "";
    }
    refreshTerminalTabTitle(tab);
    await activatePane(tab.activePaneId);
    await mountAndFitTabPanes(tab);
  }

  async function confirmRunningPanes(panes: TerminalPane[]) {
    const runningCount = panes.filter((pane) => pane.status === "running").length;
    if (!runningCount) return true;
    if (!hasTauriRuntime()) return window.confirm("Close running terminal session?");
    return ask(runningCount === 1 ? "Close running terminal session?" : `Close ${runningCount} running terminal sessions?`, {
      title: "Close Terminal",
      kind: "warning",
      okLabel: "Close",
      cancelLabel: "Cancel",
    });
  }

  function startResize(event: PointerEvent, firstPaneId: string, secondPaneId: string, direction: SplitDirection) {
    const tab = activeTab;
    if (!tab) return;
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const split = target.parentElement;
    if (!split) return;
    const rect = split.getBoundingClientRect();
    resizeDrag = {
      tabId: tab.id,
      baseTree: clonePaneTree(tab.tree),
      firstPaneId,
      secondPaneId,
      direction,
      startClient: direction === "row" ? event.clientX : event.clientY,
      containerPixels: direction === "row" ? rect.width : rect.height,
    };
    target.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }

  function handlePointerMove(event: PointerEvent) {
    const drag = resizeDrag;
    if (drag) {
      const tab = tabs.find((item) => item.id === drag.tabId);
      if (!tab) return;
      const currentClient = drag.direction === "row" ? event.clientX : event.clientY;
      tab.tree = resizeAdjacentPanes({
        tree: drag.baseTree,
        firstPaneId: drag.firstPaneId,
        secondPaneId: drag.secondPaneId,
        deltaPixels: currentClient - drag.startClient,
        containerPixels: drag.containerPixels,
        minFirstPixels: drag.direction === "row" ? minPaneWidth : minPaneHeight,
        minSecondPixels: drag.direction === "row" ? minPaneWidth : minPaneHeight,
      });
      void tick().then(() => {
        for (const pane of tab.panes) terminalTabs.scheduleFit(pane.id);
      });
      return;
    }
    updatePointerDrag(event);
  }

  function handlePointerUp(event: PointerEvent) {
    const wasResizing = resizeDrag !== null;
    resizeDrag = null;
    if (wasResizing) return;
    void finishPointerDrag(event);
  }

  function handlePointerCancel(event: PointerEvent) {
    if (resizeDrag) resizeDrag = null;
    if (pointerDrag?.pointerId === event.pointerId) cancelDragInteraction();
  }

  function startPanePointerDrag(event: PointerEvent, paneId: string) {
    startPointerDrag(event, "pane", paneId);
  }

  function startTabPointerDrag(event: PointerEvent, tabId: string) {
    startPointerDrag(event, "tab", tabId);
  }

  function startPointerDrag(event: PointerEvent, kind: "pane" | "tab", id: string) {
    if (event.button !== 0) return;
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    pointerDrag = {
      kind,
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      target,
    };
    target.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }

  function cancelDragInteraction() {
    pointerDrag = null;
    dragState = null;
    dropTarget = null;
  }

  function updatePointerDrag(event: PointerEvent) {
    const drag = pointerDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active) {
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (distance < 6) return;
      drag.active = true;
      dragState = { kind: drag.kind, id: drag.id };
      if (!drag.target.hasPointerCapture(drag.pointerId)) {
        drag.target.setPointerCapture(drag.pointerId);
      }
    }
    dropTarget = paneDropTargetFromPoint(event.clientX, event.clientY);
    event.preventDefault();
    event.stopPropagation();
  }

  async function finishPointerDrag(event: PointerEvent) {
    const drag = pointerDrag;
    pointerDrag = null;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const target = paneDropTargetFromPoint(event.clientX, event.clientY);
    const wasActive = drag.active;
    dragState = null;
    dropTarget = null;
    if (!wasActive) return;
    if (target) {
      const sourcePaneId = drag.kind === "pane" ? drag.id : tabs.find((tab) => tab.id === drag.id)?.activePaneId ?? null;
      if (!sourcePaneId) return;
      try {
        await movePaneToPane(sourcePaneId, target.paneId, target.zone);
      } catch (error) {
        settingsError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  function paneDropTargetFromPoint(x: number, y: number): { paneId: string; zone: PaneDropZone } | null {
    const panes = [...document.querySelectorAll<HTMLElement>(".terminal-pane.active [data-pane-id]")];
    const containing = panes
      .map((pane) => ({ pane, rect: pane.getBoundingClientRect() }))
      .filter(({ rect }) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
      .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height);
    const match = containing[0];
    const paneId = match?.pane.dataset.paneId;
    return match && paneId ? { paneId, zone: dropZoneForRect(match.rect, x, y) } : null;
  }

  function dropZoneForRect(rect: DOMRect, x: number, y: number): PaneDropZone {
    const relativeX = (x - rect.left) / rect.width;
    const relativeY = (y - rect.top) / rect.height;
    const distances = [
      { zone: "left" as const, distance: relativeX },
      { zone: "right" as const, distance: 1 - relativeX },
      { zone: "up" as const, distance: relativeY },
      { zone: "down" as const, distance: 1 - relativeY },
    ];
    const nearest = distances.reduce((best, item) => (item.distance < best.distance ? item : best));
    return nearest.distance > 0.24 ? "center" : nearest.zone;
  }

  function handleWindowBlur() {
    if (dragState || pointerDrag) cancelDragInteraction();
    resizeDrag = null;
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "hidden") handleWindowBlur();
  }

  async function movePaneToPane(sourcePaneId: string, targetPaneId: string, zone: PaneDropZone) {
    const sourceTab = findTabByPaneId(sourcePaneId);
    const targetTab = findTabByPaneId(targetPaneId);
    if (sourceTab.id === targetTab.id) {
      targetTab.tree =
        zone === "center"
          ? swapPanes(targetTab.tree, sourcePaneId, targetPaneId)
          : movePaneIntoSplit(targetTab.tree, sourcePaneId, targetPaneId, zone);
      targetTab.activePaneId = sourcePaneId;
      refreshTerminalTabTitle(targetTab);
      await activatePane(sourcePaneId);
      await mountAndFitTabPanes(targetTab);
      return;
    }

    if (zone === "center") {
      await swapPanesAcrossTabs(sourceTab, sourcePaneId, targetTab, targetPaneId);
      return;
    }

    const sourcePane = terminalPaneById(sourceTab, sourcePaneId);
    if (!sourcePane) throw new Error(`source pane ${sourcePaneId} not found`);
    removePaneFromTab(sourceTab, sourcePaneId);
    sourcePane.tabId = targetTab.id;
    targetTab.panes = [...targetTab.panes, sourcePane];
    targetTab.tree = splitPane(targetTab.tree, targetPaneId, sourcePaneId, zone);
    targetTab.activePaneId = sourcePaneId;
    activeId = targetTab.id;
    refreshTerminalTabTitle(targetTab);
    await tick();
    await mountAndFitTabPanes(targetTab);
    terminalTabs.scheduleFit(sourcePaneId);
    sourcePane.term?.focus();
  }

  async function swapPanesAcrossTabs(sourceTab: TerminalTab, sourcePaneId: string, targetTab: TerminalTab, targetPaneId: string) {
    const sourcePane = terminalPaneById(sourceTab, sourcePaneId);
    const targetPane = terminalPaneById(targetTab, targetPaneId);
    if (!sourcePane) throw new Error(`source pane ${sourcePaneId} not found`);
    if (!targetPane) throw new Error(`target pane ${targetPaneId} not found`);

    sourceTab.tree = replacePane(sourceTab.tree, sourcePaneId, targetPaneId);
    targetTab.tree = replacePane(targetTab.tree, targetPaneId, sourcePaneId);
    sourcePane.tabId = targetTab.id;
    targetPane.tabId = sourceTab.id;
    sourceTab.panes = sourceTab.panes.map((pane) => (pane.id === sourcePaneId ? targetPane : pane));
    targetTab.panes = targetTab.panes.map((pane) => (pane.id === targetPaneId ? sourcePane : pane));
    if (sourceTab.activePaneId === sourcePaneId) sourceTab.activePaneId = targetPaneId;
    if (targetTab.activePaneId === targetPaneId) targetTab.activePaneId = sourcePaneId;
    activeId = targetTab.id;
    refreshTerminalTabTitle(sourceTab);
    refreshTerminalTabTitle(targetTab);
    await activatePane(sourcePaneId);
    await mountAndFitTabPanes(sourceTab);
    await mountAndFitTabPanes(targetTab);
  }

  async function detachPaneToTab(paneId: string) {
    const sourceTab = findTabByPaneId(paneId);
    if (sourceTab.panes.length === 1) return;
    const pane = terminalPaneById(sourceTab, paneId);
    if (!pane) throw new Error(`pane ${paneId} not found`);
    removePaneFromTab(sourceTab, paneId);
    const newTab = createTerminalTabFromPane(pane);
    tabs = [...tabs, newTab];
    activeId = newTab.id;
    refreshTerminalTabTitle(newTab);
    await activateTab(newTab.id);
    await mountAndFitTabPanes(sourceTab);
    await mountAndFitTabPanes(newTab);
  }

  async function mountAndFitTabPanes(tab: TerminalTab) {
    await tick();
    for (const pane of tab.panes) {
      await terminalTabs.mountTerminal(pane.id);
      terminalTabs.scheduleFit(pane.id);
    }
  }

  function removePaneFromTab(tab: TerminalTab, paneId: string) {
    const pane = terminalPaneById(tab, paneId);
    if (!pane) throw new Error(`pane ${paneId} not found in tab ${tab.id}`);
    const nextTree = removePane(tab.tree, paneId);
    tab.panes = tab.panes.filter((item) => item.id !== paneId);
    if (!nextTree || tab.panes.length === 0) {
      tabs = tabs.filter((item) => item.id !== tab.id);
      if (activeId === tab.id) activeId = tabs[0]?.id ?? "";
      return;
    }
    tab.tree = nextTree;
    if (tab.activePaneId === paneId) {
      const nextPane = tab.panes[0];
      if (!nextPane) throw new Error(`tab ${tab.id} has no pane after removal`);
      tab.activePaneId = nextPane.id;
    }
    refreshTerminalTabTitle(tab);
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

  async function openPaneContextMenu(event: MouseEvent, paneId: string) {
    event.preventDefault();
    await activatePane(paneId);
    if (!hasTauriRuntime()) return;
    await unwrapCommand(
      commands.showPaneContextMenu({
        x: event.clientX,
        y: event.clientY,
        pane_id: paneId,
      }),
    ).catch((error) => {
      settingsError = error instanceof Error ? error.message : String(error);
    });
  }

  function handlePaneMenu(event: PaneMenuEvent) {
    if (event.action === "split_left") {
      void splitPaneById(event.pane_id, "left");
      return;
    }
    if (event.action === "split_right") {
      void splitPaneById(event.pane_id, "right");
      return;
    }
    if (event.action === "split_up") {
      void splitPaneById(event.pane_id, "up");
      return;
    }
    if (event.action === "split_down") {
      void splitPaneById(event.pane_id, "down");
      return;
    }
    settingsError = `Unsupported pane menu action: ${event.action}`;
  }

  function handleKeyboard(event: KeyboardEvent) {
    const command = commandForKeyboardEvent(event);
    if (!command) return;
    event.preventDefault();
    runTerminalCommand(command);
  }

  function commandForKeyboardEvent(event: KeyboardEvent): TerminalCommandId | null {
    if (!keybindings) return null;
    for (const [command, binding] of Object.entries(keybindings) as Array<[TerminalCommandId, string]>) {
      if (eventMatchesBinding(event, binding)) return command;
    }
    return null;
  }

  function runTerminalCommand(command: TerminalCommandId) {
    if (command === "terminal.newTab") {
      void newSession();
      return;
    }
    if (command === "terminal.closeTab" && activeId) {
      void closeTab(activeId);
      return;
    }
    if (command === "terminal.splitRight" && activeId) {
      void splitActivePane("right");
      return;
    }
    if (command === "terminal.splitLeft" && activeId) {
      void splitActivePane("left");
      return;
    }
    if (command === "terminal.splitUp" && activeId) {
      void splitActivePane("up");
      return;
    }
    if (command === "terminal.splitDown" && activeId) {
      void splitActivePane("down");
      return;
    }
    if (command === "terminal.closePane" && activeTab) {
      void closePane(activeTab.activePaneId);
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
      void listen<PaneMenuEvent>("terminal://pane-menu", (event) => handlePaneMenu(event.payload)).then((dispose) => {
        paneMenuUnlisten = dispose;
      });
    }
    window.addEventListener("keydown", handleKeyboard);
    window.addEventListener("pointermove", handlePointerMove, { capture: true });
    window.addEventListener("pointerup", handlePointerUp, { capture: true });
    window.addEventListener("pointercancel", handlePointerCancel, { capture: true });
    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("keydown", handleKeyboard);
      window.removeEventListener("pointermove", handlePointerMove, { capture: true });
      window.removeEventListener("pointerup", handlePointerUp, { capture: true });
      window.removeEventListener("pointercancel", handlePointerCancel, { capture: true });
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      outputUnlisten?.();
      exitUnlisten?.();
      configUnlisten?.();
      paneMenuUnlisten?.();
      for (const tab of tabs) {
        disposeTerminalTab(tab);
        for (const pane of tab.panes) {
          if (pane.status === "running") void unwrapCommand(commands.closeTerminalSession(pane.id));
        }
      }
    };
  });

  $effect(() => {
    if (activeId) {
      void tick().then(() => {
        const tab = tabs.find((item) => item.id === activeId);
        if (!tab) return;
        void mountAndFitTabPanes(tab);
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
      {startTabPointerDrag}
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
      {#each tabs as tab (tab.id)}
        <div class:active={tab.id === activeId} class="terminal-pane">
          <TerminalPaneTree
            {tab}
            tree={tab.tree}
            activePaneId={tab.activePaneId}
            {activatePane}
            {closePane}
            {openPaneContextMenu}
            {startResize}
            {startPanePointerDrag}
            dragActive={dragState !== null}
            {dropTarget}
          />
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
      {startTabPointerDrag}
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
    min-width: 0;
    min-height: 0;
    background: var(--terminal-bg);
    overflow: hidden;
    visibility: hidden;
    pointer-events: none;
  }

  .terminal-pane.active {
    visibility: visible;
    pointer-events: auto;
  }

  .terminal-mount {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
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
    background-color: var(--terminal-bg);
    scrollbar-width: none;
  }

  :global(.xterm .xterm-viewport::-webkit-scrollbar) {
    width: 0;
    height: 0;
    display: none;
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
