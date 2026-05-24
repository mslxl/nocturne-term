use std::{
    collections::{BTreeMap, HashMap},
    env, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use hex::ToHex;
use notify::{Config as NotifyConfig, RecommendedWatcher, RecursiveMode, Watcher};
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
#[cfg(debug_assertions)]
use specta_typescript::Typescript;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_specta::{collect_commands, Builder};

const CONFIG_CHANGED_EVENT: &str = "config://changed";
const TERMINAL_OUTPUT_EVENT: &str = "terminal://output";
const TERMINAL_EXIT_EVENT: &str = "terminal://exit";
const ROOT_DIR_NAME: &str = "nocturne";
const MAIN_CONFIG_FILE: &str = "config.toml";
const STATE_FILE: &str = "state.toml";
const PROFILES_DIR: &str = "profiles";
const DEFAULT_PROFILE_FILE: &str = "default.toml";
const DEFAULT_HOSTS_DIR: &str = "hosts";
const DEFAULT_PROFILE_NAME: &str = "default";

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", content = "value")]
pub enum ConfigValue {
    String(String),
    Integer(String),
    Float(f64),
    Boolean(bool),
    Datetime(String),
    Array(Vec<ConfigValue>),
    Table(BTreeMap<String, ConfigValue>),
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
pub struct ConfigTable {
    pub values: BTreeMap<String, ConfigValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
pub struct MainConfigDocument {
    pub root: ConfigTable,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
pub struct ProfileConfigDocument {
    pub root: ConfigTable,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
pub struct HostConfigDocument {
    pub root: ConfigTable,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
pub struct EffectiveConfigDocument {
    pub root: ConfigTable,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ConfigRootInfo {
    pub root_dir: String,
    pub active_profile: String,
    pub main_config_path: String,
    pub profile_config_path: String,
    pub state_path: String,
    pub host_dirs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ProfileEntry {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct HostEntry {
    pub id: String,
    pub path: String,
    pub document: HostConfigDocument,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AppConfigSnapshot {
    pub root: ConfigRootInfo,
    pub main_config: MainConfigDocument,
    pub profile_config: ProfileConfigDocument,
    pub effective_config: EffectiveConfigDocument,
    pub profiles: Vec<ProfileEntry>,
    pub hosts: Vec<HostEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct HostDirsInput {
    pub dirs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ProfileDocumentInput {
    pub name: String,
    pub document: ProfileConfigDocument,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct HostDocumentInput {
    pub id: Option<String>,
    pub document: HostConfigDocument,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TerminalRenderer {
    Canvas,
    Webgl,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TerminalCursorStyle {
    Block,
    Underline,
    Bar,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TabBarOrientation {
    Horizontal,
    Vertical,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TerminalTheme {
    pub background: String,
    pub foreground: String,
    pub cursor: String,
    pub selection_background: String,
    pub black: String,
    pub red: String,
    pub green: String,
    pub yellow: String,
    pub blue: String,
    pub magenta: String,
    pub cyan: String,
    pub white: String,
    pub bright_black: String,
    pub bright_red: String,
    pub bright_green: String,
    pub bright_yellow: String,
    pub bright_blue: String,
    pub bright_magenta: String,
    pub bright_cyan: String,
    pub bright_white: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TerminalSettings {
    pub command: Option<String>,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub font_family: String,
    pub font_size: f64,
    pub scrollback: u32,
    pub renderer: TerminalRenderer,
    pub cursor_blink: bool,
    pub cursor_style: TerminalCursorStyle,
    pub theme: TerminalTheme,
    pub tab_bar_orientation: TabBarOrientation,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CreateTerminalSessionInput {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TerminalSizeInput {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TerminalInput {
    pub session_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TerminalSessionInfo {
    pub id: String,
    pub title: String,
    pub command: String,
    pub cols: u16,
    pub rows: u16,
    pub process_id: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TerminalOutputEvent {
    pub session_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TerminalExitEvent {
    pub session_id: String,
    pub exit_code: Option<u32>,
    pub signal: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", content = "message")]
pub enum ConfigError {
    Io { message: String },
    Parse { message: String },
    Missing { message: String },
    Invalid { message: String },
    Terminal { message: String },
}

pub type Result<T> = std::result::Result<T, ConfigError>;

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io { message } => write!(f, "io error: {message}"),
            Self::Parse { message } => write!(f, "parse error: {message}"),
            Self::Missing { message } => write!(f, "missing value: {message}"),
            Self::Invalid { message } => write!(f, "invalid value: {message}"),
            Self::Terminal { message } => write!(f, "terminal error: {message}"),
        }
    }
}

impl std::error::Error for ConfigError {}

#[derive(Default)]
struct WatchState {
    watcher: Option<RecommendedWatcher>,
    watched: Vec<PathBuf>,
}

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

#[derive(Default)]
struct AppState {
    watcher: Mutex<WatchState>,
    terminal: TerminalState,
}

static APP_STATE: OnceLock<Arc<AppState>> = OnceLock::new();

fn app_state() -> Arc<AppState> {
    APP_STATE
        .get_or_init(|| Arc::new(AppState::default()))
        .clone()
}

fn io_error(error: impl std::fmt::Display) -> ConfigError {
    ConfigError::Io {
        message: error.to_string(),
    }
}

fn parse_error(error: impl std::fmt::Display) -> ConfigError {
    ConfigError::Parse {
        message: error.to_string(),
    }
}

fn missing_error(message: impl Into<String>) -> ConfigError {
    ConfigError::Missing {
        message: message.into(),
    }
}

fn invalid_error(message: impl Into<String>) -> ConfigError {
    ConfigError::Invalid {
        message: message.into(),
    }
}

fn terminal_error(message: impl std::fmt::Display) -> ConfigError {
    ConfigError::Terminal {
        message: message.to_string(),
    }
}

fn root_dir(app: &AppHandle<impl Runtime>) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(io_error)?
        .join(ROOT_DIR_NAME);
    Ok(dir)
}

fn root_paths(app: &AppHandle<impl Runtime>) -> Result<ConfigRootInfo> {
    let root = root_dir(app)?;
    let state = load_state(&root.join(STATE_FILE))?;
    let active_profile = if state.active_profile.is_empty() {
        DEFAULT_PROFILE_NAME.to_string()
    } else {
        state.active_profile
    };
    let host_dirs = load_application_host_dirs(&root, &active_profile)?;
    Ok(ConfigRootInfo {
        main_config_path: root.join(MAIN_CONFIG_FILE).to_string_lossy().into_owned(),
        profile_config_path: root
            .join(PROFILES_DIR)
            .join(format!("{active_profile}.toml"))
            .to_string_lossy()
            .into_owned(),
        state_path: root.join(STATE_FILE).to_string_lossy().into_owned(),
        root_dir: root.to_string_lossy().into_owned(),
        active_profile,
        host_dirs: host_dirs
            .into_iter()
            .map(|dir| dir.to_string_lossy().into_owned())
            .collect(),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppStateFile {
    active_profile: String,
}

impl Default for AppStateFile {
    fn default() -> Self {
        Self {
            active_profile: DEFAULT_PROFILE_NAME.to_string(),
        }
    }
}

fn load_state(path: &Path) -> Result<AppStateFile> {
    if !path.exists() {
        return Ok(AppStateFile::default());
    }
    let text = fs::read_to_string(path).map_err(io_error)?;
    if text.trim().is_empty() {
        return Ok(AppStateFile::default());
    }
    toml::from_str(&text).map_err(parse_error)
}

fn save_state(path: &Path, state: &AppStateFile) -> Result<()> {
    ensure_parent(path)?;
    write_atomic(path, &toml::to_string_pretty(state).map_err(parse_error)?)
}

fn ensure_parent(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    Ok(())
}

fn write_atomic(path: &Path, content: &str) -> Result<()> {
    let tmp = path.with_extension("toml.tmp");
    {
        let mut file = fs::File::create(&tmp).map_err(io_error)?;
        file.write_all(content.as_bytes()).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
    }
    fs::rename(&tmp, path).map_err(io_error)?;
    Ok(())
}

fn resolve_root_relative(root: &Path, dir: &str) -> PathBuf {
    let path = PathBuf::from(dir);
    if path.is_absolute() {
        path
    } else {
        root.join(path)
    }
}

fn ensure_layout(app: &AppHandle<impl Runtime>) -> Result<ConfigRootInfo> {
    let root = root_dir(app)?;
    fs::create_dir_all(&root).map_err(io_error)?;
    let profiles_dir = root.join(PROFILES_DIR);
    let hosts_dir = root.join(DEFAULT_HOSTS_DIR);
    fs::create_dir_all(&profiles_dir).map_err(io_error)?;
    fs::create_dir_all(&hosts_dir).map_err(io_error)?;

    let state_path = root.join(STATE_FILE);
    if !state_path.exists() {
        save_state(&state_path, &AppStateFile::default())?;
    }

    let main_config = root.join(MAIN_CONFIG_FILE);
    if !main_config.exists() {
        write_atomic(&main_config, "")?;
    }

    let default_profile = profiles_dir.join(DEFAULT_PROFILE_FILE);
    if !default_profile.exists() {
        write_atomic(&default_profile, "")?;
    }

    root_paths(app)
}

fn read_text(path: &Path) -> Result<String> {
    if !path.exists() {
        return Err(missing_error(format!("file not found: {}", path.display())));
    }
    fs::read_to_string(path).map_err(io_error)
}

fn parse_toml(text: &str) -> Result<toml::Value> {
    if text.trim().is_empty() {
        Ok(toml::Value::Table(toml::map::Map::new()))
    } else {
        toml::from_str(text).map_err(parse_error)
    }
}

fn read_document_table(path: &Path) -> Result<ConfigTable> {
    let text = read_text(path)?;
    if text.trim().is_empty() {
        return Ok(ConfigTable::default());
    }
    let value = parse_toml(&text)?;
    match value {
        toml::Value::Table(table) => Ok(table_to_config_table(&table)),
        _ => Err(invalid_error(format!(
            "expected toml table in {}",
            path.display()
        ))),
    }
}

fn read_profile_document_from_path(path: &Path) -> Result<ProfileConfigDocument> {
    Ok(ProfileConfigDocument {
        root: read_document_table(path)?,
    })
}

fn value_to_config_value(value: &toml::Value) -> ConfigValue {
    match value {
        toml::Value::String(value) => ConfigValue::String(value.clone()),
        toml::Value::Integer(value) => ConfigValue::Integer(value.to_string()),
        toml::Value::Float(value) => ConfigValue::Float(*value),
        toml::Value::Boolean(value) => ConfigValue::Boolean(*value),
        toml::Value::Datetime(value) => ConfigValue::Datetime(value.to_string()),
        toml::Value::Array(values) => {
            ConfigValue::Array(values.iter().map(value_to_config_value).collect())
        }
        toml::Value::Table(table) => ConfigValue::Table(
            table
                .iter()
                .map(|(key, value)| (key.clone(), value_to_config_value(value)))
                .collect(),
        ),
    }
}

fn config_value_to_toml(value: &ConfigValue) -> Result<toml::Value> {
    Ok(match value {
        ConfigValue::String(value) => toml::Value::String(value.clone()),
        ConfigValue::Integer(value) => toml::Value::Integer(
            value
                .parse::<i64>()
                .map_err(|_| invalid_error(format!("integer must fit TOML i64 range: {value}")))?,
        ),
        ConfigValue::Float(value) => toml::Value::Float(*value),
        ConfigValue::Boolean(value) => toml::Value::Boolean(*value),
        ConfigValue::Datetime(value) => toml::Value::Datetime(value.parse().map_err(parse_error)?),
        ConfigValue::Array(values) => toml::Value::Array(
            values
                .iter()
                .map(config_value_to_toml)
                .collect::<Result<Vec<_>>>()?,
        ),
        ConfigValue::Table(table) => toml::Value::Table(
            table
                .iter()
                .map(|(key, value)| Ok((key.clone(), config_value_to_toml(value)?)))
                .collect::<Result<BTreeMap<_, _>>>()?
                .into_iter()
                .collect(),
        ),
    })
}

fn table_to_config_table(table: &toml::Table) -> ConfigTable {
    ConfigTable {
        values: table
            .iter()
            .map(|(key, value)| (key.clone(), value_to_config_value(value)))
            .collect(),
    }
}

fn config_table_to_toml(table: &ConfigTable) -> Result<toml::Value> {
    Ok(toml::Value::Table(
        table
            .values
            .iter()
            .map(|(key, value)| Ok((key.clone(), config_value_to_toml(value)?)))
            .collect::<Result<BTreeMap<_, _>>>()?
            .into_iter()
            .collect(),
    ))
}

fn string_array_from_toml(value: &toml::Value) -> Result<Vec<String>> {
    match value {
        toml::Value::Array(values) => values
            .iter()
            .map(|value| match value {
                toml::Value::String(value) => Ok(value.clone()),
                _ => Err(invalid_error("host_dirs must be an array of strings")),
            })
            .collect(),
        _ => Err(invalid_error("host_dirs must be an array of strings")),
    }
}

fn read_main_config_from_path(path: &Path) -> Result<MainConfigDocument> {
    Ok(MainConfigDocument {
        root: read_document_table(path)?,
    })
}

fn write_document(path: &Path, table: &ConfigTable) -> Result<()> {
    if table.values.is_empty() {
        return write_atomic(path, "");
    }
    let value = config_table_to_toml(table)?;
    let text = toml::to_string_pretty(&value).map_err(parse_error)?;
    write_atomic(path, &text)
}

fn normalize_toml(value: &toml::Value) -> toml::Value {
    match value {
        toml::Value::Table(table) => {
            let mut normalized = toml::map::Map::new();
            let mut entries: Vec<_> = table.iter().collect();
            entries.sort_by(|(a, _), (b, _)| a.cmp(b));
            for (key, value) in entries {
                normalized.insert(key.clone(), normalize_toml(value));
            }
            toml::Value::Table(normalized)
        }
        toml::Value::Array(values) => {
            toml::Value::Array(values.iter().map(normalize_toml).collect())
        }
        _ => value.clone(),
    }
}

fn hash_toml(text: &str) -> Result<String> {
    let value = parse_toml(text)?;
    hash_toml_value(&value)
}

fn hash_toml_value(value: &toml::Value) -> Result<String> {
    let normalized = normalize_toml(value);
    let serialized = if matches!(normalized, toml::Value::Table(ref table) if table.is_empty()) {
        String::new()
    } else {
        toml::to_string(&normalized).map_err(parse_error)?
    };
    Ok(Sha256::digest(serialized.as_bytes()).encode_hex::<String>())
}

fn deep_merge(base: &toml::Value, overlay: &toml::Value) -> toml::Value {
    match (base, overlay) {
        (toml::Value::Table(base_table), toml::Value::Table(overlay_table)) => {
            let mut merged = base_table.clone();
            for (key, value) in overlay_table {
                let next = merged
                    .get(key)
                    .map(|base_value| deep_merge(base_value, value))
                    .unwrap_or_else(|| value.clone());
                merged.insert(key.clone(), next);
            }
            toml::Value::Table(merged)
        }
        _ => overlay.clone(),
    }
}

fn profile_path(root: &Path, name: &str) -> PathBuf {
    root.join(PROFILES_DIR).join(format!("{name}.toml"))
}

fn load_application_host_dirs(root: &Path, active_profile: &str) -> Result<Vec<PathBuf>> {
    let main = read_main_config_from_path(&root.join(MAIN_CONFIG_FILE))?;
    let profile = read_profile_document_from_path(&profile_path(root, active_profile))?;
    let merged = deep_merge(
        &config_table_to_toml(&main.root)?,
        &config_table_to_toml(&profile.root)?,
    );
    let dirs = match merged {
        toml::Value::Table(ref table) => match table.get("host_dirs") {
            Some(value) => string_array_from_toml(value)?,
            None => Vec::new(),
        },
        _ => return Err(invalid_error("effective config must be a TOML table")),
    };
    let resolved = if dirs.is_empty() {
        vec![root.join(DEFAULT_HOSTS_DIR)]
    } else {
        dirs.into_iter()
            .map(|dir| resolve_root_relative(root, &dir))
            .collect()
    };
    Ok(resolved)
}

fn host_dirs(root: &Path, active_profile: &str) -> Result<Vec<PathBuf>> {
    load_application_host_dirs(root, active_profile)
}

fn host_path_from_id(root: &Path, active_profile: &str, id: &str) -> Result<PathBuf> {
    for dir in host_dirs(root, active_profile)? {
        if !dir.exists() {
            continue;
        }
        for entry in fs::read_dir(&dir).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("toml") {
                continue;
            }
            let content = read_text(&path)?;
            if hash_toml(&content)? == id {
                return Ok(path);
            }
        }
    }
    Err(missing_error(format!("host {id} not found")))
}

fn load_host_entries(root: &Path, state: &AppStateFile) -> Result<Vec<HostEntry>> {
    let mut hosts = Vec::new();
    for dir in host_dirs(root, &state.active_profile)? {
        if !dir.exists() {
            continue;
        }
        for entry in fs::read_dir(&dir).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("toml") {
                continue;
            }
            let toml = read_text(&path)?;
            let id = hash_toml(&toml)?;
            let document = if toml.trim().is_empty() {
                HostConfigDocument::default()
            } else {
                match parse_toml(&toml)? {
                    toml::Value::Table(table) => HostConfigDocument {
                        root: table_to_config_table(&table),
                    },
                    _ => return Err(invalid_error("host config must be a TOML table")),
                }
            };
            hosts.push(HostEntry {
                id,
                path: path.to_string_lossy().into_owned(),
                document,
            });
        }
    }
    hosts.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(hosts)
}

fn watch_config(app: AppHandle, paths: Vec<PathBuf>) -> Result<()> {
    let state = app_state();
    let mut guard = state.watcher.lock().unwrap();
    if let Some(mut watcher) = guard.watcher.take() {
        for path in &guard.watched {
            let _ = watcher.unwatch(path);
        }
    }
    let app_for_watch = app.clone();
    let mut watcher = RecommendedWatcher::new(
        move |_| {
            let _ = app_for_watch.emit(CONFIG_CHANGED_EVENT, ());
        },
        NotifyConfig::default(),
    )
    .map_err(io_error)?;
    for path in &paths {
        if path.exists() {
            watcher
                .watch(path, RecursiveMode::Recursive)
                .map_err(io_error)?;
        }
    }
    guard.watched = paths;
    guard.watcher = Some(watcher);
    Ok(())
}

fn list_profiles_impl(root: &Path) -> Result<Vec<ProfileEntry>> {
    let dir = root.join(PROFILES_DIR);
    fs::create_dir_all(&dir).map_err(io_error)?;
    let mut items = Vec::new();
    for entry in fs::read_dir(&dir).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("toml") {
            continue;
        }
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or_else(|| invalid_error("invalid profile file name"))?
            .to_string();
        items.push(ProfileEntry {
            name,
            path: path.to_string_lossy().into_owned(),
        });
    }
    items.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(items)
}

fn emit_change(app: &AppHandle) {
    let _ = app.emit(CONFIG_CHANGED_EVENT, ());
}

fn default_terminal_theme() -> TerminalTheme {
    TerminalTheme {
        background: "#101113".to_string(),
        foreground: "#eef1f6".to_string(),
        cursor: "#eef1f6".to_string(),
        selection_background: "#36506f".to_string(),
        black: "#1f2329".to_string(),
        red: "#e06c75".to_string(),
        green: "#98c379".to_string(),
        yellow: "#e5c07b".to_string(),
        blue: "#61afef".to_string(),
        magenta: "#c678dd".to_string(),
        cyan: "#56b6c2".to_string(),
        white: "#d7dae0".to_string(),
        bright_black: "#5c6370".to_string(),
        bright_red: "#f28b91".to_string(),
        bright_green: "#b4d99c".to_string(),
        bright_yellow: "#f0d49a".to_string(),
        bright_blue: "#82c4ff".to_string(),
        bright_magenta: "#d99af0".to_string(),
        bright_cyan: "#7fd3df".to_string(),
        bright_white: "#ffffff".to_string(),
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
            renderer: TerminalRenderer::Canvas,
            cursor_blink: true,
            cursor_style: TerminalCursorStyle::Block,
            theme: default_terminal_theme(),
            tab_bar_orientation: TabBarOrientation::Horizontal,
        }
    }
}

fn effective_application_config(app: &AppHandle) -> Result<toml::Value> {
    let root = ensure_layout(app)?;
    let root_path = PathBuf::from(&root.root_dir);
    let main_config = read_main_config_from_path(Path::new(&root.main_config_path))?;
    let profile_config =
        read_profile_document_from_path(&profile_path(&root_path, &root.active_profile))?;
    let main_value = config_table_to_toml(&main_config.root)?;
    let profile_value = config_table_to_toml(&profile_config.root)?;
    Ok(deep_merge(&main_value, &profile_value))
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

fn parse_renderer(value: &str) -> Result<TerminalRenderer> {
    match value {
        "canvas" => Ok(TerminalRenderer::Canvas),
        "webgl" => Ok(TerminalRenderer::Webgl),
        _ => Err(invalid_error("terminal.renderer must be canvas or webgl")),
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
        "vertical" => Ok(TabBarOrientation::Vertical),
        _ => Err(invalid_error(
            "terminal.tab_bar_orientation must be horizontal or vertical",
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

fn is_css_color_like(value: &str) -> bool {
    let hex = value.strip_prefix('#');
    matches!(hex.map(str::len), Some(3 | 6 | 8))
        && hex
            .map(|text| text.chars().all(|item| item.is_ascii_hexdigit()))
            .unwrap_or(false)
}

fn terminal_settings_from_config(config: &toml::Value) -> Result<TerminalSettings> {
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
    apply_theme_config(&mut settings.theme, table)?;
    Ok(settings)
}

fn terminal_env_from_config(config: &toml::Value) -> Result<BTreeMap<String, String>> {
    let Some(table) = terminal_table(config)? else {
        return Ok(BTreeMap::new());
    };
    optional_string_map(table, "env").map(Option::unwrap_or_default)
}

fn validated_pty_size(cols: u16, rows: u16) -> Result<PtySize> {
    if !(2..=500).contains(&cols) {
        return Err(invalid_error("terminal cols must be between 2 and 500"));
    }
    if !(1..=300).contains(&rows) {
        return Err(invalid_error("terminal rows must be between 1 and 300"));
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

fn build_terminal_command(
    settings: &TerminalSettings,
    env_overrides: &BTreeMap<String, String>,
) -> CommandBuilder {
    let mut command = if let Some(program) = &settings.command {
        let mut command = CommandBuilder::new(program);
        command.args(settings.args.iter());
        command
    } else {
        CommandBuilder::new_default_prog()
    };
    if let Some(cwd) = &settings.cwd {
        command.cwd(cwd);
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
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
    let state = app_state();
    if let Ok(mut sessions) = state.terminal.sessions.lock() {
        sessions.remove(id);
    };
}

fn session_by_id(id: &str) -> Result<Arc<TerminalSession>> {
    let state = app_state();
    let sessions = state.terminal.sessions.lock().unwrap();
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
fn get_config_root(app: AppHandle) -> Result<ConfigRootInfo> {
    ensure_layout(&app)
}

#[tauri::command]
#[specta::specta]
fn get_config_snapshot(app: AppHandle) -> Result<AppConfigSnapshot> {
    let root = ensure_layout(&app)?;
    let root_path = PathBuf::from(&root.root_dir);
    let state = load_state(Path::new(&root.state_path))?;
    let main_config = read_main_config_from_path(Path::new(&root.main_config_path))?;
    let profile_path = profile_path(&root_path, &root.active_profile);
    let profile_config = read_profile_document_from_path(&profile_path)?;
    let main_value = config_table_to_toml(&main_config.root)?;
    let profile_value = config_table_to_toml(&profile_config.root)?;
    let effective = deep_merge(&main_value, &profile_value);
    let effective_config = match effective {
        toml::Value::Table(ref table) => EffectiveConfigDocument {
            root: table_to_config_table(table),
        },
        _ => return Err(invalid_error("effective config must be a TOML table")),
    };
    Ok(AppConfigSnapshot {
        root,
        main_config,
        profile_config,
        effective_config,
        profiles: list_profiles_impl(&root_path)?,
        hosts: load_host_entries(&root_path, &state)?,
    })
}

#[tauri::command]
#[specta::specta]
fn get_terminal_settings(app: AppHandle) -> Result<TerminalSettings> {
    terminal_settings_from_config(&effective_application_config(&app)?)
}

#[tauri::command]
#[specta::specta]
fn create_terminal_session(
    app: AppHandle,
    input: CreateTerminalSessionInput,
) -> Result<TerminalSessionInfo> {
    let size = validated_pty_size(input.cols, input.rows)?;
    let config = effective_application_config(&app)?;
    let settings = terminal_settings_from_config(&config)?;
    let env_overrides = terminal_env_from_config(&config)?;
    let command_label = terminal_command_label(&settings);
    let command = build_terminal_command(&settings, &env_overrides);
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(size).map_err(terminal_error)?;
    let reader = pair.master.try_clone_reader().map_err(terminal_error)?;
    let writer = pair.master.take_writer().map_err(terminal_error)?;
    let child = pair.slave.spawn_command(command).map_err(terminal_error)?;
    let process_id = child.process_id();
    let killer = child.clone_killer();
    let state = app_state();
    let session_number = state.terminal.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let id = format!("term-{session_number}");
    let session = Arc::new(TerminalSession {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        killer: Mutex::new(killer),
    });
    {
        let mut sessions = state.terminal.sessions.lock().unwrap();
        sessions.insert(id.clone(), session);
    }

    spawn_terminal_reader(app.clone(), id.clone(), reader);
    spawn_terminal_waiter(app, id.clone(), child);

    Ok(TerminalSessionInfo {
        id,
        title: format!("Session {session_number}"),
        command: command_label,
        cols: input.cols,
        rows: input.rows,
        process_id,
    })
}

#[tauri::command]
#[specta::specta]
fn write_terminal(input: TerminalInput) -> Result<()> {
    let session = session_by_id(&input.session_id)?;
    let mut writer = session.writer.lock().unwrap();
    writer
        .write_all(input.data.as_bytes())
        .map_err(terminal_error)?;
    writer.flush().map_err(terminal_error)
}

#[tauri::command]
#[specta::specta]
fn resize_terminal(input: TerminalSizeInput) -> Result<()> {
    let size = validated_pty_size(input.cols, input.rows)?;
    let session = session_by_id(&input.session_id)?;
    let master = session.master.lock().unwrap();
    master.resize(size).map_err(terminal_error)
}

#[tauri::command]
#[specta::specta]
fn close_terminal_session(session_id: String) -> Result<()> {
    let session = session_by_id(&session_id)?;
    {
        let mut killer = session.killer.lock().unwrap();
        killer.kill().map_err(terminal_error)?;
    }
    remove_terminal_session(&session_id);
    Ok(())
}

#[tauri::command]
#[specta::specta]
fn list_profiles(app: AppHandle) -> Result<Vec<ProfileEntry>> {
    let root = ensure_layout(&app)?;
    list_profiles_impl(Path::new(&root.root_dir))
}

#[tauri::command]
#[specta::specta]
fn read_profile(app: AppHandle, name: String) -> Result<ProfileConfigDocument> {
    let root = ensure_layout(&app)?;
    let path = profile_path(Path::new(&root.root_dir), &name);
    read_profile_document_from_path(&path)
}

#[tauri::command]
#[specta::specta]
fn create_profile(app: AppHandle, input: ProfileDocumentInput) -> Result<ProfileEntry> {
    let root = ensure_layout(&app)?;
    let path = profile_path(Path::new(&root.root_dir), &input.name);
    write_document(&path, &input.document.root)?;
    emit_change(&app);
    Ok(ProfileEntry {
        name: input.name,
        path: path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
#[specta::specta]
fn update_profile(app: AppHandle, input: ProfileDocumentInput) -> Result<ProfileEntry> {
    let root = ensure_layout(&app)?;
    let path = profile_path(Path::new(&root.root_dir), &input.name);
    if !path.exists() {
        return Err(missing_error(format!("profile {} not found", input.name)));
    }
    write_document(&path, &input.document.root)?;
    emit_change(&app);
    Ok(ProfileEntry {
        name: input.name,
        path: path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
#[specta::specta]
fn delete_profile(app: AppHandle, name: String) -> Result<()> {
    let root = ensure_layout(&app)?;
    let path = profile_path(Path::new(&root.root_dir), &name);
    if !path.exists() {
        return Err(missing_error(format!("profile {name} not found")));
    }
    fs::remove_file(&path).map_err(io_error)?;
    emit_change(&app);
    Ok(())
}

#[tauri::command]
#[specta::specta]
fn set_active_profile(app: AppHandle, name: String) -> Result<ConfigRootInfo> {
    let root = ensure_layout(&app)?;
    let root_path = PathBuf::from(&root.root_dir);
    let path = profile_path(&root_path, &name);
    if !path.exists() {
        return Err(missing_error(format!("profile {name} not found")));
    }
    let state_path = Path::new(&root.state_path);
    let next = AppStateFile {
        active_profile: name.clone(),
    };
    save_state(state_path, &next)?;
    emit_change(&app);
    root_paths(&app)
}

#[tauri::command]
#[specta::specta]
fn read_main_config(app: AppHandle) -> Result<MainConfigDocument> {
    let root = ensure_layout(&app)?;
    let text = read_text(Path::new(&root.main_config_path))?;
    if text.trim().is_empty() {
        return Ok(MainConfigDocument::default());
    }
    let value = parse_toml(&text)?;
    match value {
        toml::Value::Table(table) => Ok(MainConfigDocument {
            root: table_to_config_table(&table),
        }),
        _ => Err(invalid_error("main config must be a TOML table")),
    }
}

#[tauri::command]
#[specta::specta]
fn update_main_config(app: AppHandle, document: MainConfigDocument) -> Result<MainConfigDocument> {
    let root = ensure_layout(&app)?;
    let path = Path::new(&root.main_config_path);
    write_document(path, &document.root)?;
    emit_change(&app);
    Ok(document)
}

#[tauri::command]
#[specta::specta]
fn read_host(app: AppHandle, id: String) -> Result<HostEntry> {
    let root = ensure_layout(&app)?;
    let state = load_state(Path::new(&root.state_path))?;
    let path = host_path_from_id(Path::new(&root.root_dir), &state.active_profile, &id)?;
    let toml = read_text(&path)?;
    let document = if toml.trim().is_empty() {
        HostConfigDocument::default()
    } else {
        match parse_toml(&toml)? {
            toml::Value::Table(table) => HostConfigDocument {
                root: table_to_config_table(&table),
            },
            _ => return Err(invalid_error("host config must be a TOML table")),
        }
    };
    Ok(HostEntry {
        id,
        path: path.to_string_lossy().into_owned(),
        document,
    })
}

#[tauri::command]
#[specta::specta]
fn list_hosts(app: AppHandle) -> Result<Vec<HostEntry>> {
    let root = ensure_layout(&app)?;
    let state = load_state(Path::new(&root.state_path))?;
    load_host_entries(Path::new(&root.root_dir), &state)
}

#[tauri::command]
#[specta::specta]
fn create_host(app: AppHandle, document: HostConfigDocument) -> Result<HostEntry> {
    let root = ensure_layout(&app)?;
    let state = load_state(Path::new(&root.state_path))?;
    let value = config_table_to_toml(&document.root)?;
    let id = hash_toml_value(&value)?;
    let dir = host_dirs(Path::new(&root.root_dir), &state.active_profile)?
        .into_iter()
        .next()
        .ok_or_else(|| missing_error("host directory is not configured"))?;
    fs::create_dir_all(&dir).map_err(io_error)?;
    let path = dir.join(format!("{id}.toml"));
    write_document(&path, &document.root)?;
    emit_change(&app);
    Ok(HostEntry {
        id,
        path: path.to_string_lossy().into_owned(),
        document,
    })
}

#[tauri::command]
#[specta::specta]
fn update_host(app: AppHandle, input: HostDocumentInput) -> Result<HostEntry> {
    let root = ensure_layout(&app)?;
    let state = load_state(Path::new(&root.state_path))?;
    let old_path = if let Some(id) = input.id.clone() {
        host_path_from_id(Path::new(&root.root_dir), &state.active_profile, &id)?
    } else {
        return Err(invalid_error("host id is required for update"));
    };
    let value = config_table_to_toml(&input.document.root)?;
    let new_id = hash_toml_value(&value)?;
    let new_path = old_path
        .parent()
        .ok_or_else(|| invalid_error("invalid host path"))?
        .join(format!("{new_id}.toml"));
    if old_path != new_path {
        if new_path.exists() {
            fs::remove_file(&old_path).map_err(io_error)?;
        } else {
            fs::rename(&old_path, &new_path).map_err(io_error)?;
        }
    }
    write_document(&new_path, &input.document.root)?;
    emit_change(&app);
    Ok(HostEntry {
        id: new_id,
        path: new_path.to_string_lossy().into_owned(),
        document: input.document,
    })
}

#[tauri::command]
#[specta::specta]
fn delete_host(app: AppHandle, id: String) -> Result<()> {
    let root = ensure_layout(&app)?;
    let state = load_state(Path::new(&root.state_path))?;
    let path = host_path_from_id(Path::new(&root.root_dir), &state.active_profile, &id)?;
    fs::remove_file(path).map_err(io_error)?;
    emit_change(&app);
    Ok(())
}

#[tauri::command]
#[specta::specta]
fn set_host_dirs_command(app: AppHandle, input: HostDirsInput) -> Result<ConfigRootInfo> {
    let root = ensure_layout(&app)?;
    let path = Path::new(&root.main_config_path);
    let mut document = read_main_config_from_path(path)?;
    document.root.values.insert(
        "host_dirs".to_string(),
        ConfigValue::Array(input.dirs.into_iter().map(ConfigValue::String).collect()),
    );
    write_document(path, &document.root)?;
    emit_change(&app);
    root_paths(&app)
}

#[tauri::command]
#[specta::specta]
fn watch_config_command(app: AppHandle) -> Result<()> {
    let root = ensure_layout(&app)?;
    let state = load_state(Path::new(&root.state_path))?;
    let mut paths = vec![
        PathBuf::from(&root.main_config_path),
        PathBuf::from(&root.state_path),
        Path::new(&root.root_dir).join(PROFILES_DIR),
    ];
    paths.extend(host_dirs(Path::new(&root.root_dir), &state.active_profile)?);
    watch_config(app, paths)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = Builder::<tauri::Wry>::new().commands(collect_commands![
        get_config_root,
        get_config_snapshot,
        get_terminal_settings,
        create_terminal_session,
        write_terminal,
        resize_terminal,
        close_terminal_session,
        list_profiles,
        read_profile,
        create_profile,
        update_profile,
        delete_profile,
        set_active_profile,
        read_main_config,
        update_main_config,
        read_host,
        list_hosts,
        create_host,
        update_host,
        delete_host,
        set_host_dirs_command,
        watch_config_command
    ]);

    #[cfg(debug_assertions)]
    builder
        .export(Typescript::default(), "../src/lib/bindings.ts")
        .expect("failed to export Tauri command bindings");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(builder.invoke_handler())
        .setup(|app| {
            let _ = ensure_layout(app.handle())?;
            watch_config_command(app.handle().clone())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_toml_integer_to_decimal_string_for_ipc_contract() {
        let value = parse_toml("large = 9007199254740993\n").expect("valid TOML");
        let table = match value {
            toml::Value::Table(table) => table_to_config_table(&table),
            _ => panic!("expected table"),
        };

        match table.values.get("large") {
            Some(ConfigValue::Integer(value)) => assert_eq!(value, "9007199254740993"),
            value => panic!("expected integer config value, got {value:?}"),
        }

        let toml = config_table_to_toml(&table).expect("valid config table");
        assert_eq!(
            toml.get("large").and_then(toml::Value::as_integer),
            Some(9007199254740993)
        );
    }

    #[test]
    fn rejects_integer_strings_outside_toml_range() {
        let value = ConfigValue::Integer("9223372036854775808".to_string());
        let error = config_value_to_toml(&value).expect_err("integer should not serialize");

        assert!(matches!(error, ConfigError::Invalid { .. }));
    }
}
