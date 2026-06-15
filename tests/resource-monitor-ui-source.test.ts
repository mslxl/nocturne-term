/*
 * Test content:
 *
 * Feature:
 * Verifies the Resource Monitor Svelte component structure and layout
 * constraints.
 *
 * Operation:
 * Reads the Resource Monitor ToolTab component source and checks for the
 * provider row, compact Host-scoped provider mode control, metric rows,
 * expandable CPU/GPU detail rendering, provider-switch loading state,
 * OverlayScrollbars usage, pointer drag ordering hooks, and CSS that prevents
 * horizontal scrolling in a dense single-column panel.
 *
 * Expected:
 * The Resource Monitor UI is a native-feeling dense panel rather than a
 * dashboard-card placeholder, exposes the expected controls, persists remote
 * provider mode through Host config instead of global settings, always renders
 * provider-mode save errors until the next user action, enters a loading state
 * while switching remote provider modes so old provider data is hidden, avoids
 * rendering provider/status text in the compact header, avoids cloning generated
 * Tauri binding objects with `structuredClone`, reads editable Host config only
 * for SSH Resource Monitor ToolTabs so Local Resource Monitor cannot show a
 * missing Local Host error, always renders bordered overall and detail history
 * charts without top max labels, allows metric panels to be reordered by pointer
 * drag without native HTML drag interference, keeps CPU/GPU detail expansion
 * controls available but closed by default, uses OverlayScrollbars rather than
 * native scrollbars, and hides horizontal overflow while preserving vertical
 * scrolling for narrow dock groups.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve("src/lib/resources/ResourceMonitorToolTab.svelte"), "utf8");

describe("Resource Monitor UI source", () => {
  it("defines dense overall rows, Host provider mode control, and no horizontal scroll", () => {
    assert.match(source, /data-testid="resource-monitor-provider-row"/);
    assert.match(source, /data-testid="resource-monitor-provider-mode"/);
    assert.match(source, /let providerModeLoading = \$state\(false\)/);
    assert.match(source, /beginResourceMonitorProviderSwitch\(toolTab\.id\)/);
    assert.match(source, /class:provider-loading=\{providerModeLoading\}/);
    assert.match(source, /data-testid="resource-monitor-loading"/);
    assert.match(source, /aria-label="Loading resource metrics"/);
    assert.match(source, /if \(toolTab\.host_id === LOCAL_HOST_ID\)/);
    assert.match(source, /commands\.readConnectionHost\(toolTab\.host_id\)/);
    assert.match(source, /commands\.updateConnectionHost/);
    assert.match(source, /remote_provider:\s*value/);
    assert.match(source, /cloneHostDocument\(hostEntry\.document\)/);
    assert.doesNotMatch(source, /structuredClone\(hostEntry\.document\)/);
    assert.match(source, /providerModeError = "";\s*remoteProviderMode = value;/);
    assert.doesNotMatch(source, /catch \(error\) \{[\s\S]*providerModeError = error instanceof Error \? error\.message : String\(error\);[\s\S]*await refreshHostProviderMode\(\);[\s\S]*\}/);
    assert.doesNotMatch(source, /data-testid="resource-monitor-provider-label"/);
    assert.doesNotMatch(source, /data-testid="resource-monitor-status"/);
    assert.doesNotMatch(source, /\{model\.providerLabel\}/);
    assert.doesNotMatch(source, /\{model\.statusLabel\}/);
    assert.doesNotMatch(source, />Loading<\/div>/);
    assert.match(source, /data-testid="resource-monitor-row"/);
    assert.match(source, /data-testid="resource-monitor-detail-toggle"/);
    assert.match(source, /resource-monitor-detail-spacer/);
    assert.match(source, /\{#if row\.collapsible\}[\s\S]*data-testid="resource-monitor-detail-toggle"[\s\S]*\{:else\}[\s\S]*resource-monitor-detail-spacer/);
    assert.match(source, /data-testid="resource-monitor-history"/);
    assert.match(source, /data-testid="resource-monitor-child-history"/);
    assert.match(source, /OverlayScrollbarsComponent/);
    assert.match(source, /reorderResourceMetricOrder/);
    assert.match(source, /let expandedGroups = \$state<Set<ResourceMetricId>>\(new Set\(\)\)/);
    assert.doesNotMatch(source, /new Set\(\["cpu", "gpu"\]\)/);
    assert.match(source, /onpointerdown=/);
    assert.match(source, /pointer-drag-source/);
    assert.match(source, /pointer-drop-target/);
    assert.doesNotMatch(source, /draggable="true"/);
    assert.doesNotMatch(source, /ondragstart=/);
    assert.doesNotMatch(source, /ondrop=/);
    assert.match(source, /border:\s*1px solid/);
    assert.match(source, /overflow-x:\s*hidden/);
    assert.match(source, /overflow-y:\s*hidden/);
    assert.doesNotMatch(source, /Updated now/);
    assert.doesNotMatch(source, /Current/);
    assert.doesNotMatch(source, /History<\/button>/);
    assert.doesNotMatch(source, /resource-monitor-history-max/);
    assert.doesNotMatch(source, />100%<\/span>/);
    assert.doesNotMatch(source, /samples/);
    assert.doesNotMatch(source, /resource-monitor-placeholder/);
    assert.doesNotMatch(source, /dashboard-card|metric-card/);
  });
});
