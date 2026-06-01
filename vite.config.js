import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import Icons from "unplugin-icons/vite";

const host = process.env.TAURI_DEV_HOST;
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
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
