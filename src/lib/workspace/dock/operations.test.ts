import { describe, it } from "node:test";
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
  restoreFloatingWindow,
  splitSlot,
  closeOwnerToolTab,
  type DockIdFactory,
} from "./operations";

describe("dock workspace operations", () => {
  it("validates a workspace snapshot with independent workspace layouts", () => {
    const snapshot = createSnapshot();

    validateWorkspaceSnapshot(snapshot);

    assert.deepEqual(snapshot.workspaces.map((workspace) => workspace.layout), [
      createDockGroup("group-a", [createOwnedSlot("slot-files-a", "files-a")], "slot-files-a"),
      createDockGroup("group-b", [createOwnedSlot("slot-files-b", "files-b")], "slot-files-b"),
    ]);
  });

  it("splits a slot into a new dock group", () => {
    const ids = sequenceIds();
    const layout = splitSlot(
      createDockGroup("group-a", [createOwnedSlot("slot-files-a", "files-a")], "slot-files-a"),
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

  it("floats an owned slot into an independent floating window and restores it", () => {
    const ids = sequenceIds();
    const floated = floatOwnedSlot(createSnapshot(), "workspace-a", "slot-files-a", "float-1", ids);
    const ownerWorkspace = floated.workspaces.find((workspace) => workspace.id === "workspace-a");
    const floatingWindow = floated.floatingWindows.find((window) => window.id === "float-1");
    if (!ownerWorkspace || !floatingWindow) assert.fail("expected owner workspace and floating window");

    assert.equal(listDockSlots(ownerWorkspace.layout)[0]?.kind, "floating-placeholder");
    assert.deepEqual(listDockSlots(floatingWindow.layout).map((slot) => slot.kind), ["owned"]);

    const restored = restoreFloatingWindow(floated, "float-1");
    const restoredWorkspace = restored.workspaces.find((workspace) => workspace.id === "workspace-a");
    if (!restoredWorkspace) assert.fail("expected restored owner workspace");

    assert.equal(restored.floatingWindows.length, 0);
    assert.deepEqual(listDockSlots(restoredWorkspace.layout), [createOwnedSlot("slot-files-a", "files-a")]);
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
        layout: createDockGroup("group-a", [createOwnedSlot("slot-files-a", "files-a")], "slot-files-a"),
      },
      {
        id: "workspace-b",
        hostId: "host-b",
        title: "Staging",
        ownedToolTabIds: ["files-b"],
        layout: createDockGroup("group-b", [createOwnedSlot("slot-files-b", "files-b")], "slot-files-b"),
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
