/*
 * Test content:
 *
 * Feature:
 * Verifies Dock ToolTab bar placement source contracts.
 *
 * Operation:
 * Reads the Svelte Workspace page source and extracted WorkspaceDockGroup
 * component source. The page must compute edge-priority placement and pass it
 * to the component, while the component must keep the model role separate from
 * visual edge placement data and CSS classes for bottom and vertical ToolTab bars.
 *
 * Expected:
 * Bottom placement wins before left/right, left and right use vertical writing,
 * bottom groups move the ToolTab bar below the tool surface, and the semantic
 * Dock group role remains the model role used by drag/drop logic.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

describe("Dock ToolTab bar placement source", () => {
  it("places ToolTab bars from Dock edge bounds with bottom priority", async () => {
    const pageSource = await readFile(new URL("../src/routes/+page.svelte", import.meta.url), "utf8");
    const groupSource = await readFile(new URL("../src/lib/workspace/components/WorkspaceDockGroup.svelte", import.meta.url), "utf8");

    assert.match(pageSource, /function toolTabbarPlacement\(bounds: DockGroupBounds\): ToolTabbarPlacement \{[\s\S]*bounds\.bottom && !bounds\.top[\s\S]*return "bottom";[\s\S]*bounds\.left && !bounds\.right[\s\S]*return "left";[\s\S]*bounds\.right && !bounds\.left[\s\S]*return "right";[\s\S]*return "top";[\s\S]*\}/);
    assert.match(pageSource, /tabbarPlacement=\{toolTabbarPlacement\(bounds\)\}/);
    assert.match(pageSource, /visualRole=\{visualDockGroupRole\(bounds\)\}/);
    assert.match(groupSource, /data-dock-group-role=\{layout\.role\}/);
    assert.match(groupSource, /data-dock-group-visual-role=\{visualRole\}/);
    assert.match(groupSource, /data-dock-group-model-role=\{layout\.role\}/);
    assert.match(groupSource, /data-tool-tabbar-placement=\{tabbarPlacement\}/);
    assert.match(groupSource, /\.workspace-dock-group\.tabbar-bottom\s*\{[\s\S]*grid-template-rows:\s*minmax\(0,\s*1fr\)\s*31px;/);
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
});
