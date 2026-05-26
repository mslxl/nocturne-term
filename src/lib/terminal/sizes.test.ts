import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeTerminalFitSize, normalizeTerminalSessionSize, toTerminalSessionSizeInput } from "./sizes";

describe("terminal size normalization", () => {
  it("normalizes non-finite fit dimensions before they can reach Tauri invoke", () => {
    const normalized = normalizeTerminalFitSize(
      {
        cols: Number.NaN,
        rows: Number.POSITIVE_INFINITY,
        pixelWidth: Number.NaN,
        pixelHeight: Number.NEGATIVE_INFINITY,
      },
      { cols: 120, rows: 40, pixelWidth: 900, pixelHeight: 500 },
    );

    assert.deepEqual(normalized, {
      cols: 120,
      rows: 40,
      pixelWidth: 900,
      pixelHeight: 500,
    });
    assert.ok(Object.values(normalized).every((value) => Number.isInteger(value) && value > 0));
  });

  it("clamps fit dimensions to the backend pty limits", () => {
    assert.deepEqual(
      normalizeTerminalFitSize(
        { cols: 1, rows: 0, pixelWidth: 0, pixelHeight: 70000 },
        { cols: 80, rows: 24, pixelWidth: 640, pixelHeight: 480 },
      ),
      { cols: 2, rows: 1, pixelWidth: 1, pixelHeight: 65535 },
    );
    assert.deepEqual(
      normalizeTerminalFitSize(
        { cols: 999, rows: 999, pixelWidth: 400.4, pixelHeight: 300.6 },
        { cols: 80, rows: 24, pixelWidth: 640, pixelHeight: 480 },
      ),
      { cols: 500, rows: 300, pixelWidth: 400, pixelHeight: 301 },
    );
  });

  it("normalizes backend session dimensions defensively", () => {
    assert.deepEqual(
      normalizeTerminalSessionSize({
        cols: Number.NaN,
        rows: Number.NaN,
        pixel_width: Number.NaN,
        pixel_height: 0,
      }),
      { cols: 80, rows: 24, pixelWidth: 1, pixelHeight: 1 },
    );
  });

  it("serializes session size input without nulls from NaN values", () => {
    const input = toTerminalSessionSizeInput({
      cols: Number.NaN,
      rows: Number.NaN,
      pixelWidth: Number.NaN,
      pixelHeight: Number.NaN,
    });

    assert.equal(JSON.stringify(input), '{"cols":80,"rows":24,"pixel_width":1,"pixel_height":1}');
  });
});
