# Dogfood Round 7 — Sunita: Temporal / Telemetry Analytics Findings

Built a sensor-telemetry model — `(Reading)-[:MEASURED_BY]->(Device)-[:LOCATED_AT]->(Site)`
with each `Reading` carrying a stored `DATETIME ts` and numeric `value` — and ran
windowed/as-of queries, downsampling buckets, rate/delta, z-score anomaly flags, and
hierarchy rollups, verifying every aggregate against an independent JS computation over
the same seeded data.

Files: `telemetry.ts` (34,560-reading scenario + 19 verified assertions), `smoke.ts`,
`probe-bucket.ts`, `probe-bucket2.ts`, `probe-order.ts`, `probe-pct.ts`, `probe-value.ts`,
`probe-gaps.ts`, `probe-hod.ts`.

Verdict up front: **the core temporal story is solid — stored `DATETIME` ordering,
comparison, windowing, and substring-prefix bucketing are byte-correct and `telemetry.ts`
passes 19/19.** The friction is entirely in the _arithmetic and stats layer_ on top: you
cannot turn a `DURATION` into a number (so no in-engine rate math), duration ÷ scalar and
duration × fractional-scalar silently return `null`, there are no percentile/median/stddev
aggregates, and no date-part extraction (hour/day-of-week/etc.) — forcing a string-substring
hack for every bucket. Two silent-`null` hazards can produce wrong results with no error.

---

## HIGH-1 — `DURATION ÷ number` always returns `null`; `DURATION × non-integer` returns `null` (silent)

- **Severity:** HIGH
- **Category:** BUG (silent wrong result — `null` instead of a duration/number)
- **Repro:** `probe-gaps.ts` / `smoke.ts` and confirmed with extra probes:
  - `RETURN DURATION 'P10D' / 2 AS d` -> `{"d":null}` (expected `P5D` / `PT432000S`)
  - `RETURN DURATION 'P10D' / 4 AS d` -> `{"d":null}` (expected `PT216000S`)
  - `RETURN DURATION 'P10D' * 1.5 AS d`-> `{"d":null}` (expected `P15D` / `PT1296000S`)
  - `RETURN DURATION 'PT2H' * 1.5 AS d`-> `{"d":null}` (expected `PT3H`)
  - `RETURN DURATION 'PT10S' * 0.5 AS d`->`{"d":null}` (expected `PT5S`)
  - `RETURN 1.5 * DURATION 'P10D' AS d`-> `{"d":null}` (expected `P15D`)
- **Contrast (what works):** integer-valued multipliers are fine —
  `DURATION 'P10D' * 2` -> `P20D`, and `* 2.0` -> `P20D`. So the multiply path only accepts
  integer-valued scalars and silently nulls a fractional one; the **divide path nulls even
  exact integer division** (`/ 2`, `/ 4`).
- **Impact:** biggest blocker for telemetry. "readings per second", "scale a retention
  window by 1.5", "half-interval" — any duration scaling that isn't an integer multiply —
  produces `null`, and it propagates silently (a `WHERE r.ts >= now - DURATION 'P10D' * 1.5`
  clause compares against `null` and drops every row with no error). No exception, no
  diagnostic.
- **Workaround:** none in-engine for fractional/divide; pre-compute the duration in JS and
  pass it as a param, or restrict to integer multiplies.

## HIGH-2 — No `DURATION -> number` path at all (no rate math in-engine)

- **Severity:** HIGH (capability gap, total for the telemetry use case)
- **Category:** CAPABILITY / BUG (one facet silently nulls)
- **Repro:** `probe-gaps.ts`:
  - `seconds(duration_between(a, b))` -> `ERR call to an unknown or unimplemented function: seconds()`
  - `duration_between(a,b) * 1` -> returns a **DURATION** (`PT7200S`), not a number — multiplying a duration by 1 does not coerce to a scalar.
  - `duration_between(a,b) / DURATION 'PT1H'` -> `{"x":null}` (silent — the natural
    "how many hours" duration-ratio idiom yields `null`, not `2`).
- **Impact:** there is **no** way to get a scalar magnitude out of a `DURATION`. Rate =
  Δvalue / Δseconds is impossible in-engine; durations can only be compared/returned opaquely.
  The `dur/dur` null is especially sharp — that's the standard dimensionless-ratio idiom and
  it fails silently (see also HIGH-1).
- **Workaround:** `to_string(dur)` works (`"PT7200S"`) — parse the ISO-8601 string in JS.

## MED-3 — Unknown/unimplemented function silently returns `[]` on an empty match

- **Severity:** MED
- **Category:** BUG (validation hazard — a bad query passes on empty data)
- **Repro:** `probe-gaps.ts` vs `probe-pct.ts`:
  - Empty graph: `MATCH (n) RETURN percentile_cont(n.v, 0.5) AS x` -> `OK []` (no error),
    and even `MATCH (n) RETURN totallyfake(n.v) AS x` -> `OK []`.
  - Non-empty graph (10 vertices): same `percentile_cont` call ->
    `ERR call to an unknown or unimplemented function: percentile_cont()`.
- **Impact:** unknown-function resolution is deferred to row evaluation, so a typo'd or
  unsupported function name **passes silently whenever the match is empty**. A query
  validated against a fresh/empty graph (common test/CI setup) looks healthy, then throws in
  production once data arrives. Function validity should not depend on cardinality.
- **Workaround:** validate queries against non-empty fixtures.

## MED-4 — Stored `STRING` timestamp vs `DATETIME` literal silently compares to `null` -> count 0

- **Severity:** MED
- **Category:** ERGONOMICS / HAZARD (type policy defensible, but the failure is silent)
- **Repro:** `probe-gaps.ts` (HAZARD block). Store `ts` as a plain string
  (`'2026-07-01T10:00:00'`, i.e. forgot `parseDateTime`), then:
  - `MATCH (r:R) WHERE r.ts >= DATETIME '2026-07-01T09:00:00' RETURN count(r) AS c` -> `{"c":0}`
    (expected 1; the string is lexically after the cutoff).
  - `RETURN r.ts >= DATETIME '2026-07-01T09:00:00' AS cmp` -> `[{"cmp":null},{"cmp":null}]`.
  - Same query on a properly-typed `DATETIME` store -> `{"c":1}` (correct).
- **Impact:** a single forgotten `parseDateTime` at ingest turns every temporal filter into a
  silent all-rows-dropped — the most damaging failure mode for a telemetry app, with no
  error or warning. STRING-vs-DATETIME yielding UNKNOWN/`null` is the documented type policy,
  but there's no strict/lint mode to surface it.
- **Workaround:** wrap the property: `WHERE datetime(r.ts) >= DATETIME '...'` -> `{"c":1}` (verified).

## MED-5 — No date-part extraction (hour / day-of-week / date_trunc / `.hour`)

- **Severity:** MED
- **Category:** CAPABILITY
- **Repro:** `probe-gaps.ts`:
  - `extract(HOUR FROM DATETIME '...')` -> `ERR 'HOUR' is a reserved word; quote it as a delimited identifier`
    (the `EXTRACT(field FROM x)` grammar isn't recognized; `HOUR` is lexed as an identifier).
  - `date_trunc('hour', ...)` -> unknown fn; `hour(...)` -> unknown; `year(DATE '...')` -> unknown.
  - `(DATETIME '...').hour` and `.epochSeconds` -> `ERR Unexpected trailing input '.'` (no field accessor).
- **Impact:** "average by hour-of-day", "weekday vs weekend", "truncate to hour" — core
  telemetry rollups — have no first-class path. Every bucket goes through
  `substring(to_string(ts), ...)` string surgery (see LOW-7).
- **Workaround:** `substring(to_string(r.ts), 12, 2)` for hour-of-day works
  (`probe-hod.ts` -> `[{"hod":"10","c":2},{"hod":"14","c":1}]`), but it's positional string
  math yielding a string, not a semantic int.

## MED-6 — No percentile / median / stddev aggregates

- **Severity:** MED
- **Category:** CAPABILITY
- **Repro:** `probe-pct.ts` (10-vertex graph): `percentile_cont`, `percentile_disc`,
  `median`, `stddev`, `stdev` all -> `ERR call to an unknown or unimplemented function`.
  Manual median is also blocked: `list_sort(collect_list(r.v))[5]` ->
  `ERR Unexpected trailing input '['` (no list-index syntax — known gap).
- **Impact:** p50/p95/p99 and stddev-based outlier detection cannot be expressed. Percentiles
  have no workaround at all in GQL (no list indexing, so you can't hand-roll from a sorted
  `collect_list`).
- **Workaround:** stddev _is_ achievable in one pass via `sum(v)` + `sum(power(v,2))` and a
  JS variance step — verified byte-correct in `telemetry.ts` §4 (z-score PASS). Median/
  percentile require pulling values out with `collect_list` and sorting in JS.

## LOW-7 — `substring` is 1-based; passing `0` silently truncates -> wrong buckets

- **Severity:** LOW
- **Category:** ERGONOMICS / HAZARD
- **Repro:** `probe-bucket2.ts`:
  - `substring(to_string(r.ts), 1, 13)` -> `"2026-07-01T10"` (correct hour bucket)
  - `substring(to_string(r.ts), 0, 13)` -> `"2026-07-01T1"` (12 chars — start=0 consumes one length unit)
- **Impact:** `probe-bucket.ts` uses the intuitive-but-wrong `0` start and every hour bucket
  collapses to `"2026-07-01T1"`, silently merging hours 10-19 into one bucket (its "hourly
  avg" groups 4 disparate readings as one) — a wrong aggregate with no error. The SQL 1-based
  convention is correct per spec, but 0-based is the JS reflex and the failure is a silent
  mis-bucket.
- **Workaround:** always start at 1 (`telemetry.ts` does, and passes).

## LOW-8 — `value` and `day` are reserved words; common telemetry names must be quoted

- **Severity:** LOW
- **Category:** ERGONOMICS (clear error — just friction)
- **Repro:** `probe-value.ts` / `probe-bucket.ts`:
  - `RETURN r.value` -> `ERR 'value' is a reserved word; quote it as a delimited identifier`
  - `WHERE r.value > 0` -> same; `RETURN ... AS day` -> `ERR 'day' is a reserved word ...`
  - Quoted forms all work: `` r.`value` ``, ``avg(r.`value`)``, `` AS `day` ``.
- **Impact:** `value`, `day`, `hour` are the most natural telemetry names, so nearly every
  query needs backticks. The error message is excellent (names the word, says how to fix),
  so this is pure friction, not a trap.

---

## What worked well (a lot)

- **`telemetry.ts` passes 19/19** against independent JS ground truth over 34,560 readings:
  all time-window forms (`r.ts >= now - DURATION` and `r.ts + DURATION >= now`), a half-open
  `BETWEEN`, hourly/daily downsampling (min/max/avg/sum/count), 2-D group count conservation,
  consecutive-order deltas, threshold + z-score anomaly flags, and site-level hierarchy
  rollups (incl. a windowed one combining traversal + as-of).
- **Stored `DATETIME` ordering & comparison are correct.** `ORDER BY r.ts` on stored
  datetimes sorts right (`smoke.ts`); `>=`/`<`/`AND` range filters match JS exactly.
- **Substring-prefix bucketing (1-based) is exact** and merges sub-second timestamps into the
  right hour bucket (`probe-gaps.ts`: `10:15:00` and `10:45:00.5` both -> `2026-07-01T10`,
  count 2). `to_string(DATETIME)` is clean second/sub-second ISO with no zone.
- **`collect_list` + `WITH ... ORDER BY` gives deterministic sorted collection** — the
  documented "pre-sort in WITH, then collect" idiom works (`probe-order.ts`: `WITH r ORDER BY
r.ts RETURN collect_list(r.v)` -> `[1,3,5,9]`), whereas a trailing `ORDER BY` in the same
  `RETURN` is (correctly, per docs) ignored by the aggregate.
- **`duration_between` is correct** (`PT300S` for a 5-min gap, `PT10800S` for 3h) and works
  with an aggregate arg (`duration_between(lit, max(r.ts))`).
- **`current_timestamp` param injection works**, including the documented DATE->DATETIME
  coercion: `{__now: parseDate('2026-07-01')}` -> `current_timestamp` = `2026-07-01T00:00:00`
  (`smoke.ts`). Instant + duration arithmetic in `WHERE` is correct.
- **Integer duration scaling** (`DURATION 'P10D' * 2` -> `P20D`) works — only fractional/
  divide cases break (HIGH-1).

## Doc accuracy

- Scripts' inline notes match reality: substring is 1-based (confirmed), a trailing
  `ORDER BY` doesn't sort a `collect_list` (confirmed — must `WITH`-sort first), and the
  instant-arith window form is a valid alternative to `now - DURATION`. No doc overclaim
  found in the temporal surface.
- Gap the docs should call out: there is **no `DURATION -> number` coercion**, and duration ÷
  scalar / duration × fractional silently yield `null` (HIGH-1/HIGH-2) — users expect rate
  math to work and get silent nulls instead of an error.
