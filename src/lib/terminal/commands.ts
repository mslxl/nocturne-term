type CommandResult<T, E> = { status: "ok"; data: T } | { status: "error"; error: E };

export async function unwrapCommand<T, E>(result: Promise<CommandResult<T, E>>): Promise<T> {
  const resolved = await result;
  if (resolved.status === "ok") return resolved.data;
  throw new Error(formatCommandError(resolved.error));
}

function formatCommandError(error: unknown): string {
  if (isRecord(error) && typeof error.kind === "string") {
    const message = isRecord(error.message) && typeof error.message.message === "string" ? error.message.message : "";
    return message ? `${error.kind}: ${message}` : error.kind;
  }
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
