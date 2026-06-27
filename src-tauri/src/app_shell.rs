#[cfg(target_os = "macos")]
use tauri::menu::AboutMetadata;
#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, EventTarget, LogicalPosition, Manager, PhysicalPosition, PhysicalSize,
    Runtime, Size, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent,
};
#[cfg(any(target_os = "windows", target_os = "linux"))]
use tauri_plugin_decorum::WebviewWindowExt;
#[cfg(target_os = "macos")]
use {
    objc2_app_kit::{NSView, NSWindow, NSWindowButton},
    objc2_foundation::{NSPoint, NSRect, NSSize},
};

use crate::{
    config,
    error::{invalid_error, Result},
    terminal,
    types::{
        AppMenuPopupInput, AppMenuRoot, TabBarContextMenuInput, TabBarOrientation,
        TerminalMenuCommand, TerminalMenuEvent, TerminalMenuStateInput,
    },
    workspace,
};
use std::{
    env,
    sync::{Mutex, OnceLock},
};

const MAIN_WINDOW_LABEL: &str = "main";
const SETTINGS_WINDOW_LABEL: &str = "settings";
const HOST_MANAGER_WINDOW_LABEL: &str = "hosts";
const PROFILE_NEW_DIALOG_LABEL: &str = "dialog-profile-new";
const PROFILE_DELETE_DIALOG_LABEL: &str = "dialog-profile-delete";
const MENU_SETTINGS: &str = "file.settings";
const MENU_COMMAND_PALETTE: &str = "file.command_palette";
const MENU_PROFILE_NEW: &str = "file.profile.new";
const MENU_PROFILE_EDIT: &str = "file.profile.edit";
const MENU_PROFILE_DELETE: &str = "file.profile.delete";
const PROFILE_SWITCH_PREFIX: &str = "file.profile.switch.";
const TAB_BAR_ORIENTATION_PREFIX: &str = "terminal.tab_bar_orientation.";
const TAB_BAR_ORIENTATION_HORIZONTAL: &str = "terminal.tab_bar_orientation.horizontal";
const TAB_BAR_ORIENTATION_VERTICAL_LEFT: &str = "terminal.tab_bar_orientation.vertical_left";
const TAB_BAR_ORIENTATION_VERTICAL_RIGHT: &str = "terminal.tab_bar_orientation.vertical_right";
const MENU_TERMINAL_PREFIX: &str = "terminal.menu.";
const MENU_NEW_WINDOW: &str = "terminal.menu.new_window";
const MENU_NEW_TAB: &str = "terminal.menu.new_tab";
const MENU_CLOSE: &str = "terminal.menu.close";
const MENU_CLOSE_TAB: &str = "terminal.menu.close_tab";
const MENU_CLOSE_WINDOW: &str = "terminal.menu.close_window";
const MENU_UNDO: &str = "terminal.menu.undo";
const MENU_REDO: &str = "terminal.menu.redo";
const MENU_COPY: &str = "terminal.menu.copy";
const MENU_PASTE: &str = "terminal.menu.paste";
const MENU_PASTE_SELECTION: &str = "terminal.menu.paste_selection";
const MENU_SELECT_ALL: &str = "terminal.menu.select_all";
const MENU_FIND: &str = "terminal.menu.find";
const MENU_FIND_NEXT: &str = "terminal.menu.find_next";
const MENU_FIND_PREVIOUS: &str = "terminal.menu.find_previous";
const MENU_HIDE_FIND_BAR: &str = "terminal.menu.hide_find_bar";
const MENU_USE_SELECTION_FOR_FIND: &str = "terminal.menu.use_selection_for_find";
const MENU_JUMP_TO_SELECTION: &str = "terminal.menu.jump_to_selection";
const MENU_RESET_FONT_SIZE: &str = "terminal.menu.reset_font_size";
const MENU_INCREASE_FONT_SIZE: &str = "terminal.menu.increase_font_size";
const MENU_DECREASE_FONT_SIZE: &str = "terminal.menu.decrease_font_size";
const MENU_CHANGE_TAB_TITLE: &str = "terminal.menu.change_tab_title";
const MENU_TOGGLE_READ_ONLY: &str = "terminal.menu.toggle_read_only";
const MENU_MINIMIZE: &str = "terminal.menu.minimize";
const MENU_ZOOM: &str = "terminal.menu.zoom";
const MENU_FILL: &str = "terminal.menu.fill";
const MENU_CENTER: &str = "terminal.menu.center";
const MENU_MOVE_RESIZE_LEFT: &str = "terminal.menu.move_resize_left";
const MENU_MOVE_RESIZE_RIGHT: &str = "terminal.menu.move_resize_right";
const MENU_MOVE_RESIZE_TOP: &str = "terminal.menu.move_resize_top";
const MENU_MOVE_RESIZE_BOTTOM: &str = "terminal.menu.move_resize_bottom";
const MENU_MOVE_RESIZE_TOP_LEFT: &str = "terminal.menu.move_resize_top_left";
const MENU_MOVE_RESIZE_TOP_RIGHT: &str = "terminal.menu.move_resize_top_right";
const MENU_MOVE_RESIZE_BOTTOM_LEFT: &str = "terminal.menu.move_resize_bottom_left";
const MENU_MOVE_RESIZE_BOTTOM_RIGHT: &str = "terminal.menu.move_resize_bottom_right";
const MENU_TOGGLE_FULL_SCREEN: &str = "terminal.menu.toggle_full_screen";
const MENU_SHOW_PREVIOUS_TAB: &str = "terminal.menu.show_previous_tab";
const MENU_SHOW_NEXT_TAB: &str = "terminal.menu.show_next_tab";
const MENU_MOVE_TAB_TO_NEW_WINDOW: &str = "terminal.menu.move_tab_to_new_window";
const MENU_BRING_ALL_TO_FRONT: &str = "terminal.menu.bring_all_to_front";
const SETTINGS_NAVIGATE_EVENT: &str = "settings://navigate";
const TERMINAL_MENU_EVENT: &str = "terminal://menu-command";
const DEFAULT_WINDOW_WIDTH: f64 = 960.0;
const DEFAULT_WINDOW_HEIGHT: f64 = 640.0;
const MIN_WINDOW_WIDTH: f64 = 540.0;
const MIN_WINDOW_HEIGHT: f64 = 360.0;
#[cfg(any(target_os = "windows", target_os = "linux"))]
const DECORUM_TITLEBAR_REFRESH_ATTEMPTS: usize = 24;
#[cfg(any(target_os = "windows", target_os = "linux"))]
const DECORUM_TITLEBAR_REFRESH_DELAY_MS: u64 = 100;
static LAST_FOCUSED_MAIN_WINDOW: OnceLock<Mutex<String>> = OnceLock::new();
#[cfg(any(target_os = "windows", target_os = "linux"))]
static DECORUM_TITLEBAR_WINDOWS: OnceLock<Mutex<std::collections::HashSet<String>>> =
    OnceLock::new();
#[cfg(target_os = "macos")]
const MACOS_TRAFFIC_LIGHT_X: f64 = 14.0;
#[cfg(target_os = "macos")]
const MACOS_TRAFFIC_LIGHT_CONTAINER_HEIGHT: f64 = 52.0;
#[cfg(target_os = "macos")]
const MACOS_TRAFFIC_LIGHT_BUTTON_Y: f64 = 23.0;

#[derive(Copy, Clone, PartialEq, Eq)]
enum UiLanguage {
    En,
    Zh,
}

struct MenuText {
    file: &'static str,
    edit: &'static str,
    view: &'static str,
    window: &'static str,
    new_window: &'static str,
    new_tab: &'static str,
    profile: &'static str,
    settings: &'static str,
    profile_new: &'static str,
    profile_edit: &'static str,
    profile_delete: &'static str,
    command_palette: &'static str,
    close: &'static str,
    close_tab: &'static str,
    close_window: &'static str,
    undo: &'static str,
    redo: &'static str,
    copy: &'static str,
    paste: &'static str,
    paste_selection: &'static str,
    select_all: &'static str,
    find_menu: &'static str,
    find: &'static str,
    find_next: &'static str,
    find_previous: &'static str,
    hide_find_bar: &'static str,
    use_selection_for_find: &'static str,
    jump_to_selection: &'static str,
    reset_font_size: &'static str,
    increase_font_size: &'static str,
    decrease_font_size: &'static str,
    change_tab_title: &'static str,
    toggle_read_only: &'static str,
    minimize: &'static str,
    zoom: &'static str,
    fill: &'static str,
    center: &'static str,
    move_resize: &'static str,
    move_resize_left: &'static str,
    move_resize_right: &'static str,
    move_resize_top: &'static str,
    move_resize_bottom: &'static str,
    move_resize_top_left: &'static str,
    move_resize_top_right: &'static str,
    move_resize_bottom_left: &'static str,
    move_resize_bottom_right: &'static str,
    toggle_full_screen: &'static str,
    show_previous_tab: &'static str,
    show_next_tab: &'static str,
    move_tab_to_new_window: &'static str,
    bring_all_to_front: &'static str,
    horizontal_tabs: &'static str,
    vertical_left_tabs: &'static str,
    vertical_right_tabs: &'static str,
    settings_title: &'static str,
    hosts_title: &'static str,
    new_profile_title: &'static str,
    delete_profile_title: &'static str,
}

fn menu_text(language: UiLanguage) -> MenuText {
    match language {
        UiLanguage::En => MenuText {
            file: "File",
            edit: "Edit",
            view: "View",
            window: "Window",
            new_window: "New Window",
            new_tab: "New Session",
            profile: "Profile",
            settings: "Settings...",
            profile_new: "New...",
            profile_edit: "Edit...",
            profile_delete: "Delete...",
            command_palette: "Command Palette...",
            close: "Close",
            close_tab: "Close Tab",
            close_window: "Close Window",
            undo: "Undo",
            redo: "Redo",
            copy: "Copy",
            paste: "Paste",
            paste_selection: "Paste Selection",
            select_all: "Select All",
            find_menu: "Find",
            find: "Find...",
            find_next: "Find Next",
            find_previous: "Find Previous",
            hide_find_bar: "Hide Find Bar",
            use_selection_for_find: "Use Selection for Find",
            jump_to_selection: "Jump to Selection",
            reset_font_size: "Reset Font Size",
            increase_font_size: "Increase Font Size",
            decrease_font_size: "Decrease Font Size",
            change_tab_title: "Change Tab Title...",
            toggle_read_only: "Toggle Terminal Read-only",
            minimize: "Minimize",
            zoom: "Zoom",
            fill: "Fill",
            center: "Center",
            move_resize: "Move & Resize",
            move_resize_left: "Left",
            move_resize_right: "Right",
            move_resize_top: "Top",
            move_resize_bottom: "Bottom",
            move_resize_top_left: "Top Left",
            move_resize_top_right: "Top Right",
            move_resize_bottom_left: "Bottom Left",
            move_resize_bottom_right: "Bottom Right",
            toggle_full_screen: "Toggle Full Screen",
            show_previous_tab: "Show Previous Tab",
            show_next_tab: "Show Next Tab",
            move_tab_to_new_window: "Move Tab to New Window",
            bring_all_to_front: "Bring All to Front",
            horizontal_tabs: "Horizontal Tabs",
            vertical_left_tabs: "Vertical Tabs on Left",
            vertical_right_tabs: "Vertical Tabs on Right",
            settings_title: "Nocturne Settings",
            hosts_title: "Nocturne Hosts",
            new_profile_title: "New Profile",
            delete_profile_title: "Delete Profile",
        },
        UiLanguage::Zh => MenuText {
            file: "文件",
            edit: "编辑",
            view: "显示",
            window: "窗口",
            new_window: "新建窗口",
            new_tab: "新建 Session",
            profile: "档案",
            settings: "设置...",
            profile_new: "新建...",
            profile_edit: "编辑...",
            profile_delete: "删除...",
            command_palette: "命令面板...",
            close: "关闭",
            close_tab: "关闭标签",
            close_window: "关闭窗口",
            undo: "撤销",
            redo: "重做",
            copy: "复制",
            paste: "粘贴",
            paste_selection: "粘贴选区",
            select_all: "全选",
            find_menu: "查找",
            find: "查找...",
            find_next: "查找下一个",
            find_previous: "查找上一个",
            hide_find_bar: "隐藏查找栏",
            use_selection_for_find: "使用选区查找",
            jump_to_selection: "跳转到选区",
            reset_font_size: "重置字号",
            increase_font_size: "增大字号",
            decrease_font_size: "减小字号",
            change_tab_title: "修改标签标题...",
            toggle_read_only: "切换终端只读",
            minimize: "最小化",
            zoom: "缩放",
            fill: "填满",
            center: "居中",
            move_resize: "移动与调整大小",
            move_resize_left: "左侧",
            move_resize_right: "右侧",
            move_resize_top: "顶部",
            move_resize_bottom: "底部",
            move_resize_top_left: "左上",
            move_resize_top_right: "右上",
            move_resize_bottom_left: "左下",
            move_resize_bottom_right: "右下",
            toggle_full_screen: "切换全屏",
            show_previous_tab: "显示上一个标签",
            show_next_tab: "显示下一个标签",
            move_tab_to_new_window: "将标签移到新窗口",
            bring_all_to_front: "全部置于前面",
            horizontal_tabs: "水平标签",
            vertical_left_tabs: "左侧标签",
            vertical_right_tabs: "右侧标签",
            settings_title: "Nocturne 设置",
            hosts_title: "Nocturne 主机",
            new_profile_title: "新建档案",
            delete_profile_title: "删除档案",
        },
    }
}

pub(crate) fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let root = config::ensure_layout(app).map_err(config_to_io)?;
    let profiles = config::list_profiles_impl_from_app(app).map_err(config_to_io)?;
    let labels = menu_text(resolve_ui_language(app));
    let keybindings = terminal_menu_keybindings(app);

    let new_window =
        terminal_menu_item(app, MENU_NEW_WINDOW, labels.new_window, Some("CmdOrCtrl+N"))?;
    let new_tab = terminal_menu_item(app, MENU_NEW_TAB, labels.new_tab, Some("CmdOrCtrl+T"))?;
    let close = terminal_menu_item(app, MENU_CLOSE, labels.close, Some("CmdOrCtrl+W"))?;
    let close_tab = terminal_menu_item(
        app,
        MENU_CLOSE_TAB,
        labels.close_tab,
        Some("CmdOrCtrl+Shift+W"),
    )?;
    let close_window = terminal_menu_item(
        app,
        MENU_CLOSE_WINDOW,
        labels.close_window,
        Some("CmdOrCtrl+Shift+Alt+W"),
    )?;
    let settings = MenuItem::with_id(
        app,
        MENU_SETTINGS,
        labels.settings,
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let command_palette = terminal_menu_item(
        app,
        MENU_COMMAND_PALETTE,
        labels.command_palette,
        keybindings.open_command_palette.as_deref(),
    )?;
    let profile_new = MenuItem::with_id(
        app,
        MENU_PROFILE_NEW,
        labels.profile_new,
        true,
        None::<&str>,
    )?;
    let profile_edit = MenuItem::with_id(
        app,
        MENU_PROFILE_EDIT,
        labels.profile_edit,
        true,
        None::<&str>,
    )?;
    let profile_delete = MenuItem::with_id(
        app,
        MENU_PROFILE_DELETE,
        labels.profile_delete,
        true,
        None::<&str>,
    )?;
    let separator_profile = PredefinedMenuItem::separator(app)?;

    let mut profile_items: Vec<CheckMenuItem<R>> = Vec::new();
    for profile in profiles {
        profile_items.push(CheckMenuItem::with_id(
            app,
            format!("{PROFILE_SWITCH_PREFIX}{}", profile.name),
            &profile.name,
            true,
            profile.name == root.active_profile,
            None::<&str>,
        )?);
    }

    let mut profile_children: Vec<&dyn tauri::menu::IsMenuItem<R>> = vec![
        &profile_new,
        &profile_delete,
        &profile_edit,
        &separator_profile,
    ];
    for item in &profile_items {
        profile_children.push(item);
    }

    let profile_menu = Submenu::with_items(app, labels.profile, true, &profile_children)?;
    let file_sep1 = PredefinedMenuItem::separator(app)?;
    let file_sep2 = PredefinedMenuItem::separator(app)?;
    let file_sep3 = PredefinedMenuItem::separator(app)?;
    let file = Submenu::with_items(
        app,
        labels.file,
        true,
        &[
            &new_window,
            &new_tab,
            &file_sep1,
            &close,
            &close_tab,
            &close_window,
            &file_sep3,
            &command_palette,
            &settings,
            &profile_menu,
        ],
    )?;

    let undo = terminal_menu_item(app, MENU_UNDO, labels.undo, Some("CmdOrCtrl+Z"))?;
    let redo = terminal_menu_item(app, MENU_REDO, labels.redo, Some("CmdOrCtrl+Shift+Z"))?;
    let copy = terminal_menu_item(app, MENU_COPY, labels.copy, Some("CmdOrCtrl+C"))?;
    let paste = terminal_menu_item(app, MENU_PASTE, labels.paste, Some("CmdOrCtrl+V"))?;
    let paste_selection = terminal_menu_item_enabled(
        app,
        MENU_PASTE_SELECTION,
        labels.paste_selection,
        false,
        None::<&str>,
    )?;
    let select_all =
        terminal_menu_item(app, MENU_SELECT_ALL, labels.select_all, Some("CmdOrCtrl+A"))?;
    let find = terminal_menu_item(app, MENU_FIND, labels.find, keybindings.find.as_deref())?;
    let find_next = terminal_menu_item(
        app,
        MENU_FIND_NEXT,
        labels.find_next,
        keybindings.find_next.as_deref(),
    )?;
    let find_previous = terminal_menu_item(
        app,
        MENU_FIND_PREVIOUS,
        labels.find_previous,
        keybindings.find_previous.as_deref(),
    )?;
    let hide_find_bar =
        terminal_menu_item(app, MENU_HIDE_FIND_BAR, labels.hide_find_bar, None::<&str>)?;
    let use_selection_for_find = terminal_menu_item(
        app,
        MENU_USE_SELECTION_FOR_FIND,
        labels.use_selection_for_find,
        Some("CmdOrCtrl+E"),
    )?;
    let jump_to_selection = terminal_menu_item(
        app,
        MENU_JUMP_TO_SELECTION,
        labels.jump_to_selection,
        Some("CmdOrCtrl+J"),
    )?;
    let find_menu = Submenu::with_items(
        app,
        labels.find_menu,
        true,
        &[
            &find,
            &find_next,
            &find_previous,
            &hide_find_bar,
            &use_selection_for_find,
            &jump_to_selection,
        ],
    )?;
    let edit_sep1 = PredefinedMenuItem::separator(app)?;
    let edit_sep2 = PredefinedMenuItem::separator(app)?;
    let edit_sep3 = PredefinedMenuItem::separator(app)?;
    let edit = Submenu::with_items(
        app,
        labels.edit,
        true,
        &[
            &undo,
            &redo,
            &edit_sep1,
            &copy,
            &paste,
            &paste_selection,
            &select_all,
            &edit_sep2,
            &find_menu,
            &edit_sep3,
        ],
    )?;

    let reset_font_size = terminal_menu_item(
        app,
        MENU_RESET_FONT_SIZE,
        labels.reset_font_size,
        Some("CmdOrCtrl+0"),
    )?;
    let increase_font_size = terminal_menu_item(
        app,
        MENU_INCREASE_FONT_SIZE,
        labels.increase_font_size,
        Some("CmdOrCtrl+="),
    )?;
    let decrease_font_size = terminal_menu_item(
        app,
        MENU_DECREASE_FONT_SIZE,
        labels.decrease_font_size,
        Some("CmdOrCtrl+-"),
    )?;
    let change_tab_title = terminal_menu_item(
        app,
        MENU_CHANGE_TAB_TITLE,
        labels.change_tab_title,
        None::<&str>,
    )?;
    let toggle_read_only = terminal_menu_item(
        app,
        MENU_TOGGLE_READ_ONLY,
        labels.toggle_read_only,
        None::<&str>,
    )?;
    let view_sep = PredefinedMenuItem::separator(app)?;
    let view = Submenu::with_items(
        app,
        labels.view,
        true,
        &[
            &reset_font_size,
            &increase_font_size,
            &decrease_font_size,
            &view_sep,
            &change_tab_title,
            &toggle_read_only,
        ],
    )?;

    let minimize = terminal_menu_item(app, MENU_MINIMIZE, labels.minimize, Some("CmdOrCtrl+M"))?;
    let zoom = terminal_menu_item(app, MENU_ZOOM, labels.zoom, None::<&str>)?;
    let fill = terminal_menu_item(app, MENU_FILL, labels.fill, None::<&str>)?;
    let center = terminal_menu_item(app, MENU_CENTER, labels.center, None::<&str>)?;
    let move_resize_left = terminal_menu_item(
        app,
        MENU_MOVE_RESIZE_LEFT,
        labels.move_resize_left,
        None::<&str>,
    )?;
    let move_resize_right = terminal_menu_item(
        app,
        MENU_MOVE_RESIZE_RIGHT,
        labels.move_resize_right,
        None::<&str>,
    )?;
    let move_resize_top = terminal_menu_item(
        app,
        MENU_MOVE_RESIZE_TOP,
        labels.move_resize_top,
        None::<&str>,
    )?;
    let move_resize_bottom = terminal_menu_item(
        app,
        MENU_MOVE_RESIZE_BOTTOM,
        labels.move_resize_bottom,
        None::<&str>,
    )?;
    let move_resize_top_left = terminal_menu_item(
        app,
        MENU_MOVE_RESIZE_TOP_LEFT,
        labels.move_resize_top_left,
        None::<&str>,
    )?;
    let move_resize_top_right = terminal_menu_item(
        app,
        MENU_MOVE_RESIZE_TOP_RIGHT,
        labels.move_resize_top_right,
        None::<&str>,
    )?;
    let move_resize_bottom_left = terminal_menu_item(
        app,
        MENU_MOVE_RESIZE_BOTTOM_LEFT,
        labels.move_resize_bottom_left,
        None::<&str>,
    )?;
    let move_resize_bottom_right = terminal_menu_item(
        app,
        MENU_MOVE_RESIZE_BOTTOM_RIGHT,
        labels.move_resize_bottom_right,
        None::<&str>,
    )?;
    let move_resize_menu = Submenu::with_items(
        app,
        labels.move_resize,
        true,
        &[
            &move_resize_left,
            &move_resize_right,
            &move_resize_top,
            &move_resize_bottom,
            &move_resize_top_left,
            &move_resize_top_right,
            &move_resize_bottom_left,
            &move_resize_bottom_right,
        ],
    )?;
    let toggle_full_screen = terminal_menu_item(
        app,
        MENU_TOGGLE_FULL_SCREEN,
        labels.toggle_full_screen,
        Some("CmdOrCtrl+Ctrl+F"),
    )?;
    let show_previous_tab = terminal_menu_item(
        app,
        MENU_SHOW_PREVIOUS_TAB,
        labels.show_previous_tab,
        Some("CmdOrCtrl+Shift+["),
    )?;
    let show_next_tab = terminal_menu_item(
        app,
        MENU_SHOW_NEXT_TAB,
        labels.show_next_tab,
        Some("CmdOrCtrl+Shift+]"),
    )?;
    let move_tab_to_new_window = terminal_menu_item(
        app,
        MENU_MOVE_TAB_TO_NEW_WINDOW,
        labels.move_tab_to_new_window,
        None::<&str>,
    )?;
    let bring_all_to_front = terminal_menu_item(
        app,
        MENU_BRING_ALL_TO_FRONT,
        labels.bring_all_to_front,
        None::<&str>,
    )?;
    let window_sep1 = PredefinedMenuItem::separator(app)?;
    let window_sep2 = PredefinedMenuItem::separator(app)?;
    let window_sep3 = PredefinedMenuItem::separator(app)?;
    let window_sep4 = PredefinedMenuItem::separator(app)?;
    let window = Submenu::with_items(
        app,
        labels.window,
        true,
        &[
            &minimize,
            &zoom,
            &fill,
            &center,
            &move_resize_menu,
            &window_sep1,
            &toggle_full_screen,
            &window_sep2,
            &show_previous_tab,
            &show_next_tab,
            &move_tab_to_new_window,
            &window_sep3,
            &bring_all_to_front,
        ],
    )?;

    #[cfg(target_os = "macos")]
    {
        let app_menu = macos_application_menu(app)?;
        Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])
    }
    #[cfg(not(target_os = "macos"))]
    {
        Menu::with_items(app, &[&file, &edit, &view, &window])
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn build_bootstrap_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let labels = menu_text(default_ui_language());

    let new_window =
        terminal_menu_item(app, MENU_NEW_WINDOW, labels.new_window, Some("CmdOrCtrl+N"))?;
    let new_tab = terminal_menu_item(app, MENU_NEW_TAB, labels.new_tab, Some("CmdOrCtrl+T"))?;
    let command_palette = terminal_menu_item(
        app,
        MENU_COMMAND_PALETTE,
        labels.command_palette,
        Some("CmdOrCtrl+Shift+P"),
    )?;
    let settings = MenuItem::with_id(
        app,
        MENU_SETTINGS,
        labels.settings,
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let file_sep = PredefinedMenuItem::separator(app)?;
    let file = Submenu::with_items(
        app,
        labels.file,
        true,
        &[
            &new_window,
            &new_tab,
            &file_sep,
            &command_palette,
            &settings,
        ],
    )?;

    let copy = terminal_menu_item(app, MENU_COPY, labels.copy, Some("CmdOrCtrl+C"))?;
    let paste = terminal_menu_item(app, MENU_PASTE, labels.paste, Some("CmdOrCtrl+V"))?;
    let select_all =
        terminal_menu_item(app, MENU_SELECT_ALL, labels.select_all, Some("CmdOrCtrl+A"))?;
    let edit = Submenu::with_items(app, labels.edit, true, &[&copy, &paste, &select_all])?;

    let view = Submenu::with_items(app, labels.view, true, &[])?;

    let minimize = terminal_menu_item(app, MENU_MINIMIZE, labels.minimize, Some("CmdOrCtrl+M"))?;
    let zoom = terminal_menu_item(app, MENU_ZOOM, labels.zoom, None::<&str>)?;
    let bring_all_to_front = terminal_menu_item(
        app,
        MENU_BRING_ALL_TO_FRONT,
        labels.bring_all_to_front,
        None::<&str>,
    )?;
    let window = Submenu::with_items(
        app,
        labels.window,
        true,
        &[&minimize, &zoom, &bring_all_to_front],
    )?;

    let app_menu = macos_application_menu(app)?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])
}

#[cfg(target_os = "macos")]
fn macos_application_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    let package = app.package_info();
    let config = app.config();
    let about = AboutMetadata {
        name: Some(package.name.clone()),
        version: Some(package.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    };
    let about = PredefinedMenuItem::about(app, None, Some(about))?;
    let separator1 = PredefinedMenuItem::separator(app)?;
    let services = PredefinedMenuItem::services(app, None)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let hide = PredefinedMenuItem::hide(app, None)?;
    let hide_others = PredefinedMenuItem::hide_others(app, None)?;
    let separator3 = PredefinedMenuItem::separator(app)?;
    let quit = PredefinedMenuItem::quit(app, None)?;

    Submenu::with_items(
        app,
        package.name.clone(),
        true,
        &[
            &about,
            &separator1,
            &services,
            &separator2,
            &hide,
            &hide_others,
            &separator3,
            &quit,
        ],
    )
}

pub(crate) fn handle_menu_event(app: &AppHandle, id: &str) {
    let result = if id == MENU_SETTINGS {
        spawn_app_shell_action(app, "open settings window from menu", |app| {
            open_settings(&app, "main")
        })
    } else if id == MENU_COMMAND_PALETTE {
        handle_terminal_menu(app, id)
    } else if id == MENU_PROFILE_EDIT {
        spawn_app_shell_action(app, "open profile settings window from menu", |app| {
            open_settings(&app, "profile")
        })
    } else if id == MENU_PROFILE_NEW {
        spawn_app_shell_action(app, "open new profile dialog from menu", |app| {
            open_dialog(&app, DialogKind::ProfileNew)
        })
    } else if id == MENU_PROFILE_DELETE {
        spawn_app_shell_action(app, "open delete profile dialog from menu", |app| {
            open_dialog(&app, DialogKind::ProfileDelete)
        })
    } else if let Some(profile) = id.strip_prefix(PROFILE_SWITCH_PREFIX) {
        config::set_active_profile_impl(app, profile.to_string()).and_then(|_| refresh_menu(app))
    } else if let Some(placement) = id.strip_prefix(TAB_BAR_ORIENTATION_PREFIX) {
        let orientation = tab_bar_orientation_from_menu_id(placement);
        orientation.and_then(|value| config::set_effective_tab_bar_orientation(app, value))
    } else if id.starts_with(MENU_TERMINAL_PREFIX) {
        handle_terminal_menu(app, id)
    } else {
        Ok(())
    };

    if let Err(error) = result {
        eprintln!("menu action failed: {error}");
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn open_settings_window(app: AppHandle, mode: String) -> Result<()> {
    match mode.as_str() {
        "main" | "profile" => open_settings(&app, &mode),
        _ => Err(invalid_error(format!("unsupported settings mode: {mode}"))),
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn open_profile_new_dialog(app: AppHandle) -> Result<()> {
    open_dialog(&app, DialogKind::ProfileNew)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn open_host_manager_window(app: AppHandle) -> Result<()> {
    open_host_manager(&app)
}

pub(crate) fn handle_window_event(window: &Window, event: &WindowEvent) {
    if matches!(event, WindowEvent::Focused(true)) && is_main_window_label(window.label()) {
        let state =
            LAST_FOCUSED_MAIN_WINDOW.get_or_init(|| Mutex::new(MAIN_WINDOW_LABEL.to_string()));
        if let Ok(mut label) = state.lock() {
            *label = window.label().to_string();
        }
        #[cfg(target_os = "macos")]
        if let Ok(true) = integrated_titlebar_active(&window.app_handle()) {
            let _ = position_macos_window_traffic_lights(window);
        }
    } else if matches!(event, WindowEvent::Destroyed) && is_main_window_label(window.label()) {
        terminal::close_terminal_sessions_for_window(window.label());
        clear_last_focused_main_window(&window.app_handle(), window.label());
    } else if matches!(event, WindowEvent::Destroyed) {
        if let Some(floating_window_id) = floating_window_id_from_label(window.label()) {
            if let Err(error) =
                workspace::close_floating_window_by_id(&window.app_handle(), floating_window_id)
            {
                log::warn!(
                    "failed to close floating window mirror {floating_window_id} after window close: {error}"
                );
            }
        }
    }
}

pub(crate) fn apply_main_window_chrome<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    let integrated = integrated_titlebar_active(app)?;
    for window in app.webview_windows().values() {
        apply_integrated_titlebar_chrome(window, integrated);
    }
    Ok(())
}

fn apply_integrated_titlebar_chrome<R: Runtime>(window: &WebviewWindow<R>, _integrated: bool) {
    if !is_workspace_chrome_window_label(window.label()) {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        let style = if _integrated {
            TitleBarStyle::Overlay
        } else {
            TitleBarStyle::Visible
        };
        let title = if _integrated { "" } else { "Nocturne" };
        if let Err(error) = window.set_title_bar_style(style) {
            log::warn!(
                "failed to apply macOS integrated titlebar style to {}: {error}",
                window.label()
            );
            return;
        }
        if let Err(error) = window.set_title(title) {
            log::warn!(
                "failed to apply macOS integrated titlebar title to {}: {error}",
                window.label()
            );
            return;
        }
        if _integrated {
            if let Err(error) = position_macos_webview_traffic_lights(window) {
                log::warn!(
                    "failed to position macOS integrated titlebar traffic lights for {}: {error}",
                    window.label()
                );
                return;
            }
            schedule_macos_webview_traffic_light_position(window);
        }
    }
}

pub(crate) fn apply_initial_main_window_chrome<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        if integrated_titlebar_active(app)? {
            for window in app.webview_windows().values() {
                if is_workspace_chrome_window_label(window.label()) {
                    window.set_title("").map_err(to_config_error)?;
                    position_macos_webview_traffic_lights(window)?;
                    schedule_macos_webview_traffic_light_position(window);
                }
            }
            return Ok(());
        }
    }
    apply_main_window_chrome(app)
}

pub(crate) fn apply_initial_workspace_decorum_chrome(app: &AppHandle) -> Result<()> {
    let integrated = integrated_titlebar_active(app)?;
    for window in app.webview_windows().values() {
        if is_workspace_chrome_window_label(window.label()) {
            apply_workspace_decorum_chrome(window, integrated);
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn position_macos_webview_traffic_lights<R: Runtime>(window: &WebviewWindow<R>) -> Result<()> {
    let ns_window = window.ns_window().map_err(to_config_error)? as *mut NSWindow;
    position_macos_traffic_lights(ns_window)
}

#[cfg(target_os = "macos")]
fn schedule_macos_webview_traffic_light_position<R: Runtime>(window: &WebviewWindow<R>) {
    let window = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let window_for_main = window.clone();
        let _ = window.run_on_main_thread(move || {
            let _ = position_macos_webview_traffic_lights(&window_for_main);
        });
    });
}

#[cfg(target_os = "macos")]
fn position_macos_window_traffic_lights<R: Runtime>(window: &Window<R>) -> Result<()> {
    let ns_window = window.ns_window().map_err(to_config_error)? as *mut NSWindow;
    position_macos_traffic_lights(ns_window)
}

#[cfg(target_os = "macos")]
fn position_macos_traffic_lights(ns_window: *mut NSWindow) -> Result<()> {
    let Some(ns_window) = (unsafe { ns_window.as_ref() }) else {
        return Err(invalid_error(
            "main window native handle is not an NSWindow",
        ));
    };
    let Some(close) = ns_window.standardWindowButton(NSWindowButton::CloseButton) else {
        return Ok(());
    };
    let Some(miniaturize) = ns_window.standardWindowButton(NSWindowButton::MiniaturizeButton)
    else {
        return Ok(());
    };
    let zoom = ns_window.standardWindowButton(NSWindowButton::ZoomButton);
    let Some(title_bar_container_view) =
        (unsafe { close.superview() }).and_then(|view| unsafe { view.superview() })
    else {
        return Ok(());
    };
    let window_frame = ns_window.frame();
    title_bar_container_view.setFrame(NSRect::new(
        NSPoint::new(
            NSView::frame(&title_bar_container_view).origin.x,
            window_frame.size.height - MACOS_TRAFFIC_LIGHT_CONTAINER_HEIGHT,
        ),
        NSSize::new(
            NSView::frame(&title_bar_container_view).size.width,
            MACOS_TRAFFIC_LIGHT_CONTAINER_HEIGHT,
        ),
    ));
    let close_frame = NSView::frame(&close);
    let space_between = NSView::frame(&miniaturize).origin.x - close_frame.origin.x;

    for (index, button) in [Some(close), Some(miniaturize), zoom]
        .into_iter()
        .flatten()
        .enumerate()
    {
        let frame = NSView::frame(&button);
        button.setFrameOrigin(NSPoint::new(
            MACOS_TRAFFIC_LIGHT_X + (index as f64 * space_between),
            MACOS_TRAFFIC_LIGHT_BUTTON_Y,
        ));
        button.setFrameSize(frame.size);
    }
    Ok(())
}

fn integrated_titlebar_active<R: Runtime>(app: &AppHandle<R>) -> Result<bool> {
    Ok(config::effective_integrated_titlebar(app)? && config::effective_horizontal_tab_bar(app)?)
}

#[cfg(target_os = "macos")]
fn apply_main_window_builder_chrome<'a, R, M>(
    integrated: bool,
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M>
where
    R: Runtime,
    M: Manager<R>,
{
    if integrated {
        builder
            .title_bar_style(TitleBarStyle::Overlay)
            .hidden_title(true)
    } else {
        builder.title_bar_style(TitleBarStyle::Visible)
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn apply_main_window_builder_chrome<'a, R, M>(
    integrated: bool,
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M>
where
    R: Runtime,
    M: Manager<R>,
{
    builder.decorations(!integrated)
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn apply_main_window_builder_chrome<'a, R, M>(
    _integrated: bool,
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M>
where
    R: Runtime,
    M: Manager<R>,
{
    builder
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn apply_decorum_titlebar(window: &WebviewWindow, integrated: bool) {
    if !integrated {
        if let Err(error) = window.set_decorations(true) {
            log::warn!(
                "failed to restore standard titlebar decorations for {} after decorum was disabled: {error}",
                window.label()
            );
        }
        return;
    }

    let state =
        DECORUM_TITLEBAR_WINDOWS.get_or_init(|| Mutex::new(std::collections::HashSet::new()));
    let mut labels = match state.lock() {
        Ok(labels) => labels,
        Err(error) => {
            log::warn!(
                "failed to lock decorum integrated titlebar state for {}: {error}",
                window.label()
            );
            return;
        }
    };
    if !labels.insert(window.label().to_string()) {
        schedule_decorum_titlebar_refresh(window);
        return;
    }
    if let Err(error) = window.create_overlay_titlebar() {
        labels.remove(window.label());
        log::warn!(
            "failed to apply decorum integrated titlebar to {}: {error}; falling back to standard system titlebar",
            window.label()
        );
        if let Err(restore_error) = window.set_decorations(true) {
            log::warn!(
                "failed to restore standard titlebar decorations for {} after decorum error: {restore_error}",
                window.label()
            );
        }
    } else {
        schedule_decorum_titlebar_refresh(window);
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn apply_workspace_decorum_chrome(window: &WebviewWindow, integrated: bool) {
    apply_decorum_titlebar(window, integrated);
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn schedule_decorum_titlebar_refresh(window: &WebviewWindow) {
    let window = window.clone();
    std::thread::spawn(move || {
        for attempt in 0..DECORUM_TITLEBAR_REFRESH_ATTEMPTS {
            if let Err(error) = window.emit("decorum-page-load", ()) {
                log::warn!(
                    "failed to request decorum titlebar refresh for {}: {error}",
                    window.label()
                );
            }
            let script = r#"
                (() => {
                    const controls = document.querySelectorAll("[data-tauri-decorum-tb] .decorum-tb-btn");
                    if (controls.length >= 3) return true;
                    document.dispatchEvent(new Event("DOMContentLoaded"));
                    return document.querySelectorAll("[data-tauri-decorum-tb] .decorum-tb-btn").length >= 3;
                })();
            "#;
            match window.eval(script) {
                Ok(_) => {}
                Err(error) => log::warn!(
                    "failed to dispatch decorum titlebar bootstrap event for {}: {error}",
                    window.label()
                ),
            }
            if attempt + 1 < DECORUM_TITLEBAR_REFRESH_ATTEMPTS {
                std::thread::sleep(std::time::Duration::from_millis(
                    DECORUM_TITLEBAR_REFRESH_DELAY_MS,
                ));
            }
        }
    });
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn apply_workspace_decorum_chrome(_window: &WebviewWindow, _integrated: bool) {}

fn spawn_app_shell_action<R, F>(
    app: &AppHandle<R>,
    description: &'static str,
    action: F,
) -> Result<()>
where
    R: Runtime,
    F: FnOnce(AppHandle<R>) -> Result<()> + Send + 'static,
{
    let app = app.clone();
    std::thread::spawn(move || {
        log::debug!("{description} started");
        if let Err(error) = action(app) {
            log::warn!("{description} failed: {error}");
        }
        log::debug!("{description} finished");
    });
    Ok(())
}

fn clear_last_focused_main_window<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let Some(state) = LAST_FOCUSED_MAIN_WINDOW.get() else {
        return;
    };
    let Ok(mut current) = state.lock() else {
        return;
    };
    if current.as_str() == label {
        *current = fallback_main_window_label(app).unwrap_or_else(|| MAIN_WINDOW_LABEL.to_string());
    }
}

fn terminal_menu_item<R: Runtime, A: AsRef<str>>(
    app: &AppHandle<R>,
    id: &str,
    label: &str,
    accelerator: Option<A>,
) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(app, id, label, true, accelerator)
}

fn terminal_menu_item_enabled<R: Runtime, A: AsRef<str>>(
    app: &AppHandle<R>,
    id: &str,
    label: &str,
    enabled: bool,
    accelerator: Option<A>,
) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(app, id, label, enabled, accelerator)
}

struct TerminalMenuKeybindings {
    find: Option<String>,
    find_next: Option<String>,
    find_previous: Option<String>,
    open_command_palette: Option<String>,
}

fn terminal_menu_keybindings<R: Runtime>(app: &AppHandle<R>) -> TerminalMenuKeybindings {
    let is_macos = cfg!(target_os = "macos");
    let config = config::effective_application_config(app).ok();
    TerminalMenuKeybindings {
        find: terminal_accelerator(&config, "find", if is_macos { "Meta+F" } else { "Ctrl+F" }),
        find_next: terminal_accelerator(
            &config,
            "findNext",
            if is_macos { "Meta+G" } else { "Ctrl+G" },
        ),
        find_previous: terminal_accelerator(
            &config,
            "findPrevious",
            if is_macos {
                "Meta+Shift+G"
            } else {
                "Ctrl+Shift+G"
            },
        ),
        open_command_palette: terminal_accelerator(
            &config,
            "openCommandPalette",
            if is_macos {
                "Meta+Shift+P"
            } else {
                "Ctrl+Shift+P"
            },
        ),
    }
}

fn terminal_accelerator(
    config: &Option<toml::Value>,
    key: &str,
    default_value: &str,
) -> Option<String> {
    let configured = config
        .as_ref()
        .and_then(|config| config.get("keybindings"))
        .and_then(|keybindings| keybindings.as_table())
        .and_then(|keybindings| keybindings.get("terminal"))
        .and_then(|terminal| terminal.as_table())
        .and_then(|terminal| terminal.get(key))
        .and_then(|binding| binding.as_str())
        .unwrap_or(default_value);
    tauri_accelerator(configured)
}

fn tauri_accelerator(binding: &str) -> Option<String> {
    if binding.trim().is_empty() {
        return None;
    }
    Some(
        binding
            .split('+')
            .map(|part| match part.trim().to_lowercase().as_str() {
                "meta" | "cmd" | "command" => "CmdOrCtrl".to_string(),
                "ctrl" | "control" => "Ctrl".to_string(),
                "alt" | "option" => "Alt".to_string(),
                "shift" => "Shift".to_string(),
                key => key.to_uppercase(),
            })
            .collect::<Vec<_>>()
            .join("+"),
    )
}

fn handle_terminal_menu(app: &AppHandle, id: &str) -> Result<()> {
    match terminal_command_from_menu_id(id) {
        Some(TerminalMenuCommand::NewWindow) => open_main_window_route(app, None),
        Some(TerminalMenuCommand::CloseWindow) => focused_or_main_window(app)?
            .close()
            .map_err(to_config_error),
        Some(TerminalMenuCommand::Minimize) => focused_or_main_window(app)?
            .minimize()
            .map_err(to_config_error),
        Some(TerminalMenuCommand::Zoom) => toggle_zoom_window(&focused_or_main_window(app)?),
        Some(TerminalMenuCommand::Fill) => fill_window(&focused_or_main_window(app)?),
        Some(TerminalMenuCommand::Center) => focused_or_main_window(app)?
            .center()
            .map_err(to_config_error),
        Some(TerminalMenuCommand::MoveResizeLeft) => {
            move_resize_window(&focused_or_main_window(app)?, WindowPlacement::Left)
        }
        Some(TerminalMenuCommand::MoveResizeRight) => {
            move_resize_window(&focused_or_main_window(app)?, WindowPlacement::Right)
        }
        Some(TerminalMenuCommand::MoveResizeTop) => {
            move_resize_window(&focused_or_main_window(app)?, WindowPlacement::Top)
        }
        Some(TerminalMenuCommand::MoveResizeBottom) => {
            move_resize_window(&focused_or_main_window(app)?, WindowPlacement::Bottom)
        }
        Some(TerminalMenuCommand::MoveResizeTopLeft) => {
            move_resize_window(&focused_or_main_window(app)?, WindowPlacement::TopLeft)
        }
        Some(TerminalMenuCommand::MoveResizeTopRight) => {
            move_resize_window(&focused_or_main_window(app)?, WindowPlacement::TopRight)
        }
        Some(TerminalMenuCommand::MoveResizeBottomLeft) => {
            move_resize_window(&focused_or_main_window(app)?, WindowPlacement::BottomLeft)
        }
        Some(TerminalMenuCommand::MoveResizeBottomRight) => {
            move_resize_window(&focused_or_main_window(app)?, WindowPlacement::BottomRight)
        }
        Some(TerminalMenuCommand::ToggleFullScreen) => {
            toggle_fullscreen(&focused_or_main_window(app)?)
        }
        Some(TerminalMenuCommand::BringAllToFront) => bring_all_to_front(app),
        Some(command) => emit_terminal_menu_event(app, command),
        None => Ok(()),
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn open_main_window(app: AppHandle, route: Option<String>) -> Result<()> {
    open_main_window_route(&app, route.as_deref())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn open_workspace_floating_window(
    app: AppHandle,
    floating_window_id: String,
) -> Result<()> {
    if floating_window_id.trim().is_empty() {
        return Err(invalid_error("floating window id cannot be empty"));
    }
    let label = format!("workspace-floating-{floating_window_id}");
    if let Some(window) = app.get_webview_window(&label) {
        return focus_window(&window);
    }
    let builder = WebviewWindowBuilder::new(&app, label, WebviewUrl::App("".into()))
        .title("Nocturne")
        .inner_size(760.0, 520.0)
        .min_inner_size(420.0, 320.0)
        .resizable(true)
        .center();
    let builder = apply_main_window_builder_chrome(integrated_titlebar_active(&app)?, builder);
    let window = builder.build().map_err(to_config_error)?;
    apply_workspace_decorum_chrome(&window, integrated_titlebar_active(&app)?);
    focus_window(&window)
}

fn floating_window_id_from_label(label: &str) -> Option<&str> {
    label
        .strip_prefix("workspace-floating-")
        .filter(|id| !id.trim().is_empty())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn show_app_menu(app: AppHandle, input: AppMenuPopupInput) -> Result<()> {
    let menu = build_app_popup_menu(&app, input.root).map_err(to_config_error)?;
    let window = app
        .get_webview_window(&input.window_label)
        .ok_or_else(|| invalid_error(format!("window {} not found", input.window_label)))?;
    window
        .popup_menu_at(&menu, LogicalPosition::new(input.x, input.y))
        .map_err(to_config_error)
}

fn build_app_popup_menu<R: Runtime>(
    app: &AppHandle<R>,
    root: AppMenuRoot,
) -> tauri::Result<Menu<R>> {
    let labels = menu_text(resolve_ui_language(app));
    let keybindings = terminal_menu_keybindings(app);
    match root {
        AppMenuRoot::File => build_file_popup_menu(app, labels, &keybindings),
        AppMenuRoot::Edit => build_edit_popup_menu(app, labels, &keybindings),
        AppMenuRoot::View => build_view_popup_menu(app, labels),
        AppMenuRoot::Window => build_window_popup_menu(app, labels),
    }
}

fn build_file_popup_menu<R: Runtime>(
    app: &AppHandle<R>,
    labels: MenuText,
    keybindings: &TerminalMenuKeybindings,
) -> tauri::Result<Menu<R>> {
    let root = config::ensure_layout(app).map_err(config_to_io)?;
    let profiles = config::list_profiles_impl_from_app(app).map_err(config_to_io)?;
    let new_window =
        terminal_menu_item(app, MENU_NEW_WINDOW, labels.new_window, Some("CmdOrCtrl+N"))?;
    let new_tab = terminal_menu_item(app, MENU_NEW_TAB, labels.new_tab, Some("CmdOrCtrl+T"))?;
    let close = terminal_menu_item(app, MENU_CLOSE, labels.close, Some("CmdOrCtrl+W"))?;
    let close_tab = terminal_menu_item(
        app,
        MENU_CLOSE_TAB,
        labels.close_tab,
        Some("CmdOrCtrl+Shift+W"),
    )?;
    let close_window = terminal_menu_item(
        app,
        MENU_CLOSE_WINDOW,
        labels.close_window,
        Some("CmdOrCtrl+Shift+Alt+W"),
    )?;
    let command_palette = terminal_menu_item(
        app,
        MENU_COMMAND_PALETTE,
        labels.command_palette,
        keybindings.open_command_palette.as_deref(),
    )?;
    let settings = MenuItem::with_id(
        app,
        MENU_SETTINGS,
        labels.settings,
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let profile_new = MenuItem::with_id(
        app,
        MENU_PROFILE_NEW,
        labels.profile_new,
        true,
        None::<&str>,
    )?;
    let profile_edit = MenuItem::with_id(
        app,
        MENU_PROFILE_EDIT,
        labels.profile_edit,
        true,
        None::<&str>,
    )?;
    let profile_delete = MenuItem::with_id(
        app,
        MENU_PROFILE_DELETE,
        labels.profile_delete,
        true,
        None::<&str>,
    )?;
    let separator_profile = PredefinedMenuItem::separator(app)?;
    let mut profile_items: Vec<CheckMenuItem<R>> = Vec::new();
    for profile in profiles {
        profile_items.push(CheckMenuItem::with_id(
            app,
            format!("{PROFILE_SWITCH_PREFIX}{}", profile.name),
            &profile.name,
            true,
            profile.name == root.active_profile,
            None::<&str>,
        )?);
    }
    let mut profile_children: Vec<&dyn tauri::menu::IsMenuItem<R>> = vec![
        &profile_new,
        &profile_delete,
        &profile_edit,
        &separator_profile,
    ];
    for item in &profile_items {
        profile_children.push(item);
    }
    let profile_menu = Submenu::with_items(app, labels.profile, true, &profile_children)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    Menu::with_items(
        app,
        &[
            &new_window,
            &new_tab,
            &sep1,
            &close,
            &close_tab,
            &close_window,
            &sep3,
            &command_palette,
            &settings,
            &profile_menu,
        ],
    )
}

fn build_edit_popup_menu<R: Runtime>(
    app: &AppHandle<R>,
    labels: MenuText,
    keybindings: &TerminalMenuKeybindings,
) -> tauri::Result<Menu<R>> {
    let undo = terminal_menu_item(app, MENU_UNDO, labels.undo, Some("CmdOrCtrl+Z"))?;
    let redo = terminal_menu_item(app, MENU_REDO, labels.redo, Some("CmdOrCtrl+Shift+Z"))?;
    let copy = terminal_menu_item(app, MENU_COPY, labels.copy, Some("CmdOrCtrl+C"))?;
    let paste = terminal_menu_item(app, MENU_PASTE, labels.paste, Some("CmdOrCtrl+V"))?;
    let paste_selection = terminal_menu_item_enabled(
        app,
        MENU_PASTE_SELECTION,
        labels.paste_selection,
        false,
        None::<&str>,
    )?;
    let select_all =
        terminal_menu_item(app, MENU_SELECT_ALL, labels.select_all, Some("CmdOrCtrl+A"))?;
    let find = terminal_menu_item(app, MENU_FIND, labels.find, keybindings.find.as_deref())?;
    let find_next = terminal_menu_item(
        app,
        MENU_FIND_NEXT,
        labels.find_next,
        keybindings.find_next.as_deref(),
    )?;
    let find_previous = terminal_menu_item(
        app,
        MENU_FIND_PREVIOUS,
        labels.find_previous,
        keybindings.find_previous.as_deref(),
    )?;
    let hide_find_bar =
        terminal_menu_item(app, MENU_HIDE_FIND_BAR, labels.hide_find_bar, None::<&str>)?;
    let use_selection_for_find = terminal_menu_item(
        app,
        MENU_USE_SELECTION_FOR_FIND,
        labels.use_selection_for_find,
        Some("CmdOrCtrl+E"),
    )?;
    let jump_to_selection = terminal_menu_item(
        app,
        MENU_JUMP_TO_SELECTION,
        labels.jump_to_selection,
        Some("CmdOrCtrl+J"),
    )?;
    let find_menu = Submenu::with_items(
        app,
        labels.find_menu,
        true,
        &[
            &find,
            &find_next,
            &find_previous,
            &hide_find_bar,
            &use_selection_for_find,
            &jump_to_selection,
        ],
    )?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    Menu::with_items(
        app,
        &[
            &undo,
            &redo,
            &sep1,
            &copy,
            &paste,
            &paste_selection,
            &select_all,
            &sep2,
            &find_menu,
            &sep3,
        ],
    )
}

fn build_view_popup_menu<R: Runtime>(
    app: &AppHandle<R>,
    labels: MenuText,
) -> tauri::Result<Menu<R>> {
    let reset_font_size = terminal_menu_item(
        app,
        MENU_RESET_FONT_SIZE,
        labels.reset_font_size,
        Some("CmdOrCtrl+0"),
    )?;
    let increase_font_size = terminal_menu_item(
        app,
        MENU_INCREASE_FONT_SIZE,
        labels.increase_font_size,
        Some("CmdOrCtrl+="),
    )?;
    let decrease_font_size = terminal_menu_item(
        app,
        MENU_DECREASE_FONT_SIZE,
        labels.decrease_font_size,
        Some("CmdOrCtrl+-"),
    )?;
    let change_tab_title = terminal_menu_item(
        app,
        MENU_CHANGE_TAB_TITLE,
        labels.change_tab_title,
        None::<&str>,
    )?;
    let toggle_read_only = terminal_menu_item(
        app,
        MENU_TOGGLE_READ_ONLY,
        labels.toggle_read_only,
        None::<&str>,
    )?;
    let sep = PredefinedMenuItem::separator(app)?;
    Menu::with_items(
        app,
        &[
            &reset_font_size,
            &increase_font_size,
            &decrease_font_size,
            &sep,
            &change_tab_title,
            &toggle_read_only,
        ],
    )
}

fn build_window_popup_menu<R: Runtime>(
    app: &AppHandle<R>,
    labels: MenuText,
) -> tauri::Result<Menu<R>> {
    let minimize = terminal_menu_item(app, MENU_MINIMIZE, labels.minimize, Some("CmdOrCtrl+M"))?;
    let zoom = terminal_menu_item(app, MENU_ZOOM, labels.zoom, None::<&str>)?;
    let fill = terminal_menu_item(app, MENU_FILL, labels.fill, None::<&str>)?;
    let center = terminal_menu_item(app, MENU_CENTER, labels.center, None::<&str>)?;
    let move_resize_left = terminal_menu_item(
        app,
        MENU_MOVE_RESIZE_LEFT,
        labels.move_resize_left,
        None::<&str>,
    )?;
    let move_resize_right = terminal_menu_item(
        app,
        MENU_MOVE_RESIZE_RIGHT,
        labels.move_resize_right,
        None::<&str>,
    )?;
    let move_resize_top = terminal_menu_item(
        app,
        MENU_MOVE_RESIZE_TOP,
        labels.move_resize_top,
        None::<&str>,
    )?;
    let move_resize_bottom = terminal_menu_item(
        app,
        MENU_MOVE_RESIZE_BOTTOM,
        labels.move_resize_bottom,
        None::<&str>,
    )?;
    let move_resize_top_left = terminal_menu_item(
        app,
        MENU_MOVE_RESIZE_TOP_LEFT,
        labels.move_resize_top_left,
        None::<&str>,
    )?;
    let move_resize_top_right = terminal_menu_item(
        app,
        MENU_MOVE_RESIZE_TOP_RIGHT,
        labels.move_resize_top_right,
        None::<&str>,
    )?;
    let move_resize_bottom_left = terminal_menu_item(
        app,
        MENU_MOVE_RESIZE_BOTTOM_LEFT,
        labels.move_resize_bottom_left,
        None::<&str>,
    )?;
    let move_resize_bottom_right = terminal_menu_item(
        app,
        MENU_MOVE_RESIZE_BOTTOM_RIGHT,
        labels.move_resize_bottom_right,
        None::<&str>,
    )?;
    let move_resize_menu = Submenu::with_items(
        app,
        labels.move_resize,
        true,
        &[
            &move_resize_left,
            &move_resize_right,
            &move_resize_top,
            &move_resize_bottom,
            &move_resize_top_left,
            &move_resize_top_right,
            &move_resize_bottom_left,
            &move_resize_bottom_right,
        ],
    )?;
    let toggle_full_screen = terminal_menu_item(
        app,
        MENU_TOGGLE_FULL_SCREEN,
        labels.toggle_full_screen,
        Some("CmdOrCtrl+Ctrl+F"),
    )?;
    let show_previous_tab = terminal_menu_item(
        app,
        MENU_SHOW_PREVIOUS_TAB,
        labels.show_previous_tab,
        Some("CmdOrCtrl+Shift+["),
    )?;
    let show_next_tab = terminal_menu_item(
        app,
        MENU_SHOW_NEXT_TAB,
        labels.show_next_tab,
        Some("CmdOrCtrl+Shift+]"),
    )?;
    let move_tab_to_new_window = terminal_menu_item(
        app,
        MENU_MOVE_TAB_TO_NEW_WINDOW,
        labels.move_tab_to_new_window,
        None::<&str>,
    )?;
    let bring_all_to_front = terminal_menu_item(
        app,
        MENU_BRING_ALL_TO_FRONT,
        labels.bring_all_to_front,
        None::<&str>,
    )?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let sep4 = PredefinedMenuItem::separator(app)?;
    Menu::with_items(
        app,
        &[
            &minimize,
            &zoom,
            &fill,
            &center,
            &move_resize_menu,
            &sep1,
            &toggle_full_screen,
            &sep2,
            &show_previous_tab,
            &show_next_tab,
            &move_tab_to_new_window,
            &sep3,
            &bring_all_to_front,
        ],
    )
}

#[tauri::command]
#[specta::specta]
pub(crate) fn refresh_app_menu(app: AppHandle) -> Result<()> {
    refresh_menu(&app)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn update_terminal_menu_state(
    app: AppHandle,
    input: TerminalMenuStateInput,
) -> Result<()> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    let items = menu.items().map_err(to_config_error)?;
    set_menu_item_enabled(&items, MENU_NEW_TAB, true)?;
    set_menu_item_enabled(&items, MENU_CLOSE, input.has_active_tab)?;
    set_menu_item_enabled(&items, MENU_CLOSE_TAB, input.has_active_tab)?;
    set_menu_item_enabled(&items, MENU_UNDO, input.can_undo_text)?;
    set_menu_item_enabled(&items, MENU_REDO, input.can_redo_text)?;
    set_menu_item_enabled(&items, MENU_COPY, input.has_selection)?;
    set_menu_item_enabled(&items, MENU_PASTE, input.can_paste)?;
    set_menu_item_enabled(&items, MENU_PASTE_SELECTION, input.can_paste_selection)?;
    set_menu_item_enabled(&items, MENU_SELECT_ALL, input.can_select_all)?;
    set_menu_item_enabled(&items, MENU_FIND, input.has_active_tab)?;
    set_menu_item_enabled(
        &items,
        MENU_FIND_NEXT,
        input.has_active_tab && input.has_find_query,
    )?;
    set_menu_item_enabled(
        &items,
        MENU_FIND_PREVIOUS,
        input.has_active_tab && input.has_find_query,
    )?;
    set_menu_item_enabled(&items, MENU_HIDE_FIND_BAR, input.find_visible)?;
    set_menu_item_enabled(&items, MENU_USE_SELECTION_FOR_FIND, input.has_selection)?;
    set_menu_item_enabled(&items, MENU_JUMP_TO_SELECTION, input.can_jump_to_selection)?;
    set_menu_item_enabled(&items, MENU_RESET_FONT_SIZE, input.has_active_tab)?;
    set_menu_item_enabled(&items, MENU_INCREASE_FONT_SIZE, input.has_active_tab)?;
    set_menu_item_enabled(&items, MENU_DECREASE_FONT_SIZE, input.has_active_tab)?;
    set_menu_item_enabled(&items, MENU_CHANGE_TAB_TITLE, input.has_active_tab)?;
    set_menu_item_enabled(&items, MENU_TOGGLE_READ_ONLY, input.has_active_tab)?;
    set_menu_item_enabled(&items, MENU_SHOW_PREVIOUS_TAB, input.has_multiple_tabs)?;
    set_menu_item_enabled(&items, MENU_SHOW_NEXT_TAB, input.has_multiple_tabs)?;
    set_menu_item_enabled(&items, MENU_MOVE_TAB_TO_NEW_WINDOW, input.has_active_tab)?;
    Ok(())
}

fn set_menu_item_enabled<R: Runtime>(
    items: &[MenuItemKind<R>],
    id: &str,
    enabled: bool,
) -> Result<()> {
    let Some(item) = find_menu_item(items, id)? else {
        return Ok(());
    };
    match item {
        MenuItemKind::MenuItem(item) => item.set_enabled(enabled).map_err(to_config_error),
        MenuItemKind::Submenu(item) => item.set_enabled(enabled).map_err(to_config_error),
        MenuItemKind::Check(item) => item.set_enabled(enabled).map_err(to_config_error),
        MenuItemKind::Icon(item) => item.set_enabled(enabled).map_err(to_config_error),
        MenuItemKind::Predefined(_) => Ok(()),
    }
}

fn find_menu_item<R: Runtime>(
    items: &[MenuItemKind<R>],
    id: &str,
) -> Result<Option<MenuItemKind<R>>> {
    for item in items {
        if item.id() == id {
            return Ok(Some(item.clone()));
        }
        if let Some(submenu) = item.as_submenu() {
            let children = submenu.items().map_err(to_config_error)?;
            if let Some(child) = find_menu_item(&children, id)? {
                return Ok(Some(child));
            }
        }
    }
    Ok(None)
}

pub(crate) fn refresh_menu<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    let menu = build_menu(app).map_err(to_config_error)?;
    app.set_menu(menu).map_err(to_config_error)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn show_tab_bar_context_menu(
    app: AppHandle,
    input: TabBarContextMenuInput,
) -> Result<()> {
    let labels = menu_text(resolve_ui_language(&app));
    let settings = terminal::get_terminal_settings(app.clone())?;
    let horizontal = CheckMenuItem::with_id(
        &app,
        TAB_BAR_ORIENTATION_HORIZONTAL,
        labels.horizontal_tabs,
        true,
        settings.tab_bar_orientation == TabBarOrientation::Horizontal,
        None::<&str>,
    )
    .map_err(to_config_error)?;
    let vertical_left = CheckMenuItem::with_id(
        &app,
        TAB_BAR_ORIENTATION_VERTICAL_LEFT,
        labels.vertical_left_tabs,
        true,
        settings.tab_bar_orientation == TabBarOrientation::VerticalLeft,
        None::<&str>,
    )
    .map_err(to_config_error)?;
    let vertical_right = CheckMenuItem::with_id(
        &app,
        TAB_BAR_ORIENTATION_VERTICAL_RIGHT,
        labels.vertical_right_tabs,
        true,
        settings.tab_bar_orientation == TabBarOrientation::VerticalRight,
        None::<&str>,
    )
    .map_err(to_config_error)?;
    let menu = Menu::with_items(&app, &[&horizontal, &vertical_left, &vertical_right])
        .map_err(to_config_error)?;
    let window = app
        .get_webview_window(&input.window_label)
        .ok_or_else(|| invalid_error(format!("window {} not found", input.window_label)))?;
    window
        .popup_menu_at(&menu, LogicalPosition::new(input.x, input.y))
        .map_err(to_config_error)
}

fn tab_bar_orientation_from_menu_id(id: &str) -> Result<TabBarOrientation> {
    match id {
        "horizontal" => Ok(TabBarOrientation::Horizontal),
        "vertical_left" => Ok(TabBarOrientation::VerticalLeft),
        "vertical_right" => Ok(TabBarOrientation::VerticalRight),
        _ => Err(invalid_error(format!(
            "unsupported tab bar placement: {id}"
        ))),
    }
}

fn terminal_command_from_menu_id(id: &str) -> Option<TerminalMenuCommand> {
    match id {
        MENU_NEW_WINDOW => Some(TerminalMenuCommand::NewWindow),
        MENU_COMMAND_PALETTE => Some(TerminalMenuCommand::OpenCommandPalette),
        MENU_NEW_TAB => Some(TerminalMenuCommand::NewTab),
        MENU_CLOSE => Some(TerminalMenuCommand::Close),
        MENU_CLOSE_TAB => Some(TerminalMenuCommand::CloseTab),
        MENU_CLOSE_WINDOW => Some(TerminalMenuCommand::CloseWindow),
        MENU_UNDO => Some(TerminalMenuCommand::Undo),
        MENU_REDO => Some(TerminalMenuCommand::Redo),
        MENU_COPY => Some(TerminalMenuCommand::Copy),
        MENU_PASTE => Some(TerminalMenuCommand::Paste),
        MENU_PASTE_SELECTION => Some(TerminalMenuCommand::PasteSelection),
        MENU_SELECT_ALL => Some(TerminalMenuCommand::SelectAll),
        MENU_FIND => Some(TerminalMenuCommand::Find),
        MENU_FIND_NEXT => Some(TerminalMenuCommand::FindNext),
        MENU_FIND_PREVIOUS => Some(TerminalMenuCommand::FindPrevious),
        MENU_HIDE_FIND_BAR => Some(TerminalMenuCommand::HideFindBar),
        MENU_USE_SELECTION_FOR_FIND => Some(TerminalMenuCommand::UseSelectionForFind),
        MENU_JUMP_TO_SELECTION => Some(TerminalMenuCommand::JumpToSelection),
        MENU_RESET_FONT_SIZE => Some(TerminalMenuCommand::ResetFontSize),
        MENU_INCREASE_FONT_SIZE => Some(TerminalMenuCommand::IncreaseFontSize),
        MENU_DECREASE_FONT_SIZE => Some(TerminalMenuCommand::DecreaseFontSize),
        MENU_CHANGE_TAB_TITLE => Some(TerminalMenuCommand::ChangeTabTitle),
        MENU_TOGGLE_READ_ONLY => Some(TerminalMenuCommand::ToggleReadOnly),
        MENU_MINIMIZE => Some(TerminalMenuCommand::Minimize),
        MENU_ZOOM => Some(TerminalMenuCommand::Zoom),
        MENU_FILL => Some(TerminalMenuCommand::Fill),
        MENU_CENTER => Some(TerminalMenuCommand::Center),
        MENU_MOVE_RESIZE_LEFT => Some(TerminalMenuCommand::MoveResizeLeft),
        MENU_MOVE_RESIZE_RIGHT => Some(TerminalMenuCommand::MoveResizeRight),
        MENU_MOVE_RESIZE_TOP => Some(TerminalMenuCommand::MoveResizeTop),
        MENU_MOVE_RESIZE_BOTTOM => Some(TerminalMenuCommand::MoveResizeBottom),
        MENU_MOVE_RESIZE_TOP_LEFT => Some(TerminalMenuCommand::MoveResizeTopLeft),
        MENU_MOVE_RESIZE_TOP_RIGHT => Some(TerminalMenuCommand::MoveResizeTopRight),
        MENU_MOVE_RESIZE_BOTTOM_LEFT => Some(TerminalMenuCommand::MoveResizeBottomLeft),
        MENU_MOVE_RESIZE_BOTTOM_RIGHT => Some(TerminalMenuCommand::MoveResizeBottomRight),
        MENU_TOGGLE_FULL_SCREEN => Some(TerminalMenuCommand::ToggleFullScreen),
        MENU_SHOW_PREVIOUS_TAB => Some(TerminalMenuCommand::ShowPreviousTab),
        MENU_SHOW_NEXT_TAB => Some(TerminalMenuCommand::ShowNextTab),
        MENU_MOVE_TAB_TO_NEW_WINDOW => Some(TerminalMenuCommand::MoveTabToNewWindow),
        MENU_BRING_ALL_TO_FRONT => Some(TerminalMenuCommand::BringAllToFront),
        _ => None,
    }
}

fn emit_terminal_menu_event<R: Runtime>(
    app: &AppHandle<R>,
    command: TerminalMenuCommand,
) -> Result<()> {
    let window = focused_or_main_window(app)?;
    focus_window(&window)?;
    app.emit_to(
        EventTarget::webview_window(window.label()),
        TERMINAL_MENU_EVENT,
        TerminalMenuEvent { command },
    )
    .map_err(to_config_error)
}

fn open_settings<R: Runtime>(app: &AppHandle<R>, mode: &str) -> Result<()> {
    log::debug!("opening Settings window mode={mode}");
    let route = format!("/settings?mode={mode}");
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        log::debug!("Settings window already exists; focusing it");
        focus_window(&window)?;
        window
            .emit(SETTINGS_NAVIGATE_EVENT, route)
            .map_err(to_config_error)?;
        return Ok(());
    }

    let title = menu_text(resolve_ui_language(app)).settings_title;
    log::debug!("building Settings window route={route}");
    let window = WebviewWindowBuilder::new(
        app,
        SETTINGS_WINDOW_LABEL,
        WebviewUrl::App(route.trim_start_matches('/').into()),
    )
    .title(title)
    .inner_size(920.0, 680.0)
    .min_inner_size(540.0, 420.0)
    .resizable(true)
    .center()
    .build()
    .map_err(to_config_error)?;
    log::debug!("Settings window built; focusing it");
    focus_window(&window)
}

fn open_host_manager<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    log::debug!("opening Host Manager window");
    if let Some(window) = app.get_webview_window(HOST_MANAGER_WINDOW_LABEL) {
        log::debug!("Host Manager window already exists; focusing it");
        return focus_window(&window);
    }

    let title = menu_text(resolve_ui_language(app)).hosts_title;
    log::debug!("building Host Manager window");
    let window = WebviewWindowBuilder::new(
        app,
        HOST_MANAGER_WINDOW_LABEL,
        WebviewUrl::App("hosts".into()),
    )
    .title(title)
    .inner_size(920.0, 680.0)
    .min_inner_size(560.0, 420.0)
    .resizable(true)
    .center()
    .build()
    .map_err(to_config_error)?;
    log::debug!("Host Manager window built; focusing it");
    focus_window(&window)
}

fn open_main_window_route(app: &AppHandle, route: Option<&str>) -> Result<()> {
    let label = next_main_window_label(app);
    let route = route.unwrap_or_default().trim_start_matches('/');
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(route.into()))
        .title("Nocturne")
        .inner_size(DEFAULT_WINDOW_WIDTH, DEFAULT_WINDOW_HEIGHT)
        .min_inner_size(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
        .resizable(true)
        .center();
    let builder = apply_main_window_builder_chrome(integrated_titlebar_active(app)?, builder);
    let window = builder.build().map_err(to_config_error)?;
    apply_workspace_decorum_chrome(&window, integrated_titlebar_active(app)?);
    focus_window(&window)
}

fn next_main_window_label<R: Runtime>(app: &AppHandle<R>) -> String {
    for index in 2.. {
        let label = format!("main-{index}");
        if app.get_webview_window(&label).is_none() {
            return label;
        }
    }
    unreachable!("unbounded main window label search should return")
}

fn focused_or_main_window<R: Runtime>(app: &AppHandle<R>) -> Result<WebviewWindow<R>> {
    app.webview_windows()
        .values()
        .find(|window| is_main_window_label(window.label()) && window.is_focused().unwrap_or(false))
        .cloned()
        .or_else(|| {
            LAST_FOCUSED_MAIN_WINDOW.get().and_then(|label| {
                label
                    .lock()
                    .ok()
                    .and_then(|label| app.get_webview_window(&label))
            })
        })
        .or_else(|| app.get_webview_window(MAIN_WINDOW_LABEL))
        .or_else(|| {
            fallback_main_window_label(app).and_then(|label| app.get_webview_window(&label))
        })
        .ok_or_else(|| invalid_error("main window not found"))
}

fn is_main_window_label(label: &str) -> bool {
    label == MAIN_WINDOW_LABEL
        || label
            .strip_prefix("main-")
            .is_some_and(|suffix| suffix.chars().all(|item| item.is_ascii_digit()))
}

fn is_workspace_chrome_window_label(label: &str) -> bool {
    label == MAIN_WINDOW_LABEL
        || label.starts_with("main-")
        || label.starts_with("workspace-floating-")
}

fn fallback_main_window_label<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    app.webview_windows()
        .keys()
        .filter(|label| is_main_window_label(label))
        .min_by_key(|label| main_window_label_order(label))
        .cloned()
}

fn main_window_label_order(label: &str) -> u32 {
    if label == MAIN_WINDOW_LABEL {
        return 1;
    }
    label
        .strip_prefix("main-")
        .and_then(|suffix| suffix.parse::<u32>().ok())
        .unwrap_or(u32::MAX)
}

fn toggle_zoom_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<()> {
    if window.is_maximized().map_err(to_config_error)? {
        window.unmaximize().map_err(to_config_error)
    } else {
        window.maximize().map_err(to_config_error)
    }
}

fn toggle_fullscreen<R: Runtime>(window: &WebviewWindow<R>) -> Result<()> {
    let fullscreen = window.is_fullscreen().map_err(to_config_error)?;
    window.set_fullscreen(!fullscreen).map_err(to_config_error)
}

fn fill_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<()> {
    let monitor = window
        .current_monitor()
        .map_err(to_config_error)?
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or_else(|| invalid_error("monitor not found"))?;
    window
        .set_position(PhysicalPosition::new(
            monitor.position().x,
            monitor.position().y,
        ))
        .map_err(to_config_error)?;
    window
        .set_size(Size::Physical(PhysicalSize::new(
            monitor.size().width,
            monitor.size().height,
        )))
        .map_err(to_config_error)
}

enum WindowPlacement {
    Left,
    Right,
    Top,
    Bottom,
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

fn move_resize_window<R: Runtime>(
    window: &WebviewWindow<R>,
    placement: WindowPlacement,
) -> Result<()> {
    let monitor = window
        .current_monitor()
        .map_err(to_config_error)?
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or_else(|| invalid_error("monitor not found"))?;
    let origin = monitor.position();
    let size = monitor.size();
    let half_width = size.width / 2;
    let half_height = size.height / 2;
    let (x, y, width, height) = match placement {
        WindowPlacement::Left => (origin.x, origin.y, half_width, size.height),
        WindowPlacement::Right => (
            origin.x + half_width as i32,
            origin.y,
            half_width,
            size.height,
        ),
        WindowPlacement::Top => (origin.x, origin.y, size.width, half_height),
        WindowPlacement::Bottom => (
            origin.x,
            origin.y + half_height as i32,
            size.width,
            half_height,
        ),
        WindowPlacement::TopLeft => (origin.x, origin.y, half_width, half_height),
        WindowPlacement::TopRight => (
            origin.x + half_width as i32,
            origin.y,
            half_width,
            half_height,
        ),
        WindowPlacement::BottomLeft => (
            origin.x,
            origin.y + half_height as i32,
            half_width,
            half_height,
        ),
        WindowPlacement::BottomRight => (
            origin.x + half_width as i32,
            origin.y + half_height as i32,
            half_width,
            half_height,
        ),
    };
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(to_config_error)?;
    window
        .set_size(Size::Physical(PhysicalSize::new(width, height)))
        .map_err(to_config_error)
}

fn bring_all_to_front<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    for window in app.webview_windows().values() {
        window.show().map_err(to_config_error)?;
        window.unminimize().map_err(to_config_error)?;
        window.set_focus().map_err(to_config_error)?;
    }
    Ok(())
}

enum DialogKind {
    ProfileNew,
    ProfileDelete,
}

impl DialogKind {
    fn label(&self) -> &'static str {
        match self {
            Self::ProfileNew => PROFILE_NEW_DIALOG_LABEL,
            Self::ProfileDelete => PROFILE_DELETE_DIALOG_LABEL,
        }
    }

    fn route(&self) -> &'static str {
        match self {
            Self::ProfileNew => "dialog/profile-new",
            Self::ProfileDelete => "dialog/profile-delete",
        }
    }
}

fn open_dialog<R: Runtime>(app: &AppHandle<R>, kind: DialogKind) -> Result<()> {
    if let Some(window) = app.get_webview_window(kind.label()) {
        return focus_window(&window);
    }

    let mut builder =
        WebviewWindowBuilder::new(app, kind.label(), WebviewUrl::App(kind.route().into()))
            .title({
                let labels = menu_text(resolve_ui_language(app));
                match kind {
                    DialogKind::ProfileNew => labels.new_profile_title,
                    DialogKind::ProfileDelete => labels.delete_profile_title,
                }
            })
            .inner_size(420.0, 210.0)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .center();

    if let Some(parent) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        builder = builder.parent(&parent).map_err(to_config_error)?;
    } else if let Some(parent) = app.get_webview_window("main") {
        builder = builder.parent(&parent).map_err(to_config_error)?;
    }

    let window = builder.build().map_err(to_config_error)?;
    focus_window(&window)
}

fn resolve_ui_language<R: Runtime>(app: &AppHandle<R>) -> UiLanguage {
    if let Ok(value) = config::effective_application_config(app) {
        if let Some(language) = value
            .get("ui")
            .and_then(|ui| ui.as_table())
            .and_then(|ui| ui.get("language"))
            .and_then(|language| language.as_str())
        {
            return match language {
                "zh" => UiLanguage::Zh,
                "en" => UiLanguage::En,
                _ => default_ui_language(),
            };
        }
    }
    default_ui_language()
}

fn default_ui_language() -> UiLanguage {
    match env::var("LANG").unwrap_or_default().to_lowercase() {
        lang if lang.starts_with("zh") => UiLanguage::Zh,
        _ => UiLanguage::En,
    }
}

fn focus_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<()> {
    window.show().map_err(to_config_error)?;
    window.unminimize().map_err(to_config_error)?;
    window.set_focus().map_err(to_config_error)
}

fn config_to_io(error: crate::ConfigError) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Other, error.to_string())
}

fn to_config_error(error: impl std::fmt::Display) -> crate::ConfigError {
    invalid_error(error.to_string())
}
