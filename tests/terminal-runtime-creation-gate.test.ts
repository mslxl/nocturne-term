/*
 * Test content:
 *
 * Feature:
 * Verifies that Terminal runtime creation for a Workspace ToolTab is
 * serialized by ToolTab id.
 *
 * Operation:
 * Starts two concurrent creation requests for the same Terminal ToolTab while
 * no runtime exists yet, releases the underlying async creation operation, and
 * waits for both callers to complete.
 *
 * Expected:
 * Only one backend runtime creation operation runs for that ToolTab id, and
 * both callers resolve from the same in-flight creation instead of creating a
 * duplicate backend terminal session such as term-1 plus term-2.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { TerminalRuntimeCreationGate } from "../src/lib/terminal/runtime-creation";

describe("terminal runtime creation gate", () => {
  it("coalesces concurrent creation for one ToolTab id", async () => {
    const gate = new TerminalRuntimeCreationGate();
    let hasRuntime = false;
    let createCalls = 0;
    const release = deferred<void>();

    const first = gate.ensure("tool-terminal-a", () => hasRuntime, async () => {
      createCalls += 1;
      await release.promise;
      hasRuntime = true;
    });
    const second = gate.ensure("tool-terminal-a", () => hasRuntime, async () => {
      createCalls += 1;
      await release.promise;
      hasRuntime = true;
    });

    assert.equal(createCalls, 1);
    release.resolve();
    await Promise.all([first, second]);
    assert.equal(createCalls, 1);
    assert.equal(hasRuntime, true);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
