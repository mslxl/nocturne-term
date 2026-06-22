export type FilesUploadTargetViewMode = "tree" | "columns";

export type FilesUploadTargetEntry = {
  kind: string;
  path: string;
};

export type FilesUploadTargetInput = {
  viewMode: FilesUploadTargetViewMode;
  focusedDirectoryPath: string | null;
  selectedEntries: readonly FilesUploadTargetEntry[];
  explicitDirectoryPath?: string | null;
  hostDefaultPath?: string | null;
};

export type FilesUploadTargetResult =
  | { kind: "target"; path: string }
  | { kind: "needs_target_sheet"; initialPath: string | null };

export function resolveFilesUploadTarget(input: FilesUploadTargetInput): FilesUploadTargetResult {
  if (input.explicitDirectoryPath) {
    return { kind: "target", path: input.explicitDirectoryPath };
  }

  const selectedTarget = resolveSelectedEntriesTarget(input.selectedEntries);
  if (selectedTarget) {
    return { kind: "target", path: selectedTarget };
  }

  if (input.viewMode === "columns" && input.focusedDirectoryPath) {
    return { kind: "target", path: input.focusedDirectoryPath };
  }

  return {
    kind: "needs_target_sheet",
    initialPath: input.focusedDirectoryPath || input.hostDefaultPath || null,
  };
}

export function resolveSelectedEntriesTarget(entries: readonly FilesUploadTargetEntry[]): string | null {
  if (entries.length === 0) return null;
  if (entries.length === 1) {
    const [entry] = entries;
    if (!entry) return null;
    return entry.kind === "directory" ? entry.path : parentPathOf(entry.path);
  }

  const selectedDirectories = entries.filter((entry) => entry.kind === "directory");
  if (selectedDirectories.length === 1) {
    return selectedDirectories[0]?.path ?? null;
  }

  const parentPaths = entries.map((entry) => (entry.kind === "directory" ? parentPathOf(entry.path) : parentPathOf(entry.path)));
  const [firstParent] = parentPaths;
  if (firstParent && parentPaths.every((parent) => parent === firstParent)) {
    return firstParent;
  }
  return null;
}

export function parentPathOf(value: string): string {
  const normalized = value.replace(/[\\/]+$/, "");
  const slashIndex = normalized.lastIndexOf("/");
  const backslashIndex = normalized.lastIndexOf("\\");
  const index = Math.max(slashIndex, backslashIndex);
  if (index < 0) return "";
  if (index === 0) return normalized[0] ?? "/";
  if (/^[A-Za-z]:[\\/]?[^\\/]+$/.test(normalized)) return normalized.slice(0, 2);
  return normalized.slice(0, index);
}
