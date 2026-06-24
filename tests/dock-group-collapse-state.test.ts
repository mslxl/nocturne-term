/*
 * Test content:
 *
 * Feature:
 * Verifies Dock group collapsed view state for side and bottom ToolTab bars.
 *
 * Operation:
 * Builds in-memory Workspace layouts, toggles a group's collapsed flag, activates
 * another ToolTab in the same group, clears collapse when a group is rendered in
 * a top ToolTab-bar placement, and mirrors an owned ToolTab into another
 * Workspace before collapsing only the owner Workspace group.
 *
 * Expected:
 * Collapsed state is stored on the Dock group layout, activating a different
 * ToolTab expands that group, top-placement groups cannot stay collapsed, and
 * collapsing a group in one Workspace does not affect a mirror group in another
 * Workspace because mirror display state is group-local rather than ToolTab
 * business state.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  createDockGroup,
  createOwnedSlot,
  listDockGroups,
  type WorkspaceLayoutSnapshot,
} from "../src/lib/workspace/dock/model";
import {
  activateSlot,
  createMirrorInWorkspace,
  setDockGroupCollapsed,
} from "../src/lib/workspace/dock/operations";

describe("Dock group collapsed view state", () => {
  it("stores collapsed state on the target Dock group", () => {
    const layout = createDockGroup(
      "group-tools",
      "side_panel",
      [createOwnedSlot("slot-files", "tool-files")],
      "slot-files",
    );

    assert.equal(layout.collapsed, false);

    const collapsed = setDockGroupCollapsed(layout, "group-tools", true);
    const [group] = listDockGroups(collapsed);

    assert.equal(group?.collapsed, true);
  });

  it("expands a collapsed group when a different ToolTab becomes active", () => {
    const layout = createDockGroup(
      "group-tools",
      "side_panel",
      [
        createOwnedSlot("slot-files", "tool-files"),
        createOwnedSlot("slot-transfers", "tool-transfers"),
      ],
      "slot-files",
    );

    const collapsed = setDockGroupCollapsed(layout, "group-tools", true);
    const activated = activateSlot(collapsed, "slot-transfers");
    const [group] = listDockGroups(activated);

    assert.equal(group?.activeSlotId, "slot-transfers");
    assert.equal(group?.collapsed, false);
  });

  it("clears collapsed state when a group must render with a top ToolTab bar", () => {
    const layout = createDockGroup(
      "group-content",
      "content",
      [createOwnedSlot("slot-terminal", "tool-terminal")],
      "slot-terminal",
    );

    const collapsed = setDockGroupCollapsed(layout, "group-content", true);
    const expanded = setDockGroupCollapsed(collapsed, "group-content", false);
    const [group] = listDockGroups(expanded);

    assert.equal(group?.collapsed, false);
  });

  it("does not collapse mirror groups in other Workspaces", () => {
    const snapshot = createMirrorInWorkspace(createSnapshot(), "tool-files", "workspace-mirror", "group-mirror", {
      slotId: () => "slot-files-mirror",
    });
    const owner = snapshot.workspaces.find((workspace) => workspace.id === "workspace-owner");
    const mirror = snapshot.workspaces.find((workspace) => workspace.id === "workspace-mirror");
    if (!owner || !mirror) assert.fail("expected owner and mirror Workspaces");

    const ownerCollapsed = setDockGroupCollapsed(owner.layout, "group-owner", true);
    const ownerGroup = listDockGroups(ownerCollapsed).find((group) => group.id === "group-owner");
    const mirrorGroup = listDockGroups(mirror.layout).find((group) => group.id === "group-mirror");

    assert.equal(ownerGroup?.collapsed, true);
    assert.equal(mirrorGroup?.collapsed, false);
    assert.deepEqual(mirrorGroup?.slots, [
      {
        kind: "owned",
        id: "slot-placeholder",
        toolTabId: "tool-placeholder",
      },
      {
        kind: "mirror",
        id: "slot-files-mirror",
        toolTabId: "tool-files",
        ownerWorkspaceId: "workspace-owner",
      },
    ]);
  });
});

function createSnapshot(): WorkspaceLayoutSnapshot {
  return {
    version: 1,
    activeWorkspaceId: "workspace-owner",
    workspaces: [
      {
        id: "workspace-owner",
        hostId: "host-owner",
        title: "Owner",
        ownedToolTabIds: ["tool-files"],
        layout: createDockGroup(
          "group-owner",
          "side_panel",
          [createOwnedSlot("slot-files", "tool-files")],
          "slot-files",
        ),
      },
      {
        id: "workspace-mirror",
        hostId: "host-mirror",
        title: "Mirror",
        ownedToolTabIds: ["tool-placeholder"],
        layout: createDockGroup(
          "group-mirror",
          "side_panel",
          [createOwnedSlot("slot-placeholder", "tool-placeholder")],
          "slot-placeholder",
        ),
      },
    ],
    toolTabs: [
      {
        id: "tool-files",
        kind: "files",
        ownerWorkspaceId: "workspace-owner",
        hostId: "host-owner",
        title: "/home/owner",
      },
      {
        id: "tool-placeholder",
        kind: "transfers",
        ownerWorkspaceId: "workspace-mirror",
        hostId: "host-mirror",
        title: "Transfers",
      },
    ],
    floatingWindows: [],
  };
}
