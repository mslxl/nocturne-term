import { debug, error, info, trace, warn } from "@tauri-apps/plugin-log";
import { hasTauriRuntime } from "$lib/tauri/runtime";

const MAX_LOG_MESSAGE_LENGTH = 20_000;
const TAURI_IPC_FALLBACK_WARNING =
  "IPC custom protocol failed, Tauri will now use the postMessage interface instead";

let initialized = false;

export type ConsoleMethod = "debug" | "error" | "info" | "log" | "trace" | "warn";

const loggers = {
  debug,
  error,
  info,
  log: info,
  trace,
  warn
} satisfies Record<ConsoleMethod, (message: string) => Promise<void>>;

export function forwardConsoleToBackendLogs(): void {
  if (initialized || !hasTauriRuntime()) {
    return;
  }
  initialized = true;

  for (const method of Object.keys(loggers) as ConsoleMethod[]) {
    const original = console[method].bind(console);
    console[method] = (...values: unknown[]) => {
      original(...values);

      if (!shouldForwardConsoleLog(method, values)) {
        return;
      }

      void loggers[method](formatConsoleValuesForLog(values)).catch((logError: unknown) => {
        original("failed to forward console log to backend", logError);
      });
    };
  }
}

export function shouldForwardConsoleLog(method: ConsoleMethod, values: unknown[]): boolean {
  return !isRecoverableTauriIpcFallbackWarning(method, values);
}

export function formatConsoleValuesForLog(values: unknown[]): string {
  const message = values.map((value) => formatConsoleValue(value, new Set())).join(" ");
  if (message.length <= MAX_LOG_MESSAGE_LENGTH) {
    return message;
  }

  return `${message.slice(0, MAX_LOG_MESSAGE_LENGTH)}...[truncated]`;
}

function isRecoverableTauriIpcFallbackWarning(method: ConsoleMethod, values: unknown[]): boolean {
  return method === "warn" && values[0] === TAURI_IPC_FALLBACK_WARNING;
}

function formatConsoleValue(value: unknown, ancestors: Set<object>): string {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }

  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }

  if (value === undefined) {
    return "undefined";
  }

  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }

  if (typeof value !== "object" || value === null) {
    return String(value);
  }

  return JSON.stringify(toLogValue(value, ancestors));
}

function toLogValue(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }

  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }

  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  if (ancestors.has(value)) {
    return "[Circular]";
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => toLogValue(item, ancestors));
    }

    const entries = Reflect.ownKeys(value).map((key) => [
      String(key),
      toLogValue(readPropertyForLog(value, key), ancestors)
    ]);
    return Object.fromEntries(entries);
  } finally {
    ancestors.delete(value);
  }
}

function readPropertyForLog(value: object, key: string | symbol): unknown {
  try {
    return (value as Record<string | symbol, unknown>)[key];
  } catch (error) {
    return `[Thrown while reading: ${errorMessage(error)}]`;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
