use std::{
    collections::{BTreeMap, HashMap},
    env,
    io::{Read, Write},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter};

use crate::{
    config::effective_application_config,
    error::{invalid_error, missing_error, terminal_error, Result},
    terminal_schemes::{
        builtin_dark_scheme, builtin_light_scheme, scheme_to_terminal_theme,
        terminal_color_scheme_by_id,
    },
    types::{
        CreateTerminalSessionInput, TabBarOrientation, TerminalCursorStyle, TerminalExitEvent,
        TerminalInput, TerminalOutputEvent, TerminalPadding, TerminalRenderer, TerminalSessionInfo,
        TerminalSettings, TerminalSettingsInput, TerminalSizeInput, TerminalTheme,
        TerminalColorSchemeVariant,
    },
};

const TERMINAL_OUTPUT_EVENT: &str = "terminal://output";
const TERMINAL_EXIT_EVENT: &str = "terminal://exit";

struct TerminalSession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
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
        Some(_) => return Err(invalid_error("terminal.color_scheme.light must be a string")),
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

fn terminal_env_from_config(config: &toml::Value) -> Result<BTreeMap<String, String>> {
    let Some(table) = terminal_table(config)? else {
        return Ok(BTreeMap::new());
    };
    optional_string_map(table, "env").map(Option::unwrap_or_default)
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

fn session_by_id(id: &str) -> Result<Arc<TerminalSession>> {
    let state = terminal_state();
    let sessions = state.sessions.lock().unwrap();
    sessions
        .get(id)
        .cloned()
        .ok_or_else(|| missing_error(format!("terminal session {id} not found")))
}

fn spawn_terminal_reader(app: AppHandle, session_id: String, mut reader: Box<dyn Read + Send>) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    let event = TerminalOutputEvent {
                        session_id: session_id.clone(),
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
pub(crate) fn create_terminal_session(
    app: AppHandle,
    input: CreateTerminalSessionInput,
) -> Result<TerminalSessionInfo> {
    let size = validated_pty_size(
        input.cols,
        input.rows,
        input.pixel_width,
        input.pixel_height,
    )?;
    let config = effective_application_config(&app)?;
    let settings = terminal_settings_from_config(&app, &config, input.resolved_theme)?;
    let env_overrides = terminal_env_from_config(&config)?;
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
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        killer: Mutex::new(killer),
    });
    {
        let mut sessions = state.sessions.lock().unwrap();
        sessions.insert(id.clone(), session);
    }

    spawn_terminal_reader(app.clone(), id.clone(), reader);
    spawn_terminal_waiter(app, id.clone(), child);

    Ok(TerminalSessionInfo {
        id,
        title: format!("Session {session_number}"),
        command: command_label,
        cwd: input.cwd.or(settings.cwd),
        cols: input.cols,
        rows: input.rows,
        pixel_width: input.pixel_width,
        pixel_height: input.pixel_height,
        process_id,
    })
}

#[tauri::command]
#[specta::specta]
pub(crate) fn write_terminal(input: TerminalInput) -> Result<()> {
    let session = session_by_id(&input.session_id)?;
    let mut writer = session.writer.lock().unwrap();
    writer
        .write_all(input.data.as_bytes())
        .map_err(terminal_error)?;
    writer.flush().map_err(terminal_error)
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
    let session = session_by_id(&input.session_id)?;
    let master = session.master.lock().unwrap();
    master.resize(size).map_err(terminal_error)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn close_terminal_session(session_id: String) -> Result<()> {
    let session = session_by_id(&session_id)?;
    {
        let mut killer = session.killer.lock().unwrap();
        killer.kill().map_err(terminal_error)?;
    }
    remove_terminal_session(&session_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::parse_toml;

    #[test]
    fn parses_uniform_terminal_padding() {
        let config = parse_toml(
            r#"
            [terminal]
            padding = 6
            "#,
        )
        .expect("valid TOML");

        let settings = terminal_settings_from_config(&config).expect("valid terminal settings");

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

        let settings = terminal_settings_from_config(&config).expect("valid terminal settings");

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

        let error = terminal_settings_from_config(&config).expect_err("legacy renderer is invalid");

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
}
