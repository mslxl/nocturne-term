/*
 * Test content:
 *
 * Feature:
 * Verifies managed ripgrep helper packaging for Files search.
 *
 * Operation:
 * Reads package scripts, the Tauri config, the release workflow, and the
 * ripgrep helper preparation script without executing platform-specific
 * binaries.
 *
 * Expected:
 * The repository prepares every target-specific `rg` helper binary in one
 * release job, bundles them as flat files under `src-tauri/resources/ripgrep`,
 * uses that artifact before Tauri packaging, does not upload `rg` to the
 * Nocturne GitHub Release, and never relies on `latest` or a
 * host-platform-only helper.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Files ripgrep helper packaging", () => {
  it("defines helper preparation scripts and bundle resources", () => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    const tauriConfig = JSON.parse(readFileSync(resolve("src-tauri/tauri.conf.json"), "utf8"));
    const releaseWorkflow = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
    const validateScript = readFileSync(resolve("scripts/validate-helper-resources.mjs"), "utf8");

    assert.equal(packageJson.scripts["prepare:ripgrep-helpers"], "node scripts/prepare-ripgrep-helpers.mjs");
    assert.ok(existsSync(resolve("scripts/prepare-ripgrep-helpers.mjs")));
    assert.deepEqual(tauriConfig.bundle.resources, [
      "resources/nocturne-terminal-agent/**/*",
      "resources/nocturne-resource-monitor-agent/**/*",
      "resources/ripgrep/**/*",
    ]);
    assert.match(releaseWorkflow, /prepare_ripgrep_helpers:/);
    assert.match(releaseWorkflow, /pnpm prepare:ripgrep-helpers/);
    assert.match(releaseWorkflow, /name: ripgrep-helpers/);
    assert.match(releaseWorkflow, /Download ripgrep helpers/);
    assert.match(releaseWorkflow, /pattern: ripgrep-helpers/);
    assert.doesNotMatch(releaseWorkflow, /Upload ripgrep helper release asset/);
    assert.doesNotMatch(releaseWorkflow, /rg-\$\{RIPGREP_VERSION\}-\$\{RELEASE_TAG\}-/);
    assert.doesNotMatch(releaseWorkflow, /releases\/latest|download\/latest/);
    assert.match(validateScript, /"src-tauri"[\s\S]*"resources"[\s\S]*"ripgrep"/);
    assert.match(validateScript, /`rg-\$\{RIPGREP_VERSION\}-linux-x86_64`/);
    assert.match(validateScript, /`rg-\$\{RIPGREP_VERSION\}-windows-x86_64\.exe`/);
  });

  it("keeps the ripgrep target matrix aligned with runtime helper selection", () => {
    const script = readFileSync(resolve("scripts/prepare-ripgrep-helpers.mjs"), "utf8");
    const rustFiles = readFileSync(resolve("src-tauri/src/files.rs"), "utf8");

    const expectedTargets = [
      { os: "linux", arch: "x86_64", binary: "rg" },
      { os: "linux", arch: "aarch64", binary: "rg" },
      { os: "linux", arch: "armv7", binary: "rg" },
      { os: "macos", arch: "x86_64", binary: "rg" },
      { os: "macos", arch: "aarch64", binary: "rg" },
      { os: "windows", arch: "x86_64", binary: "rg.exe" },
      { os: "windows", arch: "i686", binary: "rg.exe" },
    ];

    for (const target of expectedTargets) {
      assert.match(script, new RegExp(`os: "${target.os}"[\\s\\S]*arch: "${target.arch}"[\\s\\S]*binary: "${escapeRegex(target.binary)}"`));
      assert.match(rustFiles, new RegExp(`RemoteResourceTargetArch::${rustArchVariant(target.arch)}\\s*=>\\s*"${target.arch}"`));
    }

    assert.match(script, /RIPGREP_VERSION/);
    assert.match(script, /src-tauri", "resources", "ripgrep"/);
    assert.match(script, /helperFileName\(target\)/);
    assert.doesNotMatch(script, /outputRoot, target\.os, target\.arch/);
    assert.match(script, /rg-\$\{RIPGREP_VERSION\}-\$\{target\.os\}-\$\{target\.arch\}/);
    assert.match(script, /response\.statusCode >= 300 && response\.statusCode < 400/);
    assert.match(script, /location/);
    assert.match(releaseWorkflowSource(), /prepare_ripgrep_helpers:[\s\S]*runs-on: ubuntu-22\.04/);
    assert.doesNotMatch(releaseWorkflowSource(), /prepare_ripgrep_helpers:[\s\S]*matrix:[\s\S]*artifact-name/);
    assert.doesNotMatch(releaseWorkflowSource(), /NOCTURNE_RIPGREP_TARGETS/);
    assert.doesNotMatch(releaseWorkflowSource(), /for source_file in src-tauri\/resources\/ripgrep\/rg-\$\{RIPGREP_VERSION\}-\*/);
    assert.doesNotMatch(releaseWorkflowSource(), /source_file="\$\{RIPGREP_SOURCE_FILE\}"[\s\S]*source_file="\$\{RIPGREP_SOURCE_FILE\}\.exe"/);
    assert.match(rustFiles, /https:\/\/github\.com\/BurntSushi\/ripgrep\/releases\/download\/\{\}/);
    assert.doesNotMatch(rustFiles, /github\.com\/\{\}\/releases\/download\/\{\}\/\{\}/);
    assert.match(rustFiles, /search_sftp_files_with_managed_rg/);
    assert.match(rustFiles, /load_ripgrep_helper_bytes_from_app/);
    assert.match(rustFiles, /deploy_ripgrep_helper_if_needed/);
    assert.match(rustFiles, /Nocturne ripgrep helper/);
  });
});

function rustArchVariant(arch: string): string {
  return new Map([
    ["x86_64", "X86_64"],
    ["aarch64", "Aarch64"],
    ["armv7", "Armv7"],
    ["i686", "I686"],
  ]).get(arch) ?? arch;
}

function releaseWorkflowSource(): string {
  return readFileSync(resolve(".github/workflows/release.yml"), "utf8");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
