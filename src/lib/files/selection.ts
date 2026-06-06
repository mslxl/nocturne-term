export type FilesSelectionState = {
  selectedPaths: string[];
  activePath: string;
  anchorPath: string;
};

export type FilesSelectionInput = {
  path: string;
  visiblePaths: readonly string[];
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
};

export function emptyFilesSelection(): FilesSelectionState {
  return {
    selectedPaths: [],
    activePath: "",
    anchorPath: "",
  };
}

export function selectFilesEntry(state: FilesSelectionState, input: FilesSelectionInput): FilesSelectionState {
  const modifierToggle = input.ctrlKey === true || input.metaKey === true;
  if (input.shiftKey === true) {
    const range = selectionRange(input.visiblePaths, state.anchorPath || state.activePath || input.path, input.path);
    return {
      selectedPaths: range.length ? range : [input.path],
      activePath: input.path,
      anchorPath: state.anchorPath || state.activePath || input.path,
    };
  }

  if (modifierToggle) {
    const selected = new Set(state.selectedPaths);
    if (selected.has(input.path)) {
      selected.delete(input.path);
    } else {
      selected.add(input.path);
    }
    return {
      selectedPaths: Array.from(selected),
      activePath: input.path,
      anchorPath: input.path,
    };
  }

  return {
    selectedPaths: [input.path],
    activePath: input.path,
    anchorPath: input.path,
  };
}

export function selectFilesContextTarget(state: FilesSelectionState, targetPath: string): FilesSelectionState {
  if (state.selectedPaths.includes(targetPath)) return state;
  return {
    selectedPaths: [targetPath],
    activePath: targetPath,
    anchorPath: targetPath,
  };
}

export function selectFilesMarquee(state: FilesSelectionState, paths: readonly string[]): FilesSelectionState {
  if (paths.length === 0) return state;
  const selectedPaths = uniquePaths(paths);
  const activePath = selectedPaths[selectedPaths.length - 1] ?? state.activePath;
  return {
    selectedPaths,
    activePath,
    anchorPath: selectedPaths[0] ?? state.anchorPath,
  };
}

export function clearFilesSelection(): FilesSelectionState {
  return emptyFilesSelection();
}

function selectionRange(visiblePaths: readonly string[], anchorPath: string, targetPath: string): string[] {
  const anchorIndex = visiblePaths.indexOf(anchorPath);
  const targetIndex = visiblePaths.indexOf(targetPath);
  if (anchorIndex < 0 || targetIndex < 0) return [];
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return visiblePaths.slice(start, end + 1);
}

function uniquePaths(paths: readonly string[]): string[] {
  return Array.from(new Set(paths));
}
