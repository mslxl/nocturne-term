import type { ConfigValue, TerminalCursorStyle, TerminalRenderer, TabBarOrientation } from "$lib/bindings";
import {
  booleanValue,
  configBoolean,
  configFloat,
  configInteger,
  configString,
  configStringArray,
  integerValue,
  numberValue,
  readValue,
  stringArrayValue,
  stringValue,
  type AppLanguage,
  type AppTheme,
} from "$lib/config/document";
import type { MessageKey } from "$lib/i18n/messages";

export type SettingCategoryId = "appearance" | "terminal" | "profiles" | "hosts";
export type SettingValueKind = "text" | "number" | "integer" | "boolean" | "select" | "textarea" | "color";

export type SettingDefinition<T = unknown> = {
  key: string;
  category: SettingCategoryId;
  label: MessageKey;
  path: string[];
  kind: SettingValueKind;
  defaultValue: T;
  options?: { value: string; label: MessageKey }[];
  help?: MessageKey;
  min?: number;
  step?: number;
  get: (root: { values: Record<string, ConfigValue> }) => T;
  toConfigValue: (value: T) => ConfigValue | undefined;
};

function valueAt(root: { values: Record<string, ConfigValue> }, path: string[]) {
  return readValue(root, path);
}

export const settingCategories: { id: SettingCategoryId; label: MessageKey }[] = [
  { id: "appearance", label: "appearance" },
  { id: "terminal", label: "terminal" },
  { id: "profiles", label: "profiles" },
  { id: "hosts", label: "hosts" },
];

export const settingsSchema: SettingDefinition[] = [
  {
    key: "ui.theme",
    category: "appearance",
    label: "theme",
    path: ["ui", "theme"],
    kind: "select",
    defaultValue: "system" satisfies AppTheme,
    options: [
      { value: "system", label: "system" },
      { value: "light", label: "light" },
      { value: "dark", label: "dark" },
    ],
    get: (root) => stringValue(valueAt(root, ["ui", "theme"])) ?? "system",
    toConfigValue: (value) => configString(String(value)),
  },
  {
    key: "ui.language",
    category: "appearance",
    label: "language",
    path: ["ui", "language"],
    kind: "select",
    defaultValue: "en" satisfies AppLanguage,
    options: [
      { value: "en", label: "english" },
      { value: "zh", label: "chinese" },
    ],
    get: (root) => stringValue(valueAt(root, ["ui", "language"])) ?? "",
    toConfigValue: (value) => (String(value) ? configString(String(value)) : undefined),
  },
  {
    key: "terminal.command",
    category: "terminal",
    label: "command",
    path: ["terminal", "command"],
    kind: "text",
    defaultValue: "",
    help: "blankMeansDefault",
    get: (root) => stringValue(valueAt(root, ["terminal", "command"])) ?? "",
    toConfigValue: (value) => (String(value).trim() ? configString(String(value).trim()) : undefined),
  },
  {
    key: "terminal.args",
    category: "terminal",
    label: "arguments",
    path: ["terminal", "args"],
    kind: "textarea",
    defaultValue: "",
    help: "onePerLine",
    get: (root) => (stringArrayValue(valueAt(root, ["terminal", "args"])) ?? []).join("\n"),
    toConfigValue: (value) => {
      const items = String(value)
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean);
      return items.length ? configStringArray(items) : undefined;
    },
  },
  {
    key: "terminal.cwd",
    category: "terminal",
    label: "workingDirectory",
    path: ["terminal", "cwd"],
    kind: "text",
    defaultValue: "",
    help: "blankMeansDefault",
    get: (root) => stringValue(valueAt(root, ["terminal", "cwd"])) ?? "",
    toConfigValue: (value) => (String(value).trim() ? configString(String(value).trim()) : undefined),
  },
  {
    key: "terminal.font_family",
    category: "terminal",
    label: "fontFamily",
    path: ["terminal", "font_family"],
    kind: "text",
    defaultValue: "Menlo, Monaco, Consolas, monospace",
    get: (root) => stringValue(valueAt(root, ["terminal", "font_family"])) ?? "Menlo, Monaco, Consolas, monospace",
    toConfigValue: (value) => configString(String(value)),
  },
  {
    key: "terminal.font_size",
    category: "terminal",
    label: "fontSize",
    path: ["terminal", "font_size"],
    kind: "number",
    defaultValue: 13,
    min: 8,
    step: 0.5,
    get: (root) => numberValue(valueAt(root, ["terminal", "font_size"])) ?? 13,
    toConfigValue: (value) => configFloat(Number(value)),
  },
  {
    key: "terminal.scrollback",
    category: "terminal",
    label: "scrollback",
    path: ["terminal", "scrollback"],
    kind: "integer",
    defaultValue: 10000,
    min: 0,
    step: 100,
    get: (root) => integerValue(valueAt(root, ["terminal", "scrollback"])) ?? 10000,
    toConfigValue: (value) => configInteger(Number(value)),
  },
  {
    key: "terminal.renderer",
    category: "terminal",
    label: "renderer",
    path: ["terminal", "renderer"],
    kind: "select",
    defaultValue: "canvas" satisfies TerminalRenderer,
    options: [
      { value: "canvas", label: "canvas" },
      { value: "webgl", label: "webgl" },
    ],
    get: (root) => stringValue(valueAt(root, ["terminal", "renderer"])) ?? "canvas",
    toConfigValue: (value) => configString(String(value)),
  },
  {
    key: "terminal.cursor_blink",
    category: "terminal",
    label: "cursorBlink",
    path: ["terminal", "cursor_blink"],
    kind: "boolean",
    defaultValue: true,
    get: (root) => booleanValue(valueAt(root, ["terminal", "cursor_blink"])) ?? true,
    toConfigValue: (value) => configBoolean(Boolean(value)),
  },
  {
    key: "terminal.cursor_style",
    category: "terminal",
    label: "cursorStyle",
    path: ["terminal", "cursor_style"],
    kind: "select",
    defaultValue: "block" satisfies TerminalCursorStyle,
    options: [
      { value: "block", label: "block" },
      { value: "underline", label: "underline" },
      { value: "bar", label: "bar" },
    ],
    get: (root) => stringValue(valueAt(root, ["terminal", "cursor_style"])) ?? "block",
    toConfigValue: (value) => configString(String(value)),
  },
  {
    key: "terminal.tab_bar_orientation",
    category: "terminal",
    label: "tabBarOrientation",
    path: ["terminal", "tab_bar_orientation"],
    kind: "select",
    defaultValue: "horizontal" satisfies TabBarOrientation,
    options: [
      { value: "horizontal", label: "horizontal" },
      { value: "vertical", label: "vertical" },
    ],
    get: (root) => stringValue(valueAt(root, ["terminal", "tab_bar_orientation"])) ?? "horizontal",
    toConfigValue: (value) => configString(String(value)),
  },
  ...(["top", "right", "bottom", "left"] as const).map((edge) => ({
    key: `terminal.padding.${edge}`,
    category: "terminal" as const,
    label: edge,
    path: ["terminal", "padding", edge],
    kind: "number" as const,
    defaultValue: 8,
    min: 0,
    step: 1,
    get: (root: { values: Record<string, ConfigValue> }) =>
      numberValue(valueAt(root, ["terminal", "padding", edge])) ?? 8,
    toConfigValue: (value: unknown) => configFloat(Number(value)),
  })),
  {
    key: "host_dirs",
    category: "hosts",
    label: "hostDirs",
    path: ["host_dirs"],
    kind: "textarea",
    defaultValue: "hosts",
    help: "onePerLine",
    get: (root) => (stringArrayValue(valueAt(root, ["host_dirs"])) ?? ["hosts"]).join("\n"),
    toConfigValue: (value) => {
      const items = String(value)
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean);
      return configStringArray(items.length ? items : ["hosts"]);
    },
  },
];
