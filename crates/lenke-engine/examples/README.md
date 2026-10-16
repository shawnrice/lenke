# Benchmarks

The `lenke-engine` bench corpus. **Look here before writing a new one** — the
suite is indexed by _question_, and the answer to yours is very likely already a
case in one of the group binaries.

Two kinds of entry point:

- **Themed group binaries** (`ingest_bench`, `query_bench`, …) — each groups a
  subsystem's questions as selectable _cases_. This is the consolidation: one
  binary per subsystem instead of one per question.
- **`bench_all`** — runs every group in one process. This is the **regression
  sweep**: run it to catch a slowdown in a subsystem you did not think you
  touched. The per-group binaries are for iterating on one subsystem.

A handful of focused probes stay as their own binaries because they answer one
sharp question with a bespoke fixture (see the bottom).

## Running

```
# the whole corpus, for a regression sweep
cargo run --release --manifest-path crates/lenke-engine/Cargo.toml --example bench_all

# one subsystem
cargo run --release --manifest-path crates/lenke-engine/Cargo.toml --example query_bench

# one case (a substring matched against each case's `group/case` label);
# works on any binary, including bench_all
cargo run --release ... --example query_bench -- seeded
cargo run --release ... --example bench_all   -- index
```

Environment: `BENCH_REPS=<n>` (samples per case, min is reported; default 7),
`BENCH_N=<n>` (primary sweep size; default 200k). Native only — these use
`std::time::Instant` and cannot run under wasm. For the pure-TS / wasm / FFI
comparison, use `cd packages/native && bun run bench` instead.

**The chain-DEPTH question lives in the TS harness, not here:** `cd packages/native && bun run
probe:depth` prints ns PER PATH for a fixed-length `count(*)` chain at 2-11 hops on BOTH engines
side by side, and whether they agree on the answer. It is over there because the question is
inherently cross-engine — item 298 used it to find that native's count arms stopped at three hops
while the TS ones stopped at four, so each engine's cliff was invisible from inside its own
harness. The RATE is the signal: a degree product's ns/path falls as the path count grows, an
enumeration's is flat.

## By question

| If you are asking…                                                     | Run                                  |
| ---------------------------------------------------------------------- | ------------------------------------ |
| Where does NDJSON decode time go?                                      | `ingest_bench -- phases`             |
| How close is decode to the raw-scan ceiling?                           | `ingest_bench -- ceiling`            |
| What does parallel decode / encode buy?                                | `ingest_bench -- threads` / `encode` |
| How many resident bytes does an element cost?                          | `ingest_bench -- mem`                |
| What does a GQL / Gremlin query shape cost?                            | `query_bench -- gql` / `gremlin`     |
| Which counts still enumerate vs shortcut?                              | `query_bench -- counts`              |
| What does a row cost, by what is returned?                             | `query_bench -- perrow`              |
| What does turning query text into a plan cost?                         | `query_bench -- plan`                |
| How many allocations does a parse or a DECODE make, and of what sizes? | `alloc_count_probe`                  |
| Would a parse CACHE change any plan? (prepared vs direct)              | `prepared_parity_probe`              |
| Does an indexed key seek beat a scan?                                  | `query_bench -- seeded`              |
| What does a bulk write (SET) pay?                                      | `storage_bench -- write`             |
| What does a second label on every edge cost?                           | `storage_bench -- multilabel`        |
| What do the graph algorithms cost, and how do they parallelize?        | `algo_bench -- run` / `parallel`     |
| What does neighborAggregate cost? a CALL's dispatch vs its projection? | `algo_bench -- neighboragg` / `call` |
| What does a map/record property cost vs flat scalars (stored, codec)?  | `value_bench -- maps` / `codec`      |
| How do shapes scale across the cache transition?                       | `scale_bench -- sweep`               |
| What does content-derived CDC scope extraction cost per write?         | `scale_bench -- cdc`                 |
| What does a scalar min/max cost by COLUMN TYPE and ENCODING?           | `strag_421`                          |
| What does a PAGED query pay, and does the page's depth matter?         | `skippage_428`                       |
| What does a filter's EXPRESSION cost, at equal selectivity?            | `exprpred_437`                       |

**Deferred** (need crate-private access or a large bespoke fixture, so not in a
group binary yet): the eval-vs-columnar floor (`eval_vec` is crate-private — it
lives as an ignored test), temporal-column cost (`temporal_bench`, needs host
`Temporal` construction), and the AML / HRIS domain-shaped workloads. **Not
coming back** — the core-vs-engine (`cross_engine_shortcuts`) and Gremlin-arm-vs-IR
audits (`arm_audit`, `migration_arm_price_audit`, …) priced migrations that are
complete, and query-parallelism benches (`bench_parallel_query_speedup`) target an
evaluator the engine does not have.

## The focused probes (stay their own binary)

Each answers one sharp question with a bespoke fixture, and opens with that
question in its module header — read the header before touching it.

- `expand_bench` — what a type-filtered `expand` pays to scan a node's whole
  adjacency and filter by edge type (scales with degree × type spread).
- `interval_bench` — what an "as of T" bitemporal query pays to post-filter all
  of a node's edges by validity interval, vs an interval-index seek.
- `frontier_guard_probe` — does the intermediate-frontier guard REFUSE a runaway before it
  allocates, and does it leave everything else alone? Written after an OOM took a 61 GB box into
  its swapfile (item 296). **Run it under the cap** — the header gives the line. Its most useful
  property is the one that cost two wrong readings to find: it prints whether the optimized plan
  actually contains an `Expand`, because `count(*)` and `count(far.k)` over a multi-hop chain are
  both answered by an exec-level TALLY and never expand at all. A bare projection is the shape
  that materializes.
- `percall_probe` — where a SERVING-SIZED call's time goes, measured in-process so the FFI is
  not in the way. `bun run bench:usage` shows the native engine losing 3-5x to pure TS on every
  indexed small-op row, and the natural suspect (the FFI boundary) is innocent: a `vertexCount`
  round trip is **8ns**. This prices the layers that are not — parse, optimize, exec, plan clone,
  JSON render — and exists because item 291's conclusion turns on their RATIO, which no bench
  reports. Read it with the audit entry; the numbers are what any attempt at the parse cost has
  to beat.
- `prepared_parity_probe` — would a PARSE CACHE in the native engine change any answer or any
  route? `lnk_query` parses and optimizes on every call with no cache, while the TS engine has had
  both since items 228/229, and a cache must hold a PREPARED plan (`$n` stays an `Expr::Param`)
  rather than a direct one (`$n` is substituted to a literal during the parse) — two different
  parses. This compares their optimized plans shape by shape, against a store with and without an
  index on the gated key, because a substituted literal could seed an index a bound param would
  not. Ten of fourteen are identical; the carve-out worth the binary is the one with no wrong
  answer to give it away — **a parameterized INSERT plans as `InsertFrom`/`InsertNodeExpr` instead
  of the literal `Insert` path**, so a cache would silently cost it performance. Re-run it before
  widening what the cache admits.
- `alloc_count_probe` — how many heap allocations `gql::parse` makes, and of what SIZES. A
  counting global allocator, which is why it is its own binary: it would perturb every other case
  in a shared process. Written at item 317 to settle a target that had been recorded as
  "structural rather than allocational" — it is 50 allocations and 4187 bytes for a 57-byte query,
  and the size histogram resolves the small end exactly because that is what names them (an
  8-byte one is an identifier the lexer built, a 1-byte one is a variable name the descent
  CLONED). Read it with the audit entry: three plausible suspects were eliminated by counting
  them, each more cheaply than assuming would have cost.

  It also counts the **NDJSON decode** (added at item 331), because the staged-record borrow
  target had been priced from a micro that turned out 5x high and a count is the instrument that
  does not have that failure mode. Two things there are worth copying rather than re-deriving:
  differencing SMALL documents does NOT attribute a per-line cost — at a few lines the store's own
  HashMap growth swamps it and a difference comes out negative — while varying ONE field of the
  fixture at 50k lines does, because the bucket that moves by ~50k names itself. That is how the
  three 1-byte allocations per edge property were pinned to the property KEY (widen the key, and
  all three move buckets together), which found two of them wasted.

- `limit_product_probe` — what a CORRELATED cross product under a keyless `LIMIT`
  pays, and whether the cap reaches it at all. Its fixture is why it is its own
  binary: a tiny left side against a large right one, which the shared social
  fixture has no equivalent of (a correlated product over 200,000 x 200,000 is not
  a measurement). Items 282, 283 and 288 each re-derived these numbers; the
  CONTROLS are the valuable half — the one-sided spelling, the uncapped product and
  each side's own pull bound what any design here can win.
- `scan_layout_probe` — whether a different COLUMN LAYOUT would make predicate
  scans faster, and whether it survives mutation (it prices each layout twice: the
  scan, and what one point write costs to maintain it). The answer to "is SIMD
  worth it here" runs through this: today's loop gathers, gates on a byte and
  materializes ids, which defeats vectorization before the value layout matters.
- `bitmap_layout_probe` — whether a predicate can become BITMAP ARITHMETIC rather
  than value comparisons (recursive frequency encoding; bit-sliced index), what
  each costs to mutate, and whether it reaches the vector units. It does: the
  circuits compile to `vandps`/`vorps`/`vandnps` over ymm with no intrinsics.
- `simd_index_probe` — a 71-experiment campaign: bitmap indexes first (E1-E36),
  then the real planner (E37-E71). The bitmap half hunted speedups in explicit AVX2
  (nothing — LLVM already vectorizes), early exit (nothing), value
  recoding (nothing), sparse containers (worse), against conjunctions (5.7x
  end-to-end), counts (the mask IS the answer), block skipping (up to 6.1x, but only
  on clustered data), and aggregates — filtered GROUP BY is 175x and a maintained
  counter table answers an unfiltered one in 10ns. The capstone (E36) is 23.1x on a
  realistic dashboard query, 5.4x of which needs only the filter side. Read it before
  re-attempting any of the eight rejected ideas.

  E37-E71 then turn from bitmaps to the real planner, and most of that stretch is
  about not fooling yourself. E58-E66 drove the one-hop `orient` rewrite (a far-side
  predicate reaches an index only if the far node is WRITTEN with a label, since
  `RangeSeek` requires one). E64-E65 give the seek-vs-scan rule: scan 1.88 ns/node,
  seek 12.2 ns/row, so the crossover is 15.4% selectivity. E67 is the 300x pushdown
  cliff where adding a label made a query slower.

  **E68-E71 are one thread with a negative result, and the most useful part.** A
  residual filter above an `Expand` appeared to cost `count(*)` 15x. It does not:
  `count(*)` over a bare `Expand` sums adjacency LENGTHS — O(sources), never visiting
  an edge — and any endpoint predicate must visit every edge. E71 proves it by
  holding sources fixed and scaling the degree (unfiltered flat at ~33us, filtered
  196->712us). Four attempts to "fix" the non-problem are recorded with their
  numbers, including a fold that was 3.1x WORSE. Do not re-open without a way to
  answer an endpoint predicate without visiting edges.

- `exprpred_437` — what does an EXPRESSION cost inside a filter, as opposed to the rows
  it selects? Every pair of cases selects exactly the same rows and differs only in the
  predicate's shape, so a gap cannot be the selectivity: `a.k > 5` against
  `a.k + 0 > 5` (one addition), against `a.k * 1 > 5`, against `abs(a.k) > 5`, and
  `a.k = 1` against `NOT (a.k <> 1)`. Run it before adding a shape to
  `try_filter_keep`'s pattern list, and before believing any claim that a predicate form
  is "basically free".

- `skippage_428` — what does a PAGED query pay, and does the depth of the page matter?
  Asked because the TS engine's generic tail projected every row before paging (item
  427). Native does not: a shallow `SKIP 100 LIMIT 20` costs 0.001 ms at 1,000,000 nodes
  because the input stream is paged lazily, and the 2.556 ms a `SKIP n-5` costs is the
  unavoidable walk of a million inputs, not projection of skipped rows. It carries the
  unpaged projection of the same rows as the ceiling and `count(*)` as the floor, so
  "native already pages lazily" is read off two controls rather than asserted.

- `skipcast_426` — NOT a benchmark: a CONFORMANCE probe. Does a SKIPPED row's projection
  still get evaluated? The engine's stated rule is "project exactly the rows you emit",
  and a `SKIP` does not obey it — `CAST` faults on a row `SKIP 1 LIMIT 1` cannot emit,
  while the same query with an `ORDER BY` succeeds. Both engines agree on all four
  spellings, so the differential fuzzer cannot find it. Run it before changing paging in
  either engine.

- `strag_421` — the column-TYPE question for a scalar aggregate. `try_scan_num_agg`
  folds a `Num` column and its gate declines every other ("non-numeric column: the
  general path handles poison"), so: what does `max(n.s)` over a string cost, and does
  the answer depend on the ENCODING? It prints `scan_is_cheap` per key, because "the
  dict arm is 14x" is only a claim about the dict arm if the fixture produced one — and
  a 3-distinct-over-3-rows fixture is NOT dictionary-encoded, which is how a first
  version of item 421's unit test came to test the wrong arm. Sweeps 50k/200k/1M and
  carries the numeric fold, the count over the same column and the projection of it as
  controls. `PROBE_ONLY=<substring>` runs one case per process, which is what separates
  a real control movement from allocator contamination by the targets ahead of it.

- `spelling_probe` — that equivalent query spellings optimize to the SAME plan
  and so cost the same (a plan mismatch is the real signal; time is the backstop).

- `seedspell_401` — WHICH predicate spellings reach an index seek at all. The prior
  question to `spelling_probe`'s: that one checks two spellings agree, this one checks
  each one seeds. It groups equivalent spellings, prints SEEK or scan per member from
  the PLAN (a scan that is fast on this fixture is still the bug) and flags any group
  whose members disagree — on seeding or on the row count, so a spelling that "seeds"
  by changing the question is visible too. Two live flags it found: item 402's point
  equality on a range-indexed key, and `NOT (k <= v)`, which scans where `k > v` seeks
  and CANNOT be rewritten naively — see the audit for the NaN reason.

## Before trusting a number

The hard-won rules live in the repo `CLAUDE.md` ("Benchmarks: look before you
build") and are enforced by the shared harness: min-of-N (never a mean),
`black_box` every result, a dep-free deterministic RNG, and **sweep the size**
across the 200k–1M cache transition rather than trusting one point. Record a
rejected optimization with its numbers next to the code it would have changed —
several have been re-attempted for want of that note.
