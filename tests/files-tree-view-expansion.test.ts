/*
Feature: Files Tree view expansion.
Operation: Build Tree view rows from root entries plus lazily loaded child entries and activate a directory row with click and double-click actions.
Expected: Expanded directories reveal indented child rows without changing the current browser path, clicking any directory row area maps to a Tree expansion toggle, and directory double-click does not perform a second toggle or path navigation.
*/
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  buildFileTreeRows,
  fileTreeClickAction,
  fileTreeDoubleClickAction,
  type FileTreeEntry,
} from "../src/lib/files/tree";

describe("Files Tree view expansion", () => {
  it("reveals lazily loaded children under an expanded directory", () => {
    const rows = buildFileTreeRows({
      rootEntries: [entry("src", "/repo/src", "directory"), entry("README.md", "/repo/README.md", "file")],
      childrenByPath: {
        "/repo/src": [entry("main.ts", "/repo/src/main.ts", "file")],
      },
      expandedPaths: new Set(["/repo/src"]),
      loadingPaths: new Set(),
      errorByPath: new Map(),
    });

    assert.deepEqual(
      rows.map((row) => ({ name: row.entry.name, depth: row.depth, expanded: row.expanded })),
      [
        { name: "src", depth: 0, expanded: true },
        { name: "main.ts", depth: 1, expanded: false },
        { name: "README.md", depth: 0, expanded: false },
      ],
    );
  });

  it("keeps collapsed directory children out of the visible Tree rows", () => {
    const rows = buildFileTreeRows({
      rootEntries: [entry("src", "/repo/src", "directory")],
      childrenByPath: {
        "/repo/src": [entry("main.ts", "/repo/src/main.ts", "file")],
      },
      expandedPaths: new Set(),
      loadingPaths: new Set(),
      errorByPath: new Map(),
    });

    assert.deepEqual(rows.map((row) => row.entry.name), ["src"]);
  });

  it("ignores directory double-click activation after the row click has already toggled expansion", () => {
    assert.equal(fileTreeDoubleClickAction(entry("src", "/repo/src", "directory")), "ignore-directory");
    assert.equal(fileTreeDoubleClickAction(entry("README.md", "/repo/README.md", "file")), "select-file");
  });

  it("treats directory row clicks as Tree toggles from any row area", () => {
    assert.equal(fileTreeClickAction(entry("src", "/repo/src", "directory")), "toggle-directory");
    assert.equal(fileTreeClickAction(entry("README.md", "/repo/README.md", "file")), "select-file");
  });
});

function entry(name: string, path: string, kind: FileTreeEntry["kind"]): FileTreeEntry {
  return {
    name,
    path,
    kind,
    size: null,
    modified_unix_ms: null,
    permissions: null,
    owner: null,
    group: null,
    symlink_target: null,
  };
}
