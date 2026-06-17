/*
 * Test content:
 *
 * Feature:
 * Verifies the Resource Monitor UI view model for dense metric rows.
 *
 * Operation:
 * Builds a Resource Monitor snapshot with overall CPU, per-core CPU details,
 * memory, swap, two GPU devices, and two Disk mount points, then converts it
 * into render rows with custom metric ordering and history samples.
 *
 * Expected:
 * The view model returns a provider/status summary, uses current values and
 * compact auxiliary text, keeps CPU, GPU, and Disk as one overall row each by
 * default, exposes CPU core, GPU device, and Disk mount child rows for
 * expandable details, keeps history curves for non-Disk available overall
 * rows, renders Disk as a progress-style capacity row without a history curve,
 * omits useless "Updated now" status text, sample-count labels, and chart max
 * labels, respects custom metric order, and represents unavailable metrics
 * with their reasons instead of failing the whole UI.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { buildResourceMonitorViewModel } from "../src/lib/resources/view-model";
import type { ResourceCollection } from "../src/lib/resources/store";

describe("Resource Monitor UI view model", () => {
  it("builds dense overall rows with expandable CPU, GPU, and Disk details", () => {
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
              {
                id: "gpu-0",
                label: "GPU 0",
                computePercent: 10,
                memoryUsed: 1 * 1024 ** 3,
                memoryTotal: 4 * 1024 ** 3,
              },
              {
                id: "gpu-1",
                label: "GPU 1",
                computePercent: null,
                computeUnavailableReason: "compute unavailable",
                memoryUsed: 3 * 1024 ** 3,
                memoryTotal: 4 * 1024 ** 3,
              },
            ],
          },
        },
        disk: {
          metric: "disk",
          status: "available",
          percent: 60,
          used: 60 * 1024 ** 3,
          total: 100 * 1024 ** 3,
          available: 40 * 1024 ** 3,
          collectedAtMs: 120000,
          details: {
            disks: [
              {
                id: "/",
                mountPoint: "/",
                deviceName: "/dev/nvme0n1p2",
                fileSystem: "ext4",
                used: 60 * 1024 ** 3,
                total: 100 * 1024 ** 3,
                available: 40 * 1024 ** 3,
                percent: 60,
              },
              {
                id: "/data",
                mountPoint: "/data",
                deviceName: "/dev/sdb1",
                fileSystem: "xfs",
                used: 500 * 1024 ** 3,
                total: 1000 * 1024 ** 3,
                available: 500 * 1024 ** 3,
                percent: 50,
              },
            ],
          },
        },
      },
    };

    const collapsedModel = buildResourceMonitorViewModel({
      snapshot,
      historyForMetric: () => [],
      metricOrder: ["memory", "cpu", "swap", "gpu", "disk"],
      stale: false,
      warning: null,
    });

    assert.equal(collapsedModel.providerLabel, "local provider");
    assert.equal(collapsedModel.rows.find((row) => row.id === "cpu")?.collapsible, true);
    assert.equal(collapsedModel.rows.find((row) => row.id === "cpu")?.expanded, false);
    assert.equal(collapsedModel.rows.find((row) => row.id === "gpu")?.collapsible, true);
    assert.equal(collapsedModel.rows.find((row) => row.id === "gpu")?.expanded, false);
    assert.equal(collapsedModel.rows.find((row) => row.id === "disk")?.collapsible, true);
    assert.equal(collapsedModel.rows.find((row) => row.id === "disk")?.expanded, false);

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
      metricOrder: ["memory", "cpu", "swap", "gpu", "disk"],
      expandedMetrics: new Set(["cpu", "gpu", "disk"]),
      stale: false,
      warning: null,
    });

    assert.equal(model.providerLabel, "local provider");
    assert.equal(model.statusLabel, "");
    assert.deepEqual(model.rows.map((row) => row.id), ["memory", "cpu", "swap", "gpu", "disk"]);

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
      ["gpu-gpu-1", "GPU 1", "Compute unavailable"],
    ]);

    const disk = model.rows[4];
    assert.equal(disk?.primary, "60%");
    assert.equal(disk?.auxiliary, "60 GiB / 100 GiB, available 40 GiB");
    assert.equal(disk?.collapsible, true);
    assert.equal(disk?.expanded, true);
    assert.equal(disk?.history, null);
    assert.equal(disk?.progressPercent, 60);
    assert.deepEqual(disk?.children.map((child) => [child.id, child.label, child.primary, child.auxiliary, child.progressPercent]), [
      ["disk-_", "/", "60%", "/dev/nvme0n1p2, ext4, 60 GiB / 100 GiB, available 40 GiB", 60],
      ["disk-_data", "/data", "50%", "/dev/sdb1, xfs, 500 GiB / 1000 GiB, available 500 GiB", 50],
    ]);
  });
});
