/*
Feature: Files preview visibility for unsupported content.
Operation: Evaluate preview results returned for text, image, unsupported, over-limit, and loading states.
Expected: Only completed text and image preview results create a preview region; loading, unsupported, and over-limit files do not produce any visible preview area.
*/
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isRenderableFilePreview, shouldShowFilePreviewRegion, type FileTreePreviewResult } from "../src/lib/files/tree";

describe("Files preview visibility for unsupported content", () => {
  it("shows previews only for renderable text and image content", () => {
    assert.equal(isRenderableFilePreview(preview("text")), true);
    assert.equal(isRenderableFilePreview(preview("image")), true);
    assert.equal(isRenderableFilePreview(preview("unsupported")), false);
    assert.equal(isRenderableFilePreview(preview("too_large")), false);
    assert.equal(isRenderableFilePreview(undefined), false);
  });

  it("creates the preview region only after a matching renderable preview result exists", () => {
    assert.equal(shouldShowFilePreviewRegion({ selectedPath: "/repo/README.md", previewPath: "/repo/README.md", preview: preview("text") }), true);
    assert.equal(shouldShowFilePreviewRegion({ selectedPath: "/repo/image.png", previewPath: "/repo/image.png", preview: preview("image") }), true);
    assert.equal(shouldShowFilePreviewRegion({ selectedPath: "/repo/archive.bin", previewPath: "/repo/archive.bin", preview: preview("unsupported") }), false);
    assert.equal(shouldShowFilePreviewRegion({ selectedPath: "/repo/archive.bin", previewPath: "/repo/archive.bin", preview: preview("too_large") }), false);
    assert.equal(shouldShowFilePreviewRegion({ selectedPath: "/repo/archive.bin", previewPath: "/repo/archive.bin", preview: undefined }), false);
    assert.equal(shouldShowFilePreviewRegion({ selectedPath: "/repo/next.md", previewPath: "/repo/next.md", preview: preview("text") }), false);
  });
});

function preview(kind: FileTreePreviewResult["content"]["kind"]): FileTreePreviewResult {
  if (kind === "text") {
    return {
      path: "/repo/README.md",
      name: "README.md",
      entry_kind: "file",
      size: "12",
      modified_unix_ms: null,
      permissions: null,
      content: { kind, text: "hello" },
    };
  }
  if (kind === "image") {
    return {
      path: "/repo/image.png",
      name: "image.png",
      entry_kind: "file",
      size: "12",
      modified_unix_ms: null,
      permissions: null,
      content: { kind, mime: "image/png", data_base64: "aGVsbG8=" },
    };
  }
  if (kind === "too_large") {
    return {
      path: "/repo/archive.bin",
      name: "archive.bin",
      entry_kind: "file",
      size: "999999",
      modified_unix_ms: null,
      permissions: null,
      content: { kind, limit_bytes: 1024 },
    };
  }
  return {
    path: "/repo/archive.bin",
    name: "archive.bin",
    entry_kind: "file",
    size: "12",
    modified_unix_ms: null,
    permissions: null,
    content: { kind, reason: "Unsupported file type" },
  };
}
