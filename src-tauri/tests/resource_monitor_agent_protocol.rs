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
    LocalResourceMetricAvailability, LocalResourceMetricKind, RemoteResourceTargetArch,
    RemoteResourceTargetOs, ResourceMonitorAgentEvent, ResourceMonitorAgentMetric,
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
        gpus: Vec::new(),
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
        gpus: Vec::new(),
    })
    .expect("gpu metric should normalize");

    match gpu.availability {
        LocalResourceMetricAvailability::Available { .. } => panic!("GPU should be unavailable"),
        LocalResourceMetricAvailability::Unavailable { reason } => {
            assert_eq!(reason, "GPU provider command not found");
        }
    }
}
