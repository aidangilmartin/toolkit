//! Loadout's own data folder (`%LOCALAPPDATA%\Loadout`).

use std::fs;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::{IoContext, Result};
use crate::fsutil;

pub const CONFIG: &str = "config.json";
pub const PROFILES: &str = "profiles.json";
/// Saved servers from v0.1.0, moved into profiles on first start.
pub const LEGACY_SERVERS: &str = "servers.json";
pub const STATE: &str = "state.json";

#[derive(Debug, Clone)]
pub struct Store {
    root: PathBuf,
}

impl Store {
    pub fn new(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        for dir in [
            "packs",
            "backups/originals",
            "backups/snapshots",
            "backups/tx",
        ] {
            let path = root.join(dir);
            fs::create_dir_all(&path).ctx_path("create folder", &path)?;
        }
        Ok(Self { root })
    }

    /// Default location: `%LOCALAPPDATA%\Loadout`.
    pub fn default_root() -> Option<PathBuf> {
        dirs::data_local_dir().map(|d| d.join("Loadout"))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    pub fn packs_dir(&self) -> PathBuf {
        self.root.join("packs")
    }

    pub fn originals_dir(&self) -> PathBuf {
        self.root.join("backups").join("originals")
    }

    pub fn snapshots_dir(&self) -> PathBuf {
        self.root.join("backups").join("snapshots")
    }

    pub fn tx_dir(&self) -> PathBuf {
        self.root.join("backups").join("tx")
    }

    /// Load a JSON file, falling back to the default when it doesn't exist.
    /// A corrupt file is moved aside (never silently overwritten) and the
    /// default is returned so the app keeps working.
    pub fn load<T: DeserializeOwned + Default>(&self, name: &str) -> Result<T> {
        let path = self.path(name);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(T::default()),
            Err(err) => return Err(err).ctx_path("read", &path),
        };
        match serde_json::from_slice(&bytes) {
            Ok(value) => Ok(value),
            Err(err) => {
                let aside = path.with_extension(format!("corrupt-{}.json", fsutil::now_compact()));
                log::error!(
                    "{} is corrupt ({err}); moved to {}",
                    path.display(),
                    aside.display()
                );
                fs::rename(&path, &aside).ctx_path("move aside", &path)?;
                Ok(T::default())
            }
        }
    }

    pub fn save<T: Serialize>(&self, name: &str, value: &T) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(value)?;
        fsutil::write_atomic(&self.path(name), &bytes)
    }
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let bytes = fs::read(path).ctx_path("read", path)?;
    Ok(serde_json::from_slice(&bytes)?)
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    fsutil::write_atomic(path, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::AppConfig;

    #[test]
    fn missing_file_gives_default_and_corrupt_file_is_kept_aside() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::new(tmp.path()).unwrap();
        let config: AppConfig = store.load(CONFIG).unwrap();
        assert_eq!(config, AppConfig::default());

        fs::write(store.path(CONFIG), b"{ not json").unwrap();
        let config: AppConfig = store.load(CONFIG).unwrap();
        assert_eq!(config, AppConfig::default());
        let aside = fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().contains("corrupt"));
        assert!(aside);
    }

    #[test]
    fn round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::new(tmp.path()).unwrap();
        let config = AppConfig {
            setup_complete: true,
            ..Default::default()
        };
        store.save(CONFIG, &config).unwrap();
        assert_eq!(store.load::<AppConfig>(CONFIG).unwrap(), config);
    }
}
