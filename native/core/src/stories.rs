//! Stories and profile posts: the rules both phones share.
//!
//! Reference: `mobile/src/stories/seenPosts.ts` (which posts were opened on this device, the order of the strip),
//! `mobile/src/stories/StoriesStrip.tsx` (who is in the strip and how each entry reads, whose stories the viewer
//! plays and where it starts, what comes before and after), `mobile/src/ProfilePosts.tsx` (the viewer's words and
//! times, picking a photo or a video, the two tabs of a profile), `mobile/src/media/swipeMath.ts` (the viewer's
//! swipes), `mobile/src/SettingsScreen.tsx` («Кто видит мои истории и записи») and `server/src/posts.js` (the
//! caption's limit). Pinned to the reference's own answers by `tests/stories_vectors.rs`.
//!
//! The media of a story or a post is NOT end-to-end encrypted in the reference: it is an ordinary profile upload
//! (`POST /uploads?purpose=post`, read back by `GET /files/<id>`), kept by the server as it is, like the avatar.
//! An answer to a story IS: an ordinary encrypted message to the author with `meta.story` inside the ciphertext.

use crate::json::{self, JsString, Value};
use crate::time::{iso_from_ms, parse_iso_ms};
use std::cmp::Ordering;
use std::collections::HashSet;

/// A photo of a story stays this long; a video plays to its end.
pub const STORY_PHOTO_MS: f64 = 5000.0;
/// «Видео недоступно» shows this long, then a story moves on.
pub const VIDEO_FAILED_MS: f64 = 1500.0;
/// How often the strip re-reads the feed on its own.
pub const REFRESH_MS: f64 = 300_000.0;
pub const MAX_CAPTION: usize = 300;
pub const SEEN_POSTS_LIMIT: usize = 500;
/// Above this size an upload goes in chunks.
pub const SMALL_UPLOAD: f64 = 20.0 * 1024.0 * 1024.0;
const DISMISS_DISTANCE: f64 = 120.0;
const DISMISS_VELOCITY: f64 = 900.0;
const PAGE_FRACTION: f64 = 0.25;
const PAGE_VELOCITY: f64 = 600.0;

const AUDIENCES: [(&str, &str, &str); 2] = [
    ("friends", "Друзья", "Истории и записи видят только твои друзья."),
    ("everyone", "Все", "Истории и записи видит любой, кого ты не заблокировал."),
];

fn s(text: &str) -> Value { Value::str(text) }

/// What JavaScript's `trim` and `\s` call white space, as a UTF-16 code unit.
fn js_space(unit: u16) -> bool {
    matches!(unit, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
fn trim(text: &[u16]) -> &[u16] {
    let Some(start) = text.iter().position(|unit| !js_space(*unit)) else { return &[] };
    let end = text.iter().rposition(|unit| !js_space(*unit)).map_or(start, |last| last + 1);
    &text[start..end]
}
/// `value ? … : …`
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => *number != 0.0 && !number.is_nan(),
        Some(Value::String(text)) => !text.0.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}
/// A number inside a template string: `String(number)`.
fn number_string(number: f64) -> String {
    if number.is_nan() { "NaN".to_string() } else if number.is_infinite() { if number > 0.0 { "Infinity" } else { "-Infinity" }.to_string() } else { json::number_text(number) }
}
/// `Math.round`: halves go up.
fn round(number: f64) -> f64 {
    let floor = number.floor();
    if number - floor >= 0.5 { floor + 1.0 } else { floor }
}
/// `Math.max(0, number)`.
fn at_least_zero(number: f64) -> f64 { if number.is_nan() { f64::NAN } else if number > 0.0 { number } else { 0.0 } }
/// `Math.sign`.
fn sign(number: f64) -> f64 { if number.is_nan() { f64::NAN } else if number > 0.0 { 1.0 } else if number < 0.0 { -1.0 } else { 0.0 } }
/// Sets a key the way `{...object, key: value}` does: in its old place, or at the end.
fn set(entries: &mut Vec<(JsString, Value)>, key: &str, value: Value) {
    let key = JsString::from_str(key);
    match entries.iter_mut().find(|(name, _)| *name == key) { Some(entry) => entry.1 = value, None => entries.push((key, value)) }
}
fn strings(list: &[Value]) -> Option<Vec<&JsString>> {
    list.iter().map(|item| match item { Value::String(text) => Some(text), _ => None }).collect()
}
fn id_of(value: &Value) -> Option<&JsString> {
    match value.get("id") { Some(Value::String(id)) => Some(id), _ => None }
}
/// `list.slice(-SEEN_POSTS_LIMIT)`.
fn newest(mut list: Vec<Value>) -> Vec<Value> {
    if list.len() > SEEN_POSTS_LIMIT { list.drain(..list.len() - SEEN_POSTS_LIMIT); }
    list
}

// ---- Posts opened on this device ----

/// The stored list, validated: strings only, no duplicates, at most `SEEN_POSTS_LIMIT` (newest kept).
pub fn parse_seen_posts(raw: Option<&JsString>) -> Vec<Value> {
    let Some(raw) = raw.filter(|raw| !raw.0.is_empty()) else { return Vec::new() };
    let Some(text) = raw.to_str() else { return Vec::new() };
    let Ok(Value::Array(list)) = json::parse(&text) else { return Vec::new() };
    let mut known: HashSet<&JsString> = HashSet::new();
    let mut ids = Vec::new();
    for item in &list {
        if let Value::String(id) = item {
            if !id.0.is_empty() && id.0.len() <= 200 && known.insert(id) { ids.push(Value::String(id.clone())) }
        }
    }
    newest(ids)
}

/// The list with `ids` added (the oldest dropped past the limit); the same list when all were there already.
pub fn with_seen_posts(list: &[Value], ids: &[Value]) -> Option<Vec<Value>> {
    let (have, added) = (strings(list)?, strings(ids)?);
    let mut fresh: Vec<&JsString> = Vec::new();
    for id in added {
        if !id.0.is_empty() && !have.contains(&id) && !fresh.contains(&id) { fresh.push(id) }
    }
    if fresh.is_empty() { return Some(list.to_vec()) }
    Some(newest(list.iter().cloned().chain(fresh.into_iter().map(|id| Value::String(id.clone()))).collect()))
}

// ---- The strip above the chats ----

/// One person of the feed (`StoryFeedItem`), read strictly: a wrong kind anywhere is no answer.
struct Entry<'a> {
    id: &'a JsString,
    name: &'a JsString,
    stories: &'a [Value],
    unseen: f64,
    posts: &'a [Value],
    pending: bool,
    latest: Option<&'a JsString>,
}

fn posts_list(list: &[Value]) -> Option<&[Value]> {
    if list.iter().all(|post| id_of(post).is_some()) { Some(list) } else { None }
}

fn entry(value: &Value) -> Option<Entry<'_>> {
    let user = value.get("user")?;
    let id = id_of(user)?;
    let Some(Value::String(name)) = user.get("displayName") else { return None };
    let Some(Value::Array(stories)) = value.get("stories") else { return None };
    let Some(Value::Number(unseen)) = value.get("unseen") else { return None };
    let posts: &[Value] = match value.get("posts") { None | Some(Value::Null) => &[], Some(Value::Array(list)) => list, _ => return None };
    let latest = match value.get("latest") { None | Some(Value::Null) => None, Some(Value::String(text)) => Some(text).filter(|text| !text.0.is_empty()), _ => return None };
    Some(Entry { id, name, stories: posts_list(stories)?, unseen: *unseen, posts: posts_list(posts)?, pending: truthy(value.get("pending")), latest })
}

struct Feed<'a> { items: Vec<Entry<'a>>, mine: &'a [Value] }

fn feed(value: &Value) -> Option<Feed<'_>> {
    let (Some(Value::Array(items)), Some(Value::Array(mine))) = (value.get("items"), value.get("mine")) else { return None };
    Some(Feed { items: items.iter().map(entry).collect::<Option<Vec<_>>>()?, mine: posts_list(mine)? })
}

/// Something new to look at: an unwatched story, or (for a person shown for a post) a post not opened here yet.
fn has_unseen(item: &Entry, seen: &HashSet<&JsString>) -> bool {
    if !item.stories.is_empty() { item.unseen > 0.0 } else { item.posts.iter().any(|post| id_of(post).is_some_and(|id| !seen.contains(id))) }
}

/// The strip's order: people with something unseen, then the rest; inside each group the newest story or post
/// first. The reference compares the times with `localeCompare`; for the server's times (ISO, one spelling) that
/// is the order of their code units, which is what is compared here. An entry without a time ties with every
/// other of its group, as in the reference — the server sends the time for all of them or (an older one) for none.
fn strip_order<'a, 'b>(items: &'b [Entry<'a>], seen: &HashSet<&JsString>) -> Vec<&'b Entry<'a>> {
    let mut people: Vec<&Entry> = items.iter().collect();
    people.sort_by(|a, b| {
        has_unseen(b, seen).cmp(&has_unseen(a, seen)).then_with(|| match (a.latest, b.latest) {
            (Some(a), Some(b)) => b.0.cmp(&a.0),
            _ => Ordering::Equal,
        })
    });
    people
}

fn seen_set(list: &[Value]) -> Option<HashSet<&JsString>> { Some(strings(list)?.into_iter().collect()) }

/// The strip as it is shown: `{show, mine: {has, label, spoken}, people: [{id, name, spoken, post, pending, fresh,
/// sub}], order}`. `show` is false while nobody (the person included) has anything; `name` is the first word of the
/// person's name; `fresh` lights the ring; `sub` is «запись», «заявка» or nothing; `order` is whose stories the
/// viewer goes through: the person's own first when there are any.
pub fn strip(feed_value: &Value, seen: &[Value], me: &JsString) -> Option<Value> {
    let (feed, seen) = (feed(feed_value)?, seen_set(seen)?);
    let people = strip_order(&feed.items, &seen);
    let has_mine = !feed.mine.is_empty();
    let shown: Vec<Value> = people.iter().map(|item| {
        let post = item.stories.is_empty();
        let first: Vec<u16> = trim(&item.name.0).iter().copied().take_while(|unit| !js_space(*unit)).collect();
        let state = if post { ", запись".to_string() } else if item.unseen != 0.0 && !item.unseen.is_nan() { format!(", новых историй: {}", number_string(item.unseen)) } else { ", истории просмотрены".to_string() };
        let mut spoken = item.name.0.clone();
        spoken.extend(state.encode_utf16());
        if item.pending { spoken.extend(", заявка".encode_utf16()) }
        json::object(vec![
            ("id", Value::String(item.id.clone())),
            ("name", Value::String(if first.is_empty() { item.name.clone() } else { JsString(first) })),
            ("spoken", Value::String(JsString(spoken))),
            ("post", Value::Bool(post)),
            ("pending", Value::Bool(item.pending)),
            ("fresh", Value::Bool(has_unseen(item, &seen))),
            ("sub", s(if post { "запись" } else if item.pending { "заявка" } else { "" })),
        ])
    }).collect();
    let mut order: Vec<Value> = Vec::new();
    if has_mine { order.push(Value::String(me.clone())) }
    order.extend(people.iter().map(|item| Value::String(item.id.clone())));
    Some(json::object(vec![
        ("show", Value::Bool(!feed.items.is_empty() || has_mine)),
        ("mine", json::object(vec![("has", Value::Bool(has_mine)), ("label", s("Моя история")), ("spoken", s(if has_mine { "Моя история" } else { "Добавить историю" }))])),
        ("people", Value::Array(shown)),
        ("order", Value::Array(order)),
    ]))
}

/// What the viewer plays for the person whose id is `viewing`: `{open, own, posts, items, start, before, after}`.
/// `items` are the ids of their live stories, oldest first — or, when they have none, of their recent posts
/// (`posts` is then true). `start`: moving forward, a friend's first unwatched story (the first one for the
/// person's own stories and for posts); moving back (`entered` below zero), the last one. `before` and `after`:
/// whose stories come when these end or are swiped away, or null.
pub fn viewer(feed_value: &Value, seen: &[Value], me: &JsString, viewing: &JsString, entered: f64) -> Option<Value> {
    let (feed, seen) = (feed(feed_value)?, seen_set(seen)?);
    let people = strip_order(&feed.items, &seen);
    let own = viewing == me;
    let shown = if own { None } else { people.iter().find(|item| item.id == viewing) };
    let posts_shown = shown.is_some_and(|item| item.stories.is_empty());
    let current: Option<&[Value]> = if own { Some(feed.mine) } else { shown.map(|item| if posts_shown { item.posts } else { item.stories }) };
    let mut order: Vec<&JsString> = Vec::new();
    if !feed.mine.is_empty() { order.push(me) }
    order.extend(people.iter().map(|item| item.id));
    let at = order.iter().position(|id| *id == viewing);
    let neighbour = |id: Option<&&JsString>| id.map_or(Value::Null, |id| Value::String((*id).clone()));
    let before = match at { Some(at) if at > 0 => neighbour(order.get(at - 1)), _ => Value::Null };
    let after = match at { Some(at) => neighbour(order.get(at + 1)), None => Value::Null };
    let start = match current {
        None => 0.0,
        Some(list) if entered < 0.0 => list.len() as f64 - 1.0,
        Some(_) if own || posts_shown => 0.0,
        Some(list) => list.iter().position(|story| !truthy(story.get("seen"))).unwrap_or(0) as f64,
    };
    let items: Vec<Value> = current.unwrap_or(&[]).iter().filter_map(id_of).map(|id| Value::String(id.clone())).collect();
    Some(json::object(vec![
        ("open", Value::Bool(!items.is_empty())),
        ("own", Value::Bool(own)),
        ("posts", Value::Bool(posts_shown)),
        ("items", Value::Array(items)),
        ("start", Value::Number(start)),
        ("before", before),
        ("after", after),
    ]))
}

/// The feed after a friend's story was watched: that story is seen and the person has one unseen less. Null when
/// there is nothing to change (no such person or story, or the story was seen already — nothing is told to the
/// server then either).
pub fn viewed(feed_value: &Value, user_id: &JsString, story_id: &JsString) -> Option<Value> {
    let parsed = feed(feed_value)?;
    let Some(item) = parsed.items.iter().find(|item| item.id == user_id) else { return Some(Value::Null) };
    let Some(story) = item.stories.iter().find(|story| id_of(story) == Some(story_id)) else { return Some(Value::Null) };
    if truthy(story.get("seen")) { return Some(Value::Null) }
    let (Value::Object(top), Some(Value::Array(items))) = (feed_value, feed_value.get("items")) else { return None };
    let changed: Vec<Value> = items.iter().zip(&parsed.items).map(|(raw, item)| {
        let Value::Object(fields) = raw else { return raw.clone() };
        if item.id != user_id { return raw.clone() }
        let mut fields = fields.clone();
        set(&mut fields, "unseen", Value::Number(at_least_zero(item.unseen - 1.0)));
        set(&mut fields, "stories", Value::Array(item.stories.iter().map(|story| {
            let Value::Object(story_fields) = story else { return story.clone() };
            if id_of(story) != Some(story_id) { return story.clone() }
            let mut story_fields = story_fields.clone();
            set(&mut story_fields, "seen", Value::Bool(true));
            Value::Object(story_fields)
        }).collect()));
        Value::Object(fields)
    }).collect();
    let mut top = top.clone();
    set(&mut top, "items", Value::Array(changed));
    Some(Value::Object(top))
}

// ---- The viewer ----

/// The quiet line under the name: «только что» / «5 ч назад» for a story, «2 из 7» for a post.
pub fn headline(created_at: &JsString, now_ms: f64, story: bool, index: f64, count: f64) -> String {
    if !story { return format!("{} из {}", number_string(index + 1.0), number_string(count)) }
    let when = created_at.to_str().and_then(|text| parse_iso_ms(&text)).unwrap_or(f64::NAN);
    let ago = at_least_zero(round((now_ms - when) / 3_600_000.0));
    if ago < 1.0 { "только что".to_string() } else { format!("{} ч назад", number_string(ago)) }
}

/// Swipe up or down to close. A flick back towards the middle does not close even past the distance.
fn should_dismiss(translation: f64, velocity: f64) -> bool {
    if !translation.is_finite() || !velocity.is_finite() { return false }
    let flick_back = translation != 0.0 && sign(velocity) != sign(translation) && velocity.abs() > DISMISS_VELOCITY / 2.0;
    if translation.abs() > DISMISS_DISTANCE && !flick_back { return true }
    velocity.abs() > DISMISS_VELOCITY && (translation == 0.0 || sign(velocity) == sign(translation))
}

/// The axis a drag locks to once it has moved past the slop: the larger component wins.
pub fn swipe_axis(dx: f64, dy: f64) -> &'static str { if dx.abs() > dy.abs() { "x" } else { "y" } }

/// What a finished drag does: left — the next story (or post), right — the previous one, down — close, up — the
/// answer or the list of viewers. A short or reversed drag springs back («cancel»).
pub fn swipe(axis: &str, tx: f64, ty: f64, vx: f64, vy: f64, width: f64) -> &'static str {
    if axis == "x" {
        let (far, fast) = (tx.abs() > width * PAGE_FRACTION, vx.abs() > PAGE_VELOCITY);
        if tx == 0.0 || !(far || fast) { return "cancel" }
        if vx.abs() > PAGE_VELOCITY / 2.0 && sign(vx) != sign(tx) { return "cancel" }
        return if tx < 0.0 { "next" } else { "previous" };
    }
    if ty > 0.0 && should_dismiss(ty, vy) { return "close" }
    if ty < -60.0 || (ty < 0.0 && vy < -DISMISS_VELOCITY / 2.0) { return "up" }
    "cancel"
}

/// Where the page is while the finger drags it: `{x, y, progress}`. Sideways it follows the finger (a third as
/// far when there is nothing beyond); down it follows, up a quarter as far; `progress` (0 … 1) is how far the pull
/// down has gone towards closing — the page shrinks to 0.86 and the black behind fades to 0.15 with it.
pub fn drag(axis: &str, tx: f64, ty: f64, has_next: bool, has_previous: bool, height: f64) -> Value {
    let (mut x, mut y) = (0.0, 0.0);
    if axis == "x" {
        let open = if tx < 0.0 { has_next } else { has_previous };
        x = if open { tx } else { tx / 3.0 };
    } else {
        y = if ty > 0.0 { ty } else { ty / 4.0 };
    }
    let pulled = at_least_zero(y);
    let progress = if !pulled.is_finite() || !(height > 0.0) { 0.0 } else { (pulled.abs() / (height / 2.0)).min(1.0) };
    json::object(vec![("x", Value::Number(x)), ("y", Value::Number(y)), ("progress", Value::Number(progress))])
}

/// «Просмотры» of the person's own story: `{count, spoken, heading}`.
pub fn views(count: Option<f64>) -> Value {
    let count = count.unwrap_or(0.0);
    json::object(vec![("count", Value::Number(count)), ("spoken", s(&format!("Просмотры: {}", number_string(count)))), ("heading", s(&format!("Просмотров: {}", number_string(count))))])
}

/// When a person watched, as the list of viewers shows it: the clock today, «вчера», else «21 нояб.». The local
/// clock is given as the two moments' offsets from UTC in minutes.
pub fn viewed_at(at: &JsString, now_ms: f64, offset_at_min: f64, offset_now_min: f64) -> String {
    let Some(at) = at.to_str().and_then(|text| parse_iso_ms(&text)) else { return "Invalid Date".to_string() };
    let (local, local_now) = (at + offset_at_min * 60_000.0, now_ms + offset_now_min * 60_000.0);
    if !local.is_finite() || !local_now.is_finite() || local.abs() > 8.64e15 { return "Invalid Date".to_string() }
    let (day, today) = ((local / 86_400_000.0).floor(), (local_now / 86_400_000.0).floor());
    let stamp = iso_from_ms(local.floor() as i64);
    if day == today { return stamp[11..16].to_string() }
    if day == today - 1.0 { return "вчера".to_string() }
    const MONTHS: [&str; 12] = ["янв.", "февр.", "мар.", "апр.", "мая", "июн.", "июл.", "авг.", "сент.", "окт.", "нояб.", "дек."];
    let (month, day_of_month): (usize, u32) = (stamp[5..7].parse().unwrap_or(1), stamp[8..10].parse().unwrap_or(1));
    format!("{day_of_month} {}", MONTHS[(month.max(1) - 1).min(11)])
}

// ---- Publishing ----

/// A caption as the server takes it: `{caption, error, left}` — the text without the white space around it, the
/// refusal when it is longer than 300 (counted before trimming, in UTF-16 units), and how many units are left.
pub fn caption(text: &JsString) -> Value {
    let length = text.0.len();
    json::object(vec![
        ("caption", Value::String(JsString(trim(&text.0).to_vec()))),
        ("error", s(if length > MAX_CAPTION { "Подпись — до 300 символов." } else { "" })),
        ("left", Value::Number(MAX_CAPTION as f64 - length as f64)),
    ])
}

/// How a picked photo or video is uploaded: `{error}` when it may not be, else `{error: "", name, mimeType,
/// resizeWidth, quality, purpose, chunked}`. A photo wider than 1600 px is scaled to 1600 and written as a JPEG at
/// 0.85; a video may be a minute long and goes in chunks above 20 MiB.
pub fn upload(file: &Value) -> Option<Value> {
    let Value::Object(_) = file else { return None };
    let number = |key: &str| match file.get(key) { Some(Value::Number(number)) => Some(*number), None | Some(Value::Null) => Some(0.0), _ => None };
    let (width, duration, size) = (number("width")?, number("durationMs")?, number("size")?);
    if truthy(file.get("video")) {
        if duration > 60_500.0 { return Some(json::object(vec![("error", s("Видео — не длиннее минуты."))])) }
        let mime = match file.get("mimeType") { Some(Value::String(text)) if !text.0.is_empty() => Value::String(text.clone()), None | Some(Value::Null) | Some(Value::String(_)) => s("video/mp4"), _ => return None };
        return Some(json::object(vec![("error", s("")), ("name", s("post.mp4")), ("mimeType", mime), ("resizeWidth", Value::Null), ("quality", Value::Null), ("purpose", s("post")), ("chunked", Value::Bool(size > SMALL_UPLOAD))]));
    }
    Some(json::object(vec![("error", s("")), ("name", s("post.jpg")), ("mimeType", s("image/jpeg")), ("resizeWidth", if width > 1600.0 { Value::Number(1600.0) } else { Value::Null }),
        ("quality", Value::Number(0.85)), ("purpose", s("post")), ("chunked", Value::Bool(false))]))
}

// ---- A profile ----

/// The two tabs of a profile with their counts: «Публикации 3», «Истории».
pub fn tabs(posts: f64, stories: f64) -> Value {
    let label = |name: &str, count: f64| if count != 0.0 && !count.is_nan() { s(&format!("{name} {}", number_string(count))) } else { s(name) };
    Value::Array(vec![label("Публикации", posts), label("Истории", stories)])
}

/// An empty tab: `{emoji, heading, hint, button}` (`button` is null on another person's profile).
pub fn empty(tab: &str, own: bool) -> Option<Value> {
    let post = match tab { "post" => true, "story" => false, _ => return None };
    let hint = match (own, post) {
        (true, true) => "Публикуй фото и видео в своём профиле — их увидят друзья.",
        (true, false) => "История видна друзьям 24 часа, потом исчезает.",
        (false, true) => "Здесь появятся фото и видео.",
        (false, false) => "Сейчас историй нет.",
    };
    Some(json::object(vec![
        ("emoji", s(if post { "🖼️" } else { "✨" })),
        ("heading", s(if post { "Публикаций пока нет…" } else { "Историй пока нет…" })),
        ("hint", s(hint)),
        ("button", if own { s(if post { "Добавить публикацию" } else { "Добавить историю" }) } else { Value::Null }),
    ]))
}

/// «Кто видит мои истории и записи» as it stands: `{value, label, hint}`; anything unknown is «Друзья».
pub fn audience(value: &Value) -> Value {
    let wanted = value.as_str().unwrap_or_default();
    let found = AUDIENCES.iter().find(|item| item.0 == wanted).unwrap_or(&AUDIENCES[0]);
    json::object(vec![("value", s(found.0)), ("label", s(found.1)), ("hint", s(found.2))])
}

fn rules() -> Value {
    let n = Value::Number;
    let words: Vec<(&str, &str)> = vec![
        ("mine", "Моя история"), ("addStory", "Добавить историю"), ("addPost", "Добавить публикацию"), ("post", "запись"), ("pending", "заявка"),
        ("addStoryFailed", "Не удалось добавить историю."), ("addPostFailed", "Не удалось добавить публикацию."), ("removeFailed", "Не удалось удалить."),
        ("videoTooLong", "Видео — не длиннее минуты."), ("mediaOnly", "Публикация — фото или видео MP4/MOV."),
        ("hidden", "Публикации и истории видны только друзьям"), ("tabPosts", "Публикации"), ("tabStories", "Истории"),
        ("removePost", "Публикация"), ("removeStory", "История"), ("remove", "Удалить"), ("removeAbout", "Исчезнет из профиля у всех."),
        ("videoGone", "Видео недоступно"), ("previous", "Предыдущее"), ("next", "Следующее"), ("close", "Закрыть"),
        ("views", "Просмотры"), ("nobodyWatched", "Пока никто не смотрел"), ("reply", "Ответить…"), ("replyLabel", "Ответ на историю"), ("sendReply", "Отправить ответ"),
        ("replySent", "Ответ отправлен в чат"), ("replyFailed", "Не удалось отправить ответ."), ("noChat", "Не удалось открыть чат с автором."),
        ("photo", "Фото"), ("video", "Видео"), ("stories", "Истории"), ("profileMedia", "Фото и видео профиля"), ("quote", "История"), ("openStory", "Открыть историю"),
        ("storyGone", "История недоступна"),
    ];
    json::object(vec![
        ("photoMs", n(STORY_PHOTO_MS)), ("minStepMs", n(60.0)), ("videoFailedMs", n(VIDEO_FAILED_MS)), ("refreshMs", n(REFRESH_MS)), ("holdMs", n(220.0)),
        ("captionMax", n(MAX_CAPTION as f64)), ("replyMax", n(4000.0)), ("videoMaxMs", n(60_500.0)), ("videoPickSeconds", n(60.0)),
        ("photoMaxWidth", n(1600.0)), ("photoQuality", n(0.85)), ("smallUpload", n(SMALL_UPLOAD)),
        ("seenLimit", n(SEEN_POSTS_LIMIT as f64)), ("seenKey", s("linea.seen-posts.v1:")), ("avatar", n(56.0)), ("columns", n(3.0)), ("gap", n(2.0)),
        ("audienceGroup", s("Истории и записи")), ("audienceTitle", s("Кто видит мои истории и записи")),
        ("audiences", Value::Array(AUDIENCES.iter().map(|item| json::object(vec![("value", s(item.0)), ("label", s(item.1)), ("hint", s(item.2))])).collect())),
        ("words", json::object(words.into_iter().map(|(key, text)| (key, s(text))).collect())),
    ])
}

// ---- By name, for the apps (`invizent_view`) ----

/// The functions above by name; `args` are the JSON arguments. `None`: an unknown name or arguments of the wrong
/// kind.
/// - `storiesRules []` → the times, limits, sizes and words: `{photoMs, minStepMs, videoFailedMs, refreshMs, holdMs,
///   captionMax, replyMax, videoMaxMs, videoPickSeconds, photoMaxWidth, photoQuality, smallUpload, seenLimit,
///   seenKey, avatar, columns, gap, audienceGroup, audienceTitle, audiences, words}`.
/// - `storiesSeenParse [text|null]` → the ids of the posts opened on this device, read back from storage.
/// - `storiesSeenAdd [ids, added]` → the list to keep.
/// - `storiesStrip [feed, seenIds, myId]` → the strip (see `strip`).
/// - `storiesViewer [feed, seenIds, myId, viewingId, entered]` → what the viewer plays (see `viewer`).
/// - `storiesViewed [feed, userId, storyId]` → the feed with that story watched, or null when nothing changes.
/// - `storiesHeadline [createdAt, nowMs, story, index, count]` → «только что», «5 ч назад» or «2 из 7».
/// - `storiesAxis [dx, dy]` → "x" or "y"; `storiesSwipe [axis, tx, ty, vx, vy, width]` → "next", "previous",
///   "close", "up" or "cancel"; `storiesDrag [axis, tx, ty, hasNext, hasPrevious, height]` → `{x, y, progress}`.
/// - `storiesViews [count|null]` → `{count, spoken, heading}`; `storiesViewedAt [viewedAt, nowMs, offsetAtMin,
///   offsetNowMin]` → the time in the list of viewers.
/// - `storiesCaption [text]` → `{caption, error, left}`; `storiesUpload [{video, width, durationMs, mimeType,
///   size}]` → how the file goes up.
/// - `storiesTabs [posts, stories]` → the two labels; `storiesEmpty [tab, own]` → an empty tab's words;
///   `storiesAudience [value|null]` → `{value, label, hint}`.
pub fn view(name: &str, args: &[Value]) -> Option<Value> {
    use Value::{Array, Bool, Null, Number, String as Text};
    Some(match (name, args) {
        ("storiesRules", []) => rules(),
        ("storiesSeenParse", [Null]) => Array(Vec::new()),
        ("storiesSeenParse", [Text(raw)]) => Array(parse_seen_posts(Some(raw))),
        ("storiesSeenAdd", [Array(list), Array(ids)]) => Array(with_seen_posts(list, ids)?),
        ("storiesStrip", [feed, Array(seen), Text(me)]) => strip(feed, seen, me)?,
        ("storiesViewer", [feed, Array(seen), Text(me), Text(viewing), Number(entered)]) => viewer(feed, seen, me, viewing, *entered)?,
        ("storiesViewed", [feed, Text(user), Text(story)]) => viewed(feed, user, story)?,
        ("storiesHeadline", [Text(created), Number(now), Bool(story), Number(index), Number(count)]) => s(&headline(created, *now, *story, *index, *count)),
        ("storiesAxis", [Number(dx), Number(dy)]) => s(swipe_axis(*dx, *dy)),
        ("storiesSwipe", [Text(axis), Number(tx), Number(ty), Number(vx), Number(vy), Number(width)]) => {
            let axis = axis.to_string_lossy();
            if axis != "x" && axis != "y" { return None }
            s(swipe(&axis, *tx, *ty, *vx, *vy, *width))
        }
        ("storiesDrag", [Text(axis), Number(tx), Number(ty), Bool(has_next), Bool(has_previous), Number(height)]) => {
            let axis = axis.to_string_lossy();
            if axis != "x" && axis != "y" { return None }
            drag(&axis, *tx, *ty, *has_next, *has_previous, *height)
        }
        ("storiesViews", [Null]) => views(None),
        ("storiesViews", [Number(count)]) => views(Some(*count)),
        ("storiesViewedAt", [Text(at), Number(now), Number(offset_at), Number(offset_now)]) => s(&viewed_at(at, *now, *offset_at, *offset_now)),
        ("storiesCaption", [Text(text)]) => caption(text),
        ("storiesUpload", [file]) => upload(file)?,
        ("storiesTabs", [Number(posts), Number(stories)]) => tabs(*posts, *stories),
        ("storiesEmpty", [Text(tab), Bool(own)]) => empty(&tab.to_string_lossy(), *own)?,
        ("storiesAudience", [value]) => audience(value),
        _ => return None,
    })
}
