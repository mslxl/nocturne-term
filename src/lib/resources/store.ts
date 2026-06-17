export const RESOURCE_PROVIDER_TIMEOUT_MS = 5_000;
export const RESOURCE_STALE_FAILURE_THRESHOLD = 3;
export const RESOURCE_HISTORY_RETENTION_MS = 5 * 60 * 1_000;
export const RESOURCE_HISTORY_MAX_SAMPLES = 300;

export type ResourceMetricId = "cpu" | "memory" | "swap" | "gpu" | "disk";

export type ResourceAvailableMetric = {
  metric: ResourceMetricId;
  status: "available";
  percent: number;
  used: number;
  total: number;
  available?: number;
  free?: number;
  collectedAtMs: number;
  details?: ResourceMetricDetails;
};

export type ResourceUnavailableMetric = {
  metric: ResourceMetricId;
  status: "unavailable";
  reason: string;
  collectedAtMs: number;
};

export type ResourceMetric = ResourceAvailableMetric | ResourceUnavailableMetric;

export type ResourceMetricDetails = {
  cores?: ResourceCpuCoreSample[];
  gpus?: ResourceGpuDeviceSample[];
  disks?: ResourceDiskMountSample[];
};

export type ResourceCpuCoreSample = {
  id: string;
  label: string;
  percent: number;
};

export type ResourceGpuDeviceSample = {
  id: string;
  label: string;
  computePercent: number | null;
  computeUnavailableReason?: string;
  memoryUsed: number;
  memoryTotal: number;
};

export type ResourceDiskMountSample = {
  id: string;
  mountPoint: string;
  deviceName: string;
  fileSystem: string;
  used: number;
  total: number;
  available: number;
  percent: number;
};

export type ResourceMetricMap = Partial<Record<ResourceMetricId, ResourceMetric>>;

export type ResourceCollection = {
  ownerToolTabId: string;
  provider: string;
  collectedAtMs: number;
  metrics: ResourceMetricMap;
};

export type ResourceCollectInput = {
  ownerToolTabId: string;
  signal: AbortSignal;
};

export type ResourceProvider = {
  collect(input: ResourceCollectInput): Promise<ResourceCollection>;
};

export type ResourceMonitorState = {
  ownerToolTabId: string;
  latest: ResourceCollection | null;
  inFlight: boolean;
  providerSwitchInProgress: boolean;
  consecutiveFailures: number;
  stale: boolean;
  warning: string | null;
  lastError: Error | null;
};

export type ResourceTickResult =
  | { kind: "collected"; ownerToolTabId: string; collection: ResourceCollection }
  | { kind: "skipped_in_flight"; ownerToolTabId: string }
  | { kind: "skipped_not_visible"; ownerToolTabId: string }
  | { kind: "skipped_provider_switch"; ownerToolTabId: string }
  | { kind: "skipped_provider_pending"; ownerToolTabId: string; reason: string }
  | { kind: "failed"; ownerToolTabId: string; error: Error };

type ResourceViewRegistration = {
  viewId: string;
  ownerToolTabId: string;
  visible: boolean;
};

type InternalOwnerState = ResourceMonitorState & {
  inFlightPromise: Promise<ResourceTickResult> | null;
  history: Map<ResourceMetricId, ResourceMetric[]>;
};

export type ResourceMonitorStore = {
  readonly timeoutMs: number;
  setViewVisibility(registration: ResourceViewRegistration): void;
  unregisterView(viewId: string): void;
  visibleOwnerToolTabIds(): string[];
  stateForOwner(ownerToolTabId: string): ResourceMonitorState;
  beginProviderSwitch(ownerToolTabId: string): void;
  endProviderSwitch(ownerToolTabId: string): void;
  tickForView(viewId: string): Promise<ResourceTickResult>;
  tickForOwner(ownerToolTabId: string): Promise<ResourceTickResult>;
  tickVisibleOwners(): Promise<ResourceTickResult[]>;
  historyForMetric(ownerToolTabId: string, metric: ResourceMetricId): ResourceMetric[];
  historyForView(viewId: string, metric: ResourceMetricId): ResourceMetric[];
};

export class ResourceProviderPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceProviderPendingError";
  }
}

export function createResourceMonitorStore(options: {
  provider: ResourceProvider;
  timeoutMs?: number;
}): ResourceMonitorStore {
  const timeoutMs = options.timeoutMs ?? RESOURCE_PROVIDER_TIMEOUT_MS;
  const views = new Map<string, ResourceViewRegistration>();
  const owners = new Map<string, InternalOwnerState>();

  function ownerState(ownerToolTabId: string): InternalOwnerState {
    const existing = owners.get(ownerToolTabId);
    if (existing) {
      return existing;
    }
    const created: InternalOwnerState = {
      ownerToolTabId,
      latest: null,
      inFlight: false,
      providerSwitchInProgress: false,
      inFlightPromise: null,
      history: new Map(),
      consecutiveFailures: 0,
      stale: false,
      warning: null,
      lastError: null,
    };
    owners.set(ownerToolTabId, created);
    return created;
  }

  function hasVisibleView(ownerToolTabId: string): boolean {
    for (const view of views.values()) {
      if (view.ownerToolTabId === ownerToolTabId && view.visible) {
        return true;
      }
    }
    return false;
  }

  async function tickForOwner(ownerToolTabId: string): Promise<ResourceTickResult> {
    const state = ownerState(ownerToolTabId);
    if (!hasVisibleView(ownerToolTabId)) {
      return { kind: "skipped_not_visible", ownerToolTabId };
    }
    if (state.providerSwitchInProgress) {
      return { kind: "skipped_provider_switch", ownerToolTabId };
    }
    if (state.inFlightPromise) {
      return { kind: "skipped_in_flight", ownerToolTabId };
    }

    state.inFlight = true;
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    const providerPromise = options.provider.collect({ ownerToolTabId, signal: controller.signal });
    providerPromise.catch(() => {
      // Prevent a late provider rejection after timeout from surfacing as an unhandled rejection.
    });

    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        reject(new Error(`Resource collection timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    const firstResultPromise = Promise.race([providerPromise, timeout])
      .then((collection) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        return applyCollection(state, ownerToolTabId, collection);
      })
      .catch((error: unknown) => handleCollectionError(state, ownerToolTabId, error));

    state.inFlightPromise = providerPromise
      .then((collection) => {
        if (timedOut) {
          return applyCollection(state, ownerToolTabId, collection);
        }
        return { kind: "collected", ownerToolTabId, collection } satisfies ResourceTickResult;
      })
      .catch((error: unknown) => {
        if (timedOut) {
          return handleCollectionError(state, ownerToolTabId, error);
        }
        return { kind: "failed", ownerToolTabId, error: normalizeError(error) } satisfies ResourceTickResult;
      })
      .finally(() => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        state.inFlight = false;
        state.inFlightPromise = null;
      });

    return firstResultPromise;
  }

  return {
    timeoutMs,
    setViewVisibility(registration) {
      views.set(registration.viewId, { ...registration });
      ownerState(registration.ownerToolTabId);
    },
    unregisterView(viewId) {
      views.delete(viewId);
    },
    visibleOwnerToolTabIds() {
      const ownerIds = new Set<string>();
      for (const view of views.values()) {
        if (view.visible) {
          ownerIds.add(view.ownerToolTabId);
        }
      }
      return [...ownerIds];
    },
    stateForOwner(ownerToolTabId) {
      const state = ownerState(ownerToolTabId);
      return {
        ownerToolTabId: state.ownerToolTabId,
        latest: state.latest,
        inFlight: state.inFlight,
        providerSwitchInProgress: state.providerSwitchInProgress,
        consecutiveFailures: state.consecutiveFailures,
        stale: state.stale,
        warning: state.warning,
        lastError: state.lastError,
      };
    },
    beginProviderSwitch(ownerToolTabId) {
      const state = ownerState(ownerToolTabId);
      state.providerSwitchInProgress = true;
      state.latest = null;
      state.history.clear();
      state.consecutiveFailures = 0;
      state.stale = false;
      state.warning = null;
      state.lastError = null;
    },
    endProviderSwitch(ownerToolTabId) {
      ownerState(ownerToolTabId).providerSwitchInProgress = false;
    },
    tickForView(viewId) {
      const view = views.get(viewId);
      if (!view) {
        throw new Error(`resource monitor view ${viewId} is not registered`);
      }
      return tickForOwner(view.ownerToolTabId);
    },
    tickForOwner,
    tickVisibleOwners() {
      return Promise.all(this.visibleOwnerToolTabIds().map((ownerToolTabId) => tickForOwner(ownerToolTabId)));
    },
    historyForMetric(ownerToolTabId, metric) {
      return [...(ownerState(ownerToolTabId).history.get(metric) ?? [])];
    },
    historyForView(viewId, metric) {
      const view = views.get(viewId);
      if (!view) {
        throw new Error(`resource monitor view ${viewId} is not registered`);
      }
      return [...(ownerState(view.ownerToolTabId).history.get(metric) ?? [])];
    },
  };
}

function applyCollection(
  state: InternalOwnerState,
  ownerToolTabId: string,
  collection: ResourceCollection,
): ResourceTickResult {
  if (collection.ownerToolTabId !== ownerToolTabId) {
    throw new Error(
      `resource provider returned owner ${collection.ownerToolTabId} for ${ownerToolTabId}`,
    );
  }
  state.latest = collection;
  appendHistory(state, collection);
  state.consecutiveFailures = 0;
  state.stale = false;
  state.warning = null;
  state.lastError = null;
  return { kind: "collected", ownerToolTabId, collection };
}

function handleCollectionError(
  state: InternalOwnerState,
  ownerToolTabId: string,
  error: unknown,
): ResourceTickResult {
  if (error instanceof ResourceProviderPendingError) {
    return {
      kind: "skipped_provider_pending",
      ownerToolTabId,
      reason: error.message,
    };
  }
  const normalizedError = normalizeError(error);
  state.consecutiveFailures += 1;
  state.lastError = normalizedError;
  if (state.latest && state.consecutiveFailures >= RESOURCE_STALE_FAILURE_THRESHOLD) {
    state.stale = true;
    state.warning = `Resource data is stale after ${state.consecutiveFailures} consecutive collection failures.`;
  }
  return { kind: "failed", ownerToolTabId, error: normalizedError };
}

function appendHistory(state: InternalOwnerState, collection: ResourceCollection): void {
  const cutoffMs = collection.collectedAtMs - RESOURCE_HISTORY_RETENTION_MS;
  for (const metric of Object.values(collection.metrics)) {
    if (!metric) {
      continue;
    }
    const existing = state.history.get(metric.metric) ?? [];
    const next = [...existing, metric]
      .filter((sample) => sample.collectedAtMs >= cutoffMs)
      .slice(-RESOURCE_HISTORY_MAX_SAMPLES);
    state.history.set(metric.metric, next);
  }
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}
