import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      vite: resolve(repoRoot, "tests/tauri/shared-vite-server.mjs"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/tauri/**/*.test.mjs"],
    globalSetup: ["tests/tauri/shared-vite-server-global-setup.mjs"],
    setupFiles: ["tests/tauri/parallel-port-env.mjs"],
    fileParallelism: true,
    maxConcurrency: 1,
    testTimeout: 180_000,
    hookTimeout: 180_000,
    pool: "forks",
    maxWorkers: Number(process.env.TAURI_TEST_MAX_WORKERS ?? "2"),
    minWorkers: 1,
  },
});
