//! Server addresses and FiveM launch helpers. The actual process spawning /
//! URL opening is done by the desktop shell.

use std::collections::BTreeMap;
use std::path::Path;

use crate::error::IoContext;
use crate::fsutil;
use crate::model::GameRequirements;

/// Accepts what players paste: `1.2.3.4:30120`, `play.example.com`,
/// `cfx.re/join/abc123`, `https://cfx.re/join/abc123`, `fivem://connect/…` or a
/// bare join code (`abc123`). Returns the address FiveM's connect link expects.
pub fn normalize_server_address(input: &str) -> Result<String, String> {
    let mut address = input.trim().to_string();
    for prefix in ["fivem://connect/", "https://", "http://"] {
        if address.to_ascii_lowercase().starts_with(prefix) {
            address = address[prefix.len()..].to_string();
        }
    }
    let address = address.trim_end_matches('/').to_string();
    if address.is_empty() {
        return Err("Enter a server address or cfx.re join code.".into());
    }
    let lower = address.to_ascii_lowercase();
    if let Some(code) = lower.strip_prefix("cfx.re/join/") {
        return if is_join_code(code) {
            Ok(format!("cfx.re/join/{}", &address["cfx.re/join/".len()..]))
        } else {
            Err("That cfx.re join link doesn't look right.".into())
        };
    }
    if is_join_code(&address) && !address.contains('.') && !address.contains(':') {
        return Ok(format!("cfx.re/join/{address}"));
    }
    let (host, port) = match address.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') => (host, Some(port)),
        _ => (address.as_str(), None),
    };
    let host_ok = !host.is_empty()
        && host.len() <= 253
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    let port_ok = port.is_none_or(|p| p.parse::<u16>().is_ok_and(|n| n > 0));
    if host_ok && port_ok && (host.contains('.') || host.eq_ignore_ascii_case("localhost")) {
        Ok(address)
    } else {
        Err("Use an IP:port (like 1.2.3.4:30120), a hostname, or a cfx.re/join code.".into())
    }
}

/// cfx.re join codes are short alphanumeric strings (normally 6 characters).
fn is_join_code(code: &str) -> bool {
    (5..=8).contains(&code.len()) && code.chars().all(|c| c.is_ascii_alphanumeric())
}

/// The link FiveM registers for joining a server.
pub fn connect_url(address: &str) -> String {
    format!("fivem://connect/{address}")
}

// ---- Starting FiveM the way the server wants -------------------------------
//
// When FiveM joins a server it reads the server's `/info.json` and compares a
// few values with how it was started. If any differ, it shows "FiveM needs to
// restart" and starts itself again as `FiveM.exe -b<build> -pure_<level>
// fivem://connect/<server>`, after writing the pool sizes and executable build
// to `CitizenFX.ini` (see `NetLibrary.cpp` and `ConnectToNative.cpp` in
// citizenfx/fivem). Loadout reads the same values before launching and starts
// FiveM that way from the beginning, so no restart is needed.

/// FiveM's own default game build (`GetDefaultGTA5Build`), the lowest build a
/// server can make the default. It only ever goes up with FiveM updates.
pub const FIVEM_DEFAULT_BUILD: u32 = 3258;

/// Read a server's requirements from its `/info.json` `vars` (or the server
/// list's copy of them).
pub fn requirements_from_vars(vars: &serde_json::Value) -> GameRequirements {
    let text = |key: &str| -> Option<String> {
        match &vars[key] {
            serde_json::Value::String(s) => Some(s.trim().to_string()),
            serde_json::Value::Number(n) => Some(n.to_string()),
            serde_json::Value::Bool(b) => Some(b.to_string()),
            _ => None,
        }
        .filter(|s| !s.is_empty())
    };
    let number = |key: &str| text(key).and_then(|s| s.parse::<u32>().ok());

    let enforced = text("sv_enforceGameBuild");
    // FiveM treats the old 3717 build number as the Winter 2025 update.
    let game_build =
        number("sv_enforceGameBuild")
            .filter(|&b| b != 0)
            .map(|b| if b == 3717 { 3751 } else { b });
    let pool_sizes = text("sv_poolSizesIncrease")
        .and_then(|raw| serde_json::from_str::<BTreeMap<String, serde_json::Value>>(&raw).ok())
        .map(|pools| {
            pools
                .into_iter()
                .filter_map(|(pool, n)| Some((pool, u32::try_from(n.as_u64()?).ok()?)))
                .filter(|(pool, _)| !pool.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let server_default = number("sv_defaultGameBuild").filter(|&b| b >= FIVEM_DEFAULT_BUILD);
    // Old servers without sv_defaultGameBuild run the enforced build's own exe,
    // unless they turned that off (or asked for build 1, which can't).
    let legacy_replace_exe = server_default.is_none()
        && text("sv_replaceExeToSwitchBuilds").as_deref() != Some("false")
        && enforced.as_deref() != Some("1");
    let exe_build = match game_build {
        Some(build) if legacy_replace_exe => Some(build),
        _ => server_default,
    };
    GameRequirements {
        game_build,
        pure_level: number("sv_pureLevel").unwrap_or(0).min(2),
        // Kept as the server wrote them; `limit_pool_sizes` applies cfx.re's limits.
        pool_sizes,
        exe_build,
    }
}

/// Trim a server's pool size increases the way FiveM does before comparing them
/// with its own (`PoolSizeManager::Sanitize`): pools cfx.re doesn't allow are
/// dropped and the rest capped at their limit. Otherwise FiveM sees different
/// pools than Loadout set and restarts.
pub fn limit_pool_sizes(pools: &mut BTreeMap<String, u32>, limits: &BTreeMap<String, u32>) {
    pools.retain(|pool, n| match limits.get(pool) {
        None => false,
        Some(&limit) if *n > limit => {
            *n = limit;
            limit > 0
        }
        Some(_) => true,
    });
}

/// How to start FiveM for a server: command-line options, `[Game]` keys to set
/// (`None` removes the key, so FiveM uses its default) and a summary for people.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSetup {
    pub args: Vec<String>,
    pub ini: Vec<(&'static str, Option<String>)>,
    pub summary: Vec<String>,
}

pub fn launch_setup(req: &GameRequirements) -> LaunchSetup {
    // The executable FiveM must run: the server's choice, or FiveM's own default.
    // FiveM's restart always writes this number; leaving it out lets FiveM pick
    // another executable (and restart anyway).
    let exe_build = req.exe_build.unwrap_or(FIVEM_DEFAULT_BUILD);
    // Without an enforced build, FiveM wants the server's default build.
    let build = req.game_build.unwrap_or(exe_build);
    let mut args = vec![format!("-b{build}")];
    let mut summary = Vec::new();
    let mut pools = String::new();
    if req.game_build.is_some() {
        summary.push(format!("game build {build}"));
        if !req.pool_sizes.is_empty() {
            summary.push(format!(
                "bigger pools ({})",
                req.pool_sizes
                    .keys()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
            pools = serde_json::to_string(&req.pool_sizes).unwrap_or_default();
        }
    }
    // FiveM only compares pure mode when the server enforces a build, and its
    // restart starts without pure mode otherwise.
    let pure_level = if req.game_build.is_some() {
        req.pure_level
    } else {
        0
    };
    let mut ini = vec![
        ("PoolSizesIncrease", Some(pools)),
        ("DefaultBuild", Some(exe_build.to_string())),
        // FiveM's restart saves this too; a plain start of FiveM uses it.
        ("PureLevel", Some(pure_level.to_string())),
    ];
    // FiveM saves its default build as the last one used when it switches to it.
    if build == FIVEM_DEFAULT_BUILD {
        ini.push(("SavedBuildNumber", Some(build.to_string())));
    }
    if pure_level > 0 {
        args.push(format!("-pure_{pure_level}"));
        summary.push(format!("pure mode {pure_level}"));
    }
    LaunchSetup { args, ini, summary }
}

impl LaunchSetup {
    /// The connect link, carrying the build and pure mode as well as the
    /// command line does: FiveM picks the build from a `?-b<build>` part of the
    /// link, and the pure level from `pure_` in any argument. So they arrive even
    /// when FiveM ends up started by the link alone.
    pub fn connect_link(&self, address: &str) -> String {
        let mut link = connect_url(address);
        for arg in &self.args {
            link.push('?');
            link.push_str(arg);
        }
        link
    }
}

/// Set or remove keys in the `[Game]` section of FiveM's `CitizenFX.ini`,
/// leaving every other line (and its encoding) exactly as it was.
pub fn update_citizenfx_ini(path: &Path, changes: &[(&str, Option<String>)]) -> crate::Result<()> {
    let bytes = std::fs::read(path).ctx_path("read", path)?;
    // Windows' ini functions also read UTF-16 files (with a byte order mark);
    // edit those as text and write them back the same way.
    let out = match bytes.strip_prefix(&[0xFF, 0xFE]) {
        Some(utf16) => {
            let units: Vec<u16> = utf16
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            let text = String::from_utf16_lossy(&units);
            let edited = edit_game_section(text.as_bytes(), changes);
            let edited = String::from_utf8_lossy(&edited);
            let mut out = vec![0xFF, 0xFE];
            out.extend(edited.encode_utf16().flat_map(u16::to_le_bytes));
            out
        }
        None => edit_game_section(&bytes, changes),
    };
    if out != bytes {
        fsutil::write_atomic(path, &out)?;
    }
    Ok(())
}

fn edit_game_section(bytes: &[u8], changes: &[(&str, Option<String>)]) -> Vec<u8> {
    let crlf = bytes.windows(2).any(|w| w == b"\r\n");
    let newline: &[u8] = if crlf { b"\r\n" } else { b"\n" };
    let mut lines: Vec<Vec<u8>> = bytes
        .split(|&b| b == b'\n')
        .map(|line| line.strip_suffix(b"\r").unwrap_or(line).to_vec())
        .collect();
    if lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }

    let is_section = |line: &[u8]| line.trim_ascii().starts_with(b"[");
    let game_start = lines
        .iter()
        .position(|l| l.trim_ascii().eq_ignore_ascii_case(b"[game]"));
    let game_start = match game_start {
        Some(i) => i,
        None => {
            lines.push(b"[Game]".to_vec());
            lines.len() - 1
        }
    };
    for (key, value) in changes {
        let section_end = lines[game_start + 1..]
            .iter()
            .position(|l| is_section(l))
            .map_or(lines.len(), |i| game_start + 1 + i);
        let existing = (game_start + 1..section_end).find(|&i| {
            lines[i]
                .split(|&b| b == b'=')
                .next()
                .is_some_and(|k| k.trim_ascii().eq_ignore_ascii_case(key.as_bytes()))
                && lines[i].contains(&b'=')
        });
        match (existing, value) {
            (Some(i), Some(value)) => lines[i] = format!("{key}={value}").into_bytes(),
            (Some(i), None) => {
                lines.remove(i);
            }
            (None, Some(value)) => {
                // After the section's last non-blank line.
                let mut at = section_end;
                while at > game_start + 1 && lines[at - 1].trim_ascii().is_empty() {
                    at -= 1;
                }
                lines.insert(at, format!("{key}={value}").into_bytes());
            }
            (None, None) => {}
        }
    }
    let mut out = lines.join(newline);
    out.extend_from_slice(newline);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_common_inputs() {
        let ok = |s: &str| normalize_server_address(s).unwrap();
        assert_eq!(ok("  1.2.3.4:30120 "), "1.2.3.4:30120");
        assert_eq!(ok("play.example.com"), "play.example.com");
        assert_eq!(ok("cfx.re/join/abc123"), "cfx.re/join/abc123");
        assert_eq!(ok("https://cfx.re/join/AbC123/"), "cfx.re/join/AbC123");
        assert_eq!(
            ok("fivem://connect/cfx.re/join/xyz789"),
            "cfx.re/join/xyz789"
        );
        assert_eq!(ok("abc123"), "cfx.re/join/abc123");
        assert_eq!(ok("localhost:30120"), "localhost:30120");
        assert_eq!(ok("localhost"), "localhost");
        assert_eq!(
            connect_url("1.2.3.4:30120"),
            "fivem://connect/1.2.3.4:30120"
        );
    }

    #[test]
    fn rejects_garbage() {
        for bad in [
            "",
            "   ",
            "cfx.re/join/",
            "1.2.3.4:99999",
            "bad host!",
            "x;calc.exe",
            "toolongnodots",
            "1.2.3.4:0",
        ] {
            assert!(normalize_server_address(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn reads_what_a_server_needs() {
        use serde_json::json;
        // The server from the screenshot: build 3095, pure mode 1, more weapon components.
        let req = requirements_from_vars(&json!({
            "sv_enforceGameBuild": "3095",
            "sv_pureLevel": "1",
            "sv_poolSizesIncrease": "{\"CWeaponComponentInfo\":500}",
            "sv_replaceExeToSwitchBuilds": "false",
        }));
        assert_eq!(req.game_build, Some(3095));
        assert_eq!(req.pure_level, 1);
        assert_eq!(req.pool_sizes.get("CWeaponComponentInfo"), Some(&500));
        // replaceExe off and no sv_defaultGameBuild: FiveM's own default exe.
        assert_eq!(req.exe_build, None);

        // Old servers run the enforced build's exe.
        let legacy = requirements_from_vars(&json!({ "sv_enforceGameBuild": "2944" }));
        assert_eq!(legacy.exe_build, Some(2944));
        // New servers say which exe, but never below FiveM's default.
        let modern = requirements_from_vars(
            &json!({ "sv_enforceGameBuild": "3095", "sv_defaultGameBuild": "3570" }),
        );
        assert_eq!(modern.exe_build, Some(3570));
        // A default below FiveM's own counts as unset (so an old server's rules apply).
        let too_low = requirements_from_vars(
            &json!({ "sv_enforceGameBuild": "3095", "sv_defaultGameBuild": "2060" }),
        );
        assert_eq!(too_low.exe_build, Some(3095));
        let too_low = requirements_from_vars(&json!({
            "sv_enforceGameBuild": "3095",
            "sv_defaultGameBuild": "2060",
            "sv_replaceExeToSwitchBuilds": "false",
        }));
        assert_eq!(too_low.exe_build, None);
        // 3717 is the old name of the Winter 2025 build.
        assert_eq!(
            requirements_from_vars(&json!({ "sv_enforceGameBuild": "3717" })).game_build,
            Some(3751)
        );
        // Nothing set (or junk): FiveM's defaults.
        let plain =
            requirements_from_vars(&json!({ "sv_pureLevel": "x", "sv_poolSizesIncrease": "nope" }));
        assert_eq!(plain, GameRequirements::default());
    }

    #[test]
    fn launches_with_the_servers_settings() {
        let mut req = GameRequirements {
            game_build: Some(3095),
            pure_level: 1,
            pool_sizes: BTreeMap::from([("CWeaponComponentInfo".to_string(), 500)]),
            exe_build: None,
        };
        let setup = launch_setup(&req);
        assert_eq!(setup.args, ["-b3095", "-pure_1"]);
        assert_eq!(
            setup.ini,
            [
                (
                    "PoolSizesIncrease",
                    Some("{\"CWeaponComponentInfo\":500}".to_string())
                ),
                ("DefaultBuild", Some("3258".to_string())),
                ("PureLevel", Some("1".to_string())),
            ]
        );
        assert_eq!(
            setup.summary,
            [
                "game build 3095",
                "bigger pools (CWeaponComponentInfo)",
                "pure mode 1"
            ]
        );
        assert_eq!(
            setup.connect_link("cfx.re/join/abc123"),
            "fivem://connect/cfx.re/join/abc123?-b3095?-pure_1"
        );

        req.exe_build = Some(3570);
        req.pool_sizes.clear();
        req.pure_level = 0;
        let setup = launch_setup(&req);
        assert_eq!(setup.args, ["-b3095"]);
        assert_eq!(
            setup.ini,
            [
                ("PoolSizesIncrease", Some(String::new())),
                ("DefaultBuild", Some("3570".to_string())),
                ("PureLevel", Some("0".to_string())),
            ]
        );

        // No enforced build: FiveM's default build (saved as the last used, like
        // FiveM does), or the one the server picked.
        let setup = launch_setup(&GameRequirements::default());
        assert_eq!(setup.args, ["-b3258"]);
        assert!(setup.summary.is_empty());
        assert_eq!(
            setup.ini,
            [
                ("PoolSizesIncrease", Some(String::new())),
                ("DefaultBuild", Some("3258".to_string())),
                ("PureLevel", Some("0".to_string())),
                ("SavedBuildNumber", Some("3258".to_string())),
            ]
        );
        let setup = launch_setup(&GameRequirements {
            exe_build: Some(3570),
            // Without an enforced build FiveM ignores pure mode (and starts without it).
            pure_level: 2,
            ..Default::default()
        });
        assert_eq!(setup.args, ["-b3570"]);
        assert_eq!(
            setup.connect_link("1.2.3.4:30120"),
            "fivem://connect/1.2.3.4:30120?-b3570"
        );
    }

    #[test]
    fn limits_pool_sizes_like_fivem() {
        let limits = BTreeMap::from([
            ("CWeaponComponentInfo".to_string(), 1000),
            ("CPed".to_string(), 0),
            ("CVehicle".to_string(), 50),
        ]);
        let mut pools = BTreeMap::from([
            ("CWeaponComponentInfo".to_string(), 5000), // capped
            ("CPed".to_string(), 10),                   // not allowed at all
            ("CVehicle".to_string(), 0),                // kept as it is
            ("Unknown".to_string(), 1),                 // not on the list
        ]);
        limit_pool_sizes(&mut pools, &limits);
        assert_eq!(
            pools,
            BTreeMap::from([
                ("CVehicle".to_string(), 0),
                ("CWeaponComponentInfo".to_string(), 1000),
            ])
        );
        // A zero increase is a pool FiveM keeps, so Loadout does too.
        let req = requirements_from_vars(&serde_json::json!({
            "sv_enforceGameBuild": "3095",
            "sv_poolSizesIncrease": "{\"CVehicle\":0}",
        }));
        assert_eq!(req.pool_sizes.get("CVehicle"), Some(&0));
    }

    #[test]
    fn edits_utf16_ini_files() {
        let dir = tempfile::tempdir().unwrap();
        let ini = dir.path().join("CitizenFX.ini");
        let text = "[Game]\r\nIVPath=D:\\Jeux\\GTA é\r\nDefaultBuild=3095\r\n";
        let encode = |text: &str| {
            let mut bytes = vec![0xFF, 0xFE];
            bytes.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
            bytes
        };
        std::fs::write(&ini, encode(text)).unwrap();
        update_citizenfx_ini(&ini, &[("DefaultBuild", Some("3258".into()))]).unwrap();
        assert_eq!(
            std::fs::read(&ini).unwrap(),
            encode("[Game]\r\nIVPath=D:\\Jeux\\GTA é\r\nDefaultBuild=3258\r\n")
        );
    }

    #[test]
    fn edits_only_the_game_section() {
        let dir = tempfile::tempdir().unwrap();
        let ini = dir.path().join("CitizenFX.ini");
        // Non-UTF-8 bytes (an ANSI path) must survive untouched.
        let original: &[u8] = b"[Game]\r\nIVPath=D:\\Games\\GTA \xe9\r\nSavedBuildNumber=3095\r\nUpdateChannel=production\r\n\r\n[Other]\r\nDefaultBuild=1\r\n";
        std::fs::write(&ini, original).unwrap();
        update_citizenfx_ini(
            &ini,
            &[
                ("SavedBuildNumber", None),
                ("PoolSizesIncrease", Some("{\"CPed\":10}".into())),
                ("defaultbuild", Some("3258".into())),
            ],
        )
        .unwrap();
        let after = std::fs::read(&ini).unwrap();
        assert_eq!(
            after,
            b"[Game]\r\nIVPath=D:\\Games\\GTA \xe9\r\nUpdateChannel=production\r\nPoolSizesIncrease={\"CPed\":10}\r\ndefaultbuild=3258\r\n\r\n[Other]\r\nDefaultBuild=1\r\n"
        );
        // Setting the same values again changes nothing.
        update_citizenfx_ini(&ini, &[("PoolSizesIncrease", Some("{\"CPed\":10}".into()))]).unwrap();
        assert_eq!(std::fs::read(&ini).unwrap(), after);

        let bare = dir.path().join("bare.ini");
        std::fs::write(&bare, "[Paths]\nx=1\n").unwrap();
        update_citizenfx_ini(&bare, &[("DefaultBuild", Some("3570".into()))]).unwrap();
        assert_eq!(
            std::fs::read_to_string(&bare).unwrap(),
            "[Paths]\nx=1\n[Game]\nDefaultBuild=3570\n"
        );
    }
}
