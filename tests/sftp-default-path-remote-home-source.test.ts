/*
 * Test content:
 *
 * Feature:
 * Verifies that the SFTP Files provider chooses the remote user's home
 * directory for the default path instead of the local desktop user's home.
 *
 * Operation:
 * Reads the Rust Files provider source and inspects the SFTP default-path
 * implementation. The SFTP resolver must accept the SSH session, obtain the
 * remote home path through a remote command helper, and expand "~" or "~/..."
 * host configuration values against that remote home. It also checks that the
 * SFTP browse path resolver rejects local desktop path shapes before reading a
 * remote directory.
 *
 * Expected:
 * SSH Files browsing starts in the remote Linux home directory when the Host
 * has no files.default_path, and host defaults such as "~/Projects" resolve on
 * the remote host. A stale local desktop path such as a Windows home directory
 * is not sent to SFTP as a remote path. The SFTP default-path resolver must not
 * call the local home-directory helper or rely on the local Windows home path.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const filesSourceUrl = new URL("../src-tauri/src/files.rs", import.meta.url);

describe("SFTP default path remote home", () => {
  it("resolves empty and tilde SFTP defaults from the remote SSH session", async () => {
    const source = await readFile(filesSourceUrl, "utf8");

    const sftpDefaultPathBody = source.match(/fn\s+sftp_default_path[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(sftpDefaultPathBody, /session:\s*&Session/, "sftp_default_path must receive the SSH session so it can query remote home.");
    assert.match(sftpDefaultPathBody, /sftp:\s*&ssh2::Sftp/, "sftp_default_path must still receive the SFTP handle for fallback resolution.");
    assert.match(
      source,
      /fn\s+remote_home_path\s*\(\s*session:\s*&Session,\s*sftp:\s*&ssh2::Sftp\s*\)/,
      "SFTP default path resolution must have a remote home helper.",
    );
    const remoteHomeBody = source.match(/fn\s+remote_home_path[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(remoteHomeBody, /run_remote_command\(session,/, "remote_home_path must run a remote command.");
    assert.match(remoteHomeBody, /\$HOME/, "remote_home_path must ask the remote shell for $HOME.");
    assert.match(source, /trimmed\s*==\s*"~"/, "SFTP defaults must expand a literal tilde.");
    assert.match(source, /strip_prefix\("~\/"\)/, "SFTP defaults must expand ~/ relative paths.");
    assert.match(
      source,
      /fn\s+sftp_current_path\s*\(/,
      "SFTP listing must resolve the requested browse path separately from local path handling.",
    );
    assert.match(
      source,
      /fn\s+looks_like_local_desktop_path\s*\(/,
      "SFTP path resolution must detect stale local desktop paths.",
    );
    assert.match(
      source,
      /looks_like_local_desktop_path\(trimmed\)/,
      "SFTP path resolution must ignore stale local desktop paths before browsing.",
    );
    assert.match(
      source,
      /let\s+current_path\s*=\s*sftp_current_path\(/,
      "SFTP listing must use the SFTP-specific current path resolver.",
    );

    assert.doesNotMatch(
      sftpDefaultPathBody,
      /expand_local_home|dirs::home_dir/,
      "SFTP default path resolution must never use the local user's home directory.",
    );
  });
});
