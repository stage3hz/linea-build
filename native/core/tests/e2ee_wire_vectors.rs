//! An encrypted message on the wire, against the reference's own validators and canonical form.
use invizent_core::e2ee::wire::*;
use invizent_core::json;
use serde::Deserialize;
use std::cmp::Ordering;

#[derive(Deserialize)]
struct Order { a: String, b: String, sign: i8 }
#[test]
fn ids_are_ordered_as_the_reference_orders_them() {
    let cases: Vec<Order> = serde_json::from_str(include_str!("vectors/id-order.json")).expect("vectors");
    assert!(cases.len() >= 700);
    let units = |text: &str| text.encode_utf16().collect::<Vec<u16>>();
    for case in cases {
        let want = match case.sign { -1 => Ordering::Less, 1 => Ordering::Greater, _ => Ordering::Equal };
        assert_eq!(id_order(&units(&case.a), &units(&case.b)), want, "{} against {}", case.a, case.b);
    }
}

#[derive(Deserialize)]
struct Wire { value: String, valid: bool, fingerprint: Option<String>, canonical: Option<String> }
#[test]
fn encrypted_messages_are_judged_and_reduced_as_in_the_reference() {
    let cases: Vec<Wire> = serde_json::from_str(include_str!("vectors/encrypted.json")).expect("vectors");
    assert!(cases.len() > 600, "{} cases", cases.len());
    assert!(cases.iter().filter(|case| case.valid).count() >= 20);
    let mut wrong = Vec::new();
    for case in &cases {
        let value = json::parse(&case.value).expect("a JSON value");
        if valid_encrypted(&value) != case.valid { wrong.push(format!("{} must be {}", &case.value[..case.value.len().min(300)], case.valid)); continue }
        if !case.valid { continue }
        if let Some(canonical) = &case.canonical { assert_eq!(&canonical_encrypted(&value), canonical) }
        assert_eq!(Some(fingerprint(&value)), case.fingerprint, "{}", &case.value[..case.value.len().min(200)]);
    }
    assert!(wrong.is_empty(), "{} of {} differ, first: {:#?}", wrong.len(), cases.len(), &wrong[..wrong.len().min(8)]);
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Identity { user_id: String, device_id: String, identity_key: String, registration_id: f64 }
impl From<Identity> for DeviceIdentity {
    fn from(d: Identity) -> Self { DeviceIdentity { user_id: d.user_id, device_id: d.device_id, identity_key: d.identity_key, registration_id: d.registration_id } }
}
#[derive(Deserialize)]
struct Code { own: Identity, other: Identity, code: String }
#[derive(Deserialize)]
struct Set { devices: Vec<Identity>, sorted: Vec<String>, fingerprint: String }
#[derive(Deserialize)]
struct Trust { codes: Vec<Code>, sets: Vec<Set> }
#[test]
fn safety_codes_and_device_fingerprints_match_the_reference() {
    let trust: Trust = serde_json::from_str(include_str!("vectors/trust.json")).expect("vectors");
    assert_eq!(trust.codes.len(), 16);
    for case in trust.codes {
        let (own, other): (DeviceIdentity, DeviceIdentity) = (case.own.into(), case.other.into());
        assert_eq!(safety_code(&own, &other), case.code);
        assert_eq!(safety_code(&other, &own), case.code, "the same on both phones");
    }
    for set in trust.sets {
        let mut devices: Vec<DeviceIdentity> = set.devices.into_iter().map(Into::into).collect();
        sort_devices(&mut devices);
        assert_eq!(devices.iter().map(|d| d.device_id.clone()).collect::<Vec<_>>(), set.sorted);
        assert_eq!(devices_fingerprint(&devices), set.fingerprint);
    }
}
