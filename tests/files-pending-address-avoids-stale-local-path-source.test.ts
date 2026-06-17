/*
 * Test content:
 *
 * Feature:
 * Verifies that the Files address field does not display stale local browsing
 * paths while a new Files provider request is still pending.
 *
 * Operation:
 * Reads the FilesToolTab Svelte source and inspects the derived address/path
 * expression and toolbar rendering. The displayed path must use the provider
 * result when available, otherwise the ToolTab title, not the previous local
 * path state.
 *
 * Expected:
 * When switching from a Local Files ToolTab to an SSH/SFTP Files ToolTab, the
 * address field does not show the old local desktop path before the remote
 * provider returns its current path.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const filesToolTabUrl = new URL("../src/lib/files/FilesToolTab.svelte", import.meta.url);

describe("Files pending address path", () => {
  it("falls back to the ToolTab title instead of stale view-local path state", async () => {
    const source = await readFile(filesToolTabUrl, "utf8");
    const currentPathExpression =
      source.match(/const\s+currentPath\s*=\s*\$derived\((?<expression>.*?)\);/)?.groups?.expression ?? "";

    assert.notEqual(currentPathExpression, "", "FilesToolTab must define a currentPath derived expression.");
    assert.match(currentPathExpression, /result\?\.provider\.current_path/, "currentPath must prefer the provider current path.");
    assert.match(currentPathExpression, /toolTab\.title/, "currentPath must have a ToolTab title fallback.");
    assert.doesNotMatch(
      currentPathExpression,
      /\?\?\s*path\s*\?\?/,
      "currentPath must not show stale path state while a new provider request is pending.",
    );
  });
});
