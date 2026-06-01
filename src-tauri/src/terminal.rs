use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    env,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use keyring_core::Entry as KeyringEntry;
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use ssh2::{Channel, HashType, HostKeyType, Session};
use tauri::{AppHandle, Emitter};

use crate::{
    config::{
        connection_host_by_id, default_connection_host_id, effective_application_config,
        resolve_openssh_proxy_jump_chain, ssh_known_hosts_path,
    },
    error::{invalid_error, missing_error, terminal_error, Result},
    ssh_trust::{ssh_trust_target, SshTrustStore},
    terminal_schemes::{
        builtin_dark_scheme, builtin_light_scheme, scheme_to_terminal_theme,
        terminal_color_scheme_by_id,
    },
    types::{
        ConnectionDiagnosticSeverity, ConnectionHostEntry, ConnectionHostSource,
        ConnectionProtocol, CreateHostTerminalSessionInput, ExistingTerminalSessionInput,
        LocalConnectionConfig, SshConnectionConfig, SshCredentialInput, SshCredentialKind,
        TabBarOrientation, TerminalColorSchemeVariant, TerminalCursorStyle, TerminalExitEvent,
        TerminalInput, TerminalOutputBacklogInput, TerminalOutputEvent, TerminalPadding,
        TerminalRenderer, TerminalSessionInfo, TerminalSessionOwnershipInput, TerminalSettings,
        TerminalSettingsInput, TerminalSizeInput, TerminalTheme, TerminalTransportKind,
        TerminalTransportState, TerminalTransportStateEvent,
    },
};

const TERMINAL_OUTPUT_EVENT: &str = "terminal://output";
const TERMINAL_EXIT_EVENT: &str = "terminal://exit";
const TERMINAL_TRANSPORT_STATE_EVENT: &str = "terminal://transport-state";
const OUTPUT_BACKLOG_LIMIT: usize = 512 * 1024;
const SSH_PENDING_WRITE_LIMIT: usize = 1024 * 1024;
const SSH_WRITE_CHUNK_LIMIT: usize = 8192;

struct TerminalSession {
    backend: Mutex<TerminalBackend>,
    info: Mutex<TerminalSessionInfo>,
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
            font_family: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
                .to_string(),
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
            settings.theme = match theme_variant {
                TerminalColorSchemeVariant::Light => {
                    scheme_to_terminal_theme(&builtin_light_scheme())
                }
                TerminalColorSchemeVariant::Dark => {
                    scheme_to_terminal_theme(&builtin_dark_scheme())
                }
            };
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
        settings.theme = match theme_variant {
            TerminalColorSchemeVariant::Light => scheme_to_terminal_theme(&builtin_light_scheme()),
            TerminalColorSchemeVariant::Dark => scheme_to_terminal_theme(&builtin_dark_scheme()),
        };
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
}

fn kill_terminal_session(session: Arc<TerminalSession>) -> Result<()> {
    let mut backend = session.backend.lock().unwrap();
    match &mut *backend {
        TerminalBackend::Local { killer, .. } => killer.kill().map_err(terminal_error),
        TerminalBackend::Ssh { commands } => commands
            .send(SshWorkerCommand::Close)
            .map_err(|error| terminal_error(format!("failed to close ssh session: {error}"))),
    }
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
        if let Err(error) = kill_terminal_session(session) {
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
            },
            Err(error) => TerminalExitEvent {
                session_id,
                exit_code: None,
                signal: Some(error.to_string()),
            },
        };
        let _ = app.emit(TERMINAL_EXIT_EVENT, event);
    });
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
) {
    remove_terminal_session(&session_id);
    let _ = app.emit(
        TERMINAL_EXIT_EVENT,
        TerminalExitEvent {
            session_id,
            exit_code,
            signal,
        },
    );
}

pub(crate) struct SshWorkerInput {
    pub(crate) app: Option<AppHandle>,
    pub(crate) session_id: String,
    pub(crate) display_name: String,
    pub(crate) host_id: String,
    pub(crate) ssh: SshConnectionConfig,
    pub(crate) proxy_jump_chain: Option<Vec<SshConnectionConfig>>,
    pub(crate) username: String,
    pub(crate) size: PtySize,
    pub(crate) trust_path: PathBuf,
    pub(crate) accept_new_host_key: bool,
    pub(crate) update_changed_host_key: bool,
    pub(crate) credential: Option<SshCredentialInput>,
    pub(crate) save_credential: bool,
}

struct PreparedSshSession {
    channel: Channel,
    jump_guards: Vec<thread::JoinHandle<()>>,
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
                emit_terminal_exit(&app, session_id, None, Some(error.to_string()));
                return;
            }
        };
        let mut channel = prepared.channel;
        let result = run_ssh_worker(&app, &session_id, &mut channel, receiver);
        if let Err(error) = result {
            update_terminal_transport_state(&app, &session_id, TerminalTransportState::Failed);
            emit_terminal_exit(&app, session_id, None, Some(error.to_string()));
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
    emit_terminal_exit(app, session_id.to_string(), Some(0), signal);
    Ok(())
}

fn prepare_ssh_session(input: &SshWorkerInput) -> Result<PreparedSshSession> {
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
    authenticate_ssh_session(&session, input)?;
    update_ssh_input_transport_state(input, TerminalTransportState::Connected);

    let mut channel = session.channel_session().map_err(terminal_error)?;
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
    tcp_mode.set_nonblocking(true).map_err(terminal_error)?;
    session.set_blocking(false);
    Ok(PreparedSshSession {
        channel,
        jump_guards,
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
        display_name: format!("{} via {}", input.display_name, jump.hostname),
        host_id: format!("proxy-jump:{}", ssh_trust_target(&jump.hostname, jump.port)),
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
        credential: input.credential.clone(),
        save_credential: input.save_credential,
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

fn bridge_proxy_channel(mut local: TcpStream, mut remote: Channel) {
    let _ = local.set_nonblocking(true);
    let mut local_buffer = [0_u8; 8192];
    let mut remote_buffer = [0_u8; 8192];
    let mut pending_remote_writes = VecDeque::new();
    let mut pending_local_writes = VecDeque::new();
    loop {
        let mut progressed = false;
        match drain_ssh_pending_writes(&mut remote, &mut pending_remote_writes) {
            Ok(true) => progressed = true,
            Ok(false) => {}
            Err(_) => break,
        }
        match drain_tcp_pending_writes(&mut local, &mut pending_local_writes) {
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
        if let Some(passphrase) = read_ssh_secret_from_keyring(
            &input.host_id,
            username,
            SshCredentialKind::KeyPassphrase,
            input.ssh.identity_file.as_deref(),
        ) {
            if session
                .userauth_pubkey_file(username, None, path, Some(&passphrase))
                .is_ok()
                && session.authenticated()
            {
                return Ok(());
            }
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
                if input.save_credential {
                    write_ssh_secret_to_keyring(
                        &input.host_id,
                        username,
                        SshCredentialKind::KeyPassphrase,
                        input.ssh.identity_file.as_deref(),
                        passphrase,
                    )?;
                }
                return Ok(());
            }
        }
    }

    if let Some(password) =
        read_ssh_secret_from_keyring(&input.host_id, username, SshCredentialKind::Password, None)
    {
        if session.userauth_password(username, &password).is_ok() && session.authenticated() {
            return Ok(());
        }
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
            if input.save_credential {
                write_ssh_secret_to_keyring(
                    &input.host_id,
                    username,
                    SshCredentialKind::Password,
                    None,
                    password,
                )?;
            }
            return Ok(());
        }
    }

    let methods = session.auth_methods(username).unwrap_or("");
    if input.ssh.identity_file.is_some() && methods.contains("publickey") {
        return Err(terminal_error("ssh credential required: key_passphrase"));
    }
    if methods.contains("password") || methods.contains("keyboard-interactive") {
        return Err(terminal_error("ssh credential required: password"));
    }
    Err(terminal_error(format!(
        "ssh authentication failed; supported methods: {methods}"
    )))
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
        return Err(terminal_error(format!(
            "ssh host key changed for {} ({target}); blocked until you choose Update Trust Record for {algorithm} {fingerprint}",
            input.display_name
        )));
    }
    if !store.has_target_algorithm(&target, &algorithm) && !input.accept_new_host_key {
        return Err(terminal_error(format!(
            "ssh host key is not trusted for {} ({target}); confirm {algorithm} {fingerprint} to continue",
            input.display_name
        )));
    }
    store.upsert_key(target, key);
    store.save(&input.trust_path)
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

fn ssh_keyring_account(
    host_id: &str,
    username: &str,
    kind: SshCredentialKind,
    identity_file: Option<&str>,
) -> String {
    match kind {
        SshCredentialKind::Password => format!("connection-host:{host_id}:password:{username}"),
        SshCredentialKind::KeyPassphrase => format!(
            "connection-host:{host_id}:key_passphrase:{username}:{}",
            identity_file.unwrap_or("")
        ),
    }
}

fn read_ssh_secret_from_keyring(
    host_id: &str,
    username: &str,
    kind: SshCredentialKind,
    identity_file: Option<&str>,
) -> Option<String> {
    let _ = keyring::use_native_store(true);
    let account = ssh_keyring_account(host_id, username, kind, identity_file);
    KeyringEntry::new("nocturne", &account)
        .and_then(|entry| entry.get_password())
        .ok()
}

fn write_ssh_secret_to_keyring(
    host_id: &str,
    username: &str,
    kind: SshCredentialKind,
    identity_file: Option<&str>,
    value: &str,
) -> Result<()> {
    keyring::use_native_store(true).map_err(terminal_error)?;
    let account = ssh_keyring_account(host_id, username, kind, identity_file);
    let entry = KeyringEntry::new("nocturne", &account).map_err(terminal_error)?;
    entry.set_password(value).map_err(terminal_error)
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
    let host_id = if input.connection_host_id.trim().is_empty() {
        default_connection_host_id(&app)?
    } else {
        input.connection_host_id.clone()
    };
    let host = connection_host_by_id(&app, &host_id)?;
    validate_connection_host_for_terminal(&host)?;
    match host.document.protocol {
        ConnectionProtocol::Local => create_local_host_terminal_session(app, input, host, size),
        ConnectionProtocol::Ssh => create_ssh_host_terminal_session(app, input, host, size),
        ConnectionProtocol::Telnet => Err(invalid_error("telnet sessions are not implemented yet")),
    }
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
    let session_number = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let id = format!("term-{session_number}");
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
        }),
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
    let trust_path = ssh_known_hosts_path(&app)?;
    let state = terminal_state();
    let session_number = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let id = format!("term-{session_number}");
    let worker = SshWorkerInput {
        app: Some(app.clone()),
        session_id: id.clone(),
        display_name: host.document.name.clone(),
        host_id: host.id.clone(),
        ssh: ssh.clone(),
        proxy_jump_chain,
        username: username.clone(),
        size,
        trust_path,
        accept_new_host_key: input.accept_new_host_key,
        update_changed_host_key: input.update_changed_host_key,
        credential: input.credential,
        save_credential: input.save_credential,
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
        }),
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
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn close_terminal_session(session_id: String) -> Result<()> {
    let session = match session_by_id(&session_id) {
        Ok(session) => session,
        Err(_) => return Ok(()),
    };
    kill_terminal_session(session)?;
    remove_terminal_session(&session_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::parse_toml;
    use tempfile::tempdir;

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
    #[ignore = "requires Docker; run with cargo test ssh_proxy_jump_multi_hop_reaches_target_through_docker -- --ignored"]
    fn ssh_proxy_jump_multi_hop_reaches_target_through_docker() {
        let fixture = DockerSshFixture::start();
        let config_path = fixture.root.path().join("ssh_config");
        std::fs::write(
            &config_path,
            &format!(
                r#"
                Host jump1
                  HostName 127.0.0.1
                  Port {}
                  User root

                Host jump2
                  HostName {}
                  User root

                Host target
                  HostName {}
                  User root
                  ProxyJump jump1,jump2
                "#,
                fixture.jump1_port, fixture.jump2_name, fixture.target_name
            ),
        )
        .expect("write OpenSSH config");
        let proxy_jump_chain =
            crate::config::resolve_openssh_proxy_jump_chain(&config_path, "jump1,jump2")
                .expect("resolve OpenSSH ProxyJump aliases");
        assert_eq!(proxy_jump_chain[0].hostname, "127.0.0.1");
        assert_eq!(proxy_jump_chain[0].port, fixture.jump1_port);
        assert_eq!(proxy_jump_chain[1].hostname, fixture.jump2_name);

        let input = SshWorkerInput {
            app: None,
            session_id: "docker-proxy-jump-test".to_string(),
            display_name: "docker target".to_string(),
            host_id: "docker-target".to_string(),
            ssh: SshConnectionConfig {
                hostname: fixture.target_name.clone(),
                port: 22,
                username: Some("root".to_string()),
                identity_file: None,
                proxy_jump: Some("jump1,jump2".to_string()),
                forward_agent: false,
                server_alive_interval: None,
            },
            proxy_jump_chain: Some(proxy_jump_chain),
            username: "root".to_string(),
            size: PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 800,
                pixel_height: 600,
            },
            trust_path: fixture.root.path().join("known-hosts.toml"),
            accept_new_host_key: true,
            update_changed_host_key: false,
            credential: Some(SshCredentialInput {
                kind: SshCredentialKind::Password,
                value: "nocturne".to_string(),
            }),
            save_credential: false,
        };
        let mut prepared = prepare_ssh_session(&input).expect("connect through two jump hosts");
        prepared
            .channel
            .write_all(b"printf 'nocturne-docker-target\\n'; exit\n")
            .expect("write shell command");

        let output = read_ssh_channel_until(&mut prepared.channel, "nocturne-docker-target");
        assert!(
            output.contains("nocturne-docker-target"),
            "expected target marker in SSH shell output, got: {output:?}"
        );
    }

    struct DockerSshFixture {
        root: tempfile::TempDir,
        network: String,
        image: String,
        jump1_name: String,
        jump2_name: String,
        target_name: String,
        jump1_port: u16,
    }

    impl DockerSshFixture {
        fn start() -> Self {
            require_docker();
            let root = tempdir().expect("temp dir");
            let suffix = format!(
                "{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("system clock after unix epoch")
                    .as_millis()
            );
            let image = format!("nocturne-ssh-test:{suffix}");
            let network = format!("nocturne-ssh-test-{suffix}");
            write_dockerfile(root.path());
            docker([
                "build",
                "-q",
                "-t",
                &image,
                root.path().to_string_lossy().as_ref(),
            ]);
            docker(["network", "create", &network]);

            let jump1_name = format!("nocturne-jump1-{suffix}");
            let jump2_name = format!("nocturne-jump2-{suffix}");
            let target_name = format!("nocturne-target-{suffix}");
            docker([
                "run",
                "-d",
                "--rm",
                "--name",
                &jump1_name,
                "--network",
                &network,
                "-p",
                "127.0.0.1::22",
                &image,
            ]);
            docker([
                "run",
                "-d",
                "--rm",
                "--name",
                &jump2_name,
                "--network",
                &network,
                &image,
            ]);
            docker([
                "run",
                "-d",
                "--rm",
                "--name",
                &target_name,
                "--network",
                &network,
                &image,
            ]);
            wait_for_ssh_container(&jump1_name);
            wait_for_ssh_container(&jump2_name);
            wait_for_ssh_container(&target_name);
            let jump1_port = docker_output([
                "inspect",
                "-f",
                "{{(index (index .NetworkSettings.Ports \"22/tcp\") 0).HostPort}}",
                &jump1_name,
            ])
            .trim()
            .parse::<u16>()
            .expect("mapped jump host port");

            Self {
                root,
                network,
                image,
                jump1_name,
                jump2_name,
                target_name,
                jump1_port,
            }
        }
    }

    impl Drop for DockerSshFixture {
        fn drop(&mut self) {
            let _ = std::process::Command::new("docker")
                .args([
                    "rm",
                    "-f",
                    &self.jump1_name,
                    &self.jump2_name,
                    &self.target_name,
                ])
                .output();
            let _ = std::process::Command::new("docker")
                .args(["network", "rm", &self.network])
                .output();
            let _ = std::process::Command::new("docker")
                .args(["image", "rm", "-f", &self.image])
                .output();
        }
    }

    fn write_dockerfile(root: &Path) {
        let dockerfile = r#"
FROM alpine:3.20
RUN apk add --no-cache openssh-server \
  && ssh-keygen -A \
  && echo 'root:nocturne' | chpasswd \
  && sed -i 's/^#*PasswordAuthentication .*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
  && sed -i 's/^#*PermitRootLogin .*/PermitRootLogin yes/' /etc/ssh/sshd_config \
  && sed -i 's/^#*AllowTcpForwarding .*/AllowTcpForwarding yes/' /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
"#;
        std::fs::write(root.join("Dockerfile"), dockerfile).expect("write Dockerfile");
    }

    fn require_docker() {
        let status = std::process::Command::new("docker")
            .arg("version")
            .status()
            .expect("Docker is required for this ignored integration test");
        assert!(
            status.success(),
            "Docker is required for this integration test"
        );
    }

    fn docker<const N: usize>(args: [&str; N]) {
        let output = std::process::Command::new("docker")
            .args(args)
            .output()
            .expect("run docker");
        assert!(
            output.status.success(),
            "docker command failed\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn docker_output<const N: usize>(args: [&str; N]) -> String {
        let output = std::process::Command::new("docker")
            .args(args)
            .output()
            .expect("run docker");
        assert!(
            output.status.success(),
            "docker command failed\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).expect("docker stdout is utf8")
    }

    fn wait_for_ssh_container(name: &str) {
        for _ in 0..50 {
            let output = std::process::Command::new("docker")
                .args([
                    "exec",
                    name,
                    "sh",
                    "-lc",
                    "test -S /var/run/docker.sock || pgrep sshd >/dev/null",
                ])
                .output()
                .expect("docker exec");
            if output.status.success() {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        panic!("sshd did not become ready in {name}");
    }

    fn read_ssh_channel_until(channel: &mut Channel, marker: &str) -> String {
        let started = std::time::Instant::now();
        let mut output = Vec::new();
        let mut buffer = [0_u8; 4096];
        while started.elapsed() < Duration::from_secs(15) {
            match channel.read(&mut buffer) {
                Ok(0) => {
                    if channel.eof() {
                        break;
                    }
                }
                Ok(size) => {
                    output.extend_from_slice(&buffer[..size]);
                    let text = String::from_utf8_lossy(&output);
                    if text.contains(marker) {
                        return text.into_owned();
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) => panic!("failed to read SSH channel: {error}"),
            }
            thread::sleep(Duration::from_millis(20));
        }
        String::from_utf8_lossy(&output).into_owned()
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
