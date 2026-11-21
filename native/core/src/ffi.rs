//! The core as the apps call it: plain C functions (Swift and Kotlin both speak C).
//!
//! Text goes in and comes out as NUL-terminated UTF-8. Every text the core hands out is the core's own and
//! must be given back with `invizent_string_free`. Structured values travel as JSON. A function that cannot
//! answer gives a null pointer; nothing here ever unwinds across the boundary.

use crate::e2ee::wire::{safety_code, DeviceIdentity};
use crate::json::{self, Value};
use std::ffi::{c_char, CStr, CString};
use std::panic::catch_unwind;

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
