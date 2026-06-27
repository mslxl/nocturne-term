import { beforeAll, describe, expect, it } from "vitest";

globalThis.self ??= globalThis as unknown as Window & typeof globalThis;

import type { TerminalSessionInfo } from "$lib/bindings";
import type { TerminalSession } from "./tabs";

let createTerminalPane: (info: TerminalSessionInfo) => TerminalSession;
let retargetTerminalPaneSession: (session: TerminalSession, info: TerminalSessionInfo) => void;
let handleTerminalPaneInput: (
  session: Pick<TerminalSession, "id" | "readOnly" | "reconnectPending">,
  data: string,
  callbacks: {
    markReconnectRequested?: (sessionId: string) => void;
    requestReconnect?: (sessionId: string) => void;
    writeTerminal: (data: string) => void;
  },
) => void;
let updateTerminalPaneDirectoryFromOutput: (session: TerminalSession, chunks: string[]) => boolean;

beforeAll(async () => {
  const tabs = await import("./tabs");
  createTerminalPane = tabs.createTerminalSession;
  retargetTerminalPaneSession = tabs.retargetTerminalSession;
  handleTerminalPaneInput = tabs.handleTerminalSessionInput;
  updateTerminalPaneDirectoryFromOutput = tabs.updateTerminalSessionDirectoryFromOutput;
});

describe("terminal sessions", () => {
  it("maps disconnected Agent sessions to read-only history sessions", () => {
    const session = createTerminalPane(sessionInfo({ transport_state: "disconnected" }));

    expect(session.status).toBe("disconnected");
    expect(session.readOnly).toBe(true);
    expect(session.exitText).toBe("History");
    expect(session.outputQueue.join("")).toContain("[Disconnected: cmd]");
  });

  it("retargets disconnected Agent sessions to read-only history sessions", () => {
    const session = createTerminalPane(sessionInfo());

    retargetTerminalPaneSession(session, sessionInfo({
      id: "term-2",
      transport_state: "disconnected",
      agent: { session_id: "registry-term-2" },
    }));

    expect(session.id).toBe("term-2");
    expect(session.agentSessionId).toBe("registry-term-2");
    expect(session.status).toBe("disconnected");
    expect(session.readOnly).toBe(true);
    expect(session.exitText).toBe("History");
    expect(session.outputQueue.join("")).toContain("[Disconnected: cmd]");
  });

  it("drops the input that triggers reconnect instead of writing it into the restarted session", () => {
    const session = {
      id: "term-3",
      readOnly: false,
      reconnectPending: true,
    } satisfies Pick<TerminalSession, "id" | "readOnly" | "reconnectPending">;
    const writes: string[] = [];
    const reconnects: string[] = [];
    const marks: string[] = [];

    handleTerminalPaneInput(session, "echo should-disappear", {
      writeTerminal: (data) => writes.push(data),
      requestReconnect: (sessionId) => reconnects.push(sessionId),
      markReconnectRequested: (sessionId) => marks.push(sessionId),
    });

    expect(writes).toEqual([]);
    expect(reconnects).toEqual(["term-3"]);
    expect(marks).toEqual(["term-3"]);
  });

  it("updates cwd from Windows prompt output when OSC 7 is unavailable", () => {
    const session = createTerminalPane(sessionInfo({
      title: "Session 1",
      cwd: null,
    }));
    session.titleOverride = "C:\\Windows\\system32\\WindowsPowerShell\\v1.0";

    const changed = updateTerminalPaneDirectoryFromOutput(session, [
      "\r\nC:\\Sources\\nocturne-term\\src-tauri>",
    ]);

    expect(changed).toBe(true);
    expect(session.currentDirectory).toBe("C:\\Sources\\nocturne-term\\src-tauri");
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
