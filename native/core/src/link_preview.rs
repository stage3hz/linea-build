//! The card of a link in a one-to-one chat: site, title, description and a small picture.
//!
//! There is no reference for this in `mobile/src`: it is a feature of the native apps, so its rules are written
//! here once and pinned by hand-written tests (`tests/link_preview.rs`, `tests/link_preview_service.rs`).
//!
//! Privacy first. The SENDER's phone fetches the page itself, and only for a link the person typed; the server
//! never sees the link. The card then travels INSIDE the encrypted message as the top-level key `linkPreview`
//! (apps that do not know it ignore unknown top-level keys and show the plain link), and the recipient's phone
//! shows only what arrived: it never contacts the site. Everything that arrives is checked here, and a card that
//! does not fit exactly is dropped — the message itself is always shown.
//!
//! Three parts: reading a fetched page (`parse_page`), the card as it travels (`wire`, `valid_wire`), and which
//! link of a text gets the card and whether it may be fetched at all (`candidate`, `fetchable`, `private_address`).

use crate::format::{native_text, LINK, SPOILER};
use crate::json::{self, JsString, Value};
use crate::photo::preview::{create_link_image, valid_link_image};

/// How much of a page is read: its head is in the first kilobytes.
pub const MAX_HTML_BYTES: usize = 256 * 1024;
/// The largest picture a phone downloads to make the card's small one.
pub const MAX_IMAGE_DOWNLOAD_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_URL: usize = 2048;
pub const MAX_SITE: usize = 80;
pub const MAX_TITLE: usize = 200;
pub const MAX_DESCRIPTION: usize = 500;
/// How many redirects a fetch follows, each to an address `fetchable` lets through.
pub const MAX_REDIRECTS: usize = 3;
pub const FETCH_TIMEOUT_MS: f64 = 6000.0;
/// The encrypted body of one device's envelope holds 64 KiB; a card must leave room for the Signal framing.
pub const MAX_PAYLOAD_BYTES: usize = 60_000;

// ── Plain text ───────────────────────────────────────────────────────────────────────────────────────────────

/// Characters that are never shown and can only mislead: controls, bidirectional overrides and marks, invisible
/// fillers, tag characters, noncharacters. (The joiners U+200C/U+200D stay: emoji and some scripts need them.)
fn dropped(c: char) -> bool {
    (c.is_control() && !c.is_whitespace())
        || matches!(c, '\u{ad}' | '\u{61c}' | '\u{180e}' | '\u{200b}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2069}' | '\u{feff}' | '\u{fff9}'..='\u{fffb}' | '\u{fffe}' | '\u{ffff}' | '\u{e0000}'..='\u{e007f}')
}

/// One line of plain text: the characters above removed, every run of white space one space, no space at the
/// ends, at most `max` characters (code points).
pub fn plain_text(text: &str, max: usize) -> String {
    let mut out = String::new();
    let (mut count, mut space) = (0, false);
    for c in text.chars() {
        if c.is_whitespace() { space = true; continue }
        if dropped(c) { continue }
        if space && count > 0 {
            if count + 1 >= max { break }
            out.push(' ');
            count += 1;
        }
        space = false;
        if count >= max { break }
        out.push(c);
        count += 1;
    }
    out
}

// ── Addresses ────────────────────────────────────────────────────────────────────────────────────────────────

fn parsed(url: &str) -> Option<url::Url> {
    if url.is_empty() || url.chars().count() > MAX_URL || url.chars().any(|c| c.is_whitespace() || c.is_control()) { return None }
    url::Url::parse(url).ok()
}

/// Names that never leave a home or office network.
const LOCAL_ZONES: [&str; 13] = ["local", "localhost", "localdomain", "internal", "intranet", "lan", "home", "corp", "private", "test", "invalid", "arpa", "onion"];

/// Whether a phone may fetch this address for a card: `https`, the default port, no name or password in it, and
/// a public host name — not an IP address in any spelling, not a name of a local network.
pub fn fetchable(url: &str) -> bool {
    let Some(address) = parsed(url) else { return false };
    if address.scheme() != "https" || !address.username().is_empty() || address.password().is_some() || address.port().is_some() { return false }
    let Some(url::Host::Domain(host)) = address.host() else { return false };
    let host = host.strip_suffix('.').unwrap_or(host).to_ascii_lowercase();
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 || labels.iter().any(|label| label.is_empty()) { return false }
    let zone = labels[labels.len() - 1];
    // A zone is letters (or a punycode name); a host that ends in a number is an address in disguise.
    zone.bytes().any(|byte| byte.is_ascii_alphabetic()) && !LOCAL_ZONES.contains(&zone)
}

fn private_v4(ip: std::net::Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_broadcast() || ip.is_multicast() || ip.is_documentation()
        || a == 0 || a >= 240 || (a == 100 && (64..128).contains(&b)) || (a == 192 && b == 0 && c == 0) || (a == 198 && (b == 18 || b == 19))
}

/// Whether an address a host name resolved to must NOT be contacted: loopback, private, link-local, shared,
/// multicast, reserved — or not an address at all. A phone checks every address of the name before it connects.
pub fn private_address(ip: &str) -> bool {
    let text = ip.trim().trim_start_matches('[').trim_end_matches(']');
    // A scope (`fe80::1%en0`) belongs to link-local addresses only.
    if text.contains('%') { return true }
    match text.parse::<std::net::IpAddr>() {
        Err(_) => true,
        Ok(std::net::IpAddr::V4(ip)) => private_v4(ip),
        Ok(std::net::IpAddr::V6(ip)) => {
            let parts = ip.segments();
            let embedded = std::net::Ipv4Addr::new((parts[6] >> 8) as u8, parts[6] as u8, (parts[7] >> 8) as u8, parts[7] as u8);
            // IPv4 inside IPv6: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d) and the NAT64 prefix a phone on an
            // IPv6-only network gets for every IPv4 site (64:ff9b::/96) are judged by the IPv4 address.
            if parts[..5] == [0, 0, 0, 0, 0] && (parts[5] == 0xffff || parts[5] == 0) { return private_v4(embedded) }
            if parts[..6] == [0x64, 0xff9b, 0, 0, 0, 0] { return private_v4(embedded) }
            ip.is_loopback() || ip.is_unspecified() || ip.is_multicast()
                || parts[0] & 0xfe00 == 0xfc00 || parts[0] & 0xffc0 == 0xfe80 || parts[0] & 0xffc0 == 0xfec0
                || (parts[0] == 0x2001 && parts[1] == 0xdb8) || (parts[0] == 0x64 && parts[1] == 0xff9b)
        }
    }
}

/// The `https` links of a text as the message list finds them (`format::native_text`), in order, those hidden
/// under a spoiler left out: a card must not show what the text hides.
pub fn links(text: &JsString, entities: Option<&Value>) -> Vec<String> {
    let shown = native_text(text, entities);
    let (Some(Value::Array(fmt)), Some(Value::Array(urls))) = (shown.get("fmt"), shown.get("urls")) else { return Vec::new() };
    let mut addresses = urls.iter();
    let mut out = Vec::new();
    for run in fmt.chunks(3) {
        let Some(Value::Number(flags)) = run.first() else { continue };
        let flags = *flags as u32;
        if flags & LINK == 0 { continue }
        let Some(Value::String(address)) = addresses.next() else { break };
        let Some(address) = address.to_str() else { continue };
        if flags & SPOILER != 0 { continue }
        if address.get(..8).is_some_and(|scheme| scheme.eq_ignore_ascii_case("https://")) { out.push(address) }
    }
    out
}

/// The link of a text that gets the card: its first `https` link, when a phone may fetch it.
pub fn candidate(text: &JsString, entities: Option<&Value>) -> Option<String> {
    links(text, entities).into_iter().next().filter(|address| fetchable(address))
}

// ── The card as it travels ───────────────────────────────────────────────────────────────────────────────────

/// The site's name when the page gives none: its host without `www.`.
pub fn site_of(url: &str) -> String {
    let host = parsed(url).and_then(|address| address.host_str().map(str::to_string)).unwrap_or_default();
    plain_text(host.strip_prefix("www.").unwrap_or(&host), MAX_SITE)
}

/// The card for `encrypt`, from what a phone read off a page: the texts made plain and cut to their limits, the
/// picture (JPEG bytes, already scaled down by the phone) cleaned of everything but the picture. A picture that
/// is not acceptable is left out; `None` when there is nothing to show or the address may not carry a card.
pub fn wire(url: &str, site: &str, title: &str, description: &str, jpeg: Option<&[u8]>) -> Option<Value> {
    if !fetchable(url) { return None }
    let (mut site, title, description) = (plain_text(site, MAX_SITE), plain_text(title, MAX_TITLE), plain_text(description, MAX_DESCRIPTION));
    if site.is_empty() { site = site_of(url) }
    let image = jpeg.and_then(|bytes| create_link_image(bytes).ok()).map(|made| json::object(vec![("mimeType", Value::str("image/jpeg")), ("base64", Value::str(&made.base64)), ("width", Value::Number(f64::from(made.width))), ("height", Value::Number(f64::from(made.height)))])).filter(valid_link_image);
    if site.is_empty() || (title.is_empty() && description.is_empty() && image.is_none()) { return None }
    let mut card = vec![("url", Value::str(url)), ("site", Value::str(&site)), ("title", Value::str(&title)), ("description", Value::str(&description))];
    if let Some(image) = image { card.push(("image", image)) }
    Some(json::object(card))
}

fn words(value: &Value, key: &str) -> Option<String> { match value.get(key) { Some(Value::String(text)) => text.to_str(), _ => None } }

/// Whether a card is exactly one this app would have made for a message with this text: only the known keys,
/// texts already plain and within their limits, an `https` address that is one of the links of the text, and a
/// picture that is a bounded, cleaned JPEG with its true size.
pub fn valid_wire(card: &Value, text: &JsString, entities: Option<&Value>) -> bool {
    let Value::Object(entries) = card else { return false };
    let known = |name: &JsString| ["url", "site", "title", "description", "image"].iter().any(|key| name.0.iter().copied().eq(key.encode_utf16()));
    if !entries.iter().all(|(name, _)| known(name)) || entries.iter().enumerate().any(|(at, (name, _))| entries[..at].iter().any(|(earlier, _)| earlier == name)) { return false }
    let (Some(url), Some(site), Some(title), Some(description)) = (words(card, "url"), words(card, "site"), words(card, "title"), words(card, "description")) else { return false };
    if !fetchable(&url) || !links(text, entities).contains(&url) { return false }
    if site.is_empty() || site != plain_text(&site, MAX_SITE) || title != plain_text(&title, MAX_TITLE) || description != plain_text(&description, MAX_DESCRIPTION) { return false }
    let image = card.get("image");
    if image.is_some_and(|image| !valid_link_image(image)) { return false }
    !(title.is_empty() && description.is_empty() && image.is_none())
}

/// The card a message may carry, or none: a message with a file, a poll or an action never has one.
pub fn for_message<'a>(card: Option<&'a Value>, text: &JsString, attachment: &Value, meta: Option<&Value>) -> Option<&'a Value> {
    let card = card.filter(|card| !matches!(card, Value::Null))?;
    if !matches!(attachment, Value::Null) { return None }
    let has = |key: &str| meta.and_then(|meta| meta.get(key)).is_some_and(|value| !matches!(value, Value::Null));
    if has("action") || has("poll") { return None }
    valid_wire(card, text, meta.and_then(|meta| meta.get("entities"))).then_some(card)
}

/// The card without its picture: what is sent when the whole body would not fit one envelope.
pub fn without_image(card: &Value) -> Value {
    let Value::Object(entries) = card else { return card.clone() };
    Value::Object(entries.iter().filter(|(name, _)| !name.0.iter().copied().eq("image".encode_utf16())).cloned().collect())
}

// ── Reading a page ───────────────────────────────────────────────────────────────────────────────────────────

/// What a page says about itself. `site` is the page's own name, or the host when it gives none.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct Page { pub site: String, pub title: String, pub description: String, pub image_url: Option<String> }

#[derive(Clone, Copy, PartialEq, Debug)]
enum Charset { Utf8, Windows1251, Koi8R, Windows1252 }

fn charset_named(label: &str) -> Option<Charset> {
    match label.trim().trim_matches(|c| c == '"' || c == '\'').trim().to_ascii_lowercase().as_str() {
        "utf-8" | "utf8" | "unicode-1-1-utf-8" => Some(Charset::Utf8),
        "windows-1251" | "cp1251" | "x-cp1251" | "win-1251" | "win1251" => Some(Charset::Windows1251),
        "koi8-r" | "koi8" | "koi8_r" | "koi" | "cskoi8r" => Some(Charset::Koi8R),
        "windows-1252" | "cp1252" | "x-cp1252" | "iso-8859-1" | "iso8859-1" | "latin1" | "l1" | "us-ascii" | "ascii" => Some(Charset::Windows1252),
        _ => None,
    }
}

/// `charset=…` inside a `Content-Type` value.
fn charset_in(content_type: &str) -> Option<Charset> {
    let lower = content_type.to_ascii_lowercase();
    let at = lower.find("charset")?;
    let rest = lower[at + 7..].trim_start().strip_prefix('=')?;
    charset_named(rest.split(|c: char| c == ';' || c == ',').next().unwrap_or(""))
}

// The upper halves of the one-byte charsets, as the WHATWG decoders give them (`tests/link_preview.rs` checks
// every byte against Node's `TextDecoder`, recorded in `tests/vectors/link-charsets.json`).
const WINDOWS_1251: [u16; 128] = [
    0x402, 0x403, 0x201a, 0x453, 0x201e, 0x2026, 0x2020, 0x2021, 0x20ac, 0x2030, 0x409, 0x2039, 0x40a, 0x40c, 0x40b, 0x40f, 0x452, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x98, 0x2122, 0x459, 0x203a, 0x45a, 0x45c, 0x45b, 0x45f,
    0xa0, 0x40e, 0x45e, 0x408, 0xa4, 0x490, 0xa6, 0xa7, 0x401, 0xa9, 0x404, 0xab, 0xac, 0xad, 0xae, 0x407, 0xb0, 0xb1, 0x406, 0x456, 0x491, 0xb5, 0xb6, 0xb7, 0x451, 0x2116, 0x454, 0xbb, 0x458, 0x405, 0x455, 0x457,
    0x410, 0x411, 0x412, 0x413, 0x414, 0x415, 0x416, 0x417, 0x418, 0x419, 0x41a, 0x41b, 0x41c, 0x41d, 0x41e, 0x41f, 0x420, 0x421, 0x422, 0x423, 0x424, 0x425, 0x426, 0x427, 0x428, 0x429, 0x42a, 0x42b, 0x42c, 0x42d, 0x42e, 0x42f,
    0x430, 0x431, 0x432, 0x433, 0x434, 0x435, 0x436, 0x437, 0x438, 0x439, 0x43a, 0x43b, 0x43c, 0x43d, 0x43e, 0x43f, 0x440, 0x441, 0x442, 0x443, 0x444, 0x445, 0x446, 0x447, 0x448, 0x449, 0x44a, 0x44b, 0x44c, 0x44d, 0x44e, 0x44f,
];
const KOI8_R: [u16; 128] = [
    0x2500, 0x2502, 0x250c, 0x2510, 0x2514, 0x2518, 0x251c, 0x2524, 0x252c, 0x2534, 0x253c, 0x2580, 0x2584, 0x2588, 0x258c, 0x2590, 0x2591, 0x2592, 0x2593, 0x2320, 0x25a0, 0x2219, 0x221a, 0x2248, 0x2264, 0x2265, 0xa0, 0x2321, 0xb0, 0xb2, 0xb7, 0xf7,
    0x2550, 0x2551, 0x2552, 0x451, 0x2553, 0x2554, 0x2555, 0x2556, 0x2557, 0x2558, 0x2559, 0x255a, 0x255b, 0x255c, 0x255d, 0x255e, 0x255f, 0x2560, 0x2561, 0x401, 0x2562, 0x2563, 0x2564, 0x2565, 0x2566, 0x2567, 0x2568, 0x2569, 0x256a, 0x256b, 0x256c, 0xa9,
    0x44e, 0x430, 0x431, 0x446, 0x434, 0x435, 0x444, 0x433, 0x445, 0x438, 0x439, 0x43a, 0x43b, 0x43c, 0x43d, 0x43e, 0x43f, 0x44f, 0x440, 0x441, 0x442, 0x443, 0x436, 0x432, 0x44c, 0x44b, 0x437, 0x448, 0x44d, 0x449, 0x447, 0x44a,
    0x42e, 0x410, 0x411, 0x426, 0x414, 0x415, 0x424, 0x413, 0x425, 0x418, 0x419, 0x41a, 0x41b, 0x41c, 0x41d, 0x41e, 0x41f, 0x42f, 0x420, 0x421, 0x422, 0x423, 0x416, 0x412, 0x42c, 0x42b, 0x417, 0x428, 0x42d, 0x429, 0x427, 0x42a,
];
/// 0x80–0x9F only: from 0xA0 on, windows-1252 is the byte itself.
const WINDOWS_1252: [u16; 32] = [
    0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

fn one_byte(bytes: &[u8], upper: impl Fn(u8) -> u16) -> String {
    bytes.iter().map(|byte| if byte.is_ascii() { char::from(*byte) } else { char::from_u32(u32::from(upper(*byte))).unwrap_or('\u{fffd}') }).collect()
}

/// The text of `bytes` in a charset by its name (`utf-8`, `windows-1251`, `koi8-r`, `windows-1252` and their
/// usual other names); `None` for a name this does not know.
pub fn decode(bytes: &[u8], label: &str) -> Option<String> { charset_named(label).map(|charset| decoded(bytes, charset)) }

fn decoded(bytes: &[u8], charset: Charset) -> String {
    match charset {
        Charset::Utf8 => String::from_utf8_lossy(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes)).into_owned(),
        Charset::Windows1251 => one_byte(bytes, |byte| WINDOWS_1251[usize::from(byte) - 128]),
        Charset::Koi8R => one_byte(bytes, |byte| KOI8_R[usize::from(byte) - 128]),
        Charset::Windows1252 => one_byte(bytes, |byte| if byte < 0xa0 { WINDOWS_1252[usize::from(byte) - 128] } else { u16::from(byte) }),
    }
}

/// The page's text: a byte-order mark decides, then the server's `Content-Type`, then the page's own `<meta>`,
/// then the bytes themselves — UTF-8 when they are UTF-8, otherwise windows-1251.
fn page_text(bytes: &[u8], content_type: Option<&str>) -> String {
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) { return decoded(bytes, Charset::Utf8) }
    let declared = content_type.and_then(charset_in).or_else(|| {
        // The declaration is ASCII in every charset read here, so the start of the page is looked through as is.
        let start = decoded(&bytes[..bytes.len().min(8192)], Charset::Windows1252);
        read_head(&start).charset
    });
    let charset = declared.unwrap_or_else(|| match std::str::from_utf8(bytes) {
        Ok(_) => Charset::Utf8,
        // Only the cut at the size limit may split a character.
        Err(error) if error.error_len().is_none() => Charset::Utf8,
        Err(_) => Charset::Windows1251,
    });
    decoded(bytes, charset)
}

const ENTITIES: [(&str, char); 44] = [
    ("amp", '&'), ("lt", '<'), ("gt", '>'), ("quot", '"'), ("apos", '\''), ("nbsp", '\u{a0}'), ("laquo", '«'), ("raquo", '»'), ("mdash", '—'), ("ndash", '–'),
    ("hellip", '…'), ("copy", '©'), ("reg", '®'), ("trade", '™'), ("bdquo", '„'), ("ldquo", '“'), ("rdquo", '”'), ("lsquo", '‘'), ("rsquo", '’'), ("sbquo", '‚'),
    ("middot", '·'), ("bull", '•'), ("deg", '°'), ("euro", '€'), ("shy", '\u{ad}'), ("thinsp", '\u{2009}'), ("ensp", '\u{2002}'), ("emsp", '\u{2003}'), ("times", '×'), ("minus", '−'),
    ("plusmn", '±'), ("sect", '§'), ("para", '¶'), ("pound", '£'), ("yen", '¥'), ("cent", '¢'), ("frac12", '½'), ("rarr", '→'), ("larr", '←'), ("prime", '′'),
    ("lsaquo", '‹'), ("rsaquo", '›'), ("numero", '№'), ("iexcl", '¡'),
];

/// `&amp;`, `&#8212;`, `&#x2014;` and the like as their characters; anything else stays as written.
pub fn decode_entities(text: &str) -> String {
    if !text.contains('&') { return text.to_string() }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        // The longest name is short: only the next few bytes are looked at.
        let end = rest.bytes().take(12).position(|byte| byte == b';');
        let known = end.and_then(|end| {
            let name = &rest[1..end];
            if let Some(number) = name.strip_prefix('#') {
                let code = match number.strip_prefix(['x', 'X']) {
                    Some(hex) if !hex.is_empty() && hex.bytes().all(|byte| byte.is_ascii_hexdigit()) => u32::from_str_radix(hex, 16).ok(),
                    None if !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit()) => number.parse::<u32>().ok(),
                    _ => None,
                }?;
                // As browsers do: 0x80–0x9F are read as windows-1252, what is not a character becomes U+FFFD.
                let code = if (0x80..0xa0).contains(&code) { u32::from(WINDOWS_1252[code as usize - 0x80]) } else { code };
                return Some((char::from_u32(code).filter(|c| *c != '\0').unwrap_or('\u{fffd}'), end));
            }
            ENTITIES.iter().find(|(known, _)| *known == name).map(|(_, c)| (*c, end))
        });
        match known {
            Some((c, end)) => { out.push(c); rest = &rest[end + 1..] }
            None => { out.push('&'); rest = &rest[1..] }
        }
    }
    out.push_str(rest);
    out
}

/// What the head of a page holds, as written (entities decoded, not yet made plain).
#[derive(Default)]
struct Head { charset: Option<Charset>, title: Option<String>, metas: Vec<(String, String)> }

/// Where `word` starts at or after `from`, letters in either case.
fn find_word(html: &str, from: usize, word: &str) -> Option<usize> {
    let (bytes, word) = (html.as_bytes(), word.as_bytes());
    if bytes.len() < word.len() { return None }
    (from..=bytes.len() - word.len()).find(|at| bytes[*at..*at + word.len()].eq_ignore_ascii_case(word))
}

/// One tag's attributes, from just after its name: `(name in small letters, value)` pairs and where the tag ends.
fn attributes(html: &str, mut at: usize) -> (Vec<(String, String)>, usize) {
    let bytes = html.as_bytes();
    let mut out = Vec::new();
    loop {
        while at < bytes.len() && (bytes[at].is_ascii_whitespace() || bytes[at] == b'/') { at += 1 }
        if at >= bytes.len() { return (out, at) }
        if bytes[at] == b'>' { return (out, at + 1) }
        let start = at;
        // A name may not begin with `=` in good HTML; taking it as part of the name keeps the scan moving.
        at += 1;
        while at < bytes.len() && !bytes[at].is_ascii_whitespace() && !matches!(bytes[at], b'=' | b'>' | b'/') { at += 1 }
        let name = html.get(start..at).unwrap_or("").to_ascii_lowercase();
        while at < bytes.len() && bytes[at].is_ascii_whitespace() { at += 1 }
        let mut value = "";
        if at < bytes.len() && bytes[at] == b'=' {
            at += 1;
            while at < bytes.len() && bytes[at].is_ascii_whitespace() { at += 1 }
            if at < bytes.len() && (bytes[at] == b'"' || bytes[at] == b'\'') {
                let quote = bytes[at];
                let from = at + 1;
                let end = bytes[from..].iter().position(|byte| *byte == quote).map_or(bytes.len(), |found| from + found);
                value = html.get(from..end).unwrap_or("");
                at = (end + 1).min(bytes.len());
            } else {
                let from = at;
                while at < bytes.len() && !bytes[at].is_ascii_whitespace() && bytes[at] != b'>' { at += 1 }
                value = html.get(from..at).unwrap_or("");
            }
        }
        if out.len() < 32 { out.push((name, decode_entities(value))) }
    }
}

/// Walks the tags of a page up to the end of its head. Nothing is run and nothing is followed: scripts and styles
/// are stepped over, and only `<title>` and `<meta>` are read.
fn read_head(html: &str) -> Head {
    let bytes = html.as_bytes();
    let mut head = Head::default();
    let mut at = 0;
    while let Some(open) = bytes[at.min(bytes.len())..].iter().position(|byte| *byte == b'<').map(|found| at + found) {
        at = open + 1;
        if html[at..].starts_with("!--") {
            match html[at + 3..].find("-->") { Some(end) => { at += 3 + end + 3; continue } None => break }
        }
        if matches!(bytes.get(at), Some(b'!' | b'?')) {
            match bytes[at..].iter().position(|byte| *byte == b'>') { Some(end) => { at += end + 1; continue } None => break }
        }
        let closing = bytes.get(at) == Some(&b'/');
        let start = if closing { at + 1 } else { at };
        // A `<` that opens nothing is text.
        if !bytes.get(start).is_some_and(u8::is_ascii_alphabetic) { continue }
        let mut end = start;
        while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || matches!(bytes[end], b'-' | b':' | b'_')) { end += 1 }
        let name = html[start..end].to_ascii_lowercase();
        let (attrs, after) = attributes(html, end);
        at = after;
        if closing { if name == "head" { break } else { continue } }
        match name.as_str() {
            "body" => break,
            // Their content is not markup: it ends only at their own closing tag.
            "script" | "style" | "template" | "textarea" | "xmp" | "iframe" | "noembed" | "noframes" => match find_word(html, at, &format!("</{name}")) { Some(end) => at = end, None => break },
            "title" => {
                let end = find_word(html, at, "</title").unwrap_or(bytes.len());
                if head.title.is_none() { head.title = Some(decode_entities(&html[at..end])) }
                at = end;
            }
            "meta" => {
                let attr = |wanted: &str| attrs.iter().find(|(name, _)| name == wanted).map(|(_, value)| value.as_str());
                if head.charset.is_none() {
                    head.charset = attr("charset").and_then(charset_named).or_else(|| {
                        if attr("http-equiv").is_some_and(|kind| kind.trim().eq_ignore_ascii_case("content-type")) { attr("content").and_then(charset_in) } else { None }
                    });
                }
                if let Some(content) = attr("content") {
                    for key in ["property", "name"] {
                        if let Some(key) = attr(key) { if head.metas.len() < 400 { head.metas.push((key.trim().to_ascii_lowercase(), content.to_string())) } }
                    }
                }
            }
            _ => {}
        }
    }
    head
}

/// Reads the head of a fetched page: Open Graph first, the Twitter card names next, then `<title>` and
/// `<meta name="description">`. `bytes` is the start of the answer (only the first 256 KiB are looked at),
/// `content_type` the server's header when there is one, `page_url` the address the page finally came from
/// (after redirects): the picture's address is resolved against it and kept only when a phone may fetch it.
/// `None` when `page_url` itself is not an address a card may come from.
pub fn parse_page(bytes: &[u8], content_type: Option<&str>, page_url: &str) -> Option<Page> {
    if !fetchable(page_url) { return None }
    let base = parsed(page_url)?;
    let html = page_text(&bytes[..bytes.len().min(MAX_HTML_BYTES)], content_type);
    let head = read_head(&html);
    let first = |keys: &[&str], max: usize| -> String {
        keys.iter().find_map(|key| head.metas.iter().filter(|(name, _)| name == key).map(|(_, content)| plain_text(content, max)).find(|text| !text.is_empty())).unwrap_or_default()
    };
    let mut site = first(&["og:site_name", "application-name"], MAX_SITE);
    if site.is_empty() { site = site_of(page_url) }
    let mut title = first(&["og:title", "twitter:title"], MAX_TITLE);
    if title.is_empty() { title = plain_text(head.title.as_deref().unwrap_or(""), MAX_TITLE) }
    let description = first(&["og:description", "twitter:description", "description"], MAX_DESCRIPTION);
    let image_url = ["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"].iter().find_map(|key| {
        head.metas.iter().filter(|(name, _)| name == key).find_map(|(_, content)| {
            if content.trim().is_empty() { return None }
            let address = base.join(content.trim()).ok()?.to_string();
            fetchable(&address).then_some(address)
        })
    });
    Some(Page { site, title, description, image_url })
}
