/*
 * Test content:
 *
 * Feature:
 * Verifies the Terminal Sessions ToolTab source contract for persistent
 * registry-backed terminal sessions.
 *
 * Operation:
 * Reads the Svelte component, main Workspace page, command palette, and Rust
 * terminal/workspace services. It checks that the ToolTab lists, attaches,
 * renames, and deletes single or selected sessions through registry-scoped
 * commands, is opened by a Workspace intent and command palette command, and
 * refreshes through explicit events/manual action instead of a timer. It also
 * verifies WebView reload restores existing PTYs, including agent-backed
 * sessions, instead of creating duplicate sessions.
 *
 * Expected:
 * Terminal Sessions is a first-class ToolTab that uses the helper-client
 * registry path for host-scoped sessions. It permits Terminal or Terminal Sessions
 * ToolTabs as the host scope for list/delete/attach/history operations
 * while opening attachments and exited-session history into normal Terminal
 * ToolTabs.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

describe("Terminal Sessions ToolTab source", () => {
  it("renders registry sessions with manual and event-driven refresh paths", async () => {
    const [component, page, commandsSource, terminalTabsSource, terminalRust, workspaceRust] = await Promise.all([
      readFile(new URL("../src/lib/terminal/TerminalSessionsToolTab.svelte", import.meta.url), "utf8"),
      readFile(new URL("../src/routes/+page.svelte", import.meta.url), "utf8"),
      readFile(new URL("../src/lib/command-palette/commands.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/lib/terminal/tabs.ts", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/terminal.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/workspace.rs", import.meta.url), "utf8"),
    ]);

    assert.match(component, /commands\.listDetachedTerminalSessions/);
    assert.match(component, /commands\.deleteDetachedTerminalSession/);
    assert.match(component, /commands\.renameDetachedTerminalSession/);
    assert.match(component, /onSessionsChanged\?: \(sessions: TerminalDetachedSessionInfo\[\]\) => void \| Promise<void>/);
    assert.doesNotMatch(component, /onRenamed\?:/);
    assert.match(component, /let selectedSessionIds = \$state\(new Set<string>\(\)\)/);
    assert.match(component, /let selecting = \$state\(false\)/);
    assert.match(component, /let renamingSessionId = \$state\(""\)/);
    assert.match(component, /let renameDraft = \$state\(""\)/);
    assert.match(component, /async function deleteSelectedSessions\(\)/);
    assert.match(component, /async function commitRenamingSession\(session: TerminalDetachedSessionInfo\)/);
    assert.match(component, /function handleRenameKeydown\(event: KeyboardEvent, session: TerminalDetachedSessionInfo\)/);
    assert.match(component, /let sessionContextMenu = \$state<\{ sessionId: string; left: number; top: number \} \| null>\(null\)/);
    assert.match(component, /function openSessionContextMenu\(event: MouseEvent, session: TerminalDetachedSessionInfo\)/);
    assert.match(component, /function renameSessionFromContextMenu\(session: TerminalDetachedSessionInfo\)/);
    assert.match(component, /async function deleteSessionFromContextMenu\(session: TerminalDetachedSessionInfo\)/);
    assert.match(component, /detached_session_id: session\.session_id/);
    assert.match(component, /title,\s*\}\),\s*\);/);
    assert.match(component, /sessions = sessions\.map\(\(item\) => \(item\.session_id === session\.session_id \? \{ \.\.\.item, title \} : item\)\)/);
    assert.match(component, /void notifySessionsChanged\(sessions\)/);
    assert.doesNotMatch(component, /onRenamed\?\./);
    assert.match(component, /sessionsToDelete = sessions\.filter\(\(session\) => selectedSessionIds\.has\(session\.session_id\)\)/);
    assert.match(component, /Delete \$\{sessionsToDelete\.length\} terminal sessions and their saved transcripts\?/);
    assert.match(component, /function enterSelectionMode/);
    assert.match(component, /function exitSelectionMode/);
    assert.match(component, /function selectAllSessions/);
    assert.match(component, /function invertSelectedSessions/);
    assert.match(component, /function sessionDisplayTitle\(session: TerminalDetachedSessionInfo\) \{\s*const title = session\.title\.trim\(\);\s*return title \|\| session\.session_id;\s*\}/);
    assert.match(component, /aria-label="Select terminal sessions"/);
    assert.match(component, /aria-label="Select all terminal sessions"/);
    assert.match(component, /aria-label="Invert terminal session selection"/);
    assert.match(component, /aria-label="Done selecting terminal sessions"/);
    assert.match(component, /aria-label="Delete selected terminal sessions"/);
    assert.match(component, /disabled=\{selectedSessionIds\.size === 0\}/);
    assert.match(component, /data-selected=\{selectedSessionIds\.has\(session\.session_id\)\}/);
    assert.match(component, /class="session-select-indicator"/);
    assert.match(component, /aria-pressed=\{selectedSessionIds\.has\(session\.session_id\)\}/);
    assert.match(component, /function toggleSessionSelected\(sessionId: string\)/);
    assert.match(component, /onclick=\{\(\) => toggleSessionSelected\(session\.session_id\)\}/);
    assert.match(component, /<Circle \/>/);
    assert.match(component, /<Check \/>/);
    assert.doesNotMatch(component, /type="checkbox"/);
    assert.doesNotMatch(component, /event\.currentTarget\.checked/);
    assert.match(component, /pruneSelectedSessions/);
    assert.match(component, /function sessionDisplayTitle/);
    assert.match(component, /session\.cwd\?\.trim\(\)/);
    assert.match(component, /aria-label=\{`Rename \$\{sessionDisplayTitle\(session\)\}`\}/);
    assert.match(component, /class="session-rename-input"/);
    assert.match(component, /bind:value=\{renameDraft\}/);
    assert.match(component, /onkeydown=\{\(event\) => handleRenameKeydown\(event, session\)\}/);
    assert.match(component, /event\.key === "Escape"/);
    assert.match(component, /event\.key === "Enter"/);
    assert.match(component, /oncontextmenu=\{\(event\) => openSessionContextMenu\(event, session\)\}/);
    assert.match(component, /data-session-context-menu="true"/);
    assert.match(component, /onclick=\{\(\) => renameSessionFromContextMenu\(menuSession\)\}>Rename<\/button>/);
    assert.match(component, /onclick=\{\(\) => void deleteSessionFromContextMenu\(menuSession\)\}>Delete<\/button>/);
    assert.doesNotMatch(component, /<Pencil \/>/);
    assert.doesNotMatch(component, /aria-label=\{`Delete \$\{sessionDisplayTitle\(session\)\}`\}/);
    assert.match(component, /title=\{sessionTooltip\(session\)\}/);
    assert.match(component, /title=\{sessionSubtitle\(session\)\}/);
    assert.match(component, /title=\{statusLabel\(session\)\}/);
    assert.doesNotMatch(component, /session\.cols\}x\{session\.rows/);
    assert.doesNotMatch(component, /\{session\.cols\}x\{session\.rows\}/);
    assert.match(component, /onOpenHistory/);
    assert.match(component, /View History/);
    assert.match(component, /attached_count/);
    assert.match(component, /Attached \$\{session\.attached_count\}/);
    assert.match(component, /aria-label="Refresh terminals"/);
    assert.match(component, /aria-label="Terminal sessions"/);
    assert.match(component, /session\.detached/);
    assert.match(component, /<strong>Terminals<\/strong>/);
    assert.match(component, /OverlayScrollbarsComponent element="div" class="sessions-body-scroll"/);
    assert.match(component, /let sessionsOverflow = \$state\(false\)/);
    assert.match(component, /bind:this=\{sessionsBody\}/);
    assert.match(component, /bind:this=\{sessionsList\}/);
    assert.match(component, /ResizeObserver/);
    assert.match(component, /sessionsList\.scrollHeight > sessionsBody\.clientHeight \+ 1/);
    assert.match(component, /{:else if sessions.length === 0}\s*<div class="sessions-status">No sessions<\/div>\s*{:else}\s*<OverlayScrollbarsComponent/);
    assert.doesNotMatch(component, /{:else if sessionsOverflow}/);
    assert.doesNotMatch(component, /class="sessions-list-frame"/);
    assert.match(component, /\.sessions-list\s*\{[\s\S]*grid-auto-rows:\s*minmax\(44px,\s*max-content\);/);
    assert.match(component, /container-type:\s*inline-size;/);
    assert.match(component, /grid-template-areas:\s*"main meta actions";/);
    assert.match(component, /grid-template-columns:\s*minmax\(0,\s*1fr\) auto auto;/);
    assert.match(component, /@container \(max-width: 190px\)/);
    assert.match(component, /grid-template-areas:\s*"main actions"\s*"meta actions";/);
    assert.match(component, /grid-area:\s*main;/);
    assert.match(component, /grid-area:\s*meta;/);
    assert.match(component, /grid-area:\s*actions;/);
    assert.match(component, /data-selecting=\{selecting\}/);
    assert.match(component, /header\[data-selecting="true"\]/);
    assert.match(component, /li\[data-selecting="true"\]/);
    assert.match(component, /\.sessions-list\s*\{[\s\S]*align-content:\s*start;/);
    assert.match(component, /y:\s*"scroll"/);
    assert.match(component, /visibility:\s*"auto"/);
    assert.match(component, /autoHide:\s*"leave"/);
    assert.match(component, /class="sessions-body"/);
    assert.match(component, /overflow: hidden;/);
    assert.match(component, /grid-template-rows: minmax\(0, 1fr\);/);
    assert.match(component, /\.terminal-sessions-tooltab\s*\{[\s\S]*box-sizing:\s*border-box;/);
    assert.match(component, /:global\(\.sessions-body-scroll\)\s*\{[\s\S]*box-sizing:\s*border-box;/);
    assert.doesNotMatch(component, /setInterval/);
    assert.doesNotMatch(component, /refetchInterval/);
    assert.doesNotMatch(component, /class="sessions-list-scroll"/);

    assert.match(page, /import TerminalSessionsToolTab from "\$lib\/terminal\/TerminalSessionsToolTab\.svelte"/);
    assert.match(page, /workspaceId: tool\?\.owner_workspace_id \?\? ""/);
    assert.match(page, /toolTabId: tab\.id/);
    assert.match(page, /const reloadTabsStorageKey = "nocturne:reload-tabs"/);
    assert.match(page, /let reloadSnapshotQueued = false/);
    assert.match(page, /let pageMounted = false/);
    assert.match(page, /function scheduleReloadTabsSnapshot\(\)/);
    assert.match(page, /queueMicrotask\(\(\) => \{[\s\S]*storeReloadTabsSnapshot\(\);[\s\S]*\}\)/);
    assert.match(page, /\$effect\(\(\) => \{[\s\S]*terminalRuntimeByToolTabId;[\s\S]*activeTerminalToolTabId;[\s\S]*activeId;[\s\S]*if \(pageMounted\) scheduleReloadTabsSnapshot\(\);[\s\S]*\}\);/);
    assert.match(page, /function storeReloadTabsSnapshot\(\)/);
    assert.match(page, /if \(tabs\.length === 0\) \{\s*sessionStorage\.removeItem\(reloadTabsStorageKey\);\s*return;\s*\}/);
    assert.match(page, /sessionStorage\.setItem\(reloadTabsStorageKey, JSON\.stringify\(stored\)\)/);
    assert.match(page, /async function restoreReloadedTabs\(\)/);
    assert.match(page, /sessionStorage\.removeItem\(reloadTabsStorageKey\)/);
    assert.match(page, /window\.addEventListener\("pagehide", handlePageHide\)/);
    assert.match(page, /function setTerminalRuntime[\s\S]*scheduleReloadTabsSnapshot\(\);[\s\S]*publishWorkspaceDebugSnapshot/);
    assert.match(page, /function deleteTerminalRuntime[\s\S]*scheduleReloadTabsSnapshot\(\);[\s\S]*publishWorkspaceDebugSnapshot/);
    assert.match(page, /storeReloadTabsSnapshot\(\);[\s\S]*for \(const tab of terminalRuntimeTabs\(\)\) \{[\s\S]*disposeTerminalTab\(tab\);/);
    assert.doesNotMatch(page, /nocturne:dev-hot-tabs/);
    assert.doesNotMatch(page, /restoreHotTabs/);
    assert.match(page, /const reattachesAgentSession = session\.agentBacked && session\.agentSessionId && !session\.readOnly && stored\.workspaceId && stored\.toolTabId/);
    assert.match(page, /commands\.attachDetachedTerminalSession\(\{\s*workspace_id: stored\.workspaceId,\s*tool_tab_id: stored\.toolTabId,\s*detached_session_id: session\.agentSessionId,/);
    assert.match(page, /commands\.existingTerminalSessionInfo\(\{ session_id: session\.id \}\)/);
    assert.match(page, /if \(!reattachesAgentSession\) \{\s*restored\.title = session\.title;\s*restored\.baseTitle = session\.baseTitle;\s*\}/);
    assert.match(page, /tool\.kind === "terminal_sessions"/);
    assert.match(page, /kind:\s*"open_terminal_sessions_tool_tab"/);
    assert.match(page, /terminalSessionsRevision \+= 1/);
    assert.match(
      page,
      /async function reconnectHostSession[\s\S]*retargetTerminalSession\(session, info\);[\s\S]*if \(session\.agentBacked\) terminalSessionsRevision \+= 1;/,
    );
    assert.match(page, /onAttach=\{attachDetachedTerminalSession\}/);
    assert.match(page, /onOpenHistory=\{openDetachedTerminalSessionHistory\}/);
    assert.match(page, /commands\.openDetachedTerminalSessionHistory/);
    assert.match(page, /async function createEmptyTerminalToolTabForWorkspace[\s\S]*dispatchWorkspaceIntent\(\{/);
    assert.match(page, /session\.readOnly = true/);
    assert.match(page, /data-terminal-read-only=\{session\.readOnly \? "true" : "false"\}/);
    assert.match(page, /data-terminal-status=\{session\.status\}/);
    assert.match(page, /data-terminal-exit-text=\{session\.exitText\}/);
    assert.match(page, /data-agent-session-id=\{session\.agentSessionId\}/);
    assert.match(page, /function terminalSessionTooltip\(session: TerminalSession, displayTitle: string\)/);
    assert.match(page, /let agentSessionNamesById = \$state\(new Map<string, string>\(\)\)/);
    assert.match(page, /function updateAgentSessionNamesFromDetachedSessions\(sessions:/);
    assert.match(page, /function applyAgentSessionNamesToOpenTerminals/);
    assert.match(page, /const registryTitle = session\.agentSessionName\.trim\(\)/);
    assert.match(page, /const lines = \[registryTitle \|\| displayTitle\.trim\(\) \|\| "Terminal"\]/);
    assert.match(page, /onSessionsChanged=\{updateAgentSessionNamesFromDetachedSessions\}/);
    assert.doesNotMatch(page, /function renameOpenTerminalAgentSession/);
    assert.doesNotMatch(page, /session\.baseTitle = trimmed/);
    assert.doesNotMatch(page, /onRenamed=/);
    assert.doesNotMatch(page, /Session: \$\{agentSessionId\}/);
    assert.match(commandsSource, /tool\.openTerminalSessions/);
    assert.match(terminalTabsSource, /updateTerminalSessionDirectoryFromOutput\(session, chunks\)[\s\S]*refreshTitleForSession\(session\)/);
    assert.match(terminalTabsSource, /function inferDirectoryFromPromptOutput/);
    assert.match(terminalRust, /cwd: session\.cwd\.clone\(\)/);

    assert.match(workspaceRust, /OpenTerminalSessionsToolTab/);
    assert.match(workspaceRust, /WorkspaceToolKind::TerminalSessions/);
    assert.match(terminalRust, /owned_workspace_tool_host_for_kinds/);
    assert.match(terminalRust, /WorkspaceToolKind::TerminalSessions/);
    assert.match(terminalRust, /open_detached_terminal_session_history/);
    assert.match(terminalRust, /TerminalBackend::AgentHistory/);
  });
});
