//! Tauri commands for the sound maker (see loadout_core::soundmaker). Its logic runs in the web
//! view; these hand it files and the CodeWalker bridge. File contents travel as raw bytes, not
//! JSON arrays, since sound banks are megabytes.

use std::path::PathBuf;
use std::sync::Arc;

use loadout_core::soundmaker::{BridgeError, BridgeSource, FileStat, SoundMaker};
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt;

pub struct SoundMakerState(pub Arc<SoundMaker>);

type CmdResult<T> = Result<T, String>;

const PROGRESS_EVENT: &str = "soundmaker://progress";

/// The bridge built into this exe (see build.rs), or `LOADOUT_BRIDGE` in development.
pub fn bridge_source() -> BridgeSource {
    if let Some(path) = std::env::var_os("LOADOUT_BRIDGE") {
        return BridgeSource::Path(PathBuf::from(path));
    }
    #[cfg(embedded_bridge)]
    {
        BridgeSource::Embedded(include_bytes!(env!("LOADOUT_BRIDGE_EXE")))
    }
    #[cfg(not(embedded_bridge))]
    {
        BridgeSource::None
    }
}

async fn run<T, F>(state: &State<'_, SoundMakerState>, f: F) -> CmdResult<T>
where
    T: Send + 'static,
    F: FnOnce(&SoundMaker) -> loadout_core::Result<T> + Send + 'static,
{
    let sm = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || f(&sm))
        .await
        .map_err(|e| format!("Internal error: {e}"))?
        .map_err(|e| {
            log::warn!("sound maker: {e}");
            e.user_message()
        })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundMakerInfo {
    root: String,
    bridge_available: bool,
    app_version: String,
}

#[tauri::command]
pub fn sm_info(app: AppHandle, state: State<'_, SoundMakerState>) -> SoundMakerInfo {
    SoundMakerInfo {
        root: state.0.root().display().to_string(),
        bridge_available: state.0.bridge_available(),
        app_version: app.package_info().version.to_string(),
    }
}

#[tauri::command]
pub async fn sm_stat(
    state: State<'_, SoundMakerState>,
    path: String,
) -> CmdResult<Option<FileStat>> {
    run(&state, move |sm| sm.stat(&path)).await
}

#[tauri::command]
pub async fn sm_read_dir(
    state: State<'_, SoundMakerState>,
    path: String,
) -> CmdResult<Vec<String>> {
    run(&state, move |sm| sm.read_dir(&path)).await
}

#[tauri::command]
pub async fn sm_read_file(state: State<'_, SoundMakerState>, path: String) -> CmdResult<Response> {
    run(&state, move |sm| sm.read_file(&path))
        .await
        .map(Response::new)
}

/// The bytes are the raw request body; the path is in the `path` header (URI-encoded).
#[tauri::command]
pub async fn sm_write_file(
    state: State<'_, SoundMakerState>,
    request: Request<'_>,
) -> CmdResult<()> {
    let path = request
        .headers()
        .get("path")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .ok_or("No path given")?;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => return Err("Expected raw bytes".into()),
    };
    run(&state, move |sm| sm.write_file(&path, &bytes)).await
}

#[tauri::command]
pub async fn sm_mkdir(state: State<'_, SoundMakerState>, path: String) -> CmdResult<()> {
    run(&state, move |sm| sm.mkdir(&path)).await
}

#[tauri::command]
pub async fn sm_remove(state: State<'_, SoundMakerState>, path: String) -> CmdResult<()> {
    run(&state, move |sm| sm.remove(&path)).await
}

#[tauri::command]
pub async fn sm_rename(
    state: State<'_, SoundMakerState>,
    from: String,
    to: String,
) -> CmdResult<()> {
    run(&state, move |sm| sm.rename(&from, &to)).await
}

#[tauri::command]
pub async fn sm_copy(state: State<'_, SoundMakerState>, from: String, to: String) -> CmdResult<()> {
    run(&state, move |sm| sm.copy(&from, &to)).await
}

#[tauri::command]
pub async fn sm_make_temp_dir(
    state: State<'_, SoundMakerState>,
    prefix: String,
) -> CmdResult<String> {
    run(&state, move |sm| sm.make_temp_dir(&prefix))
        .await
        .map(|p| p.display().to_string())
}

/// Runs a bridge command. Progress lines are sent as `soundmaker://progress` events. Errors
/// come back as `{ code, message }`.
#[tauri::command]
pub async fn sm_run_bridge(
    app: AppHandle,
    state: State<'_, SoundMakerState>,
    args: Vec<String>,
) -> Result<serde_json::Value, BridgeError> {
    let sm = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        log::info!("bridge: {}", args.first().map(String::as_str).unwrap_or(""));
        sm.run_bridge(&args, &mut |message| {
            let _ = app.emit(PROGRESS_EVENT, message);
        })
        .inspect_err(|e| log::warn!("bridge failed ({}): {}", e.code, e.message))
    })
    .await
    .map_err(|e| BridgeError {
        code: "crash".into(),
        message: format!("Internal error: {e}"),
    })?
}

#[tauri::command]
pub fn sm_show_in_folder(app: AppHandle, path: String) -> CmdResult<()> {
    app.opener()
        .reveal_item_in_dir(PathBuf::from(path))
        .map_err(|e| format!("Couldn't open the folder: {e}"))
}

#[tauri::command]
pub fn sm_open_url(app: AppHandle, url: String) -> CmdResult<()> {
    if !url.starts_with("https://") {
        return Err("Only https links can be opened.".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("Couldn't open the link: {e}"))
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(b) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::percent_decode;

    #[test]
    fn decodes_header_paths() {
        assert_eq!(
            percent_decode("C%3A%5CUsers%5Cn%C3%A9%5Cmy%20pack%5CREADME.txt"),
            "C:\\Users\\né\\my pack\\README.txt"
        );
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("a%2"), "a%2");
        assert_eq!(percent_decode("%é"), "%é");
    }
}
