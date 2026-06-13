/*
 * Test content:
 *
 * Feature:
 * Verifies the Rust Workspace backend creates the default Resource Monitor
 * layout for startup and newly created Workspaces.
 *
 * Operation:
 * Reads the Rust Workspace service source and inspects the default snapshot and
 * create-Workspace implementation for Resource Monitor ToolTab ids, right-side
 * group ids, row split ratios, and the absence of the previous bottom panel
 * Transfer Queue layout.
 *
 * Expected:
 * Both default startup Workspaces and newly created Workspaces include Files,
 * Terminal, Resource Monitor, and Transfer Queue. The root layout is a
 * three-column row split where Files is left, Terminal is content, and Resource
 * Monitor plus Transfer Queue share the right sidebar group with Resource
 * Monitor active by default.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

describe("Resource Monitor backend default Workspace layout", () => {
  it("creates Resources and Transfers in the right sidebar for startup and new Workspaces", async () => {
    const source = await readFile(new URL("../src-tauri/src/workspace.rs", import.meta.url), "utf8");
    const defaultSnapshot = extractFunctionSource(source, "default_snapshot");
    const createWorkspaceDefault = extractFunctionSource(source, "default_new_workspace_layout");

    assert.match(defaultSnapshot, /let resources_tool_id = new_id\("tool-resources"\)/);
    assert.match(defaultSnapshot, /let resources_slot_id = new_id\("slot-resources"\)/);
    assert.match(defaultSnapshot, /let right_group_id = new_id\("group-resources-transfers"\)/);

    assert.match(defaultSnapshot, /WorkspaceToolKind::Resources/);
    assert.match(defaultSnapshot, /WorkspaceToolKind::Transfers/);

    for (const functionSource of [defaultSnapshot, createWorkspaceDefault]) {
      assert.match(functionSource, /resources_tool_id/);
      assert.match(functionSource, /transfers_tool_id/);
      assert.match(functionSource, /owned_tool_tab_ids: vec!\[[\s\S]*resources_tool_id(?:\.clone\(\))?[\s\S]*transfers_tool_id(?:\.clone\(\))?[\s\S]*\]/);
      assert.match(functionSource, /role: WorkspaceDockGroupRole::Sidebar,[\s\S]*active_slot_id: (?:ids\.)?resources_slot_id/);
      assert.match(functionSource, /ratios: vec!\[0\.24, 0\.52, 0\.24\]/);
      assert.doesNotMatch(functionSource, /WorkspaceDockGroupRole::Panel/);
      assert.doesNotMatch(functionSource, /WorkspaceDockDirection::Column/);
      assert.doesNotMatch(functionSource, /group-transfers/);
    }
    assert.match(createWorkspaceDefault, /resources: true/);
    assert.match(createWorkspaceDefault, /transfers: true/);
  });
});

function extractFunctionSource(source: string, name: string): string {
  const start = source.indexOf(`fn ${name}`);
  assert.notEqual(start, -1, `missing Rust function ${name}`);
  let brace = source.indexOf("{", start);
  assert.notEqual(brace, -1, `missing Rust function body for ${name}`);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated Rust function ${name}`);
}
