import type { ITerminalOptions, ITheme } from "@xterm/xterm";
import type { TerminalSettings } from "$lib/bindings";

export function xtermOptions(config: TerminalSettings): ITerminalOptions {
  return {
    allowProposedApi: config.renderer === "webgl",
    cursorBlink: config.cursor_blink,
    cursorStyle: config.cursor_style,
    fontFamily: config.font_family,
    fontSize: finiteNumber("terminal.font_size", config.font_size),
    scrollback: config.scrollback,
    theme: xtermTheme(config.theme),
  };
}

export function syncSettingsVariables(config: TerminalSettings) {
  document.documentElement.style.setProperty("--terminal-bg", config.theme.background);
  document.documentElement.style.setProperty("--terminal-fg", config.theme.foreground);
  document.documentElement.style.setProperty("--terminal-selection", config.theme.selection_background);
  document.documentElement.style.setProperty("--terminal-padding-top", `${finiteNumber("terminal.padding.top", config.padding.top)}px`);
  document.documentElement.style.setProperty("--terminal-padding-right", `${finiteNumber("terminal.padding.right", config.padding.right)}px`);
  document.documentElement.style.setProperty("--terminal-padding-bottom", `${finiteNumber("terminal.padding.bottom", config.padding.bottom)}px`);
  document.documentElement.style.setProperty("--terminal-padding-left", `${finiteNumber("terminal.padding.left", config.padding.left)}px`);
}

function xtermTheme(config: TerminalSettings["theme"]): ITheme {
  return {
    background: config.background,
    foreground: config.foreground,
    cursor: config.cursor,
    selectionBackground: config.selection_background,
    black: config.black,
    red: config.red,
    green: config.green,
    yellow: config.yellow,
    blue: config.blue,
    magenta: config.magenta,
    cyan: config.cyan,
    white: config.white,
    brightBlack: config.bright_black,
    brightRed: config.bright_red,
    brightGreen: config.bright_green,
    brightYellow: config.bright_yellow,
    brightBlue: config.bright_blue,
    brightMagenta: config.bright_magenta,
    brightCyan: config.bright_cyan,
    brightWhite: config.bright_white,
  };
}

function finiteNumber(name: string, value: number | null): number {
  if (value === null || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}
