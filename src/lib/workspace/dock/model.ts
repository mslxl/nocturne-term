export type WorkspaceId = string;
export type ToolTabId = string;
export type DisplaySlotId = string;
export type DockGroupId = string;
export type FloatingWindowId = string;

export type DockDirection = "row" | "column";
export type DockSide = "left" | "right" | "up" | "down";
export type DockGroupRole = "content" | "side_panel";

export type ToolTabKind = "files" | "terminal" | "transfers" | "resources" | "ports";

export type ToolTab = {
  id: ToolTabId;
  kind: ToolTabKind;
  ownerWorkspaceId: WorkspaceId;
  hostId: string;
  title: string;
};

export type OwnedDisplaySlot = {
  kind: "owned";
  id: DisplaySlotId;
  toolTabId: ToolTabId;
};

export type MirrorDisplaySlot = {
  kind: "mirror";
  id: DisplaySlotId;
  toolTabId: ToolTabId;
  ownerWorkspaceId: WorkspaceId;
};

export type FloatingPlaceholderSlot = {
  kind: "floating-placeholder";
  id: DisplaySlotId;
  toolTabId: ToolTabId;
  floatingWindowId: FloatingWindowId;
};

export type ClosedSourceSlot = {
  kind: "closed-source";
  id: DisplaySlotId;
  previousTitle: string;
  ownerWorkspaceTitle: string;
};

export type ToolSlot = OwnedDisplaySlot | MirrorDisplaySlot | FloatingPlaceholderSlot | ClosedSourceSlot;

export type DockGroup = {
  kind: "group";
  id: DockGroupId;
  role: DockGroupRole;
  slots: ToolSlot[];
  activeSlotId: DisplaySlotId;
  collapsed: boolean;
};

export type DockSplit = {
  kind: "split";
  direction: DockDirection;
  children: DockLayout[];
  ratios: number[];
};

export type DockLayout = DockGroup | DockSplit;

export type WorkspaceTab = {
  id: WorkspaceId;
  hostId: string;
  title: string;
  ownedToolTabIds: ToolTabId[];
  layout: DockLayout;
};

export type FloatingWindowLayout = {
  id: FloatingWindowId;
  layout: DockLayout;
};

export type WorkspaceLayoutSnapshot = {
  version: number;
  activeWorkspaceId: WorkspaceId;
  workspaces: WorkspaceTab[];
  toolTabs: ToolTab[];
  floatingWindows: FloatingWindowLayout[];
};

export function createDockGroup(
  id: DockGroupId,
  role: DockGroupRole,
  slots: ToolSlot[],
  activeSlotId: DisplaySlotId,
  collapsed = false,
): DockGroup {
  if (!id.trim()) throw new Error("dock group id cannot be empty");
  if (!["content", "side_panel"].includes(role)) throw new Error(`dock group ${id} has invalid role ${role}`);
  if (slots.length === 0 && role !== "content") throw new Error(`dock group ${id} must contain at least one slot`);
  assertUnique(slots.map((slot) => slot.id), "display slot");
  if (slots.length > 0 && !slots.some((slot) => slot.id === activeSlotId)) {
    throw new Error(`active slot ${activeSlotId} not found in dock group ${id}`);
  }
  if (slots.length === 0 && activeSlotId) throw new Error(`empty dock group ${id} cannot have an active slot`);
  return { kind: "group", id, role, slots, activeSlotId, collapsed };
}

export function createOwnedSlot(id: DisplaySlotId, toolTabId: ToolTabId): OwnedDisplaySlot {
  assertId("display slot", id);
  assertId("tool tab", toolTabId);
  return { kind: "owned", id, toolTabId };
}

export function createMirrorSlot(
  id: DisplaySlotId,
  toolTabId: ToolTabId,
  ownerWorkspaceId: WorkspaceId,
): MirrorDisplaySlot {
  assertId("display slot", id);
  assertId("tool tab", toolTabId);
  assertId("owner workspace", ownerWorkspaceId);
  return { kind: "mirror", id, toolTabId, ownerWorkspaceId };
}

export function createFloatingPlaceholderSlot(
  id: DisplaySlotId,
  toolTabId: ToolTabId,
  floatingWindowId: FloatingWindowId,
): FloatingPlaceholderSlot {
  assertId("display slot", id);
  assertId("tool tab", toolTabId);
  assertId("floating window", floatingWindowId);
  return { kind: "floating-placeholder", id, toolTabId, floatingWindowId };
}

export function createClosedSourceSlot(
  id: DisplaySlotId,
  previousTitle: string,
  ownerWorkspaceTitle: string,
): ClosedSourceSlot {
  assertId("display slot", id);
  if (!previousTitle.trim()) throw new Error("closed source previous title cannot be empty");
  if (!ownerWorkspaceTitle.trim()) throw new Error("closed source owner workspace title cannot be empty");
  return { kind: "closed-source", id, previousTitle, ownerWorkspaceTitle };
}

export function normalizeDockRatios(ratios: number[]): number[] {
  if (ratios.length === 0) throw new Error("dock split ratios cannot be empty");
  if (ratios.some((ratio) => !Number.isFinite(ratio) || ratio <= 0)) {
    throw new Error("dock split ratios must be positive finite numbers");
  }
  const total = ratios.reduce((sum, ratio) => sum + ratio, 0);
  return ratios.map((ratio) => ratio / total);
}

export function listDockSlots(layout: DockLayout): ToolSlot[] {
  if (layout.kind === "group") return [...layout.slots];
  return layout.children.flatMap((child) => listDockSlots(child));
}

export function listDockGroups(layout: DockLayout): DockGroup[] {
  if (layout.kind === "group") return [layout];
  return layout.children.flatMap((child) => listDockGroups(child));
}

export function hasDisplaySlot(layout: DockLayout, slotId: DisplaySlotId): boolean {
  return listDockSlots(layout).some((slot) => slot.id === slotId);
}

export function cloneDockLayout(layout: DockLayout): DockLayout {
  if (layout.kind === "group") {
    return {
      kind: "group",
      id: layout.id,
      role: layout.role,
      activeSlotId: layout.activeSlotId,
      collapsed: layout.collapsed,
      slots: layout.slots.map((slot) => ({ ...slot })),
    };
  }
  return {
    kind: "split",
    direction: layout.direction,
    ratios: [...layout.ratios],
    children: layout.children.map((child) => cloneDockLayout(child)),
  };
}

export function validateWorkspaceSnapshot(snapshot: WorkspaceLayoutSnapshot) {
  if (!Number.isInteger(snapshot.version) || snapshot.version < 0) {
    throw new Error(`workspace snapshot version must be a non-negative integer: ${snapshot.version}`);
  }
  assertUnique(snapshot.workspaces.map((workspace) => workspace.id), "workspace");
  assertUnique(snapshot.toolTabs.map((toolTab) => toolTab.id), "tool tab");
  assertUnique(snapshot.floatingWindows.map((window) => window.id), "floating window");
  const workspaceIds = new Set(snapshot.workspaces.map((workspace) => workspace.id));
  const toolTabsById = new Map(snapshot.toolTabs.map((toolTab) => [toolTab.id, toolTab]));
  if (!workspaceIds.has(snapshot.activeWorkspaceId)) {
    throw new Error(`active workspace ${snapshot.activeWorkspaceId} not found`);
  }
  for (const toolTab of snapshot.toolTabs) {
    if (!workspaceIds.has(toolTab.ownerWorkspaceId)) {
      throw new Error(`tool tab ${toolTab.id} owner workspace ${toolTab.ownerWorkspaceId} not found`);
    }
  }
  for (const workspace of snapshot.workspaces) {
    validateWorkspace(workspace, toolTabsById);
  }
  for (const window of snapshot.floatingWindows) {
    validateDockLayout(window.layout, toolTabsById);
    const nonContentGroup = listDockGroups(window.layout).find((group) => group.role !== "content");
    if (nonContentGroup) {
      throw new Error(`floating window ${window.id} group ${nonContentGroup.id} must use content role`);
    }
  }
}

function validateWorkspace(workspace: WorkspaceTab, toolTabsById: Map<ToolTabId, ToolTab>) {
  assertId("workspace", workspace.id);
  assertId("host", workspace.hostId);
  if (!workspace.title.trim()) throw new Error(`workspace ${workspace.id} title cannot be empty`);
  assertUnique(workspace.ownedToolTabIds, `workspace ${workspace.id} owned tool tab`);
  for (const toolTabId of workspace.ownedToolTabIds) {
    const toolTab = toolTabsById.get(toolTabId);
    if (!toolTab) throw new Error(`workspace ${workspace.id} references missing tool tab ${toolTabId}`);
    if (toolTab.ownerWorkspaceId !== workspace.id) {
      throw new Error(`workspace ${workspace.id} cannot own tool tab ${toolTabId} from ${toolTab.ownerWorkspaceId}`);
    }
  }
  validateDockLayout(workspace.layout, toolTabsById);
}

function validateDockLayout(layout: DockLayout, toolTabsById: Map<ToolTabId, ToolTab>) {
  if (layout.kind === "group") {
    createDockGroup(layout.id, layout.role, layout.slots, layout.activeSlotId);
    for (const slot of layout.slots) {
      if (slot.kind === "closed-source") continue;
      const toolTab = toolTabsById.get(slot.toolTabId);
      if (!toolTab) throw new Error(`display slot ${slot.id} references missing tool tab ${slot.toolTabId}`);
      if (slot.kind === "mirror" && toolTab.ownerWorkspaceId !== slot.ownerWorkspaceId) {
        throw new Error(`mirror slot ${slot.id} owner workspace mismatch for tool tab ${slot.toolTabId}`);
      }
    }
    return;
  }
  if (layout.children.length < 2) throw new Error("dock split must contain at least two children");
  if (layout.children.length !== layout.ratios.length) {
    throw new Error("dock split children and ratios length must match");
  }
  normalizeDockRatios(layout.ratios);
  for (const child of layout.children) validateDockLayout(child, toolTabsById);
}

function assertId(label: string, id: string) {
  if (!id.trim()) throw new Error(`${label} id cannot be empty`);
}

function assertUnique(values: readonly string[], label: string) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${label} id ${value}`);
    seen.add(value);
  }
}
