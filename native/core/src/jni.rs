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
    invizent_proof_call, invizent_proof_free, invizent_proof_new, invizent_safety_code, invizent_string_free, invizent_view, InvizentCrypto, InvizentHost, InvizentProof,
};
use crate::ffi::{invizent_file_bytes_free, invizent_file_call, invizent_file_clean_jpeg, invizent_file_open, invizent_file_open_chunk, invizent_file_seal, invizent_file_seal_chunk, InvizentBytes};
use jni_sys::{jboolean, jbyteArray, jclass, jint, jlong, jmethodID, jobject, jsize, jstring, jvalue, JNIEnv, JavaVM, JNI_EDETACHED, JNI_OK, JNI_VERSION_1_6};
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

/// `Core.view(name: String, argsJson: String): String?` — a pure function of the core by its name, see
/// `invizent_view`. Null for an unknown name, arguments of the wrong kind, or a text that is not a text.
///
/// # Safety
/// Called by the JVM with its own environment pointer and strings of its own (or null).
#[no_mangle]
pub unsafe extern "system" fn Java_com_linea_messenger_core_Core_view(env: *mut JNIEnv, _class: jclass, name: jstring, args_json: jstring) -> jstring {
    let (Some(name), Some(args)) = (c_text(env, name), c_text(env, args_json)) else { return std::ptr::null_mut() };
    give(env, invizent_view(name.as_ptr(), args.as_ptr()))
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

// ── Files attached to encrypted messages ─────────────────────────────────────────────────────────────────────
//
// The functions of `object FileCore` (Kotlin, `com.linea.messenger.attachments`). A file's bytes cross as a Java
// `byte[]`, copied once on the way in and once on the way out (never as base64 inside JSON). A step answers
// with an object: a `byte[]` — its result — or a `String` — the words of the refusal; null only when the JVM
// could not make the answer.

/// The bytes of a Java array; none for null.
unsafe fn bytes(env: *mut JNIEnv, array: jbyteArray) -> Option<Vec<u8>> {
    if env.is_null() || array.is_null() { return None }
    let table = &**env;
    let length = (table.GetArrayLength?)(env, array);
    let mut out = vec![0u8; usize::try_from(length).ok()?];
    if length > 0 { (table.GetByteArrayRegion?)(env, array, 0, length, out.as_mut_ptr().cast()) }
    Some(out)
}

/// The answer of a step on a file for Kotlin: the words when there are some, else the bytes as a new `byte[]`.
/// The core's memory is given back either way.
unsafe fn file_answer(env: *mut JNIEnv, words: *mut c_char, out: InvizentBytes) -> jobject {
    if !words.is_null() {
        invizent_file_bytes_free(out);
        return give(env, words)
    }
    let made = (|| -> Option<jobject> {
        if env.is_null() { return None }
        let table = &**env;
        let length = jsize::try_from(out.len).ok()?;
        let array = (table.NewByteArray?)(env, length);
        if array.is_null() { return None }
        if length > 0 && !out.data.is_null() { (table.SetByteArrayRegion?)(env, array, 0, length, out.data.cast_const().cast()) }
        Some(array)
    })();
    invizent_file_bytes_free(out);
    made.unwrap_or(std::ptr::null_mut())
}

/// `FileCore.fileCall(name: String, argsJson: String): String?` — see `invizent_file_call`.
///
/// # Safety
/// Called by the JVM with its own environment pointer and strings of its own (or null).
#[no_mangle]
pub unsafe extern "system" fn Java_com_linea_messenger_attachments_FileCore_fileCall(env: *mut JNIEnv, _class: jclass, name: jstring, args_json: jstring) -> jstring {
    let (Some(name), Some(args)) = (c_text(env, name), c_text(env, args_json)) else { return std::ptr::null_mut() };
    give(env, invizent_file_call(name.as_ptr(), args.as_ptr()))
}

/// `FileCore.fileSeal(plain: ByteArray, encryptionJson: String): Any?` — see `invizent_file_seal`: the
/// ciphertext with its tag (`byte[]`), or the words for the person (`String`).
///
/// # Safety
/// Called by the JVM with its own environment pointer and objects of its own (or null).
#[no_mangle]
pub unsafe extern "system" fn Java_com_linea_messenger_attachments_FileCore_fileSeal(env: *mut JNIEnv, _class: jclass, plain: jbyteArray, encryption_json: jstring) -> jobject {
    let (Some(plain), Some(encryption)) = (bytes(env, plain), c_text(env, encryption_json)) else { return std::ptr::null_mut() };
    let mut out = InvizentBytes { data: std::ptr::null_mut(), len: 0 };
    let words = invizent_file_seal(plain.as_ptr(), plain.len(), encryption.as_ptr(), &mut out);
    file_answer(env, words, out)
}

/// `FileCore.fileOpen(cipher: ByteArray, attachmentJson: String): Any?` — see `invizent_file_open`: the file
/// (`byte[]`), or the words for the person (`String`); a file that fails its check is never given out.
///
/// # Safety
/// Called by the JVM with its own environment pointer and objects of its own (or null).
#[no_mangle]
pub unsafe extern "system" fn Java_com_linea_messenger_attachments_FileCore_fileOpen(env: *mut JNIEnv, _class: jclass, cipher: jbyteArray, attachment_json: jstring) -> jobject {
    let (Some(cipher), Some(attachment)) = (bytes(env, cipher), c_text(env, attachment_json)) else { return std::ptr::null_mut() };
    let mut out = InvizentBytes { data: std::ptr::null_mut(), len: 0 };
    let words = invizent_file_open(cipher.as_ptr(), cipher.len(), attachment.as_ptr(), &mut out);
    file_answer(env, words, out)
}

/// `FileCore.fileCleanJpeg(jpeg: ByteArray): Any?` — see `invizent_file_clean_jpeg`: the picture alone
/// (`byte[]`), or the words for the person (`String`).
///
/// # Safety
/// Called by the JVM with its own environment pointer and an array of its own (or null).
#[no_mangle]
pub unsafe extern "system" fn Java_com_linea_messenger_attachments_FileCore_fileCleanJpeg(env: *mut JNIEnv, _class: jclass, jpeg: jbyteArray) -> jobject {
    let Some(jpeg) = bytes(env, jpeg) else { return std::ptr::null_mut() };
    let mut out = InvizentBytes { data: std::ptr::null_mut(), len: 0 };
    let words = invizent_file_clean_jpeg(jpeg.as_ptr(), jpeg.len(), &mut out);
    file_answer(env, words, out)
}

// ── Big files (the chunked scheme) ───────────────────────────────────────────────────────────────────────────
//
// The functions of `object ChunkCore` (Kotlin, `com.linea.messenger.video`). One chunk's bytes cross as a Java
// `byte[]`, as a small file's do; the answers are those of `fileSeal` / `fileOpen`. The by-name functions of the
// scheme (`newChunkedEncryption`, `chunks`, `chunk`, `chunkAfter`, `chunked`) go through `FileCore.fileCall`.

/// `ChunkCore.fileSealChunk(plain: ByteArray, encryptionJson: String, index: Long, size: Long): Any?` — see
/// `invizent_file_seal_chunk`: the chunk's ciphertext with its tag (`byte[]`), or the words for the person
/// (`String`). A negative index or size is not a chunk: null.
///
/// # Safety
/// Called by the JVM with its own environment pointer and objects of its own (or null).
#[no_mangle]
pub unsafe extern "system" fn Java_com_linea_messenger_video_ChunkCore_fileSealChunk(env: *mut JNIEnv, _class: jclass, plain: jbyteArray, encryption_json: jstring, index: jlong, size: jlong) -> jobject {
    let (Some(plain), Some(encryption)) = (bytes(env, plain), c_text(env, encryption_json)) else { return std::ptr::null_mut() };
    let (Ok(index), Ok(size)) = (u64::try_from(index), u64::try_from(size)) else { return std::ptr::null_mut() };
    let mut out = InvizentBytes { data: std::ptr::null_mut(), len: 0 };
    let words = invizent_file_seal_chunk(plain.as_ptr(), plain.len(), encryption.as_ptr(), index, size, &mut out);
    file_answer(env, words, out)
}

/// `ChunkCore.fileOpenChunk(cipher: ByteArray, attachmentJson: String, index: Long): Any?` — see
/// `invizent_file_open_chunk`: the chunk's bytes (`byte[]`), or the words for the person (`String`); a chunk
/// that fails its check is never given out. A negative index is not a chunk: null.
///
/// # Safety
/// Called by the JVM with its own environment pointer and objects of its own (or null).
#[no_mangle]
pub unsafe extern "system" fn Java_com_linea_messenger_video_ChunkCore_fileOpenChunk(env: *mut JNIEnv, _class: jclass, cipher: jbyteArray, attachment_json: jstring, index: jlong) -> jobject {
    let (Some(cipher), Some(attachment)) = (bytes(env, cipher), c_text(env, attachment_json)) else { return std::ptr::null_mut() };
    let Ok(index) = u64::try_from(index) else { return std::ptr::null_mut() };
    let mut out = InvizentBytes { data: std::ptr::null_mut(), len: 0 };
    let words = invizent_file_open_chunk(cipher.as_ptr(), cipher.len(), attachment.as_ptr(), index, &mut out);
    file_answer(env, words, out)
}

// ── Cards of links ───────────────────────────────────────────────────────────────────────────────────────────
//
// The function of `object LinkCore` (Kotlin, `com.linea.messenger.linkpreview`).

/// `LinkCore.linkCall(name: String, argsJson: String): String?` — see `invizent_link_call`.
///
/// # Safety
/// Called by the JVM with its own environment pointer and strings of its own (or null).
#[no_mangle]
pub unsafe extern "system" fn Java_com_linea_messenger_linkpreview_LinkCore_linkCall(env: *mut JNIEnv, _class: jclass, name: jstring, args_json: jstring) -> jstring {
    let (Some(name), Some(args)) = (c_text(env, name), c_text(env, args_json)) else { return std::ptr::null_mut() };
    give(env, crate::ffi::invizent_link_call(name.as_ptr(), args.as_ptr()))
}
