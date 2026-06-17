/*
 * Test content:
 *
 * Feature:
 * Verifies the Files ToolTab ripgrep search user interface contract.
 *
 * Operation:
 * Reads the Files ToolTab source and checks that the search bar exposes name
 * and content modes, hidden/no-ignore/symlink toggles, sends the matching
 * fields to the `searchFiles` Tauri command, and renders content-match line
 * details when the backend returns `rg --json` matches.
 *
 * Expected:
 * The frontend can request both name and content search, maps every visible
 * search option into the backend payload, and shows line numbers and matching
 * line text without relying on a real Tauri WebView or platform-specific
 * binaries.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const filesToolTabSourceUrl = new URL("../src/lib/files/FilesToolTab.svelte", import.meta.url);

describe("Files ToolTab ripgrep search UI source", () => {
  it("exposes ripgrep search modes and sends every option to searchFiles", async () => {
    const source = await readFile(filesToolTabSourceUrl, "utf8");
    const searchCall = source.match(/commands\.searchFiles\(\{([\s\S]*?)\}\)/)?.[1] ?? "";

    assert.match(source, /let searchMode = \$state<"name" \| "content">/);
    assert.match(source, /let searchIgnoreIgnoreFiles = \$state\(false\)/);
    assert.match(source, /let searchFollowSymlinks = \$state\(false\)/);
    assert.match(searchCall, /mode:\s*searchMode/);
    assert.match(searchCall, /ignore_ignore_files:\s*searchIgnoreIgnoreFiles/);
    assert.match(searchCall, /follow_symlinks:\s*searchFollowSymlinks/);
    assert.doesNotMatch(searchCall, /follow_symlinks:\s*false/);
    assert.match(source, /!helper\.available && searchMode === "name"/);
  });

  it("renders content match line details from ripgrep json results", async () => {
    const source = await readFile(filesToolTabSourceUrl, "utf8");

    assert.match(source, /match\.line_number/);
    assert.match(source, /match\.line_text/);
    assert.match(source, /search-match-line/);
  });
});
