/*
 * Test content:
 *
 * Feature:
 * Verifies the Ports ToolTab frontend source for unsupported Host protocols,
 * backend snapshot wiring, inline draft/edit commands, header sort menus,
 * collapsed events, non-loopback confirmation, Workspace close confirmation,
 * and main Workspace rendering.
 *
 * Operation:
 * Reads the Svelte source for the Ports ToolTab and main Workspace page, then
 * inspects the protocol support check, unsupported empty state text, backend
 * snapshot commands, Start/Stop command wiring, inline draft persistence, row
 * Save/Cancel controls, the pre-edit draft row state, header sort menu items,
 * direction header suppression, event expansion controls, menu overflow
 * behavior, background snapshot refresh, non-loopback risk checks,
 * OverlayScrollbars vertical-only table scrolling, Host port-forward close
 * confirmation, first Host-open non-loopback confirmation, and Workspace
 * ToolTab render branch.
 *
 * Expected:
 * Ports renders only as supported for SSH Hosts, Local/Telnet Hosts get an
 * unsupported state without a visible add affordance, snapshot state comes
 * from typed Tauri commands, runtime buttons call Start/Stop commands, draft
 * edits are retained through typed commands, active Host port forwards are
 * confirmed before the last same-Host Workspace closes, horizontal table
 * scrolling is avoided, row action menus are not clipped by table-cell
 * overflow, runtime status can refresh after backend worker changes, the blank
 * draft row renders as a quiet insertion row before editing starts, and the main
 * Workspace page mounts PortsToolTab for ToolTabs whose kind is "ports".
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

describe("Port Forwarding ToolTab skeleton source", () => {
  it("renders a ports branch and unsupported state for non-SSH hosts", async () => {
    const [portsSource, pageSource] = await Promise.all([
      readFile(new URL("../src/lib/ports/PortsToolTab.svelte", import.meta.url), "utf8"),
      readFile(new URL("../src/routes/+page.svelte", import.meta.url), "utf8"),
    ]);

    assert.match(portsSource, /host\?\.document\.protocol === "ssh"/);
    assert.match(portsSource, /Ports unavailable/);
    assert.match(portsSource, /Port forwarding is supported for SSH hosts\./);
    assert.match(portsSource, /commands\.getPortForwardSnapshot/);
    assert.match(portsSource, /commands\.startPortForwardRule/);
    assert.match(portsSource, /commands\.stopPortForwardRule/);
    assert.match(portsSource, /commands\.updatePortForwardDraft/);
    assert.match(portsSource, /commands\.clearPortForwardDraft/);
    assert.match(portsSource, /commands\.checkPortForwardNonLoopbackRisk/);
    assert.match(portsSource, /OverlayScrollbarsComponent/);
    assert.match(portsSource, /import \{ createQuery, useQueryClient \} from "@tanstack\/svelte-query"/);
    assert.match(portsSource, /const queryClient = useQueryClient\(\)/);
    assert.match(portsSource, /const snapshotQuery = createQuery\(\(\) => \(\{/);
    assert.match(portsSource, /queryKey: portForwardSnapshotQueryKey\(host\?\.id \?\? "no-host"\)/);
    assert.match(portsSource, /refetchInterval:\s*750/);
    assert.match(portsSource, /refetchIntervalInBackground:\s*true/);
    assert.match(portsSource, /queryClient\.setQueryData\(portForwardSnapshotQueryKey\(next\.host_id\), next\)/);
    assert.doesNotMatch(portsSource, /window\.setInterval/);
    assert.doesNotMatch(portsSource, /clearInterval/);
    assert.match(portsSource, /overflow:\s*\{[\s\S]*x:\s*"hidden"[\s\S]*y:\s*"scroll"[\s\S]*\}/);
    assert.match(portsSource, /class="ports-table-shell"/);
    assert.match(portsSource, /<colgroup>/);
    assert.match(portsSource, /class="connections-col"/);
    assert.match(portsSource, /class="endpoint-col"/);
    assert.match(portsSource, /class="actions-col"/);
    assert.match(portsSource, /table-layout:\s*fixed/);
    assert.match(portsSource, /min-width:\s*0/);
    assert.doesNotMatch(portsSource, /overflow:\s*auto/);
    assert.doesNotMatch(portsSource, /min-width:\s*760px/);
    assert.match(portsSource, />Save</);
    assert.match(portsSource, />Cancel</);
    assert.match(portsSource, /let draftActive = \$state\(false\)/);
    assert.match(portsSource, /let draftIsEditing = \$derived\(draftActive \|\| draftChanged \|\| !!snapshot\?\.draft \|\| !!validation\.draft\)/);
    assert.match(portsSource, /async function beginDraftEdit\(\)/);
    assert.match(portsSource, /draftNameInput\?\.focus\(\)/);
    assert.match(portsSource, /class=\{draftIsEditing \? "draft" : "draft draft-idle"\}/);
    assert.match(portsSource, /class="draft-seed draft-seed-endpoint"/);
    assert.match(portsSource, /aria-label="Start editing draft port forward"/);
    assert.match(portsSource, /\.ports-table tr\.draft-idle td\s*\{[\s\S]*background:/);
    assert.match(portsSource, /\.draft-seed-name::before/);
    assert.match(portsSource, />Sort Ascending</);
    assert.match(portsSource, />Set as Secondary Sort</);
    assert.match(portsSource, /if \(columnId === "actions"\) return/);
    assert.match(portsSource, /return columnId === "actions" \? null : columnId as PortForwardSortKey/);
    assert.match(portsSource, /class="direction-header" aria-label="Sort Direction" onclick=\{\(event\) => sortHeader\(String\(column\.id\), event\)\}/);
    assert.match(portsSource, /column\.id !== "direction" && column\.id !== "actions"/);
    assert.match(portsSource, /\.ports-table th button\.direction-header\s*\{[\s\S]*width:\s*100%;/);
    assert.match(portsSource, />Events</);
    assert.match(portsSource, /source\.runtime\.events/);
    assert.match(portsSource, /item\.runtime\.warning/);
    assert.match(portsSource, /class="warning-overlay"/);
    assert.match(portsSource, /\.ports-table td\.actions-cell\s*\{[\s\S]*overflow:\s*visible;/);
    assert.match(portsSource, /\.ports-table td\.connections-cell\s*\{[\s\S]*overflow:\s*visible;/);
    assert.match(portsSource, /function toggleMoreMenu\(rowId: string, event: MouseEvent\)/);
    assert.match(portsSource, /getBoundingClientRect\(\)/);
    assert.match(portsSource, /style=\{openMenuStyle\}/);
    assert.match(portsSource, /position:\s*fixed;/);
    assert.match(portsSource, /row\.status === "failed" && row\.error/);
    assert.doesNotMatch(portsSource, />\s*(Add|Create|New)\s*</);
    assert.match(pageSource, /import PortsToolTab from "\$lib\/ports\/PortsToolTab\.svelte"/);
    assert.match(pageSource, /tool\.kind === "ports"/);
    assert.match(pageSource, /<PortsToolTab toolTab=\{tool\} host=\{connectionHostForToolTab\(tool\)\}/);
    assert.match(pageSource, /confirmWorkspacePortForwardClose/);
    assert.match(pageSource, /confirmAutoOpenPortForwardRisks/);
    assert.match(pageSource, /row\.runtime\.status !== "needs_confirmation"/);
    assert.match(pageSource, /This saved port forward starts when the Host opens/);
    assert.match(pageSource, /addNonLoopbackConfirmation\(row\.rule/);
    assert.match(pageSource, /commands\.startPortForwardRule/);
    assert.match(pageSource, /commands\.getPortForwardSnapshot\(workspace\.host_id\)/);
    assert.match(pageSource, /item\.runtime\.status === "starting"/);
    assert.match(pageSource, /item\.runtime\.status === "running"/);
    assert.match(pageSource, /item\.runtime\.status === "reconnecting"/);
    assert.match(pageSource, /Close this workspace and stop/);
  });
});
