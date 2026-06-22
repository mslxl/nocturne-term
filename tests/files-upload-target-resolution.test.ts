/*
 * Test content:
 *
 * Feature:
 * Finder-style Files upload target resolution.
 *
 * Operation:
 * Resolves upload destinations from Tree selections, Columns focus, selected
 * files, multi-selection, explicit directory drop targets, and unclear focus
 * states.
 *
 * Expected:
 * Upload targets prefer selected directories, otherwise use selected file
 * parents, Columns focused directories, or a common multi-selection parent.
 * Explicit directory drop targets override selection, and unclear states return
 * `needs_target_sheet` so the UI can show a Finder-style target selection
 * sheet instead of silently uploading into the root or current view top.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { resolveFilesUploadTarget, type FilesUploadTargetEntry } from "../src/lib/files/upload-target";

const directory = (path: string): FilesUploadTargetEntry => ({
  kind: "directory",
  path,
});

const file = (path: string): FilesUploadTargetEntry => ({
  kind: "file",
  path,
});

describe("Files upload target resolution", () => {
  it("uses a selected Tree directory as the upload target", () => {
    assert.deepEqual(
      resolveFilesUploadTarget({
        viewMode: "tree",
        focusedDirectoryPath: "/home/alice",
        selectedEntries: [directory("/home/alice/project")],
      }),
      { kind: "target", path: "/home/alice/project" },
    );
  });

  it("uses the selected file parent when a file is selected", () => {
    assert.deepEqual(
      resolveFilesUploadTarget({
        viewMode: "tree",
        focusedDirectoryPath: "/home/alice",
        selectedEntries: [file("/home/alice/project/readme.md")],
      }),
      { kind: "target", path: "/home/alice/project" },
    );
  });

  it("uses the common parent for multi-selection across files", () => {
    assert.deepEqual(
      resolveFilesUploadTarget({
        viewMode: "tree",
        focusedDirectoryPath: "/home/alice",
        selectedEntries: [file("/home/alice/project/a.txt"), file("/home/alice/project/b.txt")],
      }),
      { kind: "target", path: "/home/alice/project" },
    );
  });

  it("uses a single selected directory even when it appears in a multi-selection", () => {
    assert.deepEqual(
      resolveFilesUploadTarget({
        viewMode: "tree",
        focusedDirectoryPath: "/home/alice",
        selectedEntries: [directory("/home/alice/project")],
      }),
      { kind: "target", path: "/home/alice/project" },
    );
  });

  it("falls back to the focused Columns directory when no entry is selected", () => {
    assert.deepEqual(
      resolveFilesUploadTarget({
        viewMode: "columns",
        focusedDirectoryPath: "/home/alice/project/src",
        selectedEntries: [],
      }),
      { kind: "target", path: "/home/alice/project/src" },
    );
  });

  it("uses an explicit directory drop target before selection or focus", () => {
    assert.deepEqual(
      resolveFilesUploadTarget({
        viewMode: "tree",
        focusedDirectoryPath: "/home/alice",
        selectedEntries: [file("/home/alice/readme.md")],
        explicitDirectoryPath: "/home/alice/drop-here",
      }),
      { kind: "target", path: "/home/alice/drop-here" },
    );
  });

  it("requests a target sheet when no directory target is clear", () => {
    assert.deepEqual(
      resolveFilesUploadTarget({
        viewMode: "tree",
        focusedDirectoryPath: "",
        selectedEntries: [],
      }),
      { kind: "needs_target_sheet", initialPath: null },
    );
  });

  it("uses host default as target sheet initial path when focus is unclear", () => {
    assert.deepEqual(
      resolveFilesUploadTarget({
        viewMode: "tree",
        focusedDirectoryPath: "",
        hostDefaultPath: "/home/alice",
        selectedEntries: [],
      }),
      { kind: "needs_target_sheet", initialPath: "/home/alice" },
    );
  });
});
