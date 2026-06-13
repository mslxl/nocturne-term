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
    pub files: Option<HostFilesConfig>,
    pub resources: Option<HostResourceConfig>,
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
            files: None,
            resources: None,
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

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
pub struct HostFilesConfig {
    pub default_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
pub struct HostResourceConfig {
    pub target_os: Option<RemoteResourceTargetOs>,
    pub target_arch: Option<RemoteResourceTargetArch>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum RemoteResourceTargetOs {
    Linux,
    Macos,
    Windows,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum RemoteResourceTargetArch {
    X86_64,
    Aarch64,
    Armv7,
    I686,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceToolKind {
    Files,
    Terminal,
    Transfers,
    Resources,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceDockDirection {
    Row,
    Column,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceDockSide {
    Left,
    Right,
    Up,
    Down,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceDockGroupRole {
    Content,
    Sidebar,
    Panel,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkspaceToolSlot {
    Owned {
        id: String,
        tool_tab_id: String,
    },
    Mirror {
        id: String,
        tool_tab_id: String,
        owner_workspace_id: String,
    },
    FloatingPlaceholder {
        id: String,
        tool_tab_id: String,
        floating_window_id: String,
    },
    ClosedSource {
        id: String,
        previous_title: String,
        owner_workspace_title: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkspaceDockLayout {
    Split {
        direction: WorkspaceDockDirection,
        children: Vec<WorkspaceDockLayout>,
        ratios: Vec<f64>,
    },
    Group {
        id: String,
        role: WorkspaceDockGroupRole,
        slots: Vec<WorkspaceToolSlot>,
        active_slot_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct WorkspaceToolTab {
    pub id: String,
    pub kind: WorkspaceToolKind,
    pub owner_workspace_id: String,
    pub host_id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct WorkspaceTabState {
    pub id: String,
    pub host_id: String,
    pub title: String,
    pub owned_tool_tab_ids: Vec<String>,
    pub layout: WorkspaceDockLayout,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct WorkspaceFloatingWindowState {
    pub id: String,
    pub layout: WorkspaceDockLayout,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct WorkspaceLayoutSnapshot {
    pub version: u32,
    pub active_workspace_id: String,
    pub workspaces: Vec<WorkspaceTabState>,
    pub tool_tabs: Vec<WorkspaceToolTab>,
    pub floating_windows: Vec<WorkspaceFloatingWindowState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct WorkspaceDispatchInput {
    pub expected_version: u32,
    pub intent: WorkspaceIntent,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AppMenuRoot {
    File,
    Edit,
    View,
    Window,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AppMenuPopupInput {
    pub root: AppMenuRoot,
    pub window_label: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkspaceIntent {
    CreateWorkspace {
        host_id: String,
    },
    ActivateWorkspace {
        workspace_id: String,
    },
    RenameWorkspace {
        workspace_id: String,
        title: String,
    },
    CloseWorkspace {
        workspace_id: String,
    },
    CloseOtherWorkspaces {
        workspace_id: String,
    },
    CloseWorkspacesToRight {
        workspace_id: String,
    },
    ActivateToolSlot {
        workspace_id: String,
        slot_id: String,
    },
    CloseToolSlot {
        workspace_id: String,
        slot_id: String,
    },
    CloseOtherToolSlots {
        workspace_id: String,
        slot_id: String,
    },
    CloseToolSlotsToRight {
        workspace_id: String,
        slot_id: String,
    },
    MirrorToolTab {
        source_tool_tab_id: String,
        target_workspace_id: String,
        target_group_id: String,
    },
    FloatToolSlot {
        workspace_id: String,
        slot_id: String,
    },
    CloseFloatingWindow {
        floating_window_id: String,
    },
    MoveToolSlotToGroup {
        workspace_id: String,
        slot_id: String,
        target_group_id: String,
    },
    MoveToolSlotToSplit {
        workspace_id: String,
        slot_id: String,
        target_slot_id: String,
        side: WorkspaceDockSide,
    },
    MoveToolSlotToWorkspaceEdge {
        workspace_id: String,
        slot_id: String,
        side: WorkspaceDockSide,
    },
    SplitToolSlot {
        workspace_id: String,
        target_slot_id: String,
        tool_tab_id: String,
        side: WorkspaceDockSide,
    },
    CreateTerminalToolTab {
        workspace_id: String,
        target_group_id: Option<String>,
    },
    OpenResourceMonitorToolTab {
        workspace_id: String,
        target_group_id: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct WorkspaceChangedEvent {
    pub version: u32,
    pub reason: String,
    pub snapshot: WorkspaceLayoutSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum FileProviderKind {
    Local,
    Sftp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum FileEntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FileProviderCapabilities {
    pub can_read: bool,
    pub can_write: bool,
    pub can_rename: bool,
    pub can_delete: bool,
    pub can_trash: bool,
    pub can_chmod: bool,
    pub can_symlink: bool,
    pub can_watch: bool,
    pub can_search_by_name: bool,
    pub can_search_content: bool,
    pub can_upload_helper: bool,
    pub supports_server_side_copy: bool,
    pub supports_atomic_rename: bool,
    pub supports_metadata_owner_group: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FileProviderInfo {
    pub kind: FileProviderKind,
    pub host_id: String,
    pub root_path: String,
    pub current_path: String,
    pub capabilities: FileProviderCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: FileEntryKind,
    pub size: Option<String>,
    pub modified_unix_ms: Option<String>,
    pub permissions: Option<String>,
    pub owner: Option<String>,
    pub group: Option<String>,
    pub symlink_target: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FileListInput {
    pub workspace_id: String,
    pub tool_tab_id: String,
    pub path: Option<String>,
    pub accept_new_host_key: bool,
    pub update_changed_host_key: bool,
    pub credential: Option<SshCredentialInput>,
    pub save_credential: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FileListResult {
    pub provider: FileProviderInfo,
    pub entries: Vec<FileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FilePathInput {
    pub workspace_id: String,
    pub tool_tab_id: String,
    pub path: String,
    pub accept_new_host_key: bool,
    pub update_changed_host_key: bool,
    pub credential: Option<SshCredentialInput>,
    pub save_credential: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FileTrashInfoInput {
    pub workspace_id: String,
    pub tool_tab_id: String,
    pub accept_new_host_key: bool,
    pub update_changed_host_key: bool,
    pub credential: Option<SshCredentialInput>,
    pub save_credential: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FileTrashInfo {
    pub available: bool,
    pub home_path: String,
    pub files_path: Option<String>,
    pub info_path: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RemoteSearchHelperInput {
    pub workspace_id: String,
    pub tool_tab_id: String,
    pub accept_new_host_key: bool,
    pub update_changed_host_key: bool,
    pub credential: Option<SshCredentialInput>,
    pub save_credential: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RemoteSearchHelperInfo {
    pub available: bool,
    pub provider_label: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FileCreateDirectoryInput {
    pub workspace_id: String,
    pub tool_tab_id: String,
    pub parent_path: String,
    pub name: String,
    pub accept_new_host_key: bool,
    pub update_changed_host_key: bool,
    pub credential: Option<SshCredentialInput>,
    pub save_credential: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FileRenameInput {
    pub workspace_id: String,
    pub tool_tab_id: String,
    pub source_path: String,
    pub destination_path: String,
    pub accept_new_host_key: bool,
    pub update_changed_host_key: bool,
    pub credential: Option<SshCredentialInput>,
    pub save_credential: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FileChmodInput {
    pub workspace_id: String,
    pub tool_tab_id: String,
    pub path: String,
    pub mode: String,
    pub accept_new_host_key: bool,
    pub update_changed_host_key: bool,
    pub credential: Option<SshCredentialInput>,
    pub save_credential: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FilePreviewInput {
    pub workspace_id: String,
    pub tool_tab_id: String,
    pub path: String,
    pub text_limit_bytes: u32,
    pub image_limit_bytes: u32,
    pub accept_new_host_key: bool,
    pub update_changed_host_key: bool,
    pub credential: Option<SshCredentialInput>,
    pub save_credential: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FilePreviewContent {
    Text { text: String },
    Image { mime: String, data_base64: String },
    Unsupported { reason: String },
    TooLarge { limit_bytes: u32 },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FilePreviewResult {
    pub path: String,
    pub name: String,
    pub entry_kind: FileEntryKind,
    pub size: Option<String>,
    pub modified_unix_ms: Option<String>,
    pub permissions: Option<String>,
    pub content: FilePreviewContent,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum FileSearchMode {
    Name,
    Content,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FileSearchInput {
    pub workspace_id: String,
    pub tool_tab_id: String,
    pub root_path: String,
    pub query: String,
    pub mode: FileSearchMode,
    pub include_hidden: bool,
    pub ignore_ignore_files: bool,
    pub follow_symlinks: bool,
    pub max_results: u32,
    pub accept_new_host_key: bool,
    pub update_changed_host_key: bool,
    pub credential: Option<SshCredentialInput>,
    pub save_credential: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FileSearchMatchRange {
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FileSearchMatch {
    pub path: String,
    pub name: String,
    pub kind: FileEntryKind,
    pub line_number: Option<u32>,
    pub line_text: Option<String>,
    pub ranges: Vec<FileSearchMatchRange>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FileSearchResult {
    pub provider_label: String,
    pub root_path: String,
    pub query: String,
    pub matches: Vec<FileSearchMatch>,
    pub diagnostics: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TransferEndpointKind {
    Local,
    Provider,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TransferEndpoint {
    pub kind: TransferEndpointKind,
    pub provider_kind: Option<FileProviderKind>,
    pub host_id: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TransferTaskStatus {
    Queued,
    Running,
    Failed,
    Completed,
    Canceled,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TransferTask {
    pub id: String,
    pub source: TransferEndpoint,
    pub destination: TransferEndpoint,
    pub initiator_workspace_id: Option<String>,
    pub related_workspace_ids: Vec<String>,
    pub status: TransferTaskStatus,
    pub bytes_total: Option<String>,
    pub bytes_done: String,
    pub error: Option<String>,
    pub created_at_unix_ms: String,
    pub updated_at_unix_ms: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TransferQueueSnapshot {
    pub version: u32,
    pub tasks: Vec<TransferTask>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TransferCreateInput {
    pub source: TransferEndpoint,
    pub destination: TransferEndpoint,
    pub initiator_workspace_id: Option<String>,
    pub related_workspace_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TransferTaskInput {
    pub task_id: String,
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
pub enum ResourceRefreshInterval {
    OneSecond,
    TwoSeconds,
    FiveSeconds,
    TenSeconds,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ResourceSettings {
    pub default_refresh_interval: ResourceRefreshInterval,
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
    WaitingForWorkspaceVerification,
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
    pub workspace_id: String,
    pub tool_tab_id: String,
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

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SshCredentialKind {
    Password,
    KeyPassphrase,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SshAuthTargetKind {
    ConnectionHost,
    ProxyJump,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SshAuthTarget {
    pub id: String,
    pub kind: SshAuthTargetKind,
    pub label: String,
    pub username: String,
    pub hostname: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SshCredentialChallenge {
    pub workspace_id: String,
    pub source_tool_tab_id: Option<String>,
    pub auth_target: SshAuthTarget,
    pub credential_kind: SshCredentialKind,
    pub identity_file: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SshHostKeyChallengeKind {
    Unknown,
    Changed,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SshHostKeyChallenge {
    pub workspace_id: String,
    pub source_tool_tab_id: Option<String>,
    pub auth_target: SshAuthTarget,
    pub challenge_kind: SshHostKeyChallengeKind,
    pub target: String,
    pub algorithm: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SshWorkspaceChallenge {
    Credential { challenge: SshCredentialChallenge },
    HostKey { challenge: SshHostKeyChallenge },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct WorkspaceSshVerificationRequiredEvent {
    pub workspace_id: String,
    pub verification_id: String,
    pub challenge: SshWorkspaceChallenge,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct WorkspaceSshVerificationSubmitInput {
    pub workspace_id: String,
    pub verification_id: String,
    pub response: WorkspaceSshVerificationResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkspaceSshVerificationResponse {
    Credential {
        credential: SshCredentialInput,
        save_credential: bool,
    },
    HostKey {
        accept_new_host_key: bool,
        update_changed_host_key: bool,
    },
    Cancel,
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
    pub error: Option<crate::error::ConfigError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TerminalTransportStateEvent {
    pub session_id: String,
    pub state: TerminalTransportState,
}
