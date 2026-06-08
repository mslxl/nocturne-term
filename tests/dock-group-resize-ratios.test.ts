/*
Feature: Workspace Dock group resize ratios.
Operation: Resize the divider between adjacent Dock split children with horizontal and vertical pointer deltas.
Expected: The targeted split ratios update while preserving a normalized ratio total, respecting a minimum child size, and leaving unrelated nested splits unchanged.
*/
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resizeWorkspaceDockSplit } from "../src/lib/workspace/dock/resize";
import type { WorkspaceDockLayout } from "../src/lib/bindings";

describe("Workspace Dock group resize ratios", () => {
  it("updates adjacent root split ratios from a pointer delta", () => {
    const layout = split("row", [group("files"), group("terminal")], [0.25, 0.75]);
    const resized = resizeWorkspaceDockSplit({
      layout,
      splitPath: [],
      dividerIndex: 0,
      deltaPixels: 150,
      containerPixels: 1000,
      minChildPixels: 80,
    });

    assert.equal(resized.kind, "split");
    assert.deepEqual(resized.ratios.map((ratio) => Number(ratio?.toFixed(4))), [0.4, 0.6]);
  });

  it("clamps resize deltas to keep both groups usable", () => {
    const layout = split("row", [group("left"), group("right")], [0.5, 0.5]);
    const resized = resizeWorkspaceDockSplit({
      layout,
      splitPath: [],
      dividerIndex: 0,
      deltaPixels: -900,
      containerPixels: 1000,
      minChildPixels: 120,
    });

    assert.equal(resized.kind, "split");
    assert.deepEqual(resized.ratios.map((ratio) => Number(ratio?.toFixed(4))), [0.12, 0.88]);
  });

  it("resizes only the split addressed by the nested split path", () => {
    const layout = split("column", [
      group("top"),
      split("row", [group("bottom-left"), group("bottom-right")], [0.7, 0.3]),
    ], [0.6, 0.4]);
    const resized = resizeWorkspaceDockSplit({
      layout,
      splitPath: [1],
      dividerIndex: 0,
      deltaPixels: -100,
      containerPixels: 500,
      minChildPixels: 80,
    });

    assert.equal(resized.kind, "split");
    assert.deepEqual(resized.ratios, [0.6, 0.4]);
    const nested = resized.children[1];
    assert.equal(nested.kind, "split");
    assert.deepEqual(nested.ratios.map((ratio) => Number(ratio?.toFixed(4))), [0.5, 0.5]);
  });
});

function group(id: string): WorkspaceDockLayout {
  return {
    kind: "group",
    id,
    role: "content",
    slots: [{ kind: "closed_source", id: `${id}-slot`, previous_title: id, owner_workspace_title: "closed" }],
    active_slot_id: `${id}-slot`,
  };
}

function split(direction: "row" | "column", children: WorkspaceDockLayout[], ratios: number[]): WorkspaceDockLayout {
  return { kind: "split", direction, children, ratios };
}
