//! What a chat shows: the raw (decrypted) messages folded into the visible history, and the lines the chat list,
//! a reply quote and an older client show for a message.
//!
//! Reference: `mobile/src/messageMeta.ts` from `messageKey` to `pollFallback` (`foldChat`, `listPreviewMessage`,
//! `chatListText`, `callPreview`, `replyPreview`, `pollFallback`, `actionFallback`, `editInTime`, `editWindowOpen`,
//! `isQuietAction`, `isAction`, `isCallSignal`, `skippedInList`, `isCallEnd`, `dedupeCallEnds`, `withEdit`), with the
//! helpers these call in other files: `maskSpoilers` (`format/entities.ts`), `attachmentLabel`, `isVoice`,
//! `isVideoNote`, `formatVoiceTime` (`voice/voice.ts`), `formatCallDuration` (`calls/callModel.ts`) and
//! `autoDeleteLabel` (`messageMeta.ts`). Pinned to the reference by `tests/chat_view_vectors.rs`
//! (vectors from `tests/generate-chat-view-vectors.mjs`, which runs the reference itself).
//!
//! Messages are JSON values in the reference's shapes (`Message` of `mobile/src/types.ts`); a field that is absent
//! is JavaScript's `undefined`. Texts are UTF-16 (`JsString`): the reference cuts them by code units
//! (`slice(0, 200)`), which can leave half of a surrogate pair — kept as it is.
//!
//! Dates: the reference reads them with `Date.parse`, this module with `time::parse_iso_ms` (ISO forms only).
//! A date in another spelling («Nov 21 2026», or a date-time without a zone) is «not a date» here.

use crate::json::{self, JsString, Value};
use crate::message_meta::REACTIONS;
use crate::time::parse_iso_ms;
use std::collections::{HashMap, HashSet};

/// Telegram: a message can be edited for 48 hours after it was sent.
pub const EDIT_WINDOW_MS: f64 = 48.0 * 3_600_000.0;
/// Clocks of two phones differ: an edit up to this much past the window is still taken.
pub const EDIT_CLOCK_SKEW_MS: f64 = 10.0 * 60_000.0;

// ---- JavaScript's view of a JSON value ----

/// `value?.key`: the field of an object; anything else has no fields.
fn field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> { value.and_then(|value| value.get(key)) }
/// `value === 'word'`.
fn is(value: Option<&Value>, word: &str) -> bool { matches!(value, Some(Value::String(text)) if text.0.iter().copied().eq(word.encode_utf16())) }
/// `!!value`.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => *number != 0.0 && !number.is_nan(),
        Some(Value::String(text)) => !text.0.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}
/// The number, or NaN for anything that is not one.
fn number(value: Option<&Value>) -> f64 { match value { Some(Value::Number(number)) => *number, _ => f64::NAN } }
/// The code units of a string; nothing for anything that is not one.
fn units(value: Option<&Value>) -> &[u16] { match value { Some(Value::String(text)) => &text.0, _ => &[] } }
fn utf16(text: &str) -> Vec<u16> { text.encode_utf16().collect() }
fn array(value: Option<&Value>) -> &[Value] { match value { Some(Value::Array(items)) => items, _ => &[] } }
/// `Date.parse` for the ISO forms (NaN otherwise).
fn date(value: Option<&Value>) -> f64 {
    match value { Some(Value::String(text)) => text.to_str().and_then(|text| parse_iso_ms(&text)).unwrap_or(f64::NAN), _ => f64::NAN }
}
/// `message.meta?.action`, when it is there (`if (!action)` is the reference's test).
fn action_of(message: &Value) -> Option<&Value> { field(message.get("meta"), "action").filter(|action| truthy(Some(action))) }
/// The order `(a, b) => a.id - b.id` gives (equal ids keep their places). −0 and +0 are one id; an id that is not a
/// number has no place of its own in JavaScript either.
fn id_key(message: &Value) -> f64 { let id = number(message.get("id")); if id.is_nan() { f64::NAN } else { id + 0.0 } }
/// Sets a key the way `{...object, key: value}` does: in its old place, or at the end.
fn set(entries: &mut Vec<(JsString, Value)>, key: &str, value: Value) {
    let key = JsString::from_str(key);
    match entries.iter_mut().find(|(name, _)| *name == key) { Some(entry) => entry.1 = value, None => entries.push((key, value)) }
}
fn entries_of(value: &Value) -> Vec<(JsString, Value)> { match value { Value::Object(entries) => entries.clone(), _ => Vec::new() } }

/// What JavaScript's `trim` and `\s` call white space, as a UTF-16 code unit.
fn js_space(unit: u16) -> bool {
    matches!(unit, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
fn trim(text: &[u16]) -> &[u16] {
    let Some(start) = text.iter().position(|unit| !js_space(*unit)) else { return &[] };
    let end = text.iter().rposition(|unit| !js_space(*unit)).expect("found from the start") + 1;
    &text[start..end]
}
/// `text.slice(0, max)`.
fn head(text: &[u16], max: usize) -> &[u16] { &text[..text.len().min(max)] }
/// `text.slice(from, to)` for any two numbers.
fn slice(text: &[u16], from: f64, to: f64) -> &[u16] {
    let at = |position: f64| -> usize {
        if position.is_nan() { return 0 }
        let position = position.trunc();
        if position < 0.0 { (text.len() as f64 + position).max(0.0) as usize } else { position.min(text.len() as f64) as usize }
    };
    let (from, to) = (at(from), at(to));
    if to > from { &text[from..to] } else { &[] }
}
/// `Math.max` / `Math.min` of two numbers (NaN wins, unlike Rust's).
fn js_max(a: f64, b: f64) -> f64 { if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) } }
fn js_min(a: f64, b: f64) -> f64 { if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) } }
/// `String(n).padStart(2, '0')` for a whole number.
fn two_digits(value: f64) -> String { let text = json::number_text(value); if text.len() < 2 { format!("0{text}") } else { text } }

// ---- small questions about one message ----

/// `senderId:clientId` — how a message is named across both phones.
pub fn message_key(message: &Value) -> JsString {
    let mut key = units(message.get("senderId")).to_vec();
    key.push(b':' as u16);
    key.extend_from_slice(units(message.get("clientId")));
    JsString(key)
}

fn in_time(sent: f64, edit: f64) -> bool { !sent.is_finite() || !edit.is_finite() || edit - sent <= EDIT_WINDOW_MS + EDIT_CLOCK_SKEW_MS }
/// Whether an edit sent at `edit_at` applies to a message sent at `sent_at` (both from the author's clock).
/// Unknown times are not held against it.
pub fn edit_in_time(sent_at: &str, edit_at: &str) -> bool {
    in_time(parse_iso_ms(sent_at).unwrap_or(f64::NAN), parse_iso_ms(edit_at).unwrap_or(f64::NAN))
}
/// Whether the message sent at `created_at` may still be edited at `now_ms`.
pub fn edit_window_open(created_at: &str, now_ms: f64) -> bool {
    parse_iso_ms(created_at).is_some_and(|sent| now_ms - sent < EDIT_WINDOW_MS)
}

/// Not shown in the chat list: a reaction, an unpin, a poll vote, an edit or a deletion changes another message.
pub fn is_quiet_action(message: &Value) -> bool {
    let Some(action) = action_of(message) else { return false };
    let kind = action.get("type");
    is(kind, "react") || is(kind, "vote") || is(kind, "edit") || is(kind, "delete") || (is(kind, "pin") && !truthy(action.get("target")))
}
pub fn is_action(message: &Value) -> bool { action_of(message).is_some() }
/// A call offer or answer only carries the SDP: invisible in the chat, so not the list line either (the `end` is).
pub fn is_call_signal(message: &Value) -> bool {
    let action = field(message.get("meta"), "action");
    is(field(action, "type"), "call") && !is(field(action, "step"), "end")
}
/// The chat list looks past this message for the line to show.
pub fn skipped_in_list(message: &Value) -> bool { is_quiet_action(message) || is_call_signal(message) }
/// A readable `end` of a call: decrypted here, or one whose meta arrived without a crypto state.
pub fn is_call_end(message: &Value) -> bool {
    let Some(action) = action_of(message) else { return false };
    let state = message.get("cryptoState");
    is(action.get("type"), "call") && is(action.get("step"), "end") && (state.is_none() || is(state, "decrypted"))
}

fn dedupe_refs<'a>(messages: &[&'a Value]) -> Vec<&'a Value> {
    let mut kept: Vec<&'a Value> = Vec::new();
    let mut by_call: HashMap<&[u16], usize> = HashMap::new();
    for message in messages.iter().copied() {
        if !is_call_end(message) { continue }
        let action = action_of(message).expect("a call end has an action");
        let call = units(action.get("call"));
        let Some(&at) = by_call.get(call) else { by_call.insert(call, kept.len()); kept.push(message); continue };
        let (known, kept_known) = (action.get("duration").is_some(), action_of(kept[at]).expect("kept as a call end").get("duration").is_some());
        let better = (known && !kept_known) || (known == kept_known && number(message.get("id")) < number(kept[at].get("id")));
        if better { kept[at] = message }
    }
    kept
}
/// The one `end` to show per call (both phones may have sent one): the one that knows the duration, else the
/// earliest. In the order the calls first appear.
pub fn dedupe_call_ends(messages: &[Value]) -> Vec<Value> {
    dedupe_refs(&messages.iter().collect::<Vec<_>>()).into_iter().cloned().collect()
}

/// The message with an edit applied: new text, and the edit's formatting replaces the old one.
pub fn with_edit(message: &Value, text: &Value, entities: Option<&Value>) -> Value {
    let mut meta = message.get("meta").map(entries_of).unwrap_or_default();
    meta.retain(|(name, _)| !name.0.iter().copied().eq("entities".encode_utf16()));
    if let Some(entities) = entities { if !array(Some(entities)).is_empty() { meta.push((JsString::from_str("entities"), entities.clone())) } }
    let mut out = entries_of(message);
    set(&mut out, "text", text.clone());
    // `meta: undefined` when nothing is left: the key is there in JavaScript, and never written.
    if meta.is_empty() { out.retain(|(name, _)| !name.0.iter().copied().eq("meta".encode_utf16())) } else { set(&mut out, "meta", Value::Object(meta)) }
    Value::Object(out)
}

// ---- texts ----

/// `maskSpoilers`: the text of a spoiler is replaced by ▒ so a glance at the list reveals nothing.
fn mask_spoilers(text: &[u16], entities: Option<&Value>) -> Vec<u16> {
    let mut spoilers: Vec<(f64, f64)> = array(entities).iter().filter(|entity| is(entity.get("type"), "spoiler")).map(|entity| (number(entity.get("offset")), number(entity.get("length")))).collect();
    if spoilers.is_empty() { return text.to_vec() }
    spoilers.sort_by(|a, b| (a.0 + 0.0).total_cmp(&(b.0 + 0.0)));
    let length = text.len() as f64;
    let (mut out, mut position): (Vec<u16>, f64) = (Vec::new(), 0.0);
    for (offset, count) in spoilers {
        let (start, end) = (js_max(position, js_min(length, offset)), js_min(length, offset + count));
        if end <= start { continue }
        out.extend_from_slice(slice(text, position, start));
        // `Array.from(hidden.replace(/\s+/g, '')).length`: characters, a surrogate pair being one.
        let hidden: Vec<u16> = slice(text, start, end).iter().copied().filter(|unit| !js_space(*unit)).collect();
        let pairs = hidden.windows(2).filter(|pair| (0xd800..=0xdbff).contains(&pair[0]) && (0xdc00..=0xdfff).contains(&pair[1])).count();
        out.extend(std::iter::repeat(0x2592).take((hidden.len() - pairs).clamp(1, 12)));
        position = end;
    }
    out.extend_from_slice(slice(text, position, f64::INFINITY));
    out
}

/// `formatCallDuration`: 0:42, 3:12, 1:02:05 (hours appear only from the first full hour).
fn format_call_duration(seconds: f64) -> String {
    let total = if seconds.is_finite() { seconds.floor().max(0.0) } else { 0.0 };
    let (h, m, s) = ((total / 3600.0).floor(), ((total % 3600.0) / 60.0).floor(), total % 60.0);
    if h != 0.0 { format!("{}:{}:{}", json::number_text(h), two_digits(m), two_digits(s)) } else { format!("{}:{}", json::number_text(m), two_digits(s)) }
}

/// Chat-list line (and fallback text) for a finished call; `action` is a `call` action. It names no direction:
/// the same text is stored by the sender and shown on both phones.
pub fn call_preview(action: &Value) -> JsString {
    let video = truthy(action.get("video"));
    let (icon, noun, lower) = if video { ("📹", "Видеозвонок", "видеозвонок") } else { ("📞", "Звонок", "звонок") };
    let reason = action.get("reason");
    let text = if is(reason, "missed") { format!("{icon} Пропущенный {lower}") }
        else if is(reason, "declined") || is(reason, "busy") { format!("{icon} Отклонённый {lower}") }
        else if is(reason, "failed") { format!("{icon} {noun} не удался") }
        else { match action.get("duration") { None => format!("{icon} {noun}"), Some(duration) => format!("{icon} {noun} · {}", format_call_duration(number(Some(duration)))) } };
    JsString::from_str(&text)
}

/// Chat-list line for a message: plain text with spoilers hidden (▒), formatting dropped; a finished call reads
/// as `call_preview`.
pub fn chat_list_text(message: &Value) -> JsString {
    let action = field(message.get("meta"), "action");
    if is(field(action, "type"), "call") && is(field(action, "step"), "end") { return call_preview(action.expect("it has a type")) }
    JsString(mask_spoilers(units(message.get("text")), field(message.get("meta"), "entities")))
}

/// `attachmentLabel`: short human label for previews.
fn attachment_label(attachment: &Value) -> Vec<u16> {
    let (name, mime) = (units(attachment.get("name")), units(attachment.get("mimeType")));
    // `^prefix-\d{1,16}\.ext$`
    let named = |prefix: &str, extension: &str| -> bool {
        let (prefix, extension) = (utf16(prefix), utf16(extension));
        if !name.starts_with(&prefix) || !name.ends_with(&extension) || name.len() < prefix.len() + extension.len() { return false }
        let digits = &name[prefix.len()..name.len() - extension.len()];
        (1..=16).contains(&digits.len()) && digits.iter().all(|unit| (b'0' as u16..=b'9' as u16).contains(unit))
    };
    if mime == utf16("audio/mp4") && named("voice-", ".m4a") {
        let ms = field(attachment.get("media"), "durationMs");
        let mut label = "🎤 Голосовое сообщение".to_string();
        if truthy(ms) {
            // `formatVoiceTime`
            let ms = number(ms);
            let total = ((if ms.is_finite() { ms } else { 0.0 }) / 1000.0).floor().max(0.0);
            label.push_str(&format!(" · {}:{}", json::number_text((total / 60.0).floor()), two_digits(total % 60.0)));
        }
        return utf16(&label);
    }
    if mime == utf16("video/mp4") && named("circle-", ".mp4") { return utf16("Видеосообщение") }
    if mime.starts_with(&utf16("image/")) { return utf16("🖼 Фотография") }
    if mime.starts_with(&utf16("video/")) { return utf16("🎬 Видео") }
    let mut label = utf16("📎 ");
    label.extend_from_slice(name);
    label
}

/// Plain-text one-line quote for a reply (at most 200 code units).
pub fn reply_preview(message: &Value) -> JsString {
    let poll = field(message.get("meta"), "poll");
    if truthy(poll) {
        let mut line = utf16("📊 ");
        line.extend_from_slice(units(field(poll, "question")));
        return JsString(head(&line, 200).to_vec());
    }
    // Formatting is dropped in a quote; a spoiler stays hidden. `.trim().replace(/\s+/g, ' ')`.
    let masked = mask_spoilers(units(message.get("text")), field(message.get("meta"), "entities"));
    let mut body: Vec<u16> = Vec::new();
    let mut in_space = false;
    for unit in trim(&masked).iter().copied() {
        if !js_space(unit) { body.push(unit); in_space = false } else if !in_space { body.push(0x20); in_space = true }
    }
    if !body.is_empty() { return JsString(head(&body, 200).to_vec()) }
    match message.get("attachment") { attachment if truthy(attachment) => JsString(head(&attachment_label(attachment.expect("truthy")), 200).to_vec()), _ => JsString::default() }
}
/// Fallback text stored with a poll so a chat preview or an older client shows something readable.
pub fn poll_fallback(poll: &Value) -> JsString {
    let mut out = utf16("📊 ");
    out.extend_from_slice(units(poll.get("question")));
    for (index, option) in array(poll.get("options")).iter().enumerate() {
        out.extend(format!("\n{}. ", index + 1).encode_utf16());
        out.extend_from_slice(units(Some(option)));
    }
    JsString(head(&out, 8000).to_vec())
}

/// `autoDeleteLabel`.
fn auto_delete_label(ttl: f64) -> &'static str { if ttl == 86400.0 { "1 день" } else if ttl == 604800.0 { "1 неделя" } else if ttl == 2592000.0 { "1 месяц" } else { "Выкл." } }

/// Readable text an older client (or a chat preview) shows for an action; `target_text` is the text of the message
/// it acts on (may be empty). `None` — the reference's `undefined` — for an action of an unknown type.
pub fn action_fallback(action: &Value, target_text: &JsString) -> Option<JsString> {
    let target = trim(&target_text.0);
    let quoted = |start: &str| -> JsString {
        let mut out = utf16(start);
        if !target.is_empty() { out.extend(utf16(" «")); out.extend_from_slice(head(target, 60)); out.push(0xbb) }
        JsString(out)
    };
    let kind = action.get("type");
    if is(kind, "edit") {
        let mut out = utf16("✏\u{fe0f} Изменено: ");
        out.extend_from_slice(units(action.get("text")));
        return Some(JsString(head(&out, 8000).to_vec()));
    }
    if is(kind, "delete") { return Some(JsString::from_str("🗑 Сообщение удалено")) }
    if is(kind, "react") {
        if !truthy(action.get("emoji")) { return Some(quoted("Реакция убрана")) }
        let mut out = units(action.get("emoji")).to_vec();
        out.extend(quoted(" Реакция на сообщение").0);
        return Some(JsString(out));
    }
    if is(kind, "pin") { return Some(if truthy(action.get("target")) { quoted("Закреплено сообщение") } else { JsString::from_str("Сообщение откреплено") }) }
    if is(kind, "vote") { return Some(if array(action.get("options")).is_empty() { quoted("Голос отменён") } else { quoted("🗳 Голос в опросе") }) }
    if is(kind, "settings") {
        return Some(JsString::from_str(&if truthy(action.get("ttl")) { format!("⏱ Автоудаление: {}", auto_delete_label(number(action.get("ttl")))) }
            else if truthy(action.get("noCopy")) { "🚫 Копирование запрещено".to_string() } else { "⏱ Автоудаление выключено".to_string() }));
    }
    if is(kind, "clear") { return Some(JsString::from_str("🧹 История очищена")) }
    if is(kind, "call") {
        let step = action.get("step");
        return Some(if is(step, "offer") { JsString::from_str(if truthy(action.get("video")) { "📹 Видеозвонок" } else { "📞 Звонок" }) }
            else if is(step, "answer") { JsString::from_str("📞 Звонок принят") }
            else if is(step, "restart") || is(step, "restart-answer") { JsString::from_str("📞 Восстановление связи") }
            else { call_preview(action) });
    }
    None
}

// ---- the chat list's line ----

/// The message the chat list should show: the newest one that is not a quiet action and was not deleted, with its
/// latest edit applied and its spoilers hidden. `None` when the given messages hold none.
pub fn list_preview_message(list: &[Value]) -> Option<Value> {
    let mut sorted: Vec<&Value> = list.iter().collect();
    sorted.sort_by(|a, b| id_key(b).total_cmp(&id_key(a)));
    let mut deleted: HashSet<&[u16]> = HashSet::new();
    // Per `sender:target`, newest first.
    let mut edits: HashMap<Vec<u16>, Vec<&Value>> = HashMap::new();
    for message in sorted.iter().copied() {
        let state = message.get("cryptoState");
        if state.is_some() && !is(state, "decrypted") { continue }
        let action = field(message.get("meta"), "action");
        if is(field(action, "type"), "delete") { deleted.insert(units(field(action, "target"))); }
        if is(field(action, "type"), "edit") {
            // Only the author edits, so an edit's target is the action sender's own message.
            let mut key = units(message.get("senderId")).to_vec();
            key.push(b':' as u16);
            key.extend_from_slice(units(field(action, "target")));
            edits.entry(key).or_default().push(message);
        }
    }
    for message in sorted.iter().copied() {
        if is_quiet_action(message) || is_call_signal(message) || deleted.contains(units(message.get("clientId"))) { continue }
        // The newest edit made within the window (a later one, past 48 h, is ignored).
        let sent = date(message.get("createdAt"));
        let edited = edits.get(&message_key(message).0).and_then(|list| list.iter().copied().find(|edit| in_time(sent, date(edit.get("createdAt")))));
        let shown = match edited {
            Some(edit) if !is_action(message) => { let action = field(edit.get("meta"), "action"); with_edit(message, field(action, "text").unwrap_or(&Value::Null), field(action, "entities")) }
            _ => message.clone(),
        };
        // The list must not give a spoiler away.
        let masked = chat_list_text(&shown);
        if matches!(shown.get("text"), Some(Value::String(text)) if *text == masked) { return Some(shown) }
        let mut out = entries_of(&shown);
        set(&mut out, "text", Value::String(masked));
        return Some(Value::Object(out));
    }
    None
}

// ---- the chat itself ----

/// Applies encrypted actions to the decrypted history, oldest first: what the chat shows.
///
/// Only the author may edit a message (either side may delete one); each participant has at most one reaction per
/// message (the latest wins); the latest pin from either side wins. `hidden_for_me` holds `senderId:clientId` keys.
/// Returns `{"messages":[…],"pinned":message|null,"rules":{"ttl","noCopy"},"nextExpiry":ms|null}`; each message is
/// the raw one (edited when an edit applies) plus `edited`, `reactions` and, for a poll, `poll`. The reference's
/// `byClientId` map is the same messages by their `clientId` and is not repeated.
pub fn fold_chat(messages: &[Value], user_id: &str, hidden_for_me: &[String], now_ms: f64) -> Value {
    let user = utf16(user_id);
    let hidden: HashSet<Vec<u16>> = hidden_for_me.iter().map(|key| utf16(key)).collect();
    let mut ordered: Vec<&Value> = messages.iter().collect();
    ordered.sort_by(|a, b| id_key(a).total_cmp(&id_key(b)));

    // What can be shown, by clientId, in the order each clientId first appeared (a JavaScript Map).
    let mut content: Vec<&Value> = Vec::new();
    let mut place: HashMap<&[u16], usize> = HashMap::new();
    fn put<'a>(content: &mut Vec<&'a Value>, place: &mut HashMap<&'a [u16], usize>, message: &'a Value) {
        match place.get(units(message.get("clientId"))) {
            Some(&at) => content[at] = message,
            None => { place.insert(units(message.get("clientId")), content.len()); content.push(message); }
        }
    }
    for message in ordered.iter().copied() { if !is_action(message) { put(&mut content, &mut place, message) } }
    // A finished call is a service row in the chat, one per call even when both phones sent an `end`; offers and
    // answers stay invisible (they only carry the SDP).
    for message in dedupe_refs(&ordered) { put(&mut content, &mut place, message) }
    let author_of = |target: &[u16]| -> Option<&Value> { place.get(target).and_then(|&at| content[at].get("senderId")) };

    // Rules in force at each moment: a message keeps the auto-delete that applied when it was sent.
    let (mut rules_ttl, mut rules_no_copy) = (Value::Number(0.0), Value::Bool(false));
    let mut cleared_before = 0.0;
    let zero = Value::Number(0.0);
    let mut ttl_of: HashMap<&[u16], &Value> = HashMap::new();
    {
        let mut ttl_now: &Value = &zero;
        for message in ordered.iter().copied() {
            let Some(action) = action_of(message) else { ttl_of.insert(units(message.get("clientId")), ttl_now); continue };
            if !is(message.get("cryptoState"), "decrypted") { continue }
            if is(action.get("type"), "settings") {
                ttl_now = action.get("ttl").unwrap_or(&Value::Null);
                rules_ttl = ttl_now.clone();
                rules_no_copy = action.get("noCopy").cloned().unwrap_or(Value::Null);
                continue;
            }
            if is(action.get("type"), "clear") { cleared_before = number(message.get("id")); continue }
        }
    }

    let mut edits: HashMap<&[u16], &Value> = HashMap::new(); // target → the edit action
    let mut deleted: HashSet<&[u16]> = HashSet::new();
    // Per target, in a Map's order: who → which emoji / which options.
    let mut reactions: HashMap<&[u16], Vec<(&[u16], &Value)>> = HashMap::new();
    let mut votes: HashMap<&[u16], Vec<(&[u16], Vec<f64>)>> = HashMap::new();
    let mut pin: Option<&Value> = None;
    for message in ordered.iter().copied() {
        let Some(action) = action_of(message) else { continue };
        if !is(message.get("cryptoState"), "decrypted") { continue }
        let kind = action.get("type");
        if is(kind, "call") || is(kind, "settings") || is(kind, "clear") { continue }
        if is(kind, "pin") { pin = action.get("target"); continue }
        let target = units(action.get("target"));
        let author = author_of(target);
        let sender = units(message.get("senderId"));
        if is(kind, "edit") || is(kind, "delete") {
            // Edits: only the author. Deletes: in a one-to-one chat either side may delete any message for both.
            // Unknown targets are ignored.
            if !truthy(author) || (is(kind, "edit") && author != message.get("senderId")) { continue }
            if is(kind, "edit") {
                if in_time(date(content[place[target]].get("createdAt")), date(message.get("createdAt"))) { edits.insert(target, action); }
            } else { deleted.insert(target); }
            continue;
        }
        if !truthy(author) { continue }
        if is(kind, "vote") {
            let poll = field(content[place[target]].get("meta"), "poll");
            let options = array(action.get("options"));
            if !truthy(poll) || options.iter().any(|index| number(Some(index)) >= array(field(poll, "options")).len() as f64) || (!truthy(field(poll, "multiple")) && options.len() > 1) { continue }
            let per_voter = votes.entry(target).or_default();
            if options.is_empty() { per_voter.retain(|(voter, _)| *voter != sender) } else {
                let mut chosen: Vec<f64> = options.iter().map(|index| number(Some(index))).collect();
                chosen.sort_by(|a, b| a.total_cmp(b));
                match per_voter.iter_mut().find(|(voter, _)| *voter == sender) { Some(entry) => entry.1 = chosen, None => per_voter.push((sender, chosen)) }
            }
            continue;
        }
        let per_user = reactions.entry(target).or_default();
        match action.get("emoji") {
            emoji if truthy(emoji) => { let emoji = emoji.expect("truthy"); match per_user.iter_mut().find(|(reactor, _)| *reactor == sender) { Some(entry) => entry.1 = emoji, None => per_user.push((sender, emoji)) } }
            _ => per_user.retain(|(reactor, _)| *reactor != sender),
        }
    }

    let mut view: Vec<Value> = Vec::new();
    // `null` until the first message that expires; NaN once a message under auto-delete has no readable date.
    let mut next_expiry: Option<f64> = None;
    for message in content.iter().copied() {
        let client_id = units(message.get("clientId"));
        if deleted.contains(client_id) || hidden.contains(&message_key(message).0) { continue }
        let id = number(message.get("id"));
        if id > 0.0 && id < cleared_before { continue }
        let ttl = ttl_of.get(client_id).copied();
        if truthy(ttl) {
            let expires = date(message.get("createdAt")) + number(ttl) * 1000.0;
            if expires <= now_ms { continue }
            if next_expiry.is_none_or(|next| expires < next) { next_expiry = Some(expires) }
        }
        // One line per emoji, in the order the emoji first appear, then in the order of REACTIONS.
        let mut summary: Vec<(&Value, f64, bool)> = Vec::new();
        for (reactor, emoji) in reactions.get(client_id).map(Vec::as_slice).unwrap_or(&[]) {
            let at = summary.iter().position(|item| item.0 == *emoji).unwrap_or_else(|| { summary.push((emoji, 0.0, false)); summary.len() - 1 });
            summary[at].1 += 1.0;
            if *reactor == user.as_slice() { summary[at].2 = true }
        }
        let rank = |emoji: &Value| -> i64 { REACTIONS.iter().position(|known| is(Some(emoji), known)).map_or(-1, |at| at as i64) };
        summary.sort_by_key(|item| rank(item.0));
        let edit = edits.get(client_id).copied();
        let mut item = match edit { Some(edit) => entries_of(&with_edit(message, edit.get("text").unwrap_or(&Value::Null), edit.get("entities"))), None => entries_of(message) };
        set(&mut item, "edited", Value::Bool(edit.is_some()));
        set(&mut item, "reactions", Value::Array(summary.into_iter().map(|(emoji, count, mine)| json::object(vec![("emoji", emoji.clone()), ("count", Value::Number(count)), ("mine", Value::Bool(mine))])).collect()));
        let poll = field(message.get("meta"), "poll");
        if truthy(poll) {
            let mut counts = vec![0.0; array(field(poll, "options")).len()];
            let mut mine: &[f64] = &[];
            let per_voter = votes.get(client_id).map(Vec::as_slice).unwrap_or(&[]);
            for (voter, chosen) in per_voter {
                for index in chosen { if *index >= 0.0 && index.fract() == 0.0 && (*index as usize) < counts.len() { counts[*index as usize] += 1.0 } }
                if *voter == user.as_slice() { mine = chosen }
            }
            let numbers = |list: &[f64]| Value::Array(list.iter().map(|value| Value::Number(*value)).collect());
            set(&mut item, "poll", json::object(vec![("counts", numbers(&counts)), ("mine", numbers(mine)), ("voters", Value::Number(per_voter.len() as f64))]));
        }
        view.push(Value::Object(item));
    }
    view.sort_by(|a, b| id_key(a).total_cmp(&id_key(b)));
    let pinned = match pin {
        Some(pin) if truthy(Some(pin)) => view.iter().find(|item| item.get("clientId") == Some(pin)).cloned().unwrap_or(Value::Null),
        _ => Value::Null,
    };
    json::object(vec![
        ("messages", Value::Array(view)),
        ("pinned", pinned),
        ("rules", json::object(vec![("ttl", rules_ttl), ("noCopy", rules_no_copy)])),
        ("nextExpiry", match next_expiry { Some(expires) if expires.is_finite() => Value::Number(expires), _ => Value::Null }),
    ])
}
