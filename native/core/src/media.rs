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
