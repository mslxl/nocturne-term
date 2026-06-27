import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { isTerminalSessionInactiveMessage } from "./errors";

describe("terminal session error classification", () => {
  it("recognizes stale backend session messages", () => {
    assert.equal(isTerminalSessionInactiveMessage("Missing: terminal session term-4 not found"), true);
    assert.equal(
      isTerminalSessionInactiveMessage("Terminal: terminal session term-8 is no longer active; press any key to reconnect"),
      true,
    );
  });

  it("does not treat unrelated not-found messages as terminal lifecycle errors", () => {
    assert.equal(isTerminalSessionInactiveMessage("profile default not found"), false);
    assert.equal(isTerminalSessionInactiveMessage("terminal view term-4 not found"), false);
  });
});
