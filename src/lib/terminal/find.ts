export type TerminalFindOptions = {
  caseSensitive: boolean;
  regex: boolean;
};

export type TerminalFindMatch = {
  lineEnd: number;
  lineStart: number;
  matchEnd: number;
  matchStart: number;
  text: string;
};

export type TerminalFindSnapshot = {
  activeIndex: number;
  error: string;
  matches: TerminalFindMatch[];
};

export type TerminalFindSearchKey = {
  caseSensitive: boolean;
  paneId: string;
  query: string;
  regex: boolean;
};

export type TerminalBufferLineLike = {
  isWrapped?: boolean;
  translateToString: (trimRight?: boolean) => string;
};

export type TerminalLike = {
  buffer: {
    active: {
      getLine: (index: number) => TerminalBufferLineLike | undefined;
      length: number;
    };
  };
  getSelectionPosition?: () => TerminalSelectionPosition | undefined;
};

type TerminalSelectionPosition = {
  start: {
    x: number;
    y: number;
  };
};

type LogicalLine = {
  lineEnd: number;
  lineStart: number;
  segments: Array<{
    offset: number;
    row: number;
  }>;
  text: string;
};

export function terminalFindSnapshot(
  terminal: TerminalLike,
  query: string,
  options: TerminalFindOptions,
): TerminalFindSnapshot {
  if (query.length === 0) return { activeIndex: 0, error: "", matches: [] };
  const pattern = compilePattern(query, options);
  if (!pattern.ok) return { activeIndex: 0, error: pattern.error, matches: [] };

  const logicalLines = terminalLogicalLines(terminal);
  const matches = logicalLines.flatMap((line) => matchesInLine(line, pattern.pattern));
  return {
    activeIndex: activeMatchIndex(terminal, logicalLines, matches),
    error: "",
    matches,
  };
}

export function terminalLogicalLineAtSelection(terminal: TerminalLike): string {
  const selection = terminal.getSelectionPosition?.();
  if (!selection) return "";
  const row = selection.start.y;
  const logicalLine = terminalLogicalLines(terminal).find(
    (line) => row >= line.lineStart && row <= line.lineEnd,
  );
  return logicalLine?.text.trimEnd() ?? "";
}

export function terminalFindSearchKeyChanged(
  previous: TerminalFindSearchKey | null,
  next: TerminalFindSearchKey,
): boolean {
  return (
    previous === null ||
    previous.paneId !== next.paneId ||
    previous.query !== next.query ||
    previous.caseSensitive !== next.caseSensitive ||
    previous.regex !== next.regex
  );
}

function terminalLogicalLines(terminal: TerminalLike): LogicalLine[] {
  const lines: LogicalLine[] = [];
  const buffer = terminal.buffer.active;
  let row = 0;
  while (row < buffer.length) {
    const line = buffer.getLine(row);
    if (!line) {
      row += 1;
      continue;
    }
    if (line.isWrapped && row > 0) {
      row += 1;
      continue;
    }

    const lineStart = row;
    const segmentRows = [row];
    while (row + 1 < buffer.length && buffer.getLine(row + 1)?.isWrapped) {
      row += 1;
      segmentRows.push(row);
    }

    let text = "";
    const segments: LogicalLine["segments"] = [];
    for (const segmentRow of segmentRows) {
      const segment = buffer.getLine(segmentRow);
      if (!segment) throw new Error(`terminal buffer line ${segmentRow} disappeared while collecting find text`);
      segments.push({ offset: text.length, row: segmentRow });
      text += segment.translateToString(segmentRow === segmentRows[segmentRows.length - 1]);
    }

    lines.push({ lineEnd: segmentRows[segmentRows.length - 1], lineStart, segments, text });
    row += 1;
  }
  return lines;
}

function compilePattern(
  query: string,
  options: TerminalFindOptions,
): { ok: true; pattern: RegExp } | { ok: false; error: string } {
  const flags = options.caseSensitive ? "g" : "gi";
  if (options.regex) {
    try {
      return { ok: true, pattern: new RegExp(query, flags) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Invalid regular expression" };
    }
  }
  return { ok: true, pattern: new RegExp(escapeRegExp(query), flags) };
}

function matchesInLine(line: LogicalLine, pattern: RegExp): TerminalFindMatch[] {
  const matches: TerminalFindMatch[] = [];
  pattern.lastIndex = 0;
  for (;;) {
    const match = pattern.exec(line.text);
    if (!match) break;
    const matchText = match[0];
    matches.push({
      lineEnd: line.lineEnd,
      lineStart: line.lineStart,
      matchEnd: match.index + matchText.length,
      matchStart: match.index,
      text: line.text,
    });
    if (matchText.length === 0) pattern.lastIndex += 1;
    if (pattern.lastIndex > line.text.length) break;
  }
  return matches;
}

function activeMatchIndex(
  terminal: TerminalLike,
  logicalLines: LogicalLine[],
  matches: TerminalFindMatch[],
): number {
  if (matches.length === 0) return 0;
  const selection = terminal.getSelectionPosition?.();
  if (!selection) return 1;
  const selectedLine = logicalLines.find(
    (line) => selection.start.y >= line.lineStart && selection.start.y <= line.lineEnd,
  );
  if (!selectedLine) return 1;
  const selectedOffset = selectionOffset(selectedLine, selection.start.y, selection.start.x);
  const index = matches.findIndex(
    (match) =>
      match.lineStart === selectedLine.lineStart &&
      match.lineEnd === selectedLine.lineEnd &&
      selectedOffset >= match.matchStart &&
      selectedOffset < match.matchEnd,
  );
  return index === -1 ? 1 : index + 1;
}

function selectionOffset(line: LogicalLine, row: number, column: number): number {
  const segment = line.segments.find((item) => item.row === row);
  if (!segment) throw new Error(`selection row ${row} is not part of logical line ${line.lineStart}`);
  return segment.offset + column;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
