use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, LogicalPosition, Manager, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::{
    config,
    error::{invalid_error, Result},
    terminal,
    types::{PaneContextMenuInput, PaneMenuAction, PaneMenuEvent, TabBarContextMenuInput, TabBarOrientation},
};
use std::env;

const SETTINGS_WINDOW_LABEL: &str = "settings";
const PROFILE_NEW_DIALOG_LABEL: &str = "dialog-profile-new";
const PROFILE_DELETE_DIALOG_LABEL: &str = "dialog-profile-delete";
const MENU_SETTINGS: &str = "file.settings";
const MENU_PROFILE_NEW: &str = "file.profile.new";
const MENU_PROFILE_EDIT: &str = "file.profile.edit";
const MENU_PROFILE_DELETE: &str = "file.profile.delete";
const PROFILE_SWITCH_PREFIX: &str = "file.profile.switch.";
const TAB_BAR_ORIENTATION_PREFIX: &str = "terminal.tab_bar_orientation.";
const TAB_BAR_ORIENTATION_HORIZONTAL: &str = "terminal.tab_bar_orientation.horizontal";
const TAB_BAR_ORIENTATION_VERTICAL_LEFT: &str = "terminal.tab_bar_orientation.vertical_left";
const TAB_BAR_ORIENTATION_VERTICAL_RIGHT: &str = "terminal.tab_bar_orientation.vertical_right";
const PANE_SPLIT_LEFT: &str = "terminal.pane.split_left";
const PANE_SPLIT_RIGHT: &str = "terminal.pane.split_right";
const PANE_SPLIT_UP: &str = "terminal.pane.split_up";
const PANE_SPLIT_DOWN: &str = "terminal.pane.split_down";
const SETTINGS_NAVIGATE_EVENT: &str = "settings://navigate";
const PANE_MENU_EVENT: &str = "terminal://pane-menu";

#[derive(Copy, Clone, PartialEq, Eq)]
enum UiLanguage {
    En,
    Zh,
}

struct MenuText {
    file: &'static str,
    profile: &'static str,
    settings: &'static str,
    profile_new: &'static str,
    profile_edit: &'static str,
    profile_delete: &'static str,
    close: &'static str,
    horizontal_tabs: &'static str,
    vertical_left_tabs: &'static str,
    vertical_right_tabs: &'static str,
    split_left: &'static str,
    split_right: &'static str,
    split_up: &'static str,
    split_down: &'static str,
    settings_title: &'static str,
    new_profile_title: &'static str,
    delete_profile_title: &'static str,
}

fn menu_text(language: UiLanguage) -> MenuText {
    match language {
        UiLanguage::En => MenuText {
            file: "File",
            profile: "Profile",
            settings: "Settings...",
            profile_new: "New...",
            profile_edit: "Edit...",
            profile_delete: "Delete...",
            close: "Close",
            horizontal_tabs: "Horizontal Tabs",
            vertical_left_tabs: "Vertical Tabs on Left",
            vertical_right_tabs: "Vertical Tabs on Right",
            split_left: "Split Left",
            split_right: "Split Right",
            split_up: "Split Up",
            split_down: "Split Down",
            settings_title: "Nocturne Settings",
            new_profile_title: "New Profile",
            delete_profile_title: "Delete Profile",
        },
        UiLanguage::Zh => MenuText {
            file: "文件",
            profile: "档案",
            settings: "设置...",
            profile_new: "新建...",
            profile_edit: "编辑...",
            profile_delete: "删除...",
            close: "关闭",
            horizontal_tabs: "水平标签",
            vertical_left_tabs: "左侧标签",
            vertical_right_tabs: "右侧标签",
            split_left: "向左分割",
            split_right: "向右分割",
            split_up: "向上分割",
            split_down: "向下分割",
            settings_title: "Nocturne 设置",
            new_profile_title: "新建档案",
            delete_profile_title: "删除档案",
        },
    }
}

pub(crate) fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let root = config::ensure_layout(app).map_err(config_to_io)?;
    let profiles = config::list_profiles_impl_from_app(app).map_err(config_to_io)?;
    let labels = menu_text(resolve_ui_language(app));

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
    let separator = PredefinedMenuItem::separator(app)?;

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

    let mut profile_children: Vec<&dyn tauri::menu::IsMenuItem<R>> =
        vec![&profile_new, &profile_delete, &profile_edit, &separator];
    for item in &profile_items {
        profile_children.push(item);
    }

    let profile_menu = Submenu::with_items(app, labels.profile, true, &profile_children)?;
    let close = PredefinedMenuItem::close_window(app, Some(labels.close))?;
    let file = Submenu::with_items(app, labels.file, true, &[&settings, &profile_menu, &close])?;
    Menu::with_items(app, &[&file])
}

pub(crate) fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let result = if id == MENU_SETTINGS {
        open_settings(app, "main")
    } else if id == MENU_PROFILE_EDIT {
        open_settings(app, "profile")
    } else if id == MENU_PROFILE_NEW {
        open_dialog(app, DialogKind::ProfileNew)
    } else if id == MENU_PROFILE_DELETE {
        open_dialog(app, DialogKind::ProfileDelete)
    } else if let Some(profile) = id.strip_prefix(PROFILE_SWITCH_PREFIX) {
        config::set_active_profile_impl(app, profile.to_string()).and_then(|_| refresh_menu(app))
    } else if let Some(placement) = id.strip_prefix(TAB_BAR_ORIENTATION_PREFIX) {
        let orientation = tab_bar_orientation_from_menu_id(placement);
        orientation.and_then(|value| config::set_effective_tab_bar_orientation(app, value))
    } else if id.starts_with(&format!("{PANE_SPLIT_LEFT}:"))
        || id.starts_with(&format!("{PANE_SPLIT_RIGHT}:"))
        || id.starts_with(&format!("{PANE_SPLIT_UP}:"))
        || id.starts_with(&format!("{PANE_SPLIT_DOWN}:"))
    {
        emit_pane_menu_event(app, id)
    } else {
        Ok(())
    };

    if let Err(error) = result {
        eprintln!("menu action failed: {error}");
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn show_pane_context_menu(app: AppHandle, input: PaneContextMenuInput) -> Result<()> {
    let labels = menu_text(resolve_ui_language(&app));
    let split_left = MenuItem::with_id(
        &app,
        format!("{PANE_SPLIT_LEFT}:{}", input.pane_id),
        labels.split_left,
        true,
        None::<&str>,
    )
    .map_err(to_config_error)?;
    let split_right = MenuItem::with_id(
        &app,
        format!("{PANE_SPLIT_RIGHT}:{}", input.pane_id),
        labels.split_right,
        true,
        None::<&str>,
    )
    .map_err(to_config_error)?;
    let split_up = MenuItem::with_id(
        &app,
        format!("{PANE_SPLIT_UP}:{}", input.pane_id),
        labels.split_up,
        true,
        None::<&str>,
    )
    .map_err(to_config_error)?;
    let split_down = MenuItem::with_id(
        &app,
        format!("{PANE_SPLIT_DOWN}:{}", input.pane_id),
        labels.split_down,
        true,
        None::<&str>,
    )
    .map_err(to_config_error)?;
    let menu = Menu::with_items(&app, &[&split_left, &split_right, &split_up, &split_down])
        .map_err(to_config_error)?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| invalid_error("main window not found"))?;
    window
        .popup_menu_at(&menu, LogicalPosition::new(input.x, input.y))
        .map_err(to_config_error)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn refresh_app_menu(app: AppHandle) -> Result<()> {
    refresh_menu(&app)
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
        .get_webview_window("main")
        .ok_or_else(|| invalid_error("main window not found"))?;
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

fn emit_pane_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<()> {
    let (action, pane_id) = if let Some(pane_id) = id.strip_prefix(&format!("{PANE_SPLIT_LEFT}:")) {
        (PaneMenuAction::SplitLeft, pane_id)
    } else if let Some(pane_id) = id.strip_prefix(&format!("{PANE_SPLIT_RIGHT}:")) {
        (PaneMenuAction::SplitRight, pane_id)
    } else if let Some(pane_id) = id.strip_prefix(&format!("{PANE_SPLIT_UP}:")) {
        (PaneMenuAction::SplitUp, pane_id)
    } else if let Some(pane_id) = id.strip_prefix(&format!("{PANE_SPLIT_DOWN}:")) {
        (PaneMenuAction::SplitDown, pane_id)
    } else {
        return Ok(());
    };
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| invalid_error("main window not found"))?;
    window
        .emit(
            PANE_MENU_EVENT,
            PaneMenuEvent {
                action,
                pane_id: pane_id.to_string(),
            },
        )
        .map_err(to_config_error)
}

fn open_settings<R: Runtime>(app: &AppHandle<R>, mode: &str) -> Result<()> {
    let route = format!("/settings?mode={mode}");
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        focus_window(&window)?;
        window
            .emit(SETTINGS_NAVIGATE_EVENT, route)
            .map_err(to_config_error)?;
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(
        app,
        SETTINGS_WINDOW_LABEL,
        WebviewUrl::App(route.trim_start_matches('/').into()),
    )
    .title(menu_text(resolve_ui_language(app)).settings_title)
    .inner_size(920.0, 680.0)
    .min_inner_size(540.0, 420.0)
    .resizable(true)
    .center()
    .build()
    .map_err(to_config_error)?;
    focus_window(&window)
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
