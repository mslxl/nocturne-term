import { describe, expect, it } from "vitest";
import type { ConnectionHostDocument, ConnectionHostEntry } from "$lib/bindings";
import { emptySshHostDocument, setTerminalAgentMode, terminalAgentAvailableForHost, terminalAgentEnabledForHost, terminalAgentModeForEditableHost } from "./model";

function userHost(document: ConnectionHostDocument): ConnectionHostEntry {
  return {
    id: document.id,
    path: "host.toml",
    source: "user",
    read_only: false,
    document,
    diagnostics: [],
  };
}

describe("host terminal agent mode", () => {
  it("defaults editable host documents to enabled agent mode without persisting a terminal table", () => {
    const document = emptySshHostDocument("host-a");

    expect(terminalAgentModeForEditableHost(document)).toBe("enabled");
    expect(document.terminal).toBeNull();
  });

  it("persists only explicit disabled agent mode and clears the table when re-enabled", () => {
    const disabled = setTerminalAgentMode(emptySshHostDocument("host-a"), "disabled");
    const enabled = setTerminalAgentMode(disabled, "enabled");

    expect(disabled.terminal).toEqual({ agent_mode: "disabled" });
    expect(terminalAgentModeForEditableHost(disabled)).toBe("disabled");
    expect(enabled.terminal).toBeNull();
    expect(terminalAgentModeForEditableHost(enabled)).toBe("enabled");
  });

  it("allows agent mode edits for new and editable user hosts only", () => {
    const document = emptySshHostDocument("host-a");
    const editable = userHost(document);
    const readOnly = { ...editable, read_only: true };
    const openSsh = { ...editable, source: "open_ssh_config" as const, read_only: true };

    expect(terminalAgentAvailableForHost(null, "new")).toBe(true);
    expect(terminalAgentAvailableForHost(editable, "existing")).toBe(true);
    expect(terminalAgentAvailableForHost(readOnly, "existing")).toBe(false);
    expect(terminalAgentAvailableForHost(openSsh, "existing")).toBe(false);
  });

  it("treats enabled agent mode as the default for editable user hosts only", () => {
    const enabled = userHost(emptySshHostDocument("host-a"));
    const disabled = userHost(setTerminalAgentMode(emptySshHostDocument("host-a"), "disabled"));
    const openSsh = { ...enabled, source: "open_ssh_config" as const, read_only: true };
    const virtualLocal = {
      ...enabled,
      source: "virtual" as const,
      read_only: true,
      document: {
        ...enabled.document,
        protocol: "local" as const,
        local: { command: null, args: [], cwd: null, env: {} },
        ssh: null,
      },
    };

    expect(terminalAgentEnabledForHost(enabled)).toBe(true);
    expect(terminalAgentEnabledForHost(disabled)).toBe(false);
    expect(terminalAgentEnabledForHost(openSsh)).toBe(false);
    expect(terminalAgentEnabledForHost(virtualLocal)).toBe(true);
  });
});
