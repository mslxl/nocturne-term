/*
 * Test content:
 *
 * Feature:
 * Verifies that Terminal and Files frontend command calls are scoped through
 * the active Workspace and ToolTab instead of trusting a frontend-supplied host
 * id for provider authentication.
 *
 * Operation:
 * Reads the Svelte frontend sources for Terminal creation and Files provider
 * commands. The test checks that terminal session creation sends
 * `workspace_id` and `tool_tab_id`, that Files command auth includes
 * `workspace_id` and `tool_tab_id`, and that Files provider command payloads no
 * longer include `host_id`.
 *
 * Expected:
 * Terminal and Files commands derive the Host in Rust from authoritative
 * Workspace/ToolTab state. A password accepted for one Workspace can be stored
 * as that Workspace's encrypted temporary credential and reused by Files in the
 * same Workspace without accidentally crossing into another Workspace.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pageSourceUrl = new URL("../src/routes/+page.svelte", import.meta.url);
const filesToolTabSourceUrl = new URL("../src/lib/files/FilesToolTab.svelte", import.meta.url);

const filesCommandNames = [
  "listFiles",
  "previewFile",
  "createDirectory",
  "renameFile",
  "chmodFile",
  "deleteFile",
  "remoteTrashInfo",
  "remoteSearchHelperInfo",
  "trashFile",
  "searchFiles",
] as const;

describe("Workspace-scoped Terminal and Files command inputs", () => {
  it("creates terminal sessions with workspace and ToolTab ids", async () => {
    const source = await readFile(pageSourceUrl, "utf8");
    const createCalls = Array.from(source.matchAll(/commands\.createHostTerminalSession\(\{([\s\S]*?)\}\)/g));

    assert.ok(createCalls.length >= 1, "Terminal session creation command calls must exist.");
    for (const [, body] of createCalls) {
      assert.match(body, /workspace_id:\s*workspaceId/);
      assert.match(body, /tool_tab_id:\s*toolTabId/);
      assert.doesNotMatch(body, /connection_host_id:/);
    }
  });

  it("sends Files provider commands through workspace and ToolTab scoped auth", async () => {
    const source = await readFile(filesToolTabSourceUrl, "utf8");
    const authBody = source.match(/function providerCommandAuth\(\) \{\s*return \{([\s\S]*?)\};\s*\}/)?.[1] ?? "";

    assert.match(authBody, /workspace_id:\s*workspaceId/);
    assert.match(authBody, /tool_tab_id:\s*toolTab\.id/);

    for (const commandName of filesCommandNames) {
      const calls = Array.from(source.matchAll(new RegExp(String.raw`commands\.${commandName}\(\{([\s\S]*?)\}\)`, "g")));
      assert.ok(calls.length >= 1, `${commandName} should be exercised by the Files ToolTab source.`);
      for (const [, body] of calls) {
        assert.match(body, /\.\.\.providerCommandAuth\(\)/, `${commandName} must include Workspace/ToolTab auth scope.`);
        assert.doesNotMatch(body, /host_id:\s*toolTab\.host_id/, `${commandName} must not trust a frontend host id.`);
      }
    }
  });
});
