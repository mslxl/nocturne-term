import {
  createTable,
  getCoreRowModel,
  getSortedRowModel,
  type ColumnDef,
  type Row,
  type SortingState,
} from "@tanstack/table-core";

export type PortForwardDirection = "local_to_remote" | "remote_to_local";
export type PortForwardStatus = "stopped" | "starting" | "running" | "reconnecting" | "failed" | "needs_confirmation";
export type PortForwardPersistence = "just_this_time" | "saved";

export type PortForwardEndpoint = {
  address: string;
  port: number;
};

export type PortForwardTableRow = {
  id: string;
  name: string;
  direction: PortForwardDirection;
  local: PortForwardEndpoint;
  remote: PortForwardEndpoint;
  status: PortForwardStatus;
  activeConnections: number;
  error: string | null;
  warning: string | null;
  persistence: PortForwardPersistence;
  draft: boolean;
};

export type PortForwardSortKey = "connections" | "name" | "local" | "direction" | "remote";

export type PortForwardSortRule = {
  key: PortForwardSortKey;
  desc: boolean;
};

export const portForwardColumns: ColumnDef<PortForwardTableRow>[] = [
  column("connections", "Connections", (row) => connectionsSortValue(row)),
  column("name", "Name", (row) => row.name),
  column("local", "Local", (row) => endpointSortValue(row.local)),
  column("direction", "", (row) => directionLabel(row.direction)),
  column("remote", "Remote", (row) => endpointSortValue(row.remote)),
  column("actions", "Actions", (row) => row.id),
];

export function sortPortForwardRows(rows: PortForwardTableRow[], sorting: readonly PortForwardSortRule[]): PortForwardTableRow[] {
  const draftRows = rows.filter((row) => row.draft);
  const dataRows = rows.filter((row) => !row.draft);
  const instance = createTable<PortForwardTableRow>({
    data: dataRows,
    columns: portForwardColumns,
    state: {
      sorting: sorting.map(toTanstackSort),
    },
    onStateChange: () => {},
    renderFallbackValue: null,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  return [...instance.getRowModel().rows.map((row) => row.original), ...draftRows];
}

export function nextPortForwardSorting(
  current: readonly PortForwardSortRule[],
  key: PortForwardSortKey,
  secondary: boolean,
): PortForwardSortRule[] {
  const existing = current.find((rule) => rule.key === key);
  const nextRule = existing ? { key, desc: !existing.desc } : { key, desc: false };
  if (!secondary) {
    return [nextRule];
  }
  const primary = current.find((rule) => rule.key !== key) ?? null;
  return primary ? [primary, nextRule] : [nextRule];
}

export function setPortForwardSortDirection(
  current: readonly PortForwardSortRule[],
  key: PortForwardSortKey,
  desc: boolean,
): PortForwardSortRule[] {
  const existing = current.filter((rule) => rule.key !== key);
  return [{ key, desc }, ...existing].slice(0, 2);
}

export function setPortForwardSecondarySort(
  current: readonly PortForwardSortRule[],
  key: PortForwardSortKey,
): PortForwardSortRule[] {
  const existingPrimary = current.find((rule) => rule.key !== key) ?? null;
  const existing = current.find((rule) => rule.key === key);
  const secondary = existing ? { ...existing } : { key, desc: false };
  return existingPrimary ? [existingPrimary, secondary] : [secondary];
}

export function clearPortForwardSort(
  current: readonly PortForwardSortRule[],
  key: PortForwardSortKey,
): PortForwardSortRule[] {
  return current.filter((rule) => rule.key !== key);
}

export function formatEndpoint(endpoint: PortForwardEndpoint): string {
  const address = endpoint.address.includes(":") && !endpoint.address.startsWith("[")
    ? `[${endpoint.address}]`
    : endpoint.address;
  return `${address}:${endpoint.port}`;
}

export function directionLabel(direction: PortForwardDirection): "->" | "<-" {
  return direction === "local_to_remote" ? "->" : "<-";
}

export function connectionCellText(row: PortForwardTableRow): string {
  if (row.status === "failed" && row.error) return row.error;
  if (row.warning) return row.warning;
  if (row.status === "running") return String(row.activeConnections);
  return row.status.replaceAll("_", " ");
}

export function createDraftStore() {
  const drafts = new Map<string, PortForwardTableRow>();
  return {
    get(hostId: string): PortForwardTableRow | null {
      return drafts.get(hostId) ?? null;
    },
    set(hostId: string, draft: PortForwardTableRow) {
      if (!hostId.trim()) throw new Error("host id cannot be empty");
      if (!draft.draft) throw new Error("port forward draft row must be marked as draft");
      drafts.set(hostId, draft);
    },
    clear(hostId: string) {
      drafts.delete(hostId);
    },
  };
}

function column(
  id: string,
  header: string,
  accessorFn: (row: PortForwardTableRow) => string | number,
): ColumnDef<PortForwardTableRow> {
  return {
    id,
    header,
    accessorFn,
    sortingFn: (left: Row<PortForwardTableRow>, right: Row<PortForwardTableRow>, columnId: string) => {
      const leftValue = left.getValue<string | number>(columnId);
      const rightValue = right.getValue<string | number>(columnId);
      if (typeof leftValue === "number" && typeof rightValue === "number") {
        return leftValue - rightValue;
      }
      return String(leftValue).localeCompare(String(rightValue), undefined, { numeric: true, sensitivity: "base" });
    },
  };
}

function toTanstackSort(rule: PortForwardSortRule): SortingState[number] {
  return {
    id: rule.key,
    desc: rule.desc,
  };
}

function connectionsSortValue(row: PortForwardTableRow): number {
  if (row.status === "running") return 3000 + row.activeConnections;
  if (row.status === "starting") return 2000;
  if (row.status === "reconnecting") return 1900;
  if (row.status === "needs_confirmation") return 1800;
  if (row.status === "failed") return 1000;
  return 0;
}

function endpointSortValue(endpoint: PortForwardEndpoint): string {
  return `${endpoint.address}:${endpoint.port.toString().padStart(5, "0")}`;
}
