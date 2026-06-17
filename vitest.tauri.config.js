import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/tauri/**/*.test.mjs"],
    fileParallelism: false,
    maxConcurrency: 1,
    testTimeout: 180_000,
    hookTimeout: 180_000,
    pool: "forks",
    maxWorkers: 1,
    minWorkers: 1,
  },
});
