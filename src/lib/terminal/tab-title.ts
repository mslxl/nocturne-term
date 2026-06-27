type TabTitleSession = {
  title: string;
  baseTitle?: string;
  agentSessionName?: string;
  command?: string;
  currentDirectory?: string;
  titleOverride?: string;
  agentBacked?: boolean;
};

type TabTitleModel = {
  id: string;
  title: string;
  session: TabTitleSession;
};

export function refreshTerminalTabTitleModel(tab: TabTitleModel) {
  const sessionTitle = terminalSessionDisplayTitle(tab.session);
  if (!sessionTitle) throw new Error(`terminal session ${tab.id} has an empty title`);
  tab.title = sessionTitle;
}

export function terminalSessionDisplayTitle(session: TabTitleSession) {
  const activityTitle = terminalSessionActivityTitle(session);
  if (!session.agentBacked) return activityTitle;
  const registryTitle = terminalAgentRegistryTitle(session);
  if (!activityTitle) return registryTitle;
  if (!registryTitle || registryTitle === activityTitle) return activityTitle;
  return `${activityTitle} · ${registryTitle}`;
}

function terminalSessionActivityTitle(session: TabTitleSession) {
  const titleOverride = session.titleOverride?.trim() ?? "";
  const currentDirectory = session.currentDirectory?.trim() ?? "";
  if (titleOverride && !isPathLikeTitle(titleOverride)) return titleOverride;
  if (currentDirectory) return compactTerminalPathTitle(currentDirectory);
  if (titleOverride) return compactTerminalTitle(titleOverride);
  if (session.agentBacked) return session.command?.trim() ?? "";

  const sessionTitle = session.title.trim();
  if (sessionTitle && !isGeneratedSessionTitle(sessionTitle) && !isPathLikeTitle(sessionTitle)) return sessionTitle;
  if (sessionTitle && !isGeneratedSessionTitle(sessionTitle)) return compactTerminalTitle(sessionTitle);

  return session.command?.trim() ?? session.baseTitle?.trim() ?? "";
}

function terminalAgentRegistryTitle(session: TabTitleSession) {
  const observedName = session.agentSessionName?.trim() ?? "";
  if (observedName && !isGeneratedSessionTitle(observedName) && !isPathLikeTitle(observedName)) return observedName;
  const baseTitle = session.baseTitle?.trim() ?? "";
  const sessionTitle = session.title.trim();
  const title = baseTitle || sessionTitle;
  if (!title || isGeneratedSessionTitle(title) || isPathLikeTitle(title)) return "";
  return title;
}

export function compactTerminalTitle(title: string) {
  const trimmed = title.trim();
  if (!trimmed) return "";
  return isPathLikeTitle(trimmed) ? compactTerminalPathTitle(trimmed) : trimmed;
}

export function compactTerminalPathTitle(path: string) {
  const trimmed = path.trim();
  if (!trimmed) return "";
  if (trimmed === "~" || trimmed === "/") return trimmed;
  if (/^[A-Za-z]:[\\/]?$/.test(trimmed)) return trimmed.replace("/", "\\");

  const withoutTrailingSeparators = trimmed.replace(/[\\/]+$/, "");
  if (!withoutTrailingSeparators) return trimmed;
  const parts = withoutTrailingSeparators.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1)?.trim() || trimmed;
}

export function isPathLikeTitle(title: string) {
  if (title === "~" || title === "/") return true;
  if (/^[A-Za-z]:[\\/]/.test(title)) return true;
  if (title.startsWith("~/") || title.startsWith("~\\")) return true;
  if (title.startsWith("/") && title.length > 1) return true;
  return title.includes("\\");
}

export function isGeneratedSessionTitle(title: string) {
  return /^Session \d+$/.test(title.trim());
}
