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
    type PortForwardSshVerificationRequiredEvent,
    type TabBarOrientation,
    type TerminalDetachedSessionInfo,
    type TerminalMenuStateInput,
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
  import { buildHostFolderTree, hostFolderLabel, hostHasBlockingDiagnostics, hostSubtitle, terminalAgentEnabledForHost, type HostFolderTreeNode } from "$lib/hosts/model";
  import { hasTauriRuntime } from "$lib/tauri/runtime";
  import { dockSplitGridTemplate, resizeWorkspaceDockSplit } from "$lib/workspace/dock/resize";
  import WorkspaceDockGroup from "$lib/workspace/components/WorkspaceDockGroup.svelte";
  import WorkspaceTabBar from "$lib/workspace/components/WorkspaceTabBar.svelte";
  import { createWorkspaceStore } from "$lib/workspace/state.svelte";
  import { unwrapCommand } from "$lib/terminal/commands";
  import { addNonLoopbackConfirmation } from "$lib/ports/editing";
  import FilesToolTab from "$lib/files/FilesToolTab.svelte";
  import { FILES_WORKSPACE_SSH_VERIFICATION_SUBMITTED_EVENT } from "$lib/files/workspace-verification";
  import PortsToolTab from "$lib/ports/PortsToolTab.svelte";
  import ResourceMonitorToolTab from "$lib/resources/ResourceMonitorToolTab.svelte";
  import { DEFAULT_FILES_TOOLBAR_ACTION_IDS, normalizeFilesToolbarActionIds, type FilesToolbarActionId } from "$lib/files/toolbar-actions";
  import TerminalSessionsToolTab from "$lib/terminal/TerminalSessionsToolTab.svelte";
  import TransfersToolTab from "$lib/transfers/TransfersToolTab.svelte";
  import { startTransferQueueObserver } from "$lib/transfers/queue.svelte";
  import { routeTerminalSessionEvent, shouldHandleTerminalSessionEvent } from "$lib/terminal/event-routing";
  import { isTerminalSessionInactiveMessage } from "$lib/terminal/errors";
  import { DEFAULT_TERMINAL_FONT_FAMILY } from "$lib/terminal/fonts";
  import {
    mergeAgentSessionNameFromAttachInfo,
    mergeAgentSessionNamesFromRegistryList,
  } from "$lib/terminal/session-names";
  import {
    clearTerminalFindEffects,
    terminalFindSearchKeyChanged,
    terminalFindSnapshot,
    type TerminalFindSearchKey,
    type TerminalFindSnapshot,
    type TerminalLike,
  } from "$lib/terminal/find";
  import { eventMatchesBinding, readKeybindingMap, type KeybindingMap, type TerminalCommandId } from "$lib/terminal/keybindings";
  import { syncSettingsVariables, xtermOptions } from "$lib/terminal/settings";
  import {
    createTerminalTab,
    createTerminalTabController,
    createTerminalSession,
    createTerminalTabFromSession,
    detachTerminalSession,
    disposeTerminalTab,
    disposeTerminalSession,
    measureTerminalFit,
    refreshTerminalTabTitle,
    retargetTerminalSession,
    terminalSessionById,
    type TerminalExitEvent,
    type TerminalOutputEvent,
    type TerminalSession,
    type TerminalTab,
    type TerminalTransportStateEvent,
  } from "$lib/terminal/tabs";
  import { toTerminalSessionSizeInput } from "$lib/terminal/sizes";
  import { terminalMenuCanRedo, terminalMenuCanUndo } from "$lib/terminal/menu-history";
  import { TerminalRuntimeCreationGate } from "$lib/terminal/runtime-creation";
  import { language, setLanguage, t } from "$lib/i18n";

  type StoredSession = {
    id: string;
    title: string;
    baseTitle: string;
    agentSessionName: string;
    command: string;
    currentDirectory: string;
    titleOverride: string;
    readOnly: boolean;
    agentBacked: boolean;
    agentSessionId: string;
    reconnectPending: boolean;
    everConnected: boolean;
    connectionHostId: string;
    reconnectTrust: TerminalSession["reconnectTrust"];
    status: TerminalSession["status"];
    serialized: string;
    lastCols: number;
    lastRows: number;
    lastPixelWidth: number;
    lastPixelHeight: number;
    nextOutputSequence: string;
  };

  type StoredTerminalTab = {
    workspaceId: string;
    toolTabId: string;
    session: StoredSession;
  };
  type StoredReloadTabs = {
    activeIndex: number;
    tabs: StoredTerminalTab[];
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
  const reloadTabsStorageKey = "nocturne:reload-tabs";
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
  type CloseTabAction = {
    kind: "close_tab";
    tab: TerminalTab;
    index: number;
    previousActiveId: string;
  };
  type TerminalUndoAction = CreateTabAction | CloseTabAction;
  type TerminalRedoAction = { kind: "create_tab" } | CloseTabAction;
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
  type ToolTabContextMenuDetachTarget = {
    sessionId: string;
  };
  type NocturneTestHooks = {
    openCommandPalette: () => void;
    openTerminalSessions: () => void;
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
  type ToolTabKind = WorkspaceToolTab["kind"];
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
  let agentSessionNamesById = $state(new Map<string, string>());
  let pendingTerminalRuntimeWorkspaceIds = new Set<string>();
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
  let terminalMenuUnlisten: undefined | (() => void);
  let terminalMeasureContainer: HTMLDivElement;
  let appTheme: "light" | "dark" = "light";
  let findVisible = $state(false);
  let findQuery = $state("");
  let findCaseSensitive = $state(false);
  let findRegex = $state(false);
  let findSnapshot = $state<TerminalFindSnapshot>({ activeIndex: 0, error: "", matches: [] });
  let appliedFindSearchKey: TerminalFindSearchKey | null = null;
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
  let hostSessionRetryBySessionId = $state<Record<string, HostSessionRetry>>({});
  let commandPaletteLastFocus: HTMLElement | null = null;
  let recentPaletteIds = $state<string[]>([]);
  let lastFocusedTextInput: TextInputElement | null = null;
  let serializedMenuState = "";
  let undoStack: TerminalUndoAction[] = [];
  let redoStack: TerminalRedoAction[] = [];
  let startupSessionPromise: Promise<void> | null = null;
  let detachedTerminalPaletteItems = $state<PaletteItem[]>([]);
  let terminalSessionsRevision = $state(0);
  let lastPersistedTerminalTitleByAgentSessionId = new Map<string, string>();
  const terminalRuntimeCreationGate = new TerminalRuntimeCreationGate();
  const textEditHistories = new WeakMap<TextInputElement, TextEditHistory>();
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
  let toolTabDragState = $state<{
    workspaceId: string;
    slotId: string;
    groupId: string;
    groupRole: "content" | "side_panel";
    toolTabId: string | null;
    active: boolean;
  } | null>(null);
  let toolTabDropTarget = $state<ToolTabDropTarget | null>(null);
  let activeToolSlotOverrideByGroupId = $state<Record<string, string>>({});
  let activeToolSlotOverrideRevision = $state(0);
  let suppressToolTabClickSlotId = "";
  let reloadSnapshotQueued = false;
  let loadSettingsPromise: Promise<void> | null = null;
  let loadSettingsQueued = false;
  let pageMounted = false;
  let toolTabPointerDrag = $state<{
    workspaceId: string;
    slotId: string;
    groupId: string;
    groupRole: "content" | "side_panel";
    toolTabId: string | null;
    toolKind: ToolTabKind | null;
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
    notifyTitleChange: (sessionId, title) => {
      void persistTerminalProgramTitle(sessionId, title);
    },
    notifySessionTitleRefresh: () => {
      terminalTitleRevision += 1;
    },
    requestReconnect: (sessionId) => {
      void reconnectTerminalAfterDisconnect(sessionId);
    },
  });

  $effect(() => {
    terminalRuntimeByToolTabId;
    activeTerminalToolTabId;
    activeId;
    if (pageMounted) scheduleReloadTabsSnapshot();
  });

  function publishWorkspaceDebugSnapshot(next: WorkspaceLayoutSnapshot | null) {
    if (typeof window !== "undefined") {
      Object.assign(window, {
        __NOCTURNE_WORKSPACE_DEBUG__: {
          snapshot: next,
          workspaceRenderRevision,
          activeToolSlotOverrideByGroupId,
          activeToolSlotOverrideRevision,
          activeId,
          activeTerminalToolTabId,
          terminalRuntimeToolTabIds: Array.from(terminalRuntimeByToolTabId.keys()),
          terminalRuntimeSessionIds: Array.from(terminalRuntimeByToolTabId.values()).map((runtime) => runtime.tab.session.id),
        },
      });
    }
  }

  function syncWorkspaceSnapshot(next: WorkspaceLayoutSnapshot | null) {
    if (next) pruneActiveToolSlotOverrides(next);
    workspaceViewSnapshot = next;
    workspaceRenderRevision += 1;
    publishWorkspaceDebugSnapshot(next);
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

  function scheduleReloadTabsSnapshot() {
    if (floatingWindowId || reloadSnapshotQueued) return;
    reloadSnapshotQueued = true;
    queueMicrotask(() => {
      reloadSnapshotQueued = false;
      storeReloadTabsSnapshot();
    });
  }

  async function loadSettings() {
    if (loadSettingsPromise) {
      loadSettingsQueued = true;
      return loadSettingsPromise;
    }
    loadSettingsPromise = (async () => {
      try {
        do {
          loadSettingsQueued = false;
          await loadSettingsOnce();
        } while (loadSettingsQueued);
      } finally {
        loadSettingsPromise = null;
      }
    })();
    return loadSettingsPromise;
  }

  async function loadSettingsOnce() {
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
      const session = tab.session;
      if (session.term) session.term.options = xtermOptions(next);
      terminalTabs.scheduleFit(session.id);
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
      font_family: DEFAULT_TERMINAL_FONT_FAMILY,
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

  function pruneActiveToolSlotOverrides(snapshot: WorkspaceLayoutSnapshot) {
    const nextOverrides: Record<string, string> = {};
    for (const workspace of snapshot.workspaces) collectValidActiveToolSlotOverrides(workspace.layout, nextOverrides);
    for (const window of snapshot.floating_windows) collectValidActiveToolSlotOverrides(window.layout, nextOverrides);
    const currentKeys = Object.keys(activeToolSlotOverrideByGroupId);
    const nextKeys = Object.keys(nextOverrides);
    const changed =
      currentKeys.length !== nextKeys.length ||
      nextKeys.some((key) => activeToolSlotOverrideByGroupId[key] !== nextOverrides[key]);
    if (!changed) return;
    activeToolSlotOverrideByGroupId = nextOverrides;
    activeToolSlotOverrideRevision += 1;
  }

  function collectValidActiveToolSlotOverrides(layout: WorkspaceDockLayout, target: Record<string, string>) {
    if (layout.kind === "group") {
      const override = activeToolSlotOverrideByGroupId[layout.id];
      if (override && layout.slots.some((slot) => slot.id === override)) target[layout.id] = override;
      return;
    }
    for (const child of layout.children) collectValidActiveToolSlotOverrides(child, target);
  }

  function isGroupSlotActive(layout: Extract<WorkspaceDockLayout, { kind: "group" }>, slotId: string): boolean {
    return slotId === activeGroupSlotId(layout);
  }

  function workspaceSlotToolTabId(slot: WorkspaceToolSlot): string | null {
    if (slot.kind === "closed_source") return null;
    return slot.tool_tab_id;
  }

  function dockGroupRole(group: Extract<WorkspaceDockLayout, { kind: "group" }>): "content" | "side_panel" {
    if (group.role === "content" || group.role === "side_panel") return group.role;
    throw new Error(`dock group ${group.id} has unsupported role ${group.role}`);
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

  function edgeToolTabbarPlacement(bounds: DockGroupBounds): ToolTabbarPlacement {
    if (bounds.bottom && !bounds.top) return "bottom";
    if (bounds.left && !bounds.right) return "left";
    if (bounds.right && !bounds.left) return "right";
    return "top";
  }

  function toolTabbarPlacement(
    group: Extract<WorkspaceDockLayout, { kind: "group" }>,
    bounds: DockGroupBounds,
  ): ToolTabbarPlacement {
    if (dockGroupRole(group) === "content") return "top";
    return edgeToolTabbarPlacement(bounds);
  }

  function visualDockGroupRole(group: Extract<WorkspaceDockLayout, { kind: "group" }>) {
    return dockGroupRole(group);
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
      return layout.slots.some((slot) => slot.id === slotId) ? { ...layout, active_slot_id: slotId, collapsed: false } : layout;
    }
    return { ...layout, children: layout.children.map((child) => activateWorkspaceLayoutSlot(child, slotId)) };
  }

  function setWorkspaceDockGroupCollapsed(
    layout: WorkspaceDockLayout,
    groupId: string,
    collapsed: boolean,
  ): WorkspaceDockLayout {
    if (layout.kind === "group") {
      return layout.id === groupId ? { ...layout, collapsed } : layout;
    }
    return {
      ...layout,
      children: layout.children.map((child) => setWorkspaceDockGroupCollapsed(child, groupId, collapsed)),
    };
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

  function activeDisplaySlotForToolTab(layout: WorkspaceDockLayout, toolTabId: string): WorkspaceToolSlot | null {
    if (layout.kind === "group") {
      const active = activeGroupSlot(layout);
      if (active && active.kind !== "closed_source" && active.tool_tab_id === toolTabId) return active;
      return layout.slots.find((slot) => slot.kind !== "closed_source" && slot.tool_tab_id === toolTabId) ?? null;
    }
    return layout.children
      .map((child) => activeDisplaySlotForToolTab(child, toolTabId))
      .find((slot): slot is WorkspaceToolSlot => slot !== null) ?? null;
  }

  function terminalRuntimeForToolTab(toolTabId: string): TerminalToolRuntime | null {
    return terminalRuntimeByToolTabId.get(toolTabId) ?? null;
  }

  function setTerminalRuntime(toolTabId: string, runtime: TerminalToolRuntime) {
    applyAgentSessionNameToTerminal(runtime.tab);
    const next = new Map(terminalRuntimeByToolTabId);
    next.set(toolTabId, runtime);
    terminalRuntimeByToolTabId = next;
    syncLegacyTerminalTabState();
    scheduleReloadTabsSnapshot();
    publishWorkspaceDebugSnapshot(workspaceSnapshot);
  }

  function deleteTerminalRuntime(toolTabId: string) {
    const next = new Map(terminalRuntimeByToolTabId);
    next.delete(toolTabId);
    terminalRuntimeByToolTabId = next;
    syncLegacyTerminalTabState();
    scheduleReloadTabsSnapshot();
    publishWorkspaceDebugSnapshot(workspaceSnapshot);
  }

  function syncLegacyTerminalTabState() {
    tabs = terminalRuntimeTabs();
    activeId = activeTerminalToolTabId;
    scheduleReloadTabsSnapshot();
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

  function slotToolTooltip(slot: WorkspaceToolSlot) {
    if (slot.kind === "closed_source") return `${slot.previous_title}\nSource workspace: ${slot.owner_workspace_title}`;
    if (slot.kind === "floating_placeholder") {
      const tool = slotTool(slot);
      return `${tool?.title ?? "ToolTab"}\nShown in floating window`;
    }
    const tool = slotTool(slot);
    if (!tool) return "Missing ToolTab";
    if (tool.kind !== "terminal") return toolTabDisplayTitle(tool);
    const runtime = terminalRuntimeForToolTab(tool.id);
    if (!runtime) return tool.title;
    return terminalSessionTooltip(runtime.tab.session, terminalRuntimeTitleForToolTab(tool.id) ?? tool.title);
  }

  function toolTabDisplayTitle(tool: WorkspaceToolTab) {
    if (tool.kind !== "terminal") return tool.title;
    return terminalRuntimeTitleForToolTab(tool.id) ?? tool.title;
  }

  function terminalSessionTooltip(session: TerminalSession, displayTitle: string) {
    const registryTitle = session.agentSessionName.trim();
    const lines = [registryTitle || displayTitle.trim() || "Terminal"];
    const cwd = session.currentDirectory.trim();
    const command = session.command.trim();
    if (displayTitle.trim() && displayTitle.trim() !== lines[0]) lines.push(displayTitle.trim());
    if (cwd && cwd !== lines[0] && cwd !== displayTitle.trim()) lines.push(cwd);
    if (command) lines.push(`Command: ${command}`);
    return lines.join("\n");
  }

  function terminalRuntimeTitleForToolTab(toolTabId: string) {
    terminalTitleRevision;
    const runtime = terminalRuntimeForToolTab(toolTabId);
    const title = runtime?.tab.title.trim() ?? "";
    return title.length > 0 ? title : null;
  }

  function updateAgentSessionNamesFromDetachedSessions(sessions: TerminalDetachedSessionInfo[]) {
    const next = mergeAgentSessionNamesFromRegistryList(agentSessionNamesById, sessions);
    const changed = next !== agentSessionNamesById;
    if (!changed) return;
    agentSessionNamesById = next;
    applyAgentSessionNamesToOpenTerminals();
  }

  function updateAgentSessionNameFromInfo(info: TerminalSessionInfo) {
    const next = mergeAgentSessionNameFromAttachInfo(agentSessionNamesById, info);
    if (next === agentSessionNamesById) return;
    agentSessionNamesById = next;
  }

  function applyAgentSessionNamesToOpenTerminals() {
    let changed = false;
    for (const runtime of terminalRuntimeByToolTabId.values()) {
      if (applyAgentSessionNameToTerminal(runtime.tab)) changed = true;
    }
    if (!changed) return;
    terminalTitleRevision += 1;
    scheduleReloadTabsSnapshot();
    publishWorkspaceDebugSnapshot(workspaceSnapshot);
  }

  function applyAgentSessionNameToTerminal(tab: TerminalTab) {
    const session = tab.session;
    if (!session.agentBacked || !session.agentSessionId) return false;
    const name = agentSessionNamesById.get(session.agentSessionId)?.trim() ?? session.agentSessionName.trim();
    if (!name || session.agentSessionName === name) return false;
    session.agentSessionName = name;
    refreshTerminalTabTitle(tab);
    return true;
  }

  function terminalSessionIdForToolTab(tool: WorkspaceToolTab | string | null): string | undefined {
    if (!tool) return undefined;
    if (typeof tool === "string") return terminalRuntimeForToolTab(tool)?.tab.session.id;
    return tool.kind === "terminal" ? terminalRuntimeForToolTab(tool.id)?.tab.session.id : undefined;
  }

  function ownerWorkspaceTitle(slot: WorkspaceToolSlot) {
    if (slot.kind === "closed_source") return slot.owner_workspace_title;
    if (slot.kind !== "mirror") return "";
    return workspaceById(slot.owner_workspace_id)?.title ?? "Closed workspace";
  }

  function splitStyle(layout: Extract<WorkspaceDockLayout, { kind: "split" }>, bounds: DockGroupBounds) {
    const collapsedTracks = layout.children.map((child, index) => {
      if (child.kind !== "group" || child.collapsed !== true) return null;
      const placement = toolTabbarPlacement(child, childDockGroupBounds(bounds, layout.direction, index, layout.children.length));
      if (placement === "left" || placement === "right") return "32px";
      if (placement === "bottom") return "31px";
      return null;
    });
    const resizableBoundaries = layout.children.slice(0, -1).map((_, index) => splitBoundaryResizable(layout, index));
    if (collapsedTracks.every((track) => track === null)) {
      return dockSplitGridTemplateWithResizableBoundaries(layout.direction, layout.children.length, layout.ratios, resizableBoundaries);
    }
    return dockSplitGridTemplateWithFixedTracks(layout.direction, layout.children.length, layout.ratios, collapsedTracks, resizableBoundaries);
  }

  function dockSplitGridTemplateWithFixedTracks(
    direction: "row" | "column",
    childCount: number,
    ratios: readonly (number | null)[],
    fixedTracks: readonly (string | null)[],
    resizableBoundaries: readonly boolean[],
    splitterPixels = 5,
  ): string {
    const normalized = normalizedDockRatios(childCount, ratios);
    const flexibleTotal = normalized.reduce((sum, ratio, index) => fixedTracks[index] === null ? sum + ratio : sum, 0);
    const tracks = normalized.flatMap((ratio, index) => {
      const fixedTrack = fixedTracks[index];
      const flexibleRatio = flexibleTotal > 0 ? ratio / flexibleTotal : 1;
      const track = fixedTrack ?? `minmax(0, ${Math.max(0.08, flexibleRatio)}fr)`;
      return index === normalized.length - 1 || !resizableBoundaries[index] ? [track] : [track, `${splitterPixels}px`];
    });
    return direction === "row" ? `grid-template-columns: ${tracks.join(" ")};` : `grid-template-rows: ${tracks.join(" ")};`;
  }

  function dockSplitGridTemplateWithResizableBoundaries(
    direction: "row" | "column",
    childCount: number,
    ratios: readonly (number | null)[],
    resizableBoundaries: readonly boolean[],
    splitterPixels = 5,
  ): string {
    const normalized = normalizedDockRatios(childCount, ratios);
    const tracks = normalized.flatMap((ratio, index) => {
      const track = `minmax(0, ${Math.max(0.08, ratio)}fr)`;
      return index === normalized.length - 1 || !resizableBoundaries[index] ? [track] : [track, `${splitterPixels}px`];
    });
    return direction === "row" ? `grid-template-columns: ${tracks.join(" ")};` : `grid-template-rows: ${tracks.join(" ")};`;
  }

  function splitBoundaryResizable(layout: Extract<WorkspaceDockLayout, { kind: "split" }>, index: number) {
    return !dockChildCollapsed(layout.children[index]) && !dockChildCollapsed(layout.children[index + 1]);
  }

  function dockChildCollapsed(layout: WorkspaceDockLayout | undefined) {
    return layout?.kind === "group" && layout.collapsed === true;
  }

  function normalizedDockRatios(length: number, values: readonly (number | null)[]): number[] {
    const fallback = Array.from({ length }, () => 1 / Math.max(1, length));
    if (values.length !== length) return fallback;
    const numeric = values.map((value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0));
    const total = numeric.reduce((sum, value) => sum + value, 0);
    if (total <= 0) return fallback;
    return numeric.map((value) => value / total);
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

  async function setDockGroupCollapsed(workspace: WorkspaceTabState, groupId: string, collapsed: boolean) {
    const previousLayout = workspace.layout;
    replaceWorkspaceLayoutSnapshot(
      workspace.id,
      setWorkspaceDockGroupCollapsed(workspace.layout, groupId, collapsed),
    );
    try {
      const next = await dispatchWorkspaceIntent({
        kind: "set_dock_group_collapsed",
        workspace_id: workspace.id,
        group_id: groupId,
        collapsed,
      });
      replaceWorkspaceSnapshot(next);
    } catch (error) {
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
    const session = runtime.tab.session;
    if (session.status === "running" && shouldConfirmTerminalClose()) {
      const confirmed = await ask(`Close terminal session ${session.title}?`, {
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
    const session = runtime.tab.session;
    const shouldCloseSession = session.status === "running";
    disposeTerminalSession(session);
    if (activeTerminalToolTabId === toolTabId) activeTerminalToolTabId = "";
    deleteTerminalRuntime(toolTabId);
    if (shouldCloseSession) await closeTerminalSession(session);
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

  function toolTabContextMenuDetachTarget(menu: ToolTabContextMenu): ToolTabContextMenuDetachTarget | null {
    const workspace = workspaceById(menu.workspaceId);
    if (!workspace) return null;
    const slot = findWorkspaceSlot(workspace.layout, menu.slotId);
    if (!slot || slot.kind !== "owned") return null;
    const tool = terminalToolTabForSlot(slot);
    if (!tool || tool.kind !== "terminal") return null;
    const session = terminalRuntimeForToolTab(tool.id)?.tab.session;
    if (!session || !session.agentBacked || session.status !== "running") return null;
    return { sessionId: session.id };
  }

  async function detachToolTabContextMenu(menu: ToolTabContextMenu) {
    const target = toolTabContextMenuDetachTarget(menu);
    if (!target) return;
    await detachTerminalSessionView(target.sessionId);
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

  function activeWorkspaceHost() {
    const workspace = activeWorkspace;
    if (!workspace) return null;
    return lastConfigSnapshot?.hosts.find((host) => host.id === workspace.host_id) ?? null;
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
    }
    const session = tab.session;
    session.tabId = toolTabId || session.tabId;
    session.connectionHostId = connectionHostId;
    session.reconnectTrust = {
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
    scheduleReloadTabsSnapshot();
    hostSessionRetryBySessionId = {
      ...hostSessionRetryBySessionId,
      [session.id]: {
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
      await mountTerminalWhenReady(session.id);
      await flushTerminalOutputBacklog(session.id);
      session.term?.focus();
      if (recordHistory && !toolTabId) {
        pushUndoAction({ kind: "create_tab", tabId: tab.id });
      } else {
        syncTerminalMenuState();
      }
    } catch (error) {
      terminalTabs.markConnectionError(session.id, error instanceof Error ? error.message : String(error));
    }
  }

  async function reconnectHostSession(
    sessionId: string,
    connectionHostId: string,
    trust: {
      acceptNewHostKey?: boolean;
      updateChangedHostKey?: boolean;
      credential?: { kind: SshCredentialKind; value: string };
      saveCredential?: boolean;
    },
  ) {
    const tab = findTabBySessionId(sessionId);
    const session = terminalSessionById(tab, sessionId);
    if (!session) throw new Error(`session ${sessionId} not found`);
    const toolTabId = session.tabId || tab.id;
    const tool = workspaceToolById(toolTabId);
    if (!tool) throw new Error(`terminal ToolTab ${toolTabId} not found`);
    const workspaceId = tool.owner_workspace_id;
    if (!settings) await loadSettings();
    await tick();
    const info = await unwrapCommand(
      commands.createHostTerminalSession({
        ...measureNewTerminal(session.currentDirectory.trim() || null),
        workspace_id: workspaceId,
        tool_tab_id: toolTabId,
        accept_new_host_key: trust.acceptNewHostKey === true,
        update_changed_host_key: trust.updateChangedHostKey === true,
        credential: trust.credential ?? null,
        save_credential: trust.saveCredential === true,
      }),
    );
    retargetTerminalSession(session, info);
    if (session.agentBacked) terminalSessionsRevision += 1;
    session.connectionHostId = connectionHostId;
    session.reconnectTrust = {
      acceptNewHostKey: trust.acceptNewHostKey,
      updateChangedHostKey: trust.updateChangedHostKey,
    };
    refreshTerminalTabTitle(tab);
    activeId = tab.id;
    hostSessionRetryBySessionId = {
      ...hostSessionRetryBySessionId,
      [session.id]: {
        connectionHostId,
        workspaceId,
        toolTabId,
        acceptNewHostKey: trust.acceptNewHostKey,
        updateChangedHostKey: trust.updateChangedHostKey,
      },
    };
    await tick();
    await mountTerminalWhenReady(session.id);
    await flushTerminalOutputBacklog(session.id);
    terminalTabs.scheduleFit(session.id);
    session.term?.focus();
    syncTerminalMenuState();
  }

  async function reconnectTerminalAfterDisconnect(sessionId: string) {
    const tab = findTabBySessionId(sessionId);
    const session = terminalSessionById(tab, sessionId);
    if (!session) return;
    if (!session.connectionHostId) {
      terminalTabs.markReconnectUnavailable(sessionId, "This terminal session has no host metadata for reconnect.");
      return;
    }
    try {
      await reconnectHostSession(sessionId, session.connectionHostId, session.reconnectTrust);
    } catch (error) {
      terminalTabs.markReconnectUnavailable(sessionId, error instanceof Error ? error.message : String(error));
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

  async function createEmptyTerminalToolTabForWorkspace(workspaceId: string) {
    const workspace = workspaceById(workspaceId);
    if (!workspace) throw new Error("target workspace is not loaded");
    const targetGroupId =
      lastActivatedContentGroupIdByWorkspace.get(workspace.id) ?? firstContentGroupId(workspace);
    const before = new Set(
      (workspaceSnapshot?.tool_tabs ?? [])
        .filter((tool) => tool.owner_workspace_id === workspace.id && tool.kind === "terminal")
        .map((tool) => tool.id),
    );
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
    return tool;
  }

  function bindTerminalSessionToToolTab(tool: WorkspaceToolTab, info: TerminalSessionInfo) {
    updateAgentSessionNameFromInfo(info);
    const tab = createTerminalTab(info);
    tab.id = tool.id;
    tab.session.tabId = tool.id;
    setTerminalRuntime(tool.id, { toolTabId: tool.id, tab });
    activeTerminalToolTabId = tool.id;
    activeId = tool.id;
    scheduleReloadTabsSnapshot();
    return tab;
  }

  async function createEmptyTerminalToolTabForActiveWorkspace() {
    const workspace = activeWorkspace;
    if (!workspace) throw new Error("active workspace is not loaded");
    return createEmptyTerminalToolTabForWorkspace(workspace.id);
  }

  function detachedTerminalSourceTool(sourceToolTabId: string | null = null) {
    const toolTabId = sourceToolTabId ?? activeTerminalToolTabId;
    const tool = toolTabId ? workspaceToolById(toolTabId) : null;
    if (!tool || (tool.kind !== "terminal" && tool.kind !== "terminal_sessions")) {
      throw new Error("Terminal or Terminal Sessions ToolTab is required");
    }
    return tool;
  }

  async function attachDetachedTerminalSession(detachedSessionId: string, sourceToolTabId: string | null = null) {
    if (!hasTauriRuntime()) return;
    const sourceTool = detachedTerminalSourceTool(sourceToolTabId);
    pendingTerminalRuntimeWorkspaceIds.add(sourceTool.owner_workspace_id);
    try {
      const info = await unwrapCommand(
        commands.attachDetachedTerminalSession({
          workspace_id: sourceTool.owner_workspace_id,
          tool_tab_id: sourceTool.id,
          detached_session_id: detachedSessionId,
          window_label: currentWindowLabel(),
        }),
      );
      const tool = await createEmptyTerminalToolTabForWorkspace(sourceTool.owner_workspace_id);
      const tab = bindTerminalSessionToToolTab(tool, info);
      tab.session.connectionHostId = tool.host_id;
      await tick();
      await mountTerminalToolTab(tool.id);
      await flushTerminalOutputBacklog(tab.session.id);
      tab.session.term?.focus();
      detachedTerminalPaletteItems = detachedTerminalPaletteItems.filter(
        (item) => item.id !== `terminal.attachDetached:${detachedSessionId}`,
      );
      terminalSessionsRevision += 1;
      await refreshDetachedTerminalPaletteItems();
      syncTerminalMenuState();
    } finally {
      pendingTerminalRuntimeWorkspaceIds.delete(sourceTool.owner_workspace_id);
    }
  }

  async function openDetachedTerminalSessionHistory(detachedSessionId: string, sourceToolTabId: string | null = null) {
    if (!hasTauriRuntime()) return;
    const sourceTool = detachedTerminalSourceTool(sourceToolTabId);
    pendingTerminalRuntimeWorkspaceIds.add(sourceTool.owner_workspace_id);
    try {
      const info = await unwrapCommand(
        commands.openDetachedTerminalSessionHistory({
          workspace_id: sourceTool.owner_workspace_id,
          tool_tab_id: sourceTool.id,
          detached_session_id: detachedSessionId,
          window_label: currentWindowLabel(),
        }),
      );
      const tool = await createEmptyTerminalToolTabForWorkspace(sourceTool.owner_workspace_id);
      const tab = bindTerminalSessionToToolTab(tool, info);
      tab.session.connectionHostId = tool.host_id;
      tab.session.readOnly = true;
      tab.session.status = "disconnected";
      tab.session.reconnectPending = false;
      tab.session.exitText = "History";
      await tick();
      await mountTerminalToolTab(tool.id);
      await flushTerminalOutputBacklog(tab.session.id);
      tab.session.term?.focus();
      terminalSessionsRevision += 1;
      await refreshDetachedTerminalPaletteItems();
      syncTerminalMenuState();
    } finally {
      pendingTerminalRuntimeWorkspaceIds.delete(sourceTool.owner_workspace_id);
    }
  }

  async function deleteDetachedTerminalSession(detachedSessionId: string, sourceToolTabId: string | null = null) {
    if (!hasTauriRuntime()) return;
    const toolTabId = sourceToolTabId ?? activeTerminalToolTabId;
    const tool = toolTabId ? workspaceToolById(toolTabId) : null;
    if (!tool || (tool.kind !== "terminal" && tool.kind !== "terminal_sessions")) throw new Error("active Terminal ToolTab is required");
    const confirmed = await ask("Delete this terminal session and its saved transcript?", {
      title: "Delete Terminal Session",
      kind: "warning",
      okLabel: "Delete",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;
    await unwrapCommand(
      commands.deleteDetachedTerminalSession({
        workspace_id: tool.owner_workspace_id,
        tool_tab_id: tool.id,
        detached_session_id: detachedSessionId,
      }),
    );
    detachedTerminalPaletteItems = detachedTerminalPaletteItems.filter(
      (item) =>
        item.id !== `terminal.attachDetached:${detachedSessionId}` &&
        item.id !== `terminal.deleteDetached:${detachedSessionId}`,
    );
    terminalSessionsRevision += 1;
    await refreshDetachedTerminalPaletteItems();
    syncTerminalMenuState();
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

  async function openWorkspaceTerminalSessions() {
    const workspace = activeWorkspace;
    if (!workspace) throw new Error("active workspace is not loaded");
    if (!terminalAgentEnabledForHost(activeWorkspaceHost())) {
      throw new Error("terminal agent mode is disabled for this host");
    }
    await dispatchWorkspaceIntent({
      kind: "open_terminal_sessions_tool_tab",
      workspace_id: workspace.id,
      target_group_id: firstToolGroupId(workspace),
    });
  }

  function publishTestHooks() {
    if (!import.meta.env.DEV || typeof window === "undefined") return;
    (window as Window & { __NOCTURNE_TEST_HOOKS__?: NocturneTestHooks }).__NOCTURNE_TEST_HOOKS__ = {
      openCommandPalette,
      openTerminalSessions: () => {
        void openWorkspaceTerminalSessions();
      },
    };
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
    const requiresConfirmation = await unwrapCommand(commands.hostPortForwardCloseRequiresConfirmationCommand(workspace.host_id));
    if (!requiresConfirmation) return true;
    const confirmed = await ask(
      "Close this workspace and stop active port forwards?",
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
    const hostIds = Array.from(new Set(snapshot.tool_tabs
      .filter((tool) => tool.kind === "ports")
      .map((tool) => tool.host_id)));
    for (const hostId of hostIds) {
      const host = lastConfigSnapshot?.hosts.find((item) => item.id === hostId);
      if (host?.document.protocol !== "ssh") continue;
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
    if (pendingTerminalRuntimeWorkspaceIds.has(workspace.id)) return;
    return terminalTools.length > 0 && terminalTools.every((tool) => terminalRuntimeByToolTabId.has(tool.id));
  }

  async function ensureWorkspaceTerminalRuntimes() {
    const workspace = activeWorkspace;
    if (!workspace) return;
    if (pendingTerminalRuntimeWorkspaceIds.has(workspace.id)) return;
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

  async function flushTerminalOutputBacklog(sessionId: string) {
    if (!hasTauriRuntime()) return;
    if (!hasLocalTerminalSession(sessionId)) return;
    let event: TerminalOutputEvent | null;
    try {
      event = await unwrapCommand(commands.takeTerminalOutputBacklog({ session_id: sessionId }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isTerminalSessionInactiveMessage(message)) {
        terminalTabs.markConnectionError(sessionId, message);
        return;
      }
      throw error;
    }
    if (event) enqueueTerminalOutput(event);
  }

  function enqueueTerminalOutput(event: TerminalOutputEvent) {
    if (
      !routeTerminalSessionEvent(event.session_id, localTerminalSessionIds(), () => {
        terminalTabs.enqueueOutput(event);
      })
    ) {
      return;
    }
    if (event.session_id !== activeSession()?.id || !findVisible) return;
    window.requestAnimationFrame(() => {
      updateFindSnapshot();
      syncTerminalMenuState();
    });
  }

  function activeSession(): TerminalSession | null {
    const runtime = activeTerminalRuntime();
    const tab = runtime?.tab ?? activeTab;
    if (!tab) return null;
    return tab.session;
  }

  function shouldConfirmTerminalClose() {
    if (!lastConfigSnapshot) return true;
    return booleanValue(readValue(lastConfigSnapshot.effective_config.root, ["terminal", "confirm_close"])) ?? true;
  }

  async function activateTab(id: string) {
    activeId = id;
    scheduleReloadTabsSnapshot();
    const tab = tabs.find((item) => item.id === id);
    if (!tab) return;
    await tick();
    await mountAndFitTab(tab);
    tab.session.term?.focus();
    refreshFindForActiveSession();
    syncTerminalMenuState();
  }

  async function mountAndFitTab(tab: TerminalTab) {
    await tick();
    await mountTerminalWhenReady(tab.session.id);
    await flushTerminalOutputBacklog(tab.session.id);
    terminalTabs.scheduleFit(tab.session.id);
  }

  async function closeTab(id: string, { recordHistory = false }: { recordHistory?: boolean } = {}) {
    const tab = tabs.find((item) => item.id === id);
    if (!tab) return;
    const shouldClose = await confirmRunningSession(tab.session);
    if (!shouldClose) return;
    const index = tabs.findIndex((item) => item.id === id);
    const previousActiveId = activeId;
    if (recordHistory) {
      detachTerminalSession(tab.session);
      pushUndoAction({ kind: "close_tab", tab, index, previousActiveId });
    } else {
      disposeTerminalSession(tab.session);
      if (tab.session.status === "running") await closeTerminalSession(tab.session);
    }
    tabs = tabs.filter((item) => item.id !== id);
    if (activeId === id) {
      activeId = tabs[Math.max(0, index - 1)]?.id ?? tabs[0]?.id ?? "";
      if (activeId) await activateTab(activeId);
    }
    scheduleReloadTabsSnapshot();
    syncTerminalMenuState();
  }

  async function closeActiveTarget() {
    const tab = activeTab;
    if (!tab) {
      await closeCurrentWindow();
      return;
    }
    await closeTab(tab.id, { recordHistory: true });
  }

  async function closeCurrentWindow() {
    if (hasTauriRuntime()) {
      await getCurrentWindow().close();
    }
  }

  function findLocalTabBySessionId(sessionId: string): TerminalTab | null {
    return (
      terminalRuntimeTabs().find((item) => item.session.id === sessionId || item.id === sessionId) ??
      tabs.find((item) => item.session.id === sessionId || item.id === sessionId) ??
      null
    );
  }

  function findTabBySessionId(sessionId: string): TerminalTab {
    const tab = findLocalTabBySessionId(sessionId);
    if (!tab) throw new Error(`tab for terminal ${sessionId} not found`);
    return tab;
  }

  function findLocalSessionById(sessionId: string): TerminalSession | null {
    const tab = findLocalTabBySessionId(sessionId);
    return tab ? (terminalSessionById(tab, sessionId) ?? null) : null;
  }

  function localTerminalSessionIds() {
    return terminalRuntimeTabs().map((tab) => tab.session.id);
  }

  function hasLocalTerminalSession(sessionId: string) {
    return shouldHandleTerminalSessionEvent(sessionId, localTerminalSessionIds());
  }

  async function closeTerminalSessionAtView(sessionId: string, { recordHistory = false }: { recordHistory?: boolean } = {}) {
    const tab = findTabBySessionId(sessionId);
    const session = terminalSessionById(tab, sessionId);
    if (!session) return;
    const shouldClose = await confirmRunningSession(session);
    if (!shouldClose) return;
    if (recordHistory) {
      detachTerminalSession(session);
    } else {
      disposeTerminalSession(session);
      if (session.status === "running") await closeTerminalSession(session);
    }
    refreshTerminalTabTitle(tab);
    if (recordHistory) {
      pushUndoAction({ kind: "close_tab", tab, index: tabs.indexOf(tab), previousActiveId: activeId });
    } else {
      syncTerminalMenuState();
    }
  }

  async function detachTerminalSessionView(sessionId: string) {
    const tab = findTabBySessionId(sessionId);
    const session = terminalSessionById(tab, sessionId);
    if (!session) return;
    if (!session.agentBacked || session.status !== "running") {
      terminalTabs.markConnectionError(sessionId, "Only running Terminal Agent sessions can be detached.");
      return;
    }
    try {
      await unwrapCommand(commands.detachTerminalSession({ session_id: sessionId }));
    } catch (error) {
      terminalTabs.markConnectionError(sessionId, error instanceof Error ? error.message : String(error));
      return;
    }
    terminalSessionsRevision += 1;
    disposeTerminalSession(session);
    hostSessionRetryBySessionId = Object.fromEntries(
      Object.entries(hostSessionRetryBySessionId).filter(([id]) => id !== sessionId),
    );
    refreshTerminalTabTitle(tab);
    syncTerminalMenuState();
  }

  async function confirmRunningSession(session: TerminalSession) {
    if (session.status !== "running") return true;
    if (!shouldConfirmTerminalClose()) return true;
    if (!hasTauriRuntime()) return window.confirm("Close running terminal session?");
    return ask("Close running terminal session?", {
      title: "Close Terminal",
      kind: "warning",
      okLabel: "Close",
      cancelLabel: "Cancel",
    });
  }

  async function closeTerminalSession(session: TerminalSession) {
    try {
      await unwrapCommand(commands.closeTerminalSession(session.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isTerminalSessionInactiveMessage(message) || message.includes("The operation completed successfully") || message.includes("os error 0")) {
        return;
      }
      terminalTabs.markConnectionError(session.id, message);
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
      if (action.tab.session.status === "running") await closeTerminalSession(action.tab.session);
    }
  }

  async function applyTerminalUndo(action: TerminalUndoAction): Promise<TerminalRedoAction> {
    if (action.kind === "create_tab") {
      await closeCreatedTabForUndo(action.tabId);
      return { kind: "create_tab" };
    }
    if (action.kind === "close_tab") {
      await restoreClosedTab(action);
      return action;
    }
    return action;
  }

  async function applyTerminalRedo(action: TerminalRedoAction): Promise<TerminalUndoAction> {
    if (action.kind === "create_tab") {
      return restoreCreatedTabForRedo();
    }
    if (action.kind === "close_tab") {
      await closeRestoredTabForRedo(action.tab.id);
      return action;
    }
    return action;
  }

  async function closeCreatedTabForUndo(tabId: string) {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) return;
    disposeTerminalSession(tab.session);
    if (tab.session.status === "running") await closeTerminalSession(tab.session);
    tabs = tabs.filter((item) => item.id !== tab.id);
    if (activeId === tab.id) {
      activeId = tabs.at(-1)?.id ?? "";
      if (activeId) await activateTab(activeId);
    }
    scheduleReloadTabsSnapshot();
  }

  async function restoreCreatedTabForRedo(): Promise<TerminalUndoAction> {
    await openWorkspaceTerminalSession({ recordHistory: false });
    const tab = tabs.find((item) => item.id === activeId);
    if (!tab) throw new Error("redo did not create a terminal tab");
    return { kind: "create_tab", tabId: tab.id };
  }

  async function restoreClosedTab(action: Extract<TerminalUndoAction, { kind: "close_tab" }>) {
    tabs = [...tabs.slice(0, action.index), action.tab, ...tabs.slice(action.index)];
    activeId = action.tab.id;
    scheduleReloadTabsSnapshot();
    await tick();
    await mountAndFitTab(action.tab);
    action.tab.session.term?.focus();
  }

  async function closeRestoredTabForRedo(tabId: string) {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) return;
    detachTerminalSession(tab.session);
    tabs = tabs.filter((item) => item.id !== tabId);
    if (activeId === tabId) {
      activeId = tabs.at(-1)?.id ?? "";
      if (activeId) await activateTab(activeId);
    }
    scheduleReloadTabsSnapshot();
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
    updatePointerDrag(event);
  }

  function updatePointerDrag(_event: PointerEvent) {
    return;
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
  }

  function handlePointerCancel(event: PointerEvent) {
    if (dockResizeDrag?.pointerId === event.pointerId) dockResizeDrag = null;
    if (toolTabPointerDrag?.pointerId === event.pointerId) cancelToolTabDragInteraction();
  }

  function startTabPointerDrag(event: PointerEvent, tabId: string) {
    startPointerDrag(event, "tab", tabId);
  }

  function startPointerDrag(_event: PointerEvent, _kind: "tab", _tabId: string) {
    return;
  }

  function startToolTabPointerDrag(event: PointerEvent, workspace: WorkspaceTabState, slot: WorkspaceToolSlot) {
    if (event.button !== 0) return;
    if (slot.kind === "closed_source" || slot.kind === "floating_placeholder") return;
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const group = findWorkspaceGroupContainingSlot(workspace.layout, slot.id);
    if (!group) throw new Error(`dock group for tool slot ${slot.id} not found`);
    toolTabPointerDrag = {
      workspaceId: workspace.id,
      slotId: slot.id,
      groupId: group.id,
      groupRole: dockGroupRole(group),
      toolTabId: slot.tool_tab_id,
      toolKind: slot.tool_tab_id ? workspaceSnapshot?.tool_tabs.find((tool) => tool.id === slot.tool_tab_id)?.kind ?? null : null,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      target,
    };
    target.setPointerCapture(event.pointerId);
  }

  function cancelToolTabDragInteraction() {
    toolTabPointerDrag = null;
    toolTabDragState = null;
    toolTabDropTarget = null;
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
        groupId: drag.groupId,
        groupRole: drag.groupRole,
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

  async function finishToolTabPointerDrag(event: PointerEvent) {
    const drag = toolTabPointerDrag;
    toolTabPointerDrag = null;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const target = toolTabDropTargetFromPoint(event.clientX, event.clientY, drag);
    const wasActive = drag.active;
    toolTabDragState = null;
    toolTabDropTarget = null;
    if (wasActive) {
      suppressToolTabClickSlotId = drag.slotId;
      window.setTimeout(() => {
        if (suppressToolTabClickSlotId === drag.slotId) suppressToolTabClickSlotId = "";
      }, 250);
    }
    if (!wasActive || !target) return;
    try {
      await applyToolTabDrop(drag, target);
    } catch (error) {
      settingsError = error instanceof Error ? error.message : String(error);
    }
  }

  function handleClick(event: MouseEvent) {
    if (!suppressToolTabClickSlotId) return;
    const slot = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-tool-slot-id]") : null;
    if (slot?.dataset.toolSlotId !== suppressToolTabClickSlotId) return;
    suppressToolTabClickSlotId = "";
    event.preventDefault();
    event.stopPropagation();
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

    const collapsedGroupTarget = toolTabCollapsedGroupDropTargetFromPoint(x, y);
    if (collapsedGroupTarget) return collapsedGroupTarget;

    const dockGroups = [...document.querySelectorAll<HTMLElement>("[data-dock-group-id]")];
    const containingGroup = dockGroups
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
      .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0];
    if (containingGroup) {
      const targetWorkspaceId = containingGroup.element.dataset.workspaceId;
      const groupId = containingGroup.element.dataset.dockGroupId;
      if (!targetWorkspaceId || !groupId) return null;
      const workspaceEdgeTarget = toolTabWorkspaceEdgeDropTargetFromPoint(x, y, targetWorkspaceId, workspaceEdgeInnerBand());
      if (workspaceEdgeTarget) return workspaceEdgeTarget;
      const sidePanelRestoreTarget = toolTabSidePanelRestoreDropTargetFromPoint(
        x,
        y,
        targetWorkspaceId,
        containingGroup.element,
        containingGroup.rect,
        drag.toolKind,
        drag.slotId,
        drag.groupId,
        drag.groupRole,
      );
      if (sidePanelRestoreTarget) return sidePanelRestoreTarget;
      const groupEdgeTarget = toolTabGroupEdgeDropTargetFromPoint(x, y, containingGroup.element, containingGroup.rect, drag.slotId);
      if (groupEdgeTarget) return groupEdgeTarget;
      const slotTarget = toolTabSlotDropTargetFromPoint(x, y, targetWorkspaceId, drag.slotId);
      if (slotTarget) return slotTarget;
      const broadWorkspaceEdgeTarget = toolTabWorkspaceEdgeDropTargetFromPoint(x, y, targetWorkspaceId);
      if (broadWorkspaceEdgeTarget) return broadWorkspaceEdgeTarget;
      return { kind: "group", workspaceId: targetWorkspaceId, groupId };
    }

    const workspaceEdgeTarget = toolTabWorkspaceEdgeDropTargetFromPoint(x, y, drag.workspaceId);
    if (workspaceEdgeTarget) return workspaceEdgeTarget;

    const workspaceBody = document.querySelector<HTMLElement>(".workspace-body");
    if (workspaceBody) {
      const rect = workspaceBody.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return null;
    }
    return { kind: "float", workspaceId: drag.workspaceId };
  }

  function toolTabCollapsedGroupDropTargetFromPoint(x: number, y: number): ToolTabDropTarget | null {
    const collapsedGroups = [...document.querySelectorAll<HTMLElement>("[data-dock-group-id][data-dock-group-collapsed='true']")];
    const containingGroup = collapsedGroups
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
      .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0];
    const workspaceId = containingGroup?.element.dataset.workspaceId;
    const groupId = containingGroup?.element.dataset.dockGroupId;
    return workspaceId && groupId ? { kind: "group", workspaceId, groupId } : null;
  }

  function toolTabSidePanelRestoreDropTargetFromPoint(
    x: number,
    y: number,
    workspaceId: string,
    group: HTMLElement,
    rect: DOMRect,
    draggingToolKind: ToolTabKind | null,
    draggingSlotId: string,
    draggingGroupId: string,
    draggingGroupRole: "content" | "side_panel",
  ): ToolTabDropTarget | null {
    if (group.dataset.dockGroupRole !== "content") return null;
    if (!draggingToolKind || draggingToolKind === "terminal") return null;
    if (draggingGroupRole !== "side_panel") return null;
    if (group.dataset.dockGroupId === draggingGroupId) {
      return null;
    }
    const workspaceBody = document.querySelector<HTMLElement>(".workspace-body");
    if (!workspaceBody) return null;
    const bodyRect = workspaceBody.getBoundingClientRect();
    const restoreBand = sidePanelRestoreBand(rect);
    const touchesLeft = Math.abs(rect.left - bodyRect.left) <= 2;
    const touchesRight = Math.abs(rect.right - bodyRect.right) <= 2;
    const touchesBottom = Math.abs(rect.bottom - bodyRect.bottom) <= 2;
    if (touchesLeft && x >= rect.left && x <= rect.left + restoreBand) return { kind: "workspace_edge", workspaceId, side: "left" };
    if (touchesRight && x <= rect.right && x >= rect.right - restoreBand) return { kind: "workspace_edge", workspaceId, side: "right" };
    if (touchesBottom && y <= rect.bottom && y >= rect.bottom - restoreBand) return { kind: "workspace_edge", workspaceId, side: "down" };
    return null;
  }

  function sidePanelRestoreBand(rect: DOMRect) {
    return Math.min(220, Math.max(96, rect.width * 0.45));
  }

  function toolTabGroupEdgeDropTargetFromPoint(
    x: number,
    y: number,
    group: HTMLElement,
    rect: DOMRect,
    draggingSlotId: string,
  ): ToolTabDropTarget | null {
    const workspaceId = group.dataset.workspaceId;
    const slotId = group.dataset.activeToolSlotId;
    if (!workspaceId || !slotId) return null;
    if (slotId === draggingSlotId) return null;
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
    edgeInsetOverride?: number,
  ): ToolTabDropTarget | null {
    const workspaceBody = document.querySelector<HTMLElement>(".workspace-body");
    if (!workspaceBody) return null;
    const rect = workspaceBody.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
    const edgeInset = edgeInsetOverride ?? Math.min(44, Math.max(18, Math.min(rect.width, rect.height) * 0.08));
    const distances = [
      { side: "left" as const, distance: x - rect.left },
      { side: "right" as const, distance: rect.right - x },
      { side: "up" as const, distance: y - rect.top },
      { side: "down" as const, distance: rect.bottom - y },
    ];
    const nearest = distances.reduce((best, item) => (item.distance < best.distance ? item : best));
    return nearest.distance <= edgeInset ? { kind: "workspace_edge", workspaceId, side: nearest.side } : null;
  }

  function workspaceEdgeInnerBand() {
    return 28;
  }

  function toolTabSlotDropTargetFromPoint(
    x: number,
    y: number,
    workspaceId: string,
    draggingSlotId: string,
  ): ToolTabDropTarget | null {
    const slots = [...document.querySelectorAll<HTMLElement>("[data-tool-slot-id]")];
    const match = slots
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
      .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0];
    const slotId = match?.element.dataset.toolSlotId;
    if (!match || !slotId) return null;
    if (slotId === draggingSlotId) return null;
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

  function handleWindowBlur() {
    if (toolTabDragState || toolTabPointerDrag) cancelToolTabDragInteraction();
    dockResizeDrag = null;
    closeHostPicker();
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "hidden") handleWindowBlur();
  }

  function handlePageHide() {
    storeReloadTabsSnapshot();
  }

  async function moveActiveTabToNewWindow() {
    const tab = activeTab;
    if (!tab) return;
    const handoffKey = storeTabHandoff(tab);
    await unwrapCommand(commands.openMainWindow(`/?tab_handoff=${encodeURIComponent(handoffKey)}`));
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

  function storeTabSnapshot(tab: TerminalTab): StoredTerminalTab {
    const tool = workspaceToolById(tab.id);
    return {
      workspaceId: tool?.owner_workspace_id ?? "",
      toolTabId: tab.id,
      session: {
        id: tab.session.id,
        title: tab.session.title,
        baseTitle: tab.session.baseTitle,
        agentSessionName: tab.session.agentSessionName,
        command: tab.session.command,
        currentDirectory: tab.session.currentDirectory,
        titleOverride: tab.session.titleOverride,
        readOnly: tab.session.readOnly,
        agentBacked: tab.session.agentBacked,
        agentSessionId: tab.session.agentSessionId,
        reconnectPending: tab.session.reconnectPending,
        everConnected: tab.session.everConnected,
        connectionHostId: tab.session.connectionHostId,
        reconnectTrust: tab.session.reconnectTrust,
        status: tab.session.status,
        serialized: tab.session.serialize?.serialize({ scrollback: 1000 }) ?? "",
        lastCols: tab.session.lastCols,
        lastRows: tab.session.lastRows,
        lastPixelWidth: tab.session.lastPixelWidth,
        lastPixelHeight: tab.session.lastPixelHeight,
        nextOutputSequence: tab.session.nextOutputSequence.toString(),
      },
    };
  }

  function storeReloadTabsSnapshot() {
    if (floatingWindowId) return;
    if (tabs.length === 0) {
      sessionStorage.removeItem(reloadTabsStorageKey);
      return;
    }
    const stored: StoredReloadTabs = {
      activeIndex: Math.max(0, tabs.findIndex((tab) => tab.id === activeId)),
      tabs: tabs.map(storeTabSnapshot),
    };
    sessionStorage.setItem(reloadTabsStorageKey, JSON.stringify(stored));
  }

  async function restoreTabHandoff() {
    const key = new URLSearchParams(window.location.search).get("tab_handoff");
    if (!key) return false;
    const raw = localStorage.getItem(key);
    if (!raw) throw new Error(`tab handoff ${key} not found`);
    localStorage.removeItem(key);
    const stored = JSON.parse(raw) as StoredTerminalTab;
    const restoredSession = await restoreStoredSession(stored);
    await unwrapCommand(
      commands.transferTerminalSessionsToWindow({
        session_ids: [restoredSession.id],
        window_label: currentWindowLabel(),
      }),
    );
    const tab = restoreStoredTab(stored, restoredSession);
    tabs = [tab];
    activeId = tab.id;
    scheduleReloadTabsSnapshot();
    await tick();
    await mountAndFitTab(tab);
    tab.session.term?.focus();
    syncTerminalMenuState();
    return true;
  }

  async function restoreReloadedTabs() {
    const raw = sessionStorage.getItem(reloadTabsStorageKey);
    if (!raw) return false;
    sessionStorage.removeItem(reloadTabsStorageKey);
    const stored = JSON.parse(raw) as StoredReloadTabs;
    if (stored.tabs.length === 0) return false;
    const restoredTabs: TerminalTab[] = [];
    for (const storedTab of stored.tabs) {
      const restoredSession = await restoreStoredSession(storedTab);
      restoredTabs.push(restoreStoredTab(storedTab, restoredSession));
    }
    tabs = restoredTabs;
    activeId = restoredTabs[Math.min(stored.activeIndex, restoredTabs.length - 1)]?.id ?? restoredTabs[0]?.id ?? "";
    scheduleReloadTabsSnapshot();
    await tick();
    for (const tab of restoredTabs) await mountAndFitTab(tab);
    const focusedTab = tabs.find((tab) => tab.id === activeId);
    if (focusedTab) {
      focusedTab.session.term?.focus();
    }
    syncTerminalMenuState();
    return restoredTabs.length > 0;
  }

  async function restoreStoredSession(stored: StoredTerminalTab) {
    const session = stored.session;
    const reattachesAgentSession = session.agentBacked && session.agentSessionId && !session.readOnly && stored.workspaceId && stored.toolTabId;
    const restored = reattachesAgentSession
      ? createTerminalSession(
          await unwrapCommand(
            commands.attachDetachedTerminalSession({
              workspace_id: stored.workspaceId,
              tool_tab_id: stored.toolTabId,
              detached_session_id: session.agentSessionId,
              window_label: currentWindowLabel(),
            }),
          ),
        )
      : session.reconnectPending
      ? createTerminalSession({
          id: session.id,
          title: session.title,
          command: session.command,
          cwd: session.currentDirectory || null,
          cols: session.lastCols,
          rows: session.lastRows,
          pixel_width: session.lastPixelWidth,
          pixel_height: session.lastPixelHeight,
          process_id: null,
          transport: "ssh",
          transport_state: "disconnected",
          agent: null,
        })
      : createTerminalSession(await unwrapCommand(commands.existingTerminalSessionInfo({ session_id: session.id })));
    if (!reattachesAgentSession) {
      restored.title = session.title;
      restored.baseTitle = session.baseTitle;
    }
    restored.agentSessionName = session.agentSessionName || restored.agentSessionName;
    if (restored.agentSessionId && restored.agentSessionName) {
      updateAgentSessionNameFromInfo({
        id: restored.id,
        title: restored.agentSessionName,
        command: restored.command,
        cwd: restored.currentDirectory || null,
        cols: restored.lastCols,
        rows: restored.lastRows,
        pixel_width: restored.lastPixelWidth,
        pixel_height: restored.lastPixelHeight,
        process_id: null,
        transport: "agent",
        transport_state: restored.status === "running" ? "connected" : "disconnected",
        agent: { session_id: restored.agentSessionId },
      });
    }
    restored.command = session.command;
    restored.currentDirectory = session.currentDirectory;
    restored.titleOverride = session.titleOverride;
    restored.readOnly = session.readOnly;
    restored.agentSessionId = session.agentSessionId;
    restored.reconnectPending = session.reconnectPending;
    restored.everConnected = session.everConnected || session.status === "running" || session.status === "disconnected";
    restored.connectionHostId = session.connectionHostId;
    restored.reconnectTrust = session.reconnectTrust;
    restored.status = session.status;
    restored.lastCols = session.lastCols;
    restored.lastRows = session.lastRows;
    restored.lastPixelWidth = session.lastPixelWidth;
    restored.lastPixelHeight = session.lastPixelHeight;
    restored.nextOutputSequence = BigInt(session.nextOutputSequence ?? "0");
    restored.outputQueue = session.serialized ? [session.serialized] : [];
    return restored;
  }

  function restoreStoredTab(stored: StoredTerminalTab, restoredSession: TerminalSession) {
    const tab = createTerminalTabFromSession(restoredSession);
    restoredSession.tabId = tab.id;
    tab.session = restoredSession;
    refreshTerminalTabTitle(tab);
    return tab;
  }

  async function mountTerminalWhenReady(sessionId: string, viewId?: string) {
    const terminalViewId = await waitForTerminalContainer(sessionId, viewId);
    if (terminalViewId === null) return;
    await terminalTabs.mountTerminal(sessionId, terminalViewId);
  }

  async function waitForTerminalContainer(sessionId: string, viewId?: string) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const tab = findLocalTabBySessionId(sessionId);
      if (!tab) return null;
      const session = terminalSessionById(tab, sessionId);
      if (viewId && session?.viewContainers.has(viewId)) return viewId;
      const visibleViewId = session ? Array.from(session.viewContainers.keys()).find((id) => session.viewContainers.get(id)?.isConnected) : undefined;
      if (!viewId && visibleViewId) return visibleViewId;
      if (!viewId && session?.container) return sessionId;
      await tick();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    throw new Error(viewId ? `terminal session ${sessionId} did not mount container view ${viewId}` : `terminal session ${sessionId} did not mount a visible container`);
  }

  function terminalMount(node: HTMLDivElement, params: { session: TerminalSession; toolTabId: string; viewId: string }) {
    let current = params;
    attachTerminalMount(node, current);
    return {
      update(next: { session: TerminalSession; toolTabId: string; viewId: string }) {
        if (next.session === current.session && next.toolTabId === current.toolTabId && next.viewId === current.viewId) return;
        detachTerminalMount(node, current.session, current.viewId);
        current = next;
        attachTerminalMount(node, current);
      },
      destroy() {
        detachTerminalMount(node, current.session, current.viewId);
      },
    };
  }

  function attachTerminalMount(node: HTMLDivElement, params: { session: TerminalSession; toolTabId: string; viewId: string }) {
    params.session.viewContainers.set(params.viewId, node);
    if (params.viewId === params.session.id) params.session.container = node;
    void mountTerminalToolTab(params.toolTabId, params.viewId);
  }

  function detachTerminalMount(node: HTMLDivElement, session: TerminalSession, viewId: string) {
    if (session.viewContainers.get(viewId) === node) {
      session.viewContainers.delete(viewId);
    }
    if (session.container === node) {
      session.container = undefined;
    }
    terminalTabs.scheduleFit(session.id);
  }

  async function mountTerminalToolTab(toolTabId: string, viewId?: string) {
    const runtime = terminalRuntimeForToolTab(toolTabId);
    const session = runtime?.tab.session ?? null;
    if (!session) return;
    const terminalViewId = viewId ?? visibleTerminalViewIdForToolTab(toolTabId, session);
    activeTerminalToolTabId = toolTabId;
    activeId = toolTabId;
    await tick();
    await mountTerminalWhenReady(session.id, terminalViewId);
    await flushTerminalOutputBacklog(session.id);
    terminalTabs.scheduleFit(session.id, terminalViewId);
    session.term?.focus();
    syncTerminalMenuState();
  }

  function visibleTerminalViewIdForToolTab(_toolTabId: string, session: TerminalSession) {
    const existing = Array.from(session.viewContainers.keys()).find((id) => session.viewContainers.get(id)?.isConnected);
    if (existing) return existing;
    const floatingSlot = activeFloatingWindow ? activeDisplaySlotForToolTab(activeFloatingWindow.layout, session.id) : null;
    if (floatingSlot) return floatingSlot.id;
    const workspaceSlot = activeWorkspace ? activeDisplaySlotForToolTab(activeWorkspace.layout, session.id) : null;
    return workspaceSlot?.id ?? session.id;
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

  async function copyTerminalSelection(sessionId: string) {
    const session = findLocalSessionById(sessionId);
    if (!session?.term || !session.term.hasSelection()) return;
    const selection = session.term.getSelection();
    if (!selection) return;
    if (hasTauriRuntime()) await writeText(selection);
    else await navigator.clipboard.writeText(selection);
  }

  async function pasteIntoTerminal(sessionId: string) {
    const session = findLocalSessionById(sessionId);
    if (!session?.term || session.readOnly) return;
    const text = hasTauriRuntime() ? await readText() : await navigator.clipboard.readText();
    if (!text) return;
    session.term.paste(text);
  }

  async function pasteSelectionIntoActiveSession() {
    const session = activeSession();
    if (!session?.term || session.readOnly || !session.term.hasSelection()) return;
    const selection = session.term.getSelection();
    if (!selection) return;
    session.term.paste(selection);
  }

  function syncTerminalMenuState() {
    const session = activeSession();
    const hasActiveTab = activeTab !== undefined;
    const hasActiveSession = session !== null;
    const hasSelection = session?.term?.hasSelection() === true;
    const textInput = activeTextInput();
    const textInputHasSelection = textInput ? textInput.selectionStart !== textInput.selectionEnd : false;
    const textHistory = textInput ? textEditHistories.get(textInput) : undefined;
    const canUndo = terminalMenuCanUndo({
      activeSessionWritable: session !== null && !session.readOnly,
      activeTextInputCanRedo: (textHistory?.redo.length ?? 0) > 0,
      activeTextInputCanUndo: textInput !== null && ((textHistory?.undo.length ?? 0) > 0 || textInput.value.length > 0),
      redoDepth: redoStack.length,
      undoDepth: undoStack.length,
    });
    const canRedo = terminalMenuCanRedo({
      activeSessionWritable: session !== null && !session.readOnly,
      activeTextInputCanRedo: (textHistory?.redo.length ?? 0) > 0,
      activeTextInputCanUndo: textInput !== null && ((textHistory?.undo.length ?? 0) > 0 || textInput.value.length > 0),
      redoDepth: redoStack.length,
      undoDepth: undoStack.length,
    });
    const state: TerminalMenuStateInput = {
      can_edit_text: textInput !== null,
      can_undo_text: canUndo,
      can_redo_text: canRedo,
      has_active_tab: hasActiveTab,
      has_multiple_tabs: tabs.length > 1,
      has_selection: hasSelection || textInputHasSelection,
      can_paste: textInput !== null || (session !== null && !session.readOnly),
      can_paste_selection: hasSelection && session !== null && !session.readOnly,
      can_select_all: textInput !== null || hasActiveSession,
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

  function handleTerminalMenuEvent(event: { command: string }) {
    const command = event.command;
    if (command === "open_command_palette") {
      openCommandPalette();
      return;
    }
    if (command === "new_tab") {
      void openWorkspaceTerminalSession();
      return;
    }
    if (command === "close" || command === "close_tab") {
      if (activeId) void closeTab(activeId, { recordHistory: true });
      return;
    }
    if (command === "undo") {
      const input = activeTextInput();
      if (input) runTextInputEditCommand(input, "undo");
      return;
    }
    if (command === "redo") {
      const input = activeTextInput();
      if (input) runTextInputEditCommand(input, "redo");
      return;
    }
    if (command === "copy") {
      const input = activeTextInput();
      if (input) {
        runTextInputEditCommand(input, "copy");
        return;
      }
      const session = activeSession();
      if (session) void copyTerminalSelection(session.id);
      return;
    }
    if (command === "paste") {
      const session = activeSession();
      if (session) void pasteIntoTerminal(session.id);
      return;
    }
    if (command === "paste_selection") {
      void pasteSelectionIntoActiveSession();
      return;
    }
    if (command === "select_all") {
      const input = activeTextInput();
      if (input) {
        input.select();
        syncTerminalMenuState();
        return;
      }
      activeSession()?.term?.selectAll?.();
      return;
    }
    if (command === "find") {
      showFind();
      return;
    }
    if (command === "find_next") {
      findNext();
      return;
    }
    if (command === "find_previous") {
      findPrevious();
      return;
    }
    if (command === "hide_find_bar") {
      hideFind();
      return;
    }
    if (command === "use_selection_for_find") {
      useSelectionForFind();
      return;
    }
    if (command === "jump_to_selection") {
      jumpToSelection();
      return;
    }
    if (command === "reset_font_size") {
      resetFontSize();
      return;
    }
    if (command === "increase_font_size") {
      adjustFontSize(1);
      return;
    }
    if (command === "decrease_font_size") {
      adjustFontSize(-1);
      return;
    }
    if (command === "toggle_read_only") {
      const session = activeSession();
      if (session) toggleTerminalReadOnly(session.id);
      return;
    }
    if (command === "show_previous_tab") {
      showPreviousTab();
      return;
    }
    if (command === "show_next_tab") {
      showNextTab();
      return;
    }
    if (command === "move_tab_to_new_window") {
      void moveActiveTabToNewWindow();
    }
  }

  function resetTerminal(sessionId: string) {
    const session = findLocalSessionById(sessionId);
    if (!session?.term) return;
    session.term.reset();
    session.term.clear();
    terminalTabs.scheduleFit(session.id);
  }

  function toggleTerminalReadOnly(sessionId: string) {
    const session = findLocalSessionById(sessionId);
    if (!session) return;
    session.readOnly = !session.readOnly;
    syncTerminalMenuState();
  }

  async function persistTerminalProgramTitle(sessionId: string, title: string) {
    const trimmed = title.trim();
    const session = findLocalSessionById(sessionId);
    const titleKey = session?.agentSessionId || sessionId;
    if (!trimmed || lastPersistedTerminalTitleByAgentSessionId.get(titleKey) === trimmed) return;
    lastPersistedTerminalTitleByAgentSessionId.set(titleKey, trimmed);
    if (!hasTauriRuntime()) return;
    try {
      await unwrapCommand(commands.updateTerminalTitle({ session_id: sessionId, title: trimmed }));
      terminalSessionsRevision += 1;
    } catch (error) {
      lastPersistedTerminalTitleByAgentSessionId.delete(titleKey);
      settingsError = error instanceof Error ? error.message : String(error);
    }
  }

  function adjustFontSize(delta: number) {
    const session = activeSession();
    const baseSize = settings?.font_size ?? 13;
    if (!session?.term) return;
    const currentSize = typeof session.term.options.fontSize === "number" ? session.term.options.fontSize : baseSize;
    session.term.options.fontSize = Math.max(6, Math.min(48, currentSize + delta));
    terminalTabs.scheduleFit(session.id);
  }

  function resetFontSize() {
    const session = activeSession();
    if (!settings || !session) return;
    if (settings.font_size === null) throw new Error("terminal font size is missing");
    if (!session.term) return;
    session.term.options.fontSize = settings.font_size;
    terminalTabs.scheduleFit(session.id);
  }

  function showFind() {
    findVisible = true;
    const selection = activeSession()?.term?.getSelection() ?? "";
    if (selection) findQuery = selection;
    runFindNavigation("next", { focusTerminal: false, incremental: true });
    syncTerminalMenuState();
    void focusFindInput();
  }

  function hideFind() {
    const session = activeSession();
    const sessionId = session?.id;
    findVisible = false;
    clearTerminalFindEffects(session);
    findSnapshot = { activeIndex: 0, error: "", matches: [] };
    appliedFindSearchKey = null;
    syncTerminalMenuState();
    void restoreTerminalAfterFindClose(sessionId);
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
    const session = activeSession();
    updateFindSnapshot();
    if (!session?.search || !hasFindQuery() || findSnapshot.error) {
      session?.search?.clearDecorations?.();
      appliedFindSearchKey = null;
      return;
    }
    const searchKey = {
      caseSensitive: findCaseSensitive,
      sessionId: session.id,
      query: findQuery,
      regex: findRegex,
    };
    if (terminalFindSearchKeyChanged(appliedFindSearchKey, searchKey)) {
      session.search.clearDecorations?.();
      appliedFindSearchKey = searchKey;
    }
    const options = {
      caseSensitive: findCaseSensitive,
      decorations: searchDecorations(),
      incremental,
      regex: findRegex,
    };
    const found =
      direction === "next" ? session.search.findNext(findQuery, options) : session.search.findPrevious(findQuery, options);
    if (!found) session.search.clearActiveDecoration?.();
    updateFindSnapshot();
    if (focusTerminal) session.term?.focus();
    syncTerminalMenuState();
  }

  function useSelectionForFind() {
    const selection = focusedTextSelection() || activeSession()?.term?.getSelection() || "";
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
    const term = activeSession()?.term;
    findSnapshot = term
      ? terminalFindSnapshot(term as unknown as TerminalLike, findQuery, {
          caseSensitive: findCaseSensitive,
          regex: findRegex,
        })
      : { activeIndex: 0, error: "", matches: [] };
  }

  function refreshFindForActiveSession() {
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
    const term = activeSession()?.term;
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

  async function restoreTerminalAfterFindClose(sessionId: string | undefined) {
    if (!sessionId) return;
    await tick();
    await animationFrame();
    const session = tabs.find((tab) => tab.session.id === sessionId)?.session;
    session?.term?.focus();
    for (let frame = 0; frame < 3; frame += 1) {
      terminalTabs.refreshSessionPresentation(sessionId);
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

  function buildPaletteItems(): PaletteItem[] {
    const currentLanguage = language();
    const hasActiveSession = activeSession() !== null;
    const terminalAgentEnabled = terminalAgentEnabledForHost(activeWorkspaceHost());
    const staticItems = staticPaletteCommands.map((command) => {
      const item = localizeCommand(command, currentLanguage);
      const shortcut = displayShortcut(item.shortcut);
      return {
        ...item,
        shortcut,
        contextScore: paletteContextScore(item.id, hasActiveSession),
        recentScore: paletteRecentScore(item.id),
        disabledReason: paletteDisabledReason(item.id, hasActiveSession),
      };
    }).filter((item) => item.id !== "tool.openTerminalSessions" || terminalAgentEnabled);
    return [
      ...staticItems,
      ...detachedTerminalPaletteItems,
      ...connectionHostPaletteItems(),
      ...tabPaletteItems(),
      ...profilePaletteItems(),
    ];
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
          tab.session.currentDirectory ?? "",
          tab.session.command ?? "",
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

  function paletteContextScore(id: string, hasActiveSession: boolean) {
    if (id.startsWith("terminal.split") && hasActiveSession) return 34;
    if (id.startsWith("ui.theme.")) return 12;
    return 0;
  }

  function paletteRecentScore(id: string) {
    const index = recentPaletteIds.indexOf(id);
    return index === -1 ? 0 : Math.max(2, 12 - index * 2);
  }

  function paletteDisabledReason(id: string, hasActiveSession: boolean) {
    if (id.startsWith("terminal.split") && !hasActiveSession) return t("requiresActiveSession");
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
    void refreshDetachedTerminalPaletteItems();
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
    const session = activeSession();
    if (session?.term) {
      session.term.focus();
      return;
    }
    commandPaletteLastFocus?.focus?.();
  }

  function updateCommandPaletteQuery(value: string) {
    commandPaletteQuery = value;
    commandPaletteSelected = 0;
  }

  async function refreshDetachedTerminalPaletteItems() {
    if (!hasTauriRuntime()) {
      detachedTerminalPaletteItems = [];
      return;
    }
    if (!terminalAgentEnabledForHost(activeWorkspaceHost())) {
      detachedTerminalPaletteItems = [];
      return;
    }
    const toolTabId = activeTerminalToolTabId;
    const tool = toolTabId ? workspaceToolById(toolTabId) : null;
    if (!tool || (tool.kind !== "terminal" && tool.kind !== "terminal_sessions")) {
      detachedTerminalPaletteItems = [];
      return;
    }
    try {
      const sessions = await unwrapCommand(
        commands.listDetachedTerminalSessions({
          workspace_id: tool.owner_workspace_id,
          tool_tab_id: tool.id,
        }),
      );
      detachedTerminalPaletteItems = sessions.flatMap((session) => [
        ...(session.detached
          ? [
              {
                id: `terminal.attachDetached:${session.session_id}`,
                kind: "command" as const,
                title: `Attach Detached Session: ${session.title}`,
                scope: "Terminal",
                keywords: [
                  session.title,
                  session.command,
                  "attach",
                  "detached",
                  "terminal",
                  "session",
                  "agent",
                  "恢复",
                  "重新连接",
                  "终端",
                  "分离",
                ],
                contextScore: 36,
                recentScore: paletteRecentScore(`terminal.attachDetached:${session.session_id}`),
              },
            ]
          : []),
        {
          id: `terminal.deleteDetached:${session.session_id}`,
          kind: "command" as const,
          title: `Delete Terminal Session: ${session.title}`,
          scope: "Terminal",
          keywords: [
            session.title,
            session.command,
            "delete",
            "remove",
            "detached",
            "terminal",
            "session",
            "agent",
            "删除",
            "移除",
            "终端",
            "分离",
          ],
          contextScore: 20,
          recentScore: paletteRecentScore(`terminal.deleteDetached:${session.session_id}`),
        },
      ]);
    } catch (error) {
      detachedTerminalPaletteItems = [];
      settingsError = error instanceof Error ? error.message : String(error);
    }
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
    if (id.startsWith("terminal.attachDetached:")) {
      await attachDetachedTerminalSession(id.slice("terminal.attachDetached:".length));
      return;
    }
    if (id.startsWith("terminal.deleteDetached:")) {
      await deleteDetachedTerminalSession(id.slice("terminal.deleteDetached:".length));
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
    if (id === "tool.openTerminalSessions") {
      await openWorkspaceTerminalSessions();
      return;
    }
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

  function clearHostSessionRetry(sessionId: string) {
    if (!hostSessionRetryBySessionId[sessionId]) return;
    const { [sessionId]: _removed, ...rest } = hostSessionRetryBySessionId;
    hostSessionRetryBySessionId = rest;
  }

  function markConnectionCancelled(sessionId: string, message: string) {
    clearHostSessionRetry(sessionId);
    void unwrapCommand(commands.closeTerminalSession(sessionId)).catch(() => {});
    terminalTabs.markConnectionCancelled(sessionId, message);
  }

  async function handleTerminalExit(event: TerminalExitEvent) {
    if (!hasLocalTerminalSession(event.session_id)) return;
    clearHostSessionRetry(event.session_id);
    terminalTabs.markExited(event);
    terminalSessionsRevision += 1;
    await refreshDetachedTerminalPaletteItems();
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
      const sessionId = terminalSessionIdForToolTab(challenge.challenge.source_tool_tab_id);
      if (sessionId) terminalTabs.markConnectionPrompt(sessionId, "Waiting for SSH credential");
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
    if (activeSession()?.term) activeSession()?.term?.focus();
  }

  async function switchAppTheme(theme: "system" | "light" | "dark") {
    const snapshot = lastConfigSnapshot ?? (await unwrapCommand(commands.getConfigSnapshot()));
    const next = JSON.parse(JSON.stringify(snapshot.main_config)) as typeof snapshot.main_config;
    writeValue(next.root, ["ui", "theme"], configString(theme));
    await unwrapCommand(commands.updateMainConfig(next));
    await loadSettings();
    await unwrapCommand(commands.refreshAppMenu());
    if (activeSession()?.term) activeSession()?.term?.focus();
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
    publishTestHooks();
    let mounted = true;
    pageMounted = true;
    floatingWindowId = currentFloatingWindowId();
    const stopTransferQueueObserver = startTransferQueueObserver();
    void (async () => {
      if (hasTauriRuntime()) {
      const [outputDispose, exitDispose, transportStateDispose, configDispose, verificationDispose, portForwardVerificationDispose, terminalMenuDispose] = await Promise.all([
          listen<TerminalOutputEvent>("terminal://output", (event) => enqueueTerminalOutput(event.payload)),
          listen<TerminalExitEvent>("terminal://exit", (event) => {
            void handleTerminalExit(event.payload).catch((error) => {
              settingsError = error instanceof Error ? error.message : String(error);
            });
          }),
          listen<TerminalTransportStateEvent>("terminal://transport-state", (event) => {
            routeTerminalSessionEvent(event.payload.session_id, localTerminalSessionIds(), () => terminalTabs.markTransportState(event.payload));
          }),
          listen<{ command: string }>("terminal://menu-command", (event) => {
            handleTerminalMenuEvent(event.payload);
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
        ]);
        if (!mounted) {
          outputDispose();
          exitDispose();
          transportStateDispose();
          terminalMenuDispose();
          configDispose();
          verificationDispose();
          portForwardVerificationDispose();
          return;
        }
        outputUnlisten = outputDispose;
        exitUnlisten = exitDispose;
        transportStateUnlisten = transportStateDispose;
        terminalMenuUnlisten = terminalMenuDispose;
        configUnlisten = configDispose;
        workspaceSshVerificationUnlisten = verificationDispose;
        portForwardSshVerificationUnlisten = portForwardVerificationDispose;
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
        const restored = (await restoreTabHandoff()) || (await restoreReloadedTabs());
        await ensureStartupSession(restored);
      }
    })().catch((error) => {
      settingsError = error instanceof Error ? error.message : String(error);
    });
    window.addEventListener("keydown", handleKeyboard, { capture: true });
    window.addEventListener("pointermove", handlePointerMove, { capture: true });
    window.addEventListener("pointerup", handlePointerUp, { capture: true });
    window.addEventListener("pointercancel", handlePointerCancel, { capture: true });
    window.addEventListener("click", handleClick, { capture: true });
    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("focus", syncTerminalMenuState);
    window.addEventListener("pagehide", handlePageHide);
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
      pageMounted = false;
      window.removeEventListener("keydown", handleKeyboard, { capture: true });
      window.removeEventListener("pointermove", handlePointerMove, { capture: true });
      window.removeEventListener("pointerup", handlePointerUp, { capture: true });
      window.removeEventListener("pointercancel", handlePointerCancel, { capture: true });
      window.removeEventListener("click", handleClick, { capture: true });
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("focus", syncTerminalMenuState);
      window.removeEventListener("pagehide", handlePageHide);
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
      terminalMenuUnlisten?.();
      stopTransferQueueObserver();
      workspaceStore.dispose();
      if (floatingWindowId) {
        for (const tab of terminalRuntimeTabs()) disposeTerminalTab(tab);
        return;
      }
      if (isHotModuleReplacement) {
        storeReloadTabsSnapshot();
        for (const tab of terminalRuntimeTabs()) disposeTerminalTab(tab);
        return;
      }
      storeReloadTabsSnapshot();
      for (const tab of terminalRuntimeTabs()) {
        disposeTerminalTab(tab);
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
        void mountAndFitTab(tab);
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
        </div>
        <div class="workspace-tabbar-loading-tab-row" aria-hidden="true"></div>
      {:else}
        <span>{workspaceStore.loading ? "Loading workspace..." : "Workspace"}</span>
        <div
          class="workspace-tabbar-loading-drag-zone"
          aria-hidden="true"
          data-tauri-drag-region={integratedTitlebar ? true : undefined}
        ></div>
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
    {@const detachTarget = toolTabContextMenuDetachTarget(toolTabContextMenu)}
    <section
      class="tooltab-context-menu"
      style={`left: ${toolTabContextMenu.left}px; top: ${toolTabContextMenu.top}px;`}
      role="menu"
      data-tooltab-menu="true"
    >
      <button type="button" role="menuitem" onclick={() => void closeWorkspaceSlot(toolTabContextMenu!.workspaceId, toolTabContextMenu!.slotId).finally(closeToolTabContextMenu)}>
        Close
      </button>
      {#if detachTarget}
        <button type="button" role="menuitem" onclick={() => void detachToolTabContextMenu(toolTabContextMenu!).finally(closeToolTabContextMenu)}>
          Detach
        </button>
      {/if}
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
      style={splitStyle(layout, bounds)}
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
        {#if index < layout.children.length - 1 && splitBoundaryResizable(layout, index)}
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
      tabbarPlacement={toolTabbarPlacement(layout, bounds)}
      visualRole={visualDockGroupRole(layout)}
      dropTargetGroupId={activeToolDropTargetGroupId()}
      splitTargetSlotId={activeToolSplitTargetSlotId()}
      draggingSlotId={toolTabDragState?.slotId ?? null}
      {slotTool}
      slotTitle={slotToolTitle}
      slotTooltip={slotToolTooltip}
      {ownerWorkspaceTitle}
      terminalSessionId={terminalSessionIdForToolTab}
      onActivate={(slotId) => workspace ? void activateWorkspaceSlot(workspace, slotId) : undefined}
      onSetCollapsed={(collapsed) => workspace ? void setDockGroupCollapsed(workspace, layout.id, collapsed) : undefined}
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
  {:else if tool.kind === "terminal_sessions"}
    <TerminalSessionsToolTab
      toolTab={tool}
      workspaceId={effectiveWorkspace.id}
      {active}
      revision={terminalSessionsRevision}
      onAttach={attachDetachedTerminalSession}
      onOpenHistory={openDetachedTerminalSessionHistory}
      onSessionsChanged={updateAgentSessionNamesFromDetachedSessions}
      onDeleted={() => {
        terminalSessionsRevision += 1;
        return refreshDetachedTerminalPaletteItems();
      }}
    />
  {:else if tool.kind === "resources"}
    <ResourceMonitorToolTab toolTab={tool} workspaceId={effectiveWorkspace.id} viewId={slot.id} {active} />
  {:else if tool.kind === "ports"}
    <PortsToolTab toolTab={tool} host={connectionHostForToolTab(tool)} {active} />
  {:else}
    {@const terminalMode = terminalRenderMode(workspace, effectiveWorkspace)}
    {@const runtime = terminalRuntimeForToolTab(tool.id)}
    {@const session = runtime?.tab.session ?? null}
    {#if !terminalMode}
      <div class="dock-empty">
        <strong>{tool.title}</strong>
        <span>Terminal is visible in its owner workspace.</span>
      </div>
    {:else}
      <section class="terminal-tool-area" aria-label="Terminal ToolTab">
        <section class="content" aria-label="Terminal content">
          {#if (settingsError || workspaceStore.error) && (!runtime || !session)}
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
          {:else if !runtime || !session}
            <div class="placeholder">
              <img src="/favicon.png" alt="" />
              <h1>Nocturne</h1>
            </div>
          {:else}
            <section
              class="terminal-surface"
              class:mirror={slot.kind === "mirror"}
              data-testid="terminal-surface"
              data-session-id={session.id}
              data-tool-tab-id={tool.id}
              data-terminal-view-id={slot.id}
              data-terminal-read-only={session.readOnly ? "true" : "false"}
              data-terminal-status={session.status}
              data-terminal-exit-text={session.exitText}
              data-agent-session-id={session.agentSessionId}
              data-terminal-mirror={slot.kind === "mirror" ? "true" : undefined}
              data-terminal-runtime-title={terminalRuntimeTitleForToolTab(tool.id) ?? ""}
              aria-label={session.title}
              role="group"
            >
              {#if slot.kind === "mirror"}
                <div class="terminal-mirror-source" data-testid="terminal-mirror-source">
                  <span>Mirror from {ownerWorkspaceTitle(slot)}</span>
                </div>
              {/if}
              <div class="terminal-host" data-testid="terminal-host" role="presentation" onmousedown={() => void mountTerminalToolTab(tool.id, slot.id)}>
                <div class="terminal-mount" data-testid="terminal-mount" use:terminalMount={{ session, toolTabId: tool.id, viewId: slot.id }}></div>
                <div class="terminal-too-small" aria-hidden="true">Terminal too small</div>
              </div>
              {#if session.error}
                <p class="terminal-error">{session.error}</p>
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

  :global(html),
  :global(body) {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .workspace {
    --workspace-titlebar-height: 40px;
    width: 100vw;
    height: 100vh;
    min-width: 0;
    min-height: 0;
    display: grid;
    grid-template-rows: var(--workspace-titlebar-height) minmax(0, 1fr);
    overflow: hidden;
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
    pointer-events: none;
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
    pointer-events: auto !important;
  }

  .workspace.integrated-titlebar-decorum :global(button.decorum-tb-btn:hover),
  .workspace.integrated-titlebar-decorum :global(button.decorum-tb-btn:focus-visible) {
    color: transparent !important;
    background: color-mix(in srgb, var(--app-fg) 11%, transparent) !important;
  }

  .workspace.integrated-titlebar-decorum :global(button.decorum-tb-btn::before),
  .workspace.integrated-titlebar-decorum :global(button.decorum-tb-btn::after) {
    content: "";
    position: absolute;
    box-sizing: border-box;
    display: block;
    pointer-events: none;
    color: color-mix(in srgb, var(--app-fg) 94%, transparent);
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
    font-family: var(--terminal-font-family);
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
