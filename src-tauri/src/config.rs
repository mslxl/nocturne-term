use std::{
    collections::{BTreeMap, HashSet},
    env, fs,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Instant,
};

use keyring_core::Entry as KeyringEntry;
use notify::{Config as NotifyConfig, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;
use uuid::Uuid;

use crate::{
    error::{invalid_error, io_error, missing_error, parse_error, Result},
    ssh_trust::SshTrustStore,
    types::{
        AppConfigSnapshot, ConfigDocumentTarget, ConfigKeyPathInput, ConfigRootInfo, ConfigTable,
        ConfigValue, ConnectionDiagnosticSeverity, ConnectionHostDiagnostic,
        ConnectionHostDocument, ConnectionHostDocumentInput, ConnectionHostEntry,
        ConnectionHostIcon, ConnectionHostSource, EffectiveConfigDocument, HostDirsInput,
        LocalConnectionConfig, MainConfigDocument, PortForwardRule, ProfileConfigDocument,
        ProfileDocumentInput, ProfileEntry, SshConnectionConfig, TabBarOrientation,
        TerminalAgentMode,
    },
};

const CONFIG_CHANGED_EVENT: &str = "config://changed";
const CONFIG_ROOT_ENV: &str = "NOCTURNE_CONFIG_ROOT";
const ROOT_DIR_NAME: &str = "nocturne";
const MAIN_CONFIG_FILE: &str = "config.toml";
const STATE_FILE: &str = "state.toml";
pub(crate) const PROFILES_DIR: &str = "profiles";
const TERMINAL_COLOR_SCHEMES_DIR: &str = "terminal-color-schemes";
const DEFAULT_PROFILE_FILE: &str = "default.toml";
const DEFAULT_HOSTS_DIR: &str = "hosts";
const DEFAULT_PROFILE_NAME: &str = "default";
const KNOWN_HOSTS_FILE: &str = "known-hosts.toml";
const OPENSSH_INCLUDE_LIMIT: usize = 16;
const CUSTOM_HOST_ICON_MAX_BYTES: usize = 256 * 1024;
pub(crate) const DEFAULT_LOCAL_HOST_ID: &str = "00000000-0000-0000-0000-000000000001";

#[derive(Default)]
struct WatchState {
    watcher: Option<RecommendedWatcher>,
    watched: Vec<PathBuf>,
}

static WATCH_STATE: OnceLock<Arc<Mutex<WatchState>>> = OnceLock::new();

fn watch_state() -> Arc<Mutex<WatchState>> {
    WATCH_STATE
        .get_or_init(|| Arc::new(Mutex::new(WatchState::default())))
        .clone()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppStateFile {
    active_profile: String,
    #[serde(default)]
    default_local_host_removed: bool,
}

impl Default for AppStateFile {
    fn default() -> Self {
        Self {
            active_profile: DEFAULT_PROFILE_NAME.to_string(),
            default_local_host_removed: false,
        }
    }
}

fn root_dir(app: &AppHandle<impl Runtime>) -> Result<PathBuf> {
    if let Some(root) = config_root_override_from_env_value(env::var(CONFIG_ROOT_ENV).ok())? {
        return Ok(root);
    }
    let dir = app
        .path()
        .app_config_dir()
        .map_err(io_error)?
        .join(ROOT_DIR_NAME);
    Ok(dir)
}

fn config_root_override_from_env_value(value: Option<String>) -> Result<Option<PathBuf>> {
    let Some(root) = value else {
        return Ok(None);
    };
    let trimmed = root.trim();
    if trimmed.is_empty() {
        return Err(invalid_error(format!(
            "{CONFIG_ROOT_ENV} cannot be empty when set"
        )));
    }
    Ok(Some(PathBuf::from(trimmed)))
}

pub(crate) fn root_paths(app: &AppHandle<impl Runtime>) -> Result<ConfigRootInfo> {
    let root = root_dir(app)?;
    let state = load_state(&root.join(STATE_FILE))?;
    let active_profile = if state.active_profile.is_empty() {
        DEFAULT_PROFILE_NAME.to_string()
    } else {
        state.active_profile
    };
    let config = load_application_connection_config(&root, &active_profile)?;
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
        host_dirs: config
            .host_dirs
            .into_iter()
            .map(|dir| dir.to_string_lossy().into_owned())
            .collect(),
        openssh_config_files: config
            .openssh_config_files
            .into_iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
        default_host: config.default_host,
    })
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

pub(crate) fn ensure_layout(app: &AppHandle<impl Runtime>) -> Result<ConfigRootInfo> {
    let started = Instant::now();
    let root = root_dir(app)?;
    log::debug!("ensuring config layout at {}", root.display());
    fs::create_dir_all(&root).map_err(io_error)?;
    let terminal_color_schemes_dir = root.join(TERMINAL_COLOR_SCHEMES_DIR);
    let state_path = root.join(STATE_FILE);
    if !state_path.exists() {
        save_state(&state_path, &AppStateFile::default())?;
    }

    let state = load_state(&state_path)?;
    let active_profile = if state.active_profile.is_empty() {
        DEFAULT_PROFILE_NAME.to_string()
    } else {
        state.active_profile.clone()
    };
    let profiles_dir = root.join(PROFILES_DIR);
    fs::create_dir_all(&profiles_dir).map_err(io_error)?;
    fs::create_dir_all(&terminal_color_schemes_dir).map_err(io_error)?;

    let main_config = root.join(MAIN_CONFIG_FILE);
    if !main_config.exists() {
        write_atomic(&main_config, "")?;
    }

    let default_profile = profiles_dir.join(DEFAULT_PROFILE_FILE);
    if !default_profile.exists() {
        write_atomic(&default_profile, "")?;
    }
    for host_dir in host_dirs(&root, &active_profile)? {
        log::debug!("ensuring configured host directory {}", host_dir.display());
        fs::create_dir_all(&host_dir).map_err(io_error)?;
    }
    let root_info = root_paths(app)?;
    log::debug!(
        "ensured config layout in {} ms",
        started.elapsed().as_millis()
    );
    Ok(root_info)
}

pub(crate) fn notify_connection_diagnostics(app: &AppHandle<impl Runtime>) -> Result<()> {
    let started = Instant::now();
    let root = root_dir(app)?;
    log::debug!(
        "checking connection diagnostics for notification at {}",
        root.display()
    );
    let state = load_state(&root.join(STATE_FILE))?;
    let hosts = load_connection_host_entries(&root, &state)?;
    let error_count = hosts
        .iter()
        .flat_map(|host| host.diagnostics.iter())
        .filter(|diagnostic| diagnostic.severity == ConnectionDiagnosticSeverity::Error)
        .count();
    if error_count == 0 {
        log::debug!(
            "connection diagnostics notification check completed with no errors in {} ms",
            started.elapsed().as_millis()
        );
        return Ok(());
    }
    log::warn!(
        "connection diagnostics found {} error(s) in {} ms",
        error_count,
        started.elapsed().as_millis()
    );
    let _ = app
        .notification()
        .builder()
        .title("Nocturne host configuration needs attention")
        .body(format!(
            "{error_count} connection host issue(s) need repair."
        ))
        .show();
    Ok(())
}

fn read_text(path: &Path) -> Result<String> {
    if !path.exists() {
        return Err(missing_error(format!("file not found: {}", path.display())));
    }
    fs::read_to_string(path).map_err(io_error)
}

pub(crate) fn parse_toml(text: &str) -> Result<toml::Value> {
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

pub(crate) fn config_value_to_toml(value: &ConfigValue) -> Result<toml::Value> {
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

pub(crate) fn table_to_config_table(table: &toml::Table) -> ConfigTable {
    ConfigTable {
        values: table
            .iter()
            .map(|(key, value)| (key.clone(), value_to_config_value(value)))
            .collect(),
    }
}

pub(crate) fn config_table_to_toml(table: &ConfigTable) -> Result<toml::Value> {
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

fn string_array_from_toml(value: &toml::Value, name: &str) -> Result<Vec<String>> {
    match value {
        toml::Value::Array(values) => values
            .iter()
            .map(|value| match value {
                toml::Value::String(value) => Ok(value.clone()),
                _ => Err(invalid_error(format!("{name} must be an array of strings"))),
            })
            .collect(),
        _ => Err(invalid_error(format!("{name} must be an array of strings"))),
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

pub(crate) fn deep_merge(base: &toml::Value, overlay: &toml::Value) -> toml::Value {
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

fn normalize_profile_name(name: &str) -> Result<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(invalid_error("profile name cannot be empty"));
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed == "." || trimmed == ".." {
        return Err(invalid_error("profile name cannot contain path separators"));
    }
    Ok(trimmed.to_string())
}

fn remove_config_path(table: &mut ConfigTable, path: &[String]) -> Result<bool> {
    if path.is_empty() {
        return Err(invalid_error("config key path cannot be empty"));
    }
    remove_config_path_from_values(&mut table.values, path)
}

fn has_config_path(table: &ConfigTable, path: &[&str]) -> bool {
    if path.is_empty() {
        return false;
    }
    let mut values = &table.values;
    for (index, key) in path.iter().enumerate() {
        let Some(value) = values.get(*key) else {
            return false;
        };
        if index == path.len() - 1 {
            return true;
        }
        let ConfigValue::Table(child) = value else {
            return false;
        };
        values = child;
    }
    false
}

fn write_config_path(table: &mut ConfigTable, path: &[&str], value: ConfigValue) -> Result<()> {
    if path.is_empty() {
        return Err(invalid_error("config key path cannot be empty"));
    }
    let mut values = &mut table.values;
    for (index, key) in path.iter().take(path.len() - 1).enumerate() {
        let current = values
            .entry((*key).to_string())
            .or_insert_with(|| ConfigValue::Table(BTreeMap::new()));
        let ConfigValue::Table(child) = current else {
            return Err(invalid_error(format!(
                "config path {} is not a table",
                path[..=index].join(".")
            )));
        };
        values = child;
    }
    values.insert(path[path.len() - 1].to_string(), value);
    Ok(())
}

fn write_string_config_path(table: &mut ConfigTable, path: &[&str], value: String) -> Result<()> {
    write_config_path(table, path, ConfigValue::String(value))
}

fn tab_bar_orientation_value(orientation: TabBarOrientation) -> &'static str {
    match orientation {
        TabBarOrientation::Horizontal => "horizontal",
        TabBarOrientation::VerticalLeft => "vertical_left",
        TabBarOrientation::VerticalRight => "vertical_right",
    }
}

fn remove_config_path_from_values(
    values: &mut BTreeMap<String, ConfigValue>,
    path: &[String],
) -> Result<bool> {
    let key = path
        .first()
        .ok_or_else(|| invalid_error("config key path cannot be empty"))?;
    if path.len() == 1 {
        return Ok(values.remove(key).is_some());
    }
    let Some(value) = values.get_mut(key) else {
        return Ok(false);
    };
    let ConfigValue::Table(child) = value else {
        return Ok(false);
    };
    let removed = remove_config_path_from_values(child, &path[1..])?;
    if child.is_empty() {
        values.remove(key);
    }
    Ok(removed)
}

pub(crate) fn set_effective_tab_bar_orientation(
    app: &AppHandle<impl Runtime>,
    orientation: TabBarOrientation,
) -> Result<()> {
    let root = ensure_layout(app)?;
    let root_path = PathBuf::from(&root.root_dir);
    let setting_path = ["terminal", "tab_bar_orientation"];
    let value = ConfigValue::String(tab_bar_orientation_value(orientation).to_string());

    let profile_path = profile_path(&root_path, &root.active_profile);
    let mut profile = read_profile_document_from_path(&profile_path)?;
    if has_config_path(&profile.root, &setting_path) {
        write_config_path(&mut profile.root, &setting_path, value)?;
        write_document(&profile_path, &profile.root)?;
    } else {
        let path = Path::new(&root.main_config_path);
        let mut main = read_main_config_from_path(path)?;
        write_config_path(&mut main.root, &setting_path, value)?;
        write_document(path, &main.root)?;
    }

    emit_change(app);
    Ok(())
}

struct ApplicationConnectionConfig {
    host_dirs: Vec<PathBuf>,
    openssh_config_files: Vec<PathBuf>,
    default_host: String,
}

fn default_openssh_config_file() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".ssh").join("config"))
}

fn resolve_user_path(root: &Path, path: &str) -> PathBuf {
    if path == "~" {
        return dirs::home_dir().unwrap_or_else(|| root.join(path));
    }
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    resolve_root_relative(root, path)
}

fn load_application_connection_config(
    root: &Path,
    active_profile: &str,
) -> Result<ApplicationConnectionConfig> {
    let main = read_main_config_from_path(&root.join(MAIN_CONFIG_FILE))?;
    let profile = read_profile_document_from_path(&profile_path(root, active_profile))?;
    let merged = deep_merge(
        &config_table_to_toml(&main.root)?,
        &config_table_to_toml(&profile.root)?,
    );
    let (dirs, openssh_config_files, default_host) = match merged {
        toml::Value::Table(ref table) => {
            let dirs = match table.get("host_dirs") {
                Some(value) => string_array_from_toml(value, "host_dirs")?,
                None => Vec::new(),
            };
            let openssh_config_files = match table.get("openssh_config_files") {
                Some(value) => string_array_from_toml(value, "openssh_config_files")?,
                None => Vec::new(),
            };
            let default_host = match table.get("default_host") {
                Some(toml::Value::String(value)) if !value.trim().is_empty() => value.clone(),
                Some(toml::Value::String(_)) => DEFAULT_LOCAL_HOST_ID.to_string(),
                Some(_) => return Err(invalid_error("default_host must be a string")),
                None => DEFAULT_LOCAL_HOST_ID.to_string(),
            };
            (dirs, openssh_config_files, default_host)
        }
        _ => return Err(invalid_error("effective config must be a TOML table")),
    };
    let host_dirs = if dirs.is_empty() {
        vec![root.join(DEFAULT_HOSTS_DIR)]
    } else {
        dirs.into_iter()
            .map(|dir| resolve_user_path(root, &dir))
            .collect()
    };
    let openssh_config_files = if openssh_config_files.is_empty() {
        default_openssh_config_file().into_iter().collect()
    } else {
        openssh_config_files
            .into_iter()
            .map(|path| resolve_user_path(root, &path))
            .collect()
    };
    Ok(ApplicationConnectionConfig {
        host_dirs,
        openssh_config_files,
        default_host,
    })
}

fn load_application_host_dirs(root: &Path, active_profile: &str) -> Result<Vec<PathBuf>> {
    Ok(load_application_connection_config(root, active_profile)?.host_dirs)
}

fn host_dirs(root: &Path, active_profile: &str) -> Result<Vec<PathBuf>> {
    load_application_host_dirs(root, active_profile)
}

fn connection_host_path_from_id(root: &Path, active_profile: &str, id: &str) -> Result<PathBuf> {
    validate_uuid(id)?;
    let expected_file = format!("{id}.toml");
    for dir in host_dirs(root, active_profile)? {
        if !dir.exists() {
            continue;
        }
        for path in collect_host_toml_files(&dir)? {
            if path.file_name().and_then(|name| name.to_str()) == Some(expected_file.as_str()) {
                return Ok(path);
            }
            let document = read_connection_host_document_from_path(&path)?;
            if document.id == id {
                return Ok(path);
            }
        }
    }
    Err(missing_error(format!("connection host {id} not found")))
}

fn collect_host_toml_files(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    collect_host_toml_files_into(dir, &mut paths)?;
    paths.sort();
    Ok(paths)
}

fn collect_host_toml_files_into(dir: &Path, paths: &mut Vec<PathBuf>) -> Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(dir).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        let path = entry.path();
        if path.is_dir() {
            collect_host_toml_files_into(&path, paths)?;
        } else if path.extension().and_then(|s| s.to_str()) == Some("toml") {
            paths.push(path);
        }
    }
    Ok(())
}

fn connection_host_folder_from_path(base: &Path, path: &Path) -> Option<String> {
    let parent = path.parent()?;
    let relative = parent.strip_prefix(base).ok()?;
    folder_from_relative_path(relative)
}

fn connection_host_base_dir_for_path(
    root: &Path,
    active_profile: &str,
    path: &Path,
) -> Result<PathBuf> {
    for dir in host_dirs(root, active_profile)? {
        if path.strip_prefix(&dir).is_ok() {
            return Ok(dir);
        }
    }
    Err(invalid_error(format!(
        "connection host path is outside configured host directories: {}",
        path.display()
    )))
}

fn connection_host_file_path(base: &Path, folder: Option<PathBuf>, id: &str) -> PathBuf {
    let dir = folder.map_or_else(|| base.to_path_buf(), |folder| base.join(folder));
    dir.join(format!("{id}.toml"))
}

fn remove_empty_host_dirs(base: &Path, start: &Path) {
    let mut current = start.to_path_buf();
    while current != base {
        match fs::remove_dir(&current) {
            Ok(()) => {
                let Some(parent) = current.parent() else {
                    break;
                };
                current = parent.to_path_buf();
            }
            Err(_) => break,
        }
    }
}

fn folder_from_relative_path(path: &Path) -> Option<String> {
    let parts = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => part.to_str().map(ToOwned::to_owned),
            _ => None,
        })
        .collect::<Vec<_>>();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

fn validate_connection_host_folder(folder: Option<&str>) -> Result<Option<PathBuf>> {
    let Some(folder) = folder.map(str::trim).filter(|folder| !folder.is_empty()) else {
        return Ok(None);
    };
    let relative = Path::new(folder);
    if relative.is_absolute() {
        return Err(invalid_error("connection host folder must be relative"));
    }
    let mut path = PathBuf::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => {
                let Some(text) = part.to_str() else {
                    return Err(invalid_error("connection host folder must be UTF-8"));
                };
                if text.is_empty() {
                    return Err(invalid_error(
                        "connection host folder cannot contain empty segments",
                    ));
                }
                path.push(part);
            }
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(invalid_error("connection host folder cannot contain '..'"));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(invalid_error("connection host folder must be relative"));
            }
        }
    }
    if path.as_os_str().is_empty() {
        Ok(None)
    } else {
        Ok(Some(path))
    }
}

fn validate_uuid(id: &str) -> Result<()> {
    Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| invalid_error(format!("connection host id must be a UUID: {id}")))
}

fn next_connection_host_id() -> String {
    Uuid::new_v4().to_string()
}

fn read_connection_host_document_from_path(path: &Path) -> Result<ConnectionHostDocument> {
    let text = read_text(path)?;
    if text.trim().is_empty() {
        return Err(invalid_error(format!(
            "connection host file cannot be empty: {}",
            path.display()
        )));
    }
    toml::from_str(&text).map_err(parse_error)
}

fn write_connection_host_document(path: &Path, document: &ConnectionHostDocument) -> Result<()> {
    validate_connection_host_document(document)?;
    let mut disk_document = document.clone();
    disk_document.folder = None;
    let text = toml::to_string_pretty(&disk_document).map_err(parse_error)?;
    write_atomic(path, &text)
}

fn connection_host_entry_from_path(
    base: &Path,
    path: PathBuf,
    mut document: ConnectionHostDocument,
) -> ConnectionHostEntry {
    document.folder = connection_host_folder_from_path(base, &path);
    ConnectionHostEntry {
        id: document.id.clone(),
        path: Some(path.to_string_lossy().into_owned()),
        source: ConnectionHostSource::User,
        read_only: false,
        document,
        diagnostics: Vec::new(),
    }
}

fn default_local_host_document() -> ConnectionHostDocument {
    ConnectionHostDocument {
        version: 1,
        id: DEFAULT_LOCAL_HOST_ID.to_string(),
        name: "Local Shell".to_string(),
        folder: None,
        icon: Some(ConnectionHostIcon::Catalog {
            name: "lucide:terminal".to_string(),
        }),
        files: None,
        resources: None,
        port_forwards: Vec::new(),
        terminal: None,
        protocol: crate::types::ConnectionProtocol::Local,
        local: Some(LocalConnectionConfig::default()),
        ssh: None,
        telnet: None,
    }
}

pub(crate) fn effective_terminal_agent_mode(host: &ConnectionHostEntry) -> TerminalAgentMode {
    if matches!(host.source, ConnectionHostSource::Virtual)
        && matches!(
            host.document.protocol,
            crate::types::ConnectionProtocol::Local
        )
    {
        return TerminalAgentMode::Enabled;
    }
    if !matches!(host.source, ConnectionHostSource::User) || host.read_only {
        return TerminalAgentMode::Disabled;
    }
    host.document
        .terminal
        .as_ref()
        .and_then(|terminal| terminal.agent_mode)
        .unwrap_or(TerminalAgentMode::Enabled)
}

fn virtual_default_local_host() -> ConnectionHostEntry {
    let document = default_local_host_document();
    ConnectionHostEntry {
        id: document.id.clone(),
        path: None,
        source: ConnectionHostSource::Virtual,
        read_only: true,
        document,
        diagnostics: Vec::new(),
    }
}

fn validate_connection_host_document(document: &ConnectionHostDocument) -> Result<()> {
    if document.version != 1 {
        return Err(invalid_error(format!(
            "unsupported connection host version: {}",
            document.version
        )));
    }
    validate_uuid(&document.id)?;
    if document.name.trim().is_empty() {
        return Err(invalid_error("connection host name cannot be empty"));
    }
    if let Some(icon) = &document.icon {
        validate_connection_host_icon(icon)?;
    }
    validate_port_forward_rules(&document.port_forwards)?;
    match document.protocol {
        crate::types::ConnectionProtocol::Local => {
            let Some(local) = &document.local else {
                return Err(invalid_error(
                    "local connection host requires [local] config",
                ));
            };
            validate_local_config(local)
        }
        crate::types::ConnectionProtocol::Ssh => {
            let Some(ssh) = &document.ssh else {
                return Err(invalid_error("ssh connection host requires [ssh] config"));
            };
            validate_ssh_config(ssh)
        }
        crate::types::ConnectionProtocol::Telnet => {
            let Some(telnet) = &document.telnet else {
                return Err(invalid_error(
                    "telnet connection host requires [telnet] config",
                ));
            };
            if telnet.hostname.trim().is_empty() {
                return Err(invalid_error("telnet hostname cannot be empty"));
            }
            if telnet.port == 0 {
                return Err(invalid_error("telnet port must be greater than 0"));
            }
            Ok(())
        }
    }
}

fn validate_port_forward_rules(rules: &[PortForwardRule]) -> Result<()> {
    let mut ids = HashSet::new();
    let mut semantic_keys = HashSet::new();
    for rule in rules {
        validate_port_forward_rule(rule)?;
        if !ids.insert(rule.id.clone()) {
            return Err(invalid_error(format!(
                "duplicate port forward rule id {}",
                rule.id
            )));
        }
        let key = port_forward_semantic_key(rule);
        if !semantic_keys.insert(key) {
            return Err(invalid_error(format!(
                "duplicate port forward rule connection semantics for {}:{} and {}:{}",
                rule.local_address.trim(),
                rule.local_port,
                rule.remote_address.trim(),
                rule.remote_port
            )));
        }
    }
    Ok(())
}

fn validate_port_forward_rule(rule: &PortForwardRule) -> Result<()> {
    Uuid::parse_str(&rule.id)
        .map_err(|_| invalid_error(format!("port forward rule id must be a UUID: {}", rule.id)))?;
    validate_port_forward_address("local address", &rule.local_address)?;
    validate_port_forward_address("remote address", &rule.remote_address)?;
    for confirmation in &rule.non_loopback_confirmations {
        if confirmation.semantic_key != port_forward_semantic_key(rule) {
            return Err(invalid_error(format!(
                "port forward rule {} has stale non-loopback confirmation",
                rule.id
            )));
        }
        if confirmation.confirmed_at_unix_ms.trim().is_empty() {
            return Err(invalid_error(
                "port forward non-loopback confirmation timestamp cannot be empty",
            ));
        }
    }
    Ok(())
}

fn validate_port_forward_address(label: &str, address: &str) -> Result<()> {
    if address.trim().is_empty() {
        return Err(invalid_error(format!(
            "port forward {label} cannot be empty"
        )));
    }
    if address.trim() != address {
        return Err(invalid_error(format!(
            "port forward {label} cannot contain leading or trailing whitespace"
        )));
    }
    Ok(())
}

fn port_forward_semantic_key(rule: &PortForwardRule) -> crate::types::PortForwardSemanticKey {
    crate::types::PortForwardSemanticKey {
        direction: rule.direction,
        local_address: rule.local_address.trim().to_string(),
        local_port: rule.local_port,
        remote_address: rule.remote_address.trim().to_string(),
        remote_port: rule.remote_port,
    }
}

fn validate_connection_host_icon(icon: &ConnectionHostIcon) -> Result<()> {
    match icon {
        ConnectionHostIcon::Catalog { name } => {
            let trimmed = name.trim();
            if trimmed.is_empty() {
                return Err(invalid_error(
                    "connection host catalog icon name cannot be empty",
                ));
            }
            if !trimmed.contains(':') {
                return Err(invalid_error(
                    "connection host catalog icon name must include a collection prefix",
                ));
            }
            Ok(())
        }
        ConnectionHostIcon::Image { mime, data_base64 } => {
            let mime = mime.trim();
            if !matches!(mime, "image/png" | "image/jpeg" | "image/webp") {
                return Err(invalid_error(
                    "connection host image icon MIME must be image/png, image/jpeg, or image/webp",
                ));
            }
            if data_base64.trim().is_empty() {
                return Err(invalid_error(
                    "connection host image icon data cannot be empty",
                ));
            }
            let decoded =
                base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data_base64)
                    .map_err(|_| invalid_error("connection host image icon data must be base64"))?;
            if decoded.len() > CUSTOM_HOST_ICON_MAX_BYTES {
                return Err(invalid_error(format!(
                    "connection host image icon must be at most {} bytes",
                    CUSTOM_HOST_ICON_MAX_BYTES
                )));
            }
            Ok(())
        }
        ConnectionHostIcon::Svg { svg } => validate_connection_host_svg_icon(svg),
    }
}

fn validate_connection_host_svg_icon(svg: &str) -> Result<()> {
    let trimmed = svg.trim();
    if trimmed.is_empty() {
        return Err(invalid_error("connection host SVG icon cannot be empty"));
    }
    let lower = trimmed.to_ascii_lowercase();
    if !lower.contains("<svg") {
        return Err(invalid_error(
            "connection host SVG icon must contain an svg element",
        ));
    }
    if lower.contains("<script")
        || lower.contains("<foreignobject")
        || lower.contains("javascript:")
        || lower.contains("data:text/html")
        || lower.contains("http://")
        || lower.contains("https://")
    {
        return Err(invalid_error(
            "connection host SVG icon contains unsupported active or external content",
        ));
    }
    for attribute in [
        " onload=",
        " onclick=",
        " onerror=",
        " onmouseover=",
        " onfocus=",
        " onbegin=",
        " onend=",
    ] {
        if lower.contains(attribute) {
            return Err(invalid_error(
                "connection host SVG icon contains unsupported event attributes",
            ));
        }
    }
    Ok(())
}

fn validate_local_config(config: &LocalConnectionConfig) -> Result<()> {
    if matches!(config.command.as_deref(), Some(command) if command.trim().is_empty()) {
        return Err(invalid_error("local command cannot be empty"));
    }
    if config.command.is_none() && !config.args.is_empty() {
        return Err(invalid_error(
            "local args require local command because default system commands cannot accept configured args",
        ));
    }
    if matches!(config.cwd.as_deref(), Some(cwd) if cwd.trim().is_empty()) {
        return Err(invalid_error("local cwd cannot be empty"));
    }
    for key in config.env.keys() {
        if key.trim().is_empty() {
            return Err(invalid_error("local env keys cannot be empty"));
        }
    }
    Ok(())
}

fn validate_ssh_config(config: &SshConnectionConfig) -> Result<()> {
    if config.hostname.trim().is_empty() {
        return Err(invalid_error("ssh hostname cannot be empty"));
    }
    if config.port == 0 {
        return Err(invalid_error("ssh port must be greater than 0"));
    }
    Ok(())
}

fn host_filename_id(path: &Path) -> Option<String> {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .map(ToOwned::to_owned)
}

fn connection_diagnostic(
    severity: ConnectionDiagnosticSeverity,
    code: &str,
    message: impl Into<String>,
) -> ConnectionHostDiagnostic {
    ConnectionHostDiagnostic {
        severity,
        code: code.to_string(),
        message: message.into(),
    }
}

fn load_connection_host_entries(
    root: &Path,
    state: &AppStateFile,
) -> Result<Vec<ConnectionHostEntry>> {
    let started = Instant::now();
    log::debug!(
        "loading connection hosts from root={} active_profile={} default_local_host_removed={}",
        root.display(),
        state.active_profile,
        state.default_local_host_removed
    );
    let mut hosts = Vec::new();
    if !state.default_local_host_removed {
        hosts.push(virtual_default_local_host());
    }
    let dirs = host_dirs(root, &state.active_profile)?;
    log::debug!(
        "resolved {} connection host directory/directories: {}",
        dirs.len(),
        display_paths(&dirs)
    );
    let mut user_host_count = 0usize;
    for dir in dirs {
        let dir_started = Instant::now();
        log::debug!("scanning connection host directory {}", dir.display());
        if !dir.exists() {
            log::debug!(
                "skipped missing connection host directory {} in {} ms",
                dir.display(),
                dir_started.elapsed().as_millis()
            );
            continue;
        }
        let paths = collect_host_toml_files(&dir)?;
        log::debug!(
            "found {} TOML connection host file(s) in {} after {} ms",
            paths.len(),
            dir.display(),
            dir_started.elapsed().as_millis()
        );
        for path in paths {
            let mut diagnostics = Vec::new();
            let mut document = match read_connection_host_document_from_path(&path) {
                Ok(document) => document,
                Err(error) => {
                    log::warn!(
                        "failed to read connection host document {}: {}",
                        path.display(),
                        error
                    );
                    diagnostics.push(connection_diagnostic(
                        ConnectionDiagnosticSeverity::Error,
                        "malformed_toml",
                        error.to_string(),
                    ));
                    ConnectionHostDocument {
                        id: next_connection_host_id(),
                        name: path
                            .file_stem()
                            .and_then(|stem| stem.to_str())
                            .unwrap_or("Invalid Host")
                            .to_string(),
                        ..ConnectionHostDocument::default()
                    }
                }
            };
            document.folder = connection_host_folder_from_path(&dir, &path);
            if let Err(error) = validate_connection_host_document(&document) {
                diagnostics.push(connection_diagnostic(
                    ConnectionDiagnosticSeverity::Error,
                    "invalid_host",
                    error.to_string(),
                ));
            }
            if let Some(filename_id) = host_filename_id(&path) {
                if filename_id != document.id {
                    diagnostics.push(connection_diagnostic(
                        ConnectionDiagnosticSeverity::Warning,
                        "filename_id_mismatch",
                        format!(
                            "file name id {filename_id} does not match document id {}",
                            document.id
                        ),
                    ));
                }
            }
            user_host_count += 1;
            hosts.push(ConnectionHostEntry {
                id: document.id.clone(),
                path: Some(path.to_string_lossy().into_owned()),
                source: ConnectionHostSource::User,
                read_only: false,
                document,
                diagnostics,
            });
        }
        log::debug!(
            "finished connection host directory {} in {} ms",
            dir.display(),
            dir_started.elapsed().as_millis()
        );
    }
    let config_started = Instant::now();
    let config = load_application_connection_config(root, &state.active_profile)?;
    log::debug!(
        "resolved {} OpenSSH config file candidate(s) in {} ms: {}",
        config.openssh_config_files.len(),
        config_started.elapsed().as_millis(),
        display_paths(&config.openssh_config_files)
    );
    let openssh_hosts = load_openssh_connection_hosts(&config.openssh_config_files)?;
    let openssh_host_count = openssh_hosts.len();
    hosts.extend(openssh_hosts);
    mark_duplicate_connection_ids(&mut hosts);
    hosts.sort_by(|a, b| {
        a.document
            .name
            .cmp(&b.document.name)
            .then_with(|| a.id.cmp(&b.id))
    });
    log::info!(
        "loaded {} connection host(s) ({} user, {} OpenSSH/virtual) in {} ms",
        hosts.len(),
        user_host_count,
        hosts.len().saturating_sub(user_host_count),
        started.elapsed().as_millis()
    );
    log::debug!(
        "OpenSSH contributed {} host(s) before sorting and duplicate checks",
        openssh_host_count
    );
    Ok(hosts)
}

#[derive(Debug, Clone, Default)]
struct OpenSshHostBlock {
    patterns: Vec<String>,
    settings: BTreeMap<String, Vec<String>>,
    diagnostics: Vec<ConnectionHostDiagnostic>,
}

#[derive(Debug, Clone, Default)]
struct OpenSshMatchBlock {
    criteria: Vec<(String, String)>,
    unsupported: bool,
    settings: BTreeMap<String, Vec<String>>,
    diagnostics: Vec<ConnectionHostDiagnostic>,
}

fn load_openssh_connection_hosts(paths: &[PathBuf]) -> Result<Vec<ConnectionHostEntry>> {
    let started = Instant::now();
    let mut hosts = Vec::new();
    for path in paths {
        let file_started = Instant::now();
        log::debug!("checking OpenSSH config file {}", path.display());
        if !path.exists() {
            log::debug!(
                "skipped missing OpenSSH config file {} in {} ms",
                path.display(),
                file_started.elapsed().as_millis()
            );
            continue;
        }
        let parsed = parse_openssh_config(path)?;
        let parsed_hosts = parsed_to_openssh_hosts(parsed, path);
        log::debug!(
            "loaded {} OpenSSH host projection(s) from {} in {} ms",
            parsed_hosts.len(),
            path.display(),
            file_started.elapsed().as_millis()
        );
        hosts.extend(parsed_hosts);
    }
    log::debug!(
        "loaded {} total OpenSSH host projection(s) in {} ms",
        hosts.len(),
        started.elapsed().as_millis()
    );
    Ok(hosts)
}

#[derive(Debug, Clone, Default)]
struct ParsedOpenSshConfig {
    hosts: Vec<OpenSshHostBlock>,
    matches: Vec<OpenSshMatchBlock>,
    diagnostics: Vec<ConnectionHostDiagnostic>,
}

#[derive(Debug, Clone)]
struct OpenSshProxyJumpReference {
    alias: String,
    username: Option<String>,
    port: Option<u16>,
}

fn parse_openssh_config(path: &Path) -> Result<ParsedOpenSshConfig> {
    let mut parsed = ParsedOpenSshConfig::default();
    let mut visited = Vec::new();
    parse_openssh_config_file(path, 0, &mut visited, &mut parsed)?;
    Ok(parsed)
}

fn parse_openssh_config_file(
    path: &Path,
    depth: usize,
    visited: &mut Vec<PathBuf>,
    parsed: &mut ParsedOpenSshConfig,
) -> Result<()> {
    let started = Instant::now();
    log::debug!(
        "parsing OpenSSH config file depth={} path={}",
        depth,
        path.display()
    );
    if depth > OPENSSH_INCLUDE_LIMIT {
        parsed.diagnostics.push(connection_diagnostic(
            ConnectionDiagnosticSeverity::Warning,
            "include_depth",
            format!("OpenSSH Include depth exceeded at {}", path.display()),
        ));
        log::warn!(
            "OpenSSH Include depth exceeded at depth={} path={}",
            depth,
            path.display()
        );
        return Ok(());
    }
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if visited.iter().any(|item| item == &canonical) {
        parsed.diagnostics.push(connection_diagnostic(
            ConnectionDiagnosticSeverity::Warning,
            "include_cycle",
            format!("OpenSSH Include cycle at {}", path.display()),
        ));
        log::warn!("OpenSSH Include cycle at {}", path.display());
        return Ok(());
    }
    if !path.exists() {
        parsed.diagnostics.push(connection_diagnostic(
            ConnectionDiagnosticSeverity::Warning,
            "missing_include",
            format!("OpenSSH Include file not found: {}", path.display()),
        ));
        log::debug!(
            "OpenSSH config file missing at depth={} path={} after {} ms",
            depth,
            path.display(),
            started.elapsed().as_millis()
        );
        return Ok(());
    }
    visited.push(canonical);
    let content = read_text(path)?;
    let base_dir = path.parent().unwrap_or_else(|| Path::new("."));
    let mut current: Option<OpenSshSection> = None;
    for raw_line in content.lines() {
        let line = strip_openssh_comment(raw_line).trim();
        if line.is_empty() {
            continue;
        }
        let Some((key, rest)) = split_openssh_directive(line) else {
            continue;
        };
        let key_lower = key.to_ascii_lowercase();
        if key_lower == "include" {
            for include in split_openssh_words(rest) {
                for include_path in expand_openssh_include(base_dir, &include) {
                    log::debug!(
                        "OpenSSH Include from {} depth={} include={} resolved_path={}",
                        path.display(),
                        depth,
                        include,
                        include_path.display()
                    );
                    parse_openssh_config_file(&include_path, depth + 1, visited, parsed)?;
                }
            }
            continue;
        }
        if key_lower == "host" {
            flush_openssh_section(&mut current, parsed);
            current = Some(OpenSshSection::Host(OpenSshHostBlock {
                patterns: split_openssh_words(rest),
                ..OpenSshHostBlock::default()
            }));
            continue;
        }
        if key_lower == "match" {
            flush_openssh_section(&mut current, parsed);
            current = Some(OpenSshSection::Match(parse_openssh_match(rest)));
            continue;
        }
        match &mut current {
            Some(OpenSshSection::Host(block)) => {
                block
                    .settings
                    .entry(key_lower)
                    .or_default()
                    .push(rest.trim().to_string());
            }
            Some(OpenSshSection::Match(block)) => {
                block
                    .settings
                    .entry(key_lower)
                    .or_default()
                    .push(rest.trim().to_string());
            }
            None => {
                let mut block = OpenSshHostBlock {
                    patterns: vec!["*".to_string()],
                    ..OpenSshHostBlock::default()
                };
                block
                    .settings
                    .entry(key_lower)
                    .or_default()
                    .push(rest.trim().to_string());
                current = Some(OpenSshSection::Host(block));
            }
        }
    }
    flush_openssh_section(&mut current, parsed);
    visited.pop();
    log::debug!(
        "parsed OpenSSH config file depth={} path={} in {} ms",
        depth,
        path.display(),
        started.elapsed().as_millis()
    );
    Ok(())
}

enum OpenSshSection {
    Host(OpenSshHostBlock),
    Match(OpenSshMatchBlock),
}

fn flush_openssh_section(section: &mut Option<OpenSshSection>, parsed: &mut ParsedOpenSshConfig) {
    match section.take() {
        Some(OpenSshSection::Host(block)) => parsed.hosts.push(block),
        Some(OpenSshSection::Match(block)) => parsed.matches.push(block),
        None => {}
    }
}

fn strip_openssh_comment(line: &str) -> &str {
    let mut escaped = false;
    for (index, character) in line.char_indices() {
        if character == '\\' && !escaped {
            escaped = true;
            continue;
        }
        if character == '#' && !escaped {
            return &line[..index];
        }
        escaped = false;
    }
    line
}

fn split_openssh_directive(line: &str) -> Option<(&str, &str)> {
    let mut parts = line.splitn(2, char::is_whitespace);
    let key = parts.next()?.trim();
    let rest = parts.next().unwrap_or("").trim();
    (!key.is_empty()).then_some((key, rest))
}

fn split_openssh_words(value: &str) -> Vec<String> {
    value
        .split_whitespace()
        .map(|word| word.trim_matches('"').trim_matches('\'').to_string())
        .filter(|word| !word.is_empty())
        .collect()
}

fn expand_openssh_include(base_dir: &Path, include: &str) -> Vec<PathBuf> {
    let started = Instant::now();
    let expanded = expand_home(include);
    let path = PathBuf::from(expanded);
    let path = if path.is_absolute() {
        path
    } else {
        base_dir.join(path)
    };
    let pattern = path.to_string_lossy().into_owned();
    if pattern.contains('*') || pattern.contains('?') || pattern.contains('[') {
        log::debug!("expanding OpenSSH Include glob pattern={pattern}");
        match glob::glob(&pattern) {
            Ok(paths) => {
                let matches = paths
                    .filter_map(std::result::Result::ok)
                    .collect::<Vec<_>>();
                log::debug!(
                    "expanded OpenSSH Include glob pattern={} to {} path(s) in {} ms",
                    pattern,
                    matches.len(),
                    started.elapsed().as_millis()
                );
                matches
            }
            Err(error) => {
                log::warn!("failed to expand OpenSSH Include glob pattern={pattern}: {error}");
                vec![path]
            }
        }
    } else {
        log::debug!(
            "resolved OpenSSH Include path={} in {} ms",
            path.display(),
            started.elapsed().as_millis()
        );
        vec![path]
    }
}

fn display_paths(paths: &[PathBuf]) -> String {
    paths
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

fn expand_home(value: &str) -> String {
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

fn parse_openssh_match(rest: &str) -> OpenSshMatchBlock {
    let words = split_openssh_words(rest);
    if words.len() == 1 && words[0].eq_ignore_ascii_case("all") {
        return OpenSshMatchBlock {
            criteria: vec![("all".to_string(), String::new())],
            ..OpenSshMatchBlock::default()
        };
    }
    let mut criteria = Vec::new();
    let mut unsupported = false;
    let mut diagnostics = Vec::new();
    let mut index = 0;
    while index < words.len() {
        let keyword = words[index].to_ascii_lowercase();
        if keyword == "exec" {
            unsupported = true;
            diagnostics.push(connection_diagnostic(
                ConnectionDiagnosticSeverity::Warning,
                "unsupported_match_exec",
                "OpenSSH Match exec is not executed by Nocturne",
            ));
            index += 2;
            continue;
        }
        if matches!(
            keyword.as_str(),
            "host" | "originalhost" | "user" | "localuser"
        ) {
            if let Some(pattern) = words.get(index + 1) {
                criteria.push((keyword, pattern.clone()));
            }
            index += 2;
            continue;
        }
        unsupported = true;
        diagnostics.push(connection_diagnostic(
            ConnectionDiagnosticSeverity::Warning,
            "unsupported_match",
            format!("unsupported OpenSSH Match criterion: {keyword}"),
        ));
        index += 1;
    }
    OpenSshMatchBlock {
        criteria,
        unsupported,
        settings: BTreeMap::new(),
        diagnostics,
    }
}

fn openssh_entry_id(path: &Path, alias: &str) -> String {
    let source = path.to_string_lossy();
    let namespace = Uuid::new_v5(&Uuid::NAMESPACE_URL, source.as_bytes());
    Uuid::new_v5(&namespace, alias.as_bytes()).to_string()
}

fn openssh_folder_name(path: &Path) -> String {
    path.file_stem()
        .or_else(|| path.file_name())
        .and_then(|name| name.to_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("OpenSSH")
        .to_string()
}

fn parsed_to_openssh_hosts(parsed: ParsedOpenSshConfig, path: &Path) -> Vec<ConnectionHostEntry> {
    let mut entries = Vec::new();
    let folder = openssh_folder_name(path);
    for host in parsed.hosts.iter() {
        for pattern in concrete_openssh_patterns(&host.patterns) {
            let effective = effective_openssh_settings(&parsed, &pattern);
            let hostname = setting_first(&effective, "hostname").unwrap_or_else(|| pattern.clone());
            let port = setting_first(&effective, "port")
                .and_then(|value| value.parse::<u16>().ok())
                .unwrap_or(22);
            let username = setting_first(&effective, "user");
            let identity_file =
                setting_first(&effective, "identityfile").map(|value| expand_home(&value));
            let proxy_jump = setting_first(&effective, "proxyjump")
                .filter(|value| !value.eq_ignore_ascii_case("none"));
            let forward_agent = setting_first(&effective, "forwardagent")
                .map(|value| matches!(value.to_ascii_lowercase().as_str(), "yes" | "true"))
                .unwrap_or(false);
            let server_alive_interval = setting_first(&effective, "serveraliveinterval")
                .and_then(|value| value.parse().ok());
            let mut diagnostics = host.diagnostics.clone();
            diagnostics.extend(parsed.diagnostics.clone());
            for match_block in parsed.matches.iter().filter(|block| block.unsupported) {
                diagnostics.extend(match_block.diagnostics.clone());
            }
            let id = openssh_entry_id(path, &pattern);
            entries.push(ConnectionHostEntry {
                id: id.clone(),
                path: Some(path.to_string_lossy().into_owned()),
                source: ConnectionHostSource::OpenSshConfig,
                read_only: true,
                document: ConnectionHostDocument {
                    version: 1,
                    id,
                    name: pattern,
                    folder: Some(folder.clone()),
                    icon: Some(ConnectionHostIcon::Catalog {
                        name: "devicon:ssh".to_string(),
                    }),
                    files: None,
                    resources: None,
                    port_forwards: Vec::new(),
                    terminal: None,
                    protocol: crate::types::ConnectionProtocol::Ssh,
                    local: None,
                    ssh: Some(SshConnectionConfig {
                        hostname,
                        port,
                        username,
                        identity_file,
                        proxy_jump,
                        forward_agent,
                        server_alive_interval,
                    }),
                    telnet: None,
                },
                diagnostics,
            });
        }
    }
    entries
}

pub(crate) fn resolve_openssh_proxy_jump_chain(
    config_path: &Path,
    proxy_jump: &str,
) -> Result<Vec<SshConnectionConfig>> {
    let parsed = parse_openssh_config(config_path)?;
    resolve_openssh_proxy_jump_chain_from_parsed(&parsed, proxy_jump)
}

fn resolve_openssh_proxy_jump_chain_from_parsed(
    parsed: &ParsedOpenSshConfig,
    proxy_jump: &str,
) -> Result<Vec<SshConnectionConfig>> {
    let jumps = proxy_jump
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(parse_openssh_proxy_jump_reference)
        .collect::<Result<Vec<_>>>()?;
    if jumps.is_empty() {
        return Err(invalid_error("ProxyJump cannot be empty"));
    }
    if jumps
        .iter()
        .any(|jump| jump.alias.eq_ignore_ascii_case("none"))
    {
        return Err(invalid_error(
            "ProxyJump none cannot be combined with jump hosts",
        ));
    }
    jumps
        .into_iter()
        .map(|jump| openssh_proxy_jump_config(parsed, jump))
        .collect()
}

fn openssh_proxy_jump_config(
    parsed: &ParsedOpenSshConfig,
    jump: OpenSshProxyJumpReference,
) -> Result<SshConnectionConfig> {
    let effective = effective_openssh_settings(parsed, &jump.alias);
    let hostname = setting_first(&effective, "hostname").unwrap_or(jump.alias);
    let port = match jump.port {
        Some(port) => port,
        None => setting_first(&effective, "port")
            .map(|value| {
                value
                    .parse::<u16>()
                    .map_err(|_| invalid_error(format!("invalid OpenSSH Port: {value}")))
            })
            .transpose()?
            .unwrap_or(22),
    };
    let username = jump.username.or_else(|| setting_first(&effective, "user"));
    let identity_file = setting_first(&effective, "identityfile").map(|value| expand_home(&value));
    let forward_agent = setting_first(&effective, "forwardagent")
        .map(|value| matches!(value.to_ascii_lowercase().as_str(), "yes" | "true"))
        .unwrap_or(false);
    let server_alive_interval = setting_first(&effective, "serveraliveinterval")
        .map(|value| {
            value
                .parse::<u32>()
                .map_err(|_| invalid_error(format!("invalid ServerAliveInterval: {value}")))
        })
        .transpose()?;
    Ok(SshConnectionConfig {
        hostname,
        port,
        username,
        identity_file,
        proxy_jump: None,
        forward_agent,
        server_alive_interval,
    })
}

fn parse_openssh_proxy_jump_reference(value: &str) -> Result<OpenSshProxyJumpReference> {
    let (username, host_port) = match value.rsplit_once('@') {
        Some((user, host)) if !user.trim().is_empty() => (Some(user.to_string()), host),
        _ => (None, value),
    };
    let (alias, port) = parse_openssh_proxy_jump_host_port(host_port)?;
    if alias.trim().is_empty() {
        return Err(invalid_error("ProxyJump host cannot be empty"));
    }
    Ok(OpenSshProxyJumpReference {
        alias,
        username,
        port,
    })
}

fn parse_openssh_proxy_jump_host_port(value: &str) -> Result<(String, Option<u16>)> {
    if let Some(rest) = value.strip_prefix('[') {
        if let Some((host, port_text)) = rest.split_once("]:") {
            let port = port_text
                .parse::<u16>()
                .map_err(|_| invalid_error("invalid ProxyJump port"))?;
            return Ok((host.to_string(), Some(port)));
        }
        if let Some(host) = rest.strip_suffix(']').filter(|host| host.contains(':')) {
            return Ok((host.to_string(), None));
        }
        return Err(invalid_error("invalid bracketed ProxyJump host:port"));
    }
    if let Some((host, port_text)) = value.rsplit_once(':') {
        if !host.contains(':') {
            let port = port_text
                .parse::<u16>()
                .map_err(|_| invalid_error("invalid ProxyJump port"))?;
            return Ok((host.to_string(), Some(port)));
        }
    }
    Ok((value.to_string(), None))
}

fn concrete_openssh_patterns(patterns: &[String]) -> Vec<String> {
    patterns
        .iter()
        .filter(|pattern| {
            !pattern.starts_with('!')
                && !pattern.contains('*')
                && !pattern.contains('?')
                && !pattern.contains('[')
        })
        .cloned()
        .collect()
}

fn effective_openssh_settings(
    parsed: &ParsedOpenSshConfig,
    alias: &str,
) -> BTreeMap<String, Vec<String>> {
    let mut effective = BTreeMap::new();
    for host in &parsed.hosts {
        if host
            .patterns
            .iter()
            .any(|pattern| openssh_pattern_matches(pattern, alias))
        {
            merge_openssh_first_value_wins(&mut effective, &host.settings);
        }
    }
    for match_block in &parsed.matches {
        if openssh_match_block_matches(match_block, alias, &effective) {
            merge_openssh_first_value_wins(&mut effective, &match_block.settings);
        }
    }
    effective
}

fn merge_openssh_first_value_wins(
    effective: &mut BTreeMap<String, Vec<String>>,
    next: &BTreeMap<String, Vec<String>>,
) {
    for (key, values) in next {
        effective
            .entry(key.clone())
            .or_insert_with(|| values.clone());
    }
}

fn openssh_match_block_matches(
    block: &OpenSshMatchBlock,
    alias: &str,
    effective: &BTreeMap<String, Vec<String>>,
) -> bool {
    if block.unsupported {
        return false;
    }
    if block.criteria.iter().any(|(key, _)| key == "all") {
        return true;
    }
    block
        .criteria
        .iter()
        .all(|(key, pattern)| match key.as_str() {
            "host" | "originalhost" => openssh_pattern_matches(pattern, alias),
            "user" => setting_first(effective, "user")
                .map(|user| openssh_pattern_matches(pattern, &user))
                .unwrap_or(false),
            "localuser" => env::var("USER")
                .or_else(|_| env::var("USERNAME"))
                .map(|user| openssh_pattern_matches(pattern, &user))
                .unwrap_or(false),
            _ => false,
        })
}

fn setting_first(settings: &BTreeMap<String, Vec<String>>, key: &str) -> Option<String> {
    settings.get(key).and_then(|values| values.first()).cloned()
}

fn openssh_pattern_matches(patterns: &str, value: &str) -> bool {
    let mut matched = false;
    for raw_pattern in patterns
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
    {
        if let Some(pattern) = raw_pattern.strip_prefix('!') {
            if wildcard_match(pattern, value) {
                return false;
            }
        } else if wildcard_match(raw_pattern, value) {
            matched = true;
        }
    }
    matched
}

fn wildcard_match(pattern: &str, value: &str) -> bool {
    wildcard_match_bytes(pattern.as_bytes(), value.as_bytes())
}

fn wildcard_match_bytes(pattern: &[u8], value: &[u8]) -> bool {
    if pattern.is_empty() {
        return value.is_empty();
    }
    if pattern[0] == b'*' {
        return wildcard_match_bytes(&pattern[1..], value)
            || (!value.is_empty() && wildcard_match_bytes(pattern, &value[1..]));
    }
    if !value.is_empty() && (pattern[0] == b'?' || pattern[0] == value[0]) {
        return wildcard_match_bytes(&pattern[1..], &value[1..]);
    }
    false
}

fn mark_duplicate_connection_ids(hosts: &mut [ConnectionHostEntry]) {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for host in hosts
        .iter()
        .filter(|host| host.source == ConnectionHostSource::User)
    {
        *counts.entry(host.id.clone()).or_default() += 1;
    }
    for host in hosts.iter_mut() {
        if host.source != ConnectionHostSource::User {
            continue;
        }
        if counts.get(&host.id).copied().unwrap_or(0) > 1 {
            host.diagnostics.push(connection_diagnostic(
                ConnectionDiagnosticSeverity::Error,
                "duplicate_id",
                format!("duplicate connection host id {}", host.id),
            ));
        }
    }
}

fn watch_config(app: AppHandle, paths: Vec<PathBuf>) -> Result<()> {
    let state = watch_state();
    let mut guard = state.lock().unwrap();
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

pub(crate) fn list_profiles_impl_from_app(
    app: &AppHandle<impl Runtime>,
) -> Result<Vec<ProfileEntry>> {
    let root = ensure_layout(app)?;
    list_profiles_impl(Path::new(&root.root_dir))
}

pub(crate) fn set_active_profile_impl(
    app: &AppHandle<impl Runtime>,
    name: String,
) -> Result<ConfigRootInfo> {
    let root = ensure_layout(app)?;
    let root_path = PathBuf::from(&root.root_dir);
    let name = normalize_profile_name(&name)?;
    let path = profile_path(&root_path, &name);
    if !path.exists() {
        return Err(missing_error(format!("profile {name} not found")));
    }
    let state_path = Path::new(&root.state_path);
    let previous = load_state(state_path)?;
    let next = AppStateFile {
        active_profile: name.clone(),
        default_local_host_removed: previous.default_local_host_removed,
    };
    save_state(state_path, &next)?;
    emit_change(app);
    root_paths(app)
}

pub(crate) fn emit_change(app: &AppHandle<impl Runtime>) {
    let _ = crate::app_shell::apply_main_window_chrome(app);
    let _ = app.emit(CONFIG_CHANGED_EVENT, ());
}

pub(crate) fn effective_application_config(app: &AppHandle<impl Runtime>) -> Result<toml::Value> {
    let root = ensure_layout(app)?;
    let root_path = PathBuf::from(&root.root_dir);
    let main_config = read_main_config_from_path(Path::new(&root.main_config_path))?;
    let profile_config =
        read_profile_document_from_path(&profile_path(&root_path, &root.active_profile))?;
    let main_value = config_table_to_toml(&main_config.root)?;
    let profile_value = config_table_to_toml(&profile_config.root)?;
    Ok(deep_merge(&main_value, &profile_value))
}

pub(crate) fn effective_integrated_titlebar(app: &AppHandle<impl Runtime>) -> Result<bool> {
    let config = effective_application_config(app)?;
    let Some(table) = config.as_table() else {
        return Err(invalid_error("effective config must be a TOML table"));
    };
    let Some(ui) = table.get("ui") else {
        return Ok(true);
    };
    let Some(ui) = ui.as_table() else {
        return Err(invalid_error("ui must be a table"));
    };
    match ui.get("integrated_titlebar") {
        Some(toml::Value::Boolean(value)) => Ok(*value),
        Some(_) => Err(invalid_error("ui.integrated_titlebar must be a boolean")),
        None => Ok(true),
    }
}

pub(crate) fn effective_horizontal_tab_bar(app: &AppHandle<impl Runtime>) -> Result<bool> {
    let config = effective_application_config(app)?;
    let Some(table) = config.as_table() else {
        return Err(invalid_error("effective config must be a TOML table"));
    };
    let Some(terminal) = table.get("terminal") else {
        return Ok(true);
    };
    let Some(terminal) = terminal.as_table() else {
        return Err(invalid_error("terminal must be a table"));
    };
    match terminal.get("tab_bar_orientation") {
        Some(toml::Value::String(value)) if value == "horizontal" => Ok(true),
        Some(toml::Value::String(value))
            if value == "vertical" || value == "vertical_left" || value == "vertical_right" =>
        {
            Ok(false)
        }
        Some(toml::Value::String(value)) => Err(invalid_error(format!(
            "unsupported terminal.tab_bar_orientation value: {value}"
        ))),
        Some(_) => Err(invalid_error(
            "terminal.tab_bar_orientation must be a string",
        )),
        None => Ok(true),
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn get_config_root(app: AppHandle) -> Result<ConfigRootInfo> {
    log::debug!("command get_config_root started");
    let started = Instant::now();
    let root = ensure_layout(&app)?;
    log::debug!(
        "command get_config_root completed in {} ms",
        started.elapsed().as_millis()
    );
    Ok(root)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn get_config_snapshot(app: AppHandle) -> Result<AppConfigSnapshot> {
    log::debug!("command get_config_snapshot started");
    let started = Instant::now();
    let root = ensure_layout(&app)?;
    let root_path = PathBuf::from(&root.root_dir);
    let state = load_state(Path::new(&root.state_path))?;
    log::debug!("get_config_snapshot reading config documents");
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
    let profiles_started = Instant::now();
    let profiles = list_profiles_impl(&root_path)?;
    log::debug!(
        "get_config_snapshot loaded {} profile(s) in {} ms",
        profiles.len(),
        profiles_started.elapsed().as_millis()
    );
    let hosts_started = Instant::now();
    let hosts = load_connection_host_entries(&root_path, &state)?;
    log::debug!(
        "get_config_snapshot loaded {} host entry/entries in {} ms",
        hosts.len(),
        hosts_started.elapsed().as_millis()
    );
    log::info!(
        "command get_config_snapshot completed in {} ms",
        started.elapsed().as_millis()
    );
    Ok(AppConfigSnapshot {
        root,
        main_config,
        profile_config,
        effective_config,
        profiles,
        hosts,
    })
}

#[tauri::command]
#[specta::specta]
pub(crate) fn list_profiles(app: AppHandle) -> Result<Vec<ProfileEntry>> {
    let root = ensure_layout(&app)?;
    list_profiles_impl(Path::new(&root.root_dir))
}

#[tauri::command]
#[specta::specta]
pub(crate) fn read_profile(app: AppHandle, name: String) -> Result<ProfileConfigDocument> {
    let root = ensure_layout(&app)?;
    let path = profile_path(Path::new(&root.root_dir), &name);
    read_profile_document_from_path(&path)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn create_profile(app: AppHandle, input: ProfileDocumentInput) -> Result<ProfileEntry> {
    let root = ensure_layout(&app)?;
    let name = normalize_profile_name(&input.name)?;
    let path = profile_path(Path::new(&root.root_dir), &name);
    if path.exists() {
        return Err(invalid_error(format!("profile {name} already exists")));
    }
    write_document(&path, &input.document.root)?;
    emit_change(&app);
    let _ = crate::app_shell::refresh_menu(&app);
    Ok(ProfileEntry {
        name,
        path: path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
#[specta::specta]
pub(crate) fn update_profile(app: AppHandle, input: ProfileDocumentInput) -> Result<ProfileEntry> {
    let root = ensure_layout(&app)?;
    let name = normalize_profile_name(&input.name)?;
    let path = profile_path(Path::new(&root.root_dir), &name);
    if !path.exists() {
        return Err(missing_error(format!("profile {name} not found")));
    }
    write_document(&path, &input.document.root)?;
    emit_change(&app);
    let _ = crate::app_shell::refresh_menu(&app);
    Ok(ProfileEntry {
        name,
        path: path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
#[specta::specta]
pub(crate) fn delete_profile(app: AppHandle, name: String) -> Result<()> {
    let root = ensure_layout(&app)?;
    let name = normalize_profile_name(&name)?;
    if name == DEFAULT_PROFILE_NAME {
        return Err(invalid_error("default profile cannot be deleted"));
    }
    let profiles = list_profiles_impl(Path::new(&root.root_dir))?;
    if profiles.len() <= 1 {
        return Err(invalid_error("cannot delete the last profile"));
    }
    let path = profile_path(Path::new(&root.root_dir), &name);
    if !path.exists() {
        return Err(missing_error(format!("profile {name} not found")));
    }
    fs::remove_file(&path).map_err(io_error)?;
    let state_path = Path::new(&root.state_path);
    let state = load_state(state_path)?;
    if state.active_profile == name {
        save_state(
            state_path,
            &AppStateFile {
                active_profile: DEFAULT_PROFILE_NAME.to_string(),
                default_local_host_removed: state.default_local_host_removed,
            },
        )?;
    }
    emit_change(&app);
    let _ = crate::app_shell::refresh_menu(&app);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn set_active_profile(app: AppHandle, name: String) -> Result<ConfigRootInfo> {
    let root = set_active_profile_impl(&app, name)?;
    let _ = crate::app_shell::refresh_menu(&app);
    Ok(root)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn remove_config_key(app: AppHandle, input: ConfigKeyPathInput) -> Result<()> {
    let root = ensure_layout(&app)?;
    match input.target {
        ConfigDocumentTarget::Main => {
            let path = Path::new(&root.main_config_path);
            let mut document = read_main_config_from_path(path)?;
            remove_config_path(&mut document.root, &input.path)?;
            write_document(path, &document.root)?;
        }
        ConfigDocumentTarget::Profile => {
            let profile = input.profile.unwrap_or(root.active_profile);
            let profile = normalize_profile_name(&profile)?;
            let path = profile_path(Path::new(&root.root_dir), &profile);
            if !path.exists() {
                return Err(missing_error(format!("profile {profile} not found")));
            }
            let mut document = read_profile_document_from_path(&path)?;
            remove_config_path(&mut document.root, &input.path)?;
            write_document(&path, &document.root)?;
        }
    }
    emit_change(&app);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn read_main_config(app: AppHandle) -> Result<MainConfigDocument> {
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
pub(crate) fn update_main_config(
    app: AppHandle,
    document: MainConfigDocument,
) -> Result<MainConfigDocument> {
    let root = ensure_layout(&app)?;
    let path = Path::new(&root.main_config_path);
    write_document(path, &document.root)?;
    emit_change(&app);
    Ok(document)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn read_connection_host(app: AppHandle, id: String) -> Result<ConnectionHostEntry> {
    let root = ensure_layout(&app)?;
    let state = load_state(Path::new(&root.state_path))?;
    if id == DEFAULT_LOCAL_HOST_ID && !state.default_local_host_removed {
        return Ok(virtual_default_local_host());
    }
    let root_path = Path::new(&root.root_dir);
    let path = connection_host_path_from_id(root_path, &state.active_profile, &id)?;
    let base = connection_host_base_dir_for_path(root_path, &state.active_profile, &path)?;
    let document = read_connection_host_document_from_path(&path)?;
    Ok(connection_host_entry_from_path(&base, path, document))
}

#[tauri::command]
#[specta::specta]
pub(crate) fn list_connection_hosts(app: AppHandle) -> Result<Vec<ConnectionHostEntry>> {
    log::debug!("command list_connection_hosts started");
    let started = Instant::now();
    let root = ensure_layout(&app)?;
    let state = load_state(Path::new(&root.state_path))?;
    let hosts = load_connection_host_entries(Path::new(&root.root_dir), &state)?;
    log::info!(
        "command list_connection_hosts completed with {} host(s) in {} ms",
        hosts.len(),
        started.elapsed().as_millis()
    );
    Ok(hosts)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn create_connection_host(
    app: AppHandle,
    input: ConnectionHostDocumentInput,
) -> Result<ConnectionHostEntry> {
    let root = ensure_layout(&app)?;
    let state = load_state(Path::new(&root.state_path))?;
    let mut document = input.document;
    if document.id.trim().is_empty() {
        document.id = next_connection_host_id();
    }
    validate_connection_host_document(&document)?;
    let folder = validate_connection_host_folder(input.folder.as_deref())?;
    let dirs = host_dirs(Path::new(&root.root_dir), &state.active_profile)?;
    let dir = if let Some(directory) = input.directory {
        let selected = PathBuf::from(directory);
        if !dirs.iter().any(|dir| dir == &selected) {
            return Err(invalid_error("connection host directory is not configured"));
        }
        selected
    } else {
        dirs.into_iter()
            .next()
            .ok_or_else(|| missing_error("connection host directory is not configured"))?
    };
    let path = connection_host_file_path(&dir, folder, &document.id);
    if path.exists() {
        return Err(invalid_error(format!(
            "connection host {} already exists",
            document.id
        )));
    }
    ensure_parent(&path)?;
    write_connection_host_document(&path, &document)?;
    emit_change(&app);
    Ok(connection_host_entry_from_path(&dir, path, document))
}

#[tauri::command]
#[specta::specta]
pub(crate) fn update_connection_host(
    app: AppHandle,
    input: ConnectionHostDocumentInput,
) -> Result<ConnectionHostEntry> {
    let root = ensure_layout(&app)?;
    let state = load_state(Path::new(&root.state_path))?;
    let old_path = if let Some(id) = input.id.clone() {
        connection_host_path_from_id(Path::new(&root.root_dir), &state.active_profile, &id)?
    } else {
        return Err(invalid_error("connection host id is required for update"));
    };
    validate_connection_host_document(&input.document)?;
    let root_path = Path::new(&root.root_dir);
    let base = connection_host_base_dir_for_path(root_path, &state.active_profile, &old_path)?;
    let folder = validate_connection_host_folder(input.folder.as_deref())?;
    let new_path = connection_host_file_path(&base, folder, &input.document.id);
    if old_path != new_path {
        if new_path.exists() {
            return Err(invalid_error(format!(
                "connection host {} already exists",
                input.document.id
            )));
        } else {
            ensure_parent(&new_path)?;
            fs::rename(&old_path, &new_path).map_err(io_error)?;
        }
    }
    write_connection_host_document(&new_path, &input.document)?;
    if let Some(parent) = old_path.parent() {
        remove_empty_host_dirs(&base, parent);
    }
    emit_change(&app);
    Ok(connection_host_entry_from_path(
        &base,
        new_path,
        input.document,
    ))
}

#[tauri::command]
#[specta::specta]
pub(crate) fn delete_connection_host(app: AppHandle, id: String) -> Result<()> {
    let root = ensure_layout(&app)?;
    let state = load_state(Path::new(&root.state_path))?;
    if id == DEFAULT_LOCAL_HOST_ID {
        let mut next_state = state.clone();
        next_state.default_local_host_removed = true;
        save_state(Path::new(&root.state_path), &next_state)?;
    } else {
        let path =
            connection_host_path_from_id(Path::new(&root.root_dir), &state.active_profile, &id)?;
        let root_path = Path::new(&root.root_dir);
        let base = connection_host_base_dir_for_path(root_path, &state.active_profile, &path)?;
        let parent = path.parent().map(Path::to_path_buf);
        fs::remove_file(path).map_err(io_error)?;
        if let Some(parent) = parent {
            remove_empty_host_dirs(&base, &parent);
        }
    }
    if root.default_host == id {
        let setting_path = vec!["default_host".to_string()];
        let profile_path = profile_path(Path::new(&root.root_dir), &root.active_profile);
        let mut profile = read_profile_document_from_path(&profile_path)?;
        if remove_config_path(&mut profile.root, &setting_path)? {
            write_document(&profile_path, &profile.root)?;
        } else {
            let main_path = Path::new(&root.main_config_path);
            let mut document = read_main_config_from_path(main_path)?;
            remove_config_path(&mut document.root, &setting_path)?;
            write_document(main_path, &document.root)?;
        }
    }
    delete_keyring_entries_for_connection_host(&id);
    emit_change(&app);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn repair_connection_host_id(app: AppHandle, id: String) -> Result<ConnectionHostEntry> {
    let root = ensure_layout(&app)?;
    let state = load_state(Path::new(&root.state_path))?;
    let root_path = Path::new(&root.root_dir);
    let path = connection_host_path_from_id(root_path, &state.active_profile, &id)?;
    let base = connection_host_base_dir_for_path(root_path, &state.active_profile, &path)?;
    let mut document = read_connection_host_document_from_path(&path)?;
    let old_id = document.id.clone();
    document.id = next_connection_host_id();
    let new_path = path
        .parent()
        .ok_or_else(|| invalid_error("invalid connection host path"))?
        .join(format!("{}.toml", document.id));
    write_connection_host_document(&new_path, &document)?;
    if path != new_path {
        fs::remove_file(path).map_err(io_error)?;
    }
    delete_keyring_entries_for_connection_host(&old_id);
    emit_change(&app);
    Ok(connection_host_entry_from_path(&base, new_path, document))
}

fn delete_keyring_entries_for_connection_host(id: &str) {
    let _ = keyring::use_native_store(true);
    for account in [
        format!("connection-host:{id}:password"),
        format!("connection-host:{id}:key_passphrase"),
    ] {
        if let Ok(entry) = KeyringEntry::new("nocturne", &account) {
            let _ = entry.delete_credential();
        }
    }
    let mut spec = std::collections::HashMap::new();
    spec.insert("service", "nocturne");
    if let Ok(entries) = KeyringEntry::search(&spec) {
        let prefix = format!("connection-host:{id}:");
        for entry in entries {
            let Some((service, account)) = entry.get_specifiers() else {
                continue;
            };
            if service == "nocturne" && account.starts_with(&prefix) {
                let _ = entry.delete_credential();
            }
        }
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn set_host_dirs_command(
    app: AppHandle,
    input: HostDirsInput,
) -> Result<ConfigRootInfo> {
    let root = ensure_layout(&app)?;
    let path = Path::new(&root.main_config_path);
    let mut document = read_main_config_from_path(path)?;
    document.root.values.insert(
        "host_dirs".to_string(),
        ConfigValue::Array(input.dirs.into_iter().map(ConfigValue::String).collect()),
    );
    write_document(path, &document.root)?;
    emit_change(&app);
    watch_config_command(app.clone())?;
    root_paths(&app)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn set_openssh_config_files_command(
    app: AppHandle,
    input: HostDirsInput,
) -> Result<ConfigRootInfo> {
    let root = ensure_layout(&app)?;
    let path = Path::new(&root.main_config_path);
    let mut document = read_main_config_from_path(path)?;
    document.root.values.insert(
        "openssh_config_files".to_string(),
        ConfigValue::Array(input.dirs.into_iter().map(ConfigValue::String).collect()),
    );
    write_document(path, &document.root)?;
    emit_change(&app);
    watch_config_command(app.clone())?;
    root_paths(&app)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn set_default_host_command(app: AppHandle, host_id: String) -> Result<ConfigRootInfo> {
    let root = ensure_layout(&app)?;
    if host_id == DEFAULT_LOCAL_HOST_ID {
        let mut state = load_state(Path::new(&root.state_path))?;
        if state.default_local_host_removed {
            state.default_local_host_removed = false;
            save_state(Path::new(&root.state_path), &state)?;
        }
    }
    let host = connection_host_by_id(&app, &host_id)?;
    if host
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == ConnectionDiagnosticSeverity::Error)
    {
        return Err(invalid_error(
            "default host cannot have blocking diagnostics",
        ));
    }
    let setting_path = ["default_host"];
    let root_path = Path::new(&root.root_dir);
    let profile_path = profile_path(root_path, &root.active_profile);
    let mut profile = read_profile_document_from_path(&profile_path)?;
    if has_config_path(&profile.root, &setting_path) {
        write_string_config_path(&mut profile.root, &setting_path, host_id)?;
        write_document(&profile_path, &profile.root)?;
    } else {
        let path = Path::new(&root.main_config_path);
        let mut main = read_main_config_from_path(path)?;
        write_string_config_path(&mut main.root, &setting_path, host_id)?;
        write_document(path, &main.root)?;
    }
    emit_change(&app);
    root_paths(&app)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn watch_config_command(app: AppHandle) -> Result<()> {
    log::debug!("command watch_config_command started");
    let started = Instant::now();
    let root = ensure_layout(&app)?;
    let state = load_state(Path::new(&root.state_path))?;
    let mut paths = vec![
        PathBuf::from(&root.main_config_path),
        PathBuf::from(&root.state_path),
        Path::new(&root.root_dir).join(PROFILES_DIR),
        Path::new(&root.root_dir).join(TERMINAL_COLOR_SCHEMES_DIR),
    ];
    paths.extend(host_dirs(Path::new(&root.root_dir), &state.active_profile)?);
    paths.extend(
        load_application_connection_config(Path::new(&root.root_dir), &state.active_profile)?
            .openssh_config_files,
    );
    paths.push(Path::new(&root.root_dir).join(KNOWN_HOSTS_FILE));
    log::debug!(
        "watch_config_command installing watchers for {} path(s): {}",
        paths.len(),
        display_paths(&paths)
    );
    watch_config(app, paths)?;
    log::debug!(
        "command watch_config_command completed in {} ms",
        started.elapsed().as_millis()
    );
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn list_ssh_known_hosts(app: AppHandle) -> Result<Vec<String>> {
    let root = ensure_layout(&app)?;
    let path = Path::new(&root.root_dir).join(KNOWN_HOSTS_FILE);
    let store = SshTrustStore::load(&path)?;
    Ok(store.ssh.into_iter().map(|entry| entry.target).collect())
}

pub(crate) fn ssh_known_hosts_path(app: &AppHandle<impl Runtime>) -> Result<PathBuf> {
    let root = ensure_layout(app)?;
    Ok(Path::new(&root.root_dir).join(KNOWN_HOSTS_FILE))
}

pub(crate) fn connection_host_by_id(
    app: &AppHandle<impl Runtime>,
    id: &str,
) -> Result<ConnectionHostEntry> {
    let root = ensure_layout(app)?;
    let state = load_state(Path::new(&root.state_path))?;
    let entries = load_connection_host_entries(Path::new(&root.root_dir), &state)?;
    entries
        .into_iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| missing_error(format!("connection host {id} not found")))
}

pub(crate) fn update_connection_host_port_forwards<R, F>(
    app: &AppHandle<R>,
    id: &str,
    update: F,
) -> Result<ConnectionHostEntry>
where
    R: Runtime,
    F: FnOnce(&mut Vec<PortForwardRule>) -> Result<()>,
{
    let root = ensure_layout(app)?;
    let state = load_state(Path::new(&root.state_path))?;
    let root_path = Path::new(&root.root_dir);
    let path = connection_host_path_from_id(root_path, &state.active_profile, id)?;
    let base = connection_host_base_dir_for_path(root_path, &state.active_profile, &path)?;
    let mut document = read_connection_host_document_from_path(&path)?;
    update(&mut document.port_forwards)?;
    write_connection_host_document(&path, &document)?;
    emit_change(app);
    Ok(connection_host_entry_from_path(&base, path, document))
}

pub(crate) fn default_connection_host_id(app: &AppHandle<impl Runtime>) -> Result<String> {
    let root = root_paths(app)?;
    let configured = root.default_host;
    if connection_host_by_id(app, &configured).is_ok() {
        return Ok(configured);
    }
    Err(missing_error(format!(
        "default connection host {configured} not found"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ConfigError;
    use crate::types::{
        ConnectionProtocol, HostTerminalConfig, PortForwardDirection,
        PortForwardNonLoopbackConfirmation, PortForwardRule, PortForwardSemanticKey,
        TelnetConnectionConfig,
    };
    use tempfile::tempdir;

    #[test]
    fn rejects_empty_config_root_override() {
        let error = config_root_override_from_env_value(Some("  ".to_string()))
            .expect_err("empty override should fail");
        assert!(matches!(error, ConfigError::Invalid { .. }));
    }

    #[test]
    fn accepts_explicit_config_root_override() {
        let dir = tempdir().expect("temp dir");
        assert_eq!(
            config_root_override_from_env_value(Some(dir.path().to_string_lossy().into_owned()))
                .expect("override result")
                .expect("override path"),
            dir.path()
        );
    }

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

    #[test]
    fn connection_host_round_trips_with_stable_uuid_identity() {
        let dir = tempdir().expect("temp dir");
        let id = "018f6eb3-6f91-7410-bc43-f927b2236d94";
        let path = dir.path().join(format!("{id}.toml"));
        let document = ConnectionHostDocument {
            version: 1,
            id: id.to_string(),
            name: "Production API".to_string(),
            folder: Some("Production".to_string()),
            icon: Some(ConnectionHostIcon::Catalog {
                name: "devicon:amazonwebservices".to_string(),
            }),
            protocol: ConnectionProtocol::Ssh,
            local: None,
            ssh: Some(SshConnectionConfig {
                hostname: "prod.example.com".to_string(),
                port: 22,
                username: Some("deploy".to_string()),
                identity_file: Some("~/.ssh/id_ed25519".to_string()),
                proxy_jump: Some("bastion".to_string()),
                forward_agent: true,
                server_alive_interval: Some(30),
            }),
            files: None,
            resources: None,
            port_forwards: Vec::new(),
            terminal: None,
            telnet: None,
        };

        write_connection_host_document(&path, &document).expect("write host");
        let read = read_connection_host_document_from_path(&path).expect("read host");
        let text = fs::read_to_string(&path).expect("host toml");

        assert_eq!(read.id, id);
        assert_eq!(read.name, "Production API");
        assert_eq!(read.folder, None);
        assert!(!text.contains("folder"));
        assert!(matches!(
            read.icon,
            Some(ConnectionHostIcon::Catalog { ref name }) if name == "devicon:amazonwebservices"
        ));
        assert_eq!(read.ssh.expect("ssh").hostname, "prod.example.com");
    }

    #[test]
    fn connection_host_round_trips_saved_port_forwards() {
        let dir = tempdir().expect("temp dir");
        let id = "018f6eb3-6f91-7410-bc43-f927b2236d94";
        let path = dir.path().join(format!("{id}.toml"));
        let rule = test_port_forward_rule(
            "018f6eb3-6f91-7410-bc43-f927b2236d95",
            PortForwardDirection::LocalToRemote,
            "127.0.0.1",
            15432,
            "db.internal",
            5432,
        );
        let document = test_ssh_host_document(id, "Production API", vec![rule.clone()]);

        write_connection_host_document(&path, &document).expect("write host");
        let read = read_connection_host_document_from_path(&path).expect("read host");
        let text = fs::read_to_string(&path).expect("host toml");

        assert!(text.contains("[[port_forwards]]"));
        assert!(text.contains("direction = \"local_to_remote\""));
        assert_eq!(read.port_forwards.len(), 1);
        assert_eq!(read.port_forwards[0].id, rule.id);
        assert_eq!(read.port_forwards[0].name, "Postgres");
        assert_eq!(read.port_forwards[0].local_address, "127.0.0.1");
        assert_eq!(read.port_forwards[0].local_port, 15432);
        assert_eq!(read.port_forwards[0].remote_address, "db.internal");
        assert_eq!(read.port_forwards[0].remote_port, 5432);
        assert!(read.port_forwards[0].connect_on_host_open);
    }

    #[test]
    fn connection_host_preserves_port_forwards_for_unsupported_protocols() {
        let dir = tempdir().expect("temp dir");
        let id = "018f6eb3-6f91-7410-bc43-f927b2236d94";
        let path = dir.path().join(format!("{id}.toml"));
        let mut document = ConnectionHostDocument {
            version: 1,
            id: id.to_string(),
            name: "Local With Saved Forwards".to_string(),
            folder: None,
            icon: None,
            files: None,
            resources: None,
            port_forwards: vec![test_port_forward_rule(
                "018f6eb3-6f91-7410-bc43-f927b2236d95",
                PortForwardDirection::RemoteToLocal,
                "127.0.0.1",
                3000,
                "127.0.0.1",
                0,
            )],
            terminal: None,
            protocol: ConnectionProtocol::Local,
            local: Some(LocalConnectionConfig::default()),
            ssh: None,
            telnet: None,
        };

        write_connection_host_document(&path, &document).expect("write local host");
        document.protocol = ConnectionProtocol::Telnet;
        document.local = None;
        document.telnet = Some(TelnetConnectionConfig {
            hostname: "router.internal".to_string(),
            port: 23,
        });
        write_connection_host_document(&path, &document).expect("write telnet host");
        let read = read_connection_host_document_from_path(&path).expect("read telnet host");

        assert_eq!(read.protocol, ConnectionProtocol::Telnet);
        assert_eq!(read.port_forwards.len(), 1);
        assert_eq!(
            read.port_forwards[0].direction,
            PortForwardDirection::RemoteToLocal
        );
        assert_eq!(read.port_forwards[0].remote_port, 0);
    }

    #[test]
    fn connection_host_validation_rejects_duplicate_port_forward_semantics() {
        let first = test_port_forward_rule(
            "018f6eb3-6f91-7410-bc43-f927b2236d95",
            PortForwardDirection::LocalToRemote,
            "127.0.0.1",
            15432,
            "db.internal",
            5432,
        );
        let mut second = first.clone();
        second.id = "018f6eb3-6f91-7410-bc43-f927b2236d96".to_string();
        second.name = "Different Label".to_string();
        let document = test_ssh_host_document(
            "018f6eb3-6f91-7410-bc43-f927b2236d94",
            "Production API",
            vec![first, second],
        );

        let error = validate_connection_host_document(&document)
            .expect_err("duplicate port forward semantics");

        assert!(format!("{error}").contains("duplicate port forward rule connection semantics"));
    }

    #[test]
    fn connection_host_validation_requires_explicit_port_forward_addresses() {
        let rule = test_port_forward_rule(
            "018f6eb3-6f91-7410-bc43-f927b2236d95",
            PortForwardDirection::LocalToRemote,
            "",
            15432,
            "db.internal",
            5432,
        );
        let document = test_ssh_host_document(
            "018f6eb3-6f91-7410-bc43-f927b2236d94",
            "Production API",
            vec![rule],
        );

        let error =
            validate_connection_host_document(&document).expect_err("missing local address");

        assert!(format!("{error}").contains("port forward local address cannot be empty"));
    }

    #[test]
    fn connection_host_validation_invalidates_stale_port_forward_confirmations() {
        let mut rule = test_port_forward_rule(
            "018f6eb3-6f91-7410-bc43-f927b2236d95",
            PortForwardDirection::LocalToRemote,
            "0.0.0.0",
            15432,
            "db.internal",
            5432,
        );
        rule.non_loopback_confirmations
            .push(PortForwardNonLoopbackConfirmation {
                semantic_key: PortForwardSemanticKey {
                    direction: PortForwardDirection::LocalToRemote,
                    local_address: "127.0.0.1".to_string(),
                    local_port: 15432,
                    remote_address: "db.internal".to_string(),
                    remote_port: 5432,
                },
                confirmed_at_unix_ms: "1781881401000".to_string(),
            });
        let document = test_ssh_host_document(
            "018f6eb3-6f91-7410-bc43-f927b2236d94",
            "Production API",
            vec![rule],
        );

        let error = validate_connection_host_document(&document).expect_err("stale confirmation");

        assert!(format!("{error}").contains("stale non-loopback confirmation"));
    }

    #[test]
    fn user_connection_hosts_default_terminal_agent_mode_to_enabled() {
        let document = ConnectionHostDocument {
            version: 1,
            id: "018f6eb3-6f91-7410-bc43-f927b2236d94".to_string(),
            name: "Project Shell".to_string(),
            folder: None,
            icon: None,
            files: None,
            resources: None,
            port_forwards: Vec::new(),
            terminal: None,
            protocol: ConnectionProtocol::Local,
            local: Some(LocalConnectionConfig::default()),
            ssh: None,
            telnet: None,
        };
        let entry = ConnectionHostEntry {
            id: document.id.clone(),
            path: Some("Project.toml".to_string()),
            source: ConnectionHostSource::User,
            read_only: false,
            document,
            diagnostics: Vec::new(),
        };

        assert_eq!(
            effective_terminal_agent_mode(&entry),
            TerminalAgentMode::Enabled
        );
    }

    #[test]
    fn terminal_agent_mode_can_be_disabled_per_user_connection_host() {
        let document = ConnectionHostDocument {
            version: 1,
            id: "018f6eb3-6f91-7410-bc43-f927b2236d94".to_string(),
            name: "Project Shell".to_string(),
            folder: None,
            icon: None,
            files: None,
            resources: None,
            port_forwards: Vec::new(),
            terminal: Some(HostTerminalConfig {
                agent_mode: Some(TerminalAgentMode::Disabled),
            }),
            protocol: ConnectionProtocol::Local,
            local: Some(LocalConnectionConfig::default()),
            ssh: None,
            telnet: None,
        };
        let entry = ConnectionHostEntry {
            id: document.id.clone(),
            path: Some("Project.toml".to_string()),
            source: ConnectionHostSource::User,
            read_only: false,
            document,
            diagnostics: Vec::new(),
        };

        assert_eq!(
            effective_terminal_agent_mode(&entry),
            TerminalAgentMode::Disabled
        );
    }

    #[test]
    fn virtual_default_local_host_enables_terminal_agent_mode() {
        let entry = virtual_default_local_host();

        assert_eq!(
            effective_terminal_agent_mode(&entry),
            TerminalAgentMode::Enabled
        );
    }

    #[test]
    fn read_only_external_connection_hosts_force_terminal_agent_mode_disabled() {
        let mut document = default_local_host_document();
        document.terminal = Some(HostTerminalConfig {
            agent_mode: Some(TerminalAgentMode::Enabled),
        });
        let entry = ConnectionHostEntry {
            id: document.id.clone(),
            path: Some("config".to_string()),
            source: ConnectionHostSource::OpenSshConfig,
            read_only: true,
            document,
            diagnostics: Vec::new(),
        };

        assert_eq!(
            effective_terminal_agent_mode(&entry),
            TerminalAgentMode::Disabled
        );
    }

    #[test]
    fn connection_host_entries_derive_nested_folder_from_file_path() {
        let root = tempdir().expect("temp dir");
        let hosts_dir = root.path().join(DEFAULT_HOSTS_DIR);
        fs::create_dir_all(root.path().join(PROFILES_DIR)).expect("profiles dir");
        write_atomic(&root.path().join(MAIN_CONFIG_FILE), "").expect("main config");
        write_atomic(
            &root.path().join(PROFILES_DIR).join(DEFAULT_PROFILE_FILE),
            "",
        )
        .expect("default profile");
        fs::create_dir_all(hosts_dir.join("path").join("to")).expect("nested hosts dir");
        let id = "018f6eb3-6f91-7410-bc43-f927b2236d94";
        let document = ConnectionHostDocument {
            version: 1,
            id: id.to_string(),
            name: "Nested".to_string(),
            folder: Some("ignored".to_string()),
            icon: Some(ConnectionHostIcon::Catalog {
                name: "lucide:server".to_string(),
            }),
            protocol: ConnectionProtocol::Ssh,
            local: None,
            ssh: Some(SshConnectionConfig {
                hostname: "nested.example.com".to_string(),
                port: 22,
                username: None,
                identity_file: None,
                proxy_jump: None,
                forward_agent: false,
                server_alive_interval: None,
            }),
            files: None,
            resources: None,
            port_forwards: Vec::new(),
            terminal: None,
            telnet: None,
        };
        write_connection_host_document(
            &hosts_dir.join("path").join("to").join(format!("{id}.toml")),
            &document,
        )
        .expect("write nested host");

        let entries = load_connection_host_entries(root.path(), &AppStateFile::default())
            .expect("list hosts");
        let entry = entries
            .iter()
            .find(|entry| entry.id == id)
            .expect("nested host entry");

        assert_eq!(entry.document.folder.as_deref(), Some("path/to"));
    }

    #[test]
    fn validate_connection_host_folder_rejects_absolute_and_parent_paths() {
        assert!(validate_connection_host_folder(Some("team/prod"))
            .expect("valid")
            .is_some());
        assert!(matches!(
            validate_connection_host_folder(Some("../prod")),
            Err(ConfigError::Invalid { .. })
        ));
        assert!(matches!(
            validate_connection_host_folder(Some("/prod")),
            Err(ConfigError::Invalid { .. })
        ));
    }

    #[test]
    fn connection_host_validation_rejects_missing_protocol_config() {
        let document = ConnectionHostDocument {
            version: 1,
            id: "018f6eb3-6f91-7410-bc43-f927b2236d94".to_string(),
            name: "Router".to_string(),
            folder: None,
            icon: None,
            protocol: ConnectionProtocol::Telnet,
            local: None,
            ssh: None,
            files: None,
            resources: None,
            port_forwards: Vec::new(),
            terminal: None,
            telnet: None,
        };

        let error =
            validate_connection_host_document(&document).expect_err("missing telnet config");

        assert!(format!("{error}").contains("telnet connection host requires"));
    }

    #[test]
    fn connection_host_validation_rejects_unsafe_svg_icons() {
        let document = ConnectionHostDocument {
            version: 1,
            id: "018f6eb3-6f91-7410-bc43-f927b2236d94".to_string(),
            name: "Unsafe".to_string(),
            folder: None,
            icon: Some(ConnectionHostIcon::Svg {
                svg: r#"<svg onload="alert(1)"></svg>"#.to_string(),
            }),
            protocol: ConnectionProtocol::Local,
            local: Some(LocalConnectionConfig::default()),
            ssh: None,
            files: None,
            resources: None,
            port_forwards: Vec::new(),
            terminal: None,
            telnet: None,
        };

        let error = validate_connection_host_document(&document).expect_err("unsafe SVG");

        assert!(format!("{error}").contains("event attributes"));
    }

    #[test]
    fn connection_host_validation_rejects_invalid_image_icon_base64() {
        let document = ConnectionHostDocument {
            version: 1,
            id: "018f6eb3-6f91-7410-bc43-f927b2236d94".to_string(),
            name: "Invalid Image".to_string(),
            folder: None,
            icon: Some(ConnectionHostIcon::Image {
                mime: "image/png".to_string(),
                data_base64: "not base64".to_string(),
            }),
            protocol: ConnectionProtocol::Local,
            local: Some(LocalConnectionConfig::default()),
            ssh: None,
            files: None,
            resources: None,
            port_forwards: Vec::new(),
            terminal: None,
            telnet: None,
        };

        let error = validate_connection_host_document(&document).expect_err("invalid base64");

        assert!(format!("{error}").contains("must be base64"));
    }

    #[test]
    fn connection_host_entries_report_duplicate_uuids_and_filename_mismatch() {
        let root = tempdir().expect("temp dir");
        let hosts_dir = root.path().join(DEFAULT_HOSTS_DIR);
        fs::create_dir_all(root.path().join(PROFILES_DIR)).expect("profiles dir");
        write_atomic(&root.path().join(MAIN_CONFIG_FILE), "").expect("main config");
        write_atomic(
            &root.path().join(PROFILES_DIR).join(DEFAULT_PROFILE_FILE),
            "",
        )
        .expect("default profile");
        fs::create_dir_all(&hosts_dir).expect("hosts dir");
        let id = "018f6eb3-6f91-7410-bc43-f927b2236d94";
        let first = ConnectionHostDocument {
            version: 1,
            id: id.to_string(),
            name: "A".to_string(),
            folder: Some("Team A".to_string()),
            icon: Some(ConnectionHostIcon::Catalog {
                name: "lucide:server".to_string(),
            }),
            protocol: ConnectionProtocol::Ssh,
            local: None,
            ssh: Some(SshConnectionConfig {
                hostname: "a.example.com".to_string(),
                port: 22,
                username: None,
                identity_file: None,
                proxy_jump: None,
                forward_agent: false,
                server_alive_interval: None,
            }),
            files: None,
            resources: None,
            port_forwards: Vec::new(),
            terminal: None,
            telnet: None,
        };
        let second = ConnectionHostDocument {
            version: 1,
            id: id.to_string(),
            name: "B".to_string(),
            folder: Some("Routers".to_string()),
            icon: Some(ConnectionHostIcon::Catalog {
                name: "lucide:network".to_string(),
            }),
            protocol: ConnectionProtocol::Telnet,
            local: None,
            ssh: None,
            files: None,
            resources: None,
            port_forwards: Vec::new(),
            terminal: None,
            telnet: Some(TelnetConnectionConfig {
                hostname: "192.0.2.1".to_string(),
                port: 23,
            }),
        };
        write_connection_host_document(&hosts_dir.join(format!("{id}.toml")), &first)
            .expect("write first");
        write_connection_host_document(&hosts_dir.join("different-name.toml"), &second)
            .expect("write second");

        let state = AppStateFile::default();
        let entries = load_connection_host_entries(root.path(), &state).expect("list hosts");
        let user_entries = entries
            .iter()
            .filter(|entry| entry.source == ConnectionHostSource::User)
            .collect::<Vec<_>>();

        assert_eq!(user_entries.len(), 2);
        assert!(user_entries.iter().all(|entry| {
            entry
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "duplicate_id")
        }));
        assert!(user_entries.iter().any(|entry| {
            entry
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "filename_id_mismatch")
        }));
    }

    #[test]
    fn openssh_parser_resolves_include_and_match_with_wildcards() {
        let root = tempdir().expect("temp dir");
        let include = root.path().join("included.conf");
        write_atomic(
            &include,
            r#"
            Host prod-*
              User deploy

            Match host prod-api
              Port 2200
            "#,
        )
        .expect("include");
        let config = root.path().join("config");
        write_atomic(
            &config,
            &format!(
                r#"
                Include {}

                Host prod-api
                  HostName prod.example.com
                  IdentityFile ~/.ssh/prod

                Host *
                  ForwardAgent yes
                "#,
                include.display()
            ),
        )
        .expect("config");

        let parsed = parse_openssh_config(&config).expect("parse openssh config");
        let hosts = parsed_to_openssh_hosts(parsed, &config);
        let prod = hosts
            .iter()
            .find(|host| host.document.name == "prod-api")
            .expect("prod-api host");
        let ssh = prod.document.ssh.as_ref().expect("ssh config");

        assert_eq!(ssh.hostname, "prod.example.com");
        assert_eq!(ssh.username.as_deref(), Some("deploy"));
        assert_eq!(ssh.port, 2200);
        assert_eq!(prod.document.folder.as_deref(), Some("config"));
        assert!(matches!(
            prod.document.icon,
            Some(ConnectionHostIcon::Catalog { ref name }) if name == "devicon:ssh"
        ));
        let expected_identity = expand_home("~/.ssh/prod");
        assert_eq!(
            ssh.identity_file.as_deref(),
            Some(expected_identity.as_str())
        );
        assert!(ssh.forward_agent);
    }

    #[test]
    fn openssh_hosts_use_config_file_stem_as_read_only_folder() {
        let root = tempdir().expect("temp dir");
        let config = root.path().join("work.toml");
        write_atomic(
            &config,
            r#"
            Host db
              HostName db.example.com
            "#,
        )
        .expect("config");

        let hosts = parsed_to_openssh_hosts(parse_openssh_config(&config).expect("parse"), &config);
        let host = hosts.first().expect("host");

        assert_eq!(host.source, ConnectionHostSource::OpenSshConfig);
        assert!(host.read_only);
        assert_eq!(host.document.folder.as_deref(), Some("work"));
    }

    #[test]
    fn openssh_parser_does_not_show_wildcard_host_entries() {
        let root = tempdir().expect("temp dir");
        let config = root.path().join("config");
        write_atomic(
            &config,
            r#"
            Host *
              User deploy

            Host db
              HostName db.example.com
            "#,
        )
        .expect("config");

        let hosts = parsed_to_openssh_hosts(parse_openssh_config(&config).expect("parse"), &config);

        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].document.name, "db");
        assert_eq!(
            hosts[0]
                .document
                .ssh
                .as_ref()
                .expect("ssh")
                .username
                .as_deref(),
            Some("deploy")
        );
    }

    #[test]
    fn openssh_proxy_jump_aliases_resolve_to_effective_hop_configs() {
        let root = tempdir().expect("temp dir");
        let key = root.path().join("jump-key");
        let config = root.path().join("config");
        write_atomic(
            &config,
            &format!(
                r#"
                Host bastion
                  HostName 127.0.0.1
                  User jump
                  Port 2222
                  IdentityFile {}

                Host inner
                  HostName 127.0.0.2
                  User relay
                  Port 2200

                Host target
                  HostName 127.0.0.3
                  User app
                  ProxyJump bastion,inner
                "#,
                key.display()
            ),
        )
        .expect("config");

        let hops =
            resolve_openssh_proxy_jump_chain(&config, "bastion,inner").expect("resolved jumps");

        assert_eq!(hops.len(), 2);
        assert_eq!(hops[0].hostname, "127.0.0.1");
        assert_eq!(hops[0].username.as_deref(), Some("jump"));
        assert_eq!(hops[0].port, 2222);
        assert_eq!(
            hops[0].identity_file.as_deref(),
            Some(key.to_string_lossy().as_ref())
        );
        assert_eq!(hops[1].hostname, "127.0.0.2");
        assert_eq!(hops[1].username.as_deref(), Some("relay"));
        assert_eq!(hops[1].port, 2200);
    }

    #[test]
    fn openssh_proxy_jump_parses_bracketed_ipv6_with_and_without_port() {
        let default_port =
            parse_openssh_proxy_jump_reference("ops@[2001:db8::10]").expect("valid ipv6 jump");
        assert_eq!(default_port.username.as_deref(), Some("ops"));
        assert_eq!(default_port.alias, "2001:db8::10");
        assert_eq!(default_port.port, None);

        let explicit_port =
            parse_openssh_proxy_jump_reference("ops@[2001:db8::10]:2200").expect("valid ipv6 jump");
        assert_eq!(explicit_port.username.as_deref(), Some("ops"));
        assert_eq!(explicit_port.alias, "2001:db8::10");
        assert_eq!(explicit_port.port, Some(2200));
    }

    #[test]
    fn openssh_match_exec_is_reported_but_not_applied() {
        let root = tempdir().expect("temp dir");
        let config = root.path().join("config");
        write_atomic(
            &config,
            r#"
            Host prod
              HostName prod.example.com

            Match exec "echo unsafe"
              User root
            "#,
        )
        .expect("config");

        let hosts = parsed_to_openssh_hosts(parse_openssh_config(&config).expect("parse"), &config);
        let prod = hosts.first().expect("host");

        assert_eq!(
            prod.document.ssh.as_ref().expect("ssh").username.as_deref(),
            None
        );
        assert!(prod
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "unsupported_match_exec"));
    }

    fn test_ssh_host_document(
        id: &str,
        name: &str,
        port_forwards: Vec<PortForwardRule>,
    ) -> ConnectionHostDocument {
        ConnectionHostDocument {
            version: 1,
            id: id.to_string(),
            name: name.to_string(),
            folder: None,
            icon: Some(ConnectionHostIcon::Catalog {
                name: "devicon:ssh".to_string(),
            }),
            files: None,
            resources: None,
            port_forwards,
            terminal: None,
            protocol: ConnectionProtocol::Ssh,
            local: None,
            ssh: Some(SshConnectionConfig {
                hostname: "prod.example.com".to_string(),
                port: 22,
                username: Some("deploy".to_string()),
                identity_file: None,
                proxy_jump: None,
                forward_agent: false,
                server_alive_interval: None,
            }),
            telnet: None,
        }
    }

    fn test_port_forward_rule(
        id: &str,
        direction: PortForwardDirection,
        local_address: &str,
        local_port: u16,
        remote_address: &str,
        remote_port: u16,
    ) -> PortForwardRule {
        PortForwardRule {
            id: id.to_string(),
            name: "Postgres".to_string(),
            direction,
            local_address: local_address.to_string(),
            local_port,
            remote_address: remote_address.to_string(),
            remote_port,
            connect_on_host_open: true,
            non_loopback_confirmations: Vec::new(),
        }
    }
}
