//! The card of a link (`link_preview`): reading a page, the card as it travels, which link gets it.
//! There is no reference implementation, so every rule is written out here by hand. The charset tables alone are
//! checked against a reference: Node's `TextDecoder` (`tests/generate-link-vectors.mjs`).
use base64::Engine as _;
use invizent_core::json::{self, JsString, Value};
use invizent_core::link_preview::*;
use invizent_core::photo::preview::{create_link_image, create_preview, valid_link_image, MAX_LINK_IMAGE_BYTES};
use invizent_core::photo::valid_preview;
use serde::Deserialize;

const PAGE: &str = "https://news.example.ru/story/42?ref=a";

fn page(html: &str) -> Page { parse_page(html.as_bytes(), Some("text/html; charset=utf-8"), PAGE).expect("a page") }
fn units(text: &str) -> JsString { JsString::from_str(text) }
/// A well-formed JPEG as the cleaner leaves it: one grey component, `fill` bytes of picture data.
fn jpeg(width: u16, height: u16, fill: usize) -> Vec<u8> {
    let mut out = vec![0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08];
    out.extend_from_slice(&height.to_be_bytes());
    out.extend_from_slice(&width.to_be_bytes());
    out.extend_from_slice(&[0x01, 0x01, 0x11, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
    out.extend((0..fill.max(1)).map(|index| (index % 251) as u8));
    out.extend_from_slice(&[0xff, 0xd9]);
    out
}
fn b64(bytes: &[u8]) -> String { base64::engine::general_purpose::STANDARD.encode(bytes) }
fn image_value(bytes: &[u8], width: u16, height: u16) -> Value {
    json::object(vec![("mimeType", Value::str("image/jpeg")), ("base64", Value::str(&b64(bytes))), ("width", Value::Number(f64::from(width))), ("height", Value::Number(f64::from(height)))])
}
fn card(url: &str, site: &str, title: &str, description: &str) -> Value {
    json::object(vec![("url", Value::str(url)), ("site", Value::str(site)), ("title", Value::str(title)), ("description", Value::str(description))])
}
fn with(card: &Value, key: &str, value: Value) -> Value {
    let Value::Object(mut entries) = card.clone() else { panic!("an object") };
    let name = JsString::from_str(key);
    match entries.iter_mut().find(|(held, _)| *held == name) { Some(entry) => entry.1 = value, None => entries.push((name, value)) }
    Value::Object(entries)
}
fn without(card: &Value, key: &str) -> Value {
    let Value::Object(entries) = card else { panic!("an object") };
    Value::Object(entries.iter().filter(|(name, _)| *name != JsString::from_str(key)).cloned().collect())
}

// ── Plain text ───────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn text_is_made_plain() {
    assert_eq!(plain_text("  Привет,\n\t мир \u{a0}! ", 100), "Привет, мир !");
    // Controls, bidirectional overrides and marks, invisible fillers, tag characters, noncharacters: gone.
    assert_eq!(plain_text("a\u{0}b\u{7}c\u{7f}d\u{9b}e", 100), "abcde");
    assert_eq!(plain_text("safe\u{202e}txt.exe\u{202c}", 100), "safetxt.exe");
    assert_eq!(plain_text("\u{2066}a\u{2067}b\u{2068}c\u{2069}\u{200e}\u{200f}\u{61c}d", 100), "abcd");
    assert_eq!(plain_text("z\u{200b}e\u{feff}r\u{2060}o\u{ad}\u{180e}\u{e0041}\u{e007f}\u{fffe}\u{ffff}\u{fff9}!", 100), "zero!");
    // Line and paragraph separators are white space; the joiners of emoji and scripts stay.
    assert_eq!(plain_text("one\u{2028}two\u{2029}three\u{85}four\u{3000}five", 100), "one two three four five");
    assert_eq!(plain_text("👨\u{200d}👩\u{200d}👧 می\u{200c}خواهم", 100), "👨\u{200d}👩\u{200d}👧 می\u{200c}خواهم");
    assert_eq!(plain_text("\u{1}\u{2} \n", 100), "");
    assert_eq!(plain_text("", 100), "");
}

#[test]
fn text_is_cut_by_characters_and_never_ends_in_a_space() {
    assert_eq!(plain_text("абвгд", 3), "абв");
    assert_eq!(plain_text("😀😀😀😀", 2), "😀😀");
    assert_eq!(plain_text("ab cd", 2), "ab");
    assert_eq!(plain_text("ab cd", 3), "ab");
    assert_eq!(plain_text("ab cd", 4), "ab c");
    assert_eq!(plain_text("ab   \u{202e}  cd", 5), "ab cd");
    assert_eq!(plain_text("abc", 0), "");
    // Making plain text plain again changes nothing: this is what `valid_wire` relies on.
    for sample in ["  Привет,\n\t мир \u{a0}! ", "safe\u{202e}txt.exe", "a  b   c    d", "😀 😀 😀", "x"] {
        for max in [1, 2, 3, 5, 8, 80] {
            let once = plain_text(sample, max);
            assert_eq!(plain_text(&once, max), once, "{sample:?} at {max}");
            assert!(once.chars().count() <= max && !once.starts_with(' ') && !once.ends_with(' ') && !once.contains("  "));
        }
    }
}

// ── Addresses ────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn only_public_https_addresses_may_be_fetched() {
    for good in ["https://example.com", "https://example.com/", "https://www.example.ru/a/b?c=d#e", "https://sub.domain.example.org/путь?я=1", "https://example.com:443/x", "https://xn--e1afmkfd.xn--p1ai/", "https://пример.рф/страница", "HTTPS://EXAMPLE.COM/A", "https://example.com./"] {
        assert!(fetchable(good), "{good}");
    }
    for bad in [
        "", "example.com", "http://example.com/", "ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "//example.com/x",
        // Another port, a name or a password in the address.
        "https://example.com:8443/", "https://example.com:80/", "https://user@example.com/", "https://user:pass@example.com/", "https://:pass@example.com/",
        // Addresses instead of names, in every spelling a browser would accept.
        "https://127.0.0.1/", "https://10.0.0.1/", "https://192.168.1.1/admin", "https://8.8.8.8/", "https://2130706433/", "https://0x7f.0.0.1/", "https://0177.0.0.1/", "https://127.1/",
        "https://[::1]/", "https://[fe80::1]/", "https://[2001:4860:4860::8888]/", "https://[::ffff:10.0.0.1]/",
        // Names of a local network.
        "https://localhost/", "https://localhost./", "https://router/", "https://printer.local/", "https://nas.lan/", "https://intranet.corp/", "https://service.internal/", "https://x.home/", "https://a.test/",
        "https://something.onion/", "https://1.0.0.127.in-addr.arpa/", "https://box.localdomain/",
        // White space and controls.
        "https://example.com/a b", "https://example.com/\n", "https://exa\u{0}mple.com/", " https://example.com/",
    ] {
        assert!(!fetchable(bad), "{bad:?}");
    }
    let long = format!("https://example.com/{}", "a".repeat(MAX_URL - 20));
    assert_eq!(long.chars().count(), MAX_URL);
    assert!(fetchable(&long));
    assert!(!fetchable(&format!("{long}a")));
}

#[test]
fn addresses_of_private_networks_are_never_contacted() {
    for private in [
        "127.0.0.1", "127.255.255.254", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.169.254", "0.0.0.0", "0.1.2.3", "100.64.0.1", "100.127.255.255",
        "192.0.0.1", "192.0.2.5", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
        "::", "::1", "fe80::1", "fe80::1%en0", "febf::1", "fec0::1", "fc00::1", "fd12:3456:789a::1", "ff02::1", "2001:db8::1",
        "::ffff:127.0.0.1", "::ffff:10.1.2.3", "::ffff:192.168.1.1", "::10.0.0.1", "64:ff9b::a00:1", "64:ff9b::7f00:1", "64:ff9b::c0a8:101", "64:ff9b:1::1", "[::1]",
        // Not addresses at all.
        "", "example.com", "1.2.3", "1.2.3.4.5", "256.1.1.1", "12345", "::g",
    ] {
        assert!(private_address(private), "{private:?}");
    }
    for public in ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "198.17.255.255", "198.20.0.1", "192.0.1.1", "223.255.255.255", "169.253.1.1",
        "2001:4860:4860::8888", "2a02:6b8::feed:ff", "::ffff:8.8.8.8", "64:ff9b::808:808", " 8.8.8.8 ", "[2a02:6b8::1]"] {
        assert!(!private_address(public), "{public:?}");
    }
}

#[test]
fn the_first_https_link_of_a_text_gets_the_card() {
    let pick = |text: &str| candidate(&units(text), None);
    assert_eq!(pick("смотри https://example.com/a?b=1, круто"), Some("https://example.com/a?b=1".to_string()));
    assert_eq!(pick("www.example.com и ещё https://second.example.org"), Some("https://www.example.com".to_string()));
    // A link without encryption is not fetched; the next `https` one is.
    assert_eq!(pick("http://plain.example.com потом https://safe.example.com/x."), Some("https://safe.example.com/x".to_string()));
    assert_eq!(pick("http://plain.example.com"), None);
    assert_eq!(pick("просто текст"), None);
    assert_eq!(pick(""), None);
    assert_eq!(pick("@username и почта a@example.com"), None);
    // The first `https` link decides: when it may not be fetched there is no card, the second is not tried.
    assert_eq!(pick("https://192.168.1.1/admin https://example.com"), None);
    assert_eq!(pick("https://localhost/x https://example.com"), None);
    assert_eq!(pick("https://example.com:8443/ https://example.com"), None);
    assert_eq!(links(&units("https://a.example.com http://b.example.com www.c.example.com @someone"), None), vec!["https://a.example.com", "https://www.c.example.com"]);

    // A link behind words (an entity) counts with the address it leads to.
    let text = units("смотри тут и там");
    let entities = json::parse(r#"[{"type":"text_link","offset":7,"length":3,"url":"https://example.com/hidden"}]"#).unwrap();
    assert_eq!(candidate(&text, Some(&entities)), Some("https://example.com/hidden".to_string()));
    let plain_http = json::parse(r#"[{"type":"text_link","offset":7,"length":3,"url":"http://example.com/hidden"}]"#).unwrap();
    assert_eq!(candidate(&text, Some(&plain_http)), None);
    // Code is shown as typed, and a spoiler hides its text: neither gives a card.
    let code = json::parse(r#"[{"type":"code","offset":0,"length":19}]"#).unwrap();
    assert_eq!(candidate(&units("https://example.com"), Some(&code)), None);
    let spoiler = json::parse(r#"[{"type":"spoiler","offset":0,"length":19}]"#).unwrap();
    assert_eq!(candidate(&units("https://example.com и https://open.example.org"), Some(&spoiler)), Some("https://open.example.org".to_string()));
    assert_eq!(candidate(&units("https://example.com"), Some(&spoiler)), None);
}

// ── Reading a page ───────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn open_graph_is_read_first() {
    let found = page(r#"<!DOCTYPE html><html lang="ru"><head>
        <meta charset="utf-8">
        <title>Заголовок вкладки</title>
        <meta name="description" content="Обычное описание">
        <meta name="twitter:title" content="Заголовок для карточки">
        <meta property="og:site_name" content="Новости Примера">
        <meta property="og:title" content="Главная новость дня">
        <meta property="og:description" content="Что случилось &amp; почему это важно">
        <meta property="og:image" content="/img/cover.jpg">
        </head><body><h1>Текст</h1></body></html>"#);
    assert_eq!(found, Page { site: "Новости Примера".into(), title: "Главная новость дня".into(), description: "Что случилось & почему это важно".into(), image_url: Some("https://news.example.ru/img/cover.jpg".into()) });
}

#[test]
fn twitter_names_and_plain_tags_are_the_fallbacks() {
    let twitter = page(r#"<head><title>Вкладка</title><meta name="description" content="Обычное"><meta name="twitter:title" content="Твит"><meta name="twitter:description" content="Описание твита"><meta name="twitter:image" content="https://cdn.example.com/t.png"></head>"#);
    assert_eq!(twitter, Page { site: "news.example.ru".into(), title: "Твит".into(), description: "Описание твита".into(), image_url: Some("https://cdn.example.com/t.png".into()) });
    let plain = page("<html><head><title>  Просто\n   страница </title><meta name=description content='Её описание'></head>");
    assert_eq!(plain, Page { site: "news.example.ru".into(), title: "Просто страница".into(), description: "Её описание".into(), image_url: None });
    // An empty Open Graph value does not hide the fallback.
    let empty = page(r#"<meta property="og:title" content="  "><meta property="og:description" content=""><title>Запасной</title><meta name="description" content="Запасное описание">"#);
    assert_eq!((empty.title.as_str(), empty.description.as_str()), ("Запасной", "Запасное описание"));
    // The first value of a name wins; `name` and `property` are both read, in either case.
    let twice = page(r#"<META PROPERTY="OG:TITLE" CONTENT="Первый"><meta property="og:title" content="Второй"><meta name="og:description" content="Через name"><meta property="twitter:image:src" content="https://cdn.example.com/src.jpg">"#);
    assert_eq!((twice.title.as_str(), twice.description.as_str(), twice.image_url.as_deref()), ("Первый", "Через name", Some("https://cdn.example.com/src.jpg")));
    // Nothing at all: the host stands for the site, the rest is empty.
    assert_eq!(page(""), Page { site: "news.example.ru".into(), ..Page::default() });
    assert_eq!(parse_page(b"<title>x</title>", None, "https://www.example.com/").unwrap().site, "example.com");
    assert_eq!(page(r#"<meta name="application-name" content="Приложение">"#).site, "Приложение");
}

#[test]
fn the_picture_is_resolved_and_must_be_fetchable() {
    let image = |content: &str| page(&format!(r#"<meta property="og:image" content="{content}">"#)).image_url;
    assert_eq!(image("https://cdn.example.com/a.jpg").as_deref(), Some("https://cdn.example.com/a.jpg"));
    assert_eq!(image("//cdn.example.com/a.jpg").as_deref(), Some("https://cdn.example.com/a.jpg"));
    assert_eq!(image("/a.jpg").as_deref(), Some("https://news.example.ru/a.jpg"));
    assert_eq!(image("a.jpg?x=1&amp;y=2").as_deref(), Some("https://news.example.ru/story/a.jpg?x=1&y=2"));
    assert_eq!(image("../a.jpg").as_deref(), Some("https://news.example.ru/a.jpg"));
    assert_eq!(image("  https://cdn.example.com/a.jpg  ").as_deref(), Some("https://cdn.example.com/a.jpg"));
    for bad in ["http://cdn.example.com/a.jpg", "data:image/png;base64,AAAA", "javascript:alert(1)", "https://127.0.0.1/a.jpg", "https://localhost/a.jpg", "https://cdn.example.com:8080/a.jpg", "https://u:p@cdn.example.com/a.jpg", "file:///a.jpg", ""] {
        assert_eq!(image(bad), None, "{bad}");
    }
    // The secure address goes first; a picture that may not be fetched gives way to the next one.
    let order = page(r#"<meta property="og:image" content="https://cdn.example.com/plain.jpg"><meta property="og:image:secure_url" content="https://cdn.example.com/secure.jpg">"#);
    assert_eq!(order.image_url.as_deref(), Some("https://cdn.example.com/secure.jpg"));
    let next = page(r#"<meta property="og:image" content="http://cdn.example.com/plain.jpg"><meta property="og:image" content="https://cdn.example.com/second.jpg"><meta name="twitter:image" content="https://cdn.example.com/t.jpg">"#);
    assert_eq!(next.image_url.as_deref(), Some("https://cdn.example.com/second.jpg"));
    let fallback = page(r#"<meta property="og:image" content="http://cdn.example.com/plain.jpg"><meta name="twitter:image" content="https://cdn.example.com/t.jpg">"#);
    assert_eq!(fallback.image_url.as_deref(), Some("https://cdn.example.com/t.jpg"));
    // The page itself must be an address a card may come from.
    for bad in ["http://example.com/", "https://10.0.0.1/", "https://example.com:8443/", "not an address", ""] {
        assert!(parse_page(b"<title>x</title>", None, bad).is_none(), "{bad}");
    }
}

#[test]
fn entities_are_decoded() {
    assert_eq!(decode_entities("&lt;b&gt; &amp;amp; &quot;x&quot; &apos;y&apos; &laquo;ёлки&raquo;&nbsp;&mdash;&ndash;&hellip;"), "<b> &amp; \"x\" 'y' «ёлки»\u{a0}—–…");
    assert_eq!(decode_entities("&#1055;&#1088;&#x438;&#X432;&#x435;&#1090; &#128512; &#x1F600;"), "Привет 😀 😀");
    // What is not a character, and the 0x80–0x9F range browsers read as windows-1252.
    assert_eq!(decode_entities("&#0;&#xD800;&#1114112;&#99999999999;&#151;&#x93;"), "\u{fffd}\u{fffd}\u{fffd}&#99999999999;—“");
    // Anything else stays as written.
    assert_eq!(decode_entities("a & b &unknown; &amp &#; &#x; &#xZZ; &; R&D &"), "a & b &unknown; &amp &#; &#x; &#xZZ; &; R&D &");
    assert_eq!(decode_entities("нет сущностей"), "нет сущностей");
    assert_eq!(decode_entities("&&&amp;&&"), "&&&&&");
    let found = page(r#"<title>Tom &amp; Jerry &#8212; &laquo;лучшее&raquo;</title><meta property="og:description" content="&quot;цитата&quot; &lt;script&gt;alert(1)&lt;/script&gt;">"#);
    assert_eq!((found.title.as_str(), found.description.as_str()), ("Tom & Jerry — «лучшее»", "\"цитата\" <script>alert(1)</script>"));
}

#[test]
fn malformed_pages_are_read_without_surprises() {
    // Scripts, styles and comments are stepped over, whatever they hold.
    let hidden = page(r#"<head><script>var t = "<title>Из скрипта</title><meta property='og:title' content='Скрипт'>";</script>
        <style>/* <title>Из стиля</title> */</style><!-- <meta property="og:title" content="Из комментария"> -->
        <SCRIPT type="application/ld+json">{"name":"</title>"}</SCRIPT><title>Настоящий</title></head>"#);
    assert_eq!(hidden.title, "Настоящий");
    // Nothing after the head is read: a page cannot put a card's text in its body.
    assert_eq!(page(r#"<head></head><body><title>Из тела</title><meta property="og:title" content="Из тела">"#).title, "");
    assert_eq!(page(r#"<html><body class="x"><meta property="og:title" content="Из тела">"#).title, "");
    // Attributes: without quotes, in single quotes, with spaces around `=`, in capitals, with a `>` inside quotes.
    assert_eq!(page("<meta property=og:title content=Слово>").title, "Слово");
    assert_eq!(page("<meta property = 'og:title'   content = 'a > b'>").title, "a > b");
    assert_eq!(page("<META\nPROPERTY=\"og:title\"\n\tCONTENT=\"В столбик\"\n/>").title, "В столбик");
    assert_eq!(page("<meta content=\"Сначала content\" property=\"og:title\"/>").title, "Сначала content");
    assert_eq!(page("<meta property=\"og:title\" content=\"Одинарная ' внутри\">").title, "Одинарная ' внутри");
    assert_eq!(page("<meta property=og:title content=a/b/>").title, "a/b/");
    // Cut short anywhere: no panic, and what was complete is kept.
    assert_eq!(page("<title>Оборванный заголов").title, "Оборванный заголов");
    assert_eq!(page("<title>Целый</title><meta property=\"og:description\" content=\"оборвано").description, "оборвано");
    assert_eq!(page("<title>Целый</title><meta property=\"og:title").title, "Целый");
    assert_eq!(page("<title>Целый</title><!-- без конца").title, "Целый");
    assert_eq!(page("<title>Целый</title><script>без конца").title, "Целый");
    assert_eq!(page("<title>Целый</title><").title, "Целый");
    assert_eq!(page("<title>Целый</title></").title, "Целый");
    assert_eq!(page("<title>Целый</title><meta").title, "Целый");
    assert_eq!(page("<title>Целый</title><meta =").title, "Целый");
    // A `<` that opens nothing is text; unknown tags and odd attributes are stepped over.
    assert_eq!(page("1 < 2 <3 <<<< <title>a < b</title>").title, "a < b");
    assert_eq!(page("<x-y:z я=\"ю\" = == / ><meta property=og:title content=Дальше>").title, "Дальше");
    assert_eq!(page("<?xml version=\"1.0\"?><!DOCTYPE html [ <!ENTITY x \"y\"> ]><title>После пролога</title>").title, "После пролога");
    // Only the first title counts; texts are made plain and cut.
    assert_eq!(page("<title>Первый</title><title>Второй</title>").title, "Первый");
    assert_eq!(page("<title>a\u{202e}b\u{0}c</title>").title, "abc");
    let long = page(&format!("<title>{}</title><meta name=description content=\"{}\"><meta property=og:site_name content=\"{}\">", "т".repeat(300), "о ".repeat(600), "с".repeat(200)));
    assert_eq!((long.title.chars().count(), long.description.chars().count(), long.site.chars().count()), (MAX_TITLE, MAX_DESCRIPTION - 1, MAX_SITE));
    assert!(!long.description.ends_with(' '));
}

#[test]
fn every_cut_and_every_noise_is_survived() {
    let html = r#"<!DOCTYPE html><html><head><meta charset="utf-8"><title>Заголовок &amp; ещё</title><!-- c --><script>if (a < b) { x = "</scr" + "ipt>" }</script>
        <meta property="og:title" content="Карточка «раз»"><meta property='og:image' content='/a.jpg'><style>a > b {}</style><link rel="x" href=y><meta name=description content=оп></head><body>"#;
    // Cut at every byte (also in the middle of a character), read in every charset: never a panic.
    for end in 0..=html.len() {
        for content_type in [None, Some("text/html; charset=utf-8"), Some("text/html; charset=windows-1251"), Some("text/html;charset=koi8-r"), Some("text/html; charset=iso-8859-1")] {
            let found = parse_page(&html.as_bytes()[..end], content_type, PAGE).expect("a page");
            assert!(found.title.chars().count() <= MAX_TITLE);
        }
    }
    // Bytes that are nothing in particular, from a fixed generator.
    let mut seed: u32 = 0x1bad_c0de;
    let mut next = move || { seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5; seed };
    let alphabet: &[u8] = b"<>/=\"'!-& ;#xmetatitlescriptpropertycontentog:\n\xd0\xbf\xff\x00";
    for _ in 0..3000 {
        let length = (next() % 200) as usize;
        let noise: Vec<u8> = (0..length).map(|_| alphabet[(next() as usize) % alphabet.len()]).collect();
        let found = parse_page(&noise, None, PAGE).expect("a page");
        for text in [&found.site, &found.title, &found.description] { assert_eq!(plain_text(text, MAX_DESCRIPTION), **text, "{noise:?}") }
        if let Some(image) = &found.image_url { assert!(fetchable(image), "{image}") }
    }
}

#[test]
fn only_the_first_256_kib_are_read() {
    let filler = " ".repeat(MAX_HTML_BYTES - 20);
    let inside = format!("<title>Виден</title>{filler}");
    assert_eq!(page(&inside).title, "Виден");
    let outside = format!("{}<title>Не виден</title>", " ".repeat(MAX_HTML_BYTES));
    assert_eq!(page(&outside).title, "");
    // A title that the limit cuts is kept up to the cut.
    let across = format!("{}<title>{}", " ".repeat(MAX_HTML_BYTES - 10), "abcdefgh");
    assert_eq!(page(&across).title, "abc");
}

#[derive(Deserialize)]
struct Table { name: String, text: String }
#[derive(Deserialize)]
struct Sentence { name: String, base64: String, text: String }
#[derive(Deserialize)]
struct Charsets { tables: Vec<Table>, encoded: Vec<Sentence> }

#[test]
fn one_byte_charsets_are_read_as_the_standard_decoders_read_them() {
    let vectors: Charsets = serde_json::from_str(include_str!("vectors/link-charsets.json")).expect("vectors");
    assert_eq!(vectors.tables.len(), 3);
    let all: Vec<u8> = (0..=255).collect();
    for table in &vectors.tables {
        let got = decode(&all, &table.name).expect("a known charset");
        let (got, want): (Vec<char>, Vec<char>) = (got.chars().collect(), table.text.chars().collect());
        assert_eq!(got.len(), 256);
        // windows-1251 has one unassigned byte (0x98): the standard decoder gives U+0098 for it, as the table does.
        for byte in 0..256 { assert_eq!(got[byte], want[byte], "{} byte {byte:#x}", table.name) }
    }
    assert!(vectors.encoded.len() >= 6);
    for sentence in &vectors.encoded {
        let bytes = base64::engine::general_purpose::STANDARD.decode(&sentence.base64).unwrap();
        assert_eq!(decode(&bytes, &sentence.name).as_deref(), Some(sentence.text.as_str()));
    }
    for (label, same_as) in [("UTF8", "utf-8"), (" Windows-1251 ", "windows-1251"), ("cp1251", "windows-1251"), ("\"koi8-r\"", "koi8-r"), ("KOI8", "koi8-r"), ("latin1", "windows-1252"), ("ISO-8859-1", "windows-1252")] {
        assert_eq!(decode(&all, label), decode(&all, same_as), "{label}");
    }
    assert_eq!(decode(b"x", "shift_jis"), None);
    assert_eq!(decode(b"x", ""), None);
    assert_eq!(decode(&[0xef, 0xbb, 0xbf, b'a', 0xff, b'b'], "utf-8").as_deref(), Some("a\u{fffd}b"));
}

#[test]
fn the_charset_of_a_page_is_found() {
    let title = "Новости дня: Ёжик в тумане — «№ 1»";
    let cp1251: Vec<u8> = { let table = decode(&(0..=255).collect::<Vec<u8>>(), "windows-1251").unwrap(); let table: Vec<char> = table.chars().collect(); title.chars().map(|c| table.iter().position(|held| *held == c).expect("in the charset") as u8).collect() };
    let koi8: Vec<u8> = { let table = decode(&(0..=255).collect::<Vec<u8>>(), "koi8-r").unwrap(); let table: Vec<char> = table.chars().collect(); "Новости дня: Ёжик в тумане".chars().map(|c| table.iter().position(|held| *held == c).expect("in the charset") as u8).collect() };
    let wrap = |before: &str, body: &[u8]| -> Vec<u8> { let mut out = before.as_bytes().to_vec(); out.extend_from_slice(b"<title>"); out.extend_from_slice(body); out.extend_from_slice(b"</title>"); out };
    let read = |bytes: &[u8], content_type: Option<&str>| parse_page(bytes, content_type, PAGE).expect("a page").title;

    // The server's header names it.
    assert_eq!(read(&wrap("", &cp1251), Some("text/html; charset=windows-1251")), title);
    assert_eq!(read(&wrap("", &cp1251), Some("text/html;CHARSET=\"Windows-1251\"; x=y")), title);
    assert_eq!(read(&wrap("", &koi8), Some("text/html; charset=koi8-r")), "Новости дня: Ёжик в тумане");
    // The page names it, either way.
    assert_eq!(read(&wrap("<meta charset=windows-1251>", &cp1251), None), title);
    assert_eq!(read(&wrap("<meta charset=\"CP1251\">", &cp1251), Some("text/html")), title);
    assert_eq!(read(&wrap("<meta http-equiv=\"Content-Type\" content=\"text/html; charset=windows-1251\">", &cp1251), None), title);
    assert_eq!(read(&wrap("<META HTTP-EQUIV='content-type' CONTENT='text/html; charset=koi8-r'>", &koi8), None), "Новости дня: Ёжик в тумане");
    // The header wins over the page; a byte-order mark wins over both.
    assert_eq!(read(&wrap("<meta charset=utf-8>", &cp1251), Some("text/html; charset=windows-1251")), title);
    let mut marked = vec![0xef, 0xbb, 0xbf];
    marked.extend_from_slice(&wrap("<meta charset=windows-1251>", title.as_bytes()));
    assert_eq!(read(&marked, Some("text/html; charset=koi8-r")), title);
    // Nobody names it: UTF-8 when the bytes are UTF-8 (a character cut by the size limit does not count)…
    assert_eq!(read(&wrap("", title.as_bytes()), None), title);
    assert_eq!(read(&wrap("", title.as_bytes()), Some("text/html; charset=x-unknown")), title);
    let mut cut = b"<title>".to_vec();
    cut.extend_from_slice(&"Ёжик".as_bytes()[..7]);
    assert_eq!(read(&cut, None), "Ёжи\u{fffd}");
    // …and windows-1251 otherwise, as Russian pages without a declaration are.
    assert_eq!(read(&wrap("", &cp1251), None), title);
    // A meta that only mentions the word is not a declaration.
    assert_eq!(read(&wrap("<meta name=\"keywords\" content=\"charset=koi8-r\">", title.as_bytes()), None), title);
    // ASCII reads the same everywhere.
    assert_eq!(read(b"<title>Plain ASCII</title>", Some("text/html; charset=us-ascii")), "Plain ASCII");
}

// ── The card as it travels ───────────────────────────────────────────────────────────────────────────────────

#[test]
fn a_card_is_made_plain_and_whole() {
    let made = wire("https://www.example.ru/a", "  Сайт\u{202e}  примера ", "Заголовок\n\nв две строки", " Описание\t\u{0}здесь ", None).expect("a card");
    assert_eq!(json::stringify(&made), r#"{"url":"https://www.example.ru/a","site":"Сайт примера","title":"Заголовок в две строки","description":"Описание здесь"}"#);
    assert!(valid_wire(&made, &units("вот https://www.example.ru/a"), None));
    // No name of its own: the host stands for the site.
    assert_eq!(wire("https://www.example.ru/a", "", "Т", "", None).unwrap().get("site"), Some(&Value::str("example.ru")));
    assert_eq!(site_of("https://Sub.Example.COM/x"), "sub.example.com");
    // Limits, by characters.
    let long = wire("https://example.ru/", &"с".repeat(500), &"😀".repeat(500), &"о".repeat(900), None).unwrap();
    let count = |key: &str| long.get(key).and_then(Value::as_str).unwrap().chars().count();
    assert_eq!((count("site"), count("title"), count("description")), (MAX_SITE, MAX_TITLE, MAX_DESCRIPTION));
    assert!(valid_wire(&long, &units("https://example.ru/"), None));
    // Nothing to show, or an address that may not carry a card.
    assert_eq!(wire("https://example.ru/", "Сайт", " \n ", "\u{0}", None), None);
    for bad in ["http://example.ru/", "https://10.0.0.1/", "https://example.ru:8080/", "example.ru", ""] { assert_eq!(wire(bad, "Сайт", "Заголовок", "", None), None, "{bad}") }
}

#[test]
fn the_picture_of_a_card_is_cleaned_and_bounded() {
    let clean = jpeg(480, 270, 4000);
    let made = wire("https://example.ru/", "", "Т", "", Some(&clean)).unwrap();
    assert_eq!(made.get("image"), Some(&image_value(&clean, 480, 270)));
    assert!(valid_wire(&made, &units("https://example.ru/"), None));
    // A picture alone is enough for a card.
    assert!(wire("https://example.ru/", "", "", "", Some(&clean)).is_some());
    assert_eq!(wire("https://example.ru/", "", "", "", None), None);
    // Metadata (here an EXIF block and a comment) never travels: the cleaner drops it, and the card holds the rest.
    let mut dirty = clean[..2].to_vec();
    dirty.extend_from_slice(&[0xff, 0xe1, 0x00, 0x0c]);
    dirty.extend_from_slice(b"Exif\0\0GPS!");
    dirty.extend_from_slice(&[0xff, 0xfe, 0x00, 0x08]);
    dirty.extend_from_slice(b"secret");
    dirty.extend_from_slice(&clean[2..]);
    assert_eq!(create_link_image(&dirty).unwrap().base64, b64(&clean));
    assert_eq!(wire("https://example.ru/", "", "Т", "", Some(&dirty)).unwrap().get("image"), Some(&image_value(&clean, 480, 270)));
    // Over the limits, or not a JPEG: the card goes without a picture (and is nothing when it had only that).
    let side = jpeg(481, 100, 100);
    let tall = jpeg(100, 481, 100);
    let heavy = jpeg(480, 480, MAX_LINK_IMAGE_BYTES);
    for bad in [side.as_slice(), tall.as_slice(), heavy.as_slice(), b"\x89PNG\r\n\x1a\n", b"", &clean[..clean.len() - 1]] {
        assert!(create_link_image(bad).is_err());
        assert_eq!(wire("https://example.ru/", "", "Т", "", Some(bad)).unwrap().get("image"), None);
        assert_eq!(wire("https://example.ru/", "", "", "", Some(bad)), None);
    }
    // Exactly at the limits.
    let largest = jpeg(480, 480, MAX_LINK_IMAGE_BYTES - 27);
    assert_eq!(largest.len(), MAX_LINK_IMAGE_BYTES);
    assert!(create_link_image(&largest).is_ok());
    assert!(create_link_image(&jpeg(480, 480, MAX_LINK_IMAGE_BYTES - 26)).is_err());
}

#[test]
fn the_limits_of_an_attachment_preview_stay_as_they_were() {
    // The sibling with larger limits must not have loosened the picture that rides with a file.
    assert!(create_preview(&jpeg(256, 256, 100)).is_ok());
    assert!(create_preview(&jpeg(257, 100, 100)).is_err());
    assert!(create_preview(&jpeg(100, 100, 8 * 1024)).is_err());
    assert!(valid_preview(Some(&image_value(&jpeg(256, 256, 100), 256, 256))));
    assert!(!valid_preview(Some(&image_value(&jpeg(300, 200, 100), 300, 200))));
    assert!(valid_link_image(&image_value(&jpeg(300, 200, 100), 300, 200)));
    let heavy = jpeg(200, 200, 9000);
    assert!(!valid_preview(Some(&image_value(&heavy, 200, 200))) && valid_link_image(&image_value(&heavy, 200, 200)));
}

#[test]
fn a_received_card_must_be_exactly_one_this_app_makes() {
    let text = units("глянь https://example.ru/a и http://plain.example.ru/b");
    let good = card("https://example.ru/a", "Пример", "Заголовок", "Описание");
    assert!(valid_wire(&good, &text, None));
    let ok = |card: &Value| valid_wire(card, &text, None);
    // Empty texts are fine while something is left to show.
    assert!(ok(&with(&good, "description", Value::str(""))));
    assert!(ok(&with(&good, "title", Value::str(""))));
    assert!(!ok(&with(&with(&good, "title", Value::str("")), "description", Value::str(""))));
    assert!(!ok(&with(&good, "site", Value::str(""))));

    // The address must be one of the https links of this very text.
    for url in ["https://example.ru/", "https://example.ru/a/", "https://example.ru/A", "https://other.example.ru/a", "http://plain.example.ru/b", "https://plain.example.ru/b", "", "глянь"] {
        assert!(!ok(&with(&good, "url", Value::str(url))), "{url}");
    }
    assert!(!valid_wire(&good, &units("никаких ссылок"), None));
    assert!(!valid_wire(&good, &units(""), None));
    assert!(!valid_wire(&card("https://192.168.0.1/a", "Роутер", "Вход", ""), &units("https://192.168.0.1/a"), None));
    assert!(!valid_wire(&card("https://example.ru:8443/a", "Пример", "Вход", ""), &units("https://example.ru:8443/a"), None));
    // A link behind words counts by its address; one under a spoiler does not.
    let entities = json::parse(r#"[{"type":"text_link","offset":0,"length":5,"url":"https://example.ru/behind"}]"#).unwrap();
    assert!(valid_wire(&card("https://example.ru/behind", "Пример", "Заголовок", ""), &units("слова и всё"), Some(&entities)));
    assert!(!valid_wire(&card("https://example.ru/behind", "Пример", "Заголовок", ""), &units("слова и всё"), None));
    let spoiler = json::parse(r#"[{"type":"spoiler","offset":0,"length":20}]"#).unwrap();
    assert!(!valid_wire(&good, &units("https://example.ru/a"), Some(&spoiler)));

    // Texts must already be plain and within their limits.
    for (key, bad) in [("title", "две\nстроки"), ("title", " пробел в начале"), ("title", "пробел в конце "), ("title", "два  пробела"), ("title", "a\u{202e}b"), ("title", "a\u{0}b"), ("description", "таб\tтут"), ("site", "a\u{200b}b"), ("site", "неразрывный\u{a0}пробел")] {
        assert!(!ok(&with(&good, key, Value::str(bad))), "{key} {bad:?}");
    }
    assert!(ok(&with(&good, "site", Value::str(&"с".repeat(MAX_SITE)))) && !ok(&with(&good, "site", Value::str(&"с".repeat(MAX_SITE + 1)))));
    assert!(ok(&with(&good, "title", Value::str(&"т".repeat(MAX_TITLE)))) && !ok(&with(&good, "title", Value::str(&"т".repeat(MAX_TITLE + 1)))));
    assert!(ok(&with(&good, "description", Value::str(&"😀".repeat(MAX_DESCRIPTION)))) && !ok(&with(&good, "description", Value::str(&"😀".repeat(MAX_DESCRIPTION + 1)))));
    // A text that is not well-formed UTF-16 is not a text.
    assert!(!ok(&with(&good, "title", Value::String(JsString(vec![0x41, 0xd800, 0x42])))));

    // The shape: every text present and a text, no other keys, nothing twice.
    for key in ["url", "site", "title", "description"] {
        assert!(!ok(&without(&good, key)), "without {key}");
        for wrong in [Value::Null, Value::Number(1.0), Value::Bool(true), Value::Array(vec![]), json::object(vec![])] { assert!(!ok(&with(&good, key, wrong.clone())), "{key} = {wrong:?}") }
    }
    assert!(!ok(&with(&good, "extra", Value::str("x"))));
    assert!(!ok(&with(&good, "imageUrl", Value::str("https://example.ru/track.gif"))));
    let Value::Object(mut twice) = good.clone() else { unreachable!() };
    twice.push((JsString::from_str("title"), Value::str("Другой")));
    assert!(!ok(&Value::Object(twice)));
    for wrong in [Value::Null, Value::str("https://example.ru/a"), Value::Array(vec![good.clone()]), Value::Bool(true), Value::Number(0.0)] { assert!(!ok(&wrong), "{wrong:?}") }
}

#[test]
fn a_received_picture_must_be_a_bounded_cleaned_jpeg_with_its_true_size() {
    let text = units("https://example.ru/a");
    let good = card("https://example.ru/a", "Пример", "Заголовок", "");
    let clean = jpeg(320, 180, 2000);
    let ok = |image: Value| valid_wire(&with(&good, "image", image), &text, None);
    assert!(ok(image_value(&clean, 320, 180)));
    // A wrong size, an unknown key, another kind of picture.
    assert!(!ok(image_value(&clean, 180, 320)));
    assert!(!ok(image_value(&clean, 321, 180)));
    assert!(!ok(with(&image_value(&clean, 320, 180), "url", Value::str("https://example.ru/track.gif"))));
    assert!(!ok(with(&image_value(&clean, 320, 180), "mimeType", Value::str("image/png"))));
    assert!(!ok(without(&image_value(&clean, 320, 180), "mimeType")));
    assert!(!ok(with(&image_value(&clean, 320, 180), "width", Value::str("320"))));
    assert!(!ok(with(&image_value(&clean, 320, 180), "base64", Value::str(""))));
    assert!(!ok(with(&image_value(&clean, 320, 180), "base64", Value::str("не base64"))));
    for wrong in [Value::Null, Value::str("x"), Value::Array(vec![]), json::object(vec![]), Value::Bool(false)] { assert!(!ok(wrong)) }
    // Over the limits.
    assert!(!ok(image_value(&jpeg(481, 100, 100), 481, 100)));
    assert!(!ok(image_value(&jpeg(100, 481, 100), 100, 481)));
    let heavy = jpeg(480, 480, MAX_LINK_IMAGE_BYTES);
    assert!(!ok(image_value(&heavy, 480, 480)));
    assert!(ok(image_value(&jpeg(480, 480, MAX_LINK_IMAGE_BYTES - 27), 480, 480)));
    // Anything but the picture — metadata, bytes after the end — means it is not one this app made.
    let mut dirty = clean[..2].to_vec();
    dirty.extend_from_slice(&[0xff, 0xfe, 0x00, 0x08]);
    dirty.extend_from_slice(b"secret");
    dirty.extend_from_slice(&clean[2..]);
    assert!(!ok(image_value(&dirty, 320, 180)));
    let mut trailing = clean.clone();
    trailing.extend_from_slice(b"hidden");
    assert!(!ok(image_value(&trailing, 320, 180)));
    assert!(!ok(image_value(&clean[..clean.len() - 2], 320, 180)));
    // A card whose picture is bad is refused as a whole, not shown without it: it is not one this app made.
    assert!(valid_wire(&good, &text, None));
}

#[test]
fn only_a_plain_text_message_carries_a_card() {
    let text = units("https://example.ru/a");
    let good = card("https://example.ru/a", "Пример", "Заголовок", "");
    assert_eq!(for_message(Some(&good), &text, &Value::Null, None), Some(&good));
    assert_eq!(for_message(None, &text, &Value::Null, None), None);
    assert_eq!(for_message(Some(&Value::Null), &text, &Value::Null, None), None);
    // With a file, a poll or an action there is none.
    let file = json::parse(r#"{"id":"x"}"#).unwrap();
    assert_eq!(for_message(Some(&good), &text, &file, None), None);
    let poll = json::parse(r#"{"poll":{"question":"?","options":["a","b"]}}"#).unwrap();
    assert_eq!(for_message(Some(&good), &text, &Value::Null, Some(&poll)), None);
    let action = json::parse(r#"{"action":{"type":"edit","target":"t","text":"https://example.ru/a"}}"#).unwrap();
    assert_eq!(for_message(Some(&good), &text, &Value::Null, Some(&action)), None);
    // An answer to a message, or formatting, changes nothing.
    let reply = json::parse(r#"{"replyTo":"0f8fad5b-d9cb-469f-a165-70867728950e","entities":[{"type":"bold","offset":0,"length":5}]}"#).unwrap();
    let longer = units("жирно https://example.ru/a");
    assert_eq!(for_message(Some(&good), &longer, &Value::Null, Some(&reply)), Some(&good));
    // The entities of the message decide which links it has.
    let hidden = json::parse(r#"{"entities":[{"type":"spoiler","offset":0,"length":20}]}"#).unwrap();
    assert_eq!(for_message(Some(&good), &text, &Value::Null, Some(&hidden)), None);
    assert_eq!(without_image(&with(&good, "image", Value::str("x"))), good);
    assert_eq!(without_image(&good), good);
}
