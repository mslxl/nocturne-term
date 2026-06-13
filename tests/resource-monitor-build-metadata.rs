/*
 * Test content:
 *
 * Feature:
 * Verifies Resource Monitor agent build metadata and same-tag GitHub
 * download planning.
 *
 * Operation:
 * Reads the compile-time build commit and tag values embedded by the Tauri
 * build script, creates helper release asset plans for tagged and untagged
 * builds, and asks the helper loader to choose between bundled bytes, a
 * same-tag download plan, or an unavailable result without using repository-
 * local absolute paths or platform-specific binaries.
 *
 * Expected:
 * The app always embeds a non-empty commit identifier. Tagged builds create a
 * deterministic GitHub release URL that uses exactly the current app tag and a
 * target-specific `nocturne-resource-monitor-agent-<tag>-<os>-<arch>` asset name. Untagged
 * builds do not create a download plan, so Nocturne never falls back to a
 * different release or `latest` when a bundled helper is missing.
 */
use nocturne_lib::{
    build_info_for_test, helper_asset_name_for_test, helper_download_plan_for_test,
    load_resource_helper_bytes_from_path_for_test, load_resource_helper_bytes_from_paths_for_test,
    resource_helper_candidate_paths_for_test, resource_helper_resource_path_for_test,
    RemoteResourceTargetArch, RemoteResourceTargetOs, ResourceHelperBytesSource,
};
use std::fs;
use tempfile::tempdir;

#[test]
fn build_info_embeds_a_commit_identifier() {
    let info = build_info_for_test();

    assert!(
        !info.commit.trim().is_empty(),
        "build commit should be embedded for diagnostics and helper downloads"
    );
}

#[test]
fn tagged_build_download_plan_uses_the_same_tag_and_target_asset_name() {
    let plan = helper_download_plan_for_test(
        "mslxl/nocturne-term",
        Some("v0.2.0-alpha.1"),
        RemoteResourceTargetOs::Linux,
        RemoteResourceTargetArch::Aarch64,
    )
    .expect("tagged builds can create a same-tag helper download plan");

    assert_eq!(plan.tag, "v0.2.0-alpha.1");
    assert_eq!(
        plan.asset_name,
        "nocturne-resource-monitor-agent-v0.2.0-alpha.1-linux-aarch64"
    );
    assert_eq!(
        plan.url,
        "https://github.com/mslxl/nocturne-term/releases/download/v0.2.0-alpha.1/nocturne-resource-monitor-agent-v0.2.0-alpha.1-linux-aarch64"
    );
}

#[test]
fn windows_helper_download_asset_keeps_the_executable_suffix() {
    assert_eq!(
        helper_asset_name_for_test(
            "v1.0.0",
            RemoteResourceTargetOs::Windows,
            RemoteResourceTargetArch::X86_64
        ),
        "nocturne-resource-monitor-agent-v1.0.0-windows-x86_64.exe"
    );
}

#[test]
fn untagged_build_does_not_create_a_github_download_plan() {
    let plan = helper_download_plan_for_test(
        "mslxl/nocturne-term",
        None,
        RemoteResourceTargetOs::Linux,
        RemoteResourceTargetArch::X86_64,
    );

    assert_eq!(plan, None);
}

#[test]
fn missing_bundled_helper_without_tag_is_unavailable_instead_of_downloaded() {
    let missing_path = tempdir().expect("tempdir").path().join("missing-agent");

    let source = load_resource_helper_bytes_from_path_for_test(
        &missing_path,
        "mslxl/nocturne-term",
        None,
        RemoteResourceTargetOs::Linux,
        RemoteResourceTargetArch::X86_64,
    )
    .expect("missing helper without a tag should produce a controlled result");

    assert_eq!(
        source,
        ResourceHelperBytesSource::Unavailable {
            reason: "Bundled Resource Monitor helper is missing and this build has no release tag"
                .to_string()
        }
    );
}

#[test]
fn missing_bundled_helper_with_tag_returns_same_tag_download_prompt() {
    let missing_path = tempdir().expect("tempdir").path().join("missing-agent");

    let source = load_resource_helper_bytes_from_path_for_test(
        &missing_path,
        "mslxl/nocturne-term",
        Some("v0.2.0"),
        RemoteResourceTargetOs::Macos,
        RemoteResourceTargetArch::X86_64,
    )
    .expect("missing helper with a tag should produce a download prompt");

    match source {
        ResourceHelperBytesSource::DownloadRequired(plan) => {
            assert_eq!(plan.tag, "v0.2.0");
            assert_eq!(
                plan.asset_name,
                "nocturne-resource-monitor-agent-v0.2.0-macos-x86_64"
            );
            assert!(
                plan.prompt.contains("nocturne-resource-monitor-agent")
                    && plan.prompt.contains("Resource Monitor metrics")
                    && plan.prompt.contains("v0.2.0"),
                "prompt should identify helper, purpose, and tag: {}",
                plan.prompt
            );
        }
        other => panic!("expected download prompt, got {other:?}"),
    }
}

#[test]
fn bundled_helper_loader_checks_installed_resource_prefix_before_downloading() {
    let temp = tempdir().expect("tempdir");
    let resource_path = resource_helper_resource_path_for_test(
        RemoteResourceTargetOs::Windows,
        RemoteResourceTargetArch::X86_64,
    );
    let candidate_paths = resource_helper_candidate_paths_for_test(temp.path(), &resource_path);
    let prefixed_path = candidate_paths
        .get(1)
        .expect("prefixed installed resource candidate should exist");
    fs::create_dir_all(
        prefixed_path
            .parent()
            .expect("candidate should have a parent"),
    )
    .expect("test resource directory should be created");
    fs::write(prefixed_path, b"bundled-agent").expect("test bundled helper should be written");

    let source = load_resource_helper_bytes_from_paths_for_test(
        &candidate_paths,
        "mslxl/nocturne-term",
        Some("v0.2.0"),
        RemoteResourceTargetOs::Windows,
        RemoteResourceTargetArch::X86_64,
    )
    .expect("existing prefixed helper should be loaded");

    assert_eq!(
        source,
        ResourceHelperBytesSource::Bundled(b"bundled-agent".to_vec())
    );
}
