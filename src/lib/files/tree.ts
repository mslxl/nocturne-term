import type { FileEntry, FilePreviewResult } from "$lib/bindings";

export type FileTreeEntry = Pick<
  FileEntry,
  "name" | "path" | "kind" | "size" | "modified_unix_ms" | "permissions" | "owner" | "group" | "symlink_target"
>;

export type FileTreePreviewResult = FilePreviewResult;

export type FileTreeRow<TEntry extends FileTreeEntry = FileTreeEntry> = {
  entry: TEntry;
  depth: number;
  expanded: boolean;
  loading: boolean;
  error: string | null;
};

export type FileTreeRowsInput<TEntry extends FileTreeEntry = FileTreeEntry> = {
  rootEntries: readonly TEntry[];
  childrenByPath: Readonly<Record<string, readonly TEntry[]>>;
  expandedPaths: ReadonlySet<string>;
  loadingPaths: ReadonlySet<string>;
  errorByPath: ReadonlyMap<string, string>;
};

export type FileTreeDoubleClickAction = "ignore-directory" | "select-file";
export type FileTreeClickAction = "toggle-directory" | "select-file";

export type FilePreviewRegionInput = {
  selectedPath: string;
  previewPath: string;
  preview: FilePreviewResult | undefined;
};

export function buildFileTreeRows<TEntry extends FileTreeEntry>(input: FileTreeRowsInput<TEntry>): FileTreeRow<TEntry>[] {
  const rows: FileTreeRow<TEntry>[] = [];
  const visiting = new Set<string>();

  for (const entry of input.rootEntries) {
    appendEntryRows(entry, 0, input, rows, visiting);
  }

  return rows;
}

export function fileTreeDoubleClickAction(entry: FileTreeEntry): FileTreeDoubleClickAction {
  return entry.kind === "directory" ? "ignore-directory" : "select-file";
}

export function fileTreeClickAction(entry: FileTreeEntry): FileTreeClickAction {
  return entry.kind === "directory" ? "toggle-directory" : "select-file";
}

export function isRenderableFilePreview(preview: FilePreviewResult | undefined): boolean {
  return preview?.content.kind === "text" || preview?.content.kind === "image";
}

export function shouldShowFilePreviewRegion(input: FilePreviewRegionInput): boolean {
  return Boolean(
    input.selectedPath &&
      input.previewPath &&
      input.selectedPath === input.previewPath &&
      input.preview?.path === input.previewPath &&
      isRenderableFilePreview(input.preview),
  );
}

function appendEntryRows<TEntry extends FileTreeEntry>(
  entry: TEntry,
  depth: number,
  input: FileTreeRowsInput<TEntry>,
  rows: FileTreeRow<TEntry>[],
  visiting: Set<string>,
) {
  const expanded = input.expandedPaths.has(entry.path);
  rows.push({
    entry,
    depth,
    expanded,
    loading: input.loadingPaths.has(entry.path),
    error: input.errorByPath.get(entry.path) ?? null,
  });

  if (entry.kind !== "directory" || !expanded || visiting.has(entry.path)) {
    return;
  }

  visiting.add(entry.path);
  const children = input.childrenByPath[entry.path] ?? [];
  for (const child of children) {
    appendEntryRows(child, depth + 1, input, rows, visiting);
  }
  visiting.delete(entry.path);
}
