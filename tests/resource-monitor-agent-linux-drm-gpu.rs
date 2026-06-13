/*
 * Test content:
 *
 * Feature:
 * Verifies the standalone `nocturne-resource-monitor-agent` Linux DRM/sysfs GPU provider.
 *
 * Operation:
 * Creates temporary Linux GPU fixtures with DRM card device directories,
 * AMD-style VRAM usage files, and an NVIDIA-style NVML sample, then asks the
 * helper library to collect GPU metrics without executing vendor commands.
 *
 * Expected:
 * The helper reports available GPU metrics from DRM/sysfs when those files are
 * present, falls back to an in-process NVML provider when DRM has no VRAM
 * files, preserves per-device VRAM and compute details, and does not require
 * `nvidia-smi` or any external process.
 */
use std::{fs, path::Path};

use nocturne_resource_monitor_agent::{
    collect_linux_drm_gpu_metric_from_root_for_test,
    collect_linux_gpu_metric_from_sources_for_test, LinuxNvmlDeviceSample, ResourceMetricKind,
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

#[test]
fn linux_gpu_provider_falls_back_to_nvml_when_drm_vram_files_are_missing() {
    let root = tempdir().expect("tempdir");
    let device = root
        .path()
        .join("class")
        .join("drm")
        .join("card0")
        .join("device");
    fs::create_dir_all(&device).expect("device dir");
    fs::write(device.join("product_name"), "NVIDIA RTX").expect("product name");

    let metric = collect_linux_gpu_metric_from_sources_for_test(
        root.path(),
        vec![LinuxNvmlDeviceSample {
            id: "nvml-0".to_string(),
            label: "NVIDIA RTX 4090".to_string(),
            compute_percent: 37.5,
            memory_used: 4 * 1024 * 1024 * 1024,
            memory_total: 24 * 1024 * 1024 * 1024,
        }],
    );

    assert_eq!(metric.metric, ResourceMetricKind::Gpu);
    assert_eq!(metric.status, ResourceMonitorAgentMetricStatus::Available);
    assert_eq!(metric.used, Some(4 * 1024 * 1024 * 1024));
    assert_eq!(metric.total, Some(24 * 1024 * 1024 * 1024));
    assert_eq!(metric.percent, Some(37.5));
    assert_eq!(metric.gpus.len(), 1);
    assert_eq!(metric.gpus[0].id, "nvml-0");
    assert_eq!(metric.gpus[0].label, "NVIDIA RTX 4090");
    assert_eq!(metric.gpus[0].compute_percent, 37.5);
}

fn write_gpu(root: &Path, card: &str, label: &str, used: u64, total: u64) {
    let device = root.join("class").join("drm").join(card).join("device");
    fs::create_dir_all(&device).expect("device dir");
    fs::write(device.join("product_name"), label).expect("product name");
    fs::write(device.join("mem_info_vram_used"), used.to_string()).expect("used");
    fs::write(device.join("mem_info_vram_total"), total.to_string()).expect("total");
}
