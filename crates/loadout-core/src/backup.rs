//! Snapshots of the settings files (`gta5_settings.xml`, `settings.xml`, `fivem.cfg`).
//!
//! One is taken automatically before every apply. The first-run snapshot is
//! pinned and never pruned, so the player can always get back to how things were
//! before they installed Loadout.

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{Error, IoContext, Result};
use crate::fsutil;
use crate::model::{SettingsTarget, Snapshot, SnapshotFile};
use crate::store::{self, Store};

const META: &str = "meta.json";

fn snapshot_dir(store: &Store, id: &str) -> Result<PathBuf> {
    if fsutil::sanitize_rel(id).as_deref() != Some(id) || id.contains('/') {
        return Err(Error::NotFound("That backup".into()));
    }
    Ok(store.snapshots_dir().join(id))
}

/// Create a snapshot from copies already on disk.
/// `files` = `(target, where the file lives in the game folders, copy to take)`.
pub fn create_from_files(
    store: &Store,
    label: &str,
    files: &[(SettingsTarget, PathBuf, PathBuf)],
    pinned: bool,
) -> Result<Snapshot> {
    let id = format!("{}-{}", fsutil::now_compact(), &fsutil::new_id()[..6]);
    let dir = store.snapshots_dir().join(&id);
    fs::create_dir_all(&dir).ctx_path("create folder", &dir)?;
    let mut entries = Vec::new();
    for (target, original, copy) in files {
        let file = target.file_stem().to_string();
        fsutil::copy_plain(copy, &dir.join(&file)).ctx_path("back up", copy)?;
        entries.push(SnapshotFile {
            target: *target,
            original_path: original.display().to_string(),
            file,
        });
    }
    let snapshot = Snapshot {
        id,
        created_at: fsutil::now_rfc3339(),
        label: label.to_string(),
        files: entries,
        pinned,
    };
    store::write_json(&dir.join(META), &snapshot)?;
    Ok(snapshot)
}

/// Snapshot whichever of `files` currently exist. Returns `None` if none do.
pub fn create_from_disk(
    store: &Store,
    label: &str,
    files: &[(SettingsTarget, PathBuf)],
    pinned: bool,
) -> Result<Option<Snapshot>> {
    let existing: Vec<_> = files
        .iter()
        .filter(|(_, path)| path.is_file())
        .map(|(target, path)| (*target, path.clone(), path.clone()))
        .collect();
    if existing.is_empty() {
        return Ok(None);
    }
    create_from_files(store, label, &existing, pinned).map(Some)
}

pub fn list(store: &Store) -> Vec<Snapshot> {
    let mut snapshots: Vec<Snapshot> = fs::read_dir(store.snapshots_dir())
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| store::read_json::<Snapshot>(&e.path().join(META)).ok())
        .collect();
    snapshots.sort_by(|a, b| b.id.cmp(&a.id));
    snapshots
}

pub fn get(store: &Store, id: &str) -> Result<Snapshot> {
    store::read_json(&snapshot_dir(store, id)?.join(META))
        .map_err(|_| Error::NotFound("That backup".into()))
}

/// `(target, destination in the game folders, saved copy)` for each file.
pub fn files_to_restore(
    store: &Store,
    id: &str,
) -> Result<Vec<(SettingsTarget, PathBuf, PathBuf)>> {
    let snapshot = get(store, id)?;
    let dir = snapshot_dir(store, id)?;
    Ok(snapshot
        .files
        .iter()
        .map(|f| (f.target, PathBuf::from(&f.original_path), dir.join(&f.file)))
        .collect())
}

/// Keep the newest `keep` unpinned snapshots.
pub fn prune(store: &Store, keep: usize) {
    for snapshot in list(store).into_iter().filter(|s| !s.pinned).skip(keep) {
        let _ = fs::remove_dir_all(store.snapshots_dir().join(&snapshot.id));
    }
}

pub fn delete(store: &Store, id: &str) -> Result<()> {
    let dir = snapshot_dir(store, id)?;
    if !dir.join(META).is_file() {
        return Err(Error::NotFound("That backup".into()));
    }
    fs::remove_dir_all(&dir).ctx_path("delete", &dir)
}

pub fn exists_pinned(store: &Store) -> bool {
    list(store).iter().any(|s| s.pinned)
}

pub fn read_saved(path: &Path) -> Result<Vec<u8>> {
    fs::read(path).ctx_path("read", path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshots_round_trip_and_prune_keeps_pinned() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::new(tmp.path().join("data")).unwrap();
        let settings = tmp.path().join("gta5_settings.xml");
        fs::write(&settings, b"<Settings/>").unwrap();
        let first = create_from_disk(
            &store,
            "Before Loadout",
            &[
                (SettingsTarget::FivemGraphics, settings.clone()),
                (SettingsTarget::FivemCfg, tmp.path().join("missing.cfg")),
            ],
            true,
        )
        .unwrap()
        .unwrap();
        assert_eq!(first.files.len(), 1);
        for _ in 0..3 {
            std::thread::sleep(std::time::Duration::from_millis(5));
            create_from_disk(
                &store,
                "auto",
                &[(SettingsTarget::FivemGraphics, settings.clone())],
                false,
            )
            .unwrap();
        }
        assert_eq!(list(&store).len(), 4);
        prune(&store, 1);
        let left = list(&store);
        assert_eq!(left.len(), 2);
        assert!(left.iter().any(|s| s.pinned));
        let restore = files_to_restore(&store, &first.id).unwrap();
        assert_eq!(restore[0].1, settings);
        assert_eq!(fs::read(&restore[0].2).unwrap(), b"<Settings/>");
        assert!(get(&store, "../x").is_err());
    }
}
