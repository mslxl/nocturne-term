import { listen } from "@tauri-apps/api/event";
import { commands, type WorkspaceChangedEvent, type WorkspaceDispatchInput, type WorkspaceLayoutSnapshot } from "$lib/bindings";
import { unwrapCommand } from "$lib/terminal/commands";
import { hasTauriRuntime } from "$lib/tauri/runtime";

export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;

export function createWorkspaceStore() {
  const state = $state<{
    error: string;
    loading: boolean;
    snapshot: WorkspaceLayoutSnapshot | null;
  }>({
    error: "",
    loading: false,
    snapshot: null,
  });
  let unlisten: (() => void) | null = null;

  async function load() {
    if (!hasTauriRuntime()) {
      state.snapshot = demoWorkspaceSnapshot();
      state.error = "";
      return;
    }
    state.loading = true;
    state.error = "";
    try {
      state.snapshot = await unwrapCommand(commands.getWorkspaceLayoutSnapshot());
    } catch (caught) {
      state.error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      state.loading = false;
    }
  }

  async function dispatch(intent: WorkspaceDispatchInput["intent"]) {
    const current = state.snapshot;
    if (!current) throw new Error("workspace snapshot is not loaded");
    if (!hasTauriRuntime()) {
      state.snapshot = applyDemoWorkspaceIntent(current, intent);
      state.error = "";
      return state.snapshot;
    }
    const next = await unwrapCommand(
      commands.workspaceDispatch({
        expected_version: current.version,
        intent,
      }),
    );
    state.snapshot = next;
    state.error = "";
    return next;
  }

  async function subscribe() {
    if (!hasTauriRuntime() || unlisten) return;
    unlisten = await listen<WorkspaceChangedEvent>("workspace://changed", (event) => {
      if (!event.payload?.snapshot) return;
      state.snapshot = event.payload.snapshot;
      state.error = "";
    });
  }

  function dispose() {
    unlisten?.();
    unlisten = null;
  }

  function replaceSnapshot(next: WorkspaceLayoutSnapshot) {
    state.snapshot = next;
    state.error = "";
  }

  return {
    get snapshot() {
      return state.snapshot;
    },
    get loading() {
      return state.loading;
    },
    get error() {
      return state.error;
    },
    load,
    dispatch,
    subscribe,
    replaceSnapshot,
    dispose,
  };
}

function demoWorkspaceSnapshot(): WorkspaceLayoutSnapshot {
  return {
    version: 0,
    active_workspace_id: "workspace-demo",
    workspaces: [
      {
        id: "workspace-demo",
        host_id: "demo-local",
        title: "Local Shell",
        owned_tool_tab_ids: ["files-demo", "terminal-demo", "transfers-demo"],
        layout: {
          kind: "split",
          direction: "row",
          ratios: [0.28, 0.72],
          children: [
            {
              kind: "group",
              id: "group-files-demo",
              role: "sidebar",
              active_slot_id: "slot-files-demo",
              slots: [{ kind: "owned", id: "slot-files-demo", tool_tab_id: "files-demo" }],
            },
            {
              kind: "split",
              direction: "column",
              ratios: [0.78, 0.22],
              children: [
                {
                  kind: "group",
                  id: "group-terminal-demo",
                  role: "content",
                  active_slot_id: "slot-terminal-demo",
                  slots: [{ kind: "owned", id: "slot-terminal-demo", tool_tab_id: "terminal-demo" }],
                },
                {
                  kind: "group",
                  id: "group-transfers-demo",
                  role: "panel",
                  active_slot_id: "slot-transfers-demo",
                  slots: [{ kind: "owned", id: "slot-transfers-demo", tool_tab_id: "transfers-demo" }],
                },
              ],
            },
          ],
        },
      },
      {
        id: "workspace-remote-demo",
        host_id: "demo-remote",
        title: "Demo Remote",
        owned_tool_tab_ids: ["files-remote-demo", "terminal-remote-demo", "transfers-remote-demo"],
        layout: {
          kind: "split",
          direction: "row",
          ratios: [0.28, 0.72],
          children: [
            {
              kind: "group",
              id: "group-files-remote-demo",
              role: "sidebar",
              active_slot_id: "slot-files-remote-demo",
              slots: [{ kind: "owned", id: "slot-files-remote-demo", tool_tab_id: "files-remote-demo" }],
            },
            {
              kind: "split",
              direction: "column",
              ratios: [0.78, 0.22],
              children: [
                {
                  kind: "group",
                  id: "group-terminal-remote-demo",
                  role: "content",
                  active_slot_id: "slot-terminal-remote-demo",
                  slots: [{ kind: "owned", id: "slot-terminal-remote-demo", tool_tab_id: "terminal-remote-demo" }],
                },
                {
                  kind: "group",
                  id: "group-transfers-remote-demo",
                  role: "panel",
                  active_slot_id: "slot-transfers-remote-demo",
                  slots: [{ kind: "owned", id: "slot-transfers-remote-demo", tool_tab_id: "transfers-remote-demo" }],
                },
              ],
            },
          ],
        },
      },
    ],
    tool_tabs: [
      {
        id: "files-demo",
        kind: "files",
        owner_workspace_id: "workspace-demo",
        host_id: "demo-local",
        title: "~",
      },
      {
        id: "terminal-demo",
        kind: "terminal",
        owner_workspace_id: "workspace-demo",
        host_id: "demo-local",
        title: "Local Shell",
      },
      {
        id: "transfers-demo",
        kind: "transfers",
        owner_workspace_id: "workspace-demo",
        host_id: "demo-local",
        title: "Transfers",
      },
      {
        id: "files-remote-demo",
        kind: "files",
        owner_workspace_id: "workspace-remote-demo",
        host_id: "demo-remote",
        title: "/srv/demo",
      },
      {
        id: "terminal-remote-demo",
        kind: "terminal",
        owner_workspace_id: "workspace-remote-demo",
        host_id: "demo-remote",
        title: "SSH Shell",
      },
      {
        id: "transfers-remote-demo",
        kind: "transfers",
        owner_workspace_id: "workspace-remote-demo",
        host_id: "demo-remote",
        title: "Transfers",
      },
    ],
    floating_windows: [],
  };
}

function applyDemoWorkspaceIntent(
  snapshot: WorkspaceLayoutSnapshot,
  intent: WorkspaceDispatchInput["intent"],
): WorkspaceLayoutSnapshot {
  const next = cloneDemoSnapshot(snapshot);
  if (intent.kind === "activate_workspace") {
    requireDemoWorkspace(next, intent.workspace_id);
    next.active_workspace_id = intent.workspace_id;
    return bumpDemoVersion(next);
  }
  if (intent.kind === "create_workspace") {
    const workspaceId = `workspace-demo-${next.version + 1}`;
    const filesToolId = `files-demo-${next.version + 1}`;
    const terminalToolId = `terminal-demo-${next.version + 1}`;
    const transfersToolId = `transfers-demo-${next.version + 1}`;
    const filesSlotId = `slot-files-demo-${next.version + 1}`;
    const terminalSlotId = `slot-terminal-demo-${next.version + 1}`;
    const transfersSlotId = `slot-transfers-demo-${next.version + 1}`;
    const hostTitle = intent.host_id === "demo-remote" ? "Demo Remote" : "Local Shell";
    const title = uniqueDemoWorkspaceTitle(next, hostTitle);
    const terminalTitle = intent.host_id === "demo-remote" ? "SSH Shell" : "Local Shell";
    const filesTitle = intent.host_id === "demo-remote" ? "/srv/demo" : "~";
    next.workspaces.push({
      id: workspaceId,
      host_id: intent.host_id,
      title,
      owned_tool_tab_ids: [filesToolId, terminalToolId, transfersToolId],
      layout: {
        kind: "split",
        direction: "row",
        ratios: [0.28, 0.72],
        children: [
          {
            kind: "group",
            id: `group-files-demo-${next.version + 1}`,
            role: "sidebar",
            active_slot_id: filesSlotId,
            slots: [{ kind: "owned", id: filesSlotId, tool_tab_id: filesToolId }],
          },
          {
            kind: "split",
            direction: "column",
            ratios: [0.78, 0.22],
            children: [
              {
                kind: "group",
                id: `group-terminal-demo-${next.version + 1}`,
                role: "content",
                active_slot_id: terminalSlotId,
                slots: [{ kind: "owned", id: terminalSlotId, tool_tab_id: terminalToolId }],
              },
              {
                kind: "group",
                id: `group-transfers-demo-${next.version + 1}`,
                role: "panel",
                active_slot_id: transfersSlotId,
                slots: [{ kind: "owned", id: transfersSlotId, tool_tab_id: transfersToolId }],
              },
            ],
          },
        ],
      },
    });
    next.tool_tabs.push(
      {
        id: filesToolId,
        kind: "files",
        owner_workspace_id: workspaceId,
        host_id: intent.host_id,
        title: filesTitle,
      },
      {
        id: terminalToolId,
        kind: "terminal",
        owner_workspace_id: workspaceId,
        host_id: intent.host_id,
        title: terminalTitle,
      },
      {
        id: transfersToolId,
        kind: "transfers",
        owner_workspace_id: workspaceId,
        host_id: intent.host_id,
        title: "Transfers",
      },
    );
    next.active_workspace_id = workspaceId;
    return bumpDemoVersion(next);
  }
  if (intent.kind === "activate_tool_slot") {
    const workspace = requireDemoWorkspace(next, intent.workspace_id);
    workspace.layout = activateDemoSlot(workspace.layout, intent.slot_id);
    return bumpDemoVersion(next);
  }
  if (intent.kind === "move_tool_slot_to_group") {
    const workspace = requireDemoWorkspace(next, intent.workspace_id);
    const removed = removeDemoSlot(workspace.layout, intent.slot_id);
    if (!removed.layout) throw new Error("cannot move the last ToolTab in a workspace");
    workspace.layout = addDemoSlotToGroup(removed.layout, intent.target_group_id, removed.slot);
    return bumpDemoVersion(next);
  }
  if (intent.kind === "move_tool_slot_to_split") {
    const workspace = requireDemoWorkspace(next, intent.workspace_id);
    if (intent.slot_id === intent.target_slot_id) return next;
    const removed = removeDemoSlot(workspace.layout, intent.slot_id);
    if (!removed.layout) throw new Error("cannot move the last ToolTab in a workspace");
    workspace.layout = splitDemoSlot(removed.layout, intent.target_slot_id, removed.slot, intent.side);
    return bumpDemoVersion(next);
  }
  if (intent.kind === "move_tool_slot_to_workspace_edge") {
    const workspace = requireDemoWorkspace(next, intent.workspace_id);
    const removed = removeDemoSlot(workspace.layout, intent.slot_id);
    if (!removed.layout) throw new Error("cannot move the last ToolTab in a workspace");
    workspace.layout = splitDemoWorkspaceEdge(removed.layout, removed.slot, intent.side);
    return bumpDemoVersion(next);
  }
  if (intent.kind === "mirror_tool_tab") {
    const tool = next.tool_tabs.find((item) => item.id === intent.source_tool_tab_id);
    if (!tool) throw new Error(`tool tab ${intent.source_tool_tab_id} not found`);
    if (tool.owner_workspace_id === intent.target_workspace_id) throw new Error("owned ToolTabs cannot be mirrored into their owner workspace");
    const workspace = requireDemoWorkspace(next, intent.target_workspace_id);
    const duplicate = listDemoSlots(workspace.layout).find(
      (slot) => slot.kind === "mirror" && slot.tool_tab_id === intent.source_tool_tab_id,
    );
    if (duplicate) {
      workspace.layout = activateDemoSlot(workspace.layout, duplicate.id);
      return bumpDemoVersion(next);
    }
    workspace.layout = addDemoSlotToGroup(workspace.layout, intent.target_group_id, {
      kind: "mirror",
      id: `slot-mirror-${next.version + 1}`,
      tool_tab_id: intent.source_tool_tab_id,
      owner_workspace_id: tool.owner_workspace_id,
    });
    return bumpDemoVersion(next);
  }
  if (intent.kind === "float_tool_slot") {
    const workspace = requireDemoWorkspace(next, intent.workspace_id);
    const slot = findDemoSlot(workspace.layout, intent.slot_id);
    if (!slot || slot.kind !== "owned") throw new Error(`owned slot ${intent.slot_id} not found`);
    const tool = next.tool_tabs.find((item) => item.id === slot.tool_tab_id);
    if (!tool) throw new Error(`tool tab ${slot.tool_tab_id} not found`);
    const floatingWindowId = `floating-demo-${next.version + 1}`;
    next.floating_windows.push({
      id: floatingWindowId,
      layout: {
        kind: "group",
        id: `group-${floatingWindowId}`,
        role: "content",
        active_slot_id: `slot-${floatingWindowId}`,
        slots: [
          {
            kind: "mirror",
            id: `slot-${floatingWindowId}`,
            tool_tab_id: slot.tool_tab_id,
            owner_workspace_id: tool.owner_workspace_id,
          },
        ],
      },
    });
    return bumpDemoVersion(next);
  }
  if (intent.kind === "create_terminal_tool_tab") {
    const workspace = requireDemoWorkspace(next, intent.workspace_id);
    const toolTabId = `tool-terminal-demo-${next.version + 1}`;
    const slotId = `slot-terminal-demo-${next.version + 1}`;
    next.tool_tabs.push({
      id: toolTabId,
      kind: "terminal",
      owner_workspace_id: workspace.id,
      host_id: workspace.host_id,
      title: "Local Shell",
    });
    workspace.owned_tool_tab_ids.push(toolTabId);
    const targetGroupId = intent.target_group_id ?? firstDemoTerminalGroupId(workspace.layout);
    workspace.layout = targetGroupId
      ? addDemoSlotToGroup(workspace.layout, targetGroupId, {
          kind: "owned",
          id: slotId,
          tool_tab_id: toolTabId,
        })
      : addDemoSlotToFirstGroup(workspace.layout, {
          kind: "owned",
          id: slotId,
          tool_tab_id: toolTabId,
        });
    return bumpDemoVersion(next);
  }
  if (intent.kind === "close_floating_window") {
    const floating = next.floating_windows.find((window) => window.id === intent.floating_window_id);
    if (!floating) throw new Error(`floating window ${intent.floating_window_id} not found`);
    next.floating_windows = next.floating_windows.filter((window) => window.id !== intent.floating_window_id);
    return bumpDemoVersion(next);
  }
  return bumpDemoVersion(next);
}

type DemoLayout = WorkspaceLayoutSnapshot["workspaces"][number]["layout"];
type DemoSlot = Extract<DemoLayout, { kind: "group" }>["slots"][number];

function bumpDemoVersion(snapshot: WorkspaceLayoutSnapshot): WorkspaceLayoutSnapshot {
  snapshot.version += 1;
  return snapshot;
}

function cloneDemoSnapshot(snapshot: WorkspaceLayoutSnapshot): WorkspaceLayoutSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as WorkspaceLayoutSnapshot;
}

function uniqueDemoWorkspaceTitle(snapshot: WorkspaceLayoutSnapshot, baseTitle: string): string {
  const base = baseTitle.trim() || "Workspace";
  const existing = new Set(snapshot.workspaces.map((workspace) => workspace.title.trim()));
  if (!existing.has(base)) return base;
  for (let suffix = 2; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error("workspace title suffix space exhausted");
}

function requireDemoWorkspace(snapshot: WorkspaceLayoutSnapshot, workspaceId: string) {
  const workspace = snapshot.workspaces.find((item) => item.id === workspaceId);
  if (!workspace) throw new Error(`workspace ${workspaceId} not found`);
  return workspace;
}

function listDemoSlots(layout: DemoLayout): DemoSlot[] {
  if (layout.kind === "group") return [...layout.slots];
  return layout.children.flatMap(listDemoSlots);
}

function findDemoSlot(layout: DemoLayout, slotId: string): DemoSlot | null {
  return listDemoSlots(layout).find((slot) => slot.id === slotId) ?? null;
}

function activateDemoSlot(layout: DemoLayout, slotId: string): DemoLayout {
  if (layout.kind === "group") {
    return layout.slots.some((slot) => slot.id === slotId) ? { ...layout, active_slot_id: slotId } : layout;
  }
  return { ...layout, children: layout.children.map((child) => activateDemoSlot(child, slotId)) };
}

function removeDemoSlot(layout: DemoLayout, slotId: string): { layout: DemoLayout | null; slot: DemoSlot } {
  const removed = removeDemoSlotRecursive(layout, slotId);
  if (!removed.slot) throw new Error(`display slot ${slotId} not found`);
  return { layout: collapseDemoLayout(removed.layout), slot: removed.slot };
}

function removeDemoSlotRecursive(layout: DemoLayout, slotId: string): { layout: DemoLayout | null; slot: DemoSlot | null } {
  if (layout.kind === "group") {
    const slot = layout.slots.find((item) => item.id === slotId) ?? null;
    if (!slot) return { layout, slot: null };
    const slots = layout.slots.filter((item) => item.id !== slotId);
    if (slots.length === 0) return { layout: null, slot };
    return {
      layout: {
        ...layout,
        slots,
        active_slot_id: slots.some((item) => item.id === layout.active_slot_id) ? layout.active_slot_id : slots[0].id,
      },
      slot,
    };
  }
  let removedSlot: DemoSlot | null = null;
  const children: DemoLayout[] = [];
  for (const child of layout.children) {
    if (removedSlot) {
      children.push(child);
      continue;
    }
    const removed = removeDemoSlotRecursive(child, slotId);
    removedSlot = removed.slot;
    if (removed.layout) children.push(removed.layout);
  }
  return {
    layout: children.length ? { ...layout, children, ratios: normalizeDemoRatios(layout.ratios, children.length) } : null,
    slot: removedSlot,
  };
}

function addDemoSlotToGroup(layout: DemoLayout, groupId: string, slot: DemoSlot): DemoLayout {
  if (layout.kind === "group") {
    if (layout.id !== groupId) return layout;
    return { ...layout, slots: [...layout.slots, slot], active_slot_id: slot.id };
  }
  return { ...layout, children: layout.children.map((child) => addDemoSlotToGroup(child, groupId, slot)) };
}

function addDemoSlotToFirstGroup(layout: DemoLayout, slot: DemoSlot): DemoLayout {
  if (layout.kind === "group") {
    return { ...layout, slots: [...layout.slots, slot], active_slot_id: slot.id };
  }
  const children = [...layout.children];
  const first = children[0];
  if (!first) throw new Error("dock split has no children");
  children[0] = addDemoSlotToFirstGroup(first, slot);
  return { ...layout, children };
}

function firstDemoTerminalGroupId(layout: DemoLayout): string | null {
  if (layout.kind === "group") {
    return layout.role === "content" ? layout.id : null;
  }
  return layout.children.map(firstDemoTerminalGroupId).find((id): id is string => id !== null) ?? null;
}

function splitDemoSlot(layout: DemoLayout, targetSlotId: string, slot: DemoSlot, side: "left" | "right" | "up" | "down"): DemoLayout {
  if (layout.kind === "group") {
    if (!layout.slots.some((item) => item.id === targetSlotId)) return layout;
    const inserted: DemoLayout = { kind: "group", id: `group-${slot.id}`, role: layout.role, slots: [slot], active_slot_id: slot.id };
    const direction = side === "left" || side === "right" ? "row" : "column";
    const before = side === "left" || side === "up";
    return { kind: "split", direction, ratios: [0.5, 0.5], children: before ? [inserted, layout] : [layout, inserted] };
  }
  return { ...layout, children: layout.children.map((child) => splitDemoSlot(child, targetSlotId, slot, side)) };
}

function splitDemoWorkspaceEdge(layout: DemoLayout, slot: DemoSlot, side: "left" | "right" | "up" | "down"): DemoLayout {
  const inserted: DemoLayout = { kind: "group", id: `group-${slot.id}`, role: "sidebar", slots: [slot], active_slot_id: slot.id };
  const direction = side === "left" || side === "right" ? "row" : "column";
  const before = side === "left" || side === "up";
  return {
    kind: "split",
    direction,
    ratios: before ? [0.28, 0.72] : [0.72, 0.28],
    children: before ? [inserted, layout] : [layout, inserted],
  };
}

function replaceDemoSlot(layout: DemoLayout, slotId: string, replacement: DemoSlot): DemoLayout {
  if (layout.kind === "group") {
    if (!layout.slots.some((slot) => slot.id === slotId)) return layout;
    return {
      ...layout,
      active_slot_id: layout.active_slot_id === slotId ? replacement.id : layout.active_slot_id,
      slots: layout.slots.map((slot) => (slot.id === slotId ? replacement : slot)),
    };
  }
  return { ...layout, children: layout.children.map((child) => replaceDemoSlot(child, slotId, replacement)) };
}

function collapseDemoLayout(layout: DemoLayout | null): DemoLayout | null {
  if (!layout || layout.kind === "group") return layout;
  const children = layout.children
    .map((child) => collapseDemoLayout(child))
    .filter((child): child is DemoLayout => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return collapseDemoLayout(children[0] ?? null);
  return { ...layout, children, ratios: normalizeDemoRatios(layout.ratios, children.length) };
}

function normalizeDemoRatios(ratios: Array<number | null>, length: number) {
  if (ratios.length !== length) return Array.from({ length }, () => 1 / length);
  const numeric = ratios.map((ratio) => (typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0 ? ratio : 0));
  const total = numeric.reduce((sum, ratio) => sum + ratio, 0);
  return total > 0 ? numeric.map((ratio) => ratio / total) : Array.from({ length }, () => 1 / length);
}
