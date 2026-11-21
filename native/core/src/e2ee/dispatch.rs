//! The encryption service by name: one entry for every operation, with its arguments and its answer as JSON.
//! This is the form the apps call it in (`ffi.rs`), and the form the recorded scenarios are replayed in.

use super::bridge::{CryptoTransport, Env, SignalBridge, Vault};
use super::service::{Crypto, CryptoError, Outgoing, SYNC_PAGES};
use crate::json::Value;

fn word(args: &[Value], at: usize) -> String { args.get(at).and_then(Value::as_str).unwrap_or_default() }
fn number(args: &[Value], at: usize) -> Option<f64> { match args.get(at) { Some(Value::Number(number)) => Some(*number), _ => None } }
fn text(value: String) -> Value { Value::str(&value) }

/// Runs one operation. Operations and their arguments (a missing optional argument is `null`):
/// `initialize []` · `encrypt [chatId, peerId, clientId, text, attachment|null, meta|null, deliverAt|null]` ·
/// `snapshot [peerId]` · `approve [snapshot]` · `pendingOutbox []` · `sync [chatId, maxPages|null]` ·
/// `preview [message]` · `mesh [envelope]` · `delivered [chatId, clientId]` · `forget [chatId, clientId]` ·
/// `forgetChat [chatId]` · `historyChats []` · `historyPage [chatId, page|null]` ·
/// `history [chatId, limit|null, fromPage|null]` · `loadLocal [name]` · `storeLocal [name, value]` ·
/// `loadCache [name]` · `storeCache [name, value|null]` · `sealNote [peerId, deviceId, text]` ·
/// `openNote [senderId, note]` · `deviceId []`.
/// An operation that gives nothing answers `null`.
pub fn dispatch<S: SignalBridge, V: Vault, T: CryptoTransport, E: Env>(service: &mut Crypto<S, V, T, E>, op: &str, args: &[Value]) -> Result<Value, CryptoError> {
    let null = Value::Null;
    let arg = |at: usize| args.get(at).unwrap_or(&null);
    match op {
        "initialize" => service.initialize().map(|_| Value::Null),
        "deviceId" => Ok(service.device_id().map_or(Value::Null, text)),
        "encrypt" => {
            let (chat, peer, client, body, deliver) = (word(args, 0), word(args, 1), word(args, 2), word(args, 3), args.get(6).and_then(Value::as_str));
            let meta = args.get(5).filter(|meta| !matches!(meta, Value::Null));
            service.encrypt(&Outgoing { chat_id: &chat, peer_id: &peer, client_id: &client, text: &body, attachment: arg(4), meta, deliver_at: deliver.as_deref() })
        }
        "snapshot" => service.trust_snapshot(&word(args, 0)),
        "approve" => service.approve_devices(arg(0)).map(|_| Value::Null),
        "pendingOutbox" => service.pending_outbox().map(Value::Array),
        "sync" => service.sync_chat(&word(args, 0), number(args, 1).map_or(SYNC_PAGES, |pages| pages as usize)).map(|_| Value::Null),
        "preview" => service.preview(arg(0)),
        "mesh" => service.receive_mesh(arg(0)).map(|plain| plain.unwrap_or(Value::Null)),
        "delivered" => service.delivered(&word(args, 0), &word(args, 1)).map(|_| Value::Null),
        "forget" => { service.forget(&word(args, 0), &word(args, 1)); Ok(Value::Null) }
        "forgetChat" => service.forget_chat(&word(args, 0)).map(|_| Value::Null),
        "historyChats" => Ok(Value::Array(service.history_chats().iter().map(|id| Value::str(id)).collect())),
        "historyPage" => service.history_page(&word(args, 0), number(args, 1)),
        "history" => service.history(&word(args, 0), number(args, 1).map(|limit| limit as usize), number(args, 2)).map(Value::Array),
        "loadLocal" => match word(args, 0).as_str() { name @ ("saved:v1" | "ai:v1" | "drafts:v1") => Ok(service.load_local(name).map_or(Value::Null, text)), _ => Err(CryptoError::Message("Unknown local entry.".to_string())) },
        "storeLocal" => match word(args, 0).as_str() { name @ ("saved:v1" | "ai:v1" | "drafts:v1") => { service.store_local(name, &word(args, 1)); Ok(Value::Null) } _ => Err(CryptoError::Message("Unknown local entry.".to_string())) },
        "loadCache" => service.load_cache(&word(args, 0)).map(|held| held.map_or(Value::Null, text)),
        "storeCache" => service.store_cache(&word(args, 0), args.get(1).and_then(Value::as_str).as_deref()).map(|_| Value::Null),
        "sealNote" => service.seal_note(&word(args, 0), &word(args, 1), &word(args, 2)),
        "openNote" => service.open_note(&word(args, 0), arg(1)).map(text),
        _ => Err(CryptoError::Message(format!("Unknown operation: {op}"))),
    }
}
