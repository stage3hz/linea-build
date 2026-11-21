//! The small picture that rides inside an encrypted message next to an attachment.
//!
//! Reference: `mobile/src/media/previewModel.ts` — `createPreview`, `previewHeader`, `validPreview`.

use super::jpeg::{sanitize_jpeg, Refused};
use super::jpeg_hdr::{announces_gainmap, primary_jpeg};
use crate::json::{JsString, Value};
use base64::Engine as _;

pub const MAX_PREVIEW_BYTES: usize = 8 * 1024;

type Entries = [(JsString, Value)];
fn field<'a>(entries: &'a Entries, key: &str) -> Option<&'a Value> {
    let wanted = JsString::from_str(key);
    entries.iter().find(|(name, _)| *name == wanted).map(|(_, value)| value)
}
fn only(entries: &Entries, keys: &[&str]) -> bool {
    entries.iter().all(|(name, _)| keys.iter().any(|key| name.0.iter().copied().eq(key.encode_utf16())))
}
/// A whole number from 1 to `max`.
fn dimension(value: Option<&Value>, max: f64) -> Option<f64> {
    match value { Some(Value::Number(n)) if n.fract() == 0.0 && *n > 0.0 && *n <= max => Some(*n), _ => None }
}

/// A preview as this app makes it; its `mimeType` is always `image/jpeg`.
pub struct Preview { pub base64: String, pub width: u32, pub height: u32 }

pub fn create_preview(bytes: &[u8]) -> Result<Preview, Refused> {
    // Android 14+ image tools keep the gain map in a derived JPEG; the preview takes only its SDR base.
    let clean = if announces_gainmap(bytes) { sanitize_jpeg(&primary_jpeg(bytes)?)? } else { sanitize_jpeg(bytes)? };
    if clean.bytes.len() > MAX_PREVIEW_BYTES || clean.width > 256 || clean.height > 256 { return Err("the preview is over the allowed size") }
    Ok(Preview { base64: base64::engine::general_purpose::STANDARD.encode(&clean.bytes), width: clean.width, height: clean.height })
}

/// The fields of a well-shaped preview: its base64 text, width and height.
fn preview_header(value: &Value) -> Option<(&[u16], f64, f64)> {
    let Value::Object(entries) = value else { return None };
    if !only(entries, &["mimeType", "base64", "width", "height"]) { return None }
    if !matches!(field(entries, "mimeType"), Some(Value::String(text)) if text.0.iter().copied().eq("image/jpeg".encode_utf16())) { return None }
    let Some(Value::String(base64)) = field(entries, "base64") else { return None };
    if base64.0.len() > MAX_PREVIEW_BYTES.div_ceil(3) * 4 { return None }
    Some((&base64.0, dimension(field(entries, "width"), 256.0)?, dimension(field(entries, "height"), 256.0)?))
}

/// `/^[A-Za-z0-9+/]+={0,2}$/`, giving the text as bytes.
fn base64_text(units: &[u16]) -> Option<Vec<u8>> {
    let text: Vec<u8> = units.iter().map(|unit| u8::try_from(*unit)).collect::<Result<_, _>>().ok()?;
    let digits = text.iter().take_while(|byte| byte.is_ascii_alphanumeric() || **byte == b'+' || **byte == b'/').count();
    (digits > 0 && text.len() - digits <= 2 && text[digits..].iter().all(|byte| *byte == b'=')).then_some(text)
}

/// `toByteArray` of base64-js, for a text `base64_text` has let through: the length must be a multiple of four,
/// and the unused low bits of the last digit are not looked at (so several spellings give the same bytes).
fn to_byte_array(text: &[u8]) -> Option<Vec<u8>> {
    if text.len() % 4 > 0 { return None }
    let digit = |byte: u8| -> u32 { match byte { b'A'..=b'Z' => byte - b'A', b'a'..=b'z' => byte - b'a' + 26, b'0'..=b'9' => byte - b'0' + 52, b'+' => 62, _ => 63 }.into() };
    let valid_len = text.iter().position(|byte| *byte == b'=').unwrap_or(text.len());
    let place_holders = if valid_len == text.len() { 0 } else { 4 - valid_len % 4 };
    let whole = if place_holders > 0 { valid_len.saturating_sub(4).div_ceil(4) * 4 } else { valid_len };
    let mut out = Vec::with_capacity(valid_len * 3 / 4);
    for group in text[..whole].chunks(4) {
        let tmp = digit(group[0]) << 18 | digit(group[1]) << 12 | digit(group[2]) << 6 | digit(group[3]);
        out.extend_from_slice(&[(tmp >> 16) as u8, (tmp >> 8) as u8, tmp as u8]);
    }
    if place_holders == 2 {
        let tmp = digit(text[whole]) << 2 | digit(text[whole + 1]) >> 4;
        out.push(tmp as u8);
    }
    if place_holders == 1 {
        let tmp = digit(text[whole]) << 10 | digit(text[whole + 1]) << 4 | digit(text[whole + 2]) >> 2;
        out.extend_from_slice(&[(tmp >> 8) as u8, tmp as u8]);
    }
    Some(out)
}

/// Whether a preview is one this app would have made: a bounded, cleaned JPEG in its one spelling, with its true
/// size. `None`: the attachment has no preview.
pub fn valid_preview(value: Option<&Value>) -> bool {
    let Some(value) = value else { return true };
    let Some((units, width, height)) = preview_header(value) else { return false };
    let Some(text) = base64_text(units) else { return false };
    let Some(bytes) = to_byte_array(&text) else { return false };
    let Ok(clean) = create_preview(&bytes) else { return false };
    clean.base64.as_bytes() == text && f64::from(clean.width) == width && f64::from(clean.height) == height
}
