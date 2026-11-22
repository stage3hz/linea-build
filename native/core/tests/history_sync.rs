//! Old chats on a new device, the whole way (`e2ee::history_sync`): a device with cached chats sends them to a new
//! device of the same account through a stand-in of the server that keeps only what the real one keeps (history.js);
//! the backup is enabled, its secret handed over sealed, and restored by the typed secret. The Signal library is a
//! stand-in (notes are not encrypted here; that is the library's job, checked elsewhere); the pages use the real
//! AES-256-GCM-SIV. Also checked: the server never sees a message text or the backup secret.
use aes_gcm_siv::{AeadInOut as _, Aes256GcmSiv, KeyInit as _};
use base64::Engine as _;
use invizent_core::e2ee::bridge::*;
use invizent_core::e2ee::history::{self, PageCipher};
use invizent_core::e2ee::history_sync::{History, HistoryServer, Refusal, SyncError};
use invizent_core::e2ee::service::Crypto;
use invizent_core::json::{self, Value};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
const USER: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";
const CHAT: &str = "c0000000-0000-4000-8000-000000000001";

struct Cipher;
impl PageCipher for Cipher {
    fn seal(&self, plain: &str, key: &str, nonce: &str, ad: &str) -> Result<String, ()> {
        let cipher = Aes256GcmSiv::new_from_slice(&B64.decode(key).map_err(|_| ())?).map_err(|_| ())?;
        let nonce = aes_gcm_siv::Nonce::try_from(B64.decode(nonce).map_err(|_| ())?.as_slice()).map_err(|_| ())?;
        let mut buffer = B64.decode(plain).map_err(|_| ())?;
        cipher.encrypt_in_place(&nonce, &B64.decode(ad).map_err(|_| ())?, &mut buffer).map_err(|_| ())?;
        Ok(B64.encode(buffer))
    }
    fn open(&self, sealed: &str, key: &str, nonce: &str, ad: &str) -> Result<String, ()> {
        let cipher = Aes256GcmSiv::new_from_slice(&B64.decode(key).map_err(|_| ())?).map_err(|_| ())?;
        let nonce = aes_gcm_siv::Nonce::try_from(B64.decode(nonce).map_err(|_| ())?.as_slice()).map_err(|_| ())?;
        let mut buffer = B64.decode(sealed).map_err(|_| ())?;
        cipher.decrypt_in_place(&nonce, &B64.decode(ad).map_err(|_| ())?, &mut buffer).map_err(|_| ())?;
        Ok(B64.encode(buffer))
    }
}

/// The account's devices as the server lists them, shared by every device's transport.
#[derive(Default)]
struct World { devices: Vec<Value>, ids: u32 }
type Shared = Rc<RefCell<World>>;

struct Bridge(String);
impl SignalBridge for Bridge {
    fn create_state(&mut self, _address: &str, _device_id: u32) -> Result<(String, Value), SignalError> {
        let key = B64.encode([self.0.as_bytes()[0]; 33]);
        Ok(("S".to_string(), json::object(vec![("registrationId", Value::Number(7.0)), ("identityKey", Value::str(&key)), ("preKeys", Value::Array(vec![]))])))
    }
    fn replenish(&mut self, state: &str, _count: u32) -> Result<(String, Value), SignalError> { Ok((state.to_string(), Value::Null)) }
    fn trust_identity(&mut self, state: &str, _address: &str, _device_id: u32, _identity_key: &str) -> Result<String, SignalError> { Ok(state.to_string()) }
    fn encrypt(&mut self, state: &str, _address: &str, _device_id: u32, plaintext: &str, _bundle: Option<&Value>) -> Result<Sealed, SignalError> {
        Ok(Sealed { state: state.to_string(), kind: 3.0, body: B64.encode(plaintext.as_bytes()) })
    }
    fn decrypt(&mut self, state: &str, _address: &str, _device_id: u32, _kind: f64, body: &str) -> Result<Opened, SignalError> {
        Ok(Opened { state: state.to_string(), plaintext: String::from_utf8(B64.decode(body).unwrap()).unwrap() })
    }
}
struct Transport(Shared);
impl CryptoTransport for Transport {
    fn register_crypto_device(&mut self, device_id: &str, bundle: &Value) -> Result<Value, TransportError> {
        let device = json::object(vec![("id", Value::str(device_id)), ("userId", Value::str(USER)), ("deviceName", Value::str("x")), ("identityKey", bundle.get("identityKey").cloned().unwrap()), ("registrationId", Value::Number(7.0)), ("createdAt", Value::str("")), ("active", Value::Bool(true))]);
        let mut world = self.0.borrow_mut();
        world.devices.retain(|item| item.get("id").and_then(Value::as_str).as_deref() != Some(device_id));
        world.devices.push(device.clone());
        Ok(json::object(vec![("device", device), ("preKeyCount", Value::Number(20.0))]))
    }
    fn crypto_devices(&mut self, _user_id: &str) -> Result<Value, TransportError> { Ok(json::object(vec![("devices", Value::Array(self.0.borrow().devices.clone()))])) }
    fn claim_pre_key(&mut self, _user_id: &str, device_id: &str) -> Result<Value, TransportError> {
        let device = self.0.borrow().devices.iter().find(|item| item.get("id").and_then(Value::as_str).as_deref() == Some(device_id)).cloned().unwrap();
        let bundle = json::object(vec![("registrationId", Value::Number(7.0)), ("identityKey", device.get("identityKey").cloned().unwrap())]);
        Ok(json::object(vec![("device", device), ("bundle", bundle)]))
    }
    fn crypto_inbox(&mut self, _device_id: &str, _chat_id: &str, after: f64) -> Result<Value, TransportError> {
        Ok(json::object(vec![("messages", Value::Array(vec![])), ("nextCursor", Value::Number(after)), ("hasMore", Value::Bool(false))]))
    }
}
struct Clock(Shared);
impl Env for Clock {
    fn now_iso(&mut self) -> String { "2026-11-22T10:00:00.000Z".to_string() }
    fn random_uuid(&mut self) -> String { let mut world = self.0.borrow_mut(); world.ids += 1; format!("00000000-0000-4000-8000-{:012}", world.ids) }
}
#[derive(Clone, Default)]
struct Memory(Rc<RefCell<BTreeMap<String, String>>>);
impl Vault for Memory {
    fn get(&self, key: &str) -> Option<String> { self.0.borrow().get(key).cloned() }
    fn commit(&mut self, changes: Vec<(String, Option<String>)>) {
        let mut data = self.0.borrow_mut();
        for (key, value) in changes { match value { Some(value) => { data.insert(key, value); } None => { data.remove(&key); } } }
    }
}
type Device = Crypto<Bridge, Memory, Transport, Clock>;
fn device(world: &Shared, seed: &str) -> Device {
    let mut made = Crypto::new(USER, Bridge(seed.to_string()), Memory::default(), Transport(world.clone()), Clock(world.clone()), true, Box::new(|preview| preview.is_none()));
    made.initialize().expect("keys");
    made
}

/// What history.js keeps, in memory; every value that passes is recorded in `seen`.
#[derive(Default)]
struct Server { seen: Vec<String>, transfers: Vec<Value>, pages: BTreeMap<String, Vec<String>>, backup: Option<(f64, String, Vec<String>, Option<String>)>, salt: String, notes: BTreeMap<String, Value>, writer: Option<String> }
impl Server {
    fn refuse(code: &str, status: f64) -> Refusal { Refusal { network: false, message: code.to_string(), code: Some(code.to_string()), status } }
    fn transfer(&mut self, id: &str) -> &mut Value { self.transfers.iter_mut().find(|t| t.get("id").and_then(Value::as_str).as_deref() == Some(id)).unwrap() }
}
fn set(object: &mut Value, key: &str, value: Value) { if let Value::Object(entries) = object { entries.retain(|(name, _)| name.to_string_lossy() != key); entries.push((invizent_core::json::JsString::from_str(key), value)) } }
fn s(args: &[Value], at: usize) -> String { args[at].as_str().unwrap_or_default() }
impl HistoryServer for Server {
    fn call(&mut self, op: &str, args: Vec<Value>) -> Result<Value, Refusal> {
        self.seen.push(json::stringify(&Value::Array(args.clone())));
        let ok = |value: Value| Ok(value);
        match op {
            "requestHistory" => {
                let transfer = json::object(vec![("id", Value::str("a0000000-0000-4000-8000-000000000001")), ("state", Value::str("waiting")), ("targetDeviceId", Value::str(&s(&args, 0))), ("ready", Value::Bool(true)), ("notBefore", Value::str("")), ("pageCount", Value::Number(0.0))]);
                self.transfers.push(transfer.clone());
                ok(json::object(vec![("transfer", transfer)]))
            }
            "outgoingHistory" => { let me = s(&args, 0); ok(json::object(vec![("transfers", Value::Array(self.transfers.iter().filter(|t| t.get("targetDeviceId").and_then(Value::as_str) != Some(me.clone()) && matches!(t.get("state").and_then(Value::as_str).as_deref(), Some("waiting" | "sending"))).cloned().collect()))])) }
            "incomingHistory" => { let me = s(&args, 0); ok(json::object(vec![("transfer", self.transfers.iter().find(|t| t.get("targetDeviceId").and_then(Value::as_str) == Some(me.clone())).cloned().unwrap_or(Value::Null))])) }
            "claimHistory" => { let id = s(&args, 0); let source = s(&args, 1); let t = self.transfer(&id); set(t, "state", Value::str("sending")); set(t, "sourceDeviceId", Value::str(&source)); self.pages.insert(id, Vec::new()); ok(Value::Null) }
            "putHistoryPage" => { let list = self.pages.get_mut(&s(&args, 0)).unwrap(); assert_eq!(args[1], Value::Number(list.len() as f64)); list.push(s(&args, 3)); ok(Value::Null) }
            "completeHistory" => { let id = s(&args, 0); let count = self.pages[&id].len() as f64; assert_eq!(args[3], Value::Number(count)); let t = self.transfer(&id); set(t, "state", Value::str("ready")); set(t, "note", args[2].clone()); set(t, "pageCount", Value::Number(count)); ok(Value::Null) }
            "historyPage" => { let index = match args[1] { Value::Number(n) => n as usize, _ => 0 }; ok(json::object(vec![("body", Value::str(&self.pages[&s(&args, 0)][index]))])) }
            "ackHistory" => { let id = s(&args, 0); self.pages.remove(&id); let t = self.transfer(&id); set(t, "state", Value::str("done")); ok(Value::Null) }
            "backupState" => {
                let me = s(&args, 0);
                let mut fields = vec![("enabled", Value::Bool(self.backup.is_some())), ("salt", Value::str(&self.salt)), ("generation", Value::Number(self.backup.as_ref().map_or(0.0, |b| b.0)))];
                if let Some(note) = self.notes.get(&me) { fields.push(("note", note.clone())) }
                fields.push(("missing", Value::Array(Vec::new())));
                ok(json::object(fields))
            }
            "enableBackup" => { self.backup = Some((match args[1] { Value::Number(n) => n, _ => 0.0 }, s(&args, 2), Vec::new(), None)); self.writer = Some(s(&args, 0)); ok(json::object(vec![("generation", args[1].clone())])) }
            "putBackupNote" => { self.notes.insert(s(&args, 1), args[3].clone()); ok(Value::Null) }
            "appendBackupPage" => {
                if self.writer.as_deref() != Some(s(&args, 0).as_str()) { return Err(Server::refuse("BACKUP_WRITER", 409.0)) }
                let backup = self.backup.as_mut().unwrap();
                backup.2.push(s(&args, 2));
                ok(json::object(vec![("index", Value::Number(backup.2.len() as f64 - 1.0))]))
            }
            "startRestore" => { let b = self.backup.as_ref().unwrap(); ok(json::object(vec![("salt", Value::str(&self.salt)), ("keyCheck", Value::str(&b.1)), ("generation", Value::Number(b.0)), ("pageCount", Value::Number(b.2.len() as f64)), ("attemptsLeft", Value::Number(4.0))])) }
            "backupPage" => { let index = match args[0] { Value::Number(n) => n as usize, _ => 0 }; ok(json::object(vec![("body", Value::str(&self.backup.as_ref().unwrap().2[index]))])) }
            _ => panic!("unexpected {op}"),
        }
    }
}

fn entry(n: u32, text: &str) -> Value {
    json::object(vec![("chatId", Value::str(CHAT)), ("senderId", Value::str(USER)), ("clientId", Value::str(&format!("e1000000-0000-4000-8000-{n:012}"))), ("fingerprint", Value::str(&"ab".repeat(32))), ("text", Value::str(text)), ("attachment", Value::Null), ("sentAt", Value::str(&format!("2026-11-{:02}T10:00:00.000Z", n % 28 + 1)))])
}
fn texts(device: &Device) -> Vec<String> { device.history(CHAT, None, None).unwrap().iter().map(|item| item.get("text").and_then(Value::as_str).unwrap()).collect() }

#[test]
fn variant_a_the_new_device_gets_the_old_chats_and_the_server_sees_only_ciphertext() {
    let world: Shared = Rc::default();
    let mut old = device(&world, "A");
    // The old phone holds 300 messages (several pages of the copy).
    let long = "длинный текст сообщения ".repeat(30);
    let items: Vec<Value> = (1..=300).map(|n| entry(n, &format!("{n}: {long}"))).collect();
    assert_eq!(old.history_import(&Value::Array(items)).unwrap().get("imported"), Some(&Value::Number(300.0)));
    let mut fresh = device(&world, "B");
    let mut server = Server::default();
    {
        let mut history = History { crypto: &mut fresh, server: &mut server, cipher: &Cipher };
        assert!(matches!(history.ask().unwrap(), Value::Object(_)));
        assert_eq!(history.ask().unwrap(), Value::Null, "asked once");
        assert_eq!(history.receive(|_, _| {}).unwrap(), Value::Null, "nothing ready yet");
    }
    assert_eq!(History { crypto: &mut old, server: &mut server, cipher: &Cipher }.serve().unwrap(), Value::Null);
    let pages = server.pages.values().next().unwrap().len();
    assert!(pages >= 2, "{pages} pages");
    let mut progress = Vec::new();
    let imported = History { crypto: &mut fresh, server: &mut server, cipher: &Cipher }.receive(|done, total| progress.push((done, total))).unwrap();
    assert_eq!(imported, Value::Number(300.0));
    assert_eq!(progress.len(), pages);
    assert_eq!(texts(&fresh).len(), 300);
    assert_eq!(texts(&fresh), texts(&old));
    assert!(server.pages.is_empty(), "pages deleted after the acknowledgement");
    for value in &server.seen { assert!(!value.contains("длинный текст"), "the server never sees a message") }
}

#[test]
fn variant_b_backup_with_a_secret_made_on_a_device_restored_by_the_typed_secret() {
    let world: Shared = Rc::default();
    let mut old = device(&world, "A");
    old.history_import(&Value::Array((1..=40).map(|n| entry(n, &format!("сообщение {n}"))).collect())).unwrap();
    let mut server = Server { salt: B64.encode([9u8; 32]), ..Server::default() };
    let secret = History { crypto: &mut old, server: &mut server, cipher: &Cipher }.enable().unwrap();
    assert_eq!(history::parse_secret(&secret).as_deref(), Some(secret.as_str()));
    assert!(History { crypto: &mut old, server: &mut server, cipher: &Cipher }.backup().unwrap() >= 1.0);
    assert_eq!(History { crypto: &mut old, server: &mut server, cipher: &Cipher }.backup().unwrap(), 0.0, "nothing new");
    old.history_import(&Value::Array(vec![entry(41, "новое")])).unwrap();
    assert_eq!(History { crypto: &mut old, server: &mut server, cipher: &Cipher }.backup().unwrap(), 1.0, "only what is new");
    for value in &server.seen { assert!(!value.contains("сообщение") && !value.contains(&secret), "neither messages nor the secret reach the server") }

    let mut fresh = device(&world, "B");
    let mut history = History { crypto: &mut fresh, server: &mut server, cipher: &Cipher };
    let typo = format!("{}{}", &secret[..35], if secret.ends_with('A') { "B" } else { "A" });
    assert!(matches!(history.restore(&typo, |_, _| {}), Err(SyncError::Restore(_, None))));
    let other = history::new_backup_secret();
    assert!(matches!(history.restore(&other, |_, _| {}), Err(SyncError::Restore(_, Some(left))) if left == 4.0));
    assert_eq!(history.restore(&history::format_secret(&secret).to_lowercase(), |_, _| {}).unwrap(), 41.0);
    assert_eq!(history.secret(None).unwrap(), Some(secret.clone()), "the restored device holds the secret too");
    assert_eq!(texts(&fresh).len(), 41);
}
