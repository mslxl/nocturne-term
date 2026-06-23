/*
 * Test content:
 *
 * Feature:
 * Verifies that the bundled Terminal font stack uses Maple Mono first and a
 * Nerd Font glyph fallback second, and that the Settings schema exposes the
 * same default font family.
 *
 * Operation:
 * Reads the frontend Settings schema, the root Svelte layout, the app theme
 * stylesheet, the vendored Nerd Fonts asset, and Rust terminal settings
 * source. It compares the terminal.font_family default and fallback values,
 * then checks that the app imports Maple Mono from npm and declares the
 * official ryanoasis/nerd-fonts Symbols-only fallback from local static
 * assets.
 *
 * Expected:
 * Empty configuration resolves terminal.font_family to the bundled Maple Mono
 * first, the bundled Symbols Nerd Font Mono second, and system monospace
 * fallbacks after that. The Svelte app root imports Maple Mono, the app theme
 * declares the local Nerd Fonts face, the vendored font file is present, and
 * the Rust default uses the same font stack.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { settingsSchema } from "../src/lib/settings/schema";
import { DEFAULT_TERMINAL_FONT_FAMILY } from "../src/lib/terminal/fonts";

describe("Terminal font settings source", () => {
  it("uses Maple Mono first and Nerd Font glyph fallback second", async () => {
    const root = { values: {} };
    const setting = settingsSchema.find((item) => item.key === "terminal.font_family");
    assert.ok(setting, "terminal.font_family setting must be registered");

    assert.equal(setting.defaultValue, DEFAULT_TERMINAL_FONT_FAMILY);
    assert.equal(setting.get(root), DEFAULT_TERMINAL_FONT_FAMILY);
    assert.match(DEFAULT_TERMINAL_FONT_FAMILY, /^"Maple Mono", "Symbols Nerd Font Mono"/);
    assert.match(DEFAULT_TERMINAL_FONT_FAMILY, /monospace$/);

    const layoutSource = await readFile(new URL("../src/routes/+layout.svelte", import.meta.url), "utf8");
    assert.match(layoutSource, /@fontsource\/maple-mono/);
    assert.doesNotMatch(layoutSource, /@azurity\/pure-nerd-font/);

    const pageSource = await readFile(new URL("../src/routes/+page.svelte", import.meta.url), "utf8");
    assert.match(pageSource, /DEFAULT_TERMINAL_FONT_FAMILY/);
    assert.doesNotMatch(pageSource, /font_family:\s*"ui-monospace,\s*SFMono-Regular/);

    const themeSource = await readFile(new URL("../src/lib/styles/app-theme.css", import.meta.url), "utf8");
    assert.match(themeSource, /font-family:\s*"Symbols Nerd Font Mono"/);
    assert.match(themeSource, /\/fonts\/nerd-fonts\/SymbolsNerdFontMono-Regular\.ttf/);

    const nerdFont = await readFile(new URL("../static/fonts/nerd-fonts/SymbolsNerdFontMono-Regular.ttf", import.meta.url));
    assert.ok(nerdFont.byteLength > 2_000_000, "official Nerd Fonts Symbols-only TTF asset must be vendored");

    const terminalSource = await readFile(new URL("../src-tauri/src/terminal.rs", import.meta.url), "utf8");
    assert.match(terminalSource, /Maple Mono/);
    assert.match(terminalSource, /Symbols Nerd Font Mono/);
  });
});
