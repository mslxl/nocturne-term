/*
 * Test content:
 *
 * Feature:
 * Verifies the standalone `nocturne-resource-monitor-agent` Linux DRM/sysfs GPU provider.
 *
 * Operation:
 * Creates a temporary Linux DRM fixture with two card device directories and
 * AMD-style VRAM usage files, then asks the helper library to collect GPU
 * metrics from that sysfs root without executing vendor commands.
 *
 * Expected:
 * The helper reports one available GPU metric containing both devices, uses
 * `used / total / percent` memory values, preserves per-device VRAM details,
 * keeps compute usage unavailable as zero when sysfs cannot provide it, and
 * does not require `nvidia-smi` or any external process.
 */
use std::{fs, path::Path};

use nocturne_resource_monitor_agent::{
    collect_linux_drm_gpu_metric_from_root_for_test, ResourceMetricKind,
    ResourceMonitorAgentMetricStatus,
};
use tempfile::tempdir;

#[test]
fn linux_drm_sysfs_reports_vram_for_multiple_gpu_devices_without_commands() {
    let root = tempdir().expect("tempdir");
    write_gpu(
        root.path(),
        "card0",
        "AMD Radeon",
        512 * 1024 * 1024,
        2 * 1024 * 1024 * 1024,
    );
    write_gpu(
        root.path(),
        "card1",
        "Intel Arc",
        256 * 1024 * 1024,
        1024 * 1024 * 1024,
    );

    let metric = collect_linux_drm_gpu_metric_from_root_for_test(root.path());

    assert_eq!(metric.metric, ResourceMetricKind::Gpu);
    assert_eq!(metric.status, ResourceMonitorAgentMetricStatus::Available);
    assert_eq!(metric.used, Some(768 * 1024 * 1024));
    assert_eq!(metric.total, Some(3 * 1024 * 1024 * 1024));
    assert_eq!(
        metric.free,
        Some((3 * 1024 * 1024 * 1024) - (768 * 1024 * 1024))
    );
    assert_eq!(metric.percent, Some(0.0));
    assert_eq!(metric.gpus.len(), 2);
    assert_eq!(metric.gpus[0].id, "card0");
    assert_eq!(metric.gpus[0].label, "AMD Radeon");
    assert_eq!(metric.gpus[0].memory_used, 512 * 1024 * 1024);
    assert_eq!(metric.gpus[0].memory_total, 2 * 1024 * 1024 * 1024);
    assert_eq!(metric.gpus[1].id, "card1");
    assert_eq!(metric.gpus[1].label, "Intel Arc");
}

fn write_gpu(root: &Path, card: &str, label: &str, used: u64, total: u64) {
    let device = root.join("class").join("drm").join(card).join("device");
    fs::create_dir_all(&device).expect("device dir");
    fs::write(device.join("product_name"), label).expect("product name");
    fs::write(device.join("mem_info_vram_used"), used.to_string()).expect("used");
    fs::write(device.join("mem_info_vram_total"), total.to_string()).expect("total");
}
