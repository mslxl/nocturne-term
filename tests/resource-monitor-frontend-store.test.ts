/*
 * Test content:
 *
 * Feature:
 * Verifies the Resource Monitor frontend polling store that coordinates visible
 * owner and mirror ToolTab views.
 *
 * Operation:
 * Registers multiple visible views for the same owner ToolTab, triggers polling
 * ticks, triggers overlapping ticks, simulates provider failures, and returns a
 * successful snapshot where one metric is unavailable while other metrics are
 * available, and simulates a user switching remote provider modes.
 *
 * Expected:
 * The store owns polling by owner ToolTab id so mirrors do not duplicate
 * collection, skips a tick while a collection is already in flight, uses a
 * five-second provider timeout by default, marks data stale after three
 * consecutive failures while preserving the last successful snapshot, and keeps
 * per-metric unavailable reasons without failing the whole Resource Monitor.
 * When a provider mode switch begins, the store clears the previous provider's
 * snapshot and history so the panel cannot display metrics from the wrong
 * source while the new provider is loading.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RESOURCE_PROVIDER_TIMEOUT_MS,
  createResourceMonitorStore,
  type ResourceCollection,
} from "../src/lib/resources/store";

function available(metric: "cpu" | "memory" | "swap" | "gpu", percent: number) {
  return { metric, status: "available" as const, percent, used: 1, total: 4, collectedAtMs: 1000 };
}

function unavailable(metric: "cpu" | "memory" | "swap" | "gpu", reason: string) {
  return { metric, status: "unavailable" as const, reason, collectedAtMs: 1000 };
}

describe("Resource Monitor frontend store", () => {
  it("deduplicates collection by owner ToolTab across visible mirrors", async () => {
    let calls = 0;
    const snapshot: ResourceCollection = {
      ownerToolTabId: "tool-resources-1",
      provider: "local provider",
      collectedAtMs: 1000,
      metrics: {
        cpu: available("cpu", 23),
      },
    };
    const store = createResourceMonitorStore({
      provider: {
        collect: async () => {
          calls += 1;
          return snapshot;
        },
      },
    });

    store.setViewVisibility({ viewId: "owner-view", ownerToolTabId: "tool-resources-1", visible: true });
    store.setViewVisibility({ viewId: "mirror-view", ownerToolTabId: "tool-resources-1", visible: true });

    const results = await store.tickVisibleOwners();

    assert.equal(calls, 1);
    assert.deepEqual(results.map((result) => result.kind), ["collected"]);
    assert.deepEqual(store.visibleOwnerToolTabIds(), ["tool-resources-1"]);
    assert.equal(store.stateForOwner("tool-resources-1").latest?.metrics.cpu?.status, "available");
  });

  it("skips overlapping ticks while a collection is in flight", async () => {
    let calls = 0;
    let resolveCollection: (value: ResourceCollection) => void = () => {
      throw new Error("collection resolver was not installed");
    };
    const collection = new Promise<ResourceCollection>((resolve) => {
      resolveCollection = resolve;
    });
    const store = createResourceMonitorStore({
      provider: {
        collect: () => {
          calls += 1;
          return collection;
        },
      },
    });
    store.setViewVisibility({ viewId: "owner-view", ownerToolTabId: "tool-resources-1", visible: true });

    const first = store.tickForView("owner-view");
    const second = await store.tickForView("owner-view");
    resolveCollection({
      ownerToolTabId: "tool-resources-1",
      provider: "local provider",
      collectedAtMs: 1000,
      metrics: { cpu: available("cpu", 42) },
    });
    const firstResult = await first;

    assert.equal(calls, 1);
    assert.equal(second.kind, "skipped_in_flight");
    assert.equal(firstResult.kind, "collected");
  });

  it("defaults to a five-second timeout and records timeout failures", async () => {
    assert.equal(RESOURCE_PROVIDER_TIMEOUT_MS, 5000);
    const store = createResourceMonitorStore({
      timeoutMs: 1,
      provider: {
        collect: (_input) => new Promise<ResourceCollection>(() => {}),
      },
    });
    store.setViewVisibility({ viewId: "owner-view", ownerToolTabId: "tool-resources-1", visible: true });

    const result = await store.tickForView("owner-view");

    assert.equal(result.kind, "failed");
    assert.match(result.error.message, /timed out/i);
    assert.equal(store.stateForOwner("tool-resources-1").consecutiveFailures, 1);
  });

  it("marks stale after three failures while preserving the last successful data", async () => {
    let shouldFail = false;
    const store = createResourceMonitorStore({
      provider: {
        collect: async () => {
          if (shouldFail) {
            throw new Error("provider unavailable");
          }
          return {
            ownerToolTabId: "tool-resources-1",
            provider: "local provider",
            collectedAtMs: 1000,
            metrics: { memory: available("memory", 64) },
          };
        },
      },
    });
    store.setViewVisibility({ viewId: "owner-view", ownerToolTabId: "tool-resources-1", visible: true });

    await store.tickForView("owner-view");
    shouldFail = true;
    await store.tickForView("owner-view");
    await store.tickForView("owner-view");
    await store.tickForView("owner-view");

    const state = store.stateForOwner("tool-resources-1");
    assert.equal(state.consecutiveFailures, 3);
    assert.equal(state.stale, true);
    assert.equal(state.latest?.metrics.memory?.status, "available");
    assert.equal(state.latest?.metrics.memory?.percent, 64);
    assert.match(state.warning ?? "", /stale/i);
  });

  it("keeps per-metric unavailable reasons without failing the whole snapshot", async () => {
    const store = createResourceMonitorStore({
      provider: {
        collect: async () => ({
          ownerToolTabId: "tool-resources-1",
          provider: "local provider",
          collectedAtMs: 1000,
          metrics: {
            cpu: available("cpu", 50),
            gpu: unavailable("gpu", "No GPU provider is available on this host."),
          },
        }),
      },
    });
    store.setViewVisibility({ viewId: "owner-view", ownerToolTabId: "tool-resources-1", visible: true });

    const result = await store.tickForView("owner-view");
    const state = store.stateForOwner("tool-resources-1");

    assert.equal(result.kind, "collected");
    assert.equal(state.consecutiveFailures, 0);
    assert.equal(state.latest?.metrics.cpu?.status, "available");
    assert.equal(state.latest?.metrics.gpu?.status, "unavailable");
    assert.equal(state.latest?.metrics.gpu?.reason, "No GPU provider is available on this host.");
  });

  it("clears stale provider data and history when a provider switch begins", async () => {
    const store = createResourceMonitorStore({
      provider: {
        collect: async () => ({
          ownerToolTabId: "tool-resources-1",
          provider: "system commands on remote",
          collectedAtMs: 1000,
          metrics: {
            cpu: available("cpu", 40),
            gpu: available("gpu", 20),
          },
        }),
      },
    });
    store.setViewVisibility({ viewId: "owner-view", ownerToolTabId: "tool-resources-1", visible: true });
    await store.tickForView("owner-view");

    assert.equal(store.stateForOwner("tool-resources-1").latest?.provider, "system commands on remote");
    assert.equal(store.historyForMetric("tool-resources-1", "cpu").length, 1);

    store.beginProviderSwitch("tool-resources-1");

    const state = store.stateForOwner("tool-resources-1");
    assert.equal(state.latest, null);
    assert.equal(state.stale, false);
    assert.equal(state.warning, null);
    assert.equal(state.consecutiveFailures, 0);
    assert.deepEqual(store.historyForMetric("tool-resources-1", "cpu"), []);
    assert.deepEqual(store.historyForMetric("tool-resources-1", "gpu"), []);
  });
});
