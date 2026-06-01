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

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ConnectionHostDocument {
    pub version: u32,
    pub id: String,
    pub name: String,
    pub folder: Option<String>,
    pub icon: Option<ConnectionHostIcon>,
    pub protocol: ConnectionProtocol,
    pub local: Option<LocalConnectionConfig>,
    pub ssh: Option<SshConnectionConfig>,
    pub telnet: Option<TelnetConnectionConfig>,
}

impl Default for ConnectionHostDocument {
    fn default() -> Self {
        Self {
            version: 1,
            id: String::new(),
            name: String::new(),
            folder: None,
            icon: None,
            protocol: ConnectionProtocol::Local,
            local: None,
            ssh: None,
            telnet: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ConnectionHostIcon {
    Catalog { name: String },
    Image { mime: String, data_base64: String },
    Svg { svg: String },
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
    pub openssh_config_files: Vec<String>,
    pub default_host: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ProfileEntry {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ConnectionHostEntry {
    pub id: String,
    pub path: Option<String>,
    pub source: ConnectionHostSource,
    pub read_only: bool,
    pub document: ConnectionHostDocument,
    pub diagnostics: Vec<ConnectionHostDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionProtocol {
    Local,
    Ssh,
    Telnet,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionHostSource {
    Virtual,
    User,
    OpenSshConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
pub struct LocalConnectionConfig {
    pub command: Option<String>,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SshConnectionConfig {
    pub hostname: String,
    pub port: u16,
    pub username: Option<String>,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
    pub forward_agent: bool,
    pub server_alive_interval: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TelnetConnectionConfig {
    pub hostname: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ConnectionHostDiagnostic {
    pub severity: ConnectionDiagnosticSeverity,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionDiagnosticSeverity {
    Warning,
    Error,
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
    pub hosts: Vec<ConnectionHostEntry>,
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
pub struct ConnectionHostDocumentInput {
    pub id: Option<String>,
    pub directory: Option<String>,
    pub folder: Option<String>,
    pub document: ConnectionHostDocument,
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
    pub window_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PaneContextMenuInput {
    pub x: f64,
    pub y: f64,
    pub pane_id: String,
    pub window_label: String,
    pub has_selection: bool,
    pub read_only: bool,
    pub has_multiple_panes: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PaneMenuEvent {
    pub action: PaneMenuAction,
    pub pane_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TerminalMenuStateInput {
    pub can_edit_text: bool,
    pub can_undo_text: bool,
    pub can_redo_text: bool,
    pub has_active_tab: bool,
    pub has_active_pane: bool,
    pub has_multiple_tabs: bool,
    pub has_multiple_panes: bool,
    pub has_selection: bool,
    pub can_paste: bool,
    pub can_paste_selection: bool,
    pub can_select_all: bool,
    pub can_jump_to_selection: bool,
    pub find_visible: bool,
    pub has_find_query: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PaneMenuAction {
    Copy,
    Paste,
    ResetTerminal,
    ToggleReadOnly,
    ChangeTabTitle,
    ZoomSplit,
    ClosePane,
    SplitLeft,
    SplitRight,
    SplitUp,
    SplitDown,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TerminalMenuEvent {
    pub command: TerminalMenuCommand,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TerminalMenuCommand {
    OpenCommandPalette,
    NewWindow,
    NewTab,
    SplitRight,
    SplitLeft,
    SplitDown,
    SplitUp,
    Close,
    CloseTab,
    CloseWindow,
    Undo,
    Redo,
    Copy,
    Paste,
    PasteSelection,
    SelectAll,
    Find,
    FindNext,
    FindPrevious,
    HideFindBar,
    UseSelectionForFind,
    JumpToSelection,
    ResetFontSize,
    IncreaseFontSize,
    DecreaseFontSize,
    ChangeTabTitle,
    ToggleReadOnly,
    Minimize,
    Zoom,
    Fill,
    Center,
    MoveResizeLeft,
    MoveResizeRight,
    MoveResizeTop,
    MoveResizeBottom,
    MoveResizeTopLeft,
    MoveResizeTopRight,
    MoveResizeBottomLeft,
    MoveResizeBottomRight,
    ToggleFullScreen,
    ShowPreviousTab,
    ShowNextTab,
    MoveTabToNewWindow,
    ZoomSplit,
    SelectPreviousSplit,
    SelectNextSplit,
    SelectSplitLeft,
    SelectSplitRight,
    SelectSplitUp,
    SelectSplitDown,
    ResizeSplitLeft,
    ResizeSplitRight,
    ResizeSplitUp,
    ResizeSplitDown,
    BringAllToFront,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TerminalTransportKind {
    Local,
    Ssh,
    Telnet,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TerminalTransportState {
    Resolving,
    Connecting,
    VerifyingHostKey,
    Authenticating,
    Connected,
    Disconnected,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CreateHostTerminalSessionInput {
    pub cols: u16,
    pub rows: u16,
    pub pixel_width: u16,
    pub pixel_height: u16,
    pub resolved_theme: Option<TerminalColorSchemeVariant>,
    pub cwd: Option<String>,
    pub connection_host_id: String,
    pub window_label: String,
    pub accept_new_host_key: bool,
    pub update_changed_host_key: bool,
    pub credential: Option<SshCredentialInput>,
    pub save_credential: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SshCredentialInput {
    pub kind: SshCredentialKind,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SshCredentialKind {
    Password,
    KeyPassphrase,
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
    pub transport: TerminalTransportKind,
    pub transport_state: TerminalTransportState,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ExistingTerminalSessionInput {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TerminalSessionOwnershipInput {
    pub session_ids: Vec<String>,
    pub window_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TerminalOutputBacklogInput {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TerminalOutputEvent {
    pub session_id: String,
    pub sequence: String,
    pub backlog: bool,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TerminalExitEvent {
    pub session_id: String,
    pub exit_code: Option<u32>,
    pub signal: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TerminalTransportStateEvent {
    pub session_id: String,
    pub state: TerminalTransportState,
}
