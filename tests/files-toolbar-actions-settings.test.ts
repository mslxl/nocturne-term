/*
 * Test content:
 *
 * Feature:
 * Files toolbar action visibility and ordering settings.
 *
 * Operation:
 * Normalizes configured toolbar action ids from ordered setting lists that may
 * include hidden actions, duplicate ids, unknown ids, or no usable ids.
 *
 * Expected:
 * The normalized toolbar action ids preserve the configured display order,
 * omit duplicates, unknown ids, and selection-scoped context-menu actions,
 * allow hiding omitted actions, and fall back to the built-in Files toolbar
 * order when the setting has no usable action.
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
  it("uses the configured toolbar action order and hides omitted actions", () => {
    assert.deepEqual(normalizeFilesToolbarActionIds(["search", "refresh", "path"]), ["search", "refresh", "path"]);
  });

  it("omits duplicate and unknown toolbar action ids", () => {
    assert.deepEqual(normalizeFilesToolbarActionIds(["search", "unknown", "search", "up", "view_mode"]), ["search", "up", "view_mode"]);
  });

  it("omits selection-scoped file actions because they belong to the context menu", () => {
    assert.deepEqual(
      normalizeFilesToolbarActionIds(["rename", "permissions", "delete", "copy", "cut", "download", "refresh", "path"]),
      ["refresh", "path"],
    );
  });

  it("falls back to the default toolbar order when no configured action is usable", () => {
    assert.deepEqual(normalizeFilesToolbarActionIds([]), DEFAULT_FILES_TOOLBAR_ACTION_IDS);
    assert.deepEqual(normalizeFilesToolbarActionIds(["unknown"]), DEFAULT_FILES_TOOLBAR_ACTION_IDS);
  });

  it("round-trips textarea setting text through toolbar action ids", () => {
    const text = "search\nrefresh\npath\n";
    assert.deepEqual(filesToolbarActionIdsFromSettingText(text), ["search", "refresh", "path"]);
    assert.equal(filesToolbarActionSettingText(["search", "refresh", "path"]), "search\nrefresh\npath");
  });
});
