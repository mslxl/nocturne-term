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
 * deletes through the existing registry-scoped commands, is opened by a
 * Workspace intent and command palette command, and refreshes through explicit
 * events/manual action instead of a timer.
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
    const [component, page, commandsSource, terminalRust, workspaceRust] = await Promise.all([
      readFile(new URL("../src/lib/terminal/TerminalSessionsToolTab.svelte", import.meta.url), "utf8"),
      readFile(new URL("../src/routes/+page.svelte", import.meta.url), "utf8"),
      readFile(new URL("../src/lib/command-palette/commands.ts", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/terminal.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/workspace.rs", import.meta.url), "utf8"),
    ]);

    assert.match(component, /commands\.listDetachedTerminalSessions/);
    assert.match(component, /commands\.deleteDetachedTerminalSession/);
    assert.match(component, /onOpenHistory/);
    assert.match(component, /View History/);
    assert.match(component, /attached_count/);
    assert.match(component, /Attached \$\{session\.attached_count\}/);
    assert.match(component, /aria-label="Refresh terminals"/);
    assert.match(component, /aria-label="Terminals"/);
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
    assert.match(component, /\.sessions-list\s*\{[\s\S]*grid-auto-rows:\s*minmax\(36px,\s*max-content\);/);
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
    assert.match(page, /onAttach=\{attachDetachedTerminalSession\}/);
    assert.match(page, /onOpenHistory=\{openDetachedTerminalSessionHistory\}/);
    assert.match(page, /commands\.openDetachedTerminalSessionHistory/);
    assert.match(page, /async function createEmptyTerminalToolTabForWorkspace[\s\S]*dispatchWorkspaceIntent\(\{/);
    assert.match(page, /pane\.readOnly = true/);
    assert.match(page, /data-terminal-read-only=\{pane\.readOnly \? "true" : "false"\}/);
    assert.match(page, /data-terminal-status=\{pane\.status\}/);
    assert.match(page, /data-terminal-exit-text=\{pane\.exitText\}/);
    assert.match(page, /data-agent-session-id=\{pane\.agentSessionId\}/);
    assert.match(commandsSource, /tool\.openTerminalSessions/);

    assert.match(workspaceRust, /OpenTerminalSessionsToolTab/);
    assert.match(workspaceRust, /WorkspaceToolKind::TerminalSessions/);
    assert.match(terminalRust, /owned_workspace_tool_host_for_kinds/);
    assert.match(terminalRust, /WorkspaceToolKind::TerminalSessions/);
    assert.match(terminalRust, /open_detached_terminal_session_history/);
    assert.match(terminalRust, /TerminalBackend::AgentHistory/);
  });
});
