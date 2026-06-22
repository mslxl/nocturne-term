/*
 * Test content:
 *
 * Feature:
 * Verifies remote Resource Monitor system-command provider planning and output
 * parsing for Linux, macOS, and Windows targets.
 *
 * Operation:
 * Builds provider command plans for target operating systems and parses fixture
 * command outputs for Linux `free -b`, Linux/macOS `df`, macOS memory data, and
 * Windows memory/disk data without executing platform-specific commands on the
 * test machine.
 *
 * Expected:
 * Provider selection returns explicit system-command plans per target OS,
 * parsing normalizes memory, swap, and disk into used / total / percent metrics
 * with mount point details, unsupported or missing command coverage produces
 * unavailable reasons, and the provider is marked as running collection work
 * off the Tauri command thread.
 */
use nocturne_lib::{
    parse_linux_free_b_for_test, parse_linux_nvidia_smi_csv_for_test,
    parse_linux_proc_stat_cpu_for_test, parse_macos_disk_df_for_test, parse_macos_memory_for_test,
    parse_unix_disk_df_for_test, parse_windows_disk_for_test, parse_windows_memory_for_test,
    remote_system_command_plan_for_test, remote_system_provider_runs_off_command_thread_for_test,
    LocalDiskMountMetric, LocalGpuDeviceMetric, LocalResourceMetricAvailability,
    LocalResourceMetricDetails, LocalResourceMetricKind, RemoteResourceTargetOs,
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
    assert!(linux
        .commands
        .iter()
        .any(|command| command.contains("df -P -kT")));

    let macos = remote_system_command_plan_for_test(RemoteResourceTargetOs::Macos);
    assert!(macos
        .commands
        .iter()
        .any(|command| command.contains("vm_stat")));
    assert!(macos
        .commands
        .iter()
        .any(|command| command.contains("sysctl")));
    assert!(macos
        .commands
        .iter()
        .any(|command| command.contains("df -P -k")));

    let windows = remote_system_command_plan_for_test(RemoteResourceTargetOs::Windows);
    assert!(windows
        .commands
        .iter()
        .any(|command| command.contains("Get-CimInstance")));
    assert!(windows
        .commands
        .iter()
        .any(|command| command.contains("Win32_LogicalDisk")));
}

#[test]
fn linux_proc_stat_output_normalizes_cpu_usage() {
    let metric = parse_linux_proc_stat_cpu_for_test(
        r#"
        cpu  100 0 100 800 0 0 0 0 0 0
        cpu0 50 0 50 400 0 0 0 0 0 0
        cpu1 25 0 25 450 0 0 0 0 0 0
        "#,
    )
    .expect("linux proc stat output should parse");

    assert_eq!(metric.kind, LocalResourceMetricKind::Cpu);
    match metric.availability {
        LocalResourceMetricAvailability::Available {
            percent, details, ..
        } => {
            assert_eq!(percent, 20.0);
            assert_eq!(
                details,
                LocalResourceMetricDetails::CpuCores(vec![20.0, 10.0])
            );
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
                        compute_percent: Some(37.5),
                        compute_unavailable_reason: None,
                        memory_used: 4096 * 1024 * 1024,
                        memory_total: 24576 * 1024 * 1024,
                    },
                    LocalGpuDeviceMetric {
                        id: "nvidia-1".to_string(),
                        label: "NVIDIA A10".to_string(),
                        compute_percent: Some(5.0),
                        compute_unavailable_reason: None,
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
fn linux_df_output_normalizes_disk_mounts_and_filters_pseudo_filesystems() {
    let metric = parse_unix_disk_df_for_test(
        true,
        r#"
Filesystem     Type     1K-blocks      Used Available Use% Mounted on
/dev/nvme0n1p2 ext4     104857600  62914560  41943040  60% /
tmpfs          tmpfs      1048576        10   1048566   1% /run
/dev/sdb1      xfs     1048576000 524288000 524288000  50% /data
"#,
    )
    .expect("linux df output should parse");

    assert_eq!(metric.kind, LocalResourceMetricKind::Disk);
    match metric.availability {
        LocalResourceMetricAvailability::Available {
            used,
            total,
            percent,
            available,
            details,
            ..
        } => {
            assert_eq!(used, (62914560 + 524288000) * 1024);
            assert_eq!(total, (104857600 + 1048576000) * 1024);
            assert_eq!(available, Some((41943040 + 524288000) * 1024));
            assert_eq!(percent, 51.0);
            assert_eq!(
                details,
                LocalResourceMetricDetails::DiskMounts(vec![
                    LocalDiskMountMetric {
                        id: "/".to_string(),
                        mount_point: "/".to_string(),
                        device_name: "/dev/nvme0n1p2".to_string(),
                        file_system: "ext4".to_string(),
                        used: 62914560 * 1024,
                        total: 104857600 * 1024,
                        available: 41943040 * 1024,
                        percent: 60.0,
                    },
                    LocalDiskMountMetric {
                        id: "/data".to_string(),
                        mount_point: "/data".to_string(),
                        device_name: "/dev/sdb1".to_string(),
                        file_system: "xfs".to_string(),
                        used: 524288000 * 1024,
                        total: 1048576000 * 1024,
                        available: 524288000 * 1024,
                        percent: 50.0,
                    },
                ])
            );
        }
        LocalResourceMetricAvailability::Unavailable { reason } => {
            panic!("disk should be available, got {reason}");
        }
    }
}

#[test]
fn macos_df_output_normalizes_disk_mounts_without_filesystem_type() {
    let metric = parse_macos_disk_df_for_test(
        r#"
Filesystem   1024-blocks      Used Available Capacity Mounted on
/dev/disk3s5  104857600  62914560  41943040    60%    /
/dev/disk5s1  209715200 104857600 104857600    50%    /Volumes/Data
"#,
    )
    .expect("macos df output should parse");

    assert_eq!(metric.kind, LocalResourceMetricKind::Disk);
    match metric.availability {
        LocalResourceMetricAvailability::Available { details, .. } => {
            assert_eq!(
                details,
                LocalResourceMetricDetails::DiskMounts(vec![
                    LocalDiskMountMetric {
                        id: "/".to_string(),
                        mount_point: "/".to_string(),
                        device_name: "/dev/disk3s5".to_string(),
                        file_system: "unknown".to_string(),
                        used: 62914560 * 1024,
                        total: 104857600 * 1024,
                        available: 41943040 * 1024,
                        percent: 60.0,
                    },
                    LocalDiskMountMetric {
                        id: "/Volumes/Data".to_string(),
                        mount_point: "/Volumes/Data".to_string(),
                        device_name: "/dev/disk5s1".to_string(),
                        file_system: "unknown".to_string(),
                        used: 104857600 * 1024,
                        total: 209715200 * 1024,
                        available: 104857600 * 1024,
                        percent: 50.0,
                    },
                ])
            );
        }
        LocalResourceMetricAvailability::Unavailable { reason } => {
            panic!("disk should be available, got {reason}");
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

#[test]
fn windows_logical_disk_values_normalize_disk_mounts() {
    let metric = parse_windows_disk_for_test(vec![
        (
            "C:".to_string(),
            "NTFS".to_string(),
            Some(100 * 1024 * 1024 * 1024),
            Some(40 * 1024 * 1024 * 1024),
        ),
        (
            "D:".to_string(),
            "ReFS".to_string(),
            Some(200 * 1024 * 1024 * 1024),
            Some(150 * 1024 * 1024 * 1024),
        ),
    ]);

    assert_eq!(metric.kind, LocalResourceMetricKind::Disk);
    match metric.availability {
        LocalResourceMetricAvailability::Available {
            used,
            total,
            available,
            details,
            ..
        } => {
            assert_eq!(used, 110 * 1024 * 1024 * 1024);
            assert_eq!(total, 300 * 1024 * 1024 * 1024);
            assert_eq!(available, Some(190 * 1024 * 1024 * 1024));
            assert_eq!(
                details,
                LocalResourceMetricDetails::DiskMounts(vec![
                    LocalDiskMountMetric {
                        id: "C:\\".to_string(),
                        mount_point: "C:\\".to_string(),
                        device_name: "C:".to_string(),
                        file_system: "NTFS".to_string(),
                        used: 60 * 1024 * 1024 * 1024,
                        total: 100 * 1024 * 1024 * 1024,
                        available: 40 * 1024 * 1024 * 1024,
                        percent: 60.0,
                    },
                    LocalDiskMountMetric {
                        id: "D:\\".to_string(),
                        mount_point: "D:\\".to_string(),
                        device_name: "D:".to_string(),
                        file_system: "ReFS".to_string(),
                        used: 50 * 1024 * 1024 * 1024,
                        total: 200 * 1024 * 1024 * 1024,
                        available: 150 * 1024 * 1024 * 1024,
                        percent: 25.0,
                    },
                ])
            );
        }
        LocalResourceMetricAvailability::Unavailable { reason } => {
            panic!("disk should be available, got {reason}");
        }
    }
}
