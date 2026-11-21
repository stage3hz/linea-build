//! What the Signal tests share: two parties, bundles as the server hands them out, and how a refusal reads.
#![allow(dead_code)]

use invizent_core::e2ee::bridge::{Opened, Sealed, SignalBridge, SignalError};
use invizent_core::json;
use invizent_core::signal::LibSignal;
use serde_json::{json, Value};

pub fn to_core(value: &Value) -> json::Value { json::parse(&value.to_string()).expect("JSON") }
pub fn from_core(value: &json::Value) -> Value { serde_json::from_str(&json::stringify(value)).expect("JSON") }
pub fn state_json(state: &str) -> Value { serde_json::from_str(state).expect("the state is JSON") }

/// The bundle one sender is given: the public bundle with a single one-time prekey (or none).
pub fn claimed(bundle: &Value, pre_key: Option<usize>) -> Value {
    let mut out = json!({ "registrationId": bundle["registrationId"], "identityKey": bundle["identityKey"], "signedPreKey": bundle["signedPreKey"], "kyberPreKey": bundle["kyberPreKey"] });
    if let Some(index) = pre_key { out["preKey"] = bundle["preKeys"][index].clone() }
    out
}

/// The reason of a refusal by the bridge (`TRUST_REQUIRED`), or `CRYPTO_FAILED` for the library's.
pub fn reason(error: &SignalError) -> &str { error.code.strip_prefix("ERR_LINEA_SIGNAL_").expect("the code the apps know") }

/// `lane_session_error` of `src/e2ee/service.rs`, word for word: a lost or expired session, not a refusal over identity or trust.
pub fn reads_as_lost_session(error: &SignalError) -> bool {
    let text = format!("{} {} {}", error.name, error.code, error.message).to_lowercase();
    (text.contains("session") || text.contains("unacknowledged")) && !(text.contains("identity") || text.contains("trust"))
}

/// A device driven by the Rust bridge.
pub struct Party { pub name: String, pub state: String, pub bundle: Value }

impl Party {
    pub fn new(name: &str) -> Party {
        let (state, bundle) = LibSignal.create_state(name, 1).expect("a new state");
        Party { name: name.to_string(), state, bundle: from_core(&bundle) }
    }
    pub fn from_state(name: &str, state: &str) -> Party { Party { name: name.to_string(), state: state.to_string(), bundle: Value::Null } }
    pub fn identity(&self) -> String { self.bundle["identityKey"].as_str().expect("an identity key").to_string() }
    pub fn trust(&mut self, name: &str, identity: &str) { self.state = LibSignal.trust_identity(&self.state, name, 1, identity).expect("pinned") }
    pub fn try_seal(&self, to: &str, text: &str, bundle: Option<&Value>) -> Result<Sealed, SignalError> {
        let bundle = bundle.map(to_core);
        LibSignal.encrypt(&self.state, to, 1, text, bundle.as_ref())
    }
    pub fn seal(&mut self, to: &str, text: &str, bundle: Option<&Value>) -> (f64, String) {
        let sealed = self.try_seal(to, text, bundle).expect("encrypted");
        self.state = sealed.state;
        (sealed.kind, sealed.body)
    }
    pub fn try_open(&self, from: &str, message: &(f64, String)) -> Result<Opened, SignalError> { LibSignal.decrypt(&self.state, from, 1, message.0, &message.1) }
    pub fn open(&mut self, from: &str, message: &(f64, String)) -> String {
        let opened = self.try_open(from, message).expect("decrypted");
        self.state = opened.state;
        opened.plaintext
    }
}

/// Two devices that have pinned each other's identity.
pub fn pair(first: &str, second: &str) -> (Party, Party) {
    let (mut a, mut b) = (Party::new(first), Party::new(second));
    a.trust(second, &b.identity());
    b.trust(first, &a.identity());
    (a, b)
}
