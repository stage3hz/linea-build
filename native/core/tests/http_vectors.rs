//! Network quality, the server's errors and time limits against the reference itself; headers and answers by rule.
use invizent_core::http::*;
use invizent_core::json;
use invizent_core::network::{self, Media, Quality, RequestKind, Tier};
use serde::Deserialize;

fn tier(name: &str) -> Tier { match name { "slow" => Tier::Slow, "medium" => Tier::Medium, _ => Tier::Fast } }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Classify { rtt_ms: Option<f64>, kbps: Option<f64>, tier: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sample { ms: f64, bytes: f64, rtt_ms: Option<f64>, kbps: Option<f64>, tier: String }
#[derive(Deserialize)]
struct Timeout { kind: String, tier: String, ms: u32 }
#[derive(Deserialize)]
struct Autoload { kind: String, tier: String, loads: bool }
#[derive(Deserialize)]
struct Network { classify: Vec<Classify>, samples: Vec<Sample>, timeouts: Vec<Timeout>, autoload: Vec<Autoload> }

#[test]
fn network_quality_matches_the_reference() {
    let vectors: Network = serde_json::from_str(include_str!("vectors/network.json")).expect("vectors");
    for case in &vectors.classify { assert_eq!(network::classify(case.rtt_ms, case.kbps), tier(&case.tier), "{:?} {:?}", case.rtt_ms, case.kbps); }
    let mut state = Quality::default();
    for step in &vectors.samples {
        state = network::add_sample(state, step.ms, step.bytes);
        assert_eq!((state.rtt_ms, state.kbps, state.tier), (step.rtt_ms, step.kbps, tier(&step.tier)), "after {} ms, {} bytes", step.ms, step.bytes);
    }
    assert_eq!(vectors.timeouts.len(), 9);
    for case in &vectors.timeouts {
        let kind = match case.kind.as_str() { "send" => RequestKind::Send, "upload" => RequestKind::Upload, _ => RequestKind::Read };
        assert_eq!(network::timeout_for(kind, tier(&case.tier)), case.ms);
    }
    assert_eq!(vectors.autoload.len(), 12);
    for case in &vectors.autoload {
        let kind = match case.kind.as_str() { "photo" => Media::Photo, "video" => Media::Video, "cover" => Media::Cover, _ => Media::AnimatedAvatar };
        assert_eq!(network::autoload(kind, tier(&case.tier)), case.loads, "{} on {}", case.kind, case.tier);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ErrorCase { body: String, message: String, code: Option<String>, attempts_remaining: Option<u8>, attempts_left: Option<u8>, retry_after_seconds: Option<f64>, ready_at: Option<String>, server_time: Option<String>, expires_at: Option<String>, received: Option<f64> }
#[test]
fn server_errors_are_read_as_the_reference_reads_them() {
    let cases: Vec<ErrorCase> = serde_json::from_str(include_str!("vectors/api-error.json")).expect("vectors");
    assert!(cases.len() >= 10);
    for case in cases {
        let got = ApiError::from_answer(400, &json::parse(&case.body).expect("a body"));
        let want = ApiError { message: case.message, status: 400, code: case.code, attempts_remaining: case.attempts_remaining, attempts_left: case.attempts_left, retry_after_seconds: case.retry_after_seconds, ready_at: case.ready_at, server_time: case.server_time, expires_at: case.expires_at, received: case.received };
        assert_eq!(got, want, "body {}", case.body);
    }
}

#[derive(Deserialize)]
struct TimeoutCase { path: String, method: String, tier: String, ms: u32 }
#[test]
fn time_limits_match_the_reference() {
    let cases: Vec<TimeoutCase> = serde_json::from_str(include_str!("vectors/request-timeout.json")).expect("vectors");
    assert!(cases.len() >= 90);
    for case in cases { assert_eq!(request_timeout(&case.path, &case.method, tier(&case.tier)), case.ms, "{} {} on {}", case.method, case.path, case.tier); }
}

#[test]
fn headers_are_those_of_the_reference() {
    assert_eq!(client_header("0.16.3", Platform::Ios), "invizent; v=0.16.3; p=ios");
    assert_eq!(client_header("1.0.0", Platform::Android), "invizent; v=1.0.0; p=android");
    let base = Outgoing { method: "GET", path: "/me", json_body: false, client: "invizent; v=1; p=ios", token: None, proof: None, attest_key: "k", now_ms: 1_763_660_000_999 };
    // A read is not signed; without a session nothing else is sent.
    assert_eq!(headers(&base), vec![("X-Linea-Client", "invizent; v=1; p=ios".to_string())]);
    // A write with a session and a proof: signed with whole seconds, in the reference's order.
    let write = Outgoing { method: "post", path: "/chats/42/messages?lean=1", json_body: true, token: Some("tok"), proof: Some("prf"), attest_key: "a-per-build-key-0123456789abcdef", ..base };
    let got = headers(&write);
    let names: Vec<&str> = got.iter().map(|(name, _)| *name).collect();
    assert_eq!(names, vec!["X-Linea-Client", "X-Linea-Attest", "Content-Type", "Authorization", "X-Linea-Proof"]);
    // The same signature the server reference made for these inputs (tests/vectors/attest.json).
    assert!(got[1].1.starts_with("1763660000."));
    assert_eq!(got[1].1, invizent_core::attest::header("a-per-build-key-0123456789abcdef", 1_763_660_000, "POST", "/chats/42/messages?lean=1").unwrap());
    assert_eq!(got[3].1, "Bearer tok");
    // No key in the build: no signature. A proof without a session is never sent.
    let unsigned = Outgoing { method: "DELETE", path: "/chats/7", json_body: false, token: None, proof: Some("prf"), attest_key: "", ..base };
    assert_eq!(headers(&unsigned).len(), 1);
}

#[test]
fn answers_mean_what_they_mean_in_the_reference() {
    let ok = read_answer(200, r#"{"a":1}"#);
    assert!(matches!(ok.outcome, Outcome::Ok(_)) && ok.server_ok && !ok.update_required);
    assert_eq!(read_answer(204, "").outcome, Outcome::Ok(json::parse("{}").unwrap()));
    assert_eq!(read_answer(200, "not json").outcome, Outcome::Ok(json::parse("{}").unwrap()));
    for status in [502, 503, 504] { let down = read_answer(status, "<html>"); assert_eq!(down.outcome, Outcome::ServerDown); assert!(!down.server_ok); }
    let retired = read_answer(426, r#"{"error":"Обнови приложение"}"#);
    assert!(retired.update_required && retired.server_ok);
    let Outcome::Refused(error) = retired.outcome else { panic!() };
    assert_eq!((error.status, error.message.as_str()), (426, "Обнови приложение"));
    let Outcome::Refused(proof) = read_answer(401, r#"{"error":"x","code":"device_proof"}"#).outcome else { panic!() };
    assert!(wants_proof(&proof));
    let Outcome::Refused(other) = read_answer(401, r#"{"error":"x"}"#).outcome else { panic!() };
    assert!(!wants_proof(&other));
    let Outcome::Refused(crash) = read_answer(500, "").outcome else { panic!() };
    assert_eq!(crash.message, GENERIC_ERROR);
    assert!(!read_answer(500, "").server_ok);
    // Which failed requests go to the next server by themselves.
    assert!(repeats_on_next_server("GET", false, true, false));
    assert!(repeats_on_next_server("", false, true, false));
    assert!(!repeats_on_next_server("POST", false, true, false));
    assert!(repeats_on_next_server("POST", true, true, false));
    assert!(!repeats_on_next_server("GET", false, false, false));
    assert!(!repeats_on_next_server("POST", true, true, true));
    // Which requests may need the device proof.
    assert!(bound(Some("t"), "/me") && !bound(None, "/me") && !bound(Some(""), "/me") && !bound(Some("t"), "/auth/device/challenge"));
}
