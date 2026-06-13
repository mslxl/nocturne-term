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
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectionFromSnapshotForTest } from "../src/lib/resources/runtime";
import type { ResourceMonitorSnapshot } from "../src/lib/bindings";

describe("Resource Monitor runtime snapshot normalization", () => {
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
              memory_used: String(1 * 1024 ** 3),
              memory_total: String(4 * 1024 ** 3),
            },
            {
              id: "1",
              label: "NVIDIA RTX 6000 Ada",
              compute_percent: 74,
              memory_used: String(2 * 1024 ** 3),
              memory_total: String(4 * 1024 ** 3),
            },
          ],
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
});
