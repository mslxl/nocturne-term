import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  countPaneLeaves,
  createPaneLeaf,
  clonePaneTree,
  deriveCustomizableTabTitle,
  deriveTabDisplayTitle,
  layoutPaneTree,
  listPaneIds,
  paneItemsForTree,
  normalizeRatios,
  removePane,
  resizeAdjacentPanes,
  movePaneIntoSplit,
  splitPane,
  swapPanes,
  type PaneTree,
} from "./panes";

describe("pane tree", () => {
  it("creates a root leaf and counts panes", () => {
    const tree = createPaneLeaf("pane-1");

    assert.equal(countPaneLeaves(tree), 1);
    assert.deepEqual(listPaneIds(tree), ["pane-1"]);
  });

  it("returns pane items in the visible tree order only", () => {
    const splitTree = splitPane(createPaneLeaf("pane-1"), "pane-1", "pane-2", "right");
    const zoomTree = createPaneLeaf("pane-2");
    const items = [
      { id: "pane-1", title: "left" },
      { id: "pane-2", title: "right" },
    ];

    assert.deepEqual(paneItemsForTree(splitTree, items).map((item) => item.id), ["pane-1", "pane-2"]);
    assert.deepEqual(paneItemsForTree(zoomTree, items), [{ id: "pane-2", title: "right" }]);
  });

  it("rejects visible tree panes that are missing from pane items", () => {
    assert.throws(
      () => paneItemsForTree(createPaneLeaf("pane-2"), [{ id: "pane-1" }]),
      /pane item pane-2 not found/,
    );
  });

  it("clones pane trees without sharing nested arrays", () => {
    const tree = splitPane(createPaneLeaf("pane-1"), "pane-1", "pane-2", "right");
    const cloned = clonePaneTree(tree);

    assert.deepEqual(cloned, tree);
    assert.notEqual(cloned, tree);
    assert.equal(cloned.kind, "split");
    assert.equal(tree.kind, "split");
    if (cloned.kind !== "split" || tree.kind !== "split") return;
    assert.notEqual(cloned.children, tree.children);
    assert.notEqual(cloned.ratios, tree.ratios);
  });

  it("splits right by creating a row split with the new pane after the target", () => {
    const tree = splitPane(createPaneLeaf("pane-1"), "pane-1", "pane-2", "right");

    assert.deepEqual(tree, {
      kind: "split",
      direction: "row",
      children: [
        { kind: "leaf", paneId: "pane-1" },
        { kind: "leaf", paneId: "pane-2" },
      ],
      ratios: [0.5, 0.5],
    });
  });

  it("splits down by creating a column split with the new pane after the target", () => {
    const tree = splitPane(createPaneLeaf("pane-1"), "pane-1", "pane-2", "down");

    assert.equal(tree.kind, "split");
    if (tree.kind !== "split") return;
    assert.equal(tree.direction, "column");
    assert.deepEqual(listPaneIds(tree), ["pane-1", "pane-2"]);
  });

  it("supports left and up insertion order", () => {
    const left = splitPane(createPaneLeaf("pane-1"), "pane-1", "pane-left", "left");
    const up = splitPane(createPaneLeaf("pane-1"), "pane-1", "pane-up", "up");

    assert.deepEqual(listPaneIds(left), ["pane-left", "pane-1"]);
    assert.deepEqual(listPaneIds(up), ["pane-up", "pane-1"]);
  });

  it("inserts matching-direction leaf splits into the existing split node", () => {
    const first = splitPane(createPaneLeaf("pane-1"), "pane-1", "pane-2", "right");
    const second = splitPane(first, "pane-2", "pane-3", "right");

    assert.equal(second.kind, "split");
    if (second.kind !== "split") return;
    assert.equal(second.direction, "row");
    assert.deepEqual(listPaneIds(second), ["pane-1", "pane-2", "pane-3"]);
    assert.deepEqual(second.ratios, [0.5, 0.25, 0.25]);
  });

  it("nests cross-direction splits under the target child", () => {
    const first = splitPane(createPaneLeaf("pane-1"), "pane-1", "pane-2", "right");
    const second = splitPane(first, "pane-2", "pane-3", "down");

    assert.equal(second.kind, "split");
    if (second.kind !== "split") return;
    assert.equal(second.direction, "row");
    assert.deepEqual(listPaneIds(second), ["pane-1", "pane-2", "pane-3"]);
    assert.equal(second.children[1]?.kind, "split");
  });

  it("removes panes and collapses split nodes with one child", () => {
    const initial = splitPane(createPaneLeaf("pane-1"), "pane-1", "pane-2", "right");
    const removed = removePane(initial, "pane-1");

    assert.deepEqual(removed, { kind: "leaf", paneId: "pane-2" });
  });

  it("normalizes ratios after removal", () => {
    const tree: PaneTree = {
      kind: "split",
      direction: "row",
      children: [
        { kind: "leaf", paneId: "pane-1" },
        { kind: "leaf", paneId: "pane-2" },
        { kind: "leaf", paneId: "pane-3" },
      ],
      ratios: [0.2, 0.3, 0.5],
    };
    const removed = removePane(tree, "pane-2");

    assert.equal(removed?.kind, "split");
    if (!removed || removed.kind !== "split") return;
    assertAlmostEqual(removed.ratios[0], 2 / 7);
    assertAlmostEqual(removed.ratios[1], 5 / 7);
  });

  it("derives tab display titles from active pane title and pane count", () => {
    assert.equal(deriveTabDisplayTitle("server", 1), "server");
    assert.equal(deriveTabDisplayTitle("server", 3), "server | 3 panes");
  });

  it("prefers a custom tab title until it is cleared", () => {
    assert.equal(deriveCustomizableTabTitle("Production", "server", 3), "Production");
    assert.equal(deriveCustomizableTabTitle("  ", "server", 3), "server | 3 panes");
  });

  it("rejects invalid ratios instead of silently fixing them", () => {
    assert.throws(() => normalizeRatios([1, 0]), /positive finite/);
    assert.throws(() => normalizeRatios([]), /cannot be empty/);
  });

  it("updates adjacent ratios while honoring minimum pane sizes", () => {
    const tree = splitPane(createPaneLeaf("pane-1"), "pane-1", "pane-2", "right");
    const resized = resizeAdjacentPanes({
      tree,
      firstPaneId: "pane-1",
      secondPaneId: "pane-2",
      deltaPixels: 250,
      containerPixels: 600,
      minFirstPixels: 160,
      minSecondPixels: 160,
    });

    assert.equal(resized.kind, "split");
    if (resized.kind !== "split") return;
    assert.deepEqual(resized.ratios, [440 / 600, 160 / 600]);
  });

  it("keeps resize calculations stable when repeated from the same base tree", () => {
    const base = splitPane(createPaneLeaf("pane-1"), "pane-1", "pane-2", "right");
    const first = resizeAdjacentPanes({
      tree: base,
      firstPaneId: "pane-1",
      secondPaneId: "pane-2",
      deltaPixels: 50,
      containerPixels: 600,
      minFirstPixels: 160,
      minSecondPixels: 160,
    });
    const second = resizeAdjacentPanes({
      tree: base,
      firstPaneId: "pane-1",
      secondPaneId: "pane-2",
      deltaPixels: 50,
      containerPixels: 600,
      minFirstPixels: 160,
      minSecondPixels: 160,
    });

    assert.deepEqual(second, first);
  });

  it("computes pane and splitter layout from ratios", () => {
    const tree = splitPane(createPaneLeaf("pane-1"), "pane-1", "pane-2", "right");
    const layout = layoutPaneTree(tree, { x: 0, y: 0, width: 405, height: 200 }, 5);

    assert.deepEqual(layout.panes, [
      { paneId: "pane-1", bounds: { x: 0, y: 0, width: 200, height: 200 } },
      { paneId: "pane-2", bounds: { x: 205, y: 0, width: 200, height: 200 } },
    ]);
    assert.deepEqual(layout.splitters, [
      {
        id: "pane-1:pane-2",
        direction: "row",
        firstPaneId: "pane-1",
        secondPaneId: "pane-2",
        bounds: { x: 200, y: 0, width: 5, height: 200 },
      },
    ]);
  });

  it("swaps pane positions without changing split structure", () => {
    const tree = splitPane(splitPane(createPaneLeaf("pane-1"), "pane-1", "pane-2", "right"), "pane-2", "pane-3", "down");
    const swapped = swapPanes(tree, "pane-1", "pane-3");

    assert.deepEqual(listPaneIds(swapped), ["pane-3", "pane-2", "pane-1"]);
    assert.equal(swapped.kind, "split");
    if (swapped.kind !== "split") return;
    assert.equal(swapped.direction, "row");
    assert.equal(swapped.children[1]?.kind, "split");
  });

  it("moves a pane into an edge split and collapses the source branch", () => {
    const tree = splitPane(splitPane(createPaneLeaf("pane-1"), "pane-1", "pane-2", "right"), "pane-2", "pane-3", "down");
    const moved = movePaneIntoSplit(tree, "pane-1", "pane-3", "right");

    assert.deepEqual(listPaneIds(moved), ["pane-2", "pane-3", "pane-1"]);
    assert.equal(moved.kind, "split");
    if (moved.kind !== "split") return;
    assert.equal(moved.direction, "column");
  });
});

function assertAlmostEqual(actual: number | undefined, expected: number) {
  if (typeof actual !== "number") {
    assert.fail(`expected a number, received ${actual}`);
  }
  assert.ok(Math.abs(actual - expected) < Number.EPSILON * 4, `${actual} should be close to ${expected}`);
}
