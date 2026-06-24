<script lang="ts">
  import { flushSync, onMount, tick } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { ask, message, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { OverlayScrollbarsComponent } from "overlayscrollbars-svelte";
  import "katex/dist/katex.min.css";
  import "overlayscrollbars/overlayscrollbars.css";
  import FileIcon from "~icons/lucide/file";
  import FileSymlinkIcon from "~icons/lucide/file-symlink";
  import FolderIcon from "~icons/lucide/folder";
  import { commands, type FileEntry, type FileListResult, type FilePreviewResult, type FileProviderKind, type FileSearchResult, type TransferEndpoint, type TransferQueueSnapshot, type TransferTask, type WorkspaceToolTab } from "$lib/bindings";
  import { setFilesClipboard } from "$lib/files/clipboard.svelte";
  import { basename, buildFilesColumnsView, columnsForPath, columnsForVisiblePane, type FilesColumnView } from "$lib/files/columns";
  import { filesSelectionContextMenuActions, type FilesContextMenuAction, type FilesContextMenuActionId } from "$lib/files/context-menu";
  import { isMarkdownPreviewPath, renderMarkdownPreviewHtml } from "$lib/files/markdown-preview";
  import { filesToolSelection, filesToolViewState, resetFilesToolSelection } from "$lib/files/selection.svelte";
  import { selectFilesContextTarget, selectFilesEntry, selectFilesMarquee } from "$lib/files/selection";
  import { DEFAULT_FILES_TOOLBAR_ACTION_IDS, normalizeFilesToolbarActionIds, type FilesToolbarActionId } from "$lib/files/toolbar-actions";
  import { resolveFilesUploadTarget } from "$lib/files/upload-target";
  import {
    buildFileTreeRootModel,
    buildFileTreeRows,
    fileTreeClickAction,
    fileTreeDoubleClickAction,
    filesTreeInitialFocusPlan,
    filesTreeStickyAncestors,
    isRenderableFilePreview,
    normalizeFilesTreeStickySettings,
    shouldShowFilePreviewRegion,
  } from "$lib/files/tree";
  import {
    FILES_WORKSPACE_SSH_VERIFICATION_SUBMITTED_EVENT,
    isFilesWorkspaceVerificationPendingError,
    type FilesWorkspaceSshVerificationSubmittedDetail,
  } from "$lib/files/workspace-verification";
  import { hasTauriRuntime } from "$lib/tauri/runtime";
  import { unwrapCommand } from "$lib/terminal/commands";

  type Props = {
    toolTab: WorkspaceToolTab;
    workspaceId: string;
    defaultViewMode?: "tree" | "columns";
    showHidden?: boolean;
    deleteBehavior?: "direct" | "try_remote_trash";
    textPreviewLimitBytes?: number;
    imagePreviewLimitBytes?: number;
    toolbarActionIds?: readonly string[];
    treeStickyEnabled?: boolean;
    treeStickyMaxLevels?: number;
  };

  type TransferQueueChangedEvent = {
    version: number;
    snapshot: TransferQueueSnapshot;
  };

  let {
    toolTab,
    workspaceId,
    defaultViewMode = "tree",
    showHidden = true,
    deleteBehavior = "direct",
    textPreviewLimitBytes = 1_048_576,
    imagePreviewLimitBytes = 10_485_760,
    toolbarActionIds = DEFAULT_FILES_TOOLBAR_ACTION_IDS,
    treeStickyEnabled = true,
    treeStickyMaxLevels = 3,
  }: Props = $props();
  // This component is keyed by ToolTab id by the workspace renderer, so the initial id is stable for this instance.
  // svelte-ignore state_referenced_locally
  const selection = filesToolSelection(toolTab.id);
  // svelte-ignore state_referenced_locally
  const viewState = filesToolViewState(toolTab.id);
  let path = $derived(viewState.path);
  let lastSelectedEntry = $derived(viewState.lastSelectedEntry);
  let viewMode = $derived(viewState.viewMode ?? defaultViewMode);
  let viewModeInitialized = false;
  let searchOpen = $state(false);
  let searchQuery = $state("");
  let searchMode = $state<"name" | "content">("name");
  let searchIgnoreIgnoreFiles = $state(false);
  let searchFollowSymlinks = $state(false);
  let searchResult = $state<FileSearchResult | null>(null);
  let searchLoading = $state(false);
  let previewPath = $derived(viewState.previewPath);
  let dragHover = $state(false);
  let operationError = $state("");
  let contextMenu = $state<{
    x: number;
    y: number;
    actions: FilesContextMenuAction[];
  } | null>(null);
  let selectionRevision = $state(0);
  let marquee = $state<{
    active: boolean;
    root: HTMLElement;
    inputKind: "mouse" | "pointer";
    pointerId?: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  let expandedTreePaths = $derived(viewState.expandedTreePaths);
  let userCollapsedTreePaths = $derived(viewState.userCollapsedTreePaths);
  let treeChildrenByPath = $derived(viewState.treeChildrenByPath);
  let treeLoadingByPath = $state<Record<string, boolean>>({});
  let treeErrorByPath = $derived(viewState.treeErrorByPath);
  const directoryChildrenLoadPromises = new Map<string, Promise<FileListResult | null>>();
  let filesRoot: HTMLElement | null = null;
  let columnsPanes = $state<ColumnsPane[]>([]);
  let columnsMotion = $state<ColumnsMotion>("idle");
  let columnsMotionPreparing = $state(false);
  let columnsMotionActive = $state(false);
  let columnsMotionSettling = $state(false);
  let columnsResizeColumnCount = $state<number | null>(null);
  let nameDialog = $state<{
    action: "create_directory" | "rename" | "chmod" | "upload_target";
    title: string;
    label: string;
    value: string;
  } | null>(null);
  let pendingUploadSource = $state<"dialog" | "drop" | null>(null);
  let pendingDroppedPaths = $state<string[]>([]);
  let firstVisibleTreePath = $derived(viewState.firstVisibleTreePath);
  let externalDropTargetPath = $state<string | null>(null);
  type FilesColumn = FilesColumnView<FileEntry>;
  type ColumnsMotion = "idle" | "forward" | "backward" | "resize";
  type ColumnsMotionHint = "forward" | "backward" | "none";
  type ColumnsPane = {
    id: string;
    columns: FilesColumn[];
    renderColumns?: FilesColumn[];
    current: boolean;
  };

  type ColumnsSlideMotionWindow = {
    previous: FilesColumn[];
    current: FilesColumn[];
    distance: string;
  };
  let lastColumnsSignature = "";
  let pendingColumnsMotionHint = $state<ColumnsMotionHint | null>(null);
  let columnsMotionGeneration = 0;
  let columnsMotionFinishTimer: number | null = null;
  let columnsMotionDistance = $state("100%");
  let columnsMotionTranslate = $state("0px");
  let columnsMotionTransition = $state("none");
  let pendingColumnsScrollOffsets: ReadonlyMap<string, { scrollTop: number; anchorPath: string | null }> | null = null;
  let pendingColumnsFocusWindowPath: string | null = null;
  let pendingColumnsReplaceWithoutMotionPath: string | null = null;
  let filesResult = $derived(viewState.filesResult);
  let filesLoading = $state(false);
  let filesError = $state<unknown>(null);
  let filesLoadGeneration = 0;
  let initialDirectoryFocusPath = "";
  let columnsAncestorPreloadKey = "";
  let treeAncestorPreloadKey = "";
  let treeInitialFocusScrollKey = "";
  let treeInitialFocusScrollPendingKey = "";
  let handledCompletedTransferIds = new Set<string>();
  let treeVisibleFrame: number | null = null;
  const queryClient = useQueryClient();
  const overlayVerticalOptions = {
    overflow: {
      x: "hidden",
      y: "scroll",
    },
    scrollbars: {
      autoHide: "leave",
      autoHideDelay: 420,
      theme: "os-theme-nocturne",
    },
  } as const;
  const overlayHorizontalOptions = {
    overflow: {
      x: "scroll",
      y: "hidden",
    },
    scrollbars: {
      autoHide: "leave",
      autoHideDelay: 420,
      theme: "os-theme-nocturne",
    },
  } as const;
  const overlayBothOptions = {
    overflow: {
      x: "scroll",
      y: "scroll",
    },
    scrollbars: {
      autoHide: "leave",
      autoHideDelay: 420,
      theme: "os-theme-nocturne",
    },
  } as const;
  const overlayPreviewOptions = {
    overflow: {
      x: "hidden",
      y: "scroll",
    },
    scrollbars: {
      autoHide: "leave",
      autoHideDelay: 420,
      theme: "os-theme-nocturne",
    },
  } as const;
  const columnsMotionDurationMs = 480;
  const columnsMotionEasing = "cubic-bezier(0.33, 0, 0.2, 1)";

  onMount(() => {
    const removeNativeMarqueeListeners = installNativeMarqueeListeners();
    const removeTreeScrollListener = installTreeVisibleScrollListener();
    if (!hasTauriRuntime()) {
      return () => {
        removeNativeMarqueeListeners();
        removeTreeScrollListener();
        clearColumnsMotionCleanup();
      };
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          dragHover = true;
          externalDropTargetPath = directoryDropTargetFromPosition(event.payload.position?.x, event.payload.position?.y);
          return;
        }
        if (event.payload.type === "leave") {
          dragHover = false;
          externalDropTargetPath = null;
          return;
        }
        dragHover = false;
        const explicitDirectoryPath = directoryDropTargetFromPosition(event.payload.position?.x, event.payload.position?.y);
        externalDropTargetPath = null;
        void uploadDroppedPaths(event.payload.paths, explicitDirectoryPath).catch((error) => {
          operationError = error instanceof Error ? error.message : String(error);
        });
      })
      .then((dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        unlisten = dispose;
      })
      .catch((error) => {
        operationError = error instanceof Error ? error.message : String(error);
      });
    return () => {
      disposed = true;
      removeNativeMarqueeListeners();
      removeTreeScrollListener();
      removeMarqueeWindowListeners();
      clearColumnsMotionCleanup();
      clearTreeVisibleFrame();
      unlisten?.();
    };
  });

  onMount(() => {
    function retryAfterWorkspaceVerification(event: Event) {
      const detail = (event as CustomEvent<FilesWorkspaceSshVerificationSubmittedDetail>).detail;
      if (detail?.workspaceId !== workspaceId) return;
      if (!filesError && !filesLoading) return;
      void loadFilesForPath(path ?? result?.provider.current_path ?? null, {
        hostId: toolTab.host_id,
        toolTabId: toolTab.id,
        force: true,
      });
    }
    window.addEventListener(FILES_WORKSPACE_SSH_VERIFICATION_SUBMITTED_EVENT, retryAfterWorkspaceVerification);
    return () => {
      window.removeEventListener(FILES_WORKSPACE_SSH_VERIFICATION_SUBMITTED_EVENT, retryAfterWorkspaceVerification);
    };
  });

  onMount(() => {
    if (!hasTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<TransferQueueChangedEvent>("transfer://changed", (event) => {
      if (disposed) return;
      void refreshForCompletedUploads(event.payload.snapshot).catch((error) => {
        operationError = error instanceof Error ? error.message : String(error);
      });
    })
      .then((dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        unlisten = dispose;
      })
      .catch((error) => {
        operationError = error instanceof Error ? error.message : String(error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  });

  const result = $derived(filesResult);
  const currentPath = $derived(result?.provider.current_path ?? toolTab.title);
  const entries = $derived((result?.entries ?? []).filter((entry) => showHidden || !entry.name.startsWith(".")));
  const visibleTreeChildrenByPath = $derived(filterEntriesByVisibility(treeChildrenByPath));
  const treeRootModel = $derived(
    buildFileTreeRootModel({
      rootPath: result?.provider.root_path ?? currentPath,
      currentPath,
      currentEntries: entries,
      childrenByPath: visibleTreeChildrenByPath,
    }),
  );
  const treeRows = $derived(
    buildFileTreeRows({
      rootEntries: treeRootModel.rootEntries,
      childrenByPath: treeRootModel.childrenByPath,
      expandedPaths: recordKeySet(expandedTreePaths),
      loadingPaths: recordKeySet(treeLoadingByPath),
      errorByPath: recordStringMap(treeErrorByPath),
    }),
  );
  const selectedPath = $derived.by(() => {
    selectionRevision;
    return selection.activePath;
  });
  const selectedEntry = $derived(findEntryByPath(selectedPath) ?? null);
  const selectedEntries = $derived.by(() => {
    selectionRevision;
    return selection.selectedPaths.map((selected) => findEntryByPath(selected)).filter((entry): entry is FileEntry => entry !== null);
  });
  const fileColumns = $derived(
    buildFilesColumnsView({
      rootPath: result?.provider.root_path ?? currentPath,
      currentPath,
      selectedPath,
      activeEntries: entries,
      childrenByPath: visibleTreeChildrenByPath,
    }),
  );
  const visibleToolbarActionIds = $derived(normalizeFilesToolbarActionIds(toolbarActionIds));
  const focusedDirectoryPath = $derived(focusedFilesDirectoryPath());
  const selectionSummary = $derived(selectedEntries.length === 0 ? "" : `${selectedEntries.length} ${selectedEntries.length === 1 ? "item" : "items"} selected`);
  const treeStickySettings = $derived(normalizeFilesTreeStickySettings({ enabled: treeStickyEnabled, maxLevels: treeStickyMaxLevels }));
  const treeStickyRows = $derived(
    filesTreeStickyAncestors({
      rows: treeRows,
      firstVisiblePath: firstVisibleTreePath || selectedPath || treeRows[0]?.entry.path || "",
      maxLevels: treeStickySettings.maxLevels,
      enabled: treeStickySettings.enabled,
    }),
  );

  const previewQuery = createQuery(() => ({
    queryKey: ["files", "preview", workspaceId, toolTab.id, toolTab.host_id, previewPath, textPreviewLimitBytes, imagePreviewLimitBytes],
    enabled: Boolean(previewPath),
    queryFn: () =>
      unwrapCommand(
        commands.previewFile({
          path: previewPath,
          text_limit_bytes: textPreviewLimitBytes,
          image_limit_bytes: imagePreviewLimitBytes,
          ...providerCommandAuth(),
        }),
      ),
    staleTime: 8_000,
  }));

  const previewResult = $derived(previewQuery.data as FilePreviewResult | undefined);
  const previewVisible = $derived(
    shouldShowFilePreviewRegion({
      selectedPath,
      previewPath,
      preview: previewResult,
    }),
  );
  let remoteHelperChecked = false;

  $effect(() => {
    const targetPath = path;
    const hostId = toolTab.host_id;
    const toolTabId = toolTab.id;
    if (!hasTauriRuntime()) return;
    void loadFilesForPath(targetPath, { hostId, toolTabId });
  });

  $effect(() => {
    if (!path && result?.provider.current_path) {
      viewState.path = result.provider.current_path;
    }
    if (!initialDirectoryFocusPath && result?.provider.current_path) {
      initialDirectoryFocusPath = normalizeFilePath(result.provider.current_path);
    }
  });

  $effect(() => {
    if (!result?.provider.root_path || !result.provider.current_path) return;
    const plan = filesTreeInitialFocusPlan({
      rootPath: result.provider.root_path,
      focusPath: result.provider.current_path,
      collapsedPaths: recordKeySet(userCollapsedTreePaths),
    });
    if (plan.expandPaths.every((directoryPath) => expandedTreePaths[directoryPath])) return;
    viewState.expandedTreePaths = {
      ...Object.fromEntries(plan.expandPaths.map((directoryPath) => [directoryPath, true])),
      ...expandedTreePaths,
    };
  });

  $effect(() => {
    if (viewMode !== "tree" || !result?.provider.root_path || !result.provider.current_path) return;
    const plan = filesTreeInitialFocusPlan({
      rootPath: result.provider.root_path,
      focusPath: result.provider.current_path,
      collapsedPaths: recordKeySet(userCollapsedTreePaths),
    });
    const preloadKey = `${result.provider.root_path}\u001f${result.provider.current_path}\u001f${plan.expandPaths.join("\u001e")}`;
    if (treeAncestorPreloadKey === preloadKey) return;
    treeAncestorPreloadKey = preloadKey;
    void preloadTreeFocusedAncestorDirectories(plan.expandPaths).catch((error) => {
      operationError = error instanceof Error ? error.message : String(error);
    });
  });

  $effect(() => {
    if (viewModeInitialized) return;
    if (!viewState.viewMode) viewState.viewMode = defaultViewMode;
    viewModeInitialized = true;
  });

  $effect(() => {
    if (viewMode !== "columns") return;
    syncColumnsPanes(fileColumns);
  });

  $effect(() => {
    if (viewMode !== "columns" || !result?.provider.root_path || !result.provider.current_path) return;
    const preloadKey = `${result.provider.root_path}\u001f${result.provider.current_path}`;
    if (columnsAncestorPreloadKey === preloadKey) return;
    columnsAncestorPreloadKey = preloadKey;
    void preloadColumnsAncestorDirectories(result.provider.root_path, result.provider.current_path).catch((error) => {
      operationError = error instanceof Error ? error.message : String(error);
    });
  });

  $effect(() => {
    treeRows;
    if (viewMode !== "tree") return;
    scheduleFirstVisibleTreePathUpdate();
    scheduleTreeInitialFocusScroll();
  });

  $effect(() => {
    if (viewMode === "columns" && previewVisible) scheduleColumnsScrollToActiveWindow();
  });

  async function refresh() {
    const expandedDirectories = Object.entries(expandedTreePaths)
      .filter(([, expanded]) => expanded)
      .map(([directoryPath]) => directoryPath);
    await queryClient.invalidateQueries({ queryKey: ["files", "list", toolTab.id] });
    await loadFilesForPath(path ?? result?.provider.current_path ?? null, { hostId: toolTab.host_id, toolTabId: toolTab.id, force: true });
    await Promise.all(expandedDirectories.map((directoryPath) => reloadDirectoryChildren(directoryPath)));
  }

  async function refreshForCompletedUploads(snapshot: TransferQueueSnapshot) {
    const completedUploads = snapshot.tasks.filter((task) => isCompletedUploadForThisFilesTool(task));
    const freshTasks = completedUploads.filter((task) => !handledCompletedTransferIds.has(task.id));
    if (freshTasks.length === 0) return;
    handledCompletedTransferIds = new Set([...handledCompletedTransferIds, ...freshTasks.map((task) => task.id)]);
    const changedDirectories = new Set(freshTasks.map((task) => parentPathOf(task.destination.path)));
    await refreshVisibleDirectoriesPreservingState(changedDirectories);
  }

  async function refreshVisibleDirectoriesPreservingState(changedDirectories: ReadonlySet<string>) {
    const expandedDirectories = Object.entries(expandedTreePaths)
      .filter(([, expanded]) => expanded)
      .map(([directoryPath]) => directoryPath)
      .filter((directoryPath) => changedDirectories.has(directoryPath) || hasChangedAncestor(directoryPath, changedDirectories));
    const currentDirectory = path ?? result?.provider.current_path ?? null;
    if (currentDirectory && (changedDirectories.has(currentDirectory) || hasChangedAncestor(currentDirectory, changedDirectories))) {
      await queryClient.invalidateQueries({ queryKey: ["files", "list", toolTab.id, toolTab.host_id, currentDirectory] });
      await loadFilesForPath(currentDirectory, { hostId: toolTab.host_id, toolTabId: toolTab.id, force: true, preserveLoadingState: true });
    }
    await Promise.all(expandedDirectories.map((directoryPath) => reloadDirectoryChildren(directoryPath)));
  }

  async function refreshAfterMutation() {
    resetFilesToolSelection(toolTab.id);
    viewState.lastSelectedEntry = null;
    viewState.previewPath = "";
    searchResult = null;
    await refresh();
  }

  async function refreshTransfers() {
    await queryClient.invalidateQueries({ queryKey: ["transfers", "queue"] });
  }

  async function loadFilesForPath(
    targetPath: string | null,
    options: { hostId: string; toolTabId: string; force?: boolean; preserveLoadingState?: boolean },
  ) {
    const generation = ++filesLoadGeneration;
    if (!options.preserveLoadingState) filesLoading = true;
    filesError = null;
    try {
      const next = await queryClient.fetchQuery({
        queryKey: ["files", "list", options.toolTabId, options.hostId, targetPath],
        queryFn: () =>
          unwrapCommand(
            commands.listFiles({
              path: targetPath,
              ...providerCommandAuth(),
            }),
          ),
        staleTime: options.force ? 0 : 8_000,
      });
      if (generation !== filesLoadGeneration) return;
      viewState.filesResult = next;
      filesLoading = false;
    } catch (error) {
      if (generation !== filesLoadGeneration) return;
      if (isFilesWorkspaceVerificationPendingError(error)) {
        filesError = error;
        filesLoading = true;
        return;
      }
      filesError = error;
      filesLoading = false;
    }
  }

  async function runSearch() {
    const query = searchQuery.trim();
    if (!query) {
      operationError = "Search query cannot be empty.";
      return;
    }
    searchLoading = true;
    operationError = "";
    try {
      if (result?.provider.kind === "sftp" && !remoteHelperChecked) {
        remoteHelperChecked = true;
        const helper = await unwrapCommand(
          commands.remoteSearchHelperInfo({
            ...providerCommandAuth(),
          }),
        );
        if (!helper.available && searchMode === "name") {
          const choice = await message(
            `${helper.reason ?? "A remote search helper is not available."}\n\nUse SFTP scan for this search?`,
            {
              title: "Remote Search Helper",
              kind: "warning",
              buttons: {
                yes: "Use SFTP Scan",
                no: "Cancel",
                cancel: "Cancel",
              },
            },
          );
          if (choice !== "Use SFTP Scan") return;
        }
      }
      searchResult = await unwrapCommand(
        commands.searchFiles({
          root_path: currentPath,
          query,
          mode: searchMode,
          include_hidden: showHidden,
          ignore_ignore_files: searchIgnoreIgnoreFiles,
          follow_symlinks: searchFollowSymlinks,
          max_results: 500,
          ...providerCommandAuth(),
        }),
      );
    } finally {
      searchLoading = false;
    }
  }

  function clearSearch() {
    searchResult = null;
    searchQuery = "";
    searchOpen = false;
  }

  function openEntry(entry: FileEntry) {
    applySingleEntrySelection(entry);
    if (entry.kind !== "directory") return;
    viewState.path = entry.path;
    searchResult = null;
    viewState.previewPath = "";
  }

  function openColumnsEntry(entry: FileEntry) {
    if (entry.kind === "directory") return;
    openEntry(entry);
  }

  async function activateTreeEntry(entry: FileEntry) {
    if (fileTreeDoubleClickAction(entry) === "ignore-directory") return;
    applySingleEntrySelection(entry);
  }

  async function clickTreeEntry(entry: FileEntry, event?: MouseEvent) {
    applyEntrySelection(entry, treeRows.map((row) => row.entry.path), event);
    if (fileTreeClickAction(entry, event?.detail ?? 1) === "toggle-directory") {
      await toggleTreeDirectory(entry);
    }
  }

  async function toggleTreeDirectory(entry: FileEntry) {
    if (entry.kind !== "directory") return;
    const normalizedPath = normalizeFilePath(entry.path);
    const willExpand = !expandedTreePaths[normalizedPath];
    viewState.expandedTreePaths = { ...expandedTreePaths, [normalizedPath]: willExpand };
    if (willExpand) {
      const { [normalizedPath]: _expandedAgain, ...remainingCollapsedPaths } = userCollapsedTreePaths;
      viewState.userCollapsedTreePaths = remainingCollapsedPaths;
    } else {
      viewState.userCollapsedTreePaths = { ...userCollapsedTreePaths, [normalizedPath]: true };
    }
    if (!willExpand || treeChildrenByPath[normalizedPath] || treeLoadingByPath[normalizedPath]) {
      return;
    }

    await loadDirectoryChildren(entry);
  }

  async function loadDirectoryChildren(entry: FileEntry) {
    if (entry.kind !== "directory") return null;
    const normalizedPath = normalizeFilePath(entry.path);
    if (treeChildrenByPath[normalizedPath]) return null;
    const existingLoad = directoryChildrenLoadPromises.get(normalizedPath);
    if (existingLoad) {
      return await existingLoad;
    }
    return await reloadDirectoryChildren(entry.path);
  }

  async function reloadDirectoryChildren(directoryPath: string) {
    const normalizedDirectoryPath = normalizeFilePath(directoryPath);
    const existingLoad = directoryChildrenLoadPromises.get(normalizedDirectoryPath);
    if (existingLoad) {
      return await existingLoad;
    }
    const loadPromise = doReloadDirectoryChildren(directoryPath, normalizedDirectoryPath);
    directoryChildrenLoadPromises.set(normalizedDirectoryPath, loadPromise);
    try {
      return await loadPromise;
    } finally {
      directoryChildrenLoadPromises.delete(normalizedDirectoryPath);
    }
  }

  async function doReloadDirectoryChildren(directoryPath: string, normalizedDirectoryPath: string) {
    treeLoadingByPath = { ...treeLoadingByPath, [normalizedDirectoryPath]: true };
    const { [normalizedDirectoryPath]: _previousError, ...remainingErrors } = treeErrorByPath;
    viewState.treeErrorByPath = remainingErrors;
    try {
      const childResult = await unwrapCommand(
        commands.listFiles({
          path: directoryPath,
          ...providerCommandAuth(),
        }),
      );
      viewState.treeChildrenByPath = {
        ...treeChildrenByPath,
        [normalizedDirectoryPath]: childResult.entries,
      };
      return childResult;
    } catch (error) {
      viewState.treeErrorByPath = {
        ...treeErrorByPath,
        [normalizedDirectoryPath]: error instanceof Error ? error.message : String(error),
      };
      return null;
    } finally {
      const { [normalizedDirectoryPath]: _completed, ...remainingLoading } = treeLoadingByPath;
      treeLoadingByPath = remainingLoading;
    }
  }

  function applyCurrentDirectoryResult(childResult: FileListResult | null) {
    if (!childResult) return;
    if (!sameFilePath(viewState.path ?? "", childResult.provider.current_path)) return;
    viewState.filesResult = childResult;
    filesError = null;
    filesLoading = false;
  }

  async function preloadColumnsAncestorDirectories(rootPath: string, currentDirectoryPath: string) {
    const ancestorDirectories = columnAncestorDirectoryPaths(rootPath, currentDirectoryPath);
    for (const directoryPath of ancestorDirectories) {
      const normalizedDirectoryPath = normalizeFilePath(directoryPath);
      if (treeChildrenByPath[normalizedDirectoryPath] || treeLoadingByPath[normalizedDirectoryPath]) continue;
      await reloadDirectoryChildren(directoryPath);
    }
  }

  async function preloadTreeFocusedAncestorDirectories(directoryPaths: readonly string[]) {
    for (const directoryPath of directoryPaths) {
      const normalizedDirectoryPath = normalizeFilePath(directoryPath);
      if (treeChildrenByPath[normalizedDirectoryPath] || treeLoadingByPath[normalizedDirectoryPath]) continue;
      await reloadDirectoryChildren(providerDirectoryRequestPath(directoryPath));
    }
  }

  function openSearchMatch(match: FileSearchResult["matches"][number]) {
    applySelection({
      selectedPaths: [match.path],
      activePath: match.path,
      anchorPath: match.path,
    });
    viewState.lastSelectedEntry = null;
    if (match.kind !== "directory") return;
    viewState.path = match.path;
    clearSearch();
  }

  async function selectEntry(entry: FileEntry, visiblePaths: readonly string[], event?: MouseEvent) {
    blurFilesRowAfterClick(event);
    let selectionScrollOffsets: ReadonlyMap<string, { scrollTop: number; anchorPath: string | null }> | null = null;
    if (viewMode === "columns") {
      const capturedScrollOffsets = captureColumnsScrollOffsets();
      if (hasMeaningfulColumnsScrollOffsets(capturedScrollOffsets)) {
        selectionScrollOffsets = capturedScrollOffsets;
        pendingColumnsScrollOffsets = selectionScrollOffsets;
      }
    }
    const columnsMotionHint = classifyColumnsSelectionMotion(entry);
    pendingColumnsMotionHint = columnsMotionHint;
    pendingColumnsReplaceWithoutMotionPath = columnsMotionHint === "none" && entry.kind === "directory" ? normalizeFilePath(entry.path) : null;
    pendingColumnsFocusWindowPath = columnsSelectionFocusWindowPath(entry, event);
    try {
      const shouldLoadBeforeSelection = shouldLoadColumnsDirectoryBeforeSelection(entry, columnsMotionHint);
      if (shouldLoadBeforeSelection) {
        searchResult = null;
        viewState.previewPath = "";
        applyEntrySelection(entry, visiblePaths, event);
        viewState.path = entry.path;
        applyCurrentDirectoryResult(await loadDirectoryChildren(entry));
      } else {
        applyEntrySelection(entry, visiblePaths, event);
        if (viewMode === "columns" && entry.kind === "directory") {
          viewState.path = entry.path;
        }
      }
      if (viewMode === "columns" && entry.kind === "directory" && !shouldLoadBeforeSelection) {
        searchResult = null;
        viewState.previewPath = "";
        applyCurrentDirectoryResult(await loadDirectoryChildren(entry));
      }
    } finally {
      if (selectionScrollOffsets && pendingColumnsScrollOffsets === selectionScrollOffsets) {
        await tick();
        scheduleColumnsScrollRestore(selectionScrollOffsets);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (pendingColumnsScrollOffsets === selectionScrollOffsets) {
              pendingColumnsScrollOffsets = null;
            }
          });
        });
      }
    }
  }

  function applySingleEntrySelection(entry: FileEntry) {
    applySelection({
      selectedPaths: [entry.path],
      activePath: entry.path,
      anchorPath: entry.path,
    });
    viewState.lastSelectedEntry = entry;
    viewState.previewPath = entry.kind === "file" || entry.kind === "symlink" ? entry.path : "";
  }

  function applyEntrySelection(entry: FileEntry, visiblePaths: readonly string[], event?: MouseEvent) {
    const next = selectFilesEntry(selection, {
      path: entry.path,
      visiblePaths,
      ctrlKey: event?.ctrlKey,
      metaKey: event?.metaKey,
      shiftKey: event?.shiftKey,
    });
    applySelection(next);
    viewState.lastSelectedEntry = entry;
    viewState.previewPath = entry.kind === "file" || entry.kind === "symlink" ? entry.path : "";
  }

  function applySelection(next: typeof selection) {
    selection.selectedPaths = next.selectedPaths;
    selection.activePath = next.activePath;
    selection.anchorPath = next.anchorPath;
    selectionRevision += 1;
  }

  function shouldLoadColumnsDirectoryBeforeSelection(entry: FileEntry, columnsMotionHint: ColumnsMotionHint | null) {
    if (viewMode !== "columns" || entry.kind !== "directory") return false;
    if (columnsMotionHint === "forward" || columnsMotionHint === "backward") return true;
    return !treeChildrenByPath[normalizeFilePath(entry.path)];
  }

  function handleFilesRowPointerDown(event: PointerEvent | MouseEvent) {
    event.stopPropagation();
    event.preventDefault();
  }

  function blurFilesRowAfterClick(event?: MouseEvent) {
    const currentTarget = event?.currentTarget;
    if (currentTarget instanceof HTMLElement) currentTarget.blur();
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && (activeElement.matches(".column-row") || activeElement.matches(".files-row"))) {
      activeElement.blur();
    }
  }

  function isPathSelected(path: string) {
    selectionRevision;
    return selection.selectedPaths.includes(path);
  }

  function syncColumnsPanes(nextColumns: FilesColumn[]) {
    const nextSignature = columnsSignature(nextColumns);
    if (lastColumnsSignature === nextSignature) return;

    if (!lastColumnsSignature || columnsPanes.length === 0) {
      clearColumnsMotionCleanup();
      columnsMotion = "idle";
      columnsMotionPreparing = false;
      columnsMotionActive = false;
      columnsMotionSettling = false;
      columnsResizeColumnCount = null;
      columnsPanes = [currentColumnsPane(nextColumns)];
      lastColumnsSignature = nextSignature;
      scheduleColumnsScrollToActiveWindow();
      return;
    }

    const previousPane = columnsPanes.find((pane) => pane.current);
    const previousColumns = previousPane?.columns ?? [];
    if (columnsPathSignature(previousColumns) === columnsPathSignature(nextColumns)) {
      if (columnsMotionInFlight()) {
        const scrollOffsets = consumePendingColumnsScrollOffsets();
        columnsPanes = columnsPanes.map((pane) =>
          pane.current
            ? {
                ...pane,
                columns: nextColumns,
                renderColumns: pane.renderColumns ? columnsForMotionWindow(nextColumns) : undefined,
              }
            : pane,
        );
        lastColumnsSignature = nextSignature;
        scheduleColumnsScrollRestore(scrollOffsets);
        scheduleColumnsScrollToSelectedDirectoryWindow(nextColumns);
        return;
      }
      const scrollOffsets = consumePendingColumnsScrollOffsets();
      clearColumnsMotionCleanup();
      columnsMotion = "idle";
      columnsMotionPreparing = false;
      columnsMotionActive = false;
      columnsMotionSettling = false;
      columnsResizeColumnCount = null;
      columnsPanes = [currentColumnsPane(nextColumns)];
      lastColumnsSignature = nextSignature;
      clearSettledColumnsNavigationPendingState();
      scheduleColumnsScrollRestore(scrollOffsets);
      scheduleColumnsScrollToSelectedDirectoryWindow(nextColumns);
      return;
    }
    if (shouldReplaceColumnsWithoutMotion(previousColumns, nextColumns)) {
      if (visibleColumnsWindowCount(previousColumns) !== visibleColumnsWindowCount(nextColumns)) {
        startColumnsResizeMotion(previousColumns, nextColumns, nextSignature);
        return;
      }
      const scrollOffsets = consumePendingColumnsScrollOffsets();
      clearColumnsMotionCleanup();
      columnsMotion = "idle";
      columnsMotionPreparing = false;
      columnsMotionActive = false;
      columnsMotionSettling = false;
      columnsResizeColumnCount = null;
      columnsPanes = [currentColumnsPane(nextColumns)];
      lastColumnsSignature = nextSignature;
      clearPendingColumnsMotionHintIfSettled(nextColumns);
      clearSettledColumnsNavigationPendingState();
      scheduleColumnsScrollRestore(scrollOffsets);
      return;
    }
    if (visibleColumnsWindowCount(previousColumns) !== visibleColumnsWindowCount(nextColumns)) {
      startColumnsResizeMotion(previousColumns, nextColumns, nextSignature);
      return;
    }

    const previousSignature = lastColumnsSignature;
    const direction = pendingColumnsMotionHint === "forward" || pendingColumnsMotionHint === "backward" ? pendingColumnsMotionHint : inferColumnsMotion(previousColumns, nextColumns);
    pendingColumnsMotionHint = null;
    const generation = ++columnsMotionGeneration;
    const motionWindow = columnsForSlideMotionWindow(previousColumns, nextColumns, direction);
    const previousRenderColumns = motionWindow?.previous ?? columnsForMotionWindow(previousColumns);
    const currentRenderColumns = motionWindow?.current ?? columnsForMotionWindow(nextColumns);
    const previous = {
      id: `previous:${generation}:${previousSignature}`,
      columns: previousColumns,
      renderColumns: previousRenderColumns,
      current: false,
    };
    const current = {
      id: `current:${generation}:${nextSignature}`,
      columns: nextColumns,
      renderColumns: currentRenderColumns,
      current: true,
    };

    clearColumnsMotionCleanup();
    columnsMotionSettling = false;
    columnsMotion = direction;
    columnsMotionDistance = motionWindow?.distance ?? "100%";
    columnsMotionTranslate = direction === "backward" ? negativeColumnsMotionDistance(columnsMotionDistance) : "0px";
    columnsResizeColumnCount = null;
    columnsMotionPreparing = true;
    columnsMotionActive = false;
    columnsPanes = direction === "backward" ? [current, previous] : [previous, current];
    lastColumnsSignature = nextSignature;

    flushSync();
    resetColumnsHorizontalScroll();
    forceColumnsMotionLayout();
    startColumnsSlideMotionFrame(generation, direction, nextColumns);
  }

  function startColumnsSlideMotionFrame(generation: number, direction: Exclude<ColumnsMotion, "idle" | "resize">, nextColumns: FilesColumn[]) {
    clearColumnsMotionFinishTimer();
    const distance = columnsMotionDistancePixels();
    const from = direction === "forward" ? 0 : -distance;
    const to = direction === "forward" ? -distance : 0;
    columnsMotionTransition = "none";
    columnsMotionTranslate = `${from}px`;
    columnsMotionPreparing = true;
    columnsMotionActive = false;
    flushSync();
    const content = applyColumnsMotionElementStyle(`${from}px`, "none");
    if (content) void content.offsetWidth;
    columnsMotionTranslate = `${to}px`;
    columnsMotionPreparing = false;
    columnsMotionActive = true;
    flushSync();
    const activeContent = applyColumnsMotionElementStyle(`${to}px`, "none");
    if (activeContent) void activeContent.offsetWidth;
    columnsMotionFinishTimer = window.setTimeout(() => {
      finishColumnsSlideMotion(generation, nextColumns);
    }, columnsMotionDurationMs + 120);
  }

  function finishColumnsSlideMotion(generation: number, nextColumns: FilesColumn[]) {
    if (columnsMotionGeneration !== generation) return;
    clearColumnsMotionFinishTimer();
    const finalPane = columnsPanes.find((pane) => pane.current);
    const finalColumns = finalPane?.columns ?? nextColumns;
    columnsMotionSettling = true;
    columnsPanes = [{ ...currentColumnsPane(finalColumns), renderColumns: columnsForMotionWindow(finalColumns) }];
    columnsMotion = "idle";
    columnsMotionDistance = "100%";
    columnsMotionTranslate = "0px";
    columnsMotionTransition = "none";
    applyColumnsMotionElementStyle("0px", "none");
    columnsResizeColumnCount = null;
    columnsMotionPreparing = false;
    columnsMotionActive = false;
    void tick().then(() => {
      if (columnsMotionGeneration !== generation) return;
      columnsPanes = [currentColumnsPane(finalColumns)];
      return tick();
    }).then(() => {
      if (columnsMotionGeneration !== generation) return;
      scrollColumnsViewToActiveWindow();
      requestAnimationFrame(() => {
        if (columnsMotionGeneration !== generation) return;
        columnsMotionSettling = false;
        scheduleColumnsScrollToActiveWindow();
      });
    });
  }

  function columnsMotionDistancePixels() {
    const view = filesRoot?.querySelector<HTMLElement>(".columns-view");
    const width = view?.getBoundingClientRect().width ?? 0;
    if (columnsMotionDistance === "calc(100% / 3)") return width / 3;
    if (columnsMotionDistance === "calc(100% / 6)") return width / 6;
    return width;
  }

  function negativeColumnsMotionDistance(distance: string) {
    if (distance === "100%") return "-100%";
    if (distance === "calc(100% / 3)") return "calc(-100% / 3)";
    if (distance === "calc(100% / 6)") return "calc(-100% / 6)";
    return `calc(-1 * ${distance})`;
  }

  function columnsMotionDistanceClass(distance: string) {
    if (distance === "calc(100% / 3)") return "third";
    if (distance === "calc(100% / 6)") return "sixth";
    return "full";
  }

  function columnsMotionContentElement() {
    return filesRoot?.querySelector<HTMLElement>(".columns-view .columns-content") ?? null;
  }

  function applyColumnsMotionElementStyle(translate: string, transition: string) {
    const content = columnsMotionContentElement();
    if (!content) return null;
    content.style.setProperty("transition", transition);
    content.style.setProperty("transform", `translateX(${translate})`);
    void content.offsetWidth;
    return content;
  }

  function startColumnsResizeMotion(previousColumns: FilesColumn[], nextColumns: FilesColumn[], nextSignature: string) {
    const generation = ++columnsMotionGeneration;
    const scrollOffsets = consumePendingColumnsScrollOffsets();
    clearColumnsMotionCleanup();
    columnsMotionSettling = false;
    columnsMotion = "resize";
    columnsMotionDistance = "100%";
    columnsMotionPreparing = true;
    columnsMotionActive = false;
    columnsResizeColumnCount = Math.max(1, previousColumns.length);
    columnsPanes = [currentColumnsPane(nextColumns)];
    lastColumnsSignature = nextSignature;
    pendingColumnsMotionHint = null;
    void tick().then(() => {
      if (columnsMotionGeneration !== generation) return;
      restoreColumnsScrollOffsets(scrollOffsets);
      requestAnimationFrame(() => {
        if (columnsMotionGeneration !== generation) return;
        columnsMotionPreparing = false;
        columnsMotionActive = true;
        columnsResizeColumnCount = null;
        void tick().then(() => {
          if (columnsMotionGeneration !== generation) return;
          restoreColumnsScrollOffsets(scrollOffsets);
          scheduleColumnsScrollRestore(scrollOffsets);
          clearColumnsMotionFinishTimer();
          columnsMotionFinishTimer = window.setTimeout(() => {
            if (columnsMotionGeneration !== generation) return;
            columnsMotionFinishTimer = null;
            columnsMotion = "idle";
            columnsMotionDistance = "100%";
            columnsMotionPreparing = false;
            columnsMotionActive = false;
            columnsResizeColumnCount = null;
            scheduleColumnsScrollToActiveWindow();
          }, columnsMotionDurationMs + 40);
        });
      });
    });
  }

  function columnsMotionInFlight() {
    return columnsMotionPreparing || columnsMotionActive || columnsMotionFinishTimer !== null;
  }

  function shouldReplaceColumnsWithoutMotion(previous: readonly FilesColumn[], next: readonly FilesColumn[]) {
    if (pendingColumnsMotionHint === "none") return true;
    if (pendingColumnsMotionHint === "forward" || pendingColumnsMotionHint === "backward") return false;
    if (
      pendingColumnsReplaceWithoutMotionPath &&
      next.some((column) => sameFilePath(column.path, pendingColumnsReplaceWithoutMotionPath ?? ""))
    ) {
      return true;
    }
    const columnsSelectedEntry = selectedEntryForColumnsMotion();
    if (!previous.length || !next.length || !columnsSelectedEntry) return false;
    if (columnsSelectedEntry.kind !== "directory") return true;

    const previousLastPath = previous[previous.length - 1]?.path;
    if (!previousLastPath) return false;
    if (sameFilePath(columnsSelectedEntry.path, previousLastPath)) return true;
    if (pathDescendsFrom(columnsSelectedEntry.path, previousLastPath)) return false;
    if (pathDescendsFrom(previousLastPath, columnsSelectedEntry.path)) return false;
    return true;

  }

  function clearSettledColumnsNavigationPendingState() {
    pendingColumnsMotionHint = null;
    pendingColumnsFocusWindowPath = null;
    pendingColumnsReplaceWithoutMotionPath = null;
  }

  function classifyColumnsSelectionMotion(entry: FileEntry): ColumnsMotionHint | null {
    if (viewMode !== "columns") return null;
    if (entry.kind !== "directory") return "none";

    const currentColumns = columnsForMotionBasis();
    const previousLastPath = currentColumns[currentColumns.length - 1]?.path;
    if (!previousLastPath) return null;
    if (sameFilePath(entry.path, previousLastPath)) return "none";
    if (pathDescendsFrom(previousLastPath, entry.path)) return "backward";

    const entryColumnIndex = currentColumns.findIndex((column) => column.entries.some((columnEntry) => sameFilePath(columnEntry.path, entry.path)));
    const visibleColumnCount = visibleColumnsWindowCount(currentColumns);
    const visibleStartIndex = Math.max(0, currentColumns.length - visibleColumnCount);
    const entryColumnPath = currentColumns[entryColumnIndex]?.path ?? "";
    if (
      visibleColumnCount === 3 &&
      entryColumnIndex === visibleStartIndex &&
      !sameFilePath(entryColumnPath, currentPath) &&
      !sameFilePath(entryColumnPath, initialDirectoryFocusPath)
    ) {
      return "backward";
    }
    if (entryColumnIndex >= 0 && entryColumnIndex < currentColumns.length - 1) {
      return "none";
    }
    return entryColumnIndex === currentColumns.length - 1 ? "forward" : "none";
  }

  function columnsForMotionBasis() {
    return columnsPanes.find((pane) => pane.current)?.columns ?? fileColumns;
  }

  function columnsSelectionFocusWindowPath(entry: FileEntry, event?: MouseEvent) {
    if (viewMode !== "columns" || entry.kind !== "directory") return null;
    const clickedColumn = event?.currentTarget instanceof HTMLElement ? event.currentTarget.closest<HTMLElement>(".file-column") : null;
    const columnsView = clickedColumn?.closest<HTMLElement>(".columns-view");
    const currentPane = columnsView?.querySelector<HTMLElement>(".columns-pane.current") ?? columnsView;
    if (clickedColumn && columnsView && currentPane) {
      const viewRect = columnsView.getBoundingClientRect();
      const visibleColumns = [...currentPane.querySelectorAll<HTMLElement>(".file-column")].filter((column) => {
        const rect = column.getBoundingClientRect();
        return Math.max(0, Math.min(rect.right, viewRect.right) - Math.max(rect.left, viewRect.left)) >= 40;
      });
      if (visibleColumns.length >= 3 && visibleColumns[0] === clickedColumn) {
        const clickedColumnPath = clickedColumn.getAttribute("aria-label");
        if (!clickedColumnPath) throw new Error("Columns view column is missing its path label");
        return clickedColumnPath;
      }
    }

    const currentColumns = columnsForMotionBasis();
    const visibleColumnCount = visibleColumnsWindowCount(currentColumns);
    if (visibleColumnCount < 3) return null;
    const visibleStartIndex = Math.max(0, currentColumns.length - visibleColumnCount);
    const entryColumnIndex = currentColumns.findIndex((column) => column.entries.some((columnEntry) => sameFilePath(columnEntry.path, entry.path)));
    return entryColumnIndex === visibleStartIndex ? currentColumns[entryColumnIndex].path : null;
  }

  function clearPendingColumnsMotionHintIfSettled(columns: readonly FilesColumn[]) {
    if (!pendingColumnsMotionHint) return;
    const columnsSelectedEntry = selectedEntryForColumnsMotion();
    if (!columnsSelectedEntry || columnsSelectedEntry.kind !== "directory" || columns.some((column) => sameFilePath(column.path, columnsSelectedEntry.path))) {
      pendingColumnsMotionHint = null;
      pendingColumnsFocusWindowPath = null;
      if (pendingColumnsReplaceWithoutMotionPath && sameFilePath(currentPath, pendingColumnsReplaceWithoutMotionPath)) {
        pendingColumnsReplaceWithoutMotionPath = null;
      }
    }
  }

  function selectedEntryForColumnsMotion() {
    if (lastSelectedEntry && sameFilePath(lastSelectedEntry.path, selectedPath)) return lastSelectedEntry;
    return selectedEntry;
  }

  function currentColumnsPane(columns: FilesColumn[]): ColumnsPane {
    return {
      id: currentColumnsPaneId(),
      columns,
      current: true,
    };
  }

  function currentColumnsPaneId() {
    return "current";
  }

  function columnsRenderKey(path: string) {
    return `column:${path}`;
  }

  function previewColumnRenderKey() {
    return "preview";
  }

  function columnsPaneColumnCount(pane: ColumnsPane) {
    if (pane.current && columnsMotion === "resize" && columnsResizeColumnCount !== null) {
      return columnsResizeColumnCount;
    }
    return columnsForRenderedPane(pane).length + (previewVisible && pane.current ? 1 : 0);
  }

  function visibleColumnsWindowCount(columns: readonly FilesColumn[]) {
    return Math.min(columns.length, 3);
  }

  function columnsForRenderedPane(pane: ColumnsPane) {
    return columnsForVisiblePane(pane.renderColumns ?? pane.columns, { previewVisible: previewVisible && pane.current });
  }

  function columnsForMotionWindow(columns: readonly FilesColumn[]) {
    const count = visibleColumnsWindowCount(columns);
    const start = preferredColumnsWindowStart(columns, count);
    return columns.slice(start, start + count);
  }

  function preferredColumnsWindowStart(columns: readonly FilesColumn[], count = visibleColumnsWindowCount(columns)) {
    const fallback = Math.max(0, columns.length - count);
    if (!pendingColumnsFocusWindowPath) return fallback;
    const selectedColumnIndex = columns.findIndex((column) => sameFilePath(column.path, pendingColumnsFocusWindowPath ?? ""));
    if (selectedColumnIndex < 0) return fallback;
    const maxStart = Math.max(0, columns.length - count);
    return Math.min(Math.max(0, selectedColumnIndex - 1), maxStart);
  }

  function columnsForSlideMotionWindow(previous: readonly FilesColumn[], next: readonly FilesColumn[], direction: ColumnsMotion): ColumnsSlideMotionWindow | null {
    if (direction !== "backward") return null;
    const previousPaths = previous.map((column) => normalizeFilePath(column.path));
    const nextPaths = next.map((column) => normalizeFilePath(column.path));
    if (previousPaths.length < 3 || nextPaths.length < 3) return null;

    if (sameStringArray(previousPaths.slice(-3, -1), nextPaths.slice(-2))) {
      return {
        previous: previous.slice(-1),
        current: next.slice(-3),
        distance: "calc(100% / 3)",
      };
    }

    if (sameFilePath(previousPaths[previousPaths.length - 3] ?? "", nextPaths[nextPaths.length - 2] ?? "")) {
      return {
        previous: previous.slice(-3),
        current: next.slice(-3),
        distance: "calc(100% / 6)",
      };
    }

    return null;
  }

  function columnsSignature(columns: readonly FilesColumn[]) {
    return columns
      .map((column) => `${column.path}\u001e${column.entries.map((entry) => `${entry.path}:${entry.selected ? "1" : "0"}`).join("\u001d")}`)
      .join("\u001f");
  }

  function columnsPathSignature(columns: readonly FilesColumn[]) {
    return columns.map((column) => column.path).join("\u001f");
  }

  function inferColumnsMotion(previous: readonly FilesColumn[], next: readonly FilesColumn[]): Exclude<ColumnsMotion, "idle" | "resize"> {
    const previousPaths = previous.map((column) => column.path);
    const nextPaths = next.map((column) => column.path);
    if (sameStringArray(previousPaths.slice(1), nextPaths.slice(0, -1))) return "forward";
    if (sameStringArray(nextPaths.slice(1), previousPaths.slice(0, -1))) return "backward";
    return nextPaths.length >= previousPaths.length ? "forward" : "backward";
  }

  function sameStringArray(left: readonly string[], right: readonly string[]) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }

  function sameFilePath(left: string, right: string) {
    return normalizeFilePath(left) === normalizeFilePath(right);
  }

  function pathDescendsFrom(pathValue: string, parentValue: string) {
    const path = normalizeFilePath(pathValue);
    const parent = normalizeFilePath(parentValue);
    if (!path || !parent || path === parent) return false;
    if (parent === "/") return path.startsWith("/") || /^[A-Za-z]:(?:\/|$)/.test(path);
    const parentPrefix = parent.endsWith("/") ? parent : `${parent}/`;
    return path.startsWith(parentPrefix);
  }

  function normalizeFilePath(value: string) {
    const withForwardSlashes = value.replace(/\\/g, "/");
    if (/^[A-Za-z]:\/?$/.test(withForwardSlashes)) return `${withForwardSlashes.slice(0, 2)}/`;
    return withForwardSlashes.replace(/\/+$/, "") || "/";
  }

  function columnAncestorDirectoryPaths(rootPath: string, currentDirectoryPath: string) {
    const root = normalizeFilePath(rootPath) || "/";
    const current = normalizeFilePath(currentDirectoryPath);
    const chain = columnsForPath(current).map(normalizeFilePath);
    const fullChain = root === "/" && /^[A-Za-z]:(?:\/|$)/.test(current) ? [root, ...chain] : chain;
    return fullChain.slice(0, -1).map(providerDirectoryRequestPath);
  }

  function providerDirectoryRequestPath(pathValue: string) {
    return /^[A-Za-z]:$/.test(pathValue) ? `${pathValue}/` : pathValue;
  }

  function clearColumnsMotionCleanup() {
    clearColumnsMotionFinishTimer();
    columnsMotionPreparing = false;
    columnsMotionActive = false;
    columnsMotionSettling = false;
    columnsResizeColumnCount = null;
    columnsMotionTranslate = "0px";
    columnsMotionTransition = "none";
  }

  function clearColumnsMotionFinishTimer() {
    if (columnsMotionFinishTimer !== null) {
      window.clearTimeout(columnsMotionFinishTimer);
      columnsMotionFinishTimer = null;
    }
  }

  function captureColumnsScrollOffsets() {
    const offsets = new Map<string, { scrollTop: number; anchorPath: string | null }>();
    const columns = filesRoot?.querySelectorAll<HTMLElement>(".columns-view .columns-pane.current .file-column") ?? [];
    for (const column of columns) {
      const path = column.getAttribute("aria-label");
      const viewport = columnScrollViewport(column);
      if (path) {
        offsets.set(path, {
          scrollTop: viewport?.scrollTop ?? 0,
          anchorPath: firstVisibleColumnRowPath(column),
        });
      }
    }
    return offsets;
  }

  function consumePendingColumnsScrollOffsets() {
    const offsets = pendingColumnsScrollOffsets ?? captureMeaningfulColumnsScrollOffsets();
    return offsets;
  }

  function captureMeaningfulColumnsScrollOffsets() {
    const offsets = captureColumnsScrollOffsets();
    return hasMeaningfulColumnsScrollOffsets(offsets) ? offsets : new Map<string, { scrollTop: number; anchorPath: string | null }>();
  }

  function hasMeaningfulColumnsScrollOffsets(offsets: ReadonlyMap<string, { scrollTop: number; anchorPath: string | null }>) {
    for (const offset of offsets.values()) {
      if (Math.abs(offset.scrollTop) > 1) return true;
    }
    return false;
  }

  function scheduleColumnsScrollRestore(offsets: ReadonlyMap<string, { scrollTop: number; anchorPath: string | null }>) {
    if (!offsets.size) return;
    let remainingFrames = 4;
    const restore = () => {
      restoreColumnsScrollOffsets(offsets);
      remainingFrames -= 1;
      if (remainingFrames > 0) {
        requestAnimationFrame(restore);
        return;
      }
    };
    requestAnimationFrame(restore);
  }

  function scheduleColumnsScrollToActiveWindow() {
    let waitFrames = 60;
    let remainingFrames = 24;
    const scroll = () => {
      if (columnsMotion === "resize" || columnsMotionPreparing || columnsMotionActive) {
        waitFrames -= 1;
        if (waitFrames > 0) requestAnimationFrame(scroll);
        return;
      }
      scrollColumnsViewToActiveWindow();
      remainingFrames -= 1;
      if (remainingFrames > 0) requestAnimationFrame(scroll);
    };
    requestAnimationFrame(scroll);
  }

  function scheduleColumnsScrollToSelectedDirectoryWindow(columns: readonly FilesColumn[]) {
    const focusPath = pendingColumnsFocusWindowPath;
    if (!focusPath || !columns.some((column) => sameFilePath(column.path, focusPath))) return;
    let remainingFrames = 30;
    const waitForMotion = () => {
      if (columnsMotionInFlight()) {
        remainingFrames -= 1;
        if (remainingFrames > 0) requestAnimationFrame(waitForMotion);
        return;
      }
      scheduleColumnsScrollToActiveWindow();
    };
    requestAnimationFrame(waitForMotion);
  }

  function scrollColumnsViewToActiveWindow() {
    const view = filesRoot?.querySelector<HTMLElement>(".columns-view");
    if (!view) return;
    const scrollTarget = columnsHorizontalScrollTarget(view);
    if (!scrollTarget) return;
    const columns = [...(filesRoot?.querySelectorAll<HTMLElement>(".columns-view .columns-pane.current .file-column") ?? [])];
    const activeColumn = columns.at(-1);
    if (!activeColumn) return;
    const visibleColumnCount = Math.min(columns.length, 3);
    const columnWidth = activeColumn.getBoundingClientRect().width || activeColumn.offsetWidth;
    const renderedPaths = columns.map((column) => column.getAttribute("aria-label") ?? "");
    const selectedColumnIndex = pendingColumnsFocusWindowPath
      ? renderedPaths.findIndex((path) => sameFilePath(path, pendingColumnsFocusWindowPath ?? ""))
      : -1;
    const maxStart = Math.max(0, columns.length - visibleColumnCount);
    const targetStart = selectedColumnIndex >= 0 ? Math.min(Math.max(0, selectedColumnIndex - 1), maxStart) : maxStart;
    const targetScrollLeft = Math.max(0, targetStart * columnWidth);
    scrollTarget.scrollLeft = Math.min(targetScrollLeft, scrollTarget.scrollWidth - scrollTarget.clientWidth);
  }

  function resetColumnsHorizontalScroll() {
    const view = filesRoot?.querySelector<HTMLElement>(".columns-view");
    if (!view) return;
    const scrollTarget = columnsHorizontalScrollTarget(view);
    if (scrollTarget && scrollTarget.scrollLeft !== 0) scrollTarget.scrollLeft = 0;
    if (view.scrollLeft !== 0) view.scrollLeft = 0;
  }

  function forceColumnsMotionLayout() {
    const content = filesRoot?.querySelector<HTMLElement>(".columns-view .columns-content");
    if (!content) return;
    void content.getBoundingClientRect();
  }

  function canWriteScrollLeft(element: HTMLElement) {
    if (element.scrollWidth <= element.clientWidth + 4) return false;
    const original = element.scrollLeft;
    element.scrollLeft = Math.min(32, element.scrollWidth - element.clientWidth);
    const writable = element.scrollLeft > 0;
    element.scrollLeft = original;
    return writable;
  }

  function columnsHorizontalScrollTarget(view: HTMLElement) {
    const candidates = [
      view,
      ...(view.matches("[data-overlayscrollbars-viewport]") ? [] : Array.from(view.querySelectorAll<HTMLElement>("[data-overlayscrollbars-viewport]"))),
      ...Array.from(view.querySelectorAll<HTMLElement>("*")).filter((element) => element.scrollWidth > element.clientWidth + 4),
    ];
    return candidates.find(canWriteScrollLeft) ?? null;
  }

  function restoreColumnsScrollOffsets(offsets: ReadonlyMap<string, { scrollTop: number; anchorPath: string | null }>) {
    const columns = filesRoot?.querySelectorAll<HTMLElement>(".columns-view .columns-pane.current .file-column") ?? [];
    for (const column of columns) {
      const path = column.getAttribute("aria-label");
      if (!path || !offsets.has(path)) continue;
      const viewport = columnScrollViewport(column);
      const offset = offsets.get(path);
      if (!offset) continue;
      if (viewport) viewport.scrollTop = offset.scrollTop;
      if (offset.anchorPath) {
        const anchor = [...column.querySelectorAll<HTMLElement>(".column-row")].find((row) => row.getAttribute("data-entry-path") === offset.anchorPath);
        if (viewport && anchor) {
          const columnRect = column.getBoundingClientRect();
          const anchorRect = anchor.getBoundingClientRect();
          const delta = anchorRect.top - columnRect.top - 32;
          if (Math.abs(delta) > 1) viewport.scrollTop += delta;
        }
      }
    }
  }

  function firstVisibleColumnRowPath(column: HTMLElement) {
    const columnRect = column.getBoundingClientRect();
    const rows = column.querySelectorAll<HTMLElement>(".column-row");
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > columnRect.top + 32 && rect.top < columnRect.bottom - 4) {
        return row.getAttribute("data-entry-path");
      }
    }
    return null;
  }

  function columnScrollViewport(column: HTMLElement) {
    const list = column.querySelector<HTMLElement>(".column-list");
    if (!list) return null;
    const overlayViewport = list.matches("[data-overlayscrollbars-viewport]")
      ? list
      : list.querySelector<HTMLElement>("[data-overlayscrollbars-viewport]");
    if (overlayViewport && canWriteScrollTop(overlayViewport)) return overlayViewport;
    const candidates = [list, ...list.querySelectorAll<HTMLElement>("*")];
    return candidates.find((element) => canWriteScrollTop(element)) ?? list;
  }

  function canWriteScrollTop(element: HTMLElement) {
    if (element.scrollHeight <= element.clientHeight + 4) return false;
    const original = element.scrollTop;
    element.scrollTop = Math.min(32, element.scrollHeight - element.clientHeight);
    const writable = element.scrollTop > 0;
    element.scrollTop = original;
    return writable;
  }

  function formatSize(entry: FileEntry) {
    if (entry.kind === "directory") return "";
    if (!entry.size) return "";
    const value = Number(entry.size);
    if (!Number.isFinite(value)) return entry.size;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }

  function formatModified(entry: FileEntry) {
    if (!entry.modified_unix_ms) return "";
    const value = Number(entry.modified_unix_ms);
    if (!Number.isFinite(value)) return "";
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  }

  function formatPreviewModified(preview: FilePreviewResult) {
    if (!preview.modified_unix_ms) return "";
    const value = Number(preview.modified_unix_ms);
    if (!Number.isFinite(value)) return "";
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  }

  function formatBytes(value: number) {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }

  function formatPreviewSize(preview: FilePreviewResult) {
    if (!preview.size) return "";
    const value = Number(preview.size);
    if (!Number.isFinite(value)) return preview.size;
    return formatBytes(value);
  }

  function previewImageSrc(preview: FilePreviewResult) {
    if (preview.content.kind !== "image") return "";
    return `data:${preview.content.mime};base64,${preview.content.data_base64}`;
  }

  function isMarkdownTextPreview(preview: FilePreviewResult) {
    return preview.content.kind === "text" && isMarkdownPreviewPath(preview.path);
  }

  function markdownPreviewHtml(preview: FilePreviewResult) {
    if (preview.content.kind !== "text") return "";
    return renderMarkdownPreviewHtml(preview.content.text);
  }

  function providerCommandAuth() {
    return {
      workspace_id: workspaceId,
      tool_tab_id: toolTab.id,
      accept_new_host_key: false,
      update_changed_host_key: false,
      credential: null,
      save_credential: false,
    };
  }

  function recordKeySet(record: Readonly<Record<string, boolean>>) {
    return new Set(Object.entries(record).filter(([, enabled]) => enabled).map(([key]) => key));
  }

  function recordStringMap(record: Readonly<Record<string, string>>) {
    return new Map(Object.entries(record));
  }

  function filterEntriesByVisibility(record: Readonly<Record<string, FileEntry[]>>) {
    return Object.fromEntries(
      Object.entries(record).map(([directoryPath, children]) => [
        directoryPath,
        children.filter((entry) => showHidden || !entry.name.startsWith(".")),
      ]),
    );
  }

  function findEntryByPath(value: string) {
    if (!value) return null;
    for (const entry of treeRootModel.rootEntries) {
      if (entry.path === value) return entry;
    }
    for (const entry of entries) {
      if (entry.path === value) return entry;
    }
    for (const children of Object.values(treeRootModel.childrenByPath)) {
      const entry = children.find((child) => child.path === value);
      if (entry) return entry;
    }
    return null;
  }

  function updateFirstVisibleTreePath() {
    const table = filesRoot?.querySelector<HTMLElement>(".files-table");
    if (!table) return;
    const viewport = table.matches("[data-overlayscrollbars-viewport]")
      ? table
      : table.querySelector<HTMLElement>("[data-overlayscrollbars-viewport]");
    const root = viewport ?? table;
    const rootRect = root.getBoundingClientRect();
    const rows = filesRoot?.querySelectorAll<HTMLElement>(".files-table .files-row[data-file-entry='true']:not(.sticky-row)") ?? [];
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > rootRect.top + 2 && rect.top < rootRect.bottom - 2) {
        viewState.firstVisibleTreePath = row.getAttribute("data-entry-path") ?? "";
        return;
      }
    }
  }

  function scheduleFirstVisibleTreePathUpdate() {
    if (treeVisibleFrame !== null) return;
    treeVisibleFrame = requestAnimationFrame(() => {
      treeVisibleFrame = null;
      updateFirstVisibleTreePath();
    });
  }

  function scheduleTreeInitialFocusScroll() {
    if (!result?.provider.current_path) return;
    const focusPath = normalizeFilePath(result.provider.current_path);
    if (!treeRows.some((row) => sameFilePath(row.entry.path, focusPath))) return;
    const scrollKey = `${toolTab.id}\u001f${focusPath}`;
    if (treeInitialFocusScrollKey === scrollKey || treeInitialFocusScrollPendingKey === scrollKey) return;
    treeInitialFocusScrollPendingKey = scrollKey;
    requestAnimationFrame(() => {
      if (treeInitialFocusScrollPendingKey === scrollKey) treeInitialFocusScrollPendingKey = "";
      if (treeInitialFocusScrollKey === scrollKey) return;
      const rows = filesRoot?.querySelectorAll<HTMLElement>(".files-table .files-row[data-file-entry='true']:not(.sticky-row)") ?? [];
      const focusRow = [...rows].find((row) => sameFilePath(row.getAttribute("data-entry-path") ?? "", focusPath));
      if (!focusRow) return;
      treeInitialFocusScrollKey = scrollKey;
      focusRow.scrollIntoView({ block: "center", inline: "nearest" });
      scheduleFirstVisibleTreePathUpdate();
    });
  }

  function clearTreeVisibleFrame() {
    if (treeVisibleFrame === null) return;
    cancelAnimationFrame(treeVisibleFrame);
    treeVisibleFrame = null;
  }

  function installTreeVisibleScrollListener() {
    const handleScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (!target.closest(".files-table")) return;
      scheduleFirstVisibleTreePathUpdate();
    };
    document.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("scroll", handleScroll, true);
      clearTreeVisibleFrame();
    };
  }

  function focusedFilesDirectoryPath() {
    if (selectedEntry) {
      return selectedEntry.kind === "directory" ? selectedEntry.path : parentPathOf(selectedEntry.path);
    }
    return currentPath;
  }

  function parentPathOf(value: string) {
    const slashIndex = value.lastIndexOf("/");
    const backslashIndex = value.lastIndexOf("\\");
    const index = Math.max(slashIndex, backslashIndex);
    if (index < 0) return currentPath;
    if (index === 0) return value[0];
    return value.slice(0, index);
  }

  function isCompletedUploadForThisFilesTool(task: TransferTask) {
    if (task.status !== "completed") return false;
    if (task.destination.kind !== "provider") return false;
    if (task.destination.host_id !== toolTab.host_id) return false;
    if (!result?.provider.kind || task.destination.provider_kind !== result.provider.kind) return false;
    if (!task.related_workspace_ids.includes(workspaceId) && task.initiator_workspace_id !== workspaceId) return false;
    return true;
  }

  function hasChangedAncestor(directoryPath: string, changedDirectories: ReadonlySet<string>) {
    const normalizedDirectory = normalizePathForComparison(directoryPath);
    for (const changed of changedDirectories) {
      const normalizedChanged = normalizePathForComparison(changed);
      if (normalizedDirectory === normalizedChanged) return true;
      if (normalizedDirectory.startsWith(`${normalizedChanged}/`)) return true;
    }
    return false;
  }

  function normalizePathForComparison(value: string) {
    return value.replace(/\\/g, "/").replace(/\/+$/, "");
  }

  function joinPath(parent: string, name: string) {
    if (parent === "/") return `/${name}`;
    if (/^[A-Za-z]:\\?$/.test(parent)) return `${parent.replace(/\\?$/, "\\")}${name}`;
    const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
    return `${parent.replace(/[\\/]+$/, "")}${separator}${name}`;
  }

  function providerEndpoint(filePath: string): TransferEndpoint {
    const providerKind = result?.provider.kind;
    if (!providerKind) throw new Error("Files provider is not loaded");
    return {
      kind: "provider",
      provider_kind: providerKind as FileProviderKind,
      host_id: toolTab.host_id,
      path: filePath,
    };
  }

  function clipboardItem(entry: FileEntry) {
    const providerKind = result?.provider.kind;
    if (!providerKind) throw new Error("Files provider is not loaded");
    return {
      endpoint: providerEndpoint(entry.path),
      name: entry.name,
      providerKind: providerKind as FileProviderKind,
      hostId: toolTab.host_id,
      workspaceId,
    };
  }

  function localEndpoint(filePath: string): TransferEndpoint {
    return {
      kind: "local",
      provider_kind: null,
      host_id: null,
      path: filePath,
    };
  }

  function directoryDropTargetFromPosition(x: number | undefined, y: number | undefined) {
    if (typeof x !== "number" || typeof y !== "number") return null;
    const element = document.elementFromPoint(x, y);
    if (!(element instanceof HTMLElement)) return null;
    const row = element.closest<HTMLElement>("[data-file-entry='true']");
    if (!row || row.getAttribute("data-entry-kind") !== "directory") return null;
    return row.getAttribute("data-entry-path");
  }

  function openCreateDirectoryDialog() {
    operationError = "";
    nameDialog = {
      action: "create_directory",
      title: "New Folder",
      label: "Folder name",
      value: "Untitled Folder",
    };
  }

  function openRenameDialog() {
    if (selectedEntries.length !== 1) return;
    const [entry] = selectedEntries;
    operationError = "";
    nameDialog = {
      action: "rename",
      title: "Rename",
      label: "New name",
      value: entry.name,
    };
  }

  function openChmodDialog() {
    if (selectedEntries.length === 0) return;
    operationError = "";
    nameDialog = {
      action: "chmod",
      title: selectedEntries.length === 1 ? "Permissions" : `Permissions (${selectedEntries.length} items)`,
      label: "Octal mode",
      value: selectedEntries[0]?.permissions?.slice(-4).replace(/^0(?=[0-7]{3}$)/, "") ?? "644",
    };
  }

  function closeNameDialog() {
    nameDialog = null;
  }

  async function submitNameDialog() {
    if (!nameDialog) return;
    const value = nameDialog.value.trim();
    if (!value) {
      operationError = "Name cannot be empty.";
      return;
    }
    operationError = "";
    if (nameDialog.action === "upload_target") {
      const source = pendingUploadSource;
      const dropped = pendingDroppedPaths;
      closeNameDialog();
      pendingUploadSource = null;
      pendingDroppedPaths = [];
      if (source === "drop") {
        await uploadLocalPaths(dropped, value);
      } else {
        await chooseUploadSourcesAndUpload(value);
      }
      return;
    }
    if (nameDialog.action === "create_directory") {
      await unwrapCommand(
        commands.createDirectory({
          parent_path: currentPath,
          name: value,
          ...providerCommandAuth(),
        }),
      );
    } else if (nameDialog.action === "rename") {
      if (selectedEntries.length !== 1) throw new Error("Rename requires exactly one selected file");
      const [entry] = selectedEntries;
      const destinationPath = joinPath(parentPathOf(entry.path), value);
      await unwrapCommand(
        commands.renameFile({
          source_path: entry.path,
          destination_path: destinationPath,
          ...providerCommandAuth(),
        }),
      );
    } else if (nameDialog.action === "chmod") {
      if (selectedEntries.length === 0) throw new Error("No files are selected for chmod");
      for (const entry of selectedEntries) {
        await unwrapCommand(
          commands.chmodFile({
            path: entry.path,
            mode: value,
            ...providerCommandAuth(),
          }),
        );
      }
    } else {
      throw new Error(`Unsupported Files name dialog action: ${nameDialog.action}`);
    }
    closeNameDialog();
    await refreshAfterMutation();
  }

  async function deleteSelected() {
    if (selectedEntries.length === 0) return;
    operationError = "";
    const deleteLabel = selectedEntries.length === 1 ? selectedEntries[0]?.path ?? "" : `${selectedEntries.length} items`;
    if (deleteBehavior === "try_remote_trash" && result?.provider.kind === "sftp") {
      const trashInfo = await unwrapCommand(
        commands.remoteTrashInfo({
          ...providerCommandAuth(),
        }),
      );
      if (trashInfo.available) {
        const choice = await message(`Move to remote Trash or delete permanently?\n\n${deleteLabel}`, {
          title: selectedEntries.length === 1 ? "Delete File" : "Delete Files",
          kind: "warning",
          buttons: {
            yes: "Move to Trash",
            no: "Delete Permanently",
            cancel: "Cancel",
          },
        });
        if (choice === "Move to Trash") {
          for (const entry of selectedEntries) {
            await unwrapCommand(
              commands.trashFile({
                path: entry.path,
                ...providerCommandAuth(),
              }),
            );
          }
          await refreshAfterMutation();
          return;
        }
        if (choice !== "Delete Permanently") return;
      }
    }
    const confirmed = await ask(`Delete permanently? This cannot be undone.\n\n${deleteLabel}`, {
      title: selectedEntries.length === 1 ? "Delete File" : "Delete Files",
      kind: "warning",
    });
    if (!confirmed) return;
    for (const entry of selectedEntries) {
      await unwrapCommand(
        commands.deleteFile({
          path: entry.path,
          ...providerCommandAuth(),
        }),
      );
    }
    await refreshAfterMutation();
  }

  function copySelected() {
    if (selectedEntries.length === 0) return;
    operationError = "";
    setFilesClipboard({
      mode: "copy",
      items: selectedEntries.map((entry) => clipboardItem(entry)),
    });
  }

  function cutSelected() {
    if (selectedEntries.length === 0) return;
    operationError = "";
    setFilesClipboard({
      mode: "cut",
      items: selectedEntries.map((entry) => clipboardItem(entry)),
    });
  }

  async function startUpload() {
    operationError = "";
    const target = resolveCurrentUploadTarget();
    if (target.kind === "needs_target_sheet") {
      openUploadTargetDialog(target.initialPath);
      return;
    }
    await chooseUploadSourcesAndUpload(target.path);
  }

  function openUploadTargetDialog(initialPath: string | null) {
    pendingUploadSource = pendingUploadSource ?? "dialog";
    nameDialog = {
      action: "upload_target",
      title: "Upload Target",
      label: "Target folder",
      value: initialPath || focusedDirectoryPath || currentPath,
    };
  }

  function resolveCurrentUploadTarget(explicitDirectoryPath?: string | null) {
    return resolveFilesUploadTarget({
      viewMode,
      focusedDirectoryPath,
      selectedEntries,
      explicitDirectoryPath,
      hostDefaultPath: result?.provider.current_path ?? toolTab.title,
    });
  }

  async function copySelectedPaths() {
    if (selectedEntries.length === 0) return;
    operationError = "";
    const text = selectedEntries.map((entry) => entry.path).join("\n");
    if (hasTauriRuntime()) {
      await writeText(text);
    } else {
      await navigator.clipboard.writeText(text);
    }
  }

  async function chooseUploadSourcesAndUpload(destinationDirectory: string) {
    const selected = await openDialog({
      multiple: true,
      title: "Upload",
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    await uploadLocalPaths(paths, destinationDirectory);
  }

  async function uploadLocalPaths(paths: string[], destinationDirectory: string) {
    if (paths.length === 0) return;
    operationError = "";
    for (const localPath of paths) {
      const name = basename(localPath);
      if (!name) throw new Error(`Cannot upload path without a name: ${localPath}`);
      await unwrapCommand(
        commands.createTransferTask({
          source: localEndpoint(localPath),
          destination: providerEndpoint(joinPath(destinationDirectory, name)),
          initiator_workspace_id: workspaceId,
          related_workspace_ids: [workspaceId],
        }),
      );
    }
    await refreshTransfers();
  }

  async function uploadDroppedPaths(paths: string[], explicitDirectoryPath?: string | null) {
    if (paths.length === 0) return;
    operationError = "";
    const target = resolveCurrentUploadTarget(explicitDirectoryPath);
    if (target.kind === "needs_target_sheet") {
      pendingUploadSource = "drop";
      pendingDroppedPaths = [...paths];
      openUploadTargetDialog(target.initialPath);
      return;
    }
    await uploadLocalPaths(paths, target.path);
  }

  async function downloadSelected() {
    if (selectedEntries.length === 0) return;
    operationError = "";
    if (selectedEntries.length === 1) {
      const entry = selectedEntries[0];
      if (!entry) return;
      const destination = await saveDialog({
        title: entry.kind === "directory" ? "Download Folder" : "Download File",
        defaultPath: entry.name,
      });
      if (!destination) return;
      await unwrapCommand(
        commands.createTransferTask({
          source: providerEndpoint(entry.path),
          destination: localEndpoint(destination),
          initiator_workspace_id: workspaceId,
          related_workspace_ids: [workspaceId],
        }),
      );
    } else {
      const destinationDirectory = await openDialog({
        multiple: false,
        directory: true,
        title: "Download Selected Files",
      });
      if (!destinationDirectory) return;
      for (const entry of selectedEntries) {
        await unwrapCommand(
          commands.createTransferTask({
            source: providerEndpoint(entry.path),
            destination: localEndpoint(joinPath(destinationDirectory, entry.name)),
            initiator_workspace_id: workspaceId,
            related_workspace_ids: [workspaceId],
          }),
        );
      }
    }
    await refreshTransfers();
  }

  function toolbarActionLabel(id: FilesToolbarActionId) {
    if (id === "upload") return "Upload";
    if (id === "new_folder") return "New folder";
    if (id === "refresh") return "Refresh";
    if (id === "view_mode") return "View mode";
    throw new Error(`Unsupported Files toolbar action id: ${id}`);
  }

  function toolbarActionIcon(id: FilesToolbarActionId) {
    if (id === "upload") return "⇧";
    if (id === "new_folder") return "＋";
    if (id === "refresh") return "↻";
    throw new Error(`Files toolbar action ${id} does not have an icon button`);
  }

  function toolbarActionDisabled(id: FilesToolbarActionId) {
    return false;
  }

  async function runToolbarAction(id: FilesToolbarActionId) {
    if (id === "upload") {
      await startUpload();
      return;
    }
    if (id === "new_folder") {
      openCreateDirectoryDialog();
      return;
    }
    if (id === "refresh") {
      await refresh();
      return;
    }
    if (id === "view_mode") {
      return;
    }
    throw new Error(`Unsupported executable Files toolbar action id: ${id}`);
  }

  function openSelectionContextMenu(entry: FileEntry, event: MouseEvent) {
    event.preventDefault();
    const next = selectFilesContextTarget(selection, entry.path);
    applySelection(next);
    viewState.lastSelectedEntry = entry;
    viewState.previewPath = entry.kind === "file" || entry.kind === "symlink" ? entry.path : "";
    contextMenu = {
      x: event.clientX,
      y: event.clientY,
      actions: filesSelectionContextMenuActions(next.selectedPaths.length, { canChmod: result?.provider.capabilities.can_chmod === true }),
    };
  }

  type MarqueePointerEvent = PointerEvent | MouseEvent;

  function beginMarqueeSelection(event: MarqueePointerEvent) {
    if (event.button !== 0) return;
    if (marquee?.active) return;
    if (!(event.currentTarget instanceof HTMLElement)) return;
    if (event.target instanceof HTMLElement && event.target.closest("[data-file-entry='true']")) return;
    event.preventDefault();
    const root = event.currentTarget.closest<HTMLElement>(".files-selection-surface") ?? event.currentTarget;
    const inputKind = "pointerId" in event ? "pointer" : "mouse";
    if ("pointerId" in event) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const rect = root.getBoundingClientRect();
    marquee = {
      active: true,
      root,
      inputKind,
      pointerId: "pointerId" in event ? event.pointerId : undefined,
      startX: event.clientX - rect.left,
      startY: event.clientY - rect.top,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      width: 0,
      height: 0,
    };
    if (inputKind === "pointer") {
      window.addEventListener("pointermove", updateGlobalMarqueeSelection, { capture: true });
      window.addEventListener("pointerup", commitGlobalMarqueeSelection, { capture: true });
      window.addEventListener("pointercancel", cancelMarqueeSelection, { capture: true });
    } else {
      window.addEventListener("mousemove", updateGlobalMarqueeSelection, { capture: true });
      window.addEventListener("mouseup", commitGlobalMarqueeSelection, { capture: true });
    }
  }

  function installNativeMarqueeListeners() {
    if (!filesRoot) return () => undefined;
    const pointerDown = (event: PointerEvent) => beginNativeMarqueeSelection(event);
    const mouseDown = (event: MouseEvent) => beginNativeMarqueeSelection(event);
    filesRoot.addEventListener("pointerdown", pointerDown, { capture: true });
    filesRoot.addEventListener("mousedown", mouseDown, { capture: true });
    return () => {
      filesRoot?.removeEventListener("pointerdown", pointerDown, { capture: true });
      filesRoot?.removeEventListener("mousedown", mouseDown, { capture: true });
    };
  }

  function beginNativeMarqueeSelection(event: MarqueePointerEvent) {
    if (event.button !== 0) return;
    if (!(event.target instanceof HTMLElement)) return;
    if (event.target.closest("[data-file-entry='true']")) return;
    const target = event.target.closest<HTMLElement>("[data-file-entry='true'], .files-selection-surface");
    if (!target || !filesRoot?.contains(target)) return;
    const root = target.closest<HTMLElement>(".files-selection-surface");
    if (!root) return;
    recordMarqueeDiagnostic("native-begin", event, target);
    beginMarqueeSelectionFromRoot(event, target, root);
  }

  function beginMarqueeSelectionFromRoot(event: MarqueePointerEvent, captureTarget: HTMLElement, root: HTMLElement) {
    if (marquee?.active) return;
    event.preventDefault();
    const inputKind = "pointerId" in event ? "pointer" : "mouse";
    if ("pointerId" in event) {
      captureTarget.setPointerCapture(event.pointerId);
    }
    const rect = root.getBoundingClientRect();
    marquee = {
      active: true,
      root,
      inputKind,
      pointerId: "pointerId" in event ? event.pointerId : undefined,
      startX: event.clientX - rect.left,
      startY: event.clientY - rect.top,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      width: 0,
      height: 0,
    };
    recordMarqueeDiagnostic("begin", event, captureTarget);
    if (inputKind === "pointer") {
      window.addEventListener("pointermove", updateGlobalMarqueeSelection, { capture: true });
      window.addEventListener("pointerup", commitGlobalMarqueeSelection, { capture: true });
      window.addEventListener("pointercancel", cancelMarqueeSelection, { capture: true });
    } else {
      window.addEventListener("mousemove", updateGlobalMarqueeSelection, { capture: true });
      window.addEventListener("mouseup", commitGlobalMarqueeSelection, { capture: true });
    }
  }

  function updateMarqueeSelection(event: MarqueePointerEvent) {
    if (!marquee?.active) return;
    if (!marqueeEventMatchesInput(event)) return;
    event.preventDefault();
    const rect = marquee.root.getBoundingClientRect();
    const startX = marquee.startX;
    const startY = marquee.startY;
    const currentX = event.clientX - rect.left;
    const currentY = event.clientY - rect.top;
    marquee = {
      ...marquee,
      x: Math.min(startX, currentX),
      y: Math.min(startY, currentY),
      width: Math.abs(currentX - startX),
      height: Math.abs(currentY - startY),
    };
    recordMarqueeDiagnostic("update", event, event.target instanceof HTMLElement ? event.target : null);
  }

  function commitMarqueeSelection(event: MarqueePointerEvent) {
    if (!marquee?.active) return;
    if (!marqueeEventMatchesInput(event)) return;
    event.preventDefault();
    const root = marquee.root;
    if ("pointerId" in event && root.hasPointerCapture(event.pointerId)) {
      root.releasePointerCapture(event.pointerId);
    }
    const paths = filesPathsInsideMarquee(root, marquee);
    const next = selectFilesMarquee(selection, paths);
    applySelection(next);
    const activeEntry = findEntryByPath(next.activePath);
    viewState.lastSelectedEntry = activeEntry;
    viewState.previewPath = activeEntry && (activeEntry.kind === "file" || activeEntry.kind === "symlink") ? activeEntry.path : "";
    recordMarqueeDiagnostic("commit", event, event.target instanceof HTMLElement ? event.target : null, { paths });
    marquee = null;
    removeMarqueeWindowListeners();
  }

  function cancelMarqueeSelection() {
    marquee = null;
    removeMarqueeWindowListeners();
  }

  function updateGlobalMarqueeSelection(event: Event) {
    if (event instanceof MouseEvent || event instanceof PointerEvent) {
      updateMarqueeSelection(event);
    }
  }

  function commitGlobalMarqueeSelection(event: Event) {
    if (event instanceof MouseEvent || event instanceof PointerEvent) {
      commitMarqueeSelection(event);
    }
  }

  function marqueeEventMatchesInput(event: MarqueePointerEvent) {
    if (!marquee) return false;
    if (marquee.inputKind === "pointer") {
      return "pointerId" in event && event.pointerId === marquee.pointerId;
    }
    return !("pointerId" in event);
  }

  function removeMarqueeWindowListeners() {
    window.removeEventListener("pointermove", updateGlobalMarqueeSelection, { capture: true });
    window.removeEventListener("pointerup", commitGlobalMarqueeSelection, { capture: true });
    window.removeEventListener("pointercancel", cancelMarqueeSelection, { capture: true });
    window.removeEventListener("mousemove", updateGlobalMarqueeSelection, { capture: true });
    window.removeEventListener("mouseup", commitGlobalMarqueeSelection, { capture: true });
  }

  function recordMarqueeDiagnostic(
    phase: string,
    event: MarqueePointerEvent,
    target: HTMLElement | null,
    extra: Record<string, unknown> = {},
  ) {
    const log = (window as unknown as { __NOCTURNE_TEST_MARQUEE_LOG__?: unknown }).__NOCTURNE_TEST_MARQUEE_LOG__;
    if (!Array.isArray(log)) return;
    log.push({
      phase,
      clientX: event.clientX,
      clientY: event.clientY,
      targetClass: target?.className?.toString?.() ?? "",
      targetPath: target?.dataset.entryPath ?? "",
      ...extra,
    });
  }

  function filesPathsInsideMarquee(root: HTMLElement, box: NonNullable<typeof marquee>) {
    const rootRect = root.getBoundingClientRect();
    const boxLeft = rootRect.left + box.x;
    const boxTop = rootRect.top + box.y;
    const boxRight = boxLeft + box.width;
    const boxBottom = boxTop + box.height;
    return Array.from(root.querySelectorAll<HTMLElement>("[data-file-entry='true']")).flatMap((row) => {
      const rect = row.getBoundingClientRect();
      const intersects = rect.left <= boxRight && rect.right >= boxLeft && rect.top <= boxBottom && rect.bottom >= boxTop;
      return intersects ? [row.dataset.entryPath ?? ""] : [];
    }).filter(Boolean);
  }

  async function runContextMenuAction(id: FilesContextMenuActionId) {
    contextMenu = null;
    if (id === "rename") {
      openRenameDialog();
      return;
    }
    if (id === "permissions") {
      openChmodDialog();
      return;
    }
    if (id === "copy_path") {
      await copySelectedPaths();
      return;
    }
    if (id === "delete") {
      await deleteSelected();
      return;
    }
    if (id === "copy") {
      copySelected();
      return;
    }
    if (id === "cut") {
      cutSelected();
      return;
    }
    if (id === "download") {
      await downloadSelected();
      return;
    }
    throw new Error(`Unsupported Files context menu action id: ${id}`);
  }
</script>

<section bind:this={filesRoot} class:drag-hover={dragHover} class="files-tooltab" aria-label="Files">
  {#if !hasTauriRuntime()}
    <div class="files-demo-placeholder" data-testid="files-demo-placeholder">
      <strong>{toolTab.title}</strong>
      <span>Files provider is available in the Tauri app.</span>
    </div>
  {:else}
  <header class="files-chrome">
    <div class="files-toolbar">
      {#each visibleToolbarActionIds as actionId (actionId)}
        {#if actionId === "view_mode"}
        <div class="view-toggle" role="group" aria-label="View mode">
          <button class:active={viewMode === "tree"} type="button" title="Tree view" aria-label="Tree view" onclick={() => (viewState.viewMode = "tree")}>☰</button>
          <button class:active={viewMode === "columns"} type="button" title="Columns view" aria-label="Columns view" onclick={() => (viewState.viewMode = "columns")}>▥</button>
        </div>
        {:else}
        <button
          type="button"
          title={toolbarActionLabel(actionId)}
          aria-label={toolbarActionLabel(actionId)}
          disabled={toolbarActionDisabled(actionId)}
          onclick={() =>
            void runToolbarAction(actionId).catch((error) => {
              operationError = error instanceof Error ? error.message : String(error);
            })}
        >
          {toolbarActionIcon(actionId)}
        </button>
        {/if}
      {/each}
      <div class="path-field" title={focusedDirectoryPath}>{focusedDirectoryPath}</div>
    </div>
  </header>

  {#if searchOpen}
    <form
      class="search-bar"
      onsubmit={(event) => {
        event.preventDefault();
        void runSearch().catch((error) => {
          operationError = error instanceof Error ? error.message : String(error);
          searchLoading = false;
        });
      }}
    >
      <div class="search-mode" role="group" aria-label="Search mode">
        <button type="button" class:active={searchMode === "name"} onclick={() => (searchMode = "name")}>Name</button>
        <button type="button" class:active={searchMode === "content"} onclick={() => (searchMode = "content")}>Content</button>
      </div>
      <input bind:value={searchQuery} placeholder={searchMode === "content" ? "Search file contents" : "Search names recursively"} />
      <label class="search-toggle">
        <input type="checkbox" bind:checked={searchIgnoreIgnoreFiles} />
        <span>No ignore</span>
      </label>
      <label class="search-toggle">
        <input type="checkbox" bind:checked={searchFollowSymlinks} />
        <span>Follow links</span>
      </label>
      <button type="submit" disabled={searchLoading}>{searchLoading ? "Searching" : "Search"}</button>
      <button type="button" onclick={clearSearch}>Close</button>
    </form>
  {/if}

  {#if filesError && isFilesWorkspaceVerificationPendingError(filesError)}
    <div class="files-status">Waiting for Workspace verification...</div>
  {:else if filesLoading && !result}
    <div class="files-status">Loading...</div>
  {:else if filesError}
    <div class="files-status error">{filesError instanceof Error ? filesError.message : String(filesError)}</div>
  {:else if operationError}
    <div class="files-status error">{operationError}</div>
  {:else}
    {#if searchResult}
      <div class="search-results" aria-label="Search results">
        <header>
          <strong>{searchResult.matches.length} matches</strong>
          <span>{searchResult.provider_label}</span>
          {#if searchResult.truncated}
            <small>truncated</small>
          {/if}
        </header>
        <OverlayScrollbarsComponent element="div" class="search-list" options={overlayVerticalOptions} defer>
          {#each searchResult.matches as match, index (`${match.path}-${match.line_number ?? "path"}-${index}`)}
            <button
              class:selected={isPathSelected(match.path)}
              class="search-row"
              type="button"
              ondblclick={() => openSearchMatch(match)}
              onclick={() => {
                applySelection({
                  selectedPaths: [match.path],
                  activePath: match.path,
                  anchorPath: match.path,
                });
              }}
            >
              <span class="search-match-name">{match.name}</span>
              <span class="search-match-path">{match.path}</span>
              {#if match.line_text}
                <span class="search-match-line">
                  {#if match.line_number}
                    <small>{match.line_number}</small>
                  {/if}
                  <span>{match.line_text}</span>
                </span>
              {/if}
            </button>
          {/each}
          {#each searchResult.diagnostics as diagnostic, index (`${index}-${diagnostic}`)}
            <p class="search-diagnostic">{diagnostic}</p>
          {/each}
        </OverlayScrollbarsComponent>
      </div>
    {:else if viewMode === "columns"}
      <OverlayScrollbarsComponent element="div" class="columns-view" aria-label="Columns file browser" options={overlayHorizontalOptions} defer>
        <div
          class:motion-active={columnsMotionActive}
          class:motion-backward={columnsMotion === "backward"}
          class:motion-forward={columnsMotion === "forward"}
          class:motion-preparing={columnsMotionPreparing}
          class:motion-resize={columnsMotion === "resize"}
          class:motion-settling={columnsMotionSettling}
          class:motion-distance-full={columnsMotionDistanceClass(columnsMotionDistance) === "full"}
          class:motion-distance-third={columnsMotionDistanceClass(columnsMotionDistance) === "third"}
          class:motion-distance-sixth={columnsMotionDistanceClass(columnsMotionDistance) === "sixth"}
          class="columns-content"
          style={`--columns-motion-duration: ${columnsMotionDurationMs}ms; --columns-motion-easing: ${columnsMotionEasing}; --columns-motion-distance: ${columnsMotionDistance}; --columns-motion-translate: ${columnsMotionTranslate}; --columns-motion-transition: ${columnsMotionTransition}; transform: translateX(${columnsMotionTranslate}); transition: ${columnsMotionTransition};`}
        >
          {#each columnsPanes as pane (pane.id)}
            <div
              class:current={pane.current}
              class="columns-pane"
              aria-hidden={!pane.current}
              style={`--columns-count: ${columnsPaneColumnCount(pane)}; --columns-visible-count: ${Math.min(columnsPaneColumnCount(pane), 3)};`}
            >
              {#each columnsForRenderedPane(pane) as column (columnsRenderKey(column.path))}
                <section class="file-column" aria-label={column.path}>
                  <header title={column.path}>{column.title}</header>
                  <OverlayScrollbarsComponent
                    element="div"
                    class="column-list"
                    options={overlayVerticalOptions}
                    defer
                  >
                    <div
                      class="files-selection-surface"
                      role="presentation"
                      onpointerdown={beginMarqueeSelection}
                      onpointermove={updateMarqueeSelection}
                      onpointerup={commitMarqueeSelection}
                      onpointercancel={cancelMarqueeSelection}
                      onmousedown={beginMarqueeSelection}
                      onmousemove={updateMarqueeSelection}
                      onmouseup={commitMarqueeSelection}
                      onmouseleave={cancelMarqueeSelection}
                    >
                      {#each column.entries as entry (entry.path)}
                        <button
                          class:drop-target={externalDropTargetPath === entry.path}
                          class:active-selected={sameFilePath(selectedPath, entry.path)}
                          class:selected={entry.selected}
                          class:multi-selected={isPathSelected(entry.path)}
                          class="column-row"
                          data-file-entry="true"
                          data-entry-kind={entry.kind}
                          data-entry-path={entry.path}
                          type="button"
                          onpointerdown={handleFilesRowPointerDown}
                          onmousedown={handleFilesRowPointerDown}
                          ondblclick={() => openColumnsEntry(entry)}
                          oncontextmenu={(event) => openSelectionContextMenu(entry, event)}
                          onclick={(event) =>
                            void selectEntry(entry, column.entries.map((item) => item.path), event).catch((error) => {
                              operationError = error instanceof Error ? error.message : String(error);
                            })}
                        >
                          <span class="name-cell" title={entry.symlink_target ? `${entry.path} -> ${entry.symlink_target}` : entry.path}>
                            <span class="kind-icon file-kind-icon" aria-hidden="true">
                              {#if entry.kind === "directory"}
                                <FolderIcon />
                              {:else if entry.kind === "symlink"}
                                <FileSymlinkIcon />
                              {:else}
                                <FileIcon />
                              {/if}
                            </span>
                            <span class="file-name-text">{entry.name}</span>
                          </span>
                          <small>{formatSize(entry)}</small>
                          {#if externalDropTargetPath === entry.path}
                            <span class="drop-target-hint">Upload here</span>
                          {/if}
                        </button>
                      {/each}
                    </div>
                  </OverlayScrollbarsComponent>
                </section>
              {/each}
              {#if previewVisible && pane.current}
                <section class="file-column preview-column" aria-label="Preview" data-column-key={previewColumnRenderKey()}>
                  <header>Preview</header>
                  {@render previewPanel()}
                </section>
              {/if}
            </div>
          {/each}
        </div>
	      </OverlayScrollbarsComponent>
	    {:else}
	      <div class:with-preview={previewVisible} class="tree-preview-layout">
	        <OverlayScrollbarsComponent
            element="div"
            class="files-table"
            role="treegrid"
            aria-rowcount={treeRows.length}
            options={overlayBothOptions}
            defer
          >
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions (Tree rows keep focus and keyboard semantics; this wrapper only captures drag-marquee mouse movement.) -->
            <div
              class="files-selection-surface"
              role="rowgroup"
              onpointerdown={beginMarqueeSelection}
              onpointermove={updateMarqueeSelection}
              onpointerup={commitMarqueeSelection}
              onpointercancel={cancelMarqueeSelection}
              onmousedown={beginMarqueeSelection}
              onmousemove={updateMarqueeSelection}
              onmouseup={commitMarqueeSelection}
              onmouseleave={cancelMarqueeSelection}
                    >
                      {#if treeStickyRows.length > 0}
                        <div class="tree-sticky-rows" aria-label="Sticky parent directories">
                          {#each treeStickyRows as stickyRow (stickyRow.entry.path)}
                            <button
                              class:drop-target={externalDropTargetPath === stickyRow.entry.path}
                              class:active-selected={sameFilePath(selectedPath, stickyRow.entry.path)}
                              class:selected={isPathSelected(stickyRow.entry.path)}
                              class="files-row sticky-row"
                              data-file-entry="true"
                              data-entry-kind={stickyRow.entry.kind}
                              data-entry-path={stickyRow.entry.path}
                              type="button"
                              onpointerdown={(event) => event.stopPropagation()}
                              onmousedown={(event) => event.stopPropagation()}
                              style={`--tree-depth: ${stickyRow.depth};`}
                              oncontextmenu={(event) => openSelectionContextMenu(stickyRow.entry, event)}
                              onclick={(event) =>
                                void clickTreeEntry(stickyRow.entry, event).catch((error) => {
                                  operationError = error instanceof Error ? error.message : String(error);
                                })}
                            >
                              <span class="name-cell" title={stickyRow.entry.path}>
                                <span class="tree-disclosure" aria-hidden="true">{stickyRow.expanded ? "▾" : "▸"}</span>
                                <span class="kind-icon file-kind-icon" aria-hidden="true"><FolderIcon /></span>
                                <span class="file-name-text">{stickyRow.entry.name}</span>
                              </span>
                              <span></span>
                              <span></span>
                              <span>{externalDropTargetPath === stickyRow.entry.path ? "Upload here" : ""}</span>
                            </button>
                          {/each}
                        </div>
                      {/if}
	            <div class="files-row files-head" role="row">
	              <span>Name</span>
	              <span>Size</span>
	              <span>Modified</span>
	              <span>Permissions</span>
	            </div>
	            {#each treeRows as row (row.entry.path)}
	              <div
                    class:drop-target={externalDropTargetPath === row.entry.path}
                    class:active-selected={sameFilePath(selectedPath, row.entry.path)}
	                class:selected={isPathSelected(row.entry.path)}
	                class="files-row"
                  data-file-entry="true"
                  data-entry-kind={row.entry.kind}
                  data-entry-path={row.entry.path}
	                role="row"
                  tabindex="0"
                  onpointerdown={(event) => event.stopPropagation()}
                  onmousedown={(event) => event.stopPropagation()}
	                aria-level={row.depth + 1}
	                aria-expanded={row.entry.kind === "directory" ? row.expanded : undefined}
	                style={`--tree-depth: ${row.depth};`}
	                ondblclick={() =>
	                  void activateTreeEntry(row.entry).catch((error) => {
	                    operationError = error instanceof Error ? error.message : String(error);
	                  })}
                  oncontextmenu={(event) => openSelectionContextMenu(row.entry, event)}
	                onclick={(event) =>
                    void clickTreeEntry(row.entry, event).catch((error) => {
                      operationError = error instanceof Error ? error.message : String(error);
                    })}
                  onkeydown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    void activateTreeEntry(row.entry).catch((error) => {
                      operationError = error instanceof Error ? error.message : String(error);
                    });
                  }}
	              >
	                <span class="name-cell" title={row.entry.symlink_target ? `${row.entry.path} -> ${row.entry.symlink_target}` : row.entry.path}>
                    {#if row.entry.kind === "directory"}
                      <button
                        class="tree-disclosure"
                        type="button"
                        aria-label={row.expanded ? "Collapse directory" : "Expand directory"}
                        aria-expanded={row.expanded}
                        onclick={(event) => {
                          event.stopPropagation();
                          void toggleTreeDirectory(row.entry).catch((error) => {
                            operationError = error instanceof Error ? error.message : String(error);
                          });
                        }}
                      >
                        {row.loading ? "…" : row.expanded ? "▾" : "▸"}
                      </button>
                    {:else}
                      <span class="tree-disclosure placeholder" aria-hidden="true"></span>
                    {/if}
                    <span class="kind-icon file-kind-icon" aria-hidden="true">
                      {#if row.entry.kind === "directory"}
                        <FolderIcon />
                      {:else if row.entry.kind === "symlink"}
                        <FileSymlinkIcon />
                      {:else}
                        <FileIcon />
                      {/if}
                    </span>
	                  <span class="file-name-text">{row.entry.name}</span>
	                </span>
	                <span>{formatSize(row.entry)}</span>
	                <span>{formatModified(row.entry)}</span>
	                <span>{externalDropTargetPath === row.entry.path ? "Upload here" : row.error ?? row.entry.permissions ?? ""}</span>
	              </div>
	            {/each}
            </div>
	        </OverlayScrollbarsComponent>
          {#if previewVisible}
            <aside class="tree-preview" aria-label="Preview">
              {@render previewPanel()}
            </aside>
          {/if}
	      </div>
	    {/if}
      {#if selectionSummary}
        <footer class="files-selection-summary">{selectionSummary}</footer>
      {/if}
  {/if}

  {#if nameDialog}
    <div class="dialog-scrim" role="presentation">
      <button class="dialog-backdrop" type="button" aria-label="Close dialog" onclick={closeNameDialog}></button>
      <form
        class="name-dialog"
        aria-label={nameDialog.title}
        onsubmit={(event) => {
          event.preventDefault();
          void submitNameDialog().catch((error) => {
            operationError = error instanceof Error ? error.message : String(error);
          });
        }}
      >
        <h2>{nameDialog.title}</h2>
        <label>
          <span>{nameDialog.label}</span>
          <input bind:value={nameDialog.value} />
        </label>
        <div class="dialog-actions">
          <button type="button" onclick={closeNameDialog}>Cancel</button>
          <button type="submit">OK</button>
        </div>
      </form>
    </div>
  {/if}

  {#if dragHover && !externalDropTargetPath}
    <div class="drop-overlay" aria-hidden="true">
      <span>Drop to upload</span>
    </div>
  {/if}

  {#if contextMenu}
    <button class="context-menu-backdrop" type="button" aria-label="Close context menu" onclick={() => (contextMenu = null)}></button>
    <div
      class="files-context-menu"
      role="menu"
      tabindex="-1"
      style={`left: ${contextMenu.x}px; top: ${contextMenu.y}px;`}
      onkeydown={(event) => {
        if (event.key === "Escape") contextMenu = null;
      }}
    >
      {#each contextMenu.actions as action (action.id)}
        <button
          class:dangerous={action.dangerous}
          type="button"
          role="menuitem"
          disabled={action.disabled}
          onclick={() =>
            void runContextMenuAction(action.id).catch((error) => {
              operationError = error instanceof Error ? error.message : String(error);
            })}
        >
          {action.label}
        </button>
      {/each}
    </div>
  {/if}

  {#if marquee}
    <div
      class="marquee-selection"
      style={`left: ${marquee.x}px; top: ${marquee.y}px; width: ${marquee.width}px; height: ${marquee.height}px;`}
      aria-hidden="true"
    ></div>
  {/if}
  {/if}
</section>

{#snippet previewPanel()}
  {#if previewResult && isRenderableFilePreview(previewResult)}
    <div class="preview-content">
      <header>
        <strong title={previewResult.path}>{previewResult.name}</strong>
        <span>{formatPreviewSize(previewResult)}</span>
        <span>{formatPreviewModified(previewResult)}</span>
      </header>
      {#if previewResult.content.kind === "text" && isMarkdownTextPreview(previewResult)}
        <OverlayScrollbarsComponent element="div" class="preview-markdown" options={overlayPreviewOptions} defer>
          {@html markdownPreviewHtml(previewResult)}
        </OverlayScrollbarsComponent>
      {:else if previewResult.content.kind === "text"}
        <OverlayScrollbarsComponent element="pre" class="preview-text" options={overlayPreviewOptions} defer>{previewResult.content.text}</OverlayScrollbarsComponent>
      {:else if previewResult.content.kind === "image"}
        <OverlayScrollbarsComponent element="div" class="image-preview" options={overlayPreviewOptions} defer>
          <img alt={previewResult.name} src={previewImageSrc(previewResult)} />
        </OverlayScrollbarsComponent>
      {/if}
    </div>
  {/if}
{/snippet}

<style>
  .files-tooltab {
    min-width: 0;
    min-height: 0;
    height: 100%;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    position: relative;
    border-right: 1px solid var(--app-border);
    background: color-mix(in srgb, var(--app-bg) 96%, var(--app-control));
    color: var(--app-fg);
  }

  .files-tooltab.drag-hover {
    box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--app-accent) 68%, transparent);
  }

  .files-demo-placeholder {
    min-width: 0;
    min-height: 0;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 6px;
    color: color-mix(in srgb, var(--app-fg) 62%, transparent);
    font-size: 12px;
  }

  .files-demo-placeholder strong {
    color: var(--app-fg);
    font-size: 13px;
  }

  .files-toolbar {
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
    padding: 4px 6px;
    border-bottom: 1px solid var(--app-border);
  }

  .files-chrome {
    min-width: 0;
    border-bottom: 1px solid var(--app-border);
  }

  .files-chrome .files-toolbar {
    border-bottom: 0;
  }

  button {
    appearance: none;
    color: inherit;
    font: inherit;
  }

  .files-toolbar button {
    flex: 0 0 30px;
    width: 30px;
    height: 28px;
    border: 0;
    border-radius: 6px;
    background: transparent;
  }

  .files-toolbar button:active,
  .files-row:active {
    background: var(--app-active);
  }

  .files-toolbar button:disabled {
    opacity: 0.38;
  }

  .view-toggle {
    flex: 0 0 58px;
    display: grid;
    grid-template-columns: repeat(2, 28px);
    height: 28px;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--app-fg) 13%, transparent);
    border-radius: 6px;
  }

  .view-toggle button {
    width: 28px;
    height: 26px;
    border-radius: 0;
  }

  .view-toggle button.active {
    background: color-mix(in srgb, var(--app-active) 72%, transparent);
  }

  .path-field {
    box-sizing: border-box;
    flex: 1 1 132px;
    min-width: 0;
    max-width: 100%;
    height: 28px;
    display: flex;
    align-items: center;
    border: 1px solid color-mix(in srgb, var(--app-fg) 13%, transparent);
    border-radius: 6px;
    padding: 0 8px;
    background: color-mix(in srgb, var(--app-bg) 88%, var(--app-control));
    color: color-mix(in srgb, var(--app-fg) 82%, transparent);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .search-bar {
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 5px 6px;
    border-bottom: 1px solid var(--app-border);
  }

  .search-bar input:not([type="checkbox"]) {
    flex: 1 1 180px;
    min-width: 0;
    height: 28px;
    border: 1px solid color-mix(in srgb, var(--app-fg) 13%, transparent);
    border-radius: 6px;
    padding: 0 8px;
    background: color-mix(in srgb, var(--app-bg) 88%, var(--app-control));
    color: inherit;
    font: inherit;
    font-size: 12px;
  }

  .search-mode {
    height: 28px;
    display: inline-flex;
    border: 1px solid color-mix(in srgb, var(--app-fg) 13%, transparent);
    border-radius: 6px;
    overflow: hidden;
    background: color-mix(in srgb, var(--app-bg) 88%, var(--app-control));
  }

  .search-bar button {
    min-width: 64px;
    height: 28px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 12px;
  }

  .files-status {
    display: grid;
    place-items: center;
    padding: 18px;
    color: color-mix(in srgb, var(--app-fg) 65%, transparent);
    font-size: 12px;
    text-align: center;
  }

  .files-status.error {
    color: var(--app-danger);
  }

  .tree-preview-layout :global(.files-table) {
    min-width: 0;
    min-height: 0;
    font-size: 12px;
  }

  .search-mode button {
    min-width: 68px;
    border-radius: 0;
  }

  .search-mode button.active {
    background: color-mix(in srgb, var(--app-active) 76%, transparent);
  }

  .search-toggle {
    height: 28px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0 6px;
    color: color-mix(in srgb, var(--app-fg) 72%, transparent);
    font-size: 12px;
    white-space: nowrap;
  }

  .search-toggle input {
    margin: 0;
  }

  .files-selection-surface {
    min-width: 100%;
    min-height: 100%;
    padding-bottom: 72px;
    user-select: none;
    -webkit-user-select: none;
  }

  .tree-preview-layout {
    min-width: 0;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }

  .tree-preview-layout.with-preview {
    grid-template-columns: minmax(0, 1fr) minmax(220px, 28%);
  }

  .tree-preview {
    min-width: 0;
    min-height: 0;
    border-left: 1px solid var(--app-border);
    background: color-mix(in srgb, var(--app-bg) 97%, var(--app-control));
    overflow: hidden;
  }

  .search-results {
    min-width: 0;
    min-height: 0;
    display: grid;
    grid-template-rows: 30px minmax(0, 1fr);
    font-size: 12px;
  }

  .search-results header {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 9px;
    border-bottom: 1px solid color-mix(in srgb, var(--app-border) 65%, transparent);
    color: color-mix(in srgb, var(--app-fg) 66%, transparent);
  }

  .search-results header strong {
    color: var(--app-fg);
  }

  .search-results :global(.search-list) {
    min-width: 0;
    min-height: 0;
  }

  .search-row {
    width: 100%;
    min-height: 34px;
    display: grid;
    grid-template-columns: 180px minmax(0, 1fr);
    grid-template-rows: auto;
    gap: 10px;
    align-items: center;
    border: 0;
    border-bottom: 1px solid color-mix(in srgb, var(--app-border) 55%, transparent);
    padding: 0 9px;
    background: transparent;
    text-align: left;
  }

  .search-match-name,
  .search-match-path,
  .search-match-line span,
  .search-match-line small {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .search-match-path,
  .search-match-line small,
  .search-diagnostic {
    color: color-mix(in srgb, var(--app-fg) 58%, transparent);
  }

  .search-match-line {
    grid-column: 1 / -1;
    min-width: 0;
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr);
    gap: 8px;
    color: color-mix(in srgb, var(--app-fg) 74%, transparent);
  }

  .search-diagnostic {
    margin: 0;
    padding: 7px 9px;
    border-bottom: 1px solid color-mix(in srgb, var(--app-border) 45%, transparent);
  }

  .files-tooltab :global(.columns-view) {
    width: 100%;
    min-width: 0;
    min-height: 0;
    font-size: 12px;
    overflow: hidden;
  }

  .columns-content {
    min-width: 100%;
    width: 100%;
    height: 100%;
    min-height: 0;
    display: flex;
    transform: translateX(0);
    transition: var(--columns-motion-transition, none);
    will-change: transform;
  }

  .columns-content.motion-resize {
    transform: translateX(0);
    transition: none;
  }

  .columns-content.motion-preparing {
    transition: none;
  }

  .columns-content.motion-forward.motion-active.motion-distance-full {
    animation: columns-slide-forward-full var(--columns-motion-duration, 180ms) var(--columns-motion-easing, cubic-bezier(0.22, 1, 0.36, 1)) forwards;
  }

  .columns-content.motion-forward.motion-active.motion-distance-third {
    animation: columns-slide-forward-third var(--columns-motion-duration, 180ms) var(--columns-motion-easing, cubic-bezier(0.22, 1, 0.36, 1)) forwards;
  }

  .columns-content.motion-forward.motion-active.motion-distance-sixth {
    animation: columns-slide-forward-sixth var(--columns-motion-duration, 180ms) var(--columns-motion-easing, cubic-bezier(0.22, 1, 0.36, 1)) forwards;
  }

  .columns-content.motion-backward.motion-active.motion-distance-full {
    animation: columns-slide-backward-full var(--columns-motion-duration, 180ms) var(--columns-motion-easing, cubic-bezier(0.22, 1, 0.36, 1)) forwards;
  }

  .columns-content.motion-backward.motion-active.motion-distance-third {
    animation: columns-slide-backward-third var(--columns-motion-duration, 180ms) var(--columns-motion-easing, cubic-bezier(0.22, 1, 0.36, 1)) forwards;
  }

  .columns-content.motion-backward.motion-active.motion-distance-sixth {
    animation: columns-slide-backward-sixth var(--columns-motion-duration, 180ms) var(--columns-motion-easing, cubic-bezier(0.22, 1, 0.36, 1)) forwards;
  }

  .columns-content.motion-settling {
    transform: translateX(0);
    animation: none;
    transition: none;
  }

  .columns-pane {
    --columns-pane-width: max(100%, calc(var(--columns-count, 1) * (100% / var(--columns-visible-count, 1))));
    --column-width: calc(100% / var(--columns-count, 1));
    flex: 0 0 var(--columns-pane-width);
    width: var(--columns-pane-width);
    min-width: var(--columns-pane-width);
    height: 100%;
    min-height: 0;
    display: flex;
  }

  .columns-content.motion-forward .columns-pane,
  .columns-content.motion-backward .columns-pane {
    --columns-pane-width: calc(var(--columns-count, 1) * (100% / 3));
    --column-width: calc(100% / var(--columns-count, 1));
  }

  .file-column {
    flex: 0 0 var(--column-width);
    width: var(--column-width);
    min-width: 0;
    height: 100%;
    min-height: 0;
    display: grid;
    grid-template-rows: 28px minmax(0, 1fr);
    border-right: 1px solid var(--app-border);
  }

  .preview-column {
    flex: 0 0 var(--column-width);
    width: var(--column-width);
    min-width: 0;
  }

  .columns-content.motion-resize .file-column {
    transition:
      flex-basis var(--columns-motion-duration, 180ms) var(--columns-motion-easing, cubic-bezier(0.22, 1, 0.36, 1)),
      width var(--columns-motion-duration, 180ms) var(--columns-motion-easing, cubic-bezier(0.22, 1, 0.36, 1));
  }

  .columns-content.motion-resize .preview-column {
    transition:
      flex-basis var(--columns-motion-duration, 180ms) var(--columns-motion-easing, cubic-bezier(0.22, 1, 0.36, 1)),
      width var(--columns-motion-duration, 180ms) var(--columns-motion-easing, cubic-bezier(0.22, 1, 0.36, 1));
  }

  @keyframes columns-slide-forward-full {
    from {
      transform: translateX(0);
    }

    to {
      transform: translateX(-100%);
    }
  }

  @keyframes columns-slide-forward-third {
    from {
      transform: translateX(0);
    }

    to {
      transform: translateX(calc(-100% / 3));
    }
  }

  @keyframes columns-slide-forward-sixth {
    from {
      transform: translateX(0);
    }

    to {
      transform: translateX(calc(-100% / 6));
    }
  }

  @keyframes columns-slide-backward-full {
    from {
      transform: translateX(-100%);
    }

    to {
      transform: translateX(0);
    }
  }

  @keyframes columns-slide-backward-third {
    from {
      transform: translateX(calc(-100% / 3));
    }

    to {
      transform: translateX(0);
    }
  }

  @keyframes columns-slide-backward-sixth {
    from {
      transform: translateX(calc(-100% / 6));
    }

    to {
      transform: translateX(0);
    }
  }

  .file-column header {
    min-width: 0;
    padding: 7px 9px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--app-border) 65%, transparent);
    color: color-mix(in srgb, var(--app-fg) 58%, transparent);
    font-size: 11px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-column :global(.column-list) {
    min-width: 0;
    min-height: 0;
  }

  .column-row {
    width: 100%;
    min-width: 0;
    min-height: 28px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
    border: 0;
    padding: 0 9px;
    background: transparent;
    text-align: left;
  }

  .column-row.selected {
    background: color-mix(in srgb, var(--app-active) 72%, transparent);
  }

  .column-row.active-selected,
  .files-row.active-selected {
    background: color-mix(in srgb, var(--app-active) 84%, transparent);
    box-shadow: inset 2px 0 0 color-mix(in srgb, var(--app-accent) 82%, transparent);
  }

  .column-row.drop-target,
  .files-row.drop-target {
    background: color-mix(in srgb, var(--app-accent) 18%, var(--app-bg));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--app-accent) 62%, transparent);
  }

  .drop-target-hint {
    grid-column: 1 / -1;
    justify-self: start;
    border-radius: 4px;
    padding: 1px 5px;
    background: color-mix(in srgb, var(--app-accent) 18%, transparent);
    color: color-mix(in srgb, var(--app-fg) 74%, transparent);
    font-size: 10px;
  }

  .column-row small {
    min-width: 0;
    color: color-mix(in srgb, var(--app-fg) 55%, transparent);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .files-row {
    width: 100%;
    min-width: 620px;
    min-height: 28px;
    display: grid;
    grid-template-columns: minmax(220px, 1fr) 86px 150px 86px;
    align-items: center;
    column-gap: 10px;
    border: 0;
    border-bottom: 1px solid color-mix(in srgb, var(--app-border) 55%, transparent);
    padding: 0 9px;
    background: transparent;
    text-align: left;
    user-select: none;
    -webkit-user-select: none;
  }

  .files-row:focus-visible {
    outline: 1px solid color-mix(in srgb, var(--app-accent) 82%, transparent);
    outline-offset: -1px;
  }

  .files-head {
    position: sticky;
    top: 0;
    z-index: 1;
    min-height: 26px;
    background: color-mix(in srgb, var(--app-bg) 94%, var(--app-control));
    color: color-mix(in srgb, var(--app-fg) 58%, transparent);
    font-size: 11px;
    font-weight: 600;
  }

  .tree-sticky-rows {
    position: sticky;
    top: 0;
    z-index: 2;
    display: grid;
    background: color-mix(in srgb, var(--app-bg) 96%, var(--app-control));
    box-shadow: 0 1px 0 color-mix(in srgb, var(--app-border) 72%, transparent);
  }

  .tree-sticky-rows .sticky-row {
    min-height: 25px;
    border-bottom-color: color-mix(in srgb, var(--app-border) 42%, transparent);
    background: color-mix(in srgb, var(--app-bg) 94%, var(--app-control));
  }

  .files-row.selected {
    background: color-mix(in srgb, var(--app-active) 72%, transparent);
  }

  .column-row.multi-selected,
  .search-row.selected {
    background: color-mix(in srgb, var(--app-active) 72%, transparent);
  }

  .files-row span,
  .column-row span,
  .column-row small {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .name-cell {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 5px;
    padding-left: calc(var(--tree-depth, 0) * 16px);
  }

  .file-name-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .kind-icon,
  .tree-disclosure {
    width: 13px;
    color: color-mix(in srgb, var(--app-fg) 58%, transparent);
  }

  .file-kind-icon {
    width: 15px;
    height: 15px;
    display: inline-grid;
    place-items: center;
    flex: 0 0 15px;
  }

  .file-kind-icon :global(svg) {
    width: 15px;
    height: 15px;
    stroke-width: 1.8;
  }

  .tree-disclosure {
    height: 22px;
    display: grid;
    place-items: center;
    border: 0;
    padding: 0;
    background: transparent;
    font-size: 12px;
  }

  .tree-disclosure.placeholder {
    height: auto;
  }

  .preview-content {
    min-width: 0;
    min-height: 0;
    height: 100%;
    container-type: inline-size;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    font-size: 12px;
    overflow: hidden;
  }

  .preview-content header {
    min-width: 0;
    display: grid;
    gap: 3px;
    border-bottom: 1px solid color-mix(in srgb, var(--app-border) 65%, transparent);
    padding: 8px 10px;
    overflow: hidden;
  }

  .preview-content header strong,
  .preview-content header span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .preview-content header strong {
    font-size: 12px;
    font-weight: 650;
  }

  .preview-content header span {
    color: color-mix(in srgb, var(--app-fg) 58%, transparent);
    font-size: 11px;
  }

  .preview-content :global(.preview-text) {
    min-width: 0;
    min-height: 0;
    max-width: 100%;
    margin: 0;
    overflow-x: hidden;
    padding: 10px;
    color: color-mix(in srgb, var(--app-fg) 86%, transparent);
    font-family: var(--terminal-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
    font-size: 11px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .preview-content :global(.preview-markdown) {
    min-width: 0;
    min-height: 0;
    max-width: 100%;
    overflow-x: hidden;
    padding: 10px 12px 14px;
    color: color-mix(in srgb, var(--app-fg) 88%, transparent);
    font-size: 12px;
    line-height: 1.5;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .preview-content :global(.preview-markdown > :first-child) {
    margin-top: 0;
  }

  .preview-content :global(.preview-markdown > :last-child) {
    margin-bottom: 0;
  }

  .preview-content :global(.preview-markdown h1),
  .preview-content :global(.preview-markdown h2),
  .preview-content :global(.preview-markdown h3),
  .preview-content :global(.preview-markdown h4) {
    margin: 0.85em 0 0.45em;
    font-weight: 650;
    line-height: 1.2;
  }

  .preview-content :global(.preview-markdown h1) {
    font-size: 18px;
  }

  .preview-content :global(.preview-markdown h2) {
    font-size: 15px;
  }

  .preview-content :global(.preview-markdown h3),
  .preview-content :global(.preview-markdown h4) {
    font-size: 13px;
  }

  .preview-content :global(.preview-markdown p),
  .preview-content :global(.preview-markdown ul),
  .preview-content :global(.preview-markdown ol),
  .preview-content :global(.preview-markdown blockquote),
  .preview-content :global(.preview-markdown pre),
  .preview-content :global(.preview-markdown table) {
    margin: 0.65em 0;
  }

  .preview-content :global(.preview-markdown ul),
  .preview-content :global(.preview-markdown ol) {
    padding-left: 1.35em;
  }

  .preview-content :global(.preview-markdown code),
  .preview-content :global(.preview-markdown pre) {
    font-family: var(--terminal-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
    font-size: 11px;
  }

  .preview-content :global(.preview-markdown code) {
    border-radius: 4px;
    padding: 1px 4px;
    background: color-mix(in srgb, var(--app-fg) 9%, transparent);
  }

  .preview-content :global(.preview-markdown pre) {
    max-width: 100%;
    overflow-x: hidden;
    border-radius: 6px;
    padding: 8px;
    background: color-mix(in srgb, var(--app-fg) 7%, transparent);
    white-space: pre-wrap;
  }

  .preview-content :global(.preview-markdown pre code) {
    padding: 0;
    background: transparent;
  }

  .preview-content :global(.preview-markdown blockquote) {
    border-left: 2px solid color-mix(in srgb, var(--app-border) 80%, transparent);
    padding-left: 8px;
    color: color-mix(in srgb, var(--app-fg) 68%, transparent);
  }

  .preview-content :global(.preview-markdown table) {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }

  .preview-content :global(.preview-markdown th),
  .preview-content :global(.preview-markdown td) {
    border: 1px solid color-mix(in srgb, var(--app-border) 72%, transparent);
    padding: 4px 6px;
    vertical-align: top;
  }

  .preview-content :global(.preview-markdown .katex-display) {
    max-width: 100%;
    overflow-x: hidden;
    overflow-y: hidden;
    white-space: normal;
  }

  .preview-content :global(.image-preview) {
    min-width: 0;
    min-height: 0;
    display: grid;
    overflow: hidden;
    place-items: center;
    padding: 10px;
  }

  .preview-content :global(.image-preview img) {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
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

  .dialog-scrim {
    position: absolute;
    inset: 0;
    z-index: 3;
    display: grid;
    place-items: center;
    padding: 16px;
    background: color-mix(in srgb, var(--app-bg) 38%, transparent);
  }

  .dialog-backdrop {
    position: absolute;
    inset: 0;
    border: 0;
    background: transparent;
  }

  .name-dialog {
    position: relative;
    z-index: 1;
    width: min(320px, 100%);
    display: grid;
    gap: 12px;
    border: 1px solid var(--app-border);
    border-radius: 8px;
    padding: 14px;
    background: var(--app-bg);
    box-shadow: 0 18px 48px color-mix(in srgb, black 30%, transparent);
  }

  .name-dialog h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 650;
  }

  .name-dialog label {
    display: grid;
    gap: 6px;
    font-size: 12px;
    color: color-mix(in srgb, var(--app-fg) 72%, transparent);
  }

  .name-dialog input {
    min-width: 0;
    height: 30px;
    border: 1px solid var(--app-border);
    border-radius: 6px;
    padding: 0 8px;
    background: color-mix(in srgb, var(--app-bg) 90%, var(--app-control));
    color: var(--app-fg);
    font: inherit;
  }

  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .dialog-actions button {
    min-width: 70px;
    height: 30px;
    border: 1px solid var(--app-border);
    border-radius: 6px;
    background: color-mix(in srgb, var(--app-bg) 82%, var(--app-control));
  }

  .drop-overlay {
    position: absolute;
    inset: 8px;
    z-index: 2;
    display: grid;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--app-accent) 72%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--app-bg) 74%, transparent);
    color: var(--app-fg);
    pointer-events: none;
  }

  .drop-overlay span {
    border-radius: 6px;
    padding: 6px 10px;
    background: color-mix(in srgb, var(--app-control) 84%, var(--app-bg));
    font-size: 12px;
    font-weight: 650;
  }

  .context-menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 9;
    border: 0;
    padding: 0;
    background: transparent;
  }

  .files-context-menu {
    position: fixed;
    z-index: 10;
    min-width: 154px;
    display: grid;
    gap: 1px;
    border: 1px solid color-mix(in srgb, var(--app-border) 88%, transparent);
    border-radius: 7px;
    padding: 4px;
    background: color-mix(in srgb, var(--app-bg) 94%, var(--app-control));
    box-shadow: 0 12px 32px color-mix(in srgb, black 22%, transparent);
  }

  .files-context-menu button {
    min-width: 0;
    height: 26px;
    border: 0;
    border-radius: 5px;
    padding: 0 8px;
    background: transparent;
    color: inherit;
    font-size: 12px;
    text-align: left;
  }

  .files-context-menu button:hover:not(:disabled),
  .files-context-menu button:focus-visible {
    background: color-mix(in srgb, var(--app-active) 72%, transparent);
    outline: none;
  }

  .files-context-menu button.dangerous {
    color: var(--app-danger);
  }

  .files-selection-summary {
    min-width: 0;
    min-height: 24px;
    display: flex;
    align-items: center;
    border-top: 1px solid color-mix(in srgb, var(--app-border) 70%, transparent);
    padding: 0 8px;
    color: color-mix(in srgb, var(--app-fg) 60%, transparent);
    font-size: 11px;
  }

  .files-context-menu button:disabled {
    opacity: 0.42;
  }

  .marquee-selection {
    position: absolute;
    z-index: 8;
    border: 1px solid color-mix(in srgb, var(--app-accent) 72%, transparent);
    border-radius: 3px;
    background: color-mix(in srgb, var(--app-accent) 16%, transparent);
    pointer-events: none;
  }
</style>
