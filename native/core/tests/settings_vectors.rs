//! The rules behind the settings pages against the reference's own answers (`mobile/src/theme.tsx`,
//! `themes/palettes.ts`, `themes/custom.ts`, `themePreference.ts`, `chatPreferences.ts`, `notifications/model.ts`;
//! vectors from `tests/generate-settings-vectors.mjs`).
//!
//! Every line of the vectors is `JSON.stringify`'s text: `{"name", "args", "want"}`. Each is first read and written
//! back and must come out the same text; then the core is asked by that name with those arguments, as the apps
//! ask it, and its answer is compared with the reference's as JSON text, to the character. Where the reference
//! has no answer the vectors say null, and so must the core (no answer at all).
use invizent_core::json::{self, Value};
use invizent_core::settings;
use std::collections::BTreeMap;

fn cases() -> Vec<Value> {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/settings.json")).expect("vectors");
    text.lines().map(|line| {
        let case = json::parse(line).expect("a JSON line");
        assert_eq!(json::stringify(&case), line, "the line is not read and written back as it is");
        case
    }).collect()
}

fn named<'a>(cases: &'a [Value], name: &'a str) -> impl Iterator<Item = &'a Value> + 'a {
    cases.iter().filter(move |case| case.get("name") == Some(&Value::str(name)))
}

#[test]
fn settings_answer_as_the_reference_does() {
    let cases = cases();
    let (mut wrong, mut counts): (Vec<String>, BTreeMap<String, usize>) = (Vec::new(), BTreeMap::new());
    for (index, case) in cases.iter().enumerate() {
        let name = case.get("name").and_then(Value::as_str).expect("a name");
        let Some(Value::Array(args)) = case.get("args") else { panic!("case {index}: no arguments") };
        let want = json::stringify(case.get("want").expect("an answer"));
        let got = settings::view(&name, args).map_or_else(|| "null".to_string(), |answer| json::stringify(&answer));
        if want != got && wrong.len() < 6 { wrong.push(format!("case {index} {name} {}\n  want {}\n  got  {}", json::stringify(&Value::Array(args.clone())).chars().take(500).collect::<String>(), want.chars().take(900).collect::<String>(), got.chars().take(900).collect::<String>())) }
        if want != got { *counts.entry(format!("WRONG {name}")).or_default() += 1 }
        *counts.entry(name).or_default() += 1;
    }
    assert!(wrong.is_empty(), "{:?}\n{}", counts.iter().filter(|(name, _)| name.starts_with("WRONG")).collect::<Vec<_>>(), wrong.join("\n"));
    for (name, least) in [("settingsRules", 1), ("settingsTheme", 3000), ("settingsHsvColor", 700), ("settingsColorHsv", 700), ("settingsStoredTheme", 14), ("settingsWithPlatina", 24),
        ("settingsPreferences", 900), ("settingsNotificationPrefs", 700), ("settingsNight", 6000), ("settingsThemeTap", 28), ("settingsMuteUntil", 160), ("settingsCustomMute", 900),
        ("settingsMuteState", 4000), ("settingsSize", 6000)] {
        assert!(counts.get(name).copied().unwrap_or(0) >= least, "{name}: {:?} cases", counts.get(name));
    }
}

#[test]
fn the_vectors_are_not_all_one_answer() {
    // A rule that always answered the same would pass a test whose vectors happen to be one-sided.
    let cases = cases();
    let flag = |case: &Value, key: &str| case.get("want").and_then(|want| want.get(key)) == Some(&Value::Bool(true));
    for key in ["auto", "known", "expired", "night"] {
        let yes = named(&cases, "settingsNight").filter(|case| flag(case, key)).count();
        let no = named(&cases, "settingsNight").count() - yes;
        assert!(yes >= 200 && no >= 200, "settingsNight {key}: {yes} yes, {no} no");
    }
    for kind in ["system", "off", "schedule", "auto"] {
        let count = named(&cases, "settingsNight").filter(|case| case.get("want").and_then(|want| want.get("kind")) == Some(&Value::str(kind))).count();
        assert!(count >= 500, "settingsNight {kind}: {count}");
    }
    let muted = named(&cases, "settingsMuteState").filter(|case| flag(case, "muted")).count();
    assert!(muted >= 800 && named(&cases, "settingsMuteState").count() - muted >= 800, "{muted} muted");
    for start in ["до завтра, ", "навсегда", "до 2", "до 1"] {
        let count = named(&cases, "settingsMuteState").filter(|case| case.get("want").and_then(|want| want.get("until")).and_then(Value::as_str).is_some_and(|text| text.starts_with(start))).count();
        assert!(count >= 100, "«{start}»: {count}");
    }
    let next_year = named(&cases, "settingsMuteState").filter(|case| case.get("want").and_then(|want| want.get("end")).and_then(Value::as_str).is_some_and(|text| text.contains(" 2027, ") || text.contains(" 2026, ") || text.contains(" 2028, "))).count();
    assert!(next_year >= 100, "{next_year} ends in another year");
    let changed = named(&cases, "settingsNotificationPrefs").filter(|case| flag(case, "changed")).count();
    assert!(changed >= 300 && named(&cases, "settingsNotificationPrefs").count() - changed >= 5, "{changed} changed");
    let refused = named(&cases, "settingsCustomMute").filter(|case| case.get("want").and_then(|want| want.get("until")) == Some(&Value::Null)).count();
    assert!(refused >= 20 && named(&cases, "settingsCustomMute").count() - refused >= 500, "{refused} refused");
    // The person's colours do move: the accent or the bubble differs from the theme's own in most cases with a colour.
    let moved = named(&cases, "settingsTheme").filter(|case| {
        let Some(Value::Array(args)) = case.get("args") else { return false };
        let shown = case.get("want").and_then(|want| want.get("accent")).and_then(Value::as_str);
        matches!(&args[1], Value::String(_)) && shown.is_some() && shown != args[1].as_str()
    }).count();
    assert!(moved >= 300, "{moved} accents moved to stay readable");
    for unit in [" Б", " КБ", " МБ", " ГБ"] {
        let count = named(&cases, "settingsSize").filter(|case| case.get("want").and_then(|want| want.get("size")).and_then(Value::as_str).is_some_and(|text| text.ends_with(unit))).count();
        assert!(count >= 50, "{unit}: {count}");
    }
}

#[test]
fn the_apps_reach_the_rules_by_name() {
    // The same door the apps use (`invizent_view`).
    use std::ffi::{CStr, CString};
    let ask = |name: &str, args: &str| -> Option<String> {
        let (name, args) = (CString::new(name).unwrap(), CString::new(args).unwrap());
        let answer = unsafe { invizent_core::ffi::invizent_view(name.as_ptr(), args.as_ptr()) };
        if answer.is_null() { return None }
        let text = unsafe { CStr::from_ptr(answer) }.to_str().unwrap().to_string();
        unsafe { invizent_core::ffi::invizent_string_free(answer) };
        Some(text)
    };
    assert_eq!(ask("settingsWithPlatina", r#"["neon",false]"#).as_deref(), Some("\"dark\""));
    assert_eq!(ask("settingsSize", "[1310720]").as_deref(), Some(r#"{"size":"1.3 МБ","storage":"1.3 МБ"}"#));
    assert!(ask("settingsTheme", r#"["black",null,null]"#).is_some_and(|text| text.starts_with(r##"{"dark":true,"black":true,"bg":"#08090A""##)));
    assert_eq!(ask("settingsTheme", r#"["rose",null,null]"#), None);
    assert_eq!(ask("settingsNothing", "[]"), None);
    // The calls' names still answer behind the settings'.
    assert!(ask("callRules", "[]").is_some());
}
