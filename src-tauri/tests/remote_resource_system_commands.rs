/*
 * Test content:
 *
 * Feature:
 * Verifies remote Resource Monitor system-command provider planning and output
 * parsing for Linux, macOS, and Windows targets.
 *
 * Operation:
 * Builds provider command plans for target operating systems and parses fixture
 * command outputs for Linux `free -b`, macOS memory data, and Windows memory
 * data without executing platform-specific commands on the test machine.
 *
 * Expected:
 * Provider selection returns explicit system-command plans per target OS,
 * parsing normalizes memory and swap into used / total / percent metrics,
 * unsupported or missing command coverage produces unavailable reasons, and the
 * provider is marked as running collection work off the Tauri command thread.
 */
use nocturne_lib::{
    parse_linux_free_b_for_test, parse_linux_nvidia_smi_csv_for_test,
    parse_linux_proc_stat_cpu_for_test, parse_macos_memory_for_test, parse_windows_memory_for_test,
    remote_system_command_plan_for_test, remote_system_provider_runs_off_command_thread_for_test,
    LocalGpuDeviceMetric, LocalResourceMetricAvailability, LocalResourceMetricDetails,
    LocalResourceMetricKind, RemoteResourceTargetOs,
};

#[test]
fn remote_system_command_plans_are_selected_by_target_os() {
    let linux = remote_system_command_plan_for_test(RemoteResourceTargetOs::Linux);
    assert_eq!(linux.provider_label, "system commands on remote");
    assert!(linux
        .commands
        .iter()
        .any(|command| command.contains("free -b")));
    assert!(linux
        .commands
        .iter()
        .any(|command| command.contains("/proc/stat")));
    assert!(linux
        .commands
        .iter()
        .any(|command| command.contains("nvidia-smi")));

    let macos = remote_system_command_plan_for_test(RemoteResourceTargetOs::Macos);
    assert!(macos
        .commands
        .iter()
        .any(|command| command.contains("vm_stat")));
    assert!(macos
        .commands
        .iter()
        .any(|command| command.contains("sysctl")));

    let windows = remote_system_command_plan_for_test(RemoteResourceTargetOs::Windows);
    assert!(windows
        .commands
        .iter()
        .any(|command| command.contains("Get-CimInstance")));
}

#[test]
fn linux_proc_stat_output_normalizes_cpu_usage() {
    let metric = parse_linux_proc_stat_cpu_for_test("cpu  100 0 100 800 0 0 0 0 0 0\n")
        .expect("linux proc stat output should parse");

    assert_eq!(metric.kind, LocalResourceMetricKind::Cpu);
    match metric.availability {
        LocalResourceMetricAvailability::Available {
            percent, details, ..
        } => {
            assert_eq!(percent, 20.0);
            assert_eq!(details, LocalResourceMetricDetails::CpuCores(Vec::new()));
        }
        LocalResourceMetricAvailability::Unavailable { reason } => {
            panic!("cpu unavailable: {reason}");
        }
    }
}

#[test]
fn linux_nvidia_smi_csv_normalizes_gpu_devices_for_command_only_provider() {
    let metric = parse_linux_nvidia_smi_csv_for_test(
        r#"
        0, NVIDIA RTX 4090, 37.5, 4096, 24576
        1, NVIDIA A10, 5, 1024, 23028
        "#,
    )
    .expect("nvidia-smi output should parse");

    assert_eq!(metric.kind, LocalResourceMetricKind::Gpu);
    match metric.availability {
        LocalResourceMetricAvailability::Available {
            used,
            total,
            percent,
            details,
            ..
        } => {
            assert_eq!(used, (4096 + 1024) * 1024 * 1024);
            assert_eq!(total, (24576 + 23028) * 1024 * 1024);
            assert_eq!(percent, 21.25);
            assert_eq!(
                details,
                LocalResourceMetricDetails::GpuDevices(vec![
                    LocalGpuDeviceMetric {
                        id: "nvidia-0".to_string(),
                        label: "NVIDIA RTX 4090".to_string(),
                        compute_percent: 37.5,
                        memory_used: 4096 * 1024 * 1024,
                        memory_total: 24576 * 1024 * 1024,
                    },
                    LocalGpuDeviceMetric {
                        id: "nvidia-1".to_string(),
                        label: "NVIDIA A10".to_string(),
                        compute_percent: 5.0,
                        memory_used: 1024 * 1024 * 1024,
                        memory_total: 23028 * 1024 * 1024,
                    },
                ])
            );
        }
        LocalResourceMetricAvailability::Unavailable { reason } => {
            panic!("gpu unavailable: {reason}");
        }
    }
}

#[test]
fn remote_system_provider_runs_collection_off_tauri_command_thread() {
    assert!(remote_system_provider_runs_off_command_thread_for_test());
}

#[test]
fn linux_free_output_normalizes_memory_and_swap() {
    let metrics = parse_linux_free_b_for_test(
        r#"
                     total        used        free      shared  buff/cache   available
        Mem:   17179869184  8589934592  1073741824   268435456  7516192768  6442450944
        Swap:   4294967296  1073741824  3221225472
        "#,
    )
    .expect("linux free output should parse");

    let memory = metrics
        .iter()
        .find(|metric| metric.kind == LocalResourceMetricKind::Memory)
        .expect("memory metric");
    match memory.availability.clone() {
        LocalResourceMetricAvailability::Available {
            used,
            total,
            percent,
            available,
            ..
        } => {
            assert_eq!(used, 8589934592);
            assert_eq!(total, 17179869184);
            assert_eq!(percent, 50.0);
            assert_eq!(available, Some(6442450944));
        }
        LocalResourceMetricAvailability::Unavailable { reason } => {
            panic!("memory unavailable: {reason}")
        }
    }

    let swap = metrics
        .iter()
        .find(|metric| metric.kind == LocalResourceMetricKind::Swap)
        .expect("swap metric");
    match swap.availability.clone() {
        LocalResourceMetricAvailability::Available {
            used,
            total,
            percent,
            free,
            ..
        } => {
            assert_eq!(used, 1073741824);
            assert_eq!(total, 4294967296);
            assert_eq!(percent, 25.0);
            assert_eq!(free, Some(3221225472));
        }
        LocalResourceMetricAvailability::Unavailable { reason } => {
            panic!("swap unavailable: {reason}")
        }
    }
}

#[test]
fn macos_memory_values_normalize_memory_and_disabled_swap() {
    let metrics =
        parse_macos_memory_for_test(16 * 1024 * 1024 * 1024, 6 * 1024 * 1024 * 1024, 0, 0);

    let memory = metrics
        .iter()
        .find(|metric| metric.kind == LocalResourceMetricKind::Memory)
        .expect("memory metric");
    match memory.availability.clone() {
        LocalResourceMetricAvailability::Available {
            used,
            total,
            percent,
            available,
            ..
        } => {
            assert_eq!(used, 10 * 1024 * 1024 * 1024);
            assert_eq!(total, 16 * 1024 * 1024 * 1024);
            assert_eq!(percent, 62.5);
            assert_eq!(available, Some(6 * 1024 * 1024 * 1024));
        }
        LocalResourceMetricAvailability::Unavailable { reason } => {
            panic!("memory unavailable: {reason}")
        }
    }

    let swap = metrics
        .iter()
        .find(|metric| metric.kind == LocalResourceMetricKind::Swap)
        .expect("swap metric");
    match swap.availability.clone() {
        LocalResourceMetricAvailability::Available { total, percent, .. } => {
            assert_eq!(total, 0);
            assert_eq!(percent, 0.0);
        }
        LocalResourceMetricAvailability::Unavailable { reason } => {
            panic!("swap unavailable: {reason}")
        }
    }
}

#[test]
fn windows_memory_values_normalize_memory_and_unavailable_swap_reason() {
    let metrics =
        parse_windows_memory_for_test(16 * 1024 * 1024 * 1024, 4 * 1024 * 1024 * 1024, None);

    let memory = metrics
        .iter()
        .find(|metric| metric.kind == LocalResourceMetricKind::Memory)
        .expect("memory metric");
    match memory.availability.clone() {
        LocalResourceMetricAvailability::Available {
            used,
            percent,
            available,
            ..
        } => {
            assert_eq!(used, 12 * 1024 * 1024 * 1024);
            assert_eq!(percent, 75.0);
            assert_eq!(available, Some(4 * 1024 * 1024 * 1024));
        }
        LocalResourceMetricAvailability::Unavailable { reason } => {
            panic!("memory unavailable: {reason}")
        }
    }

    let swap = metrics
        .iter()
        .find(|metric| metric.kind == LocalResourceMetricKind::Swap)
        .expect("swap metric");
    match swap.availability.clone() {
        LocalResourceMetricAvailability::Available { .. } => panic!("swap should be unavailable"),
        LocalResourceMetricAvailability::Unavailable { reason } => {
            assert!(
                reason.contains("Windows swap metrics unavailable"),
                "unexpected reason: {reason}"
            );
        }
    }
}
