use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TerminalColorSchemeVariant {
    Light,
    Dark,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TerminalColorSchemeSource {
    Builtin,
    User,
    Legacy,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TerminalColorScheme {
    pub id: String,
    pub name: String,
    pub author: Option<String>,
    pub variant: TerminalColorSchemeVariant,
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
pub struct TerminalColorSchemeEntry {
    pub id: String,
    pub source: TerminalColorSchemeSource,
    pub path: Option<String>,
    pub scheme: TerminalColorScheme,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TerminalColorSchemeInput {
    pub id: Option<String>,
    pub scheme: TerminalColorScheme,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TerminalColorSchemeExportInput {
    pub id: String,
    pub path: String,
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
pub struct ConfigKeyPathInput {
    pub target: ConfigDocumentTarget,
    pub profile: Option<String>,
    pub path: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ConfigDocumentTarget {
    Main,
    Profile,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TerminalRenderer {
    Dom,
    Webgl,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TerminalCursorStyle {
    Block,
    Underline,
    Bar,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TabBarOrientation {
    Horizontal,
    VerticalLeft,
    VerticalRight,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TabBarContextMenuInput {
    pub x: f64,
    pub y: f64,
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
pub struct TerminalPadding {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
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
    pub padding: TerminalPadding,
    pub tab_bar_orientation: TabBarOrientation,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TerminalSettingsInput {
    pub resolved_theme: Option<TerminalColorSchemeVariant>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CreateTerminalSessionInput {
    pub cols: u16,
    pub rows: u16,
    pub pixel_width: u16,
    pub pixel_height: u16,
    pub resolved_theme: Option<TerminalColorSchemeVariant>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TerminalSizeInput {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
    pub pixel_width: u16,
    pub pixel_height: u16,
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
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub pixel_width: u16,
    pub pixel_height: u16,
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
