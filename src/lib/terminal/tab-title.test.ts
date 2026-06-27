import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { compactTerminalPathTitle, refreshTerminalTabTitleModel } from "./tab-title";

describe("terminal tab titles", () => {
  it("uses the session title when no custom title is set", () => {
    const tab = {
      id: "tab-1",
      title: "left",
      customTitle: "",
      session: { title: "right" },
    };

    refreshTerminalTabTitleModel(tab);

    assert.equal(tab.title, "right");
  });

  it("keeps a custom title when present", () => {
    const tab = {
      id: "tab-1",
      title: "custom",
      customTitle: " custom ",
      session: { title: "right" },
    };

    refreshTerminalTabTitleModel(tab);

    assert.equal(tab.title, "custom");
  });

  it("uses the running program title before the current directory", () => {
    const tab = {
      id: "tab-1",
      title: "left",
      customTitle: "",
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

  it("compacts shell path titles before using them as a running title", () => {
    const tab = {
      id: "tab-1",
      title: "left",
      customTitle: "",
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
      customTitle: "",
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
      customTitle: "",
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
      customTitle: "",
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
