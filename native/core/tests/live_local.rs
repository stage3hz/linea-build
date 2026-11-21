//! The whole road on a LOCAL test server: sign in, make keys, receive really encrypted messages, answer.
//! Runs only when asked: INVIZENT_LOCAL_SERVER=http://127.0.0.1:<port> with an account made by
//! tools/native-sim-account.mjs (INVIZENT_LOGIN / INVIZENT_PASSWORD / INVIZENT_WORD / INVIZENT_HANDLE), and with
//! `--features signal`. The other side is tools/sim-seed.mjs: the current app's own code with the official
//! Node Signal library. Never talks to anything but 127.0.0.1.
#![cfg(feature = "signal")]
use invizent_core::api;
use invizent_core::e2ee::bridge::{CryptoTransport, Env, TransportError, Vault};
use invizent_core::e2ee::dispatch::dispatch;
use invizent_core::e2ee::service::Crypto;
use invizent_core::http::{client_header, headers, read_answer, Outcome, Outgoing, Platform};
use invizent_core::json::{self, Value};
use invizent_core::signal::LibSignal;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::process::Command;
use std::rc::Rc;

fn device() -> Value { json::parse(r#"{"deviceName":"iPhone","platform":"ios","deviceModel":"iPhone","osVersion":"iOS 26.1","appVersion":"0.17.0"}"#).unwrap() }

#[derive(Clone)]
struct Http { base: String, token: Option<String>, proof: Option<String> }
impl Http {
    /// One request: the status and the JSON body.
    fn raw(&self, method: &str, path: &str, body: Option<String>, proof: Option<&str>) -> (u16, Value) {
        let client = client_header("0.17.0", Platform::Ios);
        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
        let list = headers(&Outgoing { method, path, json_body: body.is_some(), client: &client, token: self.token.as_deref(), proof: proof.or(self.proof.as_deref()), attest_key: "", now_ms });
        let mut curl = Command::new("curl");
        curl.args(["-sS", "--noproxy", "*", "-X", method, "-w", "\n%{http_code}"]);
        for (name, value) in &list { curl.args(["-H", &format!("{name}: {value}")]); }
        if let Some(body) = &body { curl.args(["--data-binary", body]); }
        let out = curl.arg(format!("{}{}", self.base, path)).output().expect("curl");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        let (body, status) = text.rsplit_once('\n').expect("a status line");
        (status.parse().expect("a status"), json::parse(body).unwrap_or(Value::Null))
    }
    fn op(&self, name: &str, args: Vec<Value>) -> Result<Value, TransportError> {
        let call = api::call(name, &args, &device()).unwrap_or_else(|| panic!("no such operation: {name}"));
        let (status, data) = self.raw(&call.method, &call.path, call.body.clone(), None);
        match read_answer(status, &json::stringify(&data)).outcome {
            Outcome::Ok(data) => Ok(data),
            Outcome::Refused(error) => Err(TransportError::Refused(error.message)),
            Outcome::ServerDown => Err(TransportError::Network("down".into())),
        }
    }
}
impl CryptoTransport for Http {
    fn register_crypto_device(&mut self, device_id: &str, bundle: &Value) -> Result<Value, TransportError> { self.op("registerCryptoDevice", vec![Value::str(device_id), bundle.clone()]) }
    fn crypto_devices(&mut self, user_id: &str) -> Result<Value, TransportError> { self.op("cryptoDevices", vec![Value::str(user_id)]) }
    fn claim_pre_key(&mut self, user_id: &str, device_id: &str) -> Result<Value, TransportError> { self.op("claimPreKey", vec![Value::str(user_id), Value::str(device_id)]) }
    fn crypto_inbox(&mut self, device_id: &str, chat_id: &str, after: f64) -> Result<Value, TransportError> { self.op("inboxPage", vec![Value::str(device_id), Value::str(chat_id), Value::Number(after)]) }
}
#[derive(Clone, Default)]
struct Memory(Rc<RefCell<BTreeMap<String, String>>>);
impl Vault for Memory {
    fn get(&self, key: &str) -> Option<String> { self.0.borrow().get(key).cloned() }
    fn commit(&mut self, changes: Vec<(String, Option<String>)>) { let mut map = self.0.borrow_mut(); for (key, value) in changes { match value { Some(value) => { map.insert(key, value); } None => { map.remove(&key); } } } }
}
struct Clock(u64);
impl Env for Clock {
    fn now_iso(&mut self) -> String { invizent_core::time::iso_from_ms(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64) }
    fn random_uuid(&mut self) -> String { self.0 += 1; let out = Command::new("cat").arg("/proc/sys/kernel/random/uuid").output().unwrap(); String::from_utf8_lossy(&out.stdout).trim().to_string() }
}

#[test]
fn sign_in_receive_and_answer_on_a_local_server() {
    let Ok(base) = std::env::var("INVIZENT_LOCAL_SERVER") else { eprintln!("SKIPPED: no INVIZENT_LOCAL_SERVER"); return };
    assert!(base.starts_with("http://127.0.0.1:"), "a local test server only");
    let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name}"));
    let mut http = Http { base: base.clone(), token: None, proof: None };
    let session = http.op("login", vec![Value::str(&var("INVIZENT_LOGIN")), Value::str(&var("INVIZENT_PASSWORD")), Value::str(&var("INVIZENT_WORD"))]).expect("signed in");
    http.token = session.get("token").and_then(Value::as_str);
    let user_id = session.get("user").and_then(|user| user.get("id")).and_then(Value::as_str).expect("a user");
    // The session is bound to a device key (here a software P-256 key), and from then on needs its proof.
    {
        use invizent_core::device_proof::{DeviceProof, KeyKind, Refresh, Reply, Signed, Step};
        use p256::ecdsa::{signature::Signer, Signature, SigningKey};
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let key = SigningKey::random(&mut rand_core::OsRng);
        let public = b64.encode(key.verifying_key().to_encoded_point(false).as_bytes());
        let now = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        let mut proof = DeviceProof::new();
        let Refresh::Start(mut step) = proof.refresh(false, None, now()) else { panic!("an exchange starts") };
        let held = loop {
            step = match step {
                Step::Post { path, body } => {
                    let reply = match http.raw("POST", path, body.as_ref().map(json::stringify), None) { (200..=299, data) => Reply::Ok(data), (status, data) => Reply::Refused { status, code: data.get("code").and_then(Value::as_str).unwrap_or_default() } };
                    proof.on_reply(reply, true, now())
                }
                Step::Sign { message, .. } => { let signature: Signature = key.sign(message.as_bytes()); proof.on_signed(Signed::Ok { signature: b64.encode(signature.to_der().as_bytes()), public_key: public.clone(), kind: KeyKind::Software }, now()) }
                Step::Done(result) => break result.expect("the exchange ends well"),
            };
        };
        assert!(held, "the session is bound and a proof is held");
        let current = proof.current(now()).expect("a proof").to_string();
        // Without the proof the bound session is refused in the words the app acts on; with it, it works.
        let (status, refused) = http.raw("GET", "/me", None, None);
        assert_eq!((status, refused.get("code").and_then(Value::as_str).as_deref()), (401, Some("device_proof")), "{}", json::stringify(&refused));
        let (status, _) = http.raw("GET", "/me", None, Some(&current));
        assert_eq!(status, 200);
        http.proof = Some(current);
        eprintln!("LIVE: the session is bound to a device key; requests carry its proof");
    }
    let memory = Memory::default();
    let mut crypto = Crypto::new(&user_id, LibSignal, memory.clone(), http.clone(), Clock(0), true, Box::new(invizent_core::photo::valid_preview));
    dispatch(&mut crypto, "initialize", &[]).expect("keys made and published");

    // The other side: six people write, with the current app's own code and the official Node library.
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    let node = std::env::var("NODE").unwrap_or_else(|_| "node".to_string());
    let seeded = Command::new(&node).current_dir(root).args(["tools/sim-seed.mjs", &base, &var("INVIZENT_HANDLE")]).output().expect("node");
    assert!(seeded.status.success(), "seeding: {}{}", String::from_utf8_lossy(&seeded.stdout), String::from_utf8_lossy(&seeded.stderr));

    let chats = http.op("chats", vec![]).expect("chats");
    let Some(Value::Array(chats)) = chats.get("chats") else { panic!("chats") };
    assert_eq!(chats.len(), 6, "six people wrote");
    let mut seen: Vec<String> = Vec::new();
    for chat in chats {
        let chat_id = chat.get("id").and_then(Value::as_str).unwrap();
        dispatch(&mut crypto, "sync", &[Value::str(&chat_id)]).unwrap_or_else(|error| panic!("sync: {}", error.message()));
        let page = http.op("messages", vec![Value::str(&chat_id)]).expect("messages");
        let Some(Value::Array(messages)) = page.get("messages") else { panic!("messages") };
        assert!(!messages.is_empty());
        for message in messages {
            let shown = dispatch(&mut crypto, "preview", &[message.clone()]).expect("preview");
            assert_eq!(shown.get("cryptoState").and_then(Value::as_str).as_deref(), Some("decrypted"), "{}", json::stringify(&shown));
            seen.push(shown.get("text").and_then(Value::as_str).unwrap());
        }
        // The list row (a lean last message) shows the same kept copy.
        let last = dispatch(&mut crypto, "preview", &[chat.get("lastMessage").cloned().unwrap()]).expect("preview");
        assert_eq!(last.get("cryptoState").and_then(Value::as_str).as_deref(), Some("decrypted"));
    }
    for text in ["Привет! Ты где?", "😂😂😂", "Го вечером?", "Список покупок:\n— молоко\n— хлеб\n— сыр", "Не забудь!"] { assert!(seen.iter().any(|line| line == text), "«{text}» was not among {} decrypted messages", seen.len()) }
    // The formatted message kept its formatting.
    let fold = invizent_core::chat_view::fold_chat(&[], &user_id, &[], 0.0);
    assert!(fold.get("messages").is_some());

    // An answer: encrypted for every device of the conversation, taken by the server, kept as sent.
    let chat = &chats[0];
    let (chat_id, peer_id) = (chat.get("id").and_then(Value::as_str).unwrap(), chat.get("peer").and_then(|peer| peer.get("id")).and_then(Value::as_str).unwrap());
    let client_id = Clock(0).random_uuid();
    let encrypted = dispatch(&mut crypto, "encrypt", &[Value::str(&chat_id), Value::str(&peer_id), Value::str(&client_id), Value::str("Уже иду, буду через пять минут"), Value::Null, Value::Null, Value::Null]).unwrap_or_else(|error| panic!("encrypt: {}", error.message()));
    let sent = http.op("sendEncrypted", vec![Value::str(&chat_id), Value::str(&client_id), encrypted]).expect("the server took it");
    assert!(sent.get("message").is_some(), "{}", json::stringify(&sent));
    dispatch(&mut crypto, "delivered", &[Value::str(&chat_id), Value::str(&client_id)]).expect("delivered");
    assert_eq!(json::stringify(&dispatch(&mut crypto, "pendingOutbox", &[]).unwrap()), "[]");
    // Our own message in the chat is shown from the copy kept at sending.
    dispatch(&mut crypto, "sync", &[Value::str(&chat_id)]).expect("sync after sending");
    let page = http.op("messages", vec![Value::str(&chat_id)]).expect("messages");
    let Some(Value::Array(messages)) = page.get("messages") else { panic!("messages") };
    let own = messages.iter().find(|message| message.get("clientId").and_then(Value::as_str).as_deref() == Some(client_id.as_str())).expect("our message is in the chat");
    let shown = dispatch(&mut crypto, "preview", &[own.clone()]).expect("preview");
    assert_eq!(shown.get("text").and_then(Value::as_str).as_deref(), Some("Уже иду, буду через пять минут"));
    eprintln!("LIVE: {} messages decrypted in {} chats; an answer sent", seen.len(), chats.len());
}
