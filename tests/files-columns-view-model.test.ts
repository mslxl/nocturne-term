/*
 * Test content:
 *
 * Feature:
 * Finder-style Files Columns view model.
 *
 * Operation:
 * Builds Columns view data for a filesystem root, a current default/home
 * directory, selected child directories, and loaded child entries for the
 * selected directory chain.
 *
 * Expected:
 * The first column can be the filesystem root while the host default/home path
 * is only the initial focus, selecting a directory opens its children in the
 * next column without replacing the first column, selecting a nested directory
 * opens a third column, and deeper selections keep the full Finder-style
 * horizontal column chain instead of capping the model to three columns.
 * Windows-style paths keep the virtual filesystem root as the first model
 * column, then a drive-root column, then normal directory levels. A selected
 * directory whose children are still loading keeps an empty right-side column
 * so the UI does not temporarily collapse from two columns back to one column.
 * Selecting a file keeps every data column in the horizontally scrollable
 * strip and adds preview as a terminal column in the component.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { buildFilesColumnsView, columnsForPath, columnsForVisiblePane } from "../src/lib/files/columns";

describe("Files Columns view model", () => {
  it("uses the filesystem root as the first column while focusing the default home directory", () => {
    const columns = buildFilesColumnsView({
      rootPath: "/",
      currentPath: "/home/alice",
      selectedPath: "",
      activeEntries: [
        { kind: "directory", name: "project", path: "/home/alice/project", size: null },
        { kind: "file", name: "notes.txt", path: "/home/alice/notes.txt", size: "512" },
      ],
      childrenByPath: {},
    });

    assert.deepEqual(
      columns.map((column) => column.path),
      ["/", "/home", "/home/alice"],
    );
    assert.deepEqual(columns[0].entries.map((entry) => ({ name: entry.name, path: entry.path, selected: entry.selected })), [
      { name: "home", path: "/home", selected: true },
    ]);
    assert.deepEqual(columns[1].entries.map((entry) => ({ name: entry.name, path: entry.path, selected: entry.selected })), [
      { name: "alice", path: "/home/alice", selected: true },
    ]);
    assert.deepEqual(columns[2].entries.map((entry) => entry.path), ["/home/alice/project", "/home/alice/notes.txt"]);
  });

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

  it("keeps the full horizontal column chain when the selected directory is deeper than three levels", () => {
    const columns = buildFilesColumnsView({
      currentPath: "/Users/alice",
      selectedPath: "/Users/alice/project/src/client/components",
      activeEntries: [{ kind: "directory", name: "project", path: "/Users/alice/project", size: null }],
      childrenByPath: {
        "/Users/alice/project": [{ kind: "directory", name: "src", path: "/Users/alice/project/src", size: null }],
        "/Users/alice/project/src": [{ kind: "directory", name: "client", path: "/Users/alice/project/src/client", size: null }],
        "/Users/alice/project/src/client": [
          { kind: "directory", name: "components", path: "/Users/alice/project/src/client/components", size: null },
          { kind: "file", name: "index.ts", path: "/Users/alice/project/src/client/index.ts", size: "128" },
        ],
        "/Users/alice/project/src/client/components": [
          { kind: "file", name: "Button.svelte", path: "/Users/alice/project/src/client/components/Button.svelte", size: "128" },
        ],
      },
    });

    assert.deepEqual(
      columns.map((column) => column.path),
      [
        "/Users/alice",
        "/Users/alice/project",
        "/Users/alice/project/src",
        "/Users/alice/project/src/client",
        "/Users/alice/project/src/client/components",
      ],
    );
    assert.deepEqual(columns[0].entries.map((entry) => entry.path), ["/Users/alice/project"]);
    assert.deepEqual(columns[1].entries.map((entry) => entry.path), ["/Users/alice/project/src"]);
    assert.deepEqual(columns[2].entries.map((entry) => entry.path), ["/Users/alice/project/src/client"]);
    assert.deepEqual(columns[3].entries.map((entry) => entry.path), [
      "/Users/alice/project/src/client/components",
      "/Users/alice/project/src/client/index.ts",
    ]);
    assert.deepEqual(columns[4].entries.map((entry) => entry.path), ["/Users/alice/project/src/client/components/Button.svelte"]);
  });

  it("replaces stale descendant columns when selecting a sibling directory from an ancestor column", () => {
    const columns = buildFilesColumnsView({
      rootPath: "/Users/alice",
      currentPath: "/Users/alice/project/src/current",
      selectedPath: "/Users/alice/project/theta",
      activeEntries: [{ kind: "file", name: "current.txt", path: "/Users/alice/project/src/current/current.txt", size: "64" }],
      childrenByPath: {
        "/Users/alice": [{ kind: "directory", name: "project", path: "/Users/alice/project", size: null }],
        "/Users/alice/project": [
          { kind: "directory", name: "src", path: "/Users/alice/project/src", size: null },
          { kind: "directory", name: "theta", path: "/Users/alice/project/theta", size: null },
        ],
        "/Users/alice/project/src": [{ kind: "directory", name: "current", path: "/Users/alice/project/src/current", size: null }],
        "/Users/alice/project/theta": [{ kind: "file", name: "theta-leaf.txt", path: "/Users/alice/project/theta/theta-leaf.txt", size: "128" }],
      },
    });

    assert.deepEqual(
      columns.map((column) => column.path),
      ["/Users/alice", "/Users/alice/project", "/Users/alice/project/theta"],
    );
    assert.deepEqual(columns[1].entries.map((entry) => ({ path: entry.path, selected: entry.selected })), [
      { path: "/Users/alice/project/src", selected: false },
      { path: "/Users/alice/project/theta", selected: true },
    ]);
    assert.deepEqual(columns[2].entries.map((entry) => entry.path), ["/Users/alice/project/theta/theta-leaf.txt"]);
  });

  it("uses active entries for the selected directory after the provider current path changes", () => {
    const columns = buildFilesColumnsView({
      rootPath: "/Users/alice",
      currentPath: "/Users/alice/project/theta",
      selectedPath: "/Users/alice/project/theta",
      activeEntries: [{ kind: "file", name: "theta-leaf.txt", path: "/Users/alice/project/theta/theta-leaf.txt", size: "128" }],
      childrenByPath: {
        "/Users/alice": [{ kind: "directory", name: "project", path: "/Users/alice/project", size: null }],
        "/Users/alice/project": [
          { kind: "directory", name: "src", path: "/Users/alice/project/src", size: null },
          { kind: "directory", name: "theta", path: "/Users/alice/project/theta", size: null },
        ],
      },
    });

    assert.deepEqual(
      columns.map((column) => column.path),
      ["/Users/alice", "/Users/alice/project", "/Users/alice/project/theta"],
    );
    assert.deepEqual(columns[2].entries.map((entry) => entry.path), ["/Users/alice/project/theta/theta-leaf.txt"]);
  });

  it("keeps every data column available when preview occupies the terminal column", () => {
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
      ["/Users/alice", "/Users/alice/project", "/Users/alice/project/src"],
    );
    assert.deepEqual(
      columnsForVisiblePane(columns, { previewVisible: false }).map((column) => column.path),
      ["/Users/alice", "/Users/alice/project", "/Users/alice/project/src"],
    );
  });

  it("keeps preview as a terminal column when selecting a file", () => {
    const columns = buildFilesColumnsView({
      currentPath: "/Users/alice",
      selectedPath: "/Users/alice/project/src/main.ts",
      activeEntries: [{ kind: "directory", name: "project", path: "/Users/alice/project", size: null }],
      childrenByPath: {
        "/Users/alice/project": [{ kind: "directory", name: "src", path: "/Users/alice/project/src", size: null }],
        "/Users/alice/project/src": [{ kind: "file", name: "main.ts", path: "/Users/alice/project/src/main.ts", size: "1024" }],
      },
    });

    assert.equal(columns.at(-1)?.path, "/Users/alice/project/src");
    assert.equal(columns.at(-1)?.entries.find((entry) => entry.path === "/Users/alice/project/src/main.ts")?.selected, true);
    assert.deepEqual(
      columnsForVisiblePane(columns, { previewVisible: true }).map((column) => column.path),
      ["/Users/alice", "/Users/alice/project", "/Users/alice/project/src"],
    );
  });

  it("normalizes Windows drive paths without platform-specific branching", () => {
    assert.deepEqual(columnsForPath("C:\\Users\\alice"), ["C:", "C:/Users", "C:/Users/alice"]);
  });

  it("keeps the Windows virtual root and drive siblings when focusing a mixed-separator path", () => {
    const columns = buildFilesColumnsView({
      rootPath: "/",
      currentPath: "C:/Users\\alice",
      selectedPath: "",
      activeEntries: [{ kind: "directory", name: "project", path: "C:\\Users\\alice\\project", size: null }],
      childrenByPath: {
        "/": [
          { kind: "directory", name: "C:", path: "C:/", size: null },
          { kind: "directory", name: "D:", path: "D:/", size: null },
        ],
        "C:/": [
          { kind: "directory", name: "Program Files", path: "C:\\Program Files", size: null },
          { kind: "directory", name: "Users", path: "C:\\Users", size: null },
          { kind: "directory", name: "Windows", path: "C:\\Windows", size: null },
        ],
        "C:/Users": [
          { kind: "directory", name: "alice", path: "C:\\Users\\alice", size: null },
          { kind: "directory", name: "Public", path: "C:\\Users\\Public", size: null },
        ],
      },
    });

    assert.deepEqual(
      columns.map((column) => column.path),
      ["/", "C:", "C:/Users", "C:/Users/alice"],
    );
    assert.deepEqual(columns[0].entries.map((entry) => ({ name: entry.name, path: entry.path, selected: entry.selected })), [
      { name: "C:", path: "C:/", selected: true },
      { name: "D:", path: "D:/", selected: false },
    ]);
    assert.deepEqual(columns[1].entries.map((entry) => ({ name: entry.name, path: entry.path, selected: entry.selected })), [
      { name: "Program Files", path: "C:\\Program Files", selected: false },
      { name: "Users", path: "C:\\Users", selected: true },
      { name: "Windows", path: "C:\\Windows", selected: false },
    ]);
    assert.deepEqual(columns[2].entries.map((entry) => ({ name: entry.name, path: entry.path, selected: entry.selected })), [
      { name: "alice", path: "C:\\Users\\alice", selected: true },
      { name: "Public", path: "C:\\Users\\Public", selected: false },
    ]);
    assert.deepEqual(columns[3].entries.map((entry) => entry.path), ["C:\\Users\\alice\\project"]);
  });

  it("keeps a separate Windows drive-root column between the virtual root and home focus", () => {
    const columns = buildFilesColumnsView({
      rootPath: "/",
      currentPath: "C:\\Users\\alice",
      selectedPath: "",
      activeEntries: [{ kind: "directory", name: "Desktop", path: "C:\\Users\\alice\\Desktop", size: null }],
      childrenByPath: {
        "/": [
          { kind: "directory", name: "C:", path: "C:/", size: null },
          { kind: "directory", name: "D:", path: "D:/", size: null },
        ],
        "C:/": [
          { kind: "directory", name: "Program Files", path: "C:/Program Files", size: null },
          { kind: "directory", name: "Users", path: "C:/Users", size: null },
          { kind: "directory", name: "Windows", path: "C:/Windows", size: null },
        ],
        "C:/Users": [
          { kind: "directory", name: "alice", path: "C:/Users/alice", size: null },
          { kind: "directory", name: "Public", path: "C:/Users/Public", size: null },
        ],
      },
    });

    assert.deepEqual(
      columns.map((column) => column.path),
      ["/", "C:", "C:/Users", "C:/Users/alice"],
    );
    assert.deepEqual(columns[0].entries.map((entry) => entry.name), ["C:", "D:"]);
    assert.deepEqual(columns[1].entries.map((entry) => entry.name), ["Program Files", "Users", "Windows"]);
    assert.deepEqual(columns[2].entries.map((entry) => entry.name), ["alice", "Public"]);
    assert.equal(columns[0].entries.find((entry) => entry.name === "C:")?.selected, true);
    assert.equal(columns[1].entries.find((entry) => entry.name === "Users")?.selected, true);
    assert.equal(columns[2].entries.find((entry) => entry.name === "alice")?.selected, true);
  });
});
