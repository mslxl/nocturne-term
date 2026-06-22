/*
 * Test content:
 *
 * Feature:
 * Files Tree root focus and sticky parent directory layout.
 *
 * Operation:
 * Computes the root-to-focus path expansion plan and sticky ancestor rows for
 * a visible Tree range, then normalizes global sticky layout settings.
 *
 * Expected:
 * Files keeps the filesystem root in the Tree model while expanding and
 * focusing the default/home path, including the focused directory's own
 * children. Sticky ancestors are capped by the configured level count, default
 * to three visible parent directories, and can be disabled globally without
 * removing normal Tree expansion behavior.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  filesTreeInitialFocusPlan,
  filesTreeStickyAncestors,
  normalizeFilesTreeStickySettings,
  type FileTreeRow,
} from "../src/lib/files/tree";

const row = (path: string, depth: number): FileTreeRow => ({
  entry: {
    kind: "directory",
    name: path.split("/").filter(Boolean).at(-1) ?? "/",
    path,
    size: null,
    modified_unix_ms: null,
    permissions: null,
    owner: null,
    group: null,
    symlink_target: null,
  },
  depth,
  expanded: true,
  loading: false,
  error: null,
});

describe("Files Tree sticky layout", () => {
  it("keeps root as the model root while focusing the default path", () => {
    assert.deepEqual(filesTreeInitialFocusPlan({ rootPath: "/", focusPath: "/home/alice/project" }), {
      rootPath: "/",
      focusPath: "/home/alice/project",
      expandPaths: ["/", "/home", "/home/alice", "/home/alice/project"],
    });
  });

  it("normalizes Windows drive roots before planning default-path expansion", () => {
    assert.deepEqual(filesTreeInitialFocusPlan({ rootPath: "C:\\", focusPath: "C:\\Users\\alice\\project" }), {
      rootPath: "C:/",
      focusPath: "C:/Users/alice/project",
      expandPaths: ["C:/", "C:/Users", "C:/Users/alice", "C:/Users/alice/project"],
    });
  });

  it("keeps the Windows virtual root before drive roots when planning default-path expansion", () => {
    assert.deepEqual(filesTreeInitialFocusPlan({ rootPath: "/", focusPath: "C:\\Users\\alice\\project" }), {
      rootPath: "/",
      focusPath: "C:/Users/alice/project",
      expandPaths: ["/", "C:/", "C:/Users", "C:/Users/alice", "C:/Users/alice/project"],
    });
  });

  it("returns the capped ancestor rows for the first visible deep row", () => {
    const rows = [
      row("/", 0),
      row("/home", 1),
      row("/home/alice", 2),
      row("/home/alice/project", 3),
      row("/home/alice/project/src", 4),
      row("/home/alice/project/src/main.ts", 5),
    ];

    assert.deepEqual(
      filesTreeStickyAncestors({ rows, firstVisiblePath: "/home/alice/project/src/main.ts", maxLevels: 3 }).map((sticky) => sticky.entry.path),
      ["/home/alice", "/home/alice/project", "/home/alice/project/src"],
    );
  });

  it("returns no sticky rows when sticky layout is disabled", () => {
    const rows = [row("/", 0), row("/home", 1)];

    assert.deepEqual(filesTreeStickyAncestors({ rows, firstVisiblePath: "/home", maxLevels: 3, enabled: false }), []);
  });

  it("normalizes global sticky settings with enabled three-level defaults", () => {
    assert.deepEqual(normalizeFilesTreeStickySettings({}), { enabled: true, maxLevels: 3 });
    assert.deepEqual(normalizeFilesTreeStickySettings({ enabled: false, maxLevels: 9 }), { enabled: false, maxLevels: 5 });
    assert.deepEqual(normalizeFilesTreeStickySettings({ enabled: true, maxLevels: 0 }), { enabled: true, maxLevels: 1 });
  });
});
