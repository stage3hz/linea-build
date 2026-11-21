//! A message with the card of a link, through the encryption service: from one person's service to the other's.
//!
//! Hand-written (the reference has no cards). The Signal library is a stand-in that only wraps the body in
//! base64, so a test can also play a sender that is not this app and put anything it likes inside the ciphertext;
//! the same journey with the real library is in `tests/signal_interop.rs`-style tests under `--features signal`
//! (`the_real_signal_library_carries_a_card` below).
use base64::Engine as _;
use invizent_core::chat_view::fold_chat;
use invizent_core::e2ee::bridge::*;
use invizent_core::e2ee::dispatch::dispatch;
use invizent_core::e2ee::service::Crypto;
use invizent_core::json::{self, JsString, Value};
use invizent_core::link_preview::{wire, MAX_PAYLOAD_BYTES};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

const ALICE: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";
const BOB: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const CHAT: &str = "3d6f0a88-5b1c-4f0e-9d53-1c2e6a7b8c9d";
const URL: &str = "https://news.example.ru/story/42";

fn b64(bytes: &[u8]) -> String { base64::engine::general_purpose::STANDARD.encode(bytes) }
fn unb64(text: &str) -> Vec<u8> { base64::engine::general_purpose::STANDARD.decode(text).expect("base64") }
fn jpeg(width: u16, height: u16, fill: usize) -> Vec<u8> {
    let mut out = vec![0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08];
    out.extend_from_slice(&height.to_be_bytes());
    out.extend_from_slice(&width.to_be_bytes());
    out.extend_from_slice(&[0x01, 0x01, 0x11, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
    out.extend((0..fill.max(1)).map(|index| (index % 251) as u8));
    out.extend_from_slice(&[0xff, 0xd9]);
    out
}

/// The stand-in for the Signal library: nothing is hidden, so the test can read and rewrite what travels.
struct Plain;
impl SignalBridge for Plain {
    fn create_state(&mut self, address: &str, _: u32) -> Result<(String, Value), SignalError> {
        let key: String = format!("{:A<44}", address.chars().filter(char::is_ascii_alphanumeric).take(44).collect::<String>());
        Ok(("state".to_string(), json::object(vec![("identityKey", Value::str(&key)), ("registrationId", Value::Number(77.0))])))
    }
    fn replenish(&mut self, state: &str, _: u32) -> Result<(String, Value), SignalError> { Ok((state.to_string(), Value::Null)) }
    fn trust_identity(&mut self, state: &str, _: &str, _: u32, _: &str) -> Result<String, SignalError> { Ok(state.to_string()) }
    fn encrypt(&mut self, state: &str, _: &str, _: u32, plaintext: &str, bundle: Option<&Value>) -> Result<Sealed, SignalError> {
        Ok(Sealed { state: state.to_string(), kind: if bundle.is_some() { PREKEY_MESSAGE } else { WHISPER_MESSAGE }, body: b64(plaintext.as_bytes()) })
    }
    fn decrypt(&mut self, state: &str, _: &str, _: u32, _: f64, body: &str) -> Result<Opened, SignalError> {
        Ok(Opened { state: state.to_string(), plaintext: String::from_utf8(unb64(body)).expect("text") })
    }
}

/// The stand-in for the server: the devices people published and the messages of the one chat.
#[derive(Default)]
struct World { devices: Vec<Value>, messages: Vec<Value> }
#[derive(Clone)]
struct Server { world: Rc<RefCell<World>>, user: String }
impl CryptoTransport for Server {
    fn register_crypto_device(&mut self, device_id: &str, bundle: &Value) -> Result<Value, TransportError> {
        let device = json::object(vec![("id", Value::str(device_id)), ("userId", Value::str(&self.user)), ("active", Value::Bool(true)),
            ("identityKey", bundle.get("identityKey").cloned().unwrap()), ("registrationId", bundle.get("registrationId").cloned().unwrap())]);
        let mut world = self.world.borrow_mut();
        world.devices.retain(|held| held.get("id") != device.get("id"));
        world.devices.push(device.clone());
        Ok(json::object(vec![("device", device), ("preKeyCount", Value::Number(100.0))]))
    }
    fn crypto_devices(&mut self, user_id: &str) -> Result<Value, TransportError> {
        Ok(json::object(vec![("devices", Value::Array(self.world.borrow().devices.iter().filter(|device| device.get("userId") == Some(&Value::str(user_id))).cloned().collect()))]))
    }
    fn claim_pre_key(&mut self, user_id: &str, device_id: &str) -> Result<Value, TransportError> {
        let device = self.world.borrow().devices.iter().find(|device| device.get("userId") == Some(&Value::str(user_id)) && device.get("id") == Some(&Value::str(device_id))).cloned().expect("a device");
        Ok(json::object(vec![("device", device.clone()), ("bundle", device)]))
    }
    fn crypto_inbox(&mut self, _: &str, chat_id: &str, after: f64) -> Result<Value, TransportError> {
        let messages: Vec<Value> = self.world.borrow().messages.iter().filter(|message| message.get("chatId") == Some(&Value::str(chat_id)) && matches!(message.get("id"), Some(Value::Number(id)) if *id > after)).cloned().collect();
        Ok(json::object(vec![("messages", Value::Array(messages)), ("nextCursor", Value::Null), ("hasMore", Value::Bool(false))]))
    }
}
struct Clock(u32);
impl Env for Clock {
    fn now_iso(&mut self) -> String { "2026-11-21T07:00:00.000Z".to_string() }
    fn random_uuid(&mut self) -> String { self.0 += 1; format!("d0000000-0000-4000-8000-{:012}", self.0) }
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

type Service = Crypto<Plain, Memory, Server, Clock>;
struct Pair { world: Rc<RefCell<World>>, alice: Service, alice_vault: Memory, bob: Service, bob_vault: Memory, sent: u32 }

fn pair() -> Pair {
    let world = Rc::new(RefCell::new(World::default()));
    let make = |user: &str, seed: u32, vault: &Memory| -> Service {
        // The picture that rides with a FILE keeps its own check; no test here sends a file.
        Crypto::new(user, Plain, vault.clone(), Server { world: world.clone(), user: user.to_string() }, Clock(seed), true, Box::new(|preview: Option<&Value>| preview.is_none()))
    };
    let (alice_vault, bob_vault) = (Memory::default(), Memory::default());
    let (mut alice, mut bob) = (make(ALICE, 1000, &alice_vault), make(BOB, 2000, &bob_vault));
    alice.initialize().expect("alice");
    bob.initialize().expect("bob");
    Pair { world, alice, alice_vault, bob, bob_vault, sent: 0 }
}

impl Pair {
    fn client_id(&mut self) -> String { self.sent += 1; format!("c0000000-0000-4000-8000-{:012}", self.sent) }
    /// Alice encrypts; the answer is the message as the server will hold it.
    fn encrypt(&mut self, text: &str, meta: Value, card: Option<Value>) -> Value {
        let client = self.client_id();
        let mut args = vec![Value::str(CHAT), Value::str(BOB), Value::str(&client), Value::str(text), Value::Null, meta, Value::Null];
        if let Some(card) = card { args.push(card) }
        let encrypted = dispatch(&mut self.alice, "encrypt", &args).expect("encrypted");
        json::object(vec![("id", Value::Number(f64::from(self.sent))), ("chatId", Value::str(CHAT)), ("senderId", Value::str(ALICE)), ("clientId", Value::str(&client)), ("encrypted", encrypted), ("createdAt", Value::str("2026-11-21T07:00:01.000Z"))])
    }
    /// The body inside Bob's envelope of a message, as JSON.
    fn body(message: &Value) -> Value {
        let Some(Value::Array(envelopes)) = message.get("encrypted").and_then(|encrypted| encrypted.get("envelopes")) else { panic!("envelopes") };
        let envelope = envelopes.iter().find(|envelope| envelope.get("userId") == Some(&Value::str(BOB))).expect("an envelope for Bob");
        json::parse(&String::from_utf8(unb64(&envelope.get("body").and_then(Value::as_str).unwrap())).unwrap()).expect("a body")
    }
    /// The same message with `change` applied to the body inside every envelope: a sender that is not this app.
    fn rewritten(message: &Value, change: impl Fn(&mut Vec<(JsString, Value)>)) -> Value {
        let mut message = message.clone();
        let Value::Object(fields) = &mut message else { panic!() };
        let encrypted = &mut fields.iter_mut().find(|(name, _)| *name == JsString::from_str("encrypted")).unwrap().1;
        let Value::Object(parts) = encrypted else { panic!() };
        let Value::Array(envelopes) = &mut parts.iter_mut().find(|(name, _)| *name == JsString::from_str("envelopes")).unwrap().1 else { panic!() };
        for envelope in envelopes {
            let Value::Object(entries) = envelope else { panic!() };
            let body = &mut entries.iter_mut().find(|(name, _)| *name == JsString::from_str("body")).unwrap().1;
            let Value::Object(mut inside) = json::parse(&String::from_utf8(unb64(&body.as_str().unwrap())).unwrap()).unwrap() else { panic!() };
            change(&mut inside);
            *body = Value::str(&b64(json::stringify(&Value::Object(inside)).as_bytes()));
        }
        message
    }
    /// The server takes the message, Bob opens the chat: what he is shown for it.
    fn deliver(&mut self, message: &Value) -> Value {
        self.world.borrow_mut().messages.push(message.clone());
        dispatch(&mut self.bob, "sync", &[Value::str(CHAT)]).expect("the chat opens");
        dispatch(&mut self.bob, "preview", &[message.clone()]).expect("shown")
    }
}
fn set(entries: &mut Vec<(JsString, Value)>, key: &str, value: Value) {
    let name = JsString::from_str(key);
    match entries.iter_mut().find(|(held, _)| *held == name) { Some(entry) => entry.1 = value, None => entries.push((name, value)) }
}
fn card_with(key: &str, value: Value) -> Value {
    let Value::Object(mut entries) = sample_card() else { panic!() };
    set(&mut entries, key, value);
    Value::Object(entries)
}
fn sample_card() -> Value { wire(URL, "Новости Примера", "Главная новость дня", "Что случилось и почему это важно", Some(&jpeg(480, 270, 3000))).expect("a card") }
fn text_with_link() -> String { format!("смотри {URL} — огонь") }

#[test]
fn a_card_travels_inside_the_ciphertext_and_is_shown_to_the_other_side() {
    let mut pair = pair();
    let card = sample_card();
    let message = pair.encrypt(&text_with_link(), Value::Null, Some(card.clone()));
    // On the wire: a top-level key next to `text`, never inside `meta` (older apps refuse unknown `meta` keys).
    let body = Pair::body(&message);
    assert_eq!(body.get("linkPreview"), Some(&card));
    assert_eq!(body.get("meta"), None);
    let Value::Object(entries) = &body else { panic!() };
    let names: Vec<String> = entries.iter().map(|(name, _)| name.to_string_lossy()).collect();
    assert_eq!(names, ["version", "chatId", "clientId", "senderId", "senderDeviceId", "recipientId", "recipientDeviceId", "text", "attachment", "sentAt", "linkPreview"]);
    // Nothing outside the ciphertext speaks of it: the server sees the same shape as for any message.
    let outside = json::stringify(&message);
    assert!(!outside.contains("linkPreview") && !outside.contains("example.ru"), "the link is only inside the envelope");

    let shown = pair.deliver(&message);
    assert_eq!(shown.get("cryptoState"), Some(&Value::str("decrypted")));
    assert_eq!(shown.get("text"), Some(&Value::str(&text_with_link())));
    assert_eq!(shown.get("linkPreview"), Some(&card));
    // The sender's own copy has it too, and so do the history and the list of unsent messages.
    let own = dispatch(&mut pair.alice, "preview", &[message.clone()]).unwrap();
    assert_eq!(own.get("linkPreview"), Some(&card));
    for service in [&mut pair.alice, &mut pair.bob] {
        let Value::Array(history) = dispatch(service, "history", &[Value::str(CHAT)]).unwrap() else { panic!() };
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].get("linkPreview"), Some(&card));
    }
    let Value::Array(unsent) = dispatch(&mut pair.alice, "pendingOutbox", &[]).unwrap() else { panic!() };
    assert_eq!(unsent[0].get("linkPreview"), Some(&card));
    // A retry with the same id gives back exactly the same ciphertext.
    let client = message.get("clientId").cloned().unwrap();
    let again = dispatch(&mut pair.alice, "encrypt", &[Value::str(CHAT), Value::str(BOB), client, Value::str(&text_with_link()), Value::Null, Value::Null, Value::Null, card]).unwrap();
    assert_eq!(Some(&again), message.get("encrypted"));
}

#[test]
fn a_message_without_a_card_is_written_exactly_as_before() {
    let mut pair = pair();
    // No eighth argument, a null one, and a card that does not belong to the text: the same body, key for key.
    let plain = pair.encrypt(&text_with_link(), Value::Null, None);
    let null = pair.encrypt(&text_with_link(), Value::Null, Some(Value::Null));
    let stray = pair.encrypt("без ссылок", Value::Null, Some(sample_card()));
    for message in [&plain, &null, &stray] {
        let body = Pair::body(message);
        let Value::Object(entries) = &body else { panic!() };
        let names: Vec<String> = entries.iter().map(|(name, _)| name.to_string_lossy()).collect();
        assert_eq!(names, ["version", "chatId", "clientId", "senderId", "senderDeviceId", "recipientId", "recipientDeviceId", "text", "attachment", "sentAt"]);
    }
    let device = pair.bob.device_id().unwrap();
    let sender = pair.alice.device_id().unwrap();
    assert_eq!(String::from_utf8(unb64(&plain.get("encrypted").unwrap().get("envelopes").unwrap().as_array_first_body())).unwrap(),
        format!(r#"{{"version":1,"chatId":"{CHAT}","clientId":"c0000000-0000-4000-8000-000000000001","senderId":"{ALICE}","senderDeviceId":"{sender}","recipientId":"{BOB}","recipientDeviceId":"{device}","text":"{}","attachment":null,"sentAt":"2026-11-21T07:00:00.000Z"}}"#, text_with_link()));
    // Nothing in the vault of either side mentions a card.
    for message in [&plain, &null, &stray] { assert_eq!(pair.deliver(message).get("linkPreview"), None) }
    for vault in [&pair.alice_vault, &pair.bob_vault] { assert!(vault.0.borrow().values().all(|record| !record.contains("linkPreview"))) }
    assert_eq!(pair.alice_vault.0.borrow().get(&format!("message:{CHAT}:{ALICE}:c0000000-0000-4000-8000-000000000001")).map(|record| record.contains(r#""plain":{"text":"#) && record.ends_with(r#""attachment":null,"sentAt":"2026-11-21T07:00:00.000Z"}}"#)), Some(true));
}

trait FirstBody { fn as_array_first_body(&self) -> String; }
impl FirstBody for Value {
    fn as_array_first_body(&self) -> String {
        let Value::Array(envelopes) = self else { panic!("envelopes") };
        envelopes[0].get("body").and_then(Value::as_str).expect("a body")
    }
}

#[test]
fn the_sender_leaves_out_a_card_that_does_not_fit_the_message() {
    let mut pair = pair();
    let sent = |pair: &mut Pair, text: &str, meta: Value, card: Value| Pair::body(&pair.encrypt(text, meta, Some(card))).get("linkPreview").cloned();
    // The message always goes; only the card is left out.
    assert_eq!(sent(&mut pair, "совсем другая ссылка https://other.example.ru/", Value::Null, sample_card()), None);
    assert_eq!(sent(&mut pair, &text_with_link(), Value::Null, card_with("title", Value::str("две\nстроки"))), None);
    assert_eq!(sent(&mut pair, &text_with_link(), Value::Null, card_with("extra", Value::Bool(true))), None);
    assert_eq!(sent(&mut pair, &text_with_link(), Value::Null, Value::str("https://news.example.ru/story/42")), None);
    assert_eq!(sent(&mut pair, &text_with_link(), Value::Null, card_with("title", Value::str(&"т".repeat(201)))), None);
    // A link under a spoiler is hidden: no card may show it.
    let spoiler = json::parse(&format!(r#"{{"entities":[{{"type":"spoiler","offset":7,"length":{}}}]}}"#, URL.len())).unwrap();
    assert_eq!(sent(&mut pair, &text_with_link(), spoiler, sample_card()), None);
    // An action (here an edit) is not a message of its own.
    let edit = json::parse(r#"{"action":{"type":"edit","target":"c0000000-0000-4000-8000-000000000001","text":"x"}}"#).unwrap();
    assert_eq!(sent(&mut pair, &text_with_link(), edit, sample_card()), None);
    assert_eq!(sent(&mut pair, &text_with_link(), Value::Null, sample_card()), Some(sample_card()));
}

#[test]
fn a_body_too_big_for_one_envelope_loses_the_picture_not_the_message() {
    let mut pair = pair();
    // Characters that JSON writes as six bytes each: the longest body a text can make.
    let heavy_text = format!("{URL} {}", "\u{1}".repeat(7000));
    let card = wire(URL, "Сайт", "Заголовок", "Описание", Some(&jpeg(480, 480, 23 * 1024))).unwrap();
    assert!(card.get("image").is_some());
    let message = pair.encrypt(&heavy_text, Value::Null, Some(card.clone()));
    let body = Pair::body(&message);
    let sent = body.get("linkPreview").expect("the card stays");
    assert_eq!(sent.get("image"), None);
    assert_eq!(sent.get("title"), Some(&Value::str("Заголовок")));
    let size = unb64(&message.get("encrypted").unwrap().get("envelopes").unwrap().as_array_first_body()).len();
    assert!(size <= MAX_PAYLOAD_BYTES, "{size}");
    assert_eq!(pair.deliver(&message).get("linkPreview"), Some(sent));
    // With an ordinary text the same card keeps its picture.
    let light = pair.encrypt(&text_with_link(), Value::Null, Some(card.clone()));
    assert_eq!(Pair::body(&light).get("linkPreview"), Some(&card));
    assert!(unb64(&light.get("encrypted").unwrap().get("envelopes").unwrap().as_array_first_body()).len() <= MAX_PAYLOAD_BYTES);
}

#[test]
fn a_card_that_is_not_exactly_ours_is_dropped_and_the_message_is_still_shown() {
    let image = |bytes: &[u8], width: f64, height: f64| json::object(vec![("mimeType", Value::str("image/jpeg")), ("base64", Value::str(&b64(bytes))), ("width", Value::Number(width)), ("height", Value::Number(height))]);
    let mut dirty = jpeg(320, 180, 500);
    dirty.splice(2..2, [0xff, 0xfe, 0x00, 0x08, b's', b'e', b'c', b'r', b'e', b't']);
    let mut tracked = image(&jpeg(320, 180, 500), 320.0, 180.0);
    if let Value::Object(entries) = &mut tracked { set(entries, "url", Value::str("https://tracker.example.com/pixel.gif")) }
    let cases: Vec<(&str, Value)> = vec![
        ("an address that is not in the text", card_with("url", Value::str("https://phishing.example.com/login"))),
        ("an address without encryption", card_with("url", Value::str("http://news.example.ru/story/42"))),
        ("an address of a home network", card_with("url", Value::str("https://192.168.0.1/"))),
        ("an unknown key", card_with("imageUrl", Value::str("https://tracker.example.com/pixel.gif"))),
        ("a title over the limit", card_with("title", Value::str(&"т".repeat(201)))),
        ("a description over the limit", card_with("description", Value::str(&"о".repeat(501)))),
        ("a site over the limit", card_with("site", Value::str(&"с".repeat(81)))),
        ("a title with an override", card_with("title", Value::str("Отчёт\u{202e}fdp.exe"))),
        ("a title with a control", card_with("title", Value::str("a\u{0}b"))),
        ("a title of two lines", card_with("title", Value::str("a\nb"))),
        ("a title that is not a text", card_with("title", Value::Number(1.0))),
        ("no site", card_with("site", Value::str(""))),
        ("a picture with metadata", card_with("image", image(&dirty, 320.0, 180.0))),
        ("a picture over the size limit", card_with("image", image(&jpeg(481, 270, 500), 481.0, 270.0))),
        ("a picture over the weight limit", card_with("image", image(&jpeg(480, 270, 30 * 1024), 480.0, 270.0))),
        ("a picture with a wrong size", card_with("image", image(&jpeg(320, 180, 500), 480.0, 270.0))),
        ("a picture that is not a JPEG", card_with("image", image(b"GIF89a", 1.0, 1.0))),
        ("a picture with an address", card_with("image", tracked)),
        ("a picture that is an address", card_with("image", Value::str("https://tracker.example.com/pixel.gif"))),
        ("a card that is a text", Value::str(URL)),
        ("a card that is a list", Value::Array(vec![sample_card()])),
        ("a card that is a number", Value::Number(1.0)),
        ("a card that is true", Value::Bool(true)),
        ("an empty card", json::object(vec![])),
    ];
    for (name, bad) in cases {
        let mut pair = pair();
        let honest = pair.encrypt(&text_with_link(), Value::Null, Some(sample_card()));
        let forged = Pair::rewritten(&honest, |body| set(body, "linkPreview", bad.clone()));
        assert_eq!(Pair::body(&forged).get("linkPreview"), Some(&bad), "{name}");
        let shown = pair.deliver(&forged);
        assert_eq!(shown.get("cryptoState"), Some(&Value::str("decrypted")), "{name}: the message is shown");
        assert_eq!(shown.get("text"), Some(&Value::str(&text_with_link())), "{name}");
        assert_eq!(shown.get("linkPreview"), None, "{name}: the card is dropped");
        assert!(pair.bob_vault.0.borrow().values().all(|record| !record.contains("linkPreview")), "{name}: nothing of it is kept");
    }
}

#[test]
fn a_card_rides_only_with_the_text_it_was_made_for() {
    // The card is right, the message around it is not the kind that has one.
    let mut pair = pair();
    let honest = pair.encrypt(&text_with_link(), Value::Null, Some(sample_card()));
    let other_text = Pair::rewritten(&honest, |body| set(body, "text", Value::str("ссылки тут больше нет")));
    assert_eq!(pair.deliver(&other_text).get("linkPreview"), None);

    let mut pair = self::pair();
    let honest = pair.encrypt(&text_with_link(), Value::Null, Some(sample_card()));
    let spoiler = json::parse(&format!(r#"{{"entities":[{{"type":"spoiler","offset":7,"length":{}}}]}}"#, URL.len())).unwrap();
    let hidden = Pair::rewritten(&honest, |body| set(body, "meta", spoiler.clone()));
    let shown = pair.deliver(&hidden);
    assert_eq!((shown.get("cryptoState"), shown.get("linkPreview")), (Some(&Value::str("decrypted")), None));

    let mut pair = self::pair();
    let honest = pair.encrypt(&text_with_link(), Value::Null, Some(sample_card()));
    let edit = json::parse(r#"{"action":{"type":"edit","target":"c0000000-0000-4000-8000-000000000009","text":"x"}}"#).unwrap();
    let action = Pair::rewritten(&honest, |body| set(body, "meta", edit.clone()));
    let shown = pair.deliver(&action);
    assert_eq!((shown.get("cryptoState"), shown.get("linkPreview")), (Some(&Value::str("decrypted")), None));

    // A link behind words: the card names the address the words lead to.
    let mut pair = self::pair();
    let entities = json::parse(&format!(r#"{{"entities":[{{"type":"text_link","offset":0,"length":6,"url":"{URL}"}}]}}"#)).unwrap();
    let message = pair.encrypt("читать дальше", entities, Some(sample_card()));
    assert_eq!(pair.deliver(&message).get("linkPreview"), Some(&sample_card()));
}

#[test]
fn the_chat_view_carries_the_card_and_an_edit_takes_it_away() {
    let mut pair = pair();
    let message = pair.encrypt(&text_with_link(), Value::Null, Some(sample_card()));
    let shown = pair.deliver(&message);
    let fold = |messages: &[Value]| -> Vec<Value> { match fold_chat(messages, BOB, &[], 1_795_244_400_000.0).get("messages") { Some(Value::Array(list)) => list.clone(), _ => panic!("messages") } };
    let view = fold(&[shown.clone()]);
    assert_eq!(view.len(), 1);
    assert_eq!(view[0].get("linkPreview"), Some(&sample_card()));
    assert_eq!(view[0].get("edited"), Some(&Value::Bool(false)));

    // An edit by the author changes the text: the card was made for the old one and goes, whatever the new text is.
    let target = message.get("clientId").and_then(Value::as_str).unwrap();
    let edit_meta = json::parse(&format!(r#"{{"action":{{"type":"edit","target":"{target}","text":"{} (исправлено)"}}}}"#, text_with_link())).unwrap();
    let edit = pair.encrypt("✏️ изменено", edit_meta, None);
    let edit_shown = pair.deliver(&edit);
    assert_eq!(edit_shown.get("cryptoState"), Some(&Value::str("decrypted")));
    let view = fold(&[shown.clone(), edit_shown]);
    assert_eq!(view.len(), 1);
    assert_eq!(view[0].get("edited"), Some(&Value::Bool(true)));
    assert_eq!(view[0].get("text"), Some(&Value::str(&format!("{} (исправлено)", text_with_link()))));
    assert_eq!(view[0].get("linkPreview"), None);
    // A reaction changes nothing about the card.
    let reaction = json::parse(&format!(r#"{{"action":{{"type":"react","target":"{target}","emoji":"🔥"}}}}"#)).unwrap();
    let reacted = pair.encrypt("🔥", reaction, None);
    let reacted_shown = pair.deliver(&reacted);
    let view = fold(&[shown, reacted_shown]);
    assert_eq!(view[0].get("linkPreview"), Some(&sample_card()));
}

/// The same journey with the real Signal library on both sides.
#[cfg(feature = "signal")]
#[test]
fn the_real_signal_library_carries_a_card() {
    use invizent_core::signal::LibSignal;
    /// A server that also hands out the real one-time keys of a published bundle, each once.
    #[derive(Clone)]
    struct Keys { inner: Server, bundles: Rc<RefCell<BTreeMap<String, Value>>> }
    impl CryptoTransport for Keys {
        fn register_crypto_device(&mut self, device_id: &str, bundle: &Value) -> Result<Value, TransportError> { self.bundles.borrow_mut().insert(device_id.to_string(), bundle.clone()); self.inner.register_crypto_device(device_id, bundle) }
        fn crypto_devices(&mut self, user_id: &str) -> Result<Value, TransportError> { self.inner.crypto_devices(user_id) }
        fn claim_pre_key(&mut self, user_id: &str, device_id: &str) -> Result<Value, TransportError> {
            let device = self.inner.claim_pre_key(user_id, device_id)?.get("device").cloned().unwrap();
            let published = self.bundles.borrow().get(device_id).cloned().expect("a bundle");
            // A claimed bundle is the published one with a single one-time key in place of the list.
            let Value::Object(entries) = &published else { panic!("a bundle") };
            let mut claimed: Vec<(JsString, Value)> = entries.iter().filter(|(name, _)| *name != JsString::from_str("preKeys")).cloned().collect();
            if let Some(Value::Array(keys)) = published.get("preKeys") { if let Some(first) = keys.first() { claimed.push((JsString::from_str("preKey"), first.clone())) } }
            Ok(json::object(vec![("device", device), ("bundle", Value::Object(claimed))]))
        }
        fn crypto_inbox(&mut self, device_id: &str, chat_id: &str, after: f64) -> Result<Value, TransportError> { self.inner.crypto_inbox(device_id, chat_id, after) }
    }
    let world = Rc::new(RefCell::new(World::default()));
    let bundles = Rc::new(RefCell::new(BTreeMap::new()));
    let make = |user: &str, seed: u32| Crypto::new(user, LibSignal, Memory::default(), Keys { inner: Server { world: world.clone(), user: user.to_string() }, bundles: bundles.clone() }, Clock(seed), true, Box::new(|preview: Option<&Value>| preview.is_none()));
    let (mut alice, mut bob) = (make(ALICE, 1000), make(BOB, 2000));
    alice.initialize().expect("alice");
    bob.initialize().expect("bob");
    let card = sample_card();
    let mut send = |alice: &mut Crypto<LibSignal, Memory, Keys, Clock>, id: u32, card: Option<Value>| -> Value {
        let client = format!("c0000000-0000-4000-8000-{id:012}");
        let mut args = vec![Value::str(CHAT), Value::str(BOB), Value::str(&client), Value::str(&text_with_link()), Value::Null, Value::Null, Value::Null];
        if let Some(card) = card { args.push(card) }
        let encrypted = dispatch(alice, "encrypt", &args).expect("encrypted");
        let message = json::object(vec![("id", Value::Number(f64::from(id))), ("chatId", Value::str(CHAT)), ("senderId", Value::str(ALICE)), ("clientId", Value::str(&client)), ("encrypted", encrypted)]);
        world.borrow_mut().messages.push(message.clone());
        message
    };
    let with_card = send(&mut alice, 1, Some(card.clone()));
    let without = send(&mut alice, 2, None);
    // The ciphertext is really one: nothing of the card can be read outside it.
    assert!(!json::stringify(&with_card).contains("example"));
    dispatch(&mut bob, "sync", &[Value::str(CHAT)]).expect("the chat opens");
    let shown = dispatch(&mut bob, "preview", &[with_card]).unwrap();
    assert_eq!(shown.get("cryptoState"), Some(&Value::str("decrypted")));
    assert_eq!(shown.get("linkPreview"), Some(&card));
    let plain = dispatch(&mut bob, "preview", &[without]).unwrap();
    assert_eq!((plain.get("cryptoState"), plain.get("linkPreview")), (Some(&Value::str("decrypted")), None));
}
