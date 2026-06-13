/*
 * Test content:
 *
 * Feature:
 * Verifies Resource Monitor command palette and Workspace ToolTab entry points.
 *
 * Operation:
 * Reads static command palette commands and the main Workspace page source to
 * locate the `tool.openResources` command and its execution path.
 *
 * Expected:
 * `tool.openResources` is exposed as a command palette command, searches by
 * Resource Monitor terms, dispatches the shared Workspace
 * `open_resource_monitor_tool_tab` intent for create-or-focus behavior, and no
 * global app-only Resource Monitor command path is introduced.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { staticPaletteCommands } from "../src/lib/command-palette/commands";
import { localizeCommand, searchPaletteItems } from "../src/lib/command-palette/search";

const pageSource = readFileSync(resolve("src/routes/+page.svelte"), "utf8");

describe("Resource Monitor command entry points", () => {
  it("exposes tool.openResources in the command palette", () => {
    const command = staticPaletteCommands.find((item) => item.id === "tool.openResources");
    assert.ok(command, "tool.openResources command must exist");
    assert.equal(command.title.en, "Open Resource Monitor");
    assert.equal(command.scope.en, "Workspace Tool");

    const results = searchPaletteItems(
      staticPaletteCommands.map((item) => localizeCommand(item, "en")),
      "resources",
      { language: "en" },
    );
    assert.equal(results[0]?.id, "tool.openResources");
  });

  it("dispatches Resource Monitor through the Workspace ToolTab intent", () => {
    assert.match(pageSource, /id === "tool\.openResources"/);
    assert.match(pageSource, /kind:\s*"open_resource_monitor_tool_tab"/);
    assert.doesNotMatch(pageSource, /app\.openResources|resourceMonitor\.openGlobal/);
  });
});
