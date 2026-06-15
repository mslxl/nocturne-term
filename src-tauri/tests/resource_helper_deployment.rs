/*
 * Test content:
 *
 * Feature:
 * Verifies Resource Monitor remote helper deployment manifest validation,
 * helper upload policy decisions, prompt payload content, and per-Host
 * deployment memory.
 *
 * Operation:
 * Validates a `nocturne-resource-monitor-agent` manifest, rejects mismatched helper names
 * and hashes, evaluates Ask/Never/Allow helper policies for missing or changed
 * manifests, records verified and canceled deployment decisions for one Host,
 * and builds a helper upload plan from bundled helper bytes.
 *
 * Expected:
 * Only a manifest matching helper name, purpose, target OS, target architecture,
 * upload path, checksum, and capabilities is valid. Never blocks upload with an
 * unavailable reason, Allow uploads without prompting, Ask produces a prompt
 * containing all required fields, deployment/hash verification is remembered
 * per Host without carrying credentials. A canceled Ask prompt is remembered
 * per Host and helper hash so automatic refresh ticks do not reopen the same
 * dialog forever. Upload planning creates stable target-specific resource
 * paths, remote helper paths, manifest paths, checksums, executable modes,
 * verification commands, launch commands, and manifest JSON for every
 * runtime-supported OS/architecture without requiring a live SSH connection.
 */
use nocturne_lib::{
    decide_resource_helper_deployment_for_test, plan_resource_helper_upload_for_test,
    resource_helper_resource_path_for_test, RemoteResourceTargetArch, RemoteResourceTargetOs,
    ResourceHelperDeploymentDecision, ResourceHelperDeploymentMemory,
    ResourceHelperDeploymentStatus, ResourceHelperManifest, ResourceHelperPolicy,
};

fn manifest(hash: &str) -> ResourceHelperManifest {
    ResourceHelperManifest {
        helper_name: "nocturne-resource-monitor-agent".to_string(),
        purpose: "Resource Monitor metrics".to_string(),
        version: "0.1.0".to_string(),
        target_os: RemoteResourceTargetOs::Linux,
        target_arch: RemoteResourceTargetArch::X86_64,
        upload_path: ".cache/nocturne/nocturne-resource-monitor-agent".to_string(),
        sha256: hash.to_string(),
        capabilities: vec![
            "resource.cpu".to_string(),
            "resource.memory".to_string(),
            "resource.swap".to_string(),
        ],
    }
}

#[test]
fn validates_resource_helper_manifest_identity_and_hash() {
    let expected = manifest("abc123");
    assert!(expected.validate_against(&expected).is_ok());

    let mut wrong_name = expected.clone();
    wrong_name.helper_name = "rg-helper".to_string();
    let error = wrong_name
        .validate_against(&expected)
        .expect_err("wrong helper name should fail");
    assert!(
        error.to_string().contains("helper name mismatch"),
        "unexpected error: {error}"
    );

    let wrong_hash = manifest("def456");
    let error = wrong_hash
        .validate_against(&expected)
        .expect_err("wrong hash should fail");
    assert!(
        error.to_string().contains("sha256 mismatch"),
        "unexpected error: {error}"
    );
}

#[test]
fn policy_never_blocks_missing_helper_with_reason() {
    let decision = decide_resource_helper_deployment_for_test(
        ResourceHelperPolicy::Never,
        ResourceHelperDeploymentStatus::Missing,
        "host-prod",
        "Production",
        manifest("abc123"),
    );

    assert_eq!(
        decision,
        ResourceHelperDeploymentDecision::Unavailable {
            reason: "remote helper policy is Never".to_string()
        }
    );
}

#[test]
fn policy_allow_uploads_missing_helper_without_prompt() {
    let decision = decide_resource_helper_deployment_for_test(
        ResourceHelperPolicy::Allow,
        ResourceHelperDeploymentStatus::Missing,
        "host-prod",
        "Production",
        manifest("abc123"),
    );

    assert_eq!(
        decision,
        ResourceHelperDeploymentDecision::Upload {
            host_id: "host-prod".to_string(),
            manifest: manifest("abc123"),
        }
    );
}

#[test]
fn policy_ask_returns_prompt_payload_with_required_fields() {
    let decision = decide_resource_helper_deployment_for_test(
        ResourceHelperPolicy::Ask,
        ResourceHelperDeploymentStatus::HashMismatch {
            found_sha256: "old".to_string(),
        },
        "host-prod",
        "Production",
        manifest("abc123"),
    );

    match decision {
        ResourceHelperDeploymentDecision::Prompt(prompt) => {
            assert_eq!(prompt.helper_name, "nocturne-resource-monitor-agent");
            assert_eq!(prompt.purpose, "Resource Monitor metrics");
            assert_eq!(prompt.host_id, "host-prod");
            assert_eq!(prompt.host_label, "Production");
            assert_eq!(prompt.target_os, RemoteResourceTargetOs::Linux);
            assert_eq!(prompt.target_arch, RemoteResourceTargetArch::X86_64);
            assert_eq!(
                prompt.upload_path,
                ".cache/nocturne/nocturne-resource-monitor-agent"
            );
            assert_eq!(prompt.sha256, "abc123");
            assert!(
                prompt.reason.contains("hash mismatch"),
                "unexpected reason: {}",
                prompt.reason
            );
        }
        other => panic!("expected prompt, got {other:?}"),
    }
}

#[test]
fn policy_ask_prompts_before_uploading_a_missing_helper() {
    let decision = decide_resource_helper_deployment_for_test(
        ResourceHelperPolicy::Ask,
        ResourceHelperDeploymentStatus::Missing,
        "host-prod",
        "Production",
        manifest("abc123"),
    );

    match decision {
        ResourceHelperDeploymentDecision::Prompt(prompt) => {
            assert_eq!(prompt.helper_name, "nocturne-resource-monitor-agent");
            assert_eq!(prompt.purpose, "Resource Monitor metrics");
            assert_eq!(prompt.host_id, "host-prod");
            assert!(
                prompt.reason.contains("missing"),
                "unexpected reason: {}",
                prompt.reason
            );
        }
        other => panic!("Ask policy must prompt before uploading, got {other:?}"),
    }
}

#[test]
fn remembers_verified_deployment_hash_per_host() {
    let mut memory = ResourceHelperDeploymentMemory::default();
    memory.record_verified("host-a", manifest("aaa"));
    memory.record_verified("host-b", manifest("bbb"));

    assert_eq!(memory.verified_hash("host-a"), Some("aaa"));
    assert_eq!(memory.verified_hash("host-b"), Some("bbb"));
    assert_eq!(memory.verified_hash("host-c"), None);
}

#[test]
fn remembers_canceled_upload_prompt_per_host_and_hash() {
    let mut memory = ResourceHelperDeploymentMemory::default();
    memory.record_canceled_prompt("host-a", manifest("aaa"));

    assert!(memory.has_canceled_prompt("host-a", &manifest("aaa")));
    assert!(!memory.has_canceled_prompt("host-a", &manifest("bbb")));
    assert!(!memory.has_canceled_prompt("host-b", &manifest("aaa")));
}

#[test]
fn bundled_helper_resource_paths_are_target_specific() {
    assert_eq!(
        resource_helper_resource_path_for_test(
            RemoteResourceTargetOs::Linux,
            RemoteResourceTargetArch::X86_64
        ),
        "nocturne-resource-monitor-agent/linux/x86_64/nocturne-resource-monitor-agent"
    );
    assert_eq!(
        resource_helper_resource_path_for_test(
            RemoteResourceTargetOs::Windows,
            RemoteResourceTargetArch::X86_64
        ),
        "nocturne-resource-monitor-agent/windows/x86_64/nocturne-resource-monitor-agent.exe"
    );
}

#[test]
fn upload_plan_selects_the_correct_bundled_helper_for_every_supported_target() {
    let targets = [
        (
            RemoteResourceTargetOs::Linux,
            RemoteResourceTargetArch::X86_64,
            "nocturne-resource-monitor-agent/linux/x86_64/nocturne-resource-monitor-agent",
            Some(0o755),
            "sha256sum -c -",
            "'~/.cache/nocturne/helpers/0.1.0/nocturne-resource-monitor-agent' --stream",
        ),
        (
            RemoteResourceTargetOs::Linux,
            RemoteResourceTargetArch::Aarch64,
            "nocturne-resource-monitor-agent/linux/aarch64/nocturne-resource-monitor-agent",
            Some(0o755),
            "sha256sum -c -",
            "'~/.cache/nocturne/helpers/0.1.0/nocturne-resource-monitor-agent' --stream",
        ),
        (
            RemoteResourceTargetOs::Linux,
            RemoteResourceTargetArch::Armv7,
            "nocturne-resource-monitor-agent/linux/armv7/nocturne-resource-monitor-agent",
            Some(0o755),
            "sha256sum -c -",
            "'~/.cache/nocturne/helpers/0.1.0/nocturne-resource-monitor-agent' --stream",
        ),
        (
            RemoteResourceTargetOs::Macos,
            RemoteResourceTargetArch::X86_64,
            "nocturne-resource-monitor-agent/macos/x86_64/nocturne-resource-monitor-agent",
            Some(0o755),
            "shasum -a 256",
            "'~/.cache/nocturne/helpers/0.1.0/nocturne-resource-monitor-agent' --stream",
        ),
        (
            RemoteResourceTargetOs::Macos,
            RemoteResourceTargetArch::Aarch64,
            "nocturne-resource-monitor-agent/macos/aarch64/nocturne-resource-monitor-agent",
            Some(0o755),
            "shasum -a 256",
            "'~/.cache/nocturne/helpers/0.1.0/nocturne-resource-monitor-agent' --stream",
        ),
        (
            RemoteResourceTargetOs::Windows,
            RemoteResourceTargetArch::X86_64,
            "nocturne-resource-monitor-agent/windows/x86_64/nocturne-resource-monitor-agent.exe",
            None,
            "Get-FileHash -Algorithm SHA256",
            "& '~/.cache/nocturne/helpers/0.1.0/nocturne-resource-monitor-agent.exe' --stream",
        ),
        (
            RemoteResourceTargetOs::Windows,
            RemoteResourceTargetArch::I686,
            "nocturne-resource-monitor-agent/windows/i686/nocturne-resource-monitor-agent.exe",
            None,
            "Get-FileHash -Algorithm SHA256",
            "& '~/.cache/nocturne/helpers/0.1.0/nocturne-resource-monitor-agent.exe' --stream",
        ),
    ];

    for (
        target_os,
        target_arch,
        expected_resource_path,
        expected_mode,
        expected_verify_fragment,
        expected_launch_command,
    ) in targets
    {
        let plan =
            plan_resource_helper_upload_for_test(b"agent-binary", target_os, target_arch, "0.1.0")
                .expect("upload plan should be created");

        assert_eq!(plan.resource_path, expected_resource_path);
        assert_eq!(plan.manifest.target_os, target_os);
        assert_eq!(plan.manifest.target_arch, target_arch);
        assert_eq!(plan.manifest.upload_path, plan.helper_upload_path);
        assert_eq!(plan.executable_mode, expected_mode);
        assert!(
            plan.verify_sha256_command
                .contains(expected_verify_fragment),
            "target {:?}/{:?} should use the right remote hash command: {}",
            target_os,
            target_arch,
            plan.verify_sha256_command
        );
        assert_eq!(plan.launch_stream_command, expected_launch_command);
        assert!(
            plan.manifest_json.contains(&format!(
                "\"target_arch\":\"{}\"",
                target_arch_json(target_arch)
            )),
            "manifest JSON should include target architecture: {}",
            plan.manifest_json
        );
    }
}

#[test]
fn upload_plan_hashes_helper_bytes_and_serializes_manifest() {
    let plan = plan_resource_helper_upload_for_test(
        b"agent-binary",
        RemoteResourceTargetOs::Linux,
        RemoteResourceTargetArch::X86_64,
        "0.1.0",
    )
    .expect("upload plan should be created");

    assert_eq!(
        plan.resource_path,
        "nocturne-resource-monitor-agent/linux/x86_64/nocturne-resource-monitor-agent"
    );
    assert_eq!(
        plan.manifest.upload_path,
        "~/.cache/nocturne/helpers/0.1.0/nocturne-resource-monitor-agent"
    );
    assert_eq!(
        plan.manifest_path,
        "~/.cache/nocturne/helpers/0.1.0/manifest.json"
    );
    assert_eq!(plan.helper_bytes, b"agent-binary");
    assert_eq!(
        plan.manifest.sha256,
        "f03e279954a05b1fd253a5be7299019af3ebdf44c57e0c69eecc738601ca6d35"
    );
    assert!(plan
        .manifest
        .capabilities
        .contains(&"resource.gpu".to_string()));
    assert!(
        plan.manifest_json
            .contains("\"helper_name\":\"nocturne-resource-monitor-agent\""),
        "manifest JSON must include helper identity: {}",
        plan.manifest_json
    );
}

#[test]
fn upload_plan_includes_remote_deployment_and_streaming_steps() {
    let plan = plan_resource_helper_upload_for_test(
        b"agent-binary",
        RemoteResourceTargetOs::Linux,
        RemoteResourceTargetArch::X86_64,
        "0.1.0",
    )
    .expect("upload plan should be created");

    assert_eq!(plan.remote_directory, "~/.cache/nocturne/helpers/0.1.0");
    assert_eq!(
        plan.helper_upload_path,
        "~/.cache/nocturne/helpers/0.1.0/nocturne-resource-monitor-agent"
    );
    assert_eq!(
        plan.manifest_upload_path,
        "~/.cache/nocturne/helpers/0.1.0/manifest.json"
    );
    assert_eq!(plan.executable_mode, Some(0o755));
    assert!(
        plan.verify_sha256_command
            .contains("f03e279954a05b1fd253a5be7299019af3ebdf44c57e0c69eecc738601ca6d35"),
        "verify command should include expected helper hash: {}",
        plan.verify_sha256_command
    );
    assert!(
        plan.launch_stream_command
            .contains("~/.cache/nocturne/helpers/0.1.0/nocturne-resource-monitor-agent"),
        "launch command should run the uploaded helper: {}",
        plan.launch_stream_command
    );
    assert!(
        plan.launch_stream_command.contains("--stream"),
        "launch command should start long-running NDJSON streaming: {}",
        plan.launch_stream_command
    );
}

fn target_arch_json(arch: RemoteResourceTargetArch) -> &'static str {
    match arch {
        RemoteResourceTargetArch::X86_64 => "x86_64",
        RemoteResourceTargetArch::Aarch64 => "aarch64",
        RemoteResourceTargetArch::Armv7 => "armv7",
        RemoteResourceTargetArch::I686 => "i686",
    }
}
