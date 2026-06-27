import type { TerminalSessionInfo } from "$lib/bindings";

type AgentSessionNameEntry = {
  session_id: string;
  title: string;
};

export function mergeAgentSessionNamesFromRegistryList(
  current: Map<string, string>,
  sessions: readonly AgentSessionNameEntry[],
) {
  let next: Map<string, string> | null = null;
  for (const session of sessions) {
    const title = session.title.trim();
    if (!title || current.get(session.session_id) === title) continue;
    next ??= new Map(current);
    next.set(session.session_id, title);
  }
  return next ?? current;
}

export function mergeAgentSessionNameFromAttachInfo(
  current: Map<string, string>,
  info: Pick<TerminalSessionInfo, "agent" | "title">,
) {
  const sessionId = info.agent?.session_id ?? "";
  if (!sessionId || current.has(sessionId)) return current;
  const title = info.title.trim();
  if (!title) return current;
  const next = new Map(current);
  next.set(sessionId, title);
  return next;
}
