export type SplitDirection = "row" | "column";
export type SplitSide = "left" | "right" | "up" | "down";
export type PaneDropZone = SplitSide | "center";

export type PaneLeaf = {
  kind: "leaf";
  paneId: string;
};

export type PaneSplitNode = {
  kind: "split";
  direction: SplitDirection;
  children: PaneTree[];
  ratios: number[];
};

export type PaneTree = PaneLeaf | PaneSplitNode;

export type PaneBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PaneLayoutItem = {
  paneId: string;
  bounds: PaneBounds;
};

export type SplitterLayoutItem = {
  id: string;
  direction: SplitDirection;
  firstPaneId: string;
  secondPaneId: string;
  bounds: PaneBounds;
};

export type SplitterResizeInput = {
  tree: PaneTree;
  firstPaneId: string;
  secondPaneId: string;
  deltaPixels: number;
  containerPixels: number;
  minFirstPixels: number;
  minSecondPixels: number;
};

export function createPaneLeaf(paneId: string): PaneLeaf {
  assertPaneId(paneId);
  return { kind: "leaf", paneId };
}

export function countPaneLeaves(tree: PaneTree): number {
  if (tree.kind === "leaf") return 1;
  return tree.children.reduce((total, child) => total + countPaneLeaves(child), 0);
}

export function listPaneIds(tree: PaneTree): string[] {
  if (tree.kind === "leaf") return [tree.paneId];
  return tree.children.flatMap((child) => listPaneIds(child));
}

export function clonePaneTree(tree: PaneTree): PaneTree {
  if (tree.kind === "leaf") return { kind: "leaf", paneId: tree.paneId };
  return {
    kind: "split",
    direction: tree.direction,
    children: tree.children.map((child) => clonePaneTree(child)),
    ratios: [...tree.ratios],
  };
}

export function firstPaneId(tree: PaneTree): string {
  if (tree.kind === "leaf") return tree.paneId;
  const first = tree.children[0];
  if (!first) throw new Error("split node has no first pane");
  return firstPaneId(first);
}

export function lastPaneId(tree: PaneTree): string {
  if (tree.kind === "leaf") return tree.paneId;
  const last = tree.children.at(-1);
  if (!last) throw new Error("split node has no last pane");
  return lastPaneId(last);
}

export function hasPane(tree: PaneTree, paneId: string): boolean {
  if (tree.kind === "leaf") return tree.paneId === paneId;
  return tree.children.some((child) => hasPane(child, paneId));
}

export function splitPane(tree: PaneTree, targetPaneId: string, newPaneId: string, side: SplitSide): PaneTree {
  assertPaneId(newPaneId);
  if (!hasPane(tree, targetPaneId)) {
    throw new Error(`pane ${targetPaneId} not found`);
  }
  if (hasPane(tree, newPaneId)) {
    throw new Error(`pane ${newPaneId} already exists`);
  }
  return splitPaneRecursive(tree, targetPaneId, newPaneId, side);
}

export function removePane(tree: PaneTree, paneId: string): PaneTree | null {
  if (!hasPane(tree, paneId)) {
    throw new Error(`pane ${paneId} not found`);
  }
  if (tree.kind === "leaf") return null;
  return collapseSingleChild(removePaneRecursive(tree, paneId));
}

export function replacePane(tree: PaneTree, targetPaneId: string, nextPaneId: string): PaneTree {
  assertPaneId(nextPaneId);
  if (!hasPane(tree, targetPaneId)) {
    throw new Error(`pane ${targetPaneId} not found`);
  }
  if (targetPaneId !== nextPaneId && hasPane(tree, nextPaneId)) {
    throw new Error(`pane ${nextPaneId} already exists`);
  }
  if (tree.kind === "leaf") {
    return tree.paneId === targetPaneId ? createPaneLeaf(nextPaneId) : tree;
  }
  return {
    ...tree,
    children: tree.children.map((child) => replacePane(child, targetPaneId, nextPaneId)),
  };
}

export function swapPanes(tree: PaneTree, firstPaneId: string, secondPaneId: string): PaneTree {
  if (firstPaneId === secondPaneId) return tree;
  if (!hasPane(tree, firstPaneId)) {
    throw new Error(`pane ${firstPaneId} not found`);
  }
  if (!hasPane(tree, secondPaneId)) {
    throw new Error(`pane ${secondPaneId} not found`);
  }
  return mapPaneLeaves(tree, (paneId) => {
    if (paneId === firstPaneId) return secondPaneId;
    if (paneId === secondPaneId) return firstPaneId;
    return paneId;
  });
}

export function movePaneIntoSplit(
  tree: PaneTree,
  movingPaneId: string,
  targetPaneId: string,
  side: SplitSide,
): PaneTree {
  if (movingPaneId === targetPaneId) return tree;
  if (!hasPane(tree, movingPaneId)) {
    throw new Error(`pane ${movingPaneId} not found`);
  }
  if (!hasPane(tree, targetPaneId)) {
    throw new Error(`pane ${targetPaneId} not found`);
  }
  const withoutMoving = removePane(tree, movingPaneId);
  if (!withoutMoving) return createPaneLeaf(movingPaneId);
  return splitPaneAllowExisting(withoutMoving, targetPaneId, movingPaneId, side);
}

export function normalizeRatios(ratios: number[]): number[] {
  if (!ratios.length) {
    throw new Error("split ratios cannot be empty");
  }
  if (ratios.some((ratio) => !Number.isFinite(ratio) || ratio <= 0)) {
    throw new Error("split ratios must be positive finite numbers");
  }
  const total = ratios.reduce((sum, ratio) => sum + ratio, 0);
  return ratios.map((ratio) => ratio / total);
}

export function deriveTabDisplayTitle(activePaneTitle: string, paneCount: number): string {
  const title = activePaneTitle.trim();
  if (!title) {
    throw new Error("active pane title cannot be empty");
  }
  if (paneCount < 1 || !Number.isInteger(paneCount)) {
    throw new Error(`pane count must be a positive integer: ${paneCount}`);
  }
  return paneCount === 1 ? title : `${title} | ${paneCount} panes`;
}

export function resizeAdjacentPanes(input: SplitterResizeInput): PaneTree {
  if (!Number.isFinite(input.deltaPixels)) {
    throw new Error("resize delta must be finite");
  }
  if (!Number.isFinite(input.containerPixels) || input.containerPixels <= 0) {
    throw new Error("container size must be positive");
  }
  if (input.minFirstPixels < 0 || input.minSecondPixels < 0) {
    throw new Error("minimum pane sizes must be non-negative");
  }
  const result = resizeAdjacentRecursive(input.tree, input);
  if (!result.changed) {
    throw new Error(`adjacent panes ${input.firstPaneId} and ${input.secondPaneId} not found`);
  }
  return result.tree;
}

export function layoutPaneTree(
  tree: PaneTree,
  bounds: PaneBounds,
  splitterSize = 5,
): { panes: PaneLayoutItem[]; splitters: SplitterLayoutItem[] } {
  if (bounds.width < 0 || bounds.height < 0) {
    throw new Error("layout bounds cannot be negative");
  }
  if (splitterSize < 0) {
    throw new Error("splitter size cannot be negative");
  }
  const panes: PaneLayoutItem[] = [];
  const splitters: SplitterLayoutItem[] = [];
  collectLayout(tree, bounds, splitterSize, panes, splitters);
  return { panes, splitters };
}

function splitPaneRecursive(tree: PaneTree, targetPaneId: string, newPaneId: string, side: SplitSide): PaneTree {
  if (tree.kind === "leaf") {
    if (tree.paneId !== targetPaneId) return tree;
    const direction = side === "left" || side === "right" ? "row" : "column";
    const before = side === "left" || side === "up";
    return {
      kind: "split",
      direction,
      children: before ? [createPaneLeaf(newPaneId), tree] : [tree, createPaneLeaf(newPaneId)],
      ratios: [0.5, 0.5],
    };
  }

  const childIndex = tree.children.findIndex((child) => hasPane(child, targetPaneId));
  if (childIndex === -1) return tree;
  const direction = side === "left" || side === "right" ? "row" : "column";
  if (tree.direction === direction && tree.children[childIndex]?.kind === "leaf") {
    return insertSibling(tree, childIndex, newPaneId, side);
  }
  return {
    ...tree,
    children: tree.children.map((child, index) =>
      index === childIndex ? splitPaneRecursive(child, targetPaneId, newPaneId, side) : child,
    ),
  };
}

function splitPaneAllowExisting(tree: PaneTree, targetPaneId: string, paneId: string, side: SplitSide): PaneTree {
  if (!hasPane(tree, targetPaneId)) {
    throw new Error(`pane ${targetPaneId} not found`);
  }
  if (hasPane(tree, paneId)) {
    throw new Error(`pane ${paneId} already exists`);
  }
  return splitPaneRecursive(tree, targetPaneId, paneId, side);
}

function mapPaneLeaves(tree: PaneTree, map: (paneId: string) => string): PaneTree {
  if (tree.kind === "leaf") return createPaneLeaf(map(tree.paneId));
  return {
    ...tree,
    children: tree.children.map((child) => mapPaneLeaves(child, map)),
  };
}

function insertSibling(tree: PaneSplitNode, targetIndex: number, newPaneId: string, side: SplitSide): PaneSplitNode {
  const insertBefore = side === "left" || side === "up";
  const insertIndex = insertBefore ? targetIndex : targetIndex + 1;
  const children = [...tree.children];
  children.splice(insertIndex, 0, createPaneLeaf(newPaneId));

  const targetRatio = tree.ratios[targetIndex];
  if (targetRatio == null) {
    throw new Error(`missing ratio for child ${targetIndex}`);
  }
  const ratios = [...tree.ratios];
  ratios[targetIndex] = targetRatio / 2;
  ratios.splice(insertIndex, 0, targetRatio / 2);
  return { ...tree, children, ratios: normalizeRatios(ratios) };
}

function removePaneRecursive(tree: PaneTree, paneId: string): PaneTree | null {
  if (tree.kind === "leaf") {
    return tree.paneId === paneId ? null : tree;
  }

  const children: PaneTree[] = [];
  const ratios: number[] = [];
  for (let index = 0; index < tree.children.length; index += 1) {
    const child = tree.children[index];
    if (!child) {
      throw new Error(`missing child at index ${index}`);
    }
    const next = removePaneRecursive(child, paneId);
    if (!next) continue;
    children.push(next);
    const ratio = tree.ratios[index];
    if (ratio == null) {
      throw new Error(`missing ratio for child ${index}`);
    }
    ratios.push(ratio);
  }

  if (!children.length) return null;
  return collapseSingleChild({
    ...tree,
    children,
    ratios: normalizeRatios(ratios),
  });
}

function collapseSingleChild(tree: PaneTree | null): PaneTree | null {
  if (!tree || tree.kind === "leaf") return tree;
  if (tree.children.length === 1) {
    const only = tree.children[0];
    if (!only) throw new Error("split node has no child to collapse");
    return collapseSingleChild(only);
  }
  return {
    ...tree,
    children: tree.children.map((child) => {
      const collapsed = collapseSingleChild(child);
      if (!collapsed) {
        throw new Error("cannot collapse an inner child to empty");
      }
      return collapsed;
    }),
    ratios: normalizeRatios(tree.ratios),
  };
}

function resizeAdjacentRecursive(
  tree: PaneTree,
  input: SplitterResizeInput,
): { tree: PaneTree; changed: boolean } {
  if (tree.kind === "leaf") return { tree, changed: false };

  for (let index = 0; index < tree.children.length - 1; index += 1) {
    const first = tree.children[index];
    const second = tree.children[index + 1];
    if (!first || !second) {
      throw new Error(`missing adjacent children at index ${index}`);
    }
    if (lastPaneId(first) === input.firstPaneId && firstPaneId(second) === input.secondPaneId) {
      return { tree: resizeChildPair(tree, index, input), changed: true };
    }
  }

  const children: PaneTree[] = [];
  let changed = false;
  for (const child of tree.children) {
    if (changed) {
      children.push(child);
      continue;
    }
    const result = resizeAdjacentRecursive(child, input);
    changed = result.changed;
    children.push(result.tree);
  }
  return { tree: changed ? { ...tree, children } : tree, changed };
}

function resizeChildPair(tree: PaneSplitNode, firstIndex: number, input: SplitterResizeInput): PaneSplitNode {
  const secondIndex = firstIndex + 1;
  const firstRatio = tree.ratios[firstIndex];
  const secondRatio = tree.ratios[secondIndex];
  if (firstRatio == null || secondRatio == null) {
    throw new Error("missing ratio for adjacent resize");
  }
  const pairRatio = firstRatio + secondRatio;
  const firstPixels = firstRatio * input.containerPixels;
  const secondPixels = secondRatio * input.containerPixels;
  const pairPixels = firstPixels + secondPixels;
  const maxFirst = pairPixels - input.minSecondPixels;
  const nextFirst = Math.min(Math.max(firstPixels + input.deltaPixels, input.minFirstPixels), maxFirst);
  const nextSecond = pairPixels - nextFirst;
  if (nextFirst <= 0 || nextSecond <= 0) {
    throw new Error("minimum pane sizes exceed available space");
  }
  const ratios = [...tree.ratios];
  ratios[firstIndex] = (nextFirst / pairPixels) * pairRatio;
  ratios[secondIndex] = (nextSecond / pairPixels) * pairRatio;
  return { ...tree, ratios: normalizeRatios(ratios) };
}

function collectLayout(
  tree: PaneTree,
  bounds: PaneBounds,
  splitterSize: number,
  panes: PaneLayoutItem[],
  splitters: SplitterLayoutItem[],
) {
  if (tree.kind === "leaf") {
    panes.push({ paneId: tree.paneId, bounds });
    return;
  }

  const ratios = normalizeRatios(tree.ratios);
  const horizontal = tree.direction === "row";
  const total = horizontal ? bounds.width : bounds.height;
  const available = Math.max(0, total - splitterSize * (tree.children.length - 1));
  let cursor = horizontal ? bounds.x : bounds.y;

  tree.children.forEach((child, index) => {
    const isLast = index === tree.children.length - 1;
    const size = isLast
      ? horizontal
        ? bounds.x + bounds.width - cursor
        : bounds.y + bounds.height - cursor
      : available * ratios[index];
    const childBounds = horizontal
      ? { x: cursor, y: bounds.y, width: size, height: bounds.height }
      : { x: bounds.x, y: cursor, width: bounds.width, height: size };
    collectLayout(child, childBounds, splitterSize, panes, splitters);
    cursor += size;
    if (!isLast) {
      const next = tree.children[index + 1];
      if (!next) throw new Error(`missing child after index ${index}`);
      splitters.push({
        id: `${lastPaneId(child)}:${firstPaneId(next)}`,
        direction: tree.direction,
        firstPaneId: lastPaneId(child),
        secondPaneId: firstPaneId(next),
        bounds: horizontal
          ? { x: cursor, y: bounds.y, width: splitterSize, height: bounds.height }
          : { x: bounds.x, y: cursor, width: bounds.width, height: splitterSize },
      });
      cursor += splitterSize;
    }
  });
}

function assertPaneId(paneId: string) {
  if (!paneId.trim()) {
    throw new Error("pane id cannot be empty");
  }
}
