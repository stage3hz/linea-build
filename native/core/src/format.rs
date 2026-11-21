//! Message text for the native message lists: one string plus runs of flags.
//!
//! Reference: `nativeText` of `mobile/src/format/nativeSpans.ts` with everything it reaches — `toBlocks` and
//! `spansOf` (`format/render.ts`), `normalizeEntities` with `snapToCodePoint`, `snapEnd`, `joined`, `extend`,
//! `expandToLines`, `validLinkUrl` and the `byPosition` order (`format/entities.ts`), `linkTokens` with `URL_RE`
//! and `MENTION_RE` (`format/markdown.ts`). Checked against the reference itself, run in Node, by
//! `tests/format_vectors.rs` (vectors from `tests/generate-format-vectors.mjs`).
//!
//! The entities are taken as they come out of JSON, and the reference does no shape check on this path
//! (`validEntities` is not called), so what JavaScript does with a value of the wrong kind is ported too:
//! `offset` and `length` go through JavaScript's own conversion to a number (and `offset + length` through its
//! `+`, which glues strings), positions may be fractions or NaN, and an order that NaN makes inconsistent is
//! sorted the way V8 sorts it. Where the reference throws (a `null` entity, an `entities` object with a truthy
//! `length`, a `language` that is not text, an object with its own `toString` where a number is needed)
//! `native_text` returns `Value::Null`.

use crate::json::{self, JsString, Value};
use crate::message_meta::valid_link_url;

/// Formatting while a message is written (the composer's toolbar, `parseMarkdown`): `format/compose.rs`.
pub mod compose;

pub const BOLD: u32 = 1;
pub const ITALIC: u32 = 2;
pub const UNDERLINE: u32 = 4;
pub const STRIKE: u32 = 8;
pub const MONO: u32 = 16;
pub const SPOILER: u32 = 32;
pub const LINK: u32 = 64;
pub const QUOTE: u32 = 128;
pub const PRE: u32 = 256;

/// The reference's `ENTITY_TYPES`, in its order.
const ENTITY_TYPES: [&str; 9] = ["bold", "italic", "underline", "strikethrough", "code", "pre", "spoiler", "quote", "text_link"];
const KIND_PRE: usize = 5;
const KIND_QUOTE: usize = 7;
const KIND_LINK: usize = 8;
/// `INLINE` of render.ts as the flag each type sets on a span (`text_link` sets the address instead).
const INLINE: [u32; 9] = [BOLD, ITALIC, UNDERLINE, STRIKE, MONO, 0, SPOILER, 0, 0];
const ENTITY_LIMIT: usize = 100;
const LANGUAGE_LIMIT: usize = 32;
const ZWJ: u32 = 0x200d;
const NEWLINE: u16 = 0x0a;

/// The reference throws here (always a `TypeError`).
struct Throw;
type Js<T> = Result<T, Throw>;

// ─── JavaScript's conversions, for values that came out of JSON ──────────────────────────────────────────────

fn units(text: &str) -> Vec<u16> { text.encode_utf16().collect() }
/// White space and line terminators: `\s`, and what `Number(text)` trims.
fn js_space(unit: u16) -> bool {
    matches!(unit, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
/// `Math.min` / `Math.max` of two numbers: NaN when either is.
fn js_min(a: f64, b: f64) -> f64 { if a.is_nan() || b.is_nan() { f64::NAN } else if a < b || (a == b && a.is_sign_negative()) { a } else { b } }
fn js_max(a: f64, b: f64) -> f64 { if a.is_nan() || b.is_nan() { f64::NAN } else if a > b || (a == b && a.is_sign_positive()) { a } else { b } }
/// ToBoolean of a JSON value (`undefined` is false).
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => *number != 0.0 && !number.is_nan(),
        Some(Value::String(text)) => !text.0.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

enum Prim { Undefined, Null, Bool(bool), Number(f64), Str(Vec<u16>) }

/// `String(number)`.
fn number_string(number: f64) -> Vec<u16> {
    if number.is_nan() { units("NaN") } else if number.is_infinite() { units(if number > 0.0 { "Infinity" } else { "-Infinity" }) } else { units(&json::number_text(number)) }
}
/// ToPrimitive. An array becomes its `join(',')`; an object is `[object Object]`, unless it has its own
/// `toString` — which, coming from JSON, cannot be called, and the inherited `valueOf` answers the object itself:
/// a TypeError. (An own `valueOf` is skipped for the same reason and changes nothing.)
fn to_primitive(value: Option<&Value>) -> Js<Prim> {
    Ok(match value {
        None => Prim::Undefined,
        Some(Value::Null) => Prim::Null,
        Some(Value::Bool(flag)) => Prim::Bool(*flag),
        Some(Value::Number(number)) => Prim::Number(*number),
        Some(Value::String(text)) => Prim::Str(text.0.clone()),
        Some(Value::Array(items)) => {
            let mut out = Vec::new();
            for (index, item) in items.iter().enumerate() {
                if index > 0 { out.push(b',' as u16) }
                if !matches!(item, Value::Null) { out.extend(to_string(&to_primitive(Some(item))?)) }
            }
            Prim::Str(out)
        }
        Some(object @ Value::Object(_)) => if object.get("toString").is_some() { return Err(Throw) } else { Prim::Str(units("[object Object]")) },
    })
}
fn to_string(value: &Prim) -> Vec<u16> {
    match value {
        Prim::Undefined => units("undefined"),
        Prim::Null => units("null"),
        Prim::Bool(flag) => units(if *flag { "true" } else { "false" }),
        Prim::Number(number) => number_string(*number),
        Prim::Str(text) => text.clone(),
    }
}
fn to_number(value: &Prim) -> f64 {
    match value {
        Prim::Undefined => f64::NAN,
        Prim::Null => 0.0,
        Prim::Bool(flag) => if *flag { 1.0 } else { 0.0 },
        Prim::Number(number) => *number,
        Prim::Str(text) => string_to_number(text),
    }
}
/// `Number(text)`: white space trimmed; empty is 0; `0x`/`0o`/`0b` whole numbers; `Infinity`; a decimal literal.
fn string_to_number(text: &[u16]) -> f64 {
    let from = text.iter().position(|unit| !js_space(*unit)).unwrap_or(text.len());
    let to = text.iter().rposition(|unit| !js_space(*unit)).map_or(from, |at| at + 1);
    let Some(text) = text[from..to].iter().map(|unit| u8::try_from(*unit).ok().filter(u8::is_ascii)).collect::<Option<Vec<u8>>>() else { return f64::NAN };
    if text.is_empty() { return 0.0 }
    if text.len() >= 2 && text[0] == b'0' {
        let bits = match text[1] { b'x' | b'X' => 4, b'o' | b'O' => 3, b'b' | b'B' => 1, _ => 0 };
        if bits > 0 { return radix_number(&text[2..], bits) }
    }
    let (negative, body) = match text[0] { b'-' => (true, &text[1..]), b'+' => (false, &text[1..]), _ => (false, &text[..]) };
    if body == b"Infinity" { return if negative { f64::NEG_INFINITY } else { f64::INFINITY } }
    // digits [. digits?] | . digits, then an optional exponent
    let digits = |at: usize| body[at..].iter().take_while(|byte| byte.is_ascii_digit()).count();
    let whole = digits(0);
    let mut at = whole;
    let mut fraction = 0;
    if body.get(at) == Some(&b'.') { fraction = digits(at + 1); at += 1 + fraction }
    if whole + fraction == 0 { return f64::NAN }
    if matches!(body.get(at), Some(b'e' | b'E')) {
        let sign = usize::from(matches!(body.get(at + 1), Some(b'+' | b'-')));
        let exponent = digits(at + 1 + sign);
        if exponent == 0 { return f64::NAN }
        at += 1 + sign + exponent;
    }
    if at != body.len() { return f64::NAN }
    // Rust reads the same grammar (checked above) and rounds correctly, as V8 does.
    std::str::from_utf8(&text).ok().and_then(|text| text.parse::<f64>().ok()).unwrap_or(f64::NAN)
}
/// The digits of a `0x`, `0o` or `0b` literal: the exact value, rounded to the nearest double (ties to even).
fn radix_number(digits: &[u8], bits: u32) -> f64 {
    if digits.is_empty() { return f64::NAN }
    let (mut mantissa, mut exponent, mut round, mut sticky) = (0u64, 0i32, false, false);
    for byte in digits {
        let Some(digit) = (*byte as char).to_digit(1 << bits) else { return f64::NAN };
        for bit in (0..bits).rev() {
            let bit = digit >> bit & 1 == 1;
            if mantissa < 1 << 52 { mantissa = mantissa << 1 | u64::from(bit) } else { if exponent == 0 { round = bit } else { sticky |= bit } exponent += 1 }
        }
    }
    if round && (sticky || mantissa & 1 == 1) { mantissa += 1 }
    mantissa as f64 * 2f64.powi(exponent)
}
/// JavaScript's `a + b`: text when either side is (or becomes) text, else a sum.
fn js_add(a: Option<&Value>, b: Option<&Value>) -> Js<Prim> {
    let (a, b) = (to_primitive(a)?, to_primitive(b)?);
    Ok(if matches!(a, Prim::Str(_)) || matches!(b, Prim::Str(_)) {
        let mut out = to_string(&a);
        out.extend(to_string(&b));
        Prim::Str(out)
    } else {
        Prim::Number(to_number(&a) + to_number(&b))
    })
}

// ─── JavaScript's string methods, with positions that may be fractions ───────────────────────────────────────

/// ToIntegerOrInfinity.
fn integer(position: f64) -> f64 { if position.is_nan() { 0.0 } else { position.trunc() } }
/// `text.charCodeAt(index)`; None is NaN (every comparison with it is false).
fn unit_at(text: &[u16], index: f64) -> Option<u16> {
    let index = integer(index);
    if index < 0.0 || index >= text.len() as f64 { None } else { Some(text[index as usize]) }
}
fn high(unit: Option<u16>) -> bool { unit.is_some_and(|unit| (0xd800..=0xdbff).contains(&unit)) }
fn low(unit: Option<u16>) -> bool { unit.is_some_and(|unit| (0xdc00..=0xdfff).contains(&unit)) }
/// `text.codePointAt(index)`. The reference only asks inside the text.
fn code_point_at(text: &[u16], index: f64) -> Option<u32> {
    let first = unit_at(text, index)?;
    let next = unit_at(text, integer(index) + 1.0);
    Some(if high(Some(first)) && low(next) { 0x10000 + ((first as u32 - 0xd800) << 10) + (next.unwrap_or(0) as u32 - 0xdc00) } else { first as u32 })
}
/// `text.slice(from, to)`.
fn slice(text: &[u16], from: f64, to: f64) -> &[u16] {
    let length = text.len() as f64;
    let place = |position: f64| { let position = integer(position); (if position < 0.0 { (length + position).max(0.0) } else { position.min(length) }) as usize };
    let (from, to) = (place(from), place(to));
    if from < to { &text[from..to] } else { &[] }
}
/// `text.indexOf('\n', position)`.
fn index_of_newline(text: &[u16], position: f64) -> Option<usize> {
    let from = integer(position).clamp(0.0, text.len() as f64) as usize;
    text[from..].iter().position(|unit| *unit == NEWLINE).map(|at| from + at)
}
/// `text.lastIndexOf('\n', position)`: a NaN position searches from the end.
fn last_index_of_newline(text: &[u16], position: f64) -> Option<usize> {
    if text.is_empty() { return None }
    let from = if position.is_nan() { f64::INFINITY } else { position.trunc() }.clamp(0.0, (text.len() - 1) as f64) as usize;
    text[..=from].iter().rposition(|unit| *unit == NEWLINE)
}

// ─── entities.ts: graphemes ──────────────────────────────────────────────────────────────────────────────────

/// `\p{M}` (Mn, Mc, Me) of Unicode 17.0, as the Node that runs the reference has it.
fn mark(code: u32) -> bool {
    MARKS.binary_search_by(|(from, to)| if code < *from { std::cmp::Ordering::Greater } else if code > *to { std::cmp::Ordering::Less } else { std::cmp::Ordering::Equal }).is_ok()
}
/// Marks that never start a grapheme: ZWJ, skin tones, combining marks (with the variation selectors and the keycap sign).
fn extend(code: Option<u32>) -> bool { code.is_some_and(|code| code == ZWJ || (0x1f3fb..=0x1f3ff).contains(&code) || mark(code)) }
fn regional_indicator(code: Option<u32>) -> bool { code.is_some_and(|code| (0x1f1e6..=0x1f1ff).contains(&code)) }
/// Start of the code point that ends at `index`.
fn code_point_start(text: &[u16], index: f64) -> f64 {
    if index >= 2.0 && low(unit_at(text, index - 1.0)) && high(unit_at(text, index - 2.0)) { index - 2.0 } else { index - 1.0 }
}
fn code_point_before(text: &[u16], index: f64) -> Option<u32> { code_point_at(text, code_point_start(text, index)) }
/// True when `index` falls inside one grapheme (the reference's rough UAX #29).
fn joined(text: &[u16], index: f64) -> bool {
    if low(unit_at(text, index)) && high(unit_at(text, index - 1.0)) { return true }
    let (after, before) = (code_point_at(text, index), code_point_before(text, index));
    if extend(after) || before == Some(ZWJ) { return true }
    if regional_indicator(after) && regional_indicator(before) {
        let (mut count, mut at) = (0, index);
        while at > 0.0 && regional_indicator(code_point_before(text, at)) { count += 1; at = code_point_start(text, at) }
        return count % 2 == 1;
    }
    false
}
fn snap_to_code_point(text: &[u16], position: f64) -> f64 {
    let length = text.len() as f64;
    let mut at = js_max(0.0, js_min(length, position));
    while at > 0.0 && at < length && joined(text, at) { at = code_point_start(text, at) }
    at
}
fn snap_end(text: &[u16], position: f64) -> f64 {
    let length = text.len() as f64;
    let mut at = js_max(0.0, js_min(length, position));
    while at > 0.0 && at < length && joined(text, at) { at += if high(unit_at(text, at)) && low(unit_at(text, at + 1.0)) { 2.0 } else { 1.0 } }
    at
}
fn line_start(text: &[u16], position: f64) -> f64 { last_index_of_newline(text, js_max(0.0, position - 1.0)).map_or(0.0, |index| index as f64 + 1.0) }
fn line_end(text: &[u16], position: f64) -> f64 { index_of_newline(text, position).unwrap_or(text.len()) as f64 }
/// Block entities cover whole lines.
fn expand_to_lines(text: &[u16], start: f64, end: f64) -> (f64, f64) {
    (line_start(text, start), line_end(text, js_max(start, if end > start { end - 1.0 } else { end })))
}

// ─── entities.ts: normalizeEntities ──────────────────────────────────────────────────────────────────────────

#[derive(Clone, PartialEq)]
enum Language {
    None,
    Text(Vec<u16>),
    /// `language` was an array: `slice` copies it, and a copy is `===` to nothing else.
    Array,
}
#[derive(Clone)]
struct Entity { kind: usize, offset: f64, length: f64, url: Option<JsString>, language: Language }

fn is_block(kind: usize) -> bool { kind == KIND_PRE || kind == KIND_QUOTE }
fn same_kind(a: &Entity, b: &Entity) -> bool { a.kind == b.kind && a.url == b.url && a.language != Language::Array && a.language == b.language }
/// `a.offset - b.offset || b.length - a.length || a.type.localeCompare(b.type)`: NaN is falsy, so an entity without
/// a position is ordered by what remains. (The nine names sort the same by code unit and by `localeCompare`.)
fn by_position(a: &Entity, b: &Entity) -> f64 {
    let by_offset = a.offset - b.offset;
    if by_offset != 0.0 && !by_offset.is_nan() { return by_offset }
    let by_length = b.length - a.length;
    if by_length != 0.0 && !by_length.is_nan() { return by_length }
    match ENTITY_TYPES[a.kind].cmp(ENTITY_TYPES[b.kind]) { std::cmp::Ordering::Less => -1.0, std::cmp::Ordering::Equal => 0.0, std::cmp::Ordering::Greater => 1.0 }
}

/// `entities?.length`, as a condition.
fn has_length(entities: Option<&Value>) -> bool {
    match entities {
        Some(Value::String(text)) => !text.0.is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(object @ Value::Object(_)) => truthy(object.get("length")),
        _ => false,
    }
}

fn normalize_entities(entities: Option<&Value>, text: &[u16]) -> Js<Vec<Entity>> {
    if !has_length(entities) { return Ok(Vec::new()) }
    let items = match entities {
        Some(Value::Array(items)) => items,
        // `for … of` over an object that is not iterable.
        Some(Value::Object(_)) => return Err(Throw),
        // The characters of a string have no `type`: every one is skipped.
        _ => return Ok(Vec::new()),
    };
    let length = text.len() as f64;
    let mut clamped: Vec<Entity> = Vec::new();
    for item in items {
        // `entity.type` of null throws; of a number, a string, a boolean or an array it is undefined.
        if matches!(item, Value::Null) { return Err(Throw) }
        if !matches!(item, Value::Object(_)) { continue }
        let Some(Value::String(name)) = item.get("type") else { continue };
        let Some(kind) = ENTITY_TYPES.iter().position(|known| name.0.iter().copied().eq(known.encode_utf16())) else { continue };
        let (offset, size) = (item.get("offset"), item.get("length"));
        let mut start = snap_to_code_point(text, js_max(0.0, js_min(length, to_number(&to_primitive(offset)?))));
        let mut end = snap_end(text, to_number(&js_add(offset, size)?));
        if is_block(kind) { (start, end) = expand_to_lines(text, start, end) }
        if kind == KIND_LINK && !valid_link_url(item.get("url")) { continue }
        if end <= start { continue }
        let language = match item.get("language") {
            value if kind != KIND_PRE || !truthy(value) => Language::None,
            Some(Value::String(language)) => Language::Text(language.0[..language.0.len().min(LANGUAGE_LIMIT)].to_vec()),
            Some(Value::Array(_)) => Language::Array,
            // `entity.language.slice` is not a function.
            _ => return Err(Throw),
        };
        let url = if kind == KIND_LINK { match item.get("url") { Some(Value::String(url)) => Some(url.clone()), _ => None } } else { None };
        clamped.push(Entity { kind, offset: start, length: end - start, url, language });
    }
    v8_sort(&mut clamped, by_position);
    let mut merged: Vec<Entity> = Vec::new();
    for entity in clamped {
        if let Some(previous) = merged.iter_mut().rev().find(|item| same_kind(item, &entity)) {
            if previous.offset + previous.length >= entity.offset {
                previous.length = js_max(previous.offset + previous.length, entity.offset + entity.length) - previous.offset;
                continue;
            }
        }
        if is_block(entity.kind) && merged.iter().any(|item| is_block(item.kind) && item.offset < entity.offset + entity.length && entity.offset < item.offset + item.length) { continue }
        merged.push(entity);
    }
    v8_sort(&mut merged, by_position);
    merged.truncate(ENTITY_LIMIT);
    Ok(merged)
}

// ─── Array.prototype.sort as V8 does it ──────────────────────────────────────────────────────────────────────
// `byPosition` is not a consistent order once a position is NaN, and then the result depends on the algorithm.
// This is V8's: runs found and extended by binary insertion (alone below 64 items), merged with galloping.

struct Sorter<T, F: FnMut(&T, &T) -> f64> { work: Vec<T>, order: F, runs: Vec<(usize, usize)>, min_gallop: usize }

fn v8_sort<T: Clone, F: FnMut(&T, &T) -> f64>(items: &mut Vec<T>, order: F) {
    let length = items.len();
    if length < 2 { return }
    let mut sorter = Sorter { work: std::mem::take(items), order, runs: Vec::new(), min_gallop: 7 };
    let min_run = { let (mut n, mut r) = (length, 0); while n >= 64 { r |= n & 1; n >>= 1 } n + r };
    let (mut low, mut remaining) = (0, length);
    while remaining != 0 {
        let mut run = sorter.count_and_make_run(low, low + remaining);
        if run < min_run {
            let forced = min_run.min(remaining);
            sorter.binary_insertion(low, low + run, low + forced);
            run = forced;
        }
        sorter.runs.push((low, run));
        sorter.merge_collapse();
        low += run;
        remaining -= run;
    }
    while sorter.runs.len() > 1 {
        let mut n = sorter.runs.len() - 2;
        if n > 0 && sorter.runs[n - 1].1 < sorter.runs[n + 1].1 { n -= 1 }
        sorter.merge_at(n);
    }
    *items = sorter.work;
}

impl<T: Clone, F: FnMut(&T, &T) -> f64> Sorter<T, F> {
    /// The length of the run that starts at `from`; a strictly descending one is reversed in place.
    fn count_and_make_run(&mut self, from: usize, high: usize) -> usize {
        let low = from + 1;
        if low == high { return 1 }
        let mut run = 2;
        let descending = (self.order)(&self.work[low], &self.work[low - 1]) < 0.0;
        for index in low + 1..high {
            let order = (self.order)(&self.work[index], &self.work[index - 1]);
            if descending { if order >= 0.0 { break } } else if order < 0.0 { break }
            run += 1;
        }
        if descending { self.work[from..from + run].reverse() }
        run
    }
    fn binary_insertion(&mut self, low: usize, start: usize, high: usize) {
        for start in (if low == start { start + 1 } else { start })..high {
            let (mut left, mut right) = (low, start);
            while left < right {
                let middle = left + ((right - left) >> 1);
                if (self.order)(&self.work[start], &self.work[middle]) < 0.0 { right = middle } else { left = middle + 1 }
            }
            self.work[left..=start].rotate_right(1);
        }
    }
    fn invariant(&self, n: usize) -> bool { n < 2 || self.runs[n - 2].1 > self.runs[n - 1].1 + self.runs[n].1 }
    fn merge_collapse(&mut self) {
        while self.runs.len() > 1 {
            let mut n = self.runs.len() - 2;
            if !self.invariant(n + 1) || !self.invariant(n) {
                if self.runs[n - 1].1 < self.runs[n + 1].1 { n -= 1 }
                self.merge_at(n);
            } else if self.runs[n].1 <= self.runs[n + 1].1 {
                self.merge_at(n);
            } else {
                break;
            }
        }
    }
    /// Where `key` goes in the sorted `length` items from `base` of `array`, before any equal ones; `hint` is where to start looking.
    fn gallop_left(order: &mut F, array: &[T], key: &T, base: usize, length: usize, hint: usize) -> usize {
        let (mut last, mut offset) = (0usize, 1usize);
        if order(&array[base + hint], key) < 0.0 {
            let max = length - hint;
            while offset < max {
                if order(&array[base + hint + offset], key) >= 0.0 { break }
                last = offset;
                offset = (offset << 1) + 1;
            }
            if offset > max { offset = max }
            last += hint;
            offset += hint;
            Self::search(last as isize + 1, offset as isize, |middle| order(&array[base + middle], key) < 0.0)
        } else {
            let max = hint + 1;
            while offset < max {
                if order(&array[base + hint - offset], key) < 0.0 { break }
                last = offset;
                offset = (offset << 1) + 1;
            }
            if offset > max { offset = max }
            Self::search(hint as isize - offset as isize + 1, hint as isize - last as isize, |middle| order(&array[base + middle], key) < 0.0)
        }
    }
    /// The same, after any equal ones.
    fn gallop_right(order: &mut F, array: &[T], key: &T, base: usize, length: usize, hint: usize) -> usize {
        let (mut last, mut offset) = (0usize, 1usize);
        if order(key, &array[base + hint]) < 0.0 {
            let max = hint + 1;
            while offset < max {
                if order(key, &array[base + hint - offset]) >= 0.0 { break }
                last = offset;
                offset = (offset << 1) + 1;
            }
            if offset > max { offset = max }
            Self::search(hint as isize - offset as isize + 1, hint as isize - last as isize, |middle| !(order(key, &array[base + middle]) < 0.0))
        } else {
            let max = length - hint;
            while offset < max {
                if order(key, &array[base + hint + offset]) < 0.0 { break }
                last = offset;
                offset = (offset << 1) + 1;
            }
            if offset > max { offset = max }
            last += hint;
            offset += hint;
            Self::search(last as isize + 1, offset as isize, |middle| !(order(key, &array[base + middle]) < 0.0))
        }
    }
    /// The binary search both gallops end with: `right(middle)` says the answer lies after `middle`.
    fn search(mut last: isize, mut offset: isize, mut right: impl FnMut(usize) -> bool) -> usize {
        while last < offset {
            let middle = last + ((offset - last) >> 1);
            if right(middle as usize) { last = middle + 1 } else { offset = middle }
        }
        offset as usize
    }
    fn merge_at(&mut self, index: usize) {
        let ((mut base_a, mut length_a), (base_b, mut length_b)) = (self.runs[index], self.runs[index + 1]);
        self.runs[index].1 = length_a + length_b;
        self.runs.remove(index + 1);
        let skipped = Self::gallop_right(&mut self.order, &self.work, &self.work[base_b], base_a, length_a, 0);
        base_a += skipped;
        length_a -= skipped;
        if length_a == 0 { return }
        length_b = Self::gallop_left(&mut self.order, &self.work, &self.work[base_a + length_a - 1], base_b, length_b, length_b - 1);
        if length_b == 0 { return }
        if length_a <= length_b { self.merge_low(base_a, length_a, base_b, length_b) } else { self.merge_high(base_a, length_a, base_b, length_b) }
    }
    /// Merges the runs A and B (B follows A) from the left, with A copied aside.
    fn merge_low(&mut self, base_a: usize, mut length_a: usize, base_b: usize, mut length_b: usize) {
        let temp: Vec<T> = self.work[base_a..base_a + length_a].to_vec();
        let (mut dest, mut cursor_temp, mut cursor_b) = (base_a, 0usize, base_b);
        let mut min_gallop = self.min_gallop;
        // false: the rest of A goes last ("succeed"); true: the rest of B, then the one item left of A ("copy B").
        let copy_b = 'merge: {
            self.work[dest] = self.work[cursor_b].clone(); dest += 1; cursor_b += 1;
            length_b -= 1;
            if length_b == 0 { break 'merge false }
            if length_a == 1 { break 'merge true }
            loop {
                let (mut wins_a, mut wins_b) = (0usize, 0usize);
                loop {
                    if (self.order)(&self.work[cursor_b], &temp[cursor_temp]) < 0.0 {
                        self.work[dest] = self.work[cursor_b].clone(); dest += 1; cursor_b += 1;
                        wins_b += 1; length_b -= 1; wins_a = 0;
                        if length_b == 0 { break 'merge false }
                        if wins_b >= min_gallop { break }
                    } else {
                        self.work[dest] = temp[cursor_temp].clone(); dest += 1; cursor_temp += 1;
                        wins_a += 1; length_a -= 1; wins_b = 0;
                        if length_a == 1 { break 'merge true }
                        if wins_a >= min_gallop { break }
                    }
                }
                min_gallop += 1;
                let mut first = true;
                while wins_a >= 7 || wins_b >= 7 || first {
                    first = false;
                    min_gallop = (min_gallop - 1).max(1);
                    self.min_gallop = min_gallop;
                    wins_a = Self::gallop_right(&mut self.order, &temp, &self.work[cursor_b], cursor_temp, length_a, 0);
                    if wins_a > 0 {
                        self.work[dest..dest + wins_a].clone_from_slice(&temp[cursor_temp..cursor_temp + wins_a]);
                        dest += wins_a; cursor_temp += wins_a; length_a -= wins_a;
                        if length_a == 1 { break 'merge true }
                        if length_a == 0 { break 'merge false }
                    }
                    self.work[dest] = self.work[cursor_b].clone(); dest += 1; cursor_b += 1;
                    length_b -= 1;
                    if length_b == 0 { break 'merge false }
                    wins_b = Self::gallop_left(&mut self.order, &self.work, &temp[cursor_temp], cursor_b, length_b, 0);
                    if wins_b > 0 {
                        for step in 0..wins_b { self.work[dest + step] = self.work[cursor_b + step].clone() }
                        dest += wins_b; cursor_b += wins_b; length_b -= wins_b;
                        if length_b == 0 { break 'merge false }
                    }
                    self.work[dest] = temp[cursor_temp].clone(); dest += 1; cursor_temp += 1;
                    length_a -= 1;
                    if length_a == 1 { break 'merge true }
                }
                min_gallop += 1;
                self.min_gallop = min_gallop;
            }
        };
        if copy_b {
            for step in 0..length_b { self.work[dest + step] = self.work[cursor_b + step].clone() }
            self.work[dest + length_b] = temp[cursor_temp].clone();
        } else if length_a > 0 {
            self.work[dest..dest + length_a].clone_from_slice(&temp[cursor_temp..cursor_temp + length_a]);
        }
    }
    /// The same from the right, with B copied aside. Places are counted one up (`dest`, `cursor_a` and
    /// `cursor_temp` point just after the item), so that none goes below zero.
    fn merge_high(&mut self, base_a: usize, mut length_a: usize, base_b: usize, mut length_b: usize) {
        let temp: Vec<T> = self.work[base_b..base_b + length_b].to_vec();
        let (mut dest, mut cursor_temp, mut cursor_a) = (base_b + length_b, length_b, base_a + length_a);
        let mut min_gallop = self.min_gallop;
        // false: the rest of B goes first ("succeed"); true: the rest of A, before it the one item left of B ("copy A").
        let copy_a = 'merge: {
            dest -= 1; cursor_a -= 1; self.work[dest] = self.work[cursor_a].clone();
            length_a -= 1;
            if length_a == 0 { break 'merge false }
            if length_b == 1 { break 'merge true }
            loop {
                let (mut wins_a, mut wins_b) = (0usize, 0usize);
                loop {
                    if (self.order)(&temp[cursor_temp - 1], &self.work[cursor_a - 1]) < 0.0 {
                        dest -= 1; cursor_a -= 1; self.work[dest] = self.work[cursor_a].clone();
                        wins_a += 1; length_a -= 1; wins_b = 0;
                        if length_a == 0 { break 'merge false }
                        if wins_a >= min_gallop { break }
                    } else {
                        dest -= 1; cursor_temp -= 1; self.work[dest] = temp[cursor_temp].clone();
                        wins_b += 1; length_b -= 1; wins_a = 0;
                        if length_b == 1 { break 'merge true }
                        if wins_b >= min_gallop { break }
                    }
                }
                min_gallop += 1;
                let mut first = true;
                while wins_a >= 7 || wins_b >= 7 || first {
                    first = false;
                    min_gallop = (min_gallop - 1).max(1);
                    self.min_gallop = min_gallop;
                    let kept = Self::gallop_right(&mut self.order, &self.work, &temp[cursor_temp - 1], base_a, length_a, length_a - 1);
                    wins_a = length_a - kept;
                    if wins_a > 0 {
                        dest -= wins_a; cursor_a -= wins_a;
                        for step in (0..wins_a).rev() { self.work[dest + step] = self.work[cursor_a + step].clone() }
                        length_a -= wins_a;
                        if length_a == 0 { break 'merge false }
                    }
                    dest -= 1; cursor_temp -= 1; self.work[dest] = temp[cursor_temp].clone();
                    length_b -= 1;
                    if length_b == 1 { break 'merge true }
                    let kept = Self::gallop_left(&mut self.order, &temp, &self.work[cursor_a - 1], 0, length_b, length_b - 1);
                    wins_b = length_b - kept;
                    if wins_b > 0 {
                        dest -= wins_b; cursor_temp -= wins_b;
                        self.work[dest..dest + wins_b].clone_from_slice(&temp[cursor_temp..cursor_temp + wins_b]);
                        length_b -= wins_b;
                        if length_b == 1 { break 'merge true }
                        if length_b == 0 { break 'merge false }
                    }
                    dest -= 1; cursor_a -= 1; self.work[dest] = self.work[cursor_a].clone();
                    length_a -= 1;
                    if length_a == 0 { break 'merge false }
                }
                min_gallop += 1;
                self.min_gallop = min_gallop;
            }
        };
        if copy_a {
            dest -= length_a; cursor_a -= length_a;
            for step in (0..length_a).rev() { self.work[dest + step] = self.work[cursor_a + step].clone() }
            self.work[dest - 1] = temp[cursor_temp - 1].clone();
        } else if length_b > 0 {
            self.work[dest - length_b..dest].clone_from_slice(&temp[..length_b]);
        }
    }
}

// ─── render.ts: toBlocks ─────────────────────────────────────────────────────────────────────────────────────

struct Span { text: Vec<u16>, flags: u32, url: Option<JsString> }
#[derive(PartialEq, Clone, Copy)]
enum BlockKind { Text, Quote, Pre }
struct Block { kind: BlockKind, spans: Vec<Span> }

fn spans_of(text: &[u16], start: f64, end: f64, entities: &[Entity]) -> Vec<Span> {
    let inline: Vec<&Entity> = entities.iter().filter(|entity| !is_block(entity.kind) && entity.offset < end && start < entity.offset + entity.length).collect();
    let mut points = vec![start, end];
    for entity in &inline { points.push(js_max(start, entity.offset)); points.push(js_min(end, entity.offset + entity.length)) }
    // None is NaN here (the filter above), so this is the order of `(a, b) => a - b` and of a Set's distinct values.
    points.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    points.dedup();
    let mut spans = Vec::new();
    for pair in points.windows(2) {
        let (from, to) = (pair[0], pair[1]);
        if to <= from { continue }
        let mut span = Span { text: slice(text, from, to).to_vec(), flags: 0, url: None };
        for entity in &inline {
            if entity.offset > from || entity.offset + entity.length < to { continue }
            if entity.kind == KIND_LINK { span.url = entity.url.clone() } else { span.flags |= INLINE[entity.kind] }
        }
        spans.push(span);
    }
    spans
}

fn to_blocks(text: &[u16], entities: Option<&Value>) -> Js<Vec<Block>> {
    let list = normalize_entities(entities, text)?;
    if list.is_empty() { return Ok(if text.is_empty() { Vec::new() } else { vec![Block { kind: BlockKind::Text, spans: vec![Span { text: text.to_vec(), flags: 0, url: None }] }] }) }
    let mut blocks: Vec<Block> = Vec::new();
    // Block entities stand on whole lines, so their offsets are whole numbers: a consistent order, any stable sort.
    let mut block_entities: Vec<&Entity> = list.iter().filter(|entity| is_block(entity.kind)).collect();
    block_entities.sort_by(|a, b| a.offset.partial_cmp(&b.offset).unwrap_or(std::cmp::Ordering::Equal));
    let length = text.len() as f64;
    let push_text = |blocks: &mut Vec<Block>, mut from: f64, mut to: f64| {
        // The line breaks that only separate a block from its neighbours are not shown as empty lines.
        if from > 0.0 && unit_at(text, from) == Some(NEWLINE) && blocks.last().is_some_and(|block| block.kind != BlockKind::Text) { from += 1.0 }
        if to < length && unit_at(text, to - 1.0) == Some(NEWLINE) && to > from { to -= 1.0 }
        if to > from { blocks.push(Block { kind: BlockKind::Text, spans: spans_of(text, from, to, &list) }) }
    };
    let mut position = 0.0;
    for block in block_entities {
        push_text(&mut blocks, position, block.offset);
        let end = block.offset + block.length;
        blocks.push(if block.kind == KIND_PRE {
            Block { kind: BlockKind::Pre, spans: vec![Span { text: slice(text, block.offset, end).to_vec(), flags: MONO, url: None }] }
        } else {
            Block { kind: BlockKind::Quote, spans: spans_of(text, block.offset, end, &list) }
        });
        position = end;
    }
    push_text(&mut blocks, position, length);
    Ok(blocks)
}

// ─── markdown.ts: linkTokens ─────────────────────────────────────────────────────────────────────────────────

fn ascii(unit: u16) -> Option<u8> { u8::try_from(unit).ok().filter(u8::is_ascii) }
/// `\w` (the patterns have no `u` flag: ASCII only, also under `i`).
fn word(unit: u16) -> bool { ascii(unit).is_some_and(|byte| byte.is_ascii_alphanumeric() || byte == b'_') }
/// `[^\s<>"'«»]`.
fn address_unit(unit: u16) -> bool { !js_space(unit) && !matches!(unit, 0x3c | 0x3e | 0x22 | 0x27 | 0xab | 0xbb) }
/// `[^\s<>"'«».,:;!?)\]]`.
fn address_end(unit: u16) -> bool { address_unit(unit) && !matches!(unit, 0x2e | 0x2c | 0x3a | 0x3b | 0x21 | 0x3f | 0x29 | 0x5d) }
/// `word` at `at`, letters in either case (under `i` without `u` no other character folds to an ASCII letter).
fn starts(text: &[u16], at: usize, word: &str) -> bool {
    text.len() >= at + word.len() && word.bytes().zip(&text[at..]).all(|(want, unit)| ascii(*unit).is_some_and(|byte| byte.to_ascii_lowercase() == want))
}
/// `(?:https?:\/\/|www\.)` at `at`: where it ends.
fn address_prefix(text: &[u16], at: usize) -> Option<usize> {
    if starts(text, at, "https://") { Some(at + 8) } else if starts(text, at, "http://") { Some(at + 7) } else if starts(text, at, "www.") { Some(at + 4) } else { None }
}
/// `/https?:\/\/|www\./i.test(text) || text.includes('@')`.
fn may_link(text: &[u16]) -> bool { text.contains(&(b'@' as u16)) || (0..text.len()).any(|at| address_prefix(text, at).is_some()) }
/// `URL_RE` at `at`: `\b((?:https?:\/\/|www\.)[^\s<>"'«»]+[^\s<>"'«».,:;!?)\]])`; where the match ends.
fn address_at(text: &[u16], at: usize) -> Option<usize> {
    if at > 0 && word(text[at - 1]) { return None }
    let body = address_prefix(text, at)?;
    let run = body + text[body..].iter().take_while(|unit| address_unit(**unit)).count();
    // The greedy run gives back its last characters until one that may end an address; one character stays in it.
    (body + 2..=run).rev().find(|end| address_end(text[end - 1]))
}

/// One piece of a span: its text and, for an address or a mention, where it leads.
fn link_tokens(text: &[u16]) -> Vec<(&[u16], Option<JsString>)> {
    let mut found: Vec<(usize, usize, JsString)> = Vec::new();
    let mut at = 0;
    while at < text.len() {
        let Some(end) = address_at(text, at) else { at += 1; continue };
        let raw = &text[at..end];
        let mut href = if starts(raw, 0, "https://") || starts(raw, 0, "http://") { Vec::new() } else { units("https://") };
        href.extend_from_slice(raw);
        found.push((at, end, JsString(href)));
        at = end;
    }
    let addresses = found.len();
    // MENTION_RE: `@([A-Za-z0-9_]{3,24})`.
    at = 0;
    while at < text.len() {
        let name = if text[at] == b'@' as u16 { text[at + 1..].iter().take(24).take_while(|unit| word(**unit)).count() } else { 0 };
        if name < 3 { at += 1; continue }
        let (start, end) = (at, at + 1 + name);
        at = end;
        if start > 0 && (word(text[start - 1]) || matches!(text[start - 1], 0x40 | 0x2e | 0x2f | 0x2d)) { continue }
        if text.get(end).is_some_and(|unit| word(*unit) || *unit == 0x40) { continue }
        if found[..addresses].iter().any(|(from, to, _)| start < *to && end > *from) { continue }
        let mut link = units("mention:");
        link.extend(text[start + 1..end].iter().map(|unit| ascii(*unit).map_or(*unit, |byte| byte.to_ascii_lowercase() as u16)));
        found.push((start, end, JsString(link)));
    }
    found.sort_by_key(|(start, _, _)| *start);
    let mut out = Vec::new();
    let mut last = 0;
    for (start, end, link) in found {
        if start > last { out.push((&text[last..start], None)) }
        out.push((&text[start..end], Some(link)));
        last = end;
    }
    if last < text.len() { out.push((&text[last..], None)) }
    out
}

// ─── nativeSpans.ts: nativeText ──────────────────────────────────────────────────────────────────────────────

/// What a message list draws for `text` with the message's `meta.entities`: `{"text", "fmt", "urls"}` — `fmt` holds
/// triples `[flags, offset, length]` in UTF-16 code units, `urls` one address per triple with the `LINK` flag, in
/// order (`https://…`, `http://…` or `mention:<username>`). `Value::Null` where the reference throws.
pub fn native_text(text: &JsString, entities: Option<&Value>) -> Value {
    let text = &text.0;
    let mut out: Vec<u16> = Vec::new();
    let mut fmt: Vec<Value> = Vec::new();
    let mut urls: Vec<Value> = Vec::new();
    if text.is_empty() {
    } else if !has_length(entities) && !may_link(text) {
        out = text.clone();
    } else {
        let Ok(blocks) = to_blocks(text, entities) else { return Value::Null };
        let mut add = |out: &mut Vec<u16>, piece: &[u16], flags: u32, url: Option<JsString>| {
            if piece.is_empty() { return }
            if flags != 0 || url.is_some() {
                fmt.extend([(flags | if url.is_some() { LINK } else { 0 }) as f64, out.len() as f64, piece.len() as f64].map(Value::Number));
                if let Some(url) = url { urls.push(Value::String(url)) }
            }
            out.extend_from_slice(piece);
        };
        for (index, block) in blocks.iter().enumerate() {
            if index > 0 { out.push(NEWLINE) }
            let base = match block.kind { BlockKind::Quote => QUOTE, BlockKind::Pre => PRE | MONO, BlockKind::Text => 0 };
            for span in &block.spans {
                let flags = base | span.flags;
                // An entity's address has passed `validLinkUrl`, which is stricter than `safeUrl`.
                if let Some(url) = &span.url { add(&mut out, &span.text, flags, Some(url.clone())) }
                // Code is shown as typed: an address inside it is not a link.
                else if span.flags & MONO != 0 || block.kind == BlockKind::Pre || !may_link(&span.text) { add(&mut out, &span.text, flags, None) }
                else { for (piece, url) in link_tokens(&span.text) { add(&mut out, piece, flags, url) } }
            }
        }
    }
    json::object(vec![("text", Value::String(JsString(out))), ("fmt", Value::Array(fmt)), ("urls", Value::Array(urls))])
}

const MARKS: [(u32, u32); 327] = [
    (0x300, 0x36f), (0x483, 0x489), (0x591, 0x5bd), (0x5bf, 0x5bf), (0x5c1, 0x5c2), (0x5c4, 0x5c5), (0x5c7, 0x5c7), (0x610, 0x61a), (0x64b, 0x65f),
    (0x670, 0x670), (0x6d6, 0x6dc), (0x6df, 0x6e4), (0x6e7, 0x6e8), (0x6ea, 0x6ed), (0x711, 0x711), (0x730, 0x74a), (0x7a6, 0x7b0), (0x7eb, 0x7f3),
    (0x7fd, 0x7fd), (0x816, 0x819), (0x81b, 0x823), (0x825, 0x827), (0x829, 0x82d), (0x859, 0x85b), (0x897, 0x89f), (0x8ca, 0x8e1), (0x8e3, 0x903),
    (0x93a, 0x93c), (0x93e, 0x94f), (0x951, 0x957), (0x962, 0x963), (0x981, 0x983), (0x9bc, 0x9bc), (0x9be, 0x9c4), (0x9c7, 0x9c8), (0x9cb, 0x9cd),
    (0x9d7, 0x9d7), (0x9e2, 0x9e3), (0x9fe, 0x9fe), (0xa01, 0xa03), (0xa3c, 0xa3c), (0xa3e, 0xa42), (0xa47, 0xa48), (0xa4b, 0xa4d), (0xa51, 0xa51),
    (0xa70, 0xa71), (0xa75, 0xa75), (0xa81, 0xa83), (0xabc, 0xabc), (0xabe, 0xac5), (0xac7, 0xac9), (0xacb, 0xacd), (0xae2, 0xae3), (0xafa, 0xaff),
    (0xb01, 0xb03), (0xb3c, 0xb3c), (0xb3e, 0xb44), (0xb47, 0xb48), (0xb4b, 0xb4d), (0xb55, 0xb57), (0xb62, 0xb63), (0xb82, 0xb82), (0xbbe, 0xbc2),
    (0xbc6, 0xbc8), (0xbca, 0xbcd), (0xbd7, 0xbd7), (0xc00, 0xc04), (0xc3c, 0xc3c), (0xc3e, 0xc44), (0xc46, 0xc48), (0xc4a, 0xc4d), (0xc55, 0xc56),
    (0xc62, 0xc63), (0xc81, 0xc83), (0xcbc, 0xcbc), (0xcbe, 0xcc4), (0xcc6, 0xcc8), (0xcca, 0xccd), (0xcd5, 0xcd6), (0xce2, 0xce3), (0xcf3, 0xcf3),
    (0xd00, 0xd03), (0xd3b, 0xd3c), (0xd3e, 0xd44), (0xd46, 0xd48), (0xd4a, 0xd4d), (0xd57, 0xd57), (0xd62, 0xd63), (0xd81, 0xd83), (0xdca, 0xdca),
    (0xdcf, 0xdd4), (0xdd6, 0xdd6), (0xdd8, 0xddf), (0xdf2, 0xdf3), (0xe31, 0xe31), (0xe34, 0xe3a), (0xe47, 0xe4e), (0xeb1, 0xeb1), (0xeb4, 0xebc),
    (0xec8, 0xece), (0xf18, 0xf19), (0xf35, 0xf35), (0xf37, 0xf37), (0xf39, 0xf39), (0xf3e, 0xf3f), (0xf71, 0xf84), (0xf86, 0xf87), (0xf8d, 0xf97),
    (0xf99, 0xfbc), (0xfc6, 0xfc6), (0x102b, 0x103e), (0x1056, 0x1059), (0x105e, 0x1060), (0x1062, 0x1064), (0x1067, 0x106d), (0x1071, 0x1074),
    (0x1082, 0x108d), (0x108f, 0x108f), (0x109a, 0x109d), (0x135d, 0x135f), (0x1712, 0x1715), (0x1732, 0x1734), (0x1752, 0x1753), (0x1772, 0x1773),
    (0x17b4, 0x17d3), (0x17dd, 0x17dd), (0x180b, 0x180d), (0x180f, 0x180f), (0x1885, 0x1886), (0x18a9, 0x18a9), (0x1920, 0x192b), (0x1930, 0x193b),
    (0x1a17, 0x1a1b), (0x1a55, 0x1a5e), (0x1a60, 0x1a7c), (0x1a7f, 0x1a7f), (0x1ab0, 0x1add), (0x1ae0, 0x1aeb), (0x1b00, 0x1b04), (0x1b34, 0x1b44),
    (0x1b6b, 0x1b73), (0x1b80, 0x1b82), (0x1ba1, 0x1bad), (0x1be6, 0x1bf3), (0x1c24, 0x1c37), (0x1cd0, 0x1cd2), (0x1cd4, 0x1ce8), (0x1ced, 0x1ced),
    (0x1cf4, 0x1cf4), (0x1cf7, 0x1cf9), (0x1dc0, 0x1dff), (0x20d0, 0x20f0), (0x2cef, 0x2cf1), (0x2d7f, 0x2d7f), (0x2de0, 0x2dff), (0x302a, 0x302f),
    (0x3099, 0x309a), (0xa66f, 0xa672), (0xa674, 0xa67d), (0xa69e, 0xa69f), (0xa6f0, 0xa6f1), (0xa802, 0xa802), (0xa806, 0xa806), (0xa80b, 0xa80b),
    (0xa823, 0xa827), (0xa82c, 0xa82c), (0xa880, 0xa881), (0xa8b4, 0xa8c5), (0xa8e0, 0xa8f1), (0xa8ff, 0xa8ff), (0xa926, 0xa92d), (0xa947, 0xa953),
    (0xa980, 0xa983), (0xa9b3, 0xa9c0), (0xa9e5, 0xa9e5), (0xaa29, 0xaa36), (0xaa43, 0xaa43), (0xaa4c, 0xaa4d), (0xaa7b, 0xaa7d), (0xaab0, 0xaab0),
    (0xaab2, 0xaab4), (0xaab7, 0xaab8), (0xaabe, 0xaabf), (0xaac1, 0xaac1), (0xaaeb, 0xaaef), (0xaaf5, 0xaaf6), (0xabe3, 0xabea), (0xabec, 0xabed),
    (0xfb1e, 0xfb1e), (0xfe00, 0xfe0f), (0xfe20, 0xfe2f), (0x101fd, 0x101fd), (0x102e0, 0x102e0), (0x10376, 0x1037a), (0x10a01, 0x10a03),
    (0x10a05, 0x10a06), (0x10a0c, 0x10a0f), (0x10a38, 0x10a3a), (0x10a3f, 0x10a3f), (0x10ae5, 0x10ae6), (0x10d24, 0x10d27), (0x10d69, 0x10d6d),
    (0x10eab, 0x10eac), (0x10efa, 0x10eff), (0x10f46, 0x10f50), (0x10f82, 0x10f85), (0x11000, 0x11002), (0x11038, 0x11046), (0x11070, 0x11070),
    (0x11073, 0x11074), (0x1107f, 0x11082), (0x110b0, 0x110ba), (0x110c2, 0x110c2), (0x11100, 0x11102), (0x11127, 0x11134), (0x11145, 0x11146),
    (0x11173, 0x11173), (0x11180, 0x11182), (0x111b3, 0x111c0), (0x111c9, 0x111cc), (0x111ce, 0x111cf), (0x1122c, 0x11237), (0x1123e, 0x1123e),
    (0x11241, 0x11241), (0x112df, 0x112ea), (0x11300, 0x11303), (0x1133b, 0x1133c), (0x1133e, 0x11344), (0x11347, 0x11348), (0x1134b, 0x1134d),
    (0x11357, 0x11357), (0x11362, 0x11363), (0x11366, 0x1136c), (0x11370, 0x11374), (0x113b8, 0x113c0), (0x113c2, 0x113c2), (0x113c5, 0x113c5),
    (0x113c7, 0x113ca), (0x113cc, 0x113d0), (0x113d2, 0x113d2), (0x113e1, 0x113e2), (0x11435, 0x11446), (0x1145e, 0x1145e), (0x114b0, 0x114c3),
    (0x115af, 0x115b5), (0x115b8, 0x115c0), (0x115dc, 0x115dd), (0x11630, 0x11640), (0x116ab, 0x116b7), (0x1171d, 0x1172b), (0x1182c, 0x1183a),
    (0x11930, 0x11935), (0x11937, 0x11938), (0x1193b, 0x1193e), (0x11940, 0x11940), (0x11942, 0x11943), (0x119d1, 0x119d7), (0x119da, 0x119e0),
    (0x119e4, 0x119e4), (0x11a01, 0x11a0a), (0x11a33, 0x11a39), (0x11a3b, 0x11a3e), (0x11a47, 0x11a47), (0x11a51, 0x11a5b), (0x11a8a, 0x11a99),
    (0x11b60, 0x11b67), (0x11c2f, 0x11c36), (0x11c38, 0x11c3f), (0x11c92, 0x11ca7), (0x11ca9, 0x11cb6), (0x11d31, 0x11d36), (0x11d3a, 0x11d3a),
    (0x11d3c, 0x11d3d), (0x11d3f, 0x11d45), (0x11d47, 0x11d47), (0x11d8a, 0x11d8e), (0x11d90, 0x11d91), (0x11d93, 0x11d97), (0x11ef3, 0x11ef6),
    (0x11f00, 0x11f01), (0x11f03, 0x11f03), (0x11f34, 0x11f3a), (0x11f3e, 0x11f42), (0x11f5a, 0x11f5a), (0x13440, 0x13440), (0x13447, 0x13455),
    (0x1611e, 0x1612f), (0x16af0, 0x16af4), (0x16b30, 0x16b36), (0x16f4f, 0x16f4f), (0x16f51, 0x16f87), (0x16f8f, 0x16f92), (0x16fe4, 0x16fe4),
    (0x16ff0, 0x16ff1), (0x1bc9d, 0x1bc9e), (0x1cf00, 0x1cf2d), (0x1cf30, 0x1cf46), (0x1d165, 0x1d169), (0x1d16d, 0x1d172), (0x1d17b, 0x1d182),
    (0x1d185, 0x1d18b), (0x1d1aa, 0x1d1ad), (0x1d242, 0x1d244), (0x1da00, 0x1da36), (0x1da3b, 0x1da6c), (0x1da75, 0x1da75), (0x1da84, 0x1da84),
    (0x1da9b, 0x1da9f), (0x1daa1, 0x1daaf), (0x1e000, 0x1e006), (0x1e008, 0x1e018), (0x1e01b, 0x1e021), (0x1e023, 0x1e024), (0x1e026, 0x1e02a),
    (0x1e08f, 0x1e08f), (0x1e130, 0x1e136), (0x1e2ae, 0x1e2ae), (0x1e2ec, 0x1e2ef), (0x1e4ec, 0x1e4ef), (0x1e5ee, 0x1e5ef), (0x1e6e3, 0x1e6e3),
    (0x1e6e6, 0x1e6e6), (0x1e6ee, 0x1e6ef), (0x1e6f5, 0x1e6f5), (0x1e8d0, 0x1e8d6), (0x1e944, 0x1e94a), (0xe0100, 0xe01ef),
];
