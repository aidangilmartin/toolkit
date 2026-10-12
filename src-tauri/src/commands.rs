//! Tauri commands: a thin async layer over `loadout_core::Loadout`.
//! Every command runs the blocking core call on a worker thread so the UI never
//! freezes, and errors are turned into player-friendly strings.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use loadout_core::launch;
use loadout_core::model::{
    AfterLaunch, AppConfig, AppStatus, ApplyPlan, ApplyResult, CapturedSettings, FolderTarget,
    InstallKind, Pack, Profile, ProfileFileKind, Progress, ProgressStage, ServerInfo, ServerSearch,
    Snapshot, UpdateInfo,
};
use loadout_core::schema::GraphicsSchema;
use loadout_core::update::{self, Release};
use loadout_core::Loadout;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

pub struct AppState {
    pub core: Arc<Loadout>,
    /// The newer release found by the last update check.
    pub update: Mutex<Option<Release>>,
}

type CmdResult<T> = Result<T, String>;

const PROGRESS_EVENT: &str = "loadout://progress";
const UPDATE_PROGRESS_EVENT: &str = "loadout://update-progress";

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

// ---- Profiles ------------------------------------------------------

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
pub async fn lookup_server(state: State<'_, AppState>, address: String) -> CmdResult<ServerInfo> {
    run(&state, move |core| core.lookup_server(&address)).await
}

#[tauri::command]
pub async fn search_servers(state: State<'_, AppState>, query: String) -> CmdResult<ServerSearch> {
    run(&state, move |core| core.search_servers(&query)).await
}

#[tauri::command]
pub async fn read_logo_file(state: State<'_, AppState>, path: String) -> CmdResult<String> {
    run(&state, move |core| {
        core.read_logo_file(&PathBuf::from(path))
    })
    .await
}

// ---- Packs -------------------------------------------------------------------

#[tauri::command]
pub async fn list_packs(state: State<'_, AppState>) -> CmdResult<Vec<Pack>> {
    run(&state, |core| Ok(core.packs())).await
}

#[tauri::command]
pub async fn import_profile_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    kind: ProfileFileKind,
) -> CmdResult<Pack> {
    let mut emit = progress_emitter(&app);
    run(&state, move |core| {
        core.import_profile_file(&PathBuf::from(path), kind, &mut emit)
    })
    .await
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

/// FiveM refuses to start when Loadout launches it directly, so on Windows the
/// desktop's Explorer starts it instead (see `shell.rs`).
async fn open_through_shell(target: String, working_dir: Option<PathBuf>) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::shell::open(&target, working_dir.as_deref())
    })
    .await
    .map_err(|e| format!("Internal error: {e}"))?
}

#[tauri::command]
pub async fn launch_fivem(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let exe = run(&state, |core| Ok(core.paths()?.fivem_exe)).await?;
    let exe = exe
        .ok_or_else(|| "FiveM.exe wasn't found. Check the FiveM folder in Settings.".to_string())?;
    if cfg!(windows) {
        open_through_shell(
            exe.display().to_string(),
            exe.parent().map(Path::to_path_buf),
        )
        .await?;
    } else {
        let mut command = std::process::Command::new(&exe);
        if let Some(dir) = exe.parent() {
            command.current_dir(dir);
        }
        command
            .spawn()
            .map_err(|e| format!("Couldn't start FiveM: {e}"))?;
    }
    after_launch(&app, &state.core);
    Ok(())
}

#[tauri::command]
pub async fn connect_server(
    app: AppHandle,
    state: State<'_, AppState>,
    address: String,
) -> CmdResult<()> {
    let address = launch::normalize_server_address(&address)?;
    let url = launch::connect_url(&address);
    if cfg!(windows) {
        open_through_shell(url, None).await?;
    } else {
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|e| format!("Couldn't open FiveM ({e}). Is FiveM installed?"))?;
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

// ---- Updates -------------------------------------------------------------------

/// The NSIS installer leaves `uninstall.exe` next to the app; the portable exe
/// has nothing next to it.
fn install_kind() -> InstallKind {
    let installed = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("uninstall.exe").is_file()))
        .unwrap_or(false);
    if installed {
        InstallKind::Installer
    } else {
        InstallKind::Portable
    }
}

/// Where downloaded installers go (cleaned up on the next start).
pub fn update_download_dir() -> PathBuf {
    std::env::temp_dir().join("loadout-update")
}

#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<Option<UpdateInfo>> {
    let current = app.package_info().version.to_string();
    let release =
        tauri::async_runtime::spawn_blocking(move || update::check(&current, install_kind()))
            .await
            .map_err(|e| format!("Internal error: {e}"))?
            .map_err(|e| e.user_message())?;
    let info = release.as_ref().map(|r| r.info.clone());
    if let Some(info) = &info {
        log::info!(
            "update available: {} -> {}",
            info.current_version,
            info.version
        );
    }
    *state.update.lock().unwrap_or_else(|p| p.into_inner()) = release;
    Ok(info)
}

/// Download the update, check it, install it and restart Loadout. On success
/// this never returns: Loadout exits so the new version can take its place.
#[tauri::command]
pub async fn install_update(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let release = state
        .update
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .ok_or_else(|| "Check for updates first.".to_string())?;
    let exe = std::env::current_exe().map_err(|e| format!("Couldn't find Loadout's exe: {e}"))?;
    let dest = match release.info.kind {
        InstallKind::Installer => update_download_dir().join(&release.asset_name),
        // Next to the exe, so swapping them is a rename on the same drive.
        InstallKind::Portable => {
            let name = exe
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Loadout.exe".into());
            exe.with_file_name(format!(".{name}.download"))
        }
    };

    let emitter = app.clone();
    let version = release.info.version.clone();
    let downloaded = dest.clone();
    let to_download = release.clone();
    tauri::async_runtime::spawn_blocking(move || {
        update::download(&to_download, &downloaded, &mut |done, total| {
            let _ = emitter.emit(
                UPDATE_PROGRESS_EVENT,
                Progress {
                    stage: ProgressStage::Copying,
                    done,
                    total,
                    message: format!("Downloading Loadout {version}"),
                },
            );
        })
    })
    .await
    .map_err(|e| format!("Internal error: {e}"))?
    .map_err(|e| {
        log::warn!("update download failed: {e}");
        e.user_message()
    })?;

    match release.info.kind {
        InstallKind::Installer => {
            // Passive install: a progress bar only. It closes Loadout if it's still
            // running, keeps the shortcuts (/UPDATE) and starts the new version (/R).
            std::process::Command::new(&dest)
                .args(["/P", "/R", "/UPDATE"])
                .spawn()
                .map_err(|e| format!("Couldn't start the installer: {e}"))?;
        }
        InstallKind::Portable => {
            update::swap_exe(&exe, &dest).map_err(|e| {
                let _ = std::fs::remove_file(&dest);
                format!(
                    "{} Download the new version from the release page instead.",
                    e.user_message()
                )
            })?;
            // The new exe waits for this one to exit (single-instance would
            // otherwise hand over to us and quit).
            let mut command = std::process::Command::new(&exe);
            command
                .arg("--after-update")
                .arg(std::process::id().to_string());
            if let Some(dir) = exe.parent() {
                command.current_dir(dir);
            }
            command.spawn().map_err(|e| {
                format!("Updated, but couldn't restart Loadout ({e}). Start it again yourself.")
            })?;
        }
    }
    log::info!("installing Loadout {}, exiting", release.info.version);
    app.exit(0);
    Ok(())
}

/// The release page in the browser: the fallback when an update can't install.
#[tauri::command]
pub async fn open_release_page(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let url = state
        .update
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(|r| r.info.release_url.clone())
        .unwrap_or_else(|| "https://github.com/aidangilmartin/toolkit/releases/latest".into());
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("Couldn't open the browser: {e}"))
}
