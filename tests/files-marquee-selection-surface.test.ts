/*
 * Test content:
 *
 * Feature:
 * Files ToolTab mouse marquee selection event wiring.
 *
 * Operation:
 * Reads the Files ToolTab Svelte source and verifies that Tree and Columns
 * lists render explicit selection-surface elements that own the pointer
 * handlers used by marquee selection.
 *
 * Expected:
 * Pointer events are bound to ordinary DOM selection surfaces inside the
 * OverlayScrollbars content rather than relying on third-party scrollbar
 * component event forwarding, so real Tauri WebView mouse drags can reach the
 * selection logic.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Files marquee selection surface", () => {
  it("binds marquee pointer handlers to explicit DOM selection surfaces", () => {
    const source = readFileSync(resolve("src/lib/files/FilesToolTab.svelte"), "utf8");
    const selectionSurfaceBlocks = [...source.matchAll(/<div\s+class="files-selection-surface"[\s\S]*?onmouseleave=\{cancelMarqueeSelection\}[\s\S]*?>/g)];

    assert.equal(selectionSurfaceBlocks.length, 2);
    for (const block of selectionSurfaceBlocks) {
      assert.match(block[0], /onpointerdown=\{beginMarqueeSelection\}/);
      assert.match(block[0], /onpointermove=\{updateMarqueeSelection\}/);
      assert.match(block[0], /onpointerup=\{commitMarqueeSelection\}/);
      assert.match(block[0], /onpointercancel=\{cancelMarqueeSelection\}/);
      assert.match(block[0], /onmousedown=\{beginMarqueeSelection\}/);
      assert.match(block[0], /onmousemove=\{updateMarqueeSelection\}/);
      assert.match(block[0], /onmouseup=\{commitMarqueeSelection\}/);
      assert.match(block[0], /onmouseleave=\{cancelMarqueeSelection\}/);
    }
  });
});
