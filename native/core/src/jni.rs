//! The core as the Android app calls it: the functions of `object Core` (Kotlin, `com.linea.messenger.core`).
//!
//! A thin layer over the C functions in `ffi.rs`, so both phones get the same answers. Texts cross as Java
//! strings (UTF-16), never as the JVM's modified UTF-8. Nothing here unwinds into the JVM.
//!
//! The encryption service asks the app for its private storage and for the server in the middle of its work:
//! those questions go to one Kotlin object (`CryptoHost`) kept by a global reference, on the very thread that
//! called `cryptoCall`. A storage that fails stops the app (see `failed`): keys are never carried on without it.

use crate::ffi::{
    invizent_api_call, invizent_core_version, invizent_crypto_call, invizent_crypto_free, invizent_crypto_new, invizent_http_prepare, invizent_http_read,
    invizent_proof_call, invizent_proof_free, invizent_proof_new, invizent_safety_code, invizent_string_free, InvizentCrypto, InvizentHost, InvizentProof,
};
use jni_sys::{jboolean, jclass, jint, jlong, jmethodID, jobject, jsize, jstring, jvalue, JNIEnv, JavaVM, JNI_EDETACHED, JNI_OK, JNI_VERSION_1_6};
use std::ffi::{c_char, c_void, CStr, CString};
use std::panic::catch_unwind;

/// A Java string as a Rust one; none for null or for text that is not valid UTF-16.
unsafe fn text(env: *mut JNIEnv, value: jstring) -> Option<String> {
    if env.is_null() || value.is_null() { return None }
    let table = &**env;
    let length = (table.GetStringLength?)(env, value);
    let mut units = vec![0u16; usize::try_from(length).ok()?];
    (table.GetStringRegion?)(env, value, 0, length, units.as_mut_ptr());
    String::from_utf16(&units).ok()
}

/// A Java string as a C one for the core; none for null, bad UTF-16 or a NUL inside.
unsafe fn c_text(env: *mut JNIEnv, value: jstring) -> Option<CString> { text(env, value).and_then(|text| CString::new(text).ok()) }

/// A Rust text as a new Java string (a local reference); null if the JVM could not make it.
unsafe fn java(env: *mut JNIEnv, text: &str) -> jstring {
    let units: Vec<u16> = text.encode_utf16().collect();
    let (Some(make), Ok(length)) = ((**env).NewString, jsize::try_from(units.len())) else { return std::ptr::null_mut() };
    make(env, units.as_ptr(), length)
}

/// A text the core handed out, as a Java string; the core's memory is given back. Null stays null.
unsafe fn give(env: *mut JNIEnv, pointer: *mut c_char) -> jstring {
    if pointer.is_null() || env.is_null() { return std::ptr::null_mut() }
    let text = CStr::from_ptr(pointer).to_str().ok().map(str::to_string);
    invizent_string_free(pointer);
    text.map_or(std::ptr::null_mut(), |text| java(env, &text))
}

/// `Core.coreVersion(): String`
///
/// # Safety
/// Called by the JVM with its own environment pointer.
#[no_mangle]
pub unsafe extern "system" fn Java_com_linea_messenger_core_Core_coreVersion(env: *mut JNIEnv, _class: jclass) -> jstring {
    give(env, invizent_core_version())
}

/// `Core.safetyCode(pairJson: String): String?`
///
/// # Safety
/// Called by the JVM with its own environment pointer and a string of its own (or null).
#[no_mangle]
pub unsafe extern "system" fn Java_com_linea_messenger_core_Core_safetyCode(env: *mut JNIEnv, _class: jclass, pair_json: jstring) -> jstring {
    let Some(pair) = c_text(env, pair_json) else { return std::ptr::null_mut() };
    let code = catch_unwind(|| invizent_safety_code(pair.as_ptr())).unwrap_or(std::ptr::null_mut());
    give(env, code)
}

// ── Requests to the server ───────────────────────────────────────────────────────────────────────────────────

/// `Core.httpPrepare(requestJson: String): String?` — see `invizent_http_prepare`.
///
/// # Safety
/// Called by the JVM with its own environment pointer and a string of its own (or null).
#[no_mangle]
pub unsafe extern "system" fn Java_com_linea_messenger_core_Core_httpPrepare(env: *mut JNIEnv, _class: jclass, request_json: jstring) -> jstring {
    let Some(request) = c_text(env, request_json) else { return std::ptr::null_mut() };
    give(env, invizent_http_prepare(request.as_ptr()))
}

/// `Core.httpRead(status: Int, body: String): String` — see `invizent_http_read`. A status outside 0…65535
/// is read as 0 (no answer of the server's own).
///
/// # Safety
/// Called by the JVM with its own environment pointer and a string of its own (or null).
#[no_mangle]
pub unsafe extern "system" fn Java_com_linea_messenger_core_Core_httpRead(env: *mut JNIEnv, _class: jclass, status: jint, body: jstring) -> jstring {
    // A body with a NUL inside is no JSON: it is read as an empty one.
    let body = c_text(env, body).unwrap_or_default();
    give(env, invizent_http_read(u16::try_from(status).unwrap_or(0), body.as_ptr()))
}

/// `Core.apiCall(op: String, argsJson: String, deviceJson: String): String?` — see `invizent_api_call`.
///
/// # Safety
/// Called by the JVM with its own environment pointer and strings of its own (or null).
#[no_mangle]
pub unsafe extern "system" fn Java_com_linea_messenger_core_Core_apiCall(env: *mut JNIEnv, _class: jclass, op: jstring, args_json: jstring, device_json: jstring) -> jstring {
    let (Some(op), Some(args), Some(device)) = (c_text(env, op), c_text(env, args_json), c_text(env, device_json)) else { return std::ptr::null_mut() };
    give(env, invizent_api_call(op.as_ptr(), args.as_ptr(), device.as_ptr()))
}

// ── The device proof of a session ────────────────────────────────────────────────────────────────────────────

/// `Core.proofNew(): Long` — one session's exchange of device proofs (`invizent_proof_new`); freed by `proofFree`.
///
/// # Safety
/// Called by the JVM.
#[no_mangle]
pub unsafe extern "system" fn Java_com_linea_messenger_core_Core_proofNew(_env: *mut JNIEnv, _class: jclass) -> jlong {
    invizent_proof_new() as jlong
}

/// `Core.proofCall(handle: Long, inputJson: String): String?` — one move of the exchange, see `invizent_proof_call`.
/// Null for a handle of 0, a text that is not a text, or a move the core cannot read.
///
/// # Safety
/// `handle` is 0 or came from `proofNew` and was not freed; the rest is the JVM's own.
#[no_mangle]
pub unsafe extern "system" fn Java_com_linea_messenger_core_Core_proofCall(env: *mut JNIEnv, _class: jclass, handle: jlong, input_json: jstring) -> jstring {
    if handle == 0 { return std::ptr::null_mut() }
    let Some(input) = c_text(env, input_json) else { return std::ptr::null_mut() };
    give(env, invizent_proof_call(handle as *mut InvizentProof, input.as_ptr()))
}

/// `Core.proofFree(handle: Long)`
///
/// # Safety
/// `handle` is 0 or came from `proofNew`, no call with it is running, and it is not used afterwards.
#[no_mangle]
pub unsafe extern "system" fn Java_com_linea_messenger_core_Core_proofFree(_env: *mut JNIEnv, _class: jclass, handle: jlong) {
    if handle != 0 { invizent_proof_free(handle as *mut InvizentProof) }
}

// ── The encryption service ───────────────────────────────────────────────────────────────────────────────────

extern "C" { fn malloc(size: usize) -> *mut c_void; }

/// A text for the core in the form `InvizentHost` asks for: allocated with `malloc`, freed by the core.
fn handed(text: &str) -> *mut c_char {
    let bytes: Vec<u8> = text.bytes().filter(|byte| *byte != 0).collect();
    // SAFETY: the block is `bytes.len() + 1` long, and exactly that much is written.
    unsafe {
        let block = malloc(bytes.len() + 1).cast::<u8>();
        if block.is_null() { return std::ptr::null_mut() }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), block, bytes.len());
        *block.add(bytes.len()) = 0;
        block.cast()
    }
}

/// The app's side of one service: the Kotlin object and its three methods —
/// `vaultGet(key: String): String?`, `vaultCommit(changesJson: String)`,
/// `transport(method: String, argsJson: String): String`.
struct App { vm: *mut JavaVM, host: jobject, vault_get: jmethodID, vault_commit: jmethodID, transport: jmethodID }

/// The JVM's environment of the current thread, for the length of one question to the app. The questions come
/// on the thread that called `cryptoCall`, which the JVM knows already; a thread it does not know is attached
/// for the question and detached after it.
struct Thread { vm: *mut JavaVM, env: *mut JNIEnv, attached: bool }
impl Thread {
    unsafe fn of(vm: *mut JavaVM) -> Option<Thread> {
        if vm.is_null() { return None }
        let mut env: *mut c_void = std::ptr::null_mut();
        match ((**vm).GetEnv?)(vm, &mut env, JNI_VERSION_1_6) {
            JNI_OK => Some(Thread { vm, env: env.cast(), attached: false }),
            JNI_EDETACHED => {
                if ((**vm).AttachCurrentThread?)(vm, &mut env, std::ptr::null_mut()) != JNI_OK || env.is_null() { return None }
                Some(Thread { vm, env: env.cast(), attached: true })
            }
            _ => None,
        }
    }
}
impl Drop for Thread {
    fn drop(&mut self) {
        if !self.attached { return }
        // SAFETY: this thread was attached by `of` and makes no more calls to the JVM.
        unsafe { if let Some(detach) = (**self.vm).DetachCurrentThread { detach(self.vm); } }
    }
}

/// True (and the exception is cleared) when the Kotlin method threw.
unsafe fn threw(env: *mut JNIEnv) -> bool {
    let Some(check) = (**env).ExceptionCheck else { return false };
    if check(env) == 0 { return false }
    if let Some(clear) = (**env).ExceptionClear { clear(env) }
    true
}

unsafe fn forget(env: *mut JNIEnv, reference: jobject) {
    if reference.is_null() { return }
    if let Some(delete) = (**env).DeleteLocalRef { delete(env, reference) }
}

/// The private storage did not answer or did not write. Carrying on would lose keys and ratchets, or make a
/// second identity over the first: the app stops here, as the iPhone app does.
unsafe fn failed(env: *mut JNIEnv, words: &'static CStr) -> ! {
    if !env.is_null() { if let Some(stop) = (**env).FatalError { stop(env, words.as_ptr()) } }
    std::process::abort()
}

/// Asks a method of the Kotlin object that takes strings and gives a string or nothing. `Err`: it threw, or the
/// JVM could not be asked at all.
unsafe fn ask(app: &App, method: jmethodID, arguments: &[&str], gives: bool) -> Result<Option<String>, ()> {
    let thread = Thread::of(app.vm).ok_or(())?;
    let env = thread.env;
    let strings: Vec<jstring> = arguments.iter().map(|text| java(env, text)).collect();
    let values: Vec<jvalue> = strings.iter().map(|string| jvalue { l: *string }).collect();
    let made = strings.iter().all(|string| !string.is_null());
    let mut answer = Ok(None);
    if !made {
        threw(env);
        answer = Err(());
    } else if gives {
        let call = (**env).CallObjectMethodA.ok_or(())?;
        let given = call(env, app.host, method, values.as_ptr());
        answer = if threw(env) { Err(()) } else { Ok(text(env, given)) };
        forget(env, given);
    } else {
        let call = (**env).CallVoidMethodA.ok_or(())?;
        call(env, app.host, method, values.as_ptr());
        if threw(env) { answer = Err(()) }
    }
    // A long catch-up asks the storage hundreds of times inside one call from Kotlin: nothing is left behind.
    for string in strings { forget(env, string) }
    answer
}

unsafe fn word(pointer: *const c_char) -> Option<String> {
    if pointer.is_null() { return None }
    CStr::from_ptr(pointer).to_str().ok().map(str::to_string)
}

extern "C" fn vault_get(context: *mut c_void, key: *const c_char) -> *mut c_char {
    // SAFETY: `context` is the `App` of `cryptoNew`, alive until `cryptoFree`; `key` is the core's own text.
    unsafe {
        let app = &*context.cast::<App>();
        let Some(key) = word(key) else { return std::ptr::null_mut() };
        match ask(app, app.vault_get, &[&key], true) {
            Ok(Some(value)) => handed(&value),
            Ok(None) => std::ptr::null_mut(),
            // «No record» and «cannot tell» must not be confused: the first makes new keys.
            Err(()) => failed(Thread::of(app.vm).map_or(std::ptr::null_mut(), |thread| thread.env), c"The private storage could not be read."),
        }
    }
}

extern "C" fn vault_commit(context: *mut c_void, changes: *const c_char) {
    // SAFETY: as in `vault_get`.
    unsafe {
        let app = &*context.cast::<App>();
        let written = word(changes).is_some_and(|changes| ask(app, app.vault_commit, &[&changes], false).is_ok());
        if !written { failed(Thread::of(app.vm).map_or(std::ptr::null_mut(), |thread| thread.env), c"The private storage could not be written.") }
    }
}

extern "C" fn transport(context: *mut c_void, method: *const c_char, args: *const c_char) -> *mut c_char {
    // SAFETY: as in `vault_get`.
    unsafe {
        let app = &*context.cast::<App>();
        let (Some(method), Some(args)) = (word(method), word(args)) else { return std::ptr::null_mut() };
        // No answer (null) is read by the core as «no connection to the server».
        match ask(app, app.transport, &[&method, &args], true) { Ok(Some(answer)) => handed(&answer), _ => std::ptr::null_mut() }
    }
}

/// One service as Kotlin holds it (the `Long` of `cryptoNew`).
struct Service { crypto: *mut InvizentCrypto, app: *mut App }

/// `Core.cryptoNew(userId: String, autoTrust: Boolean, host: Any): Long` — the service of the signed-in person;
/// 0 if it could not be made. `host` has the three methods of `App`; it is kept until `cryptoFree`.
///
/// # Safety
/// Called by the JVM with its own environment pointer and objects of its own.
#[no_mangle]
pub unsafe extern "system" fn Java_com_linea_messenger_core_Core_cryptoNew(env: *mut JNIEnv, _class: jclass, user_id: jstring, auto_trust: jboolean, host: jobject) -> jlong {
    let made = || -> Option<jlong> {
        if env.is_null() || host.is_null() { return None }
        let table = &**env;
        let user = c_text(env, user_id)?;
        let mut vm: *mut JavaVM = std::ptr::null_mut();
        if (table.GetJavaVM?)(env, &mut vm) != JNI_OK || vm.is_null() { return None }
        let class = (table.GetObjectClass?)(env, host);
        if class.is_null() { return None }
        let find = table.GetMethodID?;
        let method = |name: &CStr, signature: &CStr| -> Option<jmethodID> {
            let id = find(env, class, name.as_ptr(), signature.as_ptr());
            // A missing method leaves NoSuchMethodError pending: Kotlin sees it when this function returns.
            if id.is_null() { None } else { Some(id) }
        };
        let vault_get_id = method(c"vaultGet", c"(Ljava/lang/String;)Ljava/lang/String;")?;
        let vault_commit_id = method(c"vaultCommit", c"(Ljava/lang/String;)V")?;
        let transport_id = method(c"transport", c"(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;")?;
        forget(env, class);
        let kept = (table.NewGlobalRef?)(env, host);
        if kept.is_null() { return None }
        let app = Box::into_raw(Box::new(App { vm, host: kept, vault_get: vault_get_id, vault_commit: vault_commit_id, transport: transport_id }));
        // The Signal library is the core's own (`bridge` empty); the clock and the random source are the device's.
        let functions = InvizentHost { context: app.cast(), bridge: None, vault_get, vault_commit, transport, now_iso: None, random_uuid: None };
        let crypto = invizent_crypto_new(user.as_ptr(), auto_trust != 0, &functions);
        if crypto.is_null() {
            if let Some(delete) = table.DeleteGlobalRef { delete(env, kept) }
            drop(Box::from_raw(app));
            return None
        }
        Some(Box::into_raw(Box::new(Service { crypto, app })) as jlong)
    };
    made().unwrap_or(0)
}

/// `Core.cryptoCall(handle: Long, op: String, argsJson: String): String?` — see `invizent_crypto_call`.
/// Null only for a handle of 0 or texts that are not texts.
///
/// # Safety
/// `handle` came from `cryptoNew` and was not freed; the rest is the JVM's own.
#[no_mangle]
pub unsafe extern "system" fn Java_com_linea_messenger_core_Core_cryptoCall(env: *mut JNIEnv, _class: jclass, handle: jlong, op: jstring, args_json: jstring) -> jstring {
    if handle == 0 { return std::ptr::null_mut() }
    let (Some(op), Some(args)) = (c_text(env, op), c_text(env, args_json)) else { return std::ptr::null_mut() };
    let service = &*(handle as *const Service);
    give(env, invizent_crypto_call(service.crypto, op.as_ptr(), args.as_ptr()))
}

/// `Core.cryptoFree(handle: Long)` — ends the service and lets go of the Kotlin object.
///
/// # Safety
/// `handle` is 0 or came from `cryptoNew`, no call with it is running, and it is not used afterwards.
#[no_mangle]
pub unsafe extern "system" fn Java_com_linea_messenger_core_Core_cryptoFree(env: *mut JNIEnv, _class: jclass, handle: jlong) {
    if handle == 0 { return }
    let service = Box::from_raw(handle as *mut Service);
    invizent_crypto_free(service.crypto);
    let app = Box::from_raw(service.app);
    if !env.is_null() { if let Some(delete) = (**env).DeleteGlobalRef { delete(env, app.host) } }
}
