/*
 * Test content:
 *
 * Feature:
 * Files context menu actions for selection-scoped file operations.
 *
 * Operation:
 * Builds context menu action models for empty, single-item, and multi-item
 * selections with and without chmod provider capability.
 *
 * Expected:
 * Rename is available only for a single selected item, Permissions supports
 * multi-selection when chmod is available, and Delete, Copy, Cut, and Download
 * support every non-empty selection while remaining out of the toolbar model.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  filesSelectionContextMenuActions,
  type FilesContextMenuActionId,
} from "../src/lib/files/context-menu";

describe("Files context menu actions", () => {
  it("disables every selection action when no file entry is selected", () => {
    const actions = filesSelectionContextMenuActions(0, { canChmod: true });

    assert.deepEqual(actionDisabledMap(actions), {
      rename: true,
      permissions: true,
      delete: true,
      copy: true,
      cut: true,
      download: true,
    });
  });

  it("enables every selection action for one selected item when chmod is available", () => {
    const actions = filesSelectionContextMenuActions(1, { canChmod: true });

    assert.deepEqual(actionDisabledMap(actions), {
      rename: false,
      permissions: false,
      delete: false,
      copy: false,
      cut: false,
      download: false,
    });
  });

  it("keeps Rename single-selection only while allowing Permissions and transfer actions for multiple items", () => {
    const actions = filesSelectionContextMenuActions(3, { canChmod: true });

    assert.deepEqual(actionDisabledMap(actions), {
      rename: true,
      permissions: false,
      delete: false,
      copy: false,
      cut: false,
      download: false,
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
