/*
 * Test content:
 *
 * Feature:
 * Finder-style Files Columns view motion.
 *
 * Operation:
 * Reads the FilesToolTab component source and inspects the Columns view for
 * a double-pane sliding track, forward and backward horizontal transforms,
 * variable motion distance for visible-window slides, a non-zero motion
 * duration, transition-free inline preparation, animation cleanup, full-width
 * horizontal column panes, and active-window scroll scheduling for the
 * Finder-style full column chain.
 *
 * Expected:
 * Directory column window shifts are implemented as an explicit horizontal
 * slide between the previous pane and the next pane using an explicit
 * transform transition with a non-linear easing
 * curve, backward navigation from the left visible column can slide by one
 * column so the clicked column moves into the middle, column-count changes use
 * the same easing for file and preview column resizing without horizontal track
 * travel, resize keeps the current pane identity stable so existing column
 * scroll viewports are not recreated, slide motion uses a composited
 * transform keyframe animation with a non-linear easing function, animation cleanup
 * collapses back to one
 * current pane after the motion, and the horizontally scrollable Finder column
 * strip scrolls to a focused selected-directory window when navigation starts
 * from the left visible column, falling back to the deterministic trailing
 * window when no focused directory window is pending.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const filesToolTabUrl = new URL("../src/lib/files/FilesToolTab.svelte", import.meta.url);

describe("Files Columns view motion source", () => {
  it("slides between previous and next visible column windows", async () => {
    const source = await readFile(filesToolTabUrl, "utf8");

    assert.match(source, /const\s+columnsMotionDurationMs\s*=\s*480;/);
    assert.match(source, /const\s+columnsMotionEasing\s*=\s*"cubic-bezier\([^"]+\)";/);
    assert.doesNotMatch(source, /const\s+columnsMotionEasing\s*=\s*"linear";/);
    assert.match(source, /let\s+columnsPanes\s*=\s*\$state<ColumnsPane\[\]>\(\[\]\);/);
    assert.match(source, /let\s+columnsMotionDistance\s*=\s*\$state\("100%"\);/);
    assert.match(source, /let\s+columnsMotionFinishTimer:\s*number\s*\|\s*null\s*=\s*null;/);
    assert.match(source, /let\s+columnsMotionTranslate\s*=\s*\$state\("0px"\);/);
    assert.match(source, /let\s+columnsMotionTransition\s*=\s*\$state\("none"\);/);
    assert.match(source, /function\s+startColumnsSlideMotionFrame\(generation:\s*number,\s*direction:\s*Exclude<ColumnsMotion,\s*"idle"\s*\|\s*"resize">,\s*nextColumns:\s*FilesColumn\[\]\)/);
    assert.match(source, /function\s+finishColumnsSlideMotion\(generation:\s*number,\s*nextColumns:\s*FilesColumn\[\]\)/);
    assert.match(source, /function\s+clearColumnsMotionFinishTimer\(\)/);
    assert.match(source, /function\s+columnsMotionContentElement\(\)/);
    assert.match(source, /function\s+applyColumnsMotionElementStyle\(translate:\s*string,\s*transition:\s*string\)/);
    assert.match(source, /content\.style\.setProperty\("transform",\s*`translateX\(\$\{translate\}\)`\);/);
    assert.match(source, /const\s+distance\s*=\s*columnsMotionDistancePixels\(\);/);
    assert.match(source, /const\s+from\s*=\s*direction\s*===\s*"forward"\s*\?\s*0\s*:\s*-distance;/);
    assert.match(source, /const\s+to\s*=\s*direction\s*===\s*"forward"\s*\?\s*-distance\s*:\s*0;/);
    assert.match(source, /columnsMotionTransition\s*=\s*"none";/);
    assert.match(source, /columnsMotionTranslate\s*=\s*`\$\{from\}px`;/);
    assert.match(source, /flushSync\(\);/);
    assert.match(source, /applyColumnsMotionElementStyle\(`\$\{from\}px`,\s*"none"\);/);
    assert.match(source, /columnsMotionTranslate\s*=\s*`\$\{to\}px`;/);
    assert.match(source, /columnsMotionFinishTimer\s*=\s*window\.setTimeout\(\(\)\s*=>\s*\{[\s\S]*?finishColumnsSlideMotion\(generation,\s*nextColumns\);[\s\S]*?\},\s*columnsMotionDurationMs\s*\+\s*120\);/);
    assert.match(source, /function\s+columnsMotionInFlight\(\)\s*\{[\s\S]*?columnsMotionPreparing[\s\S]*?columnsMotionActive[\s\S]*?columnsMotionFinishTimer\s*!==\s*null[\s\S]*?\}/);
    assert.doesNotMatch(source, /let\s+columnsMotionAnimationFrame:/);
    assert.doesNotMatch(source, /let\s+columnsMotionStartFrame:/);
    assert.doesNotMatch(source, /let\s+columnsMotionStartTimer:/);
    assert.doesNotMatch(source, /let\s+columnsMotionCleanup:/);
    assert.match(source, /function\s+syncColumnsPanes\(nextColumns:\s*FilesColumn\[\]\)/);
    assert.match(source, /\$effect\(\(\)\s*=>\s*\{\s*if\s*\(viewMode\s*!==\s*"columns"\)\s*return;\s*syncColumnsPanes\(fileColumns\);\s*\}\);/);
    assert.match(source, /columnsPanes\s*=\s*direction\s*===\s*"backward"\s*\?\s*\[current,\s*previous\]\s*:\s*\[previous,\s*current\];/);
    assert.match(source, /columnsMotionDistance\s*=\s*motionWindow\?\.distance\s*\?\?\s*"100%";/);
    assert.match(source, /columnsMotionTranslate\s*=\s*direction\s*===\s*"backward"\s*\?\s*negativeColumnsMotionDistance\(columnsMotionDistance\)\s*:\s*"0px";/);
    assert.match(source, /function\s+negativeColumnsMotionDistance\(distance:\s*string\)/);
    assert.match(source, /function\s+columnsMotionDistanceClass\(distance:\s*string\)/);
    assert.match(source, /function\s+columnsForSlideMotionWindow\(previous:\s*readonly\s+FilesColumn\[\],\s*next:\s*readonly\s+FilesColumn\[\],\s*direction:\s*ColumnsMotion\)/);
    assert.match(source, /if\s*\(direction\s*!==\s*"backward"\)\s*return\s+null;/);
    assert.match(source, /sameStringArray\(previousPaths\.slice\(-3,\s*-1\),\s*nextPaths\.slice\(-2\)\)/);
    assert.match(source, /sameFilePath\(previousPaths\[previousPaths\.length\s*-\s*3\]\s*\?\?\s*"",\s*nextPaths\[nextPaths\.length\s*-\s*2\]\s*\?\?\s*""\)/);
    assert.match(source, /previous:\s*previous\.slice\(-1\),\s*[\s\S]*?current:\s*next\.slice\(-3\),\s*[\s\S]*?distance:\s*"calc\(100%\s*\/\s*3\)",/);
    assert.match(source, /previous:\s*previous\.slice\(-3\),\s*[\s\S]*?current:\s*next\.slice\(-3\),\s*[\s\S]*?distance:\s*"calc\(100%\s*\/\s*6\)",/);
    assert.match(source, /function\s+currentColumnsPane\(columns:\s*FilesColumn\[\]\):\s*ColumnsPane\s*\{[\s\S]*?id:\s*currentColumnsPaneId\(\),/);
    assert.match(source, /function\s+currentColumnsPaneId\(\)\s*\{[\s\S]*?return\s+"current";/);
    assert.match(source, /columnsPanes\s*=\s*\[currentColumnsPane\(nextColumns\)\];/);
    assert.match(source, /class:motion-forward=\{columnsMotion\s*===\s*"forward"\}/);
    assert.match(source, /class:motion-backward=\{columnsMotion\s*===\s*"backward"\}/);
    assert.match(source, /class:motion-resize=\{columnsMotion\s*===\s*"resize"\}/);
    assert.match(source, /class:motion-preparing=\{columnsMotionPreparing\}/);
    assert.match(source, /class:motion-distance-full=\{columnsMotionDistanceClass\(columnsMotionDistance\)\s*===\s*"full"\}/);
    assert.match(source, /class:motion-distance-third=\{columnsMotionDistanceClass\(columnsMotionDistance\)\s*===\s*"third"\}/);
    assert.match(source, /class:motion-distance-sixth=\{columnsMotionDistanceClass\(columnsMotionDistance\)\s*===\s*"sixth"\}/);
    assert.match(source, /style=\{`--columns-motion-duration:\s*\$\{columnsMotionDurationMs\}ms;\s*--columns-motion-easing:\s*\$\{columnsMotionEasing\};\s*--columns-motion-distance:\s*\$\{columnsMotionDistance\};\s*--columns-motion-translate:\s*\$\{columnsMotionTranslate\};\s*--columns-motion-transition:\s*\$\{columnsMotionTransition\};\s*transform:\s*translateX\(\$\{columnsMotionTranslate\}\);\s*transition:\s*\$\{columnsMotionTransition\};`\}/);
    assert.match(source, /\.columns-content\s*\{[^}]*transition:\s*var\(--columns-motion-transition,\s*none\);/s);
    assert.match(source, /\.columns-content\.motion-forward\.motion-active\.motion-distance-full\s*\{[^}]*animation:\s*columns-slide-forward-full\s+var\(--columns-motion-duration,/s);
    assert.match(source, /\.columns-content\.motion-backward\.motion-active\.motion-distance-third\s*\{[^}]*animation:\s*columns-slide-backward-third\s+var\(--columns-motion-duration,/s);
    assert.doesNotMatch(source, /\.columns-content\.motion-forward\.motion-active\s*\{[^}]*transform:\s*translateX\(var\(--columns-motion-translate/s);
    assert.doesNotMatch(source, /\.columns-content\.motion-backward\s*\{[^}]*transform:\s*translateX\(var\(--columns-motion-translate/s);
    assert.doesNotMatch(source, /translateX\(calc\(-1\s*\*\s*var\(--columns-motion-distance/);
    assert.match(source, /@keyframes\s+columns-slide-forward-full\s*\{[\s\S]*?from\s*\{[\s\S]*?transform:\s*translateX\(0\);[\s\S]*?to\s*\{[\s\S]*?transform:\s*translateX\(-100%\);/s);
    assert.match(source, /@keyframes\s+columns-slide-backward-third\s*\{[\s\S]*?from\s*\{[\s\S]*?transform:\s*translateX\(calc\(-100%\s*\/\s*3\)\);[\s\S]*?to\s*\{[\s\S]*?transform:\s*translateX\(0\);/s);
    assert.match(source, /\.columns-content\.motion-resize\s*\{[^}]*transform:\s*translateX\(0\);/s);
    assert.match(source, /\.columns-content\.motion-resize\s+\.file-column\s*\{[^}]*flex-basis\s+var\(--columns-motion-duration,\s*180ms\)\s+var\(--columns-motion-easing,/s);
    assert.match(source, /\.columns-content\.motion-resize\s+\.preview-column\s*\{[^}]*flex-basis\s+var\(--columns-motion-duration,\s*180ms\)\s+var\(--columns-motion-easing,/s);
    assert.match(source, /\.columns-content\.motion-preparing\s*\{[^}]*transition:\s*none;/s);
    assert.match(source, /--columns-visible-count:\s*\$\{Math\.min\(columnsPaneColumnCount\(pane\),\s*3\)\}/);
    assert.match(source, /\.columns-pane\s*\{[^}]*--columns-pane-width:\s*max\(100%,\s*calc\(var\(--columns-count,\s*1\)\s*\*\s*\(100%\s*\/\s*var\(--columns-visible-count,\s*1\)\)\)\);/s);
    assert.match(source, /\.columns-pane\s*\{[^}]*--column-width:\s*calc\(100%\s*\/\s*var\(--columns-count,\s*1\)\);/s);
    assert.match(source, /\.file-column\s*\{[^}]*flex:\s*0\s+0\s+var\(--column-width\);/s);
    assert.match(source, /function\s+scheduleColumnsScrollToActiveWindow\(\)/);
    assert.match(source, /function\s+scrollColumnsViewToActiveWindow\(\)/);
    assert.match(source, /function\s+preferredColumnsWindowStart\(columns:\s*readonly\s+FilesColumn\[\],\s*count\s*=\s*visibleColumnsWindowCount\(columns\)\)/);
    assert.match(source, /if\s*\(!pendingColumnsFocusWindowPath\)\s*return\s+fallback;/);
    assert.match(source, /const\s+selectedColumnIndex\s*=\s*columns\.findIndex\(\(column\)\s*=>\s*sameFilePath\(column\.path,\s*pendingColumnsFocusWindowPath\s*\?\?\s*""\)\);/);
    assert.match(source, /return\s+Math\.min\(Math\.max\(0,\s*selectedColumnIndex\s*-\s*1\),\s*maxStart\);/);
    assert.match(source, /const\s+visibleColumnCount\s*=\s*Math\.min\(columns\.length,\s*3\);/);
    assert.match(source, /const\s+renderedPaths\s*=\s*columns\.map\(\(column\)\s*=>\s*column\.getAttribute\("aria-label"\)\s*\?\?\s*""\);/);
    assert.match(source, /const\s+selectedColumnIndex\s*=\s*pendingColumnsFocusWindowPath[\s\S]*?renderedPaths\.findIndex\(\(path\)\s*=>\s*sameFilePath\(path,\s*pendingColumnsFocusWindowPath\s*\?\?\s*""\)\)[\s\S]*?:\s*-1;/);
    assert.match(source, /const\s+maxStart\s*=\s*Math\.max\(0,\s*columns\.length\s*-\s*visibleColumnCount\);/);
    assert.match(source, /const\s+targetStart\s*=\s*selectedColumnIndex\s*>=\s*0\s*\?\s*Math\.min\(Math\.max\(0,\s*selectedColumnIndex\s*-\s*1\),\s*maxStart\)\s*:\s*maxStart;/);
    assert.match(source, /const\s+targetScrollLeft\s*=\s*Math\.max\(0,\s*targetStart\s*\*\s*columnWidth\);/);
    assert.doesNotMatch(source, /scrollTarget\.scrollLeft\s*=\s*scrollTarget\.scrollWidth\s*-\s*scrollTarget\.clientWidth/);
  });
});
