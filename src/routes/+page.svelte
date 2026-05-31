<script lang="ts">
  import { onMount, tick } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { ask } from "@tauri-apps/plugin-dialog";
  import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { OverlayScrollbarsComponent } from "overlayscrollbars-svelte";
  import "overlayscrollbars/overlayscrollbars.css";
  import "@xterm/xterm/css/xterm.css";
  import { commands, type AppConfigSnapshot, type PaneMenuEvent, type TabBarOrientation, type TerminalSessionInfo, type TerminalSettings } from "$lib/bindings";
  import { appLanguageFromConfig, appThemeFromConfig, applyAppPreferences, booleanValue, configString, readValue, resolveTheme, writeValue } from "$lib/config/document";
  import CommandPalette from "$lib/command-palette/CommandPalette.svelte";
  import { staticPaletteCommands } from "$lib/command-palette/commands";
  import { localizeCommand, searchPaletteItems, type PaletteItem, type PaletteSearchResult } from "$lib/command-palette/search";
  import { buildHostFolderTree, hostFolderLabel, hostHasBlockingDiagnostics, hostSubtitle, type HostFolderTreeNode } from "$lib/hosts/model";
  import { hasTauriRuntime } from "$lib/tauri/runtime";
  import TerminalPaneTree from "$lib/terminal/components/TerminalPaneTree.svelte";
  import TerminalTabBar from "$lib/terminal/components/TerminalTabBar.svelte";
  import { unwrapCommand } from "$lib/terminal/commands";
  import { isTerminalSessionInactiveMessage } from "$lib/terminal/errors";
  import {
    clearTerminalFindEffects,
    terminalFindSearchKeyChanged,
    terminalFindSnapshot,
    type TerminalFindSearchKey,
    type TerminalFindSnapshot,
    type TerminalLike,
  } from "$lib/terminal/find";
  import { eventMatchesBinding, readKeybindingMap, type KeybindingMap, type TerminalCommandId } from "$lib/terminal/keybindings";
  import {
    movePaneIntoSplit,
    removePane,
    replacePane,
    resizeAdjacentPanes,
    paneItemsForTree,
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
    retargetTerminalPaneSession,
    refreshTerminalTabTitle,
    terminalPaneById,
    type TerminalExitEvent,
    type TerminalOutputEvent,
    type TerminalPane,
    type TerminalTab,
    type TerminalTransportStateEvent,
  } from "$lib/terminal/tabs";
  import { toTerminalSessionSizeInput } from "$lib/terminal/sizes";
  import { terminalMenuCanRedo, terminalMenuCanUndo } from "$lib/terminal/menu-history";
  import { language, setLanguage, t } from "$lib/i18n";

  type TerminalMenuCommand =
    | "new_window"
    | "open_command_palette"
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
    reconnectPending: boolean;
    everConnected: boolean;
    connectionHostId: string;
    reconnectTrust: TerminalPane["reconnectTrust"];
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
  type StoredHotTabs = {
    activeIndex: number;
    tabs: StoredTab[];
  };
  type SshCredentialKind = "password" | "key_passphrase";
  type HostSessionRetry = {
    connectionHostId: string;
    acceptNewHostKey?: boolean;
    updateChangedHostKey?: boolean;
  };
  type PendingSshCredential = {
    paneId: string | null;
    connectionHostId: string;
    kind: SshCredentialKind;
    acceptNewHostKey: boolean;
    updateChangedHostKey: boolean;
    value: string;
    save: boolean;
  };
  type HostPickerMenu = {
    node: HostFolderTreeNode;
    left: number;
    top: number;
    opensLeft: boolean;
  };

  const initialCols = 80;
  const initialRows = 24;
  const minPaneWidth = 160;
  const minPaneHeight = 96;
  const hotTabsStorageKey = "nocturne:dev-hot-tabs";
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
  let lastConfigSnapshot = $state<AppConfigSnapshot | null>(null);
  let keybindings = $state<KeybindingMap | null>(null);
  let settingsError = $state("");
  let tabs = $state<TerminalTab[]>([]);
  let activeId = $state("");
  let tabBarOrientation = $state<TabBarOrientation>("horizontal");
  let outputUnlisten: undefined | (() => void);
  let exitUnlisten: undefined | (() => void);
  let transportStateUnlisten: undefined | (() => void);
  let configUnlisten: undefined | (() => void);
  let paneMenuUnlisten: undefined | (() => void);
  let terminalMenuUnlisten: undefined | (() => void);
  let terminalMeasureContainer: HTMLDivElement;
  let appTheme: "light" | "dark" = "dark";
  let findVisible = $state(false);
  let findQuery = $state("");
  let findCaseSensitive = $state(false);
  let findRegex = $state(false);
  let findSnapshot = $state<TerminalFindSnapshot>({ activeIndex: 0, error: "", matches: [] });
  let appliedFindSearchKey: TerminalFindSearchKey | null = null;
  let movedPaneIds = new Set<string>();
  let findInput = $state<HTMLInputElement>();
  let sshCredentialInput = $state<HTMLInputElement>();
  let commandPaletteOpen = $state(false);
  let commandPaletteQuery = $state("");
  let commandPaletteSelected = $state(0);
  let hostPickerOpen = $state(false);
  let hostPickerPosition = $state({ left: 10, top: 44 });
  let hostPickerSubmenus = $state<HostPickerMenu[]>([]);
  let secondaryClickOpensDefault = $state(false);
  let macosIntegratedTitlebar = $state(false);
  let pendingSshCredential = $state<PendingSshCredential | null>(null);
  let hostSessionRetryByPaneId = $state<Record<string, HostSessionRetry>>({});
  let commandPaletteLastFocus: HTMLElement | null = null;
  let recentPaletteIds = $state<string[]>([]);
  let zoomedPane = $state<{ tabId: string; paneId: string; tree: TerminalTab["tree"]; activePaneId: string } | null>(null);
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
  const isHotModuleReplacement = import.meta.hot !== undefined;

  let activeTab = $derived(tabs.find((tab) => tab.id === activeId));
  let isVertical = $derived(tabBarOrientation !== "horizontal");
  let tabsOnLeft = $derived(tabBarOrientation === "vertical_left");
  let integratedTitlebar = $derived(isMacPlatform() && macosIntegratedTitlebar && !isVertical);
  let paletteResults = $derived(
    searchPaletteItems(buildPaletteItems(), commandPaletteQuery, {
      language: language(),
      includeDisabledExact: commandPaletteQuery.trim().length > 0,
    }),
  );
  const terminalTabs = createTerminalTabController({
    settings: () => settings,
    tabs: () => tabs,
    setGlobalError: (message) => {
      settingsError = message;
    },
    notifySelectionChange: () => {
      syncTerminalMenuState();
    },
    requestReconnect: (paneId) => {
      void reconnectPaneAfterDisconnect(paneId);
    },
  });

  async function loadSettings() {
    settingsError = "";
    const snapshot = await unwrapCommand(commands.getConfigSnapshot());
    lastConfigSnapshot = snapshot;
    applyAppPreferences(snapshot.effective_config.root);
    setLanguage(appLanguageFromConfig(readValue(snapshot.effective_config.root, ["ui", "language"])));
    appTheme = resolveTheme(appThemeFromConfig(readValue(snapshot.effective_config.root, ["ui", "theme"])));
    keybindings = readKeybindingMap(snapshot.effective_config.root, navigator.platform.toLowerCase().includes("mac"));
    secondaryClickOpensDefault = booleanValue(readValue(snapshot.effective_config.root, ["session", "secondary_click_opens_default"])) ?? false;
    macosIntegratedTitlebar = booleanValue(readValue(snapshot.effective_config.root, ["ui", "macos_integrated_titlebar"])) ?? true;
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

  function isMacPlatform() {
    return navigator.platform.toLowerCase().includes("mac");
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

  async function createHostSession(
    connectionHostId: string,
    {
      cwd = null,
      recordHistory = true,
      trust = {},
    }: {
      cwd?: string | null;
      recordHistory?: boolean;
      trust?: {
        acceptNewHostKey?: boolean;
        updateChangedHostKey?: boolean;
        credential?: { kind: SshCredentialKind; value: string };
        saveCredential?: boolean;
      };
    } = {},
  ) {
    let info: TerminalSessionInfo;
    try {
      if (!settings) await loadSettings();
      await tick();
      const measured = measureNewTerminal(cwd);
      info = await unwrapCommand(
        commands.createHostTerminalSession({
          ...measured,
          connection_host_id: connectionHostId,
          accept_new_host_key: trust.acceptNewHostKey === true,
          update_changed_host_key: trust.updateChangedHostKey === true,
          credential: trust.credential ?? null,
          save_credential: trust.saveCredential === true,
        }),
      );
    } catch (error) {
      await handleHostSessionError(connectionHostId, error, trust);
      return;
    }

    const tab = createTerminalTab(info);
    const pane = terminalPaneById(tab, tab.activePaneId);
    if (!pane) throw new Error(`active pane ${tab.activePaneId} not found in created tab`);
    pane.connectionHostId = connectionHostId;
    pane.reconnectTrust = {
      acceptNewHostKey: trust.acceptNewHostKey,
      updateChangedHostKey: trust.updateChangedHostKey,
    };
    tabs = [...tabs, tab];
    activeId = tab.id;
    hostSessionRetryByPaneId = {
      ...hostSessionRetryByPaneId,
      [tab.activePaneId]: {
        connectionHostId,
        acceptNewHostKey: trust.acceptNewHostKey,
        updateChangedHostKey: trust.updateChangedHostKey,
      },
    };
    settingsError = "";
    try {
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
      terminalTabs.markConnectionError(tab.activePaneId, error instanceof Error ? error.message : String(error));
    }
  }

  async function reconnectHostSessionInPane(
    paneId: string,
    connectionHostId: string,
    trust: {
      acceptNewHostKey?: boolean;
      updateChangedHostKey?: boolean;
      credential?: { kind: SshCredentialKind; value: string };
      saveCredential?: boolean;
    },
  ) {
    const tab = findTabByPaneId(paneId);
    const pane = terminalPaneById(tab, paneId);
    if (!pane) throw new Error(`pane ${paneId} not found`);
    if (!settings) await loadSettings();
    await tick();
    const info = await unwrapCommand(
      commands.createHostTerminalSession({
        ...measureNewTerminal(pane.currentDirectory.trim() || null),
        connection_host_id: connectionHostId,
        accept_new_host_key: trust.acceptNewHostKey === true,
        update_changed_host_key: trust.updateChangedHostKey === true,
        credential: trust.credential ?? null,
        save_credential: trust.saveCredential === true,
      }),
    );
    const nextPaneId = info.id;
    tab.tree = replacePane(tab.tree, paneId, nextPaneId);
    if (tab.activePaneId === paneId) tab.activePaneId = nextPaneId;
    retargetTerminalPaneSession(pane, info);
    pane.connectionHostId = connectionHostId;
    pane.reconnectTrust = {
      acceptNewHostKey: trust.acceptNewHostKey,
      updateChangedHostKey: trust.updateChangedHostKey,
    };
    refreshTerminalTabTitle(tab);
    activeId = tab.id;
    hostSessionRetryByPaneId = {
      ...hostSessionRetryByPaneId,
      [nextPaneId]: {
        connectionHostId,
        acceptNewHostKey: trust.acceptNewHostKey,
        updateChangedHostKey: trust.updateChangedHostKey,
      },
    };
    await tick();
    await mountTerminalWhenReady(nextPaneId);
    await flushTerminalOutputBacklog(nextPaneId);
    terminalTabs.scheduleFit(nextPaneId);
    pane.term?.focus();
    syncTerminalMenuState();
  }

  async function reconnectPaneAfterDisconnect(paneId: string) {
    const tab = findTabByPaneId(paneId);
    const pane = terminalPaneById(tab, paneId);
    if (!pane) return;
    if (!pane.connectionHostId) {
      terminalTabs.markReconnectUnavailable(paneId, "This pane has no host metadata for reconnect.");
      return;
    }
    try {
      await reconnectHostSessionInPane(paneId, pane.connectionHostId, pane.reconnectTrust);
    } catch (error) {
      terminalTabs.markReconnectUnavailable(paneId, error instanceof Error ? error.message : String(error));
    }
  }

  async function openDefaultSession({ recordHistory = true }: { recordHistory?: boolean } = {}) {
    const defaultHostId = lastConfigSnapshot?.root.default_host ?? "";
    await createHostSession(defaultHostId, { recordHistory });
  }

  async function newSession({ recordHistory = true }: { recordHistory?: boolean } = {}) {
    if (secondaryClickOpensDefault) {
      openHostPickerAtElement(document.querySelector<HTMLElement>("[data-testid='new-session']"));
      return;
    }
    await openDefaultSession({ recordHistory });
  }

  async function handleNewSessionSecondaryClick(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (secondaryClickOpensDefault) {
      await openDefaultSession();
      return;
    }
    openHostPicker(event);
  }

  async function ensureStartupSession(restored: boolean) {
    if (restored || tabs.length > 0) return;
    await openDefaultSession({ recordHistory: false });
  }

  async function flushTerminalOutputBacklog(paneId: string) {
    if (!hasTauriRuntime()) return;
    let event: TerminalOutputEvent | null;
    try {
      event = await unwrapCommand(commands.takeTerminalOutputBacklog({ session_id: paneId }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isTerminalSessionInactiveMessage(message)) {
        terminalTabs.markConnectionError(paneId, message);
        return;
      }
      throw error;
    }
    if (event) enqueueTerminalOutput(event);
  }

  function enqueueTerminalOutput(event: TerminalOutputEvent) {
    terminalTabs.enqueueOutput(event);
    if (event.session_id !== activePane()?.id || !findVisible) return;
    window.requestAnimationFrame(() => {
      updateFindSnapshot();
      syncTerminalMenuState();
    });
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
    refreshFindForActivePane();
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
    refreshFindForActivePane();
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
      const defaultHostId = lastConfigSnapshot?.root.default_host ?? "";
      const info = await createHostPaneSession(defaultHostId, cwd);
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

  async function createHostPaneSession(connectionHostId: string, cwd: string | null) {
    const measured = measureNewTerminal(cwd);
    return unwrapCommand(
      commands.createHostTerminalSession({
        ...measured,
        connection_host_id: connectionHostId,
        accept_new_host_key: false,
        update_changed_host_key: false,
        credential: null,
        save_credential: false,
      }),
    );
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
    await openDefaultSession({ recordHistory: false });
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
    closeHostPicker();
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
    localStorage.setItem(key, JSON.stringify(storeTabSnapshot(tab)));
    return key;
  }

  function storeTabSnapshot(tab: TerminalTab): StoredTab {
    return {
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
        reconnectPending: pane.reconnectPending,
        everConnected: pane.everConnected,
        connectionHostId: pane.connectionHostId,
        reconnectTrust: pane.reconnectTrust,
        status: pane.status,
        serialized: pane.serialize?.serialize({ scrollback: 1000 }) ?? "",
        lastCols: pane.lastCols,
        lastRows: pane.lastRows,
        lastPixelWidth: pane.lastPixelWidth,
        lastPixelHeight: pane.lastPixelHeight,
        nextOutputSequence: pane.nextOutputSequence.toString(),
      })),
    };
  }

  function storeHotTabsSnapshot() {
    if (!isHotModuleReplacement || tabs.length === 0) return;
    const stored: StoredHotTabs = {
      activeIndex: Math.max(0, tabs.findIndex((tab) => tab.id === activeId)),
      tabs: tabs.map(storeTabSnapshot),
    };
    sessionStorage.setItem(hotTabsStorageKey, JSON.stringify(stored));
  }

  async function restoreTabHandoff() {
    const key = new URLSearchParams(window.location.search).get("tab_handoff");
    if (!key) return false;
    const raw = localStorage.getItem(key);
    if (!raw) throw new Error(`tab handoff ${key} not found`);
    localStorage.removeItem(key);
    const stored = JSON.parse(raw) as StoredTab;
    const restoredPanes = await restoreStoredPanes(stored);
    await unwrapCommand(
      commands.transferTerminalSessionsToWindow({
        session_ids: restoredPanes.map((pane) => pane.id),
        window_label: currentWindowLabel(),
      }),
    );
    const tab = restoreStoredTab(stored, restoredPanes);
    tabs = [tab];
    activeId = tab.id;
    await tick();
    await mountAndFitTabPanes(tab);
    terminalPaneById(tab, tab.activePaneId)?.term?.focus();
    syncTerminalMenuState();
    return true;
  }

  async function restoreHotTabs() {
    if (!isHotModuleReplacement) return false;
    const raw = sessionStorage.getItem(hotTabsStorageKey);
    if (!raw) return false;
    sessionStorage.removeItem(hotTabsStorageKey);
    const stored = JSON.parse(raw) as StoredHotTabs;
    if (stored.tabs.length === 0) return false;
    const restoredTabs: TerminalTab[] = [];
    for (const storedTab of stored.tabs) {
      const restoredPanes = await restoreStoredPanes(storedTab);
      restoredTabs.push(restoreStoredTab(storedTab, restoredPanes));
    }
    tabs = restoredTabs;
    activeId = restoredTabs[Math.min(stored.activeIndex, restoredTabs.length - 1)]?.id ?? restoredTabs[0]?.id ?? "";
    await tick();
    for (const tab of restoredTabs) await mountAndFitTabPanes(tab);
    const focusedTab = tabs.find((tab) => tab.id === activeId);
    if (focusedTab) {
      terminalPaneById(focusedTab, focusedTab.activePaneId)?.term?.focus();
    }
    syncTerminalMenuState();
    return restoredTabs.length > 0;
  }

  async function restoreStoredPanes(stored: StoredTab) {
    const restoredPanes: TerminalPane[] = [];
    for (const pane of stored.panes) {
      const restored = pane.reconnectPending
        ? createTerminalPane({
            id: pane.id,
            title: pane.title,
            command: pane.command,
            cwd: pane.currentDirectory || null,
            cols: pane.lastCols,
            rows: pane.lastRows,
            pixel_width: pane.lastPixelWidth,
            pixel_height: pane.lastPixelHeight,
            process_id: null,
            transport: "ssh",
            transport_state: "disconnected",
          }, "")
        : createTerminalPane(await unwrapCommand(commands.existingTerminalSessionInfo({ session_id: pane.id })), "");
      restored.title = pane.title;
      restored.baseTitle = pane.baseTitle;
      restored.command = pane.command;
      restored.currentDirectory = pane.currentDirectory;
      restored.titleOverride = pane.titleOverride;
      restored.readOnly = pane.readOnly;
      restored.reconnectPending = pane.reconnectPending;
      restored.everConnected = pane.everConnected || pane.status === "running" || pane.status === "disconnected";
      restored.connectionHostId = pane.connectionHostId;
      restored.reconnectTrust = pane.reconnectTrust;
      restored.status = pane.status;
      restored.lastCols = pane.lastCols;
      restored.lastRows = pane.lastRows;
      restored.lastPixelWidth = pane.lastPixelWidth;
      restored.lastPixelHeight = pane.lastPixelHeight;
      restored.nextOutputSequence = BigInt(pane.nextOutputSequence ?? "0");
      restored.outputQueue = pane.serialized ? [pane.serialized] : [];
      restoredPanes.push(restored);
    }
    return restoredPanes;
  }

  function restoreStoredTab(stored: StoredTab, restoredPanes: TerminalPane[]) {
    const firstPane = restoredPanes[0];
    if (!firstPane) throw new Error("tab handoff has no panes");
    const tab = createTerminalTabFromPane(firstPane);
    tab.customTitle = stored.customTitle;
    tab.activePaneId = stored.activePaneId;
    tab.tree = clonePaneTree(stored.tree);
    for (const pane of restoredPanes) pane.tabId = tab.id;
    tab.panes = restoredPanes;
    refreshTerminalTabTitle(tab);
    return tab;
  }

  async function mountAndFitTabPanes(tab: TerminalTab) {
    await tick();
    for (const pane of paneItemsForTree(tab.tree, tab.panes)) {
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
    const tab = findTabByPaneId(paneId);
    const pane = terminalPaneById(tab, paneId);
    if (!pane) throw new Error(`pane ${paneId} not found`);
    await unwrapCommand(
      commands.showPaneContextMenu({
        x: event.clientX,
        y: event.clientY,
        pane_id: paneId,
        window_label: currentWindowLabel(),
        has_selection: pane.term?.hasSelection() === true,
        read_only: pane.readOnly,
        has_multiple_panes: tab.panes.length > 1,
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
    if (event.action === "zoom_split") {
      void zoomPane(event.pane_id);
      return;
    }
    if (event.action === "close_pane") {
      void closePane(event.pane_id, { recordHistory: true });
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
      has_find_query: hasFindQuery() && !findSnapshot.error,
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
    runFindNavigation("next", { focusTerminal: false, incremental: true });
    syncTerminalMenuState();
    void focusFindInput();
  }

  function hideFind() {
    const pane = activePane();
    const paneId = pane?.id;
    findVisible = false;
    clearTerminalFindEffects(pane);
    findSnapshot = { activeIndex: 0, error: "", matches: [] };
    appliedFindSearchKey = null;
    syncTerminalMenuState();
    void restoreTerminalAfterFindClose(paneId);
  }

  function findNext({ focusTerminal = true }: { focusTerminal?: boolean } = {}) {
    runFindNavigation("next", { focusTerminal });
  }

  function findPrevious({ focusTerminal = true }: { focusTerminal?: boolean } = {}) {
    runFindNavigation("previous", { focusTerminal });
  }

  function runFindNavigation(
    direction: "next" | "previous",
    { focusTerminal = true, incremental = false }: { focusTerminal?: boolean; incremental?: boolean } = {},
  ) {
    const pane = activePane();
    updateFindSnapshot();
    if (!pane?.search || !hasFindQuery() || findSnapshot.error) {
      pane?.search?.clearDecorations?.();
      appliedFindSearchKey = null;
      return;
    }
    const searchKey = {
      caseSensitive: findCaseSensitive,
      paneId: pane.id,
      query: findQuery,
      regex: findRegex,
    };
    if (terminalFindSearchKeyChanged(appliedFindSearchKey, searchKey)) {
      pane.search.clearDecorations?.();
      appliedFindSearchKey = searchKey;
    }
    const options = {
      caseSensitive: findCaseSensitive,
      decorations: searchDecorations(),
      incremental,
      regex: findRegex,
    };
    const found =
      direction === "next" ? pane.search.findNext(findQuery, options) : pane.search.findPrevious(findQuery, options);
    if (!found) pane.search.clearActiveDecoration?.();
    updateFindSnapshot();
    if (focusTerminal) pane.term?.focus();
    syncTerminalMenuState();
  }

  function useSelectionForFind() {
    const selection = focusedTextSelection() || activePane()?.term?.getSelection() || "";
    if (!selection) return;
    findQuery = selection;
    findVisible = true;
    runFindNavigation("next");
    syncTerminalMenuState();
    void focusFindInput();
  }

  async function copyMatchingLine() {
    if (!canCopyMatchingLine()) return;
    const match = findSnapshot.matches[findSnapshot.activeIndex - 1];
    if (!match) throw new Error(`active find match ${findSnapshot.activeIndex} is missing`);
    const line = match.text.trimEnd();
    if (hasTauriRuntime()) await writeText(line);
    else await navigator.clipboard.writeText(line);
  }

  function updateFindQuery() {
    runFindNavigation("next", { focusTerminal: false, incremental: true });
    syncTerminalMenuState();
  }

  function toggleFindCaseSensitive() {
    findCaseSensitive = !findCaseSensitive;
    updateFindQuery();
    void focusFindInput();
  }

  function toggleFindRegex() {
    findRegex = !findRegex;
    updateFindQuery();
    void focusFindInput();
  }

  function updateFindSnapshot() {
    const term = activePane()?.term;
    findSnapshot = term
      ? terminalFindSnapshot(term as unknown as TerminalLike, findQuery, {
          caseSensitive: findCaseSensitive,
          regex: findRegex,
        })
      : { activeIndex: 0, error: "", matches: [] };
  }

  function refreshFindForActivePane() {
    updateFindSnapshot();
    if (findVisible && hasFindQuery() && !findSnapshot.error) {
      runFindNavigation("next", { focusTerminal: false });
    }
  }

  function hasFindQuery() {
    return findQuery.length > 0;
  }

  function canCopyMatchingLine() {
    return hasFindQuery() && !findSnapshot.error && findSnapshot.activeIndex > 0 && findSnapshot.matches.length > 0;
  }

  function findCountLabel() {
    if (!hasFindQuery()) return "";
    if (findSnapshot.error) return "!";
    if (findSnapshot.matches.length === 0) return "0";
    return `${findSnapshot.activeIndex} / ${findSnapshot.matches.length}`;
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

  async function restoreTerminalAfterFindClose(paneId: string | undefined) {
    if (!paneId) return;
    await tick();
    await animationFrame();
    const pane = tabs.flatMap((tab) => tab.panes).find((item) => item.id === paneId);
    pane?.term?.focus();
    for (let frame = 0; frame < 3; frame += 1) {
      terminalTabs.refreshPanePresentation(paneId);
      await animationFrame();
    }
  }

  function animationFrame() {
    return new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
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
      matchBorder: "#7a91b8",
      matchOverviewRuler: "#7a91b8",
      activeMatchBackground: "#ffd166",
      activeMatchBorder: "#ffd166",
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

  function buildPaletteItems(): PaletteItem[] {
    const currentLanguage = language();
    const hasActivePane = activePane() !== null;
    const hasMultiplePanes = (activeTab?.panes.length ?? 0) > 1;
    const staticItems = staticPaletteCommands.map((command) => {
      const item = localizeCommand(command, currentLanguage);
      const shortcut = displayShortcut(item.shortcut);
      return {
        ...item,
        shortcut,
        contextScore: paletteContextScore(item.id, hasActivePane, hasMultiplePanes),
        recentScore: paletteRecentScore(item.id),
        disabledReason: paletteDisabledReason(item.id, hasActivePane, hasMultiplePanes),
      };
    });
    return [...staticItems, ...connectionHostPaletteItems(), ...tabPaletteItems(), ...profilePaletteItems()];
  }

  function connectionHostPaletteItems(): PaletteItem[] {
    return (lastConfigSnapshot?.hosts ?? []).map((host) => {
      const id = `connection.connect:${host.id}`;
      const ssh = host.document.ssh;
      const local = host.document.local;
      const folder = hostFolderLabel(host);
      return {
        id,
        kind: "connection-host",
        title: `${host.document.protocol === "local" ? "Start" : "Connect"}: ${host.document.name}`,
        scope: host.source === "open_ssh_config" ? folder : `${t("hosts")} / ${folder}`,
        keywords: [
          host.document.name,
          folder,
          host.document.icon_pack ?? "",
          host.document.protocol,
          local?.command ?? "",
          local?.cwd ?? "",
          ssh?.hostname ?? "",
          ssh?.username ?? "",
          ssh?.proxy_jump ?? "",
          hostSubtitle(host),
          "session",
          "host",
          "connect",
          "connection",
          "local",
          "ssh",
          "会话",
          "连接",
          "主机",
          "本地",
          "lianjie",
          "lj",
          "zhuji",
          "zj",
        ],
        disabledReason: hostHasBlockingDiagnostics(host) ? host.diagnostics.find((diagnostic) => diagnostic.severity === "error")?.message : undefined,
        recentScore: paletteRecentScore(id),
      };
    });
  }

  function hostPickerGroups() {
    return buildHostFolderTree(lastConfigSnapshot?.hosts ?? []);
  }

  function tabPaletteItems(): PaletteItem[] {
    return tabs.map((tab, index) => {
      const number = index + 1;
      const active = tab.id === activeId;
      const pane = terminalPaneById(tab, tab.activePaneId);
      return {
        id: `tab.switchTo:${tab.id}`,
        kind: "tab",
        title: `${t("switchToTab")}: ${number}  ${tab.title}`,
        scope: t("tab"),
        keywords: [
          tab.title,
          t("switchToTab"),
          "switch tab",
          "switch to tab",
          "切换标签",
          "切换到标签",
          `tab ${number}`,
          `标签 ${number}`,
          String(number),
          pane?.currentDirectory ?? "",
          pane?.command ?? "",
          "biaoqian",
          "bq",
        ],
        contextScore: active ? 24 : 0,
        recentScore: paletteRecentScore(`tab.switchTo:${tab.id}`),
      };
    });
  }

  function profilePaletteItems(): PaletteItem[] {
    return settingsSnapshotProfiles().map((profile) => {
      const id = `profile.switch:${profile.name}`;
      return {
        id,
        kind: "profile",
        title: `${t("switchProfile")}: ${profile.name}`,
        scope: t("profile"),
        keywords: [
          profile.name,
          t("switchProfile"),
          "switch profile",
          "profile",
          "切换配置档案",
          "配置档案",
          "档案",
          "qiehuan",
          "qh",
          "peizhidangan",
          "pzdangan",
          "dangan",
          "da",
        ],
        contextScore: profile.name === currentActiveProfile() ? 20 : 0,
        recentScore: paletteRecentScore(id),
      };
    });
  }

  function settingsSnapshotProfiles() {
    return lastConfigSnapshot?.profiles ?? [];
  }

  function currentActiveProfile() {
    return lastConfigSnapshot?.root.active_profile ?? "";
  }

  function paletteContextScore(id: string, hasActivePane: boolean, hasMultiplePanes: boolean) {
    if (id.startsWith("terminal.split") && hasActivePane) return 34;
    if (id.startsWith("terminal.movePane") && hasMultiplePanes) return 30;
    if (id === "terminal.togglePaneZoom" && hasMultiplePanes) return 30;
    if (id.startsWith("ui.theme.")) return 12;
    return 0;
  }

  function paletteRecentScore(id: string) {
    const index = recentPaletteIds.indexOf(id);
    return index === -1 ? 0 : Math.max(2, 12 - index * 2);
  }

  function paletteDisabledReason(id: string, hasActivePane: boolean, hasMultiplePanes: boolean) {
    if (id.startsWith("terminal.split") && !hasActivePane) return t("requiresActivePane");
    if ((id.startsWith("terminal.movePane") || id === "terminal.togglePaneZoom") && !hasMultiplePanes) return t("requiresMultiplePanes");
    return undefined;
  }

  function displayShortcut(shortcut: string | undefined) {
    if (!shortcut) return undefined;
    const isMac = navigator.platform.toLowerCase().includes("mac");
    if (!isMac) return shortcut.replace("Meta", "Ctrl");
    return shortcut
      .replaceAll("Meta", "⌘")
      .replaceAll("Shift", "⇧")
      .replaceAll("Alt", "⌥")
      .replaceAll("+", "");
  }

  function openCommandPalette() {
    commandPaletteLastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    commandPaletteQuery = "";
    commandPaletteSelected = 0;
    commandPaletteOpen = true;
  }

  function openHostPickerAtElement(element: HTMLElement | null) {
    const rect = element?.getBoundingClientRect() ?? null;
    if (rect) {
      const width = Math.min(320, window.innerWidth - 20);
      const left = Math.min(Math.max(10, rect.right - width), Math.max(10, window.innerWidth - width - 10));
      const below = rect.bottom + 6;
      const above = rect.top - 426;
      hostPickerPosition = {
        left,
        top: below < window.innerHeight - 80 ? below : Math.max(10, above),
      };
    }
    hostPickerSubmenus = [];
    hostPickerOpen = !hostPickerOpen;
  }

  function closeHostPicker() {
    hostPickerOpen = false;
    hostPickerSubmenus = [];
  }

  function openHostPicker(event: MouseEvent) {
    openHostPickerAtElement(event.currentTarget instanceof HTMLElement ? event.currentTarget : null);
  }

  async function runHostPickerHost(id: string) {
    closeHostPicker();
    await createHostSession(id);
  }

  async function openHostManagerFromPicker() {
    closeHostPicker();
    if (hasTauriRuntime()) await unwrapCommand(commands.openHostManagerWindow());
  }

  function isInsideHostPickerBoundary(target: EventTarget | null) {
    return target instanceof Element && target.closest("[data-host-picker-root], [data-host-picker-trigger]") !== null;
  }

  function closeHostPickerOnExternalPointer(event: PointerEvent) {
    if (!hostPickerOpen || isInsideHostPickerBoundary(event.target)) return;
    closeHostPicker();
  }

  function closeHostPickerOnExternalFocus(event: FocusEvent) {
    if (!hostPickerOpen || isInsideHostPickerBoundary(event.target)) return;
    closeHostPicker();
  }

  function showHostPickerSubmenu(node: HostFolderTreeNode, level: number, event: MouseEvent | FocusEvent) {
    const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const width = Math.min(320, Math.max(240, window.innerWidth - 20));
    const height = Math.min(390, window.innerHeight - 20);
    const opensLeft = rect.right + 8 + width > window.innerWidth - 10;
    const left = opensLeft ? Math.max(10, rect.left - width - 8) : Math.min(window.innerWidth - width - 10, rect.right + 8);
    const top = Math.min(Math.max(10, rect.top - 6), Math.max(10, window.innerHeight - height - 10));
    hostPickerSubmenus = [...hostPickerSubmenus.slice(0, level), { node, left, top, opensLeft }];
  }

  function trimHostPickerSubmenus(level: number) {
    hostPickerSubmenus = hostPickerSubmenus.slice(0, level);
  }

  async function closeCommandPalette({ restoreFocus = true }: { restoreFocus?: boolean } = {}) {
    commandPaletteOpen = false;
    commandPaletteQuery = "";
    commandPaletteSelected = 0;
    await tick();
    if (!restoreFocus) return;
    const pane = activePane();
    if (pane?.term) {
      pane.term.focus();
      return;
    }
    commandPaletteLastFocus?.focus?.();
  }

  function updateCommandPaletteQuery(value: string) {
    commandPaletteQuery = value;
    commandPaletteSelected = 0;
  }

  function moveCommandPaletteSelection(delta: number) {
    if (!paletteResults.length) return;
    commandPaletteSelected = (commandPaletteSelected + delta + paletteResults.length) % paletteResults.length;
  }

  async function runPaletteResult(result: PaletteSearchResult) {
    recentPaletteIds = [result.id, ...recentPaletteIds.filter((id) => id !== result.id)].slice(0, 8);
    await closeCommandPalette({ restoreFocus: false });
    await runPaletteCommand(result.id);
  }

  async function runPaletteCommand(id: string) {
    if (id.startsWith("tab.switchTo:")) {
      await activateTab(id.slice("tab.switchTo:".length));
      return;
    }
    if (id.startsWith("profile.switch:")) {
      await switchActiveProfile(id.slice("profile.switch:".length));
      return;
    }
    if (id.startsWith("connection.connect:")) {
      await createHostSession(id.slice("connection.connect:".length));
      return;
    }
    if (id.startsWith("ui.theme.")) {
      await switchAppTheme(id.slice("ui.theme.".length) as "system" | "light" | "dark");
      return;
    }
    if (id === "settings.open") {
      if (hasTauriRuntime()) await unwrapCommand(commands.openSettingsWindow("main"));
      return;
    }
    if (id === "hosts.openManager") {
      if (hasTauriRuntime()) await unwrapCommand(commands.openHostManagerWindow());
      return;
    }
    if (id === "profile.new") {
      if (hasTauriRuntime()) await unwrapCommand(commands.openProfileNewDialog());
      return;
    }
    if (id === "terminal.movePaneLeft") return moveActivePane("left");
    if (id === "terminal.movePaneRight") return moveActivePane("right");
    if (id === "terminal.movePaneUp") return moveActivePane("up");
    if (id === "terminal.movePaneDown") return moveActivePane("down");
    if (id === "terminal.togglePaneZoom") return togglePaneZoom();
    runTerminalCommand(id as TerminalCommandId);
  }

  async function handleHostSessionError(
    connectionHostId: string,
    error: unknown,
    trust: {
      acceptNewHostKey?: boolean;
      updateChangedHostKey?: boolean;
      credential?: { kind: SshCredentialKind; value: string };
      saveCredential?: boolean;
    } = {},
  ) {
    const message = error instanceof Error ? error.message : String(error);
    if (isUnknownHostKeyMessage(message) && !trust.acceptNewHostKey) {
      const allow = await ask(`${message}\n\nTrust this host key and continue?`, {
        title: "SSH Host Key",
        kind: "warning",
        okLabel: "Trust Host Key",
        cancelLabel: "Cancel",
      });
      if (allow) return createHostSession(connectionHostId, { trust: { acceptNewHostKey: true } });
    }
    if (isChangedHostKeyMessage(message) && !trust.updateChangedHostKey) {
      const allow = await ask(`${message}\n\nOnly continue if you expected this host key to change.`, {
        title: "SSH Host Key Changed",
        kind: "warning",
        okLabel: "Update Trust Record",
        cancelLabel: "Cancel",
      });
      if (allow) return createHostSession(connectionHostId, { trust: { updateChangedHostKey: true } });
    }
    const credentialKind = sshCredentialKindFromError(message);
    if (credentialKind) {
      pendingSshCredential = {
        paneId: null,
        connectionHostId,
        kind: credentialKind,
        acceptNewHostKey: trust.acceptNewHostKey === true,
        updateChangedHostKey: trust.updateChangedHostKey === true,
        value: "",
        save: false,
      };
      return;
    }
    settingsError = message;
  }

  function clearHostSessionRetry(paneId: string) {
    if (!hostSessionRetryByPaneId[paneId]) return;
    const { [paneId]: _removed, ...rest } = hostSessionRetryByPaneId;
    hostSessionRetryByPaneId = rest;
  }

  function markConnectionCancelled(paneId: string, message: string) {
    clearHostSessionRetry(paneId);
    void unwrapCommand(commands.closeTerminalSession(paneId)).catch(() => {});
    terminalTabs.markConnectionCancelled(paneId, message);
  }

  function isChangedHostKeyMessage(message: string) {
    return message.includes("host key changed");
  }

  function isUnknownHostKeyMessage(message: string) {
    return message.includes("not trusted") && !isChangedHostKeyMessage(message);
  }

  async function handleTerminalExit(event: TerminalExitEvent) {
    const retry = hostSessionRetryByPaneId[event.session_id];
    if (retry && event.signal) {
      if (handleSshCredentialExit(event.session_id, retry, event.signal)) return;
      if (await handleSshTrustExit(event.session_id, retry, event.signal)) return;
    }
    clearHostSessionRetry(event.session_id);
    terminalTabs.markExited(event);
  }

  async function handleSshTrustExit(paneId: string, retry: HostSessionRetry, message: string) {
    if (isUnknownHostKeyMessage(message) && !retry.acceptNewHostKey) {
      const allow = await ask(`${message}\n\nTrust this host key and reconnect?`, {
        title: "SSH Host Key",
        kind: "warning",
        okLabel: "Trust Host Key",
        cancelLabel: "Cancel",
      });
      clearHostSessionRetry(paneId);
      if (allow) {
        try {
          await reconnectHostSessionInPane(paneId, retry.connectionHostId, { acceptNewHostKey: true });
        } catch (error) {
          terminalTabs.markConnectionError(paneId, error instanceof Error ? error.message : String(error));
        }
      } else {
        markConnectionCancelled(paneId, "SSH host key was not trusted. Connection canceled.");
      }
      return true;
    }
    if (isChangedHostKeyMessage(message) && !retry.updateChangedHostKey) {
      const allow = await ask(`${message}\n\nOnly continue if you expected this host key to change.`, {
        title: "SSH Host Key Changed",
        kind: "warning",
        okLabel: "Update Trust Record",
        cancelLabel: "Cancel",
      });
      clearHostSessionRetry(paneId);
      if (allow) {
        try {
          await reconnectHostSessionInPane(paneId, retry.connectionHostId, { updateChangedHostKey: true });
        } catch (error) {
          terminalTabs.markConnectionError(paneId, error instanceof Error ? error.message : String(error));
        }
      } else {
        markConnectionCancelled(paneId, "SSH host key changed. Connection canceled.");
      }
      return true;
    }
    return false;
  }

  function handleSshCredentialExit(paneId: string, retry: HostSessionRetry, message: string) {
    const credentialKind = sshCredentialKindFromError(message);
    if (!credentialKind) return false;
    clearHostSessionRetry(paneId);
    terminalTabs.markConnectionPrompt(paneId, "Waiting for SSH credential");
    pendingSshCredential = {
      paneId,
      connectionHostId: retry.connectionHostId,
      kind: credentialKind,
      acceptNewHostKey: retry.acceptNewHostKey === true,
      updateChangedHostKey: retry.updateChangedHostKey === true,
      value: "",
      save: false,
    };
    return true;
  }

  function sshCredentialKindFromError(message: string): SshCredentialKind | null {
    if (message.includes("ssh credential required: key_passphrase")) return "key_passphrase";
    if (message.includes("ssh credential required: password")) return "password";
    return null;
  }

  async function submitSshCredential() {
    if (!pendingSshCredential) return;
    const pending = pendingSshCredential;
    pendingSshCredential = null;
    const trust = {
      acceptNewHostKey: pending.acceptNewHostKey,
      updateChangedHostKey: pending.updateChangedHostKey,
      credential: { kind: pending.kind, value: pending.value },
      saveCredential: pending.save,
    };
    if (pending.paneId) {
      try {
        await reconnectHostSessionInPane(pending.paneId, pending.connectionHostId, trust);
      } catch (error) {
        terminalTabs.markConnectionError(pending.paneId, error instanceof Error ? error.message : String(error));
      }
    } else {
      await createHostSession(pending.connectionHostId, { trust });
    }
  }

  function cancelSshCredential() {
    if (pendingSshCredential?.paneId) {
      markConnectionCancelled(pendingSshCredential.paneId, "SSH credential prompt canceled.");
    }
    pendingSshCredential = null;
  }

  $effect(() => {
    if (!pendingSshCredential) return;
    void tick().then(() => sshCredentialInput?.focus());
  });

  async function switchActiveProfile(name: string) {
    await unwrapCommand(commands.setActiveProfile(name));
    await loadSettings();
    if (activePane()?.term) activePane()?.term?.focus();
  }

  async function switchAppTheme(theme: "system" | "light" | "dark") {
    const snapshot = lastConfigSnapshot ?? (await unwrapCommand(commands.getConfigSnapshot()));
    const next = JSON.parse(JSON.stringify(snapshot.main_config)) as typeof snapshot.main_config;
    writeValue(next.root, ["ui", "theme"], configString(theme));
    await unwrapCommand(commands.updateMainConfig(next));
    await loadSettings();
    await unwrapCommand(commands.refreshAppMenu());
    if (activePane()?.term) activePane()?.term?.focus();
  }

  async function moveActivePane(side: SplitSide) {
    const tab = activeTab;
    if (!tab || tab.panes.length < 2) return;
    const targetPaneId = siblingPane(side);
    if (!targetPaneId || targetPaneId === tab.activePaneId) return;
    await movePaneToPane(tab.activePaneId, targetPaneId, side);
  }

  async function togglePaneZoom() {
    const tab = activeTab;
    if (!tab || tab.panes.length < 2) return;
    if (zoomedPane && zoomedPane.tabId === tab.id) {
      tab.tree = clonePaneTree(zoomedPane.tree);
      tab.activePaneId = terminalPaneById(tab, zoomedPane.activePaneId) ? zoomedPane.activePaneId : tab.activePaneId;
      zoomedPane = null;
      refreshTerminalTabTitle(tab);
      await mountAndFitTabPanes(tab);
      terminalPaneById(tab, tab.activePaneId)?.term?.focus();
      return;
    }
    zoomedPane = {
      tabId: tab.id,
      paneId: tab.activePaneId,
      tree: clonePaneTree(tab.tree),
      activePaneId: tab.activePaneId,
    };
    tab.tree = { kind: "leaf", paneId: tab.activePaneId };
    refreshTerminalTabTitle(tab);
    await mountAndFitTabPanes(tab);
    terminalPaneById(tab, tab.activePaneId)?.term?.focus();
  }

  async function zoomPane(paneId: string) {
    await activatePane(paneId);
    await togglePaneZoom();
  }

  async function runTerminalMenuCommand(command: TerminalMenuEvent["command"]) {
    if (command === "open_command_palette") {
      openCommandPalette();
      return;
    }
    if (command === "new_window") {
      if (hasTauriRuntime()) await unwrapCommand(commands.openMainWindow(null));
      return;
    }
    if (command === "new_tab") {
      await openDefaultSession();
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
    if (command === "zoom_split") return togglePaneZoom();
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
    if (commandPaletteOpen) return;
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
    if (command === "terminal.openCommandPalette") {
      openCommandPalette();
      return;
    }
    if (command === "terminal.newSession") {
      void openDefaultSession();
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
      return;
    }
    if (command === "terminal.find") {
      showFind();
      return;
    }
    if (command === "terminal.findNext") {
      findNext();
      return;
    }
    if (command === "terminal.findPrevious") {
      findPrevious();
    }
  }

  onMount(() => {
    let mounted = true;
    void (async () => {
      if (hasTauriRuntime()) {
        const [outputDispose, exitDispose, transportStateDispose, configDispose, paneMenuDispose, terminalMenuDispose] = await Promise.all([
          listen<TerminalOutputEvent>("terminal://output", (event) => enqueueTerminalOutput(event.payload)),
          listen<TerminalExitEvent>("terminal://exit", (event) => {
            void handleTerminalExit(event.payload).catch((error) => {
              settingsError = error instanceof Error ? error.message : String(error);
            });
          }),
          listen<TerminalTransportStateEvent>("terminal://transport-state", (event) => terminalTabs.markTransportState(event.payload)),
          listen("config://changed", () => {
            void loadSettings().catch((error) => {
              settingsError = error instanceof Error ? error.message : String(error);
            });
          }),
          listen<PaneMenuEvent>("terminal://pane-menu", (event) => handlePaneMenu(event.payload)),
          listen<TerminalMenuEvent>("terminal://menu-command", (event) => {
            void runTerminalMenuCommand(event.payload.command).catch((error) => {
              settingsError = error instanceof Error ? error.message : String(error);
            });
          }),
        ]);
        if (!mounted) {
          outputDispose();
          exitDispose();
          transportStateDispose();
          configDispose();
          paneMenuDispose();
          terminalMenuDispose();
          return;
        }
        outputUnlisten = outputDispose;
        exitUnlisten = exitDispose;
        transportStateUnlisten = transportStateDispose;
        configUnlisten = configDispose;
        paneMenuUnlisten = paneMenuDispose;
        terminalMenuUnlisten = terminalMenuDispose;
      }
      await loadSettings();
      const restored = (await restoreTabHandoff()) || (await restoreHotTabs());
      await ensureStartupSession(restored);
    })().catch((error) => {
      settingsError = error instanceof Error ? error.message : String(error);
    });
    window.addEventListener("keydown", handleKeyboard, { capture: true });
    window.addEventListener("pointermove", handlePointerMove, { capture: true });
    window.addEventListener("pointerup", handlePointerUp, { capture: true });
    window.addEventListener("pointercancel", handlePointerCancel, { capture: true });
    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("focus", syncTerminalMenuState);
    document.addEventListener("pointerdown", closeHostPickerOnExternalPointer, { capture: true });
    document.addEventListener("beforeinput", handleTextInputBeforeInput);
    document.addEventListener("focusin", closeHostPickerOnExternalFocus, { capture: true });
    document.addEventListener("input", handleTextInputInput);
    document.addEventListener("focusin", handleTextInputFocus);
    document.addEventListener("focusout", syncTerminalMenuState);
    document.addEventListener("selectionchange", syncTerminalMenuState);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    syncTerminalMenuState();
    return () => {
      mounted = false;
      window.removeEventListener("keydown", handleKeyboard, { capture: true });
      window.removeEventListener("pointermove", handlePointerMove, { capture: true });
      window.removeEventListener("pointerup", handlePointerUp, { capture: true });
      window.removeEventListener("pointercancel", handlePointerCancel, { capture: true });
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("focus", syncTerminalMenuState);
      document.removeEventListener("pointerdown", closeHostPickerOnExternalPointer, { capture: true });
      document.removeEventListener("beforeinput", handleTextInputBeforeInput);
      document.removeEventListener("focusin", closeHostPickerOnExternalFocus, { capture: true });
      document.removeEventListener("input", handleTextInputInput);
      document.removeEventListener("focusin", handleTextInputFocus);
      document.removeEventListener("focusout", syncTerminalMenuState);
      document.removeEventListener("selectionchange", syncTerminalMenuState);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      outputUnlisten?.();
      exitUnlisten?.();
      transportStateUnlisten?.();
      configUnlisten?.();
      paneMenuUnlisten?.();
      terminalMenuUnlisten?.();
      if (isHotModuleReplacement) {
        storeHotTabsSnapshot();
        for (const tab of tabs) disposeTerminalTab(tab);
        return;
      }
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
    findCaseSensitive;
    findRegex;
    findSnapshot;
    void tick().then(syncTerminalMenuState);
  });

</script>

<main class:integrated-titlebar={integratedTitlebar} class:left-tabs={tabsOnLeft} class:vertical={isVertical} class="workspace">
  <div class="terminal-measure-host" aria-hidden="true">
    <div class="terminal-mount" bind:this={terminalMeasureContainer}></div>
  </div>

  {#if !isVertical || tabsOnLeft}
    <TerminalTabBar
      {tabs}
      {activeId}
      placement={tabBarOrientation}
      {integratedTitlebar}
      {activateTab}
      {closeTab}
      {newSession}
      openHostPicker={openHostPicker}
      {handleNewSessionSecondaryClick}
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
      {integratedTitlebar}
      {activateTab}
      {closeTab}
      {newSession}
      openHostPicker={openHostPicker}
      {handleNewSessionSecondaryClick}
      openContextMenu={tabContextMenu}
      {startTabPointerDrag}
    />
  {/if}

  {#if hostPickerOpen}
    <section
      class="connection-picker"
      style={`--picker-left: ${hostPickerPosition.left}px; --picker-top: ${hostPickerPosition.top}px;`}
      aria-label="Hosts"
      data-host-picker-root="true"
    >
      <OverlayScrollbarsComponent
        element="div"
        class="connection-picker-scroll"
        options={{
          overflow: {
            x: "hidden",
            y: "scroll",
          },
          scrollbars: {
            autoHide: "leave",
            autoHideDelay: 360,
            theme: "os-theme-nocturne",
          },
        }}
        defer
      >
        <div class="connection-picker-content">
          {#each hostPickerGroups().hosts as host}
            <button type="button" disabled={hostHasBlockingDiagnostics(host)} onclick={() => void runHostPickerHost(host.id)}>
              <span>{host.document.name}</span>
              <small>{hostSubtitle(host)}</small>
            </button>
          {/each}
          {#each hostPickerGroups().children as node}
            {@render pickerFolderRow(node, 0)}
          {/each}
          <button class="manager-row" type="button" onclick={() => void openHostManagerFromPicker()}>
            <span>Manage Hosts</span>
            <small>Open Host Manager</small>
          </button>
        </div>
      </OverlayScrollbarsComponent>
    </section>
    {#each hostPickerSubmenus as menu, index}
      <section
        class:opens-left={menu.opensLeft}
        class="connection-picker picker-submenu"
        style={`--picker-left: ${menu.left}px; --picker-top: ${menu.top}px;`}
        aria-label={menu.node.name}
        data-host-picker-root="true"
        onmouseenter={() => trimHostPickerSubmenus(index + 1)}
      >
        <OverlayScrollbarsComponent
          element="div"
          class="connection-picker-scroll"
          options={{
            overflow: {
              x: "hidden",
              y: "scroll",
            },
            scrollbars: {
              autoHide: "leave",
              autoHideDelay: 360,
              theme: "os-theme-nocturne",
            },
          }}
          defer
        >
          <div class="connection-picker-content">
            {#each menu.node.hosts as host}
              <button type="button" disabled={hostHasBlockingDiagnostics(host)} onclick={() => void runHostPickerHost(host.id)}>
                <span>{host.document.name}</span>
                <small>{hostSubtitle(host)}</small>
              </button>
            {/each}
            {#each menu.node.children as child}
              {@render pickerFolderRow(child, index + 1)}
            {/each}
          </div>
        </OverlayScrollbarsComponent>
      </section>
    {/each}
  {/if}

  {#if pendingSshCredential}
    <form
      class="ssh-credential-sheet"
      onsubmit={(event) => {
        event.preventDefault();
        void submitSshCredential();
      }}
    >
      <header>
        <h2>{pendingSshCredential.kind === "password" ? "SSH Password" : "SSH Key Passphrase"}</h2>
        <button type="button" aria-label="Cancel" title="Cancel" onclick={cancelSshCredential}>×</button>
      </header>
      <input
        type="password"
        autocomplete="off"
        bind:this={sshCredentialInput}
        bind:value={pendingSshCredential.value}
        aria-label={pendingSshCredential.kind === "password" ? "SSH password" : "SSH key passphrase"}
      />
      <label>
        <input type="checkbox" bind:checked={pendingSshCredential.save} />
        <span>Save in system keyring</span>
      </label>
      <footer>
        <button type="button" onclick={cancelSshCredential}>Cancel</button>
        <button type="submit">Connect</button>
      </footer>
    </form>
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
      <div class="find-input-wrap">
        <input
          class:error={findSnapshot.error}
          bind:this={findInput}
          bind:value={findQuery}
          aria-label={t("find")}
          aria-invalid={findSnapshot.error ? "true" : "false"}
          placeholder={t("find")}
          spellcheck="false"
          title={findSnapshot.error}
          oninput={updateFindQuery}
          onkeydown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              hideFind();
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (event.shiftKey) findPrevious({ focusTerminal: false });
              else findNext({ focusTerminal: false });
            }
          }}
        />
        <span class:error={findSnapshot.error} class="find-count">{findCountLabel()}</span>
      </div>
      <button
        type="button"
        class:active={findCaseSensitive}
        aria-label={t("matchCase")}
        aria-pressed={findCaseSensitive}
        title={t("matchCase")}
        onclick={toggleFindCaseSensitive}
      >
        Aa
      </button>
      <button
        type="button"
        class:active={findRegex}
        aria-label={t("useRegex")}
        aria-pressed={findRegex}
        title={t("useRegex")}
        onclick={toggleFindRegex}
      >
        .*
      </button>
      <button
        type="button"
        aria-label={t("copyMatchingLine")}
        title={t("copyMatchingLine")}
        disabled={!canCopyMatchingLine()}
        onclick={() => void copyMatchingLine()}
      >
        ⧉
      </button>
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

  <CommandPalette
    open={commandPaletteOpen}
    query={commandPaletteQuery}
    results={paletteResults}
    selectedIndex={commandPaletteSelected}
    onQuery={updateCommandPaletteQuery}
    onClose={closeCommandPalette}
    onMove={moveCommandPaletteSelection}
    onRun={(item) => void runPaletteResult(item)}
  />

</main>

{#snippet pickerFolderRow(node: HostFolderTreeNode, level: number)}
  <button
    class="folder-row"
    type="button"
    aria-haspopup="menu"
    aria-expanded={hostPickerSubmenus[level]?.node.path === node.path}
    onmouseenter={(event) => showHostPickerSubmenu(node, level, event)}
    onfocus={(event) => showHostPickerSubmenu(node, level, event)}
  >
    <span>{node.name}</span>
    <small>{node.hosts.length + node.children.length} item(s)</small>
    <em>›</em>
  </button>
{/snippet}

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

  .connection-picker {
    position: fixed;
    top: var(--picker-top);
    left: var(--picker-left);
    z-index: 18;
    width: min(320px, calc(100vw - 20px));
    max-height: min(410px, calc(100vh - 62px));
    overflow: hidden;
    padding: 6px;
    border: 1px solid color-mix(in srgb, var(--app-fg) 16%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--app-bg) 94%, transparent);
    box-shadow: 0 14px 34px color-mix(in srgb, #000 22%, transparent);
    -webkit-backdrop-filter: blur(18px);
    backdrop-filter: blur(18px);
  }

  .connection-picker :global(.connection-picker-scroll) {
    max-height: min(398px, calc(100vh - 74px));
  }

  .connection-picker-content {
    display: grid;
    gap: 2px;
  }

  .connection-picker button {
    min-width: 0;
    min-height: 42px;
    display: grid;
    gap: 2px;
    border: 0;
    border-radius: 6px;
    padding: 6px 9px;
    color: inherit;
    background: transparent;
    font: inherit;
    text-align: left;
  }

  .connection-picker button:hover:not(:disabled) {
    background: color-mix(in srgb, var(--app-fg) 10%, transparent);
  }

  .connection-picker button:active:not(:disabled) {
    background: var(--app-active);
  }

  .connection-picker button:disabled {
    color: color-mix(in srgb, var(--app-fg) 38%, transparent);
  }

  .connection-picker .folder-row {
    position: relative;
    grid-template-columns: minmax(0, 1fr) auto;
    padding-right: 24px;
  }

  .connection-picker .folder-row em {
    position: absolute;
    right: 9px;
    align-self: center;
    color: color-mix(in srgb, var(--app-fg) 54%, transparent);
    font-style: normal;
  }

  .picker-submenu {
    z-index: 19;
  }

  .picker-submenu :global(.connection-picker-scroll) {
    max-height: min(398px, calc(100vh - 74px));
  }

  .connection-picker span,
  .connection-picker small {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .connection-picker span {
    font-size: 13px;
    line-height: 1.15;
  }

  .connection-picker small {
    color: color-mix(in srgb, var(--app-fg) 58%, transparent);
    font-size: 11px;
    line-height: 1.15;
  }

  .connection-picker .manager-row {
    border-top: 1px solid color-mix(in srgb, var(--app-fg) 12%, transparent);
    border-radius: 0 0 6px 6px;
    margin-top: 4px;
  }

  :global(.os-theme-nocturne.os-scrollbar) {
    --os-size: 7px;
    --os-padding-perpendicular: 2px;
    --os-padding-axis: 4px;
    --os-handle-border-radius: 999px;
    --os-handle-bg: color-mix(in srgb, var(--app-fg) 26%, transparent);
    --os-handle-bg-hover: color-mix(in srgb, var(--app-fg) 34%, transparent);
    --os-handle-bg-active: color-mix(in srgb, var(--app-fg) 42%, transparent);
  }

  .ssh-credential-sheet {
    position: fixed;
    top: 50%;
    left: 50%;
    z-index: 22;
    width: min(380px, calc(100vw - 28px));
    display: grid;
    gap: 12px;
    transform: translate(-50%, -50%);
    padding: 14px;
    border: 1px solid color-mix(in srgb, var(--app-fg) 18%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--app-bg) 96%, transparent);
    box-shadow: 0 18px 42px color-mix(in srgb, #000 28%, transparent);
    -webkit-backdrop-filter: blur(18px);
    backdrop-filter: blur(18px);
  }

  .ssh-credential-sheet header,
  .ssh-credential-sheet footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .ssh-credential-sheet h2 {
    margin: 0;
    font-size: 15px;
    line-height: 1.2;
  }

  .ssh-credential-sheet input[type="password"] {
    width: 100%;
    height: 32px;
    border: 1px solid color-mix(in srgb, var(--app-fg) 18%, transparent);
    border-radius: 6px;
    padding: 0 9px;
    background: color-mix(in srgb, var(--app-bg) 82%, var(--app-fg));
    color: var(--app-fg);
    font: inherit;
  }

  .ssh-credential-sheet label {
    display: flex;
    align-items: center;
    gap: 8px;
    color: color-mix(in srgb, var(--app-fg) 78%, transparent);
    font-size: 12px;
    user-select: none;
    -webkit-user-select: none;
  }

  .ssh-credential-sheet button {
    min-height: 28px;
    border: 0;
    border-radius: 6px;
    padding: 4px 10px;
    color: inherit;
    background: transparent;
    font: inherit;
  }

  .ssh-credential-sheet button:active {
    background: var(--app-active);
  }

  .terminal-mount {
    position: relative;
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
    scrollbar-color: transparent transparent;
    scrollbar-width: none;
  }

  :global(.xterm .xterm-viewport::-webkit-scrollbar) {
    width: 0;
    height: 0;
    display: none;
  }

  :global(.terminal-scrollbar) {
    position: absolute;
    top: 6px;
    right: 4px;
    bottom: 6px;
    z-index: 18;
    width: 10px;
    display: flex;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
  }

  :global(.terminal-scrollbar.terminal-scrollbar-visible) {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
  }

  :global(.terminal-scrollbar-track) {
    position: relative;
    width: 100%;
    height: 100%;
    background: transparent;
  }

  :global(.terminal-scrollbar-handle) {
    position: absolute;
    right: 0;
    width: 100%;
    min-height: 28px;
    border-radius: 999px;
    background: rgba(222, 228, 236, 0.68);
    opacity: 1;
  }

  :global(.terminal-scrollbar:hover .terminal-scrollbar-handle) {
    background: rgba(222, 228, 236, 0.82);
  }

  :global(.terminal-scrollbar:active .terminal-scrollbar-handle) {
    background: rgba(222, 228, 236, 0.92);
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
    grid-template-columns: minmax(190px, 280px) repeat(6, 30px);
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

  .find-input-wrap {
    position: relative;
    min-width: 0;
  }

  .find-bar input {
    width: 100%;
    min-width: 0;
    height: 28px;
    border: 1px solid color-mix(in srgb, var(--app-fg) 14%, transparent);
    border-radius: 6px;
    padding: 0 58px 0 9px;
    background: color-mix(in srgb, var(--app-bg) 82%, var(--app-fg));
    color: var(--app-fg);
    font: inherit;
    font-size: 13px;
    outline: none;
  }

  .find-bar input.error {
    border-color: var(--app-danger);
  }

  .find-bar input:focus-visible {
    border-color: var(--terminal-selection);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--terminal-selection) 34%, transparent);
  }

  .find-bar input.error:focus-visible {
    border-color: var(--app-danger);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--app-danger) 28%, transparent);
  }

  .find-count {
    position: absolute;
    top: 50%;
    right: 9px;
    max-width: 48px;
    transform: translateY(-50%);
    color: color-mix(in srgb, var(--app-fg) 58%, transparent);
    font-size: 11px;
    line-height: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    pointer-events: none;
    user-select: none;
    -webkit-user-select: none;
  }

  .find-count.error {
    color: var(--app-danger);
    font-weight: 600;
  }

  .find-bar button {
    width: 30px;
    height: 28px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: color-mix(in srgb, var(--app-fg) 82%, transparent);
    font: inherit;
    font-size: 13px;
    line-height: 1;
    user-select: none;
    -webkit-user-select: none;
  }

  .find-bar button:hover {
    background: color-mix(in srgb, var(--app-fg) 10%, transparent);
  }

  .find-bar button.active {
    background: color-mix(in srgb, var(--terminal-selection) 36%, transparent);
    color: var(--app-fg);
  }

  .find-bar button:active {
    background: color-mix(in srgb, var(--app-fg) 16%, transparent);
  }

  .find-bar button:disabled {
    color: color-mix(in srgb, var(--app-fg) 28%, transparent);
  }

  .find-bar button:disabled:hover,
  .find-bar button:disabled:active {
    background: transparent;
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
      grid-template-columns: minmax(0, 1fr) repeat(6, 30px);
    }
  }
</style>
