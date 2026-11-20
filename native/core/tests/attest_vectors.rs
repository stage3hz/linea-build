//! `X-Linea-Attest` against signatures made by the server's own reference (`server/src/attest.js`).
use invizent_core::attest;

#[derive(serde::Deserialize)]
struct Case { key: String, ts: u64, method: String, url: String, hex: String }

#[test]
fn signatures_match_the_server_reference() {
    let cases: Vec<Case> = serde_json::from_str(include_str!("vectors/attest.json")).expect("vectors");
    assert!(cases.len() >= 5);
    for case in cases {
        assert_eq!(attest::sign(&case.key, case.ts, &case.method, &case.url), case.hex, "{} {}", case.method, case.url);
        assert_eq!(attest::header(&case.key, case.ts, &case.method, &case.url), Some(format!("{}.{}", case.ts, case.hex)));
    }
}
