//! Finds the folders Loadout works with. Detection order for each folder:
//! user override → well-known location → registry hint → not found.

use std::path::{Path, PathBuf};

use crate::model::{PathInfo, PathKey, PathOverrides, PathSource};

/// The Windows "known folders" we start from. Tests point these at temp dirs.
#[derive(Debug, Clone, Default)]
pub struct SystemDirs {
    /// `%LOCALAPPDATA%`
    pub local_app_data: Option<PathBuf>,
    /// `%APPDATA%` (roaming)
    pub roaming_app_data: Option<PathBuf>,
    /// The user's Documents folder (may be redirected to OneDrive).
    pub documents: Option<PathBuf>,
}

impl SystemDirs {
    pub fn from_os() -> Self {
        Self {
            local_app_data: dirs::data_local_dir(),
            roaming_app_data: dirs::config_dir(),
            documents: dirs::document_dir(),
        }
    }
}

/// Registry lookups, behind a trait so detection is testable off Windows.
pub trait RegistryProbe: Send + Sync {
    /// The command registered for `fivem://` links (points at FiveM.exe).
    fn fivem_protocol_command(&self) -> Option<String>;
    /// GTA V install folders known to Rockstar/Steam/Epic launchers.
    fn gta_install_candidates(&self) -> Vec<PathBuf>;
}

pub struct NoRegistry;

impl RegistryProbe for NoRegistry {
    fn fivem_protocol_command(&self) -> Option<String> {
        None
    }
    fn gta_install_candidates(&self) -> Vec<PathBuf> {
        Vec::new()
    }
}

#[cfg(windows)]
pub struct WindowsRegistry;

#[cfg(windows)]
impl RegistryProbe for WindowsRegistry {
    fn fivem_protocol_command(&self) -> Option<String> {
        use winreg::enums::{HKEY_CLASSES_ROOT, HKEY_CURRENT_USER};
        use winreg::RegKey;
        let paths = [
            (
                HKEY_CURRENT_USER,
                r"Software\Classes\fivem\shell\open\command",
            ),
            (HKEY_CLASSES_ROOT, r"fivem\shell\open\command"),
        ];
        paths.iter().find_map(|(hive, path)| {
            RegKey::predef(*hive)
                .open_subkey(path)
                .ok()?
                .get_value::<String, _>("")
                .ok()
        })
    }

    fn gta_install_candidates(&self) -> Vec<PathBuf> {
        use winreg::enums::HKEY_LOCAL_MACHINE;
        use winreg::RegKey;
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        let mut out = Vec::new();
        let keys = [
            (
                r"SOFTWARE\WOW6432Node\Rockstar Games\Grand Theft Auto V",
                "InstallFolder",
            ),
            (
                r"SOFTWARE\WOW6432Node\Rockstar Games\GTAV",
                "InstallFolderSteam",
            ),
            (
                r"SOFTWARE\WOW6432Node\Rockstar Games\GTAV",
                "InstallFolderEpic",
            ),
            (
                r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Steam App 271590",
                "InstallLocation",
            ),
        ];
        for (key, value) in keys {
            if let Ok(dir) = hklm
                .open_subkey(key)
                .and_then(|k| k.get_value::<String, _>(value))
            {
                let dir = PathBuf::from(dir.trim_matches('"'));
                out.push(dir.clone());
                // The Steam value is known to end in a bogus "\GTAV".
                if let Some(parent) = dir.parent() {
                    out.push(parent.to_path_buf());
                }
            }
        }
        out
    }
}

pub fn system_registry() -> Box<dyn RegistryProbe> {
    #[cfg(windows)]
    {
        Box::new(WindowsRegistry)
    }
    #[cfg(not(windows))]
    {
        Box::new(NoRegistry)
    }
}

/// Every path Loadout needs, resolved once per operation.
#[derive(Debug, Clone, Default)]
pub struct ResolvedPaths {
    pub fivem_app_dir: Option<PathBuf>,
    pub fivem_exe: Option<PathBuf>,
    pub citizenfx_dir: Option<PathBuf>,
    pub gta_install_dir: Option<PathBuf>,
    pub gta_documents_dir: Option<PathBuf>,
    pub info: Vec<PathInfo>,
}

impl ResolvedPaths {
    /// `%APPDATA%\CitizenFX\gta5_settings.xml`
    pub fn fivem_settings_xml(&self) -> Option<PathBuf> {
        self.citizenfx_dir
            .as_ref()
            .map(|d| d.join("gta5_settings.xml"))
    }

    /// `%APPDATA%\CitizenFX\fivem.cfg`
    pub fn fivem_cfg(&self) -> Option<PathBuf> {
        self.citizenfx_dir.as_ref().map(|d| d.join("fivem.cfg"))
    }

    /// `Documents\Rockstar Games\GTA V\settings.xml`
    pub fn gta_settings_xml(&self) -> Option<PathBuf> {
        self.gta_documents_dir
            .as_ref()
            .map(|d| d.join("settings.xml"))
    }

    pub fn root_dir(&self, root: crate::model::InstallRoot) -> Option<&Path> {
        match root {
            crate::model::InstallRoot::FivemApp => self.fivem_app_dir.as_deref(),
            crate::model::InstallRoot::GtaInstall => self.gta_install_dir.as_deref(),
        }
    }
}

pub fn resolve(
    sys: &SystemDirs,
    registry: &dyn RegistryProbe,
    overrides: &PathOverrides,
) -> ResolvedPaths {
    let mut info = Vec::new();

    // FiveM.app
    let fivem_override = non_empty(&overrides.fivem_app_dir);
    let fivem_detected = || {
        let mut candidates = Vec::new();
        if let Some(local) = &sys.local_app_data {
            candidates.push(local.join("FiveM").join("FiveM.app"));
            candidates.push(local.join("FiveM").join("FiveM Application Data"));
        }
        if let Some(exe) = registry
            .fivem_protocol_command()
            .and_then(|cmd| exe_from_command(&cmd))
        {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join("FiveM.app"));
            }
        }
        candidates.into_iter().find(|p| p.is_dir())
    };
    let fivem_app_dir = pick(
        &mut info,
        PathKey::FivemApp,
        "FiveM application data (FiveM.app)",
        fivem_override,
        fivem_detected,
        "Usually %LOCALAPPDATA%\\FiveM\\FiveM.app. Needed for citizen packs, mods and ReShade.",
    );
    let fivem_exe = fivem_app_dir
        .as_ref()
        .and_then(|d| d.parent())
        .map(|d| d.join("FiveM.exe"))
        .filter(|p| p.is_file())
        .or_else(|| {
            registry
                .fivem_protocol_command()
                .and_then(|cmd| exe_from_command(&cmd))
                .filter(|p| p.is_file())
        });

    // CitizenFX (FiveM's settings folder)
    let citizenfx_override = non_empty(&overrides.citizenfx_dir);
    let citizenfx_dir = pick(
        &mut info,
        PathKey::CitizenFx,
        "FiveM settings (CitizenFX)",
        citizenfx_override,
        || {
            sys.roaming_app_data
                .as_ref()
                .map(|d| d.join("CitizenFX"))
                .filter(|p| p.is_dir())
        },
        "Usually %APPDATA%\\CitizenFX. Holds gta5_settings.xml and fivem.cfg.",
    );

    // GTA V install folder
    let gta_override = non_empty(&overrides.gta_install_dir);
    let gta_detected = || {
        let mut candidates = Vec::new();
        if let Some(app) = &fivem_app_dir {
            if let Some(dir) = read_iv_path(&app.join("CitizenFX.ini")) {
                candidates.push(dir);
            }
        }
        candidates.extend(registry.gta_install_candidates());
        candidates.into_iter().find(|p| is_gta_dir(p))
    };
    let gta_install_dir = pick(
        &mut info,
        PathKey::GtaInstall,
        "GTA V game folder",
        gta_override,
        gta_detected,
        "The folder that contains GTA5.exe. Only needed for sound packs that replace game audio.",
    );

    // Documents\Rockstar Games\GTA V
    let docs_override = non_empty(&overrides.gta_documents_dir);
    let gta_documents_dir = pick(
        &mut info,
        PathKey::GtaDocuments,
        "GTA V settings (Documents)",
        docs_override,
        || {
            sys.documents
                .as_ref()
                .map(|d| d.join("Rockstar Games").join("GTA V"))
                .filter(|p| p.is_dir())
        },
        "Documents\\Rockstar Games\\GTA V. Only needed to apply graphics to Story Mode / GTA Online too.",
    );

    ResolvedPaths {
        fivem_app_dir,
        fivem_exe,
        citizenfx_dir,
        gta_install_dir,
        gta_documents_dir,
        info,
    }
}

fn non_empty(value: &Option<String>) -> Option<PathBuf> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn pick(
    info: &mut Vec<PathInfo>,
    key: PathKey,
    label: &str,
    override_path: Option<PathBuf>,
    detect: impl FnOnce() -> Option<PathBuf>,
    hint: &str,
) -> Option<PathBuf> {
    let (path, source) = match override_path {
        Some(p) => (Some(p), PathSource::Override),
        None => match detect() {
            Some(p) => (Some(p), PathSource::Detected),
            None => (None, PathSource::Missing),
        },
    };
    let exists = path.as_ref().is_some_and(|p| p.is_dir());
    info.push(PathInfo {
        key,
        label: label.into(),
        path: path.as_ref().map(|p| p.display().to_string()),
        exists,
        source,
        hint: hint.into(),
    });
    path.filter(|p| p.is_dir())
}

/// `"C:\Users\me\AppData\Local\FiveM\FiveM.exe" "%1"` → the exe path.
pub fn exe_from_command(command: &str) -> Option<PathBuf> {
    let command = command.trim();
    let exe = if let Some(rest) = command.strip_prefix('"') {
        rest.split('"').next()?
    } else {
        let lower = command.to_ascii_lowercase();
        let end = lower.find(".exe").map(|i| i + 4).unwrap_or(command.len());
        &command[..end]
    };
    let exe = exe.trim();
    (!exe.is_empty()).then(|| PathBuf::from(exe))
}

/// Read `[Game] IVPath=` from FiveM's CitizenFX.ini.
pub fn read_iv_path(ini: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(ini).ok()?;
    let mut in_game = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_game = line.eq_ignore_ascii_case("[game]");
            continue;
        }
        if !in_game {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            if key.trim().eq_ignore_ascii_case("IVPath") {
                let value = value.trim().trim_matches('"');
                if !value.is_empty() {
                    return Some(PathBuf::from(value));
                }
            }
        }
    }
    None
}

pub fn is_gta_dir(dir: &Path) -> bool {
    dir.join("GTA5.exe").is_file() || dir.join("PlayGTAV.exe").is_file()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct FakeRegistry(Option<String>, Vec<PathBuf>);
    impl RegistryProbe for FakeRegistry {
        fn fivem_protocol_command(&self) -> Option<String> {
            self.0.clone()
        }
        fn gta_install_candidates(&self) -> Vec<PathBuf> {
            self.1.clone()
        }
    }

    #[test]
    fn detects_default_layout_and_iv_path() {
        let tmp = tempfile::tempdir().unwrap();
        let local = tmp.path().join("Local");
        let roaming = tmp.path().join("Roaming");
        let docs = tmp.path().join("Documents");
        let gta = tmp.path().join("Games/GTAV");
        fs::create_dir_all(local.join("FiveM/FiveM.app")).unwrap();
        fs::write(local.join("FiveM/FiveM.exe"), b"").unwrap();
        fs::create_dir_all(roaming.join("CitizenFX")).unwrap();
        fs::create_dir_all(docs.join("Rockstar Games/GTA V")).unwrap();
        fs::create_dir_all(&gta).unwrap();
        fs::write(gta.join("GTA5.exe"), b"").unwrap();
        fs::write(
            local.join("FiveM/FiveM.app/CitizenFX.ini"),
            format!("[Game]\r\nIVPath={}\r\n", gta.display()),
        )
        .unwrap();

        let sys = SystemDirs {
            local_app_data: Some(local.clone()),
            roaming_app_data: Some(roaming.clone()),
            documents: Some(docs.clone()),
        };
        let paths = resolve(&sys, &NoRegistry, &PathOverrides::default());
        assert_eq!(paths.fivem_app_dir, Some(local.join("FiveM/FiveM.app")));
        assert_eq!(paths.fivem_exe, Some(local.join("FiveM/FiveM.exe")));
        assert_eq!(paths.citizenfx_dir, Some(roaming.join("CitizenFX")));
        assert_eq!(paths.gta_install_dir, Some(gta));
        assert_eq!(
            paths.gta_documents_dir,
            Some(docs.join("Rockstar Games/GTA V"))
        );
        assert!(paths
            .info
            .iter()
            .all(|i| i.exists && i.source == PathSource::Detected));
    }

    #[test]
    fn overrides_win_and_missing_paths_are_reported() {
        let tmp = tempfile::tempdir().unwrap();
        let custom = tmp.path().join("D/FiveM.app");
        fs::create_dir_all(&custom).unwrap();
        let overrides = PathOverrides {
            fivem_app_dir: Some(custom.display().to_string()),
            ..Default::default()
        };
        let paths = resolve(&SystemDirs::default(), &NoRegistry, &overrides);
        assert_eq!(paths.fivem_app_dir, Some(custom));
        let fivem = &paths.info[0];
        assert_eq!(fivem.source, PathSource::Override);
        let gta = paths
            .info
            .iter()
            .find(|i| i.key == PathKey::GtaInstall)
            .unwrap();
        assert_eq!(gta.source, PathSource::Missing);
        assert!(paths.gta_install_dir.is_none());
    }

    #[test]
    fn registry_fallbacks() {
        let tmp = tempfile::tempdir().unwrap();
        let install = tmp.path().join("Apps/FiveM");
        fs::create_dir_all(install.join("FiveM.app")).unwrap();
        fs::write(install.join("FiveM.exe"), b"").unwrap();
        let gta = tmp.path().join("Steam/GTAV");
        fs::create_dir_all(&gta).unwrap();
        fs::write(gta.join("GTA5.exe"), b"").unwrap();
        let reg = FakeRegistry(
            Some(format!(
                "\"{}\" \"%1\"",
                install.join("FiveM.exe").display()
            )),
            vec![tmp.path().join("nope"), gta.clone()],
        );
        let paths = resolve(&SystemDirs::default(), &reg, &PathOverrides::default());
        assert_eq!(paths.fivem_app_dir, Some(install.join("FiveM.app")));
        assert_eq!(paths.fivem_exe, Some(install.join("FiveM.exe")));
        assert_eq!(paths.gta_install_dir, Some(gta));
    }

    #[test]
    fn parses_protocol_commands() {
        assert_eq!(
            exe_from_command(r#""C:\FiveM\FiveM.exe" "%1""#),
            Some(PathBuf::from(r"C:\FiveM\FiveM.exe"))
        );
        assert_eq!(
            exe_from_command(r"C:\FiveM\FiveM.exe %1"),
            Some(PathBuf::from(r"C:\FiveM\FiveM.exe"))
        );
    }
}
