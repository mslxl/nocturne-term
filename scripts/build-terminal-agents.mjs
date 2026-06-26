#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcTauri = resolve(repoRoot, "src-tauri");
const helperRoot = resolve(repoRoot, "tools", "nocturne-terminal-agent");
const outputRoot = resolve(srcTauri, "resources", "nocturne-terminal-agent");
const requestedTargets = new Set(
  (process.env.NOCTURNE_TERMINAL_AGENT_TARGETS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

const targets = [
  { os: "linux", arch: "x86_64", goos: "linux", goarch: "amd64", binary: "nocturne-terminal-agent" },
  { os: "linux", arch: "aarch64", goos: "linux", goarch: "arm64", binary: "nocturne-terminal-agent" },
  { os: "linux", arch: "armv7", goos: "linux", goarch: "arm", goarm: "7", binary: "nocturne-terminal-agent" },
  { os: "macos", arch: "x86_64", goos: "darwin", goarch: "amd64", binary: "nocturne-terminal-agent" },
  { os: "macos", arch: "aarch64", goos: "darwin", goarch: "arm64", binary: "nocturne-terminal-agent" },
  { os: "windows", arch: "x86_64", goos: "windows", goarch: "amd64", binary: "nocturne-terminal-agent.exe" },
  { os: "windows", arch: "i686", goos: "windows", goarch: "386", binary: "nocturne-terminal-agent.exe" },
];

const knownTargetNames = new Set(targets.map(targetName));
const unknownRequestedTargets = [...requestedTargets].filter((target) => !knownTargetNames.has(target));

if (unknownRequestedTargets.length > 0) {
  throw new Error(`Unknown Terminal agent targets: ${unknownRequestedTargets.join(", ")}`);
}

const selectedTargets = requestedTargets.size > 0
  ? targets.filter((target) => requestedTargets.has(targetName(target)))
  : targets;

if (selectedTargets.length === 0) {
  throw new Error(`No Terminal agent targets matched: ${[...requestedTargets].join(", ")}`);
}

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });
writeFileSync(resolve(outputRoot, ".gitkeep"), "");

for (const target of selectedTargets) {
  const outputDir = resolve(outputRoot, target.os, target.arch);
  const outputBinary = resolve(outputDir, target.binary);
  mkdirSync(outputDir, { recursive: true });
  run("go", [
    "build",
    "-trimpath",
    "-ldflags",
    "-s -w",
    "-o",
    outputBinary,
    "./cmd/nocturne-terminal-agent",
  ], targetEnv(target));
}

function targetName(target) {
  return `${target.os}/${target.arch}`;
}

function targetEnv(target) {
  const env = {
    ...process.env,
    // CGO stays off for every current target. If Windows ever needs a ConPTY
    // or PTY dependency that truly requires CGO, wire that exception through
    // CI and docs first instead of changing this default silently.
    CGO_ENABLED: "0",
    GOOS: target.goos,
    GOARCH: target.goarch,
  };
  if (target.goarm) {
    env.GOARM = target.goarm;
  }
  return env;
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: helperRoot,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}
