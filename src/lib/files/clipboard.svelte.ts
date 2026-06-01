import { cloneFilesClipboardState, type FilesClipboardState } from "./clipboard";

let clipboard = $state<FilesClipboardState | null>(null);

export function filesClipboardSnapshot(): FilesClipboardState | null {
  return clipboard;
}

export function setFilesClipboard(next: FilesClipboardState) {
  clipboard = cloneFilesClipboardState(next);
}

export function clearFilesClipboard() {
  clipboard = null;
}
