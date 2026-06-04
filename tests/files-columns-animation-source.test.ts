/*
 * Test content:
 *
 * Feature:
 * Finder-style Files Columns view motion.
 *
 * Operation:
 * Reads the FilesToolTab component source and inspects the Columns view for
 * a double-pane sliding track, forward and backward horizontal transforms,
 * a non-zero motion duration, transition-free preparation, and animation
 * cleanup.
 *
 * Expected:
 * Directory column window shifts are implemented as an explicit horizontal
 * slide between the previous three-column pane and the next three-column pane
 * using a non-linear easing curve, column-count changes use the same easing for
 * file and preview column resizing without horizontal track travel, resize
 * keeps the current pane identity stable so existing column scroll viewports
 * are not recreated, and animation cleanup collapses back to one current pane
 * after the motion.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const filesToolTabUrl = new URL("../src/lib/files/FilesToolTab.svelte", import.meta.url);

describe("Files Columns view motion source", () => {
  it("slides between previous and next three-column panes", async () => {
    const source = await readFile(filesToolTabUrl, "utf8");

    assert.match(source, /const\s+columnsMotionDurationMs\s*=\s*180;/);
    assert.match(source, /const\s+columnsMotionEasing\s*=\s*"cubic-bezier\([^"]+\)";/);
    assert.doesNotMatch(source, /const\s+columnsMotionEasing\s*=\s*"linear";/);
    assert.match(source, /let\s+columnsPanes\s*=\s*\$state<ColumnsPane\[\]>\(\[\]\);/);
    assert.match(source, /function\s+syncColumnsPanes\(nextColumns:\s*FilesColumn\[\]\)/);
    assert.match(source, /columnsPanes\s*=\s*direction\s*===\s*"backward"\s*\?\s*\[current,\s*previous\]\s*:\s*\[previous,\s*current\];/);
    assert.match(source, /function\s+currentColumnsPane\(columns:\s*FilesColumn\[\]\):\s*ColumnsPane\s*\{[\s\S]*?id:\s*currentColumnsPaneId\(\),/);
    assert.match(source, /function\s+currentColumnsPaneId\(\)\s*\{[\s\S]*?return\s+"current";/);
    assert.match(source, /columnsPanes\s*=\s*\[currentColumnsPane\(nextColumns\)\];/);
    assert.match(source, /class:motion-forward=\{columnsMotion\s*===\s*"forward"\}/);
    assert.match(source, /class:motion-backward=\{columnsMotion\s*===\s*"backward"\}/);
    assert.match(source, /class:motion-resize=\{columnsMotion\s*===\s*"resize"\}/);
    assert.match(source, /class:motion-preparing=\{columnsMotionPreparing\}/);
    assert.match(source, /\.columns-content\.motion-forward\.motion-active\s*\{[^}]*transform:\s*translateX\(-100%\);/s);
    assert.match(source, /\.columns-content\.motion-backward\s*\{[^}]*transform:\s*translateX\(-100%\);/s);
    assert.match(source, /\.columns-content\.motion-backward\.motion-active\s*\{[^}]*transform:\s*translateX\(0\);/s);
    assert.match(source, /\.columns-content\.motion-resize\s*\{[^}]*transform:\s*translateX\(0\);/s);
    assert.match(source, /style=\{`--columns-motion-duration:\s*\$\{columnsMotionDurationMs\}ms;\s*--columns-motion-easing:\s*\$\{columnsMotionEasing\};`\}/);
    assert.match(source, /\.columns-content\s*\{[^}]*transition:\s*transform\s+var\(--columns-motion-duration,\s*180ms\)\s+var\(--columns-motion-easing,/s);
    assert.match(source, /\.columns-content\.motion-resize\s+\.file-column\s*\{[^}]*flex-basis\s+var\(--columns-motion-duration,\s*180ms\)\s+var\(--columns-motion-easing,/s);
    assert.match(source, /\.columns-content\.motion-resize\s+\.preview-column\s*\{[^}]*flex-basis\s+var\(--columns-motion-duration,\s*180ms\)\s+var\(--columns-motion-easing,/s);
    assert.match(source, /\.columns-content\.motion-preparing\s*\{[^}]*transition:\s*none;/s);
    assert.match(source, /\.columns-pane\s*\{[^}]*flex:\s*0\s+0\s+100%;/s);
  });
});
