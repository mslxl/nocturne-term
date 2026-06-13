#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcTauri = resolve(repoRoot, "src-tauri");
const helperManifest = resolve(repoRoot, "crates", "nocturne-resource-monitor-agent", "Cargo.toml");
const helperCrate = dirname(helperManifest);
const outputRoot = resolve(srcTauri, "resources", "nocturne-resource-monitor-agent");
const requestedTargets = new Set(
  (process.env.NOCTURNE_RESOURCE_MONITOR_AGENT_TARGETS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

const targets = [
  { os: "linux", arch: "x86_64", triple: "x86_64-unknown-linux-musl", binary: "nocturne-resource-monitor-agent" },
  { os: "linux", arch: "aarch64", triple: "aarch64-unknown-linux-musl", binary: "nocturne-resource-monitor-agent" },
  { os: "linux", arch: "armv7", triple: "armv7-unknown-linux-musleabihf", binary: "nocturne-resource-monitor-agent" },
  { os: "macos", arch: "x86_64", triple: "x86_64-apple-darwin", binary: "nocturne-resource-monitor-agent" },
  { os: "macos", arch: "aarch64", triple: "aarch64-apple-darwin", binary: "nocturne-resource-monitor-agent" },
  { os: "windows", arch: "x86_64", triple: "x86_64-pc-windows-msvc", binary: "nocturne-resource-monitor-agent.exe" },
  { os: "windows", arch: "i686", triple: "i686-pc-windows-msvc", binary: "nocturne-resource-monitor-agent.exe" },
];

const knownTargetTriples = new Set(targets.map((target) => target.triple));
const unknownRequestedTargets = [...requestedTargets].filter((target) => !knownTargetTriples.has(target));

if (unknownRequestedTargets.length > 0) {
  throw new Error(`Unknown Resource Monitor agent targets: ${unknownRequestedTargets.join(", ")}`);
}

const selectedTargets = requestedTargets.size > 0
  ? targets.filter((target) => requestedTargets.has(target.triple))
  : targets;

if (selectedTargets.length === 0) {
  throw new Error(`No Resource Monitor agent targets matched: ${[...requestedTargets].join(", ")}`);
}

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });
writeFileSync(resolve(outputRoot, ".gitkeep"), "");

for (const target of selectedTargets) {
  run(resourceAgentBuilder(), [
    "build",
    "--manifest-path",
    helperManifest,
    "--release",
    "--target",
    target.triple,
  ], targetEnv(target));
  const builtBinary = resolve(helperCrate, "target", target.triple, "release", target.binary);
  const outputDir = resolve(outputRoot, target.os, target.arch);
  mkdirSync(outputDir, { recursive: true });
  copyFileSync(builtBinary, resolve(outputDir, target.binary));
}

function resourceAgentBuilder() {
  const builder = process.env.NOCTURNE_RESOURCE_MONITOR_AGENT_BUILDER ?? "cargo";
  if (builder !== "cargo" && builder !== "cross") {
    throw new Error(`NOCTURNE_RESOURCE_MONITOR_AGENT_BUILDER must be cargo or cross, got ${builder}`);
  }
  return builder;
}

function targetEnv(target) {
  if (target.os !== "windows") {
    return process.env;
  }
  return {
    ...process.env,
    [`CARGO_TARGET_${target.triple.toUpperCase().replaceAll("-", "_")}_RUSTFLAGS`]: "-C target-feature=+crt-static",
  };
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}
