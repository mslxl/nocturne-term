<script lang="ts">
  import type { ConnectionHostIcon, WorkspaceTabState } from "$lib/bindings";
  import HostIcon from "$lib/hosts/HostIcon.svelte";
  import { mountDecorumTitlebarHost } from "$lib/window/decorum-titlebar";
  import ChevronDownIcon from "~icons/lucide/chevron-down";
  import PlusIcon from "~icons/lucide/plus";

  type AppMenuRootItem = {
    id: "file" | "edit" | "view" | "window";
    label: string;
  };

  type Props = {
    workspaces: WorkspaceTabState[];
    activeWorkspaceId: string;
    integratedTitlebar?: boolean;
    integratedTitlebarChrome?: "macos" | "decorum" | null;
    integratedTitlebarSingleRow?: boolean;
    titlebarLayout?: "single-row" | "two-row";
    appMenuRoots?: AppMenuRootItem[];
    showHostIcons?: boolean;
    hostIconById?: Map<string, ConnectionHostIcon>;
    dropPreviewWorkspaceId?: string | null;
    activateWorkspace: (id: string) => void | Promise<void>;
    closeWorkspace: (id: string) => void | Promise<void>;
    closeOtherWorkspaces: (id: string) => void | Promise<void>;
    closeWorkspacesToRight: (id: string) => void | Promise<void>;
    newWorkspace: () => void | Promise<void>;
    openAppMenu?: (root: AppMenuRootItem["id"], event: MouseEvent) => void | Promise<void>;
    openHostPicker: (event: MouseEvent) => void | Promise<void>;
    handleNewWorkspaceSecondaryClick: (event: MouseEvent) => void | Promise<void>;
  };

  let {
    workspaces,
    activeWorkspaceId,
    integratedTitlebar = false,
    integratedTitlebarChrome = null,
    integratedTitlebarSingleRow = false,
    titlebarLayout = "two-row",
    appMenuRoots = [],
    showHostIcons = false,
    hostIconById = new Map(),
    dropPreviewWorkspaceId = null,
    activateWorkspace,
    closeWorkspace,
    closeOtherWorkspaces,
    closeWorkspacesToRight,
    newWorkspace,
    openAppMenu,
    openHostPicker,
    handleNewWorkspaceSecondaryClick,
  }: Props = $props();
  let contextMenu = $state<{ id: string; left: number; top: number } | null>(null);
  let effectiveTitlebarLayout = $derived(integratedTitlebarSingleRow ? "single-row" : titlebarLayout);

  function hostIcon(hostId: string): ConnectionHostIcon | null {
    if (!showHostIcons) return null;
    return hostIconById.get(hostId) ?? null;
  }

  function activate(event: MouseEvent, id: string) {
    event.preventDefault();
    event.stopPropagation();
    void activateWorkspace(id);
  }

  function close(event: MouseEvent, id: string) {
    event.preventDefault();
    event.stopPropagation();
    void closeWorkspace(id);
  }

  function handleWorkspaceContextMenu(event: MouseEvent, id: string) {
    event.preventDefault();
    event.stopPropagation();
    contextMenu = { id, left: event.clientX, top: event.clientY };
  }

  function runContextAction(action: "close-others" | "close-right") {
    const menu = contextMenu;
    contextMenu = null;
    if (!menu) return;
    if (action === "close-others") void closeOtherWorkspaces(menu.id);
    if (action === "close-right") void closeWorkspacesToRight(menu.id);
  }
</script>

<nav
  class:integrated-titlebar={integratedTitlebar}
  class:integrated-titlebar-macos={integratedTitlebarChrome === "macos"}
  class:integrated-titlebar-decorum={integratedTitlebarChrome === "decorum"}
  class:titlebar-single-row={effectiveTitlebarLayout === "single-row"}
  class:titlebar-two-row={effectiveTitlebarLayout === "two-row"}
  class="workspace-tabbar"
  aria-label="Workspaces"
>
  {#if effectiveTitlebarLayout === "two-row"}
    <div class="workspace-titlebar-menu-row">
      {#if integratedTitlebarChrome === "decorum" && appMenuRoots.length > 0}
        <div class="workspace-app-menu" role="menubar" aria-label="Application menu">
          {#each appMenuRoots as root (root.id)}
            <button
              class="workspace-app-menu-root"
              data-app-menu-root={root.id}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              onclick={(event) => openAppMenu?.(root.id, event)}
            >
              {root.label}
            </button>
          {/each}
        </div>
      {/if}
      <div
        class="workspace-titlebar-drag-zone"
        aria-hidden="true"
        data-tauri-drag-region={integratedTitlebar ? true : undefined}
      ></div>
      {#if integratedTitlebarChrome === "decorum"}
        <div class="workspace-decorum-slot" aria-hidden="true" use:mountDecorumTitlebarHost></div>
      {/if}
    </div>
  {/if}
  <div class="workspace-titlebar-tab-row">
    {#if effectiveTitlebarLayout === "single-row" && integratedTitlebarChrome === "decorum" && appMenuRoots.length > 0}
      <div class="workspace-app-menu" role="menubar" aria-label="Application menu">
        {#each appMenuRoots as root (root.id)}
          <button
            class="workspace-app-menu-root"
            data-app-menu-root={root.id}
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            onclick={(event) => openAppMenu?.(root.id, event)}
          >
            {root.label}
          </button>
        {/each}
      </div>
    {/if}
    <div class="workspace-tabs">
      {#each workspaces as workspace (workspace.id)}
        {@const icon = hostIcon(workspace.host_id)}
        <div
          class:active={workspace.id === activeWorkspaceId}
          class="workspace-tab"
          data-workspace-id={workspace.id}
          data-testid={`workspace-tab-${workspace.id}`}
          role="group"
          oncontextmenu={(event) => handleWorkspaceContextMenu(event, workspace.id)}
        >
          <button
            class:drop-preview={workspace.id === dropPreviewWorkspaceId}
            class="workspace-activate"
            data-workspace-drop-preview={workspace.id === dropPreviewWorkspaceId ? "true" : undefined}
            type="button"
            onclick={(event) => activate(event, workspace.id)}
          >
            {#if icon}
              <HostIcon icon={icon} size="small" title={workspace.title} />
            {/if}
            <span>{workspace.title}</span>
          </button>
          <button
            class="close-workspace"
            type="button"
            aria-label={`Close ${workspace.title}`}
            title="Close workspace"
            onclick={(event) => close(event, workspace.id)}
          >
            &times;
          </button>
        </div>
      {/each}
    </div>
    <div class="workspace-actions">
      <div class="workspace-action-split-button" role="group" aria-label="Workspace actions">
        <button
          class="new-workspace"
          data-host-picker-trigger="true"
          type="button"
          aria-label="New workspace"
          title="New workspace"
          onclick={newWorkspace}
          oncontextmenu={handleNewWorkspaceSecondaryClick}
        >
          <PlusIcon aria-hidden="true" />
        </button>
        <button
          class="host-picker"
          data-host-picker-trigger="true"
          type="button"
          aria-label="Choose host"
          title="Choose host"
          onclick={openHostPicker}
        >
          <ChevronDownIcon aria-hidden="true" />
        </button>
      </div>
    </div>
    {#if effectiveTitlebarLayout === "single-row"}
      <div
        class="workspace-titlebar-drag-zone"
        aria-hidden="true"
        data-tauri-drag-region={integratedTitlebar ? true : undefined}
      ></div>
      {#if integratedTitlebarChrome === "decorum"}
        <div class="workspace-decorum-slot" aria-hidden="true" use:mountDecorumTitlebarHost></div>
      {/if}
    {/if}
  </div>
  {#if contextMenu}
    <div
      class="workspace-context-menu"
      style={`left: ${contextMenu.left}px; top: ${contextMenu.top}px;`}
      role="menu"
      tabindex="-1"
      onpointerleave={() => (contextMenu = null)}
    >
      <button type="button" role="menuitem" onclick={() => runContextAction("close-others")}>Close Others</button>
      <button type="button" role="menuitem" onclick={() => runContextAction("close-right")}>Close to the Right</button>
    </div>
  {/if}
</nav>

<style>
  .workspace-tabbar {
    min-width: 0;
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    border-bottom: 1px solid var(--app-border);
    background: color-mix(in srgb, var(--app-bg) 90%, var(--app-control));
    user-select: none;
    -webkit-user-select: none;
  }

  .workspace-tabbar.integrated-titlebar {
    padding: 0;
  }

  .workspace-tabbar.integrated-titlebar-macos {
    padding-left: 84px;
  }

  .workspace-tabbar.titlebar-single-row {
    flex-direction: row;
    column-gap: 6px;
    padding-block: 5px;
    padding-left: 8px;
  }

  .workspace-tabbar.titlebar-single-row.integrated-titlebar-decorum {
    padding-right: 0;
  }

  .workspace-tabbar.titlebar-two-row {
    flex-direction: column;
    row-gap: 0;
  }

  .workspace-titlebar-menu-row,
  .workspace-titlebar-tab-row {
    min-width: 0;
    display: flex;
    align-items: stretch;
  }

  .workspace-titlebar-menu-row {
    position: relative;
    z-index: 5;
    min-height: 32px;
    padding-left: 8px;
    border-bottom: 1px solid color-mix(in srgb, var(--app-border) 70%, transparent);
  }

  .workspace-titlebar-tab-row {
    position: relative;
    z-index: 5;
    min-height: 40px;
    padding: 5px 8px;
  }

  .workspace-tabbar.titlebar-single-row .workspace-titlebar-tab-row {
    flex: 1 1 auto;
    min-height: 30px;
    padding: 0;
  }

  .workspace-tabs {
    min-width: 0;
    position: relative;
    z-index: 6;
    flex: 0 1 auto;
    display: flex;
    overflow: auto;
    scrollbar-width: none;
  }

  .workspace-app-menu {
    position: relative;
    z-index: 6;
    flex: none;
    display: flex;
    align-items: center;
    gap: 2px;
    align-self: stretch;
    padding-right: 8px;
  }

  .workspace-app-menu-root {
    height: 30px;
    min-width: 0;
    display: grid;
    place-items: center;
    border-radius: 5px;
    padding: 0 8px;
    color: color-mix(in srgb, var(--app-fg) 78%, transparent);
    font-size: 12px;
    line-height: 1;
  }

  .titlebar-single-row .workspace-app-menu {
    margin-right: 2px;
    padding-right: 10px;
    border-right: 1px solid color-mix(in srgb, var(--app-border) 72%, transparent);
  }

  .integrated-titlebar .workspace-app-menu-root {
    height: 26px;
  }

  .titlebar-two-row .workspace-app-menu-root {
    height: 28px;
  }

  .workspace-app-menu-root:hover,
  .workspace-app-menu-root:focus-visible {
    background: color-mix(in srgb, var(--app-fg) 9%, transparent);
    color: var(--app-fg);
  }

  .integrated-titlebar .workspace-tabs {
    gap: 6px;
    padding-left: 2px;
  }

  .workspace-tabs::-webkit-scrollbar {
    display: none;
  }

  button {
    appearance: none;
    border: 0;
    color: inherit;
    background: transparent;
    font: inherit;
  }

  .workspace-tab {
    min-width: 148px;
    max-width: 260px;
    height: 39px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 28px;
    align-items: stretch;
    border-right: 1px solid var(--app-border);
  }

  .integrated-titlebar .workspace-tab {
    height: 30px;
    min-width: 142px;
    border: 1px solid color-mix(in srgb, var(--app-border) 80%, transparent);
    border-radius: 6px;
    overflow: hidden;
  }

  .workspace-tab.active {
    background: var(--app-control);
  }

  .workspace-tab:has(.workspace-activate.drop-preview) {
    background: color-mix(in srgb, var(--app-accent) 9%, var(--app-control));
  }

  .workspace-activate {
    min-width: 0;
    height: 39px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 4px 6px 4px 12px;
    text-align: left;
  }

  .integrated-titlebar .workspace-activate {
    height: 28px;
    padding-block: 2px;
  }

  .workspace-activate.drop-preview {
    background: color-mix(in srgb, var(--app-accent) 16%, transparent);
    box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--app-accent) 78%, transparent);
  }

  .workspace-activate span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    line-height: 1.1;
  }

  .close-workspace {
    width: 28px;
    height: 39px;
    display: grid;
    place-items: center;
    color: color-mix(in srgb, var(--app-fg) 58%, transparent);
    font-size: 16px;
    line-height: 1;
  }

  .integrated-titlebar .close-workspace {
    height: 28px;
  }

  .close-workspace:hover {
    color: var(--app-fg);
  }

  .workspace-actions {
    position: relative;
    z-index: 1;
    flex: none;
    display: flex;
    align-items: stretch;
    margin-left: 6px;
  }

  .integrated-titlebar .workspace-actions {
    gap: 6px;
  }

  .workspace-action-split-button {
    display: flex;
    align-items: stretch;
  }

  .integrated-titlebar .workspace-action-split-button {
    height: 30px;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--app-border) 78%, transparent);
    border-radius: 5px;
    background: transparent;
  }

  .workspace-titlebar-drag-zone {
    flex: 1 1 24px;
    min-width: 24px;
  }

  .workspace-decorum-slot {
    flex: none;
    position: relative;
    z-index: 0;
    width: 138px;
    height: 100%;
    display: grid;
    align-items: stretch;
    justify-content: end;
    pointer-events: none;
  }

  .workspace-actions button {
    height: 39px;
    min-width: 34px;
    display: grid;
    place-items: center;
    gap: 1px;
    border-left: 1px solid var(--app-border);
  }

  .workspace-actions .new-workspace {
    width: 74px;
  }

  .integrated-titlebar .workspace-actions button {
    height: 28px;
    border: 0;
  }

  .integrated-titlebar .workspace-actions .new-workspace {
    width: 34px;
  }

  .integrated-titlebar .workspace-actions .host-picker {
    width: 30px;
    min-width: 30px;
    border-left: 1px solid color-mix(in srgb, var(--app-border) 82%, transparent);
  }

  .integrated-titlebar .workspace-actions button:hover {
    background: color-mix(in srgb, var(--app-fg) 9%, transparent);
  }

  .workspace-actions :global(svg) {
    width: 14px;
    height: 14px;
    display: block;
    color: color-mix(in srgb, var(--app-fg) 86%, transparent);
    stroke-width: 1.8;
  }

  .close-workspace:active,
  .workspace-activate:active,
  .workspace-actions button:active {
    background: var(--app-active);
  }

  .workspace-context-menu {
    position: fixed;
    z-index: 80;
    min-width: 168px;
    border: 1px solid var(--app-border);
    border-radius: 6px;
    padding: 4px;
    background: color-mix(in srgb, var(--app-bg) 94%, var(--app-control));
    box-shadow: 0 14px 36px color-mix(in srgb, black 24%, transparent);
  }

  .workspace-context-menu button {
    width: 100%;
    display: block;
    border-radius: 4px;
    padding: 6px 8px;
    text-align: left;
    color: var(--app-fg);
    font-size: 12px;
  }

  .workspace-context-menu button:hover {
    background: var(--app-hover);
  }

  @media (max-width: 720px) {
    .workspace-tab {
      min-width: 120px;
    }

    .workspace-actions .new-workspace {
      width: 48px;
    }

    .integrated-titlebar .workspace-actions .new-workspace {
      width: 34px;
    }

  }
</style>
