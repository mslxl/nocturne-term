#!/usr/bin/env node
import { createWriteStream, mkdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { get } from "node:https";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const RIPGREP_VERSION = process.env.RIPGREP_VERSION ?? "14.1.1";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(repoRoot, "src-tauri", "resources", "ripgrep");
const requestedTargets = new Set(
  (process.env.NOCTURNE_RIPGREP_TARGETS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

const targets = [
  { os: "linux", arch: "x86_64", asset: `ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl.tar.gz`, binary: "rg" },
  { os: "linux", arch: "aarch64", asset: `ripgrep-${RIPGREP_VERSION}-aarch64-unknown-linux-gnu.tar.gz`, binary: "rg" },
  { os: "linux", arch: "armv7", asset: `ripgrep-${RIPGREP_VERSION}-armv7-unknown-linux-musleabihf.tar.gz`, binary: "rg" },
  { os: "macos", arch: "x86_64", asset: `ripgrep-${RIPGREP_VERSION}-x86_64-apple-darwin.tar.gz`, binary: "rg" },
  { os: "macos", arch: "aarch64", asset: `ripgrep-${RIPGREP_VERSION}-aarch64-apple-darwin.tar.gz`, binary: "rg" },
  { os: "windows", arch: "x86_64", asset: `ripgrep-${RIPGREP_VERSION}-x86_64-pc-windows-msvc.zip`, binary: "rg.exe" },
  { os: "windows", arch: "i686", asset: `ripgrep-${RIPGREP_VERSION}-i686-pc-windows-msvc.zip`, binary: "rg.exe" },
];

const knownTargetKeys = new Set(targets.map((target) => `${target.os}/${target.arch}`));
const unknownRequestedTargets = [...requestedTargets].filter((target) => !knownTargetKeys.has(target));
if (unknownRequestedTargets.length > 0) {
  throw new Error(`Unknown ripgrep helper targets: ${unknownRequestedTargets.join(", ")}`);
}

const selectedTargets = requestedTargets.size > 0
  ? targets.filter((target) => requestedTargets.has(`${target.os}/${target.arch}`))
  : targets;
if (selectedTargets.length === 0) {
  throw new Error(`No ripgrep helper targets matched: ${[...requestedTargets].join(", ")}`);
}

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });
writeFileSync(resolve(outputRoot, ".gitkeep"), "");

for (const target of selectedTargets) {
  const workDir = await mkdtemp(resolve(tmpdir(), "rg-"));
  try {
    const archivePath = resolve(workDir, target.asset);
    await download(ripgrepReleaseUrl(target.asset), archivePath);
    const extractDir = resolve(workDir, "extract");
    mkdirSync(extractDir, { recursive: true });
    if (target.asset.endsWith(".zip")) {
      extractZip(archivePath, extractDir);
    } else {
      extractTarGz(archivePath, extractDir);
    }
    const binaryPath = await findExtractedBinary(extractDir, target.binary);
    copyFileSync(binaryPath, resolve(outputRoot, helperFileName(target)));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function ripgrepReleaseUrl(asset) {
  return `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${asset}`;
}

function helperFileName(target) {
  return `rg-${RIPGREP_VERSION}-${target.os}-${target.arch}${target.binary.endsWith(".exe") ? ".exe" : ""}`;
}

function download(url, destination, redirects = 0) {
  return new Promise((resolvePromise, reject) => {
    const request = get(url, { headers: { "User-Agent": "Nocturne ripgrep helper packager" } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        const { location } = response.headers;
        response.resume();
        if (!location) {
          reject(new Error(`Download redirect did not include a location: ${url}`));
          return;
        }
        if (redirects >= 5) {
          reject(new Error(`Download redirected too many times: ${url}`));
          return;
        }
        const redirectedUrl = new URL(location, url).toString();
        download(redirectedUrl, destination, redirects + 1).then(resolvePromise, reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed with HTTP ${response.statusCode}: ${url}`));
        response.resume();
        return;
      }
      const file = createWriteStream(destination);
      response.pipe(file);
      file.on("finish", () => file.close(resolvePromise));
      file.on("error", reject);
    });
    request.on("error", reject);
  });
}

function extractTarGz(archivePath, destination) {
  run("tar", ["-xzf", archivePath, "-C", destination]);
}

function extractZip(archivePath, destination) {
  if (process.platform === "win32") {
    run("powershell", ["-NoProfile", "-Command", "Expand-Archive", "-LiteralPath", archivePath, "-DestinationPath", destination, "-Force"]);
    return;
  }
  run("unzip", ["-q", archivePath, "-d", destination]);
}

async function findExtractedBinary(root, binary) {
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(path);
      } else if (entry.isFile() && basename(path) === binary) {
        return path;
      }
    }
  }
  throw new Error(`Could not find ${binary} in extracted ripgrep archive`);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}
