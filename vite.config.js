import { defineConfig } from "vitest/config";
import { sveltekit } from "@sveltejs/kit/vite";
import Icons from "unplugin-icons/vite";

const tauriDevHost = process.env.TAURI_DEV_HOST;
const host = tauriDevHost ?? "127.0.0.1";
const port = Number(process.env.NOCTURNE_DEV_PORT ?? 1420);

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [sveltekit(), Icons({ compiler: "svelte" })],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port,
    strictPort: true,
    host,
    hmr: tauriDevHost
      ? {
          protocol: "ws",
          host: tauriDevHost,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["tests/tauri/**/*.test.mjs", "node_modules/**", "src-tauri/**"],
  },
}));
