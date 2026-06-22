/*
 * Test content:
 *
 * Feature:
 * Verifies Dock ToolTab bar placement source contracts.
 *
 * Operation:
 * Reads the Svelte Workspace page source and checks the edge-priority helper,
 * visual Dock group role data attributes, and CSS classes for bottom and
 * vertical ToolTab bars.
 *
 * Expected:
 * Bottom placement wins before left/right, left and right use vertical writing,
 * bottom groups move the ToolTab bar below the tool surface, and visual group
 * role follows the current ToolTab bar placement.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

describe("Dock ToolTab bar placement source", () => {
  it("places ToolTab bars from Dock edge bounds with bottom priority", async () => {
    const source = await readFile(new URL("../src/routes/+page.svelte", import.meta.url), "utf8");

    assert.match(source, /function toolTabbarPlacement\(bounds: DockGroupBounds\): ToolTabbarPlacement \{[\s\S]*bounds\.bottom && !bounds\.top[\s\S]*return "bottom";[\s\S]*bounds\.left && !bounds\.right[\s\S]*return "left";[\s\S]*bounds\.right && !bounds\.left[\s\S]*return "right";[\s\S]*return "top";[\s\S]*\}/);
    assert.match(source, /data-dock-group-role=\{visualDockGroupRole\(bounds\)\}/);
    assert.match(source, /data-dock-group-model-role=\{dockGroupRole\(layout\)\}/);
    assert.match(source, /data-tool-tabbar-placement=\{toolTabbarPlacement\(bounds\)\}/);
    assert.match(source, /\.workspace-dock-group\.tabbar-bottom\s*\{[\s\S]*grid-template-rows:\s*minmax\(0,\s*1fr\)\s*31px;/);
    assert.match(source, /\.workspace-dock-group\.tabbar-left \.tool-tab,[\s\S]*\.workspace-dock-group\.tabbar-right \.tool-tab\s*\{[\s\S]*writing-mode:\s*vertical-rl;/);
  });

  it("keeps side and bottom ToolTab active states visually stable", async () => {
    const source = await readFile(new URL("../src/routes/+page.svelte", import.meta.url), "utf8");

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
