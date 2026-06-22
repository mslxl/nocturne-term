/*
 * Test helper:
 *
 * Resolves a Tauri application binary for real WebView tests. If
 * TAURI_TEST_APPLICATION is provided, it validates that path. Otherwise it
 * builds the debug Tauri binary and returns the platform-specific executable.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export async function resolveTauriTestApplication(repoRoot) {
  const explicit = process.env.TAURI_TEST_APPLICATION;
  if (explicit) {
    return requiredPath("TAURI_TEST_APPLICATION", explicit);
  }

  const binaryPath = defaultDebugBinaryPath(repoRoot);
  await run(repoRoot, "pnpm", ["tauri", "build", "--debug", "--no-bundle"]);
  if (!existsSync(binaryPath)) {
    throw new Error(`Tauri debug build did not produce expected application binary: ${binaryPath}`);
  }
  return binaryPath;
}

export function optionalEnvPath(name) {
  const value = process.env[name];
  if (!value) return "";
  return requiredPath(name, value);
}

function defaultDebugBinaryPath(repoRoot) {
  const executable = process.platform === "win32" ? "nocturne.exe" : "nocturne";
  return resolve(repoRoot, "src-tauri", "target", "debug", executable);
}

function requiredPath(name, value) {
  const path = resolve(value);
  if (!existsSync(path)) {
    throw new Error(`${name} points to a missing file: ${path}`);
  }
  return path;
}

function run(cwd, command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      shell: process.platform === "win32",
      stdio: "inherit",
    });
    child.on("error", rejectRun);
    child.on("exit", (code) => {
      if (code === 0) {
        resolveRun();
      } else {
        rejectRun(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
      }
    });
  });
}
