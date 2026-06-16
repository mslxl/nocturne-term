use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=NOCTURNE_BUILD_COMMIT");
    println!("cargo:rerun-if-env-changed=NOCTURNE_BUILD_TAG");
    println!("cargo:rerun-if-changed=../.git/HEAD");

    #[cfg(windows)]
    compile_windows_test_manifest();

    let commit = env_or_git("NOCTURNE_BUILD_COMMIT", &["rev-parse", "HEAD"])
        .unwrap_or_else(|| "unknown".to_string());
    let tag = env_or_git(
        "NOCTURNE_BUILD_TAG",
        &["describe", "--tags", "--exact-match", "HEAD"],
    )
    .unwrap_or_default();

    println!("cargo:rustc-env=NOCTURNE_BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=NOCTURNE_BUILD_TAG={tag}");

    tauri_build::build()
}

#[cfg(windows)]
fn compile_windows_test_manifest() {
    use std::{env, fs, path::PathBuf};

    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set"));
    let manifest_path = out_dir.join("nocturne-test-common-controls-v6.manifest");
    let rc_path = out_dir.join("nocturne_test_common_controls_v6.rc");
    // `cargo test` builds a separate Windows harness executable, and that binary needs
    // its own Common Controls v6 manifest to avoid loader failures before tests start.
    fs::write(
        &manifest_path,
        r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#,
    )
    .expect("failed to write Windows test manifest");
    fs::write(
        &rc_path,
        format!("1 24 \"{}\"\n", manifest_path.display().to_string().replace('\\', "\\\\")),
    )
    .expect("failed to write Windows test resource file");

    embed_resource::compile_for(&rc_path, std::iter::empty::<&str>(), embed_resource::NONE)
        .manifest_required()
        .expect("failed to compile Windows test manifest resource");
    println!("cargo:rustc-link-search=native={}", out_dir.display());
}

fn env_or_git(env_key: &str, args: &[&str]) -> Option<String> {
    std::env::var(env_key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| git_output(args))
}

fn git_output(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}
