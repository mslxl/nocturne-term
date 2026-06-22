import { emptyFilesSelection, type FilesSelectionState } from "./selection";
import type { FileEntry, FileListResult } from "$lib/bindings";

let selections = $state(new Map<string, FilesSelectionState>());
let viewStates = $state(new Map<string, FilesToolViewState>());

export type FilesToolViewState = {
  path: string | null;
  previewPath: string;
  lastSelectedEntry: FileEntry | null;
  viewMode: "tree" | "columns" | null;
  expandedTreePaths: Record<string, boolean>;
  userCollapsedTreePaths: Record<string, boolean>;
  treeChildrenByPath: Record<string, FileEntry[]>;
  treeErrorByPath: Record<string, string>;
  firstVisibleTreePath: string;
  filesResult: FileListResult | undefined;
};

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

export function filesToolViewState(toolTabId: string): FilesToolViewState {
  const existing = viewStates.get(toolTabId);
  if (existing) return existing;
  const next = $state<FilesToolViewState>({
    path: null,
    previewPath: "",
    lastSelectedEntry: null,
    viewMode: null,
    expandedTreePaths: {},
    userCollapsedTreePaths: {},
    treeChildrenByPath: {},
    treeErrorByPath: {},
    firstVisibleTreePath: "",
    filesResult: undefined,
  });
  viewStates.set(toolTabId, next);
  return next;
}
