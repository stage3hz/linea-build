//! A file attached to an encrypted message: how it is sealed before it is uploaded, how the downloaded bytes are
//! checked and opened, and the object that travels inside the message.
//!
//! Reference: `mobile/src/e2ee/attachments.ts` (`encryptPrepared`, `decryptAttachment`, `associatedData`,
//! `safeName`), `mobile/src/api.ts` (`multipartFile`), `mobile/src/media/formats.ts` (`mediaPreviewKind`) and
//! `mobile/src/theme.tsx` (`formatSize`). Pinned by `tests/e2ee_files.rs`, whose vectors come from running the
//! reference (`tests/generate-file-vectors.mjs`).
//!
//! A file of up to 20 MiB is one AES-256-GCM-SIV block (the Signal library's own, `signal::seal` / `signal::open`)
//! under a key and a nonce made for this file alone; the file's own id is authenticated with it. The key travels
//! only inside the encrypted message. Bigger files use the chunked scheme, which this module only recognises.

use crate::json::{JsString, Value};

/// A small file: at most this many bytes of plaintext.
pub const MAX_FILE: usize = 20 * 1024 * 1024;
/// What the cipher adds to a file.
pub const TAG: usize = 16;
pub const SCHEME: &str = "aes-256-gcm-siv";
pub const SCHEME_CHUNKED: &str = "aes-256-gcm-siv-chunked";

// The words of the reference's refusals.
pub const TOO_BIG_TO_SEND: &str = "Файл слишком большой. Максимум — 20 МБ.";
pub const NO_KEY: &str = "У вложения нет ключа сквозного шифрования.";
pub const TOO_BIG: &str = "Файл превышает допустимый размер.";
pub const NOT_LOADED: &str = "Не удалось загрузить зашифрованный файл.";
pub const CLAIMS_TOO_MUCH: &str = "Размер зашифрованного файла превышает ограничение.";
pub const WRONG_SIZE: &str = "Размер вложения не совпадает с сообщением.";
pub const NOT_AUTHENTIC: &str = "Проверка вложения не пройдена. Файл не будет открыт.";
/// Not in the reference (it opens chunked files): these apps do not open them yet.
pub const CHUNKED_NOT_YET: &str = "Большие файлы пока нельзя открыть в этой версии приложения.";
/// Not in the reference (it passes the library's own error on): the file could not be sealed.
pub const NOT_SEALED: &str = "Не удалось зашифровать файл.";

fn text(units: &[u16]) -> Value { Value::String(JsString(units.to_vec())) }
fn word<'a>(value: &'a Value, key: &str) -> Option<&'a JsString> { match value.get(key) { Some(Value::String(text)) => Some(text), _ => None } }
fn is(value: Option<&JsString>, wanted: &str) -> bool { value.is_some_and(|text| text.0.iter().copied().eq(wanted.encode_utf16())) }

/// What is authenticated together with a file: `linea-attachment-v1:` and the file's key id, in base64.
pub fn associated_data(file_key_id: &str) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(format!("linea-attachment-v1:{file_key_id}"))
}

/// The description of a file's encryption, as it travels inside the message. `key` and `nonce` are base64.
pub fn encryption(key: &str, nonce: &str, file_key_id: &str) -> Value {
    Value::Object(vec![
        (JsString::from_str("scheme"), Value::str(SCHEME)), (JsString::from_str("key"), Value::str(key)),
        (JsString::from_str("nonce"), Value::str(nonce)), (JsString::from_str("fileKeyId"), Value::str(file_key_id)),
    ])
}

/// A random version-4 id from the system's random source, as `crypto.randomUUID()` writes it.
fn random_uuid() -> String {
    let mut bytes = [0u8; 16];
    // Without the system's random source there is no safe key: stopping is the only honest answer.
    getrandom::getrandom(&mut bytes).expect("the system's random source");
    bytes[6] = bytes[6] & 0x0f | 0x40;
    bytes[8] = bytes[8] & 0x3f | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

/// The encryption of a new file: a key, a nonce and a key id nobody has used before.
pub fn fresh_encryption() -> Value {
    use base64::Engine as _;
    let (mut key, mut nonce) = ([0u8; 32], [0u8; 12]);
    let file_key_id = random_uuid();
    getrandom::getrandom(&mut key).expect("the system's random source");
    getrandom::getrandom(&mut nonce).expect("the system's random source");
    let encode = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
    encryption(&encode(&key), &encode(&nonce), &file_key_id)
}

/// The key, the nonce and the associated data of a small file's encryption; `None` when a part is not a text.
#[cfg(feature = "signal")]
fn key_material(encryption: &Value) -> Option<(String, String, String)> {
    let part = |key: &str| word(encryption, key).and_then(JsString::to_str);
    Some((part("key")?, part("nonce")?, associated_data(&part("fileKeyId")?)))
}

/// Seals a file's bytes for upload: the ciphertext with its 16-byte tag.
#[cfg(feature = "signal")]
pub fn seal_file(plain: &[u8], encryption: &Value) -> Result<Vec<u8>, &'static str> {
    use base64::Engine as _;
    if plain.len() > MAX_FILE { return Err(TOO_BIG_TO_SEND) }
    if !is(word(encryption, "scheme"), SCHEME) { return Err(NOT_SEALED) }
    let (key, nonce, ad) = key_material(encryption).ok_or(NOT_SEALED)?;
    let engine = base64::engine::general_purpose::STANDARD;
    let sealed = crate::signal::seal(&engine.encode(plain), &key, &nonce, &ad).map_err(|_| NOT_SEALED)?;
    engine.decode(sealed).map_err(|_| NOT_SEALED)
}

/// What is known before anything is downloaded: whether this attachment can be opened here at all.
pub fn before_download(attachment: &Value) -> Result<(), &'static str> {
    let encryption = attachment.get("encryption");
    if encryption.is_some_and(|encryption| is(word(encryption, "scheme"), SCHEME_CHUNKED)) { return Err(CHUNKED_NOT_YET) }
    if !encryption.is_some_and(|encryption| is(word(encryption, "scheme"), SCHEME)) { return Err(NO_KEY) }
    if matches!(attachment.get("size"), Some(Value::Number(size)) if *size > MAX_FILE as f64) { return Err(TOO_BIG) }
    Ok(())
}

/// What the server's answer says before its body is read: `ok` is a 2xx status, `claimed` the Content-Length.
pub fn before_body(ok: bool, claimed: Option<f64>) -> Result<(), &'static str> {
    if !ok { return Err(NOT_LOADED) }
    if claimed.is_some_and(|claimed| claimed.is_finite() && claimed > (MAX_FILE + TAG) as f64) { return Err(CLAIMS_TOO_MUCH) }
    Ok(())
}

/// How many bytes the server must send for this attachment: the size the message names and the tag.
pub fn cipher_size(attachment: &Value) -> Option<usize> {
    match attachment.get("size") { Some(Value::Number(size)) if size.fract() == 0.0 && *size >= 0.0 && *size <= MAX_FILE as f64 => Some(*size as usize + TAG), _ => None }
}

/// Opens a downloaded file with the key from its message. Nothing is given out unless the size is the one the
/// message names and the cipher's check of every byte passes.
#[cfg(feature = "signal")]
pub fn open_file(cipher: &[u8], attachment: &Value) -> Result<Vec<u8>, &'static str> {
    use base64::Engine as _;
    before_download(attachment)?;
    let named = matches!(attachment.get("size"), Some(Value::Number(size)) if *size + TAG as f64 == cipher.len() as f64);
    if cipher.len() > MAX_FILE + TAG || !named { return Err(WRONG_SIZE) }
    let (key, nonce, ad) = attachment.get("encryption").and_then(key_material).ok_or(NOT_AUTHENTIC)?;
    let engine = base64::engine::general_purpose::STANDARD;
    let opened = crate::signal::open(&engine.encode(cipher), &key, &nonce, &ad).map_err(|_| NOT_AUTHENTIC)?;
    engine.decode(opened).map_err(|_| NOT_AUTHENTIC)
}

/// The attachment of a message, for the encryption service's `encrypt`: `id` is what the server answered to the
/// upload, `size` the number of plaintext bytes that were sealed.
pub fn attachment(id: &str, name: &JsString, mime_type: &JsString, size: usize, encryption: &Value, media: Option<&Value>, preview: Option<&Value>) -> Value {
    let cut = |units: &JsString, most: usize, otherwise: &str| if units.0.is_empty() { Value::str(otherwise) } else { text(&units.0[..units.0.len().min(most)]) };
    let mut out = vec![
        (JsString::from_str("id"), Value::str(id)), (JsString::from_str("name"), cut(name, 240, "file")),
        (JsString::from_str("mimeType"), cut(mime_type, 150, "application/octet-stream")), (JsString::from_str("size"), Value::Number(size as f64)),
        (JsString::from_str("encryption"), encryption.clone()),
    ];
    if let Some(media) = crate::media::wire_media(media) { out.push((JsString::from_str("media"), media)) }
    if let Some(preview) = preview { out.push((JsString::from_str("preview"), preview.clone())) }
    Value::Object(out)
}

/// The body of an upload around the file's bytes: `head`, the bytes, `tail`.
pub struct Multipart { pub head: Vec<u8>, pub tail: Vec<u8>, pub content_type: String }

/// A one-file multipart/form-data body with the given boundary.
pub fn multipart_file(boundary: &str, filename: &JsString, mime_type: &str) -> Multipart {
    let safe: Vec<u16> = filename.0.iter().map(|unit| if matches!(*unit, 0x22 | 0x5c | 0x0d | 0x0a) { b'_' as u16 } else { *unit }).take(200).collect();
    let safe_name = if safe.is_empty() { "file".to_string() } else { String::from_utf16_lossy(&safe) };
    let token = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'+' | b'-'));
    let safe_type = match mime_type.split_once('/') { Some((kind, sub)) if token(kind) && token(sub) => mime_type, _ => "application/octet-stream" };
    Multipart {
        head: format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{safe_name}\"\r\nContent-Type: {safe_type}\r\n\r\n").into_bytes(),
        tail: format!("\r\n--{boundary}--\r\n").into_bytes(),
        content_type: format!("multipart/form-data; boundary={boundary}"),
    }
}

/// The body of `POST /e2ee/files` around a sealed file: one part `file`, named `encrypted.bin`.
pub fn upload_form(boundary: &str) -> Multipart { multipart_file(boundary, &JsString::from_str("encrypted.bin"), "application/octet-stream") }

/// A boundary nobody can guess, in the reference's shape.
pub fn fresh_boundary() -> String {
    let mut bytes = [0u8; 12];
    getrandom::getrandom(&mut bytes).expect("the system's random source");
    format!("----invizent{}", bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>())
}

/// The name a decrypted file is kept under while it is shown: letters, digits, `.`, `_` and `-` only, at most the
/// last hundred, never empty.
pub fn safe_name(name: &JsString) -> String {
    let kept = |unit: u16| matches!(unit, 0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a | 0x410..=0x44f | 0x451 | 0x401 | 0x2e | 0x5f | 0x2d);
    let safe: Vec<u16> = name.0.iter().map(|unit| if kept(*unit) { *unit } else { b'_' as u16 }).collect();
    if safe.is_empty() { return "file".to_string() }
    String::from_utf16_lossy(&safe[safe.len().saturating_sub(100)..])
}

/// A size for the person: «512 Б», «2 КБ», «1.5 МБ», «2.0 ГБ».
pub fn size_text(bytes: u64) -> String {
    const KB: u128 = 1024;
    let bytes_wide = u128::from(bytes);
    // `toFixed` rounds the exact value, halves upwards.
    let tenths = |unit: u128| -> String { let n = (bytes_wide * 20 + unit) / (unit * 2); format!("{}.{}", n / 10, n % 10) };
    if bytes_wide < KB { return format!("{bytes} Б") }
    if bytes_wide < KB * KB { return format!("{} КБ", (bytes_wide * 2 + KB) / (KB * 2)) }
    if bytes_wide >= KB * KB * KB { return format!("{} ГБ", tenths(KB * KB * KB)) }
    format!("{} МБ", tenths(KB * KB))
}

/// How an attachment is shown, judged by its name and declared type alone.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind { Photo, Video, Audio, File }
impl Kind {
    pub fn word(self) -> &'static str { match self { Kind::Photo => "photo", Kind::Video => "video", Kind::Audio => "audio", Kind::File => "file" } }
}

const PHOTO_ENDINGS: &[&str] = &["jpg", "jpeg", "png", "webp", "heic", "heif", "hif", "bmp", "tif", "tiff", "gif", "avif", "dng", "nef", "arw", "cr2", "cr3", "raf", "orf", "rw2", "srw", "pef", "dcr", "raw", "psd", "psb", "svg", "jxl", "jp2", "j2k", "jpf", "jpx", "exr", "hdr", "pic", "tga", "ico", "cur", "pcx", "pnm", "ppm", "pgm", "pbm", "dds", "qoi"];
const VIDEO_ENDINGS: &[&str] = &["mp4", "m4v", "mov", "qt", "3gp", "3g2", "mkv", "webm", "avi", "wmv", "asf", "flv", "f4v", "mpg", "mpeg", "mpe", "m2v", "mts", "m2ts", "ts", "vob", "ogv", "mxf"];
const AUDIO_ENDINGS: &[&str] = &["mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "aif", "aiff", "alac", "amr", "caf", "wma"];

pub fn kind(name: &JsString, mime_type: &JsString) -> Kind {
    let lower = |unit: &u16| if (0x41..=0x5a).contains(unit) { unit + 0x20 } else { *unit };
    let starts = |prefix: &str| mime_type.0.len() >= prefix.len() && mime_type.0.iter().map(lower).zip(prefix.encode_utf16()).all(|(a, b)| a == b);
    let ending: Vec<u16> = match name.0.iter().rposition(|unit| *unit == b'.' as u16) { Some(dot) => name.0[dot + 1..].iter().map(lower).collect(), None => Vec::new() };
    let ends = |list: &[&str]| name.0.contains(&(b'.' as u16)) && list.iter().any(|item| ending.iter().copied().eq(item.encode_utf16()));
    if starts("image/") || ends(PHOTO_ENDINGS) { return Kind::Photo }
    if starts("video/") || ends(VIDEO_ENDINGS) { return Kind::Video }
    if starts("audio/") || ends(AUDIO_ENDINGS) { return Kind::Audio }
    Kind::File
}

// ── Big files: the chunked scheme ────────────────────────────────────────────────────────────────────────────
//
// Reference: `mobile/src/e2ee/attachments.ts` (`chunkNonce`, `chunkAd`, `chunkedCipherSize`, `uploadChunks`,
// `downloadChunked`). A file is cut into chunks of 4 MiB of plaintext; each chunk is one AES-256-GCM-SIV block
// under the file's key, with a nonce of its own (the file's nonce with the chunk's index mixed into its last four
// bytes) and with its place and the number of chunks authenticated — so chunks cannot be reordered, dropped or
// cut off. On the server the chunks stand one after another, each with its 16-byte tag.

/// The plaintext of one chunk; the last chunk of a file may be shorter.
pub const CHUNK_PLAIN: usize = 4 * 1024 * 1024;
pub const WRONG_NONCE: &str = "Неверный nonce вложения.";
pub const FILE_CHANGED: &str = "Файл изменился во время отправки.";
pub const NO_SIZE: &str = "Не удалось определить размер файла.";

/// How many chunks a file of `size` bytes has: at least one.
pub fn chunk_count(size: u64) -> u64 { size.div_ceil(CHUNK_PLAIN as u64).max(1) }
/// How many bytes the server holds for a chunked file of `size` bytes.
pub fn chunked_cipher_size(size: u64) -> u64 { size + chunk_count(size) * TAG as u64 }
/// The plaintext bytes of chunk `index`; `None` when the file has no such chunk.
pub fn chunk_plain_len(size: u64, index: u64) -> Option<usize> {
    if index >= chunk_count(size) { return None }
    Some((size - index * CHUNK_PLAIN as u64).min(CHUNK_PLAIN as u64) as usize)
}
/// Where chunk `index` stands on the server: its first byte and its last one (for a `Range` header).
pub fn chunk_range(size: u64, index: u64) -> Option<(u64, u64)> {
    chunk_plain_len(size, index)?;
    let (full, start) = ((CHUNK_PLAIN + TAG) as u64, index * (CHUNK_PLAIN + TAG) as u64);
    Some((start, chunked_cipher_size(size).min(start + full) - 1))
}
/// The chunk an upload goes on with after the server has `received` bytes.
pub fn chunk_after(received: u64) -> u64 { received / (CHUNK_PLAIN + TAG) as u64 }

/// The nonce of one chunk: the file's nonce with the index mixed into its last four bytes.
pub fn chunk_nonce(base: &str, index: u64) -> Result<String, &'static str> {
    use base64::Engine as _;
    let engine = base64::engine::general_purpose::STANDARD;
    let mut bytes = engine.decode(base).map_err(|_| WRONG_NONCE)?;
    if bytes.len() != 12 { return Err(WRONG_NONCE) }
    let mixed = u32::from_be_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) ^ index as u32;
    bytes[8..].copy_from_slice(&mixed.to_be_bytes());
    Ok(engine.encode(bytes))
}

/// What is authenticated with one chunk: the file's key id, the chunk's place and the number of chunks.
pub fn chunk_ad(file_key_id: &str, index: u64, count: u64) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(format!("linea-attachment-v2:{file_key_id}:{index}:{count}"))
}

/// The description of a chunked file's encryption, as it travels inside the message.
pub fn chunked_encryption(key: &str, nonce: &str, file_key_id: &str) -> Value {
    Value::Object(vec![
        (JsString::from_str("scheme"), Value::str(SCHEME_CHUNKED)), (JsString::from_str("key"), Value::str(key)),
        (JsString::from_str("nonce"), Value::str(nonce)), (JsString::from_str("fileKeyId"), Value::str(file_key_id)),
        (JsString::from_str("chunkSize"), Value::Number(CHUNK_PLAIN as f64)),
    ])
}

/// The encryption of a new big file: a key, a nonce and a key id nobody has used before. An upload that starts
/// again from its first byte takes a new one — different bytes are never sealed under the same key and nonce.
pub fn fresh_chunked_encryption() -> Value {
    let fresh = fresh_encryption();
    let part = |key: &str| word(&fresh, key).and_then(JsString::to_str).unwrap_or_default();
    chunked_encryption(&part("key"), &part("nonce"), &part("fileKeyId"))
}

fn is_chunked(encryption: Option<&Value>) -> bool {
    encryption.is_some_and(|encryption| is(word(encryption, "scheme"), SCHEME_CHUNKED) && matches!(encryption.get("chunkSize"), Some(Value::Number(size)) if *size == CHUNK_PLAIN as f64))
}

/// What is known about a chunked attachment before anything is downloaded: its size in plaintext bytes.
pub fn chunked_size(attachment: &Value) -> Result<u64, &'static str> {
    if !is_chunked(attachment.get("encryption")) { return Err(NO_KEY) }
    match attachment.get("size") {
        Some(Value::Number(size)) if size.fract() == 0.0 && *size >= 0.0 && *size <= crate::e2ee::attachment::MAX_CHUNKED => Ok(*size as u64),
        _ => Err(WRONG_SIZE),
    }
}

/// Seals chunk `index` of a file of `size` bytes: exactly the chunk's bytes go in, the ciphertext with its tag
/// comes out.
#[cfg(feature = "signal")]
pub fn seal_chunk(plain: &[u8], encryption: &Value, index: u64, size: u64) -> Result<Vec<u8>, &'static str> {
    use base64::Engine as _;
    if size == 0 { return Err(NO_SIZE) }
    if !is_chunked(Some(encryption)) { return Err(NOT_SEALED) }
    if chunk_plain_len(size, index) != Some(plain.len()) { return Err(FILE_CHANGED) }
    let part = |key: &str| word(encryption, key).and_then(JsString::to_str).ok_or(NOT_SEALED);
    let (key, nonce, ad) = (part("key")?, chunk_nonce(&part("nonce")?, index)?, chunk_ad(&part("fileKeyId")?, index, chunk_count(size)));
    let engine = base64::engine::general_purpose::STANDARD;
    let sealed = crate::signal::seal(&engine.encode(plain), &key, &nonce, &ad).map_err(|_| NOT_SEALED)?;
    engine.decode(sealed).map_err(|_| NOT_SEALED)
}

/// Opens chunk `index` of a downloaded chunked file with the key from its message. Nothing is given out unless
/// the chunk has the size its place asks for and the cipher's check passes — with this chunk's own nonce, its
/// place and the number of chunks the message's size means.
#[cfg(feature = "signal")]
pub fn open_chunk(cipher: &[u8], attachment: &Value, index: u64) -> Result<Vec<u8>, &'static str> {
    use base64::Engine as _;
    let size = chunked_size(attachment)?;
    let wanted = chunk_plain_len(size, index).ok_or(WRONG_SIZE)?;
    if cipher.len() != wanted + TAG { return Err(WRONG_SIZE) }
    let encryption = attachment.get("encryption").ok_or(NO_KEY)?;
    let part = |key: &str| word(encryption, key).and_then(JsString::to_str).ok_or(NOT_AUTHENTIC);
    let (key, nonce, ad) = (part("key")?, chunk_nonce(&part("nonce")?, index).map_err(|_| NOT_AUTHENTIC)?, chunk_ad(&part("fileKeyId")?, index, chunk_count(size)));
    let engine = base64::engine::general_purpose::STANDARD;
    let opened = crate::signal::open(&engine.encode(cipher), &key, &nonce, &ad).map_err(|_| NOT_AUTHENTIC)?;
    let plain = engine.decode(opened).map_err(|_| NOT_AUTHENTIC)?;
    if plain.len() != wanted { return Err(WRONG_SIZE) }
    Ok(plain)
}
