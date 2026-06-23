/*
Feature: Files Markdown preview rendering.
Operation: Render Markdown preview content through the Files Markdown preview helper, including headings, emphasis, inline and block math, and raw HTML input.
Expected: Markdown files are detected by extension, Markdown syntax renders to HTML, KaTeX renders math expressions, and raw HTML is escaped so preview content cannot inject arbitrary markup.
*/
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { isMarkdownPreviewPath, renderMarkdownPreviewHtml } from "../src/lib/files/markdown-preview";

describe("Files Markdown preview rendering", () => {
  it("detects Markdown preview paths without matching unrelated text files", () => {
    assert.equal(isMarkdownPreviewPath("/repo/README.md"), true);
    assert.equal(isMarkdownPreviewPath("notes.markdown"), true);
    assert.equal(isMarkdownPreviewPath("/repo/markdown.txt"), false);
  });

  it("renders Markdown syntax and KaTeX math as preview HTML", () => {
    const html = renderMarkdownPreviewHtml("# Title\n\nThis is **bold** and $x^2$.\n\n$$\ny = x + 1\n$$");

    assert.match(html, /<h1[^>]*>Title<\/h1>/);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /class="[^"]*katex/);
    assert.match(html, /katex-display/);
  });

  it("escapes raw HTML while preserving code samples", () => {
    const html = renderMarkdownPreviewHtml("<script>alert(1)</script>\n\n```html\n<div>$not_math$</div>\n```");

    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /&lt;div&gt;\$not_math\$&lt;\/div&gt;/);
  });
});
