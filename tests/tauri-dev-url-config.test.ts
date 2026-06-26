/*
 * Test content:
 *
 * Feature:
 * Verifies the Tauri development WebView URL configuration.
 *
 * Operation:
 * Reads the base Tauri config and the development overlay config.
 *
 * Expected:
 * Both configs keep the debug WebView pointed at the IPv4 loopback Vite URL so
 * Windows hosts that resolve localhost to IPv6 do not show connection-refused
 * pages while Vite is listening on 127.0.0.1.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Tauri dev URL config", () => {
  it("keeps base and dev-overlay WebView URLs on the Vite IPv4 loopback address", () => {
    const baseConfig = JSON.parse(readFileSync(resolve("src-tauri/tauri.conf.json"), "utf8"));
    const devConfig = JSON.parse(readFileSync(resolve("src-tauri/tauri.dev.conf.json"), "utf8"));

    assert.equal(baseConfig.build.devUrl, "http://127.0.0.1:1420");
    assert.equal(devConfig.build.beforeDevCommand, "pnpm dev");
    assert.equal(devConfig.build.devUrl, "http://127.0.0.1:1420");
  });
});
