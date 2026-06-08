/*
 * Test content:
 *
 * Feature:
 * Verifies the Workspace-owned SSH verification flow for Terminal, Files/SFTP,
 * and Transfer SFTP authentication scopes.
 *
 * Operation:
 * Reads the Rust and Svelte sources that wire SSH challenges. The test checks
 * that Files/SFTP connections keep an AppHandle so the backend can emit the
 * structured Workspace verification event, that the frontend listens for that
 * event and submits structured responses instead of parsing challenge strings,
 * that Terminal exposes a waiting-for-Workspace-verification state, and that
 * Transfer SFTP operations pass the task initiator Workspace scope into SFTP
 * auth instead of using operation-local scope strings.
 *
 * Expected:
 * SSH credential and host-key challenges are coordinated by the Workspace,
 * pending Terminal/Files operations remain pending instead of becoming final
 * provider errors, and transfers reuse only the initiating Workspace's
 * encrypted temporary credential.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pageSourceUrl = new URL("../src/routes/+page.svelte", import.meta.url);
const filesSourceUrl = new URL("../src-tauri/src/files.rs", import.meta.url);
const terminalTabsSourceUrl = new URL("../src/lib/terminal/tabs.ts", import.meta.url);
const terminalTypesSourceUrl = new URL("../src-tauri/src/types.rs", import.meta.url);
const transfersSourceUrl = new URL("../src-tauri/src/transfers.rs", import.meta.url);

describe("Workspace SSH verification coordinator wiring", () => {
  it("emits Files/SFTP challenges through the Workspace prompt event", async () => {
    const filesSource = await readFile(filesSourceUrl, "utf8");

    assert.match(
      filesSource,
      /SshWorkerInput\s*\{[\s\S]*?app:\s*Some\(app\.clone\(\)\)/,
      "SFTP worker input must carry AppHandle so credential and host-key challenges emit Workspace events.",
    );
  });

  it("uses structured Workspace verification events in the frontend without challenge string parsing", async () => {
    const pageSource = await readFile(pageSourceUrl, "utf8");

    assert.match(pageSource, /listen<WorkspaceSshVerificationRequiredEvent>\("workspace:\/\/ssh-verification-required"/);
    assert.match(pageSource, /commands\.submitWorkspaceSshVerification\(\{/);
    assert.doesNotMatch(pageSource, /sshChallengeFromConfigError/);
    assert.doesNotMatch(pageSource, /kind\s*!==\s*"SshWorkspaceChallenge"/);
  });

  it("exposes Terminal waiting state while backend verification is pending", async () => {
    const typesSource = await readFile(terminalTypesSourceUrl, "utf8");
    const tabsSource = await readFile(terminalTabsSourceUrl, "utf8");

    assert.match(typesSource, /WaitingForWorkspaceVerification/);
    assert.match(tabsSource, /waiting_for_workspace_verification/);
    assert.match(tabsSource, /Waiting for Workspace verification/);
  });

  it("passes the transfer initiator Workspace into all SFTP auth scopes", async () => {
    const source = await readFile(transfersSourceUrl, "utf8");

    assert.match(source, /struct TransferAuthScope<'a>\s*\{[\s\S]*?workspace_id:\s*&'a str/);
    assert.match(source, /let auth_scope = TransferAuthScope::from_task\(task\)\?/);
    assert.match(source, /transfer_sftp_auth_scope\(auth_scope\)/);
    assert.doesNotMatch(source, /transfer_sftp_auth_scope\("transfer-/);
    assert.doesNotMatch(source, /transfer_sftp_auth_scope\(task_id\)/);
  });
});
