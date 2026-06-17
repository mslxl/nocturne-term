/*
 * Test content:
 *
 * Feature:
 * Verifies the standalone Resource Monitor helper reports CPU detail data.
 *
 * Operation:
 * Collects one in-process helper metrics snapshot through the helper crate
 * API without launching a Tauri WebView or executing platform-specific
 * commands.
 *
 * Expected:
 * The CPU metric is available, reports an overall percent, and includes at
 * least one per-core CPU percent so the Resource Monitor UI can expand the CPU
 * row in Agent mode.
 */
use nocturne_resource_monitor_agent::{
    collect_metrics, ResourceMetricKind, ResourceMonitorAgentMetricStatus,
};

#[test]
fn resource_monitor_agent_cpu_metric_includes_per_core_details() {
    let metrics = collect_metrics();
    let cpu = metrics
        .iter()
        .find(|metric| metric.metric == ResourceMetricKind::Cpu)
        .expect("helper snapshot should include CPU metric");

    assert_eq!(cpu.status, ResourceMonitorAgentMetricStatus::Available);
    assert!(cpu.percent.is_some(), "CPU metric should include overall percent");
    assert!(
        !cpu.cores.is_empty(),
        "CPU metric should include per-core details"
    );
    assert!(
        cpu.cores
            .iter()
            .all(|percent| percent.is_finite() && (0.0..=100.0).contains(percent)),
        "CPU core percents should be normalized"
    );
}
