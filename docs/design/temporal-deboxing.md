# Temporal column de-boxing

Status: **shipped** (both phases, all 6 types; 1253 native + full TS/FFI gate green,
byte-identical). Overflow-policy prerequisite shipped.

## Implementation

One `Column::Temporal { data: TemporalCol, present: BitSet }` variant wraps a
per-type SoA inner enum (`TemporalCol` in `graph.rs`) — so each exhaustive `match
col` gains a single arm while per-type width is preserved inside (Date = `Vec<i32>`,
Duration = four parallel `Vec`s). Threaded through `value_kind`/`empty_col_for(_kind)`/
`col_set`/`value_id`/`push_absent`/`element_len`/`is_present`/`to_mixed`/`remove_value`
(graph.rs), the NDJSON encoder, and the scalar prop-read (eval.rs). `TemporalKind` +
`Temporal::kind()` classify a value to its column kind; a key mixing temporal
sub-kinds (or temporal + other) promotes to `Mixed` like any type disagreement.

Phase (b) is implemented as **vectorized gather** (`gather_temporal` → `VVec::Gen` of
`Val::Temporal`, chained after `gather_num`/`gather_str` at the Prop sites): a temporal
property now reconstructs from the packed arrays in a tight loop instead of the per-row
`Binding`+`eval` dispatch, engaging the vectorized scan. (A fully-typed integer-loop
comparator with Duration-SoA lexicographic compare is a further, riskier optimization
left for later — see "Remaining opportunity"; the gather captured most of the win.)

## Context

Temporal property values (`DATE`, `TIME`, `LOCAL DATETIME`, `ZONED TIME`,
`ZONED DATETIME`, `DURATION`) are currently stored in `Column::Mixed`
(`Vec<Option<Value>>`, ~40 B/slot) — there is no typed temporal column, so every
temporal read is a two-hop discriminant walk (`Option` → `Value` → `Temporal`) and
every filter/sort/aggregate falls to the scalar path (the vectorized scan only
engages typed `Column::Num`/`Str`).

A `Value::Temporal(Temporal)` is inline (no heap): `Temporal` is 40 B, pinned by its
largest variant `Duration` (3×i64 + u32). So a single unified `Column::Temporal
{ Vec<Temporal> }` would save ~0 memory — **per-type packed columns are the only
thing that recovers memory**, because only they can use each type's true width.

## Decision

De-box all six fixed-width temporal types into per-type packed `Column` variants,
mirroring `Column::Num`. **Measured** packed width per slot vs the 40 B Mixed slot
(SoA, `size_of` sum; `temporal_bench` `vertex_prop_bytes`) — this is the **memory**
axis, distinct from speed (see Results):

| Type             | Packed layout            | B/slot | vs Mixed |
| ---------------- | ------------------------ | ------ | -------- |
| `DATE`           | `Vec<i32>`               | 4      | 9.70×    |
| `TIME`           | `Vec<u32>,Vec<u32>`      | 8      | 4.92×    |
| `ZONED TIME`     | `secs,nanos,offset`      | 10     | 3.95×    |
| `LOCAL DATETIME` | `Vec<i64>,Vec<u32>`      | 12     | 3.30×    |
| `ZONED DATETIME` | `secs,nanos,offset`      | 14     | 2.83×    |
| `DURATION`       | `months,days,secs,nanos` | 28     | 1.42×    |

(SoA packs tighter than an AoS struct would — `DURATION` is 28 B, not a padded 32;
`ZONED DATETIME` 14, not 16 — so the multi-field ratios beat the back-of-envelope
estimates.) `DATE` at `i32` (4 B, Arrow `Date32`-aligned) is why the overflow decision
kept the i32 wall — the packed date column is the payoff.

Wire form is unchanged: `value_id` reconstructs `Value::Temporal(...)`, so codecs,
Arrow egress, FFI, and byte-identity with the (non-columnar) TS engine are untouched.
A key that mixes temporal subtypes (or a temporal + non-temporal) promotes to `Mixed`
exactly like `Num`/`Str` do today.

### Two phases

- **(a) storage** — new `Column` variants + `value_kind`/`empty_col_for`/`col_set`/
  `value_id`/`push_absent`/`element_len`/`is_present`/`to_mixed`/`remove_value` arms.
  Buys the memory win + discriminant-free reads. Near-zero risk (wire form via
  `value_id`).
- **(b) vectorized** — engage the vectorized scan for temporal props. Shipped as a
  gather (`gather_temporal` → `VVec::Gen`), replacing per-row `eval` dispatch with a
  tight reconstruct loop. A fully-typed integer-loop comparator (Duration SoA
  early-resolve on `months`) is the further, deferred step (see Results → Remaining
  opportunity).

Tiered expectation held: the gather (project 2×, others ~1.4–1.5×) is the low-risk
majority; the typed-compare ceiling (esp. `DURATION` sorts) is what's left on the table.

## Baseline (before de-boxing)

`cargo run --release --example temporal_bench` — 200k Person vertices, one column of
each type, all in `Column::Mixed` / scalar eval. Build reported **~219 B/vertex across
6 cols (~36 B/col)**, empirically confirming the ~40 B Mixed slot.

| type      | filter>p count | order by | project | min/max |
| --------- | -------------- | -------- | ------- | ------- |
| date      | 13.4 ms        | 37.7 ms  | 4.3 ms  | 21.0 ms |
| time      | 14.3 ms        | 37.2 ms  | 4.4 ms  | 21.1 ms |
| datetime  | 11.7 ms        | 37.1 ms  | 4.2 ms  | 22.3 ms |
| ztime     | 14.5 ms        | 36.3 ms  | 4.3 ms  | 21.9 ms |
| zdatetime | 13.2 ms        | 37.1 ms  | 4.3 ms  | 25.0 ms |
| duration  | 14.4 ms        | 38.4 ms  | 6.3 ms  | 21.3 ms |

Flat across types (all share the Mixed scalar path) — the differentiation is what
de-boxing should produce. `project` is expected to move least (it rebuilds a 40 B
`Value` per row regardless); `filter`/`order`/`min-max` are the vectorization targets.

## Results (200k vertices, same harness)

Each cell is the **mean of all six type rows** for that op/phase (they cluster tightly
— the gather is kind-agnostic), baseline → phase (a) storage → phase (b) gather:

| op             | baseline | phase (a) | phase (b) | total |
| -------------- | -------- | --------- | --------- | ----- |
| filter>p count | 13.57 ms | 11.37 ms  | 9.61 ms   | 1.41× |
| order by       | 37.28 ms | 31.59 ms  | 25.99 ms  | 1.43× |
| project        | 4.63 ms  | 4.06 ms   | 2.18 ms   | 2.13× |
| min/max        | 22.10 ms | 19.86 ms  | 14.36 ms  | 1.54× |

Per-type spread is small except two outliers: **duration** is consistently slowest
(baseline project 6.3 ms — its lexicographic compare is why it heads the deferred
typed-compare list), and **zdatetime** min/max ran high at baseline (25.0 ms). Raw
per-type numbers come straight from `temporal_bench`.

**Speed and memory are different axes** — the memory ratio is per-type (Date 9.70×,
Duration 1.42×; table above), but speed is roughly uniform (~1.4–2.1×) because the
shipped phase-(b) gather reconstructs a `Val::Temporal` per row regardless of packed
width. The 10×-fewer-bytes of a Date column would only translate to speed in a
cache-bound _integer-loop_ scan — the deferred typed-compare, and even there speed is
bounded by more than byte count. `project` doubling reflects the gather removing the
per-row eval dispatch (its dominant cost), not the memory ratio.

### Remaining opportunity

`filter`/`order`/`min-max` still compare through `Val` ordering, not tight integer
loops — a typed `VVec::Temporal` with per-kind comparison (and `DURATION` SoA
early-resolve on `months`) would push these further, at real risk to the hot path.
Deferred until a temporal-heavy workload justifies it; the gather already delivered the
low-risk majority (project 2×, the rest ~1.4–1.5×).

## Prerequisite shipped

Date/datetime range overflow (`instant ± huge duration` past the i32 day range) now
raises `E_DATA_EXCEPTION` in both engines (native `FAULT_DATE_OVERFLOW`), superseding
the old D4 → null — same policy as duration overflow and division by zero. The i32
date wall is retained (Arrow `Date32`-aligned; covers all real dates), which is what
keeps the packed date column at 4 B.
