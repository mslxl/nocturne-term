/*
 * Test content:
 *
 * Feature:
 * Verifies the Terminal ToolTab close/detach context menu lives on the dock
 * group tab chrome instead of the terminal content area.
 *
 * Operation:
 * Reads the Workspace dock group Svelte component, the main Workspace page,
 * and the workspace tabs documentation. The test checks that the dock-group
 * tab button handles the context menu, that the shared tooltab menu includes
 * Close and Detach actions, and that the terminal content surface no longer
 * advertises a separate close/detach menu.
 *
 * Expected:
 * Close and Detach are exposed from the tooltab chrome menu only, while the
 * terminal content surface remains free of those actions.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

describe("Terminal ToolTab context menu source", () => {
  it("keeps Close and Detach on the dock-group tab menu instead of terminal content", async () => {
    const group = await readFile(new URL("../src/lib/workspace/components/WorkspaceDockGroup.svelte", import.meta.url), "utf8");
    const page = await readFile(new URL("../src/routes/+page.svelte", import.meta.url), "utf8");
    const docs = await readFile(new URL("../docs/workspace-tabs.md", import.meta.url), "utf8");

    assert.match(group, /oncontextmenu=\{\(event\) => workspace \? onContextMenu\(event, layout, slot\) : undefined\}/);
    assert.match(group, /role="tab"/);
    assert.match(page, /<button type="button" role="menuitem" onclick=\{\(\) => void closeWorkspaceSlot\(toolTabContextMenu!\.workspaceId, toolTabContextMenu!\.slotId\)\.finally\(closeToolTabContextMenu\)\}>[\s\S]*Close[\s\S]*<\/button>/);
    assert.match(page, /<button type="button" role="menuitem" onclick=\{\(\) => void detachToolTabContextMenu\(toolTabContextMenu!\)\.finally\(closeToolTabContextMenu\)\}>[\s\S]*Detach[\s\S]*<\/button>/);
    assert.match(page, /data-tooltab-menu="true"/);
    assert.match(page, /toolTabContextMenuDetachTarget/);
    assert.doesNotMatch(page, /Detach Session/);
    assert.doesNotMatch(page, /Close Session/);
    assert.match(docs, /The `Close` and `Detach` actions belong to the dock group tab-button right-click menu/);
  });
});
