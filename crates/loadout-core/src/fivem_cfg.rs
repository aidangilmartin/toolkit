//! Reads and patches FiveM's `%APPDATA%\CitizenFX\fivem.cfg`.
//!
//! FiveM saves archived convars there as `seta <key> <value>` lines; that includes
//! GTA's pause-menu settings as `profile_*` keys (FOV, HUD, volumes…). We only
//! rewrite the `seta` lines we were asked to change and leave everything else
//! (binds, comments, unknown commands) untouched.

use std::collections::BTreeMap;

use crate::model::KeyChange;

#[derive(Debug, Clone)]
struct Line {
    raw: String,
    seta: Option<Seta>,
}

#[derive(Debug, Clone)]
struct Seta {
    command: String,
    key: String,
    key_quoted: bool,
    value: String,
}

#[derive(Debug, Clone)]
pub struct FivemCfg {
    lines: Vec<Line>,
    newline: &'static str,
    trailing_newline: bool,
}

impl FivemCfg {
    pub fn parse(text: &str) -> Self {
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
        let trailing_newline = text.is_empty() || text.ends_with('\n');
        let body = text.strip_suffix('\n').unwrap_or(text);
        let body = body.strip_suffix('\r').unwrap_or(body);
        let lines = if text.is_empty() {
            Vec::new()
        } else {
            body.split('\n')
                .map(|raw| {
                    let raw = raw.strip_suffix('\r').unwrap_or(raw).to_string();
                    let seta = parse_seta(&raw);
                    Line { raw, seta }
                })
                .collect()
        };
        Self {
            lines,
            newline,
            trailing_newline,
        }
    }

    /// Current value of every `seta` key (the last occurrence wins, like FiveM).
    pub fn values(&self) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        for seta in self.lines.iter().filter_map(|l| l.seta.as_ref()) {
            // Keys are case-insensitive for FiveM; keep the first spelling we saw.
            let existing = out
                .keys()
                .find(|k: &&String| k.eq_ignore_ascii_case(&seta.key))
                .cloned();
            out.insert(
                existing.unwrap_or_else(|| seta.key.clone()),
                seta.value.clone(),
            );
        }
        out
    }

    pub fn patch(&self, changes: &BTreeMap<String, String>) -> (String, Vec<KeyChange>) {
        let mut lines = self.lines.clone();
        let mut applied = Vec::new();
        for (key, value) in changes {
            let found = lines.iter_mut().rev().find(|l| {
                l.seta
                    .as_ref()
                    .is_some_and(|s| s.key.eq_ignore_ascii_case(key))
            });
            match found {
                Some(line) => {
                    let seta = line.seta.as_mut().expect("matched a seta line");
                    if &seta.value == value {
                        continue;
                    }
                    applied.push(KeyChange {
                        key: key.clone(),
                        from: Some(seta.value.clone()),
                        to: value.clone(),
                    });
                    seta.value = value.clone();
                    line.raw = render(seta);
                }
                None => {
                    let seta = Seta {
                        command: "seta".into(),
                        key: key.clone(),
                        key_quoted: false,
                        value: value.clone(),
                    };
                    applied.push(KeyChange {
                        key: key.clone(),
                        from: None,
                        to: value.clone(),
                    });
                    lines.push(Line {
                        raw: render(&seta),
                        seta: Some(seta),
                    });
                }
            }
        }
        let mut text = lines
            .iter()
            .map(|l| l.raw.as_str())
            .collect::<Vec<_>>()
            .join(self.newline);
        if (self.trailing_newline || !applied.is_empty()) && !text.is_empty() {
            text.push_str(self.newline);
        }
        (text, applied)
    }
}

fn render(seta: &Seta) -> String {
    let key = if seta.key_quoted {
        format!("\"{}\"", seta.key)
    } else {
        seta.key.clone()
    };
    format!("{} {key} \"{}\"", seta.command, seta.value)
}

fn parse_seta(raw: &str) -> Option<Seta> {
    let tokens = tokenize(raw.trim());
    let (command, _) = tokens.first()?;
    if !command.eq_ignore_ascii_case("seta") {
        return None;
    }
    let (key, key_quoted) = tokens.get(1)?.clone();
    let value = tokens.get(2).map(|(v, _)| v.clone()).unwrap_or_default();
    Some(Seta {
        command: command.clone(),
        key,
        key_quoted,
        value,
    })
}

/// Split on whitespace, honouring double quotes. Returns `(token, was_quoted)`.
fn tokenize(line: &str) -> Vec<(String, bool)> {
    let mut tokens = Vec::new();
    let mut chars = line.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
            continue;
        }
        if c == '/' && line.trim_start().starts_with("//") && tokens.is_empty() {
            break; // comment line
        }
        if c == '"' {
            chars.next();
            let mut token = String::new();
            for c in chars.by_ref() {
                if c == '"' {
                    break;
                }
                token.push(c);
            }
            tokens.push((token, true));
        } else {
            let mut token = String::new();
            while let Some(&c) = chars.peek() {
                if c.is_whitespace() {
                    break;
                }
                token.push(c);
                chars.next();
            }
            tokens.push((token, false));
        }
    }
    tokens
}

/// Convar names FiveM accepts: letters, digits and a few separators.
pub fn is_valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 96
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':'))
}

/// Values go inside double quotes; refuse anything that could break out of them
/// or start a second command.
pub fn validate_value(key: &str, value: &str) -> Result<(), String> {
    if value.len() > 512 || value.chars().any(|c| matches!(c, '"' | ';' | '\n' | '\r')) {
        return Err(format!(
            "{key}: the value can't contain quotes, ';' or line breaks"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    const SAMPLE: &str = "seta profile_sfxVolume \"8\"\nseta \"profile_fpsFieldOfView\" \"5\"\nbind keyboard \"F1\" \"+openmenu\"\n// comment\nseta ui_streamerMode \"false\"\nseta profile_sfxVolume \"9\"\n";

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn reads_last_value_per_key() {
        let cfg = FivemCfg::parse(SAMPLE);
        let values = cfg.values();
        assert_eq!(values["profile_sfxVolume"], "9");
        assert_eq!(values["profile_fpsFieldOfView"], "5");
        assert_eq!(values["ui_streamerMode"], "false");
        assert_eq!(values.len(), 3);
    }

    #[test]
    fn patch_preserves_other_lines_and_appends_new_keys() {
        let cfg = FivemCfg::parse(SAMPLE);
        let (text, changes) = cfg.patch(&map(&[
            ("profile_sfxVolume", "3"),
            ("profile_fpsFieldOfView", "5"),
            ("profile_displayRadar", "1"),
        ]));
        assert_eq!(changes.len(), 2);
        assert_eq!(
            text,
            "seta profile_sfxVolume \"8\"\nseta \"profile_fpsFieldOfView\" \"5\"\nbind keyboard \"F1\" \"+openmenu\"\n// comment\nseta ui_streamerMode \"false\"\nseta profile_sfxVolume \"3\"\nseta profile_displayRadar \"1\"\n"
        );
        assert_eq!(FivemCfg::parse(&text).values()["profile_sfxVolume"], "3");
    }

    #[test]
    fn unchanged_patch_is_identical_and_crlf_is_kept() {
        let crlf = SAMPLE.replace('\n', "\r\n");
        let cfg = FivemCfg::parse(&crlf);
        let (text, changes) = cfg.patch(&map(&[("ui_streamerMode", "false")]));
        assert!(changes.is_empty());
        assert_eq!(text, crlf);
        let (text, _) = cfg.patch(&map(&[("ui_streamerMode", "true")]));
        assert!(text.contains("seta ui_streamerMode \"true\"\r\n"));
    }

    #[test]
    fn empty_file_gets_new_lines() {
        let (text, changes) = FivemCfg::parse("").patch(&map(&[("profile_x", "1")]));
        assert_eq!(changes.len(), 1);
        assert_eq!(text, "seta profile_x \"1\"\n");
    }

    #[test]
    fn validation() {
        assert!(is_valid_key("profile_fpsFieldOfView"));
        assert!(!is_valid_key("bad key"));
        assert!(!is_valid_key("x\"y"));
        assert!(validate_value("k", "1; quit").is_err());
        assert!(validate_value("k", "a\"b").is_err());
        assert!(validate_value("k", "hello world").is_ok());
    }
}
