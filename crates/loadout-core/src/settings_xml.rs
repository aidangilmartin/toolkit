//! Reads and patches GTA V `settings.xml` / FiveM `gta5_settings.xml`.
//!
//! The patcher never re-serialises the document. It records the byte ranges of every
//! value while parsing, then splices replacement text into the original string. Every
//! byte we don't change (line endings, indentation, BOM, element order) stays
//! exactly as the game wrote it.

use std::collections::BTreeMap;

use quick_xml::events::Event;
use quick_xml::Reader;

use crate::model::KeyChange;

#[derive(Debug, Clone)]
enum ValueLoc {
    /// Byte range of the `value="…"` attribute content (without quotes).
    Attr(usize, usize),
    /// Byte range of the element's text content.
    Text(usize, usize),
    /// Element exists but carries no value (`<Foo />`): range of the whole tag.
    Tag(usize, usize),
}

#[derive(Debug, Clone)]
struct Entry {
    key: String,
    value: String,
    loc: ValueLoc,
}

#[derive(Debug, Clone)]
struct Section {
    name: String,
    /// Offset right after the last child element (where new children go).
    insert_at: usize,
    child_indent: String,
}

#[derive(Debug, Clone)]
pub struct SettingsXml {
    text: String,
    bom: bool,
    newline: &'static str,
    entries: Vec<Entry>,
    sections: Vec<Section>,
}

#[derive(Debug, Clone)]
pub struct PatchOutcome {
    pub bytes: Vec<u8>,
    pub changes: Vec<KeyChange>,
    /// Keys whose section doesn't exist in this file.
    pub skipped: Vec<String>,
}

struct Frame {
    name: String,
    open_end: usize,
    text: String,
    text_range: Option<(usize, usize)>,
    value_attr: Option<(usize, usize, String)>,
    has_children: bool,
    last_child_end: Option<usize>,
    child_indent: Option<String>,
}

impl SettingsXml {
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        let (bom, body) = match bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
            Some(rest) => (true, rest),
            None => (false, bytes),
        };
        let text = String::from_utf8(body.to_vec())
            .map_err(|_| "the file isn't valid UTF-8 text".to_string())?;
        let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };

        let mut reader = Reader::from_str(&text);
        reader.config_mut().trim_text(false);
        let mut stack: Vec<Frame> = Vec::new();
        let mut entries = Vec::new();
        let mut sections = Vec::new();
        let mut last_ws: Option<(usize, usize)> = None;
        let mut saw_root = false;

        loop {
            let start = reader.buffer_position() as usize;
            let event = reader
                .read_event()
                .map_err(|e| format!("invalid XML near byte {start}: {e}"))?;
            let end = reader.buffer_position() as usize;
            match event {
                Event::Start(tag) => {
                    let name = tag.name().as_ref().to_string();
                    if stack.is_empty() {
                        if saw_root {
                            return Err("more than one root element".into());
                        }
                        saw_root = true;
                    }
                    let indent = indent_of(&text, last_ws);
                    if let Some(parent) = stack.last_mut() {
                        parent.has_children = true;
                        parent.child_indent.get_or_insert(indent);
                    }
                    let value_attr = find_attr(&text[start..end], "value").map(|(s, e)| {
                        (start + s, start + e, unescape(&text[start + s..start + e]))
                    });
                    stack.push(Frame {
                        name,
                        open_end: end,
                        text: String::new(),
                        text_range: None,
                        value_attr,
                        has_children: false,
                        last_child_end: None,
                        child_indent: None,
                    });
                    last_ws = None;
                }
                Event::Empty(tag) => {
                    let name = tag.name().as_ref().to_string();
                    let indent = indent_of(&text, last_ws);
                    if let Some(parent) = stack.last_mut() {
                        parent.has_children = true;
                        parent.last_child_end = Some(end);
                        parent.child_indent.get_or_insert(indent);
                    }
                    if !stack.is_empty() {
                        let key = path_of(&stack, &name);
                        let loc_value = match find_attr(&text[start..end], "value") {
                            Some((s, e)) => (
                                ValueLoc::Attr(start + s, start + e),
                                unescape(&text[start + s..start + e]),
                            ),
                            None => (ValueLoc::Tag(start, end), String::new()),
                        };
                        entries.push(Entry {
                            key,
                            value: loc_value.1,
                            loc: loc_value.0,
                        });
                    }
                    last_ws = None;
                }
                Event::Text(t) => {
                    let content = t.xml10_content();
                    if content.trim().is_empty() {
                        last_ws = Some((start, end));
                    } else {
                        last_ws = None;
                    }
                    if let Some(frame) = stack.last_mut() {
                        frame.text.push_str(&content);
                        extend(&mut frame.text_range, start, end);
                    }
                }
                Event::GeneralRef(r) => {
                    let decoded = match r.resolve_char_ref() {
                        Ok(Some(c)) => c.to_string(),
                        _ => match r.into_inner().as_ref() {
                            "amp" => "&".into(),
                            "lt" => "<".into(),
                            "gt" => ">".into(),
                            "quot" => "\"".into(),
                            "apos" => "'".into(),
                            other => format!("&{other};"),
                        },
                    };
                    if let Some(frame) = stack.last_mut() {
                        frame.text.push_str(&decoded);
                        extend(&mut frame.text_range, start, end);
                    }
                    last_ws = None;
                }
                Event::CData(c) => {
                    if let Some(frame) = stack.last_mut() {
                        frame.text.push_str(&c.into_inner());
                        extend(&mut frame.text_range, start, end);
                    }
                    last_ws = None;
                }
                Event::End(_) => {
                    let frame = stack.pop().ok_or("unexpected closing tag")?;
                    if let Some(parent) = stack.last_mut() {
                        parent.last_child_end = Some(end);
                    }
                    if stack.is_empty() {
                        // Closing the root element.
                        last_ws = None;
                        continue;
                    }
                    let key = path_of(&stack, &frame.name);
                    if frame.has_children {
                        sections.push(Section {
                            name: key,
                            insert_at: frame.last_child_end.unwrap_or(frame.open_end),
                            child_indent: frame.child_indent.unwrap_or_else(|| "    ".into()),
                        });
                    } else if let Some((s, e, value)) = frame.value_attr {
                        entries.push(Entry {
                            key,
                            value,
                            loc: ValueLoc::Attr(s, e),
                        });
                    } else {
                        let (s, e) = frame.text_range.unwrap_or((frame.open_end, frame.open_end));
                        entries.push(Entry {
                            key,
                            value: frame.text.trim().to_string(),
                            loc: ValueLoc::Text(s, e),
                        });
                    }
                    last_ws = None;
                }
                Event::Eof => break,
                _ => last_ws = None,
            }
        }
        if !saw_root {
            return Err("the file is empty".into());
        }
        if !stack.is_empty() {
            return Err("the file is cut off (unclosed elements)".into());
        }
        Ok(Self {
            text,
            bom,
            newline,
            entries,
            sections,
        })
    }

    /// Every leaf value in the file, keyed by `section/Element` (or `Element` for
    /// top-level values such as `version`).
    pub fn values(&self) -> BTreeMap<String, String> {
        self.entries
            .iter()
            .map(|e| (e.key.clone(), e.value.clone()))
            .collect()
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.entries
            .iter()
            .rev()
            .find(|e| e.key == key)
            .map(|e| e.value.as_str())
    }

    /// Apply `changes` and return the new file bytes. Values that already match
    /// produce no change; missing elements are inserted into their section.
    pub fn patch(&self, changes: &BTreeMap<String, String>) -> PatchOutcome {
        let mut edits: Vec<(usize, usize, String)> = Vec::new();
        let mut inserts: BTreeMap<usize, String> = BTreeMap::new();
        let mut applied = Vec::new();
        let mut skipped = Vec::new();

        for (key, new_value) in changes {
            if let Some(entry) = self.entries.iter().rev().find(|e| &e.key == key) {
                if &entry.value == new_value {
                    continue;
                }
                match entry.loc {
                    ValueLoc::Attr(s, e) => edits.push((s, e, escape_attr(new_value))),
                    ValueLoc::Text(s, e) => edits.push((s, e, escape_text(new_value))),
                    ValueLoc::Tag(s, e) => {
                        let name = key.rsplit('/').next().unwrap_or(key);
                        edits.push((s, e, element(name, new_value)));
                    }
                }
                applied.push(KeyChange {
                    key: key.clone(),
                    from: Some(entry.value.clone()),
                    to: new_value.clone(),
                });
                continue;
            }
            let Some((section_name, name)) = key.rsplit_once('/') else {
                skipped.push(key.clone());
                continue;
            };
            let Some(section) = self.sections.iter().find(|s| s.name == section_name) else {
                skipped.push(key.clone());
                continue;
            };
            let insert = inserts.entry(section.insert_at).or_default();
            insert.push_str(self.newline);
            insert.push_str(&section.child_indent);
            insert.push_str(&element(name, new_value));
            applied.push(KeyChange {
                key: key.clone(),
                from: None,
                to: new_value.clone(),
            });
        }

        for (at, text) in inserts {
            edits.push((at, at, text));
        }
        // Apply from the end so earlier offsets stay valid.
        edits.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
        let mut text = self.text.clone();
        for (s, e, replacement) in edits {
            text.replace_range(s..e, &replacement);
        }
        let mut bytes = Vec::with_capacity(text.len() + 3);
        if self.bom {
            bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        }
        bytes.extend_from_slice(text.as_bytes());
        PatchOutcome {
            bytes,
            changes: applied,
            skipped,
        }
    }
}

fn path_of(stack: &[Frame], name: &str) -> String {
    // stack[0] is the <Settings> root, which isn't part of the key.
    let mut parts: Vec<&str> = stack.iter().skip(1).map(|f| f.name.as_str()).collect();
    parts.push(name);
    parts.join("/")
}

fn extend(range: &mut Option<(usize, usize)>, start: usize, end: usize) {
    *range = Some(match *range {
        Some((s, _)) => (s, end),
        None => (start, end),
    });
}

/// Indentation of an element = whitespace after the last newline before it.
fn indent_of(text: &str, ws: Option<(usize, usize)>) -> String {
    match ws {
        Some((s, e)) => {
            let ws = &text[s..e];
            match ws.rfind('\n') {
                Some(i) => ws[i + 1..].to_string(),
                None => ws.to_string(),
            }
        }
        None => String::new(),
    }
}

fn element(name: &str, value: &str) -> String {
    format!("<{name} value=\"{}\" />", escape_attr(value))
}

/// Locate the content range of attribute `attr` inside a raw start tag.
fn find_attr(tag: &str, attr: &str) -> Option<(usize, usize)> {
    let bytes = tag.as_bytes();
    let mut i = 1; // skip '<'
    while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'>' && bytes[i] != b'/'
    {
        i += 1;
    }
    loop {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] == b'>' || bytes[i] == b'/' {
            return None;
        }
        let name_start = i;
        while i < bytes.len() && bytes[i] != b'=' && !bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let name = &tag[name_start..i];
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'=' {
            return None;
        }
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let quote = *bytes.get(i)?;
        if quote != b'"' && quote != b'\'' {
            return None;
        }
        let value_start = i + 1;
        let value_end = value_start + tag[value_start..].find(quote as char)?;
        if name == attr {
            return Some((value_start, value_end));
        }
        i = value_end + 1;
    }
}

fn unescape(raw: &str) -> String {
    if !raw.contains('&') {
        return raw.to_string();
    }
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp + 1..];
        match after.find(';') {
            Some(semi) => {
                let entity = &after[..semi];
                let decoded = match entity {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    _ => entity
                        .strip_prefix("#x")
                        .and_then(|h| u32::from_str_radix(h, 16).ok())
                        .or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()))
                        .and_then(char::from_u32),
                };
                match decoded {
                    Some(c) => out.push(c),
                    None => {
                        out.push('&');
                        out.push_str(entity);
                        out.push(';');
                    }
                }
                rest = &after[semi + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn escape_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('"', "&quot;")
}

fn escape_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    /// The fixture with LF line endings, whatever git did on checkout.
    fn sample() -> String {
        include_str!("../tests/fixtures/settings.xml").replace("\r\n", "\n")
    }

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn reads_values_from_a_real_shaped_file() {
        let doc = SettingsXml::parse(sample().as_bytes()).unwrap();
        let values = doc.values();
        assert_eq!(values["version"], "27");
        assert_eq!(values["configSource"], "SMC_AUTO");
        assert_eq!(values["graphics/ShadowQuality"], "3");
        assert_eq!(values["graphics/LodScale"], "1.000000");
        assert_eq!(values["video/Windowed"], "0");
        assert_eq!(
            values["VideoCardDescription"],
            "NVIDIA GeForce RTX 3070 & Co"
        );
        assert!(values.len() > 50);
    }

    #[test]
    fn unchanged_patch_is_byte_identical() {
        let doc = SettingsXml::parse(sample().as_bytes()).unwrap();
        let out = doc.patch(&map(&[("graphics/ShadowQuality", "3")]));
        assert!(out.changes.is_empty());
        assert_eq!(out.bytes, sample().as_bytes());
    }

    #[test]
    fn patch_only_touches_requested_values() {
        let doc = SettingsXml::parse(sample().as_bytes()).unwrap();
        let out = doc.patch(&map(&[
            ("graphics/ShadowQuality", "1"),
            ("video/Windowed", "2"),
            ("configSource", "SMC_USER"),
        ]));
        assert_eq!(out.changes.len(), 3);
        let expected = sample()
            .replace(
                "<ShadowQuality value=\"3\" />",
                "<ShadowQuality value=\"1\" />",
            )
            .replace("<Windowed value=\"0\" />", "<Windowed value=\"2\" />")
            .replace("SMC_AUTO", "SMC_USER");
        assert_eq!(String::from_utf8(out.bytes.clone()).unwrap(), expected);
        let reparsed = SettingsXml::parse(&out.bytes).unwrap();
        assert_eq!(reparsed.get("graphics/ShadowQuality"), Some("1"));
        assert_eq!(reparsed.get("configSource"), Some("SMC_USER"));
    }

    #[test]
    fn missing_keys_are_inserted_with_matching_indentation() {
        let crlf = sample().replace('\n', "\r\n");
        let doc = SettingsXml::parse(crlf.as_bytes()).unwrap();
        let out = doc.patch(&map(&[
            ("graphics/BrandNewSetting", "0.500000"),
            ("graphics/AnotherOne", "true"),
            ("nosuchsection/Thing", "1"),
        ]));
        assert_eq!(out.skipped, vec!["nosuchsection/Thing".to_string()]);
        let text = String::from_utf8(out.bytes).unwrap();
        assert!(text.contains(
            "<MotionBlurStrength value=\"0.000000\" />\r\n    <AnotherOne value=\"true\" />\r\n    <BrandNewSetting value=\"0.500000\" />\r\n  </graphics>"
        ));
        let reparsed = SettingsXml::parse(text.as_bytes()).unwrap();
        assert_eq!(reparsed.get("graphics/BrandNewSetting"), Some("0.500000"));
    }

    #[test]
    fn bom_and_entities_survive() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(sample().as_bytes());
        let doc = SettingsXml::parse(&bytes).unwrap();
        let out = doc.patch(&map(&[("graphics/MSAA", "4")]));
        assert_eq!(&out.bytes[..3], &[0xEF, 0xBB, 0xBF]);
        let text = String::from_utf8(out.bytes[3..].to_vec()).unwrap();
        assert!(text.contains("NVIDIA GeForce RTX 3070 &amp; Co"));
        assert!(text.contains("<MSAA value=\"4\" />"));
    }

    #[test]
    fn rejects_garbage() {
        assert!(SettingsXml::parse(b"").is_err());
        assert!(SettingsXml::parse(b"<Settings><graphics>").is_err());
        assert!(SettingsXml::parse(&[0xff, 0xfe, 0x00]).is_err());
    }

    #[test]
    fn attribute_finder_handles_spacing_and_quotes() {
        assert_eq!(find_attr("<A value=\"1\" />", "value"), Some((10, 11)));
        assert_eq!(
            find_attr("<A  x='2'   value = '33'/>", "value"),
            Some((21, 23))
        );
        assert_eq!(find_attr("<A x=\"1\"/>", "value"), None);
    }
}
