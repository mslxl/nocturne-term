import type {
  ConfigTable,
  ConfigValue,
  MainConfigDocument,
  ProfileConfigDocument,
} from "$lib/bindings";

export type AppTheme = "system" | "light" | "dark";
export type AppLanguage = "en" | "zh";
export type ConfigDocument = MainConfigDocument | ProfileConfigDocument;

export function cloneDocument<T extends ConfigDocument>(document: T): T {
  return JSON.parse(JSON.stringify(document)) as T;
}

export function readValue(table: ConfigTable, path: string[]): ConfigValue | undefined {
  let values: Record<string, ConfigValue> = table.values;
  for (let index = 0; index < path.length; index += 1) {
    const value = values[path[index]];
    if (!value) return undefined;
    if (index === path.length - 1) return value;
    if (value.kind !== "Table") return undefined;
    values = value.value;
  }
  return undefined;
}

export function hasValue(table: ConfigTable, path: string[]): boolean {
  return readValue(table, path) !== undefined;
}

export function writeValue(table: ConfigTable, path: string[], value: ConfigValue) {
  if (path.length === 0) throw new Error("config path cannot be empty");
  let values: Record<string, ConfigValue> = table.values;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    const current = values[key];
    if (current && current.kind !== "Table") {
      throw new Error(`config path ${path.slice(0, index + 1).join(".")} is not a table`);
    }
    if (!current) {
      values[key] = { kind: "Table", value: {} };
    }
    const next = values[key];
    if (next.kind !== "Table") {
      throw new Error(`config path ${path.slice(0, index + 1).join(".")} is not a table`);
    }
    values = next.value;
  }
  values[path[path.length - 1]] = value;
}

export function stringValue(value: ConfigValue | undefined): string | undefined {
  if (!value) return undefined;
  if (value.kind !== "String") throw new Error("expected string config value");
  return value.value;
}

export function numberValue(value: ConfigValue | undefined): number | undefined {
  if (!value) return undefined;
  if (value.kind !== "Float") throw new Error("expected float config value");
  if (value.value === null) throw new Error("float config value cannot be null");
  return value.value;
}

export function integerValue(value: ConfigValue | undefined): number | undefined {
  if (!value) return undefined;
  if (value.kind !== "Integer") throw new Error("expected integer config value");
  const parsed = Number(value.value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`integer config value is not safe for editing: ${value.value}`);
  return parsed;
}

export function booleanValue(value: ConfigValue | undefined): boolean | undefined {
  if (!value) return undefined;
  if (value.kind !== "Boolean") throw new Error("expected boolean config value");
  return value.value;
}

export function stringArrayValue(value: ConfigValue | undefined): string[] | undefined {
  if (!value) return undefined;
  if (value.kind !== "Array") throw new Error("expected array config value");
  return value.value.map((item) => {
    if (item.kind !== "String") throw new Error("expected string item in config array");
    return item.value;
  });
}

export function configString(value: string): ConfigValue {
  return { kind: "String", value };
}

export function configFloat(value: number): ConfigValue {
  return { kind: "Float", value };
}

export function configInteger(value: number): ConfigValue {
  if (!Number.isSafeInteger(value)) throw new Error("integer config value must be a safe integer");
  return { kind: "Integer", value: String(value) };
}

export function configBoolean(value: boolean): ConfigValue {
  return { kind: "Boolean", value };
}

export function configStringArray(value: string[]): ConfigValue {
  return { kind: "Array", value: value.map(configString) };
}

export function appThemeFromConfig(value: ConfigValue | undefined): AppTheme {
  const theme = stringValue(value);
  if (!theme) return "system";
  if (theme === "system" || theme === "light" || theme === "dark") return theme;
  throw new Error(`unsupported ui.theme value: ${theme}`);
}

export function appLanguageFromConfig(value: ConfigValue | undefined): AppLanguage {
  const language = stringValue(value);
  if (language === "zh" || language === "en") return language;
  if (!language) return defaultLanguage();
  throw new Error(`unsupported ui.language value: ${language}`);
}

export function defaultLanguage(): AppLanguage {
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function resolveTheme(theme: AppTheme): "light" | "dark" {
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyAppPreferences(table: ConfigTable) {
  const theme = appThemeFromConfig(readValue(table, ["ui", "theme"]));
  const language = appLanguageFromConfig(readValue(table, ["ui", "language"]));
  document.documentElement.dataset.theme = resolveTheme(theme);
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  window.dispatchEvent(new CustomEvent("nocturne://language", { detail: language }));
}
