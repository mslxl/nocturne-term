/*
 * Test content:
 *
 * Feature:
 * Verifies managed ripgrep helper deployment planning for Files search.
 *
 * Operation:
 * Builds target-specific resource paths, official ripgrep download plans, and
 * upload plans for the Files `rg` helper without opening a real SSH
 * connection or executing platform-specific binaries.
 *
 * Expected:
 * Runtime helper selection uses a flat bundled
 * `ripgrep/rg-<rg-version>-<os>-<arch>[.exe]` resource file,
 * missing helpers download the locked ripgrep version from the official
 * BurntSushi/ripgrep release archive instead of Nocturne release assets,
 * manifests identify the helper as `rg` for Files recursive search, upload
 * paths include both app and ripgrep versions, Windows helpers keep `.exe`,
 * and the launch command runs the managed helper with caller-provided ripgrep
 * arguments.
 */

use nocturne_lib::{
    extract_ripgrep_helper_from_archive_for_test, load_ripgrep_helper_bytes_from_path_for_test,
    load_ripgrep_helper_bytes_from_paths_for_test, plan_ripgrep_helper_upload_for_test,
    ripgrep_helper_asset_name_for_test, ripgrep_helper_candidate_paths_for_test,
    ripgrep_helper_resource_path_for_test, ripgrep_managed_command_for_test,
    RemoteResourceTargetArch, RemoteResourceTargetOs, ResourceHelperBytesSource,
};
use std::fs;
use std::io::{Cursor, Write};
use tempfile::tempdir;

#[test]
fn ripgrep_helper_paths_are_target_specific() {
    assert_eq!(
        ripgrep_helper_resource_path_for_test(
            "14.1.1",
            RemoteResourceTargetOs::Linux,
            RemoteResourceTargetArch::Aarch64
        ),
        "ripgrep/rg-14.1.1-linux-aarch64"
    );
    assert_eq!(
        ripgrep_helper_resource_path_for_test(
            "14.1.1",
            RemoteResourceTargetOs::Windows,
            RemoteResourceTargetArch::X86_64
        ),
        "ripgrep/rg-14.1.1-windows-x86_64.exe"
    );
}

#[test]
fn ripgrep_helper_download_plan_uses_official_locked_rg_version() {
    assert_eq!(
        ripgrep_helper_asset_name_for_test(
            "14.1.1",
            RemoteResourceTargetOs::Windows,
            RemoteResourceTargetArch::X86_64
        ),
        Some("ripgrep-14.1.1-x86_64-pc-windows-msvc.zip".to_string())
    );

    let missing_path = tempdir().expect("tempdir").path().join("missing-rg");
    let source = load_ripgrep_helper_bytes_from_path_for_test(
        &missing_path,
        "ignored/nocturne-term",
        None,
        "14.1.1",
        RemoteResourceTargetOs::Macos,
        RemoteResourceTargetArch::Aarch64,
    )
    .expect("missing bundled rg helper should produce a download prompt");

    match source {
        ResourceHelperBytesSource::DownloadRequired(plan) => {
            assert_eq!(plan.tag, "14.1.1");
            assert_eq!(
                plan.asset_name,
                "ripgrep-14.1.1-aarch64-apple-darwin.tar.gz"
            );
            assert_eq!(
                plan.url,
                "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-aarch64-apple-darwin.tar.gz"
            );
            assert!(
                plan.prompt.contains("rg")
                    && plan.prompt.contains("Files recursive search")
                    && plan.prompt.contains("14.1.1")
                    && plan.prompt.contains("official ripgrep release"),
                "prompt should identify helper, purpose, locked version, and source: {}",
                plan.prompt
            );
        }
        other => panic!("expected download prompt, got {other:?}"),
    }
}

#[test]
fn untagged_missing_ripgrep_helper_is_unavailable_instead_of_downloaded() {
    let missing_path = tempdir().expect("tempdir").path().join("missing-rg");
    let source = load_ripgrep_helper_bytes_from_path_for_test(
        &missing_path,
        "mslxl/nocturne-term",
        None,
        "14.1.1",
        RemoteResourceTargetOs::Linux,
        RemoteResourceTargetArch::X86_64,
    )
    .expect("missing untagged rg helper should produce a controlled result");

    assert!(
        matches!(source, ResourceHelperBytesSource::DownloadRequired(_)),
        "untagged builds can still download the locked official ripgrep version"
    );
}

#[test]
fn unsupported_ripgrep_helper_target_is_unavailable_without_a_fake_url() {
    assert_eq!(
        ripgrep_helper_asset_name_for_test(
            "14.1.1",
            RemoteResourceTargetOs::Macos,
            RemoteResourceTargetArch::Armv7
        ),
        None
    );

    let missing_path = tempdir().expect("tempdir").path().join("missing-rg");
    let source = load_ripgrep_helper_bytes_from_path_for_test(
        &missing_path,
        "ignored/nocturne-term",
        None,
        "14.1.1",
        RemoteResourceTargetOs::Macos,
        RemoteResourceTargetArch::Armv7,
    )
    .expect("unsupported rg helper target should produce a controlled result");

    assert_eq!(
        source,
        ResourceHelperBytesSource::Unavailable {
            reason: "No official ripgrep helper archive is available for macos armv7".to_string()
        }
    );
}

#[test]
fn bundled_ripgrep_loader_checks_installed_resource_prefix_before_downloading() {
    let temp = tempdir().expect("tempdir");
    let resource_path = ripgrep_helper_resource_path_for_test(
        "14.1.1",
        RemoteResourceTargetOs::Windows,
        RemoteResourceTargetArch::X86_64,
    );
    let candidate_paths = ripgrep_helper_candidate_paths_for_test(temp.path(), &resource_path);
    let prefixed_path = candidate_paths
        .get(1)
        .expect("prefixed installed resource candidate should exist");
    fs::create_dir_all(
        prefixed_path
            .parent()
            .expect("candidate should have a parent"),
    )
    .expect("test resource directory should be created");
    fs::write(prefixed_path, b"bundled-rg").expect("test bundled helper should be written");

    let source = load_ripgrep_helper_bytes_from_paths_for_test(
        &candidate_paths,
        "ignored/nocturne-term",
        Some("v0.2.0"),
        "14.1.1",
        RemoteResourceTargetOs::Windows,
        RemoteResourceTargetArch::X86_64,
    )
    .expect("existing prefixed rg helper should be loaded");

    assert_eq!(
        source,
        ResourceHelperBytesSource::Bundled(b"bundled-rg".to_vec())
    );
}

#[test]
fn ripgrep_downloaded_archives_extract_the_helper_binary() {
    let tar_bytes = tar_gz_with_file("ripgrep-14.1.1-x86_64-unknown-linux-musl/rg", b"rg-bin");
    assert_eq!(
        extract_ripgrep_helper_from_archive_for_test(
            &tar_bytes,
            "ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz"
        )
        .expect("tar.gz archive should extract rg"),
        b"rg-bin"
    );

    let zip_bytes = zip_with_file("ripgrep-14.1.1-x86_64-pc-windows-msvc/rg.exe", b"rg-exe");
    assert_eq!(
        extract_ripgrep_helper_from_archive_for_test(
            &zip_bytes,
            "ripgrep-14.1.1-x86_64-pc-windows-msvc.zip"
        )
        .expect("zip archive should extract rg.exe"),
        b"rg-exe"
    );
}

#[test]
fn ripgrep_upload_plan_identifies_files_search_helper_and_launch_command() {
    let plan = plan_ripgrep_helper_upload_for_test(
        b"rg-binary",
        RemoteResourceTargetOs::Linux,
        RemoteResourceTargetArch::X86_64,
        "0.1.0",
        "14.1.1",
    )
    .expect("upload plan should be created");

    assert_eq!(plan.resource_path, "ripgrep/rg-14.1.1-linux-x86_64");
    assert_eq!(plan.manifest.helper_name, "rg");
    assert_eq!(plan.manifest.purpose, "Files recursive search");
    assert_eq!(plan.manifest.version, "0.1.0+rg.14.1.1");
    assert_eq!(
        plan.helper_upload_path,
        "~/.cache/nocturne/helpers/0.1.0/rg-14.1.1/rg"
    );
    assert_eq!(
        plan.manifest_upload_path,
        "~/.cache/nocturne/helpers/0.1.0/rg-14.1.1/rg.manifest.json"
    );
    assert!(plan
        .manifest
        .capabilities
        .contains(&"files.search.name".to_string()));
    assert!(plan
        .manifest
        .capabilities
        .contains(&"files.search.content".to_string()));
    assert!(plan
        .manifest
        .capabilities
        .contains(&"ripgrep.json".to_string()));
    assert!(plan.manifest_json.contains("\"helper_name\":\"rg\""));
    assert!(plan.verify_sha256_command.contains("sha256sum -c -"));
    assert_eq!(
        ripgrep_managed_command_for_test(
            RemoteResourceTargetOs::Linux,
            &plan.helper_upload_path,
            "--json -- 'needle' '/home/me'"
        ),
        "'~/.cache/nocturne/helpers/0.1.0/rg-14.1.1/rg' --json -- 'needle' '/home/me'"
    );
}

#[test]
fn windows_ripgrep_upload_plan_uses_windows_helper_paths_and_command() {
    let plan = plan_ripgrep_helper_upload_for_test(
        b"rg-binary",
        RemoteResourceTargetOs::Windows,
        RemoteResourceTargetArch::X86_64,
        "0.1.0",
        "14.1.1",
    )
    .expect("windows upload plan should be created");

    assert_eq!(plan.resource_path, "ripgrep/rg-14.1.1-windows-x86_64.exe");
    assert_eq!(
        plan.helper_upload_path,
        "~/.cache/nocturne/helpers/0.1.0/rg-14.1.1/rg.exe"
    );
    assert_eq!(plan.executable_mode, None);
    assert!(plan.verify_sha256_command.contains("Get-FileHash"));
    assert_eq!(
        ripgrep_managed_command_for_test(
            RemoteResourceTargetOs::Windows,
            &plan.helper_upload_path,
            "--json -- 'needle' 'C:/Users/me'"
        ),
        "& '~/.cache/nocturne/helpers/0.1.0/rg-14.1.1/rg.exe' --json -- 'needle' 'C:/Users/me'"
    );
}

fn tar_gz_with_file(path: &str, bytes: &[u8]) -> Vec<u8> {
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut builder = tar::Builder::new(encoder);
    let mut header = tar::Header::new_gnu();
    header
        .set_path(path)
        .expect("test tar path should be valid");
    header.set_size(bytes.len() as u64);
    header.set_cksum();
    builder
        .append(&header, bytes)
        .expect("test tar entry should be written");
    let encoder = builder.into_inner().expect("test tar should finish");
    encoder.finish().expect("test gzip should finish")
}

fn zip_with_file(path: &str, bytes: &[u8]) -> Vec<u8> {
    let cursor = Cursor::new(Vec::new());
    let mut archive = zip::ZipWriter::new(cursor);
    archive
        .start_file(path, zip::write::SimpleFileOptions::default())
        .expect("test zip entry should start");
    archive
        .write_all(bytes)
        .expect("test zip entry should be written");
    archive
        .finish()
        .expect("test zip should finish")
        .into_inner()
}
