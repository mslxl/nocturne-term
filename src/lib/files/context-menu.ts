export type FilesContextMenuActionId = "download" | "rename" | "copy" | "cut" | "permissions" | "copy_path" | "delete";

export type FilesContextMenuCapabilities = {
  canChmod: boolean;
};

export type FilesContextMenuAction = {
  id: FilesContextMenuActionId;
  label: string;
  disabled: boolean;
  dangerous: boolean;
};

const actionLabels: Record<FilesContextMenuActionId, string> = {
  download: "Download",
  rename: "Rename",
  copy: "Copy",
  cut: "Cut",
  permissions: "Permissions",
  copy_path: "Copy Path",
  delete: "Delete",
};

const selectionActionOrder: FilesContextMenuActionId[] = ["download", "rename", "copy", "cut", "permissions", "copy_path", "delete"];

export function filesSelectionContextMenuActions(
  selectedCount: number,
  capabilities: FilesContextMenuCapabilities,
): FilesContextMenuAction[] {
  return selectionActionOrder.map((id) => ({
    id,
    label: actionLabels[id],
    disabled: filesContextMenuActionDisabled(id, selectedCount, capabilities),
    dangerous: id === "delete",
  }));
}

export function filesContextMenuActionDisabled(
  id: FilesContextMenuActionId,
  selectedCount: number,
  capabilities: FilesContextMenuCapabilities,
): boolean {
  if (selectedCount <= 0) return true;
  if (id === "rename") return selectedCount !== 1;
  if (id === "permissions") return !capabilities.canChmod;
  return false;
}
