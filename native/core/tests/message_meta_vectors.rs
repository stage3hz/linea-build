//! The shape rules of a decrypted message's `meta`, against the reference's own verdicts.
use invizent_core::json;
use invizent_core::message_meta::{valid_link_url, valid_meta};
use serde::Deserialize;

#[derive(Deserialize)]
struct Case { meta: Option<String>, valid: bool }
#[test]
fn meta_is_accepted_and_refused_as_in_the_reference() {
    let cases: Vec<Case> = serde_json::from_str(include_str!("vectors/message-meta.json")).expect("vectors");
    assert!(cases.len() > 2000, "{} cases", cases.len());
    assert!(cases.iter().filter(|case| case.valid).count() > 100);
    let mut wrong = Vec::new();
    for case in &cases {
        let value = case.meta.as_ref().map(|text| json::parse(text).expect("a JSON value"));
        if valid_meta(value.as_ref()) != case.valid { wrong.push(format!("{} must be {}", case.meta.clone().unwrap_or_else(|| "undefined".into()), case.valid)) }
    }
    assert!(wrong.is_empty(), "{} of {} differ, first: {:#?}", wrong.len(), cases.len(), &wrong[..wrong.len().min(8)]);
}

#[derive(Deserialize)]
struct Link { url: String, valid: bool }
#[test]
fn links_are_accepted_and_refused_as_in_the_reference() {
    let cases: Vec<Link> = serde_json::from_str(include_str!("vectors/links.json")).expect("vectors");
    assert!(cases.len() >= 19);
    for case in cases { assert_eq!(valid_link_url(Some(&json::parse(&case.url).expect("a JSON value"))), case.valid, "{}", case.url); }
}
