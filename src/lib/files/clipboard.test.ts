import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cloneFilesClipboardState } from "./clipboard";

describe("files clipboard", () => {
  it("rejects empty clipboard writes", () => {
    assert.throws(
      () => cloneFilesClipboardState({ mode: "copy", items: [] }),
      /files clipboard cannot be empty/,
    );
  });

  it("stores provider endpoint references without sharing mutable endpoint objects", () => {
    const endpoint = {
      kind: "provider" as const,
      provider_kind: "sftp" as const,
      host_id: "host-a",
      path: "/var/www/app",
    };

    const snapshot = cloneFilesClipboardState({
      mode: "cut",
      items: [
        {
          endpoint,
          name: "app",
          providerKind: "sftp",
          hostId: "host-a",
          workspaceId: "workspace-a",
        },
      ],
    });
    endpoint.path = "/mutated";

    assert.equal(snapshot.mode, "cut");
    assert.equal(snapshot.items[0]?.endpoint.path, "/var/www/app");
  });
});
