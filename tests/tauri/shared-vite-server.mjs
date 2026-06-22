/*
 * Test utility content:
 *
 * Feature:
 * Provides a Vite createServer-compatible adapter for parallel Tauri WebView
 * tests.
 *
 * Operation:
 * Replaces per-test Vite server creation with a lightweight handle whose
 * listen operation waits for the shared global Tauri test dev server and whose
 * close operation intentionally leaves that shared server alive for other
 * workers.
 *
 * Expected:
 * Existing Tauri test files can continue to call createServer(), listen(), and
 * close(), while parallel workers do not stop the dev server out from under
 * other running Tauri windows.
 */
export async function createServer(options = {}) {
  const devUrl = process.env.TAURI_TEST_DEV_URL ?? "http://localhost:1420/";
  const devPort = Number(new URL(devUrl).port);
  const requestedPort = options.server?.port;

  if (requestedPort !== undefined && requestedPort !== devPort) {
    throw new Error(
      `Tauri WebView tests must use the shared dev server port ${devPort}; received ${requestedPort}`,
    );
  }

  return {
    async listen() {
      await waitForDevServer(devUrl);
      return this;
    },
    async close() {
      return undefined;
    },
  };
}

async function waitForDevServer(devUrl) {
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    try {
      const response = await fetch(devUrl);
      if (response.ok) return;
    } catch {
      // The global setup owns startup; individual tests only wait for it.
    }
    await delay(250);
  }
  throw new Error(`Shared Tauri test dev server was not reachable at ${devUrl}`);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
