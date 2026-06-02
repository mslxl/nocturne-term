import { listen } from "@tauri-apps/api/event";
import { commands, type WorkspaceDispatchInput, type WorkspaceLayoutSnapshot } from "$lib/bindings";
import { unwrapCommand } from "$lib/terminal/commands";
import { hasTauriRuntime } from "$lib/tauri/runtime";

export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;

type WorkspaceChangedEvent = {
  version: number;
  reason: string;
  snapshot: WorkspaceLayoutSnapshot;
};

export function createWorkspaceStore() {
  let snapshot = $state<WorkspaceLayoutSnapshot | null>(null);
  let loading = $state(false);
  let error = $state("");
  let unlisten: (() => void) | null = null;

  async function load() {
    if (!hasTauriRuntime()) {
      snapshot = demoWorkspaceSnapshot();
      error = "";
      return;
    }
    loading = true;
    error = "";
    try {
      snapshot = await unwrapCommand(commands.getWorkspaceLayoutSnapshot());
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      loading = false;
    }
  }

  async function dispatch(intent: WorkspaceDispatchInput["intent"]) {
    const current = snapshot;
    if (!current) throw new Error("workspace snapshot is not loaded");
    if (!hasTauriRuntime()) {
      snapshot = applyDemoWorkspaceIntent(current, intent);
      error = "";
      return snapshot;
    }
    const next = await unwrapCommand(
      commands.workspaceDispatch({
        expected_version: current.version,
        intent,
      }),
    );
    snapshot = next;
    error = "";
    return next;
  }

  async function subscribe() {
    if (!hasTauriRuntime() || unlisten) return;
    unlisten = await listen<WorkspaceChangedEvent>("workspace://changed", (event) => {
      snapshot = event.payload.snapshot;
      error = "";
    });
  }

  function dispose() {
    unlisten?.();
    unlisten = null;
  }

  function replaceSnapshot(next: WorkspaceLayoutSnapshot) {
    snapshot = next;
    error = "";
  }

  return {
    get snapshot() {
      return snapshot;
    },
    get loading() {
      return loading;
    },
    get error() {
      return error;
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
                  active_slot_id: "slot-terminal-demo",
                  slots: [{ kind: "owned", id: "slot-terminal-demo", tool_tab_id: "terminal-demo" }],
                },
                {
                  kind: "group",
                  id: "group-transfers-demo",
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
                  active_slot_id: "slot-terminal-remote-demo",
                  slots: [{ kind: "owned", id: "slot-terminal-remote-demo", tool_tab_id: "terminal-remote-demo" }],
                },
                {
                  kind: "group",
                  id: "group-transfers-remote-demo",
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
    const floatingWindowId = `floating-demo-${next.version + 1}`;
    workspace.layout = replaceDemoSlot(workspace.layout, intent.slot_id, {
      kind: "floating_placeholder",
      id: intent.slot_id,
      tool_tab_id: slot.tool_tab_id,
      floating_window_id: floatingWindowId,
    });
    next.floating_windows.push({
      id: floatingWindowId,
      layout: {
        kind: "group",
        id: `group-${floatingWindowId}`,
        active_slot_id: `slot-${floatingWindowId}`,
        slots: [{ kind: "owned", id: `slot-${floatingWindowId}`, tool_tab_id: slot.tool_tab_id }],
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
  if (intent.kind === "restore_floating_window") {
    const floating = next.floating_windows.find((window) => window.id === intent.floating_window_id);
    if (!floating) throw new Error(`floating window ${intent.floating_window_id} not found`);
    for (const slot of listDemoSlots(floating.layout)) {
      if (slot.kind !== "owned") continue;
      const tool = next.tool_tabs.find((item) => item.id === slot.tool_tab_id);
      if (!tool) throw new Error(`tool tab ${slot.tool_tab_id} not found`);
      const workspace = requireDemoWorkspace(next, tool.owner_workspace_id);
      const placeholder = listDemoSlots(workspace.layout).find(
        (item) =>
          item.kind === "floating_placeholder" &&
          item.tool_tab_id === slot.tool_tab_id &&
          item.floating_window_id === intent.floating_window_id,
      );
      if (placeholder) {
        workspace.layout = replaceDemoSlot(workspace.layout, placeholder.id, {
          kind: "owned",
          id: placeholder.id,
          tool_tab_id: slot.tool_tab_id,
        });
      }
    }
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
    return layout.slots.some((slot) => slot.kind === "owned" && slot.tool_tab_id.includes("terminal")) ? layout.id : null;
  }
  return layout.children.map(firstDemoTerminalGroupId).find((id): id is string => id !== null) ?? null;
}

function splitDemoSlot(layout: DemoLayout, targetSlotId: string, slot: DemoSlot, side: "left" | "right" | "up" | "down"): DemoLayout {
  if (layout.kind === "group") {
    if (!layout.slots.some((item) => item.id === targetSlotId)) return layout;
    const inserted: DemoLayout = { kind: "group", id: `group-${slot.id}`, slots: [slot], active_slot_id: slot.id };
    const direction = side === "left" || side === "right" ? "row" : "column";
    const before = side === "left" || side === "up";
    return { kind: "split", direction, ratios: [0.5, 0.5], children: before ? [inserted, layout] : [layout, inserted] };
  }
  return { ...layout, children: layout.children.map((child) => splitDemoSlot(child, targetSlotId, slot, side)) };
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
  return layout.children.length === 1 ? layout.children[0] : layout;
}

function normalizeDemoRatios(ratios: Array<number | null>, length: number) {
  if (ratios.length !== length) return Array.from({ length }, () => 1 / length);
  const numeric = ratios.map((ratio) => (typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0 ? ratio : 0));
  const total = numeric.reduce((sum, ratio) => sum + ratio, 0);
  return total > 0 ? numeric.map((ratio) => ratio / total) : Array.from({ length }, () => 1 / length);
}
