/*
 * Test content:
 *
 * Feature:
 * Verifies the default Workspace layout model for Resource Monitor.
 *
 * Operation:
 * Builds a default-style Workspace snapshot and inspects the Dock tree, owned
 * ToolTabs, right-side dock group, and active slot without launching a Tauri
 * WebView.
 *
 * Expected:
 * The Workspace owns Files, Terminal, Resource Monitor, and Transfer Queue.
 * Files is docked on the left, Terminal is in the content group, and Resource
 * Monitor plus Transfer Queue are docked together in the right-side group with
 * Resource Monitor active by default.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  defaultWorkspaceLayoutSnapshot,
  defaultWorkspaceToolIds,
} from "../src/lib/workspace/dock/default-layout";
import { listDockGroups } from "../src/lib/workspace/dock/model";

describe("Resource Monitor default Workspace layout", () => {
  it("places Resources and Transfers together in the right dock group with Resources active", () => {
    const ids = defaultWorkspaceToolIds("local");
    const snapshot = defaultWorkspaceLayoutSnapshot({
      workspaceId: "workspace-local",
      hostId: "host-local",
      title: "Local Shell",
      filesTitle: "~",
      terminalTitle: "Local Shell",
      ids,
    });
    const workspace = snapshot.workspaces[0];
    assert.ok(workspace, "default snapshot must contain one workspace.");

    assert.deepEqual(workspace.ownedToolTabIds, [
      ids.filesToolId,
      ids.terminalToolId,
      ids.resourcesToolId,
      ids.transfersToolId,
    ]);

    const kindsById = Object.fromEntries(snapshot.toolTabs.map((toolTab) => [toolTab.id, toolTab.kind]));
    assert.equal(kindsById[ids.filesToolId], "files");
    assert.equal(kindsById[ids.terminalToolId], "terminal");
    assert.equal(kindsById[ids.resourcesToolId], "resources");
    assert.equal(kindsById[ids.transfersToolId], "transfers");

    assert.equal(workspace.layout.kind, "split");
    if (workspace.layout.kind !== "split") return;
    assert.equal(workspace.layout.direction, "row");
    assert.deepEqual(workspace.layout.ratios, [0.24, 0.52, 0.24]);

    const groups = listDockGroups(workspace.layout);
    const filesGroup = groups.find((group) => group.id === ids.filesGroupId);
    const terminalGroup = groups.find((group) => group.id === ids.terminalGroupId);
    const rightGroup = groups.find((group) => group.id === ids.rightGroupId);
    assert.ok(filesGroup, "Files group must exist.");
    assert.ok(terminalGroup, "Terminal content group must exist.");
    assert.ok(rightGroup, "right-side resources/transfers group must exist.");

    assert.equal(filesGroup.role, "sidebar");
    assert.deepEqual(ownedToolTabIds(filesGroup.slots), [ids.filesToolId]);
    assert.equal(terminalGroup.role, "content");
    assert.deepEqual(ownedToolTabIds(terminalGroup.slots), [ids.terminalToolId]);
    assert.equal(rightGroup.role, "sidebar");
    assert.deepEqual(ownedToolTabIds(rightGroup.slots), [ids.resourcesToolId, ids.transfersToolId]);
    assert.equal(rightGroup.activeSlotId, ids.resourcesSlotId);
  });
});

function ownedToolTabIds(slots: Array<{ kind: string; toolTabId?: string }>): string[] {
  return slots.map((slot) => {
    assert.equal(slot.kind, "owned");
    const toolTabId = slot.toolTabId;
    if (typeof toolTabId !== "string") {
      throw new Error("owned slot is missing toolTabId");
    }
    return toolTabId;
  });
}
