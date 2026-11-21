//! What a chat shows and the lines made of a message, against the reference's own answers
//! (`mobile/src/messageMeta.ts` from `messageKey` on; vectors from `tests/generate-chat-view-vectors.mjs`).
//!
//! Every line of the vectors is `JSON.stringify`'s text. Each is first read and written back and must come out the
//! same text, so the expected values below are compared as the reference's JSON text, to the character.
use invizent_core::chat_view::*;
use invizent_core::json::{self, JsString, Value};

fn cases() -> Vec<Value> {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/chat-view.json")).expect("vectors");
    text.lines().map(|line| {
        let case = json::parse(line).expect("a JSON line");
        assert_eq!(json::stringify(&case), line, "the line is not read and written back as it is");
        case
    }).collect()
}
fn kind<'a>(cases: &'a [Value], kind: &'a str) -> impl Iterator<Item = &'a Value> + 'a { cases.iter().filter(move |case| case.get("kind") == Some(&Value::str(kind))) }
fn part<'a>(case: &'a Value, key: &str) -> &'a Value { case.get(key).unwrap_or_else(|| panic!("no {key}")) }
fn items(value: &Value) -> &[Value] { match value { Value::Array(items) => items, other => panic!("not an array: {other:?}") } }
fn text(value: &Value) -> String { value.as_str().expect("a string") }
fn number(value: &Value) -> f64 { match value { Value::Number(number) => *number, other => panic!("not a number: {other:?}") } }
fn written(text: JsString) -> String { json::stringify(&Value::String(text)) }
fn report(what: &str, wrong: &[String], of: usize) { assert!(wrong.is_empty(), "{what}: {} of {of} differ, first:\n{}", wrong.len(), wrong[..wrong.len().min(3)].join("\n")) }
/// Where two texts part, with some of what follows.
fn differ(index: usize, want: &str, got: &str) -> String {
    let at = want.bytes().zip(got.bytes()).position(|(a, b)| a != b).unwrap_or(want.len().min(got.len()));
    let cut = |text: &str| { let from = (0..=at.saturating_sub(60)).rev().find(|i| text.is_char_boundary(*i)).unwrap_or(0); text[from..].chars().take(200).collect::<String>() };
    format!("case {index}, at byte {at}:\n  want …{}\n  got  …{}", cut(want), cut(got))
}

#[test]
fn chats_are_folded_as_in_the_reference() {
    let cases = cases();
    let chats: Vec<&Value> = kind(&cases, "chat").collect();
    assert!(chats.len() >= 1500, "{} chats", chats.len());
    let (mut wrong, mut rows, mut pinned, mut expiring) = (Vec::new(), 0, 0, 0);
    for (index, case) in chats.iter().enumerate() {
        let messages = items(part(case, "messages"));
        let hidden: Vec<String> = items(part(case, "hidden")).iter().map(text).collect();
        let got = fold_chat(messages, &text(part(case, "userId")), &hidden, number(part(case, "now")));
        let (want, got) = (json::stringify(part(case, "fold")), json::stringify(&got));
        if want != got { wrong.push(differ(index, &want, &got)) }
        rows += messages.len();
        if part(part(case, "fold"), "pinned") != &Value::Null { pinned += 1 }
        if part(part(case, "fold"), "nextExpiry") != &Value::Null { expiring += 1 }
    }
    report("fold_chat", &wrong, chats.len());
    assert!(rows > 15000 && pinned > 100 && expiring > 100, "{rows} rows, {pinned} pinned, {expiring} expiring");
}

#[test]
fn the_chat_list_line_is_chosen_as_in_the_reference() {
    let cases = cases();
    let (mut wrong, mut total, mut none) = (Vec::new(), 0, 0);
    for (index, case) in kind(&cases, "chat").enumerate() {
        let messages = items(part(case, "messages"));
        let (want, got) = (json::stringify(part(case, "list")), json::stringify(&list_preview_message(messages).unwrap_or(Value::Null)));
        if want != got { wrong.push(differ(index, &want, &got)) }
        // The one `end` kept per call, as places in `messages`.
        let ends: Vec<String> = dedupe_call_ends(messages).iter().map(json::stringify).collect();
        let want_ends: Vec<String> = items(part(case, "ends")).iter().map(|at| json::stringify(&messages[number(at) as usize])).collect();
        if ends != want_ends { wrong.push(format!("case {index}: call ends {} instead of {}", ends.len(), want_ends.len())) }
        total += 1;
        if want == "null" { none += 1 }
    }
    report("list_preview_message / dedupe_call_ends", &wrong, total);
    assert!(none > 50 && total - none > 1000, "{none} of {total} with nothing to show");
}

#[test]
fn single_messages_read_as_in_the_reference() {
    let cases = cases();
    let (mut wrong, mut total) = (Vec::new(), 0);
    let mut check = |index: usize, what: &str, message: &Value, want: &Value, got: String| {
        total += 1;
        if json::stringify(want) != got { wrong.push(format!("case {index}, {what} of {}:\n  want {}\n  got  {got}", json::stringify(message), json::stringify(want))) }
    };
    for (index, case) in kind(&cases, "chat").enumerate() {
        let messages = items(part(case, "messages"));
        let rows = items(part(case, "rows"));
        assert_eq!(messages.len(), rows.len());
        for (message, row) in messages.iter().zip(rows) {
            let row = items(row);
            let flags = (is_quiet_action(message) as u8) | (is_action(message) as u8) << 1 | (is_call_signal(message) as u8) << 2 | (skipped_in_list(message) as u8) << 3 | (is_call_end(message) as u8) << 4;
            check(index, "flags", message, &row[0], flags.to_string());
            check(index, "chat_list_text", message, &row[1], written(chat_list_text(message)));
            check(index, "reply_preview", message, &row[2], written(reply_preview(message)));
        }
    }
    for (index, case) in kind(&cases, "line").enumerate() {
        let message = part(case, "message");
        check(index, "message_key", message, part(case, "key"), written(message_key(message)));
        check(index, "chat_list_text (line)", message, part(case, "list"), written(chat_list_text(message)));
        check(index, "reply_preview (line)", message, part(case, "reply"), written(reply_preview(message)));
    }
    report("lines", &wrong, total);
    assert!(total > 50000, "{total} checks");
}

#[test]
fn the_edit_window_is_the_reference_s() {
    let cases = cases();
    let mut total = 0;
    for case in kind(&cases, "time") {
        let (sent, edit, now) = (text(part(case, "sent")), text(part(case, "edit")), number(part(case, "now")));
        assert_eq!(Value::Bool(edit_in_time(&sent, &edit)), *part(case, "inTime"), "edit_in_time({sent:?}, {edit:?})");
        assert_eq!(Value::Bool(edit_window_open(&sent, now)), *part(case, "open"), "edit_window_open({sent:?}, {now})");
        total += 1;
    }
    assert!(total >= 200, "{total} cases");
}

#[test]
fn fallback_texts_are_the_reference_s() {
    let cases = cases();
    let (mut wrong, mut total) = (Vec::new(), 0);
    let mut check = |what: &str, input: &Value, want: &Value, got: String| {
        total += 1;
        if json::stringify(want) != got { wrong.push(format!("{what} of {}:\n  want {}\n  got  {got}", json::stringify(input), json::stringify(want))) }
    };
    for case in kind(&cases, "fallback") {
        let Value::String(target) = part(case, "target") else { panic!("target") };
        let got = action_fallback(part(case, "action"), target).map_or("null".to_string(), written);
        check(&format!("action_fallback (target {})", json::stringify(part(case, "target"))), part(case, "action"), part(case, "text"), got);
    }
    for case in kind(&cases, "call") { check("call_preview", part(case, "action"), part(case, "text"), written(call_preview(part(case, "action")))) }
    for case in kind(&cases, "poll") { check("poll_fallback", part(case, "poll"), part(case, "text"), written(poll_fallback(part(case, "poll")))) }
    report("fallbacks", &wrong, total);
    assert!(total > 1200, "{total} checks");
}
