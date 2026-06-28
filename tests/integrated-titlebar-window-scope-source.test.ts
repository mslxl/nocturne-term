/*
 * Test content:
 *
 * Feature:
 * Verifies integrated title bar chrome is scoped to Workspace and floating
 * Workspace windows while utility windows keep standard native title bars.
 *
 * Operation:
 * Reads the Rust app shell source and Tauri configuration. The test checks for
 * explicit helper functions that classify integrated-titlebar windows, include
 * `main`, `main-*`, and `workspace-floating-*`, exclude settings/hosts/dialog
 * windows, and configure decorum permissions plus global Tauri access.
 *
 * Expected:
 * Integrated chrome is eligible only for Workspace and floating windows;
 * settings, host manager, and dialogs are excluded, and decorum setup is
 * present for Windows/Linux fallback-capable titlebar integration. The app
 * shell requests one decorum page-load refresh and waits for the mounted
 * Workspace slot to acknowledge readiness; the frontend must not synthesize
 * DOMContentLoaded events because doing so can repeatedly trigger decorum's
 * bootstrap path after controls already exist.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

describe("integrated titlebar window scope source", () => {
  it("classifies workspace and floating windows as integrated-titlebar eligible", async () => {
    const appShell = await readFile(new URL("../src-tauri/src/app_shell.rs", import.meta.url), "utf8");

    assert.match(appShell, /fn is_workspace_chrome_window_label/);
    assert.match(appShell, /label == MAIN_WINDOW_LABEL/);
    assert.match(appShell, /label\.starts_with\("main-"\)/);
    assert.match(appShell, /label\.starts_with\("workspace-floating-"\)/);
    assert.doesNotMatch(appShell, /is_workspace_chrome_window_label[\s\S]*label == "settings"/);
    assert.doesNotMatch(appShell, /is_workspace_chrome_window_label[\s\S]*label == "hosts"/);
    assert.match(appShell, /apply_integrated_titlebar_chrome/);
  });

  it("configures decorum for Windows and Linux without blocking startup on failure", async () => {
    const cargoToml = await readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
    const tauriConfig = await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8");
    const capability = await readFile(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8");
    const libSource = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
    const appShell = await readFile(new URL("../src-tauri/src/app_shell.rs", import.meta.url), "utf8");

    assert.match(cargoToml, /tauri-plugin-decorum/);
    assert.match(tauriConfig, /"withGlobalTauri"\s*:\s*true/);
    assert.match(tauriConfig, /"decorations"\s*:\s*false/);
    assert.match(capability, /decorum:allow-show-snap-overlay/);
    assert.match(libSource, /tauri_plugin_decorum::init\(\)/);
    assert.match(appShell, /create_overlay_titlebar/);
    assert.match(appShell, /builder\.decorations\(!integrated\)/);
    assert.match(appShell, /schedule_decorum_titlebar_refresh/);
    assert.match(appShell, /DECORUM_TITLEBAR_REFRESH_ATTEMPTS/);
    assert.match(appShell, /window\.emit\("decorum-page-load", \(\)\)/);
    assert.match(appShell, /DECORUM_TITLEBAR_READY_EVENT/);
    assert.match(appShell, /window\.listen_any\(DECORUM_TITLEBAR_READY_EVENT/);
    assert.match(appShell, /decorum titlebar refresh did not receive a ready acknowledgment/);
    assert.match(appShell, /log::warn!\([^;]*decorum/i);
  });

  it("requests decorum injection from the mounted Workspace slot in dev-url windows", async () => {
    const decorumHost = await readFile(new URL("../src/lib/window/decorum-titlebar.ts", import.meta.url), "utf8");

    assert.match(decorumHost, /emit\("decorum-page-load"\)/);
    assert.match(decorumHost, /emit\(DECORUM_TITLEBAR_READY_EVENT\)/);
    assert.match(decorumHost, /decorumBootstrapRequested/);
    assert.doesNotMatch(decorumHost, /document\.dispatchEvent\(new Event\("DOMContentLoaded"\)\)/);
    assert.doesNotMatch(decorumHost, /setTimeout\(\(\) => document\.dispatchEvent\(new Event\("DOMContentLoaded"\)\), 30\)/);
    assert.match(decorumHost, /findAndAttach\(\)/);
  });

  it("applies decorum to the initial Windows and Linux main window during setup", async () => {
    const libSource = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
    const appShell = await readFile(new URL("../src-tauri/src/app_shell.rs", import.meta.url), "utf8");

    assert.match(libSource, /apply_initial_workspace_decorum_chrome\(app\.handle\(\)\)/);
    assert.match(appShell, /pub\(crate\) fn apply_initial_workspace_decorum_chrome\(app: &AppHandle\)/);
    assert.match(appShell, /apply_initial_workspace_decorum_chrome[\s\S]*for window in app\.webview_windows\(\)\.values\(\)/);
    assert.match(appShell, /apply_initial_workspace_decorum_chrome[\s\S]*is_workspace_chrome_window_label\(window\.label\(\)\)/);
    assert.match(appShell, /apply_initial_workspace_decorum_chrome[\s\S]*let integrated = integrated_titlebar_active\(app\)\?/);
    assert.match(appShell, /apply_initial_workspace_decorum_chrome[\s\S]*apply_workspace_decorum_chrome\(window, integrated\)/);
  });
});
