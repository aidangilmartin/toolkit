//! Back end for the sound maker (the gun sound pack editor). Its logic runs in the UI
//! (`src/soundmaker`); this module gives it files and the CodeWalker bridge, which reads and
//! rebuilds GTA V's audio archives.
//!
//! Reading is allowed anywhere, as the player picks sounds, banks and packs from all over.
//! Writing is kept to the sound maker's own folder and the temp folder, plus the few files an
//! export writes into a folder the player picked (README.txt, ID-LEGEND.txt, .rpf, .gunpack
//! and .zip files).

use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Error, IoContext, Result};
use crate::fsutil;

/// File names an export may write into (or remove from) a folder the player picked.
const EXPORT_FILE_NAMES: &[&str] = &["readme.txt", "id-legend.txt"];
const EXPORT_EXTENSIONS: &[&str] = &["rpf", "gunpack", "zip"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub is_dir: bool,
    pub size: u64,
    pub mtime_ms: i64,
}

/// A failed bridge command. `code` comes from the bridge (e.g. `keys`, `no-tts`) or is one of
/// `no-bridge`, `spawn` and `crash`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BridgeError {
    pub code: String,
    pub message: String,
}

impl BridgeError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        BridgeError {
            code: code.into(),
            message: message.into(),
        }
    }
}

/// Where the bridge comes from.
pub enum BridgeSource {
    None,
    /// An executable on disk (development builds, tests).
    Path(PathBuf),
    /// Built into Loadout's exe, written out to the sound maker's folder on first use, so the
    /// portable exe has it too. (It holds no CodeWalker code: that comes from the player's own
    /// CodeWalker download.)
    Embedded(&'static [u8]),
}

pub struct SoundMaker {
    root: PathBuf,
    temp: PathBuf,
    source: BridgeSource,
    installed: OnceLock<Option<PathBuf>>,
}

#[cfg(windows)]
const BRIDGE_FILE: &str = "gunpack-bridge.exe";
#[cfg(not(windows))]
const BRIDGE_FILE: &str = "gunpack-bridge";

impl SoundMaker {
    /// `root` is the sound maker's data folder.
    pub fn new(root: PathBuf, source: BridgeSource) -> Self {
        SoundMaker {
            root,
            temp: std::env::temp_dir(),
            source,
            installed: OnceLock::new(),
        }
    }

    /// Uses another temp folder (tests).
    pub fn with_temp_dir(mut self, temp: PathBuf) -> Self {
        self.temp = temp;
        self
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn bridge_available(&self) -> bool {
        match &self.source {
            BridgeSource::None => false,
            BridgeSource::Path(p) => p.is_file(),
            BridgeSource::Embedded(_) => true,
        }
    }

    /// The bridge executable, writing out the embedded one the first time.
    fn bridge_exe(&self) -> std::result::Result<PathBuf, BridgeError> {
        let missing = || {
            BridgeError::new(
                "no-bridge",
                "The CodeWalker bridge is missing from this build of Loadout. Run \"pnpm build:bridge\" (needs the .NET 8 SDK) and rebuild.",
            )
        };
        match &self.source {
            BridgeSource::None => Err(missing()),
            BridgeSource::Path(p) => p.is_file().then(|| p.clone()).ok_or_else(missing),
            BridgeSource::Embedded(exe) => {
                let installed = self.installed.get_or_init(|| {
                    install_bridge(&self.root.join("bridge"), exe)
                        .inspect_err(|e| log::warn!("couldn't write out the bridge: {e}"))
                        .ok()
                });
                installed.clone().ok_or_else(|| {
                    BridgeError::new(
                        "spawn",
                        format!(
                            "Couldn't set up the CodeWalker bridge in {}. Check the disk has space.",
                            self.root.join("bridge").display()
                        ),
                    )
                })
            }
        }
    }

    // ---- Paths -----------------------------------------------------------------

    fn absolute(raw: &str) -> Result<PathBuf> {
        let path = PathBuf::from(raw);
        if !path.is_absolute() {
            return Err(Error::invalid(format!("Not a full path: {raw}")));
        }
        if path.components().any(|c| c == Component::ParentDir) {
            return Err(Error::invalid(format!("Not allowed: {raw}")));
        }
        Ok(path)
    }

    fn in_own_folders(&self, path: &Path) -> bool {
        fsutil::is_within(&self.root, path) || fsutil::is_within(&self.temp, path)
    }

    fn is_export_file(path: &Path) -> bool {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        EXPORT_FILE_NAMES.contains(&name.as_str()) || EXPORT_EXTENSIONS.contains(&ext.as_str())
    }

    /// A path the sound maker may write a file to.
    fn writable_file(&self, raw: &str) -> Result<PathBuf> {
        let path = Self::absolute(raw)?;
        if self.in_own_folders(&path) || Self::is_export_file(&path) {
            Ok(path)
        } else {
            Err(Error::invalid(format!(
                "The sound maker can't write to {}",
                path.display()
            )))
        }
    }

    /// A path inside the sound maker's own folders (or the temp folder).
    fn own_path(&self, raw: &str) -> Result<PathBuf> {
        let path = Self::absolute(raw)?;
        if self.in_own_folders(&path) {
            Ok(path)
        } else {
            Err(Error::invalid(format!(
                "The sound maker can't change {}",
                path.display()
            )))
        }
    }

    // ---- Files -----------------------------------------------------------------

    pub fn stat(&self, raw: &str) -> Result<Option<FileStat>> {
        let path = Self::absolute(raw)?;
        Ok(fs::metadata(&path).ok().map(|m| FileStat {
            is_dir: m.is_dir(),
            size: m.len(),
            mtime_ms: fsutil::mtime_ms(&m),
        }))
    }

    pub fn read_dir(&self, raw: &str) -> Result<Vec<String>> {
        let path = Self::absolute(raw)?;
        let Ok(entries) = fs::read_dir(&path) else {
            return Ok(Vec::new());
        };
        let mut names: Vec<String> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        Ok(names)
    }

    pub fn read_file(&self, raw: &str) -> Result<Vec<u8>> {
        let path = Self::absolute(raw)?;
        fs::read(&path).ctx_path("read", &path)
    }

    pub fn write_file(&self, raw: &str, bytes: &[u8]) -> Result<()> {
        let path = self.writable_file(raw)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).ctx_path("create folder", parent)?;
        }
        fs::write(&path, bytes).ctx_path("write", &path)
    }

    /// Creates a folder (and its parents). Exports make one in a folder the player picked.
    pub fn mkdir(&self, raw: &str) -> Result<()> {
        let path = Self::absolute(raw)?;
        fs::create_dir_all(&path).ctx_path("create folder", &path)
    }

    /// Removes a file or folder in the sound maker's own folders, or an export file anywhere.
    /// Missing paths are fine.
    pub fn remove(&self, raw: &str) -> Result<()> {
        let path = Self::absolute(raw)?;
        let own = self.in_own_folders(&path);
        if path == self.root || path == self.temp || (!own && !Self::is_export_file(&path)) {
            return Err(Error::invalid(format!(
                "The sound maker can't remove {}",
                path.display()
            )));
        }
        match fs::symlink_metadata(&path) {
            Err(_) => Ok(()),
            Ok(meta) if meta.is_dir() => {
                if !own {
                    return Err(Error::invalid(format!(
                        "The sound maker can't remove {}",
                        path.display()
                    )));
                }
                fs::remove_dir_all(&path).ctx_path("remove", &path)
            }
            Ok(_) => fsutil::remove_file_if_exists(&path).map(|_| ()),
        }
    }

    /// Renames within the sound maker's own folders.
    pub fn rename(&self, from: &str, to: &str) -> Result<()> {
        let from = self.own_path(from)?;
        let to = self.own_path(to)?;
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).ctx_path("create folder", parent)?;
        }
        fsutil::with_retry(|| fs::rename(&from, &to)).ctx_path("move", &from)
    }

    /// Copies a file or folder from anywhere into the sound maker's own folders.
    pub fn copy(&self, from: &str, to: &str) -> Result<()> {
        let from = Self::absolute(from)?;
        let to = self.own_path(to)?;
        if from.is_dir() {
            fsutil::copy_dir(&from, &to)
        } else {
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent).ctx_path("create folder", parent)?;
            }
            fs::copy(&from, &to).ctx_path("copy", &from).map(|_| ())
        }
    }

    /// A new, empty scratch folder in the sound maker's folder.
    pub fn make_temp_dir(&self, prefix: &str) -> Result<PathBuf> {
        let safe: String = prefix
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .take(32)
            .collect();
        let dir = self
            .root
            .join("work")
            .join(format!("{safe}{}", fsutil::new_id()));
        fs::create_dir_all(&dir).ctx_path("create folder", &dir)?;
        Ok(dir)
    }

    /// Clears scratch folders left behind by a crash. Call at start-up.
    pub fn clean_up(&self) {
        let _ = fs::remove_dir_all(self.root.join("work"));
    }

    // ---- Bridge ----------------------------------------------------------------

    /// Runs one bridge command. The bridge prints one JSON line on stdout
    /// (`{"ok":true,"result":…}` or `{"ok":false,"code":…,"error":…}`) and JSON progress lines
    /// (`{"progress":"…"}`) on stderr.
    pub fn run_bridge(
        &self,
        args: &[String],
        on_progress: &mut dyn FnMut(String),
    ) -> std::result::Result<Value, BridgeError> {
        let exe = self.bridge_exe()?;
        run_bridge_exe(&exe, args, on_progress)
    }
}

/// Writes the embedded bridge into `<dir>/<content hash>/`, once per version, and removes
/// older versions.
fn install_bridge(dir: &Path, exe: &[u8]) -> Result<PathBuf> {
    let mut hash = fsutil::hash_bytes(exe);
    hash.truncate(16);
    let target = dir.join(&hash);
    let exe_path = target.join(BRIDGE_FILE);
    let complete = fs::metadata(&exe_path).is_ok_and(|m| m.len() == exe.len() as u64);
    if !complete {
        fs::create_dir_all(&target).ctx_path("create folder", &target)?;
        fsutil::write_atomic(&exe_path, exe)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&exe_path, fs::Permissions::from_mode(0o755))
                .ctx_path("set up", &exe_path)?;
        }
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy() != hash {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(exe_path)
}

pub fn run_bridge_exe(
    exe: &Path,
    args: &[String],
    on_progress: &mut dyn FnMut(String),
) -> std::result::Result<Value, BridgeError> {
    let mut command = Command::new(exe);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|e| {
        BridgeError::new(
            "spawn",
            format!("Could not start the CodeWalker bridge: {e}"),
        )
    })?;

    let mut stdout = child.stdout.take().expect("piped stdout");
    let stdout_thread = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        text
    });

    let mut stderr_text: Vec<String> = Vec::new();
    if let Some(stderr) = child.stderr.take() {
        for line in BufReader::new(stderr).lines().map_while(|l| l.ok()) {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(&line) {
                Ok(msg) => {
                    if let Some(p) = msg.get("progress").and_then(Value::as_str) {
                        if !p.starts_with("debug") {
                            on_progress(p.to_string());
                        }
                    }
                }
                Err(_) => stderr_text.push(line),
            }
        }
    }
    let status = child
        .wait()
        .map_err(|e| BridgeError::new("crash", format!("The CodeWalker bridge failed: {e}")))?;
    let stdout = stdout_thread.join().unwrap_or_default();

    let last = stdout.trim().lines().last().unwrap_or("").trim();
    let parsed: Value = serde_json::from_str(last).map_err(|_| {
        let tail = stderr_text
            .iter()
            .rev()
            .take(5)
            .rev()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        let detail = if !tail.is_empty() {
            tail
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            format!("exit code {}", status.code().unwrap_or(-1))
        };
        BridgeError::new("crash", format!("The CodeWalker bridge failed: {detail}"))
    })?;
    if parsed.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(parsed.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(BridgeError::new(
            parsed
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("error"),
            parsed
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Unknown bridge error."),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn maker() -> (tempfile::TempDir, SoundMaker) {
        let tmp = tempfile::tempdir().unwrap();
        let sm = SoundMaker::new(tmp.path().join("soundmaker"), BridgeSource::None)
            .with_temp_dir(tmp.path().join("temp"));
        (tmp, sm)
    }

    fn s(p: &Path) -> String {
        p.display().to_string()
    }

    #[test]
    fn files_round_trip_in_its_own_folder() {
        let (_tmp, sm) = maker();
        let bank = sm.root().join("templates/resident/weapons.awc");
        sm.write_file(&s(&bank), b"abc").unwrap();
        assert_eq!(sm.read_file(&s(&bank)).unwrap(), b"abc");
        assert_eq!(
            sm.read_dir(&s(&sm.root().join("templates"))).unwrap(),
            vec!["resident"]
        );
        let st = sm.stat(&s(&bank)).unwrap().unwrap();
        assert!(!st.is_dir);
        assert_eq!(st.size, 3);
        assert!(sm.stat(&s(&sm.root().join("nope"))).unwrap().is_none());
        assert!(sm.read_dir(&s(&sm.root().join("nope"))).unwrap().is_empty());

        let moved = sm.root().join("templates/dlc/weapons.awc");
        sm.rename(&s(&bank), &s(&moved)).unwrap();
        assert!(moved.is_file());
        sm.remove(&s(&sm.root().join("templates"))).unwrap();
        assert!(!moved.exists());
        sm.remove(&s(&sm.root().join("missing"))).unwrap();
    }

    #[test]
    fn writes_elsewhere_only_export_files() {
        let (tmp, sm) = maker();
        let picked = tmp.path().join("Desktop/my_pack");
        sm.mkdir(&s(&picked)).unwrap();
        sm.write_file(&s(&picked.join("README.txt")), b"x").unwrap();
        sm.write_file(&s(&picked.join("WEAPONS_PLAYER.rpf")), b"x")
            .unwrap();
        sm.write_file(&s(&tmp.path().join("p.gunpack")), b"x")
            .unwrap();
        assert!(sm.write_file(&s(&picked.join("evil.exe")), b"x").is_err());
        assert!(sm.write_file(&s(&picked.join("notes.txt")), b"x").is_err());
        assert!(sm.write_file("relative/README.txt", b"x").is_err());
        let sneaky = format!("{}/../../x.exe", sm.root().display());
        assert!(sm.write_file(&sneaky, b"x").is_err());

        sm.remove(&s(&picked.join("README.txt"))).unwrap();
        assert!(!picked.join("README.txt").exists());
        // folders outside its own are never removed, and nothing is moved out there
        assert!(sm.remove(&s(&picked)).is_err());
        assert!(picked.is_dir());
        assert!(sm
            .rename(
                &s(&picked.join("WEAPONS_PLAYER.rpf")),
                &s(&sm.root().join("x"))
            )
            .is_err());
        assert!(sm.remove(&s(sm.root())).is_err());
    }

    #[test]
    fn copies_in_and_makes_scratch_folders() {
        let (tmp, sm) = maker();
        let pack = tmp.path().join("pack");
        fs::create_dir_all(pack.join("sub")).unwrap();
        fs::write(pack.join("sub/RESIDENT.rpf"), b"r").unwrap();
        let dest = sm.root().join("vanilla");
        sm.copy(&s(&pack), &s(&dest)).unwrap();
        assert_eq!(fs::read(dest.join("sub/RESIDENT.rpf")).unwrap(), b"r");
        assert!(sm.copy(&s(&pack), &s(&tmp.path().join("out"))).is_err());

        let a = sm.make_temp_dir("gsm-load-").unwrap();
        let b = sm.make_temp_dir("gsm-load-").unwrap();
        assert_ne!(a, b);
        assert!(a.is_dir() && fsutil::is_within(sm.root(), &a));
        sm.clean_up();
        assert!(!a.exists());
    }

    #[test]
    fn says_when_the_bridge_is_missing() {
        let (_tmp, sm) = maker();
        assert!(!sm.bridge_available());
        let err = sm.run_bridge(&["list".into()], &mut |_| {}).unwrap_err();
        assert_eq!(err.code, "no-bridge");
    }

    #[cfg(unix)]
    fn fake_bridge(dir: &Path, script: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-bridge");
        fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn runs_the_bridge_and_forwards_progress() {
        let tmp = tempfile::tempdir().unwrap();
        let exe = fake_bridge(
            tmp.path(),
            r#"echo '{"progress":"step 1"}' >&2
echo '{"progress":"debug: hidden"}' >&2
echo 'not json' >&2
echo "{\"ok\":true,\"result\":{\"first\":\"$1\",\"count\":$#}}""#,
        );
        let sm = SoundMaker::new(tmp.path().join("sm"), BridgeSource::Path(exe));
        assert!(sm.bridge_available());
        let mut seen = Vec::new();
        let result = sm
            .run_bridge(&["list".into(), "--gta".into(), "x".into()], &mut |p| {
                seen.push(p)
            })
            .unwrap();
        assert_eq!(result, serde_json::json!({ "first": "list", "count": 3 }));
        assert_eq!(seen, vec!["step 1"]);
    }

    #[cfg(unix)]
    #[test]
    fn writes_out_the_embedded_bridge_once_per_version() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("sm");
        static V1: &[u8] = b"#!/bin/sh\necho '{\"ok\":true,\"result\":1}'\n";
        static V2: &[u8] = b"#!/bin/sh\necho '{\"ok\":true,\"result\":2}'\n";
        let run = |exe: &'static [u8]| {
            let sm = SoundMaker::new(root.clone(), BridgeSource::Embedded(exe));
            assert!(sm.bridge_available());
            sm.run_bridge(&[], &mut |_| {}).unwrap()
        };
        assert_eq!(run(V1), serde_json::json!(1));
        assert_eq!(run(V1), serde_json::json!(1));
        assert_eq!(run(V2), serde_json::json!(2));
        let versions = fs::read_dir(root.join("bridge")).unwrap().count();
        assert_eq!(versions, 1);
    }

    #[cfg(unix)]
    #[test]
    fn turns_bridge_failures_into_coded_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let failing = fake_bridge(
            tmp.path(),
            r#"echo '{"ok":false,"code":"keys","error":"bad keys"}'; exit 1"#,
        );
        let err = run_bridge_exe(&failing, &[], &mut |_| {}).unwrap_err();
        assert_eq!(err, BridgeError::new("keys", "bad keys"));

        let dir = tmp.path().join("crash");
        fs::create_dir_all(&dir).unwrap();
        let crash = fake_bridge(&dir, "echo 'Unhandled exception' >&2; exit 3");
        let err = run_bridge_exe(&crash, &[], &mut |_| {}).unwrap_err();
        assert_eq!(err.code, "crash");
        assert!(err.message.contains("Unhandled exception"));
    }
}
