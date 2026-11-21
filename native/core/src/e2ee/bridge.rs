//! What the logic around encryption needs from the outside: the Signal library, the private storage, the
//! server and the clock.
//!
//! Reference: `mobile/src/e2ee/types.ts` (`SignalBridge`, `PrivateVault`), `CryptoTransport` and the names of the
//! stored records in `mobile/src/e2ee/core.ts`. The Signal protocol itself is the official library on each
//! platform (`mobile/modules/linea-signal`: `SignalCore.swift`, `SignalCore.kt`); its whole state — identity,
//! prekeys, sessions — is one opaque text that only that library reads. The storage is the encrypted database
//! on the device; a change of several records is written as one step or not at all.

use crate::json::Value;

/// Signal message kinds as the reference names them: 3 opens a session (carries a prekey bundle), 2 continues one.
pub const PREKEY_MESSAGE: f64 = 3.0;
pub const WHISPER_MESSAGE: f64 = 2.0;

#[derive(Clone, PartialEq, Debug)]
pub struct Sealed { pub state: String, pub kind: f64, pub body: String }

#[derive(Clone, PartialEq, Debug)]
pub struct Opened { pub state: String, pub plaintext: String }

/// The failure of a Signal operation, in the library's own words (`name` and `code` when it gives them).
#[derive(Clone, PartialEq, Debug, Default)]
pub struct SignalError { pub name: String, pub code: String, pub message: String }

/// The Signal library. Every call takes the state and gives back the new one; nothing is kept inside.
/// Bundles are JSON values in the reference's shapes (`PublicBundle`, `ClaimedBundle`).
pub trait SignalBridge {
    /// A new identity with its first prekeys: the state and the public bundle.
    fn create_state(&mut self, local_address: &str, device_id: u32) -> Result<(String, Value), SignalError>;
    /// Adds `count` one-time prekeys: the state and the public bundle.
    fn replenish(&mut self, state: &str, count: u32) -> Result<(String, Value), SignalError>;
    fn trust_identity(&mut self, state: &str, address: &str, device_id: u32, identity_key: &str) -> Result<String, SignalError>;
    /// `bundle`: the other device's claimed bundle when a session has to be started.
    fn encrypt(&mut self, state: &str, address: &str, device_id: u32, plaintext: &str, bundle: Option<&Value>) -> Result<Sealed, SignalError>;
    fn decrypt(&mut self, state: &str, address: &str, device_id: u32, kind: f64, body: &str) -> Result<Opened, SignalError>;
}

/// The private storage. `commit` writes every change or none; `None` removes a record.
pub trait Vault {
    fn get(&self, key: &str) -> Option<String>;
    fn commit(&mut self, changes: Vec<(String, Option<String>)>);
}

#[derive(Clone, PartialEq, Debug)]
pub enum TransportError {
    /// The request got no answer: there may be no internet. With its words for the person.
    Network(String),
    /// The server answered no, with its words.
    Refused(String),
}

/// The server, as far as encryption needs it. Answers are the parsed JSON bodies.
pub trait CryptoTransport {
    /// `{device, preKeyCount}`
    fn register_crypto_device(&mut self, device_id: &str, bundle: &Value) -> Result<Value, TransportError>;
    /// `{devices: [...]}`
    fn crypto_devices(&mut self, user_id: &str) -> Result<Value, TransportError>;
    /// `{device, bundle}`
    fn claim_pre_key(&mut self, user_id: &str, device_id: &str) -> Result<Value, TransportError>;
    /// `{messages, nextCursor, hasMore}`
    fn crypto_inbox(&mut self, device_id: &str, chat_id: &str, after: f64) -> Result<Value, TransportError>;
}

/// The clock and the id generator of the device.
pub trait Env {
    /// The time now as `2026-11-21T07:00:00.000Z`.
    fn now_iso(&mut self) -> String;
    /// A new random UUID (version 4), in small letters.
    fn random_uuid(&mut self) -> String;
}

/// The names of the stored records, exactly as the reference writes them: a native app opens the database the
/// previous app left and must find everything where it was.
pub mod keys {
    pub const PROTOCOL: &str = "protocol";
    pub const DEVICE: &str = "device";
    pub const OUTBOX_INDEX: &str = "outbox:index";
    pub const HISTORY_CHATS: &str = "history:chats";
    pub fn trust(user_id: &str, device_id: &str) -> String { format!("trust:{user_id}:{device_id}") }
    pub fn rekey(user_id: &str, device_id: &str) -> String { format!("rekey:{user_id}:{device_id}") }
    /// `lane`: `scheduled` or `voice` for the separate sessions, `None` for the ordinary one.
    pub fn session(user_id: &str, device_id: &str, lane: Option<&str>) -> String {
        match lane { Some(lane) => format!("session:{user_id}:{device_id}:{lane}"), None => format!("session:{user_id}:{device_id}") }
    }
    pub fn devices(user_id: &str) -> String { format!("devices:{user_id}") }
    pub fn message(chat_id: &str, sender_id: &str, client_id: &str) -> String { format!("message:{chat_id}:{sender_id}:{client_id}") }
    pub fn outbox(chat_id: &str, client_id: &str) -> String { format!("outbox:{chat_id}:{client_id}") }
    pub fn cursor(chat_id: &str) -> String { format!("cursor:{chat_id}") }
    pub fn history_meta(chat_id: &str) -> String { format!("history:{chat_id}") }
    pub fn history_page(chat_id: &str, page: f64) -> String { format!("history:{chat_id}:{}", crate::json::number_text(page)) }
    /// The address a device is known by to the Signal library: `user.device`, with `.scheduled` / `.voice` for
    /// the separate sessions.
    pub fn address(user_id: &str, device_id: &str, lane: Option<&str>) -> String {
        match lane { Some(lane) => format!("{user_id}.{device_id}.{lane}"), None => format!("{user_id}.{device_id}") }
    }
}
