/*
 * Feature: console-to-backend log forwarding for Tauri IPC fallback warnings.
 * Operation: evaluate a console.warn payload that matches Tauri's recoverable
 * custom-protocol IPC fallback message.
 * Expected: the warning remains a browser console warning but is not forwarded
 * to backend logs, while ordinary warnings continue to be eligible for backend
 * forwarding.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldForwardConsoleLog } from "../src/lib/tauri/logging";

const TAURI_IPC_FALLBACK_WARNING =
  "IPC custom protocol failed, Tauri will now use the postMessage interface instead";

describe("Tauri IPC fallback console warning forwarding", () => {
  it("does not forward the recoverable custom-protocol fallback warning to backend logs", () => {
    assert.equal(
      shouldForwardConsoleLog("warn", [TAURI_IPC_FALLBACK_WARNING, new TypeError("Failed to fetch")]),
      false,
    );
    assert.equal(shouldForwardConsoleLog("warn", ["terminal startup failed"]), true);
    assert.equal(shouldForwardConsoleLog("error", [TAURI_IPC_FALLBACK_WARNING]), true);
  });
});
