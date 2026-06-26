/*
 * Test content:
 *
 * Feature:
 * Verifies Dock ToolTab bar placement source contracts.
 *
 * Operation:
 * Reads the Svelte Workspace page source and extracted WorkspaceDockGroup
 * component source. The page must keep content groups on a top ToolTab bar,
 * compute edge-priority placement only for side-panel groups, and pass that
 * placement to the component while keeping the model role available on the DOM.
 *
 * Expected:
 * Content groups always use top placement even when they touch a window edge.
 * For side-panel groups, bottom placement wins before left/right, left and
 * right use vertical writing, and bottom groups move the ToolTab bar below the
 * tool surface. The frontend hit-test keeps group-edge split targets reachable
 * for Dock groups that already touch the Workspace edge. Demo workspace state
 * preserves explicit group roles instead of recomputing roles from geometry.
 * Content groups that touch a side or bottom Workspace edge expose a restore
 * zone before group-edge split hit testing so a ToolTab can return to a native
 * side-panel position. Side and bottom groups expose collapsed display state on
 * the group DOM, while top placement is excluded from ToolTab-bar collapse.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

describe("Dock ToolTab bar placement source", () => {
  it("places ToolTab bars from Dock edge bounds with bottom priority", async () => {
    const pageSource = await readFile(new URL("../src/routes/+page.svelte", import.meta.url), "utf8");
    const groupSource = await readFile(new URL("../src/lib/workspace/components/WorkspaceDockGroup.svelte", import.meta.url), "utf8");

    assert.match(pageSource, /function edgeToolTabbarPlacement\(bounds: DockGroupBounds\): ToolTabbarPlacement \{[\s\S]*bounds\.bottom && !bounds\.top[\s\S]*return "bottom";[\s\S]*bounds\.left && !bounds\.right[\s\S]*return "left";[\s\S]*bounds\.right && !bounds\.left[\s\S]*return "right";[\s\S]*return "top";[\s\S]*\}/);
    assert.match(pageSource, /function toolTabbarPlacement\([\s\S]*group: Extract<WorkspaceDockLayout, \{ kind: "group" \}>,[\s\S]*bounds: DockGroupBounds,[\s\S]*\): ToolTabbarPlacement \{[\s\S]*dockGroupRole\(group\) === "content"[\s\S]*return "top";[\s\S]*return edgeToolTabbarPlacement\(bounds\);[\s\S]*\}/);
    assert.match(pageSource, /tabbarPlacement=\{toolTabbarPlacement\(layout, bounds\)\}/);
    assert.match(pageSource, /visualRole=\{visualDockGroupRole\(layout\)\}/);
    assert.match(pageSource, /const workspaceEdgeTarget = toolTabWorkspaceEdgeDropTargetFromPoint\(x, y, targetWorkspaceId, workspaceEdgeInnerBand\(\)\);[\s\S]*if \(workspaceEdgeTarget\) return workspaceEdgeTarget;[\s\S]*const sidePanelRestoreTarget = toolTabSidePanelRestoreDropTargetFromPoint\([\s\S]*drag\.groupId,[\s\S]*drag\.groupRole,[\s\S]*\);[\s\S]*if \(sidePanelRestoreTarget\) return sidePanelRestoreTarget;[\s\S]*const groupEdgeTarget = toolTabGroupEdgeDropTargetFromPoint\(x, y, containingGroup\.element, containingGroup\.rect, drag\.slotId\);[\s\S]*if \(groupEdgeTarget\) return groupEdgeTarget;[\s\S]*const slotTarget = toolTabSlotDropTargetFromPoint\(x, y, targetWorkspaceId, drag\.slotId\);[\s\S]*if \(slotTarget\) return slotTarget;[\s\S]*const broadWorkspaceEdgeTarget = toolTabWorkspaceEdgeDropTargetFromPoint\(x, y, targetWorkspaceId\);[\s\S]*if \(broadWorkspaceEdgeTarget\) return broadWorkspaceEdgeTarget;/);
    assert.match(pageSource, /function toolTabGroupEdgeDropTargetFromPoint\([\s\S]*draggingSlotId: string,[\s\S]*\)[\s\S]*if \(slotId === draggingSlotId\) return null;/);
    assert.match(pageSource, /function workspaceEdgeInnerBand\(\) \{[\s\S]*return 28;[\s\S]*\}/);
    assert.match(pageSource, /function toolTabSidePanelRestoreDropTargetFromPoint\([\s\S]*draggingSlotId: string,[\s\S]*draggingGroupId: string,[\s\S]*draggingGroupRole: "content" \| "side_panel",[\s\S]*group\.dataset\.dockGroupRole !== "content"[\s\S]*draggingToolKind === "terminal"[\s\S]*draggingGroupRole !== "side_panel"[\s\S]*group\.dataset\.dockGroupId === draggingGroupId[\s\S]*return null;[\s\S]*return \{ kind: "workspace_edge", workspaceId, side: "left" \};[\s\S]*function sidePanelRestoreBand\(rect: DOMRect\) \{[\s\S]*Math\.min\(220, Math\.max\(96, rect\.width \* 0\.45\)\)[\s\S]*\}/);
    assert.match(pageSource, /function toolTabSlotDropTargetFromPoint\([\s\S]*draggingSlotId: string,[\s\S]*\)[\s\S]*if \(slotId === draggingSlotId\) return null;/);
    assert.match(pageSource, /function splitBoundaryResizable\(layout: Extract<WorkspaceDockLayout, \{ kind: "split" \}>, index: number\) \{[\s\S]*!dockChildCollapsed\(layout\.children\[index\]\)[\s\S]*!dockChildCollapsed\(layout\.children\[index \+ 1\]\)[\s\S]*\}/);
    assert.match(pageSource, /function dockChildCollapsed\(layout: WorkspaceDockLayout \| undefined\) \{[\s\S]*layout\?\.kind === "group" && layout\.collapsed === true[\s\S]*\}/);
    assert.match(pageSource, /index < layout\.children\.length - 1 && splitBoundaryResizable\(layout, index\)/);
    assert.match(groupSource, /data-dock-group-role=\{layout\.role\}/);
    assert.match(groupSource, /data-dock-group-visual-role=\{visualRole\}/);
    assert.match(groupSource, /data-dock-group-model-role=\{layout\.role\}/);
    assert.match(groupSource, /data-tool-tabbar-placement=\{tabbarPlacement\}/);
    assert.match(groupSource, /data-dock-group-collapsed=\{groupCollapsed \? "true" : "false"\}/);
    assert.match(groupSource, /const canCollapse = \$derived\(tabbarPlacement !== "top"\)/);
    assert.match(groupSource, /\.workspace-dock-group\.tabbar-bottom\s*\{[\s\S]*grid-template-rows:\s*minmax\(0,\s*1fr\)\s*31px;/);
    assert.match(groupSource, /\.workspace-dock-group\.tabbar-bottom\.collapsed\s*\{[\s\S]*grid-template-rows:\s*minmax\(0,\s*0fr\)\s*31px;/);
    assert.match(groupSource, /\.workspace-dock-group\.tabbar-left\.collapsed\s*\{[\s\S]*grid-template-columns:\s*32px\s*minmax\(0,\s*0fr\);/);
    assert.match(groupSource, /\.workspace-dock-group\.tabbar-right\.collapsed\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*0fr\)\s*32px;/);
    assert.match(groupSource, /\.workspace-dock-group\.tabbar-left \.tool-tab,[\s\S]*\.workspace-dock-group\.tabbar-right \.tool-tab\s*\{[\s\S]*writing-mode:\s*vertical-rl;/);
  });

  it("keeps side and bottom ToolTab active states visually stable", async () => {
    const source = await readFile(new URL("../src/lib/workspace/components/WorkspaceDockGroup.svelte", import.meta.url), "utf8");

    assert.match(source, /\.tool-tab\s*\{[\s\S]*position:\s*relative;[\s\S]*box-sizing:\s*border-box;[\s\S]*flex:\s*0 0 auto;/);
    assert.match(source, /\.tool-tab\.active\s*\{[\s\S]*background:[\s\S]*box-shadow:/);
    assert.match(source, /\.tool-tab\.active::after\s*\{[\s\S]*content:\s*"";[\s\S]*position:\s*absolute;[\s\S]*pointer-events:\s*none;/);
    assert.match(source, /\.workspace-dock-group\.tabbar-bottom \.tool-tab\.active::after\s*\{[\s\S]*top:\s*2px;[\s\S]*height:\s*1px;/);
    assert.match(source, /\.workspace-dock-group\.tabbar-left \.tool-tab\.active::after\s*\{[\s\S]*right:\s*2px;[\s\S]*width:\s*1px;/);
    assert.match(source, /\.workspace-dock-group\.tabbar-right \.tool-tab\.active::after\s*\{[\s\S]*left:\s*2px;[\s\S]*width:\s*1px;/);
    assert.doesNotMatch(source, /\.tool-tab\.active\s*\{[^}]*border-color:/);
    assert.doesNotMatch(source, /\.tool-tab\.active\s*\{[^}]*color:/);
    assert.doesNotMatch(source, /\.tool-tab\.active\s*\{[^}]*font-weight:/);
    assert.doesNotMatch(source, /\.tool-tab\.active\s*\{[^}]*padding:/);
    assert.doesNotMatch(source, /\.tool-tab\.active\s*\{[^}]*transform:/);
  });

  it("keeps vertical ToolTab rails compressed instead of showing native scrollbars", async () => {
    const source = await readFile(new URL("../src/lib/workspace/components/WorkspaceDockGroup.svelte", import.meta.url), "utf8");
    const pageSource = await readFile(new URL("../src/routes/+page.svelte", import.meta.url), "utf8");
    const appThemeSource = await readFile(new URL("../src/lib/styles/app-theme.css", import.meta.url), "utf8");

    assert.match(source, /if \(kind === "terminal_sessions"\) return "Terms";/);
    assert.match(source, /groupCollapsed \|\| tabbarPlacement === "left" \|\| tabbarPlacement === "right" \? compactSlotTitle\(slot, tool\) : fullTitle/);
    assert.match(source, /\.workspace-dock-group\.tabbar-left \.tool-tabbar,[\s\S]*\.workspace-dock-group\.tabbar-right \.tool-tabbar\s*\{[\s\S]*flex-direction:\s*column;[\s\S]*align-items:\s*stretch;[\s\S]*overflow:\s*hidden;[\s\S]*scrollbar-width:\s*none;/);
    assert.match(source, /\.workspace-dock-group\.tabbar-left \.tool-tab,[\s\S]*\.workspace-dock-group\.tabbar-right \.tool-tab\s*\{[\s\S]*flex:\s*0 1 auto;[\s\S]*height:\s*auto;[\s\S]*min-height:\s*0;[\s\S]*padding:\s*2px 0;/);
    assert.match(source, /\.tool-tab \.tool-title\s*\{[\s\S]*min-height:\s*0;[\s\S]*max-height:\s*100%;[\s\S]*overflow:\s*hidden;/);
    assert.match(source, /\.workspace-dock-group\s*\{[\s\S]*box-sizing:\s*border-box;/);
    assert.match(source, /\.tool-tabbar\s*\{[\s\S]*box-sizing:\s*border-box;/);
    assert.match(source, /\.tool-surface\s*\{[\s\S]*box-sizing:\s*border-box;/);
    assert.match(source, /\.tool-pane\s*\{[\s\S]*box-sizing:\s*border-box;/);
    assert.match(pageSource, /:global\(html\),\s*:global\(body\)\s*\{[\s\S]*height:\s*100%;[\s\S]*overflow:\s*hidden;/);
    assert.match(appThemeSource, /html,\s*body\s*\{[\s\S]*height:\s*100%;[\s\S]*overflow:\s*hidden;/);
    assert.doesNotMatch(source, /\.workspace-dock-group\.tabbar-left \.tool-tabbar,[\s\S]*\.workspace-dock-group\.tabbar-right \.tool-tabbar\s*\{[\s\S]*overflow-y:\s*auto;/);
  });

  it("does not recompute explicit demo group roles from current bounds", async () => {
    const source = await readFile(new URL("../src/lib/workspace/state.svelte.ts", import.meta.url), "utf8");

    assert.match(source, /function bumpDemoVersion\(snapshot: WorkspaceLayoutSnapshot\): WorkspaceLayoutSnapshot \{[\s\S]*assertDemoSnapshotGroupRoles\(snapshot\);[\s\S]*snapshot\.version \+= 1;[\s\S]*return snapshot;[\s\S]*\}/);
    assert.match(source, /function assertDemoLayoutGroupRoles\(layout: DemoLayout\) \{[\s\S]*if \(layout\.kind === "group"\) \{[\s\S]*if \(layout\.role !== "content" && layout\.role !== "side_panel"\)[\s\S]*throw new Error/);
    assert.match(source, /function splitDemoSlot\([\s\S]*const inserted: DemoLayout = \{ kind: "group", id: `group-\$\{slot\.id\}`, role: layout\.role,/);
    assert.match(source, /function splitDemoWorkspaceEdge\([\s\S]*const role = side === "up" \? "content" : "side_panel";/);
    assert.doesNotMatch(source, /demoRoleForBounds/);
    assert.doesNotMatch(source, /normalizeDemoLayoutGroupRoles/);
    assert.doesNotMatch(source, /role = .*bounds/);
  });
});
