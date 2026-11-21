//! The device-bound session exchange, case for case with the reference tests (`mobile/test/device-proof.test.mjs`),
//! against a stand-in server that checks signatures by the server's own rule (`server/src/devicebind.js`):
//! ECDSA P-256 / SHA-256 over the message, the public key as a base64url 65-byte point.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use invizent_core::device_proof::*;
use invizent_core::json::{self, Value};
use p256::ecdsa::{signature::{Signer, Verifier}, DerSignature, Signature, SigningKey, VerifyingKey};

struct Key { signing: SigningKey, point: String }
fn software_key() -> Key {
    let signing = SigningKey::random(&mut rand_core::OsRng);
    let point = URL_SAFE_NO_PAD.encode(signing.verifying_key().to_encoded_point(false).as_bytes());
    Key { signing, point }
}
impl Key {
    fn sign(&self, message: &str) -> Signed {
        let signature: DerSignature = self.signing.sign(message.as_bytes());
        Signed::Ok { signature: URL_SAFE_NO_PAD.encode(signature.as_bytes()), public_key: self.point.clone(), kind: KeyKind::Hardware }
    }
}

fn signature_valid(point: &str, message: &str, signature: &str) -> bool {
    let Ok(point) = URL_SAFE_NO_PAD.decode(point) else { return false };
    let Ok(key) = VerifyingKey::from_sec1_bytes(&point) else { return false };
    let Ok(bytes) = URL_SAFE_NO_PAD.decode(signature) else { return false };
    if bytes.len() == 64 { if let Ok(raw) = Signature::from_slice(&bytes) { if key.verify(message.as_bytes(), &raw).is_ok() { return true } } }
    DerSignature::from_bytes(&bytes).map(|der| key.verify(message.as_bytes(), &der).is_ok()).unwrap_or(false)
}

/// The server's three routes.
#[derive(Default)]
struct Server { bound: Option<String>, challenge: Option<String>, calls: Vec<&'static str>, proofs: u32, bind_races: bool }
impl Server {
    fn refuse(status: u16, code: &str) -> Reply { Reply::Refused { status, code: code.to_string() } }
    fn post(&mut self, path: &'static str, body: Option<&Value>, racing_key: Option<&str>) -> Reply {
        // «Bound a moment ago by another request»: the first bind finds the session already bound.
        if path == BIND_PATH && self.bind_races { self.bind_races = false; self.bound = racing_key.map(str::to_string); }
        self.calls.push(path);
        if path == CHALLENGE_PATH {
            let challenge = format!("c{}", self.calls.len());
            self.challenge = Some(challenge.clone());
            return Reply::Ok(json::object(vec![("challenge", Value::str(&challenge)), ("sessionId", Value::str("session-1")), ("bound", Value::Bool(self.bound.is_some()))]));
        }
        let purpose = if path == BIND_PATH { Purpose::Bind } else { Purpose::Proof };
        if purpose == Purpose::Bind && self.bound.is_some() { return Self::refuse(409, "device_bound") }
        let Some(challenge) = self.challenge.clone() else { return Self::refuse(409, "device_challenge") };
        let body = body.expect("a body");
        let key = if purpose == Purpose::Bind { body.get("publicKey").and_then(Value::as_str) } else { self.bound.clone() }.expect("a key");
        let signature = body.get("signature").and_then(Value::as_str).expect("a signature");
        if !signature_valid(&key, &device_message(purpose, "session-1", &challenge), &signature) { return Self::refuse(403, "device_signature") }
        self.challenge = None;
        if purpose == Purpose::Bind { self.bound = Some(key) }
        self.proofs += 1;
        Reply::Ok(json::object(vec![("proof", Value::str(&format!("proof-{}", self.proofs))), ("expiresIn", Value::Number(600.0))]))
    }
}

/// Runs the steps to the end, the way an app does. `sign`: what the device key answers.
fn run(proof: &mut DeviceProof, server: &mut Server, first: Step, has_key: bool, now: i64, sign: &dyn Fn(&str) -> Signed, racing_key: Option<&str>) -> Result<bool, ProofError> {
    let mut step = first;
    loop {
        step = match step {
            Step::Post { path, body } => { let reply = server.post(path, body.as_ref(), racing_key); proof.on_reply(reply, has_key, now) }
            Step::Sign { message, .. } => proof.on_signed(sign(&message), now),
            Step::Done(result) => return result,
        };
    }
}
fn refresh(proof: &mut DeviceProof, server: &mut Server, key: Option<&Key>, force: bool, seen: Option<u64>, now: i64) -> Result<bool, ProofError> {
    match proof.refresh(force, seen, now) {
        Refresh::Held => Ok(true),
        Refresh::NotUsed => Ok(false),
        Refresh::Running => panic!("no exchange is running between calls in these tests"),
        Refresh::Start(step) => run(proof, server, step, key.is_some(), now, &|message| key.expect("asked to sign without a key").sign(message), None),
    }
}

#[test]
fn messages_match_the_server() {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Case { purpose: String, session_id: String, challenge: String, message: String }
    let cases: Vec<Case> = serde_json::from_str(include_str!("vectors/device-message.json")).expect("vectors");
    assert!(cases.len() >= 4);
    for case in cases {
        let purpose = if case.purpose == "bind" { Purpose::Bind } else { Purpose::Proof };
        assert_eq!(device_message(purpose, &case.session_id, &case.challenge), case.message);
    }
}

#[test]
fn first_run_binds_then_the_same_key_only_proves() {
    let device = software_key();
    let (mut server, mut proof, mut now) = (Server::default(), DeviceProof::new(), 1_000_000i64);
    assert_eq!(proof.current(now), None);
    assert!(proof.due(now));
    assert!(!proof.known(), "not yet known to need a proof: requests are not held back");
    assert_eq!(refresh(&mut proof, &mut server, Some(&device), false, None, now), Ok(true));
    assert_eq!(server.bound.as_deref(), Some(device.point.as_str()));
    assert_eq!(proof.current(now), Some("proof-1"));
    assert!(proof.known());
    assert!(!proof.due(now));
    assert_eq!(server.calls, vec![CHALLENGE_PATH, BIND_PATH]);
    assert_eq!(proof.renew_after_ms(), Some(600_000 - PROOF_MARGIN_MS - 30_000));
    // Still fresh: nothing is asked again.
    assert_eq!(refresh(&mut proof, &mut server, Some(&device), false, None, now), Ok(true));
    assert_eq!(server.calls.len(), 2);
    // Close to its end: renewed by a signature, not by binding again.
    now += 600_000 - PROOF_MARGIN_MS + 1;
    assert!(proof.due(now));
    assert_eq!(refresh(&mut proof, &mut server, Some(&device), false, None, now), Ok(true));
    assert_eq!(proof.current(now), Some("proof-2"));
    assert_eq!(server.calls[2..], [CHALLENGE_PATH, PROOF_PATH]);
    now += 600_001;
    assert_eq!(proof.current(now), None, "an expired proof is not sent");
}

#[test]
fn requests_that_arrive_together_share_one_exchange() {
    let (mut server, mut proof) = (Server::default(), DeviceProof::new());
    let Refresh::Start(step) = proof.refresh(false, None, 0) else { panic!("the first request starts the exchange") };
    // While it runs, the others are told to wait for it — forced or not.
    assert_eq!(proof.refresh(false, None, 0), Refresh::Running);
    assert_eq!(proof.refresh(true, None, 0), Refresh::Running);
    let device = software_key();
    assert_eq!(run(&mut proof, &mut server, step, true, 0, &|message| device.sign(message), None), Ok(true));
    assert_eq!(server.calls.len(), 2);
}

#[test]
fn requests_refused_together_renew_the_proof_once() {
    let device = software_key();
    let (mut server, mut proof) = (Server::default(), DeviceProof::new());
    let seen = proof.generation(); // three requests leave before any proof exists
    for _ in 0..3 { assert_eq!(refresh(&mut proof, &mut server, Some(&device), true, Some(seen), 0), Ok(true)); }
    assert_eq!(server.calls.len(), 2, "one exchange served all three");
    assert_eq!(proof.current(0), Some("proof-1"));
    // A request sent with the newest proof and still refused does get a new one.
    let newest = proof.generation();
    assert_eq!(refresh(&mut proof, &mut server, Some(&device), true, Some(newest), 0), Ok(true));
    assert_eq!(proof.current(0), Some("proof-2"));
}

#[test]
fn an_older_server_no_key_or_a_broken_key_leave_the_session_as_it_was() {
    // An older server: the route does not exist.
    let mut none = DeviceProof::new();
    let Refresh::Start(_) = none.refresh(false, None, 0) else { panic!() };
    assert_eq!(none.on_reply(Reply::Refused { status: 404, code: String::new() }, true, 0), Step::Done(Ok(false)));
    assert!(!none.due(0), "not asked again in this run");
    assert_eq!(none.current(0), None);
    assert_eq!(none.refresh(false, None, 0), Refresh::NotUsed);
    // No key on this device: it stays unbound.
    let (mut server, mut no_key) = (Server::default(), DeviceProof::new());
    assert_eq!(refresh(&mut no_key, &mut server, None, false, None, 0), Ok(false));
    assert_eq!(server.bound, None);
    // A key that does not work.
    let (mut server, mut broken) = (Server::default(), DeviceProof::new());
    let Refresh::Start(step) = broken.refresh(false, None, 0) else { panic!() };
    assert_eq!(run(&mut broken, &mut server, step, true, 0, &|_| Signed::Failed { key_changed: false }, None), Ok(false));
    assert!(!broken.due(0));
}

#[test]
fn bound_to_another_key_is_lost_a_passing_failure_is_not() {
    let owner = software_key();
    let bound = || Server { bound: Some(owner.point.clone()), ..Server::default() };
    // Another device's token copied here: there is a key, but not the one the session knows.
    let stranger = software_key();
    assert_eq!(refresh(&mut DeviceProof::new(), &mut bound(), Some(&stranger), false, None, 0), Err(ProofError::Lost));
    // No key at all.
    assert_eq!(refresh(&mut DeviceProof::new(), &mut bound(), None, false, None, 0), Err(ProofError::Lost));
    // The chip was cleared.
    assert!(key_changed("Error invoking remote method 'x': Error: TPM key changed"));
    let mut cleared = DeviceProof::new();
    let Refresh::Start(step) = cleared.refresh(false, None, 0) else { panic!() };
    assert_eq!(run(&mut cleared, &mut bound(), step, true, 0, &|_| Signed::Failed { key_changed: true }, None), Err(ProofError::Lost));
    // The key is busy for a moment.
    let (mut server, mut flaky, mut now) = (bound(), DeviceProof::new(), 0i64);
    let Refresh::Start(step) = flaky.refresh(false, None, now) else { panic!() };
    assert_eq!(run(&mut flaky, &mut server, step, true, now, &|_| Signed::Failed { key_changed: false }, None), Err(ProofError::Unavailable));
    assert!(!flaky.due(now), "the next request does not hammer the key");
    now += PROOF_RETRY_MS;
    assert!(flaky.due(now));
    assert_eq!(refresh(&mut flaky, &mut server, Some(&owner), false, None, now), Ok(true));
}

#[test]
fn bound_a_moment_ago_by_another_request_turns_into_a_proof() {
    let device = software_key();
    let (mut server, mut proof) = (Server { bind_races: true, ..Server::default() }, DeviceProof::new());
    let Refresh::Start(step) = proof.refresh(false, None, 0) else { panic!() };
    assert_eq!(run(&mut proof, &mut server, step, true, 0, &|message| device.sign(message), Some(&device.point)), Ok(true));
    assert_eq!(server.calls, vec![CHALLENGE_PATH, BIND_PATH, CHALLENGE_PATH, PROOF_PATH]);
}

#[test]
fn a_failed_request_is_passed_on_and_delays_the_next_try() {
    let mut proof = DeviceProof::new();
    let Refresh::Start(_) = proof.refresh(false, None, 10) else { panic!() };
    assert_eq!(proof.on_reply(Reply::Failed, true, 10), Step::Done(Err(ProofError::Transport(Reply::Failed))));
    assert!(!proof.due(10 + PROOF_RETRY_MS - 1));
    assert!(proof.due(10 + PROOF_RETRY_MS));
    // An answer that makes no sense is «unavailable», not a crash.
    let Refresh::Start(_) = proof.refresh(false, None, 10 + PROOF_RETRY_MS) else { panic!() };
    assert_eq!(proof.on_reply(Reply::Ok(Value::Null), true, 10 + PROOF_RETRY_MS), Step::Done(Err(ProofError::Unavailable)));
}
