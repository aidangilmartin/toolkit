//! Server addresses and FiveM launch helpers. The actual process spawning /
//! URL opening is done by the desktop shell.

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
}
