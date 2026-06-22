/*
 * Test content:
 *
 * Feature:
 * Files context menu actions for selection-scoped file operations.
 *
 * Operation:
 * Builds context menu models for empty, single-item, and multi-item selections
 * with and without chmod provider capability.
 *
 * Expected:
 * Rename is available only for a single selected item, Permissions supports
 * multi-selection when chmod is available, Copy Path is available for every
 * non-empty selection, Delete is marked dangerous, and the shared action order
 * is Download, Rename, Copy, Cut, Permissions, Copy Path, Delete.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  filesSelectionContextMenuActions,
  type FilesContextMenuActionId,
} from "../src/lib/files/context-menu";

describe("Files context menu actions", () => {
  it("uses the shared Finder-style selection action order", () => {
    const actions = filesSelectionContextMenuActions(1, { canChmod: true });

    assert.deepEqual(actions.map((action) => action.id), ["download", "rename", "copy", "cut", "permissions", "copy_path", "delete"]);
    assert.equal(actions.at(-1)?.dangerous, true);
  });

  it("disables every selection action when no file entry is selected", () => {
    const actions = filesSelectionContextMenuActions(0, { canChmod: true });

    assert.deepEqual(actionDisabledMap(actions), {
      download: true,
      rename: true,
      copy: true,
      cut: true,
      permissions: true,
      copy_path: true,
      delete: true,
    });
  });

  it("enables every selection action for one selected item when chmod is available", () => {
    const actions = filesSelectionContextMenuActions(1, { canChmod: true });

    assert.deepEqual(actionDisabledMap(actions), {
      download: false,
      rename: false,
      copy: false,
      cut: false,
      permissions: false,
      copy_path: false,
      delete: false,
    });
  });

  it("keeps Rename single-selection only while allowing Permissions and transfer actions for multiple items", () => {
    const actions = filesSelectionContextMenuActions(3, { canChmod: true });

    assert.deepEqual(actionDisabledMap(actions), {
      download: false,
      rename: true,
      copy: false,
      cut: false,
      permissions: false,
      copy_path: false,
      delete: false,
    });
  });

  it("disables Permissions when the provider cannot chmod even for a multi-selection", () => {
    const actions = filesSelectionContextMenuActions(2, { canChmod: false });

    assert.equal(actionDisabledMap(actions).permissions, true);
  });
});

function actionDisabledMap(actions: ReturnType<typeof filesSelectionContextMenuActions>): Record<FilesContextMenuActionId, boolean> {
  return Object.fromEntries(actions.map((action) => [action.id, action.disabled])) as Record<FilesContextMenuActionId, boolean>;
}
