/*
 * Test content:
 *
 * Feature:
 * Verifies the Resource Monitor Workspace ToolTab model.
 *
 * Operation:
 * Builds an in-memory Workspace layout without a Resource Monitor, opens the
 * Resource Monitor into a target dock group, opens it a second time, and then
 * inspects the ToolTab list, Workspace ownership list, and active display slot.
 *
 * Expected:
 * The first open creates one owned `resources` ToolTab for the Workspace. The
 * second open does not create a duplicate and instead focuses the existing
 * Resource Monitor display slot.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  createDockGroup,
  createOwnedSlot,
  listDockSlots,
  type WorkspaceLayoutSnapshot,
} from "../src/lib/workspace/dock/model";
import { openResourceMonitorToolTab } from "../src/lib/workspace/dock/operations";

describe("Resource Monitor ToolTab model", () => {
  it("creates one owned Resource Monitor and focuses it on repeated open", () => {
    const first = openResourceMonitorToolTab(createSnapshot(), "workspace-a", "group-tools");
    const second = openResourceMonitorToolTab(first, "workspace-a", "group-tools");
    const workspace = second.workspaces.find((item) => item.id === "workspace-a");
    assert.ok(workspace, "workspace-a must exist after opening Resource Monitor.");

    const resources = second.toolTabs.filter(
      (toolTab) => toolTab.ownerWorkspaceId === "workspace-a" && toolTab.kind === "resources",
    );
    assert.equal(resources.length, 1);
    const resource = resources[0];
    assert.ok(resource, "Resource Monitor ToolTab must be present.");
    assert.match(resource.id, /^tool-resources-/);
    assert.equal(resource.hostId, "host-a");
    assert.equal(resource.title, "Resources");
    assert.equal(workspace.ownedToolTabIds.filter((id) => id === resource.id).length, 1);

    const resourceSlots = listDockSlots(workspace.layout).filter(
      (slot) => slot.kind === "owned" && slot.toolTabId === resource.id,
    );
    assert.equal(resourceSlots.length, 1);
    const resourceSlot = resourceSlots[0];
    assert.ok(resourceSlot, "Resource Monitor owned slot must be present.");

    const group = workspace.layout.kind === "group"
      ? workspace.layout
      : workspace.layout.children.find((child) => child.kind === "group" && child.id === "group-tools");
    assert.ok(group && group.kind === "group", "target tool dock group must exist.");
    assert.equal(group.activeSlotId, resourceSlot.id);
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
        ownedToolTabIds: ["terminal-a", "transfers-a"],
        layout: {
          kind: "split",
          direction: "row",
          ratios: [0.72, 0.28],
          children: [
            createDockGroup("group-content", "content", [createOwnedSlot("slot-terminal-a", "terminal-a")], "slot-terminal-a"),
            createDockGroup("group-tools", "sidebar", [createOwnedSlot("slot-transfers-a", "transfers-a")], "slot-transfers-a"),
          ],
        },
      },
    ],
    toolTabs: [
      { id: "terminal-a", kind: "terminal", ownerWorkspaceId: "workspace-a", hostId: "host-a", title: "Shell" },
      { id: "transfers-a", kind: "transfers", ownerWorkspaceId: "workspace-a", hostId: "host-a", title: "Transfers" },
    ],
    floatingWindows: [],
  };
}
