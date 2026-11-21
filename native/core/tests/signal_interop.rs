//! The Signal bridge against the bridges the apps run today, each driven as a child process:
//!
//! - the desktop app's bridge, `desktop/signal.mjs` on the official `@signalapp/libsignal-client` (Node), through
//!   `tests/signal-interop.mjs`. Its state has a shape of its own, so a state crosses over through that script's
//!   `toPhone` / `toDesktop`, which rename tables and leave every library record as it is;
//! - the Android app's bridge, `SignalCore.kt` on the official `libsignal-client` JVM library, through the
//!   repository's own test driver (`SignalInterop.kt`). Its state is the phones' state itself and crosses over
//!   untouched. It needs the classes `gradle interopClasspath` builds in `mobile/modules/linea-signal/jvm-tests`;
//!   without them these tests say so and pass (set `INVIZENT_REQUIRE_KOTLIN_INTEROP=1` to make that a failure).
//!
//! Run with `cargo test --features signal`.
#![cfg(feature = "signal")]

mod signal_support;

use std::cell::RefCell;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use invizent_core::e2ee::bridge::{SignalBridge, SignalError};
use invizent_core::signal::{self, LibSignal};
use serde_json::{json, Value};
use signal_support::{claimed, from_core, reads_as_lost_session, state_json, to_core};

// ── The drivers ───────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind { Node, Kotlin }

struct Remote { kind: Kind, child: Child, input: ChildStdin, output: BufReader<ChildStdout> }

impl Drop for Remote {
    fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); }
}

fn repository() -> PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("../..") }

impl Remote {
    fn start(kind: Kind, mut command: Command) -> Remote {
        let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().unwrap_or_else(|error| panic!("the {kind:?} driver did not start: {error}"));
        let (input, output) = (child.stdin.take().unwrap(), BufReader::new(child.stdout.take().unwrap()));
        Remote { kind, child, input, output }
    }
    fn node() -> Remote {
        let node = std::env::var("INVIZENT_NODE").unwrap_or_else(|_| if Path::new("/opt/node24/bin/node").exists() { "/opt/node24/bin/node".into() } else { "node".into() });
        assert!(repository().join("desktop/node_modules/@signalapp/libsignal-client").exists(), "desktop/node_modules is not installed: run `npm ci` in desktop/");
        let mut command = Command::new(node);
        command.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/signal-interop.mjs"));
        let mut remote = Remote::start(Kind::Node, command);
        assert_eq!(remote.call("version", json!([])).expect("the driver answers"), json!(signal::VERSION), "the desktop app's library is another version");
        remote
    }
    /// `None`: the JVM classes have not been built on this machine.
    fn kotlin() -> Option<Remote> {
        let classpath = repository().join("mobile/modules/linea-signal/jvm-tests/build/interop-classpath.txt");
        let Ok(classpath) = std::fs::read_to_string(&classpath) else {
            assert!(std::env::var("INVIZENT_REQUIRE_KOTLIN_INTEROP").is_err(), "the Kotlin driver is required but {classpath:?} is missing");
            eprintln!("SKIPPED: the Kotlin bridge is not built ({classpath:?} is missing; `gradle interopClasspath` in mobile/modules/linea-signal/jvm-tests builds it)");
            return None;
        };
        let java = std::env::var("INVIZENT_JAVA").unwrap_or_else(|_| "java".into());
        let mut command = Command::new(java);
        command.args(["-Dfile.encoding=UTF-8", "-Dstdout.encoding=UTF-8", "-Dstdin.encoding=UTF-8", "-cp", classpath.trim(), "expo.modules.lineasignal.SignalInteropKt"]);
        // The JVM announces JAVA_TOOL_OPTIONS on stderr; nothing of it is needed here.
        command.env_remove("JAVA_TOOL_OPTIONS");
        Some(Remote::start(Kind::Kotlin, command))
    }
    fn call(&mut self, method: &str, args: Value) -> Result<Value, String> {
        writeln!(self.input, "{}", json!({ "method": method, "args": args })).expect("the driver listens");
        let mut line = String::new();
        self.output.read_line(&mut line).expect("the driver answers");
        let answer: Value = serde_json::from_str(&line).unwrap_or_else(|error| panic!("the {:?} driver answered {line:?} to {method}: {error}", self.kind));
        if answer["ok"] == json!(true) { return Ok(answer["value"].clone()) }
        Err(match self.kind { Kind::Kotlin => answer["error"].as_str().unwrap().to_string(), Kind::Node => format!("{}: {}", answer["error"]["name"].as_str().unwrap(), answer["error"]["message"].as_str().unwrap()) })
    }
}

/// How the Rust bridge's refusal is written in these tests: the reason, and for the library's own its name and words.
fn told(error: SignalError) -> String {
    let reason = error.code.strip_prefix("ERR_LINEA_SIGNAL_").expect("the code the apps know").to_string();
    if reason == "CRYPTO_FAILED" { format!("CRYPTO_FAILED {}: {}", error.name, error.message) } else { reason }
}

/// A bridge: the Rust one or one of today's.
#[derive(Clone, Copy)]
enum Engine<'a> { Rust, Remote(&'a RefCell<Remote>) }

type Message = (f64, String);

impl Engine<'_> {
    fn remote(&self, method: &str, args: Value) -> Result<Value, String> {
        match self { Engine::Remote(remote) => remote.borrow_mut().call(method, args), Engine::Rust => unreachable!() }
    }
    fn create(&self, name: &str) -> (String, Value) {
        match self {
            Engine::Rust => { let (state, bundle) = LibSignal.create_state(name, 1).expect("a new state"); (state, from_core(&bundle)) }
            Engine::Remote(_) => { let made = self.remote("createState", json!([name, 1])).expect("a new state"); (made["state"].as_str().unwrap().to_string(), made["bundle"].clone()) }
        }
    }
    fn replenish(&self, state: &str, count: u32) -> Result<(String, Value), String> {
        match self {
            Engine::Rust => LibSignal.replenish(state, count).map(|(state, bundle)| (state, from_core(&bundle))).map_err(told),
            Engine::Remote(_) => self.remote("replenish", json!([state, count])).map(|made| (made["state"].as_str().unwrap().to_string(), made["bundle"].clone())),
        }
    }
    fn trust(&self, state: &str, name: &str, identity: &str) -> Result<String, String> {
        match self {
            Engine::Rust => LibSignal.trust_identity(state, name, 1, identity).map_err(told),
            Engine::Remote(_) => self.remote("trustIdentity", json!([state, name, 1, identity])).map(|made| made["state"].as_str().unwrap().to_string()),
        }
    }
    fn encrypt(&self, state: &str, to: &str, text: &str, bundle: Option<&Value>) -> Result<(String, Message), String> {
        match self {
            Engine::Rust => LibSignal.encrypt(state, to, 1, text, bundle.map(to_core).as_ref()).map(|sealed| (sealed.state, (sealed.kind, sealed.body))).map_err(told),
            Engine::Remote(_) => self.remote("encrypt", json!([state, to, 1, text, bundle])).map(|made| (made["state"].as_str().unwrap().to_string(), (made["type"].as_f64().unwrap(), made["body"].as_str().unwrap().to_string()))),
        }
    }
    fn decrypt(&self, state: &str, from: &str, message: &Message) -> Result<(String, String), String> {
        match self {
            Engine::Rust => LibSignal.decrypt(state, from, 1, message.0, &message.1).map(|opened| (opened.state, opened.plaintext)).map_err(told),
            Engine::Remote(_) => self.remote("decrypt", json!([state, from, 1, message.0 as u32, message.1])).map(|made| (made["state"].as_str().unwrap().to_string(), made["plaintext"].as_str().unwrap().to_string())),
        }
    }
    fn seal(&self, plaintext: &str, key: &str, nonce: &str, ad: &str) -> Result<String, String> {
        match self { Engine::Rust => signal::seal(plaintext, key, nonce, ad).map_err(told), Engine::Remote(_) => self.remote("seal", json!([plaintext, key, nonce, ad])).map(|made| made.as_str().unwrap().to_string()) }
    }
    fn open(&self, ciphertext: &str, key: &str, nonce: &str, ad: &str) -> Result<String, String> {
        match self { Engine::Rust => signal::open(ciphertext, key, nonce, ad).map_err(told), Engine::Remote(_) => self.remote("open", json!([ciphertext, key, nonce, ad])).map(|made| made.as_str().unwrap().to_string()) }
    }
    fn kind(&self) -> Option<Kind> { match self { Engine::Rust => None, Engine::Remote(remote) => Some(remote.borrow().kind) } }
    /// The state as the other side keeps it. The Kotlin bridge's state is the phones' state: it crosses untouched.
    fn carried(&self, state: &str, to: Engine) -> String {
        match (self.kind(), to.kind()) {
            (Some(Kind::Node), None) => self.remote("toPhone", json!([state])).expect("carried").as_str().unwrap().to_string(),
            (None, Some(Kind::Node)) => to.remote("toDesktop", json!([state])).expect("carried").as_str().unwrap().to_string(),
            (Some(Kind::Kotlin), None) | (None, Some(Kind::Kotlin)) => state.to_string(),
            (from, to) => panic!("no crossing from {from:?} to {to:?}"),
        }
    }
}

/// A device: its state and the bridge that holds it now.
struct Device<'a> { name: String, engine: Engine<'a>, state: String, bundle: Value }

impl<'a> Device<'a> {
    fn new(engine: Engine<'a>, name: &str) -> Device<'a> { let (state, bundle) = engine.create(name); Device { name: name.to_string(), engine, state, bundle } }
    fn identity(&self) -> String { self.bundle["identityKey"].as_str().unwrap().to_string() }
    fn trust(&mut self, other: &Device) { self.state = self.engine.trust(&self.state, &other.name, &other.identity()).expect("pinned") }
    fn send(&mut self, to: &str, text: &str, bundle: Option<&Value>) -> Message {
        let (state, message) = self.engine.encrypt(&self.state, to, text, bundle).unwrap_or_else(|error| panic!("{} could not encrypt: {error}", self.name));
        self.state = state;
        message
    }
    fn receive(&mut self, from: &str, message: &Message) -> String {
        let (state, text) = self.engine.decrypt(&self.state, from, message).unwrap_or_else(|error| panic!("{} could not decrypt: {error}", self.name));
        self.state = state;
        text
    }
    fn refuses(&self, from: &str, message: &Message) -> String { self.engine.decrypt(&self.state, from, message).expect_err("refused").to_string() }
    /// The device's state is handed to another bridge, as when the app is replaced by the new one.
    fn move_to(&mut self, engine: Engine<'a>) { self.state = self.engine.carried(&self.state, engine); self.engine = engine; }
}

fn acquainted<'a>(first: Engine<'a>, first_name: &str, second: Engine<'a>, second_name: &str) -> (Device<'a>, Device<'a>) {
    let (mut a, mut b) = (Device::new(first, first_name), Device::new(second, second_name));
    a.trust(&b);
    b.trust(&a);
    (a, b)
}
/// A few messages each way, each opened by the other side.
fn talk(a: &mut Device, b: &mut Device, tag: &str) {
    for round in 0..3 {
        let out = a.send(&b.name.clone(), &format!("{tag} → {round} 🙂"), None);
        assert_eq!(out.0, 2.0, "{tag}");
        assert_eq!(b.receive(&a.name.clone(), &out), format!("{tag} → {round} 🙂"));
        let back = b.send(&a.name.clone(), &format!("{tag} ← {round}"), None);
        assert_eq!(back.0, 2.0, "{tag}");
        assert_eq!(a.receive(&b.name.clone(), &back), format!("{tag} ← {round}"));
    }
}

const ALICE: &str = "0f8fad5b-d9cb-469f-a165-70867728950e.00000000-0000-4000-8000-000000000001";
const BOB: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7.d0000001-0000-4000-8000-000000000001";

// ── The scenarios, the same for both of today's bridges ───────────────────────────────────────────────────────

/// On the wire: a session opened by either side, continued, rekeyed, with late messages.
fn wire(theirs: Engine) {
    for rust_opens in [true, false] {
        let (mut a, mut b) = if rust_opens { acquainted(Engine::Rust, ALICE, theirs, BOB) } else { acquainted(theirs, ALICE, Engine::Rust, BOB) };
        let opening = a.send(BOB, "Привет через границу", Some(&claimed(&b.bundle, Some(0))));
        assert_eq!(opening.0, 3.0);
        let second = a.send(BOB, "второе до ответа", None);
        assert_eq!(second.0, 3.0);
        assert_eq!(b.receive(ALICE, &second), "второе до ответа");
        assert_eq!(b.receive(ALICE, &opening), "Привет через границу");
        let reply = b.send(ALICE, "ответ", None);
        assert_eq!(reply.0, 2.0);
        assert_eq!(a.receive(BOB, &reply), "ответ");
        talk(&mut a, &mut b, "после открытия");
        // Late and out of order, both ways.
        let late: Vec<Message> = (0..4).map(|index| a.send(BOB, &format!("поздно {index}"), None)).collect();
        let other: Vec<Message> = (0..3).map(|index| b.send(ALICE, &format!("навстречу {index}"), None)).collect();
        for index in [3usize, 1, 0] { assert_eq!(b.receive(ALICE, &late[index]), format!("поздно {index}")) }
        for index in [2usize, 0, 1] { assert_eq!(a.receive(BOB, &other[index]), format!("навстречу {index}")) }
        // A rekey from each side while the session lives: a PreKey message again, and the late message of the old chain still opens.
        let rekey = a.send(BOB, "новая сессия", Some(&claimed(&b.bundle, Some(1))));
        assert_eq!(rekey.0, 3.0);
        assert_eq!(b.receive(ALICE, &rekey), "новая сессия");
        assert_eq!(b.receive(ALICE, &late[2]), "поздно 2");
        talk(&mut b, &mut a, "после смены ключей");
        let rekey = b.send(ALICE, "и с другой стороны", Some(&claimed(&a.bundle, None)));
        assert_eq!(rekey.0, 3.0);
        assert_eq!(a.receive(BOB, &rekey), "и с другой стороны");
        talk(&mut a, &mut b, "в конце");
        // A message already opened does not open again, whoever holds the state.
        assert!(!b.refuses(ALICE, &opening).is_empty() && !a.refuses(BOB, &reply).is_empty());
    }
}

/// An installation's state, made and used by today's bridge, opens in the Rust bridge and goes on — and back.
fn installed_state_moves(theirs: Engine) {
    // The life before: both devices on today's bridge.
    let (mut a, mut b) = acquainted(theirs, ALICE, theirs, BOB);
    let opening = a.send(BOB, "первое", Some(&claimed(&b.bundle, Some(0))));
    assert_eq!(b.receive(ALICE, &opening), "первое");
    let reply = b.send(ALICE, "ответ", None);
    assert_eq!(a.receive(BOB, &reply), "ответ");
    talk(&mut a, &mut b, "до переезда");
    let in_flight_to_b = a.send(BOB, "в пути к Бобу", None);
    let in_flight_to_a = b.send(ALICE, "в пути к Алисе", None);

    // Alice's app is replaced: her state is now read by the Rust bridge.
    a.move_to(Engine::Rust);
    let carried = state_json(&a.state);
    assert_eq!((carried["version"].clone(), carried["libsignalVersion"].clone(), carried["nextPreKeyId"].clone()), (json!(1), json!("0.106.0"), json!(21)));
    assert_eq!(a.receive(BOB, &in_flight_to_a), "в пути к Алисе");
    talk(&mut a, &mut b, "Алиса переехала");
    assert_eq!(b.receive(ALICE, &in_flight_to_b), "в пути к Бобу");
    // What the Rust bridge wrote is the same state: same tables, records still the library's.
    let written = state_json(&a.state);
    assert_eq!(written.as_object().unwrap().keys().collect::<Vec<_>>(), carried.as_object().unwrap().keys().filter(|key| written.get(key.as_str()).is_some()).collect::<Vec<_>>());
    for table in ["preKeys", "signedPreKeys", "kyberPreKeys", "trustedIdentities", "kyberUsed", "senderKeys"] { assert_eq!(written[table], carried[table], "{table}") }
    assert_eq!((written["identityKeyPair"].clone(), written["registrationId"].clone()), (carried["identityKeyPair"].clone(), carried["registrationId"].clone()));
    assert_eq!(written["sessions"].as_object().unwrap().keys().collect::<Vec<_>>(), [&format!("{BOB}#1")]);
    // Her pins moved with it: the same key is accepted again, another one is a changed identity.
    assert_eq!(Engine::Rust.trust(&a.state, BOB, &b.identity()).as_deref(), Ok(a.state.as_str()));
    let stranger = Device::new(Engine::Rust, BOB);
    assert_eq!(Engine::Rust.trust(&a.state, BOB, &stranger.identity()).unwrap_err(), "IDENTITY_CHANGED");
    assert_eq!(Engine::Rust.encrypt(&a.state, BOB, "x", Some(&claimed(&stranger.bundle, Some(0)))).unwrap_err(), "IDENTITY_CHANGED");
    // New prekeys continue the numbering today's bridge left, and a newcomer can open a session on them.
    let (state, bundle) = Engine::Rust.replenish(&a.state, 3).expect("more prekeys");
    assert_eq!(bundle["preKeys"].as_array().unwrap().iter().map(|key| key["id"].as_u64().unwrap()).collect::<Vec<_>>(), [21, 22, 23]);
    for field in ["registrationId", "identityKey", "signedPreKey", "kyberPreKey"] { assert_eq!(bundle[field], a.bundle[field], "{field}") }
    a.state = state;
    let mut carol = Device::new(theirs, "carol.dev");
    carol.trust(&a);
    a.state = Engine::Rust.trust(&a.state, "carol.dev", &carol.identity()).expect("pinned");
    let from_carol = carol.send(ALICE, "я новенькая", Some(&claimed(&bundle, Some(2))));
    assert_eq!(a.receive("carol.dev", &from_carol), "я новенькая");
    // …and on the bundle made before the move: the signed, Kyber and one-time prekeys today's bridge stored.
    let mut dave = Device::new(Engine::Rust, "dave.dev");
    dave.trust(&a);
    a.state = Engine::Rust.trust(&a.state, "dave.dev", &dave.identity()).expect("pinned");
    let from_dave = dave.send(ALICE, "по старому ключу", Some(&claimed(&a.bundle, Some(7))));
    assert_eq!(a.receive("dave.dev", &from_dave), "по старому ключу");
    let back = a.send("dave.dev", "принято", None);
    assert_eq!(dave.receive(ALICE, &back), "принято");

    // Bob moves too: now both sides are the Rust bridge, on states today's bridge made.
    let pending = a.send(BOB, "пока Боб переезжал", None);
    b.move_to(Engine::Rust);
    assert_eq!(b.receive(ALICE, &pending), "пока Боб переезжал");
    talk(&mut a, &mut b, "оба переехали");
    // The opening message of the old life is not accepted a second time (by now its chain is long gone, so the
    // library fails to open it rather than recognise it).
    assert_eq!(b.refuses(ALICE, &opening), "CRYPTO_FAILED LibSignalError: invalid PreKey message: decryption failed");
    let lost = { let mut state = state_json(&b.state); state["sessions"] = json!({}); state.to_string() };
    assert_eq!(Engine::Rust.decrypt(&lost, ALICE, &opening).unwrap_err(), "CRYPTO_FAILED LibSignalError: invalid prekey identifier");
    let no_session = LibSignal.encrypt(&lost, ALICE, 1, "x", None).unwrap_err();
    assert!(reads_as_lost_session(&no_session), "{no_session:?}");

    // And back: the state the Rust bridge wrote opens in today's bridge (an older build of the app, the other phone).
    let pending = b.send(ALICE, "пока Алиса возвращалась", None);
    a.move_to(theirs);
    assert_eq!(a.receive(BOB, &pending), "пока Алиса возвращалась");
    talk(&mut a, &mut b, "Алиса вернулась");
    b.move_to(theirs);
    talk(&mut b, &mut a, "оба вернулись");
    let (_, bundle) = theirs.replenish(&a.state, 2).expect("more prekeys");
    assert_eq!(bundle["preKeys"].as_array().unwrap().iter().map(|key| key["id"].as_u64().unwrap()).collect::<Vec<_>>(), [24, 25]);
}

/// A state that has never been used crosses over, and its keys serve on the other side.
fn fresh_state_moves(theirs: Engine) {
    for (maker, user) in [(theirs, Engine::Rust), (Engine::Rust, theirs)] {
        let mut receiver = Device::new(maker, BOB);
        receiver.move_to(user);
        let mut sender = Device::new(maker, ALICE);
        sender.trust(&receiver);
        receiver.state = user.trust(&receiver.state, ALICE, &sender.identity()).expect("pinned");
        // The bundle was published by the maker; the keys behind it are now read by the user.
        let opening = sender.send(BOB, "на ключи, сделанные другой библиотекой", Some(&claimed(&receiver.bundle, Some(19))));
        assert_eq!(receiver.receive(ALICE, &opening), "на ключи, сделанные другой библиотекой");
        talk(&mut receiver, &mut sender, "после");
        let (state, bundle) = user.replenish(&receiver.state, 2).expect("more prekeys");
        assert_eq!(bundle["preKeys"].as_array().unwrap().iter().map(|key| key["id"].as_u64().unwrap()).collect::<Vec<_>>(), [21, 22]);
        for field in ["registrationId", "identityKey", "signedPreKey", "kyberPreKey"] { assert_eq!(bundle[field], receiver.bundle[field], "{field}") }
        receiver.state = state;
        // The sender starts anew on a prekey the user's side made, and the receiver's session opens it.
        let rekey = sender.send(BOB, "на новый ключ", Some(&claimed(&bundle, Some(1))));
        assert_eq!((rekey.0, receiver.receive(ALICE, &rekey)), (3.0, "на новый ключ".to_string()));
    }
}

/// The record of the Kyber prekey's uses crosses over and keeps refusing a replayed opening.
fn replay_record_moves(theirs: Engine) {
    for (before, after) in [(theirs, Engine::Rust), (Engine::Rust, theirs)] {
        let (mut a, mut b) = acquainted(before, ALICE, before, BOB);
        // No one-time prekey: only the record stands against a replay once the session is gone.
        let opening = a.send(BOB, "раз", Some(&claimed(&b.bundle, None)));
        let untouched = b.state.clone();
        assert_eq!(b.receive(ALICE, &opening), "раз");
        b.move_to(after);
        let lost = { let mut state = state_json(&b.state); state["sessions"] = json!({}); state.to_string() };
        let refusal = after.decrypt(&lost, ALICE, &opening);
        match after.kind() {
            None => assert_eq!(refusal.unwrap_err(), "REUSED_BASE_KEY"),
            // The Kotlin bridge refuses with the library's ReusedBaseKeyException, which its module reports as CRYPTO_FAILED.
            Some(Kind::Kotlin) => assert_eq!(refusal.unwrap_err(), "CRYPTO_FAILED"),
            // The desktop bridge records the use (the record crossed over) but does not consult it.
            Some(Kind::Node) => {
                let uses = state_json(&b.state)["kyberUses"].clone();
                let tuple = state_json(&after.carried(&b.state, Engine::Rust))["kyberUsed"].as_object().unwrap().keys().next().unwrap().clone();
                assert_eq!(uses.as_array().unwrap().len(), 1);
                assert_eq!(tuple, format!("1:1:{}", uses[0]["baseKey"].as_str().unwrap()));
            }
        }
        // The same message opens on a state that has not seen it: it is the record that refuses.
        let mut fresh = Device { name: BOB.to_string(), engine: before, state: untouched, bundle: Value::Null };
        fresh.move_to(after);
        assert_eq!(fresh.receive(ALICE, &opening), "раз");
    }
}

/// File encryption: the same bytes from both, each opening the other's.
fn files(theirs: Engine) {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;
    let file: Vec<u8> = (0..70_000u32).map(|index| (index * 131 % 253) as u8).collect();
    let (plaintext, key, nonce, ad) = (STANDARD.encode(&file), STANDARD.encode([3u8; 32]), STANDARD.encode([5u8; 12]), STANDARD.encode("вложение:1"));
    let ours = Engine::Rust.seal(&plaintext, &key, &nonce, &ad).expect("sealed");
    assert_eq!(theirs.seal(&plaintext, &key, &nonce, &ad).expect("sealed"), ours);
    assert_eq!(theirs.open(&ours, &key, &nonce, &ad).expect("opened"), plaintext);
    assert_eq!(Engine::Rust.open(&ours, &key, &nonce, &ad).expect("opened"), plaintext);
    assert_eq!(Engine::Rust.seal("", &key, &nonce, "").expect("sealed"), theirs.seal("", &key, &nonce, "").expect("sealed"));
    let other_ad = STANDARD.encode("вложение:2");
    assert!(theirs.open(&ours, &key, &nonce, &other_ad).is_err() && Engine::Rust.open(&ours, &key, &nonce, &other_ad).is_err());
}

fn all(theirs: Engine) {
    wire(theirs);
    installed_state_moves(theirs);
    fresh_state_moves(theirs);
    replay_record_moves(theirs);
    files(theirs);
}

#[test]
fn the_desktop_bridge_and_the_rust_bridge_understand_each_other() {
    let node = RefCell::new(Remote::node());
    all(Engine::Remote(&node));
}

#[test]
fn the_android_bridge_and_the_rust_bridge_understand_each_other() {
    let Some(kotlin) = Remote::kotlin() else { return };
    let kotlin = RefCell::new(kotlin);
    all(Engine::Remote(&kotlin));
}

/// The Rust bridge and the Kotlin bridge refuse the same things for the same reasons.
#[test]
fn the_android_bridge_and_the_rust_bridge_refuse_alike() {
    let Some(kotlin) = Remote::kotlin() else { return };
    let kotlin = RefCell::new(kotlin);
    let theirs = Engine::Remote(&kotlin);
    for engine in [Engine::Rust, theirs] {
        let (a, mut b) = (Device::new(engine, ALICE), Device::new(engine, BOB));
        let reasons = |result: Result<String, String>| result.expect_err("refused").split(' ').next().unwrap().to_string();
        let state_of = |result: Result<(String, Message), String>| result.map(|made| made.0);
        let opened = |result: Result<(String, String), String>| result.map(|made| made.0);
        let made = |result: Result<(String, Value), String>| result.map(|made| made.0);
        let bundle = claimed(&b.bundle, Some(0));
        assert_eq!(reasons(state_of(engine.encrypt(&a.state, BOB, "x", Some(&bundle)))), "TRUST_REQUIRED");
        assert_eq!(reasons(engine.trust(&a.state, "bob dev", &b.identity())), "INVALID_ADDRESS");
        assert_eq!(reasons(engine.trust(&a.state, BOB, "AAAA")), "INVALID_IDENTITY");
        assert_eq!(reasons(engine.trust(&a.state, BOB, "A")), "INVALID_BASE64");
        let trusting = engine.trust(&a.state, BOB, &b.identity()).expect("pinned");
        assert_eq!(reasons(engine.trust(&trusting, BOB, &a.identity())), "IDENTITY_CHANGED");
        let other = Device::new(engine, BOB);
        assert_eq!(reasons(state_of(engine.encrypt(&trusting, BOB, "x", Some(&claimed(&other.bundle, Some(0)))))), "IDENTITY_CHANGED");
        assert_eq!(reasons(state_of(engine.encrypt(&trusting, BOB, "x", None))), "CRYPTO_FAILED", "no session");
        assert_eq!(reasons(state_of(engine.encrypt(&trusting, BOB, &"я".repeat(signal::MAX_MESSAGE / 2 + 1), Some(&bundle)))), "MESSAGE_TOO_LARGE");
        for (change, reason) in [
            (json!({ "registrationId": 0 }), "INVALID_NUMBER"), (json!({ "registrationId": 16384 }), "INVALID_NUMBER"), (json!({ "registrationId": "7" }), "INVALID_NUMBER"),
            (json!({ "identityKey": "AAAA" }), "INVALID_IDENTITY"), (json!({ "signedPreKey": { "id": 1, "publicKey": "AAAA", "signature": bundle["signedPreKey"]["signature"] } }), "INVALID_PUBLIC_KEY"),
            (json!({ "kyberPreKey": { "id": 1, "publicKey": bundle["kyberPreKey"]["publicKey"], "signature": "AAAA" } }), "INVALID_SIGNATURE"),
            (json!({ "preKey": { "id": 0, "publicKey": bundle["preKey"]["publicKey"] } }), "INVALID_NUMBER"),
            (json!({ "signedPreKey": other.bundle["signedPreKey"] }), "CRYPTO_FAILED"),
        ] {
            let mut bad = bundle.clone();
            for (key, value) in change.as_object().unwrap() { bad[key] = value.clone() }
            assert_eq!(reasons(state_of(engine.encrypt(&trusting, BOB, "x", Some(&bad)))), reason, "{change}");
        }
        let (_, message) = engine.encrypt(&trusting, BOB, "x", Some(&bundle)).expect("encrypted");
        assert_eq!(reasons(opened(engine.decrypt(&b.state, ALICE, &message))), "TRUST_REQUIRED");
        b.trust(&a);
        assert_eq!(reasons(opened(engine.decrypt(&b.state, ALICE, &(4.0, message.1.clone())))), "UNSUPPORTED_MESSAGE_TYPE");
        assert_eq!(reasons(opened(engine.decrypt(&b.state, ALICE, &(3.0, "@@@@".to_string())))), "INVALID_BASE64");
        assert_eq!(reasons(opened(engine.decrypt(&b.state, ALICE, &(2.0, message.1.clone())))), "CRYPTO_FAILED");
        assert_eq!(reasons(opened(engine.decrypt(&b.state, "bob/dev", &message))), "INVALID_ADDRESS");
        assert_eq!(reasons(made(engine.replenish(&a.state, 0))), "INVALID_PREKEY_COUNT");
        assert_eq!(reasons(made(engine.replenish(&a.state, 101))), "INVALID_PREKEY_COUNT");
        let edited = |change: &dyn Fn(&mut Value)| { let mut state = state_json(&a.state); change(&mut state); state.to_string() };
        assert_eq!(reasons(made(engine.replenish(&edited(&|state| state["version"] = json!(2)), 1))), "UNSUPPORTED_STATE");
        assert_eq!(reasons(made(engine.replenish(&edited(&|state| state["libsignalVersion"] = json!("0.105.0")), 1))), "UNSUPPORTED_STATE");
        assert_eq!(reasons(made(engine.replenish(&edited(&|state| state["nextPreKeyId"] = json!(2147483647u32)), 1))), "PREKEY_ID_EXHAUSTED");
        assert_eq!(reasons(made(engine.replenish(&edited(&|state| { for index in 0..64 { state["signedPreKeys"][format!("x{index}")] = json!("AAAA") } }), 1))), "KEY_CAPACITY");
        assert_eq!(reasons(made(engine.replenish(&edited(&|state| { state.as_object_mut().unwrap().remove("sessions"); }), 1))), "CRYPTO_FAILED");
        let key = "A".repeat(43) + "=";
        assert_eq!(reasons(engine.open("AAAA", &key, "AAAAAAAAAAAAAAAA", "")), "INVALID_CIPHERTEXT");
        assert_eq!(reasons(engine.seal("A", &key, "AAAAAAAAAAAAAAAA", "")), "INVALID_BASE64");
    }
}
