//! ISO/IEC 39075 temporal values — `DATE`, `LOCAL DATETIME`, `DURATION`.
//!
//! Dependency-free (no `chrono`/`time`): the calendar math is Howard Hinnant's
//! civil-from-days algorithm and the ISO-8601 parse/format is hand-rolled, so
//! the wire form is a pure function we can reproduce byte-for-byte in the TS
//! engine. The internal field layout is private to each engine; **byte-identity
//! is defined by the ISO-8601 string** (`format`) and the comparison order, not
//! by the representation.
//!
//! Scope (phase 0): the zone-less trio. `ZONED DATETIME`, `LOCAL/ZONED TIME`
//! come later; the `Temporal` enum leaves room for them.

use std::cmp::Ordering;

/// A calendar date with no time or zone: days since 1970-01-01 (proleptic
/// Gregorian). Ordered chronologically.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct Date {
    /// Days since the Unix epoch (1970-01-01).
    pub days: i32,
}

/// A zone-less datetime (ISO "LOCAL DATETIME"): seconds since 1970-01-01T00:00:00
/// plus a sub-second nanosecond part. Ordered chronologically.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct DateTime {
    pub secs: i64,
    /// 0..1_000_000_000
    pub nanos: u32,
}

/// An ISO-8601 calendar duration. Months and days are kept SEPARATE from seconds
/// (a month is not a fixed number of seconds), matching the Cypher/GQL duration
/// model. Relationally unordered (like SQL intervals), but given a deterministic
/// TOTAL order for `ORDER BY` (lexicographic over the normalized components).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Duration {
    pub months: i64,
    pub days: i64,
    pub secs: i64,
    /// 0..1_000_000_000
    pub nanos: u32,
}

/// The zone-less temporal trio, carried as one `Value`/`Val`/`GVal` variant so
/// each exhaustive match gains a single arm.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Temporal {
    Date(Date),
    DateTime(DateTime),
    Duration(Duration),
}

const SECS_PER_DAY: i64 = 86_400;

// --- civil calendar (Hinnant) ------------------------------------------------

/// Days since 1970-01-01 for a proleptic-Gregorian (y, m, d). `m` in 1..=12.
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// Proleptic-Gregorian (y, m, d) for days since 1970-01-01.
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

// --- small parse helpers -----------------------------------------------------

fn parse_int(s: &str) -> Result<i64, String> {
    s.parse::<i64>()
        .map_err(|_| format!("invalid integer '{s}'"))
}

/// Parse `HH:MM:SS[.fraction]` into (seconds-of-day, nanos).
fn parse_time(s: &str) -> Result<(i64, u32), String> {
    let (hms, frac) = match s.split_once('.') {
        Some((a, b)) => (a, Some(b)),
        None => (s, None),
    };
    let mut it = hms.split(':');
    let h = parse_int(it.next().unwrap_or(""))?;
    let m = parse_int(it.next().ok_or("missing minutes")?)?;
    let sec = parse_int(it.next().ok_or("missing seconds")?)?;
    if it.next().is_some() {
        return Err(format!("bad time '{s}'"));
    }
    if !(0..24).contains(&h) || !(0..60).contains(&m) || !(0..60).contains(&sec) {
        return Err(format!("time out of range '{s}'"));
    }
    let nanos = parse_frac(frac)?;
    Ok((h * 3600 + m * 60 + sec, nanos))
}

/// A fractional-second string (up to 9 digits) → nanoseconds.
fn parse_frac(frac: Option<&str>) -> Result<u32, String> {
    let Some(f) = frac else { return Ok(0) };
    if f.is_empty() || f.len() > 9 || !f.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("bad fractional seconds '.{f}'"));
    }
    let mut padded = f.to_string();
    while padded.len() < 9 {
        padded.push('0');
    }
    parse_int(&padded).map(|n| n as u32)
}

/// Render `nanos` as `.fraction` (trailing zeros trimmed), or empty if zero.
fn fmt_frac(nanos: u32) -> String {
    if nanos == 0 {
        return String::new();
    }
    let s = format!("{nanos:09}");
    format!(".{}", s.trim_end_matches('0'))
}

// --- Date --------------------------------------------------------------------

impl Date {
    /// Parse `YYYY-MM-DD`.
    pub fn parse(s: &str) -> Result<Self, String> {
        let mut it = s.splitn(3, '-');
        // A leading '-' (negative year) is unusual; require the common form.
        let y = parse_int(it.next().ok_or("empty date")?)?;
        let m = parse_int(it.next().ok_or_else(|| format!("bad date '{s}'"))?)?;
        let d = parse_int(it.next().ok_or_else(|| format!("bad date '{s}'"))?)?;
        if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
            return Err(format!("date out of range '{s}'"));
        }
        let days = days_from_civil(y, m, d);
        i32::try_from(days)
            .map(|days| Self { days })
            .map_err(|_| format!("date out of range '{s}'"))
    }

    pub fn format(&self) -> String {
        let (y, m, d) = civil_from_days(self.days as i64);
        format!("{y:04}-{m:02}-{d:02}")
    }
}

// --- DateTime ----------------------------------------------------------------

impl DateTime {
    /// Parse `YYYY-MM-DDTHH:MM:SS[.fraction]` (also accepts a space separator).
    pub fn parse(s: &str) -> Result<Self, String> {
        let sep = s
            .find(['T', ' '])
            .ok_or_else(|| format!("datetime missing time part '{s}'"))?;
        let date = Date::parse(&s[..sep])?;
        let (tod, nanos) = parse_time(&s[sep + 1..])?;
        Ok(Self {
            secs: date.days as i64 * SECS_PER_DAY + tod,
            nanos,
        })
    }

    pub fn format(&self) -> String {
        // Floor-divide so a pre-epoch time-of-day stays in [0, 86400).
        let days = self.secs.div_euclid(SECS_PER_DAY);
        let tod = self.secs.rem_euclid(SECS_PER_DAY);
        let (y, mo, d) = civil_from_days(days);
        let (h, m, s) = (tod / 3600, (tod % 3600) / 60, tod % 60);
        format!(
            "{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}{}",
            fmt_frac(self.nanos)
        )
    }

    fn key(&self) -> (i64, u32) {
        (self.secs, self.nanos)
    }
}

impl Ord for DateTime {
    fn cmp(&self, other: &Self) -> Ordering {
        self.key().cmp(&other.key())
    }
}
impl PartialOrd for DateTime {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

// --- Duration ----------------------------------------------------------------

impl Duration {
    /// Parse ISO-8601 `PnYnMnWnDTnHnMnS` (years→months, weeks→days). Fractional
    /// seconds allowed on the seconds field.
    pub fn parse(s: &str) -> Result<Self, String> {
        let rest = s
            .strip_prefix('P')
            .ok_or_else(|| format!("duration must start with 'P': '{s}'"))?;
        let (date_part, time_part) = match rest.split_once('T') {
            Some((d, t)) => (d, Some(t)),
            None => (rest, None),
        };
        let mut months = 0i64;
        let mut days = 0i64;
        let mut num = String::new();
        for c in date_part.chars() {
            match c {
                '0'..='9' | '-' => num.push(c),
                'Y' => {
                    months += take_num(&mut num, 'Y', s)? * 12;
                }
                'M' => {
                    months += take_num(&mut num, 'M', s)?;
                }
                'W' => {
                    days += take_num(&mut num, 'W', s)? * 7;
                }
                'D' => {
                    days += take_num(&mut num, 'D', s)?;
                }
                _ => return Err(format!("bad duration date field '{c}' in '{s}'")),
            }
        }
        if !num.is_empty() {
            return Err(format!("dangling number in duration '{s}'"));
        }
        let mut secs = 0i64;
        let mut nanos = 0u32;
        if let Some(tp) = time_part {
            for c in tp.chars() {
                match c {
                    '0'..='9' | '-' | '.' => num.push(c),
                    'H' => secs += take_num(&mut num, 'H', s)? * 3600,
                    'M' => secs += take_num(&mut num, 'M', s)? * 60,
                    'S' => {
                        let (whole, frac) = take_secs(&mut num, s)?;
                        secs += whole;
                        nanos = frac;
                    }
                    _ => return Err(format!("bad duration time field '{c}' in '{s}'")),
                }
            }
            if !num.is_empty() {
                return Err(format!("dangling number in duration '{s}'"));
            }
        }
        Ok(Self {
            months,
            days,
            secs,
            nanos,
        })
    }

    /// Canonical ISO-8601: `P<months>M<days>DT<secs>S`, each component omitted
    /// when zero; all-zero renders `PT0S`. Total months / total days (no Y/W
    /// split) so the form is deterministic and round-trips to itself.
    pub fn format(&self) -> String {
        let mut out = String::from("P");
        if self.months != 0 {
            out.push_str(&format!("{}M", self.months));
        }
        if self.days != 0 {
            out.push_str(&format!("{}D", self.days));
        }
        if self.secs != 0 || self.nanos != 0 {
            out.push_str(&format!("T{}{}S", self.secs, fmt_frac(self.nanos)));
        }
        if out == "P" {
            out.push_str("T0S");
        }
        out
    }

    /// Deterministic total order (NOT chronological — a month has no fixed
    /// length): lexicographic over (months, days, secs, nanos). For `ORDER BY`.
    fn total_key(&self) -> (i64, i64, i64, u32) {
        (self.months, self.days, self.secs, self.nanos)
    }
}

/// Consume the pending numeric buffer as an integer for designator `d`.
fn take_num(num: &mut String, d: char, whole: &str) -> Result<i64, String> {
    if num.is_empty() {
        return Err(format!("missing number before '{d}' in '{whole}'"));
    }
    let v = parse_int(num)?;
    num.clear();
    Ok(v)
}

/// Consume the pending buffer as `seconds[.fraction]` → (whole secs, nanos).
fn take_secs(num: &mut String, whole: &str) -> Result<(i64, u32), String> {
    if num.is_empty() {
        return Err(format!("missing number before 'S' in '{whole}'"));
    }
    let (w, frac) = match num.split_once('.') {
        Some((a, b)) => (a, Some(b.to_string())),
        None => (num.as_str(), None),
    };
    let secs = parse_int(w)?;
    let nanos = parse_frac(frac.as_deref())?;
    num.clear();
    Ok((secs, nanos))
}

// --- Temporal (the value-model variant) --------------------------------------

impl Temporal {
    /// The kind tag used by codecs and the value key: `date`/`datetime`/`duration`.
    pub fn tag(&self) -> &'static str {
        match self {
            Self::Date(_) => "date",
            Self::DateTime(_) => "datetime",
            Self::Duration(_) => "duration",
        }
    }

    /// The GraphSON v3 `@type` name (TinkerPop extended types).
    pub fn graphson_type(&self) -> &'static str {
        match self {
            Self::Date(_) => "gx:LocalDate",
            Self::DateTime(_) => "gx:LocalDateTime",
            Self::Duration(_) => "gx:Duration",
        }
    }

    /// The GraphSON `@type` → kind tag, for decode. `None` if not temporal.
    pub fn graphson_tag(ty: &str) -> Option<&'static str> {
        match ty {
            "gx:LocalDate" => Some("date"),
            "gx:LocalDateTime" => Some("datetime"),
            "gx:Duration" => Some("duration"),
            _ => None,
        }
    }

    /// The ISO-8601 string form (the byte-identity wire value).
    pub fn format(&self) -> String {
        match self {
            Self::Date(d) => d.format(),
            Self::DateTime(dt) => dt.format(),
            Self::Duration(du) => du.format(),
        }
    }

    /// Compact tagged JSON, e.g. `{"@date":"2020-01-01"}` — the representation
    /// for our JSON-family codecs (ndjson/pg-json/query results). The ISO form
    /// never contains JSON-special characters, so no escaping is needed. (Its
    /// decode twin is [`Temporal::from_json_tag`].)
    pub fn json_tagged(&self) -> String {
        format!("{{\"@{}\":\"{}\"}}", self.tag(), self.format())
    }

    /// Decode from a `@date`/`@datetime`/`@duration` JSON object key + its string
    /// value (the single-key tagged form). `None` if the key isn't a temporal tag.
    pub fn from_json_tag(key: &str, s: &str) -> Option<Result<Self, String>> {
        let tag = key.strip_prefix('@')?;
        matches!(tag, "date" | "datetime" | "duration").then(|| Self::parse(tag, s))
    }

    /// Build from a kind tag + ISO string (the codec decode path).
    pub fn parse(tag: &str, s: &str) -> Result<Self, String> {
        match tag {
            "date" => Date::parse(s).map(Temporal::Date),
            "datetime" => DateTime::parse(s).map(Temporal::DateTime),
            "duration" => Duration::parse(s).map(Temporal::Duration),
            _ => Err(format!("unknown temporal kind '{tag}'")),
        }
    }

    /// Kind rank for the cross-kind total order (date < datetime < duration).
    fn kind_rank(&self) -> u8 {
        match self {
            Self::Date(_) => 0,
            Self::DateTime(_) => 1,
            Self::Duration(_) => 2,
        }
    }

    /// Deterministic TOTAL order over all temporals (for `ORDER BY`/min/max):
    /// by kind, then chronologically within date/datetime, lexicographically
    /// within duration.
    pub fn cmp_total(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Self::Date(a), Self::Date(b)) => a.cmp(b),
            (Self::DateTime(a), Self::DateTime(b)) => a.cmp(b),
            (Self::Duration(a), Self::Duration(b)) => a.total_key().cmp(&b.total_key()),
            _ => self.kind_rank().cmp(&other.kind_rank()),
        }
    }

    /// Relational order for `< > <= >=`: date/datetime are instants (chronological);
    /// durations and cross-kind pairs are UNKNOWN (`None`) — SQL-interval-like,
    /// and consistent with the engine's partial relational / total sort split.
    pub fn rel_cmp(&self, other: &Self) -> Option<Ordering> {
        match (self, other) {
            (Self::Date(a), Self::Date(b)) => Some(a.cmp(b)),
            (Self::DateTime(a), Self::DateTime(b)) => Some(a.cmp(b)),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_round_trips_known_dates() {
        for &(y, m, d) in &[
            (1970, 1, 1),
            (2000, 1, 1),
            (2020, 2, 29), // leap day
            (1969, 12, 31),
            (1600, 12, 31),
            (2262, 4, 11),
        ] {
            let days = days_from_civil(y, m, d);
            assert_eq!(
                civil_from_days(days),
                (y, m as u32, d as u32),
                "{y}-{m}-{d}"
            );
        }
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(1970, 1, 2), 1);
        assert_eq!(days_from_civil(1969, 12, 31), -1);
    }

    #[test]
    fn date_parse_format_round_trip() {
        for s in ["1970-01-01", "2020-02-29", "1999-12-31", "2026-07-11"] {
            assert_eq!(Date::parse(s).unwrap().format(), s);
        }
        assert!(Date::parse("2020-13-01").is_err());
        assert!(Date::parse("not-a-date").is_err());
    }

    #[test]
    fn datetime_parse_format_round_trip() {
        for s in [
            "2020-01-01T00:00:00",
            "2026-07-11T13:45:06",
            "2020-01-01T10:15:30.5",
            "1969-12-31T23:59:59", // pre-epoch time-of-day stays in range
        ] {
            assert_eq!(DateTime::parse(s).unwrap().format(), s);
        }
        // space separator accepted on input, normalized to 'T'.
        assert_eq!(
            DateTime::parse("2020-01-01 10:15:30").unwrap().format(),
            "2020-01-01T10:15:30"
        );
    }

    #[test]
    fn duration_parse_normalizes_and_round_trips() {
        // years→months, weeks→days on input; canonical uses total M/D and T…S.
        assert_eq!(
            Duration::parse("P1Y2M3W4DT5H6M7S").unwrap().format(),
            "P14M25DT18367S"
        );
        assert_eq!(Duration::parse("P1Y").unwrap().format(), "P12M");
        assert_eq!(Duration::parse("PT0S").unwrap().format(), "PT0S");
        assert_eq!(Duration::parse("P0D").unwrap().format(), "PT0S");
        assert_eq!(Duration::parse("PT1.5S").unwrap().format(), "PT1.5S");
        // canonical output re-parses to itself.
        let canon = Duration::parse("P14M25DT18367S").unwrap();
        assert_eq!(Duration::parse(&canon.format()).unwrap(), canon);
        assert!(Duration::parse("1Y").is_err());
    }

    #[test]
    fn ordering_is_deterministic() {
        let d1 = Temporal::Date(Date::parse("2020-01-01").unwrap());
        let d2 = Temporal::Date(Date::parse("2020-06-01").unwrap());
        assert_eq!(d1.rel_cmp(&d2), Some(Ordering::Less));
        assert_eq!(d1.cmp_total(&d2), Ordering::Less);

        let t1 = Temporal::DateTime(DateTime::parse("2020-01-01T00:00:00").unwrap());
        // cross-kind: relationally UNKNOWN, but a deterministic total order.
        assert_eq!(d1.rel_cmp(&t1), None);
        assert_eq!(d1.cmp_total(&t1), Ordering::Less); // date kind-rank < datetime

        let du = Temporal::Duration(Duration::parse("P1M").unwrap());
        assert_eq!(du.rel_cmp(&du), None); // durations not relationally ordered
        assert_eq!(du.cmp_total(&du), Ordering::Equal);
        assert_eq!(t1.cmp_total(&du), Ordering::Less); // datetime kind-rank < duration
    }
}
