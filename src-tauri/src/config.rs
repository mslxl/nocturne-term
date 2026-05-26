use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

use hex::ToHex;
use notify::{Config as NotifyConfig, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::{
    error::{invalid_error, io_error, missing_error, parse_error, Result},
    types::{
        AppConfigSnapshot, ConfigDocumentTarget, ConfigKeyPathInput, ConfigRootInfo, ConfigTable,
        ConfigValue, EffectiveConfigDocument, HostConfigDocument, HostDirsInput, HostDocumentInput,
        HostEntry, MainConfigDocument, ProfileConfigDocument, ProfileDocumentInput, ProfileEntry,
        TabBarOrientation,
    },
};

const CONFIG_CHANGED_EVENT: &str = "config://changed";
const ROOT_DIR_NAME: &str = "nocturne";
const MAIN_CONFIG_FILE: &str = "config.toml";
const STATE_FILE: &str = "state.toml";
pub(crate) const PROFILES_DIR: &str = "profiles";
const TERMINAL_COLOR_SCHEMES_DIR: &str = "terminal-color-schemes";
const DEFAULT_PROFILE_FILE: &str = "default.toml";
const DEFAULT_HOSTS_DIR: &str = "hosts";
const DEFAULT_PROFILE_NAME: &str = "default";

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
}

impl Default for AppStateFile {
    fn default() -> Self {
        Self {
            active_profile: DEFAULT_PROFILE_NAME.to_string(),
        }
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

pub(crate) fn root_paths(app: &AppHandle<impl Runtime>) -> Result<ConfigRootInfo> {
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
    let root = root_dir(app)?;
    fs::create_dir_all(&root).map_err(io_error)?;
    let profiles_dir = root.join(PROFILES_DIR);
    let hosts_dir = root.join(DEFAULT_HOSTS_DIR);
    let terminal_color_schemes_dir = root.join(TERMINAL_COLOR_SCHEMES_DIR);
    fs::create_dir_all(&profiles_dir).map_err(io_error)?;
    fs::create_dir_all(&hosts_dir).map_err(io_error)?;
    fs::create_dir_all(&terminal_color_schemes_dir).map_err(io_error)?;

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
    let next = AppStateFile {
        active_profile: name.clone(),
    };
    save_state(state_path, &next)?;
    emit_change(app);
    root_paths(app)
}

pub(crate) fn emit_change(app: &AppHandle<impl Runtime>) {
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

#[tauri::command]
#[specta::specta]
pub(crate) fn get_config_root(app: AppHandle) -> Result<ConfigRootInfo> {
    ensure_layout(&app)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn get_config_snapshot(app: AppHandle) -> Result<AppConfigSnapshot> {
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
        save_state(state_path, &AppStateFile::default())?;
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
pub(crate) fn read_host(app: AppHandle, id: String) -> Result<HostEntry> {
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
pub(crate) fn list_hosts(app: AppHandle) -> Result<Vec<HostEntry>> {
    let root = ensure_layout(&app)?;
    let state = load_state(Path::new(&root.state_path))?;
    load_host_entries(Path::new(&root.root_dir), &state)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn create_host(app: AppHandle, document: HostConfigDocument) -> Result<HostEntry> {
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
pub(crate) fn update_host(app: AppHandle, input: HostDocumentInput) -> Result<HostEntry> {
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
pub(crate) fn delete_host(app: AppHandle, id: String) -> Result<()> {
    let root = ensure_layout(&app)?;
    let state = load_state(Path::new(&root.state_path))?;
    let path = host_path_from_id(Path::new(&root.root_dir), &state.active_profile, &id)?;
    fs::remove_file(path).map_err(io_error)?;
    emit_change(&app);
    Ok(())
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
pub(crate) fn watch_config_command(app: AppHandle) -> Result<()> {
    let root = ensure_layout(&app)?;
    let state = load_state(Path::new(&root.state_path))?;
    let mut paths = vec![
        PathBuf::from(&root.main_config_path),
        PathBuf::from(&root.state_path),
        Path::new(&root.root_dir).join(PROFILES_DIR),
        Path::new(&root.root_dir).join(TERMINAL_COLOR_SCHEMES_DIR),
    ];
    paths.extend(host_dirs(Path::new(&root.root_dir), &state.active_profile)?);
    watch_config(app, paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ConfigError;

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
