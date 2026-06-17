/*
 * Test content:
 *
 * Feature:
 * Verifies in-memory Resource Monitor history buffers for owner and mirror
 * ToolTab views.
 *
 * Operation:
 * Collects metric samples with controlled timestamps, exceeds the five-minute
 * retention window, exceeds the 300-sample per-metric cap, and reads the same
 * owner history through owner and mirror views.
 *
 * Expected:
 * History keeps only samples from the last five minutes and at most 300 samples
 * per metric, owner and mirror views share the same owner sampling data without
 * duplicate polling, and no history is persisted outside the frontend store
 * instance.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createResourceMonitorStore, type ResourceCollection, type ResourceMetric } from "../src/lib/resources/store";

function collection(ownerToolTabId: string, metric: "cpu" | "memory", percent: number, collectedAtMs: number): ResourceCollection {
  return {
    ownerToolTabId,
    provider: "local provider",
    collectedAtMs,
    metrics: {
      [metric]: {
        metric,
        status: "available",
        percent,
        used: percent,
        total: 100,
        collectedAtMs,
      },
    },
  };
}

function availablePercents(samples: ResourceMetric[]): number[] {
  return samples.map((sample) => {
    assert.equal(sample.status, "available");
    return sample.percent;
  });
}

describe("Resource Monitor history buffers", () => {
  it("prunes samples older than five minutes for each metric", async () => {
    const samples = [
      collection("tool-resources-1", "cpu", 1, 0),
      collection("tool-resources-1", "cpu", 2, 1000),
      collection("tool-resources-1", "cpu", 3, 301000),
    ];
    const store = createResourceMonitorStore({
      provider: {
        collect: async () => {
          const sample = samples.shift();
          assert.ok(sample, "test must provide enough samples");
          return sample;
        },
      },
    });
    store.setViewVisibility({ viewId: "owner-view", ownerToolTabId: "tool-resources-1", visible: true });

    await store.tickForView("owner-view");
    await store.tickForView("owner-view");
    await store.tickForView("owner-view");

    assert.deepEqual(
      availablePercents(store.historyForMetric("tool-resources-1", "cpu")),
      [2, 3],
    );
  });

  it("keeps at most 300 samples per metric", async () => {
    let nextPercent = 0;
    const store = createResourceMonitorStore({
      provider: {
        collect: async () => {
          nextPercent += 1;
          return collection("tool-resources-1", "memory", nextPercent, nextPercent);
        },
      },
    });
    store.setViewVisibility({ viewId: "owner-view", ownerToolTabId: "tool-resources-1", visible: true });

    for (let index = 0; index < 301; index += 1) {
      await store.tickForView("owner-view");
    }

    const history = store.historyForMetric("tool-resources-1", "memory");
    assert.equal(history.length, 300);
    assert.deepEqual(availablePercents([history[0], history[299]].filter((sample): sample is ResourceMetric => Boolean(sample))), [2, 301]);
  });

  it("shares owner history between owner and mirror views without duplicate collection", async () => {
    let calls = 0;
    const store = createResourceMonitorStore({
      provider: {
        collect: async () => {
          calls += 1;
          return collection("tool-resources-1", "cpu", 80, 1000);
        },
      },
    });
    store.setViewVisibility({ viewId: "owner-view", ownerToolTabId: "tool-resources-1", visible: true });
    store.setViewVisibility({ viewId: "mirror-view", ownerToolTabId: "tool-resources-1", visible: true });

    await store.tickVisibleOwners();

    assert.equal(calls, 1);
    assert.deepEqual(store.historyForView("owner-view", "cpu"), store.historyForView("mirror-view", "cpu"));
  });

  it("does not persist history across frontend store instances", async () => {
    const first = createResourceMonitorStore({
      provider: {
        collect: async () => collection("tool-resources-1", "cpu", 33, 1000),
      },
    });
    first.setViewVisibility({ viewId: "owner-view", ownerToolTabId: "tool-resources-1", visible: true });
    await first.tickForView("owner-view");

    const second = createResourceMonitorStore({
      provider: {
        collect: async () => collection("tool-resources-1", "cpu", 44, 1000),
      },
    });

    assert.deepEqual(second.historyForMetric("tool-resources-1", "cpu"), []);
  });
});
