/*
 * Test content:
 *
 * Feature:
 * Verifies that Files provider Tauri commands do not run blocking local or SFTP
 * file work directly on the command handler path.
 *
 * Operation:
 * Reads the Rust Files command source and checks every Files command used by
 * browsing, preview, search, and file mutations. Each command must be declared
 * as an async Tauri command and must delegate to the shared blocking worker
 * helper before executing provider-specific filesystem or SFTP operations.
 *
 * Expected:
 * Listing, creating directories, renaming, chmod, deleting, remote trash checks,
 * remote helper checks, trashing, previewing, and searching are all async
 * wrappers. Slow remote SFTP operations therefore cannot freeze the app while
 * the WebView waits for a command response.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const filesSourceUrl = new URL("../src-tauri/src/files.rs", import.meta.url);

const fileCommands = [
  "list_files",
  "create_directory",
  "rename_file",
  "chmod_file",
  "delete_file",
  "remote_trash_info",
  "remote_search_helper_info",
  "trash_file",
  "preview_file",
  "search_files",
] as const;

describe("Remote file command async dispatch", () => {
  it("runs Files Tauri commands through an async blocking-worker wrapper", async () => {
    const source = await readFile(filesSourceUrl, "utf8");

    assert.match(
      source,
      /async\s+fn\s+run_file_command<[\s\S]*?tauri::async_runtime::spawn_blocking/,
      "Files commands need a shared async helper that offloads blocking provider work.",
    );

    for (const command of fileCommands) {
      const commandBodyPattern = new RegExp(
        String.raw`#\[tauri::command\]\s*#\[specta::specta\]\s*pub\(crate\)\s+async\s+fn\s+${command}\s*\([\s\S]*?\)\s*->\s*Result<[\s\S]*?>\s*\{([\s\S]*?)\n\}\n\nfn\s+${command}_blocking`,
      );
      const match = source.match(commandBodyPattern);
      assert.ok(match, `${command} must be an async command followed by ${command}_blocking.`);
      const body = match[1];
      assert.match(body, new RegExp(String.raw`run_file_command\("${command}",`));
      assert.match(body, new RegExp(String.raw`${command}_blocking\(app,\s*input\)`));
    }
  });
});
