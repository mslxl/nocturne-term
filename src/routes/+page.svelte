<script lang="ts">
  import { onMount, tick } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { ask } from "@tauri-apps/plugin-dialog";
  import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { OverlayScrollbarsComponent } from "overlayscrollbars-svelte";
  import "overlayscrollbars/overlayscrollbars.css";
  import "@xterm/xterm/css/xterm.css";
  import {
    commands,
    type AppConfigSnapshot,
    type ConnectionHostIcon,
    type PaneMenuEvent,
    type PortForwardSshVerificationRequiredEvent,
    type TabBarOrientation,
    type TerminalSessionInfo,
    type TerminalSettings,
    type WorkspaceSshVerificationRequiredEvent,
    type WorkspaceDockLayout,
    type WorkspaceFloatingWindowState,
    type WorkspaceDispatchInput,
    type WorkspaceLayoutSnapshot,
    type WorkspaceTabState,
    type WorkspaceToolSlot,
    type WorkspaceToolTab,
  } from "$lib/bindings";
  import { appLanguageFromConfig, appThemeFromConfig, applyAppPreferences, booleanValue, configString, integerValue, readValue, resolveTheme, stringArrayValue, stringValue, writeValue } from "$lib/config/document";
  import CommandPalette from "$lib/command-palette/CommandPalette.svelte";
  import { staticPaletteCommands } from "$lib/command-palette/commands";
  import { localizeCommand, searchPaletteItems, type PaletteItem, type PaletteSearchResult } from "$lib/command-palette/search";
  import HostIcon from "$lib/hosts/HostIcon.svelte";
  import { resolveHostIcon } from "$lib/hosts/icons";
  import { buildHostFolderTree, hostFolderLabel, hostHasBlockingDiagnostics, hostSubtitle, type HostFolderTreeNode } from "$lib/hosts/model";
  import { hasTauriRuntime } from "$lib/tauri/runtime";
  import { dockSplitGridTemplate, resizeWorkspaceDockSplit } from "$lib/workspace/dock/resize";
  import WorkspaceDockGroup from "$lib/workspace/components/WorkspaceDockGroup.svelte";
  import WorkspaceTabBar from "$lib/workspace/components/WorkspaceTabBar.svelte";
  import { mountDecorumTitlebarHost } from "$lib/window/decorum-titlebar";
  import { createWorkspaceStore } from "$lib/workspace/state.svelte";
  import { unwrapCommand } from "$lib/terminal/commands";
  import { addNonLoopbackConfirmation } from "$lib/ports/editing";
  import FilesToolTab from "$lib/files/FilesToolTab.svelte";
  import { FILES_WORKSPACE_SSH_VERIFICATION_SUBMITTED_EVENT } from "$lib/files/workspace-verification";
  import PortsToolTab from "$lib/ports/PortsToolTab.svelte";
  import ResourceMonitorToolTab from "$lib/resources/ResourceMonitorToolTab.svelte";
  import { DEFAULT_FILES_TOOLBAR_ACTION_IDS, normalizeFilesToolbarActionIds, type FilesToolbarActionId } from "$lib/files/toolbar-actions";
  import TransfersToolTab from "$lib/transfers/TransfersToolTab.svelte";
  import { startTransferQueueObserver } from "$lib/transfers/queue.svelte";
  import { routeTerminalPaneEvent, shouldHandleTerminalPaneEvent } from "$lib/terminal/event-routing";
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
  import { TerminalRuntimeCreationGate } from "$lib/terminal/runtime-creation";
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
    workspaceId: string;
    toolTabId: string;
    acceptNewHostKey?: boolean;
    updateChangedHostKey?: boolean;
  };
  type PendingSshCredential = {
    scope: "workspace" | "port_forward";
    verificationId: string;
    workspaceId?: string;
    hostId?: string;
    toolTabId: string | null;
    authTargetLabel: string;
    kind: SshCredentialKind;
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
  type TerminalToolRuntime = {
    tab: TerminalTab;
    toolTabId: string;
  };
  type TerminalRenderMode = {
    workspace: WorkspaceTabState;
  };
  type ToolTabContextMenu = {
    workspaceId: string;
    slotId: string;
    toolTabId: string | null;
    groupId: string;
    left: number;
    top: number;
  };
  type ToolTabDropTarget =
    | { kind: "group"; workspaceId: string; groupId: string }
    | { kind: "split"; workspaceId: string; slotId: string; side: "left" | "right" | "up" | "down" }
    | { kind: "workspace_edge"; workspaceId: string; side: "left" | "right" | "up" | "down" }
    | { kind: "workspace"; workspaceId: string }
    | { kind: "float"; workspaceId: string };
  type ToolTabDropPreview = {
    kind: "group" | "split" | "workspace_edge";
    side: "" | "left" | "right" | "up" | "down";
    style: string;
  };
  type DockGroupBounds = {
    left: boolean;
    right: boolean;
    top: boolean;
    bottom: boolean;
  };
  type ToolTabbarPlacement = "top" | "left" | "right" | "bottom";
  type AppMenuRootId = "file" | "edit" | "view" | "window";

  let settings = $state<TerminalSettings | null>(null);
  let lastConfigSnapshot = $state<AppConfigSnapshot | null>(null);
  let keybindings = $state<KeybindingMap | null>(null);
  let settingsError = $state("");
  let tabs = $state<TerminalTab[]>([]);
  let activeId = $state("");
  let terminalRuntimeByToolTabId = $state(new Map<string, TerminalToolRuntime>());
  let terminalTitleRevision = $state(0);
  let activeTerminalWorkspaceId = "";
  let activeTerminalToolTabId = $state("");
  let lastActivatedContentGroupIdByWorkspace = new Map<string, string>();
  let tabBarOrientation = $state<TabBarOrientation>("horizontal");
  let outputUnlisten: undefined | (() => void);
  let exitUnlisten: undefined | (() => void);
  let transportStateUnlisten: undefined | (() => void);
  let configUnlisten: undefined | (() => void);
  let workspaceSshVerificationUnlisten: undefined | (() => void);
  let portForwardSshVerificationUnlisten: undefined | (() => void);
  let paneMenuUnlisten: undefined | (() => void);
  let terminalMenuUnlisten: undefined | (() => void);
  let terminalMeasureContainer: HTMLDivElement;
  let appTheme: "light" | "dark" = "light";
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
  let toolTabContextMenu = $state<ToolTabContextMenu | null>(null);
  let integratedTitlebarSetting = $state(false);
  let integratedTitlebarSingleRowSetting = $state(false);
  let showHostIconsInTabs = $state(false);
  let defaultFilesViewMode = $state<"tree" | "columns">("tree");
  let showHiddenFiles = $state(true);
  let filesDeleteBehavior = $state<"direct" | "try_remote_trash">("direct");
  let textPreviewLimitBytes = $state(1_048_576);
  let imagePreviewLimitBytes = $state(10_485_760);
  let filesToolbarActionIds = $state<FilesToolbarActionId[]>([...DEFAULT_FILES_TOOLBAR_ACTION_IDS]);
  let filesTreeStickyEnabled = $state(true);
  let filesTreeStickyMaxLevels = $state(3);
  let pendingSshCredential = $state<PendingSshCredential | null>(null);
  let hostSessionRetryByPaneId = $state<Record<string, HostSessionRetry>>({});
  let commandPaletteLastFocus: HTMLElement | null = null;
  let recentPaletteIds = $state<string[]>([]);
  let zoomedPane = $state<{ tabId: string; paneId: string; tree: TerminalTab["tree"]; activePaneId: string } | null>(null);
  let lastFocusedTextInput: TextInputElement | null = null;
  let serializedMenuState = "";
  let undoStack: TerminalUndoAction[] = [];
  let redoStack: TerminalRedoAction[] = [];
  let startupSessionPromise: Promise<void> | null = null;
  const terminalRuntimeCreationGate = new TerminalRuntimeCreationGate();
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
  let dockResizeDrag = $state<{
    workspaceId: string | null;
    floatingWindowId: string | null;
    baseLayout: WorkspaceDockLayout;
    splitPath: number[];
    dividerIndex: number;
    direction: "row" | "column";
    startClient: number;
    containerPixels: number;
    pointerId: number;
  } | null>(null);
  let dragState = $state<{ kind: "pane" | "tab"; id: string } | null>(null);
  let toolTabDragState = $state<{ workspaceId: string; slotId: string; toolTabId: string | null; active: boolean } | null>(null);
  let toolTabDropTarget = $state<ToolTabDropTarget | null>(null);
  let activeToolSlotOverrideByGroupId = $state<Record<string, string>>({});
  let activeToolSlotOverrideRevision = $state(0);
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
  let toolTabPointerDrag = $state<{
    workspaceId: string;
    slotId: string;
    toolTabId: string | null;
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
    target: HTMLElement;
  } | null>(null);
  const isHotModuleReplacement = import.meta.hot !== undefined;
  const workspaceStore = createWorkspaceStore();
  const confirmedAutoOpenPortRules = new Set<string>();

  let activeTab = $derived(tabs.find((tab) => tab.id === activeId));
  let workspaceViewSnapshot = $state<WorkspaceLayoutSnapshot | null>(null);
  let workspaceSnapshot = $derived(workspaceViewSnapshot);
  let workspaceRenderRevision = $state(0);
  let activeWorkspace = $derived.by(() => {
    const snapshot = workspaceSnapshot;
    return snapshot?.workspaces.find((workspace) => workspace.id === snapshot.active_workspace_id) ?? null;
  });
  let floatingWindowId = $state<string | null>(null);
  let activeFloatingWindow = $derived(
    floatingWindowId
      ? (workspaceSnapshot?.floating_windows.find((window) => window.id === floatingWindowId) ?? null)
      : null,
  );
  let isVertical = $derived(tabBarOrientation !== "horizontal");
  let tabsOnLeft = $derived(tabBarOrientation === "vertical_left");
  let integratedTitlebar = $derived(isDesktopPlatform() && integratedTitlebarSetting && !isVertical);
  let integratedTitlebarChrome = $derived.by<"macos" | "decorum" | null>(() =>
    integratedTitlebar ? (isMacPlatform() ? "macos" : "decorum") : null,
  );
  let integratedTitlebarSingleRow = $derived(integratedTitlebarChrome === "decorum" && integratedTitlebarSingleRowSetting);
  let integratedTitlebarLayout = $derived.by<"single-row" | "two-row">(() =>
    integratedTitlebarSingleRow ? "single-row" : "two-row",
  );
  let appMenuRoots = $derived([
    { id: "file" as const, label: language() === "zh" ? "文件" : "File" },
    { id: "edit" as const, label: t("edit") },
    { id: "view" as const, label: language() === "zh" ? "视图" : "View" },
    { id: "window" as const, label: language() === "zh" ? "窗口" : "Window" },
  ]);
  let hostIconById = $derived(hostIconMap(lastConfigSnapshot));
  let paletteResults = $derived(
    searchPaletteItems(buildPaletteItems(), commandPaletteQuery, {
      language: language(),
      includeDisabledExact: commandPaletteQuery.trim().length > 0,
    }),
  );
  const terminalTabs = createTerminalTabController({
    settings: () => settings,
    tabs: () => terminalRuntimeTabs(),
    setGlobalError: (message) => {
      settingsError = message;
    },
    notifySelectionChange: () => {
      syncTerminalMenuState();
    },
    notifyTitleChange: () => {
      terminalTitleRevision += 1;
    },
    requestReconnect: (paneId) => {
      void reconnectPaneAfterDisconnect(paneId);
    },
  });

  function syncWorkspaceSnapshot(next: WorkspaceLayoutSnapshot | null) {
    workspaceViewSnapshot = next;
    workspaceRenderRevision += 1;
    if (typeof window !== "undefined") {
      Object.assign(window, {
        __NOCTURNE_WORKSPACE_DEBUG__: {
          snapshot: next,
          workspaceRenderRevision,
          activeToolSlotOverrideByGroupId,
          activeToolSlotOverrideRevision,
        },
      });
    }
  }

  async function dispatchWorkspaceIntent(intent: WorkspaceDispatchInput["intent"]) {
    const next = await workspaceStore.dispatch(intent);
    syncWorkspaceSnapshot(next);
    return next;
  }

  function replaceWorkspaceSnapshot(next: WorkspaceLayoutSnapshot) {
    workspaceStore.replaceSnapshot(next);
    syncWorkspaceSnapshot(next);
  }

  function terminalRuntimeTabs() {
    return Array.from(terminalRuntimeByToolTabId.values()).map((runtime) => runtime.tab);
  }

  async function loadSettings() {
    settingsError = "";
    if (!hasTauriRuntime()) {
      const root = { values: {} };
      const snapshot: AppConfigSnapshot = {
        root: {
          root_dir: "/demo",
          active_profile: "default",
          main_config_path: "/demo/nocturne.toml",
          profile_config_path: "/demo/profiles/default.toml",
          state_path: "/demo/state.toml",
          host_dirs: [],
          openssh_config_files: [],
          default_host: "demo-local",
        },
        main_config: { root },
        profile_config: { root },
        effective_config: { root },
        profiles: [],
        hosts: [],
      };
      lastConfigSnapshot = snapshot;
      applyAppPreferences(snapshot.effective_config.root);
      setLanguage(appLanguageFromConfig(readValue(snapshot.effective_config.root, ["ui", "language"])));
      appTheme = resolveTheme(appThemeFromConfig(readValue(snapshot.effective_config.root, ["ui", "theme"])));
      keybindings = readKeybindingMap(snapshot.effective_config.root, navigator.platform.toLowerCase().includes("mac"));
      integratedTitlebarSetting = true;
      integratedTitlebarSingleRowSetting = false;
      showHostIconsInTabs = false;
      defaultFilesViewMode = "tree";
      showHiddenFiles = true;
      filesDeleteBehavior = "direct";
      textPreviewLimitBytes = 1_048_576;
      imagePreviewLimitBytes = 10_485_760;
      filesToolbarActionIds = [...DEFAULT_FILES_TOOLBAR_ACTION_IDS];
      filesTreeStickyEnabled = true;
      filesTreeStickyMaxLevels = 3;
      settings = demoTerminalSettings();
      tabBarOrientation = settings.tab_bar_orientation;
      syncSettingsVariables(settings);
      return;
    }
    const snapshot = await unwrapCommand(commands.getConfigSnapshot());
    lastConfigSnapshot = snapshot;
    applyAppPreferences(snapshot.effective_config.root);
    setLanguage(appLanguageFromConfig(readValue(snapshot.effective_config.root, ["ui", "language"])));
    appTheme = resolveTheme(appThemeFromConfig(readValue(snapshot.effective_config.root, ["ui", "theme"])));
    keybindings = readKeybindingMap(snapshot.effective_config.root, navigator.platform.toLowerCase().includes("mac"));
    integratedTitlebarSetting = booleanValue(readValue(snapshot.effective_config.root, ["ui", "integrated_titlebar"])) ?? true;
    integratedTitlebarSingleRowSetting = isMacPlatform()
      ? false
      : (booleanValue(readValue(snapshot.effective_config.root, ["ui", "integrated_titlebar_single_row"])) ?? false);
    showHostIconsInTabs = booleanValue(readValue(snapshot.effective_config.root, ["workspace", "show_host_icons_in_tabs"])) ?? false;
    defaultFilesViewMode = filesViewModeFromConfig(readValue(snapshot.effective_config.root, ["files", "default_view_mode"]));
    showHiddenFiles = booleanValue(readValue(snapshot.effective_config.root, ["files", "show_hidden"])) ?? true;
    filesDeleteBehavior = filesDeleteBehaviorFromConfig(readValue(snapshot.effective_config.root, ["files", "delete_behavior"]));
    textPreviewLimitBytes = integerValue(readValue(snapshot.effective_config.root, ["files", "text_preview_limit_bytes"])) ?? 1_048_576;
    imagePreviewLimitBytes = integerValue(readValue(snapshot.effective_config.root, ["files", "image_preview_limit_bytes"])) ?? 10_485_760;
    filesToolbarActionIds = normalizeFilesToolbarActionIds(stringArrayValue(readValue(snapshot.effective_config.root, ["files", "toolbar_actions"])));
    filesTreeStickyEnabled = booleanValue(readValue(snapshot.effective_config.root, ["files", "tree_sticky_enabled"])) ?? true;
    filesTreeStickyMaxLevels = integerValue(readValue(snapshot.effective_config.root, ["files", "tree_sticky_max_levels"])) ?? 3;
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

  function filesViewModeFromConfig(value: Parameters<typeof stringValue>[0]): "tree" | "columns" {
    const mode = stringValue(value);
    return mode === "columns" ? "columns" : "tree";
  }

  function filesDeleteBehaviorFromConfig(value: Parameters<typeof stringValue>[0]): "direct" | "try_remote_trash" {
    const mode = stringValue(value);
    return mode === "try_remote_trash" ? "try_remote_trash" : "direct";
  }

  function demoTerminalSettings(): TerminalSettings {
    return {
      command: null,
      args: [],
      cwd: null,
      font_family: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      font_size: 13,
      scrollback: 10_000,
      renderer: "dom",
      cursor_blink: true,
      cursor_style: "block",
      theme: {
        background: "#111111",
        foreground: "#f1f1f1",
        cursor: "#f1f1f1",
        selection_background: "#4c6fff66",
        black: "#1c1c1c",
        red: "#d75f5f",
        green: "#87af5f",
        yellow: "#d7af5f",
        blue: "#5f87d7",
        magenta: "#af87d7",
        cyan: "#5fafaf",
        white: "#d0d0d0",
        bright_black: "#666666",
        bright_red: "#ff8787",
        bright_green: "#afd787",
        bright_yellow: "#ffd787",
        bright_blue: "#87afff",
        bright_magenta: "#d7afff",
        bright_cyan: "#87d7d7",
        bright_white: "#ffffff",
      },
      padding: {
        top: 8,
        right: 10,
        bottom: 8,
        left: 10,
      },
      tab_bar_orientation: "horizontal",
    };
  }

  function workspaceToolById(toolTabId: string): WorkspaceToolTab | null {
    return workspaceSnapshot?.tool_tabs.find((tool) => tool.id === toolTabId) ?? null;
  }

  function slotTool(slot: WorkspaceToolSlot): WorkspaceToolTab | null {
    if (slot.kind === "closed_source") return null;
    return workspaceToolById(slot.tool_tab_id);
  }

  function activeGroupSlot(layout: Extract<WorkspaceDockLayout, { kind: "group" }>): WorkspaceToolSlot | null {
    const activeSlotId = activeGroupSlotId(layout);
    return layout.slots.find((slot) => slot.id === activeSlotId) ?? layout.slots[0] ?? null;
  }

  function activeGroupSlotId(layout: Extract<WorkspaceDockLayout, { kind: "group" }>): string {
    activeToolSlotOverrideRevision;
    const override = activeToolSlotOverrideByGroupId[layout.id];
    return override && layout.slots.some((slot) => slot.id === override) ? override : layout.active_slot_id;
  }

  function isGroupSlotActive(layout: Extract<WorkspaceDockLayout, { kind: "group" }>, slotId: string): boolean {
    return slotId === activeGroupSlotId(layout);
  }

  function workspaceSlotToolTabId(slot: WorkspaceToolSlot): string | null {
    if (slot.kind === "closed_source") return null;
    return slot.tool_tab_id;
  }

  function dockGroupRole(group: Extract<WorkspaceDockLayout, { kind: "group" }>) {
    return group.role;
  }

  function rootDockGroupBounds(): DockGroupBounds {
    return { left: true, right: true, top: true, bottom: true };
  }

  function childDockGroupBounds(
    parent: DockGroupBounds,
    direction: "row" | "column",
    index: number,
    count: number,
  ): DockGroupBounds {
    const last = count - 1;
    return direction === "row"
      ? {
          left: parent.left && index === 0,
          right: parent.right && index === last,
          top: parent.top,
          bottom: parent.bottom,
        }
      : {
          left: parent.left,
          right: parent.right,
          top: parent.top && index === 0,
          bottom: parent.bottom && index === last,
        };
  }

  function toolTabbarPlacement(bounds: DockGroupBounds): ToolTabbarPlacement {
    if (bounds.bottom && !bounds.top) return "bottom";
    if (bounds.left && !bounds.right) return "left";
    if (bounds.right && !bounds.left) return "right";
    return "top";
  }

  function visualDockGroupRole(bounds: DockGroupBounds) {
    return toolTabbarPlacement(bounds) === "top" ? "content" : "side_panel";
  }

  function firstContentGroupId(workspace: WorkspaceTabState): string | null {
    return firstGroupIdByRole(workspace.layout, "content");
  }

  function firstToolGroupId(workspace: WorkspaceTabState): string | null {
    return (
      firstGroupIdByRole(workspace.layout, "side_panel") ??
      firstContentGroupId(workspace)
    );
  }

  function firstGroupIdByRole(layout: WorkspaceDockLayout, role: "content" | "side_panel"): string | null {
    if (layout.kind === "group") return dockGroupRole(layout) === role ? layout.id : null;
    return layout.children.map((child) => firstGroupIdByRole(child, role)).find((id): id is string => id !== null) ?? null;
  }

  function groupIdForSlot(layout: WorkspaceDockLayout, slotId: string): string | null {
    if (layout.kind === "group") {
      return layout.slots.some((slot) => slot.id === slotId) ? layout.id : null;
    }
    return layout.children.map((child) => groupIdForSlot(child, slotId)).find((id): id is string => id !== null) ?? null;
  }

  function activateWorkspaceLayoutSlot(layout: WorkspaceDockLayout, slotId: string): WorkspaceDockLayout {
    if (layout.kind === "group") {
      return layout.slots.some((slot) => slot.id === slotId) ? { ...layout, active_slot_id: slotId } : layout;
    }
    return { ...layout, children: layout.children.map((child) => activateWorkspaceLayoutSlot(child, slotId)) };
  }

  function replaceWorkspaceLayoutSnapshot(workspaceId: string, layout: WorkspaceDockLayout) {
    const current = workspaceSnapshot;
    if (!current) return;
    replaceWorkspaceSnapshot({
      ...current,
      workspaces: current.workspaces.map((item) => (item.id === workspaceId ? { ...item, layout } : item)),
    });
  }

  function terminalToolTabForSlot(slot: WorkspaceToolSlot | null): WorkspaceToolTab | null {
    if (!slot || slot.kind === "closed_source" || slot.kind === "floating_placeholder") return null;
    const tool = slotTool(slot);
    return tool?.kind === "terminal" ? tool : null;
  }

  function activeTerminalSlotForWorkspace(workspace: WorkspaceTabState): WorkspaceToolSlot | null {
    return activeTerminalSlot(workspace.layout);
  }

  function activeTerminalSlot(layout: WorkspaceDockLayout): WorkspaceToolSlot | null {
    if (layout.kind === "group") {
      const active = activeGroupSlot(layout);
      if (terminalToolTabForSlot(active)) return active;
      return layout.slots.find((slot) => terminalToolTabForSlot(slot) !== null) ?? null;
    }
    return layout.children.map(activeTerminalSlot).find((slot): slot is WorkspaceToolSlot => slot !== null) ?? null;
  }

  function terminalRuntimeForToolTab(toolTabId: string): TerminalToolRuntime | null {
    return terminalRuntimeByToolTabId.get(toolTabId) ?? null;
  }

  function setTerminalRuntime(toolTabId: string, runtime: TerminalToolRuntime) {
    const next = new Map(terminalRuntimeByToolTabId);
    next.set(toolTabId, runtime);
    terminalRuntimeByToolTabId = next;
    syncLegacyTerminalTabState();
  }

  function deleteTerminalRuntime(toolTabId: string) {
    const next = new Map(terminalRuntimeByToolTabId);
    next.delete(toolTabId);
    terminalRuntimeByToolTabId = next;
    syncLegacyTerminalTabState();
  }

  function syncLegacyTerminalTabState() {
    tabs = terminalRuntimeTabs();
    activeId = activeTerminalToolTabId;
  }

  function activeTerminalRuntime(): TerminalToolRuntime | null {
    if (!activeTerminalToolTabId) return null;
    return terminalRuntimeForToolTab(activeTerminalToolTabId);
  }

  function workspaceById(workspaceId: string): WorkspaceTabState | null {
    return workspaceSnapshot?.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  }

  function activeWorkspaceFromSnapshot(snapshot: WorkspaceLayoutSnapshot | null): WorkspaceTabState | null {
    if (!snapshot) return null;
    return snapshot.workspaces.find((workspace) => workspace.id === snapshot.active_workspace_id) ?? snapshot.workspaces[0] ?? null;
  }

  function slotToolTitle(slot: WorkspaceToolSlot) {
    if (slot.kind === "closed_source") return slot.previous_title;
    const tool = slotTool(slot);
    if (tool) return toolTabDisplayTitle(tool);
    return "Missing ToolTab";
  }

  function toolTabDisplayTitle(tool: WorkspaceToolTab) {
    if (tool.kind !== "terminal") return tool.title;
    return terminalRuntimeTitleForToolTab(tool.id) ?? tool.title;
  }

  function terminalRuntimeTitleForToolTab(toolTabId: string) {
    terminalTitleRevision;
    const runtime = terminalRuntimeForToolTab(toolTabId);
    const title = runtime?.tab.title.trim() ?? "";
    return title.length > 0 ? title : null;
  }

  function terminalSessionIdForToolTab(tool: WorkspaceToolTab | null): string | undefined {
    return tool?.kind === "terminal" ? terminalRuntimeForToolTab(tool.id)?.tab.activePaneId : undefined;
  }

  function ownerWorkspaceTitle(slot: WorkspaceToolSlot) {
    if (slot.kind === "closed_source") return slot.owner_workspace_title;
    if (slot.kind !== "mirror") return "";
    return workspaceById(slot.owner_workspace_id)?.title ?? "Closed workspace";
  }

  function splitStyle(layout: Extract<WorkspaceDockLayout, { kind: "split" }>) {
    return dockSplitGridTemplate(layout.direction, layout.children.length, layout.ratios);
  }

  function dockLayoutRenderKey(layout: WorkspaceDockLayout): string {
    if (layout.kind === "group") return `${layout.id}:${layout.active_slot_id}:${layout.slots.map((slot) => slot.id).join("|")}`;
    return `${layout.kind}:${layout.direction}:${layout.children.map(dockLayoutRenderKey).join("/")}`;
  }

  function dockLayoutStableRenderKey(layout: WorkspaceDockLayout): string {
    if (layout.kind === "group") return `group:${layout.id}`;
    return `split:${layout.direction}:${layout.children.map(dockLayoutStableRenderKey).join("/")}`;
  }

  function dockLayoutActiveSlotRenderKey(layout: WorkspaceDockLayout, activeSlotOverrides: Record<string, string>): string {
    if (layout.kind === "group") {
      const override = activeSlotOverrides[layout.id];
      const activeSlotId = override && layout.slots.some((slot) => slot.id === override) ? override : layout.active_slot_id;
      return `${layout.id}:${activeSlotId}`;
    }
    return layout.children.map((child) => dockLayoutActiveSlotRenderKey(child, activeSlotOverrides)).join("/");
  }

  async function activateWorkspaceSlot(workspace: WorkspaceTabState, slotId: string) {
    const slot = findWorkspaceSlot(workspace.layout, slotId);
    const groupId = groupIdForSlot(workspace.layout, slotId);
    const previousLayout = workspace.layout;
    if (slot && groupId) {
      const revisionBefore = activeToolSlotOverrideRevision;
      activeToolSlotOverrideByGroupId = { ...activeToolSlotOverrideByGroupId, [groupId]: slotId };
      activeToolSlotOverrideRevision += 1;
      if (typeof window !== "undefined") {
        Object.assign(window, {
          __NOCTURNE_LAST_TOOL_ACTIVATION__: {
            slotId,
            groupId,
            revisionBefore,
            revisionAfter: activeToolSlotOverrideRevision,
            override: activeToolSlotOverrideByGroupId[groupId],
          },
        });
      }
      replaceWorkspaceLayoutSnapshot(workspace.id, activateWorkspaceLayoutSlot(workspace.layout, slotId));
      const tool = terminalToolTabForSlot(slot);
      const group = findWorkspaceGroup(workspace.layout, groupId);
      if (group && dockGroupRole(group) === "content") {
        lastActivatedContentGroupIdByWorkspace.set(workspace.id, groupId);
      }
      if (tool) activeTerminalToolTabId = tool.id;
    }
    try {
      const next = await dispatchWorkspaceIntent({
        kind: "activate_tool_slot",
        workspace_id: workspace.id,
        slot_id: slotId,
      });
      replaceWorkspaceSnapshot(next);
    } catch (error) {
      if (groupId) {
        const previousGroup = findWorkspaceGroup(previousLayout, groupId);
        if (previousGroup) {
          activeToolSlotOverrideByGroupId = {
            ...activeToolSlotOverrideByGroupId,
            [groupId]: previousGroup.active_slot_id,
          };
          activeToolSlotOverrideRevision += 1;
        }
      }
      replaceWorkspaceLayoutSnapshot(workspace.id, previousLayout);
      settingsError = error instanceof Error ? error.message : String(error);
    }
  }

  async function closeWorkspaceSlot(workspaceId: string, slotId: string) {
    const workspace = workspaceById(workspaceId);
    const slot = workspace ? findWorkspaceSlot(workspace.layout, slotId) : null;
    const tool = slot ? terminalToolTabForSlot(slot) : null;
    if (slot?.kind === "owned" && tool) {
      const confirmed = await confirmTerminalToolRuntimeClose(tool.id);
      if (!confirmed) return;
    }
    const next = await dispatchWorkspaceIntent({ kind: "close_tool_slot", workspace_id: workspaceId, slot_id: slotId });
    if (slot?.kind === "owned" && tool) {
      await disposeTerminalToolRuntime(tool.id);
      await mountActiveTerminalForWorkspace(workspaceId, next);
    }
  }

  async function confirmTerminalToolRuntimeClose(toolTabId: string) {
    const runtime = terminalRuntimeForToolTab(toolTabId);
    if (!runtime) return true;
    const pane = terminalPaneById(runtime.tab, runtime.tab.activePaneId);
    if (!pane) return true;
    if (pane.status === "running" && shouldConfirmTerminalClose()) {
      const confirmed = await ask(`Close terminal session ${pane.title}?`, {
        title: "Close Terminal",
        kind: "warning",
        okLabel: "Close",
        cancelLabel: "Cancel",
      });
      if (!confirmed) return false;
    }
    return true;
  }

  async function disposeTerminalToolRuntime(toolTabId: string) {
    const runtime = terminalRuntimeForToolTab(toolTabId);
    if (!runtime) return;
    const pane = terminalPaneById(runtime.tab, runtime.tab.activePaneId);
    if (!pane) return;
    const shouldCloseSession = pane.status === "running";
    disposeTerminalTab(runtime.tab);
    if (activeTerminalToolTabId === toolTabId) activeTerminalToolTabId = "";
    deleteTerminalRuntime(toolTabId);
    if (shouldCloseSession) await closePaneSession(pane);
  }

  async function closeOtherWorkspaceSlots(workspaceId: string, slotId: string) {
    const toolIds = terminalToolTabIdsClosedByOtherSlots(workspaceId, slotId);
    for (const toolTabId of toolIds) {
      const confirmed = await confirmTerminalToolRuntimeClose(toolTabId);
      if (!confirmed) return;
    }
    const next = await dispatchWorkspaceIntent({ kind: "close_other_tool_slots", workspace_id: workspaceId, slot_id: slotId });
    for (const toolTabId of toolIds) await disposeTerminalToolRuntime(toolTabId);
    await mountActiveTerminalForWorkspace(workspaceId, next);
  }

  async function closeWorkspaceSlotsToRight(workspaceId: string, slotId: string) {
    const toolIds = terminalToolTabIdsClosedToRight(workspaceId, slotId);
    for (const toolTabId of toolIds) {
      const confirmed = await confirmTerminalToolRuntimeClose(toolTabId);
      if (!confirmed) return;
    }
    const next = await dispatchWorkspaceIntent({ kind: "close_tool_slots_to_right", workspace_id: workspaceId, slot_id: slotId });
    for (const toolTabId of toolIds) await disposeTerminalToolRuntime(toolTabId);
    await mountActiveTerminalForWorkspace(workspaceId, next);
  }

  async function mountActiveTerminalForWorkspace(workspaceId: string, snapshot: WorkspaceLayoutSnapshot | null = workspaceSnapshot) {
    const workspace = snapshot?.workspaces.find((item) => item.id === workspaceId) ?? null;
    if (!workspace) return;
    const toolById = (toolTabId: string) => snapshot?.tool_tabs.find((item) => item.id === toolTabId) ?? null;
    const terminalSlot = activeTerminalSlotForWorkspaceSnapshot(workspace, toolById);
    const tool = terminalSlot && terminalSlot.kind !== "closed_source" && terminalSlot.kind !== "floating_placeholder"
      ? toolById(terminalSlot.tool_tab_id)
      : null;
    if (tool?.kind !== "terminal") return;
    if (!terminalRuntimeForToolTab(tool.id)) return;
    activeTerminalToolTabId = tool.id;
    syncLegacyTerminalTabState();
    await tick();
    await mountTerminalToolTab(tool.id);
  }

  function activeTerminalSlotForWorkspaceSnapshot(
    workspace: WorkspaceTabState,
    toolById: (toolTabId: string) => WorkspaceToolTab | null,
  ): WorkspaceToolSlot | null {
    return activeTerminalSlotFromSnapshot(workspace.layout, toolById);
  }

  function activeTerminalSlotFromSnapshot(
    layout: WorkspaceDockLayout,
    toolById: (toolTabId: string) => WorkspaceToolTab | null,
  ): WorkspaceToolSlot | null {
    if (layout.kind === "group") {
      const active = activeGroupSlot(layout);
      if (slotIsTerminalForSnapshot(active, toolById)) return active;
      return layout.slots.find((slot) => slotIsTerminalForSnapshot(slot, toolById)) ?? null;
    }
    return layout.children
      .map((child) => activeTerminalSlotFromSnapshot(child, toolById))
      .find((slot): slot is WorkspaceToolSlot => slot !== null) ?? null;
  }

  function slotIsTerminalForSnapshot(
    slot: WorkspaceToolSlot | null,
    toolById: (toolTabId: string) => WorkspaceToolTab | null,
  ) {
    if (!slot || slot.kind === "closed_source" || slot.kind === "floating_placeholder") return false;
    return toolById(slot.tool_tab_id)?.kind === "terminal";
  }

  function terminalToolTabIdsClosedByOtherSlots(workspaceId: string, slotId: string) {
    const workspace = workspaceById(workspaceId);
    if (!workspace) return [];
    return listWorkspaceSlots(workspace.layout)
      .filter((slot) => slot.id !== slotId && slot.kind === "owned")
      .map((slot) => terminalToolTabForSlot(slot)?.id ?? "")
      .filter((id) => id.length > 0);
  }

  function terminalToolTabIdsClosedToRight(workspaceId: string, slotId: string) {
    const workspace = workspaceById(workspaceId);
    if (!workspace) return [];
    const group = findWorkspaceGroupContainingSlot(workspace.layout, slotId);
    if (!group) return [];
    const index = group.slots.findIndex((slot) => slot.id === slotId);
    if (index < 0) return [];
    return group.slots
      .slice(index + 1)
      .filter((slot) => slot.kind === "owned")
      .map((slot) => terminalToolTabForSlot(slot)?.id ?? "")
      .filter((id) => id.length > 0);
  }

  async function mirrorToolTabToWorkspace(toolTabId: string, targetWorkspaceId: string, targetGroupId: string) {
    await dispatchWorkspaceIntent({
      kind: "mirror_tool_tab",
      source_tool_tab_id: toolTabId,
      target_workspace_id: targetWorkspaceId,
      target_group_id: targetGroupId,
    });
  }

  async function floatWorkspaceSlot(workspaceId: string, slotId: string) {
    const before = workspaceSnapshot?.floating_windows.map((window) => window.id) ?? [];
    await dispatchWorkspaceIntent({ kind: "float_tool_slot", workspace_id: workspaceId, slot_id: slotId });
    const after = workspaceSnapshot?.floating_windows ?? [];
    const created = after.find((window) => !before.includes(window.id));
    if (created && hasTauriRuntime()) {
      void openFloatingWindow(created.id).catch((error) => {
        settingsError = error instanceof Error ? error.message : String(error);
      });
    }
  }

  function openFloatingWindow(floatingWindowId: string) {
    const label = `workspace-floating-${floatingWindowId}`;
    const window = new WebviewWindow(label, {
      url: "/",
      title: "Nocturne",
      width: 760,
      height: 520,
      minWidth: 420,
      minHeight: 320,
      resizable: true,
      center: true,
      focus: true,
      visible: true,
    });
    return new Promise<void>((resolve, reject) => {
      window.once("tauri://created", () => resolve());
      window.once("tauri://error", (event) => {
        reject(new Error(String(event.payload)));
      });
    });
  }

  function openToolTabContextMenu(
    event: MouseEvent,
    workspace: WorkspaceTabState,
    group: Extract<WorkspaceDockLayout, { kind: "group" }>,
    slot: WorkspaceToolSlot,
  ) {
    event.preventDefault();
    event.stopPropagation();
    const tool = slotTool(slot);
    toolTabContextMenu = {
      workspaceId: workspace.id,
      slotId: slot.id,
      toolTabId: tool?.id ?? null,
      groupId: group.id,
      left: event.clientX,
      top: event.clientY,
    };
  }

  function closeToolTabContextMenu() {
    toolTabContextMenu = null;
  }

  function otherMirrorTargets(menu: ToolTabContextMenu) {
    const sourceTool = menu.toolTabId ? workspaceToolById(menu.toolTabId) : null;
    if (!sourceTool) return [];
    return (workspaceSnapshot?.workspaces ?? [])
      .filter((workspace) => workspace.id !== sourceTool.owner_workspace_id)
      .map((workspace) => ({ workspace, groupId: firstDockGroupId(workspace.layout) }))
      .filter((item): item is { workspace: WorkspaceTabState; groupId: string } => item.groupId !== null);
  }

  function firstDockGroupId(layout: WorkspaceDockLayout): string | null {
    if (layout.kind === "group") return layout.id;
    return layout.children.map(firstDockGroupId).find((id): id is string => id !== null) ?? null;
  }

  function findWorkspaceSlot(layout: WorkspaceDockLayout, slotId: string): WorkspaceToolSlot | null {
    if (layout.kind === "group") return layout.slots.find((slot) => slot.id === slotId) ?? null;
    return layout.children.map((child) => findWorkspaceSlot(child, slotId)).find((slot): slot is WorkspaceToolSlot => slot !== null) ?? null;
  }

  function findWorkspaceGroup(
    layout: WorkspaceDockLayout,
    groupId: string,
  ): Extract<WorkspaceDockLayout, { kind: "group" }> | null {
    if (layout.kind === "group") return layout.id === groupId ? layout : null;
    return layout.children.map((child) => findWorkspaceGroup(child, groupId)).find((group): group is Extract<WorkspaceDockLayout, { kind: "group" }> => group !== null) ?? null;
  }

  function findWorkspaceGroupContainingSlot(
    layout: WorkspaceDockLayout,
    slotId: string,
  ): Extract<WorkspaceDockLayout, { kind: "group" }> | null {
    if (layout.kind === "group") return layout.slots.some((slot) => slot.id === slotId) ? layout : null;
    return layout.children
      .map((child) => findWorkspaceGroupContainingSlot(child, slotId))
      .find((group): group is Extract<WorkspaceDockLayout, { kind: "group" }> => group !== null) ?? null;
  }

  function listWorkspaceSlots(layout: WorkspaceDockLayout): WorkspaceToolSlot[] {
    if (layout.kind === "group") return [...layout.slots];
    return layout.children.flatMap(listWorkspaceSlots);
  }

  async function moveWorkspaceSlotToGroup(workspaceId: string, slotId: string, targetGroupId: string) {
    await dispatchWorkspaceIntent({
      kind: "move_tool_slot_to_group",
      workspace_id: workspaceId,
      slot_id: slotId,
      target_group_id: targetGroupId,
    });
  }

  async function moveWorkspaceSlotToSplit(
    workspaceId: string,
    slotId: string,
    targetSlotId: string,
    side: "left" | "right" | "up" | "down",
  ) {
    await dispatchWorkspaceIntent({
      kind: "move_tool_slot_to_split",
      workspace_id: workspaceId,
      slot_id: slotId,
      target_slot_id: targetSlotId,
      side,
    });
  }

  function terminalRenderMode(workspace: WorkspaceTabState | null, effectiveWorkspace: WorkspaceTabState): TerminalRenderMode | null {
    return {
      workspace: effectiveWorkspace,
    };
  }

  function currentWindowLabel() {
    return hasTauriRuntime() ? getCurrentWindow().label : "main";
  }

  function currentFloatingWindowId() {
    const queryValue = new URL(window.location.href).searchParams.get("floating_window");
    if (queryValue) return queryValue;
    if (!hasTauriRuntime()) return null;
    const label = getCurrentWindow().label;
    return label.startsWith("workspace-floating-") ? label.slice("workspace-floating-".length) : null;
  }

  function isMacPlatform() {
    return navigator.platform.toLowerCase().includes("mac");
  }

  function isDesktopPlatform() {
    return !/android|iphone|ipad|ipod/i.test(navigator.userAgent);
  }

  function hostIconMap(snapshot: AppConfigSnapshot | null): Map<string, ConnectionHostIcon> {
    return new Map((snapshot?.hosts ?? []).map((host) => [host.id, resolveHostIcon(host)]));
  }

  function connectionHostForToolTab(tool: WorkspaceToolTab) {
    return lastConfigSnapshot?.hosts.find((host) => host.id === tool.host_id) ?? null;
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
      toolTabId = "",
      workspaceId = "",
      trust = {},
    }: {
      cwd?: string | null;
      recordHistory?: boolean;
      toolTabId?: string;
      workspaceId?: string;
      trust?: {
        acceptNewHostKey?: boolean;
        updateChangedHostKey?: boolean;
        credential?: { kind: SshCredentialKind; value: string };
        saveCredential?: boolean;
      };
    } = {},
  ) {
    if (!workspaceId) throw new Error("Terminal session requires a workspace id");
    if (!toolTabId) throw new Error("Terminal session requires a ToolTab id");
    let info: TerminalSessionInfo;
    try {
      if (!settings) await loadSettings();
      await tick();
      const measured = measureNewTerminal(cwd);
      info = await unwrapCommand(
        commands.createHostTerminalSession({
          ...measured,
          workspace_id: workspaceId,
          tool_tab_id: toolTabId,
          accept_new_host_key: trust.acceptNewHostKey === true,
          update_changed_host_key: trust.updateChangedHostKey === true,
          credential: trust.credential ?? null,
          save_credential: trust.saveCredential === true,
        }),
      );
    } catch (error) {
      await handleHostSessionError(connectionHostId, workspaceId, toolTabId, error, trust);
      return;
    }

    const tab = createTerminalTab(info);
    if (toolTabId) {
      tab.id = toolTabId;
      for (const pane of tab.panes) pane.tabId = toolTabId;
    }
    const pane = terminalPaneById(tab, tab.activePaneId);
    if (!pane) throw new Error(`active pane ${tab.activePaneId} not found in created tab`);
    pane.connectionHostId = connectionHostId;
    pane.reconnectTrust = {
      acceptNewHostKey: trust.acceptNewHostKey,
      updateChangedHostKey: trust.updateChangedHostKey,
    };
    if (toolTabId) {
      setTerminalRuntime(toolTabId, { toolTabId, tab });
      activeTerminalToolTabId = toolTabId;
    } else {
      tabs = [...tabs, tab];
    }
    activeId = tab.id;
    hostSessionRetryByPaneId = {
      ...hostSessionRetryByPaneId,
      [tab.activePaneId]: {
        connectionHostId,
        workspaceId,
        toolTabId,
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
      if (recordHistory && !toolTabId) {
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
    const toolTabId = pane.tabId || tab.id;
    const tool = workspaceToolById(toolTabId);
    if (!tool) throw new Error(`terminal ToolTab ${toolTabId} not found`);
    const workspaceId = tool.owner_workspace_id;
    if (!settings) await loadSettings();
    await tick();
    const info = await unwrapCommand(
      commands.createHostTerminalSession({
        ...measureNewTerminal(pane.currentDirectory.trim() || null),
        workspace_id: workspaceId,
        tool_tab_id: toolTabId,
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
        workspaceId,
        toolTabId,
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

  async function openWorkspaceTerminalSession({ recordHistory = true }: { recordHistory?: boolean } = {}) {
    if (!hasTauriRuntime()) return;
    const workspace = activeWorkspace;
    if (!workspace) throw new Error("active workspace is not loaded");
    const before = new Set(
      (workspaceSnapshot?.tool_tabs ?? [])
        .filter((tool) => tool.owner_workspace_id === workspace.id && tool.kind === "terminal")
        .map((tool) => tool.id),
    );
    const targetGroupId =
      lastActivatedContentGroupIdByWorkspace.get(workspace.id) ?? firstContentGroupId(workspace);
    const next = await dispatchWorkspaceIntent({
      kind: "create_terminal_tool_tab",
      workspace_id: workspace.id,
      target_group_id: targetGroupId,
    });
    const tool = next.tool_tabs.find(
      (item) =>
        item.owner_workspace_id === workspace.id &&
        item.kind === "terminal" &&
        !before.has(item.id),
    );
    if (!tool) throw new Error("created Terminal ToolTab was not found in workspace snapshot");
    activeTerminalToolTabId = tool.id;
    await createHostSession(tool.host_id, { recordHistory, toolTabId: tool.id, workspaceId: workspace.id });
  }

  async function openWorkspaceResourceMonitor() {
    const workspace = activeWorkspace;
    if (!workspace) throw new Error("active workspace is not loaded");
    await dispatchWorkspaceIntent({
      kind: "open_resource_monitor_tool_tab",
      workspace_id: workspace.id,
      target_group_id: firstToolGroupId(workspace),
    });
  }

  async function openDefaultWorkspace() {
    const defaultHostId = lastConfigSnapshot?.root.default_host ?? "";
    await createWorkspaceForHost(defaultHostId);
  }

  async function createWorkspaceForHost(hostId: string) {
    await dispatchWorkspaceIntent({ kind: "create_workspace", host_id: hostId });
  }

  async function activateWorkspace(id: string) {
    const current = workspaceSnapshot;
    if (!current || current.active_workspace_id === id) return;
    await dispatchWorkspaceIntent({ kind: "activate_workspace", workspace_id: id });
    await restoreTerminalRuntimeForWorkspace(id);
  }

  async function closeWorkspace(id: string) {
    const canClose = await confirmWorkspaceTransferClose(id);
    if (!canClose) return;
    const canClosePorts = await confirmWorkspacePortForwardClose(id);
    if (!canClosePorts) return;
    await dispatchWorkspaceIntent({ kind: "close_workspace", workspace_id: id });
    await disposeTerminalRuntimesForWorkspace(id);
    const nextWorkspaceId = workspaceSnapshot?.active_workspace_id;
    if (nextWorkspaceId) await restoreTerminalRuntimeForWorkspace(nextWorkspaceId);
  }

  async function closeOtherWorkspaces(id: string) {
    const ids = workspaceSnapshot?.workspaces.map((workspace) => workspace.id).filter((workspaceId) => workspaceId !== id) ?? [];
    const confirmedPortHosts = new Set<string>();
    for (const workspaceId of ids) {
      const canClose = await confirmWorkspaceTransferClose(workspaceId);
      if (!canClose) return;
      const canClosePorts = await confirmWorkspacePortForwardClose(workspaceId, ids, confirmedPortHosts);
      if (!canClosePorts) return;
    }
    await dispatchWorkspaceIntent({ kind: "close_other_workspaces", workspace_id: id });
    for (const workspaceId of ids) {
      await disposeTerminalRuntimesForWorkspace(workspaceId);
    }
    await restoreTerminalRuntimeForWorkspace(id);
  }

  async function closeWorkspacesToRight(id: string) {
    const workspaces = workspaceSnapshot?.workspaces ?? [];
    const index = workspaces.findIndex((workspace) => workspace.id === id);
    if (index < 0) return;
    const ids = workspaces.slice(index + 1).map((workspace) => workspace.id);
    const confirmedPortHosts = new Set<string>();
    for (const workspaceId of ids) {
      const canClose = await confirmWorkspaceTransferClose(workspaceId);
      if (!canClose) return;
      const canClosePorts = await confirmWorkspacePortForwardClose(workspaceId, ids, confirmedPortHosts);
      if (!canClosePorts) return;
    }
    await dispatchWorkspaceIntent({ kind: "close_workspaces_to_right", workspace_id: id });
    for (const workspaceId of ids) {
      await disposeTerminalRuntimesForWorkspace(workspaceId);
    }
    const nextWorkspaceId = workspaceSnapshot?.active_workspace_id;
    if (nextWorkspaceId) await restoreTerminalRuntimeForWorkspace(nextWorkspaceId);
  }

  async function confirmWorkspaceTransferClose(workspaceId: string) {
    if (!hasTauriRuntime()) return true;
    const queue = await unwrapCommand(commands.getTransferQueueSnapshot());
    const related = queue.tasks.filter(
      (task) =>
        (task.status === "queued" || task.status === "running") &&
        (task.initiator_workspace_id === workspaceId || task.related_workspace_ids.includes(workspaceId)),
    );
    if (related.length === 0) return true;
    const confirmed = await ask(
      related.length === 1
        ? "Close this workspace and cancel 1 related transfer?"
        : `Close this workspace and cancel ${related.length} related transfers?`,
      {
        title: "Close Workspace",
        kind: "warning",
      },
    );
    if (!confirmed) return false;
    for (const task of related) {
      await unwrapCommand(commands.cancelTransferTask({ task_id: task.id }));
    }
    return true;
  }

  async function confirmWorkspacePortForwardClose(
    workspaceId: string,
    closingWorkspaceIds: string[] = [workspaceId],
    confirmedHostIds = new Set<string>(),
  ) {
    if (!hasTauriRuntime()) return true;
    const snapshot = workspaceSnapshot;
    const workspace = snapshot?.workspaces.find((item) => item.id === workspaceId);
    if (!snapshot || !workspace) return true;
    if (confirmedHostIds.has(workspace.host_id)) return true;
    const remainingSameHost = snapshot.workspaces.some(
      (item) => item.host_id === workspace.host_id && !closingWorkspaceIds.includes(item.id),
    );
    if (remainingSameHost) return true;
    const ports = await unwrapCommand(commands.getPortForwardSnapshot(workspace.host_id));
    const active = ports.rules.filter((item) =>
      item.runtime.status === "starting" ||
      item.runtime.status === "running" ||
      item.runtime.status === "reconnecting",
    );
    if (active.length === 0) return true;
    const confirmed = await ask(
      active.length === 1
        ? "Close this workspace and stop 1 active port forward?"
        : `Close this workspace and stop ${active.length} active port forwards?`,
      {
        title: "Close Workspace",
        kind: "warning",
      },
    );
    if (confirmed) confirmedHostIds.add(workspace.host_id);
    return confirmed;
  }

  async function confirmAutoOpenPortForwardRisks(snapshot: WorkspaceLayoutSnapshot | null = workspaceSnapshot) {
    if (!snapshot || floatingWindowId || !hasTauriRuntime()) return;
    const hostIds = Array.from(new Set(snapshot.workspaces.map((workspace) => workspace.host_id)));
    for (const hostId of hostIds) {
      const ports = await unwrapCommand(commands.getPortForwardSnapshot(hostId));
      for (const row of ports.rules) {
        if (row.runtime.status !== "needs_confirmation" || row.runtime.persistence !== "saved" || !row.rule.connect_on_host_open) continue;
        const key = [
          hostId,
          row.rule.id,
          row.rule.direction,
          row.rule.local_address,
          row.rule.local_port,
          row.rule.remote_address,
          row.rule.remote_port,
        ].join("|");
        if (confirmedAutoOpenPortRules.has(key)) continue;
        confirmedAutoOpenPortRules.add(key);
        const risk = await unwrapCommand(commands.checkPortForwardNonLoopbackRisk({ rule: row.rule }));
        if (!risk.requires_confirmation) continue;
        const confirmed = await ask(`Listen on ${risk.listen_address}? This saved port forward starts when the Host opens and can expose the forwarded port beyond loopback.\n\n${risk.reasons.join("\n")}`, {
          title: "Confirm Port Listen Address",
          kind: "warning",
        });
        if (!confirmed) continue;
        await unwrapCommand(commands.createOrUpdatePortForwardRule({
          host_id: hostId,
          persistence: row.runtime.persistence,
          rule: addNonLoopbackConfirmation(row.rule, String(Date.now())),
        }));
        await unwrapCommand(commands.startPortForwardRule({
          host_id: hostId,
          rule_id: row.rule.id,
        }));
      }
    }
  }

  async function newSession({ recordHistory = true }: { recordHistory?: boolean } = {}) {
    await openWorkspaceTerminalSession({ recordHistory });
  }

  async function newWorkspace() {
    await openDefaultWorkspace();
  }

  async function handleNewWorkspaceSecondaryClick(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    openHostPicker(event);
  }

  async function ensureStartupSession(restored: boolean) {
    if (restored || activeWorkspaceTerminalRuntimesReady()) return;
    if (startupSessionPromise) {
      await startupSessionPromise;
      return;
    }
    startupSessionPromise = ensureWorkspaceTerminalRuntimes().finally(() => {
      startupSessionPromise = null;
    });
    await startupSessionPromise;
  }

  function activeWorkspaceTerminalRuntimesReady() {
    const workspace = activeWorkspace;
    if (!workspace) return false;
    const terminalTools = (workspaceSnapshot?.tool_tabs ?? []).filter(
      (tool) =>
        tool.owner_workspace_id === workspace.id &&
        tool.kind === "terminal" &&
        workspace.owned_tool_tab_ids.includes(tool.id),
    );
    return terminalTools.length > 0 && terminalTools.every((tool) => terminalRuntimeByToolTabId.has(tool.id));
  }

  async function ensureWorkspaceTerminalRuntimes() {
    const workspace = activeWorkspace;
    if (!workspace) return;
    const terminalTools = (workspaceSnapshot?.tool_tabs ?? []).filter(
      (tool) =>
        tool.owner_workspace_id === workspace.id &&
        tool.kind === "terminal" &&
        workspace.owned_tool_tab_ids.includes(tool.id),
    );
    for (const tool of terminalTools) {
      await terminalRuntimeCreationGate.ensure(
        tool.id,
        () => terminalRuntimeByToolTabId.has(tool.id),
        async () => {
          activeTerminalToolTabId = tool.id;
          await createHostSession(tool.host_id, { recordHistory: false, toolTabId: tool.id, workspaceId: workspace.id });
        },
      );
    }
    if (!activeTerminalToolTabId && terminalTools[0]) activeTerminalToolTabId = terminalTools[0].id;
  }

  async function disposeTerminalRuntimesForWorkspace(workspaceId: string) {
    const toolTabIds = Array.from(terminalRuntimeByToolTabId.values())
      .filter((runtime) => workspaceToolById(runtime.toolTabId)?.owner_workspace_id === workspaceId)
      .map((runtime) => runtime.toolTabId);
    for (const toolTabId of toolTabIds) {
      await disposeTerminalToolRuntime(toolTabId);
    }
  }

  async function restoreTerminalRuntimeForWorkspace(workspaceId: string) {
    if (activeTerminalWorkspaceId === workspaceId) return;
    activeTerminalWorkspaceId = workspaceId;
    const workspace = workspaceById(workspaceId);
    const terminalSlot = workspace ? activeTerminalSlotForWorkspace(workspace) : null;
    const tool = terminalToolTabForSlot(terminalSlot);
    if (tool) {
      activeTerminalToolTabId = tool.id;
      syncLegacyTerminalTabState();
    }
    await tick();
    await ensureWorkspaceTerminalRuntimes();
    if (activeTerminalToolTabId) await mountTerminalToolTab(activeTerminalToolTabId);
    syncTerminalMenuState();
  }

  async function flushTerminalOutputBacklog(paneId: string) {
    if (!hasTauriRuntime()) return;
    if (!hasLocalTerminalPane(paneId)) return;
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
    if (
      !routeTerminalPaneEvent(event.session_id, localTerminalPaneIds(), () => {
        terminalTabs.enqueueOutput(event);
      })
    ) {
      return;
    }
    if (event.session_id !== activePane()?.id || !findVisible) return;
    window.requestAnimationFrame(() => {
      updateFindSnapshot();
      syncTerminalMenuState();
    });
  }

  function activePane(): TerminalPane | null {
    const runtime = activeTerminalRuntime();
    const tab = runtime?.tab ?? activeTab;
    if (!tab) return null;
    return terminalPaneById(tab, tab.activePaneId) ?? null;
  }

  function shouldConfirmTerminalClose() {
    if (!lastConfigSnapshot) return true;
    return booleanValue(readValue(lastConfigSnapshot.effective_config.root, ["terminal", "confirm_close"])) ?? true;
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

  function findLocalTabByPaneId(paneId: string): TerminalTab | null {
    return (
      terminalRuntimeTabs().find((item) => item.panes.some((pane) => pane.id === paneId)) ??
      tabs.find((item) => item.panes.some((pane) => pane.id === paneId)) ??
      null
    );
  }

  function findTabByPaneId(paneId: string): TerminalTab {
    const tab = findLocalTabByPaneId(paneId);
    if (!tab) throw new Error(`tab for pane ${paneId} not found`);
    return tab;
  }

  function localTerminalPaneIds() {
    return terminalRuntimeTabs().flatMap((tab) => tab.panes.map((pane) => pane.id));
  }

  function hasLocalTerminalPane(paneId: string) {
    return shouldHandleTerminalPaneEvent(paneId, localTerminalPaneIds());
  }

  async function splitActivePane(side: SplitSide, { recordHistory = true }: { recordHistory?: boolean } = {}) {
    await openWorkspaceTerminalSession({ recordHistory });
  }

  async function splitPaneById(paneId: string, side: SplitSide, { recordHistory = true }: { recordHistory?: boolean } = {}) {
    await openWorkspaceTerminalSession({ recordHistory });
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
    if (!shouldConfirmTerminalClose()) return true;
    if (!hasTauriRuntime()) return window.confirm("Close running terminal session?");
    return ask(runningCount === 1 ? "Close running terminal session?" : `Close ${runningCount} running terminal sessions?`, {
      title: "Close Terminal",
      kind: "warning",
      okLabel: "Close",
      cancelLabel: "Cancel",
    });
  }

  async function closePaneSession(pane: TerminalPane) {
    try {
      await unwrapCommand(commands.closeTerminalSession(pane.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isTerminalSessionInactiveMessage(message) || message.includes("The operation completed successfully") || message.includes("os error 0")) {
        return;
      }
      terminalTabs.markConnectionError(pane.id, message);
    }
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
    await openWorkspaceTerminalSession({ recordHistory: false });
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

  function startDockResize(
    event: PointerEvent,
    owner: { workspaceId: string | null; floatingWindowId: string | null },
    layout: Extract<WorkspaceDockLayout, { kind: "split" }>,
    splitPath: number[],
    dividerIndex: number,
  ) {
    if (event.button !== 0) return;
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const split = target.parentElement;
    if (!split) return;
    const rect = split.getBoundingClientRect();
    dockResizeDrag = {
      ...owner,
      baseLayout: owner.workspaceId
        ? (workspaceById(owner.workspaceId)?.layout ?? layout)
        : (workspaceSnapshot?.floating_windows.find((window) => window.id === owner.floatingWindowId)?.layout ?? layout),
      splitPath,
      dividerIndex,
      direction: layout.direction,
      startClient: layout.direction === "row" ? event.clientX : event.clientY,
      containerPixels: layout.direction === "row" ? rect.width : rect.height,
      pointerId: event.pointerId,
    };
    target.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }

  function updateDockResize(event: PointerEvent) {
    const drag = dockResizeDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const currentClient = drag.direction === "row" ? event.clientX : event.clientY;
    const nextLayout = resizeWorkspaceDockSplit({
      layout: drag.baseLayout,
      splitPath: drag.splitPath,
      dividerIndex: drag.dividerIndex,
      deltaPixels: currentClient - drag.startClient,
      containerPixels: drag.containerPixels,
      minChildPixels: drag.direction === "row" ? 160 : 96,
    });
    replaceDockOwnerLayout(drag.workspaceId, drag.floatingWindowId, nextLayout);
  }

  function replaceDockOwnerLayout(workspaceId: string | null, floatingWindowId: string | null, layout: WorkspaceDockLayout) {
    const current = workspaceSnapshot;
    if (!current) return;
    replaceWorkspaceSnapshot({
      ...current,
      workspaces: workspaceId
        ? current.workspaces.map((workspace) => (workspace.id === workspaceId ? { ...workspace, layout } : workspace))
        : current.workspaces,
      floating_windows: floatingWindowId
        ? current.floating_windows.map((window) => (window.id === floatingWindowId ? { ...window, layout } : window))
        : current.floating_windows,
    });
  }

  async function moveWorkspaceSlotToEdge(
    workspaceId: string,
    slotId: string,
    side: "left" | "right" | "up" | "down",
  ) {
    await dispatchWorkspaceIntent({
      kind: "move_tool_slot_to_workspace_edge",
      workspace_id: workspaceId,
      slot_id: slotId,
      side,
    });
  }

  function handlePointerMove(event: PointerEvent) {
    if (dockResizeDrag) {
      updateDockResize(event);
      return;
    }
    if (toolTabPointerDrag) {
      updateToolTabPointerDrag(event);
      return;
    }
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
    if (dockResizeDrag) {
      dockResizeDrag = null;
      return;
    }
    if (toolTabPointerDrag) {
      void finishToolTabPointerDrag(event);
      return;
    }
    const wasResizing = resizeDrag !== null;
    resizeDrag = null;
    if (wasResizing) return;
    void finishPointerDrag(event);
  }

  function handlePointerCancel(event: PointerEvent) {
    if (dockResizeDrag?.pointerId === event.pointerId) dockResizeDrag = null;
    if (toolTabPointerDrag?.pointerId === event.pointerId) cancelToolTabDragInteraction();
    if (resizeDrag) resizeDrag = null;
    if (pointerDrag?.pointerId === event.pointerId) cancelDragInteraction();
  }

  function startPanePointerDrag(event: PointerEvent, paneId: string) {
    startPointerDrag(event, "pane", paneId);
  }

  function startTabPointerDrag(event: PointerEvent, tabId: string) {
    startPointerDrag(event, "tab", tabId);
  }

  function startToolTabPointerDrag(event: PointerEvent, workspace: WorkspaceTabState, slot: WorkspaceToolSlot) {
    if (event.button !== 0) return;
    if (slot.kind === "closed_source" || slot.kind === "floating_placeholder") return;
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    toolTabPointerDrag = {
      workspaceId: workspace.id,
      slotId: slot.id,
      toolTabId: slot.tool_tab_id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      target,
    };
    target.setPointerCapture(event.pointerId);
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

  function cancelToolTabDragInteraction() {
    toolTabPointerDrag = null;
    toolTabDragState = null;
    toolTabDropTarget = null;
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

  function updateToolTabPointerDrag(event: PointerEvent) {
    const drag = toolTabPointerDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active) {
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (distance < 6) return;
      drag.active = true;
      toolTabDragState = {
        workspaceId: drag.workspaceId,
        slotId: drag.slotId,
        toolTabId: drag.toolTabId,
        active: true,
      };
      if (!drag.target.hasPointerCapture(drag.pointerId)) {
        drag.target.setPointerCapture(drag.pointerId);
      }
    }
    toolTabDropTarget = toolTabDropTargetFromPoint(event.clientX, event.clientY, drag);
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

  async function finishToolTabPointerDrag(event: PointerEvent) {
    const drag = toolTabPointerDrag;
    toolTabPointerDrag = null;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const target = toolTabDropTargetFromPoint(event.clientX, event.clientY, drag);
    const wasActive = drag.active;
    toolTabDragState = null;
    toolTabDropTarget = null;
    if (!wasActive || !target) return;
    try {
      await applyToolTabDrop(drag, target);
    } catch (error) {
      settingsError = error instanceof Error ? error.message : String(error);
    }
  }

  async function applyToolTabDrop(
    drag: NonNullable<typeof toolTabPointerDrag>,
    target: ToolTabDropTarget,
  ) {
    if (target.kind === "float") {
      await floatWorkspaceSlot(drag.workspaceId, drag.slotId);
      return;
    }
    if (target.kind === "workspace") {
      if (!drag.toolTabId || target.workspaceId === drag.workspaceId) return;
      const targetWorkspace = workspaceById(target.workspaceId);
      const groupId = targetWorkspace ? firstDockGroupId(targetWorkspace.layout) : null;
      if (!groupId) throw new Error(`workspace ${target.workspaceId} has no dock group`);
      await mirrorToolTabToWorkspace(drag.toolTabId, target.workspaceId, groupId);
      return;
    }
    if (target.kind === "workspace_edge") {
      if (target.workspaceId !== drag.workspaceId) {
        if (!drag.toolTabId) return;
        const targetWorkspace = workspaceById(target.workspaceId);
        const groupId = targetWorkspace ? firstDockGroupId(targetWorkspace.layout) : null;
        if (!groupId) throw new Error(`workspace ${target.workspaceId} has no dock group`);
        await mirrorToolTabToWorkspace(drag.toolTabId, target.workspaceId, groupId);
        return;
      }
      await moveWorkspaceSlotToEdge(drag.workspaceId, drag.slotId, target.side);
      return;
    }
    if (target.workspaceId !== drag.workspaceId) {
      if (!drag.toolTabId) return;
      const targetWorkspace = workspaceById(target.workspaceId);
      const groupId = target.kind === "group" ? target.groupId : targetWorkspace ? firstDockGroupId(targetWorkspace.layout) : null;
      if (!groupId) throw new Error(`workspace ${target.workspaceId} has no dock group`);
      await mirrorToolTabToWorkspace(drag.toolTabId, target.workspaceId, groupId);
      return;
    }
    if (target.kind === "group") {
      await moveWorkspaceSlotToGroup(drag.workspaceId, drag.slotId, target.groupId);
      return;
    }
    await moveWorkspaceSlotToSplit(drag.workspaceId, drag.slotId, target.slotId, target.side);
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

  function toolTabDropTargetFromPoint(
    x: number,
    y: number,
    drag: NonNullable<typeof toolTabPointerDrag>,
  ): ToolTabDropTarget | null {
    const workspaceTabs = [...document.querySelectorAll<HTMLElement>("[data-workspace-id]")];
    const workspaceTarget = workspaceTabs.find((tab) => {
      const rect = tab.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    });
    const workspaceId = workspaceTarget?.dataset.workspaceId;
    if (workspaceId && workspaceId !== drag.workspaceId) return { kind: "workspace", workspaceId };

    const workspaceEdgeTarget = toolTabWorkspaceEdgeDropTargetFromPoint(x, y, drag.workspaceId);
    if (workspaceEdgeTarget) return workspaceEdgeTarget;

    const dockGroups = [...document.querySelectorAll<HTMLElement>("[data-dock-group-id]")];
    const containingGroup = dockGroups
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
      .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0];
    if (containingGroup) {
      const targetWorkspaceId = containingGroup.element.dataset.workspaceId;
      const groupId = containingGroup.element.dataset.dockGroupId;
      if (!targetWorkspaceId || !groupId) return null;
      const groupEdgeTarget = toolTabGroupEdgeDropTargetFromPoint(x, y, containingGroup.element, containingGroup.rect);
      if (groupEdgeTarget) return groupEdgeTarget;
      const slotTarget = toolTabSlotDropTargetFromPoint(x, y, targetWorkspaceId);
      if (slotTarget) return slotTarget;
      return { kind: "group", workspaceId: targetWorkspaceId, groupId };
    }

    const workspaceBody = document.querySelector<HTMLElement>(".workspace-body");
    if (workspaceBody) {
      const rect = workspaceBody.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return null;
    }
    return { kind: "float", workspaceId: drag.workspaceId };
  }

  function toolTabGroupEdgeDropTargetFromPoint(
    x: number,
    y: number,
    group: HTMLElement,
    rect: DOMRect,
  ): ToolTabDropTarget | null {
    const workspaceId = group.dataset.workspaceId;
    const slotId = group.dataset.activeToolSlotId;
    if (!workspaceId || !slotId) return null;
    const edgeInset = Math.min(72, Math.max(28, Math.min(rect.width, rect.height) * 0.22));
    const distances = [
      { side: "left" as const, distance: x - rect.left },
      { side: "right" as const, distance: rect.right - x },
      { side: "up" as const, distance: y - rect.top },
      { side: "down" as const, distance: rect.bottom - y },
    ];
    const nearest = distances.reduce((best, item) => (item.distance < best.distance ? item : best));
    return nearest.distance <= edgeInset ? { kind: "split", workspaceId, slotId, side: nearest.side } : null;
  }

  function toolTabWorkspaceEdgeDropTargetFromPoint(
    x: number,
    y: number,
    workspaceId: string,
  ): ToolTabDropTarget | null {
    const workspaceBody = document.querySelector<HTMLElement>(".workspace-body");
    if (!workspaceBody) return null;
    const rect = workspaceBody.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
    const edgeInset = Math.min(44, Math.max(18, Math.min(rect.width, rect.height) * 0.08));
    const distances = [
      { side: "left" as const, distance: x - rect.left },
      { side: "right" as const, distance: rect.right - x },
      { side: "up" as const, distance: y - rect.top },
      { side: "down" as const, distance: rect.bottom - y },
    ];
    const nearest = distances.reduce((best, item) => (item.distance < best.distance ? item : best));
    return nearest.distance <= edgeInset ? { kind: "workspace_edge", workspaceId, side: nearest.side } : null;
  }

  function toolTabSlotDropTargetFromPoint(x: number, y: number, workspaceId: string): ToolTabDropTarget | null {
    const slots = [...document.querySelectorAll<HTMLElement>("[data-tool-slot-id]")];
    const match = slots
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
      .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0];
    const slotId = match?.element.dataset.toolSlotId;
    if (!match || !slotId) return null;
    return { kind: "split", workspaceId, slotId, side: dockSideForRect(match.rect, x, y) };
  }

  function dockSideForRect(rect: DOMRect, x: number, y: number): "left" | "right" | "up" | "down" {
    const relativeX = (x - rect.left) / rect.width;
    const relativeY = (y - rect.top) / rect.height;
    const distances = [
      { side: "left" as const, distance: relativeX },
      { side: "right" as const, distance: 1 - relativeX },
      { side: "up" as const, distance: relativeY },
      { side: "down" as const, distance: 1 - relativeY },
    ];
    return distances.reduce((best, item) => (item.distance < best.distance ? item : best)).side;
  }

  function toolTabDropPreview(): ToolTabDropPreview | null {
    const target = toolTabDropTarget;
    if (!target || target.kind === "float" || target.kind === "workspace") return null;
    if (typeof document === "undefined") return null;
    const workspaceBody = document.querySelector<HTMLElement>(".workspace-body");
    if (!workspaceBody) return null;
    const bodyRect = workspaceBody.getBoundingClientRect();
    if (target.kind === "workspace_edge") {
      const previewRect = sliceRect(bodyRect, target.side, 0.28);
      return {
        kind: target.kind,
        side: target.side,
        style: rectStyleWithin(previewRect, bodyRect),
      };
    }
    if (target.kind === "group") {
      const group = dockGroupElementById(target.groupId);
      if (!group) return null;
      return {
        kind: target.kind,
        side: "",
        style: rectStyleWithin(group.getBoundingClientRect(), bodyRect),
      };
    }
    const slot = toolSlotElementById(target.slotId);
    const group = slot?.closest<HTMLElement>("[data-dock-group-id]");
    if (!group) return null;
    const previewRect = sliceRect(group.getBoundingClientRect(), target.side, 0.5);
    return {
      kind: target.kind,
      side: target.side,
      style: rectStyleWithin(previewRect, bodyRect),
    };
  }

  function dockGroupElementById(groupId: string): HTMLElement | null {
    return [...document.querySelectorAll<HTMLElement>("[data-dock-group-id]")]
      .find((group) => group.dataset.dockGroupId === groupId) ?? null;
  }

  function toolSlotElementById(slotId: string): HTMLElement | null {
    return [...document.querySelectorAll<HTMLElement>("[data-tool-slot-id]")]
      .find((slot) => slot.dataset.toolSlotId === slotId) ?? null;
  }

  function activeToolDropTargetGroupId() {
    return toolTabDropTarget?.kind === "group" ? toolTabDropTarget.groupId : null;
  }

  function activeToolSplitTargetSlotId() {
    return toolTabDropTarget?.kind === "split" ? toolTabDropTarget.slotId : null;
  }

  function sliceRect(rect: DOMRect, side: "left" | "right" | "up" | "down", ratio: number) {
    const width = side === "left" || side === "right" ? rect.width * ratio : rect.width;
    const height = side === "up" || side === "down" ? rect.height * ratio : rect.height;
    const left = side === "right" ? rect.right - width : rect.left;
    const top = side === "down" ? rect.bottom - height : rect.top;
    return { left, top, width, height };
  }

  function rectStyleWithin(rect: { left: number; top: number; width: number; height: number }, parent: DOMRect) {
    return [
      `left: ${Math.round(rect.left - parent.left)}px`,
      `top: ${Math.round(rect.top - parent.top)}px`,
      `width: ${Math.round(rect.width)}px`,
      `height: ${Math.round(rect.height)}px`,
    ].join("; ");
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
    if (toolTabDragState || toolTabPointerDrag) cancelToolTabDragInteraction();
    resizeDrag = null;
    dockResizeDrag = null;
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

  async function mountTerminalWhenReady(paneId: string, viewId?: string) {
    const terminalViewId = await waitForPaneContainer(paneId, viewId);
    if (terminalViewId === null) return;
    await terminalTabs.mountTerminal(paneId, terminalViewId);
  }

  async function waitForPaneContainer(paneId: string, viewId?: string) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const tab = findLocalTabByPaneId(paneId);
      if (!tab) return null;
      const pane = terminalPaneById(tab, paneId);
      if (viewId && pane?.viewContainers.has(viewId)) return viewId;
      const visibleViewId = pane ? Array.from(pane.viewContainers.keys()).find((id) => pane.viewContainers.get(id)?.isConnected) : undefined;
      if (!viewId && visibleViewId) return visibleViewId;
      if (!viewId && pane?.container) return paneId;
      await tick();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    throw new Error(viewId ? `terminal pane ${paneId} did not mount container view ${viewId}` : `terminal pane ${paneId} did not mount a visible container`);
  }

  function terminalMount(node: HTMLDivElement, params: { pane: TerminalPane; toolTabId: string; viewId: string }) {
    let current = params;
    attachTerminalMount(node, current);
    return {
      update(next: { pane: TerminalPane; toolTabId: string; viewId: string }) {
        if (next.pane === current.pane && next.toolTabId === current.toolTabId && next.viewId === current.viewId) return;
        detachTerminalMount(node, current.pane, current.viewId);
        current = next;
        attachTerminalMount(node, current);
      },
      destroy() {
        detachTerminalMount(node, current.pane, current.viewId);
      },
    };
  }

  function attachTerminalMount(node: HTMLDivElement, params: { pane: TerminalPane; toolTabId: string; viewId: string }) {
    params.pane.viewContainers.set(params.viewId, node);
    if (params.viewId === params.pane.id) params.pane.container = node;
    void mountTerminalToolTab(params.toolTabId, params.viewId);
  }

  function detachTerminalMount(node: HTMLDivElement, pane: TerminalPane, viewId: string) {
    if (pane.viewContainers.get(viewId) === node) {
      pane.viewContainers.delete(viewId);
    }
    if (pane.container === node) {
      pane.container = undefined;
    }
    terminalTabs.scheduleFit(pane.id);
  }

  async function mountTerminalToolTab(toolTabId: string, viewId?: string) {
    const runtime = terminalRuntimeForToolTab(toolTabId);
    const pane = runtime ? terminalPaneById(runtime.tab, runtime.tab.activePaneId) : null;
    if (!pane) return;
    const terminalViewId = viewId ?? visibleTerminalViewIdForToolTab(toolTabId, pane);
    activeTerminalToolTabId = toolTabId;
    activeId = toolTabId;
    await tick();
    await mountTerminalWhenReady(pane.id, terminalViewId);
    await flushTerminalOutputBacklog(pane.id);
    terminalTabs.scheduleFit(pane.id, terminalViewId);
    pane.term?.focus();
    syncTerminalMenuState();
  }

  function visibleTerminalViewIdForToolTab(toolTabId: string, pane: TerminalPane) {
    const existing = Array.from(pane.viewContainers.keys()).find((id) => pane.viewContainers.get(id)?.isConnected);
    if (existing) return existing;
    const floatingSlot = activeFloatingWindow ? activeDisplaySlotForToolTab(activeFloatingWindow.layout, toolTabId) : null;
    if (floatingSlot) return floatingSlot.id;
    const workspaceSlot = activeWorkspace ? activeDisplaySlotForToolTab(activeWorkspace.layout, toolTabId) : null;
    return workspaceSlot?.id ?? pane.id;
  }

  function activeDisplaySlotForToolTab(layout: WorkspaceDockLayout, toolTabId: string): WorkspaceToolSlot | null {
    if (layout.kind === "group") {
      const active = activeGroupSlot(layout);
      if (displaySlotHasToolTab(active, toolTabId)) return active;
      return layout.slots.find((slot) => displaySlotHasToolTab(slot, toolTabId)) ?? null;
    }
    return layout.children
      .map((child) => activeDisplaySlotForToolTab(child, toolTabId))
      .find((slot): slot is WorkspaceToolSlot => slot !== null) ?? null;
  }

  function displaySlotHasToolTab(slot: WorkspaceToolSlot | null, toolTabId: string) {
    return slot?.kind === "owned" || slot?.kind === "mirror" ? slot.tool_tab_id === toolTabId : false;
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

  async function openAppMenu(root: AppMenuRootId, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (!hasTauriRuntime()) return;
    const rect = event.currentTarget instanceof HTMLElement ? event.currentTarget.getBoundingClientRect() : null;
    if (!rect) throw new Error("app menu root did not provide a DOM target");
    await unwrapCommand(
      commands.showAppMenu({
        root,
        window_label: currentWindowLabel(),
        x: rect.left,
        y: rect.bottom,
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
    if (!hasLocalTerminalPane(event.pane_id)) return;
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
    if (event.action === "close_pane") {
      void closePane(event.pane_id, { recordHistory: true });
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
      const id = `workspace.new:${host.id}`;
      const ssh = host.document.ssh;
      const local = host.document.local;
      const folder = hostFolderLabel(host);
      return {
        id,
        kind: "connection-host",
        title: `Open Workspace: ${host.document.name}`,
        scope: host.source === "open_ssh_config" ? folder : `${t("hosts")} / ${folder}`,
        icon: resolveHostIcon(host),
        keywords: [
          host.document.name,
          folder,
          host.document.icon?.type === "catalog" ? host.document.icon.name : "",
          host.document.protocol,
          local?.command ?? "",
          local?.cwd ?? "",
          ssh?.hostname ?? "",
          ssh?.username ?? "",
          ssh?.proxy_jump ?? "",
          hostSubtitle(host),
          "workspace",
          "host",
          "open",
          "connect",
          "connection",
          "local",
          "ssh",
          "工作区",
          "打开",
          "连接",
          "主机",
          "本地",
          "gongzuoqu",
          "gzq",
          "dakai",
          "dk",
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
    await createWorkspaceForHost(id);
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

  function closeToolTabContextMenuOnExternalPointer(event: PointerEvent) {
    if (!toolTabContextMenu) return;
    if (event.target instanceof Element && event.target.closest("[data-tooltab-menu]")) return;
    closeToolTabContextMenu();
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
    if (id.startsWith("workspace.new:")) {
      await createWorkspaceForHost(id.slice("workspace.new:".length));
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
    if (id === "tool.openResources") {
      await openWorkspaceResourceMonitor();
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
    workspaceId: string,
    toolTabId: string,
    error: unknown,
    trust: {
      acceptNewHostKey?: boolean;
      updateChangedHostKey?: boolean;
      credential?: { kind: SshCredentialKind; value: string };
      saveCredential?: boolean;
    } = {},
  ) {
    const message = error instanceof Error ? error.message : String(error);
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

  async function handleTerminalExit(event: TerminalExitEvent) {
    if (!hasLocalTerminalPane(event.session_id)) return;
    clearHostSessionRetry(event.session_id);
    terminalTabs.markExited(event);
  }

  async function handleWorkspaceSshVerificationRequired(event: WorkspaceSshVerificationRequiredEvent) {
    const { challenge, verification_id: verificationId, workspace_id: workspaceId } = event;
    if (challenge.kind === "credential") {
      pendingSshCredential = {
        scope: "workspace",
        verificationId,
        workspaceId,
        toolTabId: challenge.challenge.source_tool_tab_id,
        authTargetLabel: challenge.challenge.auth_target.label,
        kind: challenge.challenge.credential_kind,
        value: "",
        save: false,
      };
      const paneId = terminalPaneIdForToolTab(challenge.challenge.source_tool_tab_id);
      if (paneId) terminalTabs.markConnectionPrompt(paneId, "Waiting for SSH credential");
      return;
    }

    const hostKey = challenge.challenge;
    const changed = hostKey.challenge_kind === "changed";
    const allow = await ask(
      changed
        ? `SSH host key changed for ${hostKey.auth_target.label} (${hostKey.target}).\n\nOnly continue if you expected this host key to change.\n\n${hostKey.algorithm} ${hostKey.fingerprint}`
        : `Trust SSH host key for ${hostKey.auth_target.label} (${hostKey.target})?\n\n${hostKey.algorithm} ${hostKey.fingerprint}`,
      {
        title: changed ? "SSH Host Key Changed" : "SSH Host Key",
        kind: "warning",
        okLabel: changed ? "Update Trust Record" : "Trust Host Key",
        cancelLabel: "Cancel",
      },
    );
    await unwrapCommand(commands.submitWorkspaceSshVerification({
      workspace_id: workspaceId,
      verification_id: verificationId,
      response: allow
        ? {
            kind: "host_key",
            accept_new_host_key: !changed,
            update_changed_host_key: changed,
          }
        : { kind: "cancel" },
    }));
    notifyFilesWorkspaceVerificationSubmitted(workspaceId);
  }

  async function handlePortForwardSshVerificationRequired(event: PortForwardSshVerificationRequiredEvent) {
    const { challenge, verification_id: verificationId, host_id: hostId } = event;
    if (challenge.kind === "credential") {
      pendingSshCredential = {
        scope: "port_forward",
        verificationId,
        hostId,
        toolTabId: null,
        authTargetLabel: challenge.challenge.auth_target.label,
        kind: challenge.challenge.credential_kind,
        value: "",
        save: false,
      };
      return;
    }

    const hostKey = challenge.challenge;
    const changed = hostKey.challenge_kind === "changed";
    const allow = await ask(
      changed
        ? `SSH host key changed for ${hostKey.auth_target.label} (${hostKey.target}).\n\nOnly continue if you expected this host key to change.\n\n${hostKey.algorithm} ${hostKey.fingerprint}`
        : `Trust SSH host key for ${hostKey.auth_target.label} (${hostKey.target})?\n\n${hostKey.algorithm} ${hostKey.fingerprint}`,
      {
        title: changed ? "SSH Host Key Changed" : "SSH Host Key",
        kind: "warning",
        okLabel: changed ? "Update Trust Record" : "Trust Host Key",
        cancelLabel: "Cancel",
      },
    );
    await unwrapCommand(commands.submitPortForwardSshVerification({
      host_id: hostId,
      verification_id: verificationId,
      response: allow
        ? {
            kind: "host_key",
            accept_new_host_key: !changed,
            update_changed_host_key: changed,
          }
        : { kind: "cancel" },
    }));
  }

  function terminalPaneIdForToolTab(toolTabId: string | null) {
    if (!toolTabId) return null;
    const runtime = terminalRuntimeForToolTab(toolTabId);
    return runtime?.tab.activePaneId ?? null;
  }

  async function submitSshCredential() {
    if (!pendingSshCredential) return;
    const pending = pendingSshCredential;
    pendingSshCredential = null;
    const response = {
      kind: "credential" as const,
      credential: { kind: pending.kind, value: pending.value },
      save_credential: pending.save,
    };
    if (pending.scope === "workspace") {
      if (!pending.workspaceId) throw new Error("Workspace SSH credential is missing Workspace id");
      await unwrapCommand(commands.submitWorkspaceSshVerification({
        workspace_id: pending.workspaceId,
        verification_id: pending.verificationId,
        response,
      }));
      notifyFilesWorkspaceVerificationSubmitted(pending.workspaceId);
    } else {
      if (!pending.hostId) throw new Error("Port Forwarding SSH credential is missing Host id");
      await unwrapCommand(commands.submitPortForwardSshVerification({
        host_id: pending.hostId,
        verification_id: pending.verificationId,
        response,
      }));
    }
  }

  function cancelSshCredential() {
    const pending = pendingSshCredential;
    pendingSshCredential = null;
    if (!pending) return;
    if (pending.scope === "workspace") {
      const workspaceId = pending.workspaceId;
      if (!workspaceId) return;
      void unwrapCommand(commands.submitWorkspaceSshVerification({
        workspace_id: workspaceId,
        verification_id: pending.verificationId,
        response: { kind: "cancel" },
      })).finally(() => notifyFilesWorkspaceVerificationSubmitted(workspaceId));
    } else {
      if (!pending.hostId) return;
      void unwrapCommand(commands.submitPortForwardSshVerification({
        host_id: pending.hostId,
        verification_id: pending.verificationId,
        response: { kind: "cancel" },
      }));
    }
  }

  function notifyFilesWorkspaceVerificationSubmitted(workspaceId: string) {
    window.dispatchEvent(new CustomEvent(FILES_WORKSPACE_SSH_VERIFICATION_SUBMITTED_EVENT, {
      detail: { workspaceId },
    }));
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
      await openWorkspaceTerminalSession();
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
      void openWorkspaceTerminalSession();
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
    floatingWindowId = currentFloatingWindowId();
    const stopTransferQueueObserver = startTransferQueueObserver();
    void (async () => {
      if (hasTauriRuntime()) {
        const [outputDispose, exitDispose, transportStateDispose, configDispose, verificationDispose, portForwardVerificationDispose, paneMenuDispose, terminalMenuDispose] = await Promise.all([
          listen<TerminalOutputEvent>("terminal://output", (event) => enqueueTerminalOutput(event.payload)),
          listen<TerminalExitEvent>("terminal://exit", (event) => {
            void handleTerminalExit(event.payload).catch((error) => {
              settingsError = error instanceof Error ? error.message : String(error);
            });
          }),
          listen<TerminalTransportStateEvent>("terminal://transport-state", (event) => {
            routeTerminalPaneEvent(event.payload.session_id, localTerminalPaneIds(), () => terminalTabs.markTransportState(event.payload));
          }),
          listen("config://changed", () => {
            void loadSettings().catch((error) => {
              settingsError = error instanceof Error ? error.message : String(error);
            });
          }),
          listen<WorkspaceSshVerificationRequiredEvent>("workspace://ssh-verification-required", (event) => {
            void handleWorkspaceSshVerificationRequired(event.payload).catch((error) => {
              settingsError = error instanceof Error ? error.message : String(error);
            });
          }),
          listen<PortForwardSshVerificationRequiredEvent>("port-forwarding://ssh-verification-required", (event) => {
            void handlePortForwardSshVerificationRequired(event.payload).catch((error) => {
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
          verificationDispose();
          portForwardVerificationDispose();
          paneMenuDispose();
          terminalMenuDispose();
          return;
        }
        outputUnlisten = outputDispose;
        exitUnlisten = exitDispose;
        transportStateUnlisten = transportStateDispose;
        configUnlisten = configDispose;
        workspaceSshVerificationUnlisten = verificationDispose;
        portForwardSshVerificationUnlisten = portForwardVerificationDispose;
        paneMenuUnlisten = paneMenuDispose;
        terminalMenuUnlisten = terminalMenuDispose;
      }
      await workspaceStore.subscribe(syncWorkspaceSnapshot);
      await loadSettings();
      await workspaceStore.load();
      syncWorkspaceSnapshot(workspaceStore.snapshot);
      await confirmAutoOpenPortForwardRisks(workspaceSnapshot);
      if (!floatingWindowId && workspaceSnapshot?.active_workspace_id) {
        await restoreTerminalRuntimeForWorkspace(workspaceSnapshot.active_workspace_id);
      }
      if (!floatingWindowId) {
        const restored = (await restoreTabHandoff()) || (await restoreHotTabs());
        await ensureStartupSession(restored);
      }
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
    document.addEventListener("pointerdown", closeToolTabContextMenuOnExternalPointer, { capture: true });
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
      document.removeEventListener("pointerdown", closeToolTabContextMenuOnExternalPointer, { capture: true });
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
      workspaceSshVerificationUnlisten?.();
      portForwardSshVerificationUnlisten?.();
      paneMenuUnlisten?.();
      terminalMenuUnlisten?.();
      stopTransferQueueObserver();
      workspaceStore.dispose();
      if (floatingWindowId) {
        for (const tab of terminalRuntimeTabs()) disposeTerminalTab(tab);
        return;
      }
      if (isHotModuleReplacement) {
        storeHotTabsSnapshot();
        for (const tab of terminalRuntimeTabs()) disposeTerminalTab(tab);
        return;
      }
      for (const tab of terminalRuntimeTabs()) {
        disposeTerminalTab(tab);
        for (const pane of tab.panes) {
          if (movedPaneIds.has(pane.id)) continue;
          if (pane.status === "running") void unwrapCommand(commands.closeTerminalSession(pane.id));
        }
      }
    };
  });

  $effect(() => {
    if (floatingWindowId) return;
    const workspaceId = workspaceSnapshot?.active_workspace_id ?? "";
    if (!workspaceId || workspaceId === activeTerminalWorkspaceId) return;
    void restoreTerminalRuntimeForWorkspace(workspaceId).then(() => ensureStartupSession(false));
  });

  $effect(() => {
    if (floatingWindowId) return;
    const workspace = activeWorkspace;
    if (!workspace) return;
    const terminalSlot = activeTerminalSlotForWorkspace(workspace);
    const tool = terminalToolTabForSlot(terminalSlot);
    if (!tool) return;
    activeTerminalToolTabId = tool.id;
    void mountTerminalToolTab(tool.id);
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

<main
  class:floating-workspace={floatingWindowId !== null}
  class:integrated-titlebar={integratedTitlebar}
  class:integrated-titlebar-macos={integratedTitlebarChrome === "macos"}
  class:integrated-titlebar-decorum={integratedTitlebarChrome === "decorum"}
  class:titlebar-single-row={integratedTitlebarLayout === "single-row"}
  class:titlebar-two-row={integratedTitlebarLayout === "two-row"}
  class:left-tabs={tabsOnLeft}
  class:vertical={isVertical}
  class="workspace"
>
  <div class="terminal-measure-host" aria-hidden="true">
    <div class="terminal-mount" bind:this={terminalMeasureContainer}></div>
  </div>

  {#if workspaceSnapshot && !floatingWindowId}
    <WorkspaceTabBar
      workspaces={workspaceSnapshot.workspaces}
      activeWorkspaceId={workspaceSnapshot.active_workspace_id}
      {integratedTitlebar}
      {integratedTitlebarChrome}
      titlebarLayout={integratedTitlebarLayout}
      integratedTitlebarSingleRow={integratedTitlebarSingleRow}
      {appMenuRoots}
      showHostIcons={showHostIconsInTabs}
      {hostIconById}
      dropPreviewWorkspaceId={toolTabDropTarget?.kind === "workspace" ? toolTabDropTarget.workspaceId : null}
      {activateWorkspace}
      {closeWorkspace}
      {closeOtherWorkspaces}
      {closeWorkspacesToRight}
      {newWorkspace}
      {openAppMenu}
      {openHostPicker}
      {handleNewWorkspaceSecondaryClick}
    />
  {:else}
    <div
      class:integrated-titlebar={integratedTitlebar}
      class:integrated-titlebar-macos={integratedTitlebarChrome === "macos"}
      class:integrated-titlebar-decorum={integratedTitlebarChrome === "decorum"}
      class:titlebar-single-row={integratedTitlebarLayout === "single-row"}
      class:titlebar-two-row={integratedTitlebarLayout === "two-row"}
      class="workspace-tabbar-loading"
    >
      {#if integratedTitlebarLayout === "two-row"}
        <div class="workspace-tabbar-loading-menu-row">
          <span>{workspaceStore.loading ? "Loading workspace..." : "Workspace"}</span>
          <div
            class="workspace-tabbar-loading-drag-zone"
            aria-hidden="true"
            data-tauri-drag-region={integratedTitlebar ? true : undefined}
          ></div>
          {#if integratedTitlebarChrome === "decorum"}
            <div class="workspace-decorum-slot" aria-hidden="true" use:mountDecorumTitlebarHost></div>
          {/if}
        </div>
        <div class="workspace-tabbar-loading-tab-row" aria-hidden="true"></div>
      {:else}
        <span>{workspaceStore.loading ? "Loading workspace..." : "Workspace"}</span>
        <div
          class="workspace-tabbar-loading-drag-zone"
          aria-hidden="true"
          data-tauri-drag-region={integratedTitlebar ? true : undefined}
        ></div>
        {#if integratedTitlebarChrome === "decorum"}
          <div class="workspace-decorum-slot" aria-hidden="true" use:mountDecorumTitlebarHost></div>
        {/if}
      {/if}
    </div>
  {/if}

  <section
    class="workspace-body"
    aria-label={activeFloatingWindow ? "Floating ToolTabs" : (activeWorkspace?.title ?? "Workspace")}
    data-workspace-active-id={workspaceSnapshot?.active_workspace_id ?? ""}
    data-workspace-rendered-id={activeWorkspace?.id ?? ""}
    data-workspace-snapshot-count={workspaceSnapshot?.workspaces.length ?? 0}
    data-workspace-render-revision={workspaceRenderRevision}
    data-active-tool-slot-revision={activeToolSlotOverrideRevision}
    data-active-tool-slot-signature={activeWorkspace ? dockLayoutActiveSlotRenderKey(activeWorkspace.layout, activeToolSlotOverrideByGroupId) : ""}
  >
    {#key activeFloatingWindow ? `floating:${activeFloatingWindow.id}` : floatingWindowId ? `floating-missing:${floatingWindowId}` : activeWorkspace ? `workspace:${activeWorkspace.id}` : "workspace:none"}
      {#if workspaceSnapshot}
        {#if activeFloatingWindow}
          {@render floatingDockLayout(activeFloatingWindow)}
        {:else if floatingWindowId}
          <div class="dock-empty">
            <strong>Floating window closed</strong>
            <span>The floating ToolTab source is no longer available.</span>
          </div>
        {:else if activeWorkspace}
          {@render dockLayout(activeWorkspace.layout, activeWorkspace, null, [], rootDockGroupBounds(), activeToolSlotOverrideRevision, activeToolSlotOverrideByGroupId)}
        {:else}
          <div class="dock-empty">Workspace</div>
        {/if}
      {:else}
        <div class="dock-empty">Workspace</div>
      {/if}
    {/key}
    {#if toolTabDropPreview()}
      {@const preview = toolTabDropPreview()!}
      <div
        class="tooltab-drop-preview"
        class:edge={preview.kind === "workspace_edge"}
        class:group={preview.kind === "group"}
        class:split={preview.kind === "split"}
        data-drop-kind={preview.kind}
        data-drop-side={preview.side}
        data-tooltab-drop-preview="true"
        style={preview.style}
        aria-hidden="true"
      ></div>
    {/if}
  </section>

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
              <HostIcon icon={resolveHostIcon(host)} />
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
                <HostIcon icon={resolveHostIcon(host)} />
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
      <p>{pendingSshCredential.authTargetLabel}</p>
      <input
        type="password"
        autocomplete="off"
        bind:this={sshCredentialInput}
        bind:value={pendingSshCredential.value}
        aria-label={pendingSshCredential.kind === "password" ? `SSH password for ${pendingSshCredential.authTargetLabel}` : `SSH key passphrase for ${pendingSshCredential.authTargetLabel}`}
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

  {#if toolTabContextMenu}
    <section
      class="tooltab-context-menu"
      style={`left: ${toolTabContextMenu.left}px; top: ${toolTabContextMenu.top}px;`}
      role="menu"
      data-tooltab-menu="true"
    >
      <button type="button" role="menuitem" onclick={() => void closeWorkspaceSlot(toolTabContextMenu!.workspaceId, toolTabContextMenu!.slotId).finally(closeToolTabContextMenu)}>
        Close
      </button>
      <button type="button" role="menuitem" onclick={() => void closeOtherWorkspaceSlots(toolTabContextMenu!.workspaceId, toolTabContextMenu!.slotId).finally(closeToolTabContextMenu)}>
        Close Others
      </button>
      <button type="button" role="menuitem" onclick={() => void closeWorkspaceSlotsToRight(toolTabContextMenu!.workspaceId, toolTabContextMenu!.slotId).finally(closeToolTabContextMenu)}>
        Close to the Right
      </button>
      {#if toolTabContextMenu.toolTabId}
        <hr />
        <button type="button" role="menuitem" onclick={() => void floatWorkspaceSlot(toolTabContextMenu!.workspaceId, toolTabContextMenu!.slotId).finally(closeToolTabContextMenu)}>
          Float ToolTab
        </button>
        {#each otherMirrorTargets(toolTabContextMenu) as target (target.workspace.id)}
          <button
            type="button"
            role="menuitem"
            onclick={() => void mirrorToolTabToWorkspace(toolTabContextMenu!.toolTabId!, target.workspace.id, target.groupId).finally(closeToolTabContextMenu)}
          >
            Mirror to {target.workspace.title}
          </button>
        {/each}
      {/if}
    </section>
  {/if}

</main>

{#snippet floatingDockLayout(floatingWindow: WorkspaceFloatingWindowState)}
  <section class="floating-window-shell">
    <header>
      <span>Floating ToolTabs</span>
    </header>
    {@render dockLayout(floatingWindow.layout, null, floatingWindow.id, [], rootDockGroupBounds(), activeToolSlotOverrideRevision, activeToolSlotOverrideByGroupId)}
  </section>
{/snippet}

{#snippet dockLayout(
  layout: WorkspaceDockLayout,
  workspace: WorkspaceTabState | null,
  floatingWindowId: string | null,
  splitPath: number[],
  bounds: DockGroupBounds,
  activeSlotRevision: number,
  activeSlotOverrides: Record<string, string>,
)}
  {#if layout.kind === "split"}
    <section
      class:column={layout.direction === "column"}
      class:row={layout.direction === "row"}
      class="workspace-dock-split"
      style={splitStyle(layout)}
    >
      {#each layout.children as child, index (dockLayoutStableRenderKey(child))}
        {@render dockLayout(
          child,
          workspace,
          floatingWindowId,
          [...splitPath, index],
          childDockGroupBounds(bounds, layout.direction, index, layout.children.length),
          activeSlotRevision,
          activeSlotOverrides,
        )}
        {#if index < layout.children.length - 1}
          <button
            class:column={layout.direction === "column"}
            class:row={layout.direction === "row"}
            class="workspace-dock-resizer"
            type="button"
            aria-label="Resize Dock groups"
            onpointerdown={(event) =>
              startDockResize(
                event,
                { workspaceId: workspace?.id ?? null, floatingWindowId },
                layout,
                splitPath,
                index,
              )}
          ></button>
        {/if}
      {/each}
    </section>
  {:else}
    <WorkspaceDockGroup
      {layout}
      {workspace}
      activeSlotId={activeGroupSlotId(layout)}
      {activeSlotRevision}
      tabbarPlacement={toolTabbarPlacement(bounds)}
      visualRole={visualDockGroupRole(bounds)}
      dropTargetGroupId={activeToolDropTargetGroupId()}
      splitTargetSlotId={activeToolSplitTargetSlotId()}
      draggingSlotId={toolTabDragState?.slotId ?? null}
      {slotTool}
      slotTitle={slotToolTitle}
      {ownerWorkspaceTitle}
      terminalSessionId={terminalSessionIdForToolTab}
      onActivate={(slotId) => workspace ? void activateWorkspaceSlot(workspace, slotId) : undefined}
      onClose={(slotId) => workspace ? void closeWorkspaceSlot(workspace.id, slotId) : undefined}
      onContextMenu={(event, group, slot) => workspace ? openToolTabContextMenu(event, workspace, group, slot) : undefined}
      onPointerDown={(event, slot) => workspace ? startToolTabPointerDrag(event, workspace, slot) : undefined}
    >
      {#snippet children(activeSlot, active)}
        {@render dockSlotContent(activeSlot, workspace, active)}
      {/snippet}
    </WorkspaceDockGroup>
  {/if}
{/snippet}

{#snippet dockSlotContent(slot: WorkspaceToolSlot | null, workspace: WorkspaceTabState | null, active: boolean = true)}
  {@const tool = slot ? slotTool(slot) : null}
  {@const effectiveWorkspace = workspace ?? (tool ? workspaceById(tool.owner_workspace_id) : null)}
  {#if !slot}
    <div class="dock-empty">No ToolTab</div>
  {:else if slot.kind === "closed_source"}
    <div class="dock-empty">
      <strong>{slot.previous_title}</strong>
      <span>Source workspace closed: {slot.owner_workspace_title}</span>
    </div>
  {:else if slot.kind === "floating_placeholder"}
    <div class="dock-empty">
      <strong>{tool?.title ?? "ToolTab"}</strong>
      <span>Shown in floating window</span>
    </div>
  {:else if !tool}
    <div class="dock-empty">Missing ToolTab</div>
  {:else if !effectiveWorkspace}
    <div class="dock-empty">
      <strong>{tool.title}</strong>
      <span>Owner workspace is no longer available.</span>
    </div>
  {:else if tool.kind === "files"}
    {#key tool.id}
      <FilesToolTab
        toolTab={tool}
        workspaceId={effectiveWorkspace.id}
        defaultViewMode={defaultFilesViewMode}
        showHidden={showHiddenFiles}
        deleteBehavior={filesDeleteBehavior}
        {textPreviewLimitBytes}
        {imagePreviewLimitBytes}
        toolbarActionIds={filesToolbarActionIds}
        treeStickyEnabled={filesTreeStickyEnabled}
        treeStickyMaxLevels={filesTreeStickyMaxLevels}
      />
    {/key}
  {:else if tool.kind === "transfers"}
    <TransfersToolTab workspace={effectiveWorkspace} {active} />
  {:else if tool.kind === "resources"}
    <ResourceMonitorToolTab toolTab={tool} workspaceId={effectiveWorkspace.id} viewId={slot.id} />
  {:else if tool.kind === "ports"}
    <PortsToolTab toolTab={tool} host={connectionHostForToolTab(tool)} />
  {:else}
    {@const terminalMode = terminalRenderMode(workspace, effectiveWorkspace)}
    {@const runtime = terminalRuntimeForToolTab(tool.id)}
    {@const pane = runtime ? terminalPaneById(runtime.tab, runtime.tab.activePaneId) : null}
    {#if !terminalMode}
      <div class="dock-empty">
        <strong>{tool.title}</strong>
        <span>Terminal is visible in its owner workspace.</span>
      </div>
    {:else}
      <section class="terminal-tool-area" aria-label="Terminal ToolTab">
        <section class="content" aria-label="Terminal content">
          {#if settingsError || workspaceStore.error}
            <div class="placeholder error-state">
              <img src="/favicon.png" alt="" />
              <h1>Nocturne</h1>
              <p>{settingsError || workspaceStore.error}</p>
            </div>
          {:else if tabs.length === 0}
            <div class="placeholder">
              <img src="/favicon.png" alt="" />
              <h1>Nocturne</h1>
            </div>
          {:else if !runtime || !pane}
            <div class="placeholder">
              <img src="/favicon.png" alt="" />
              <h1>Nocturne</h1>
            </div>
          {:else}
            <section
              class="terminal-surface"
              class:mirror={slot.kind === "mirror"}
              data-testid="terminal-surface"
              data-session-id={pane.id}
              data-tool-tab-id={tool.id}
              data-terminal-view-id={slot.id}
              data-terminal-mirror={slot.kind === "mirror" ? "true" : undefined}
              data-terminal-runtime-title={terminalRuntimeTitleForToolTab(tool.id) ?? ""}
              aria-label={pane.title}
              role="group"
              oncontextmenu={(event) => void openPaneContextMenu(event, pane.id)}
            >
              {#if slot.kind === "mirror"}
                <div class="terminal-mirror-source" data-testid="terminal-mirror-source">
                  <span>Mirror from {ownerWorkspaceTitle(slot)}</span>
                </div>
              {/if}
              <div class="terminal-host" data-testid="terminal-host" role="presentation" onmousedown={() => void mountTerminalToolTab(tool.id, slot.id)}>
                <div class="terminal-mount" data-testid="terminal-mount" use:terminalMount={{ pane, toolTabId: tool.id, viewId: slot.id }}></div>
                <div class="terminal-too-small" aria-hidden="true">Terminal too small</div>
              </div>
              {#if pane.error}
                <p class="terminal-error">{pane.error}</p>
              {/if}
            </section>
          {/if}
        </section>
      </section>
    {/if}
  {/if}
{/snippet}

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
    --terminal-bg: #fbfbfb;
    --terminal-fg: #202124;
    --terminal-selection: #c8ddff;
    --terminal-padding-top: 8px;
    --terminal-padding-right: 10px;
    --terminal-padding-bottom: 8px;
    --terminal-padding-left: 10px;
  }

  :global(body) {
    overflow: hidden;
  }

  .workspace {
    --workspace-titlebar-height: 40px;
    width: 100vw;
    height: 100vh;
    display: grid;
    grid-template-rows: var(--workspace-titlebar-height) minmax(0, 1fr);
    background: color-mix(in srgb, var(--app-bg) 94%, var(--app-fg));
  }

  .workspace.integrated-titlebar-decorum.titlebar-two-row {
    --workspace-titlebar-height: 72px;
  }

  .workspace.integrated-titlebar-decorum.titlebar-single-row {
    --workspace-titlebar-height: 40px;
  }

  .terminal-measure-host {
    position: fixed;
    inset: 80px 0 0 0;
    z-index: -1;
    padding: var(--terminal-padding-top) var(--terminal-padding-right) var(--terminal-padding-bottom) var(--terminal-padding-left);
    overflow: hidden;
    visibility: hidden;
    pointer-events: none;
  }

  .workspace-tabbar-loading {
    min-width: 0;
    position: relative;
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 12px;
    border-bottom: 1px solid var(--app-border);
    padding: 0 12px;
    background: color-mix(in srgb, var(--app-bg) 90%, var(--app-control));
    color: color-mix(in srgb, var(--app-fg) 66%, transparent);
    font-size: 12px;
    user-select: none;
    -webkit-user-select: none;
  }

  .workspace-tabbar-loading.integrated-titlebar {
    padding: 0;
  }

  .workspace-tabbar-loading.integrated-titlebar-macos {
    padding-left: 84px;
  }

  .workspace-tabbar-loading.integrated-titlebar-decorum {
    padding-right: 0;
  }

  .workspace-tabbar-loading.titlebar-two-row {
    flex-direction: column;
    align-items: stretch;
    gap: 0;
  }

  .workspace-tabbar-loading.titlebar-single-row {
    padding-block: 5px;
    padding-left: 8px;
  }

  .workspace-tabbar-loading-menu-row,
  .workspace-tabbar-loading-tab-row {
    min-width: 0;
    display: flex;
    align-items: center;
  }

  .workspace-tabbar-loading-menu-row {
    min-height: 32px;
    padding-left: 8px;
    border-bottom: 1px solid color-mix(in srgb, var(--app-border) 70%, transparent);
  }

  .workspace-tabbar-loading-tab-row {
    min-height: 40px;
  }

  .workspace.integrated-titlebar-decorum :global(.workspace-decorum-slot) {
    flex: none;
    width: 138px;
    height: 100%;
    display: grid;
    align-items: stretch;
    justify-content: end;
  }

  .workspace.integrated-titlebar-decorum :global(.workspace-decorum-controls) {
    width: 138px;
    height: 100%;
    display: grid;
    grid-template-columns: repeat(3, 46px);
    align-items: stretch;
    justify-content: end;
    background: transparent;
  }

  .workspace.integrated-titlebar-decorum :global(.workspace-decorum-controls > [data-tauri-drag-region]) {
    display: none !important;
  }

  .workspace.integrated-titlebar-decorum :global(button.decorum-tb-btn) {
    z-index: 3 !important;
    position: relative !important;
    width: 46px !important;
    min-width: 46px !important;
    height: 100% !important;
    min-height: 30px !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    transform: none !important;
    border: 0 !important;
    border-radius: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
    background: transparent !important;
    color: transparent !important;
    font-size: 0 !important;
    font-weight: 400 !important;
    line-height: 1 !important;
    text-shadow: none !important;
    -webkit-text-stroke: 0 transparent !important;
    -webkit-font-smoothing: antialiased !important;
    cursor: default !important;
  }

  .workspace.integrated-titlebar-decorum :global(button.decorum-tb-btn::before),
  .workspace.integrated-titlebar-decorum :global(button.decorum-tb-btn::after) {
    content: "";
    position: absolute;
    box-sizing: border-box;
    display: block;
    pointer-events: none;
    color: color-mix(in srgb, var(--app-fg) 74%, transparent);
  }

  .workspace.integrated-titlebar-decorum :global(#decorum-tb-minimize::before) {
    left: 18px;
    top: 50%;
    width: 10px;
    height: 1px;
    background: currentColor;
    transform: translateY(4px);
  }

  .workspace.integrated-titlebar-decorum :global(#decorum-tb-maximize::before) {
    left: 18px;
    top: 50%;
    width: 10px;
    height: 10px;
    border: 1px solid currentColor;
    transform: translateY(-5px);
  }

  .workspace.integrated-titlebar-decorum :global(#decorum-tb-close::before),
  .workspace.integrated-titlebar-decorum :global(#decorum-tb-close::after) {
    left: 17px;
    top: 50%;
    width: 12px;
    height: 1px;
    background: currentColor;
    transform-origin: center;
  }

  .workspace.integrated-titlebar-decorum :global(#decorum-tb-close::before) {
    transform: rotate(45deg);
  }

  .workspace.integrated-titlebar-decorum :global(#decorum-tb-close::after) {
    transform: rotate(-45deg);
  }

  .workspace.integrated-titlebar-decorum :global(button.decorum-tb-btn:hover) {
    background: color-mix(in srgb, var(--app-fg) 11%, transparent) !important;
  }

  .workspace.integrated-titlebar-decorum :global(button.decorum-tb-btn:hover::before),
  .workspace.integrated-titlebar-decorum :global(button.decorum-tb-btn:hover::after) {
    color: var(--app-fg);
  }

  .workspace.integrated-titlebar-decorum :global(button.decorum-tb-btn:active) {
    background: color-mix(in srgb, var(--app-fg) 17%, transparent) !important;
  }

  .workspace.integrated-titlebar-decorum :global(#decorum-tb-close:hover) {
    background: #c42b1c !important;
  }

  .workspace.integrated-titlebar-decorum :global(#decorum-tb-close:hover::before),
  .workspace.integrated-titlebar-decorum :global(#decorum-tb-close:hover::after) {
    color: #ffffff;
  }

  .workspace-tabbar-loading span {
    min-width: 0;
    flex: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .workspace-tabbar-loading-drag-zone {
    flex: 1 1 24px;
    min-width: 24px;
    height: 100%;
  }

  .workspace.vertical .terminal-measure-host {
    inset: 40px 208px 0 0;
  }

  .workspace.vertical.left-tabs .terminal-measure-host {
    inset: 40px 0 0 208px;
  }

  .workspace-body {
    min-width: 0;
    min-height: 0;
    position: relative;
    display: block;
    overflow: hidden;
  }

  .workspace.floating-workspace {
    grid-template-rows: minmax(0, 1fr);
  }

  .floating-window-shell {
    min-width: 0;
    min-height: 0;
    height: 100%;
    display: grid;
    grid-template-rows: 34px minmax(0, 1fr);
    overflow: hidden;
  }

  .floating-window-shell > header {
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    border-bottom: 1px solid var(--app-border);
    padding: 0 10px;
    background: color-mix(in srgb, var(--app-bg) 92%, var(--app-control));
    color: color-mix(in srgb, var(--app-fg) 72%, transparent);
    font-size: 12px;
  }

  .workspace-dock-split {
    min-width: 0;
    min-height: 0;
    width: 100%;
    height: 100%;
    display: grid;
    overflow: hidden;
  }

  .workspace-dock-split.row {
    grid-auto-flow: column;
  }

  .workspace-dock-split.column {
    grid-auto-flow: row;
  }

  .workspace-dock-resizer {
    appearance: none;
    min-width: 0;
    min-height: 0;
    border: 0;
    padding: 0;
    background: transparent;
    touch-action: none;
  }

  .workspace-dock-resizer.row {
    width: 5px;
    height: 100%;
    cursor: col-resize;
  }

  .workspace-dock-resizer.column {
    width: 100%;
    height: 5px;
    cursor: row-resize;
  }

  .workspace-dock-resizer:hover,
  .workspace-dock-resizer:focus-visible {
    background: color-mix(in srgb, var(--app-accent) 34%, transparent);
    outline: 0;
  }

  .tooltab-drop-preview {
    position: absolute;
    z-index: 60;
    box-sizing: border-box;
    border: 2px solid color-mix(in srgb, var(--app-accent) 86%, white 8%);
    border-radius: 5px;
    background:
      linear-gradient(
        135deg,
        color-mix(in srgb, var(--app-accent) 30%, transparent),
        color-mix(in srgb, var(--app-accent) 14%, transparent)
      );
    box-shadow:
      inset 0 0 0 1px color-mix(in srgb, white 32%, transparent),
      0 0 0 1px color-mix(in srgb, var(--app-accent) 34%, transparent),
      0 10px 26px color-mix(in srgb, black 18%, transparent);
    opacity: 0.96;
    pointer-events: none;
    transition:
      left 120ms cubic-bezier(0.2, 0, 0, 1),
      top 120ms cubic-bezier(0.2, 0, 0, 1),
      width 120ms cubic-bezier(0.2, 0, 0, 1),
      height 120ms cubic-bezier(0.2, 0, 0, 1),
      opacity 90ms ease;
  }

  .tooltab-drop-preview.edge {
    border-width: 3px;
    background:
      linear-gradient(
        135deg,
        color-mix(in srgb, var(--app-accent) 36%, transparent),
        color-mix(in srgb, var(--app-accent) 18%, transparent)
      );
  }

  .tooltab-drop-preview.split {
    background:
      linear-gradient(
        135deg,
        color-mix(in srgb, var(--app-accent) 28%, transparent),
        color-mix(in srgb, var(--app-control) 18%, transparent)
      );
  }

  .tooltab-drop-preview.group {
    border-style: dashed;
  }

  .tooltab-context-menu {
    position: fixed;
    z-index: 90;
    min-width: 188px;
    border: 1px solid var(--app-border);
    border-radius: 6px;
    padding: 4px;
    background: color-mix(in srgb, var(--app-bg) 95%, var(--app-control));
    box-shadow: 0 14px 36px color-mix(in srgb, black 24%, transparent);
  }

  .tooltab-context-menu button {
    width: 100%;
    display: block;
    border: 0;
    border-radius: 4px;
    padding: 6px 8px;
    background: transparent;
    color: var(--app-fg);
    font: inherit;
    font-size: 12px;
    text-align: left;
  }

  .tooltab-context-menu button:hover {
    background: var(--app-hover);
  }

  .tooltab-context-menu hr {
    height: 1px;
    border: 0;
    margin: 4px;
    background: var(--app-border);
  }

  .dock-empty {
    min-width: 0;
    min-height: 0;
    height: 100%;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 5px;
    padding: 16px;
    color: color-mix(in srgb, var(--app-fg) 58%, transparent);
    font-size: 12px;
    text-align: center;
  }

  .dock-empty strong,
  .dock-empty span {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .terminal-tool-area {
    min-width: 0;
    min-height: 0;
    height: 100%;
    display: grid;
    grid-template-rows: minmax(0, 1fr);
  }

  .content {
    min-width: 0;
    min-height: 0;
    position: relative;
    background: var(--terminal-bg);
  }

  .terminal-surface {
    position: relative;
    min-width: 0;
    min-height: 0;
    height: 100%;
    display: grid;
    grid-template-rows: minmax(0, 1fr);
    overflow: hidden;
    background: var(--terminal-bg);
  }

  .terminal-surface.mirror {
    border: 1px solid color-mix(in srgb, var(--app-accent) 58%, var(--app-border));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--app-accent) 18%, transparent);
  }

  .terminal-host {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    position: relative;
    padding: var(--terminal-padding-top) var(--terminal-padding-right) var(--terminal-padding-bottom) var(--terminal-padding-left);
    overflow: hidden;
  }

  .terminal-mount {
    position: relative;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .terminal-mirror-source,
  .terminal-too-small {
    position: absolute;
    z-index: 19;
    max-width: min(360px, calc(100% - 20px));
    border: 1px solid color-mix(in srgb, var(--app-fg) 18%, transparent);
    border-radius: 999px;
    padding: 3px 8px;
    background: color-mix(in srgb, var(--app-bg) 88%, transparent);
    color: color-mix(in srgb, var(--app-fg) 78%, transparent);
    font-size: 11px;
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    pointer-events: none;
    -webkit-backdrop-filter: blur(14px);
    backdrop-filter: blur(14px);
  }

  .terminal-mirror-source {
    top: 8px;
    left: 8px;
    border-color: color-mix(in srgb, var(--app-accent) 48%, var(--app-border));
  }

  .terminal-too-small {
    top: 50%;
    left: 50%;
    display: none;
    transform: translate(-50%, -50%);
  }

  :global(.terminal-mount[data-terminal-too-small]) {
    opacity: 0.28;
  }

  :global(.terminal-mount[data-terminal-too-small] ~ .terminal-too-small) {
    display: block;
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
    grid-template-columns: 20px minmax(0, 1fr);
    column-gap: 7px;
    row-gap: 2px;
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

  .connection-picker button > :global(.host-icon) {
    grid-row: 1 / span 2;
    align-self: center;
  }

  .connection-picker .manager-row {
    grid-template-columns: minmax(0, 1fr);
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
    .workspace.vertical .terminal-measure-host {
      inset: 40px 160px 0 0;
    }

    .workspace.vertical.left-tabs .terminal-measure-host {
      inset: 40px 0 0 160px;
    }

    .find-bar {
      left: 10px;
      right: 10px;
      grid-template-columns: minmax(0, 1fr) repeat(6, 30px);
    }
  }
</style>
