//! The FiveM server list, for finding a server by name.
//!
//! FiveM's own server browser downloads every listed server at once and filters
//! locally, and so does Loadout. `GET {api}/streamRedir/` redirects to a stream of
//! frames, each a 4-byte little-endian length followed by a protobuf message:
//!
//! ```text
//! message Server { string EndPoint = 1; ServerData Data = 2; }
//! message ServerData {
//!   int32 svMaxclients = 1; int32 clients = 2; string hostname = 4;
//!   int32 iconVersion = 11; map<string, string> vars = 12;  // and more, skipped
//! }
//! ```
//!
//! The handful of fields Loadout needs are read by the small decoder below.

use std::time::Duration;

use ureq::Agent;

use crate::error::{Error, Result};
use crate::model::{ServerListing, ServerSearch};
use crate::servers::{self, clean_name, clean_text};

/// Results returned per search.
pub const RESULT_LIMIT: usize = 50;
/// The whole list is tens of MB; anything much bigger isn't the server list.
const LIST_LIMIT: u64 = 256 * 1024 * 1024;
/// A single server's entry is a few KB at most.
const FRAME_LIMIT: usize = 1024 * 1024;
const DESCRIPTION_LIMIT: usize = 140;
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// A listed server plus the lower-cased text searches run against.
#[derive(Debug, Clone)]
pub struct Indexed {
    pub listing: ServerListing,
    name: String,
    id: String,
    haystack: String,
}

impl Indexed {
    fn new(listing: ServerListing) -> Self {
        let name = listing.name.to_lowercase();
        let id = listing.id.to_lowercase();
        let haystack = [
            listing.name.as_str(),
            listing.description.as_deref().unwrap_or_default(),
            &listing.tags.join(" "),
            listing.locale.as_deref().unwrap_or_default(),
            listing.id.as_str(),
        ]
        .join(" ")
        .to_lowercase();
        Self {
            listing,
            name,
            id,
            haystack,
        }
    }
}

/// Download the whole server list (a few seconds on a normal connection).
pub fn fetch() -> Result<Vec<Indexed>> {
    let agent: Agent = Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(60)))
        .user_agent(BROWSER_UA)
        .build()
        .into();
    fetch_with(&agent, &servers::cfx_api())
}

fn fetch_with(agent: &Agent, api: &str) -> Result<Vec<Indexed>> {
    let url = format!("{api}/streamRedir/");
    let failed = |err: ureq::Error| {
        log::warn!("downloading the server list failed: {err}");
        Error::Network(match err {
            ureq::Error::Timeout(_) => "The FiveM server list took too long to download. Try again, or paste the server's IP or cfx.re link instead.".into(),
            _ => "Couldn't load the FiveM server list. Check your connection, or paste the server's IP or cfx.re link instead.".into(),
        })
    };
    let mut response = agent
        .get(&url)
        .header("Accept", "*/*")
        .header("Origin", "https://servers.fivem.net")
        .header("Referer", "https://servers.fivem.net/")
        .call()
        .map_err(failed)?;
    let bytes = response
        .body_mut()
        .with_config()
        .limit(LIST_LIMIT)
        .read_to_vec()
        .map_err(failed)?;
    let servers = parse_stream(&bytes, api);
    log::info!(
        "server list: {} servers from {} KB",
        servers.len(),
        bytes.len() / 1024
    );
    if servers.is_empty() {
        return Err(Error::Network(
            "The FiveM server list came back empty. Try again in a minute.".into(),
        ));
    }
    Ok(servers.into_iter().map(Indexed::new).collect())
}

/// Split the stream into frames and decode each one. Broken frames are skipped;
/// a cut-off frame at the end stops the parse.
pub fn parse_stream(bytes: &[u8], api: &str) -> Vec<ServerListing> {
    let mut servers = Vec::new();
    let mut pos = 0;
    while let Some(head) = bytes.get(pos..pos + 4) {
        let len = u32::from_le_bytes([head[0], head[1], head[2], head[3]]) as usize;
        pos += 4;
        let Some(frame) = bytes.get(pos..pos.saturating_add(len)) else {
            break;
        };
        pos += len;
        if len <= FRAME_LIMIT {
            if let Some(server) = decode_server(frame, api) {
                servers.push(server);
            }
        }
    }
    servers
}

/// Most relevant first: an exact join code, then names starting with the query,
/// then names containing it, then everything else that matches every word. Busier
/// servers first within each group. An empty query lists the busiest servers.
pub fn search(servers: &[Indexed], query: &str, limit: usize) -> ServerSearch {
    let query = query.trim().to_lowercase();
    let query = ["https://", "http://", "fivem://connect/"]
        .iter()
        .fold(query.as_str(), |q, prefix| {
            q.strip_prefix(prefix).unwrap_or(q)
        });
    let query = query.strip_prefix("cfx.re/join/").unwrap_or(query);
    let query = query.trim_end_matches('/');
    let words: Vec<&str> = query.split_whitespace().collect();

    let mut ranked: Vec<(u8, &Indexed)> = servers
        .iter()
        .filter_map(|server| {
            let rank = if words.is_empty() {
                0
            } else if server.id == query {
                4
            } else if !words.iter().all(|w| server.haystack.contains(w)) {
                return None;
            } else if server.name.starts_with(query) {
                3
            } else if server.name.contains(query) {
                2
            } else {
                1
            };
            Some((rank, server))
        })
        .collect();
    ranked.sort_by(|(rank_a, a), (rank_b, b)| {
        rank_b
            .cmp(rank_a)
            .then(b.listing.players.cmp(&a.listing.players))
            .then_with(|| a.name.cmp(&b.name))
    });
    ServerSearch {
        matches: ranked.len() as u32,
        total: servers.len() as u32,
        results: ranked
            .into_iter()
            .take(limit)
            .map(|(_, server)| server.listing.clone())
            .collect(),
    }
}

// ---- Protobuf ---------------------------------------------------------------

enum Field<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
    Other,
}

/// Just enough of the protobuf wire format to read the server list.
struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    fn done(&self) -> bool {
        self.pos >= self.buf.len()
    }

    fn varint(&mut self) -> Option<u64> {
        let mut value = 0u64;
        for shift in (0..64).step_by(7) {
            let byte = *self.buf.get(self.pos)?;
            self.pos += 1;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Some(value);
            }
        }
        None
    }

    fn take(&mut self, len: usize) -> Option<&'a [u8]> {
        let bytes = self.buf.get(self.pos..self.pos.checked_add(len)?)?;
        self.pos += len;
        Some(bytes)
    }

    /// The next field number and value. `None` when the data is broken.
    fn field(&mut self) -> Option<(u64, Field<'a>)> {
        let key = self.varint()?;
        let value = match key & 7 {
            0 => Field::Varint(self.varint()?),
            1 => {
                self.take(8)?;
                Field::Other
            }
            2 => {
                let len = usize::try_from(self.varint()?).ok()?;
                Field::Bytes(self.take(len)?)
            }
            5 => {
                self.take(4)?;
                Field::Other
            }
            _ => return None,
        };
        Some((key >> 3, value))
    }
}

/// protobuf `int32`: negative numbers are sent as 10-byte varints.
fn int32(value: u64) -> i32 {
    value as i64 as i32
}

fn count(value: u64) -> u32 {
    int32(value).max(0) as u32
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn decode_server(frame: &[u8], api: &str) -> Option<ServerListing> {
    let mut reader = Reader::new(frame);
    let (mut id, mut data) = (None, None);
    while !reader.done() {
        match reader.field()? {
            (1, Field::Bytes(bytes)) => id = Some(text(bytes)),
            (2, Field::Bytes(bytes)) => data = Some(bytes),
            _ => {}
        }
    }
    let id = id.filter(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric()))?;

    let (mut max_players, mut players, mut icon_version) = (0, 0, 0);
    let (mut hostname, mut project, mut description, mut tags, mut locale) =
        (None, None, None, None, None);
    let mut reader = Reader::new(data?);
    while !reader.done() {
        match reader.field()? {
            (1, Field::Varint(v)) => max_players = count(v),
            (2, Field::Varint(v)) => players = count(v),
            (4, Field::Bytes(bytes)) => hostname = Some(text(bytes)),
            (11, Field::Varint(v)) => icon_version = int32(v),
            (12, Field::Bytes(entry)) => {
                let (mut key, mut value) = (None, None);
                let mut entry = Reader::new(entry);
                while !entry.done() {
                    match entry.field()? {
                        (1, Field::Bytes(bytes)) => key = Some(bytes),
                        (2, Field::Bytes(bytes)) => value = Some(text(bytes)),
                        _ => {}
                    }
                }
                match key {
                    Some(b"sv_projectName") => project = value,
                    Some(b"sv_projectDesc") => description = value,
                    Some(b"tags") => tags = value,
                    Some(b"locale") => locale = value,
                    _ => {}
                }
            }
            _ => {}
        }
    }

    let name = project
        .as_deref()
        .and_then(clean_name)
        .or_else(|| hostname.as_deref().and_then(clean_name))
        .unwrap_or_else(|| id.clone());
    Some(ServerListing {
        icon_url: (icon_version != 0).then(|| format!("{api}/icon/{id}/{icon_version}.png")),
        name,
        description: description
            .as_deref()
            .and_then(|d| clean_text(d, DESCRIPTION_LIMIT)),
        players,
        max_players,
        tags: tags
            .unwrap_or_default()
            .split(',')
            .filter_map(|t| clean_text(t, 24))
            .take(4)
            .collect(),
        locale: locale.filter(|l| !l.trim().is_empty() && l != "root-AQ"),
        id,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::test_http::{agent, serve, Reply};

    // A minimal protobuf encoder, to build frames like the real list's.
    fn varint(mut v: u64) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let byte = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                out.push(byte);
                return out;
            }
            out.push(byte | 0x80);
        }
    }
    fn key(field: u64, wire: u64) -> Vec<u8> {
        varint(field << 3 | wire)
    }
    fn num(field: u64, v: i64) -> Vec<u8> {
        [key(field, 0), varint(v as u64)].concat()
    }
    fn bytes(field: u64, b: &[u8]) -> Vec<u8> {
        [key(field, 2), varint(b.len() as u64), b.to_vec()].concat()
    }
    fn var(k: &str, v: &str) -> Vec<u8> {
        bytes(
            12,
            &[bytes(1, k.as_bytes()), bytes(2, v.as_bytes())].concat(),
        )
    }
    fn frame(message: &[u8]) -> Vec<u8> {
        [
            (message.len() as u32).to_le_bytes().to_vec(),
            message.to_vec(),
        ]
        .concat()
    }
    fn server(id: &str, players: i64, data: Vec<Vec<u8>>) -> Vec<u8> {
        let data = [vec![num(1, 64), num(2, players)], data].concat().concat();
        frame(&[bytes(1, id.as_bytes()), bytes(2, &data)].concat())
    }

    const API: &str = "https://example.test/api/servers";

    #[test]
    fn decodes_the_stream() {
        let stream = [
            server(
                "abc123",
                41,
                vec![
                    bytes(4, b"^1ignored hostname"),
                    num(11, -5),
                    var("sv_projectName", "^2Arena ^7PvP"),
                    var("sv_projectDesc", "^3Fast ^7fights\nno waiting"),
                    var("tags", "pvp, arena,, ^1drift,racing,extra"),
                    var("locale", "en-GB"),
                    // Fields Loadout doesn't read: players, a fixed64, a fixed32.
                    bytes(10, &bytes(1, b"Someone")),
                    [key(13, 1), vec![0; 8]].concat(),
                    [key(14, 5), vec![0; 4]].concat(),
                ],
            ),
            server("plain1", 3, vec![bytes(4, b"^5Plain host"), num(11, 0)]),
            server("bad id!", 1, vec![]),
            frame(b"\xff\xff\xff"),
            // A cut-off frame at the end.
            server("cut999", 1, vec![])[..10].to_vec(),
        ]
        .concat();
        let servers = parse_stream(&stream, API);
        assert_eq!(servers.len(), 2, "{servers:#?}");
        let arena = &servers[0];
        assert_eq!(arena.id, "abc123");
        assert_eq!(arena.name, "Arena PvP");
        assert_eq!(arena.description.as_deref(), Some("Fast fights no waiting"));
        assert_eq!((arena.players, arena.max_players), (41, 64));
        assert_eq!(arena.tags, ["pvp", "arena", "drift", "racing"]);
        assert_eq!(arena.locale.as_deref(), Some("en-GB"));
        assert_eq!(
            arena.icon_url.as_deref(),
            Some("https://example.test/api/servers/icon/abc123/-5.png")
        );
        let plain = &servers[1];
        assert_eq!(plain.name, "Plain host");
        assert_eq!(plain.icon_url, None);
        assert_eq!(plain.description, None);
        assert!(plain.tags.is_empty());
    }

    fn listing(id: &str, name: &str, players: u32, tags: &[&str]) -> Indexed {
        Indexed::new(ServerListing {
            id: id.into(),
            name: name.into(),
            description: Some(format!("{name} description")),
            players,
            max_players: 128,
            icon_url: None,
            tags: tags.iter().map(|t| t.to_string()).collect(),
            locale: Some("en-US".into()),
        })
    }

    #[test]
    fn ranks_search_results() {
        let servers = vec![
            listing("aaa111", "Big City Roleplay", 300, &["rp", "economy"]),
            listing("bbb222", "Roleplay Heaven", 50, &["rp"]),
            listing("ccc333", "Arena Deathmatch", 120, &["pvp"]),
            listing("ddd444", "Quiet RP", 10, &["serious", "roleplay"]),
            listing("roleplay", "Some Server", 1, &[]),
        ];
        let ids = |query: &str| -> Vec<String> {
            search(&servers, query, 10)
                .results
                .into_iter()
                .map(|s| s.id)
                .collect()
        };
        // Exact code, then "starts with", then "contains", then other matches.
        assert_eq!(ids("Roleplay"), ["roleplay", "bbb222", "aaa111", "ddd444"]);
        assert_eq!(ids("city rp"), ["aaa111"]);
        assert_eq!(ids("https://cfx.re/join/CCC333/"), ["ccc333"]);
        assert_eq!(ids("pvp"), ["ccc333"]);
        assert!(ids("nothing like this").is_empty());

        let busiest = search(&servers, "  ", 2);
        assert_eq!(busiest.total, 5);
        assert_eq!(busiest.matches, 5);
        let busiest: Vec<_> = busiest.results.into_iter().map(|s| s.id).collect();
        assert_eq!(busiest, ["aaa111", "ccc333"]);
        let roleplay = search(&servers, "roleplay", 1);
        assert_eq!((roleplay.matches, roleplay.results.len()), (4, 1));
    }

    #[test]
    fn downloads_the_list_through_the_redirect() {
        let stream = [
            server("abc123", 7, vec![var("sv_projectName", "Arena")]),
            server("def456", 9, vec![var("sv_projectName", "City")]),
        ]
        .concat();
        let port = serve(HashMap::from([
            (
                "/api/servers/streamRedir/".to_string(),
                Reply::redirect("/stream/latest"),
            ),
            ("/stream/latest".to_string(), Reply::ok(stream)),
        ]));
        let api = format!("http://127.0.0.1:{port}/api/servers");
        let servers = fetch_with(&agent(), &api).unwrap();
        assert_eq!(servers.len(), 2);
        let found = search(&servers, "", 10);
        assert_eq!(found.results[0].name, "City");

        let empty = serve(HashMap::from([(
            "/api/servers/streamRedir/".to_string(),
            Reply::ok(Vec::new()),
        )]));
        let err =
            fetch_with(&agent(), &format!("http://127.0.0.1:{empty}/api/servers")).unwrap_err();
        assert!(err.to_string().contains("came back empty"), "{err}");
        let err = fetch_with(&agent(), &format!("http://127.0.0.1:{empty}/nope")).unwrap_err();
        assert!(
            err.to_string()
                .contains("Couldn't load the FiveM server list"),
            "{err}"
        );
    }
}
