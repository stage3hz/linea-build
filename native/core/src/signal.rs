//! The Signal library for both phone apps: `SignalBridge` on top of the official `libsignal-protocol` crate.
//!
//! A line-by-line port of `mobile/modules/linea-signal/ios/SignalCore.swift` (its twin is `SignalCore.kt`): the
//! same library operations in the same order, the same checks, limits and refusal reasons, and the same state —
//! one JSON object whose records are the library's own serialized bytes in base64 — so that the state an
//! installed app has written opens here and the other way round.
//!
//! Nothing here is cryptography: keys, signatures, sessions, messages and the AES-256-GCM-SIV of `seal` / `open`
//! are all the library's (for the last one, the `aes-gcm-siv` crate the library's own bridge calls). Random
//! numbers come from the operating system's generator, the way the library's bridge takes them.
//!
//! Each call loads an isolated store from the given state and gives back the new state; a failed call gives back
//! nothing, so a half-changed state never escapes. Nothing is kept, written or logged here.

use std::cell::Cell;
use std::collections::BTreeMap;
use std::future::Future;
use std::rc::Rc;
use std::task::{Context, Poll, Waker};
use std::time::{SystemTime, UNIX_EPOCH};

use aes_gcm_siv::{AeadInOut as _, Aes256GcmSiv, KeyInit as _};
use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use libsignal_protocol::{
    kem, message_decrypt_prekey, message_decrypt_signal, message_encrypt, process_prekey_bundle, CiphertextMessageType, DeviceId,
    Direction, GenericSignedPreKey as _, IdentityChange, IdentityKey, IdentityKeyPair, IdentityKeyStore, KeyPair, KyberPreKeyId,
    KyberPreKeyRecord, KyberPreKeyStore, PreKeyBundle, PreKeyId, PreKeyRecord, PreKeySignalMessage, PreKeyStore, ProtocolAddress,
    PublicKey, SenderKeyRecord, SenderKeyStore, SessionRecord, SessionStore, SignalMessage, SignalProtocolError, SignedPreKeyId,
    SignedPreKeyRecord, SignedPreKeyStore, Timestamp,
};
use rand::rngs::OsRng;
use rand::{Rng as _, TryRngCore as _};
use uuid::Uuid;

use crate::e2ee::bridge::{Opened, Sealed, SignalBridge, SignalError};
use crate::json::{self, JsString, Value};

/// The version of the library the state belongs to; a state of another version is refused (`UNSUPPORTED_STATE`).
pub const VERSION: &str = "0.106.0";
pub const MAX_STATE: usize = 16 * 1024 * 1024;
pub const MAX_MESSAGE: usize = 1024 * 1024;
pub const MAX_FILE: usize = 20 * 1024 * 1024;
pub const MAX_PRE_KEYS: usize = 1000;
const MAX_AD: usize = 64 * 1024;
const MAX_SIGNED_KEYS: usize = 64;
const MAX_RECORDS: usize = 10000;
const MAX_KYBER_USED: usize = 50000;
const RECORD_LIMIT: usize = 65536;

/// The Signal library of the phone apps. It keeps nothing: every call takes the state and gives back the new one.
pub struct LibSignal;

/// Why a call was refused.
#[derive(Debug)]
enum Failure {
    /// A check of the bridge itself, with the reason the apps already know (`TRUST_REQUIRED`, `STATE_CAPACITY`, …).
    Reason(&'static str),
    /// The library said no.
    Library(SignalProtocolError),
    /// Anything else the Swift bridge does not name (a state that is not the expected JSON, a failed file tag).
    Other,
}
type Outcome<T> = Result<T, Failure>;

impl From<SignalProtocolError> for Failure {
    fn from(error: SignalProtocolError) -> Self { Failure::Library(error) }
}

/// The name the official Node binding gives a library error (`rust/bridge/shared/types/src/node/error.rs`).
fn library_name(error: &SignalProtocolError) -> &'static str {
    match error {
        SignalProtocolError::DuplicatedMessage(..) => "DuplicatedMessage",
        SignalProtocolError::SealedSenderSelfSend => "SealedSenderSelfSend",
        SignalProtocolError::UntrustedIdentity(..) => "UntrustedIdentity",
        SignalProtocolError::InvalidRegistrationId(..) => "InvalidRegistrationId",
        SignalProtocolError::InvalidProtocolAddress { .. } => "InvalidProtocolAddress",
        SignalProtocolError::InvalidSessionStructure(..) => "InvalidSession",
        SignalProtocolError::InvalidSenderKeySession { .. } => "InvalidSenderKeySession",
        _ => "LibSignalError",
    }
}

/// A refusal as the apps see it.
///
/// A check of the bridge reads exactly as the Swift and Kotlin modules report it: code `ERR_LINEA_SIGNAL_<reason>`,
/// message `Signal operation rejected: <reason>`. A refusal by the library keeps the code those modules give it
/// (`ERR_LINEA_SIGNAL_CRYPTO_FAILED`) and carries the library's own name and words the way the official Node
/// binding does, so a lost or expired session reads as «session … not found» and an untrusted key as
/// «untrusted identity …» — which is what the logic around encryption tells apart.
impl From<Failure> for SignalError {
    fn from(failure: Failure) -> Self {
        let rejected = |reason: &str| SignalError { name: "Error".to_string(), code: format!("ERR_LINEA_SIGNAL_{reason}"), message: format!("Signal operation rejected: {reason}") };
        match failure {
            Failure::Reason(reason) => rejected(reason),
            Failure::Other => rejected("CRYPTO_FAILED"),
            Failure::Library(error) => SignalError { name: library_name(&error).to_string(), code: "ERR_LINEA_SIGNAL_CRYPTO_FAILED".to_string(), message: error.to_string() },
        }
    }
}

fn require(condition: bool, reason: &'static str) -> Outcome<()> {
    if condition { Ok(()) } else { Err(Failure::Reason(reason)) }
}

/// The operating system's generator, taken the way the library's own bridge takes it.
fn os_rng() -> impl rand::CryptoRng {
    OsRng.unwrap_err()
}

/// Runs a library call to its end. The stores below answer at once, so the call never has to wait.
fn finish<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    match future.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(output) => output,
        Poll::Pending => unreachable!("the stores answer at once"),
    }
}

fn valid_name(name: &str) -> bool {
    (1..=160).contains(&name.len()) && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}
fn address(name: &str, device_id: i64) -> Outcome<ProtocolAddress> {
    require(device_id == 1 && valid_name(name), "INVALID_ADDRESS")?;
    Ok(ProtocolAddress::new(name.to_string(), DeviceId::try_from(1u32).map_err(|_| Failure::Reason("INVALID_ADDRESS"))?))
}
fn encode(bytes: &[u8]) -> String { STANDARD.encode(bytes) }
/// Canonical base64 of at most `limit` bytes.
fn decode(value: &str, limit: usize) -> Outcome<Vec<u8>> {
    require(value.len() <= ((limit + 2) / 3) * 4 && value.len() % 4 == 0, "INVALID_BASE64")?;
    let data = STANDARD.decode(value).map_err(|_| Failure::Reason("INVALID_BASE64"))?;
    require(data.len() <= limit && encode(&data) == value, "INVALID_BASE64")?;
    Ok(data)
}
fn string(object: &Value, key: &str) -> Outcome<String> {
    match object.get(key) { Some(Value::String(text)) => Ok(text.to_string_lossy()), _ => Err(Failure::Reason("INVALID_FIELD")) }
}
fn integer(object: &Value, key: &str, max: f64) -> Outcome<u32> {
    let Some(Value::Number(number)) = object.get(key) else { return Err(Failure::Reason("INVALID_NUMBER")) };
    require(number.is_finite() && *number >= 1.0 && *number <= max && number.round() == *number, "INVALID_NUMBER")?;
    Ok(*number as u32)
}
const INT32_MAX: f64 = i32::MAX as f64;
fn object<'a>(value: &'a Value, key: &str) -> Outcome<&'a Value> {
    match value.get(key) { Some(found @ Value::Object(_)) => Ok(found), _ => Err(Failure::Reason("INVALID_FIELD")) }
}

// ── The five calls ────────────────────────────────────────────────────────────────────────────────────────────

fn create_state(local_address_name: &str, device_id: i64) -> Outcome<(String, Value)> {
    address(local_address_name, device_id)?;
    let mut rng = os_rng();
    let identity = IdentityKeyPair::generate(&mut rng);
    // The registration id is a public protocol identifier, not private key material.
    let registration: u32 = rng.random_range(1..=16380);
    let mut store = Store::new(Head {
        version: 1, libsignal_version: VERSION.to_string(), local_address_name: local_address_name.to_string(), local_device_id: device_id,
        identity_key_pair: encode(&identity.serialize()), registration_id: registration, next_pre_key_id: 1, signed_pre_key_id: 1, kyber_pre_key_id: 1,
    }, Records::default())?;
    let timestamp = Timestamp::from_epoch_millis(SystemTime::now().duration_since(UNIX_EPOCH).map(|since| since.as_millis() as u64).unwrap_or(0));
    let signed_key = KeyPair::generate(&mut rng);
    let signature = identity.private_key().calculate_signature(&signed_key.public_key.serialize(), &mut rng).map_err(SignalProtocolError::from)?;
    let signed = SignedPreKeyRecord::new(SignedPreKeyId::from(1), timestamp, &signed_key, &signature);
    store.signed.store(1, &signed)?;
    let kyber_key = kem::KeyPair::generate(kem::KeyType::Kyber1024, &mut rng);
    let signature = identity.private_key().calculate_signature(&kyber_key.public_key.serialize(), &mut rng).map_err(SignalProtocolError::from)?;
    let kyber = KyberPreKeyRecord::new(KyberPreKeyId::from(1), timestamp, &kyber_key, &signature);
    store.kyber.store(1, &kyber)?;
    generated(store, 20)
}

fn replenish(state: &str, count: u32) -> Outcome<(String, Value)> {
    generated(Store::parse(state)?, count)
}

fn generated(mut store: Store, count: u32) -> Outcome<(String, Value)> {
    require((1..=100).contains(&count), "INVALID_PREKEY_COUNT")?;
    require(store.pre_keys.records.len() + count as usize <= MAX_PRE_KEYS, "PREKEY_CAPACITY")?;
    let first = store.head.next_pre_key_id;
    require(first >= 1 && first <= i32::MAX as u32 - count, "PREKEY_ID_EXHAUSTED")?;
    let mut rng = os_rng();
    let mut fresh = Vec::new();
    for id in first..first + count {
        let record = PreKeyRecord::new(PreKeyId::from(id), &KeyPair::generate(&mut rng));
        store.pre_keys.store(id, &record)?;
        fresh.push(json::object(vec![("id", Value::Number(id as f64)), ("publicKey", Value::str(&encode(&record.public_key()?.serialize())))]));
    }
    store.head.next_pre_key_id = first + count;
    Ok((store.export()?, public_bundle(&store, fresh)?))
}

fn public_bundle(store: &Store, fresh: Vec<Value>) -> Outcome<Value> {
    let signed = store.signed.load(store.head.signed_pre_key_id)?;
    let kyber = store.kyber.load(store.head.kyber_pre_key_id)?;
    Ok(json::object(vec![
        ("registrationId", Value::Number(store.head.registration_id as f64)),
        ("identityKey", Value::str(&encode(&store.identity.pair.identity_key().serialize()))),
        ("signedPreKey", json::object(vec![
            ("id", Value::Number(u32::from(signed.id()?) as f64)),
            ("publicKey", Value::str(&encode(&signed.public_key()?.serialize()))),
            ("signature", Value::str(&encode(&signed.signature()?))),
        ])),
        ("kyberPreKey", json::object(vec![
            ("id", Value::Number(u32::from(kyber.id()?) as f64)),
            ("publicKey", Value::str(&encode(&kyber.public_key()?.serialize()))),
            ("signature", Value::str(&encode(&kyber.signature()?))),
        ])),
        ("preKeys", Value::Array(fresh)),
    ]))
}

fn trust_identity(state: &str, name: &str, device_id: i64, public_key: &str) -> Outcome<String> {
    let mut store = Store::parse(state)?;
    let data = decode(public_key, 33)?;
    require(data.len() == 33, "INVALID_IDENTITY")?;
    let identity = IdentityKey::decode(&data)?;
    store.identity.pin(&identity, &address(name, device_id)?)?;
    store.export()
}

fn encrypt(state: &str, name: &str, device_id: i64, plaintext: &str, bundle: Option<&Value>) -> Outcome<Sealed> {
    let mut store = Store::parse(state)?;
    let remote = address(name, device_id)?;
    require(store.identity.identity(&remote)?.is_some(), "TRUST_REQUIRED")?;
    let bytes = plaintext.as_bytes();
    require(bytes.len() <= MAX_MESSAGE, "MESSAGE_TOO_LARGE")?;
    let mut rng = os_rng();
    if let Some(bundle) = bundle {
        let pre_keys = remote_bundle(bundle, device_id)?;
        require(store.identity.trusted(pre_keys.identity_key()?, &remote)?, "IDENTITY_CHANGED")?;
        // The caller passes a bundle only when it wants a fresh session: there is none yet, or it decided to
        // rekey (the peer's device could not open our messages, or its identity changed). A live session must
        // not swallow the bundle: archive its chain first, then start the new session, so this message leaves
        // as a PreKey message (type 3). Same contract as the Swift, Kotlin and Node bridges.
        if let Some(mut current) = store.sessions.load(&remote)? {
            current.archive_current_state()?;
            store.sessions.store(&remote, &current)?;
        }
        let result = finish(process_prekey_bundle(&remote, &store.local_address, &mut store.sessions, &mut store.identity, &pre_keys, SystemTime::now(), &mut rng));
        store.settle(result)?;
    }
    let result = finish(message_encrypt(bytes, &remote, &store.local_address, &mut store.sessions, &mut store.identity, SystemTime::now(), &mut rng));
    let cipher = store.settle(result)?;
    let kind = match cipher.message_type() { CiphertextMessageType::Whisper => 2.0, CiphertextMessageType::PreKey => 3.0, _ => return Err(Failure::Reason("UNSUPPORTED_MESSAGE_TYPE")) };
    Ok(Sealed { state: store.export()?, kind, body: encode(cipher.serialize()) })
}

fn decrypt(state: &str, name: &str, device_id: i64, kind: f64, body: &str) -> Outcome<Opened> {
    let mut store = Store::parse(state)?;
    let remote = address(name, device_id)?;
    require(store.identity.identity(&remote)?.is_some(), "TRUST_REQUIRED")?;
    let bytes = decode(body, MAX_MESSAGE + 64 * 1024)?;
    let mut rng = os_rng();
    let plaintext = if kind == 2.0 {
        let message = SignalMessage::try_from(bytes.as_slice())?;
        let result = finish(message_decrypt_signal(&message, &remote, &store.local_address, &mut store.sessions, &mut store.identity, &mut rng));
        store.settle(result)?
    } else if kind == 3.0 {
        let message = PreKeySignalMessage::try_from(bytes.as_slice())?;
        let result = finish(message_decrypt_prekey(&message, &remote, &store.local_address, &mut store.sessions, &mut store.identity, &mut store.pre_keys, &store.signed, &mut store.kyber, &mut rng));
        store.settle(result)?.plaintext
    } else {
        return Err(Failure::Reason("UNSUPPORTED_MESSAGE_TYPE"));
    };
    require(plaintext.len() <= MAX_MESSAGE, "MESSAGE_TOO_LARGE")?;
    let text = String::from_utf8(plaintext).map_err(|_| Failure::Reason("INVALID_TEXT"))?;
    Ok(Opened { state: store.export()?, plaintext: text })
}

/// The other device's claimed bundle (`ClaimedBundle` of the reference), every field checked before the library sees it.
fn remote_bundle(bundle: &Value, device_id: i64) -> Outcome<PreKeyBundle> {
    let signed = object(bundle, "signedPreKey")?;
    let kyber = object(bundle, "kyberPreKey")?;
    let identity_bytes = decode(&string(bundle, "identityKey")?, 33)?;
    require(identity_bytes.len() == 33, "INVALID_IDENTITY")?;
    let identity = IdentityKey::decode(&identity_bytes)?;
    let ec = |key: &Value| -> Outcome<PublicKey> {
        let data = decode(&string(key, "publicKey")?, 33)?;
        require(data.len() == 33, "INVALID_PUBLIC_KEY")?;
        Ok(PublicKey::deserialize(&data).map_err(SignalProtocolError::from)?)
    };
    let signature = |key: &Value| -> Outcome<Vec<u8>> {
        let data = decode(&string(key, "signature")?, 64)?;
        require(data.len() == 64, "INVALID_SIGNATURE")?;
        Ok(data)
    };
    let registration = integer(bundle, "registrationId", 16383.0)?;
    let (signed_id, signed_public, signed_signature) = (integer(signed, "id", INT32_MAX)?, ec(signed)?, signature(signed)?);
    let kyber_id = integer(kyber, "id", INT32_MAX)?;
    let kyber_public = kem::PublicKey::deserialize(&decode(&string(kyber, "publicKey")?, 8192)?)?;
    let kyber_signature = signature(kyber)?;
    let pre_key = match bundle.get("preKey") {
        Some(pre_key @ Value::Object(_)) => Some((PreKeyId::from(integer(pre_key, "id", INT32_MAX)?), ec(pre_key)?)),
        _ => None,
    };
    let device = DeviceId::try_from(device_id as u32).map_err(|error| SignalProtocolError::InvalidArgument(error.to_string()))?;
    Ok(PreKeyBundle::new(registration, device, pre_key, SignedPreKeyId::from(signed_id), signed_public, signed_signature, KyberPreKeyId::from(kyber_id), kyber_public, kyber_signature, identity)?)
}

// ── File encryption ───────────────────────────────────────────────────────────────────────────────────────────

fn cipher(key: &str, nonce: &str) -> Outcome<(Aes256GcmSiv, aes_gcm_siv::Nonce)> {
    let (key_bytes, nonce_bytes) = (decode(key, 32)?, decode(nonce, 12)?);
    require(key_bytes.len() == 32 && nonce_bytes.len() == 12, "INVALID_KEY_OR_NONCE")?;
    let cipher = Aes256GcmSiv::new_from_slice(&key_bytes).map_err(|_| Failure::Other)?;
    let nonce = aes_gcm_siv::Nonce::try_from(nonce_bytes.as_slice()).map_err(|_| Failure::Other)?;
    Ok((cipher, nonce))
}

/// Encrypts a file's bytes (AES-256-GCM-SIV, the library's own). Everything is base64: the plaintext (at most
/// 20 MiB), the 32-byte key, the 12-byte nonce and the associated data (at most 64 KiB); so is the answer, the
/// ciphertext with its 16-byte tag.
pub fn seal(plaintext: &str, key: &str, nonce: &str, ad: &str) -> Result<String, SignalError> {
    let sealed = || -> Outcome<String> {
        let (cipher, nonce) = cipher(key, nonce)?;
        let mut buffer = decode(plaintext, MAX_FILE)?;
        let ad = decode(ad, MAX_AD)?;
        buffer.reserve(16);
        cipher.encrypt_in_place(&nonce, &ad, &mut buffer).map_err(|_| Failure::Other)?;
        Ok(encode(&buffer))
    };
    sealed().map_err(SignalError::from)
}

/// Opens what `seal` made; a wrong key, nonce, associated data or a changed byte is refused.
pub fn open(ciphertext: &str, key: &str, nonce: &str, ad: &str) -> Result<String, SignalError> {
    let opened = || -> Outcome<String> {
        let (cipher, nonce) = cipher(key, nonce)?;
        let mut buffer = decode(ciphertext, MAX_FILE + 16)?;
        require(buffer.len() >= 16, "INVALID_CIPHERTEXT")?;
        let ad = decode(ad, MAX_AD)?;
        cipher.decrypt_in_place(&nonce, &ad, &mut buffer).map_err(|_| Failure::Other)?;
        Ok(encode(&buffer))
    };
    opened().map_err(SignalError::from)
}

// ── The state ─────────────────────────────────────────────────────────────────────────────────────────────────

/// The plain fields of `PersistentSignalState`.
struct Head {
    version: i64,
    libsignal_version: String,
    local_address_name: String,
    local_device_id: i64,
    identity_key_pair: String,
    registration_id: u32,
    next_pre_key_id: u32,
    signed_pre_key_id: u32,
    kyber_pre_key_id: u32,
}

type Map = BTreeMap<String, String>;

/// The record tables of `PersistentSignalState`: name → the library's serialized record in base64.
#[derive(Default)]
struct Records {
    pre_keys: Map,
    signed_pre_keys: Map,
    kyber_pre_keys: Map,
    sessions: Map,
    trusted_identities: Map,
    kyber_used: BTreeMap<String, bool>,
    sender_keys: Map,
}

/// A refusal of the bridge made inside a library call. The library reports it as a failed callback; the reason
/// is kept here and given back in its place, as the Swift binding rethrows the store's own error.
type Refusal = Rc<Cell<Option<&'static str>>>;

#[derive(Debug)]
struct Refused(&'static str);
impl std::fmt::Display for Refused {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { formatter.write_str(self.0) }
}
impl std::error::Error for Refused {}

/// One table with its limits.
struct Table {
    records: Map,
    cap: usize,
    limit: usize,
    refusal: Refusal,
}
impl Table {
    fn read(&self, key: &str) -> Outcome<Option<Vec<u8>>> {
        match self.records.get(key) { None => Ok(None), Some(value) => decode(value, self.limit).map(Some) }
    }
    fn save(&mut self, key: String, data: &[u8]) -> Outcome<()> {
        require(self.records.contains_key(&key) || self.records.len() < self.cap, "STATE_CAPACITY")?;
        self.records.insert(key, encode(data));
        Ok(())
    }
    /// What the library is told when a store call fails.
    fn told(&self, failure: Failure) -> SignalProtocolError {
        told(&self.refusal, failure)
    }
}
fn told(refusal: &Refusal, failure: Failure) -> SignalProtocolError {
    match failure {
        Failure::Library(error) => error,
        Failure::Reason(reason) => {
            refusal.set(Some(reason));
            SignalProtocolError::ApplicationCallbackError("store", Box::new(Refused(reason)))
        }
        Failure::Other => SignalProtocolError::ApplicationCallbackError("store", Box::new(Refused("CRYPTO_FAILED"))),
    }
}
fn key(address: &ProtocolAddress) -> String { format!("{}#{}", address.name(), address.device_id()) }

struct Identities { pair: IdentityKeyPair, registration_id: u32, table: Table }
struct PreKeys(Table);
struct SignedPreKeys(Table);
struct KyberPreKeys { table: Table, used: BTreeMap<String, bool> }
struct Sessions(Table);
struct SenderKeys(Table);

impl std::ops::Deref for PreKeys { type Target = Table; fn deref(&self) -> &Table { &self.0 } }

impl Identities {
    fn identity(&self, address: &ProtocolAddress) -> Outcome<Option<IdentityKey>> {
        match self.table.read(&key(address))? { None => Ok(None), Some(bytes) => Ok(Some(IdentityKey::decode(&bytes)?)) }
    }
    /// Only a key the person has approved is trusted, in both directions: nothing is trusted on first use.
    fn trusted(&self, identity: &IdentityKey, address: &ProtocolAddress) -> Outcome<bool> {
        Ok(self.identity(address)?.map(|known| known == *identity).unwrap_or(false))
    }
    fn pin(&mut self, identity: &IdentityKey, address: &ProtocolAddress) -> Outcome<()> {
        if let Some(existing) = self.identity(address)? { require(existing == *identity, "IDENTITY_CHANGED")? }
        self.table.save(key(address), &identity.serialize())
    }
}
impl PreKeys {
    fn store(&mut self, id: u32, record: &PreKeyRecord) -> Outcome<()> { let data = record.serialize()?; self.0.save(id.to_string(), &data) }
    fn load(&self, id: u32) -> Outcome<PreKeyRecord> {
        match self.0.read(&id.to_string())? { None => Err(SignalProtocolError::InvalidPreKeyId.into()), Some(bytes) => Ok(PreKeyRecord::deserialize(&bytes)?) }
    }
}
impl SignedPreKeys {
    fn store(&mut self, id: u32, record: &SignedPreKeyRecord) -> Outcome<()> { let data = record.serialize()?; self.0.save(id.to_string(), &data) }
    fn load(&self, id: u32) -> Outcome<SignedPreKeyRecord> {
        match self.0.read(&id.to_string())? { None => Err(SignalProtocolError::InvalidSignedPreKeyId.into()), Some(bytes) => Ok(SignedPreKeyRecord::deserialize(&bytes)?) }
    }
}
impl KyberPreKeys {
    fn store(&mut self, id: u32, record: &KyberPreKeyRecord) -> Outcome<()> { let data = record.serialize()?; self.table.save(id.to_string(), &data) }
    fn load(&self, id: u32) -> Outcome<KyberPreKeyRecord> {
        match self.table.read(&id.to_string())? { None => Err(SignalProtocolError::InvalidKyberPreKeyId.into()), Some(bytes) => Ok(KyberPreKeyRecord::deserialize(&bytes)?) }
    }
    /// The Kyber prekey is the reusable last-resort one: it stays, and the use is remembered for good, so the
    /// same opening message cannot start a session twice.
    fn mark_used(&mut self, id: u32, signed_pre_key_id: u32, base_key: &PublicKey) -> Outcome<()> {
        self.load(id)?;
        let tuple = format!("{id}:{signed_pre_key_id}:{}", encode(&base_key.serialize()));
        require(!self.used.contains_key(&tuple), "REUSED_BASE_KEY")?;
        require(self.used.len() < MAX_KYBER_USED, "REPLAY_RECORD_CAPACITY")?;
        self.used.insert(tuple, true);
        Ok(())
    }
}
impl Sessions {
    fn load(&self, address: &ProtocolAddress) -> Outcome<Option<SessionRecord>> {
        match self.0.read(&key(address))? { None => Ok(None), Some(bytes) => Ok(Some(SessionRecord::deserialize(&bytes)?)) }
    }
    fn store(&mut self, address: &ProtocolAddress, record: &SessionRecord) -> Outcome<()> { let data = record.serialize()?; self.0.save(key(address), &data) }
}

#[async_trait(?Send)]
impl IdentityKeyStore for Identities {
    async fn get_identity_key_pair(&self) -> Result<IdentityKeyPair, SignalProtocolError> { Ok(self.pair) }
    async fn get_local_registration_id(&self) -> Result<u32, SignalProtocolError> { Ok(self.registration_id) }
    async fn save_identity(&mut self, address: &ProtocolAddress, identity: &IdentityKey) -> Result<IdentityChange, SignalProtocolError> {
        let trusted = self.trusted(identity, address).map_err(|failure| self.table.told(failure))?;
        require(trusted, "IDENTITY_CHANGED").map_err(|failure| self.table.told(failure))?;
        Ok(IdentityChange::NewOrUnchanged)
    }
    async fn is_trusted_identity(&self, address: &ProtocolAddress, identity: &IdentityKey, _direction: Direction) -> Result<bool, SignalProtocolError> {
        self.trusted(identity, address).map_err(|failure| self.table.told(failure))
    }
    async fn get_identity(&self, address: &ProtocolAddress) -> Result<Option<IdentityKey>, SignalProtocolError> {
        self.identity(address).map_err(|failure| self.table.told(failure))
    }
}
#[async_trait(?Send)]
impl PreKeyStore for PreKeys {
    async fn get_pre_key(&self, id: PreKeyId) -> Result<PreKeyRecord, SignalProtocolError> { self.load(id.into()).map_err(|failure| self.0.told(failure)) }
    async fn save_pre_key(&mut self, id: PreKeyId, record: &PreKeyRecord) -> Result<(), SignalProtocolError> { self.store(id.into(), record).map_err(|failure| self.0.told(failure)) }
    async fn remove_pre_key(&mut self, id: PreKeyId) -> Result<(), SignalProtocolError> { self.0.records.remove(&u32::from(id).to_string()); Ok(()) }
}
#[async_trait(?Send)]
impl SignedPreKeyStore for SignedPreKeys {
    async fn get_signed_pre_key(&self, id: SignedPreKeyId) -> Result<SignedPreKeyRecord, SignalProtocolError> { self.load(id.into()).map_err(|failure| self.0.told(failure)) }
    async fn save_signed_pre_key(&mut self, id: SignedPreKeyId, record: &SignedPreKeyRecord) -> Result<(), SignalProtocolError> { self.store(id.into(), record).map_err(|failure| self.0.told(failure)) }
}
#[async_trait(?Send)]
impl KyberPreKeyStore for KyberPreKeys {
    async fn get_kyber_pre_key(&self, id: KyberPreKeyId) -> Result<KyberPreKeyRecord, SignalProtocolError> { self.load(id.into()).map_err(|failure| self.table.told(failure)) }
    async fn save_kyber_pre_key(&mut self, id: KyberPreKeyId, record: &KyberPreKeyRecord) -> Result<(), SignalProtocolError> { self.store(id.into(), record).map_err(|failure| self.table.told(failure)) }
    async fn mark_kyber_pre_key_used(&mut self, id: KyberPreKeyId, signed_pre_key_id: SignedPreKeyId, base_key: &PublicKey) -> Result<(), SignalProtocolError> {
        self.mark_used(id.into(), signed_pre_key_id.into(), base_key).map_err(|failure| self.table.told(failure))
    }
}
#[async_trait(?Send)]
impl SessionStore for Sessions {
    async fn load_session(&self, address: &ProtocolAddress) -> Result<Option<SessionRecord>, SignalProtocolError> { self.load(address).map_err(|failure| self.0.told(failure)) }
    async fn store_session(&mut self, address: &ProtocolAddress, record: &SessionRecord) -> Result<(), SignalProtocolError> { self.store(address, record).map_err(|failure| self.0.told(failure)) }
}
/// Group sender keys: part of the state's format, not used by the app's one-to-one sessions.
#[async_trait(?Send)]
impl SenderKeyStore for SenderKeys {
    async fn store_sender_key(&mut self, sender: &ProtocolAddress, distribution_id: Uuid, record: &SenderKeyRecord) -> Result<(), SignalProtocolError> {
        let data = record.serialize()?;
        self.0.save(format!("{}:{}", key(sender), distribution_id.as_hyphenated()), &data).map_err(|failure| self.0.told(failure))
    }
    async fn load_sender_key(&mut self, sender: &ProtocolAddress, distribution_id: Uuid) -> Result<Option<SenderKeyRecord>, SignalProtocolError> {
        match self.0.read(&format!("{}:{}", key(sender), distribution_id.as_hyphenated())).map_err(|failure| self.0.told(failure))? {
            None => Ok(None),
            Some(bytes) => Ok(Some(SenderKeyRecord::deserialize(&bytes)?)),
        }
    }
}

/// `SignalStateStore`: the state loaded for one call. The library takes its stores one by one, so each table is
/// its own store.
struct Store {
    head: Head,
    local_address: ProtocolAddress,
    identity: Identities,
    pre_keys: PreKeys,
    signed: SignedPreKeys,
    kyber: KyberPreKeys,
    sessions: Sessions,
    sender_keys: SenderKeys,
    refusal: Refusal,
}

impl Store {
    fn new(head: Head, records: Records) -> Outcome<Store> {
        require(head.version == 1 && head.libsignal_version == VERSION, "UNSUPPORTED_STATE")?;
        require((1..=16383).contains(&head.registration_id), "INVALID_REGISTRATION")?;
        require(records.pre_keys.len() <= MAX_PRE_KEYS && records.signed_pre_keys.len() <= MAX_SIGNED_KEYS && records.kyber_pre_keys.len() <= MAX_SIGNED_KEYS, "KEY_CAPACITY")?;
        require(records.sessions.len() <= MAX_RECORDS && records.trusted_identities.len() <= MAX_RECORDS && records.kyber_used.len() <= MAX_KYBER_USED, "STATE_CAPACITY")?;
        let pair = IdentityKeyPair::try_from(decode(&head.identity_key_pair, 256)?.as_slice())?;
        let local_address = address(&head.local_address_name, head.local_device_id)?;
        let refusal: Refusal = Rc::new(Cell::new(None));
        let table = |records: Map, cap: usize, limit: usize| Table { records, cap, limit, refusal: refusal.clone() };
        Ok(Store {
            identity: Identities { pair, registration_id: head.registration_id, table: table(records.trusted_identities, MAX_RECORDS, 33) },
            pre_keys: PreKeys(table(records.pre_keys, MAX_PRE_KEYS, RECORD_LIMIT)),
            signed: SignedPreKeys(table(records.signed_pre_keys, MAX_SIGNED_KEYS, RECORD_LIMIT)),
            kyber: KyberPreKeys { table: table(records.kyber_pre_keys, MAX_SIGNED_KEYS, RECORD_LIMIT), used: records.kyber_used },
            sessions: Sessions(table(records.sessions, MAX_RECORDS, MAX_MESSAGE)),
            sender_keys: SenderKeys(table(records.sender_keys, MAX_RECORDS, RECORD_LIMIT)),
            head, local_address, refusal,
        })
    }

    /// Reads the state the way Swift's `JSONDecoder` reads `PersistentSignalState`: every field must be there
    /// with its own type, a field it does not know is passed over.
    fn parse(text: &str) -> Outcome<Store> {
        require(text.len() <= MAX_STATE, "STATE_TOO_LARGE")?;
        let state = json::parse(text).map_err(|_| Failure::Other)?;
        if !matches!(state, Value::Object(_)) { return Err(Failure::Other) }
        let field = |name: &str| state.get(name).ok_or(Failure::Other);
        let whole = |name: &str, max: f64| -> Outcome<f64> {
            match field(name)? { Value::Number(number) if number.is_finite() && number.fract() == 0.0 && *number >= 0.0f64.min(-max) && *number <= max => Ok(*number), _ => Err(Failure::Other) }
        };
        let signed_whole = |name: &str| -> Outcome<i64> {
            match field(name)? { Value::Number(number) if number.is_finite() && number.fract() == 0.0 && number.abs() < 9.2e18 => Ok(*number as i64), _ => Err(Failure::Other) }
        };
        let unsigned = |name: &str| -> Outcome<u32> {
            let number = whole(name, u32::MAX as f64)?;
            if number < 0.0 { Err(Failure::Other) } else { Ok(number as u32) }
        };
        let text_of = |name: &str| -> Outcome<String> {
            match field(name)? { Value::String(text) => Ok(text.to_string_lossy()), _ => Err(Failure::Other) }
        };
        let table = |name: &str| -> Outcome<Map> {
            let Value::Object(entries) = field(name)? else { return Err(Failure::Other) };
            entries.iter().map(|(key, value)| match value { Value::String(text) => Ok((key.to_string_lossy(), text.to_string_lossy())), _ => Err(Failure::Other) }).collect()
        };
        let flags = |name: &str| -> Outcome<BTreeMap<String, bool>> {
            let Value::Object(entries) = field(name)? else { return Err(Failure::Other) };
            entries.iter().map(|(key, value)| match value { Value::Bool(flag) => Ok((key.to_string_lossy(), *flag)), _ => Err(Failure::Other) }).collect()
        };
        let head = Head {
            version: signed_whole("version")?, libsignal_version: text_of("libsignalVersion")?, local_address_name: text_of("localAddressName")?,
            local_device_id: signed_whole("localDeviceId")?, identity_key_pair: text_of("identityKeyPair")?, registration_id: unsigned("registrationId")?,
            next_pre_key_id: unsigned("nextPreKeyId")?, signed_pre_key_id: unsigned("signedPreKeyId")?, kyber_pre_key_id: unsigned("kyberPreKeyId")?,
        };
        let records = Records {
            pre_keys: table("preKeys")?, signed_pre_keys: table("signedPreKeys")?, kyber_pre_keys: table("kyberPreKeys")?, sessions: table("sessions")?,
            trusted_identities: table("trustedIdentities")?, kyber_used: flags("kyberUsed")?, sender_keys: table("senderKeys")?,
        };
        Store::new(head, records)
    }

    /// Writes the state with its keys in order, as the Swift exporter does.
    fn export(&self) -> Outcome<String> {
        let name = |text: &str| JsString::from_str(text);
        let table = |map: &Map| Value::Object(map.iter().map(|(key, value)| (name(key), Value::str(value))).collect());
        let number = |value: f64| Value::Number(value);
        let state = Value::Object(vec![
            (name("identityKeyPair"), Value::str(&self.head.identity_key_pair)),
            (name("kyberPreKeyId"), number(self.head.kyber_pre_key_id as f64)),
            (name("kyberPreKeys"), table(&self.kyber.table.records)),
            (name("kyberUsed"), Value::Object(self.kyber.used.iter().map(|(key, flag)| (name(key), Value::Bool(*flag))).collect())),
            (name("libsignalVersion"), Value::str(&self.head.libsignal_version)),
            (name("localAddressName"), Value::str(&self.head.local_address_name)),
            (name("localDeviceId"), number(self.head.local_device_id as f64)),
            (name("nextPreKeyId"), number(self.head.next_pre_key_id as f64)),
            (name("preKeys"), table(&self.pre_keys.0.records)),
            (name("registrationId"), number(self.head.registration_id as f64)),
            (name("senderKeys"), table(&self.sender_keys.0.records)),
            (name("sessions"), table(&self.sessions.0.records)),
            (name("signedPreKeyId"), number(self.head.signed_pre_key_id as f64)),
            (name("signedPreKeys"), table(&self.signed.0.records)),
            (name("trustedIdentities"), table(&self.identity.table.records)),
            (name("version"), number(self.head.version as f64)),
        ]);
        let text = json::stringify(&state);
        require(text.len() <= MAX_STATE, "STATE_TOO_LARGE")?;
        Ok(text)
    }

    /// The end of a library call: a refusal the bridge made inside it comes back as itself.
    fn settle<T>(&self, result: Result<T, SignalProtocolError>) -> Outcome<T> {
        let refusal = self.refusal.take();
        match result {
            Ok(value) => Ok(value),
            Err(SignalProtocolError::ApplicationCallbackError(..)) if refusal.is_some() => Err(Failure::Reason(refusal.expect("checked"))),
            Err(error) => Err(Failure::Library(error)),
        }
    }
}

impl SignalBridge for LibSignal {
    fn create_state(&mut self, local_address: &str, device_id: u32) -> Result<(String, Value), SignalError> {
        Ok(create_state(local_address, device_id as i64)?)
    }
    fn replenish(&mut self, state: &str, count: u32) -> Result<(String, Value), SignalError> {
        Ok(replenish(state, count)?)
    }
    fn trust_identity(&mut self, state: &str, address: &str, device_id: u32, identity_key: &str) -> Result<String, SignalError> {
        Ok(trust_identity(state, address, device_id as i64, identity_key)?)
    }
    fn encrypt(&mut self, state: &str, address: &str, device_id: u32, plaintext: &str, bundle: Option<&Value>) -> Result<Sealed, SignalError> {
        Ok(encrypt(state, address, device_id as i64, plaintext, bundle)?)
    }
    fn decrypt(&mut self, state: &str, address: &str, device_id: u32, kind: f64, body: &str) -> Result<Opened, SignalError> {
        Ok(decrypt(state, address, device_id as i64, kind, body)?)
    }
}
