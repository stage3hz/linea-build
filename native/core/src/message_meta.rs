//! Message features that travel INSIDE the end-to-end encrypted body: their shape rules.
//!
//! Reference: `mobile/src/messageMeta.ts` (`validMeta`, `validAction`) and `mobile/src/format/entities.ts`
//! (`validEntities`, `validLinkUrl`). The server stores and relays these as ordinary ciphertext and cannot tell a
//! reply, an edit, a reaction or a pin from a normal message — so the only check is this one, on the device,
//! after decryption. Anything that does not fit exactly is refused.

use crate::json::{JsString, Value};

/// The reactions a message may carry (the reference's list, in its order).
pub const REACTIONS: [&str; 42] = ["👍", "❤️", "😂", "😮", "😢", "🔥", "👎", "🎉", "🙏", "👏", "🤔", "💯", "😍", "🥰", "😁", "🤣", "😎", "🤯", "😱", "🤬", "🥺", "😭", "🤡", "💩", "👀", "💀", "🫡", "🤝", "✍️", "🙈", "😴", "🤗", "🍾", "💔", "⚡", "🏆", "🥶", "😈", "🫶", "✅", "❌", "👌"];
pub const AUTO_DELETE: [f64; 4] = [0.0, 86400.0, 604800.0, 2592000.0];
pub const POLL_QUESTION: usize = 255;
pub const POLL_OPTION: usize = 100;
pub const POLL_MIN_OPTIONS: usize = 2;
pub const POLL_MAX_OPTIONS: usize = 10;
pub const ENTITY_COUNT: usize = 100;
pub const ENTITY_URL: usize = 2048;
pub const ENTITY_LANGUAGE: usize = 32;
pub const ENTITY_TEXT: f64 = 8000.0;
const ENTITY_TYPES: [&str; 9] = ["bold", "italic", "underline", "strikethrough", "code", "pre", "spoiler", "quote", "text_link"];

type Entries = [(JsString, Value)];

fn record(value: &Value) -> Option<&Entries> { match value { Value::Object(entries) => Some(entries), _ => None } }
fn field<'a>(entries: &'a Entries, key: &str) -> Option<&'a Value> {
    let wanted = JsString::from_str(key);
    entries.iter().find(|(name, _)| *name == wanted).map(|(_, value)| value)
}
fn only(entries: &Entries, keys: &[&str]) -> bool {
    entries.iter().all(|(name, _)| keys.iter().any(|key| name.0.iter().copied().eq(key.encode_utf16())))
}
fn units(value: Option<&Value>) -> Option<&Vec<u16>> { match value { Some(Value::String(text)) => Some(&text.0), _ => None } }
fn is(value: Option<&Value>, word: &str) -> bool { units(value).is_some_and(|text| text.iter().copied().eq(word.encode_utf16())) }
fn boolean(value: Option<&Value>) -> bool { matches!(value, Some(Value::Bool(_))) }
/// `Number.isInteger`.
fn integer(value: Option<&Value>) -> Option<f64> { match value { Some(Value::Number(n)) if n.is_finite() && n.fract() == 0.0 => Some(*n), _ => None } }

/// What JavaScript's `trim` and `\s` call white space, as a UTF-16 code unit.
fn js_space(unit: u16) -> bool {
    matches!(unit, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
/// A string no longer than `max` code units and (unless `allow_empty`) not blank.
fn text(value: Option<&Value>, max: usize, allow_empty: bool) -> bool {
    units(value).is_some_and(|text| text.len() <= max && (allow_empty || text.iter().any(|unit| !js_space(*unit))))
}
/// `8-4-4-4-12` hex digits, either case.
fn uuid(value: Option<&Value>) -> bool {
    let Some(text) = units(value) else { return false };
    if text.len() != 36 { return false }
    text.iter().enumerate().all(|(index, unit)| if matches!(index, 8 | 13 | 18 | 23) { *unit == b'-' as u16 } else { u8::try_from(*unit).is_ok_and(|byte| byte.is_ascii_hexdigit()) })
}

/// A link a message may carry: `http://` or `https://` followed by anything without white space.
pub fn valid_link_url(value: Option<&Value>) -> bool {
    let Some(text) = units(value) else { return false };
    if text.len() > ENTITY_URL { return false }
    let lower: Vec<u16> = text.iter().take(8).map(|unit| if (b'A' as u16..=b'Z' as u16).contains(unit) { unit + 32 } else { *unit }).collect();
    let rest = if lower.starts_with(&"https://".encode_utf16().collect::<Vec<_>>()) { &text[8..] } else if lower.starts_with(&"http://".encode_utf16().collect::<Vec<_>>()) { &text[7..] } else { return false };
    !rest.is_empty() && rest.iter().all(|unit| !js_space(*unit))
}

/// Shape check for an `entities` array that arrived inside a decrypted payload. `text_length` (UTF-16 code
/// units) bounds the offsets.
pub fn valid_entities(value: Option<&Value>, text_length: f64) -> bool {
    let Some(Value::Array(items)) = value else { return false };
    if items.len() > ENTITY_COUNT { return false }
    items.iter().all(|item| {
        let Some(entries) = record(item) else { return false };
        if !only(entries, &["type", "offset", "length", "url", "language"]) { return false }
        let kind = field(entries, "type");
        if !ENTITY_TYPES.iter().any(|name| is(kind, name)) { return false }
        let (Some(offset), Some(length)) = (integer(field(entries, "offset")), integer(field(entries, "length"))) else { return false };
        if offset < 0.0 || length < 1.0 || offset + length > text_length { return false }
        let url = field(entries, "url");
        if is(kind, "text_link") { if !valid_link_url(url) { return false } } else if url.is_some() { return false }
        if let Some(language) = field(entries, "language") {
            if !is(kind, "pre") || !units(Some(language)).is_some_and(|text| text.len() <= ENTITY_LANGUAGE) { return false }
        }
        true
    })
}
fn entity_count(value: Option<&Value>) -> usize { match value { Some(Value::Array(items)) => items.len(), _ => 0 } }

fn valid_action(value: &Value) -> bool {
    let Some(entries) = record(value) else { return false };
    let get = |key: &str| field(entries, key);
    let kind = get("type");
    if is(kind, "edit") {
        let Some(body) = units(get("text")) else { return false };
        return only(entries, &["type", "target", "text", "entities"]) && uuid(get("target")) && text(get("text"), 8000, false)
            && (get("entities").is_none() || (valid_entities(get("entities"), body.len() as f64) && entity_count(get("entities")) > 0));
    }
    if is(kind, "delete") { return only(entries, &["type", "target"]) && uuid(get("target")) }
    if is(kind, "react") {
        return only(entries, &["type", "target", "emoji"]) && uuid(get("target"))
            && (matches!(get("emoji"), Some(Value::Null)) || REACTIONS.iter().any(|emoji| is(get("emoji"), emoji)));
    }
    if is(kind, "pin") { return only(entries, &["type", "target"]) && (matches!(get("target"), Some(Value::Null)) || uuid(get("target"))) }
    if is(kind, "vote") {
        let Some(Value::Array(options)) = get("options") else { return false };
        if !only(entries, &["type", "target", "options"]) || !uuid(get("target")) || options.len() > POLL_MAX_OPTIONS { return false }
        let picked: Option<Vec<f64>> = options.iter().map(|option| integer(Some(option)).filter(|index| *index >= 0.0 && *index < POLL_MAX_OPTIONS as f64)).collect();
        let Some(picked) = picked else { return false };
        return picked.iter().enumerate().all(|(at, index)| !picked[..at].contains(index));
    }
    if is(kind, "call") {
        if !only(entries, &["type", "call", "step", "video", "sdp", "reason", "duration", "caller", "gen"]) || !uuid(get("call")) { return false }
        let step = get("step");
        let (end, restart) = (is(step, "end"), is(step, "restart") || is(step, "restart-answer"));
        if !(is(step, "offer") || is(step, "answer") || end || restart) { return false }
        // An ICE restart is numbered (1 … 100 000); nothing else carries a number.
        if restart { if !integer(get("gen")).is_some_and(|gen| (1.0..=100_000.0).contains(&gen)) { return false } } else if get("gen").is_some() { return false }
        if get("video").is_some() && !boolean(get("video")) { return false }
        match get("sdp") {
            None => if !end { return false },
            Some(sdp) => {
                let Some(body) = units(Some(sdp)) else { return false };
                if end || body.len() > 60000 || !body.starts_with(&"v=0".encode_utf16().collect::<Vec<_>>()) { return false }
            }
        }
        if get("reason").is_some() && !["hangup", "declined", "busy", "missed", "failed"].iter().any(|reason| is(get("reason"), reason)) { return false }
        // The outcome belongs to the `end` only: a week is the longest call anyone will believe.
        if get("duration").is_some() && !(end && integer(get("duration")).is_some_and(|seconds| (0.0..=7.0 * 86400.0).contains(&seconds))) { return false }
        if get("caller").is_some() && !(end && boolean(get("caller"))) { return false }
        return true;
    }
    if is(kind, "settings") {
        return only(entries, &["type", "ttl", "noCopy"]) && matches!(get("ttl"), Some(Value::Number(ttl)) if AUTO_DELETE.contains(ttl)) && boolean(get("noCopy"));
    }
    if is(kind, "clear") { return only(entries, &["type"]) }
    false
}

/// Whether the `meta` of a decrypted message is one this app would have made. `None`: the message has no meta.
pub fn valid_meta(value: Option<&Value>) -> bool {
    let Some(value) = value else { return true };
    let Some(entries) = record(value) else { return false };
    if !only(entries, &["reply", "forward", "action", "album", "poll", "entities", "story", "silent"]) || entries.is_empty() { return false }
    let get = |key: &str| field(entries, key);
    if get("silent").is_some() && !matches!(get("silent"), Some(Value::Bool(true))) { return false }
    if let Some(story) = get("story") {
        // A story reference is a quote of its own: never together with a reply quote.
        let Some(story) = record(story) else { return false };
        if !only(story, &["id", "ownerId"]) || !uuid(field(story, "id")) || !uuid(field(story, "ownerId")) || get("reply").is_some() { return false }
    }
    if get("entities").is_some() && (!valid_entities(get("entities"), ENTITY_TEXT) || entity_count(get("entities")) == 0) { return false }
    if let Some(reply) = get("reply") {
        let Some(reply) = record(reply) else { return false };
        if !only(reply, &["clientId", "senderId", "preview"]) || !uuid(field(reply, "clientId")) || !uuid(field(reply, "senderId")) || !text(field(reply, "preview"), 200, true) { return false }
    }
    if let Some(forward) = get("forward") {
        let Some(forward) = record(forward) else { return false };
        if !only(forward, &["from"]) || !text(field(forward, "from"), 80, false) { return false }
    }
    // An action is a message of its own: nothing rides with it.
    if let Some(action) = get("action") { if !valid_action(action) || entries.len() != 1 { return false } }
    if let Some(album) = get("album") {
        let Some(album) = record(album) else { return false };
        let (Some(count), Some(index)) = (integer(field(album, "count")), integer(field(album, "index"))) else { return false };
        if !only(album, &["id", "index", "count"]) || !uuid(field(album, "id")) || !(2.0..=10.0).contains(&count) || index < 0.0 || index >= count { return false }
    }
    if let Some(poll) = get("poll") {
        let Some(poll) = record(poll) else { return false };
        let Some(Value::Array(options)) = field(poll, "options") else { return false };
        if !only(poll, &["question", "options", "multiple"]) || !text(field(poll, "question"), POLL_QUESTION, false) || !boolean(field(poll, "multiple"))
            || options.len() < POLL_MIN_OPTIONS || options.len() > POLL_MAX_OPTIONS || !options.iter().all(|option| text(Some(option), POLL_OPTION, false)) || get("album").is_some() { return false }
    }
    true
}
