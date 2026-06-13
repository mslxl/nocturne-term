#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RIPGREP_VERSION = process.env.RIPGREP_VERSION ?? "14.1.1";

const resourceMonitorAgentRoot = resolve(
  repoRoot,
  "src-tauri",
  "resources",
  "nocturne-resource-monitor-agent",
);
const ripgrepRoot = resolve(repoRoot, "src-tauri", "resources", "ripgrep");

const requiredFiles = [
  ...[
    "linux/x86_64/nocturne-resource-monitor-agent",
    "linux/aarch64/nocturne-resource-monitor-agent",
    "linux/armv7/nocturne-resource-monitor-agent",
    "macos/x86_64/nocturne-resource-monitor-agent",
    "macos/aarch64/nocturne-resource-monitor-agent",
    "windows/x86_64/nocturne-resource-monitor-agent.exe",
    "windows/i686/nocturne-resource-monitor-agent.exe",
  ].map((file) => resolve(resourceMonitorAgentRoot, file)),
  ...[
    `rg-${RIPGREP_VERSION}-linux-x86_64`,
    `rg-${RIPGREP_VERSION}-linux-aarch64`,
    `rg-${RIPGREP_VERSION}-linux-armv7`,
    `rg-${RIPGREP_VERSION}-macos-x86_64`,
    `rg-${RIPGREP_VERSION}-macos-aarch64`,
    `rg-${RIPGREP_VERSION}-windows-x86_64.exe`,
    `rg-${RIPGREP_VERSION}-windows-i686.exe`,
  ].map((file) => resolve(ripgrepRoot, file)),
];

const missing = [];
const empty = [];

for (const file of requiredFiles) {
  if (!existsSync(file)) {
    missing.push(file);
    continue;
  }
  if (!statSync(file).isFile() || statSync(file).size === 0) {
    empty.push(file);
  }
}

if (missing.length > 0 || empty.length > 0) {
  if (missing.length > 0) {
    console.error("Missing bundled helper resources:");
    for (const file of missing) {
      console.error(`- ${file}`);
    }
  }
  if (empty.length > 0) {
    console.error("Empty bundled helper resources:");
    for (const file of empty) {
      console.error(`- ${file}`);
    }
  }
  process.exit(1);
}

console.log(`Validated ${requiredFiles.length} bundled helper resources.`);
