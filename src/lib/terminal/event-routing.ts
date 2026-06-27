export function shouldHandleTerminalSessionEvent(sessionId: string, localSessionIds: Iterable<string>): boolean {
  if (!sessionId.trim()) return false;
  for (const localSessionId of localSessionIds) {
    if (localSessionId === sessionId) return true;
  }
  return false;
}

export function routeTerminalSessionEvent(
  sessionId: string,
  localSessionIds: Iterable<string>,
  handle: (sessionId: string) => void,
): boolean {
  if (!shouldHandleTerminalSessionEvent(sessionId, localSessionIds)) return false;
  handle(sessionId);
  return true;
}
