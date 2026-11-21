//! A session bound to this device's key: the app's side of the exchange.
//!
//! Reference: `mobile/src/deviceProof.ts` (the app) and `server/src/devicebind.js` (the server).
//!
//! The session token on the disk is not enough for a bound session: every request also carries a «proof» — a
//! random value the server hands out for ten minutes in exchange for a signature by the device's key (Secure
//! Enclave, Android Keystore). The proof lives in memory only, never on the disk: a copied token, or the whole
//! folder of the app, signs in nowhere else.
//!
//! This is the exchange as a state machine without any input or output of its own: it says what to do next
//! (`Step`) and is told what happened. The apps do the request and the signing with their own platform code and
//! feed the answers back. An older server (no such routes) or a device without a key: nothing happens, the
//! session works as before.

use crate::json::{self, Value};

/// Renew this long before the proof runs out.
pub const PROOF_MARGIN_MS: i64 = 90_000;
/// After a failed attempt the next request does not try again sooner than this.
pub const PROOF_RETRY_MS: i64 = 5_000;

pub const CHALLENGE_PATH: &str = "/auth/device/challenge";
pub const BIND_PATH: &str = "/auth/device/bind";
pub const PROOF_PATH: &str = "/auth/device/proof";

/// What the device signs. The purpose and the session are part of it: a signature made to bind one session
/// cannot be replayed as a proof, nor for another session.
pub fn device_message(purpose: Purpose, session_id: &str, challenge: &str) -> String {
    let word = match purpose { Purpose::Bind => "bind", Purpose::Proof => "proof" };
    format!("invizent-device-{word}-v1\n{session_id}\n{challenge}")
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Purpose { Bind, Proof }

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum KeyKind { Hardware, Software }

/// The server's answer to a request of the exchange.
#[derive(Clone, PartialEq, Debug)]
pub enum Reply {
    Ok(Value),
    /// The server said no: the HTTP status and the error's `code` (empty when it has none).
    Refused { status: u16, code: String },
    /// The request did not get an answer (no network, a timeout).
    Failed,
}

/// The device key's answer to a request to sign.
#[derive(Clone, PartialEq, Debug)]
pub enum Signed {
    /// `public_key` (base64url of the 65-byte P-256 point) and `kind` are needed for binding.
    Ok { signature: String, public_key: String, kind: KeyKind },
    /// The key could not sign. `key_changed`: the chip no longer holds the key the session was bound to.
    Failed { key_changed: bool },
}

#[derive(Clone, PartialEq, Debug)]
pub enum ProofError {
    /// The session is bound to a key this device does not have — it cannot be used here any more (sign in again).
    Lost,
    /// The key could not sign right now, or the server's answer made no sense: try again later.
    Unavailable,
    /// The request itself failed; the reply is passed on as it was.
    Transport(Reply),
}

/// What the app has to do next.
#[derive(Clone, PartialEq, Debug)]
pub enum Step {
    /// POST this path with the session token (and this body, if any), then call `on_reply`.
    Post { path: &'static str, body: Option<Value> },
    /// Sign the UTF-8 bytes of this message with the device key (ECDSA P-256 / SHA-256, base64url), then call `on_signed`.
    Sign { message: String, purpose: Purpose },
    /// The exchange is over: `Ok(true)` a proof is held, `Ok(false)` this session does not use one.
    Done(Result<bool, ProofError>),
}

/// The answer to «may this request go now?».
#[derive(Clone, PartialEq, Debug)]
pub enum Refresh {
    /// A proof is held: go.
    Held,
    /// This session does not use a proof: go.
    NotUsed,
    /// An exchange is already running: wait for it to finish and take its result.
    Running,
    /// Start the exchange with this step.
    Start(Step),
}

#[derive(Clone, PartialEq, Debug)]
enum Phase {
    Idle,
    Challenge { again: bool },
    BindSign { again: bool },
    Bind { again: bool },
    ProofSign { again: bool },
    Proof { again: bool },
}

#[derive(Debug)]
pub struct DeviceProof {
    proof: Option<String>,
    until: i64,
    /// Nothing to do for this session in this run: the server has no binding, or there is no key to bind with.
    off: bool,
    failed_at: i64,
    issued: u64,
    phase: Phase,
    /// How long the proof just received is good for, milliseconds.
    last_ttl_ms: i64,
}

impl Default for DeviceProof {
    fn default() -> Self { Self::new() }
}

impl DeviceProof {
    pub fn new() -> Self {
        DeviceProof { proof: None, until: 0, off: false, failed_at: -PROOF_RETRY_MS, issued: 0, phase: Phase::Idle, last_ttl_ms: 0 }
    }

    /// The proof to send with a request, if one is held and still good.
    pub fn current(&self, now: i64) -> Option<&str> {
        if self.until > now { self.proof.as_deref() } else { None }
    }
    /// Grows with every proof received: lets a refused request tell whether a newer proof has arrived since it left.
    pub fn generation(&self) -> u64 { self.issued }
    /// Whether a proof was ever held in this run: only then is the session known to need one.
    pub fn known(&self) -> bool { self.until > 0 }
    /// Whether a request should first wait for `refresh`.
    pub fn due(&self, now: i64) -> bool {
        !self.off && self.until - now < PROOF_MARGIN_MS && now - self.failed_at >= PROOF_RETRY_MS
    }
    /// When to renew by itself while the app runs, milliseconds from the moment the proof was received
    /// (so a long upload or an open socket never meets an expired proof). `None` when no proof is held.
    pub fn renew_after_ms(&self) -> Option<i64> {
        if self.proof.is_some() && self.last_ttl_ms > 0 { Some((self.last_ttl_ms - PROOF_MARGIN_MS - 30_000).max(30_000)) } else { None }
    }

    /// Asks for a proof (binding the session to the key first, if it has none).
    /// `force`: the server has just refused the proof we hold. `seen`: the generation when the refused request
    /// was sent — if a newer proof has arrived since (many requests were refused together), that one is used.
    pub fn refresh(&mut self, force: bool, seen: Option<u64>, now: i64) -> Refresh {
        if self.phase != Phase::Idle { return Refresh::Running }
        if self.off { return Refresh::NotUsed }
        if force && seen.is_some() && seen != Some(self.issued) && self.current(now).is_some() { return Refresh::Held }
        if !force && self.current(now).is_some() && self.until - now >= PROOF_MARGIN_MS { return Refresh::Held }
        self.phase = Phase::Challenge { again: true };
        Refresh::Start(Step::Post { path: CHALLENGE_PATH, body: None })
    }

    fn finish(&mut self, result: Result<bool, ProofError>, now: i64) -> Step {
        self.phase = Phase::Idle;
        if result.is_err() { self.failed_at = now }
        Step::Done(result)
    }
    fn switch_off(&mut self, now: i64) -> Step {
        self.off = true;
        self.finish(Ok(false), now)
    }
    fn restart(&mut self) -> Step {
        self.phase = Phase::Challenge { again: false };
        Step::Post { path: CHALLENGE_PATH, body: None }
    }

    /// The answer to the request of the last `Step::Post`. `has_key`: whether this device has a key at all.
    pub fn on_reply(&mut self, reply: Reply, has_key: bool, now: i64) -> Step {
        match self.phase.clone() {
            Phase::Challenge { again } => {
                let answer = match reply {
                    Reply::Ok(value) => value,
                    // A server from before device binding: the session stays as it is.
                    Reply::Refused { status: 404, .. } => return self.switch_off(now),
                    other => return self.finish(Err(ProofError::Transport(other)), now),
                };
                let (Some(challenge), Some(session_id)) = (answer.get("challenge").and_then(Value::as_str), answer.get("sessionId").and_then(Value::as_str)) else {
                    return self.finish(Err(ProofError::Unavailable), now);
                };
                let bound = !matches!(answer.get("bound"), None | Some(Value::Null) | Some(Value::Bool(false)));
                if !bound {
                    // Not bound yet. Without a key it stays unbound.
                    if !has_key { return self.switch_off(now) }
                    self.phase = Phase::BindSign { again };
                    return Step::Sign { message: device_message(Purpose::Bind, &session_id, &challenge), purpose: Purpose::Bind };
                }
                if !has_key { return self.finish(Err(ProofError::Lost), now) }
                self.phase = Phase::ProofSign { again };
                Step::Sign { message: device_message(Purpose::Proof, &session_id, &challenge), purpose: Purpose::Proof }
            }
            Phase::Bind { again } => match reply {
                Reply::Ok(value) => self.take(&value, now),
                // Bound a moment ago by another request of this app: prove it instead.
                Reply::Refused { ref code, .. } if again && (code == "device_bound" || code == "device_challenge") => self.restart(),
                Reply::Refused { status: 400 | 403, .. } => self.switch_off(now),
                other => self.finish(Err(ProofError::Transport(other)), now),
            },
            Phase::Proof { again } => match reply {
                Reply::Ok(value) => self.take(&value, now),
                Reply::Refused { ref code, .. } if code == "device_signature" => self.finish(Err(ProofError::Lost), now),
                Reply::Refused { ref code, .. } if again && code == "device_challenge" => self.restart(),
                other => self.finish(Err(ProofError::Transport(other)), now),
            },
            // A reply nobody asked for: the exchange is not disturbed.
            Phase::Idle | Phase::BindSign { .. } | Phase::ProofSign { .. } => Step::Done(Err(ProofError::Unavailable)),
        }
    }

    /// The answer to the request of the last `Step::Sign`.
    pub fn on_signed(&mut self, signed: Signed, now: i64) -> Step {
        match self.phase.clone() {
            Phase::BindSign { again } => match signed {
                Signed::Ok { signature, public_key, kind } => {
                    self.phase = Phase::Bind { again };
                    let kind = match kind { KeyKind::Hardware => "hardware", KeyKind::Software => "software" };
                    Step::Post { path: BIND_PATH, body: Some(json::object(vec![("publicKey", Value::str(&public_key)), ("kind", Value::str(kind)), ("signature", Value::str(&signature))])) }
                }
                // No working key on this device: as before, by the token.
                Signed::Failed { .. } => self.switch_off(now),
            },
            Phase::ProofSign { again } => match signed {
                Signed::Ok { signature, .. } => {
                    self.phase = Phase::Proof { again };
                    Step::Post { path: PROOF_PATH, body: Some(json::object(vec![("signature", Value::str(&signature))])) }
                }
                // «key changed»: the chip no longer holds the key the session was bound to — not a passing failure.
                Signed::Failed { key_changed } => self.finish(Err(if key_changed { ProofError::Lost } else { ProofError::Unavailable }), now),
            },
            _ => Step::Done(Err(ProofError::Unavailable)),
        }
    }

    fn take(&mut self, answer: &Value, now: i64) -> Step {
        let proof = answer.get("proof").and_then(Value::as_str);
        let expires_in = match answer.get("expiresIn") { Some(Value::Number(seconds)) if *seconds > 0.0 => Some(*seconds), _ => None };
        let (Some(proof), Some(expires_in)) = (proof, expires_in) else { return self.finish(Err(ProofError::Unavailable), now) };
        self.proof = Some(proof);
        self.issued += 1;
        self.last_ttl_ms = (expires_in * 1000.0) as i64;
        self.until = now + self.last_ttl_ms;
        self.finish(Ok(true), now)
    }
}

/// Whether a key's error text says the key itself is gone (reference: `/key changed/i`).
pub fn key_changed(error_text: &str) -> bool {
    error_text.to_lowercase().contains("key changed")
}
