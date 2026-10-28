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

| If you are asking…                                                               | Run                                  |
| -------------------------------------------------------------------------------- | ------------------------------------ |
| Where does NDJSON decode time go?                                                | `ingest_bench -- phases`             |
| How close is decode to the raw-scan ceiling?                                     | `ingest_bench -- ceiling`            |
| What does parallel decode / encode buy?                                          | `ingest_bench -- threads` / `encode` |
| What does each ENCODE format cost, per byte? (incl. the FFI `binary` snapshot)   | `ingest_bench -- codecs`             |
| How many resident bytes does an element cost?                                    | `ingest_bench -- mem`                |
| What does a GQL / Gremlin query shape cost?                                      | `query_bench -- gql` / `gremlin`     |
| Which counts still enumerate vs shortcut?                                        | `query_bench -- counts`              |
| What does a row cost, by what is returned?                                       | `query_bench -- perrow`              |
| What does turning query text into a plan cost?                                   | `query_bench -- plan`                |
| How many allocations does a parse or a DECODE make, and of what sizes?           | `alloc_count_probe`                  |
| Would a parse CACHE change any plan? (prepared vs direct)                        | `prepared_parity_probe`              |
| Where does a lookup table stop being cheaper than a slice scan?                  | `bind_probe`                         |
| Does an indexed key seek beat a scan?                                            | `query_bench -- seeded`              |
| What does a bulk write (SET) pay?                                                | `storage_bench -- write`             |
| What does a second label on every edge cost?                                     | `storage_bench -- multilabel`        |
| What do the graph algorithms cost, and how do they parallelize?                  | `algo_bench -- run` / `parallel`     |
| What does neighborAggregate cost? a CALL's dispatch vs its projection?           | `algo_bench -- neighboragg` / `call` |
| What does a map/record property cost vs flat scalars (stored, codec)?            | `value_bench -- maps` / `codec`      |
| How do shapes scale across the cache transition?                                 | `scale_bench -- sweep`               |
| What does content-derived CDC scope extraction cost per write?                   | `scale_bench -- cdc`                 |
| What does a scalar min/max cost by COLUMN TYPE and ENCODING?                     | `strag_421`                          |
| What does a PAGED query pay, and does the page's depth matter?                   | `skippage_428`                       |
| What does a filter's EXPRESSION cost, at equal selectivity?                      | `exprpred_437`                       |
| What does ONE scalar function call cost, and is its name vectorized?             | `scalarfn_bench`                     |
| Why is DETACH DELETE the slow write, and in WHAT does it scale?                  | `detach_442`                         |
| What does `RETURN DISTINCT <temporal>` cost PER KIND, and which reach the keyer? | `temporal_distinct_1015`             |
| And what does a statement-position `ORDER BY <temporal> LIMIT k` pay?            | `temporal_distinct_1015` (topk)      |
| What does a LABEL NAME's length cost an element render, per row?                 | `labelhoist_1068`                    |
| And an EDGE element, by edge-type COUNT and name length?                         | `edgelabel_1069`                     |
| What would `Value::Map(Arc<[_]>)` save over `Arc<Vec<_>>` at render sizes?       | `mapalloc_1070`                      |
| What does ONE property CELL cost an element render, by properties per node?      | `propcells_1071`                     |

**Deferred** (need crate-private access or a large bespoke fixture, so not in a
group binary yet): the eval-vs-columnar floor (`eval_vec` is crate-private — it
lives as an ignored test) and the AML / HRIS domain-shaped workloads. (The
temporal-column note that used to sit here said host `Temporal` construction was
the blocker; `lib.rs` re-exports `temporal` publicly, so it is not —
`temporal_distinct_1015` builds its fixture that way.) **Not
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
- `topk_864` — what does a CLAUSE-position `RETURN x ORDER BY <prop> LIMIT k` pay by key
  representation? The same query over four columns of ONE fixture that differ only in
  representation — `age` (Num), `name` (Str, N distinct), `city`/`dept` (Dict, 8- and 5-way) —
  between a `count(*)` floor and a no-`LIMIT` full-sort ceiling. **Its header originally credited
  this to `try_scan_top_k` and that was wrong** (item 865): a clause-position `ORDER BY` sorts
  above the projection, so the plan is `OrderPage{Project{Scan}}` and `try_late_materialize`
  handles it — an instrumented build showed `try_scan_top_k` is never entered by any query in this
  file. So read this table as the late-materialize path's, and use `topk2_864` for the fast path.
  The ceiling column is the useful part either way: the fallback already partial-sorts, so it sits
  6.8x BELOW a full sort and the representation gap is only 1.7-1.9x.
- `topk2_864` — the SPELLING × representation table, and the instrument for `try_scan_top_k`.
  `MATCH … ORDER BY k LIMIT n RETURN x` (statement position) leaves a bare `Scan` under the sort
  and reaches the streaming top-K; `MATCH … RETURN x ORDER BY k LIMIT n` (clause position) does
  not. Two equivalent spellings, two code paths — which by this repo's own rule must still cost the
  same, so the probe prints both. It is also where the dictionary arm's ≥1785x was measured: a
  dictionary key has a bounded rank, so once `skip+limit` rows at the extreme rank are seen in
  arrival order the scan can STOP.
- `parseplan_883` — the native half of "what does a parse+plan cache MISS cost?". A FRESH query
  text per iteration so no cache can serve it, with `textOnly` as the control that `format!` is not
  what is being measured. Native: parse **0.653 us/op**, parse+optimize **0.734**. The TS twin
  (`packages/native/parseplan-cost-probe.ts`) reads 2.962 and 3.979 on the same statement — so the
  TS PARSER is 4.5x native's and the TS PLANNER adds ~1.02 us against native's 0.08, 12.6x. Read
  the pair together; either alone says nothing about whether a number is large.
- **TS-side companion, no Rust twin:** `packages/native/lexer-census-probe.ts` — WHICH of the
  tokenizer's scanners carries the characters? A static census, not a timing, for choosing a target
  before changing one: identifier characters are **46-60%** of a realistic query, whitespace 11-18%,
  punctuation 6-20%, and string literals **3-12% of the benchmark fixtures but 49.7% of ordinary
  string-heavy application query text**. Every row re-sums to its own length, so no class is dropped
  or double-counted. It is what told item 886 to change the identifier scanner AND the string
  scanner, and to measure them on separate arms.
- **TS-side companion, no Rust twin:** `packages/native/lexer-split-probe.ts` — of the TS parser's
  cost, how much is the TOKENIZER and how much the recursive descent above it? Items 885 and 886
  both changed the tokenizer without knowing its share. Answer: **28% on a 7-token statement rising
  to 54% on a 60-token one**, so the descent is the larger half on most shapes and "keep going in
  the tokenizer" was an assumption. It reaches into `packages/gql/src` deliberately (`tokenize` is
  not public, and both halves must come from ONE compilation), so its absolute figures are NOT
  comparable with `parseplan-cost-probe.ts` — only its two arms with each other.
- **TS-side companion, no Rust twin:** `packages/native/nested-read-ladder-probe.ts` — where do the
  ~75 ns a row go that make a TS nested read 3.4x a flat one? A ladder of QUERIES (no engine change,
  no deliberately-wrong arm), each rung reading one stage more than the one below. Answer: reading a
  RECORD-valued property costs the SAME as a scalar one (−0.8 ns/row), so the whole gap is the FIELD
  step, 75.8 ns/row. Inside it: `LenkeRecord extends Map` is NOT the cause (a subclassed `Map.get`
  is 17.5 ns against a plain one's 17.7), and `has+get` costs no more than `get` alone — but a
  `Map.get` is **4-7x a plain-object property read** (17.7 against 4.3 ns), which prices the
  representation at ~13 of the 75.8 and leaves ~63 as expression plumbing.
- **TS-side companion, no Rust twin:** `packages/native/compile-spelling-probe.ts` — do equivalent
  spellings cost the same TO PLAN? `bun run spelling` only checks RUNTIME. They do not: against a
  shared no-predicate control, one predicate on one node costs **+0.409 us as an inline `{k: 1}`,
  +1.021 as an inline `WHERE`, and +1.793 as a clause `WHERE`** — a 4.4x spread for one question,
  disjoint across three alternated rounds. It also prints the planner BY SHAPE, which is the other
  half of the finding: a MATCH plans for **18x** what a longer INSERT does (2.65 us for
  `MATCH (n) RETURN n` against 0.53 for a 47-char INSERT), so item 883's single-INSERT figure for
  "the TS planner" understated the MATCH case by that much.
- `dottedindex_895` — why is a query SLOWER with an index on a dotted key than without one?
  `value/maps`'s indexed arms read `map field meta.city` at **10699.5 us indexed against 2594.8
  unindexed, 4.1x slower**, and the flat twin 306.0 against 253.9. Not a planner bug: at 4 distinct
  values over 200k nodes the predicate matches ~25%, above the 15% `SEEK_MAX_FRACTION` cap, so
  `seek_beats_scan` correctly rejects the seek. The probe prints the surviving `IndexSeek` count and
  settles it — **without** an index the plan keeps an `IndexSeek` that executes as the no-index
  fallback filter (the path items 359/893/894 optimized); **with** one it becomes `Scan` + `Filter`,
  a different evaluator that materializes the whole base column. Two unindexed paths for one
  predicate, 4.1x apart, and the cost model chooses between them on grounds that do not include it.
- `barehop_882` — is native's bare-hop cost ENGINE time or FFI serialization? Item 881's new bench
  row showed `V().out()` at native 329.61 ms against TS's 185.4, which looks like native being the
  slow side. This runs the same plans IN PROCESS (`exec::try_run`, no boundary) and answers it:
  266.98 ms, so the cost is the engine. It then puts that next to the shapes that return the same
  1,000,000 rows as a SCALAR — `id()` 20.64, `values(age)` 4.95, and the GQL twins `RETURN b` 266.75
  against `RETURN b.age` 5.82 — which is the 46x that matters. **The conclusion is a retraction, not
  a target**: native materializes an OWNED element per row (external id, sorted labels, property
  map) where TS returns a reference, and that render loop is already item 828's column-major rewrite
  with a further hoist refuted at 829. Every row prints its ROW COUNT because the shapes differ in
  what they return, not just in speed.
- `edgecount_877` — every spelling of "how many edges are there", in both front ends, each with
  its PLAN (`PLAN=1`) next to its time and its answer. Written because `E().count()` was the last
  bench row where native was the slow side, and it found something much larger on the way:
  `g.E().hasLabel('KNOWS').count()` lowers to `Aggregate{Filter{EdgeScan, IsLabeled}}`, which no
  fast path claimed, against `MATCH ()-[:KNOWS]->() RETURN count(*)` answering the same question
  from a CSR partition length — **89,800x**. It also pins the semantics a label-set count depends
  on: a multi-label `hasLabel` is an OR (every edge on a two-type fixture) and an unknown label is
  0, both measured here rather than assumed. The remaining row is `live_edge_count`'s own O(V) sum
  (~33 µs at 1M edges), which is why the untyped hop count stops at 0.0325 rather than 0.0003.
- `vacuouslabel_876` — what does a VACUOUS label cost? `V().hasLabel('Person').out('KNOWS')
.count()` measured 0.5380 ms against 0.0003 for `V().out('KNOWS').count()` — the same question,
  since every vertex in the fixture is a `Person` — because the O(1) CSR-partition shortcut
  required `Scan { label: None }` literally. Both front ends, both spellings, with a SELECTIVE
  label (`Staff`, 1 in 50) as the control that must keep filtering: an elision firing there would
  answer every edge instead of the labelled sources' edges, which is why every row prints its ROW
  COUNT. `PLAN=1` dumps the three plans (they differ only in the `Scan`'s label); `TOMB=1` prints
  what a `delete_node` does to the label list, which is the fact the coverage predicate rests on.
- `filtercensus_871` — which column REPRESENTATIONS does a filtered scan have a fast path for?
  One fixture whose five columns differ ONLY in representation (Num, Dict, Str over the 4,096
  dictionary cap, Bool, Date), each predicate built to select the same 1/50 of rows. Two controls
  per row and they answer different questions: `count(*)` reads no property (the floor) and
  `WHERE true` runs the filter machinery over every row while keeping them all — so if `WHERE
<pred>` and `WHERE true` agree the predicate is free and the cost is the scan, and if they
  diverge the predicate is the cost. That pair is what showed the Date predicate costing 3.8x
  `WHERE true`, i.e. more than the generic boolean path it should beat. `PLAN=1` dumps the
  optimized plan for three predicates instead of timing them, which is how item 871 found that
  EQUALITY lowers to `IndexSeek` and never reaches the filter family at all; `XKIND=1` prints what
  a cross-KIND temporal comparison does (0 rows, no fault) — the fact a fast path's `kind` bail
  depends on.
- `keyless_870` — do the two spellings of a KEYLESS `LIMIT` converge natively? The TS engine's
  statement-position keyless page forced the whole working table and sliced (36.68 ms against 0.04
  for the clause spelling, item 869), so this asks the same of native across seven pairs: bare,
  with an `OFFSET`, on a string key, after a `WHERE`, after a selective `WHERE`, and after a hop —
  the last three being where `pull_capped` declines and `pull_capped_stream` takes over. All seven
  land within 1.5% and ~1000x below the no-`LIMIT` ceilings the table also prints, so the defect is
  TS-only. Keep the ceilings: without them "0.0002 ms" says nothing about whether a cap applied.
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
- `bind_probe` — `bind_params`' lookup table: a `HashMap` build against a slice SCAN, swept over
  parameter count x `$name` occurrences. The useful question is not "is a scan faster at one
  parameter" (it is, 32.9ns against 2.0) but WHERE IT STOPS BEING FASTER, since a scan is O(P) per
  lookup against the map's O(1) — and the answer is that it does not, up to 32 parameters with 16
  occurrences, because the map's BUILD cost dominates throughout. Exists because the win is ~30ns
  on a serving call, which is ~1.5% of it and below `bench:usage`'s ~+/-6% floor: the bench can
  only certify no regression, so the claim needs its own harness (item 598).
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

- `detach_442` — why is `DETACH DELETE` the one write native is not fast at? Three sweeps,
  each varying ONE thing: edges 8x with the deleted count fixed (FLAT, so it is not a scan
  over the edge set), the deleted count 50x with edges fixed (linear, constant per node),
  and the NODE count 8x with the deleted count fixed (LINEAR per node — which is the
  answer). Run it before touching `delete_node`, and keep the three sweeps: any two of them
  alone are consistent with the wrong explanation.
  **Sweep E is a different question on the same subject (item 920): what does ONE `delete_node`
  cost, and in what does it scale?** A-D all drive `DETACH DELETE`, which batches into
  `delete_nodes` and so measures the BATCH path; a single delete takes the targeted arm instead.
  Its `big` arm puts the victim's own label around every node and its `small` arm puts the victim
  in a 200-node label beside a big one. **`small` is NOT a control** — its own bucket is still
  rewritten, so a change to bucket removal reaches it; it pins the cost to BUCKET SIZE. The control
  for the targeted arm is sweeps A-D, which cannot reach it.

- `churn_925` — what gets slower as a store CHURNS? Every other fixture here varies graph
  SIZE; this one pins the live set at 20,000 and varies **ids ever created**, which is the axis
  item 818's open anomaly is about. It refuted that anomaly's hypothesis: the indexed seek is
  FLAT across 1,000,000 create-and-delete pairs (67.2 -> 67.2 ns) and so is the unindexed
  CONTROL, while `add_node`/`delete_node` step ~1.4x between 100k and 300k churn and then come
  back DOWN at 1M — bounded, not a leak. **Keep the control column**: the unindexed scan is
  what makes "the index is innocent" a measurement rather than an assertion. Run it before
  believing any claim that a cost grows with churn.

- `setindexcount_922` — does the INDEX COUNT cost a `SET` on a key none of those indexes
  covers? `apply_set_prop` asks `index_on_base(key) || is_range_indexed(key)` before every
  write, and both were linear scans, so the answer was yes: 22.6 ns at 0 indexes rising to
  43.1 at 64. Varies the index count, which **nothing else in this corpus does** — with zero
  indexes the scans are an empty-iterator check and cost nothing, which is why no other
  fixture can see this. Keep the `add_edge` control: it never reaches `apply_set_prop`, so if
  it climbs with the index count the probe is measuring the index maps' memory instead. Note
  that `small` in `detach_442` sweep E and the `SET indexed` column here are NOT controls —
  both are reached by the code under test.

  `detach_442` gained **sweep F** alongside it (item 923): one delete at a time with the NODE
  COUNT FIXED and the DISTINCT LABEL count rising, which is the axis sweep E holds constant.
  Its before curve is NON-MONOTONIC — 0.43 / 0.18 / 0.71 / 4.02 µs at 1 / 10 / 100 / 1000
  labels — because item 920's memmove runs over a bucket of N/L and falls while the bucket
  loop runs over L and rises. **Keep all four points:** a sweep stopping at ten labels sees a
  cost that is going DOWN and concludes there is nothing to fix.

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

- `scalarfn_bench` — the per-call question for the scalar library. `Expr::Call` is a chain of
  specialization tables consulted by NAME and arity (`unary_num_fn`, `unary_str_fn`,
  `binary_str_pred_fn`, `binary_num_fn`; items 759, 765, 766) and anything no table claims falls to
  the general per-row dispatch, so "is this name vectorized?" has a measurable answer. It exists
  because items 759, 765, 766 and 767 each rebuilt an ad-hoc harness to ask it — four times for one
  question. Every case is `count(f(a.s))` over the same rows, so only the expression differs, and
  two controls sit at the bottom: `count(a.s)` with no call at all, and `count(abs(a.n))`, a
  vectorized NUMERIC call that no string-side change can reach. `size` is in the list on purpose —
  it is on the general dispatch and returns a `Num` without allocating an output string, which is
  `char_length`'s shape on the vectorized path, so the pair separates "the fast path buys nothing"
  from "the fast path is not firing". That is what refuted extending the table at item 783: the two
  land 0.2 ns apart, while the 1.5 ns that separates the two bands is the OUTPUT STRING
  allocation. The fixture mixes ASCII and non-ASCII because `utf16_len` has an ASCII fast path
  (item 767), so an all-ASCII fixture prices `char_length` as a different function than it is.

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

**Scraping these tables is where the output bites back.** A row label is not unique and a
column is not always a time, so a script that greps by label prefix and keeps the minimum can
silently measure something else. Item 629 hit both in one run: `2-hop` prefix-matches
`2-hop + filter` in `query/plan`, whose column is a **ratio** (1.68) rather than microseconds,
and the min picked the ratio; `1-hop` and `2-hop` each also appear in **two** timing sections
(`query/gql` and `query/counts`), so a min across them silently mixes two different shapes.
Qualify by the `=== section ===` header, match the label EXACTLY, and take the first
occurrence per run.
