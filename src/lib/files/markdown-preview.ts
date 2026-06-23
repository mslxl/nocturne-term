import katex from "katex";
import { Marked } from "marked";

const markdownPreviewParser = new Marked({
  async: false,
  breaks: false,
  gfm: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

type ProtectedSegment = {
  placeholder: string;
  value: string;
};

type KatexSegment = {
  placeholder: string;
  html: string;
};

export function isMarkdownPreviewPath(path: string): boolean {
  return /\.(?:md|markdown)$/i.test(path);
}

export function renderMarkdownPreviewHtml(markdown: string): string {
  const protectedSegments: ProtectedSegment[] = [];
  const katexSegments: KatexSegment[] = [];
  const sourceWithoutCode = protectCodeSegments(markdown, protectedSegments);
  const sourceWithMath = renderMathPlaceholders(sourceWithoutCode, katexSegments);
  const source = restoreProtectedSegments(sourceWithMath, protectedSegments);
  const html = markdownPreviewParser.parse(source, { async: false });

  return restoreKatexSegments(html, katexSegments);
}

function protectCodeSegments(source: string, protectedSegments: ProtectedSegment[]): string {
  const withoutFencedCode = source.replace(/(^|\n)([ \t]{0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]{0,3}\3[ \t]*(?=\n|$)/g, (value: string) => {
    return createProtectedPlaceholder(value, protectedSegments);
  });

  return withoutFencedCode.replace(/(`+)([^`\n]*?)\1/g, (value: string) => {
    return createProtectedPlaceholder(value, protectedSegments);
  });
}

function createProtectedPlaceholder(value: string, protectedSegments: ProtectedSegment[]): string {
  const placeholder = `NOCTURNE_MARKDOWN_CODE_${protectedSegments.length}_PLACEHOLDER`;
  protectedSegments.push({ placeholder, value });
  return placeholder;
}

function restoreProtectedSegments(source: string, protectedSegments: readonly ProtectedSegment[]): string {
  let restored = source;
  for (const segment of protectedSegments) {
    restored = restored.split(segment.placeholder).join(segment.value);
  }
  return restored;
}

function renderMathPlaceholders(source: string, katexSegments: KatexSegment[]): string {
  const withBlockMath = source.replace(/\$\$([\s\S]+?)\$\$/g, (_value: string, expression: string) => {
    return `\n\n${createKatexPlaceholder(expression, true, katexSegments)}\n\n`;
  });

  return withBlockMath.replace(/(^|[^\\$])\$([^\n$]+?)\$/g, (_value: string, prefix: string, expression: string) => {
    return `${prefix}${createKatexPlaceholder(expression, false, katexSegments)}`;
  });
}

function createKatexPlaceholder(expression: string, displayMode: boolean, katexSegments: KatexSegment[]): string {
  const placeholder = `NOCTURNE_MARKDOWN_KATEX_${katexSegments.length}_PLACEHOLDER`;
  katexSegments.push({
    placeholder,
    html: katex.renderToString(expression.trim(), {
      displayMode,
      throwOnError: false,
      strict: "ignore",
    }),
  });
  return placeholder;
}

function restoreKatexSegments(html: string, katexSegments: readonly KatexSegment[]): string {
  let restored = html;
  for (const segment of katexSegments) {
    const paragraphPattern = new RegExp(`<p>\\s*${escapeRegExp(segment.placeholder)}\\s*</p>`, "g");
    restored = restored.replace(paragraphPattern, segment.html);
    restored = restored.split(segment.placeholder).join(segment.html);
  }
  return restored;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
