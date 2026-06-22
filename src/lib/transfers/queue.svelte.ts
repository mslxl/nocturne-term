import { listen } from "@tauri-apps/api/event";
import { commands, type TransferQueueSnapshot } from "$lib/bindings";
import { hasTauriRuntime } from "$lib/tauri/runtime";
import { unwrapCommand } from "$lib/terminal/commands";

type TransferQueueChangedEvent = {
  version: number;
  snapshot: TransferQueueSnapshot;
};

type TauriInternals = {
  invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
};

const transferQueueChangedEvent = "transfer://changed";

class TransferQueueState {
  snapshot = $state<TransferQueueSnapshot | null>(null);
  loading = $state(false);
  error = $state("");
}

export const transferQueueState = new TransferQueueState();
let running = false;
let refreshing = false;
let refreshInterval = 0;
let runtimeProbeInterval = 0;
let unlisten: (() => void) | null = null;

export function startTransferQueueObserver(): () => void {
  let stopped = false;

  const startRuntime = () => {
    if (stopped || running || !hasTauriRuntime()) return false;
    running = true;
    transferQueueState.loading = !transferQueueState.snapshot;
    void refreshTransferQueue();
    refreshInterval = window.setInterval(() => {
      void refreshTransferQueue();
    }, 2_000);
    void listen<TransferQueueChangedEvent>(transferQueueChangedEvent, (event) => {
      transferQueueState.snapshot = event.payload.snapshot;
      transferQueueState.loading = false;
      transferQueueState.error = "";
    })
      .then((dispose) => {
        if (stopped) {
          dispose();
          return;
        }
        unlisten = dispose;
      })
      .catch((listenError) => {
        transferQueueState.error = listenError instanceof Error ? listenError.message : String(listenError);
        transferQueueState.loading = false;
      });
    return true;
  };

  if (!startRuntime()) {
    runtimeProbeInterval = window.setInterval(() => {
      if (startRuntime()) window.clearInterval(runtimeProbeInterval);
    }, 100);
  }

  return () => {
    stopped = true;
    running = false;
    refreshing = false;
    window.clearInterval(refreshInterval);
    window.clearInterval(runtimeProbeInterval);
    unlisten?.();
    unlisten = null;
  };
}

export async function refreshTransferQueue() {
  if (refreshing || !hasTauriRuntime()) return;
  refreshing = true;
  if (!transferQueueState.snapshot) transferQueueState.loading = true;
  transferQueueState.error = "";
  try {
    transferQueueState.snapshot = await readTransferQueueSnapshot();
  } catch (refreshError) {
    transferQueueState.error = refreshError instanceof Error ? refreshError.message : String(refreshError);
  } finally {
    refreshing = false;
    transferQueueState.loading = false;
  }
}

async function readTransferQueueSnapshot(): Promise<TransferQueueSnapshot> {
  const internals = (window as Window & { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  if (internals?.invoke) {
    return assertTransferQueueSnapshot(await internals.invoke("get_transfer_queue_snapshot"));
  }
  return await unwrapCommand(commands.getTransferQueueSnapshot());
}

function assertTransferQueueSnapshot(value: unknown): TransferQueueSnapshot {
  if (!value || typeof value !== "object") {
    throw new Error("transfer queue snapshot response is not an object");
  }
  const nextSnapshot = value as Partial<TransferQueueSnapshot>;
  if (typeof nextSnapshot.version !== "number" || !Array.isArray(nextSnapshot.tasks)) {
    throw new Error("transfer queue snapshot response has an invalid shape");
  }
  return nextSnapshot as TransferQueueSnapshot;
}
