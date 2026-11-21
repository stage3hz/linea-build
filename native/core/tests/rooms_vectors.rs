//! The rules of rooms against the reference's own answers (`mobile/src/rooms/rooms.ts`,
//! `mobile/src/communities/voiceAuth.ts`, `voiceRestartOfferer` of `calls/reconnect.ts`, the music wire of
//! `rooms/roomMusic.tsx`; vectors from `tests/generate-rooms-vectors.mjs`).
//!
//! Every line of the vectors is `JSON.stringify`'s text: `{"name", "args", "want"}`. Each is first read and written
//! back and must come out the same text; then the core is asked by that name with those arguments, as the apps
//! ask it, and its answer is compared with the reference's as JSON text, to the character.
//!
//! The seats are the one exception: they come out of a cosine and a sine, which the phones' own mathematics
//! libraries may round in the last digit differently from the reference's. Who sits where and in which order is
//! compared exactly; the two coordinates must agree to a billionth of the stage.
use invizent_core::json::{self, Value};
use invizent_core::rooms;
use std::collections::BTreeMap;

fn cases() -> Vec<Value> {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/rooms.json")).expect("vectors");
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

/// The same people in the same order, each within a billionth of where the reference seats them.
fn same_seats(want: &Value, got: &Value) -> bool {
    let (Value::Array(want), Value::Array(got)) = (want, got) else { return false };
    want.len() == got.len() && want.iter().zip(got).all(|(a, b)| {
        let near = |key: &str| matches!((a.get(key), b.get(key)), (Some(Value::Number(x)), Some(Value::Number(y))) if (x - y).abs() < 1e-9);
        a.get("id") == b.get("id") && near("x") && near("y")
    })
}

#[test]
fn rooms_answer_as_the_reference_does() {
    let cases = cases();
    let (mut wrong, mut counts): (Vec<String>, BTreeMap<String, usize>) = (Vec::new(), BTreeMap::new());
    for (index, case) in cases.iter().enumerate() {
        let name = case.get("name").and_then(Value::as_str).expect("a name");
        let Some(Value::Array(args)) = case.get("args") else { panic!("case {index}: no arguments") };
        let want = json::stringify(case.get("want").expect("an answer"));
        let answer = rooms::view(&name, args);
        let got = answer.as_ref().map_or_else(|| "no answer".to_string(), json::stringify);
        let fine = if name == "roomSeats" { answer.as_ref().is_some_and(|answer| same_seats(case.get("want").expect("an answer"), answer)) } else { want == got };
        if !fine && wrong.len() < 5 { wrong.push(format!("case {index} {name} {}\n{}", json::stringify(&Value::Array(args.clone())).chars().take(400).collect::<String>(), differ(&want, &got))) }
        if !fine { *counts.entry(format!("WRONG {name}")).or_default() += 1 }
        *counts.entry(name).or_default() += 1;
    }
    assert!(wrong.is_empty(), "{:?}\n{}", counts.iter().filter(|(name, _)| name.starts_with("WRONG")).collect::<Vec<_>>(), wrong.join("\n"));
    // Every name the apps may ask by is covered, and the big ones by many cases.
    for (name, least) in [("roomRules", 1), ("roomSort", 100), ("roomEvent", 350), ("roomCallCheck", 250), ("roomSeats", 300), ("roomSeatSize", 300), ("roomInsideLine", 19), ("roomSleepLine", 2000),
        ("roomAuthText", 400), ("roomCheckAuth", 600), ("roomRestartOfferer", 400), ("roomMusicIn", 1000), ("roomMusicOut", 500)] {
        assert!(counts.get(name).copied().unwrap_or(0) >= least, "{name}: {:?} cases", counts.get(name));
    }
}

#[test]
fn the_vectors_are_not_all_one_answer() {
    // A rule that always answered the same would pass a test whose vectors happen to be one-sided.
    let cases = cases();
    let named = |name: &'static str| cases.iter().filter(move |case| case.get("name") == Some(&Value::str(name)));
    for name in ["roomCheckAuth", "roomRestartOfferer"] {
        let (yes, no) = named(name).fold((0, 0), |(yes, no), case| if case.get("want") == Some(&Value::Bool(true)) { (yes + 1, no) } else { (yes, no + 1) });
        assert!(yes >= 30 && no >= 30, "{name}: {yes} yes, {no} no");
    }
    for name in ["roomAuthText", "roomMusicIn", "roomMusicOut", "roomEvent"] {
        let (with, without) = named(name).fold((0, 0), |(with, without), case| if case.get("want") == Some(&Value::Null) { (with, without + 1) } else { (with + 1, without) });
        assert!(with >= 30 && without >= 30, "{name}: {with} answers, {without} nulls");
    }
    let calls = named("roomCallCheck").fold((0, 0), |(ids, errors), case| if case.get("want").and_then(|want| want.get("ids")).is_some() { (ids + 1, errors) } else { (ids, errors + 1) });
    assert!(calls.0 >= 30 && calls.1 >= 30, "roomCallCheck: {calls:?}");
    // The list really is put in another order, the ring really starts and really stops, and all three lines about sleep appear.
    assert!(named("roomSort").filter(|case| case.get("want") != case.get("args").and_then(|args| match args { Value::Array(args) => args.first(), _ => None })).count() >= 30);
    let rings = |before: bool, after: bool| named("roomEvent").filter(|case| {
        let was = case.get("args").and_then(|args| match args { Value::Array(args) => args.first(), _ => None }).and_then(|state| state.get("ring")).is_some_and(|ring| ring != &Value::Null);
        let is = case.get("want").and_then(|want| want.get("ring")).is_some_and(|ring| ring != &Value::Null);
        case.get("want") != Some(&Value::Null) && was == before && is == after
    }).count();
    assert!(rings(false, true) >= 10 && rings(true, false) >= 10, "rings: {} begin, {} end", rings(false, true), rings(true, false));
    for words in ["сегодня в", "вчера в", "ещё никто", "марта", "октября"] {
        assert!(named("roomSleepLine").filter(|case| case.get("want").and_then(Value::as_str).is_some_and(|line| line.contains(words))).count() >= 2, "{words}");
    }
}
