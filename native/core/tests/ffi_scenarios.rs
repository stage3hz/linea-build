//! The recorded scenarios once more, this time through the C functions the apps call: the app's side (Signal
//! library, storage, server, clock) is played by C callbacks that hand back what the reference was given.
use invizent_core::ffi::*;
use invizent_core::json::{self, Value};
use serde::Deserialize;
use std::cell::RefCell;
use std::collections::{BTreeMap, VecDeque};
use std::ffi::{c_char, c_void, CStr, CString};

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Io { kind: String, method: Option<String>, args: Option<String>, result: Option<String>, error: Option<String>, error_name: Option<String> }
#[derive(Deserialize)]
struct Failure { name: String, message: String }
#[derive(Deserialize)]
struct Step { op: String, args: String, ok: Option<String>, error: Option<Failure>, io: Vec<Io>, set: BTreeMap<String, String>, removed: Vec<String> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scenario { name: String, user_id: String, steps: Vec<Step> }

#[derive(Default)]
struct World { queue: RefCell<VecDeque<Io>>, place: RefCell<String>, vault: RefCell<BTreeMap<String, String>>, wrong: RefCell<Vec<String>> }
impl World {
    fn next(&self, kind: &str, method: &str, args: Option<&str>) -> Option<Io> {
        let Some(entry) = self.queue.borrow_mut().pop_front() else { self.wrong.borrow_mut().push(format!("{}: {kind} {method} was not asked for by the reference", self.place.borrow())); return None };
        if entry.kind != kind || entry.method.as_deref().unwrap_or("") != method { self.wrong.borrow_mut().push(format!("{}: {kind} {method} instead of {} {:?}", self.place.borrow(), entry.kind, entry.method)) }
        if let (Some(args), Some(recorded)) = (args, &entry.args) { if args != recorded { self.wrong.borrow_mut().push(format!("{}: arguments of {method}: {args} instead of {recorded}", self.place.borrow())) } }
        Some(entry)
    }
}

extern "C" { fn malloc(size: usize) -> *mut c_void; }
/// A text allocated the way an app allocates it.
fn hand(text: &str) -> *mut c_char {
    let bytes = text.as_bytes();
    unsafe {
        let pointer = malloc(bytes.len() + 1).cast::<u8>();
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer, bytes.len());
        *pointer.add(bytes.len()) = 0;
        pointer.cast()
    }
}
unsafe fn read(text: *const c_char) -> String { CStr::from_ptr(text).to_str().unwrap().to_string() }
unsafe fn world<'a>(context: *mut c_void) -> &'a World { &*(context as *const World) }

extern "C" fn bridge(context: *mut c_void, method: *const c_char, args: *const c_char) -> *mut c_char {
    let (world, method, args) = unsafe { (world(context), read(method), read(args)) };
    let Some(entry) = world.next("bridge", &method, Some(&args)) else { return std::ptr::null_mut() };
    match &entry.error {
        Some(message) => hand(&json::stringify(&json::object(vec![("error", json::object(vec![("name", Value::str(entry.error_name.as_deref().unwrap_or(""))), ("code", Value::str("")), ("message", Value::str(message))]))]))),
        None => hand(&format!("{{\"ok\":{}}}", entry.result.unwrap())),
    }
}
extern "C" fn transport(context: *mut c_void, method: *const c_char, args: *const c_char) -> *mut c_char {
    let (world, method, args) = unsafe { (world(context), read(method), read(args)) };
    let Some(entry) = world.next("transport", &method, Some(&args)) else { return std::ptr::null_mut() };
    match entry.error.as_deref() {
        Some("network") => hand(&json::stringify(&json::object(vec![("network", Value::str("Нет связи с сервером."))]))),
        Some(message) => hand(&json::stringify(&json::object(vec![("refused", Value::str(message))]))),
        None => hand(&format!("{{\"ok\":{}}}", entry.result.unwrap())),
    }
}
extern "C" fn vault_get(context: *mut c_void, key: *const c_char) -> *mut c_char {
    let (world, key) = unsafe { (world(context), read(key)) };
    world.vault.borrow().get(&key).map_or(std::ptr::null_mut(), |value| hand(value))
}
extern "C" fn vault_commit(context: *mut c_void, changes: *const c_char) {
    let (world, changes) = unsafe { (world(context), read(changes)) };
    let Ok(Value::Array(list)) = json::parse(&changes) else { panic!("changes") };
    let mut vault = world.vault.borrow_mut();
    for change in list {
        let Value::Array(pair) = change else { panic!("a change") };
        match pair[1].as_str() { Some(value) => { vault.insert(pair[0].as_str().unwrap(), value); } None => { vault.remove(&pair[0].as_str().unwrap()); } }
    }
}
extern "C" fn now_iso(context: *mut c_void) -> *mut c_char { unsafe { world(context) }.next("now", "", None).and_then(|entry| entry.result).map_or(std::ptr::null_mut(), |text| hand(&text)) }
extern "C" fn random_uuid(context: *mut c_void) -> *mut c_char { unsafe { world(context) }.next("uuid", "", None).and_then(|entry| entry.result).map_or(std::ptr::null_mut(), |text| hand(&text)) }

#[test]
fn the_scenarios_hold_through_the_c_functions() {
    let scenarios: Vec<Scenario> = serde_json::from_str(include_str!("vectors/crypto-scenarios.json")).expect("vectors");
    let mut steps_run = 0;
    for scenario in &scenarios {
        let world = Box::new(World::default());
        let host = InvizentHost { context: (&*world as *const World).cast_mut().cast(), bridge: Some(bridge), vault_get, vault_commit, transport, now_iso: Some(now_iso), random_uuid: Some(random_uuid) };
        let user = CString::new(scenario.user_id.as_str()).unwrap();
        let mut crypto: *mut InvizentCrypto = std::ptr::null_mut();
        let mut expected: BTreeMap<String, String> = BTreeMap::new();
        for (index, step) in scenario.steps.iter().enumerate() {
            let place = format!("«{}», step {} ({})", scenario.name, index, step.op);
            *world.place.borrow_mut() = place.clone();
            *world.queue.borrow_mut() = step.io.iter().cloned().collect();
            if step.op == "new" {
                let Value::Array(args) = json::parse(&step.args).unwrap() else { panic!() };
                unsafe { invizent_crypto_free(crypto); crypto = invizent_crypto_new(user.as_ptr(), matches!(args[0].get("autoTrust"), Some(Value::Bool(true))), &host); }
                assert!(!crypto.is_null());
                continue;
            }
            let (op, args) = (CString::new(step.op.as_str()).unwrap(), CString::new(step.args.as_str()).unwrap());
            let answer = unsafe { let pointer = invizent_crypto_call(crypto, op.as_ptr(), args.as_ptr()); let text = read(pointer); invizent_string_free(pointer); text };
            let answer = json::parse(&answer).expect("an answer in JSON");
            assert!(world.wrong.borrow().is_empty(), "{:?}", world.wrong.borrow());
            match (&step.error, answer.get("error")) {
                (None, None) => { let ok = answer.get("ok").expect("ok"); assert_eq!(if matches!(ok, Value::Null) { None } else { Some(json::stringify(ok)) }, step.ok, "{place}: the result") }
                (Some(wanted), Some(error)) => {
                    assert_eq!(error.get("name").and_then(Value::as_str).as_deref(), Some(wanted.name.as_str()), "{place}: the refusal's kind");
                    if !matches!(wanted.name.as_str(), "SyntaxError" | "TypeError") { assert_eq!(error.get("message").and_then(Value::as_str).as_deref(), Some(wanted.message.as_str()), "{place}: the refusal") }
                }
                (wanted, got) => panic!("{place}: the reference {} — the core {}", wanted.as_ref().map_or("answered".to_string(), |e| format!("refused with «{}»", e.message)), got.map_or("answered".to_string(), |e| format!("refused with {}", json::stringify(e)))),
            }
            assert!(world.queue.borrow().is_empty(), "{place}: the reference made more calls out");
            for (key, value) in &step.set { expected.insert(key.clone(), value.clone()); }
            for key in &step.removed { expected.remove(key); }
            assert_eq!(*world.vault.borrow(), expected, "{place}: the vault");
            steps_run += 1;
        }
        unsafe { invizent_crypto_free(crypto) };
    }
    assert!(steps_run >= 350, "{steps_run} steps");
}

#[test]
fn bad_calls_get_an_answer_not_a_crash() {
    extern "C" fn nothing(_: *mut c_void, _: *const c_char, _: *const c_char) -> *mut c_char { std::ptr::null_mut() }
    extern "C" fn none(_: *mut c_void, _: *const c_char) -> *mut c_char { std::ptr::null_mut() }
    extern "C" fn drop_changes(_: *mut c_void, _: *const c_char) {}
    let host = InvizentHost { context: std::ptr::null_mut(), bridge: None, vault_get: none, vault_commit: drop_changes, transport: nothing, now_iso: None, random_uuid: None };
    let user = CString::new("0f8fad5b-d9cb-469f-a165-70867728950e").unwrap();
    unsafe {
        assert!(invizent_crypto_new(std::ptr::null(), true, &host).is_null());
        assert!(invizent_crypto_new(user.as_ptr(), true, std::ptr::null()).is_null());
        let crypto = invizent_crypto_new(user.as_ptr(), true, &host);
        let call = |op: &str, args: &str| { let (op, args) = (CString::new(op).unwrap(), CString::new(args).unwrap()); let pointer = invizent_crypto_call(crypto, op.as_ptr(), args.as_ptr()); let text = read(pointer); invizent_string_free(pointer); text };
        // The app's side answers nothing at all: the Signal library is silent, so no keys can be made.
        assert!(call("initialize", "[]").contains("\"error\""));
        assert!(call("no-such-thing", "[]").contains("Unknown operation"));
        assert!(call("encrypt", "{}").contains("Bad arguments"));
        assert!(call("encrypt", "[]").contains("\"error\""));
        assert_eq!(call("historyChats", "[]"), "{\"ok\":[]}");
        assert_eq!(call("loadCache", "[\"device\"]"), "{\"error\":{\"name\":\"Error\",\"message\":\"Unknown cache entry.\"}}");
        assert!(invizent_crypto_call(std::ptr::null_mut(), std::ptr::null(), std::ptr::null()).is_null());
        invizent_crypto_free(crypto);
        invizent_crypto_free(std::ptr::null_mut());
    }
}
