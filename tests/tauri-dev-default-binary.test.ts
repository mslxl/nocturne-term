/*
 * Test content:
 *
 * Feature:
 * Verifies the Tauri debug development flow selects the Nocturne app binary
 * when the crate also contains helper binaries.
 *
 * Operation:
 * Reads the Rust package manifest and checks that the package declares the
 * default binary used by `cargo run` during `pnpm tauri dev`.
 *
 * Expected:
 * The manifest sets `default-run` to `nocturne` so adding helper binaries such
 * as `nocturne-resource-monitor-agent` does not make the Tauri debug flow ambiguous.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Tauri dev default binary", () => {
  it("declares the app binary as the Cargo default run target", () => {
    const manifest = readFileSync(resolve("src-tauri/Cargo.toml"), "utf8");

    assert.match(manifest, /^\s*default-run\s*=\s*"nocturne"\s*$/m);
  });
});
