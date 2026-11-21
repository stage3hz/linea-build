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
