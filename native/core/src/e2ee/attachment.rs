//! A file attached to an encrypted message: its shape rules and how its voice waveform travels.
//!
//! Reference: `mobile/src/e2ee/core.ts` — `validAttachment`, `wireBody`, `withWaveform`.

use crate::json::{JsString, Value};
use crate::media::{js_string, valid_media, waveform_text};

type Entries = [(JsString, Value)];
fn field<'a>(entries: &'a Entries, key: &str) -> Option<&'a Value> {
    let wanted = JsString::from_str(key);
    entries.iter().find(|(name, _)| *name == wanted).map(|(_, value)| value)
}
fn has_only_keys<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Entries> {
    let Some(Value::Object(entries)) = value else { return None };
    entries.iter().all(|(name, _)| keys.iter().any(|key| name.0.iter().copied().eq(key.encode_utf16()))).then_some(entries.as_slice())
}
fn word(value: Option<&Value>, text: &str) -> bool { matches!(value, Some(Value::String(units)) if units.0.iter().copied().eq(text.encode_utf16())) }
/// The reference tests these fields with a regular expression, which reads the value as text first.
fn uuid_text(value: Option<&Value>) -> bool {
    let text = js_string(value);
    text.len() == 36 && text.iter().enumerate().all(|(index, unit)| if matches!(index, 8 | 13 | 18 | 23) { *unit == b'-' as u16 } else { u8::try_from(*unit).is_ok_and(|byte| byte.is_ascii_hexdigit()) })
}
fn base64_text(value: Option<&Value>, digits: usize, padded: bool) -> bool {
    let text = js_string(value);
    let digit = |unit: &u16| u8::try_from(*unit).is_ok_and(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/');
    text.len() == digits + usize::from(padded) && text[..digits].iter().all(digit) && (!padded || text[digits] == b'=' as u16)
}

pub const CHUNK_SIZE: f64 = 4.0 * 1024.0 * 1024.0;
/// Small files: one AES-256-GCM-SIV block.
pub const MAX_SMALL: f64 = 20.0 * 1024.0 * 1024.0;
/// Big files: the same cipher per 4 MiB chunk.
pub const MAX_CHUNKED: f64 = 10.0 * 1024.0 * 1024.0 * 1024.0;

/// Whether the attachment of a decrypted message is one this app would have made (`null`: no attachment).
/// `preview_ok` judges the small picture that rides along (a re-check of its JPEG, `media::preview`).
pub fn valid_attachment(value: &Value, preview_ok: &dyn Fn(Option<&Value>) -> bool) -> bool {
    if matches!(value, Value::Null) { return true }
    let Some(entries) = has_only_keys(Some(value), &["id", "name", "mimeType", "size", "encryption", "media", "preview"]) else { return false };
    let encryption = field(entries, "encryption");
    let chunked = matches!(encryption, Some(Value::Object(e)) if word(field(e, "scheme"), "aes-256-gcm-siv-chunked"));
    let keys: &[&str] = if chunked { &["scheme", "key", "nonce", "fileKeyId", "chunkSize"] } else { &["scheme", "key", "nonce", "fileKeyId"] };
    let Some(e) = has_only_keys(encryption, keys) else { return false };
    if chunked && !matches!(field(e, "chunkSize"), Some(Value::Number(size)) if *size == CHUNK_SIZE) { return false }
    let name_ok = matches!(field(entries, "name"), Some(Value::String(name)) if !name.0.is_empty() && name.0.len() <= 240);
    let mime_ok = matches!(field(entries, "mimeType"), Some(Value::String(mime)) if mime.0.len() <= 150);
    let size_ok = matches!(field(entries, "size"), Some(Value::Number(size)) if size.fract() == 0.0 && *size >= 0.0 && *size <= if chunked { MAX_CHUNKED } else { MAX_SMALL });
    uuid_text(field(entries, "id")) && name_ok && mime_ok && size_ok
        && (word(field(e, "scheme"), "aes-256-gcm-siv") || chunked)
        && base64_text(field(e, "key"), 43, true) && base64_text(field(e, "nonce"), 16, false) && uuid_text(field(e, "fileKeyId"))
        && valid_media(field(entries, "media")) && preview_ok(field(entries, "preview"))
}

fn set(entries: &mut Vec<(JsString, Value)>, key: &str, value: Value) {
    let key = JsString::from_str(key);
    match entries.iter_mut().find(|(name, _)| *name == key) { Some(entry) => entry.1 = value, None => entries.push((key, value)) }
}

/// The body as it is encrypted. A voice waveform travels next to the attachment, not inside `attachment.media`:
/// apps before 0.14.5 check the media keys strictly and would refuse the whole message, but ignore unknown
/// top-level keys.
pub fn wire_body(plain: &Value) -> Value {
    let Value::Object(body) = plain else { return plain.clone() };
    let Some(Value::Object(attachment)) = field(body, "attachment") else { return plain.clone() };
    let Some(Value::Object(media)) = field(attachment, "media") else { return plain.clone() };
    let Some(waveform) = field(media, "waveform") else { return plain.clone() };
    let name = JsString::from_str("waveform");
    let rest: Vec<(JsString, Value)> = media.iter().filter(|(key, _)| *key != name).cloned().collect();
    let mut attachment = attachment.clone();
    if rest.is_empty() { let media = JsString::from_str("media"); attachment.retain(|(key, _)| *key != media) } else { set(&mut attachment, "media", Value::Object(rest)) }
    let mut out = body.clone();
    set(&mut out, "attachment", Value::Object(attachment));
    set(&mut out, "voiceWaveform", waveform.clone());
    Value::Object(out)
}

/// The attachment of a received message with the waveform that travelled next to it put back.
pub fn with_waveform(attachment: &Value, waveform: Option<&Value>) -> Value {
    let Value::Object(entries) = attachment else { return attachment.clone() };
    let Some(Value::String(text)) = waveform else { return attachment.clone() };
    if !waveform_text(&text.0) { return attachment.clone() }
    let media = match field(entries, "media") { Some(Value::Object(media)) => media.clone(), _ => Vec::new() };
    if field(&media, "waveform").is_some() { return attachment.clone() }
    let mut media = media;
    set(&mut media, "waveform", Value::String(text.clone()));
    let mut out = entries.to_vec();
    set(&mut out, "media", Value::Object(media));
    Value::Object(out)
}
