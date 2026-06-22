/*
 * Test content:
 *
 * Feature:
 * Verifies the Port Forwarding table model for endpoint display, direction
 * labels, two-key sorting through TanStack table-core, and Host-scoped draft
 * retention.
 *
 * Operation:
 * Builds several table rows, applies primary and secondary sort keys, formats
 * IPv4/IPv6 endpoints, toggles header sorting state, and stores draft rows in
 * separate Host runtimes.
 *
 * Expected:
 * Endpoint display uses host:port with IPv6 brackets, direction display is
 * arrow-only, sorting honors at most two user-selected keys while keeping the
 * blank draft row at the bottom, and draft edits are retained independently per
 * Host until cleared.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  createDraftStore,
  clearPortForwardSort,
  connectionCellText,
  portForwardColumns,
  directionLabel,
  formatEndpoint,
  nextPortForwardSorting,
  setPortForwardSecondarySort,
  setPortForwardSortDirection,
  sortPortForwardRows,
  type PortForwardTableRow,
} from "../src/lib/ports/table";

describe("Port Forwarding table model", () => {
  it("formats endpoints and directions for local-left remote-right display", () => {
    assert.equal(formatEndpoint({ address: "127.0.0.1", port: 15432 }), "127.0.0.1:15432");
    assert.equal(formatEndpoint({ address: "::1", port: 8080 }), "[::1]:8080");
    assert.equal(directionLabel("local_to_remote"), "->");
    assert.equal(directionLabel("remote_to_local"), "<-");
    assert.equal(portForwardColumns.find((column) => column.id === "direction")?.header, "");
  });

  it("sorts with primary and secondary keys while keeping draft at the bottom", () => {
    const rows = [
      row("b", "Beta", "running", 2, "127.0.0.1", 9000),
      row("a", "Alpha", "running", 2, "127.0.0.1", 8000),
      row("c", "Cache", "failed", 0, "127.0.0.1", 7000),
      { ...row("draft", "", "stopped", 0, "127.0.0.1", 0), draft: true },
    ];

    const sorted = sortPortForwardRows(rows, [
      { key: "connections", desc: true },
      { key: "local", desc: false },
    ]);

    assert.deepEqual(sorted.map((item) => item.id), ["a", "b", "c", "draft"]);
  });

  it("shows failed errors before warnings and ignores stale errors for transient states", () => {
    assert.equal(connectionCellText({
      ...row("error", "Broken", "failed", 0, "127.0.0.1", 9001),
      error: "port in use",
      warning: "port was assigned but could not be saved",
    }), "port in use");
    assert.equal(connectionCellText({
      ...row("warning", "Dynamic", "running", 3, "127.0.0.1", 0),
      warning: "port was assigned but could not be saved",
    }), "port was assigned but could not be saved");
    assert.equal(connectionCellText(row("running", "Stable", "running", 3, "127.0.0.1", 9002)), "3");
    assert.equal(connectionCellText({
      ...row("starting", "Starting", "starting", 0, "127.0.0.1", 9003),
      error: "auth prompt pending",
    }), "starting");
    assert.equal(connectionCellText({
      ...row("reconnecting", "Retrying", "reconnecting", 0, "127.0.0.1", 9004),
      error: "reconnect scheduled after failure",
    }), "reconnecting");
  });

  it("updates header sorting with one primary and one secondary key", () => {
    assert.deepEqual(nextPortForwardSorting([], "name", false), [{ key: "name", desc: false }]);
    assert.deepEqual(nextPortForwardSorting([{ key: "name", desc: false }], "name", false), [
      { key: "name", desc: true },
    ]);
    assert.deepEqual(
      nextPortForwardSorting([
        { key: "name", desc: false },
        { key: "local", desc: false },
      ], "remote", true),
      [
        { key: "name", desc: false },
        { key: "remote", desc: false },
      ],
    );
  });

  it("applies header menu sort commands", () => {
    assert.deepEqual(setPortForwardSortDirection([{ key: "name", desc: false }], "local", true), [
      { key: "local", desc: true },
      { key: "name", desc: false },
    ]);
    assert.deepEqual(setPortForwardSecondarySort([{ key: "name", desc: false }], "remote"), [
      { key: "name", desc: false },
      { key: "remote", desc: false },
    ]);
    assert.deepEqual(clearPortForwardSort([
      { key: "name", desc: false },
      { key: "remote", desc: true },
    ], "name"), [{ key: "remote", desc: true }]);
  });

  it("retains draft rows per Host runtime until cleared", () => {
    const store = createDraftStore();
    const hostA = { ...row("draft-a", "Postgres", "stopped", 0, "127.0.0.1", 15432), draft: true };
    const hostB = { ...row("draft-b", "Redis", "stopped", 0, "127.0.0.1", 16379), draft: true };

    store.set("host-a", hostA);
    store.set("host-b", hostB);

    assert.equal(store.get("host-a")?.name, "Postgres");
    assert.equal(store.get("host-b")?.name, "Redis");
    store.clear("host-a");
    assert.equal(store.get("host-a"), null);
    assert.equal(store.get("host-b")?.name, "Redis");
  });
});

function row(
  id: string,
  name: string,
  status: PortForwardTableRow["status"],
  activeConnections: number,
  localAddress: string,
  localPort: number,
): PortForwardTableRow {
  return {
    id,
    name,
    direction: "local_to_remote",
    local: { address: localAddress, port: localPort },
    remote: { address: "db.internal", port: 5432 },
    status,
    activeConnections,
    error: status === "failed" ? "port in use" : null,
    warning: null,
    persistence: "just_this_time",
    draft: false,
  };
}
