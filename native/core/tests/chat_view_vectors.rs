//! What a chat shows and the lines made of a message, against the reference's own answers
//! (`mobile/src/messageMeta.ts` from `messageKey` on; vectors from `tests/generate-chat-view-vectors.mjs`).
//!
//! Every line of the vectors is `JSON.stringify`'s text. Each is first read and written back and must come out the
//! same text, so the expected values below are compared as the reference's JSON text, to the character — but for
//! the owner's rule that the app's own lines carry no emoji (see `owned`).
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

// ---- the owner's rule over the reference ----
// The app's own lines carry no emoji: the reference's «📞 Звонок · 0:04», «🖼 Фотография», «🧹 История очищена»,
// «📊 question» read without the mark (chat_view.rs `APP_MARKS`), and no icon takes its place. The reference's
// answers are compared with the mark taken off. A line the reference cut at `limit` units with its mark is now
// the same words, cut at `limit` without it: the reference's (shorter) cut must then begin the line.

const MARKS: [&str; 15] = ["📞 ", "📹 ", "🎤 ", "🖼\u{fe0f} ", "🖼 ", "🎬 ", "📎 ", "📊 ", "✏\u{fe0f} ", "✏ ", "🗑 ", "🗳 ", "⏱ ", "🚫 ", "🧹 "];
fn unmarked(text: &[u16]) -> Vec<u16> {
    for mark in MARKS {
        let mark: Vec<u16> = mark.encode_utf16().collect();
        if text.starts_with(&mark) { return text[mark.len()..].to_vec() }
    }
    text.to_vec()
}
fn js_truthy(value: Option<&Value>) -> bool {
    match value { None | Some(Value::Null) | Some(Value::Bool(false)) => false, Some(Value::Number(n)) => *n != 0.0 && !n.is_nan(), Some(Value::String(s)) => !s.0.is_empty(), _ => true }
}
/// A poll's message, or an action's but a reaction's: its text is the app's own fallback.
fn app_made(message: &Value) -> bool {
    let meta = message.get("meta");
    let action = meta.and_then(|meta| meta.get("action"));
    js_truthy(meta.and_then(|meta| meta.get("poll"))) || (js_truthy(action) && action.and_then(|action| action.get("type")) != Some(&Value::str("react")))
}
/// `got` against the reference's `want` with its mark taken off, when `strip`.
fn owned(want: &Value, got: &JsString, strip: bool, limit: usize) -> bool {
    let Value::String(want) = want else { return json::stringify(want) == written(got.clone()) };
    if !strip { return want.0 == got.0 }
    let bare = unmarked(&want.0);
    bare == got.0 || (bare.len() < want.0.len() && want.0.len() == limit && got.0.len() <= limit && got.0.starts_with(&bare))
}
/// The reference's chat-list message with the app's mark taken off its text.
fn owned_message(want: &Value) -> Value {
    let Value::Object(entries) = want else { return want.clone() };
    if !app_made(want) { return want.clone() }
    Value::Object(entries.iter().map(|(key, value)| match value {
        Value::String(text) if key.0.iter().copied().eq("text".encode_utf16()) => (key.clone(), Value::String(JsString(unmarked(&text.0)))),
        _ => (key.clone(), value.clone()),
    }).collect())
}
/// Whether the reply line of `message` is one the app makes: a poll's question, an attachment's label (no words),
/// or an action's fallback.
fn reply_app_made(message: &Value) -> bool {
    let words = message.get("text").map(|text| match text { Value::String(text) => text.0.iter().any(|unit| !matches!(unit, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)), _ => false }).unwrap_or(false);
    app_made(message) || !words
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
        let (want, got) = (json::stringify(&owned_message(part(case, "list"))), json::stringify(&list_preview_message(messages).unwrap_or(Value::Null)));
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
    let (mut wrong_lines, mut checked) = (Vec::<String>::new(), 0);
    let mut check = |index: usize, what: &str, message: &Value, want: &Value, got: String| {
        total += 1;
        if json::stringify(want) != got { wrong.push(format!("case {index}, {what} of {}:\n  want {}\n  got  {got}", json::stringify(message), json::stringify(want))) }
    };
    // The owner's rule: the app's lines without the reference's mark (`owned`).
    let mut lines = |index: usize, message: &Value, list: &Value, reply: &Value| {
        let (list_got, reply_got) = (chat_list_text(message), reply_preview(message));
        if !owned(list, &list_got, app_made(message), usize::MAX) { wrong_lines.push(format!("case {index}, chat_list_text of {}:\n  want {}\n  got  {}", json::stringify(message), json::stringify(list), written(list_got))) }
        if !owned(reply, &reply_got, reply_app_made(message), 200) { wrong_lines.push(format!("case {index}, reply_preview of {}:\n  want {}\n  got  {}", json::stringify(message), json::stringify(reply), written(reply_got))) }
        checked += 2;
    };
    for (index, case) in kind(&cases, "chat").enumerate() {
        let messages = items(part(case, "messages"));
        let rows = items(part(case, "rows"));
        assert_eq!(messages.len(), rows.len());
        for (message, row) in messages.iter().zip(rows) {
            let row = items(row);
            let flags = (is_quiet_action(message) as u8) | (is_action(message) as u8) << 1 | (is_call_signal(message) as u8) << 2 | (skipped_in_list(message) as u8) << 3 | (is_call_end(message) as u8) << 4;
            check(index, "flags", message, &row[0], flags.to_string());
            lines(index, message, &row[1], &row[2]);
        }
    }
    for (index, case) in kind(&cases, "line").enumerate() {
        let message = part(case, "message");
        check(index, "message_key", message, part(case, "key"), written(message_key(message)));
        lines(index, message, part(case, "list"), part(case, "reply"));
    }
    drop(lines);
    wrong.extend(wrong_lines);
    report("lines", &wrong, total + checked);
    assert!(total + checked > 50000, "{} checks", total + checked);
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
    // The owner's rule: the reference's texts without their mark (`owned`); a reaction keeps the person's emoji.
    let mut check = |what: &str, input: &Value, want: &Value, got: Option<JsString>, limit: usize| {
        total += 1;
        let strip = input.get("type") != Some(&Value::str("react"));
        let right = match &got { None => *want == Value::Null, Some(got) => owned(want, got, strip, limit) };
        if !right { wrong.push(format!("{what} of {}:\n  want {}\n  got  {}", json::stringify(input), json::stringify(want), got.map_or("null".to_string(), written))) }
    };
    for case in kind(&cases, "fallback") {
        let Value::String(target) = part(case, "target") else { panic!("target") };
        let got = action_fallback(part(case, "action"), target);
        check(&format!("action_fallback (target {})", json::stringify(part(case, "target"))), part(case, "action"), part(case, "text"), got, 8000);
    }
    for case in kind(&cases, "call") { check("call_preview", part(case, "action"), part(case, "text"), Some(call_preview(part(case, "action"))), usize::MAX) }
    for case in kind(&cases, "poll") { check("poll_fallback", part(case, "poll"), part(case, "text"), Some(poll_fallback(part(case, "poll"))), 8000) }
    report("fallbacks", &wrong, total);
    assert!(total > 1200, "{total} checks");
}
