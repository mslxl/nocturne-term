/*
 * Test content:
 *
 * Feature:
 * Verifies the Terminal Sessions ToolTab source contract for persistent
 * registry-backed terminal sessions.
 *
 * Operation:
 * Reads the Svelte component, main Workspace page, command palette, and Rust
 * terminal/workspace services. It checks that the ToolTab lists, attaches, and
 * deletes single or selected sessions through the existing registry-scoped
 * commands, is opened by a Workspace intent and command palette command, and
 * refreshes through explicit events/manual action instead of a timer.
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
    assert.match(component, /let selectedSessionIds = \$state\(new Set<string>\(\)\)/);
    assert.match(component, /let selecting = \$state\(false\)/);
    assert.match(component, /async function deleteSelectedSessions\(\)/);
    assert.match(component, /sessionsToDelete = sessions\.filter\(\(session\) => selectedSessionIds\.has\(session\.session_id\)\)/);
    assert.match(component, /Delete \$\{sessionsToDelete\.length\} terminal sessions and their saved transcripts\?/);
    assert.match(component, /function enterSelectionMode/);
    assert.match(component, /function exitSelectionMode/);
    assert.match(component, /function selectAllSessions/);
    assert.match(component, /function invertSelectedSessions/);
    assert.match(component, /aria-label="Select terminal sessions"/);
    assert.match(component, /aria-label="Select all terminal sessions"/);
    assert.match(component, /aria-label="Invert terminal session selection"/);
    assert.match(component, /aria-label="Done selecting terminal sessions"/);
    assert.match(component, /aria-label="Delete selected terminal sessions"/);
    assert.match(component, /disabled=\{selectedSessionIds\.size === 0\}/);
    assert.match(component, /\{#if selecting\}[\s\S]*type="checkbox"/);
    assert.match(component, /type="checkbox"/);
    assert.match(component, /checked=\{selectedSessionIds\.has\(session\.session_id\)\}/);
    assert.match(component, /toggleSessionSelection\(session\.session_id, event\.currentTarget\.checked\)/);
    assert.match(component, /pruneSelectedSessions/);
    assert.match(component, /function sessionDisplayTitle/);
    assert.match(component, /isGeneratedSessionTitle/);
    assert.match(component, /session\.cwd\?\.trim\(\)/);
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
    assert.match(component, /{:else if sessionsOverflow}/);
    assert.match(component, /{:else if sessions.length === 0}\s*<div class="sessions-status">No sessions<\/div>\s*{:else if sessionsOverflow}/);
    assert.match(component, /{:else if sessionsOverflow}\s*<OverlayScrollbarsComponent/);
    assert.match(component, /class="sessions-list-frame"/);
    assert.match(component, /\.sessions-list-frame\s*\{[\s\S]*align-content:\s*start;/);
    assert.match(component, /\.sessions-list\s*\{[\s\S]*grid-auto-rows:\s*minmax\(44px,\s*max-content\);/);
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
