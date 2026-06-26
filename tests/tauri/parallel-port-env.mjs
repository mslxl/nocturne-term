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
 * debug dev server unless the caller explicitly provided a custom URL. It also
 * retries only the known transient WebDriver session-creation failure where
 * msedgedriver reports that the WebView DevToolsActivePort file was not
 * created during parallel Tauri startup.
 *
 * Expected:
 * Parallel Tauri test workers do not race for the same tauri-driver or native
 * WebDriver port, and every launched debug Tauri application connects to the
 * same shared dev server URL baked into the debug app flow. A transient
 * DevToolsActivePort startup miss is retried without hiding real WebDriver
 * failures or application assertions. Explicit environment variables continue
 * to take precedence for focused local debugging.
 */
const workerId = Number(process.env.VITEST_WORKER_ID ?? process.env.VITEST_POOL_ID ?? "0");

if (!Number.isInteger(workerId) || workerId < 0) {
  throw new Error(`Vitest did not provide a usable worker id for Tauri port assignment: ${workerId}`);
}

const portOffset = workerId * 10;

process.env.TAURI_TEST_DRIVER_PORT ??= String(4444 + portOffset);
process.env.TAURI_TEST_NATIVE_DRIVER_PORT ??= String(9515 + portOffset);
process.env.TAURI_TEST_DEV_URL ??= "http://127.0.0.1:1420/";
process.env.NOCTURNE_DEV_PORT ??= String(new URL(process.env.TAURI_TEST_DEV_URL).port);

const fetchPatchKey = Symbol.for("nocturne.tauriTest.webdriverSessionRetry");
if (!globalThis[fetchPatchKey]) {
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    if (!isWebDriverSessionCreate(input, init)) return originalFetch(input, init);

    let lastResponse = null;
    for (const delayMs of [0, 500, 1_000, 1_500]) {
      if (delayMs > 0) await delay(delayMs);
      const response = await originalFetch(input, init);
      if (response.ok) return response;
      if (!(await isRetryableSessionCreationFailure(response))) return response;
      lastResponse = response;
    }

    if (!lastResponse) {
      throw new Error("WebDriver session creation retry exhausted without a response");
    }
    return lastResponse;
  };
  globalThis[fetchPatchKey] = true;
}

function isWebDriverSessionCreate(input, init) {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "POST") return false;
  const rawUrl = input instanceof Request ? input.url : String(input);
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return url.pathname === "/session";
}

async function isRetryableSessionCreationFailure(response) {
  let text = "";
  try {
    text = await response.clone().text();
  } catch {
    return false;
  }
  return text.includes("session not created") && text.includes("DevToolsActivePort file doesn't exist");
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
