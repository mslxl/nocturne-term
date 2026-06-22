/*
 * Test content:
 *
 * Feature:
 * Files Columns view initialization for Windows virtual roots.
 *
 * Operation:
 * Inspects the Files ToolTab source to verify that Columns mode preloads the
 * ancestor directory chain for the current focus path, normalizes path keys,
 * and converts a Windows drive display path such as C: into C:/ before asking
 * the provider to list that directory.
 *
 * Expected:
 * The component has an explicit Columns ancestor preloading effect, uses the
 * shared Columns path-chain helper, stores child directory results under
 * normalized keys, and requests drive roots with a trailing slash so Windows
 * lists the drive root instead of a process-local drive working directory.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "vitest";
import assert from "node:assert/strict";

describe("Files Columns ancestor preload source contract", () => {
  const source = readFileSync(resolve("src/lib/files/FilesToolTab.svelte"), "utf8");

  it("preloads Columns ancestor directories without replacing the current focus", () => {
    assert.match(source, /function\s+preloadColumnsAncestorDirectories\(rootPath:\s*string,\s*currentDirectoryPath:\s*string\)/);
    assert.match(source, /columnAncestorDirectoryPaths\(rootPath,\s*currentDirectoryPath\)/);
    assert.match(source, /columnsForPath\(current\)\.map\(normalizeFilePath\)/);
    assert.match(source, /await\s+reloadDirectoryChildren\(directoryPath\)/);
  });

  it("normalizes cached child-directory keys and requests Windows drive roots with a slash", () => {
    assert.match(source, /const\s+normalizedDirectoryPath\s*=\s*normalizeFilePath\(directoryPath\);/);
    assert.match(source, /\[normalizedDirectoryPath\]:\s*childResult\.entries/);
    assert.match(source, /function\s+providerDirectoryRequestPath\(pathValue:\s*string\)/);
    assert.match(source, /\^\[A-Za-z\]:\$/);
    assert.match(source, /`\$\{pathValue\}\/`/);
  });
});
