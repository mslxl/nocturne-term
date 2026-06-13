/*
 * Test content:
 *
 * Feature:
 * Verifies the local Rust Resource Monitor GPU provider implementation.
 *
 * Operation:
 * Reads the local GPU collection function source without executing platform
 * binaries or relying on machine-specific GPU hardware.
 *
 * Expected:
 * The local provider does not launch vendor or system command wrappers such as
 * `nvidia-smi` or PowerShell. Local GPU collection must use in-process provider
 * code, and the Windows provider must use PDH plus DXGI APIs instead of
 * shelling out.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Resource Monitor local GPU provider source", () => {
  it("does not collect local GPU metrics by shelling out to vendor commands", () => {
    const source = readFileSync(resolve("src-tauri/src/resources.rs"), "utf8");
    const start = source.indexOf("fn collect_local_gpu_metric()");
    const end = source.indexOf("fn normalize_gpu_devices_metric", start);

    assert.notEqual(start, -1);
    assert.notEqual(end, -1);

    const localGpuProvider = source.slice(start, end);
    assert.doesNotMatch(localGpuProvider, /Command::new/);
    assert.doesNotMatch(localGpuProvider, /nvidia-smi/);
    assert.doesNotMatch(localGpuProvider, /powershell/i);
    assert.match(source, /PdhAddEnglishCounterW/);
    assert.match(source, /PdhGetFormattedCounterArrayW/);
    assert.match(source, /CreateDXGIFactory1/);
  });
});
