import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { compactTerminalPathTitle, refreshTerminalTabTitleModel } from "./tab-title";

describe("terminal tab titles", () => {
  it("uses the session title when no live title is known", () => {
    const tab = {
      id: "tab-1",
      title: "left",
      session: { title: "right" },
    };

    refreshTerminalTabTitleModel(tab);

    assert.equal(tab.title, "right");
  });

  it("uses the running program title before the current directory", () => {
    const tab = {
      id: "tab-1",
      title: "left",
      session: {
        title: "Local Shell",
        command: "pwsh",
        currentDirectory: "C:\\Sources\\nocturne-term",
        titleOverride: "vim main.go",
      },
    };

    refreshTerminalTabTitleModel(tab);

    assert.equal(tab.title, "vim main.go");
  });

  it("appends the registry session name for Terminal Agent tabs", () => {
    const tab = {
      id: "tab-1",
      title: "left",
      session: {
        title: "BraveBeacon",
        baseTitle: "BraveBeacon",
        command: "pwsh",
        currentDirectory: "C:\\Sources\\nocturne-term",
        titleOverride: "vim main.go",
        agentBacked: true,
      },
    };

    refreshTerminalTabTitleModel(tab);

    assert.equal(tab.title, "vim main.go · BraveBeacon");
  });

  it("uses the command before the registry session name when an attached Agent view has no cwd yet", () => {
    const tab = {
      id: "tab-1",
      title: "left",
      session: {
        title: "BraveBeacon",
        baseTitle: "BraveBeacon",
        command: "pwsh",
        currentDirectory: "",
        titleOverride: "",
        agentBacked: true,
      },
    };

    refreshTerminalTabTitleModel(tab);

    assert.equal(tab.title, "pwsh · BraveBeacon");
  });

  it("uses the observed Agent session name instead of stale session fields", () => {
    const tab = {
      id: "tab-1",
      title: "left",
      session: {
        title: "OldName",
        baseTitle: "OldName",
        agentSessionName: "RenamedBuild",
        command: "pwsh",
        currentDirectory: "",
        titleOverride: "",
        agentBacked: true,
      },
    };

    refreshTerminalTabTitleModel(tab);

    assert.equal(tab.title, "pwsh · RenamedBuild");
  });

  it("does not append the session name outside Terminal Agent mode", () => {
    const tab = {
      id: "tab-1",
      title: "left",
      session: {
        title: "BraveBeacon",
        baseTitle: "BraveBeacon",
        command: "pwsh",
        currentDirectory: "C:\\Sources\\nocturne-term",
        titleOverride: "vim main.go",
        agentBacked: false,
      },
    };

    refreshTerminalTabTitleModel(tab);

    assert.equal(tab.title, "vim main.go");
  });

  it("compacts shell path titles before using them as a running title", () => {
    const tab = {
      id: "tab-1",
      title: "left",
      session: {
        title: "Local Shell",
        command: "pwsh",
        currentDirectory: "C:\\Sources\\nocturne-term\\src-tauri",
        titleOverride: "C:\\Sources\\nocturne-term\\src-tauri",
      },
    };

    refreshTerminalTabTitleModel(tab);

    assert.equal(tab.title, "src-tauri");
  });

  it("uses cwd before a path-like shell title from another directory", () => {
    const tab = {
      id: "tab-1",
      title: "left",
      session: {
        title: "Local Shell",
        command: "pwsh",
        currentDirectory: "C:\\Sources\\nocturne-term\\src-tauri",
        titleOverride: "C:\\Windows\\system32\\WindowsPowerShell\\v1.0",
      },
    };

    refreshTerminalTabTitleModel(tab);

    assert.equal(tab.title, "src-tauri");
  });

  it("uses a short current directory label when no program title is active", () => {
    const tab = {
      id: "tab-1",
      title: "left",
      session: {
        title: "Local Shell",
        command: "pwsh",
        currentDirectory: "C:\\Sources\\nocturne-term",
        titleOverride: "",
      },
    };

    refreshTerminalTabTitleModel(tab);

    assert.equal(tab.title, "nocturne-term");
  });

  it("uses the command instead of generated Session titles when no cwd is known yet", () => {
    const tab = {
      id: "tab-1",
      title: "Session 1",
      session: {
        title: "Session 1",
        command: "pwsh",
        currentDirectory: "",
        titleOverride: "",
      },
    };

    refreshTerminalTabTitleModel(tab);

    assert.equal(tab.title, "pwsh");
  });

  it("compacts Windows and POSIX paths for tab labels", () => {
    assert.equal(compactTerminalPathTitle("C:\\Sources\\nocturne-term\\src-tauri"), "src-tauri");
    assert.equal(compactTerminalPathTitle("/Users/alice/Projects/nocturne-term"), "nocturne-term");
    assert.equal(compactTerminalPathTitle("~/Projects/nocturne-term"), "nocturne-term");
    assert.equal(compactTerminalPathTitle("C:\\"), "C:\\");
    assert.equal(compactTerminalPathTitle("/"), "/");
    assert.equal(compactTerminalPathTitle("~"), "~");
  });
});
