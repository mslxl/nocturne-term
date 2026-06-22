/*
 * Test content:
 *
 * Feature:
 * Verifies that Files Tree rows keep metadata columns aligned when file or
 * directory names are longer than the available Name column width.
 *
 * Operation:
 * Reads the FilesToolTab Svelte source and inspects the Tree row markup and
 * stylesheet rules used by the Name column.
 *
 * Expected:
 * Tree row names are wrapped in a dedicated truncation element inside the
 * flex-based name cell. The wrapper has min-width: 0 plus overflow ellipsis
 * rules, so long names shrink within the Name column instead of pushing Size,
 * Modified, or Permissions columns out of alignment.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const filesToolTabUrl = new URL("../src/lib/files/FilesToolTab.svelte", import.meta.url);

describe("Files Tree long-name alignment source", () => {
  it("wraps Tree file names in a shrinkable ellipsis element", async () => {
    const source = await readFile(filesToolTabUrl, "utf8");

    assert.match(source, /<span\s+class="file-name-text">\{row\.entry\.name\}<\/span>/);
    assert.match(
      source,
      /\.file-name-text\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s,
    );
  });
});
