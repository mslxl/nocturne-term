export type FilesContextMenuActionId = "rename" | "permissions" | "delete" | "copy" | "cut" | "download";

export type FilesContextMenuCapabilities = {
  canChmod: boolean;
};

export type FilesContextMenuAction = {
  id: FilesContextMenuActionId;
  label: string;
  disabled: boolean;
};

const actionLabels: Record<FilesContextMenuActionId, string> = {
  rename: "Rename",
  permissions: "Permissions",
  delete: "Delete",
  copy: "Copy",
  cut: "Cut",
  download: "Download",
};

export function filesSelectionContextMenuActions(
  selectedCount: number,
  capabilities: FilesContextMenuCapabilities,
): FilesContextMenuAction[] {
  return (["rename", "permissions", "delete", "copy", "cut", "download"] as const).map((id) => ({
    id,
    label: actionLabels[id],
    disabled: filesContextMenuActionDisabled(id, selectedCount, capabilities),
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
