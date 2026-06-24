/*
 * Test content:
 *
 * Feature:
 * Verifies Workspace dispatch recovery when the frontend snapshot version is
 * stale during a ToolTab Dock drag operation.
 *
 * Operation:
 * Creates the Workspace frontend store with a version 0 snapshot, mocks the
 * Rust Workspace dispatch command to reject the first move intent with
 * `workspace snapshot version mismatch`, then mocks the snapshot read command
 * to return version 1 before the same intent is retried.
 *
 * Expected:
 * The store reloads the authoritative Rust Workspace snapshot after the
 * version mismatch, retries the ToolTab move with the refreshed version, and
 * ends with the successful version 2 snapshot instead of surfacing the stale
 * version error to the UI.
 */
import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import type { WorkspaceDispatchInput, WorkspaceLayoutSnapshot } from "../src/lib/bindings";

const mocks = vi.hoisted(() => ({
  workspaceDispatch: vi.fn(),
  getWorkspaceLayoutSnapshot: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

vi.mock("../src/lib/tauri/runtime", () => ({
  hasTauriRuntime: () => true,
}));

vi.mock("../src/lib/bindings", () => ({
  commands: {
    workspaceDispatch: mocks.workspaceDispatch,
    getWorkspaceLayoutSnapshot: mocks.getWorkspaceLayoutSnapshot,
  },
}));

describe("Workspace store dispatch version retry", () => {
  it("reloads and retries a ToolTab move after a workspace snapshot version mismatch", async () => {
    const { createWorkspaceStore } = await import("../src/lib/workspace/state.svelte");
    const initial = snapshot(0);
    const refreshed = snapshot(1);
    const committed = snapshot(2);
    const intent: WorkspaceDispatchInput["intent"] = {
      kind: "move_tool_slot_to_group",
      workspace_id: "workspace-a",
      slot_id: "slot-files-a",
      target_group_id: "group-content-a",
    };

    mocks.workspaceDispatch
      .mockResolvedValueOnce({
        status: "error",
        error: {
          kind: "Invalid",
          message: {
            message: "workspace snapshot version mismatch: expected 0, current 1",
          },
        },
      })
      .mockResolvedValueOnce({ status: "ok", data: committed });
    mocks.getWorkspaceLayoutSnapshot.mockResolvedValueOnce({ status: "ok", data: refreshed });

    const store = createWorkspaceStore();
    store.replaceSnapshot(initial);

    const result = await store.dispatch(intent);

    assert.equal(result.version, 2);
    assert.equal(store.snapshot?.version, 2);
    assert.deepEqual(mocks.workspaceDispatch.mock.calls.map(([input]) => input.expected_version), [0, 1]);
    assert.deepEqual(mocks.workspaceDispatch.mock.calls.map(([input]) => input.intent), [intent, intent]);
    assert.equal(mocks.getWorkspaceLayoutSnapshot.mock.calls.length, 1);
    assert.equal(store.error, "");
  });
});

function snapshot(version: number): WorkspaceLayoutSnapshot {
  return {
    version,
    active_workspace_id: "workspace-a",
    workspaces: [
      {
        id: "workspace-a",
        host_id: "host-local",
        title: "Local",
        owned_tool_tab_ids: ["tool-files-a"],
        layout: {
          kind: "group",
          id: "group-content-a",
          role: "content",
          active_slot_id: "slot-files-a",
          collapsed: false,
          slots: [
            {
              kind: "owned",
              id: "slot-files-a",
              tool_tab_id: "tool-files-a",
            },
          ],
        },
      },
    ],
    tool_tabs: [
      {
        id: "tool-files-a",
        kind: "files",
        owner_workspace_id: "workspace-a",
        host_id: "host-local",
        title: "~",
      },
    ],
    floating_windows: [],
  };
}
