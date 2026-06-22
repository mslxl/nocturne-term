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

export type FileTreeInitialFocusPlan = {
  rootPath: string;
  focusPath: string;
  expandPaths: string[];
};

export type FileTreeStickySettings = {
  enabled?: boolean | null;
  maxLevels?: number | null;
};

export type FileTreeRowsInput<TEntry extends FileTreeEntry = FileTreeEntry> = {
  rootEntries: readonly TEntry[];
  childrenByPath: Readonly<Record<string, readonly TEntry[]>>;
  expandedPaths: ReadonlySet<string>;
  loadingPaths: ReadonlySet<string>;
  errorByPath: ReadonlyMap<string, string>;
};

export type FileTreeRootModel<TEntry extends FileTreeEntry = FileTreeEntry> = {
  rootEntries: TEntry[];
  childrenByPath: Record<string, TEntry[]>;
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
  const normalizedInput: FileTreeRowsInput<TEntry> = {
    rootEntries: input.rootEntries,
    childrenByPath: cloneChildren(input.childrenByPath),
    expandedPaths: normalizePathSet(input.expandedPaths),
    loadingPaths: normalizePathSet(input.loadingPaths),
    errorByPath: normalizePathMap(input.errorByPath),
  };

  for (const entry of normalizedInput.rootEntries) {
    appendEntryRows(entry, 0, normalizedInput, rows, visiting);
  }

  return rows;
}

export function buildFileTreeRootModel<TEntry extends FileTreeEntry>(input: {
  rootPath: string;
  currentPath: string;
  currentEntries: readonly TEntry[];
  childrenByPath: Readonly<Record<string, readonly TEntry[]>>;
}): FileTreeRootModel<TEntry> {
  const rootPath = normalizeTreePath(input.rootPath || input.currentPath || "/");
  const currentPath = normalizeTreePath(input.currentPath || rootPath);
  const childrenByPath = cloneChildren(input.childrenByPath);
  const rootEntry = syntheticDirectoryEntry<TEntry>(rootPath);
  const ancestors = ancestorPathChain(rootPath, currentPath);

  if (ancestors.length === 0) {
    childrenByPath[rootPath] = mergeEntries(childrenByPath[rootPath] ?? [], input.currentEntries);
    return { rootEntries: [rootEntry], childrenByPath };
  }

  for (let index = 0; index < ancestors.length - 1; index += 1) {
    const parent = ancestors[index];
    const child = ancestors[index + 1];
    childrenByPath[parent] = mergeEntries(childrenByPath[parent] ?? [], [syntheticDirectoryEntry<TEntry>(child)]);
  }
  childrenByPath[currentPath] = mergeEntries(childrenByPath[currentPath] ?? [], input.currentEntries);
  return { rootEntries: [rootEntry], childrenByPath };
}

export function fileTreeDoubleClickAction(entry: FileTreeEntry): FileTreeDoubleClickAction {
  return entry.kind === "directory" ? "ignore-directory" : "select-file";
}

export function fileTreeClickAction(entry: FileTreeEntry, clickDetail = 1): FileTreeClickAction {
  void clickDetail;
  return entry.kind === "directory" ? "toggle-directory" : "select-file";
}

export function isRenderableFilePreview(preview: FilePreviewResult | undefined): boolean {
  return preview?.content.kind === "text" || preview?.content.kind === "image";
}

export function shouldShowFilePreviewRegion(input: FilePreviewRegionInput): boolean {
  const selectedPath = normalizePreviewPath(input.selectedPath);
  const previewPath = normalizePreviewPath(input.previewPath);
  const resultPath = normalizePreviewPath(input.preview?.path ?? "");
  return Boolean(
    selectedPath &&
      previewPath &&
      selectedPath === previewPath &&
      resultPath === previewPath &&
      isRenderableFilePreview(input.preview),
  );
}

export function filesTreeInitialFocusPlan(input: {
  rootPath: string;
  focusPath: string;
  collapsedPaths?: ReadonlySet<string>;
}): FileTreeInitialFocusPlan {
  const rootPath = normalizeTreePath(input.rootPath);
  const focusPath = normalizeTreePath(input.focusPath);
  const collapsedPaths = normalizePathSet(input.collapsedPaths ?? new Set());
  const expandedCandidates = [...ancestorPaths(focusPath), focusPath].map(normalizeTreePath);
  return {
    rootPath,
    focusPath,
    expandPaths: [...new Set(expandedCandidates)]
      .filter((path) => (path === rootPath || descendsFrom(path, rootPath)) && !collapsedPaths.has(path)),
  };
}

export function filesTreeStickyAncestors<TEntry extends FileTreeEntry>(input: {
  rows: readonly FileTreeRow<TEntry>[];
  firstVisiblePath: string;
  maxLevels: number;
  enabled?: boolean;
}): FileTreeRow<TEntry>[] {
  if (input.enabled === false) return [];
  const maxLevels = clampStickyLevels(input.maxLevels);
  const visibleIndex = input.rows.findIndex((row) => row.entry.path === input.firstVisiblePath);
  if (visibleIndex < 0) return [];
  const visibleDepth = input.rows[visibleIndex]?.depth ?? 0;
  if (visibleDepth <= 0) return [];

  const ancestors: FileTreeRow<TEntry>[] = [];
  for (let index = visibleIndex - 1; index >= 0; index -= 1) {
    const row = input.rows[index];
    if (!row || row.depth >= visibleDepth) continue;
    if (ancestors.some((ancestor) => ancestor.depth === row.depth)) continue;
    ancestors.push(row);
    if (row.depth === 0) break;
  }
  return ancestors.reverse().slice(-maxLevels);
}

export function normalizeFilesTreeStickySettings(input: FileTreeStickySettings): { enabled: boolean; maxLevels: number } {
  return {
    enabled: input.enabled ?? true,
    maxLevels: clampStickyLevels(input.maxLevels ?? 3),
  };
}

function appendEntryRows<TEntry extends FileTreeEntry>(
  entry: TEntry,
  depth: number,
  input: FileTreeRowsInput<TEntry>,
  rows: FileTreeRow<TEntry>[],
  visiting: Set<string>,
) {
  const normalizedPath = normalizeTreePath(entry.path);
  const expanded = input.expandedPaths.has(normalizedPath);
  rows.push({
    entry,
    depth,
    expanded,
    loading: input.loadingPaths.has(normalizedPath),
    error: input.errorByPath.get(normalizedPath) ?? null,
  });

  if (entry.kind !== "directory" || !expanded || visiting.has(normalizedPath)) {
    return;
  }

  visiting.add(normalizedPath);
  const children = input.childrenByPath[normalizedPath] ?? [];
  for (const child of children) {
    appendEntryRows(child, depth + 1, input, rows, visiting);
  }
  visiting.delete(normalizedPath);
}

function ancestorPaths(path: string): string[] {
  const normalized = normalizeTreePath(path);
  if (normalized === "/") return ["/"];
  if (isWindowsDrivePath(normalized)) {
    const drive = normalized.slice(0, 3);
    const parts = normalized.slice(3).split("/").filter(Boolean);
    const ancestors = ["/", drive];
    for (let index = 0; index < parts.length - 1; index += 1) {
      const parent = ancestors.at(-1) ?? drive;
      ancestors.push(`${parent.replace(/\/$/, "")}/${parts[index]}`);
    }
    return ancestors;
  }
  const parts = normalized.split("/").filter(Boolean);
  const ancestors = normalized.startsWith("/") ? ["/"] : [];
  for (let index = 0; index < parts.length - 1; index += 1) {
    const parent = ancestors.at(-1) ?? "";
    ancestors.push(parent === "/" || parent === "" ? `${parent}${parts[index]}` : `${parent}/${parts[index]}`);
  }
  return ancestors;
}

function ancestorPathChain(rootPath: string, currentPath: string): string[] {
  const root = normalizeTreePath(rootPath);
  const current = normalizeTreePath(currentPath);
  if (root === current) return [root];
  const ancestors = [...ancestorPaths(current), current]
    .map(normalizeTreePath)
    .filter((path) => path === root || descendsFrom(path, root));
  if (!ancestors.includes(root)) ancestors.unshift(root);
  return ancestors;
}

function cloneChildren<TEntry extends FileTreeEntry>(childrenByPath: Readonly<Record<string, readonly TEntry[]>>) {
  return Object.fromEntries(Object.entries(childrenByPath).map(([path, children]) => [normalizeTreePath(path), [...children]])) as Record<string, TEntry[]>;
}

function normalizePathSet(paths: ReadonlySet<string>): Set<string> {
  return new Set([...paths].map(normalizeTreePath));
}

function normalizePathMap(values: ReadonlyMap<string, string>): Map<string, string> {
  return new Map([...values].map(([path, value]) => [normalizeTreePath(path), value]));
}

function mergeEntries<TEntry extends FileTreeEntry>(existing: readonly TEntry[], additions: readonly TEntry[]) {
  const merged = [...existing];
  const seen = new Set(merged.map((entry) => normalizeTreePath(entry.path)));
  for (const entry of additions) {
    const normalizedPath = normalizeTreePath(entry.path);
    if (seen.has(normalizedPath)) continue;
    seen.add(normalizedPath);
    merged.push(entry);
  }
  return merged;
}

function syntheticDirectoryEntry<TEntry extends FileTreeEntry>(path: string): TEntry {
  const normalized = normalizeTreePath(path);
  return {
    name: treePathName(normalized),
    path: normalized,
    kind: "directory",
    size: null,
    modified_unix_ms: null,
    permissions: null,
    owner: null,
    group: null,
    symlink_target: null,
  } as TEntry;
}

function treePathName(path: string): string {
  if (path === "/") return "/";
  const trimmed = path.replace(/[\\/]+$/, "");
  const slashIndex = trimmed.lastIndexOf("/");
  const backslashIndex = trimmed.lastIndexOf("\\");
  const index = Math.max(slashIndex, backslashIndex);
  return index < 0 ? trimmed : trimmed.slice(index + 1) || trimmed;
}

function normalizeTreePath(value: string): string {
  const withForwardSlashes = value.replace(/\\/g, "/");
  if (/^[A-Za-z]:\/?$/.test(withForwardSlashes)) return `${withForwardSlashes.slice(0, 2)}/`;
  return withForwardSlashes.replace(/\/+$/, "") || "/";
}

function descendsFrom(path: string, root: string): boolean {
  if (path === root) return true;
  const normalizedRoot = normalizeTreePath(root);
  const normalizedPath = normalizeTreePath(path);
  if (normalizedRoot === "/") return normalizedPath.startsWith("/") || isWindowsDrivePath(normalizedPath);
  const rootPrefix = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
  return normalizedPath.startsWith(rootPrefix);
}

function isWindowsDrivePath(value: string): boolean {
  return /^[A-Za-z]:\//.test(value);
}

function clampStickyLevels(value: number): number {
  if (!Number.isFinite(value)) return 3;
  return Math.min(5, Math.max(1, Math.trunc(value)));
}

function normalizePreviewPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}
