//! The apply engine: turn a profile into a plan, then carry the plan out as a
//! transaction that can always be undone.
//!
//! * **Plan** – diff the profile against the files on disk and the ledger of
//!   files Loadout installed earlier. Nothing is written.
//! * **Execute** – for every step, first save what's on disk now (the
//!   "pre-image") and note the step in a journal, then make the change.
//! * **Rollback** – on any error, restore the pre-images in reverse order.
//! * **Commit** – write the new ledger (the commit point), then tidy up.
//! * **Recover** – if the app died mid-apply, the journal left in
//!   `backups/tx/` is rolled back (or finished, if it had committed) at startup.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::backup;
use crate::error::{Error, IoContext, Result};
use crate::fivem_cfg::{self, FivemCfg};
use crate::fsutil;
use crate::model::{
    AppliedSettings, ApplyPlan, ApplyResult, DeployState, DeployedFile, FileOpKind, FileOpPlan,
    InstallRoot, OriginalBackup, Pack, PackConflict, Profile, Progress, ProgressStage,
    SettingsFilePlan, SettingsTarget,
};
use crate::packs;
use crate::paths::ResolvedPaths;
use crate::schema;
use crate::settings_xml::SettingsXml;
use crate::store::{self, Store};

/// How many automatic "before apply" snapshots to keep.
pub const SNAPSHOTS_TO_KEEP: usize = 20;

#[derive(Debug, Clone)]
enum Op {
    Settings {
        target: SettingsTarget,
        path: PathBuf,
        bytes: Vec<u8>,
    },
    Install(Install),
    Remove {
        entry: DeployedFile,
        /// The pack file that matches what's on disk now (used to undo).
        ours: PathBuf,
    },
    Forget,
}

#[derive(Debug, Clone)]
struct Install {
    root: InstallRoot,
    root_dir: PathBuf,
    /// Relative path with on-disk casing.
    rel: String,
    src: PathBuf,
    pack_id: String,
    pack_path: String,
    hash: String,
    size: u64,
    /// What's on disk now isn't ours: back it up as the vanilla original first.
    backup_existing: bool,
    /// What's on disk now is our own file from this pack path (for undo).
    ours: Option<PathBuf>,
    /// Original backup carried over from the ledger entry we're replacing.
    keep_original: Option<OriginalBackup>,
    keep_created_dirs: Vec<String>,
}

/// A computed plan, ready to execute.
#[derive(Debug, Clone)]
pub struct Prepared {
    pub summary: ApplyPlan,
    ops: Vec<Op>,
    /// Ledger entries that stay exactly as they are.
    kept: Vec<DeployedFile>,
    /// Old original backups that become stale once this apply commits.
    stale_originals: Vec<String>,
    applied: AppliedSettings,
    profile_id: Option<String>,
    label: String,
}

impl Prepared {
    /// True when no file would be touched (the ledger may still change).
    pub fn touches_no_files(&self) -> bool {
        self.ops.iter().all(|op| matches!(op, Op::Forget))
    }
}

enum Current {
    Missing,
    Ours,
    Changed,
}

fn current_state(dest: &Path, entry: &DeployedFile) -> Result<Current> {
    match fs::metadata(dest) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(Current::Missing),
        Err(err) => Err(err).ctx_path("inspect", dest),
        Ok(meta) if !meta.is_file() => Ok(Current::Changed),
        Ok(meta) => {
            if meta.len() == entry.size && fsutil::mtime_ms(&meta) == entry.mtime_ms {
                return Ok(Current::Ours);
            }
            if meta.len() != entry.size {
                return Ok(Current::Changed);
            }
            let (hash, _) = fsutil::hash_file(dest)?;
            Ok(if hash == entry.hash {
                Current::Ours
            } else {
                Current::Changed
            })
        }
    }
}

fn dir_key(dir: &Path) -> String {
    dir.to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

fn display_path(root: InstallRoot, rel: &str) -> String {
    format!("{}/{}", root.label(), rel)
}

struct Desired {
    root: InstallRoot,
    root_dir: PathBuf,
    pack_id: String,
    pack_name: String,
    pack_path: String,
    hash: String,
    size: u64,
    src: PathBuf,
}

/// Work out what applying `profile` (or restoring vanilla, for `None`) would change.
pub fn prepare(
    store: &Store,
    paths: &ResolvedPaths,
    packs: &[Pack],
    state: &DeployState,
    profile: Option<&Profile>,
    running_processes: Vec<String>,
) -> Result<Prepared> {
    let mut ops = Vec::new();
    let mut settings_plans = Vec::new();
    let mut warnings = Vec::new();
    let mut errors = Vec::new();
    let mut applied = AppliedSettings::default();

    // ---- Settings files ---------------------------------------------------
    if let Some(profile) = profile {
        let mut overlay = BTreeMap::new();
        for (key, value) in &profile.graphics {
            match schema::canonicalize(key, value) {
                Ok(canonical) => {
                    overlay.insert(key.clone(), canonical);
                }
                Err(err) => errors.push(err),
            }
        }
        if !overlay.is_empty() {
            let mut targets = vec![(SettingsTarget::FivemGraphics, paths.fivem_settings_xml())];
            if profile.apply_to_gta {
                targets.push((SettingsTarget::GtaGraphics, paths.gta_settings_xml()));
            }
            for (target, path) in targets {
                let Some(path) = path.filter(|p| p.is_file()) else {
                    warnings.push(match target {
                        SettingsTarget::FivemGraphics => "FiveM's graphics file (gta5_settings.xml) wasn't found, so graphics were skipped. Start FiveM once so it creates it.".to_string(),
                        _ => "GTA V's settings.xml wasn't found, so Story Mode / Online graphics were skipped. Start GTA V once so it creates it.".to_string(),
                    });
                    continue;
                };
                let bytes = fs::read(&path).ctx_path("read", &path)?;
                let doc = match SettingsXml::parse(&bytes) {
                    Ok(doc) => doc,
                    Err(message) => {
                        errors.push(format!(
                            "{} looks damaged ({message}). Start the game once so it rewrites it.",
                            path.display()
                        ));
                        continue;
                    }
                };
                let mut changes = overlay.clone();
                if !doc.patch(&changes).changes.is_empty() && doc.get("configSource").is_some() {
                    // Mark the settings as user-chosen, as the game does after you change them.
                    changes.insert("configSource".into(), "SMC_USER".into());
                }
                let outcome = doc.patch(&changes);
                let visible: Vec<_> = outcome
                    .changes
                    .iter()
                    .filter(|c| c.key != "configSource")
                    .cloned()
                    .collect();
                if !outcome.changes.is_empty() {
                    ops.push(Op::Settings {
                        target,
                        path: path.clone(),
                        bytes: outcome.bytes,
                    });
                }
                settings_plans.push(SettingsFilePlan {
                    target,
                    path: path.display().to_string(),
                    changes: visible,
                    skipped: outcome.skipped,
                });
            }
            applied.graphics = overlay;
            applied.apply_to_gta = profile.apply_to_gta;
        }

        let mut cfg_overlay = BTreeMap::new();
        for (key, value) in &profile.fivem_cfg {
            if !fivem_cfg::is_valid_key(key) {
                errors.push(format!("\"{key}\" isn't a valid FiveM setting name"));
            } else if let Err(err) = fivem_cfg::validate_value(key, value) {
                errors.push(err);
            } else {
                cfg_overlay.insert(key.clone(), value.clone());
            }
        }
        if !cfg_overlay.is_empty() {
            match paths.fivem_cfg() {
                None => warnings.push(
                    "FiveM's CitizenFX folder wasn't found, so in-game settings were skipped."
                        .into(),
                ),
                Some(path) => {
                    let text = if path.is_file() {
                        fs::read_to_string(&path).ctx_path("read", &path)?
                    } else {
                        String::new()
                    };
                    let (new_text, changes) = FivemCfg::parse(&text).patch(&cfg_overlay);
                    if !changes.is_empty() {
                        ops.push(Op::Settings {
                            target: SettingsTarget::FivemCfg,
                            path: path.clone(),
                            bytes: new_text.into_bytes(),
                        });
                    }
                    settings_plans.push(SettingsFilePlan {
                        target: SettingsTarget::FivemCfg,
                        path: path.display().to_string(),
                        changes,
                        skipped: Vec::new(),
                    });
                    applied.fivem_cfg = cfg_overlay;
                }
            }
        }
    }

    // ---- Pack files -------------------------------------------------------
    let mut desired: Vec<Desired> = Vec::new();
    let mut by_key: HashMap<(InstallRoot, String), usize> = HashMap::new();
    let mut conflicts: BTreeMap<(InstallRoot, String), Vec<String>> = BTreeMap::new();
    if let Some(profile) = profile {
        for pack_id in &profile.packs {
            let Some(pack) = packs.iter().find(|p| &p.id == pack_id) else {
                errors.push("This profile uses a pack that has been deleted. Edit the profile and remove it.".into());
                continue;
            };
            let Some(root_dir) = paths.root_dir(pack.root) else {
                errors.push(format!(
                    "\"{}\" installs into the {}, which wasn't found. Set it in Settings.",
                    pack.name,
                    pack.root.label()
                ));
                continue;
            };
            for file in &pack.files {
                let key = (pack.root, fsutil::rel_key(&file.path));
                let wanted = Desired {
                    root: pack.root,
                    root_dir: root_dir.to_path_buf(),
                    pack_id: pack.id.clone(),
                    pack_name: pack.name.clone(),
                    pack_path: file.path.clone(),
                    hash: file.hash.clone(),
                    size: file.size,
                    src: packs::file_path(&store.packs_dir(), &pack.id, &file.path),
                };
                match by_key.get(&key) {
                    Some(&i) => {
                        conflicts
                            .entry(key)
                            .or_insert_with(|| vec![desired[i].pack_name.clone()])
                            .push(pack.name.clone());
                        desired[i] = wanted;
                    }
                    None => {
                        by_key.insert(key, desired.len());
                        desired.push(wanted);
                    }
                }
            }
        }
    }

    let mut file_plans = Vec::new();
    let mut kept = Vec::new();
    let mut stale_originals = Vec::new();
    let mut matched = vec![false; desired.len()];
    let mut remove_ops = Vec::new();
    let mut install_ops = Vec::new();

    for entry in &state.files {
        let root_dir = PathBuf::from(&entry.root_dir);
        let dest = fsutil::rel_to_path(&root_dir, &entry.path);
        let current = current_state(&dest, entry)?;
        let ours_src = packs::file_path(&store.packs_dir(), &entry.pack_id, &entry.pack_path);
        let wanted = by_key
            .get(&(entry.root, fsutil::rel_key(&entry.path)))
            .copied()
            .filter(|&i| dir_key(&desired[i].root_dir) == dir_key(&root_dir));
        let shown = display_path(entry.root, &entry.path);
        match (wanted, current) {
            (Some(i), Current::Ours) if desired[i].hash == entry.hash => {
                matched[i] = true;
                let mut keep = entry.clone();
                keep.pack_id = desired[i].pack_id.clone();
                keep.pack_path = desired[i].pack_path.clone();
                kept.push(keep);
            }
            (Some(i), current) => {
                matched[i] = true;
                let d = &desired[i];
                let (backup_existing, ours, keep_original, note) = match current {
                    Current::Ours => (false, Some(ours_src.clone()), entry.original.clone(), None),
                    Current::Changed => {
                        stale_originals.extend(entry.original.iter().map(|o| o.file.clone()));
                        (true, None, None, Some("Changed by something else since it was installed (probably a FiveM update or a game file check). That version is kept as the new original.".to_string()))
                    }
                    Current::Missing => {
                        stale_originals.extend(entry.original.iter().map(|o| o.file.clone()));
                        (
                            false,
                            None,
                            None,
                            Some("It had been deleted; installing it again.".to_string()),
                        )
                    }
                };
                file_plans.push(FileOpPlan {
                    kind: if matches!(current, Current::Ours) {
                        FileOpKind::Replace
                    } else {
                        FileOpKind::Install
                    },
                    root: entry.root,
                    path: shown,
                    pack_name: Some(d.pack_name.clone()),
                    size: d.size,
                    backs_up_original: backup_existing,
                    restores_original: false,
                    note,
                });
                install_ops.push(Op::Install(Install {
                    root: d.root,
                    root_dir: root_dir.clone(),
                    rel: entry.path.clone(),
                    src: d.src.clone(),
                    pack_id: d.pack_id.clone(),
                    pack_path: d.pack_path.clone(),
                    hash: d.hash.clone(),
                    size: d.size,
                    backup_existing,
                    ours,
                    keep_original,
                    keep_created_dirs: entry.created_dirs.clone(),
                }));
            }
            (None, Current::Ours) => {
                stale_originals.extend(entry.original.iter().map(|o| o.file.clone()));
                file_plans.push(FileOpPlan {
                    kind: FileOpKind::Remove,
                    root: entry.root,
                    path: shown,
                    pack_name: packs
                        .iter()
                        .find(|p| p.id == entry.pack_id)
                        .map(|p| p.name.clone()),
                    size: entry.original.as_ref().map(|o| o.size).unwrap_or(0),
                    backs_up_original: false,
                    restores_original: entry.original.is_some(),
                    note: None,
                });
                remove_ops.push(Op::Remove {
                    entry: entry.clone(),
                    ours: ours_src,
                });
            }
            (None, current) => {
                stale_originals.extend(entry.original.iter().map(|o| o.file.clone()));
                file_plans.push(FileOpPlan {
                    kind: FileOpKind::Forget,
                    root: entry.root,
                    path: shown,
                    pack_name: None,
                    size: 0,
                    backs_up_original: false,
                    restores_original: false,
                    note: Some(match current {
                        Current::Missing => "Already gone.".into(),
                        _ => "Changed by something else since it was installed (probably a FiveM update), so it's left as it is.".into(),
                    }),
                });
                remove_ops.push(Op::Forget);
            }
        }
    }

    for (i, d) in desired.iter().enumerate() {
        if matched[i] {
            continue;
        }
        let (dest, rel) = fsutil::resolve_ci(&d.root_dir, &d.pack_path);
        if dest.is_dir() {
            errors.push(format!(
                "{} is a folder, so \"{}\" can't install a file there.",
                dest.display(),
                d.pack_name
            ));
            continue;
        }
        if !d.src.is_file() {
            errors.push(format!(
                "\"{}\" is missing {} from the library. Re-import the pack.",
                d.pack_name, d.pack_path
            ));
            continue;
        }
        let backup_existing = dest.is_file();
        file_plans.push(FileOpPlan {
            kind: FileOpKind::Install,
            root: d.root,
            path: display_path(d.root, &rel),
            pack_name: Some(d.pack_name.clone()),
            size: d.size,
            backs_up_original: backup_existing,
            restores_original: false,
            note: None,
        });
        install_ops.push(Op::Install(Install {
            root: d.root,
            root_dir: d.root_dir.clone(),
            rel,
            src: d.src.clone(),
            pack_id: d.pack_id.clone(),
            pack_path: d.pack_path.clone(),
            hash: d.hash.clone(),
            size: d.size,
            backup_existing,
            ours: None,
            keep_original: None,
            keep_created_dirs: Vec::new(),
        }));
    }
    ops.extend(remove_ops);
    ops.extend(install_ops);

    let copy_bytes = file_plans
        .iter()
        .filter(|f| f.kind != FileOpKind::Forget)
        .map(|f| f.size)
        .sum();
    let conflicts = conflicts
        .into_iter()
        .map(|((root, _), packs)| {
            let winner = packs.last().cloned().unwrap_or_default();
            let path = desired
                .iter()
                .find(|d| d.root == root && d.pack_name == winner)
                .map(|d| d.pack_path.clone())
                .unwrap_or_default();
            PackConflict {
                root,
                path,
                packs,
                winner,
            }
        })
        .collect();
    // Keep the stale list unique and never delete an original that's still referenced.
    stale_originals.sort();
    stale_originals.dedup();
    stale_originals.retain(|f| {
        !kept
            .iter()
            .any(|k| k.original.as_ref().is_some_and(|o| &o.file == f))
    });

    let label = match profile {
        Some(p) => format!("Before applying \"{}\"", p.name),
        None => "Before restoring vanilla".to_string(),
    };
    Ok(Prepared {
        summary: ApplyPlan {
            profile_id: profile.map(|p| p.id.clone()),
            profile_name: profile.map(|p| p.name.clone()),
            settings: settings_plans,
            files: file_plans,
            conflicts,
            warnings,
            errors,
            copy_bytes,
            running_processes,
        },
        ops,
        kept,
        stale_originals,
        applied,
        profile_id: profile.map(|p| p.id.clone()),
        label,
    })
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum StepStatus {
    Pending,
    Started,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "path")]
enum PreImage {
    /// Nothing was there.
    Absent,
    /// A copy we made (in the tx folder or in backups/originals).
    Saved(String),
    /// Identical to this pack library file.
    Pack(String),
    /// The step doesn't touch any file.
    Untouched,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    dest: String,
    status: StepStatus,
    pre: PreImage,
    /// Backup created in `backups/originals` by this step (deleted on rollback).
    created_original: Option<String>,
    /// Folders created by this step (removed on rollback if empty).
    created_dirs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    id: String,
    started_at: String,
    label: String,
    committed: bool,
    steps: Vec<Step>,
    /// Old backups to delete once the new ledger is in place.
    delete_on_commit: Vec<String>,
}

const JOURNAL: &str = "journal.json";
const NEW_STATE: &str = "state.new.json";

fn save_journal(dir: &Path, journal: &Journal) -> Result<()> {
    store::write_json(&dir.join(JOURNAL), journal)
}

/// Test hooks: make step `n` fail (to test rollback) or stop dead before it
/// (to simulate a crash and test recovery).
#[derive(Debug, Clone, Copy, Default)]
pub struct Hooks {
    pub fail_before_step: Option<usize>,
    pub crash_before_step: Option<usize>,
    /// Stop right after the commit point, before tidying up.
    pub crash_after_commit: bool,
}

pub struct Outcome {
    pub result: ApplyResult,
    pub state: DeployState,
}

/// Carry out a prepared plan. On error everything is rolled back.
pub fn execute(
    store: &Store,
    prepared: Prepared,
    progress: &mut dyn FnMut(Progress),
    hooks: Hooks,
) -> Result<Outcome> {
    if !prepared.summary.errors.is_empty() {
        return Err(Error::invalid(prepared.summary.errors.join("\n")));
    }
    if !prepared.summary.running_processes.is_empty() {
        return Err(Error::GameRunning(
            prepared.summary.running_processes.clone(),
        ));
    }

    let tx_id = format!("{}-{}", fsutil::now_compact(), &fsutil::new_id()[..8]);
    let tx_dir = store.tx_dir().join(&tx_id);
    fs::create_dir_all(&tx_dir).ctx_path("create folder", &tx_dir)?;
    let mut journal = Journal {
        id: tx_id,
        started_at: fsutil::now_rfc3339(),
        label: prepared.label.clone(),
        committed: false,
        steps: prepared
            .ops
            .iter()
            .map(|op| Step {
                dest: op_dest(op)
                    .map(|p| p.display().to_string())
                    .unwrap_or_default(),
                status: StepStatus::Pending,
                pre: PreImage::Untouched,
                created_original: None,
                created_dirs: Vec::new(),
            })
            .collect(),
        delete_on_commit: prepared
            .stale_originals
            .iter()
            .map(|f| store.originals_dir().join(f).display().to_string())
            .collect(),
    };
    save_journal(&tx_dir, &journal)?;

    let total: u64 = prepared.summary.copy_bytes.max(1);
    let mut done = 0u64;
    let mut installed: Vec<DeployedFile> = Vec::new();

    let run = (|| -> Result<()> {
        for (i, op) in prepared.ops.iter().enumerate() {
            if hooks.crash_before_step == Some(i) {
                return Err(Error::invalid("simulated crash"));
            }
            if hooks.fail_before_step == Some(i) {
                return Err(Error::invalid(format!("simulated failure at step {i}")));
            }
            run_step(store, &tx_dir, &mut journal, i, op, &mut installed)?;
            if let Op::Install(install) = op {
                done += install.size;
                progress(Progress {
                    stage: ProgressStage::Copying,
                    done,
                    total,
                    message: format!("Installed {}", install.rel),
                });
            } else if let Op::Remove { entry, .. } = op {
                done += entry.original.as_ref().map(|o| o.size).unwrap_or(0);
                progress(Progress {
                    stage: ProgressStage::Copying,
                    done,
                    total,
                    message: format!("Removed {}", entry.path),
                });
            }
        }
        Ok(())
    })();

    if let Err(err) = run {
        if hooks.crash_before_step.is_some() {
            // Simulated crash: leave the journal behind for `recover`.
            return Err(err);
        }
        let problems = rollback(&journal);
        if problems.is_empty() {
            let _ = fs::remove_dir_all(&tx_dir);
            return Err(err);
        }
        return Err(Error::invalid(format!(
            "{err}. Undoing it also hit problems ({}); the backups are kept in {}.",
            problems.join("; "),
            tx_dir.display()
        )));
    }

    // ---- Commit -----------------------------------------------------------
    progress(Progress {
        stage: ProgressStage::Finishing,
        done: total,
        total,
        message: "Saving".into(),
    });
    let mut files = prepared.kept.clone();
    files.extend(installed);
    files.sort_by_key(|f| (f.root, f.path.to_lowercase()));
    let applied_at = fsutil::now_rfc3339();
    let state = DeployState {
        active_profile_id: prepared.profile_id.clone(),
        applied_at: Some(applied_at.clone()),
        applied: prepared.applied.clone(),
        files,
    };
    store::write_json(&tx_dir.join(NEW_STATE), &state)?;
    journal.committed = true;
    save_journal(&tx_dir, &journal)?;
    if hooks.crash_after_commit {
        return Err(Error::invalid("simulated crash after commit"));
    }
    let snapshot_id = finish_commit(store, &tx_dir, &journal, &prepared)?;

    Ok(Outcome {
        result: ApplyResult {
            plan: prepared.summary,
            applied_at,
            snapshot_id,
        },
        state,
    })
}

fn op_dest(op: &Op) -> Option<PathBuf> {
    match op {
        Op::Settings { path, .. } => Some(path.clone()),
        Op::Install(i) => Some(fsutil::rel_to_path(&i.root_dir, &i.rel)),
        Op::Remove { entry, .. } => {
            Some(fsutil::rel_to_path(Path::new(&entry.root_dir), &entry.path))
        }
        Op::Forget => None,
    }
}

fn run_step(
    store: &Store,
    tx_dir: &Path,
    journal: &mut Journal,
    i: usize,
    op: &Op,
    installed: &mut Vec<DeployedFile>,
) -> Result<()> {
    let Some(dest) = op_dest(op) else {
        return Ok(()); // Forget: ledger-only change.
    };

    // 1. Save the pre-image and record the step before touching anything.
    let mut created_original = None;
    let mut planned_dirs = Vec::new();
    let pre = match op {
        Op::Settings { .. } => {
            if dest.is_file() {
                let copy = tx_dir.join(format!("pre-{i}"));
                fsutil::copy_plain(&dest, &copy).ctx_path("back up", &dest)?;
                PreImage::Saved(copy.display().to_string())
            } else {
                PreImage::Absent
            }
        }
        Op::Install(install) => {
            planned_dirs = missing_dirs(&install.root_dir, &install.rel);
            if let Some(ours) = install.ours.as_ref().filter(|p| p.is_file()) {
                PreImage::Pack(ours.display().to_string())
            } else if install.backup_existing && dest.is_file() {
                let backup = store.originals_dir().join(fsutil::new_id());
                fsutil::copy_plain(&dest, &backup).ctx_path("back up", &dest)?;
                created_original = Some(backup.clone());
                PreImage::Saved(backup.display().to_string())
            } else if dest.is_file() {
                let copy = tx_dir.join(format!("pre-{i}"));
                fsutil::copy_plain(&dest, &copy).ctx_path("back up", &dest)?;
                PreImage::Saved(copy.display().to_string())
            } else {
                PreImage::Absent
            }
        }
        Op::Remove { ours, .. } => {
            if ours.is_file() {
                PreImage::Pack(ours.display().to_string())
            } else {
                let copy = tx_dir.join(format!("pre-{i}"));
                fsutil::copy_plain(&dest, &copy).ctx_path("back up", &dest)?;
                PreImage::Saved(copy.display().to_string())
            }
        }
        Op::Forget => PreImage::Untouched,
    };
    {
        let step = &mut journal.steps[i];
        step.pre = pre;
        step.status = StepStatus::Started;
        step.created_original = created_original.as_ref().map(|p| p.display().to_string());
        step.created_dirs = planned_dirs
            .iter()
            .map(|p| p.display().to_string())
            .collect();
    }
    save_journal(tx_dir, journal)?;

    // 2. Make the change.
    match op {
        Op::Settings { bytes, .. } => fsutil::write_atomic(&dest, bytes)?,
        Op::Install(install) => {
            let created = fsutil::create_parent_dirs(&install.root_dir, &install.rel)?;
            let (hash, size) = fsutil::copy_atomic(&install.src, &dest)?;
            if hash != install.hash {
                return Err(Error::invalid(format!(
                    "The library copy of {} is damaged. Re-import that pack.",
                    install.pack_path
                )));
            }
            let mtime_ms = fs::metadata(&dest)
                .map(|m| fsutil::mtime_ms(&m))
                .unwrap_or(0);
            let original = match &created_original {
                Some(path) => {
                    let (hash, size) = fsutil::hash_file(path)?;
                    Some(OriginalBackup {
                        file: path
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_default(),
                        hash,
                        size,
                    })
                }
                None => install.keep_original.clone(),
            };
            let mut created_dirs = install.keep_created_dirs.clone();
            for dir in created {
                if !created_dirs.contains(&dir) {
                    created_dirs.push(dir);
                }
            }
            installed.push(DeployedFile {
                root: install.root,
                root_dir: install.root_dir.display().to_string(),
                path: install.rel.clone(),
                pack_id: install.pack_id.clone(),
                pack_path: install.pack_path.clone(),
                hash,
                size,
                mtime_ms,
                original,
                created_dirs,
            });
        }
        Op::Remove { entry, .. } => {
            match &entry.original {
                Some(original) => {
                    let backup = store.originals_dir().join(&original.file);
                    fsutil::copy_atomic(&backup, &dest)?;
                }
                None => {
                    fsutil::remove_file_if_exists(&dest)?;
                }
            }
            fsutil::remove_empty_dirs(Path::new(&entry.root_dir), &entry.created_dirs);
        }
        Op::Forget => {}
    }
    Ok(())
}

/// Folders that would have to be created for `root/rel` (absolute paths).
fn missing_dirs(root: &Path, rel: &str) -> Vec<PathBuf> {
    let parts: Vec<&str> = rel.split('/').collect();
    let mut out = Vec::new();
    let mut current = root.to_path_buf();
    for part in &parts[..parts.len().saturating_sub(1)] {
        current.push(part);
        if !current.exists() {
            out.push(current.clone());
        }
    }
    out
}

/// Undo every started step, newest first. Returns the problems it couldn't fix.
fn rollback(journal: &Journal) -> Vec<String> {
    let mut problems = Vec::new();
    for step in journal.steps.iter().rev() {
        if step.status == StepStatus::Pending {
            continue;
        }
        let dest = PathBuf::from(&step.dest);
        let result = match &step.pre {
            PreImage::Absent => fsutil::remove_file_if_exists(&dest).map(|_| ()),
            PreImage::Saved(src) | PreImage::Pack(src) => {
                fsutil::copy_atomic(Path::new(src), &dest).map(|_| ())
            }
            PreImage::Untouched => Ok(()),
        };
        if let Err(err) = result {
            problems.push(err.to_string());
        }
        let mut dirs: Vec<&String> = step.created_dirs.iter().collect();
        dirs.sort_by_key(|d| std::cmp::Reverse(d.len()));
        for dir in dirs {
            let path = Path::new(dir);
            if fs::read_dir(path)
                .map(|mut it| it.next().is_none())
                .unwrap_or(false)
            {
                let _ = fs::remove_dir(path);
            }
        }
        if let Some(original) = &step.created_original {
            let _ = fsutil::remove_file_if_exists(Path::new(original));
        }
    }
    problems
}

/// Everything after the commit point: install the new ledger, drop stale
/// backups, keep the settings pre-images as a snapshot, and clean up.
fn finish_commit(
    store: &Store,
    tx_dir: &Path,
    journal: &Journal,
    prepared: &Prepared,
) -> Result<Option<String>> {
    fsutil::copy_atomic(&tx_dir.join(NEW_STATE), &store.path(store::STATE))?;
    // The new ledger is in place: drop the journal first so nothing can ever
    // "recover" this transaction again, even if tidying up below fails.
    fsutil::remove_file_if_exists(&tx_dir.join(JOURNAL))?;
    for file in &journal.delete_on_commit {
        let _ = fsutil::remove_file_if_exists(Path::new(file));
    }
    let mut snapshot_files = Vec::new();
    for (step, op) in journal.steps.iter().zip(&prepared.ops) {
        if let (Op::Settings { target, path, .. }, PreImage::Saved(copy)) = (op, &step.pre) {
            snapshot_files.push((*target, path.clone(), PathBuf::from(copy)));
        }
    }
    let snapshot_id = if snapshot_files.is_empty() {
        None
    } else {
        let snap = backup::create_from_files(store, &prepared.label, &snapshot_files, false)?;
        backup::prune(store, SNAPSHOTS_TO_KEEP);
        Some(snap.id)
    };
    let _ = fs::remove_dir_all(tx_dir);
    Ok(snapshot_id)
}

/// Roll back (or finish) any apply that was interrupted by a crash.
/// Returns a message for the user when something was recovered.
pub fn recover(store: &Store) -> Result<Option<String>> {
    let mut notices = Vec::new();
    let mut dirs: Vec<PathBuf> = fs::read_dir(store.tx_dir())
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    for dir in dirs.into_iter().rev() {
        let journal: Journal = match store::read_json(&dir.join(JOURNAL)) {
            Ok(journal) => journal,
            Err(_) => {
                // Died before the first journal write: nothing was touched.
                let _ = fs::remove_dir_all(&dir);
                continue;
            }
        };
        if journal.committed {
            fsutil::copy_atomic(&dir.join(NEW_STATE), &store.path(store::STATE))?;
            fsutil::remove_file_if_exists(&dir.join(JOURNAL))?;
            for file in &journal.delete_on_commit {
                let _ = fsutil::remove_file_if_exists(Path::new(file));
            }
            let _ = fs::remove_dir_all(&dir);
            notices.push(format!(
                "Finished \"{}\", which was interrupted.",
                journal.label.trim_start_matches("Before ")
            ));
        } else {
            let problems = rollback(&journal);
            if problems.is_empty() {
                let _ = fs::remove_dir_all(&dir);
                notices.push("An apply was interrupted (Loadout closed or crashed). Your files were put back the way they were.".into());
            } else {
                notices.push(format!(
                    "An interrupted apply couldn't be fully undone: {}. Backups are kept in {}.",
                    problems.join("; "),
                    dir.display()
                ));
            }
        }
    }
    remove_orphaned_originals(store);
    Ok((!notices.is_empty()).then(|| notices.join(" ")))
}

/// Delete backups of originals that no ledger entry points to any more (left
/// behind if Loadout stopped between committing and tidying up). Only called at
/// startup, when no transaction is running.
fn remove_orphaned_originals(store: &Store) {
    let Ok(state) = store.load::<DeployState>(store::STATE) else {
        return;
    };
    let referenced: std::collections::HashSet<&str> = state
        .files
        .iter()
        .filter_map(|f| f.original.as_ref().map(|o| o.file.as_str()))
        .collect();
    for entry in fs::read_dir(store.originals_dir())
        .into_iter()
        .flatten()
        .flatten()
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !referenced.contains(name.as_str()) {
            log::info!("Removing orphaned backup {name}");
            let _ = fsutil::remove_file_if_exists(&entry.path());
        }
    }
}

/// True when a file Loadout installed is still exactly as it left it.
pub fn is_unchanged(dest: &Path, entry: &DeployedFile) -> bool {
    matches!(current_state(dest, entry), Ok(Current::Ours))
}
