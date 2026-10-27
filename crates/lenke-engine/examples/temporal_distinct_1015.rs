//! What does `RETURN DISTINCT <temporal>` cost PER KIND in the Rust engine?
//!
//! Item 847 gave `distinct.rs`'s `ColKeyer` a `Date` arm — 9.2x on a scan — and stopped there:
//!
//! > ONLY `Date`, for the reason item 840 records: the general path's equivalence is
//! > `group_key`'s, which keys a temporal by `t.format()` — RENDER equality — while a field is
//! > STRUCTURAL. The two coincide where `format` is injective, which for `Date` is demonstrable.
//! > The kinds carrying a sub-second or zone part keep the general path.
//!
//! That is a real constraint and, unlike the TS engine's twin note (item 1014), it is about
//! SEMANTICS rather than convenience: structural keying may only replace render keying where
//! `format` is injective, or two values that render alike would land in different groups and the
//! answer would change.
//!
//! **It is also unproven for the other kinds.** Reading `temporal.rs`: `fmt_frac` zero-pads
//! `nanos` to nine digits and trims trailing zeros (injective — `""` for 0, and distinct
//! otherwise), `fmt_year` pads without truncating, and `fmt_offset` renders whole minutes as
//! `Z` or `±HH:MM` with `{:02}`, which widens rather than truncates. A `DateTime` renders
//! `civil_from_days(secs)` + time-of-day + frac, all recoverable; a zoned kind renders the LOCAL
//! value plus its offset, from which the stored instant is recoverable. So `format` appears
//! injective for `Time`, `DateTime`, `ZonedDateTime` and `ZonedTime` too.
//!
//! This probe prices what that would be worth before any of it is built. `Num` is the floor the
//! `Date` arm already reaches, and `Date` is the arm that proves the fixture reaches the keyer at
//! all — so those two are the controls, and the distance from them is the target.
//!
//! Run:
//!   cargo run --release --manifest-path crates/lenke-engine/Cargo.toml \
//!     --example temporal_distinct_1015
//!   ROWS=200000 DISTINCT=1000 REPS=9 ... --example temporal_distinct_1015
use lenke_engine::store::{Builder, Store};
use lenke_engine::temporal::{Date, DateTime, Temporal, Time, ZonedDateTime, ZonedTime};
use lenke_engine::value::Value;
use std::time::Instant;

fn env(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// The `i`th value of `kind`, carrying `i % distinct` so every kind has the SAME group count —
/// a keyer is priced against the work it does, and a different number of groups is a different
/// question (the trap `CLOSED.md` records as matching the fixture to the claim).
fn value_of(kind: &str, i: usize, distinct: usize) -> Value {
    let v = (i % distinct) as i64;

    match kind {
        "num" => Value::Num(v as f64),
        "str" => Value::Str(format!("s{v}").into()),
        "date" => Value::Temporal(Temporal::Date(Date {
            days: (19_000 + v) as i32,
        })),
        "time" => Value::Temporal(Temporal::Time(Time {
            secs: v as u32,
            nanos: 0,
        })),
        "datetime" => Value::Temporal(Temporal::DateTime(DateTime {
            secs: 1_700_000_000 + v,
            nanos: 0,
        })),
        // `nanos` varying with `secs` FIXED, so a key that drops the sub-second part answers ONE
        // group here rather than merely measuring faster.
        "datetime_nanos" => Value::Temporal(Temporal::DateTime(DateTime {
            secs: 1_700_000_000,
            nanos: v as u32,
        })),
        "zoned" => Value::Temporal(Temporal::ZonedDateTime(ZonedDateTime {
            secs: 1_700_000_000 + v,
            nanos: 0,
            offset: 60,
        })),
        "zonedtime" => Value::Temporal(Temporal::ZonedTime(ZonedTime {
            secs: v as u32,
            nanos: 0,
            offset: 60,
        })),
        other => panic!("unknown kind: {other}"),
    }
}

fn fixture(kind: &str, rows: usize, distinct: usize) -> Store {
    let mut b = Builder::default();
    // ONE source wired to every `P` (item 1022), so a hop reaches the whole set as a FRONTIER.
    // `frontier_group_by` is a different function from the scan grouping arms item 848 added, and
    // its `_ => return None` covers EVERY temporal kind — `Date` included — so the frontier shape
    // needs its own fixture or the gap cannot be reached at all.
    let src = b.node(&["S"], &[("n", Value::Num(0.0))]);

    for i in 0..rows {
        let id = b.node(&["P"], &[("t", value_of(kind, i, distinct))]);
        b.edge(src, id, "E");
    }

    b.build()
}

fn time_q(q: &str, store: &Store, reps: usize) -> (f64, usize) {
    time_any(q, store, reps, false)
}

/// The Gremlin twin (item 1016). `values(k).dedup()` is lowered by a DIFFERENT fast path from
/// either GQL form, with its own Date-only gate, so measuring it needs its own arm rather than an
/// assumption that one surface's number carries to the other.
fn time_gremlin(q: &str, store: &Store, reps: usize) -> (f64, usize) {
    time_any(q, store, reps, true)
}

fn time_any(q: &str, store: &Store, reps: usize, gremlin: bool) -> (f64, usize) {
    let raw = if gremlin {
        lenke_engine::gremlin::parse(q).unwrap()
    } else {
        lenke_engine::gql::parse(q).unwrap()
    };
    let plan = lenke_engine::opt::optimize_indexed(raw, store);
    let mut best = f64::MAX;
    let mut rows = 0;

    for _ in 0..reps {
        let t = Instant::now();
        let out = lenke_engine::exec::try_run(&plan, store).expect("runs");
        best = best.min(t.elapsed().as_secs_f64() * 1e6);
        rows = out.rows.iter().count();
    }

    (best, rows)
}

fn main() {
    let rows = env("ROWS", 200_000);
    let distinct = env("DISTINCT", 1000);
    let reps = env("REPS", 9);

    println!("# RETURN DISTINCT <temporal> per kind — {rows} rows, {distinct} distinct, min of {reps} (us)");
    println!("# num and date are the CONTROLS: both already reach ColKeyer, so a fix cannot move them.\n");
    println!(
        "  kind              scan_distinct_us   rows   count_distinct_us   gremlin_dedup_us   g_rows   topk_us   topk_ceiling_us   frontier_grp_us"
    );

    for kind in [
        "num",
        "str",
        "date",
        "time",
        "datetime",
        "datetime_nanos",
        "zoned",
        "zonedtime",
    ] {
        let store = fixture(kind, rows, distinct);
        let (scan, n) = time_q("MATCH (p:P) RETURN DISTINCT p.t AS t", &store, reps);
        let (agg, _) = time_q("MATCH (p:P) RETURN count(DISTINCT p.t) AS c", &store, reps);
        let (grem, gn) = time_gremlin("g.V().hasLabel('P').values('t').dedup()", &store, reps);
        // A STATEMENT-POSITION sorted LIMIT (item 1019), which is the spelling that reaches
        // `try_scan_top_k` — `order.rs` mentions `Temporal` zero times, so a temporal key hits
        // its `_ => return None` and pays a full sort. The unlimited form is the ceiling: a key
        // landing on it is getting no top-k treatment at all. `num` and `dict` are the controls
        // that already have a path; `str` is the one item 864 MEASURED and refused.
        let (topk, _) = time_q(
            "MATCH (p:P) ORDER BY p.t LIMIT 10 RETURN p AS p",
            &store,
            reps,
        );
        // THE FRONTIER GROUPED AGGREGATE (item 1022). The scan form goes through item 848's
        // grouping arms; this one reaches `frontier_group_by`, which declines every temporal kind.
        // `num` and `str` are the controls that already have arms there.
        let (fgrp, _) = time_q(
            "MATCH (s:S)-[:E]->(p:P) RETURN p.t AS k, count(*) AS c",
            &store,
            reps,
        );
        let (ceil, _) = time_q("MATCH (p:P) ORDER BY p.t RETURN p AS p", &store, reps);
        // The row count is CHECKED, not assumed: every kind must find exactly `distinct` groups,
        // so a fixture whose values collide (or a key that over-splits) is loud rather than fast.
        let ok = if n == distinct {
            ""
        } else {
            " <- WRONG GROUPS"
        };

        println!(
            "  {kind:16}  {scan:14.1}  {n:6}  {agg:17.1}  {grem:16.1}  {gn:6}  {topk:8.1}  {ceil:15.1}  {fgrp:12.1}{ok}"
        );
    }
}
