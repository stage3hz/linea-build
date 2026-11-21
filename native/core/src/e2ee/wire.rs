//! An encrypted message as it travels: its shape rules, its canonical form, and the codes people compare.
//!
//! Reference: `mobile/src/e2ee/core.ts` — `validEncrypted`, `canonicalEncrypted`, the safety code and the
//! fingerprint of a conversation's devices in `snapshot`.

use crate::json::{self, JsString, Value};
use sha2::{Digest, Sha256};

type Entries = [(JsString, Value)];

fn field<'a>(entries: &'a Entries, key: &str) -> Option<&'a Value> {
    let wanted = JsString::from_str(key);
    entries.iter().find(|(name, _)| *name == wanted).map(|(_, value)| value)
}
fn has_only_keys<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Entries> {
    let Value::Object(entries) = value else { return None };
    entries.iter().all(|(name, _)| keys.iter().any(|key| name.0.iter().copied().eq(key.encode_utf16()))).then_some(entries.as_slice())
}
fn units(value: Option<&Value>) -> Option<&Vec<u16>> { match value { Some(Value::String(text)) => Some(&text.0), _ => None } }
fn is(value: Option<&Value>, word: &str) -> bool { units(value).is_some_and(|text| text.iter().copied().eq(word.encode_utf16())) }
/// `8-4-4-4-12` hex digits, either case.
fn uuid(value: Option<&Value>) -> bool {
    let Some(text) = units(value) else { return false };
    text.len() == 36 && text.iter().enumerate().all(|(index, unit)| if matches!(index, 8 | 13 | 18 | 23) { *unit == b'-' as u16 } else { u8::try_from(*unit).is_ok_and(|byte| byte.is_ascii_hexdigit()) })
}
fn lower(text: &[u16]) -> Vec<u16> { text.iter().map(|unit| if (b'A' as u16..=b'Z' as u16).contains(unit) { unit + 32 } else { *unit }).collect() }
fn all_different(texts: &[Vec<u16>]) -> bool { texts.iter().enumerate().all(|(at, text)| !texts[..at].contains(text)) }

/// The largest ciphertext one device's envelope may carry, bytes.
pub const MAX_BODY_BYTES: usize = 65536;

/// Standard base64 in its one canonical spelling, of at most 64 KiB of bytes and not empty.
fn valid_ciphertext_body(value: Option<&Value>) -> bool {
    let Some(text) = units(value) else { return false };
    if text.is_empty() || text.len() > MAX_BODY_BYTES.div_ceil(3) * 4 || text.len() % 4 != 0 { return false }
    let Ok(bytes): Result<Vec<u8>, _> = text.iter().map(|unit| u8::try_from(*unit)).collect() else { return false };
    let digit = |byte: u8| -> Option<u8> { match byte { b'A'..=b'Z' => Some(byte - b'A'), b'a'..=b'z' => Some(byte - b'a' + 26), b'0'..=b'9' => Some(byte - b'0' + 52), b'+' => Some(62), b'/' => Some(63), _ => None } };
    let groups = bytes.len() / 4;
    for (index, group) in bytes.chunks(4).enumerate() {
        let last = index + 1 == groups;
        let padding = group.iter().rev().take_while(|byte| **byte == b'=').count();
        if padding > 2 || (padding > 0 && !last) { return false }
        let Some(digits): Option<Vec<u8>> = group[..4 - padding].iter().map(|byte| digit(*byte)).collect() else { return false };
        // The canonical spelling leaves the unused low bits of the last digit at zero.
        if (padding == 2 && digits[1] & 0x0f != 0) || (padding == 1 && digits[2] & 0x03 != 0) { return false }
    }
    let padding = bytes.iter().rev().take_while(|byte| **byte == b'=').count();
    bytes.len() / 4 * 3 - padding <= MAX_BODY_BYTES
}

fn valid_envelope(value: &Value) -> bool {
    let Some(entries) = has_only_keys(value, &["userId", "deviceId", "type", "body"]) else { return false };
    uuid(field(entries, "userId")) && uuid(field(entries, "deviceId"))
        && matches!(field(entries, "type"), Some(Value::Number(kind)) if *kind == 2.0 || *kind == 3.0)
        && valid_ciphertext_body(field(entries, "body"))
}

fn valid_attachment_ids(value: &Value) -> bool {
    let Value::Array(ids) = value else { return false };
    if ids.len() > 10 || !ids.iter().all(|id| uuid(Some(id))) { return false }
    all_different(&ids.iter().map(|id| lower(units(Some(id)).expect("checked above"))).collect::<Vec<_>>())
}

/// Whether an encrypted message, as received, is one this app would have made. Anything else — an unknown key,
/// a foreign scheme, a body that is not canonical base64 — is refused before any cryptography is attempted.
pub fn valid_encrypted(value: &Value) -> bool {
    let Some(entries) = has_only_keys(value, &["scheme", "senderDeviceId", "envelopes", "attachmentIds", "lane"]) else { return false };
    if !is(field(entries, "scheme"), "signal-v1") || !uuid(field(entries, "senderDeviceId")) { return false }
    if field(entries, "lane").is_some() && !is(field(entries, "lane"), "scheduled") { return false }
    let Some(Value::Array(envelopes)) = field(entries, "envelopes") else { return false };
    if envelopes.is_empty() || envelopes.len() > 10 || !envelopes.iter().all(valid_envelope) { return false }
    let devices: Vec<Vec<u16>> = envelopes.iter().map(|envelope| lower(units(envelope.get("deviceId")).expect("checked above"))).collect();
    if !all_different(&devices) { return false }
    match field(entries, "attachmentIds") { None | Some(Value::Null) => true, Some(ids) => valid_attachment_ids(ids) }
}

/// The order of the reference's `localeCompare` for the texts it is used on here: ids (`8-4-4-4-12` hex digits)
/// joined by one punctuation mark, so the marks stand at the same places in both texts and never decide.
/// First the letters and digits decide, case aside (digits before letters); between texts that differ only in
/// case, the first difference decides and the small letter comes first. The server issues ids in small letters,
/// so in practice this is plain alphabetical order; the rule for mixed case is checked against the reference.
pub fn id_order(a: &[u16], b: &[u16]) -> std::cmp::Ordering {
    lower(a).cmp(&lower(b)).then_with(|| {
        a.iter().zip(b.iter()).find(|(x, y)| x != y).map(|(x, y)| y.cmp(x)).unwrap_or(std::cmp::Ordering::Equal)
    })
}

fn joined(first: &Value, second: &Value, mark: char) -> Vec<u16> {
    let mut out = units(Some(first)).cloned().unwrap_or_default();
    out.push(mark as u16);
    out.extend(units(Some(second)).cloned().unwrap_or_default());
    out
}

/// The one text an encrypted message is reduced to before it is hashed: whatever order the envelopes and the
/// attachment ids arrived in, and whatever else rode along, the same message gives the same text.
/// The message must have passed `valid_encrypted`.
pub fn canonical_encrypted(value: &Value) -> String {
    let null = Value::Null;
    let get = |key: &str| value.get(key).unwrap_or(&null);
    let mut envelopes: Vec<&Value> = match get("envelopes") { Value::Array(items) => items.iter().collect(), _ => Vec::new() };
    let key = |envelope: &Value| joined(envelope.get("userId").unwrap_or(&null), envelope.get("deviceId").unwrap_or(&null), ':');
    envelopes.sort_by(|a, b| id_order(&key(a), &key(b)));
    let envelopes: Vec<Value> = envelopes.into_iter().map(|item| json::object(vec![
        ("userId", item.get("userId").cloned().unwrap_or(Value::Null)), ("deviceId", item.get("deviceId").cloned().unwrap_or(Value::Null)),
        ("type", item.get("type").cloned().unwrap_or(Value::Null)), ("body", item.get("body").cloned().unwrap_or(Value::Null)),
    ])).collect();
    // The ids are sorted the way a plain JavaScript sort does it: by UTF-16 code units.
    let mut ids: Vec<Value> = match get("attachmentIds") { Value::Array(items) => items.clone(), _ => Vec::new() };
    ids.sort_by(|a, b| units(Some(a)).cmp(&units(Some(b))));
    let mut out = vec![("scheme", get("scheme").clone()), ("senderDeviceId", get("senderDeviceId").clone()), ("envelopes", Value::Array(envelopes)), ("attachmentIds", Value::Array(ids))];
    if units(value.get("lane")).is_some_and(|lane| !lane.is_empty()) { out.push(("lane", get("lane").clone())) }
    json::stringify(&json::object(out))
}

/// SHA-256 of a text's UTF-8 bytes, lower-case hex — the hash the reference is given by its platform.
pub fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The fingerprint of an encrypted message: the hash of its canonical form.
pub fn fingerprint(value: &Value) -> String { sha256_hex(&canonical_encrypted(value)) }

/// One device of a conversation, as far as trust is concerned.
#[derive(Clone, PartialEq, Debug)]
pub struct DeviceIdentity { pub user_id: String, pub device_id: String, pub identity_key: String, pub registration_id: f64 }

impl DeviceIdentity {
    /// `user.device`: the device's address.
    pub fn address(&self) -> String { format!("{}.{}", self.user_id, self.device_id) }
    fn line(&self) -> String { format!("{}:{}:{}", self.address(), self.identity_key, json::number_text(self.registration_id)) }
}

/// The safety code two people compare for one device: the same on both phones, because the pair is sorted
/// before it is hashed. Shown in groups of four.
pub fn safety_code(own: &DeviceIdentity, other: &DeviceIdentity) -> String {
    let mut pair = [own.line(), other.line()];
    // A plain JavaScript sort: by UTF-16 code units.
    pair.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let hash = sha256_hex(&format!("linea-safety-code-v1\u{0}{}\u{0}{}", pair[0], pair[1])).to_uppercase();
    hash.as_bytes().chunks(4).map(|group| std::str::from_utf8(group).expect("hex")).collect::<Vec<_>>().join(" ")
}

/// A conversation's devices in the order the reference keeps them (by address).
pub fn sort_devices(devices: &mut [DeviceIdentity]) {
    devices.sort_by(|a, b| id_order(&a.address().encode_utf16().collect::<Vec<_>>(), &b.address().encode_utf16().collect::<Vec<_>>()));
}

/// The fingerprint of the whole set of devices: it changes when any device is added, removed or re-keyed.
pub fn devices_fingerprint(devices: &[DeviceIdentity]) -> String {
    let rows: Vec<Value> = devices.iter().map(|device| Value::Array(vec![Value::str(&device.user_id), Value::str(&device.device_id), Value::str(&device.identity_key), Value::Number(device.registration_id)])).collect();
    sha256_hex(&json::stringify(&Value::Array(rows)))
}
