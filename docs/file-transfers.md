# File Transfers

This document defines Nocturne's application-level transfer service, Transfers tool tab, conflicts, cross-host behavior, and workspace close protection.

## Goals

File transfers are not owned by a single Files tool tab. A transfer may involve:

- local to remote
- remote to local
- remote to remote on the same host
- remote to remote across different hosts
- local to local

Transfers therefore belong to an application-level transfer service. Workspaces display filtered views of that global queue.

## Transfer Service

Transfer tasks have source and destination endpoints:

```ts
type TransferEndpoint =
  | { kind: "local"; path: string }
  | { kind: "provider"; providerKind: "local" | "sftp"; hostId: string; path: string };

type TransferTask = {
  id: string;
  source: TransferEndpoint;
  destination: TransferEndpoint;
  initiatorWorkspaceId: string | null;
  relatedWorkspaceIds: string[];
  status: "queued" | "running" | "failed" | "completed" | "canceled";
};
```

The service owns scheduling, progress, cancellation, retry, conflict resolution, and backend sessions needed to keep transfers independent from visible Files browsing sessions.

Closing a Files tool tab should not silently break a transfer. Transfers use service-owned sessions when needed.

The first release supports both single-file transfers and recursive directory transfers. Directory transfers recursively create destination directories and stream files through the same transfer service. Existing destination directories are merged into, but existing destination files are not overwritten.

## Transfers ToolTab

Transfers is a tool tab view over the application-level queue.

Rules:

- Each workspace may own its own Transfers tool tab view.
- The business queue is global.
- The tool tab stores filter state, such as related to this workspace, all transfers, or a host filter.
- Transfers tool tabs are persisted like other tool tabs.
- Transfers defaults to a bottom dock panel when first opened, but it can be moved or floated.

The file list should show only lightweight per-row transfer markers. Detailed progress, failures, retries, conflicts, and cancellation live in Transfers.

## Cross-Host Copies

Cross-host remote copies use local machine streaming as the first-release data path:

1. read from source provider
2. stream through the local app
3. write to destination provider

Do not attempt server-to-server direct copy in the first release.

Same-host operations may use provider capabilities such as atomic rename or server-side copy when available. If server-side copy is not available, copy through the application transfer stream.

## Concurrency

Concurrency is configurable:

- global transfer concurrency, default 3
- per-host transfer concurrency, default 2

A cross-host task consumes concurrency on both source and destination hosts.

Single large files are not split into parallel chunks in the first release.

Browsing and search use their own limits and do not consume transfer slots.

## Cancellation And Retry

The first release supports:

- cancel
- retry after failure

It does not promise pause or resumable transfer. The internal state machine may reserve future states, but the UI must not expose pause/resume until it is real.

## Conflicts

Transfer conflicts must not silently overwrite files.

Single-file conflict actions:

- Replace
- Keep Both
- Skip
- Cancel

Batch conflicts support Apply to all.

Directory conflicts merge into the existing directory by default, but file conflicts inside that directory use the same conflict rules. Until the conflict UI is complete, an existing destination file fails the transfer rather than overwriting silently.

`Keep Both` uses a deterministic copy name such as `name copy.ext` or `name (copy).ext`.

Conflict handling is shown inside the Transfers tool tab or a focused transfer conflict surface owned by Transfers. It should not be hidden in the Files list.

## Workspace Close Protection

The transfer service is application-level, but workspaces remain responsible for transfers they initiated or that involve their host.

When closing a workspace, Nocturne must check for related queued or running transfers. The close confirmation must explain that closing the workspace will cancel those transfers if the user continues.

If the user confirms, cancel the related transfer tasks before closing the workspace. If the user cancels, keep both workspace and transfers.

Closing an unrelated workspace must not cancel transfer tasks.

Mirror-originated transfers should record:

- the owner workspace of the source tool tab
- the workspace where the user initiated the operation
- endpoint host/workspace relationships where available

This lets Transfers filter and close confirmations remain understandable.

## Dialogs And Notifications

Native file panels are used for upload/download path selection.

Drag-and-drop should use Tauri/native file APIs where possible. The first implementation handles drag-in uploads through Tauri webview drag/drop events and creates Transfer Service tasks from dropped local paths. Upload Folder uses the native open panel with recursive directory access and enqueues a recursive directory transfer. If native drag-out downloads cannot be implemented reliably, fall back to a Web API path only after documenting the trade-off.

OS notifications may be used for transfer completion or failure when the app/window is not frontmost. In-window web-style toasts should not be the primary transfer notification surface.
