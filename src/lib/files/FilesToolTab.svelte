<script lang="ts">
  import { onMount } from "svelte";
  import { ask, message, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { commands, type FileEntry, type FileListResult, type FilePreviewResult, type FileProviderKind, type FileSearchResult, type TransferEndpoint, type WorkspaceToolTab } from "$lib/bindings";
  import { clearFilesClipboard, filesClipboardSnapshot, setFilesClipboard } from "$lib/files/clipboard.svelte";
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
  };

  let {
    toolTab,
    workspaceId,
    defaultViewMode = "tree",
    showHidden = true,
    deleteBehavior = "direct",
    textPreviewLimitBytes = 1_048_576,
    imagePreviewLimitBytes = 10_485_760,
  }: Props = $props();
  let path = $state<string | null>(null);
  let selectedPath = $state("");
  let viewMode = $state<"tree" | "columns">("tree");
  let viewModeInitialized = false;
  let searchOpen = $state(false);
  let searchQuery = $state("");
  let searchResult = $state<FileSearchResult | null>(null);
  let searchLoading = $state(false);
  let previewPath = $state("");
  let dragHover = $state(false);
  let operationError = $state("");
  let nameDialog = $state<{
    action: "create_directory" | "rename" | "chmod";
    title: string;
    label: string;
    value: string;
  } | null>(null);
  const queryClient = useQueryClient();

  onMount(() => {
    if (!hasTauriRuntime()) return;
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
  const selectedEntry = $derived(entries.find((entry) => entry.path === selectedPath) ?? null);
  const columnPaths = $derived(columnsForPath(currentPath));
  const filesClipboard = $derived(filesClipboardSnapshot());
  const canPaste = $derived(Boolean(filesClipboard && result?.provider.capabilities.can_write));

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

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["files", "list", toolTab.id] });
  }

  async function refreshAfterMutation() {
    selectedPath = "";
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
    previewPath = entry.kind === "file" || entry.kind === "symlink" ? entry.path : "";
    if (entry.kind !== "directory") return;
    path = entry.path;
    searchResult = null;
    previewPath = "";
  }

  function openSearchMatch(match: FileSearchResult["matches"][number]) {
    selectedPath = match.path;
    if (match.kind !== "directory") return;
    path = match.path;
    clearSearch();
  }

  function selectEntry(entry: FileEntry) {
    selectedPath = entry.path;
    previewPath = entry.kind === "file" || entry.kind === "symlink" ? entry.path : "";
    if (viewMode === "columns" && entry.kind === "directory") {
      path = entry.path;
      searchResult = null;
      previewPath = "";
    }
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

  function basename(value: string) {
    const slashIndex = value.lastIndexOf("/");
    const backslashIndex = value.lastIndexOf("\\");
    const index = Math.max(slashIndex, backslashIndex);
    return index < 0 ? value : value.slice(index + 1);
  }

  function columnsForPath(value: string) {
    if (!value || value === "~") return [value || "~"];
    const normalized = value.replace(/\\/g, "/");
    if (normalized === "/") return ["/"];
    if (/^[A-Za-z]:\//.test(normalized)) {
      const drive = normalized.slice(0, 2);
      const parts = normalized.slice(3).split("/").filter(Boolean);
      const columns = [drive];
      for (const part of parts) {
        columns.push(`${columns[columns.length - 1].replace(/\/$/, "")}/${part}`);
      }
      return columns;
    }
    const parts = normalized.split("/").filter(Boolean);
    const columns = normalized.startsWith("/") ? ["/"] : [];
    for (const part of parts) {
      const parent = columns[columns.length - 1] ?? "";
      columns.push(parent === "/" || parent === "" ? `${parent}${part}` : `${parent}/${part}`);
    }
    return columns.length ? columns : [value];
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
</script>

<section class:drag-hover={dragHover} class="files-tooltab" aria-label="Files">
  {#if !hasTauriRuntime()}
    <div class="files-demo-placeholder" data-testid="files-demo-placeholder">
      <strong>{toolTab.title}</strong>
      <span>Files provider is available in the Tauri app.</span>
    </div>
  {:else}
  <header class="files-toolbar">
    <button type="button" title="Up" aria-label="Up" onclick={goUp}>↑</button>
    <button type="button" title="Refresh" aria-label="Refresh" onclick={() => void refresh()}>↻</button>
    <button type="button" title="New folder" aria-label="New folder" onclick={openCreateDirectoryDialog}>＋</button>
    <button type="button" title="Rename" aria-label="Rename" disabled={!selectedEntry} onclick={openRenameDialog}>✎</button>
    <button type="button" title="Permissions" aria-label="Permissions" disabled={!selectedEntry || !result?.provider.capabilities.can_chmod} onclick={openChmodDialog}>◫</button>
    <button type="button" title="Delete" aria-label="Delete" disabled={!selectedEntry} onclick={() => void deleteSelected()}>⌫</button>
    <button type="button" title="Copy" aria-label="Copy" disabled={!selectedEntry} onclick={copySelected}>⧉</button>
    <button type="button" title="Cut" aria-label="Cut" disabled={!selectedEntry} onclick={cutSelected}>✂</button>
    <button type="button" title="Paste" aria-label="Paste" disabled={!canPaste} onclick={() => void pasteClipboard()}>▣</button>
    <button type="button" title="Upload files" aria-label="Upload files" onclick={() => void uploadFiles()}>⇧</button>
    <button type="button" title="Upload folder" aria-label="Upload folder" onclick={() => void uploadFolder()}>⇪</button>
    <button type="button" title="Download" aria-label="Download" disabled={!selectedEntry} onclick={() => void downloadSelected()}>⇩</button>
    <button type="button" title="Search" aria-label="Search" onclick={() => (searchOpen = !searchOpen)}>⌕</button>
    <div class="view-toggle" role="group" aria-label="View mode">
      <button class:active={viewMode === "tree"} type="button" title="Tree view" aria-label="Tree view" onclick={() => (viewMode = "tree")}>☰</button>
      <button class:active={viewMode === "columns"} type="button" title="Columns view" aria-label="Columns view" onclick={() => (viewMode = "columns")}>▥</button>
    </div>
    <div class="path-field" title={currentPath}>{currentPath}</div>
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
        <div class="search-list">
          {#each searchResult.matches as match (match.path)}
            <button class="search-row" type="button" ondblclick={() => openSearchMatch(match)} onclick={() => (selectedPath = match.path)}>
              <span>{match.name}</span>
              <small>{match.path}</small>
            </button>
          {/each}
          {#each searchResult.diagnostics as diagnostic, index (`${index}-${diagnostic}`)}
            <p class="search-diagnostic">{diagnostic}</p>
          {/each}
        </div>
      </div>
    {:else if viewMode === "columns"}
      <div class="columns-view" aria-label="Columns file browser">
        {#each columnPaths as columnPath (columnPath)}
          <section class="file-column" aria-label={columnPath}>
            <header title={columnPath}>{basename(columnPath) || columnPath}</header>
            {#if columnPath === currentPath}
              <div class="column-list">
                {#each entries as entry (entry.path)}
                  <button
                    class:selected={selectedPath === entry.path}
                    class="column-row"
                    type="button"
                    ondblclick={() => openEntry(entry)}
                    onclick={() => selectEntry(entry)}
                  >
                    <span class="name-cell" title={entry.symlink_target ? `${entry.path} -> ${entry.symlink_target}` : entry.path}>
                      <span class="kind-icon" aria-hidden="true">{entry.kind === "directory" ? "▸" : entry.kind === "symlink" ? "↪" : ""}</span>
                      {entry.name}
                    </span>
                    <small>{formatSize(entry)}</small>
                  </button>
                {/each}
              </div>
            {/if}
          </section>
	        {/each}
	        <section class="file-column preview-column" aria-label="Preview">
	          <header>Preview</header>
	          {@render previewPanel()}
	        </section>
	      </div>
	    {:else}
	      <div class="tree-preview-layout">
	        <div class="files-table" role="treegrid" aria-rowcount={entries.length}>
	          <div class="files-row files-head" role="row">
	            <span>Name</span>
	            <span>Size</span>
	            <span>Modified</span>
	            <span>Permissions</span>
	          </div>
	          {#each entries as entry (entry.path)}
	            <button
	              class:selected={selectedPath === entry.path}
	              class="files-row"
	              type="button"
	              role="row"
	              ondblclick={() => openEntry(entry)}
	              onclick={() => selectEntry(entry)}
	            >
	              <span class="name-cell" title={entry.symlink_target ? `${entry.path} -> ${entry.symlink_target}` : entry.path}>
	                <span class="kind-icon" aria-hidden="true">{entry.kind === "directory" ? "▸" : entry.kind === "symlink" ? "↪" : ""}</span>
	                {entry.name}
	              </span>
	              <span>{formatSize(entry)}</span>
	              <span>{formatModified(entry)}</span>
	              <span>{entry.permissions ?? ""}</span>
	            </button>
	          {/each}
	        </div>
	        <aside class="tree-preview" aria-label="Preview">
	          {@render previewPanel()}
	        </aside>
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
  {#if !selectedEntry}
    <div class="preview-empty">Select a file to preview</div>
  {:else if selectedEntry.kind === "directory"}
    <div class="preview-empty">Directory selected</div>
  {:else if previewQuery.isPending}
    <div class="preview-empty">Loading preview...</div>
  {:else if previewQuery.error}
    <div class="preview-empty error">{previewQuery.error instanceof Error ? previewQuery.error.message : String(previewQuery.error)}</div>
  {:else if previewResult}
    <div class="preview-content">
      <header>
        <strong title={previewResult.path}>{previewResult.name}</strong>
        <span>{formatPreviewSize(previewResult)}</span>
        <span>{formatPreviewModified(previewResult)}</span>
      </header>
      {#if previewResult.content.kind === "text"}
        <pre>{previewResult.content.text}</pre>
      {:else if previewResult.content.kind === "image"}
        <div class="image-preview">
          <img alt={previewResult.name} src={previewImageSrc(previewResult)} />
        </div>
      {:else if previewResult.content.kind === "too_large"}
        <div class="preview-empty">Preview limit: {formatBytes(previewResult.content.limit_bytes)}</div>
      {:else}
        <div class="preview-empty">{previewResult.content.reason}</div>
      {/if}
    </div>
  {:else}
    <div class="preview-empty">No preview</div>
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
    display: grid;
    grid-template-columns: repeat(13, 30px) auto minmax(0, 1fr);
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
    min-width: 0;
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

  .files-table {
    min-width: 0;
    min-height: 0;
    overflow: auto;
    font-size: 12px;
  }

  .tree-preview-layout {
    min-width: 0;
    min-height: 0;
    display: grid;
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

  .search-list {
    min-width: 0;
    min-height: 0;
    overflow: auto;
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

  .columns-view {
    min-width: 0;
    min-height: 0;
    display: flex;
    overflow: auto;
    font-size: 12px;
  }

  .file-column {
    width: 230px;
    min-width: 230px;
    height: 100%;
    display: grid;
    grid-template-rows: 28px minmax(0, 1fr);
    border-right: 1px solid var(--app-border);
  }

  .preview-column {
    width: 280px;
    min-width: 280px;
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

  .column-list {
    min-width: 0;
    min-height: 0;
    overflow: auto;
  }

  .column-row {
    width: 100%;
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
    color: color-mix(in srgb, var(--app-fg) 55%, transparent);
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
  }

  .kind-icon {
    width: 13px;
    color: color-mix(in srgb, var(--app-fg) 58%, transparent);
  }

  .preview-empty {
    min-width: 0;
    min-height: 100%;
    display: grid;
    place-items: center;
    padding: 16px;
    color: color-mix(in srgb, var(--app-fg) 58%, transparent);
    font-size: 12px;
    text-align: center;
  }

  .preview-empty.error {
    color: var(--app-danger);
  }

  .preview-content {
    min-width: 0;
    min-height: 0;
    height: 100%;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    font-size: 12px;
  }

  .preview-content header {
    min-width: 0;
    display: grid;
    gap: 3px;
    border-bottom: 1px solid color-mix(in srgb, var(--app-border) 65%, transparent);
    padding: 8px 10px;
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

  .preview-content pre {
    min-width: 0;
    min-height: 0;
    margin: 0;
    overflow: auto;
    padding: 10px;
    color: color-mix(in srgb, var(--app-fg) 86%, transparent);
    font-family: var(--terminal-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
    font-size: 11px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .image-preview {
    min-width: 0;
    min-height: 0;
    display: grid;
    place-items: center;
    overflow: auto;
    padding: 10px;
  }

  .image-preview img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
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
