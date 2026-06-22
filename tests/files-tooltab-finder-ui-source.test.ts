/*
 * Test content:
 *
 * Feature:
 * Finder-style Files ToolTab UI wiring for sticky rows, directory drop targets,
 * context-menu selection actions, and Columns horizontal browsing.
 *
 * Operation:
 * Reads the FilesToolTab Svelte source and inspects the DOM/event wiring that
 * cannot be fully covered by pure view-model tests.
 *
 * Expected:
 * Tree sticky rows are driven by persisted per-ToolTab view state and the first
 * visible tree row instead of only the selected path, external file drops
 * resolve a concrete directory row target and show lightweight row highlighting,
 * selection actions stay in the context menu without a top selection action bar,
 * marquee selection starts only from empty list space, and Columns navigation
 * schedules deterministic horizontal scrolling to a pending focused column
 * window when the user clicks the left visible column, otherwise falling back to
 * the last three visible columns.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sourcePath = resolve("src/lib/files/FilesToolTab.svelte");

describe("Files ToolTab Finder-style UI source", () => {
  it("uses visible tree range, row drop targets, and active-window Columns scrolling", () => {
    const source = readFileSync(sourcePath, "utf8");

    assert.match(source, /filesToolViewState/);
    assert.match(source, /const\s+viewState\s*=\s*filesToolViewState\(toolTab\.id\);/);
    assert.match(source, /let\s+firstVisibleTreePath\s*=\s*\$derived\(viewState\.firstVisibleTreePath\);/);
    assert.match(source, /firstVisiblePath:\s*firstVisibleTreePath\s*\|\|\s*selectedPath/);
    assert.match(source, /function\s+installTreeVisibleScrollListener\(\)/);
    assert.match(source, /function\s+updateFirstVisibleTreePath\(\)/);
    assert.match(source, /viewState\.firstVisibleTreePath\s*=\s*row\.getAttribute\("data-entry-path"\)\s*\?\?\s*"";/);

    assert.match(source, /let\s+externalDropTargetPath\s*=\s*\$state<string\s*\|\s*null>\(null\);/);
    assert.match(source, /function\s+directoryDropTargetFromPosition\(x:\s*number\s*\|\s*undefined,\s*y:\s*number\s*\|\s*undefined\)/);
    assert.match(source, /data-entry-kind=\{row\.entry\.kind\}/);
    assert.match(source, /class:drop-target=\{externalDropTargetPath\s*===\s*row\.entry\.path\}/);
    assert.match(source, /class:drop-target=\{externalDropTargetPath\s*===\s*entry\.path\}/);
    assert.match(source, /class:drop-target=\{externalDropTargetPath\s*===\s*stickyRow\.entry\.path\}/);
    assert.match(source, /Drop to upload/);
    assert.match(source, /dragHover\s*&&\s*!externalDropTargetPath/);

    assert.doesNotMatch(source, /selection-action-bar/);
    assert.doesNotMatch(source, /filesSelectionToolbarActions/);
    assert.match(source, /class:dangerous=\{action\.dangerous\}/);
    assert.match(source, /event\.target\s+instanceof\s+HTMLElement\s+&&\s+event\.target\.closest\("\[data-file-entry='true'\]"\)/);

    assert.match(source, /function\s+scheduleColumnsScrollToActiveWindow\(\)/);
    assert.match(source, /function\s+scrollColumnsViewToActiveWindow\(\)/);
    assert.match(source, /const\s+visibleColumnCount\s*=\s*Math\.min\(columns\.length,\s*3\);/);
    assert.match(source, /const\s+selectedColumnIndex\s*=\s*pendingColumnsFocusWindowPath[\s\S]*?renderedPaths\.findIndex\(\(path\)\s*=>\s*sameFilePath\(path,\s*pendingColumnsFocusWindowPath\s*\?\?\s*""\)\)[\s\S]*?:\s*-1;/);
    assert.match(source, /const\s+maxStart\s*=\s*Math\.max\(0,\s*columns\.length\s*-\s*visibleColumnCount\);/);
    assert.match(source, /const\s+targetStart\s*=\s*selectedColumnIndex\s*>=\s*0\s*\?\s*Math\.min\(Math\.max\(0,\s*selectedColumnIndex\s*-\s*1\),\s*maxStart\)\s*:\s*maxStart;/);
    assert.match(source, /const\s+targetScrollLeft\s*=\s*Math\.max\(0,\s*targetStart\s*\*\s*columnWidth\);/);
    assert.match(source, /function\s+columnsSelectionFocusWindowPath\(entry:\s*FileEntry,\s*event\?:\s*MouseEvent\)/);
    assert.match(source, /scheduleColumnsScrollToActiveWindow\(\);/);
    assert.doesNotMatch(source, /scrollTarget\.scrollLeft\s*=\s*scrollTarget\.scrollWidth\s*-\s*scrollTarget\.clientWidth/);
  });
});
