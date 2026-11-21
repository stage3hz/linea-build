//! The description of a photo, a video or a voice message that rides with an attachment.
//!
//! Reference: `mobile/src/media/previewModel.ts` (`validMedia`, `wireMedia`).

use crate::json::{JsString, Value};

type Entries = [(JsString, Value)];
fn field<'a>(entries: &'a Entries, key: &str) -> Option<&'a Value> {
    let wanted = JsString::from_str(key);
    entries.iter().find(|(name, _)| *name == wanted).map(|(_, value)| value)
}
fn only(entries: &Entries, keys: &[&str]) -> bool {
    entries.iter().all(|(name, _)| keys.iter().any(|key| name.0.iter().copied().eq(key.encode_utf16())))
}
/// A whole number from 1 to `max`.
fn dimension(value: &Value, max: f64) -> bool { matches!(value, Value::Number(n) if n.fract() == 0.0 && *n > 0.0 && *n <= max) }

/// JavaScript's `String(value)` for a value that came from JSON, as UTF-16 code units. The reference tests some
/// fields through it (a regular expression's `test`, `String(...)`), so `["sdr"]` reads as `sdr` there; the same
/// reading is kept here so that both sides agree on every input.
pub fn js_string(value: Option<&Value>) -> Vec<u16> {
    match value {
        None => "undefined".encode_utf16().collect(),
        Some(Value::Null) => "null".encode_utf16().collect(),
        Some(Value::Bool(flag)) => (if *flag { "true" } else { "false" }).encode_utf16().collect(),
        Some(Value::Number(number)) => (if number.is_nan() { "NaN".to_string() } else { crate::json::number_text(*number) }).encode_utf16().collect(),
        Some(Value::String(text)) => text.0.clone(),
        Some(Value::Array(items)) => {
            let mut out = Vec::new();
            for (index, item) in items.iter().enumerate() {
                if index > 0 { out.push(b',' as u16) }
                if !matches!(item, Value::Null) { out.extend(js_string(Some(item))) }
            }
            out
        }
        Some(Value::Object(_)) => "[object Object]".encode_utf16().collect(),
    }
}

/// Loudness bars of a voice message: 8 to 100 letters, each A–Z or a–f.
pub fn waveform_text(units: &[u16]) -> bool {
    (8..=100).contains(&units.len()) && units.iter().all(|unit| (b'A' as u16..=b'Z' as u16).contains(unit) || (b'a' as u16..=b'f' as u16).contains(unit))
}

/// Whether a media description is one this app would have made. `None`: the attachment has none.
pub fn valid_media(value: Option<&Value>) -> bool {
    let Some(value) = value else { return true };
    let Value::Object(entries) = value else { return false };
    if !only(entries, &["width", "height", "durationMs", "hdr", "waveform"]) { return false }
    if field(entries, "width").is_some_and(|width| !dimension(width, 20000.0)) { return false }
    if field(entries, "height").is_some_and(|height| !dimension(height, 20000.0)) { return false }
    if field(entries, "durationMs").is_some_and(|ms| !matches!(ms, Value::Number(n) if n.is_finite() && *n >= 0.0 && *n <= 86_400_000.0)) { return false }
    if field(entries, "waveform").is_some_and(|waveform| !matches!(waveform, Value::String(text) if waveform_text(&text.0))) { return false }
    // 'gainmap' is accepted for forward compatibility; senders do not put it on the wire yet (see `wire_media`).
    match field(entries, "hdr") {
        None => true,
        hdr => { let text = js_string(hdr); ["sdr", "pq", "hlg", "gainmap"].iter().any(|word| text.iter().copied().eq(word.encode_utf16())) }
    }
}

/// The media description as sent inside the encrypted message. Apps up to 0.14.x accept only hdr ∈ {sdr, pq, hlg}
/// and refuse the whole message otherwise, so a gain-map photo is sent without the hdr field: every app shows the
/// JPEG, and HDR screens use its gain map.
pub fn wire_media(media: Option<&Value>) -> Option<Value> {
    let media = media?;
    let Value::Object(entries) = media else { return Some(media.clone()) };
    let gainmap = matches!(field(entries, "hdr"), Some(Value::String(text)) if text.0.iter().copied().eq("gainmap".encode_utf16()));
    if !gainmap { return Some(media.clone()) }
    let hdr = JsString::from_str("hdr");
    Some(Value::Object(entries.iter().filter(|(name, _)| *name != hdr).cloned().collect()))
}

// ── The loudness bars of a voice message ─────────────────────────────────────────────────────────────────────
//
// Reference: `mobile/src/voice/voice.ts` (`encodeWaveform`, `decodeWaveform`, `fitWaveform`, `formatVoiceTime`,
// `formatVoiceTimeFine`, `voiceFileName`, `videoNoteFileName`, `isVoice`, `isVideoNote`). Pinned by
// `tests/e2ee_files.rs` with vectors from running the reference (`tests/generate-chunked-vectors.mjs`).

const WAVE: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";
/// A take's waveform always has this many bars.
pub const WAVEFORM_BARS: usize = 100;
/// The floor of the reference level, as a fraction of full scale: silence stays flat.
const WAVE_FLOOR: f64 = 2500.0 / 32767.0;

/// JavaScript's `Math.round` for a number that is not negative.
fn js_round(value: f64) -> f64 { let floor = value.floor(); if value - floor >= 0.5 { floor + 1.0 } else { floor } }

/// The waveform of a finished take from the recorder's levels (0…1, one about every 100 ms): one letter per bar,
/// 0…31 as `A`–`Z`, `a`–`f`. `None` for fewer than four levels or a take with no sound: no made-up bars.
pub fn encode_waveform(levels: &[f64]) -> Option<String> {
    if levels.len() < 4 { return None }
    if !(levels.iter().copied().fold(f64::NEG_INFINITY, f64::max) > 0.02) { return None }
    let amp: Vec<f64> = levels.iter().map(|level| 10f64.powf((1f64.min(0f64.max(*level)) * 60.0 - 60.0) / 20.0)).collect();
    let mut bins = Vec::with_capacity(WAVEFORM_BARS);
    for bar in 0..WAVEFORM_BARS {
        let from = bar * amp.len() / WAVEFORM_BARS;
        let to = (from + 1).max((bar + 1) * amp.len() / WAVEFORM_BARS);
        let mut value = 0f64;
        for item in amp.iter().take(to).skip(from) { value = value.max(*item) }
        bins.push(value);
    }
    let reference = WAVE_FLOOR.max(bins.iter().fold(0f64, |sum, value| sum + value) / bins.len() as f64 * 1.8);
    Some(bins.iter().map(|value| WAVE[js_round(value.min(reference) / reference * 31.0).clamp(0.0, 31.0) as usize] as char).collect())
}

/// The bars of a received waveform, each 0…1; `None` when it is not a waveform.
pub fn decode_waveform(units: &[u16]) -> Option<Vec<f64>> {
    if !waveform_text(units) { return None }
    Some(units.iter().map(|unit| WAVE.iter().position(|letter| u16::from(*letter) == *unit).unwrap_or(0) as f64 / 31.0).collect())
}

/// Fits bars into `count` bars for the width they are drawn in: the peak of each group.
pub fn fit_waveform(bars: &[f64], count: usize) -> Vec<f64> {
    if count == 0 || bars.len() <= count { return bars.to_vec() }
    (0..count).map(|i| {
        let from = i * bars.len() / count;
        let to = (from + 1).max((i + 1) * bars.len() / count);
        bars[from..to.min(bars.len())].iter().copied().fold(0f64, f64::max)
    }).collect()
}

/// The bars a voice message's row draws: its waveform fitted into at most `count` bars; a message without one
/// (an older app) shows 48 even low bars.
pub fn waveform_bars(waveform: Option<&[u16]>, count: usize) -> Vec<f64> {
    let bars = waveform.and_then(decode_waveform).unwrap_or_else(|| vec![0.12; 48]);
    fit_waveform(&bars, count.max(12))
}

/// «1:05»: minutes and seconds of a length in milliseconds.
pub fn voice_time(ms: f64) -> String {
    let value = if ms.is_finite() { ms } else { 0.0 };
    let total = (value / 1000.0).floor().max(0.0) as u64;
    format!("{}:{:02}", total / 60, total % 60)
}

/// «0:04,63»: the timer of a take being recorded, with hundredths.
pub fn voice_time_fine(ms: f64) -> String {
    let finite = if ms.is_finite() { ms } else { 0.0 };
    let value = finite.max(0.0);
    let total = (value / 1000.0).floor() as u64;
    format!("{}:{:02},{:02}", total / 60, total % 60, ((value % 1000.0) / 10.0).floor() as u64)
}

/// A take shorter than this is not sent.
pub const VOICE_MIN_MS: f64 = 500.0;
/// The longest voice take, and the longest round video.
pub const VOICE_MAX_MS: f64 = 18.0 * 60.0 * 60.0 * 1000.0;
pub const VIDEO_NOTE_MAX_MS: f64 = 60.0 * 1000.0;
pub const VOICE_MIME: &str = "audio/mp4";
pub const VIDEO_NOTE_MIME: &str = "video/mp4";

fn stamp(now_ms: f64) -> String { crate::json::number_text(if now_ms.is_finite() { now_ms.floor().max(0.0) } else { 0.0 }) }
/// The name that makes receivers show an attachment as a voice message: `voice-<ms>.m4a`.
pub fn voice_file_name(now_ms: f64) -> String { format!("voice-{}.m4a", stamp(now_ms)) }
/// The name that makes receivers show an attachment as a round video: `circle-<ms>.mp4`.
pub fn video_note_file_name(now_ms: f64) -> String { format!("circle-{}.mp4", stamp(now_ms)) }

fn named(name: &[u16], before: &str, after: &str) -> bool {
    let (before, after): (Vec<u16>, Vec<u16>) = (before.encode_utf16().collect(), after.encode_utf16().collect());
    if name.len() < before.len() + after.len() + 1 || !name.starts_with(&before) || !name.ends_with(&after) { return false }
    let digits = &name[before.len()..name.len() - after.len()];
    (1..=16).contains(&digits.len()) && digits.iter().all(|unit| (0x30..=0x39).contains(unit))
}
fn mime_is(attachment: &Value, wanted: &str) -> bool { matches!(attachment.get("mimeType"), Some(Value::String(text)) if text.0.iter().copied().eq(wanted.encode_utf16())) }
/// Whether an attachment is a voice message: `audio/mp4` named `voice-<digits>.m4a`.
pub fn is_voice(attachment: &Value) -> bool {
    mime_is(attachment, VOICE_MIME) && matches!(attachment.get("name"), Some(Value::String(name)) if named(&name.0, "voice-", ".m4a"))
}
/// Whether an attachment is a round video message: `video/mp4` named `circle-<digits>.mp4`.
pub fn is_video_note(attachment: &Value) -> bool {
    mime_is(attachment, VIDEO_NOTE_MIME) && matches!(attachment.get("name"), Some(Value::String(name)) if named(&name.0, "circle-", ".mp4"))
}
