/*
 * Test content:
 *
 * Feature:
 * Verifies pure Rust local Resource Monitor provider normalization.
 *
 * Operation:
 * Normalizes CPU, memory, swap, and GPU metric inputs, including a Linux
 * DRM/sysfs GPU fixture, without launching a Tauri WebView, an external helper
 * process, or vendor command wrappers.
 *
 * Expected:
 * Local Resource Monitor collection is described with the user-facing local
 * provider label while remaining an in-process Rust
 * provider, CPU includes per-core percentages, memory and swap normalize to
 * used / total / percent with auxiliary available/free values where known,
 * disabled swap with total zero is represented as available zero usage,
 * Linux DRM/sysfs VRAM metrics are normalized into grouped GPU device details,
 * and unavailable GPU metrics carry an explicit reason.
 */
use std::{fs, path::Path};

use nocturne_lib::{
    collect_linux_drm_gpu_metric_from_root_for_test, gpu_unavailable_metric_for_test,
    local_resource_provider_descriptor_for_test, normalize_cpu_metric_for_test,
    normalize_memory_metric_for_test, normalize_windows_gpu_pdh_samples_for_test,
    LocalGpuDeviceMetric, LocalResourceMetricAvailability, LocalResourceMetricDetails,
    LocalResourceMetricKind, WindowsGpuAdapterInfo, WindowsGpuPdhSample,
};
use tempfile::tempdir;

#[test]
fn local_provider_does_not_start_external_agent() {
    let descriptor = local_resource_provider_descriptor_for_test();

    assert_eq!(descriptor.label, "local provider");
    assert!(!descriptor.starts_external_agent);
}

#[test]
fn cpu_metric_normalizes_overall_and_per_core_percentages() {
    let metric = normalize_cpu_metric_for_test(42.5, vec![10.0, 75.0]);

    assert_eq!(metric.kind, LocalResourceMetricKind::Cpu);
    match metric.availability {
        LocalResourceMetricAvailability::Available {
            percent, details, ..
        } => {
            assert_eq!(percent, 42.5);
            assert_eq!(
                details,
                LocalResourceMetricDetails::CpuCores(vec![10.0, 75.0])
            );
        }
        LocalResourceMetricAvailability::Unavailable { reason } => {
            panic!("CPU should be available, got {reason}");
        }
    }
}

#[test]
fn memory_metric_normalizes_used_total_percent_and_available_memory() {
    let metric = normalize_memory_metric_for_test(
        LocalResourceMetricKind::Memory,
        8 * 1024,
        16 * 1024,
        Some(6 * 1024),
        None,
    );

    assert_eq!(metric.kind, LocalResourceMetricKind::Memory);
    match metric.availability {
        LocalResourceMetricAvailability::Available {
            used,
            total,
            percent,
            available,
            free,
            ..
        } => {
            assert_eq!(used, 8 * 1024);
            assert_eq!(total, 16 * 1024);
            assert_eq!(percent, 50.0);
            assert_eq!(available, Some(6 * 1024));
            assert_eq!(free, None);
        }
        LocalResourceMetricAvailability::Unavailable { reason } => {
            panic!("memory should be available, got {reason}");
        }
    }
}

#[test]
fn memory_with_zero_total_is_unavailable_but_disabled_swap_is_available() {
    let memory =
        normalize_memory_metric_for_test(LocalResourceMetricKind::Memory, 0, 0, None, None);
    match memory.availability {
        LocalResourceMetricAvailability::Available { .. } => {
            panic!("zero-total memory should fail")
        }
        LocalResourceMetricAvailability::Unavailable { reason } => {
            assert!(
                reason.contains("memory total is zero"),
                "unexpected reason: {reason}"
            );
        }
    }

    let swap = normalize_memory_metric_for_test(LocalResourceMetricKind::Swap, 0, 0, None, Some(0));
    match swap.availability {
        LocalResourceMetricAvailability::Available {
            used,
            total,
            percent,
            free,
            ..
        } => {
            assert_eq!(used, 0);
            assert_eq!(total, 0);
            assert_eq!(percent, 0.0);
            assert_eq!(free, Some(0));
        }
        LocalResourceMetricAvailability::Unavailable { reason } => {
            panic!("disabled swap should be available zero usage, got {reason}");
        }
    }
}

#[test]
fn gpu_unavailable_metric_preserves_reason() {
    let metric = gpu_unavailable_metric_for_test("No reliable local GPU provider is available.");

    assert_eq!(metric.kind, LocalResourceMetricKind::Gpu);
    match metric.availability {
        LocalResourceMetricAvailability::Available { .. } => panic!("GPU should be unavailable"),
        LocalResourceMetricAvailability::Unavailable { reason } => {
            assert_eq!(reason, "No reliable local GPU provider is available.");
        }
    }
}

#[test]
fn linux_drm_sysfs_normalizes_grouped_gpu_devices() {
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

    assert_eq!(metric.kind, LocalResourceMetricKind::Gpu);
    match metric.availability {
        LocalResourceMetricAvailability::Available {
            used,
            total,
            percent,
            details,
            ..
        } => {
            assert_eq!(used, 768 * 1024 * 1024);
            assert_eq!(total, 3 * 1024 * 1024 * 1024);
            assert_eq!(percent, 0.0);
            assert_eq!(
                details,
                LocalResourceMetricDetails::GpuDevices(vec![
                    LocalGpuDeviceMetric {
                        id: "card0".to_string(),
                        label: "AMD Radeon".to_string(),
                        compute_percent: 0.0,
                        memory_used: 512 * 1024 * 1024,
                        memory_total: 2 * 1024 * 1024 * 1024,
                    },
                    LocalGpuDeviceMetric {
                        id: "card1".to_string(),
                        label: "Intel Arc".to_string(),
                        compute_percent: 0.0,
                        memory_used: 256 * 1024 * 1024,
                        memory_total: 1024 * 1024 * 1024,
                    },
                ])
            );
        }
        LocalResourceMetricAvailability::Unavailable { reason } => {
            panic!("GPU should be available, got {reason}");
        }
    }
}

#[test]
fn windows_pdh_samples_normalize_grouped_gpu_devices() {
    let metric = normalize_windows_gpu_pdh_samples_for_test(
        vec![
            WindowsGpuPdhSample::memory(
                "luid_0x00000000_0x00012ABC_phys_0_dedicated",
                1024 * 1024 * 1024,
            ),
            WindowsGpuPdhSample::engine(
                "pid_1234_luid_0x00000000_0x00012ABC_phys_0_eng_0_engtype_3D",
                12.5,
            ),
            WindowsGpuPdhSample::engine(
                "pid_5678_luid_0x00000000_0x00012abc_phys_0_eng_1_engtype_Compute_0",
                7.5,
            ),
            WindowsGpuPdhSample::memory(
                "luid_0x00000000_0x00034def_phys_0_dedicated",
                2 * 1024 * 1024 * 1024,
            ),
            WindowsGpuPdhSample::engine("luid_0x00000000_0x00034def_engtype_3D", 40.0),
        ],
        vec![
            WindowsGpuAdapterInfo::new(
                "luid_0x00000000_0x00012abc",
                "NVIDIA RTX",
                4 * 1024 * 1024 * 1024,
            ),
            WindowsGpuAdapterInfo::new(
                "luid_0x00000000_0x00034def",
                "AMD Radeon",
                8 * 1024 * 1024 * 1024,
            ),
        ],
    );

    assert_eq!(metric.kind, LocalResourceMetricKind::Gpu);
    match metric.availability {
        LocalResourceMetricAvailability::Available {
            used,
            total,
            percent,
            details,
            ..
        } => {
            assert_eq!(used, 3 * 1024 * 1024 * 1024);
            assert_eq!(total, 12 * 1024 * 1024 * 1024);
            assert_eq!(percent, 30.0);
            assert_eq!(
                details,
                LocalResourceMetricDetails::GpuDevices(vec![
                    LocalGpuDeviceMetric {
                        id: "luid_0x00000000_0x00012abc".to_string(),
                        label: "NVIDIA RTX".to_string(),
                        compute_percent: 20.0,
                        memory_used: 1024 * 1024 * 1024,
                        memory_total: 4 * 1024 * 1024 * 1024,
                    },
                    LocalGpuDeviceMetric {
                        id: "luid_0x00000000_0x00034def".to_string(),
                        label: "AMD Radeon".to_string(),
                        compute_percent: 40.0,
                        memory_used: 2 * 1024 * 1024 * 1024,
                        memory_total: 8 * 1024 * 1024 * 1024,
                    },
                ])
            );
        }
        LocalResourceMetricAvailability::Unavailable { reason } => {
            panic!("Windows PDH GPU samples should be available, got {reason}");
        }
    }
}

fn write_gpu(root: &Path, card: &str, label: &str, used: u64, total: u64) {
    let device = root.join("class").join("drm").join(card).join("device");
    fs::create_dir_all(&device).expect("device dir");
    fs::write(device.join("product_name"), label).expect("product name");
    fs::write(device.join("mem_info_vram_used"), used.to_string()).expect("used");
    fs::write(device.join("mem_info_vram_total"), total.to_string()).expect("total");
}
