/*
 * Test utility content:
 *
 * Feature:
 * Provides an isolated application configuration environment for Tauri tests
 * that launch the real Nocturne application through tauri-driver.
 *
 * Operation:
 * Creates a unique temporary directory for each test process and returns an
 * environment object with NOCTURNE_CONFIG_ROOT pointing inside that temporary
 * directory. The caller passes the environment to tauri-driver so the launched
 * application does not read or write the user's persisted Workspace state.
 *
 * Expected:
 * Each Tauri test starts from a clean app configuration root, persisted
 * Workspace layout from previous manual runs or tests is ignored, and the
 * temporary directory can be removed after the WebDriver session closes.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createIsolatedAppConfigEnv(name) {
  const root = await mkdtemp(join(tmpdir(), `nocturne-tauri-${name}-`));
  const dirs = {
    NOCTURNE_CONFIG_ROOT: join(root, "nocturne-config"),
  };

  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })));

  return {
    root,
    env: {
      ...process.env,
      ...dirs,
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
