/*
Feature: Files Tree view expansion.
Operation: Build Tree view rows from root entries plus lazily loaded child entries and activate directory rows through ordinary click actions.
Expected: Expanded directories reveal indented child rows without changing the current browser path, the filesystem root remains the first Tree row while the default/home path is only the initial focus, and every ordinary directory row click maps to an expansion toggle.
*/
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  buildFileTreeRootModel,
  buildFileTreeRows,
  filesTreeInitialFocusPlan,
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

  it("keeps the filesystem root as the first row while expanding the focused default path", () => {
    const model = buildFileTreeRootModel({
      rootPath: "/",
      currentPath: "/home/alice",
      currentEntries: [entry("project", "/home/alice/project", "directory")],
      childrenByPath: {},
    });
    const rows = buildFileTreeRows({
      rootEntries: model.rootEntries,
      childrenByPath: model.childrenByPath,
      expandedPaths: new Set(["/", "/home", "/home/alice"]),
      loadingPaths: new Set(),
      errorByPath: new Map(),
    });

    assert.deepEqual(
      rows.map((row) => ({ name: row.entry.name, path: row.entry.path, depth: row.depth })),
      [
        { name: "/", path: "/", depth: 0 },
        { name: "home", path: "/home", depth: 1 },
        { name: "alice", path: "/home/alice", depth: 2 },
        { name: "project", path: "/home/alice/project", depth: 3 },
      ],
    );
  });

  it("keeps Windows drive roots expandable as absolute drive roots", () => {
    const model = buildFileTreeRootModel({
      rootPath: "C:\\",
      currentPath: "C:\\Users\\alice",
      currentEntries: [entry("project", "C:\\Users\\alice\\project", "directory")],
      childrenByPath: {},
    });
    const rows = buildFileTreeRows({
      rootEntries: model.rootEntries,
      childrenByPath: model.childrenByPath,
      expandedPaths: new Set(["C:/", "C:/Users", "C:/Users/alice"]),
      loadingPaths: new Set(),
      errorByPath: new Map(),
    });

    assert.deepEqual(
      rows.map((row) => ({ name: row.entry.name, path: row.entry.path, depth: row.depth })),
      [
        { name: "C:", path: "C:/", depth: 0 },
        { name: "Users", path: "C:/Users", depth: 1 },
        { name: "alice", path: "C:/Users/alice", depth: 2 },
        { name: "project", path: "C:\\Users\\alice\\project", depth: 3 },
      ],
    );
  });

  it("keeps the Windows virtual root above drive roots while focusing a drive default path", () => {
    const model = buildFileTreeRootModel({
      rootPath: "/",
      currentPath: "C:\\Users\\alice",
      currentEntries: [entry("project", "C:\\Users\\alice\\project", "directory")],
      childrenByPath: {
        "/": [entry("C:", "C:/", "directory"), entry("D:", "D:/", "directory")],
      },
    });
    const rows = buildFileTreeRows({
      rootEntries: model.rootEntries,
      childrenByPath: model.childrenByPath,
      expandedPaths: new Set(["/", "C:/", "C:/Users", "C:/Users/alice"]),
      loadingPaths: new Set(),
      errorByPath: new Map(),
    });

    assert.deepEqual(
      rows.map((row) => ({ name: row.entry.name, path: row.entry.path, depth: row.depth })),
      [
        { name: "/", path: "/", depth: 0 },
        { name: "C:", path: "C:/", depth: 1 },
        { name: "Users", path: "C:/Users", depth: 2 },
        { name: "alice", path: "C:/Users/alice", depth: 3 },
        { name: "project", path: "C:\\Users\\alice\\project", depth: 4 },
        { name: "D:", path: "D:/", depth: 1 },
      ],
    );
  });

  it("matches Windows child maps even when provider entries keep backslash paths", () => {
    const rows = buildFileTreeRows({
      rootEntries: [entry("C:", "C:/", "directory")],
      childrenByPath: {
        "C:/Users": [entry("alice", "C:\\Users\\alice", "directory")],
        "C:/Users/alice": [entry("project", "C:\\Users\\alice\\project", "directory")],
        "C:/": [entry("Users", "C:\\Users", "directory")],
      },
      expandedPaths: new Set(["C:/", "C:\\Users", "C:\\Users\\alice"]),
      loadingPaths: new Set(),
      errorByPath: new Map(),
    });

    assert.deepEqual(
      rows.map((row) => ({ name: row.entry.name, path: row.entry.path, depth: row.depth })),
      [
        { name: "C:", path: "C:/", depth: 0 },
        { name: "Users", path: "C:\\Users", depth: 1 },
        { name: "alice", path: "C:\\Users\\alice", depth: 2 },
        { name: "project", path: "C:\\Users\\alice\\project", depth: 3 },
      ],
    );
  });

  it("hydrates the Windows virtual-root focus chain when the current drive is expanded", () => {
    const model = buildFileTreeRootModel({
      rootPath: "/",
      currentPath: "C:/Users/alice/nocturne-fixture",
      currentEntries: [entry("alpha", "C:/Users/alice/nocturne-fixture/alpha", "directory")],
      childrenByPath: {
        "/": [entry("C:", "C:/", "directory")],
      },
    });
    const rows = buildFileTreeRows({
      rootEntries: model.rootEntries,
      childrenByPath: model.childrenByPath,
      expandedPaths: new Set(["/", "C:/"]),
      loadingPaths: new Set(),
      errorByPath: new Map(),
    });

    assert.deepEqual(
      rows.map((row) => ({ name: row.entry.name, path: row.entry.path, depth: row.depth })),
      [
        { name: "/", path: "/", depth: 0 },
        { name: "C:", path: "C:/", depth: 1 },
        { name: "Users", path: "C:/Users", depth: 2 },
      ],
    );
  });

  it("keeps loaded Windows ancestor siblings visible while hydrating the default focus chain", () => {
    const model = buildFileTreeRootModel({
      rootPath: "/",
      currentPath: "C:/Users/alice/nocturne-fixture",
      currentEntries: [entry("alpha", "C:/Users/alice/nocturne-fixture/alpha", "directory")],
      childrenByPath: {
        "/": [entry("C:", "C:/", "directory"), entry("D:", "D:/", "directory")],
        "C:/": [entry("Program Files", "C:/Program Files", "directory"), entry("Users", "C:/Users", "directory"), entry("Windows", "C:/Windows", "directory")],
        "C:/Users": [entry("alice", "C:/Users/alice", "directory"), entry("Public", "C:/Users/Public", "directory")],
        "C:/Users/alice": [entry("Desktop", "C:/Users/alice/Desktop", "directory"), entry("nocturne-fixture", "C:/Users/alice/nocturne-fixture", "directory")],
      },
    });
    const rows = buildFileTreeRows({
      rootEntries: model.rootEntries,
      childrenByPath: model.childrenByPath,
      expandedPaths: new Set(["/", "C:/", "C:/Users", "C:/Users/alice", "C:/Users/alice/nocturne-fixture"]),
      loadingPaths: new Set(),
      errorByPath: new Map(),
    });

    assert.deepEqual(
      rows.map((row) => ({ name: row.entry.name, path: row.entry.path, depth: row.depth })),
      [
        { name: "/", path: "/", depth: 0 },
        { name: "C:", path: "C:/", depth: 1 },
        { name: "Program Files", path: "C:/Program Files", depth: 2 },
        { name: "Users", path: "C:/Users", depth: 2 },
        { name: "alice", path: "C:/Users/alice", depth: 3 },
        { name: "Desktop", path: "C:/Users/alice/Desktop", depth: 4 },
        { name: "nocturne-fixture", path: "C:/Users/alice/nocturne-fixture", depth: 4 },
        { name: "alpha", path: "C:/Users/alice/nocturne-fixture/alpha", depth: 5 },
        { name: "Public", path: "C:/Users/Public", depth: 3 },
        { name: "Windows", path: "C:/Windows", depth: 2 },
        { name: "D:", path: "D:/", depth: 1 },
      ],
    );
  });

  it("does not force the initial focus drive back open after the user collapses it", () => {
    const collapsedByUser = new Set(["C:/"]);
    const plan = filesTreeInitialFocusPlan({
      rootPath: "/",
      focusPath: "C:/Users/alice/nocturne-fixture",
      collapsedPaths: collapsedByUser,
    });

    assert.deepEqual(plan.expandPaths, ["/", "C:/Users", "C:/Users/alice", "C:/Users/alice/nocturne-fixture"]);
    assert.equal(plan.expandPaths.includes("C:/"), false);
  });

  it("keeps Windows drive root paths distinct from drive-relative paths in the component", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../src/lib/files/FilesToolTab.svelte", import.meta.url), "utf8");

    assert.ok(
      source.includes('if (/^[A-Za-z]:\\/?$/.test(withForwardSlashes)) return `${withForwardSlashes.slice(0, 2)}/`;'),
      "FilesToolTab must preserve C:/ as a drive root instead of normalizing it to drive-relative C:",
    );
    assert.doesNotMatch(source, /return value\.replace\(\/\\\\\\\\\/g,\s*"\/"\)\.replace\(\/\\\/\+\$\/,\s*""\);/);
  });

  it("ignores directory double-click activation after the row click has already toggled expansion", () => {
    assert.equal(fileTreeDoubleClickAction(entry("src", "/repo/src", "directory")), "ignore-directory");
    assert.equal(fileTreeDoubleClickAction(entry("README.md", "/repo/README.md", "file")), "select-file");
  });

  it("treats directory row clicks as Tree toggles from any row area", () => {
    assert.equal(fileTreeClickAction(entry("src", "/repo/src", "directory")), "toggle-directory");
    assert.equal(fileTreeClickAction(entry("README.md", "/repo/README.md", "file")), "select-file");
  });

  it("treats every ordinary directory row click as an expansion toggle", () => {
    assert.equal(fileTreeClickAction(entry("src", "/repo/src", "directory"), 1), "toggle-directory");
    assert.equal(fileTreeClickAction(entry("README.md", "/repo/README.md", "file"), 1), "select-file");
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
