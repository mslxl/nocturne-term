/*
 * Test content:
 *
 * Feature:
 * Verifies the Terminal mirror PTY size policy used when one backend terminal
 * session is displayed by multiple owner, mirror, or floating views.
 *
 * Operation:
 * Computes the shared PTY size from sets of Terminal view measurements that
 * include visible usable views, hidden views, unmounted views, not-yet-fitted
 * views, and views below the minimum participating terminal size.
 *
 * Expected:
 * Only visible, mounted, fitted, and usable views participate. The shared PTY
 * size uses the minimum participating columns and rows, all views tied for the
 * limiting dimension are marked as constraining, and a session with no usable
 * participants keeps the last valid PTY size without requesting a resize.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeTerminalMirrorPtySize } from "../src/lib/terminal/mirror-size";

describe("Terminal mirror PTY size", () => {
  it("uses the minimum usable size across visible mounted fitted views", () => {
    const result = computeTerminalMirrorPtySize({
      lastValidSize: { cols: 100, rows: 32, pixelWidth: 900, pixelHeight: 420 },
      lastSentSize: { cols: 100, rows: 32, pixelWidth: 900, pixelHeight: 420 },
      views: [
        view("owner", 120, 32, 960, 420),
        view("mirror-narrow", 88, 36, 660, 500),
        view("mirror-short", 110, 24, 820, 300),
        view("hidden", 40, 12, 320, 160, { visible: false }),
        view("unmounted", 45, 12, 340, 180, { mounted: false }),
        view("not-fitted", 48, 12, 360, 190, { fitted: false }),
      ],
    });

    assert.deepEqual(result.size, { cols: 88, rows: 24, pixelWidth: 660, pixelHeight: 300 });
    assert.deepEqual(result.participantIds, ["owner", "mirror-narrow", "mirror-short"]);
    assert.deepEqual(result.constrainingViewIds, ["mirror-narrow", "mirror-short"]);
    assert.deepEqual(result.tooSmallViewIds, []);
    assert.equal(result.shouldSendResize, true);
  });

  it("ignores too-small views and keeps the last valid size when none can participate", () => {
    const lastValidSize = { cols: 96, rows: 30, pixelWidth: 820, pixelHeight: 390 };
    const result = computeTerminalMirrorPtySize({
      lastValidSize,
      lastSentSize: lastValidSize,
      minimum: { cols: 20, rows: 6 },
      views: [
        view("compact-owner", 18, 10, 140, 120),
        view("compact-mirror", 80, 5, 620, 72),
        view("background-mirror", 100, 30, 900, 420, { visible: false }),
      ],
    });

    assert.deepEqual(result.size, lastValidSize);
    assert.deepEqual(result.participantIds, []);
    assert.deepEqual(result.tooSmallViewIds, ["compact-owner", "compact-mirror"]);
    assert.deepEqual(result.constrainingViewIds, []);
    assert.equal(result.shouldSendResize, false);
  });
});

function view(
  id: string,
  cols: number,
  rows: number,
  pixelWidth: number,
  pixelHeight: number,
  overrides: Partial<Parameters<typeof computeTerminalMirrorPtySize>[0]["views"][number]> = {},
) {
  return {
    id,
    visible: true,
    mounted: true,
    fitted: true,
    cols,
    rows,
    pixelWidth,
    pixelHeight,
    ...overrides,
  };
}
