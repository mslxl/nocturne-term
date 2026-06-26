/*
 * Test utility content:
 *
 * Feature:
 * Provides an isolated application configuration environment for Tauri tests
 * that launch the real Nocturne application through tauri-driver.
 *
 * Operation:
 * Creates a unique temporary directory for each test process and returns an
 * environment object with NOCTURNE_CONFIG_ROOT and WebView2 user data pointing
 * inside that temporary directory. The caller passes the environment to
 * tauri-driver so the launched application does not read or write the user's
 * persisted Workspace state. Cleanup also removes WebView2 scoped_dir*
 * temporary profile directories created during the test once their owner
 * process has exited.
 *
 * Expected:
 * Each Tauri test starts from a clean app configuration and WebView data root,
 * persisted Workspace layout from previous manual runs or tests is ignored, and
 * the temporary directories can be removed after the WebDriver session closes.
 */
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createIsolatedAppConfigEnv(name) {
  const existingScopedWebViewDirs = await listScopedWebViewTempDirs();
  const root = await mkdtemp(join(tmpdir(), `nocturne-tauri-${name}-`));
  const dirs = {
    NOCTURNE_CONFIG_ROOT: join(root, "nocturne-config"),
    WEBVIEW2_USER_DATA_FOLDER: join(root, "webview2-user-data"),
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
      await cleanupNewScopedWebViewTempDirs(existingScopedWebViewDirs);
    },
  };
}

async function cleanupNewScopedWebViewTempDirs(existingDirs) {
  const currentDirs = await listScopedWebViewTempDirs();
  for (const [dirName, dirPath] of currentDirs) {
    if (existingDirs.has(dirName)) continue;

    const ownerPid = getScopedDirOwnerPid(dirName);
    if (ownerPid === null || isProcessRunning(ownerPid)) continue;

    await rm(dirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function listScopedWebViewTempDirs() {
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  const scopedDirs = new Map();

  for (const entry of entries) {
    if (!entry.isDirectory() || getScopedDirOwnerPid(entry.name) === null) continue;

    const dirPath = join(tmpdir(), entry.name);
    if (await containsEbWebViewDir(dirPath)) {
      scopedDirs.set(entry.name, dirPath);
    }
  }

  return scopedDirs;
}

async function containsEbWebViewDir(dirPath) {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.some((entry) => entry.isDirectory() && entry.name === "EBWebView");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function getScopedDirOwnerPid(dirName) {
  const match = /^scoped_dir(\d+)_\d+$/.exec(dirName);
  if (!match) return null;

  const ownerPid = Number(match[1]);
  return Number.isSafeInteger(ownerPid) && ownerPid > 0 ? ownerPid : null;
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}
