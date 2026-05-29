import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { xtermOptions } from "./settings";
import type { TerminalSettings } from "../bindings";

describe("terminal settings", () => {
  it("enables xterm proposed APIs required by search decorations", () => {
    const options = xtermOptions(settings());

    assert.equal(options.allowProposedApi, true);
  });
});

function settings(): TerminalSettings {
  return {
    args: [],
    command: null,
    cursor_blink: true,
    cursor_style: "block",
    cwd: null,
    font_family: "Menlo",
    font_size: 13,
    padding: { bottom: 8, left: 10, right: 10, top: 8 },
    renderer: "dom",
    scrollback: 10000,
    tab_bar_orientation: "horizontal",
    theme: {
      background: "#101113",
      black: "#000000",
      blue: "#0000ff",
      bright_black: "#555555",
      bright_blue: "#5555ff",
      bright_cyan: "#55ffff",
      bright_green: "#55ff55",
      bright_magenta: "#ff55ff",
      bright_red: "#ff5555",
      bright_white: "#ffffff",
      bright_yellow: "#ffff55",
      cursor: "#ffffff",
      cyan: "#00ffff",
      foreground: "#ffffff",
      green: "#00ff00",
      magenta: "#ff00ff",
      red: "#ff0000",
      selection_background: "#36506f",
      white: "#cccccc",
      yellow: "#ffff00",
    },
  };
}
