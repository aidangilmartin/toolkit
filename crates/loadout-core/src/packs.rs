//! The pack library: import folders, `.zip` archives or single `.rpf` files,
//! work out where their files belong, and store them under `packs/<id>/`.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::error::{Error, IoContext, Result};
use crate::fsutil;
use crate::model::{
    ImportProposal, InstallRoot, Pack, PackCategory, PackFile, PackLayout, Progress, ProgressStage,
    ProposedFile, ProposedFileKind,
};

/// Audio archives that live loose in `GTA V\x64\audio\sfx` (matched on the file stem).
const AUDIO_RPF_PREFIXES: &[&str] = &[
    "weapons_player",
    "resident",
    "police_scanner",
    "pain",
    "animals",
    "streamed_vehicles",
    "streamed_ambience",
    "explosions",
];
const DOC_EXTENSIONS: &[&str] = &[
    "txt", "md", "url", "png", "jpg", "jpeg", "gif", "webp", "bmp", "pdf", "html", "htm", "nfo",
    "rtf", "docx",
];
const BLOCKED_EXTENSIONS: &[&str] = &[
    "exe", "asi", "bat", "cmd", "ps1", "vbs", "vbe", "js", "jse", "wsf", "scr", "com", "msi",
    "lnk", "reg", "sys", "cpl",
];
const JUNK_NAMES: &[&str] = &[".ds_store", "thumbs.db", "desktop.ini"];
const RESHADE_MARKERS: &[&str] = &["dxgi.dll", "d3d11.dll", "reshade.ini", "reshadepreset.ini"];

pub const GTA_WARNING: &str = "This pack replaces GTA V game files. That also affects Story Mode and GTA Online, so use \"Restore vanilla\" before playing GTA Online.";

#[derive(Debug, Clone)]
struct Entry {
    /// Path inside the source, `/`-separated, as found.
    path: String,
    size: u64,
}

enum Source {
    Dir(PathBuf),
    Zip(PathBuf),
    Single(PathBuf),
}

fn open_source(path: &Path) -> Result<Source> {
    if path.is_dir() {
        return Ok(Source::Dir(path.to_path_buf()));
    }
    if !path.is_file() {
        return Err(Error::NotFound(path.display().to_string()));
    }
    let ext = extension(&path.to_string_lossy());
    match ext.as_str() {
        "zip" => Ok(Source::Zip(path.to_path_buf())),
        "rpf" => Ok(Source::Single(path.to_path_buf())),
        "rar" | "7z" => Err(Error::invalid(
            "RAR and 7z archives aren't supported yet. Extract it first, then import the folder.",
        )),
        _ => Err(Error::invalid(
            "Choose a folder, a .zip archive or an .rpf file.",
        )),
    }
}

fn list_entries(source: &Source) -> Result<Vec<Entry>> {
    match source {
        Source::Dir(dir) => {
            let mut entries = Vec::new();
            for item in walkdir::WalkDir::new(dir).follow_links(false) {
                let item =
                    item.map_err(|e| Error::invalid(format!("Couldn't read the folder: {e}")))?;
                if !item.file_type().is_file() {
                    continue;
                }
                let rel = item.path().strip_prefix(dir).unwrap_or(item.path());
                let path = rel.to_string_lossy().replace('\\', "/");
                let size = item.metadata().map(|m| m.len()).unwrap_or(0);
                entries.push(Entry { path, size });
            }
            entries.sort_by(|a, b| a.path.cmp(&b.path));
            Ok(entries)
        }
        Source::Zip(path) => {
            let file = File::open(path).ctx_path("open", path)?;
            let mut archive = zip::ZipArchive::new(file)?;
            let mut entries = Vec::new();
            for i in 0..archive.len() {
                let entry = archive.by_index_raw(i)?;
                if entry.is_dir() {
                    continue;
                }
                if entry.encrypted() {
                    return Err(Error::invalid(
                        "Password-protected archives aren't supported.",
                    ));
                }
                entries.push(Entry {
                    path: entry.name().replace('\\', "/"),
                    size: entry.size(),
                });
            }
            Ok(entries)
        }
        Source::Single(path) => Ok(vec![Entry {
            path: path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            size: fs::metadata(path).map(|m| m.len()).unwrap_or(0),
        }]),
    }
}

fn extension(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => ext.to_ascii_lowercase(),
        _ => String::new(),
    }
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn is_junk(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.split('/').any(|c| c == "__macosx") || JUNK_NAMES.contains(&file_name(&lower))
}

fn is_audio_rpf(path: &str) -> bool {
    let name = file_name(path).to_lowercase();
    match name.strip_suffix(".rpf") {
        Some(stem) => AUDIO_RPF_PREFIXES.iter().any(|p| stem.starts_with(p)),
        None => false,
    }
}

/// Strip folders that wrap the whole pack (`MyPack v2/MyPack/...`).
fn common_base(paths: &[&str]) -> String {
    let meaningful = [
        "citizen",
        "mods",
        "plugins",
        "x64",
        "reshade-shaders",
        "common",
        "platform",
    ];
    let mut base = String::new();
    loop {
        let mut first: Option<&str> = None;
        let mut all_nested = true;
        for p in paths {
            let rest = &p[base.len()..];
            match rest.split_once('/') {
                Some((head, _)) => match first {
                    None => first = Some(head),
                    Some(f) if f == head => {}
                    _ => return base,
                },
                None => {
                    all_nested = false;
                    break;
                }
            }
        }
        match first {
            Some(head) if all_nested && !meaningful.contains(&head.to_lowercase().as_str()) => {
                base.push_str(head);
                base.push('/');
            }
            _ => return base,
        }
    }
}

fn detect_layout(rels: &[String]) -> Option<PackLayout> {
    let lower: Vec<String> = rels.iter().map(|r| r.to_lowercase()).collect();
    let starts = |prefixes: &[&str]| {
        lower
            .iter()
            .any(|l| prefixes.iter().any(|p| l.starts_with(p)))
    };
    if starts(&["citizen/", "mods/", "plugins/", "common/", "platform/"]) {
        return Some(PackLayout::FivemTree);
    }
    if lower.iter().any(|l| l.contains("x64/audio/")) || rels.iter().any(|r| is_audio_rpf(r)) {
        return Some(PackLayout::GtaAudio);
    }
    if lower
        .iter()
        .any(|l| RESHADE_MARKERS.contains(&file_name(l)) || l.contains("reshade-shaders/"))
    {
        return Some(PackLayout::PluginsFolder);
    }
    if lower.iter().any(|l| l.ends_with(".rpf")) {
        return Some(PackLayout::ModsFolder);
    }
    None
}

/// Map a file onto its destination for the chosen layout.
/// `Err(reason)` means the file is skipped (shown as ignored in the wizard).
fn map_dest(layout: PackLayout, rel: &str) -> std::result::Result<String, String> {
    let lower = rel.to_lowercase();
    match layout {
        PackLayout::FivemTree => {
            if ["citizen/", "mods/", "plugins/"]
                .iter()
                .any(|p| lower.starts_with(p))
            {
                Ok(rel.to_string())
            } else if lower.starts_with("common/") || lower.starts_with("platform/") {
                Ok(format!("citizen/{rel}"))
            } else {
                Err("Outside FiveM's citizen, mods and plugins folders".into())
            }
        }
        PackLayout::ModsFolder => {
            if lower.ends_with(".rpf") {
                let rest = if lower.starts_with("mods/") {
                    &rel[5..]
                } else {
                    rel
                };
                Ok(format!("mods/{rest}"))
            } else {
                Err("Only .rpf files belong in the mods folder".into())
            }
        }
        PackLayout::PluginsFolder => {
            let rest = if lower.starts_with("plugins/") {
                &rel[8..]
            } else {
                rel
            };
            Ok(format!("plugins/{rest}"))
        }
        PackLayout::GtaAudio => {
            if let Some(idx) = lower.find("x64/audio/") {
                Ok(rel[idx..].to_string())
            } else if lower.ends_with(".rpf") {
                Ok(format!("x64/audio/sfx/{}", file_name(rel)))
            } else {
                Err("Not a game audio file".into())
            }
        }
    }
}

/// Why a destination may not be installed, if it may not.
pub fn blocked_reason(root: InstallRoot, dest: &str) -> Option<String> {
    let lower = dest.to_lowercase();
    let name = file_name(&lower);
    let ext = extension(&lower);
    if BLOCKED_EXTENSIONS.contains(&ext.as_str()) {
        return Some("Programs and scripts can't be installed".into());
    }
    if name == "dinput8.dll" || name.starts_with("scripthookv") || name == "openiv.asi" {
        return Some("Script hooks and ASI loaders aren't allowed".into());
    }
    match root {
        InstallRoot::GtaInstall => {
            if !lower.starts_with("x64/audio/") {
                return Some(
                    "Only game audio (x64/audio) can be replaced in the GTA V folder".into(),
                );
            }
            if ext == "dll" {
                return Some("DLL files aren't allowed in the GTA V folder".into());
            }
        }
        InstallRoot::FivemApp => {
            let top = lower.split('/').next().unwrap_or("");
            if !matches!(top, "citizen" | "mods" | "plugins") {
                return Some(
                    "Only FiveM's citizen, mods and plugins folders can be changed".into(),
                );
            }
            if ext == "dll" && top != "plugins" {
                return Some("DLL files are only allowed in FiveM's plugins folder".into());
            }
        }
    }
    None
}

fn category_for(layout: PackLayout, dests: &[String]) -> PackCategory {
    match layout {
        PackLayout::GtaAudio => PackCategory::SoundPack,
        PackLayout::ModsFolder => PackCategory::Mods,
        PackLayout::PluginsFolder => PackCategory::Reshade,
        PackLayout::FivemTree => {
            let lower: Vec<String> = dests.iter().map(|d| d.to_lowercase()).collect();
            if lower.iter().any(|d| d.starts_with("citizen/")) {
                PackCategory::Citizen
            } else if lower.iter().any(|d| d.starts_with("plugins/")) {
                PackCategory::Reshade
            } else {
                PackCategory::Mods
            }
        }
    }
}

fn suggested_name(source: &Path) -> String {
    let raw = if source.is_dir() {
        source.file_name().map(|n| n.to_string_lossy().into_owned())
    } else {
        source.file_stem().map(|n| n.to_string_lossy().into_owned())
    };
    let name = raw
        .unwrap_or_else(|| "New pack".into())
        .replace(['_', '.'], " ");
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        "New pack".into()
    } else {
        name.chars().take(80).collect()
    }
}

/// Look at a folder/zip/rpf and propose how to import it. Nothing is copied.
pub fn inspect(source_path: &Path, layout_override: Option<PackLayout>) -> Result<ImportProposal> {
    let source = open_source(source_path)?;
    let entries = list_entries(&source)?;
    if entries.is_empty() {
        return Err(Error::invalid("There are no files in there."));
    }

    let useful: Vec<&str> = entries
        .iter()
        .filter(|e| !is_junk(&e.path))
        .map(|e| e.path.as_str())
        .collect();
    let base = common_base(&useful);
    let rels: Vec<String> = useful.iter().map(|p| p[base.len()..].to_string()).collect();

    let mut warnings = Vec::new();
    let layout = match layout_override.or_else(|| detect_layout(&rels)) {
        Some(layout) => layout,
        None => {
            warnings.push(
                "Couldn't recognise this pack's layout. Pick where it should be installed, or repackage it with citizen/, mods/, plugins/ or x64/audio/sfx/ folders."
                    .into(),
            );
            PackLayout::FivemTree
        }
    };
    let root = layout.root();

    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for entry in &entries {
        let mut proposed = ProposedFile {
            source: entry.path.clone(),
            dest: String::new(),
            kind: ProposedFileKind::Deploy,
            reason: None,
            size: entry.size,
            include: true,
        };
        if is_junk(&entry.path) {
            proposed.kind = ProposedFileKind::Ignored;
            proposed.reason = Some("System junk file".into());
        } else {
            let rel = &entry.path[base.len()..];
            let is_doc = !rel.contains('/') && DOC_EXTENSIONS.contains(&extension(rel).as_str());
            if is_doc {
                proposed.kind = ProposedFileKind::Doc;
                proposed.dest = fsutil::sanitize_rel(rel).unwrap_or_else(|| "readme.txt".into());
            } else {
                match map_dest(layout, rel) {
                    Ok(dest) => match fsutil::sanitize_rel(&dest) {
                        Some(dest) => {
                            proposed.dest = dest.clone();
                            if let Some(reason) = blocked_reason(root, &dest) {
                                proposed.kind = ProposedFileKind::Blocked;
                                proposed.reason = Some(reason);
                            } else if !seen.insert(fsutil::rel_key(&dest)) {
                                proposed.kind = ProposedFileKind::Ignored;
                                proposed.reason = Some("Same path as another file".into());
                            }
                        }
                        None => {
                            proposed.kind = ProposedFileKind::Blocked;
                            proposed.reason = Some("The file name isn't valid on Windows".into());
                        }
                    },
                    Err(reason) => {
                        proposed.kind = ProposedFileKind::Ignored;
                        proposed.reason = Some(reason);
                    }
                }
            }
        }
        proposed.include = matches!(
            proposed.kind,
            ProposedFileKind::Deploy | ProposedFileKind::Doc
        );
        files.push(proposed);
    }

    let deploy_dests: Vec<String> = files
        .iter()
        .filter(|f| f.kind == ProposedFileKind::Deploy)
        .map(|f| f.dest.clone())
        .collect();
    if deploy_dests.is_empty() {
        warnings.push("Nothing in here can be installed with this layout.".into());
    }
    if files.iter().any(|f| f.kind == ProposedFileKind::Blocked) {
        warnings.push("Some files are blocked and won't be imported.".into());
    }
    if root == InstallRoot::GtaInstall && !deploy_dests.is_empty() {
        warnings.push(GTA_WARNING.into());
    }

    Ok(ImportProposal {
        source_path: source_path.display().to_string(),
        source_name: source_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        name: suggested_name(source_path),
        category: category_for(layout, &deploy_dests),
        layout,
        root,
        files,
        warnings,
    })
}

/// Copy the chosen files into the library. The proposal comes back from the UI,
/// so everything is validated again here.
pub fn import(
    packs_dir: &Path,
    proposal: &ImportProposal,
    progress: &mut dyn FnMut(Progress),
) -> Result<Pack> {
    let name = proposal.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(Error::invalid(
            "Give the pack a name (up to 80 characters).",
        ));
    }
    let root = proposal.layout.root();
    let mut deploy = Vec::new();
    let mut docs = Vec::new();
    let mut seen = HashSet::new();
    for file in proposal.files.iter().filter(|f| f.include) {
        let source = fsutil::sanitize_rel(&file.source)
            .ok_or_else(|| Error::invalid(format!("Invalid source path: {}", file.source)))?;
        match file.kind {
            ProposedFileKind::Deploy => {
                let dest = fsutil::sanitize_rel(&file.dest)
                    .ok_or_else(|| Error::invalid(format!("Invalid destination: {}", file.dest)))?;
                if let Some(reason) = blocked_reason(root, &dest) {
                    return Err(Error::invalid(format!("{dest}: {reason}")));
                }
                if !seen.insert(fsutil::rel_key(&dest)) {
                    return Err(Error::invalid(format!(
                        "Two files would be installed as {dest}"
                    )));
                }
                deploy.push((file.source.clone(), source, dest));
            }
            ProposedFileKind::Doc => {
                let dest = fsutil::sanitize_rel(&file.dest).unwrap_or_else(|| "readme.txt".into());
                docs.push((file.source.clone(), source, dest));
            }
            _ => {}
        }
    }
    if deploy.is_empty() {
        return Err(Error::invalid("There's nothing to install in this pack."));
    }

    let source = open_source(Path::new(&proposal.source_path))?;
    let id = fsutil::new_id();
    let staging = packs_dir.join(format!(".import-{id}"));
    let result = (|| -> Result<Pack> {
        let wanted: Vec<(String, PathBuf)> = deploy
            .iter()
            .map(|(raw, _, dest)| {
                (
                    raw.clone(),
                    fsutil::rel_to_path(&staging.join("files"), dest),
                )
            })
            .chain(docs.iter().map(|(raw, _, dest)| {
                (
                    raw.clone(),
                    fsutil::rel_to_path(&staging.join("docs"), dest),
                )
            }))
            .collect();
        let total: u64 = list_entries(&source)?
            .iter()
            .filter(|e| wanted.iter().any(|(raw, _)| raw == &e.path))
            .map(|e| e.size)
            .sum();
        let mut done = 0u64;
        let mut hashes = std::collections::HashMap::new();
        let mut report = |done: u64, file: &str| {
            progress(Progress {
                stage: ProgressStage::Copying,
                done,
                total,
                message: format!("Copying {file}"),
            })
        };
        match &source {
            Source::Dir(dir) => {
                for (raw, target) in &wanted {
                    let src = fsutil::rel_to_path(dir, raw);
                    if !fsutil::is_within(dir, &src) {
                        return Err(Error::invalid(format!("Invalid source path: {raw}")));
                    }
                    report(done, raw);
                    let (hash, size) = fsutil::copy_atomic(&src, target)?;
                    done += size;
                    hashes.insert(raw.clone(), (hash, size));
                }
            }
            Source::Zip(path) => {
                let file = File::open(path).ctx_path("open", path)?;
                let mut archive = zip::ZipArchive::new(file)?;
                for i in 0..archive.len() {
                    let mut entry = archive.by_index(i)?;
                    let entry_path = entry.name().replace('\\', "/");
                    let Some((raw, target)) = wanted.iter().find(|(raw, _)| raw == &entry_path)
                    else {
                        continue;
                    };
                    report(done, raw);
                    let (hash, size) =
                        fsutil::write_stream_atomic(&mut entry as &mut dyn Read, target)?;
                    done += size;
                    hashes.insert(raw.clone(), (hash, size));
                }
            }
            Source::Single(path) => {
                if let Some((raw, target)) = wanted.first() {
                    report(done, raw);
                    let (hash, size) = fsutil::copy_atomic(path, target)?;
                    done += size;
                    hashes.insert(raw.clone(), (hash, size));
                }
            }
        }
        report(done, "");

        let mut files = Vec::new();
        for (raw, _, dest) in &deploy {
            let (hash, size) = hashes
                .get(raw)
                .cloned()
                .ok_or_else(|| Error::invalid(format!("{raw} is missing from the source")))?;
            files.push(PackFile {
                path: dest.clone(),
                size,
                hash,
            });
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        let total_size = files.iter().map(|f| f.size).sum();
        let pack = Pack {
            id: id.clone(),
            name: name.to_string(),
            category: proposal.category,
            root,
            files,
            docs: docs.iter().map(|(_, _, dest)| dest.clone()).collect(),
            total_size,
            source_name: proposal.source_name.clone(),
            imported_at: fsutil::now_rfc3339(),
            notes: String::new(),
            profile_file: None,
        };
        crate::store::write_json(&staging.join("pack.json"), &pack)?;
        Ok(pack)
    })();

    match result {
        Ok(pack) => {
            let final_dir = packs_dir.join(&id);
            fs::rename(&staging, &final_dir).ctx_path("finish importing into", &final_dir)?;
            Ok(pack)
        }
        Err(err) => {
            let _ = fs::remove_dir_all(&staging);
            Err(err)
        }
    }
}

pub fn file_path(packs_dir: &Path, pack_id: &str, rel: &str) -> PathBuf {
    fsutil::rel_to_path(&packs_dir.join(pack_id).join("files"), rel)
}

pub fn load_all(packs_dir: &Path) -> Vec<Pack> {
    let mut packs: Vec<Pack> = fs::read_dir(packs_dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(
            |e| match crate::store::read_json::<Pack>(&e.path().join("pack.json")) {
                Ok(pack) => Some(pack),
                Err(err) => {
                    log::warn!("Skipping pack folder {}: {err}", e.path().display());
                    None
                }
            },
        )
        .collect();
    packs.sort_by_key(|p| p.name.to_lowercase());
    packs
}

pub fn save(packs_dir: &Path, pack: &Pack) -> Result<()> {
    crate::store::write_json(&packs_dir.join(&pack.id).join("pack.json"), pack)
}

pub fn delete(packs_dir: &Path, id: &str) -> Result<()> {
    let dir = packs_dir.join(id);
    if fsutil::sanitize_rel(id).as_deref() != Some(id) || !dir.join("pack.json").is_file() {
        return Err(Error::NotFound("That pack".into()));
    }
    fs::remove_dir_all(&dir).ctx_path("delete", &dir)
}

/// Remove half-finished imports left behind by a crash.
pub fn cleanup_staging(packs_dir: &Path) {
    for entry in fs::read_dir(packs_dir).into_iter().flatten().flatten() {
        if entry.file_name().to_string_lossy().starts_with(".import-") {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(root: &Path, rel: &str, body: &[u8]) {
        let path = fsutil::rel_to_path(root, rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    fn deploy_dests(p: &ImportProposal) -> Vec<String> {
        p.files
            .iter()
            .filter(|f| f.kind == ProposedFileKind::Deploy)
            .map(|f| f.dest.clone())
            .collect()
    }

    #[test]
    fn loose_sound_pack_goes_to_gta_audio() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("Cool Gun Sounds v2");
        write(&src, "Cool Gun Sounds/WEAPONS_PLAYER.rpf", b"weapons");
        write(&src, "Cool Gun Sounds/RESIDENT.rpf", b"resident");
        write(&src, "Cool Gun Sounds/README.txt", b"read me");
        write(&src, "Cool Gun Sounds/__MACOSX/._x", b"junk");
        let p = inspect(&src, None).unwrap();
        assert_eq!(p.layout, PackLayout::GtaAudio);
        assert_eq!(p.root, InstallRoot::GtaInstall);
        assert_eq!(p.category, PackCategory::SoundPack);
        assert_eq!(p.name, "Cool Gun Sounds v2");
        assert_eq!(
            deploy_dests(&p),
            vec![
                "x64/audio/sfx/RESIDENT.rpf",
                "x64/audio/sfx/WEAPONS_PLAYER.rpf"
            ]
        );
        assert!(p
            .files
            .iter()
            .any(|f| f.kind == ProposedFileKind::Doc && f.dest == "README.txt"));
        assert!(p.warnings.iter().any(|w| w.contains("GTA Online")));
    }

    #[test]
    fn citizen_tree_and_blocked_files() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("pvp");
        write(
            &src,
            "citizen/common/data/timecycle/timecycle_mods_1.xml",
            b"tc",
        );
        write(&src, "plugins/dxgi.dll", b"reshade");
        write(&src, "citizen/evil.exe", b"nope");
        write(&src, "citizen/dinput8.dll", b"nope");
        write(&src, "extras/thing.dat", b"?");
        let p = inspect(&src, None).unwrap();
        assert_eq!(p.layout, PackLayout::FivemTree);
        assert_eq!(p.category, PackCategory::Citizen);
        assert_eq!(
            deploy_dests(&p),
            vec![
                "citizen/common/data/timecycle/timecycle_mods_1.xml",
                "plugins/dxgi.dll"
            ]
        );
        let blocked: Vec<_> = p
            .files
            .iter()
            .filter(|f| f.kind == ProposedFileKind::Blocked)
            .map(|f| f.source.as_str())
            .collect();
        assert_eq!(blocked, vec!["citizen/dinput8.dll", "citizen/evil.exe"]);
        let ignored = p
            .files
            .iter()
            .find(|f| f.source == "extras/thing.dat")
            .unwrap();
        assert_eq!(ignored.kind, ProposedFileKind::Ignored);
    }

    #[test]
    fn citizen_contents_without_the_citizen_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("pack");
        write(&src, "common/data/visualsettings.dat", b"v");
        let p = inspect(&src, None).unwrap();
        assert_eq!(
            deploy_dests(&p),
            vec!["citizen/common/data/visualsettings.dat"]
        );
    }

    #[test]
    fn reshade_and_mods_layouts_and_override() {
        let tmp = tempfile::tempdir().unwrap();
        let reshade = tmp.path().join("preset");
        write(&reshade, "dxgi.dll", b"r");
        write(&reshade, "ReShade.ini", b"ini");
        write(&reshade, "reshade-shaders/Shaders/a.fx", b"fx");
        let p = inspect(&reshade, None).unwrap();
        assert_eq!(p.layout, PackLayout::PluginsFolder);
        assert_eq!(
            deploy_dests(&p),
            vec![
                "plugins/ReShade.ini",
                "plugins/dxgi.dll",
                "plugins/reshade-shaders/Shaders/a.fx"
            ]
        );

        let mods = tmp.path().join("cars");
        write(&mods, "graphics.rpf", b"g");
        write(&mods, "notes.ini", b"n");
        let p = inspect(&mods, None).unwrap();
        assert_eq!(p.layout, PackLayout::ModsFolder);
        assert_eq!(deploy_dests(&p), vec!["mods/graphics.rpf"]);

        let p = inspect(&mods, Some(PackLayout::FivemTree)).unwrap();
        assert!(deploy_dests(&p).is_empty());
        assert!(!p.warnings.is_empty());
    }

    #[test]
    fn single_rpf_and_unsupported_archives() {
        let tmp = tempfile::tempdir().unwrap();
        let rpf = tmp.path().join("WEAPONS_PLAYER.rpf");
        fs::write(&rpf, b"x").unwrap();
        let p = inspect(&rpf, None).unwrap();
        assert_eq!(deploy_dests(&p), vec!["x64/audio/sfx/WEAPONS_PLAYER.rpf"]);
        let rar = tmp.path().join("pack.rar");
        fs::write(&rar, b"x").unwrap();
        assert!(inspect(&rar, None)
            .unwrap_err()
            .to_string()
            .contains("Extract"));
    }

    #[test]
    fn zip_import_round_trip_and_tampering_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("sounds.zip");
        {
            let file = File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file("Pack/WEAPONS_PLAYER.rpf", opts).unwrap();
            zip.write_all(b"new weapons").unwrap();
            zip.start_file("Pack/readme.txt", opts).unwrap();
            zip.write_all(b"hi").unwrap();
            zip.finish().unwrap();
        }
        let packs_dir = tmp.path().join("packs");
        fs::create_dir_all(&packs_dir).unwrap();
        let proposal = inspect(&zip_path, None).unwrap();
        let mut events = 0;
        let pack = import(&packs_dir, &proposal, &mut |_| events += 1).unwrap();
        assert!(events > 0);
        assert_eq!(pack.files.len(), 1);
        assert_eq!(pack.files[0].path, "x64/audio/sfx/WEAPONS_PLAYER.rpf");
        assert_eq!(pack.files[0].hash, fsutil::hash_bytes(b"new weapons"));
        assert_eq!(
            fs::read(file_path(&packs_dir, &pack.id, &pack.files[0].path)).unwrap(),
            b"new weapons"
        );
        assert_eq!(pack.docs, vec!["readme.txt"]);
        assert_eq!(load_all(&packs_dir), vec![pack.clone()]);

        let mut evil = proposal.clone();
        evil.files[0].dest = "../../Windows/evil.rpf".into();
        assert!(import(&packs_dir, &evil, &mut |_| {}).is_err());
        let mut evil = proposal.clone();
        evil.files[0].dest = "x64/audio/sfx/hook.asi".into();
        assert!(import(&packs_dir, &evil, &mut |_| {}).is_err());
        // Failed imports leave nothing behind.
        assert_eq!(fs::read_dir(&packs_dir).unwrap().count(), 1);

        delete(&packs_dir, &pack.id).unwrap();
        assert!(load_all(&packs_dir).is_empty());
    }
}
