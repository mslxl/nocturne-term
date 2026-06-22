/*
 * Test content:
 *
 * Feature:
 * Verifies pure Dock workspace operations for splitting slots, creating
 * Workspace mirrors, creating floating-window mirror ToolTabs, closing owner
 * ToolTabs, closing floating mirror displays, and validating split ratios.
 *
 * Operation:
 * Builds in-memory Workspace snapshots, applies Dock operation helpers, and
 * inspects the resulting layouts, slots, active selections, floating windows,
 * and closed-source placeholders without launching a Tauri runtime.
 *
 * Expected:
 * Dock operations preserve ownership boundaries, floating a ToolTab creates a
 * mirror display while leaving the owner slot visible, duplicate mirrors focus
 * the existing slot, owner close replaces mirrors with closed-source
 * placeholders, closing a floating window removes only its mirror display,
 * explicit Dock group roles remain spatial instead of ToolTab-derived, and
 * invalid layout contracts fail fast.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  createDockGroup,
  createOwnedSlot,
  listDockSlots,
  normalizeDockRatios,
  validateWorkspaceSnapshot,
  type WorkspaceLayoutSnapshot,
} from "./model";
import {
  createMirrorInWorkspace,
  floatOwnedSlot,
  closeFloatingWindow,
  splitSlot,
  removeSlot,
  closeOwnerToolTab,
  type DockIdFactory,
} from "./operations";

describe("dock workspace operations", () => {
  it("validates a workspace snapshot with independent workspace layouts", () => {
    const snapshot = createSnapshot();

    validateWorkspaceSnapshot(snapshot);

    assert.deepEqual(snapshot.workspaces.map((workspace) => workspace.layout), [
      createDockGroup("group-a", "content", [createOwnedSlot("slot-files-a", "files-a")], "slot-files-a"),
      createDockGroup("group-b", "content", [createOwnedSlot("slot-files-b", "files-b")], "slot-files-b"),
    ]);
  });

  it("splits a slot into a new dock group", () => {
    const ids = sequenceIds();
    const layout = splitSlot(
      createDockGroup("group-a", "content", [createOwnedSlot("slot-files-a", "files-a")], "slot-files-a"),
      "slot-files-a",
      createOwnedSlot("slot-terminal-a", "terminal-a"),
      "right",
      ids,
    );

    assert.equal(layout.kind, "split");
    if (layout.kind !== "split") return;
    assert.equal(layout.direction, "row");
    assert.deepEqual(layout.ratios, [0.5, 0.5]);
    assert.deepEqual(listDockSlots(layout).map((slot) => slot.id), ["slot-files-a", "slot-terminal-a"]);
    assert.deepEqual(
      layout.children.map((child) => (child.kind === "group" ? child.role : "")),
      ["content", "content"],
    );
  });

  it("preserves an empty content group when its final slot is removed", () => {
    const result = removeSlot(
      createDockGroup("group-content", "content", [createOwnedSlot("slot-terminal", "terminal-a")], "slot-terminal"),
      "slot-terminal",
    );

    assert.equal(result.removed.id, "slot-terminal");
    assert.deepEqual(result.layout, createDockGroup("group-content", "content", [], ""));
  });

  it("creates one mirror per target workspace and focuses duplicates", () => {
    const ids = sequenceIds();
    const first = createMirrorInWorkspace(createSnapshot(), "files-a", "workspace-b", "group-b", ids);
    const second = createMirrorInWorkspace(first, "files-a", "workspace-b", "group-b", ids);
    const target = second.workspaces.find((workspace) => workspace.id === "workspace-b");
    if (!target || target.layout.kind !== "group") assert.fail("expected target dock group");

    const mirrors = target.layout.slots.filter((slot) => slot.kind === "mirror");

    assert.equal(mirrors.length, 1);
    assert.equal(target.layout.activeSlotId, mirrors[0]?.id);
  });

  it("floats an owned slot as a mirror without moving the owner slot", () => {
    const ids = sequenceIds();
    const floated = floatOwnedSlot(createSnapshot(), "workspace-a", "slot-files-a", "float-1", ids);
    const ownerWorkspace = floated.workspaces.find((workspace) => workspace.id === "workspace-a");
    const floatingWindow = floated.floatingWindows.find((window) => window.id === "float-1");
    if (!ownerWorkspace || !floatingWindow) assert.fail("expected owner workspace and floating window");

    assert.deepEqual(listDockSlots(ownerWorkspace.layout), [createOwnedSlot("slot-files-a", "files-a")]);
    assert.deepEqual(listDockSlots(floatingWindow.layout), [
      { kind: "mirror", id: "slot-new-1", toolTabId: "files-a", ownerWorkspaceId: "workspace-a" },
    ]);

    const closed = closeFloatingWindow(floated, "float-1");
    const ownerAfterClose = closed.workspaces.find((workspace) => workspace.id === "workspace-a");
    if (!ownerAfterClose) assert.fail("expected owner workspace after floating window close");

    assert.equal(closed.floatingWindows.length, 0);
    assert.deepEqual(listDockSlots(ownerAfterClose.layout), [createOwnedSlot("slot-files-a", "files-a")]);
  });

  it("turns mirrors into closed-source placeholders when the owner tool tab closes", () => {
    const ids = sequenceIds();
    const mirrored = createMirrorInWorkspace(createSnapshot(), "files-a", "workspace-b", "group-b", ids);
    const closed = closeOwnerToolTab(mirrored, "files-a");
    const target = closed.workspaces.find((workspace) => workspace.id === "workspace-b");
    if (!target) assert.fail("expected target workspace");
    const mirrorReplacement = listDockSlots(target.layout).find((slot) => slot.kind === "closed-source");

    assert.equal(closed.toolTabs.some((toolTab) => toolTab.id === "files-a"), false);
    assert.deepEqual(closed.workspaces.find((workspace) => workspace.id === "workspace-a")?.ownedToolTabIds, ["terminal-a"]);
    assert.equal(mirrorReplacement?.kind, "closed-source");
    assert.equal(mirrorReplacement?.previousTitle, "/home/a");
    assert.equal(mirrorReplacement?.ownerWorkspaceTitle, "Production");
  });

  it("rejects invalid ratios", () => {
    assert.throws(() => normalizeDockRatios([1, Number.NaN]), /positive finite/);
  });

  it("rejects an empty side panel dock group", () => {
    assert.throws(() => createDockGroup("group-b", "side_panel", [], ""), /dock group group-b must contain at least one slot/);
  });

  it("rejects floating window groups that are not content", () => {
    const snapshot = createSnapshot();
    snapshot.floatingWindows.push({
      id: "float-side-panel",
      layout: createDockGroup("group-float-side-panel", "side_panel", [
        { kind: "mirror", id: "slot-float-sidebar", toolTabId: "files-a", ownerWorkspaceId: "workspace-a" },
      ], "slot-float-sidebar"),
    });

    assert.throws(() => validateWorkspaceSnapshot(snapshot), /floating window float-side-panel group group-float-side-panel must use content role/);
  });
});

function createSnapshot(): WorkspaceLayoutSnapshot {
  return {
    version: 1,
    activeWorkspaceId: "workspace-a",
    workspaces: [
      {
        id: "workspace-a",
        hostId: "host-a",
        title: "Production",
        ownedToolTabIds: ["files-a", "terminal-a"],
        layout: createDockGroup("group-a", "content", [createOwnedSlot("slot-files-a", "files-a")], "slot-files-a"),
      },
      {
        id: "workspace-b",
        hostId: "host-b",
        title: "Staging",
        ownedToolTabIds: ["files-b"],
        layout: createDockGroup("group-b", "content", [createOwnedSlot("slot-files-b", "files-b")], "slot-files-b"),
      },
    ],
    toolTabs: [
      { id: "files-a", kind: "files", ownerWorkspaceId: "workspace-a", hostId: "host-a", title: "/home/a" },
      { id: "terminal-a", kind: "terminal", ownerWorkspaceId: "workspace-a", hostId: "host-a", title: "zsh" },
      { id: "files-b", kind: "files", ownerWorkspaceId: "workspace-b", hostId: "host-b", title: "/home/b" },
    ],
    floatingWindows: [],
  };
}

function sequenceIds(): DockIdFactory {
  let nextSlot = 0;
  let nextGroup = 0;
  return {
    slotId: () => {
      nextSlot += 1;
      return `slot-new-${nextSlot}`;
    },
    groupId: () => {
      nextGroup += 1;
      return `group-new-${nextGroup}`;
    },
  };
}
