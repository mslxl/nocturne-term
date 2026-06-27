import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { terminalMenuCanRedo, terminalMenuCanUndo } from "./menu-history";

describe("terminal menu history state", () => {
  it("does not enable undo for a terminal without app history or focused input undo history", () => {
    assert.equal(
      terminalMenuCanUndo({
        activeSessionWritable: true,
        activeTextInputCanRedo: false,
        activeTextInputCanUndo: false,
        redoDepth: 0,
        undoDepth: 0,
      }),
      false,
    );
  });

  it("does not enable redo for a terminal without app history or focused input redo history", () => {
    assert.equal(
      terminalMenuCanRedo({
        activeSessionWritable: true,
        activeTextInputCanRedo: false,
        activeTextInputCanUndo: false,
        redoDepth: 0,
        undoDepth: 0,
      }),
      false,
    );
  });

  it("enables redo from app history", () => {
    assert.equal(
      terminalMenuCanRedo({
        activeSessionWritable: false,
        activeTextInputCanRedo: false,
        activeTextInputCanUndo: false,
        redoDepth: 1,
        undoDepth: 0,
      }),
      true,
    );
  });

  it("enables undo from app history", () => {
    assert.equal(
      terminalMenuCanUndo({
        activeSessionWritable: false,
        activeTextInputCanRedo: false,
        activeTextInputCanUndo: false,
        redoDepth: 0,
        undoDepth: 1,
      }),
      true,
    );
  });
});
