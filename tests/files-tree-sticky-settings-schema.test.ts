/*
 * Test content:
 *
 * Feature:
 * Global Files settings for Tree sticky parent directory rows.
 *
 * Operation:
 * Inspects the settings schema and i18n help text used by the Settings page.
 *
 * Expected:
 * The schema exposes enabled and bounded max-level controls with defaults that
 * match the Finder-style Tree design, serializes them to the files table, and
 * the toolbar help text documents only the supported directory-level toolbar
 * action ids instead of legacy split-upload, navigation, paste, search, or path
 * ids.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { settingsSchema } from "../src/lib/settings/schema";
import { messages } from "../src/lib/i18n/messages";

function setting(key: string) {
  const item = settingsSchema.find((definition) => definition.key === key);
  assert.ok(item, `Expected setting ${key} to exist.`);
  return item;
}

describe("Files Tree sticky settings schema", () => {
  it("exposes enabled and max-level controls with native Files defaults", () => {
    const enabled = setting("files.tree_sticky_enabled");
    assert.equal(enabled.category, "files");
    assert.equal(enabled.kind, "boolean");
    assert.equal(enabled.defaultValue, true);
    assert.deepEqual(enabled.path, ["files", "tree_sticky_enabled"]);

    const levels = setting("files.tree_sticky_max_levels");
    assert.equal(levels.category, "files");
    assert.equal(levels.kind, "select");
    assert.equal(levels.defaultValue, "3");
    assert.deepEqual(levels.path, ["files", "tree_sticky_max_levels"]);
    assert.deepEqual(
      levels.options?.map((option) => option.value),
      ["1", "2", "3", "4", "5"],
    );
  });

  it("reads and writes the sticky settings under the files table", () => {
    const root = {
      values: {
        files: {
          kind: "Table" as const,
          value: {
            tree_sticky_enabled: { kind: "Boolean" as const, value: false },
            tree_sticky_max_levels: { kind: "Integer" as const, value: "5" },
          },
        },
      },
    };

    const enabled = setting("files.tree_sticky_enabled");
    const levels = setting("files.tree_sticky_max_levels");

    assert.equal(enabled.get(root), false);
    assert.deepEqual(enabled.toConfigValue(true), { kind: "Boolean", value: true });
    assert.equal(levels.get(root), "5");
    assert.deepEqual(levels.toConfigValue("2"), { kind: "Integer", value: "2" });
  });

  it("documents only supported toolbar ids in settings help text", () => {
    const help = messages.en.filesToolbarActionsHelp;
    assert.match(help, /upload, new_folder, refresh, view_mode/);
    for (const legacyId of ["up", "paste", "upload_files", "upload_folder", "search", "path"]) {
      assert.doesNotMatch(help, new RegExp(`\\b${legacyId}\\b`));
    }
  });
});
