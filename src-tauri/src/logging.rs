use std::{
    fs,
    path::{Path, PathBuf},
    process,
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

use crate::{
    error::{io_error, Result},
    ConfigError,
};

const LOG_FILE_PREFIX: &str = "nocturne";
const MAX_LOG_FILE_SIZE_BYTES: u128 = 8 * 1024 * 1024;
const MAX_SESSION_LOG_FILES: usize = 16;
const MAX_TOTAL_LOG_FILES: usize = 96;
const MAX_TOTAL_LOG_BYTES: u64 = 256 * 1024 * 1024;

pub(crate) fn session_log_file_name() -> String {
    let started_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must be later than the Unix epoch")
        .as_secs();

    format!("{LOG_FILE_PREFIX}-{started_at}-{}", process::id())
}

pub(crate) fn plugin(file_name: String) -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_log::Builder::new()
        .clear_targets()
        .level(log::LevelFilter::Debug)
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .max_file_size(MAX_LOG_FILE_SIZE_BYTES)
        .rotation_strategy(RotationStrategy::KeepSome(MAX_SESSION_LOG_FILES))
        .targets([
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::LogDir {
                file_name: Some(file_name),
            }),
        ])
        .build()
}

pub(crate) fn clean_log_dir(
    app: &AppHandle<impl Runtime>,
    active_file_name: &str,
) -> Result<LogCleanupSummary> {
    let dir = app.path().app_log_dir().map_err(io_error)?;
    clean_log_dir_path(&dir, active_file_name)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LogCleanupSummary {
    pub(crate) removed_files: usize,
    pub(crate) removed_bytes: u64,
    pub(crate) kept_files: usize,
    pub(crate) kept_bytes: u64,
}

#[derive(Debug)]
struct LogFileEntry {
    path: PathBuf,
    len: u64,
    modified: SystemTime,
}

fn clean_log_dir_path(dir: &Path, active_file_name: &str) -> Result<LogCleanupSummary> {
    if !dir.exists() {
        return Ok(LogCleanupSummary {
            removed_files: 0,
            removed_bytes: 0,
            kept_files: 0,
            kept_bytes: 0,
        });
    }

    let active_log_file = format!("{active_file_name}.log");
    let mut files = Vec::new();

    for entry in fs::read_dir(dir).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        let path = entry.path();
        if !path.is_file() || !is_nocturne_log_file(&path) {
            continue;
        }

        if path.file_name().and_then(|name| name.to_str()) == Some(active_log_file.as_str()) {
            continue;
        }

        let metadata = path.metadata().map_err(io_error)?;
        files.push(LogFileEntry {
            path,
            len: metadata.len(),
            modified: metadata.modified().map_err(io_error)?,
        });
    }

    files.sort_by(|a, b| {
        b.modified
            .cmp(&a.modified)
            .then_with(|| b.path.cmp(&a.path))
    });

    let mut kept_files: usize = 0;
    let mut kept_bytes: u64 = 0;
    let mut removed_files: usize = 0;
    let mut removed_bytes: u64 = 0;

    for file in files {
        let exceeds_count = kept_files >= MAX_TOTAL_LOG_FILES;
        let exceeds_size = kept_bytes.saturating_add(file.len) > MAX_TOTAL_LOG_BYTES;
        if exceeds_count || exceeds_size {
            fs::remove_file(&file.path).map_err(io_error)?;
            removed_files += 1;
            removed_bytes = removed_bytes.saturating_add(file.len);
        } else {
            kept_files += 1;
            kept_bytes = kept_bytes.saturating_add(file.len);
        }
    }

    Ok(LogCleanupSummary {
        removed_files,
        removed_bytes,
        kept_files,
        kept_bytes,
    })
}

fn is_nocturne_log_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.starts_with(LOG_FILE_PREFIX)
                && (name.ends_with(".log") || name.ends_with(".log.bak"))
        })
}

pub(crate) fn cleanup_error(error: ConfigError) -> String {
    format!("failed to clean old log files: {error}")
}

#[cfg(test)]
mod tests {
    use std::{fs::File, io::Write, thread, time::Duration};

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn cleanup_keeps_active_log_file() {
        let dir = tempdir().expect("tempdir");
        let active_path = dir.path().join("nocturne-active.log");
        write_bytes(&active_path, 1);

        let summary = clean_log_dir_path(dir.path(), "nocturne-active").expect("cleanup");

        assert!(active_path.exists());
        assert_eq!(summary.removed_files, 0);
    }

    #[test]
    fn cleanup_removes_oldest_logs_when_count_limit_is_exceeded() {
        let dir = tempdir().expect("tempdir");
        for index in 0..(MAX_TOTAL_LOG_FILES + 2) {
            write_bytes(&dir.path().join(format!("nocturne-old-{index}.log")), 1);
            thread::sleep(Duration::from_millis(2));
        }

        let summary = clean_log_dir_path(dir.path(), "nocturne-active").expect("cleanup");
        let remaining = fs::read_dir(dir.path()).expect("read dir").count();

        assert_eq!(summary.removed_files, 2);
        assert_eq!(remaining, MAX_TOTAL_LOG_FILES);
    }

    #[test]
    fn cleanup_ignores_other_files() {
        let dir = tempdir().expect("tempdir");
        let unrelated = dir.path().join("other.log");
        let note = dir.path().join("nocturne-note.txt");
        let plugin_backup = dir
            .path()
            .join("nocturne-active_2026-05-31_13-31-11.log.bak");
        write_bytes(&unrelated, 1);
        write_bytes(&note, 1);
        write_bytes(&plugin_backup, 1);

        let summary = clean_log_dir_path(dir.path(), "nocturne-active").expect("cleanup");

        assert!(unrelated.exists());
        assert!(note.exists());
        assert_eq!(summary.kept_files, 1);
        assert_eq!(summary.removed_files, 0);
    }

    fn write_bytes(path: &Path, len: usize) {
        let mut file = File::create(path).expect("create file");
        file.write_all(&vec![b'x'; len]).expect("write file");
    }
}
