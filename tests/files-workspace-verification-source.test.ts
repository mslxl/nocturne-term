/*
 * Test content:
 *
 * Feature:
 * Verifies Files ToolTab source wiring for SSH Workspace verification recovery.
 *
 * Operation:
 * Reads the Files ToolTab and main Workspace page source without launching a
 * real Tauri WebView, then checks for the shared verification-submitted event,
 * pending-error detection, and forced Files reload after a Workspace
 * verification response is submitted.
 *
 * Expected:
 * Files renders Workspace SSH verification as a waiting state instead of a
 * final toolbar failure, listens for the verification-submitted event, retries
 * the current directory with `force: true`, and the Workspace page dispatches
 * that event after credential or host-key verification is submitted.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Files Workspace verification source", () => {
  it("retries Files loading after Workspace SSH verification is submitted", () => {
    const files = readFileSync(resolve("src/lib/files/FilesToolTab.svelte"), "utf8");
    const page = readFileSync(resolve("src/routes/+page.svelte"), "utf8");

    assert.match(files, /FILES_WORKSPACE_SSH_VERIFICATION_SUBMITTED_EVENT/);
    assert.match(files, /isFilesWorkspaceVerificationPendingError\(error\)/);
    assert.match(files, /Waiting for Workspace verification\.\.\./);
    assert.match(files, /window\.addEventListener\(FILES_WORKSPACE_SSH_VERIFICATION_SUBMITTED_EVENT/);
    assert.match(files, /force:\s*true/);
    assert.match(page, /notifyFilesWorkspaceVerificationSubmitted\(workspaceId\)/);
    assert.match(page, /notifyFilesWorkspaceVerificationSubmitted\(pending\.workspaceId\)/);
    assert.match(page, /window\.dispatchEvent\(new CustomEvent\(FILES_WORKSPACE_SSH_VERIFICATION_SUBMITTED_EVENT/);
  });
});

