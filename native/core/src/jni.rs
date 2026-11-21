//! The core as the Android app calls it: the functions of `object Core` (Kotlin, `com.linea.messenger.core`).
//!
//! A thin layer over the C functions in `ffi.rs`, so both phones get the same answers. Texts cross as Java
//! strings (UTF-16), never as the JVM's modified UTF-8. Nothing here unwinds into the JVM.

use crate::ffi::{invizent_core_version, invizent_safety_code, invizent_string_free};
use jni_sys::{jclass, jsize, jstring, JNIEnv};
use std::ffi::{c_char, CStr, CString};
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

/// A text the core handed out, as a Java string; the core's memory is given back. Null stays null.
unsafe fn give(env: *mut JNIEnv, pointer: *mut c_char) -> jstring {
    if pointer.is_null() || env.is_null() { return std::ptr::null_mut() }
    let units: Option<Vec<u16>> = CStr::from_ptr(pointer).to_str().ok().map(|text| text.encode_utf16().collect());
    invizent_string_free(pointer);
    let Some(units) = units else { return std::ptr::null_mut() };
    let (Some(make), Ok(length)) = ((**env).NewString, jsize::try_from(units.len())) else { return std::ptr::null_mut() };
    make(env, units.as_ptr(), length)
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
    let Some(pair) = text(env, pair_json).and_then(|pair| CString::new(pair).ok()) else { return std::ptr::null_mut() };
    let code = catch_unwind(|| invizent_safety_code(pair.as_ptr())).unwrap_or(std::ptr::null_mut());
    give(env, code)
}
