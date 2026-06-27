/*
 * Feature: Terminal session event routing for local session ids.
 * Operation: classify terminal session ids against the set of local session ids
 * before dispatching delayed terminal events.
 * Expected: unknown session ids are ignored, while known session ids are handled locally.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { routeTerminalSessionEvent, shouldHandleTerminalSessionEvent } from "../src/lib/terminal/event-routing";

describe("terminal session event routing", () => {
  it("ignores terminal events for session ids that are not present in the current WebView runtime", () => {
    const localSessionIds = ["term-2", "term-3"];

    assert.equal(shouldHandleTerminalSessionEvent("term-1", localSessionIds), false);
    assert.equal(shouldHandleTerminalSessionEvent("term-2", localSessionIds), true);
  });

  it("does not dispatch unknown session ids into handlers that require a local session", () => {
    const handledSessionIds: string[] = [];
    const localSessionIds = ["term-2"];

    const ignored = routeTerminalSessionEvent("term-1", localSessionIds, () => {
      throw new Error("unknown sessions must not reach local session handlers");
    });
    const handled = routeTerminalSessionEvent("term-2", localSessionIds, (sessionId) => {
      handledSessionIds.push(sessionId);
    });

    assert.equal(ignored, false);
    assert.equal(handled, true);
    assert.deepEqual(handledSessionIds, ["term-2"]);
  });
});
