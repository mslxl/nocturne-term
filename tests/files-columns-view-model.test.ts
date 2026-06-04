/*
 * Test content:
 *
 * Feature:
 * Finder-style Files Columns view model.
 *
 * Operation:
 * Builds Columns view data for a current directory, a selected child
 * directory, and loaded child entries for the selected directory chain.
 *
 * Expected:
 * The first column contains the current directory entries, selecting a
 * directory opens its children in the next column without replacing the first
 * column, selecting a nested directory opens a third column, and deeper
 * selections keep the visible model capped to a Finder-style three-column
 * window. A selected directory whose children are still loading keeps an empty
 * right-side column so the UI does not temporarily collapse from two columns
 * back to one column.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFilesColumnsView, columnsForPath, columnsForVisiblePane } from "../src/lib/files/columns";

describe("Files Columns view model", () => {
  it("opens selected directory children to the right without replacing the current column", () => {
    const columns = buildFilesColumnsView({
      currentPath: "/Users/alice",
      selectedPath: "/Users/alice/project",
      activeEntries: [
        { kind: "directory", name: "project", path: "/Users/alice/project", size: null },
        { kind: "file", name: "notes.txt", path: "/Users/alice/notes.txt", size: "512" },
      ],
      childrenByPath: {
        "/Users/alice/project": [
          { kind: "directory", name: "src", path: "/Users/alice/project/src", size: null },
          { kind: "file", name: "README.md", path: "/Users/alice/project/README.md", size: "2048" },
        ],
      },
    });

    assert.deepEqual(
      columns.map((column) => column.path),
      ["/Users/alice", "/Users/alice/project"],
    );
    assert.deepEqual(columns[0].entries.map((entry) => entry.path), ["/Users/alice/project", "/Users/alice/notes.txt"]);
    assert.deepEqual(columns[1].entries.map((entry) => entry.path), [
      "/Users/alice/project/src",
      "/Users/alice/project/README.md",
    ]);
    assert.equal(columns[0].entries[0].selected, true);
    assert.equal(columns[1].entries[0].selected, false);
  });

  it("keeps a right-side column for a selected directory while children are loading", () => {
    const columns = buildFilesColumnsView({
      currentPath: "/Users/alice",
      selectedPath: "/Users/alice/project",
      activeEntries: [
        { kind: "directory", name: "project", path: "/Users/alice/project", size: null },
        { kind: "file", name: "notes.txt", path: "/Users/alice/notes.txt", size: "512" },
      ],
      childrenByPath: {},
    });

    assert.deepEqual(
      columns.map((column) => column.path),
      ["/Users/alice", "/Users/alice/project"],
    );
    assert.deepEqual(columns[1].entries, []);
    assert.equal(columns[0].entries[0].selected, true);
  });

  it("opens a third column when a nested directory is selected", () => {
    const columns = buildFilesColumnsView({
      currentPath: "/Users/alice",
      selectedPath: "/Users/alice/project/src",
      activeEntries: [{ kind: "directory", name: "project", path: "/Users/alice/project", size: null }],
      childrenByPath: {
        "/Users/alice/project": [{ kind: "directory", name: "src", path: "/Users/alice/project/src", size: null }],
        "/Users/alice/project/src": [{ kind: "file", name: "main.ts", path: "/Users/alice/project/src/main.ts", size: "1024" }],
      },
    });

    assert.deepEqual(
      columns.map((column) => column.path),
      ["/Users/alice", "/Users/alice/project", "/Users/alice/project/src"],
    );
    assert.deepEqual(columns[2].entries.map((entry) => entry.path), ["/Users/alice/project/src/main.ts"]);
    assert.equal(columns[0].entries[0].selected, true);
    assert.equal(columns[1].entries[0].selected, true);
  });

  it("keeps only a three-column window when the selected directory is deeper than three levels", () => {
    const columns = buildFilesColumnsView({
      currentPath: "/Users/alice",
      selectedPath: "/Users/alice/project/src/client",
      activeEntries: [{ kind: "directory", name: "project", path: "/Users/alice/project", size: null }],
      childrenByPath: {
        "/Users/alice/project": [{ kind: "directory", name: "src", path: "/Users/alice/project/src", size: null }],
        "/Users/alice/project/src": [{ kind: "directory", name: "client", path: "/Users/alice/project/src/client", size: null }],
        "/Users/alice/project/src/client": [
          { kind: "directory", name: "components", path: "/Users/alice/project/src/client/components", size: null },
          { kind: "file", name: "index.ts", path: "/Users/alice/project/src/client/index.ts", size: "128" },
        ],
      },
    });

    assert.deepEqual(
      columns.map((column) => column.path),
      ["/Users/alice/project", "/Users/alice/project/src", "/Users/alice/project/src/client"],
    );
    assert.deepEqual(columns[0].entries.map((entry) => entry.path), ["/Users/alice/project/src"]);
    assert.deepEqual(columns[1].entries.map((entry) => entry.path), ["/Users/alice/project/src/client"]);
    assert.deepEqual(columns[2].entries.map((entry) => entry.path), [
      "/Users/alice/project/src/client/components",
      "/Users/alice/project/src/client/index.ts",
    ]);
  });

  it("keeps two data columns available when preview occupies the third visible column", () => {
    const columns = buildFilesColumnsView({
      currentPath: "/Users/alice",
      selectedPath: "/Users/alice/project/src/main.ts",
      activeEntries: [{ kind: "directory", name: "project", path: "/Users/alice/project", size: null }],
      childrenByPath: {
        "/Users/alice/project": [{ kind: "directory", name: "src", path: "/Users/alice/project/src", size: null }],
        "/Users/alice/project/src": [{ kind: "file", name: "main.ts", path: "/Users/alice/project/src/main.ts", size: "1024" }],
      },
    });

    assert.deepEqual(
      columns.map((column) => column.path),
      ["/Users/alice", "/Users/alice/project", "/Users/alice/project/src"],
    );
    assert.deepEqual(
      columnsForVisiblePane(columns, { previewVisible: true }).map((column) => column.path),
      ["/Users/alice/project", "/Users/alice/project/src"],
    );
    assert.deepEqual(
      columnsForVisiblePane(columns, { previewVisible: false }).map((column) => column.path),
      ["/Users/alice", "/Users/alice/project", "/Users/alice/project/src"],
    );
  });

  it("normalizes Windows drive paths without platform-specific branching", () => {
    assert.deepEqual(columnsForPath("C:\\Users\\alice"), ["C:", "C:/Users", "C:/Users/alice"]);
  });
});
