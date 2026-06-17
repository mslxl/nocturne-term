/*
 * Test content:
 *
 * Feature:
 * Verifies that the Files Tree view removes the preview area completely when
 * the selected file has no renderable preview.
 *
 * Operation:
 * Reads the FilesToolTab component stylesheet and inspects the Tree preview
 * layout rules for the default state and the explicit with-preview state.
 *
 * Expected:
 * The default Tree preview layout uses a single content column. The second
 * preview column is allocated only by the .tree-preview-layout.with-preview
 * rule, so unsupported, loading, and over-limit previews do not leave an empty
 * preview region on screen.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const filesToolTabUrl = new URL("../src/lib/files/FilesToolTab.svelte", import.meta.url);

describe("Files preview layout CSS", () => {
  it("allocates the Tree preview column only when preview content is visible", async () => {
    const source = await readFile(filesToolTabUrl, "utf8");

    assert.match(
      source,
      /\.tree-preview-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s,
    );
    assert.match(
      source,
      /\.tree-preview-layout\.with-preview\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(220px,\s*28%\);/s,
    );
  });
});
