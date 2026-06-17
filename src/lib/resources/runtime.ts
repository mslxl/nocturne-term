import {
  commands,
  type ResourceMonitorMetric,
  type ResourceMonitorSnapshot,
} from "$lib/bindings";
import { hasTauriRuntime } from "$lib/tauri/runtime";
import { unwrapCommand } from "$lib/terminal/commands";
import {
  createResourceMonitorStore,
  ResourceProviderPendingError,
  type ResourceCollection,
  type ResourceAvailableMetric,
  type ResourceMetric,
  type ResourceMetricId,
  type ResourceMonitorState,
  type ResourceMonitorStore,
  type ResourceTickResult,
} from "$lib/resources/store";

export type ResourceMonitorViewScope = {
  viewId: string;
  workspaceId: string;
  ownerToolTabId: string;
  visible: boolean;
};

const ownerScopes = new Map<string, { workspaceId: string; ownerToolTabId: string }>();

const store = createResourceMonitorStore({
  provider: {
    collect: async ({ ownerToolTabId, signal }) => {
      const scope = ownerScopes.get(ownerToolTabId);
      if (!scope) {
        throw new Error(`resource monitor owner ${ownerToolTabId} is not registered`);
      }
      if (!hasTauriRuntime()) {
        throw new Error("Resource Monitor requires the Tauri runtime");
      }
      if (signal.aborted) {
        throw new Error("Resource collection was aborted before it started");
      }
      const snapshot = await unwrapCommand(
        commands.collectResourceMonitorSnapshot({
          workspace_id: scope.workspaceId,
          tool_tab_id: scope.ownerToolTabId,
        }),
      );
      if (signal.aborted) {
        throw new Error("Resource collection was aborted");
      }
      return collectionFromSnapshot(ownerToolTabId, snapshot);
    },
  },
});

export function registerResourceMonitorView(scope: ResourceMonitorViewScope): ResourceMonitorState {
  ownerScopes.set(scope.ownerToolTabId, {
    workspaceId: scope.workspaceId,
    ownerToolTabId: scope.ownerToolTabId,
  });
  store.setViewVisibility(scope);
  return store.stateForOwner(scope.ownerToolTabId);
}

export function unregisterResourceMonitorView(viewId: string): void {
  store.unregisterView(viewId);
}

export function resourceMonitorStateForOwner(ownerToolTabId: string): ResourceMonitorState {
  return store.stateForOwner(ownerToolTabId);
}

export function resourceMonitorHistoryForView(viewId: string, metric: ResourceMetricId): ResourceMetric[] {
  return store.historyForView(viewId, metric);
}

export function beginResourceMonitorProviderSwitch(ownerToolTabId: string): ResourceMonitorState {
  store.beginProviderSwitch(ownerToolTabId);
  return store.stateForOwner(ownerToolTabId);
}

export function endResourceMonitorProviderSwitch(ownerToolTabId: string): ResourceMonitorState {
  store.endProviderSwitch(ownerToolTabId);
  return store.stateForOwner(ownerToolTabId);
}

export async function tickResourceMonitorView(viewId: string): Promise<ResourceTickResult> {
  return store.tickForView(viewId);
}

export function resourceMonitorStoreForTest(): ResourceMonitorStore {
  return store;
}

function collectionFromSnapshot(
  ownerToolTabId: string,
  snapshot: ResourceMonitorSnapshot,
): ResourceCollection {
  const pendingReason = resourceHelperUploadPendingReason(snapshot);
  if (pendingReason) {
    throw new ResourceProviderPendingError(pendingReason);
  }
  return {
    ownerToolTabId,
    provider: snapshot.provider,
    collectedAtMs: numberFromDecimalString(snapshot.collected_at_ms, "collected_at_ms"),
    metrics: Object.fromEntries(
      snapshot.metrics.map((metric) => [metric.metric, metricFromSnapshotMetric(metric)]),
    ) as ResourceCollection["metrics"],
  };
}

const RESOURCE_HELPER_UPLOAD_PENDING_REASON = "Waiting for Resource Monitor helper upload confirmation";

function resourceHelperUploadPendingReason(snapshot: ResourceMonitorSnapshot): string | null {
  if (snapshot.provider !== "unavailable resource provider" || snapshot.metrics.length === 0) {
    return null;
  }
  const reasons = snapshot.metrics.map((metric) => metric.reason);
  if (reasons.every((reason) => reason === RESOURCE_HELPER_UPLOAD_PENDING_REASON)) {
    return RESOURCE_HELPER_UPLOAD_PENDING_REASON;
  }
  return null;
}

export function collectionFromSnapshotForTest(
  ownerToolTabId: string,
  snapshot: ResourceMonitorSnapshot,
): ResourceCollection {
  return collectionFromSnapshot(ownerToolTabId, snapshot);
}

function metricFromSnapshotMetric(metric: ResourceMonitorMetric): ResourceMetric {
  const collectedAtMs = Date.now();
  const metricId = metric.metric as ResourceMetricId;
  if (metric.status === "unavailable") {
    if (!metric.reason) {
      throw new Error(`unavailable resource metric ${metric.metric} is missing reason`);
    }
    return {
      metric: metricId,
      status: "unavailable",
      reason: metric.reason,
      collectedAtMs,
    };
  }
  if (metric.status !== "available") {
    throw new Error(`unsupported resource metric status: ${metric.status}`);
  }
  if (metric.percent === null || metric.used === null || metric.total === null) {
    throw new Error(`available resource metric ${metric.metric} is missing numeric fields`);
  }
  return {
    metric: metricId,
    status: "available",
    percent: metric.percent,
    used: numberFromDecimalString(metric.used, `${metric.metric}.used`),
    total: numberFromDecimalString(metric.total, `${metric.metric}.total`),
    available: metric.available === null ? undefined : numberFromDecimalString(metric.available, `${metric.metric}.available`),
    free: metric.free === null ? undefined : numberFromDecimalString(metric.free, `${metric.metric}.free`),
    collectedAtMs,
    details: detailsFromSnapshotMetric(metric),
  };
}

function detailsFromSnapshotMetric(metric: ResourceMonitorMetric): ResourceAvailableMetric["details"] {
  const metricWithDisk = metric as ResourceMonitorMetric & {
    disks?: Array<{
      id: string;
      mount_point: string;
      device_name: string;
      file_system: string;
      used: string;
      total: string;
      available: string;
      percent: number;
    }>;
  };
  if (metric.metric === "cpu" && metric.cores.length > 0) {
    return {
      cores: metric.cores.map((percent, index) => {
        if (percent === null) {
          throw new Error(`resource metric cpu.cores[${index}] is null`);
        }
        return {
          id: String(index),
          label: `Core ${index}`,
          percent,
        };
      }),
    };
  }
  if (metric.metric === "gpu" && metric.gpus.length > 0) {
    return {
      gpus: metric.gpus.map((gpu, index) => {
        const gpuWithReason = gpu as typeof gpu & { compute_unavailable_reason?: string | null };
        const sample = {
          id: gpu.id,
          label: gpu.label,
          computePercent: gpu.compute_percent,
          memoryUsed: numberFromDecimalString(gpu.memory_used, `gpu.devices[${index}].memory_used`),
          memoryTotal: numberFromDecimalString(gpu.memory_total, `gpu.devices[${index}].memory_total`),
        };
        if (gpuWithReason.compute_unavailable_reason) {
          return {
            ...sample,
            computeUnavailableReason: gpuWithReason.compute_unavailable_reason,
          };
        }
        return sample;
      }),
    };
  }
  if (metric.metric === "disk" && (metricWithDisk.disks?.length ?? 0) > 0) {
    return {
      disks: metricWithDisk.disks!.map((disk, index) => {
        if (disk.percent === null) {
          throw new Error(`resource metric disk.mounts[${index}].percent is null`);
        }
        return {
          id: disk.id,
          mountPoint: disk.mount_point,
          deviceName: disk.device_name,
          fileSystem: disk.file_system,
          used: numberFromDecimalString(disk.used, `disk.mounts[${index}].used`),
          total: numberFromDecimalString(disk.total, `disk.mounts[${index}].total`),
          available: numberFromDecimalString(disk.available, `disk.mounts[${index}].available`),
          percent: disk.percent,
        };
      }),
    };
  }
  return undefined;
}

function numberFromDecimalString(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`resource metric ${label} must be a decimal string`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`resource metric ${label} is outside the frontend display range`);
  }
  return parsed;
}
