import type {
  ResourceCollection,
  ResourceMetric,
  ResourceMetricId,
} from "$lib/resources/store";
import { defaultResourceMetricOrder } from "$lib/resources/metric-order";

export type ResourceMonitorViewModel = {
  providerLabel: string;
  statusLabel: string;
  warning: string | null;
  rows: ResourceMetricRow[];
};

export type ResourceMetricRow = {
  id: string;
  metric: ResourceMetricId;
  label: string;
  status: "available" | "unavailable";
  primary: string;
  auxiliary: string;
  reason: string | null;
  collapsible: boolean;
  expanded: boolean;
  children: ResourceMetricChildRow[];
  history: ResourceMetricHistory | null;
};

export type ResourceMetricChildRow = {
  id: string;
  label: string;
  primary: string;
  auxiliary: string;
  history: ResourceMetricHistory | null;
};

export type ResourceMetricHistory = {
  points: number[];
  label: string;
};

export function buildResourceMonitorViewModel(input: {
  snapshot: ResourceCollection | null;
  expandedGroups: ReadonlySet<string>;
  historyForMetric?: (metric: ResourceMetricId) => ResourceMetric[];
  metricOrder?: readonly ResourceMetricId[];
  stale: boolean;
  warning: string | null;
}): ResourceMonitorViewModel {
  const metricOrder = input.metricOrder ?? defaultResourceMetricOrder;
  if (!input.snapshot) {
    return {
      providerLabel: "No provider",
      statusLabel: "Waiting for first sample",
      warning: input.warning,
      rows: metricOrder.map((metric) =>
        unavailableRow({
          metric,
          reason: "Collection has not started.",
          expandedGroups: input.expandedGroups,
        }),
      ),
    };
  }

  return {
    providerLabel: input.snapshot.provider,
    statusLabel: input.stale ? "Stale" : "",
    warning: input.warning,
    rows: metricOrder.map((metric) =>
      rowForMetric({
        metric,
        sample: input.snapshot?.metrics[metric] ?? null,
        expandedGroups: input.expandedGroups,
        historySamples: input.historyForMetric?.(metric) ?? [],
      }),
    ),
  };
}

function rowForMetric(input: {
  metric: ResourceMetricId;
  sample: ResourceMetric | null;
  expandedGroups: ReadonlySet<string>;
  historySamples: ResourceMetric[];
}): ResourceMetricRow {
  if (!input.sample) {
    return unavailableRow({
      metric: input.metric,
      reason: "Metric is unavailable.",
      expandedGroups: input.expandedGroups,
    });
  }
  if (input.sample.status === "unavailable") {
    return unavailableRow({
      metric: input.metric,
      reason: input.sample.reason,
      expandedGroups: input.expandedGroups,
    });
  }

  const children = childRows(input.sample, input.historySamples);
  const expanded = input.expandedGroups.has(input.metric);
  const history = historyForSamples(input.historySamples);
  return {
    id: input.metric,
    metric: input.metric,
    label: metricLabel(input.metric),
    status: "available",
    primary: `${formatPercent(input.sample.percent)}%`,
    auxiliary: auxiliaryText(input.sample),
    reason: null,
    collapsible: children.length > 0,
    expanded,
    children: expanded ? children : [],
    history,
  };
}

function unavailableRow(input: {
  metric: ResourceMetricId;
  reason: string;
  expandedGroups: ReadonlySet<string>;
}): ResourceMetricRow {
  return {
    id: input.metric,
    metric: input.metric,
    label: metricLabel(input.metric),
    status: "unavailable",
    primary: "Unavailable",
    auxiliary: "",
    reason: input.reason,
    collapsible: false,
    expanded: input.expandedGroups.has(input.metric),
    children: [],
    history: null,
  };
}

function historyForSamples(samples: ResourceMetric[]): ResourceMetricHistory {
  const points = samples
    .filter((sample): sample is Extract<ResourceMetric, { status: "available" }> => sample.status === "available")
    .map((sample) => sample.percent);
  return {
    points,
    label: "",
  };
}

function childRows(
  sample: Extract<ResourceMetric, { status: "available" }>,
  historySamples: ResourceMetric[],
): ResourceMetricChildRow[] {
  if (sample.metric === "cpu") {
    return (sample.details?.cores ?? []).map((core) => ({
      id: `cpu-core-${core.id}`,
      label: core.label,
      primary: `${formatPercent(core.percent)}%`,
      auxiliary: "",
      history: childHistoryForSamples(historySamples, (historySample) => {
        if (historySample.status !== "available" || historySample.metric !== "cpu") {
          return null;
        }
        return historySample.details?.cores?.find((historyCore) => historyCore.id === core.id)?.percent ?? null;
      }),
    }));
  }
  if (sample.metric === "gpu") {
    return (sample.details?.gpus ?? []).map((gpu) => ({
      id: `gpu-${gpu.id}`,
      label: gpu.label,
      primary: `${formatPercent(gpu.computePercent)}% compute`,
      auxiliary: `${formatBytes(gpu.memoryUsed)} / ${formatBytes(gpu.memoryTotal)} VRAM`,
      history: childHistoryForSamples(historySamples, (historySample) => {
        if (historySample.status !== "available" || historySample.metric !== "gpu") {
          return null;
        }
        return historySample.details?.gpus?.find((historyGpu) => historyGpu.id === gpu.id)?.computePercent ?? null;
      }),
    }));
  }
  return [];
}

function childHistoryForSamples(
  samples: ResourceMetric[],
  pointForSample: (sample: ResourceMetric) => number | null,
): ResourceMetricHistory {
  const points = samples
    .map(pointForSample)
    .filter((point): point is number => point !== null);
  return {
    points,
    label: "",
  };
}

function auxiliaryText(sample: Extract<ResourceMetric, { status: "available" }>): string {
  if (sample.metric === "cpu") {
    const coreCount = sample.details?.cores?.length ?? 0;
    return coreCount > 0 ? `${coreCount} ${coreCount === 1 ? "core" : "cores"}` : "";
  }
  if (sample.metric === "gpu") {
    const gpuCount = sample.details?.gpus?.length ?? 0;
    return gpuCount > 0 ? `${gpuCount} ${gpuCount === 1 ? "GPU" : "GPUs"}` : `${formatBytes(sample.used)} / ${formatBytes(sample.total)}`;
  }
  const secondary = sample.available !== undefined
    ? `available ${formatBytes(sample.available)}`
    : sample.free !== undefined
      ? `free ${formatBytes(sample.free)}`
      : "";
  return [`${formatBytes(sample.used)} / ${formatBytes(sample.total)}`, secondary].filter(Boolean).join(", ");
}

function metricLabel(metric: ResourceMetricId): string {
  switch (metric) {
    case "cpu":
      return "CPU";
    case "memory":
      return "Memory";
    case "swap":
      return "Swap";
    case "gpu":
      return "GPU";
  }
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unitIndex = 0;
  while (Math.abs(value) >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(1);
  const unit = units[unitIndex];
  if (!unit) {
    throw new Error(`missing byte unit for index ${unitIndex}`);
  }
  return `${formatted} ${unit}`;
}
