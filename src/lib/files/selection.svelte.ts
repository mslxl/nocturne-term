import { emptyFilesSelection, type FilesSelectionState } from "./selection";

let selections = $state(new Map<string, FilesSelectionState>());

export function filesToolSelection(toolTabId: string): FilesSelectionState {
  const existing = selections.get(toolTabId);
  if (existing) return existing;
  const next = emptyFilesSelection();
  selections.set(toolTabId, next);
  return next;
}

export function resetFilesToolSelection(toolTabId: string) {
  const selection = filesToolSelection(toolTabId);
  selection.selectedPaths = [];
  selection.activePath = "";
  selection.anchorPath = "";
}
