export type TerminalFitSize = {
  cols: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
};

export type TerminalSessionSize = {
  cols: number | null | undefined;
  rows: number | null | undefined;
  pixel_width: number | null | undefined;
  pixel_height: number | null | undefined;
};

export const defaultTerminalFitSize: TerminalFitSize = {
  cols: 80,
  rows: 24,
  pixelWidth: 1,
  pixelHeight: 1,
};

const minCols = 2;
const maxCols = 500;
const minRows = 1;
const maxRows = 300;
const minPixels = 1;
const maxPixels = 65535;

export function normalizeTerminalFitSize(
  size: TerminalFitSize,
  fallback: TerminalFitSize = defaultTerminalFitSize,
): TerminalFitSize {
  return {
    cols: normalizeDimension(size.cols, minCols, maxCols, fallback.cols),
    rows: normalizeDimension(size.rows, minRows, maxRows, fallback.rows),
    pixelWidth: normalizeDimension(size.pixelWidth, minPixels, maxPixels, fallback.pixelWidth),
    pixelHeight: normalizeDimension(size.pixelHeight, minPixels, maxPixels, fallback.pixelHeight),
  };
}

export function normalizeTerminalSessionSize(
  size: TerminalSessionSize,
  fallback: TerminalFitSize = defaultTerminalFitSize,
): TerminalFitSize {
  return normalizeTerminalFitSize(
    {
      cols: size.cols as number,
      rows: size.rows as number,
      pixelWidth: size.pixel_width as number,
      pixelHeight: size.pixel_height as number,
    },
    fallback,
  );
}

export function toTerminalSessionSizeInput(size: TerminalFitSize) {
  const normalized = normalizeTerminalFitSize(size);
  return {
    cols: normalized.cols,
    rows: normalized.rows,
    pixel_width: normalized.pixelWidth,
    pixel_height: normalized.pixelHeight,
  };
}

function normalizeDimension(
  value: number | null | undefined,
  min: number,
  max: number,
  fallback: number | null | undefined,
): number {
  if (!Number.isFinite(value)) {
    return normalizeDimension(Number.isFinite(fallback) ? fallback : min, min, max, min);
  }
  return Math.min(Math.max(Math.round(value as number), min), max);
}
