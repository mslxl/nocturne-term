<script lang="ts">
  import { onMount } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import { ask } from "@tauri-apps/plugin-dialog";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { OverlayScrollbarsComponent } from "overlayscrollbars-svelte";
  import "overlayscrollbars/overlayscrollbars.css";
  import { commands, type ConnectionHostDocument, type ConnectionHostEntry, type ConnectionProtocol } from "$lib/bindings";
  import { applyAppPreferences } from "$lib/config/document";
  import HostIcon from "$lib/hosts/HostIcon.svelte";
  import HostIconPicker from "$lib/hosts/HostIconPicker.svelte";
  import { inferHostIcon, resolveHostIcon } from "$lib/hosts/icons";
  import { buildHostFolderTree, compactOptional, cloneHostDocument, emptySshHostDocument, hostAddress, hostFolderPaths, hostHasBlockingDiagnostics, hostSourceLabel, hostSubtitle, setHostProtocol, type HostFolderTreeNode } from "$lib/hosts/model";
  import { hasTauriRuntime } from "$lib/tauri/runtime";
  import { unwrapCommand } from "$lib/terminal/commands";
  import CircleHelp from "~icons/lucide/circle-help";

  const queryClient = useQueryClient();
  const snapshotQuery = createQuery(() => ({
    queryKey: ["config", "snapshot"],
    queryFn: () => unwrapCommand(commands.getConfigSnapshot()),
  }));

  type HostEditorMode = "existing" | "new";

  let editorMode = $state<HostEditorMode>("existing");
  let selectedId = $state("");
  let draft = $state<ConnectionHostDocument | null>(null);
  let pendingDefaultHostId = $state<string | null>(null);
  let selectedDirectory = $state("");
  let errorMessage = $state("");
  let expandedFolders = $state<Record<string, boolean>>({});
  let folderPickerOpen = $state(false);
  let iconPickerOpen = $state(false);
  let iconPickerMode = $state<"quick" | "full">("quick");
  let unlistenConfig: undefined | (() => void);

  const snapshot = $derived(snapshotQuery.data);
  const hosts = $derived(snapshot?.hosts ?? []);
  const selectedHost = $derived(editorMode === "existing" ? selectedConnectionHost(hosts, selectedId) : null);
  const editable = $derived(selectedHost?.source === "user" && !selectedHost.read_only);
  const iconEditable = $derived(editorMode === "new" || editable);
  const hostDirs = $derived(snapshot?.root.host_dirs ?? []);
  const defaultHostId = $derived(snapshot?.root.default_host ?? "");
  const visibleDefaultHostId = $derived(pendingDefaultHostId ?? defaultHostId);
  const defaultChangePending = $derived(!!selectedHost && pendingDefaultHostId === selectedHost.id && selectedHost.id !== defaultHostId);
  const canSave = $derived(!!draft && (editorMode === "new" || editable || defaultChangePending));
  const blockingCount = $derived(hosts.filter(hostHasBlockingDiagnostics).length);
  const hostTree = $derived(buildHostFolderTree(hosts));
  const existingFolders = $derived(hostFolderPaths(hostTree));
  const folderSuggestions = $derived(folderMatches(existingFolders, draft?.folder ?? ""));
  const draftIcon = $derived(draft ? (draft.icon ?? inferHostIcon(draft)) : null);

  $effect(() => {
    if (snapshot?.effective_config.root) applyAppPreferences(snapshot.effective_config.root);
  });

  $effect(() => {
    if (editorMode === "new") return;
    if (!selectedHost) {
      selectedId = "";
      draft = null;
      return;
    }
    if (!selectedId || !hosts.some((host) => host.id === selectedId)) selectedId = selectedHost.id;
    draft = cloneHostDocument(selectedHost.document);
    pendingDefaultHostId = null;
    selectedDirectory = selectedHost.path ? directoryName(selectedHost.path) : hostDirs[0] ?? "";
    iconPickerOpen = false;
  });

  function selectHost(host: ConnectionHostEntry) {
    editorMode = "existing";
    selectedId = host.id;
    draft = cloneHostDocument(host.document);
    pendingDefaultHostId = null;
    selectedDirectory = host.path ? directoryName(host.path) : hostDirs[0] ?? "";
    errorMessage = "";
    iconPickerOpen = false;
  }

  function newHost() {
    editorMode = "new";
    selectedId = "";
    draft = emptySshHostDocument();
    pendingDefaultHostId = null;
    selectedDirectory = hostDirs[0] ?? "";
    errorMessage = "";
    iconPickerOpen = false;
  }

  function copyOpenSshHost(host: ConnectionHostEntry) {
    const document = cloneHostDocument(host.document);
    document.id = "";
    document.name = `${document.name} Copy`;
    editorMode = "new";
    selectedId = "";
    draft = document;
    pendingDefaultHostId = null;
    selectedDirectory = hostDirs[0] ?? "";
    errorMessage = "";
    iconPickerOpen = false;
  }

  async function saveHost() {
    if (!draft) return;
    errorMessage = "";
    try {
      let savedHost = selectedHost;
      if (editable || editorMode === "new") {
        const folder = compactOptional(draft.folder ?? "");
        const document = normalizeDraft(draft);
        if (selectedId && editable) {
          savedHost = await unwrapCommand(commands.updateConnectionHost({ id: selectedId, directory: null, folder, document }));
        } else {
          savedHost = await unwrapCommand(commands.createConnectionHost({ id: null, directory: selectedDirectory || null, folder, document }));
        }
      }
      if (savedHost && pendingDefaultHostId === selectedHost?.id && savedHost.id !== defaultHostId) {
        await unwrapCommand(commands.setDefaultHostCommand(savedHost.id));
      }
      await queryClient.invalidateQueries({ queryKey: ["config"] });
      if (savedHost) {
        editorMode = "existing";
        selectedId = savedHost.id;
        draft = cloneHostDocument(savedHost.document);
        selectedDirectory = savedHost.path ? directoryName(savedHost.path) : hostDirs[0] ?? "";
      } else {
        draft = null;
      }
      pendingDefaultHostId = null;
      iconPickerOpen = false;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  function updateDefaultHost(checked: boolean) {
    if (!selectedHost || hostHasBlockingDiagnostics(selectedHost)) return;
    pendingDefaultHostId = checked ? selectedHost.id : null;
  }

  function toggleIconPicker() {
    if (!iconEditable) return;
    iconPickerMode = "quick";
    iconPickerOpen = !iconPickerOpen;
  }

  function updateDraftIcon(icon: ConnectionHostDocument["icon"]) {
    if (!draft || !iconEditable) return;
    draft.icon = icon;
  }

  async function deleteHost() {
    if (!selectedHost || (selectedHost.source !== "user" && selectedHost.source !== "virtual")) return;
    const message = selectedHost.source === "virtual"
      ? "Remove the default Local Shell from the host list?"
      : "Delete this host file and its Nocturne keyring secrets?";
    const confirmed = await ask(message, { title: "Delete Host", kind: "warning" });
    if (!confirmed) return;
    errorMessage = "";
    try {
      await unwrapCommand(commands.deleteConnectionHost(selectedHost.id));
      editorMode = "existing";
      selectedId = "";
      draft = null;
      pendingDefaultHostId = null;
      await queryClient.invalidateQueries({ queryKey: ["config"] });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  async function repairId() {
    if (!selectedHost || selectedHost.source !== "user") return;
    const confirmed = await ask("Regenerate this host UUID? References and saved secrets for the old UUID will be removed.", { title: "Repair Host ID", kind: "warning" });
    if (!confirmed) return;
    errorMessage = "";
    try {
      await unwrapCommand(commands.repairConnectionHostId(selectedHost.id));
      await queryClient.invalidateQueries({ queryKey: ["config"] });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  function normalizeDraft(document: ConnectionHostDocument): ConnectionHostDocument {
    const next = cloneHostDocument(document);
    next.name = next.name.trim();
    if (next.protocol === "local") {
      if (!next.local) next.local = { command: null, args: [], cwd: null, env: {} };
      next.local.command = compactOptional(next.local.command ?? "");
      next.local.cwd = compactOptional(next.local.cwd ?? "");
      next.local.args = next.local.args.map((item) => item.trim()).filter(Boolean);
      next.ssh = null;
      next.telnet = null;
      return next;
    }
    if (next.protocol !== "ssh" || !next.ssh) throw new Error("Only local and SSH hosts are supported in this editor");
    next.local = null;
    next.ssh.hostname = next.ssh.hostname.trim();
    next.ssh.username = compactOptional(next.ssh.username ?? "");
    next.ssh.identity_file = compactOptional(next.ssh.identity_file ?? "");
    next.ssh.proxy_jump = compactOptional(next.ssh.proxy_jump ?? "");
    return next;
  }

  function updateProtocol(protocol: ConnectionProtocol) {
    if (!draft) return;
    draft = setHostProtocol(draft, protocol);
  }

  function localArgsText(document: ConnectionHostDocument) {
    return document.local?.args.join("\n") ?? "";
  }

  function updateLocalArgs(value: string) {
    if (!draft?.local) return;
    draft.local.args = value.split("\n").map((item) => item.trim()).filter(Boolean);
  }

  function updateDraftFolder(value: string) {
    if (!draft) return;
    draft.folder = value;
    folderPickerOpen = true;
  }

  function chooseFolder(path: string) {
    if (!draft) return;
    draft.folder = path;
    folderPickerOpen = false;
  }

  function toggleFolder(path: string) {
    expandedFolders = {
      ...expandedFolders,
      [path]: expandedFolders[path] !== false ? false : true,
    };
  }

  function folderExpanded(path: string) {
    return expandedFolders[path] !== false;
  }

  function folderMatches(paths: string[], value: string | null | undefined) {
    const query = value?.trim().toLowerCase() ?? "";
    return paths
      .filter((path) => !query || path.toLowerCase().includes(query))
      .slice(0, 8);
  }

  function directoryName(path: string) {
    const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return index >= 0 ? path.slice(0, index) : path;
  }

  function selectedConnectionHost(hosts: ConnectionHostEntry[], selectedId: string): ConnectionHostEntry | null {
    if (selectedId) return hosts.find((host) => host.id === selectedId) ?? null;
    return hosts[0] ?? null;
  }

  onMount(() => {
    if (!hasTauriRuntime()) return;
    void listen("config://changed", () => {
      void queryClient.invalidateQueries({ queryKey: ["config"] });
    }).then((dispose) => {
      unlistenConfig = dispose;
    });
    return () => unlistenConfig?.();
  });
</script>

<svelte:head>
  <title>Nocturne Hosts</title>
</svelte:head>

<main class="host-shell">
  <aside class="host-list" aria-label="Hosts">
    <header>
      <h1>Hosts</h1>
      <div class="new-buttons">
        <button type="button" onclick={newHost}>New</button>
      </div>
    </header>
    {#if blockingCount}
      <p class="warning">{blockingCount} host issue(s) need repair before connection.</p>
    {/if}
    <OverlayScrollbarsComponent
      element="div"
      class="host-list-scroll"
      options={{
        overflow: {
          x: "hidden",
          y: "scroll",
        },
        scrollbars: {
          autoHide: "leave",
          autoHideDelay: 420,
          theme: "os-theme-nocturne",
        },
      }}
      defer
    >
      {#if snapshotQuery.isPending}
        <p class="empty">Loading</p>
      {:else if snapshotQuery.error}
        <p class="error">{snapshotQuery.error.message}</p>
      {:else}
        <div class="rows">
          {#each hostTree.hosts as host}
            <button
              class:active={host.id === selectedId}
              class:error-row={hostHasBlockingDiagnostics(host)}
              class:readonly-row={host.read_only}
              type="button"
              onclick={() => selectHost(host)}
            >
              <span class="host-row-main">
                <HostIcon icon={resolveHostIcon(host)} />
                <span>
                  <strong>{host.document.name}</strong>
                  <small>{hostSubtitle(host)}</small>
                </span>
              </span>
              <em>{host.id === defaultHostId ? "DEFAULT" : host.document.protocol.toUpperCase()}</em>
            </button>
          {/each}
          {#each hostTree.children as node}
            {@render folderNode(node, 0)}
          {/each}
        </div>
      {/if}
    </OverlayScrollbarsComponent>
  </aside>

  <section class="detail" aria-label="Host detail">
    <OverlayScrollbarsComponent
      element="div"
      class="detail-scroll"
      options={{
        overflow: {
          x: "hidden",
          y: "scroll",
        },
        scrollbars: {
          autoHide: "leave",
          autoHideDelay: 420,
          theme: "os-theme-nocturne",
        },
      }}
      defer
    >
      <div class="detail-content">
      {#if errorMessage}
        <p class="error">{errorMessage}</p>
      {/if}

      {#if draft}
        <header class="detail-header">
          <div>
            <div class="detail-title">
              {#if draftIcon}
                <div class="detail-icon-control">
                  <button
                    class="detail-icon-button"
                    class:editable={iconEditable}
                    class:open={iconPickerOpen}
                    type="button"
                    disabled={!iconEditable}
                    aria-expanded={iconPickerOpen}
                    aria-label={iconEditable ? "Change host icon" : "Host icon"}
                    title={iconEditable ? "Change host icon" : "Host icon"}
                    onclick={toggleIconPicker}
                  >
                    <HostIcon icon={draftIcon} size="large" />
                  </button>
                  {#if iconPickerOpen}
                    <div class="detail-icon-popover">
                      <HostIconPicker
                        value={draft.icon}
                        fallbackIcon={draftIcon}
                        mode={iconPickerMode}
                        disabled={!iconEditable}
                        onChange={updateDraftIcon}
                        onClose={() => (iconPickerOpen = false)}
                        onOpenFull={() => (iconPickerMode = "full")}
                      />
                    </div>
                  {/if}
                </div>
              {/if}
              <div>
                <h2>{draft.name || "Host"}</h2>
                <p>{selectedHost ? hostSourceLabel(selectedHost) : "New Nocturne host"}</p>
              </div>
            </div>
          </div>
          <div class="actions">
            {#if selectedHost?.source === "open_ssh_config"}
              <button type="button" onclick={() => copyOpenSshHost(selectedHost)}>Copy</button>
            {/if}
            {#if selectedHost?.source === "user" && hostHasBlockingDiagnostics(selectedHost)}
              <button type="button" onclick={repairId}>Repair ID</button>
            {/if}
            {#if selectedHost?.source === "user" || selectedHost?.source === "virtual"}
              <button class="danger" type="button" onclick={deleteHost}>Delete</button>
            {/if}
            <button type="button" disabled={!canSave} onclick={saveHost}>Save</button>
          </div>
        </header>

        {#if selectedHost?.source === "open_ssh_config"}
          <p class="notice">OpenSSH config is read-only because it is shared with SSH, Git, rsync, and shell scripts. Copy it to a Nocturne host to edit safely.</p>
        {/if}

        {#if selectedHost?.diagnostics.length}
          <div class="diagnostics">
            {#each selectedHost.diagnostics as diagnostic}
              <p class:error={diagnostic.severity === "error"}>{diagnostic.message}</p>
            {/each}
          </div>
        {/if}

        <div class="form">
          <label>
            <span>Name</span>
            <input bind:value={draft.name} disabled={selectedHost?.read_only} />
          </label>
          <label>
            <span>Folder</span>
            <div class="folder-field">
              <input
                value={draft.folder ?? ""}
                disabled={selectedHost?.read_only}
                onfocus={() => (folderPickerOpen = true)}
                oninput={(event) => updateDraftFolder(event.currentTarget.value)}
              />
              <button type="button" disabled={selectedHost?.read_only} aria-label="Choose folder" title="Choose folder" onclick={() => (folderPickerOpen = !folderPickerOpen)}>▾</button>
              {#if folderPickerOpen && !selectedHost?.read_only}
                <div class="folder-popover">
                  <button type="button" onclick={() => chooseFolder("")}>
                    <span>Hosts</span>
                    <small>Top level</small>
                  </button>
                  {#each folderSuggestions as folder}
                    <button type="button" onclick={() => chooseFolder(folder)}>
                      <span>{folder}</span>
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          </label>
          <label>
            <span>Type</span>
            <select value={draft.protocol} disabled={selectedHost?.read_only} onchange={(event) => updateProtocol(event.currentTarget.value as ConnectionProtocol)}>
              <option value="local">Local</option>
              <option value="ssh">SSH</option>
              <option value="telnet">Telnet</option>
            </select>
          </label>
          {#if selectedHost && selectedHost.source !== "open_ssh_config"}
            <label class="check">
              <span>Default</span>
              <input type="checkbox" checked={selectedHost.id === visibleDefaultHostId} disabled={hostHasBlockingDiagnostics(selectedHost)} onchange={(event) => updateDefaultHost(event.currentTarget.checked)} />
            </label>
          {/if}
          {#if !selectedHost || selectedHost.source === "user"}
            <label>
              <span>Storage Directory</span>
              <select bind:value={selectedDirectory} disabled={!!selectedHost?.id}>
                {#each hostDirs as dir}
                  <option value={dir}>{dir}</option>
                {/each}
              </select>
              <small>Where Nocturne saves the host TOML file. It is only selectable for new Nocturne hosts.</small>
            </label>
          {/if}
          {#if draft.protocol === "local" && draft.local}
            <label>
              <span>Command</span>
              <input value={draft.local.command ?? ""} disabled={selectedHost?.read_only} oninput={(event) => (draft!.local!.command = event.currentTarget.value)} />
            </label>
            <label>
              <span>Arguments</span>
              <textarea rows="4" disabled={selectedHost?.read_only} oninput={(event) => updateLocalArgs(event.currentTarget.value)}>{localArgsText(draft)}</textarea>
              <small>One argument per line. Leave blank when using the system shell.</small>
            </label>
            <label>
              <span>Working Directory</span>
              <input value={draft.local.cwd ?? ""} disabled={selectedHost?.read_only} oninput={(event) => (draft!.local!.cwd = event.currentTarget.value)} />
            </label>
          {:else if draft.protocol === "ssh" && draft.ssh}
            <label>
              <span>Hostname</span>
              <input bind:value={draft.ssh.hostname} disabled={selectedHost?.read_only} />
            </label>
            <label>
              <span>Port</span>
              <input type="number" min="1" max="65535" bind:value={draft.ssh.port} disabled={selectedHost?.read_only} />
            </label>
            <label>
              <span>Username</span>
              <input value={draft.ssh.username ?? ""} disabled={selectedHost?.read_only} oninput={(event) => (draft!.ssh!.username = event.currentTarget.value)} />
            </label>
            <label>
              <span>Identity File</span>
              <input value={draft.ssh.identity_file ?? ""} disabled={selectedHost?.read_only} oninput={(event) => (draft!.ssh!.identity_file = event.currentTarget.value)} />
            </label>
            <label>
              <span>ProxyJump</span>
              <input value={draft.ssh.proxy_jump ?? ""} disabled={selectedHost?.read_only} oninput={(event) => (draft!.ssh!.proxy_jump = event.currentTarget.value)} />
            </label>
            <label class="check">
              <span class="label-with-help">
                Forward Agent
                <span
                  class="help-tip"
                  role="img"
                  aria-label="Forward Agent lets this SSH connection use your local SSH agent to authenticate onward SSH connections from the remote host. Enable it only for trusted hosts."
                  title="Lets this SSH connection use your local SSH agent for onward SSH connections from the remote host. Enable only for trusted hosts."
                >
                  <CircleHelp aria-hidden="true" />
                  <span class="help-bubble" role="tooltip">Lets this SSH connection use your local SSH agent for onward SSH connections from the remote host. Enable only for trusted hosts.</span>
                </span>
              </span>
              <input type="checkbox" bind:checked={draft.ssh.forward_agent} disabled={selectedHost?.read_only} />
            </label>
          {/if}
        </div>

        <footer>
          <span>{hostAddress({ id: draft.id, path: null, source: "user", read_only: false, document: draft, diagnostics: [] })}</span>
        </footer>
      {:else}
        <p class="empty">Create or select a host.</p>
      {/if}
      </div>
    </OverlayScrollbarsComponent>
  </section>
</main>

{#snippet folderNode(node: HostFolderTreeNode, depth: number)}
  <button class="tree-folder" style={`--folder-depth: ${depth}`} type="button" aria-expanded={folderExpanded(node.path)} onclick={() => toggleFolder(node.path)}>
    <em>{folderExpanded(node.path) ? "▾" : "▸"}</em>
    <span>{node.name}</span>
  </button>
  {#if folderExpanded(node.path)}
    {#each node.hosts as host}
      <button
        style={`--folder-depth: ${depth + 1}`}
        class:active={host.id === selectedId}
        class:error-row={hostHasBlockingDiagnostics(host)}
        class:readonly-row={host.read_only}
        type="button"
        onclick={() => selectHost(host)}
      >
        <span class="host-row-main">
          <HostIcon icon={resolveHostIcon(host)} />
          <span>
            <strong>{host.document.name}</strong>
            <small>{hostSubtitle(host)}</small>
          </span>
        </span>
        <em>{host.id === defaultHostId ? "DEFAULT" : host.document.protocol.toUpperCase()}</em>
      </button>
    {/each}
    {#each node.children as child}
      {@render folderNode(child, depth + 1)}
    {/each}
  {/if}
{/snippet}

<style>
  :global(:root) {
    color-scheme: light dark;
    --hosts-bg: #f5f5f5;
    --hosts-fg: #1f2023;
    --hosts-muted: #6b6d72;
    --hosts-border: #d8d9dd;
    --hosts-control: #ffffff;
    --hosts-active: #dce8fb;
    --hosts-danger: #a92727;
    overflow: hidden;
  }

  :global(:root[data-theme="dark"]) {
    --hosts-bg: #202124;
    --hosts-fg: #ededee;
    --hosts-muted: #a6a8ad;
    --hosts-border: #3b3d42;
    --hosts-control: #2b2d31;
    --hosts-active: #34445f;
    --hosts-danger: #ffb5b5;
  }

  :global(body) {
    margin: 0;
    background: var(--hosts-bg);
    color: var(--hosts-fg);
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    overflow: hidden;
  }

  :global(*) {
    box-sizing: border-box;
  }

  .host-shell {
    width: 100vw;
    height: 100vh;
    display: grid;
    grid-template-columns: 310px minmax(0, 1fr);
  }

  .host-list {
    min-width: 0;
    min-height: 0;
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    border-right: 1px solid var(--hosts-border);
    background: color-mix(in srgb, var(--hosts-bg) 86%, var(--hosts-control));
    user-select: none;
    -webkit-user-select: none;
    overflow: hidden;
  }

  .host-list header,
  .detail-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 18px;
    border-bottom: 1px solid var(--hosts-border);
  }

  h1,
  h2,
  p {
    margin: 0;
  }

  h1 {
    font-size: 20px;
  }

  h2 {
    font-size: 18px;
  }

  .rows {
    display: grid;
    padding: 8px;
  }

  .rows button {
    min-width: 0;
    min-height: 48px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    border: 0;
    border-radius: 6px;
    padding: 7px 9px 7px calc(9px + var(--folder-depth, 0) * 12px);
    color: inherit;
    background: transparent;
    font: inherit;
    text-align: left;
  }

  .rows button.tree-folder {
    min-height: 30px;
    grid-template-columns: 14px minmax(0, 1fr);
    gap: 5px;
    padding: 4px 9px 4px calc(9px + var(--folder-depth, 0) * 14px);
    color: var(--hosts-muted);
    font-size: 12px;
    font-weight: 600;
  }

  .host-row-main {
    min-width: 0;
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr);
    gap: 8px;
    align-items: center;
  }

  .tree-folder em {
    color: var(--hosts-muted);
    font-size: 11px;
    font-style: normal;
  }

  .rows button.active {
    background: var(--hosts-active);
  }

  .rows button:not(.active):hover {
    background: color-mix(in srgb, var(--hosts-control) 82%, var(--hosts-bg));
  }

  .rows button.readonly-row {
    color: color-mix(in srgb, var(--hosts-fg) 58%, transparent);
  }

  .rows button.readonly-row em {
    color: color-mix(in srgb, var(--hosts-muted) 62%, transparent);
  }

  .rows span,
  .rows strong,
  .rows small {
    min-width: 0;
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rows .host-row-main {
    min-width: 0;
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr);
    gap: 8px;
    align-items: center;
  }

  .rows small,
  .detail-header p,
  footer,
  .notice {
    color: var(--hosts-muted);
    font-size: 12px;
  }

  .rows em {
    color: var(--hosts-muted);
    font-size: 11px;
    font-style: normal;
  }

  .error-row strong,
  .error {
    color: var(--hosts-danger);
  }

  .detail {
    min-width: 0;
    min-height: 0;
    height: 100%;
    overflow-x: hidden;
  }

  .detail :global(.detail-scroll) {
    height: 100%;
  }

  .host-list :global(.host-list-scroll) {
    min-height: 0;
    height: 100%;
  }

  .detail-content {
    min-width: 0;
    overflow-x: hidden;
  }

  .detail-header > div:first-child {
    min-width: 0;
  }

  .detail-title {
    min-width: 0;
    display: grid;
    grid-template-columns: 40px minmax(0, 1fr);
    gap: 10px;
    align-items: center;
  }

  .detail-icon-control {
    position: relative;
    width: 40px;
    height: 40px;
    z-index: 20;
  }

  .detail-icon-button {
    position: relative;
    width: 40px;
    height: 40px;
    min-height: 40px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 10px;
    padding: 0;
    background: transparent;
    color: inherit;
  }

  .detail-icon-button.editable:hover,
  .detail-icon-button.editable:focus-visible,
  .detail-icon-button.editable.open {
    background: color-mix(in srgb, var(--hosts-active) 72%, transparent);
    outline: none;
  }

  .detail-icon-button.editable::after {
    content: "";
    position: absolute;
    right: 3px;
    bottom: 3px;
    width: 9px;
    height: 9px;
    border: 1.5px solid var(--hosts-bg);
    border-radius: 999px;
    background: var(--hosts-fg);
    opacity: 0;
    transform: scale(0.78);
    transition:
      opacity 0.12s ease-out,
      transform 0.12s ease-out;
  }

  .detail-icon-button.editable:hover::after,
  .detail-icon-button.editable:focus-visible::after {
    opacity: 1;
    transform: scale(1);
  }

  .detail-icon-popover {
    position: absolute;
    z-index: 50;
    top: calc(100% + 8px);
    left: 0;
  }

  .detail-header h2,
  .detail-header p {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .actions {
    min-width: 0;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  button {
    min-height: 28px;
    border: 1px solid var(--hosts-border);
    border-radius: 6px;
    padding: 4px 10px;
    color: inherit;
    background: var(--hosts-control);
    font: inherit;
  }

  button:disabled {
    opacity: 0.5;
  }

  button:active:not(:disabled) {
    background: color-mix(in srgb, var(--hosts-active) 55%, var(--hosts-control));
  }

  button.danger {
    color: var(--hosts-danger);
  }

  .new-buttons {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .notice,
  .diagnostics,
  .error,
  .warning {
    margin: 12px 18px;
    overflow-wrap: anywhere;
  }

  .warning {
    color: var(--hosts-danger);
    font-size: 12px;
  }

  .diagnostics {
    border: 1px solid var(--hosts-border);
    border-radius: 6px;
    padding: 8px 10px;
    background: color-mix(in srgb, var(--hosts-control) 70%, var(--hosts-bg));
  }

  .form {
    width: min(760px, 100%);
    max-width: 100%;
    display: grid;
    gap: 14px;
    padding: 18px;
    overflow-x: hidden;
  }

  label {
    min-width: 0;
    display: grid;
    grid-template-columns: 140px minmax(0, 1fr);
    align-items: center;
    gap: 12px;
  }

  label span {
    min-width: 0;
    color: var(--hosts-muted);
    font-size: 13px;
  }

  .label-with-help {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  .help-tip {
    position: relative;
    display: inline-flex;
    width: 16px;
    height: 16px;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    color: color-mix(in srgb, var(--hosts-muted) 86%, transparent);
    outline: none;
  }

  .help-tip :global(svg) {
    width: 14px;
    height: 14px;
  }

  .help-tip:hover {
    color: var(--hosts-fg);
  }

  .help-bubble {
    position: absolute;
    left: 50%;
    bottom: calc(100% + 8px);
    z-index: 20;
    width: min(280px, calc(100vw - 32px));
    padding: 8px 10px;
    border: 1px solid var(--hosts-border);
    border-radius: 7px;
    background: color-mix(in srgb, var(--hosts-control) 96%, var(--hosts-bg));
    box-shadow: 0 10px 28px color-mix(in srgb, #000 20%, transparent);
    color: var(--hosts-fg);
    font-size: 12px;
    font-weight: 400;
    line-height: 1.35;
    opacity: 0;
    pointer-events: none;
    transform: translate(-50%, 4px);
    transition: opacity 120ms ease, transform 120ms ease;
  }

  .help-tip:hover .help-bubble {
    opacity: 1;
    transform: translate(-50%, 0);
  }

  label small {
    grid-column: 2;
    margin-top: -8px;
    color: color-mix(in srgb, var(--hosts-muted) 88%, transparent);
    font-size: 11px;
    line-height: 1.3;
  }

  input,
  select,
  textarea {
    min-width: 0;
    width: 100%;
    max-width: 100%;
    border: 1px solid var(--hosts-border);
    border-radius: 6px;
    padding: 6px 8px;
    background: var(--hosts-control);
    color: var(--hosts-fg);
    font: inherit;
  }

  input:disabled,
  select:disabled,
  textarea:disabled {
    color: color-mix(in srgb, var(--hosts-fg) 48%, transparent);
    background: color-mix(in srgb, var(--hosts-control) 54%, var(--hosts-bg));
    border-color: color-mix(in srgb, var(--hosts-border) 68%, transparent);
  }

  textarea {
    resize: vertical;
  }

  .folder-field {
    position: relative;
    min-width: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 30px;
  }

  .folder-field input {
    border-radius: 6px 0 0 6px;
  }

  .folder-field > button {
    min-height: 32px;
    border-left: 0;
    border-radius: 0 6px 6px 0;
    padding: 0;
  }

  .folder-popover {
    position: absolute;
    top: calc(100% + 5px);
    left: 0;
    right: 0;
    z-index: 5;
    display: grid;
    gap: 2px;
    max-height: 220px;
    overflow: auto;
    padding: 5px;
    border: 1px solid var(--hosts-border);
    border-radius: 7px;
    background: color-mix(in srgb, var(--hosts-control) 96%, transparent);
    box-shadow: 0 14px 32px color-mix(in srgb, #000 22%, transparent);
  }

  .folder-popover button {
    min-width: 0;
    display: grid;
    gap: 1px;
    border: 0;
    background: transparent;
    text-align: left;
  }

  .folder-popover button:hover {
    background: color-mix(in srgb, var(--hosts-active) 70%, transparent);
  }

  .folder-popover span,
  .folder-popover small {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .check input {
    width: auto;
    justify-self: start;
  }

  footer {
    padding: 0 18px 18px;
    overflow-wrap: anywhere;
  }

  :global(.os-theme-nocturne.os-scrollbar) {
    --os-size: 7px;
    --os-padding-perpendicular: 2px;
    --os-padding-axis: 4px;
    --os-handle-border-radius: 999px;
    --os-handle-bg: color-mix(in srgb, var(--hosts-fg) 26%, transparent);
    --os-handle-bg-hover: color-mix(in srgb, var(--hosts-fg) 34%, transparent);
    --os-handle-bg-active: color-mix(in srgb, var(--hosts-fg) 42%, transparent);
  }

  .empty {
    padding: 18px;
    color: var(--hosts-muted);
  }

  @media (max-width: 720px) {
    .host-shell {
      grid-template-columns: 1fr;
      grid-template-rows: 42vh minmax(0, 1fr);
    }

    .host-list {
      border-right: 0;
      border-bottom: 1px solid var(--hosts-border);
      overflow: auto;
    }

    label {
      grid-template-columns: 1fr;
      gap: 5px;
    }

    label small {
      grid-column: 1;
      margin-top: 0;
    }
  }
</style>
