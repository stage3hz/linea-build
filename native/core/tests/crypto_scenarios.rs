//! The encryption service against recordings of the reference itself (`tests/generate-crypto-scenarios.mjs`).
//! For every step the stand-ins hand back what the reference was given, in the same order, and check that the
//! core asks for the same things with the same arguments; then the result and every record in the vault must
//! be the same.
use invizent_core::e2ee::bridge::*;
use invizent_core::e2ee::dispatch::dispatch;
use invizent_core::e2ee::service::{Crypto, CryptoError};
use invizent_core::json::{self, Value};
use serde::Deserialize;
use std::cell::RefCell;
use std::collections::{BTreeMap, VecDeque};
use std::rc::Rc;

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

/// The recorded calls out of the service, shared by the stand-ins.
#[derive(Clone, Default)]
struct Tape { queue: Rc<RefCell<VecDeque<Io>>>, place: Rc<RefCell<String>> }
impl Tape {
    fn next(&self, kind: &str, method: &str, args: Value) -> Io {
        let entry = self.queue.borrow_mut().pop_front().unwrap_or_else(|| panic!("{}: the core asked for {kind} {method} — the reference did not", self.place.borrow()));
        assert_eq!((entry.kind.as_str(), entry.method.as_deref().unwrap_or("")), (kind, method), "{}: another call was expected", self.place.borrow());
        if let Some(recorded) = &entry.args { assert_eq!(json::stringify(&args), *recorded, "{}: arguments of {method}", self.place.borrow()) }
        entry
    }
}
fn value(entry: &Io) -> Value { json::parse(entry.result.as_deref().expect("a result")).expect("JSON") }
fn text(value: &Value, key: &str) -> String { value.get(key).and_then(Value::as_str).expect(key) }
fn signal(entry: &Io) -> Result<Value, SignalError> {
    match &entry.error { Some(message) => Err(SignalError { name: entry.error_name.clone().unwrap_or_default(), code: String::new(), message: message.clone() }), None => Ok(value(entry)) }
}
fn answer(entry: &Io) -> Result<Value, TransportError> {
    match entry.error.as_deref() { Some("network") => Err(TransportError::Network("Нет связи с сервером.".to_string())), Some(message) => Err(TransportError::Refused(message.to_string())), None => Ok(value(entry)) }
}
fn number(n: u32) -> Value { Value::Number(n as f64) }

struct Bridge(Tape);
impl SignalBridge for Bridge {
    fn create_state(&mut self, address: &str, device_id: u32) -> Result<(String, Value), SignalError> {
        let made = signal(&self.0.next("bridge", "createState", Value::Array(vec![Value::str(address), number(device_id)])))?;
        Ok((text(&made, "state"), made.get("bundle").cloned().unwrap()))
    }
    fn replenish(&mut self, state: &str, count: u32) -> Result<(String, Value), SignalError> {
        let made = signal(&self.0.next("bridge", "replenish", Value::Array(vec![Value::str(state), number(count)])))?;
        Ok((text(&made, "state"), made.get("bundle").cloned().unwrap()))
    }
    fn trust_identity(&mut self, state: &str, address: &str, device_id: u32, identity_key: &str) -> Result<String, SignalError> {
        Ok(text(&signal(&self.0.next("bridge", "trustIdentity", Value::Array(vec![Value::str(state), Value::str(address), number(device_id), Value::str(identity_key)])))?, "state"))
    }
    fn encrypt(&mut self, state: &str, address: &str, device_id: u32, plaintext: &str, bundle: Option<&Value>) -> Result<Sealed, SignalError> {
        let made = signal(&self.0.next("bridge", "encrypt", Value::Array(vec![Value::str(state), Value::str(address), number(device_id), Value::str(plaintext), bundle.cloned().unwrap_or(Value::Null)])))?;
        let Some(Value::Number(kind)) = made.get("type") else { panic!("a type") };
        Ok(Sealed { state: text(&made, "state"), kind: *kind, body: text(&made, "body") })
    }
    fn decrypt(&mut self, state: &str, address: &str, device_id: u32, kind: f64, body: &str) -> Result<Opened, SignalError> {
        let made = signal(&self.0.next("bridge", "decrypt", Value::Array(vec![Value::str(state), Value::str(address), number(device_id), Value::Number(kind), Value::str(body)])))?;
        Ok(Opened { state: text(&made, "state"), plaintext: text(&made, "plaintext") })
    }
}
struct Server(Tape);
impl CryptoTransport for Server {
    fn register_crypto_device(&mut self, device_id: &str, bundle: &Value) -> Result<Value, TransportError> { answer(&self.0.next("transport", "registerCryptoDevice", Value::Array(vec![Value::str(device_id), bundle.clone()]))) }
    fn crypto_devices(&mut self, user_id: &str) -> Result<Value, TransportError> { answer(&self.0.next("transport", "cryptoDevices", Value::Array(vec![Value::str(user_id)]))) }
    fn claim_pre_key(&mut self, user_id: &str, device_id: &str) -> Result<Value, TransportError> { answer(&self.0.next("transport", "claimPreKey", Value::Array(vec![Value::str(user_id), Value::str(device_id)]))) }
    fn crypto_inbox(&mut self, device_id: &str, chat_id: &str, after: f64) -> Result<Value, TransportError> { answer(&self.0.next("transport", "cryptoInbox", Value::Array(vec![Value::str(device_id), Value::str(chat_id), Value::Number(after)]))) }
}
struct Clock(Tape);
impl Env for Clock {
    fn now_iso(&mut self) -> String { self.0.next("now", "", Value::Null).result.expect("a time") }
    fn random_uuid(&mut self) -> String { self.0.next("uuid", "", Value::Null).result.expect("an id") }
}
#[derive(Clone, Default)]
struct Memory(Rc<RefCell<BTreeMap<String, String>>>);
impl Vault for Memory {
    fn get(&self, key: &str) -> Option<String> { self.0.borrow().get(key).cloned() }
    fn commit(&mut self, changes: Vec<(String, Option<String>)>) {
        let mut map = self.0.borrow_mut();
        for (key, value) in changes { match value { Some(value) => { map.insert(key, value); } None => { map.remove(&key); } } }
    }
}

#[test]
fn the_service_does_exactly_what_the_reference_does() {
    let scenarios: Vec<Scenario> = serde_json::from_str(include_str!("vectors/crypto-scenarios.json")).expect("vectors");
    assert!(scenarios.len() >= 27);
    let mut steps_run = 0;
    for scenario in &scenarios {
        let tape = Tape::default();
        let memory = Memory::default();
        let mut expected: BTreeMap<String, String> = BTreeMap::new();
        let make = |auto_trust: bool| Crypto::new(&scenario.user_id, Bridge(tape.clone()), memory.clone(), Server(tape.clone()), Clock(tape.clone()), auto_trust,
            Box::new(|preview: Option<&Value>| preview.is_none() || preview.and_then(Value::as_str).as_deref() == Some("OK")));
        let mut service = make(false);
        for (index, step) in scenario.steps.iter().enumerate() {
            let place = format!("«{}», step {} ({} {})", scenario.name, index, step.op, step.args.chars().take(120).collect::<String>());
            *tape.place.borrow_mut() = place.clone();
            *tape.queue.borrow_mut() = step.io.iter().cloned().collect();
            let Value::Array(args) = json::parse(&step.args).expect("arguments") else { panic!("arguments") };
            let outcome: Result<Option<String>, CryptoError> = match step.op.as_str() {
                "new" => { service = make(matches!(args[0].get("autoTrust"), Some(Value::Bool(true)))); Ok(None) }
                op => dispatch(&mut service, op, &args).map(|answer| if matches!(answer, Value::Null) { None } else { Some(json::stringify(&answer)) }),
            };
            match (&outcome, &step.error) {
                (Ok(result), None) => assert_eq!(result, &step.ok, "{place}: the result"),
                // The words of these two are the JavaScript engine's own; the kind is what counts.
                (Err(error), Some(wanted)) if matches!(wanted.name.as_str(), "SyntaxError" | "TypeError") => assert_eq!(error.name(), wanted.name, "{place}: the refusal"),
                (Err(error), Some(wanted)) => assert_eq!((error.name(), error.message()), (wanted.name.as_str(), wanted.message.as_str()), "{place}: the refusal"),
                (Ok(_), Some(wanted)) => panic!("{place}: the reference refused with «{}», the core did not", wanted.message),
                (Err(error), None) => panic!("{place}: the core refused with «{}», the reference did not", error.message()),
            }
            assert!(tape.queue.borrow().is_empty(), "{place}: the reference made {} more call(s) out: {:?}", tape.queue.borrow().len(), tape.queue.borrow().front());
            for (key, value) in &step.set { expected.insert(key.clone(), value.clone()); }
            for key in &step.removed { expected.remove(key); }
            let held = memory.0.borrow();
            if *held != expected {
                for (key, value) in expected.iter() { assert_eq!(held.get(key), Some(value), "{place}: the record {key}") }
                for key in held.keys() { assert!(expected.contains_key(key), "{place}: the core wrote {key}, the reference did not") }
            }
            steps_run += 1;
        }
    }
    assert!(steps_run >= 380, "{steps_run} steps");
}
