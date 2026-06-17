/*
 * Test content:
 *
 * Feature:
 * Verifies the standalone `nocturne-resource-monitor-agent` Linux DRM/sysfs GPU provider.
 *
 * Operation:
 * Creates temporary Linux GPU fixtures with DRM card device directories,
 * AMD-style VRAM usage files, alternate kernel VRAM filenames, and an
 * NVIDIA-style procfs fixture and NVML sample, then asks the helper library to
 * collect GPU metrics without executing vendor commands.
 *
 * Expected:
 * The helper reports available GPU metrics from DRM/sysfs when those files are
 * present, accepts multiple DRM/sysfs VRAM filename conventions before falling
 * back to NVIDIA procfs and then NVML, treats VRAM-only procfs data as an
 * available GPU metric with unavailable compute details, preserves per-device
 * VRAM and compute details, and does not require `nvidia-smi` or any external
 * process.
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
    assert_eq!(metric.gpus[0].compute_percent, Some(37.5));
}

#[test]
fn linux_gpu_provider_falls_back_to_nvidia_procfs_before_nvml() {
    let root = tempdir().expect("tempdir");
    let device = root
        .path()
        .join("class")
        .join("drm")
        .join("card0")
        .join("device");
    fs::create_dir_all(&device).expect("device dir");
    fs::write(device.join("product_name"), "NVIDIA RTX").expect("product name");
    let gpu_info = root
        .path()
        .join("proc")
        .join("driver")
        .join("nvidia")
        .join("gpus")
        .join("0000_01_00.0");
    fs::create_dir_all(&gpu_info).expect("gpu proc dir");
    fs::write(
        gpu_info.join("information"),
        "Model: NVIDIA RTX 6000 Ada\nIRQ: 141\n",
    )
    .expect("information");
    fs::write(
        gpu_info.join("fb_memory_usage"),
        "Total: 49140 MiB\nReserved: 640 MiB\nUsed: 2048 MiB\nFree: 46452 MiB\n",
    )
    .expect("fb memory");

    let metric = collect_linux_gpu_metric_from_sources_for_test(
        root.path(),
        vec![LinuxNvmlDeviceSample {
            id: "nvml-0".to_string(),
            label: "NVML fallback should not be used".to_string(),
            compute_percent: 99.0,
            memory_used: 1,
            memory_total: 2,
        }],
    );

    assert_eq!(metric.metric, ResourceMetricKind::Gpu);
    assert_eq!(metric.status, ResourceMonitorAgentMetricStatus::Available);
    assert_eq!(metric.used, Some(2048 * 1024 * 1024));
    assert_eq!(metric.total, Some(49140 * 1024 * 1024));
    assert_eq!(metric.percent, Some(0.0));
    assert_eq!(metric.gpus.len(), 1);
    assert_eq!(metric.gpus[0].id, "nvidia-0000_01_00.0");
    assert_eq!(metric.gpus[0].label, "NVIDIA RTX 6000 Ada");
    assert_eq!(metric.gpus[0].compute_percent, None);
    assert_eq!(
        metric.gpus[0].compute_unavailable_reason.as_deref(),
        Some("NVIDIA procfs does not expose compute utilization")
    );
}

#[test]
fn linux_drm_sysfs_accepts_alternate_vram_file_names_before_nvml() {
    let root = tempdir().expect("tempdir");
    let device = root
        .path()
        .join("class")
        .join("drm")
        .join("card0")
        .join("device");
    fs::create_dir_all(&device).expect("device dir");
    fs::write(device.join("device_name"), "DRM NVIDIA").expect("device name");
    fs::write(device.join("mem_info_vram_used_bytes"), "1073741824").expect("used");
    fs::write(device.join("mem_info_vram_total_bytes"), "8589934592").expect("total");

    let metric = collect_linux_gpu_metric_from_sources_for_test(
        root.path(),
        vec![LinuxNvmlDeviceSample {
            id: "nvml-0".to_string(),
            label: "NVML fallback should not be used".to_string(),
            compute_percent: 99.0,
            memory_used: 1,
            memory_total: 2,
        }],
    );

    assert_eq!(metric.metric, ResourceMetricKind::Gpu);
    assert_eq!(metric.status, ResourceMonitorAgentMetricStatus::Available);
    assert_eq!(metric.used, Some(1024 * 1024 * 1024));
    assert_eq!(metric.total, Some(8 * 1024 * 1024 * 1024));
    assert_eq!(metric.percent, Some(0.0));
    assert_eq!(metric.gpus.len(), 1);
    assert_eq!(metric.gpus[0].id, "card0");
    assert_eq!(metric.gpus[0].label, "DRM NVIDIA");
}

fn write_gpu(root: &Path, card: &str, label: &str, used: u64, total: u64) {
    let device = root.join("class").join("drm").join(card).join("device");
    fs::create_dir_all(&device).expect("device dir");
    fs::write(device.join("product_name"), label).expect("product name");
    fs::write(device.join("mem_info_vram_used"), used.to_string()).expect("used");
    fs::write(device.join("mem_info_vram_total"), total.to_string()).expect("total");
}
