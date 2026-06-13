import type { ResourceMetricId } from "$lib/resources/store";

export const defaultResourceMetricOrder: ResourceMetricId[] = ["cpu", "memory", "swap", "gpu"];

export function reorderResourceMetricOrder(
  order: readonly ResourceMetricId[],
  dragged: ResourceMetricId,
  target: ResourceMetricId,
): ResourceMetricId[] {
  if (dragged === target) {
    return [...order];
  }
  if (!order.includes(dragged)) {
    throw new Error(`dragged resource metric is not in the order: ${dragged}`);
  }
  if (!order.includes(target)) {
    throw new Error(`target resource metric is not in the order: ${target}`);
  }
  const withoutDragged = order.filter((metric) => metric !== dragged);
  const targetIndex = withoutDragged.indexOf(target);
  if (targetIndex === -1) {
    throw new Error(`target resource metric disappeared during reorder: ${target}`);
  }
  return [
    ...withoutDragged.slice(0, targetIndex),
    dragged,
    ...withoutDragged.slice(targetIndex),
  ];
}
