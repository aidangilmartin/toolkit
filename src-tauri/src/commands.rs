//! Tauri commands: a thin async layer over `loadout_core::Loadout`.
//! Every command runs the blocking core call on a worker thread so the UI never
//! freezes, and errors are turned into player-friendly strings.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use loadout_core::launch;
use loadout_core::model::{
    AfterLaunch, AppConfig, AppStatus, ApplyPlan, ApplyResult, CapturedSettings, FolderTarget,
    ImportProposal, Pack, PackCategory, PackLayout, Profile, Progress, Server, Snapshot,
};
use loadout_core::schema::GraphicsSchema;
use loadout_core::Loadout;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

pub struct AppState {
    pub core: Arc<Loadout>,
}

type CmdResult<T> = Result<T, String>;

const PROGRESS_EVENT: &str = "loadout://progress";

async fn run<T, F>(state: &State<'_, AppState>, f: F) -> CmdResult<T>
where
    T: Send + 'static,
    F: FnOnce(&Loadout) -> loadout_core::Result<T> + Send + 'static,
{
    let core = state.core.clone();
    tauri::async_runtime::spawn_blocking(move || f(&core))
        .await
        .map_err(|e| format!("Internal error: {e}"))?
        .map_err(|e| {
            log::warn!("{e}");
            e.user_message()
        })
}

fn progress_emitter(app: &AppHandle) -> impl FnMut(Progress) {
    let app = app.clone();
    move |progress| {
        let _ = app.emit(PROGRESS_EVENT, progress);
    }
}

// ---- Status & config -------------------------------------------------------

#[tauri::command]
pub async fn get_status(state: State<'_, AppState>) -> CmdResult<AppStatus> {
    run(&state, |core| core.status()).await
}

#[tauri::command]
pub async fn running_processes(state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    run(&state, |core| Ok(core.running_processes())).await
}

#[tauri::command]
pub async fn close_game(state: State<'_, AppState>) -> CmdResult<usize> {
    run(&state, |core| Ok(core.close_game())).await
}

#[tauri::command]
pub async fn dismiss_notice(state: State<'_, AppState>) -> CmdResult<()> {
    run(&state, |core| {
        core.dismiss_notice();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn get_config(state: State<'_, AppState>) -> CmdResult<AppConfig> {
    run(&state, |core| core.config()).await
}

#[tauri::command]
pub async fn save_config(state: State<'_, AppState>, config: AppConfig) -> CmdResult<AppConfig> {
    run(&state, move |core| core.save_config(config)).await
}

#[tauri::command]
pub async fn complete_setup(state: State<'_, AppState>) -> CmdResult<AppConfig> {
    run(&state, |core| core.complete_setup()).await
}

#[tauri::command]
pub fn get_schema(state: State<'_, AppState>) -> GraphicsSchema {
    state.core.schema().clone()
}

#[tauri::command]
pub async fn capture_current(state: State<'_, AppState>) -> CmdResult<CapturedSettings> {
    run(&state, |core| core.capture()).await
}

// ---- Profiles & servers ------------------------------------------------------

#[tauri::command]
pub async fn list_profiles(state: State<'_, AppState>) -> CmdResult<Vec<Profile>> {
    run(&state, |core| core.profiles()).await
}

#[tauri::command]
pub async fn save_profile(state: State<'_, AppState>, profile: Profile) -> CmdResult<Profile> {
    run(&state, move |core| core.save_profile(profile)).await
}

#[tauri::command]
pub async fn duplicate_profile(state: State<'_, AppState>, id: String) -> CmdResult<Profile> {
    run(&state, move |core| core.duplicate_profile(&id)).await
}

#[tauri::command]
pub async fn delete_profile(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    run(&state, move |core| core.delete_profile(&id)).await
}

#[tauri::command]
pub async fn list_servers(state: State<'_, AppState>) -> CmdResult<Vec<Server>> {
    run(&state, |core| core.servers()).await
}

#[tauri::command]
pub async fn save_server(state: State<'_, AppState>, server: Server) -> CmdResult<Server> {
    run(&state, move |core| core.save_server(server)).await
}

#[tauri::command]
pub async fn delete_server(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    run(&state, move |core| core.delete_server(&id)).await
}

// ---- Packs -------------------------------------------------------------------

#[tauri::command]
pub async fn list_packs(state: State<'_, AppState>) -> CmdResult<Vec<Pack>> {
    run(&state, |core| Ok(core.packs())).await
}

#[tauri::command]
pub async fn inspect_pack(
    state: State<'_, AppState>,
    path: String,
    layout: Option<PackLayout>,
) -> CmdResult<ImportProposal> {
    run(&state, move |core| {
        core.inspect_pack(&PathBuf::from(path), layout)
    })
    .await
}

#[tauri::command]
pub async fn import_pack(
    app: AppHandle,
    state: State<'_, AppState>,
    proposal: ImportProposal,
) -> CmdResult<Pack> {
    let mut emit = progress_emitter(&app);
    run(&state, move |core| core.import_pack(&proposal, &mut emit)).await
}

#[tauri::command]
pub async fn update_pack(
    state: State<'_, AppState>,
    id: String,
    name: String,
    category: PackCategory,
    notes: String,
) -> CmdResult<Pack> {
    run(&state, move |core| {
        core.update_pack(&id, &name, category, &notes)
    })
    .await
}

#[tauri::command]
pub async fn delete_pack(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    run(&state, move |core| core.delete_pack(&id)).await
}

// ---- Apply ---------------------------------------------------------------------

#[tauri::command]
pub async fn plan_apply(
    state: State<'_, AppState>,
    profile_id: Option<String>,
) -> CmdResult<ApplyPlan> {
    run(&state, move |core| core.plan(profile_id.as_deref())).await
}

#[tauri::command]
pub async fn apply_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: Option<String>,
) -> CmdResult<ApplyResult> {
    let mut emit = progress_emitter(&app);
    run(&state, move |core| {
        core.apply(profile_id.as_deref(), &mut emit)
    })
    .await
}

#[tauri::command]
pub async fn save_drift_to_profile(state: State<'_, AppState>) -> CmdResult<Profile> {
    run(&state, |core| core.save_drift_to_profile()).await
}

#[tauri::command]
pub async fn dismiss_drift(state: State<'_, AppState>) -> CmdResult<()> {
    run(&state, |core| core.dismiss_drift()).await
}

// ---- Backups ---------------------------------------------------------------------

#[tauri::command]
pub async fn list_snapshots(state: State<'_, AppState>) -> CmdResult<Vec<Snapshot>> {
    run(&state, |core| Ok(core.snapshots())).await
}

#[tauri::command]
pub async fn restore_snapshot(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    run(&state, move |core| core.restore_snapshot(&id)).await
}

#[tauri::command]
pub async fn delete_snapshot(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    run(&state, move |core| core.delete_snapshot(&id)).await
}

// ---- Launching -------------------------------------------------------------------

fn after_launch(app: &AppHandle, core: &Loadout) {
    match core.config().map(|c| c.after_launch).unwrap_or_default() {
        AfterLaunch::KeepOpen => {}
        AfterLaunch::Minimize => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.minimize();
            }
        }
        AfterLaunch::Close => {
            let app = app.clone();
            std::thread::spawn(move || {
                // Give FiveM a moment to take over the protocol hand-off.
                std::thread::sleep(Duration::from_millis(1500));
                app.exit(0);
            });
        }
    }
}

#[tauri::command]
pub async fn launch_fivem(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let exe = run(&state, |core| Ok(core.paths()?.fivem_exe)).await?;
    let exe = exe
        .ok_or_else(|| "FiveM.exe wasn't found. Check the FiveM folder in Settings.".to_string())?;
    let mut command = std::process::Command::new(&exe);
    if let Some(dir) = exe.parent() {
        command.current_dir(dir);
    }
    command
        .spawn()
        .map_err(|e| format!("Couldn't start FiveM: {e}"))?;
    after_launch(&app, &state.core);
    Ok(())
}

#[tauri::command]
pub async fn connect_server(
    app: AppHandle,
    state: State<'_, AppState>,
    address: String,
    server_id: Option<String>,
) -> CmdResult<()> {
    let address = launch::normalize_server_address(&address)?;
    app.opener()
        .open_url(launch::connect_url(&address), None::<&str>)
        .map_err(|e| format!("Couldn't open FiveM ({e}). Is FiveM installed?"))?;
    if let Some(id) = server_id {
        run(&state, move |core| core.mark_played(&id)).await?;
    }
    after_launch(&app, &state.core);
    Ok(())
}

#[tauri::command]
pub async fn open_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    target: FolderTarget,
) -> CmdResult<()> {
    let path = run(&state, move |core| {
        let path = match target {
            FolderTarget::Data => Some(core.data_dir().to_path_buf()),
            FolderTarget::Logs => Some(core.data_dir().join("logs")),
            FolderTarget::Pack { id } => Some(core.pack_dir(&id)).filter(|p| p.is_dir()),
            FolderTarget::Game { key } => core
                .paths()?
                .info
                .into_iter()
                .find(|info| info.key == key && info.exists)
                .and_then(|info| info.path)
                .map(PathBuf::from),
        };
        Ok(path)
    })
    .await?;
    let path = path.ok_or_else(|| "That folder wasn't found.".to_string())?;
    let _ = std::fs::create_dir_all(&path);
    app.opener()
        .open_path(path.display().to_string(), None::<&str>)
        .map_err(|e| format!("Couldn't open the folder: {e}"))
}
