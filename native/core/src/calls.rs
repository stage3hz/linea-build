//! One-to-one calls: the rules both phones follow, so that a call between an iPhone and an Android phone is the
//! same call on each side.
//!
//! Reference: `mobile/src/calls/callModel.ts` (what is sent when, the key emoji, economy voice, the `end` a call
//! leaves, the link's grade and its statistics), `mobile/src/calls/reconnect.ts` (the reconnect state machine,
//! ICE-restart glare, the capability marker), `mobile/src/calls/callStatus.ts` (the status line, the minimised bar),
//! `mobile/src/calls/callLog.ts` (`callServiceText`: the row a finished call leaves in the chat) and
//! `mobile/src/scheduled/model.ts` (`pushKind`). Pinned to the reference by `tests/calls_vectors.rs` (vectors from
//! `tests/generate-calls-vectors.mjs`, which runs the reference itself).
//!
//! Nothing here touches the network or the media: the apps own the peer connection and ask these functions what
//! to do. An SDP is a JavaScript string (UTF-16 code units) and is cut and compared by code units, as the reference
//! does; only the DTLS fingerprints are read as text (a lone surrogate inside one would be replaced — no WebRTC
//! stack writes such a line).
//!
//! Where the reference would throw on a value of the wrong kind (a `null` among the ICE servers), the answer here
//! is the quiet one (`false`); `Date.parse` is the narrower ISO reader of `time.rs`.

use crate::chat_view::format_call_duration;
use crate::json::{self, JsString, Value};
use crate::time::parse_iso_ms;

/// An offer older than this is a missed call, never rings (a call rings for a minute).
pub const OFFER_TTL_MS: f64 = 60_000.0;
/// A call rings for a minute, then ends by itself (both sides).
pub const RING_TIMEOUT_MS: f64 = 60_000.0;
/// Non-trickle ICE: send what was gathered by then.
pub const GATHER_TIMEOUT_MS: f64 = 3_000.0;
/// With a relay configured, the wait goes on up to this long for the relay's own address to arrive.
pub const GATHER_RELAY_MS: f64 = 10_000.0;
/// How long the servers of the last call may be reused when the request for fresh ones fails.
pub const ICE_REUSE_MS: f64 = 4.0 * 60.0 * 60_000.0;
/// How long a call placed offline waits for the connection before it ends with «Нет соединения».
pub const NETWORK_WAIT_MS: f64 = 20_000.0;
pub const NO_CONNECTION_TEXT: &str = "Нет соединения";
/// `disconnected` is often transient: wait this long before restarting ICE.
pub const DISCONNECT_GRACE_MS: f64 = 3_000.0;
/// The side that does not win the tie-break waits a little longer.
pub const POLITE_EXTRA_MS: f64 = 1_500.0;
/// Give up after this long without media.
pub const RECONNECT_WINDOW_MS: f64 = 30_000.0;
pub const RESTART_BACKOFF_MS: [f64; 4] = [0.0, 2_000.0, 4_000.0, 8_000.0];
/// Our own restart offer older than this no longer wins glare.
pub const PENDING_OFFER_STALE_MS: f64 = 8_000.0;
pub const RESTART_ATTRIBUTE: &str = "a=x-invizent-restart:1";
/// Height of the minimised call bar.
pub const CALL_BAR_HEIGHT: f64 = 36.0;

// ---- JavaScript's view of a JSON value, and texts as code units ----

fn is(value: Option<&Value>, word: &str) -> bool { matches!(value, Some(Value::String(text)) if text.0.iter().copied().eq(word.encode_utf16())) }
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => *number != 0.0 && !number.is_nan(),
        Some(Value::String(text)) => !text.0.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}
/// `typeof value === 'number' && Number.isFinite(value) ? value : null`.
fn num(value: Option<&Value>) -> Option<f64> { match value { Some(Value::Number(number)) if number.is_finite() => Some(*number), _ => None } }
fn number_or_null(value: Option<f64>) -> Value { value.map_or(Value::Null, Value::Number) }
fn utf16(text: &str) -> Vec<u16> { text.encode_utf16().collect() }
fn starts(line: &[u16], prefix: &str) -> bool {
    let mut units = line.iter().copied();
    prefix.encode_utf16().all(|wanted| units.next() == Some(wanted))
}
fn starts_units(line: &[u16], prefix: &[u16]) -> bool { line.len() >= prefix.len() && &line[..prefix.len()] == prefix }
fn find(text: &[u16], wanted: &[u16]) -> Option<usize> {
    if wanted.is_empty() { return Some(0) }
    if text.len() < wanted.len() { return None }
    (0..=text.len() - wanted.len()).find(|at| &text[*at..*at + wanted.len()] == wanted)
}
/// `text.split(separator)` for a separator that is not empty.
fn split<'a>(text: &'a [u16], separator: &[u16]) -> Vec<&'a [u16]> {
    let (mut out, mut from) = (Vec::new(), 0);
    while let Some(at) = find(&text[from..], separator) {
        out.push(&text[from..from + at]);
        from += at + separator.len();
    }
    out.push(&text[from..]);
    out
}
fn join(lines: &[Vec<u16>], separator: &[u16]) -> Vec<u16> {
    let mut out = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if index > 0 { out.extend_from_slice(separator) }
        out.extend_from_slice(line);
    }
    out
}
/// What JavaScript's `trim` and `\s` call white space, as a UTF-16 code unit.
fn js_space(unit: u16) -> bool {
    matches!(unit, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
/// Where a regular expression's `^` and `$` (with the `m` flag) see the end of a line.
fn line_end(unit: u16) -> bool { matches!(unit, 0x0a | 0x0d | 0x2028 | 0x2029) }
fn trim(text: &[u16]) -> &[u16] {
    let Some(start) = text.iter().position(|unit| !js_space(*unit)) else { return &[] };
    let end = text.iter().rposition(|unit| !js_space(*unit)).expect("found from the start") + 1;
    &text[start..end]
}
/// `[A-Za-z0-9_]`: a regular expression's `\w`.
fn word_unit(unit: u16) -> bool { matches!(unit, 0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a | 0x5f) }
fn digit(unit: u16) -> bool { (0x30..=0x39).contains(&unit) }
/// Whether `text` at `at` reads `word`, letters of either case (a regular expression's `i` for ASCII).
fn reads_ignoring_case(text: &[u16], at: usize, word: &str) -> bool {
    let mut place = at;
    for wanted in word.encode_utf16() {
        let Some(&unit) = text.get(place) else { return false };
        let lower = |unit: u16| if (0x41..=0x5a).contains(&unit) { unit + 0x20 } else { unit };
        if lower(unit) != lower(wanted) { return false }
        place += 1;
    }
    true
}
/// `Math.round`.
fn js_round(number: f64) -> f64 { if number.fract() == -0.5 { number.ceil() } else { number.round() } }
/// A whole number of seconds or minutes as `String(n)`, and `String(n).padStart(2, '0')`.
fn whole(number: f64) -> String { if number.is_nan() { "NaN".to_string() } else { json::number_text(number) } }
fn two(number: f64) -> String { let text = whole(number); if text.chars().count() < 2 { format!("0{text}") } else { text } }

// ---- What is sent when (callModel.ts) ----

/// Non-trickle ICE: the addresses are sent once, inside the offer / answer. Once gathering is complete, at once;
/// otherwise after 3 s only if the relay's address is already there (or no relay is configured); never later
/// than 10 s.
pub fn gather_done(complete: bool, relay: bool, want_relay: bool, elapsed_ms: f64) -> bool {
    if complete || elapsed_ms >= GATHER_RELAY_MS { return true }
    elapsed_ms >= GATHER_TIMEOUT_MS && (relay || !want_relay)
}

/// Whether an ICE candidate line is the relay's address (`… typ relay …`).
pub fn is_relay_candidate(candidate: Option<&Value>) -> bool {
    let Some(Value::String(text)) = candidate else { return false };
    let (text, wanted) = (&text.0, utf16("typ relay"));
    if text.len() < wanted.len() { return false }
    (0..=text.len() - wanted.len()).any(|at| {
        &text[at..at + wanted.len()] == wanted.as_slice() && (at == 0 || !word_unit(text[at - 1])) && text.get(at + wanted.len()).is_none_or(|unit| !word_unit(*unit))
    })
}

/// Whether the servers the app was given include a relay (TURN).
pub fn has_relay(ice_servers: Option<&Value>) -> bool {
    let Some(Value::Array(servers)) = ice_servers else { return false };
    let turn = |url: &Value| matches!(url, Value::String(text) if reads_ignoring_case(&text.0, 0, "turn:") || reads_ignoring_case(&text.0, 0, "turns:"));
    servers.iter().any(|server| match server.get("urls") { Some(Value::Array(urls)) => urls.iter().any(turn), Some(url) => turn(url), None => false })
}

/// An incoming offer rings only if it is fresh and not one already handled.
pub fn offer_is_fresh(created_at: &str, now_ms: f64, seen: &[String], call_id: &str) -> bool {
    let Some(at) = parse_iso_ms(created_at) else { return false };
    at.is_finite() && now_ms - at <= OFFER_TTL_MS && at - now_ms <= 60_000.0 && !seen.iter().any(|id| id == call_id)
}

/// DTLS fingerprints from an SDP (the keys that protect the media): `algorithm FINGERPRINT`, in the SDP's order.
pub fn sdp_fingerprints(sdp: &[u16]) -> Vec<String> {
    let prefix = utf16("a=fingerprint:");
    let mut out = Vec::new();
    for start in 0..sdp.len() {
        if start > 0 && !line_end(sdp[start - 1]) { continue }
        if !starts_units(&sdp[start..], &prefix) { continue }
        let name_from = start + prefix.len();
        let name_to = name_from + sdp[name_from..].iter().position(|unit| js_space(*unit)).unwrap_or(sdp.len() - name_from);
        if name_to == name_from || sdp.get(name_to) != Some(&0x20) { continue }
        let hex_from = name_to + 1;
        let hex_unit = |unit: u16| digit(unit) || (0x41..=0x46).contains(&unit) || (0x61..=0x66).contains(&unit) || unit == 0x3a;
        let hex_to = hex_from + sdp[hex_from..].iter().position(|unit| !hex_unit(*unit)).unwrap_or(sdp.len() - hex_from);
        if hex_to == hex_from { continue }
        // Only white space may follow on the line.
        let rest_to = hex_to + sdp[hex_to..].iter().position(|unit| line_end(*unit)).unwrap_or(sdp.len() - hex_to);
        if !sdp[hex_to..rest_to].iter().all(|unit| js_space(*unit)) { continue }
        out.push(format!("{} {}", String::from_utf16_lossy(&sdp[name_from..name_to]).to_lowercase(), String::from_utf16_lossy(&sdp[hex_from..hex_to]).to_ascii_uppercase()));
    }
    out
}

/// Canonical text both peers hash: their fingerprints, sorted so the order does not depend on who called.
pub fn key_material(local_sdp: &[u16], remote_sdp: &[u16]) -> Option<String> {
    let (mut all, remote) = (sdp_fingerprints(local_sdp), sdp_fingerprints(remote_sdp));
    if all.is_empty() || remote.is_empty() { return None }
    all.extend(remote);
    // JavaScript's sort compares code units.
    all.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    Some(all.join("|"))
}

const EMOJI: [&str; 64] = ["🐶", "🐱", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐮", "🐷", "🐸", "🐵", "🐔", "🐧", "🐦", "🦉", "🦄", "🐝", "🦋", "🐢", "🐙", "🦀", "🐬", "🐳", "🌵", "🌲", "🌻", "🍄", "🍎", "🍋", "🍉", "🍓", "🍒", "🥑", "🌶", "🍕", "🍩", "🍪", "🎈", "🎁", "⚽", "🏀", "🎸", "🎧", "🚀", "🚗", "⛵", "🏠", "⏰", "💡", "🔑", "🔒", "📎", "✏️", "📚", "💎", "🔥", "⭐", "🌙", "☀️", "🌈", "❄️", "⚡", "🌊"];

/// Four emoji derived from the SHA-256 of both sides' fingerprints; both sides see the same. `None`: an SDP
/// without a fingerprint (no key is shown).
pub fn call_key(local_sdp: &[u16], remote_sdp: &[u16]) -> Option<Vec<&'static str>> {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(key_material(local_sdp, remote_sdp)?.as_bytes());
    // `parseInt(hex.slice(i * 4, i * 4 + 4), 16) % 64`: two bytes of the digest, big-endian.
    Some((0..4).map(|i| EMOJI[(usize::from(digest[i * 2]) << 8 | usize::from(digest[i * 2 + 1])) % EMOJI.len()]).collect())
}

/// `0:07`, `12:30`, `75:00` — the running clock of a call.
pub fn call_clock(ms: f64) -> String {
    let seconds = if ms.is_nan() { f64::NAN } else { (ms / 1000.0).floor().max(0.0) };
    format!("{}:{}", whole((seconds / 60.0).floor()), two(seconds % 60.0))
}

/// What the audio sender is capped at on a measured network speed (bits per second); `None`: no cap.
pub fn send_bitrate(tier: &str) -> Option<f64> { match tier { "slow" => Some(12_000.0), "medium" => Some(24_000.0), _ => None } }

/// Economy voice for slow links (EDGE/3G): our SDP tells the other phone what to send us.
pub fn economy_sdp(sdp: &[u16], tier: &str) -> Vec<u16> {
    if tier == "fast" || sdp.is_empty() { return sdp.to_vec() }
    // /a=rtpmap:(\d+) opus\/48000/i — the first place it reads so, anywhere in the text.
    let payload = (0..sdp.len()).find_map(|at| {
        if !reads_ignoring_case(sdp, at, "a=rtpmap:") { return None }
        let from = at + 9;
        let to = from + sdp[from..].iter().position(|unit| !digit(*unit)).unwrap_or(sdp.len() - from);
        (to > from && reads_ignoring_case(sdp, to, " opus/48000")).then(|| sdp[from..to].to_vec())
    });
    let Some(payload) = payload else { return sdp.to_vec() };
    let payload = String::from_utf16_lossy(&payload);
    let wanted: &[(&str, &str)] = if tier == "slow" { &[("maxaveragebitrate", "12000"), ("maxplaybackrate", "16000"), ("stereo", "0"), ("useinbandfec", "1"), ("usedtx", "1")] }
        else { &[("maxaveragebitrate", "24000"), ("stereo", "0"), ("useinbandfec", "1")] };
    let eol = if find(sdp, &utf16("\r\n")).is_some() { utf16("\r\n") } else { utf16("\n") };
    let mut lines: Vec<Vec<u16>> = split(sdp, &eol).into_iter().map(<[u16]>::to_vec).collect();
    let merge = |existing: &[u16]| -> Vec<u16> {
        let mut params: Vec<(Vec<u16>, Vec<u16>)> = Vec::new();
        let mut set = |key: Vec<u16>, value: Vec<u16>| match params.iter_mut().find(|(name, _)| *name == key) { Some(entry) => entry.1 = value, None => params.push((key, value)) };
        for part in split(existing, &[0x3b]) {
            let part = trim(part);
            if part.is_empty() { continue }
            match part.iter().position(|unit| *unit == 0x3d) { None => set(part.to_vec(), Vec::new()), Some(at) => set(part[..at].to_vec(), part[at + 1..].to_vec()) }
        }
        for (key, value) in wanted { set(utf16(key), utf16(value)) }
        let written: Vec<Vec<u16>> = params.into_iter().map(|(key, value)| if value.is_empty() { key } else { [key, vec![0x3d], value].concat() }).collect();
        join(&written, &[0x3b])
    };
    let fmtp_prefix = format!("a=fmtp:{payload} ");
    match lines.iter().position(|line| starts(line, &fmtp_prefix)) {
        Some(at) => {
            let merged = merge(&lines[at][fmtp_prefix.encode_utf16().count()..]);
            lines[at] = [utf16(&fmtp_prefix), merged].concat();
        }
        None => {
            // `findIndex` answers -1 when the line is spelled in another case: the new line then goes first.
            let after = lines.iter().position(|line| starts(line, &format!("a=rtpmap:{payload} "))).map_or(0, |at| at + 1);
            lines.insert(after, [utf16(&fmtp_prefix), merge(&[])].concat());
        }
    }
    if tier == "slow" {
        // a=ptime belongs to the audio section: at that section's end.
        if let Some(audio) = lines.iter().position(|line| starts(line, "m=audio")) {
            let end = lines.iter().enumerate().position(|(index, line)| index > audio && starts(line, "m="));
            let section_end = end.unwrap_or(lines.len());
            if !lines[audio..section_end].iter().any(|line| starts(line, "a=ptime:")) {
                let back = usize::from(end.is_none() && lines.last().is_some_and(Vec::is_empty));
                lines.insert(section_end - back, utf16("a=ptime:60"));
            }
        }
    }
    join(&lines, &eol)
}

// ---- The `end` a call leaves behind ----

/// Whole seconds since the media connected, never negative and never longer than the week a message may carry.
pub fn call_duration_seconds(started_at: f64, now_ms: f64) -> f64 { (7.0 * 86400.0f64).min(js_round((now_ms - started_at) / 1000.0).max(0.0)) }

/// Every `end` a phone sends: the outcome, whether it was video, whether this phone placed the call and — for an
/// answered call — how long it lasted. `call`: `{id, video, incoming, startedAt}`.
pub fn call_end_meta(call: &Value, reason: &Value, now_ms: f64) -> Value {
    let mut entries = vec![("type", Value::str("call")), ("call", call.get("id").cloned().unwrap_or(Value::Null)), ("step", Value::str("end")), ("reason", reason.clone()),
        ("video", call.get("video").cloned().unwrap_or(Value::Null)), ("caller", Value::Bool(!truthy(call.get("incoming"))))];
    if truthy(call.get("startedAt")) { entries.push(("duration", Value::Number(call_duration_seconds(num(call.get("startedAt")).unwrap_or(f64::NAN), now_ms)))) }
    json::object(entries)
}

/// «Завершить» / «Отклонить» by status: the words on the screen and the reason sent (`None`: nothing was sent
/// yet, so nothing is sent now).
pub fn hangup_outcome(status: &str, incoming: bool) -> (&'static str, Option<&'static str>) {
    match status {
        "incoming" => ("Звонок отклонён", Some("declined")),
        "requesting" => ("Звонок отменён", None),
        "ringing" => ("Звонок отменён", Some("missed")),
        "connecting" => if incoming { ("Звонок отклонён", Some("declined")) } else { ("Звонок отменён", Some("missed")) },
        _ => ("Звонок завершён", Some("hangup")),
    }
}

/// The push the server should send for a message with this meta: a ringing call, nothing for an action, quiet
/// for «без звука». `None`: an ordinary message.
pub fn push_kind(meta: Option<&Value>) -> Option<&'static str> {
    let action = meta.and_then(|meta| meta.get("action")).filter(|action| truthy(Some(action)));
    if let Some(action) = action {
        let call = is(action.get("type"), "call");
        if call && is(action.get("step"), "end") && is(action.get("reason"), "missed") && action.get("caller") == Some(&Value::Bool(true)) { return Some("missed") }
        return Some(if call && is(action.get("step"), "offer") { "call" } else { "none" });
    }
    truthy(meta.and_then(|meta| meta.get("silent"))).then_some("silent")
}

// ---- Following the link while the call goes on ----

fn rank(grade: &str) -> usize { match grade { "bad" => 2, "weak" => 1, _ => 0 } }
const ORDER: [&str; 3] = ["good", "weak", "bad"];

/// One reading of the link → its grade. Unknown numbers count as fine.
pub fn grade_link(rtt_ms: Option<f64>, loss_pct: Option<f64>, jitter_ms: Option<f64>) -> &'static str {
    let (loss, rtt, jitter) = (loss_pct.unwrap_or(0.0), rtt_ms.unwrap_or(0.0), jitter_ms.unwrap_or(0.0));
    if loss >= 10.0 || rtt >= 800.0 || jitter >= 120.0 { return "bad" }
    if loss >= 3.0 || rtt >= 350.0 || jitter >= 50.0 { return "weak" }
    "good"
}

/// The grade the call acts on: worse at once, better only after three calm readings in a row, one step at a time.
pub fn steady_grade(current: &str, reading: &str, calm: f64) -> (&'static str, f64) {
    let (now, read) = (rank(current), rank(reading));
    if read > now { return (ORDER[read], 0.0) }
    if read == now { return (ORDER[now], 0.0) }
    if calm + 1.0 >= 3.0 { (ORDER[now - 1], 0.0) } else { (ORDER[now], calm + 1.0) }
}

/// The cap for the voice: the tighter of what the measured network speed and the live link allow.
pub fn audio_cap(tier: &str, grade: &str) -> Option<f64> {
    let by_grade = match grade { "weak" => Some(24_000.0), "bad" => Some(12_000.0), _ => None };
    match (send_bitrate(tier), by_grade) { (Some(a), Some(b)) => Some(a.min(b)), (a, b) => a.or(b) }
}
/// The cap for the camera picture: it gives way first, the voice last.
pub fn video_cap(grade: &str) -> f64 { match grade { "weak" => 400_000.0, "bad" => 150_000.0, _ => 900_000.0 } }
pub fn link_text(grade: &str) -> &'static str { match grade { "weak" => "слабая связь", "bad" => "плохая связь", _ => "" } }

/// How the call's media travels and how well, from the entries of the connection's statistics. `previous`: the
/// last sample (for the bitrates) or null. Answer: `{link: {route, rttMs, lossPct, jitterMs, kbpsOut, kbpsIn},
/// sample: {at, sent, received}}`.
pub fn call_link(reports: &[Value], previous: Option<&Value>, now_ms: f64) -> Value {
    let all: Vec<&Value> = reports.iter().filter(|report| matches!(report, Value::Object(_) | Value::Array(_))).collect();
    // Like the reference's Map: the last report with an id is the one found by it.
    let by_id = |id: Option<&Value>| -> Option<&Value> {
        let Some(Value::String(id)) = id else { return None };
        all.iter().rev().find(|report| matches!(report.get("id"), Some(Value::String(own)) if own == id)).copied()
    };
    let transport = all.iter().find(|report| is(report.get("type"), "transport") && matches!(report.get("selectedCandidatePairId"), Some(Value::String(_)))).copied();
    let pair = transport.and_then(|transport| by_id(transport.get("selectedCandidatePairId"))).or_else(|| {
        all.iter().find(|report| is(report.get("type"), "candidate-pair")
            && (report.get("selected") == Some(&Value::Bool(true)) || (report.get("nominated") == Some(&Value::Bool(true)) && is(report.get("state"), "succeeded")))).copied()
    });
    let local = pair.and_then(|pair| by_id(pair.get("localCandidateId")));
    let remote = pair.and_then(|pair| by_id(pair.get("remoteCandidateId")));
    let route = pair.map(|_| {
        if is(local.and_then(|local| local.get("candidateType")), "relay") {
            let protocol = local.and_then(|local| local.get("relayProtocol"));
            if is(protocol, "udp") { "relay-udp" } else if is(protocol, "tcp") || is(protocol, "tls") { "relay-tcp" } else { "relay" }
        } else if is(remote.and_then(|remote| remote.get("candidateType")), "relay") { "relay" } else { "direct" }
    });
    let audio_in = all.iter().find(|report| is(report.get("type"), "inbound-rtp") && (is(report.get("kind"), "audio") || is(report.get("mediaType"), "audio"))).copied();
    let (lost, got) = (num(audio_in.and_then(|report| report.get("packetsLost"))), num(audio_in.and_then(|report| report.get("packetsReceived"))));
    let total = |kind: &str, field: &str| -> f64 { all.iter().filter(|report| is(report.get("type"), kind)).fold(0.0, |sum, report| sum + num(report.get(field)).unwrap_or(0.0)) };
    let (sent, received) = (total("outbound-rtp", "bytesSent"), total("inbound-rtp", "bytesReceived"));
    let previous = previous.filter(|previous| truthy(Some(previous)));
    let number = |value: Option<&Value>| match value { Some(Value::Number(number)) => *number, _ => f64::NAN };
    let seconds = previous.map_or(0.0, |previous| (now_ms - number(previous.get("at"))) / 1000.0);
    let rate = |now: f64, before: f64| -> Option<f64> { (previous.is_some() && seconds >= 0.5 && now >= before).then(|| js_round((now - before) * 8.0 / seconds / 1000.0)) };
    let before = |field: &str| -> f64 { match previous.and_then(|previous| previous.get(field)) { None | Some(Value::Null) => 0.0, other => number(other) } };
    let (rtt, jitter) = (num(pair.and_then(|pair| pair.get("currentRoundTripTime"))), num(audio_in.and_then(|report| report.get("jitter"))));
    let loss = match (lost, got) {
        (Some(lost), Some(got)) if lost + got > 0.0 => Some(js_round(lost.max(0.0) / (lost.max(0.0) + got) * 1000.0) / 10.0),
        _ => None,
    };
    json::object(vec![
        ("link", json::object(vec![
            ("route", route.map_or(Value::Null, Value::str)), ("rttMs", number_or_null(rtt.map(|rtt| js_round(rtt * 1000.0)))), ("lossPct", number_or_null(loss)),
            ("jitterMs", number_or_null(jitter.map(|jitter| js_round(jitter * 1000.0)))), ("kbpsOut", number_or_null(rate(sent, before("sent")))), ("kbpsIn", number_or_null(rate(received, before("received")))),
        ])),
        ("sample", json::object(vec![("at", Value::Number(now_ms)), ("sent", Value::Number(sent)), ("received", Value::Number(received))])),
    ])
}

/// The lines of the call's diagnostics. A dash where there is no figure yet.
pub fn call_link_lines(link: &Value, tier: &str) -> Vec<String> {
    let show = |key: &str, unit: &str| match link.get(key) { Some(Value::Number(value)) => format!("{} {unit}", json::number_text(*value)), _ => "—".to_string() };
    let route = match link.get("route") { Some(Value::String(route)) => match route.to_string_lossy().as_str() { "direct" => "напрямую", "relay-udp" => "через сервер (UDP)", "relay-tcp" => "через сервер (TCP)", _ => "через сервер" }, _ => "—" };
    let mode = match tier { "slow" => "экономия (12 кбит/с)", "medium" => "средний (24 кбит/с)", _ => "полное качество" };
    vec![
        format!("Маршрут: {route}"),
        format!("Задержка: {} · потери: {} · дрожание: {}", show("rttMs", "мс"), show("lossPct", "%"), show("jitterMs", "мс")),
        format!("Отправка: {} · приём: {}", show("kbpsOut", "кбит/с"), show("kbpsIn", "кбит/с")),
        format!("Режим звука: {mode}"),
    ]
}

// ---- Automatic reconnection (reconnect.ts) ----

/// The state of the media path: `phase` is "up", "grace", "reconnecting" or "lost".
#[derive(Clone, PartialEq, Debug)]
pub struct Link { pub phase: String, pub trouble_at: Option<f64>, pub attempts: f64, pub next_at: Option<f64> }
impl Link {
    pub fn up() -> Link { Link { phase: "up".to_string(), trouble_at: None, attempts: 0.0, next_at: None } }
    pub fn read(value: &Value) -> Option<Link> {
        let phase = value.get("phase")?.as_str()?;
        if !["up", "grace", "reconnecting", "lost"].contains(&phase.as_str()) { return None }
        let optional = |key: &str| match value.get(key) { Some(Value::Number(number)) => Some(Some(*number)), Some(Value::Null) | None => Some(None), _ => None };
        let Some(Value::Number(attempts)) = value.get("attempts") else { return None };
        Some(Link { phase, trouble_at: optional("troubleAt")?, attempts: *attempts, next_at: optional("nextAt")? })
    }
    pub fn written(&self) -> Value {
        json::object(vec![("phase", Value::str(&self.phase)), ("troubleAt", number_or_null(self.trouble_at)), ("attempts", Value::Number(self.attempts)), ("nextAt", number_or_null(self.next_at))])
    }
}
/// What one input does to the link.
#[derive(Clone, PartialEq, Debug)]
pub struct LinkStep { pub link: Link, pub restart: bool, pub end: bool, pub recovered: bool, pub wake_at: Option<f64> }
pub enum LinkInput<'a> { State(&'a str), Network, Timer }

/// Delay before the next restart attempt: 0, 2 s, 4 s, 8 s, 8 s…
pub fn restart_delay(attempt: f64) -> f64 { RESTART_BACKOFF_MS[attempt.min(3.0).max(0.0) as usize] }

/// The reconnect state machine: up → grace (disconnected) → reconnecting (restart offers with backoff) → up again
/// (connected) or lost (the window ran out). `lost` is final.
pub fn link_next(link: &Link, input: LinkInput, now: f64, grace_ms: f64, window_ms: f64) -> LinkStep {
    let out = |next: Link, restart: bool, end: bool, recovered: bool| -> LinkStep {
        let wake_at = match (next.phase.as_str(), next.trouble_at) { ("up" | "lost", _) | (_, None) => None, (_, Some(trouble)) => Some(next.next_at.unwrap_or(f64::INFINITY).min(trouble + window_ms)) };
        LinkStep { link: next, restart, end, recovered, wake_at }
    };
    if link.phase == "lost" { return out(link.clone(), false, false, false) }
    let attempt = |trouble_at: f64, attempts: f64| out(Link { phase: "reconnecting".to_string(), trouble_at: Some(trouble_at), attempts, next_at: Some(now + restart_delay(attempts)) }, true, false, false);
    match input {
        LinkInput::State(state) => match state {
            "connected" | "completed" => out(Link::up(), false, false, link.phase != "up"),
            "disconnected" => if link.phase != "up" { out(link.clone(), false, false, false) } else { out(Link { phase: "grace".to_string(), trouble_at: Some(now), attempts: 0.0, next_at: Some(now + grace_ms) }, false, false, false) },
            // Already restarting: the next attempt is on its timer.
            "failed" => if link.phase == "reconnecting" { out(link.clone(), false, false, false) } else { attempt(link.trouble_at.unwrap_or(now), 1.0) },
            _ => out(link.clone(), false, false, false),
        },
        // The old path is probably gone: restart at once. While the media still flows, no «Восстановление связи…».
        LinkInput::Network => if link.phase == "up" { out(link.clone(), true, false, false) } else { attempt(link.trouble_at.unwrap_or(now), link.attempts + 1.0) },
        LinkInput::Timer => {
            let Some(trouble_at) = link.trouble_at.filter(|_| link.phase != "up") else { return out(link.clone(), false, false, false) };
            if now >= trouble_at + window_ms { return out(Link { phase: "lost".to_string(), next_at: None, ..link.clone() }, false, true, false) }
            if link.next_at.is_some_and(|next_at| now >= next_at) { return attempt(trouble_at, link.attempts + 1.0) }
            out(link.clone(), false, false, false)
        }
    }
}

/// «Восстановление связи…» on the call screen: from the trouble's start until the media is back.
pub fn link_shows_reconnecting(link: &Link) -> bool { link.phase == "reconnecting" || link.phase == "grace" }

/// What to do with a restart offer from the other side: "answer", "rollback-and-answer", "ignore-glare",
/// "ignore-stale" or "ignore-fingerprint". The caller is «impolite» (keeps its own offer), the callee «polite».
pub fn remote_restart(gen: Option<f64>, last_remote_gen: f64, signaling_state: &str, polite: bool, fingerprints_match: bool, pending_age_ms: Option<f64>) -> &'static str {
    let whole = gen.filter(|gen| gen.is_finite() && gen.fract() == 0.0);
    if !whole.is_some_and(|gen| gen > last_remote_gen) { return "ignore-stale" }
    if !fingerprints_match { return "ignore-fingerprint" }
    if signaling_state == "have-local-offer" { return if polite || pending_age_ms.unwrap_or(0.0) > PENDING_OFFER_STALE_MS { "rollback-and-answer" } else { "ignore-glare" } }
    "answer"
}

/// A restart answer counts only for the offer we are waiting for (the newest one we sent).
pub fn restart_answer_fits(gen: &Value, pending_gen: &Value, signaling_state: &str, fingerprints_match: bool) -> bool {
    !matches!(pending_gen, Value::Null) && gen == pending_gen && signaling_state == "have-local-offer" && fingerprints_match
}

/// The DTLS fingerprints of a restart SDP must be the ones the call was set up (and verified) with.
pub fn same_fingerprints(a: &[u16], b: &[u16]) -> bool {
    let (mut x, mut y) = (sdp_fingerprints(a), sdp_fingerprints(b));
    x.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    y.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    !x.is_empty() && x.len() == y.len() && x.join("|") == y.join("|")
}

/// Capability marker: a client that understands the `restart` steps says so with a session-level SDP attribute.
pub fn mark_restart_capable(sdp: &[u16]) -> Vec<u16> {
    let attribute = utf16(RESTART_ATTRIBUTE);
    if sdp.is_empty() || find(sdp, &attribute).is_some() { return sdp.to_vec() }
    let eol = if find(sdp, &utf16("\r\n")).is_some() { utf16("\r\n") } else { utf16("\n") };
    let mut lines: Vec<Vec<u16>> = split(sdp, &eol).into_iter().map(<[u16]>::to_vec).collect();
    let Some(media) = lines.iter().position(|line| starts(line, "m=")) else { return sdp.to_vec() };
    lines.insert(media, attribute);
    join(&lines, &eol)
}

/// Whether the other side said it understands the `restart` steps.
pub fn restart_capable(sdp: Option<&[u16]>) -> bool {
    let Some(sdp) = sdp.filter(|sdp| !sdp.is_empty()) else { return false };
    let attribute = utf16(RESTART_ATTRIBUTE);
    // split(/\r?\n/)
    let pieces = split(sdp, &[0x0a]);
    let last = pieces.len() - 1;
    pieces.iter().enumerate().any(|(index, piece)| {
        let line = if index < last && piece.last() == Some(&0x0d) { &piece[..piece.len() - 1] } else { piece };
        line == attribute.as_slice()
    })
}

/// The marker is ours, not WebRTC's: removed before the SDP is handed to the connection.
pub fn strip_restart_marker(sdp: &[u16]) -> Vec<u16> {
    let attribute = utf16(RESTART_ATTRIBUTE);
    for start in 0..sdp.len() {
        if start > 0 && !line_end(sdp[start - 1]) { continue }
        if !starts_units(&sdp[start..], &attribute) { continue }
        let after = start + attribute.len();
        // (\r?\n|$)
        let end = if sdp.get(after) == Some(&0x0d) && sdp.get(after + 1) == Some(&0x0a) { after + 2 }
            else if sdp.get(after) == Some(&0x0a) { after + 1 }
            else if sdp.get(after).is_none_or(|unit| line_end(*unit)) { after }
            else { continue };
        return [&sdp[..start], &sdp[end..]].concat();
    }
    sdp.to_vec()
}

// ---- What a call says about itself (callStatus.ts) ----

/// The signalling path: "online", "waiting" («Ожидание сети…») or "connecting" («Соединение…»). `connection`: the
/// live line ("connecting", "connected", "offline"); `online`: what the phone says about its network.
pub fn signal_network(connection: &str, online: Option<bool>) -> &'static str {
    if online == Some(false) { return "waiting" }
    if connection == "connected" { return "online" }
    if online == Some(true) || connection == "connecting" { "connecting" } else { "waiting" }
}
fn network_text(network: &str) -> &'static str { if network == "waiting" { "Ожидание сети…" } else { "Соединение…" } }

/// What the status line needs to know (`CallStatusInput` of the reference).
pub struct StatusInput { pub status: String, pub incoming: bool, pub video: bool, pub reconnecting: bool, pub started_at: Option<f64>, pub ended_text: String, pub network: String, pub now: f64 }
impl StatusInput {
    pub fn read(value: &Value) -> Option<StatusInput> {
        let text = |key: &str| value.get(key).and_then(Value::as_str);
        let Some(Value::Number(now)) = value.get("now") else { return None };
        Some(StatusInput { status: text("status")?, incoming: truthy(value.get("incoming")), video: truthy(value.get("video")), reconnecting: truthy(value.get("reconnecting")),
            started_at: num(value.get("startedAt")).filter(|at| *at != 0.0), ended_text: text("endedText").unwrap_or_default(), network: text("network")?, now: *now })
    }
    fn clock(&self) -> String { call_clock(self.now - self.started_at.unwrap_or(self.now)) }
}

/// The status line under the name.
pub fn call_status_text(input: &StatusInput) -> String {
    match input.status.as_str() {
        "incoming" => if input.video { "Входящий видеозвонок" } else { "Входящий звонок" }.to_string(),
        "ended" => input.ended_text.clone(),
        "requesting" | "ringing" => {
            if input.network != "online" { return network_text(&input.network).to_string() }
            if input.status == "requesting" { "Запрос…" } else { "Вызов…" }.to_string()
        }
        "connecting" => if input.network == "waiting" { "Ожидание сети…" } else { "Соединение…" }.to_string(),
        _ => {
            if !input.reconnecting { return input.clock() }
            if input.network == "waiting" { "Ожидание сети…" } else { "Восстановление связи…" }.to_string()
        }
    }
}

/// The running clock shown next to the status of the minimised bar (a call that is reconnecting keeps its duration).
pub fn call_bar_clock(input: &StatusInput) -> Option<String> { (input.status == "active" && input.reconnecting).then(|| input.clock()) }

/// The bar's colour: "active" (green), "trouble" (orange), "pending" (blue), "ended".
pub fn call_bar_tone(status: &str, reconnecting: bool, network: &str) -> &'static str {
    if status == "ended" { return "ended" }
    if status == "active" { return if reconnecting { "trouble" } else { "active" } }
    if network == "online" { "pending" } else { "trouble" }
}

/// The ring timer ran out: «Нет ответа», or — without the connection — «Нет соединения» with «Повторить».
pub fn ring_expiry(network: &str) -> (&'static str, bool) { if network == "online" { ("Нет ответа", false) } else { (NO_CONNECTION_TEXT, true) } }

/// The text of the system call indicator.
pub fn system_call_text(status: &str, video: bool, reconnecting: bool, network: &str) -> &'static str {
    if status == "active" && !reconnecting { return if video { "Видеозвонок" } else { "Звонок" } }
    if status == "active" { return if network == "waiting" { "Ожидание сети…" } else { "Восстановление связи…" } }
    if network != "online" { return network_text(network) }
    if status == "ringing" { "Вызов…" } else { "Соединение…" }
}

// ---- The row a finished call leaves in the chat (callLog.ts) ----

/// The kind of row this account sees for the call: "outgoing", "incoming", "missed", "cancelled", "declined",
/// "busy" or "failed". `action`: the `end` of the call; `sender_is_me`: whether this account sent it.
pub fn classify_call(action: &Value, sender_is_me: bool) -> &'static str {
    // Older clients send no `caller`; the reason tells then.
    let placed = match action.get("caller") { Some(Value::Bool(caller)) => *caller, _ => !is(action.get("reason"), "declined") && !is(action.get("reason"), "busy") };
    let outgoing = if placed { sender_is_me } else { !sender_is_me };
    let reason = action.get("reason");
    if is(reason, "missed") { if outgoing { "cancelled" } else { "missed" } }
    else if is(reason, "declined") { "declined" }
    else if is(reason, "busy") { if outgoing { "busy" } else { "missed" } }
    else if is(reason, "failed") { "failed" }
    else if outgoing { "outgoing" } else { "incoming" }
}

pub fn call_label(kind: &str, video: bool) -> &'static str {
    match (kind, video) {
        ("outgoing", false) => "Исходящий звонок", ("outgoing", true) => "Исходящий видеозвонок",
        ("incoming", false) => "Входящий звонок", ("incoming", true) => "Входящий видеозвонок",
        ("missed", false) => "Пропущенный звонок", ("missed", true) => "Пропущенный видеозвонок",
        ("cancelled", false) => "Отменённый звонок", ("cancelled", true) => "Отменённый видеозвонок",
        ("declined", false) => "Отклонённый звонок", ("declined", true) => "Отклонённый видеозвонок",
        ("busy", _) => "Собеседник занят",
        (_, false) => "Звонок не удался", (_, true) => "Видеозвонок не удался",
    }
}

/// «Исходящий звонок · 3:12», «Пропущенный звонок» — the centred service row in the chat.
pub fn call_service_text(action: &Value, sender_is_me: bool) -> String {
    let kind = classify_call(action, sender_is_me);
    let label = call_label(kind, truthy(action.get("video")));
    match action.get("duration") {
        Some(duration) if kind == "outgoing" || kind == "incoming" => format!("{label} · {}", format_call_duration(match duration { Value::Number(seconds) => *seconds, _ => f64::NAN })),
        _ => label.to_string(),
    }
}

// ---- By name, for the apps (`invizent_view`) ----

/// The functions above by name; `args` are the JSON arguments. `None`: an unknown name or arguments of the wrong
/// kind.
/// - `callRules []` → the time limits and sizes: `{offerTtlMs, ringTimeoutMs, gatherTimeoutMs, gatherRelayMs,
///   iceReuseMs, networkWaitMs, disconnectGraceMs, politeExtraMs, reconnectWindowMs, barHeight, noConnectionText}`.
/// - `callGatherDone [complete, relay, wantRelay, elapsedMs]` → whether the SDP may be sent now.
/// - `callIsRelayCandidate [candidate]`, `callHasRelay [iceServers]` → bool.
/// - `callOfferFresh [createdAt, nowMs, [seen call ids], callId]` → whether an offer may ring.
/// - `callKey [localSdp, remoteSdp]` → the four emoji, or null.
/// - `callSameFingerprints [a, b]` → bool.
/// - `callEconomySdp [sdp, tier]`, `callMarkRestart [sdp]`, `callStripRestart [sdp]` → the SDP; `callRestartCapable [sdp|null]` → bool.
/// - `callEnd [{id, video, incoming, startedAt}, reason, nowMs]` → the `end` action.
/// - `callHangup [status, incoming]` → `{text, reason|null}`.
/// - `callPushKind [meta|null]` → "call", "missed", "none", "silent" or null.
/// - `callGrade [{rttMs, lossPct, jitterMs}, currentGrade, calm]` → `{reading, grade, calm}`.
/// - `callCaps [tier, grade]` → `{audio|null, video, send|null, text}`.
/// - `callLink [reports, previousSample|null, nowMs]` → `{link, sample}`; `callLinkLines [link, tier]` → the lines.
/// - `callLinkNext [link|null, {kind, state?}, nowMs, incoming]` → `{link, restart, end, recovered, wakeAt, showing}`
///   (null link: up; the callee waits `politeExtraMs` longer before its first restart).
/// - `callRemoteRestart [{gen, lastRemoteGen, signalingState, polite, fingerprintsMatch, pendingAgeMs}]` → the decision.
/// - `callRestartAnswerFits [{gen, pendingGen, signalingState, fingerprintsMatch}]` → bool.
/// - `callSignalNetwork [connection, online|null]` → "online", "waiting", "connecting".
/// - `callStatus [{status, incoming, video, reconnecting, startedAt, endedText, network, now}]` →
///   `{text, clock|null, tone, system}`.
/// - `callRingExpiry [network]` → `{text, retry}`.
/// - `callServiceText [endAction, senderId, userId]` → the chat's row.
pub fn view(name: &str, args: &[Value]) -> Option<Value> {
    let text = |units: Vec<u16>| Value::String(JsString(units));
    let optional_number = |value: &Value| match value { Value::Number(number) => Some(Some(*number)), Value::Null => Some(None), _ => None };
    Some(match (name, args) {
        ("callRules", []) => json::object(vec![
            ("offerTtlMs", Value::Number(OFFER_TTL_MS)), ("ringTimeoutMs", Value::Number(RING_TIMEOUT_MS)), ("gatherTimeoutMs", Value::Number(GATHER_TIMEOUT_MS)),
            ("gatherRelayMs", Value::Number(GATHER_RELAY_MS)), ("iceReuseMs", Value::Number(ICE_REUSE_MS)), ("networkWaitMs", Value::Number(NETWORK_WAIT_MS)),
            ("disconnectGraceMs", Value::Number(DISCONNECT_GRACE_MS)), ("politeExtraMs", Value::Number(POLITE_EXTRA_MS)), ("reconnectWindowMs", Value::Number(RECONNECT_WINDOW_MS)),
            ("barHeight", Value::Number(CALL_BAR_HEIGHT)), ("noConnectionText", Value::str(NO_CONNECTION_TEXT)),
        ]),
        ("callGatherDone", [Value::Bool(complete), Value::Bool(relay), Value::Bool(want_relay), Value::Number(elapsed)]) => Value::Bool(gather_done(*complete, *relay, *want_relay, *elapsed)),
        ("callIsRelayCandidate", [candidate]) => Value::Bool(is_relay_candidate(Some(candidate))),
        ("callHasRelay", [servers]) => Value::Bool(has_relay(Some(servers))),
        ("callOfferFresh", [Value::String(created), Value::Number(now), Value::Array(seen), Value::String(id)]) => {
            let seen: Vec<String> = seen.iter().filter_map(Value::as_str).collect();
            Value::Bool(offer_is_fresh(&created.to_string_lossy(), *now, &seen, &id.to_string_lossy()))
        }
        ("callKey", [Value::String(local), Value::String(remote)]) => call_key(&local.0, &remote.0).map_or(Value::Null, |emoji| Value::Array(emoji.into_iter().map(Value::str).collect())),
        ("callSameFingerprints", [Value::String(a), Value::String(b)]) => Value::Bool(same_fingerprints(&a.0, &b.0)),
        ("callEconomySdp", [Value::String(sdp), Value::String(tier)]) => text(economy_sdp(&sdp.0, &tier.to_string_lossy())),
        ("callMarkRestart", [Value::String(sdp)]) => text(mark_restart_capable(&sdp.0)),
        ("callStripRestart", [Value::String(sdp)]) => text(strip_restart_marker(&sdp.0)),
        ("callRestartCapable", [sdp]) => Value::Bool(restart_capable(match sdp { Value::String(sdp) => Some(&sdp.0), _ => None })),
        ("callEnd", [call @ Value::Object(_), reason @ Value::String(_), Value::Number(now)]) => call_end_meta(call, reason, *now),
        ("callHangup", [Value::String(status), Value::Bool(incoming)]) => {
            let (words, reason) = hangup_outcome(&status.to_string_lossy(), *incoming);
            json::object(vec![("text", Value::str(words)), ("reason", reason.map_or(Value::Null, Value::str))])
        }
        ("callPushKind", [meta]) => push_kind(Some(meta)).map_or(Value::Null, Value::str),
        ("callGrade", [reading @ Value::Object(_), Value::String(current), Value::Number(calm)]) => {
            let read = grade_link(num(reading.get("rttMs")), num(reading.get("lossPct")), num(reading.get("jitterMs")));
            let (grade, calm) = steady_grade(&current.to_string_lossy(), read, *calm);
            json::object(vec![("reading", Value::str(read)), ("grade", Value::str(grade)), ("calm", Value::Number(calm))])
        }
        ("callCaps", [Value::String(tier), Value::String(grade)]) => {
            let (tier, grade) = (tier.to_string_lossy(), grade.to_string_lossy());
            json::object(vec![("audio", number_or_null(audio_cap(&tier, &grade))), ("video", Value::Number(video_cap(&grade))), ("send", number_or_null(send_bitrate(&tier))), ("text", Value::str(link_text(&grade)))])
        }
        ("callLink", [Value::Array(reports), previous, Value::Number(now)]) => call_link(reports, Some(previous), *now),
        ("callLinkLines", [link @ Value::Object(_), Value::String(tier)]) => Value::Array(call_link_lines(link, &tier.to_string_lossy()).iter().map(|line| Value::str(line)).collect()),
        ("callLinkNext", [link, input @ Value::Object(_), Value::Number(now), Value::Bool(incoming)]) => {
            let link = if matches!(link, Value::Null) { Link::up() } else { Link::read(link)? };
            let state = input.get("state").and_then(Value::as_str).unwrap_or_default();
            let input = match input.get("kind")?.as_str()?.as_str() { "state" => LinkInput::State(&state), "network" => LinkInput::Network, "timer" => LinkInput::Timer, _ => return None };
            let step = link_next(&link, input, *now, DISCONNECT_GRACE_MS + if *incoming { POLITE_EXTRA_MS } else { 0.0 }, RECONNECT_WINDOW_MS);
            json::object(vec![("link", step.link.written()), ("restart", Value::Bool(step.restart)), ("end", Value::Bool(step.end)), ("recovered", Value::Bool(step.recovered)),
                ("wakeAt", number_or_null(step.wake_at)), ("showing", Value::Bool(link_shows_reconnecting(&step.link)))])
        }
        ("callRemoteRestart", [input @ Value::Object(_)]) => Value::str(remote_restart(
            match input.get("gen") { Some(Value::Number(gen)) => Some(*gen), _ => None }, num(input.get("lastRemoteGen"))?, &input.get("signalingState")?.as_str()?,
            truthy(input.get("polite")), truthy(input.get("fingerprintsMatch")), optional_number(input.get("pendingAgeMs").unwrap_or(&Value::Null))?)),
        ("callRestartAnswerFits", [input @ Value::Object(_)]) => Value::Bool(restart_answer_fits(
            input.get("gen").unwrap_or(&Value::Null), input.get("pendingGen").unwrap_or(&Value::Null), &input.get("signalingState")?.as_str()?, truthy(input.get("fingerprintsMatch")))),
        ("callSignalNetwork", [Value::String(connection), online]) => {
            let online = match online { Value::Bool(online) => Some(*online), Value::Null => None, _ => return None };
            Value::str(signal_network(&connection.to_string_lossy(), online))
        }
        ("callStatus", [input @ Value::Object(_)]) => {
            let input = StatusInput::read(input)?;
            json::object(vec![("text", Value::str(&call_status_text(&input))), ("clock", call_bar_clock(&input).map_or(Value::Null, |clock| Value::str(&clock))),
                ("tone", Value::str(call_bar_tone(&input.status, input.reconnecting, &input.network))), ("system", Value::str(system_call_text(&input.status, input.video, input.reconnecting, &input.network)))])
        }
        ("callRingExpiry", [Value::String(network)]) => {
            let (words, retry) = ring_expiry(&network.to_string_lossy());
            json::object(vec![("text", Value::str(words)), ("retry", Value::Bool(retry))])
        }
        ("callServiceText", [action @ Value::Object(_), Value::String(sender), Value::String(user)]) => Value::str(&call_service_text(action, sender == user)),
        _ => return None,
    })
}
