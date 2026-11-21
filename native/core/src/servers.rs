//! Which server the app may talk to, and which one it picks.
//!
//! Reference: `mobile/src/servers/list.ts` (pure rules) and `mobile/src/servers/pool.ts` (the pool).
//!
//! The account lives at a fixed «realm»; keys and history on the device are tied to it, never to the address in
//! use. Servers are the built-in ones plus a list signed by the owner offline: the app only accepts a list
//! signed by a key built into it, so a hijacked DNS name or a captured data centre cannot point people at a
//! foreign server. The fastest live server is used; a failed one is skipped at once.

use crate::json::{self, Value};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signature, VerifyingKey};

/// Only our own domains may ever carry the account.
fn trusted_host(host: &str) -> bool {
    if host == "141-133-194-51.nip.io" || host == "invizent-api.invizent-8165e2.workers.dev" { return true }
    let Some(rest) = host.strip_suffix(".com").or_else(|| host.strip_suffix(".ru")) else { return false };
    let mut labels: Vec<&str> = rest.split('.').collect();
    if labels.pop() != Some("invizent") { return false }
    labels.iter().all(|label| !label.is_empty() && label.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))
}

/// The server's address in its one accepted form (`https://host`), or `None` when it may not be used:
/// only https, only our domains, the default port, no credentials, path, query or fragment.
pub fn normalize_server(address: &str) -> Option<String> {
    let parsed = url::Url::parse(address).ok()?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() { return None }
    if parsed.query().is_some_and(|query| !query.is_empty()) || parsed.fragment().is_some_and(|fragment| !fragment.is_empty()) { return None }
    if parsed.path() != "/" || parsed.port().is_some() { return None }
    let host = parsed.host_str()?;
    if !trusted_host(host) { return None }
    Some(format!("https://{host}"))
}

#[derive(Clone, PartialEq, Debug)]
pub struct ServerEntry { pub url: String, pub region: Option<String> }

#[derive(Clone, PartialEq, Debug)]
pub struct ServerList { pub version: f64, pub issued_at: String, pub servers: Vec<ServerEntry> }

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
fn base64_text(text: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
}
/// `String(value || '')` for the list's date.
fn js_string_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => String::new(),
        Some(Value::Bool(true)) => "true".to_string(),
        Some(Value::Number(number)) => if *number == 0.0 || number.is_nan() { String::new() } else { json::number_text(*number) },
        Some(Value::String(text)) => text.to_string_lossy(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => String::new(), // never sent by the owner's tool; not a date either way
    }
}

/// Checks the signature with the built-in keys and the content rules. `min_version` stops an attacker from
/// replaying an older, still validly signed list.
///
/// The signature check is Ed25519 as the common libraries do it. The reference's library also accepts a few
/// non-canonical encodings that only the holder of the signing key could produce; a list signed by the owner's
/// tool is never one of those.
pub fn verify_server_list(payload: &str, sig: &str, keys: &[&str], min_version: f64) -> Option<ServerList> {
    if payload.encode_utf16().count() > 16_384 || !base64_text(sig, 80, 100) { return None }
    let signature = Signature::from_slice(&STANDARD.decode(sig).ok()?).ok()?;
    let signed_by_ours = keys.iter().any(|key| {
        if !base64_text(key, 40, 48) { return false }
        let Ok(bytes) = STANDARD.decode(key) else { return false };
        let Ok(bytes): Result<[u8; 32], _> = bytes.try_into() else { return false };
        VerifyingKey::from_bytes(&bytes).is_ok_and(|key| key.verify_strict(payload.as_bytes(), &signature).is_ok())
    });
    if !signed_by_ours { return None }
    let list = json::parse(payload).ok()?;
    let version = match list.get("version") { Some(Value::Number(n)) if n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER => *n, _ => return None };
    if version < min_version { return None }
    let Some(Value::Array(entries)) = list.get("servers") else { return None };
    if entries.is_empty() || entries.len() > 32 { return None }
    let mut servers: Vec<ServerEntry> = Vec::new();
    for entry in entries {
        let url = normalize_server(&entry.get("url").and_then(Value::as_str)?)?;
        if servers.iter().any(|server| server.url == url) { return None }
        let region = match entry.get("region") { Some(Value::String(text)) if text.0.len() <= 40 => text.to_str(), _ => None };
        servers.push(ServerEntry { url, region });
    }
    Some(ServerList { version, issued_at: js_string_or_empty(list.get("issuedAt")), servers })
}

/// What is known about a server's speed.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Rtt {
    /// Never measured.
    Unknown,
    /// The last probe got no answer.
    Dead,
    /// Round trip, milliseconds.
    Ms(f64),
}

/// Picks the server to use. Measured round trips decide; the current one is kept unless it fails or another is
/// clearly faster (≥40 ms and ≥30 %), so the app does not flip-flop. `rtt` is in the order the servers were measured.
pub fn choose_server(current: Option<&str>, rtt: &[(String, Rtt)]) -> Option<String> {
    let mut alive: Vec<(&str, f64)> = rtt.iter().filter_map(|(url, speed)| match speed { Rtt::Ms(ms) => Some((url.as_str(), *ms)), _ => None }).collect();
    alive.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    let Some(&(best_url, best)) = alive.first() else { return current.map(str::to_string) };
    if let Some(current) = current {
        if let Some((_, Rtt::Ms(now))) = rtt.iter().find(|(url, _)| url == current) {
            if !(now - best >= 40.0 && best <= now * 0.7) { return Some(current.to_string()) }
        }
    }
    Some(best_url.to_string())
}

/// After `failed` stopped answering: the next server to try. Measured-alive servers first (fastest first), then
/// never-measured ones; servers whose last probe failed or that failed recently come after — and if every other
/// server is known dead, we stay on `failed` (a slow link drops requests now and then; jumping to a dead server
/// would waste a whole upload). `down`: when each server last failed (0 when never).
pub fn fallback_server(failed: &str, all: &[String], rtt: &dyn Fn(&str) -> Rtt, down: &dyn Fn(&str) -> f64, now: f64, down_ms: f64) -> Option<String> {
    let others: Vec<&String> = all.iter().filter(|url| url.as_str() != failed).collect();
    if others.is_empty() { return None }
    let recently_down = |url: &str| down(url) != 0.0 && now - down(url) < down_ms;
    let rank = |url: &str| -> u8 { if recently_down(url) || rtt(url) == Rtt::Dead { 2 } else if matches!(rtt(url), Rtt::Ms(_)) { 0 } else { 1 } };
    let ms = |url: &str| match rtt(url) { Rtt::Ms(ms) => ms, _ => 0.0 };
    let mut sorted = others.clone();
    sorted.sort_by(|a, b| {
        rank(a).cmp(&rank(b)).then_with(|| {
            let within = match rank(a) { 0 => ms(a) - ms(b), 2 => down(a) - down(b), _ => 0.0 };
            within.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
        })
    });
    let best = sorted[0];
    if rank(best) == 2 && all.iter().any(|url| url == failed) { Some(failed.to_string()) } else { Some(best.clone()) }
}
