/*
 * Test content:
 *
 * Feature:
 * Verifies the Resource Monitor Svelte component structure and layout
 * constraints.
 *
 * Operation:
 * Reads the Resource Monitor ToolTab component source and checks for the
 * provider row, metric rows, collapsed-by-default detail controls, hidden
 * non-collapsible detail spacers, per-metric always-on history rendering,
 * OverlayScrollbars usage, pointer drag ordering hooks, and CSS that prevents
 * horizontal scrolling in a dense single-column panel.
 *
 * Expected:
 * The Resource Monitor UI is a native-feeling dense panel rather than a
 * dashboard-card placeholder, exposes the expected controls, always renders
 * bordered history charts without top max labels, allows metric panels to be
 * reordered by pointer drag without native HTML drag interference, starts every
 * collapsible detail view closed, uses non-button spacers for metrics that
 * cannot expand, uses OverlayScrollbars rather than native scrollbars, and
 * hides horizontal overflow while preserving vertical scrolling for narrow dock
 * groups.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve("src/lib/resources/ResourceMonitorToolTab.svelte"), "utf8");

describe("Resource Monitor UI source", () => {
  it("defines dense rows, provider status, collapsible details, and no horizontal scroll", () => {
    assert.match(source, /data-testid="resource-monitor-provider-row"/);
    assert.match(source, /data-testid="resource-monitor-status"/);
    assert.match(source, /data-testid="resource-monitor-row"/);
    assert.match(source, /data-testid="resource-monitor-detail-toggle"/);
    assert.match(source, /resource-monitor-detail-spacer/);
    assert.match(source, /\{#if row\.collapsible\}[\s\S]*data-testid="resource-monitor-detail-toggle"[\s\S]*\{:else\}[\s\S]*resource-monitor-detail-spacer/);
    assert.match(source, /data-testid="resource-monitor-history"/);
    assert.match(source, /data-testid="resource-monitor-child-history"/);
    assert.match(source, /OverlayScrollbarsComponent/);
    assert.match(source, /reorderResourceMetricOrder/);
    assert.match(source, /let expandedGroups = \$state<Set<string>>\(new Set\(\)\)/);
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
