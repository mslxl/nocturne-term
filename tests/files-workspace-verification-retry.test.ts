/*
 * Test content:
 *
 * Feature:
 * Verifies the Files ToolTab recovery contract when an SSH Workspace is still
 * completing credential or host-key verification.
 *
 * Operation:
 * Calls the Files Workspace verification helper with command errors that match
 * structured Workspace SSH challenge failures and with unrelated provider
 * failures.
 *
 * Expected:
 * Files treats Workspace SSH verification challenges as a pending, retryable
 * state so the toolbar does not remain failed after the Workspace handshake
 * completes, while unrelated provider errors remain final visible errors.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { isFilesWorkspaceVerificationPendingError } from "../src/lib/files/workspace-verification";

describe("Files Workspace verification retry", () => {
  it("detects Workspace SSH verification errors as retryable pending state", () => {
    assert.equal(
      isFilesWorkspaceVerificationPendingError(
        new Error("SshWorkspaceChallenge: SSH credential required for Build Host"),
      ),
      true,
    );
    assert.equal(
      isFilesWorkspaceVerificationPendingError("Terminal: Waiting for Workspace verification"),
      true,
    );
    assert.equal(
      isFilesWorkspaceVerificationPendingError(new Error("terminal error: connection refused")),
      false,
    );
  });
});

