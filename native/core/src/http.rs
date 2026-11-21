//! Requests to the server: what is sent with each one and what its answer means.
//!
//! Reference: `mobile/src/api.ts` (`requestOnce`, `send`, `request`, `ApiError`, `requestTimeout`) and
//! `mobile/src/attest/index.ts`. The apps do the network call itself with the platform's own client (TLS and
//! certificate checks are the system's); this module decides the headers before it and reads the answer after it,
//! so both apps treat every answer the same way.

use crate::attest;
use crate::json::{self, Value};
use crate::network::{timeout_for, RequestKind, Tier};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Platform { Ios, Android }

/// `X-Linea-Client`: the real build, so that retired versions can be turned away.
pub fn client_header(version: &str, platform: Platform) -> String {
    format!("invizent; v={version}; p={}", match platform { Platform::Ios => "ios", Platform::Android => "android" })
}

/// What one request carries.
pub struct Outgoing<'a> {
    pub method: &'a str,
    /// The path with its query, as it is sent.
    pub path: &'a str,
    /// Whether the body is JSON (not a file form).
    pub json_body: bool,
    pub client: &'a str,
    /// The session token, when signed in.
    pub token: Option<&'a str>,
    /// The device proof held right now, if any.
    pub proof: Option<&'a str>,
    /// The per-build signing key ("" when the build has none).
    pub attest_key: &'a str,
    pub now_ms: u64,
}

/// The headers, in the order the reference sends them.
pub fn headers(request: &Outgoing) -> Vec<(&'static str, String)> {
    let mut out = vec![("X-Linea-Client", request.client.to_string())];
    let verb = if request.method.is_empty() { "GET".to_string() } else { request.method.to_uppercase() };
    // Only state-changing requests are signed.
    if verb != "GET" && verb != "HEAD" {
        if let Some(value) = attest::header(request.attest_key, request.now_ms / 1000, &verb, request.path) { out.push(("X-Linea-Attest", value)) }
    }
    if request.json_body { out.push(("Content-Type", "application/json".to_string())) }
    if let Some(token) = request.token.filter(|token| !token.is_empty()) {
        out.push(("Authorization", format!("Bearer {token}")));
        if let Some(proof) = request.proof { out.push(("X-Linea-Proof", proof.to_string())) }
    }
    out
}

/// The server said no.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct ApiError {
    pub message: String,
    pub status: u16,
    pub code: Option<String>,
    pub attempts_remaining: Option<u8>,
    /// Wrong sign-ins left before the 5-minute lock.
    pub attempts_left: Option<u8>,
    pub retry_after_seconds: Option<f64>,
    pub ready_at: Option<String>,
    pub server_time: Option<String>,
    pub expires_at: Option<String>,
    /// Chunked uploads: how many bytes the server already has, to resume from there.
    pub received: Option<f64>,
}

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
pub const GENERIC_ERROR: &str = "Не удалось выполнить запрос. Попробуй ещё раз.";
pub const SERVER_DOWN: &str = "Сервер недоступен.";

impl ApiError {
    /// From the answer's status and its JSON body (anything that is not an object gives the bare error).
    pub fn from_answer(status: u16, data: &Value) -> ApiError {
        let text = |key: &str| data.get(key).and_then(Value::as_str);
        let number = |key: &str| match data.get(key) { Some(Value::Number(n)) => Some(*n), _ => None };
        let small = |key: &str, max: f64| number(key).filter(|n| n.fract() == 0.0 && *n >= 0.0 && *n <= max).map(|n| n as u8);
        ApiError {
            message: text("error").unwrap_or_else(|| GENERIC_ERROR.to_string()),
            status,
            code: text("code"),
            attempts_remaining: small("attemptsRemaining", 3.0),
            attempts_left: small("attemptsLeft", 5.0),
            retry_after_seconds: number("retryAfterSeconds").filter(|n| n.is_finite() && *n >= 0.0),
            ready_at: text("readyAt"),
            server_time: text("serverTime"),
            expires_at: text("expiresAt"),
            received: number("received").filter(|n| n.fract() == 0.0 && *n >= 0.0 && *n <= MAX_SAFE_INTEGER),
        }
    }
}

/// What an answer means.
#[derive(Clone, PartialEq, Debug)]
pub enum Outcome {
    /// The parsed body (`{}` when the body is empty or is not JSON).
    Ok(Value),
    Refused(ApiError),
    /// 502/503/504 come from the proxy in front of a server that is down: the request never reached the server
    /// itself, so it is safe to send it to the next one.
    ServerDown,
}

#[derive(Clone, PartialEq, Debug)]
pub struct Answer {
    pub outcome: Outcome,
    /// Any answer below 500 proves a server of ours is reachable (tells «no internet» from a short drop).
    pub server_ok: bool,
    /// 426: this build is retired — the app must ask for an update.
    pub update_required: bool,
}

pub fn read_answer(status: u16, body: &str) -> Answer {
    let data = if body.is_empty() { Value::Object(Vec::new()) } else { json::parse(body).unwrap_or_else(|_| Value::Object(Vec::new())) };
    let outcome = if matches!(status, 502 | 503 | 504) { Outcome::ServerDown }
        else if !(200..300).contains(&status) { Outcome::Refused(ApiError::from_answer(status, &data)) }
        else { Outcome::Ok(data) };
    Answer { outcome, server_ok: status < 500, update_required: status == 426 }
}

/// Whether a request that failed on one server goes to the next by itself: only reads, or a request that
/// provably never arrived; writes have their own retries (messages are idempotent by their client id), so
/// nothing is ever done twice.
pub fn repeats_on_next_server(method: &str, not_delivered: bool, endpoint_changed: bool, streamed_body: bool) -> bool {
    let verb = if method.is_empty() { "GET".to_string() } else { method.to_uppercase() };
    (verb == "GET" || verb == "HEAD" || not_delivered) && endpoint_changed && !streamed_body
}

/// Whether a request belongs to a session that may need the device proof.
pub fn bound(token: Option<&str>, path: &str) -> bool {
    token.is_some_and(|token| !token.is_empty()) && !path.starts_with("/auth/device/")
}

/// The server wants the device proof (ours ran out, or the session was bound a moment ago): get one and repeat.
/// Nothing was done by the refused request, so repeating a write is safe.
pub fn wants_proof(error: &ApiError) -> bool {
    error.status == 401 && error.code.as_deref() == Some("device_proof")
}

/// The time limit of one request, milliseconds.
pub fn request_timeout(path: &str, method: &str, tier: Tier) -> u32 {
    // AI media jobs run much longer than ordinary calls.
    match path { "/ai/chat" | "/ai/speech" => return 70_000, "/ai/image" | "/ai/transcribe" => return 130_000, "/ai/video" => return 340_000, "/ai/models" => return 20_000, _ => {} }
    let bare = path.split('?').next().unwrap_or("");
    // Signing in and changing secrets hash up to three secrets on the server and queue behind other such jobs.
    if method == "POST" && matches!(bare, "/auth/login" | "/auth/register" | "/auth/recovery/verify" | "/auth/recovery/reset" | "/auth/password" | "/auth/confirmation-word" | "/auth/recovery-word") {
        return (45_000.0 * timeout_for(RequestKind::Read, tier) as f64 / timeout_for(RequestKind::Read, Tier::Fast) as f64).round() as u32;
    }
    let upload_chunk = method == "PUT" && (bare.starts_with("/uploads/") || bare.starts_with("/e2ee/uploads/"));
    let messages = match path.find("/messages") { None => false, Some(_) => path.match_indices("/messages").any(|(at, text)| { let rest = &path[at + text.len()..]; rest.is_empty() || rest.starts_with('?') }) };
    let kind = if bare == "/uploads" || bare == "/e2ee/files" || upload_chunk { RequestKind::Upload } else if method != "GET" && messages { RequestKind::Send } else { RequestKind::Read };
    timeout_for(kind, tier)
}
