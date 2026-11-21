//! The rules of one-to-one calls against the reference's own answers (`mobile/src/calls/callModel.ts`,
//! `reconnect.ts`, `callStatus.ts`, `callLog.ts`, `scheduled/model.ts`; vectors from
//! `tests/generate-calls-vectors.mjs`).
//!
//! Every line of the vectors is `JSON.stringify`'s text: `{"name", "args", "want"}`. Each is first read and written
//! back and must come out the same text; then the core is asked by that name with those arguments, as the apps
//! ask it, and its answer is compared with the reference's as JSON text, to the character.
use invizent_core::calls;
use invizent_core::json::{self, Value};
use std::collections::BTreeMap;

fn cases() -> Vec<Value> {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/calls.json")).expect("vectors");
    text.lines().map(|line| {
        let case = json::parse(line).expect("a JSON line");
        assert_eq!(json::stringify(&case), line, "the line is not read and written back as it is");
        case
    }).collect()
}

/// Where two texts part, with some of what follows.
fn differ(want: &str, got: &str) -> String {
    let at = want.bytes().zip(got.bytes()).position(|(a, b)| a != b).unwrap_or(want.len().min(got.len()));
    let cut = |text: &str| { let from = (0..=at.saturating_sub(80)).rev().find(|i| text.is_char_boundary(*i)).unwrap_or(0); text[from..].chars().take(260).collect::<String>() };
    format!("at byte {at}:\n  want …{}\n  got  …{}", cut(want), cut(got))
}

#[test]
fn calls_answer_as_the_reference_does() {
    let cases = cases();
    let (mut wrong, mut counts): (Vec<String>, BTreeMap<String, usize>) = (Vec::new(), BTreeMap::new());
    for (index, case) in cases.iter().enumerate() {
        let name = case.get("name").and_then(Value::as_str).expect("a name");
        let Some(Value::Array(args)) = case.get("args") else { panic!("case {index}: no arguments") };
        let want = json::stringify(case.get("want").expect("an answer"));
        let got = calls::view(&name, args).map_or_else(|| "no answer".to_string(), |answer| json::stringify(&answer));
        if want != got && wrong.len() < 5 { wrong.push(format!("case {index} {name} {}\n{}", json::stringify(&Value::Array(args.clone())).chars().take(400).collect::<String>(), differ(&want, &got))) }
        if want != got { *counts.entry(format!("WRONG {name}")).or_default() += 1 }
        *counts.entry(name).or_default() += 1;
    }
    assert!(wrong.is_empty(), "{:?}\n{}", counts.iter().filter(|(name, _)| name.starts_with("WRONG")).collect::<Vec<_>>(), wrong.join("\n"));
    // Every name the apps may ask by is covered, and the big ones by many cases.
    for (name, least) in [("callRules", 1), ("callGatherDone", 80), ("callIsRelayCandidate", 20), ("callHasRelay", 20), ("callOfferFresh", 300), ("callKey", 300), ("callSameFingerprints", 300),
        ("callEconomySdp", 700), ("callMarkRestart", 250), ("callStripRestart", 300), ("callRestartCapable", 300), ("callEnd", 400), ("callHangup", 14), ("callPushKind", 150), ("callGrade", 600),
        ("callCaps", 9), ("callLink", 900), ("callLinkLines", 700), ("callLinkNext", 4000), ("callRemoteRestart", 2500), ("callRestartAnswerFits", 96), ("callSignalNetwork", 9), ("callStatus", 1440),
        ("callRingExpiry", 3), ("callServiceText", 700)] {
        assert!(counts.get(name).copied().unwrap_or(0) >= least, "{name}: {:?} cases", counts.get(name));
    }
}

#[test]
fn the_vectors_are_not_all_one_answer() {
    // A rule that always answered the same would pass a test whose vectors happen to be one-sided.
    let cases = cases();
    for name in ["callGatherDone", "callIsRelayCandidate", "callHasRelay", "callOfferFresh", "callSameFingerprints", "callRestartCapable", "callRestartAnswerFits"] {
        let (yes, no) = cases.iter().filter(|case| case.get("name") == Some(&Value::str(name))).fold((0, 0), |(yes, no), case| if case.get("want") == Some(&Value::Bool(true)) { (yes + 1, no) } else { (yes, no + 1) });
        assert!(yes >= 3 && no >= 3, "{name}: {yes} yes, {no} no");
    }
    let keys = cases.iter().filter(|case| case.get("name") == Some(&Value::str("callKey")));
    let (with, without) = keys.fold((0, 0), |(with, without), case| if case.get("want") == Some(&Value::Null) { (with, without + 1) } else { (with + 1, without) });
    assert!(with >= 50 && without >= 20, "{with} keys, {without} without");
    let changed = cases.iter().filter(|case| case.get("name") == Some(&Value::str("callEconomySdp")) && case.get("want") != case.get("args").and_then(|args| match args { Value::Array(args) => args.first(), _ => None })).count();
    assert!(changed >= 200, "{changed} SDPs changed");
    for (name, least) in [("callStripRestart", 60), ("callMarkRestart", 100)] {
        let changed = cases.iter().filter(|case| case.get("name") == Some(&Value::str(name)) && case.get("want") != case.get("args").and_then(|args| match args { Value::Array(args) => args.first(), _ => None })).count();
        assert!(changed >= least, "{name}: {changed} changed");
    }
}
