import type { ConfigValue } from "../bindings";
import { stringValue } from "../config/document";

export type TerminalCommandId =
  | "terminal.openCommandPalette"
  | "terminal.newSession"
  | "terminal.closeTab"
  | "terminal.splitLeft"
  | "terminal.splitRight"
  | "terminal.splitUp"
  | "terminal.splitDown"
  | "terminal.closePane"
  | "terminal.find"
  | "terminal.findNext"
  | "terminal.findPrevious";

export type KeybindingDefinition = {
  command: TerminalCommandId;
  label: string;
  macDefault: string;
  default: string;
};

export const terminalKeybindings: KeybindingDefinition[] = [
  {
    command: "terminal.openCommandPalette",
    label: "Command Palette",
    macDefault: "Meta+Shift+P",
    default: "Ctrl+Shift+P",
  },
  {
    command: "terminal.newSession",
    label: "New Session",
    macDefault: "Meta+T",
    default: "Ctrl+Shift+T",
  },
  {
    command: "terminal.closeTab",
    label: "Close Tab",
    macDefault: "Meta+W",
    default: "Ctrl+Shift+W",
  },
  {
    command: "terminal.splitLeft",
    label: "Split Left",
    macDefault: "Meta+Alt+D",
    default: "Ctrl+Alt+Left",
  },
  {
    command: "terminal.splitRight",
    label: "Split Right",
    macDefault: "Meta+D",
    default: "Ctrl+Shift+D",
  },
  {
    command: "terminal.splitUp",
    label: "Split Up",
    macDefault: "Meta+Alt+Shift+D",
    default: "Ctrl+Alt+Up",
  },
  {
    command: "terminal.splitDown",
    label: "Split Down",
    macDefault: "Meta+Shift+D",
    default: "Ctrl+Alt+D",
  },
  {
    command: "terminal.closePane",
    label: "Close Pane",
    macDefault: "Meta+Shift+W",
    default: "Ctrl+Alt+W",
  },
  {
    command: "terminal.find",
    label: "Find",
    macDefault: "Meta+F",
    default: "Ctrl+F",
  },
  {
    command: "terminal.findNext",
    label: "Find Next",
    macDefault: "Meta+G",
    default: "Ctrl+G",
  },
  {
    command: "terminal.findPrevious",
    label: "Find Previous",
    macDefault: "Meta+Shift+G",
    default: "Ctrl+Shift+G",
  },
];

export type KeybindingMap = Record<TerminalCommandId, string>;

export function defaultKeybindingMap(isMac: boolean): KeybindingMap {
  return Object.fromEntries(
    terminalKeybindings.map((binding) => [binding.command, isMac ? binding.macDefault : binding.default]),
  ) as KeybindingMap;
}

export function readKeybindingMap(root: { values: Record<string, ConfigValue> }, isMac: boolean): KeybindingMap {
  const defaults = defaultKeybindingMap(isMac);
  const table = root.values.keybindings;
  if (!table) return defaults;
  if (table.kind !== "Table") throw new Error("keybindings must be a table");
  const terminal = table.value.terminal;
  if (!terminal) return defaults;
  if (terminal.kind !== "Table") throw new Error("keybindings.terminal must be a table");
  const entries = { ...defaults };
  for (const binding of terminalKeybindings) {
    const raw = stringValue(terminal.value[binding.command.replace("terminal.", "")]);
    if (raw !== undefined) entries[binding.command] = raw;
  }
  return entries;
}

export function eventMatchesBinding(event: KeyboardEvent, binding: string): boolean {
  const parsed = parseKeybinding(binding);
  if (!parsed) return false;
  return (
    event.key.toLowerCase() === parsed.key.toLowerCase() &&
    event.metaKey === parsed.meta &&
    event.ctrlKey === parsed.ctrl &&
    event.altKey === parsed.alt &&
    event.shiftKey === parsed.shift
  );
}

export function parseKeybinding(binding: string): { key: string; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean } | null {
  const parts = binding
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const key = parts.at(-1);
  if (!key) return null;
  const modifiers = new Set(parts.slice(0, -1).map((part) => part.toLowerCase()));
  return {
    key,
    meta: modifiers.has("meta") || modifiers.has("cmd") || modifiers.has("command"),
    ctrl: modifiers.has("ctrl") || modifiers.has("control"),
    alt: modifiers.has("alt") || modifiers.has("option"),
    shift: modifiers.has("shift"),
  };
}
