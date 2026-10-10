mod commands;

use std::path::PathBuf;
use std::sync::Arc;

use loadout_core::paths::{system_registry, SystemDirs};
use loadout_core::process::SystemProcesses;
use loadout_core::store::Store;
use loadout_core::Loadout;
use tauri::Manager;

use commands::AppState;

/// Where Loadout keeps its data. `LOADOUT_DATA_DIR` overrides it (handy for testing).
fn data_dir() -> PathBuf {
    std::env::var_os("LOADOUT_DATA_DIR")
        .map(PathBuf::from)
        .or_else(Store::default_root)
        .unwrap_or_else(|| PathBuf::from("Loadout-data"))
}

/// The Windows folders to look in. `LOADOUT_SYSTEM_ROOT` points them at a fake
/// `Local/`, `Roaming/`, `Documents/` layout so the app can be tried off Windows.
fn system_dirs() -> SystemDirs {
    match std::env::var_os("LOADOUT_SYSTEM_ROOT").map(PathBuf::from) {
        Some(root) => SystemDirs {
            local_app_data: Some(root.join("Local")),
            roaming_app_data: Some(root.join("Roaming")),
            documents: Some(root.join("Documents")),
        },
        None => SystemDirs::from_os(),
    }
}

pub fn run() {
    let data_dir = data_dir();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .clear_targets()
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Folder {
                        path: data_dir.join("logs"),
                        file_name: Some("loadout".into()),
                    },
                ))
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                ))
                .level(log::LevelFilter::Info)
                .max_file_size(2_000_000)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let core = Loadout::open(
                data_dir.clone(),
                system_dirs(),
                system_registry(),
                Box::new(SystemProcesses),
            )?;
            log::info!("Loadout started, data in {}", data_dir.display());
            app.manage(AppState {
                core: Arc::new(core),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::running_processes,
            commands::close_game,
            commands::dismiss_notice,
            commands::get_config,
            commands::save_config,
            commands::complete_setup,
            commands::get_schema,
            commands::capture_current,
            commands::list_profiles,
            commands::save_profile,
            commands::duplicate_profile,
            commands::delete_profile,
            commands::lookup_server,
            commands::search_servers,
            commands::read_logo_file,
            commands::list_packs,
            commands::import_profile_file,
            commands::plan_apply,
            commands::apply_profile,
            commands::save_drift_to_profile,
            commands::dismiss_drift,
            commands::list_snapshots,
            commands::restore_snapshot,
            commands::delete_snapshot,
            commands::launch_fivem,
            commands::connect_server,
            commands::open_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Loadout");
}
