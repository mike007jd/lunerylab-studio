pub(crate) fn bridge_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|err| format!("OS RNG unavailable for desktop bridge token: {err}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Dependency-free constant-time byte-slice equality. A length mismatch returns
/// false early (this leaks only length, not content — the bridge token is a
/// fixed-length 64-char hex string), but for equal-length inputs the comparison
/// time is independent of where the first differing byte is, so an attacker
/// cannot recover the token byte-by-byte via response-timing.
pub(crate) fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// True when `host` (the raw `Host` request header value) points at loopback.
/// Accepts `127.0.0.1[:port]`, `localhost[:port]`, and `[::1][:port]`. Used as
/// defense-in-depth against DNS-rebinding: even though the bridge binds only
/// 127.0.0.1, a rebound hostname resolving to loopback could still reach it, so
/// we additionally require the presented Host to be a loopback literal.
pub(crate) fn host_is_loopback(host: &str) -> bool {
    let host = host.trim();
    if host.is_empty() {
        return false;
    }
    // IPv6 literal form: `[::1]` optionally followed by `:port`.
    if let Some(rest) = host.strip_prefix('[') {
        if let Some((inside, _after)) = rest.split_once(']') {
            return inside.eq_ignore_ascii_case("::1");
        }
        return false;
    }
    // host[:port] — split off a trailing port if present.
    let bare = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
    bare.eq_ignore_ascii_case("localhost") || bare == "127.0.0.1"
}
