#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localTauri = join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tauri.cmd" : "tauri",
);
const tauriBin = existsSync(localTauri) ? localTauri : "tauri";

const args = process.argv.slice(2);
const command = args[0];
const configByCommand = new Map([
  ["dev", "src-tauri/tauri.dev.conf.json"],
  ["build", "src-tauri/tauri.release.conf.json"],
]);

const configPath = configByCommand.get(command);
const finalArgs =
  configPath && !args.includes("--config")
    ? [command, "--config", configPath, ...args.slice(1)]
    : args;

const child = spawn(tauriBin, finalArgs, {
  cwd: repoRoot,
  env: process.env,
  shell: process.platform === "win32",
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
