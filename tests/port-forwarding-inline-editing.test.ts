/*
 * Test content:
 *
 * Feature:
 * Verifies Port Forwarding inline edit helpers for draft retention, rule input
 * creation, validation errors, and delete confirmation decisions.
 *
 * Operation:
 * Builds edit models from empty drafts and runtime rule snapshots, converts
 * draft edits back to Host-runtime draft payloads, creates typed rule inputs,
 * and checks deletion confirmation behavior for active and inactive rules.
 *
 * Expected:
 * Draft ports remain strings until save, rule inputs parse valid numeric ports,
 * invalid endpoints produce field-specific validation errors, stopped/failed
 * rows delete without confirmation, and running or actively connected rows
 * require confirmation.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  buildRuleInput,
  addNonLoopbackConfirmation,
  canDeleteWithoutConfirmation,
  draftFromEditModel,
  editModelFromDraft,
  editModelFromSnapshot,
  PortForwardEditError,
  type PortForwardEditModel,
} from "../src/lib/ports/editing";
import type { PortForwardRuleSnapshot_Deserialize } from "../src/lib/bindings";

describe("Port Forwarding inline editing helpers", () => {
  it("keeps draft port input as strings until a row is saved", () => {
    const model = editModelFromDraft({
      name: "Postgres",
      direction: "local_to_remote",
      local_address: "127.0.0.1",
      local_port: "",
      remote_address: "db.internal",
      remote_port: "5432",
      persistence: "just_this_time",
      connect_on_host_open: true,
    });

    assert.equal(model.localPort, "");
    assert.deepEqual(draftFromEditModel(model), {
      name: "Postgres",
      direction: "local_to_remote",
      local_address: "127.0.0.1",
      local_port: "",
      remote_address: "db.internal",
      remote_port: "5432",
      persistence: "just_this_time",
      connect_on_host_open: true,
    });
  });

  it("creates typed rule input from a valid edit model", () => {
    const input = buildRuleInput("host-a", validModel({ id: "rule-a" }), null);

    assert.equal(input.host_id, "host-a");
    assert.equal(input.persistence, "just_this_time");
    assert.equal(input.rule.id, "rule-a");
    assert.equal(input.rule.local_port, 15432);
    assert.equal(input.rule.remote_port, 5432);
    assert.deepEqual(input.rule.non_loopback_confirmations, []);
  });

  it("reports field errors for missing addresses and malformed ports", () => {
    assert.throws(
      () => buildRuleInput("host-a", validModel({
        localAddress: "",
        localPort: "abc",
        remoteAddress: "",
        remotePort: "70000",
      }), null),
      (cause) => {
        assert.ok(cause instanceof PortForwardEditError);
        assert.equal(cause.validation.fieldErrors.localAddress, "Local address is required");
        assert.equal(cause.validation.fieldErrors.localPort, "Use 0-65535");
        assert.equal(cause.validation.fieldErrors.remoteAddress, "Remote address is required");
        assert.equal(cause.validation.fieldErrors.remotePort, "Use 0-65535");
        return true;
      },
    );
  });

  it("maps snapshots to edit models and decides when deletion needs confirmation", () => {
    const stopped = snapshot("stopped", 0);
    const failed = snapshot("failed", 0);
    const running = snapshot("running", 0);
    const connected = snapshot("failed", 2);

    assert.equal(editModelFromSnapshot(stopped).localPort, "15432");
    assert.equal(canDeleteWithoutConfirmation(stopped), true);
    assert.equal(canDeleteWithoutConfirmation(failed), true);
    assert.equal(canDeleteWithoutConfirmation(running), false);
    assert.equal(canDeleteWithoutConfirmation(connected), false);
  });

  it("adds non-loopback confirmations bound to current connection semantics", () => {
    const row = snapshot("stopped", 0);
    const confirmed = addNonLoopbackConfirmation(row.rule, "1781881401000");

    assert.deepEqual(confirmed.non_loopback_confirmations, [{
      semantic_key: {
        direction: "local_to_remote",
        local_address: "127.0.0.1",
        local_port: 15432,
        remote_address: "db.internal",
        remote_port: 5432,
      },
      confirmed_at_unix_ms: "1781881401000",
    }]);

    const replaced = addNonLoopbackConfirmation(confirmed, "1781881402000");
    assert.equal(replaced.non_loopback_confirmations?.length, 1);
    assert.equal(replaced.non_loopback_confirmations?.[0]?.confirmed_at_unix_ms, "1781881402000");
  });
});

function validModel(overrides: Partial<PortForwardEditModel> = {}): PortForwardEditModel {
  return {
    id: "",
    name: "Postgres",
    direction: "local_to_remote",
    localAddress: "127.0.0.1",
    localPort: "15432",
    remoteAddress: "db.internal",
    remotePort: "5432",
    persistence: "just_this_time",
    connectOnHostOpen: true,
    ...overrides,
  };
}

function snapshot(status: PortForwardRuleSnapshot_Deserialize["runtime"]["status"], activeConnections: number): PortForwardRuleSnapshot_Deserialize {
  return {
    rule: {
      id: "rule-a",
      name: "Postgres",
      direction: "local_to_remote",
      local_address: "127.0.0.1",
      local_port: 15432,
      remote_address: "db.internal",
      remote_port: 5432,
      connect_on_host_open: true,
      non_loopback_confirmations: [],
    },
    runtime: {
      rule_id: "rule-a",
      persistence: "just_this_time",
      status,
      intended_running: status === "running",
      active_connections: activeConnections,
      effective_local_port: null,
      effective_remote_port: null,
      warning: null,
      error: status === "failed" ? "port in use" : null,
      events: [],
    },
  };
}
