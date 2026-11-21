//! The encryption service: this device's keys, who is trusted, and how a message is encrypted for every device
//! of a conversation.
//!
//! Reference: `CryptoService` in `mobile/src/e2ee/core.ts`, ported step for step — the same calls to the Signal
//! library and the server in the same order, the same records in the vault, the same refusals in the same
//! words. Checked by replaying recordings of the reference itself (`tests/crypto_scenarios.rs`).

use super::attachment::{valid_attachment, wire_body};
use super::bridge::{keys, CryptoTransport, Env, SignalBridge, SignalError, TransportError, Vault};
use super::wire::{canonical_encrypted, id_order, sha256_hex};
use crate::json::{self, JsString, Value};
use crate::media::js_string;
use crate::message_meta::valid_meta;
use crate::time::parse_iso_ms;

pub const UNTRUSTED: &str = "Проверь коды устройств в разделе «Защита чата». Новые ключи не принимаются автоматически.";
const BAD_CONTENT: &str = "Некорректное содержимое сообщения.";
const OUTBOX_LIMIT: usize = 500;
const HISTORY_PAGE: usize = 50;
const HISTORY_PAGES: f64 = 40.0;
/// A separate session that is never answered in stays «unacknowledged» for the Signal library, which refuses to
/// encrypt in one older than 30 days: it is started afresh once it is this old.
const LANE_SESSION_MAX_AGE_MS: f64 = 20.0 * 86_400_000.0;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Clone, PartialEq, Debug)]
pub enum CryptoError {
    /// A refusal in the words shown to the person.
    Message(String),
    /// A device whose keys were not accepted.
    Untrusted,
    /// The server could not be reached.
    Network(String),
    /// The server said no.
    Server(String),
    Signal(SignalError),
}

impl CryptoError {
    /// The error's name as the reference's callers see it.
    pub fn name(&self) -> &str {
        match self { CryptoError::Untrusted => "UntrustedDeviceError", CryptoError::Network(_) => "NetworkError", CryptoError::Signal(error) if !error.name.is_empty() => &error.name, _ => "Error" }
    }
    pub fn message(&self) -> &str {
        match self { CryptoError::Message(text) | CryptoError::Network(text) | CryptoError::Server(text) => text, CryptoError::Untrusted => UNTRUSTED, CryptoError::Signal(error) => &error.message }
    }
}
impl From<TransportError> for CryptoError {
    fn from(error: TransportError) -> Self { match error { TransportError::Network(text) => CryptoError::Network(text), TransportError::Refused(text) => CryptoError::Server(text) } }
}
impl From<SignalError> for CryptoError {
    fn from(error: SignalError) -> Self { CryptoError::Signal(error) }
}
fn refuse<T>(text: &str) -> Result<T, CryptoError> { Err(CryptoError::Message(text.to_string())) }

// JavaScript's notions, where the reference leans on them.
fn truthy(value: Option<&Value>) -> bool {
    match value { None | Some(Value::Null) | Some(Value::Bool(false)) => false, Some(Value::Number(n)) => *n != 0.0 && !n.is_nan(), Some(Value::String(text)) => !text.0.is_empty(), Some(_) => true }
}
/// `===` for values that came from JSON (two objects or arrays are never the same one).
fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) | (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x == y,
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        _ => false,
    }
}
fn is_text(value: Option<&Value>, text: &str) -> bool { matches!(value, Some(Value::String(units)) if units.0.iter().copied().eq(text.encode_utf16())) }
/// `String(value)`.
fn text_of(value: Option<&Value>) -> String { String::from_utf16_lossy(&js_string(value)) }
fn uuid_units(text: &[u16]) -> bool {
    text.len() == 36 && text.iter().enumerate().all(|(index, unit)| if matches!(index, 8 | 13 | 18 | 23) { *unit == b'-' as u16 } else { u8::try_from(*unit).is_ok_and(|byte| byte.is_ascii_hexdigit()) })
}
/// `uuid.test(value)`: the value is read as text first.
fn uuid_test(value: Option<&Value>) -> bool { uuid_units(&js_string(value)) }
fn uuid_str(text: &str) -> bool { uuid_units(&text.encode_utf16().collect::<Vec<_>>()) }
fn safe_integer(value: Option<&Value>) -> Option<f64> { match value { Some(Value::Number(n)) if n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER => Some(*n), _ => None } }
fn same_device(a: &Value, b: &Value) -> bool {
    strict_eq(a.get("identityKey"), b.get("identityKey")) && strict_eq(a.get("registrationId"), b.get("registrationId"))
}
fn parse(text: Option<String>) -> Result<Option<Value>, CryptoError> {
    match text { None => Ok(None), Some(text) => json::parse(&text).map(Some).map_err(|_| CryptoError::Message("Unexpected token in JSON".to_string())) }
}
fn js_blank(text: &str) -> bool {
    text.encode_utf16().all(|unit| matches!(unit, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff))
}
fn device_address(device: &Value, lane: Option<&str>) -> String { keys::address(&text_of(device.get("userId")), &text_of(device.get("id")), lane) }
fn device_key(device: &Value, name: fn(&str, &str) -> String) -> String { name(&text_of(device.get("userId")), &text_of(device.get("id"))) }
fn session_key(device: &Value, lane: Option<&str>) -> String { keys::session(&text_of(device.get("userId")), &text_of(device.get("id")), lane) }
/// The Signal library's «no usable session» (a lost or expired session), not a refusal over identity or trust.
fn lane_session_error(error: &SignalError) -> bool {
    let text = format!("{} {} {}", error.name, error.code, error.message).to_lowercase();
    (text.contains("session") || text.contains("unacknowledged")) && !(text.contains("identity") || text.contains("trust"))
}

/// What is asked of `encrypt`.
pub struct Outgoing<'a> {
    pub chat_id: &'a str,
    pub peer_id: &'a str,
    pub client_id: &'a str,
    pub text: &'a str,
    /// The attachment as it will travel, or `Value::Null`.
    pub attachment: &'a Value,
    pub meta: Option<&'a Value>,
    /// «Отправить позже»: the message is dated at that time inside the ciphertext and travels in its own session.
    pub deliver_at: Option<&'a str>,
}

pub struct Crypto<S: SignalBridge, V: Vault, T: CryptoTransport, E: Env> {
    pub user_id: String,
    pub bridge: S,
    pub vault: V,
    pub transport: T,
    pub env: E,
    /// New or changed device keys are accepted without a code check; checking stays optional.
    pub auto_trust: bool,
    /// The check of the small picture that rides with an attachment.
    pub preview_ok: Box<dyn Fn(Option<&Value>) -> bool>,
    local: Option<Value>,
    initialized: bool,
}

impl<S: SignalBridge, V: Vault, T: CryptoTransport, E: Env> Crypto<S, V, T, E> {
    pub fn new(user_id: &str, bridge: S, vault: V, transport: T, env: E, auto_trust: bool, preview_ok: Box<dyn Fn(Option<&Value>) -> bool>) -> Self {
        Crypto { user_id: user_id.to_string(), bridge, vault, transport, env, auto_trust, preview_ok, local: None, initialized: false }
    }

    /// This device's id, once its keys are known.
    pub fn device_id(&self) -> Option<String> { self.local.as_ref().and_then(|local| local.get("id")).and_then(Value::as_str) }
    fn local_id(&self) -> String { self.device_id().unwrap_or_default() }
    fn local_bundle(&self) -> Value { self.local.as_ref().and_then(|local| local.get("bundle")).cloned().unwrap_or(Value::Null) }

    /// Finds this device's keys (making them on the very first start) and publishes the public half.
    pub fn initialize(&mut self) -> Result<(), CryptoError> {
        if self.initialized { return Ok(()) }
        let mut local = parse(self.vault.get(keys::DEVICE))?.filter(|value| truthy(Some(value)));
        let mut state = self.vault.get(keys::PROTOCOL).filter(|state| !state.is_empty());
        if local.is_none() && state.is_none() {
            let id = self.env.random_uuid();
            let (created, bundle) = self.bridge.create_state(&keys::address(&self.user_id, &id, None), 1)?;
            let made = json::object(vec![("id", Value::str(&id)), ("bundle", bundle)]);
            // Identity and prekeys are kept before any public material is published.
            self.vault.commit(vec![(keys::DEVICE.to_string(), Some(json::stringify(&made))), (keys::PROTOCOL.to_string(), Some(created.clone()))]);
            local = Some(made);
            state = Some(created);
        }
        let (Some(mut local), Some(state)) = (local, state) else { return refuse("Локальные ключи недоступны. Автоматическая замена ключей отключена.") };
        if !uuid_test(local.get("id")) { return refuse("Локальные ключи недоступны. Автоматическая замена ключей отключена.") }
        self.local = Some(local.clone());
        let id = text_of(local.get("id"));
        let bundle = local.get("bundle").cloned().unwrap_or(Value::Null);
        let published = self.transport.register_crypto_device(&id, &bundle)?;
        let device = published.get("device").cloned().unwrap_or(Value::Null);
        if !strict_eq(device.get("id"), local.get("id")) || !is_text(device.get("userId"), &self.user_id) || !same_device(&device, &bundle) {
            return refuse("Сервер вернул другие ключи устройства. Соединение остановлено.");
        }
        if matches!(published.get("preKeyCount"), Some(Value::Number(count)) if *count < 8.0) {
            let (replenished, bundle) = self.bridge.replenish(&state, 20)?;
            local = json::object(vec![("id", Value::str(&id)), ("bundle", bundle.clone())]);
            self.vault.commit(vec![(keys::DEVICE.to_string(), Some(json::stringify(&local))), (keys::PROTOCOL.to_string(), Some(replenished))]);
            self.local = Some(local);
            self.transport.register_crypto_device(&id, &bundle)?;
        }
        self.initialized = true;
        Ok(())
    }

    fn cached_list(&self, user_id: &str) -> Vec<Value> {
        match self.vault.get(&keys::devices(user_id)).filter(|text| !text.is_empty()).map(|text| json::parse(&text)) { Some(Ok(Value::Array(list))) => list, _ => Vec::new() }
    }

    /// Without internet: the last lists from the server, only devices there already is a session with.
    fn cached_targets(&self, peer_id: &str) -> Result<Vec<Value>, CryptoError> {
        let local_id = self.local_id();
        let mut out = Vec::new();
        let own = self.cached_list(&self.user_id).into_iter().filter(|device| !is_text(device.get("id"), &local_id));
        for device in own.chain(self.cached_list(peer_id)) {
            if !is_text(device.get("userId"), &self.user_id) && !is_text(device.get("userId"), peer_id) { continue }
            let held = |key: String| self.vault.get(&key).is_some_and(|value| !value.is_empty());
            if truthy(device.get("active")) && held(session_key(&device, None)) && held(device_key(&device, keys::trust)) { out.push(device) }
        }
        if !out.iter().any(|device| is_text(device.get("userId"), peer_id)) { return refuse("Без интернета можно писать только тем, с кем уже переписывались.") }
        Ok(out)
    }

    /// The devices a message for `peer_id` goes to: the peer's and one's own others, as the server lists them now.
    fn targets(&mut self, peer_id: &str) -> Result<Vec<Value>, CryptoError> {
        if !uuid_str(peer_id) || peer_id == self.user_id { return refuse("Неверный собеседник.") }
        let user_id = self.user_id.clone();
        let own = self.transport.crypto_devices(&user_id);
        let peer = self.transport.crypto_devices(peer_id);
        let (own, peer) = (own?, peer?);
        let list = |answer: &Value| match answer.get("devices") { Some(Value::Array(devices)) => devices.clone(), _ => Vec::new() };
        let (own_devices, peer_devices) = (list(&own), list(&peer));
        let local_id = self.local_id();
        let bundle = self.local_bundle();
        let this = own_devices.iter().find(|device| is_text(device.get("id"), &local_id));
        if !this.is_some_and(|device| is_text(device.get("userId"), &user_id) && truthy(device.get("active")) && same_device(device, &bundle)) {
            return refuse("Устройство больше не разрешено для переписки. Войди в аккаунт снова.");
        }
        if peer_devices.is_empty() { return refuse("У собеседника пока нет активного устройства с шифрованием. Попроси его открыть новую версию приложения.") }
        let mut devices: Vec<Value> = own_devices.iter().filter(|device| !is_text(device.get("id"), &local_id)).cloned().chain(peer_devices.iter().cloned()).collect();
        let mut seen: Vec<String> = Vec::new();
        for device in &devices {
            let address = device_address(device, None);
            let known_owner = is_text(device.get("userId"), &user_id) || is_text(device.get("userId"), peer_id);
            let number_ok = safe_integer(device.get("registrationId")).is_some_and(|number| (1.0..=16383.0).contains(&number));
            let key_ok = matches!(device.get("identityKey"), Some(Value::String(key)) if key.0.len() == 44 && key.0.iter().all(|unit| u8::try_from(*unit).is_ok_and(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')));
            if !uuid_test(device.get("id")) || !known_owner || !truthy(device.get("active")) || !number_ok || !key_ok || seen.contains(&address) { return refuse("Сервер вернул некорректный список ключей.") }
            seen.push(address);
        }
        if devices.len() > 9 { return refuse("Слишком много устройств в разговоре.") }
        devices.sort_by(|a, b| id_order(&device_address(a, None).encode_utf16().collect::<Vec<_>>(), &device_address(b, None).encode_utf16().collect::<Vec<_>>()));
        // The lists are remembered (only when they changed) for encrypting without internet.
        let (own_json, peer_json) = (json::stringify(&Value::Array(own_devices)), json::stringify(&Value::Array(peer_devices)));
        if self.vault.get(&keys::devices(&user_id)).as_deref() != Some(&own_json) || self.vault.get(&keys::devices(peer_id)).as_deref() != Some(&peer_json) {
            self.vault.commit(vec![(keys::devices(&user_id), Some(own_json)), (keys::devices(peer_id), Some(peer_json))]);
        }
        Ok(devices)
    }

    fn snapshot(&mut self, peer_id: &str) -> Result<Value, CryptoError> {
        let targets = self.targets(peer_id)?;
        let (local_id, bundle) = (self.local_id(), self.local_bundle());
        let own_line = format!("{}:{}:{}", keys::address(&self.user_id, &local_id, None), text_of(bundle.get("identityKey")), text_of(bundle.get("registrationId")));
        let mut devices = Vec::new();
        for device in &targets {
            let trusted = parse(self.vault.get(&device_key(device, keys::trust)))?;
            let mut pair = [own_line.clone(), format!("{}:{}:{}", device_address(device, None), text_of(device.get("identityKey")), text_of(device.get("registrationId")))];
            pair.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            let hash = sha256_hex(&format!("linea-safety-code-v1\u{0}{}\u{0}{}", pair[0], pair[1])).to_uppercase();
            let code = hash.as_bytes().chunks(4).map(|group| std::str::from_utf8(group).expect("hex")).collect::<Vec<_>>().join(" ");
            let is_trusted = trusted.as_ref().is_some_and(|record| truthy(Some(record)) && !truthy(record.get("auto")) && same_device(record, device));
            let Value::Object(mut entries) = device.clone() else { continue };
            for (key, value) in [("code", Value::str(&code)), ("trusted", Value::Bool(is_trusted)), ("self", Value::Bool(is_text(device.get("userId"), &self.user_id)))] {
                let key = JsString::from_str(key);
                match entries.iter_mut().find(|(name, _)| *name == key) { Some(entry) => entry.1 = value, None => entries.push((key, value)) }
            }
            devices.push(Value::Object(entries));
        }
        let rows: Vec<Value> = devices.iter().map(|device| Value::Array(["userId", "id", "identityKey", "registrationId"].iter().map(|key| device.get(key).cloned().unwrap_or(Value::Null)).collect())).collect();
        let fingerprint = sha256_hex(&json::stringify(&Value::Array(rows)));
        Ok(json::object(vec![("peerId", Value::str(peer_id)), ("ownDeviceId", Value::str(&local_id)), ("devices", Value::Array(devices)), ("fingerprint", Value::str(&fingerprint))]))
    }

    /// The devices of a conversation with the codes to compare and whether each is already checked.
    pub fn trust_snapshot(&mut self, peer_id: &str) -> Result<Value, CryptoError> {
        self.initialize()?;
        self.snapshot(peer_id)
    }

    /// The person compared the codes of `snapshot`: its devices become trusted — unless the list has changed since.
    pub fn approve_devices(&mut self, snapshot: &Value) -> Result<(), CryptoError> {
        self.initialize()?;
        let current = self.snapshot(&text_of(snapshot.get("peerId")))?;
        if !strict_eq(current.get("ownDeviceId"), snapshot.get("ownDeviceId")) || !strict_eq(current.get("fingerprint"), snapshot.get("fingerprint")) {
            return refuse("Список устройств изменился. Сверь обновлённые коды.");
        }
        let mut state = self.vault.get(keys::PROTOCOL).unwrap_or_default();
        let mut changes: Vec<(String, Option<String>)> = Vec::new();
        let devices = match current.get("devices") { Some(Value::Array(devices)) => devices.clone(), _ => Vec::new() };
        for device in &devices {
            let previous = parse(self.vault.get(&device_key(device, keys::trust)))?;
            if previous.as_ref().is_some_and(|record| truthy(Some(record)) && !truthy(record.get("auto")) && !same_device(record, device)) { return Err(CryptoError::Untrusted) }
            state = self.bridge.trust_identity(&state, &device_address(device, None), 1, &text_of(device.get("identityKey")))?;
            let record = json::object(vec![("identityKey", device.get("identityKey").cloned().unwrap_or(Value::Null)), ("registrationId", device.get("registrationId").cloned().unwrap_or(Value::Null)), ("checkedAt", Value::str(&self.env.now_iso()))]);
            changes.push((device_key(device, keys::trust), Some(json::stringify(&record))));
        }
        changes.push((keys::PROTOCOL.to_string(), Some(state)));
        self.vault.commit(changes);
        Ok(())
    }

    fn outbox_refs(&self) -> Vec<Value> {
        match self.vault.get(keys::OUTBOX_INDEX).map(|text| json::parse(&text)) {
            Some(Ok(Value::Array(list))) => list.into_iter().filter(|item| matches!(item, Value::Object(_)) && uuid_test(item.get("chatId")) && uuid_test(item.get("clientId"))).collect(),
            _ => Vec::new(),
        }
    }

    /// Vault changes that add (or drop) one entry of the outbox list; part of the caller's atomic commit.
    fn outbox_index_change(&self, chat_id: &str, client_id: &str, present: bool) -> Vec<(String, Option<String>)> {
        let refs = self.outbox_refs();
        let rest: Vec<Value> = refs.iter().filter(|item| !is_text(item.get("chatId"), chat_id) || !is_text(item.get("clientId"), client_id)).cloned().collect();
        if !present {
            return if rest.len() == refs.len() { Vec::new() } else { vec![(keys::OUTBOX_INDEX.to_string(), if rest.is_empty() { None } else { Some(json::stringify(&Value::Array(rest))) })] };
        }
        if rest.len() != refs.len() { return Vec::new() }
        let mut list = rest;
        list.push(json::object(vec![("chatId", Value::str(chat_id)), ("clientId", Value::str(client_id))]));
        let from = list.len().saturating_sub(OUTBOX_LIMIT);
        vec![(keys::OUTBOX_INDEX.to_string(), Some(json::stringify(&Value::Array(list[from..].to_vec()))))]
    }

    /// Chats with decrypted history cached on this device.
    pub fn history_chats(&self) -> Vec<String> {
        match self.vault.get(keys::HISTORY_CHATS).map(|text| json::parse(&text)) {
            Some(Ok(Value::Array(list))) => list.iter().filter(|id| matches!(id, Value::String(text) if uuid_units(&text.0))).filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        }
    }

    /// Vault changes that name a newly cached decrypted message in the chat's history pages; part of the caller's
    /// atomic commit.
    fn history_change(&self, chat_id: &str, sender_id: &str, client_id: &str) -> Result<Vec<(String, Option<String>)>, CryptoError> {
        let mut changes: Vec<(String, Option<String>)> = Vec::new();
        let stored = parse(self.vault.get(&keys::history_meta(chat_id)))?;
        let read = |meta: &Value| -> Option<(f64, f64)> { let (first, last) = (safe_integer(meta.get("first"))?, safe_integer(meta.get("last"))?); (first <= last).then_some((first, last)) };
        let meta_text = |first: f64, last: f64| json::stringify(&json::object(vec![("first", Value::Number(first)), ("last", Value::Number(last))]));
        let (mut first, mut last) = match stored.as_ref().filter(|meta| truthy(Some(meta))).and_then(read) {
            Some(range) => range,
            None => {
                changes.push((keys::history_meta(chat_id), Some(meta_text(0.0, 0.0))));
                let chats = self.history_chats();
                if !chats.iter().any(|id| id == chat_id) {
                    let mut list: Vec<Value> = chats.iter().map(|id| Value::str(id)).collect();
                    list.push(Value::str(chat_id));
                    changes.push((keys::HISTORY_CHATS.to_string(), Some(json::stringify(&Value::Array(list)))));
                }
                (0.0, 0.0)
            }
        };
        let mut page = match self.vault.get(&keys::history_page(chat_id, last)).map(|text| json::parse(&text)) { Some(Ok(Value::Array(items))) => items, _ => Vec::new() };
        if page.len() >= HISTORY_PAGE {
            last += 1.0;
            if last - first >= HISTORY_PAGES { changes.push((keys::history_page(chat_id, first), None)); first += 1.0 }
            changes.retain(|(key, _)| *key != keys::history_meta(chat_id));
            changes.push((keys::history_meta(chat_id), Some(meta_text(first, last))));
            page = Vec::new();
        }
        page.push(Value::Array(vec![Value::str(sender_id), Value::str(client_id)]));
        changes.push((keys::history_page(chat_id, last), Some(json::stringify(&Value::Array(page)))));
        Ok(changes)
    }

    fn claim(&mut self, device: &Value) -> Result<Value, CryptoError> {
        let claimed = self.transport.claim_pre_key(&text_of(device.get("userId")), &text_of(device.get("id")))?;
        let (listed, bundle) = (claimed.get("device").cloned().unwrap_or(Value::Null), claimed.get("bundle").cloned().unwrap_or(Value::Null));
        if !strict_eq(listed.get("id"), device.get("id")) || !strict_eq(listed.get("userId"), device.get("userId")) || !same_device(&listed, device) || !same_device(&bundle, device) { return Err(CryptoError::Untrusted) }
        Ok(bundle)
    }

    /// Encrypts one message for every device of the conversation and keeps it — ciphertext, plain copy, its place
    /// in the history and in the list of unsent messages — in one step, before anything is sent. A repeated call
    /// with the same id gives back exactly the same ciphertext.
    pub fn encrypt(&mut self, message: &Outgoing) -> Result<Value, CryptoError> {
        self.initialize()?;
        let Outgoing { chat_id, peer_id, client_id, text, attachment, meta, deliver_at } = *message;
        let has_attachment = truthy(Some(attachment));
        let preview_ok = &self.preview_ok;
        if !uuid_str(chat_id) || !uuid_str(client_id) || text.encode_utf16().count() > 8000 || (js_blank(text) && !has_attachment)
            || !valid_attachment(attachment, &|preview| preview_ok(preview)) || !valid_meta(meta) || deliver_at.is_some_and(|at| parse_iso_ms(at).is_none()) {
            return refuse(BAD_CONTENT);
        }
        let lane: Option<&str> = deliver_at.map(|_| "scheduled");
        let key = keys::outbox(chat_id, client_id);
        if let Some(previous) = parse(self.vault.get(&key))?.filter(|record| truthy(Some(record))) {
            let plain = previous.get("plain");
            let text_of_field = |value: Option<&Value>| value.map(json::stringify);
            let same = is_text(previous.get("peerId"), peer_id) && is_text(plain.and_then(|plain| plain.get("text")), text)
                && text_of_field(plain.and_then(|plain| plain.get("attachment"))) == Some(json::stringify(attachment))
                && text_of_field(plain.and_then(|plain| plain.get("meta"))) == text_of_field(meta)
                && match (previous.get("encrypted").and_then(|encrypted| encrypted.get("lane")), lane) { (None, None) => true, (lane_then, Some(lane_now)) => is_text(lane_then, lane_now), _ => false };
            if !same { return refuse("Идентификатор сообщения уже использован.") }
            // Retries reuse exactly the committed ciphertext.
            return Ok(previous.get("encrypted").cloned().unwrap_or(Value::Null));
        }
        let mut offline = false;
        // A separate session may need a prekey bundle, which only the server has: scheduling waits for the internet.
        let targets = match self.targets(peer_id) {
            Ok(targets) => targets,
            Err(CryptoError::Network(_)) if lane.is_none() => { offline = true; self.cached_targets(peer_id)? }
            Err(error) => return Err(error),
        };
        let mut state = self.vault.get(keys::PROTOCOL).unwrap_or_default();
        let now = self.env.now_iso();
        let local_id = self.local_id();
        let mut plain = vec![("text", Value::str(text)), ("attachment", attachment.clone()), ("sentAt", Value::str(deliver_at.unwrap_or(&now)))];
        if let Some(meta) = meta.filter(|meta| truthy(Some(meta))) { plain.push(("meta", meta.clone())) }
        let plain = json::object(plain);
        let mut changes: Vec<(String, Option<String>)> = Vec::new();
        let put = |changes: &mut Vec<(String, Option<String>)>, key: String, value: Option<String>| { changes.retain(|(name, _)| *name != key); changes.push((key, value)) };
        let mut envelopes: Vec<Value> = Vec::new();
        for device in &targets {
            let trusted = parse(self.vault.get(&device_key(device, keys::trust)))?.filter(|record| truthy(Some(record)));
            let known = trusted.as_ref().is_some_and(|record| same_device(record, device));
            let mut rekey = false;
            // New keys are never accepted without the server.
            if offline && !known { continue }
            let identity_key = text_of(device.get("identityKey"));
            if !known {
                if !self.auto_trust { return Err(CryptoError::Untrusted) }
                state = self.bridge.trust_identity(&state, &device_address(device, None), 1, &identity_key)?;
                let record = json::object(vec![("identityKey", device.get("identityKey").cloned().unwrap_or(Value::Null)), ("registrationId", device.get("registrationId").cloned().unwrap_or(Value::Null)), ("checkedAt", Value::Null), ("auto", Value::Bool(true))]);
                put(&mut changes, device_key(device, keys::trust), Some(json::stringify(&record)));
                // A changed key needs a fresh session.
                rekey = trusted.is_some();
            }
            // The separate session's address is pinned to the same identity; the Signal library refuses an unpinned one.
            if lane.is_some() { state = self.bridge.trust_identity(&state, &device_address(device, lane), 1, &identity_key)? }
            // The mark «our decrypt of their message failed» is about the ordinary session only.
            if lane.is_none() && self.vault.get(&device_key(device, keys::rekey)).is_some_and(|mark| !mark.is_empty()) { rekey = true; put(&mut changes, device_key(device, keys::rekey), None) }
            let session = self.vault.get(&session_key(device, lane)).filter(|session| !session.is_empty());
            let stale = lane.is_some() && session.as_ref().is_some_and(|started| !(parse_iso_ms(started).unwrap_or(f64::NAN) > parse_iso_ms(&now).unwrap_or(f64::NAN) - LANE_SESSION_MAX_AGE_MS));
            let mut bundle = if rekey || session.is_none() || stale { Some(self.claim(device)?) } else { None };
            let mut payload = vec![("version", Value::Number(1.0)), ("chatId", Value::str(chat_id)), ("clientId", Value::str(client_id)), ("senderId", Value::str(&self.user_id)), ("senderDeviceId", Value::str(&local_id)),
                ("recipientId", device.get("userId").cloned().unwrap_or(Value::Null)), ("recipientDeviceId", device.get("id").cloned().unwrap_or(Value::Null))];
            if let Some(lane) = lane { payload.push(("lane", Value::str(lane))) }
            let mut payload = match json::object(payload) { Value::Object(entries) => entries, _ => Vec::new() };
            if let Value::Object(body) = wire_body(&plain) {
                for (name, value) in body { match payload.iter_mut().find(|(key, _)| *key == name) { Some(entry) => entry.1 = value, None => payload.push((name, value)) } }
            }
            let payload = json::stringify(&Value::Object(payload));
            let address = device_address(device, lane);
            let sealed = match self.bridge.encrypt(&state, &address, 1, &payload, bundle.as_ref()) {
                Ok(sealed) => sealed,
                // A separate session the library no longer accepts is started afresh once. Only for session
                // errors: a refusal over identity or trust would just burn the peer's one-time prekeys.
                Err(error) if lane.is_some() && bundle.is_none() && lane_session_error(&error) => {
                    bundle = Some(self.claim(device)?);
                    self.bridge.encrypt(&state, &address, 1, &payload, bundle.as_ref())?
                }
                Err(error) => return Err(error.into()),
            };
            state = sealed.state;
            let mark = if lane.is_some() { if bundle.is_some() { now.clone() } else { session.clone().unwrap_or_default() } } else { "1".to_string() };
            put(&mut changes, session_key(device, lane), Some(mark));
            envelopes.push(json::object(vec![("userId", device.get("userId").cloned().unwrap_or(Value::Null)), ("deviceId", device.get("id").cloned().unwrap_or(Value::Null)), ("type", Value::Number(sealed.kind)), ("body", Value::str(&sealed.body))]));
        }
        let ids = if has_attachment { vec![attachment.get("id").cloned().unwrap_or(Value::Null)] } else { Vec::new() };
        let mut encrypted = vec![("scheme", Value::str("signal-v1")), ("senderDeviceId", Value::str(&local_id)), ("envelopes", Value::Array(envelopes)), ("attachmentIds", Value::Array(ids))];
        if let Some(lane) = lane { encrypted.push(("lane", Value::str(lane))) }
        let encrypted = json::object(encrypted);
        let fingerprint = sha256_hex(&canonical_encrypted(&encrypted));
        put(&mut changes, key, Some(json::stringify(&json::object(vec![("encrypted", encrypted.clone()), ("plain", plain.clone()), ("peerId", Value::str(peer_id))]))));
        put(&mut changes, keys::message(chat_id, &self.user_id, client_id), Some(json::stringify(&json::object(vec![("fingerprint", Value::str(&fingerprint)), ("plain", plain)]))));
        for (name, value) in self.outbox_index_change(chat_id, client_id, true) { put(&mut changes, name, value) }
        for (name, value) in self.history_change(chat_id, &self.user_id.clone(), client_id)? { put(&mut changes, name, value) }
        // The ratchet, the outbox and the local history are kept in one step BEFORE anything is sent.
        put(&mut changes, keys::PROTOCOL.to_string(), Some(state));
        self.vault.commit(changes);
        Ok(encrypted)
    }

    /// Messages encrypted and kept but not confirmed by the server yet, oldest first. Safe to send again: the
    /// same id reuses the same ciphertext. Reads the vault only, so it works without internet.
    pub fn pending_outbox(&mut self) -> Result<Vec<Value>, CryptoError> {
        let refs = self.outbox_refs();
        let (mut items, mut kept) = (Vec::new(), Vec::new());
        for reference in &refs {
            let (chat_id, client_id) = (text_of(reference.get("chatId")), text_of(reference.get("clientId")));
            let stored = parse(self.vault.get(&keys::outbox(&chat_id, &client_id)))?;
            // Delivered or dropped since: the name is forgotten too.
            let Some(stored) = stored.filter(|record| truthy(Some(record)) && truthy(record.get("plain")) && uuid_test(record.get("peerId"))) else { continue };
            kept.push(reference.clone());
            let plain = stored.get("plain").cloned().unwrap_or(Value::Null);
            let field = |key: &str| plain.get(key).cloned();
            let mut item = vec![("chatId", reference.get("chatId").cloned()), ("clientId", reference.get("clientId").cloned()), ("peerId", stored.get("peerId").cloned()), ("text", field("text")), ("attachment", field("attachment")), ("sentAt", field("sentAt"))];
            if truthy(plain.get("meta")) { item.push(("meta", field("meta"))) }
            if truthy(stored.get("encrypted").and_then(|encrypted| encrypted.get("lane"))) { item.push(("deliverAt", field("sentAt"))) }
            // A missing field is simply not written, as in the reference.
            items.push(json::object(item.into_iter().filter_map(|(key, value)| value.map(|value| (key, value))).collect()));
        }
        if kept.len() != refs.len() { self.vault.commit(vec![(keys::OUTBOX_INDEX.to_string(), if kept.is_empty() { None } else { Some(json::stringify(&Value::Array(kept))) })]) }
        Ok(items)
    }
}
