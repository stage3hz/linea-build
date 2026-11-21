//! The preview picture of an attachment, against the reference's own verdicts
//! (`mobile/src/media/previewModel.ts`, `validPreview`; vectors from `tests/generate-preview-vectors.mjs`).
use invizent_core::json;
use base64::Engine as _;
use invizent_core::photo::preview::create_preview;
use invizent_core::photo::valid_preview;
use serde::Deserialize;

#[derive(Deserialize)]
struct Case { name: String, json: Option<String>, valid: bool }
#[test]
fn previews_are_accepted_and_refused_as_in_the_reference() {
    let cases: Vec<Case> = serde_json::from_str(include_str!("vectors/preview.json")).expect("vectors");
    assert!(cases.len() > 3000, "{} cases", cases.len());
    let accepted = cases.iter().filter(|case| case.valid).count();
    assert!(accepted > 700 && cases.len() - accepted > 2000, "{accepted} of {} accepted", cases.len());
    assert!(cases.iter().any(|case| case.json.is_none() && case.valid), "no preview at all is a valid one");
    let mut wrong = Vec::new();
    for case in &cases {
        let value = case.json.as_ref().map(|text| json::parse(text).unwrap_or_else(|_| panic!("{}: not a JSON value", case.name)));
        if valid_preview(value.as_ref()) != case.valid { wrong.push(format!("{} must be {}", case.name, case.valid)) }
    }
    assert!(wrong.is_empty(), "{} of {} differ, first: {:#?}", wrong.len(), cases.len(), &wrong[..wrong.len().min(12)]);
}

#[derive(Deserialize)]
struct Made { name: String, file: String, same: Option<bool>, base64: Option<String>, width: Option<u32>, height: Option<u32> }
#[test]
fn previews_are_made_as_in_the_reference() {
    let cases: Vec<Made> = serde_json::from_str(include_str!("vectors/preview-create.json")).expect("vectors");
    let (kept, cleaned) = (cases.iter().filter(|case| case.same == Some(true)).count(), cases.iter().filter(|case| case.base64.is_some()).count());
    assert!(cases.len() > 1500 && kept > 300 && cleaned > 300 && cases.len() - kept - cleaned > 700, "{} cases, {kept} kept, {cleaned} cleaned", cases.len());
    let mut wrong = Vec::new();
    for case in &cases {
        let bytes = base64::engine::general_purpose::STANDARD.decode(&case.file).expect("base64");
        let want = if case.same == Some(true) { Some(case.file.clone()) } else { case.base64.clone() }.map(|text| (text, case.width.expect("width"), case.height.expect("height")));
        let got = create_preview(&bytes).ok().map(|made| (made.base64, made.width, made.height));
        if got != want { wrong.push(format!("{}: got {:?}, the reference gave {:?}", case.name, got.map(|(_, w, h)| (w, h)), want.map(|(_, w, h)| (w, h)))) }
    }
    assert!(wrong.is_empty(), "{} of {} differ, first: {:#?}", wrong.len(), cases.len(), &wrong[..wrong.len().min(12)]);
}
