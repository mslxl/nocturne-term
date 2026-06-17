/*
 * Test content:
 *
 * Feature:
 * Verifies the Windows/Linux integrated titlebar menu layout setting.
 *
 * Operation:
 * Reads the settings schema, i18n messages, Workspace page, Workspace tab bar,
 * and documentation. The test checks that `ui.integrated_titlebar_single_row`
 * exists as a Windows/Linux-only setting with a default of false, that macOS
 * does not enable or show it, and that the Workspace chrome can render either
 * a single-row menu+Workspace-tab layout or a Zotero-style two-row layout where
 * app menu roots occupy the first row and Workspace tabs occupy the second row.
 *
 * Expected:
 * The default Windows/Linux integrated titlebar layout uses two rows. Enabling
 * the setting keeps the current single-row layout. macOS keeps its existing
 * native overlay behavior and never uses this setting.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

describe("integrated titlebar menu layout source", () => {
  it("defines a Windows/Linux-only single-row layout setting that defaults off", async () => {
    const schema = await readFile(new URL("../src/lib/settings/schema.ts", import.meta.url), "utf8");
    const messages = await readFile(new URL("../src/lib/i18n/messages.ts", import.meta.url), "utf8");
    const docs = [
      await readFile(new URL("../docs/settings-page.md", import.meta.url), "utf8"),
      await readFile(new URL("../docs/application-config-storage.md", import.meta.url), "utf8"),
    ].join("\n");

    assert.match(schema, /key:\s*"ui\.integrated_titlebar_single_row"/);
    assert.match(schema, /path:\s*\["ui",\s*"integrated_titlebar_single_row"\]/);
    assert.match(schema, /defaultValue:\s*false/);
    assert.match(schema, /platforms:\s*\["windows",\s*"linux"\]/);
    assert.match(messages, /integratedTitlebarSingleRow/);
    assert.match(messages, /integratedTitlebarSingleRowHelp/);
    assert.match(docs, /ui\.integrated_titlebar_single_row/);
    assert.match(docs, /defaults? to `false`/i);
    assert.match(docs, /Windows and Linux/i);
    assert.match(docs, /macOS/i);
  });

  it("renders default two-row titlebar chrome and optional single-row chrome", async () => {
    const page = await readFile(new URL("../src/routes/+page.svelte", import.meta.url), "utf8");
    const tabbar = await readFile(new URL("../src/lib/workspace/components/WorkspaceTabBar.svelte", import.meta.url), "utf8");

    assert.match(page, /let integratedTitlebarSingleRowSetting = \$state\(false\)/);
    assert.match(page, /integratedTitlebarSingleRowSetting\s*=\s*false/);
    assert.match(page, /booleanValue\(readValue\(snapshot\.effective_config\.root,\s*\["ui",\s*"integrated_titlebar_single_row"\]\)\)\s*\?\?\s*false/);
    assert.match(page, /integratedTitlebarSingleRow={integratedTitlebarSingleRow}/);
    assert.match(page, /integratedTitlebarSingleRow\s*\?\s*"single-row"\s*:\s*"two-row"/);

    assert.match(tabbar, /titlebarLayout\?:\s*"single-row"\s*\|\s*"two-row"/);
    assert.match(tabbar, /titlebarLayout = "two-row"/);
    assert.match(tabbar, /effectiveTitlebarLayout = \$derived\(integratedTitlebarSingleRow \? "single-row" : titlebarLayout\)/);
    assert.match(tabbar, /class:titlebar-two-row=\{effectiveTitlebarLayout === "two-row"\}/);
    assert.match(tabbar, /class="workspace-titlebar-menu-row"/);
    assert.match(tabbar, /class="workspace-titlebar-tab-row"/);
    assert.match(tabbar, /class="workspace-app-menu"/);
    assert.match(tabbar, /class="workspace-tabs"/);
    assert.match(tabbar, /\.workspace-tabbar\.titlebar-two-row/);
    assert.match(tabbar, /\.workspace-tabbar\.titlebar-single-row/);
  });
});
