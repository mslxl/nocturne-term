use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use ssh2::{FileStat, OpenFlags, OpenType};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::{
    config::{connection_host_by_id, effective_application_config},
    error::{invalid_error, terminal_error, Result},
    files::{
        connect_sftp_for_host, run_remote_command, shell_quote, SftpAuthScope, SftpConnection,
    },
    types::{
        ConnectionProtocol, HostResourceConfig, RemoteResourceTargetArch, RemoteResourceTargetOs,
        ResourceRefreshInterval, ResourceRemoteProviderMode, ResourceSettings, WorkspaceToolKind,
    },
    workspace::owned_workspace_tool_host,
};

const GITHUB_RELEASE_REPOSITORY: &str = "mslxl/nocturne-term";
const RESOURCE_HELPER_VERSION: &str = env!("CARGO_PKG_VERSION");
const RESOURCE_HELPER_HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const LINUX_NVIDIA_SMI_QUERY_COMMAND: &str = "nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits";

static RESOURCE_HELPER_DEPLOYMENTS: OnceLock<Arc<Mutex<ResourceHelperDeploymentMemory>>> =
    OnceLock::new();

fn resource_helper_deployment_memory() -> Arc<Mutex<ResourceHelperDeploymentMemory>> {
    RESOURCE_HELPER_DEPLOYMENTS
        .get_or_init(|| Arc::new(Mutex::new(ResourceHelperDeploymentMemory::default())))
        .clone()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalResourceProviderDescriptor {
    pub label: &'static str,
    pub starts_external_agent: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum LocalResourceMetricKind {
    Cpu,
    Memory,
    Swap,
    Gpu,
}

#[derive(Debug, Clone, PartialEq)]
pub enum LocalResourceMetricAvailability {
    Available {
        used: u64,
        total: u64,
        percent: f64,
        available: Option<u64>,
        free: Option<u64>,
        details: LocalResourceMetricDetails,
    },
    Unavailable {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum LocalResourceMetricDetails {
    None,
    CpuCores(Vec<f64>),
    GpuDevices(Vec<LocalGpuDeviceMetric>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct LocalGpuDeviceMetric {
    pub id: String,
    pub label: String,
    pub compute_percent: f64,
    pub memory_used: u64,
    pub memory_total: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WindowsGpuAdapterInfo {
    pub id: String,
    pub label: String,
    pub dedicated_video_memory: u64,
}

impl WindowsGpuAdapterInfo {
    pub fn new(
        id: impl Into<String>,
        label: impl Into<String>,
        dedicated_video_memory: u64,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            dedicated_video_memory,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum WindowsGpuPdhSample {
    Engine {
        instance: String,
        utilization_percent: f64,
    },
    Memory {
        instance: String,
        bytes: u64,
    },
}

impl WindowsGpuPdhSample {
    pub fn engine(instance: impl Into<String>, utilization_percent: f64) -> Self {
        Self::Engine {
            instance: instance.into(),
            utilization_percent,
        }
    }

    pub fn memory(instance: impl Into<String>, bytes: u64) -> Self {
        Self::Memory {
            instance: instance.into(),
            bytes,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LocalResourceMetric {
    pub kind: LocalResourceMetricKind,
    pub availability: LocalResourceMetricAvailability,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LocalResourceSnapshot {
    pub provider: &'static str,
    pub metrics: Vec<LocalResourceMetric>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ResourceMonitorCollectInput {
    pub workspace_id: String,
    pub tool_tab_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ResourceMonitorSnapshot {
    pub provider: String,
    pub collected_at_ms: String,
    pub metrics: Vec<ResourceMonitorMetric>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ResourceMonitorMetric {
    pub metric: LocalResourceMetricKind,
    pub status: String,
    pub used: Option<String>,
    pub total: Option<String>,
    pub percent: Option<f64>,
    pub available: Option<String>,
    pub free: Option<String>,
    pub reason: Option<String>,
    pub cores: Vec<f64>,
    pub gpus: Vec<ResourceMonitorGpuDevice>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ResourceMonitorGpuDevice {
    pub id: String,
    pub label: String,
    pub compute_percent: f64,
    pub memory_used: String,
    pub memory_total: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NocturneBuildInfo {
    pub commit: String,
    pub tag: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteSystemCommandPlan {
    pub target_os: RemoteResourceTargetOs,
    pub provider_label: &'static str,
    pub commands: Vec<&'static str>,
    pub runs_off_tauri_command_thread: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteResourceTargetDetection {
    Detected {
        os: RemoteResourceTargetOs,
        arch: RemoteResourceTargetArch,
        source: &'static str,
    },
    Unknown {
        reason: String,
        requires_user_choice: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ResourceMonitorAgentEvent {
    Hello {
        version: String,
        os: RemoteResourceTargetOs,
        arch: RemoteResourceTargetArch,
        capabilities: Vec<String>,
    },
    Snapshot {
        metrics: Vec<ResourceMonitorAgentMetric>,
    },
    Warning {
        message: String,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResourceMonitorAgentMetric {
    pub metric: LocalResourceMetricKind,
    pub status: String,
    pub used: Option<u64>,
    pub total: Option<u64>,
    pub percent: Option<f64>,
    pub available: Option<u64>,
    pub free: Option<u64>,
    pub reason: Option<String>,
    #[serde(default)]
    pub gpus: Vec<ResourceMonitorAgentGpuDevice>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResourceMonitorAgentGpuDevice {
    pub id: String,
    pub label: String,
    pub compute_percent: f64,
    pub memory_used: u64,
    pub memory_total: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceHelperPolicy {
    Ask,
    Never,
    Allow,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceHelperManifest {
    pub helper_name: String,
    pub purpose: String,
    pub version: String,
    pub target_os: RemoteResourceTargetOs,
    pub target_arch: RemoteResourceTargetArch,
    pub upload_path: String,
    pub sha256: String,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceHelperUploadPlan {
    pub resource_path: String,
    pub manifest: ResourceHelperManifest,
    pub manifest_path: String,
    pub remote_directory: String,
    pub helper_upload_path: String,
    pub manifest_upload_path: String,
    pub executable_mode: Option<u32>,
    pub verify_sha256_command: String,
    pub launch_stream_command: String,
    pub helper_bytes: Vec<u8>,
    pub manifest_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceHelperDownloadPlan {
    pub tag: String,
    pub asset_name: String,
    pub url: String,
    pub prompt: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResourceHelperBytesSource {
    Bundled(Vec<u8>),
    DownloadRequired(ResourceHelperDownloadPlan),
    Unavailable { reason: String },
}

impl ResourceHelperManifest {
    pub fn validate_against(&self, expected: &ResourceHelperManifest) -> Result<()> {
        if self.helper_name != expected.helper_name {
            return Err(invalid_error("helper name mismatch"));
        }
        if self.purpose != expected.purpose {
            return Err(invalid_error("helper purpose mismatch"));
        }
        if self.target_os != expected.target_os {
            return Err(invalid_error("target OS mismatch"));
        }
        if self.target_arch != expected.target_arch {
            return Err(invalid_error("target architecture mismatch"));
        }
        if self.upload_path != expected.upload_path {
            return Err(invalid_error("upload path mismatch"));
        }
        if self.sha256 != expected.sha256 {
            return Err(invalid_error("sha256 mismatch"));
        }
        for capability in &expected.capabilities {
            if !self.capabilities.contains(capability) {
                return Err(invalid_error(format!(
                    "missing helper capability: {capability}"
                )));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResourceHelperDeploymentStatus {
    Verified,
    Missing,
    HashMismatch { found_sha256: String },
    InvalidManifest { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceHelperPrompt {
    pub helper_name: String,
    pub purpose: String,
    pub host_id: String,
    pub host_label: String,
    pub target_os: RemoteResourceTargetOs,
    pub target_arch: RemoteResourceTargetArch,
    pub upload_path: String,
    pub sha256: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResourceHelperDeploymentDecision {
    UseExisting,
    Upload {
        host_id: String,
        manifest: ResourceHelperManifest,
    },
    Prompt(ResourceHelperPrompt),
    Unavailable {
        reason: String,
    },
}

#[derive(Debug, Clone, Default)]
pub struct ResourceHelperDeploymentMemory {
    verified: BTreeMap<String, ResourceHelperManifest>,
}

impl ResourceHelperDeploymentMemory {
    pub fn record_verified(
        &mut self,
        host_id: impl Into<String>,
        manifest: ResourceHelperManifest,
    ) {
        self.verified.insert(host_id.into(), manifest);
    }

    pub fn verified_hash(&self, host_id: &str) -> Option<&str> {
        self.verified
            .get(host_id)
            .map(|manifest| manifest.sha256.as_str())
    }
}

impl Default for ResourceSettings {
    fn default() -> Self {
        Self {
            default_refresh_interval: ResourceRefreshInterval::TwoSeconds,
            remote_provider: ResourceRemoteProviderMode::Auto,
        }
    }
}

fn resources_table(config: &toml::Value) -> Result<Option<&toml::Table>> {
    let root = match config {
        toml::Value::Table(table) => table,
        _ => return Err(invalid_error("effective config must be a TOML table")),
    };
    match root.get("resources") {
        Some(toml::Value::Table(table)) => Ok(Some(table)),
        Some(_) => Err(invalid_error("resources config must be a table")),
        None => Ok(None),
    }
}

fn parse_refresh_interval(value: &str) -> Result<ResourceRefreshInterval> {
    match value {
        "1s" => Ok(ResourceRefreshInterval::OneSecond),
        "2s" => Ok(ResourceRefreshInterval::TwoSeconds),
        "5s" => Ok(ResourceRefreshInterval::FiveSeconds),
        "10s" => Ok(ResourceRefreshInterval::TenSeconds),
        _ => Err(invalid_error(
            "resources.default_refresh_interval must be 1s, 2s, 5s, or 10s",
        )),
    }
}

fn parse_remote_provider_mode(value: &str) -> Result<ResourceRemoteProviderMode> {
    match value {
        "auto" => Ok(ResourceRemoteProviderMode::Auto),
        "agent" => Ok(ResourceRemoteProviderMode::Agent),
        "system_commands" => Ok(ResourceRemoteProviderMode::SystemCommands),
        _ => Err(invalid_error(
            "resources.remote_provider must be auto, agent, or system_commands",
        )),
    }
}

fn resource_settings_from_config(config: &toml::Value) -> Result<ResourceSettings> {
    let mut settings = ResourceSettings::default();
    let Some(table) = resources_table(config)? else {
        return Ok(settings);
    };
    match table.get("default_refresh_interval") {
        Some(toml::Value::String(value)) => {
            settings.default_refresh_interval = parse_refresh_interval(value)?;
        }
        Some(_) => {
            return Err(invalid_error(
                "resources.default_refresh_interval must be a string",
            ));
        }
        None => {}
    }
    match table.get("remote_provider") {
        Some(toml::Value::String(value)) => {
            settings.remote_provider = parse_remote_provider_mode(value)?;
        }
        Some(_) => {
            return Err(invalid_error("resources.remote_provider must be a string"));
        }
        None => {}
    }
    Ok(settings)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn get_resource_settings(app: AppHandle) -> Result<ResourceSettings> {
    resource_settings_from_config(&effective_application_config(&app)?)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn collect_resource_monitor_snapshot(
    app: AppHandle,
    input: ResourceMonitorCollectInput,
) -> Result<ResourceMonitorSnapshot> {
    tauri::async_runtime::spawn_blocking(move || {
        collect_resource_monitor_snapshot_blocking(app, input)
    })
    .await
    .map_err(|error| {
        invalid_error(format!(
            "collect_resource_monitor_snapshot worker failed: {error}"
        ))
    })?
}

fn collect_resource_monitor_snapshot_blocking(
    app: AppHandle,
    input: ResourceMonitorCollectInput,
) -> Result<ResourceMonitorSnapshot> {
    let host_id = owned_workspace_tool_host(
        &app,
        &input.workspace_id,
        &input.tool_tab_id,
        WorkspaceToolKind::Resources,
    )?;
    let host = connection_host_by_id(&app, &host_id)?;
    match host.document.protocol {
        ConnectionProtocol::Local => Ok(local_snapshot_dto(collect_local_resource_snapshot())),
        ConnectionProtocol::Ssh => collect_remote_resource_snapshot(app, input, host),
        ConnectionProtocol::Telnet => Ok(unavailable_snapshot_dto(
            "telnet resource provider is not supported",
        )),
    }
}

fn collect_remote_resource_snapshot(
    app: AppHandle,
    input: ResourceMonitorCollectInput,
    host: crate::types::ConnectionHostEntry,
) -> Result<ResourceMonitorSnapshot> {
    let connection = connect_sftp_for_host(
        &app,
        &host,
        SftpAuthScope {
            workspace_id: &input.workspace_id,
            source_tool_tab_id: Some(&input.tool_tab_id),
        },
        false,
        false,
        None,
        false,
        &format!("resources-{}", input.tool_tab_id),
    )?;
    let detection = detect_remote_resource_target(&connection, host.document.resources.clone())?;
    let (target_os, target_arch) = match detection {
        RemoteResourceTargetDetection::Detected { os, arch, .. } => (os, arch),
        RemoteResourceTargetDetection::Unknown { reason, .. } => {
            return Ok(unavailable_snapshot_dto(reason));
        }
    };
    let settings = resource_settings_from_config(&effective_application_config(&app)?)?;
    match settings.remote_provider {
        ResourceRemoteProviderMode::SystemCommands => {
            return collect_remote_system_resource_snapshot(&connection, target_os);
        }
        ResourceRemoteProviderMode::Auto => {
            let system_snapshot = collect_remote_system_resource_snapshot(&connection, target_os)?;
            if remote_system_snapshot_has_all_metrics(&system_snapshot) {
                return Ok(system_snapshot);
            }
        }
        ResourceRemoteProviderMode::Agent => {}
    }

    let helper_source = load_resource_helper_bytes_from_app(&app, target_os, target_arch)?;
    let helper_bytes = match helper_source {
        ResourceHelperBytesSource::Bundled(bytes) => bytes,
        ResourceHelperBytesSource::DownloadRequired(plan) => {
            download_resource_helper_after_confirmation(&app, &plan)?
        }
        ResourceHelperBytesSource::Unavailable { reason } => {
            return Ok(unavailable_snapshot_dto(reason));
        }
    };
    let plan = plan_resource_helper_upload(
        &helper_bytes,
        target_os,
        target_arch,
        RESOURCE_HELPER_VERSION,
    )?;
    let helper_policy = resource_helper_policy(&app)?;
    let helper_remote_path =
        match deploy_resource_helper_if_needed(&app, &connection, &host, helper_policy, &plan)? {
            ResourceHelperDeploymentRuntime::Ready(path) => path,
            ResourceHelperDeploymentRuntime::Unavailable { reason } => {
                return Ok(unavailable_snapshot_dto(reason));
            }
        };
    let output = run_remote_command(
        &connection.session,
        &resource_helper_launch_once_command(target_os, &helper_remote_path),
    )?;
    if output.status != 0 {
        return Ok(unavailable_snapshot_dto(format!(
            "nocturne-resource-monitor-agent failed: {}",
            output.stderr.trim()
        )));
    }
    let events = parse_resource_monitor_agent_ndjson(&output.stdout)?;
    let metrics = metrics_from_resource_monitor_agent_events(events)?;
    Ok(local_snapshot_dto(LocalResourceSnapshot {
        provider: "nocturne-resource-monitor-agent on remote",
        metrics,
    }))
}

fn collect_remote_system_resource_snapshot(
    connection: &SftpConnection,
    target_os: RemoteResourceTargetOs,
) -> Result<ResourceMonitorSnapshot> {
    let metrics = collect_remote_system_resource_metrics(connection, target_os)?;
    Ok(local_snapshot_dto(LocalResourceSnapshot {
        provider: remote_system_command_plan(target_os).provider_label,
        metrics,
    }))
}

fn collect_remote_system_resource_metrics(
    connection: &SftpConnection,
    target_os: RemoteResourceTargetOs,
) -> Result<Vec<LocalResourceMetric>> {
    match target_os {
        RemoteResourceTargetOs::Linux => collect_remote_linux_system_resource_metrics(connection),
        RemoteResourceTargetOs::Macos => Ok(vec![
            unavailable_metric(
                LocalResourceMetricKind::Cpu,
                "macOS remote CPU command provider is not implemented",
            ),
            unavailable_metric(
                LocalResourceMetricKind::Memory,
                "macOS remote memory command provider is not implemented",
            ),
            unavailable_metric(
                LocalResourceMetricKind::Swap,
                "macOS remote swap command provider is not implemented",
            ),
            unavailable_metric(
                LocalResourceMetricKind::Gpu,
                "macOS remote GPU command provider is not implemented",
            ),
        ]),
        RemoteResourceTargetOs::Windows => Ok(vec![
            unavailable_metric(
                LocalResourceMetricKind::Cpu,
                "Windows remote CPU command provider is not implemented",
            ),
            unavailable_metric(
                LocalResourceMetricKind::Memory,
                "Windows remote memory command provider is not implemented",
            ),
            unavailable_metric(
                LocalResourceMetricKind::Swap,
                "Windows remote swap command provider is not implemented",
            ),
            unavailable_metric(
                LocalResourceMetricKind::Gpu,
                "Windows remote GPU command provider is not implemented",
            ),
        ]),
    }
}

fn collect_remote_linux_system_resource_metrics(
    connection: &SftpConnection,
) -> Result<Vec<LocalResourceMetric>> {
    let mut metrics = Vec::new();
    let stat = run_remote_command(&connection.session, "cat /proc/stat")?;
    metrics.push(if stat.status == 0 {
        parse_linux_proc_stat_cpu(&stat.stdout)?
    } else {
        unavailable_metric(
            LocalResourceMetricKind::Cpu,
            format!("Linux /proc/stat command failed: {}", stat.stderr.trim()),
        )
    });

    let free = run_remote_command(&connection.session, "free -b")?;
    if free.status == 0 {
        metrics.extend(parse_linux_free_b(&free.stdout)?);
    } else {
        metrics.push(unavailable_metric(
            LocalResourceMetricKind::Memory,
            format!("Linux free command failed: {}", free.stderr.trim()),
        ));
        metrics.push(unavailable_metric(
            LocalResourceMetricKind::Swap,
            format!("Linux free command failed: {}", free.stderr.trim()),
        ));
    }

    let gpu = run_remote_command(&connection.session, LINUX_NVIDIA_SMI_QUERY_COMMAND)?;
    metrics.push(if gpu.status == 0 {
        parse_linux_nvidia_smi_csv(&gpu.stdout)?
    } else {
        unavailable_metric(
            LocalResourceMetricKind::Gpu,
            "nvidia-smi is unavailable or did not report NVIDIA GPU metrics",
        )
    });

    Ok(metrics)
}

fn remote_system_snapshot_has_all_metrics(snapshot: &ResourceMonitorSnapshot) -> bool {
    [
        LocalResourceMetricKind::Cpu,
        LocalResourceMetricKind::Memory,
        LocalResourceMetricKind::Swap,
        LocalResourceMetricKind::Gpu,
    ]
    .into_iter()
    .all(|kind| {
        snapshot
            .metrics
            .iter()
            .any(|metric| metric.metric == kind && metric.status == "available")
    })
}

pub(crate) fn detect_remote_resource_target(
    connection: &SftpConnection,
    host_config: Option<HostResourceConfig>,
) -> Result<RemoteResourceTargetDetection> {
    if let Some(config) = host_config.clone() {
        match (config.target_os, config.target_arch) {
            (Some(_), Some(_)) | (Some(_), None) | (None, Some(_)) => {
                return Ok(resolve_resource_target(Some(config), None));
            }
            (None, None) => {}
        }
    }

    let uname_os = run_remote_command(&connection.session, "uname -s");
    let uname_arch = run_remote_command(&connection.session, "uname -m");
    if let (Ok(os), Ok(arch)) = (&uname_os, &uname_arch) {
        if os.status == 0 && arch.status == 0 {
            return Ok(resolve_resource_target(
                host_config,
                Some((&os.stdout, &arch.stdout)),
            ));
        }
    }

    let windows_os = run_remote_command(
        &connection.session,
        "[System.Environment]::OSVersion.Platform",
    );
    let windows_arch = run_remote_command(
        &connection.session,
        "[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture",
    );
    if let (Ok(os), Ok(arch)) = (&windows_os, &windows_arch) {
        if os.status == 0 && arch.status == 0 {
            return Ok(parse_remote_windows_platform(&os.stdout, &arch.stdout));
        }
    }

    Ok(RemoteResourceTargetDetection::Unknown {
        reason: "Remote target detection did not produce OS and architecture".to_string(),
        requires_user_choice: true,
    })
}

enum ResourceHelperDeploymentRuntime {
    Ready(String),
    Unavailable { reason: String },
}

fn deploy_resource_helper_if_needed(
    app: &AppHandle,
    connection: &SftpConnection,
    host: &crate::types::ConnectionHostEntry,
    policy: ResourceHelperPolicy,
    plan: &ResourceHelperUploadPlan,
) -> Result<ResourceHelperDeploymentRuntime> {
    let home = remote_home_path(&connection.session)?;
    let helper_upload_path = expand_remote_home(&plan.helper_upload_path, &home);
    let memory = resource_helper_deployment_memory();
    if memory
        .lock()
        .map_err(|_| invalid_error("resource helper deployment memory is poisoned"))?
        .verified_hash(&host.id)
        == Some(plan.manifest.sha256.as_str())
    {
        return Ok(ResourceHelperDeploymentRuntime::Ready(helper_upload_path));
    }

    let decision = decide_resource_helper_deployment(
        policy,
        ResourceHelperDeploymentStatus::Missing,
        &host.id,
        &host.document.name,
        plan.manifest.clone(),
    );
    match decision {
        ResourceHelperDeploymentDecision::UseExisting => {
            return Ok(ResourceHelperDeploymentRuntime::Ready(helper_upload_path));
        }
        ResourceHelperDeploymentDecision::Unavailable { reason } => {
            return Ok(ResourceHelperDeploymentRuntime::Unavailable { reason });
        }
        ResourceHelperDeploymentDecision::Prompt(prompt)
            if !confirm_resource_helper_upload(app, &prompt) =>
        {
            return Ok(ResourceHelperDeploymentRuntime::Unavailable {
                reason: "Resource Monitor helper upload was canceled by the user".to_string(),
            });
        }
        ResourceHelperDeploymentDecision::Prompt(_)
        | ResourceHelperDeploymentDecision::Upload { .. } => {}
    }

    deploy_resource_helper(connection, plan, &home)?;
    memory
        .lock()
        .map_err(|_| invalid_error("resource helper deployment memory is poisoned"))?
        .record_verified(&host.id, plan.manifest.clone());
    Ok(ResourceHelperDeploymentRuntime::Ready(helper_upload_path))
}

fn confirm_resource_helper_upload(app: &AppHandle, prompt: &ResourceHelperPrompt) -> bool {
    app.dialog()
        .message(format!(
            "Upload {} for {}?\n\nHost: {}\nTarget: {:?} {:?}\nPath: {}\nSHA-256: {}\nReason: {}",
            prompt.helper_name,
            prompt.purpose,
            prompt.host_label,
            prompt.target_os,
            prompt.target_arch,
            prompt.upload_path,
            prompt.sha256,
            prompt.reason
        ))
        .title("Upload Resource Monitor helper")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Upload".to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show()
}

fn deploy_resource_helper(
    connection: &SftpConnection,
    plan: &ResourceHelperUploadPlan,
    home: &str,
) -> Result<()> {
    let sftp = connection.session.sftp().map_err(terminal_error)?;
    let remote_directory = expand_remote_home(&plan.remote_directory, &home);
    let helper_upload_path = expand_remote_home(&plan.helper_upload_path, &home);
    let manifest_upload_path = expand_remote_home(&plan.manifest_upload_path, &home);

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
            "uploaded Resource Monitor helper hash verification failed: {}",
            output.stderr.trim()
        )));
    }
    Ok(())
}

fn metrics_from_resource_monitor_agent_events(
    events: Vec<ResourceMonitorAgentEvent>,
) -> Result<Vec<LocalResourceMetric>> {
    for event in events {
        if let ResourceMonitorAgentEvent::Snapshot { metrics } = event {
            return metrics
                .into_iter()
                .map(normalize_resource_monitor_agent_metric)
                .collect::<Result<Vec<_>>>();
        }
    }
    Err(invalid_error(
        "nocturne-resource-monitor-agent did not produce a snapshot event",
    ))
}

fn remote_home_path(session: &ssh2::Session) -> Result<String> {
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

fn ensure_sftp_directory(sftp: &ssh2::Sftp, path: &Path) -> Result<()> {
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

fn write_sftp_file(sftp: &ssh2::Sftp, path: &Path, bytes: &[u8], mode: i32) -> Result<()> {
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

pub fn resource_settings_from_config_for_test(config: &toml::Value) -> Result<ResourceSettings> {
    resource_settings_from_config(config)
}

pub fn build_info() -> NocturneBuildInfo {
    let commit = option_env!("NOCTURNE_BUILD_COMMIT")
        .unwrap_or("unknown")
        .trim()
        .to_string();
    let tag = option_env!("NOCTURNE_BUILD_TAG")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    NocturneBuildInfo { commit, tag }
}

pub fn local_resource_provider_descriptor() -> LocalResourceProviderDescriptor {
    LocalResourceProviderDescriptor {
        label: "local provider",
        starts_external_agent: false,
    }
}

pub fn collect_local_resource_snapshot() -> LocalResourceSnapshot {
    let mut system = sysinfo::System::new_all();
    system.refresh_all();

    LocalResourceSnapshot {
        provider: local_resource_provider_descriptor().label,
        metrics: vec![
            normalize_cpu_metric(
                f64::from(system.global_cpu_usage()),
                system
                    .cpus()
                    .iter()
                    .map(|cpu| f64::from(cpu.cpu_usage()))
                    .collect(),
            ),
            normalize_memory_metric(
                LocalResourceMetricKind::Memory,
                system.used_memory(),
                system.total_memory(),
                Some(system.available_memory()),
                None,
            ),
            normalize_memory_metric(
                LocalResourceMetricKind::Swap,
                system.used_swap(),
                system.total_swap(),
                None,
                Some(system.free_swap()),
            ),
            collect_local_gpu_metric(),
        ],
    }
}

fn local_snapshot_dto(snapshot: LocalResourceSnapshot) -> ResourceMonitorSnapshot {
    ResourceMonitorSnapshot {
        provider: snapshot.provider.to_string(),
        collected_at_ms: current_unix_ms_string(),
        metrics: snapshot.metrics.into_iter().map(metric_dto).collect(),
    }
}

fn unavailable_snapshot_dto(reason: impl Into<String>) -> ResourceMonitorSnapshot {
    let reason = reason.into();
    ResourceMonitorSnapshot {
        provider: "unavailable resource provider".to_string(),
        collected_at_ms: current_unix_ms_string(),
        metrics: [
            LocalResourceMetricKind::Cpu,
            LocalResourceMetricKind::Memory,
            LocalResourceMetricKind::Swap,
            LocalResourceMetricKind::Gpu,
        ]
        .into_iter()
        .map(|metric| ResourceMonitorMetric {
            metric,
            status: "unavailable".to_string(),
            used: None,
            total: None,
            percent: None,
            available: None,
            free: None,
            reason: Some(reason.clone()),
            cores: Vec::new(),
            gpus: Vec::new(),
        })
        .collect(),
    }
}

fn load_resource_helper_bytes_from_app(
    app: &AppHandle,
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
) -> Result<ResourceHelperBytesSource> {
    let resource_path = resource_helper_resource_path(target_os, target_arch);
    let resource_dir = app.path().resource_dir().map_err(crate::error::io_error)?;
    load_resource_helper_bytes_from_paths(
        &resource_helper_candidate_paths(&resource_dir, &resource_path),
        GITHUB_RELEASE_REPOSITORY,
        build_info().tag.as_deref(),
        target_os,
        target_arch,
    )
}

pub fn load_resource_helper_bytes_from_path(
    path: &Path,
    github_repository: &str,
    build_tag: Option<&str>,
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
) -> Result<ResourceHelperBytesSource> {
    load_resource_helper_bytes_from_paths(
        &[path.to_path_buf()],
        github_repository,
        build_tag,
        target_os,
        target_arch,
    )
}

fn load_resource_helper_bytes_from_paths(
    paths: &[PathBuf],
    github_repository: &str,
    build_tag: Option<&str>,
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
) -> Result<ResourceHelperBytesSource> {
    for path in paths {
        match fs::read(path) {
            Ok(bytes) if !bytes.is_empty() => return Ok(ResourceHelperBytesSource::Bundled(bytes)),
            Ok(_) => {
                return Err(invalid_error(format!(
                    "bundled Resource Monitor helper is empty: {}",
                    path.display()
                )));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(crate::error::io_error(error)),
        }
    }

    match helper_download_plan(github_repository, build_tag, target_os, target_arch) {
        Some(plan) => Ok(ResourceHelperBytesSource::DownloadRequired(plan)),
        None => Ok(ResourceHelperBytesSource::Unavailable {
            reason: "Bundled Resource Monitor helper is missing and this build has no release tag"
                .to_string(),
        }),
    }
}

fn resource_helper_candidate_paths(resource_dir: &Path, resource_path: &str) -> Vec<PathBuf> {
    vec![
        resource_dir.join(resource_path),
        resource_dir.join("resources").join(resource_path),
    ]
}

pub fn helper_download_plan(
    github_repository: &str,
    build_tag: Option<&str>,
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
) -> Option<ResourceHelperDownloadPlan> {
    let tag = build_tag?.trim();
    if tag.is_empty() {
        return None;
    }
    let asset_name = helper_asset_name(tag, target_os, target_arch);
    let url = format!(
        "https://github.com/{}/releases/download/{}/{}",
        github_repository.trim_matches('/'),
        tag,
        asset_name
    );
    Some(ResourceHelperDownloadPlan {
        tag: tag.to_string(),
        asset_name,
        url: url.clone(),
        prompt: format!(
            "The bundled Resource Monitor helper is missing. Download nocturne-resource-monitor-agent for Resource Monitor metrics from the current app release tag {tag}?\n\n{url}"
        ),
    })
}

pub fn helper_asset_name(
    tag: &str,
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
) -> String {
    format!(
        "nocturne-resource-monitor-agent-{}-{}-{}{}",
        tag,
        resource_target_os_dir(target_os),
        resource_target_arch_dir(target_arch),
        if target_os == RemoteResourceTargetOs::Windows {
            ".exe"
        } else {
            ""
        }
    )
}

fn download_resource_helper_after_confirmation(
    app: &AppHandle,
    plan: &ResourceHelperDownloadPlan,
) -> Result<Vec<u8>> {
    let allowed = app
        .dialog()
        .message(plan.prompt.clone())
        .title("Download Resource Monitor helper")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Download".to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show();
    if !allowed {
        return Err(invalid_error(
            "Resource Monitor helper download was canceled by the user",
        ));
    }
    download_resource_helper_from_url(&plan.url)
}

fn download_resource_helper_from_url(url: &str) -> Result<Vec<u8>> {
    let client = reqwest::blocking::Client::builder()
        .timeout(RESOURCE_HELPER_HTTP_TIMEOUT)
        .build()
        .map_err(|error| invalid_error(format!("resource helper HTTP client failed: {error}")))?;
    let response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, "Nocturne Resource Monitor")
        .send()
        .map_err(|error| invalid_error(format!("resource helper download failed: {error}")))?;
    if !response.status().is_success() {
        return Err(invalid_error(format!(
            "resource helper download returned HTTP {}",
            response.status()
        )));
    }
    let bytes = response
        .bytes()
        .map_err(|error| invalid_error(format!("resource helper download read failed: {error}")))?;
    if bytes.is_empty() {
        return Err(invalid_error("downloaded Resource Monitor helper is empty"));
    }
    Ok(bytes.to_vec())
}

fn resource_helper_policy(app: &AppHandle) -> Result<ResourceHelperPolicy> {
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
        "ask" => Ok(ResourceHelperPolicy::Ask),
        "never" => Ok(ResourceHelperPolicy::Never),
        "allow" => Ok(ResourceHelperPolicy::Allow),
        _ => Err(invalid_error(
            "files.remote_helper_policy must be ask, never, or allow",
        )),
    }
}

fn metric_dto(metric: LocalResourceMetric) -> ResourceMonitorMetric {
    match metric.availability {
        LocalResourceMetricAvailability::Available {
            used,
            total,
            percent,
            available,
            free,
            details,
        } => {
            let (cores, gpus) = match details {
                LocalResourceMetricDetails::CpuCores(cores) => (cores, Vec::new()),
                LocalResourceMetricDetails::GpuDevices(gpus) => {
                    let gpu_devices = gpus
                        .into_iter()
                        .map(|gpu| ResourceMonitorGpuDevice {
                            id: gpu.id,
                            label: gpu.label,
                            compute_percent: gpu.compute_percent,
                            memory_used: gpu.memory_used.to_string(),
                            memory_total: gpu.memory_total.to_string(),
                        })
                        .collect();
                    (Vec::new(), gpu_devices)
                }
                LocalResourceMetricDetails::None => (Vec::new(), Vec::new()),
            };
            ResourceMonitorMetric {
                metric: metric.kind,
                status: "available".to_string(),
                used: Some(used.to_string()),
                total: Some(total.to_string()),
                percent: Some(percent),
                available: available.map(|value| value.to_string()),
                free: free.map(|value| value.to_string()),
                reason: None,
                cores,
                gpus,
            }
        }
        LocalResourceMetricAvailability::Unavailable { reason } => ResourceMonitorMetric {
            metric: metric.kind,
            status: "unavailable".to_string(),
            used: None,
            total: None,
            percent: None,
            available: None,
            free: None,
            reason: Some(reason),
            cores: Vec::new(),
            gpus: Vec::new(),
        },
    }
}

fn current_unix_ms_string() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

pub fn remote_system_command_plan(target_os: RemoteResourceTargetOs) -> RemoteSystemCommandPlan {
    let commands = match target_os {
        RemoteResourceTargetOs::Linux => vec![
            "cat /proc/stat",
            "free -b",
            LINUX_NVIDIA_SMI_QUERY_COMMAND,
        ],
        RemoteResourceTargetOs::Macos => vec![
            "sysctl -n hw.memsize",
            "vm_stat",
            "sysctl -n vm.swapusage",
            "top -l 1 -n 0",
        ],
        RemoteResourceTargetOs::Windows => vec![
            "Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory",
            "Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor",
            "Get-CimInstance Win32_PageFileUsage",
        ],
    };
    RemoteSystemCommandPlan {
        target_os,
        provider_label: "system commands on remote",
        commands,
        runs_off_tauri_command_thread: true,
    }
}

pub fn remote_system_provider_runs_off_command_thread() -> bool {
    true
}

pub fn parse_linux_proc_stat_cpu(output: &str) -> Result<LocalResourceMetric> {
    let line = output
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("cpu "))
        .ok_or_else(|| {
            invalid_error("Linux /proc/stat output did not include aggregate cpu row")
        })?;
    let values = line
        .split_whitespace()
        .skip(1)
        .map(|value| {
            value.parse::<u64>().map_err(|error| {
                invalid_error(format!("Linux /proc/stat CPU field is invalid: {error}"))
            })
        })
        .collect::<Result<Vec<_>>>()?;
    if values.len() < 4 {
        return Err(invalid_error(
            "Linux /proc/stat aggregate cpu row has too few fields",
        ));
    }
    let idle = values
        .get(3)
        .copied()
        .unwrap_or(0)
        .saturating_add(values.get(4).copied().unwrap_or(0));
    let total = values
        .iter()
        .fold(0_u64, |sum, value| sum.saturating_add(*value));
    if total == 0 {
        return Ok(unavailable_metric(
            LocalResourceMetricKind::Cpu,
            "Linux /proc/stat aggregate cpu total is zero",
        ));
    }
    let busy = total.saturating_sub(idle);
    Ok(normalize_cpu_metric(
        (busy as f64 / total as f64) * 100.0,
        Vec::new(),
    ))
}

pub fn parse_linux_free_b(output: &str) -> Result<Vec<LocalResourceMetric>> {
    let mut memory: Option<LocalResourceMetric> = None;
    let mut swap: Option<LocalResourceMetric> = None;

    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.first() == Some(&"Mem:") {
            let total = parse_u64_field(parts.get(1), "linux free Mem total")?;
            let used = parse_u64_field(parts.get(2), "linux free Mem used")?;
            let available = parts
                .get(6)
                .map(|value| parse_u64_field(Some(value), "linux free Mem available"))
                .transpose()?;
            memory = Some(normalize_memory_metric(
                LocalResourceMetricKind::Memory,
                used,
                total,
                available,
                None,
            ));
        } else if parts.first() == Some(&"Swap:") {
            let total = parse_u64_field(parts.get(1), "linux free Swap total")?;
            let used = parse_u64_field(parts.get(2), "linux free Swap used")?;
            let free = parts
                .get(3)
                .map(|value| parse_u64_field(Some(value), "linux free Swap free"))
                .transpose()?;
            swap = Some(normalize_memory_metric(
                LocalResourceMetricKind::Swap,
                used,
                total,
                None,
                free,
            ));
        }
    }

    Ok(vec![
        memory.unwrap_or_else(|| {
            unavailable_metric(
                LocalResourceMetricKind::Memory,
                "Linux free output did not include Mem row",
            )
        }),
        swap.unwrap_or_else(|| {
            unavailable_metric(
                LocalResourceMetricKind::Swap,
                "Linux free output did not include Swap row",
            )
        }),
    ])
}

pub fn parse_linux_nvidia_smi_csv(output: &str) -> Result<LocalResourceMetric> {
    let mut devices = Vec::new();
    for (index, line) in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .enumerate()
    {
        let parts: Vec<&str> = line.split(',').map(str::trim).collect();
        if parts.len() != 5 {
            return Err(invalid_error(format!(
                "nvidia-smi CSV row {} must have 5 fields",
                index + 1
            )));
        }
        let id = format!("nvidia-{}", parts[0]);
        let label = parts[1].to_string();
        let compute_percent = parse_f64_field(parts.get(2), "nvidia-smi utilization.gpu")?;
        let memory_used_mib = parse_u64_field(parts.get(3), "nvidia-smi memory.used")?;
        let memory_total_mib = parse_u64_field(parts.get(4), "nvidia-smi memory.total")?;
        devices.push(LocalGpuDeviceMetric {
            id,
            label,
            compute_percent,
            memory_used: memory_used_mib.saturating_mul(1024 * 1024),
            memory_total: memory_total_mib.saturating_mul(1024 * 1024),
        });
    }

    if devices.is_empty() {
        return Ok(unavailable_metric(
            LocalResourceMetricKind::Gpu,
            "nvidia-smi did not report NVIDIA GPU metrics",
        ));
    }

    Ok(normalize_gpu_devices_metric(devices))
}

pub fn parse_macos_memory(
    total_memory: u64,
    available_memory: u64,
    swap_total: u64,
    swap_used: u64,
) -> Vec<LocalResourceMetric> {
    let used_memory = total_memory.saturating_sub(available_memory);
    let swap_free = swap_total.saturating_sub(swap_used);
    vec![
        normalize_memory_metric(
            LocalResourceMetricKind::Memory,
            used_memory,
            total_memory,
            Some(available_memory),
            None,
        ),
        normalize_memory_metric(
            LocalResourceMetricKind::Swap,
            swap_used,
            swap_total,
            None,
            Some(swap_free),
        ),
    ]
}

pub fn parse_windows_memory(
    total_memory: u64,
    free_memory: u64,
    swap: Option<(u64, u64)>,
) -> Vec<LocalResourceMetric> {
    let used_memory = total_memory.saturating_sub(free_memory);
    let swap_metric = match swap {
        Some((used, total)) => normalize_memory_metric(
            LocalResourceMetricKind::Swap,
            used,
            total,
            None,
            Some(total.saturating_sub(used)),
        ),
        None => unavailable_metric(
            LocalResourceMetricKind::Swap,
            "Windows swap metrics unavailable from selected system commands",
        ),
    };
    vec![
        normalize_memory_metric(
            LocalResourceMetricKind::Memory,
            used_memory,
            total_memory,
            Some(free_memory),
            None,
        ),
        swap_metric,
    ]
}

pub fn parse_resource_monitor_agent_ndjson(input: &str) -> Result<Vec<ResourceMonitorAgentEvent>> {
    let mut events = Vec::new();
    for (index, line) in input.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let event = serde_json::from_str::<ResourceMonitorAgentEvent>(line).map_err(|error| {
            invalid_error(format!(
                "invalid nocturne-resource-monitor-agent NDJSON event at line {}: {}",
                index + 1,
                error
            ))
        })?;
        events.push(event);
    }
    Ok(events)
}

pub fn decide_resource_helper_deployment(
    policy: ResourceHelperPolicy,
    status: ResourceHelperDeploymentStatus,
    host_id: &str,
    host_label: &str,
    manifest: ResourceHelperManifest,
) -> ResourceHelperDeploymentDecision {
    if status == ResourceHelperDeploymentStatus::Verified {
        return ResourceHelperDeploymentDecision::UseExisting;
    }

    match policy {
        ResourceHelperPolicy::Never => ResourceHelperDeploymentDecision::Unavailable {
            reason: "remote helper policy is Never".to_string(),
        },
        ResourceHelperPolicy::Allow => ResourceHelperDeploymentDecision::Upload {
            host_id: host_id.to_string(),
            manifest,
        },
        ResourceHelperPolicy::Ask => {
            ResourceHelperDeploymentDecision::Prompt(ResourceHelperPrompt {
                helper_name: manifest.helper_name.clone(),
                purpose: manifest.purpose.clone(),
                host_id: host_id.to_string(),
                host_label: host_label.to_string(),
                target_os: manifest.target_os,
                target_arch: manifest.target_arch,
                upload_path: manifest.upload_path.clone(),
                sha256: manifest.sha256.clone(),
                reason: deployment_status_reason(&status),
            })
        }
    }
}

pub fn resource_helper_resource_path(
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
) -> String {
    format!(
        "nocturne-resource-monitor-agent/{}/{}/{}",
        resource_target_os_dir(target_os),
        resource_target_arch_dir(target_arch),
        resource_helper_executable_name(target_os)
    )
}

pub fn plan_resource_helper_upload(
    helper_bytes: &[u8],
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
    version: &str,
) -> Result<ResourceHelperUploadPlan> {
    if helper_bytes.is_empty() {
        return Err(invalid_error("resource helper bytes cannot be empty"));
    }
    let remote_directory = resource_helper_remote_directory(version);
    let helper_upload_path = resource_helper_remote_path(target_os, version);
    let manifest_upload_path = resource_helper_manifest_remote_path(version);
    let helper_sha256 = hex::encode(Sha256::digest(helper_bytes));
    let manifest = ResourceHelperManifest {
        helper_name: "nocturne-resource-monitor-agent".to_string(),
        purpose: "Resource Monitor metrics".to_string(),
        version: version.to_string(),
        target_os,
        target_arch,
        upload_path: helper_upload_path.clone(),
        sha256: helper_sha256.clone(),
        capabilities: vec![
            "resource.cpu".to_string(),
            "resource.memory".to_string(),
            "resource.swap".to_string(),
            "resource.gpu".to_string(),
        ],
    };
    let manifest_json = serde_json::to_string(&manifest)
        .map_err(|error| invalid_error(format!("resource helper manifest JSON failed: {error}")))?;
    Ok(ResourceHelperUploadPlan {
        resource_path: resource_helper_resource_path(target_os, target_arch),
        manifest,
        manifest_path: manifest_upload_path.clone(),
        remote_directory,
        helper_upload_path: helper_upload_path.clone(),
        manifest_upload_path,
        executable_mode: resource_helper_executable_mode(target_os),
        verify_sha256_command: resource_helper_verify_sha256_command(
            target_os,
            &helper_upload_path,
            &helper_sha256,
        ),
        launch_stream_command: resource_helper_launch_stream_command(
            target_os,
            &helper_upload_path,
        ),
        helper_bytes: helper_bytes.to_vec(),
        manifest_json,
    })
}

fn resource_helper_remote_directory(version: &str) -> String {
    format!("~/.cache/nocturne/helpers/{version}")
}

fn resource_helper_remote_path(target_os: RemoteResourceTargetOs, version: &str) -> String {
    format!(
        "{}/{}",
        resource_helper_remote_directory(version),
        resource_helper_executable_name(target_os)
    )
}

fn resource_helper_manifest_remote_path(version: &str) -> String {
    format!("~/.cache/nocturne/helpers/{version}/manifest.json")
}

fn resource_target_os_dir(target_os: RemoteResourceTargetOs) -> &'static str {
    match target_os {
        RemoteResourceTargetOs::Linux => "linux",
        RemoteResourceTargetOs::Macos => "macos",
        RemoteResourceTargetOs::Windows => "windows",
    }
}

fn resource_target_arch_dir(target_arch: RemoteResourceTargetArch) -> &'static str {
    match target_arch {
        RemoteResourceTargetArch::X86_64 => "x86_64",
        RemoteResourceTargetArch::Aarch64 => "aarch64",
        RemoteResourceTargetArch::Armv7 => "armv7",
        RemoteResourceTargetArch::I686 => "i686",
    }
}

fn resource_helper_executable_name(target_os: RemoteResourceTargetOs) -> &'static str {
    match target_os {
        RemoteResourceTargetOs::Windows => "nocturne-resource-monitor-agent.exe",
        RemoteResourceTargetOs::Linux | RemoteResourceTargetOs::Macos => {
            "nocturne-resource-monitor-agent"
        }
    }
}

fn resource_helper_executable_mode(target_os: RemoteResourceTargetOs) -> Option<u32> {
    match target_os {
        RemoteResourceTargetOs::Windows => None,
        RemoteResourceTargetOs::Linux | RemoteResourceTargetOs::Macos => Some(0o755),
    }
}

fn resource_helper_verify_sha256_command(
    target_os: RemoteResourceTargetOs,
    helper_path: &str,
    expected_sha256: &str,
) -> String {
    match target_os {
        RemoteResourceTargetOs::Linux => format!(
            "printf '%s  %s\\n' '{expected_sha256}' '{helper_path}' | sha256sum -c -"
        ),
        RemoteResourceTargetOs::Macos => format!(
            "test \"$(shasum -a 256 '{helper_path}' | awk '{{print $1}}')\" = '{expected_sha256}'"
        ),
        RemoteResourceTargetOs::Windows => format!(
            "if ((Get-FileHash -Algorithm SHA256 '{helper_path}').Hash.ToLowerInvariant() -ne '{expected_sha256}') {{ exit 1 }}"
        ),
    }
}

fn resource_helper_launch_stream_command(
    target_os: RemoteResourceTargetOs,
    helper_path: &str,
) -> String {
    match target_os {
        RemoteResourceTargetOs::Windows => format!("& '{helper_path}' --stream"),
        RemoteResourceTargetOs::Linux | RemoteResourceTargetOs::Macos => {
            format!("'{helper_path}' --stream")
        }
    }
}

fn resource_helper_launch_once_command(
    target_os: RemoteResourceTargetOs,
    helper_path: &str,
) -> String {
    match target_os {
        RemoteResourceTargetOs::Windows => format!("& {}", shell_quote(helper_path)),
        RemoteResourceTargetOs::Linux | RemoteResourceTargetOs::Macos => shell_quote(helper_path),
    }
}

fn deployment_status_reason(status: &ResourceHelperDeploymentStatus) -> String {
    match status {
        ResourceHelperDeploymentStatus::Verified => "helper already verified".to_string(),
        ResourceHelperDeploymentStatus::Missing => "helper is missing".to_string(),
        ResourceHelperDeploymentStatus::HashMismatch { found_sha256 } => {
            format!("helper hash mismatch; found {found_sha256}")
        }
        ResourceHelperDeploymentStatus::InvalidManifest { reason } => {
            format!("helper manifest invalid: {reason}")
        }
    }
}

pub fn normalize_resource_monitor_agent_metric(
    metric: ResourceMonitorAgentMetric,
) -> Result<LocalResourceMetric> {
    match metric.status.as_str() {
        "available" => normalize_available_resource_monitor_agent_metric(metric),
        "unavailable" => Ok(unavailable_metric(
            metric.metric,
            metric
                .reason
                .ok_or_else(|| invalid_error("unavailable helper metric is missing reason"))?,
        )),
        other => Err(invalid_error(format!(
            "unsupported helper metric status: {other}"
        ))),
    }
}

fn normalize_available_resource_monitor_agent_metric(
    metric: ResourceMonitorAgentMetric,
) -> Result<LocalResourceMetric> {
    match metric.metric {
        LocalResourceMetricKind::Cpu => {
            let percent = metric
                .percent
                .ok_or_else(|| invalid_error("available CPU helper metric is missing percent"))?;
            Ok(LocalResourceMetric {
                kind: LocalResourceMetricKind::Cpu,
                availability: LocalResourceMetricAvailability::Available {
                    used: 0,
                    total: 100,
                    percent: normalize_percent(percent),
                    available: None,
                    free: None,
                    details: LocalResourceMetricDetails::None,
                },
            })
        }
        LocalResourceMetricKind::Memory
        | LocalResourceMetricKind::Swap
        | LocalResourceMetricKind::Gpu => {
            if metric.metric == LocalResourceMetricKind::Gpu && !metric.gpus.is_empty() {
                return Ok(normalize_gpu_devices_metric(
                    metric
                        .gpus
                        .into_iter()
                        .map(|gpu| LocalGpuDeviceMetric {
                            id: gpu.id,
                            label: gpu.label,
                            compute_percent: gpu.compute_percent,
                            memory_used: gpu.memory_used,
                            memory_total: gpu.memory_total,
                        })
                        .collect(),
                ));
            }
            let used = metric
                .used
                .ok_or_else(|| invalid_error("available helper metric is missing used"))?;
            let total = metric
                .total
                .ok_or_else(|| invalid_error("available helper metric is missing total"))?;
            Ok(normalize_memory_metric(
                metric.metric,
                used,
                total,
                metric.available,
                metric.free,
            ))
        }
    }
}

pub fn resolve_resource_target(
    host_config: Option<HostResourceConfig>,
    uname_output: Option<(&str, &str)>,
) -> RemoteResourceTargetDetection {
    if let Some(config) = host_config {
        match (config.target_os, config.target_arch) {
            (Some(os), Some(arch)) => {
                return RemoteResourceTargetDetection::Detected {
                    os,
                    arch,
                    source: "host_config",
                };
            }
            (None, None) => {}
            _ => {
                return RemoteResourceTargetDetection::Unknown {
                    reason: "Host resource target config is incomplete".to_string(),
                    requires_user_choice: true,
                };
            }
        }
    }

    let Some((os, arch)) = uname_output else {
        return RemoteResourceTargetDetection::Unknown {
            reason: "Remote target detection did not produce OS and architecture".to_string(),
            requires_user_choice: true,
        };
    };
    parse_remote_uname(os, arch)
}

pub fn parse_remote_uname(os_output: &str, arch_output: &str) -> RemoteResourceTargetDetection {
    let Some(os) = parse_unix_os(os_output) else {
        return unsupported_target();
    };
    let Some(arch) = parse_target_arch(arch_output) else {
        return unsupported_target();
    };
    RemoteResourceTargetDetection::Detected {
        os,
        arch,
        source: "remote_uname",
    }
}

pub fn parse_remote_windows_platform(
    os_output: &str,
    arch_output: &str,
) -> RemoteResourceTargetDetection {
    if !os_output.to_ascii_lowercase().contains("windows") {
        return unsupported_target();
    }
    let Some(arch) = parse_target_arch(arch_output) else {
        return unsupported_target();
    };
    RemoteResourceTargetDetection::Detected {
        os: RemoteResourceTargetOs::Windows,
        arch,
        source: "remote_windows_platform",
    }
}

fn normalize_cpu_metric(overall_percent: f64, core_percents: Vec<f64>) -> LocalResourceMetric {
    LocalResourceMetric {
        kind: LocalResourceMetricKind::Cpu,
        availability: LocalResourceMetricAvailability::Available {
            used: 0,
            total: 100,
            percent: normalize_percent(overall_percent),
            available: None,
            free: None,
            details: LocalResourceMetricDetails::CpuCores(
                core_percents.into_iter().map(normalize_percent).collect(),
            ),
        },
    }
}

fn normalize_memory_metric(
    kind: LocalResourceMetricKind,
    used: u64,
    total: u64,
    available: Option<u64>,
    free: Option<u64>,
) -> LocalResourceMetric {
    if total == 0 {
        if kind == LocalResourceMetricKind::Swap {
            return LocalResourceMetric {
                kind,
                availability: LocalResourceMetricAvailability::Available {
                    used: 0,
                    total: 0,
                    percent: 0.0,
                    available,
                    free,
                    details: LocalResourceMetricDetails::None,
                },
            };
        }
        return LocalResourceMetric {
            kind,
            availability: LocalResourceMetricAvailability::Unavailable {
                reason: format!("{} total is zero", metric_name(kind)),
            },
        };
    }

    LocalResourceMetric {
        kind,
        availability: LocalResourceMetricAvailability::Available {
            used,
            total,
            percent: normalize_percent((used as f64 / total as f64) * 100.0),
            available,
            free,
            details: LocalResourceMetricDetails::None,
        },
    }
}

fn collect_local_gpu_metric() -> LocalResourceMetric {
    #[cfg(target_os = "linux")]
    {
        return collect_linux_drm_gpu_metric_from_root(Path::new("/sys"));
    }
    #[cfg(target_os = "windows")]
    {
        return collect_windows_gpu_pdh_metric().unwrap_or_else(gpu_unavailable_metric);
    }
    #[cfg(target_os = "macos")]
    {
        return gpu_unavailable_metric(
            "macOS local GPU provider is unavailable through a stable public API",
        );
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        gpu_unavailable_metric("local GPU provider is unsupported on this platform")
    }
}

fn collect_linux_drm_gpu_metric_from_root(sys_root: &Path) -> LocalResourceMetric {
    let drm_root = sys_root.join("class").join("drm");
    let entries = match fs::read_dir(&drm_root) {
        Ok(entries) => entries,
        Err(error) => {
            return gpu_unavailable_metric(format!(
                "Linux DRM sysfs GPU provider unavailable at {}: {error}",
                drm_root.display()
            ));
        }
    };

    let mut devices = Vec::new();
    let mut diagnostics = Vec::new();

    for entry in entries {
        let Ok(entry) = entry else {
            continue;
        };
        let card_path = entry.path();
        let card_id = entry.file_name().to_string_lossy().to_string();
        if !card_id.starts_with("card") || card_id.contains('-') {
            continue;
        }
        match linux_drm_gpu_device_metric(&card_id, &card_path.join("device")) {
            Ok(Some(device)) => devices.push(device),
            Ok(None) => {}
            Err(reason) => diagnostics.push(reason),
        }
    }

    if devices.is_empty() {
        let reason = if diagnostics.is_empty() {
            "Linux DRM sysfs did not report VRAM metrics for any GPU devices".to_string()
        } else {
            diagnostics.join("; ")
        };
        return gpu_unavailable_metric(reason);
    }

    normalize_gpu_devices_metric(devices)
}

fn linux_drm_gpu_device_metric(
    card_id: &str,
    device_path: &Path,
) -> std::result::Result<Option<LocalGpuDeviceMetric>, String> {
    let used_path = device_path.join("mem_info_vram_used");
    let total_path = device_path.join("mem_info_vram_total");
    if !used_path.exists() || !total_path.exists() {
        return Ok(None);
    }

    let memory_used = read_u64_file(&used_path)?;
    let memory_total = read_u64_file(&total_path)?;
    let label = read_first_existing_trimmed(&[
        device_path.join("product_name"),
        device_path.join("device_name"),
        device_path.join("uevent"),
    ])
    .unwrap_or_else(|| card_id.to_string());

    Ok(Some(LocalGpuDeviceMetric {
        id: card_id.to_string(),
        label,
        compute_percent: 0.0,
        memory_used,
        memory_total,
    }))
}

fn read_u64_file(path: &Path) -> std::result::Result<u64, String> {
    let value = fs::read_to_string(path)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    value
        .trim()
        .parse::<u64>()
        .map_err(|error| format!("{} is not an unsigned integer: {error}", path.display()))
}

fn read_first_existing_trimmed(paths: &[PathBuf]) -> Option<String> {
    for path in paths {
        let Ok(value) = fs::read_to_string(path) else {
            continue;
        };
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.lines().next().unwrap_or(trimmed).to_string());
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn collect_windows_gpu_pdh_metric() -> std::result::Result<LocalResourceMetric, String> {
    let mut samples = Vec::new();
    let adapters = collect_windows_dxgi_adapters()?;
    samples.extend(
        collect_windows_pdh_counter_array(
            r"\GPU Engine(*)\Utilization Percentage",
            WindowsPdhCounterFormat::Double,
        )?
        .into_iter()
        .filter_map(|sample| {
            sample
                .double_value
                .map(|value| WindowsGpuPdhSample::engine(sample.instance, value))
        }),
    );
    samples.extend(
        collect_windows_pdh_counter_array(
            r"\GPU Adapter Memory(*)\Dedicated Usage",
            WindowsPdhCounterFormat::Large,
        )?
        .into_iter()
        .filter_map(|sample| {
            sample.large_value.map(|value| {
                WindowsGpuPdhSample::memory(
                    format!("{}_dedicated", sample.instance),
                    value.max(0) as u64,
                )
            })
        }),
    );

    Ok(normalize_windows_gpu_pdh_samples(samples, adapters))
}

fn normalize_windows_gpu_pdh_samples(
    samples: Vec<WindowsGpuPdhSample>,
    adapters: Vec<WindowsGpuAdapterInfo>,
) -> LocalResourceMetric {
    let mut devices = BTreeMap::<String, LocalGpuDeviceMetric>::new();

    for adapter in adapters {
        devices.insert(
            adapter.id.clone(),
            LocalGpuDeviceMetric {
                id: adapter.id,
                label: adapter.label,
                compute_percent: 0.0,
                memory_used: 0,
                memory_total: adapter.dedicated_video_memory,
            },
        );
    }

    for sample in samples {
        match sample {
            WindowsGpuPdhSample::Engine {
                instance,
                utilization_percent,
            } => {
                let Some(id) = windows_gpu_luid_from_engine_instance(&instance) else {
                    continue;
                };
                let entry = devices
                    .entry(id.clone())
                    .or_insert_with(|| LocalGpuDeviceMetric {
                        id: id.clone(),
                        label: format!("GPU {id}"),
                        compute_percent: 0.0,
                        memory_used: 0,
                        memory_total: 0,
                    });
                entry.compute_percent =
                    normalize_percent(entry.compute_percent + utilization_percent);
            }
            WindowsGpuPdhSample::Memory { instance, bytes } => {
                let Some((id, memory_kind)) = windows_gpu_memory_instance_parts(&instance) else {
                    continue;
                };
                let entry = devices
                    .entry(id.clone())
                    .or_insert_with(|| LocalGpuDeviceMetric {
                        id: id.clone(),
                        label: format!("GPU {id}"),
                        compute_percent: 0.0,
                        memory_used: 0,
                        memory_total: 0,
                    });
                match memory_kind {
                    WindowsGpuMemoryCounterKind::DedicatedUsage => entry.memory_used = bytes,
                    WindowsGpuMemoryCounterKind::DedicatedLimit => entry.memory_total = bytes,
                }
            }
        }
    }

    let devices: Vec<LocalGpuDeviceMetric> = devices
        .into_values()
        .filter(|device| {
            device.compute_percent > 0.0 || device.memory_used > 0 || device.memory_total > 0
        })
        .collect();
    if devices.is_empty() {
        return gpu_unavailable_metric("Windows PDH did not report any GPU devices");
    }

    normalize_gpu_devices_metric(devices)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WindowsGpuMemoryCounterKind {
    DedicatedUsage,
    DedicatedLimit,
}

fn windows_gpu_luid_from_engine_instance(instance: &str) -> Option<String> {
    windows_luid_id_from_instance(instance)
}

fn windows_gpu_memory_instance_parts(
    instance: &str,
) -> Option<(String, WindowsGpuMemoryCounterKind)> {
    let id = windows_luid_id_from_instance(instance)?;
    let lower = instance.to_ascii_lowercase();
    if lower.ends_with("_dedicated_limit") {
        Some((id, WindowsGpuMemoryCounterKind::DedicatedLimit))
    } else if lower.ends_with("_dedicated") {
        Some((id, WindowsGpuMemoryCounterKind::DedicatedUsage))
    } else {
        None
    }
}

fn windows_luid_id_from_instance(instance: &str) -> Option<String> {
    let parts: Vec<&str> = instance.split('_').collect();
    for window in parts.windows(3) {
        if window[0].eq_ignore_ascii_case("luid")
            && is_windows_hex_word(window[1])
            && is_windows_hex_word(window[2])
        {
            return Some(format!(
                "luid_{}_{}",
                window[1].to_ascii_lowercase(),
                window[2].to_ascii_lowercase()
            ));
        }
    }
    None
}

fn is_windows_hex_word(value: &str) -> bool {
    value.len() == 10
        && value[..2].eq_ignore_ascii_case("0x")
        && value[2..].chars().all(|ch| ch.is_ascii_hexdigit())
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy)]
enum WindowsPdhCounterFormat {
    Double,
    Large,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone)]
struct WindowsPdhCounterSample {
    instance: String,
    double_value: Option<f64>,
    large_value: Option<i64>,
}

#[cfg(target_os = "windows")]
fn collect_windows_dxgi_adapters() -> std::result::Result<Vec<WindowsGpuAdapterInfo>, String> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ERROR_NOT_FOUND};

    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }
        .map_err(|error| format!("Windows DXGI factory creation failed: {error}"))?;
    let mut adapters = Vec::new();
    let mut index = 0_u32;
    loop {
        match unsafe { factory.EnumAdapters1(index) } {
            Ok(adapter) => {
                let desc = unsafe { adapter.GetDesc1() }
                    .map_err(|error| format!("Windows DXGI adapter description failed: {error}"))?;
                let id = windows_luid_id(desc.AdapterLuid.LowPart, desc.AdapterLuid.HighPart);
                let label = windows_utf16_array_to_string(&desc.Description)
                    .unwrap_or_else(|| format!("GPU {id}"));
                adapters.push(WindowsGpuAdapterInfo::new(
                    id,
                    label,
                    desc.DedicatedVideoMemory as u64,
                ));
            }
            Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(error) => return Err(format!("Windows DXGI adapter enumeration failed: {error}")),
        }
        index += 1;
    }

    if adapters.is_empty() {
        return Err("Windows DXGI did not report any GPU adapters".to_string());
    }

    Ok(adapters)
}

fn windows_luid_id(low_part: u32, high_part: i32) -> String {
    format!("luid_0x{:08x}_0x{:08x}", high_part as u32, low_part)
}

#[cfg(target_os = "windows")]
fn windows_utf16_array_to_string(value: &[u16]) -> Option<String> {
    let end = value
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(value.len());
    let label = String::from_utf16_lossy(&value[..end]).trim().to_string();
    if label.is_empty() {
        None
    } else {
        Some(label)
    }
}

#[cfg(target_os = "windows")]
fn collect_windows_pdh_counter_array(
    counter_path: &str,
    format: WindowsPdhCounterFormat,
) -> std::result::Result<Vec<WindowsPdhCounterSample>, String> {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt, ptr, thread, time::Duration};
    use windows_sys::Win32::{
        Foundation::ERROR_SUCCESS,
        System::Performance::{
            PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData,
            PdhGetFormattedCounterArrayW, PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W,
            PDH_FMT_DOUBLE, PDH_FMT_LARGE, PDH_HCOUNTER, PDH_HQUERY, PDH_INVALID_DATA,
            PDH_MORE_DATA,
        },
    };

    struct Query(PDH_HQUERY);
    impl Drop for Query {
        fn drop(&mut self) {
            unsafe {
                PdhCloseQuery(self.0);
            }
        }
    }

    let mut query: PDH_HQUERY = ptr::null_mut();
    let status = unsafe { PdhOpenQueryW(ptr::null(), 0, &mut query) };
    if status != ERROR_SUCCESS {
        return Err(format!("Windows PDH open query failed: 0x{status:08x}"));
    }
    let query = Query(query);

    let mut counter: PDH_HCOUNTER = ptr::null_mut();
    let wide_path: Vec<u16> = OsStr::new(counter_path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let status = unsafe { PdhAddEnglishCounterW(query.0, wide_path.as_ptr(), 0, &mut counter) };
    if status != ERROR_SUCCESS {
        return Err(format!(
            "Windows PDH add counter {counter_path} failed: 0x{status:08x}"
        ));
    }

    let first_status = unsafe { PdhCollectQueryData(query.0) };
    if first_status != ERROR_SUCCESS && first_status != PDH_INVALID_DATA {
        return Err(format!(
            "Windows PDH first collection failed for {counter_path}: 0x{first_status:08x}"
        ));
    }
    thread::sleep(Duration::from_millis(120));
    let status = unsafe { PdhCollectQueryData(query.0) };
    if status != ERROR_SUCCESS {
        return Err(format!(
            "Windows PDH collection failed for {counter_path}: 0x{status:08x}"
        ));
    }

    let pdh_format = match format {
        WindowsPdhCounterFormat::Double => PDH_FMT_DOUBLE,
        WindowsPdhCounterFormat::Large => PDH_FMT_LARGE,
    };
    let mut buffer_size = 0_u32;
    let mut item_count = 0_u32;
    let status = unsafe {
        PdhGetFormattedCounterArrayW(
            counter,
            pdh_format,
            &mut buffer_size,
            &mut item_count,
            ptr::null_mut(),
        )
    };
    if status != PDH_MORE_DATA {
        return Err(format!(
            "Windows PDH counter array sizing failed for {counter_path}: 0x{status:08x}"
        ));
    }

    let item_size = std::mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>();
    let item_capacity = (buffer_size as usize + item_size - 1) / item_size;
    let mut items = vec![PDH_FMT_COUNTERVALUE_ITEM_W::default(); item_capacity];
    let status = unsafe {
        PdhGetFormattedCounterArrayW(
            counter,
            pdh_format,
            &mut buffer_size,
            &mut item_count,
            items.as_mut_ptr(),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!(
            "Windows PDH counter array read failed for {counter_path}: 0x{status:08x}"
        ));
    }

    let mut samples = Vec::new();
    for item in items.into_iter().take(item_count as usize) {
        let instance = wide_ptr_to_string(item.szName);
        if instance.is_empty() {
            continue;
        }
        let c_status = item.FmtValue.CStatus;
        if c_status != ERROR_SUCCESS {
            continue;
        }
        let sample = match format {
            WindowsPdhCounterFormat::Double => WindowsPdhCounterSample {
                instance,
                double_value: Some(unsafe { item.FmtValue.Anonymous.doubleValue }),
                large_value: None,
            },
            WindowsPdhCounterFormat::Large => WindowsPdhCounterSample {
                instance,
                double_value: None,
                large_value: Some(unsafe { item.FmtValue.Anonymous.largeValue }),
            },
        };
        samples.push(sample);
    }

    Ok(samples)
}

#[cfg(target_os = "windows")]
fn wide_ptr_to_string(value: windows_sys::core::PCWSTR) -> String {
    if value.is_null() {
        return String::new();
    }
    let mut len = 0_usize;
    unsafe {
        while *value.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(value, len))
    }
}

fn normalize_gpu_devices_metric(devices: Vec<LocalGpuDeviceMetric>) -> LocalResourceMetric {
    let used = devices
        .iter()
        .fold(0_u64, |sum, gpu| sum.saturating_add(gpu.memory_used));
    let total = devices
        .iter()
        .fold(0_u64, |sum, gpu| sum.saturating_add(gpu.memory_total));
    let compute_percent =
        devices.iter().map(|gpu| gpu.compute_percent).sum::<f64>() / devices.len() as f64;

    LocalResourceMetric {
        kind: LocalResourceMetricKind::Gpu,
        availability: LocalResourceMetricAvailability::Available {
            used,
            total,
            percent: normalize_percent(compute_percent),
            available: None,
            free: Some(total.saturating_sub(used)),
            details: LocalResourceMetricDetails::GpuDevices(devices),
        },
    }
}

fn gpu_unavailable_metric(reason: impl Into<String>) -> LocalResourceMetric {
    unavailable_metric(LocalResourceMetricKind::Gpu, reason)
}

fn unavailable_metric(
    kind: LocalResourceMetricKind,
    reason: impl Into<String>,
) -> LocalResourceMetric {
    LocalResourceMetric {
        kind,
        availability: LocalResourceMetricAvailability::Unavailable {
            reason: reason.into(),
        },
    }
}

pub fn helper_target_unknown_metric(kind: LocalResourceMetricKind) -> LocalResourceMetric {
    unavailable_metric(kind, "Target OS/architecture unknown")
}

fn parse_unix_os(value: &str) -> Option<RemoteResourceTargetOs> {
    match value.trim().to_ascii_lowercase().as_str() {
        "linux" => Some(RemoteResourceTargetOs::Linux),
        "darwin" => Some(RemoteResourceTargetOs::Macos),
        _ => None,
    }
}

fn parse_target_arch(value: &str) -> Option<RemoteResourceTargetArch> {
    match value.trim().to_ascii_lowercase().as_str() {
        "x86_64" | "amd64" => Some(RemoteResourceTargetArch::X86_64),
        "aarch64" | "arm64" => Some(RemoteResourceTargetArch::Aarch64),
        "armv7" | "armv7l" => Some(RemoteResourceTargetArch::Armv7),
        "i386" | "i686" | "x86" => Some(RemoteResourceTargetArch::I686),
        _ => None,
    }
}

fn unsupported_target() -> RemoteResourceTargetDetection {
    RemoteResourceTargetDetection::Unknown {
        reason: "Unsupported remote target OS or architecture".to_string(),
        requires_user_choice: true,
    }
}

fn parse_u64_field(value: Option<&&str>, label: &str) -> Result<u64> {
    let Some(value) = value else {
        return Err(invalid_error(format!("{label} is missing")));
    };
    value
        .parse::<u64>()
        .map_err(|error| invalid_error(format!("{label} is invalid: {error}")))
}

fn parse_f64_field(value: Option<&&str>, label: &str) -> Result<f64> {
    let Some(value) = value else {
        return Err(invalid_error(format!("{label} is missing")));
    };
    let parsed = value
        .parse::<f64>()
        .map_err(|error| invalid_error(format!("{label} is invalid: {error}")))?;
    if !parsed.is_finite() {
        return Err(invalid_error(format!("{label} must be finite")));
    }
    Ok(parsed)
}

fn normalize_percent(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 100.0)
    } else {
        0.0
    }
}

fn metric_name(kind: LocalResourceMetricKind) -> &'static str {
    match kind {
        LocalResourceMetricKind::Cpu => "cpu",
        LocalResourceMetricKind::Memory => "memory",
        LocalResourceMetricKind::Swap => "swap",
        LocalResourceMetricKind::Gpu => "gpu",
    }
}

pub fn local_resource_provider_descriptor_for_test() -> LocalResourceProviderDescriptor {
    local_resource_provider_descriptor()
}

pub fn build_info_for_test() -> NocturneBuildInfo {
    build_info()
}

pub fn helper_asset_name_for_test(
    tag: &str,
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
) -> String {
    helper_asset_name(tag, target_os, target_arch)
}

pub fn helper_download_plan_for_test(
    github_repository: &str,
    build_tag: Option<&str>,
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
) -> Option<ResourceHelperDownloadPlan> {
    helper_download_plan(github_repository, build_tag, target_os, target_arch)
}

pub fn load_resource_helper_bytes_from_path_for_test(
    path: &Path,
    github_repository: &str,
    build_tag: Option<&str>,
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
) -> Result<ResourceHelperBytesSource> {
    load_resource_helper_bytes_from_path(path, github_repository, build_tag, target_os, target_arch)
}

pub fn load_resource_helper_bytes_from_paths_for_test(
    paths: &[PathBuf],
    github_repository: &str,
    build_tag: Option<&str>,
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
) -> Result<ResourceHelperBytesSource> {
    load_resource_helper_bytes_from_paths(
        paths,
        github_repository,
        build_tag,
        target_os,
        target_arch,
    )
}

pub fn resource_helper_candidate_paths_for_test(
    resource_dir: &Path,
    resource_path: &str,
) -> Vec<PathBuf> {
    resource_helper_candidate_paths(resource_dir, resource_path)
}

pub fn normalize_cpu_metric_for_test(
    overall_percent: f64,
    core_percents: Vec<f64>,
) -> LocalResourceMetric {
    normalize_cpu_metric(overall_percent, core_percents)
}

pub fn normalize_memory_metric_for_test(
    kind: LocalResourceMetricKind,
    used: u64,
    total: u64,
    available: Option<u64>,
    free: Option<u64>,
) -> LocalResourceMetric {
    normalize_memory_metric(kind, used, total, available, free)
}

pub fn gpu_unavailable_metric_for_test(reason: impl Into<String>) -> LocalResourceMetric {
    gpu_unavailable_metric(reason)
}

pub fn remote_system_command_plan_for_test(
    target_os: RemoteResourceTargetOs,
) -> RemoteSystemCommandPlan {
    remote_system_command_plan(target_os)
}

pub fn remote_system_provider_runs_off_command_thread_for_test() -> bool {
    remote_system_provider_runs_off_command_thread()
}

pub fn parse_linux_free_b_for_test(output: &str) -> Result<Vec<LocalResourceMetric>> {
    parse_linux_free_b(output)
}

pub fn parse_linux_proc_stat_cpu_for_test(output: &str) -> Result<LocalResourceMetric> {
    parse_linux_proc_stat_cpu(output)
}

pub fn parse_linux_nvidia_smi_csv_for_test(output: &str) -> Result<LocalResourceMetric> {
    parse_linux_nvidia_smi_csv(output)
}

pub fn parse_macos_memory_for_test(
    total_memory: u64,
    available_memory: u64,
    swap_total: u64,
    swap_used: u64,
) -> Vec<LocalResourceMetric> {
    parse_macos_memory(total_memory, available_memory, swap_total, swap_used)
}

pub fn parse_windows_memory_for_test(
    total_memory: u64,
    free_memory: u64,
    swap: Option<(u64, u64)>,
) -> Vec<LocalResourceMetric> {
    parse_windows_memory(total_memory, free_memory, swap)
}

pub fn resolve_resource_target_for_test(
    host_config: Option<HostResourceConfig>,
    uname_output: Option<(&str, &str)>,
) -> RemoteResourceTargetDetection {
    resolve_resource_target(host_config, uname_output)
}

pub fn parse_remote_uname_for_test(
    os_output: &str,
    arch_output: &str,
) -> RemoteResourceTargetDetection {
    parse_remote_uname(os_output, arch_output)
}

pub fn parse_remote_windows_platform_for_test(
    os_output: &str,
    arch_output: &str,
) -> RemoteResourceTargetDetection {
    parse_remote_windows_platform(os_output, arch_output)
}

pub fn helper_target_unknown_metric_for_test(kind: LocalResourceMetricKind) -> LocalResourceMetric {
    helper_target_unknown_metric(kind)
}

pub fn collect_linux_drm_gpu_metric_from_root_for_test(sys_root: &Path) -> LocalResourceMetric {
    collect_linux_drm_gpu_metric_from_root(sys_root)
}

pub fn normalize_windows_gpu_pdh_samples_for_test(
    samples: Vec<WindowsGpuPdhSample>,
    adapters: Vec<WindowsGpuAdapterInfo>,
) -> LocalResourceMetric {
    normalize_windows_gpu_pdh_samples(samples, adapters)
}

pub fn parse_resource_monitor_agent_ndjson_for_test(
    input: &str,
) -> Result<Vec<ResourceMonitorAgentEvent>> {
    parse_resource_monitor_agent_ndjson(input)
}

pub fn normalize_resource_monitor_agent_metric_for_test(
    metric: ResourceMonitorAgentMetric,
) -> Result<LocalResourceMetric> {
    normalize_resource_monitor_agent_metric(metric)
}

pub fn decide_resource_helper_deployment_for_test(
    policy: ResourceHelperPolicy,
    status: ResourceHelperDeploymentStatus,
    host_id: &str,
    host_label: &str,
    manifest: ResourceHelperManifest,
) -> ResourceHelperDeploymentDecision {
    decide_resource_helper_deployment(policy, status, host_id, host_label, manifest)
}

pub fn resource_helper_resource_path_for_test(
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
) -> String {
    resource_helper_resource_path(target_os, target_arch)
}

pub fn plan_resource_helper_upload_for_test(
    helper_bytes: &[u8],
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
    version: &str,
) -> Result<ResourceHelperUploadPlan> {
    plan_resource_helper_upload(helper_bytes, target_os, target_arch, version)
}
