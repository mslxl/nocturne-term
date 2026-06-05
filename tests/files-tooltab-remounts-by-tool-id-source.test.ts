/*
 * Test content:
 *
 * Feature:
 * Verifies that the Files ToolTab UI does not reuse local browsing state when
 * the active Files ToolTab changes to another Workspace or Host.
 *
 * Operation:
 * Reads the main Svelte route source and inspects the Files ToolTab rendering
 * branch. The FilesToolTab component must be wrapped in a Svelte key block that
 * uses the Workspace ToolTab id.
 *
 * Expected:
 * Switching from a Local Files ToolTab to an SSH/SFTP Files ToolTab remounts the
 * component and clears view-local state such as the last path. While the remote
 * directory is still loading, the address field must not show the previous
 * local desktop path.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pageSourceUrl = new URL("../src/routes/+page.svelte", import.meta.url);

describe("Files ToolTab remount identity", () => {
  it("keys FilesToolTab rendering by Workspace ToolTab id", async () => {
    const source = await readFile(pageSourceUrl, "utf8");
    const filesBranch = source.match(/{:else if tool\.kind === "files"}[\s\S]*?{:else if tool\.kind === "transfers"}/)?.[0] ?? "";

    assert.match(filesBranch, /{#key\s+tool\.id}/, "FilesToolTab must remount when the active ToolTab id changes.");
    assert.match(filesBranch, /<FilesToolTab\b/, "The keyed branch must render FilesToolTab.");
    assert.match(filesBranch, /{\/key}/, "The FilesToolTab key block must be closed before the next ToolTab branch.");
  });
});
