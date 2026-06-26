import { beforeAll, describe, expect, it } from "vitest";

globalThis.self ??= globalThis as unknown as Window & typeof globalThis;

import type { TerminalSessionInfo } from "$lib/bindings";
import type { TerminalPane } from "./tabs";

let createTerminalPane: (info: TerminalSessionInfo, tabId: string) => TerminalPane;
let retargetTerminalPaneSession: (pane: TerminalPane, info: TerminalSessionInfo) => void;

beforeAll(async () => {
  ({ createTerminalPane, retargetTerminalPaneSession } = await import("./tabs"));
});

describe("createTerminalPane", () => {
  it("maps disconnected Agent sessions to read-only disconnected panes", () => {
    const pane = createTerminalPane(sessionInfo({ transport_state: "disconnected" }), "tab-a");

    expect(pane.status).toBe("disconnected");
    expect(pane.readOnly).toBe(true);
    expect(pane.exitText).toBe("History");
    expect(pane.outputQueue.join("")).toContain("[Disconnected: cmd]");
  });

  it("retargets disconnected Agent sessions to read-only history panes", () => {
    const pane = createTerminalPane(sessionInfo(), "tab-a");

    retargetTerminalPaneSession(pane, sessionInfo({
      id: "term-2",
      transport_state: "disconnected",
      agent: { session_id: "registry-term-2" },
    }));

    expect(pane.id).toBe("term-2");
    expect(pane.agentSessionId).toBe("registry-term-2");
    expect(pane.status).toBe("disconnected");
    expect(pane.readOnly).toBe(true);
    expect(pane.exitText).toBe("History");
    expect(pane.outputQueue.join("")).toContain("[Disconnected: cmd]");
  });
});

function sessionInfo(overrides: Partial<TerminalSessionInfo> = {}): TerminalSessionInfo {
  return {
    id: "term-1",
    title: "Session 1",
    command: "cmd",
    cwd: null,
    cols: 80,
    rows: 24,
    pixel_width: 800,
    pixel_height: 600,
    process_id: null,
    transport: "agent",
    transport_state: "connected",
    agent: { session_id: "term-1" },
    ...overrides,
  };
}
