import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  terminalScrollbarLineFromPointer,
  terminalScrollbarState,
  terminalWheelDeltaToLines,
  terminalWheelScrollResult,
} from "./scrollbar";

describe("terminal scrollbar state", () => {
  it("hides the thumb when xterm has no scrollback", () => {
    assert.deepEqual(terminalScrollbarState({ baseY: 0, viewportY: 0, rows: 24 }), {
      visible: false,
      thumbSizePercent: 1,
      scrollPercent: 0,
      scrollbackRows: 0,
    });
  });

  it("derives visible thumb geometry from xterm scrollback", () => {
    assert.deepEqual(terminalScrollbarState({ baseY: 300, viewportY: 150, rows: 100 }), {
      visible: true,
      thumbSizePercent: 0.25,
      scrollPercent: 0.5,
      scrollbackRows: 300,
    });
  });

  it("clamps invalid viewport positions to the valid scrollback range", () => {
    assert.deepEqual(terminalScrollbarState({ baseY: 20, viewportY: 200, rows: 80 }), {
      visible: true,
      thumbSizePercent: 0.8,
      scrollPercent: 1,
      scrollbackRows: 20,
    });
    assert.deepEqual(terminalScrollbarState({ baseY: 20, viewportY: -5, rows: 80 }), {
      visible: true,
      thumbSizePercent: 0.8,
      scrollPercent: 0,
      scrollbackRows: 20,
    });
  });

  it("maps scrollbar pointer positions to xterm scrollback lines", () => {
    assert.equal(
      terminalScrollbarLineFromPointer({
        pointerY: 0,
        trackTop: 0,
        trackHeight: 400,
        thumbHeight: 100,
        scrollbackRows: 300,
      }),
      0,
    );
    assert.equal(
      terminalScrollbarLineFromPointer({
        pointerY: 200,
        trackTop: 0,
        trackHeight: 400,
        thumbHeight: 100,
        scrollbackRows: 300,
      }),
      150,
    );
    assert.equal(
      terminalScrollbarLineFromPointer({
        pointerY: 500,
        trackTop: 0,
        trackHeight: 400,
        thumbHeight: 100,
        scrollbackRows: 300,
      }),
      300,
    );
  });

  it("accumulates fractional pixel wheel deltas for trackpad scrolling", () => {
    const first = terminalWheelDeltaToLines({ deltaY: 4, deltaMode: 0, rows: 30, previousRemainder: 0 });
    assert.deepEqual(first, { lines: 0, remainder: 0.25 });

    const second = terminalWheelDeltaToLines({ deltaY: 12, deltaMode: 0, rows: 30, previousRemainder: first.remainder });
    assert.deepEqual(second, { lines: 1, remainder: 0 });
  });

  it("preserves direction for negative wheel deltas", () => {
    assert.deepEqual(terminalWheelDeltaToLines({ deltaY: -20, deltaMode: 0, rows: 30, previousRemainder: 0 }), {
      lines: -1,
      remainder: -0.25,
    });
  });

  it("consumes normal-buffer wheel events at scrollback boundaries", () => {
    assert.deepEqual(
      terminalWheelScrollResult({
        baseY: 300,
        viewportY: 0,
        deltaY: -24,
        deltaMode: 0,
        rows: 30,
        previousRemainder: 0,
        normalBuffer: true,
        mouseTracking: false,
        defaultPrevented: false,
        shiftKey: false,
      }),
      {
        consume: true,
        target: null,
        remainder: -0.5,
      },
    );

    assert.deepEqual(
      terminalWheelScrollResult({
        baseY: 300,
        viewportY: 300,
        deltaY: 24,
        deltaMode: 0,
        rows: 30,
        previousRemainder: 0,
        normalBuffer: true,
        mouseTracking: false,
        defaultPrevented: false,
        shiftKey: false,
      }),
      {
        consume: true,
        target: null,
        remainder: 0.5,
      },
    );
  });

  it("leaves TUI and mouse-tracking wheel events for xterm", () => {
    assert.deepEqual(
      terminalWheelScrollResult({
        baseY: 0,
        viewportY: 0,
        deltaY: 24,
        deltaMode: 0,
        rows: 30,
        previousRemainder: 0.25,
        normalBuffer: false,
        mouseTracking: false,
        defaultPrevented: false,
        shiftKey: false,
      }),
      {
        consume: false,
        target: null,
        remainder: 0.25,
      },
    );

    assert.deepEqual(
      terminalWheelScrollResult({
        baseY: 300,
        viewportY: 120,
        deltaY: 24,
        deltaMode: 0,
        rows: 30,
        previousRemainder: 0.25,
        normalBuffer: true,
        mouseTracking: true,
        defaultPrevented: false,
        shiftKey: false,
      }),
      {
        consume: false,
        target: null,
        remainder: 0.25,
      },
    );
  });
});
