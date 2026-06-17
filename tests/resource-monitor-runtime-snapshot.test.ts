/*
 * Test content:
 *
 * Feature:
 * Verifies Resource Monitor frontend snapshot normalization for GPU device
 * details received from generated Tauri/Specta bindings.
 *
 * Operation:
 * Converts a Resource Monitor snapshot containing one available GPU metric with
 * two grouped GPU devices from the Tauri DTO shape into the frontend collection
 * shape.
 *
 * Expected:
 * The frontend preserves the GPU metric as available, converts decimal string
 * memory values into numbers, exposes each GPU device with label, compute
 * usage, and VRAM usage, and does not drop grouped GPU details before the UI
 * view model renders them.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { collectionFromSnapshotForTest } from "../src/lib/resources/runtime";
import { ResourceProviderPendingError } from "../src/lib/resources/store";
import type { ResourceMonitorSnapshot } from "../src/lib/bindings";

describe("Resource Monitor runtime snapshot normalization", () => {
  it("preserves CPU core details from Tauri snapshots", () => {
    const snapshot: ResourceMonitorSnapshot = {
      provider: "system commands on remote",
      collected_at_ms: "120000",
      metrics: [
        {
          metric: "cpu",
          status: "available",
          used: "0",
          total: "100",
          percent: 42,
          available: null,
          free: null,
          reason: null,
          cores: [12.5, 71.5],
          gpus: [],
          disks: [],
        },
      ],
    };

    const collection = collectionFromSnapshotForTest("tool-resources-1", snapshot);
    const cpu = collection.metrics.cpu;

    assert.equal(cpu?.status, "available");
    assert.deepEqual(cpu?.details?.cores, [
      { id: "0", label: "Core 0", percent: 12.5 },
      { id: "1", label: "Core 1", percent: 71.5 },
    ]);
  });

  it("preserves grouped GPU device details from Tauri snapshots", () => {
    const snapshot: ResourceMonitorSnapshot = {
      provider: "local provider",
      collected_at_ms: "120000",
      metrics: [
        {
          metric: "gpu",
          status: "available",
          used: String(3 * 1024 ** 3),
          total: String(8 * 1024 ** 3),
          percent: 42,
          available: null,
          free: String(5 * 1024 ** 3),
          reason: null,
          cores: [],
          gpus: [
            {
              id: "0",
              label: "NVIDIA RTX A4000",
              compute_percent: 10,
              compute_unavailable_reason: null,
              memory_used: String(1 * 1024 ** 3),
              memory_total: String(4 * 1024 ** 3),
            },
            {
              id: "1",
              label: "NVIDIA RTX 6000 Ada",
              compute_percent: 74,
              compute_unavailable_reason: null,
              memory_used: String(2 * 1024 ** 3),
              memory_total: String(4 * 1024 ** 3),
            },
          ],
          disks: [],
        },
      ],
    };

    const collection = collectionFromSnapshotForTest("tool-resources-1", snapshot);
    const gpu = collection.metrics.gpu;

    assert.equal(gpu?.status, "available");
    assert.deepEqual(gpu?.details?.gpus, [
      {
        id: "0",
        label: "NVIDIA RTX A4000",
        computePercent: 10,
        memoryUsed: 1 * 1024 ** 3,
        memoryTotal: 4 * 1024 ** 3,
      },
      {
        id: "1",
        label: "NVIDIA RTX 6000 Ada",
        computePercent: 74,
        memoryUsed: 2 * 1024 ** 3,
        memoryTotal: 4 * 1024 ** 3,
      },
    ]);
  });

  it("preserves Disk mount details from Tauri snapshots", () => {
    const snapshot: ResourceMonitorSnapshot = {
      provider: "system commands on remote",
      collected_at_ms: "120000",
      metrics: [
        {
          metric: "disk",
          status: "available",
          used: String(60 * 1024 ** 3),
          total: String(100 * 1024 ** 3),
          percent: 60,
          available: String(40 * 1024 ** 3),
          free: String(40 * 1024 ** 3),
          reason: null,
          cores: [],
          gpus: [],
          disks: [
            {
              id: "/",
              mount_point: "/",
              device_name: "/dev/nvme0n1p2",
              file_system: "ext4",
              used: String(60 * 1024 ** 3),
              total: String(100 * 1024 ** 3),
              available: String(40 * 1024 ** 3),
              percent: 60,
            },
          ],
        },
      ],
    };

    const collection = collectionFromSnapshotForTest("tool-resources-1", snapshot);
    const disk = collection.metrics.disk;

    assert.equal(disk?.status, "available");
    assert.deepEqual(disk?.details?.disks, [
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
    ]);
  });

  it("treats helper upload confirmation snapshots as pending instead of metric data", () => {
    const snapshot: ResourceMonitorSnapshot = {
      provider: "unavailable resource provider",
      collected_at_ms: "120000",
      metrics: ["cpu", "memory", "swap", "gpu"].map((metric) => ({
        metric: metric as ResourceMonitorSnapshot["metrics"][number]["metric"],
        status: "unavailable",
        used: null,
        total: null,
        percent: null,
        available: null,
        free: null,
        reason: "Waiting for Resource Monitor helper upload confirmation",
        cores: [],
        gpus: [],
        disks: [],
      })),
    };

    assert.throws(
      () => collectionFromSnapshotForTest("tool-resources-1", snapshot),
      ResourceProviderPendingError,
    );
  });
});
