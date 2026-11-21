//! Files attached to encrypted messages, against the reference's own code.
//!
//! `vectors/files.json` is what `mobile/src/e2ee/attachments.ts` made (`tests/generate-file-vectors.mjs`): files
//! sealed by the reference with the official Signal library of the desktop app, and what it says about
//! downloaded ones. The other direction is asked live: a file sealed here is handed to the reference's
//! `decryptAttachment` (the same script with `--open`). Cryptography needs `cargo test --features signal`.
use invizent_core::e2ee::files;
use invizent_core::json::{self, JsString};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct Sealed { name: String, file_name: String, mime_type: String, plain: String, id: String, key: String, nonce: String, file_key_id: String, media: Option<String>, preview: Option<String>, boundary: String, content_type: String, body: String, attachment: String }
#[derive(Deserialize)]
#[allow(dead_code)]
struct Opened { name: String, attachment: String, status: u16, claimed: Option<f64>, cipher: String, plain: Option<String>, error: Option<String> }
#[derive(Deserialize)]
struct Name { units: Vec<u16>, safe: String }
#[derive(Deserialize)]
struct Size { bytes: u64, text: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Kind { name: String, mime_type: String, kind: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Multipart { filename: String, mime_type: String, bytes: String, boundary: String, content_type: String, body: String }
#[derive(Deserialize)]
#[allow(dead_code)]
struct Vectors { sealed: Vec<Sealed>, opened: Vec<Opened>, names: Vec<Name>, sizes: Vec<Size>, kinds: Vec<Kind>, multipart: Vec<Multipart> }

fn vectors() -> Vectors { serde_json::from_str(include_str!("vectors/files.json")).expect("vectors") }
fn units(text: &str) -> JsString { JsString::from_str(text) }
fn b64(text: &str) -> Vec<u8> { use base64::Engine as _; base64::engine::general_purpose::STANDARD.decode(text).expect("base64") }

#[test]
fn names_sizes_and_kinds_read_as_in_the_reference() {
    let all = vectors();
    assert!(all.names.len() > 60 && all.sizes.len() > 400 && all.kinds.len() > 600, "{} {} {}", all.names.len(), all.sizes.len(), all.kinds.len());
    let mut wrong = Vec::new();
    for case in &all.names {
        let made = files::safe_name(&JsString(case.units.clone()));
        if made != case.safe { wrong.push(format!("name {:?}: {made:?}, must be {:?}", String::from_utf16_lossy(&case.units), case.safe)) }
    }
    assert!(all.names.iter().any(|case| case.units.len() > 100) && all.names.iter().any(|case| case.units.iter().any(|unit| (0xd800..0xe000).contains(unit))));
    for case in &all.sizes {
        let made = files::size_text(case.bytes);
        if made != case.text { wrong.push(format!("size {}: {made:?}, must be {:?}", case.bytes, case.text)) }
    }
    for case in &all.kinds {
        let made = files::kind(&units(&case.name), &units(&case.mime_type)).word();
        if made != case.kind { wrong.push(format!("kind of {:?} {:?}: {made}, must be {}", case.name, case.mime_type, case.kind)) }
    }
    assert!(wrong.is_empty(), "{} differ, first: {:#?}", wrong.len(), &wrong[..wrong.len().min(8)]);
    for word in ["photo", "video", "audio", "file"] { assert!(all.kinds.iter().any(|case| case.kind == word), "no {word}") }
}

#[test]
fn an_upload_body_is_built_as_in_the_reference() {
    let all = vectors();
    assert!(all.multipart.len() >= 8);
    for case in &all.multipart {
        let form = files::multipart_file(&case.boundary, &units(&case.filename), &case.mime_type);
        assert_eq!(form.content_type, case.content_type, "{:?}", case.filename);
        assert_eq!([form.head, b64(&case.bytes), form.tail].concat(), b64(&case.body), "{:?} {:?}", case.filename, case.mime_type);
    }
    // A boundary of this app's own: the reference's shape, and never the same twice.
    let (one, two) = (files::fresh_boundary(), files::fresh_boundary());
    assert!(one.starts_with("----invizent") && one.len() == 12 + 24 && one[12..].bytes().all(|byte| byte.is_ascii_hexdigit()) && one != two, "{one}");
}

#[test]
fn what_is_known_before_a_download_reads_as_in_the_reference() {
    let all = vectors();
    let mut asked = 0;
    for case in &all.opened {
        let attachment = json::parse(&case.attachment).expect("an attachment");
        // The reference's order: the attachment itself, then the server's answer, then the bytes.
        let early = files::before_download(&attachment).and_then(|_| files::before_body((200..300).contains(&case.status), case.claimed));
        let expected_early = case.error.as_deref().filter(|words| [files::NO_KEY, files::TOO_BIG, files::NOT_LOADED, files::CLAIMS_TOO_MUCH].contains(words));
        assert_eq!(early.err(), expected_early, "{}", case.name);
        asked += 1;
    }
    assert!(asked > 50);
    // The chunked scheme is recognised and not opened yet; a number that is not a size names no length.
    let chunked = json::parse(r#"{"id":"x","size":5,"encryption":{"scheme":"aes-256-gcm-siv-chunked","chunkSize":4194304}}"#).unwrap();
    assert_eq!(files::before_download(&chunked), Err(files::CHUNKED_NOT_YET));
    for (size, expected) in [("0", Some(16)), ("5", Some(21)), ("20971520", Some(20971536)), ("20971521", None), ("-1", None), ("1.5", None), ("\"5\"", None), ("null", None)] {
        assert_eq!(files::cipher_size(&json::parse(&format!(r#"{{"size":{size}}}"#)).unwrap()), expected, "{size}");
    }
}

#[cfg(feature = "signal")]
mod with_the_library {
    use super::*;
    use invizent_core::json::Value;
    use std::io::{BufRead, BufReader, Write};
    use std::path::Path;
    use std::process::{Command, Stdio};

    fn encryption_of(case: &Sealed) -> Value { files::encryption(&case.key, &case.nonce, &case.file_key_id) }
    #[test]
    fn a_file_is_sealed_and_described_exactly_as_the_reference_does() {
        let all = vectors();
        assert!(all.sealed.len() >= 13);
        let preview_ok = |preview: Option<&Value>| invizent_core::photo::valid_preview(preview);
        for case in &all.sealed {
            let (plain, encryption) = (b64(&case.plain), encryption_of(case));
            let sealed = files::seal_file(&plain, &encryption).unwrap_or_else(|words| panic!("{}: {words}", case.name));
            assert_eq!(sealed.len(), plain.len() + files::TAG, "{}", case.name);
            // The whole request: the same bytes the reference posted.
            let form = files::upload_form(&case.boundary);
            assert_eq!(form.content_type, case.content_type, "{}", case.name);
            assert!([form.head, sealed, form.tail].concat() == b64(&case.body), "{}: another request body", case.name);
            // The object inside the message. (A name cut inside a pair holds a lone surrogate serde cannot carry.)
            let expected = json::parse(&case.attachment).expect("an attachment");
            assert!(invizent_core::e2ee::attachment::valid_attachment(&expected, &preview_ok), "{}", case.name);
            if case.name.contains("inside a pair") { continue }
            let (media, preview) = (case.media.as_ref().map(|text| json::parse(text).unwrap()), case.preview.as_ref().map(|text| json::parse(text).unwrap()));
            let made = files::attachment(&case.id, &units(&case.file_name), &units(&case.mime_type), plain.len(), &encryption, media.as_ref(), preview.as_ref());
            assert_eq!(json::stringify(&made), case.attachment, "{}", case.name);
        }
        // The cut inside a pair, with the name as JavaScript holds it.
        let mut name: Vec<u16> = "a".repeat(239).encode_utf16().collect();
        name.extend("😀.txt".encode_utf16());
        let made = files::attachment("x", &JsString(name.clone()), &units(""), 1, &Value::Null, None, None);
        assert!(matches!(made.get("name"), Some(Value::String(cut)) if cut.0 == name[..240]) && made.get("mimeType") == Some(&Value::str("application/octet-stream")));
        assert_eq!(files::attachment("x", &units(""), &units("a/b"), 1, &Value::Null, None, None).get("name"), Some(&Value::str("file")));
    }

    #[test]
    fn a_downloaded_file_is_opened_or_refused_exactly_as_the_reference_does() {
        let all = vectors();
        let (mut opened, mut refused) = (0, std::collections::BTreeSet::new());
        for case in &all.opened {
            let (attachment, cipher) = (json::parse(&case.attachment).expect("an attachment"), b64(&case.cipher));
            let result = files::before_download(&attachment).and_then(|_| files::before_body((200..300).contains(&case.status), case.claimed)).and_then(|_| files::open_file(&cipher, &attachment));
            match (&case.plain, &case.error) {
                (Some(plain), None) => { assert!(result.as_deref() == Ok(b64(plain).as_slice()), "{}: {:?}", case.name, result.err()); opened += 1 }
                (None, Some(words)) => { assert_eq!(result.err(), Some(words.as_str()), "{}", case.name); refused.insert(words.clone()); }
                _ => panic!("a case with no outcome: {}", case.name),
            }
        }
        assert!(opened >= 15 && refused.len() == 6, "{opened} opened, refusals: {refused:?}");
    }

    #[test]
    fn a_file_sealed_here_is_opened_by_the_reference_and_a_changed_one_is_not() {
        let node = std::env::var("INVIZENT_NODE").unwrap_or_else(|_| if Path::new("/opt/node24/bin/node").exists() { "/opt/node24/bin/node".into() } else { "node".into() });
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        assert!(manifest.join("../../desktop/node_modules/@signalapp/libsignal-client").exists(), "desktop/node_modules is not installed: run `npm ci` in desktop/");
        let mut child = Command::new(node).arg(manifest.join("tests/generate-file-vectors.mjs")).arg("--open").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().expect("the reference starts");
        let (mut input, mut output) = (child.stdin.take().unwrap(), BufReader::new(child.stdout.take().unwrap()));
        let mut ask = |attachment: &Value, cipher: &[u8]| -> serde_json::Value {
            use base64::Engine as _;
            let line = serde_json::json!({ "attachment": serde_json::from_str::<serde_json::Value>(&json::stringify(attachment)).unwrap(), "cipher": base64::engine::general_purpose::STANDARD.encode(cipher) });
            writeln!(input, "{line}").unwrap();
            let mut answer = String::new();
            output.read_line(&mut answer).unwrap();
            serde_json::from_str(&answer).expect("the reference answers")
        };
        let mut seed = 0x2545f491u32;
        let mut byte = move || { seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5; seed as u8 };
        let mut keys = std::collections::BTreeSet::new();
        for (index, size) in [1usize, 2, 15, 16, 17, 4095, 4096, 65537, 300_000].into_iter().enumerate() {
            let plain: Vec<u8> = (0..size).map(|_| byte()).collect();
            let encryption = files::fresh_encryption();
            assert!(keys.insert(json::stringify(&encryption)), "the same key twice");
            let sealed = files::seal_file(&plain, &encryption).expect("sealed");
            let id = format!("00000000-0000-4000-8000-{index:012}");
            let attachment = files::attachment(&id, &units("файл.bin"), &units("application/octet-stream"), plain.len(), &encryption, None, None);
            assert!(invizent_core::e2ee::attachment::valid_attachment(&attachment, &|preview| preview.is_none()), "{size}");
            use base64::Engine as _;
            assert_eq!(ask(&attachment, &sealed)["plain"], serde_json::json!(base64::engine::general_purpose::STANDARD.encode(&plain)), "{size} bytes");
            assert_eq!(files::open_file(&sealed, &attachment).as_deref(), Ok(plain.as_slice()));
            // One changed bit: both sides refuse, in the same words.
            let mut changed = sealed.clone();
            changed[size / 2] ^= 0x10;
            assert_eq!(ask(&attachment, &changed)["error"], serde_json::json!(files::NOT_AUTHENTIC));
            assert_eq!(files::open_file(&changed, &attachment), Err(files::NOT_AUTHENTIC));
            assert_eq!(ask(&attachment, &sealed[..sealed.len() - 1])["error"], serde_json::json!(files::WRONG_SIZE));
            assert_eq!(files::open_file(&sealed[..sealed.len() - 1], &attachment), Err(files::WRONG_SIZE));
        }
        drop(input);
        let _ = child.wait();
        // More than a small file is never sealed.
        assert_eq!(files::seal_file(&vec![0u8; files::MAX_FILE + 1], &files::fresh_encryption()), Err(files::TOO_BIG_TO_SEND));
    }

    // ── The same through the C functions, the way the apps call them ─────────────────────────────────────────
    use invizent_core::ffi::*;
    use std::ffi::{CStr, CString};

    unsafe fn text(pointer: *mut std::ffi::c_char) -> Option<String> {
        if pointer.is_null() { return None }
        let out = CStr::from_ptr(pointer).to_str().unwrap().to_string();
        invizent_string_free(pointer);
        Some(out)
    }
    unsafe fn call(name: &str, args: &str) -> Option<String> {
        let (name, args) = (CString::new(name).unwrap(), CString::new(args).unwrap());
        text(invizent_file_call(name.as_ptr(), args.as_ptr()))
    }
    /// The bytes of an answer, given back to the core.
    unsafe fn taken(bytes: InvizentBytes) -> Vec<u8> {
        let out = if bytes.data.is_null() { Vec::new() } else { std::slice::from_raw_parts(bytes.data, bytes.len).to_vec() };
        invizent_file_bytes_free(bytes);
        out
    }

    #[test]
    fn files_cross_the_boundary() {
        unsafe {
            let empty = || InvizentBytes { data: std::ptr::null_mut(), len: 0 };
            let encryption = call("newEncryption", "[]").expect("an encryption");
            assert_ne!(Some(&encryption), call("newEncryption", "[]").as_ref());
            let plain: Vec<u8> = (0..70_000u32).map(|n| (n * 31 % 251) as u8).collect();
            let key = CString::new(encryption.clone()).unwrap();
            let mut sealed = empty();
            assert!(invizent_file_seal(plain.as_ptr(), plain.len(), key.as_ptr(), &mut sealed).is_null());
            let cipher = taken(sealed);
            assert_eq!(cipher.len(), plain.len() + 16);
            assert!(!cipher.windows(32).any(|window| plain.windows(32).next() == Some(window)));

            let form = call("uploadForm", "[]").expect("a form");
            let form: serde_json::Value = serde_json::from_str(&form).unwrap();
            let boundary = form["contentType"].as_str().unwrap().strip_prefix("multipart/form-data; boundary=").expect("a boundary").to_string();
            assert_eq!(form["head"], serde_json::json!(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"encrypted.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n")));
            assert_eq!(form["tail"], serde_json::json!(format!("\r\n--{boundary}--\r\n")));

            let preview = call("preview", &serde_json::json!([vectors().sealed.iter().find_map(|case| case.preview.clone()).map(|text| serde_json::from_str::<serde_json::Value>(&text).unwrap()["base64"].clone()).unwrap()]).to_string()).expect("a preview");
            let attachment = call("attachment", &format!(r#"["0f8fad5b-d9cb-469f-a165-70867728950e","photo.png","image/png",{},{encryption},{{"width":640,"height":480,"hdr":"sdr"}},{preview}]"#, plain.len())).expect("an attachment");
            let parsed = json::parse(&attachment).unwrap();
            assert!(invizent_core::e2ee::attachment::valid_attachment(&parsed, &|preview| invizent_core::photo::valid_preview(preview)));
            assert_eq!(call("describe", &format!("[{attachment}]")).as_deref(), Some(r#"{"kind":"photo","fileName":"photo.png","sizeText":"68 КБ","cipherSize":70016,"refusal":null}"#));

            let message = CString::new(attachment.clone()).unwrap();
            let mut opened = empty();
            assert!(invizent_file_open(cipher.as_ptr(), cipher.len(), message.as_ptr(), &mut opened).is_null());
            assert!(taken(opened) == plain);
            // A changed byte, a cut file, a missing key: words, and no bytes.
            let mut changed = cipher.clone();
            changed[1000] ^= 1;
            let mut out = empty();
            assert_eq!(text(invizent_file_open(changed.as_ptr(), changed.len(), message.as_ptr(), &mut out)).as_deref(), Some(files::NOT_AUTHENTIC));
            assert!(out.data.is_null() && out.len == 0);
            assert_eq!(text(invizent_file_open(cipher.as_ptr(), cipher.len() - 1, message.as_ptr(), &mut out)).as_deref(), Some(files::WRONG_SIZE));
            assert_eq!(text(invizent_file_open(std::ptr::null(), 0, message.as_ptr(), &mut out)).as_deref(), Some(files::WRONG_SIZE));
            let bare = CString::new(r#"{"id":"x","size":70000}"#).unwrap();
            assert_eq!(text(invizent_file_open(cipher.as_ptr(), cipher.len(), bare.as_ptr(), &mut out)).as_deref(), Some(files::NO_KEY));
            assert_eq!(text(invizent_file_open(cipher.as_ptr(), cipher.len(), std::ptr::null(), &mut out)).as_deref(), Some(files::NO_KEY));
            assert!(text(invizent_file_seal(plain.as_ptr(), plain.len(), std::ptr::null(), &mut out)).is_some() && out.data.is_null());
            assert!(text(invizent_file_seal(plain.as_ptr(), plain.len(), key.as_ptr(), std::ptr::null_mut())).is_some());
            invizent_file_bytes_free(empty());

            // What is not an attachment gets no answer.
            assert!(call("attachment", &format!(r#"["not an id","a","b",5,{encryption},null,null]"#)).is_none());
            assert!(call("attachment", &format!(r#"["0f8fad5b-d9cb-469f-a165-70867728950e","a","b",20971521,{encryption},null,null]"#)).is_none());
            assert!(call("attachment", &format!(r#"["0f8fad5b-d9cb-469f-a165-70867728950e","a","b",5,{encryption},null,{{"mimeType":"image/jpeg","base64":"AAAA","width":1,"height":1}}]"#)).is_none());
            assert!(call("preview", r#"["AAAA"]"#).is_none());
            assert_eq!(call("describe", r#"[{"name":"big.mkv","mimeType":"video/x-matroska","size":3221225472,"encryption":{"scheme":"aes-256-gcm-siv-chunked"}}]"#).as_deref(),
                Some(format!(r#"{{"kind":"video","fileName":"big.mkv","sizeText":"3.0 ГБ","cipherSize":null,"refusal":"{}"}}"#, files::CHUNKED_NOT_YET).as_str()));
            assert_eq!(call("received", "[200,70016]").as_deref(), Some("null"));
            assert_eq!(call("received", "[200,null]").as_deref(), Some("null"));
            assert_eq!(call("received", "[404,null]"), Some(format!("\"{}\"", files::NOT_LOADED)));
            assert_eq!(call("received", "[200,20971537]"), Some(format!("\"{}\"", files::CLAIMS_TOO_MUCH)));
            assert_eq!(call("sizeText", "[1572864]").as_deref(), Some("\"1.5 МБ\""));
            for (name, args) in [("nothing", "[]"), ("sizeText", "[-1]"), ("sizeText", "[\"1\"]"), ("describe", "[5]"), ("newEncryption", "[1]"), ("attachment", "[]"), ("preview", "[5]"), ("sizeText", "{")] { assert!(call(name, args).is_none(), "{name} {args}") }
            assert!(invizent_file_call(std::ptr::null(), std::ptr::null()).is_null());

            // A photo as a JPEG: the gate keeps the picture and drops everything private.
            let private = b"GPS:51.0,0.1; camera serial SECRET";
            let preview_bytes = b64(serde_json::from_str::<serde_json::Value>(&preview).unwrap()["base64"].as_str().unwrap());
            let mut with_exif = preview_bytes[..2].to_vec();
            with_exif.extend([0xff, 0xe1, 0, (private.len() + 2) as u8]);
            with_exif.extend(private);
            with_exif.extend(&preview_bytes[2..]);
            let mut clean = empty();
            assert!(invizent_file_clean_jpeg(with_exif.as_ptr(), with_exif.len(), &mut clean).is_null());
            let clean = taken(clean);
            assert!(clean == preview_bytes && !clean.windows(private.len()).any(|window| window == private));
            assert!(text(invizent_file_clean_jpeg(plain.as_ptr(), plain.len(), &mut out)).is_some() && out.data.is_null());
        }
    }
}

// ── Big files (the chunked scheme), voice messages and round videos ──────────────────────────────────────────
//
// `vectors/chunked.json` is what the reference made (`tests/generate-chunked-vectors.mjs`): the small functions of
// the scheme, whole files uploaded by `encryptAndUploadLarge` (known by the SHA-256 of what the server holds; the
// plaintext is a pattern both sides make), what it says about tampered downloads, and voice waveforms.
mod big {
    use invizent_core::e2ee::files;
    use invizent_core::json::{self, JsString, Value};
    use invizent_core::media;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Nonce { base: String, index: u64, nonce: String }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Ad { file_key_id: String, index: u64, count: u64, ad: String }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Size { size: u64, cipher_size: u64 }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    #[allow(dead_code)]
    pub struct File { pub size: u64, pub start: u8, pub attachment: String, pub cipher_sha256: String, pub tags: Vec<String> }
    #[derive(Deserialize)]
    #[allow(dead_code)]
    pub struct Refused { pub name: String, pub error: String }
    #[derive(Deserialize)]
    struct Waveform { levels: String, waveform: Option<String> }
    #[derive(Deserialize)]
    struct Bars { waveform: Option<String>, count: usize, bars: Vec<f64> }
    #[derive(Deserialize)]
    struct Time { ms: f64, time: String, fine: String }
    #[derive(Deserialize)]
    struct Name { now: f64, voice: String, note: String }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Kind { name: String, mime_type: String, voice: bool, note: bool }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Rules { voice_mime: String, voice_min_ms: f64, voice_max_ms: f64, note_max_ms: f64, bars: usize, chunk: usize, large: usize }
    #[derive(Deserialize)]
    #[allow(dead_code)]
    pub struct Vectors { nonces: Vec<Nonce>, ads: Vec<Ad>, sizes: Vec<Size>, pub files: Vec<File>, pub refused: Vec<Refused>, waveforms: Vec<Waveform>, bars: Vec<Bars>, times: Vec<Time>, names: Vec<Name>, kinds: Vec<Kind>, rules: Rules }
    pub fn vectors() -> Vectors { serde_json::from_str(include_str!("vectors/chunked.json")).expect("vectors") }

    /// The plaintext of a test file, as the generator makes it.
    pub fn pattern(size: u64, start: u8) -> Vec<u8> { (0..size).map(|i| (i.wrapping_mul(31).wrapping_add((i >> 8).wrapping_mul(17)).wrapping_add(u64::from(start)) & 0xff) as u8).collect() }

    #[test]
    fn chunks_are_counted_placed_and_named_as_in_the_reference() {
        let all = vectors();
        assert!(all.nonces.len() >= 40 && all.ads.len() >= 5 && all.sizes.len() >= 70);
        assert_eq!((all.rules.chunk, all.rules.large), (files::CHUNK_PLAIN, files::MAX_FILE));
        for case in &all.nonces { assert_eq!(files::chunk_nonce(&case.base, case.index).as_deref(), Ok(case.nonce.as_str()), "{} {}", case.base, case.index) }
        assert!(all.nonces.iter().any(|case| case.index > u64::from(u32::MAX >> 1)) && all.nonces.iter().any(|case| case.index != 0 && case.nonce != case.base));
        for bad in ["", "AAAA", "AAAAAAAAAAAAAAAAAAAA", "not base64 at all"] { assert_eq!(files::chunk_nonce(bad, 1), Err(files::WRONG_NONCE), "{bad}") }
        for case in &all.ads { assert_eq!(files::chunk_ad(&case.file_key_id, case.index, case.count), case.ad) }
        for case in &all.sizes {
            assert_eq!(files::chunked_cipher_size(case.size), case.cipher_size, "{}", case.size);
            // The chunks stand one after another and cover the whole file, each with its tag.
            let count = files::chunk_count(case.size);
            let (mut plain, mut at) = (0u64, 0u64);
            for index in [0, 1, count / 2, count.saturating_sub(2), count - 1] {
                let (start, end) = files::chunk_range(case.size, index).expect("a chunk");
                assert_eq!(start, index * (files::CHUNK_PLAIN + files::TAG) as u64);
                assert_eq!(end + 1 - start, (files::chunk_plain_len(case.size, index).unwrap() + files::TAG) as u64);
                assert_eq!(files::chunk_after(start), index);
                if index == count - 1 { plain = index * files::CHUNK_PLAIN as u64 + files::chunk_plain_len(case.size, index).unwrap() as u64; at = end + 1 }
            }
            assert_eq!((plain, at), (case.size, case.cipher_size), "{}", case.size);
            assert!(files::chunk_range(case.size, count).is_none() && files::chunk_plain_len(case.size, count).is_none());
        }
        assert_eq!(files::chunk_after(files::chunked_cipher_size(9 * 1024 * 1024)), 3);
    }

    #[test]
    fn a_waveform_is_made_and_drawn_as_in_the_reference() {
        let all = vectors();
        assert!(all.waveforms.len() >= 140 && all.bars.len() >= 500 && all.rules.bars == media::WAVEFORM_BARS);
        let (mut made, mut none) = (0, 0);
        for case in &all.waveforms {
            // The levels are read by the core's own JSON reader, as they arrive from the apps.
            let Ok(Value::Array(levels)) = json::parse(&case.levels) else { panic!("levels") };
            let levels: Vec<f64> = levels.iter().map(|level| match level { Value::Number(level) => *level, _ => panic!("a level") }).collect();
            let letters = media::encode_waveform(&levels);
            assert_eq!(letters, case.waveform, "{} levels: {}", levels.len(), &case.levels[..case.levels.len().min(80)]);
            match letters { Some(letters) => { assert!(letters.len() == 100 && media::waveform_text(&letters.encode_utf16().collect::<Vec<_>>())); made += 1 } None => none += 1 }
        }
        assert!(made >= 120 && none >= 6, "{made} {none}");
        for case in &all.bars {
            let units: Option<Vec<u16>> = case.waveform.as_ref().map(|text| text.encode_utf16().collect());
            assert_eq!(media::waveform_bars(units.as_deref(), case.count), case.bars, "{:?} into {}", case.waveform, case.count);
        }
        for case in &all.times { assert_eq!((media::voice_time(case.ms), media::voice_time_fine(case.ms)), (case.time.clone(), case.fine.clone()), "{}", case.ms) }
        for case in &all.names { assert_eq!((media::voice_file_name(case.now), media::video_note_file_name(case.now)), (case.voice.clone(), case.note.clone()), "{}", case.now) }
        for case in &all.kinds {
            let attachment = json::object(vec![("name", Value::String(JsString::from_str(&case.name))), ("mimeType", Value::str(&case.mime_type))]);
            assert_eq!((media::is_voice(&attachment), media::is_video_note(&attachment)), (case.voice, case.note), "{:?} {:?}", case.name, case.mime_type);
        }
        assert!(all.kinds.iter().any(|case| case.voice) && all.kinds.iter().any(|case| case.note));
        assert_eq!((all.rules.voice_mime.as_str(), all.rules.voice_min_ms, all.rules.voice_max_ms, all.rules.note_max_ms), (media::VOICE_MIME, media::VOICE_MIN_MS, media::VOICE_MAX_MS, media::VIDEO_NOTE_MAX_MS));
    }

    #[cfg(feature = "signal")]
    mod crypto {
        use super::*;
        use sha2::{Digest, Sha256};
        use std::io::{BufRead, BufReader, Write};
        use std::path::Path;
        use std::process::{Command, Stdio};

        fn hex(bytes: &[u8]) -> String { bytes.iter().map(|byte| format!("{byte:02x}")).collect() }
        fn sha(bytes: &[u8]) -> String { hex(&Sha256::digest(bytes)) }
        /// The whole file, chunk by chunk, as the upload sends it.
        fn seal_all(plain: &[u8], encryption: &Value) -> Vec<u8> {
            let size = plain.len() as u64;
            let mut out = Vec::with_capacity(files::chunked_cipher_size(size) as usize);
            for index in 0..files::chunk_count(size) {
                let from = index as usize * files::CHUNK_PLAIN;
                out.extend(files::seal_chunk(&plain[from..from + files::chunk_plain_len(size, index).unwrap()], encryption, index, size).expect("a chunk is sealed"));
            }
            out
        }
        /// The whole file back, chunk by chunk, as the download opens it: the first refusal ends it.
        fn open_all(cipher: &[u8], attachment: &Value) -> Result<Vec<u8>, &'static str> {
            let size = files::chunked_size(attachment)?;
            let mut out = Vec::new();
            for index in 0..files::chunk_count(size) {
                let (start, end) = files::chunk_range(size, index).ok_or(files::WRONG_SIZE)?;
                let part = cipher.get(start as usize..(end + 1) as usize).ok_or(files::WRONG_SIZE)?;
                out.extend(files::open_chunk(part, attachment, index)?);
            }
            Ok(out)
        }
        fn with(attachment: &Value, key: &str, value: Value) -> Value {
            let Value::Object(entries) = attachment else { panic!("an object") };
            Value::Object(entries.iter().map(|(name, old)| if *name == JsString::from_str(key) { (name.clone(), value.clone()) } else { (name.clone(), old.clone()) }).collect())
        }
        fn with_encryption(attachment: &Value, key: &str, value: Option<Value>) -> Value {
            let Some(Value::Object(entries)) = attachment.get("encryption") else { panic!("an encryption") };
            let mut entries: Vec<(JsString, Value)> = entries.iter().filter(|(name, _)| *name != JsString::from_str(key)).cloned().collect();
            if let Some(value) = value { entries.push((JsString::from_str(key), value)) }
            with(attachment, "encryption", Value::Object(entries))
        }

        #[test]
        fn a_big_file_is_sealed_chunk_by_chunk_exactly_as_the_reference_does() {
            let all = vectors();
            assert!(all.files.len() >= 6 && all.files.iter().any(|case| case.tags.len() == 3) && all.files.iter().any(|case| case.size == files::CHUNK_PLAIN as u64));
            for case in &all.files {
                let attachment = json::parse(&case.attachment).expect("an attachment");
                assert!(invizent_core::e2ee::attachment::valid_attachment(&attachment, &|preview| preview.is_none()), "{}", case.size);
                let text = |value: Option<&Value>| match value { Some(Value::String(text)) => text.to_str().unwrap(), _ => panic!("a text") };
                let e = attachment.get("encryption").unwrap();
                let encryption = files::chunked_encryption(&text(e.get("key")), &text(e.get("nonce")), &text(e.get("fileKeyId")));
                let plain = pattern(case.size, case.start);
                let cipher = seal_all(&plain, &encryption);
                // Byte for byte what the reference's upload left on the server.
                assert_eq!(cipher.len() as u64, files::chunked_cipher_size(case.size));
                assert_eq!(sha(&cipher), case.cipher_sha256, "{} bytes", case.size);
                let full = files::CHUNK_PLAIN + files::TAG;
                let tags: Vec<String> = cipher.chunks(full).map(|chunk| hex(&chunk[chunk.len() - files::TAG..])).collect();
                assert_eq!(tags, case.tags, "{} bytes", case.size);
                // The object inside the message, and the way back.
                let made = files::attachment(&text(attachment.get("id")), &JsString::from_str("data.bin"), &JsString::from_str("application/octet-stream"), case.size as usize, &encryption, None, None);
                assert_eq!(json::stringify(&made), case.attachment);
                assert_eq!(files::chunked_size(&made), Ok(case.size));
                assert!(open_all(&cipher, &made).as_deref() == Ok(plain.as_slice()), "{} bytes do not open", case.size);
                // A chunk that is not the file's own length for its place is not sealed.
                assert_eq!(files::seal_chunk(&plain[..plain.len() - 1], &encryption, files::chunk_count(case.size) - 1, case.size), Err(files::FILE_CHANGED));
                assert_eq!(files::seal_chunk(&plain[..1], &encryption, files::chunk_count(case.size), case.size), Err(files::FILE_CHANGED));
            }
            assert_eq!(files::seal_chunk(&[], &files::fresh_chunked_encryption(), 0, 0), Err(files::NO_SIZE));
            assert_eq!(files::seal_chunk(&[1], &files::fresh_encryption(), 0, 1), Err(files::NOT_SEALED));

            // The reference's refusals of a tampered download, on the same three-chunk file.
            let case = all.files.iter().find(|case| case.tags.len() == 3).unwrap();
            let attachment = json::parse(&case.attachment).unwrap();
            let e = attachment.get("encryption").unwrap();
            let text = |key: &str| match e.get(key) { Some(Value::String(text)) => text.to_str().unwrap(), _ => panic!("a text") };
            let cipher = seal_all(&pattern(case.size, case.start), &files::chunked_encryption(&text("key"), &text("nonce"), &text("fileKeyId")));
            let full = files::CHUNK_PLAIN + files::TAG;
            let chunk = 4.0 * 1024.0 * 1024.0;
            let mut seen = 0;
            for refusal in &all.refused {
                let result = match refusal.name.as_str() {
                    "the first two chunks swapped" => open_all(&[&cipher[full..2 * full], &cipher[..full], &cipher[2 * full..]].concat(), &attachment),
                    "a byte of the second chunk changed" => { let mut changed = cipher.clone(); changed[full + 100] ^= 1; open_all(&changed, &attachment) }
                    "the message names one chunk only" => open_all(&cipher, &with(&attachment, "size", Value::Number(chunk))),
                    "the message names two chunks only" => open_all(&cipher, &with(&attachment, "size", Value::Number(2.0 * chunk))),
                    "another file key id" => open_all(&cipher, &with_encryption(&attachment, "fileKeyId", Some(Value::str("00000000-0000-4000-8000-000000000000")))),
                    "another chunk size" => open_all(&cipher, &with_encryption(&attachment, "chunkSize", Some(Value::Number(1024.0 * 1024.0)))),
                    "no chunk size" => open_all(&cipher, &with_encryption(&attachment, "chunkSize", None)),
                    other => panic!("an unknown case: {other}"),
                };
                assert_eq!(result.err(), Some(refusal.error.as_str()), "{}", refusal.name);
                seen += 1;
            }
            assert!(seen >= 7);
            // What the reference never gets to see: a chunk of the wrong length, a small file's scheme, a place past the end.
            assert_eq!(files::open_chunk(&cipher[..full - 1], &attachment, 0), Err(files::WRONG_SIZE));
            assert_eq!(files::open_chunk(&cipher[..full], &attachment, 3), Err(files::WRONG_SIZE));
            assert_eq!(files::open_chunk(&cipher[..full], &with_encryption(&attachment, "scheme", Some(Value::str(files::SCHEME))), 0), Err(files::NO_KEY));
            // A chunk moved to another place does not open even when its length fits.
            assert_eq!(files::open_chunk(&cipher[..full], &attachment, 1), Err(files::NOT_AUTHENTIC));
            assert_eq!(files::open_chunk(&cipher[full..2 * full], &attachment, 0), Err(files::NOT_AUTHENTIC));
        }

        fn reference(mode: &str) -> (std::process::Child, std::process::ChildStdin, BufReader<std::process::ChildStdout>) {
            let node = std::env::var("INVIZENT_NODE").unwrap_or_else(|_| if Path::new("/opt/node24/bin/node").exists() { "/opt/node24/bin/node".into() } else { "node".into() });
            let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
            assert!(manifest.join("../../desktop/node_modules/@signalapp/libsignal-client").exists(), "desktop/node_modules is not installed: run `npm ci` in desktop/");
            let mut child = Command::new(node).arg(manifest.join("tests/generate-chunked-vectors.mjs")).arg(mode).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().expect("the reference starts");
            let (input, output) = (child.stdin.take().unwrap(), BufReader::new(child.stdout.take().unwrap()));
            (child, input, output)
        }
        fn asked(input: &mut std::process::ChildStdin, output: &mut BufReader<std::process::ChildStdout>, line: serde_json::Value) -> serde_json::Value {
            writeln!(input, "{line}").unwrap();
            let mut answer = String::new();
            output.read_line(&mut answer).unwrap();
            serde_json::from_str(&answer).expect("the reference answers")
        }

        #[test]
        fn big_files_go_both_ways_between_this_core_and_the_reference() {
            let folder = std::env::temp_dir().join(format!("invizent-chunked-{}", std::process::id()));
            std::fs::create_dir_all(&folder).unwrap();
            let path = folder.join("server.bin");
            let as_json = |value: &Value| serde_json::from_str::<serde_json::Value>(&json::stringify(value)).unwrap();

            // Sealed here, opened by the reference's download.
            let (mut child, mut input, mut output) = reference("--open");
            let mut keys = std::collections::BTreeSet::new();
            for (index, size) in [1u64, 4096, files::CHUNK_PLAIN as u64, files::CHUNK_PLAIN as u64 + 7].into_iter().enumerate() {
                let plain = pattern(size, 40 + index as u8);
                let encryption = files::fresh_chunked_encryption();
                assert!(keys.insert(json::stringify(&encryption)), "the same key twice");
                let cipher = seal_all(&plain, &encryption);
                let attachment = files::attachment(&format!("00000000-0000-4000-8000-{index:012}"), &JsString::from_str("запись.bin"), &JsString::from_str("application/octet-stream"), size as usize, &encryption, None, None);
                assert!(invizent_core::e2ee::attachment::valid_attachment(&attachment, &|preview| preview.is_none()), "{size}");
                std::fs::write(&path, &cipher).unwrap();
                let answer = asked(&mut input, &mut output, serde_json::json!({ "attachment": as_json(&attachment), "path": path }));
                assert_eq!(answer, serde_json::json!({ "sha256": sha(&plain), "size": size }), "{size} bytes");
                // One changed bit: both sides refuse, in the same words.
                let mut changed = cipher.clone();
                changed[cipher.len() - 20.min(cipher.len())] ^= 0x10;
                std::fs::write(&path, &changed).unwrap();
                assert_eq!(asked(&mut input, &mut output, serde_json::json!({ "attachment": as_json(&attachment), "path": path }))["error"], serde_json::json!(files::NOT_AUTHENTIC), "{size}");
                assert_eq!(open_all(&changed, &attachment), Err(files::NOT_AUTHENTIC));
            }
            drop(input);
            let _ = child.wait();

            // Uploaded by the reference (with keys of its own, new on every run), opened here.
            let (mut child, mut input, mut output) = reference("--seal");
            for (seed, size) in [(7u8, 3u64), (99, files::CHUNK_PLAIN as u64 + 1), (180, 2 * files::CHUNK_PLAIN as u64)] {
                let answer = asked(&mut input, &mut output, serde_json::json!({ "seed": seed, "size": size, "path": path }));
                let attachment = json::parse(&answer["attachment"].to_string()).expect("an attachment");
                let cipher = std::fs::read(&path).unwrap();
                assert_eq!(cipher.len() as u64, files::chunked_cipher_size(size));
                assert!(open_all(&cipher, &attachment).as_deref() == Ok(pattern(size, seed).as_slice()), "{size} bytes from the reference do not open");
            }
            drop(input);
            let _ = child.wait();
            let _ = std::fs::remove_dir_all(&folder);
        }

        // ── The same through the C functions ─────────────────────────────────────────────────────────────────
        use invizent_core::ffi::*;
        use std::ffi::{CStr, CString};

        unsafe fn words(pointer: *mut std::ffi::c_char) -> Option<String> {
            if pointer.is_null() { return None }
            let out = CStr::from_ptr(pointer).to_str().unwrap().to_string();
            invizent_string_free(pointer);
            Some(out)
        }
        unsafe fn call(name: &str, args: &str) -> Option<String> {
            let (name, args) = (CString::new(name).unwrap(), CString::new(args).unwrap());
            words(invizent_file_call(name.as_ptr(), args.as_ptr()))
        }
        unsafe fn taken(bytes: InvizentBytes) -> Vec<u8> {
            let out = if bytes.data.is_null() { Vec::new() } else { std::slice::from_raw_parts(bytes.data, bytes.len).to_vec() };
            invizent_file_bytes_free(bytes);
            out
        }

        #[test]
        fn big_files_and_waveforms_cross_the_boundary() {
            unsafe {
                let empty = || InvizentBytes { data: std::ptr::null_mut(), len: 0 };
                let encryption = call("newChunkedEncryption", "[]").expect("an encryption");
                assert_ne!(Some(&encryption), call("newChunkedEncryption", "[]").as_ref());
                assert!(encryption.contains(r#""scheme":"aes-256-gcm-siv-chunked""#) && encryption.ends_with(r#""chunkSize":4194304}"#), "{encryption}");
                let size = files::CHUNK_PLAIN as u64 + 1000;
                assert_eq!(call("chunks", &format!("[{size}]")).as_deref(), Some(r#"{"count":2,"chunkSize":4194304,"cipherSize":4195336}"#));
                assert_eq!(call("chunk", &format!("[{size},0]")).as_deref(), Some(r#"{"start":0,"end":4194319,"plain":4194304,"cipher":4194320}"#));
                assert_eq!(call("chunk", &format!("[{size},1]")).as_deref(), Some(r#"{"start":4194320,"end":4195335,"plain":1000,"cipher":1016}"#));
                assert_eq!(call("chunk", &format!("[{size},2]")).as_deref(), Some("null"));
                assert_eq!(call("chunkAfter", "[4194320]").as_deref(), Some("1"));
                assert_eq!(call("chunkAfter", "[0]").as_deref(), Some("0"));

                let plain = pattern(size, 11);
                let key = CString::new(encryption.clone()).unwrap();
                let mut cipher = Vec::new();
                for (index, part) in plain.chunks(files::CHUNK_PLAIN).enumerate() {
                    let mut sealed = empty();
                    assert!(invizent_file_seal_chunk(part.as_ptr(), part.len(), key.as_ptr(), index as u64, size, &mut sealed).is_null());
                    cipher.extend(taken(sealed));
                }
                assert_eq!(cipher.len() as u64, files::chunked_cipher_size(size));
                let attachment = call("attachment", &format!(r#"["0f8fad5b-d9cb-469f-a165-70867728950e","video.mp4","video/mp4",{size},{encryption},{{"width":1280,"height":720,"durationMs":4000,"hdr":"sdr"}},null]"#)).expect("an attachment");
                assert_eq!(call("chunked", &format!("[{attachment}]")).as_deref(), Some(r#"{"size":4195304,"count":2,"cipherSize":4195336,"refusal":null}"#));
                assert_eq!(call("mediaKind", &format!("[{attachment}]")).as_deref(), Some("\"video\""));
                // The small-file road still refuses it (the apps choose the road by `chunked`).
                assert!(call("describe", &format!("[{attachment}]")).unwrap().contains(files::CHUNKED_NOT_YET));
                let message = CString::new(attachment).unwrap();
                let full = files::CHUNK_PLAIN + files::TAG;
                let mut back = Vec::new();
                for (index, part) in cipher.chunks(full).enumerate() {
                    let mut opened = empty();
                    assert!(invizent_file_open_chunk(part.as_ptr(), part.len(), message.as_ptr(), index as u64, &mut opened).is_null());
                    back.extend(taken(opened));
                }
                assert!(back == plain);
                let mut out = empty();
                assert_eq!(words(invizent_file_open_chunk(cipher.as_ptr(), full, message.as_ptr(), 1, &mut out)).as_deref(), Some(files::WRONG_SIZE));
                assert!(out.data.is_null() && out.len == 0);
                assert_eq!(words(invizent_file_open_chunk(cipher[full..].as_ptr(), cipher.len() - full, message.as_ptr(), 0, &mut out)).as_deref(), Some(files::WRONG_SIZE));
                let mut changed = cipher[..full].to_vec();
                changed[5] ^= 1;
                assert_eq!(words(invizent_file_open_chunk(changed.as_ptr(), full, message.as_ptr(), 0, &mut out)).as_deref(), Some(files::NOT_AUTHENTIC));
                assert_eq!(words(invizent_file_open_chunk(cipher.as_ptr(), full, std::ptr::null(), 0, &mut out)).as_deref(), Some(files::NO_KEY));
                assert_eq!(words(invizent_file_seal_chunk(plain.as_ptr(), 10, key.as_ptr(), 0, size, &mut out)).as_deref(), Some(files::FILE_CHANGED));
                assert!(words(invizent_file_seal_chunk(plain.as_ptr(), 10, key.as_ptr(), 0, 10, std::ptr::null_mut())).is_some());
                assert_eq!(call("chunked", r#"[{"size":5,"encryption":{"scheme":"aes-256-gcm-siv"}}]"#), Some(format!(r#"{{"refusal":"{}"}}"#, files::NO_KEY)));

                // Voice messages and round videos.
                let all = vectors();
                let case = all.waveforms.iter().find(|case| case.waveform.as_ref().is_some_and(|letters| letters.contains('f') && letters.contains('A'))).unwrap();
                assert_eq!(call("waveform", &format!("[{}]", case.levels)), Some(format!("\"{}\"", case.waveform.as_ref().unwrap())));
                assert_eq!(call("waveform", "[[0,0,0,0,0]]").as_deref(), Some("null"));
                assert_eq!(call("waveformBars", "[null,10]").as_deref(), Some(format!("[{}]", vec!["0.12"; 12].join(",")).as_str()));
                assert_eq!(call("waveformBars", r#"["AAAAffff",58]"#).as_deref(), Some("[0,0,0,0,1,1,1,1]"));
                assert_eq!(call("voiceTime", "[23000]").as_deref(), Some("\"0:23\""));
                assert_eq!(call("voiceTimeFine", "[4630]").as_deref(), Some("\"0:04,63\""));
                assert_eq!(call("voiceName", "[1795244400000]").as_deref(), Some("\"voice-1795244400000.m4a\""));
                assert_eq!(call("noteName", "[1795244400000]").as_deref(), Some("\"circle-1795244400000.mp4\""));
                assert_eq!(call("mediaKind", r#"[{"name":"voice-1795244400000.m4a","mimeType":"audio/mp4"}]"#).as_deref(), Some("\"voice\""));
                assert_eq!(call("mediaKind", r#"[{"name":"circle-1795244400000.mp4","mimeType":"video/mp4"}]"#).as_deref(), Some("\"note\""));
                assert_eq!(call("mediaKind", r#"[{"name":"song.m4a","mimeType":"audio/mp4"}]"#).as_deref(), Some("\"audio\""));
                assert_eq!(call("recordRules", "[]").as_deref(), Some(r#"{"voiceMime":"audio/mp4","noteMime":"video/mp4","voiceMinMs":500,"voiceMaxMs":64800000,"noteMaxMs":60000}"#));
                for (name, args) in [("chunks", "[-1]"), ("chunk", "[5]"), ("waveform", "[[\"a\",1,1,1]]"), ("waveformBars", "[null]"), ("chunked", "[5]"), ("mediaKind", "[1]"), ("voiceTime", "[\"1\"]")] { assert!(call(name, args).is_none(), "{name} {args}") }
            }
        }
    }
}
