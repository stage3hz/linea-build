//! JSON exactly as the reference app's JavaScript reads and writes it.
//!
//! The logic around end-to-end encryption hashes and compares the text `JSON.stringify` produces (the canonical
//! form of an encrypted message, the trust fingerprint), so the text has to be the same to the byte. That means
//! JavaScript's own rules, not merely valid JSON:
//! - strings are sequences of UTF-16 code units and may hold a lone surrogate, written back as `\udXXX`;
//! - numbers are IEEE doubles printed the way `Number.prototype.toString` prints them;
//! - an object's keys keep the order in which they were added, except that keys that are array indices come
//!   first, in ascending order; a repeated key keeps its first place and its last value.
//! Checked against Node itself by `tests/json_vectors.rs`.

use std::fmt::Write as _;

/// A JavaScript string: UTF-16 code units, possibly with lone surrogates.
#[derive(Clone, PartialEq, Eq, Hash, Debug, Default)]
pub struct JsString(pub Vec<u16>);

impl JsString {
    pub fn from_str(text: &str) -> Self {
        JsString(text.encode_utf16().collect())
    }
    /// The text, with any lone surrogate replaced by U+FFFD (for showing, never for hashing).
    pub fn to_string_lossy(&self) -> String {
        String::from_utf16_lossy(&self.0)
    }
    /// The text when it is well-formed UTF-16.
    pub fn to_str(&self) -> Option<String> {
        String::from_utf16(&self.0).ok()
    }
}

#[derive(Clone, PartialEq, Debug)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    String(JsString),
    Array(Vec<Value>),
    /// Keys in JavaScript's own enumeration order.
    Object(Vec<(JsString, Value)>),
}

impl Value {
    pub fn str(text: &str) -> Value {
        Value::String(JsString::from_str(text))
    }
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Object(entries) => {
                let wanted = JsString::from_str(key);
                entries.iter().find(|(name, _)| *name == wanted).map(|(_, value)| value)
            }
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<String> {
        match self {
            Value::String(text) => text.to_str(),
            _ => None,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct ParseError {
    pub at: usize,
    pub what: &'static str,
}

/// Reads JSON text the way `JSON.parse` does.
pub fn parse(text: &str) -> Result<Value, ParseError> {
    let mut reader = Reader { bytes: text.as_bytes(), at: 0, depth: 0 };
    reader.space();
    let value = reader.value()?;
    reader.space();
    if reader.at != reader.bytes.len() {
        return Err(reader.error("text after the value"));
    }
    Ok(value)
}

/// Deeper than any real message; a guard against a stack overflow on hostile input.
const MAX_DEPTH: usize = 256;

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
    depth: usize,
}

impl Reader<'_> {
    fn error(&self, what: &'static str) -> ParseError {
        ParseError { at: self.at, what }
    }
    fn space(&mut self) {
        while let Some(byte) = self.bytes.get(self.at) {
            if matches!(byte, b' ' | b'\t' | b'\n' | b'\r') { self.at += 1 } else { break }
        }
    }
    fn word(&mut self, word: &str, value: Value) -> Result<Value, ParseError> {
        if self.bytes[self.at..].starts_with(word.as_bytes()) {
            self.at += word.len();
            Ok(value)
        } else {
            Err(self.error("unknown word"))
        }
    }
    fn value(&mut self) -> Result<Value, ParseError> {
        match self.bytes.get(self.at) {
            None => Err(self.error("the text ends early")),
            Some(b'n') => self.word("null", Value::Null),
            Some(b't') => self.word("true", Value::Bool(true)),
            Some(b'f') => self.word("false", Value::Bool(false)),
            Some(b'"') => Ok(Value::String(self.string()?)),
            Some(b'[') => self.array(),
            Some(b'{') => self.object(),
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(_) => Err(self.error("unexpected character")),
        }
    }
    fn number(&mut self) -> Result<Value, ParseError> {
        let start = self.at;
        if self.bytes.get(self.at) == Some(&b'-') { self.at += 1 }
        match self.bytes.get(self.at) {
            Some(b'0') => self.at += 1,
            Some(b'1'..=b'9') => while matches!(self.bytes.get(self.at), Some(b'0'..=b'9')) { self.at += 1 },
            _ => return Err(self.error("a digit is expected")),
        }
        if self.bytes.get(self.at) == Some(&b'.') {
            self.at += 1;
            if !matches!(self.bytes.get(self.at), Some(b'0'..=b'9')) { return Err(self.error("a digit is expected after the point")) }
            while matches!(self.bytes.get(self.at), Some(b'0'..=b'9')) { self.at += 1 }
        }
        if matches!(self.bytes.get(self.at), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.bytes.get(self.at), Some(b'+' | b'-')) { self.at += 1 }
            if !matches!(self.bytes.get(self.at), Some(b'0'..=b'9')) { return Err(self.error("a digit is expected in the exponent")) }
            while matches!(self.bytes.get(self.at), Some(b'0'..=b'9')) { self.at += 1 }
        }
        let text = std::str::from_utf8(&self.bytes[start..self.at]).map_err(|_| self.error("not a number"))?;
        text.parse::<f64>().map(Value::Number).map_err(|_| self.error("not a number"))
    }
    fn hex4(&mut self) -> Result<u16, ParseError> {
        let digits = self.bytes.get(self.at..self.at + 4).ok_or_else(|| self.error("four hex digits are expected"))?;
        let text = std::str::from_utf8(digits).map_err(|_| self.error("four hex digits are expected"))?;
        if !text.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err(self.error("four hex digits are expected")) }
        self.at += 4;
        Ok(u16::from_str_radix(text, 16).expect("checked above"))
    }
    fn string(&mut self) -> Result<JsString, ParseError> {
        self.at += 1; // the opening quote
        let mut units: Vec<u16> = Vec::new();
        loop {
            let start = self.at;
            // A run of ordinary characters is taken whole: the input is valid UTF-8, so it is cut only at ASCII.
            while let Some(&byte) = self.bytes.get(self.at) {
                if byte == b'"' || byte == b'\\' || byte < 0x20 { break }
                self.at += 1;
            }
            if self.at > start {
                let run = std::str::from_utf8(&self.bytes[start..self.at]).map_err(|_| self.error("not UTF-8"))?;
                units.extend(run.encode_utf16());
            }
            match self.bytes.get(self.at) {
                None => return Err(self.error("the string is not closed")),
                Some(b'"') => { self.at += 1; return Ok(JsString(units)) }
                Some(b'\\') => {
                    self.at += 1;
                    let unit = match self.bytes.get(self.at) {
                        Some(b'"') => 0x22, Some(b'\\') => 0x5c, Some(b'/') => 0x2f,
                        Some(b'b') => 0x08, Some(b'f') => 0x0c, Some(b'n') => 0x0a, Some(b'r') => 0x0d, Some(b't') => 0x09,
                        Some(b'u') => { self.at += 1; units.push(self.hex4()?); continue }
                        _ => return Err(self.error("unknown escape")),
                    };
                    self.at += 1;
                    units.push(unit);
                }
                Some(_) => return Err(self.error("a control character inside a string")),
            }
        }
    }
    fn array(&mut self) -> Result<Value, ParseError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH { return Err(self.error("nested too deep")) }
        self.at += 1;
        let mut items = Vec::new();
        self.space();
        if self.bytes.get(self.at) == Some(&b']') { self.at += 1; self.depth -= 1; return Ok(Value::Array(items)) }
        loop {
            self.space();
            items.push(self.value()?);
            self.space();
            match self.bytes.get(self.at) {
                Some(b',') => self.at += 1,
                Some(b']') => { self.at += 1; self.depth -= 1; return Ok(Value::Array(items)) }
                _ => return Err(self.error("a comma or the end of the array is expected")),
            }
        }
    }
    fn object(&mut self) -> Result<Value, ParseError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH { return Err(self.error("nested too deep")) }
        self.at += 1;
        let mut entries: Vec<(JsString, Value)> = Vec::new();
        self.space();
        if self.bytes.get(self.at) == Some(&b'}') { self.at += 1; self.depth -= 1; return Ok(Value::Object(entries)) }
        loop {
            self.space();
            if self.bytes.get(self.at) != Some(&b'"') { return Err(self.error("a key is expected")) }
            let key = self.string()?;
            self.space();
            if self.bytes.get(self.at) != Some(&b':') { return Err(self.error("a colon is expected")) }
            self.at += 1;
            self.space();
            let value = self.value()?;
            // A repeated key keeps its first place and takes the last value.
            match entries.iter_mut().find(|(name, _)| *name == key) {
                Some(entry) => entry.1 = value,
                None => entries.push((key, value)),
            }
            self.space();
            match self.bytes.get(self.at) {
                Some(b',') => self.at += 1,
                Some(b'}') => { self.at += 1; self.depth -= 1; return Ok(Value::Object(order_keys(entries))) }
                _ => return Err(self.error("a comma or the end of the object is expected")),
            }
        }
    }
}

/// The key as an array index (`"0"`, `"17"`, up to 2^32 − 2, no leading zeros), if it is one.
fn array_index(key: &JsString) -> Option<u32> {
    let units = &key.0;
    if units.is_empty() || units.len() > 10 { return None }
    if units.len() > 1 && units[0] == b'0' as u16 { return None }
    let mut value: u64 = 0;
    for &unit in units {
        if !(b'0' as u16..=b'9' as u16).contains(&unit) { return None }
        value = value * 10 + (unit - b'0' as u16) as u64;
    }
    if value <= 4_294_967_294 { Some(value as u32) } else { None }
}

/// JavaScript's enumeration order: array-index keys ascending, then the rest as they were added.
fn order_keys(entries: Vec<(JsString, Value)>) -> Vec<(JsString, Value)> {
    if !entries.iter().any(|(key, _)| array_index(key).is_some()) { return entries }
    let (mut indexed, named): (Vec<_>, Vec<_>) = entries.into_iter().partition(|(key, _)| array_index(key).is_some());
    indexed.sort_by_key(|(key, _)| array_index(key).expect("partitioned by this"));
    indexed.extend(named);
    indexed
}

/// Builds an object from entries in the order given, applying JavaScript's key order.
pub fn object(entries: Vec<(&str, Value)>) -> Value {
    let mut out: Vec<(JsString, Value)> = Vec::new();
    for (key, value) in entries {
        let key = JsString::from_str(key);
        match out.iter_mut().find(|(name, _)| *name == key) {
            Some(entry) => entry.1 = value,
            None => out.push((key, value)),
        }
    }
    Value::Object(order_keys(out))
}

/// Writes the value the way `JSON.stringify(value)` does (no indentation).
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_value(value, &mut out);
    out
}

fn write_value(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => out.push_str(&number_text(*number)),
        Value::String(text) => write_string(text, out),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 { out.push(',') }
                write_value(item, out);
            }
            out.push(']');
        }
        Value::Object(entries) => {
            out.push('{');
            for (index, (key, item)) in entries.iter().enumerate() {
                if index > 0 { out.push(',') }
                write_string(key, out);
                out.push(':');
                write_value(item, out);
            }
            out.push('}');
        }
    }
}

fn write_string(text: &JsString, out: &mut String) {
    out.push('"');
    let units = &text.0;
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        index += 1;
        match unit {
            0x22 => out.push_str("\\\""),
            0x5c => out.push_str("\\\\"),
            0x08 => out.push_str("\\b"),
            0x0c => out.push_str("\\f"),
            0x0a => out.push_str("\\n"),
            0x0d => out.push_str("\\r"),
            0x09 => out.push_str("\\t"),
            0x00..=0x1f => { let _ = write!(out, "\\u{unit:04x}"); }
            0xd800..=0xdbff => {
                // A high surrogate followed by a low one is a character; alone it is written as an escape.
                match units.get(index) {
                    Some(&low @ 0xdc00..=0xdfff) => {
                        index += 1;
                        let code = 0x10000 + (((unit as u32) - 0xd800) << 10) + ((low as u32) - 0xdc00);
                        out.push(char::from_u32(code).expect("a valid pair"));
                    }
                    _ => { let _ = write!(out, "\\u{unit:04x}"); }
                }
            }
            0xdc00..=0xdfff => { let _ = write!(out, "\\u{unit:04x}"); }
            _ => out.push(char::from_u32(unit as u32).expect("not a surrogate")),
        }
    }
    out.push('"');
}

/// `Number.prototype.toString` (and `JSON.stringify` for numbers: not finite is `null`).
pub fn number_text(number: f64) -> String {
    if !number.is_finite() { return "null".to_string() }
    if number == 0.0 { return "0".to_string() }
    // The shortest digits that read back as the same double, with their decimal exponent.
    let scientific = format!("{:e}", number.abs());
    let (mantissa, exponent) = scientific.split_once('e').expect("{:e} always has an exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let exponent: i32 = exponent.parse().expect("an integer exponent");
    let k = digits.len() as i32; // how many digits
    let n = exponent + 1; // where the decimal point stands, counted from the first digit
    let mut out = String::new();
    if number < 0.0 { out.push('-') }
    if k <= n && n <= 21 {
        out.push_str(&digits);
        for _ in 0..(n - k) { out.push('0') }
    } else if 0 < n && n <= 21 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        for _ in 0..(-n) { out.push('0') }
        out.push_str(&digits);
    } else {
        out.push_str(&digits[..1]);
        if k > 1 { out.push('.'); out.push_str(&digits[1..]) }
        out.push('e');
        out.push(if n - 1 < 0 { '-' } else { '+' });
        out.push_str(&(n - 1).abs().to_string());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_what_json_parse_refuses() {
        for bad in ["", "{", "[1,]", "{\"a\":1,}", "01", "1.", "+1", "'a'", "\"a\nb\"", "nul", "[1] 2", "{a:1}", "\"\\x\"", "\"\\u12\""] {
            assert!(parse(bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn builds_objects_in_javascript_key_order() {
        let made = object(vec![("b", Value::Number(1.0)), ("2", Value::Null), ("a", Value::Bool(true)), ("1", Value::str("x")), ("b", Value::Number(2.0))]);
        assert_eq!(stringify(&made), r#"{"1":"x","2":null,"b":2,"a":true}"#);
    }
}
