//! What the logic around encryption needs from the outside: the Signal library and the private storage.
//!
//! Reference: `mobile/src/e2ee/types.ts` (`SignalBridge`, `PrivateVault`) and the names of the stored records in
//! `mobile/src/e2ee/core.ts`. The Signal protocol itself is the official library on each platform
//! (`mobile/modules/linea-signal`: `SignalCore.swift`, `SignalCore.kt`); its whole state — identity, prekeys,
//! sessions — is one opaque text that only that library reads. The storage is the encrypted database on the
//! device; a change of several records is written as one step or not at all.

use std::collections::BTreeMap;

/// Signal message kinds as the reference names them: 3 opens a session (carries a prekey bundle), 2 continues one.
pub const PREKEY_MESSAGE: u8 = 3;
pub const WHISPER_MESSAGE: u8 = 2;

#[derive(Clone, PartialEq, Debug)]
pub struct Sealed { pub state: String, pub kind: u8, pub body: String }

#[derive(Clone, PartialEq, Debug)]
pub struct Opened { pub state: String, pub plaintext: String }

/// The failure of a Signal operation, with the library's own words.
#[derive(Clone, PartialEq, Debug)]
pub struct SignalError(pub String);

/// The Signal library. Every call takes the state and gives back the new one; nothing is kept inside.
/// `bundle` values are JSON texts in the reference's shapes (`PublicBundle`, `ClaimedBundle`).
pub trait SignalBridge {
    /// A new identity with its first prekeys. Returns the state and the public bundle (JSON).
    fn create_state(&self, local_address: &str, device_id: u32) -> Result<(String, String), SignalError>;
    /// Adds `count` one-time prekeys. Returns the state and the public bundle (JSON).
    fn replenish(&self, state: &str, count: u32) -> Result<(String, String), SignalError>;
    fn trust_identity(&self, state: &str, address: &str, device_id: u32, identity_key: &str) -> Result<String, SignalError>;
    /// `bundle`: the other device's claimed bundle (JSON) when no session exists yet.
    fn encrypt(&self, state: &str, address: &str, device_id: u32, plaintext: &str, bundle: Option<&str>) -> Result<Sealed, SignalError>;
    fn decrypt(&self, state: &str, address: &str, device_id: u32, kind: u8, body: &str) -> Result<Opened, SignalError>;
}

/// The private storage. `commit` writes every change or none; `None` removes a record.
pub trait Vault {
    fn get(&self, key: &str) -> Option<String>;
    fn commit(&mut self, changes: BTreeMap<String, Option<String>>);
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
    pub fn history_page(chat_id: &str, page: u32) -> String { format!("history:{chat_id}:{page}") }
    /// The address a device is known by to the Signal library: `user.device`, with `.scheduled` / `.voice` for
    /// the separate sessions.
    pub fn address(user_id: &str, device_id: &str, lane: Option<&str>) -> String {
        match lane { Some(lane) => format!("{user_id}.{device_id}.{lane}"), None => format!("{user_id}.{device_id}") }
    }
}
