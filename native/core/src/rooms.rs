//! Rooms («комнаты»): the rules both phones follow for the lasting voice rooms of a fixed set of friends.
//!
//! Reference: `mobile/src/rooms/rooms.ts` (the order of the list, what the live line's `room.*` events do to it,
//! the ring, a group call from the chat list, where everyone sits, the words «трое внутри» and «спит · были вчера
//! в 18:20»), `mobile/src/communities/voiceAuth.ts` (the end-to-end check of a connection: the note two devices
//! exchange inside Signal about the DTLS fingerprints they see), `voiceRestartOfferer` of
//! `mobile/src/calls/reconnect.ts`, and the «music for everyone» wire of `mobile/src/rooms/roomMusic.tsx` with
//! the 512 characters `mobile/src/communities/voice.ts` allows it. Pinned to the reference by
//! `tests/rooms_vectors.rs` (vectors from `tests/generate-rooms-vectors.mjs`, which runs the reference itself).
//!
//! Nothing here touches the network or the media. The connection of two people in a room is the same one as in a
//! one-to-one call, so its reconnection, the link's grade and the restart marker are asked of `calls.rs`.
//!
//! Where the reference would throw on a value of the wrong kind (a room without its list of members), the answer
//! here is the quiet one: the event changes nothing, or there is no answer at all. `Date.parse` is the narrower
//! ISO reader of `time.rs` (the server writes no other form).

use crate::json::{self, JsString, Value};
use crate::time::parse_iso_ms;

/// Members of a room, the creator included.
pub const ROOM_LIMIT: usize = 12;
pub const MAX_ROOM_NAME: f64 = 48.0;
/// How long a «зовёт в комнату» call rings before it gives up on its own.
pub const RING_MS: f64 = 30_000.0;
/// A connection whose check has not come in this time is refused.
pub const AUTH_TIMEOUT_MS: f64 = 20_000.0;
pub const LINK_POLL_MS: f64 = 4_000.0;
pub const SPEAKING_POLL_MS: f64 = 350.0;
/// The sound level above which a person is shown as talking.
pub const SPEAKING_LEVEL: f64 = 0.02;
/// How far a listener may drift from the one who leads the music before it jumps to the leader's place, seconds.
pub const MUSIC_DRIFT: f64 = 2.5;
pub const MUSIC_BEAT_MS: f64 = 4_000.0;
/// What one message of the peer-to-peer channel may hold, in UTF-16 code units.
pub const CONTROL_LIMIT: usize = 512;
pub const MUSIC_OFF: &str = "{\"type\":\"music\",\"off\":true}";
pub const TALK_COLOR: &str = "#3EE08E";
pub const REFUSED_TEXT: &str = "Не удалось подтвердить шифрование с участником — соединение с ним отключено.";

// ---- JavaScript's view of a JSON value, and texts as code units ----

fn units(text: &str) -> Vec<u16> { text.encode_utf16().collect() }
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => *number != 0.0 && !number.is_nan(),
        Some(Value::String(text)) => !text.0.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}
fn text_of(value: Option<&Value>) -> Option<&JsString> { match value { Some(Value::String(text)) => Some(text), _ => None } }
fn list_of(value: Option<&Value>) -> Option<&Vec<Value>> { match value { Some(Value::Array(list)) => Some(list), _ => None } }
/// `a === b` for two values of which a text is wanted: true only for two equal texts.
fn same_text(a: Option<&Value>, b: Option<&Value>) -> bool { matches!((text_of(a), text_of(b)), (Some(a), Some(b)) if a == b) }
/// `{...object, key: value}`: the key keeps its place when it is there already, and is added last when not.
fn set(entries: &mut Vec<(JsString, Value)>, key: &str, value: Value) {
    let key = JsString::from_str(key);
    match entries.iter_mut().find(|(name, _)| *name == key) {
        Some(entry) => entry.1 = value,
        None => entries.push((key, value)),
    }
}
/// What JavaScript's `trim` and `\s` call white space, as a UTF-16 code unit.
fn js_space(unit: u16) -> bool {
    matches!(unit, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
fn trim(text: &[u16]) -> &[u16] {
    let Some(start) = text.iter().position(|unit| !js_space(*unit)) else { return &[] };
    let end = text.iter().rposition(|unit| !js_space(*unit)).expect("found from the start") + 1;
    &text[start..end]
}
/// `Math.round`.
fn js_round(number: f64) -> f64 { if number.fract() == -0.5 { number.ceil() } else { number.round() } }

// ---- The list (rooms.ts) ----

/// A room the list can hold: an object with its id, the people inside as a list and its members as a list.
fn well_formed(room: &Value) -> bool {
    matches!(room, Value::Object(_)) && text_of(room.get("id")).is_some_and(|id| !id.0.is_empty()) && list_of(room.get("inside")).is_some() && list_of(room.get("members")).is_some()
}
fn inside_count(room: &Value) -> usize { list_of(room.get("inside")).map_or(0, Vec::len) }
/// `Date.parse(room.lastActiveAt || room.createdAt) || 0`.
fn used(room: &Value) -> f64 {
    let stamp = if truthy(room.get("lastActiveAt")) { room.get("lastActiveAt") } else { room.get("createdAt") };
    text_of(stamp).and_then(|text| parse_iso_ms(&text.to_string_lossy())).filter(|ms| ms.is_finite()).unwrap_or(0.0)
}

/// Awake rooms first (the busiest on top), then the sleeping ones by when they were last used. Rooms that are
/// equal in all of it keep their order.
pub fn sort_rooms(rooms: &[Value]) -> Vec<Value> {
    let mut out = rooms.to_vec();
    out.sort_by(|a, b| {
        let key = |room: &Value| (inside_count(room) > 0, truthy(room.get("awake")), inside_count(room), used(room));
        let (x, y) = (key(a), key(b));
        y.0.cmp(&x.0).then(y.1.cmp(&x.1)).then(y.2.cmp(&x.2)).then(y.3.partial_cmp(&x.3).unwrap_or(std::cmp::Ordering::Equal))
    });
    out
}

/// What the app keeps about rooms: the list (None before it was read), the room open on screen, the ring.
pub struct RoomsState { pub rooms: Option<Vec<Value>>, pub open_id: Value, pub ring: Value }
impl RoomsState {
    pub fn read(value: &Value) -> Option<RoomsState> {
        let rooms = match value.get("rooms") { Some(Value::Array(rooms)) => Some(rooms.clone()), Some(Value::Null) | None => None, _ => return None };
        Some(RoomsState { rooms, open_id: value.get("openId").cloned().unwrap_or(Value::Null), ring: value.get("ring").cloned().unwrap_or(Value::Null) })
    }
    pub fn written(self) -> Value {
        json::object(vec![("rooms", self.rooms.map_or(Value::Null, Value::Array)), ("openId", self.open_id), ("ring", self.ring)])
    }
}

/// An event of the live line. `None`: it is not about rooms (its type does not begin with `room.`). Otherwise
/// the state after it: `room.created` / `room.updated` put the room into the list, `room.removed` takes it out
/// (and closes it on screen, and stops its ring), `room.state` says who is inside (the ring stops once this
/// account is inside or the room is empty again), `room.ring` starts the ring (never one's own).
pub fn room_event(mut state: RoomsState, event: &Value, me: &JsString, now: f64) -> Option<RoomsState> {
    let kind = text_of(event.get("type"))?.to_string_lossy();
    if !kind.starts_with("room.") { return None }
    let room_id = text_of(event.get("roomId"));
    match kind.as_str() {
        "room.created" | "room.updated" => {
            if let Some(room) = event.get("room").filter(|room| well_formed(room)) {
                let mut rooms = state.rooms.take().unwrap_or_default();
                if rooms.iter().any(|item| same_text(item.get("id"), room.get("id"))) {
                    for item in rooms.iter_mut() { if same_text(item.get("id"), room.get("id")) { *item = room.clone() } }
                } else {
                    rooms.insert(0, room.clone());
                }
                state.rooms = Some(sort_rooms(&rooms));
            }
        }
        "room.removed" => {
            if let Some(room_id) = room_id {
                if let Some(rooms) = state.rooms.as_mut() { rooms.retain(|room| text_of(room.get("id")) != Some(room_id)) }
                if text_of(Some(&state.open_id)) == Some(room_id) { state.open_id = Value::Null }
                if text_of(state.ring.get("roomId")) == Some(room_id) { state.ring = Value::Null }
            }
        }
        "room.state" => {
            if let Some(room_id) = room_id {
                let inside: Vec<Value> = list_of(event.get("inside")).cloned().unwrap_or_default();
                if let Some(rooms) = state.rooms.take() {
                    let changed: Vec<Value> = rooms.into_iter().map(|room| match room {
                        Value::Object(mut entries) if entries.iter().any(|(key, value)| key.0 == units("id") && text_of(Some(value)) == Some(room_id)) => {
                            set(&mut entries, "inside", Value::Array(inside.clone()));
                            set(&mut entries, "awake", Value::Bool(truthy(event.get("awake"))));
                            // `data.lastActiveAt ?? room.lastActiveAt`
                            match event.get("lastActiveAt") { Some(Value::Null) | None => {} Some(stamp) => set(&mut entries, "lastActiveAt", stamp.clone()) }
                            Value::Object(entries)
                        }
                        other => other,
                    }).collect();
                    state.rooms = Some(sort_rooms(&changed));
                }
                // The call stops ringing once you are inside, or once the room is empty again.
                if text_of(state.ring.get("roomId")) == Some(room_id) && (inside.is_empty() || inside.iter().any(|member| text_of(member.get("userId")) == Some(me))) { state.ring = Value::Null }
            }
        }
        "room.ring" => {
            if let (Some(room_id), Some(from_id)) = (room_id, text_of(event.get("fromId"))) {
                if from_id != me {
                    // The server names the caller by id and name; the picture comes from the room's own member list.
                    let known = state.rooms.as_ref().and_then(|rooms| rooms.iter().find(|room| text_of(room.get("id")) == Some(room_id)))
                        .and_then(|room| list_of(room.get("members"))).and_then(|members| members.iter().find(|member| text_of(member.get("id")) == Some(from_id))).cloned();
                    let from = known.unwrap_or_else(|| json::object(vec![("id", Value::String(from_id.clone())), ("username", Value::str("")),
                        ("displayName", text_of(event.get("fromName")).map_or(Value::str("Кто-то из своих"), |name| Value::String(name.clone()))), ("avatarColor", Value::str("#8A8F98")), ("avatarId", Value::Null)]));
                    state.ring = json::object(vec![("roomId", Value::String(room_id.clone())), ("name", text_of(event.get("name")).map_or(Value::str(""), |name| Value::String(name.clone()))), ("from", from), ("at", Value::Number(now))]);
                }
            }
        }
        _ => {}
    }
    Some(state)
}

/// A group call from the chat list: the people to make a room of (nobody twice, never oneself), or the words
/// that say why not — one person is an ordinary call, and a room holds twelve.
pub fn room_call_check(member_ids: &[Value], me: &JsString) -> Result<Vec<JsString>, String> {
    let mut ids: Vec<JsString> = Vec::new();
    for id in member_ids {
        let Value::String(id) = id else { continue };
        if id.0.is_empty() || id == me || ids.contains(id) { continue }
        ids.push(id.clone());
    }
    if ids.len() < 2 { return Err("Выбери хотя бы двоих: одному звонят обычным звонком.".to_string()) }
    if ids.len() > ROOM_LIMIT - 1 { return Err(format!("В комнате максимум {ROOM_LIMIT} человек.")) }
    Ok(ids)
}

// ---- Seats ----

/// FNV-1a over the text's UTF-16 code units, as an unsigned 32-bit number.
fn hash(text: &[u16]) -> u32 {
    let mut value: u32 = 2_166_136_261;
    for unit in text { value = (value ^ u32::from(*unit)).wrapping_mul(16_777_619) }
    value
}

/// Where everyone sits: this account in the middle, the others around on an ellipse. A seat depends only on who
/// the members are, so a person is always found in the same place. Fractions of the stage (0…1, the centre of the
/// picture), in the order the reference's map holds them: this account first.
pub fn seats(room_id: &JsString, member_ids: &[JsString], me: &JsString) -> Vec<(JsString, f64, f64)> {
    let joined = |a: &JsString, b: &JsString| { let mut all = a.0.clone(); all.extend_from_slice(&b.0); all };
    let mut others: Vec<&JsString> = member_ids.iter().filter(|id| *id != me).collect();
    others.sort_by_key(|id| hash(&joined(room_id, id)));
    let mut out: Vec<(JsString, f64, f64)> = vec![(me.clone(), 0.5, 0.5)];
    let count = others.len();
    let start = -140.0 + f64::from(hash(&room_id.0) % 40);
    for (index, id) in others.into_iter().enumerate() {
        let wobble = hash(&joined(id, room_id));
        // `wobble >> 5` is JavaScript's signed shift: the number is read as a signed 32-bit one first.
        let shifted = (wobble as i32) >> 5;
        let sway = if count > 2 { f64::from(wobble % 21) - 10.0 } else { 0.0 };
        let angle = (start + index as f64 * (360.0 / count.max(1) as f64) + sway) * std::f64::consts::PI / 180.0;
        let reach = if count > 6 { 0.92 + f64::from(shifted % 9) / 100.0 } else { 0.84 + f64::from(shifted % 15) / 100.0 };
        let (x, y) = (0.5 + angle.cos() * 0.36 * reach, 0.5 + angle.sin() * 0.38 * reach);
        match out.iter_mut().find(|(known, _, _)| known == id) {
            Some(seat) => { seat.1 = x; seat.2 = y }
            None => out.push((id.clone(), x, y)),
        }
    }
    out
}

/// The size of a picture for a room of this many people on a stage this wide.
pub fn seat_size(members: f64, stage: f64) -> f64 {
    let (top, share) = if members <= 5.0 { (88.0, 0.24) } else if members <= 8.0 { (70.0, 0.19) } else { (58.0, 0.16) };
    let wide = stage * share;
    js_round(if wide < top { wide } else { top })
}

// ---- The words ----

/// «трое внутри» for 3, «5 внутри» above four.
pub fn inside_line(count: f64) -> String {
    const WORDS: [&str; 5] = ["никого", "один", "двое", "трое", "четверо"];
    if count.fract() == 0.0 && (0.0..=4.0).contains(&count) { format!("{} внутри", WORDS[count as usize]) } else { format!("{} внутри", json::number_text(count)) }
}

const MONTHS: [&str; 12] = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

/// «спит · были вчера в 18:20». `last_active_at`: the room's own stamp (None or empty: nobody has been in it).
/// The phone says what only it knows about its time zone: the two local midnights (of that day and of today,
/// milliseconds since 1970) and how many minutes its clock was ahead of UTC at that moment. `None`: the stamp is
/// not a date.
pub fn sleep_line(last_active_at: Option<&str>, midnight_at: f64, midnight_now: f64, offset_minutes: f64) -> Option<String> {
    let Some(stamp) = last_active_at.filter(|text| !text.is_empty()) else { return Some("спит · ещё никто не заходил".to_string()) };
    let local = (parse_iso_ms(stamp)? + offset_minutes * 60_000.0).floor() as i64;
    let (days, in_day) = (local.div_euclid(86_400_000), local.rem_euclid(86_400_000));
    let time = format!("{:02}:{:02}", in_day / 3_600_000, in_day / 60_000 % 60);
    let apart = ((midnight_now - midnight_at) / 86_400_000.0).floor();
    if apart <= 0.0 { return Some(format!("спит · были сегодня в {time}")) }
    if apart == 1.0 { return Some(format!("спит · были вчера в {time}")) }
    // The civil-from-days rule.
    let z = days + 719_468;
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let m = (5 * day_of_year + 2) / 153;
    let (day, month) = (day_of_year - (153 * m + 2) / 5 + 1, if m < 10 { m + 3 } else { m - 9 });
    Some(format!("спит · были {day} {}", MONTHS[(month - 1) as usize]))
}

// ---- The end-to-end check of a connection (voiceAuth.ts) ----

/// `sha-256 AB:CD:…` of every `a=fingerprint` line, normalised, each once, sorted, joined with `|`. Empty if none.
pub fn sdp_fingerprints(sdp: &[u16]) -> String {
    let prefix = units("a=fingerprint:");
    let mut found: Vec<String> = Vec::new();
    for line in sdp.split(|unit| *unit == 0x0a) {
        let line = trim(line);
        if line.len() < prefix.len() || line[..prefix.len()] != prefix[..] { continue }
        let rest = &line[prefix.len()..];
        let name_from = rest.iter().position(|unit| !js_space(*unit)).unwrap_or(rest.len());
        let name_unit = |unit: u16| matches!(unit, 0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a | 0x2d);
        let name_to = name_from + rest[name_from..].iter().position(|unit| !name_unit(*unit)).unwrap_or(rest.len() - name_from);
        if name_to == name_from { continue }
        let hex_from = name_to + rest[name_to..].iter().position(|unit| !js_space(*unit)).unwrap_or(rest.len() - name_to);
        if hex_from == name_to { continue }
        let hex_unit = |unit: u16| matches!(unit, 0x30..=0x39 | 0x41..=0x46 | 0x61..=0x66 | 0x3a);
        let hex_to = hex_from + rest[hex_from..].iter().position(|unit| !hex_unit(*unit)).unwrap_or(rest.len() - hex_from);
        // The line is trimmed: nothing may follow the fingerprint.
        if hex_to == hex_from || hex_to != rest.len() { continue }
        let print = format!("{} {}", String::from_utf16_lossy(&rest[name_from..name_to]).to_ascii_lowercase(), String::from_utf16_lossy(&rest[hex_from..hex_to]).to_ascii_uppercase());
        if !found.contains(&print) { found.push(print) }
    }
    found.sort();
    found.join("|")
}

/// The note's text: who I am in the room (the ids the server gave the two connections), my fingerprint and the
/// one I see for you. `None`: an SDP without a fingerprint — there is nothing to vouch for.
pub fn auth_text(channel_id: &JsString, own: &JsString, peer: &JsString, local_sdp: &[u16], remote_sdp: &[u16]) -> Option<String> {
    let (mine, yours) = (sdp_fingerprints(local_sdp), sdp_fingerprints(remote_sdp));
    if mine.is_empty() || yours.is_empty() { return None }
    Some(json::stringify(&json::object(vec![("v", Value::Number(1.0)), ("channelId", Value::String(channel_id.clone())), ("from", Value::String(own.clone())), ("to", Value::String(peer.clone())),
        ("mine", Value::str(&mine)), ("yours", Value::str(&yours))])))
}

/// Checks the note the peer sent against the SDP of our connection with them: `mine` in their note must be the
/// fingerprint in the SDP we received from them, `yours` must be ours, and it must be about this room and these
/// two connections.
pub fn check_auth(text: &str, channel_id: &Value, own: &Value, peer: &Value, local_sdp: &[u16], remote_sdp: &[u16]) -> bool {
    let Ok(note @ Value::Object(_)) = json::parse(text) else { return false };
    if note.get("v") != Some(&Value::Number(1.0)) { return false }
    let (Some(mine), Some(yours)) = (text_of(note.get("mine")), text_of(note.get("yours"))) else { return false };
    let (theirs, ours) = (sdp_fingerprints(remote_sdp), sdp_fingerprints(local_sdp));
    !theirs.is_empty() && !ours.is_empty() && same_text(note.get("channelId"), Some(channel_id)) && same_text(note.get("from"), Some(peer)) && same_text(note.get("to"), Some(own))
        && mine.0 == units(&theirs) && yours.0 == units(&ours)
}

/// Which side of a pair sends the ICE restart (and wins when both did at once): the one whose id is the smaller
/// text, compared as JavaScript compares texts. The same answer on both sides.
pub fn restart_offerer(own: &JsString, peer: &JsString) -> bool { own.0 < peer.0 }

// ---- Music for everyone (roomMusic.tsx, voice.ts) ----

/// A message of the peer-to-peer channel that is about the music: `{off: true}` — the one who led has stopped;
/// `{track, place, playing}` — what plays, where in it (seconds, never past the end) and whether it plays.
/// `None`: not about the music, longer than the channel allows, or not a track of the catalogue.
pub fn music_in(text: &JsString) -> Option<Value> {
    if text.0.len() > CONTROL_LIMIT { return None }
    let data = json::parse(&text.to_string_lossy()).ok()?;
    if !matches!(data, Value::Object(_)) || text_of(data.get("type")).map(|kind| kind.0 == units("music")) != Some(true) { return None }
    if truthy(data.get("off")) { return Some(json::object(vec![("off", Value::Bool(true))])) }
    let track = data.get("t").filter(|track| matches!(track, Value::Object(_)))?;
    let source = text_of(track.get("source"))?.to_string_lossy();
    let fits = text_of(track.get("id")).is_some_and(|id| id.0.len() <= 120) && (source == "audius" || source == "soundcloud")
        && match track.get("sourceId") { None => true, Some(Value::String(id)) => id.0.len() <= 80, Some(_) => false }
        && text_of(track.get("title")).is_some() && text_of(track.get("artist")).is_some();
    let Some(Value::Number(duration)) = track.get("duration") else { return None };
    let Some(Value::Number(pos)) = data.get("pos") else { return None };
    if !fits || !duration.is_finite() || !pos.is_finite() { return None }
    // `Math.max(0, Math.min(pos, duration || pos))`
    let end = if *duration != 0.0 { *duration } else { *pos };
    let least = if *pos < end { *pos } else { end };
    let place = if least > 0.0 { least } else { 0.0 };
    Some(json::object(vec![("track", track.clone()), ("place", Value::Number(place)), ("playing", Value::Bool(truthy(data.get("playing"))))]))
}

/// What the one who leads tells the others: the track (its names cut short), the place to a tenth of a second,
/// playing or paused. `None`: a file of the phone's own (it cannot be played for everyone), or a text longer
/// than the channel allows.
pub fn music_out(track: &Value, position: f64, playing: bool) -> Option<String> {
    let source = text_of(track.get("source"))?;
    if source.0 == units("local") { return None }
    let (Some(id), Some(title), Some(artist), Some(Value::Number(duration))) = (text_of(track.get("id")), text_of(track.get("title")), text_of(track.get("artist")), track.get("duration")) else { return None };
    let cut = |text: &JsString, most: usize| Value::String(JsString(text.0[..text.0.len().min(most)].to_vec()));
    let mut told = vec![("id", Value::String(id.clone())), ("source", Value::String(source.clone()))];
    if let Some(source_id) = track.get("sourceId") { told.push(("sourceId", source_id.clone())) }
    told.extend([("title", cut(title, 70)), ("artist", cut(artist, 50)), ("duration", Value::Number(js_round(*duration)))]);
    let text = json::stringify(&json::object(vec![("type", Value::str("music")), ("t", json::object(told)), ("pos", Value::Number(js_round(position * 10.0) / 10.0)), ("playing", Value::Bool(playing))]));
    (text.encode_utf16().count() <= CONTROL_LIMIT).then_some(text)
}

// ---- What the apps ask by name ----

/// The rules above by name, for the apps (they come through `invizent_view` like the rest). `None`: no such
/// name, or arguments of the wrong kind.
///
/// - `roomRules []` → `{limit, maxName, ringMs, authTimeoutMs, linkPollMs, speakingPollMs, speakingLevel,
///   musicDrift, musicBeatMs, musicOff, talk, refused}`.
/// - `roomSort [rooms]` → the rooms in the list's order.
/// - `roomEvent [{rooms|null, openId|null, ring|null}, event, userId, nowMs]` → the state after the event; null
///   when the event is not about rooms.
/// - `roomCallCheck [memberIds, userId]` → `{ids}` or `{error}`.
/// - `roomSeats [{id, members: [{id}]}, userId]` → `[{id, x, y}]`, this account first.
/// - `roomSeatSize [members, stageWidth]` → the picture's size.
/// - `roomInsideLine [count]` → «трое внутри».
/// - `roomSleepLine [lastActiveAt|null, nowMs, midnightAtMs, midnightNowMs, offsetMinutes]` → «спит · были …»
///   (`nowMs` is not read: the two midnights say all there is to say).
/// - `roomAuthText [channelId, self, peer, localSdp, remoteSdp]` → the note's text; null without a fingerprint.
/// - `roomCheckAuth [text, {channelId, self, peer, localSdp, remoteSdp}]` → bool.
/// - `roomRestartOfferer [self, peer]` → bool.
/// - `roomMusicIn [text]` → `{off: true}`, `{track, place, playing}` or null.
/// - `roomMusicOut [track, position, playing]` → the text to send; null when there is nothing to send.
pub fn view(name: &str, args: &[Value]) -> Option<Value> {
    Some(match (name, args) {
        ("roomRules", []) => json::object(vec![
            ("limit", Value::Number(ROOM_LIMIT as f64)), ("maxName", Value::Number(MAX_ROOM_NAME)), ("ringMs", Value::Number(RING_MS)), ("authTimeoutMs", Value::Number(AUTH_TIMEOUT_MS)),
            ("linkPollMs", Value::Number(LINK_POLL_MS)), ("speakingPollMs", Value::Number(SPEAKING_POLL_MS)), ("speakingLevel", Value::Number(SPEAKING_LEVEL)), ("musicDrift", Value::Number(MUSIC_DRIFT)),
            ("musicBeatMs", Value::Number(MUSIC_BEAT_MS)), ("musicOff", Value::str(MUSIC_OFF)), ("talk", Value::str(TALK_COLOR)), ("refused", Value::str(REFUSED_TEXT)),
        ]),
        ("roomSort", [Value::Array(rooms)]) => {
            if !rooms.iter().all(well_formed) { return None }
            Value::Array(sort_rooms(rooms))
        }
        ("roomEvent", [state @ Value::Object(_), event, Value::String(me), Value::Number(now)]) => room_event(RoomsState::read(state)?, event, me, *now).map_or(Value::Null, RoomsState::written),
        ("roomCallCheck", [Value::Array(ids), Value::String(me)]) => match room_call_check(ids, me) {
            Ok(ids) => json::object(vec![("ids", Value::Array(ids.into_iter().map(Value::String).collect()))]),
            Err(words) => json::object(vec![("error", Value::str(&words))]),
        },
        ("roomSeats", [room @ Value::Object(_), Value::String(me)]) => {
            let ids: Vec<JsString> = list_of(room.get("members"))?.iter().map(|member| text_of(member.get("id")).cloned()).collect::<Option<_>>()?;
            Value::Array(seats(text_of(room.get("id"))?, &ids, me).into_iter().map(|(id, x, y)| json::object(vec![("id", Value::String(id)), ("x", Value::Number(x)), ("y", Value::Number(y))])).collect())
        }
        ("roomSeatSize", [Value::Number(members), Value::Number(stage)]) => Value::Number(seat_size(*members, *stage)),
        ("roomInsideLine", [Value::Number(count)]) => Value::str(&inside_line(*count)),
        ("roomSleepLine", [stamp, Value::Number(_), Value::Number(midnight_at), Value::Number(midnight_now), Value::Number(offset)]) => {
            let stamp = match stamp { Value::String(stamp) => Some(stamp.to_string_lossy()), Value::Null => None, _ => return None };
            Value::str(&sleep_line(stamp.as_deref(), *midnight_at, *midnight_now, *offset)?)
        }
        ("roomAuthText", [Value::String(channel), Value::String(own), Value::String(peer), Value::String(local), Value::String(remote)]) => auth_text(channel, own, peer, &local.0, &remote.0).map_or(Value::Null, |text| Value::str(&text)),
        ("roomCheckAuth", [Value::String(text), expected @ Value::Object(_)]) => {
            let (Some(local), Some(remote)) = (text_of(expected.get("localSdp")), text_of(expected.get("remoteSdp"))) else { return None };
            Value::Bool(check_auth(&text.to_string_lossy(), expected.get("channelId")?, expected.get("self")?, expected.get("peer")?, &local.0, &remote.0))
        }
        ("roomRestartOfferer", [Value::String(own), Value::String(peer)]) => Value::Bool(restart_offerer(own, peer)),
        ("roomMusicIn", [Value::String(text)]) => music_in(text).unwrap_or(Value::Null),
        ("roomMusicOut", [track @ Value::Object(_), Value::Number(position), Value::Bool(playing)]) => music_out(track, *position, *playing).map_or(Value::Null, |text| Value::str(&text)),
        _ => return None,
    })
}
