/*
 * Feature: Terminal pane event routing in windows that may not own a backend
 * session runtime.
 * Operation: classify terminal pane ids against the set of pane ids currently
 * mounted in the WebView before dispatching delayed terminal events or mount
 * continuations.
 * Expected: events for unknown term-* pane ids are ignored as external or stale
 * events, while events for known pane ids are handled locally.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { routeTerminalPaneEvent, shouldHandleTerminalPaneEvent } from "../src/lib/terminal/event-routing";

describe("terminal pane event routing", () => {
  it("ignores terminal events for pane ids that are not present in the current WebView runtime", () => {
    const localPaneIds = ["term-2", "term-3"];

    assert.equal(shouldHandleTerminalPaneEvent("term-1", localPaneIds), false);
    assert.equal(shouldHandleTerminalPaneEvent("term-2", localPaneIds), true);
  });

  it("does not dispatch unknown pane ids into handlers that require a local pane", () => {
    const handledPaneIds: string[] = [];
    const localPaneIds = ["term-2"];

    const ignored = routeTerminalPaneEvent("term-1", localPaneIds, () => {
      throw new Error("unknown panes must not reach local pane handlers");
    });
    const handled = routeTerminalPaneEvent("term-2", localPaneIds, (paneId) => {
      handledPaneIds.push(paneId);
    });

    assert.equal(ignored, false);
    assert.equal(handled, true);
    assert.deepEqual(handledPaneIds, ["term-2"]);
  });
});
