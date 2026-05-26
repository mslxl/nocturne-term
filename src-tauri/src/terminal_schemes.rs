use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::{
    config,
    error::{invalid_error, io_error, missing_error, parse_error, Result},
    types::{
        TerminalColorScheme, TerminalColorSchemeEntry, TerminalColorSchemeExportInput, TerminalColorSchemeInput,
        TerminalColorSchemeSource, TerminalColorSchemeVariant, TerminalTheme,
    },
};

const SCHEMES_DIR: &str = "terminal-color-schemes";
const BUILTIN_LIGHT_ID: &str = "builtin:nocturne-light";
const BUILTIN_DARK_ID: &str = "builtin:nocturne-dark";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredTerminalColorScheme {
    name: String,
    author: Option<String>,
    variant: TerminalColorSchemeVariant,
    background: String,
    foreground: String,
    cursor: String,
    selection_background: String,
    black: String,
    red: String,
    green: String,
    yellow: String,
    blue: String,
    magenta: String,
    cyan: String,
    white: String,
    bright_black: String,
    bright_red: String,
    bright_green: String,
    bright_yellow: String,
    bright_blue: String,
    bright_magenta: String,
    bright_cyan: String,
    bright_white: String,
}

pub(crate) fn terminal_color_scheme_dir(app: &AppHandle<impl Runtime>) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(io_error)?
        .join("nocturne")
        .join(SCHEMES_DIR))
}

pub(crate) fn ensure_terminal_color_scheme_dir(app: &AppHandle<impl Runtime>) -> Result<PathBuf> {
    let dir = terminal_color_scheme_dir(app)?;
    fs::create_dir_all(&dir).map_err(io_error)?;
    Ok(dir)
}

pub(crate) fn scheme_to_terminal_theme(scheme: &TerminalColorScheme) -> TerminalTheme {
    TerminalTheme {
        background: scheme.background.clone(),
        foreground: scheme.foreground.clone(),
        cursor: scheme.cursor.clone(),
        selection_background: scheme.selection_background.clone(),
        black: scheme.black.clone(),
        red: scheme.red.clone(),
        green: scheme.green.clone(),
        yellow: scheme.yellow.clone(),
        blue: scheme.blue.clone(),
        magenta: scheme.magenta.clone(),
        cyan: scheme.cyan.clone(),
        white: scheme.white.clone(),
        bright_black: scheme.bright_black.clone(),
        bright_red: scheme.bright_red.clone(),
        bright_green: scheme.bright_green.clone(),
        bright_yellow: scheme.bright_yellow.clone(),
        bright_blue: scheme.bright_blue.clone(),
        bright_magenta: scheme.bright_magenta.clone(),
        bright_cyan: scheme.bright_cyan.clone(),
        bright_white: scheme.bright_white.clone(),
    }
}

pub(crate) fn builtin_light_scheme() -> TerminalColorScheme {
    TerminalColorScheme {
        id: BUILTIN_LIGHT_ID.to_string(),
        name: "Nocturne Light".to_string(),
        author: Some("Nocturne".to_string()),
        variant: TerminalColorSchemeVariant::Light,
        background: "#fbfbfb".to_string(),
        foreground: "#202124".to_string(),
        cursor: "#1f6feb".to_string(),
        selection_background: "#c8ddff".to_string(),
        black: "#25292e".to_string(),
        red: "#cf222e".to_string(),
        green: "#116329".to_string(),
        yellow: "#9a6700".to_string(),
        blue: "#0969da".to_string(),
        magenta: "#8250df".to_string(),
        cyan: "#1b7c83".to_string(),
        white: "#eaeef2".to_string(),
        bright_black: "#57606a".to_string(),
        bright_red: "#a40e26".to_string(),
        bright_green: "#1a7f37".to_string(),
        bright_yellow: "#bf8700".to_string(),
        bright_blue: "#218bff".to_string(),
        bright_magenta: "#a475f9".to_string(),
        bright_cyan: "#3192aa".to_string(),
        bright_white: "#ffffff".to_string(),
    }
}

pub(crate) fn builtin_dark_scheme() -> TerminalColorScheme {
    TerminalColorScheme {
        id: BUILTIN_DARK_ID.to_string(),
        name: "Nocturne Dark".to_string(),
        author: Some("Nocturne".to_string()),
        variant: TerminalColorSchemeVariant::Dark,
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

fn builtin_entries() -> Vec<TerminalColorSchemeEntry> {
    vec![
        TerminalColorSchemeEntry {
            id: BUILTIN_LIGHT_ID.to_string(),
            source: TerminalColorSchemeSource::Builtin,
            path: None,
            scheme: builtin_light_scheme(),
        },
        TerminalColorSchemeEntry {
            id: BUILTIN_DARK_ID.to_string(),
            source: TerminalColorSchemeSource::Builtin,
            path: None,
            scheme: builtin_dark_scheme(),
        },
    ]
}

fn stored_from_scheme(scheme: &TerminalColorScheme) -> StoredTerminalColorScheme {
    StoredTerminalColorScheme {
        name: scheme.name.clone(),
        author: scheme.author.clone(),
        variant: scheme.variant.clone(),
        background: scheme.background.clone(),
        foreground: scheme.foreground.clone(),
        cursor: scheme.cursor.clone(),
        selection_background: scheme.selection_background.clone(),
        black: scheme.black.clone(),
        red: scheme.red.clone(),
        green: scheme.green.clone(),
        yellow: scheme.yellow.clone(),
        blue: scheme.blue.clone(),
        magenta: scheme.magenta.clone(),
        cyan: scheme.cyan.clone(),
        white: scheme.white.clone(),
        bright_black: scheme.bright_black.clone(),
        bright_red: scheme.bright_red.clone(),
        bright_green: scheme.bright_green.clone(),
        bright_yellow: scheme.bright_yellow.clone(),
        bright_blue: scheme.bright_blue.clone(),
        bright_magenta: scheme.bright_magenta.clone(),
        bright_cyan: scheme.bright_cyan.clone(),
        bright_white: scheme.bright_white.clone(),
    }
}

fn scheme_from_stored(id: String, stored: StoredTerminalColorScheme) -> TerminalColorScheme {
    TerminalColorScheme {
        id,
        name: stored.name,
        author: stored.author,
        variant: stored.variant,
        background: stored.background,
        foreground: stored.foreground,
        cursor: stored.cursor,
        selection_background: stored.selection_background,
        black: stored.black,
        red: stored.red,
        green: stored.green,
        yellow: stored.yellow,
        blue: stored.blue,
        magenta: stored.magenta,
        cyan: stored.cyan,
        white: stored.white,
        bright_black: stored.bright_black,
        bright_red: stored.bright_red,
        bright_green: stored.bright_green,
        bright_yellow: stored.bright_yellow,
        bright_blue: stored.bright_blue,
        bright_magenta: stored.bright_magenta,
        bright_cyan: stored.bright_cyan,
        bright_white: stored.bright_white,
    }
}

fn validate_scheme(scheme: &TerminalColorScheme) -> Result<()> {
    validate_user_scheme_id(&scheme.id)?;
    if scheme.name.trim().is_empty() {
        return Err(invalid_error("terminal color scheme name cannot be empty"));
    }
    for (field, value) in color_fields(scheme) {
        if !is_css_hex_color(value) {
            return Err(invalid_error(format!(
                "terminal color scheme {field} must be a CSS hex color"
            )));
        }
    }
    Ok(())
}

fn color_fields(scheme: &TerminalColorScheme) -> Vec<(&'static str, &str)> {
    vec![
        ("background", &scheme.background),
        ("foreground", &scheme.foreground),
        ("cursor", &scheme.cursor),
        ("selection_background", &scheme.selection_background),
        ("black", &scheme.black),
        ("red", &scheme.red),
        ("green", &scheme.green),
        ("yellow", &scheme.yellow),
        ("blue", &scheme.blue),
        ("magenta", &scheme.magenta),
        ("cyan", &scheme.cyan),
        ("white", &scheme.white),
        ("bright_black", &scheme.bright_black),
        ("bright_red", &scheme.bright_red),
        ("bright_green", &scheme.bright_green),
        ("bright_yellow", &scheme.bright_yellow),
        ("bright_blue", &scheme.bright_blue),
        ("bright_magenta", &scheme.bright_magenta),
        ("bright_cyan", &scheme.bright_cyan),
        ("bright_white", &scheme.bright_white),
    ]
}

fn is_css_hex_color(value: &str) -> bool {
    let hex = value.strip_prefix('#');
    matches!(hex.map(str::len), Some(3 | 6 | 8))
        && hex
            .map(|text| text.chars().all(|item| item.is_ascii_hexdigit()))
            .unwrap_or(false)
}

fn validate_user_scheme_id(id: &str) -> Result<()> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err(invalid_error("terminal color scheme id cannot be empty"));
    }
    if trimmed.starts_with("builtin:") || trimmed.starts_with("legacy:") {
        return Err(invalid_error(
            "user terminal color scheme id cannot use a reserved prefix",
        ));
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed == "." || trimmed == ".." {
        return Err(invalid_error(
            "terminal color scheme id cannot contain path separators",
        ));
    }
    if !trimmed
        .chars()
        .all(|item| item.is_ascii_alphanumeric() || matches!(item, '-' | '_' | '.'))
    {
        return Err(invalid_error(
            "terminal color scheme id can only contain letters, numbers, dashes, underscores, and dots",
        ));
    }
    Ok(())
}

fn normalize_user_scheme_id(id: &str) -> Result<String> {
    validate_user_scheme_id(id)?;
    Ok(id.trim().to_string())
}

fn scheme_path(dir: &Path, id: &str) -> Result<PathBuf> {
    let id = normalize_user_scheme_id(id)?;
    Ok(dir.join(format!("{id}.toml")))
}

fn read_user_scheme_entry(path: &Path) -> Result<TerminalColorSchemeEntry> {
    let id = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| invalid_error("invalid terminal color scheme file name"))?
        .to_string();
    let text = fs::read_to_string(path).map_err(io_error)?;
    let stored: StoredTerminalColorScheme = toml::from_str(&text).map_err(parse_error)?;
    let scheme = scheme_from_stored(id.clone(), stored);
    validate_scheme(&scheme)?;
    Ok(TerminalColorSchemeEntry {
        id,
        source: TerminalColorSchemeSource::User,
        path: Some(path.to_string_lossy().into_owned()),
        scheme,
    })
}

fn write_user_scheme(path: &Path, scheme: &TerminalColorScheme) -> Result<()> {
    validate_scheme(scheme)?;
    let text = toml::to_string_pretty(&stored_from_scheme(scheme)).map_err(parse_error)?;
    fs::write(path, text).map_err(io_error)
}

fn user_entries(dir: &Path) -> Result<Vec<TerminalColorSchemeEntry>> {
    fs::create_dir_all(dir).map_err(io_error)?;
    let mut items = Vec::new();
    for entry in fs::read_dir(dir).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("toml") {
            continue;
        }
        items.push(read_user_scheme_entry(&path)?);
    }
    items.sort_by(|a, b| a.scheme.name.cmp(&b.scheme.name).then(a.id.cmp(&b.id)));
    Ok(items)
}

pub(crate) fn list_terminal_color_scheme_entries(
    app: &AppHandle<impl Runtime>,
) -> Result<Vec<TerminalColorSchemeEntry>> {
    let dir = ensure_terminal_color_scheme_dir(app)?;
    let mut entries = builtin_entries();
    entries.extend(user_entries(&dir)?);
    Ok(entries)
}

pub(crate) fn terminal_color_scheme_by_id(
    app: &AppHandle<impl Runtime>,
    id: &str,
) -> Result<TerminalColorSchemeEntry> {
    match id {
        BUILTIN_LIGHT_ID => {
            return Ok(TerminalColorSchemeEntry {
                id: BUILTIN_LIGHT_ID.to_string(),
                source: TerminalColorSchemeSource::Builtin,
                path: None,
                scheme: builtin_light_scheme(),
            });
        }
        BUILTIN_DARK_ID => {
            return Ok(TerminalColorSchemeEntry {
                id: BUILTIN_DARK_ID.to_string(),
                source: TerminalColorSchemeSource::Builtin,
                path: None,
                scheme: builtin_dark_scheme(),
            });
        }
        _ => {}
    }

    if id.starts_with("builtin:") || id.starts_with("legacy:") {
        return Err(missing_error(format!(
            "terminal color scheme {id} is not available"
        )));
    }
    let dir = ensure_terminal_color_scheme_dir(app)?;
    let path = scheme_path(&dir, id)?;
    if !path.exists() {
        return Err(missing_error(format!(
            "terminal color scheme {id} not found"
        )));
    }
    read_user_scheme_entry(&path)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn list_terminal_color_schemes(
    app: AppHandle,
) -> Result<Vec<TerminalColorSchemeEntry>> {
    list_terminal_color_scheme_entries(&app)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn read_terminal_color_scheme(
    app: AppHandle,
    id: String,
) -> Result<TerminalColorSchemeEntry> {
    terminal_color_scheme_by_id(&app, &id)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn create_terminal_color_scheme(
    app: AppHandle,
    input: TerminalColorSchemeInput,
) -> Result<TerminalColorSchemeEntry> {
    let dir = ensure_terminal_color_scheme_dir(&app)?;
    let mut scheme = input.scheme;
    if let Some(id) = input.id {
        scheme.id = normalize_user_scheme_id(&id)?;
    } else {
        scheme.id = normalize_user_scheme_id(&scheme.id)?;
    }
    let path = scheme_path(&dir, &scheme.id)?;
    if path.exists() {
        return Err(invalid_error(format!(
            "terminal color scheme {} already exists",
            scheme.id
        )));
    }
    write_user_scheme(&path, &scheme)?;
    config::emit_change(&app);
    read_user_scheme_entry(&path)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn update_terminal_color_scheme(
    app: AppHandle,
    input: TerminalColorSchemeInput,
) -> Result<TerminalColorSchemeEntry> {
    let dir = ensure_terminal_color_scheme_dir(&app)?;
    let old_id = input
        .id
        .as_deref()
        .ok_or_else(|| invalid_error("terminal color scheme id is required for update"))?;
    let old_id = normalize_user_scheme_id(old_id)?;
    let mut scheme = input.scheme;
    scheme.id = normalize_user_scheme_id(&scheme.id)?;
    let old_path = scheme_path(&dir, &old_id)?;
    if !old_path.exists() {
        return Err(missing_error(format!(
            "terminal color scheme {old_id} not found"
        )));
    }
    let new_path = scheme_path(&dir, &scheme.id)?;
    if old_path != new_path {
        if new_path.exists() {
            return Err(invalid_error(format!(
                "terminal color scheme {} already exists",
                scheme.id
            )));
        }
        fs::rename(&old_path, &new_path).map_err(io_error)?;
    }
    write_user_scheme(&new_path, &scheme)?;
    config::emit_change(&app);
    read_user_scheme_entry(&new_path)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn delete_terminal_color_scheme(app: AppHandle, id: String) -> Result<()> {
    let dir = ensure_terminal_color_scheme_dir(&app)?;
    let id = normalize_user_scheme_id(&id)?;
    let path = scheme_path(&dir, &id)?;
    if !path.exists() {
        return Err(missing_error(format!(
            "terminal color scheme {id} not found"
        )));
    }
    fs::remove_file(path).map_err(io_error)?;
    config::emit_change(&app);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn export_terminal_color_scheme(app: AppHandle, id: String) -> Result<String> {
    let entry = terminal_color_scheme_by_id(&app, &id)?;
    if let Some(path) = entry.path {
        return Ok(path);
    }
    let dir = ensure_terminal_color_scheme_dir(&app)?.join("exports");
    fs::create_dir_all(&dir).map_err(io_error)?;
    let export_id = id.replace(':', "-");
    let path = dir.join(format!("{export_id}.toml"));
    write_user_scheme(&path, &entry.scheme)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn export_terminal_color_scheme_to_path(
    app: AppHandle,
    input: TerminalColorSchemeExportInput,
) -> Result<String> {
    let entry = terminal_color_scheme_by_id(&app, &input.id)?;
    let path = PathBuf::from(input.path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    write_user_scheme(&path, &entry.scheme)?;
    Ok(path.to_string_lossy().into_owned())
}
