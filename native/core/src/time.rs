//! Dates as the server and the apps write them.

/// Milliseconds since 1970 for an ISO 8601 date-time: `2026-11-21T07:00:00.000Z`, with or without the
/// fraction and the seconds, with `Z` or an offset like `+03:00`; a date alone is midnight UTC.
/// The reference's `Date.parse` also reads other spellings («Nov 21 2026»); those are refused here on purpose —
/// the apps only ever write the ISO form, and a narrower reading cannot let anything through that the
/// reference would have refused.
pub fn parse_iso_ms(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    let number = |from: usize, len: usize| -> Option<i64> {
        let part = bytes.get(from..from + len)?;
        if !part.iter().all(u8::is_ascii_digit) { return None }
        std::str::from_utf8(part).ok()?.parse().ok()
    };
    let (year, month, day) = (number(0, 4)?, number(5, 2)?, number(8, 2)?);
    if bytes.get(4) != Some(&b'-') || bytes.get(7) != Some(&b'-') || !(1..=12).contains(&month) { return None }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let month_days = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][(month - 1) as usize];
    if !(1..=month_days).contains(&day) { return None }
    // Days since 1970-01-01 (the civil-from-days rule, run backwards).
    let (y, m) = if month <= 2 { (year - 1, month + 9) } else { (year, month - 3) };
    let era = y.div_euclid(400);
    let year_of_era = y.rem_euclid(400);
    let day_of_year = (153 * m + 2) / 5 + day - 1;
    let days = era * 146_097 + year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year - 719_468;
    if bytes.len() == 10 { return Some(days as f64 * 86_400_000.0) }
    if bytes.get(10) != Some(&b'T') { return None }
    let (hour, minute) = (number(11, 2)?, number(14, 2)?);
    if bytes.get(13) != Some(&b':') || hour > 24 || minute > 59 { return None }
    let mut at = 16;
    let mut second = 0;
    let mut millis = 0.0;
    if bytes.get(at) == Some(&b':') {
        second = number(at + 1, 2)?;
        if second > 59 { return None }
        at += 3;
        if bytes.get(at) == Some(&b'.') {
            let start = at + 1;
            let mut end = start;
            while bytes.get(end).is_some_and(u8::is_ascii_digit) { end += 1 }
            if end == start { return None }
            let digits = &text[start..end.min(start + 3)];
            millis = digits.parse::<f64>().ok()? * 10f64.powi(3 - digits.len() as i32);
            at = end;
        }
    }
    if hour == 24 && (minute != 0 || second != 0 || millis != 0.0) { return None }
    let offset_minutes = match bytes.get(at) {
        Some(b'Z') if at + 1 == bytes.len() => 0,
        Some(sign @ (b'+' | b'-')) if at + 6 == bytes.len() && bytes.get(at + 3) == Some(&b':') => {
            let (hours, minutes) = (number(at + 1, 2)?, number(at + 4, 2)?);
            if hours > 23 || minutes > 59 { return None }
            (hours * 60 + minutes) * if *sign == b'+' { 1 } else { -1 }
        }
        // Without a zone a date-time is local time in JavaScript: not a form the apps write.
        _ => return None,
    };
    Some((days * 86_400 + hour * 3600 + minute * 60 + second - offset_minutes * 60) as f64 * 1000.0 + millis)
}

#[cfg(test)]
mod tests {
    use super::parse_iso_ms;

    #[test]
    fn reads_what_the_apps_write() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.000Z"), Some(0.0));
        assert_eq!(parse_iso_ms("2026-11-21T07:00:00.000Z"), Some(1_795_244_400_000.0));
        assert_eq!(parse_iso_ms("2026-11-21T10:00:00+03:00"), Some(1_795_244_400_000.0));
        assert_eq!(parse_iso_ms("2026-11-21T07:00Z"), Some(1_795_244_400_000.0));
        assert_eq!(parse_iso_ms("2026-11-21T07:00:00.5Z"), Some(1_795_244_400_500.0));
        assert_eq!(parse_iso_ms("2024-02-29"), Some(1_709_164_800_000.0));
        for bad in ["", "не дата", "2026-13-01T00:00:00Z", "2025-02-29", "2026-11-21 07:00:00Z", "2026-11-21T07:00:00", "2026-11-21T25:00:00Z", "Nov 21 2026"] { assert_eq!(parse_iso_ms(bad), None, "{bad:?}") }
    }
}

/// The time as the apps write it: `2026-11-21T07:00:00.000Z`, from milliseconds since 1970.
pub fn iso_from_ms(ms: i64) -> String {
    let (days, in_day) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    // The civil-from-days rule.
    let z = days + 719_468;
    let (era, day_of_era) = (z.div_euclid(146_097), z.rem_euclid(146_097));
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let m = (5 * day_of_year + 2) / 153;
    let (day, month) = (day_of_year - (153 * m + 2) / 5 + 1, if m < 10 { m + 3 } else { m - 9 });
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", in_day / 3_600_000, in_day / 60_000 % 60, in_day / 1000 % 60, in_day % 1000)
}

#[cfg(test)]
mod written {
    use super::*;
    #[test]
    fn times_are_written_as_they_are_read() {
        assert_eq!(iso_from_ms(1_795_244_400_000), "2026-11-21T07:00:00.000Z");
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(1_709_164_800_123), "2024-02-29T00:00:00.123Z");
        let mut ms = 946_684_799_999i64; // across a century's end, leap days, month ends
        while ms < 4_200_000_000_000 { assert_eq!(parse_iso_ms(&iso_from_ms(ms)), Some(ms as f64), "{ms}"); ms += 86_400_000 * 13 + 3_723_457; }
    }
}
