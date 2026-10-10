//! Looks up a FiveM server's name and logo so a profile can show them.
//!
//! - `cfx.re/join/<code>` addresses go through the server list API that the FiveM
//!   client uses itself.
//! - `ip:port` and hostnames are asked directly: every FiveM server answers
//!   `GET /info.json` (with its logo as base64 PNG) and `GET /dynamic.json`.

use std::fs;
use std::path::Path;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::Value;
use ureq::Agent;

use crate::error::{Error, IoContext, Result};
use crate::launch::normalize_server_address;
use crate::model::ServerInfo;

pub const CFX_API: &str = "https://frontend.cfx-services.net/api/servers";

/// The cfx.re API to use. `LOADOUT_CFX_API` points it somewhere else, for testing
/// the desktop app against a local stand-in.
pub fn cfx_api() -> String {
    std::env::var("LOADOUT_CFX_API")
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| CFX_API.to_string())
}
pub const DEFAULT_PORT: u16 = 30120;
/// Biggest logo Loadout keeps. FiveM's own limit is 96×96 PNG, so this is plenty.
pub const ICON_LIMIT: usize = 512 * 1024;
const JSON_LIMIT: u64 = 8 * 1024 * 1024;
const NAME_LIMIT: usize = 80;

/// Look the server up over the network. Takes a few seconds at most.
pub fn lookup(address: &str) -> Result<ServerInfo> {
    let agent: Agent = Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(6)))
        .user_agent("Mozilla/5.0")
        .build()
        .into();
    lookup_with(&agent, &cfx_api(), address)
}

fn lookup_with(agent: &Agent, cfx_api: &str, address: &str) -> Result<ServerInfo> {
    let address = normalize_server_address(address).map_err(Error::Invalid)?;
    let mut info = match address.strip_prefix("cfx.re/join/") {
        Some(code) => lookup_cfx(agent, cfx_api, code)?,
        None => lookup_direct(agent, &address)?,
    };
    info.address = address;
    Ok(info)
}

pub(crate) fn get(
    agent: &Agent,
    url: &str,
    limit: u64,
) -> std::result::Result<Vec<u8>, ureq::Error> {
    let mut response = agent.get(url).call()?;
    response.body_mut().with_config().limit(limit).read_to_vec()
}

fn network_error(what: &str, err: ureq::Error) -> Error {
    log::warn!("server lookup for {what} failed: {err}");
    Error::Network(match err {
        ureq::Error::Timeout(_) => format!("{what} didn't answer in time. Is the server online?"),
        ureq::Error::StatusCode(code) => format!("{what} answered with error {code}."),
        _ => format!("Couldn't reach {what}. Check the address and that the server is online."),
    })
}

fn lookup_cfx(agent: &Agent, api: &str, code: &str) -> Result<ServerInfo> {
    let body = get(agent, &format!("{api}/single/{code}"), JSON_LIMIT).map_err(|err| match err {
        ureq::Error::StatusCode(404) => Error::Network(format!(
            "cfx.re doesn't know the join code \"{code}\". The server may be offline, or use its IP and port instead."
        )),
        err => network_error("cfx.re", err),
    })?;
    let (mut info, icon_version) = parse_cfx(&body)?;
    if let Some(version) = icon_version {
        info.icon = get(
            agent,
            &format!("{api}/icon/{code}/{version}.png"),
            ICON_LIMIT as u64,
        )
        .ok()
        .and_then(|bytes| image_data_url(&bytes));
    }
    Ok(info)
}

fn lookup_direct(agent: &Agent, address: &str) -> Result<ServerInfo> {
    let host = if address.contains(':') {
        address.to_string()
    } else {
        format!("{address}:{DEFAULT_PORT}")
    };
    let info = get(agent, &format!("http://{host}/info.json"), JSON_LIMIT)
        .map_err(|err| network_error(&host, err))?;
    let dynamic = get(agent, &format!("http://{host}/dynamic.json"), JSON_LIMIT).ok();
    parse_direct(&info, dynamic.as_deref())
}

fn parse_json(bytes: &[u8], what: &str) -> Result<Value> {
    serde_json::from_slice(bytes).map_err(|_| {
        Error::Network(format!(
            "{what} answered, but not like a FiveM server does."
        ))
    })
}

/// `GET /api/servers/single/<code>` → info, plus the logo version (no version, no logo).
fn parse_cfx(bytes: &[u8]) -> Result<(ServerInfo, Option<String>)> {
    let value = parse_json(bytes, "cfx.re")?;
    let data = &value["Data"];
    if !data.is_object() {
        return Err(Error::Network(
            "cfx.re didn't return that server. It may be offline.".into(),
        ));
    }
    let name = clean_name(data["vars"]["sv_projectName"].as_str().unwrap_or_default())
        .or_else(|| clean_name(data["hostname"].as_str().unwrap_or_default()));
    let icon_version = match &data["iconVersion"] {
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric()) => {
            Some(s.clone())
        }
        _ => None,
    };
    let info = ServerInfo {
        address: String::new(),
        name,
        icon: None,
        players: as_u32(&data["clients"]),
        max_players: as_u32(&data["sv_maxclients"])
            .or_else(|| as_u32(&data["svMaxclients"]))
            .or_else(|| as_u32(&data["vars"]["sv_maxClients"])),
    };
    Ok((info, icon_version))
}

/// `GET /info.json` (and optionally `/dynamic.json`) straight from the server.
fn parse_direct(info: &[u8], dynamic: Option<&[u8]>) -> Result<ServerInfo> {
    let info = parse_json(info, "The server")?;
    if !info.is_object() {
        return Err(Error::Network(
            "The server answered, but not like a FiveM server does.".into(),
        ));
    }
    let dynamic = dynamic
        .and_then(|bytes| serde_json::from_slice::<Value>(bytes).ok())
        .unwrap_or(Value::Null);
    let icon = info["icon"]
        .as_str()
        .map(|b64| b64.split_whitespace().collect::<String>())
        .and_then(|b64| STANDARD.decode(b64).ok())
        .and_then(|bytes| image_data_url(&bytes));
    Ok(ServerInfo {
        address: String::new(),
        name: clean_name(info["vars"]["sv_projectName"].as_str().unwrap_or_default())
            .or_else(|| clean_name(dynamic["hostname"].as_str().unwrap_or_default())),
        icon,
        players: as_u32(&dynamic["clients"]),
        max_players: as_u32(&dynamic["sv_maxclients"])
            .or_else(|| as_u32(&info["vars"]["sv_maxClients"])),
    })
}

fn as_u32(value: &Value) -> Option<u32> {
    match value {
        Value::Number(n) => n.as_u64().and_then(|n| u32::try_from(n).ok()),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// Server names carry FiveM colour codes (`^1Red ^7White`). Strip them and tidy up.
pub fn clean_name(raw: &str) -> Option<String> {
    clean_text(raw, NAME_LIMIT)
}

/// [`clean_name`] for any server text: no colour codes, one line, at most `limit` characters.
pub fn clean_text(raw: &str, limit: usize) -> Option<String> {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '^'
            && chars
                .peek()
                .is_some_and(|n| n.is_ascii_digit() || "*_~=r".contains(*n))
        {
            chars.next();
            continue;
        }
        out.push(if c.is_control() { ' ' } else { c });
    }
    let name = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let name: String = name.chars().take(limit).collect();
    (!name.is_empty()).then_some(name)
}

/// The image type, recognised from the file's first bytes.
pub fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// A `data:` URL for a PNG/JPEG/WebP of at most [`ICON_LIMIT`] bytes.
pub fn image_data_url(bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() || bytes.len() > ICON_LIMIT {
        return None;
    }
    let mime = image_mime(bytes)?;
    Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

/// Whether a profile's stored logo is an image Loadout produced.
pub fn is_valid_icon(url: &str) -> bool {
    let Some((header, b64)) = url.split_once(',') else {
        return false;
    };
    let Some(mime) = header
        .strip_prefix("data:")
        .and_then(|h| h.strip_suffix(";base64"))
    else {
        return false;
    };
    STANDARD
        .decode(b64)
        .ok()
        .filter(|bytes| bytes.len() <= ICON_LIMIT)
        .and_then(|bytes| image_mime(&bytes))
        == Some(mime)
}

/// A logo picked by hand, for servers that can't be looked up.
pub fn read_logo_file(path: &Path) -> Result<String> {
    let size = fs::metadata(path).ctx_path("read", path)?.len();
    if size > ICON_LIMIT as u64 {
        return Err(Error::invalid(
            "That image is too big. Pick one under 512 KB.",
        ));
    }
    let bytes = fs::read(path).ctx_path("read", path)?;
    image_data_url(&bytes).ok_or_else(|| Error::invalid("Pick a PNG, JPEG or WebP image."))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::net::TcpListener;

    use super::*;
    use crate::test_http::{agent as test_agent, serve, Reply};

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDRfake";

    #[test]
    fn cleans_colour_codes() {
        assert_eq!(
            clean_name("^1Los ^7Santos  ^*RP^r | ^2EN ").as_deref(),
            Some("Los Santos RP | EN")
        );
        assert_eq!(clean_name("^1^2 "), None);
        assert_eq!(clean_name("a^b").as_deref(), Some("a^b"));
        assert_eq!(clean_name(&"x".repeat(200)).unwrap().len(), NAME_LIMIT);
    }

    #[test]
    fn recognises_images() {
        assert_eq!(image_mime(PNG), Some("image/png"));
        assert_eq!(image_mime(b"\xFF\xD8\xFF\xE0"), Some("image/jpeg"));
        assert_eq!(image_mime(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(image_mime(b"<svg"), None);
        let url = image_data_url(PNG).unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
        assert!(is_valid_icon(&url));
        assert!(!is_valid_icon("data:image/jpeg;base64,iVBORw0KGgo="));
        assert!(!is_valid_icon("data:image/svg+xml;base64,PHN2Zz4="));
        assert!(!is_valid_icon("https://example.com/logo.png"));
        assert_eq!(image_data_url(&vec![0x89; ICON_LIMIT + 1]), None);
    }

    #[test]
    fn parses_cfx_server_list_answer() {
        let body = br#"{"EndPoint":"abc123","Data":{"clients":41,"sv_maxclients":128,
            "hostname":"^1Fallback","iconVersion":-1234567,
            "vars":{"sv_projectName":"^2Arena ^7PvP"}}}"#;
        let (info, version) = parse_cfx(body).unwrap();
        assert_eq!(info.name.as_deref(), Some("Arena PvP"));
        assert_eq!((info.players, info.max_players), (Some(41), Some(128)));
        assert_eq!(version.as_deref(), Some("-1234567"));

        let (info, version) =
            parse_cfx(br#"{"Data":{"hostname":"^3City","vars":{"sv_maxClients":"48"}}}"#).unwrap();
        assert_eq!(info.name.as_deref(), Some("City"));
        assert_eq!(info.max_players, Some(48));
        assert_eq!(version, None);

        assert!(parse_cfx(br#"{"error":"not found"}"#).is_err());
        assert!(parse_cfx(b"<html>").is_err());
    }

    #[test]
    fn parses_direct_answer() {
        let info = format!(
            r#"{{"icon":"{}","vars":{{"sv_projectName":"^5Ocean RP","sv_maxClients":"64"}}}}"#,
            STANDARD.encode(PNG)
        );
        let dynamic = br#"{"clients":12,"hostname":"^1ignored","sv_maxclients":"32"}"#;
        let parsed = parse_direct(info.as_bytes(), Some(dynamic)).unwrap();
        assert_eq!(parsed.name.as_deref(), Some("Ocean RP"));
        assert_eq!((parsed.players, parsed.max_players), (Some(12), Some(32)));
        assert_eq!(parsed.icon, image_data_url(PNG));

        let parsed = parse_direct(br#"{"vars":{}}"#, Some(b"{\"hostname\":\"Host\"}")).unwrap();
        assert_eq!(parsed.name.as_deref(), Some("Host"));
        assert_eq!(parsed.icon, None);
        let parsed = parse_direct(br#"{"icon":"bm90IGFuIGltYWdl"}"#, None).unwrap();
        assert_eq!(parsed.icon, None, "non-image icons are dropped");
    }

    #[test]
    fn looks_up_a_server_directly() {
        let info = format!(
            r#"{{"icon":"{}","vars":{{"sv_projectName":"Ocean RP"}}}}"#,
            STANDARD.encode(PNG)
        );
        let port = serve(HashMap::from([
            ("/info.json".to_string(), Reply::ok(info)),
            (
                "/dynamic.json".to_string(),
                Reply::ok(&br#"{"clients":3,"sv_maxclients":"10"}"#[..]),
            ),
        ]));
        let found =
            lookup_with(&test_agent(), "http://unused", &format!("127.0.0.1:{port}")).unwrap();
        assert_eq!(found.address, format!("127.0.0.1:{port}"));
        assert_eq!(found.name.as_deref(), Some("Ocean RP"));
        assert_eq!(found.icon, image_data_url(PNG));
        assert_eq!((found.players, found.max_players), (Some(3), Some(10)));
    }

    #[test]
    fn looks_up_a_join_code() {
        let port = serve(HashMap::from([
            (
                "/api/servers/single/abc123".to_string(),
                Reply::ok(&br#"{"Data":{"hostname":"^2Arena","iconVersion":77,"clients":5}}"#[..]),
            ),
            (
                "/api/servers/icon/abc123/77.png".to_string(),
                Reply::ok(PNG),
            ),
        ]));
        let api = format!("http://127.0.0.1:{port}/api/servers");
        let found = lookup_with(&test_agent(), &api, "https://cfx.re/join/abc123").unwrap();
        assert_eq!(found.address, "cfx.re/join/abc123");
        assert_eq!(found.name.as_deref(), Some("Arena"));
        assert_eq!(found.icon, image_data_url(PNG));

        let err = lookup_with(&test_agent(), &api, "zzz999").unwrap_err();
        assert!(
            err.to_string().contains("doesn't know the join code"),
            "{err}"
        );
    }

    #[test]
    fn explains_unreachable_servers() {
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let err = lookup_with(&test_agent(), CFX_API, &format!("127.0.0.1:{port}")).unwrap_err();
        // Refused straight away on Linux; Windows retries the connect and may time out first.
        let message = err.to_string();
        assert!(
            message.contains("Couldn't reach") || message.contains("didn't answer in time"),
            "{message}"
        );
        let err = lookup_with(&test_agent(), CFX_API, "not an address").unwrap_err();
        assert!(matches!(err, Error::Invalid(_)));
    }

    #[test]
    fn reads_a_logo_file() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("logo.png");
        fs::write(&png, PNG).unwrap();
        assert_eq!(read_logo_file(&png).unwrap(), image_data_url(PNG).unwrap());
        let txt = dir.path().join("logo.txt");
        fs::write(&txt, "hello").unwrap();
        assert!(read_logo_file(&txt).is_err());
    }
}
