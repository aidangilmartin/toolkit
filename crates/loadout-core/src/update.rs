//! Keeping Loadout up to date from its GitHub releases.
//!
//! - [`check`] asks GitHub for the latest release and returns it if it's newer.
//! - [`download`] fetches the right file for this copy (installer or portable
//!   exe) and checks it against the SHA-256 checksum GitHub publishes for it.
//! - The desktop shell then runs the installer, or swaps the portable exe with
//!   [`swap_exe`] and restarts.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;
use sha2::{Digest, Sha256};
use ureq::Agent;

use crate::error::{Error, IoContext, Result};
use crate::model::{InstallKind, UpdateInfo};

pub const RELEASES_API: &str =
    "https://api.github.com/repos/aidangilmartin/toolkit/releases/latest";
/// Release files must come from Loadout's own releases.
const DOWNLOAD_PREFIX: &str = "https://github.com/aidangilmartin/toolkit/releases/download/";
/// Loadout's downloads are a few MB; anything this big isn't one of them.
const DOWNLOAD_LIMIT: u64 = 300 * 1024 * 1024;

/// A newer release, with what's needed to download it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Release {
    pub info: UpdateInfo,
    pub asset_name: String,
    pub asset_url: String,
    /// Lower-case hex SHA-256 of the file, from GitHub.
    pub sha256: String,
}

/// The release API to ask. `LOADOUT_UPDATE_API` points it at a local stand-in,
/// for testing the desktop app.
pub fn releases_api() -> String {
    std::env::var("LOADOUT_UPDATE_API")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| RELEASES_API.to_string())
}

/// `v1.2.3` / `1.2` → `(1, 2, 3)` / `(1, 2, 0)`. Pre-releases (`1.2.3-beta`) and
/// anything else give `None`, so they're never offered as updates.
pub fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let text = text.trim();
    let text = text.strip_prefix(['v', 'V']).unwrap_or(text);
    let mut parts = text.split('.');
    let mut next = || -> Option<u64> {
        match parts.next() {
            None => Some(0),
            Some(part) => part.parse().ok(),
        }
    };
    let version = (next()?, next()?, next()?);
    parts.next().is_none().then_some(version)
}

/// The bullet points under the release notes' "What's new" heading, as plain text.
pub fn whats_new(body: &str) -> Vec<String> {
    let mut notes = Vec::new();
    let mut inside = false;
    for line in body.lines() {
        let line = line.trim();
        if let Some(heading) = line.strip_prefix("## ") {
            inside = heading.to_lowercase().starts_with("what's new");
            continue;
        }
        if let Some(point) = line.strip_prefix("- ").filter(|_| inside) {
            let point = point.replace("**", "").replace('`', "");
            if !point.trim().is_empty() {
                notes.push(point.trim().to_string());
            }
        }
    }
    notes
}

fn agent(timeout: Duration, current: &str) -> Agent {
    Agent::config_builder()
        .timeout_global(Some(timeout))
        .user_agent(format!("Loadout/{current}"))
        .build()
        .into()
}

/// Ask GitHub whether there's a newer Loadout than `current`.
pub fn check(current: &str, kind: InstallKind) -> Result<Option<Release>> {
    check_with(
        &agent(Duration::from_secs(15), current),
        &releases_api(),
        current,
        kind,
    )
}

fn check_with(
    agent: &Agent,
    api: &str,
    current: &str,
    kind: InstallKind,
) -> Result<Option<Release>> {
    let failed = |err: ureq::Error| {
        log::warn!("update check failed: {err}");
        Error::Network("Couldn't check for updates. Check your internet connection.".into())
    };
    let body = agent
        .get(api)
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(failed)?
        .body_mut()
        .with_config()
        .limit(4 * 1024 * 1024)
        .read_to_vec()
        .map_err(failed)?;
    let release: Value = serde_json::from_slice(&body).map_err(|_| {
        Error::Network("The update server answered with something unexpected.".into())
    })?;
    parse_release(&release, api, current, kind)
}

fn parse_release(
    release: &Value,
    api: &str,
    current: &str,
    kind: InstallKind,
) -> Result<Option<Release>> {
    if release["draft"].as_bool() == Some(true) || release["prerelease"].as_bool() == Some(true) {
        return Ok(None);
    }
    let tag = release["tag_name"].as_str().unwrap_or_default();
    let (Some(latest), Some(installed)) = (parse_version(tag), parse_version(current)) else {
        return Ok(None);
    };
    if latest <= installed {
        return Ok(None);
    }

    let suffix = match kind {
        InstallKind::Installer => "_x64-setup.exe",
        InstallKind::Portable => "_x64-portable.exe",
    };
    let missing = || {
        Error::Network(format!(
            "Loadout {tag} is out, but its download isn't ready yet. Try again in a few minutes."
        ))
    };
    let asset = release["assets"]
        .as_array()
        .and_then(|assets| {
            assets.iter().find(|a| {
                a["name"]
                    .as_str()
                    .is_some_and(|name| name.starts_with("Loadout_") && name.ends_with(suffix))
            })
        })
        .ok_or_else(missing)?;
    let url = asset["browser_download_url"].as_str().unwrap_or_default();
    if !allowed_download(url, api) {
        log::warn!("refusing update download from {url}");
        return Err(missing());
    }
    let sha256 = asset["digest"]
        .as_str()
        .and_then(|d| d.strip_prefix("sha256:"))
        .map(str::to_ascii_lowercase)
        .filter(|d| d.len() == 64 && d.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(missing)?;
    let size = asset["size"].as_u64().unwrap_or_default();
    if size == 0 || size > DOWNLOAD_LIMIT {
        return Err(missing());
    }

    let version = tag.trim_start_matches(['v', 'V']).to_string();
    Ok(Some(Release {
        info: UpdateInfo {
            version,
            current_version: current.to_string(),
            notes: whats_new(release["body"].as_str().unwrap_or_default()),
            release_url: release["html_url"]
                .as_str()
                .filter(|u| u.starts_with("https://github.com/") || api != RELEASES_API)
                .unwrap_or("https://github.com/aidangilmartin/toolkit/releases/latest")
                .to_string(),
            published_at: release["published_at"].as_str().map(str::to_string),
            size,
            kind,
        },
        asset_name: asset["name"].as_str().unwrap_or_default().to_string(),
        asset_url: url.to_string(),
        sha256,
    }))
}

/// Release files come from Loadout's GitHub releases (or, when testing against a
/// local stand-in, from the same server as the release API).
fn allowed_download(url: &str, api: &str) -> bool {
    if api == RELEASES_API {
        return url.starts_with(DOWNLOAD_PREFIX);
    }
    let origin = |u: &str| -> Option<String> {
        let (scheme, rest) = u.split_once("://")?;
        Some(format!("{scheme}://{}/", rest.split('/').next()?))
    };
    origin(api).is_some_and(|o| url.starts_with(&o))
}

/// Download the release's file to `dest` and check it's exactly what GitHub
/// published. A damaged or tampered download is deleted and refused.
pub fn download(release: &Release, dest: &Path, progress: &mut dyn FnMut(u64, u64)) -> Result<()> {
    download_with(
        &agent(Duration::from_secs(10 * 60), &release.info.current_version),
        release,
        dest,
        progress,
    )
}

fn download_with(
    agent: &Agent,
    release: &Release,
    dest: &Path,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<()> {
    let failed = |err: ureq::Error| {
        log::warn!("update download failed: {err}");
        Error::Network("The download stopped. Check your internet connection and try again.".into())
    };
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).ctx_path("create folder", dir)?;
    }
    let mut response = agent.get(&release.asset_url).call().map_err(failed)?;
    let mut reader = response
        .body_mut()
        .with_config()
        .limit(DOWNLOAD_LIMIT)
        .reader();
    let result = (|| -> Result<(String, u64)> {
        let mut file = File::create(dest).ctx_path("save the update to", dest)?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 64 * 1024];
        let mut done = 0u64;
        let total = release.info.size;
        progress(0, total);
        loop {
            let n = reader.read(&mut buf).map_err(|err| {
                log::warn!("update download failed: {err}");
                Error::Network(
                    "The download stopped. Check your internet connection and try again.".into(),
                )
            })?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            file.write_all(&buf[..n])
                .ctx_path("save the update to", dest)?;
            done += n as u64;
            progress(done.min(total), total);
        }
        file.sync_all().ctx_path("save the update to", dest)?;
        let digest: String = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        Ok((digest, done))
    })();
    match result {
        Ok((digest, size)) if digest == release.sha256 && size == release.info.size => Ok(()),
        Ok(_) => {
            let _ = fs::remove_file(dest);
            Err(Error::Network(
                "The download was damaged (it doesn't match the published checksum), so it wasn't installed. Try again.".into(),
            ))
        }
        Err(err) => {
            let _ = fs::remove_file(dest);
            Err(err)
        }
    }
}

/// Where the previous exe is kept while a portable update replaces it.
pub fn old_exe_path(exe: &Path) -> PathBuf {
    let name = exe
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Loadout.exe".into());
    exe.with_file_name(format!("{name}.old"))
}

/// Put `new_exe` in place of the running `exe`. Windows lets a running exe be
/// renamed (not overwritten), so the old one moves aside and is deleted on the
/// next start. If anything fails, the original is put back.
pub fn swap_exe(exe: &Path, new_exe: &Path) -> Result<()> {
    let old = old_exe_path(exe);
    let _ = fs::remove_file(&old);
    fs::rename(exe, &old).ctx_path("move aside", exe)?;
    if let Err(err) = fs::rename(new_exe, exe) {
        let _ = fs::rename(&old, exe);
        return Err(err).ctx_path("put the new version in place of", exe);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(exe, fs::Permissions::from_mode(0o755));
    }
    Ok(())
}

/// Tidy up after an update: the previous portable exe and downloaded installers.
pub fn clean_up(exe: &Path, download_dir: &Path) {
    let _ = fs::remove_file(old_exe_path(exe));
    let _ = fs::remove_dir_all(download_dir);
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::json;

    use super::*;
    use crate::test_http::{agent as test_agent, serve_with, Reply};

    #[test]
    fn compares_versions() {
        assert_eq!(parse_version("v0.3.1"), Some((0, 3, 1)));
        assert_eq!(parse_version("1.2"), Some((1, 2, 0)));
        assert_eq!(parse_version(" 2 "), Some((2, 0, 0)));
        assert_eq!(parse_version("1.2.3-beta.1"), None);
        assert_eq!(parse_version("1.2.3.4"), None);
        assert_eq!(parse_version("latest"), None);
        assert!(parse_version("0.10.0") > parse_version("0.9.9"));
    }

    #[test]
    fn reads_whats_new() {
        let body = "Intro\n\n## Download\n\n- **setup.exe**: the installer\n\n## What's new\n\n- **Fixed:** Play starts FiveM.\n- Search the `server list`.\n\n## Good to know\n\n- Not this one";
        assert_eq!(
            whats_new(body),
            ["Fixed: Play starts FiveM.", "Search the server list."]
        );
        assert!(whats_new("no headings").is_empty());
    }

    fn release(tag: &str, base: &str, digest: &str) -> Value {
        json!({
            "tag_name": tag,
            "html_url": format!("{base}/releases/tag/{tag}"),
            "body": "## What's new\n\n- One-click updates.",
            "published_at": "2026-10-12T10:00:00Z",
            "draft": false,
            "prerelease": false,
            "assets": [
                {
                    "name": format!("Loadout_{}_x64-setup.exe", tag.trim_start_matches('v')),
                    "browser_download_url": format!("{base}/download/setup.exe"),
                    "size": 11,
                    "digest": digest,
                },
                {
                    "name": format!("Loadout_{}_x64-portable.exe", tag.trim_start_matches('v')),
                    "browser_download_url": format!("{base}/download/portable.exe"),
                    "size": 11,
                    "digest": digest,
                }
            ]
        })
    }

    const HELLO_SHA: &str =
        "sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

    #[test]
    fn picks_the_right_download() {
        let api = "http://127.0.0.1:1/api/latest";
        let base = "http://127.0.0.1:1";
        let found = parse_release(
            &release("v0.4.0", base, HELLO_SHA),
            api,
            "0.3.1",
            InstallKind::Installer,
        )
        .unwrap()
        .unwrap();
        assert_eq!(found.info.version, "0.4.0");
        assert_eq!(found.info.notes, ["One-click updates."]);
        assert_eq!(found.asset_name, "Loadout_0.4.0_x64-setup.exe");
        assert_eq!(found.sha256.len(), 64);
        let portable = parse_release(
            &release("v0.4.0", base, HELLO_SHA),
            api,
            "0.3.1",
            InstallKind::Portable,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            portable.asset_url,
            "http://127.0.0.1:1/download/portable.exe"
        );

        // Same or older: nothing to do.
        for current in ["0.4.0", "0.5.0"] {
            let none = parse_release(
                &release("v0.4.0", base, HELLO_SHA),
                api,
                current,
                InstallKind::Installer,
            );
            assert_eq!(none.unwrap(), None);
        }
        // Drafts and pre-releases are never offered.
        let mut draft = release("v0.4.0", base, HELLO_SHA);
        draft["prerelease"] = json!(true);
        assert_eq!(
            parse_release(&draft, api, "0.3.1", InstallKind::Installer).unwrap(),
            None
        );
        // No checksum, or a download from somewhere else: refused.
        assert!(parse_release(
            &release("v0.4.0", base, ""),
            api,
            "0.3.1",
            InstallKind::Installer
        )
        .is_err());
        let elsewhere = release("v0.4.0", "https://evil.example", HELLO_SHA);
        assert!(parse_release(&elsewhere, api, "0.3.1", InstallKind::Installer).is_err());
        // The real API only accepts Loadout's own GitHub release downloads.
        let github = release(
            "v0.4.0",
            "https://github.com/aidangilmartin/toolkit/releases",
            HELLO_SHA,
        );
        assert!(parse_release(&github, RELEASES_API, "0.3.1", InstallKind::Installer).is_ok());
        let other_repo = release(
            "v0.4.0",
            "https://github.com/someone/else/releases",
            HELLO_SHA,
        );
        assert!(parse_release(&other_repo, RELEASES_API, "0.3.1", InstallKind::Installer).is_err());
    }

    #[test]
    fn checks_downloads_and_verifies_them() {
        let port = serve_with(|port| {
            let base = format!("http://127.0.0.1:{port}");
            HashMap::from([
                (
                    "/api/latest".to_string(),
                    Reply::ok(release("v0.4.0", &base, HELLO_SHA).to_string()),
                ),
                (
                    "/download/setup.exe".to_string(),
                    Reply::redirect("/objects/setup"),
                ),
                ("/objects/setup".to_string(), Reply::ok(&b"hello world"[..])),
                (
                    "/download/portable.exe".to_string(),
                    Reply::ok(&b"hello WORLD"[..]),
                ),
            ])
        });
        let api = format!("http://127.0.0.1:{port}/api/latest");
        let dir = tempfile::tempdir().unwrap();

        let release = check_with(&test_agent(), &api, "0.3.1", InstallKind::Installer)
            .unwrap()
            .unwrap();
        let dest = dir.path().join("setup.exe");
        let mut seen = Vec::new();
        download_with(&test_agent(), &release, &dest, &mut |done, total| {
            seen.push((done, total))
        })
        .unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"hello world");
        assert_eq!(seen.last(), Some(&(11, 11)));

        // A file that doesn't match its checksum is deleted and refused.
        let portable = check_with(&test_agent(), &api, "0.3.1", InstallKind::Portable)
            .unwrap()
            .unwrap();
        let bad = dir.path().join("portable.exe");
        let err = download_with(&test_agent(), &portable, &bad, &mut |_, _| {}).unwrap_err();
        assert!(err.to_string().contains("damaged"), "{err}");
        assert!(!bad.exists());

        let closed = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let offline = check_with(
            &test_agent(),
            &format!("http://127.0.0.1:{closed}/nope"),
            "0.3.1",
            InstallKind::Installer,
        )
        .unwrap_err();
        assert!(
            offline.to_string().contains("Couldn't check for updates"),
            "{offline}"
        );
    }

    #[test]
    fn swaps_the_portable_exe() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("Loadout.exe");
        let new = dir.path().join(".Loadout.exe.download");
        fs::write(&exe, "old version").unwrap();
        fs::write(&new, "new version").unwrap();
        swap_exe(&exe, &new).unwrap();
        assert_eq!(fs::read_to_string(&exe).unwrap(), "new version");
        assert_eq!(
            fs::read_to_string(old_exe_path(&exe)).unwrap(),
            "old version"
        );
        assert!(!new.exists());

        // A failed swap puts the original back.
        let err = swap_exe(&exe, &dir.path().join("missing.exe")).unwrap_err();
        assert!(err.to_string().contains("new version"), "{err}");
        assert_eq!(fs::read_to_string(&exe).unwrap(), "new version");

        let downloads = dir.path().join("downloads");
        fs::create_dir_all(&downloads).unwrap();
        clean_up(&exe, &downloads);
        assert!(!old_exe_path(&exe).exists());
        assert!(!downloads.exists());
        assert!(exe.exists());
    }
}
