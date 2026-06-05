/*
 * Test content:
 *
 * Feature:
 * Verifies that the Settings schema reports the same default Terminal padding
 * values as the runtime Terminal settings.
 *
 * Operation:
 * Reads the terminal.padding edge definitions from the frontend settings
 * schema and compares their fallback values for an empty config root.
 *
 * Expected:
 * Top and bottom default to 8px, while right and left default to 10px. The
 * Settings page must not display 8px for horizontal padding when the runtime
 * terminal surface uses 10px by default.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { settingsSchema } from "../src/lib/settings/schema";

describe("Terminal padding settings schema", () => {
  it("matches the runtime default padding values per edge", () => {
    const root = { values: {} };
    const paddingDefaults = Object.fromEntries(
      settingsSchema
        .filter((setting) => setting.key.startsWith("terminal.padding."))
        .map((setting) => [setting.key, { defaultValue: setting.defaultValue, fallback: setting.get(root) }]),
    );

    assert.deepEqual(paddingDefaults, {
      "terminal.padding.top": { defaultValue: 8, fallback: 8 },
      "terminal.padding.right": { defaultValue: 10, fallback: 10 },
      "terminal.padding.bottom": { defaultValue: 8, fallback: 8 },
      "terminal.padding.left": { defaultValue: 10, fallback: 10 },
    });
  });
});
