/*
 * Test content:
 *
 * Feature:
 * Verifies the Rust Local Resource Monitor provider.
 *
 * Operation:
 * Collects a local resource snapshot through the Rust provider and inspects
 * the normalized metric kinds and provider descriptor.
 *
 * Expected:
 * The local provider does not start an external agent, labels itself as the
 * local provider, and returns exactly one CPU, memory, swap, and GPU
 * metric so the frontend can render a first local sample without waiting
 * forever.
 */

use nocturne_lib::{
    collect_local_resource_snapshot, local_resource_provider_descriptor_for_test,
    LocalResourceMetricKind,
};

#[test]
fn local_resource_provider_collects_all_metric_kinds_without_external_agent() {
    let descriptor = local_resource_provider_descriptor_for_test();
    assert_eq!(descriptor.label, "local provider");
    assert!(!descriptor.starts_external_agent);

    let snapshot = collect_local_resource_snapshot();
    assert_eq!(snapshot.provider, "local provider");

    let kinds: Vec<LocalResourceMetricKind> =
        snapshot.metrics.iter().map(|metric| metric.kind).collect();
    assert_eq!(
        kinds,
        vec![
            LocalResourceMetricKind::Cpu,
            LocalResourceMetricKind::Memory,
            LocalResourceMetricKind::Swap,
            LocalResourceMetricKind::Gpu,
        ],
    );
}
