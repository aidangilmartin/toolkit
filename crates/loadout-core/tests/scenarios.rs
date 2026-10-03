//! End-to-end scenarios against fake FiveM / GTA V folders laid out like a real
//! Windows install. The core promise being tested: whatever happens (switching
//! profiles, failures, crashes, FiveM updates), the player's folders can always be
//! brought back exactly to how they were.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use loadout_core::deploy::Hooks;
use loadout_core::fsutil;
use loadout_core::model::{
    FileOpKind, PackLayout, Profile, ProposedFileKind, Server, SettingsTarget,
};
use loadout_core::paths::{NoRegistry, SystemDirs};
use loadout_core::process::FakeProcesses;
use loadout_core::settings_xml::SettingsXml;
use loadout_core::{Error, Loadout};
use pretty_assertions::assert_eq;

/// The fixture with CRLF line endings, like the game writes it (whatever git did on checkout).
fn settings_crlf() -> String {
    include_str!("fixtures/settings.xml")
        .replace("\r\n", "\n")
        .replace('\n', "\r\n")
}

struct World {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    procs: Arc<FakeProcesses>,
    app: Loadout,
}

fn write(path: &Path, body: impl AsRef<[u8]>) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, body).unwrap();
}

impl World {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let gta = root.join("Games/Grand Theft Auto V");
        write(&gta.join("GTA5.exe"), "exe");
        write(
            &gta.join("x64/audio/sfx/WEAPONS_PLAYER.rpf"),
            "vanilla weapons",
        );
        write(&gta.join("x64/audio/sfx/RESIDENT.rpf"), "vanilla resident");
        let app_dir = root.join("Local/FiveM/FiveM.app");
        write(&root.join("Local/FiveM/FiveM.exe"), "exe");
        write(
            &app_dir.join("CitizenFX.ini"),
            format!("[Game]\r\nIVPath={}\r\n", gta.display()),
        );
        write(
            &app_dir.join("citizen/common/data/visualsettings.dat"),
            "vanilla visuals",
        );
        fs::create_dir_all(app_dir.join("mods")).unwrap();
        let cfx = root.join("Roaming/CitizenFX");
        write(&cfx.join("gta5_settings.xml"), settings_crlf());
        write(
            &cfx.join("fivem.cfg"),
            "seta profile_fpsFieldOfView \"5\"\nseta profile_sfxVolume \"8\"\nbind keyboard \"F1\" \"+menu\"\n",
        );
        write(
            &root.join("Documents/Rockstar Games/GTA V/settings.xml"),
            settings_crlf(),
        );
        let procs = Arc::new(FakeProcesses::none());
        let app = open(&root, procs.clone());
        Self {
            _tmp: tmp,
            root,
            procs,
            app,
        }
    }

    fn reopen(&mut self) {
        self.app = open(&self.root, self.procs.clone());
    }

    fn gta(&self, rel: &str) -> PathBuf {
        fsutil::rel_to_path(&self.root.join("Games/Grand Theft Auto V"), rel)
    }

    fn fivem(&self, rel: &str) -> PathBuf {
        fsutil::rel_to_path(&self.root.join("Local/FiveM/FiveM.app"), rel)
    }

    fn cfx(&self, rel: &str) -> PathBuf {
        self.root.join("Roaming/CitizenFX").join(rel)
    }

    fn docs_settings(&self) -> PathBuf {
        self.root
            .join("Documents/Rockstar Games/GTA V/settings.xml")
    }

    /// Every file and folder in the game-side folders, with content hashes.
    fn game_tree(&self) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        for dir in ["Games", "Local", "Roaming", "Documents"] {
            for entry in walkdir::WalkDir::new(self.root.join(dir)) {
                let entry = entry.unwrap();
                let rel = entry
                    .path()
                    .strip_prefix(&self.root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                let value = if entry.file_type().is_dir() {
                    "<dir>".to_string()
                } else {
                    fsutil::hash_file(entry.path()).unwrap().0
                };
                out.insert(rel, value);
            }
        }
        out
    }

    fn pack_tree(&self) -> BTreeMap<String, String> {
        only_pack_folders(self.game_tree())
    }

    fn import(&self, name: &str, files: &[(&str, &str)]) -> String {
        let src = self.root.join("downloads").join(name);
        for (rel, body) in files {
            write(&fsutil::rel_to_path(&src, rel), body);
        }
        let proposal = self.app.inspect_pack(&src, None).unwrap();
        self.app.import_pack(&proposal, &mut |_| {}).unwrap().id
    }

    fn profile(
        &self,
        name: &str,
        preset: &str,
        packs: Vec<String>,
        extra: impl FnOnce(&mut Profile),
    ) -> String {
        let schema = self.app.schema();
        let mut profile = Profile {
            name: name.into(),
            graphics: schema
                .presets
                .iter()
                .find(|p| p.id == preset)
                .unwrap()
                .values
                .clone(),
            packs,
            ..Default::default()
        };
        extra(&mut profile);
        self.app.save_profile(profile).unwrap().id
    }

    fn setting(&self, path: &Path, key: &str) -> Option<String> {
        let doc = SettingsXml::parse(&fs::read(path).unwrap()).unwrap();
        doc.get(key).map(str::to_string)
    }

    fn data_dir_is_clean(&self) {
        let data = self.app.data_dir();
        assert_eq!(
            fs::read_dir(data.join("backups/tx")).unwrap().count(),
            0,
            "tx dir"
        );
    }

    fn originals_count(&self) -> usize {
        fs::read_dir(self.app.data_dir().join("backups/originals"))
            .unwrap()
            .count()
    }
}

/// The folders packs install into (GTA V and FiveM.app), not the settings folders.
fn only_pack_folders(tree: BTreeMap<String, String>) -> BTreeMap<String, String> {
    tree.into_iter()
        .filter(|(k, _)| k.starts_with("Games/") || k.starts_with("Local/"))
        .collect()
}

fn open(root: &Path, procs: Arc<FakeProcesses>) -> Loadout {
    let sys = SystemDirs {
        local_app_data: Some(root.join("Local")),
        roaming_app_data: Some(root.join("Roaming")),
        documents: Some(root.join("Documents")),
    };
    Loadout::open(
        root.join("data"),
        sys,
        Box::new(NoRegistry),
        Box::new(procs),
    )
    .unwrap()
}

/// Arena (sound pack + citizen pack, max FPS) and RP (ReShade, Ultra on both games).
fn arena_and_rp(w: &World) -> (String, String) {
    let sounds = w.import(
        "PvP Gun Sounds",
        &[
            ("WEAPONS_PLAYER.rpf", "pvp weapons"),
            ("RESIDENT.rpf", "pvp resident"),
        ],
    );
    let citizen = w.import(
        "Clean PvP citizen",
        &[
            ("citizen/common/data/visualsettings.dat", "pvp visuals"),
            ("citizen/common/data/timecycle/clear.xml", "clear tc"),
        ],
    );
    let reshade = w.import(
        "Cinematic ReShade",
        &[
            ("dxgi.dll", "reshade"),
            ("ReShade.ini", "ini"),
            ("reshade-shaders/Shaders/a.fx", "fx"),
        ],
    );
    let arena = w.profile("Arena", "max-fps", vec![sounds, citizen], |p| {
        p.fivem_cfg
            .insert("profile_fpsFieldOfView".into(), "10".into());
        p.graphics.insert("video/Windowed".into(), "0".into());
    });
    let rp = w.profile("RP", "ultra", vec![reshade], |p| {
        p.apply_to_gta = true;
        p.fivem_cfg
            .insert("profile_fpsFieldOfView".into(), "3".into());
    });
    (arena, rp)
}

#[test]
fn arena_rp_vanilla_round_trip() {
    let w = World::new();
    let initial = w.game_tree();
    w.app.complete_setup().unwrap();
    let (arena, rp) = arena_and_rp(&w);

    let plan = w.app.plan(Some(&arena)).unwrap();
    assert!(plan.errors.is_empty(), "{:?}", plan.errors);
    let installs = plan
        .files
        .iter()
        .filter(|f| f.kind == FileOpKind::Install)
        .count();
    assert_eq!(installs, 4);
    assert_eq!(plan.files.iter().filter(|f| f.backs_up_original).count(), 3);
    assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);

    // Arena
    let result = w.app.apply(Some(&arena), &mut |_| {}).unwrap();
    assert!(result.snapshot_id.is_some());
    assert_eq!(
        fs::read(w.gta("x64/audio/sfx/WEAPONS_PLAYER.rpf")).unwrap(),
        b"pvp weapons"
    );
    assert_eq!(
        fs::read(w.fivem("citizen/common/data/visualsettings.dat")).unwrap(),
        b"pvp visuals"
    );
    let fivem_xml = w.cfx("gta5_settings.xml");
    assert_eq!(
        w.setting(&fivem_xml, "graphics/GrassQuality").as_deref(),
        Some("0")
    );
    assert_eq!(
        w.setting(&fivem_xml, "graphics/LodScale").as_deref(),
        Some("0.000000")
    );
    assert_eq!(
        w.setting(&fivem_xml, "configSource").as_deref(),
        Some("SMC_USER")
    );
    assert_eq!(
        w.setting(&fivem_xml, "VideoCardDescription").as_deref(),
        Some("NVIDIA GeForce RTX 3070 & Co")
    );
    let cfg = fs::read_to_string(w.cfx("fivem.cfg")).unwrap();
    assert!(cfg.contains("seta profile_fpsFieldOfView \"10\""));
    assert!(cfg.contains("bind keyboard \"F1\" \"+menu\""));
    // GTA V's own settings weren't asked for.
    assert_eq!(
        fs::read_to_string(w.docs_settings()).unwrap(),
        settings_crlf()
    );
    let status = w.app.status().unwrap();
    assert_eq!(status.active_profile_id.as_deref(), Some(arena.as_str()));
    assert!(
        status.settings_drift.is_empty(),
        "{:?}",
        status.settings_drift
    );
    assert!(status.file_drift.is_empty());
    assert_eq!(status.deployed_files.len(), 4);

    // Applying the same profile again changes nothing.
    let again = w.app.plan(Some(&arena)).unwrap();
    assert!(!again.has_changes(), "{again:?}");

    // Arena -> RP
    w.app.apply(Some(&rp), &mut |_| {}).unwrap();
    assert_eq!(
        fs::read(w.gta("x64/audio/sfx/WEAPONS_PLAYER.rpf")).unwrap(),
        b"vanilla weapons"
    );
    assert_eq!(
        fs::read(w.fivem("citizen/common/data/visualsettings.dat")).unwrap(),
        b"vanilla visuals"
    );
    assert!(
        !w.fivem("citizen/common/data/timecycle").exists(),
        "created folder removed"
    );
    assert_eq!(fs::read(w.fivem("plugins/dxgi.dll")).unwrap(), b"reshade");
    assert_eq!(
        w.setting(&fivem_xml, "graphics/GrassQuality").as_deref(),
        Some("3")
    );
    assert_eq!(
        w.setting(&w.docs_settings(), "graphics/GrassQuality")
            .as_deref(),
        Some("3")
    );
    assert_eq!(w.originals_count(), 0);

    // RP -> vanilla: pack files exactly as they started.
    w.app.apply(None, &mut |_| {}).unwrap();
    assert_eq!(w.pack_tree(), only_pack_folders(initial.clone()));
    assert!(w.app.status().unwrap().deployed_files.is_empty());

    // …and the first-run backup brings the settings files back too.
    let pinned = w.app.snapshots().into_iter().find(|s| s.pinned).unwrap();
    assert_eq!(pinned.files.len(), 3);
    w.app.restore_snapshot(&pinned.id).unwrap();
    assert_eq!(w.game_tree(), initial);
    assert_eq!(w.originals_count(), 0);
    w.data_dir_is_clean();
}

#[test]
fn any_failure_rolls_everything_back() {
    let w = World::new();
    let (arena, rp) = arena_and_rp(&w);
    let initial = w.game_tree();
    let steps = {
        let plan = w.app.plan(Some(&arena)).unwrap();
        plan.files.len()
            + plan
                .settings
                .iter()
                .filter(|s| !s.changes.is_empty())
                .count()
    };
    assert!(steps >= 6);
    for k in 0..steps {
        let hooks = Hooks {
            fail_before_step: Some(k),
            ..Default::default()
        };
        let err = w
            .app
            .apply_with_hooks(Some(&arena), &mut |_| {}, hooks)
            .unwrap_err();
        assert!(err.to_string().contains("simulated failure"), "{err}");
        assert_eq!(w.game_tree(), initial, "after failing at step {k}");
        assert_eq!(w.originals_count(), 0, "after failing at step {k}");
        w.data_dir_is_clean();
        assert!(w.app.status().unwrap().active_profile_id.is_none());
    }

    // Same while switching from one profile to another.
    w.app.apply(Some(&arena), &mut |_| {}).unwrap();
    let on_arena = w.game_tree();
    let originals = w.originals_count();
    for k in 0..8 {
        let hooks = Hooks {
            fail_before_step: Some(k),
            ..Default::default()
        };
        assert!(w
            .app
            .apply_with_hooks(Some(&rp), &mut |_| {}, hooks)
            .is_err());
        assert_eq!(w.game_tree(), on_arena, "after failing at step {k}");
        assert_eq!(w.originals_count(), originals);
    }
    w.app.apply(Some(&rp), &mut |_| {}).unwrap();
    w.app.apply(None, &mut |_| {}).unwrap();
}

#[test]
fn crashes_are_recovered_on_next_start() {
    let mut w = World::new();
    let (arena, _) = arena_and_rp(&w);
    let initial = w.game_tree();
    for k in [0, 2, 5] {
        let hooks = Hooks {
            crash_before_step: Some(k),
            ..Default::default()
        };
        assert!(w
            .app
            .apply_with_hooks(Some(&arena), &mut |_| {}, hooks)
            .is_err());
        w.reopen();
        let notice = w.app.status().unwrap().recovery_notice.unwrap();
        assert!(notice.contains("interrupted"), "{notice}");
        assert_eq!(w.game_tree(), initial, "after a crash before step {k}");
        assert_eq!(w.originals_count(), 0);
        w.data_dir_is_clean();
    }

    // A crash after the commit point finishes the apply instead.
    let hooks = Hooks {
        crash_after_commit: true,
        ..Default::default()
    };
    assert!(w
        .app
        .apply_with_hooks(Some(&arena), &mut |_| {}, hooks)
        .is_err());
    w.reopen();
    let status = w.app.status().unwrap();
    assert_eq!(status.active_profile_id.as_deref(), Some(arena.as_str()));
    assert_eq!(status.deployed_files.len(), 4);
    assert!(status.file_drift.is_empty());
    assert_eq!(
        fs::read(w.gta("x64/audio/sfx/WEAPONS_PLAYER.rpf")).unwrap(),
        b"pvp weapons"
    );
    w.data_dir_is_clean();
    w.app.apply(None, &mut |_| {}).unwrap();
    assert_eq!(w.pack_tree(), only_pack_folders(initial));
}

#[test]
fn fivem_updates_and_in_game_changes_are_detected() {
    let w = World::new();
    let (arena, rp) = arena_and_rp(&w);
    w.app.apply(Some(&arena), &mut |_| {}).unwrap();

    // A FiveM update rewrites a file our citizen pack replaced.
    let visuals = w.fivem("citizen/common/data/visualsettings.dat");
    fs::write(&visuals, "fivem v2 visuals").unwrap();
    let status = w.app.status().unwrap();
    assert_eq!(
        status.file_drift,
        vec!["FiveM.app/citizen/common/data/visualsettings.dat".to_string()]
    );

    // Switching away leaves the updated file alone instead of restoring a stale original.
    let plan = w.app.plan(Some(&rp)).unwrap();
    let forget = plan
        .files
        .iter()
        .find(|f| f.path.ends_with("visualsettings.dat"))
        .unwrap();
    assert_eq!(forget.kind, FileOpKind::Forget);
    w.app.apply(Some(&rp), &mut |_| {}).unwrap();
    assert_eq!(fs::read(&visuals).unwrap(), b"fivem v2 visuals");

    // Switching back backs up the *new* file as the original, and vanilla restores it.
    w.app.apply(Some(&arena), &mut |_| {}).unwrap();
    assert_eq!(fs::read(&visuals).unwrap(), b"pvp visuals");
    w.app.apply(None, &mut |_| {}).unwrap();
    assert_eq!(fs::read(&visuals).unwrap(), b"fivem v2 visuals");
    assert_eq!(w.originals_count(), 0);

    // In-game settings changes are spotted and can be saved into the profile.
    w.app.apply(Some(&arena), &mut |_| {}).unwrap();
    let xml = w.cfx("gta5_settings.xml");
    let text = fs::read_to_string(&xml).unwrap().replace(
        "<ShadowQuality value=\"1\" />",
        "<ShadowQuality value=\"2\" />",
    );
    fs::write(&xml, text).unwrap();
    let cfg = fs::read_to_string(w.cfx("fivem.cfg"))
        .unwrap()
        .replace("\"10\"", "\"12\"");
    fs::write(w.cfx("fivem.cfg"), cfg).unwrap();
    let drift = w.app.status().unwrap().settings_drift;
    let keys: Vec<(SettingsTarget, &str)> =
        drift.iter().map(|d| (d.target, d.key.as_str())).collect();
    assert_eq!(
        keys,
        vec![
            (SettingsTarget::FivemGraphics, "graphics/ShadowQuality"),
            (SettingsTarget::FivemCfg, "profile_fpsFieldOfView"),
        ]
    );
    let profile = w.app.save_drift_to_profile().unwrap();
    assert_eq!(profile.graphics["graphics/ShadowQuality"], "2");
    assert_eq!(profile.fivem_cfg["profile_fpsFieldOfView"], "12");
    assert!(w.app.status().unwrap().settings_drift.is_empty());
    assert!(!w.app.plan(Some(&arena)).unwrap().has_changes());
}

#[test]
fn running_game_blocks_changes() {
    let w = World::new();
    let (arena, _) = arena_and_rp(&w);
    let initial = w.game_tree();
    w.procs.set(&["FiveM_b3095_GTAProcess.exe"]);
    let plan = w.app.plan(Some(&arena)).unwrap();
    assert_eq!(plan.running_processes, vec!["FiveM_b3095_GTAProcess.exe"]);
    match w.app.apply(Some(&arena), &mut |_| {}) {
        Err(Error::GameRunning(names)) => assert_eq!(names, vec!["FiveM_b3095_GTAProcess.exe"]),
        other => panic!("expected GameRunning, got {other:?}"),
    }
    assert_eq!(w.game_tree(), initial);
    assert_eq!(w.app.close_game(), 1);
    w.app.apply(Some(&arena), &mut |_| {}).unwrap();
}

#[test]
fn conflicts_case_insensitivity_and_guards() {
    let w = World::new();
    // The game ships the file in lower case; the pack uses upper case.
    fs::rename(
        w.gta("x64/audio/sfx/RESIDENT.rpf"),
        w.gta("x64/audio/sfx/resident.rpf"),
    )
    .unwrap();
    let initial = w.game_tree();
    let a = w.import(
        "Pack A",
        &[
            ("RESIDENT.rpf", "a resident"),
            ("WEAPONS_PLAYER.rpf", "a weapons"),
        ],
    );
    let b = w.import("Pack B", &[("RESIDENT.rpf", "b resident")]);
    let both = w.profile("Both", "balanced", vec![a.clone(), b.clone()], |_| {});
    let plan = w.app.plan(Some(&both)).unwrap();
    assert_eq!(plan.conflicts.len(), 1);
    assert_eq!(plan.conflicts[0].winner, "Pack B");
    w.app.apply(Some(&both), &mut |_| {}).unwrap();
    assert_eq!(
        fs::read(w.gta("x64/audio/sfx/resident.rpf")).unwrap(),
        b"b resident"
    );
    assert!(!w.gta("x64/audio/sfx/RESIDENT.rpf").exists() || cfg!(windows));

    // Packs that are installed can't be deleted; unused ones can.
    assert!(w.app.delete_pack(&a).is_err());
    w.app.apply(None, &mut |_| {}).unwrap();
    assert_eq!(w.pack_tree(), only_pack_folders(initial));
    w.app.delete_pack(&a).unwrap();
    let profile = w
        .app
        .profiles()
        .unwrap()
        .into_iter()
        .find(|p| p.id == both)
        .unwrap();
    assert_eq!(profile.packs, vec![b]);
}

#[test]
fn missing_settings_files_and_read_only_flags() {
    let w = World::new();
    let sounds = w.import("Sounds", &[("WEAPONS_PLAYER.rpf", "pvp")]);
    let arena = w.profile("Arena", "max-fps", vec![sounds], |_| {});
    let xml = w.cfx("gta5_settings.xml");

    fsutil::set_readonly(&xml, true).unwrap();
    w.app.apply(Some(&arena), &mut |_| {}).unwrap();
    assert!(fsutil::is_readonly(&xml), "read-only flag kept");
    assert_eq!(
        w.setting(&xml, "graphics/GrassQuality").as_deref(),
        Some("0")
    );
    fsutil::set_readonly(&xml, false).unwrap();

    fs::remove_file(&xml).unwrap();
    let rp = w.profile("RP", "ultra", vec![], |_| {});
    let plan = w.app.plan(Some(&rp)).unwrap();
    assert!(plan
        .warnings
        .iter()
        .any(|w| w.contains("gta5_settings.xml")));
    w.app.apply(Some(&rp), &mut |_| {}).unwrap();
    assert_eq!(
        fs::read(w.gta("x64/audio/sfx/WEAPONS_PLAYER.rpf")).unwrap(),
        b"vanilla weapons"
    );
}

#[test]
fn profiles_servers_and_validation() {
    let w = World::new();
    let mut bad = Profile {
        name: "Bad".into(),
        ..Default::default()
    };
    bad.graphics
        .insert("graphics/ShadowQuality".into(), "9".into());
    assert!(w.app.save_profile(bad).is_err());
    let mut bad = Profile {
        name: "Bad".into(),
        ..Default::default()
    };
    bad.fivem_cfg.insert("profile_x".into(), "1; quit".into());
    assert!(w.app.save_profile(bad).is_err());
    assert!(w.app.save_profile(Profile::default()).is_err());

    let id = w.profile("Arena", "max-fps", vec![], |_| {});
    let copy = w.app.duplicate_profile(&id).unwrap();
    assert_eq!(copy.name, "Arena (copy)");

    let server = w
        .app
        .save_server(Server {
            name: "".into(),
            address: "https://cfx.re/join/abc123".into(),
            profile_id: Some(id.clone()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(server.address, "cfx.re/join/abc123");
    assert_eq!(server.name, "cfx.re/join/abc123");
    assert!(w
        .app
        .save_server(Server {
            address: "not a server".into(),
            ..Default::default()
        })
        .is_err());
    w.app.mark_played(&server.id).unwrap();
    w.app.delete_profile(&id).unwrap();
    let servers = w.app.servers().unwrap();
    assert_eq!(servers[0].profile_id, None);
    assert!(servers[0].last_played_at.is_some());
}

#[test]
fn capture_current_settings_for_a_new_profile() {
    let w = World::new();
    let captured = w.app.capture().unwrap();
    assert!(captured.fivem_graphics_found);
    assert!(captured
        .graphics_default
        .contains_key("graphics/ShadowQuality"));
    assert!(!captured.graphics_default.contains_key("video/ScreenWidth"));
    assert!(captured.graphics_all.contains_key("video/ScreenWidth"));
    assert!(!captured.graphics_all.contains_key("VideoCardDescription"));
    assert_eq!(captured.cfg_default.len(), 2);
    let profile = w
        .app
        .save_profile(Profile {
            name: "Current".into(),
            graphics: captured.graphics_default.clone(),
            fivem_cfg: captured.cfg_default.clone(),
            ..Default::default()
        })
        .unwrap();
    // A profile captured from the current files changes nothing when applied.
    assert!(!w.app.plan(Some(&profile.id)).unwrap().has_changes());
}

#[test]
fn import_wizard_layout_override() {
    let w = World::new();
    let src = w.root.join("downloads/odd");
    write(&src.join("stuff/WEAPONS_PLAYER.rpf"), "x");
    let proposal = w
        .app
        .inspect_pack(&src, Some(PackLayout::ModsFolder))
        .unwrap();
    let dests: Vec<_> = proposal
        .files
        .iter()
        .filter(|f| f.kind == ProposedFileKind::Deploy)
        .map(|f| f.dest.as_str())
        .collect();
    assert_eq!(dests, vec!["mods/WEAPONS_PLAYER.rpf"]);
}
