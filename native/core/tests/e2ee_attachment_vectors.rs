//! Media descriptions and attachments, against the reference's own functions.
use invizent_core::e2ee::attachment::{valid_attachment, wire_body, with_waveform};
use invizent_core::e2ee::bridge::keys;
use invizent_core::json::{self, Value};
use invizent_core::media::{valid_media, wire_media};
use serde::Deserialize;

#[derive(Deserialize)]
struct Media { value: Option<String>, valid: bool, wire: Option<String> }
#[test]
fn media_descriptions_are_judged_as_in_the_reference() {
    let cases: Vec<Media> = serde_json::from_str(include_str!("vectors/media.json")).expect("vectors");
    assert!(cases.len() > 800, "{} cases", cases.len());
    let mut wrong = Vec::new();
    for case in &cases {
        let value = case.value.as_ref().map(|text| json::parse(text).expect("a JSON value"));
        if valid_media(value.as_ref()) != case.valid { wrong.push(format!("{:?} must be {}", case.value, case.valid)) }
        if let (Some(value), Some(wire)) = (&value, &case.wire) { assert_eq!(&json::stringify(&wire_media(Some(value)).unwrap_or(Value::Null)), wire, "{:?}", case.value) }
    }
    assert!(wrong.is_empty(), "{} of {} differ, first: {:#?}", wrong.len(), cases.len(), &wrong[..wrong.len().min(8)]);
}

#[derive(Deserialize)]
struct Attachment { value: String, valid: bool }
#[test]
fn attachments_are_judged_as_in_the_reference() {
    let cases: Vec<Attachment> = serde_json::from_str(include_str!("vectors/attachment.json")).expect("vectors");
    assert!(cases.len() > 500, "{} cases", cases.len());
    assert!(cases.iter().filter(|case| case.valid).count() >= 10);
    // The generator's stand-in for the preview check: no preview, or the word OK.
    let preview_ok = |preview: Option<&Value>| preview.is_none() || preview.and_then(Value::as_str).as_deref() == Some("OK");
    let mut wrong = Vec::new();
    for case in &cases {
        if valid_attachment(&json::parse(&case.value).expect("a JSON value"), &preview_ok) != case.valid { wrong.push(format!("{} must be {}", case.value, case.valid)) }
    }
    assert!(wrong.is_empty(), "{} of {} differ, first: {:#?}", wrong.len(), cases.len(), &wrong[..wrong.len().min(8)]);
}

#[derive(Deserialize)]
struct WireCase { plain: String, wire: String }
#[derive(Deserialize)]
struct BackCase { attachment: String, waveform: Option<String>, result: String }
#[derive(Deserialize)]
struct Waveform { wire: Vec<WireCase>, back: Vec<BackCase> }
#[test]
fn a_voice_waveform_travels_next_to_the_attachment_as_in_the_reference() {
    let vectors: Waveform = serde_json::from_str(include_str!("vectors/waveform.json")).expect("vectors");
    assert!(vectors.wire.len() >= 7 && vectors.back.len() >= 36);
    for case in vectors.wire { assert_eq!(json::stringify(&wire_body(&json::parse(&case.plain).unwrap())), case.wire, "{}", case.plain) }
    for case in vectors.back {
        let waveform = case.waveform.as_ref().map(|text| json::parse(text).unwrap());
        assert_eq!(json::stringify(&with_waveform(&json::parse(&case.attachment).unwrap(), waveform.as_ref())), case.result, "{} + {:?}", case.attachment, case.waveform);
    }
}

#[test]
fn stored_records_keep_the_names_the_reference_gave_them() {
    assert_eq!(keys::trust("u", "d"), "trust:u:d");
    assert_eq!(keys::rekey("u", "d"), "rekey:u:d");
    assert_eq!(keys::session("u", "d", None), "session:u:d");
    assert_eq!(keys::session("u", "d", Some("scheduled")), "session:u:d:scheduled");
    assert_eq!(keys::devices("u"), "devices:u");
    assert_eq!(keys::message("c", "s", "m"), "message:c:s:m");
    assert_eq!(keys::outbox("c", "m"), "outbox:c:m");
    assert_eq!(keys::history_meta("c"), "history:c");
    assert_eq!(keys::history_page("c", 3.0), "history:c:3");
    assert_eq!(keys::address("u", "d", None), "u.d");
    assert_eq!(keys::address("u", "d", Some("voice")), "u.d.voice");
}
