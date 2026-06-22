export type FilesColumnEntry = {
  kind: string;
  name: string;
  path: string;
  size?: string | null;
};

export type FilesColumnViewEntry<TEntry extends FilesColumnEntry> = TEntry & {
  selected: boolean;
  synthetic?: boolean;
};

export type FilesColumnView<TEntry extends FilesColumnEntry> = {
  path: string;
  title: string;
  entries: FilesColumnViewEntry<TEntry>[];
};

export function columnsForPath(value: string): string[] {
  if (!value || value === "~") return [value || "~"];
  const normalized = value.replace(/\\/g, "/");
  if (normalized === "/") return ["/"];
  if (/^[A-Za-z]:\//.test(normalized)) {
    const drive = normalized.slice(0, 2);
    const parts = normalized.slice(3).split("/").filter(Boolean);
    const columns = [drive];
    for (const part of parts) {
      columns.push(`${columns[columns.length - 1].replace(/\/$/, "")}/${part}`);
    }
    return columns;
  }
  const parts = normalized.split("/").filter(Boolean);
  const columns = normalized.startsWith("/") ? ["/"] : [];
  for (const part of parts) {
    const parent = columns[columns.length - 1] ?? "";
    columns.push(parent === "/" || parent === "" ? `${parent}${part}` : `${parent}/${part}`);
  }
  return columns.length ? columns : [value];
}

export function basename(value: string): string {
  const slashIndex = value.lastIndexOf("/");
  const backslashIndex = value.lastIndexOf("\\");
  const index = Math.max(slashIndex, backslashIndex);
  return index < 0 ? value : value.slice(index + 1);
}

export function buildFilesColumnsView<TEntry extends FilesColumnEntry>(input: {
  rootPath?: string;
  currentPath: string;
  selectedPath: string;
  activeEntries: readonly TEntry[];
  childrenByPath?: Readonly<Record<string, readonly TEntry[]>>;
}): FilesColumnView<TEntry>[] {
  const columns: FilesColumnView<TEntry>[] = [];
  const rootPath = normalizeColumnPath(input.rootPath || input.currentPath);
  const currentPath = normalizeColumnPath(input.currentPath || rootPath);
  const selectedPath = normalizeColumnPath(input.selectedPath || currentPath);
  const childrenByPath = normalizeChildrenByPath(input.childrenByPath ?? {});
  const focusChain = rootPath === currentPath ? [currentPath] : pathChainFromRoot(rootPath, currentPath);
  const initialColumns = focusChain.length ? focusChain : [currentPath];

  for (let index = 0; index < initialColumns.length; index += 1) {
    const columnPath = initialColumns[index] ?? currentPath;
    const nextPath = initialColumns[index + 1];
    const baseEntries = index === initialColumns.length - 1 ? input.activeEntries : childrenByPath[columnPath] ?? [];
    const columnEntries = nextPath ? mergeColumnEntries(baseEntries, [syntheticDirectoryEntry<TEntry>(nextPath)]) : baseEntries;
    columns.push(columnView(columnPath, columnEntries, selectedPath || currentPath));
  }

  let columnEntries = columns.at(-1)?.entries ?? [];

  while (true) {
    const selectedDirectory = columnEntries.find(
      (entry) => entry.kind === "directory" && (sameColumnPath(entry.path, selectedPath) || selectedPathDescendsFrom(selectedPath, entry.path)),
    );
    if (!selectedDirectory) break;
    const childEntries = childrenByPath[normalizeColumnPath(selectedDirectory.path)];
    const columnPath = selectedDirectory.path;
    columnEntries = (childEntries ?? []).map((entry) => ({
      ...entry,
      selected: sameColumnPath(entry.path, selectedPath) || selectedPathDescendsFrom(selectedPath, entry.path),
    }));
    if (!childEntries) {
      columns.push({
        path: columnPath,
        title: basename(columnPath) || columnPath,
        entries: [],
      });
      break;
    }
    columns.push(columnView(columnPath, childEntries, selectedPath));
  }

  return columns;
}

export function columnsForVisiblePane<TEntry extends FilesColumnEntry>(
  columns: readonly FilesColumnView<TEntry>[],
  _options: { previewVisible: boolean },
): FilesColumnView<TEntry>[] {
  return [...columns];
}

function selectedPathDescendsFrom(selectedPath: string, directoryPath: string): boolean {
  const selected = normalizeColumnPath(selectedPath);
  const directory = normalizeColumnPath(directoryPath);
  if (!selected || !directory || selected === directory) return false;
  if (directory === "/") return selected.startsWith("/");
  return selected.startsWith(`${directory}/`);
}

function sameColumnPath(left: string, right: string): boolean {
  return normalizeColumnPath(left) === normalizeColumnPath(right);
}

function columnView<TEntry extends FilesColumnEntry>(
  path: string,
  entries: readonly TEntry[],
  selectedPath: string,
): FilesColumnView<TEntry> {
  return {
    path,
    title: basename(path) || path,
    entries: entries.map((entry) => ({
      ...entry,
      selected: sameColumnPath(entry.path, selectedPath) || selectedPathDescendsFrom(selectedPath, entry.path),
    })),
  };
}

function pathChainFromRoot(rootPath: string, currentPath: string): string[] {
  const root = normalizeColumnPath(rootPath);
  const current = normalizeColumnPath(currentPath);
  const chain = columnsForPath(current).map(normalizeColumnPath);
  if (root === "/" && isWindowsDrivePath(current)) return [root, ...chain];
  const rootIndex = chain.findIndex((path) => path === root);
  if (rootIndex >= 0) return chain.slice(rootIndex);
  return [root, current];
}

function isWindowsDrivePath(value: string): boolean {
  return /^[A-Za-z]:(?:\/|$)/.test(value);
}

function syntheticDirectoryEntry<TEntry extends FilesColumnEntry>(path: string): TEntry {
  return {
    kind: "directory",
    name: basename(path) || path,
    path,
    size: null,
  } as TEntry;
}

function mergeColumnEntries<TEntry extends FilesColumnEntry>(existing: readonly TEntry[], additions: readonly TEntry[]) {
  const merged = [...existing];
  const seen = new Set(merged.map((entry) => normalizeColumnPath(entry.path)));
  for (const entry of additions) {
    const normalizedPath = normalizeColumnPath(entry.path);
    if (seen.has(normalizedPath)) continue;
    seen.add(normalizedPath);
    merged.push(entry);
  }
  return merged;
}

function normalizeChildrenByPath<TEntry extends FilesColumnEntry>(childrenByPath: Readonly<Record<string, readonly TEntry[]>>) {
  return Object.fromEntries(Object.entries(childrenByPath).map(([path, entries]) => [normalizeColumnPath(path), entries])) as Record<string, readonly TEntry[]>;
}

function normalizeColumnPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (/^[A-Za-z]:\/?$/.test(normalized)) return normalized.slice(0, 2);
  return normalized.replace(/\/+$/, "") || "/";
}
