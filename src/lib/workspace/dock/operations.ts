import {
  cloneDockLayout,
  createClosedSourceSlot,
  createDockGroup,
  createMirrorSlot,
  hasDisplaySlot,
  listDockSlots,
  normalizeDockRatios,
  type DisplaySlotId,
  type DockGroup,
  type DockGroupId,
  type DockLayout,
  type DockSide,
  type FloatingWindowId,
  type ToolSlot,
  type ToolTabId,
  type WorkspaceId,
  type WorkspaceLayoutSnapshot,
} from "./model";

export type DockIdFactory = {
  slotId: () => DisplaySlotId;
  groupId: () => DockGroupId;
};

export function splitSlot(
  layout: DockLayout,
  targetSlotId: DisplaySlotId,
  insertedSlot: ToolSlot,
  side: DockSide,
  ids: Pick<DockIdFactory, "groupId">,
): DockLayout {
  if (!hasDisplaySlot(layout, targetSlotId)) {
    throw new Error(`target display slot ${targetSlotId} not found`);
  }
  if (hasDisplaySlot(layout, insertedSlot.id)) {
    throw new Error(`display slot ${insertedSlot.id} already exists`);
  }
  return splitSlotRecursive(layout, targetSlotId, insertedSlot, side, ids);
}

export function removeSlot(layout: DockLayout, slotId: DisplaySlotId): { layout: DockLayout | null; removed: ToolSlot } {
  if (!hasDisplaySlot(layout, slotId)) {
    throw new Error(`display slot ${slotId} not found`);
  }
  const result = removeSlotRecursive(layout, slotId);
  if (!result.removed) throw new Error(`display slot ${slotId} was not removed`);
  return { layout: collapseSingleChild(result.layout), removed: result.removed };
}

export function replaceSlot(layout: DockLayout, slotId: DisplaySlotId, replacement: ToolSlot): DockLayout {
  if (!hasDisplaySlot(layout, slotId)) {
    throw new Error(`display slot ${slotId} not found`);
  }
  if (slotId !== replacement.id && hasDisplaySlot(layout, replacement.id)) {
    throw new Error(`display slot ${replacement.id} already exists`);
  }
  return replaceSlotRecursive(layout, slotId, replacement);
}

export function addSlotToGroup(layout: DockLayout, groupId: DockGroupId, slot: ToolSlot): DockLayout {
  if (hasDisplaySlot(layout, slot.id)) {
    throw new Error(`display slot ${slot.id} already exists`);
  }
  return mapGroup(layout, groupId, (group) => createDockGroup(group.id, group.role, [...group.slots, slot], slot.id));
}

export function createMirrorInWorkspace(
  snapshot: WorkspaceLayoutSnapshot,
  sourceToolTabId: ToolTabId,
  targetWorkspaceId: WorkspaceId,
  targetGroupId: DockGroupId,
  ids: Pick<DockIdFactory, "slotId">,
): WorkspaceLayoutSnapshot {
  const sourceToolTab = snapshot.toolTabs.find((toolTab) => toolTab.id === sourceToolTabId);
  if (!sourceToolTab) throw new Error(`source tool tab ${sourceToolTabId} not found`);
  if (sourceToolTab.ownerWorkspaceId === targetWorkspaceId) {
    throw new Error("owned tool tabs should be moved inside their owner workspace, not mirrored");
  }
  const targetWorkspace = snapshot.workspaces.find((workspace) => workspace.id === targetWorkspaceId);
  if (!targetWorkspace) throw new Error(`target workspace ${targetWorkspaceId} not found`);
  const duplicate = listDockSlots(targetWorkspace.layout).find(
    (slot) => slot.kind === "mirror" && slot.toolTabId === sourceToolTabId,
  );
  if (duplicate) {
    return {
      ...snapshot,
      workspaces: snapshot.workspaces.map((workspace) =>
        workspace.id === targetWorkspaceId
          ? { ...workspace, layout: activateSlot(workspace.layout, duplicate.id) }
          : workspace,
      ),
    };
  }
  const slot = createMirrorSlot(ids.slotId(), sourceToolTabId, sourceToolTab.ownerWorkspaceId);
  return {
    ...snapshot,
    workspaces: snapshot.workspaces.map((workspace) =>
      workspace.id === targetWorkspaceId
        ? { ...workspace, layout: addSlotToGroup(workspace.layout, targetGroupId, slot) }
        : workspace,
    ),
  };
}

export function floatOwnedSlot(
  snapshot: WorkspaceLayoutSnapshot,
  ownerWorkspaceId: WorkspaceId,
  ownerSlotId: DisplaySlotId,
  floatingWindowId: FloatingWindowId,
  ids: DockIdFactory,
): WorkspaceLayoutSnapshot {
  const ownerWorkspace = snapshot.workspaces.find((workspace) => workspace.id === ownerWorkspaceId);
  if (!ownerWorkspace) throw new Error(`owner workspace ${ownerWorkspaceId} not found`);
  const slot = listDockSlots(ownerWorkspace.layout).find((item) => item.id === ownerSlotId);
  if (!slot) throw new Error(`owner display slot ${ownerSlotId} not found`);
  if (slot.kind !== "owned") throw new Error(`display slot ${ownerSlotId} is not owned`);
  const toolTab = snapshot.toolTabs.find((item) => item.id === slot.toolTabId);
  if (!toolTab) throw new Error(`owned slot ${ownerSlotId} references missing tool tab ${slot.toolTabId}`);
  const floatingSlot = createMirrorSlot(ids.slotId(), slot.toolTabId, toolTab.ownerWorkspaceId);
  const floatingGroup = createDockGroup(ids.groupId(), "content", [floatingSlot], floatingSlot.id);
  return {
    ...snapshot,
    floatingWindows: [...snapshot.floatingWindows, { id: floatingWindowId, layout: floatingGroup }],
  };
}

export function closeFloatingWindow(snapshot: WorkspaceLayoutSnapshot, floatingWindowId: FloatingWindowId): WorkspaceLayoutSnapshot {
  const floatingWindow = snapshot.floatingWindows.find((window) => window.id === floatingWindowId);
  if (!floatingWindow) throw new Error(`floating window ${floatingWindowId} not found`);
  return {
    ...snapshot,
    floatingWindows: snapshot.floatingWindows.filter((window) => window.id !== floatingWindowId),
  };
}

export function closeOwnerToolTab(snapshot: WorkspaceLayoutSnapshot, toolTabId: ToolTabId): WorkspaceLayoutSnapshot {
  const toolTab = snapshot.toolTabs.find((item) => item.id === toolTabId);
  if (!toolTab) throw new Error(`tool tab ${toolTabId} not found`);
  const ownerWorkspace = snapshot.workspaces.find((workspace) => workspace.id === toolTab.ownerWorkspaceId);
  if (!ownerWorkspace) throw new Error(`owner workspace ${toolTab.ownerWorkspaceId} not found`);
  const closedSource = (slotId: DisplaySlotId) => createClosedSourceSlot(slotId, toolTab.title, ownerWorkspace.title);
  return {
    ...snapshot,
    workspaces: snapshot.workspaces.map((workspace) => ({
      ...workspace,
      ownedToolTabIds: workspace.ownedToolTabIds.filter((id) => id !== toolTabId),
      layout: removeOrCloseToolSlots(workspace.layout, toolTabId, closedSource, workspace.id === toolTab.ownerWorkspaceId),
    })),
    floatingWindows: snapshot.floatingWindows.map((window) => ({
      ...window,
      layout: removeOrCloseToolSlots(window.layout, toolTabId, closedSource, true),
    })),
    toolTabs: snapshot.toolTabs.filter((item) => item.id !== toolTabId),
  };
}

export function activateSlot(layout: DockLayout, slotId: DisplaySlotId): DockLayout {
  if (!hasDisplaySlot(layout, slotId)) throw new Error(`display slot ${slotId} not found`);
  return mapContainingGroup(layout, slotId, (group) => ({ ...group, activeSlotId: slotId }));
}

function splitSlotRecursive(
  layout: DockLayout,
  targetSlotId: DisplaySlotId,
  insertedSlot: ToolSlot,
  side: DockSide,
  ids: Pick<DockIdFactory, "groupId">,
): DockLayout {
  if (layout.kind === "group") {
    if (!layout.slots.some((slot) => slot.id === targetSlotId)) return layout;
    const direction = side === "left" || side === "right" ? "row" : "column";
    const before = side === "left" || side === "up";
    const existing = cloneDockLayout(layout);
    const insertedGroup = createDockGroup(ids.groupId(), layout.role, [insertedSlot], insertedSlot.id);
    return {
      kind: "split",
      direction,
      children: before ? [insertedGroup, existing] : [existing, insertedGroup],
      ratios: [0.5, 0.5],
    };
  }
  return {
    ...layout,
    children: layout.children.map((child) =>
      hasDisplaySlot(child, targetSlotId) ? splitSlotRecursive(child, targetSlotId, insertedSlot, side, ids) : child,
    ),
  };
}

function removeSlotRecursive(layout: DockLayout, slotId: DisplaySlotId): { layout: DockLayout | null; removed: ToolSlot | null } {
  if (layout.kind === "group") {
    const removed = layout.slots.find((slot) => slot.id === slotId) ?? null;
    if (!removed) return { layout, removed: null };
    const remaining = layout.slots.filter((slot) => slot.id !== slotId);
    if (remaining.length === 0) {
      return {
        layout: layout.role === "content" ? createDockGroup(layout.id, layout.role, [], "") : null,
        removed,
      };
    }
    const activeSlotId = layout.activeSlotId === slotId ? remaining[0]?.id : layout.activeSlotId;
    if (!activeSlotId) throw new Error(`dock group ${layout.id} lost active slot after removal`);
    return { layout: createDockGroup(layout.id, layout.role, remaining, activeSlotId), removed };
  }
  let removed: ToolSlot | null = null;
  const children: DockLayout[] = [];
  for (const child of layout.children) {
    if (removed) {
      children.push(child);
      continue;
    }
    const result = removeSlotRecursive(child, slotId);
    removed = result.removed;
    if (result.layout) children.push(result.layout);
  }
  return {
    layout: children.length === 0 ? null : { ...layout, children, ratios: normalizeDockRatios(layout.ratios.slice(0, children.length)) },
    removed,
  };
}

function replaceSlotRecursive(layout: DockLayout, slotId: DisplaySlotId, replacement: ToolSlot): DockLayout {
  if (layout.kind === "group") {
    if (!layout.slots.some((slot) => slot.id === slotId)) return layout;
    const slots = layout.slots.map((slot) => (slot.id === slotId ? replacement : slot));
    const activeSlotId = layout.activeSlotId === slotId ? replacement.id : layout.activeSlotId;
    return createDockGroup(layout.id, layout.role, slots, activeSlotId);
  }
  return { ...layout, children: layout.children.map((child) => replaceSlotRecursive(child, slotId, replacement)) };
}

function removeOrCloseToolSlots(
  layout: DockLayout,
  toolTabId: ToolTabId,
  closedSource: (slotId: DisplaySlotId) => ReturnType<typeof createClosedSourceSlot>,
  removeOwned: boolean,
): DockLayout {
  if (layout.kind === "group") {
    const slots = layout.slots
      .map((slot) => {
        if (slot.kind === "closed-source") return slot;
        if (slot.toolTabId !== toolTabId) return slot;
        if (slot.kind === "mirror") return closedSource(slot.id);
        return removeOwned ? null : slot;
      })
      .filter((slot): slot is ToolSlot => slot !== null);
    if (slots.length === 0) {
      if (layout.role === "content") return createDockGroup(layout.id, layout.role, [], "");
      const closedSlot = closedSource(`${layout.id}-closed`);
      return createDockGroup(layout.id, layout.role, [closedSlot], closedSlot.id);
    }
    const activeSlotId = slots.some((slot) => slot.id === layout.activeSlotId) ? layout.activeSlotId : slots[0]?.id;
    if (!activeSlotId) throw new Error(`dock group ${layout.id} has no active slot`);
    return createDockGroup(layout.id, layout.role, slots, activeSlotId);
  }
  return {
    ...layout,
    children: layout.children.map((child) => removeOrCloseToolSlots(child, toolTabId, closedSource, removeOwned)),
  };
}

function mapGroup(layout: DockLayout, groupId: DockGroupId, map: (group: DockGroup) => DockGroup): DockLayout {
  if (layout.kind === "group") {
    if (layout.id !== groupId) return layout;
    return map(layout);
  }
  if (!layout.children.some((child) => containsGroup(child, groupId))) {
    throw new Error(`dock group ${groupId} not found`);
  }
  return {
    ...layout,
    children: layout.children.map((child) => (containsGroup(child, groupId) ? mapGroup(child, groupId, map) : child)),
  };
}

function mapContainingGroup(layout: DockLayout, slotId: DisplaySlotId, map: (group: DockGroup) => DockGroup): DockLayout {
  if (layout.kind === "group") {
    return layout.slots.some((slot) => slot.id === slotId) ? map(layout) : layout;
  }
  return {
    ...layout,
    children: layout.children.map((child) => (hasDisplaySlot(child, slotId) ? mapContainingGroup(child, slotId, map) : child)),
  };
}

function containsGroup(layout: DockLayout, groupId: DockGroupId): boolean {
  if (layout.kind === "group") return layout.id === groupId;
  return layout.children.some((child) => containsGroup(child, groupId));
}

function collapseSingleChild(layout: DockLayout | null): DockLayout | null {
  if (!layout || layout.kind === "group") return layout;
  const children = layout.children
    .map((child) => collapseSingleChild(child))
    .filter((child): child is DockLayout => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return collapseSingleChild(children[0] ?? null);
  return {
    ...layout,
    children,
    ratios: normalizeDockRatios(layout.ratios.slice(0, children.length)),
  };
}
