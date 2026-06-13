/*
 * Test content:
 *
 * Feature:
 * Verifies Resource Monitor agent build and packaging configuration.
 *
 * Operation:
 * Reads package scripts, the Tauri config, the release workflow, the
 * Resource Monitor agent build script, and the helper crate manifest without
 * executing platform-specific binaries.
 *
 * Expected:
 * The repository defines a standalone `crates/nocturne-resource-monitor-agent` Cargo
 * package and a script for building target-specific helper binaries from that
 * manifest, the old src-tauri bin entry point is absent, the Tauri bundle
 * includes the helper resource directory, and release builds run the helper
 * build step before the Tauri bundle so remote Resource Monitor helpers are
 * packaged with the app. Every runtime-supported remote OS/architecture pair
 * has the same target in the local build script and release workflow, so helper
 * upload planning cannot select a resource that was never built or bundled.
 * Linux ARM helpers use cross so GitHub runners can produce musl binaries for
 * targets other than the runner CPU architecture, Windows helpers request
 * static CRT linking to avoid shipping extra runtime files to remote Hosts,
 * and release assets are uploaded with deterministic same-tag names so a
 * missing bundled helper can only be downloaded from the current app release.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Resource Monitor agent packaging", () => {
  it("defines helper build scripts and bundle resources", () => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    const tauriConfig = JSON.parse(readFileSync(resolve("src-tauri/tauri.conf.json"), "utf8"));
    const releaseWorkflow = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
    const buildScript = readFileSync(resolve("scripts/build-resource-monitor-agents.mjs"), "utf8");
    const validateScript = readFileSync(resolve("scripts/validate-helper-resources.mjs"), "utf8");
    const buildRs = readFileSync(resolve("src-tauri/build.rs"), "utf8");
    const helperManifest = readFileSync(resolve("crates/nocturne-resource-monitor-agent/Cargo.toml"), "utf8");

    assert.equal(packageJson.scripts["build:resource-monitor-agents"], "node scripts/build-resource-monitor-agents.mjs");
    assert.ok(tauriConfig.bundle.resources.includes("resources/nocturne-resource-monitor-agent/**/*"));
    assert.equal(existsSync(resolve("src-tauri/src/bin/nocturne-resource-monitor-agent.rs")), false);
    assert.match(helperManifest, /name\s*=\s*"nocturne-resource-monitor-agent"/);
    assert.doesNotMatch(helperManifest, /tauri/);
    assert.doesNotMatch(helperManifest, /nocturne_lib|nocturne\s*=/);
    assert.match(buildScript, /resolve\(repoRoot, "crates", "nocturne-resource-monitor-agent", "Cargo\.toml"\)/);
    assert.doesNotMatch(buildScript, /resolve\(srcTauri, "Cargo\.toml"\)/);
    assert.match(buildScript, /resolve\(helperCrate, "target", target\.triple, "release", target\.binary\)/);
    assert.match(releaseWorkflow, /pnpm build:resource-monitor-agents/);
    assert.match(releaseWorkflow, /build_resource_monitor_agents:/);
    assert.match(releaseWorkflow, /actions\/upload-artifact@v4/);
    assert.match(releaseWorkflow, /Upload Resource Monitor agent release asset/);
    assert.match(releaseWorkflow, /gh release upload "\$RELEASE_TAG"/);
    assert.match(releaseWorkflow, /nocturne-resource-monitor-agent-\$\{\{ needs\.prepare\.outputs\.tag \}\}-\$\{\{ matrix\.artifact-path \}\}/);
    assert.match(releaseWorkflow, /actions\/download-artifact@v4/);
    assert.match(releaseWorkflow, /Validate bundled helper resources/);
    assert.match(releaseWorkflow, /pnpm validate:helper-resources/);
    assert.match(releaseWorkflow, /NOCTURNE_RESOURCE_MONITOR_AGENT_TARGETS/);
    assert.match(buildScript, /nocturne-resource-monitor-agent/);
    assert.match(buildScript, /NOCTURNE_RESOURCE_MONITOR_AGENT_TARGETS/);
    assert.match(buildScript, /Unknown Resource Monitor agent targets/);
    assert.match(buildScript, /NOCTURNE_RESOURCE_MONITOR_AGENT_BUILDER/);
    assert.match(buildScript, /target-feature=\+crt-static/);
    assert.match(buildScript, /writeFileSync\(resolve\(outputRoot, "\.gitkeep"\)/);
    assert.match(buildRs, /NOCTURNE_BUILD_COMMIT/);
    assert.match(buildRs, /NOCTURNE_BUILD_TAG/);
    assert.match(buildRs, /rev-parse", "HEAD"/);
    assert.match(buildRs, /describe", "--tags", "--exact-match", "HEAD"/);
    assert.match(buildScript, /x86_64-unknown-linux-musl/);
    assert.match(buildScript, /aarch64-apple-darwin/);
    assert.match(buildScript, /x86_64-pc-windows-msvc/);
    assert.match(validateScript, /"src-tauri"[\s\S]*"resources"[\s\S]*"nocturne-resource-monitor-agent"/);
    assert.match(validateScript, /linux\/x86_64\/nocturne-resource-monitor-agent/);
    assert.match(validateScript, /windows\/x86_64\/nocturne-resource-monitor-agent\.exe/);
  });

  it("keeps build, CI, and runtime helper target matrices aligned", () => {
    const releaseWorkflow = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
    const buildScript = readFileSync(resolve("scripts/build-resource-monitor-agents.mjs"), "utf8");
    const rustTypes = readFileSync(resolve("src-tauri/src/types.rs"), "utf8");
    const rustResources = readFileSync(resolve("src-tauri/src/resources.rs"), "utf8");

    const expectedTargets = [
      {
        os: "linux",
        arch: "x86_64",
        triple: "x86_64-unknown-linux-musl",
        binary: "nocturne-resource-monitor-agent",
      },
      {
        os: "linux",
        arch: "aarch64",
        triple: "aarch64-unknown-linux-musl",
        binary: "nocturne-resource-monitor-agent",
      },
      {
        os: "linux",
        arch: "armv7",
        triple: "armv7-unknown-linux-musleabihf",
        binary: "nocturne-resource-monitor-agent",
      },
      {
        os: "macos",
        arch: "x86_64",
        triple: "x86_64-apple-darwin",
        binary: "nocturne-resource-monitor-agent",
      },
      {
        os: "macos",
        arch: "aarch64",
        triple: "aarch64-apple-darwin",
        binary: "nocturne-resource-monitor-agent",
      },
      {
        os: "windows",
        arch: "x86_64",
        triple: "x86_64-pc-windows-msvc",
        binary: "nocturne-resource-monitor-agent.exe",
      },
      {
        os: "windows",
        arch: "i686",
        triple: "i686-pc-windows-msvc",
        binary: "nocturne-resource-monitor-agent.exe",
      },
    ];

    for (const target of expectedTargets) {
      assert.match(buildScript, new RegExp(`os: "${target.os}"[\\s\\S]*arch: "${target.arch}"[\\s\\S]*triple: "${escapeRegex(target.triple)}"[\\s\\S]*binary: "${escapeRegex(target.binary)}"`));
      assert.match(releaseWorkflow, new RegExp(`rust-target: ${escapeRegex(target.triple)}[\\s\\S]*artifact-path: ${target.os}/${target.arch}`));
    }

    assert.match(releaseWorkflow, /Install cross for Linux ARM agents/);
    assert.match(releaseWorkflow, /cargo install cross --git https:\/\/github\.com\/cross-rs\/cross/);
    assert.match(releaseWorkflow, /NOCTURNE_RESOURCE_MONITOR_AGENT_BUILDER: \$\{\{ matrix\.builder \}\}/);
    assert.match(releaseWorkflow, /binary-name: nocturne-resource-monitor-agent\.exe/);
    assert.match(releaseWorkflow, /AGENT_BINARY: \$\{\{ matrix\.binary-name \}\}/);
    assert.match(releaseWorkflow, /source_file="\$\{AGENT_SOURCE\}\/\$\{AGENT_BINARY\}"/);
    assert.doesNotMatch(releaseWorkflow, /gh release upload "\$RELEASE_TAG" "\$\{source_file\}#\$\{asset_name\}"/);
    assert.match(releaseWorkflow, /gh release upload "\$RELEASE_TAG" "\$upload_file" --clobber/);
    assert.doesNotMatch(releaseWorkflow, /source_file="\$\{AGENT_SOURCE\}\/nocturne-resource-monitor-agent"[\s\S]*source_file="\$\{AGENT_SOURCE\}\/nocturne-resource-monitor-agent\.exe"/);
    assert.match(releaseWorkflow, /rust-target: aarch64-unknown-linux-musl[\s\S]*artifact-path: linux\/aarch64[\s\S]*builder: cross/);
    assert.match(releaseWorkflow, /rust-target: armv7-unknown-linux-musleabihf[\s\S]*artifact-path: linux\/armv7[\s\S]*builder: cross/);
    assert.match(releaseWorkflow, /rust-target: x86_64-pc-windows-msvc[\s\S]*artifact-path: windows\/x86_64[\s\S]*binary-name: nocturne-resource-monitor-agent\.exe[\s\S]*builder: cargo/);
    assert.match(rustTypes, /pub enum RemoteResourceTargetArch[\s\S]*Armv7/);
    assert.match(rustResources, /RemoteResourceTargetArch::Armv7\s*=>\s*"armv7"/);
  });

  it("keeps resource-monitor-agent GPU collection inside the helper process without shelling out to vendor commands", () => {
    const helperSource = readFileSync(resolve("crates/nocturne-resource-monitor-agent/src/lib.rs"), "utf8");

    assert.doesNotMatch(helperSource, /std::process::Command/);
    assert.doesNotMatch(helperSource, /nvidia-smi/);
    assert.match(helperSource, /Path::new\("\/sys"\)/);
    assert.match(helperSource, /join\("class"\)\.join\("drm"\)/);
    assert.match(helperSource, /mem_info_vram_used/);
    assert.match(helperSource, /PdhAddEnglishCounterW/);
    assert.match(helperSource, /PdhGetFormattedCounterArrayW/);
    assert.match(helperSource, /CreateDXGIFactory1/);
  });
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
