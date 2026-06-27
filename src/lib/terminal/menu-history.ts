export type TerminalMenuHistoryState = {
  activeSessionWritable: boolean;
  activeTextInputCanRedo: boolean;
  activeTextInputCanUndo: boolean;
  redoDepth: number;
  undoDepth: number;
};

export function terminalMenuCanUndo(state: TerminalMenuHistoryState): boolean {
  return state.activeTextInputCanUndo || state.undoDepth > 0;
}

export function terminalMenuCanRedo(state: TerminalMenuHistoryState): boolean {
  return state.activeTextInputCanRedo || state.redoDepth > 0;
}
