use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use ssh2::{OpenFlags, OpenType, Sftp};
use tauri::AppHandle;
use uuid::Uuid;

use crate::{
    config::{connection_host_by_id, effective_application_config},
    error::{invalid_error, io_error, terminal_error, Result},
    files::{connect_sftp_for_host, expand_local_home, join_remote_path, SftpAuthScope},
    types::{
        ConnectionHostEntry, ConnectionProtocol, FileProviderKind, TransferCreateInput,
        TransferEndpoint, TransferEndpointKind, TransferQueueSnapshot, TransferTask,
        TransferTaskInput, TransferTaskStatus,
    },
};

const TRANSFER_CHUNK_SIZE: usize = 128 * 1024;
const DEFAULT_GLOBAL_TRANSFER_CONCURRENCY: usize = 3;
const DEFAULT_PER_HOST_TRANSFER_CONCURRENCY: usize = 2;

struct RunningTransfer {
    canceled: Arc<AtomicBool>,
}

#[derive(Default)]
struct TransferStore {
    version: u32,
    tasks: Vec<TransferTask>,
    running: std::collections::HashMap<String, RunningTransfer>,
}

struct TransferReadSource {
    reader: Box<dyn Read + Send>,
}

#[derive(Clone, Copy)]
struct TransferAuthScope<'a> {
    workspace_id: &'a str,
}

impl<'a> TransferAuthScope<'a> {
    fn from_task(task: &'a TransferTask) -> Result<Self> {
        let workspace_id = task
            .initiator_workspace_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                invalid_error(
                    "transfer task requires an initiator Workspace for SFTP authentication",
                )
            })?;
        Ok(Self { workspace_id })
    }
}

fn transfer_sftp_auth_scope(auth_scope: TransferAuthScope<'_>) -> SftpAuthScope<'_> {
    SftpAuthScope {
        workspace_id: auth_scope.workspace_id,
        source_tool_tab_id: None,
    }
}

struct TransferConcurrencySettings {
    global: usize,
    per_host: usize,
}

struct SftpReadSource {
    _connection: crate::files::SftpConnection,
    file: ssh2::File,
}

impl Read for SftpReadSource {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.file.read(buffer)
    }
}

struct SftpWriteDestination {
    _connection: crate::files::SftpConnection,
    file: ssh2::File,
}

#[derive(Clone)]
struct DirectoryChild {
    name: String,
    path: String,
    kind: TransferSourceKind,
    size: Option<u64>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TransferSourceKind {
    File,
    Directory,
}

enum TransferPlanEntry {
    Directory {
        destination: TransferEndpoint,
    },
    File {
        source: TransferEndpoint,
        destination: TransferEndpoint,
        size: Option<u64>,
    },
}

impl Write for SftpWriteDestination {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.file.write(buffer)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}

static TRANSFER_STORE: OnceLock<Arc<Mutex<TransferStore>>> = OnceLock::new();

fn transfer_store() -> Arc<Mutex<TransferStore>> {
    TRANSFER_STORE
        .get_or_init(|| Arc::new(Mutex::new(TransferStore::default())))
        .clone()
}

#[tauri::command]
#[specta::specta]
pub(crate) fn get_transfer_queue_snapshot(_app: AppHandle) -> Result<TransferQueueSnapshot> {
    snapshot()
}

#[tauri::command]
#[specta::specta]
pub(crate) fn create_transfer_task(
    app: AppHandle,
    input: TransferCreateInput,
) -> Result<TransferQueueSnapshot> {
    validate_transfer_input(&input)?;
    let task = create_queued_task(input);
    {
        let store = transfer_store();
        let mut guard = lock_store(&store)?;
        guard.tasks.push(task);
        bump_version(&mut guard)?;
    }
    schedule_transfers(app)?;
    snapshot()
}

#[tauri::command]
#[specta::specta]
pub(crate) fn cancel_transfer_task(
    _app: AppHandle,
    input: TransferTaskInput,
) -> Result<TransferQueueSnapshot> {
    let store = transfer_store();
    let mut guard = lock_store(&store)?;
    if let Some(running) = guard.running.get(&input.task_id) {
        running.canceled.store(true, Ordering::SeqCst);
    }
    let task = task_mut(&mut guard, &input.task_id)?;
    match task.status {
        TransferTaskStatus::Completed | TransferTaskStatus::Canceled => {}
        TransferTaskStatus::Queued | TransferTaskStatus::Running | TransferTaskStatus::Failed => {
            task.status = TransferTaskStatus::Canceled;
            task.error = None;
            task.updated_at_unix_ms = now_unix_ms();
            bump_version(&mut guard)?;
        }
    }
    guard.running.remove(&input.task_id);
    Ok(snapshot_from_store(&guard))
}

#[tauri::command]
#[specta::specta]
pub(crate) fn retry_transfer_task(
    app: AppHandle,
    input: TransferTaskInput,
) -> Result<TransferQueueSnapshot> {
    {
        let store = transfer_store();
        let mut guard = lock_store(&store)?;
        if guard.running.contains_key(&input.task_id) {
            return Err(invalid_error(format!(
                "transfer task {} is already running",
                input.task_id
            )));
        }
        let task = task_mut(&mut guard, &input.task_id)?;
        match task.status {
            TransferTaskStatus::Failed | TransferTaskStatus::Canceled => {}
            TransferTaskStatus::Queued
            | TransferTaskStatus::Running
            | TransferTaskStatus::Completed => {
                return Err(invalid_error(
                    "only failed or canceled transfers can be retried",
                ));
            }
        }
        task.status = TransferTaskStatus::Queued;
        task.bytes_total = None;
        task.bytes_done = "0".to_string();
        task.error = None;
        task.updated_at_unix_ms = now_unix_ms();
        bump_version(&mut guard)?;
    }
    schedule_transfers(app)?;
    snapshot()
}

fn create_queued_task(input: TransferCreateInput) -> TransferTask {
    let now = now_unix_ms();
    TransferTask {
        id: format!("transfer-{}", Uuid::new_v4()),
        source: input.source,
        destination: input.destination,
        initiator_workspace_id: input.initiator_workspace_id,
        related_workspace_ids: input.related_workspace_ids,
        status: TransferTaskStatus::Queued,
        bytes_total: None,
        bytes_done: "0".to_string(),
        error: None,
        created_at_unix_ms: now.clone(),
        updated_at_unix_ms: now,
    }
}

fn schedule_transfers(app: AppHandle) -> Result<()> {
    let settings = transfer_concurrency_settings(&app)?;
    let mut runnable = Vec::new();
    {
        let store = transfer_store();
        let mut guard = lock_store(&store)?;
        loop {
            let running_count = guard.running.len();
            if running_count >= settings.global {
                break;
            }
            let host_counts = running_host_counts(&guard.tasks, &guard.running);
            let Some(index) = guard.tasks.iter().position(|task| {
                task.status == TransferTaskStatus::Queued
                    && task_hosts(task).iter().all(|host_id| {
                        host_counts.get(host_id).copied().unwrap_or(0) < settings.per_host
                    })
            }) else {
                break;
            };
            let canceled = Arc::new(AtomicBool::new(false));
            let task = &mut guard.tasks[index];
            task.status = TransferTaskStatus::Running;
            task.error = None;
            task.updated_at_unix_ms = now_unix_ms();
            let task_id = task.id.clone();
            runnable.push((task.clone(), Arc::clone(&canceled)));
            guard.running.insert(task_id, RunningTransfer { canceled });
            bump_version(&mut guard)?;
        }
    }
    for (task, canceled) in runnable {
        spawn_transfer_worker(app.clone(), task, canceled);
    }
    Ok(())
}

fn spawn_transfer_worker(app: AppHandle, task: TransferTask, canceled: Arc<AtomicBool>) {
    thread::spawn(move || {
        let task_id = task.id.clone();
        let result = execute_transfer(&app, &task, &canceled);
        match result {
            Ok(()) => {
                if let Err(error) = mark_transfer_completed(&task_id, &canceled) {
                    log::warn!("failed to complete transfer {task_id}: {error}");
                }
                if let Err(error) = schedule_transfers(app.clone()) {
                    log::warn!("failed to schedule transfers after {task_id} completed: {error}");
                }
            }
            Err(error) => {
                if let Err(update_error) =
                    mark_transfer_failed(&task_id, error.to_string(), &canceled)
                {
                    log::warn!("failed to mark transfer {task_id} failed: {update_error}");
                }
                if let Err(error) = schedule_transfers(app.clone()) {
                    log::warn!("failed to schedule transfers after {task_id} failed: {error}");
                }
            }
        }
    });
}

fn execute_transfer(app: &AppHandle, task: &TransferTask, canceled: &AtomicBool) -> Result<()> {
    ensure_not_canceled(canceled)?;
    let auth_scope = TransferAuthScope::from_task(task)?;
    let metadata = source_metadata(app, &task.source, auth_scope)?;
    match metadata.kind {
        TransferSourceKind::File => {
            let mut done = 0;
            if let Some(size) = metadata.size {
                set_transfer_total(&task.id, size)?;
            }
            copy_file(
                app,
                &task.source,
                &task.destination,
                &task.id,
                auth_scope,
                canceled,
                &mut done,
            )
        }
        TransferSourceKind::Directory => copy_directory(app, task, auth_scope, canceled),
    }
}

fn copy_directory(
    app: &AppHandle,
    task: &TransferTask,
    auth_scope: TransferAuthScope<'_>,
    canceled: &AtomicBool,
) -> Result<()> {
    let mut plan = Vec::new();
    collect_directory_plan(
        app,
        &task.source,
        &task.destination,
        auth_scope,
        canceled,
        &mut plan,
    )?;
    let total = plan
        .iter()
        .filter_map(|entry| match entry {
            TransferPlanEntry::File { size, .. } => *size,
            TransferPlanEntry::Directory { .. } => None,
        })
        .try_fold(0_u64, |total, size| {
            total
                .checked_add(size)
                .ok_or_else(|| invalid_error("transfer byte count overflow"))
        })?;
    set_transfer_total(&task.id, total)?;
    let mut done = 0;
    for entry in plan {
        ensure_not_canceled(canceled)?;
        match entry {
            TransferPlanEntry::Directory { destination } => {
                ensure_destination_directory(app, &destination, auth_scope)?;
            }
            TransferPlanEntry::File {
                source,
                destination,
                ..
            } => copy_file(
                app,
                &source,
                &destination,
                &task.id,
                auth_scope,
                canceled,
                &mut done,
            )?,
        }
    }
    Ok(())
}

fn collect_directory_plan(
    app: &AppHandle,
    source: &TransferEndpoint,
    destination: &TransferEndpoint,
    auth_scope: TransferAuthScope<'_>,
    canceled: &AtomicBool,
    plan: &mut Vec<TransferPlanEntry>,
) -> Result<()> {
    ensure_not_canceled(canceled)?;
    plan.push(TransferPlanEntry::Directory {
        destination: destination.clone(),
    });
    for child in directory_children(app, source, auth_scope)? {
        ensure_not_canceled(canceled)?;
        let child_source = child_endpoint(source, &child.path);
        let child_destination =
            child_endpoint(destination, &join_endpoint_path(destination, &child.name));
        match child.kind {
            TransferSourceKind::Directory => {
                collect_directory_plan(
                    app,
                    &child_source,
                    &child_destination,
                    auth_scope,
                    canceled,
                    plan,
                )?;
            }
            TransferSourceKind::File => plan.push(TransferPlanEntry::File {
                source: child_source,
                destination: child_destination,
                size: child.size,
            }),
        }
    }
    Ok(())
}

fn copy_file(
    app: &AppHandle,
    source_endpoint: &TransferEndpoint,
    destination_endpoint: &TransferEndpoint,
    task_id: &str,
    auth_scope: TransferAuthScope<'_>,
    canceled: &AtomicBool,
    done: &mut u64,
) -> Result<()> {
    let mut source = open_read_source(app, source_endpoint, task_id, auth_scope)?;
    ensure_destination_absent(app, destination_endpoint, auth_scope)?;
    let mut writer = open_write_destination(app, destination_endpoint, task_id, auth_scope)?;
    let mut buffer = vec![0_u8; TRANSFER_CHUNK_SIZE];
    loop {
        ensure_not_canceled(canceled)?;
        let read = source.reader.read(&mut buffer).map_err(io_error)?;
        if read == 0 {
            break;
        }
        writer.write_all(&buffer[..read]).map_err(io_error)?;
        *done = (*done)
            .checked_add(read as u64)
            .ok_or_else(|| invalid_error("transfer byte count overflow"))?;
        update_transfer_progress(task_id, *done)?;
    }
    writer.flush().map_err(io_error)?;
    Ok(())
}

fn source_metadata(
    app: &AppHandle,
    endpoint: &TransferEndpoint,
    auth_scope: TransferAuthScope<'_>,
) -> Result<DirectoryChild> {
    match endpoint_provider(app, endpoint)? {
        TransferProvider::Local(path) => {
            let metadata = fs::symlink_metadata(&path).map_err(io_error)?;
            let name = path
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.to_string_lossy().into_owned());
            Ok(DirectoryChild {
                name,
                path: path.to_string_lossy().into_owned(),
                kind: if metadata.file_type().is_dir() {
                    TransferSourceKind::Directory
                } else {
                    TransferSourceKind::File
                },
                size: if metadata.file_type().is_dir() {
                    None
                } else {
                    Some(metadata.len())
                },
            })
        }
        TransferProvider::Sftp { host, path } => {
            let connection = connect_sftp_for_host(
                app,
                &host,
                transfer_sftp_auth_scope(auth_scope),
                false,
                false,
                None,
                false,
                "transfer-source-stat",
            )?;
            let sftp = connection.session.sftp().map_err(terminal_error)?;
            let stat = sftp.lstat(Path::new(&path)).map_err(terminal_error)?;
            let name = Path::new(&path)
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone());
            Ok(DirectoryChild {
                name,
                path,
                kind: if sftp_stat_is_dir(&stat) {
                    TransferSourceKind::Directory
                } else {
                    TransferSourceKind::File
                },
                size: if sftp_stat_is_dir(&stat) {
                    None
                } else {
                    stat.size
                },
            })
        }
    }
}

fn directory_children(
    app: &AppHandle,
    endpoint: &TransferEndpoint,
    auth_scope: TransferAuthScope<'_>,
) -> Result<Vec<DirectoryChild>> {
    match endpoint_provider(app, endpoint)? {
        TransferProvider::Local(path) => {
            let mut children = fs::read_dir(&path)
                .map_err(io_error)?
                .map(|entry| {
                    let entry = entry.map_err(io_error)?;
                    let path = entry.path();
                    let metadata = fs::symlink_metadata(&path).map_err(io_error)?;
                    let is_dir = metadata.file_type().is_dir();
                    Ok(DirectoryChild {
                        name: entry.file_name().to_string_lossy().into_owned(),
                        path: path.to_string_lossy().into_owned(),
                        kind: if is_dir {
                            TransferSourceKind::Directory
                        } else {
                            TransferSourceKind::File
                        },
                        size: if is_dir { None } else { Some(metadata.len()) },
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            children
                .sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
            Ok(children)
        }
        TransferProvider::Sftp { host, path } => {
            let connection = connect_sftp_for_host(
                app,
                &host,
                transfer_sftp_auth_scope(auth_scope),
                false,
                false,
                None,
                false,
                "transfer-list",
            )?;
            let sftp = connection.session.sftp().map_err(terminal_error)?;
            let mut children = sftp
                .readdir(Path::new(&path))
                .map_err(terminal_error)?
                .into_iter()
                .filter_map(|(child_path, stat)| {
                    let name = child_path.file_name()?.to_string_lossy().into_owned();
                    if name == "." || name == ".." {
                        return None;
                    }
                    let is_dir = sftp_stat_is_dir(&stat);
                    Some(DirectoryChild {
                        name: name.clone(),
                        path: join_remote_path(&path, &name),
                        kind: if is_dir {
                            TransferSourceKind::Directory
                        } else {
                            TransferSourceKind::File
                        },
                        size: if is_dir { None } else { stat.size },
                    })
                })
                .collect::<Vec<_>>();
            children
                .sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
            Ok(children)
        }
    }
}

fn ensure_destination_directory(
    app: &AppHandle,
    endpoint: &TransferEndpoint,
    auth_scope: TransferAuthScope<'_>,
) -> Result<()> {
    match endpoint_provider(app, endpoint)? {
        TransferProvider::Local(path) => ensure_local_destination_directory(&path),
        TransferProvider::Sftp { host, path } => {
            let connection = connect_sftp_for_host(
                app,
                &host,
                transfer_sftp_auth_scope(auth_scope),
                false,
                false,
                None,
                false,
                "transfer-mkdir",
            )?;
            let sftp = connection.session.sftp().map_err(terminal_error)?;
            match sftp.lstat(Path::new(&path)) {
                Ok(stat) if sftp_stat_is_dir(&stat) => Ok(()),
                Ok(_) => Err(invalid_error(format!(
                    "destination exists and is not a directory: {path}"
                ))),
                Err(_) => sftp.mkdir(Path::new(&path), 0o755).map_err(terminal_error),
            }
        }
    }
}

fn ensure_local_destination_directory(path: &Path) -> Result<()> {
    if path.exists() {
        if path.is_dir() {
            return Ok(());
        }
        return Err(invalid_error(format!(
            "destination exists and is not a directory: {}",
            path.display()
        )));
    }
    fs::create_dir_all(path).map_err(io_error)
}

fn child_endpoint(parent: &TransferEndpoint, path: &str) -> TransferEndpoint {
    let mut endpoint = parent.clone();
    endpoint.path = path.to_string();
    endpoint
}

fn join_endpoint_path(endpoint: &TransferEndpoint, name: &str) -> String {
    let local_provider = matches!(endpoint.provider_kind, Some(FileProviderKind::Local));
    if endpoint.kind == TransferEndpointKind::Local || local_provider {
        return PathBuf::from(endpoint.path.clone())
            .join(name)
            .to_string_lossy()
            .into_owned();
    }
    join_remote_path(&endpoint.path, name)
}

fn sftp_stat_is_dir(stat: &ssh2::FileStat) -> bool {
    stat.perm
        .map(|permissions| permissions & 0o170000 == 0o040000)
        .unwrap_or(false)
}

fn open_read_source(
    app: &AppHandle,
    endpoint: &TransferEndpoint,
    task_id: &str,
    auth_scope: TransferAuthScope<'_>,
) -> Result<TransferReadSource> {
    match endpoint_provider(app, endpoint)? {
        TransferProvider::Local(path) => {
            let metadata = fs::metadata(&path).map_err(io_error)?;
            if !metadata.is_file() {
                return Err(invalid_error("transfer read source must be a file"));
            }
            let file = fs::File::open(&path).map_err(io_error)?;
            Ok(TransferReadSource {
                reader: Box::new(file),
            })
        }
        TransferProvider::Sftp { host, path } => {
            let connection = connect_sftp_for_host(
                app,
                &host,
                transfer_sftp_auth_scope(auth_scope),
                false,
                false,
                None,
                false,
                &format!("{task_id}-read"),
            )?;
            let sftp = connection.session.sftp().map_err(terminal_error)?;
            let stat = sftp.stat(Path::new(&path)).map_err(terminal_error)?;
            if stat.is_dir() {
                return Err(invalid_error("transfer read source must be a file"));
            }
            let file = sftp.open(Path::new(&path)).map_err(terminal_error)?;
            drop(sftp);
            Ok(TransferReadSource {
                reader: Box::new(SftpReadSource {
                    _connection: connection,
                    file,
                }),
            })
        }
    }
}

fn open_write_destination(
    app: &AppHandle,
    endpoint: &TransferEndpoint,
    task_id: &str,
    auth_scope: TransferAuthScope<'_>,
) -> Result<Box<dyn Write + Send>> {
    match endpoint_provider(app, endpoint)? {
        TransferProvider::Local(path) => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(io_error)?;
            }
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(io_error)?;
            Ok(Box::new(file))
        }
        TransferProvider::Sftp { host, path } => {
            let connection = connect_sftp_for_host(
                app,
                &host,
                transfer_sftp_auth_scope(auth_scope),
                false,
                false,
                None,
                false,
                &format!("{task_id}-write"),
            )?;
            let sftp = connection.session.sftp().map_err(terminal_error)?;
            ensure_remote_parent(&sftp, Path::new(&path))?;
            let file = sftp
                .open_mode(
                    Path::new(&path),
                    OpenFlags::WRITE | OpenFlags::EXCLUSIVE,
                    0o644,
                    OpenType::File,
                )
                .map_err(terminal_error)?;
            drop(sftp);
            Ok(Box::new(SftpWriteDestination {
                _connection: connection,
                file,
            }))
        }
    }
}

fn ensure_destination_absent(
    app: &AppHandle,
    endpoint: &TransferEndpoint,
    auth_scope: TransferAuthScope<'_>,
) -> Result<()> {
    match endpoint_provider(app, endpoint)? {
        TransferProvider::Local(path) => {
            if path.exists() {
                return Err(invalid_error(format!(
                    "destination already exists: {}",
                    path.display()
                )));
            }
            Ok(())
        }
        TransferProvider::Sftp { host, path } => {
            let connection = connect_sftp_for_host(
                app,
                &host,
                transfer_sftp_auth_scope(auth_scope),
                false,
                false,
                None,
                false,
                "transfer-stat",
            )?;
            let sftp = connection.session.sftp().map_err(terminal_error)?;
            match sftp.lstat(Path::new(&path)) {
                Ok(_) => Err(invalid_error(format!("destination already exists: {path}"))),
                Err(_) => Ok(()),
            }
        }
    }
}

fn ensure_remote_parent(sftp: &Sftp, path: &Path) -> Result<()> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    if parent.as_os_str().is_empty() {
        return Ok(());
    }
    sftp.stat(parent).map_err(terminal_error)?;
    Ok(())
}

enum TransferProvider {
    Local(PathBuf),
    Sftp {
        host: ConnectionHostEntry,
        path: String,
    },
}

fn endpoint_provider(app: &AppHandle, endpoint: &TransferEndpoint) -> Result<TransferProvider> {
    match endpoint.kind {
        TransferEndpointKind::Local => Ok(TransferProvider::Local(PathBuf::from(
            expand_local_home(endpoint.path.clone()),
        ))),
        TransferEndpointKind::Provider => {
            let provider_kind = endpoint.provider_kind.clone().ok_or_else(|| {
                invalid_error("provider transfer endpoint requires provider_kind")
            })?;
            let host_id = endpoint
                .host_id
                .as_deref()
                .ok_or_else(|| invalid_error("provider transfer endpoint requires host_id"))?;
            let host = connection_host_by_id(app, host_id)?;
            match (provider_kind, host.document.protocol.clone()) {
                (FileProviderKind::Local, ConnectionProtocol::Local) => {
                    Ok(TransferProvider::Local(PathBuf::from(expand_local_home(
                        endpoint.path.clone(),
                    ))))
                }
                (FileProviderKind::Sftp, ConnectionProtocol::Ssh) => Ok(TransferProvider::Sftp {
                    host,
                    path: endpoint.path.clone(),
                }),
                (FileProviderKind::Local, _) => Err(invalid_error(
                    "local provider endpoint must use a local host",
                )),
                (FileProviderKind::Sftp, _) => {
                    Err(invalid_error("sftp provider endpoint must use an ssh host"))
                }
            }
        }
    }
}

fn snapshot() -> Result<TransferQueueSnapshot> {
    let store = transfer_store();
    let guard = lock_store(&store)?;
    Ok(snapshot_from_store(&guard))
}

fn snapshot_from_store(store: &TransferStore) -> TransferQueueSnapshot {
    TransferQueueSnapshot {
        version: store.version,
        tasks: store.tasks.clone(),
    }
}

fn set_transfer_total(task_id: &str, total: u64) -> Result<()> {
    update_task(task_id, |task| {
        task.bytes_total = Some(total.to_string());
        task.updated_at_unix_ms = now_unix_ms();
        Ok(())
    })
}

fn update_transfer_progress(task_id: &str, done: u64) -> Result<()> {
    update_task(task_id, |task| {
        if task.status == TransferTaskStatus::Canceled {
            return Ok(());
        }
        task.bytes_done = done.to_string();
        task.updated_at_unix_ms = now_unix_ms();
        Ok(())
    })
}

fn mark_transfer_completed(task_id: &str, canceled: &AtomicBool) -> Result<()> {
    let store = transfer_store();
    let mut guard = lock_store(&store)?;
    let task = task_mut(&mut guard, task_id)?;
    if canceled.load(Ordering::SeqCst) || task.status == TransferTaskStatus::Canceled {
        task.status = TransferTaskStatus::Canceled;
    } else {
        task.status = TransferTaskStatus::Completed;
        task.error = None;
        if let Some(total) = task.bytes_total.clone() {
            task.bytes_done = total;
        }
    }
    task.updated_at_unix_ms = now_unix_ms();
    guard.running.remove(task_id);
    bump_version(&mut guard)?;
    Ok(())
}

fn mark_transfer_failed(task_id: &str, error: String, canceled: &AtomicBool) -> Result<()> {
    let store = transfer_store();
    let mut guard = lock_store(&store)?;
    let task = task_mut(&mut guard, task_id)?;
    if canceled.load(Ordering::SeqCst) || task.status == TransferTaskStatus::Canceled {
        task.status = TransferTaskStatus::Canceled;
        task.error = None;
    } else {
        task.status = TransferTaskStatus::Failed;
        task.error = Some(error);
    }
    task.updated_at_unix_ms = now_unix_ms();
    guard.running.remove(task_id);
    bump_version(&mut guard)?;
    Ok(())
}

fn update_task(task_id: &str, update: impl FnOnce(&mut TransferTask) -> Result<()>) -> Result<()> {
    let store = transfer_store();
    let mut guard = lock_store(&store)?;
    let task = task_mut(&mut guard, task_id)?;
    update(task)?;
    bump_version(&mut guard)?;
    Ok(())
}

fn lock_store(
    store: &Arc<Mutex<TransferStore>>,
) -> Result<std::sync::MutexGuard<'_, TransferStore>> {
    store
        .lock()
        .map_err(|_| invalid_error("transfer store lock poisoned"))
}

fn task_mut<'a>(store: &'a mut TransferStore, task_id: &str) -> Result<&'a mut TransferTask> {
    store
        .tasks
        .iter_mut()
        .find(|task| task.id == task_id)
        .ok_or_else(|| invalid_error(format!("transfer task {task_id} not found")))
}

fn bump_version(store: &mut TransferStore) -> Result<()> {
    store.version = store
        .version
        .checked_add(1)
        .ok_or_else(|| invalid_error("transfer queue version overflow"))?;
    Ok(())
}

fn validate_transfer_input(input: &TransferCreateInput) -> Result<()> {
    if input.source.path.trim().is_empty() {
        return Err(invalid_error("transfer source path cannot be empty"));
    }
    if input.destination.path.trim().is_empty() {
        return Err(invalid_error("transfer destination path cannot be empty"));
    }
    Ok(())
}

fn ensure_not_canceled(canceled: &AtomicBool) -> Result<()> {
    if canceled.load(Ordering::SeqCst) {
        return Err(invalid_error("transfer was canceled"));
    }
    Ok(())
}

fn transfer_concurrency_settings(app: &AppHandle) -> Result<TransferConcurrencySettings> {
    let config = effective_application_config(app)?;
    let table = config
        .as_table()
        .ok_or_else(|| invalid_error("effective config must be a TOML table"))?;
    let transfers = table.get("transfers").and_then(toml::Value::as_table);
    Ok(TransferConcurrencySettings {
        global: read_positive_usize_setting(
            transfers,
            "global_concurrency",
            DEFAULT_GLOBAL_TRANSFER_CONCURRENCY,
        )?,
        per_host: read_positive_usize_setting(
            transfers,
            "per_host_concurrency",
            DEFAULT_PER_HOST_TRANSFER_CONCURRENCY,
        )?,
    })
}

fn read_positive_usize_setting(
    table: Option<&toml::map::Map<String, toml::Value>>,
    key: &str,
    default_value: usize,
) -> Result<usize> {
    let Some(value) = table.and_then(|table| table.get(key)) else {
        return Ok(default_value);
    };
    let Some(raw) = value.as_integer() else {
        return Err(invalid_error(format!("transfers.{key} must be an integer")));
    };
    if raw < 1 {
        return Err(invalid_error(format!("transfers.{key} must be at least 1")));
    }
    usize::try_from(raw).map_err(|_| invalid_error(format!("transfers.{key} is too large")))
}

fn running_host_counts(
    tasks: &[TransferTask],
    running: &std::collections::HashMap<String, RunningTransfer>,
) -> std::collections::HashMap<String, usize> {
    let mut counts = std::collections::HashMap::new();
    for task in tasks.iter().filter(|task| running.contains_key(&task.id)) {
        for host_id in task_hosts(task) {
            *counts.entry(host_id).or_insert(0) += 1;
        }
    }
    counts
}

fn task_hosts(task: &TransferTask) -> Vec<String> {
    let mut hosts = Vec::new();
    for endpoint in [&task.source, &task.destination] {
        if endpoint.kind == TransferEndpointKind::Provider {
            if let Some(host_id) = endpoint.host_id.as_ref() {
                if !hosts.iter().any(|item| item == host_id) {
                    hosts.push(host_id.clone());
                }
            }
        }
    }
    hosts
}

fn now_unix_ms() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn joins_local_and_remote_endpoint_paths() {
        let local = TransferEndpoint {
            kind: TransferEndpointKind::Local,
            provider_kind: None,
            host_id: None,
            path: "/tmp/root".to_string(),
        };
        let sftp = TransferEndpoint {
            kind: TransferEndpointKind::Provider,
            provider_kind: Some(FileProviderKind::Sftp),
            host_id: Some("host-a".to_string()),
            path: "/var/www".to_string(),
        };

        let expected_local = PathBuf::from("/tmp/root")
            .join("child.txt")
            .to_string_lossy()
            .into_owned();
        assert_eq!(join_endpoint_path(&local, "child.txt"), expected_local);
        assert_eq!(join_endpoint_path(&sftp, "child.txt"), "/var/www/child.txt");
    }

    #[test]
    fn creates_child_endpoint_without_changing_provider_identity() {
        let parent = TransferEndpoint {
            kind: TransferEndpointKind::Provider,
            provider_kind: Some(FileProviderKind::Sftp),
            host_id: Some("host-a".to_string()),
            path: "/var/www".to_string(),
        };

        let child = child_endpoint(&parent, "/var/www/assets");

        assert_eq!(child.kind, TransferEndpointKind::Provider);
        assert!(matches!(child.provider_kind, Some(FileProviderKind::Sftp)));
        assert_eq!(child.host_id.as_deref(), Some("host-a"));
        assert_eq!(child.path, "/var/www/assets");
        assert_eq!(parent.path, "/var/www");
    }

    #[test]
    fn ensures_local_destination_directory_without_replacing_files() {
        let root = tempdir().expect("tempdir");
        let directory_endpoint = TransferEndpoint {
            kind: TransferEndpointKind::Local,
            provider_kind: None,
            host_id: None,
            path: root.path().join("nested").to_string_lossy().into_owned(),
        };
        let file_path = root.path().join("plain-file");
        fs::write(&file_path, "content").expect("write");
        let file_endpoint = TransferEndpoint {
            kind: TransferEndpointKind::Local,
            provider_kind: None,
            host_id: None,
            path: file_path.to_string_lossy().into_owned(),
        };

        ensure_local_destination_directory(Path::new(&directory_endpoint.path))
            .expect("create directory");

        assert!(root.path().join("nested").is_dir());
        assert!(ensure_local_destination_directory(Path::new(&file_endpoint.path)).is_err());
    }
}
