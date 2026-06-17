/*
Feature: Files preview horizontal overflow behavior.
Operation: Inspect the FilesToolTab preview scroll configuration and preview render calls for text and image preview content.
Expected: Preview content uses an overlay scrollbar configuration that hides horizontal overflow, so file previews wrap or fit instead of showing a horizontal scrollbar.
*/
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const filesToolTabUrl = new URL("../src/lib/files/FilesToolTab.svelte", import.meta.url);

describe("Files preview horizontal overflow behavior", () => {
  it("uses a preview overlay scrollbar configuration with hidden horizontal overflow", async () => {
    const source = await readFile(filesToolTabUrl, "utf8");

    assert.match(source, /const overlayPreviewOptions = \{[^}]*overflow:\s*\{[^}]*x:\s*"hidden"[^}]*y:\s*"scroll"/s);
    assert.match(source, /class="preview-text"\s+options=\{overlayPreviewOptions\}/s);
    assert.match(source, /class="image-preview"\s+options=\{overlayPreviewOptions\}/s);
    assert.match(source, /\.preview-content\s*\{[^}]*overflow:\s*hidden;/s);
    assert.match(source, /\.preview-content header\s*\{[^}]*overflow:\s*hidden;/s);
  });
});
