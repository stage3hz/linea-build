//! The table of server endpoints: what each call of the reference's `Api` sends.
//!
//! Reference: class `Api` in `mobile/src/api.ts`, every member from `health` to the end of the class that is a
//! request (`name = (args…) => this.request(path, options?)`, and the first request of the few `async` members
//! that only build a path and options: `sendEncrypted`, `scheduleEncrypted`, `scheduled`, `readChannel`). The
//! transport itself is `crate::http`; uploads, downloads and address builders are not here.
//!
//! [`call`] gives the method, the path with its query and the body text, byte for byte as the reference makes
//! them: `encodeURIComponent` for every piece of a path, `JSON.stringify` (key order, left-out `undefined` keys,
//! the order of spreads) for a body. Checked against the reference itself by `tests/api_vectors.rs`
//! (`tests/generate-api-vectors.mjs` runs the members cut out of `api.ts`).
//!
//! What is deliberately not here, because it is behaviour over several requests and not the table:
//! - `sendEncrypted` is the request of a fresh `Api` (`pushField` still true). Its fallbacks for older servers are
//!   the same op with other arguments: without `push`, or with `push` = `"none"`.
//! - `scheduleEncrypted` and `scheduled` are the requests made while `scheduledSupported` is true.
//! - `readChannel` is its own request; the fallback on 404 is `communityMe(communityId, {lastReadId})`.

use crate::json::{self, JsString, Value};

/// One request as the reference makes it.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Call {
    pub method: String,
    /// The path with its query, as given to `request`.
    pub path: String,
    /// The exact JSON text sent, or `None` when the reference sends no body.
    pub body: Option<String>,
}

/// The request the reference's member `op` makes for `args`.
///
/// `args` are the member's arguments in order. An optional argument that is absent from the slice or `null` is
/// `undefined` in the reference (a default value applies). `None` is returned for an unknown `op`, for more
/// arguments than the member has, for a required argument that is absent, for an argument of the wrong kind,
/// and where the reference throws `URIError` (a string that is not well-formed UTF-16 in a path).
///
/// The kind checked is the JSON kind the reference's signature names: a string, a number, an object, an array
/// (`string | null` for `changeStatusEmoji`). Strings are not checked against the unions the signature lists
/// (`'post' | 'story'`, `'allow' | 'deny'`…) and objects and arrays are sent as they are, exactly as the
/// reference does: `JSON.stringify(fields)`. An object is taken to be in JavaScript's key order, as
/// `json::parse` and `json::object` make it. Only the options of `scheduled`, which the reference reads rather
/// than sends, are checked inside: `chatId` a string, `lean` a boolean, each may be absent or `null`.
///
/// `device` is what the reference's helpers read on this device, a JSON object:
/// - `deviceName`, `platform`, `appVersion` (strings) and `deviceModel`, `osVersion` (a string, `null` or
///   absent): the `DeviceInfo` of `mobile/src/deviceInfo.ts`. `login` and `register` mix `deviceFields()` into
///   the body (`deviceName`, `platform`, `deviceModel`, `osVersion`, `appVersion`, in this order, the two
///   optional ones left out when `null` or absent); `verifyRecovery` and `registerCryptoDevice` send
///   `deviceName`. These members return `None` when a field they read is missing or of the wrong kind.
/// - `networkTier`: what `networkTier()` of `mobile/src/network/quality.ts` returns now. `messages` asks for 15
///   messages on `"slow"`, 30 on `"medium"` and 50 on anything else (absent included).
/// Members that read nothing of it ignore `device` whatever it is.
pub fn call(op: &str, args: &[Value], device: &Value) -> Option<Call> {
    let (_, most, build) = TABLE.iter().find(|(name, _, _)| *name == op)?;
    if args.len() > *most { return None }
    build(&In { args, device })
}

/// Every `op` that [`call`] knows, in the order of the reference.
pub fn ops() -> impl Iterator<Item = &'static str> {
    TABLE.iter().map(|(name, _, _)| *name)
}

/// `encodeURIComponent`: `None` where JavaScript throws `URIError` (a surrogate without its pair).
pub fn encode_uri_component(text: &JsString) -> Option<String> {
    let units = &text.0;
    let mut out = String::with_capacity(units.len());
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        index += 1;
        let code = match unit {
            0xdc00..=0xdfff => return None,
            0xd800..=0xdbff => match units.get(index) {
                Some(&low @ 0xdc00..=0xdfff) => { index += 1; 0x10000 + (((unit as u32) - 0xd800) << 10) + ((low as u32) - 0xdc00) }
                _ => return None,
            },
            _ => unit as u32,
        };
        let character = char::from_u32(code)?;
        if character.is_ascii_alphanumeric() || "-_.!~*'()".contains(character) { out.push(character); continue }
        let mut bytes = [0u8; 4];
        for byte in character.encode_utf8(&mut bytes).bytes() {
            out.push('%');
            out.push(char::from(b"0123456789ABCDEF"[(byte >> 4) as usize]));
            out.push(char::from(b"0123456789ABCDEF"[(byte & 15) as usize]));
        }
    }
    Some(out)
}

/// What `String.prototype.trim` removes: JavaScript's white space and line terminators.
fn js_space(unit: u16) -> bool {
    matches!(unit, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
fn trim(text: &JsString) -> JsString {
    let units = &text.0;
    let start = units.iter().position(|unit| !js_space(*unit)).unwrap_or(units.len());
    let end = units.iter().rposition(|unit| !js_space(*unit)).map_or(start, |last| last + 1);
    JsString(units[start..end].to_vec())
}

/// A number inside a template string: `String(number)`.
fn number_string(number: f64) -> String {
    if number.is_nan() { "NaN".to_string() } else if number.is_infinite() { if number > 0.0 { "Infinity" } else { "-Infinity" }.to_string() } else { json::number_text(number) }
}
/// `number ? … : …`
fn truthy(number: f64) -> bool { number != 0.0 && !number.is_nan() }

/// The key as an array index (`"0"`, `"17"`, up to 2^32 − 2, no leading zeros), if it is one.
fn array_index(key: &JsString) -> Option<u32> {
    let units = &key.0;
    if units.is_empty() || units.len() > 10 || (units.len() > 1 && units[0] == b'0' as u16) { return None }
    let mut value: u64 = 0;
    for &unit in units {
        if !(b'0' as u16..=b'9' as u16).contains(&unit) { return None }
        value = value * 10 + (unit - b'0' as u16) as u64;
    }
    if value <= 4_294_967_294 { Some(value as u32) } else { None }
}

/// An object literal as JavaScript builds it: a key written again keeps its first place and takes the new value;
/// array-index keys come first, ascending.
#[derive(Default)]
struct Literal(Vec<(JsString, Value)>);
impl Literal {
    fn put(&mut self, key: JsString, value: Value) {
        match self.0.iter_mut().find(|(name, _)| *name == key) {
            Some(entry) => entry.1 = value,
            None => self.0.push((key, value)),
        }
    }
    /// `key: value`
    fn set(mut self, key: &str, value: Value) -> Self { self.put(JsString::from_str(key), value); self }
    /// `key` for a string held in a variable of that name.
    fn text(self, key: &str, value: &JsString) -> Self { self.set(key, Value::String(value.clone())) }
    /// A key whose value may be `undefined`: `JSON.stringify` leaves it out. (None of these keys can be there already.)
    fn maybe(self, key: &str, value: Option<&JsString>) -> Self { match value { Some(value) => self.text(key, value), None => self } }
    /// `...(value ? {key: value} : {})` for a string: an empty one is left out as well.
    fn if_any(self, key: &str, value: Option<&JsString>) -> Self { self.maybe(key, value.filter(|text| !text.0.is_empty())) }
    /// `...object`
    fn spread(mut self, object: &Value) -> Self {
        if let Value::Object(entries) = object { for (key, value) in entries { self.put(key.clone(), value.clone()) } }
        self
    }
    /// `JSON.stringify` of the literal.
    fn json(self) -> Option<String> {
        let (mut indexed, named): (Vec<_>, Vec<_>) = self.0.into_iter().partition(|(key, _)| array_index(key).is_some());
        indexed.sort_by_key(|(key, _)| array_index(key).expect("partitioned by this"));
        indexed.extend(named);
        Some(json::stringify(&Value::Object(indexed)))
    }
}
fn literal() -> Literal { Literal::default() }

/// The arguments of one call.
struct In<'a> {
    args: &'a [Value],
    device: &'a Value,
}
impl<'a> In<'a> {
    /// The argument, `None` when it is `undefined` for the reference (absent or `null`).
    fn given(&self, at: usize) -> Option<&'a Value> { self.args.get(at).filter(|value| !matches!(value, Value::Null)) }
    /// A required string.
    fn s(&self, at: usize) -> Option<&'a JsString> { match self.args.get(at)? { Value::String(text) => Some(text), _ => None } }
    /// An optional string: `Some(None)` when left out.
    fn os(&self, at: usize) -> Option<Option<&'a JsString>> { match self.given(at) { None => Some(None), Some(Value::String(text)) => Some(Some(text)), Some(_) => None } }
    /// A required string, as a piece of a path.
    fn e(&self, at: usize) -> Option<String> { encode_uri_component(self.s(at)?) }
    /// A required number.
    fn n(&self, at: usize) -> Option<f64> { match self.args.get(at)? { Value::Number(number) => Some(*number), _ => None } }
    /// An optional number.
    fn on(&self, at: usize) -> Option<Option<f64>> { match self.given(at) { None => Some(None), Some(Value::Number(number)) => Some(Some(*number)), Some(_) => None } }
    /// A required object.
    fn o(&self, at: usize) -> Option<&'a Value> { self.args.get(at).filter(|value| matches!(value, Value::Object(_))) }
    /// A required array.
    fn a(&self, at: usize) -> Option<&'a Value> { self.args.get(at).filter(|value| matches!(value, Value::Array(_))) }
    /// `JSON.stringify(fields)` for an object argument.
    fn sent(&self, at: usize) -> Option<String> { self.o(at).map(json::stringify) }

    /// `deviceInfo().deviceName`
    fn device_name(&self) -> Option<&'a JsString> { device_text(self.device, "deviceName")? }
    /// `...deviceFields()` (deviceInfo.ts): `deviceModel ?? undefined` and `osVersion ?? undefined` are left out by `JSON.stringify`.
    fn device_fields(&self, body: Literal) -> Option<Literal> {
        let device = self.device;
        if !matches!(device, Value::Object(_)) { return None }
        Some(body.text("deviceName", device_text(device, "deviceName")??).text("platform", device_text(device, "platform")??)
            .maybe("deviceModel", device_text(device, "deviceModel")?).maybe("osVersion", device_text(device, "osVersion")?)
            .text("appVersion", device_text(device, "appVersion")??))
    }
}
/// A field of the device: `Some(None)` when absent or `null`, `None` when it is not a string.
fn device_text<'a>(device: &'a Value, key: &str) -> Option<Option<&'a JsString>> {
    match device.get(key) { None | Some(Value::Null) => Some(None), Some(Value::String(text)) => Some(Some(text)), Some(_) => None }
}

fn request(method: &str, path: String, body: Option<String>) -> Option<Call> { Some(Call { method: method.to_string(), path, body }) }
fn get(path: impl Into<String>) -> Option<Call> { request("GET", path.into(), None) }
fn post(path: impl Into<String>, body: Option<String>) -> Option<Call> { request("POST", path.into(), Some(body?)) }
fn put(path: impl Into<String>, body: Option<String>) -> Option<Call> { request("PUT", path.into(), Some(body?)) }
fn patch(path: impl Into<String>, body: Option<String>) -> Option<Call> { request("PATCH", path.into(), Some(body?)) }
/// A request with a method and no body.
fn bare(method: &str, path: impl Into<String>) -> Option<Call> { request(method, path.into(), None) }
/// `body: '{}'`
fn empty() -> Option<String> { Some("{}".to_string()) }
/// `{currentPassword, <second>, currentConfirmationWord}` of the secret changes.
fn secret_change(i: &In, first: &str, second: &str) -> Option<String> {
    literal().text(first, i.s(0)?).text(second, i.s(1)?).maybe("currentConfirmationWord", i.os(2)?).json()
}
/// `/communities/{id}/channels/{channelId}`
fn channel(i: &In) -> Option<String> { Some(format!("/communities/{}/channels/{}", i.e(0)?, i.e(1)?)) }

type Build = fn(&In) -> Option<Call>;

/// The member's name, how many parameters it has, its request. In the order of `api.ts`.
static TABLE: &[(&str, usize, Build)] = &[
    ("health", 0, |_| get("/health")),
    ("me", 0, |_| get("/me")),
    ("login", 3, |i| post("/auth/login", i.device_fields(literal().text("username", i.s(0)?).text("password", i.s(1)?).text("confirmationWord", i.s(2)?))?.json())),
    ("register", 6, |i| post("/auth/register", i.device_fields(literal().text("username", i.s(0)?).if_any("publicUsername", i.os(5)?).text("password", i.s(1)?).text("displayName", i.s(2)?)
        .text("confirmationWord", i.s(3)?).text("recoveryWord", i.s(4)?))?.json())),
    ("verifyRecovery", 2, |i| post("/auth/recovery/verify", literal().text("username", i.s(0)?).text("recoveryWord", i.s(1)?).text("deviceName", i.device_name()?).json())),
    ("recoveryStatus", 1, |i| post("/auth/recovery/status", literal().text("resetToken", i.s(0)?).json())),
    ("resetPassword", 2, |i| post("/auth/recovery/reset", literal().text("resetToken", i.s(0)?).text("newPassword", i.s(1)?).json())),
    ("recoveryRequests", 0, |_| get("/auth/recovery/requests")),
    ("cancelRecovery", 1, |i| post("/auth/recovery/cancel", literal().text("requestId", i.s(0)?).json())),
    ("security", 0, |_| get("/auth/security")),
    ("changePassword", 3, |i| post("/auth/password", secret_change(i, "currentPassword", "newPassword"))),
    ("changeConfirmationWord", 3, |i| post("/auth/confirmation-word", secret_change(i, "currentPassword", "confirmationWord"))),
    ("changeRecoveryWord", 3, |i| post("/auth/recovery-word", secret_change(i, "currentPassword", "recoveryWord"))),
    ("sessions", 0, |_| get("/auth/sessions")),
    ("revokeSession", 1, |i| post("/auth/sessions/revoke", literal().text("sessionId", i.s(0)?).json())),
    ("revokeOtherSessions", 0, |_| post("/auth/sessions/revoke-others", empty())),
    ("registerCryptoDevice", 2, |i| post("/e2ee/devices", literal().text("deviceId", i.s(0)?).text("deviceName", i.device_name()?).spread(i.o(1)?).json())),
    ("cryptoDevices", 1, |i| get(format!("/e2ee/devices?userId={}", i.e(0)?))),
    ("ownCryptoDevices", 0, |_| get("/e2ee/devices/self")),
    ("claimPreKey", 2, |i| post("/e2ee/prekeys/claim", literal().text("userId", i.s(0)?).text("deviceId", i.s(1)?).json())),
    ("revokeCryptoDevice", 1, |i| post("/e2ee/devices/revoke", literal().text("deviceId", i.s(0)?).json())),
    ("inboxPage", 3, |i| get(format!("/e2ee/inbox?lean=1&deviceId={}&chatId={}&after={}&limit=100", i.e(0)?, i.e(1)?, number_string(i.n(2)?)))),
    ("logout", 0, |_| bare("POST", "/auth/logout")),
    ("chats", 0, |_| get("/chats?lean=1")),
    ("users", 1, |i| get(format!("/users?q={}", i.e(0)?))),
    ("createChat", 1, |i| post("/chats", literal().text("userId", i.s(0)?).json())),
    ("userProfile", 1, |i| get(format!("/users/{}", i.e(0)?))),
    ("profilePosts", 1, |i| get(format!("/users/{}/posts", i.e(0)?))),
    ("publishPost", 3, |i| post("/me/posts", literal().text("uploadId", i.s(0)?).text("kind", i.s(1)?).text("caption", i.os(2)?.unwrap_or(&JsString::default())).json())),
    ("deletePost", 1, |i| bare("DELETE", format!("/me/posts/{}", i.e(0)?))),
    ("storiesFeed", 0, |_| get("/stories/feed?posts=1")),
    ("viewStory", 1, |i| post(format!("/stories/{}/view", i.e(0)?), empty())),
    ("storyViewers", 1, |i| get(format!("/stories/{}/viewers", i.e(0)?))),
    ("profileGifts", 1, |i| get(format!("/users/{}/gifts", i.e(0)?))),
    ("sendGift", 3, |i| post(format!("/users/{}/gifts", i.e(0)?), literal().text("gift", i.s(1)?).text("message", i.os(2)?.unwrap_or(&JsString::default())).json())),
    ("removeGift", 1, |i| bare("DELETE", format!("/me/gifts/{}", i.e(0)?))),
    ("blocks", 0, |_| get("/blocks")),
    ("block", 1, |i| bare("PUT", format!("/blocks/{}", i.e(0)?))),
    ("unblock", 1, |i| bare("DELETE", format!("/blocks/{}", i.e(0)?))),
    ("report", 3, |i| {
        let comment = i.os(2)?.map(trim).unwrap_or_default();
        post("/reports", literal().spread(i.o(0)?).text("reason", i.s(1)?).if_any("comment", Some(&comment)).json())
    }),
    ("deleteAccount", 2, |i| post("/auth/delete-account", literal().text("currentPassword", i.s(0)?).text("currentConfirmationWord", i.s(1)?).json())),
    ("contacts", 0, |_| get("/contacts")),
    ("addContact", 1, |i| bare("PUT", format!("/contacts/{}", i.e(0)?))),
    ("friendRequests", 0, |_| get("/friends/requests")),
    ("acceptFriend", 1, |i| bare("POST", format!("/friends/requests/{}/accept", i.e(0)?))),
    ("dropFriendRequest", 1, |i| bare("DELETE", format!("/friends/requests/{}", i.e(0)?))),
    ("removeContact", 1, |i| bare("DELETE", format!("/contacts/{}", i.e(0)?))),
    ("chatSettings", 2, |i| patch(format!("/chats/{}/settings", i.e(0)?), i.sent(1))),
    ("messages", 2, |i| {
        let limit = match i.device.get("networkTier").and_then(Value::as_str).as_deref() { Some("slow") => 15, Some("medium") => 30, _ => 50 };
        let before = i.on(1)?.filter(|number| truthy(*number)).map_or(String::new(), |number| format!("&before={}", number_string(number)));
        get(format!("/chats/{}/messages?lean=1&limit={limit}{before}", i.e(0)?))
    }),
    ("sendEncrypted", 4, |i| {
        let body = literal().text("clientId", i.s(1)?).set("encrypted", i.o(2)?.clone()).if_any("push", i.os(3)?);
        post(format!("/chats/{}/messages?lean=1", i.e(0)?), body.json())
    }),
    ("scheduleEncrypted", 5, |i| {
        let body = literal().text("clientId", i.s(1)?).set("encrypted", i.o(2)?.clone()).text("deliverAt", i.s(3)?).if_any("push", i.os(4)?);
        post(format!("/chats/{}/messages?lean=1", i.e(0)?), body.json())
    }),
    ("scheduled", 1, |i| {
        let mut query: Vec<String> = Vec::new();
        if let Some(options) = i.given(0) {
            if !matches!(options, Value::Object(_)) { return None }
            match options.get("chatId") { None | Some(Value::Null) => {} Some(Value::String(chat)) => if !chat.0.is_empty() { query.push(format!("chatId={}", encode_uri_component(chat)?)) }, Some(_) => return None }
            match options.get("lean") { None | Some(Value::Null) | Some(Value::Bool(false)) => {} Some(Value::Bool(true)) => query.push("lean=1".to_string()), Some(_) => return None }
        }
        get(if query.is_empty() { "/scheduled".to_string() } else { format!("/scheduled?{}", query.join("&")) })
    }),
    ("deleteScheduled", 1, |i| bare("DELETE", format!("/scheduled/{}", i.e(0)?))),
    ("sendScheduledNow", 1, |i| bare("POST", format!("/scheduled/{}/send?lean=1", i.e(0)?))),
    ("registerPush", 2, |i| put("/me/push", literal().text("token", i.s(0)?).text("platform", i.s(1)?).json())),
    ("unregisterPush", 0, |_| bare("DELETE", "/me/push")),
    ("read", 2, |i| post(format!("/chats/{}/read", i.e(0)?), literal().set("messageId", Value::Number(i.n(1)?)).json())),
    ("privacy", 0, |_| get("/me/privacy")),
    ("updatePrivacy", 1, |i| patch("/me/privacy", i.sent(0))),
    ("lastSeenRules", 0, |_| get("/me/last-seen-rules")),
    ("setLastSeenRule", 2, |i| put(format!("/me/last-seen-rules/{}", i.e(0)?), literal().text("rule", i.s(1)?).json())),
    ("removeLastSeenRule", 1, |i| bare("DELETE", format!("/me/last-seen-rules/{}", i.e(0)?))),
    ("callRules", 0, |_| get("/me/call-rules")),
    ("setCallRule", 2, |i| put(format!("/me/call-rules/{}", i.e(0)?), literal().text("rule", i.s(1)?).json())),
    ("removeCallRule", 1, |i| bare("DELETE", format!("/me/call-rules/{}", i.e(0)?))),
    ("callPermission", 2, |i| {
        let incoming = i.os(1)?.is_some_and(|direction| *direction == JsString::from_str("incoming"));
        get(format!("/calls/permission/{}{}", i.e(0)?, if incoming { "?direction=incoming" } else { "" }))
    }),
    ("profile", 1, |i| patch("/me", i.sent(0))),
    ("changeLoginName", 3, |i| post("/auth/login-name", secret_change(i, "newLogin", "currentPassword"))),
    ("callIce", 0, |_| get("/calls/ice")),
    ("usernameStatus", 0, |_| get("/me/username")),
    ("changeUsername", 1, |i| patch("/me/username", literal().text("username", i.s(0)?).json())),
    ("changeStatusEmoji", 1, |i| match i.args.first()? {
        emoji @ (Value::String(_) | Value::Null) => patch("/me/status-emoji", literal().set("statusEmoji", emoji.clone()).json()),
        _ => None,
    }),
    ("rooms", 0, |_| get("/rooms")),
    ("createRoom", 2, |i| post("/rooms", literal().set("memberIds", i.a(0)?.clone()).if_any("name", i.os(1)?).json())),
    ("renameRoom", 2, |i| patch(format!("/rooms/{}", i.e(0)?), literal().text("name", i.s(1)?).json())),
    ("leaveRoom", 1, |i| bare("POST", format!("/rooms/{}/leave", i.e(0)?))),
    ("ringRoom", 1, |i| bare("POST", format!("/rooms/{}/ring", i.e(0)?))),
    ("communities", 0, |_| get("/communities")),
    ("createCommunity", 1, |i| post("/communities", i.sent(0))),
    ("community", 1, |i| get(format!("/communities/{}", i.e(0)?))),
    ("updateCommunity", 2, |i| patch(format!("/communities/{}", i.e(0)?), i.sent(1))),
    ("deleteChatForEveryone", 1, |i| bare("DELETE", format!("/chats/{}", i.e(0)?))),
    ("readDate", 2, |i| get(format!("/chats/{}/messages/{}/read-date", i.e(0)?, number_string(i.n(1)?)))),
    ("readChannel", 3, |i| post(format!("{}/read", channel(i)?), literal().set("lastReadId", Value::Number(i.n(2)?)).json())),
    ("communityMe", 2, |i| patch(format!("/communities/{}/me", i.e(0)?), i.sent(1))),
    ("deleteCommunity", 1, |i| bare("DELETE", format!("/communities/{}", i.e(0)?))),
    ("leaveCommunity", 1, |i| post(format!("/communities/{}/leave", i.e(0)?), empty())),
    ("communityMembers", 1, |i| get(format!("/communities/{}/members", i.e(0)?))),
    ("banMember", 3, |i| put(format!("/communities/{}/bans/{}", i.e(0)?, i.e(1)?), literal().if_any("reason", i.os(2)?).json())),
    ("unbanMember", 2, |i| bare("DELETE", format!("/communities/{}/bans/{}", i.e(0)?, i.e(1)?))),
    ("communityBans", 1, |i| get(format!("/communities/{}/bans", i.e(0)?))),
    ("setMemberVoice", 3, |i| put(format!("/communities/{}/members/{}/voice", i.e(0)?, i.e(1)?), i.sent(2))),
    ("kickMember", 2, |i| bare("DELETE", format!("/communities/{}/members/{}", i.e(0)?, i.e(1)?))),
    ("setMemberRoles", 3, |i| put(format!("/communities/{}/members/{}/roles", i.e(0)?, i.e(1)?), literal().set("roleIds", i.a(2)?.clone()).json())),
    ("createRole", 2, |i| post(format!("/communities/{}/roles", i.e(0)?), i.sent(1))),
    ("updateRole", 3, |i| patch(format!("/communities/{}/roles/{}", i.e(0)?, i.e(1)?), i.sent(2))),
    ("deleteRole", 2, |i| bare("DELETE", format!("/communities/{}/roles/{}", i.e(0)?, i.e(1)?))),
    ("createChannel", 2, |i| post(format!("/communities/{}/channels", i.e(0)?), i.sent(1))),
    ("updateChannel", 3, |i| patch(channel(i)?, i.sent(2))),
    ("deleteChannel", 2, |i| bare("DELETE", channel(i)?)),
    ("channelMessages", 3, |i| {
        let before = i.on(2)?.filter(|number| truthy(*number)).map_or(String::new(), |number| format!("?before={}", number_string(number)));
        get(format!("{}/messages{before}", channel(i)?))
    }),
    ("sendChannelMessage", 3, |i| post(format!("{}/messages", channel(i)?), i.sent(2))),
    ("editChannelMessage", 4, |i| patch(format!("{}/messages/{}", channel(i)?, number_string(i.n(2)?)), literal().text("text", i.s(3)?).json())),
    ("reactChannelMessage", 4, |i| post(format!("{}/messages/{}/reactions", channel(i)?, number_string(i.n(2)?)), literal().text("emoji", i.s(3)?).json())),
    ("deleteChannelMessage", 3, |i| bare("DELETE", format!("{}/messages/{}", channel(i)?, number_string(i.n(2)?)))),
    ("createInvite", 1, |i| post(format!("/communities/{}/invites", i.e(0)?), empty())),
    ("invite", 1, |i| get(format!("/invites/{}", i.e(0)?))),
    ("acceptInvite", 1, |i| post(format!("/invites/{}/accept", i.e(0)?), empty())),
];
