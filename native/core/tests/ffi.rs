//! The C functions the apps call, called the way they call them.
use invizent_core::e2ee::wire::{safety_code, DeviceIdentity};
use invizent_core::ffi::*;
use std::ffi::{CStr, CString};

unsafe fn text(pointer: *mut std::ffi::c_char) -> Option<String> {
    if pointer.is_null() { return None }
    let out = CStr::from_ptr(pointer).to_str().unwrap().to_string();
    invizent_string_free(pointer);
    Some(out)
}

#[test]
fn version_and_safety_code_cross_the_boundary() {
    unsafe {
        assert_eq!(text(invizent_core_version()).as_deref(), Some(env!("CARGO_PKG_VERSION")));
        let own = DeviceIdentity { user_id: "0f8fad5b-d9cb-469f-a165-70867728950e".into(), device_id: "00000000-0000-4000-8000-000000000001".into(), identity_key: "A".repeat(44), registration_id: 77.0 };
        let other = DeviceIdentity { user_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7".into(), device_id: "d0000001-0000-4000-8000-000000000001".into(), identity_key: "B".repeat(44), registration_id: 16000.0 };
        let pair = format!(r#"{{"own":{{"userId":"{}","deviceId":"{}","identityKey":"{}","registrationId":77}},"other":{{"userId":"{}","deviceId":"{}","identityKey":"{}","registrationId":16000}}}}"#, own.user_id, own.device_id, own.identity_key, other.user_id, other.device_id, other.identity_key);
        let input = CString::new(pair).unwrap();
        let code = text(invizent_safety_code(input.as_ptr())).expect("a code");
        assert_eq!(code, safety_code(&own, &other));
        assert_eq!(code.len(), 64 + 15);
        // What is not a pair of devices gets no answer, and nothing breaks.
        for bad in ["", "{", "{}", r#"{"own":{},"other":{}}"#, "null"] {
            let input = CString::new(bad).unwrap();
            assert!(invizent_safety_code(input.as_ptr()).is_null(), "{bad}");
        }
        assert!(invizent_safety_code(std::ptr::null()).is_null());
        invizent_string_free(std::ptr::null_mut());
    }
}

#[test]
fn requests_and_answers_cross_the_boundary() {
    unsafe {
        let ask = |json: &str| { let input = CString::new(json).unwrap(); text(invizent_http_prepare(input.as_ptr())) };
        let made = ask(r#"{"method":"post","path":"/auth/login","jsonBody":true,"version":"0.17.0","platform":"ios","nowMs":1795244400000}"#).expect("headers");
        assert_eq!(made, r#"{"headers":[["X-Linea-Client","invizent; v=0.17.0; p=ios"],["Content-Type","application/json"]],"timeoutMs":45000}"#);
        let signed_in = ask(r#"{"path":"/chats?lean=1","version":"0.17.0","platform":"android","token":"t0ken","proof":"pr00f","nowMs":1}"#).expect("headers");
        assert!(signed_in.contains(r#"["Authorization","Bearer t0ken"],["X-Linea-Proof","pr00f"]"#) && signed_in.contains("p=android") && !signed_in.contains("Content-Type"), "{signed_in}");
        for bad in ["", "{}", r#"{"path":"/x","version":"1","platform":"windows","nowMs":1}"#, r#"{"path":"/x","version":"1","platform":"ios"}"#] { assert!(ask(bad).is_none(), "{bad}") }
        assert!(invizent_http_prepare(std::ptr::null()).is_null());

        let read = |status: u16, body: &str| { let input = CString::new(body).unwrap(); text(invizent_http_read(status, input.as_ptr())).unwrap() };
        assert_eq!(read(200, r#"{"chats":[]}"#), r#"{"ok":{"chats":[]},"serverOk":true,"updateRequired":false}"#);
        assert_eq!(read(200, "не JSON"), r#"{"ok":{},"serverOk":true,"updateRequired":false}"#);
        assert_eq!(read(401, r#"{"error":"Неверный пароль.","attemptsLeft":4,"code":"bad_password"}"#), r#"{"refused":{"message":"Неверный пароль.","status":401,"code":"bad_password","attemptsLeft":4},"serverOk":true,"updateRequired":false}"#);
        assert_eq!(read(426, "{}"), r#"{"refused":{"message":"Не удалось выполнить запрос. Попробуй ещё раз.","status":426},"serverOk":true,"updateRequired":true}"#);
        assert_eq!(read(503, "<html>"), r#"{"serverDown":true,"serverOk":false,"updateRequired":false}"#);
        assert!(text(invizent_http_read(500, std::ptr::null())).unwrap().contains("\"refused\""));
    }
}
