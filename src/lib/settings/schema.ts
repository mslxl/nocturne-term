import type { ConfigValue, TerminalCursorStyle, TerminalRenderer, TabBarOrientation } from "$lib/bindings";
import {
  booleanValue,
  configBoolean,
  configFloat,
  configInteger,
  configString,
  configStringArray,
  defaultLanguage,
  integerValue,
  numberValue,
  readValue,
  stringArrayValue,
  stringValue,
  type AppLanguage,
  type AppTheme,
} from "$lib/config/document";
import type { MessageKey } from "$lib/i18n/messages";
import { DEFAULT_FILES_TOOLBAR_ACTION_IDS, filesToolbarActionIdsFromSettingText, filesToolbarActionSettingText } from "$lib/files/toolbar-actions";
import { defaultKeybindingMap, terminalKeybindings, type KeybindingMap } from "$lib/terminal/keybindings";

export type SettingCategoryId = "appearance" | "workspace" | "terminal" | "files" | "resources" | "transfers" | "keybindings" | "profiles" | "hosts";
export type SettingValueKind = "text" | "number" | "integer" | "boolean" | "select" | "textarea" | "path-list" | "color" | "keybindings";
export type SettingsPlatform = "windows" | "linux" | "macos";

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
  platforms?: SettingsPlatform[];
  get: (root: { values: Record<string, ConfigValue> }) => T;
  toConfigValue: (value: T) => ConfigValue | undefined;
};

function valueAt(root: { values: Record<string, ConfigValue> }, path: string[]) {
  return readValue(root, path);
}

function tabBarOrientationValue(value: ConfigValue | undefined): TabBarOrientation {
  const raw = stringValue(value);
  if (!raw) return "horizontal";
  if (raw === "vertical") return "vertical_right";
  if (raw === "horizontal" || raw === "vertical_left" || raw === "vertical_right") return raw;
  throw new Error(`unsupported terminal.tab_bar_orientation value: ${raw}`);
}

function isMacPlatform() {
  return typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");
}

export function currentSettingsPlatform(): SettingsPlatform | null {
  if (typeof navigator === "undefined") return null;
  const platform = navigator.platform.toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();
  if (platform.includes("mac")) return "macos";
  if (platform.includes("win")) return "windows";
  if (platform.includes("linux") || userAgent.includes("linux")) return "linux";
  return null;
}

export function settingVisibleOnCurrentPlatform(setting: SettingDefinition) {
  if (!setting.platforms) return true;
  const platform = currentSettingsPlatform();
  return platform !== null && setting.platforms.includes(platform);
}

export const settingCategories: { id: SettingCategoryId; label: MessageKey }[] = [
  { id: "appearance", label: "appearance" },
  { id: "workspace", label: "workspace" },
  { id: "terminal", label: "terminal" },
  { id: "files", label: "files" },
  { id: "resources", label: "resources" },
  { id: "transfers", label: "transfers" },
  { id: "keybindings", label: "keybindings" },
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
    get: (root) => stringValue(valueAt(root, ["ui", "language"])) ?? defaultLanguage(),
    toConfigValue: (value) => (String(value) ? configString(String(value)) : undefined),
  },
  {
    key: "ui.integrated_titlebar",
    category: "appearance",
    label: "integratedTitlebar",
    path: ["ui", "integrated_titlebar"],
    kind: "boolean",
    defaultValue: true,
    help: "integratedTitlebarHelp",
    get: (root) => booleanValue(valueAt(root, ["ui", "integrated_titlebar"])) ?? true,
    toConfigValue: (value) => configBoolean(Boolean(value)),
  },
  {
    key: "ui.integrated_titlebar_single_row",
    category: "appearance",
    label: "integratedTitlebarSingleRow",
    path: ["ui", "integrated_titlebar_single_row"],
    kind: "boolean",
    defaultValue: false,
    help: "integratedTitlebarSingleRowHelp",
    platforms: ["windows", "linux"],
    get: (root) => booleanValue(valueAt(root, ["ui", "integrated_titlebar_single_row"])) ?? false,
    toConfigValue: (value) => configBoolean(Boolean(value)),
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
    defaultValue: "dom" satisfies TerminalRenderer,
    options: [
      { value: "dom", label: "dom" },
      { value: "webgl", label: "webgl" },
    ],
    get: (root) => {
      return stringValue(valueAt(root, ["terminal", "renderer"])) ?? "dom";
    },
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
      { value: "vertical_left", label: "verticalLeft" },
      { value: "vertical_right", label: "verticalRight" },
    ],
    get: (root) => tabBarOrientationValue(valueAt(root, ["terminal", "tab_bar_orientation"])),
    toConfigValue: (value) => configString(String(value)),
  },
  {
    key: "terminal.confirm_close",
    category: "terminal",
    label: "confirmClose",
    path: ["terminal", "confirm_close"],
    kind: "boolean",
    defaultValue: true,
    help: "confirmCloseHelp",
    get: (root) => booleanValue(valueAt(root, ["terminal", "confirm_close"])) ?? true,
    toConfigValue: (value) => configBoolean(Boolean(value)),
  },
  ...(["top", "right", "bottom", "left"] as const).map((edge) => ({
    key: `terminal.padding.${edge}`,
    category: "terminal" as const,
    label: edge,
    path: ["terminal", "padding", edge],
    kind: "number" as const,
    defaultValue: edge === "left" || edge === "right" ? 10 : 8,
    min: 0,
    step: 1,
    get: (root: { values: Record<string, ConfigValue> }) =>
      numberValue(valueAt(root, ["terminal", "padding", edge])) ?? (edge === "left" || edge === "right" ? 10 : 8),
    toConfigValue: (value: unknown) => configFloat(Number(value)),
  })),
  {
    key: "workspace.restore_strategy",
    category: "workspace",
    label: "workspaceRestoreStrategy",
    path: ["workspace", "restore_strategy"],
    kind: "select",
    defaultValue: "visible_auto_reconnect",
    options: [
      { value: "visible_auto_reconnect", label: "visibleAutoReconnect" },
      { value: "manual", label: "manualReconnect" },
      { value: "safe_auto_restore", label: "safeAutoRestore" },
    ],
    get: (root) => stringValue(valueAt(root, ["workspace", "restore_strategy"])) ?? "visible_auto_reconnect",
    toConfigValue: (value) => configString(String(value)),
  },
  {
    key: "workspace.show_host_icons_in_tabs",
    category: "workspace",
    label: "showHostIconsInTabs",
    path: ["workspace", "show_host_icons_in_tabs"],
    kind: "boolean",
    defaultValue: false,
    help: "showHostIconsInTabsHelp",
    get: (root) => booleanValue(valueAt(root, ["workspace", "show_host_icons_in_tabs"])) ?? false,
    toConfigValue: (value) => configBoolean(Boolean(value)),
  },
  {
    key: "files.default_view_mode",
    category: "files",
    label: "defaultFilesViewMode",
    path: ["files", "default_view_mode"],
    kind: "select",
    defaultValue: "tree",
    options: [
      { value: "tree", label: "treeView" },
      { value: "columns", label: "columnsView" },
    ],
    get: (root) => stringValue(valueAt(root, ["files", "default_view_mode"])) ?? "tree",
    toConfigValue: (value) => configString(String(value)),
  },
  {
    key: "files.show_hidden",
    category: "files",
    label: "showHiddenFiles",
    path: ["files", "show_hidden"],
    kind: "boolean",
    defaultValue: true,
    get: (root) => booleanValue(valueAt(root, ["files", "show_hidden"])) ?? true,
    toConfigValue: (value) => configBoolean(Boolean(value)),
  },
  {
    key: "files.delete_behavior",
    category: "files",
    label: "deleteBehavior",
    path: ["files", "delete_behavior"],
    kind: "select",
    defaultValue: "direct",
    options: [
      { value: "direct", label: "directDelete" },
      { value: "try_remote_trash", label: "tryRemoteTrash" },
    ],
    help: "deleteBehaviorHelp",
    get: (root) => stringValue(valueAt(root, ["files", "delete_behavior"])) ?? "direct",
    toConfigValue: (value) => configString(String(value)),
  },
  {
    key: "files.clipboard_semantics",
    category: "files",
    label: "clipboardSemantics",
    path: ["files", "clipboard_semantics"],
    kind: "select",
    defaultValue: "windows",
    options: [
      { value: "windows", label: "windowsStyle" },
      { value: "finder", label: "finderStyle" },
    ],
    get: (root) => stringValue(valueAt(root, ["files", "clipboard_semantics"])) ?? "windows",
    toConfigValue: (value) => configString(String(value)),
  },
  {
    key: "files.remote_helper_policy",
    category: "files",
    label: "remoteHelperPolicy",
    path: ["files", "remote_helper_policy"],
    kind: "select",
    defaultValue: "ask",
    options: [
      { value: "ask", label: "ask" },
      { value: "never", label: "never" },
      { value: "allow", label: "allow" },
    ],
    get: (root) => stringValue(valueAt(root, ["files", "remote_helper_policy"])) ?? "ask",
    toConfigValue: (value) => configString(String(value)),
  },
  {
    key: "files.text_preview_limit_bytes",
    category: "files",
    label: "textPreviewLimit",
    path: ["files", "text_preview_limit_bytes"],
    kind: "integer",
    defaultValue: 1048576,
    min: 0,
    step: 262144,
    get: (root) => integerValue(valueAt(root, ["files", "text_preview_limit_bytes"])) ?? 1048576,
    toConfigValue: (value) => configInteger(Number(value)),
  },
  {
    key: "files.image_preview_limit_bytes",
    category: "files",
    label: "imagePreviewLimit",
    path: ["files", "image_preview_limit_bytes"],
    kind: "integer",
    defaultValue: 10485760,
    min: 0,
    step: 1048576,
    get: (root) => integerValue(valueAt(root, ["files", "image_preview_limit_bytes"])) ?? 10485760,
    toConfigValue: (value) => configInteger(Number(value)),
  },
  {
    key: "files.toolbar_actions",
    category: "files",
    label: "filesToolbarActions",
    path: ["files", "toolbar_actions"],
    kind: "textarea",
    defaultValue: filesToolbarActionSettingText(DEFAULT_FILES_TOOLBAR_ACTION_IDS),
    help: "filesToolbarActionsHelp",
    get: (root) => filesToolbarActionSettingText(stringArrayValue(valueAt(root, ["files", "toolbar_actions"])) ?? DEFAULT_FILES_TOOLBAR_ACTION_IDS),
    toConfigValue: (value) => {
      const ids = filesToolbarActionIdsFromSettingText(String(value));
      return ids.length ? configStringArray(ids) : undefined;
    },
  },
  {
    key: "resources.default_refresh_interval",
    category: "resources",
    label: "defaultResourceRefreshInterval",
    path: ["resources", "default_refresh_interval"],
    kind: "select",
    defaultValue: "2s",
    options: [
      { value: "1s", label: "oneSecond" },
      { value: "2s", label: "twoSeconds" },
      { value: "5s", label: "fiveSeconds" },
      { value: "10s", label: "tenSeconds" },
    ],
    get: (root) => stringValue(valueAt(root, ["resources", "default_refresh_interval"])) ?? "2s",
    toConfigValue: (value) => configString(String(value)),
  },
  {
    key: "resources.remote_provider",
    category: "resources",
    label: "resourceRemoteProvider",
    path: ["resources", "remote_provider"],
    kind: "select",
    defaultValue: "auto",
    help: "resourceRemoteProviderHelp",
    options: [
      { value: "auto", label: "auto" },
      { value: "agent", label: "resourceProviderAgent" },
      { value: "system_commands", label: "resourceProviderSystemCommands" },
    ],
    get: (root) => stringValue(valueAt(root, ["resources", "remote_provider"])) ?? "auto",
    toConfigValue: (value) => configString(String(value)),
  },
  {
    key: "transfers.global_concurrency",
    category: "transfers",
    label: "globalTransferConcurrency",
    path: ["transfers", "global_concurrency"],
    kind: "integer",
    defaultValue: 3,
    min: 1,
    step: 1,
    get: (root) => integerValue(valueAt(root, ["transfers", "global_concurrency"])) ?? 3,
    toConfigValue: (value) => configInteger(Number(value)),
  },
  {
    key: "transfers.per_host_concurrency",
    category: "transfers",
    label: "perHostTransferConcurrency",
    path: ["transfers", "per_host_concurrency"],
    kind: "integer",
    defaultValue: 2,
    min: 1,
    step: 1,
    get: (root) => integerValue(valueAt(root, ["transfers", "per_host_concurrency"])) ?? 2,
    toConfigValue: (value) => configInteger(Number(value)),
  },
  {
    key: "keybindings.terminal",
    category: "keybindings",
    label: "terminalKeybindings",
    path: ["keybindings", "terminal"],
    kind: "keybindings",
    defaultValue: defaultKeybindingMap(isMacPlatform()),
    get: (root) => {
      const table = valueAt(root, ["keybindings", "terminal"]);
      const defaults = defaultKeybindingMap(isMacPlatform());
      if (!table) return defaults;
      if (table.kind !== "Table") throw new Error("keybindings.terminal must be a table");
      const next: KeybindingMap = { ...defaults };
      for (const binding of terminalKeybindings) {
        const key = binding.command.replace("terminal.", "");
        const configured = stringValue(table.value[key]);
        if (configured !== undefined) next[binding.command] = configured;
      }
      return next;
    },
    toConfigValue: (value) => {
      const bindings = value as KeybindingMap;
      return {
        kind: "Table",
        value: Object.fromEntries(
          terminalKeybindings.map((binding) => [
            binding.command.replace("terminal.", ""),
            configString(bindings[binding.command]),
          ]),
        ),
      };
    },
  },
  {
    key: "host_dirs",
    category: "hosts",
    label: "hostDirs",
    path: ["host_dirs"],
    kind: "path-list",
    defaultValue: ["hosts"],
    get: (root) => stringArrayValue(valueAt(root, ["host_dirs"])) ?? ["hosts"],
    toConfigValue: (value) => {
      if (!Array.isArray(value)) {
        throw new Error("host directories must be a string array");
      }
      const items = value
        .map((item) => item.trim())
        .filter(Boolean);
      return configStringArray(items.length ? items : ["hosts"]);
    },
  },
  {
    key: "openssh_config_files",
    category: "hosts",
    label: "opensshConfigFiles",
    path: ["openssh_config_files"],
    kind: "path-list",
    defaultValue: ["~/.ssh/config"],
    get: (root) => stringArrayValue(valueAt(root, ["openssh_config_files"])) ?? ["~/.ssh/config"],
    toConfigValue: (value) => {
      if (!Array.isArray(value)) {
        throw new Error("OpenSSH config files must be a string array");
      }
      const items = value
        .map((item) => item.trim())
        .filter(Boolean);
      return configStringArray(items.length ? items : ["~/.ssh/config"]);
    },
  },
];
