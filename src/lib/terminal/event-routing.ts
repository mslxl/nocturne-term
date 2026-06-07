export function shouldHandleTerminalPaneEvent(paneId: string, localPaneIds: Iterable<string>): boolean {
  if (!paneId.trim()) return false;
  for (const localPaneId of localPaneIds) {
    if (localPaneId === paneId) return true;
  }
  return false;
}

export function routeTerminalPaneEvent(
  paneId: string,
  localPaneIds: Iterable<string>,
  handle: (paneId: string) => void,
): boolean {
  if (!shouldHandleTerminalPaneEvent(paneId, localPaneIds)) return false;
  handle(paneId);
  return true;
}
