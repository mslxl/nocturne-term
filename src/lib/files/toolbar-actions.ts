export type FilesToolbarActionId =
  | "up"
  | "refresh"
  | "new_folder"
  | "paste"
  | "upload_files"
  | "upload_folder"
  | "search"
  | "view_mode"
  | "path";

export const DEFAULT_FILES_TOOLBAR_ACTION_IDS: FilesToolbarActionId[] = [
  "up",
  "refresh",
  "new_folder",
  "paste",
  "upload_files",
  "upload_folder",
  "search",
  "view_mode",
  "path",
];

const validFilesToolbarActionIds = new Set<string>(DEFAULT_FILES_TOOLBAR_ACTION_IDS);

export function normalizeFilesToolbarActionIds(configuredIds: readonly string[] | undefined): FilesToolbarActionId[] {
  const normalized: FilesToolbarActionId[] = [];
  const seen = new Set<string>();
  for (const id of configuredIds ?? []) {
    if (!validFilesToolbarActionIds.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    normalized.push(id as FilesToolbarActionId);
  }
  return normalized.length ? normalized : [...DEFAULT_FILES_TOOLBAR_ACTION_IDS];
}

export function filesToolbarActionIdsFromSettingText(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function filesToolbarActionSettingText(configuredIds: readonly string[] | undefined): string {
  return normalizeFilesToolbarActionIds(configuredIds).join("\n");
}
