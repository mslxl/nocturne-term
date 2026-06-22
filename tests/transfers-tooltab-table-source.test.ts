/*
 * Test content:
 *
 * Feature:
 * Verifies that the Transfers ToolTab is implemented as a TanStack Table-backed
 * transfer queue with clear native table semantics.
 *
 * Operation:
 * Reads the TransfersToolTab Svelte source and checks that it imports TanStack
 * Table primitives, builds a core row model, and renders a real table with
 * header, body, row, and cell roles/test hooks for the queue.
 *
 * Expected:
 * Transfers uses TanStack Table for row/column modeling and exposes an obvious
 * table UI instead of a card list, so source, destination, progress, status,
 * and actions are presented in aligned columns.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Transfers ToolTab table source", () => {
  it("uses TanStack Table and renders an explicit transfer queue table", () => {
    const source = readFileSync(resolve("src/lib/transfers/TransfersToolTab.svelte"), "utf8");

    expect(source).toContain("@tanstack/table-core");
    expect(source).toMatch(/\bcreateTable\b/);
    expect(source).toMatch(/\bgetCoreRowModel\b/);
    expect(source).toContain('data-testid="transfers-table"');
    expect(source).toContain("<table");
    expect(source).toContain("<thead");
    expect(source).toContain("<tbody");
    expect(source).toContain("Status");
    expect(source).toContain("Source");
    expect(source).toContain("Destination");
    expect(source).toContain("Progress");
    expect(source).toContain("Actions");
  });
});
