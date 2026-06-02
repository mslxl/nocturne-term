import type { WorkspaceDockLayout } from "$lib/bindings";

export type WorkspaceDockResizeInput = {
  layout: WorkspaceDockLayout;
  splitPath: readonly number[];
  dividerIndex: number;
  deltaPixels: number;
  containerPixels: number;
  minChildPixels?: number;
};

export function resizeWorkspaceDockSplit(input: WorkspaceDockResizeInput): WorkspaceDockLayout {
  if (!Number.isFinite(input.deltaPixels)) throw new Error("dock resize delta must be finite");
  if (!Number.isFinite(input.containerPixels) || input.containerPixels <= 0) {
    throw new Error("dock resize container size must be positive");
  }
  const minChildPixels = input.minChildPixels ?? 96;
  if (!Number.isFinite(minChildPixels) || minChildPixels <= 0) {
    throw new Error("dock resize minimum child size must be positive");
  }
  return resizeAtPath(input.layout, input.splitPath, input, minChildPixels);
}

export function dockSplitGridTemplate(
  direction: "row" | "column",
  childCount: number,
  ratios: readonly (number | null)[],
  splitterPixels = 5,
): string {
  const normalized = normalizedWorkspaceRatios(childCount, ratios);
  const tracks = normalized.flatMap((ratio, index) => {
    const track = `minmax(0, ${Math.max(0.08, ratio)}fr)`;
    return index === normalized.length - 1 ? [track] : [track, `${splitterPixels}px`];
  });
  return direction === "row" ? `grid-template-columns: ${tracks.join(" ")};` : `grid-template-rows: ${tracks.join(" ")};`;
}

export function normalizedWorkspaceRatios(length: number, values: readonly (number | null)[]): number[] {
  const fallback = Array.from({ length }, () => 1 / Math.max(1, length));
  if (values.length !== length) return fallback;
  const numeric = values.map((value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0));
  const total = numeric.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return fallback;
  return numeric.map((value) => value / total);
}

function resizeAtPath(
  layout: WorkspaceDockLayout,
  splitPath: readonly number[],
  input: WorkspaceDockResizeInput,
  minChildPixels: number,
): WorkspaceDockLayout {
  if (layout.kind !== "split") throw new Error("dock resize path does not address a split");
  if (splitPath.length > 0) {
    const [childIndex, ...remainingPath] = splitPath;
    const child = layout.children[childIndex];
    if (!child) throw new Error(`dock resize split child ${childIndex} not found`);
    return {
      ...layout,
      children: layout.children.map((item, index) =>
        index === childIndex ? resizeAtPath(child, remainingPath, input, minChildPixels) : item,
      ),
    };
  }
  return resizeCurrentSplit(layout, input, minChildPixels);
}

function resizeCurrentSplit(
  layout: Extract<WorkspaceDockLayout, { kind: "split" }>,
  input: WorkspaceDockResizeInput,
  minChildPixels: number,
): WorkspaceDockLayout {
  const firstIndex = input.dividerIndex;
  const secondIndex = firstIndex + 1;
  if (firstIndex < 0 || secondIndex >= layout.children.length) {
    throw new Error(`dock resize divider ${input.dividerIndex} is outside split children`);
  }

  const ratios = normalizedWorkspaceRatios(layout.children.length, layout.ratios);
  const pixels = ratios.map((ratio) => ratio * input.containerPixels);
  const pairPixels = pixels[firstIndex] + pixels[secondIndex];
  const pairMin = Math.min(minChildPixels, pairPixels / 2);
  const nextFirst = clamp(pixels[firstIndex] + input.deltaPixels, pairMin, pairPixels - pairMin);
  pixels[firstIndex] = nextFirst;
  pixels[secondIndex] = pairPixels - nextFirst;
  const totalPixels = pixels.reduce((sum, value) => sum + value, 0);

  return {
    ...layout,
    ratios: pixels.map((value) => value / totalPixels),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
