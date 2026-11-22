//! The core as the apps call it: plain C functions (Swift and Kotlin both speak C).
//!
//! Text goes in and comes out as NUL-terminated UTF-8. Every text the core hands out is the core's own and
//! must be given back with `invizent_string_free`. Structured values travel as JSON. A function that cannot
//! answer gives a null pointer; nothing here ever unwinds across the boundary.

use crate::e2ee::bridge::{CryptoTransport, Env, Opened, Sealed, SignalBridge, SignalError, TransportError, Vault};
use crate::e2ee::dispatch::dispatch;
use crate::e2ee::service::Crypto;
use crate::e2ee::wire::{safety_code, DeviceIdentity};
use crate::json::{self, Value};
use std::ffi::{c_char, c_void, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Mutex;

fn give(text: String) -> *mut c_char { CString::new(text).map_or(std::ptr::null_mut(), CString::into_raw) }

/// # Safety
/// `text` is null or a NUL-terminated string that stays valid for the call.
unsafe fn take(text: *const c_char) -> Option<String> {
    if text.is_null() { return None }
    CStr::from_ptr(text).to_str().ok().map(str::to_string)
}

/// The version of the core, e.g. `0.1.0`.
#[no_mangle]
pub extern "C" fn invizent_core_version() -> *mut c_char { give(env!("CARGO_PKG_VERSION").to_string()) }

fn device(value: Option<&Value>) -> Option<DeviceIdentity> {
    let value = value?;
    let Some(Value::Number(registration_id)) = value.get("registrationId") else { return None };
    Some(DeviceIdentity { user_id: value.get("userId")?.as_str()?, device_id: value.get("deviceId")?.as_str()?, identity_key: value.get("identityKey")?.as_str()?, registration_id: *registration_id })
}

/// The safety code two people compare for a pair of devices.
/// In: `{"own":{"userId","deviceId","identityKey","registrationId"},"other":{…}}`. Out: the code, or null.
///
/// # Safety
/// `pair_json` is null or a NUL-terminated string that stays valid for the call.
#[no_mangle]
pub unsafe extern "C" fn invizent_safety_code(pair_json: *const c_char) -> *mut c_char {
    let Some(text) = take(pair_json) else { return std::ptr::null_mut() };
    catch_unwind(|| {
        let pair = json::parse(&text).ok()?;
        Some(safety_code(&device(pair.get("own"))?, &device(pair.get("other"))?))
    }).ok().flatten().map_or(std::ptr::null_mut(), give)
}

/// Gives a text back to the core.
///
/// # Safety
/// `text` is null or a pointer this library handed out, not yet given back.
#[no_mangle]
pub unsafe extern "C" fn invizent_string_free(text: *mut c_char) { if !text.is_null() { drop(CString::from_raw(text)) } }

// ── The encryption service ───────────────────────────────────────────────────────────────────────────────────

/// What the app gives the service: the Signal library, the private storage and the server, as functions.
/// Every text a function gives back is allocated with `malloc` (Swift: `strdup`) and freed by the core.
/// The functions are called on the thread that called `invizent_crypto_call`, one at a time, and may block
/// (the server function waits for the answer).
#[repr(C)]
pub struct InvizentHost {
    /// Passed back to every function.
    pub context: *mut c_void,
    /// The Signal library. `method`: createState, replenish, trustIdentity, encrypt, decrypt; `args`: a JSON
    /// array in the order of the library's own arguments. Answer: `{"ok":…}` (the method's result object) or
    /// `{"error":{"name":…,"code":…,"message":…}}`.
    /// Null: the Signal library built into the core is used (the phone apps do this).
    pub bridge: Option<extern "C" fn(context: *mut c_void, method: *const c_char, args: *const c_char) -> *mut c_char>,
    /// One record of the private storage; null when there is none.
    pub vault_get: extern "C" fn(context: *mut c_void, key: *const c_char) -> *mut c_char,
    /// Writes all of `changes` or none: a JSON array of `[key, value]`, `value` null to remove.
    pub vault_commit: extern "C" fn(context: *mut c_void, changes: *const c_char),
    /// The server. `method`: registerCryptoDevice, cryptoDevices, claimPreKey, cryptoInbox; `args`: a JSON array.
    /// Answer: `{"ok":…}` (the body), `{"network":"…"}` (no answer came) or `{"refused":"…"}` (the server said no).
    pub transport: extern "C" fn(context: *mut c_void, method: *const c_char, args: *const c_char) -> *mut c_char,
    /// The time now as `2026-11-21T07:00:00.000Z`; null = the device's clock.
    pub now_iso: Option<extern "C" fn(context: *mut c_void) -> *mut c_char>,
    /// A new random UUID; null = made here from the system's random source.
    pub random_uuid: Option<extern "C" fn(context: *mut c_void) -> *mut c_char>,
}

extern "C" { fn free(pointer: *mut c_void); }

/// Takes a text the app allocated, and frees it.
fn taken(pointer: *mut c_char) -> Option<String> {
    if pointer.is_null() { return None }
    // SAFETY: the app hands out NUL-terminated texts allocated with malloc (the contract of InvizentHost).
    unsafe {
        let text = CStr::from_ptr(pointer).to_str().ok().map(str::to_string);
        free(pointer.cast());
        text
    }
}
fn c_text(text: &str) -> CString { CString::new(text.replace('\0', "")).unwrap_or_default() }

#[derive(Clone, Copy)]
struct Host(*const InvizentHost);
impl Host {
    fn get(&self) -> &InvizentHost { unsafe { &*self.0 } }
    fn asked(&self, call: extern "C" fn(*mut c_void, *const c_char, *const c_char) -> *mut c_char, method: &str, args: Vec<Value>) -> Option<Value> {
        let (method, args) = (c_text(method), c_text(&json::stringify(&Value::Array(args))));
        json::parse(&taken(call(self.get().context, method.as_ptr(), args.as_ptr()))?).ok()
    }
    fn signal(&self, method: &str, args: Vec<Value>) -> Result<Value, SignalError> {
        let silent = || SignalError { name: "Error".to_string(), code: String::new(), message: "The Signal library gave no answer.".to_string() };
        let answer = self.asked(self.get().bridge.ok_or_else(silent)?, method, args).ok_or_else(silent)?;
        if let Some(error) = answer.get("error") {
            let part = |key: &str| error.get(key).and_then(Value::as_str).unwrap_or_default();
            return Err(SignalError { name: part("name"), code: part("code"), message: part("message") });
        }
        answer.get("ok").cloned().ok_or_else(silent)
    }
}
fn part(value: &Value, key: &str) -> Result<String, SignalError> {
    value.get(key).and_then(Value::as_str).ok_or_else(|| SignalError { name: "Error".to_string(), code: String::new(), message: format!("The Signal library's answer has no {key}.") })
}
fn count(n: u32) -> Value { Value::Number(f64::from(n)) }

impl SignalBridge for Host {
    fn create_state(&mut self, address: &str, device_id: u32) -> Result<(String, Value), SignalError> {
        #[cfg(feature = "signal")]
        if self.get().bridge.is_none() { return crate::signal::LibSignal.create_state(address, device_id) }
        let made = self.signal("createState", vec![Value::str(address), count(device_id)])?;
        Ok((part(&made, "state")?, made.get("bundle").cloned().unwrap_or(Value::Null)))
    }
    fn replenish(&mut self, state: &str, more: u32) -> Result<(String, Value), SignalError> {
        #[cfg(feature = "signal")]
        if self.get().bridge.is_none() { return crate::signal::LibSignal.replenish(state, more) }
        let made = self.signal("replenish", vec![Value::str(state), count(more)])?;
        Ok((part(&made, "state")?, made.get("bundle").cloned().unwrap_or(Value::Null)))
    }
    fn trust_identity(&mut self, state: &str, address: &str, device_id: u32, identity_key: &str) -> Result<String, SignalError> {
        #[cfg(feature = "signal")]
        if self.get().bridge.is_none() { return crate::signal::LibSignal.trust_identity(state, address, device_id, identity_key) }
        part(&self.signal("trustIdentity", vec![Value::str(state), Value::str(address), count(device_id), Value::str(identity_key)])?, "state")
    }
    fn encrypt(&mut self, state: &str, address: &str, device_id: u32, plaintext: &str, bundle: Option<&Value>) -> Result<Sealed, SignalError> {
        #[cfg(feature = "signal")]
        if self.get().bridge.is_none() { return crate::signal::LibSignal.encrypt(state, address, device_id, plaintext, bundle) }
        let made = self.signal("encrypt", vec![Value::str(state), Value::str(address), count(device_id), Value::str(plaintext), bundle.cloned().unwrap_or(Value::Null)])?;
        let Some(Value::Number(kind)) = made.get("type") else { return Err(part(&made, "type").unwrap_err()) };
        Ok(Sealed { state: part(&made, "state")?, kind: *kind, body: part(&made, "body")? })
    }
    fn decrypt(&mut self, state: &str, address: &str, device_id: u32, kind: f64, body: &str) -> Result<Opened, SignalError> {
        #[cfg(feature = "signal")]
        if self.get().bridge.is_none() { return crate::signal::LibSignal.decrypt(state, address, device_id, kind, body) }
        let made = self.signal("decrypt", vec![Value::str(state), Value::str(address), count(device_id), Value::Number(kind), Value::str(body)])?;
        Ok(Opened { state: part(&made, "state")?, plaintext: part(&made, "plaintext")? })
    }
}
impl Vault for Host {
    fn get(&self, key: &str) -> Option<String> { let key = c_text(key); taken((self.get().vault_get)(self.get().context, key.as_ptr())) }
    fn commit(&mut self, changes: Vec<(String, Option<String>)>) {
        let list = changes.into_iter().map(|(key, value)| Value::Array(vec![Value::str(&key), value.map_or(Value::Null, |value| Value::str(&value))])).collect();
        let text = c_text(&json::stringify(&Value::Array(list)));
        (self.get().vault_commit)(self.get().context, text.as_ptr());
    }
}
impl Host {
    fn server(&self, method: &str, args: Vec<Value>) -> Result<Value, TransportError> {
        let silent = || TransportError::Network("Нет связи с сервером.".to_string());
        let answer = self.asked(self.get().transport, method, args).ok_or_else(silent)?;
        if let Some(words) = answer.get("network") { return Err(TransportError::Network(words.as_str().unwrap_or_default())) }
        if let Some(words) = answer.get("refused") { return Err(TransportError::Refused(words.as_str().unwrap_or_default())) }
        answer.get("ok").cloned().ok_or_else(silent)
    }
}
impl CryptoTransport for Host {
    fn register_crypto_device(&mut self, device_id: &str, bundle: &Value) -> Result<Value, TransportError> { self.server("registerCryptoDevice", vec![Value::str(device_id), bundle.clone()]) }
    fn crypto_devices(&mut self, user_id: &str) -> Result<Value, TransportError> { self.server("cryptoDevices", vec![Value::str(user_id)]) }
    fn claim_pre_key(&mut self, user_id: &str, device_id: &str) -> Result<Value, TransportError> { self.server("claimPreKey", vec![Value::str(user_id), Value::str(device_id)]) }
    fn crypto_inbox(&mut self, device_id: &str, chat_id: &str, after: f64) -> Result<Value, TransportError> { self.server("cryptoInbox", vec![Value::str(device_id), Value::str(chat_id), Value::Number(after)]) }
}
impl Env for Host {
    fn now_iso(&mut self) -> String {
        if let Some(text) = self.get().now_iso.and_then(|ask| taken(ask(self.get().context))) { return text }
        let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_millis() as i64);
        crate::time::iso_from_ms(ms)
    }
    fn random_uuid(&mut self) -> String {
        if let Some(text) = self.get().random_uuid.and_then(|ask| taken(ask(self.get().context))) { return text }
        let mut bytes = [0u8; 16];
        // Without the system's random source there is no safe id: stopping is the only honest answer.
        getrandom::getrandom(&mut bytes).expect("the system's random source");
        bytes[6] = bytes[6] & 0x0f | 0x40;
        bytes[8] = bytes[8] & 0x3f | 0x80;
        let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
    }
}

/// One person's encryption service on this device.
pub struct InvizentCrypto { service: Mutex<Crypto<Host, Host, Host, Host>>, _host: Box<InvizentHost> }

/// Makes the service for the signed-in person. `host` is copied; its functions and `context` must stay
/// valid until `invizent_crypto_free`. Null if `user_id` is not a text.
///
/// # Safety
/// `user_id` is a NUL-terminated string; `host` points to a filled-in `InvizentHost`.
#[no_mangle]
pub unsafe extern "C" fn invizent_crypto_new(user_id: *const c_char, auto_trust: bool, host: *const InvizentHost) -> *mut InvizentCrypto {
    let (Some(user_id), false) = (take(user_id), host.is_null()) else { return std::ptr::null_mut() };
    let kept = Box::new(std::ptr::read(host));
    let handle = Host(&*kept);
    // The check of an attachment's small picture: see `photo`.
    let service = Crypto::new(&user_id, handle, handle, handle, handle, auto_trust, Box::new(preview_ok));
    Box::into_raw(Box::new(InvizentCrypto { service: Mutex::new(service), _host: kept }))
}

/// Runs one operation of the service (the names and arguments: `e2ee::dispatch`). `args`: a JSON array.
/// Answer: `{"ok":…}` or `{"error":{"name":…,"message":…}}`; never null for a valid `crypto`.
///
/// # Safety
/// `crypto` came from `invizent_crypto_new` and was not freed; `op` and `args` are NUL-terminated strings.
#[no_mangle]
pub unsafe extern "C" fn invizent_crypto_call(crypto: *mut InvizentCrypto, op: *const c_char, args: *const c_char) -> *mut c_char {
    if crypto.is_null() { return std::ptr::null_mut() }
    let failure = |name: &str, message: &str| json::stringify(&json::object(vec![("error", json::object(vec![("name", Value::str(name)), ("message", Value::str(message))]))]));
    let (Some(op), Some(args)) = (take(op), take(args)) else { return give(failure("Error", "Bad call.")) };
    let Ok(Value::Array(args)) = json::parse(&args) else { return give(failure("Error", "Bad arguments.")) };
    let crypto = &*crypto;
    let answer = catch_unwind(AssertUnwindSafe(|| {
        let mut service = crypto.service.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(step) = op.strip_prefix("history.") { return history_step(&mut service, Host(&*crypto._host), step, &args) }
        match dispatch(&mut service, &op, &args) {
            Ok(value) => json::stringify(&json::object(vec![("ok", value)])),
            Err(error) => failure(error.name(), error.message()),
        }
    }));
    give(answer.unwrap_or_else(|_| failure("Error", "The core stopped on this operation.")))
}

/// The server for old chats on a new device: the same transport, with the refusal's code and status
/// (`{"refused": words, "code": …, "status": …}` from the app).
struct HistoryHost(Host);
impl crate::e2ee::history_sync::HistoryServer for HistoryHost {
    fn call(&mut self, op: &str, args: Vec<Value>) -> Result<Value, crate::e2ee::history_sync::Refusal> {
        use crate::e2ee::history_sync::Refusal;
        let silent = || Refusal { network: true, message: "Нет связи с сервером.".to_string(), code: None, status: 0.0 };
        let answer = self.0.asked(self.0.get().transport, op, args).ok_or_else(silent)?;
        if let Some(words) = answer.get("network") { return Err(Refusal { network: true, message: words.as_str().unwrap_or_default(), code: None, status: 0.0 }) }
        if let Some(words) = answer.get("refused") {
            let status = match answer.get("status") { Some(Value::Number(n)) => *n, _ => 0.0 };
            return Err(Refusal { network: false, message: words.as_str().unwrap_or_default(), code: answer.get("code").and_then(Value::as_str), status });
        }
        answer.get("ok").cloned().ok_or_else(silent)
    }
}

/// `history.<step>` of `invizent_crypto_call` (docs/HISTORY-TRANSFER.md, `e2ee::history_sync`): `state []` → the
/// vault's `history:v1` · `status []` → `{enabled, canRestore, restoreAt, updatedAt, held}` · `ask []` → the request made, or null · `serve []` → the time of the next request still
/// waiting, or null · `receive []` → the messages imported, or null · `outgoing []` → `{transfers}` ·
/// `cancel [transferId]` · `enable []` → the new backup secret · `disable []` · `secret []` → the secret, or null ·
/// `backup []` → pages written · `restore [typed]` → the messages imported. A refusal also carries `code` (the
/// server's) and `left` (restore attempts left this hour).
fn history_step(service: &mut Crypto<Host, Host, Host, Host>, host: Host, step: &str, args: &[Value]) -> String {
    use crate::e2ee::history_sync::{History, SyncError};
    let failure = |error: SyncError| {
        let mut fields = vec![("name", Value::str(error.name())), ("message", Value::str(&error.message()))];
        if let Some(code) = error.code() { fields.push(("code", Value::str(code))) }
        if let SyncError::Restore(_, Some(left)) = &error { fields.push(("left", Value::Number(*left))) }
        json::stringify(&json::object(vec![("error", json::object(fields))]))
    };
    #[cfg(feature = "signal")]
    let cipher = crate::e2ee::history::LibCipher;
    #[cfg(not(feature = "signal"))]
    struct NoCipher;
    #[cfg(not(feature = "signal"))]
    impl crate::e2ee::history::PageCipher for NoCipher {
        fn seal(&self, _: &str, _: &str, _: &str, _: &str) -> Result<String, ()> { Err(()) }
        fn open(&self, _: &str, _: &str, _: &str, _: &str) -> Result<String, ()> { Err(()) }
    }
    #[cfg(not(feature = "signal"))]
    let cipher = NoCipher;
    let mut server = HistoryHost(host);
    let mut history = History { crypto: service, server: &mut server, cipher: &cipher };
    let device = || history_device(&args);
    let result: Result<Value, SyncError> = match step {
        "state" => Ok(history.state()),
        // The settings screen: the server's backup state (salt and notes left out) and whether this device holds the secret.
        "status" => history.crypto.initialize().map_err(SyncError::from).and_then(|_| {
            let id = history.crypto.device_id().unwrap_or_default();
            let backup = history.server.call("backupState", vec![Value::str(&id)]).map_err(SyncError::from)?;
            let held = history.secret(Some(&backup)).unwrap_or(None).is_some();
            let pick = |key: &str| backup.get(key).cloned().unwrap_or(Value::Null);
            Ok(json::object(vec![("enabled", pick("enabled")), ("canRestore", pick("canRestore")), ("restoreAt", pick("restoreAt")), ("updatedAt", pick("updatedAt")), ("held", Value::Bool(held))]))
        }),
        "ask" => history.ask(),
        "serve" => history.serve(),
        "receive" => history.receive(|_, _| {}),
        "outgoing" => history.crypto.initialize().map_err(SyncError::from).and_then(|_| { let id = history.crypto.device_id().unwrap_or_default(); history.server.call("outgoingHistory", vec![Value::str(&id)]).map_err(SyncError::from) }),
        "cancel" => history.crypto.initialize().map_err(SyncError::from).and_then(|_| { let id = history.crypto.device_id().unwrap_or_default(); history.server.call("cancelHistory", vec![device(), Value::str(&id)]).map(|_| Value::Null).map_err(SyncError::from) }),
        "enable" => history.enable().map(|secret| Value::str(&secret)),
        "disable" => history.disable().map(|_| Value::Null),
        "secret" => history.secret(None).map(|secret| secret.map_or(Value::Null, |secret| Value::str(&secret))),
        "backup" => history.backup().map(Value::Number),
        "restore" => history.restore(&args.first().and_then(Value::as_str).unwrap_or_default(), |_, _| {}).map(Value::Number),
        _ => Err(SyncError::Message(format!("Unknown operation: history.{step}"))),
    };
    match result { Ok(value) => json::stringify(&json::object(vec![("ok", value)])), Err(error) => failure(error) }
}
fn history_device(args: &[Value]) -> Value { args.first().cloned().unwrap_or(Value::Null) }

/// Ends the service.
///
/// # Safety
/// `crypto` is null or came from `invizent_crypto_new` and is not used afterwards.
#[no_mangle]
pub unsafe extern "C" fn invizent_crypto_free(crypto: *mut InvizentCrypto) { if !crypto.is_null() { drop(Box::from_raw(crypto)) } }

/// The small picture that rides with an attachment must be exactly what the app's own cleaner would produce.
fn preview_ok(preview: Option<&Value>) -> bool { crate::photo::valid_preview(preview) }

// ── Requests to the server ───────────────────────────────────────────────────────────────────────────────────

/// The headers and the time limit of one request.
/// In: `{"method","path","jsonBody":bool,"version","platform":"ios"|"android","token"?,"proof"?,"attestKey"?,
/// "nowMs","tier"?:"slow"|"medium"|"fast"}`. Out: `{"headers":[[name,value],…],"timeoutMs":n}`, or null.
///
/// # Safety
/// `request_json` is null or a NUL-terminated string that stays valid for the call.
#[no_mangle]
pub unsafe extern "C" fn invizent_http_prepare(request_json: *const c_char) -> *mut c_char {
    let Some(text) = take(request_json) else { return std::ptr::null_mut() };
    catch_unwind(|| {
        use crate::http::{client_header, headers, request_timeout, Outgoing, Platform};
        use crate::network::Tier;
        let request = json::parse(&text).ok()?;
        let word = |key: &str| request.get(key).and_then(Value::as_str);
        let (method, path) = (word("method").unwrap_or_else(|| "GET".to_string()).to_uppercase(), word("path")?);
        let platform = match word("platform")?.as_str() { "ios" => Platform::Ios, "android" => Platform::Android, _ => return None };
        let client = client_header(&word("version")?, platform);
        let now_ms = match request.get("nowMs") { Some(Value::Number(ms)) if *ms >= 0.0 => *ms as u64, _ => return None };
        let tier = match word("tier").as_deref() { Some("slow") => Tier::Slow, Some("medium") => Tier::Medium, _ => Tier::Fast };
        let (token, proof, attest_key) = (word("token"), word("proof"), word("attestKey").unwrap_or_default());
        let list = headers(&Outgoing { method: &method, path: &path, json_body: matches!(request.get("jsonBody"), Some(Value::Bool(true))), client: &client, token: token.as_deref(), proof: proof.as_deref(), attest_key: &attest_key, now_ms });
        let list = list.into_iter().map(|(name, value)| Value::Array(vec![Value::str(name), Value::str(&value)])).collect();
        Some(json::stringify(&json::object(vec![("headers", Value::Array(list)), ("timeoutMs", Value::Number(f64::from(request_timeout(&path, &method, tier))))])))
    }).ok().flatten().map_or(std::ptr::null_mut(), give)
}

/// What the server's answer means. Out, always with `"serverOk"` and `"updateRequired"`:
/// `{"ok":body}` · `{"refused":{"message","status","code"?,…}}` · `{"serverDown":true}` (the request did not
/// reach the server itself: it may go to the next one).
///
/// # Safety
/// `body` is null or a NUL-terminated string that stays valid for the call.
#[no_mangle]
pub unsafe extern "C" fn invizent_http_read(status: u16, body: *const c_char) -> *mut c_char {
    let body = take(body).unwrap_or_default();
    catch_unwind(|| {
        use crate::http::{read_answer, Outcome};
        let answer = read_answer(status, &body);
        let mut out = match answer.outcome {
            Outcome::Ok(data) => vec![("ok", data)],
            Outcome::ServerDown => vec![("serverDown", Value::Bool(true))],
            Outcome::Refused(error) => {
                let mut fields = vec![("message", Value::str(&error.message)), ("status", Value::Number(f64::from(error.status)))];
                let mut text = |key: &'static str, value: Option<String>| if let Some(value) = value { fields.push((key, Value::str(&value))) };
                text("code", error.code); text("readyAt", error.ready_at); text("serverTime", error.server_time); text("expiresAt", error.expires_at);
                let mut number = |key: &'static str, value: Option<f64>| if let Some(value) = value { fields.push((key, Value::Number(value))) };
                number("attemptsRemaining", error.attempts_remaining.map(f64::from)); number("attemptsLeft", error.attempts_left.map(f64::from));
                number("retryAfterSeconds", error.retry_after_seconds); number("received", error.received);
                vec![("refused", json::object(fields))]
            }
        };
        out.push(("serverOk", Value::Bool(answer.server_ok)));
        out.push(("updateRequired", Value::Bool(answer.update_required)));
        json::stringify(&json::object(out))
    }).map_or(std::ptr::null_mut(), give)
}

/// The request of one server operation: `op` is its name (`login`, `chats`, `inboxPage`, … — see `api`), `args`
/// its arguments as a JSON array, `device` what the app knows about the device (`api::call`).
/// Out: `{"method","path","body"?}`, or null for an unknown operation or arguments of the wrong kind.
///
/// # Safety
/// The three are NUL-terminated strings that stay valid for the call (or null).
#[no_mangle]
pub unsafe extern "C" fn invizent_api_call(op: *const c_char, args: *const c_char, device: *const c_char) -> *mut c_char {
    let (Some(op), Some(args), Some(device)) = (take(op), take(args), take(device)) else { return std::ptr::null_mut() };
    catch_unwind(|| {
        let Ok(Value::Array(args)) = json::parse(&args) else { return None };
        let call = crate::api::call(&op, &args, &json::parse(&device).ok()?)?;
        let mut out = vec![("method", Value::str(&call.method)), ("path", Value::str(&call.path))];
        if let Some(body) = &call.body { out.push(("body", Value::str(body))) }
        Some(json::stringify(&json::object(out)))
    }).ok().flatten().map_or(std::ptr::null_mut(), give)
}

// ── The device proof of a session ────────────────────────────────────────────────────────────────────────────

/// One session's exchange of device proofs (`device_proof`), driven by the app step by step.
pub struct InvizentProof(Mutex<crate::device_proof::DeviceProof>);

#[no_mangle]
pub extern "C" fn invizent_proof_new() -> *mut InvizentProof { Box::into_raw(Box::new(InvizentProof(Mutex::new(crate::device_proof::DeviceProof::new())))) }

/// # Safety
/// `proof` is null or came from `invizent_proof_new` and is not used afterwards.
#[no_mangle]
pub unsafe extern "C" fn invizent_proof_free(proof: *mut InvizentProof) { if !proof.is_null() { drop(Box::from_raw(proof)) } }

/// One move of the exchange. `input`, always with `"now"` (milliseconds):
/// - `{"op":"state"}` → `{"proof":text|null,"due":bool,"known":bool,"generation":n,"renewAfterMs":n|null}`
/// - `{"op":"refresh","force":bool,"seen":n|null}` → `{"refresh":"held"|"notUsed"|"running"}` or a step
/// - `{"op":"reply","hasKey":bool, "ok":body}` / `…"refused":{"status":n,"code":text}` / `…"failed":true` → a step
/// - `{"op":"signed","signature","publicKey","kind":"hardware"|"software"}` / `{"op":"signed","failed":true,"keyChanged":bool}` → a step
/// A step: `{"post":{"path":text,"body":json|null}}` (POST it with the session's token, then `reply`) ·
/// `{"sign":{"message":text,"purpose":"bind"|"proof"}}` (sign with the device key, then `signed`) ·
/// `{"done":"held"|"notUsed"|"lost"|"unavailable"|"transport"}`.
///
/// # Safety
/// `proof` came from `invizent_proof_new`; `input` is a NUL-terminated string.
#[no_mangle]
pub unsafe extern "C" fn invizent_proof_call(proof: *mut InvizentProof, input: *const c_char) -> *mut c_char {
    use crate::device_proof::{KeyKind, ProofError, Purpose, Refresh, Reply, Signed, Step};
    if proof.is_null() { return std::ptr::null_mut() }
    let Some(text) = take(input) else { return std::ptr::null_mut() };
    let proof = &*proof;
    catch_unwind(AssertUnwindSafe(|| {
        let input = json::parse(&text).ok()?;
        let now = match input.get("now") { Some(Value::Number(now)) => *now as i64, _ => return None };
        let flag = |key: &str| matches!(input.get(key), Some(Value::Bool(true)));
        let word = |key: &str| input.get(key).and_then(Value::as_str);
        let step = |step: Step| -> Value {
            match step {
                Step::Post { path, body } => json::object(vec![("post", json::object(vec![("path", Value::str(path)), ("body", body.unwrap_or(Value::Null))]))]),
                Step::Sign { message, purpose } => json::object(vec![("sign", json::object(vec![("message", Value::str(&message)), ("purpose", Value::str(match purpose { Purpose::Bind => "bind", Purpose::Proof => "proof" }))]))]),
                Step::Done(result) => json::object(vec![("done", Value::str(match result { Ok(true) => "held", Ok(false) => "notUsed", Err(ProofError::Lost) => "lost", Err(ProofError::Unavailable) => "unavailable", Err(ProofError::Transport(_)) => "transport" }))]),
            }
        };
        let mut held = proof.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let out = match word("op")?.as_str() {
            "state" => json::object(vec![("proof", held.current(now).map_or(Value::Null, Value::str)), ("due", Value::Bool(held.due(now))), ("known", Value::Bool(held.known())),
                ("generation", Value::Number(held.generation() as f64)), ("renewAfterMs", held.renew_after_ms().map_or(Value::Null, |ms| Value::Number(ms as f64)))]),
            "refresh" => {
                let seen = match input.get("seen") { Some(Value::Number(seen)) => Some(*seen as u64), _ => None };
                match held.refresh(flag("force"), seen, now) {
                    Refresh::Held => json::object(vec![("refresh", Value::str("held"))]),
                    Refresh::NotUsed => json::object(vec![("refresh", Value::str("notUsed"))]),
                    Refresh::Running => json::object(vec![("refresh", Value::str("running"))]),
                    Refresh::Start(first) => step(first),
                }
            }
            "reply" => {
                let reply = if let Some(body) = input.get("ok") { Reply::Ok(body.clone()) }
                    else if let Some(refused) = input.get("refused") { Reply::Refused { status: match refused.get("status") { Some(Value::Number(status)) => *status as u16, _ => 0 }, code: refused.get("code").and_then(Value::as_str).unwrap_or_default() } }
                    else { Reply::Failed };
                step(held.on_reply(reply, flag("hasKey"), now))
            }
            "signed" => {
                let signed = match (word("signature"), word("publicKey")) {
                    (Some(signature), Some(public_key)) if !flag("failed") => Signed::Ok { signature, public_key, kind: if word("kind").as_deref() == Some("hardware") { KeyKind::Hardware } else { KeyKind::Software } },
                    _ => Signed::Failed { key_changed: flag("keyChanged") },
                };
                step(held.on_signed(signed, now))
            }
            _ => return None,
        };
        Some(json::stringify(&out))
    })).ok().flatten().map_or(std::ptr::null_mut(), give)
}

// ── What is shown ────────────────────────────────────────────────────────────────────────────────────────────

/// Pure functions of the core by name; `args` is a JSON array, the answer is JSON (null for an unknown name or
/// arguments of the wrong kind):
/// - `foldChat [messages, userId, hiddenForMe[], nowMs]` → `{messages, pinned, rules, nextExpiry}`: a chat's raw
///   (decrypted) messages folded into what is shown — edits, deletions, reactions, pins, polls, auto-delete.
/// - `chatListText [message]` → the line of a chat in the list.
/// - `replyPreview [message]` → the short line quoted in an answer.
/// - `nativeText [text, entities|null]` → `{text, fmt, urls}`: a message's text with its formatting as runs
///   `[flags, offset, length]` in UTF-16 units and one address per run with the link flag (`format`).
/// - `editWindowOpen [createdAt, nowMs]` → whether a message sent then may still be edited (48 hours).
/// - `actionFallback [action, targetText]` → the readable text stored with an action (an edit, a reaction, a pin…);
///   null for an action of an unknown kind.
/// - `listPreviewMessage [messages]` → the message the chat list shows for them (quiet actions and deleted ones
///   skipped, the latest edit applied, spoilers hidden); null when there is none.
/// - `call… […]` → the rules of one-to-one calls (see `calls::view` for the names).
/// - `settings… […]` → the rules behind the settings pages (see `settings::view` for the names).
/// - `stories… […]` → the rules of stories and profile posts (see `stories::view` for the names).
/// - `room… […]` → the rules of rooms (see `rooms::view` for the names).
/// - `compose… […]` → formatting while a message is written (see `format::compose::view` for the names).
/// - `history… […]` → old chats on a new device: pages, keys, the backup secret, its QR code (see `e2ee::history::view`).
///
/// # Safety
/// `name` and `args` are NUL-terminated strings that stay valid for the call (or null).
#[no_mangle]
pub unsafe extern "C" fn invizent_view(name: *const c_char, args: *const c_char) -> *mut c_char {
    let (Some(name), Some(args)) = (take(name), take(args)) else { return std::ptr::null_mut() };
    catch_unwind(|| {
        use crate::chat_view;
        let Ok(Value::Array(args)) = json::parse(&args) else { return None };
        let text = |units: crate::json::JsString| Value::String(units);
        let out = match (name.as_str(), args.as_slice()) {
            ("foldChat", [Value::Array(messages), Value::String(user_id), Value::Array(hidden), Value::Number(now)]) => {
                let hidden: Vec<String> = hidden.iter().filter_map(Value::as_str).collect();
                chat_view::fold_chat(messages, &user_id.to_string_lossy(), &hidden, *now)
            }
            ("chatListText", [message]) => text(chat_view::chat_list_text(message)),
            ("replyPreview", [message]) => text(chat_view::reply_preview(message)),
            // A null answer: the formatting is malformed in a way the reference itself stops on — show the text plain.
            ("nativeText", [Value::String(body), entities]) => crate::format::native_text(body, if matches!(entities, Value::Null) { None } else { Some(entities) }),
            ("editWindowOpen", [Value::String(created), Value::Number(now)]) => Value::Bool(chat_view::edit_window_open(&created.to_string_lossy(), *now)),
            ("actionFallback", [action, Value::String(target)]) => chat_view::action_fallback(action, target).map_or(Value::Null, text),
            ("listPreviewMessage", [Value::Array(list)]) => chat_view::list_preview_message(list).unwrap_or(Value::Null),
            // Settings (`settings.rs`): every name that starts with `settings`.
            (name, args) if name.starts_with("settings") => crate::settings::view(name, args)?,
            // Stories and profile posts (`stories.rs`): every name that starts with `stories`.
            (name, args) if name.starts_with("stories") => crate::stories::view(name, args)?,
            // Rooms (`rooms.rs`): every name that starts with `room`.
            (name, args) if name.starts_with("room") => crate::rooms::view(name, args)?,
            // The composer's formatting (`format/compose.rs`): every name that starts with `compose`.
            (name, args) if name.starts_with("compose") => crate::format::compose::view(name, args)?,
            // Old chats on a new device (`e2ee/history.rs`): every name that starts with `history`.
            (name, args) if name.starts_with("history") => crate::e2ee::history::view(name, args)?,
            // Calls (`calls.rs`): every name that starts with `call`.
            (name, args) => crate::calls::view(name, args)?,
        };
        Some(json::stringify(&out))
    }).ok().flatten().map_or(std::ptr::null_mut(), give)
}

// ── Files attached to encrypted messages ─────────────────────────────────────────────────────────────────────
//
// A file's bytes cross the boundary as a pointer and a length, and the answer is a buffer of the core's own,
// given back with `invizent_file_bytes_free`. (Not base64 inside JSON: a 20 MiB photo would be a 27 MB text,
// escaped and parsed on both sides — several copies of the picture in memory at once on a phone.)

/// Bytes the core hands out; `data` is null when there are none.
#[repr(C)]
pub struct InvizentBytes { pub data: *mut u8, pub len: usize }

fn give_bytes(bytes: Vec<u8>, out: *mut InvizentBytes) {
    let boxed = bytes.into_boxed_slice();
    let len = boxed.len();
    unsafe { *out = InvizentBytes { data: Box::into_raw(boxed).cast::<u8>(), len } }
}
/// # Safety
/// `data` is null or points to `len` readable bytes.
unsafe fn file_bytes<'a>(data: *const u8, len: usize) -> &'a [u8] { if data.is_null() || len == 0 { &[] } else { std::slice::from_raw_parts(data, len) } }

/// One step on a file: `work` gives the bytes for `out`, or the words of the refusal (the answer; null: done).
fn file_step(out: *mut InvizentBytes, work: impl FnOnce() -> Result<Vec<u8>, &'static str>) -> *mut c_char {
    if out.is_null() { return give(crate::e2ee::files::NOT_SEALED.to_string()) }
    unsafe { *out = InvizentBytes { data: std::ptr::null_mut(), len: 0 } }
    match catch_unwind(AssertUnwindSafe(work)) {
        Ok(Ok(bytes)) => { give_bytes(bytes, out); std::ptr::null_mut() }
        Ok(Err(words)) => give(words.to_string()),
        Err(_) => give(crate::e2ee::files::NOT_SEALED.to_string()),
    }
}

/// Seals a file for upload (AES-256-GCM-SIV, the Signal library's): `encryption_json` is what
/// `invizent_file_call("newEncryption")` gave. Answer: null, and `out` holds the ciphertext with its tag; or the
/// words for the person (given back with `invizent_string_free`), and `out` is empty.
///
/// # Safety
/// `plain` points to `plain_len` bytes, `encryption_json` is a NUL-terminated string, `out` is writable.
#[no_mangle]
pub unsafe extern "C" fn invizent_file_seal(plain: *const u8, plain_len: usize, encryption_json: *const c_char, out: *mut InvizentBytes) -> *mut c_char {
    let (plain, encryption) = (file_bytes(plain, plain_len), take(encryption_json).and_then(|text| json::parse(&text).ok()));
    file_step(out, || {
        let encryption = encryption.ok_or(crate::e2ee::files::NOT_SEALED)?;
        #[cfg(feature = "signal")]
        { crate::e2ee::files::seal_file(plain, &encryption) }
        #[cfg(not(feature = "signal"))]
        { let _ = (plain, encryption); Err(crate::e2ee::files::NOT_SEALED) }
    })
}

/// Opens a downloaded file with the key of its message: `attachment_json` is the attachment of the decrypted
/// message. Answer: null, and `out` holds the file; or the words for the person, and `out` is empty — a file
/// of another size than the message names, or with a single changed byte, is never given out.
///
/// # Safety
/// `cipher` points to `cipher_len` bytes, `attachment_json` is a NUL-terminated string, `out` is writable.
#[no_mangle]
pub unsafe extern "C" fn invizent_file_open(cipher: *const u8, cipher_len: usize, attachment_json: *const c_char, out: *mut InvizentBytes) -> *mut c_char {
    let (cipher, attachment) = (file_bytes(cipher, cipher_len), take(attachment_json).and_then(|text| json::parse(&text).ok()));
    file_step(out, || {
        let attachment = attachment.ok_or(crate::e2ee::files::NO_KEY)?;
        #[cfg(feature = "signal")]
        { crate::e2ee::files::open_file(cipher, &attachment) }
        #[cfg(not(feature = "signal"))]
        { let _ = (cipher, attachment); Err(crate::e2ee::files::NOT_AUTHENTIC) }
    })
}

/// A JPEG the phone has just written, as the reference's gate lets it out: only the picture, no metadata of any
/// kind. Answer: null, and `out` holds the cleaned file; or words, and `out` is empty (the photo is not sent).
///
/// # Safety
/// `jpeg` points to `jpeg_len` bytes, `out` is writable.
#[no_mangle]
pub unsafe extern "C" fn invizent_file_clean_jpeg(jpeg: *const u8, jpeg_len: usize, out: *mut InvizentBytes) -> *mut c_char {
    let jpeg = file_bytes(jpeg, jpeg_len);
    file_step(out, || {
        const REFUSED: &str = "Не удалось обработать фото. Файл не отправлен.";
        // A picture with a gain map needs the gate that rebuilds both of its images; this one would drop the map.
        if crate::photo::jpeg_hdr::announces_gainmap(jpeg) { return Err(REFUSED) }
        crate::photo::jpeg::sanitize_jpeg(jpeg).map(|clean| clean.bytes).map_err(|_| REFUSED)
    })
}

/// Gives back bytes the core handed out.
///
/// # Safety
/// `bytes` came from one of the functions above and is not used afterwards (empty bytes are fine).
#[no_mangle]
pub unsafe extern "C" fn invizent_file_bytes_free(bytes: InvizentBytes) {
    if !bytes.data.is_null() { drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(bytes.data, bytes.len))) }
}

/// The rest about files, by name; `args` is a JSON array, the answer is JSON (null for an unknown name or
/// arguments of the wrong kind):
/// - `newEncryption []` → `{scheme, key, nonce, fileKeyId}`: a key, a nonce and a key id for one new file.
/// - `uploadForm []` → `{head, tail, contentType}`: the body of `POST /e2ee/files` is `head`, the sealed bytes,
///   `tail` (both plain ASCII), sent with that `Content-Type`.
/// - `attachment [id, name, mimeType, size, encryption, media|null, preview|null]` → the attachment for the
///   encryption service's `encrypt` (`id`: the server's answer to the upload; `size`: plaintext bytes), or null
///   when it is not one a message may carry.
/// - `preview [jpegBase64]` → `{mimeType, base64, width, height}`: the small picture that rides with a photo,
///   cleaned and checked (at most 256 px a side and 8 KiB), or null when it is not acceptable.
/// - `describe [attachment]` → `{kind: "photo"|"video"|"audio"|"file", fileName, sizeText, cipherSize|null,
///   refusal|null}`: how it is shown, the safe name of its temporary file, how many bytes the server must send,
///   and — when it cannot be opened here (no key, too big, the chunked scheme) — the words that say so.
/// - `received [status, contentLength|null]` → null, or the words for an answer whose body must not be read.
/// - `sizeText [bytes]` → «1.5 МБ».
///
/// # Safety
/// `name` and `args` are NUL-terminated strings that stay valid for the call (or null).
#[no_mangle]
pub unsafe extern "C" fn invizent_file_call(name: *const c_char, args: *const c_char) -> *mut c_char {
    let (Some(name), Some(args)) = (take(name), take(args)) else { return std::ptr::null_mut() };
    catch_unwind(|| {
        use crate::e2ee::files;
        let Ok(Value::Array(args)) = json::parse(&args) else { return None };
        let optional = |value: &Value| if matches!(value, Value::Null) { None } else { Some(value.clone()) };
        let whole = |number: f64| (number.fract() == 0.0 && (0.0..=9007199254740991.0).contains(&number)).then_some(number as u64);
        let out = match (name.as_str(), args.as_slice()) {
            ("newEncryption", []) => files::fresh_encryption(),
            ("uploadForm", []) => {
                let form = files::upload_form(&files::fresh_boundary());
                json::object(vec![("head", Value::str(&String::from_utf8_lossy(&form.head))), ("tail", Value::str(&String::from_utf8_lossy(&form.tail))), ("contentType", Value::str(&form.content_type))])
            }
            ("attachment", [Value::String(id), Value::String(file_name), Value::String(mime_type), Value::Number(size), encryption, media, preview]) => {
                let size = usize::try_from(whole(*size)?).ok()?;
                let made = files::attachment(&id.to_str()?, file_name, mime_type, size, encryption, optional(media).as_ref(), optional(preview).as_ref());
                if !crate::e2ee::attachment::valid_attachment(&made, &|preview| preview_ok(preview)) { return None }
                made
            }
            ("preview", [Value::String(jpeg)]) => {
                use base64::Engine as _;
                let bytes = base64::engine::general_purpose::STANDARD.decode(jpeg.to_str()?).ok()?;
                let made = crate::photo::preview::create_preview(&bytes).ok()?;
                let preview = json::object(vec![("mimeType", Value::str("image/jpeg")), ("base64", Value::str(&made.base64)), ("width", Value::Number(f64::from(made.width))), ("height", Value::Number(f64::from(made.height)))]);
                if !preview_ok(Some(&preview)) { return None }
                preview
            }
            ("describe", [attachment @ Value::Object(_)]) => {
                let words = |key: &str| match attachment.get(key) { Some(Value::String(text)) => text.clone(), _ => crate::json::JsString::default() };
                let size = match attachment.get("size") { Some(Value::Number(size)) => whole(*size), _ => None };
                let refusal = files::before_download(attachment).err();
                json::object(vec![
                    ("kind", Value::str(files::kind(&words("name"), &words("mimeType")).word())), ("fileName", Value::str(&files::safe_name(&words("name")))),
                    ("sizeText", Value::str(&size.map(files::size_text).unwrap_or_default())),
                    ("cipherSize", files::cipher_size(attachment).filter(|_| refusal.is_none()).map_or(Value::Null, |size| Value::Number(size as f64))),
                    ("refusal", refusal.map_or(Value::Null, Value::str)),
                ])
            }
            ("received", [Value::Number(status), claimed]) => {
                let claimed = match claimed { Value::Number(claimed) => Some(*claimed), _ => None };
                files::before_body((200.0..300.0).contains(status), claimed).err().map_or(Value::Null, Value::str)
            }
            ("sizeText", [Value::Number(bytes)]) => Value::str(&files::size_text(whole(*bytes)?)),
            // Big files, voice messages and round videos: see `file_call_more` at the end of this file.
            (name, args) => return file_call_more(name, args),
        };
        Some(json::stringify(&out))
    }).ok().flatten().map_or(std::ptr::null_mut(), give)
}

// ── Big files (the chunked scheme), voice messages and round videos ──────────────────────────────────────────

/// More of `invizent_file_call`, by name:
/// - `newChunkedEncryption []` → `{scheme, key, nonce, fileKeyId, chunkSize}`: the key of one new big file (and of
///   every new start of its upload from the first byte).
/// - `chunks [size]` → `{count, chunkSize, cipherSize}`: how a file of `size` plaintext bytes is cut, and how many
///   bytes the server holds for it.
/// - `chunk [size, index]` → `{start, end, plain, cipher}`: chunk `index` on the server (its first and last byte,
///   for `PUT …?offset=start` and `Range: bytes=start-end`) and its length before and after sealing; null when
///   the file has no such chunk.
/// - `chunkAfter [received]` → the chunk an upload goes on with once the server holds `received` bytes.
/// - `chunked [attachment]` → `{size, count, cipherSize, refusal: null}` for an attachment of the chunked scheme,
///   or `{refusal}` with the words for the person.
/// - `waveform [levels]` → the letters of a finished take's waveform (levels 0…1), or null when it has none.
/// - `waveformBars [waveform|null, count]` → the bars a row draws, each 0…1.
/// - `voiceTime [ms]` → «1:05»; `voiceTimeFine [ms]` → «0:04,63».
/// - `voiceName [nowMs]` → `voice-<ms>.m4a`; `noteName [nowMs]` → `circle-<ms>.mp4`.
/// - `mediaKind [attachment]` → "voice", "note", or what `describe` calls it ("photo", "video", "audio", "file").
/// - `recordRules []` → `{voiceMime, noteMime, voiceMinMs, voiceMaxMs, noteMaxMs}`.
fn file_call_more(name: &str, args: &[Value]) -> Option<String> {
    use crate::e2ee::files;
    use crate::media;
    let whole = |number: f64| (number.fract() == 0.0 && (0.0..=9007199254740991.0).contains(&number)).then_some(number as u64);
    let out = match (name, args) {
        ("newChunkedEncryption", []) => files::fresh_chunked_encryption(),
        ("chunks", [Value::Number(size)]) => {
            let size = whole(*size)?;
            json::object(vec![("count", Value::Number(files::chunk_count(size) as f64)), ("chunkSize", Value::Number(files::CHUNK_PLAIN as f64)), ("cipherSize", Value::Number(files::chunked_cipher_size(size) as f64))])
        }
        ("chunk", [Value::Number(size), Value::Number(index)]) => {
            let (size, index) = (whole(*size)?, whole(*index)?);
            match (files::chunk_range(size, index), files::chunk_plain_len(size, index)) {
                (Some((start, end)), Some(plain)) => json::object(vec![("start", Value::Number(start as f64)), ("end", Value::Number(end as f64)), ("plain", Value::Number(plain as f64)), ("cipher", Value::Number((plain + files::TAG) as f64))]),
                _ => Value::Null,
            }
        }
        ("chunkAfter", [Value::Number(received)]) => Value::Number(files::chunk_after(whole(*received)?) as f64),
        ("chunked", [attachment @ Value::Object(_)]) => match files::chunked_size(attachment) {
            Ok(size) => json::object(vec![("size", Value::Number(size as f64)), ("count", Value::Number(files::chunk_count(size) as f64)), ("cipherSize", Value::Number(files::chunked_cipher_size(size) as f64)), ("refusal", Value::Null)]),
            Err(words) => json::object(vec![("refusal", Value::str(words))]),
        },
        ("waveform", [Value::Array(levels)]) => {
            let levels: Option<Vec<f64>> = levels.iter().map(|level| match level { Value::Number(level) => Some(*level), _ => None }).collect();
            media::encode_waveform(&levels?).map_or(Value::Null, |letters| Value::str(&letters))
        }
        ("waveformBars", [waveform, Value::Number(count)]) => {
            let letters = match waveform { Value::String(text) => Some(text.0.as_slice()), _ => None };
            Value::Array(media::waveform_bars(letters, whole(*count)?.min(1000) as usize).into_iter().map(Value::Number).collect())
        }
        ("voiceTime", [Value::Number(ms)]) => Value::str(&media::voice_time(*ms)),
        ("voiceTimeFine", [Value::Number(ms)]) => Value::str(&media::voice_time_fine(*ms)),
        ("voiceName", [Value::Number(now)]) => Value::str(&media::voice_file_name(*now)),
        ("noteName", [Value::Number(now)]) => Value::str(&media::video_note_file_name(*now)),
        ("mediaKind", [attachment @ Value::Object(_)]) => {
            let words = |key: &str| match attachment.get(key) { Some(Value::String(text)) => text.clone(), _ => crate::json::JsString::default() };
            Value::str(if media::is_voice(attachment) { "voice" } else if media::is_video_note(attachment) { "note" } else { files::kind(&words("name"), &words("mimeType")).word() })
        }
        ("recordRules", []) => json::object(vec![
            ("voiceMime", Value::str(media::VOICE_MIME)), ("noteMime", Value::str(media::VIDEO_NOTE_MIME)), ("voiceMinMs", Value::Number(media::VOICE_MIN_MS)),
            ("voiceMaxMs", Value::Number(media::VOICE_MAX_MS)), ("noteMaxMs", Value::Number(media::VIDEO_NOTE_MAX_MS)),
        ]),
        _ => return None,
    };
    Some(json::stringify(&out))
}

/// Seals chunk `index` of a big file of `size` plaintext bytes: `encryption_json` is what
/// `invizent_file_call("newChunkedEncryption")` gave, `plain` exactly that chunk's bytes. Answer: null, and `out`
/// holds the chunk's ciphertext with its tag; or the words for the person, and `out` is empty.
///
/// # Safety
/// `plain` points to `plain_len` bytes, `encryption_json` is a NUL-terminated string, `out` is writable.
#[no_mangle]
pub unsafe extern "C" fn invizent_file_seal_chunk(plain: *const u8, plain_len: usize, encryption_json: *const c_char, index: u64, size: u64, out: *mut InvizentBytes) -> *mut c_char {
    let (plain, encryption) = (file_bytes(plain, plain_len), take(encryption_json).and_then(|text| json::parse(&text).ok()));
    file_step(out, || {
        let encryption = encryption.ok_or(crate::e2ee::files::NOT_SEALED)?;
        #[cfg(feature = "signal")]
        { crate::e2ee::files::seal_chunk(plain, &encryption, index, size) }
        #[cfg(not(feature = "signal"))]
        { let _ = (plain, encryption, index, size); Err(crate::e2ee::files::NOT_SEALED) }
    })
}

/// Opens chunk `index` of a downloaded big file with the key of its message (`attachment_json`: the attachment of
/// the decrypted message). Answer: null, and `out` holds the chunk's bytes; or the words for the person, and
/// `out` is empty — a chunk of another size than its place asks for, moved from another place, or with a single
/// changed byte is never given out.
///
/// # Safety
/// `cipher` points to `cipher_len` bytes, `attachment_json` is a NUL-terminated string, `out` is writable.
#[no_mangle]
pub unsafe extern "C" fn invizent_file_open_chunk(cipher: *const u8, cipher_len: usize, attachment_json: *const c_char, index: u64, out: *mut InvizentBytes) -> *mut c_char {
    let (cipher, attachment) = (file_bytes(cipher, cipher_len), take(attachment_json).and_then(|text| json::parse(&text).ok()));
    file_step(out, || {
        let attachment = attachment.ok_or(crate::e2ee::files::NO_KEY)?;
        #[cfg(feature = "signal")]
        { crate::e2ee::files::open_chunk(cipher, &attachment, index) }
        #[cfg(not(feature = "signal"))]
        { let _ = (cipher, attachment, index); Err(crate::e2ee::files::NOT_AUTHENTIC) }
    })
}

// ── Cards of links ───────────────────────────────────────────────────────────────────────────────────────────

/// The card of a link in a one-to-one chat (`link_preview`), by name; `args` is a JSON array, the answer is JSON
/// (null for an unknown name or arguments of the wrong kind). Bytes travel as standard base64.
/// - `limits []` → `{htmlBytes, imageDownloadBytes, imageBytes, imageSide, redirects, timeoutMs}`: what a phone
///   keeps to when it fetches a page for a card.
/// - `candidate [text, entities|null]` → the link of a text that gets the card (its first `https` link, when it
///   may be fetched), or null.
/// - `fetchable [url]` → whether a phone may fetch this address (the page, a redirect's target, the picture):
///   `https`, the default port, a public host name.
/// - `privateAddress [ip]` → whether an address a host name resolved to must NOT be contacted.
/// - `parse [htmlBase64, contentType|null, pageUrl]` → `{site, title, description, imageUrl|null}`: what the head
///   of a fetched page says; null when `pageUrl` is not an address a card may come from.
/// - `image [jpegBase64]` → `{mimeType, base64, width, height}`: the card's picture cleaned of everything but the
///   picture (at most 480 px a side and 24 KiB), or null when it is not acceptable.
/// - `wire [url, site, title, description, jpegBase64|null]` → the card for the encryption service's `encrypt`
///   (texts made plain and cut, the picture cleaned; a picture that is not acceptable is left out), or null when
///   there is nothing to show.
/// - `valid [linkPreview, text, entities|null]` → whether a card is one a message with this text may carry.
///
/// # Safety
/// `name` and `args` are NUL-terminated strings that stay valid for the call (or null).
#[no_mangle]
pub unsafe extern "C" fn invizent_link_call(name: *const c_char, args: *const c_char) -> *mut c_char {
    let (Some(name), Some(args)) = (take(name), take(args)) else { return std::ptr::null_mut() };
    catch_unwind(|| {
        use crate::link_preview as link;
        use base64::Engine as _;
        let Ok(Value::Array(args)) = json::parse(&args) else { return None };
        let bytes = |text: &crate::json::JsString| base64::engine::general_purpose::STANDARD.decode(text.to_str()?).ok();
        let optional = |value: &Value| if matches!(value, Value::Null) { None } else { Some(value.clone()) };
        let out = match (name.as_str(), args.as_slice()) {
            ("limits", []) => json::object(vec![
                ("htmlBytes", Value::Number(link::MAX_HTML_BYTES as f64)), ("imageDownloadBytes", Value::Number(link::MAX_IMAGE_DOWNLOAD_BYTES as f64)),
                ("imageBytes", Value::Number(crate::photo::preview::MAX_LINK_IMAGE_BYTES as f64)), ("imageSide", Value::Number(f64::from(crate::photo::preview::MAX_LINK_IMAGE_SIDE))),
                ("redirects", Value::Number(link::MAX_REDIRECTS as f64)), ("timeoutMs", Value::Number(link::FETCH_TIMEOUT_MS)),
            ]),
            ("candidate", [Value::String(text), entities]) => link::candidate(text, optional(entities).as_ref()).map_or(Value::Null, |url| Value::str(&url)),
            ("fetchable", [Value::String(url)]) => Value::Bool(url.to_str().is_some_and(|url| link::fetchable(&url))),
            ("privateAddress", [Value::String(ip)]) => Value::Bool(ip.to_str().is_none_or(|ip| link::private_address(&ip))),
            ("parse", [Value::String(html), content_type, Value::String(page_url)]) => {
                let content_type = match content_type { Value::String(text) => Some(text.to_string_lossy()), Value::Null => None, _ => return None };
                match link::parse_page(&bytes(html)?, content_type.as_deref(), &page_url.to_str()?) {
                    Some(page) => json::object(vec![("site", Value::str(&page.site)), ("title", Value::str(&page.title)), ("description", Value::str(&page.description)), ("imageUrl", page.image_url.map_or(Value::Null, |url| Value::str(&url)))]),
                    None => Value::Null,
                }
            }
            ("image", [Value::String(jpeg)]) => {
                let made = crate::photo::preview::create_link_image(&bytes(jpeg)?).ok()?;
                let image = json::object(vec![("mimeType", Value::str("image/jpeg")), ("base64", Value::str(&made.base64)), ("width", Value::Number(f64::from(made.width))), ("height", Value::Number(f64::from(made.height)))]);
                if !crate::photo::preview::valid_link_image(&image) { return None }
                image
            }
            ("wire", [Value::String(url), Value::String(site), Value::String(title), Value::String(description), jpeg]) => {
                let jpeg = match jpeg { Value::String(text) => Some(bytes(text)?), Value::Null => None, _ => return None };
                link::wire(&url.to_str()?, &site.to_string_lossy(), &title.to_string_lossy(), &description.to_string_lossy(), jpeg.as_deref()).unwrap_or(Value::Null)
            }
            ("valid", [card, Value::String(text), entities]) => Value::Bool(link::valid_wire(card, text, optional(entities).as_ref())),
            _ => return None,
        };
        Some(json::stringify(&out))
    }).ok().flatten().map_or(std::ptr::null_mut(), give)
}
