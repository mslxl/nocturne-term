use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use portable_pty::PtySize;
use sha2::{Digest, Sha256};
use ssh2::{FileStat, OpenFlags, OpenType, Session, Sftp};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::{
    config::{
        connection_host_by_id, effective_application_config, resolve_openssh_proxy_jump_chain,
        ssh_known_hosts_path,
    },
    error::{invalid_error, io_error, terminal_error, Result},
    resources::{
        build_info, detect_remote_resource_target, RemoteResourceTargetDetection,
        ResourceHelperBytesSource, ResourceHelperDownloadPlan, ResourceHelperManifest,
        ResourceHelperUploadPlan,
    },
    terminal::{connect_authenticated_ssh_session, default_ssh_username, SshWorkerInput},
    types::{
        ConnectionHostEntry, ConnectionHostSource, ConnectionProtocol, FileChmodInput,
        FileCreateDirectoryInput, FileEntry, FileEntryKind, FileListInput, FileListResult,
        FilePathInput, FilePreviewContent, FilePreviewInput, FilePreviewResult,
        FileProviderCapabilities, FileProviderInfo, FileProviderKind, FileRenameInput,
        FileSearchInput, FileSearchMatch, FileSearchMatchRange, FileSearchMode, FileSearchResult,
        FileTrashInfo, FileTrashInfoInput, RemoteResourceTargetArch, RemoteResourceTargetOs,
        RemoteSearchHelperInfo, RemoteSearchHelperInput,
    },
    workspace,
    workspace_ssh::connection_host_auth_target,
};

const DEFAULT_SEARCH_LIMIT: usize = 500;
const MAX_PREVIEW_READ_BYTES: usize = 10 * 1024 * 1024;
const RIPGREP_HELPER_VERSION: &str = "14.1.1";
const RIPGREP_HELPER_HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

static RIPGREP_HELPER_DEPLOYMENTS: OnceLock<Arc<Mutex<RipgrepHelperDeploymentMemory>>> =
    OnceLock::new();

#[derive(Debug, Clone, Default)]
struct RipgrepHelperDeploymentMemory {
    verified: BTreeMap<String, String>,
}

impl RipgrepHelperDeploymentMemory {
    fn record_verified(&mut self, host_id: impl Into<String>, sha256: impl Into<String>) {
        self.verified.insert(host_id.into(), sha256.into());
    }

    fn verified_hash(&self, host_id: &str) -> Option<&str> {
        self.verified.get(host_id).map(String::as_str)
    }
}

fn ripgrep_helper_deployment_memory() -> Arc<Mutex<RipgrepHelperDeploymentMemory>> {
    RIPGREP_HELPER_DEPLOYMENTS
        .get_or_init(|| Arc::new(Mutex::new(RipgrepHelperDeploymentMemory::default())))
        .clone()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RemoteHelperPolicy {
    Ask,
    Never,
    Allow,
}

pub(crate) struct SftpConnection {
    pub(crate) session: Session,
    _jump_guards: Vec<thread::JoinHandle<()>>,
}

pub(crate) struct SftpAuthScope<'a> {
    pub(crate) workspace_id: &'a str,
    pub(crate) source_tool_tab_id: Option<&'a str>,
}

fn files_input_host(
    app: &AppHandle,
    workspace_id: &str,
    tool_tab_id: &str,
) -> Result<ConnectionHostEntry> {
    let host_id = workspace::owned_workspace_tool_host(
        app,
        workspace_id,
        tool_tab_id,
        crate::types::WorkspaceToolKind::Files,
    )?;
    connection_host_by_id(app, &host_id)
}

async fn run_file_command<T, F>(command: &'static str, work: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| invalid_error(format!("{command} worker failed: {error}")))?
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn list_files(app: AppHandle, input: FileListInput) -> Result<FileListResult> {
    run_file_command("list_files", move || list_files_blocking(app, input)).await
}

fn list_files_blocking(app: AppHandle, input: FileListInput) -> Result<FileListResult> {
    let host = files_input_host(&app, &input.workspace_id, &input.tool_tab_id)?;
    match host.document.protocol {
        ConnectionProtocol::Local => list_local_files(&host, input.path),
        ConnectionProtocol::Ssh => list_sftp_files(app, host, input),
        ConnectionProtocol::Telnet => Err(invalid_error("telnet hosts do not support Files")),
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn create_directory(
    app: AppHandle,
    input: FileCreateDirectoryInput,
) -> Result<()> {
    run_file_command("create_directory", move || {
        create_directory_blocking(app, input)
    })
    .await
}

fn create_directory_blocking(app: AppHandle, input: FileCreateDirectoryInput) -> Result<()> {
    validate_child_name(&input.name)?;
    let host = files_input_host(&app, &input.workspace_id, &input.tool_tab_id)?;
    let path = join_provider_path(
        &input.parent_path,
        &input.name,
        host.document.protocol.clone(),
    );
    match host.document.protocol {
        ConnectionProtocol::Local => fs::create_dir(expand_local_home(path)).map_err(io_error),
        ConnectionProtocol::Ssh => {
            let connection = connect_sftp_for_host(
                &app,
                &host,
                SftpAuthScope {
                    workspace_id: &input.workspace_id,
                    source_tool_tab_id: Some(&input.tool_tab_id),
                },
                input.accept_new_host_key,
                input.update_changed_host_key,
                input.credential,
                input.save_credential,
                "files-mkdir",
            )?;
            connection
                .session
                .sftp()
                .map_err(terminal_error)?
                .mkdir(Path::new(&path), 0o755)
                .map_err(terminal_error)
        }
        ConnectionProtocol::Telnet => Err(invalid_error("telnet hosts do not support Files")),
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn rename_file(app: AppHandle, input: FileRenameInput) -> Result<()> {
    run_file_command("rename_file", move || rename_file_blocking(app, input)).await
}

fn rename_file_blocking(app: AppHandle, input: FileRenameInput) -> Result<()> {
    if input.source_path.trim().is_empty() || input.destination_path.trim().is_empty() {
        return Err(invalid_error("rename paths cannot be empty"));
    }
    let host = files_input_host(&app, &input.workspace_id, &input.tool_tab_id)?;
    match host.document.protocol {
        ConnectionProtocol::Local => fs::rename(
            expand_local_home(input.source_path),
            expand_local_home(input.destination_path),
        )
        .map_err(io_error),
        ConnectionProtocol::Ssh => {
            let connection = connect_sftp_for_host(
                &app,
                &host,
                SftpAuthScope {
                    workspace_id: &input.workspace_id,
                    source_tool_tab_id: Some(&input.tool_tab_id),
                },
                input.accept_new_host_key,
                input.update_changed_host_key,
                input.credential,
                input.save_credential,
                "files-rename",
            )?;
            connection
                .session
                .sftp()
                .map_err(terminal_error)?
                .rename(
                    Path::new(&input.source_path),
                    Path::new(&input.destination_path),
                    None,
                )
                .map_err(terminal_error)
        }
        ConnectionProtocol::Telnet => Err(invalid_error("telnet hosts do not support Files")),
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn chmod_file(app: AppHandle, input: FileChmodInput) -> Result<()> {
    run_file_command("chmod_file", move || chmod_file_blocking(app, input)).await
}

fn chmod_file_blocking(app: AppHandle, input: FileChmodInput) -> Result<()> {
    if input.path.trim().is_empty() {
        return Err(invalid_error("chmod path cannot be empty"));
    }
    let mode = parse_chmod_mode(&input.mode)?;
    let host = files_input_host(&app, &input.workspace_id, &input.tool_tab_id)?;
    match host.document.protocol {
        ConnectionProtocol::Local => chmod_local_path(&expand_local_home(input.path), mode),
        ConnectionProtocol::Ssh => {
            let connection = connect_sftp_for_host(
                &app,
                &host,
                SftpAuthScope {
                    workspace_id: &input.workspace_id,
                    source_tool_tab_id: Some(&input.tool_tab_id),
                },
                input.accept_new_host_key,
                input.update_changed_host_key,
                input.credential,
                input.save_credential,
                "files-chmod",
            )?;
            let sftp = connection.session.sftp().map_err(terminal_error)?;
            let existing = sftp.lstat(Path::new(&input.path)).map_err(terminal_error)?;
            let file_type_bits = existing.perm.unwrap_or(0) & libc_mode::S_IFMT;
            sftp.setstat(
                Path::new(&input.path),
                FileStat {
                    size: None,
                    uid: None,
                    gid: None,
                    perm: Some(file_type_bits | mode),
                    atime: None,
                    mtime: None,
                },
            )
            .map_err(terminal_error)
        }
        ConnectionProtocol::Telnet => Err(invalid_error("telnet hosts do not support Files")),
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn delete_file(app: AppHandle, input: FilePathInput) -> Result<()> {
    run_file_command("delete_file", move || delete_file_blocking(app, input)).await
}

fn delete_file_blocking(app: AppHandle, input: FilePathInput) -> Result<()> {
    if input.path.trim().is_empty() {
        return Err(invalid_error("delete path cannot be empty"));
    }
    let host = files_input_host(&app, &input.workspace_id, &input.tool_tab_id)?;
    match host.document.protocol {
        ConnectionProtocol::Local => delete_local_path(&expand_local_home(input.path)),
        ConnectionProtocol::Ssh => {
            let connection = connect_sftp_for_host(
                &app,
                &host,
                SftpAuthScope {
                    workspace_id: &input.workspace_id,
                    source_tool_tab_id: Some(&input.tool_tab_id),
                },
                input.accept_new_host_key,
                input.update_changed_host_key,
                input.credential,
                input.save_credential,
                "files-delete",
            )?;
            let sftp = connection.session.sftp().map_err(terminal_error)?;
            delete_sftp_path(&sftp, Path::new(&input.path))
        }
        ConnectionProtocol::Telnet => Err(invalid_error("telnet hosts do not support Files")),
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn remote_trash_info(
    app: AppHandle,
    input: FileTrashInfoInput,
) -> Result<FileTrashInfo> {
    run_file_command("remote_trash_info", move || {
        remote_trash_info_blocking(app, input)
    })
    .await
}

fn remote_trash_info_blocking(app: AppHandle, input: FileTrashInfoInput) -> Result<FileTrashInfo> {
    let host = files_input_host(&app, &input.workspace_id, &input.tool_tab_id)?;
    match host.document.protocol {
        ConnectionProtocol::Local => Err(invalid_error("local hosts do not use remote trash")),
        ConnectionProtocol::Ssh => {
            let connection = connect_sftp_for_host(
                &app,
                &host,
                SftpAuthScope {
                    workspace_id: &input.workspace_id,
                    source_tool_tab_id: Some(&input.tool_tab_id),
                },
                input.accept_new_host_key,
                input.update_changed_host_key,
                input.credential,
                input.save_credential,
                "files-trash-info",
            )?;
            let sftp = connection.session.sftp().map_err(terminal_error)?;
            remote_trash_info_for_sftp(&connection.session, &sftp)
        }
        ConnectionProtocol::Telnet => Err(invalid_error("telnet hosts do not support Files")),
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn remote_search_helper_info(
    app: AppHandle,
    input: RemoteSearchHelperInput,
) -> Result<RemoteSearchHelperInfo> {
    run_file_command("remote_search_helper_info", move || {
        remote_search_helper_info_blocking(app, input)
    })
    .await
}

fn remote_search_helper_info_blocking(
    app: AppHandle,
    input: RemoteSearchHelperInput,
) -> Result<RemoteSearchHelperInfo> {
    let host = files_input_host(&app, &input.workspace_id, &input.tool_tab_id)?;
    match host.document.protocol {
        ConnectionProtocol::Local => Err(invalid_error(
            "local hosts do not use a remote search helper",
        )),
        ConnectionProtocol::Ssh => {
            let connection = connect_sftp_for_host(
                &app,
                &host,
                SftpAuthScope {
                    workspace_id: &input.workspace_id,
                    source_tool_tab_id: Some(&input.tool_tab_id),
                },
                input.accept_new_host_key,
                input.update_changed_host_key,
                input.credential,
                input.save_credential,
                "files-remote-search-helper",
            )?;
            let available =
                remote_command_succeeds(&connection.session, "command -v rg >/dev/null 2>&1")?;
            Ok(RemoteSearchHelperInfo {
                available,
                provider_label: if available {
                    "ripgrep on remote".to_string()
                } else {
                    "SFTP scan".to_string()
                },
                reason: if available {
                    None
                } else {
                    Some("remote rg helper is not available on this host".to_string())
                },
            })
        }
        ConnectionProtocol::Telnet => Err(invalid_error("telnet hosts do not support Files")),
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn trash_file(app: AppHandle, input: FilePathInput) -> Result<()> {
    run_file_command("trash_file", move || trash_file_blocking(app, input)).await
}

fn trash_file_blocking(app: AppHandle, input: FilePathInput) -> Result<()> {
    if input.path.trim().is_empty() {
        return Err(invalid_error("trash path cannot be empty"));
    }
    let host = files_input_host(&app, &input.workspace_id, &input.tool_tab_id)?;
    match host.document.protocol {
        ConnectionProtocol::Local => Err(invalid_error(
            "local trash is not implemented by the Files provider yet",
        )),
        ConnectionProtocol::Ssh => {
            let connection = connect_sftp_for_host(
                &app,
                &host,
                SftpAuthScope {
                    workspace_id: &input.workspace_id,
                    source_tool_tab_id: Some(&input.tool_tab_id),
                },
                input.accept_new_host_key,
                input.update_changed_host_key,
                input.credential,
                input.save_credential,
                "files-trash",
            )?;
            let sftp = connection.session.sftp().map_err(terminal_error)?;
            move_sftp_path_to_trash(&connection.session, &sftp, Path::new(&input.path))
        }
        ConnectionProtocol::Telnet => Err(invalid_error("telnet hosts do not support Files")),
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn preview_file(
    app: AppHandle,
    input: FilePreviewInput,
) -> Result<FilePreviewResult> {
    run_file_command("preview_file", move || preview_file_blocking(app, input)).await
}

fn preview_file_blocking(app: AppHandle, input: FilePreviewInput) -> Result<FilePreviewResult> {
    if input.path.trim().is_empty() {
        return Err(invalid_error("preview path cannot be empty"));
    }
    validate_preview_limits(input.text_limit_bytes, input.image_limit_bytes)?;
    let host = files_input_host(&app, &input.workspace_id, &input.tool_tab_id)?;
    match host.document.protocol {
        ConnectionProtocol::Local => preview_local_file(input),
        ConnectionProtocol::Ssh => {
            let connection = connect_sftp_for_host(
                &app,
                &host,
                SftpAuthScope {
                    workspace_id: &input.workspace_id,
                    source_tool_tab_id: Some(&input.tool_tab_id),
                },
                input.accept_new_host_key,
                input.update_changed_host_key,
                input.credential.clone(),
                input.save_credential,
                "files-preview",
            )?;
            let sftp = connection.session.sftp().map_err(terminal_error)?;
            preview_sftp_file(&sftp, input)
        }
        ConnectionProtocol::Telnet => Err(invalid_error("telnet hosts do not support Files")),
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn search_files(
    app: AppHandle,
    input: FileSearchInput,
) -> Result<FileSearchResult> {
    run_file_command("search_files", move || search_files_blocking(app, input)).await
}

fn search_files_blocking(app: AppHandle, input: FileSearchInput) -> Result<FileSearchResult> {
    let query = input.query.trim();
    if query.is_empty() {
        return Err(invalid_error("search query cannot be empty"));
    }
    let host = files_input_host(&app, &input.workspace_id, &input.tool_tab_id)?;
    match host.document.protocol {
        ConnectionProtocol::Local => search_local_files(&host, input),
        ConnectionProtocol::Ssh => search_sftp_files(&app, &host, input),
        ConnectionProtocol::Telnet => Err(invalid_error("telnet hosts do not support Files")),
    }
}

fn list_local_files(host: &ConnectionHostEntry, path: Option<String>) -> Result<FileListResult> {
    let root_path = local_filesystem_root_path();
    let default_path = local_default_path(host)?;
    let current_path = path
        .filter(|value| !value.trim().is_empty())
        .map(expand_local_home)
        .unwrap_or(default_path);
    let (current_path, entries) = list_local_entries(&current_path)?;
    Ok(FileListResult {
        provider: FileProviderInfo {
            kind: FileProviderKind::Local,
            host_id: host.id.clone(),
            root_path,
            current_path,
            capabilities: local_capabilities(),
        },
        entries: sort_entries(entries),
    })
}

fn list_local_entries(path: &str) -> Result<(String, Vec<FileEntry>)> {
    #[cfg(windows)]
    {
        if is_windows_virtual_root(path) {
            return Ok(("/".to_string(), sort_entries(windows_drive_entries()?)));
        }
    }
    let entries = fs::read_dir(path)
        .map_err(io_error)?
        .map(|entry| local_file_entry(entry.map_err(io_error)?))
        .collect::<Result<Vec<_>>>()?;
    Ok((normalize_local_display_path(path), sort_entries(entries)))
}

fn list_sftp_files(
    app: AppHandle,
    host: ConnectionHostEntry,
    input: FileListInput,
) -> Result<FileListResult> {
    let connection = connect_sftp_for_host(
        &app,
        &host,
        SftpAuthScope {
            workspace_id: &input.workspace_id,
            source_tool_tab_id: Some(&input.tool_tab_id),
        },
        input.accept_new_host_key,
        input.update_changed_host_key,
        input.credential,
        input.save_credential,
        "files-list",
    )?;
    let sftp = connection.session.sftp().map_err(terminal_error)?;
    let root_path = sftp_default_path(
        &connection.session,
        &sftp,
        host.document
            .files
            .as_ref()
            .and_then(|files| files.default_path.clone()),
    )?;
    let default_path = root_path;
    let root_path = "/".to_string();
    let current_path = sftp_current_path(input.path, &default_path);
    let entries = sftp
        .readdir(Path::new(&current_path))
        .map_err(terminal_error)?
        .into_iter()
        .filter_map(|(path, stat)| sftp_file_entry(&current_path, path, stat))
        .collect::<Vec<_>>();
    Ok(FileListResult {
        provider: FileProviderInfo {
            kind: FileProviderKind::Sftp,
            host_id: host.id,
            root_path,
            current_path,
            capabilities: sftp_capabilities(),
        },
        entries: sort_entries(entries),
    })
}

fn search_local_files(
    host: &ConnectionHostEntry,
    input: FileSearchInput,
) -> Result<FileSearchResult> {
    let root_path = if input.root_path.trim().is_empty() {
        local_default_path(host)?
    } else {
        expand_local_home(input.root_path.clone())
    };
    if let Some(result) = search_local_files_with_ripgrep(&root_path, &input)? {
        return Ok(result);
    }
    let mut matches = Vec::new();
    let mut diagnostics = match input.mode {
        FileSearchMode::Name => {
            vec!["local ripgrep was not available; using local scan".to_string()]
        }
        FileSearchMode::Content => {
            vec!["local ripgrep was not available; using local content scan".to_string()]
        }
    };
    let mut visited = HashSet::new();
    let limit = search_limit(input.max_results);
    let query = input.query.to_lowercase();
    let truncated = match input.mode {
        FileSearchMode::Name => scan_local_search_path(
            Path::new(&root_path),
            &query,
            input.include_hidden,
            input.follow_symlinks,
            limit,
            &mut matches,
            &mut diagnostics,
            &mut visited,
        )?,
        FileSearchMode::Content => scan_local_content_search_path(
            Path::new(&root_path),
            &query,
            input.include_hidden,
            input.follow_symlinks,
            limit,
            &mut matches,
            &mut diagnostics,
            &mut visited,
        )?,
    };
    Ok(FileSearchResult {
        provider_label: "local scan".to_string(),
        root_path,
        query: input.query,
        matches,
        diagnostics,
        truncated,
    })
}

fn search_local_files_with_ripgrep(
    root_path: &str,
    input: &FileSearchInput,
) -> Result<Option<FileSearchResult>> {
    let output = run_local_ripgrep(
        input.mode.clone(),
        root_path,
        &input.query,
        input.include_hidden,
        input.ignore_ignore_files,
        input.follow_symlinks,
    )?;
    let Some(output) = output else {
        return Ok(None);
    };
    if output.status > 1 || (matches!(input.mode, FileSearchMode::Name) && output.status != 0) {
        return Ok(None);
    }
    let limit = search_limit(input.max_results);
    let mut diagnostics = if output.stderr.trim().is_empty() {
        Vec::new()
    } else {
        output.stderr.lines().map(str::to_string).collect()
    };
    let (matches, truncated) = match input.mode {
        FileSearchMode::Name => {
            let mut matches = Vec::new();
            let query = input.query.to_lowercase();
            let truncated = collect_remote_rg_name_matches(
                &output.stdout,
                root_path,
                &query,
                limit,
                &mut matches,
            );
            (matches, truncated)
        }
        FileSearchMode::Content => {
            let (matches, truncated, parse_diagnostics) =
                parse_remote_ripgrep_json_matches(&output.stdout, limit);
            diagnostics.extend(parse_diagnostics);
            (matches, truncated)
        }
    };
    Ok(Some(FileSearchResult {
        provider_label: "local ripgrep".to_string(),
        root_path: root_path.to_string(),
        query: input.query.clone(),
        matches,
        diagnostics,
        truncated,
    }))
}

fn run_local_ripgrep(
    mode: FileSearchMode,
    root_path: &str,
    query: &str,
    include_hidden: bool,
    ignore_ignore_files: bool,
    follow_symlinks: bool,
) -> Result<Option<RemoteCommandOutput>> {
    let mut command = Command::new("rg");
    match mode {
        FileSearchMode::Name => {
            command.arg("--files");
        }
        FileSearchMode::Content => {
            command.arg("--json");
        }
    }
    if include_hidden {
        command.arg("--hidden");
    }
    if ignore_ignore_files {
        command.arg("--no-ignore");
    }
    if follow_symlinks {
        command.arg("--follow");
    }
    command.arg("--");
    if matches!(mode, FileSearchMode::Content) {
        command.arg(query);
    }
    command.arg(root_path);
    match command.output() {
        Ok(output) => Ok(Some(RemoteCommandOutput {
            status: output.status.code().unwrap_or(2),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error(error)),
    }
}

fn search_sftp_files(
    app: &AppHandle,
    host: &ConnectionHostEntry,
    input: FileSearchInput,
) -> Result<FileSearchResult> {
    let helper_policy = remote_helper_policy(app)?;
    let connection = connect_sftp_for_host(
        app,
        host,
        SftpAuthScope {
            workspace_id: &input.workspace_id,
            source_tool_tab_id: Some(&input.tool_tab_id),
        },
        input.accept_new_host_key,
        input.update_changed_host_key,
        input.credential.clone(),
        input.save_credential,
        "files-search",
    )?;
    let sftp = connection.session.sftp().map_err(terminal_error)?;
    let root_path = if input.root_path.trim().is_empty() {
        sftp_default_path(
            &connection.session,
            &sftp,
            host.document
                .files
                .as_ref()
                .and_then(|files| files.default_path.clone()),
        )?
    } else {
        input.root_path.clone()
    };
    if !matches!(helper_policy, RemoteHelperPolicy::Never) {
        match search_sftp_files_with_remote_rg(&connection.session, &root_path, &input) {
            Ok(Some(result)) => return Ok(result),
            Ok(None) => {}
            Err(error) => {
                log::debug!("remote rg search unavailable for host {}: {error}", host.id);
            }
        }
        match search_sftp_files_with_managed_rg(
            app,
            host,
            &connection,
            &root_path,
            &input,
            helper_policy,
        ) {
            Ok(Some(result)) => return Ok(result),
            Ok(None) => {}
            Err(error) => {
                log::debug!(
                    "managed rg search unavailable for host {}: {error}",
                    host.id
                );
            }
        }
    }
    if matches!(input.mode, FileSearchMode::Content) {
        let reason = if matches!(helper_policy, RemoteHelperPolicy::Never) {
            "remote helper policy is Never; content search requires ripgrep"
        } else {
            "ripgrep on remote was not available; content search requires ripgrep"
        };
        return Ok(FileSearchResult {
            provider_label: "SFTP scan".to_string(),
            root_path,
            query: input.query,
            matches: Vec::new(),
            diagnostics: vec![reason.to_string()],
            truncated: false,
        });
    }
    let mut matches = Vec::new();
    let mut diagnostics = if matches!(helper_policy, RemoteHelperPolicy::Never) {
        vec!["remote helper policy is Never; using SFTP scan".to_string()]
    } else {
        vec!["ripgrep on remote was not available; using SFTP scan".to_string()]
    };
    let limit = search_limit(input.max_results);
    let query = input.query.to_lowercase();
    let truncated = scan_sftp_search_path(
        &sftp,
        Path::new(&root_path),
        &query,
        input.include_hidden,
        input.follow_symlinks,
        limit,
        &mut matches,
        &mut diagnostics,
    )?;
    Ok(FileSearchResult {
        provider_label: "SFTP scan".to_string(),
        root_path,
        query: input.query,
        matches,
        diagnostics,
        truncated,
    })
}

fn search_sftp_files_with_remote_rg(
    session: &Session,
    root_path: &str,
    input: &FileSearchInput,
) -> Result<Option<FileSearchResult>> {
    if !remote_command_succeeds(session, "command -v rg >/dev/null 2>&1")? {
        return Ok(None);
    }
    let command = build_remote_ripgrep_command(
        input.mode.clone(),
        root_path,
        &input.query,
        input.include_hidden,
        input.ignore_ignore_files,
        input.follow_symlinks,
    );
    let output = run_remote_command(session, &command)?;
    if output.status > 1 || (matches!(input.mode, FileSearchMode::Name) && output.status != 0) {
        return Ok(None);
    }
    let query = input.query.to_lowercase();
    let limit = search_limit(input.max_results);
    let mut diagnostics = if output.stderr.trim().is_empty() {
        Vec::new()
    } else {
        output.stderr.lines().map(str::to_string).collect()
    };
    let (matches, truncated) = match input.mode {
        FileSearchMode::Name => {
            let mut matches = Vec::new();
            let truncated = collect_remote_rg_name_matches(
                &output.stdout,
                root_path,
                &query,
                limit,
                &mut matches,
            );
            (matches, truncated)
        }
        FileSearchMode::Content => {
            let (matches, truncated, parse_diagnostics) =
                parse_remote_ripgrep_json_matches(&output.stdout, limit);
            diagnostics.extend(parse_diagnostics);
            (matches, truncated)
        }
    };
    Ok(Some(FileSearchResult {
        provider_label: "ripgrep on remote".to_string(),
        root_path: root_path.to_string(),
        query: input.query.clone(),
        matches,
        diagnostics,
        truncated,
    }))
}

fn search_sftp_files_with_managed_rg(
    app: &AppHandle,
    host: &ConnectionHostEntry,
    connection: &SftpConnection,
    root_path: &str,
    input: &FileSearchInput,
    helper_policy: RemoteHelperPolicy,
) -> Result<Option<FileSearchResult>> {
    if matches!(helper_policy, RemoteHelperPolicy::Never) {
        return Ok(None);
    }
    let detection = detect_remote_resource_target(connection, host.document.resources.clone())?;
    let (target_os, target_arch) = match detection {
        RemoteResourceTargetDetection::Detected { os, arch, .. } => (os, arch),
        RemoteResourceTargetDetection::Unknown { reason, .. } => {
            log::debug!(
                "managed rg target detection unavailable for host {}: {reason}",
                host.id
            );
            return Ok(None);
        }
    };
    let helper_source = load_ripgrep_helper_bytes_from_app(app, target_os, target_arch)?;
    let helper_bytes = match helper_source {
        ResourceHelperBytesSource::Bundled(bytes) => bytes,
        ResourceHelperBytesSource::DownloadRequired(plan) => {
            match download_ripgrep_helper_after_confirmation(app, &plan) {
                Ok(bytes) => bytes,
                Err(error) => {
                    log::debug!("managed rg helper download canceled or failed: {error}");
                    return Ok(None);
                }
            }
        }
        ResourceHelperBytesSource::Unavailable { reason } => {
            log::debug!(
                "managed rg helper unavailable for host {}: {reason}",
                host.id
            );
            return Ok(None);
        }
    };
    let plan = plan_ripgrep_helper_upload(
        &helper_bytes,
        target_os,
        target_arch,
        env!("CARGO_PKG_VERSION"),
        RIPGREP_HELPER_VERSION,
    )?;
    if matches!(helper_policy, RemoteHelperPolicy::Ask)
        && !ripgrep_helper_verified(&host.id, &plan.manifest.sha256)?
        && !confirm_ripgrep_helper_upload(app, host, &plan)
    {
        return Ok(None);
    }
    let helper_remote_path = deploy_ripgrep_helper_if_needed(connection, &host.id, &plan)?;
    let ripgrep_args = build_ripgrep_args(
        input.mode.clone(),
        root_path,
        &input.query,
        input.include_hidden,
        input.ignore_ignore_files,
        input.follow_symlinks,
    );
    let output = run_remote_command(
        &connection.session,
        &ripgrep_managed_command(target_os, &helper_remote_path, &ripgrep_args),
    )?;
    if output.status > 1 || (matches!(input.mode, FileSearchMode::Name) && output.status != 0) {
        return Ok(None);
    }
    let query = input.query.to_lowercase();
    let limit = search_limit(input.max_results);
    let mut diagnostics = if output.stderr.trim().is_empty() {
        Vec::new()
    } else {
        output.stderr.lines().map(str::to_string).collect()
    };
    let (matches, truncated) = match input.mode {
        FileSearchMode::Name => {
            let mut matches = Vec::new();
            let truncated = collect_remote_rg_name_matches(
                &output.stdout,
                root_path,
                &query,
                limit,
                &mut matches,
            );
            (matches, truncated)
        }
        FileSearchMode::Content => {
            let (matches, truncated, parse_diagnostics) =
                parse_remote_ripgrep_json_matches(&output.stdout, limit);
            diagnostics.extend(parse_diagnostics);
            (matches, truncated)
        }
    };
    Ok(Some(FileSearchResult {
        provider_label: "Nocturne ripgrep helper".to_string(),
        root_path: root_path.to_string(),
        query: input.query.clone(),
        matches,
        diagnostics,
        truncated,
    }))
}

pub(crate) fn connect_sftp_for_host(
    app: &AppHandle,
    host: &ConnectionHostEntry,
    auth_scope: SftpAuthScope<'_>,
    accept_new_host_key: bool,
    update_changed_host_key: bool,
    credential: Option<crate::types::SshCredentialInput>,
    save_credential: bool,
    session_id: &str,
) -> Result<SftpConnection> {
    let ssh = host
        .document
        .ssh
        .clone()
        .ok_or_else(|| invalid_error("ssh connection host requires ssh config"))?;
    let username = default_ssh_username(&ssh)?;
    let auth_target = connection_host_auth_target(
        &host.id,
        &host.document.name,
        &username,
        &ssh.hostname,
        ssh.port,
    );
    let proxy_jump_chain = if matches!(host.source, ConnectionHostSource::OpenSshConfig) {
        match (host.path.as_deref(), ssh.proxy_jump.as_deref()) {
            (Some(path), Some(proxy_jump)) => Some(resolve_openssh_proxy_jump_chain(
                Path::new(path),
                proxy_jump,
            )?),
            _ => None,
        }
    } else {
        None
    };
    let worker_input = SshWorkerInput {
        app: Some(app.clone()),
        session_id: session_id.to_string(),
        workspace_id: auth_scope.workspace_id.to_string(),
        source_tool_tab_id: auth_scope.source_tool_tab_id.map(ToOwned::to_owned),
        display_name: host.document.name.clone(),
        auth_target,
        ssh,
        proxy_jump_chain,
        username,
        size: PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 800,
            pixel_height: 600,
        },
        trust_path: ssh_known_hosts_path(app)?,
        accept_new_host_key,
        update_changed_host_key,
        credential,
        save_credential,
        verification_scope: crate::terminal::SshVerificationScope::Workspace,
    };
    connect_sftp_session(&worker_input)
}

fn connect_sftp_session(input: &SshWorkerInput) -> Result<SftpConnection> {
    let authenticated = connect_authenticated_ssh_session(input)?;
    authenticated.session.set_blocking(true);
    Ok(SftpConnection {
        session: authenticated.session,
        _jump_guards: authenticated.jump_guards,
    })
}

pub(crate) struct RemoteCommandOutput {
    pub(crate) status: i32,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

pub(crate) fn remote_command_succeeds(session: &Session, command: &str) -> Result<bool> {
    Ok(run_remote_command(session, command)?.status == 0)
}

pub(crate) fn run_remote_command(session: &Session, command: &str) -> Result<RemoteCommandOutput> {
    let mut channel = session.channel_session().map_err(terminal_error)?;
    channel.exec(command).map_err(terminal_error)?;
    let mut stdout = String::new();
    channel
        .read_to_string(&mut stdout)
        .map_err(terminal_error)?;
    let mut stderr = String::new();
    channel
        .stderr()
        .read_to_string(&mut stderr)
        .map_err(terminal_error)?;
    channel.wait_close().map_err(terminal_error)?;
    Ok(RemoteCommandOutput {
        status: channel.exit_status().map_err(terminal_error)?,
        stdout,
        stderr,
    })
}

fn build_remote_ripgrep_command(
    mode: FileSearchMode,
    root_path: &str,
    query: &str,
    include_hidden: bool,
    ignore_ignore_files: bool,
    follow_symlinks: bool,
) -> String {
    format!(
        "rg {}",
        build_ripgrep_args(
            mode,
            root_path,
            query,
            include_hidden,
            ignore_ignore_files,
            follow_symlinks,
        )
    )
}

fn build_ripgrep_args(
    mode: FileSearchMode,
    root_path: &str,
    query: &str,
    include_hidden: bool,
    ignore_ignore_files: bool,
    follow_symlinks: bool,
) -> String {
    let mut command = match mode {
        FileSearchMode::Name => String::from("--files"),
        FileSearchMode::Content => String::from("--json"),
    };
    if include_hidden {
        command.push_str(" --hidden");
    }
    if ignore_ignore_files {
        command.push_str(" --no-ignore");
    }
    if follow_symlinks {
        command.push_str(" --follow");
    }
    command.push_str(" -- ");
    if matches!(mode, FileSearchMode::Content) {
        command.push_str(&shell_quote(query));
        command.push(' ');
    }
    command.push_str(&shell_quote(root_path));
    command
}

fn collect_remote_rg_name_matches(
    output: &str,
    root_path: &str,
    query: &str,
    limit: usize,
    matches: &mut Vec<FileSearchMatch>,
) -> bool {
    let mut truncated = false;
    for line in output.lines() {
        if matches.len() >= limit {
            truncated = true;
            break;
        }
        let Some(name) = line
            .rsplit('/')
            .next()
            .filter(|name| name.to_lowercase().contains(query))
        else {
            continue;
        };
        matches.push(FileSearchMatch {
            path: line.to_string(),
            name: name.to_string(),
            kind: remote_rg_kind(root_path, line),
            line_number: None,
            line_text: None,
            ranges: Vec::new(),
        });
    }
    truncated
}

fn parse_remote_ripgrep_json_matches(
    output: &str,
    limit: usize,
) -> (Vec<FileSearchMatch>, bool, Vec<String>) {
    let mut matches = Vec::new();
    let mut diagnostics = Vec::new();
    let mut truncated = false;
    for line in output.lines().filter(|line| !line.trim().is_empty()) {
        if matches.len() >= limit {
            truncated = true;
            break;
        }
        let value = match serde_json::from_str::<serde_json::Value>(line) {
            Ok(value) => value,
            Err(error) => {
                diagnostics.push(format!("invalid rg json event: {error}"));
                continue;
            }
        };
        if value.get("type").and_then(serde_json::Value::as_str) != Some("match") {
            continue;
        }
        let Some(data) = value.get("data") else {
            diagnostics.push("rg match event missing data".to_string());
            continue;
        };
        let Some(path) = data
            .get("path")
            .and_then(|path| path.get("text"))
            .and_then(serde_json::Value::as_str)
        else {
            diagnostics.push("rg match event missing path text".to_string());
            continue;
        };
        let Some(line_text) = data
            .get("lines")
            .and_then(|lines| lines.get("text"))
            .and_then(serde_json::Value::as_str)
        else {
            diagnostics.push(format!("{path}: rg match event missing line text"));
            continue;
        };
        let Some(line_number) = data
            .get("line_number")
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
        else {
            diagnostics.push(format!("{path}: rg match event missing line number"));
            continue;
        };
        let ranges = data
            .get("submatches")
            .and_then(serde_json::Value::as_array)
            .map(|submatches| {
                submatches
                    .iter()
                    .filter_map(|submatch| {
                        let start = submatch
                            .get("start")
                            .and_then(serde_json::Value::as_u64)
                            .and_then(|value| u32::try_from(value).ok())?;
                        let end = submatch
                            .get("end")
                            .and_then(serde_json::Value::as_u64)
                            .and_then(|value| u32::try_from(value).ok())?;
                        Some(FileSearchMatchRange { start, end })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        matches.push(FileSearchMatch {
            path: path.to_string(),
            name: provider_file_name(path),
            kind: FileEntryKind::File,
            line_number: Some(line_number),
            line_text: Some(line_text.trim_end_matches(['\r', '\n']).to_string()),
            ranges,
        });
    }
    (matches, truncated, diagnostics)
}

fn provider_file_name(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(path)
        .to_string()
}

fn ripgrep_helper_resource_path(
    rg_version: &str,
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
) -> String {
    format!(
        "ripgrep/rg-{}-{}-{}{}",
        rg_version,
        remote_target_os_dir(target_os),
        remote_target_arch_dir(target_arch),
        if target_os == RemoteResourceTargetOs::Windows {
            ".exe"
        } else {
            ""
        }
    )
}

fn load_ripgrep_helper_bytes_from_app(
    app: &AppHandle,
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
) -> Result<ResourceHelperBytesSource> {
    let resource_path =
        ripgrep_helper_resource_path(RIPGREP_HELPER_VERSION, target_os, target_arch);
    let resource_dir = app.path().resource_dir().map_err(crate::error::io_error)?;
    load_ripgrep_helper_bytes_from_paths(
        &ripgrep_helper_candidate_paths(&resource_dir, &resource_path),
        "",
        build_info().tag.as_deref(),
        RIPGREP_HELPER_VERSION,
        target_os,
        target_arch,
    )
}

pub fn load_ripgrep_helper_bytes_from_path(
    path: &Path,
    _github_repository: &str,
    _build_tag: Option<&str>,
    rg_version: &str,
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
) -> Result<ResourceHelperBytesSource> {
    load_ripgrep_helper_bytes_from_paths(
        &[path.to_path_buf()],
        _github_repository,
        _build_tag,
        rg_version,
        target_os,
        target_arch,
    )
}

fn load_ripgrep_helper_bytes_from_paths(
    paths: &[PathBuf],
    _github_repository: &str,
    _build_tag: Option<&str>,
    rg_version: &str,
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
) -> Result<ResourceHelperBytesSource> {
    for path in paths {
        match fs::read(path) {
            Ok(bytes) if !bytes.is_empty() => return Ok(ResourceHelperBytesSource::Bundled(bytes)),
            Ok(_) => {
                return Err(invalid_error(format!(
                    "bundled ripgrep helper is empty: {}",
                    path.display()
                )));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(crate::error::io_error(error)),
        }
    }

    match ripgrep_helper_download_plan(rg_version, target_os, target_arch) {
        Some(plan) => Ok(ResourceHelperBytesSource::DownloadRequired(plan)),
        None => Ok(ResourceHelperBytesSource::Unavailable {
            reason: format!(
                "No official ripgrep helper archive is available for {} {}",
                remote_target_os_dir(target_os),
                remote_target_arch_dir(target_arch)
            ),
        }),
    }
}

fn ripgrep_helper_candidate_paths(resource_dir: &Path, resource_path: &str) -> Vec<PathBuf> {
    vec![
        resource_dir.join(resource_path),
        resource_dir.join("resources").join(resource_path),
    ]
}

fn ripgrep_helper_download_plan(
    rg_version: &str,
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
) -> Option<ResourceHelperDownloadPlan> {
    let asset_name = ripgrep_helper_asset_name(rg_version, target_os, target_arch)?;
    let url = format!(
        "https://github.com/BurntSushi/ripgrep/releases/download/{}/{}",
        rg_version, asset_name
    );
    Some(ResourceHelperDownloadPlan {
        tag: rg_version.to_string(),
        asset_name,
        url: url.clone(),
        prompt: format!(
            "The bundled ripgrep helper is missing. Download rg {rg_version} for Files recursive search from the official ripgrep release?\n\n{url}"
        ),
    })
}

fn ripgrep_helper_asset_name(
    rg_version: &str,
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
) -> Option<String> {
    let triple = match (target_os, target_arch) {
        (RemoteResourceTargetOs::Linux, RemoteResourceTargetArch::X86_64) => {
            "x86_64-unknown-linux-musl"
        }
        (RemoteResourceTargetOs::Linux, RemoteResourceTargetArch::Aarch64) => {
            "aarch64-unknown-linux-gnu"
        }
        (RemoteResourceTargetOs::Linux, RemoteResourceTargetArch::Armv7) => {
            "armv7-unknown-linux-musleabihf"
        }
        (RemoteResourceTargetOs::Macos, RemoteResourceTargetArch::X86_64) => "x86_64-apple-darwin",
        (RemoteResourceTargetOs::Macos, RemoteResourceTargetArch::Aarch64) => {
            "aarch64-apple-darwin"
        }
        (RemoteResourceTargetOs::Windows, RemoteResourceTargetArch::X86_64) => {
            "x86_64-pc-windows-msvc"
        }
        (RemoteResourceTargetOs::Windows, RemoteResourceTargetArch::I686) => "i686-pc-windows-msvc",
        _ => return None,
    };
    let extension = if target_os == RemoteResourceTargetOs::Windows {
        "zip"
    } else {
        "tar.gz"
    };
    Some(format!("ripgrep-{rg_version}-{triple}.{extension}"))
}

fn plan_ripgrep_helper_upload(
    helper_bytes: &[u8],
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
    app_version: &str,
    rg_version: &str,
) -> Result<ResourceHelperUploadPlan> {
    if helper_bytes.is_empty() {
        return Err(invalid_error("ripgrep helper bytes cannot be empty"));
    }
    let helper_version = format!("{app_version}+rg.{rg_version}");
    let remote_directory = format!("~/.cache/nocturne/helpers/{app_version}/rg-{rg_version}");
    let helper_upload_path = format!(
        "{}/{}",
        remote_directory,
        ripgrep_helper_executable_name(target_os)
    );
    let manifest_upload_path = format!("{remote_directory}/rg.manifest.json");
    let helper_sha256 = hex::encode(Sha256::digest(helper_bytes));
    let manifest = ResourceHelperManifest {
        helper_name: "rg".to_string(),
        purpose: "Files recursive search".to_string(),
        version: helper_version,
        target_os,
        target_arch,
        upload_path: helper_upload_path.clone(),
        sha256: helper_sha256.clone(),
        capabilities: vec![
            "files.search.name".to_string(),
            "files.search.content".to_string(),
            "ripgrep.json".to_string(),
        ],
    };
    let manifest_json = serde_json::to_string(&manifest)
        .map_err(|error| invalid_error(format!("ripgrep helper manifest JSON failed: {error}")))?;
    Ok(ResourceHelperUploadPlan {
        resource_path: ripgrep_helper_resource_path(rg_version, target_os, target_arch),
        manifest,
        manifest_path: manifest_upload_path.clone(),
        remote_directory,
        helper_upload_path: helper_upload_path.clone(),
        manifest_upload_path,
        executable_mode: ripgrep_helper_executable_mode(target_os),
        verify_sha256_command: ripgrep_helper_verify_sha256_command(
            target_os,
            &helper_upload_path,
            &helper_sha256,
        ),
        launch_stream_command: ripgrep_managed_command(target_os, &helper_upload_path, "--version"),
        helper_bytes: helper_bytes.to_vec(),
        manifest_json,
    })
}

fn remote_target_os_dir(target_os: RemoteResourceTargetOs) -> &'static str {
    match target_os {
        RemoteResourceTargetOs::Linux => "linux",
        RemoteResourceTargetOs::Macos => "macos",
        RemoteResourceTargetOs::Windows => "windows",
    }
}

fn remote_target_arch_dir(target_arch: RemoteResourceTargetArch) -> &'static str {
    match target_arch {
        RemoteResourceTargetArch::X86_64 => "x86_64",
        RemoteResourceTargetArch::Aarch64 => "aarch64",
        RemoteResourceTargetArch::Armv7 => "armv7",
        RemoteResourceTargetArch::I686 => "i686",
    }
}

fn ripgrep_helper_executable_name(target_os: RemoteResourceTargetOs) -> &'static str {
    match target_os {
        RemoteResourceTargetOs::Windows => "rg.exe",
        RemoteResourceTargetOs::Linux | RemoteResourceTargetOs::Macos => "rg",
    }
}

fn ripgrep_helper_executable_mode(target_os: RemoteResourceTargetOs) -> Option<u32> {
    match target_os {
        RemoteResourceTargetOs::Windows => None,
        RemoteResourceTargetOs::Linux | RemoteResourceTargetOs::Macos => Some(0o755),
    }
}

fn ripgrep_helper_verify_sha256_command(
    target_os: RemoteResourceTargetOs,
    helper_path: &str,
    expected_sha256: &str,
) -> String {
    match target_os {
        RemoteResourceTargetOs::Linux => format!(
            "printf '%s  %s\\n' '{expected_sha256}' '{helper_path}' | sha256sum -c -"
        ),
        RemoteResourceTargetOs::Macos => format!(
            "test \"$(shasum -a 256 '{}' | awk '{{print $1}}')\" = '{}'",
            helper_path, expected_sha256
        ),
        RemoteResourceTargetOs::Windows => format!(
            "if ((Get-FileHash -Algorithm SHA256 '{}').Hash.ToLowerInvariant() -ne '{}') {{ exit 1 }}",
            helper_path, expected_sha256
        ),
    }
}

fn ripgrep_managed_command(
    target_os: RemoteResourceTargetOs,
    helper_path: &str,
    ripgrep_args: &str,
) -> String {
    match target_os {
        RemoteResourceTargetOs::Windows => {
            format!("& {} {}", shell_quote(helper_path), ripgrep_args)
        }
        RemoteResourceTargetOs::Linux | RemoteResourceTargetOs::Macos => {
            format!("{} {}", shell_quote(helper_path), ripgrep_args)
        }
    }
}

fn confirm_ripgrep_helper_upload(
    app: &AppHandle,
    host: &ConnectionHostEntry,
    plan: &ResourceHelperUploadPlan,
) -> bool {
    app.dialog()
        .message(format!(
            "Upload rg for Files recursive search?\n\nHost: {}\nTarget: {:?} {:?}\nPath: {}\nSHA-256: {}",
            host.document.name,
            plan.manifest.target_os,
            plan.manifest.target_arch,
            plan.helper_upload_path,
            plan.manifest.sha256
        ))
        .title("Upload ripgrep helper")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Upload".to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show()
}

fn download_ripgrep_helper_after_confirmation(
    app: &AppHandle,
    plan: &ResourceHelperDownloadPlan,
) -> Result<Vec<u8>> {
    let allowed = app
        .dialog()
        .message(plan.prompt.clone())
        .title("Download ripgrep helper")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Download".to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show();
    if !allowed {
        return Err(invalid_error(
            "ripgrep helper download was canceled by the user",
        ));
    }
    download_ripgrep_helper_from_plan(plan)
}

fn download_ripgrep_helper_from_plan(plan: &ResourceHelperDownloadPlan) -> Result<Vec<u8>> {
    let archive_bytes = download_ripgrep_helper_archive_from_url(&plan.url)?;
    extract_ripgrep_helper_from_archive(&archive_bytes, &plan.asset_name)
}

fn download_ripgrep_helper_archive_from_url(url: &str) -> Result<Vec<u8>> {
    let client = reqwest::blocking::Client::builder()
        .timeout(RIPGREP_HELPER_HTTP_TIMEOUT)
        .build()
        .map_err(|error| invalid_error(format!("ripgrep helper HTTP client failed: {error}")))?;
    let response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, "Nocturne Files Search")
        .send()
        .map_err(|error| invalid_error(format!("ripgrep helper download failed: {error}")))?;
    if !response.status().is_success() {
        return Err(invalid_error(format!(
            "ripgrep helper download returned HTTP {}",
            response.status()
        )));
    }
    let bytes = response
        .bytes()
        .map_err(|error| invalid_error(format!("ripgrep helper download read failed: {error}")))?;
    if bytes.is_empty() {
        return Err(invalid_error("downloaded ripgrep helper archive is empty"));
    }
    Ok(bytes.to_vec())
}

fn extract_ripgrep_helper_from_archive(archive_bytes: &[u8], asset_name: &str) -> Result<Vec<u8>> {
    if asset_name.ends_with(".zip") {
        return extract_ripgrep_helper_from_zip(archive_bytes);
    }
    if asset_name.ends_with(".tar.gz") {
        return extract_ripgrep_helper_from_tar_gz(archive_bytes);
    }
    Err(invalid_error(format!(
        "unsupported ripgrep helper archive format: {asset_name}"
    )))
}

fn extract_ripgrep_helper_from_zip(archive_bytes: &[u8]) -> Result<Vec<u8>> {
    let reader = Cursor::new(archive_bytes);
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|error| invalid_error(format!("ripgrep zip archive failed: {error}")))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| invalid_error(format!("ripgrep zip entry failed: {error}")))?;
        if !entry.is_file() || !archive_entry_matches(entry.name(), "rg.exe") {
            continue;
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|error| invalid_error(format!("ripgrep zip read failed: {error}")))?;
        if bytes.is_empty() {
            return Err(invalid_error("downloaded ripgrep helper is empty"));
        }
        return Ok(bytes);
    }
    Err(invalid_error("rg.exe was not found in ripgrep zip archive"))
}

fn extract_ripgrep_helper_from_tar_gz(archive_bytes: &[u8]) -> Result<Vec<u8>> {
    let decoder = flate2::read::GzDecoder::new(Cursor::new(archive_bytes));
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| invalid_error(format!("ripgrep tar archive failed: {error}")))?;
    for entry in entries {
        let mut entry =
            entry.map_err(|error| invalid_error(format!("ripgrep tar entry failed: {error}")))?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry
            .path()
            .map_err(|error| invalid_error(format!("ripgrep tar path failed: {error}")))?;
        if !archive_entry_matches(path.to_string_lossy().as_ref(), "rg") {
            continue;
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|error| invalid_error(format!("ripgrep tar read failed: {error}")))?;
        if bytes.is_empty() {
            return Err(invalid_error("downloaded ripgrep helper is empty"));
        }
        return Ok(bytes);
    }
    Err(invalid_error("rg was not found in ripgrep tar.gz archive"))
}

fn archive_entry_matches(path: &str, expected_name: &str) -> bool {
    Path::new(path).file_name().and_then(|name| name.to_str()) == Some(expected_name)
}

fn ripgrep_helper_verified(host_id: &str, expected_sha256: &str) -> Result<bool> {
    Ok(ripgrep_helper_deployment_memory()
        .lock()
        .map_err(|_| invalid_error("ripgrep helper deployment memory is poisoned"))?
        .verified_hash(host_id)
        == Some(expected_sha256))
}

fn deploy_ripgrep_helper_if_needed(
    connection: &SftpConnection,
    host_id: &str,
    plan: &ResourceHelperUploadPlan,
) -> Result<String> {
    let home = remote_home_path_from_shell(&connection.session)?;
    let helper_upload_path = expand_remote_home(&plan.helper_upload_path, &home);
    if ripgrep_helper_verified(host_id, &plan.manifest.sha256)? {
        return Ok(helper_upload_path);
    }
    deploy_ripgrep_helper(connection, plan, &home)?;
    ripgrep_helper_deployment_memory()
        .lock()
        .map_err(|_| invalid_error("ripgrep helper deployment memory is poisoned"))?
        .record_verified(host_id, plan.manifest.sha256.clone());
    Ok(helper_upload_path)
}

fn deploy_ripgrep_helper(
    connection: &SftpConnection,
    plan: &ResourceHelperUploadPlan,
    home: &str,
) -> Result<()> {
    let sftp = connection.session.sftp().map_err(terminal_error)?;
    let remote_directory = expand_remote_home(&plan.remote_directory, home);
    let helper_upload_path = expand_remote_home(&plan.helper_upload_path, home);
    let manifest_upload_path = expand_remote_home(&plan.manifest_upload_path, home);

    ensure_sftp_directory(&sftp, Path::new(&remote_directory))?;
    write_sftp_file(
        &sftp,
        Path::new(&helper_upload_path),
        &plan.helper_bytes,
        0o755,
    )?;
    write_sftp_file(
        &sftp,
        Path::new(&manifest_upload_path),
        plan.manifest_json.as_bytes(),
        0o644,
    )?;
    if let Some(mode) = plan.executable_mode {
        sftp.setstat(
            Path::new(&helper_upload_path),
            FileStat {
                size: None,
                uid: None,
                gid: None,
                perm: Some(mode),
                atime: None,
                mtime: None,
            },
        )
        .map_err(terminal_error)?;
    }

    let verify_command = plan
        .verify_sha256_command
        .replace(&plan.helper_upload_path, &helper_upload_path);
    let output = run_remote_command(&connection.session, &verify_command)?;
    if output.status != 0 {
        return Err(invalid_error(format!(
            "uploaded ripgrep helper hash verification failed: {}",
            output.stderr.trim()
        )));
    }
    Ok(())
}

fn remote_home_path_from_shell(session: &Session) -> Result<String> {
    let output = run_remote_command(session, "printf %s \"$HOME\"")?;
    let home = output.stdout.trim();
    if home.is_empty() {
        return Err(invalid_error("remote HOME is unavailable"));
    }
    Ok(home.to_string())
}

fn expand_remote_home(path: &str, home: &str) -> String {
    if path == "~" {
        return home.to_string();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return format!("{}/{}", home.trim_end_matches('/'), rest);
    }
    path.to_string()
}

fn ensure_sftp_directory(sftp: &Sftp, path: &Path) -> Result<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if current.as_os_str().is_empty() {
            continue;
        }
        if sftp.stat(&current).is_ok() {
            continue;
        }
        sftp.mkdir(&current, 0o755).map_err(terminal_error)?;
    }
    Ok(())
}

fn write_sftp_file(sftp: &Sftp, path: &Path, bytes: &[u8], mode: i32) -> Result<()> {
    let mut file = sftp
        .open_mode(
            path,
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
            mode,
            OpenType::File,
        )
        .map_err(terminal_error)?;
    file.write_all(bytes).map_err(terminal_error)
}

pub fn build_remote_ripgrep_command_for_test(
    mode: FileSearchMode,
    root_path: &str,
    query: &str,
    include_hidden: bool,
    ignore_ignore_files: bool,
    follow_symlinks: bool,
) -> String {
    build_remote_ripgrep_command(
        mode,
        root_path,
        query,
        include_hidden,
        ignore_ignore_files,
        follow_symlinks,
    )
}

pub fn parse_remote_ripgrep_json_matches_for_test(
    output: &str,
    limit: usize,
) -> (Vec<FileSearchMatch>, bool, Vec<String>) {
    parse_remote_ripgrep_json_matches(output, limit)
}

pub fn ripgrep_helper_resource_path_for_test(
    rg_version: &str,
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
) -> String {
    ripgrep_helper_resource_path(rg_version, target_os, target_arch)
}

pub fn ripgrep_helper_asset_name_for_test(
    rg_version: &str,
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
) -> Option<String> {
    ripgrep_helper_asset_name(rg_version, target_os, target_arch)
}

pub fn extract_ripgrep_helper_from_archive_for_test(
    archive_bytes: &[u8],
    asset_name: &str,
) -> Result<Vec<u8>> {
    extract_ripgrep_helper_from_archive(archive_bytes, asset_name)
}

pub fn load_ripgrep_helper_bytes_from_path_for_test(
    path: &Path,
    github_repository: &str,
    build_tag: Option<&str>,
    rg_version: &str,
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
) -> Result<ResourceHelperBytesSource> {
    load_ripgrep_helper_bytes_from_path(
        path,
        github_repository,
        build_tag,
        rg_version,
        target_os,
        target_arch,
    )
}

pub fn load_ripgrep_helper_bytes_from_paths_for_test(
    paths: &[PathBuf],
    github_repository: &str,
    build_tag: Option<&str>,
    rg_version: &str,
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
) -> Result<ResourceHelperBytesSource> {
    load_ripgrep_helper_bytes_from_paths(
        paths,
        github_repository,
        build_tag,
        rg_version,
        target_os,
        target_arch,
    )
}

pub fn ripgrep_helper_candidate_paths_for_test(
    resource_dir: &Path,
    resource_path: &str,
) -> Vec<PathBuf> {
    ripgrep_helper_candidate_paths(resource_dir, resource_path)
}

pub fn plan_ripgrep_helper_upload_for_test(
    helper_bytes: &[u8],
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
    app_version: &str,
    rg_version: &str,
) -> Result<ResourceHelperUploadPlan> {
    plan_ripgrep_helper_upload(
        helper_bytes,
        target_os,
        target_arch,
        app_version,
        rg_version,
    )
}

pub fn ripgrep_managed_command_for_test(
    target_os: RemoteResourceTargetOs,
    helper_path: &str,
    ripgrep_args: &str,
) -> String {
    ripgrep_managed_command(target_os, helper_path, ripgrep_args)
}

fn remote_rg_kind(root_path: &str, path: &str) -> FileEntryKind {
    if path == root_path || path.ends_with('/') {
        FileEntryKind::Directory
    } else {
        FileEntryKind::File
    }
}

pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn remote_helper_policy(app: &AppHandle) -> Result<RemoteHelperPolicy> {
    let config = effective_application_config(app)?;
    let table = config
        .as_table()
        .ok_or_else(|| invalid_error("effective config must be a TOML table"))?;
    let value = table
        .get("files")
        .and_then(toml::Value::as_table)
        .and_then(|files| files.get("remote_helper_policy"))
        .and_then(toml::Value::as_str)
        .unwrap_or("ask");
    match value {
        "ask" => Ok(RemoteHelperPolicy::Ask),
        "never" => Ok(RemoteHelperPolicy::Never),
        "allow" => Ok(RemoteHelperPolicy::Allow),
        _ => Err(invalid_error(
            "files.remote_helper_policy must be ask, never, or allow",
        )),
    }
}

fn validate_child_name(name: &str) -> Result<()> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(invalid_error("file name cannot be empty"));
    }
    if trimmed == "." || trimmed == ".." {
        return Err(invalid_error("file name cannot be . or .."));
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains('\0') {
        return Err(invalid_error("file name cannot contain path separators"));
    }
    Ok(())
}

fn join_provider_path(parent: &str, name: &str, protocol: ConnectionProtocol) -> String {
    match protocol {
        ConnectionProtocol::Local => PathBuf::from(expand_local_home(parent.to_string()))
            .join(name)
            .to_string_lossy()
            .into_owned(),
        ConnectionProtocol::Ssh | ConnectionProtocol::Telnet => join_remote_path(parent, name),
    }
}

fn delete_local_path(path: &str) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if metadata.file_type().is_dir() {
        fs::remove_dir_all(path).map_err(io_error)
    } else {
        fs::remove_file(path).map_err(io_error)
    }
}

fn parse_chmod_mode(value: &str) -> Result<u32> {
    let trimmed = value.trim();
    if trimmed.len() < 3 || trimmed.len() > 4 {
        return Err(invalid_error(
            "mode must be an octal value such as 644 or 0755",
        ));
    }
    if !trimmed.bytes().all(|byte| (b'0'..=b'7').contains(&byte)) {
        return Err(invalid_error("mode must contain only octal digits"));
    }
    let mode = u32::from_str_radix(trimmed, 8)
        .map_err(|_| invalid_error("mode must be an octal value"))?;
    if mode > 0o7777 {
        return Err(invalid_error("mode cannot be greater than 7777"));
    }
    Ok(mode)
}

#[cfg(unix)]
fn chmod_local_path(path: &str, mode: u32) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    let mut permissions = metadata.permissions();
    permissions.set_mode(mode);
    fs::set_permissions(path, permissions).map_err(io_error)
}

#[cfg(not(unix))]
fn chmod_local_path(_path: &str, _mode: u32) -> Result<()> {
    Err(invalid_error(
        "chmod is not supported by the local provider on this platform",
    ))
}

fn delete_sftp_path(sftp: &Sftp, path: &Path) -> Result<()> {
    let stat = sftp.lstat(path).map_err(terminal_error)?;
    if matches!(sftp_entry_kind(stat.perm), FileEntryKind::Directory) {
        let children = sftp.readdir(path).map_err(terminal_error)?;
        for (child_path, _child_stat) in children {
            let Some(name) = child_path.file_name().and_then(|value| value.to_str()) else {
                return Err(invalid_error("remote path contains an invalid file name"));
            };
            if name == "." || name == ".." {
                continue;
            }
            delete_sftp_path(sftp, &child_path)?;
        }
        sftp.rmdir(path).map_err(terminal_error)
    } else {
        sftp.unlink(path).map_err(terminal_error)
    }
}

fn remote_trash_info_for_sftp(session: &Session, sftp: &Sftp) -> Result<FileTrashInfo> {
    let home_path = sftp_default_path(session, sftp, None)?;
    let trash_root = join_remote_path(&join_remote_path(&home_path, ".local"), "share/Trash");
    let files_path = join_remote_path(&trash_root, "files");
    let info_path = join_remote_path(&trash_root, "info");
    let files_exists = sftp_directory_exists(sftp, Path::new(&files_path));
    let info_exists = sftp_directory_exists(sftp, Path::new(&info_path));
    Ok(FileTrashInfo {
        available: files_exists && info_exists,
        home_path,
        files_path: (files_exists && info_exists).then_some(files_path),
        info_path: (files_exists && info_exists).then_some(info_path),
        reason: if files_exists && info_exists {
            None
        } else {
            Some("XDG Trash was not found under the remote home directory".to_string())
        },
    })
}

fn preview_local_file(input: FilePreviewInput) -> Result<FilePreviewResult> {
    let path = expand_local_home(input.path);
    let metadata = fs::symlink_metadata(&path).map_err(io_error)?;
    let file_type = metadata.file_type();
    let entry_kind = local_entry_kind(&file_type);
    let size = metadata.len();
    let content = if matches!(entry_kind, FileEntryKind::Directory) {
        FilePreviewContent::Unsupported {
            reason: "Directories cannot be previewed.".to_string(),
        }
    } else if let Some(mime) = image_mime_for_path(Path::new(&path)) {
        if size > u64::from(input.image_limit_bytes) {
            FilePreviewContent::TooLarge {
                limit_bytes: input.image_limit_bytes,
            }
        } else {
            let data = fs::read(&path).map_err(io_error)?;
            FilePreviewContent::Image {
                mime,
                data_base64: BASE64_STANDARD.encode(data),
            }
        }
    } else if looks_like_text_path(Path::new(&path)) {
        if size > u64::from(input.text_limit_bytes) {
            FilePreviewContent::TooLarge {
                limit_bytes: input.text_limit_bytes,
            }
        } else {
            FilePreviewContent::Text {
                text: fs::read_to_string(&path).map_err(io_error)?,
            }
        }
    } else {
        FilePreviewContent::Unsupported {
            reason: "This file type is not previewable yet.".to_string(),
        }
    };
    Ok(FilePreviewResult {
        path: path.clone(),
        name: Path::new(&path)
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone()),
        entry_kind,
        size: Some(size.to_string()),
        modified_unix_ms: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis().to_string()),
        permissions: local_permissions(&metadata),
        content,
    })
}

fn preview_sftp_file(sftp: &Sftp, input: FilePreviewInput) -> Result<FilePreviewResult> {
    let path = Path::new(&input.path);
    let stat = sftp.lstat(path).map_err(terminal_error)?;
    let entry_kind = sftp_entry_kind(stat.perm);
    let size = stat.size.unwrap_or(0);
    let content = if matches!(entry_kind, FileEntryKind::Directory) {
        FilePreviewContent::Unsupported {
            reason: "Directories cannot be previewed.".to_string(),
        }
    } else if let Some(mime) = image_mime_for_path(path) {
        if size > u64::from(input.image_limit_bytes) {
            FilePreviewContent::TooLarge {
                limit_bytes: input.image_limit_bytes,
            }
        } else {
            let data = read_sftp_file_limited(sftp, path, input.image_limit_bytes)?;
            FilePreviewContent::Image {
                mime,
                data_base64: BASE64_STANDARD.encode(data),
            }
        }
    } else if looks_like_text_path(path) {
        if size > u64::from(input.text_limit_bytes) {
            FilePreviewContent::TooLarge {
                limit_bytes: input.text_limit_bytes,
            }
        } else {
            let data = read_sftp_file_limited(sftp, path, input.text_limit_bytes)?;
            FilePreviewContent::Text {
                text: String::from_utf8(data)
                    .map_err(|_| invalid_error("preview file is not valid UTF-8 text"))?,
            }
        }
    } else {
        FilePreviewContent::Unsupported {
            reason: "This file type is not previewable yet.".to_string(),
        }
    };
    Ok(FilePreviewResult {
        path: input.path.clone(),
        name: path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| input.path.clone()),
        entry_kind,
        size: stat.size.map(|value| value.to_string()),
        modified_unix_ms: stat
            .mtime
            .map(|value| (u128::from(value) * 1000).to_string()),
        permissions: stat.perm.map(octal_permissions),
        content,
    })
}

fn validate_preview_limits(text_limit_bytes: u32, image_limit_bytes: u32) -> Result<()> {
    if usize::try_from(text_limit_bytes).unwrap_or(usize::MAX) > MAX_PREVIEW_READ_BYTES {
        return Err(invalid_error("text preview limit is too large"));
    }
    if usize::try_from(image_limit_bytes).unwrap_or(usize::MAX) > MAX_PREVIEW_READ_BYTES {
        return Err(invalid_error("image preview limit is too large"));
    }
    Ok(())
}

fn read_sftp_file_limited(sftp: &Sftp, path: &Path, limit: u32) -> Result<Vec<u8>> {
    let mut file = sftp.open(path).map_err(terminal_error)?;
    let capacity =
        usize::try_from(limit).map_err(|_| invalid_error("preview limit is too large"))?;
    let mut data = Vec::with_capacity(capacity.min(64 * 1024));
    let mut handle = std::io::Read::by_ref(&mut file).take(u64::from(limit) + 1);
    handle.read_to_end(&mut data).map_err(terminal_error)?;
    if data.len() > capacity {
        return Err(invalid_error("preview exceeded configured limit"));
    }
    Ok(data)
}

fn image_mime_for_path(path: &Path) -> Option<String> {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
    {
        Some(extension) if extension == "png" => Some("image/png".to_string()),
        Some(extension) if extension == "jpg" || extension == "jpeg" => {
            Some("image/jpeg".to_string())
        }
        Some(extension) if extension == "webp" => Some("image/webp".to_string()),
        Some(extension) if extension == "gif" => Some("image/gif".to_string()),
        _ => None,
    }
}

fn looks_like_text_path(path: &Path) -> bool {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
    {
        Some(extension) => matches!(
            extension.as_str(),
            "txt"
                | "md"
                | "markdown"
                | "json"
                | "toml"
                | "yaml"
                | "yml"
                | "xml"
                | "csv"
                | "log"
                | "rs"
                | "ts"
                | "tsx"
                | "js"
                | "jsx"
                | "svelte"
                | "css"
                | "scss"
                | "html"
                | "sh"
                | "bash"
                | "zsh"
                | "fish"
                | "py"
                | "go"
                | "java"
                | "c"
                | "h"
                | "cpp"
                | "hpp"
                | "sql"
                | "ini"
                | "conf"
                | "env"
        ),
        None => path
            .file_name()
            .and_then(|value| value.to_str())
            .map(|name| matches!(name, "Makefile" | "Dockerfile" | ".gitignore" | ".env"))
            .unwrap_or(false),
    }
}

fn move_sftp_path_to_trash(session: &Session, sftp: &Sftp, path: &Path) -> Result<()> {
    let trash = remote_trash_info_for_sftp(session, sftp)?;
    if !trash.available {
        return Err(invalid_error(trash.reason.unwrap_or_else(|| {
            "remote Trash is not available for this host".to_string()
        })));
    }
    let files_path = trash
        .files_path
        .ok_or_else(|| invalid_error("remote Trash files path is missing"))?;
    let info_path = trash
        .info_path
        .ok_or_else(|| invalid_error("remote Trash info path is missing"))?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| invalid_error("remote path contains an invalid file name"))?;
    if name == "." || name == ".." {
        return Err(invalid_error("cannot trash . or .."));
    }
    let trashed_name = unique_sftp_trash_name(sftp, &files_path, &info_path, name)?;
    let destination_path = join_remote_path(&files_path, &trashed_name);
    let info_file_path = join_remote_path(&info_path, &format!("{trashed_name}.trashinfo"));
    let trashinfo = format!(
        "[Trash Info]\nPath={}\nDeletionDate={}\n",
        trashinfo_escape_path(&path.to_string_lossy()),
        trashinfo_deletion_date()
    );
    let mut info_file = sftp
        .open_mode(
            Path::new(&info_file_path),
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUSIVE,
            0o600,
            OpenType::File,
        )
        .map_err(terminal_error)?;
    if let Err(error) = info_file.write_all(trashinfo.as_bytes()) {
        return Err(terminal_error(error));
    }
    if let Err(error) = sftp.rename(path, Path::new(&destination_path), None) {
        let _ = sftp.unlink(Path::new(&info_file_path));
        return Err(terminal_error(error));
    }
    Ok(())
}

fn sftp_directory_exists(sftp: &Sftp, path: &Path) -> bool {
    match sftp.lstat(path) {
        Ok(stat) => matches!(sftp_entry_kind(stat.perm), FileEntryKind::Directory),
        Err(_) => false,
    }
}

fn unique_sftp_trash_name(
    sftp: &Sftp,
    files_path: &str,
    info_path: &str,
    name: &str,
) -> Result<String> {
    let sanitized = sanitize_trash_name(name)?;
    for index in 0..10_000 {
        let candidate = if index == 0 {
            sanitized.clone()
        } else {
            format!("{sanitized}.{index}")
        };
        let file_candidate = join_remote_path(files_path, &candidate);
        let info_candidate = join_remote_path(info_path, &format!("{candidate}.trashinfo"));
        if sftp.lstat(Path::new(&file_candidate)).is_err()
            && sftp.lstat(Path::new(&info_candidate)).is_err()
        {
            return Ok(candidate);
        }
    }
    Err(invalid_error(
        "could not allocate a unique remote Trash file name",
    ))
}

fn sanitize_trash_name(name: &str) -> Result<String> {
    validate_child_name(name)?;
    Ok(name.replace('\n', "_").replace('\r', "_"))
}

fn trashinfo_escape_path(value: &str) -> String {
    let mut output = String::new();
    for byte in value.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'.' | b'_' | b'-' | b'~' => {
                output.push(char::from(*byte))
            }
            _ => output.push_str(&format!("%{byte:02X}")),
        }
    }
    output
}

fn trashinfo_deletion_date() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let days = seconds / 86_400;
    let seconds_of_day = seconds % 86_400;
    let (year, month, day) = civil_from_days(days as i64);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}")
}

fn civil_from_days(days_since_unix_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_unix_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if month <= 2 { 1 } else { 0 };
    (year as i32, month as u32, day as u32)
}

fn scan_local_search_path(
    path: &Path,
    query: &str,
    include_hidden: bool,
    follow_symlinks: bool,
    limit: usize,
    matches: &mut Vec<FileSearchMatch>,
    diagnostics: &mut Vec<String>,
    visited: &mut HashSet<PathBuf>,
) -> Result<bool> {
    if matches.len() >= limit {
        return Ok(true);
    }
    let canonical = if follow_symlinks {
        match fs::canonicalize(path) {
            Ok(value) => Some(value),
            Err(error) => {
                diagnostics.push(format!("{}: {error}", path.display()));
                None
            }
        }
    } else {
        None
    };
    if let Some(canonical) = canonical {
        if !visited.insert(canonical) {
            return Ok(false);
        }
    }
    let read_dir = match fs::read_dir(path) {
        Ok(value) => value,
        Err(error) => {
            diagnostics.push(format!("{}: {error}", path.display()));
            return Ok(false);
        }
    };
    for entry in read_dir {
        if matches.len() >= limit {
            return Ok(true);
        }
        let entry = match entry {
            Ok(value) => value,
            Err(error) => {
                diagnostics.push(format!("{}: {error}", path.display()));
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if !include_hidden && name.starts_with('.') {
            continue;
        }
        let entry_path = entry.path();
        let metadata = if follow_symlinks {
            fs::metadata(&entry_path)
        } else {
            fs::symlink_metadata(&entry_path)
        };
        let metadata = match metadata {
            Ok(value) => value,
            Err(error) => {
                diagnostics.push(format!("{}: {error}", entry_path.display()));
                continue;
            }
        };
        let file_type = metadata.file_type();
        let kind = local_entry_kind(&file_type);
        if name.to_lowercase().contains(query) {
            matches.push(FileSearchMatch {
                path: entry_path.to_string_lossy().into_owned(),
                name: name.clone(),
                kind: kind.clone(),
                line_number: None,
                line_text: None,
                ranges: Vec::new(),
            });
        }
        if matches.len() >= limit {
            return Ok(true);
        }
        if matches!(kind, FileEntryKind::Directory)
            && scan_local_search_path(
                &entry_path,
                query,
                include_hidden,
                follow_symlinks,
                limit,
                matches,
                diagnostics,
                visited,
            )?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn scan_local_content_search_path(
    path: &Path,
    query: &str,
    include_hidden: bool,
    follow_symlinks: bool,
    limit: usize,
    matches: &mut Vec<FileSearchMatch>,
    diagnostics: &mut Vec<String>,
    visited: &mut HashSet<PathBuf>,
) -> Result<bool> {
    if matches.len() >= limit {
        return Ok(true);
    }
    let canonical = if follow_symlinks {
        match fs::canonicalize(path) {
            Ok(value) => Some(value),
            Err(error) => {
                diagnostics.push(format!("{}: {error}", path.display()));
                None
            }
        }
    } else {
        None
    };
    if let Some(canonical) = canonical {
        if !visited.insert(canonical) {
            return Ok(false);
        }
    }
    let children = match fs::read_dir(path) {
        Ok(value) => value,
        Err(error) => {
            diagnostics.push(format!("{}: {error}", path.display()));
            return Ok(false);
        }
    };
    for entry in children {
        if matches.len() >= limit {
            return Ok(true);
        }
        let entry = match entry {
            Ok(value) => value,
            Err(error) => {
                diagnostics.push(format!("{}: {error}", path.display()));
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if !include_hidden && name.starts_with('.') {
            continue;
        }
        let entry_path = entry.path();
        let metadata = if follow_symlinks {
            fs::metadata(&entry_path)
        } else {
            fs::symlink_metadata(&entry_path)
        };
        let metadata = match metadata {
            Ok(value) => value,
            Err(error) => {
                diagnostics.push(format!("{}: {error}", entry_path.display()));
                continue;
            }
        };
        let kind = local_entry_kind(&metadata.file_type());
        match kind {
            FileEntryKind::Directory => {
                if scan_local_content_search_path(
                    &entry_path,
                    query,
                    include_hidden,
                    follow_symlinks,
                    limit,
                    matches,
                    diagnostics,
                    visited,
                )? {
                    return Ok(true);
                }
            }
            FileEntryKind::File | FileEntryKind::Symlink => {
                let Ok(content) = fs::read_to_string(&entry_path) else {
                    continue;
                };
                for (index, line) in content.lines().enumerate() {
                    if matches.len() >= limit {
                        return Ok(true);
                    }
                    let lowercase = line.to_lowercase();
                    let Some(byte_start) = lowercase.find(query) else {
                        continue;
                    };
                    let byte_end = byte_start + query.len();
                    matches.push(FileSearchMatch {
                        path: entry_path.to_string_lossy().into_owned(),
                        name: name.clone(),
                        kind: kind.clone(),
                        line_number: u32::try_from(index + 1).ok(),
                        line_text: Some(line.to_string()),
                        ranges: vec![FileSearchMatchRange {
                            start: u32::try_from(byte_start).unwrap_or(u32::MAX),
                            end: u32::try_from(byte_end).unwrap_or(u32::MAX),
                        }],
                    });
                }
            }
            FileEntryKind::Other => {}
        }
    }
    Ok(false)
}

fn scan_sftp_search_path(
    sftp: &Sftp,
    path: &Path,
    query: &str,
    include_hidden: bool,
    follow_symlinks: bool,
    limit: usize,
    matches: &mut Vec<FileSearchMatch>,
    diagnostics: &mut Vec<String>,
) -> Result<bool> {
    if matches.len() >= limit {
        return Ok(true);
    }
    let children = match sftp.readdir(path) {
        Ok(value) => value,
        Err(error) => {
            diagnostics.push(format!("{}: {error}", path.display()));
            return Ok(false);
        }
    };
    for (child_path, stat) in children {
        if matches.len() >= limit {
            return Ok(true);
        }
        let Some(name) = child_path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
        else {
            diagnostics.push(format!(
                "{}: invalid remote file name",
                child_path.display()
            ));
            continue;
        };
        if name == "." || name == ".." || (!include_hidden && name.starts_with('.')) {
            continue;
        }
        let kind = sftp_entry_kind(stat.perm);
        if name.to_lowercase().contains(query) {
            matches.push(FileSearchMatch {
                path: child_path.to_string_lossy().into_owned(),
                name: name.clone(),
                kind: kind.clone(),
                line_number: None,
                line_text: None,
                ranges: Vec::new(),
            });
        }
        if matches.len() >= limit {
            return Ok(true);
        }
        if matches!(kind, FileEntryKind::Directory)
            && scan_sftp_search_path(
                sftp,
                &child_path,
                query,
                include_hidden,
                follow_symlinks,
                limit,
                matches,
                diagnostics,
            )?
        {
            return Ok(true);
        }
        if follow_symlinks && matches!(kind, FileEntryKind::Symlink) {
            diagnostics.push(format!(
                "{}: following remote symlinks is not available in SFTP scan",
                child_path.display()
            ));
        }
    }
    Ok(false)
}

fn local_file_entry(entry: fs::DirEntry) -> Result<FileEntry> {
    let path = entry.path();
    let metadata = fs::symlink_metadata(&path).map_err(io_error)?;
    let file_type = metadata.file_type();
    Ok(FileEntry {
        name: entry.file_name().to_string_lossy().into_owned(),
        path: normalize_local_display_path(&path.to_string_lossy()),
        kind: local_entry_kind(&file_type),
        size: Some(metadata.len().to_string()),
        modified_unix_ms: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis().to_string()),
        permissions: local_permissions(&metadata),
        owner: None,
        group: None,
        symlink_target: if file_type.is_symlink() {
            fs::read_link(&path)
                .ok()
                .map(|target| target.to_string_lossy().into_owned())
        } else {
            None
        },
    })
}

fn local_entry_kind(file_type: &fs::FileType) -> FileEntryKind {
    if file_type.is_dir() {
        FileEntryKind::Directory
    } else if file_type.is_symlink() {
        FileEntryKind::Symlink
    } else if file_type.is_file() {
        FileEntryKind::File
    } else {
        FileEntryKind::Other
    }
}

fn sftp_file_entry(parent: &str, path: PathBuf, stat: FileStat) -> Option<FileEntry> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    if name == "." || name == ".." {
        return None;
    }
    let full_path = join_remote_path(parent, &name);
    let permissions = stat.perm;
    Some(FileEntry {
        name,
        path: full_path,
        kind: sftp_entry_kind(permissions),
        size: stat.size.map(|value| value.to_string()),
        modified_unix_ms: stat
            .mtime
            .map(|value| (u128::from(value) * 1000).to_string()),
        permissions: permissions.map(octal_permissions),
        owner: stat.uid.map(|value| value.to_string()),
        group: stat.gid.map(|value| value.to_string()),
        symlink_target: None,
    })
}

fn local_default_path(host: &ConnectionHostEntry) -> Result<String> {
    let configured = host
        .document
        .files
        .as_ref()
        .and_then(|files| files.default_path.clone())
        .or_else(|| {
            host.document
                .local
                .as_ref()
                .and_then(|local| local.cwd.clone())
        });
    Ok(configured
        .filter(|value| !value.trim().is_empty())
        .map(expand_local_home)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("/"))
                .to_string_lossy()
                .into_owned()
        }))
}

fn local_filesystem_root_path() -> String {
    #[cfg(windows)]
    {
        "/".to_string()
    }
    #[cfg(not(windows))]
    {
        "/".to_string()
    }
}

fn normalize_local_display_path(value: &str) -> String {
    #[cfg(windows)]
    {
        let with_forward_slashes = value.replace('\\', "/");
        if with_forward_slashes == "/" {
            return "/".to_string();
        }
        if with_forward_slashes.len() == 2
            && with_forward_slashes.as_bytes()[1] == b':'
            && with_forward_slashes.as_bytes()[0].is_ascii_alphabetic()
        {
            return format!("{with_forward_slashes}/");
        }
        return with_forward_slashes;
    }
    #[cfg(not(windows))]
    {
        value.to_string()
    }
}

#[cfg(windows)]
fn is_windows_virtual_root(path: &str) -> bool {
    let trimmed = path.trim();
    trimmed == "/" || trimmed == "\\"
}

#[cfg(windows)]
fn windows_drive_entries() -> Result<Vec<FileEntry>> {
    use windows_sys::Win32::Storage::FileSystem::GetLogicalDrives;

    let mask = unsafe { GetLogicalDrives() };
    if mask == 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    let mut entries = Vec::new();
    for index in 0..26 {
        if mask & (1 << index) == 0 {
            continue;
        }
        let letter = char::from(b'A' + index as u8);
        let name = format!("{letter}:");
        entries.push(FileEntry {
            name: name.clone(),
            path: format!("{name}/"),
            kind: FileEntryKind::Directory,
            size: None,
            modified_unix_ms: None,
            permissions: None,
            owner: None,
            group: None,
            symlink_target: None,
        });
    }
    Ok(entries)
}

fn sftp_default_path(
    session: &Session,
    sftp: &ssh2::Sftp,
    configured: Option<String>,
) -> Result<String> {
    if let Some(path) = configured {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            if trimmed == "~" {
                return remote_home_path(session, sftp);
            }
            if let Some(rest) = trimmed.strip_prefix("~/") {
                return Ok(join_remote_path(&remote_home_path(session, sftp)?, rest));
            }
            return Ok(trimmed.to_string());
        }
    }
    remote_home_path(session, sftp)
}

fn sftp_current_path(requested: Option<String>, default_path: &str) -> String {
    let Some(path) = requested else {
        return default_path.to_string();
    };
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed == "~" || looks_like_local_desktop_path(trimmed) {
        return default_path.to_string();
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        return join_remote_path(default_path, rest);
    }
    trimmed.to_string()
}

fn looks_like_local_desktop_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() >= 3
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
        && bytes[0].is_ascii_alphabetic()
    {
        return true;
    }
    value.contains('\\')
}

fn remote_home_path(session: &Session, sftp: &ssh2::Sftp) -> Result<String> {
    let output = run_remote_command(session, "printf %s \"$HOME\"")?;
    let home = output.stdout.trim();
    if !home.is_empty() {
        return Ok(home.to_string());
    }
    sftp.realpath(Path::new("."))
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(terminal_error)
}

pub(crate) fn expand_local_home(value: String) -> String {
    if value == "~" {
        return dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("~"))
            .to_string_lossy()
            .into_owned();
    }
    if let Some(rest) = value.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    value
}

pub(crate) fn join_remote_path(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", parent.trim_end_matches('/'), name)
    }
}

fn sort_entries(mut entries: Vec<FileEntry>) -> Vec<FileEntry> {
    entries.sort_by(|left, right| {
        let left_dir = matches!(left.kind, FileEntryKind::Directory);
        let right_dir = matches!(right.kind, FileEntryKind::Directory);
        right_dir
            .cmp(&left_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    entries
}

fn search_limit(value: u32) -> usize {
    usize::try_from(value)
        .ok()
        .filter(|limit| *limit > 0)
        .unwrap_or(DEFAULT_SEARCH_LIMIT)
}

fn sftp_entry_kind(permissions: Option<u32>) -> FileEntryKind {
    let Some(permissions) = permissions else {
        return FileEntryKind::Other;
    };
    match permissions & libc_mode::S_IFMT {
        libc_mode::S_IFDIR => FileEntryKind::Directory,
        libc_mode::S_IFLNK => FileEntryKind::Symlink,
        libc_mode::S_IFREG => FileEntryKind::File,
        _ => FileEntryKind::Other,
    }
}

fn octal_permissions(value: u32) -> String {
    format!("{:03o}", value & 0o7777)
}

#[cfg(unix)]
fn local_permissions(metadata: &fs::Metadata) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;
    Some(octal_permissions(metadata.permissions().mode()))
}

#[cfg(not(unix))]
fn local_permissions(_metadata: &fs::Metadata) -> Option<String> {
    None
}

fn local_capabilities() -> FileProviderCapabilities {
    FileProviderCapabilities {
        can_read: true,
        can_write: true,
        can_rename: true,
        can_delete: true,
        can_trash: true,
        can_chmod: cfg!(unix),
        can_symlink: true,
        can_watch: true,
        can_search_by_name: true,
        can_search_content: true,
        can_upload_helper: false,
        supports_server_side_copy: true,
        supports_atomic_rename: true,
        supports_metadata_owner_group: cfg!(unix),
    }
}

fn sftp_capabilities() -> FileProviderCapabilities {
    FileProviderCapabilities {
        can_read: true,
        can_write: true,
        can_rename: true,
        can_delete: true,
        can_trash: false,
        can_chmod: true,
        can_symlink: true,
        can_watch: false,
        can_search_by_name: true,
        can_search_content: true,
        can_upload_helper: true,
        supports_server_side_copy: false,
        supports_atomic_rename: true,
        supports_metadata_owner_group: true,
    }
}

mod libc_mode {
    pub const S_IFMT: u32 = 0o170000;
    pub const S_IFREG: u32 = 0o100000;
    pub const S_IFDIR: u32 = 0o040000;
    pub const S_IFLNK: u32 = 0o120000;
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn local_file_provider_uses_filesystem_root_with_default_path_as_current_path() {
        let root = tempdir().expect("tempdir");
        let host = ConnectionHostEntry {
            id: "local-fixture".to_string(),
            path: None,
            source: ConnectionHostSource::User,
            read_only: false,
            document: crate::types::ConnectionHostDocument {
                version: 1,
                id: "local-fixture".to_string(),
                name: "Local Fixture".to_string(),
                protocol: ConnectionProtocol::Local,
                files: Some(crate::types::HostFilesConfig {
                    default_path: Some(root.path().to_string_lossy().into_owned()),
                }),
                local: Some(crate::types::LocalConnectionConfig::default()),
                ..Default::default()
            },
            diagnostics: Vec::new(),
        };

        let result = list_local_files(&host, None).expect("list local files");

        assert_eq!(
            result.provider.current_path,
            normalize_local_display_path(&root.path().to_string_lossy())
        );
        assert_ne!(result.provider.root_path, result.provider.current_path);
        #[cfg(windows)]
        assert_eq!(result.provider.root_path, "/");
        #[cfg(not(windows))]
        assert_eq!(result.provider.root_path, "/");
    }

    #[cfg(windows)]
    #[test]
    fn windows_local_file_provider_uses_virtual_root_with_drive_entries() {
        let root = tempdir().expect("tempdir");
        let host = ConnectionHostEntry {
            id: "local-windows-root-fixture".to_string(),
            path: None,
            source: ConnectionHostSource::User,
            read_only: false,
            document: crate::types::ConnectionHostDocument {
                version: 1,
                id: "local-windows-root-fixture".to_string(),
                name: "Local Windows Root Fixture".to_string(),
                protocol: ConnectionProtocol::Local,
                files: Some(crate::types::HostFilesConfig {
                    default_path: Some(root.path().to_string_lossy().into_owned()),
                }),
                local: Some(crate::types::LocalConnectionConfig::default()),
                ..Default::default()
            },
            diagnostics: Vec::new(),
        };

        let root_result = list_local_files(&host, Some("/".to_string())).expect("list virtual root");
        let current_drive = root
            .path()
            .components()
            .next()
            .map(|component| component.as_os_str().to_string_lossy().into_owned())
            .expect("tempdir has a drive prefix");

        assert_eq!(root_result.provider.root_path, "/");
        assert_eq!(root_result.provider.current_path, "/");
        assert!(
            root_result
                .entries
                .iter()
                .any(|entry| entry.name == current_drive && entry.path == format!("{current_drive}/")),
            "virtual root should include the current drive; entries: {:?}",
            root_result.entries
        );
    }

    #[test]
    fn local_search_filters_hidden_files_and_matches_case_insensitively() {
        let root = tempdir().expect("tempdir");
        fs::create_dir_all(root.path().join("src")).expect("src dir");
        fs::write(root.path().join("src").join("Server.TS"), "").expect("server file");
        fs::write(root.path().join(".server-secret"), "").expect("hidden file");
        let mut matches = Vec::new();
        let mut diagnostics = Vec::new();
        let mut visited = HashSet::new();

        let truncated = scan_local_search_path(
            root.path(),
            "server",
            false,
            false,
            20,
            &mut matches,
            &mut diagnostics,
            &mut visited,
        )
        .expect("search");

        assert!(!truncated);
        assert!(diagnostics.is_empty());
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].name, "Server.TS");
    }

    #[test]
    fn local_search_reports_truncation_at_limit() {
        let root = tempdir().expect("tempdir");
        fs::write(root.path().join("match-a"), "").expect("match a");
        fs::write(root.path().join("match-b"), "").expect("match b");
        let mut matches = Vec::new();
        let mut diagnostics = Vec::new();
        let mut visited = HashSet::new();

        let truncated = scan_local_search_path(
            root.path(),
            "match",
            true,
            false,
            1,
            &mut matches,
            &mut diagnostics,
            &mut visited,
        )
        .expect("search");

        assert!(truncated);
        assert_eq!(matches.len(), 1);
    }

    #[test]
    fn chmod_mode_accepts_octal_and_rejects_invalid_values() {
        assert_eq!(parse_chmod_mode("644").expect("mode"), 0o644);
        assert_eq!(parse_chmod_mode("0755").expect("mode"), 0o755);

        assert!(parse_chmod_mode("888").is_err());
        assert!(parse_chmod_mode("10000").is_err());
        assert!(parse_chmod_mode("rw-r--r--").is_err());
    }

    #[test]
    fn shell_quote_handles_single_quotes() {
        assert_eq!(shell_quote("/tmp/it's here"), "'/tmp/it'\"'\"'s here'");
    }

    #[test]
    fn remote_rg_matches_filter_by_basename_and_report_truncation() {
        let mut matches = Vec::new();
        let truncated = collect_remote_rg_name_matches(
            "/home/me/src/main.rs\n/home/me/src/other.rs\n/home/me/src/readme.md\n",
            "/home/me",
            "rs",
            1,
            &mut matches,
        );

        assert!(truncated);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].name, "main.rs");
        assert_eq!(matches[0].path, "/home/me/src/main.rs");
        assert!(matches!(matches[0].kind, FileEntryKind::File));
    }
}
