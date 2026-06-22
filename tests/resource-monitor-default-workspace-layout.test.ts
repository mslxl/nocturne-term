/*
 * Test content:
 *
 * Feature:
 * Verifies the default Workspace layout model for Resource Monitor.
 *
 * Operation:
 * Builds a default-style Workspace snapshot and inspects the Dock tree, owned
 * ToolTabs, right-side dock group, bottom Ports panel, and active slots without
 * launching a Tauri WebView.
 *
 * Expected:
 * The Workspace owns Files, Terminal, Resource Monitor, Transfer Queue, and
 * Ports. Files is docked on the left, Terminal is in the content group,
 * Resource Monitor and Transfer Queue are docked in the right-side group with
 * Resource Monitor active, and Ports is docked in a bottom panel by default.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  defaultWorkspaceLayoutSnapshot,
  defaultWorkspaceToolIds,
} from "../src/lib/workspace/dock/default-layout";
import { listDockGroups } from "../src/lib/workspace/dock/model";

describe("Resource Monitor default Workspace layout", () => {
  it("places Resources on the right and Ports in the bottom panel by default", () => {
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
      ids.portsToolId,
    ]);

    const kindsById = Object.fromEntries(snapshot.toolTabs.map((toolTab) => [toolTab.id, toolTab.kind]));
    assert.equal(kindsById[ids.filesToolId], "files");
    assert.equal(kindsById[ids.terminalToolId], "terminal");
    assert.equal(kindsById[ids.resourcesToolId], "resources");
    assert.equal(kindsById[ids.transfersToolId], "transfers");
    assert.equal(kindsById[ids.portsToolId], "ports");

    assert.equal(workspace.layout.kind, "split");
    if (workspace.layout.kind !== "split") return;
    assert.equal(workspace.layout.direction, "column");
    assert.deepEqual(workspace.layout.ratios, [0.7, 0.3]);
    const topSplit = workspace.layout.children[0];
    assert.equal(topSplit?.kind, "split");
    if (topSplit?.kind !== "split") return;
    assert.equal(topSplit.direction, "row");
    assert.deepEqual(topSplit.ratios, [0.24, 0.52, 0.24]);

    const groups = listDockGroups(workspace.layout);
    const filesGroup = groups.find((group) => group.id === ids.filesGroupId);
    const terminalGroup = groups.find((group) => group.id === ids.terminalGroupId);
    const rightGroup = groups.find((group) => group.id === ids.rightGroupId);
    const portsGroup = groups.find((group) => group.id === ids.portsGroupId);
    assert.ok(filesGroup, "Files group must exist.");
    assert.ok(terminalGroup, "Terminal content group must exist.");
    assert.ok(rightGroup, "right-side resources/transfers group must exist.");
    assert.ok(portsGroup, "bottom Ports panel group must exist.");

    assert.equal(filesGroup.role, "side_panel");
    assert.deepEqual(ownedToolTabIds(filesGroup.slots), [ids.filesToolId]);
    assert.equal(terminalGroup.role, "content");
    assert.deepEqual(ownedToolTabIds(terminalGroup.slots), [ids.terminalToolId]);
    assert.equal(rightGroup.role, "side_panel");
    assert.deepEqual(ownedToolTabIds(rightGroup.slots), [ids.resourcesToolId, ids.transfersToolId]);
    assert.equal(rightGroup.activeSlotId, ids.resourcesSlotId);
    assert.equal(portsGroup.role, "side_panel");
    assert.deepEqual(ownedToolTabIds(portsGroup.slots), [ids.portsToolId]);
    assert.equal(portsGroup.activeSlotId, ids.portsSlotId);
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
