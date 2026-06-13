use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=NOCTURNE_BUILD_COMMIT");
    println!("cargo:rerun-if-env-changed=NOCTURNE_BUILD_TAG");
    println!("cargo:rerun-if-changed=../.git/HEAD");

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
