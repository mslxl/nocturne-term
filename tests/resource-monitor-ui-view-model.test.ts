/*
 * Test content:
 *
 * Feature:
 * Verifies the Resource Monitor UI view model for dense metric rows.
 *
 * Operation:
 * Builds a Resource Monitor snapshot with overall CPU, per-core CPU details,
 * memory, swap, and two GPU devices, then converts it into render rows with
 * CPU and GPU groups collapsed by default, then expanded explicitly with custom
 * metric ordering and history samples.
 *
 * Expected:
 * The view model returns a provider/status summary, uses current values and
 * compact auxiliary text, keeps collapsible child rows hidden when groups are
 * closed, exposes CPU cores and GPU devices when groups are explicitly opened,
 * always exposes history data for available rows, exposes CPU overall and
 * per-core history, omits useless "Updated now" status text, sample-count
 * labels, and chart max labels, respects custom metric order, and represents
 * unavailable metrics with their reasons instead of failing the whole UI.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildResourceMonitorViewModel } from "../src/lib/resources/view-model";
import type { ResourceCollection } from "../src/lib/resources/store";

describe("Resource Monitor UI view model", () => {
  it("builds dense rows with collapsible CPU cores and GPU devices", () => {
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
      expandedGroups: new Set(),
      historyForMetric: () => [],
      metricOrder: ["memory", "cpu", "swap", "gpu"],
      stale: false,
      warning: null,
    });

    assert.equal(collapsedModel.providerLabel, "local provider");
    assert.equal(collapsedModel.rows.find((row) => row.id === "cpu")?.expanded, false);
    assert.equal(collapsedModel.rows.find((row) => row.id === "cpu")?.children.length, 0);
    assert.equal(collapsedModel.rows.find((row) => row.id === "gpu")?.expanded, false);
    assert.equal(collapsedModel.rows.find((row) => row.id === "gpu")?.children.length, 0);

    const model = buildResourceMonitorViewModel({
      snapshot,
      expandedGroups: new Set(["cpu", "gpu"]),
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
    assert.deepEqual(cpu?.children?.map((row) => `${row.label}:${row.primary}`), ["Core 0:10%", "Core 1:62%"]);
    assert.deepEqual(cpu?.children?.[0]?.history?.points, [8, 10]);
    assert.deepEqual(cpu?.children?.[1]?.history?.points, [16, 62]);
    assert.equal(cpu?.history?.label, "");

    const memory = model.rows[0];
    assert.equal(memory?.primary, "50%");
    assert.match(memory?.auxiliary ?? "", /8 GiB \/ 16 GiB/);
    assert.match(memory?.auxiliary ?? "", /available 6 GiB/);
    assert.deepEqual(memory?.history?.points, []);

    const swap = model.rows[2];
    assert.equal(swap?.status, "unavailable");
    assert.equal(swap?.reason, "Swap is disabled on this host.");

    const gpu = model.rows[3];
    assert.equal(gpu?.auxiliary, "2 GPUs");
    assert.deepEqual(gpu?.children?.map((row) => `${row.label}:${row.primary}:${row.auxiliary}`), [
      "GPU 0:10% compute:1 GiB / 4 GiB VRAM",
      "GPU 1:70% compute:3 GiB / 4 GiB VRAM",
    ]);
  });
});
