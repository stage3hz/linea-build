//! Server addresses, the signed list and the choice of a server, against the reference (`mobile/src/servers/list.ts`).
use invizent_core::servers::*;
use serde::Deserialize;

#[derive(Deserialize)]
struct Address { address: String, normal: Option<String> }
#[test]
fn addresses_are_accepted_and_refused_as_in_the_reference() {
    let cases: Vec<Address> = serde_json::from_str(include_str!("vectors/server-address.json")).expect("vectors");
    assert!(cases.len() >= 40);
    for case in cases { assert_eq!(normalize_server(&case.address), case.normal, "{:?}", case.address); }
}

#[derive(Deserialize)]
struct Entry { url: String, region: Option<String> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct List { version: f64, issued_at: String, servers: Vec<Entry> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListCase { name: String, payload: String, sig: String, min_version: f64, list: Option<List> }
#[derive(Deserialize)]
struct Lists { keys: Vec<String>, cases: Vec<ListCase> }
#[test]
fn signed_lists_are_accepted_and_refused_as_in_the_reference() {
    let lists: Lists = serde_json::from_str(include_str!("vectors/server-list.json")).expect("vectors");
    let keys: Vec<&str> = lists.keys.iter().map(String::as_str).collect();
    assert!(lists.cases.len() >= 15);
    for case in lists.cases {
        let got = verify_server_list(&case.payload, &case.sig, &keys, case.min_version);
        match (got, case.list) {
            (None, None) => {}
            (Some(got), Some(want)) => {
                assert_eq!(got.version, want.version, "{}", case.name);
                assert_eq!(got.issued_at, want.issued_at, "{}", case.name);
                let servers: Vec<(String, Option<String>)> = got.servers.into_iter().map(|s| (s.url, s.region)).collect();
                let wanted: Vec<(String, Option<String>)> = want.servers.into_iter().map(|s| (s.url, s.region)).collect();
                assert_eq!(servers, wanted, "{}", case.name);
            }
            (got, want) => panic!("{}: got {:?}, the reference gave {}", case.name, got, if want.is_some() { "a list" } else { "nothing" }),
        }
        // No key built in: nothing is ever accepted.
        assert!(verify_server_list(&case.payload, &case.sig, &[], case.min_version).is_none());
    }
}

fn speed(value: &Option<f64>) -> Rtt { match value { Some(ms) => Rtt::Ms(*ms), None => Rtt::Dead } }

#[derive(Deserialize)]
struct Choose { current: Option<String>, rtt: Vec<(String, Option<f64>)>, chosen: Option<String> }
#[test]
fn the_choice_matches_the_reference() {
    let cases: Vec<Choose> = serde_json::from_str(include_str!("vectors/server-choose.json")).expect("vectors");
    assert!(cases.len() >= 14);
    for (index, case) in cases.into_iter().enumerate() {
        let rtt: Vec<(String, Rtt)> = case.rtt.iter().map(|(url, value)| (url.clone(), speed(value))).collect();
        assert_eq!(choose_server(case.current.as_deref(), &rtt), case.chosen, "case {index}");
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fallback { failed: String, all: Vec<String>, rtt: Vec<(String, Option<f64>)>, down: Vec<(String, f64)>, now: f64, down_ms: f64, next: Option<String> }
#[test]
fn the_fallback_matches_the_reference() {
    let cases: Vec<Fallback> = serde_json::from_str(include_str!("vectors/server-fallback.json")).expect("vectors");
    assert!(cases.len() >= 12);
    for (index, case) in cases.into_iter().enumerate() {
        let rtt = |url: &str| case.rtt.iter().find(|(name, _)| name == url).map(|(_, value)| speed(value)).unwrap_or(Rtt::Unknown);
        let down = |url: &str| case.down.iter().find(|(name, _)| name == url).map(|(_, at)| *at).unwrap_or(0.0);
        assert_eq!(fallback_server(&case.failed, &case.all, &rtt, &down, case.now, case.down_ms), case.next, "case {index}");
    }
}
