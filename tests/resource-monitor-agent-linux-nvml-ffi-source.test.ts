/*
 * Test content:
 *
 * Feature:
 * Verifies the standalone Resource Monitor agent's Linux NVML FFI string
 * buffer uses Rust's target-specific `c_char` type.
 *
 * Operation:
 * Reads the helper source without compiling for a platform-specific binary and
 * inspects the NVML `device_name` implementation.
 *
 * Expected:
 * The NVML name buffer is declared as `[c_char; 96]` instead of `[i8; 96]`,
 * so Linux targets where `c_char` is unsigned, such as aarch64 musl, compile
 * the `nvmlDeviceGetName` and `CStr::from_ptr` calls without pointer type
 * mismatches.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Resource Monitor agent Linux NVML FFI source", () => {
  it("uses c_char for the NVML device name buffer", () => {
    const source = readFileSync(resolve("crates/nocturne-resource-monitor-agent/src/lib.rs"), "utf8");
    const start = source.indexOf("unsafe fn device_name(");
    const end = source.indexOf("unsafe fn device_utilization(", start);

    assert.notEqual(start, -1);
    assert.notEqual(end, -1);

    const deviceName = source.slice(start, end);
    assert.match(deviceName, /let mut buffer = \[0 as c_char; 96\]/);
    assert.doesNotMatch(deviceName, /\[0_i8; 96\]/);
  });
});
