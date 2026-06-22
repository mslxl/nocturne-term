/*
 * Test utility content:
 *
 * Feature:
 * Starts one shared Vite development server for the Tauri WebView test run.
 *
 * Operation:
 * Before Vitest workers execute Tauri tests, resolves the repository root,
 * starts Vite on TAURI_TEST_DEV_URL or the default debug URL, and keeps it
 * alive until the complete Tauri test run finishes. If a caller already has a
 * compatible dev server running on that URL, the setup reuses it.
 *
 * Expected:
 * Parallel Tauri test workers all connect their debug Tauri application to the
 * same reachable dev server instead of racing to create and close per-test Vite
 * servers, preventing intermittent localhost connection-refused pages.
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

export default async function setupSharedViteServer() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const devUrl = process.env.TAURI_TEST_DEV_URL ?? "http://localhost:1420/";
  const devPort = Number(new URL(devUrl).port);

  if (!Number.isInteger(devPort) || devPort <= 0) {
    throw new Error(`TAURI_TEST_DEV_URL must include a valid port for Tauri tests: ${devUrl}`);
  }

  process.env.TAURI_TEST_DEV_URL = devUrl;
  process.env.NOCTURNE_DEV_PORT = String(devPort);

  if (await devServerResponds(devUrl)) {
    return async () => undefined;
  }

  const vitePath = require.resolve("vite", { paths: [repoRoot] });
  const { createServer } = await import(pathToFileURL(vitePath).href);
  const devServer = await createServer({
    server: {
      host: "localhost",
      port: devPort,
      strictPort: true,
    },
    envDir: repoRoot,
    logLevel: "silent",
  });

  await devServer.listen();
  await waitForDevServer(devUrl);

  return async () => {
    await devServer.close();
  };
}

async function waitForDevServer(devUrl) {
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    if (await devServerResponds(devUrl)) return;
    await delay(250);
  }
  throw new Error(`Shared Vite dev server did not become reachable at ${devUrl}`);
}

async function devServerResponds(devUrl) {
  try {
    const response = await fetch(devUrl);
    return response.ok;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
