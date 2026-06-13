/*
 * Test content:
 *
 * Feature:
 * Verifies the Settings schema for Resource Monitor settings.
 *
 * Operation:
 * Reads the frontend Settings schema, finds the Resource Monitor refresh and
 * remote provider settings, checks their category, labels, config paths, fixed
 * select options, default values, fallback values for an empty config root,
 * configured value mapping, and serialized config values.
 *
 * Expected:
 * The settings appear under the Resource Monitor tool category. Refresh stores
 * `resources.default_refresh_interval`, only allows 1s, 2s, 5s, and 10s, and
 * defaults to 2s. Remote provider stores `resources.remote_provider`, only
 * allows auto, agent, and system_commands, defaults to auto, and writes TOML
 * string values.
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

  it("defines a remote provider mode setting", () => {
    const setting = settingsSchema.find((item) => item.key === "resources.remote_provider");
    assert.ok(setting, "resources.remote_provider setting must exist");

    assert.equal(setting.category, "resources");
    assert.equal(setting.label, "resourceRemoteProvider");
    assert.deepEqual(setting.path, ["resources", "remote_provider"]);
    assert.equal(setting.kind, "select");
    assert.equal(setting.defaultValue, "auto");
    assert.deepEqual(setting.options?.map((option) => option.value), ["auto", "agent", "system_commands"]);
    assert.equal(setting.get({ values: {} }), "auto");
    assert.equal(setting.get({ values: { resources: { kind: "Table", value: { remote_provider: configString("system_commands") } } } }), "system_commands");
    assert.deepEqual(setting.toConfigValue("agent"), configString("agent"));
  });
});
