/*
 * Test content:
 *
 * Feature:
 * Verifies integrated title bar drag regions do not swallow Workspace,
 * ToolTab, Dock, Terminal, or Files interactions.
 *
 * Operation:
 * Reads the Workspace app shell, Workspace page, and Workspace tab bar
 * component. The test checks that drag-region attributes appear only on safe
 * empty header regions, that decorum uses the plugin-created titlebar host
 * instead of a static WebView host that would suppress native controls, and
 * that interactive Workspace controls are explicitly excluded from drag-region
 * behavior.
 *
 * Expected:
 * Interactive controls remain normal controls under integrated titlebar mode,
 * while safe empty header areas still allow native window dragging.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

describe("integrated titlebar drag region source", () => {
  it("keeps drag regions on safe titlebar containers only", async () => {
    const appShellSource = await readFile(new URL("../src/app.html", import.meta.url), "utf8");
    const pageSource = await readFile(new URL("../src/routes/+page.svelte", import.meta.url), "utf8");
    const tabbarSource = await readFile(new URL("../src/lib/workspace/components/WorkspaceTabBar.svelte", import.meta.url), "utf8");

    assert.doesNotMatch(appShellSource, /data-tauri-decorum-tb/);
    assert.match(tabbarSource, /class="workspace-decorum-slot"[\s\S]*use:mountDecorumTitlebarHost/);
    assert.match(pageSource, /\.workspace-decorum-controls > \[data-tauri-drag-region\][\s\S]*display:\s*none !important/);
    assert.match(tabbarSource, /class="workspace-titlebar-drag-zone"[\s\S]*data-tauri-drag-region=\{integratedTitlebar \? true : undefined\}/);
    assert.match(pageSource, /class="workspace-decorum-slot"[\s\S]*use:mountDecorumTitlebarHost/);
    assert.match(pageSource, /class="workspace-tabbar-loading-drag-zone"[\s\S]*data-tauri-drag-region=\{integratedTitlebar \? true : undefined\}/);
    assert.doesNotMatch(pageSource, /data-tauri-decorum-tb/);
    assert.doesNotMatch(tabbarSource, /data-tauri-drag-region=\{integratedTitlebar \? "deep" : undefined\}/);
    assert.doesNotMatch(pageSource, /data-tauri-drag-region=\{integratedTitlebar \? "deep" : undefined\}/);
    assert.doesNotMatch(pageSource, /<section[^>]*class="workspace-body"[^>]*data-tauri-drag-region/);
    assert.doesNotMatch(pageSource, /<[^>]*class="tool-tab[^"]*"[^>]*data-tauri-drag-region/);
  });
});
