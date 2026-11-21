//! The C functions the apps call, called the way they call them.
use invizent_core::e2ee::wire::{safety_code, DeviceIdentity};
use invizent_core::ffi::*;
use invizent_core::json::Value;
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

#[test]
fn server_operations_cross_the_boundary() {
    unsafe {
        let ask = |op: &str, args: &str| { let (op, args, device) = (CString::new(op).unwrap(), CString::new(args).unwrap(), CString::new(r#"{"deviceName":"iPhone","platform":"ios","deviceModel":"iPhone","osVersion":"iOS 26.1","appVersion":"0.17.0"}"#).unwrap()); text(invizent_api_call(op.as_ptr(), args.as_ptr(), device.as_ptr())) };
        assert_eq!(ask("chats", "[]").as_deref(), Some(r#"{"method":"GET","path":"/chats?lean=1"}"#));
        assert_eq!(ask("login", r#"["anna","пароль","слово"]"#).as_deref(), Some(r#"{"method":"POST","path":"/auth/login","body":"{\"username\":\"anna\",\"password\":\"пароль\",\"confirmationWord\":\"слово\",\"deviceName\":\"iPhone\",\"platform\":\"ios\",\"deviceModel\":\"iPhone\",\"osVersion\":\"iOS 26.1\",\"appVersion\":\"0.17.0\"}"}"#));
        assert!(ask("no-such-operation", "[]").is_none());
        assert!(ask("chats", "{}").is_none());
        assert!(invizent_api_call(std::ptr::null(), std::ptr::null(), std::ptr::null()).is_null());
    }
}

#[test]
fn the_device_proof_exchange_crosses_the_boundary() {
    unsafe {
        let proof = invizent_proof_new();
        let call = |input: &str| { let input = CString::new(input).unwrap(); text(invizent_proof_call(proof, input.as_ptr())) };
        assert_eq!(call(r#"{"op":"state","now":1000}"#).as_deref(), Some(r#"{"proof":null,"due":true,"known":false,"generation":0,"renewAfterMs":null}"#));
        // A session not bound yet: challenge → sign for binding → bind → the proof is held.
        assert_eq!(call(r#"{"op":"refresh","force":false,"seen":null,"now":1000}"#).as_deref(), Some(r#"{"post":{"path":"/auth/device/challenge","body":null}}"#));
        assert_eq!(call(r#"{"op":"refresh","force":false,"seen":null,"now":1000}"#).as_deref(), Some(r#"{"refresh":"running"}"#));
        assert_eq!(call(r#"{"op":"reply","hasKey":true,"ok":{"challenge":"c1","sessionId":"s1","bound":false},"now":1100}"#).as_deref(), Some(r#"{"sign":{"message":"invizent-device-bind-v1\ns1\nc1","purpose":"bind"}}"#));
        assert_eq!(call(r#"{"op":"signed","signature":"sig","publicKey":"pub","kind":"hardware","now":1200}"#).as_deref(), Some(r#"{"post":{"path":"/auth/device/bind","body":{"publicKey":"pub","kind":"hardware","signature":"sig"}}}"#));
        assert_eq!(call(r#"{"op":"reply","hasKey":true,"ok":{"proof":"p1","expiresIn":600},"now":1300}"#).as_deref(), Some(r#"{"done":"held"}"#));
        assert_eq!(call(r#"{"op":"state","now":2000}"#).as_deref(), Some(r#"{"proof":"p1","due":false,"known":true,"generation":1,"renewAfterMs":480000}"#));
        assert_eq!(call(r#"{"op":"refresh","force":false,"seen":null,"now":2000}"#).as_deref(), Some(r#"{"refresh":"held"}"#));
        // The server refuses the proof we hold: a new one is proven with the same key; a lost key ends the session here.
        assert_eq!(call(r#"{"op":"refresh","force":true,"seen":1,"now":3000}"#).as_deref(), Some(r#"{"post":{"path":"/auth/device/challenge","body":null}}"#));
        assert_eq!(call(r#"{"op":"reply","hasKey":true,"ok":{"challenge":"c2","sessionId":"s1","bound":true},"now":3100}"#).as_deref(), Some(r#"{"sign":{"message":"invizent-device-proof-v1\ns1\nc2","purpose":"proof"}}"#));
        assert_eq!(call(r#"{"op":"signed","failed":true,"keyChanged":true,"now":3200}"#).as_deref(), Some(r#"{"done":"lost"}"#));
        for bad in ["", "{}", r#"{"op":"state"}"#, r#"{"op":"dance","now":1}"#] { assert!(call(bad).is_none(), "{bad}") }
        invizent_proof_free(proof);
        invizent_proof_free(std::ptr::null_mut());
        assert!(invizent_proof_call(std::ptr::null_mut(), std::ptr::null()).is_null());
    }
}

#[test]
fn what_is_shown_crosses_the_boundary() {
    unsafe {
        let ask = |name: &str, args: &str| { let (name, args) = (CString::new(name).unwrap(), CString::new(args).unwrap()); text(invizent_view(name.as_ptr(), args.as_ptr())) };
        let me = "0f8fad5b-d9cb-469f-a165-70867728950e";
        let message = |id: u32, client: &str, body: &str, meta: &str| format!(r#"{{"id":{id},"chatId":"c","senderId":"{me}","clientId":"{client}","text":"{body}","attachment":null,"createdAt":"2026-11-21T07:00:0{id}.000Z","cryptoState":"decrypted"{meta}}}"#);
        // A message and its edit: one line is shown, with the new text, marked as edited.
        let (first, second) = ("e0000001-0000-4000-8000-000000000001", "e0000002-0000-4000-8000-000000000002");
        let edit = format!(r#","meta":{{"action":{{"type":"edit","target":"{first}","text":"исправленное"}}}}"#);
        let folded = ask("foldChat", &format!(r#"[[{},{}],"{me}",[],1795244500000]"#, message(1, first, "первое", ""), message(2, second, "", &edit))).expect("a fold");
        let folded = invizent_core::json::parse(&folded).unwrap();
        let Some(Value::Array(shown)) = folded.get("messages") else { panic!("messages") };
        assert_eq!(shown.len(), 1, "{}", invizent_core::json::stringify(&folded));
        assert_eq!(shown[0].get("text").and_then(Value::as_str).as_deref(), Some("исправленное"));
        assert_eq!(shown[0].get("edited"), Some(&Value::Bool(true)));
        assert_eq!(ask("chatListText", &format!("[{}]", message(1, "a", "привет", ""))).as_deref(), Some("\"привет\""));
        assert_eq!(ask("nativeText", r#"["Жирный и www.example.com",[{"type":"bold","offset":0,"length":6}]]"#).as_deref(), Some(r#"{"text":"Жирный и www.example.com","fmt":[1,0,6,64,9,15],"urls":["https://www.example.com"]}"#));
        assert_eq!(ask("nativeText", r#"["просто текст",null]"#).as_deref(), Some(r#"{"text":"просто текст","fmt":[],"urls":[]}"#));
        assert_eq!(ask("editWindowOpen", r#"["2026-01-01T00:00:00.000Z",1767312000000]"#).as_deref(), Some("true"));
        assert_eq!(ask("editWindowOpen", r#"["2026-01-01T00:00:00.000Z",1767398400000]"#).as_deref(), Some("false"));
        assert_eq!(ask("actionFallback", r#"[{"type":"pin","target":"0b0b0b0b-0000-4000-8000-000000000001"}," привет "]"#).as_deref(), Some(r#""Закреплено сообщение «привет»""#));
        assert_eq!(ask("actionFallback", r#"[{"type":"nothing"},""]"#).as_deref(), Some("null"));
        assert_eq!(ask("listPreviewMessage", r#"[[{"id":1,"senderId":"a","clientId":"c1","text":"раз","createdAt":"2026-01-01T00:00:00.000Z"},{"id":2,"senderId":"a","clientId":"c2","text":"🗑 Сообщение удалено","createdAt":"2026-01-01T00:00:01.000Z","meta":{"action":{"type":"delete","target":"c9"}}}]]"#).is_some_and(|line| line.contains("раз")), true);
        assert!(ask("foldChat", "[]").is_none() && ask("nothing", "[]").is_none() && ask("chatListText", "{}").is_none());
        assert!(invizent_view(std::ptr::null(), std::ptr::null()).is_null());
    }
}
