import type { TerminalFitSize } from "./sizes";

export type TerminalMirrorViewMeasurement = TerminalFitSize & {
  id: string;
  visible: boolean;
  mounted: boolean;
  fitted: boolean;
};

export type TerminalMirrorPtySizeInput = {
  views: TerminalMirrorViewMeasurement[];
  lastValidSize: TerminalFitSize;
  lastSentSize: TerminalFitSize;
  minimum?: {
    cols: number;
    rows: number;
  };
};

export type TerminalMirrorPtySizeResult = {
  size: TerminalFitSize;
  participantIds: string[];
  tooSmallViewIds: string[];
  constrainingViewIds: string[];
  shouldSendResize: boolean;
};

export const defaultTerminalMirrorMinimum = {
  cols: 20,
  rows: 6,
} as const;

export function computeTerminalMirrorPtySize(input: TerminalMirrorPtySizeInput): TerminalMirrorPtySizeResult {
  const minimum = input.minimum ?? defaultTerminalMirrorMinimum;
  const mountedViews = input.views.filter((view) => view.visible && view.mounted && view.fitted);
  const tooSmallViewIds = mountedViews
    .filter((view) => view.cols < minimum.cols || view.rows < minimum.rows)
    .map((view) => view.id);
  const participants = mountedViews.filter((view) => view.cols >= minimum.cols && view.rows >= minimum.rows);
  if (participants.length === 0) {
    return {
      size: input.lastValidSize,
      participantIds: [],
      tooSmallViewIds,
      constrainingViewIds: [],
      shouldSendResize: false,
    };
  }

  const cols = Math.min(...participants.map((view) => view.cols));
  const rows = Math.min(...participants.map((view) => view.rows));
  const pixelWidth = Math.min(...participants.filter((view) => view.cols === cols).map((view) => view.pixelWidth));
  const pixelHeight = Math.min(...participants.filter((view) => view.rows === rows).map((view) => view.pixelHeight));
  const constrainingViewIds = participants
    .filter((view) => view.cols === cols || view.rows === rows)
    .map((view) => view.id);
  const size = { cols, rows, pixelWidth, pixelHeight };

  return {
    size,
    participantIds: participants.map((view) => view.id),
    tooSmallViewIds,
    constrainingViewIds,
    shouldSendResize:
      input.lastSentSize.cols !== size.cols ||
      input.lastSentSize.rows !== size.rows ||
      input.lastSentSize.pixelWidth !== size.pixelWidth ||
      input.lastSentSize.pixelHeight !== size.pixelHeight,
  };
}
