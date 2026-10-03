//! Small, careful filesystem helpers used by the deploy engine.
//!
//! Everything that writes into game folders goes through [`write_atomic`] or
//! [`copy_atomic`]: write a temp file next to the destination, flush it, then rename
//! it over the destination. A crash or power cut never leaves a half-written file.

use std::fs::{self, File, Metadata};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use crate::error::{IoContext, Result};

const TMP_SUFFIX: &str = ".loadout-tmp";

/// Current time as an RFC 3339 string (UTC), used for all timestamps we persist.
pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// A filesystem-safe timestamp for folder names, e.g. `20261003-142501`.
pub fn now_compact() -> String {
    chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string()
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Retry an IO operation a few times when Windows reports the file as busy
/// (antivirus scanners and indexers briefly lock freshly written files).
pub fn with_retry<T>(mut op: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    let mut delay = Duration::from_millis(60);
    for attempt in 0..5 {
        match op() {
            Err(err) if attempt < 4 && is_transient(&err) => {
                std::thread::sleep(delay);
                delay *= 2;
            }
            other => return other,
        }
    }
    unreachable!("the last attempt always returns")
}

fn is_transient(err: &io::Error) -> bool {
    if err.kind() == io::ErrorKind::PermissionDenied {
        return true;
    }
    // ERROR_SHARING_VIOLATION (32) / ERROR_LOCK_VIOLATION (33) on Windows.
    cfg!(windows) && matches!(err.raw_os_error(), Some(32) | Some(33))
}

pub fn mtime_ms(meta: &Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Hash a file with BLAKE3. Returns `(hex hash, size in bytes)`.
pub fn hash_file(path: &Path) -> Result<(String, u64)> {
    let mut file = File::open(path).ctx_path("open", path)?;
    hash_reader(&mut file).ctx_path("read", path)
}

pub fn hash_reader(reader: &mut dyn Read) -> io::Result<(String, u64)> {
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut total = 0u64;
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok((hasher.finalize().to_hex().to_string(), total))
}

pub fn hash_bytes(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

fn tmp_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().unwrap_or_default().to_os_string();
    name.push(TMP_SUFFIX);
    dest.with_file_name(name)
}

pub fn is_readonly(path: &Path) -> bool {
    fs::metadata(path)
        .map(|m| m.permissions().readonly())
        .unwrap_or(false)
}

/// Toggle the read-only flag. On Unix, "writable" only adds the owner write bit.
pub fn set_readonly(path: &Path, readonly: bool) -> io::Result<()> {
    let mut perms = fs::metadata(path)?.permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = perms.mode();
        perms.set_mode(if readonly {
            mode & !0o222
        } else {
            mode | 0o200
        });
    }
    #[cfg(not(unix))]
    perms.set_readonly(readonly);
    fs::set_permissions(path, perms)
}

/// Stream `reader` into `dest` atomically, hashing as we go.
/// Keeps the read-only flag of an existing destination.
pub fn write_stream_atomic(reader: &mut dyn Read, dest: &Path) -> Result<(String, u64)> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).ctx_path("create folder", parent)?;
    }
    let tmp = tmp_path(dest);
    let result = (|| -> io::Result<(String, u64)> {
        let mut out = File::create(&tmp)?;
        let mut hasher = blake3::Hasher::new();
        let mut buf = vec![0u8; 256 * 1024];
        let mut total = 0u64;
        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            out.write_all(&buf[..n])?;
            total += n as u64;
        }
        out.sync_all()?;
        Ok((hasher.finalize().to_hex().to_string(), total))
    })();
    match result {
        Ok(hashed) => {
            replace_with(&tmp, dest)?;
            Ok(hashed)
        }
        Err(err) => {
            let _ = fs::remove_file(&tmp);
            Err(err).ctx_path("write", dest)
        }
    }
}

/// Write bytes to `dest` atomically, keeping its read-only flag if it had one.
pub fn write_atomic(dest: &Path, bytes: &[u8]) -> Result<()> {
    write_stream_atomic(&mut &bytes[..], dest).map(|_| ())
}

/// Copy `src` over `dest` atomically. Returns `(hash, size)` of the copied data.
pub fn copy_atomic(src: &Path, dest: &Path) -> Result<(String, u64)> {
    let mut file = File::open(src).ctx_path("open", src)?;
    write_stream_atomic(&mut file, dest)
}

/// Rename the finished temp file over `dest`.
fn replace_with(tmp: &Path, dest: &Path) -> Result<()> {
    let was_readonly = is_readonly(dest);
    if was_readonly {
        // Windows refuses to replace a read-only file.
        set_readonly(dest, false).ctx_path("unlock", dest)?;
    }
    let renamed = with_retry(|| fs::rename(tmp, dest));
    if let Err(err) = renamed {
        let _ = fs::remove_file(tmp);
        if was_readonly {
            let _ = set_readonly(dest, true);
        }
        return Err(err).ctx_path("replace", dest);
    }
    if was_readonly {
        set_readonly(dest, true).ctx_path("lock", dest)?;
    }
    Ok(())
}

/// Delete a file (clearing read-only first). Returns false if it didn't exist.
pub fn remove_file_if_exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.permissions().readonly() {
                set_readonly(path, false).ctx_path("unlock", path)?;
            }
            with_retry(|| fs::remove_file(path)).ctx_path("delete", path)?;
            Ok(true)
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err).ctx_path("inspect", path),
    }
}

/// Normalise a relative path coming from a pack or archive into `a/b/c` form.
/// Returns `None` for anything that could escape the target folder or that
/// Windows can't store (`..`, absolute paths, drive letters, reserved names…).
pub fn sanitize_rel(raw: &str) -> Option<String> {
    let mut parts = Vec::new();
    for part in raw.split(['/', '\\']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || !is_valid_component(part) {
            return None;
        }
        parts.push(part);
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

fn is_valid_component(part: &str) -> bool {
    if part.len() > 255 || part.ends_with(' ') || part.ends_with('.') {
        return false;
    }
    if part
        .chars()
        .any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
    {
        return false;
    }
    let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit());
    !reserved
}

/// Lower-cased key used to compare relative paths the way Windows does.
pub fn rel_key(rel: &str) -> String {
    rel.to_lowercase()
}

/// Map `a/b/c` onto `root`, reusing the on-disk casing of any components that
/// already exist (Windows paths are case-insensitive; this makes the Linux test
/// suite behave the same way). Returns the full path and the relative path with
/// the actual casing.
pub fn resolve_ci(root: &Path, rel: &str) -> (PathBuf, String) {
    let mut current = root.to_path_buf();
    let mut actual = Vec::new();
    let mut exists = true;
    for part in rel.split('/').filter(|p| !p.is_empty()) {
        let mut chosen = part.to_string();
        if exists {
            // Read the real name from the folder listing: on Windows `exists()`
            // also matches a differently-cased name and would hide its casing.
            match find_ci(&current, part) {
                Some(found) => chosen = found,
                None => exists = false,
            }
        }
        current.push(&chosen);
        actual.push(chosen);
    }
    (current, actual.join("/"))
}

/// The entry in `dir` called `name`, preferring an exact match over a
/// case-insensitive one.
fn find_ci(dir: &Path, name: &str) -> Option<String> {
    let wanted = name.to_lowercase();
    let mut fallback = None;
    for entry in fs::read_dir(dir).ok()?.filter_map(|e| e.ok()) {
        let entry_name = entry.file_name().to_string_lossy().into_owned();
        if entry_name == name {
            return Some(entry_name);
        }
        if fallback.is_none() && entry_name.to_lowercase() == wanted {
            fallback = Some(entry_name);
        }
    }
    fallback
}

/// Create the parent folders of `root/rel`, returning the folders that had to be
/// created (relative to `root`, outermost first) so they can be removed later.
pub fn create_parent_dirs(root: &Path, rel: &str) -> Result<Vec<String>> {
    let mut created = Vec::new();
    let parts: Vec<&str> = rel.split('/').collect();
    let mut current = root.to_path_buf();
    let mut rel_so_far = Vec::new();
    for part in &parts[..parts.len().saturating_sub(1)] {
        current.push(part);
        rel_so_far.push(*part);
        if !current.exists() {
            fs::create_dir(&current).ctx_path("create folder", &current)?;
            created.push(rel_so_far.join("/"));
        }
    }
    Ok(created)
}

/// Remove folders we created earlier, deepest first, but only while they're empty.
pub fn remove_empty_dirs(root: &Path, created: &[String]) {
    let mut dirs: Vec<&String> = created.iter().collect();
    dirs.sort_by_key(|d| std::cmp::Reverse(d.matches('/').count()));
    for dir in dirs {
        let path = rel_to_path(root, dir);
        let is_empty = fs::read_dir(&path)
            .map(|mut it| it.next().is_none())
            .unwrap_or(false);
        if is_empty {
            let _ = fs::remove_dir(&path);
        }
    }
}

pub fn rel_to_path(root: &Path, rel: &str) -> PathBuf {
    let mut path = root.to_path_buf();
    for part in rel.split('/').filter(|p| !p.is_empty()) {
        path.push(part);
    }
    path
}

/// True when `path` stays inside `root` (no `..` tricks).
pub fn is_within(root: &Path, path: &Path) -> bool {
    let mut depth = 0i32;
    match path.strip_prefix(root) {
        Ok(rest) => {
            for comp in rest.components() {
                match comp {
                    Component::ParentDir => depth -= 1,
                    Component::Normal(_) => depth += 1,
                    _ => return false,
                }
                if depth < 0 {
                    return false;
                }
            }
            true
        }
        Err(_) => false,
    }
}

/// Recursively copy a directory (used for snapshots and tests).
pub fn copy_dir(src: &Path, dest: &Path) -> Result<()> {
    for entry in walkdir::WalkDir::new(src) {
        let entry = entry.map_err(|e| {
            crate::error::Error::io(
                format!("Couldn't read {}", src.display()),
                io::Error::other(e.to_string()),
            )
        })?;
        let rel = entry.path().strip_prefix(src).unwrap_or(entry.path());
        let target = dest.join(rel);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target).ctx_path("create folder", &target)?;
        } else {
            fs::copy(entry.path(), &target).ctx_path("copy", entry.path())?;
        }
    }
    Ok(())
}

pub fn dir_size(path: &Path) -> u64 {
    walkdir::WalkDir::new(path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_rejects_escapes_and_reserved_names() {
        assert_eq!(sanitize_rel("a\\b/c.rpf").as_deref(), Some("a/b/c.rpf"));
        assert_eq!(sanitize_rel("./x//y").as_deref(), Some("x/y"));
        assert_eq!(sanitize_rel("../evil.dll"), None);
        assert_eq!(sanitize_rel("a/../../b"), None);
        assert_eq!(sanitize_rel("C:/Windows/x"), None);
        assert_eq!(sanitize_rel("con.txt"), None);
        assert_eq!(sanitize_rel("dir/LPT1"), None);
        assert_eq!(sanitize_rel("trailing./x"), None);
        assert_eq!(sanitize_rel(""), None);
        assert_eq!(
            sanitize_rel("COMPUTER.txt").as_deref(),
            Some("COMPUTER.txt")
        );
    }

    #[test]
    fn resolve_ci_reuses_existing_casing() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("x64/Audio/SFX")).unwrap();
        fs::write(tmp.path().join("x64/Audio/SFX/WEAPONS_PLAYER.rpf"), b"v").unwrap();
        let (path, actual) = resolve_ci(tmp.path(), "X64/audio/sfx/weapons_player.rpf");
        assert_eq!(actual, "x64/Audio/SFX/WEAPONS_PLAYER.rpf");
        assert!(path.exists());
        let (_, actual) = resolve_ci(tmp.path(), "x64/audio/new/thing.rpf");
        assert_eq!(actual, "x64/Audio/new/thing.rpf");
    }

    #[test]
    fn atomic_write_keeps_readonly_flag() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("settings.xml");
        fs::write(&file, b"old").unwrap();
        set_readonly(&file, true).unwrap();
        write_atomic(&file, b"new").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"new");
        assert!(is_readonly(&file));
        set_readonly(&file, false).unwrap();
    }

    #[test]
    fn created_dirs_are_tracked_and_removed() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir(tmp.path().join("mods")).unwrap();
        let created = create_parent_dirs(tmp.path(), "mods/a/b/file.rpf").unwrap();
        assert_eq!(created, vec!["mods/a".to_string(), "mods/a/b".to_string()]);
        remove_empty_dirs(tmp.path(), &created);
        assert!(tmp.path().join("mods").exists());
        assert!(!tmp.path().join("mods/a").exists());
    }

    #[test]
    fn is_within_blocks_parent_traversal() {
        let root = Path::new("/games/fivem");
        assert!(is_within(root, Path::new("/games/fivem/mods/a.rpf")));
        assert!(!is_within(root, Path::new("/games/fivem/../x")));
        assert!(!is_within(root, Path::new("/elsewhere/x")));
    }
}
