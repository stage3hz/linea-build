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
    pub bridge: extern "C" fn(context: *mut c_void, method: *const c_char, args: *const c_char) -> *mut c_char,
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
        let answer = self.asked(self.get().bridge, method, args).ok_or_else(silent)?;
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
        let made = self.signal("createState", vec![Value::str(address), count(device_id)])?;
        Ok((part(&made, "state")?, made.get("bundle").cloned().unwrap_or(Value::Null)))
    }
    fn replenish(&mut self, state: &str, more: u32) -> Result<(String, Value), SignalError> {
        let made = self.signal("replenish", vec![Value::str(state), count(more)])?;
        Ok((part(&made, "state")?, made.get("bundle").cloned().unwrap_or(Value::Null)))
    }
    fn trust_identity(&mut self, state: &str, address: &str, device_id: u32, identity_key: &str) -> Result<String, SignalError> {
        part(&self.signal("trustIdentity", vec![Value::str(state), Value::str(address), count(device_id), Value::str(identity_key)])?, "state")
    }
    fn encrypt(&mut self, state: &str, address: &str, device_id: u32, plaintext: &str, bundle: Option<&Value>) -> Result<Sealed, SignalError> {
        let made = self.signal("encrypt", vec![Value::str(state), Value::str(address), count(device_id), Value::str(plaintext), bundle.cloned().unwrap_or(Value::Null)])?;
        let Some(Value::Number(kind)) = made.get("type") else { return Err(part(&made, "type").unwrap_err()) };
        Ok(Sealed { state: part(&made, "state")?, kind: *kind, body: part(&made, "body")? })
    }
    fn decrypt(&mut self, state: &str, address: &str, device_id: u32, kind: f64, body: &str) -> Result<Opened, SignalError> {
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
        match dispatch(&mut service, &op, &args) {
            Ok(value) => json::stringify(&json::object(vec![("ok", value)])),
            Err(error) => failure(error.name(), error.message()),
        }
    }));
    give(answer.unwrap_or_else(|_| failure("Error", "The core stopped on this operation.")))
}

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
