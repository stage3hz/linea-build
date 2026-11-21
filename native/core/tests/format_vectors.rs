//! Message text for the native lists against the reference's own answers (`nativeText` of
//! `mobile/src/format/nativeSpans.ts`; vectors from `tests/generate-format-vectors.mjs`).
//!
//! Every line of the vectors is `JSON.stringify`'s text. Each is first read and written back and must come out the
//! same text, so the answers are compared as the reference's JSON text, to the character.
use invizent_core::format::{self, native_text};
use invizent_core::json::{self, JsString, Value};

fn cases() -> Vec<Value> {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/format.json")).expect("vectors");
    text.lines().map(|line| {
        let case = json::parse(line).expect("a JSON line");
        assert_eq!(json::stringify(&case), line, "the line is not read and written back as it is");
        case
    }).collect()
}
fn items(value: &Value) -> &[Value] { match value { Value::Array(items) => items, other => panic!("not an array: {other:?}") } }
fn short(text: String) -> String { if text.chars().count() > 900 { text.chars().take(900).collect::<String>() + "…" } else { text } }

#[test]
fn native_text_is_the_reference_s() {
    let cases = cases();
    assert!(cases.len() >= 15000, "{} cases", cases.len());
    let mut wrong = Vec::new();
    // What the cases exercise, counted from the reference's answers.
    let (mut thrown, mut plain, mut runs, mut addresses, mut mentions, mut malformed, mut big) = (0, 0, 0, 0, 0, 0, 0);
    let mut flags_seen = 0u32;
    for (index, case) in cases.iter().enumerate() {
        let Some(Value::String(text)) = case.get("text") else { panic!("case {index}: no text") };
        let entities = case.get("entities");
        let want = case.get("out").unwrap_or_else(|| panic!("case {index}: no out"));
        let got = native_text(text, entities);
        let (want_text, got_text) = (json::stringify(want), json::stringify(&got));
        if want_text != got_text {
            wrong.push(short(format!("case {index}: text {}\n  entities {}\n  want {want_text}\n  got  {got_text}", json::stringify(&Value::String(text.clone())), entities.map_or("(none)".to_string(), json::stringify))));
        }
        match entities { Some(Value::Array(list)) => if list.len() >= 64 { big += 1 }, Some(_) => malformed += 1, None => {} }
        if *want == Value::Null { thrown += 1; continue }
        let fmt = items(want.get("fmt").expect("fmt"));
        if fmt.is_empty() { plain += 1 }
        for run in fmt.chunks(3) {
            let Value::Number(flags) = run[0] else { panic!("case {index}: flags") };
            flags_seen |= flags as u32;
            runs += 1;
        }
        for url in items(want.get("urls").expect("urls")) {
            let Value::String(JsString(url)) = url else { panic!("case {index}: url") };
            if url.starts_with(&"mention:".encode_utf16().collect::<Vec<_>>()) { mentions += 1 } else { addresses += 1 }
        }
    }
    assert!(wrong.is_empty(), "native_text: {} of {} differ, first:\n{}", wrong.len(), cases.len(), wrong[..wrong.len().min(4)].join("\n"));
    let every = format::BOLD | format::ITALIC | format::UNDERLINE | format::STRIKE | format::MONO | format::SPOILER | format::LINK | format::QUOTE | format::PRE;
    assert_eq!(flags_seen, every, "not every flag is in the vectors");
    assert!(thrown > 300 && plain > 2000 && runs > 20000 && addresses > 5000 && mentions > 1500 && malformed > 100 && big >= 40, "{thrown} thrown, {plain} plain, {runs} runs, {addresses} addresses, {mentions} mentions, {malformed} malformed, {big} big");
}

#[test]
fn nothing_to_draw_is_an_empty_text() {
    let empty = r#"{"text":"","fmt":[],"urls":[]}"#;
    assert_eq!(json::stringify(&native_text(&JsString::default(), None)), empty);
    // An empty text is answered before the entities are looked at — also the ones the reference would throw on.
    assert_eq!(json::stringify(&native_text(&JsString::default(), Some(&json::parse("[null]").unwrap()))), empty);
    assert_eq!(native_text(&JsString::from_str("x"), Some(&json::parse("[null]").unwrap())), Value::Null);
    assert_eq!(json::stringify(&native_text(&JsString::from_str("см. www.a.bc"), None)), r#"{"text":"см. www.a.bc","fmt":[64,4,8],"urls":["https://www.a.bc"]}"#);
}
