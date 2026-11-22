//! Old chats on a new device: the encrypted pages, the transfer and backup keys, and the backup secret as the
//! person sees it (docs/HISTORY-TRANSFER.md).
//!
//! Reference: `mobile/src/e2ee/history.ts`, ported exactly; pinned by `tests/history_vectors.rs`, whose vectors
//! come from running the reference in Node (`tests/generate-history-vectors.mjs`). The messages themselves are
//! exported and imported by the encryption service (`service::history_export` / `history_import`); this is only
//! what wraps them.
//!
//! A page is `{"v":1,"items":[…]}` (with `"last":true` on the last page of a transfer), sealed with AES-256-GCM-SIV
//! (the cipher of attachments) under a 32-byte key and a random 12-byte nonce; the body that is uploaded is
//! base64(nonce ‖ ciphertext+tag). Backup key = HKDF-SHA256(secret, server salt, `linea-backup-v1:key:<account>`);
//! the key check the server keeps is the same with `…:check:…`.

use crate::json::{self, Value};
use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SECRET_BYTES: usize = 20;
pub const BACKUP_QR_PREFIX: &str = "linea-backup:";
pub const OPEN_FAILED: &str = "Не удалось расшифровать копию переписок.";
pub const DAMAGED: &str = "Страница копии повреждена.";
pub const UNKNOWN_FORMAT: &str = "Неизвестный формат копии переписок.";

/// AES-256-GCM-SIV on base64 texts, as the Signal bridge's `seal` / `open` take them.
pub trait PageCipher {
    fn seal(&self, plain: &str, key: &str, nonce: &str, ad: &str) -> Result<String, ()>;
    fn open(&self, cipher: &str, key: &str, nonce: &str, ad: &str) -> Result<String, ()>;
}
/// The cipher of the Signal library linked into the apps.
#[cfg(feature = "signal")]
pub struct LibCipher;
#[cfg(feature = "signal")]
impl PageCipher for LibCipher {
    fn seal(&self, plain: &str, key: &str, nonce: &str, ad: &str) -> Result<String, ()> { crate::signal::seal(plain, key, nonce, ad).map_err(|_| ()) }
    fn open(&self, cipher: &str, key: &str, nonce: &str, ad: &str) -> Result<String, ()> { crate::signal::open(cipher, key, nonce, ad).map_err(|_| ()) }
}

fn key_ok(key: &str) -> bool { key.len() == 44 && key.ends_with('=') && key[..43].bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/') }
fn uuid_ok(text: &str) -> bool {
    text.len() == 36 && text.bytes().enumerate().all(|(index, byte)| if matches!(index, 8 | 13 | 18 | 23) { byte == b'-' } else { byte.is_ascii_hexdigit() })
}
fn random(count: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; count];
    // Without the system's random source there is no safe key: stopping is the only honest answer.
    getrandom::getrandom(&mut bytes).expect("the system's random source");
    bytes
}

pub fn transfer_ad(transfer_id: &str, index: f64) -> String { format!("linea-history-v1:{transfer_id}:{}", json::number_text(index)) }
pub fn backup_ad(user_id: &str, generation: f64) -> String { format!("linea-backup-v1:{user_id}:{}", json::number_text(generation)) }
/// A fresh 32-byte key, base64.
pub fn new_page_key() -> String { B64.encode(random(32)) }

/// Seals one page. `nonce`: only for vectors; the system's random source otherwise.
pub fn seal_page(cipher: &dyn PageCipher, key: &str, ad: &str, items: &[Value], last: bool, nonce: Option<[u8; 12]>) -> Result<String, &'static str> {
    if !key_ok(key) { return Err("Неверный ключ страницы.") }
    let iv = nonce.unwrap_or_else(|| random(12).try_into().expect("12 bytes"));
    let mut fields = vec![("v", Value::Number(1.0)), ("items", Value::Array(items.to_vec()))];
    if last { fields.push(("last", Value::Bool(true))) }
    let plain = json::stringify(&json::object(fields));
    let sealed = cipher.seal(&B64.encode(plain.as_bytes()), key, &B64.encode(iv), &B64.encode(ad.as_bytes())).map_err(|_| "Не удалось зашифровать копию переписок.")?;
    let mut body = iv.to_vec();
    body.extend(B64.decode(sealed).map_err(|_| "Не удалось зашифровать копию переписок.")?);
    Ok(B64.encode(body))
}

/// Opens a page: its items and whether it is the last of a transfer. Anything changed, or under another key or
/// name, is refused.
pub fn open_page(cipher: &dyn PageCipher, key: &str, ad: &str, body: &str) -> Result<(Vec<Value>, bool), &'static str> {
    let bytes = B64.decode(body).map_err(|_| DAMAGED)?;
    if bytes.len() < 12 + 16 || !key_ok(key) { return Err(DAMAGED) }
    let opened = cipher.open(&B64.encode(&bytes[12..]), key, &B64.encode(&bytes[..12]), &B64.encode(ad.as_bytes())).map_err(|_| OPEN_FAILED)?;
    let plain = String::from_utf8(B64.decode(opened).map_err(|_| OPEN_FAILED)?).map_err(|_| OPEN_FAILED)?;
    let value = json::parse(&plain).map_err(|_| UNKNOWN_FORMAT)?;
    let version_ok = matches!(value.get("v"), Some(Value::Number(v)) if *v == 1.0);
    let last = match value.get("last") { None => Some(false), Some(Value::Bool(true)) => Some(true), _ => None };
    match (version_ok, value.get("items"), last) { (true, Some(Value::Array(items)), Some(last)) => Ok((items.clone(), last)), _ => Err(UNKNOWN_FORMAT) }
}

/// What is sealed with Signal for the target device once every page of a transfer is uploaded.
pub fn transfer_note(transfer_id: &str, key: &str, page_count: f64) -> String {
    json::stringify(&json::object(vec![("v", Value::Number(1.0)), ("kind", Value::str("history-transfer")), ("transferId", Value::str(transfer_id)), ("key", Value::str(key)), ("pageCount", Value::Number(page_count))]))
}
/// `(key, pageCount)`, or `None` when the note is not for this transfer.
pub fn parse_transfer_note(text: &str, transfer_id: &str) -> Option<(String, f64)> {
    let value = json::parse(text).ok()?;
    let key = value.get("key").and_then(Value::as_str).filter(|key| key_ok(key))?;
    let pages = match value.get("pageCount") { Some(Value::Number(n)) if n.fract() == 0.0 && (1.0..=1024.0).contains(n) => *n, _ => return None };
    let ok = matches!(value.get("v"), Some(Value::Number(v)) if *v == 1.0) && value.get("kind").and_then(Value::as_str).as_deref() == Some("history-transfer") && value.get("transferId").and_then(Value::as_str).as_deref() == Some(transfer_id);
    ok.then_some((key, pages))
}
/// The backup secret sealed with Signal for another own device.
pub fn secret_note(user_id: &str, generation: f64, secret: &str) -> String {
    json::stringify(&json::object(vec![("v", Value::Number(1.0)), ("kind", Value::str("backup-secret")), ("userId", Value::str(user_id)), ("generation", Value::Number(generation)), ("secret", Value::str(secret))]))
}
/// `(generation, secret)`, or `None`.
pub fn parse_secret_note(text: &str, user_id: &str) -> Option<(f64, String)> {
    let value = json::parse(text).ok()?;
    let secret = value.get("secret").and_then(Value::as_str).and_then(|text| parse_secret(&text))?;
    let generation = match value.get("generation") { Some(Value::Number(n)) if n.fract() == 0.0 && *n >= 1.0 && *n <= 9_007_199_254_740_991.0 => *n, _ => return None };
    let ok = matches!(value.get("v"), Some(Value::Number(v)) if *v == 1.0) && value.get("kind").and_then(Value::as_str).as_deref() == Some("backup-secret") && value.get("userId").and_then(Value::as_str).as_deref() == Some(user_id);
    ok.then_some((generation, secret))
}

// ── The backup secret: 160 random bits in Crockford's base32 and 4 characters of check ──────────────────────────

fn base32(bytes: &[u8]) -> String {
    let (mut out, mut buffer, mut bits) = (String::new(), 0u32, 0u32);
    for byte in bytes {
        buffer = (buffer << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 { out.push(ALPHABET[((buffer >> (bits - 5)) & 31) as usize] as char); bits -= 5 }
        buffer &= (1 << bits) - 1;
    }
    if bits > 0 { out.push(ALPHABET[((buffer << (5 - bits)) & 31) as usize] as char) }
    out
}
fn unbase32(text: &str) -> Option<Vec<u8>> {
    let (mut out, mut buffer, mut bits) = (Vec::new(), 0u32, 0u32);
    for byte in text.bytes() {
        let value = ALPHABET.iter().position(|item| *item == byte)? as u32;
        buffer = (buffer << 5) | value;
        bits += 5;
        if bits >= 8 { out.push(((buffer >> (bits - 8)) & 255) as u8); bits -= 8; buffer &= (1 << bits) - 1 }
    }
    Some(out)
}
fn check_of(data: &str) -> String { base32(&Sha256::digest(format!("linea-backup-secret-v1:{data}").as_bytes())[..3])[..4].to_string() }

/// A new secret from these 20 random bytes: 36 characters, the last 4 are the check.
pub fn backup_secret_from(bytes: &[u8; SECRET_BYTES]) -> String { let data = base32(bytes); let check = check_of(&data); data + &check }
pub fn new_backup_secret() -> String { backup_secret_from(&random(SECRET_BYTES).try_into().expect("20 bytes")) }
/// «ABCD EFGH …» for the screen.
pub fn format_secret(secret: &str) -> String { secret.as_bytes().chunks(4).map(|group| String::from_utf8_lossy(group).into_owned()).collect::<Vec<_>>().join(" ") }
pub fn secret_qr(secret: &str) -> String { format!("{BACKUP_QR_PREFIX}{secret}") }
/// What was typed or read by the camera, as the canonical secret, or `None`. Spaces, dashes and case do not
/// matter; O is read as 0 and I, L as 1.
pub fn parse_secret(input: &str) -> Option<String> {
    if input.encode_utf16().count() > 200 { return None }
    let mut text = input.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if text.len() >= BACKUP_QR_PREFIX.len() && text.is_char_boundary(BACKUP_QR_PREFIX.len()) && text[..BACKUP_QR_PREFIX.len()].eq_ignore_ascii_case(BACKUP_QR_PREFIX) { text = &text[BACKUP_QR_PREFIX.len()..] }
    let canonical: String = text.chars().filter(|c| !c.is_whitespace() && *c != '-').flat_map(char::to_uppercase).map(|c| match c { 'O' => '0', 'I' | 'L' => '1', other => other }).collect();
    if canonical.len() != 36 || !canonical.bytes().all(|byte| ALPHABET.contains(&byte)) { return None }
    let data = &canonical[..32];
    let bytes = unbase32(data)?;
    if bytes.len() != SECRET_BYTES || base32(&bytes) != data { return None }
    (check_of(data) == canonical[32..]).then_some(canonical)
}

fn hkdf(ikm: &[u8], salt: &[u8], info: &[u8]) -> [u8; 32] {
    let mut extract = Hmac::<Sha256>::new_from_slice(salt).expect("HMAC takes a key of any length");
    extract.update(ikm);
    let prk = extract.finalize().into_bytes();
    let mut expand = Hmac::<Sha256>::new_from_slice(&prk).expect("HMAC takes a key of any length");
    expand.update(info);
    expand.update(&[1]);
    expand.finalize().into_bytes().into()
}
/// The backup key and the key check (base64, 32 bytes each) for this account and the server's salt.
pub fn backup_keys(secret: &str, salt: &str, user_id: &str) -> Option<(String, String)> {
    let canonical = parse_secret(secret)?;
    let salt = B64.decode(salt).ok().filter(|salt| salt.len() >= 16)?;
    if !uuid_ok(user_id) { return None }
    let ikm = unbase32(&canonical[..32])?;
    Some((B64.encode(hkdf(&ikm, &salt, format!("linea-backup-v1:key:{user_id}").as_bytes())), B64.encode(hkdf(&ikm, &salt, format!("linea-backup-v1:check:{user_id}").as_bytes()))))
}

/// The names of `invizent_view` that start with `history` (the apps' screens and runners):
/// `historyNewKey []` → key · `historySealPage [key, ad, items, last]` → body · `historyOpenPage [key, ad, body]`
/// → `{items, last}` or `{error}` · `historyTransferAd [id, index]` · `historyBackupAd [userId, generation]` ·
/// `historyTransferNote [id, key, pageCount]` · `historyParseTransferNote [text, id]` → `{key, pageCount}` | null ·
/// `historySecretNote [userId, generation, secret]` · `historyParseSecretNote [text, userId]` → `{generation, secret}`
/// | null · `historyNewSecret []` · `historyFormatSecret [secret]` · `historyParseSecret [text]` → secret | null ·
/// `historySecretQr [secret]` · `historyBackupKeys [secret, salt, userId]` → `{key, keyCheck}` | null ·
/// `historyQr [text]` → rows of `0`/`1` | null. Page sealing needs the Signal library (feature `signal`).
pub fn view(name: &str, args: &[Value]) -> Option<Value> {
    let s = |at: usize| args.get(at).and_then(Value::as_str);
    let n = |at: usize| match args.get(at) { Some(Value::Number(n)) => Some(*n), _ => None };
    let text = |value: String| Value::str(&value);
    Some(match name {
        "historyNewKey" => text(new_page_key()),
        #[cfg(feature = "signal")]
        "historySealPage" => { let Some(Value::Array(items)) = args.get(2) else { return None }; text(seal_page(&LibCipher, &s(0)?, &s(1)?, items, matches!(args.get(3), Some(Value::Bool(true))), None).ok()?) }
        #[cfg(feature = "signal")]
        "historyOpenPage" => match open_page(&LibCipher, &s(0)?, &s(1)?, &s(2)?) {
            Ok((items, last)) => json::object(vec![("items", Value::Array(items)), ("last", Value::Bool(last))]),
            Err(words) => json::object(vec![("error", Value::str(words))]),
        },
        "historyTransferAd" => text(transfer_ad(&s(0)?, n(1)?)),
        "historyBackupAd" => text(backup_ad(&s(0)?, n(1)?)),
        "historyTransferNote" => text(transfer_note(&s(0)?, &s(1)?, n(2)?)),
        "historyParseTransferNote" => parse_transfer_note(&s(0)?, &s(1)?).map_or(Value::Null, |(key, pages)| json::object(vec![("key", Value::str(&key)), ("pageCount", Value::Number(pages))])),
        "historySecretNote" => text(secret_note(&s(0)?, n(1)?, &s(2)?)),
        "historyParseSecretNote" => parse_secret_note(&s(0)?, &s(1)?).map_or(Value::Null, |(generation, secret)| json::object(vec![("generation", Value::Number(generation)), ("secret", Value::str(&secret))])),
        "historyNewSecret" => text(new_backup_secret()),
        "historyFormatSecret" => text(format_secret(&s(0)?)),
        "historyParseSecret" => parse_secret(&s(0)?).map_or(Value::Null, text),
        "historySecretQr" => text(secret_qr(&s(0)?)),
        "historyBackupKeys" => backup_keys(&s(0)?, &s(1)?, &s(2)?).map_or(Value::Null, |(key, check)| json::object(vec![("key", Value::str(&key)), ("keyCheck", Value::str(&check))])),
        "historyQr" => crate::qr::matrix(&s(0)?).map_or(Value::Null, |rows| Value::Array(rows.iter().map(|row| Value::str(&row.iter().map(|dark| if *dark { '1' } else { '0' }).collect::<String>())).collect())),
        _ => return None,
    })
}
