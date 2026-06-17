/*
 * Test content:
 *
 * Feature:
 * Verifies Dock layout cleanup when closing the final ToolTab in one side of a
 * content-area split.
 *
 * Operation:
 * Builds a Workspace snapshot with two content Dock groups split left and
 * right, closes the owner ToolTab displayed in the right group, and inspects
 * the resulting Workspace layout.
 *
 * Expected:
 * The closed owner ToolTab is removed from the Workspace and global ToolTab
 * list, the now-empty right content group is removed, the single-child split
 * collapses, and the remaining left content group becomes the whole content
 * layout instead of leaving an unrelated empty split region behind.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  createDockGroup,
  createOwnedSlot,
  listDockGroups,
  listDockSlots,
  validateWorkspaceSnapshot,
  type WorkspaceLayoutSnapshot,
} from "../src/lib/workspace/dock/model";
import { closeOwnerToolTab } from "../src/lib/workspace/dock/operations";

describe("Dock layout close empty split group", () => {
  it("collapses a content split side after closing that side's final owner ToolTab", () => {
    const closed = closeOwnerToolTab(splitContentSnapshot(), "terminal-right");
    const workspace = closed.workspaces.find((item) => item.id === "workspace-local");
    if (!workspace) assert.fail("expected workspace-local");

    assert.equal(closed.toolTabs.some((toolTab) => toolTab.id === "terminal-right"), false);
    assert.deepEqual(workspace.ownedToolTabIds, ["terminal-left"]);
    assert.deepEqual(
      listDockGroups(workspace.layout).map((group) => group.id),
      ["group-left"],
    );
    assert.deepEqual(
      listDockSlots(workspace.layout).map((slot) => slot.id),
      ["slot-left"],
    );
    assert.deepEqual(
      workspace.layout,
      createDockGroup("group-left", "content", [createOwnedSlot("slot-left", "terminal-left")], "slot-left"),
    );
    validateWorkspaceSnapshot(closed);
  });
});

function splitContentSnapshot(): WorkspaceLayoutSnapshot {
  return {
    version: 1,
    activeWorkspaceId: "workspace-local",
    workspaces: [
      {
        id: "workspace-local",
        hostId: "host-local",
        title: "Local",
        ownedToolTabIds: ["terminal-left", "terminal-right"],
        layout: {
          kind: "split",
          direction: "row",
          ratios: [0.5, 0.5],
          children: [
            createDockGroup("group-left", "content", [createOwnedSlot("slot-left", "terminal-left")], "slot-left"),
            createDockGroup("group-right", "content", [createOwnedSlot("slot-right", "terminal-right")], "slot-right"),
          ],
        },
      },
    ],
    toolTabs: [
      {
        id: "terminal-left",
        kind: "terminal",
        ownerWorkspaceId: "workspace-local",
        hostId: "host-local",
        title: "Left Shell",
      },
      {
        id: "terminal-right",
        kind: "terminal",
        ownerWorkspaceId: "workspace-local",
        hostId: "host-local",
        title: "Right Shell",
      },
    ],
    floatingWindows: [],
  };
}
