//! JSON read and written exactly as Node does it (`JSON.parse`, `JSON.stringify`, `String(number)`).
use invizent_core::json;

#[derive(serde::Deserialize)]
struct Text { text: String, written: String }
#[derive(serde::Deserialize)]
struct Number { bits: String, text: String }

#[test]
fn parse_then_stringify_matches_node() {
    let cases: Vec<Text> = serde_json::from_str(include_str!("vectors/json.json")).expect("vectors");
    assert!(cases.len() >= 45);
    for case in cases {
        let value = json::parse(&case.text).unwrap_or_else(|error| panic!("{:?} must parse: {error:?}", case.text));
        assert_eq!(json::stringify(&value), case.written, "source {:?}", case.text);
        // Writing is stable: what was written reads back to the same value.
        assert_eq!(json::parse(&case.written).expect("own output parses"), value, "source {:?}", case.text);
    }
}

#[test]
fn numbers_print_as_in_javascript() {
    let cases: Vec<Number> = serde_json::from_str(include_str!("vectors/numbers.json")).expect("vectors");
    assert!(cases.len() >= 25);
    for case in cases {
        let number = f64::from_bits(u64::from_str_radix(&case.bits, 16).expect("hex bits"));
        assert_eq!(json::number_text(number), case.text, "bits {}", case.bits);
    }
}
