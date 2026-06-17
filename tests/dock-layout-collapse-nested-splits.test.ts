/*
 * Test content:
 *
 * Feature:
 * Verifies that Dock layout slot removal recursively collapses nested split
 * nodes that are left with a single child.
 *
 * Operation:
 * Builds a Workspace-style Dock layout with a left Files group and a right
 * column split containing Terminal and Transfers groups, removes the Transfers
 * display slot, and validates the resulting layout inside a Workspace snapshot.
 *
 * Expected:
 * The removed slot is returned, the inner column split collapses to the
 * remaining Terminal group, the root split keeps only valid children and
 * ratios, and the resulting snapshot passes Dock layout validation.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  createDockGroup,
  createOwnedSlot,
  listDockGroups,
  validateWorkspaceSnapshot,
  type WorkspaceLayoutSnapshot,
} from "../src/lib/workspace/dock/model";
import { removeSlot } from "../src/lib/workspace/dock/operations";

describe("Dock layout nested split collapse", () => {
  it("recursively collapses a nested split after removing its only sibling slot", () => {
    const source = workspaceLayoutSnapshot();
    const result = removeSlot(source.workspaces[0].layout, "slot-transfers");

    assert.equal(result.removed.id, "slot-transfers");
    assert.equal(result.layout?.kind, "split");
    if (!result.layout || result.layout.kind !== "split") assert.fail("expected root split");

    assert.equal(result.layout.direction, "row");
    assert.equal(result.layout.children.length, 2);
    assert.equal(result.layout.children[1]?.kind, "group");
    assert.deepEqual(
      listDockGroups(result.layout).map((group) => group.id),
      ["group-files", "group-terminal"],
    );

    validateWorkspaceSnapshot({
      ...source,
      workspaces: [{ ...source.workspaces[0], layout: result.layout }],
    });
  });
});

function workspaceLayoutSnapshot(): WorkspaceLayoutSnapshot {
  return {
    version: 1,
    activeWorkspaceId: "workspace-local",
    workspaces: [
      {
        id: "workspace-local",
        hostId: "host-local",
        title: "Local",
        ownedToolTabIds: ["tool-files", "tool-terminal", "tool-transfers"],
        layout: {
          kind: "split",
          direction: "row",
          ratios: [0.28, 0.72],
          children: [
            createDockGroup("group-files", "sidebar", [createOwnedSlot("slot-files", "tool-files")], "slot-files"),
            {
              kind: "split",
              direction: "column",
              ratios: [0.78, 0.22],
              children: [
                createDockGroup("group-terminal", "content", [createOwnedSlot("slot-terminal", "tool-terminal")], "slot-terminal"),
                createDockGroup("group-transfers", "panel", [createOwnedSlot("slot-transfers", "tool-transfers")], "slot-transfers"),
              ],
            },
          ],
        },
      },
    ],
    toolTabs: [
      { id: "tool-files", kind: "files", ownerWorkspaceId: "workspace-local", hostId: "host-local", title: "~" },
      {
        id: "tool-terminal",
        kind: "terminal",
        ownerWorkspaceId: "workspace-local",
        hostId: "host-local",
        title: "Local Shell",
      },
      {
        id: "tool-transfers",
        kind: "transfers",
        ownerWorkspaceId: "workspace-local",
        hostId: "host-local",
        title: "Transfers",
      },
    ],
    floatingWindows: [],
  };
}
