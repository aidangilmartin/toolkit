//! Types shared with the UI. Every type here derives `TS`, and `cargo test`
//! regenerates `src/bindings/*.ts` from them.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct PathOverrides {
    pub fivem_app_dir: Option<String>,
    pub citizenfx_dir: Option<String>,
    pub gta_install_dir: Option<String>,
    pub gta_documents_dir: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AfterLaunch {
    #[default]
    KeepOpen,
    Minimize,
    Close,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct AppConfig {
    pub paths: PathOverrides,
    pub after_launch: AfterLaunch,
    /// Show the "these files will change" preview before applying.
    pub confirm_file_changes: bool,
    pub setup_complete: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            paths: PathOverrides::default(),
            after_launch: AfterLaunch::KeepOpen,
            confirm_file_changes: true,
            setup_complete: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Profiles & servers
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct Profile {
    pub id: String,
    pub name: String,
    /// Accent colour, `#rrggbb`.
    pub color: String,
    pub notes: String,
    /// Partial overlay for settings.xml: `"graphics/ShadowQuality" -> "1"`.
    pub graphics: BTreeMap<String, String>,
    /// Also write the graphics overlay to GTA V's own settings.xml (Story/Online).
    pub apply_to_gta: bool,
    /// Partial overlay for fivem.cfg: `"profile_fpsFieldOfView" -> "5"`.
    pub fivem_cfg: BTreeMap<String, String>,
    /// Pack ids in priority order (a later pack wins when two packs ship the same file).
    pub packs: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl Default for Profile {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            color: "#34d399".into(),
            notes: String::new(),
            graphics: BTreeMap::new(),
            apply_to_gta: false,
            fivem_cfg: BTreeMap::new(),
            packs: Vec::new(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct Server {
    pub id: String,
    pub name: String,
    /// `ip:port`, a hostname, or `cfx.re/join/<code>`.
    pub address: String,
    /// Profile applied before connecting. `None` connects without changing anything.
    pub profile_id: Option<String>,
    pub last_played_at: Option<String>,
}

// ---------------------------------------------------------------------------
// Packs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PackCategory {
    SoundPack,
    Citizen,
    Mods,
    Reshade,
    Other,
}

/// Which folder a pack installs into.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum InstallRoot {
    /// `%LOCALAPPDATA%\FiveM\FiveM.app`
    FivemApp,
    /// The GTA V install folder (where GTA5.exe lives).
    GtaInstall,
}

impl InstallRoot {
    pub fn label(self) -> &'static str {
        match self {
            InstallRoot::FivemApp => "FiveM.app",
            InstallRoot::GtaInstall => "GTA V folder",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PackFile {
    /// Destination path relative to the pack's root, `a/b/c.rpf`.
    pub path: String,
    pub size: u64,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Pack {
    pub id: String,
    pub name: String,
    pub category: PackCategory,
    pub root: InstallRoot,
    pub files: Vec<PackFile>,
    /// Readmes/screenshots kept with the pack but never installed.
    #[serde(default)]
    pub docs: Vec<String>,
    pub total_size: u64,
    pub source_name: String,
    pub imported_at: String,
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ProposedFileKind {
    /// Installed into the game when the pack is enabled.
    Deploy,
    /// Kept with the pack (readme, screenshots) but never installed.
    Doc,
    /// Junk (`__MACOSX`, `Thumbs.db`…) or a duplicate.
    Ignored,
    /// Not allowed (executables, script hooks, files outside safe folders).
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProposedFile {
    /// Path inside the source folder/archive.
    pub source: String,
    /// Destination relative to the install root (docs: relative to the pack's docs folder).
    pub dest: String,
    pub kind: ProposedFileKind,
    pub reason: Option<String>,
    pub size: u64,
    pub include: bool,
}

/// Where a pack's files go. Detected on import, and the user can override it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PackLayout {
    /// Keep the pack's own `citizen/`, `mods/`, `plugins/` folders under FiveM.app.
    FivemTree,
    /// Every `.rpf` goes into `FiveM.app/mods`.
    ModsFolder,
    /// Everything goes into `FiveM.app/plugins` (ReShade).
    PluginsFolder,
    /// Audio `.rpf` files replace the game's own in `GTA V/x64/audio/sfx`.
    GtaAudio,
}

impl PackLayout {
    pub fn root(self) -> InstallRoot {
        match self {
            PackLayout::GtaAudio => InstallRoot::GtaInstall,
            _ => InstallRoot::FivemApp,
        }
    }
}

/// What the import wizard shows before anything is copied. The UI can edit
/// name/category/include and hands the same structure back to import.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImportProposal {
    pub source_path: String,
    pub source_name: String,
    pub name: String,
    pub category: PackCategory,
    pub layout: PackLayout,
    pub root: InstallRoot,
    pub files: Vec<ProposedFile>,
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// Settings targets, plans and results
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SettingsTarget {
    /// `%APPDATA%\CitizenFX\gta5_settings.xml`
    FivemGraphics,
    /// `Documents\Rockstar Games\GTA V\settings.xml`
    GtaGraphics,
    /// `%APPDATA%\CitizenFX\fivem.cfg`
    FivemCfg,
}

impl SettingsTarget {
    pub fn label(self) -> &'static str {
        match self {
            SettingsTarget::FivemGraphics => "FiveM graphics (gta5_settings.xml)",
            SettingsTarget::GtaGraphics => "GTA V graphics (settings.xml)",
            SettingsTarget::FivemCfg => "FiveM in-game settings (fivem.cfg)",
        }
    }

    pub fn file_stem(self) -> &'static str {
        match self {
            SettingsTarget::FivemGraphics => "fivem-gta5_settings.xml",
            SettingsTarget::GtaGraphics => "gta-settings.xml",
            SettingsTarget::FivemCfg => "fivem.cfg",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KeyChange {
    pub key: String,
    pub from: Option<String>,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SettingsFilePlan {
    pub target: SettingsTarget,
    pub path: String,
    pub changes: Vec<KeyChange>,
    /// Keys that couldn't be written (no matching section in the file).
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum FileOpKind {
    /// Copy a pack file into the game (backing up anything it replaces).
    Install,
    /// Swap one of our files for another pack's version.
    Replace,
    /// Take a pack file out again (restoring the original if there was one).
    Remove,
    /// The file was changed by something else (e.g. a FiveM update); leave it alone.
    Forget,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileOpPlan {
    pub kind: FileOpKind,
    pub root: InstallRoot,
    pub path: String,
    pub pack_name: Option<String>,
    pub size: u64,
    pub backs_up_original: bool,
    pub restores_original: bool,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PackConflict {
    pub root: InstallRoot,
    pub path: String,
    pub packs: Vec<String>,
    pub winner: String,
}

/// Dry-run result shown in the apply preview.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ApplyPlan {
    pub profile_id: Option<String>,
    pub profile_name: Option<String>,
    pub settings: Vec<SettingsFilePlan>,
    pub files: Vec<FileOpPlan>,
    pub conflicts: Vec<PackConflict>,
    pub warnings: Vec<String>,
    /// Problems that stop the apply (missing folders, invalid values…).
    pub errors: Vec<String>,
    pub copy_bytes: u64,
    pub running_processes: Vec<String>,
}

impl ApplyPlan {
    pub fn has_changes(&self) -> bool {
        !self.settings.iter().all(|s| s.changes.is_empty()) || !self.files.is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ApplyResult {
    pub plan: ApplyPlan,
    pub applied_at: String,
    pub snapshot_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Ledger (what Loadout has put into the game folders)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OriginalBackup {
    /// File name inside `backups/originals`.
    pub file: String,
    pub hash: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DeployedFile {
    pub root: InstallRoot,
    /// Absolute root folder at the time of deployment.
    pub root_dir: String,
    /// Path relative to `root_dir`, with the casing that's on disk.
    pub path: String,
    pub pack_id: String,
    /// Path of the source file inside the pack.
    pub pack_path: String,
    pub hash: String,
    pub size: u64,
    pub mtime_ms: i64,
    pub original: Option<OriginalBackup>,
    /// Folders we had to create for this file (removed again when empty).
    #[serde(default)]
    pub created_dirs: Vec<String>,
}

/// Overlay values as they were written, used to spot in-game changes later.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct AppliedSettings {
    pub graphics: BTreeMap<String, String>,
    pub apply_to_gta: bool,
    pub fivem_cfg: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct DeployState {
    pub active_profile_id: Option<String>,
    pub applied_at: Option<String>,
    pub applied: AppliedSettings,
    pub files: Vec<DeployedFile>,
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PathKey {
    FivemApp,
    CitizenFx,
    GtaInstall,
    GtaDocuments,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PathSource {
    Override,
    Detected,
    Missing,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PathInfo {
    pub key: PathKey,
    pub label: String,
    pub path: Option<String>,
    pub exists: bool,
    pub source: PathSource,
    pub hint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SettingsDrift {
    pub target: SettingsTarget,
    pub key: String,
    pub applied: String,
    pub current: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppStatus {
    pub paths: Vec<PathInfo>,
    pub fivem_exe: Option<String>,
    pub running_processes: Vec<String>,
    pub active_profile_id: Option<String>,
    pub applied_at: Option<String>,
    pub settings_drift: Vec<SettingsDrift>,
    /// Pack files that were changed or removed by something else since we installed them.
    pub file_drift: Vec<String>,
    pub deployed_files: Vec<DeployedFile>,
    /// Set when an interrupted apply was rolled back at startup.
    pub recovery_notice: Option<String>,
    pub data_dir: String,
}

/// The raw values currently on disk, plus the subset Loadout would capture
/// into a profile by default.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CapturedSettings {
    pub fivem_graphics_found: bool,
    pub graphics_all: BTreeMap<String, String>,
    pub graphics_default: BTreeMap<String, String>,
    pub fivem_cfg_found: bool,
    pub cfg_all: BTreeMap<String, String>,
    pub cfg_default: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SnapshotFile {
    pub target: SettingsTarget,
    /// Where the file lives in the game folders.
    pub original_path: String,
    /// File name inside the snapshot folder.
    pub file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Snapshot {
    pub id: String,
    pub created_at: String,
    pub label: String,
    pub files: Vec<SnapshotFile>,
    /// Pinned snapshots (the first-run backup) are never pruned.
    pub pinned: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ProgressStage {
    Preparing,
    Copying,
    Writing,
    Finishing,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Progress {
    pub stage: ProgressStage,
    pub done: u64,
    pub total: u64,
    pub message: String,
}
