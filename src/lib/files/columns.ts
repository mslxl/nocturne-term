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
  currentPath: string;
  selectedPath: string;
  activeEntries: readonly TEntry[];
  childrenByPath?: Readonly<Record<string, readonly TEntry[]>>;
}): FilesColumnView<TEntry>[] {
  const columns: FilesColumnView<TEntry>[] = [];
  let columnPath = input.currentPath;
  let columnEntries: readonly TEntry[] = input.activeEntries;

  while (true) {
    columns.push({
      path: columnPath,
      title: basename(columnPath) || columnPath,
      entries: columnEntries.map((entry) => ({
        ...entry,
        selected: entry.path === input.selectedPath || selectedPathDescendsFrom(input.selectedPath, entry.path),
      })),
    });

    const selectedDirectory = columnEntries.find(
      (entry) => entry.kind === "directory" && (entry.path === input.selectedPath || selectedPathDescendsFrom(input.selectedPath, entry.path)),
    );
    if (!selectedDirectory) break;
    const childEntries = input.childrenByPath?.[selectedDirectory.path];
    columnPath = selectedDirectory.path;
    columnEntries = childEntries ?? [];
    if (!childEntries) {
      columns.push({
        path: columnPath,
        title: basename(columnPath) || columnPath,
        entries: [],
      });
      break;
    }
  }

  return columns.slice(-3);
}

export function columnsForVisiblePane<TEntry extends FilesColumnEntry>(
  columns: readonly FilesColumnView<TEntry>[],
  options: { previewVisible: boolean },
): FilesColumnView<TEntry>[] {
  return options.previewVisible ? columns.slice(-2) : [...columns];
}

function selectedPathDescendsFrom(selectedPath: string, directoryPath: string): boolean {
  if (!selectedPath) return false;
  return selectedPath.startsWith(`${directoryPath.replace(/[\\/]+$/, "")}/`) || selectedPath.startsWith(`${directoryPath.replace(/[\\/]+$/, "")}\\`);
}
