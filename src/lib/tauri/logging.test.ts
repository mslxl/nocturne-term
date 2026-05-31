import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatConsoleValuesForLog } from "./logging";

describe("frontend log formatting", () => {
  it("expands objects and marks direct circular references", () => {
    const value: { name: string; self?: unknown } = { name: "session" };
    value.self = value;

    assert.equal(formatConsoleValuesForLog([value]), '{"name":"session","self":"[Circular]"}');
  });

  it("expands nested circular references without hiding non-circular repeated objects", () => {
    const shared = { host: "local" };
    const value: { left: unknown; right: unknown; nested: { parent?: unknown } } = {
      left: shared,
      right: shared,
      nested: {}
    };
    value.nested.parent = value;

    assert.equal(
      formatConsoleValuesForLog([value]),
      '{"left":{"host":"local"},"right":{"host":"local"},"nested":{"parent":"[Circular]"}}',
    );
  });

  it("marks properties that throw while being read", () => {
    const value = {
      get broken() {
        throw new Error("read failed");
      }
    };

    assert.equal(formatConsoleValuesForLog([value]), '{"broken":"[Thrown while reading: read failed]"}');
  });
});
