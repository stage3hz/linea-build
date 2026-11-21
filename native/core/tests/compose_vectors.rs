//! Formatting while a message is written against the reference's own answers (`toggleEntity`, `clearFormatting`,
//! `activeTypes`, `shiftEntities` of `mobile/src/format/entities.ts` and the composer's `composed` with
//! `parseMarkdown`; vectors from `tests/generate-compose-vectors.mjs`). Answers are compared as JSON text.
use invizent_core::format::compose;
use invizent_core::json::{self, Value};

#[test]
fn compose_is_the_reference_s() {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/compose.json")).expect("vectors");
    let mut wrong = Vec::new();
    let mut count = std::collections::BTreeMap::new();
    let mut total = 0;
    for (index, line) in text.lines().enumerate() {
        let case = json::parse(line).expect("a JSON line");
        let Some(Value::String(op)) = case.get("op") else { panic!("case {index}: no op") };
        let op = op.to_string_lossy();
        let Some(Value::Array(args)) = case.get("args") else { panic!("case {index}: no args") };
        let want = case.get("out").expect("out");
        let got = compose::view(&op, args).unwrap_or(Value::Null);
        let (want_text, got_text) = (json::stringify(want), json::stringify(&got));
        if want_text != got_text && wrong.len() < 12 {
            wrong.push(format!("case {index} {op}: args {}\n  want {want_text}\n  got  {got_text}", json::stringify(&Value::Array(args.clone()))));
        }
        *count.entry(op).or_insert(0) += 1;
        total += 1;
    }
    assert!(total >= 12000, "{total} cases");
    for name in ["composeToggle", "composeClear", "composeActive", "composeShift", "composeOut"] {
        assert!(count.get(name).copied().unwrap_or(0) >= 1000, "{name}: {:?}", count.get(name));
    }
    assert!(wrong.is_empty(), "{} wrong:\n{}", wrong.len(), wrong.join("\n"));
}
