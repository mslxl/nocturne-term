import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { refreshTerminalTabTitleModel } from "./tab-title";

describe("terminal tab titles", () => {
  it("uses logical pane count instead of the zoomed visible tree count", () => {
    const tab = {
      id: "tab-1",
      title: "left | 2 panes",
      customTitle: "",
      activePaneId: "pane-2",
      panes: [
        { id: "pane-1", title: "left" },
        { id: "pane-2", title: "right" },
      ],
      tree: { kind: "leaf", paneId: "pane-2" },
    };

    refreshTerminalTabTitleModel(tab);

    assert.equal(tab.title, "right | 2 panes");
  });
});
