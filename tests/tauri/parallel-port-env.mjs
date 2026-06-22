/*
 * Test utility content:
 *
 * Feature:
 * Assigns non-overlapping default WebDriver ports to parallel Tauri WebView
 * test workers while keeping the Tauri dev server URL shared.
 *
 * Operation:
 * Reads the Vitest worker identifier before each Tauri test file is evaluated,
 * fills TAURI_TEST_DRIVER_PORT and TAURI_TEST_NATIVE_DRIVER_PORT from a
 * per-worker port block, and keeps TAURI_TEST_DEV_URL on the single shared
 * debug dev server unless the caller explicitly provided a custom URL.
 *
 * Expected:
 * Parallel Tauri test workers do not race for the same tauri-driver or native
 * WebDriver port, and every launched debug Tauri application connects to the
 * same shared dev server URL baked into the debug app flow. Explicit
 * environment variables continue to take precedence for focused local
 * debugging.
 */
const workerId = Number(process.env.VITEST_WORKER_ID ?? process.env.VITEST_POOL_ID ?? "0");

if (!Number.isInteger(workerId) || workerId < 0) {
  throw new Error(`Vitest did not provide a usable worker id for Tauri port assignment: ${workerId}`);
}

const portOffset = workerId * 10;

process.env.TAURI_TEST_DRIVER_PORT ??= String(4444 + portOffset);
process.env.TAURI_TEST_NATIVE_DRIVER_PORT ??= String(9515 + portOffset);
process.env.TAURI_TEST_DEV_URL ??= "http://localhost:1420/";
process.env.NOCTURNE_DEV_PORT ??= String(new URL(process.env.TAURI_TEST_DEV_URL).port);
