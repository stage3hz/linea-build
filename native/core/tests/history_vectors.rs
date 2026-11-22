//! Old chats on a new device (`e2ee::history`, `qr`) against the reference itself (`tests/generate-history-vectors.mjs`
//! runs `mobile/src/e2ee/history.ts` and `qr.ts`): the same secret from the same bytes, the same keys, the same
//! sealed page byte for byte, the same refusals, the same QR modules.
use aes_gcm_siv::{AeadInOut as _, Aes256GcmSiv, KeyInit as _};
use base64::Engine as _;
use invizent_core::e2ee::history::{self, PageCipher};
use invizent_core::json::{self, Value};
use serde_json::Value as J;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// AES-256-GCM-SIV of the same crate the Signal library uses (`signal::seal` / `open`).
struct Cipher;
impl PageCipher for Cipher {
    fn seal(&self, plain: &str, key: &str, nonce: &str, ad: &str) -> Result<String, ()> {
        let cipher = Aes256GcmSiv::new_from_slice(&B64.decode(key).map_err(|_| ())?).map_err(|_| ())?;
        let nonce = aes_gcm_siv::Nonce::try_from(B64.decode(nonce).map_err(|_| ())?.as_slice()).map_err(|_| ())?;
        let mut buffer = B64.decode(plain).map_err(|_| ())?;
        cipher.encrypt_in_place(&nonce, &B64.decode(ad).map_err(|_| ())?, &mut buffer).map_err(|_| ())?;
        Ok(B64.encode(buffer))
    }
    fn open(&self, sealed: &str, key: &str, nonce: &str, ad: &str) -> Result<String, ()> {
        let cipher = Aes256GcmSiv::new_from_slice(&B64.decode(key).map_err(|_| ())?).map_err(|_| ())?;
        let nonce = aes_gcm_siv::Nonce::try_from(B64.decode(nonce).map_err(|_| ())?.as_slice()).map_err(|_| ())?;
        let mut buffer = B64.decode(sealed).map_err(|_| ())?;
        cipher.decrypt_in_place(&nonce, &B64.decode(ad).map_err(|_| ())?, &mut buffer).map_err(|_| ())?;
        Ok(B64.encode(buffer))
    }
}

fn vectors() -> J { serde_json::from_str(include_str!("vectors/history.json")).expect("vectors") }
fn s(value: &J) -> &str { value.as_str().expect("text") }
/// The reference's answer to `openPage`: `{ok: {items, last}}` or `{error}`.
fn outcome(result: Result<(Vec<Value>, bool), &'static str>) -> J {
    match result {
        Ok((items, last)) => serde_json::json!({ "ok": { "items": serde_json::from_str::<J>(&json::stringify(&Value::Array(items))).unwrap(), "last": last } }),
        Err(words) => serde_json::json!({ "error": words }),
    }
}

#[test]
fn the_backup_secret_is_made_parsed_and_turned_into_keys_as_the_reference_does() {
    let v = vectors();
    let user = s(&v["user"]);
    for case in v["secrets"].as_array().unwrap() {
        let bytes: [u8; 20] = B64.decode(s(&case["bytes"])).unwrap().try_into().unwrap();
        let secret = history::backup_secret_from(&bytes);
        assert_eq!(secret, s(&case["secret"]));
        assert_eq!(history::format_secret(&secret), s(&case["formatted"]));
        assert_eq!(history::secret_qr(&secret), s(&case["qr"]));
        for pair in case["parsed"].as_array().unwrap() {
            assert_eq!(history::parse_secret(s(&pair[0])).as_deref(), pair[1].as_str(), "parse {}", pair[0]);
        }
        let (key, check) = history::backup_keys(&secret, s(&case["salt"]), user).unwrap();
        assert_eq!((key.as_str(), check.as_str()), (s(&case["keys"]["key"]), s(&case["keys"]["keyCheck"])));
        let (other, _) = history::backup_keys(&secret, s(&case["salt"]), "a0000000-0000-4000-8000-000000000001").unwrap();
        assert_eq!(other, s(&case["otherUser"]["key"]));
        assert!(history::backup_keys(&secret, "c2hvcnQ=", user).is_none(), "a salt shorter than 16 bytes");
    }
}

#[test]
fn pages_are_sealed_byte_for_byte_and_opened_with_the_same_refusals() {
    let v = vectors();
    // The items as the reference wrote them (key order kept: serde_json would sort the keys).
    let raw = json::parse(include_str!("vectors/history.json")).expect("vectors");
    let Some(Value::Array(raw_pages)) = raw.get("pages") else { panic!("pages") };
    for (page, raw_page) in v["pages"].as_array().unwrap().iter().zip(raw_pages) {
        let nonce: [u8; 12] = B64.decode(s(&page["nonce"])).unwrap().try_into().unwrap();
        let Some(Value::Array(items)) = raw_page.get("items").cloned() else { panic!("items") };
        let body = history::seal_page(&Cipher, s(&page["key"]), s(&page["ad"]), &items, page["last"].as_bool().unwrap(), Some(nonce)).unwrap();
        assert_eq!(body, s(&page["body"]));
        assert_eq!(outcome(history::open_page(&Cipher, s(&page["key"]), s(&page["ad"]), &body)), page["opened"]);
        assert_eq!(outcome(history::open_page(&Cipher, s(&page["key"]), &format!("{}x", s(&page["ad"])), &body)), page["wrongAd"]);
        let mut tampered = B64.decode(&body).unwrap();
        *tampered.last_mut().unwrap() ^= 1;
        assert_eq!(outcome(history::open_page(&Cipher, s(&page["key"]), s(&page["ad"]), &B64.encode(tampered))), page["tampered"]);
        assert_eq!(outcome(history::open_page(&Cipher, s(&page["key"]), s(&page["ad"]), &body[..20])), page["short"]);
    }
    for page in v["odd"].as_array().unwrap() {
        assert_eq!(outcome(history::open_page(&Cipher, s(&page["key"]), s(&page["ad"]), s(&page["body"]))), page["opened"], "{}", page["body"]);
    }
}

#[test]
fn notes_ads_and_qr_codes_are_the_reference_s() {
    let v = vectors();
    let (user, transfer) = (s(&v["user"]), "a0000000-0000-4000-8000-000000000001");
    let key = format!("{}=", "C".repeat(43));
    assert_eq!(history::transfer_note(transfer, &key, 3.0), s(&v["notes"]["transfer"]));
    for pair in v["notes"]["transferParsed"].as_array().unwrap() {
        let got = history::parse_transfer_note(s(&pair[0]), transfer).map(|(key, pages)| serde_json::json!({ "key": key, "pageCount": pages as i64 }));
        assert_eq!(got.unwrap_or(J::Null), pair[1], "{}", pair[0]);
    }
    let secret = s(&v["secrets"][0]["secret"]);
    assert_eq!(history::secret_note(user, 2.0, secret), s(&v["notes"]["secret"]));
    for pair in v["notes"]["secretParsed"].as_array().unwrap() {
        let got = history::parse_secret_note(s(&pair[0]), user).map(|(generation, secret)| serde_json::json!({ "generation": generation as i64, "secret": secret }));
        assert_eq!(got.unwrap_or(J::Null), pair[1], "{}", pair[0]);
    }
    for case in v["ads"].as_array().unwrap() { assert_eq!(history::transfer_ad(s(&case[1]), case[2].as_f64().unwrap()), s(&case[0])) }
    for pair in v["qr"].as_array().unwrap() {
        let got = invizent_core::qr::matrix(s(&pair[0])).map(|rows| rows.iter().map(|row| row.iter().map(|dark| if *dark { '1' } else { '0' }).collect::<String>()).collect::<Vec<_>>());
        let want: Option<Vec<String>> = pair[1].as_array().map(|rows| rows.iter().map(|row| s(row).to_string()).collect());
        assert_eq!(got, want, "QR of {:?}", pair[0]);
    }
}

#[test]
fn the_view_names_answer_like_the_functions() {
    let secret = history::new_backup_secret();
    let args = |list: Vec<Value>| list;
    assert_eq!(history::view("historyParseSecret", &args(vec![Value::str(&history::format_secret(&secret).to_lowercase())])), Some(Value::str(&secret)));
    assert_eq!(history::view("historyParseSecret", &args(vec![Value::str("x")])), Some(Value::Null));
    let qr = history::view("historyQr", &args(vec![Value::str(&history::secret_qr(&secret).to_uppercase())])).unwrap();
    assert!(matches!(&qr, Value::Array(rows) if rows.len() == 29));
    assert_eq!(history::view("historyNope", &[]), None);
}
