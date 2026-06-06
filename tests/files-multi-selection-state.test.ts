/*
 * Test content:
 *
 * Feature:
 * Files ToolTab multi-selection business state.
 *
 * Operation:
 * Applies single-click, Ctrl/Cmd toggle, Shift range selection, row context
 * menu targeting, and marquee selection operations against visible file paths.
 *
 * Expected:
 * The selected path set, active preview path, and range anchor follow native
 * file-list semantics so Tree, Columns, owner views, and mirror views can share
 * the same business selection state while keeping drag rectangle UI local.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  emptyFilesSelection,
  selectFilesContextTarget,
  selectFilesEntry,
  selectFilesMarquee,
} from "../src/lib/files/selection";

describe("Files multi-selection state", () => {
  const visiblePaths = ["/repo/a.txt", "/repo/b.txt", "/repo/c.txt", "/repo/d.txt", "/repo/e.txt"];

  it("selects one entry and uses it as active preview path and range anchor", () => {
    const state = selectFilesEntry(emptyFilesSelection(), { path: "/repo/b.txt", visiblePaths });

    assert.deepEqual(state, {
      selectedPaths: ["/repo/b.txt"],
      activePath: "/repo/b.txt",
      anchorPath: "/repo/b.txt",
    });
  });

  it("toggles entries with Ctrl or Cmd without discarding the existing selected paths", () => {
    const first = selectFilesEntry(emptyFilesSelection(), { path: "/repo/b.txt", visiblePaths });
    const second = selectFilesEntry(first, { path: "/repo/d.txt", visiblePaths, ctrlKey: true });
    const third = selectFilesEntry(second, { path: "/repo/b.txt", visiblePaths, metaKey: true });

    assert.deepEqual(second.selectedPaths, ["/repo/b.txt", "/repo/d.txt"]);
    assert.equal(second.activePath, "/repo/d.txt");
    assert.deepEqual(third.selectedPaths, ["/repo/d.txt"]);
    assert.equal(third.activePath, "/repo/b.txt");
  });

  it("selects a visible range from the existing anchor through the Shift-click target", () => {
    const first = selectFilesEntry(emptyFilesSelection(), { path: "/repo/b.txt", visiblePaths });
    const range = selectFilesEntry(first, { path: "/repo/e.txt", visiblePaths, shiftKey: true });

    assert.deepEqual(range.selectedPaths, ["/repo/b.txt", "/repo/c.txt", "/repo/d.txt", "/repo/e.txt"]);
    assert.equal(range.activePath, "/repo/e.txt");
    assert.equal(range.anchorPath, "/repo/b.txt");
  });

  it("preserves a multi-selection when the context menu opens on an already selected row", () => {
    const state = {
      selectedPaths: ["/repo/b.txt", "/repo/d.txt"],
      activePath: "/repo/d.txt",
      anchorPath: "/repo/b.txt",
    };

    assert.strictEqual(selectFilesContextTarget(state, "/repo/b.txt"), state);
  });

  it("selects only the target row when the context menu opens on an unselected row", () => {
    const state = {
      selectedPaths: ["/repo/b.txt", "/repo/d.txt"],
      activePath: "/repo/d.txt",
      anchorPath: "/repo/b.txt",
    };

    assert.deepEqual(selectFilesContextTarget(state, "/repo/c.txt"), {
      selectedPaths: ["/repo/c.txt"],
      activePath: "/repo/c.txt",
      anchorPath: "/repo/c.txt",
    });
  });

  it("uses marquee-selected paths as the shared selection while keeping empty drags from clearing selection", () => {
    const state = selectFilesEntry(emptyFilesSelection(), { path: "/repo/a.txt", visiblePaths });
    const marquee = selectFilesMarquee(state, ["/repo/c.txt", "/repo/d.txt", "/repo/c.txt"]);

    assert.deepEqual(marquee.selectedPaths, ["/repo/c.txt", "/repo/d.txt"]);
    assert.equal(marquee.activePath, "/repo/d.txt");
    assert.equal(marquee.anchorPath, "/repo/c.txt");
    assert.strictEqual(selectFilesMarquee(marquee, []), marquee);
  });
});
