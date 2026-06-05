<script lang="ts">
  import type { ConnectionHostIcon, WorkspaceTabState } from "$lib/bindings";
  import HostIcon from "$lib/hosts/HostIcon.svelte";

  type Props = {
    workspaces: WorkspaceTabState[];
    activeWorkspaceId: string;
    integratedTitlebar?: boolean;
    showHostIcons?: boolean;
    hostIconById?: Map<string, ConnectionHostIcon>;
    dropPreviewWorkspaceId?: string | null;
    activateWorkspace: (id: string) => void | Promise<void>;
    closeWorkspace: (id: string) => void | Promise<void>;
    closeOtherWorkspaces: (id: string) => void | Promise<void>;
    closeWorkspacesToRight: (id: string) => void | Promise<void>;
    newWorkspace: () => void | Promise<void>;
    openHostPicker: (event: MouseEvent) => void | Promise<void>;
    handleNewWorkspaceSecondaryClick: (event: MouseEvent) => void | Promise<void>;
  };

  let {
    workspaces,
    activeWorkspaceId,
    integratedTitlebar = false,
    showHostIcons = false,
    hostIconById = new Map(),
    dropPreviewWorkspaceId = null,
    activateWorkspace,
    closeWorkspace,
    closeOtherWorkspaces,
    closeWorkspacesToRight,
    newWorkspace,
    openHostPicker,
    handleNewWorkspaceSecondaryClick,
  }: Props = $props();
  let contextMenu = $state<{ id: string; left: number; top: number } | null>(null);

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
  class="workspace-tabbar"
  aria-label="Workspaces"
  data-tauri-drag-region={integratedTitlebar ? "deep" : undefined}
>
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
    <button
      class="new-workspace"
      data-host-picker-trigger="true"
      type="button"
      aria-label="New workspace"
      title="New workspace"
      onclick={newWorkspace}
      oncontextmenu={handleNewWorkspaceSecondaryClick}
    >
      <span>+</span>
      <small>Workspace</small>
    </button>
    <button
      class="host-picker"
      data-host-picker-trigger="true"
      type="button"
      aria-label="Choose host"
      title="Choose host"
      onclick={openHostPicker}
    >
      <span>⌄</span>
    </button>
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
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: stretch;
    border-bottom: 1px solid var(--app-border);
    background: color-mix(in srgb, var(--app-bg) 90%, var(--app-control));
    user-select: none;
    -webkit-user-select: none;
  }

  .workspace-tabbar.integrated-titlebar {
    column-gap: 6px;
    padding: 5px 8px 5px 84px;
  }

  .workspace-tabs {
    min-width: 0;
    display: flex;
    overflow: auto;
    scrollbar-width: none;
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
    margin-right: 6px;
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
    display: flex;
  }

  .workspace-actions button {
    height: 39px;
    min-width: 34px;
    display: grid;
    align-content: center;
    justify-items: center;
    gap: 1px;
    border-left: 1px solid var(--app-border);
  }

  .workspace-actions .new-workspace {
    width: 74px;
  }

  .integrated-titlebar .workspace-actions button {
    height: 30px;
    border: 1px solid color-mix(in srgb, var(--app-border) 80%, transparent);
    border-radius: 6px;
    margin-left: 6px;
  }

  .workspace-actions span {
    font-size: 15px;
    line-height: 1;
  }

  .workspace-actions small {
    color: color-mix(in srgb, var(--app-fg) 62%, transparent);
    font-size: 9px;
    line-height: 1;
  }

  .integrated-titlebar .workspace-actions small {
    display: none;
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

    .workspace-actions small {
      display: none;
    }
  }
</style>
