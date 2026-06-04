<script lang="ts">
  import { onMount, tick } from "svelte";
  import { ask, message, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { OverlayScrollbarsComponent } from "overlayscrollbars-svelte";
  import "overlayscrollbars/overlayscrollbars.css";
  import FileIcon from "~icons/lucide/file";
  import FileSymlinkIcon from "~icons/lucide/file-symlink";
  import FolderIcon from "~icons/lucide/folder";
  import { commands, type FileEntry, type FileListResult, type FilePreviewResult, type FileProviderKind, type FileSearchResult, type TransferEndpoint, type WorkspaceToolTab } from "$lib/bindings";
  import { clearFilesClipboard, filesClipboardSnapshot, setFilesClipboard } from "$lib/files/clipboard.svelte";
  import { basename, buildFilesColumnsView, columnsForVisiblePane, type FilesColumnView } from "$lib/files/columns";
  import { DEFAULT_FILES_TOOLBAR_ACTION_IDS, normalizeFilesToolbarActionIds, type FilesToolbarActionId } from "$lib/files/toolbar-actions";
  import { buildFileTreeRows, fileTreeClickAction, fileTreeDoubleClickAction, isRenderableFilePreview, shouldShowFilePreviewRegion } from "$lib/files/tree";
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
  }: Props = $props();
  let path = $state<string | null>(null);
  let selectedPath = $state("");
  let lastSelectedEntry = $state<FileEntry | null>(null);
  let viewMode = $state<"tree" | "columns">("tree");
  let viewModeInitialized = false;
  let searchOpen = $state(false);
  let searchQuery = $state("");
  let searchResult = $state<FileSearchResult | null>(null);
  let searchLoading = $state(false);
  let previewPath = $state("");
  let dragHover = $state(false);
  let operationError = $state("");
  let expandedTreePaths = $state<Record<string, boolean>>({});
  let treeChildrenByPath = $state<Record<string, FileEntry[]>>({});
  let treeLoadingByPath = $state<Record<string, boolean>>({});
  let treeErrorByPath = $state<Record<string, string>>({});
  let filesRoot: HTMLElement | null = null;
  let columnsPanes = $state<ColumnsPane[]>([]);
  let columnsMotion = $state<ColumnsMotion>("idle");
  let columnsMotionPreparing = $state(false);
  let columnsMotionActive = $state(false);
  let columnsMotionSettling = $state(false);
  let columnsResizeColumnCount = $state<number | null>(null);
  let nameDialog = $state<{
    action: "create_directory" | "rename" | "chmod";
    title: string;
    label: string;
    value: string;
  } | null>(null);
  type FilesColumn = FilesColumnView<FileEntry>;
  type ColumnsMotion = "idle" | "forward" | "backward" | "resize";
  type ColumnsMotionHint = "forward" | "backward" | "none";
  type ColumnsPane = {
    id: string;
    columns: FilesColumn[];
    current: boolean;
  };
  let lastColumnsSignature = "";
  let pendingColumnsMotionHint = $state<ColumnsMotionHint | null>(null);
  let columnsMotionGeneration = 0;
  let columnsMotionCleanup: number | null = null;
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
  const columnsMotionDurationMs = 180;
  const columnsMotionEasing = "cubic-bezier(0.22, 1, 0.36, 1)";

  onMount(() => {
    if (!hasTauriRuntime()) {
      return () => {
        clearColumnsMotionCleanup();
      };
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          dragHover = true;
          return;
        }
        if (event.payload.type === "leave") {
          dragHover = false;
          return;
        }
        dragHover = false;
        void uploadDroppedPaths(event.payload.paths).catch((error) => {
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
      clearColumnsMotionCleanup();
      unlisten?.();
    };
  });

  const filesQuery = createQuery(() => ({
    queryKey: ["files", "list", toolTab.id, toolTab.host_id, path],
    enabled: hasTauriRuntime(),
    queryFn: () =>
      unwrapCommand(
        commands.listFiles({
          host_id: toolTab.host_id,
          path,
          accept_new_host_key: false,
          update_changed_host_key: false,
          credential: null,
          save_credential: false,
        }),
      ),
    staleTime: 8_000,
  }));

  const result = $derived(filesQuery.data as FileListResult | undefined);
  const currentPath = $derived(result?.provider.current_path ?? path ?? toolTab.title);
  const entries = $derived((result?.entries ?? []).filter((entry) => showHidden || !entry.name.startsWith(".")));
  const visibleTreeChildrenByPath = $derived(filterEntriesByVisibility(treeChildrenByPath));
  const treeRows = $derived(
    buildFileTreeRows({
      rootEntries: entries,
      childrenByPath: visibleTreeChildrenByPath,
      expandedPaths: recordKeySet(expandedTreePaths),
      loadingPaths: recordKeySet(treeLoadingByPath),
      errorByPath: recordStringMap(treeErrorByPath),
    }),
  );
  const selectedEntry = $derived(findEntryByPath(selectedPath) ?? null);
  const fileColumns = $derived(buildFilesColumnsView({ currentPath, selectedPath, activeEntries: entries, childrenByPath: visibleTreeChildrenByPath }));
  const filesClipboard = $derived(filesClipboardSnapshot());
  const canPaste = $derived(Boolean(filesClipboard && result?.provider.capabilities.can_write));
  const visibleToolbarActionIds = $derived(normalizeFilesToolbarActionIds(toolbarActionIds));

  const previewQuery = createQuery(() => ({
    queryKey: ["files", "preview", toolTab.id, toolTab.host_id, previewPath, textPreviewLimitBytes, imagePreviewLimitBytes],
    enabled: hasTauriRuntime() && Boolean(previewPath),
    queryFn: () =>
      unwrapCommand(
        commands.previewFile({
          host_id: toolTab.host_id,
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
      selectedPath: selectedEntry?.path ?? "",
      previewPath,
      preview: previewResult,
    }),
  );
  let remoteHelperChecked = false;

  $effect(() => {
    if (!path && result?.provider.current_path) {
      path = result.provider.current_path;
    }
  });

  $effect(() => {
    if (viewModeInitialized) return;
    viewMode = defaultViewMode;
    viewModeInitialized = true;
  });

  $effect(() => {
    syncColumnsPanes(fileColumns);
  });

  async function refresh() {
    clearTreeDirectoryCache();
    await queryClient.invalidateQueries({ queryKey: ["files", "list", toolTab.id] });
  }

  async function refreshAfterMutation() {
    selectedPath = "";
    lastSelectedEntry = null;
    previewPath = "";
    searchResult = null;
    await refresh();
  }

  async function refreshTransfers() {
    await queryClient.invalidateQueries({ queryKey: ["transfers", "queue"] });
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
      if (!remoteHelperChecked) {
        remoteHelperChecked = true;
        const helper = await unwrapCommand(
          commands.remoteSearchHelperInfo({
            host_id: toolTab.host_id,
            ...providerCommandAuth(),
          }),
        );
        if (!helper.available) {
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
          host_id: toolTab.host_id,
          root_path: currentPath,
          query,
          include_hidden: showHidden,
          follow_symlinks: false,
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
    selectedPath = entry.path;
    lastSelectedEntry = entry;
    previewPath = entry.kind === "file" || entry.kind === "symlink" ? entry.path : "";
    if (entry.kind !== "directory") return;
    path = entry.path;
    searchResult = null;
    previewPath = "";
  }

  function openColumnsEntry(entry: FileEntry) {
    if (entry.kind === "directory") return;
    openEntry(entry);
  }

  async function activateTreeEntry(entry: FileEntry) {
    if (fileTreeDoubleClickAction(entry) === "ignore-directory") return;
    selectedPath = entry.path;
    lastSelectedEntry = entry;
    previewPath = entry.kind === "file" || entry.kind === "symlink" ? entry.path : "";
  }

  async function clickTreeEntry(entry: FileEntry) {
    selectedPath = entry.path;
    lastSelectedEntry = entry;
    previewPath = entry.kind === "file" || entry.kind === "symlink" ? entry.path : "";
    if (fileTreeClickAction(entry) === "toggle-directory") {
      await toggleTreeDirectory(entry);
    }
  }

  async function toggleTreeDirectory(entry: FileEntry) {
    if (entry.kind !== "directory") return;
    const willExpand = !expandedTreePaths[entry.path];
    expandedTreePaths = { ...expandedTreePaths, [entry.path]: willExpand };
    if (!willExpand || treeChildrenByPath[entry.path] || treeLoadingByPath[entry.path]) {
      return;
    }

    await loadDirectoryChildren(entry);
  }

  async function loadDirectoryChildren(entry: FileEntry) {
    if (entry.kind !== "directory") return;
    if (treeChildrenByPath[entry.path] || treeLoadingByPath[entry.path]) return;
    treeLoadingByPath = { ...treeLoadingByPath, [entry.path]: true };
    const { [entry.path]: _previousError, ...remainingErrors } = treeErrorByPath;
    treeErrorByPath = remainingErrors;
    try {
      const childResult = await unwrapCommand(
        commands.listFiles({
          host_id: toolTab.host_id,
          path: entry.path,
          ...providerCommandAuth(),
        }),
      );
      treeChildrenByPath = {
        ...treeChildrenByPath,
        [entry.path]: childResult.entries,
      };
    } catch (error) {
      treeErrorByPath = {
        ...treeErrorByPath,
        [entry.path]: error instanceof Error ? error.message : String(error),
      };
    } finally {
      const { [entry.path]: _completed, ...remainingLoading } = treeLoadingByPath;
      treeLoadingByPath = remainingLoading;
    }
  }

  function openSearchMatch(match: FileSearchResult["matches"][number]) {
    selectedPath = match.path;
    lastSelectedEntry = null;
    if (match.kind !== "directory") return;
    path = match.path;
    clearSearch();
  }

  async function selectEntry(entry: FileEntry) {
    pendingColumnsMotionHint = classifyColumnsSelectionMotion(entry);
    selectedPath = entry.path;
    lastSelectedEntry = entry;
    previewPath = entry.kind === "file" || entry.kind === "symlink" ? entry.path : "";
    if (viewMode === "columns" && entry.kind === "directory") {
      searchResult = null;
      previewPath = "";
      await loadDirectoryChildren(entry);
    }
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
      return;
    }

    const previousPane = columnsPanes.find((pane) => pane.current);
    const previousColumns = previousPane?.columns ?? [];
    if (columnsPathSignature(previousColumns) === columnsPathSignature(nextColumns)) {
      if (columnsMotionInFlight()) {
        columnsPanes = columnsPanes.map((pane) =>
          pane.current
            ? {
                ...pane,
                columns: nextColumns,
                id: currentColumnsPaneId(),
              }
            : pane,
        );
        lastColumnsSignature = nextSignature;
        return;
      }
      const scrollOffsets = captureColumnsScrollOffsets();
      clearColumnsMotionCleanup();
      columnsMotion = "idle";
      columnsMotionPreparing = false;
      columnsMotionActive = false;
      columnsMotionSettling = false;
      columnsResizeColumnCount = null;
      columnsPanes = [currentColumnsPane(nextColumns)];
      lastColumnsSignature = nextSignature;
      scheduleColumnsScrollRestore(scrollOffsets);
      return;
    }
    if (shouldReplaceColumnsWithoutMotion(previousColumns, nextColumns)) {
      if (previousColumns.length !== nextColumns.length) {
        startColumnsResizeMotion(previousColumns, nextColumns, nextSignature);
        return;
      }
      const scrollOffsets = captureColumnsScrollOffsets();
      clearColumnsMotionCleanup();
      columnsMotion = "idle";
      columnsMotionPreparing = false;
      columnsMotionActive = false;
      columnsMotionSettling = false;
      columnsResizeColumnCount = null;
      columnsPanes = [currentColumnsPane(nextColumns)];
      lastColumnsSignature = nextSignature;
      clearPendingColumnsMotionHintIfSettled(nextColumns);
      scheduleColumnsScrollRestore(scrollOffsets);
      return;
    }
    if (previousColumns.length !== nextColumns.length) {
      startColumnsResizeMotion(previousColumns, nextColumns, nextSignature);
      return;
    }

    const previousSignature = lastColumnsSignature;
    const direction = pendingColumnsMotionHint === "forward" || pendingColumnsMotionHint === "backward" ? pendingColumnsMotionHint : inferColumnsMotion(previousColumns, nextColumns);
    pendingColumnsMotionHint = null;
    const generation = ++columnsMotionGeneration;
    const previous = { id: `previous:${generation}:${previousSignature}`, columns: previousColumns, current: false };
    const current = { id: `current:${generation}:${nextSignature}`, columns: nextColumns, current: true };

    clearColumnsMotionCleanup();
    columnsMotionSettling = false;
    columnsMotion = direction;
    columnsResizeColumnCount = null;
    columnsMotionPreparing = true;
    columnsMotionActive = false;
    columnsPanes = direction === "backward" ? [current, previous] : [previous, current];
    lastColumnsSignature = nextSignature;

    requestAnimationFrame(() => {
      if (columnsMotionGeneration !== generation) return;
      columnsMotionPreparing = false;
      columnsMotionActive = true;
      columnsMotionCleanup = window.setTimeout(() => {
        if (columnsMotionGeneration !== generation) return;
        const finalPane = columnsPanes.find((pane) => pane.current);
        const finalColumns = finalPane?.columns ?? nextColumns;
        columnsMotionSettling = true;
        columnsPanes = [currentColumnsPane(finalColumns)];
        columnsMotion = "idle";
        columnsResizeColumnCount = null;
        columnsMotionPreparing = false;
        columnsMotionActive = false;
        columnsMotionCleanup = null;
        requestAnimationFrame(() => {
          if (columnsMotionGeneration !== generation) return;
          columnsMotionSettling = false;
        });
      }, columnsMotionDurationMs + 40);
    });
  }

  function startColumnsResizeMotion(previousColumns: FilesColumn[], nextColumns: FilesColumn[], nextSignature: string) {
    const generation = ++columnsMotionGeneration;
    const scrollOffsets = captureColumnsScrollOffsets();
    clearColumnsMotionCleanup();
    columnsMotionSettling = false;
    columnsMotion = "resize";
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
          columnsMotionCleanup = window.setTimeout(() => {
            if (columnsMotionGeneration !== generation) return;
            columnsMotion = "idle";
            columnsMotionPreparing = false;
            columnsMotionActive = false;
            columnsResizeColumnCount = null;
            columnsMotionCleanup = null;
          }, columnsMotionDurationMs + 40);
        });
      });
    });
  }

  function columnsMotionInFlight() {
    return columnsMotionPreparing || columnsMotionActive || columnsMotionCleanup !== null;
  }

  function shouldReplaceColumnsWithoutMotion(previous: readonly FilesColumn[], next: readonly FilesColumn[]) {
    if (pendingColumnsMotionHint === "none") return true;
    if (pendingColumnsMotionHint === "forward" || pendingColumnsMotionHint === "backward") return false;
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

  function classifyColumnsSelectionMotion(entry: FileEntry): ColumnsMotionHint | null {
    if (viewMode !== "columns") return null;
    if (entry.kind !== "directory") return "none";

    const currentColumns = columnsForMotionBasis();
    const previousLastPath = currentColumns[currentColumns.length - 1]?.path;
    if (!previousLastPath) return null;
    if (sameFilePath(entry.path, previousLastPath)) return "none";
    if (pathDescendsFrom(previousLastPath, entry.path)) return "backward";

    const entryColumnIndex = currentColumns.findIndex((column) => column.entries.some((columnEntry) => sameFilePath(columnEntry.path, entry.path)));
    if (entryColumnIndex >= 0 && entryColumnIndex < currentColumns.length - 1) {
      return currentColumns.length > 2 && entryColumnIndex === 0 ? "backward" : "none";
    }
    return entryColumnIndex === currentColumns.length - 1 ? "forward" : "none";
  }

  function columnsForMotionBasis() {
    return columnsPanes.find((pane) => pane.current)?.columns ?? fileColumns;
  }

  function clearPendingColumnsMotionHintIfSettled(columns: readonly FilesColumn[]) {
    if (!pendingColumnsMotionHint) return;
    const columnsSelectedEntry = selectedEntryForColumnsMotion();
    if (!columnsSelectedEntry || columnsSelectedEntry.kind !== "directory" || columns.some((column) => sameFilePath(column.path, columnsSelectedEntry.path))) {
      pendingColumnsMotionHint = null;
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

  function columnsForRenderedPane(pane: ColumnsPane) {
    return columnsForVisiblePane(pane.columns, { previewVisible: previewVisible && pane.current });
  }

  function columnsSignature(columns: readonly FilesColumn[]) {
    return columns
      .map((column) => `${column.path}\u001e${column.entries.map((entry) => `${entry.path}:${entry.selected ? "1" : "0"}`).join("\u001d")}`)
      .join("\u001f");
  }

  function columnsPathSignature(columns: readonly FilesColumn[]) {
    return columns.map((column) => column.path).join("\u001f");
  }

  function inferColumnsMotion(previous: readonly FilesColumn[], next: readonly FilesColumn[]): ColumnsMotion {
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
    if (parent === "/") return path.startsWith("/");
    return path.startsWith(`${parent}/`);
  }

  function normalizeFilePath(value: string) {
    return value.replace(/\\/g, "/").replace(/\/+$/, "");
  }

  function clearColumnsMotionCleanup() {
    if (columnsMotionCleanup !== null) {
      window.clearTimeout(columnsMotionCleanup);
      columnsMotionCleanup = null;
    }
    columnsMotionPreparing = false;
    columnsMotionActive = false;
    columnsMotionSettling = false;
    columnsResizeColumnCount = null;
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

  function scheduleColumnsScrollRestore(offsets: ReadonlyMap<string, { scrollTop: number; anchorPath: string | null }>) {
    if (!offsets.size) return;
    let remainingFrames = 5;
    const restore = () => {
      restoreColumnsScrollOffsets(offsets);
      remainingFrames -= 1;
      if (remainingFrames > 0) requestAnimationFrame(restore);
    };
    requestAnimationFrame(restore);
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

  function goUp() {
    if (!currentPath || currentPath === "/" || currentPath === "~") return;
    const trimmed = currentPath.replace(/\/+$/, "");
    const index = trimmed.lastIndexOf("/");
    path = index <= 0 ? "/" : trimmed.slice(0, index);
    searchResult = null;
    previewPath = "";
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

  function providerCommandAuth() {
    return {
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

  function clearTreeDirectoryCache() {
    treeChildrenByPath = {};
    treeLoadingByPath = {};
    treeErrorByPath = {};
  }

  function findEntryByPath(value: string) {
    if (!value) return null;
    for (const entry of entries) {
      if (entry.path === value) return entry;
    }
    for (const children of Object.values(visibleTreeChildrenByPath)) {
      const entry = children.find((child) => child.path === value);
      if (entry) return entry;
    }
    return null;
  }

  function parentPathOf(value: string) {
    const slashIndex = value.lastIndexOf("/");
    const backslashIndex = value.lastIndexOf("\\");
    const index = Math.max(slashIndex, backslashIndex);
    if (index < 0) return currentPath;
    if (index === 0) return value[0];
    return value.slice(0, index);
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

  function sameProviderEndpoint(first: TransferEndpoint, second: TransferEndpoint) {
    return first.kind === second.kind && first.provider_kind === second.provider_kind && first.host_id === second.host_id;
  }

  function localEndpoint(filePath: string): TransferEndpoint {
    return {
      kind: "local",
      provider_kind: null,
      host_id: null,
      path: filePath,
    };
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
    if (!selectedEntry) return;
    operationError = "";
    nameDialog = {
      action: "rename",
      title: "Rename",
      label: "New name",
      value: selectedEntry.name,
    };
  }

  function openChmodDialog() {
    if (!selectedEntry) return;
    operationError = "";
    nameDialog = {
      action: "chmod",
      title: "Permissions",
      label: "Octal mode",
      value: selectedEntry.permissions?.slice(-4).replace(/^0(?=[0-7]{3}$)/, "") ?? "644",
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
    if (nameDialog.action === "create_directory") {
      await unwrapCommand(
        commands.createDirectory({
          host_id: toolTab.host_id,
          parent_path: currentPath,
          name: value,
          ...providerCommandAuth(),
        }),
      );
    } else if (nameDialog.action === "rename") {
      if (!selectedEntry) throw new Error("No file is selected for rename");
      const destinationPath = joinPath(parentPathOf(selectedEntry.path), value);
      await unwrapCommand(
        commands.renameFile({
          host_id: toolTab.host_id,
          source_path: selectedEntry.path,
          destination_path: destinationPath,
          ...providerCommandAuth(),
        }),
      );
    } else {
      if (!selectedEntry) throw new Error("No file is selected for chmod");
      await unwrapCommand(
        commands.chmodFile({
          host_id: toolTab.host_id,
          path: selectedEntry.path,
          mode: value,
          ...providerCommandAuth(),
        }),
      );
    }
    closeNameDialog();
    await refreshAfterMutation();
  }

  async function deleteSelected() {
    if (!selectedEntry) return;
    operationError = "";
    if (deleteBehavior === "try_remote_trash" && result?.provider.kind === "sftp") {
      const trashInfo = await unwrapCommand(
        commands.remoteTrashInfo({
          host_id: toolTab.host_id,
          ...providerCommandAuth(),
        }),
      );
      if (trashInfo.available) {
        const choice = await message(`Move to remote Trash or delete permanently?\n\n${selectedEntry.path}`, {
          title: "Delete File",
          kind: "warning",
          buttons: {
            yes: "Move to Trash",
            no: "Delete Permanently",
            cancel: "Cancel",
          },
        });
        if (choice === "Move to Trash") {
          await unwrapCommand(
            commands.trashFile({
              host_id: toolTab.host_id,
              path: selectedEntry.path,
              ...providerCommandAuth(),
            }),
          );
          await refreshAfterMutation();
          return;
        }
        if (choice !== "Delete Permanently") return;
      }
    }
    const confirmed = await ask(`Delete permanently? This cannot be undone.\n\n${selectedEntry.path}`, {
      title: "Delete File",
      kind: "warning",
    });
    if (!confirmed) return;
    await unwrapCommand(
      commands.deleteFile({
        host_id: toolTab.host_id,
        path: selectedEntry.path,
        ...providerCommandAuth(),
      }),
    );
    await refreshAfterMutation();
  }

  function copySelected() {
    if (!selectedEntry) return;
    operationError = "";
    setFilesClipboard({
      mode: "copy",
      items: [clipboardItem(selectedEntry)],
    });
  }

  function cutSelected() {
    if (!selectedEntry) return;
    operationError = "";
    setFilesClipboard({
      mode: "cut",
      items: [clipboardItem(selectedEntry)],
    });
  }

  async function pasteClipboard() {
    const snapshot = filesClipboardSnapshot();
    if (!snapshot || !result) return;
    operationError = "";
    const destinationDirectory = providerEndpoint(currentPath);
    for (const item of snapshot.items) {
      const destinationPath = joinPath(currentPath, item.name);
      const destination = providerEndpoint(destinationPath);
      if (snapshot.mode === "cut" && sameProviderEndpoint(item.endpoint, destinationDirectory)) {
        await unwrapCommand(
          commands.renameFile({
            host_id: toolTab.host_id,
            source_path: item.endpoint.path,
            destination_path: destinationPath,
            ...providerCommandAuth(),
          }),
        );
      } else if (snapshot.mode === "cut") {
        operationError = "Move across hosts or providers is not available yet. Use Copy, then delete the source after the transfer completes.";
        return;
      } else {
        await unwrapCommand(
          commands.createTransferTask({
            source: item.endpoint,
            destination,
            initiator_workspace_id: workspaceId,
            related_workspace_ids: Array.from(new Set([workspaceId, item.workspaceId])),
          }),
        );
      }
    }
    if (snapshot.mode === "cut") clearFilesClipboard();
    await refreshAfterMutation();
    await refreshTransfers();
  }

  async function uploadFiles() {
    operationError = "";
    const selected = await openDialog({
      multiple: true,
      directory: false,
      title: "Upload Files",
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    for (const localPath of paths) {
      const name = basename(localPath);
      if (!name) throw new Error(`Cannot upload path without a file name: ${localPath}`);
      await unwrapCommand(
        commands.createTransferTask({
          source: localEndpoint(localPath),
          destination: providerEndpoint(joinPath(currentPath, name)),
          initiator_workspace_id: workspaceId,
          related_workspace_ids: [workspaceId],
        }),
      );
    }
    await refreshTransfers();
  }

  async function uploadFolder() {
    operationError = "";
    const selected = await openDialog({
      multiple: false,
      directory: true,
      recursive: true,
      title: "Upload Folder",
    });
    if (!selected) return;
    const name = basename(selected);
    if (!name) throw new Error(`Cannot upload path without a folder name: ${selected}`);
    await unwrapCommand(
      commands.createTransferTask({
        source: localEndpoint(selected),
        destination: providerEndpoint(joinPath(currentPath, name)),
        initiator_workspace_id: workspaceId,
        related_workspace_ids: [workspaceId],
      }),
    );
    await refreshTransfers();
  }

  async function uploadDroppedPaths(paths: string[]) {
    if (paths.length === 0) return;
    operationError = "";
    for (const localPath of paths) {
      const name = basename(localPath);
      if (!name) throw new Error(`Cannot upload path without a file name: ${localPath}`);
      await unwrapCommand(
        commands.createTransferTask({
          source: localEndpoint(localPath),
          destination: providerEndpoint(joinPath(currentPath, name)),
          initiator_workspace_id: workspaceId,
          related_workspace_ids: [workspaceId],
        }),
      );
    }
    await refreshTransfers();
  }

  async function downloadSelected() {
    if (!selectedEntry) return;
    operationError = "";
    const destination = await saveDialog({
      title: selectedEntry.kind === "directory" ? "Download Folder" : "Download File",
      defaultPath: selectedEntry.name,
    });
    if (!destination) return;
    await unwrapCommand(
      commands.createTransferTask({
        source: providerEndpoint(selectedEntry.path),
        destination: localEndpoint(destination),
        initiator_workspace_id: workspaceId,
        related_workspace_ids: [workspaceId],
      }),
    );
    await refreshTransfers();
  }

  function toolbarActionLabel(id: FilesToolbarActionId) {
    if (id === "up") return "Up";
    if (id === "refresh") return "Refresh";
    if (id === "new_folder") return "New folder";
    if (id === "rename") return "Rename";
    if (id === "permissions") return "Permissions";
    if (id === "delete") return "Delete";
    if (id === "copy") return "Copy";
    if (id === "cut") return "Cut";
    if (id === "paste") return "Paste";
    if (id === "upload_files") return "Upload files";
    if (id === "upload_folder") return "Upload folder";
    if (id === "download") return "Download";
    if (id === "search") return "Search";
    if (id === "view_mode") return "View mode";
    if (id === "path") return "Path";
    throw new Error(`Unsupported Files toolbar action id: ${id}`);
  }

  function toolbarActionIcon(id: FilesToolbarActionId) {
    if (id === "up") return "↑";
    if (id === "refresh") return "↻";
    if (id === "new_folder") return "＋";
    if (id === "rename") return "✎";
    if (id === "permissions") return "◫";
    if (id === "delete") return "⌫";
    if (id === "copy") return "⧉";
    if (id === "cut") return "✂";
    if (id === "paste") return "▣";
    if (id === "upload_files") return "⇧";
    if (id === "upload_folder") return "⇪";
    if (id === "download") return "⇩";
    if (id === "search") return "⌕";
    throw new Error(`Files toolbar action ${id} does not have an icon button`);
  }

  function toolbarActionDisabled(id: FilesToolbarActionId) {
    if (id === "rename" || id === "delete" || id === "copy" || id === "cut" || id === "download") return !selectedEntry;
    if (id === "permissions") return !selectedEntry || !result?.provider.capabilities.can_chmod;
    if (id === "paste") return !canPaste;
    return false;
  }

  async function runToolbarAction(id: FilesToolbarActionId) {
    if (id === "up") {
      goUp();
      return;
    }
    if (id === "refresh") {
      await refresh();
      return;
    }
    if (id === "new_folder") {
      openCreateDirectoryDialog();
      return;
    }
    if (id === "rename") {
      openRenameDialog();
      return;
    }
    if (id === "permissions") {
      openChmodDialog();
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
    if (id === "paste") {
      await pasteClipboard();
      return;
    }
    if (id === "upload_files") {
      await uploadFiles();
      return;
    }
    if (id === "upload_folder") {
      await uploadFolder();
      return;
    }
    if (id === "download") {
      await downloadSelected();
      return;
    }
    if (id === "search") {
      searchOpen = !searchOpen;
      return;
    }
    throw new Error(`Unsupported executable Files toolbar action id: ${id}`);
  }
</script>

<section bind:this={filesRoot} class:drag-hover={dragHover} class="files-tooltab" aria-label="Files">
  {#if !hasTauriRuntime()}
    <div class="files-demo-placeholder" data-testid="files-demo-placeholder">
      <strong>{toolTab.title}</strong>
      <span>Files provider is available in the Tauri app.</span>
    </div>
  {:else}
  <header class="files-toolbar">
    {#each visibleToolbarActionIds as actionId (actionId)}
      {#if actionId === "view_mode"}
        <div class="view-toggle" role="group" aria-label="View mode">
          <button class:active={viewMode === "tree"} type="button" title="Tree view" aria-label="Tree view" onclick={() => (viewMode = "tree")}>☰</button>
          <button class:active={viewMode === "columns"} type="button" title="Columns view" aria-label="Columns view" onclick={() => (viewMode = "columns")}>▥</button>
        </div>
      {:else if actionId === "path"}
        <div class="path-field" title={currentPath}>{currentPath}</div>
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
      <input bind:value={searchQuery} placeholder="Search names recursively" />
      <button type="submit" disabled={searchLoading}>{searchLoading ? "Searching" : "Search"}</button>
      <button type="button" onclick={clearSearch}>Close</button>
    </form>
  {/if}

  {#if filesQuery.isPending}
    <div class="files-status">Loading...</div>
  {:else if filesQuery.error}
    <div class="files-status error">{filesQuery.error instanceof Error ? filesQuery.error.message : String(filesQuery.error)}</div>
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
          {#each searchResult.matches as match (match.path)}
            <button class="search-row" type="button" ondblclick={() => openSearchMatch(match)} onclick={() => (selectedPath = match.path)}>
              <span>{match.name}</span>
              <small>{match.path}</small>
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
          class="columns-content"
          style={`--columns-motion-duration: ${columnsMotionDurationMs}ms; --columns-motion-easing: ${columnsMotionEasing};`}
        >
          {#each columnsPanes as pane (pane.id)}
            <div
              class:current={pane.current}
              class="columns-pane"
              aria-hidden={!pane.current}
              style={`--columns-count: ${columnsPaneColumnCount(pane)};`}
            >
              {#each columnsForRenderedPane(pane) as column (columnsRenderKey(column.path))}
                <section class="file-column" aria-label={column.path}>
                  <header title={column.path}>{column.title}</header>
                  <OverlayScrollbarsComponent element="div" class="column-list" options={overlayVerticalOptions} defer>
                    {#each column.entries as entry (entry.path)}
                      <button
                        class:selected={entry.selected}
                        class="column-row"
                        data-entry-kind={entry.kind}
                        data-entry-path={entry.path}
                        type="button"
                        ondblclick={() => openColumnsEntry(entry)}
                        onclick={() =>
                          void selectEntry(entry).catch((error) => {
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
                          {entry.name}
                        </span>
                        <small>{formatSize(entry)}</small>
                      </button>
                    {/each}
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
	        <OverlayScrollbarsComponent element="div" class="files-table" role="treegrid" aria-rowcount={treeRows.length} options={overlayBothOptions} defer>
	          <div class="files-row files-head" role="row">
	            <span>Name</span>
	            <span>Size</span>
	            <span>Modified</span>
	            <span>Permissions</span>
	          </div>
	          {#each treeRows as row (row.entry.path)}
	            <div
	              class:selected={selectedPath === row.entry.path}
	              class="files-row"
	              role="row"
                tabindex="0"
	              aria-level={row.depth + 1}
	              aria-expanded={row.entry.kind === "directory" ? row.expanded : undefined}
	              style={`--tree-depth: ${row.depth};`}
	              ondblclick={() =>
	                void activateTreeEntry(row.entry).catch((error) => {
	                  operationError = error instanceof Error ? error.message : String(error);
	                })}
	              onclick={() =>
                  void clickTreeEntry(row.entry).catch((error) => {
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
	                {row.entry.name}
	              </span>
	              <span>{formatSize(row.entry)}</span>
	              <span>{formatModified(row.entry)}</span>
	              <span>{row.error ?? row.entry.permissions ?? ""}</span>
	            </div>
	          {/each}
	        </OverlayScrollbarsComponent>
          {#if previewVisible}
            <aside class="tree-preview" aria-label="Preview">
              {@render previewPanel()}
            </aside>
          {/if}
	      </div>
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

  {#if dragHover}
    <div class="drop-overlay" aria-hidden="true">
      <span>Drop to upload</span>
    </div>
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
      {#if previewResult.content.kind === "text"}
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
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 6px;
    padding: 5px 6px;
    border-bottom: 1px solid var(--app-border);
  }

  .search-bar input {
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
    min-height: 32px;
    display: grid;
    grid-template-columns: 180px minmax(0, 1fr);
    gap: 10px;
    align-items: center;
    border: 0;
    border-bottom: 1px solid color-mix(in srgb, var(--app-border) 55%, transparent);
    padding: 0 9px;
    background: transparent;
    text-align: left;
  }

  .search-row span,
  .search-row small {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .search-row small,
  .search-diagnostic {
    color: color-mix(in srgb, var(--app-fg) 58%, transparent);
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
    transition: transform var(--columns-motion-duration, 180ms) var(--columns-motion-easing, cubic-bezier(0.22, 1, 0.36, 1));
    will-change: transform;
  }

  .columns-content.motion-forward.motion-active {
    transform: translateX(-100%);
  }

  .columns-content.motion-backward {
    transform: translateX(-100%);
  }

  .columns-content.motion-backward.motion-active {
    transform: translateX(0);
  }

  .columns-content.motion-resize {
    transform: translateX(0);
    transition: none;
  }

  .columns-content.motion-preparing {
    transition: none;
  }

  .columns-content.motion-settling {
    transform: translateX(0);
    transition: none;
  }

  .columns-pane {
    flex: 0 0 100%;
    width: 100%;
    min-width: 100%;
    height: 100%;
    min-height: 0;
    display: flex;
  }

  .file-column {
    flex: 0 0 calc(100% / max(var(--columns-count, 1), 1));
    width: calc(100% / max(var(--columns-count, 1), 1));
    min-width: 0;
    height: 100%;
    display: grid;
    grid-template-rows: 28px minmax(0, 1fr);
    border-right: 1px solid var(--app-border);
  }

  .preview-column {
    flex: 0 0 calc(100% / max(var(--columns-count, 1), 1));
    width: calc(100% / max(var(--columns-count, 1), 1));
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

  .files-row.selected {
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
    display: flex;
    align-items: center;
    gap: 5px;
    padding-left: calc(var(--tree-depth, 0) * 16px);
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
</style>
