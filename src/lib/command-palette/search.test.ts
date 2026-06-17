import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { staticPaletteCommands } from "./commands";
import { localizeCommand, searchPaletteItems, type PaletteItem } from "./search";

describe("command palette search", () => {
  it("finds Chinese commands from English input", () => {
    const items = staticPaletteCommands.map((command) => localizeCommand(command, "zh"));
    const results = searchPaletteItems(items, "split", { language: "zh" });

    assert.equal(results[0]?.id, "terminal.splitRight");
    assert.match(results[0]?.title ?? "", /拆分/);
  });

  it("finds split commands from Chinese pinyin initials", () => {
    const items = staticPaletteCommands.map((command) => localizeCommand(command, "en"));
    const results = searchPaletteItems(items, "cf", { language: "en" });

    assert.equal(results[0]?.id, "terminal.splitRight");
  });

  it("finds numbered tab results", () => {
    const items: PaletteItem[] = [
      {
        id: "tab.switchTo:tab-2",
        kind: "tab",
        title: "Switch to Tab: 2  server",
        scope: "Tab",
        keywords: ["2", "tab 2", "server", "/work/server"],
      },
    ];

    const results = searchPaletteItems(items, "tab 2", { language: "en" });

    assert.equal(results[0]?.id, "tab.switchTo:tab-2");
  });

  it("keeps dynamic object results action-labeled", () => {
    const items: PaletteItem[] = [
      {
        id: "tab.switchTo:tab-2",
        kind: "tab",
        title: "Switch to Tab: 2  server",
        scope: "Tab",
        keywords: ["2", "tab 2", "server"],
      },
      {
        id: "profile.switch:default",
        kind: "profile",
        title: "Switch Profile: default",
        scope: "Profile",
        keywords: ["default", "profile"],
      },
    ];

    const tabResult = searchPaletteItems(items, "server", { language: "en" })[0];
    const profileResult = searchPaletteItems(items, "default", { language: "en" })[0];

    assert.equal(tabResult?.title, "Switch to Tab: 2  server");
    assert.equal(profileResult?.title, "Switch Profile: default");
  });

  it("hides disabled commands unless the query is exact enough", () => {
    const items: PaletteItem[] = [
      {
        id: "terminal.togglePaneZoom",
        kind: "command",
        title: "Toggle Pane Zoom",
        scope: "Pane",
        keywords: ["zoom"],
        disabledReason: "Requires multiple panes",
      },
    ];

    assert.equal(searchPaletteItems(items, "zoom", { language: "en" }).length, 0);
    assert.equal(searchPaletteItems(items, "Toggle Pane Zoom", { language: "en", includeDisabledExact: true }).length, 1);
  });
});
