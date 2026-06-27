mod app_shell;
mod config;
mod error;
mod files;
mod logging;
mod port_forwarding;
mod resources;
mod ssh_trust;
mod terminal;
mod terminal_schemes;
mod transfers;
mod types;
mod workspace;
mod workspace_ssh;

// The Tauri app binaries get their own manifest through tauri_build; this only links the
// extra Common Controls v6 resource into the Windows test harness executable.
#[cfg(all(test, windows))]
#[link(name = "nocturne_test_common_controls_v6", kind = "static")]
extern "C" {}

#[cfg(debug_assertions)]
use specta_typescript::Typescript;
use tauri_specta::{collect_commands, Builder};

pub use error::{ConfigError, Result};
pub use files::{
    build_remote_ripgrep_command_for_test, extract_ripgrep_helper_from_archive_for_test,
    load_ripgrep_helper_bytes_from_path_for_test, load_ripgrep_helper_bytes_from_paths_for_test,
    parse_remote_ripgrep_json_matches_for_test, plan_ripgrep_helper_upload_for_test,
    ripgrep_helper_asset_name_for_test, ripgrep_helper_candidate_paths_for_test,
    ripgrep_helper_resource_path_for_test, ripgrep_managed_command_for_test,
};
pub use resources::{
    build_info_for_test, collect_linux_drm_gpu_metric_from_root_for_test,
    collect_local_resource_snapshot, decide_resource_helper_deployment_for_test,
    gpu_unavailable_metric_for_test, helper_asset_name_for_test, helper_download_plan_for_test,
    helper_target_unknown_metric_for_test, load_resource_helper_bytes_from_path_for_test,
    load_resource_helper_bytes_from_paths_for_test, local_resource_provider_descriptor_for_test,
    normalize_cpu_metric_for_test, normalize_memory_metric_for_test,
    normalize_resource_monitor_agent_metric_for_test, normalize_windows_gpu_pdh_samples_for_test,
    parse_linux_free_b_for_test, parse_linux_nvidia_smi_csv_for_test,
    parse_linux_proc_stat_cpu_for_test, parse_macos_disk_df_for_test, parse_macos_memory_for_test,
    parse_remote_uname_for_test, parse_remote_windows_platform_for_test,
    parse_resource_monitor_agent_ndjson_for_test, parse_unix_disk_df_for_test,
    parse_windows_disk_for_test, parse_windows_memory_for_test,
    plan_resource_helper_upload_for_test, remote_provider_mode_for_host_resources_for_test,
    remote_system_command_plan_for_test, remote_system_provider_runs_off_command_thread_for_test,
    resolve_resource_target_for_test, resource_helper_candidate_paths_for_test,
    resource_helper_resource_path_for_test, resource_settings_from_config_for_test,
    LocalDiskMountMetric, LocalGpuDeviceMetric, LocalResourceMetric,
    LocalResourceMetricAvailability, LocalResourceMetricDetails, LocalResourceMetricKind,
    LocalResourceSnapshot, NocturneBuildInfo, RemoteResourceTargetDetection,
    RemoteSystemCommandPlan, ResourceHelperBytesSource, ResourceHelperDeploymentDecision,
    ResourceHelperDeploymentMemory, ResourceHelperDeploymentStatus, ResourceHelperDownloadPlan,
    ResourceHelperManifest, ResourceHelperPolicy, ResourceHelperUploadPlan,
    ResourceMonitorAgentDiskMount, ResourceMonitorAgentEvent, ResourceMonitorAgentGpuDevice,
    ResourceMonitorAgentMetric, WindowsGpuAdapterInfo, WindowsGpuPdhSample,
};
pub use types::*;
pub use types::{HostResourceConfig, RemoteResourceTargetArch, RemoteResourceTargetOs};

fn create_app_specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            config::get_config_root,
            config::get_config_snapshot,
            resources::get_resource_settings,
            resources::collect_resource_monitor_snapshot,
            terminal::get_terminal_settings,
            terminal::get_terminal_settings_for_theme,
            terminal::create_host_terminal_session,
            terminal::existing_terminal_session_info,
            terminal::transfer_terminal_sessions_to_window,
            terminal::detach_terminal_session,
            terminal::list_detached_terminal_sessions,
            terminal::attach_detached_terminal_session,
            terminal::open_detached_terminal_session_history,
            terminal::delete_detached_terminal_session,
            terminal::export_terminal_session_key,
            terminal::take_terminal_output_backlog,
            terminal::write_terminal,
            terminal::resize_terminal,
            terminal::rename_terminal_session,
            terminal::update_terminal_title,
            terminal::close_terminal_session,
            terminal_schemes::list_terminal_color_schemes,
            terminal_schemes::read_terminal_color_scheme,
            terminal_schemes::create_terminal_color_scheme,
            terminal_schemes::update_terminal_color_scheme,
            terminal_schemes::delete_terminal_color_scheme,
            terminal_schemes::export_terminal_color_scheme,
            terminal_schemes::export_terminal_color_scheme_to_path,
            files::list_files,
            files::search_files,
            files::create_directory,
            files::rename_file,
            files::chmod_file,
            files::delete_file,
            files::remote_trash_info,
            files::remote_search_helper_info,
            files::trash_file,
            files::preview_file,
            transfers::get_transfer_queue_snapshot,
            transfers::create_transfer_task,
            transfers::cancel_transfer_task,
            transfers::retry_transfer_task,
            port_forwarding::get_port_forward_snapshot,
            port_forwarding::create_or_update_port_forward_rule,
            port_forwarding::update_port_forward_draft,
            port_forwarding::clear_port_forward_draft,
            port_forwarding::check_port_forward_non_loopback_risk,
            port_forwarding::start_port_forward_rule,
            port_forwarding::stop_port_forward_rule,
            port_forwarding::delete_port_forward_rule,
            port_forwarding::submit_port_forward_ssh_verification,
            workspace::get_workspace_layout_snapshot,
            workspace::workspace_dispatch,
            workspace_ssh::submit_workspace_ssh_verification,
            config::list_profiles,
            config::read_profile,
            config::create_profile,
            config::update_profile,
            config::delete_profile,
            config::set_active_profile,
            config::read_main_config,
            config::update_main_config,
            config::read_connection_host,
            config::list_connection_hosts,
            config::create_connection_host,
            config::update_connection_host,
            config::delete_connection_host,
            config::repair_connection_host_id,
            config::list_ssh_known_hosts,
            config::set_host_dirs_command,
            config::set_openssh_config_files_command,
            config::set_default_host_command,
            config::remove_config_key,
            app_shell::show_tab_bar_context_menu,
            app_shell::show_app_menu,
            app_shell::open_settings_window,
            app_shell::open_host_manager_window,
            app_shell::open_profile_new_dialog,
            app_shell::open_main_window,
            app_shell::open_workspace_floating_window,
            app_shell::refresh_app_menu,
            app_shell::update_terminal_menu_state,
            config::watch_config_command
        ])
        .typ::<types::WorkspaceChangedEvent>()
        .typ::<types::WorkspaceSshVerificationRequiredEvent>()
        .typ::<types::TransferQueueChangedEvent>()
        .typ::<types::PortForwardSshVerificationRequiredEvent>()
        .typ::<types::WorkspaceDockGroupRole>()
        .typ::<types::WorkspaceDockLayout>()
        .typ::<types::PortForwardSnapshot>()
}

#[cfg(debug_assertions)]
fn export_app_bindings_from_builder(builder: &Builder<tauri::Wry>) {
    let bindings_path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/bindings.ts");
    builder
        .export(Typescript::default(), bindings_path)
        .expect("failed to export Tauri command bindings");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let log_file_name = logging::session_log_file_name();
    let builder = create_app_specta_builder();

    #[cfg(debug_assertions)]
    export_app_bindings_from_builder(&builder);

    let tauri_builder = tauri::Builder::default().enable_macos_default_menu(false);
    #[cfg(target_os = "macos")]
    let tauri_builder = tauri_builder.menu(|app| app_shell::build_bootstrap_menu(app));

    tauri_builder
        .on_menu_event(|app, event| app_shell::handle_menu_event(app, event.id().as_ref()))
        .on_window_event(|window, event| app_shell::handle_window_event(window, event))
        .plugin(logging::plugin(log_file_name.clone()))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_decorum::init())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            match logging::clean_log_dir(app.handle(), &log_file_name) {
                Ok(summary) if summary.removed_files > 0 => {
                    log::info!(
                        "cleaned {} old log files ({} bytes removed, {} files kept)",
                        summary.removed_files,
                        summary.removed_bytes,
                        summary.kept_files
                    );
                }
                Ok(_) => {}
                Err(error) => log::warn!("{}", logging::cleanup_error(error)),
            }
            log::info!("Nocturne setup started");
            let _ = config::ensure_layout(app.handle())?;
            let diagnostics_app = app.handle().clone();
            std::thread::spawn(move || {
                log::debug!("background connection diagnostics notification check started");
                if let Err(error) = config::notify_connection_diagnostics(&diagnostics_app) {
                    log::warn!("failed to notify connection diagnostics during setup: {error}");
                }
                log::debug!("background connection diagnostics notification check finished");
            });
            app_shell::refresh_menu(app.handle())?;
            app_shell::apply_initial_main_window_chrome(app.handle())?;
            app_shell::apply_initial_workspace_decorum_chrome(app.handle())?;
            config::watch_config_command(app.handle().clone())?;
            log::info!("Nocturne setup completed");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
