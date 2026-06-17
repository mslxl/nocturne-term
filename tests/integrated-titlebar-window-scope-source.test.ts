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
 * present for Windows/Linux fallback-capable titlebar integration.
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
    assert.match(capability, /decorum:allow-show-snap-overlay/);
    assert.match(libSource, /tauri_plugin_decorum::init\(\)/);
    assert.match(appShell, /create_overlay_titlebar/);
    assert.match(appShell, /log::warn!\([^;]*decorum/i);
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
