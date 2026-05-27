<script lang="ts">
  import { onMount, tick } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { ask } from "@tauri-apps/plugin-dialog";
  import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
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
    createTerminalTabFromPane,
    createTerminalTabController,
    detachTerminalPane,
    disposeTerminalPane,
    disposeTerminalTab,
    measureTerminalFit,
    refreshTerminalTabTitle,
    terminalPaneById,
    type TerminalExitEvent,
    type TerminalOutputEvent,
    type TerminalPane,
    type TerminalTab,
  } from "$lib/terminal/tabs";
  import { toTerminalSessionSizeInput } from "$lib/terminal/sizes";
  import { terminalMenuCanRedo, terminalMenuCanUndo } from "$lib/terminal/menu-history";
  import { t } from "$lib/i18n";

  type TerminalMenuCommand =
    | "new_window"
    | "new_tab"
    | "split_right"
    | "split_left"
    | "split_down"
    | "split_up"
    | "close"
    | "close_tab"
    | "close_window"
    | "undo"
    | "redo"
    | "copy"
    | "paste"
    | "paste_selection"
    | "select_all"
    | "find"
    | "find_next"
    | "find_previous"
    | "hide_find_bar"
    | "use_selection_for_find"
    | "jump_to_selection"
    | "reset_font_size"
    | "increase_font_size"
    | "decrease_font_size"
    | "change_tab_title"
    | "toggle_read_only"
    | "show_previous_tab"
    | "show_next_tab"
    | "move_tab_to_new_window"
    | "zoom_split"
    | "select_previous_split"
    | "select_next_split"
    | "select_split_left"
    | "select_split_right"
    | "select_split_up"
    | "select_split_down"
    | "resize_split_left"
    | "resize_split_right"
    | "resize_split_up"
    | "resize_split_down";

  type TerminalMenuEvent = {
    command: TerminalMenuCommand;
  };

  type StoredPane = {
    id: string;
    title: string;
    baseTitle: string;
    command: string;
    currentDirectory: string;
    titleOverride: string;
    readOnly: boolean;
    status: TerminalPane["status"];
    serialized: string;
    lastCols: number;
    lastRows: number;
    lastPixelWidth: number;
    lastPixelHeight: number;
    nextOutputSequence: string;
  };

  type StoredTab = {
    customTitle: string;
    activePaneId: string;
    tree: TerminalTab["tree"];
    panes: StoredPane[];
  };

  const initialCols = 80;
  const initialRows = 24;
  const minPaneWidth = 160;
  const minPaneHeight = 96;
  type PaneMenuEvent = {
    action:
      | "copy"
      | "paste"
      | "reset_terminal"
      | "toggle_read_only"
      | "change_tab_title"
      | "split_left"
      | "split_right"
      | "split_up"
    | "split_down";
    pane_id: string;
  };
  type TextInputElement = HTMLInputElement | HTMLTextAreaElement;
  type TextEditSnapshot = {
    selectionEnd: number;
    selectionStart: number;
    value: string;
  };
  type TextEditHistory = {
    current: TextEditSnapshot;
    redo: TextEditSnapshot[];
    undo: TextEditSnapshot[];
  };
  type CreateTabAction = {
    kind: "create_tab";
    tabId: string;
  };
  type CreatePaneAction = {
    kind: "create_pane";
    paneId: string;
    side: SplitSide;
    tabId: string;
    targetPaneId: string;
  };
  type CloseTabAction = {
    kind: "close_tab";
    tab: TerminalTab;
    index: number;
    previousActiveId: string;
  };
  type ClosePaneAction = {
    kind: "close_pane";
    pane: TerminalPane;
    tabId: string;
    index: number;
    tree: TerminalTab["tree"];
    activePaneId: string;
  };
  type TerminalUndoAction =
    | CreateTabAction
    | CreatePaneAction
    | CloseTabAction
    | ClosePaneAction;
  type TerminalRedoAction =
    | {
        kind: "create_tab";
      }
    | {
        kind: "create_pane";
        side: SplitSide;
        tabId: string;
        targetPaneId: string;
      }
    | CloseTabAction
    | ClosePaneAction;

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
  let terminalMenuUnlisten: undefined | (() => void);
  let terminalMeasureContainer: HTMLDivElement;
  let appTheme: "light" | "dark" = "dark";
  let findVisible = $state(false);
  let findQuery = $state("");
  let movedPaneIds = new Set<string>();
  let findInput = $state<HTMLInputElement>();
  let lastFocusedTextInput: TextInputElement | null = null;
  let serializedMenuState = "";
  let undoStack: TerminalUndoAction[] = [];
  let redoStack: TerminalRedoAction[] = [];
  const textEditHistories = new WeakMap<TextInputElement, TextEditHistory>();
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
    notifySelectionChange: () => {
      syncTerminalMenuState();
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

  function currentWindowLabel() {
    return hasTauriRuntime() ? getCurrentWindow().label : "main";
  }

  function measureNewTerminal(cwd: string | null = null) {
    if (!settings) throw new Error("Terminal settings are not loaded");
    const measuredSize = measureTerminalFit(terminalMeasureContainer, settings, { cols: initialCols, rows: initialRows });
    return {
      ...toTerminalSessionSizeInput(measuredSize),
      resolved_theme: appTheme,
      cwd,
      window_label: currentWindowLabel(),
    };
  }

  async function newSession({ recordHistory = true }: { recordHistory?: boolean } = {}) {
    try {
      if (!settings) await loadSettings();
      await tick();
      const info = await unwrapCommand(commands.createTerminalSession(measureNewTerminal()));
      const tab = createTerminalTab(info);
      tabs = [...tabs, tab];
      activeId = tab.id;
      await tick();
      await mountTerminalWhenReady(tab.activePaneId);
      await flushTerminalOutputBacklog(tab.activePaneId);
      terminalPaneById(tab, tab.activePaneId)?.term?.focus();
      if (recordHistory) {
        pushUndoAction({ kind: "create_tab", tabId: tab.id });
      } else {
        syncTerminalMenuState();
      }
    } catch (error) {
      settingsError = error instanceof Error ? error.message : String(error);
    }
  }

  async function ensureStartupSession(restored: boolean) {
    if (restored || tabs.length > 0) return;
    await newSession({ recordHistory: false });
  }

  async function flushTerminalOutputBacklog(paneId: string) {
    if (!hasTauriRuntime()) return;
    const event = await unwrapCommand(commands.takeTerminalOutputBacklog({ session_id: paneId }));
    if (event) terminalTabs.enqueueOutput(event);
  }

  function activePane(): TerminalPane | null {
    const tab = activeTab;
    if (!tab) return null;
    return terminalPaneById(tab, tab.activePaneId) ?? null;
  }

  async function activateTab(id: string) {
    activeId = id;
    const tab = tabs.find((item) => item.id === id);
    if (!tab) return;
    await tick();
    await mountAndFitTabPanes(tab);
    terminalPaneById(tab, tab.activePaneId)?.term?.focus();
    syncTerminalMenuState();
  }

  async function activatePane(paneId: string) {
    const tab = tabs.find((item) => item.panes.some((pane) => pane.id === paneId));
    if (!tab) return;
    tab.activePaneId = paneId;
    refreshTerminalTabTitle(tab);
    await tick();
    await mountTerminalWhenReady(paneId);
    terminalTabs.scheduleFit(paneId);
    terminalPaneById(tab, paneId)?.term?.focus();
    syncTerminalMenuState();
  }

  async function closeTab(id: string, { recordHistory = false }: { recordHistory?: boolean } = {}) {
    const tab = tabs.find((item) => item.id === id);
    if (!tab) return;
    const shouldClose = await confirmRunningPanes(tab.panes);
    if (!shouldClose) return;
    const index = tabs.findIndex((item) => item.id === id);
    const previousActiveId = activeId;
    if (recordHistory) {
      for (const pane of tab.panes) detachTerminalPane(pane);
      pushUndoAction({ kind: "close_tab", tab, index, previousActiveId });
    } else {
      disposeTerminalTab(tab);
      for (const pane of tab.panes) {
        if (pane.status === "running") {
          await closePaneSession(pane);
        }
      }
    }
    tabs = tabs.filter((item) => item.id !== id);
    if (activeId === id) {
      activeId = tabs[Math.max(0, index - 1)]?.id ?? tabs[0]?.id ?? "";
      if (activeId) await activateTab(activeId);
    }
    syncTerminalMenuState();
  }

  async function closeActiveTarget() {
    const tab = activeTab;
    if (!tab) {
      await closeCurrentWindow();
      return;
    }
    if (tab.panes.length > 1) {
      await closePane(tab.activePaneId, { recordHistory: true });
      return;
    }
    await closeTab(tab.id, { recordHistory: true });
  }

  async function closeCurrentWindow() {
    if (hasTauriRuntime()) {
      await getCurrentWindow().close();
    }
  }

  function findTabByPaneId(paneId: string): TerminalTab {
    const tab = tabs.find((item) => item.panes.some((pane) => pane.id === paneId));
    if (!tab) throw new Error(`tab for pane ${paneId} not found`);
    return tab;
  }

  async function splitActivePane(side: SplitSide, { recordHistory = true }: { recordHistory?: boolean } = {}) {
    const tab = activeTab;
    if (!tab) return;
    await splitPaneById(tab.activePaneId, side, { recordHistory });
  }

  async function splitPaneById(paneId: string, side: SplitSide, { recordHistory = true }: { recordHistory?: boolean } = {}) {
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
      await mountTerminalWhenReady(nextPane.id);
      await flushTerminalOutputBacklog(nextPane.id);
      await mountAndFitTabPanes(tab);
      nextPane.term?.focus();
      if (recordHistory) {
        pushUndoAction({ kind: "create_pane", paneId: nextPane.id, side, tabId: tab.id, targetPaneId: paneId });
      } else {
        syncTerminalMenuState();
      }
    } catch (error) {
      settingsError = error instanceof Error ? error.message : String(error);
    }
  }

  async function closePane(paneId: string, { recordHistory = false }: { recordHistory?: boolean } = {}) {
    const tab = findTabByPaneId(paneId);
    const pane = terminalPaneById(tab, paneId);
    if (!pane) return;
    const shouldClose = await confirmRunningPanes([pane]);
    if (!shouldClose) return;

    if (tab.panes.length === 1) {
      await closeTab(tab.id, { recordHistory });
      return;
    }

    const index = tab.panes.findIndex((item) => item.id === pane.id);
    const previousTree = clonePaneTree(tab.tree);
    const previousActivePaneId = tab.activePaneId;
    if (recordHistory) {
      detachTerminalPane(pane);
    } else {
      disposeTerminalPane(pane);
      if (pane.status === "running") await closePaneSession(pane);
    }
    const nextTree = removePane(tab.tree, pane.id);
    if (!nextTree) {
      await closeTab(tab.id, { recordHistory });
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
    if (recordHistory) {
      pushUndoAction({ kind: "close_pane", pane, tabId: tab.id, index, tree: previousTree, activePaneId: previousActivePaneId });
    } else {
      syncTerminalMenuState();
    }
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

  async function closePaneSession(pane: TerminalPane) {
    await unwrapCommand(commands.closeTerminalSession(pane.id)).catch((error) => {
      settingsError = error instanceof Error ? error.message : String(error);
    });
  }

  function pushUndoAction(action: TerminalUndoAction) {
    undoStack = appendUndoAction(undoStack, action);
    clearRedoStack();
    syncTerminalMenuState();
  }

  async function runTerminalUndo() {
    const action = undoStack.at(-1);
    if (!action) return;
    undoStack = undoStack.slice(0, -1);
    const redoAction = await applyTerminalUndo(action);
    redoStack = appendRedoAction(redoStack, redoAction);
    syncTerminalMenuState();
  }

  async function runTerminalRedo() {
    const action = redoStack.at(-1);
    if (!action) return;
    redoStack = redoStack.slice(0, -1);
    const redone = await applyTerminalRedo(action);
    undoStack = appendUndoAction(undoStack, redone);
    syncTerminalMenuState();
  }

  function appendUndoAction(stack: TerminalUndoAction[], action: TerminalUndoAction) {
    const next = [...stack, action];
    const discarded = next.length > 50 ? next.shift() : undefined;
    if (discarded) void finalizeDiscardedAction(discarded);
    return next;
  }

  function appendRedoAction(stack: TerminalRedoAction[], action: TerminalRedoAction) {
    const next = [...stack, action];
    const discarded = next.length > 50 ? next.shift() : undefined;
    if (discarded) void finalizeDiscardedAction(discarded);
    return next;
  }

  function clearRedoStack() {
    for (const action of redoStack) void finalizeDiscardedAction(action);
    redoStack = [];
  }

  async function finalizeDiscardedAction(action: TerminalUndoAction | TerminalRedoAction) {
    if (action.kind === "close_tab") {
      for (const pane of action.tab.panes) {
        if (pane.status === "running") await closePaneSession(pane);
      }
      return;
    }
    if (action.kind === "close_pane" && action.pane.status === "running") {
      await closePaneSession(action.pane);
    }
  }

  async function applyTerminalUndo(action: TerminalUndoAction): Promise<TerminalRedoAction> {
    if (action.kind === "create_tab") {
      await closeCreatedTabForUndo(action.tabId);
      return { kind: "create_tab" };
    }
    if (action.kind === "create_pane") {
      await closeCreatedPaneForUndo(action.tabId, action.paneId);
      return { kind: "create_pane", side: action.side, tabId: action.tabId, targetPaneId: action.targetPaneId };
    }
    if (action.kind === "close_tab") {
      await restoreClosedTab(action);
      return action;
    }
    if (action.kind === "close_pane") {
      await restoreClosedPane(action);
    }
    return action;
  }

  async function applyTerminalRedo(action: TerminalRedoAction): Promise<TerminalUndoAction> {
    if (action.kind === "create_tab") {
      return restoreCreatedTabForRedo();
    }
    if (action.kind === "create_pane") {
      return restoreCreatedPaneForRedo(action);
    }
    if (action.kind === "close_tab") {
      await closeRestoredTabForRedo(action.tab.id);
      return action;
    }
    if (action.kind === "close_pane") {
      await closeRestoredPaneForRedo(action.tabId, action.pane.id);
    }
    return action;
  }

  async function closeCreatedTabForUndo(tabId: string) {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) return;
    for (const pane of tab.panes) {
      disposeTerminalPane(pane);
      if (pane.status === "running") await closePaneSession(pane);
    }
    tabs = tabs.filter((item) => item.id !== tab.id);
    if (activeId === tab.id) {
      activeId = tabs.at(-1)?.id ?? "";
      if (activeId) await activateTab(activeId);
    }
  }

  async function closeCreatedPaneForUndo(tabId: string, paneId: string) {
    const tab = tabs.find((item) => item.id === tabId);
    const pane = tab ? terminalPaneById(tab, paneId) : undefined;
    if (!tab || !pane) return;
    disposeTerminalPane(pane);
    if (pane.status === "running") await closePaneSession(pane);
    const nextTree = removePane(tab.tree, paneId);
    if (!nextTree) {
      tabs = tabs.filter((item) => item.id !== tab.id);
      activeId = tabs.at(-1)?.id ?? "";
      if (activeId) await activateTab(activeId);
      return;
    }
    tab.tree = nextTree;
    tab.panes = tab.panes.filter((item) => item.id !== paneId);
    tab.activePaneId = tab.panes[0]?.id ?? "";
    refreshTerminalTabTitle(tab);
    await activatePane(tab.activePaneId);
    await mountAndFitTabPanes(tab);
  }

  async function restoreCreatedTabForRedo(): Promise<TerminalUndoAction> {
    await newSession({ recordHistory: false });
    const tab = tabs.find((item) => item.id === activeId);
    if (!tab) throw new Error("redo did not create a terminal tab");
    return { kind: "create_tab", tabId: tab.id };
  }

  async function restoreCreatedPaneForRedo(action: Extract<TerminalRedoAction, { kind: "create_pane" }>): Promise<TerminalUndoAction> {
    const tab = tabs.find((item) => item.id === action.tabId);
    if (!tab) throw new Error(`redo target tab ${action.tabId} not found`);
    activeId = tab.id;
    const targetPaneId = terminalPaneById(tab, action.targetPaneId) ? action.targetPaneId : tab.activePaneId;
    await splitPaneById(targetPaneId, action.side, { recordHistory: false });
    const pane = activePane();
    if (!pane) throw new Error("redo did not create a terminal pane");
    return { ...action, paneId: pane.id, targetPaneId };
  }

  async function restoreClosedTab(action: Extract<TerminalUndoAction, { kind: "close_tab" }>) {
    tabs = [...tabs.slice(0, action.index), action.tab, ...tabs.slice(action.index)];
    activeId = action.tab.id;
    await tick();
    await mountAndFitTabPanes(action.tab);
    terminalPaneById(action.tab, action.tab.activePaneId)?.term?.focus();
  }

  async function restoreClosedPane(action: Extract<TerminalUndoAction, { kind: "close_pane" }>) {
    const tab = tabs.find((item) => item.id === action.tabId);
    if (!tab) return;
    action.pane.tabId = tab.id;
    tab.panes = [...tab.panes.slice(0, action.index), action.pane, ...tab.panes.slice(action.index)];
    tab.tree = clonePaneTree(action.tree);
    tab.activePaneId = action.activePaneId;
    refreshTerminalTabTitle(tab);
    activeId = tab.id;
    await tick();
    await mountAndFitTabPanes(tab);
    terminalPaneById(tab, tab.activePaneId)?.term?.focus();
  }

  async function closeRestoredTabForRedo(tabId: string) {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) return;
    for (const pane of tab.panes) detachTerminalPane(pane);
    tabs = tabs.filter((item) => item.id !== tabId);
    if (activeId === tabId) {
      activeId = tabs.at(-1)?.id ?? "";
      if (activeId) await activateTab(activeId);
    }
  }

  async function closeRestoredPaneForRedo(tabId: string, paneId: string) {
    const tab = tabs.find((item) => item.id === tabId);
    const pane = tab ? terminalPaneById(tab, paneId) : undefined;
    if (!tab || !pane) return;
    detachTerminalPane(pane);
    const nextTree = removePane(tab.tree, paneId);
    if (!nextTree) {
      tabs = tabs.filter((item) => item.id !== tab.id);
      activeId = tabs.at(-1)?.id ?? "";
      if (activeId) await activateTab(activeId);
      return;
    }
    tab.tree = nextTree;
    tab.panes = tab.panes.filter((item) => item.id !== paneId);
    tab.activePaneId = tab.panes[0]?.id ?? "";
    refreshTerminalTabTitle(tab);
    await activatePane(tab.activePaneId);
    await mountAndFitTabPanes(tab);
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

  async function moveActiveTabToNewWindow() {
    const tab = activeTab;
    if (!tab) return;
    const handoffKey = storeTabHandoff(tab);
    await unwrapCommand(commands.openMainWindow(`/?tab_handoff=${encodeURIComponent(handoffKey)}`));
    movedPaneIds = new Set([...movedPaneIds, ...tab.panes.map((pane) => pane.id)]);
    disposeTerminalTab(tab);
    tabs = tabs.filter((item) => item.id !== tab.id);
    activeId = tabs[0]?.id ?? "";
    if (activeId) await activateTab(activeId);
  }

  function storeTabHandoff(tab: TerminalTab): string {
    const key = `nocturne:tab-handoff:${crypto.randomUUID()}`;
    const stored: StoredTab = {
      customTitle: tab.customTitle,
      activePaneId: tab.activePaneId,
      tree: clonePaneTree(tab.tree),
      panes: tab.panes.map((pane) => ({
        id: pane.id,
        title: pane.title,
        baseTitle: pane.baseTitle,
        command: pane.command,
        currentDirectory: pane.currentDirectory,
        titleOverride: pane.titleOverride,
        readOnly: pane.readOnly,
        status: pane.status,
        serialized: pane.serialize?.serialize({ scrollback: 1000 }) ?? "",
        lastCols: pane.lastCols,
        lastRows: pane.lastRows,
        lastPixelWidth: pane.lastPixelWidth,
        lastPixelHeight: pane.lastPixelHeight,
        nextOutputSequence: pane.nextOutputSequence.toString(),
      })),
    };
    localStorage.setItem(key, JSON.stringify(stored));
    return key;
  }

  async function restoreTabHandoff() {
    const key = new URLSearchParams(window.location.search).get("tab_handoff");
    if (!key) return false;
    const raw = localStorage.getItem(key);
    if (!raw) throw new Error(`tab handoff ${key} not found`);
    localStorage.removeItem(key);
    const stored = JSON.parse(raw) as StoredTab;
    const restoredPanes: TerminalPane[] = [];
    for (const pane of stored.panes) {
      const info = await unwrapCommand(commands.existingTerminalSessionInfo({ session_id: pane.id }));
      const restored = createTerminalPane(info, "");
      restored.title = pane.title;
      restored.baseTitle = pane.baseTitle;
      restored.command = pane.command;
      restored.currentDirectory = pane.currentDirectory;
      restored.titleOverride = pane.titleOverride;
      restored.readOnly = pane.readOnly;
      restored.status = pane.status;
      restored.lastCols = pane.lastCols;
      restored.lastRows = pane.lastRows;
      restored.lastPixelWidth = pane.lastPixelWidth;
      restored.lastPixelHeight = pane.lastPixelHeight;
      restored.nextOutputSequence = BigInt(pane.nextOutputSequence ?? "0");
      restored.outputQueue = pane.serialized ? [pane.serialized] : [];
      restoredPanes.push(restored);
    }
    const firstPane = restoredPanes[0];
    if (!firstPane) throw new Error("tab handoff has no panes");
    await unwrapCommand(
      commands.transferTerminalSessionsToWindow({
        session_ids: restoredPanes.map((pane) => pane.id),
        window_label: currentWindowLabel(),
      }),
    );
    const tab = createTerminalTabFromPane(firstPane);
    tab.customTitle = stored.customTitle;
    tab.activePaneId = stored.activePaneId;
    tab.tree = clonePaneTree(stored.tree);
    for (const pane of restoredPanes) pane.tabId = tab.id;
    tab.panes = restoredPanes;
    refreshTerminalTabTitle(tab);
    tabs = [tab];
    activeId = tab.id;
    await tick();
    await mountAndFitTabPanes(tab);
    terminalPaneById(tab, tab.activePaneId)?.term?.focus();
    syncTerminalMenuState();
    return true;
  }

  async function mountAndFitTabPanes(tab: TerminalTab) {
    await tick();
    for (const pane of tab.panes) {
      await mountTerminalWhenReady(pane.id);
      await flushTerminalOutputBacklog(pane.id);
      terminalTabs.scheduleFit(pane.id);
    }
  }

  async function mountTerminalWhenReady(paneId: string) {
    await waitForPaneContainer(paneId);
    await terminalTabs.mountTerminal(paneId);
  }

  async function waitForPaneContainer(paneId: string) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const pane = terminalPaneById(findTabByPaneId(paneId), paneId);
      if (pane?.container) return;
      await tick();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    throw new Error(`terminal pane ${paneId} did not mount a container`);
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
        window_label: currentWindowLabel(),
      }),
    ).catch((error) => {
      settingsError = error instanceof Error ? error.message : String(error);
    });
  }

  async function openPaneContextMenu(event: MouseEvent, paneId: string) {
    event.preventDefault();
    await activatePane(paneId);
    if (!hasTauriRuntime()) return;
    const pane = terminalPaneById(findTabByPaneId(paneId), paneId);
    if (!pane) throw new Error(`pane ${paneId} not found`);
    await unwrapCommand(
      commands.showPaneContextMenu({
        x: event.clientX,
        y: event.clientY,
        pane_id: paneId,
        window_label: currentWindowLabel(),
        has_selection: pane.term?.hasSelection() === true,
        read_only: pane.readOnly,
      }),
    ).catch((error) => {
      settingsError = error instanceof Error ? error.message : String(error);
    });
  }

  function handlePaneMenu(event: PaneMenuEvent) {
    if (event.action === "copy") {
      void copyPaneSelection(event.pane_id);
      return;
    }
    if (event.action === "paste") {
      void pasteIntoPane(event.pane_id);
      return;
    }
    if (event.action === "reset_terminal") {
      resetPaneTerminal(event.pane_id);
      return;
    }
    if (event.action === "toggle_read_only") {
      togglePaneReadOnly(event.pane_id);
      return;
    }
    if (event.action === "change_tab_title") {
      changeTabTitleForPane(event.pane_id);
      return;
    }
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

  async function copyPaneSelection(paneId: string) {
    const pane = terminalPaneById(findTabByPaneId(paneId), paneId);
    if (!pane?.term || !pane.term.hasSelection()) return;
    const selection = pane.term.getSelection();
    if (!selection) return;
    if (hasTauriRuntime()) await writeText(selection);
    else await navigator.clipboard.writeText(selection);
  }

  async function pasteIntoPane(paneId: string) {
    const pane = terminalPaneById(findTabByPaneId(paneId), paneId);
    if (!pane?.term || pane.readOnly) return;
    const text = hasTauriRuntime() ? await readText() : await navigator.clipboard.readText();
    if (!text) return;
    pane.term.paste(text);
  }

  async function pasteSelectionIntoActivePane() {
    const pane = activePane();
    if (!pane?.term || pane.readOnly || !pane.term.hasSelection()) return;
    const selection = pane.term.getSelection();
    if (!selection) return;
    pane.term.paste(selection);
  }

  function syncTerminalMenuState() {
    const pane = activePane();
    const hasActiveTab = activeTab !== undefined;
    const hasActivePane = pane !== null;
    const hasSelection = pane?.term?.hasSelection() === true;
    const textInput = activeTextInput();
    const textInputHasSelection = textInput ? textInput.selectionStart !== textInput.selectionEnd : false;
    const textHistory = textInput ? textEditHistories.get(textInput) : undefined;
    const canUndo = terminalMenuCanUndo({
      activePaneWritable: pane !== null && !pane.readOnly,
      activeTextInputCanRedo: (textHistory?.redo.length ?? 0) > 0,
      activeTextInputCanUndo: textInput !== null && ((textHistory?.undo.length ?? 0) > 0 || textInput.value.length > 0),
      redoDepth: redoStack.length,
      undoDepth: undoStack.length,
    });
    const canRedo = terminalMenuCanRedo({
      activePaneWritable: pane !== null && !pane.readOnly,
      activeTextInputCanRedo: (textHistory?.redo.length ?? 0) > 0,
      activeTextInputCanUndo: textInput !== null && ((textHistory?.undo.length ?? 0) > 0 || textInput.value.length > 0),
      redoDepth: redoStack.length,
      undoDepth: undoStack.length,
    });
    const state = {
      can_edit_text: textInput !== null,
      can_undo_text: canUndo,
      can_redo_text: canRedo,
      has_active_tab: hasActiveTab,
      has_active_pane: hasActivePane,
      has_multiple_tabs: tabs.length > 1,
      has_multiple_panes: (activeTab?.panes.length ?? 0) > 1,
      has_selection: hasSelection || textInputHasSelection,
      can_paste: textInput !== null || (pane !== null && !pane.readOnly),
      can_paste_selection: hasSelection && pane !== null && !pane.readOnly,
      can_select_all: textInput !== null || hasActivePane,
      can_jump_to_selection: hasSelection,
      find_visible: findVisible,
      has_find_query: findQuery.trim().length > 0,
    };
    const serialized = JSON.stringify(state);
    if (serialized === serializedMenuState) return;
    serializedMenuState = serialized;
    if (!hasTauriRuntime()) return;
    void unwrapCommand(commands.updateTerminalMenuState(state)).catch((error) => {
      settingsError = error instanceof Error ? error.message : String(error);
    });
  }

  function resetPaneTerminal(paneId: string) {
    const pane = terminalPaneById(findTabByPaneId(paneId), paneId);
    if (!pane?.term) return;
    pane.term.reset();
    pane.term.clear();
    terminalTabs.scheduleFit(pane.id);
  }

  function togglePaneReadOnly(paneId: string) {
    const pane = terminalPaneById(findTabByPaneId(paneId), paneId);
    if (!pane) return;
    pane.readOnly = !pane.readOnly;
    syncTerminalMenuState();
  }

  function changeTabTitleForPane(paneId: string) {
    const tab = findTabByPaneId(paneId);
    changeTabTitle(tab);
  }

  function changeTabTitle(tab: TerminalTab) {
    const nextTitle = window.prompt(t("changeTabTitlePrompt"), tab.customTitle || tab.title);
    if (nextTitle === null) return;
    tab.customTitle = nextTitle.trim();
    refreshTerminalTabTitle(tab);
  }

  function adjustFontSize(delta: number) {
    const tab = activeTab;
    const baseSize = settings?.font_size ?? 13;
    for (const pane of tab?.panes ?? []) {
      if (!pane.term) continue;
      const currentSize = typeof pane.term.options.fontSize === "number" ? pane.term.options.fontSize : baseSize;
      pane.term.options.fontSize = Math.max(6, Math.min(48, currentSize + delta));
      terminalTabs.scheduleFit(pane.id);
    }
  }

  function resetFontSize() {
    if (!settings || !activeTab) return;
    if (settings.font_size === null) throw new Error("terminal font size is missing");
    for (const pane of activeTab.panes) {
      if (!pane.term) continue;
      pane.term.options.fontSize = settings.font_size;
      terminalTabs.scheduleFit(pane.id);
    }
  }

  function showFind() {
    findVisible = true;
    const selection = activePane()?.term?.getSelection() ?? "";
    if (selection) findQuery = selection;
    syncTerminalMenuState();
    void focusFindInput();
  }

  function hideFind() {
    findVisible = false;
    activePane()?.search?.clearDecorations?.();
    activePane()?.term?.focus();
    syncTerminalMenuState();
  }

  function findNext({ focusTerminal = true }: { focusTerminal?: boolean } = {}) {
    const pane = activePane();
    if (!pane?.search || !findQuery.trim()) return;
    pane.search.findNext(findQuery, { decorations: searchDecorations() });
    if (focusTerminal) pane.term?.focus();
  }

  function findPrevious({ focusTerminal = true }: { focusTerminal?: boolean } = {}) {
    const pane = activePane();
    if (!pane?.search || !findQuery.trim()) return;
    pane.search.findPrevious(findQuery, { decorations: searchDecorations() });
    if (focusTerminal) pane.term?.focus();
  }

  function useSelectionForFind() {
    const selection = focusedTextSelection() || activePane()?.term?.getSelection() || "";
    if (!selection) return;
    findQuery = selection;
    findVisible = true;
    findNext();
    syncTerminalMenuState();
    void focusFindInput();
  }

  function jumpToSelection() {
    const term = activePane()?.term;
    const position = term?.getSelectionPosition();
    if (!term || !position) return;
    const line = Math.min(position.start.y, position.end.y);
    term.scrollToLine(Math.max(0, line - Math.floor(term.rows / 2)));
    term.focus();
  }

  function focusedTextInput(): TextInputElement | null {
    const element = document.activeElement;
    if (isEditableTextInput(element)) {
      lastFocusedTextInput = element;
      ensureTextEditHistory(element);
      return element;
    }
    if (isEditableTextInput(lastFocusedTextInput)) {
      ensureTextEditHistory(lastFocusedTextInput);
      return lastFocusedTextInput;
    }
    lastFocusedTextInput = null;
    return null;
  }

  function activeTextInput(): TextInputElement | null {
    const element = document.activeElement;
    if (!isEditableTextInput(element)) return null;
    lastFocusedTextInput = element;
    ensureTextEditHistory(element);
    return element;
  }

  function focusedTextSelection(): string {
    const element = focusedTextInput();
    if (!element) return "";
    const start = element.selectionStart ?? 0;
    const end = element.selectionEnd ?? start;
    return element.value.slice(start, end);
  }

  function pasteIntoTextInput(element: TextInputElement, text: string) {
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? start;
    element.focus();
    element.setRangeText(text, start, end, "end");
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: text }));
  }

  function runTextInputEditCommand(element: TextInputElement, command: "undo" | "redo" | "copy") {
    element.focus();
    if (command === "undo") return undoTextInputEdit(element);
    if (command === "redo") return redoTextInputEdit(element);
    document.execCommand(command);
  }

  function isEditableTextInput(element: Element | null): element is TextInputElement {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
    if (element.disabled || element.readOnly) return false;
    if (!element.isConnected) return false;
    return !element.closest(".xterm");
  }

  function textEditSnapshot(element: TextInputElement): TextEditSnapshot {
    const fallback = element.value.length;
    return {
      value: element.value,
      selectionStart: element.selectionStart ?? fallback,
      selectionEnd: element.selectionEnd ?? fallback,
    };
  }

  function snapshotsEqual(first: TextEditSnapshot, second: TextEditSnapshot) {
    return first.value === second.value && first.selectionStart === second.selectionStart && first.selectionEnd === second.selectionEnd;
  }

  function ensureTextEditHistory(element: TextInputElement): TextEditHistory {
    const current = textEditSnapshot(element);
    const existing = textEditHistories.get(element);
    if (existing) return existing;
    const history = { current, undo: [], redo: [] };
    textEditHistories.set(element, history);
    return history;
  }

  function pushTextUndoSnapshot(element: TextInputElement) {
    const history = ensureTextEditHistory(element);
    const snapshot = textEditSnapshot(element);
    if (history.undo.length > 0 && snapshotsEqual(history.undo[history.undo.length - 1], snapshot)) return;
    history.undo.push(snapshot);
    if (history.undo.length > 100) history.undo.shift();
    history.redo = [];
    history.current = snapshot;
  }

  function updateTextEditCurrent(element: TextInputElement) {
    const history = ensureTextEditHistory(element);
    history.current = textEditSnapshot(element);
    syncTerminalMenuState();
  }

  function restoreTextInputSnapshot(element: TextInputElement, snapshot: TextEditSnapshot, inputType: "historyUndo" | "historyRedo") {
    element.focus();
    element.value = snapshot.value;
    element.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType }));
    updateTextEditCurrent(element);
  }

  async function focusFindInput() {
    await tick();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (findInput?.isConnected) {
        findInput.focus({ preventScroll: true });
        findInput.select();
        if (document.activeElement === findInput) return;
      }
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    }
  }

  function undoTextInputEdit(element: TextInputElement) {
    const history = ensureTextEditHistory(element);
    const previous = history.undo.pop();
    if (!previous) {
      document.execCommand("undo");
      syncTerminalMenuState();
      return;
    }
    history.redo.push(textEditSnapshot(element));
    restoreTextInputSnapshot(element, previous, "historyUndo");
  }

  function redoTextInputEdit(element: TextInputElement) {
    const history = ensureTextEditHistory(element);
    const next = history.redo.pop();
    if (!next) {
      document.execCommand("redo");
      syncTerminalMenuState();
      return;
    }
    history.undo.push(textEditSnapshot(element));
    restoreTextInputSnapshot(element, next, "historyRedo");
  }

  function handleTextInputBeforeInput(event: InputEvent) {
    if (event.inputType === "historyUndo" || event.inputType === "historyRedo") return;
    const target = event.target instanceof Element ? event.target : null;
    if (!isEditableTextInput(target)) return;
    pushTextUndoSnapshot(target);
    syncTerminalMenuState();
  }

  function handleTextInputInput(event: Event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!isEditableTextInput(target)) return;
    if (event instanceof InputEvent && (event.inputType === "historyUndo" || event.inputType === "historyRedo")) return;
    const history = ensureTextEditHistory(target);
    const snapshot = textEditSnapshot(target);
    if (snapshotsEqual(history.current, snapshot)) return;
    if (history.undo.length === 0 || !snapshotsEqual(history.undo[history.undo.length - 1], history.current)) {
      history.undo.push(history.current);
      if (history.undo.length > 100) history.undo.shift();
    }
    history.redo = [];
    history.current = snapshot;
    syncTerminalMenuState();
  }

  function handleTextInputFocus(event: FocusEvent) {
    const target = event.target instanceof Element ? event.target : null;
    if (!isEditableTextInput(target)) return;
    lastFocusedTextInput = target;
    ensureTextEditHistory(target);
    syncTerminalMenuState();
  }

  function searchDecorations() {
    return {
      matchBackground: "#9fb6d8",
      matchOverviewRuler: "#7a91b8",
      activeMatchBackground: "#ffd166",
      activeMatchColorOverviewRuler: "#ffd166",
    };
  }

  function showPreviousTab() {
    if (!tabs.length || !activeId) return;
    const index = tabs.findIndex((tab) => tab.id === activeId);
    const next = tabs[(index - 1 + tabs.length) % tabs.length];
    if (next) void activateTab(next.id);
  }

  function showNextTab() {
    if (!tabs.length || !activeId) return;
    const index = tabs.findIndex((tab) => tab.id === activeId);
    const next = tabs[(index + 1) % tabs.length];
    if (next) void activateTab(next.id);
  }

  function siblingPane(side: SplitSide): string | null {
    const tab = activeTab;
    if (!tab) return null;
    const panes = tab.panes.map((pane) => pane.id);
    const index = panes.indexOf(tab.activePaneId);
    if (index === -1) return null;
    if (side === "left" || side === "up") return panes[Math.max(0, index - 1)] ?? null;
    return panes[Math.min(panes.length - 1, index + 1)] ?? null;
  }

  function selectSplit(side: SplitSide) {
    const paneId = siblingPane(side);
    if (paneId) void activatePane(paneId);
  }

  function selectPreviousSplit() {
    selectSplit("left");
  }

  function selectNextSplit() {
    selectSplit("right");
  }

  function resizeActiveSplit(side: SplitSide) {
    const tab = activeTab;
    const targetPaneId = siblingPane(side);
    if (!tab || !targetPaneId) return;
    const direction = side === "left" || side === "right" ? "row" : "column";
    const delta = side === "left" || side === "up" ? -32 : 32;
    tab.tree = resizeAdjacentPanes({
      tree: tab.tree,
      firstPaneId: tab.activePaneId,
      secondPaneId: targetPaneId,
      deltaPixels: delta,
      containerPixels: direction === "row" ? window.innerWidth : window.innerHeight,
      minFirstPixels: direction === "row" ? minPaneWidth : minPaneHeight,
      minSecondPixels: direction === "row" ? minPaneWidth : minPaneHeight,
    });
    void mountAndFitTabPanes(tab);
  }

  async function runTerminalMenuCommand(command: TerminalMenuEvent["command"]) {
    if (command === "new_window") {
      if (hasTauriRuntime()) await unwrapCommand(commands.openMainWindow(null));
      return;
    }
    if (command === "new_tab") {
      await newSession();
      return;
    }
    if (command === "split_right") return splitActivePane("right");
    if (command === "split_left") return splitActivePane("left");
    if (command === "split_down") return splitActivePane("down");
    if (command === "split_up") return splitActivePane("up");
    if (command === "close") return closeActiveTarget();
    if (command === "close_tab" && activeId) return closeTab(activeId, { recordHistory: true });
    if (command === "close_window") return closeCurrentWindow();
    if (command === "undo" || command === "redo") {
      const element = activeTextInput();
      if (element) runTextInputEditCommand(element, command);
      else if (command === "undo") await runTerminalUndo();
      else await runTerminalRedo();
      return;
    }
    if (command === "copy" && activeTextInput()) {
      const element = activeTextInput();
      if (!element) return;
      runTextInputEditCommand(element, "copy");
      return;
    }
    if (command === "paste" && activeTextInput()) {
      const element = activeTextInput();
      if (!element) return;
      const text = hasTauriRuntime() ? await readText() : await navigator.clipboard.readText();
      pasteIntoTextInput(element, text);
      return;
    }
    if (command === "select_all" && activeTextInput()) {
      activeTextInput()?.select();
      return;
    }
    if (command === "copy") return activePane() ? copyPaneSelection(activePane()!.id) : undefined;
    if (command === "paste") return activePane() ? pasteIntoPane(activePane()!.id) : undefined;
    if (command === "paste_selection") return pasteSelectionIntoActivePane();
    if (command === "select_all") return activePane()?.term?.selectAll();
    if (command === "find") return showFind();
    if (command === "find_next") return findNext();
    if (command === "find_previous") return findPrevious();
    if (command === "hide_find_bar") return hideFind();
    if (command === "use_selection_for_find") return useSelectionForFind();
    if (command === "jump_to_selection") return jumpToSelection();
    if (command === "reset_font_size") return resetFontSize();
    if (command === "increase_font_size") return adjustFontSize(1);
    if (command === "decrease_font_size") return adjustFontSize(-1);
    if (command === "change_tab_title" && activeTab) return changeTabTitle(activeTab);
    if (command === "toggle_read_only" && activePane()) return togglePaneReadOnly(activePane()!.id);
    if (command === "show_previous_tab") return showPreviousTab();
    if (command === "show_next_tab") return showNextTab();
    if (command === "move_tab_to_new_window") return moveActiveTabToNewWindow();
    if (command === "zoom_split") return activePane()?.term?.focus();
    if (command === "select_previous_split") return selectPreviousSplit();
    if (command === "select_next_split") return selectNextSplit();
    if (command === "select_split_left") return selectSplit("left");
    if (command === "select_split_right") return selectSplit("right");
    if (command === "select_split_up") return selectSplit("up");
    if (command === "select_split_down") return selectSplit("down");
    if (command === "resize_split_left") return resizeActiveSplit("left");
    if (command === "resize_split_right") return resizeActiveSplit("right");
    if (command === "resize_split_up") return resizeActiveSplit("up");
    if (command === "resize_split_down") return resizeActiveSplit("down");
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
      void closeTab(activeId, { recordHistory: true });
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
      void closePane(activeTab.activePaneId, { recordHistory: true });
    }
  }

  onMount(() => {
    let mounted = true;
    void (async () => {
      if (hasTauriRuntime()) {
        const windowTarget = { kind: "WebviewWindow" as const, label: currentWindowLabel() };
        const [outputDispose, exitDispose, configDispose, paneMenuDispose, terminalMenuDispose] = await Promise.all([
          listen<TerminalOutputEvent>("terminal://output", (event) => terminalTabs.enqueueOutput(event.payload)),
          listen<TerminalExitEvent>("terminal://exit", (event) => terminalTabs.markExited(event.payload)),
          listen("config://changed", () => {
            void loadSettings().catch((error) => {
              settingsError = error instanceof Error ? error.message : String(error);
            });
          }),
          listen<PaneMenuEvent>("terminal://pane-menu", (event) => handlePaneMenu(event.payload), { target: windowTarget }),
          listen<TerminalMenuEvent>("terminal://menu-command", (event) => {
            void runTerminalMenuCommand(event.payload.command).catch((error) => {
              settingsError = error instanceof Error ? error.message : String(error);
            });
          }, { target: windowTarget }),
        ]);
        if (!mounted) {
          outputDispose();
          exitDispose();
          configDispose();
          paneMenuDispose();
          terminalMenuDispose();
          return;
        }
        outputUnlisten = outputDispose;
        exitUnlisten = exitDispose;
        configUnlisten = configDispose;
        paneMenuUnlisten = paneMenuDispose;
        terminalMenuUnlisten = terminalMenuDispose;
      }
      await loadSettings();
      const restored = await restoreTabHandoff();
      await ensureStartupSession(restored);
    })().catch((error) => {
      settingsError = error instanceof Error ? error.message : String(error);
    });
    window.addEventListener("keydown", handleKeyboard);
    window.addEventListener("pointermove", handlePointerMove, { capture: true });
    window.addEventListener("pointerup", handlePointerUp, { capture: true });
    window.addEventListener("pointercancel", handlePointerCancel, { capture: true });
    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("focus", syncTerminalMenuState);
    document.addEventListener("beforeinput", handleTextInputBeforeInput);
    document.addEventListener("input", handleTextInputInput);
    document.addEventListener("focusin", handleTextInputFocus);
    document.addEventListener("focusout", syncTerminalMenuState);
    document.addEventListener("selectionchange", syncTerminalMenuState);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    syncTerminalMenuState();
    return () => {
      mounted = false;
      window.removeEventListener("keydown", handleKeyboard);
      window.removeEventListener("pointermove", handlePointerMove, { capture: true });
      window.removeEventListener("pointerup", handlePointerUp, { capture: true });
      window.removeEventListener("pointercancel", handlePointerCancel, { capture: true });
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("focus", syncTerminalMenuState);
      document.removeEventListener("beforeinput", handleTextInputBeforeInput);
      document.removeEventListener("input", handleTextInputInput);
      document.removeEventListener("focusin", handleTextInputFocus);
      document.removeEventListener("focusout", syncTerminalMenuState);
      document.removeEventListener("selectionchange", syncTerminalMenuState);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      outputUnlisten?.();
      exitUnlisten?.();
      configUnlisten?.();
      paneMenuUnlisten?.();
      terminalMenuUnlisten?.();
      for (const tab of tabs) {
        disposeTerminalTab(tab);
        for (const pane of tab.panes) {
          if (movedPaneIds.has(pane.id)) continue;
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
        syncTerminalMenuState();
      });
    }
  });

  $effect(() => {
    tabs.length;
    activeId;
    findVisible;
    findQuery;
    void tick().then(syncTerminalMenuState);
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

  {#if findVisible}
    <form
      class="find-bar"
      role="search"
      onsubmit={(event) => {
        event.preventDefault();
        findNext();
      }}
    >
      <input
        bind:this={findInput}
        bind:value={findQuery}
        aria-label={t("find")}
        placeholder={t("find")}
        spellcheck="false"
        oninput={() => {
          findNext({ focusTerminal: false });
          syncTerminalMenuState();
        }}
        onkeydown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            hideFind();
          }
        }}
      />
      <button type="button" aria-label={t("findPrevious")} title={t("findPrevious")} onclick={() => findPrevious()}>
        ↑
      </button>
      <button type="button" aria-label={t("findNext")} title={t("findNext")} onclick={() => findNext()}>
        ↓
      </button>
      <button type="button" aria-label={t("hideFindBar")} title={t("hideFindBar")} onclick={hideFind}>
        ×
      </button>
    </form>
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

  .find-bar {
    position: fixed;
    top: max(48px, env(safe-area-inset-top));
    right: 14px;
    z-index: 20;
    display: grid;
    grid-template-columns: minmax(160px, 260px) 30px 30px 30px;
    gap: 6px;
    align-items: center;
    padding: 6px;
    border: 1px solid color-mix(in srgb, var(--app-fg) 16%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--app-bg) 92%, transparent);
    box-shadow: 0 12px 30px color-mix(in srgb, #000 22%, transparent);
    -webkit-backdrop-filter: blur(18px);
    backdrop-filter: blur(18px);
  }

  .find-bar input {
    width: 100%;
    min-width: 0;
    height: 28px;
    border: 1px solid color-mix(in srgb, var(--app-fg) 14%, transparent);
    border-radius: 6px;
    padding: 0 9px;
    background: color-mix(in srgb, var(--app-bg) 82%, var(--app-fg));
    color: var(--app-fg);
    font: inherit;
    font-size: 13px;
    outline: none;
  }

  .find-bar input:focus-visible {
    border-color: var(--terminal-selection);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--terminal-selection) 34%, transparent);
  }

  .find-bar button {
    width: 30px;
    height: 28px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: color-mix(in srgb, var(--app-fg) 82%, transparent);
    font: inherit;
    font-size: 16px;
    line-height: 1;
  }

  .find-bar button:hover {
    background: color-mix(in srgb, var(--app-fg) 10%, transparent);
  }

  .find-bar button:active {
    background: color-mix(in srgb, var(--app-fg) 16%, transparent);
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

    .find-bar {
      left: 10px;
      right: 10px;
      grid-template-columns: minmax(0, 1fr) 30px 30px 30px;
    }
  }
</style>
