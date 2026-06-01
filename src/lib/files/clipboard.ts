import type { FileProviderKind, TransferEndpoint } from "$lib/bindings";

export type FilesClipboardMode = "copy" | "cut";

export type FilesClipboardItem = {
  endpoint: TransferEndpoint;
  name: string;
  providerKind: FileProviderKind;
  hostId: string;
  workspaceId: string;
};

export type FilesClipboardState = {
  mode: FilesClipboardMode;
  items: FilesClipboardItem[];
};

export function cloneFilesClipboardState(next: FilesClipboardState): FilesClipboardState {
  if (next.items.length === 0) throw new Error("files clipboard cannot be empty");
  return {
    mode: next.mode,
    items: next.items.map((item) => ({
      ...item,
      endpoint: { ...item.endpoint },
    })),
  };
}
