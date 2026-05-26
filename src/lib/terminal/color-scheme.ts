export type TerminalColorSchemeVariant = "light" | "dark";

export type TerminalColorSchemeSource = "builtin" | "user" | "legacy";

export type TerminalColorScheme = {
  id: string;
  name: string;
  author: string | null;
  variant: TerminalColorSchemeVariant;
  background: string;
  foreground: string;
  cursor: string;
  selection_background: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  bright_black: string;
  bright_red: string;
  bright_green: string;
  bright_yellow: string;
  bright_blue: string;
  bright_magenta: string;
  bright_cyan: string;
  bright_white: string;
};

export type TerminalColorSchemeEntry = {
  id: string;
  source: TerminalColorSchemeSource;
  path: string | null;
  scheme: TerminalColorScheme;
};

export const builtInLightSchemeId = "builtin:nocturne-light";
export const builtInDarkSchemeId = "builtin:nocturne-dark";

export function emptyScheme(id: string, variant: TerminalColorSchemeVariant): TerminalColorScheme {
  return {
    id,
    name: id,
    author: null,
    variant,
    background: variant === "light" ? "#fbfbfb" : "#101113",
    foreground: variant === "light" ? "#202124" : "#eef1f6",
    cursor: variant === "light" ? "#1f6feb" : "#eef1f6",
    selection_background: variant === "light" ? "#c8ddff" : "#36506f",
    black: variant === "light" ? "#25292e" : "#1f2329",
    red: variant === "light" ? "#cf222e" : "#e06c75",
    green: variant === "light" ? "#116329" : "#98c379",
    yellow: variant === "light" ? "#9a6700" : "#e5c07b",
    blue: variant === "light" ? "#0969da" : "#61afef",
    magenta: variant === "light" ? "#8250df" : "#c678dd",
    cyan: variant === "light" ? "#1b7c83" : "#56b6c2",
    white: variant === "light" ? "#eaeef2" : "#d7dae0",
    bright_black: variant === "light" ? "#57606a" : "#5c6370",
    bright_red: variant === "light" ? "#a40e26" : "#f28b91",
    bright_green: variant === "light" ? "#1a7f37" : "#b4d99c",
    bright_yellow: variant === "light" ? "#bf8700" : "#f0d49a",
    bright_blue: variant === "light" ? "#218bff" : "#82c4ff",
    bright_magenta: variant === "light" ? "#a475f9" : "#d99af0",
    bright_cyan: variant === "light" ? "#3192aa" : "#7fd3df",
    bright_white: "#ffffff",
  };
}
