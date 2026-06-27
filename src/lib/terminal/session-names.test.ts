import { describe, expect, it } from "vitest";
import { mergeAgentSessionNameFromAttachInfo, mergeAgentSessionNamesFromRegistryList } from "./session-names";

describe("Terminal Agent session names", () => {
  it("uses registry list titles as the authority for renamed sessions", () => {
    const current = new Map([["term-a", "OldName"]]);

    const merged = mergeAgentSessionNamesFromRegistryList(current, [
      { session_id: "term-a", title: " RenamedBuild " },
      { session_id: "term-b", title: "FreshShell" },
    ]);

    expect([...merged.entries()]).toEqual([
      ["term-a", "RenamedBuild"],
      ["term-b", "FreshShell"],
    ]);
  });

  it("does not let repeated attach info overwrite an existing registry name", () => {
    const current = new Map([["term-a", "RenamedBuild"]]);

    const merged = mergeAgentSessionNameFromAttachInfo(current, {
      title: "C:\\Sources\\nocturne-term",
      agent: { session_id: "term-a" },
    });

    expect(merged).toBe(current);
    expect(merged.get("term-a")).toBe("RenamedBuild");
  });

  it("seeds the registry name from attach info only when no name has been observed yet", () => {
    const current = new Map<string, string>();

    const merged = mergeAgentSessionNameFromAttachInfo(current, {
      title: "FreshShell",
      agent: { session_id: "term-a" },
    });

    expect([...merged.entries()]).toEqual([["term-a", "FreshShell"]]);
  });

  it("ignores blank attach titles instead of erasing a known name", () => {
    const current = new Map([["term-a", "RenamedBuild"]]);

    const merged = mergeAgentSessionNameFromAttachInfo(current, {
      title: "   ",
      agent: { session_id: "term-a" },
    });

    expect(merged).toBe(current);
    expect(merged.get("term-a")).toBe("RenamedBuild");
  });
});
