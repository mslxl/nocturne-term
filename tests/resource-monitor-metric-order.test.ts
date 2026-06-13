/*
 * Test content:
 *
 * Feature:
 * Verifies Resource Monitor metric panel ordering.
 *
 * Operation:
 * Reorders the CPU, Memory, Swap, and GPU metric order by moving one metric
 * before another, repeats a no-op self move, and attempts invalid reorder
 * operations with missing metric identifiers.
 *
 * Expected:
 * Drag-style reordering returns a new metric order with the dragged panel
 * inserted before the target panel, self moves preserve the order, and invalid
 * metric ids fail loudly instead of silently corrupting the panel order.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultResourceMetricOrder, reorderResourceMetricOrder } from "../src/lib/resources/metric-order";

describe("Resource Monitor metric panel order", () => {
  it("moves a dragged metric before the target metric", () => {
    assert.deepEqual(
      reorderResourceMetricOrder(defaultResourceMetricOrder, "gpu", "memory"),
      ["cpu", "gpu", "memory", "swap"],
    );
    assert.deepEqual(
      reorderResourceMetricOrder(["cpu", "gpu", "memory", "swap"], "cpu", "swap"),
      ["gpu", "memory", "cpu", "swap"],
    );
  });

  it("preserves order for a self move", () => {
    assert.deepEqual(
      reorderResourceMetricOrder(defaultResourceMetricOrder, "cpu", "cpu"),
      defaultResourceMetricOrder,
    );
  });

  it("rejects invalid dragged or target metrics", () => {
    assert.throws(
      () => reorderResourceMetricOrder(["cpu", "memory"], "swap", "cpu"),
      /dragged resource metric is not in the order/,
    );
    assert.throws(
      () => reorderResourceMetricOrder(["cpu", "memory"], "cpu", "gpu"),
      /target resource metric is not in the order/,
    );
  });
});
