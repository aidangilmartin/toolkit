//! Starting FiveM the way Windows Explorer does.
//!
//! FiveM refuses to start when another program launches it ("This application
//! should be launched directly from the shell or a web browser"), and refuses to
//! run as administrator. So Loadout doesn't start it itself: it asks the desktop's
//! Explorer to open `FiveM.exe` or the `fivem://` link, exactly as if the player
//! had double-clicked it. The process then belongs to Explorer and isn't elevated,
//! even when Loadout is. (The technique is from Raymond Chen's "How can I launch
//! an unelevated process from my elevated process, and vice versa?")

use std::path::Path;

/// Open `target` (a program or a URL) through the Windows shell.
#[cfg(windows)]
pub fn open(target: &str, working_dir: Option<&Path>) -> Result<(), String> {
    let owned = (
        target.to_string(),
        working_dir.map(|d| d.display().to_string()),
    );
    match via_desktop(owned.0, String::new(), owned.1.unwrap_or_default()) {
        Ok(()) => Ok(()),
        Err(err) => {
            log::warn!("the desktop shell couldn't open {target} ({err}); using explorer.exe");
            explorer_exe(target)
        }
    }
}

/// Start `program` with command-line `args` through the Windows shell. There's
/// no fallback here (`explorer.exe` can't pass arguments on), so the caller
/// decides what to do if this fails.
#[cfg(windows)]
pub fn open_with_args(
    program: &Path,
    args: &str,
    working_dir: Option<&Path>,
) -> Result<(), String> {
    via_desktop(
        program.display().to_string(),
        args.to_string(),
        working_dir
            .map(|d| d.display().to_string())
            .unwrap_or_default(),
    )
}

#[cfg(windows)]
fn via_desktop(target: String, args: String, working_dir: String) -> Result<(), String> {
    // COM needs an apartment of its own, so talk to Explorer from a fresh thread.
    std::thread::spawn(move || unsafe { desktop_shell_execute(&target, &args, &working_dir) })
        .join()
        .map_err(|_| "The Windows shell call failed.".to_string())?
        .map_err(|e| e.to_string())
}

/// Ask the desktop window's Explorer to `ShellExecute` the target.
#[cfg(windows)]
unsafe fn desktop_shell_execute(
    target: &str,
    args: &str,
    working_dir: &str,
) -> windows::core::Result<()> {
    use windows::core::{Interface, BSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IServiceProvider, CLSCTX_ALL,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Shell::{
        IShellBrowser, IShellDispatch2, IShellFolderViewDual, IShellWindows, SID_STopLevelBrowser,
        ShellWindows, CSIDL_DESKTOP, SVGIO_BACKGROUND, SWC_DESKTOP, SWFO_NEEDDISPATCH,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
        let result = (|| {
            let windows: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_ALL)?;
            let desktop = VARIANT::from(CSIDL_DESKTOP as i32);
            let empty = VARIANT::default();
            let mut hwnd = 0i32;
            let dispatch = windows.FindWindowSW(
                &desktop,
                &empty,
                SWC_DESKTOP,
                &mut hwnd,
                SWFO_NEEDDISPATCH,
            )?;
            let browser: IShellBrowser = dispatch
                .cast::<IServiceProvider>()?
                .QueryService(&SID_STopLevelBrowser)?;
            let view = browser.QueryActiveShellView()?;
            let folder: IShellFolderViewDual = view.GetItemObject(SVGIO_BACKGROUND)?;
            let shell: IShellDispatch2 = folder.Application()?.cast()?;
            shell.ShellExecute(
                &BSTR::from(target),
                &VARIANT::from(args),
                &VARIANT::from(working_dir),
                &VARIANT::from(""),
                &VARIANT::from(SW_SHOWNORMAL.0),
            )
        })();
        CoUninitialize();
        result
    }
}

/// Fallback when there's no desktop shell to ask (another shell, or Explorer
/// restarting): `explorer.exe <target>` hands the target to Explorer too.
#[cfg(windows)]
fn explorer_exe(target: &str) -> Result<(), String> {
    let windows_dir = std::env::var_os("SystemRoot")
        .or_else(|| std::env::var_os("windir"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| "C:\\Windows".into());
    std::process::Command::new(windows_dir.join("explorer.exe"))
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't ask Windows to start FiveM: {e}"))
}

#[cfg(not(windows))]
pub fn open(_target: &str, _working_dir: Option<&Path>) -> Result<(), String> {
    Err("Starting FiveM only works on Windows.".into())
}

#[cfg(not(windows))]
pub fn open_with_args(
    _program: &Path,
    _args: &str,
    _working_dir: Option<&Path>,
) -> Result<(), String> {
    Err("Starting FiveM only works on Windows.".into())
}
