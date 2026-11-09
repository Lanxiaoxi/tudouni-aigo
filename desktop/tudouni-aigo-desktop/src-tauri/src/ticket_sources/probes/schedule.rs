//! `schedule`: one item whose version is the id of the current period, so the
//! engine's ordinary "version changed" diff fires once per period.
//!
//! No date library and no time-zone database: the front end sends its
//! `getTimezoneOffset()`, and the calendar arithmetic below is the
//! proleptic-Gregorian day-count algorithm (Howard Hinnant's `civil_from_days`)
//! plus the ISO 8601 week rule.

use super::{opt_int, opt_str, req_str, Item, ProbeCtx, ProbeOutput};
use serde_json::{json, Map, Value};

const MS_PER_MINUTE: i64 = 60_000;
const MS_PER_HOUR: i64 = 3_600_000;
const MS_PER_DAY: i64 = 86_400_000;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Every {
    Hourly,
    Daily,
    Weekly,
    Monthly,
}

#[derive(Debug, Clone, Copy)]
struct Schedule {
    every: Every,
    /// Minutes after midnight at which a period starts.
    at_minutes: i64,
    /// 1 = Monday … 7 = Sunday.
    weekday: i64,
}

pub(super) fn run(_kind: &str, probe: &Map<String, Value>, ctx: &ProbeCtx) -> Result<ProbeOutput, String> {
    let schedule = parse(probe)?;
    // `tz_offset_minutes` is what must be *added* to local time to get UTC, so
    // local time is now minus it (UTC+8 is -480, which adds eight hours).
    let local_ms = ctx.now_ms - ctx.tz_offset_minutes * MS_PER_MINUTE;
    let period = period_id(&schedule, local_ms);
    Ok(ProbeOutput {
        items: vec![Item { key: "schedule".to_string(), version: period.clone(), fields: json!({ "period": period }) }],
        warnings: Vec::new(),
    })
}

pub(super) fn validate(_kind: &str, probe: &Map<String, Value>) -> Result<(), String> {
    parse(probe).map(|_| ())
}

fn parse(probe: &Map<String, Value>) -> Result<Schedule, String> {
    let every = match req_str(probe, "every")? {
        "hourly" => Every::Hourly,
        "daily" => Every::Daily,
        "weekly" => Every::Weekly,
        "monthly" => Every::Monthly,
        other => return Err(format!("probe parameter \"every\" must be hourly, daily, weekly or monthly, got {other:?}")),
    };
    let at_minutes = match opt_str(probe, "at")? {
        Some(text) => parse_at(text)?,
        None => 0,
    };
    let weekday = opt_int(probe, "weekday", 1, 7)?.unwrap_or(1);
    Ok(Schedule { every, at_minutes, weekday })
}

/// `HH:MM`, strictly two digits each, as minutes after midnight.
fn parse_at(text: &str) -> Result<i64, String> {
    let bad = || format!("probe parameter \"at\" must look like HH:MM (00:00 to 23:59), got {text:?}");
    let b = text.as_bytes();
    if b.len() != 5 || b[2] != b':' || ![0, 1, 3, 4].iter().all(|&i| b[i].is_ascii_digit()) {
        return Err(bad());
    }
    let hours = i64::from((b[0] - b'0') * 10 + (b[1] - b'0'));
    let minutes = i64::from((b[3] - b'0') * 10 + (b[4] - b'0'));
    if hours > 23 || minutes > 59 {
        return Err(bad());
    }
    Ok(hours * 60 + minutes)
}

/// The id of the period containing `local_ms` (local wall-clock milliseconds
/// since the epoch).
///
/// A period that "starts at 09:00" is the same as shifting the clock back by
/// 09:00 and asking which calendar day it is in: at 08:59 the shifted clock is
/// still yesterday. The same trick moves a weekly period to its weekday.
fn period_id(schedule: &Schedule, local_ms: i64) -> String {
    let shift_minutes = match schedule.every {
        // An hourly period can only start at some minute past the hour.
        Every::Hourly => schedule.at_minutes % 60,
        Every::Daily | Every::Monthly => schedule.at_minutes,
        Every::Weekly => schedule.at_minutes + (schedule.weekday - 1) * 24 * 60,
    };
    let shifted = local_ms - shift_minutes * MS_PER_MINUTE;
    // Euclidean division so instants before 1970 land on the right day.
    let days = shifted.div_euclid(MS_PER_DAY);
    let ms_of_day = shifted.rem_euclid(MS_PER_DAY);
    let (year, month, day) = civil_from_days(days);
    match schedule.every {
        Every::Hourly => format!("{year:04}-{month:02}-{day:02}T{:02}", ms_of_day / MS_PER_HOUR),
        Every::Daily => format!("{year:04}-{month:02}-{day:02}"),
        Every::Weekly => {
            let (iso_year, week) = iso_week(days);
            format!("{iso_year:04}-W{week:02}")
        }
        Every::Monthly => format!("{year:04}-{month:02}"),
    }
}

/// Days since 1970-01-01 → (year, month, day) in the proleptic Gregorian calendar.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// (year, month, day) → days since 1970-01-01; the inverse of `civil_from_days`.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let year_of_era = y - era * 400;
    let shifted_month = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// ISO 8601 (week-year, week number) of a day count.
///
/// The week belongs to the year that contains its Thursday, which is why
/// 2021-01-01 is still in 2020-W53 and 2024-12-30 is already in 2025-W01.
fn iso_week(days: i64) -> (i64, i64) {
    // 1970-01-01 was a Thursday; Monday = 1.
    let weekday = (days + 3).rem_euclid(7) + 1;
    let thursday = days - (weekday - 1) + 3;
    let (iso_year, _, _) = civil_from_days(thursday);
    let first_of_year = days_from_civil(iso_year, 1, 1);
    (iso_year, (thursday - first_of_year) / 7 + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    /// UTC milliseconds for a calendar moment.
    fn ms(year: i64, month: i64, day: i64, hour: i64, minute: i64) -> i64 {
        (days_from_civil(year, month, day) * 24 * 60 + hour * 60 + minute) * MS_PER_MINUTE
    }

    /// Run the probe for `probe_json` at `now_ms` in the zone `tz` and return the period.
    fn period(probe_json: Value, now_ms: i64, tz: i64) -> String {
        let probe = obj(probe_json);
        let out = run("schedule", &probe, &ProbeCtx { now_ms, tz_offset_minutes: tz }).unwrap();
        assert_eq!(out.items.len(), 1);
        assert_eq!(out.items[0].key, "schedule");
        assert_eq!(out.items[0].fields, json!({ "period": out.items[0].version }));
        out.items[0].version.clone()
    }

    #[test]
    fn calendar_arithmetic_matches_known_instants() {
        // 2021-01-01T00:00:00Z and 2024-12-30T00:00:00Z, from the Unix epoch.
        assert_eq!(ms(2021, 1, 1, 0, 0), 1_609_459_200_000);
        assert_eq!(ms(2024, 12, 30, 0, 0), 1_735_516_800_000);
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(days_from_civil(2024, 2, 29)), (2024, 2, 29));
        assert_eq!(civil_from_days(days_from_civil(1900, 3, 1)), (1900, 3, 1));
    }

    #[test]
    fn hourly_periods() {
        let now = ms(2026, 11, 8, 14, 30);
        assert_eq!(period(json!({"every": "hourly"}), now, 0), "2026-11-08T14");
        // A period that starts at :45 has not started yet at :30.
        assert_eq!(period(json!({"every": "hourly", "at": "00:45"}), now, 0), "2026-11-08T13");
        assert_eq!(period(json!({"every": "hourly", "at": "07:15"}), now, 0), "2026-11-08T14");
        // The hour of "at" is irrelevant to an hourly period.
        assert_eq!(period(json!({"every": "hourly", "at": "23:00"}), ms(2026, 11, 8, 0, 10), 0), "2026-11-08T00");
    }

    #[test]
    fn daily_periods_respect_the_start_time() {
        assert_eq!(period(json!({"every": "daily"}), ms(2026, 11, 8, 0, 0), 0), "2026-11-08");
        assert_eq!(period(json!({"every": "daily", "at": "09:00"}), ms(2026, 11, 8, 8, 59), 0), "2026-11-07");
        assert_eq!(period(json!({"every": "daily", "at": "09:00"}), ms(2026, 11, 8, 9, 0), 0), "2026-11-08");
        // Crossing a month boundary backwards.
        assert_eq!(period(json!({"every": "daily", "at": "09:00"}), ms(2026, 3, 1, 8, 0), 0), "2026-02-28");
    }

    #[test]
    fn weekly_periods_use_iso_weeks() {
        // 2026-11-08 is a Sunday in ISO week 45.
        assert_eq!(period(json!({"every": "weekly"}), ms(2026, 11, 8, 14, 0), 0), "2026-W45");
        // Year boundaries: Friday 2021-01-01 is in 2020's week 53, Monday 2024-12-30 in 2025's week 1.
        assert_eq!(period(json!({"every": "weekly"}), ms(2021, 1, 1, 12, 0), 0), "2020-W53");
        assert_eq!(period(json!({"every": "weekly"}), ms(2024, 12, 30, 0, 0), 0), "2025-W01");
        assert_eq!(period(json!({"every": "weekly"}), ms(2024, 12, 29, 23, 59), 0), "2024-W52");
        assert_eq!(period(json!({"every": "weekly"}), ms(2021, 1, 4, 0, 0), 0), "2021-W01");
    }

    #[test]
    fn weekday_moves_the_start_of_the_week() {
        // With the week starting on Wednesday, Monday 2026-11-02 still belongs to the week before…
        assert_eq!(period(json!({"every": "weekly", "weekday": 3}), ms(2026, 11, 2, 0, 0), 0), "2026-W44");
        assert_eq!(period(json!({"every": "weekly", "weekday": 3}), ms(2026, 11, 3, 23, 59), 0), "2026-W44");
        // …and Wednesday 2026-11-04 starts week 45.
        assert_eq!(period(json!({"every": "weekly", "weekday": 3}), ms(2026, 11, 4, 0, 0), 0), "2026-W45");
        // The start time combines with the weekday.
        assert_eq!(
            period(json!({"every": "weekly", "weekday": 3, "at": "09:00"}), ms(2026, 11, 4, 8, 59), 0),
            "2026-W44"
        );
        assert_eq!(period(json!({"every": "weekly", "weekday": 7}), ms(2026, 11, 8, 0, 0), 0), "2026-W45");
        assert_eq!(period(json!({"every": "weekly", "weekday": 7}), ms(2026, 11, 7, 23, 0), 0), "2026-W44");
    }

    #[test]
    fn monthly_periods() {
        assert_eq!(period(json!({"every": "monthly"}), ms(2026, 11, 8, 14, 0), 0), "2026-11");
        assert_eq!(period(json!({"every": "monthly", "at": "09:00"}), ms(2026, 11, 1, 8, 0), 0), "2026-10");
        assert_eq!(period(json!({"every": "monthly", "at": "09:00"}), ms(2026, 1, 1, 8, 0), 0), "2025-12");
        assert_eq!(period(json!({"every": "monthly"}), ms(2026, 11, 30, 23, 59), 0), "2026-11");
    }

    #[test]
    fn the_time_zone_decides_which_day_it_is() {
        let now = ms(2026, 11, 7, 20, 0);
        assert_eq!(period(json!({"every": "daily"}), now, 0), "2026-11-07");
        // UTC+8 reports -480: it is already 04:00 on the 8th there.
        assert_eq!(period(json!({"every": "daily"}), now, -480), "2026-11-08");
        // UTC-5 reports 300: 02:00 UTC on the 8th is still the evening of the 7th.
        assert_eq!(period(json!({"every": "daily"}), ms(2026, 11, 8, 2, 0), 300), "2026-11-07");
        assert_eq!(period(json!({"every": "hourly"}), now, -480), "2026-11-08T04");
        // A zone that is not a whole number of hours.
        assert_eq!(period(json!({"every": "hourly"}), now, -345), "2026-11-08T01");
    }

    #[test]
    fn instants_before_the_epoch_are_handled() {
        assert_eq!(period(json!({"every": "daily"}), -1, 0), "1969-12-31");
        assert_eq!(period(json!({"every": "hourly"}), -1, 0), "1969-12-31T23");
    }

    #[test]
    fn validate_rejects_bad_parameters() {
        let check = |v: Value| validate("schedule", &obj(v));
        assert!(check(json!({"every": "daily"})).is_ok());
        assert!(check(json!({"every": "weekly", "at": "09:30", "weekday": 7})).is_ok());
        assert!(check(json!({})).is_err());
        assert!(check(json!({"every": "yearly"})).is_err());
        assert!(check(json!({"every": "daily", "at": "25:00"})).is_err());
        assert!(check(json!({"every": "daily", "at": "09:60"})).is_err());
        assert!(check(json!({"every": "daily", "at": "9:00"})).is_err());
        assert!(check(json!({"every": "daily", "at": "09-00"})).is_err());
        assert!(check(json!({"every": "daily", "at": "ab:cd"})).is_err());
        assert!(check(json!({"every": "daily", "at": "é9:00"})).is_err());
        assert!(check(json!({"every": "weekly", "weekday": 8})).is_err());
        assert!(check(json!({"every": "weekly", "weekday": 0})).is_err());
        assert!(check(json!({"every": "weekly", "weekday": "1"})).is_err());
    }
}
