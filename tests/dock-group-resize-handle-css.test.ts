/*
Feature: Workspace Dock resize handles.
Operation: Inspect the main workspace stylesheet for Dock split resize handle rules.
Expected: Dock split handles expose column and row resize cursors for row and column split boundaries.
*/
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pageUrl = new URL("../src/routes/+page.svelte", import.meta.url);

describe("Workspace Dock resize handle CSS", () => {
  it("styles row and column Dock split handles as resizable boundaries", async () => {
    const source = await readFile(pageUrl, "utf8");

    assert.match(source, /\.workspace-dock-resizer\.row\s*\{[^}]*cursor:\s*col-resize;/s);
    assert.match(source, /\.workspace-dock-resizer\.column\s*\{[^}]*cursor:\s*row-resize;/s);
  });
});
