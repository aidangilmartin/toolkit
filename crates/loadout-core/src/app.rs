//! `Loadout`: the API the desktop shell calls. It ties the store, path
//! detection, packs, the apply engine and backups together and guarantees only
//! one file-changing operation runs at a time.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use crate::backup;
use crate::deploy::{self, Hooks};
use crate::error::{Error, IoContext, Result};
use crate::fivem_cfg::{self, FivemCfg};
use crate::fsutil;
use crate::launch;
use crate::model::{
    AppConfig, AppStatus, ApplyPlan, ApplyResult, CapturedSettings, DeployState, ImportProposal,
    Pack, PackCategory, PackLayout, Profile, Progress, Server, SettingsDrift, SettingsTarget,
    Snapshot,
};
use crate::packs;
use crate::paths::{self, RegistryProbe, ResolvedPaths, SystemDirs};
use crate::process::ProcessProbe;
use crate::schema::{self, GraphicsSchema};
use crate::settings_xml::SettingsXml;
use crate::store::{self, Store};

pub struct Loadout {
    store: Store,
    sys: SystemDirs,
    registry: Box<dyn RegistryProbe>,
    processes: Box<dyn ProcessProbe>,
    op_lock: Mutex<()>,
    notice: Mutex<Option<String>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn valid_color(color: &str) -> bool {
    color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit())
}

impl Loadout {
    /// Open (or create) the data folder and recover from any interrupted apply.
    pub fn open(
        data_dir: impl Into<PathBuf>,
        sys: SystemDirs,
        registry: Box<dyn RegistryProbe>,
        processes: Box<dyn ProcessProbe>,
    ) -> Result<Self> {
        let store = Store::new(data_dir)?;
        packs::cleanup_staging(&store.packs_dir());
        let notice = deploy::recover(&store)?;
        Ok(Self {
            store,
            sys,
            registry,
            processes,
            op_lock: Mutex::new(()),
            notice: Mutex::new(notice),
        })
    }

    pub fn data_dir(&self) -> &Path {
        self.store.root()
    }

    // ---- Config & paths ---------------------------------------------------

    pub fn config(&self) -> Result<AppConfig> {
        self.store.load(store::CONFIG)
    }

    pub fn save_config(&self, mut config: AppConfig) -> Result<AppConfig> {
        for value in [
            &mut config.paths.fivem_app_dir,
            &mut config.paths.citizenfx_dir,
            &mut config.paths.gta_install_dir,
            &mut config.paths.gta_documents_dir,
        ] {
            *value = value
                .take()
                .map(|v| v.trim().trim_matches('"').to_string())
                .filter(|v| !v.is_empty());
        }
        let _guard = lock(&self.op_lock);
        self.store.save(store::CONFIG, &config)?;
        Ok(config)
    }

    pub fn paths(&self) -> Result<ResolvedPaths> {
        let config = self.config()?;
        Ok(paths::resolve(
            &self.sys,
            self.registry.as_ref(),
            &config.paths,
        ))
    }

    pub fn schema(&self) -> &'static GraphicsSchema {
        schema::schema()
    }

    fn state(&self) -> Result<DeployState> {
        self.store.load(store::STATE)
    }

    // ---- Status -------------------------------------------------------------

    pub fn running_processes(&self) -> Vec<String> {
        self.processes.running_game_processes()
    }

    pub fn close_game(&self) -> usize {
        self.processes.close_game_processes()
    }

    pub fn status(&self) -> Result<AppStatus> {
        let paths = self.paths()?;
        let state = self.state()?;
        let settings_drift = settings_drift(&paths, &state);
        let file_drift = state
            .files
            .iter()
            .filter(|entry| {
                let dest = fsutil::rel_to_path(Path::new(&entry.root_dir), &entry.path);
                !deploy::is_unchanged(&dest, entry)
            })
            .map(|entry| format!("{}/{}", entry.root.label(), entry.path))
            .collect();
        Ok(AppStatus {
            paths: paths.info.clone(),
            fivem_exe: paths.fivem_exe.as_ref().map(|p| p.display().to_string()),
            running_processes: self.running_processes(),
            active_profile_id: state.active_profile_id.clone(),
            applied_at: state.applied_at.clone(),
            settings_drift,
            file_drift,
            deployed_files: state.files.clone(),
            recovery_notice: lock(&self.notice).clone(),
            data_dir: self.store.root().display().to_string(),
        })
    }

    pub fn dismiss_notice(&self) {
        *lock(&self.notice) = None;
    }

    /// What's on disk right now, plus what a new profile would capture by default.
    pub fn capture(&self) -> Result<CapturedSettings> {
        let paths = self.paths()?;
        let mut captured = CapturedSettings::default();
        if let Some(path) = paths.fivem_settings_xml().filter(|p| p.is_file()) {
            let bytes = fs::read(&path).ctx_path("read", &path)?;
            let doc = SettingsXml::parse(&bytes).map_err(|message| Error::Parse {
                what: path.display().to_string(),
                message,
            })?;
            captured.fivem_graphics_found = true;
            captured.graphics_all = doc
                .values()
                .into_iter()
                .filter(|(k, _)| !schema::is_excluded(k))
                .collect();
            captured.graphics_default = schema::capture_defaults(&captured.graphics_all);
        }
        if let Some(path) = paths.fivem_cfg().filter(|p| p.is_file()) {
            let text = fs::read_to_string(&path).ctx_path("read", &path)?;
            captured.fivem_cfg_found = true;
            captured.cfg_all = FivemCfg::parse(&text)
                .values()
                .into_iter()
                .filter(|(k, v)| {
                    fivem_cfg::is_valid_key(k) && fivem_cfg::validate_value(k, v).is_ok()
                })
                .collect();
            captured.cfg_default = captured
                .cfg_all
                .iter()
                .filter(|(k, _)| k.to_ascii_lowercase().starts_with("profile_"))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
        }
        Ok(captured)
    }

    // ---- Profiles -----------------------------------------------------------

    pub fn profiles(&self) -> Result<Vec<Profile>> {
        self.store.load(store::PROFILES)
    }

    fn validate_profile(&self, profile: &mut Profile) -> Result<()> {
        profile.name = profile.name.trim().to_string();
        if profile.name.is_empty() || profile.name.chars().count() > 60 {
            return Err(Error::invalid(
                "Give the profile a name (up to 60 characters).",
            ));
        }
        if !valid_color(&profile.color) {
            profile.color = Profile::default().color;
        }
        let mut graphics = BTreeMap::new();
        for (key, value) in &profile.graphics {
            let canonical = schema::canonicalize(key, value).map_err(Error::Invalid)?;
            graphics.insert(key.clone(), canonical);
        }
        profile.graphics = graphics;
        for (key, value) in &profile.fivem_cfg {
            if !fivem_cfg::is_valid_key(key) {
                return Err(Error::invalid(format!(
                    "\"{key}\" isn't a valid FiveM setting name"
                )));
            }
            fivem_cfg::validate_value(key, value).map_err(Error::Invalid)?;
        }
        let packs = self.packs();
        let mut seen = Vec::new();
        for id in &profile.packs {
            if !packs.iter().any(|p| &p.id == id) {
                return Err(Error::invalid(
                    "One of the selected packs no longer exists.",
                ));
            }
            if !seen.contains(id) {
                seen.push(id.clone());
            }
        }
        profile.packs = seen;
        Ok(())
    }

    /// Create (empty id) or update a profile.
    pub fn save_profile(&self, mut profile: Profile) -> Result<Profile> {
        self.validate_profile(&mut profile)?;
        let _guard = lock(&self.op_lock);
        let mut profiles = self.profiles()?;
        let now = fsutil::now_rfc3339();
        profile.updated_at = now.clone();
        match profiles
            .iter_mut()
            .find(|p| !profile.id.is_empty() && p.id == profile.id)
        {
            Some(existing) => {
                profile.created_at = existing.created_at.clone();
                *existing = profile.clone();
            }
            None => {
                profile.id = fsutil::new_id();
                profile.created_at = now;
                profiles.push(profile.clone());
            }
        }
        self.store.save(store::PROFILES, &profiles)?;
        Ok(profile)
    }

    pub fn duplicate_profile(&self, id: &str) -> Result<Profile> {
        let original = self
            .profiles()?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| Error::NotFound("That profile".into()))?;
        let mut copy = original.clone();
        copy.id = String::new();
        copy.name = format!("{} (copy)", original.name)
            .chars()
            .take(60)
            .collect();
        self.save_profile(copy)
    }

    pub fn delete_profile(&self, id: &str) -> Result<()> {
        let _guard = lock(&self.op_lock);
        let mut profiles = self.profiles()?;
        let before = profiles.len();
        profiles.retain(|p| p.id != id);
        if profiles.len() == before {
            return Err(Error::NotFound("That profile".into()));
        }
        self.store.save(store::PROFILES, &profiles)?;
        let mut servers = self.servers()?;
        for server in servers
            .iter_mut()
            .filter(|s| s.profile_id.as_deref() == Some(id))
        {
            server.profile_id = None;
        }
        self.store.save(store::SERVERS, &servers)?;
        let mut state = self.state()?;
        if state.active_profile_id.as_deref() == Some(id) {
            state.active_profile_id = None;
            self.store.save(store::STATE, &state)?;
        }
        Ok(())
    }

    // ---- Servers ------------------------------------------------------------

    pub fn servers(&self) -> Result<Vec<Server>> {
        self.store.load(store::SERVERS)
    }

    pub fn save_server(&self, mut server: Server) -> Result<Server> {
        server.name = server.name.trim().to_string();
        server.address =
            launch::normalize_server_address(&server.address).map_err(Error::Invalid)?;
        if server.name.is_empty() {
            server.name = server.address.clone();
        }
        if server.name.chars().count() > 60 {
            return Err(Error::invalid("Server names can be up to 60 characters."));
        }
        if let Some(profile_id) = &server.profile_id {
            if !self.profiles()?.iter().any(|p| &p.id == profile_id) {
                return Err(Error::invalid("That profile no longer exists."));
            }
        }
        let _guard = lock(&self.op_lock);
        let mut servers = self.servers()?;
        match servers
            .iter_mut()
            .find(|s| !server.id.is_empty() && s.id == server.id)
        {
            Some(existing) => {
                server.last_played_at = existing.last_played_at.clone();
                *existing = server.clone();
            }
            None => {
                server.id = fsutil::new_id();
                servers.push(server.clone());
            }
        }
        self.store.save(store::SERVERS, &servers)?;
        Ok(server)
    }

    pub fn delete_server(&self, id: &str) -> Result<()> {
        let _guard = lock(&self.op_lock);
        let mut servers = self.servers()?;
        servers.retain(|s| s.id != id);
        self.store.save(store::SERVERS, &servers)
    }

    pub fn mark_played(&self, id: &str) -> Result<()> {
        let _guard = lock(&self.op_lock);
        let mut servers = self.servers()?;
        if let Some(server) = servers.iter_mut().find(|s| s.id == id) {
            server.last_played_at = Some(fsutil::now_rfc3339());
        }
        self.store.save(store::SERVERS, &servers)
    }

    // ---- Packs --------------------------------------------------------------

    pub fn packs(&self) -> Vec<Pack> {
        packs::load_all(&self.store.packs_dir())
    }

    pub fn inspect_pack(
        &self,
        source: &Path,
        layout: Option<PackLayout>,
    ) -> Result<ImportProposal> {
        packs::inspect(source, layout)
    }

    pub fn import_pack(
        &self,
        proposal: &ImportProposal,
        progress: &mut dyn FnMut(Progress),
    ) -> Result<Pack> {
        let _guard = lock(&self.op_lock);
        packs::import(&self.store.packs_dir(), proposal, progress)
    }

    pub fn update_pack(
        &self,
        id: &str,
        name: &str,
        category: PackCategory,
        notes: &str,
    ) -> Result<Pack> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 80 {
            return Err(Error::invalid(
                "Give the pack a name (up to 80 characters).",
            ));
        }
        let _guard = lock(&self.op_lock);
        let mut pack = self
            .packs()
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| Error::NotFound("That pack".into()))?;
        pack.name = name.to_string();
        pack.category = category;
        pack.notes = notes.chars().take(2000).collect();
        packs::save(&self.store.packs_dir(), &pack)?;
        Ok(pack)
    }

    pub fn delete_pack(&self, id: &str) -> Result<()> {
        let _guard = lock(&self.op_lock);
        if self.state()?.files.iter().any(|f| f.pack_id == id) {
            return Err(Error::invalid(
                "This pack is installed right now. Apply a profile without it (or restore vanilla) first.",
            ));
        }
        packs::delete(&self.store.packs_dir(), id)?;
        let mut profiles = self.profiles()?;
        for profile in profiles.iter_mut() {
            profile.packs.retain(|p| p != id);
        }
        self.store.save(store::PROFILES, &profiles)
    }

    pub fn pack_dir(&self, id: &str) -> PathBuf {
        self.store.packs_dir().join(id)
    }

    // ---- Apply ------------------------------------------------------------

    fn find_profile(&self, id: Option<&str>) -> Result<Option<Profile>> {
        match id {
            None => Ok(None),
            Some(id) => self
                .profiles()?
                .into_iter()
                .find(|p| p.id == id)
                .map(Some)
                .ok_or_else(|| Error::NotFound("That profile".into())),
        }
    }

    /// Dry run: what applying `profile_id` (or restoring vanilla, for `None`) would change.
    pub fn plan(&self, profile_id: Option<&str>) -> Result<ApplyPlan> {
        let profile = self.find_profile(profile_id)?;
        let prepared = deploy::prepare(
            &self.store,
            &self.paths()?,
            &self.packs(),
            &self.state()?,
            profile.as_ref(),
            self.running_processes(),
        )?;
        Ok(prepared.summary)
    }

    pub fn apply(
        &self,
        profile_id: Option<&str>,
        progress: &mut dyn FnMut(Progress),
    ) -> Result<ApplyResult> {
        self.apply_with_hooks(profile_id, progress, Hooks::default())
    }

    #[doc(hidden)]
    pub fn apply_with_hooks(
        &self,
        profile_id: Option<&str>,
        progress: &mut dyn FnMut(Progress),
        hooks: Hooks,
    ) -> Result<ApplyResult> {
        let _guard = lock(&self.op_lock);
        let profile = self.find_profile(profile_id)?;
        let prepared = deploy::prepare(
            &self.store,
            &self.paths()?,
            &self.packs(),
            &self.state()?,
            profile.as_ref(),
            self.running_processes(),
        )?;
        Ok(deploy::execute(&self.store, prepared, progress, hooks)?.result)
    }

    /// Copy in-game changes to the active profile's settings back into the profile.
    pub fn save_drift_to_profile(&self) -> Result<Profile> {
        let paths = self.paths()?;
        let state = self.state()?;
        let id = state
            .active_profile_id
            .clone()
            .ok_or_else(|| Error::invalid("No profile is active right now."))?;
        let mut profile = self
            .find_profile(Some(&id))?
            .ok_or_else(|| Error::NotFound("That profile".into()))?;
        for drift in settings_drift(&paths, &state) {
            let Some(current) = drift.current else {
                continue;
            };
            match drift.target {
                SettingsTarget::FivemGraphics => {
                    if let Ok(canonical) = schema::canonicalize(&drift.key, &current) {
                        profile.graphics.insert(drift.key, canonical);
                    }
                }
                SettingsTarget::FivemCfg => {
                    if fivem_cfg::validate_value(&drift.key, &current).is_ok() {
                        profile.fivem_cfg.insert(drift.key, current);
                    }
                }
                SettingsTarget::GtaGraphics => {}
            }
        }
        let profile = self.save_profile(profile)?;
        let _guard = lock(&self.op_lock);
        let mut state = self.state()?;
        state.applied.graphics = profile.graphics.clone();
        state.applied.fivem_cfg = profile.fivem_cfg.clone();
        self.store.save(store::STATE, &state)?;
        Ok(profile)
    }

    /// Stop flagging the current in-game changes (the profile is left as it is).
    pub fn dismiss_drift(&self) -> Result<()> {
        let paths = self.paths()?;
        let _guard = lock(&self.op_lock);
        let mut state = self.state()?;
        for drift in settings_drift(&paths, &state) {
            let map = match drift.target {
                SettingsTarget::FivemCfg => &mut state.applied.fivem_cfg,
                _ => &mut state.applied.graphics,
            };
            match drift.current {
                Some(current) => {
                    map.insert(drift.key, current);
                }
                None => {
                    map.remove(&drift.key);
                }
            }
        }
        self.store.save(store::STATE, &state)
    }

    // ---- Backups ------------------------------------------------------------

    fn settings_files(&self, paths: &ResolvedPaths) -> Vec<(SettingsTarget, PathBuf)> {
        let mut files = Vec::new();
        if let Some(p) = paths.fivem_settings_xml() {
            files.push((SettingsTarget::FivemGraphics, p));
        }
        if let Some(p) = paths.gta_settings_xml() {
            files.push((SettingsTarget::GtaGraphics, p));
        }
        if let Some(p) = paths.fivem_cfg() {
            files.push((SettingsTarget::FivemCfg, p));
        }
        files
    }

    pub fn snapshots(&self) -> Vec<Snapshot> {
        backup::list(&self.store)
    }

    pub fn restore_snapshot(&self, id: &str) -> Result<()> {
        let running = self.running_processes();
        if !running.is_empty() {
            return Err(Error::GameRunning(running));
        }
        let _guard = lock(&self.op_lock);
        let files = backup::files_to_restore(&self.store, id)?;
        let current: Vec<_> = files
            .iter()
            .map(|(t, dest, _)| (*t, dest.clone()))
            .collect();
        backup::create_from_disk(&self.store, "Before restoring a backup", &current, false)?;
        for (_, dest, saved) in &files {
            let bytes = backup::read_saved(saved)?;
            fsutil::write_atomic(dest, &bytes)?;
        }
        backup::prune(&self.store, deploy::SNAPSHOTS_TO_KEEP);
        Ok(())
    }

    pub fn delete_snapshot(&self, id: &str) -> Result<()> {
        let _guard = lock(&self.op_lock);
        backup::delete(&self.store, id)
    }

    /// Finish first-run setup: take the pinned "before Loadout" backup once.
    pub fn complete_setup(&self) -> Result<AppConfig> {
        let paths = self.paths()?;
        {
            let _guard = lock(&self.op_lock);
            if !backup::exists_pinned(&self.store) {
                backup::create_from_disk(
                    &self.store,
                    "Before Loadout (first run)",
                    &self.settings_files(&paths),
                    true,
                )?;
            }
        }
        let mut config = self.config()?;
        config.setup_complete = true;
        self.save_config(config)
    }
}

/// Compare the values a profile applied with what's in the files now.
fn settings_drift(paths: &ResolvedPaths, state: &DeployState) -> Vec<SettingsDrift> {
    let mut drift = Vec::new();
    if !state.applied.graphics.is_empty() {
        let mut targets = vec![(SettingsTarget::FivemGraphics, paths.fivem_settings_xml())];
        if state.applied.apply_to_gta {
            targets.push((SettingsTarget::GtaGraphics, paths.gta_settings_xml()));
        }
        for (target, path) in targets {
            let Some(doc) = path
                .and_then(|p| fs::read(p).ok())
                .and_then(|bytes| SettingsXml::parse(&bytes).ok())
            else {
                continue;
            };
            for (key, applied) in &state.applied.graphics {
                let current = doc.get(key).map(str::to_string);
                let same = current
                    .as_deref()
                    .map(|c| schema::canonicalize(key, c).ok().as_deref() == Some(applied.as_str()))
                    .unwrap_or(false);
                if !same {
                    drift.push(SettingsDrift {
                        target,
                        key: key.clone(),
                        applied: applied.clone(),
                        current,
                    });
                }
            }
        }
    }
    if !state.applied.fivem_cfg.is_empty() {
        if let Some(values) = paths
            .fivem_cfg()
            .and_then(|p| fs::read_to_string(p).ok())
            .map(|text| FivemCfg::parse(&text).values())
        {
            for (key, applied) in &state.applied.fivem_cfg {
                let current = values
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case(key))
                    .map(|(_, v)| v.clone());
                if current.as_deref() != Some(applied.as_str()) {
                    drift.push(SettingsDrift {
                        target: SettingsTarget::FivemCfg,
                        key: key.clone(),
                        applied: applied.clone(),
                        current,
                    });
                }
            }
        }
    }
    drift
}
