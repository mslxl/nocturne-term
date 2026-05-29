export type TerminalScrollbarState = {
  visible: boolean;
  thumbSizePercent: number;
  scrollPercent: number;
  scrollbackRows: number;
};

type TerminalScrollbarInput = {
  baseY: number;
  viewportY: number;
  rows: number;
};

export type TerminalWheelDeltaInput = {
  deltaY: number;
  deltaMode: number;
  rows: number;
  previousRemainder: number;
};

export type TerminalWheelDeltaResult = {
  lines: number;
  remainder: number;
};

export type TerminalWheelScrollInput = TerminalWheelDeltaInput & {
  baseY: number;
  viewportY: number;
  normalBuffer: boolean;
  mouseTracking: boolean;
  defaultPrevented: boolean;
  shiftKey: boolean;
};

export type TerminalWheelScrollResult = {
  consume: boolean;
  target: number | null;
  remainder: number;
};

const wheelDeltaModePixel = 0;
const wheelDeltaModeLine = 1;
const wheelDeltaModePage = 2;

export function terminalScrollbarState(input: TerminalScrollbarInput): TerminalScrollbarState {
  const rows = Math.max(1, Math.trunc(input.rows));
  const scrollbackRows = Math.max(0, Math.trunc(input.baseY));
  const viewportY = Math.max(0, Math.min(scrollbackRows, Math.trunc(input.viewportY)));
  const totalRows = rows + scrollbackRows;
  const visible = scrollbackRows > 0;

  if (!visible) {
    return {
      visible: false,
      thumbSizePercent: 1,
      scrollPercent: 0,
      scrollbackRows: 0,
    };
  }

  return {
    visible: true,
    thumbSizePercent: Math.max(0, Math.min(1, rows / totalRows)),
    scrollPercent: Math.max(0, Math.min(1, viewportY / scrollbackRows)),
    scrollbackRows,
  };
}

export function terminalScrollbarLineFromPointer(input: {
  pointerY: number;
  trackTop: number;
  trackHeight: number;
  thumbHeight: number;
  scrollbackRows: number;
}): number {
  const scrollbackRows = Math.max(0, Math.trunc(input.scrollbackRows));
  if (scrollbackRows === 0) return 0;
  const travel = Math.max(1, input.trackHeight - input.thumbHeight);
  const centeredPointerY = input.pointerY - input.trackTop - input.thumbHeight / 2;
  const percent = Math.max(0, Math.min(1, centeredPointerY / travel));
  return Math.round(percent * scrollbackRows);
}

export function terminalWheelDeltaToLines(input: TerminalWheelDeltaInput): TerminalWheelDeltaResult {
  if (!Number.isFinite(input.deltaY) || input.deltaY === 0) {
    return { lines: 0, remainder: input.previousRemainder };
  }

  const rows = Math.max(1, Math.trunc(input.rows));
  const normalizedDelta =
    input.deltaMode === wheelDeltaModePage
      ? input.deltaY * Math.max(1, rows - 1)
      : input.deltaMode === wheelDeltaModeLine
        ? input.deltaY
        : input.deltaMode === wheelDeltaModePixel
          ? input.deltaY / 16
          : input.deltaY / 16;
  const rawLines = input.previousRemainder + normalizedDelta;
  const lines = rawLines < 0 ? Math.ceil(rawLines) : Math.floor(rawLines);
  return {
    lines,
    remainder: rawLines - lines,
  };
}

export function terminalWheelScrollResult(input: TerminalWheelScrollInput): TerminalWheelScrollResult {
  if (
    input.defaultPrevented ||
    input.deltaY === 0 ||
    input.shiftKey ||
    !input.normalBuffer ||
    input.mouseTracking
  ) {
    return {
      consume: false,
      target: null,
      remainder: input.previousRemainder,
    };
  }

  const result = terminalWheelDeltaToLines(input);
  const before = Math.max(0, Math.trunc(input.viewportY));
  const baseY = Math.max(0, Math.trunc(input.baseY));
  if (result.lines === 0) {
    return {
      consume: true,
      target: null,
      remainder: result.remainder,
    };
  }

  const target = Math.max(0, Math.min(baseY, before + result.lines));
  return {
    consume: true,
    target: target === before ? null : target,
    remainder: result.remainder,
  };
}
