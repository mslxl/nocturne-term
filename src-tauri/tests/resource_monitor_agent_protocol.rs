/*
 * Test content:
 *
 * Feature:
 * Verifies the `nocturne-resource-monitor-agent` Resource Monitor NDJSON protocol and
 * helper metric normalization.
 *
 * Operation:
 * Parses a fixture NDJSON stream containing `hello`, `snapshot`, `warning`,
 * and `error` events, then normalizes helper snapshot metrics into the shared
 * Resource Monitor metric model without starting a helper process.
 *
 * Expected:
 * Each NDJSON line is parsed as one complete JSON event, the hello event
 * exposes helper capabilities and target OS/architecture, snapshot metrics
 * normalize available and unavailable metric values, and warning/error events
 * preserve their messages.
 */
use nocturne_lib::{
    normalize_resource_monitor_agent_metric_for_test, parse_resource_monitor_agent_ndjson_for_test,
    LocalDiskMountMetric, LocalResourceMetricAvailability, LocalResourceMetricDetails,
    LocalResourceMetricKind, RemoteResourceTargetArch, RemoteResourceTargetOs,
    ResourceMonitorAgentDiskMount, ResourceMonitorAgentEvent, ResourceMonitorAgentMetric,
};

#[test]
fn parses_resource_monitor_agent_ndjson_events() {
    let events = parse_resource_monitor_agent_ndjson_for_test(
        r#"
{"type":"hello","version":"0.1.0","os":"linux","arch":"x86_64","capabilities":["resource.cpu","resource.memory","resource.swap"]}
{"type":"snapshot","metrics":[{"metric":"memory","status":"available","used":8,"total":16,"available":6},{"metric":"gpu","status":"unavailable","reason":"No GPU device found"}]}
{"type":"warning","message":"GPU provider unavailable"}
{"type":"error","message":"snapshot failed"}
"#,
    )
    .expect("NDJSON should parse");

    assert_eq!(events.len(), 4);
    assert_eq!(
        events[0],
        ResourceMonitorAgentEvent::Hello {
            version: "0.1.0".to_string(),
            os: RemoteResourceTargetOs::Linux,
            arch: RemoteResourceTargetArch::X86_64,
            capabilities: vec![
                "resource.cpu".to_string(),
                "resource.memory".to_string(),
                "resource.swap".to_string(),
            ],
        }
    );
    match &events[1] {
        ResourceMonitorAgentEvent::Snapshot { metrics } => {
            assert_eq!(metrics.len(), 2);
            assert_eq!(metrics[0].metric, LocalResourceMetricKind::Memory);
            assert_eq!(metrics[1].metric, LocalResourceMetricKind::Gpu);
        }
        other => panic!("expected snapshot event, got {other:?}"),
    }
    assert_eq!(
        events[2],
        ResourceMonitorAgentEvent::Warning {
            message: "GPU provider unavailable".to_string()
        }
    );
    assert_eq!(
        events[3],
        ResourceMonitorAgentEvent::Error {
            message: "snapshot failed".to_string()
        }
    );
}

#[test]
fn normalizes_resource_monitor_agent_available_and_unavailable_metrics() {
    let memory = normalize_resource_monitor_agent_metric_for_test(ResourceMonitorAgentMetric {
        metric: LocalResourceMetricKind::Memory,
        status: "available".to_string(),
        used: Some(8),
        total: Some(16),
        percent: None,
        available: Some(6),
        free: None,
        reason: None,
        cores: Vec::new(),
        gpus: Vec::new(),
        disks: Vec::new(),
    })
    .expect("memory metric should normalize");

    match memory.availability {
        LocalResourceMetricAvailability::Available {
            used,
            total,
            percent,
            available,
            ..
        } => {
            assert_eq!(used, 8);
            assert_eq!(total, 16);
            assert_eq!(percent, 50.0);
            assert_eq!(available, Some(6));
        }
        LocalResourceMetricAvailability::Unavailable { reason } => {
            panic!("memory should be available, got {reason}");
        }
    }

    let gpu = normalize_resource_monitor_agent_metric_for_test(ResourceMonitorAgentMetric {
        metric: LocalResourceMetricKind::Gpu,
        status: "unavailable".to_string(),
        used: None,
        total: None,
        percent: None,
        available: None,
        free: None,
        reason: Some("GPU provider command not found".to_string()),
        cores: Vec::new(),
        gpus: Vec::new(),
        disks: Vec::new(),
    })
    .expect("gpu metric should normalize");

    match gpu.availability {
        LocalResourceMetricAvailability::Available { .. } => panic!("GPU should be unavailable"),
        LocalResourceMetricAvailability::Unavailable { reason } => {
            assert_eq!(reason, "GPU provider command not found");
        }
    }
}

#[test]
fn normalizes_resource_monitor_agent_disk_mount_details() {
    let disk = normalize_resource_monitor_agent_metric_for_test(ResourceMonitorAgentMetric {
        metric: LocalResourceMetricKind::Disk,
        status: "available".to_string(),
        used: Some(60),
        total: Some(100),
        percent: Some(60.0),
        available: Some(40),
        free: Some(40),
        reason: None,
        cores: Vec::new(),
        gpus: Vec::new(),
        disks: vec![ResourceMonitorAgentDiskMount {
            id: "/".to_string(),
            mount_point: "/".to_string(),
            device_name: "/dev/nvme0n1p2".to_string(),
            file_system: "ext4".to_string(),
            used: 60,
            total: 100,
            available: 40,
            percent: 60.0,
        }],
    })
    .expect("Disk metric should normalize");

    match disk.availability {
        LocalResourceMetricAvailability::Available {
            used,
            total,
            available,
            details,
            ..
        } => {
            assert_eq!(used, 60);
            assert_eq!(total, 100);
            assert_eq!(available, Some(40));
            assert_eq!(
                details,
                LocalResourceMetricDetails::DiskMounts(vec![LocalDiskMountMetric {
                    id: "/".to_string(),
                    mount_point: "/".to_string(),
                    device_name: "/dev/nvme0n1p2".to_string(),
                    file_system: "ext4".to_string(),
                    used: 60,
                    total: 100,
                    available: 40,
                    percent: 60.0,
                }])
            );
        }
        LocalResourceMetricAvailability::Unavailable { reason } => {
            panic!("Disk should be available, got {reason}");
        }
    }
}

#[test]
fn normalizes_resource_monitor_agent_cpu_core_details() {
    let cpu = normalize_resource_monitor_agent_metric_for_test(ResourceMonitorAgentMetric {
        metric: LocalResourceMetricKind::Cpu,
        status: "available".to_string(),
        used: Some(0),
        total: Some(100),
        percent: Some(42.0),
        available: None,
        free: None,
        reason: None,
        cores: vec![12.5, 71.5],
        gpus: Vec::new(),
        disks: Vec::new(),
    })
    .expect("CPU metric should normalize");

    match cpu.availability {
        LocalResourceMetricAvailability::Available {
            percent, details, ..
        } => {
            assert_eq!(percent, 42.0);
            assert_eq!(
                details,
                LocalResourceMetricDetails::CpuCores(vec![12.5, 71.5])
            );
        }
        LocalResourceMetricAvailability::Unavailable { reason } => {
            panic!("CPU should be available, got {reason}");
        }
    }
}
