/*
 * Test content:
 *
 * Feature:
 * Verifies the Resource Monitor UI view model for dense metric rows.
 *
 * Operation:
 * Builds a Resource Monitor snapshot with overall CPU, per-core CPU details,
 * memory, swap, and two GPU devices, then converts it into render rows with
 * custom metric ordering and history samples.
 *
 * Expected:
 * The view model returns a provider/status summary, uses current values and
 * compact auxiliary text, keeps CPU and GPU as one overall row each by default,
 * exposes CPU core and GPU device child rows for expandable details, always
 * exposes history data for available overall rows, omits useless "Updated now"
 * status text, sample-count labels, and chart max labels, respects custom
 * metric order, and represents unavailable metrics with their reasons instead
 * of failing the whole UI.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { buildResourceMonitorViewModel } from "../src/lib/resources/view-model";
import type { ResourceCollection } from "../src/lib/resources/store";

describe("Resource Monitor UI view model", () => {
  it("builds dense overall rows with expandable CPU core and GPU device details", () => {
    const snapshot: ResourceCollection = {
      ownerToolTabId: "tool-resources-1",
      provider: "local provider",
      collectedAtMs: 120000,
      metrics: {
        cpu: {
          metric: "cpu",
          status: "available",
          percent: 36,
          used: 36,
          total: 100,
          collectedAtMs: 120000,
          details: {
            cores: [
              { id: "0", label: "Core 0", percent: 10 },
              { id: "1", label: "Core 1", percent: 62 },
            ],
          },
        },
        memory: {
          metric: "memory",
          status: "available",
          percent: 50,
          used: 8 * 1024 ** 3,
          total: 16 * 1024 ** 3,
          available: 6 * 1024 ** 3,
          collectedAtMs: 120000,
        },
        swap: {
          metric: "swap",
          status: "unavailable",
          reason: "Swap is disabled on this host.",
          collectedAtMs: 120000,
        },
        gpu: {
          metric: "gpu",
          status: "available",
          percent: 40,
          used: 4 * 1024 ** 3,
          total: 8 * 1024 ** 3,
          collectedAtMs: 120000,
          details: {
            gpus: [
              { id: "gpu-0", label: "GPU 0", computePercent: 10, memoryUsed: 1 * 1024 ** 3, memoryTotal: 4 * 1024 ** 3 },
              { id: "gpu-1", label: "GPU 1", computePercent: 70, memoryUsed: 3 * 1024 ** 3, memoryTotal: 4 * 1024 ** 3 },
            ],
          },
        },
      },
    };

    const collapsedModel = buildResourceMonitorViewModel({
      snapshot,
      historyForMetric: () => [],
      metricOrder: ["memory", "cpu", "swap", "gpu"],
      stale: false,
      warning: null,
    });

    assert.equal(collapsedModel.providerLabel, "local provider");
    assert.equal(collapsedModel.rows.find((row) => row.id === "cpu")?.collapsible, true);
    assert.equal(collapsedModel.rows.find((row) => row.id === "cpu")?.expanded, false);
    assert.equal(collapsedModel.rows.find((row) => row.id === "gpu")?.collapsible, true);
    assert.equal(collapsedModel.rows.find((row) => row.id === "gpu")?.expanded, false);

    const model = buildResourceMonitorViewModel({
      snapshot,
      historyForMetric: (metric) => metric === "cpu"
        ? [
            {
              metric: "cpu",
              status: "available",
              percent: 12,
              used: 12,
              total: 100,
              collectedAtMs: 119000,
              details: {
                cores: [
                  { id: "0", label: "Core 0", percent: 8 },
                  { id: "1", label: "Core 1", percent: 16 },
                ],
              },
            },
            {
              metric: "cpu",
              status: "available",
              percent: 36,
              used: 36,
              total: 100,
              collectedAtMs: 120000,
              details: {
                cores: [
                  { id: "0", label: "Core 0", percent: 10 },
                  { id: "1", label: "Core 1", percent: 62 },
                ],
              },
            },
          ]
        : [],
      metricOrder: ["memory", "cpu", "swap", "gpu"],
      expandedMetrics: new Set(["cpu", "gpu"]),
      stale: false,
      warning: null,
    });

    assert.equal(model.providerLabel, "local provider");
    assert.equal(model.statusLabel, "");
    assert.deepEqual(model.rows.map((row) => row.id), ["memory", "cpu", "swap", "gpu"]);

    const cpu = model.rows[1];
    assert.equal(cpu?.primary, "36%");
    assert.equal(cpu?.auxiliary, "2 cores");
    assert.deepEqual(cpu?.history?.points, [12, 36]);
    assert.equal("maxLabel" in (cpu?.history ?? {}), false);
    assert.equal(cpu?.collapsible, true);
    assert.equal(cpu?.expanded, true);
    assert.deepEqual(cpu?.children.map((child) => [child.id, child.primary]), [
      ["cpu-core-0", "10%"],
      ["cpu-core-1", "62%"],
    ]);
    assert.equal(cpu?.history?.label, "");

    const memory = model.rows[0];
    assert.equal(memory?.primary, "50%");
    assert.match(memory?.auxiliary ?? "", /8 GiB \/ 16 GiB/);
    assert.match(memory?.auxiliary ?? "", /available 6 GiB/);
    assert.deepEqual(memory?.history?.points, []);
    assert.equal(memory?.collapsible, false);

    const swap = model.rows[2];
    assert.equal(swap?.status, "unavailable");
    assert.equal(swap?.reason, "Swap is disabled on this host.");
    assert.equal(swap?.collapsible, false);

    const gpu = model.rows[3];
    assert.equal(gpu?.auxiliary, "2 GPUs, 4 GiB / 8 GiB VRAM");
    assert.equal(gpu?.collapsible, true);
    assert.equal(gpu?.expanded, true);
    assert.deepEqual(gpu?.children.map((child) => [child.id, child.label, child.primary]), [
      ["gpu-gpu-0", "GPU 0", "10%"],
      ["gpu-gpu-1", "GPU 1", "70%"],
    ]);
  });
});
