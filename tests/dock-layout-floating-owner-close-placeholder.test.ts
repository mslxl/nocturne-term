/*
 * Test content:
 *
 * Feature:
 * Verifies Dock layout behavior for a floating window that displays a mirror of
 * an owned ToolTab.
 *
 * Operation:
 * Builds a Workspace snapshot, opens a floating-window mirror for an owned
 * Files ToolTab, closes the owner ToolTab, and inspects the floating window
 * layout.
 *
 * Expected:
 * Closing the owner ToolTab removes the real ToolTab while keeping the floating
 * mirror display as a closed-source placeholder, matching Workspace mirror
 * behavior instead of silently removing the floating display.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createDockGroup,
  createOwnedSlot,
  listDockSlots,
  validateWorkspaceSnapshot,
  type WorkspaceLayoutSnapshot,
} from "../src/lib/workspace/dock/model";
import { closeOwnerToolTab, floatOwnedSlot, type DockIdFactory } from "../src/lib/workspace/dock/operations";

describe("Dock layout floating owner close placeholder", () => {
  it("keeps a floating mirror as a closed-source placeholder when its owner ToolTab closes", () => {
    const floated = floatOwnedSlot(ownerSnapshot(), "workspace-local", "slot-files", "float-files", sequenceIds());
    const closed = closeOwnerToolTab(floated, "files-local");
    const floating = closed.floatingWindows.find((item) => item.id === "float-files");
    if (!floating) assert.fail("expected float-files floating window");

    assert.equal(closed.toolTabs.some((toolTab) => toolTab.id === "files-local"), false);
    assert.deepEqual(listDockSlots(floating.layout), [
      {
        kind: "closed-source",
        id: "slot-new-1",
        previousTitle: "/home/local",
        ownerWorkspaceTitle: "Local",
      },
    ]);
    validateWorkspaceSnapshot(closed);
  });
});

function ownerSnapshot(): WorkspaceLayoutSnapshot {
  return {
    version: 1,
    activeWorkspaceId: "workspace-local",
    workspaces: [
      {
        id: "workspace-local",
        hostId: "host-local",
        title: "Local",
        ownedToolTabIds: ["files-local"],
        layout: createDockGroup("group-content", "content", [createOwnedSlot("slot-files", "files-local")], "slot-files"),
      },
    ],
    toolTabs: [
      {
        id: "files-local",
        kind: "files",
        ownerWorkspaceId: "workspace-local",
        hostId: "host-local",
        title: "/home/local",
      },
    ],
    floatingWindows: [],
  };
}

function sequenceIds(): DockIdFactory {
  let nextSlot = 0;
  let nextGroup = 0;
  return {
    slotId: () => `slot-new-${++nextSlot}`,
    groupId: () => `group-new-${++nextGroup}`,
  };
}
