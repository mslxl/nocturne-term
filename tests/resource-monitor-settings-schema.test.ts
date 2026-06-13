/*
 * Test content:
 *
 * Feature:
 * Verifies the Settings schema for the Resource Monitor default refresh
 * interval.
 *
 * Operation:
 * Reads the frontend Settings schema, finds the Resource Monitor refresh
 * setting, checks its category, label, config path, fixed select options,
 * default value, fallback value for an empty config root, configured value
 * mapping, and serialized config value.
 *
 * Expected:
 * The setting appears under a Resource Monitor tool category as `Default
 * resource refresh interval`, stores `resources.default_refresh_interval`, only
 * allows 1s, 2s, 5s, and 10s, defaults to 2s, and writes a TOML string value.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { settingsSchema, settingCategories } from "../src/lib/settings/schema";
import { configString } from "../src/lib/config/document";

describe("Resource Monitor settings schema", () => {
  it("defines a fixed default refresh interval setting", () => {
    const category = settingCategories.find((item) => item.id === "resources");
    assert.deepEqual(category, { id: "resources", label: "resources" });

    const setting = settingsSchema.find((item) => item.key === "resources.default_refresh_interval");
    assert.ok(setting, "resources.default_refresh_interval setting must exist");

    assert.equal(setting.category, "resources");
    assert.equal(setting.label, "defaultResourceRefreshInterval");
    assert.deepEqual(setting.path, ["resources", "default_refresh_interval"]);
    assert.equal(setting.kind, "select");
    assert.equal(setting.defaultValue, "2s");
    assert.deepEqual(setting.options?.map((option) => option.value), ["1s", "2s", "5s", "10s"]);
    assert.equal(setting.get({ values: {} }), "2s");
    assert.equal(setting.get({ values: { resources: { kind: "Table", value: { default_refresh_interval: configString("5s") } } } }), "5s");
    assert.deepEqual(setting.toConfigValue("10s"), configString("10s"));
  });
});
