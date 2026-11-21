//! The Signal bridge against itself: two devices, both driven by `invizent_core::signal::LibSignal`.
//! Run with `cargo test --features signal` (needs `protoc` to build the library).
#![cfg(feature = "signal")]

mod signal_support;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use invizent_core::e2ee::bridge::{SignalBridge, PREKEY_MESSAGE, WHISPER_MESSAGE};
use invizent_core::signal::{self, LibSignal};
use serde_json::{json, Value};
use signal_support::*;

const ALICE: &str = "0f8fad5b-d9cb-469f-a165-70867728950e.00000000-0000-4000-8000-000000000001";
const BOB: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7.d0000001-0000-4000-8000-000000000001";

fn refused<T>(result: Result<T, invizent_core::e2ee::bridge::SignalError>, expected: &str) {
    match result {
        Ok(_) => panic!("expected {expected}, but the call went through"),
        Err(error) => {
            assert_eq!(reason(&error), expected, "{error:?}");
            if expected != "CRYPTO_FAILED" {
                assert_eq!((error.name.as_str(), error.message.as_str()), ("Error", format!("Signal operation rejected: {expected}").as_str()));
            }
        }
    }
}
fn with(state: &str, change: impl FnOnce(&mut Value)) -> String {
    let mut value = state_json(state);
    change(&mut value);
    value.to_string()
}

#[test]
fn a_new_state_has_the_shape_the_apps_keep() {
    let party = Party::new(ALICE);
    let state = state_json(&party.state);
    let keys: Vec<&str> = state.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, ["identityKeyPair", "kyberPreKeyId", "kyberPreKeys", "kyberUsed", "libsignalVersion", "localAddressName", "localDeviceId", "nextPreKeyId", "preKeys", "registrationId", "senderKeys", "sessions", "signedPreKeyId", "signedPreKeys", "trustedIdentities", "version"]);
    // The text itself has its keys in order, as the Swift exporter writes them.
    let places: Vec<usize> = keys.iter().map(|key| party.state.find(&format!("\"{key}\":")).expect("the key")).collect();
    assert!(places.windows(2).all(|pair| pair[0] < pair[1]) && party.state.starts_with("{\"identityKeyPair\":\""));
    assert_eq!((state["version"].clone(), state["libsignalVersion"].clone()), (json!(1), json!("0.106.0")));
    assert_eq!((state["localAddressName"].clone(), state["localDeviceId"].clone()), (json!(ALICE), json!(1)));
    assert_eq!((state["nextPreKeyId"].clone(), state["signedPreKeyId"].clone(), state["kyberPreKeyId"].clone()), (json!(21), json!(1), json!(1)));
    let count = |name: &str| state[name].as_object().unwrap().len();
    assert_eq!((count("preKeys"), count("signedPreKeys"), count("kyberPreKeys"), count("sessions"), count("trustedIdentities"), count("kyberUsed"), count("senderKeys")), (20, 1, 1, 0, 0, 0, 0));
    assert!(state["preKeys"].as_object().unwrap().keys().all(|id| (1..=20).contains(&id.parse::<u32>().unwrap())));

    let registration = party.bundle["registrationId"].as_u64().unwrap();
    assert!((1..=16380).contains(&registration) && state["registrationId"] == json!(registration));
    let size = |value: &Value| STANDARD.decode(value.as_str().unwrap()).expect("base64").len();
    assert_eq!(size(&party.bundle["identityKey"]), 33);
    assert_eq!((party.bundle["signedPreKey"]["id"].clone(), size(&party.bundle["signedPreKey"]["publicKey"]), size(&party.bundle["signedPreKey"]["signature"])), (json!(1), 33, 64));
    assert_eq!((party.bundle["kyberPreKey"]["id"].clone(), size(&party.bundle["kyberPreKey"]["publicKey"]), size(&party.bundle["kyberPreKey"]["signature"])), (json!(1), 1569, 64));
    let pre_keys = party.bundle["preKeys"].as_array().unwrap();
    assert_eq!(pre_keys.iter().map(|key| key["id"].as_u64().unwrap()).collect::<Vec<_>>(), (1..=20).collect::<Vec<u64>>());
    assert!(pre_keys.iter().all(|key| size(&key["publicKey"]) == 33));
    // Two states never share keys.
    let other = Party::new(ALICE);
    assert_ne!(other.identity(), party.identity());
    assert_ne!(other.bundle["preKeys"][0]["publicKey"], party.bundle["preKeys"][0]["publicKey"]);
}

#[test]
fn a_conversation_opens_with_a_prekey_message_and_goes_on_with_ordinary_ones() {
    let (mut alice, mut bob) = pair(ALICE, BOB);
    let first = alice.seal(BOB, "Привет, Боб 👋", Some(&claimed(&bob.bundle, Some(0))));
    assert_eq!(first.0, PREKEY_MESSAGE);
    // Until Bob answers, everything Alice sends still carries the opening.
    let second = alice.seal(BOB, "ещё одно", None);
    assert_eq!(second.0, PREKEY_MESSAGE);
    assert_eq!(bob.open(ALICE, &first), "Привет, Боб 👋");
    let bob_state = state_json(&bob.state);
    assert_eq!(bob_state["preKeys"].as_object().unwrap().len(), 19, "the one-time prekey is spent");
    assert!(bob_state["preKeys"].get("1").is_none());
    assert_eq!(bob_state["kyberPreKeys"].as_object().unwrap().len(), 1, "the last-resort Kyber prekey stays");
    let used: Vec<&String> = bob_state["kyberUsed"].as_object().unwrap().keys().collect();
    assert!(used.len() == 1 && used[0].starts_with("1:1:") && bob_state["kyberUsed"][used[0]] == json!(true), "{used:?}");
    assert_eq!(bob_state["sessions"].as_object().unwrap().keys().collect::<Vec<_>>(), [&format!("{ALICE}#1")]);
    assert_eq!(bob.open(ALICE, &second), "ещё одно");
    assert_eq!(state_json(&bob.state)["kyberUsed"].as_object().unwrap().len(), 1, "the same opening is not counted twice");

    let reply = bob.seal(ALICE, "Здравствуй, Алиса", None);
    assert_eq!(reply.0, WHISPER_MESSAGE);
    assert_eq!(alice.open(BOB, &reply), "Здравствуй, Алиса");
    for round in 0..6 {
        let out = alice.seal(BOB, &format!("от Алисы {round}"), None);
        assert_eq!(out.0, WHISPER_MESSAGE);
        assert_eq!(bob.open(ALICE, &out), format!("от Алисы {round}"));
        let back = bob.seal(ALICE, &format!("от Боба {round}"), None);
        assert_eq!(back.0, WHISPER_MESSAGE);
        assert_eq!(alice.open(BOB, &back), format!("от Боба {round}"));
    }
    // The same text never gives the same bytes, and an empty text is a message too.
    let (one, two) = (alice.seal(BOB, "", None), alice.seal(BOB, "", None));
    assert_ne!(one.1, two.1);
    assert_eq!((bob.open(ALICE, &one), bob.open(ALICE, &two)), (String::new(), String::new()));
}

#[test]
fn messages_arriving_out_of_order_open_and_a_repeated_one_does_not() {
    let (mut alice, mut bob) = pair(ALICE, BOB);
    let opening = alice.seal(BOB, "0", Some(&claimed(&bob.bundle, Some(3))));
    bob.open(ALICE, &opening);
    let reply = bob.seal(ALICE, "ok", None);
    alice.open(BOB, &reply);
    let sent: Vec<(f64, String)> = (1..=5).map(|index| alice.seal(BOB, &index.to_string(), None)).collect();
    for index in [4usize, 0, 3, 1, 2] { assert_eq!(bob.open(ALICE, &sent[index]), (index + 1).to_string()) }
    // Bob's own messages, late and in the other order, while Alice keeps writing.
    let from_bob: Vec<(f64, String)> = (0..3).map(|index| bob.seal(ALICE, &format!("b{index}"), None)).collect();
    let more = alice.seal(BOB, "6", None);
    assert_eq!(alice.open(BOB, &from_bob[2]), "b2");
    assert_eq!(bob.open(ALICE, &more), "6");
    assert_eq!(alice.open(BOB, &from_bob[0]), "b0");
    assert_eq!(alice.open(BOB, &from_bob[1]), "b1");

    let again = bob.try_open(ALICE, &sent[2]).expect_err("a message opens once");
    assert_eq!((again.name.as_str(), reason(&again)), ("DuplicatedMessage", "CRYPTO_FAILED"), "{again:?}");
    let mut broken = sent[4].clone();
    let mut bytes = STANDARD.decode(&broken.1).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 1;
    broken.1 = STANDARD.encode(&bytes);
    let fresh = alice.seal(BOB, "7", None);
    let mut tampered = fresh.clone();
    let mut bytes = STANDARD.decode(&tampered.1).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 1;
    tampered.1 = STANDARD.encode(&bytes);
    assert_eq!(reason(&bob.try_open(ALICE, &tampered).expect_err("a changed message is refused")), "CRYPTO_FAILED");
    assert_eq!(reason(&bob.try_open(ALICE, &broken).expect_err("a changed message is refused")), "CRYPTO_FAILED");
    // A refused message costs nothing: the untouched one still opens with the state Bob kept.
    assert_eq!(bob.open(ALICE, &fresh), "7");
}

#[test]
fn a_bundle_given_while_a_session_lives_starts_a_new_one() {
    let (mut alice, mut bob) = pair(ALICE, BOB);
    let opening = alice.seal(BOB, "первое", Some(&claimed(&bob.bundle, Some(0))));
    bob.open(ALICE, &opening);
    let reply = bob.seal(ALICE, "ответ", None);
    alice.open(BOB, &reply);
    let before = alice.seal(BOB, "по старой сессии", None);
    assert_eq!(before.0, WHISPER_MESSAGE);
    let late_from_bob = bob.seal(ALICE, "по старой сессии от Боба", None);

    // Alice decides to rekey: the bundle must not be swallowed by the live session.
    let rekeyed = alice.seal(BOB, "по новой сессии", Some(&claimed(&bob.bundle, Some(1))));
    assert_eq!(rekeyed.0, PREKEY_MESSAGE);
    assert_eq!(state_json(&alice.state)["sessions"].as_object().unwrap().len(), 1, "one record, the old chain archived inside it");
    assert_eq!(bob.open(ALICE, &rekeyed), "по новой сессии");
    let bob_state = state_json(&bob.state);
    assert_eq!((bob_state["preKeys"].as_object().unwrap().len(), bob_state["kyberUsed"].as_object().unwrap().len()), (18, 2));
    // What was sent in the old session before the rekey still opens on both sides.
    assert_eq!(bob.open(ALICE, &before), "по старой сессии");
    assert_eq!(alice.open(BOB, &late_from_bob), "по старой сессии от Боба");
    // And the conversation goes on in the new one.
    let back = bob.seal(ALICE, "принято", None);
    assert_eq!(back.0, WHISPER_MESSAGE);
    assert_eq!(alice.open(BOB, &back), "принято");
    let next = alice.seal(BOB, "дальше", None);
    assert_eq!(next.0, WHISPER_MESSAGE);
    assert_eq!(bob.open(ALICE, &next), "дальше");
    // A rekey with a bundle that has no one-time prekey works too.
    let third = alice.seal(BOB, "третья", Some(&claimed(&bob.bundle, None)));
    assert_eq!(third.0, PREKEY_MESSAGE);
    assert_eq!(bob.open(ALICE, &third), "третья");
    assert_eq!(state_json(&bob.state)["preKeys"].as_object().unwrap().len(), 18);
}

#[test]
fn nothing_is_sent_or_opened_without_an_approved_identity() {
    let (mut alice, mut bob) = (Party::new(ALICE), Party::new(BOB));
    let bundle = claimed(&bob.bundle, Some(0));
    refused(alice.try_seal(BOB, "x", Some(&bundle)), "TRUST_REQUIRED");
    refused(alice.try_seal(BOB, "x", None), "TRUST_REQUIRED");
    alice.trust(BOB, &bob.identity());
    let opening = alice.seal(BOB, "привет", Some(&bundle));
    // Bob has not approved Alice: nothing is trusted on first use.
    refused(bob.try_open(ALICE, &opening), "TRUST_REQUIRED");
    assert_eq!(state_json(&bob.state)["preKeys"].as_object().unwrap().len(), 20);
    bob.trust(ALICE, &alice.identity());
    assert_eq!(bob.open(ALICE, &opening), "привет");

    // Pinning the same key again changes nothing; another key for the same device is refused.
    let pinned = alice.state.clone();
    alice.trust(BOB, &bob.identity());
    assert_eq!(alice.state, pinned);
    let stranger = Party::new(BOB);
    refused(LibSignal.trust_identity(&alice.state, BOB, 1, &stranger.identity()), "IDENTITY_CHANGED");
    refused(LibSignal.trust_identity(&alice.state, BOB, 1, "AAAA"), "INVALID_IDENTITY");
    refused(LibSignal.trust_identity(&alice.state, BOB, 1, "not base64"), "INVALID_BASE64");
    refused(LibSignal.trust_identity(&alice.state, BOB, 1, &STANDARD.encode([7u8; 33])), "CRYPTO_FAILED");
    refused(LibSignal.trust_identity(&alice.state, BOB, 2, &bob.identity()), "INVALID_ADDRESS");
    // Both refusals read as refusals over identity or trust, never as a lost session.
    for error in [alice.try_seal(ALICE, "x", None).unwrap_err(), LibSignal.trust_identity(&alice.state, BOB, 1, &stranger.identity()).unwrap_err()] {
        assert!(!reads_as_lost_session(&error), "{error:?}");
    }
}

#[test]
fn a_changed_identity_is_refused_in_both_directions() {
    let (mut alice, mut bob) = pair(ALICE, BOB);
    let opening = alice.seal(BOB, "до", Some(&claimed(&bob.bundle, Some(0))));
    bob.open(ALICE, &opening);
    let reply = bob.seal(ALICE, "ответ", None);
    alice.open(BOB, &reply);

    // Bob's device is set up anew under the same address: a new identity.
    let mut reinstalled = Party::new(BOB);
    reinstalled.trust(ALICE, &alice.identity());
    // Sending: the bundle carries a key Alice has not approved.
    let changed = alice.try_seal(BOB, "после", Some(&claimed(&reinstalled.bundle, Some(0)))).expect_err("refused");
    assert_eq!(reason(&changed), "IDENTITY_CHANGED");
    assert!(changed.message.to_lowercase().contains("identity") && !reads_as_lost_session(&changed));
    // Receiving: an opening message signed by the new identity does not open, and Alice's state does not move.
    let from_new = reinstalled.seal(ALICE, "я новый", Some(&claimed(&alice.bundle, Some(0))));
    assert_eq!(from_new.0, PREKEY_MESSAGE);
    let untrusted = alice.try_open(BOB, &from_new).expect_err("refused");
    assert_eq!((untrusted.name.as_str(), reason(&untrusted)), ("UntrustedIdentity", "CRYPTO_FAILED"), "{untrusted:?}");
    assert!(untrusted.message.contains("untrusted identity") && !reads_as_lost_session(&untrusted), "{untrusted:?}");
    // The old Bob still talks to Alice.
    let old = bob.seal(ALICE, "я прежний", None);
    assert_eq!(alice.open(BOB, &old), "я прежний");
}

#[test]
fn a_lost_session_reads_as_a_lost_session() {
    let (mut alice, mut bob) = pair(ALICE, BOB);
    // No session yet and no bundle given.
    let none = alice.try_seal(BOB, "x", None).expect_err("no session");
    assert_eq!((none.name.as_str(), none.code.as_str()), ("LibSignalError", "ERR_LINEA_SIGNAL_CRYPTO_FAILED"));
    assert_eq!(none.message, format!("session with {BOB}.1 not found: message_encrypt"));
    assert!(reads_as_lost_session(&none));

    let opening = alice.seal(BOB, "1", Some(&claimed(&bob.bundle, Some(0))));
    bob.open(ALICE, &opening);
    let reply = bob.seal(ALICE, "2", None);
    alice.open(BOB, &reply);
    let message = bob.seal(ALICE, "3", None);
    // Alice's session record is gone (a restored backup, a cleared table).
    let lost = with(&alice.state, |state| state["sessions"] = json!({}));
    let error = LibSignal.decrypt(&lost, BOB, 1, message.0, &message.1).expect_err("no session");
    assert_eq!(error.message, format!("session with {BOB}.1 not found: message_decrypt_signal"));
    assert!(reads_as_lost_session(&error));
    assert!(reads_as_lost_session(&LibSignal.encrypt(&lost, BOB, 1, "x", None).expect_err("no session")));
    // With a bundle the conversation starts again from the same state.
    let mut restored = Party::from_state(ALICE, &lost);
    let again = restored.seal(BOB, "4", Some(&claimed(&bob.bundle, Some(1))));
    assert_eq!(again.0, PREKEY_MESSAGE);
    assert_eq!(bob.open(ALICE, &again), "4");
}

#[test]
fn an_opening_message_starts_a_session_once() {
    let (mut alice, mut bob) = pair(ALICE, BOB);
    // Without a one-time prekey only the durable record of the Kyber prekey's use stands against a replay.
    let opening = alice.seal(BOB, "раз", Some(&claimed(&bob.bundle, None)));
    let fresh = bob.state.clone();
    assert_eq!(bob.open(ALICE, &opening), "раз");
    // Replayed while the session lives: the library knows the message.
    let again = bob.try_open(ALICE, &opening).expect_err("replayed");
    assert_eq!(again.name, "DuplicatedMessage", "{again:?}");
    // Replayed after the session record is lost: the record of the use refuses it.
    let lost = with(&bob.state, |state| state["sessions"] = json!({}));
    refused(LibSignal.decrypt(&lost, ALICE, 1, opening.0, &opening.1), "REUSED_BASE_KEY");
    // The record is what refuses: without it the very same state opens the message again.
    let forgotten = with(&lost, |state| state["kyberUsed"] = json!({}));
    assert_eq!(LibSignal.decrypt(&forgotten, ALICE, 1, opening.0, &opening.1).expect("opens").plaintext, "раз");
    assert_eq!(LibSignal.decrypt(&fresh, ALICE, 1, opening.0, &opening.1).expect("opens").plaintext, "раз");

    // With a one-time prekey the prekey itself is gone after the first opening.
    let mut carol = Party::new("carol.dev");
    carol.trust(BOB, &bob.identity());
    bob.trust("carol.dev", &carol.identity());
    let with_pre_key = carol.seal(BOB, "два", Some(&claimed(&bob.bundle, Some(5))));
    assert_eq!(bob.open("carol.dev", &with_pre_key), "два");
    let lost = with(&bob.state, |state| { state["sessions"].as_object_mut().unwrap().remove("carol.dev#1"); });
    let gone = LibSignal.decrypt(&lost, "carol.dev", 1, with_pre_key.0, &with_pre_key.1).expect_err("the prekey is spent");
    assert_eq!((reason(&gone), gone.message.as_str()), ("CRYPTO_FAILED", "invalid prekey identifier"));
    // The record of uses is capped: a full one refuses a new opening rather than forget an old one.
    let full = with(&fresh, |state| { for index in 0..50000 { state["kyberUsed"][format!("9:9:{index}")] = json!(true) } });
    refused(LibSignal.decrypt(&full, ALICE, 1, opening.0, &opening.1), "REPLAY_RECORD_CAPACITY");
}

#[test]
fn new_prekeys_continue_the_numbering() {
    let mut party = Party::new(ALICE);
    let (state, bundle) = LibSignal.replenish(&party.state, 5).expect("five more");
    let bundle = from_core(&bundle);
    assert_eq!(bundle["preKeys"].as_array().unwrap().iter().map(|key| key["id"].as_u64().unwrap()).collect::<Vec<_>>(), [21, 22, 23, 24, 25]);
    // The rest of the bundle is the same device.
    for field in ["registrationId", "identityKey", "signedPreKey", "kyberPreKey"] { assert_eq!(bundle[field], party.bundle[field], "{field}") }
    let parsed = state_json(&state);
    assert_eq!((parsed["nextPreKeyId"].clone(), parsed["preKeys"].as_object().unwrap().len()), (json!(26), 25));
    party.state = state;

    // A spent prekey's number is never given again.
    let mut sender = Party::new(BOB);
    sender.trust(ALICE, &party.identity());
    party.trust(BOB, &sender.identity());
    let opening = sender.seal(ALICE, "x", Some(&claimed(&bundle, Some(4))));
    party.open(BOB, &opening);
    assert!(state_json(&party.state)["preKeys"].get("25").is_none());
    let (state, bundle) = LibSignal.replenish(&party.state, 1).expect("one more");
    assert_eq!(from_core(&bundle)["preKeys"], json!([{ "id": 26, "publicKey": state_json(&state)["preKeys"]["26"].as_str().map(|_| from_core(&bundle)["preKeys"][0]["publicKey"].clone()).unwrap() }]));
    assert_eq!(state_json(&state)["nextPreKeyId"], json!(27));

    refused(LibSignal.replenish(&party.state, 0), "INVALID_PREKEY_COUNT");
    refused(LibSignal.replenish(&party.state, 101), "INVALID_PREKEY_COUNT");
    // At most 1000 one-time prekeys are kept.
    let mut state = Party::new(ALICE).state;
    for _ in 0..9 { state = LibSignal.replenish(&state, 100).expect("a hundred more").0 }
    assert_eq!(state_json(&state)["preKeys"].as_object().unwrap().len(), 920);
    refused(LibSignal.replenish(&state, 81), "PREKEY_CAPACITY");
    let (state, bundle) = LibSignal.replenish(&state, 80).expect("up to the limit");
    assert_eq!((state_json(&state)["preKeys"].as_object().unwrap().len(), from_core(&bundle)["preKeys"][79]["id"].clone()), (1000, json!(1000)));
    refused(LibSignal.replenish(&state, 1), "PREKEY_CAPACITY");
    // The numbers end at 2^31-1.
    let near_end = with(&party.state, |state| state["nextPreKeyId"] = json!(2147483646u32));
    refused(LibSignal.replenish(&near_end, 2), "PREKEY_ID_EXHAUSTED");
    assert_eq!(from_core(&LibSignal.replenish(&near_end, 1).expect("the last number").1)["preKeys"][0]["id"], json!(2147483646u32));
    refused(LibSignal.replenish(&with(&party.state, |state| state["nextPreKeyId"] = json!(0)), 1), "PREKEY_ID_EXHAUSTED");
}

#[test]
fn a_state_is_read_the_way_the_swift_bridge_reads_it() {
    let (mut alice, mut bob) = pair(ALICE, BOB);
    let opening = alice.seal(BOB, "x", Some(&claimed(&bob.bundle, Some(0))));
    bob.open(ALICE, &opening);
    let good = bob.state.clone();
    let check = |state: &str| LibSignal.replenish(state, 1);
    assert!(check(&good).is_ok());

    // A field the bridge does not know is passed over (and not kept); the order of keys and `\/` do not matter.
    let extra = with(&good, |state| { state["somethingNew"] = json!({ "a": [1, 2] }); state["zzz"] = json!(null); });
    let (rewritten, _) = check(&extra).expect("unknown fields are passed over");
    assert!(!rewritten.contains("somethingNew"));
    let mut reversed: Vec<(String, Value)> = state_json(&good).as_object().unwrap().clone().into_iter().collect();
    reversed.reverse();
    let shuffled = format!("{{\n{}\n}}", reversed.iter().map(|(key, value)| format!("  {}: {}", json!(key), value.to_string().replace('/', "\\/"))).collect::<Vec<_>>().join(",\n"));
    assert!(shuffled.contains("\\/") && shuffled.find("\"version\"").unwrap() < shuffled.find("\"identityKeyPair\"").unwrap());
    let reply = LibSignal.encrypt(&shuffled, ALICE, 1, "ответ", None).expect("the same state, written otherwise");
    assert_eq!(alice.open(BOB, &(reply.kind, reply.body)), "ответ");
    assert!(check(&with(&good, |state| state["localDeviceId"] = json!(1.0))).is_ok());

    // Every field must be there, with its own type.
    for field in ["version", "libsignalVersion", "localAddressName", "localDeviceId", "identityKeyPair", "registrationId", "nextPreKeyId", "signedPreKeyId", "kyberPreKeyId", "preKeys", "signedPreKeys", "kyberPreKeys", "sessions", "trustedIdentities", "kyberUsed", "senderKeys"] {
        refused(check(&with(&good, |state| { state.as_object_mut().unwrap().remove(field); })), "CRYPTO_FAILED");
        refused(check(&with(&good, |state| state[field] = json!(null))), "CRYPTO_FAILED");
        refused(check(&with(&good, |state| state[field] = json!([]))), "CRYPTO_FAILED");
    }
    refused(check(&with(&good, |state| state["version"] = json!("1"))), "CRYPTO_FAILED");
    refused(check(&with(&good, |state| state["version"] = json!(1.5))), "CRYPTO_FAILED");
    refused(check(&with(&good, |state| state["registrationId"] = json!(-1))), "CRYPTO_FAILED");
    refused(check(&with(&good, |state| state["nextPreKeyId"] = json!(4294967296u64))), "CRYPTO_FAILED");
    refused(check(&with(&good, |state| state["preKeys"]["2"] = json!(7))), "CRYPTO_FAILED");
    refused(check(&with(&good, |state| { let key = state["kyberUsed"].as_object().unwrap().keys().next().unwrap().clone(); state["kyberUsed"][key] = json!(1); })), "CRYPTO_FAILED");
    for text in ["", "null", "[]", "\"state\"", "{", "{}"] { refused(check(text), "CRYPTO_FAILED") }

    // The checks of the store, in its order.
    refused(check(&with(&good, |state| state["version"] = json!(2))), "UNSUPPORTED_STATE");
    refused(check(&with(&good, |state| state["libsignalVersion"] = json!("0.105.0"))), "UNSUPPORTED_STATE");
    refused(check(&with(&good, |state| state["registrationId"] = json!(0))), "INVALID_REGISTRATION");
    refused(check(&with(&good, |state| state["registrationId"] = json!(16384))), "INVALID_REGISTRATION");
    assert!(check(&with(&good, |state| state["registrationId"] = json!(16383))).is_ok());
    let filled = |name: &'static str, count: usize| with(&good, move |state| { for index in 0..count { state[name][format!("x{index}")] = json!("AAAA") } });
    refused(check(&filled("signedPreKeys", 64)), "KEY_CAPACITY");
    refused(check(&filled("kyberPreKeys", 64)), "KEY_CAPACITY");
    refused(check(&filled("preKeys", 982)), "KEY_CAPACITY");
    refused(check(&filled("sessions", 10000)), "STATE_CAPACITY");
    refused(check(&filled("trustedIdentities", 10000)), "STATE_CAPACITY");
    refused(check(&with(&good, |state| { for index in 0..50000 { state["kyberUsed"][format!("x{index}")] = json!(true) } })), "STATE_CAPACITY");
    assert!(check(&filled("sessions", 9999)).is_ok(), "exactly at the limit");
    refused(check(&with(&good, |state| state["identityKeyPair"] = json!("AAA"))), "INVALID_BASE64");
    refused(check(&with(&good, |state| state["identityKeyPair"] = json!("AAAA"))), "CRYPTO_FAILED");
    refused(check(&with(&good, |state| state["localDeviceId"] = json!(2))), "INVALID_ADDRESS");
    refused(check(&with(&good, |state| state["localAddressName"] = json!("bob dev"))), "INVALID_ADDRESS");
    // Size: 16 MiB of text, counted in bytes.
    let padding = " ".repeat(signal::MAX_STATE - good.len());
    assert!(check(&format!("{good}{padding}")).is_ok());
    refused(check(&format!("{good}{padding} ")), "STATE_TOO_LARGE");

    // A table that is full takes no new record, but an existing one is still rewritten.
    let crowded = with(&alice.state, |state| { for index in 0..9999 { state["trustedIdentities"][format!("x{index}#1")] = json!(alice.bundle["identityKey"]) } });
    let carol = Party::new("carol.dev");
    refused(LibSignal.trust_identity(&crowded, "carol.dev", 1, &carol.identity()), "STATE_CAPACITY");
    assert!(LibSignal.trust_identity(&crowded, BOB, 1, &bob.identity()).is_ok());
    let crowded = with(&alice.state, |state| { for index in 0..9999 { state["sessions"][format!("x{index}#1")] = json!("AAAA") } });
    assert!(LibSignal.encrypt(&crowded, BOB, 1, "x", None).is_ok());
    let crowded = with(&alice.state, |state| { state["sessions"] = json!({}); for index in 0..10000 { state["sessions"][format!("x{index}#1")] = json!("AAAA") } });
    refused(LibSignal.encrypt(&crowded, BOB, 1, "x", Some(&to_core(&claimed(&bob.bundle, Some(2))))), "STATE_CAPACITY");
    // A record that is not the library's is the library's to refuse.
    let corrupt = with(&alice.state, |state| state["sessions"][format!("{BOB}#1")] = json!("AAAA"));
    assert_eq!(reason(&LibSignal.encrypt(&corrupt, BOB, 1, "x", None).expect_err("corrupt")), "CRYPTO_FAILED");
    let corrupt = with(&alice.state, |state| state["sessions"][format!("{BOB}#1")] = json!("AAA"));
    refused(LibSignal.encrypt(&corrupt, BOB, 1, "x", None), "INVALID_BASE64");
}

#[test]
fn addresses_sizes_and_message_kinds_are_checked() {
    for bad in ["", "bob dev", "боб", "bob\n", "bob/dev", &"a".repeat(161)] {
        refused(LibSignal.create_state(bad, 1), "INVALID_ADDRESS");
    }
    refused(LibSignal.create_state(ALICE, 0), "INVALID_ADDRESS");
    refused(LibSignal.create_state(ALICE, 2), "INVALID_ADDRESS");
    assert!(LibSignal.create_state(&"a".repeat(160), 1).is_ok());
    let lane = format!("{BOB}.scheduled");
    let (mut alice, mut bob) = pair(&format!("{ALICE}.scheduled"), &lane);
    assert_eq!(lane.len(), 83);
    refused(alice.try_seal("bob dev", "x", None), "INVALID_ADDRESS");
    refused(LibSignal.encrypt(&alice.state, &lane, 2, "x", None), "INVALID_ADDRESS");

    // A megabyte of text goes through; a byte more does not.
    let bundle = claimed(&bob.bundle, Some(0));
    let large = "я".repeat(signal::MAX_MESSAGE / 2);
    refused(alice.try_seal(&lane, &format!("{large}!"), Some(&bundle)), "MESSAGE_TOO_LARGE");
    let sealed = alice.seal(&lane, &large, Some(&bundle));
    let alice_name = alice.name.clone();
    assert!(bob.open(&alice_name, &sealed) == large);

    let message = alice.seal(&lane, "x", None);
    for kind in [0.0, 1.0, 2.5, 4.0, 7.0, 8.0, -3.0, f64::NAN] {
        refused(LibSignal.decrypt(&bob.state, &alice_name, 1, kind, &message.1), "UNSUPPORTED_MESSAGE_TYPE");
    }
    refused(LibSignal.decrypt(&bob.state, &alice_name, 1, 3.0, "@@@@"), "INVALID_BASE64");
    refused(LibSignal.decrypt(&bob.state, &alice_name, 1, 3.0, &message.1[..message.1.len() - 1]), "INVALID_BASE64");
    refused(LibSignal.decrypt(&bob.state, &alice_name, 1, 3.0, &STANDARD.encode(vec![0u8; signal::MAX_MESSAGE + 64 * 1024 + 1])), "INVALID_BASE64");
    // An opening message read as an ordinary one (and the other way) is the library's to refuse.
    assert_eq!(reason(&LibSignal.decrypt(&bob.state, &alice_name, 1, 2.0, &message.1).expect_err("the wrong kind")), "CRYPTO_FAILED");
    assert_eq!(reason(&LibSignal.decrypt(&bob.state, &alice_name, 1, 3.0, "").expect_err("empty")), "CRYPTO_FAILED");
    assert_eq!(bob.open(&alice_name, &message), "x");
}

#[test]
fn a_claimed_bundle_is_checked_before_the_library_sees_it() {
    let (alice, bob) = pair(ALICE, BOB);
    let good = claimed(&bob.bundle, Some(0));
    let attempt = |change: &dyn Fn(&mut Value)| { let mut bundle = good.clone(); change(&mut bundle); alice.try_seal(BOB, "x", Some(&bundle)) };
    assert!(attempt(&|_| {}).is_ok());
    assert!(attempt(&|bundle| bundle["preKey"] = json!(null)).is_ok(), "no one-time prekey");
    assert!(attempt(&|bundle| bundle["extra"] = json!(1)).is_ok());
    refused(attempt(&|bundle| { bundle.as_object_mut().unwrap().remove("signedPreKey"); }), "INVALID_FIELD");
    refused(attempt(&|bundle| bundle["kyberPreKey"] = json!("x")), "INVALID_FIELD");
    refused(attempt(&|bundle| bundle["identityKey"] = json!(5)), "INVALID_FIELD");
    refused(attempt(&|bundle| bundle["identityKey"] = json!("AAAA")), "INVALID_IDENTITY");
    refused(attempt(&|bundle| bundle["identityKey"] = json!("A")), "INVALID_BASE64");
    for bad in [json!(0), json!(16384), json!(1.5), json!("7"), json!(null), json!(true)] {
        refused(attempt(&|bundle| bundle["registrationId"] = bad.clone()), "INVALID_NUMBER");
    }
    refused(attempt(&|bundle| bundle["signedPreKey"]["id"] = json!(0)), "INVALID_NUMBER");
    refused(attempt(&|bundle| bundle["kyberPreKey"]["id"] = json!(2147483648u32)), "INVALID_NUMBER");
    refused(attempt(&|bundle| bundle["preKey"]["id"] = json!(-1)), "INVALID_NUMBER");
    refused(attempt(&|bundle| bundle["signedPreKey"]["publicKey"] = json!("AAAA")), "INVALID_PUBLIC_KEY");
    refused(attempt(&|bundle| bundle["preKey"]["publicKey"] = json!("AAAA")), "INVALID_PUBLIC_KEY");
    refused(attempt(&|bundle| { bundle["preKey"].as_object_mut().unwrap().remove("publicKey"); }), "INVALID_FIELD");
    refused(attempt(&|bundle| bundle["signedPreKey"]["signature"] = json!("AAAA")), "INVALID_SIGNATURE");
    refused(attempt(&|bundle| bundle["kyberPreKey"]["signature"] = json!("AAAA")), "INVALID_SIGNATURE");
    refused(attempt(&|bundle| bundle["kyberPreKey"]["publicKey"] = json!(STANDARD.encode(vec![8u8; 8193]))), "INVALID_BASE64");
    refused(attempt(&|bundle| bundle["kyberPreKey"]["publicKey"] = json!("AAAA")), "CRYPTO_FAILED");
    // Another device's identity under this address.
    let other = Party::new(BOB);
    refused(alice.try_seal(BOB, "x", Some(&claimed(&other.bundle, Some(0)))), "IDENTITY_CHANGED");
    // A prekey that the approved identity did not sign is the library's to refuse.
    for field in ["signedPreKey", "kyberPreKey"] {
        let error = attempt(&|bundle| bundle[field] = other.bundle[field].clone()).expect_err("a foreign signature");
        assert_eq!((reason(&error), error.message.as_str()), ("CRYPTO_FAILED", "invalid signature detected"), "{field}");
    }
}

#[test]
fn files_are_sealed_and_opened_with_the_librarys_aes_256_gcm_siv() {
    let b64 = |bytes: &[u8]| STANDARD.encode(bytes);
    let hex = |text: &str| (0..text.len() / 2).map(|at| u8::from_str_radix(&text[2 * at..2 * at + 2], 16).unwrap()).collect::<Vec<u8>>();
    // RFC 8452, appendix C.2 (AES-256-GCM-SIV).
    let (key, nonce) = (b64(&hex("0100000000000000000000000000000000000000000000000000000000000000")), b64(&hex("030000000000000000000000")));
    assert_eq!(signal::seal("", &key, &nonce, "").unwrap(), b64(&hex("07f5f4169bbf55a8400cd47ea6fd400f")));
    assert_eq!(signal::seal(&b64(&hex("0100000000000000")), &key, &nonce, "").unwrap(), b64(&hex("c2ef328e5c71c83b843122130f7364b761e0b97427e3df28")));
    assert_eq!(signal::open(&b64(&hex("c2ef328e5c71c83b843122130f7364b761e0b97427e3df28")), &key, &nonce, "").unwrap(), b64(&hex("0100000000000000")));

    let (key, nonce, ad) = (b64(&[7u8; 32]), b64(&[9u8; 12]), b64("chat:42".as_bytes()));
    let file: Vec<u8> = (0..100_000u32).map(|index| (index * 31 % 251) as u8).collect();
    let sealed = signal::seal(&b64(&file), &key, &nonce, &ad).unwrap();
    assert_eq!(STANDARD.decode(&sealed).unwrap().len(), file.len() + 16);
    assert_eq!(signal::open(&sealed, &key, &nonce, &ad).unwrap(), b64(&file));
    let failed = |result: Result<String, invizent_core::e2ee::bridge::SignalError>, expected: &str| refused(result, expected);
    failed(signal::open(&sealed, &b64(&[8u8; 32]), &nonce, &ad), "CRYPTO_FAILED");
    failed(signal::open(&sealed, &key, &b64(&[1u8; 12]), &ad), "CRYPTO_FAILED");
    failed(signal::open(&sealed, &key, &nonce, &b64("chat:43".as_bytes())), "CRYPTO_FAILED");
    let mut changed = STANDARD.decode(&sealed).unwrap();
    changed[500] ^= 0x10;
    failed(signal::open(&b64(&changed), &key, &nonce, &ad), "CRYPTO_FAILED");
    failed(signal::open(&b64(&[0u8; 15]), &key, &nonce, &ad), "INVALID_CIPHERTEXT");
    for (key, nonce) in [(b64(&[7u8; 31]), nonce.clone()), (key.clone(), b64(&[9u8; 11])), (String::new(), nonce.clone())] {
        failed(signal::seal("", &key, &nonce, &ad), "INVALID_KEY_OR_NONCE");
        failed(signal::open(&sealed, &key, &nonce, &ad), "INVALID_KEY_OR_NONCE");
    }
    failed(signal::seal("", &b64(&[7u8; 33]), &nonce, &ad), "INVALID_BASE64");
    failed(signal::seal("***", &key, &nonce, &ad), "INVALID_BASE64");
    failed(signal::seal("", &key, &nonce, &b64(&vec![0u8; 64 * 1024 + 1])), "INVALID_BASE64");
    assert!(signal::seal("", &key, &nonce, &b64(&vec![0u8; 64 * 1024])).is_ok());
}
