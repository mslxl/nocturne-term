/*
 * Test content:
 *
 * Feature:
 * Files toolbar action visibility and ordering settings.
 *
 * Operation:
 * Normalizes configured toolbar action ids from ordered setting lists that may
 * include hidden actions, duplicate ids, unknown ids, legacy Files actions, or
 * no usable ids.
 *
 * Expected:
 * The normalized toolbar action ids preserve the configured display order,
 * omit duplicates, unknown ids, legacy split-upload/navigation actions, and
 * selection-scoped context-menu actions, allow hiding omitted actions, and fall
 * back to the built-in Files toolbar order when the setting has no usable
 * action. The built-in order is Upload, New Folder, Refresh, View Mode.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  DEFAULT_FILES_TOOLBAR_ACTION_IDS,
  filesToolbarActionIdsFromSettingText,
  filesToolbarActionSettingText,
  normalizeFilesToolbarActionIds,
} from "../src/lib/files/toolbar-actions";

describe("Files toolbar action settings", () => {
  it("uses the Finder-style directory toolbar as the built-in order", () => {
    assert.deepEqual(DEFAULT_FILES_TOOLBAR_ACTION_IDS, ["upload", "new_folder", "refresh", "view_mode"]);
  });

  it("uses the configured toolbar action order and hides omitted actions", () => {
    assert.deepEqual(normalizeFilesToolbarActionIds(["refresh", "upload"]), ["refresh", "upload"]);
  });

  it("omits duplicate, unknown, and legacy toolbar action ids", () => {
    assert.deepEqual(
      normalizeFilesToolbarActionIds(["upload_files", "unknown", "upload", "upload", "up", "upload_folder", "view_mode"]),
      ["upload", "view_mode"],
    );
  });

  it("omits selection-scoped file actions because they belong to the context menu", () => {
    assert.deepEqual(
      normalizeFilesToolbarActionIds(["rename", "permissions", "delete", "copy", "cut", "download", "copy_path", "refresh"]),
      ["refresh"],
    );
  });

  it("falls back to the default toolbar order when no configured action is usable", () => {
    assert.deepEqual(normalizeFilesToolbarActionIds([]), DEFAULT_FILES_TOOLBAR_ACTION_IDS);
    assert.deepEqual(normalizeFilesToolbarActionIds(["unknown"]), DEFAULT_FILES_TOOLBAR_ACTION_IDS);
  });

  it("round-trips textarea setting text through toolbar action ids", () => {
    const text = "upload\nrefresh\nview_mode\n";
    assert.deepEqual(filesToolbarActionIdsFromSettingText(text), ["upload", "refresh", "view_mode"]);
    assert.equal(filesToolbarActionSettingText(["upload", "refresh", "view_mode"]), "upload\nrefresh\nview_mode");
  });
});
