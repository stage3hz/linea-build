//! The table of endpoints against the reference itself: every request `mobile/src/api.ts` builds, replayed.
//! Vectors: `tests/vectors/api.json`, written by `tests/generate-api-vectors.mjs` (one case per line).
use invizent_core::api::{self, Call};
use invizent_core::json::{self, JsString, Value};
use std::collections::BTreeSet;

struct Case { line: usize, op: String, args: Vec<Value>, device: Value, want: Option<Call> }

/// The lines are read with the core's own JSON reader: strings there may hold a surrogate without its pair.
fn cases() -> Vec<Case> {
    include_str!("vectors/api.json").lines().enumerate().map(|(index, text)| {
        let line = index + 1;
        let case = json::parse(text).unwrap_or_else(|error| panic!("line {line}: {error:?}"));
        let field = |name: &str| case.get(name).unwrap_or_else(|| panic!("line {line}: no {name}")).clone();
        let text_of = |name: &str| field(name).as_str().unwrap_or_else(|| panic!("line {line}: {name} is not text"));
        let Value::Array(args) = field("args") else { panic!("line {line}: args") };
        let want = match case.get("throws") {
            Some(thrown) => {
                assert_eq!(thrown.as_str().as_deref(), Some("URIError"), "line {line}");
                assert!(matches!((field("method"), field("path"), field("body")), (Value::Null, Value::Null, Value::Null)), "line {line}");
                None
            }
            None => Some(Call { method: text_of("method"), path: text_of("path"), body: match field("body") { Value::Null => None, _ => Some(text_of("body")) } }),
        };
        Case { line, op: text_of("op"), args, device: field("device"), want }
    }).collect()
}

#[test]
fn every_request_is_the_one_the_reference_makes() {
    let cases = cases();
    assert!(cases.len() >= 5000, "only {} cases", cases.len());
    let mut refused = 0;
    for case in &cases {
        let got = api::call(&case.op, &case.args, &case.device);
        assert_eq!(got, case.want, "line {}: {}({})", case.line, case.op, json::stringify(&Value::Array(case.args.clone())));
        if case.want.is_none() { refused += 1 }
    }
    // Both kinds of answer are really there.
    assert!(refused >= 100 && cases.len() - refused >= 5000, "{refused} refusals of {}", cases.len());
    assert!(cases.iter().any(|case| case.want.as_ref().is_some_and(|call| call.body.is_none())) && cases.iter().any(|case| case.want.as_ref().is_some_and(|call| call.body.is_some())));
}

#[test]
fn the_table_is_exactly_the_members_the_vectors_hold() {
    let cases = cases();
    let in_vectors: BTreeSet<&str> = cases.iter().map(|case| case.op.as_str()).collect();
    let known: BTreeSet<&str> = api::ops().collect();
    assert_eq!(api::ops().count(), known.len(), "an op is listed twice");
    let unknown: Vec<&&str> = in_vectors.difference(&known).collect();
    assert!(unknown.is_empty(), "in the vectors, unknown to call: {unknown:?}");
    let unpinned: Vec<&&str> = known.difference(&in_vectors).collect();
    assert!(unpinned.is_empty(), "known to call, absent from the vectors: {unpinned:?}");
    assert!(known.len() >= 100, "{} ops", known.len());
    // `ops()` is the table `call` reads: each op answers for at least one case of the vectors, and a name that is
    // not in the table answers nothing, whatever the arguments.
    for op in &known {
        assert!(cases.iter().any(|case| case.op == *op && case.want.is_some() && api::call(op, &case.args, &case.device).is_some()), "{op} never answers");
    }
    let device = &cases[0].device;
    for stranger in ["", "Health", "health ", "cryptoInbox", "fileUrl", "socketUrl", "inviteUrl", "upload", "uploadChannelFile", "uploadPlain", "sendMultipart", "request", "binary", "pushField", "supportsScheduled", "toString", "constructor"] {
        assert!(!known.contains(stranger));
        for case in cases.iter().step_by(97) { assert_eq!(api::call(stranger, &case.args, device), None, "{stranger}") }
    }
}

fn parse(text: &str) -> Value { json::parse(text).expect("json") }
fn args(text: &str) -> Vec<Value> { match parse(text) { Value::Array(items) => items, _ => panic!("an array") } }

#[test]
fn arguments_of_the_wrong_kind_are_refused() {
    let device = parse(r#"{"platform":"ios","deviceName":"iPhone","deviceModel":"iPhone","osVersion":"iOS 18.1","appVersion":"0.16.3","networkTier":"fast"}"#);
    let call = |op: &str, given: &str| api::call(op, &args(given), &device);
    // Each of these is accepted as written…
    for (op, good) in [("health", "[]"), ("login", r#"["u","p","w"]"#), ("users", r#"["q"]"#), ("inboxPage", r#"["d","c",5]"#), ("chatSettings", r#"["c",{}]"#), ("messages", r#"["c"]"#), ("messages", r#"["c",null]"#),
        ("createRoom", r#"[["a"]]"#), ("createRoom", r#"[["a"],null]"#), ("changeStatusEmoji", "[null]"), ("changeStatusEmoji", r#"["x"]"#), ("scheduled", "[]"), ("scheduled", "[null]"), ("scheduled", r#"[{"chatId":null,"lean":null}]"#),
        ("report", r#"[{},"spam"]"#), ("sendEncrypted", r#"["c","id",{}]"#), ("publishPost", r#"["u","post"]"#), ("register", r#"["u","p","n","c","r"]"#)] {
        assert!(call(op, good).is_some(), "{op}({good})");
    }
    // …and refused with an argument too many, one missing, or one of another kind.
    for (op, bad) in [("health", "[1]"), ("health", "[null]"), ("login", r#"["u","p"]"#), ("login", r#"["u","p","w","x"]"#), ("login", r#"["u","p",null]"#), ("login", r#"["u",5,"w"]"#), ("users", "[]"), ("users", "[null]"), ("users", "[5]"),
        ("users", r#"[["q"]]"#), ("users", r#"[{"q":1}]"#), ("users", "[true]"), ("inboxPage", r#"["d","c","5"]"#), ("inboxPage", r#"["d","c"]"#), ("inboxPage", r#"["d","c",null]"#), ("chatSettings", r#"["c"]"#), ("chatSettings", r#"["c",null]"#),
        ("chatSettings", r#"["c",[]]"#), ("chatSettings", r#"["c","{}"]"#), ("chatSettings", r#"[5,{}]"#), ("messages", r#"["c","5"]"#), ("messages", r#"["c",true]"#), ("messages", r#"["c",5,6]"#), ("createRoom", r#"[{"0":"a"}]"#), ("createRoom", r#"["a"]"#),
        ("createRoom", r#"[["a"],5]"#), ("changeStatusEmoji", "[]"), ("changeStatusEmoji", "[5]"), ("changeStatusEmoji", "[false]"), ("scheduled", "[5]"), ("scheduled", r#"["x"]"#), ("scheduled", "[[]]"), ("scheduled", r#"[{"chatId":5}]"#),
        ("scheduled", r#"[{"lean":"yes"}]"#), ("scheduled", r#"[{"lean":1}]"#), ("scheduled", r#"[{},{}]"#), ("report", r#"["u","spam"]"#), ("report", r#"[{},null]"#), ("report", r#"[{},"spam",5]"#), ("sendEncrypted", r#"["c","id","{}"]"#),
        ("sendEncrypted", r#"["c","id",{},5]"#), ("publishPost", r#"["u","post",false]"#), ("register", r#"["u","p","n","c","r",5]"#), ("read", r#"["c","7"]"#), ("setMemberRoles", r#"["c","u","r"]"#), ("setMemberRoles", r#"["c","u",{}]"#),
        ("editChannelMessage", r#"["c","ch","7","text"]"#), ("editChannelMessage", r#"["c","ch",7]"#), ("callPermission", r#"["u",true]"#), ("banMember", r#"["c","u",{}]"#)] {
        assert_eq!(call(op, bad), None, "{op}({bad})");
    }
    // The device: read only by the members that send it, and refused there when a field is missing or of another kind.
    let login = args(r#"["u","p","w"]"#);
    for bad in ["null", "[]", r#""iPhone""#, "{}", r#"{"platform":"ios","appVersion":"1"}"#, r#"{"deviceName":"iPhone","appVersion":"1"}"#, r#"{"deviceName":"iPhone","platform":"ios"}"#, r#"{"deviceName":5,"platform":"ios","appVersion":"1"}"#,
        r#"{"deviceName":"iPhone","platform":null,"appVersion":"1"}"#, r#"{"deviceName":"iPhone","platform":"ios","appVersion":1}"#, r#"{"deviceName":"iPhone","platform":"ios","appVersion":"1","deviceModel":5}"#,
        r#"{"deviceName":"iPhone","platform":"ios","appVersion":"1","osVersion":["18"]}"#] {
        let bad_device = parse(bad);
        assert_eq!(api::call("login", &login, &bad_device), None, "login on {bad}");
        assert_eq!(api::call("register", &args(r#"["u","p","n","c","r"]"#), &bad_device), None, "register on {bad}");
        assert_eq!(api::call("health", &[], &bad_device).map(|call| call.path), Some("/health".to_string()));
        assert_eq!(api::call("messages", &args(r#"["c"]"#), &bad_device).map(|call| call.path), Some("/chats/c/messages?lean=1&limit=50".to_string()), "messages on {bad}");
    }
    for bad in ["null", "{}", r#"{"deviceName":null}"#, r#"{"deviceName":5}"#] {
        assert_eq!(api::call("verifyRecovery", &args(r#"["u","w"]"#), &parse(bad)), None, "{bad}");
        assert_eq!(api::call("registerCryptoDevice", &args(r#"["d",{}]"#), &parse(bad)), None, "{bad}");
    }
    assert!(api::call("verifyRecovery", &args(r#"["u","w"]"#), &parse(r#"{"deviceName":"iPhone"}"#)).is_some());
}

/// `encodeURIComponent` over every UTF-16 code unit and pair boundary, against the rule itself (the vectors pin it to Node).
#[test]
fn encode_uri_component_over_all_code_units() {
    for unit in 0u32..=0xffff {
        let got = api::encode_uri_component(&JsString(vec![unit as u16]));
        match char::from_u32(unit) {
            None => assert_eq!(got, None, "{unit:04x}"),
            Some(character) if character.is_ascii_alphanumeric() || "-_.!~*'()".contains(character) => assert_eq!(got, Some(character.to_string())),
            Some(character) => assert_eq!(got, Some(character.to_string().bytes().map(|byte| format!("%{byte:02X}")).collect::<String>()), "{unit:04x}"),
        }
    }
    assert_eq!(api::encode_uri_component(&JsString(vec![0xd83d, 0xde00])).as_deref(), Some("%F0%9F%98%80"));
    assert_eq!(api::encode_uri_component(&JsString(vec![0xdbff, 0xdfff])).as_deref(), Some("%F4%8F%BF%BF"));
    for bad in [vec![0xd83d], vec![0xde00, 0xd83d], vec![0xd83d, 0x41], vec![0x41, 0xd83d], vec![0xd83d, 0xd83d, 0xde00], vec![0xd83d, 0xde00, 0xde00]] {
        assert_eq!(api::encode_uri_component(&JsString(bad.clone())), None, "{bad:04x?}");
    }
}
