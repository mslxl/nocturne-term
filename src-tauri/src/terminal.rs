use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    env, fs,
    io::{BufRead, BufReader, ErrorKind, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use sha2::Digest;
use ssh2::{Channel, FileStat, HashType, HostKeyType, OpenFlags, OpenType, Session, Sftp};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::{
    config::{
        connection_host_by_id, effective_application_config, effective_terminal_agent_mode,
        resolve_openssh_proxy_jump_chain, ssh_known_hosts_path,
    },
    error::{
        invalid_error, missing_error, ssh_workspace_challenge_error, terminal_error, ConfigError,
        Result,
    },
    files::{
        connect_sftp_for_host, run_remote_command, shell_quote, SftpAuthScope, SftpConnection,
    },
    resources::{
        build_info, detect_remote_resource_target, ResourceHelperBytesSource,
        ResourceHelperDownloadPlan, ResourceHelperManifest, ResourceHelperPolicy,
        ResourceHelperUploadPlan,
    },
    ssh_trust::{ssh_trust_target, SshTrustStore},
    terminal_schemes::{
        builtin_dark_scheme, builtin_light_scheme, scheme_to_terminal_theme,
        terminal_color_scheme_by_id,
    },
    types::{
        AttachDetachedTerminalSessionInput, ConnectionDiagnosticSeverity, ConnectionHostEntry,
        ConnectionHostSource, ConnectionProtocol, CreateHostTerminalSessionInput,
        DeleteDetachedTerminalSessionInput, DetachedTerminalSessionsInput,
        ExistingTerminalSessionInput, LocalConnectionConfig,
        OpenDetachedTerminalSessionHistoryInput, RemoteResourceTargetArch, RemoteResourceTargetOs,
        RenameDetachedTerminalSessionInput,
        SshAuthTarget, SshConnectionConfig, SshCredentialChallenge, SshCredentialInput,
        SshCredentialKind, SshHostKeyChallenge, SshHostKeyChallengeKind, SshHostScopedChallenge,
        SshWorkspaceChallenge, TabBarOrientation, TerminalAgentMode, TerminalAgentSessionInfo,
        TerminalColorSchemeVariant, TerminalCursorStyle, TerminalDetachInput,
        TerminalDetachedSessionInfo, TerminalExitEvent, TerminalInput, TerminalOutputBacklogInput,
        TerminalOutputEvent, TerminalPadding, TerminalRenderer, TerminalSessionInfo,
        TerminalSessionOwnershipInput, TerminalSettings, TerminalSettingsInput, TerminalSizeInput,
        TerminalTheme, TerminalTitleInput, TerminalTransportKind, TerminalTransportState,
        TerminalTransportStateEvent, WorkspaceSshVerificationResponse,
    },
    workspace,
    workspace_ssh::{
        connection_host_auth_target, proxy_jump_auth_target, read_ssh_secret_from_keyring,
        workspace_ssh_coordinator, write_ssh_secret_to_keyring, WorkspaceCredentialKey,
    },
};

const TERMINAL_OUTPUT_EVENT: &str = "terminal://output";
const TERMINAL_EXIT_EVENT: &str = "terminal://exit";
const TERMINAL_TRANSPORT_STATE_EVENT: &str = "terminal://transport-state";
const OUTPUT_BACKLOG_LIMIT: usize = 512 * 1024;
const SSH_PENDING_WRITE_LIMIT: usize = 1024 * 1024;
const SSH_WRITE_CHUNK_LIMIT: usize = 8192;
const DEFAULT_TERMINAL_FONT_FAMILY: &str =
    "\"Maple Mono\", \"Symbols Nerd Font Mono\", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
const TERMINAL_AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const TERMINAL_AGENT_GITHUB_REPOSITORY: &str = "mslxl/nocturne-term";
const TERMINAL_AGENT_HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

struct TerminalSession {
    backend: Mutex<TerminalBackend>,
    info: Mutex<TerminalSessionInfo>,
    host_id: String,
    reader_token: String,
    window_label: Mutex<String>,
    output_backlog: Mutex<Vec<u8>>,
    output_sequence: Mutex<u64>,
    output_backlog_start_sequence: Mutex<u64>,
}

enum TerminalBackend {
    Local {
        master: Box<dyn MasterPty + Send>,
        writer: Box<dyn Write + Send>,
        killer: Box<dyn ChildKiller + Send + Sync>,
    },
    Ssh {
        commands: Sender<SshWorkerCommand>,
    },
    Agent {
        session_id: String,
        helper_path: String,
        agent_process: Option<std::process::Child>,
        local_control: Option<Sender<LocalAgentControlCommand>>,
        remote: Option<RemoteAgentBackend>,
    },
    AgentHistory {
        registry_session_id: String,
    },
}

struct DetachedTerminalRecord {
    host_id: String,
    info: TerminalDetachedSessionInfo,
    session_info: TerminalSessionInfo,
    session_id: String,
    helper_path: String,
    agent_process: Option<std::process::Child>,
    remote: Option<RemoteAgentRuntime>,
}

#[derive(Clone)]
struct RemoteAgentBackend {
    commands: Sender<RemoteAgentCommand>,
    live_control: Arc<Mutex<Option<Sender<LocalAgentControlCommand>>>>,
    runtime: Arc<Mutex<Option<RemoteAgentRuntime>>>,
}

#[derive(Clone)]
struct RemoteAgentRuntime {
    helper_path: String,
    target_os: RemoteResourceTargetOs,
    agent_session_id: String,
    worker_input: SshWorkerInput,
}

struct PreparedRemoteTerminalAgent {
    runtime: RemoteAgentRuntime,
    connection: SftpConnection,
}

enum RemoteAgentCommand {
    Write(Vec<u8>, Sender<Result<TerminalAgentResponse>>),
    Resize(PtySize, Sender<Result<TerminalAgentResponse>>),
    TitleChange(String, Sender<Result<TerminalAgentResponse>>),
    Close(Sender<Result<TerminalAgentResponse>>),
    CloseView(Sender<Result<TerminalAgentResponse>>),
    Detach(Sender<Result<TerminalAgentResponse>>),
    Delete(Sender<Result<TerminalAgentResponse>>),
}

struct LocalAgentControlCommand {
    request: AgentProtocolRequest,
    response: Sender<Result<TerminalAgentResponse>>,
}

#[derive(serde::Serialize)]
struct AgentProtocolRequest {
    #[serde(rename = "type")]
    kind: &'static str,
    request_id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
enum TerminalAgentResponse {
    Ok,
    Error { message: String },
}

enum LocalGoAgentLaunchStatus {
    Running,
    Exited(GoAgentListedSession),
}

enum SshWorkerCommand {
    Write(Vec<u8>),
    Resize(PtySize),
    Close,
}

enum SshPumpAction {
    Continue,
    Closed,
}

#[derive(Default)]
struct TerminalState {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<String, Arc<TerminalSession>>>,
    detached_sessions: Mutex<HashMap<String, DetachedTerminalRecord>>,
    agent_view_sizes: Mutex<HashMap<String, HashMap<String, PtySize>>>,
}

static TERMINAL_STATE: OnceLock<Arc<TerminalState>> = OnceLock::new();

fn terminal_state() -> Arc<TerminalState> {
    TERMINAL_STATE
        .get_or_init(|| Arc::new(TerminalState::default()))
        .clone()
}

fn default_terminal_theme() -> TerminalTheme {
    scheme_to_terminal_theme(&builtin_dark_scheme())
}

fn builtin_terminal_theme_for_variant(variant: TerminalColorSchemeVariant) -> TerminalTheme {
    match variant {
        TerminalColorSchemeVariant::Light => scheme_to_terminal_theme(&builtin_light_scheme()),
        TerminalColorSchemeVariant::Dark => scheme_to_terminal_theme(&builtin_dark_scheme()),
    }
}

impl Default for TerminalPadding {
    fn default() -> Self {
        Self {
            top: 8.0,
            right: 10.0,
            bottom: 8.0,
            left: 10.0,
        }
    }
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            command: None,
            args: Vec::new(),
            cwd: None,
            font_family: DEFAULT_TERMINAL_FONT_FAMILY.to_string(),
            font_size: 13.0,
            scrollback: 10_000,
            renderer: TerminalRenderer::Dom,
            cursor_blink: true,
            cursor_style: TerminalCursorStyle::Block,
            theme: default_terminal_theme(),
            padding: TerminalPadding::default(),
            tab_bar_orientation: TabBarOrientation::Horizontal,
        }
    }
}

fn terminal_table(config: &toml::Value) -> Result<Option<&toml::Table>> {
    let root = match config {
        toml::Value::Table(table) => table,
        _ => return Err(invalid_error("effective config must be a TOML table")),
    };
    match root.get("terminal") {
        Some(toml::Value::Table(table)) => Ok(Some(table)),
        Some(_) => Err(invalid_error("terminal config must be a table")),
        None => Ok(None),
    }
}

fn optional_string(table: &toml::Table, key: &str) -> Result<Option<String>> {
    match table.get(key) {
        Some(toml::Value::String(value)) if !value.trim().is_empty() => Ok(Some(value.clone())),
        Some(toml::Value::String(_)) => {
            Err(invalid_error(format!("terminal.{key} cannot be empty")))
        }
        Some(_) => Err(invalid_error(format!("terminal.{key} must be a string"))),
        None => Ok(None),
    }
}

fn optional_bool(table: &toml::Table, key: &str) -> Result<Option<bool>> {
    match table.get(key) {
        Some(toml::Value::Boolean(value)) => Ok(Some(*value)),
        Some(_) => Err(invalid_error(format!("terminal.{key} must be a boolean"))),
        None => Ok(None),
    }
}

fn optional_string_array(table: &toml::Table, key: &str) -> Result<Option<Vec<String>>> {
    match table.get(key) {
        Some(toml::Value::Array(values)) => values
            .iter()
            .map(|value| match value {
                toml::Value::String(item) => Ok(item.clone()),
                _ => Err(invalid_error(format!(
                    "terminal.{key} must contain only strings"
                ))),
            })
            .collect::<Result<Vec<_>>>()
            .map(Some),
        Some(_) => Err(invalid_error(format!(
            "terminal.{key} must be an array of strings"
        ))),
        None => Ok(None),
    }
}

fn optional_positive_u32(table: &toml::Table, key: &str) -> Result<Option<u32>> {
    match table.get(key) {
        Some(toml::Value::Integer(value)) if *value > 0 && *value <= u32::MAX as i64 => {
            Ok(Some(*value as u32))
        }
        Some(toml::Value::Integer(_)) => Err(invalid_error(format!(
            "terminal.{key} must be a positive 32-bit integer"
        ))),
        Some(_) => Err(invalid_error(format!("terminal.{key} must be an integer"))),
        None => Ok(None),
    }
}

fn optional_positive_f64(table: &toml::Table, key: &str) -> Result<Option<f64>> {
    match table.get(key) {
        Some(toml::Value::Integer(value)) if *value > 0 => Ok(Some(*value as f64)),
        Some(toml::Value::Float(value)) if value.is_finite() && *value > 0.0 => Ok(Some(*value)),
        Some(toml::Value::Integer(_) | toml::Value::Float(_)) => {
            Err(invalid_error(format!("terminal.{key} must be positive")))
        }
        Some(_) => Err(invalid_error(format!("terminal.{key} must be a number"))),
        None => Ok(None),
    }
}

fn optional_non_negative_f64(table: &toml::Table, key: &str) -> Result<Option<f64>> {
    match table.get(key) {
        Some(toml::Value::Integer(value)) if *value >= 0 => Ok(Some(*value as f64)),
        Some(toml::Value::Float(value)) if value.is_finite() && *value >= 0.0 => Ok(Some(*value)),
        Some(toml::Value::Integer(_) | toml::Value::Float(_)) => Err(invalid_error(format!(
            "terminal.{key} must be non-negative"
        ))),
        Some(_) => Err(invalid_error(format!("terminal.{key} must be a number"))),
        None => Ok(None),
    }
}

fn optional_string_map(table: &toml::Table, key: &str) -> Result<Option<BTreeMap<String, String>>> {
    match table.get(key) {
        Some(toml::Value::Table(values)) => values
            .iter()
            .map(|(name, value)| match value {
                toml::Value::String(item) => Ok((name.clone(), item.clone())),
                _ => Err(invalid_error(format!(
                    "terminal.{key}.{name} must be a string"
                ))),
            })
            .collect::<Result<BTreeMap<_, _>>>()
            .map(Some),
        Some(_) => Err(invalid_error(format!("terminal.{key} must be a table"))),
        None => Ok(None),
    }
}

fn padding_value(values: &toml::Table, key: &str) -> Result<Option<f64>> {
    match values.get(key) {
        Some(toml::Value::Integer(value)) if *value >= 0 => Ok(Some(*value as f64)),
        Some(toml::Value::Float(value)) if value.is_finite() && *value >= 0.0 => Ok(Some(*value)),
        Some(toml::Value::Integer(_) | toml::Value::Float(_)) => Err(invalid_error(format!(
            "terminal.padding.{key} must be non-negative"
        ))),
        Some(_) => Err(invalid_error(format!(
            "terminal.padding.{key} must be a number"
        ))),
        None => Ok(None),
    }
}

fn apply_padding_config(padding: &mut TerminalPadding, table: &toml::Table) -> Result<()> {
    let Some(value) = table.get("padding") else {
        return Ok(());
    };
    let toml::Value::Table(values) = value else {
        let Some(all) = optional_non_negative_f64(table, "padding")? else {
            return Ok(());
        };
        padding.top = all;
        padding.right = all;
        padding.bottom = all;
        padding.left = all;
        return Ok(());
    };

    if let Some(horizontal) = padding_value(values, "horizontal")? {
        padding.left = horizontal;
        padding.right = horizontal;
    }
    if let Some(vertical) = padding_value(values, "vertical")? {
        padding.top = vertical;
        padding.bottom = vertical;
    }
    if let Some(top) = padding_value(values, "top")? {
        padding.top = top;
    }
    if let Some(right) = padding_value(values, "right")? {
        padding.right = right;
    }
    if let Some(bottom) = padding_value(values, "bottom")? {
        padding.bottom = bottom;
    }
    if let Some(left) = padding_value(values, "left")? {
        padding.left = left;
    }
    Ok(())
}

fn parse_renderer(value: &str) -> Result<TerminalRenderer> {
    match value {
        "dom" => Ok(TerminalRenderer::Dom),
        "webgl" => Ok(TerminalRenderer::Webgl),
        _ => Err(invalid_error("terminal.renderer must be dom or webgl")),
    }
}

fn parse_cursor_style(value: &str) -> Result<TerminalCursorStyle> {
    match value {
        "block" => Ok(TerminalCursorStyle::Block),
        "underline" => Ok(TerminalCursorStyle::Underline),
        "bar" => Ok(TerminalCursorStyle::Bar),
        _ => Err(invalid_error(
            "terminal.cursor_style must be block, underline, or bar",
        )),
    }
}

fn parse_tab_bar_orientation(value: &str) -> Result<TabBarOrientation> {
    match value {
        "horizontal" => Ok(TabBarOrientation::Horizontal),
        "vertical" | "vertical_right" => Ok(TabBarOrientation::VerticalRight),
        "vertical_left" => Ok(TabBarOrientation::VerticalLeft),
        _ => Err(invalid_error(
            "terminal.tab_bar_orientation must be horizontal, vertical_left, or vertical_right",
        )),
    }
}

fn apply_theme_config(theme: &mut TerminalTheme, table: &toml::Table) -> Result<()> {
    let Some(toml::Value::Table(values)) = table.get("theme") else {
        if table.contains_key("theme") {
            return Err(invalid_error("terminal.theme must be a table"));
        }
        return Ok(());
    };

    macro_rules! set_color {
        ($key:literal, $field:ident) => {
            if let Some(value) = values.get($key) {
                match value {
                    toml::Value::String(color) if is_css_color_like(color) => {
                        theme.$field = color.clone();
                    }
                    toml::Value::String(_) => {
                        return Err(invalid_error(format!(
                            "terminal.theme.{} must be a CSS hex color",
                            $key
                        )));
                    }
                    _ => {
                        return Err(invalid_error(format!(
                            "terminal.theme.{} must be a string",
                            $key
                        )));
                    }
                }
            }
        };
    }

    set_color!("background", background);
    set_color!("foreground", foreground);
    set_color!("cursor", cursor);
    set_color!("selection_background", selection_background);
    set_color!("black", black);
    set_color!("red", red);
    set_color!("green", green);
    set_color!("yellow", yellow);
    set_color!("blue", blue);
    set_color!("magenta", magenta);
    set_color!("cyan", cyan);
    set_color!("white", white);
    set_color!("bright_black", bright_black);
    set_color!("bright_red", bright_red);
    set_color!("bright_green", bright_green);
    set_color!("bright_yellow", bright_yellow);
    set_color!("bright_blue", bright_blue);
    set_color!("bright_magenta", bright_magenta);
    set_color!("bright_cyan", bright_cyan);
    set_color!("bright_white", bright_white);
    Ok(())
}

fn apply_legacy_theme_config(theme: &mut TerminalTheme, table: &toml::Table) -> Result<()> {
    apply_theme_config(theme, table)
}

fn parse_color_scheme_map(table: &toml::Table) -> Result<(Option<String>, Option<String>)> {
    let Some(toml::Value::Table(values)) = table.get("color_scheme") else {
        if table.contains_key("color_scheme") {
            return Err(invalid_error("terminal.color_scheme must be a table"));
        }
        return Ok((None, None));
    };

    let light = match values.get("light") {
        Some(toml::Value::String(value)) if !value.trim().is_empty() => Some(value.clone()),
        Some(toml::Value::String(_)) => {
            return Err(invalid_error("terminal.color_scheme.light cannot be empty"));
        }
        Some(_) => {
            return Err(invalid_error(
                "terminal.color_scheme.light must be a string",
            ))
        }
        None => None,
    };
    let dark = match values.get("dark") {
        Some(toml::Value::String(value)) if !value.trim().is_empty() => Some(value.clone()),
        Some(toml::Value::String(_)) => {
            return Err(invalid_error("terminal.color_scheme.dark cannot be empty"));
        }
        Some(_) => return Err(invalid_error("terminal.color_scheme.dark must be a string")),
        None => None,
    };
    Ok((light, dark))
}

fn is_css_color_like(value: &str) -> bool {
    let hex = value.strip_prefix('#');
    matches!(hex.map(str::len), Some(3 | 6 | 8))
        && hex
            .map(|text| text.chars().all(|item| item.is_ascii_hexdigit()))
            .unwrap_or(false)
}

fn terminal_settings_from_config(
    app: &AppHandle,
    config: &toml::Value,
    resolved_theme: Option<TerminalColorSchemeVariant>,
) -> Result<TerminalSettings> {
    let mut settings = TerminalSettings::default();
    if let Some(theme_variant) = resolved_theme.clone() {
        settings.theme = builtin_terminal_theme_for_variant(theme_variant);
    }
    let Some(table) = terminal_table(config)? else {
        return Ok(settings);
    };

    settings.command = optional_string(table, "command")?;
    settings.args = optional_string_array(table, "args")?.unwrap_or_default();
    settings.cwd = optional_string(table, "cwd")?;
    if settings.command.is_none() && !settings.args.is_empty() {
        return Err(invalid_error(
            "terminal.args requires terminal.command because default system commands cannot accept configured args",
        ));
    }
    if let Some(font_family) = optional_string(table, "font_family")? {
        settings.font_family = font_family;
    }
    if let Some(font_size) = optional_positive_f64(table, "font_size")? {
        settings.font_size = font_size;
    }
    if let Some(scrollback) = optional_positive_u32(table, "scrollback")? {
        settings.scrollback = scrollback;
    }
    if let Some(renderer) = optional_string(table, "renderer")? {
        settings.renderer = parse_renderer(&renderer)?;
    }
    if let Some(cursor_blink) = optional_bool(table, "cursor_blink")? {
        settings.cursor_blink = cursor_blink;
    }
    if let Some(cursor_style) = optional_string(table, "cursor_style")? {
        settings.cursor_style = parse_cursor_style(&cursor_style)?;
    }
    if let Some(orientation) = optional_string(table, "tab_bar_orientation")? {
        settings.tab_bar_orientation = parse_tab_bar_orientation(&orientation)?;
    }
    let (light_scheme, dark_scheme) = parse_color_scheme_map(table)?;
    if let Some(theme_variant) = resolved_theme {
        let theme_id = match theme_variant {
            TerminalColorSchemeVariant::Light => light_scheme,
            TerminalColorSchemeVariant::Dark => dark_scheme,
        };
        if let Some(theme_id) = theme_id {
            let scheme = terminal_color_scheme_by_id(app, &theme_id)?.scheme;
            settings.theme = scheme_to_terminal_theme(&scheme);
        } else {
            settings.theme = builtin_terminal_theme_for_variant(theme_variant);
            apply_theme_config(&mut settings.theme, table)?;
        }
    } else {
        apply_legacy_theme_config(&mut settings.theme, table)?;
    }
    apply_padding_config(&mut settings.padding, table)?;
    Ok(settings)
}

#[cfg(test)]
fn terminal_settings_from_config_for_test(config: &toml::Value) -> Result<TerminalSettings> {
    terminal_settings_from_config_without_scheme_lookup(config, None)
}

#[cfg(test)]
fn terminal_settings_from_config_without_scheme_lookup(
    config: &toml::Value,
    resolved_theme: Option<TerminalColorSchemeVariant>,
) -> Result<TerminalSettings> {
    let mut settings = TerminalSettings::default();
    if let Some(theme_variant) = resolved_theme.clone() {
        settings.theme = builtin_terminal_theme_for_variant(theme_variant);
    }
    let Some(table) = terminal_table(config)? else {
        return Ok(settings);
    };

    settings.command = optional_string(table, "command")?;
    settings.args = optional_string_array(table, "args")?.unwrap_or_default();
    settings.cwd = optional_string(table, "cwd")?;
    if settings.command.is_none() && !settings.args.is_empty() {
        return Err(invalid_error(
            "terminal.args requires terminal.command because default system commands cannot accept configured args",
        ));
    }
    if let Some(font_family) = optional_string(table, "font_family")? {
        settings.font_family = font_family;
    }
    if let Some(font_size) = optional_positive_f64(table, "font_size")? {
        settings.font_size = font_size;
    }
    if let Some(scrollback) = optional_positive_u32(table, "scrollback")? {
        settings.scrollback = scrollback;
    }
    if let Some(renderer) = optional_string(table, "renderer")? {
        settings.renderer = parse_renderer(&renderer)?;
    }
    if let Some(cursor_blink) = optional_bool(table, "cursor_blink")? {
        settings.cursor_blink = cursor_blink;
    }
    if let Some(cursor_style) = optional_string(table, "cursor_style")? {
        settings.cursor_style = parse_cursor_style(&cursor_style)?;
    }
    if let Some(orientation) = optional_string(table, "tab_bar_orientation")? {
        settings.tab_bar_orientation = parse_tab_bar_orientation(&orientation)?;
    }
    if let Some(theme_variant) = resolved_theme {
        settings.theme = builtin_terminal_theme_for_variant(theme_variant);
    }
    apply_theme_config(&mut settings.theme, table)?;
    apply_padding_config(&mut settings.padding, table)?;
    Ok(settings)
}

fn terminal_env_from_config(config: &toml::Value) -> Result<BTreeMap<String, String>> {
    let Some(table) = terminal_table(config)? else {
        return Ok(BTreeMap::new());
    };
    optional_string_map(table, "env").map(Option::unwrap_or_default)
}

fn apply_local_host_config(settings: &mut TerminalSettings, local: &LocalConnectionConfig) {
    if let Some(command) = &local.command {
        settings.command = Some(command.clone());
        settings.args = local.args.clone();
    }
    if let Some(cwd) = &local.cwd {
        settings.cwd = Some(expand_terminal_home(cwd));
    }
}

fn validated_pty_size(
    cols: u16,
    rows: u16,
    pixel_width: u16,
    pixel_height: u16,
) -> Result<PtySize> {
    if !(2..=500).contains(&cols) {
        return Err(invalid_error("terminal cols must be between 2 and 500"));
    }
    if !(1..=300).contains(&rows) {
        return Err(invalid_error("terminal rows must be between 1 and 300"));
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width,
        pixel_height,
    })
}

fn build_terminal_command(
    settings: &TerminalSettings,
    cwd_override: Option<&str>,
    env_overrides: &BTreeMap<String, String>,
) -> CommandBuilder {
    let mut command = if let Some(program) = &settings.command {
        let mut command = CommandBuilder::new(program);
        command.args(settings.args.iter());
        command
    } else {
        CommandBuilder::new_default_prog()
    };
    if let Some(cwd) = cwd_override.or(settings.cwd.as_deref()) {
        command.cwd(cwd);
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "Nocturne");
    command.env("NOCTURNE", "1");
    command.env("NOCTURNE_IMAGE_PROTOCOL", "iip");
    command.env("ITERM_SESSION_ID", "nocturne");
    for (key, value) in env_overrides {
        command.env(key, value);
    }
    command
}

#[derive(Debug, Clone, serde::Serialize)]
struct GoTerminalAgentLaunchSpec {
    version: u32,
    session_id: String,
    host_id: String,
    title: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: BTreeMap<String, String>,
    cols: u16,
    rows: u16,
    pixel_width: u16,
    pixel_height: u16,
}

fn build_go_terminal_agent_launch_spec(
    session_id: &str,
    host_id: &str,
    title: &str,
    settings: &TerminalSettings,
    cwd_override: Option<&str>,
    env_overrides: &BTreeMap<String, String>,
    size: PtySize,
) -> GoTerminalAgentLaunchSpec {
    let (command, args) = if let Some(program) = &settings.command {
        (program.clone(), settings.args.clone())
    } else {
        (default_terminal_program(), Vec::new())
    };
    let mut env = BTreeMap::new();
    env.insert("TERM".to_string(), "xterm-256color".to_string());
    env.insert("COLORTERM".to_string(), "truecolor".to_string());
    env.insert("TERM_PROGRAM".to_string(), "Nocturne".to_string());
    env.insert("NOCTURNE".to_string(), "1".to_string());
    env.insert("NOCTURNE_IMAGE_PROTOCOL".to_string(), "iip".to_string());
    env.insert("ITERM_SESSION_ID".to_string(), "nocturne".to_string());
    env.extend(env_overrides.clone());
    GoTerminalAgentLaunchSpec {
        version: 1,
        session_id: session_id.to_string(),
        host_id: host_id.to_string(),
        title: title.to_string(),
        command,
        args,
        cwd: cwd_override
            .map(ToOwned::to_owned)
            .or_else(|| settings.cwd.clone()),
        env,
        cols: size.cols,
        rows: size.rows,
        pixel_width: size.pixel_width,
        pixel_height: size.pixel_height,
    }
}

#[derive(Debug, serde::Deserialize)]
struct GoAgentResponse {
    #[serde(rename = "type")]
    kind: String,
    request_id: Option<String>,
    ok: bool,
    error: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct GoAgentEvent {
    #[serde(rename = "type")]
    kind: String,
    event: Option<String>,
    data: Option<String>,
    exit: Option<GoAgentExitInfo>,
}

#[derive(Debug, serde::Deserialize)]
struct GoAgentExitInfo {
    code: Option<u32>,
    signal: Option<String>,
    reason: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct GoAgentListLine {
    #[serde(rename = "type")]
    kind: String,
    session: Option<GoAgentListedSession>,
    count: Option<usize>,
    error: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct GoAgentListedSession {
    session_id: String,
    host_id: String,
    title: String,
    command: String,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    pixel_width: Option<u16>,
    pixel_height: Option<u16>,
    status: String,
    attached_count: Option<u32>,
}

fn default_terminal_program() -> String {
    #[cfg(windows)]
    {
        env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
}

fn terminal_command_label(settings: &TerminalSettings) -> String {
    if let Some(command) = &settings.command {
        return command.clone();
    }
    #[cfg(windows)]
    {
        env::var("ComSpec").unwrap_or_else(|_| "System shell".to_string())
    }
    #[cfg(not(windows))]
    {
        env::var("SHELL").unwrap_or_else(|_| "System shell".to_string())
    }
}

fn remove_terminal_session(id: &str) {
    let state = terminal_state();
    if let Ok(mut sessions) = state.sessions.lock() {
        sessions.remove(id);
    };
    remove_agent_view_size(&state, id);
}

fn remove_agent_view_size(state: &TerminalState, view_session_id: &str) {
    let Ok(mut sizes) = state.agent_view_sizes.lock() else {
        return;
    };
    sizes.retain(|_, views| {
        views.remove(view_session_id);
        !views.is_empty()
    });
}

fn record_agent_view_size(
    state: &TerminalState,
    registry_session_id: &str,
    view_session_id: &str,
    size: PtySize,
) -> Result<PtySize> {
    let mut sizes = state
        .agent_view_sizes
        .lock()
        .map_err(|_| invalid_error("terminal agent view sizes lock poisoned"))?;
    let views = sizes
        .entry(registry_session_id.to_string())
        .or_insert_with(HashMap::new);
    views.insert(view_session_id.to_string(), size);
    Ok(minimum_agent_view_size(views.values()))
}

fn minimum_agent_view_size<'a>(sizes: impl Iterator<Item = &'a PtySize>) -> PtySize {
    let mut result = PtySize {
        rows: u16::MAX,
        cols: u16::MAX,
        pixel_width: u16::MAX,
        pixel_height: u16::MAX,
    };
    let mut saw_size = false;
    for size in sizes {
        saw_size = true;
        result.cols = result.cols.min(size.cols);
        result.rows = result.rows.min(size.rows);
        result.pixel_width = result.pixel_width.min(size.pixel_width);
        result.pixel_height = result.pixel_height.min(size.pixel_height);
    }
    if saw_size {
        result
    } else {
        PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        }
    }
}

fn next_terminal_session_id(state: &TerminalState) -> (u64, String) {
    let session_number = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    (session_number, new_terminal_session_id())
}

fn new_terminal_session_id() -> String {
    format!("term-{}", uuid::Uuid::new_v4().simple())
}

fn random_terminal_agent_session_title(session_id: &str) -> String {
    const ADJECTIVES: &[&str] = &[
        "Adamant",
        "Adept",
        "Arcadian",
        "Auspicious",
        "Brave",
        "Charming",
        "Considerate",
        "Curious",
        "Diligent",
        "Effulgent",
        "Erudite",
        "Excellent",
        "Fabulous",
        "Friendly",
        "Glowing",
        "Gracious",
        "Inventive",
        "Joyous",
        "Judicious",
        "Kind",
        "Likable",
        "Lucky",
        "Nautical",
        "Polished",
        "Profound",
        "Quiet",
        "Remarkable",
        "Sensible",
        "Sincere",
        "Sparkling",
        "Splendid",
        "Stellar",
        "Tenacious",
        "Unflappable",
        "Verdant",
        "Wise",
    ];
    const NOUNS: &[&str] = &[
        "Anchor",
        "Apple",
        "Apricot",
        "Beacon",
        "Bridge",
        "Cabbage",
        "Cipher",
        "Clover",
        "Compass",
        "Delta",
        "Forge",
        "Harbor",
        "Ledger",
        "Matrix",
        "Melody",
        "Orbit",
        "Pilot",
        "Quartz",
        "Signal",
        "Spark",
        "Summit",
        "Vector",
        "Vertex",
        "Voyage",
    ];
    let digest = sha2::Sha256::digest(session_id.as_bytes());
    let adjective = ADJECTIVES[usize::from(digest[0]) % ADJECTIVES.len()];
    let noun = NOUNS[usize::from(digest[1]) % NOUNS.len()];
    format!("{adjective}{noun}")
}

fn terminal_agent_response_result(response: TerminalAgentResponse) -> Result<()> {
    match response {
        TerminalAgentResponse::Ok => Ok(()),
        TerminalAgentResponse::Error { message } => Err(terminal_error(message)),
    }
}

fn new_agent_request_id() -> String {
    format!("nocturne-{}", uuid::Uuid::new_v4())
}

fn agent_protocol_request(name: &str, payload: Option<serde_json::Value>) -> AgentProtocolRequest {
    AgentProtocolRequest {
        kind: "request",
        request_id: new_agent_request_id(),
        name: name.to_string(),
        payload,
    }
}

fn agent_write_request(bytes: &[u8]) -> AgentProtocolRequest {
    agent_protocol_request(
        "write",
        Some(serde_json::json!({
            "data": BASE64_STANDARD.encode(bytes),
        })),
    )
}

fn agent_resize_request(size: PtySize) -> AgentProtocolRequest {
    agent_protocol_request(
        "resize",
        Some(serde_json::json!({
            "cols": size.cols,
            "rows": size.rows,
            "pixel_width": size.pixel_width,
            "pixel_height": size.pixel_height,
        })),
    )
}

fn agent_title_request(name: &str, title: &str) -> AgentProtocolRequest {
    agent_protocol_request(
        name,
        Some(serde_json::json!({
            "title": title,
        })),
    )
}

fn send_local_agent_control_request(
    control: &Sender<LocalAgentControlCommand>,
    request: AgentProtocolRequest,
) -> Result<TerminalAgentResponse> {
    let (response_tx, response_rx) = mpsc::channel();
    control
        .send(LocalAgentControlCommand {
            request,
            response: response_tx,
        })
        .map_err(|error| {
            terminal_error(format!(
                "failed to send terminal agent control request: {error}"
            ))
        })?;
    response_rx.recv().map_err(|error| {
        terminal_error(format!(
            "terminal agent control request did not respond: {error}"
        ))
    })?
}

fn remote_agent_response(
    backend: &RemoteAgentBackend,
    build_command: impl FnOnce(Sender<Result<TerminalAgentResponse>>) -> RemoteAgentCommand,
) -> Result<TerminalAgentResponse> {
    let (response_tx, response_rx) = mpsc::channel();
    backend
        .commands
        .send(build_command(response_tx))
        .map_err(|error| terminal_error(format!("failed to send remote agent command: {error}")))?;
    response_rx
        .recv()
        .map_err(|error| terminal_error(format!("remote agent command did not respond: {error}")))?
}

fn remote_agent_backend(runtime: RemoteAgentRuntime) -> RemoteAgentBackend {
    let runtime_slot = Arc::new(Mutex::new(Some(runtime)));
    let live_control = Arc::new(Mutex::new(None));
    let (command_tx, command_rx) = mpsc::channel();
    spawn_remote_agent_control_worker(runtime_slot.clone(), command_rx);
    RemoteAgentBackend {
        commands: command_tx,
        live_control,
        runtime: runtime_slot,
    }
}

fn send_remote_agent_backend_request(
    backend: &RemoteAgentBackend,
    request: AgentProtocolRequest,
    build_command: impl FnOnce(Sender<Result<TerminalAgentResponse>>) -> RemoteAgentCommand,
) -> Result<TerminalAgentResponse> {
    let live_control = backend
        .live_control
        .lock()
        .map_err(|_| invalid_error("remote terminal agent live control lock poisoned"))?
        .clone();
    if let Some(control) = live_control {
        send_local_agent_control_request(&control, request)
    } else {
        remote_agent_response(backend, build_command)
    }
}

fn send_agent_backend_request(
    session_id: &str,
    helper_path: &str,
    local_control: Option<&Sender<LocalAgentControlCommand>>,
    remote: Option<&RemoteAgentBackend>,
    remote_command: impl FnOnce(Sender<Result<TerminalAgentResponse>>) -> RemoteAgentCommand,
    local_request: impl FnOnce() -> AgentProtocolRequest,
    command_name: &str,
    extra: &[(&str, &str)],
) -> Result<TerminalAgentResponse> {
    if let Some(remote) = remote {
        send_remote_agent_backend_request(remote, local_request(), remote_command)
    } else if let Some(control) = local_control {
        send_local_agent_control_request(control, local_request())
    } else {
        run_local_go_agent_client(helper_path, session_id, command_name, extra)
    }
}

fn kill_terminal_session(session: Arc<TerminalSession>) -> Result<()> {
    let mut backend = session.backend.lock().unwrap();
    match &mut *backend {
        TerminalBackend::Local { killer, .. } => killer.kill().map_err(terminal_error),
        TerminalBackend::Ssh { commands } => commands
            .send(SshWorkerCommand::Close)
            .map_err(|error| terminal_error(format!("failed to close ssh session: {error}"))),
        TerminalBackend::Agent {
            session_id,
            helper_path,
            agent_process,
            local_control,
            remote,
        } => {
            let response = send_agent_backend_request(
                session_id,
                helper_path,
                local_control.as_ref(),
                remote.as_ref(),
                RemoteAgentCommand::Close,
                || agent_protocol_request("close_run", None),
                "close_run",
                &[],
            );
            if let Some(child) = agent_process.as_mut() {
                let _ = child.kill();
            }
            terminal_agent_response_result(response?)
        }
        TerminalBackend::AgentHistory { .. } => Ok(()),
    }
}

fn detach_agent_terminal_view(session: &Arc<TerminalSession>) -> Result<bool> {
    let mut backend = session.backend.lock().unwrap();
    let TerminalBackend::Agent {
        session_id,
        helper_path,
        local_control,
        remote,
        ..
    } = &mut *backend
    else {
        return Ok(false);
    };
    let response = send_agent_backend_request(
        session_id,
        helper_path,
        local_control.as_ref(),
        remote.as_ref(),
        RemoteAgentCommand::Detach,
        || agent_protocol_request("detach", None),
        "detach",
        &[],
    )?;
    terminal_agent_response_result(response)?;
    Ok(true)
}

fn close_agent_terminal_view(session: &Arc<TerminalSession>) -> Result<bool> {
    let mut backend = session.backend.lock().unwrap();
    let TerminalBackend::Agent {
        session_id,
        helper_path,
        local_control,
        remote,
        ..
    } = &mut *backend
    else {
        return Ok(false);
    };
    let response = send_agent_backend_request(
        session_id,
        helper_path,
        local_control.as_ref(),
        remote.as_ref(),
        RemoteAgentCommand::CloseView,
        || agent_protocol_request("close_view", None),
        "close_view",
        &[],
    )?;
    terminal_agent_response_result(response)?;
    Ok(true)
}

fn close_terminal_view_session(session: Arc<TerminalSession>) -> Result<()> {
    if close_agent_terminal_view(&session)? {
        return Ok(());
    }
    kill_terminal_session(session)
}

pub(crate) fn close_terminal_sessions_for_window(window_label: &str) {
    let state = terminal_state();
    let sessions = {
        let Ok(sessions) = state.sessions.lock() else {
            return;
        };
        sessions
            .iter()
            .filter_map(|(id, session)| {
                let Ok(owner) = session.window_label.lock() else {
                    return None;
                };
                (owner.as_str() == window_label).then(|| (id.clone(), session.clone()))
            })
            .collect::<Vec<_>>()
    };

    for (id, session) in sessions {
        if let Err(error) = detach_agent_terminal_view(&session) {
            eprintln!("failed to close terminal session {id} for window {window_label}: {error}");
        }
        remove_terminal_session(&id);
    }
}

fn session_by_id(id: &str) -> Result<Arc<TerminalSession>> {
    let state = terminal_state();
    let sessions = state.sessions.lock().unwrap();
    sessions
        .get(id)
        .cloned()
        .ok_or_else(|| missing_error(format!("terminal session {id} not found")))
}

fn terminal_session_missing_error(id: &str) -> crate::error::ConfigError {
    terminal_error(format!(
        "terminal session {id} is no longer active; press any key to reconnect"
    ))
}

fn push_output_backlog(session_id: &str, bytes: &[u8]) -> u64 {
    let Ok(session) = session_by_id(session_id) else {
        return 0;
    };
    let mut sequence = session.output_sequence.lock().unwrap();
    let start = *sequence;
    *sequence = sequence.saturating_add(bytes.len() as u64);
    let mut backlog = session.output_backlog.lock().unwrap();
    backlog.extend_from_slice(bytes);
    if backlog.len() > OUTPUT_BACKLOG_LIMIT {
        let overflow = backlog.len() - OUTPUT_BACKLOG_LIMIT;
        backlog.drain(0..overflow);
        let mut backlog_start = session.output_backlog_start_sequence.lock().unwrap();
        *backlog_start = backlog_start.saturating_add(overflow as u64);
    }
    start
}

fn spawn_terminal_reader(app: AppHandle, session_id: String, mut reader: Box<dyn Read + Send>) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    let sequence = push_output_backlog(&session_id, &buffer[..size]);
                    let event = TerminalOutputEvent {
                        session_id: session_id.clone(),
                        sequence: sequence.to_string(),
                        backlog: false,
                        data: BASE64_STANDARD.encode(&buffer[..size]),
                    };
                    if app.emit(TERMINAL_OUTPUT_EVENT, event).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
}

fn spawn_terminal_waiter(app: AppHandle, session_id: String, mut child: Box<dyn Child + Send>) {
    thread::spawn(move || {
        let status = child.wait();
        remove_terminal_session(&session_id);
        let event = match status {
            Ok(status) => TerminalExitEvent {
                session_id,
                exit_code: Some(status.exit_code()),
                signal: status.signal().map(ToOwned::to_owned),
                error: None,
            },
            Err(error) => TerminalExitEvent {
                session_id,
                exit_code: None,
                signal: Some(error.to_string()),
                error: None,
            },
        };
        let _ = app.emit(TERMINAL_EXIT_EVENT, event);
    });
}

fn handle_go_agent_event_line(app: &AppHandle, session_id: &str, line: &str) -> Result<bool> {
    if line.trim().is_empty() {
        return Ok(true);
    }
    let event = serde_json::from_str::<GoAgentEvent>(line).map_err(terminal_error)?;
    if event.kind != "event" {
        return Ok(true);
    }
    match event.event.as_deref() {
        Some("output") | Some("history") => {
            let data = event
                .data
                .ok_or_else(|| terminal_error("terminal agent output event missing data"))?;
            let bytes = BASE64_STANDARD.decode(data).map_err(terminal_error)?;
            let sequence = push_output_backlog(session_id, &bytes);
            let event = TerminalOutputEvent {
                session_id: session_id.to_string(),
                sequence: sequence.to_string(),
                backlog: false,
                data: BASE64_STANDARD.encode(bytes),
            };
            app.emit(TERMINAL_OUTPUT_EVENT, event)
                .map_err(terminal_error)?;
            Ok(true)
        }
        Some("exit") => {
            let exit = event.exit.unwrap_or(GoAgentExitInfo {
                code: None,
                signal: None,
                reason: None,
            });
            update_terminal_transport_state(app, session_id, TerminalTransportState::Disconnected);
            emit_terminal_exit(
                app,
                session_id.to_string(),
                exit.code,
                exit.signal,
                exit.reason.map(terminal_error),
            );
            Ok(false)
        }
        Some(_) | None => Ok(true),
    }
}

fn handle_go_agent_response_line(
    line: &str,
    pending: &mut HashMap<String, Sender<Result<TerminalAgentResponse>>>,
) -> Result<bool> {
    if line.trim().is_empty() {
        return Ok(true);
    }
    let Ok(response) = serde_json::from_str::<GoAgentResponse>(line) else {
        return Ok(false);
    };
    if response.kind != "response" {
        return Ok(false);
    }
    let Some(request_id) = response.request_id.as_deref() else {
        return Ok(true);
    };
    if let Some(sender) = pending.remove(request_id) {
        let _ = sender.send(go_agent_response_from_decoded(response));
    }
    Ok(true)
}

fn go_agent_response_from_decoded(response: GoAgentResponse) -> Result<TerminalAgentResponse> {
    if response.kind != "response" {
        return Err(terminal_error("terminal agent did not return a response"));
    }
    if response.ok {
        Ok(TerminalAgentResponse::Ok)
    } else {
        Ok(TerminalAgentResponse::Error {
            message: response
                .error
                .unwrap_or_else(|| "terminal agent request failed".to_string()),
        })
    }
}

fn write_agent_control_request(
    writer: &mut dyn Write,
    request: &AgentProtocolRequest,
) -> Result<()> {
    serde_json::to_writer(&mut *writer, request).map_err(terminal_error)?;
    writer.write_all(b"\n").map_err(terminal_error)?;
    writer.flush().map_err(terminal_error)
}

fn spawn_local_agent_control_writer(
    mut writer: Box<dyn Write + Send>,
    receiver: Receiver<LocalAgentControlCommand>,
    pending: Arc<Mutex<HashMap<String, Sender<Result<TerminalAgentResponse>>>>>,
) {
    thread::spawn(move || {
        for command in receiver {
            let request_id = command.request.request_id.clone();
            match pending.lock() {
                Ok(mut guard) => {
                    guard.insert(request_id.clone(), command.response.clone());
                }
                Err(_) => {
                    let _ = command.response.send(Err(invalid_error(
                        "terminal agent response map lock poisoned",
                    )));
                    continue;
                }
            }
            if let Err(error) = write_agent_control_request(&mut writer, &command.request) {
                if let Ok(mut guard) = pending.lock() {
                    guard.remove(&request_id);
                }
                let _ = command.response.send(Err(error));
                break;
            }
        }
    });
}

fn spawn_local_go_agent_terminal_reader(
    app: AppHandle,
    view_session_id: String,
    registry_session_id: String,
    helper_path: String,
    reader_token: String,
) -> Sender<LocalAgentControlCommand> {
    let (control_tx, control_rx) = mpsc::channel();
    thread::spawn(move || {
        let mut child = match std::process::Command::new(&helper_path)
            .arg("client")
            .arg("subscribe")
            .arg("--session-id")
            .arg(&registry_session_id)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                update_terminal_transport_state(
                    &app,
                    &view_session_id,
                    TerminalTransportState::Failed,
                );
                emit_terminal_exit(
                    &app,
                    view_session_id,
                    None,
                    Some(error.to_string()),
                    Some(terminal_error(error.to_string())),
                );
                return;
            }
        };
        let Some(stdin) = child.stdin.take() else {
            update_terminal_transport_state(&app, &view_session_id, TerminalTransportState::Failed);
            emit_terminal_exit(
                &app,
                view_session_id,
                None,
                Some("terminal agent client stdin was not piped".to_string()),
                Some(terminal_error("terminal agent client stdin was not piped")),
            );
            terminate_terminal_agent_client(child);
            return;
        };
        let Some(stdout) = child.stdout.take() else {
            update_terminal_transport_state(&app, &view_session_id, TerminalTransportState::Failed);
            emit_terminal_exit(
                &app,
                view_session_id,
                None,
                Some("terminal agent client stdout was not piped".to_string()),
                Some(terminal_error("terminal agent client stdout was not piped")),
            );
            terminate_terminal_agent_client(child);
            return;
        };
        let pending_responses: Arc<Mutex<HashMap<String, Sender<Result<TerminalAgentResponse>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        spawn_local_agent_control_writer(Box::new(stdin), control_rx, pending_responses.clone());
        let run_reader = || {
            update_terminal_transport_state(
                &app,
                &view_session_id,
                TerminalTransportState::Connected,
            );
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                let read = match reader.read_line(&mut line) {
                    Ok(read) => read,
                    Err(error) => {
                        update_terminal_transport_state(
                            &app,
                            &view_session_id,
                            TerminalTransportState::Failed,
                        );
                        emit_terminal_exit(
                            &app,
                            view_session_id,
                            None,
                            Some(error.to_string()),
                            Some(terminal_error(error.to_string())),
                        );
                        return;
                    }
                };
                if read == 0 {
                    update_terminal_transport_state(
                        &app,
                        &view_session_id,
                        TerminalTransportState::Disconnected,
                    );
                    return;
                }
                if !terminal_reader_token_matches(&view_session_id, &reader_token) {
                    return;
                }
                match pending_responses.lock() {
                    Ok(mut pending) => match handle_go_agent_response_line(&line, &mut pending) {
                        Ok(true) => continue,
                        Ok(false) => {}
                        Err(error) => {
                            update_terminal_transport_state(
                                &app,
                                &view_session_id,
                                TerminalTransportState::Failed,
                            );
                            emit_terminal_exit(
                                &app,
                                view_session_id,
                                None,
                                Some(error.to_string()),
                                Some(error),
                            );
                            return;
                        }
                    },
                    Err(_) => {
                        update_terminal_transport_state(
                            &app,
                            &view_session_id,
                            TerminalTransportState::Failed,
                        );
                        emit_terminal_exit(
                            &app,
                            view_session_id,
                            None,
                            Some("terminal agent response map lock poisoned".to_string()),
                            Some(invalid_error("terminal agent response map lock poisoned")),
                        );
                        return;
                    }
                }
                match handle_go_agent_event_line(&app, &view_session_id, &line) {
                    Ok(true) => {}
                    Ok(false) => return,
                    Err(error) => {
                        update_terminal_transport_state(
                            &app,
                            &view_session_id,
                            TerminalTransportState::Failed,
                        );
                        emit_terminal_exit(
                            &app,
                            view_session_id,
                            None,
                            Some(error.to_string()),
                            Some(error),
                        );
                        return;
                    }
                }
            }
        };
        run_reader();
        terminate_terminal_agent_client(child);
    });
    control_tx
}

fn fail_all_remote_live_control_pending(
    pending: &Arc<Mutex<HashMap<String, Sender<Result<TerminalAgentResponse>>>>>,
    pending_writes: &mut VecDeque<u8>,
    error: ConfigError,
) {
    pending_writes.clear();
    let responses = match pending.lock() {
        Ok(mut guard) => guard
            .drain()
            .map(|(_, response)| response)
            .collect::<Vec<_>>(),
        Err(_) => Vec::new(),
    };
    for response in responses {
        let _ = response.send(Err(error.clone()));
    }
}

fn poll_remote_agent_control_requests(
    channel: &mut Channel,
    receiver: &Receiver<LocalAgentControlCommand>,
    pending: &Arc<Mutex<HashMap<String, Sender<Result<TerminalAgentResponse>>>>>,
    pending_writes: &mut VecDeque<u8>,
) -> Result<()> {
    loop {
        match receiver.try_recv() {
            Ok(command) => {
                let request_id = command.request.request_id.clone();
                match pending.lock() {
                    Ok(mut guard) => {
                        guard.insert(request_id.clone(), command.response.clone());
                    }
                    Err(_) => {
                        let _ = command.response.send(Err(invalid_error(
                            "terminal agent response map lock poisoned",
                        )));
                        continue;
                    }
                }
                let serialized_request = serialize_agent_control_request(&command.request)?;
                if let Err(error) = queue_pending_bytes(pending_writes, &serialized_request) {
                    fail_all_remote_live_control_pending(pending, pending_writes, error);
                    return Err(terminal_error(
                        "failed to queue remote terminal agent control request",
                    ));
                }
                if let Err(error) = drain_remote_agent_pending_writes(channel, pending_writes) {
                    fail_all_remote_live_control_pending(pending, pending_writes, error);
                    return Err(terminal_error(
                        "failed to write remote terminal agent control request",
                    ));
                }
            }
            Err(mpsc::TryRecvError::Empty) => return Ok(()),
            Err(mpsc::TryRecvError::Disconnected) => {
                return Err(terminal_error(
                    "remote terminal agent live control channel disconnected",
                ))
            }
        }
    }
}

fn serialize_agent_control_request(request: &AgentProtocolRequest) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    serde_json::to_writer(&mut bytes, request).map_err(terminal_error)?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn drain_remote_agent_pending_writes(
    channel: &mut dyn Write,
    pending: &mut VecDeque<u8>,
) -> Result<bool> {
    let mut progressed = false;
    for _ in 0..16 {
        if pending.is_empty() {
            break;
        }
        let write_len = pending.len().min(SSH_WRITE_CHUNK_LIMIT);
        let written = {
            let contiguous = pending.make_contiguous();
            match channel.write(&contiguous[..write_len]) {
                Ok(0) => break,
                Ok(size) => size,
                Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                Err(error) => return Err(terminal_error(error)),
            }
        };
        pending.drain(..written);
        progressed = true;
    }
    Ok(progressed)
}

fn terminate_terminal_agent_client(mut child: std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn spawn_local_go_agent_history_then_reader(
    app: AppHandle,
    view_session_id: String,
    registry_session_id: String,
    helper_path: String,
    reader_token: String,
) {
    thread::spawn(move || {
        match run_local_go_agent_client_output(&helper_path, &registry_session_id, "history", &[]) {
            Ok(output) => {
                for line in output.lines() {
                    if !terminal_reader_token_matches(&view_session_id, &reader_token) {
                        return;
                    }
                    if let Err(error) = handle_go_agent_event_line(&app, &view_session_id, line) {
                        update_terminal_transport_state(
                            &app,
                            &view_session_id,
                            TerminalTransportState::Failed,
                        );
                        emit_terminal_exit(
                            &app,
                            view_session_id,
                            None,
                            Some(error.to_string()),
                            Some(error),
                        );
                        return;
                    }
                }
            }
            Err(error) => {
                update_terminal_transport_state(
                    &app,
                    &view_session_id,
                    TerminalTransportState::Failed,
                );
                emit_terminal_exit(
                    &app,
                    view_session_id,
                    None,
                    Some(error.to_string()),
                    Some(error),
                );
                return;
            }
        }
        if terminal_reader_token_matches(&view_session_id, &reader_token) {
            spawn_local_go_agent_terminal_reader(
                app,
                view_session_id,
                registry_session_id,
                helper_path,
                reader_token,
            );
        }
    });
}

fn spawn_local_go_agent_history_reader(
    app: AppHandle,
    view_session_id: String,
    registry_session_id: String,
    helper_path: String,
    reader_token: String,
) {
    thread::spawn(move || {
        match run_local_go_agent_client_output(&helper_path, &registry_session_id, "history", &[]) {
            Ok(output) => {
                for line in output.lines() {
                    if !terminal_reader_token_matches(&view_session_id, &reader_token) {
                        return;
                    }
                    if let Err(error) = handle_go_agent_event_line(&app, &view_session_id, line) {
                        update_terminal_transport_state(
                            &app,
                            &view_session_id,
                            TerminalTransportState::Failed,
                        );
                        emit_terminal_exit(
                            &app,
                            view_session_id,
                            None,
                            Some(error.to_string()),
                            Some(error),
                        );
                        return;
                    }
                }
                update_terminal_transport_state(
                    &app,
                    &view_session_id,
                    TerminalTransportState::Disconnected,
                );
            }
            Err(error) => {
                update_terminal_transport_state(
                    &app,
                    &view_session_id,
                    TerminalTransportState::Failed,
                );
                emit_terminal_exit(
                    &app,
                    view_session_id,
                    None,
                    Some(error.to_string()),
                    Some(error),
                );
            }
        }
    });
}

fn spawn_remote_agent_terminal_reader(
    app: AppHandle,
    session_id: String,
    reader_token: String,
    runtime: RemoteAgentRuntime,
    live_control_slot: Arc<Mutex<Option<Sender<LocalAgentControlCommand>>>>,
) -> Sender<LocalAgentControlCommand> {
    let (control_tx, control_rx) = mpsc::channel();
    if let Ok(mut slot) = live_control_slot.lock() {
        *slot = Some(control_tx.clone());
    }
    thread::spawn(move || {
        let pending_responses: Arc<Mutex<HashMap<String, Sender<Result<TerminalAgentResponse>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let exec = match connect_ssh_exec_session(&runtime.worker_input) {
            Ok(exec) => exec,
            Err(error) => {
                update_terminal_transport_state(&app, &session_id, TerminalTransportState::Failed);
                emit_terminal_exit(&app, session_id, None, Some(error.to_string()), Some(error));
                return;
            }
        };
        let command = go_terminal_agent_client_command(
            runtime.target_os,
            &runtime.helper_path,
            &runtime.agent_session_id,
            "subscribe",
            &[],
        );
        exec.session.set_blocking(false);
        let channel = match exec_channel(&exec.session, &command) {
            Ok(channel) => channel,
            Err(error) => {
                update_terminal_transport_state(&app, &session_id, TerminalTransportState::Failed);
                emit_terminal_exit(&app, session_id, None, Some(error.to_string()), Some(error));
                return;
            }
        };
        update_terminal_transport_state(&app, &session_id, TerminalTransportState::Connected);
        let mut reader = BufReader::new(channel);
        let mut pending_writes = VecDeque::new();
        loop {
            if let Err(error) = poll_remote_agent_control_requests(
                reader.get_mut(),
                &control_rx,
                &pending_responses,
                &mut pending_writes,
            ) {
                update_terminal_transport_state(&app, &session_id, TerminalTransportState::Failed);
                emit_terminal_exit(&app, session_id, None, Some(error.to_string()), Some(error));
                return;
            }
            if let Err(error) =
                drain_remote_agent_pending_writes(reader.get_mut(), &mut pending_writes)
            {
                update_terminal_transport_state(&app, &session_id, TerminalTransportState::Failed);
                emit_terminal_exit(&app, session_id, None, Some(error.to_string()), Some(error));
                return;
            }
            let mut line = String::new();
            let read = match reader.read_line(&mut line) {
                Ok(read) => read,
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                    continue;
                }
                Err(error) => {
                    update_terminal_transport_state(
                        &app,
                        &session_id,
                        TerminalTransportState::Failed,
                    );
                    emit_terminal_exit(
                        &app,
                        session_id,
                        None,
                        Some(error.to_string()),
                        Some(terminal_error(error.to_string())),
                    );
                    return;
                }
            };
            if read == 0 {
                update_terminal_transport_state(
                    &app,
                    &session_id,
                    TerminalTransportState::Disconnected,
                );
                return;
            }
            if !terminal_reader_token_matches(&session_id, &reader_token) {
                return;
            }
            match pending_responses.lock() {
                Ok(mut pending) => match handle_go_agent_response_line(&line, &mut pending) {
                    Ok(true) => continue,
                    Ok(false) => {}
                    Err(error) => {
                        update_terminal_transport_state(
                            &app,
                            &session_id,
                            TerminalTransportState::Failed,
                        );
                        emit_terminal_exit(
                            &app,
                            session_id,
                            None,
                            Some(error.to_string()),
                            Some(error),
                        );
                        return;
                    }
                },
                Err(_) => {
                    update_terminal_transport_state(
                        &app,
                        &session_id,
                        TerminalTransportState::Failed,
                    );
                    emit_terminal_exit(
                        &app,
                        session_id,
                        None,
                        Some("terminal agent response map lock poisoned".to_string()),
                        Some(invalid_error("terminal agent response map lock poisoned")),
                    );
                    return;
                }
            }
            match handle_go_agent_event_line(&app, &session_id, &line) {
                Ok(true) => {}
                Ok(false) => return,
                Err(error) => {
                    update_terminal_transport_state(
                        &app,
                        &session_id,
                        TerminalTransportState::Failed,
                    );
                    emit_terminal_exit(
                        &app,
                        session_id,
                        None,
                        Some(error.to_string()),
                        Some(error),
                    );
                    return;
                }
            }
        }
    });
    control_tx
}

fn spawn_remote_go_agent_history_then_reader(
    app: AppHandle,
    session_id: String,
    reader_token: String,
    runtime: RemoteAgentRuntime,
    live_control_slot: Arc<Mutex<Option<Sender<LocalAgentControlCommand>>>>,
) {
    thread::spawn(move || {
        match run_remote_go_agent_client_output(
            &runtime.worker_input,
            runtime.target_os,
            &runtime.helper_path,
            &runtime.agent_session_id,
            "history",
            &[],
        ) {
            Ok(output) => {
                for line in output.lines() {
                    if !terminal_reader_token_matches(&session_id, &reader_token) {
                        return;
                    }
                    if let Err(error) = handle_go_agent_event_line(&app, &session_id, line) {
                        update_terminal_transport_state(
                            &app,
                            &session_id,
                            TerminalTransportState::Failed,
                        );
                        emit_terminal_exit(
                            &app,
                            session_id,
                            None,
                            Some(error.to_string()),
                            Some(error),
                        );
                        return;
                    }
                }
            }
            Err(error) => {
                update_terminal_transport_state(&app, &session_id, TerminalTransportState::Failed);
                emit_terminal_exit(&app, session_id, None, Some(error.to_string()), Some(error));
                return;
            }
        }
        if terminal_reader_token_matches(&session_id, &reader_token) {
            spawn_remote_agent_terminal_reader(
                app,
                session_id,
                reader_token,
                runtime,
                live_control_slot,
            );
        }
    });
}

fn spawn_remote_go_agent_history_reader(
    app: AppHandle,
    view_session_id: String,
    registry_session_id: String,
    reader_token: String,
    runtime: RemoteAgentRuntime,
) {
    thread::spawn(move || {
        match run_remote_go_agent_client_output(
            &runtime.worker_input,
            runtime.target_os,
            &runtime.helper_path,
            &registry_session_id,
            "history",
            &[],
        ) {
            Ok(output) => {
                for line in output.lines() {
                    if !terminal_reader_token_matches(&view_session_id, &reader_token) {
                        return;
                    }
                    if let Err(error) = handle_go_agent_event_line(&app, &view_session_id, line) {
                        update_terminal_transport_state(
                            &app,
                            &view_session_id,
                            TerminalTransportState::Failed,
                        );
                        emit_terminal_exit(
                            &app,
                            view_session_id,
                            None,
                            Some(error.to_string()),
                            Some(error),
                        );
                        return;
                    }
                }
                update_terminal_transport_state(
                    &app,
                    &view_session_id,
                    TerminalTransportState::Disconnected,
                );
            }
            Err(error) => {
                update_terminal_transport_state(
                    &app,
                    &view_session_id,
                    TerminalTransportState::Failed,
                );
                emit_terminal_exit(
                    &app,
                    view_session_id,
                    None,
                    Some(error.to_string()),
                    Some(error),
                );
            }
        }
    });
}

fn spawn_remote_agent_control_worker(
    runtime_slot: Arc<Mutex<Option<RemoteAgentRuntime>>>,
    receiver: Receiver<RemoteAgentCommand>,
) {
    thread::spawn(move || {
        for command in receiver {
            let runtime = match runtime_slot.lock() {
                Ok(guard) => guard.clone(),
                Err(_) => None,
            };
            let response = remote_agent_command_response_sender(&command);
            let Some(runtime) = runtime else {
                let _ = response.send(Err(terminal_error("remote terminal agent is not ready")));
                continue;
            };
            let result = send_remote_agent_command(&runtime, command);
            let should_stop = result.is_err();
            let _ = response.send(result);
            if should_stop {
                break;
            }
        }
    });
}

fn send_remote_agent_command(
    runtime: &RemoteAgentRuntime,
    command: RemoteAgentCommand,
) -> Result<TerminalAgentResponse> {
    let mut extra = Vec::new();
    let command_name = match &command {
        RemoteAgentCommand::Write(bytes, _) => {
            let data = BASE64_STANDARD.encode(bytes);
            extra.push(("--data".to_string(), data));
            "write"
        }
        RemoteAgentCommand::Resize(size, _) => {
            extra.push(("--cols".to_string(), size.cols.to_string()));
            extra.push(("--rows".to_string(), size.rows.to_string()));
            extra.push(("--pixel-width".to_string(), size.pixel_width.to_string()));
            extra.push(("--pixel-height".to_string(), size.pixel_height.to_string()));
            "resize"
        }
        RemoteAgentCommand::TitleChange(title, _) => {
            extra.push(("--title".to_string(), title.clone()));
            "title_change"
        }
        RemoteAgentCommand::Close(_) => "close_run",
        RemoteAgentCommand::CloseView(_) => "close_view",
        RemoteAgentCommand::Detach(_) => "detach",
        RemoteAgentCommand::Delete(_) => "delete",
    };
    let extra_refs = extra
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect::<Vec<_>>();
    let output = run_remote_go_agent_client(
        &runtime.worker_input,
        runtime.target_os,
        &runtime.helper_path,
        &runtime.agent_session_id,
        command_name,
        &extra_refs,
    )?;
    terminal_agent_response_result(output.clone())?;
    Ok(output)
}

fn remote_agent_command_response_sender(
    command: &RemoteAgentCommand,
) -> Sender<Result<TerminalAgentResponse>> {
    match command {
        RemoteAgentCommand::Write(_, sender)
        | RemoteAgentCommand::Resize(_, sender)
        | RemoteAgentCommand::TitleChange(_, sender)
        | RemoteAgentCommand::Close(sender)
        | RemoteAgentCommand::CloseView(sender)
        | RemoteAgentCommand::Detach(sender)
        | RemoteAgentCommand::Delete(sender) => sender.clone(),
    }
}

fn local_terminal_agent_target() -> Result<(RemoteResourceTargetOs, RemoteResourceTargetArch)> {
    let target_os = if cfg!(target_os = "windows") {
        RemoteResourceTargetOs::Windows
    } else if cfg!(target_os = "macos") {
        RemoteResourceTargetOs::Macos
    } else if cfg!(target_os = "linux") {
        RemoteResourceTargetOs::Linux
    } else {
        return Err(invalid_error("local Terminal Agent OS is not supported"));
    };
    let target_arch = if cfg!(target_arch = "x86_64") {
        RemoteResourceTargetArch::X86_64
    } else if cfg!(target_arch = "aarch64") {
        RemoteResourceTargetArch::Aarch64
    } else if cfg!(all(target_arch = "arm", target_pointer_width = "32")) {
        RemoteResourceTargetArch::Armv7
    } else if cfg!(target_arch = "x86") {
        RemoteResourceTargetArch::I686
    } else {
        return Err(invalid_error(
            "local Terminal Agent architecture is not supported",
        ));
    };
    Ok((target_os, target_arch))
}

fn local_terminal_agent_helper_path(app: &AppHandle) -> Result<String> {
    let (target_os, target_arch) = local_terminal_agent_target()?;
    let resource_path = terminal_agent_resource_path(target_os, target_arch);
    let resource_dir = app.path().resource_dir().map_err(crate::error::io_error)?;
    for path in terminal_agent_candidate_paths(&resource_dir, &resource_path) {
        match fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() => return Ok(path.to_string_lossy().into_owned()),
            Ok(_) => {
                return Err(invalid_error(format!(
                    "bundled Terminal Agent helper is not a file: {}",
                    path.display()
                )));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(crate::error::io_error(error)),
        }
    }
    Err(terminal_error(format!(
        "bundled Terminal Agent helper is missing for {}",
        resource_path
    )))
}

struct SshExecSession {
    session: Session,
    _jump_guards: Vec<thread::JoinHandle<()>>,
}

fn connect_ssh_exec_session(input: &SshWorkerInput) -> Result<SshExecSession> {
    let mut jump_guards = Vec::new();
    let tcp = if let Some(proxy_jump_chain) = input.proxy_jump_chain.as_deref() {
        let chain = connect_proxy_jump_chain(input, proxy_jump_chain)?;
        jump_guards = chain.guards;
        chain.stream
    } else if let Some(proxy_jump) = input.ssh.proxy_jump.as_deref() {
        let jumps = parse_proxy_jump_chain(proxy_jump)?;
        let chain = connect_proxy_jump_chain(input, &jumps)?;
        jump_guards = chain.guards;
        chain.stream
    } else {
        TcpStream::connect((ssh_network_hostname(&input.ssh.hostname), input.ssh.port))
            .map_err(terminal_error)?
    };
    tcp.set_nodelay(true).map_err(terminal_error)?;
    let mut session = Session::new().map_err(terminal_error)?;
    session.set_tcp_stream(tcp);
    session.handshake().map_err(terminal_error)?;
    verify_ssh_host_key(&session, input)?;
    authenticate_ssh_session(&session, input)?;
    session.set_blocking(true);
    Ok(SshExecSession {
        session,
        _jump_guards: jump_guards,
    })
}

fn exec_channel(session: &Session, command: &str) -> Result<Channel> {
    let mut channel = session.channel_session().map_err(terminal_error)?;
    channel.exec(command).map_err(terminal_error)?;
    Ok(channel)
}

fn run_remote_go_agent_client(
    input: &SshWorkerInput,
    target_os: RemoteResourceTargetOs,
    helper_path: &str,
    session_id: &str,
    command_name: &str,
    extra: &[(&str, &str)],
) -> Result<TerminalAgentResponse> {
    let exec = connect_ssh_exec_session(input)?;
    run_remote_go_agent_client_on_session(
        &exec.session,
        target_os,
        helper_path,
        session_id,
        command_name,
        extra,
    )
}

fn run_remote_go_agent_client_on_session(
    session: &Session,
    target_os: RemoteResourceTargetOs,
    helper_path: &str,
    session_id: &str,
    command_name: &str,
    extra: &[(&str, &str)],
) -> Result<TerminalAgentResponse> {
    let command =
        go_terminal_agent_client_command(target_os, helper_path, session_id, command_name, extra);
    let output = run_remote_command(session, &command)?;
    if output.status != 0 {
        return Err(terminal_error(format!(
            "remote terminal agent client failed: {}",
            output.stderr.trim()
        )));
    }
    let line = output
        .stdout
        .lines()
        .find(|line| !line.trim().is_empty() && line.contains(r#""type":"response""#))
        .ok_or_else(|| terminal_error("remote terminal agent client did not return a response"))?;
    go_agent_response_result(line)
}

fn run_remote_go_agent_client_output(
    input: &SshWorkerInput,
    target_os: RemoteResourceTargetOs,
    helper_path: &str,
    session_id: &str,
    command_name: &str,
    extra: &[(&str, &str)],
) -> Result<String> {
    let exec = connect_ssh_exec_session(input)?;
    run_remote_go_agent_client_output_on_session(
        &exec.session,
        target_os,
        helper_path,
        session_id,
        command_name,
        extra,
    )
}

fn run_remote_go_agent_client_output_on_session(
    session: &Session,
    target_os: RemoteResourceTargetOs,
    helper_path: &str,
    session_id: &str,
    command_name: &str,
    extra: &[(&str, &str)],
) -> Result<String> {
    let command =
        go_terminal_agent_client_command(target_os, helper_path, session_id, command_name, extra);
    let output = run_remote_command(session, &command)?;
    if output.status != 0 {
        return Err(terminal_error(format!(
            "remote terminal agent client failed: {}",
            output.stderr.trim()
        )));
    }
    Ok(output.stdout)
}

fn run_remote_go_agent_list(
    input: &SshWorkerInput,
    target_os: RemoteResourceTargetOs,
    helper_path: &str,
    host_id: &str,
) -> Result<Vec<GoAgentListedSession>> {
    let exec = connect_ssh_exec_session(input)?;
    run_remote_go_agent_list_on_session(&exec.session, target_os, helper_path, host_id)
}

fn run_remote_go_agent_list_on_session(
    session: &Session,
    target_os: RemoteResourceTargetOs,
    helper_path: &str,
    host_id: &str,
) -> Result<Vec<GoAgentListedSession>> {
    let command = go_terminal_agent_list_command(target_os, helper_path, host_id);
    let output = run_remote_command(session, &command)?;
    if output.status != 0 {
        return Err(terminal_error(format!(
            "remote terminal agent client list failed: {}",
            output.stderr.trim()
        )));
    }
    parse_go_agent_session_list(&output.stdout, host_id)
}

fn go_terminal_agent_client_command(
    target_os: RemoteResourceTargetOs,
    helper_path: &str,
    session_id: &str,
    command_name: &str,
    extra: &[(&str, &str)],
) -> String {
    let mut args = vec![
        "client".to_string(),
        command_name.to_string(),
        "--session-id".to_string(),
        session_id.to_string(),
    ];
    for (name, value) in extra {
        args.push((*name).to_string());
        args.push((*value).to_string());
    }
    terminal_agent_managed_command(target_os, helper_path, &args)
}

fn go_terminal_agent_list_command(
    target_os: RemoteResourceTargetOs,
    helper_path: &str,
    host_id: &str,
) -> String {
    terminal_agent_managed_command(
        target_os,
        helper_path,
        &[
            "client".to_string(),
            "list".to_string(),
            "--host-id".to_string(),
            host_id.to_string(),
        ],
    )
}

fn terminal_agent_managed_command(
    target_os: RemoteResourceTargetOs,
    helper_path: &str,
    args: &[String],
) -> String {
    let quoted_args = args
        .iter()
        .map(|arg| shell_quote(arg))
        .collect::<Vec<_>>()
        .join(" ");
    match target_os {
        RemoteResourceTargetOs::Windows => {
            format!("& {} {}", shell_quote(helper_path), quoted_args)
        }
        RemoteResourceTargetOs::Linux | RemoteResourceTargetOs::Macos => {
            format!("{} {}", shell_quote(helper_path), quoted_args)
        }
    }
}

fn go_agent_response_result(line: &str) -> Result<TerminalAgentResponse> {
    let response = serde_json::from_str::<GoAgentResponse>(line).map_err(terminal_error)?;
    if response.kind != "response" {
        return Err(terminal_error("terminal agent did not return a response"));
    }
    if response.ok {
        Ok(TerminalAgentResponse::Ok)
    } else {
        Ok(TerminalAgentResponse::Error {
            message: response
                .error
                .unwrap_or_else(|| "terminal agent request failed".to_string()),
        })
    }
}

fn parse_go_agent_session_list(output: &str, host_id: &str) -> Result<Vec<GoAgentListedSession>> {
    let mut sessions = Vec::new();
    let mut saw_complete = false;
    for line in output.lines().filter(|line| !line.trim().is_empty()) {
        let entry = serde_json::from_str::<GoAgentListLine>(line).map_err(terminal_error)?;
        match entry.kind.as_str() {
            "session" => {
                let session = entry.session.ok_or_else(|| {
                    terminal_error("terminal agent list session line missing session")
                })?;
                if session.host_id != host_id {
                    return Err(terminal_error(format!(
                        "terminal agent list returned session for unexpected host_id {}",
                        session.host_id
                    )));
                }
                sessions.push(session);
            }
            "invalid" => {
                return Err(terminal_error(format!(
                    "terminal agent registry is invalid: {}",
                    entry
                        .error
                        .unwrap_or_else(|| "unknown registry error".to_string())
                )));
            }
            "complete" => {
                saw_complete = true;
                if let Some(count) = entry.count {
                    if count != sessions.len() {
                        return Err(terminal_error(format!(
                            "terminal agent list count mismatch: expected {count}, got {}",
                            sessions.len()
                        )));
                    }
                }
            }
            other => {
                return Err(terminal_error(format!(
                    "terminal agent list returned unsupported line type {other}"
                )));
            }
        }
    }
    if !saw_complete {
        return Err(terminal_error(
            "terminal agent client list did not return a complete line",
        ));
    }
    Ok(sessions)
}

fn terminal_detached_info_from_go_session(
    session: &GoAgentListedSession,
) -> TerminalDetachedSessionInfo {
    TerminalDetachedSessionInfo {
        session_id: session.session_id.clone(),
        title: session.title.clone(),
        command: session.command.clone(),
        cwd: session.cwd.clone(),
        cols: session.cols.unwrap_or(80),
        rows: session.rows.unwrap_or(24),
        detached: session.status != "exited",
        attached_count: session.attached_count.unwrap_or(0),
    }
}

fn terminal_session_info_from_go_session(session: &GoAgentListedSession) -> TerminalSessionInfo {
    TerminalSessionInfo {
        id: session.session_id.clone(),
        title: session.title.clone(),
        command: session.command.clone(),
        cwd: session.cwd.clone(),
        cols: session.cols.unwrap_or(80),
        rows: session.rows.unwrap_or(24),
        pixel_width: session.pixel_width.unwrap_or(0),
        pixel_height: session.pixel_height.unwrap_or(0),
        process_id: None,
        transport: TerminalTransportKind::Agent,
        transport_state: if session.status == "exited" {
            TerminalTransportState::Disconnected
        } else {
            TerminalTransportState::Connected
        },
        agent: Some(TerminalAgentSessionInfo {
            session_id: session.session_id.clone(),
        }),
    }
}

fn terminal_session_info_from_go_session_with_view_id(
    session: &GoAgentListedSession,
    view_session_id: String,
) -> TerminalSessionInfo {
    let mut info = terminal_session_info_from_go_session(session);
    info.id = view_session_id;
    info
}

fn terminal_history_session_info_from_go_session(
    session: &GoAgentListedSession,
    view_session_id: String,
) -> TerminalSessionInfo {
    let mut info = terminal_session_info_from_go_session_with_view_id(session, view_session_id);
    info.transport_state = TerminalTransportState::Disconnected;
    info
}

fn run_local_go_agent_client(
    helper_path: &str,
    session_id: &str,
    command_name: &str,
    extra: &[(&str, &str)],
) -> Result<TerminalAgentResponse> {
    let mut command = std::process::Command::new(helper_path);
    command
        .arg("client")
        .arg(command_name)
        .arg("--session-id")
        .arg(session_id);
    for (name, value) in extra {
        command.arg(name).arg(value);
    }
    let output = command.output().map_err(terminal_error)?;
    if !output.status.success() {
        return Err(terminal_error(format!(
            "terminal agent client failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let stdout = String::from_utf8(output.stdout).map_err(terminal_error)?;
    let line = stdout
        .lines()
        .find(|line| !line.trim().is_empty() && line.contains(r#""type":"response""#))
        .ok_or_else(|| terminal_error("terminal agent client did not return a response"))?;
    go_agent_response_result(line)
}

fn run_local_go_agent_client_output(
    helper_path: &str,
    session_id: &str,
    command_name: &str,
    extra: &[(&str, &str)],
) -> Result<String> {
    let mut command = std::process::Command::new(helper_path);
    command
        .arg("client")
        .arg(command_name)
        .arg("--session-id")
        .arg(session_id);
    for (name, value) in extra {
        command.arg(name).arg(value);
    }
    let output = command.output().map_err(terminal_error)?;
    if !output.status.success() {
        return Err(terminal_error(format!(
            "terminal agent client failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    String::from_utf8(output.stdout).map_err(terminal_error)
}

fn run_local_go_agent_list(helper_path: &str, host_id: &str) -> Result<Vec<GoAgentListedSession>> {
    let output = std::process::Command::new(helper_path)
        .arg("client")
        .arg("list")
        .arg("--host-id")
        .arg(host_id)
        .output()
        .map_err(terminal_error)?;
    if !output.status.success() {
        return Err(terminal_error(format!(
            "terminal agent client list failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let stdout = String::from_utf8(output.stdout).map_err(terminal_error)?;
    parse_go_agent_session_list(&stdout, host_id)
}

fn prepare_remote_terminal_agent_runtime(
    app: &AppHandle,
    host: &ConnectionHostEntry,
    workspace_id: &str,
    tool_tab_id: Option<&str>,
    session_id: &str,
    size: PtySize,
    accept_new_host_key: bool,
    update_changed_host_key: bool,
    credential: Option<SshCredentialInput>,
    save_credential: bool,
) -> Result<PreparedRemoteTerminalAgent> {
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
    let connection = connect_sftp_for_host(
        app,
        host,
        SftpAuthScope {
            workspace_id,
            source_tool_tab_id: tool_tab_id,
        },
        accept_new_host_key,
        update_changed_host_key,
        credential.clone(),
        save_credential,
        session_id,
    )?;
    let detection = detect_remote_resource_target(&connection, host.document.resources.clone())?;
    let (target_os, target_arch) = match detection {
        crate::resources::RemoteResourceTargetDetection::Detected { os, arch, .. } => (os, arch),
        crate::resources::RemoteResourceTargetDetection::Unknown { reason, .. } => {
            return Err(terminal_error(format!(
                "Terminal Agent target OS/architecture is unknown: {reason}"
            )));
        }
    };
    let helper_bytes = match load_terminal_agent_bytes_from_app(app, target_os, target_arch)? {
        ResourceHelperBytesSource::Bundled(bytes) => bytes,
        ResourceHelperBytesSource::DownloadRequired(plan) => {
            download_terminal_agent_after_confirmation(app, &plan)?
        }
        ResourceHelperBytesSource::Unavailable { reason } => return Err(terminal_error(reason)),
    };
    let plan = plan_terminal_agent_upload(
        &helper_bytes,
        target_os,
        target_arch,
        TERMINAL_AGENT_VERSION,
    )?;
    match terminal_agent_helper_policy(app)? {
        ResourceHelperPolicy::Never => {
            return Err(terminal_error(
                "remote helper policy is Never; Terminal Agent mode cannot start",
            ));
        }
        ResourceHelperPolicy::Ask => {
            if !confirm_terminal_agent_upload(app, host, &plan) {
                return Err(terminal_error(
                    "Terminal Agent helper upload was canceled by the user",
                ));
            }
        }
        ResourceHelperPolicy::Allow => {}
    }
    let home = remote_home_path_from_shell(&connection.session, target_os)?;
    let helper_path = deploy_terminal_agent_helper(&connection, &plan, &home)?;
    let worker_input = SshWorkerInput {
        app: Some(app.clone()),
        session_id: session_id.to_string(),
        workspace_id: workspace_id.to_string(),
        source_tool_tab_id: tool_tab_id.map(ToOwned::to_owned),
        display_name: host.document.name.clone(),
        auth_target,
        ssh,
        proxy_jump_chain,
        username,
        size,
        trust_path: ssh_known_hosts_path(app)?,
        accept_new_host_key,
        update_changed_host_key,
        credential,
        save_credential,
        verification_scope: SshVerificationScope::Workspace,
    };
    Ok(PreparedRemoteTerminalAgent {
        runtime: RemoteAgentRuntime {
            helper_path,
            target_os,
            agent_session_id: session_id.to_string(),
            worker_input,
        },
        connection,
    })
}

fn spawn_local_go_terminal_agent(
    helper_path: &str,
    launch_spec_json: &str,
) -> Result<std::process::Child> {
    let mut child = std::process::Command::new(helper_path)
        .arg("daemon")
        .arg("--launch-spec-stdin")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(terminal_error)?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| terminal_error("terminal agent daemon stdin was not piped"))?;
    stdin
        .write_all(launch_spec_json.as_bytes())
        .map_err(terminal_error)?;
    drop(stdin);
    Ok(child)
}

fn wait_for_local_go_terminal_agent(
    helper_path: &str,
    host_id: &str,
    session_id: &str,
) -> Result<LocalGoAgentLaunchStatus> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut last_error = None;
    while std::time::Instant::now() < deadline {
        match run_local_go_agent_client(helper_path, session_id, "ping", &[]) {
            Ok(TerminalAgentResponse::Ok) => return Ok(LocalGoAgentLaunchStatus::Running),
            Ok(TerminalAgentResponse::Error { message }) => {
                if let Some(session) =
                    local_go_agent_exited_session(helper_path, host_id, session_id)?
                {
                    return Ok(LocalGoAgentLaunchStatus::Exited(session));
                }
                last_error = Some(terminal_error(message));
            }
            Err(error) => {
                if let Some(session) =
                    local_go_agent_exited_session(helper_path, host_id, session_id)?
                {
                    return Ok(LocalGoAgentLaunchStatus::Exited(session));
                }
                last_error = Some(error);
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err(last_error.unwrap_or_else(|| terminal_error("terminal agent did not start")))
}

fn local_go_agent_exited_session(
    helper_path: &str,
    host_id: &str,
    session_id: &str,
) -> Result<Option<GoAgentListedSession>> {
    let session = run_local_go_agent_list(helper_path, host_id)?
        .into_iter()
        .find(|session| session.session_id == session_id && session.status == "exited");
    Ok(session)
}

fn go_terminal_agent_launch_background_command(
    target_os: RemoteResourceTargetOs,
    helper_path: &str,
    launch_spec_path: &str,
) -> String {
    match target_os {
        RemoteResourceTargetOs::Windows => format!(
            "Start-Process -WindowStyle Hidden -FilePath {} -ArgumentList @('daemon','--launch-spec-stdin') -RedirectStandardInput {}",
            shell_quote(helper_path),
            shell_quote(launch_spec_path)
        ),
        RemoteResourceTargetOs::Linux | RemoteResourceTargetOs::Macos => format!(
            "nohup {} daemon --launch-spec-stdin < {} >/dev/null 2>&1 &",
            shell_quote(helper_path),
            shell_quote(launch_spec_path)
        ),
    }
}

fn wait_for_remote_go_terminal_agent(
    session: &Session,
    target_os: RemoteResourceTargetOs,
    helper_path: &str,
    session_id: &str,
) -> Result<()> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut last_error = None;
    while std::time::Instant::now() < deadline {
        match run_remote_go_agent_client_on_session(
            session,
            target_os,
            helper_path,
            session_id,
            "ping",
            &[],
        ) {
            Ok(TerminalAgentResponse::Ok) => return Ok(()),
            Ok(TerminalAgentResponse::Error { message }) => {
                last_error = Some(terminal_error(message));
            }
            Err(error) => {
                last_error = Some(error);
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err(last_error.unwrap_or_else(|| terminal_error("remote terminal agent did not start")))
}

fn load_terminal_agent_bytes_from_app(
    app: &AppHandle,
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
) -> Result<ResourceHelperBytesSource> {
    let resource_path = terminal_agent_resource_path(target_os, target_arch);
    let resource_dir = app.path().resource_dir().map_err(crate::error::io_error)?;
    for path in terminal_agent_candidate_paths(&resource_dir, &resource_path) {
        match fs::read(&path) {
            Ok(bytes) if !bytes.is_empty() => return Ok(ResourceHelperBytesSource::Bundled(bytes)),
            Ok(_) => {
                return Err(invalid_error(format!(
                    "bundled Terminal Agent helper is empty: {}",
                    path.display()
                )));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(crate::error::io_error(error)),
        }
    }
    match terminal_agent_download_plan(
        TERMINAL_AGENT_GITHUB_REPOSITORY,
        build_info().tag.as_deref(),
        target_os,
        target_arch,
    ) {
        Some(plan) => Ok(ResourceHelperBytesSource::DownloadRequired(plan)),
        None => Ok(ResourceHelperBytesSource::Unavailable {
            reason: "Bundled Terminal Agent helper is missing and this build has no release tag"
                .to_string(),
        }),
    }
}

fn terminal_agent_download_plan(
    github_repository: &str,
    build_tag: Option<&str>,
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
) -> Option<ResourceHelperDownloadPlan> {
    let tag = build_tag?.trim();
    if tag.is_empty() {
        return None;
    }
    let asset_name = format!(
        "nocturne-terminal-agent-{}-{}-{}{}",
        tag,
        terminal_agent_target_os_dir(target_os),
        terminal_agent_target_arch_dir(target_arch),
        if target_os == RemoteResourceTargetOs::Windows {
            ".exe"
        } else {
            ""
        }
    );
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
            "The bundled Terminal Agent helper is missing. Download nocturne-terminal-agent from the current app release tag {tag}?\n\n{url}"
        ),
    })
}

fn download_terminal_agent_after_confirmation(
    app: &AppHandle,
    plan: &crate::resources::ResourceHelperDownloadPlan,
) -> Result<Vec<u8>> {
    let allowed = app
        .dialog()
        .message(format!(
            "The bundled Terminal Agent helper is missing. Download nocturne-terminal-agent from the current app release tag {}?\n\n{}",
            plan.tag, plan.url
        ))
        .title("Download Terminal Agent helper")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Download".to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show();
    if !allowed {
        return Err(invalid_error(
            "Terminal Agent helper download was canceled by the user",
        ));
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(TERMINAL_AGENT_HTTP_TIMEOUT)
        .build()
        .map_err(|error| invalid_error(format!("terminal agent HTTP client failed: {error}")))?;
    let response = client
        .get(&plan.url)
        .header(reqwest::header::USER_AGENT, "Nocturne Terminal Agent")
        .send()
        .map_err(|error| invalid_error(format!("terminal agent download failed: {error}")))?;
    if !response.status().is_success() {
        return Err(invalid_error(format!(
            "terminal agent download returned HTTP {}",
            response.status()
        )));
    }
    let bytes = response
        .bytes()
        .map_err(|error| invalid_error(format!("terminal agent download read failed: {error}")))?;
    if bytes.is_empty() {
        return Err(invalid_error("downloaded Terminal Agent helper is empty"));
    }
    Ok(bytes.to_vec())
}

fn terminal_agent_candidate_paths(resource_dir: &Path, resource_path: &str) -> Vec<PathBuf> {
    vec![
        resource_dir.join(resource_path),
        resource_dir.join("resources").join(resource_path),
    ]
}

fn plan_terminal_agent_upload(
    helper_bytes: &[u8],
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
    version: &str,
) -> Result<ResourceHelperUploadPlan> {
    if helper_bytes.is_empty() {
        return Err(invalid_error("terminal agent helper bytes cannot be empty"));
    }
    let remote_directory = terminal_agent_remote_directory(version);
    let helper_upload_path = format!(
        "{}/{}",
        remote_directory,
        terminal_agent_executable_name(target_os)
    );
    let manifest_upload_path = format!("{remote_directory}/terminal-agent.manifest.json");
    let helper_sha256 = hex::encode(sha2::Sha256::digest(helper_bytes));
    let manifest = ResourceHelperManifest {
        helper_name: "nocturne-terminal-agent".to_string(),
        purpose: "Terminal detach and remote control".to_string(),
        version: version.to_string(),
        target_os,
        target_arch,
        upload_path: helper_upload_path.clone(),
        sha256: helper_sha256.clone(),
        capabilities: vec![
            "terminal.pty".to_string(),
            "terminal.detach".to_string(),
            "terminal.input".to_string(),
        ],
    };
    let manifest_json = serde_json::to_string(&manifest).map_err(|error| {
        invalid_error(format!(
            "terminal agent helper manifest JSON failed: {error}"
        ))
    })?;
    Ok(ResourceHelperUploadPlan {
        resource_path: terminal_agent_resource_path(target_os, target_arch),
        manifest,
        manifest_path: manifest_upload_path.clone(),
        remote_directory,
        helper_upload_path: helper_upload_path.clone(),
        manifest_upload_path,
        executable_mode: terminal_agent_executable_mode(target_os),
        verify_sha256_command: terminal_agent_verify_sha256_command(
            target_os,
            &helper_upload_path,
            &helper_sha256,
        ),
        launch_stream_command: terminal_agent_managed_command(
            target_os,
            &helper_upload_path,
            &["--help".to_string()],
        ),
        helper_bytes: helper_bytes.to_vec(),
        manifest_json,
    })
}

fn deploy_terminal_agent_helper(
    connection: &SftpConnection,
    plan: &ResourceHelperUploadPlan,
    home: &str,
) -> Result<String> {
    let sftp = connection.session.sftp().map_err(terminal_error)?;
    let remote_directory = expand_remote_home(&plan.remote_directory, home);
    let helper_upload_path = expand_remote_home(&plan.helper_upload_path, home);
    let manifest_upload_path = expand_remote_home(&plan.manifest_upload_path, home);
    ensure_terminal_sftp_directory(&sftp, Path::new(&remote_directory))?;
    write_terminal_sftp_file(
        &sftp,
        Path::new(&helper_upload_path),
        &plan.helper_bytes,
        0o755,
    )?;
    write_terminal_sftp_file(
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
            "uploaded Terminal Agent helper hash verification failed: {}",
            output.stderr.trim()
        )));
    }
    Ok(helper_upload_path)
}

fn remote_home_path_from_shell(
    session: &Session,
    target_os: RemoteResourceTargetOs,
) -> Result<String> {
    let output = run_remote_command(session, remote_home_path_command(target_os))?;
    let home = output.stdout.trim();
    if home.is_empty() {
        return Err(invalid_error("remote HOME is unavailable"));
    }
    Ok(home.to_string())
}

fn remote_home_path_command(target_os: RemoteResourceTargetOs) -> &'static str {
    match target_os {
        RemoteResourceTargetOs::Windows => "[Environment]::GetFolderPath('UserProfile')",
        RemoteResourceTargetOs::Linux | RemoteResourceTargetOs::Macos => "printf %s \"$HOME\"",
    }
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

fn ensure_terminal_sftp_directory(sftp: &Sftp, path: &Path) -> Result<()> {
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

fn write_terminal_sftp_file(sftp: &Sftp, path: &Path, bytes: &[u8], mode: i32) -> Result<()> {
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

fn write_terminal_agent_launch_spec_file(
    connection: &SftpConnection,
    path: &str,
    launch_spec_json: &str,
) -> Result<()> {
    let sftp = connection.session.sftp().map_err(terminal_error)?;
    if let Some(parent) = Path::new(path).parent() {
        ensure_terminal_sftp_directory(&sftp, parent)?;
    }
    write_terminal_sftp_file(&sftp, Path::new(path), launch_spec_json.as_bytes(), 0o600)
}

fn terminal_agent_resource_path(
    target_os: RemoteResourceTargetOs,
    target_arch: RemoteResourceTargetArch,
) -> String {
    format!(
        "nocturne-terminal-agent/{}/{}/{}",
        terminal_agent_target_os_dir(target_os),
        terminal_agent_target_arch_dir(target_arch),
        terminal_agent_executable_name(target_os)
    )
}

fn terminal_agent_remote_directory(version: &str) -> String {
    format!("~/.cache/nocturne/helpers/{version}/nocturne-terminal-agent")
}

fn terminal_agent_remote_launch_spec_path(
    target_os: RemoteResourceTargetOs,
    home: &str,
    session_id: &str,
) -> String {
    match target_os {
        RemoteResourceTargetOs::Windows => {
            format!(
                "{}\\AppData\\Local\\Temp\\nocturne-terminal-agent-{}.json",
                home.trim_end_matches(['\\', '/']),
                session_id
            )
        }
        RemoteResourceTargetOs::Linux | RemoteResourceTargetOs::Macos => {
            format!("/tmp/nocturne-terminal-agent-{session_id}.json")
        }
    }
}

fn remote_default_terminal_program(target_os: RemoteResourceTargetOs) -> String {
    match target_os {
        RemoteResourceTargetOs::Windows => "powershell.exe".to_string(),
        RemoteResourceTargetOs::Linux | RemoteResourceTargetOs::Macos => "/bin/sh".to_string(),
    }
}

fn terminal_agent_target_os_dir(target_os: RemoteResourceTargetOs) -> &'static str {
    match target_os {
        RemoteResourceTargetOs::Linux => "linux",
        RemoteResourceTargetOs::Macos => "macos",
        RemoteResourceTargetOs::Windows => "windows",
    }
}

fn terminal_agent_target_arch_dir(target_arch: RemoteResourceTargetArch) -> &'static str {
    match target_arch {
        RemoteResourceTargetArch::X86_64 => "x86_64",
        RemoteResourceTargetArch::Aarch64 => "aarch64",
        RemoteResourceTargetArch::Armv7 => "armv7",
        RemoteResourceTargetArch::I686 => "i686",
    }
}

fn terminal_agent_executable_name(target_os: RemoteResourceTargetOs) -> &'static str {
    match target_os {
        RemoteResourceTargetOs::Windows => "nocturne-terminal-agent.exe",
        RemoteResourceTargetOs::Linux | RemoteResourceTargetOs::Macos => "nocturne-terminal-agent",
    }
}

fn terminal_agent_executable_mode(target_os: RemoteResourceTargetOs) -> Option<u32> {
    match target_os {
        RemoteResourceTargetOs::Windows => None,
        RemoteResourceTargetOs::Linux | RemoteResourceTargetOs::Macos => Some(0o755),
    }
}

fn terminal_agent_verify_sha256_command(
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

fn terminal_agent_helper_policy(app: &AppHandle) -> Result<ResourceHelperPolicy> {
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

fn confirm_terminal_agent_upload(
    app: &AppHandle,
    host: &ConnectionHostEntry,
    plan: &ResourceHelperUploadPlan,
) -> bool {
    app.dialog()
        .message(format!(
            "Upload nocturne-terminal-agent for detachable terminals?\n\nHost: {}\nTarget: {:?} {:?}\nPath: {}\nSHA-256: {}",
            host.document.name,
            plan.manifest.target_os,
            plan.manifest.target_arch,
            plan.helper_upload_path,
            plan.manifest.sha256
        ))
        .title("Upload Terminal Agent helper")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Upload".to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show()
}

fn terminal_reader_token_matches(session_id: &str, reader_token: &str) -> bool {
    let Ok(session) = session_by_id(session_id) else {
        return false;
    };
    session.reader_token == reader_token
}

fn update_terminal_transport_state(
    app: &AppHandle,
    session_id: &str,
    state: TerminalTransportState,
) {
    let Ok(session) = session_by_id(session_id) else {
        return;
    };
    if let Ok(mut info) = session.info.lock() {
        info.transport_state = state.clone();
    };
    let _ = app.emit(
        TERMINAL_TRANSPORT_STATE_EVENT,
        TerminalTransportStateEvent {
            session_id: session_id.to_string(),
            state,
        },
    );
}

fn emit_terminal_exit(
    app: &AppHandle,
    session_id: String,
    exit_code: Option<u32>,
    signal: Option<String>,
    error: Option<ConfigError>,
) {
    remove_terminal_session(&session_id);
    let _ = app.emit(
        TERMINAL_EXIT_EVENT,
        TerminalExitEvent {
            session_id,
            exit_code,
            signal,
            error,
        },
    );
}

#[derive(Clone)]
pub(crate) struct SshWorkerInput {
    pub(crate) app: Option<AppHandle>,
    pub(crate) session_id: String,
    pub(crate) workspace_id: String,
    pub(crate) source_tool_tab_id: Option<String>,
    pub(crate) display_name: String,
    pub(crate) auth_target: SshAuthTarget,
    pub(crate) ssh: SshConnectionConfig,
    pub(crate) proxy_jump_chain: Option<Vec<SshConnectionConfig>>,
    pub(crate) username: String,
    pub(crate) size: PtySize,
    pub(crate) trust_path: PathBuf,
    pub(crate) accept_new_host_key: bool,
    pub(crate) update_changed_host_key: bool,
    pub(crate) credential: Option<SshCredentialInput>,
    pub(crate) save_credential: bool,
    pub(crate) verification_scope: SshVerificationScope,
}

#[derive(Clone)]
pub(crate) enum SshVerificationScope {
    Workspace,
    HostPortForward { host_id: String },
}

struct PreparedSshSession {
    channel: Channel,
    jump_guards: Vec<thread::JoinHandle<()>>,
}

pub(crate) struct AuthenticatedSshSession {
    pub(crate) session: Session,
    pub(crate) jump_guards: Vec<thread::JoinHandle<()>>,
    pub(crate) tcp_mode: TcpStream,
}

pub(crate) struct ProxyJumpChain {
    pub(crate) stream: TcpStream,
    pub(crate) guards: Vec<thread::JoinHandle<()>>,
}

fn spawn_ssh_worker(
    app: AppHandle,
    session_id: String,
    input: SshWorkerInput,
    receiver: Receiver<SshWorkerCommand>,
) {
    thread::spawn(move || {
        update_terminal_transport_state(&app, &session_id, TerminalTransportState::Connecting);
        let prepared = match prepare_ssh_session(&input) {
            Ok(prepared) => prepared,
            Err(error) => {
                update_terminal_transport_state(&app, &session_id, TerminalTransportState::Failed);
                emit_terminal_exit(&app, session_id, None, Some(error.to_string()), Some(error));
                return;
            }
        };
        let mut channel = prepared.channel;
        let result = run_ssh_worker(&app, &session_id, &mut channel, receiver);
        if let Err(error) = result {
            update_terminal_transport_state(&app, &session_id, TerminalTransportState::Failed);
            emit_terminal_exit(&app, session_id, None, Some(error.to_string()), Some(error));
        }
        drop(prepared.jump_guards);
    });
}

fn run_ssh_worker(
    app: &AppHandle,
    session_id: &str,
    channel: &mut Channel,
    receiver: Receiver<SshWorkerCommand>,
) -> Result<()> {
    let signal = pump_ssh_channel(app, session_id, channel, receiver)?;
    update_terminal_transport_state(app, session_id, TerminalTransportState::Disconnected);
    emit_terminal_exit(app, session_id.to_string(), Some(0), signal, None);
    Ok(())
}

fn prepare_ssh_session(input: &SshWorkerInput) -> Result<PreparedSshSession> {
    let authenticated = connect_authenticated_ssh_session(input)?;
    let mut channel = authenticated
        .session
        .channel_session()
        .map_err(terminal_error)?;
    channel
        .request_pty(
            "xterm-256color",
            None,
            Some((
                input.size.cols as u32,
                input.size.rows as u32,
                input.size.pixel_width as u32,
                input.size.pixel_height as u32,
            )),
        )
        .map_err(terminal_error)?;
    channel.shell().map_err(terminal_error)?;
    authenticated
        .tcp_mode
        .set_nonblocking(true)
        .map_err(terminal_error)?;
    authenticated.session.set_blocking(false);
    Ok(PreparedSshSession {
        channel,
        jump_guards: authenticated.jump_guards,
    })
}

pub(crate) fn connect_authenticated_ssh_session(
    input: &SshWorkerInput,
) -> Result<AuthenticatedSshSession> {
    let mut jump_guards = Vec::new();
    let tcp = if let Some(proxy_jump_chain) = input.proxy_jump_chain.as_deref() {
        let chain = connect_proxy_jump_chain(input, proxy_jump_chain)?;
        jump_guards = chain.guards;
        chain.stream
    } else if let Some(proxy_jump) = input.ssh.proxy_jump.as_deref() {
        let jumps = parse_proxy_jump_chain(proxy_jump)?;
        let chain = connect_proxy_jump_chain(input, &jumps)?;
        jump_guards = chain.guards;
        chain.stream
    } else {
        TcpStream::connect((ssh_network_hostname(&input.ssh.hostname), input.ssh.port))
            .map_err(terminal_error)?
    };
    tcp.set_nodelay(true).map_err(terminal_error)?;
    let tcp_mode = tcp.try_clone().map_err(terminal_error)?;

    let mut session = Session::new().map_err(terminal_error)?;
    session.set_tcp_stream(tcp);
    session.handshake().map_err(terminal_error)?;
    update_ssh_input_transport_state(input, TerminalTransportState::VerifyingHostKey);
    verify_ssh_host_key(&session, &input)?;
    update_ssh_input_transport_state(input, TerminalTransportState::Authenticating);
    authenticate_ssh_session(&session, input)?;
    update_ssh_input_transport_state(input, TerminalTransportState::Connected);
    Ok(AuthenticatedSshSession {
        session,
        jump_guards,
        tcp_mode,
    })
}

fn update_ssh_input_transport_state(input: &SshWorkerInput, state: TerminalTransportState) {
    if let Some(app) = &input.app {
        update_terminal_transport_state(app, &input.session_id, state);
    }
}

struct ProxyBridge {
    stream: TcpStream,
    guard: thread::JoinHandle<()>,
}

pub(crate) fn connect_proxy_jump_chain(
    input: &SshWorkerInput,
    jumps: &[SshConnectionConfig],
) -> Result<ProxyJumpChain> {
    let mut guards = Vec::new();
    let mut current_stream: Option<TcpStream> = None;
    for (index, jump) in jumps.iter().enumerate() {
        let jump_stream = if index == 0 {
            TcpStream::connect((ssh_network_hostname(&jump.hostname), jump.port))
                .map_err(terminal_error)?
        } else {
            current_stream
                .take()
                .ok_or_else(|| terminal_error("proxy jump bridge is missing"))?
        };
        let target = jumps.get(index + 1).unwrap_or(&input.ssh);
        let bridge = connect_proxy_jump_hop(input, jump, jump_stream, target)?;
        guards.push(bridge.guard);
        current_stream = Some(bridge.stream);
    }
    let final_stream = current_stream
        .take()
        .ok_or_else(|| invalid_error("ProxyJump cannot be empty"))?;
    Ok(ProxyJumpChain {
        stream: final_stream,
        guards,
    })
}

fn connect_proxy_jump_hop(
    input: &SshWorkerInput,
    jump: &SshConnectionConfig,
    jump_tcp: TcpStream,
    target: &SshConnectionConfig,
) -> Result<ProxyBridge> {
    jump_tcp.set_nodelay(true).map_err(terminal_error)?;
    let jump_tcp_mode = jump_tcp.try_clone().map_err(terminal_error)?;
    let mut jump_session = Session::new().map_err(terminal_error)?;
    jump_session.set_tcp_stream(jump_tcp);
    jump_session.handshake().map_err(terminal_error)?;
    let jump_input = SshWorkerInput {
        app: input.app.clone(),
        session_id: input.session_id.clone(),
        workspace_id: input.workspace_id.clone(),
        source_tool_tab_id: input.source_tool_tab_id.clone(),
        display_name: format!("{} via {}", input.display_name, jump.hostname),
        auth_target: proxy_jump_auth_target(
            jump.username.as_deref().unwrap_or(&input.username),
            &jump.hostname,
            jump.port,
        ),
        ssh: jump.clone(),
        proxy_jump_chain: None,
        username: jump
            .username
            .clone()
            .unwrap_or_else(|| input.username.clone()),
        size: input.size,
        trust_path: input.trust_path.clone(),
        accept_new_host_key: input.accept_new_host_key,
        update_changed_host_key: input.update_changed_host_key,
        credential: None,
        save_credential: input.save_credential,
        verification_scope: input.verification_scope.clone(),
    };
    verify_ssh_host_key(&jump_session, &jump_input)?;
    authenticate_ssh_session(&jump_session, &jump_input)?;
    let remote = jump_session
        .channel_direct_tcpip(ssh_network_hostname(&target.hostname), target.port, None)
        .map_err(terminal_error)?;
    jump_session.set_blocking(false);
    jump_tcp_mode
        .set_nonblocking(true)
        .map_err(terminal_error)?;
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(terminal_error)?;
    let local_addr = listener.local_addr().map_err(terminal_error)?;
    let session_id = input.session_id.clone();
    let guard = thread::spawn(move || {
        if let Ok((local, _)) = listener.accept() {
            bridge_proxy_channel(local, remote);
        }
        drop(jump_session);
        let _ = session_id;
    });
    let stream = TcpStream::connect(local_addr).map_err(terminal_error)?;
    Ok(ProxyBridge { stream, guard })
}

pub(crate) fn bridge_proxy_channel(mut local: TcpStream, mut remote: Channel) {
    bridge_proxy_channel_inner(&mut local, &mut remote, None);
}

pub(crate) fn bridge_proxy_channel_until_stopped(
    mut local: TcpStream,
    mut remote: Channel,
    stop: Arc<AtomicBool>,
) {
    bridge_proxy_channel_inner(&mut local, &mut remote, Some(stop));
}

fn bridge_proxy_channel_inner(
    local: &mut TcpStream,
    remote: &mut Channel,
    stop: Option<Arc<AtomicBool>>,
) {
    let _ = local.set_nonblocking(true);
    let mut local_buffer = [0_u8; 8192];
    let mut remote_buffer = [0_u8; 8192];
    let mut pending_remote_writes = VecDeque::new();
    let mut pending_local_writes = VecDeque::new();
    loop {
        if stop
            .as_ref()
            .is_some_and(|stop| stop.load(Ordering::SeqCst))
        {
            break;
        }
        let mut progressed = false;
        match drain_ssh_pending_writes(remote, &mut pending_remote_writes) {
            Ok(true) => progressed = true,
            Ok(false) => {}
            Err(_) => break,
        }
        match drain_tcp_pending_writes(local, &mut pending_local_writes) {
            Ok(true) => progressed = true,
            Ok(false) => {}
            Err(_) => break,
        }
        match local.read(&mut local_buffer) {
            Ok(0) => break,
            Ok(size) => {
                progressed = true;
                if queue_pending_bytes(&mut pending_remote_writes, &local_buffer[..size]).is_err() {
                    break;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => break,
        }
        match remote.read(&mut remote_buffer) {
            Ok(0) => {
                if remote.eof() {
                    break;
                }
            }
            Ok(size) => {
                progressed = true;
                if queue_pending_bytes(&mut pending_local_writes, &remote_buffer[..size]).is_err() {
                    break;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => break,
        }
        if !progressed {
            thread::sleep(Duration::from_millis(5));
        }
    }
    let _ = local.shutdown(std::net::Shutdown::Both);
    let _ = remote.close();
}

fn parse_proxy_jump_chain(value: &str) -> Result<Vec<SshConnectionConfig>> {
    let jumps = value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(parse_proxy_jump_hop)
        .collect::<Result<Vec<_>>>()?;
    if jumps.is_empty() {
        return Err(invalid_error("ProxyJump cannot be empty"));
    }
    Ok(jumps)
}

fn parse_proxy_jump_hop(value: &str) -> Result<SshConnectionConfig> {
    let (username, host_port) = match value.rsplit_once('@') {
        Some((user, host)) if !user.trim().is_empty() => (Some(user.to_string()), host),
        _ => (None, value),
    };
    let (hostname, port) = parse_host_port(host_port, 22)?;
    Ok(SshConnectionConfig {
        hostname,
        port,
        username,
        identity_file: None,
        proxy_jump: None,
        forward_agent: false,
        server_alive_interval: None,
    })
}

pub(crate) fn ssh_network_hostname(hostname: &str) -> &str {
    hostname
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .filter(|inner| inner.contains(':'))
        .unwrap_or(hostname)
}

fn parse_host_port(value: &str, default_port: u16) -> Result<(String, u16)> {
    if let Some(rest) = value.strip_prefix('[') {
        if let Some((host, port_text)) = rest.split_once("]:") {
            let port = port_text
                .parse::<u16>()
                .map_err(|_| invalid_error("invalid ProxyJump port"))?;
            return Ok((host.to_string(), port));
        }
        if let Some(host) = rest.strip_suffix(']').filter(|host| host.contains(':')) {
            return Ok((host.to_string(), default_port));
        }
        return Err(invalid_error("invalid bracketed host:port"));
    }
    if let Some((host, port_text)) = value.rsplit_once(':') {
        if !host.contains(':') {
            let port = port_text
                .parse::<u16>()
                .map_err(|_| invalid_error("invalid ProxyJump port"))?;
            return Ok((host.to_string(), port));
        }
    }
    Ok((value.to_string(), default_port))
}

fn pump_ssh_channel(
    app: &AppHandle,
    session_id: &str,
    channel: &mut Channel,
    receiver: Receiver<SshWorkerCommand>,
) -> Result<Option<String>> {
    let mut buffer = [0_u8; 8192];
    let mut pending_writes = VecDeque::new();
    loop {
        for _ in 0..16 {
            match receiver.try_recv() {
                Ok(command) => {
                    if matches!(
                        handle_ssh_worker_command(channel, &mut pending_writes, command)?,
                        SshPumpAction::Closed
                    ) {
                        return Ok(Some("closed".to_string()));
                    }
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    let _ = channel.close();
                    return Ok(Some("closed".to_string()));
                }
            }
        }
        let wrote = drain_ssh_pending_writes(channel, &mut pending_writes)?;
        match channel.read(&mut buffer) {
            Ok(0) => {
                if channel.eof() {
                    return Ok(None);
                }
            }
            Ok(size) => {
                let sequence = push_output_backlog(session_id, &buffer[..size]);
                app.emit(
                    TERMINAL_OUTPUT_EVENT,
                    TerminalOutputEvent {
                        session_id: session_id.to_string(),
                        sequence: sequence.to_string(),
                        backlog: false,
                        data: BASE64_STANDARD.encode(&buffer[..size]),
                    },
                )
                .map_err(terminal_error)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if wrote {
                    continue;
                }
                thread::sleep(Duration::from_millis(12));
            }
            Err(error) => return Err(terminal_error(error)),
        }
    }
}

fn handle_ssh_worker_command(
    channel: &mut Channel,
    pending_writes: &mut VecDeque<u8>,
    command: SshWorkerCommand,
) -> Result<SshPumpAction> {
    match command {
        SshWorkerCommand::Write(bytes) => {
            queue_pending_bytes(pending_writes, &bytes)?;
            drain_ssh_pending_writes(channel, pending_writes)?;
            Ok(SshPumpAction::Continue)
        }
        SshWorkerCommand::Resize(size) => {
            channel
                .request_pty_size(
                    size.cols as u32,
                    size.rows as u32,
                    Some(size.pixel_width as u32),
                    Some(size.pixel_height as u32),
                )
                .map_err(terminal_error)?;
            Ok(SshPumpAction::Continue)
        }
        SshWorkerCommand::Close => {
            let _ = channel.close();
            Ok(SshPumpAction::Closed)
        }
    }
}

fn queue_pending_bytes(pending: &mut VecDeque<u8>, bytes: &[u8]) -> Result<()> {
    if pending.len().saturating_add(bytes.len()) > SSH_PENDING_WRITE_LIMIT {
        return Err(terminal_error(format!(
            "ssh input buffer exceeded {} bytes",
            SSH_PENDING_WRITE_LIMIT
        )));
    }
    pending.extend(bytes);
    Ok(())
}

fn drain_ssh_pending_writes(channel: &mut Channel, pending: &mut VecDeque<u8>) -> Result<bool> {
    let mut progressed = false;
    for _ in 0..16 {
        if pending.is_empty() {
            break;
        }
        let write_len = pending.len().min(SSH_WRITE_CHUNK_LIMIT);
        let written = {
            let contiguous = pending.make_contiguous();
            match channel.write(&contiguous[..write_len]) {
                Ok(0) => break,
                Ok(size) => size,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) => return Err(terminal_error(error)),
            }
        };
        pending.drain(..written);
        progressed = true;
    }
    Ok(progressed)
}

fn drain_tcp_pending_writes(
    stream: &mut TcpStream,
    pending: &mut VecDeque<u8>,
) -> std::io::Result<bool> {
    let mut progressed = false;
    for _ in 0..16 {
        if pending.is_empty() {
            break;
        }
        let write_len = pending.len().min(SSH_WRITE_CHUNK_LIMIT);
        let written = {
            let contiguous = pending.make_contiguous();
            match stream.write(&contiguous[..write_len]) {
                Ok(0) => break,
                Ok(size) => size,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) => return Err(error),
            }
        };
        pending.drain(..written);
        progressed = true;
    }
    Ok(progressed)
}

pub(crate) fn authenticate_ssh_session(session: &Session, input: &SshWorkerInput) -> Result<()> {
    let username = &input.username;
    if session.userauth_agent(username).is_ok() && session.authenticated() {
        return Ok(());
    }
    if let Some(identity_file) = input.ssh.identity_file.as_deref() {
        let expanded = expand_terminal_home(identity_file);
        let path = Path::new(&expanded);
        if session
            .userauth_pubkey_file(username, None, path, None)
            .is_ok()
            && session.authenticated()
        {
            return Ok(());
        }
        if let Some(passphrase) = read_scoped_temporary_credential(
            input,
            SshCredentialKind::KeyPassphrase,
            input.ssh.identity_file.as_deref(),
        )? {
            if session
                .userauth_pubkey_file(username, None, path, Some(passphrase.as_str()))
                .is_ok()
                && session.authenticated()
            {
                return Ok(());
            }
            remove_scoped_temporary_credential(
                input,
                SshCredentialKind::KeyPassphrase,
                input.ssh.identity_file.as_deref(),
            )?;
            let credential = request_credential_from_scope(
                input,
                SshCredentialKind::KeyPassphrase,
                input.ssh.identity_file.clone(),
            )?;
            if session
                .userauth_pubkey_file(
                    username,
                    None,
                    path,
                    Some(credential.credential.value.as_str()),
                )
                .is_ok()
                && session.authenticated()
            {
                store_scoped_temporary_credential(
                    input,
                    SshCredentialKind::KeyPassphrase,
                    input.ssh.identity_file.as_deref(),
                    &credential.credential,
                )?;
                if credential.save_credential {
                    write_ssh_secret_to_keyring(
                        &input.auth_target,
                        SshCredentialKind::KeyPassphrase,
                        input.ssh.identity_file.as_deref(),
                        credential.credential.value.as_str(),
                    )?;
                }
                return Ok(());
            }
            return Err(credential_challenge_error(
                input,
                SshCredentialKind::KeyPassphrase,
                input.ssh.identity_file.clone(),
            ));
        }
        if matches!(
            input.credential.as_ref().map(|credential| &credential.kind),
            Some(SshCredentialKind::KeyPassphrase)
        ) {
            let passphrase = input
                .credential
                .as_ref()
                .ok_or_else(|| terminal_error("missing ssh key passphrase"))?
                .value
                .as_str();
            if session
                .userauth_pubkey_file(username, None, path, Some(passphrase))
                .is_ok()
                && session.authenticated()
            {
                store_scoped_temporary_credential(
                    input,
                    SshCredentialKind::KeyPassphrase,
                    input.ssh.identity_file.as_deref(),
                    input.credential.as_ref().unwrap(),
                )?;
                if input.save_credential {
                    write_ssh_secret_to_keyring(
                        &input.auth_target,
                        SshCredentialKind::KeyPassphrase,
                        input.ssh.identity_file.as_deref(),
                        passphrase,
                    )?;
                }
                return Ok(());
            }
        }
        if let Some(passphrase) = read_ssh_secret_from_keyring(
            &input.auth_target,
            SshCredentialKind::KeyPassphrase,
            input.ssh.identity_file.as_deref(),
        ) {
            if session
                .userauth_pubkey_file(username, None, path, Some(&passphrase))
                .is_ok()
                && session.authenticated()
            {
                store_scoped_temporary_credential(
                    input,
                    SshCredentialKind::KeyPassphrase,
                    input.ssh.identity_file.as_deref(),
                    &SshCredentialInput {
                        kind: SshCredentialKind::KeyPassphrase,
                        value: passphrase,
                    },
                )?;
                return Ok(());
            }
        }
    }

    if let Some(password) =
        read_scoped_temporary_credential(input, SshCredentialKind::Password, None)?
    {
        if session
            .userauth_password(username, password.as_str())
            .is_ok()
            && session.authenticated()
        {
            return Ok(());
        }
        remove_scoped_temporary_credential(input, SshCredentialKind::Password, None)?;
        let credential = request_credential_from_scope(input, SshCredentialKind::Password, None)?;
        if session
            .userauth_password(username, credential.credential.value.as_str())
            .is_ok()
            && session.authenticated()
        {
            store_scoped_temporary_credential(
                input,
                SshCredentialKind::Password,
                None,
                &credential.credential,
            )?;
            if credential.save_credential {
                write_ssh_secret_to_keyring(
                    &input.auth_target,
                    SshCredentialKind::Password,
                    None,
                    credential.credential.value.as_str(),
                )?;
            }
            return Ok(());
        }
        return Err(credential_challenge_error(
            input,
            SshCredentialKind::Password,
            None,
        ));
    }
    if matches!(
        input.credential.as_ref().map(|credential| &credential.kind),
        Some(SshCredentialKind::Password)
    ) {
        let password = input
            .credential
            .as_ref()
            .ok_or_else(|| terminal_error("missing ssh password"))?
            .value
            .as_str();
        if session.userauth_password(username, password).is_ok() && session.authenticated() {
            store_scoped_temporary_credential(
                input,
                SshCredentialKind::Password,
                None,
                input.credential.as_ref().unwrap(),
            )?;
            if input.save_credential {
                write_ssh_secret_to_keyring(
                    &input.auth_target,
                    SshCredentialKind::Password,
                    None,
                    password,
                )?;
            }
            return Ok(());
        }
    }
    if let Some(password) =
        read_ssh_secret_from_keyring(&input.auth_target, SshCredentialKind::Password, None)
    {
        if session.userauth_password(username, &password).is_ok() && session.authenticated() {
            store_scoped_temporary_credential(
                input,
                SshCredentialKind::Password,
                None,
                &SshCredentialInput {
                    kind: SshCredentialKind::Password,
                    value: password,
                },
            )?;
            return Ok(());
        }
    }

    let methods = session.auth_methods(username).unwrap_or("");
    if input.ssh.identity_file.is_some() && methods.contains("publickey") {
        let credential = request_credential_from_scope(
            input,
            SshCredentialKind::KeyPassphrase,
            input.ssh.identity_file.clone(),
        )?;
        let identity_file = input
            .ssh
            .identity_file
            .as_deref()
            .ok_or_else(|| terminal_error("missing ssh identity file"))?;
        let expanded = expand_terminal_home(identity_file);
        let path = Path::new(&expanded);
        if session
            .userauth_pubkey_file(
                username,
                None,
                path,
                Some(credential.credential.value.as_str()),
            )
            .is_ok()
            && session.authenticated()
        {
            store_scoped_temporary_credential(
                input,
                SshCredentialKind::KeyPassphrase,
                input.ssh.identity_file.as_deref(),
                &credential.credential,
            )?;
            if credential.save_credential {
                write_ssh_secret_to_keyring(
                    &input.auth_target,
                    SshCredentialKind::KeyPassphrase,
                    input.ssh.identity_file.as_deref(),
                    credential.credential.value.as_str(),
                )?;
            }
            return Ok(());
        }
        return Err(credential_challenge_error(
            input,
            SshCredentialKind::KeyPassphrase,
            input.ssh.identity_file.clone(),
        ));
    }
    if methods.contains("password") || methods.contains("keyboard-interactive") {
        let credential = request_credential_from_scope(input, SshCredentialKind::Password, None)?;
        if session
            .userauth_password(username, credential.credential.value.as_str())
            .is_ok()
            && session.authenticated()
        {
            store_scoped_temporary_credential(
                input,
                SshCredentialKind::Password,
                None,
                &credential.credential,
            )?;
            if credential.save_credential {
                write_ssh_secret_to_keyring(
                    &input.auth_target,
                    SshCredentialKind::Password,
                    None,
                    credential.credential.value.as_str(),
                )?;
            }
            return Ok(());
        }
        return Err(credential_challenge_error(
            input,
            SshCredentialKind::Password,
            None,
        ));
    }
    Err(terminal_error(format!(
        "ssh authentication failed; supported methods: {methods}"
    )))
}

fn credential_challenge_error(
    input: &SshWorkerInput,
    kind: SshCredentialKind,
    identity_file: Option<String>,
) -> ConfigError {
    let challenge = SshCredentialChallenge {
        workspace_id: input.workspace_id.clone(),
        source_tool_tab_id: input.source_tool_tab_id.clone(),
        auth_target: input.auth_target.clone(),
        credential_kind: kind,
        identity_file,
    };
    ssh_workspace_challenge_error(
        SshWorkspaceChallenge::Credential { challenge },
        format!("SSH credential required for {}", input.auth_target.label),
    )
}

struct WorkspaceCredentialResponse {
    credential: SshCredentialInput,
    save_credential: bool,
}

fn scoped_credential_key(
    input: &SshWorkerInput,
    kind: SshCredentialKind,
    identity_file: Option<&str>,
) -> WorkspaceCredentialKey {
    WorkspaceCredentialKey::new(&input.workspace_id, &input.auth_target, kind, identity_file)
}

fn read_scoped_temporary_credential(
    input: &SshWorkerInput,
    kind: SshCredentialKind,
    identity_file: Option<&str>,
) -> Result<Option<zeroize::Zeroizing<String>>> {
    match &input.verification_scope {
        SshVerificationScope::Workspace => {
            let key = scoped_credential_key(input, kind, identity_file);
            workspace_ssh_coordinator().read_workspace_encrypted_temporary_credential(&key)
        }
        SshVerificationScope::HostPortForward { host_id } => {
            crate::port_forwarding::read_host_port_forward_credential(
                host_id,
                &input.auth_target,
                kind,
                identity_file,
            )
        }
    }
}

fn store_scoped_temporary_credential(
    input: &SshWorkerInput,
    kind: SshCredentialKind,
    identity_file: Option<&str>,
    credential: &SshCredentialInput,
) -> Result<()> {
    match &input.verification_scope {
        SshVerificationScope::Workspace => {
            let key = scoped_credential_key(input, kind, identity_file);
            workspace_ssh_coordinator().store_prompt_credential_after_success(key, credential)
        }
        SshVerificationScope::HostPortForward { host_id } => {
            crate::port_forwarding::store_host_port_forward_credential(
                host_id,
                &input.auth_target,
                kind,
                identity_file,
                credential,
            )
        }
    }
}

fn remove_scoped_temporary_credential(
    input: &SshWorkerInput,
    kind: SshCredentialKind,
    identity_file: Option<&str>,
) -> Result<()> {
    match &input.verification_scope {
        SshVerificationScope::Workspace => {
            let key = scoped_credential_key(input, kind, identity_file);
            workspace_ssh_coordinator().remove_workspace_encrypted_temporary_credential(&key)
        }
        SshVerificationScope::HostPortForward { host_id } => {
            crate::port_forwarding::remove_host_port_forward_credential(
                host_id,
                &input.auth_target,
                kind,
                identity_file,
            )
        }
    }
}

fn request_credential_from_scope(
    input: &SshWorkerInput,
    kind: SshCredentialKind,
    identity_file: Option<String>,
) -> Result<WorkspaceCredentialResponse> {
    let ConfigError::SshWorkspaceChallenge { challenge, message } =
        credential_challenge_error(input, kind, identity_file)
    else {
        return Err(terminal_error("failed to create SSH credential challenge"));
    };
    update_ssh_input_transport_state(
        input,
        TerminalTransportState::WaitingForWorkspaceVerification,
    );
    let response = match &input.verification_scope {
        SshVerificationScope::Workspace => {
            workspace_ssh_coordinator().request_verification(input.app.as_ref(), challenge)?
        }
        SshVerificationScope::HostPortForward { host_id } => {
            crate::port_forwarding::request_host_port_forward_ssh_verification(
                input.app.as_ref(),
                host_id,
                workspace_challenge_to_host_scoped(challenge)?,
            )?
        }
    };
    update_ssh_input_transport_state(input, TerminalTransportState::Authenticating);
    match response {
        WorkspaceSshVerificationResponse::Credential {
            credential,
            save_credential,
        } => Ok(WorkspaceCredentialResponse {
            credential,
            save_credential,
        }),
        WorkspaceSshVerificationResponse::Cancel => {
            Err(terminal_error("SSH verification canceled"))
        }
        WorkspaceSshVerificationResponse::HostKey { .. } => Err(terminal_error(format!(
            "{message}: received a host-key response for a credential challenge"
        ))),
    }
}

fn workspace_challenge_to_host_scoped(
    challenge: SshWorkspaceChallenge,
) -> Result<SshHostScopedChallenge> {
    match challenge {
        SshWorkspaceChallenge::Credential { challenge } => {
            Ok(SshHostScopedChallenge::Credential { challenge })
        }
        SshWorkspaceChallenge::HostKey { challenge } => {
            Ok(SshHostScopedChallenge::HostKey { challenge })
        }
    }
}

pub(crate) fn verify_ssh_host_key(session: &Session, input: &SshWorkerInput) -> Result<()> {
    let (algorithm, fingerprint) = ssh_host_key_fingerprint(session)?;
    let key = format!("{algorithm} {fingerprint}");
    let target = ssh_trust_target(&input.ssh.hostname, input.ssh.port);
    let mut store = SshTrustStore::load(&input.trust_path)?;
    store.normalize();
    if store.contains_key(&target, &key) {
        return Ok(());
    }
    if store.has_target_algorithm(&target, &algorithm) && !input.update_changed_host_key {
        let challenge = SshHostKeyChallenge {
            workspace_id: input.workspace_id.clone(),
            source_tool_tab_id: input.source_tool_tab_id.clone(),
            auth_target: input.auth_target.clone(),
            challenge_kind: SshHostKeyChallengeKind::Changed,
            target: target.clone(),
            algorithm: algorithm.clone(),
            fingerprint: fingerprint.clone(),
        };
        let response = request_host_key_from_scope(input, challenge)?;
        if !response.update_changed_host_key {
            return Err(terminal_error("SSH host key changed. Connection canceled."));
        }
        store.upsert_key(target, key);
        return store.save(&input.trust_path);
    }
    if !store.has_target_algorithm(&target, &algorithm) && !input.accept_new_host_key {
        let challenge = SshHostKeyChallenge {
            workspace_id: input.workspace_id.clone(),
            source_tool_tab_id: input.source_tool_tab_id.clone(),
            auth_target: input.auth_target.clone(),
            challenge_kind: SshHostKeyChallengeKind::Unknown,
            target: target.clone(),
            algorithm: algorithm.clone(),
            fingerprint: fingerprint.clone(),
        };
        let response = request_host_key_from_scope(input, challenge)?;
        if !response.accept_new_host_key {
            return Err(terminal_error(
                "SSH host key was not trusted. Connection canceled.",
            ));
        }
        store.upsert_key(target, key);
        return store.save(&input.trust_path);
    }
    store.upsert_key(target, key);
    store.save(&input.trust_path)
}

struct WorkspaceHostKeyResponse {
    accept_new_host_key: bool,
    update_changed_host_key: bool,
}

fn request_host_key_from_scope(
    input: &SshWorkerInput,
    challenge: SshHostKeyChallenge,
) -> Result<WorkspaceHostKeyResponse> {
    update_ssh_input_transport_state(
        input,
        TerminalTransportState::WaitingForWorkspaceVerification,
    );
    let response = match &input.verification_scope {
        SshVerificationScope::Workspace => workspace_ssh_coordinator().request_verification(
            input.app.as_ref(),
            SshWorkspaceChallenge::HostKey { challenge },
        )?,
        SshVerificationScope::HostPortForward { host_id } => {
            crate::port_forwarding::request_host_port_forward_ssh_verification(
                input.app.as_ref(),
                host_id,
                SshHostScopedChallenge::HostKey { challenge },
            )?
        }
    };
    update_ssh_input_transport_state(input, TerminalTransportState::VerifyingHostKey);
    match response {
        WorkspaceSshVerificationResponse::HostKey {
            accept_new_host_key,
            update_changed_host_key,
        } => Ok(WorkspaceHostKeyResponse {
            accept_new_host_key,
            update_changed_host_key,
        }),
        WorkspaceSshVerificationResponse::Cancel => {
            Err(terminal_error("SSH verification canceled"))
        }
        WorkspaceSshVerificationResponse::Credential { .. } => Err(terminal_error(
            "SSH host-key verification received a credential response",
        )),
    }
}

fn ssh_host_key_fingerprint(session: &Session) -> Result<(String, String)> {
    let (_, kind) = session
        .host_key()
        .ok_or_else(|| terminal_error("ssh host key is unavailable"))?;
    let algorithm = ssh_host_key_algorithm(kind);
    let hash = session
        .host_key_hash(HashType::Sha256)
        .ok_or_else(|| terminal_error("ssh host key SHA256 fingerprint is unavailable"))?;
    Ok((
        algorithm.to_string(),
        format!(
            "SHA256:{}",
            BASE64_STANDARD.encode(hash).trim_end_matches('=')
        ),
    ))
}

fn ssh_host_key_algorithm(kind: HostKeyType) -> &'static str {
    match kind {
        HostKeyType::Rsa => "ssh-rsa",
        HostKeyType::Dss => "ssh-dss",
        HostKeyType::Ecdsa256 => "ecdsa-sha2-nistp256",
        HostKeyType::Ecdsa384 => "ecdsa-sha2-nistp384",
        HostKeyType::Ecdsa521 => "ecdsa-sha2-nistp521",
        HostKeyType::Ed25519 => "ssh-ed25519",
        HostKeyType::Unknown => "unknown",
    }
}

pub(crate) fn default_ssh_username(config: &SshConnectionConfig) -> Result<String> {
    let username = config.username.clone().unwrap_or_else(|| {
        env::var("USER")
            .or_else(|_| env::var("USERNAME"))
            .unwrap_or_default()
    });
    if username.trim().is_empty() {
        return Err(invalid_error("ssh username is required"));
    }
    Ok(username)
}

fn ssh_command_label(username: &str, config: &SshConnectionConfig) -> String {
    format!(
        "ssh {username}@{}",
        ssh_trust_target(&config.hostname, config.port)
    )
}

fn validate_connection_host_for_terminal(host: &ConnectionHostEntry) -> Result<()> {
    if host
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == ConnectionDiagnosticSeverity::Error)
    {
        return Err(invalid_error("connection host has blocking diagnostics"));
    }
    Ok(())
}

fn expand_terminal_home(value: &str) -> String {
    if value == "~" {
        return dirs::home_dir()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|| value.to_string());
    }
    if let Some(rest) = value.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    value.to_string()
}

#[tauri::command]
#[specta::specta]
pub(crate) fn get_terminal_settings(app: AppHandle) -> Result<TerminalSettings> {
    terminal_settings_from_config(&app, &effective_application_config(&app)?, None)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn get_terminal_settings_for_theme(
    app: AppHandle,
    input: TerminalSettingsInput,
) -> Result<TerminalSettings> {
    let resolved_theme = input.resolved_theme;
    let config = effective_application_config(&app)?;
    terminal_settings_from_config(&app, &config, resolved_theme)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn create_host_terminal_session(
    app: AppHandle,
    input: CreateHostTerminalSessionInput,
) -> Result<TerminalSessionInfo> {
    let size = validated_pty_size(
        input.cols,
        input.rows,
        input.pixel_width,
        input.pixel_height,
    )?;
    let host_id = workspace::owned_workspace_tool_host_for_kinds(
        &app,
        &input.workspace_id,
        &input.tool_tab_id,
        &[
            crate::types::WorkspaceToolKind::Terminal,
            crate::types::WorkspaceToolKind::TerminalSessions,
        ],
    )?;
    let host = connection_host_by_id(&app, &host_id)?;
    validate_connection_host_for_terminal(&host)?;
    if matches!(
        effective_terminal_agent_mode(&host),
        TerminalAgentMode::Enabled
    ) {
        return create_agent_host_terminal_session(app, input, host, size);
    }
    match host.document.protocol {
        ConnectionProtocol::Local => create_local_host_terminal_session(app, input, host, size),
        ConnectionProtocol::Ssh => create_ssh_host_terminal_session(app, input, host, size),
        ConnectionProtocol::Telnet => Err(invalid_error("telnet sessions are not implemented yet")),
    }
}

fn create_agent_host_terminal_session(
    app: AppHandle,
    input: CreateHostTerminalSessionInput,
    host: ConnectionHostEntry,
    size: PtySize,
) -> Result<TerminalSessionInfo> {
    match host.document.protocol {
        ConnectionProtocol::Local => {
            create_local_agent_host_terminal_session(app, input, host, size)
        }
        ConnectionProtocol::Ssh => create_ssh_agent_host_terminal_session(app, input, host, size),
        ConnectionProtocol::Telnet => Err(invalid_error(
            "Terminal Agent mode is not supported for telnet hosts",
        )),
    }
}

fn create_local_agent_host_terminal_session(
    app: AppHandle,
    input: CreateHostTerminalSessionInput,
    host: ConnectionHostEntry,
    size: PtySize,
) -> Result<TerminalSessionInfo> {
    let config = effective_application_config(&app)?;
    let mut settings = terminal_settings_from_config(&app, &config, input.resolved_theme)?;
    let mut env_overrides = terminal_env_from_config(&config)?;
    let local = host
        .document
        .local
        .clone()
        .ok_or_else(|| invalid_error("local connection host requires local config"))?;
    apply_local_host_config(&mut settings, &local);
    env_overrides.extend(local.env);
    let command_label = terminal_command_label(&settings);
    let state = terminal_state();
    let (_session_number, id) = next_terminal_session_id(&state);
    let title = random_terminal_agent_session_title(&id);
    let spec = build_go_terminal_agent_launch_spec(
        &id,
        &host.id,
        &title,
        &settings,
        input.cwd.as_deref(),
        &env_overrides,
        size,
    );
    let spec_json = serde_json::to_string(&spec).map_err(terminal_error)?;
    let helper_path = local_terminal_agent_helper_path(&app)?;
    let mut agent_process = Some(spawn_local_go_terminal_agent(&helper_path, &spec_json)?);
    let launch_status = wait_for_local_go_terminal_agent(&helper_path, &host.id, &id)?;
    let reader_token = uuid::Uuid::new_v4().to_string();
    let info = match &launch_status {
        LocalGoAgentLaunchStatus::Running => TerminalSessionInfo {
            id: id.clone(),
            title,
            command: command_label,
            cwd: input.cwd.or(settings.cwd),
            cols: input.cols,
            rows: input.rows,
            pixel_width: input.pixel_width,
            pixel_height: input.pixel_height,
            process_id: None,
            transport: TerminalTransportKind::Agent,
            transport_state: TerminalTransportState::Connected,
            agent: Some(TerminalAgentSessionInfo {
                session_id: id.clone(),
            }),
        },
        LocalGoAgentLaunchStatus::Exited(listed) => {
            terminal_history_session_info_from_go_session(listed, id.clone())
        }
    };
    let backend = match launch_status {
        LocalGoAgentLaunchStatus::Running => TerminalBackend::Agent {
            session_id: id.clone(),
            helper_path: helper_path.clone(),
            agent_process: agent_process.take(),
            local_control: None,
            remote: None,
        },
        LocalGoAgentLaunchStatus::Exited(_) => {
            if let Some(mut child) = agent_process.take() {
                let _ = child.wait();
            }
            TerminalBackend::AgentHistory {
                registry_session_id: id.clone(),
            }
        }
    };
    let session = Arc::new(TerminalSession {
        backend: Mutex::new(backend),
        info: Mutex::new(info.clone()),
        host_id: host.id.clone(),
        reader_token: reader_token.clone(),
        window_label: Mutex::new(input.window_label),
        output_backlog: Mutex::new(Vec::new()),
        output_sequence: Mutex::new(0),
        output_backlog_start_sequence: Mutex::new(0),
    });
    {
        let mut sessions = state.sessions.lock().unwrap();
        sessions.insert(id.clone(), session.clone());
    }
    let should_spawn_live_reader = matches!(
        &*session.backend.lock().unwrap(),
        TerminalBackend::Agent { .. }
    );
    if should_spawn_live_reader {
        let local_control =
            spawn_local_go_agent_terminal_reader(app, id.clone(), id, helper_path, reader_token);
        if let Ok(mut backend) = session.backend.lock() {
            if let TerminalBackend::Agent {
                local_control: slot,
                ..
            } = &mut *backend
            {
                *slot = Some(local_control);
            }
        }
    } else {
        spawn_local_go_agent_history_reader(app, id.clone(), id, helper_path, reader_token);
    }
    Ok(info)
}

fn create_ssh_agent_host_terminal_session(
    app: AppHandle,
    input: CreateHostTerminalSessionInput,
    host: ConnectionHostEntry,
    size: PtySize,
) -> Result<TerminalSessionInfo> {
    let config = effective_application_config(&app)?;
    let mut settings = terminal_settings_from_config(&app, &config, input.resolved_theme)?;
    let env_overrides = terminal_env_from_config(&config)?;
    let state = terminal_state();
    let (_session_number, id) = next_terminal_session_id(&state);
    let prepared = prepare_remote_terminal_agent_runtime(
        &app,
        &host,
        &input.workspace_id,
        Some(&input.tool_tab_id),
        &id,
        size,
        input.accept_new_host_key,
        input.update_changed_host_key,
        input.credential.clone(),
        input.save_credential,
    )?;
    let runtime = prepared.runtime;
    if settings.command.is_none() {
        settings.command = Some(remote_default_terminal_program(runtime.target_os));
    }
    let command_label = terminal_command_label(&settings);
    let title = random_terminal_agent_session_title(&id);
    let spec = build_go_terminal_agent_launch_spec(
        &id,
        &host.id,
        &title,
        &settings,
        input.cwd.as_deref(),
        &env_overrides,
        size,
    );
    let spec_json = serde_json::to_string(&spec).map_err(terminal_error)?;
    let home = remote_home_path_from_shell(&prepared.connection.session, runtime.target_os)?;
    let launch_spec_path = terminal_agent_remote_launch_spec_path(runtime.target_os, &home, &id);
    write_terminal_agent_launch_spec_file(&prepared.connection, &launch_spec_path, &spec_json)?;
    let launch = go_terminal_agent_launch_background_command(
        runtime.target_os,
        &runtime.helper_path,
        &launch_spec_path,
    );
    let launch_output = run_remote_command(&prepared.connection.session, &launch)?;
    if launch_output.status != 0 {
        return Err(terminal_error(format!(
            "failed to start remote Terminal Agent: {}",
            launch_output.stderr.trim()
        )));
    }
    wait_for_remote_go_terminal_agent(
        &prepared.connection.session,
        runtime.target_os,
        &runtime.helper_path,
        &id,
    )?;
    let remote_backend = remote_agent_backend(runtime.clone());
    let reader_token = uuid::Uuid::new_v4().to_string();
    let info = TerminalSessionInfo {
        id: id.clone(),
        title,
        command: command_label,
        cwd: input.cwd.or(settings.cwd),
        cols: input.cols,
        rows: input.rows,
        pixel_width: input.pixel_width,
        pixel_height: input.pixel_height,
        process_id: None,
        transport: TerminalTransportKind::Agent,
        transport_state: TerminalTransportState::Connected,
        agent: Some(TerminalAgentSessionInfo {
            session_id: id.clone(),
        }),
    };
    let session = Arc::new(TerminalSession {
        backend: Mutex::new(TerminalBackend::Agent {
            session_id: id.clone(),
            helper_path: runtime.helper_path.clone(),
            agent_process: None,
            local_control: None,
            remote: Some(remote_backend.clone()),
        }),
        info: Mutex::new(info.clone()),
        host_id: host.id.clone(),
        reader_token: reader_token.clone(),
        window_label: Mutex::new(input.window_label),
        output_backlog: Mutex::new(Vec::new()),
        output_sequence: Mutex::new(0),
        output_backlog_start_sequence: Mutex::new(0),
    });
    state
        .sessions
        .lock()
        .map_err(|_| invalid_error("terminal sessions lock poisoned"))?
        .insert(id.clone(), session);
    spawn_remote_agent_terminal_reader(
        app,
        id,
        reader_token,
        runtime,
        remote_backend.live_control.clone(),
    );
    Ok(info)
}

fn create_local_host_terminal_session(
    app: AppHandle,
    input: CreateHostTerminalSessionInput,
    host: ConnectionHostEntry,
    size: PtySize,
) -> Result<TerminalSessionInfo> {
    let config = effective_application_config(&app)?;
    let mut settings = terminal_settings_from_config(&app, &config, input.resolved_theme)?;
    let mut env_overrides = terminal_env_from_config(&config)?;
    let local = host
        .document
        .local
        .clone()
        .ok_or_else(|| invalid_error("local connection host requires local config"))?;
    apply_local_host_config(&mut settings, &local);
    env_overrides.extend(local.env);
    let command_label = terminal_command_label(&settings);
    let command = build_terminal_command(&settings, input.cwd.as_deref(), &env_overrides);
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(size).map_err(terminal_error)?;
    let reader = pair.master.try_clone_reader().map_err(terminal_error)?;
    let writer = pair.master.take_writer().map_err(terminal_error)?;
    let child = pair.slave.spawn_command(command).map_err(terminal_error)?;
    let process_id = child.process_id();
    let killer = child.clone_killer();
    let state = terminal_state();
    let (session_number, id) = next_terminal_session_id(&state);
    let session = Arc::new(TerminalSession {
        backend: Mutex::new(TerminalBackend::Local {
            master: pair.master,
            writer,
            killer,
        }),
        info: Mutex::new(TerminalSessionInfo {
            id: id.clone(),
            title: format!("Session {session_number}"),
            command: command_label,
            cwd: input.cwd.or(settings.cwd),
            cols: input.cols,
            rows: input.rows,
            pixel_width: input.pixel_width,
            pixel_height: input.pixel_height,
            process_id,
            transport: TerminalTransportKind::Local,
            transport_state: TerminalTransportState::Connected,
            agent: None,
        }),
        host_id: host.id.clone(),
        reader_token: uuid::Uuid::new_v4().to_string(),
        window_label: Mutex::new(input.window_label),
        output_backlog: Mutex::new(Vec::new()),
        output_sequence: Mutex::new(0),
        output_backlog_start_sequence: Mutex::new(0),
    });
    {
        let mut sessions = state.sessions.lock().unwrap();
        sessions.insert(id.clone(), session.clone());
    }

    spawn_terminal_reader(app.clone(), id.clone(), reader);
    spawn_terminal_waiter(app, id.clone(), child);

    let info = session.info.lock().unwrap().clone();
    Ok(info)
}

fn create_ssh_host_terminal_session(
    app: AppHandle,
    input: CreateHostTerminalSessionInput,
    host: ConnectionHostEntry,
    size: PtySize,
) -> Result<TerminalSessionInfo> {
    let ssh = host
        .document
        .ssh
        .clone()
        .ok_or_else(|| invalid_error("ssh connection host requires ssh config"))?;
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
    let username = default_ssh_username(&ssh)?;
    let auth_target = connection_host_auth_target(
        &host.id,
        &host.document.name,
        &username,
        &ssh.hostname,
        ssh.port,
    );
    let trust_path = ssh_known_hosts_path(&app)?;
    let state = terminal_state();
    let (_session_number, id) = next_terminal_session_id(&state);
    let worker = SshWorkerInput {
        app: Some(app.clone()),
        session_id: id.clone(),
        workspace_id: input.workspace_id.clone(),
        source_tool_tab_id: Some(input.tool_tab_id.clone()),
        display_name: host.document.name.clone(),
        auth_target,
        ssh: ssh.clone(),
        proxy_jump_chain,
        username: username.clone(),
        size,
        trust_path,
        accept_new_host_key: input.accept_new_host_key,
        update_changed_host_key: input.update_changed_host_key,
        credential: input.credential,
        save_credential: input.save_credential,
        verification_scope: SshVerificationScope::Workspace,
    };
    let (command_tx, command_rx) = mpsc::channel();
    let session = Arc::new(TerminalSession {
        backend: Mutex::new(TerminalBackend::Ssh {
            commands: command_tx,
        }),
        info: Mutex::new(TerminalSessionInfo {
            id: id.clone(),
            title: host.document.name.clone(),
            command: ssh_command_label(&username, &ssh),
            cwd: None,
            cols: input.cols,
            rows: input.rows,
            pixel_width: input.pixel_width,
            pixel_height: input.pixel_height,
            process_id: None,
            transport: TerminalTransportKind::Ssh,
            transport_state: TerminalTransportState::Resolving,
            agent: None,
        }),
        host_id: host.id.clone(),
        reader_token: uuid::Uuid::new_v4().to_string(),
        window_label: Mutex::new(input.window_label),
        output_backlog: Mutex::new(Vec::new()),
        output_sequence: Mutex::new(0),
        output_backlog_start_sequence: Mutex::new(0),
    });
    {
        let mut sessions = state.sessions.lock().unwrap();
        sessions.insert(id.clone(), session.clone());
    }
    spawn_ssh_worker(app, id.clone(), worker, command_rx);
    let info = session.info.lock().unwrap().clone();
    Ok(info)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn existing_terminal_session_info(
    input: ExistingTerminalSessionInput,
) -> Result<TerminalSessionInfo> {
    let session = session_by_id(&input.session_id)?;
    let info = session.info.lock().unwrap().clone();
    Ok(info)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn transfer_terminal_sessions_to_window(
    input: TerminalSessionOwnershipInput,
) -> Result<()> {
    for session_id in input.session_ids {
        let session = session_by_id(&session_id)?;
        let mut window_label = session.window_label.lock().unwrap();
        *window_label = input.window_label.clone();
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn detach_terminal_session(
    input: TerminalDetachInput,
) -> Result<TerminalDetachedSessionInfo> {
    let session = session_by_id(&input.session_id)?;
    let info = session.info.lock().unwrap().clone();
    if info.agent.is_none() {
        return Err(invalid_error(
            "terminal detach requires an agent-backed terminal session",
        ));
    }
    let mut backend = session.backend.lock().unwrap();
    let TerminalBackend::Agent {
        session_id,
        helper_path,
        agent_process,
        local_control,
        remote,
    } = &mut *backend
    else {
        return Err(invalid_error(
            "terminal detach requires an agent-backed terminal session",
        ));
    };
    let detach_response = send_agent_backend_request(
        session_id,
        helper_path,
        local_control.as_ref(),
        remote.as_ref(),
        RemoteAgentCommand::Detach,
        || agent_protocol_request("detach", None),
        "detach",
        &[],
    )?;
    terminal_agent_response_result(detach_response)?;
    let detached = TerminalDetachedSessionInfo {
        session_id: session_id.clone(),
        title: info.title.clone(),
        command: info.command.clone(),
        cwd: info.cwd.clone(),
        cols: info.cols,
        rows: info.rows,
        detached: true,
        attached_count: 0,
    };
    let record = DetachedTerminalRecord {
        host_id: session.host_id.clone(),
        info: detached.clone(),
        session_info: info,
        session_id: session_id.clone(),
        helper_path: helper_path.clone(),
        agent_process: agent_process.take(),
        remote: remote
            .as_ref()
            .and_then(|backend| backend.runtime.lock().ok().and_then(|guard| guard.clone())),
    };
    let state = terminal_state();
    state
        .detached_sessions
        .lock()
        .map_err(|_| invalid_error("terminal detached sessions lock poisoned"))?
        .insert(session_id.clone(), record);
    drop(backend);
    remove_terminal_session(&input.session_id);
    Ok(detached)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn list_detached_terminal_sessions(
    app: AppHandle,
    input: DetachedTerminalSessionsInput,
) -> Result<Vec<TerminalDetachedSessionInfo>> {
    let host_id = workspace::owned_workspace_tool_host_for_kinds(
        &app,
        &input.workspace_id,
        &input.tool_tab_id,
        &[
            crate::types::WorkspaceToolKind::Terminal,
            crate::types::WorkspaceToolKind::TerminalSessions,
        ],
    )?;
    let host = connection_host_by_id(&app, &host_id)?;
    let mut merged = Vec::new();
    if matches!(host.document.protocol, ConnectionProtocol::Local) {
        if matches!(
            effective_terminal_agent_mode(&host),
            TerminalAgentMode::Enabled
        ) {
            let helper_path = local_terminal_agent_helper_path(&app)?;
            for session in run_local_go_agent_list(&helper_path, &host_id)? {
                merged.push(terminal_detached_info_from_go_session(&session));
            }
        }
    } else if matches!(host.document.protocol, ConnectionProtocol::Ssh)
        && matches!(
            effective_terminal_agent_mode(&host),
            TerminalAgentMode::Enabled
        )
    {
        let prepared = prepare_remote_terminal_agent_runtime(
            &app,
            &host,
            &input.workspace_id,
            Some(&input.tool_tab_id),
            "terminal-agent-list",
            PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 800,
                pixel_height: 600,
            },
            false,
            false,
            None,
            false,
        )?;
        for session in run_remote_go_agent_list(
            &prepared.runtime.worker_input,
            prepared.runtime.target_os,
            &prepared.runtime.helper_path,
            &host_id,
        )? {
            merged.push(terminal_detached_info_from_go_session(&session));
        }
    }
    let state = terminal_state();
    let sessions = state
        .detached_sessions
        .lock()
        .map_err(|_| invalid_error("terminal detached sessions lock poisoned"))?;
    for info in sessions
        .values()
        .filter(|record| record.host_id == host_id)
        .map(|record| record.info.clone())
    {
        if !merged
            .iter()
            .any(|session| session.session_id == info.session_id)
        {
            merged.push(info);
        }
    }
    Ok(merged)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn attach_detached_terminal_session(
    app: AppHandle,
    input: AttachDetachedTerminalSessionInput,
) -> Result<TerminalSessionInfo> {
    let host_id = workspace::owned_workspace_tool_host_for_kinds(
        &app,
        &input.workspace_id,
        &input.tool_tab_id,
        &[
            crate::types::WorkspaceToolKind::Terminal,
            crate::types::WorkspaceToolKind::TerminalSessions,
        ],
    )?;
    let state = terminal_state();
    let record = match state
        .detached_sessions
        .lock()
        .map_err(|_| invalid_error("terminal detached sessions lock poisoned"))?
        .remove(&input.detached_session_id)
    {
        Some(record) => record,
        None => {
            return attach_registry_terminal_session(app, input, host_id);
        }
    };
    if record.host_id != host_id {
        state
            .detached_sessions
            .lock()
            .map_err(|_| invalid_error("terminal detached sessions lock poisoned"))?
            .insert(input.detached_session_id.clone(), record);
        return Err(invalid_error(
            "detached terminal session belongs to a different host",
        ));
    }
    let mut session_info = record.session_info;
    session_info.transport_state = TerminalTransportState::Connected;
    session_info.agent = Some(TerminalAgentSessionInfo {
        session_id: record.session_id.clone(),
    });
    let session_id = session_info.id.clone();
    let helper_path = record.helper_path;
    let daemon_session_id = record.session_id;
    let registry_session_id = daemon_session_id.clone();
    let mut remote_runtime = record.remote;
    if let Some(runtime) = remote_runtime.as_mut() {
        runtime.worker_input.workspace_id = input.workspace_id.clone();
        runtime.worker_input.source_tool_tab_id = Some(input.tool_tab_id.clone());
        runtime.agent_session_id = daemon_session_id.clone();
    }
    let remote_backend = remote_runtime.clone().map(remote_agent_backend);
    let remote_live_control = remote_backend
        .as_ref()
        .map(|backend| backend.live_control.clone());
    let reader_token = uuid::Uuid::new_v4().to_string();
    let session = Arc::new(TerminalSession {
        backend: Mutex::new(TerminalBackend::Agent {
            session_id: daemon_session_id,
            helper_path: helper_path.clone(),
            agent_process: record.agent_process,
            local_control: None,
            remote: remote_backend,
        }),
        info: Mutex::new(session_info.clone()),
        host_id,
        reader_token: reader_token.clone(),
        window_label: Mutex::new(input.window_label),
        output_backlog: Mutex::new(Vec::new()),
        output_sequence: Mutex::new(0),
        output_backlog_start_sequence: Mutex::new(0),
    });
    state
        .sessions
        .lock()
        .map_err(|_| invalid_error("terminal sessions lock poisoned"))?
        .insert(session_id.clone(), session.clone());
    if let (Some(runtime), Some(live_control)) = (remote_runtime, remote_live_control) {
        spawn_remote_agent_terminal_reader(app, session_id, reader_token, runtime, live_control);
    } else {
        let local_control = spawn_local_go_agent_terminal_reader(
            app,
            session_id,
            registry_session_id,
            helper_path,
            reader_token,
        );
        if let Ok(mut backend) = session.backend.lock() {
            if let TerminalBackend::Agent {
                local_control: slot,
                ..
            } = &mut *backend
            {
                *slot = Some(local_control);
            }
        }
    }
    Ok(session_info)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn open_detached_terminal_session_history(
    app: AppHandle,
    input: OpenDetachedTerminalSessionHistoryInput,
) -> Result<TerminalSessionInfo> {
    let host_id = workspace::owned_workspace_tool_host_for_kinds(
        &app,
        &input.workspace_id,
        &input.tool_tab_id,
        &[
            crate::types::WorkspaceToolKind::Terminal,
            crate::types::WorkspaceToolKind::TerminalSessions,
        ],
    )?;
    let host = connection_host_by_id(&app, &host_id)?;
    if !matches!(
        effective_terminal_agent_mode(&host),
        TerminalAgentMode::Enabled
    ) {
        return Err(invalid_error(
            "terminal agent mode is disabled for this host",
        ));
    }
    let (listed, helper_path, remote_runtime) = match host.document.protocol {
        ConnectionProtocol::Local => {
            let helper_path = local_terminal_agent_helper_path(&app)?;
            let listed = run_local_go_agent_list(&helper_path, &host_id)?
                .into_iter()
                .find(|session| session.session_id == input.detached_session_id)
                .ok_or_else(|| {
                    missing_error(format!(
                        "detached terminal session {} not found",
                        input.detached_session_id
                    ))
                })?;
            (listed, helper_path, None)
        }
        ConnectionProtocol::Ssh => {
            let prepared = prepare_remote_terminal_agent_runtime(
                &app,
                &host,
                &input.workspace_id,
                Some(&input.tool_tab_id),
                "terminal-agent-history",
                PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 800,
                    pixel_height: 600,
                },
                false,
                false,
                None,
                false,
            )?;
            let listed = run_remote_go_agent_list_on_session(
                &prepared.connection.session,
                prepared.runtime.target_os,
                &prepared.runtime.helper_path,
                &host_id,
            )?
            .into_iter()
            .find(|session| session.session_id == input.detached_session_id)
            .ok_or_else(|| {
                missing_error(format!(
                    "detached terminal session {} not found",
                    input.detached_session_id
                ))
            })?;
            (
                listed,
                prepared.runtime.helper_path.clone(),
                Some(prepared.runtime),
            )
        }
        ConnectionProtocol::Telnet => {
            return Err(invalid_error(
                "Terminal Agent mode is not supported for telnet hosts",
            ));
        }
    };
    if listed.status != "exited" {
        return Err(invalid_error(
            "terminal history view only opens exited terminal sessions",
        ));
    }
    let registry_session_id = listed.session_id.clone();
    let (_session_number, session_id) = next_terminal_session_id(&terminal_state());
    let session_info = terminal_history_session_info_from_go_session(&listed, session_id.clone());
    let reader_token = uuid::Uuid::new_v4().to_string();
    let session = Arc::new(TerminalSession {
        backend: Mutex::new(TerminalBackend::AgentHistory {
            registry_session_id: registry_session_id.clone(),
        }),
        info: Mutex::new(session_info.clone()),
        host_id,
        reader_token: reader_token.clone(),
        window_label: Mutex::new(input.window_label),
        output_backlog: Mutex::new(Vec::new()),
        output_sequence: Mutex::new(0),
        output_backlog_start_sequence: Mutex::new(0),
    });
    terminal_state()
        .sessions
        .lock()
        .map_err(|_| invalid_error("terminal sessions lock poisoned"))?
        .insert(session_id.clone(), session);
    if let Some(runtime) = remote_runtime {
        spawn_remote_go_agent_history_reader(
            app,
            session_id,
            registry_session_id,
            reader_token,
            runtime,
        );
    } else {
        spawn_local_go_agent_history_reader(
            app,
            session_id,
            registry_session_id,
            helper_path,
            reader_token,
        );
    }
    Ok(session_info)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn delete_detached_terminal_session(
    app: AppHandle,
    input: DeleteDetachedTerminalSessionInput,
) -> Result<()> {
    let host_id = workspace::owned_workspace_tool_host_for_kinds(
        &app,
        &input.workspace_id,
        &input.tool_tab_id,
        &[
            crate::types::WorkspaceToolKind::Terminal,
            crate::types::WorkspaceToolKind::TerminalSessions,
        ],
    )?;
    let state = terminal_state();
    let live_session = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| invalid_error("terminal sessions lock poisoned"))?;
        sessions.get(&input.detached_session_id).cloned()
    };
    if let Some(session) = live_session {
        if session.host_id != host_id {
            return Err(invalid_error(
                "terminal session belongs to a different host",
            ));
        }
        match delete_agent_session_from_backend(&session) {
            Ok(()) => {}
            Err(_) if terminal_session_is_history_view(&session) => {
                let registry_session_id = terminal_history_registry_session_id(&session)?;
                delete_registry_terminal_session(app, &input, &host_id, &registry_session_id)?
            }
            Err(error) => return Err(error),
        }
        remove_terminal_session(&input.detached_session_id);
        return Ok(());
    }

    let record = state
        .detached_sessions
        .lock()
        .map_err(|_| invalid_error("terminal detached sessions lock poisoned"))?
        .remove(&input.detached_session_id);
    if let Some(record) = record {
        if record.host_id != host_id {
            state
                .detached_sessions
                .lock()
                .map_err(|_| invalid_error("terminal detached sessions lock poisoned"))?
                .insert(input.detached_session_id.clone(), record);
            return Err(invalid_error(
                "detached terminal session belongs to a different host",
            ));
        }
        delete_agent_session_from_record(record)?;
        return Ok(());
    }

    delete_registry_terminal_session(app, &input, &host_id, &input.detached_session_id)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn rename_detached_terminal_session(
    app: AppHandle,
    input: RenameDetachedTerminalSessionInput,
) -> Result<()> {
    let title = input.title.trim().to_string();
    if title.is_empty() {
        return Err(invalid_error("terminal session title cannot be empty"));
    }
    let host_id = workspace::owned_workspace_tool_host_for_kinds(
        &app,
        &input.workspace_id,
        &input.tool_tab_id,
        &[
            crate::types::WorkspaceToolKind::Terminal,
            crate::types::WorkspaceToolKind::TerminalSessions,
        ],
    )?;
    rename_registry_terminal_session(app, &input, &host_id, &title)
}

fn rename_registry_terminal_session(
    app: AppHandle,
    input: &RenameDetachedTerminalSessionInput,
    host_id: &str,
    title: &str,
) -> Result<()> {
    let host = connection_host_by_id(&app, host_id)?;
    if !matches!(
        effective_terminal_agent_mode(&host),
        TerminalAgentMode::Enabled
    ) {
        return Err(invalid_error(
            "terminal agent mode is disabled for this host",
        ));
    }
    match host.document.protocol {
        ConnectionProtocol::Local => {
            let helper_path = local_terminal_agent_helper_path(&app)?;
            terminal_agent_response_result(run_local_go_agent_client(
                &helper_path,
                &input.detached_session_id,
                "rename",
                &[("--title", title)],
            )?)
        }
        ConnectionProtocol::Ssh => {
            let prepared = prepare_remote_terminal_agent_runtime(
                &app,
                &host,
                &input.workspace_id,
                Some(&input.tool_tab_id),
                "terminal-agent-rename",
                PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 800,
                    pixel_height: 600,
                },
                false,
                false,
                None,
                false,
            )?;
            terminal_agent_response_result(run_remote_go_agent_client(
                &prepared.runtime.worker_input,
                prepared.runtime.target_os,
                &prepared.runtime.helper_path,
                &input.detached_session_id,
                "rename",
                &[("--title", title)],
            )?)
        }
        ConnectionProtocol::Telnet => Err(invalid_error(
            "Terminal Agent mode is not supported for telnet hosts",
        )),
    }
}

fn delete_agent_session_from_backend(session: &Arc<TerminalSession>) -> Result<()> {
    let mut backend = session.backend.lock().unwrap();
    let TerminalBackend::Agent {
        session_id,
        helper_path,
        agent_process,
        local_control: _,
        remote,
    } = &mut *backend
    else {
        return Err(invalid_error(
            "terminal session deletion requires an agent-backed session",
        ));
    };
    let response = if let Some(remote) = remote.as_ref() {
        remote_agent_response(remote, RemoteAgentCommand::Delete)?
    } else {
        run_local_go_agent_client(helper_path, session_id, "delete", &[])?
    };
    if let Some(child) = agent_process.as_mut() {
        let _ = child.kill();
    }
    terminal_agent_response_result(response)
}

fn terminal_session_is_history_view(session: &Arc<TerminalSession>) -> bool {
    let Ok(backend) = session.backend.lock() else {
        return false;
    };
    matches!(&*backend, TerminalBackend::AgentHistory { .. })
}

fn terminal_history_registry_session_id(session: &Arc<TerminalSession>) -> Result<String> {
    let backend = session
        .backend
        .lock()
        .map_err(|_| invalid_error("terminal backend lock poisoned"))?;
    let TerminalBackend::AgentHistory {
        registry_session_id,
    } = &*backend
    else {
        return Err(invalid_error(
            "terminal session is not a registry history view",
        ));
    };
    Ok(registry_session_id.clone())
}

fn delete_agent_session_from_record(record: DetachedTerminalRecord) -> Result<()> {
    if let Some(runtime) = record.remote {
        let runtime_slot = Arc::new(Mutex::new(Some(runtime)));
        let (command_tx, command_rx) = mpsc::channel();
        spawn_remote_agent_control_worker(runtime_slot.clone(), command_rx);
        let backend = RemoteAgentBackend {
            commands: command_tx,
            live_control: Arc::new(Mutex::new(None)),
            runtime: runtime_slot,
        };
        terminal_agent_response_result(remote_agent_response(&backend, RemoteAgentCommand::Delete)?)
    } else {
        terminal_agent_response_result(run_local_go_agent_client(
            &record.helper_path,
            &record.session_id,
            "delete",
            &[],
        )?)
    }
}

fn delete_registry_terminal_session(
    app: AppHandle,
    input: &DeleteDetachedTerminalSessionInput,
    host_id: &str,
    registry_session_id: &str,
) -> Result<()> {
    let host = connection_host_by_id(&app, host_id)?;
    if !matches!(
        effective_terminal_agent_mode(&host),
        TerminalAgentMode::Enabled
    ) {
        return Err(invalid_error(
            "terminal agent mode is disabled for this host",
        ));
    }
    match host.document.protocol {
        ConnectionProtocol::Local => {
            let helper_path = local_terminal_agent_helper_path(&app)?;
            let exists = run_local_go_agent_list(&helper_path, host_id)?
                .into_iter()
                .any(|session| session.session_id == registry_session_id);
            if !exists {
                return Err(missing_error(format!(
                    "detached terminal session {} not found",
                    registry_session_id
                )));
            }
            terminal_agent_response_result(run_local_go_agent_client(
                &helper_path,
                registry_session_id,
                "delete",
                &[],
            )?)
        }
        ConnectionProtocol::Ssh => {
            let prepared = prepare_remote_terminal_agent_runtime(
                &app,
                &host,
                &input.workspace_id,
                Some(&input.tool_tab_id),
                "terminal-agent-delete",
                PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 800,
                    pixel_height: 600,
                },
                false,
                false,
                None,
                false,
            )?;
            let exists = run_remote_go_agent_list_on_session(
                &prepared.connection.session,
                prepared.runtime.target_os,
                &prepared.runtime.helper_path,
                host_id,
            )?
            .into_iter()
            .any(|session| session.session_id == registry_session_id);
            if !exists {
                return Err(missing_error(format!(
                    "detached terminal session {} not found",
                    registry_session_id
                )));
            }
            terminal_agent_response_result(run_remote_go_agent_client_on_session(
                &prepared.connection.session,
                prepared.runtime.target_os,
                &prepared.runtime.helper_path,
                registry_session_id,
                "delete",
                &[],
            )?)
        }
        ConnectionProtocol::Telnet => Err(invalid_error(
            "Terminal Agent mode is not supported for telnet hosts",
        )),
    }
}

fn attach_registry_terminal_session(
    app: AppHandle,
    input: AttachDetachedTerminalSessionInput,
    host_id: String,
) -> Result<TerminalSessionInfo> {
    let host = connection_host_by_id(&app, &host_id)?;
    if !matches!(
        effective_terminal_agent_mode(&host),
        TerminalAgentMode::Enabled
    ) {
        return Err(invalid_error(
            "terminal agent mode is disabled for this host",
        ));
    }
    let (listed, helper_path, remote_runtime) = match host.document.protocol {
        ConnectionProtocol::Local => {
            let helper_path = local_terminal_agent_helper_path(&app)?;
            let listed = run_local_go_agent_list(&helper_path, &host_id)?
                .into_iter()
                .find(|session| session.session_id == input.detached_session_id)
                .ok_or_else(|| {
                    missing_error(format!(
                        "detached terminal session {} not found",
                        input.detached_session_id
                    ))
                })?;
            (listed, helper_path, None)
        }
        ConnectionProtocol::Ssh => {
            let prepared = prepare_remote_terminal_agent_runtime(
                &app,
                &host,
                &input.workspace_id,
                Some(&input.tool_tab_id),
                &input.detached_session_id,
                PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 800,
                    pixel_height: 600,
                },
                false,
                false,
                None,
                false,
            )?;
            let listed = run_remote_go_agent_list_on_session(
                &prepared.connection.session,
                prepared.runtime.target_os,
                &prepared.runtime.helper_path,
                &host_id,
            )?
            .into_iter()
            .find(|session| session.session_id == input.detached_session_id)
            .ok_or_else(|| {
                missing_error(format!(
                    "detached terminal session {} not found",
                    input.detached_session_id
                ))
            })?;
            (
                listed,
                prepared.runtime.helper_path.clone(),
                Some(prepared.runtime),
            )
        }
        ConnectionProtocol::Telnet => {
            return Err(invalid_error(
                "Terminal Agent mode is not supported for telnet hosts",
            ));
        }
    };
    if listed.status == "exited" {
        return Err(invalid_error(
            "exited terminal sessions can be viewed from history but cannot be attached",
        ));
    }
    if let Some(runtime) = remote_runtime.as_ref() {
        terminal_agent_response_result(run_remote_go_agent_client(
            &runtime.worker_input,
            runtime.target_os,
            &runtime.helper_path,
            &listed.session_id,
            "ping",
            &[],
        )?)?;
    } else {
        terminal_agent_response_result(run_local_go_agent_client(
            &helper_path,
            &listed.session_id,
            "ping",
            &[],
        )?)?;
    }
    let (_session_number, session_id) = next_terminal_session_id(&terminal_state());
    let session_info =
        terminal_session_info_from_go_session_with_view_id(&listed, session_id.clone());
    let reader_token = uuid::Uuid::new_v4().to_string();
    let remote_backend = remote_runtime.clone().map(remote_agent_backend);
    let remote_live_control = remote_backend
        .as_ref()
        .map(|backend| backend.live_control.clone());
    let session = Arc::new(TerminalSession {
        backend: Mutex::new(TerminalBackend::Agent {
            session_id: listed.session_id.clone(),
            helper_path: helper_path.clone(),
            agent_process: None,
            local_control: None,
            remote: remote_backend,
        }),
        info: Mutex::new(session_info.clone()),
        host_id,
        reader_token: reader_token.clone(),
        window_label: Mutex::new(input.window_label),
        output_backlog: Mutex::new(Vec::new()),
        output_sequence: Mutex::new(0),
        output_backlog_start_sequence: Mutex::new(0),
    });
    terminal_state()
        .sessions
        .lock()
        .map_err(|_| invalid_error("terminal sessions lock poisoned"))?
        .insert(session_id.clone(), session);
    if let (Some(runtime), Some(live_control)) = (remote_runtime, remote_live_control) {
        spawn_remote_go_agent_history_then_reader(
            app,
            session_id,
            reader_token,
            runtime,
            live_control,
        );
    } else {
        spawn_local_go_agent_history_then_reader(
            app,
            session_id,
            listed.session_id,
            helper_path,
            reader_token,
        );
    }
    Ok(session_info)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn export_terminal_session_key(_session_id: String) -> Result<String> {
    Err(invalid_error(
        "Go Terminal Agent sessions do not expose shared client keys",
    ))
}

#[tauri::command]
#[specta::specta]
pub(crate) fn take_terminal_output_backlog(
    input: TerminalOutputBacklogInput,
) -> Result<Option<TerminalOutputEvent>> {
    let session = match session_by_id(&input.session_id) {
        Ok(session) => session,
        Err(_) => return Ok(None),
    };
    let backlog = session.output_backlog.lock().unwrap();
    if backlog.is_empty() {
        return Ok(None);
    }
    let data = BASE64_STANDARD.encode(&*backlog);
    let sequence = *session.output_backlog_start_sequence.lock().unwrap();
    Ok(Some(TerminalOutputEvent {
        session_id: input.session_id,
        sequence: sequence.to_string(),
        backlog: true,
        data,
    }))
}

#[tauri::command]
#[specta::specta]
pub(crate) fn write_terminal(input: TerminalInput) -> Result<()> {
    let session = session_by_id(&input.session_id)
        .map_err(|_| terminal_session_missing_error(&input.session_id))?;
    let mut backend = session.backend.lock().unwrap();
    match &mut *backend {
        TerminalBackend::Local { writer, .. } => {
            writer
                .write_all(input.data.as_bytes())
                .map_err(terminal_error)?;
            writer.flush().map_err(terminal_error)
        }
        TerminalBackend::Ssh { commands } => commands
            .send(SshWorkerCommand::Write(input.data.into_bytes()))
            .map_err(|error| terminal_error(format!("failed to write ssh session: {error}"))),
        TerminalBackend::Agent {
            session_id,
            helper_path,
            local_control,
            remote,
            ..
        } => {
            let data = BASE64_STANDARD.encode(input.data.as_bytes());
            let bytes = input.data.into_bytes();
            let local_bytes = bytes.clone();
            terminal_agent_response_result(send_agent_backend_request(
                session_id,
                helper_path,
                local_control.as_ref(),
                remote.as_ref(),
                |sender| RemoteAgentCommand::Write(bytes, sender),
                || agent_write_request(&local_bytes),
                "write",
                &[("--data", data.as_str())],
            )?)
        }
        TerminalBackend::AgentHistory {
            registry_session_id,
        } => Err(invalid_error(format!(
            "terminal history view for registry session {registry_session_id} is read-only"
        ))),
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn resize_terminal(input: TerminalSizeInput) -> Result<()> {
    let size = validated_pty_size(
        input.cols,
        input.rows,
        input.pixel_width,
        input.pixel_height,
    )?;
    let session = session_by_id(&input.session_id)
        .map_err(|_| terminal_session_missing_error(&input.session_id))?;
    {
        let mut info = session.info.lock().unwrap();
        info.cols = input.cols;
        info.rows = input.rows;
        info.pixel_width = input.pixel_width;
        info.pixel_height = input.pixel_height;
    }
    let mut backend = session.backend.lock().unwrap();
    match &mut *backend {
        TerminalBackend::Local { master, .. } => master.resize(size).map_err(terminal_error),
        TerminalBackend::Ssh { commands } => commands
            .send(SshWorkerCommand::Resize(size))
            .map_err(|error| terminal_error(format!("failed to resize ssh session: {error}"))),
        TerminalBackend::Agent {
            session_id,
            helper_path,
            local_control,
            remote,
            ..
        } => {
            let state = terminal_state();
            let agent_size = record_agent_view_size(&state, session_id, &input.session_id, size)?;
            let cols = agent_size.cols.to_string();
            let rows = agent_size.rows.to_string();
            let pixel_width = agent_size.pixel_width.to_string();
            let pixel_height = agent_size.pixel_height.to_string();
            terminal_agent_response_result(send_agent_backend_request(
                session_id,
                helper_path,
                local_control.as_ref(),
                remote.as_ref(),
                |sender| RemoteAgentCommand::Resize(agent_size, sender),
                || agent_resize_request(agent_size),
                "resize",
                &[
                    ("--cols", cols.as_str()),
                    ("--rows", rows.as_str()),
                    ("--pixel-width", pixel_width.as_str()),
                    ("--pixel-height", pixel_height.as_str()),
                ],
            )?)
        }
        TerminalBackend::AgentHistory {
            registry_session_id,
        } => Err(invalid_error(format!(
            "terminal history view for registry session {registry_session_id} cannot be resized"
        ))),
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn update_terminal_title(input: TerminalTitleInput) -> Result<()> {
    let title = input.title.trim().to_string();
    if title.is_empty() {
        return Err(invalid_error("terminal title cannot be empty"));
    }
    let session = session_by_id(&input.session_id)
        .map_err(|_| terminal_session_missing_error(&input.session_id))?;
    let mut backend = session.backend.lock().unwrap();
    match &mut *backend {
        TerminalBackend::Local { .. } => Ok(()),
        TerminalBackend::Ssh { .. } => Ok(()),
        TerminalBackend::Agent {
            session_id,
            helper_path,
            local_control,
            remote,
            ..
        } => terminal_agent_response_result(send_agent_backend_request(
            session_id,
            helper_path,
            local_control.as_ref(),
            remote.as_ref(),
            |sender| RemoteAgentCommand::TitleChange(title.clone(), sender),
            || agent_title_request("title_change", &title),
            "title_change",
            &[("--title", title.as_str())],
        )?),
        TerminalBackend::AgentHistory {
            registry_session_id,
        } => Err(invalid_error(format!(
            "terminal history view for registry session {registry_session_id} is read-only"
        ))),
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn close_terminal_session(session_id: String) -> Result<()> {
    let session = match session_by_id(&session_id) {
        Ok(session) => session,
        Err(_) => return Ok(()),
    };
    close_terminal_view_session(session)?;
    remove_terminal_session(&session_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::parse_toml;
    use std::io::{Error, ErrorKind};

    fn test_remote_agent_backend(command_tx: Sender<RemoteAgentCommand>) -> RemoteAgentBackend {
        RemoteAgentBackend {
            commands: command_tx,
            live_control: Arc::new(Mutex::new(None)),
            runtime: Arc::new(Mutex::new(None)),
        }
    }

    #[test]
    fn remote_agent_backend_prefers_live_control_connection() {
        let (fallback_tx, fallback_rx) = mpsc::channel();
        let (live_tx, live_rx) = mpsc::channel();
        let backend = RemoteAgentBackend {
            commands: fallback_tx,
            live_control: Arc::new(Mutex::new(Some(live_tx))),
            runtime: Arc::new(Mutex::new(None)),
        };

        let requester = thread::spawn(move || {
            send_agent_backend_request(
                "registry-session",
                "unused-helper",
                None,
                Some(&backend),
                |sender| RemoteAgentCommand::Write(b"ignored fallback".to_vec(), sender),
                || agent_write_request(b"hello"),
                "write",
                &[("--data", "aGVsbG8=")],
            )
        });

        let live_command = live_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("remote live control should receive write request");
        assert_eq!(live_command.request.name, "write");
        assert_eq!(live_command.request.kind, "request");
        assert!(
            live_command.request.request_id.starts_with("nocturne-"),
            "live request should carry a generated request_id"
        );
        assert!(
            fallback_rx
                .recv_timeout(Duration::from_millis(100))
                .is_err(),
            "remote write should not start a short helper command when live control is available"
        );
        live_command
            .response
            .send(Ok(TerminalAgentResponse::Ok))
            .expect("send live response");
        assert!(matches!(
            requester.join().expect("request thread panicked"),
            Ok(TerminalAgentResponse::Ok)
        ));
    }

    #[test]
    fn remote_live_control_pending_writes_retry_after_would_block() {
        struct FlakyWriter {
            fail_once: bool,
            written: Vec<u8>,
        }

        impl Write for FlakyWriter {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                if self.fail_once {
                    self.fail_once = false;
                    return Err(Error::from(ErrorKind::WouldBlock));
                }
                self.written.extend_from_slice(buf);
                Ok(buf.len())
            }

            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let request = agent_protocol_request(
            "write",
            Some(serde_json::json!({
                "data": "aGVsbG8="
            })),
        );
        let serialized = serialize_agent_control_request(&request).expect("serialize request");
        let mut pending = VecDeque::new();
        queue_pending_bytes(&mut pending, &serialized).expect("queue request");
        let mut writer = FlakyWriter {
            fail_once: true,
            written: Vec::new(),
        };

        assert!(
            !drain_remote_agent_pending_writes(&mut writer, &mut pending).expect("first drain"),
            "WouldBlock should leave the request queued"
        );
        assert_eq!(pending.len(), serialized.len());
        assert!(writer.written.is_empty());

        assert!(
            drain_remote_agent_pending_writes(&mut writer, &mut pending).expect("second drain"),
            "request should drain after backpressure clears"
        );
        assert!(pending.is_empty());
        assert_eq!(writer.written, serialized);
    }

    #[test]
    fn closing_agent_terminal_view_sends_close_view() {
        let state = terminal_state();
        let view_session_id = "test-close-view-detaches-view";
        let registry_session_id = "test-close-view-detaches-registry";
        remove_terminal_session(view_session_id);
        let (command_tx, command_rx) = mpsc::channel();
        let remote_backend = test_remote_agent_backend(command_tx);
        let session = Arc::new(TerminalSession {
            backend: Mutex::new(TerminalBackend::Agent {
                session_id: registry_session_id.to_string(),
                helper_path: "unused-helper".to_string(),
                agent_process: None,
                local_control: None,
                remote: Some(remote_backend),
            }),
            info: Mutex::new(TerminalSessionInfo {
                id: view_session_id.to_string(),
                title: "Attached view".to_string(),
                command: "bash".to_string(),
                cwd: None,
                cols: 80,
                rows: 24,
                pixel_width: 800,
                pixel_height: 600,
                process_id: None,
                transport: TerminalTransportKind::Agent,
                transport_state: TerminalTransportState::Connected,
                agent: Some(TerminalAgentSessionInfo {
                    session_id: registry_session_id.to_string(),
                }),
            }),
            host_id: "host-a".to_string(),
            reader_token: "reader-token".to_string(),
            window_label: Mutex::new("main".to_string()),
            output_backlog: Mutex::new(Vec::new()),
            output_sequence: Mutex::new(0),
            output_backlog_start_sequence: Mutex::new(0),
        });
        state
            .sessions
            .lock()
            .expect("terminal sessions lock")
            .insert(view_session_id.to_string(), session);

        let closer = thread::spawn(move || close_terminal_session(view_session_id.to_string()));
        let command = command_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("close_terminal_session sends a daemon command");
        match command {
            RemoteAgentCommand::CloseView(response_tx) => {
                response_tx
                    .send(Ok(TerminalAgentResponse::Ok))
                    .expect("send close_view response");
            }
            RemoteAgentCommand::Detach(_) => {
                panic!("closing an attached Terminal view must not detach explicitly")
            }
            RemoteAgentCommand::Close(_) => {
                panic!("closing an attached Terminal view must let close_view decide whether to close the run")
            }
            RemoteAgentCommand::Delete(_) => {
                panic!("closing an attached Terminal view must not delete the daemon")
            }
            RemoteAgentCommand::Write(_, _)
            | RemoteAgentCommand::Resize(_, _)
            | RemoteAgentCommand::TitleChange(_, _) => {
                panic!("unexpected command while closing attached Terminal view")
            }
        }
        closer
            .join()
            .expect("close thread panicked")
            .expect("close view succeeds");
        assert!(
            session_by_id(view_session_id).is_err(),
            "view-local session should be removed after detach"
        );
    }

    #[test]
    fn detach_agent_terminal_view_returns_registry_session_id() {
        let state = terminal_state();
        let view_session_id = "test-detach-view-id";
        let registry_session_id = "test-detach-registry-id";
        remove_terminal_session(view_session_id);
        {
            let mut detached = state
                .detached_sessions
                .lock()
                .expect("detached sessions lock");
            detached.remove(registry_session_id);
            detached.remove(view_session_id);
        }
        let (command_tx, command_rx) = mpsc::channel();
        let remote_backend = test_remote_agent_backend(command_tx);
        let session = Arc::new(TerminalSession {
            backend: Mutex::new(TerminalBackend::Agent {
                session_id: registry_session_id.to_string(),
                helper_path: "unused-helper".to_string(),
                agent_process: None,
                local_control: None,
                remote: Some(remote_backend),
            }),
            info: Mutex::new(TerminalSessionInfo {
                id: view_session_id.to_string(),
                title: "Attached view".to_string(),
                command: "bash".to_string(),
                cwd: None,
                cols: 120,
                rows: 30,
                pixel_width: 1000,
                pixel_height: 700,
                process_id: None,
                transport: TerminalTransportKind::Agent,
                transport_state: TerminalTransportState::Connected,
                agent: Some(TerminalAgentSessionInfo {
                    session_id: registry_session_id.to_string(),
                }),
            }),
            host_id: "host-a".to_string(),
            reader_token: "reader-token".to_string(),
            window_label: Mutex::new("main".to_string()),
            output_backlog: Mutex::new(Vec::new()),
            output_sequence: Mutex::new(0),
            output_backlog_start_sequence: Mutex::new(0),
        });
        state
            .sessions
            .lock()
            .expect("terminal sessions lock")
            .insert(view_session_id.to_string(), session);

        let detacher = thread::spawn(move || {
            detach_terminal_session(TerminalDetachInput {
                session_id: view_session_id.to_string(),
            })
        });
        let command = command_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("detach_terminal_session sends a daemon command");
        match command {
            RemoteAgentCommand::Detach(response_tx) => {
                response_tx
                    .send(Ok(TerminalAgentResponse::Ok))
                    .expect("send detach response");
            }
            _ => panic!("detach_terminal_session should send detach"),
        }
        let detached = detacher
            .join()
            .expect("detach thread panicked")
            .expect("detach succeeds");
        assert_eq!(detached.session_id, registry_session_id);
        assert!(session_by_id(view_session_id).is_err());
        let mut detached_sessions = state
            .detached_sessions
            .lock()
            .expect("detached sessions lock");
        assert!(detached_sessions.contains_key(registry_session_id));
        assert!(!detached_sessions.contains_key(view_session_id));
        detached_sessions.remove(registry_session_id);
    }

    #[test]
    fn agent_title_commands_forward_registry_session_title() {
        let state = terminal_state();
        let view_session_id = "test-title-view-id";
        let registry_session_id = "test-title-registry-id";
        remove_terminal_session(view_session_id);
        let (command_tx, command_rx) = mpsc::channel();
        let remote_backend = test_remote_agent_backend(command_tx);
        let session = Arc::new(TerminalSession {
            backend: Mutex::new(TerminalBackend::Agent {
                session_id: registry_session_id.to_string(),
                helper_path: "unused-helper".to_string(),
                agent_process: None,
                local_control: None,
                remote: Some(remote_backend),
            }),
            info: Mutex::new(TerminalSessionInfo {
                id: view_session_id.to_string(),
                title: "Attached view".to_string(),
                command: "bash".to_string(),
                cwd: None,
                cols: 120,
                rows: 30,
                pixel_width: 1000,
                pixel_height: 700,
                process_id: None,
                transport: TerminalTransportKind::Agent,
                transport_state: TerminalTransportState::Connected,
                agent: Some(TerminalAgentSessionInfo {
                    session_id: registry_session_id.to_string(),
                }),
            }),
            host_id: "host-a".to_string(),
            reader_token: "reader-token".to_string(),
            window_label: Mutex::new("main".to_string()),
            output_backlog: Mutex::new(Vec::new()),
            output_sequence: Mutex::new(0),
            output_backlog_start_sequence: Mutex::new(0),
        });
        state
            .sessions
            .lock()
            .expect("terminal sessions lock")
            .insert(view_session_id.to_string(), session);

        let title_updater = thread::spawn(move || {
            update_terminal_title(TerminalTitleInput {
                session_id: view_session_id.to_string(),
                title: "Editor: main.go".to_string(),
            })
        });
        match command_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("update_terminal_title sends a daemon command")
        {
            RemoteAgentCommand::TitleChange(title, response_tx) => {
                assert_eq!(title, "Editor: main.go");
                response_tx
                    .send(Ok(TerminalAgentResponse::Ok))
                    .expect("send title response");
            }
            _ => panic!("update_terminal_title should send title_change"),
        }
        title_updater
            .join()
            .expect("title update thread panicked")
            .expect("title update succeeds");

        remove_terminal_session(view_session_id);
    }

    #[test]
    fn terminal_session_ids_use_uuid_without_process_counter() {
        let first = new_terminal_session_id();
        let second = new_terminal_session_id();

        assert!(first.starts_with("term-"));
        assert!(second.starts_with("term-"));
        assert_ne!(
            first, second,
            "registry-backed sessions must not collide across app process restarts"
        );
        assert_ne!(
            first, "term-1",
            "registry session ids cannot include only the in-process counter"
        );
        assert!(
            !first.starts_with("term-1-"),
            "registry session ids should not encode process-local ordering"
        );
    }

    #[test]
    fn terminal_history_views_keep_registry_session_id_separate_from_view_id() {
        let session = Arc::new(TerminalSession {
            backend: Mutex::new(TerminalBackend::AgentHistory {
                registry_session_id: "registry-session-id".to_string(),
            }),
            info: Mutex::new(TerminalSessionInfo {
                id: "view-session-id".to_string(),
                title: "History".to_string(),
                command: "bash".to_string(),
                cwd: None,
                cols: 80,
                rows: 24,
                pixel_width: 800,
                pixel_height: 600,
                process_id: None,
                transport: TerminalTransportKind::Agent,
                transport_state: TerminalTransportState::Disconnected,
                agent: Some(TerminalAgentSessionInfo {
                    session_id: "registry-session-id".to_string(),
                }),
            }),
            host_id: "host-a".to_string(),
            reader_token: "reader-token".to_string(),
            window_label: Mutex::new("main".to_string()),
            output_backlog: Mutex::new(Vec::new()),
            output_sequence: Mutex::new(0),
            output_backlog_start_sequence: Mutex::new(0),
        });

        assert!(terminal_session_is_history_view(&session));
        assert_eq!(
            terminal_history_registry_session_id(&session).expect("history registry session id"),
            "registry-session-id"
        );
    }

    #[test]
    fn default_terminal_font_uses_maple_then_nerd_symbols() {
        let config = parse_toml("").expect("valid TOML");

        let settings =
            terminal_settings_from_config_for_test(&config).expect("valid terminal settings");

        assert_eq!(settings.font_family, DEFAULT_TERMINAL_FONT_FAMILY);
        assert!(settings
            .font_family
            .starts_with("\"Maple Mono\", \"Symbols Nerd Font Mono\""));
        assert!(settings.font_family.ends_with("monospace"));
    }

    #[test]
    fn parses_uniform_terminal_padding() {
        let config = parse_toml(
            r#"
            [terminal]
            padding = 6
            "#,
        )
        .expect("valid TOML");

        let settings =
            terminal_settings_from_config_for_test(&config).expect("valid terminal settings");

        assert_eq!(settings.padding.top, 6.0);
        assert_eq!(settings.padding.right, 6.0);
        assert_eq!(settings.padding.bottom, 6.0);
        assert_eq!(settings.padding.left, 6.0);
    }

    #[test]
    fn parses_terminal_padding_edges() {
        let config = parse_toml(
            r#"
            [terminal.padding]
            horizontal = 14
            vertical = 7
            left = 3
            bottom = 11
            "#,
        )
        .expect("valid TOML");

        let settings =
            terminal_settings_from_config_for_test(&config).expect("valid terminal settings");

        assert_eq!(settings.padding.top, 7.0);
        assert_eq!(settings.padding.right, 14.0);
        assert_eq!(settings.padding.bottom, 11.0);
        assert_eq!(settings.padding.left, 3.0);
    }

    #[test]
    fn parses_tab_bar_orientation_placements() {
        let horizontal = parse_tab_bar_orientation("horizontal").expect("valid placement");
        let left = parse_tab_bar_orientation("vertical_left").expect("valid placement");
        let right = parse_tab_bar_orientation("vertical_right").expect("valid placement");
        let legacy_vertical = parse_tab_bar_orientation("vertical").expect("legacy placement");

        assert_eq!(horizontal, TabBarOrientation::Horizontal);
        assert_eq!(left, TabBarOrientation::VerticalLeft);
        assert_eq!(right, TabBarOrientation::VerticalRight);
        assert_eq!(legacy_vertical, TabBarOrientation::VerticalRight);
    }

    #[test]
    fn rejects_legacy_canvas_renderer() {
        let config = parse_toml(
            r#"
            [terminal]
            renderer = "canvas"
            "#,
        )
        .expect("valid TOML");

        let error = terminal_settings_from_config_for_test(&config)
            .expect_err("legacy renderer is invalid");

        assert!(format!("{error:?}").contains("terminal.renderer must be dom or webgl"));
    }

    #[test]
    fn terminal_command_advertises_iip_compatibility() {
        let settings = TerminalSettings::default();
        let command = build_terminal_command(&settings, None, &BTreeMap::new());

        assert_eq!(
            command
                .get_env("TERM_PROGRAM")
                .and_then(|value| value.to_str()),
            Some("Nocturne")
        );
        assert_eq!(
            command
                .get_env("ITERM_SESSION_ID")
                .and_then(|value| value.to_str()),
            Some("nocturne")
        );
        assert_eq!(
            command
                .get_env("NOCTURNE_IMAGE_PROTOCOL")
                .and_then(|value| value.to_str()),
            Some("iip")
        );
    }

    #[test]
    fn terminal_agent_resource_path_uses_target_os_and_arch() {
        assert_eq!(
            terminal_agent_resource_path(
                RemoteResourceTargetOs::Linux,
                RemoteResourceTargetArch::X86_64
            ),
            "nocturne-terminal-agent/linux/x86_64/nocturne-terminal-agent"
        );
        assert_eq!(
            terminal_agent_resource_path(
                RemoteResourceTargetOs::Windows,
                RemoteResourceTargetArch::I686
            ),
            "nocturne-terminal-agent/windows/i686/nocturne-terminal-agent.exe"
        );
    }

    #[test]
    fn terminal_agent_client_command_quotes_arguments() {
        let command = go_terminal_agent_client_command(
            RemoteResourceTargetOs::Linux,
            "/tmp/nocturne agent",
            "session'withquote",
            "write",
            &[("--data", "abc+123/=")],
        );

        assert_eq!(
            command,
            "'/tmp/nocturne agent' 'client' 'write' '--session-id' 'session'\"'\"'withquote' '--data' 'abc+123/='"
        );
    }

    #[test]
    fn terminal_agent_launch_spec_path_uses_windows_path_separator() {
        let path = terminal_agent_remote_launch_spec_path(
            RemoteResourceTargetOs::Windows,
            r"C:\Users\Ada",
            "session-a",
        );

        assert_eq!(
            path,
            r"C:\Users\Ada\AppData\Local\Temp\nocturne-terminal-agent-session-a.json"
        );
        assert!(!path.contains("/AppData/"));
    }

    #[test]
    fn terminal_agent_daemon_launch_reads_stdin_spec() {
        let command = go_terminal_agent_launch_background_command(
            RemoteResourceTargetOs::Linux,
            "/tmp/nocturne-agent",
            "/tmp/session-a.json",
        );

        assert_eq!(
            command,
            "nohup '/tmp/nocturne-agent' daemon --launch-spec-stdin < '/tmp/session-a.json' >/dev/null 2>&1 &"
        );
    }

    #[test]
    fn go_terminal_agent_launch_spec_contains_session_and_host_identity() {
        let settings = TerminalSettings {
            command: Some("/bin/zsh".to_string()),
            args: vec!["-l".to_string()],
            cwd: Some("/repo".to_string()),
            ..TerminalSettings::default()
        };
        let spec = build_go_terminal_agent_launch_spec(
            "session-a",
            "host-a",
            "Session 1",
            &settings,
            None,
            &BTreeMap::new(),
            PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 800,
                pixel_height: 480,
            },
        );
        let json = serde_json::to_string(&spec).expect("serializes launch spec");

        assert!(json.contains(r#""version":1"#));
        assert!(json.contains(r#""session_id":"session-a""#));
        assert!(json.contains(r#""host_id":"host-a""#));
        assert!(json.contains(r#""command":"/bin/zsh""#));
        assert!(json.contains(r#""args":["-l"]"#));
    }

    #[test]
    fn parses_terminal_agent_list_sessions_and_complete_count() {
        let output = concat!(
            r#"{"type":"session","session":{"session_id":"term-1","host_id":"host-a","title":"Session 1","command":"zsh","cwd":"/repo","agent_version":"0.1.0","protocol_version":1,"cols":100,"rows":30,"pixel_width":900,"pixel_height":500,"endpoint":{"kind":"unix","path":"/tmp/sock"},"transcript":"term-1.ndjson","status":"running","attached_count":2}}"#,
            "\n",
            r#"{"type":"complete","count":1}"#,
            "\n"
        );

        let sessions = parse_go_agent_session_list(output, "host-a").expect("valid list output");

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "term-1");
        assert_eq!(sessions[0].cwd.as_deref(), Some("/repo"));
        assert_eq!(sessions[0].cols, Some(100));
        assert_eq!(sessions[0].rows, Some(30));
        assert_eq!(sessions[0].pixel_width, Some(900));
        assert_eq!(sessions[0].pixel_height, Some(500));
        assert_eq!(sessions[0].status, "running");
        assert_eq!(sessions[0].attached_count, Some(2));
    }

    #[test]
    fn terminal_agent_list_rejects_invalid_registry_lines() {
        let output = r#"{"type":"invalid","path":"wrong.toml","error":"registry filename does not match session_id"}"#;

        let error =
            parse_go_agent_session_list(output, "host-a").expect_err("invalid line fails fast");

        assert!(format!("{error:?}").contains("registry filename does not match session_id"));
    }

    #[test]
    fn terminal_agent_list_requires_complete_line() {
        let output = r#"{"type":"session","session":{"session_id":"term-1","host_id":"host-a","title":"Session 1","command":"zsh","status":"stale"}}"#;

        let error =
            parse_go_agent_session_list(output, "host-a").expect_err("missing complete line fails");

        assert!(format!("{error:?}").contains("complete line"));
    }

    #[test]
    fn terminal_agent_view_sizes_use_smallest_attached_view() {
        let state = TerminalState::default();
        let first = record_agent_view_size(
            &state,
            "registry-session",
            "view-a",
            PtySize {
                rows: 40,
                cols: 120,
                pixel_width: 1200,
                pixel_height: 800,
            },
        )
        .expect("records first view size");
        let second = record_agent_view_size(
            &state,
            "registry-session",
            "view-b",
            PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 900,
                pixel_height: 600,
            },
        )
        .expect("records second view size");

        assert_eq!(first.cols, 120);
        assert_eq!(first.rows, 40);
        assert_eq!(second.cols, 80);
        assert_eq!(second.rows, 24);
        assert_eq!(second.pixel_width, 900);
        assert_eq!(second.pixel_height, 600);

        remove_agent_view_size(&state, "view-b");
        let restored = record_agent_view_size(
            &state,
            "registry-session",
            "view-a",
            PtySize {
                rows: 40,
                cols: 120,
                pixel_width: 1200,
                pixel_height: 800,
            },
        )
        .expect("records remaining view size");
        assert_eq!(restored.cols, 120);
        assert_eq!(restored.rows, 40);
    }

    #[test]
    fn maps_terminal_agent_registry_session_to_terminal_info() {
        let listed = GoAgentListedSession {
            session_id: "term-9".to_string(),
            host_id: "host-a".to_string(),
            title: "Build".to_string(),
            command: "cargo check".to_string(),
            cwd: Some("/repo".to_string()),
            cols: Some(132),
            rows: Some(40),
            pixel_width: Some(1200),
            pixel_height: Some(720),
            status: "exited".to_string(),
            attached_count: Some(1),
        };

        let detached = terminal_detached_info_from_go_session(&listed);
        let info = terminal_session_info_from_go_session(&listed);
        let attached_view =
            terminal_session_info_from_go_session_with_view_id(&listed, "term-42".to_string());
        let history_view =
            terminal_history_session_info_from_go_session(&listed, "term-43".to_string());

        assert_eq!(detached.session_id, "term-9");
        assert!(!detached.detached);
        assert_eq!(detached.cols, 132);
        assert_eq!(detached.rows, 40);
        assert_eq!(detached.attached_count, 1);
        assert_eq!(info.id, "term-9");
        assert_eq!(info.cwd.as_deref(), Some("/repo"));
        assert_eq!(info.transport_state, TerminalTransportState::Disconnected);
        assert_eq!(info.agent.expect("agent metadata").session_id, "term-9");
        assert_eq!(attached_view.id, "term-42");
        assert_eq!(
            attached_view.agent.expect("agent metadata").session_id,
            "term-9"
        );
        assert_eq!(history_view.id, "term-43");
        assert_eq!(
            history_view.agent.expect("agent metadata").session_id,
            "term-9"
        );
        assert_eq!(
            history_view.transport_state,
            TerminalTransportState::Disconnected
        );
    }

    #[test]
    fn remote_home_path_command_matches_target_shell() {
        assert_eq!(
            remote_home_path_command(RemoteResourceTargetOs::Linux),
            "printf %s \"$HOME\""
        );
        assert_eq!(
            remote_home_path_command(RemoteResourceTargetOs::Macos),
            "printf %s \"$HOME\""
        );
        assert_eq!(
            remote_home_path_command(RemoteResourceTargetOs::Windows),
            "[Environment]::GetFolderPath('UserProfile')"
        );
    }

    #[test]
    fn terminal_agent_upload_plan_contains_detach_capability() {
        let plan = plan_terminal_agent_upload(
            b"terminal-agent-binary",
            RemoteResourceTargetOs::Macos,
            RemoteResourceTargetArch::Aarch64,
            "0.1.0",
        )
        .expect("valid upload plan");

        assert_eq!(plan.manifest.helper_name, "nocturne-terminal-agent");
        assert_eq!(plan.manifest.purpose, "Terminal detach and remote control");
        assert!(plan
            .manifest
            .capabilities
            .contains(&"terminal.detach".to_string()));
        assert_eq!(
            plan.resource_path,
            "nocturne-terminal-agent/macos/aarch64/nocturne-terminal-agent"
        );
    }

    #[test]
    fn terminal_command_prefers_runtime_cwd_override() {
        let settings = TerminalSettings {
            cwd: Some("/configured".to_string()),
            ..TerminalSettings::default()
        };
        let command = build_terminal_command(&settings, Some("/runtime"), &BTreeMap::new());

        assert_eq!(
            command.get_cwd().and_then(|value| value.to_str()),
            Some("/runtime")
        );
    }

    #[test]
    fn missing_session_backlog_is_empty() {
        let event = take_terminal_output_backlog(TerminalOutputBacklogInput {
            session_id: "missing-session".to_string(),
        })
        .expect("missing sessions have no backlog");

        assert!(event.is_none());
    }

    #[test]
    fn parses_proxy_jump_user_host_and_port() {
        let config = parse_proxy_jump_hop("deploy@bastion.example.com:2200").expect("valid jump");

        assert_eq!(config.username.as_deref(), Some("deploy"));
        assert_eq!(config.hostname, "bastion.example.com");
        assert_eq!(config.port, 2200);
    }

    #[test]
    fn parses_proxy_jump_ipv6_bracket_host() {
        let config = parse_proxy_jump_hop("ops@[2001:db8::10]:2222").expect("valid ipv6 jump");

        assert_eq!(config.username.as_deref(), Some("ops"));
        assert_eq!(config.hostname, "2001:db8::10");
        assert_eq!(config.port, 2222);
    }

    #[test]
    fn parses_proxy_jump_ipv6_bracket_host_with_default_port() {
        let config = parse_proxy_jump_hop("ops@[2001:db8::10]").expect("valid ipv6 jump");

        assert_eq!(config.username.as_deref(), Some("ops"));
        assert_eq!(config.hostname, "2001:db8::10");
        assert_eq!(config.port, 22);
    }

    #[test]
    fn strips_brackets_from_ipv6_hostname_for_network_connections() {
        assert_eq!(ssh_network_hostname("[2001:db8::1]"), "2001:db8::1");
        assert_eq!(ssh_network_hostname("2001:db8::1"), "2001:db8::1");
        assert_eq!(ssh_network_hostname("prod.example.com"), "prod.example.com");
    }

    #[test]
    fn parses_proxy_jump_chain_in_order() {
        let config = parse_proxy_jump_chain("first.example.com,ops@second.example.com:2200")
            .expect("valid jump");

        assert_eq!(config.len(), 2);
        assert_eq!(config[0].hostname, "first.example.com");
        assert_eq!(config[0].port, 22);
        assert_eq!(config[1].username.as_deref(), Some("ops"));
        assert_eq!(config[1].hostname, "second.example.com");
        assert_eq!(config[1].port, 2200);
    }

    #[test]
    fn ssh_pending_write_queue_rejects_unbounded_input() {
        let mut pending = VecDeque::new();
        queue_pending_bytes(&mut pending, &vec![b'a'; SSH_PENDING_WRITE_LIMIT])
            .expect("limit-sized input is accepted");

        let error = queue_pending_bytes(&mut pending, b"a").expect_err("overflow is rejected");

        assert!(format!("{error:?}").contains("ssh input buffer exceeded"));
        assert_eq!(pending.len(), SSH_PENDING_WRITE_LIMIT);
    }
}
