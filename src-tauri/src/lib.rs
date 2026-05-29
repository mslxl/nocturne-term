mod app_shell;
mod config;
mod error;
mod terminal;
mod terminal_schemes;
mod types;

#[cfg(debug_assertions)]
use specta_typescript::Typescript;
use tauri_specta::{collect_commands, Builder};

pub use error::{ConfigError, Result};
pub use types::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            config::get_config_root,
            config::get_config_snapshot,
            terminal::get_terminal_settings,
            terminal::get_terminal_settings_for_theme,
            terminal::create_terminal_session,
            terminal::existing_terminal_session_info,
            terminal::transfer_terminal_sessions_to_window,
            terminal::take_terminal_output_backlog,
            terminal::write_terminal,
            terminal::resize_terminal,
            terminal::close_terminal_session,
            terminal_schemes::list_terminal_color_schemes,
            terminal_schemes::read_terminal_color_scheme,
            terminal_schemes::create_terminal_color_scheme,
            terminal_schemes::update_terminal_color_scheme,
            terminal_schemes::delete_terminal_color_scheme,
            terminal_schemes::export_terminal_color_scheme,
            terminal_schemes::export_terminal_color_scheme_to_path,
            config::list_profiles,
            config::read_profile,
            config::create_profile,
            config::update_profile,
            config::delete_profile,
            config::set_active_profile,
            config::read_main_config,
            config::update_main_config,
            config::read_host,
            config::list_hosts,
            config::create_host,
            config::update_host,
            config::delete_host,
            config::set_host_dirs_command,
            config::remove_config_key,
            app_shell::show_tab_bar_context_menu,
            app_shell::show_pane_context_menu,
            app_shell::open_settings_window,
            app_shell::open_profile_new_dialog,
            app_shell::open_main_window,
            app_shell::refresh_app_menu,
            app_shell::update_terminal_menu_state,
            config::watch_config_command
        ])
        .typ::<types::TerminalMenuEvent>();

    #[cfg(debug_assertions)]
    builder
        .export(Typescript::default(), "../src/lib/bindings.ts")
        .expect("failed to export Tauri command bindings");

    let tauri_builder = tauri::Builder::default().enable_macos_default_menu(false);
    #[cfg(target_os = "macos")]
    let tauri_builder = tauri_builder.menu(|app| app_shell::build_bootstrap_menu(app));

    tauri_builder
        .on_menu_event(|app, event| app_shell::handle_menu_event(app, event.id().as_ref()))
        .on_window_event(|window, event| app_shell::handle_window_event(window, event))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(builder.invoke_handler())
        .setup(|app| {
            let _ = config::ensure_layout(app.handle())?;
            app_shell::refresh_menu(app.handle())?;
            config::watch_config_command(app.handle().clone())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
