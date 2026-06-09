/*
 * Test content:
 *
 * Feature:
 * Verifies that Windows/Linux integrated titlebar mode preserves app menu
 * functionality through native popup menus.
 *
 * Operation:
 * Reads the Rust app shell command registration and the Svelte Workspace page
 * and tab bar source. The test checks that Rust exposes a typed
 * `show_app_menu` command with a structured menu-root input, that the command
 * uses native `popup_menu_at`, that Specta exports the command, and that the
 * integrated titlebar renders File/Edit/View/Window menu root buttons which
 * call the generated `commands.showAppMenu` helper.
 *
 * Expected:
 * The integrated titlebar keeps decorum visual chrome while restoring app menu
 * access through native popup menus instead of WebView-drawn menu overlays or
 * lost system menu functionality.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

describe("integrated titlebar native popup menu source", () => {
  it("wires File/Edit/View/Window titlebar menu entries to a native Rust popup command", async () => {
    const appShell = await readFile(new URL("../src-tauri/src/app_shell.rs", import.meta.url), "utf8");
    const libSource = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
    const typesSource = await readFile(new URL("../src-tauri/src/types.rs", import.meta.url), "utf8");
    const pageSource = await readFile(new URL("../src/routes/+page.svelte", import.meta.url), "utf8");
    const tabbarSource = await readFile(new URL("../src/lib/workspace/components/WorkspaceTabBar.svelte", import.meta.url), "utf8");

    assert.match(typesSource, /pub enum AppMenuRoot/);
    assert.match(typesSource, /File[\s\S]*Edit[\s\S]*View[\s\S]*Window/);
    assert.match(appShell, /#\[tauri::command\]\s*#\[specta::specta\]\s*pub\(crate\) fn show_app_menu/);
    assert.match(appShell, /popup_menu_at\(&menu,\s*LogicalPosition::new\(input\.x,\s*input\.y\)\)/);
    assert.match(libSource, /app_shell::show_app_menu/);
    assert.match(tabbarSource, /class="workspace-app-menu"/);
    assert.match(tabbarSource, /data-app-menu-root=\{root\.id\}/);
    assert.match(pageSource, /commands\.showAppMenu/);
    assert.match(pageSource, /window_label:\s*currentWindowLabel\(\)/);
  });
});
