//! The rules behind the settings pages, the same on both phones: the themes and the person's own colours over
//! them, the night theme, what is kept on the device (and how an old or broken record is read), the sound of a
//! chat and the labels of sizes.
//!
//! Ported from the reference: `mobile/src/theme.tsx`, `themes/palettes.ts`, `themes/custom.ts`,
//! `themePreference.ts`, `chatPreferences.ts`, `notifications/model.ts`, and the size labels of
//! `SettingsScreen.tsx`. Pinned to it by `tests/settings_vectors.rs` (vectors from
//! `tests/generate-settings-vectors.mjs`).

use crate::json::{self, number_text, Value};
use crate::time::{iso_from_ms, parse_iso_ms};

// ---- Colours (`themes/palettes.ts`) ----

type Rgb = [f64; 3];

/// `Math.round`: halves go up.
fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// `#RRGGBB` → its three parts.
fn rgb(color: &str) -> Option<Rgb> {
    let bytes = color.as_bytes();
    if bytes.len() != 7 || bytes[0] != b'#' || !bytes[1..].iter().all(u8::is_ascii_hexdigit) { return None }
    let part = |at: usize| u8::from_str_radix(&color[at..at + 2], 16).ok().map(f64::from);
    Some([part(1)?, part(3)?, part(5)?])
}
fn rgb_of(color: &str) -> Rgb { rgb(color).unwrap_or([0.0; 3]) }

fn hex(parts: Rgb) -> String {
    let byte = |v: f64| js_round(v.clamp(0.0, 255.0)) as u8;
    format!("#{:02X}{:02X}{:02X}", byte(parts[0]), byte(parts[1]), byte(parts[2]))
}

/// `a` moved toward `b` by the share `t`.
fn mix(a: &str, b: &str, t: f64) -> String {
    let (x, y) = (rgb_of(a), rgb_of(b));
    hex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t])
}

fn rgba(color: &str, alpha: f64) -> String {
    let [r, g, b] = rgb_of(color);
    format!("rgba({},{},{},{})", r as u32, g as u32, b as u32, number_text(alpha))
}

/// WCAG relative luminance.
fn luminance(color: &str) -> f64 {
    let part = |v: f64| { let s = v / 255.0; if s <= 0.03928 { s / 12.92 } else { ((s + 0.055) / 1.055).powf(2.4) } };
    let [r, g, b] = rgb_of(color);
    0.2126 * part(r) + 0.7152 * part(g) + 0.0722 * part(b)
}

/// WCAG contrast ratio.
fn contrast(a: &str, b: &str) -> f64 {
    let (x, y) = (luminance(a), luminance(b));
    let (high, low) = if x >= y { (x, y) } else { (y, x) };
    (high + 0.05) / (low + 0.05)
}

// ---- Themes (`theme.tsx`, `themes/palettes.ts`) ----

#[derive(Clone)]
struct Theme {
    dark: bool, black: bool, plain: bool,
    bg: String, surface: String, surface2: String, text: String, muted: String, border: String, accent: String, accent_soft: String, on_accent: String,
    bubble: String, incoming: String, danger: String, danger_bg: String, chat_bg: String, subtle: String, shadow: String,
    glass: String, glass_clear: String, glass_border: String, glass_highlight: String, glass_tint: String, glass_opaque: String,
    bg_gradient: [String; 3], ambient_blue: String, ambient_lilac: String, accent_gradient: [String; 2],
}

/// A built-in theme from its colours in the order of the reference's `Theme`.
fn built_in(dark: bool, black: bool, c: [&str; 29]) -> Theme {
    let s = |at: usize| c[at].to_string();
    Theme {
        dark, black, plain: true,
        bg: s(0), surface: s(1), surface2: s(2), text: s(3), muted: s(4), border: s(5), accent: s(6), accent_soft: s(7), on_accent: s(8),
        bubble: s(9), incoming: s(10), danger: s(11), danger_bg: s(12), chat_bg: s(13), subtle: s(14), shadow: s(15),
        glass: s(16), glass_clear: s(17), glass_border: s(18), glass_highlight: s(19), glass_tint: s(20), glass_opaque: s(21),
        bg_gradient: [s(22), s(23), s(24)], ambient_blue: s(25), ambient_lilac: s(26), accent_gradient: [s(27), s(28)],
    }
}

/// The colour palettes: id, name, six colours (darkest first), which of them is the accent.
const PALETTES: [(&str, &str, [&str; 6], usize); 7] = [
    ("amethyst", "Аметист", ["#0E0B1D", "#2A1E4D", "#5A3B8C", "#8B7CC7", "#C9C2E3", "#3A3A52"], 3),
    ("coffee", "Кофе", ["#1A120E", "#3A2418", "#6B4A2E", "#A88462", "#D5C4AE", "#4A4A46"], 3),
    ("olive", "Олива", ["#0F1F17", "#1E3A2E", "#3E5A3F", "#6B7F67", "#C7CBB8", "#3D4337"], 3),
    ("dusk", "Сумерки", ["#0B132B", "#1C2541", "#3A506B", "#5BC0DE", "#F4D6B0", "#D97706"], 5),
    ("lagoon", "Лагуна", ["#0A0F14", "#0F3D3E", "#2E6F73", "#7FB3B8", "#EADCC8", "#C6601F"], 5),
    ("indigo", "Индиго", ["#1A1A1F", "#2D2B55", "#6A5ACD", "#A678B9", "#F0D9B5", "#F4A62A"], 5),
    ("neon", "Неон", ["#121212", "#1F2937", "#334155", "#64748B", "#F1F5F9", "#EC4899"], 5),
];
fn is_palette(id: &str) -> bool { PALETTES.iter().any(|palette| palette.0 == id) }

/// A palette turned into the full theme by fixed roles (`paletteTheme`).
fn palette_theme(colors: &[&str; 6], accent_index: usize) -> Theme {
    let [c0, c1, c2, c3, c4, _] = *colors;
    fn on_for<'a>(color: &str, c0: &'a str) -> &'a str { if contrast(color, c0) >= contrast(color, "#FFFFFF") { c0 } else { "#FFFFFF" } }
    // A muted accent is lifted toward the pale tone until it reads as text on the background and under button labels.
    let mut accent = colors[accent_index].to_string();
    let mut step = 0;
    while step < 20 && (contrast(&accent, c0) < 4.5 || contrast(on_for(&accent, c0), &accent) < 4.5) {
        accent = mix(&accent, c4, 0.08);
        step += 1;
    }
    Theme {
        dark: true, black: false, plain: false, bg: c0.to_string(),
        surface: rgba(c1, 0.92), surface2: rgba(c2, 0.38), text: mix(c4, "#FFFFFF", 0.55), muted: mix(c4, c0, 0.32),
        border: rgba(c3, 0.22), accent_soft: rgba(&accent, 0.17), on_accent: on_for(&accent, c0).to_string(),
        bubble: rgba(&mix(c2, c1, 0.15), 0.94), incoming: rgba(c1, 0.94),
        danger: "#FF8FA3".to_string(), danger_bg: "rgba(84,28,42,0.9)".to_string(), chat_bg: "transparent".to_string(),
        subtle: mix(c3, c0, 0.35), shadow: c0.to_string(),
        glass: rgba(c1, 0.55), glass_clear: rgba(c1, 0.22), glass_border: rgba(c4, 0.2),
        glass_highlight: rgba(c4, 0.16), glass_tint: rgba(c2, 0.12), glass_opaque: mix(c1, c0, 0.35),
        bg_gradient: [mix(c0, c1, 0.4), c0.to_string(), mix(c0, c1, 0.22)],
        ambient_blue: rgba(c2, 0.26), ambient_lilac: rgba(&accent, 0.12),
        accent_gradient: [mix(&accent, "#FFFFFF", 0.18), accent.clone()],
        accent,
    }
}

fn theme_by_id(id: &str) -> Option<Theme> {
    Some(match id {
        "light" => built_in(false, false, ["#EDF3FB", "rgba(250,252,255,0.88)", "rgba(225,233,247,0.62)", "#14243D", "#5C6E88", "rgba(81,109,154,0.17)", "#3568E7", "rgba(70,113,239,0.11)", "#FFFFFF",
            "rgba(218,231,255,0.93)", "rgba(255,255,255,0.84)", "#B83751", "rgba(255,232,238,0.92)", "transparent", "#7B8CA5", "#294C91",
            "rgba(255,255,255,0.44)", "rgba(255,255,255,0.16)", "rgba(255,255,255,0.85)", "rgba(255,255,255,0.82)", "rgba(230,239,255,0.15)", "#F6F8FD",
            "#E7EFFC", "#F5F7FD", "#E8EEF9", "rgba(117,166,255,0.25)", "rgba(172,151,239,0.17)", "#4F7CEC", "#315BCF"]),
        "dark" => built_in(true, false, ["#080F1E", "rgba(24,35,57,0.91)", "rgba(43,59,87,0.67)", "#F0F5FF", "#ABBCD6", "rgba(175,201,247,0.16)", "#9ABEFF", "rgba(115,161,255,0.15)", "#0A2047",
            "rgba(43,70,119,0.92)", "rgba(30,44,69,0.92)", "#FF9CB0", "rgba(82,34,51,0.88)", "transparent", "#8398BA", "#010511",
            "rgba(19,31,53,0.52)", "rgba(26,42,70,0.22)", "rgba(199,219,255,0.23)", "rgba(221,234,255,0.22)", "rgba(58,88,141,0.12)", "#17243A",
            "#0A1529", "#10192D", "#070E1C", "rgba(56,112,224,0.23)", "rgba(114,88,190,0.13)", "#BAD3FF", "#85ADFF"]),
        // «Чёрная»: the app's own look.
        "black" => built_in(true, true, ["#08090A", "rgba(15,16,17,0.96)", "rgba(22,23,24,0.92)", "#E5E5E6", "#8A8F98", "#23252A", "#E5E5E6", "rgba(255,255,255,0.07)", "#08090A",
            "rgba(31,32,35,0.96)", "rgba(22,23,24,0.96)", "#FF9CB0", "rgba(69,20,31,0.88)", "transparent", "#62666D", "#000000",
            "rgba(15,16,17,0.62)", "rgba(15,16,17,0.26)", "rgba(255,255,255,0.08)", "rgba(255,255,255,0.10)", "rgba(8,9,10,0.30)", "#0F1011",
            "#08090A", "#08090A", "#08090A", "rgba(255,255,255,0.03)", "rgba(255,255,255,0.02)", "#F2F2F2", "#C8C8C8"]),
        "graphite" => built_in(true, false, ["#1C1C1E", "rgba(44,44,46,0.96)", "rgba(58,58,60,0.9)", "#F2F2F7", "#A1A1A8", "rgba(255,255,255,0.10)", "#D1D1D6", "rgba(209,209,214,0.13)", "#1C1C1E",
            "rgba(72,72,76,0.97)", "rgba(44,44,46,0.96)", "#FF8A8A", "rgba(84,32,36,0.88)", "transparent", "#7C7C83", "#000000",
            "rgba(44,44,46,0.62)", "rgba(44,44,46,0.28)", "rgba(255,255,255,0.10)", "rgba(255,255,255,0.12)", "rgba(28,28,30,0.30)", "#2C2C2E",
            "#1C1C1E", "#1C1C1E", "#1C1C1E", "rgba(255,255,255,0.02)", "rgba(255,255,255,0.01)", "#E5E5EA", "#AEAEB2"]),
        other => { let palette = PALETTES.iter().find(|palette| palette.0 == other)?; palette_theme(&palette.2, palette.3) }
    })
}

// ---- The person's own colours (`themes/custom.ts`) ----

/// What JavaScript's `trim` takes off.
fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{B}' | '\u{C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

/// A stored colour: `#RRGGBB` in upper case, or nothing.
fn stored_color(value: Option<&Value>) -> Option<String> {
    let Some(Value::String(text)) = value else { return None };
    let text = text.to_string_lossy();
    let trimmed = text.trim_matches(js_space);
    rgb(trimmed).map(|_| trimmed.to_ascii_uppercase())
}

/// The digits at the start of `text` and what follows them.
fn digits(text: &str) -> Option<(&str, &str)> {
    let end = text.find(|c: char| !c.is_ascii_digit()).unwrap_or(text.len());
    if end == 0 { None } else { Some(text.split_at(end)) }
}
/// `rgb(r, g, b` or `rgba(r, g, b`: the three numbers and what follows the third.
fn rgb_call(color: &str, blanks_first: bool) -> Option<([f64; 3], &str)> {
    let rest = color.strip_prefix("rgba(").or_else(|| color.strip_prefix("rgb("))?;
    let rest = if blanks_first { rest.trim_start_matches(js_space) } else { rest };
    let (r, rest) = digits(rest)?;
    let (g, rest) = digits(rest.strip_prefix(',')?.trim_start_matches(js_space))?;
    let (b, rest) = digits(rest.strip_prefix(',')?.trim_start_matches(js_space))?;
    Some(([r.parse().ok()?, g.parse().ok()?, b.parse().ok()?], rest))
}

/// A solid `#RRGGBB` close to what a theme colour looks like (theme colours may be `rgba` over the background).
fn solid(color: &str, fallback: &str) -> String {
    let upper = color.to_uppercase();
    if rgb(&upper).is_some() { return upper }
    match rgb_call(color, false) {
        Some((parts, _)) => {
            let part = |v: f64| format!("{:02x}", v as u64);
            format!("#{}{}{}", part(parts[0]), part(parts[1]), part(parts[2])).to_uppercase()
        }
        None => fallback.to_string(),
    }
}

/// `color` moved toward `toward` in small steps until it has `ratio` contrast with `against` (or 20 steps).
fn readable(color: &str, against: &str, toward: &str, ratio: f64) -> String {
    let mut result = color.to_string();
    let mut step = 1;
    while step <= 20 && contrast(&result, against) < ratio {
        result = mix(color, toward, f64::from(step) / 20.0);
        step += 1;
    }
    result
}

/// The theme with the person's colours laid over it (`customTheme`).
fn custom_theme(theme: Theme, accent: Option<String>, bubble: Option<String>) -> Theme {
    if accent.is_none() && bubble.is_none() { return theme }
    let bg = solid(&theme.bg, if theme.dark { "#101014" } else { "#F4F6FA" });
    let text = solid(&theme.text, if theme.dark { "#FFFFFF" } else { "#10141C" });
    let mut result = theme;
    if let Some(accent) = accent {
        // The accent is also text (links, selected items): 3:1 against the background at least.
        let shown = readable(&accent, &bg, if result.dark { "#FFFFFF" } else { "#000000" }, 3.0);
        let on = if contrast(&shown, "#FFFFFF") >= contrast(&shown, "#0B0D12") { "#FFFFFF" } else { "#0B0D12" };
        result.accent_soft = rgba(&shown, if result.dark { 0.16 } else { 0.12 });
        result.on_accent = on.to_string();
        result.accent_gradient = [mix(&shown, "#FFFFFF", 0.16), mix(&shown, "#000000", 0.12)];
        result.accent = shown;
    }
    if let Some(bubble) = bubble {
        // The bubble goes darker (dark themes) or paler (light ones) until the theme's text reads on it.
        let shown = readable(&bubble, &text, if result.dark { "#000000" } else { "#FFFFFF" }, 4.5);
        result.bubble = rgba(&shown, 0.95);
    }
    result
}

/// Service text on the person's own bubble: the muted and accent colours moved toward the text colour until they
/// read on the bubble (`ownBubbleInk`).
fn own_bubble_ink(theme: &Theme) -> (String, String) {
    let text = solid(&theme.text, if theme.dark { "#FFFFFF" } else { "#10141C" });
    let bg = solid(&theme.bg, if theme.dark { "#101014" } else { "#F4F6FA" });
    let alpha = theme.bubble.strip_prefix("rgba(").and_then(|_| rgb_call(&theme.bubble, true)).and_then(|(_, rest)| {
        let rest = rest.strip_prefix(',')?.trim_start_matches(js_space);
        let end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(rest.len());
        if end == 0 || !rest[end..].starts_with(')') { return None }
        Some(rest[..end].parse::<f64>().unwrap_or(f64::NAN))
    });
    let bubble = mix(&bg, &solid(&theme.bubble, &bg), alpha.map_or(1.0, |alpha| if alpha > 1.0 { 1.0 } else { alpha }));
    (readable(&solid(&theme.muted, &text), &bubble, &text, 4.5), readable(&solid(&theme.accent, &text), &bubble, &text, 3.0))
}

fn theme_value(theme: &Theme) -> Value {
    let s = |text: &String| Value::str(text);
    let mut entries = vec![
        ("dark", Value::Bool(theme.dark)), ("black", Value::Bool(theme.black)), ("bg", s(&theme.bg)), ("surface", s(&theme.surface)), ("surface2", s(&theme.surface2)),
        ("text", s(&theme.text)), ("muted", s(&theme.muted)), ("border", s(&theme.border)), ("accent", s(&theme.accent)), ("accentSoft", s(&theme.accent_soft)),
        ("onAccent", s(&theme.on_accent)), ("bubble", s(&theme.bubble)), ("incoming", s(&theme.incoming)), ("danger", s(&theme.danger)), ("dangerBg", s(&theme.danger_bg)),
        ("chatBg", s(&theme.chat_bg)), ("subtle", s(&theme.subtle)), ("shadow", s(&theme.shadow)), ("glass", s(&theme.glass)), ("glassClear", s(&theme.glass_clear)),
        ("glassBorder", s(&theme.glass_border)), ("glassHighlight", s(&theme.glass_highlight)), ("glassTint", s(&theme.glass_tint)), ("glassOpaque", s(&theme.glass_opaque)),
        ("bgGradient", Value::Array(theme.bg_gradient.iter().map(s).collect())), ("ambientBlue", s(&theme.ambient_blue)), ("ambientLilac", s(&theme.ambient_lilac)),
        ("accentGradient", Value::Array(theme.accent_gradient.iter().map(s).collect())),
    ];
    if theme.plain { entries.push(("plain", Value::Bool(true))) }
    let (meta, accent) = own_bubble_ink(theme);
    entries.push(("ink", json::object(vec![("meta", Value::str(&meta)), ("accent", Value::str(&accent))])));
    json::object(entries)
}

/// Hue 0…360, saturation and value 0…1 → `#RRGGBB`.
fn hsv_color(h: f64, s: f64, v: f64) -> String {
    let hue = ((h % 360.0) + 360.0) % 360.0;
    let c = v * s;
    let x = c * (1.0 - (((hue / 60.0) % 2.0) - 1.0).abs());
    let m = v - c;
    let (r, g, b) = if hue < 60.0 { (c, x, 0.0) } else if hue < 120.0 { (x, c, 0.0) } else if hue < 180.0 { (0.0, c, x) } else if hue < 240.0 { (0.0, x, c) } else if hue < 300.0 { (x, 0.0, c) } else { (c, 0.0, x) };
    let part = |v: f64| format!("{:02X}", js_round((v + m) * 255.0) as i64);
    format!("#{}{}{}", part(r), part(g), part(b))
}

/// `#RRGGBB` → hue 0…360, saturation and value 0…1.
fn color_hsv(color: &str) -> Option<Value> {
    if color.bytes().any(|byte| byte.is_ascii_lowercase()) { return None }
    let [r, g, b] = rgb(color)?.map(|part| part / 255.0);
    let (max, min) = (r.max(g).max(b), r.min(g).min(b));
    let d = max - min;
    let h = if d == 0.0 { 0.0 } else if max == r { 60.0 * (((g - b) / d) % 6.0) } else if max == g { 60.0 * ((b - r) / d + 2.0) } else { 60.0 * ((r - g) / d + 4.0) };
    Some(json::object(vec![("h", Value::Number((h + 360.0) % 360.0)), ("s", Value::Number(if max == 0.0 { 0.0 } else { d / max })), ("v", Value::Number(max))]))
}

// ---- Which theme is on (`themePreference.ts`) ----

fn stored_theme_mode(value: &Value) -> String {
    match value.as_str() { Some(id) if matches!(id.as_str(), "light" | "dark" | "black" | "graphite") || is_palette(&id) => id, _ => "system".to_string() }
}
fn stored_dark_theme(value: &Value) -> String {
    match value.as_str() { Some(id) if matches!(id.as_str(), "black" | "graphite") || is_palette(&id) => id, _ => "dark".to_string() }
}

/// «HH:MM» → minutes since midnight.
fn clock_minutes(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' || ![0, 1, 3, 4].iter().all(|at| bytes[*at].is_ascii_digit()) { return None }
    let (hours, minutes) = (text[..2].parse::<u32>().ok()?, text[3..].parse::<u32>().ok()?);
    if hours > 23 || minutes > 59 { None } else { Some(f64::from(hours * 60 + minutes)) }
}

fn flag_or_null(value: Option<&Value>) -> Option<Option<bool>> {
    match value { Some(Value::Bool(flag)) => Some(Some(*flag)), Some(Value::Null) | None => Some(None), _ => None }
}

/// The night theme right now (`effectiveNightMode`, `autoNight`, `manualNightExpired`, `themeFor`).
fn night(settings: &Value, mode: &str, dark_theme: &str, system: Option<&str>, minute: f64, brightness: Option<f64>) -> Option<Value> {
    let kind = match settings.get("mode") { Some(Value::String(kind)) => kind.to_string_lossy(), Some(Value::Null) | None => if mode == "system" { "system" } else { "off" }.to_string(), _ => return None };
    let auto = match kind.as_str() {
        "system" => system == Some("dark"),
        "schedule" => {
            let (a, b) = (clock_minutes(&settings.get("from")?.as_str()?)?, clock_minutes(&settings.get("to")?.as_str()?)?);
            if a == b { false } else if a < b { minute >= a && minute <= b } else { minute >= a || minute < b }
        }
        "auto" => { let Some(Value::Number(limit)) = settings.get("brightness") else { return None }; brightness.is_some_and(|level| level <= *limit) }
        "off" => false,
        _ => return None,
    };
    let known = kind != "auto" || brightness.is_some();
    let (forced, forced_at) = (flag_or_null(settings.get("forced"))?, flag_or_null(settings.get("forcedAt"))?);
    // A manual switch holds until the rule changes by itself; an unknown rule is not a change.
    let expired = forced.is_some() && known && forced_at.is_some_and(|at| at != auto);
    let night = if expired { auto } else { forced.unwrap_or(auto) };
    let day = if mode == "system" { "light" } else { mode };
    Some(json::object(vec![("kind", Value::str(&kind)), ("auto", Value::Bool(auto)), ("known", Value::Bool(known)), ("expired", Value::Bool(expired)), ("night", Value::Bool(night)),
        ("shown", Value::str(if night { dark_theme } else { day })), ("day", Value::str(day))]))
}

// ---- What is kept on the device (`chatPreferences.ts`, `notifications/model.ts`) ----

const TEXT_SIZES: [(&str, &str, f64, f64); 4] = [("small", "Мелкий", 15.0, 20.0), ("medium", "Обычный", 17.0, 22.0), ("large", "Крупный", 19.0, 25.0), ("xlarge", "Очень крупный", 22.0, 28.0)];
const WALLPAPERS: [(&str, &str, &[&str]); 6] = [
    ("none", "Как фон", &[]), ("aurora", "Аврора", &["#0E2A47", "#1B3F6B", "#3A2A63"]), ("night", "Ночь", &["#05060B", "#0B1020", "#121A33"]),
    ("mint", "Мята", &["#0D3B3A", "#145650", "#1E3B5A"]), ("sunset", "Закат", &["#3B1838", "#5A2440", "#2A1E4A"]), ("violet", "Фиолет", &["#3A2D8F", "#5B3FB8", "#2B5BB5"]),
];
const ACCENT_CHOICES: [&str; 12] = ["#3568E7", "#2AABEE", "#00B8A9", "#34C759", "#A3D22F", "#F5C518", "#FF9500", "#FF5E3A", "#FF3B5C", "#E64AA8", "#AF52DE", "#7B61FF"];
const BUBBLE_CHOICES: [&str; 12] = ["#2B5BD7", "#1F8FD6", "#0F8F86", "#2E9E4F", "#7A9A1F", "#B8860B", "#C96A10", "#C4472B", "#C2334F", "#B03A86", "#8640B8", "#5B48C9"];
const RINGTONES: [(&str, &str); 3] = [("neon", "Неон"), ("pulse", "Пульс"), ("none", "Без мелодии")];
const MUTE_CHOICES: [(&str, &str, Option<f64>); 4] = [("1h", "На 1 час", Some(3_600_000.0)), ("8h", "На 8 часов", Some(28_800_000.0)), ("2d", "На 2 дня", Some(172_800_000.0)), ("forever", "Навсегда", None)];
const MAX_CUSTOM_DAYS: f64 = 365.0;

/// The record kept on the device read back; anything missing or odd is the default (`parsePreferences`).
fn preferences(raw: &Value) -> Value {
    let parsed = match raw { Value::String(text) if !text.0.is_empty() => json::parse(&text.to_string_lossy()).ok(), _ => None };
    let (read, value) = (parsed.is_some(), parsed.unwrap_or(Value::Null));
    let field = |name: &str| if read { value.get(name) } else { None };
    let flag = |name: &str, otherwise: bool| Value::Bool(match field(name) { Some(Value::Bool(flag)) => *flag, _ => otherwise });
    let maybe = |name: &str| match field(name) { Some(Value::Bool(flag)) => Value::Bool(*flag), _ => Value::Null };
    let one_of = |name: &str, known: &[&str], otherwise: Value| match field(name).and_then(Value::as_str) { Some(text) if known.contains(&text.as_str()) => Value::str(&text), _ => otherwise };
    let clock = |name: &str, otherwise: &str| match field(name).and_then(Value::as_str) { Some(text) if clock_minutes(&text).is_some() => Value::str(&text), _ => Value::str(otherwise) };
    let color = |name: &str| stored_color(field(name)).map_or(Value::Null, |color| Value::str(&color));
    json::object(vec![
        ("textSize", one_of("textSize", &TEXT_SIZES.map(|size| size.0), Value::str("medium"))),
        ("sendTyping", flag("sendTyping", true)),
        ("animations", one_of("animations", &["on", "off"], Value::str("auto"))),
        // 0 (never), 1 (always) or a level between them, to two places.
        ("lowBattery", Value::Number(match field("lowBattery") { Some(Value::Number(level)) if *level >= 0.0 && *level <= 1.0 => js_round(level * 100.0) / 100.0, _ => 0.25 })),
        ("bubbleRadius", Value::Number(match field("bubbleRadius") { Some(Value::Number(radius)) if [8.0, 14.0, 20.0].contains(radius) => *radius, _ => 20.0 })),
        ("wallpaper", one_of("wallpaper", &WALLPAPERS.map(|paper| paper.0), Value::str("none"))),
        ("nightMode", one_of("nightMode", &["system", "off", "schedule", "auto"], Value::Null)),
        ("nightFrom", clock("nightFrom", "22:00")),
        ("nightTo", clock("nightTo", "07:00")),
        ("nightBrightness", Value::Number(match field("nightBrightness") { Some(Value::Number(level)) if *level > 0.0 && *level < 1.0 => *level, _ => 0.25 })),
        ("nightForced", maybe("nightForced")), ("nightForcedAt", maybe("nightForcedAt")),
        ("autoplayVideo", flag("autoplayVideo", true)), ("autoplayGif", flag("autoplayGif", true)), ("animatedStickers", flag("animatedStickers", true)), ("animatedEmoji", flag("animatedEmoji", true)),
        ("pixelTrail", flag("pixelTrail", true)), ("snow", flag("snow", true)), ("ice", flag("ice", true)),
        ("accentColor", color("accentColor")), ("bubbleColor", color("bubbleColor")),
    ])
}

/// The notification switches kept on the device read back, and whether any differs from the default
/// (`parseNotificationPrefs`, `notificationPrefsChanged`).
fn notification_prefs(raw: &Value) -> Value {
    let parsed = match raw { Value::String(text) if !text.0.is_empty() => json::parse(&text.to_string_lossy()).ok(), _ => None };
    let value = match parsed { Some(value @ (Value::Object(_) | Value::Array(_))) => value, _ => Value::Null };
    let mut changed = false;
    let mut flag = |group: &str, name: &str, otherwise: bool| {
        let flag = match value.get(group).and_then(|group| group.get(name)) { Some(Value::Bool(flag)) => *flag, _ => otherwise };
        changed |= flag != otherwise;
        Value::Bool(flag)
    };
    let chats = json::object(vec![("show", flag("chats", "show", true)), ("sound", flag("chats", "sound", true)), ("vibration", flag("chats", "vibration", true)), ("preview", flag("chats", "preview", true))]);
    let communities = json::object(vec![("show", flag("communities", "show", true)), ("sound", flag("communities", "sound", true)), ("vibration", flag("communities", "vibration", true))]);
    let call_vibration = flag("calls", "vibration", true);
    let badge = json::object(vec![("enabled", flag("badge", "enabled", true)), ("countMuted", flag("badge", "countMuted", false))]);
    let ringtone = match value.get("calls").and_then(|calls| calls.get("ringtone")).and_then(Value::as_str) { Some(id) if RINGTONES.iter().any(|tone| tone.0 == id) => id, _ => "neon".to_string() };
    changed |= ringtone != "neon";
    json::object(vec![("chats", chats), ("communities", communities), ("calls", json::object(vec![("ringtone", Value::str(&ringtone)), ("vibration", call_vibration)])), ("badge", badge), ("changed", Value::Bool(changed))])
}

// ---- The sound of a chat (`notifications/model.ts`) ----

/// Russian plural forms (`plural.ts`).
fn plural(n: f64, forms: [&'static str; 3]) -> &'static str {
    let abs = n.trunc().abs();
    let (last, tens) = (abs % 10.0, abs % 100.0);
    if last == 1.0 && tens != 11.0 { forms[0] } else if (2.0..=4.0).contains(&last) && !(10.0..20.0).contains(&tens) { forms[1] } else { forms[2] }
}

/// «Настроить…»: when a hand-picked time ends (nothing: zero, or longer than a year) and how it reads.
fn custom_mute(duration: &Value, now: f64) -> Option<Value> {
    let part = |name: &str| match duration.get(name) { Some(Value::Number(count)) => Some(js_round(*count).max(0.0)), _ => None };
    let (days, hours, minutes) = (part("days")?, part("hours")?, part("minutes")?);
    let ms = days * 86_400_000.0 + hours * 3_600_000.0 + minutes * 60_000.0;
    let until = if ms <= 0.0 || ms > MAX_CUSTOM_DAYS * 86_400_000.0 { Value::Null } else { Value::str(&iso_from_ms((now + ms) as i64)) };
    let mut parts: Vec<String> = Vec::new();
    if days != 0.0 { parts.push(format!("{} {}", number_text(days), plural(days, ["день", "дня", "дней"]))) }
    if hours != 0.0 { parts.push(format!("{} {}", number_text(hours), plural(hours, ["час", "часа", "часов"]))) }
    if minutes != 0.0 { parts.push(format!("{} {}", number_text(minutes), plural(minutes, ["минута", "минуты", "минут"]))) }
    Some(json::object(vec![("until", until), ("label", Value::str(&parts.join(" ")))]))
}

fn truthy(value: Option<&Value>) -> bool {
    match value { None | Some(Value::Null) => false, Some(Value::Bool(flag)) => *flag, Some(Value::Number(number)) => *number != 0.0 && !number.is_nan(), Some(Value::String(text)) => !text.0.is_empty(), Some(_) => true }
}

const MONTHS: [&str; 12] = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

/// The wall clock of a moment already moved to the local zone: (day number, year, month from 0, day, «HH:MM»).
fn wall_clock(local_ms: f64) -> (i64, i64, usize, i64, String) {
    let ms = local_ms.floor() as i64;
    let written = iso_from_ms(ms);
    let number = |from: usize, to: usize| written[from..to].parse::<i64>().unwrap_or(0);
    (ms.div_euclid(86_400_000), number(0, 4), (number(5, 7) - 1).clamp(0, 11) as usize, number(8, 10), written[11..16].to_string())
}

/// The sound of a chat: whether it is off now, and how the end of the silence reads on the local clock
/// (`isMuted`, `muteEndLabel`, `muteUntilLabel`, `mutedStatusText`). The offsets are minutes east of UTC at
/// «now» and at the end.
fn mute_state(settings: &Value, now: f64, offset_now: f64, offset_end: f64) -> Value {
    let until = match settings.get("mutedUntil") { Some(Value::String(text)) if !text.0.is_empty() => Some(text.to_string_lossy()), _ => None };
    let at = until.as_deref().and_then(parse_iso_ms);
    // An expired mute is over even before the list is refreshed; a time that cannot be read never ends.
    let muted = truthy(settings.get("muted")) && (until.is_none() || at.map_or(true, |at| at > now));
    let end = at.map_or(String::new(), |at| {
        let (end_day, end_year, month, day, time) = wall_clock(at + offset_end * 60_000.0);
        let (today, this_year, ..) = wall_clock(now + offset_now * 60_000.0);
        if end_day == today { time } else if end_day == today + 1 { format!("завтра, {time}") }
        else { format!("{day} {}{}, {time}", MONTHS[month], if end_year == this_year { String::new() } else { format!(" {end_year}") }) }
    });
    let label = if end.is_empty() { "навсегда".to_string() } else { format!("до {end}") };
    let status = if !muted { String::new() } else if until.is_some() { format!("Звук выключен {label}") } else { "Звук выключен".to_string() };
    json::object(vec![("muted", Value::Bool(muted)), ("end", Value::str(&end)), ("until", Value::str(&label)), ("status", Value::str(&status))])
}

// ---- Sizes (`theme.tsx` `formatSize`, `SettingsScreen.tsx` `storageLabel`) ----

/// `Number.prototype.toFixed` for the sizes here (not negative, below 10²¹): the exact value, halves up.
fn to_fixed(x: f64, places: usize) -> String {
    let exact = format!("{x:.120}");
    let (whole, fraction) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut kept: Vec<u8> = whole.bytes().chain(fraction.bytes().take(places)).collect();
    if fraction.as_bytes().get(places).is_some_and(|next| *next >= b'5') {
        let mut at = kept.len();
        loop {
            if at == 0 { kept.insert(0, b'1'); break }
            at -= 1;
            if kept[at] == b'9' { kept[at] = b'0' } else { kept[at] += 1; break }
        }
    }
    let text = String::from_utf8(kept).unwrap_or_default();
    if places == 0 { text } else { let cut = text.len() - places; format!("{}.{}", &text[..cut], &text[cut..]) }
}

const KB: f64 = 1024.0;
const GB: f64 = 1_073_741_824.0;

fn format_size(bytes: f64) -> String {
    if bytes < KB { format!("{} Б", number_text(bytes)) }
    else if bytes < KB * KB { format!("{} КБ", to_fixed(bytes / KB, 0)) }
    else if bytes >= GB { format!("{} ГБ", to_fixed(bytes / GB, 1)) }
    else { format!("{} МБ", to_fixed(bytes / KB / KB, 1)) }
}

/// The account's storage: whole gigabytes from ten on, one place below, no «.0».
fn storage_label(bytes: f64) -> String {
    if bytes >= GB { format!("{} ГБ", to_fixed(bytes / GB, if bytes >= 10.0 * GB { 0 } else { 1 }).replacen(".0", "", 1)) } else { format_size(bytes) }
}

// ---- By name, for the apps (`invizent_view`) ----

fn rules() -> Value {
    let s = Value::str;
    let list = |items: &[&str]| Value::Array(items.iter().map(|item| s(item)).collect());
    let mut names = vec![("system", s("Как в системе")), ("light", s("Светлая")), ("dark", s("Тёмная")), ("black", s("Чёрная")), ("graphite", s("Графит"))];
    names.extend(PALETTES.iter().map(|palette| (palette.0, s(palette.1))));
    let appearance = |value: &str, label: &str, color: &str, line: &str| json::object(vec![("value", s(value)), ("label", s(label)), ("color", s(color)), ("line", s(line))]);
    json::object(vec![
        ("themeNames", json::object(names)),
        ("appearances", Value::Array(vec![appearance("light", "Светлая", "#EDF3FB", "#CEDAF0"), appearance("dark", "Тёмная", "#080F1E", "#31415B"),
            appearance("black", "Чёрная", "#08090A", "#23252A"), appearance("graphite", "Графит", "#1C1C1E", "#3A3A3C")])),
        ("palettes", Value::Array(PALETTES.iter().map(|palette| json::object(vec![("id", s(palette.0)), ("name", s(palette.1))])).collect())),
        ("nightModes", list(&["system", "off", "schedule", "auto"])),
        ("nightLabels", json::object(vec![("system", s("Системная")), ("off", s("Выключена")), ("schedule", s("По расписанию")), ("auto", s("Автоматически"))])),
        ("nightThemes", list(&["dark", "black", "graphite"])),
        ("textSizes", Value::Array(TEXT_SIZES.iter().map(|size| json::object(vec![("id", s(size.0)), ("label", s(size.1)), ("fontSize", Value::Number(size.2)), ("lineHeight", Value::Number(size.3))])).collect())),
        ("wallpapers", Value::Array(WALLPAPERS.iter().map(|paper| json::object(vec![("id", s(paper.0)), ("label", s(paper.1)), ("colors", if paper.2.is_empty() { Value::Null } else { list(paper.2) })])).collect())),
        ("accentChoices", list(&ACCENT_CHOICES)),
        ("bubbleChoices", list(&BUBBLE_CHOICES)),
        ("ringtones", Value::Array(RINGTONES.iter().map(|tone| json::object(vec![("id", s(tone.0)), ("label", s(tone.1))])).collect())),
        ("muteChoices", Value::Array(MUTE_CHOICES.iter().map(|choice| json::object(vec![("id", s(choice.0)), ("label", s(choice.1)), ("ms", choice.2.map_or(Value::Null, Value::Number))])).collect())),
        ("maxCustomDays", Value::Number(MAX_CUSTOM_DAYS)),
    ])
}

/// The functions above by name; `args` are the JSON arguments. `None`: an unknown name or arguments of the wrong
/// kind.
/// - `settingsRules []` → the lists the pages show: `{themeNames, appearances, palettes, nightModes, nightLabels,
///   nightThemes, textSizes, wallpapers, accentChoices, bubbleChoices, ringtones, muteChoices, maxCustomDays}`.
/// - `settingsTheme [id, accentColor|null, bubbleColor|null]` → the theme's colours as the reference's `Theme`
///   (`#RRGGBB`, `rgba(r,g,b,a)` or `transparent`) with the person's own colours laid over, and `ink: {meta, accent}`
///   for the service text on their own bubble. No answer for an unknown id.
/// - `settingsHsvColor [h, s, v]` → `#RRGGBB` (s and v in 0…1); `settingsColorHsv [#RRGGBB]` → `{h, s, v}`.
/// - `settingsStoredTheme [mode, darkTheme]` → `{mode, darkTheme}` as they are read back from the device.
/// - `settingsWithPlatina [themeId, platina]` → the theme shown (a palette without Platina is «dark»).
/// - `settingsPreferences [text|null]` → the appearance and chat preferences kept on the device, read back.
/// - `settingsNotificationPrefs [text|null]` → `{chats, communities, calls, badge, changed}`.
/// - `settingsNight [{mode, from, to, brightness, forced, forcedAt}, themeMode, darkTheme, system|null,
///   minuteOfDay, screenBrightness|null]` → `{kind, auto, known, expired, night, shown, day}`: the rule in effect,
///   what it says alone, whether it has its input, whether the manual switch has run out (the app then forgets
///   it), whether the night theme is on, the theme to show and the day theme behind it.
/// - `settingsThemeTap [themeId, night]` → `{mode?, darkTheme?, nightOff}`: what a tap on a theme card changes.
/// - `settingsMuteUntil [choice, nowMs]` → the end as the server takes it, or null for «Навсегда».
/// - `settingsCustomMute [{days, hours, minutes}, nowMs]` → `{until|null, label}`.
/// - `settingsMuteState [chatSettings|null, nowMs, offsetNowMin, offsetEndMin]` → `{muted, end, until, status}`.
/// - `settingsSize [bytes]` → `{size, storage}`: «1.3 МБ» and the account's storage «20 ГБ».
pub fn view(name: &str, args: &[Value]) -> Option<Value> {
    let color = |value: &Value| stored_color(Some(value));
    let optional_number = |value: &Value| match value { Value::Number(number) => Some(Some(*number)), Value::Null => Some(None), _ => None };
    Some(match (name, args) {
        ("settingsRules", []) => rules(),
        ("settingsTheme", [Value::String(id), accent, bubble]) => theme_value(&custom_theme(theme_by_id(&id.to_string_lossy())?, color(accent), color(bubble))),
        ("settingsHsvColor", [Value::Number(h), Value::Number(s), Value::Number(v)]) => Value::str(&hsv_color(*h, *s, *v)),
        ("settingsColorHsv", [Value::String(color)]) => color_hsv(&color.to_string_lossy())?,
        ("settingsStoredTheme", [mode, dark]) => json::object(vec![("mode", Value::str(&stored_theme_mode(mode))), ("darkTheme", Value::str(&stored_dark_theme(dark)))]),
        ("settingsWithPlatina", [Value::String(id), Value::Bool(platina)]) => { let id = id.to_string_lossy(); Value::str(if !platina && is_palette(&id) { "dark" } else { &id }) }
        ("settingsPreferences", [raw]) => preferences(raw),
        ("settingsNotificationPrefs", [raw]) => notification_prefs(raw),
        ("settingsNight", [settings @ Value::Object(_), Value::String(mode), Value::String(dark), system, Value::Number(minute), brightness]) => {
            let system = match system { Value::String(system) => Some(system.to_string_lossy()), Value::Null => None, _ => return None };
            night(settings, &mode.to_string_lossy(), &dark.to_string_lossy(), system.as_deref(), *minute, optional_number(brightness)?)?
        }
        ("settingsThemeTap", [Value::String(id), Value::Bool(night)]) => {
            let id = id.to_string_lossy();
            let is_dark = id != "system" && id != "light";
            if *night && is_dark { json::object(vec![("darkTheme", Value::str(&id)), ("nightOff", Value::Bool(false))]) } else { json::object(vec![("mode", Value::str(&id)), ("nightOff", Value::Bool(*night))]) }
        }
        ("settingsMuteUntil", [Value::String(choice), Value::Number(now)]) => {
            let choice = choice.to_string_lossy();
            MUTE_CHOICES.iter().find(|item| item.0 == choice).and_then(|item| item.2).map_or(Value::Null, |ms| Value::str(&iso_from_ms((now + ms) as i64)))
        }
        ("settingsCustomMute", [duration @ Value::Object(_), Value::Number(now)]) => custom_mute(duration, *now)?,
        ("settingsMuteState", [settings, Value::Number(now), Value::Number(offset_now), Value::Number(offset_end)]) => mute_state(settings, *now, *offset_now, *offset_end),
        ("settingsSize", [Value::Number(bytes)]) if *bytes >= 0.0 => json::object(vec![("size", Value::str(&format_size(*bytes))), ("storage", Value::str(&storage_label(*bytes)))]),
        _ => return None,
    })
}
