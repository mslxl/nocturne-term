/*
 * Test content:
 *
 * Feature:
 * Verifies the cross-platform integrated title bar configuration contract.
 *
 * Operation:
 * Reads the settings schema, frontend Workspace page, Rust config/app-shell
 * sources, and documentation. The test checks that the only supported setting
 * key is `ui.integrated_titlebar`, that the old macOS-only key is absent, and
 * that the frontend derives integrated titlebar state from desktop platform
 * support plus horizontal tab orientation rather than a macOS-only condition.
 *
 * Expected:
 * No source or documentation keeps `ui.macos_integrated_titlebar`; the new
 * `ui.integrated_titlebar` key is used consistently with a default of true.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoots = [
  new URL("../src/", import.meta.url),
  new URL("../src-tauri/", import.meta.url),
  new URL("../docs/", import.meta.url),
];
const checkedExtensions = new Set([".rs", ".ts", ".svelte", ".md", ".json", ".toml"]);

describe("integrated titlebar configuration source", () => {
  it("uses ui.integrated_titlebar as the only supported integrated titlebar key", async () => {
    const sources = await readRepositoryTextSources();
    const combined = sources.map((source) => source.text).join("\n");

    assert.doesNotMatch(combined, /macos_integrated_titlebar/);
    assert.doesNotMatch(combined, /macosIntegratedTitlebar/);
    assert.match(combined, /ui\.integrated_titlebar/);
    assert.match(combined, /effective_integrated_titlebar/);
  });

  it("exposes the setting on all desktop platforms and disables it for vertical tabs", async () => {
    const settingsSchema = await readFile(new URL("../src/lib/settings/schema.ts", import.meta.url), "utf8");
    const pageSource = await readFile(new URL("../src/routes/+page.svelte", import.meta.url), "utf8");

    assert.match(settingsSchema, /key:\s*"ui\.integrated_titlebar"/);
    assert.match(settingsSchema, /path:\s*\["ui",\s*"integrated_titlebar"\]/);
    assert.doesNotMatch(settingsSchema, /isMacPlatform\(\)\s*\?\s*\[/);
    assert.match(pageSource, /let integratedTitlebarSetting = \$state\(false\)/);
    assert.match(pageSource, /isDesktopPlatform\(\)\s*&&\s*integratedTitlebarSetting\s*&&\s*!isVertical/);
    assert.match(pageSource, /readValue\(snapshot\.effective_config\.root,\s*\["ui",\s*"integrated_titlebar"\]\)/);
  });
});

async function readRepositoryTextSources() {
  const files = (await Promise.all(sourceRoots.map(collectFiles))).flat();
  const relevant = files.filter((file) => {
    const normalized = file.replaceAll("\\", "/");
    if (normalized.includes("/node_modules/") || normalized.includes("/target/") || normalized.includes("/.git/")) {
      return false;
    }
    return checkedExtensions.has(extname(file));
  });
  return Promise.all(relevant.map(async (file) => ({ file, text: await readFile(file, "utf8") })));
}

async function collectFiles(directoryUrl: URL): Promise<string[]> {
  const entries = await readdir(directoryUrl, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "target" || entry.name === ".git") continue;
    const childUrl = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directoryUrl);
    if (entry.isDirectory()) files.push(...await collectFiles(childUrl));
    else files.push(fileURLToPath(childUrl));
  }
  return files;
}
