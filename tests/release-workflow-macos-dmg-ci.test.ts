/*
 * Test content:
 *
 * Feature:
 * Verifies that the GitHub Actions release workflow builds macOS DMG bundles
 * in explicit Tauri CI mode and preserves diagnostics for bundle_dmg.sh
 * failures.
 *
 * Operation:
 * Reads the release workflow from the repository, inspects the macOS matrix
 * Tauri build arguments, and checks for a failure-only macOS diagnostic step
 * that prints the generated DMG bundle script and directory listing.
 *
 * Expected:
 * Both macOS DMG build matrix entries pass --ci to the Tauri build command so
 * the DMG bundler avoids interactive prompts and CI-unsafe Finder scripting,
 * and the workflow contains a macOS failure diagnostic step for bundle_dmg.sh.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("release workflow macOS DMG CI mode", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");

  it("passes Tauri CI mode for each macOS DMG build", () => {
    const macosDmgEntries = [...workflow.matchAll(/label:\s*(macOS[^\n]+)[\s\S]*?args:\s*([^\n]+)/g)]
      .map((match) => ({ label: match[1].trim(), args: match[2].trim() }))
      .filter((entry) => entry.args.includes("--bundles dmg"));

    assert.deepEqual(
      macosDmgEntries.map((entry) => entry.label),
      ["macOS Apple Silicon", "macOS Intel"],
    );
    assert.deepEqual(
      macosDmgEntries.map((entry) => entry.args.includes("--ci")),
      [true, true],
    );
  });

  it("prints generated DMG script diagnostics when a macOS release build fails", () => {
    assert.match(workflow, /if:\s*failure\(\)\s*&&\s*runner\.os\s*==\s*'macOS'/);
    assert.match(workflow, /bundle_dmg\.sh/);
    assert.match(workflow, /target\/\$\{\{\s*matrix\.rust-target\s*\}\}\/release\/bundle\/dmg/);
  });
});
