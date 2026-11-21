//! The rules of stories and profile posts against the reference's own answers (`mobile/src/stories/seenPosts.ts`,
//! `stories/StoriesStrip.tsx`, `ProfilePosts.tsx`, `media/swipeMath.ts`, `theme.tsx`, `SettingsScreen.tsx`,
//! `server/src/posts.js`; vectors from `tests/generate-stories-vectors.mjs`).
//!
//! Every line of the vectors is `JSON.stringify`'s text: `{"name", "args", "want"}`. Each is first read and written
//! back and must come out the same text; then the core is asked by that name with those arguments, as the apps
//! ask it, and its answer is compared with the reference's as JSON text, to the character. Where the reference
//! has no answer the vectors say null, and so must the core (no answer at all, or null).
use invizent_core::json::{self, Value};
use invizent_core::stories;
use std::collections::BTreeMap;

fn cases() -> Vec<Value> {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/stories.json")).expect("vectors");
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
fn stories_answer_as_the_reference_does() {
    let cases = cases();
    let (mut wrong, mut counts): (Vec<String>, BTreeMap<String, usize>) = (Vec::new(), BTreeMap::new());
    for (index, case) in cases.iter().enumerate() {
        let name = case.get("name").and_then(Value::as_str).expect("a name");
        let Some(Value::Array(args)) = case.get("args") else { panic!("case {index}: no arguments") };
        let want = json::stringify(case.get("want").expect("an answer"));
        let got = stories::view(&name, args).map_or_else(|| "null".to_string(), |answer| json::stringify(&answer));
        if want != got && wrong.len() < 6 { wrong.push(format!("case {index} {name} {}\n  want {}\n  got  {}", json::stringify(&Value::Array(args.clone())).chars().take(700).collect::<String>(), want.chars().take(900).collect::<String>(), got.chars().take(900).collect::<String>())) }
        if want != got { *counts.entry(format!("WRONG {name}")).or_default() += 1 }
        *counts.entry(name).or_default() += 1;
    }
    assert!(wrong.is_empty(), "{:?}\n{}", counts.iter().filter(|(name, _)| name.starts_with("WRONG")).collect::<Vec<_>>(), wrong.join("\n"));
    for (name, least) in [("storiesRules", 1), ("storiesSeenParse", 300), ("storiesSeenAdd", 400), ("storiesStrip", 250), ("storiesViewer", 750), ("storiesViewed", 250),
        ("storiesHeadline", 1200), ("storiesAxis", 600), ("storiesSwipe", 3000), ("storiesDrag", 1500), ("storiesViews", 10), ("storiesViewedAt", 1800),
        ("storiesCaption", 500), ("storiesUpload", 800), ("storiesTabs", 24), ("storiesEmpty", 5), ("storiesAudience", 7)] {
        assert!(counts.get(name).copied().unwrap_or(0) >= least, "{name}: {:?} cases", counts.get(name));
    }
}

#[test]
fn the_vectors_are_not_all_one_answer() {
    // A rule that always answered the same would pass a test whose vectors happen to be one-sided.
    let cases = cases();
    let want = |case: &Value, key: &str| case.get("want").and_then(|want| want.get(key)).cloned();
    let flag = |case: &Value, key: &str| want(case, key) == Some(Value::Bool(true));
    for action in ["next", "previous", "close", "up", "cancel"] {
        let count = named(&cases, "storiesSwipe").filter(|case| case.get("want") == Some(&Value::str(action))).count();
        assert!(count >= 150, "storiesSwipe {action}: {count}");
    }
    for axis in ["x", "y"] {
        let count = named(&cases, "storiesAxis").filter(|case| case.get("want") == Some(&Value::str(axis))).count();
        assert!(count >= 150, "storiesAxis {axis}: {count}");
    }
    for key in ["open", "own", "posts"] {
        let yes = named(&cases, "storiesViewer").filter(|case| flag(case, key)).count();
        assert!(yes >= 60 && named(&cases, "storiesViewer").count() - yes >= 60, "storiesViewer {key}: {yes}");
    }
    let later = named(&cases, "storiesViewer").filter(|case| matches!(want(case, "start"), Some(Value::Number(start)) if start > 0.0)).count();
    assert!(later >= 100, "{later} viewers start past the first story");
    for key in ["before", "after"] {
        let some = named(&cases, "storiesViewer").filter(|case| matches!(want(case, key), Some(Value::String(_)))).count();
        assert!(some >= 150 && named(&cases, "storiesViewer").count() - some >= 100, "storiesViewer {key}: {some}");
    }
    // The strip is not the feed's own order: in most feeds of several people somebody moves.
    let moved = named(&cases, "storiesStrip").filter(|case| {
        let Some(Value::Array(args)) = case.get("args") else { return false };
        let Some(Value::Array(items)) = args[0].get("items") else { return false };
        let given: Vec<Option<Value>> = items.iter().map(|item| item.get("user").and_then(|user| user.get("id")).cloned()).collect();
        let Some(Value::Array(people)) = want(case, "people") else { return false };
        let shown: Vec<Option<Value>> = people.iter().map(|person| person.get("id").cloned()).collect();
        given != shown
    }).count();
    assert!(moved >= 120, "{moved} strips are reordered");
    for (key, least) in [("fresh", 300), ("post", 150), ("pending", 80)] {
        let count: usize = named(&cases, "storiesStrip").map(|case| match want(case, "people") { Some(Value::Array(people)) => people.iter().filter(|person| person.get(key) == Some(&Value::Bool(true))).count(), _ => 0 }).sum();
        assert!(count >= least, "{key}: {count} people");
    }
    let changed = named(&cases, "storiesViewed").filter(|case| case.get("want") != Some(&Value::Null)).count();
    assert!(changed >= 50 && named(&cases, "storiesViewed").count() - changed >= 50, "{changed} feeds changed by a view");
    for start in ["только что", "1 ч назад", "NaN ч назад"] {
        let count = named(&cases, "storiesHeadline").filter(|case| case.get("want") == Some(&Value::str(start))).count();
        assert!(count >= 20, "«{start}»: {count}");
    }
    let of = named(&cases, "storiesHeadline").filter(|case| case.get("want").and_then(Value::as_str).is_some_and(|text| text.contains(" из "))).count();
    assert!(of >= 250, "{of} «N из M»");
    for (name, test) in [("clock", (|text: &str| text.len() == 5 && text.as_bytes()[2] == b':') as fn(&str) -> bool), ("вчера", |text: &str| text == "вчера"), ("date", |text: &str| text.contains(' '))] {
        let count = named(&cases, "storiesViewedAt").filter(|case| case.get("want").and_then(Value::as_str).is_some_and(|text| test(&text))).count();
        assert!(count >= 300, "storiesViewedAt {name}: {count}");
    }
    let refused = named(&cases, "storiesCaption").filter(|case| want(case, "error") != Some(Value::str(""))).count();
    assert!(refused >= 80 && named(&cases, "storiesCaption").count() - refused >= 200, "{refused} captions refused");
    let trimmed = named(&cases, "storiesCaption").filter(|case| { let Some(Value::Array(args)) = case.get("args") else { return false }; want(case, "caption").as_ref() != args.first() }).count();
    assert!(trimmed >= 200, "{trimmed} captions trimmed");
    let too_long = named(&cases, "storiesUpload").filter(|case| want(case, "error") != Some(Value::str(""))).count();
    let chunked = named(&cases, "storiesUpload").filter(|case| flag(case, "chunked")).count();
    let resized = named(&cases, "storiesUpload").filter(|case| matches!(want(case, "resizeWidth"), Some(Value::Number(_)))).count();
    assert!(too_long >= 60 && chunked >= 40 && resized >= 80, "{too_long} too long, {chunked} chunked, {resized} resized");
    let kept = named(&cases, "storiesSeenAdd").filter(|case| { let Some(Value::Array(args)) = case.get("args") else { return false }; case.get("want") == args.first() }).count();
    assert!(kept >= 40 && named(&cases, "storiesSeenAdd").count() - kept >= 200, "{kept} lists kept as they were");
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
    assert_eq!(ask("storiesSwipe", r#"["x",-200,0,0,0,390]"#).as_deref(), Some("\"next\""));
    assert_eq!(ask("storiesHeadline", r#"["2026-11-21T07:00:00.000Z",1795262400000,true,0,1]"#).as_deref(), Some("\"5 ч назад\""));
    assert_eq!(ask("storiesTabs", "[3,0]").as_deref(), Some(r#"["Публикации 3","Истории"]"#));
    assert!(ask("storiesRules", "[]").is_some_and(|text| text.starts_with(r#"{"photoMs":5000,"#)));
    // A feed that is not one, an unknown axis, an unknown name: no answer.
    assert_eq!(ask("storiesStrip", r#"[{"items":[{"user":{"id":7}}],"mine":[]},[],"me"]"#), None);
    assert_eq!(ask("storiesStrip", r#"[{"items":[]},[],"me"]"#), None);
    assert_eq!(ask("storiesSwipe", r#"["z",0,0,0,0,390]"#), None);
    assert_eq!(ask("storiesNothing", "[]"), None);
    // The other names still answer behind these.
    assert!(ask("settingsRules", "[]").is_some());
    assert!(ask("callRules", "[]").is_some());
}
