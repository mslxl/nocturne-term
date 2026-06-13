/*
 * Test content:
 *
 * Feature:
 * Verifies Resource Monitor target operating-system and architecture detection
 * for remote helper selection.
 *
 * Operation:
 * Resolves target OS/architecture from optional Host resource config, parses
 * fixture outputs from Unix `uname` and Windows platform commands, and simulates
 * a failed detection where the user cancels manual selection.
 *
 * Expected:
 * Explicit Host config wins over command output, supported Linux/macOS/Windows
 * command outputs map to structured target OS/architecture values, failed
 * detection does not guess, and helper-backed metrics become unavailable with
 * the explicit `Target OS/architecture unknown` reason when the user cancels.
 */
use nocturne_lib::{
    helper_target_unknown_metric_for_test, parse_remote_uname_for_test,
    parse_remote_windows_platform_for_test, resolve_resource_target_for_test, HostResourceConfig,
    LocalResourceMetricAvailability, LocalResourceMetricKind, RemoteResourceTargetArch,
    RemoteResourceTargetDetection, RemoteResourceTargetOs,
};

#[test]
fn configured_host_resource_target_wins_over_command_output() {
    let detection = resolve_resource_target_for_test(
        Some(HostResourceConfig {
            target_os: Some(RemoteResourceTargetOs::Linux),
            target_arch: Some(RemoteResourceTargetArch::X86_64),
        }),
        Some(("Darwin", "arm64")),
    );

    assert_eq!(
        detection,
        RemoteResourceTargetDetection::Detected {
            os: RemoteResourceTargetOs::Linux,
            arch: RemoteResourceTargetArch::X86_64,
            source: "host_config",
        }
    );
}

#[test]
fn unix_uname_output_maps_to_structured_targets() {
    assert_eq!(
        parse_remote_uname_for_test("Linux\n", "x86_64\n"),
        RemoteResourceTargetDetection::Detected {
            os: RemoteResourceTargetOs::Linux,
            arch: RemoteResourceTargetArch::X86_64,
            source: "remote_uname",
        }
    );
    assert_eq!(
        parse_remote_uname_for_test("Darwin\n", "arm64\n"),
        RemoteResourceTargetDetection::Detected {
            os: RemoteResourceTargetOs::Macos,
            arch: RemoteResourceTargetArch::Aarch64,
            source: "remote_uname",
        }
    );
}

#[test]
fn windows_platform_output_maps_to_structured_targets() {
    assert_eq!(
        parse_remote_windows_platform_for_test("Microsoft Windows Server 2022", "AMD64"),
        RemoteResourceTargetDetection::Detected {
            os: RemoteResourceTargetOs::Windows,
            arch: RemoteResourceTargetArch::X86_64,
            source: "remote_windows_platform",
        }
    );
}

#[test]
fn detection_failure_requires_user_choice_without_guessing() {
    assert_eq!(
        parse_remote_uname_for_test("Plan 9", "mips"),
        RemoteResourceTargetDetection::Unknown {
            reason: "Unsupported remote target OS or architecture".to_string(),
            requires_user_choice: true,
        }
    );
    assert_eq!(
        resolve_resource_target_for_test(
            Some(HostResourceConfig {
                target_os: Some(RemoteResourceTargetOs::Linux),
                target_arch: None,
            }),
            None,
        ),
        RemoteResourceTargetDetection::Unknown {
            reason: "Host resource target config is incomplete".to_string(),
            requires_user_choice: true,
        }
    );
}

#[test]
fn user_cancelled_target_selection_makes_helper_metric_unavailable() {
    let metric = helper_target_unknown_metric_for_test(LocalResourceMetricKind::Gpu);

    assert_eq!(metric.kind, LocalResourceMetricKind::Gpu);
    match metric.availability {
        LocalResourceMetricAvailability::Available { .. } => {
            panic!("helper metric should be unavailable")
        }
        LocalResourceMetricAvailability::Unavailable { reason } => {
            assert_eq!(reason, "Target OS/architecture unknown");
        }
    }
}
