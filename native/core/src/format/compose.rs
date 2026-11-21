//! Formatting while a message is written: the toolbar over a selection, the styles that move with the typing, and
//! what goes out — the typed shortcuts (`**bold**`…) turned into entities, the text trimmed, the entities cut to it.
//!
//! Reference: `mobile/src/format/entities.ts` (`toggleEntity`, `removeEntity`, `rangeHas`, `clearFormatting`,
//! `activeTypes`, `shiftEntities`, `sliceEntities`, `packEntities`) and `mobile/src/format/markdown.ts`
//! (`parseMarkdown` with `urlRanges`), with the composer's `composed` of `mobile/src/ChatScreen.tsx`. The entities
//! the phone hands over are the ones these functions made (clean numbers and names); `normalizeEntities` itself is
//! the parent module's port. Checked against the reference, run in Node, by `tests/compose_vectors.rs` (vectors
//! from `tests/generate-compose-vectors.mjs`).

use super::{expand_to_lines, is_block, js_max, js_min, js_space, normalize_entities, snap_end, snap_to_code_point, Entity, Language, ENTITY_TYPES, KIND_LINK, KIND_PRE};
use crate::json::{self, JsString, Value};
use crate::message_meta::valid_link_url;

const KIND_CODE: usize = 4;
const KIND_QUOTE: usize = 7;

fn units(text: &str) -> Vec<u16> { text.encode_utf16().collect() }
fn number(entity: &Value, key: &str) -> f64 { match entity.get(key) { Some(Value::Number(n)) => *n, _ => f64::NAN } }
fn is_kind(entity: &Value, kind: usize) -> bool {
    matches!(entity.get("type"), Some(Value::String(name)) if name.0.iter().copied().eq(ENTITY_TYPES[kind].encode_utf16()))
}
fn kind_of(name: &JsString) -> Option<usize> { ENTITY_TYPES.iter().position(|known| name.0.iter().copied().eq(known.encode_utf16())) }

/// `{...entity, offset?, length}`.
fn with(entity: &Value, offset: Option<f64>, length: f64) -> Value {
    let mut fields: Vec<(JsString, Value)> = match entity { Value::Object(fields) => fields.clone(), _ => Vec::new() };
    let mut set = |key: &str, value: f64| {
        let key = JsString::from_str(key);
        match fields.iter_mut().find(|(name, _)| *name == key) {
            Some(entry) => entry.1 = Value::Number(value),
            None => fields.push((key, Value::Number(value))),
        }
    };
    if let Some(offset) = offset { set("offset", offset) }
    set("length", length);
    Value::Object(fields)
}

/// A normalized entity as the reference writes it: `{type, offset, length, url?, language?}`.
fn written(entity: &Entity) -> Value {
    let mut fields = vec![("type", Value::str(ENTITY_TYPES[entity.kind])), ("offset", Value::Number(entity.offset)), ("length", Value::Number(entity.length))];
    if entity.kind == KIND_LINK { if let Some(url) = &entity.url { fields.push(("url", Value::String(url.clone()))) } }
    if entity.kind == KIND_PRE { if let Language::Text(language) = &entity.language { if !language.is_empty() { fields.push(("language", Value::String(JsString(language.clone())))) } } }
    json::object(fields)
}

fn normalized(entities: &[Value], text: &[u16]) -> Option<Vec<Entity>> {
    normalize_entities(Some(&Value::Array(entities.to_vec())), text).ok()
}
fn normalized_values(entities: &[Value], text: &[u16]) -> Option<Vec<Value>> {
    normalized(entities, text).map(|list| list.iter().map(written).collect())
}

/// `removeEntity`: cuts the range out of every entity of `kind` (splitting one the range sits in the middle of).
fn remove(entities: &[Value], start: f64, end: f64, kind: usize) -> Vec<Value> {
    let mut out = Vec::new();
    for entity in entities {
        let (offset, length) = (number(entity, "offset"), number(entity, "length"));
        if !is_kind(entity, kind) || offset >= end || offset + length <= start { out.push(entity.clone()); continue }
        let stop = offset + length;
        if offset < start { out.push(with(entity, None, start - offset)) }
        if stop > end { out.push(with(entity, Some(end), stop - end)) }
    }
    out
}

/// `rangeHas`: every character of the range carries `kind`.
fn range_has(entities: &[Value], start: f64, end: f64, kind: usize) -> bool {
    if end <= start { return false }
    let mut position = start;
    let mut list: Vec<&Value> = entities.iter().filter(|entity| is_kind(entity, kind)).collect();
    list.sort_by(|a, b| (number(a, "offset") - number(b, "offset")).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
    for entity in list {
        if number(entity, "offset") > position { break }
        position = js_max(position, number(entity, "offset") + number(entity, "length"));
        if position >= end { return true }
    }
    false
}

/// `toggleEntity`.
pub fn toggle(entities: &[Value], text: &[u16], from: f64, to: f64, kind: usize, url: Option<&Value>) -> Option<Vec<Value>> {
    let mut start = snap_to_code_point(text, js_min(from, to));
    let mut end = snap_end(text, js_max(from, to));
    if is_block(kind) { (start, end) = expand_to_lines(text, start, end) }
    if end <= start { return normalized_values(entities, text) }
    if kind == KIND_LINK {
        let mut cleared = remove(entities, start, end, KIND_LINK);
        if valid_link_url(url) {
            let address = url.cloned().unwrap_or(Value::Null);
            cleared.push(json::object(vec![("type", Value::str(ENTITY_TYPES[kind])), ("offset", Value::Number(start)), ("length", Value::Number(end - start)), ("url", address)]));
        }
        return normalized_values(&cleared, text);
    }
    if range_has(entities, start, end, kind) { return normalized_values(&remove(entities, start, end, kind), text) }
    let mut base = entities.to_vec();
    if is_block(kind) { for other in [KIND_PRE, KIND_QUOTE] { base = remove(&base, start, end, other) } }
    if kind == KIND_CODE || kind == KIND_PRE { for other in [0, 1, 2, 3, KIND_LINK] { base = remove(&base, start, end, other) } }
    base.push(json::object(vec![("type", Value::str(ENTITY_TYPES[kind])), ("offset", Value::Number(start)), ("length", Value::Number(end - start))]));
    normalized_values(&base, text)
}

/// `clearFormatting`.
pub fn clear(entities: &[Value], text: &[u16], from: f64, to: f64) -> Option<Vec<Value>> {
    let (start, end) = (js_min(from, to), js_max(from, to));
    let mut out = entities.to_vec();
    for kind in 0..ENTITY_TYPES.len() { out = remove(&out, start, end, kind) }
    normalized_values(&out, text)
}

/// `activeTypes`, in the order of the reference's `Set`.
pub fn active(entities: &[Value], from: f64, to: f64) -> Vec<&'static str> {
    let (start, end) = (js_min(from, to), js_max(from, to));
    let mut out: Vec<&'static str> = Vec::new();
    if end == start {
        for entity in entities {
            let (offset, length) = (number(entity, "offset"), number(entity, "length"));
            if !(offset < start && start < offset + length) { continue }
            if let Some(Value::String(name)) = entity.get("type") {
                if let Some(kind) = kind_of(name) { if !out.contains(&ENTITY_TYPES[kind]) { out.push(ENTITY_TYPES[kind]) } }
            }
        }
        return out;
    }
    for kind in 0..ENTITY_TYPES.len() { if range_has(entities, start, end, kind) { out.push(ENTITY_TYPES[kind]) } }
    out
}

/// `shiftEntities`.
pub fn shift(entities: &[Value], old: &[u16], new: &[u16]) -> Option<Vec<Value>> {
    if entities.is_empty() { return Some(Vec::new()) }
    if old == new { return normalized_values(entities, new) }
    let max = old.len().min(new.len());
    let mut prefix = 0;
    while prefix < max && old[prefix] == new[prefix] { prefix += 1 }
    let mut suffix = 0;
    while suffix < max - prefix && old[old.len() - 1 - suffix] == new[new.len() - 1 - suffix] { suffix += 1 }
    let (old_end, new_end) = ((old.len() - suffix) as f64, (new.len() - suffix) as f64);
    let delta = new.len() as f64 - old.len() as f64;
    let prefix = prefix as f64;
    let map = |position: f64, is_end: bool| -> f64 {
        let before = if is_end { position <= prefix } else { position < prefix };
        if before { position } else if position >= old_end { position + delta } else if is_end { new_end } else { prefix }
    };
    let mut out = Vec::new();
    for entity in entities {
        let (start, end) = (number(entity, "offset"), number(entity, "offset") + number(entity, "length"));
        let spans = start < prefix && end > old_end;
        let fresh_start = if spans { start } else { map(start, false) };
        let fresh_end = if spans { end + delta } else { map(end, true) };
        if fresh_end > fresh_start { out.push(with(entity, Some(fresh_start), fresh_end - fresh_start)) }
    }
    normalized_values(&out, new)
}

/// `sliceEntities`.
fn slice(entities: &[Value], text: &[u16], from: f64, to: f64) -> Option<Vec<Value>> {
    let mut out = Vec::new();
    for entity in entities {
        let (offset, length) = (number(entity, "offset"), number(entity, "length"));
        let start = js_max(offset, from);
        let end = js_min(offset + length, to);
        if end > start { out.push(with(entity, Some(start - from), end - start)) }
    }
    let low = (from.max(0.0) as usize).min(text.len());
    let high = (to.max(0.0) as usize).min(text.len()).max(low);
    normalized_values(&out, &text[low..high])
}

// ─── markdown.ts: parseMarkdown ──────────────────────────────────────────────────────────────────────────────

struct Marker { open: &'static str, kind: usize, multiline: bool }
const MARKERS: [Marker; 6] = [
    Marker { open: "```", kind: KIND_PRE, multiline: true },
    Marker { open: "**", kind: 0, multiline: true },
    Marker { open: "__", kind: 1, multiline: true },
    Marker { open: "~~", kind: 3, multiline: true },
    Marker { open: "||", kind: 6, multiline: true },
    Marker { open: "`", kind: KIND_CODE, multiline: false },
];

/// `/[\p{L}\p{N}]/u.test(text[index])`: one UTF-16 unit (a lone surrogate is neither).
fn word_char(text: &[u16], index: i64) -> bool {
    if index < 0 || index as usize >= text.len() { return false }
    let Some(character) = char::from_u32(text[index as usize] as u32) else { return false };
    // `is_alphanumeric` is Alphabetic or Numeric: \p{L} and \p{N} with Other_Alphabetic, which is marks (left out by
    // the \p{M} table) and the circled Latin letters (So).
    character.is_alphanumeric() && !super::mark(character as u32) && !(0x24b6..=0x24e9).contains(&(character as u32))
}

fn starts_with(text: &[u16], at: usize, word: &[u16]) -> bool { text.len() >= at + word.len() && &text[at..at + word.len()] == word }
fn index_of(text: &[u16], word: &[u16], from: usize) -> Option<usize> {
    if word.is_empty() || from > text.len() { return None }
    (from..=text.len().saturating_sub(word.len())).find(|&at| starts_with(text, at, word))
}
fn blank(text: &[u16]) -> bool { text.iter().all(|unit| js_space(*unit)) }

/// `urlRanges`: where the addresses stand; `**`, `~~`, `||` or a backtick glued to an address's end stays out.
fn url_ranges(text: &[u16]) -> Vec<(usize, usize)> {
    if !(0..text.len()).any(|at| super::address_prefix(text, at).is_some()) { return Vec::new() }
    let mut out = Vec::new();
    let mut at = 0;
    while at < text.len() {
        let Some(end) = super::address_at(text, at) else { at += 1; continue };
        let mut cut = end;
        while cut > at && matches!(text[cut - 1], 0x2a | 0x7e | 0x7c | 0x60) { cut -= 1 }
        if cut > at { out.push((at, cut)) }
        at = end;
    }
    out
}

/// `parseMarkdown`: the text without the markers, and the entities for them merged with the ones given.
fn parse_markdown(text: &[u16], entities: &[Value]) -> Option<(Vec<u16>, Vec<Value>)> {
    let existing: Vec<Value> = normalized_values(entities, text)?;
    let code: Vec<(f64, f64)> = existing.iter().filter(|entity| is_kind(entity, KIND_CODE) || is_kind(entity, KIND_PRE))
        .map(|entity| (number(entity, "offset"), number(entity, "offset") + number(entity, "length"))).collect();
    let inside = |position: usize| code.iter().any(|(start, end)| *start <= position as f64 && (position as f64) < *end);
    let urls = url_ranges(text);
    let in_url = |position: usize| urls.iter().any(|(start, end)| *start < position && position < *end);
    let mut removed: Vec<(usize, usize)> = Vec::new();
    let mut found: Vec<(usize, usize, usize, Option<Vec<u16>>)> = Vec::new();
    let mut index = 0usize;
    'scan: while index < text.len() {
        if inside(index) || in_url(index) { index += 1; continue }
        for marker in &MARKERS {
            let open = units(marker.open);
            let fence = marker.open == "```";
            if !starts_with(text, index, &open) { continue }
            if !fence && word_char(text, index as i64 - 1) { continue }
            let content_start = index + open.len();
            let mut close = index_of(text, &open, content_start);
            while let Some(at) = close {
                let glued = false && word_char(text, (at + open.len()) as i64) && !word_char(text, at as i64 - 1);
                if inside(at) || in_url(at) || glued { close = index_of(text, &open, at + 1) } else { break }
            }
            let Some(close) = close else { continue };
            let mut content: &[u16] = &text[content_start..close];
            if blank(content) || (!marker.multiline && content.contains(&0x0a)) { continue }
            let (mut entity_start, mut entity_end) = (content_start, close);
            let mut language: Option<Vec<u16>> = None;
            if marker.kind == KIND_PRE {
                // ```lang\ncode``` — the first line names the language when it has no spaces.
                let run = content.iter().take_while(|unit| matches!(**unit, 0x41..=0x5a | 0x61..=0x7a | 0x30..=0x39 | 0x5f | 0x2b | 0x23 | 0x2e | 0x2d)).count();
                if (1..=32).contains(&run) && content.get(run) == Some(&0x0a) {
                    language = Some(content[..run].to_vec());
                    entity_start += run + 1;
                    content = &content[run + 1..];
                }
                if content.first() == Some(&0x0a) { entity_start += 1; content = &content[1..] }
                if content.last() == Some(&0x0a) { entity_end -= 1; content = &content[..content.len() - 1] }
                if blank(content) { continue }
            } else if marker.kind != KIND_CODE && (content.first().is_some_and(|unit| js_space(*unit)) || content.last().is_some_and(|unit| js_space(*unit))) {
                continue;
            }
            removed.push((index, entity_start));
            removed.push((entity_end, close + open.len()));
            found.push((marker.kind, entity_start, entity_end, language));
            index = close + open.len();
            continue 'scan;
        }
        index += 1;
    }
    if removed.is_empty() { return Some((text.to_vec(), existing)) }
    removed.sort_by_key(|(start, _)| *start);
    let map = |position: f64| -> f64 {
        let mut shift = 0.0;
        for (start, end) in &removed {
            let (start, end) = (*start as f64, *end as f64);
            if end <= position { shift += end - start } else if start < position { shift += position - start } else { break }
        }
        position - shift
    };
    let mut out: Vec<u16> = Vec::new();
    let mut last = 0;
    for (start, end) in &removed {
        if *start > last { out.extend_from_slice(&text[last..*start]) }
        last = *end;
    }
    out.extend_from_slice(&text[last.min(text.len())..]);
    let mut moved: Vec<Value> = Vec::new();
    for entity in &existing {
        let (offset, length) = (number(entity, "offset"), number(entity, "length"));
        let (start, end) = (map(offset), map(offset + length));
        if end > start { moved.push(with(entity, Some(start), end - start)) }
    }
    for (kind, start, end, language) in &found {
        let (start, end) = (map(*start as f64), map(*end as f64));
        if end <= start { continue }
        let mut fields = vec![("type", Value::str(ENTITY_TYPES[*kind])), ("offset", Value::Number(start)), ("length", Value::Number(end - start))];
        if let Some(language) = language { fields.push(("language", Value::String(JsString(language.clone())))) }
        moved.push(json::object(fields));
    }
    let entities = normalized_values(&moved, &out)?;
    Some((out, entities))
}

/// The composer's `composed`: shortcuts parsed, the text trimmed, the entities cut to it — `{text, entities|null}`.
pub fn compose(text: &[u16], entities: &[Value]) -> Option<Value> {
    let (parsed, found) = parse_markdown(text, entities)?;
    let lead = parsed.iter().take_while(|unit| js_space(**unit)).count();
    let tail = parsed[lead..].iter().rev().take_while(|unit| js_space(**unit)).count();
    let plain = &parsed[lead..parsed.len() - tail];
    let cut = slice(&found, &parsed, lead as f64, (lead + plain.len()) as f64)?;
    let packed = normalized_values(&cut, plain)?;
    Some(json::object(vec![("text", Value::String(JsString(plain.to_vec()))), ("entities", if packed.is_empty() { Value::Null } else { Value::Array(packed) })]))
}

/// By name (`invizent_view`), `args` a JSON array:
/// - `composeToggle [entities, text, start, end, type, url|null]` → entities (`toggleEntity`)
/// - `composeClear [entities, text, start, end]` → entities (`clearFormatting`)
/// - `composeActive [entities, start, end]` → the type names (`activeTypes`)
/// - `composeShift [entities, oldText, newText]` → entities (`shiftEntities`)
/// - `composeOut [text, entities]` → `{text, entities|null}` (what goes out of the field)
pub fn view(name: &str, args: &[Value]) -> Option<Value> {
    let list = |value: &Value| -> Option<Vec<Value>> { match value { Value::Array(items) => Some(items.clone()), _ => None } };
    let array = |items: Vec<Value>| Value::Array(items);
    match (name, args) {
        ("composeToggle", [entities, Value::String(text), Value::Number(start), Value::Number(end), Value::String(kind), url]) => {
            let kind = kind_of(kind)?;
            let url = if matches!(url, Value::Null) { None } else { Some(url) };
            toggle(&list(entities)?, &text.0, *start, *end, kind, url).map(array)
        }
        ("composeClear", [entities, Value::String(text), Value::Number(start), Value::Number(end)]) => clear(&list(entities)?, &text.0, *start, *end).map(array),
        ("composeActive", [entities, Value::Number(start), Value::Number(end)]) => Some(array(active(&list(entities)?, *start, *end).into_iter().map(Value::str).collect())),
        ("composeShift", [entities, Value::String(old), Value::String(new)]) => shift(&list(entities)?, &old.0, &new.0).map(array),
        ("composeOut", [Value::String(text), entities]) => compose(&text.0, &list(entities)?),
        _ => None,
    }
}
