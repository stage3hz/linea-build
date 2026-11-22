//! The encryption service: this device's keys, who is trusted, and how a message is encrypted for every device
//! of a conversation.
//!
//! Reference: `CryptoService` in `mobile/src/e2ee/core.ts`, ported step for step — the same calls to the Signal
//! library and the server in the same order, the same records in the vault, the same refusals in the same
//! words. Checked by replaying recordings of the reference itself (`tests/crypto_scenarios.rs`).

use super::attachment::{valid_attachment, wire_body, with_waveform};
use super::bridge::{keys, CryptoTransport, Env, SignalBridge, SignalError, TransportError, Vault};
use super::wire::{canonical_encrypted, id_order, sha256_hex, valid_ciphertext_body, valid_encrypted};
use crate::json::{self, JsString, Value};
use crate::link_preview::{for_message, valid_wire, without_image, MAX_PAYLOAD_BYTES};
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
pub const FAILED_TEXT: &str = "Не удалось расшифровать на этом устройстве. Напиши собеседнику — шифрование восстановится — и попроси отправить сообщение ещё раз.";
const FAILED_AFTER: f64 = 3.0;
/// Pages of 100 messages one opening of a chat may read.
pub const SYNC_PAGES: usize = 100;
pub const PARTIAL_TEXT: &str = "Загружена часть истории. Открой чат ещё раз, чтобы продолжить безопасную расшифровку.";
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
    /// A background catch-up stopped at its page limit; the next one goes on from where this one ended.
    Partial,
    /// Text that is not JSON where JSON was expected (the reference's `SyntaxError`).
    Syntax,
    /// A value of another kind than the code relies on (the reference's `TypeError`).
    Type,
}

impl CryptoError {
    /// The error's name as the reference's callers see it.
    pub fn name(&self) -> &str {
        match self { CryptoError::Untrusted => "UntrustedDeviceError", CryptoError::Network(_) => "NetworkError", CryptoError::Signal(error) if !error.name.is_empty() => &error.name, CryptoError::Partial => "PartialSync", CryptoError::Syntax => "SyntaxError", CryptoError::Type => "TypeError", _ => "Error" }
    }
    pub fn message(&self) -> &str {
        match self { CryptoError::Message(text) | CryptoError::Network(text) | CryptoError::Server(text) => text, CryptoError::Untrusted => UNTRUSTED, CryptoError::Signal(error) => &error.message, CryptoError::Partial => PARTIAL_TEXT, CryptoError::Syntax => "Unexpected token in JSON", CryptoError::Type => "Cannot read properties" }
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
    match text { None => Ok(None), Some(text) => json::parse(&text).map(Some).map_err(|_| CryptoError::Syntax) }
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
    /// The card of a link in the text (`link_preview`), or none. One that does not fit the message exactly is
    /// left out; the message goes without it.
    pub link_preview: Option<&'a Value>,
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
        let Outgoing { chat_id, peer_id, client_id, text, attachment, meta, deliver_at, link_preview } = *message;
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
        // The card of a link travels inside the ciphertext next to the text, and only while the whole body fits
        // one envelope: first its picture goes, then the card. A message without a card is written as before.
        if let Some(card) = for_message(link_preview, &JsString::from_str(text), attachment, meta) {
            let fits = |card: &Value| { let mut body = plain.clone(); body.push(("linkPreview", card.clone())); json::stringify(&json::object(body)).len() + 512 <= MAX_PAYLOAD_BYTES };
            let bare = without_image(card);
            let sent = if fits(card) { Some(card.clone()) } else if bare != *card && valid_wire(&bare, &JsString::from_str(text), meta.and_then(|meta| meta.get("entities"))) && fits(&bare) { Some(bare) } else { None };
            if let Some(sent) = sent { plain.push(("linkPreview", sent)) }
        }
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
            if truthy(plain.get("linkPreview")) { item.push(("linkPreview", field("linkPreview"))) }
            if truthy(stored.get("encrypted").and_then(|encrypted| encrypted.get("lane"))) { item.push(("deliverAt", field("sentAt"))) }
            // A missing field is simply not written, as in the reference.
            items.push(json::object(item.into_iter().filter_map(|(key, value)| value.map(|value| (key, value))).collect()));
        }
        if kept.len() != refs.len() { self.vault.commit(vec![(keys::OUTBOX_INDEX.to_string(), if kept.is_empty() { None } else { Some(json::stringify(&Value::Array(kept))) })]) }
        Ok(items)
    }
}

// ── Receiving ────────────────────────────────────────────────────────────────────────────────────────────────

/// `Number(text || 0)` for a stored counter.
fn js_number(text: Option<String>) -> f64 {
    match text.as_deref().map(str::trim) { None | Some("") => 0.0, Some(text) => text.parse().unwrap_or(f64::NAN) }
}
fn is_failed(value: Option<&Value>) -> bool { matches!(value, Some(record @ Value::Object(_)) if matches!(record.get("failed"), Some(Value::Bool(true)))) }
fn auto_record(device: &Value) -> String {
    json::stringify(&json::object(vec![("identityKey", device.get("identityKey").cloned().unwrap_or(Value::Null)), ("registrationId", device.get("registrationId").cloned().unwrap_or(Value::Null)), ("checkedAt", Value::Null), ("auto", Value::Bool(true))]))
}
/// `{...base, key: value, …}`; a value that is not there is not written.
fn spread(base: &Value, extra: Vec<(&str, Option<Value>)>) -> Value {
    let mut entries = match base { Value::Object(entries) => entries.clone(), _ => Vec::new() };
    for (key, value) in extra {
        let key = JsString::from_str(key);
        match value {
            Some(value) => match entries.iter_mut().find(|(name, _)| *name == key) { Some(entry) => entry.1 = value, None => entries.push((key, value)) },
            None => entries.retain(|(name, _)| *name != key),
        }
    }
    Value::Object(entries)
}
fn object_of(entries: Vec<(&str, Option<Value>)>) -> Value { json::object(entries.into_iter().filter_map(|(key, value)| value.map(|value| (key, value))).collect()) }
fn same_plain(a: &Value, b: &Value) -> bool {
    let text = |value: Option<&Value>| value.map(json::stringify);
    let meta = |plain: &Value| json::stringify(plain.get("meta").unwrap_or(&Value::Null));
    strict_eq(a.get("text"), b.get("text")) && text(a.get("attachment")) == text(b.get("attachment")) && meta(a) == meta(b)
}
/// The names the cache of the chat list may use: the list itself and one page per chat.
pub fn cache_name(name: &str) -> bool {
    name == "chats:v1" || name.strip_prefix("page:v1:").is_some_and(|rest| (1..=80).contains(&rest.len()) && rest.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'))
}
fn message_key(message: &Value) -> String { keys::message(&text_of(message.get("chatId")), &text_of(message.get("senderId")), &text_of(message.get("clientId"))) }

struct OpenedMessage { plain: Value, protocol: String, sender: (String, String) }

impl<S: SignalBridge, V: Vault, T: CryptoTransport, E: Env> Crypto<S, V, T, E> {
    /// A trust record for a sender not seen before, when keys are accepted on first sight: looked up in the
    /// server's list. `None`: no record and none may be made.
    fn sender_trust(&mut self, sender: &(String, String), keep: bool) -> Result<(Option<Value>, Option<(String, String)>), CryptoError> {
        let key = keys::trust(&sender.0, &sender.1);
        let trusted = parse(self.vault.get(&key))?.filter(|record| truthy(Some(record)));
        if trusted.is_some() || !self.auto_trust { return Ok((trusted, None)) }
        let devices = self.targets(&sender.0)?;
        let Some(device) = devices.iter().find(|device| is_text(device.get("userId"), &sender.0) && is_text(device.get("id"), &sender.1)) else { return Ok((None, None)) };
        let record = auto_record(device);
        let trusted = json::parse(&record).ok();
        if keep { self.vault.commit(vec![(key, Some(record))]); return Ok((trusted, None)) }
        Ok((trusted, Some((key, record))))
    }

    /// Decrypts this device's envelope of a message (from the server or from Mesh) and checks it is addressed
    /// exactly as claimed. `None`: the message has no envelope for this device.
    fn open(&mut self, message: &Value, encrypted: &Value) -> Result<Option<OpenedMessage>, CryptoError> {
        let local_id = self.local_id();
        let envelopes = match encrypted.get("envelopes") { Some(Value::Array(list)) => list.clone(), _ => Vec::new() };
        let Some(envelope) = envelopes.iter().find(|item| is_text(item.get("userId"), &self.user_id) && is_text(item.get("deviceId"), &local_id)) else { return Ok(None) };
        let sender = (text_of(message.get("senderId")), text_of(encrypted.get("senderDeviceId")));
        let (trusted, _) = self.sender_trust(&sender, true)?;
        let Some(trusted) = trusted else { return Err(CryptoError::Untrusted) };
        let state = self.vault.get(keys::PROTOCOL).unwrap_or_default();
        // A scheduled message was encrypted in the sender's separate session. It is opened at a receive-only
        // address (`….scheduled.in`): at the address our own scheduled messages go to, an incoming one would
        // become our sending session there and that session would start to ratchet.
        let lane = encrypted.get("lane").filter(|lane| truthy(Some(lane)));
        let from = match lane { Some(lane) => format!("{}.in", keys::address(&sender.0, &sender.1, Some(&text_of(Some(lane))))), None => keys::address(&sender.0, &sender.1, None) };
        let state = self.bridge.trust_identity(&state, &from, 1, &text_of(trusted.get("identityKey")))?;
        let kind = match envelope.get("type") { Some(Value::Number(kind)) => *kind, _ => f64::NAN };
        let result = self.bridge.decrypt(&state, &from, 1, kind, &text_of(envelope.get("body")))?;
        let body = json::parse(&result.plaintext).map_err(|_| CryptoError::Syntax)?;
        if matches!(body, Value::Null) { return Err(CryptoError::Type) }
        // `lane` is also inside the ciphertext: a server that adds or strips the flag is refused here, before
        // any protocol state is kept.
        let body_lane = body.get("lane").filter(|lane| !matches!(lane, Value::Null));
        let preview_ok = &self.preview_ok;
        let addressed = (match (body_lane, encrypted.get("lane")) { (None, None) => true, (a, b) => strict_eq(a, b) })
            && matches!(body.get("version"), Some(Value::Number(version)) if *version == 1.0)
            && strict_eq(body.get("chatId"), message.get("chatId")) && strict_eq(body.get("clientId"), message.get("clientId")) && strict_eq(body.get("senderId"), message.get("senderId"))
            && strict_eq(body.get("senderDeviceId"), encrypted.get("senderDeviceId")) && is_text(body.get("recipientId"), &self.user_id) && is_text(body.get("recipientDeviceId"), &local_id)
            && matches!(body.get("text"), Some(Value::String(text)) if text.0.len() <= 8000)
            && body.get("attachment").is_some_and(|attachment| valid_attachment(attachment, &|preview| preview_ok(preview)))
            && matches!(body.get("sentAt"), Some(Value::String(_))) && body.get("sentAt").and_then(Value::as_str).is_some_and(|at| parse_iso_ms(&at).is_some())
            && valid_meta(body.get("meta"));
        if !addressed { return refuse("Содержимое не соответствует адресу сообщения.") }
        let attachment = body.get("attachment").cloned().unwrap_or(Value::Null);
        let own_ids = if truthy(Some(&attachment)) { vec![attachment.get("id").cloned().unwrap_or(Value::Null)] } else { Vec::new() };
        let mut listed = match encrypted.get("attachmentIds") { Some(Value::Array(list)) => list.clone(), _ => Vec::new() };
        listed.sort_by(|a, b| js_string(Some(a)).cmp(&js_string(Some(b))));
        if json::stringify(&Value::Array(listed)) != json::stringify(&Value::Array(own_ids)) { return refuse("Неверная привязка зашифрованного вложения.") }
        let plain = object_of(vec![("text", body.get("text").cloned()), ("attachment", Some(with_waveform(&attachment, body.get("voiceWaveform")))), ("sentAt", body.get("sentAt").cloned()), ("meta", body.get("meta").filter(|meta| truthy(Some(meta))).cloned()),
            // A card that is not exactly one this app would have made for this text is dropped; the message stays.
            ("linkPreview", match body.get("text") { Some(Value::String(text)) => for_message(body.get("linkPreview"), text, &attachment, body.get("meta")).cloned(), _ => None })]);
        Ok(Some(OpenedMessage { plain, protocol: result.state, sender }))
    }

    fn decode(&mut self, message: &Value, cursor_key: &str) -> Result<(), CryptoError> {
        let cursor = (cursor_key.to_string(), Some(text_of(message.get("id"))));
        // Our own device's message left out by a lean inbox: nothing to open here (there is no envelope for
        // ourselves, and our copy was kept when it was sent) — the cursor just moves.
        if !truthy(message.get("encrypted")) && truthy(message.get("lean")) && is_text(message.get("senderId"), &self.user_id) { self.vault.commit(vec![cursor]); return Ok(()) }
        let encrypted = message.get("encrypted").cloned().unwrap_or(Value::Null);
        if !valid_encrypted(&encrypted) { return refuse("Некорректный зашифрованный пакет.") }
        let fingerprint = sha256_hex(&canonical_encrypted(&encrypted));
        let key = message_key(message);
        let cached = parse(self.vault.get(&key))?.filter(|record| truthy(Some(record)));
        let same = cached.as_ref().is_some_and(|record| is_text(record.get("fingerprint"), &fingerprint));
        let from_mesh = cached.as_ref().is_some_and(|record| truthy(record.get("mesh")));
        if cached.is_some() && (same || !from_mesh) {
            if !same { return refuse("Сервер изменил сохранённое сообщение.") }
            self.vault.commit(vec![cursor]);
            return Ok(());
        }
        if is_failed(cached.as_ref()) && same { self.vault.commit(vec![cursor]); return Ok(()) }
        let lane = truthy(encrypted.get("lane"));
        let opened = match self.open(message, &encrypted) {
            Ok(opened) => opened,
            Err(error) if error.name() == "NetworkError" || error == CryptoError::Untrusted => return Err(error),
            Err(error) => {
                // A damaged copy may be a passing glitch, so the chat first stops and tries again. But one
                // message that never opens must not block the chat for good: after a few attempts it is
                // marked as failed and skipped, and our next message to the sender's device starts a fresh
                // Signal session, which puts their side back in step too.
                let attempts_key = format!("attempts:{key}");
                let attempts = js_number(self.vault.get(&attempts_key)) + 1.0;
                if attempts < FAILED_AFTER { self.vault.commit(vec![(attempts_key, Some(json::number_text(attempts)))]); return Err(error) }
                let mut changes = vec![(attempts_key, None)];
                // A broken scheduled message says nothing about the ordinary session.
                if !lane { changes.push((keys::rekey(&text_of(message.get("senderId")), &text_of(encrypted.get("senderDeviceId"))), Some("1".to_string()))) }
                changes.push((key, Some(json::stringify(&json::object(vec![("fingerprint", Value::str(&fingerprint)), ("failed", Value::Bool(true))])))));
                changes.push(cursor);
                self.vault.commit(changes);
                return Ok(());
            }
        };
        let Some(opened) = opened else { self.vault.commit(vec![cursor]); return Ok(()) };
        // Already got it over Mesh, then the sender encrypted it again for the server: the text must match.
        if from_mesh && !cached.as_ref().and_then(|record| record.get("plain")).is_some_and(|plain| same_plain(plain, &opened.plain)) { return refuse("Сообщение по Mesh и с сервера не совпадают.") }
        // The first time this message is kept here (a Mesh copy was named already) it is named for the local search.
        let mut changes = if cached.is_some() && !is_failed(cached.as_ref()) { Vec::new() } else { self.history_change(&text_of(message.get("chatId")), &text_of(message.get("senderId")), &text_of(message.get("clientId")))? };
        changes.push((keys::PROTOCOL.to_string(), Some(opened.protocol)));
        // Only an ordinary message says there is an ordinary session with that device.
        if !lane { changes.push((keys::session(&opened.sender.0, &opened.sender.1, None), Some("1".to_string()))) }
        changes.push((key, Some(json::stringify(&json::object(vec![("fingerprint", Value::str(&fingerprint)), ("plain", opened.plain)])))));
        changes.push(cursor);
        self.vault.commit(changes);
        Ok(())
    }

    /// Opens this device's envelopes of a chat in the server's order, each exactly once: the ratchet, the
    /// decrypted copy and the cursor are kept together per message, so a message already opened (or marked as
    /// failed) is never handed to Signal again. `max_pages` (100 messages each) bounds a background catch-up;
    /// it stops with `Partial` and the next one goes on from the cursor.
    pub fn sync_chat(&mut self, chat_id: &str, max_pages: usize) -> Result<(), CryptoError> {
        self.initialize()?;
        let cursor_key = keys::cursor(chat_id);
        let mut after = js_number(self.vault.get(&cursor_key));
        let local_id = self.local_id();
        for _ in 0..max_pages {
            let result = self.transport.crypto_inbox(&local_id, chat_id, after)?;
            let Some(Value::Array(messages)) = result.get("messages").cloned() else { return Err(CryptoError::Type) };
            for message in &messages {
                let id = safe_integer(message.get("id"));
                // (written so that a spoilt cursor behaves as in the reference)
                if !is_text(message.get("chatId"), chat_id) || !id.is_some_and(|id| !(id <= after)) { return refuse("Неверный порядок зашифрованных сообщений.") }
                self.decode(message, &cursor_key)?;
                after = id.unwrap_or(after);
            }
            if !truthy(result.get("hasMore")) { return Ok(()) }
            if messages.is_empty() || !matches!(result.get("nextCursor"), Some(Value::Number(next)) if *next == after) { return refuse("Сервер вернул неверную страницу сообщений.") }
        }
        if max_pages < SYNC_PAGES { Err(CryptoError::Partial) } else { refuse(PARTIAL_TEXT) }
    }

    /// A message that came over Mesh (Bluetooth) instead of the server. Gives the content to show, or `None` if
    /// it is not for this device or was received already. The server's copy, when it comes later, is matched
    /// to this one and not shown twice.
    pub fn receive_mesh(&mut self, input: &Value) -> Result<Option<Value>, CryptoError> {
        self.initialize()?;
        let encrypted = input.get("encrypted").cloned().unwrap_or(Value::Null);
        if !truthy(Some(input)) || !uuid_test(input.get("chatId")) || !uuid_test(input.get("clientId")) || !uuid_test(input.get("senderId")) || is_text(input.get("senderId"), &self.user_id) || !valid_encrypted(&encrypted) { return Ok(None) }
        let key = message_key(input);
        if self.vault.get(&key).is_some_and(|held| !held.is_empty()) { return Ok(None) }
        let fingerprint = sha256_hex(&canonical_encrypted(&encrypted));
        let opened = match self.open(input, &encrypted) { Ok(opened) => opened, Err(error) if error.name() == "NetworkError" => return Ok(None), Err(error) => return Err(error) };
        let Some(opened) = opened else { return Ok(None) };
        let mut changes = self.history_change(&text_of(input.get("chatId")), &text_of(input.get("senderId")), &text_of(input.get("clientId")))?;
        changes.push((keys::PROTOCOL.to_string(), Some(opened.protocol)));
        if !truthy(encrypted.get("lane")) { changes.push((keys::session(&opened.sender.0, &opened.sender.1, None), Some("1".to_string()))) }
        changes.push((key, Some(json::stringify(&json::object(vec![("fingerprint", Value::str(&fingerprint)), ("plain", opened.plain.clone()), ("mesh", Value::Bool(true))])))));
        self.vault.commit(changes);
        Ok(Some(opened.plain))
    }

    /// A message of a list as it may be shown: with the decrypted copy kept here, or with words about why
    /// there is none. The text shown is only ever that copy, never anything the server put in the list.
    pub fn preview(&mut self, message: &Value) -> Result<Value, CryptoError> {
        self.initialize()?;
        let shown = |text: &str, state: &str| Ok(spread(message, vec![("text", Some(Value::str(text))), ("attachment", Some(Value::Null)), ("cryptoState", Some(Value::str(state)))]));
        let decrypted = |cached: &Value| -> Result<Value, CryptoError> {
            let Some(plain @ Value::Object(_)) = cached.get("plain") else { return Err(CryptoError::Type) };
            let mut extra = vec![("text", plain.get("text").cloned()), ("attachment", plain.get("attachment").cloned()), ("createdAt", plain.get("sentAt").cloned()), ("cryptoState", Some(Value::str("decrypted")))];
            if truthy(plain.get("meta")) { extra.push(("meta", plain.get("meta").cloned())) }
            if truthy(plain.get("linkPreview")) { extra.push(("linkPreview", plain.get("linkPreview").cloned())) }
            Ok(spread(message, extra))
        };
        let encrypted = message.get("encrypted").filter(|encrypted| truthy(Some(encrypted)));
        let stored = |vault: &V| parse(vault.get(&message_key(message))).map(|record| record.filter(|record| truthy(Some(record))));
        let Some(encrypted) = encrypted else {
            if !truthy(message.get("lean")) { return shown("Сообщение из старой версии без сквозного шифрования.", "legacy") }
            let stored = stored(&self.vault)?;
            if is_failed(stored.as_ref()) { return shown(FAILED_TEXT, "failed") }
            return match stored { Some(cached) => decrypted(&cached), None => shown("Зашифрованное сообщение. Открой чат для расшифровки.", "no-key") };
        };
        if !valid_encrypted(encrypted) { return shown("Проверка сообщения не пройдена.", "invalid") }
        let stored = stored(&self.vault)?;
        if is_failed(stored.as_ref()) { return shown(FAILED_TEXT, "failed") }
        if let Some(cached) = stored {
            if !is_text(cached.get("fingerprint"), &sha256_hex(&canonical_encrypted(encrypted))) { return shown("Проверка сообщения не пройдена.", "invalid") }
            return decrypted(&cached);
        }
        let local_id = self.local_id();
        let target = matches!(encrypted.get("envelopes"), Some(Value::Array(list)) if list.iter().any(|item| is_text(item.get("userId"), &self.user_id) && is_text(item.get("deviceId"), &local_id)));
        if !target { return shown("Это сообщение недоступно на данном устройстве.", "no-key") }
        let trusted = self.vault.get(&keys::trust(&text_of(message.get("senderId")), &text_of(encrypted.get("senderDeviceId")))).is_some_and(|record| !record.is_empty());
        if trusted { shown("Зашифрованное сообщение. Открой чат для расшифровки.", "no-key") } else { shown("Проверь ключ устройства собеседника в разделе «Защита чата».", "unverified") }
    }

    // ── What is kept: the unsent, the history, the caches ───────────────────────────────────────────────────

    /// The server took the message: it leaves the list of unsent ones.
    pub fn delivered(&mut self, chat_id: &str, client_id: &str) -> Result<(), CryptoError> {
        self.initialize()?;
        let mut changes = self.outbox_index_change(chat_id, client_id, false);
        changes.push((keys::outbox(chat_id, client_id), None));
        self.vault.commit(changes);
        Ok(())
    }

    /// A message the server will never take: its ciphertext, its place in the list of unsent ones and the copy
    /// kept here go, so it is not sent again after a restart. The next `encrypt` with the same id starts
    /// afresh. The vault only: works without internet.
    pub fn forget(&mut self, chat_id: &str, client_id: &str) {
        let mut changes = self.outbox_index_change(chat_id, client_id, false);
        changes.push((keys::outbox(chat_id, client_id), None));
        changes.push((keys::message(chat_id, &self.user_id, client_id), None));
        self.vault.commit(changes);
    }

    /// A chat deleted here: its history names, its cached page and every unsent message of it leave the vault.
    pub fn forget_chat(&mut self, chat_id: &str) -> Result<(), CryptoError> {
        let mut changes: Vec<(String, Option<String>)> = Vec::new();
        let meta = parse(self.vault.get(&keys::history_meta(chat_id)))?.filter(|meta| truthy(Some(meta)));
        if let Some(meta) = &meta {
            if let (Some(first), Some(last)) = (safe_integer(meta.get("first")), safe_integer(meta.get("last"))) {
                if last - first < HISTORY_PAGES * 2.0 { let mut page = first; while page <= last { changes.push((keys::history_page(chat_id, page), None)); page += 1.0 } }
            }
            changes.push((keys::history_meta(chat_id), None));
        }
        let chats = self.history_chats();
        if chats.iter().any(|id| id == chat_id) {
            let rest: Vec<Value> = chats.iter().filter(|id| *id != chat_id).map(|id| Value::str(id)).collect();
            changes.push((keys::HISTORY_CHATS.to_string(), if chats.len() > 1 { Some(json::stringify(&Value::Array(rest))) } else { None }));
        }
        let page = format!("page:v1:{chat_id}");
        if cache_name(&page) && self.vault.get(&page).is_some() { changes.push((page, None)) }
        let refs = self.outbox_refs();
        let rest: Vec<Value> = refs.iter().filter(|item| !is_text(item.get("chatId"), chat_id)).cloned().collect();
        if rest.len() != refs.len() {
            for item in refs.iter().filter(|item| is_text(item.get("chatId"), chat_id)) {
                let client_id = text_of(item.get("clientId"));
                changes.push((keys::outbox(chat_id, &client_id), None));
                changes.push((keys::message(chat_id, &self.user_id, &client_id), None));
            }
            changes.push((keys::OUTBOX_INDEX.to_string(), if rest.is_empty() { None } else { Some(json::stringify(&Value::Array(rest))) }));
        }
        if !changes.is_empty() { self.vault.commit(changes) }
        Ok(())
    }

    /// One page of the decrypted messages kept for a chat, newest first (the search on the device is built
    /// from these). `page`: `None` for the newest. Gives `{items, page, previous}`; `previous` names the older
    /// page, `null` past the oldest kept.
    pub fn history_page(&self, chat_id: &str, page: Option<f64>) -> Result<Value, CryptoError> {
        let answer = |items: Vec<Value>, page: f64, previous: Option<f64>| json::object(vec![("items", Value::Array(items)), ("page", Value::Number(page)), ("previous", previous.map_or(Value::Null, Value::Number))]);
        let meta = parse(self.vault.get(&keys::history_meta(chat_id)))?.filter(|meta| truthy(Some(meta)));
        let range = meta.as_ref().and_then(|meta| Some((safe_integer(meta.get("first"))?, safe_integer(meta.get("last"))?))).filter(|(first, last)| first <= last);
        let Some((first, last)) = range else { return Ok(answer(Vec::new(), page.unwrap_or(0.0), None)) };
        let current = page.unwrap_or(last);
        let previous = (current - 1.0 >= first).then_some(current - 1.0);
        if current > last || current < first { return Ok(answer(Vec::new(), current, previous)) }
        let list = match self.vault.get(&keys::history_page(chat_id, current)).map(|text| json::parse(&text)) { Some(Ok(Value::Array(list))) => list, _ => Vec::new() };
        let mut items = Vec::new();
        for item in list.iter().rev() {
            let Value::Array(pair) = item else { continue };
            let (Some(Value::String(_)), Some(Value::String(_))) = (pair.first(), pair.get(1)) else { continue };
            let (sender_id, client_id) = (text_of(pair.first()), text_of(pair.get(1)));
            let Some(Ok(cached)) = self.vault.get(&keys::message(chat_id, &sender_id, &client_id)).map(|text| json::parse(&text)) else { continue };
            if !truthy(Some(&cached)) || is_failed(Some(&cached)) || !truthy(cached.get("plain")) { continue }
            let plain = cached.get("plain").cloned().unwrap_or(Value::Null);
            items.push(object_of(vec![("chatId", Some(Value::str(chat_id))), ("senderId", pair.first().cloned()), ("clientId", pair.get(1).cloned()), ("text", plain.get("text").cloned()), ("attachment", plain.get("attachment").cloned()), ("sentAt", plain.get("sentAt").cloned()), ("meta", plain.get("meta").filter(|meta| truthy(Some(meta))).cloned()), ("linkPreview", plain.get("linkPreview").filter(|card| truthy(Some(card))).cloned())]));
        }
        Ok(answer(items, current, previous))
    }

    /// The kept pages of a chat, newest first, up to `limit` messages, starting at `from_page` when given.
    pub fn history(&self, chat_id: &str, limit: Option<usize>, from_page: Option<f64>) -> Result<Vec<Value>, CryptoError> {
        let limit = limit.unwrap_or(HISTORY_PAGE * HISTORY_PAGES as usize);
        let (mut out, mut page) = (Vec::new(), from_page);
        while out.len() < limit {
            let result = self.history_page(chat_id, page)?;
            if let Some(Value::Array(items)) = result.get("items") { for item in items { if out.len() >= limit { break } out.push(item.clone()) } }
            match result.get("previous") { Some(Value::Number(previous)) => page = Some(*previous), _ => break }
        }
        Ok(out)
    }

    /// Data that lives on this device only, in the same encrypted storage: `saved:v1` («Избранное»), `ai:v1`,
    /// `drafts:v1`. No server is needed first, so they open without a network.
    pub fn load_local(&self, name: &str) -> Option<String> { self.vault.get(name) }
    pub fn store_local(&mut self, name: &str, value: &str) { self.vault.commit(vec![(name.to_string(), Some(value.to_string()))]) }
    /// The last shown chat list (`chats:v1`) and chat pages (`page:v1:<chat>`).
    pub fn load_cache(&self, name: &str) -> Result<Option<String>, CryptoError> { if !cache_name(name) { return refuse("Unknown cache entry.") } Ok(self.vault.get(name)) }
    pub fn store_cache(&mut self, name: &str, value: Option<&str>) -> Result<(), CryptoError> {
        if !cache_name(name) { return refuse("Unknown cache entry.") }
        self.vault.commit(vec![(name.to_string(), value.map(str::to_string))]);
        Ok(())
    }

    // ── Notes for one device (voice rooms) ──────────────────────────────────────────────────────────────────

    /// A short note for exactly one device of `peer_id`, outside every chat (nothing goes to the history or
    /// to the unsent list). It travels in its own session, like a scheduled message; the trust rules are those
    /// of chat messages. Gives `{senderDeviceId, type, body}`.
    pub fn seal_note(&mut self, peer_id: &str, device_id: &str, text: &str) -> Result<Value, CryptoError> { self.seal_note_in(peer_id, device_id, text, "voice") }

    /// `lane`: `voice` (a device of the other person) or `history` (one of our own other devices: the key of a
    /// copy of the chats or the backup secret, docs/HISTORY-TRANSFER.md).
    pub fn seal_note_in(&mut self, peer_id: &str, device_id: &str, text: &str, lane: &str) -> Result<Value, CryptoError> {
        self.initialize()?;
        let lane_name = if lane == "history" { "history" } else { "voice" };
        let lane_ref: Option<&str> = Some(lane_name);
        if !uuid_str(device_id) || text.is_empty() || text.encode_utf16().count() > 4000 || (lane != "voice" && lane != "history") || (lane == "history" && peer_id != self.user_id) { return refuse("Некорректная заметка.") }
        let found = if lane == "history" { self.own_device(device_id)? } else { self.targets(peer_id)?.into_iter().find(|item| is_text(item.get("userId"), peer_id) && is_text(item.get("id"), device_id)) };
        let Some(device) = found else { return refuse("Устройство собеседника не найдено.") };
        let mut state = self.vault.get(keys::PROTOCOL).unwrap_or_default();
        let mut changes: Vec<(String, Option<String>)> = Vec::new();
        let trusted = parse(self.vault.get(&device_key(&device, keys::trust)))?.filter(|record| truthy(Some(record)));
        let mut rekey = false;
        let identity_key = text_of(device.get("identityKey"));
        if !trusted.as_ref().is_some_and(|record| same_device(record, &device)) {
            if !self.auto_trust { return Err(CryptoError::Untrusted) }
            state = self.bridge.trust_identity(&state, &device_address(&device, None), 1, &identity_key)?;
            changes.push((device_key(&device, keys::trust), Some(auto_record(&device))));
            rekey = trusted.is_some();
        }
        state = self.bridge.trust_identity(&state, &device_address(&device, lane_ref), 1, &identity_key)?;
        let now = self.env.now_iso();
        let session = self.vault.get(&session_key(&device, lane_ref)).filter(|session| !session.is_empty());
        let stale = session.as_ref().is_some_and(|started| !(parse_iso_ms(started).unwrap_or(f64::NAN) > parse_iso_ms(&now).unwrap_or(f64::NAN) - LANE_SESSION_MAX_AGE_MS));
        let mut bundle = if rekey || session.is_none() || stale { Some(self.claim(&device)?) } else { None };
        let local_id = self.local_id();
        let payload = json::stringify(&json::object(vec![("version", Value::Number(1.0)), ("note", Value::str(lane_name)), ("senderId", Value::str(&self.user_id)), ("senderDeviceId", Value::str(&local_id)),
            ("recipientId", device.get("userId").cloned().unwrap_or(Value::Null)), ("recipientDeviceId", device.get("id").cloned().unwrap_or(Value::Null)), ("text", Value::str(text))]));
        let address = device_address(&device, lane_ref);
        let sealed = match self.bridge.encrypt(&state, &address, 1, &payload, bundle.as_ref()) {
            Ok(sealed) => sealed,
            Err(error) if bundle.is_none() && error.name != "NetworkError" && lane_session_error(&error) => {
                bundle = Some(self.claim(&device)?);
                self.bridge.encrypt(&state, &address, 1, &payload, bundle.as_ref())?
            }
            Err(error) => return Err(error.into()),
        };
        changes.push((session_key(&device, lane_ref), Some(if bundle.is_some() { now } else { session.unwrap_or_default() })));
        changes.push((keys::PROTOCOL.to_string(), Some(sealed.state)));
        self.vault.commit(changes);
        Ok(json::object(vec![("senderDeviceId", Value::str(&local_id)), ("type", Value::Number(sealed.kind)), ("body", Value::str(&sealed.body))]))
    }

    /// Opens a note from `sender_id`; refuses unless that person's trusted device sealed it for this very device.
    pub fn open_note(&mut self, sender_id: &str, note: &Value) -> Result<String, CryptoError> { self.open_note_in(sender_id, note, "voice") }

    /// `lane`: `voice` (from the other person) or `history` (from one of our own other devices).
    pub fn open_note_in(&mut self, sender_id: &str, note: &Value, lane: &str) -> Result<String, CryptoError> {
        self.initialize()?;
        let own = lane == "history";
        let lane_name = if own { "history" } else { "voice" };
        let kind = match note.get("type") { Some(Value::Number(kind)) if *kind == 2.0 || *kind == 3.0 => *kind, _ => f64::NAN };
        let local_id = self.local_id();
        let wrong_sender = if own { sender_id != self.user_id } else { sender_id == self.user_id };
        if !uuid_str(sender_id) || wrong_sender || !truthy(Some(note)) || !uuid_test(note.get("senderDeviceId")) || (own && is_text(note.get("senderDeviceId"), &local_id)) || kind.is_nan() || !valid_ciphertext_body(note.get("body")) || (lane != "voice" && !own) { return refuse("Некорректная заметка.") }
        let sender = (sender_id.to_string(), text_of(note.get("senderDeviceId")));
        let (trusted, new_record) = if own { self.own_sender_trust(&sender.1)? } else { self.sender_trust(&sender, false)? };
        let Some(trusted) = trusted else { return Err(CryptoError::Untrusted) };
        let from = format!("{}.in", keys::address(&sender.0, &sender.1, Some(lane_name)));
        let state = self.vault.get(keys::PROTOCOL).unwrap_or_default();
        let state = self.bridge.trust_identity(&state, &from, 1, &text_of(trusted.get("identityKey")))?;
        let result = self.bridge.decrypt(&state, &from, 1, kind, &text_of(note.get("body")))?;
        let body = json::parse(&result.plaintext).map_err(|_| CryptoError::Syntax)?;
        if matches!(body, Value::Null) { return Err(CryptoError::Type) }
        let local_id = self.local_id();
        let ours = matches!(body.get("version"), Some(Value::Number(version)) if *version == 1.0) && is_text(body.get("note"), lane_name) && is_text(body.get("senderId"), sender_id)
            && strict_eq(body.get("senderDeviceId"), note.get("senderDeviceId")) && is_text(body.get("recipientId"), &self.user_id) && is_text(body.get("recipientDeviceId"), &local_id)
            && matches!(body.get("text"), Some(Value::String(text)) if text.0.len() <= 4000);
        if !ours { return refuse("Заметка адресована не этому устройству.") }
        let mut changes: Vec<(String, Option<String>)> = new_record.into_iter().map(|(key, record)| (key, Some(record))).collect();
        changes.push((keys::PROTOCOL.to_string(), Some(result.state)));
        self.vault.commit(changes);
        Ok(text_of(body.get("text")))
    }
}
