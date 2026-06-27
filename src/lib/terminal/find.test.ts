import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  clearTerminalFindEffects,
  terminalFindSearchKeyChanged,
  terminalFindSnapshot,
  terminalLogicalLineAtSelection,
  type TerminalBufferLineLike,
  type TerminalLike,
} from "./find";

describe("terminal find", () => {
  it("finds literal matches case-insensitively by default", () => {
    const term = terminal(["Alpha beta", "alpha again"]);

    const snapshot = terminalFindSnapshot(term, "alpha", { caseSensitive: false, regex: false });

    assert.equal(snapshot.error, "");
    assert.deepEqual(
      snapshot.matches.map((match) => [match.lineStart, match.matchStart, match.matchEnd]),
      [
        [0, 0, 5],
        [1, 0, 5],
      ],
    );
    assert.equal(snapshot.activeIndex, 1);
  });

  it("honors case-sensitive search", () => {
    const term = terminal(["Alpha beta", "alpha again"]);

    const snapshot = terminalFindSnapshot(term, "alpha", { caseSensitive: true, regex: false });

    assert.equal(snapshot.matches.length, 1);
    assert.equal(snapshot.matches[0].text, "alpha again");
  });

  it("treats regex as line-oriented and reports invalid patterns", () => {
    const term = terminal(["build 124", "build abc", "unload"]);

    const valid = terminalFindSnapshot(term, "build \\d+", { caseSensitive: false, regex: true });
    const dotPattern = terminalFindSnapshot(term, "unlo.d", { caseSensitive: false, regex: true });
    const invalid = terminalFindSnapshot(term, "build [", { caseSensitive: false, regex: true });

    assert.equal(valid.matches.length, 1);
    assert.equal(valid.matches[0].text, "build 124");
    assert.equal(dotPattern.matches.length, 1);
    assert.equal(dotPattern.matches[0].text, "unload");
    assert.match(invalid.error, /regular expression|unterminated|invalid/i);
    assert.equal(invalid.matches.length, 0);
  });

  it("returns the logical wrapped line at the active selection", () => {
    const term = terminal(
      [
        { text: "very long command ", wrapped: false },
        { text: "continued output", wrapped: true },
      ],
      { row: 1, column: 3 },
    );

    assert.equal(terminalLogicalLineAtSelection(term), "very long command continued output");
  });

  it("uses active selection to derive the current match index from xterm's zero-based selection", () => {
    const term = terminal(["alpha beta alpha"], { row: 0, column: 11 });

    const snapshot = terminalFindSnapshot(term, "alpha", { caseSensitive: false, regex: false });

    assert.equal(snapshot.matches.length, 2);
    assert.equal(snapshot.activeIndex, 2);
  });

  it("requires a fresh xterm search when query options change", () => {
    const previous = { sessionId: "session-1", query: "Unload", caseSensitive: false, regex: false };

    assert.equal(
      terminalFindSearchKeyChanged(previous, { sessionId: "session-1", query: "Unload", caseSensitive: true, regex: false }),
      true,
    );
    assert.equal(
      terminalFindSearchKeyChanged(previous, { sessionId: "session-1", query: "ulo.d", caseSensitive: false, regex: true }),
      true,
    );
    assert.equal(
      terminalFindSearchKeyChanged(previous, { sessionId: "session-1", query: "Unload", caseSensitive: false, regex: false }),
      false,
    );
  });

  it("clears both search decorations and the xterm selection on close", () => {
    let decorationsCleared = 0;
    let selectionCleared = 0;

    clearTerminalFindEffects({
      search: {
        clearDecorations: () => {
          decorationsCleared += 1;
        },
      },
      term: {
        clearSelection: () => {
          selectionCleared += 1;
        },
      },
    });

    assert.equal(decorationsCleared, 1);
    assert.equal(selectionCleared, 1);
  });
});

function terminal(
  input: Array<string | { text: string; wrapped: boolean }>,
  selection?: { row: number; column: number },
): TerminalLike {
  const lines = input.map<TerminalBufferLineLike>((item) => ({
    isWrapped: typeof item === "string" ? false : item.wrapped,
    translateToString: (trimRight?: boolean) => {
      const text = typeof item === "string" ? item : item.text;
      return trimRight ? text.trimEnd() : text;
    },
  }));
  return {
    buffer: {
      active: {
        getLine: (index) => lines[index],
        length: lines.length,
      },
    },
    getSelectionPosition: selection
      ? () => ({
          start: {
            x: selection.column,
            y: selection.row,
          },
        })
      : undefined,
  };
}
