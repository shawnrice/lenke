# Closed, refuted and settled — read this BEFORE measuring or flagging

`2026-08-31-ts-audit.md` is append-only and 23,000 lines. It records **what was decided**, in the
order it was decided, which makes "has this already been closed?" expensive to answer and easy to
get wrong. This file is the answer to that question.

Three times in one session a pass re-derived something already closed (items **246**, **247**,
**257**). Each time the pass _did_ search first and searched the **wrong store**. So:

| the kind of fact you want                 | where it lives                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| "has this perf lever been tried?"         | **this file**, then the audit item it cites                                                                                     |
| "what does ISO say about X?"              | the session notes, then `../conformance/references.md` — **not** the audit, which holds the decision X blocks, not the evidence |
| "what did that measurement actually say?" | the audit item that measured it                                                                                                 |
| "is this semantics settled?"              | **this file**, §2                                                                                                               |

The audit's own rule is quoted in several items as _"CHECK THE REFUTED LIST before measuring"_.
**Until now there was no such list** — that absence is what the three re-derivations have in
common. Keep this file current: when an item refutes a lever or settles a question, add the line
here in the same commit.

---

## 1. Refuted perf levers — DO NOT RE-MEASURE

Each of these was built or priced and **rejected with numbers**. Re-attempting one costs a tick and
produces the same answer.

| lever                                                                                            | verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | item                                       |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Type-first / inverted adjacency** `Map<type, Map<vertexId, Set<Edge>>>`                        | **REFUTED.** Wins the typed lookup 2.2-4.1x, **loses get-by-id 1.4x at three edge types and 4.8x at twenty**; the crossover is between T=1 and T=3 and a people graph has 5-20. The dual-spine variant costs **2.0-2.4x on `indexEdgeLabel`**, the most expensive thing the engine does. Only surviving direction: an **opt-in** index — a feature with an API, not an optimization. **User-confirmed closed.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 197 priced, **200 refuted**, 247 confirmed |
| **An adjacency "box"/row cache** for `edgesFromByLabel.get(id)`                                  | **REJECTED — bad trade.** Row lookup is 14ns isolated / 46ns in context; a cached row reads 128ns against 174, dense-array ceiling 97 — **1.35x for a cross-cutting cache needing invalidation on `addEdge`/`removeEdge`**. Re-derived at 246 and corroborated end-to-end at 1.09-1.14x; the rejection stands.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **172**, 246                               |
| **The var-length walk's per-frame `{edge,node}` allocation**                                     | **REFUTED.** Built it; in-process A/B of both bundles read **1.025x, overlapping**, and the control the change cannot reach moved _further_ (0.928x). At ~400ns a path, N nursery objects at a few ns cannot be a measurable share.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | **245**                                    |
| **`satisfies`' per-call iterator allocation**                                                    | **REFUTED.** A ladder attributed **64%** of the gap to it and the fix made it 2.4x cheaper — and the A/B read **1.02x overlapping**. Reverted. A ladder that skips the caller's call site misattributes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | **241**                                    |
| **Any edit to `exec::pull`'s layout**                                                            | **WON'T-GAIN.** Costs the filtered-count cluster **1.08-1.24x and never gains** — that is the toll, not a regression. Widened at 250: the cluster is layout-sensitive **crate-wide**, not just to `pull`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | **90**, 250                                |
| **Coalescing the per-write microtask**                                                           | **REFUTED at 0.4%** of total; the sync loop does not move (2329 vs 2331).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | **202**                                    |
| **Reading `this.#id` instead of the `id` getter**                                                | **REJECTED.** Flat on every row, rounds disagreeing on the sign — JSC inlines a getter whose body is a private-field read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 118                                        |
| **A positional column pair instead of `types.get(key)` per cell** (CSV encode)                   | **REJECTED.** CSV encode has no cheap win; two levers priced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 118                                        |
| **The TS insert path** (`addVertex`/`addEdge`)                                                   | **CLOSED as a constant factor** — 3.7x, and it is `JSON.parse` + alloc + freeze, not a missing path. The recorded "71% is `indexEdgeLabel`" was **withdrawn → 34.1%**. ~~Single remaining target is `addVertex` itself.~~ **Withdrawn at 312**: `addVertex` is 7.4% of the ingest row and `addEdge` ~85%. Inside `addEdge`, the label index is 28% and `edgesById.set` 10%; the 20% emission 312 also listed is **not in the decode row at all** (313 — decode disables events), though it is 1.46x cheaper now for every API write.                                                                                                                                                                                                                                                                                                                                                                                                                                | 140, 201, **203**                          |
| **The end-filtered multi-hop reversal**                                                          | **WON'T-FIX despite 48.7x.** Native prices it and declines on purpose; the remedy is an **index** (53.6x). Recorded with numbers precisely because a 48.7x in a probe invites a later sweep.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | **223**                                    |
| **Gremlin `V().out().has().count()` and `V().has().count()`**                                    | **SHARED FLOOR, not a Gremlin gap.** `filteredHopCount` already exists and fires. The GQL spelling of the same question costs the same (50.8ms vs 51.9ms), so it is item 200's adjacency-lookup floor — a per-vertex `Map.get` on the id, ~180ns.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 161, 226, **235**                          |
| **Gremlin `V().out().values(k)`**                                                                | **TinkerPop ORDERING GUARANTEE, not overhead.** `hopValuesShortcut` fires at its documented rate; Gremlin groups by the START vertex where GQL groups by the FAR one, so the cheaper shape is not available.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 170, **235**                               |
| **`bun run bench`'s `query: project 3 columns` row (ts/ffi 0.14x) as an ENGINE gap**             | **IT IS THE JSON CARRIER, NOT EXECUTION.** The largest adverse ratio in that table, on the most ordinary shape there is — and the same fixture with the same work and ONE row out is **30.8x the other way** (`3 x count(prop)`: ts 73.95ms, native 2.40ms). Decomposed against the bytes the FFI returns: **`JSON.parse` 48%** (17.63ms for a 4.47MB carrier), the crate's render + FFI call 33%, `TextDecoder` 0.5%, row shaping 12%. ~80% is the carrier and no engine change touches it; `queryArrowIpc` is the existing answer. Every row native loses in that table has a huge result set and every row it wins big has a tiny one — read the table's SHAPE before reading its ratios.                                                                                                                                                                                                                                                                        | **289**                                    |
| **`scale/sweep`'s `filter_us` as a regression screen**                                           | **NOT A SCREEN.** Moves **8-10% for ANY native edit** — proven by a null control that only lengthened an error string. `1hop_us`/`labelcnt_us` in the same table are unaffected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | **250**                                    |
| **`VarLength {1,1}` at 9.2x `Expand`**                                                           | **UNREACHABLE.** The planner never emits `Plan::VarLength` for `{1,1}` or `{1}`; the harness builds it by hand and labels the row `(walker, unreachable)`. Verified by probe: `{1,1}` costs **0.99x** the plain hop, `{1,2}` correctly stays on the walker.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 86 labelled, **265 re-verified**           |
| **`plan_cost_by_operator`'s ABSOLUTES across runs**                                              | **NOT COMPARABLE.** They swing 2-3x: `EdgeScan` read 15.30 uncapped against 4.29 recorded, which looks like a 3.6x regression and is not — capped it reproduces at 4.45. And the cause is NOT "the cgroup adds overhead" (item 86's note): directions are inconsistent, `Scan` slower capped while `Expand` faster. Read ratios WITHIN a run; compare across runs only under identical conditions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **265**                                    |
| **`Tree` / `Enumerate` / `OrderPage` / non-constant `Unwind`**                                   | **OUTPUT-SHAPE COSTS, not overhead.** `Tree` 945 builds a nested map; `Enumerate` 283 renders an ELEMENT MAP per row because that is `index()`'s output; `OrderPage` 47 is a full sort (top-k exists at 9.69); the slow `Unwind` row genuinely reads a property per row while the common row-invariant spelling is already at 5.49.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 86, **265**                                |
| **Keying the TS `IN` haystack cache on the ARRAY'S IDENTITY**                                    | **A 2.9x REGRESSION on the sibling spelling — superseded at 269 by keying on EXECUTION.** `case 'list'` rebuilds its array per ROW, so an inline list of params (`IN [$a, $b, …]`, the injection-safe spelling applications actually write) missed the identity check every row and re-hashed the whole haystack: 203.73ms pre-268 → 587.42ms at 100 terms, against 8.42ms once keyed on `execEpoch`. **A per-execution epoch counter is therefore REQUIRED, not dead code** — item 268 deleted one after the mutant removing it survived, which was correct for the identity key (`reviveParamValue`'s per-execution copy already guaranteed a fresh array) and is wrong for this one: mutant M7 (never bump the epoch) is caught by three tests. **A guard's necessity is a property of the design it guards, not of the guard.**                                                                                                                                 | 268, **269**                               |
| **Capping the GQL parser's `IN` OR-chain WITHOUT folding the list to `Lit(List)`**               | **AN ACTIVE REGRESSION, 33x.** The cap alone measured **172.98ms at 33 items** against 5.18ms for the OR-chain it replaced, and 2819ms at 500: `in_set` matches ONLY `Expr::Lit(Value::List)`, so an inline `Expr::List` haystack makes it decline and `eval` BROADCASTS the list across the batch (200,000 rows x 100 elements = 20,000,000 `Value` clones) — item 185's original defect, re-created. **The cap and the fold are correct only together**, and a non-foldable list must KEEP the chain: linear beats broadcast.                                                                                                                                                                                                                                                                                                                                                                                                                                     | **267**                                    |
| **`eval_vec`'s missing `CExpr` arms (2.7-8.0x)**                                                 | **STALE — `eval_vec` NO LONGER EXISTS.** Only `examples/README.md` and `examples/support/storage.rs` mention it; it was `lenke-core`, deleted. Do not reach for those figures.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | checked 2026-10-08                         |
| **Mutating a guard that sits BEHIND other layers, as a single point**                            | **REPORTS VACUITY, NOT DEADNESS — and the two look identical.** Item 270's rewrite is gated on `e.kind !== 'or'`; the mutant removing that gate SURVIVES, because `uniformEqChain`'s `flatten` descends only `or`, so an `xor` arrives as one branch and is rejected twice more. The gate still defends a reachable drift: with `flatten` made to descend `xor`, the gate present SURVIVES (N6) and the gate removed is CAUGHT (N7). **To falsify such a guard the mutant must remove the layer that makes it redundant, in the same mutant.** Complement of item 269, where the counter really was dead against its key — only the right mutant distinguishes the two.                                                                                                                                                                                                                                                                                             | **270**, cf. 269                           |
| **Porting item 270's OR-chain→membership rewrite to the RUST engine**                            | **REFUTED — the Rust chain is already FASTER than the hashed set.** The source reads like the same gap (`normalize_pred` rewrites an `IN` of ≤32 literals INTO a chain; `multi_eq_target` recognizes a chain only for SEEDING), but at 33 terms the chain is **2.216ms against `in_set`'s 2.959ms — 1.34x the other way**, because native's chain vectorizes through the typed compare path where TS's per-term closures did not. Nothing to port. Item 267 measured the opposite at 100 terms (chain 15.25ms against 5.76), so the crossover is between 33 and 100 and **the `<= 32` gate is approximately AT it — deliberately not tuned**, since ~1.3x on an uncommon length risks the 2.6x case and would need a proper term-count sweep at one N.                                                                                                                                                                                                              | **271**, cf. 267, 270                      |
| **Vectorizing `contains`/`starts_with`/`ends_with`, or adding an `Or` arm to `try_filter_keep`** | **REFUTED THREE WAYS.** (a) The planned `Col::Str` arm was VACUOUS — `read_property` returns `Col::Num` or `Col::Gen` and **never `Col::Str`**. (b) The arm already exists: `try_keep_strsearch` scans `&str` off a `Column::Str`/`Column::Dict`, and `try_filter_keep`'s `And` arm recurses per conjunct. (c) The genuinely missing `Or` arm is worth ~nothing: `eval_mask` has its own `typed_strsearch_mask`, so `contains OR contains` is **12.2 ns/row for both searches** (2.433ms/200k) against the AND's 1.465ms — and that 1.66x is the AND SHORT-CIRCUITING onto survivors, which is inherent. **Root cause of all three: `expression_cost_by_kind` prices PROJECTIONS (`eval`), not predicates** — `contains` is 31.83 ns/row there and ~5 ns/row as a filter. It also misdirected item 266. The harness now says so, and three misleading rows are labelled.                                                                                            | **272**, cf. 265, 266                      |
| **Native "materializes the full cross product before applying the limit"**                       | **REFUTED as recorded, then the real case CLOSED at ~1,600x.** A LIMITed uncorrelated product was already lazy (cost tracks the LIMIT at 100k AND 1M users). What was slow is the product **with a WHERE**: 11.189ms, FLAT in the limit. Item 273's right-side pushdown moved the `Filter` into the side but did not fix it (11.189 -> 10.230); **item 275 finished it** — `pull_capped`'s cross-join arm now falls back to `pull_capped_stream` for a side `pull_capped` declines, giving **0.007ms at LIMIT 1**. The arm's comment claiming the stream "is not usable here… not the same bound" was WRONG: a `c`-row prefix of each side contains the product's `c`-row prefix (right side longer than `c` → the first `c` rows all pair with the first left row; otherwise `ceil(c / survivors)` left rows suffice, and the arm already caps the left at `c`), which is the argument the arm already rested on. The two items compose — neither alone is enough. | 273, **275**                               |
| **A comment-only NULL CONTROL on the TS engine**                                                 | **VOID — `bun run build` BUNDLES, which strips comments, so the padded build emits an IDENTICAL bundle.** It compares a build with itself and returns ~1.00, which reads as "the movement is real and attributable" when it means nothing was tested. A TS null control needs padding that survives bundling (a retained export). **Item 268's TS null control used this technique and is suspect.** Found at 274, where it nearly confirmed a 3.4x "regression" that was really the probe's own cross-case warming: all cases shared ONE process, and the count cases (now 40x faster) used to warm the enumeration path the LIMIT cases then used. Isolated one-case-per-process, those rows are 0.93-0.96x.                                                                                                                                                                                                                                                      | **274**, cf. 268                           |
| **A differential fuzzer finding a bug in a shape only ONE engine accepts**                       | **STRUCTURALLY IMPOSSIBLE — it compares two answers, and there is only one.** Item 277's wrong answer (`EXISTS { MATCH (a WHERE a.k = 1)-[:E]->(x) }` returned ALL rows instead of one) sat in a shape native REFUSES outright ("inline WHERE on a EXISTS start node is not supported"), so no seed count reaches it. The guard for that class is an INTRA-engine spelling comparison: the same question as `(a {k: 1})` answered correctly, and comparing the two is what detects it. **Separately, the fuzzer also missed the ENDPOINT form, which both engines accept and where native was right** — a concrete coverage gap: it does not generate an EXISTS subquery with an inline equality on the endpoint.                                                                                                                                                                                                                                                   | **277**                                    |
| **Setting a fuzzer coverage floor "~N% under the observed minimum"**                             | **UNSAFE FOR A SMALL COUNT — it reads like a margin and is not one.** A floor's safety is its distance from the mean in SIGMA, not a percentage, because sigma grows as the square root of the count: `groupHopPredNonEmpty`'s 1.42x margin is ~6 sigma at mean 450 and never fires, while `subOrNonEmpty`'s 1.5x margin at mean 14 is ~1.6 sigma and **turned CI red on a DOCS-ONLY commit** (it hit 8 and 9 in eleven samples against a `> 8` floor). Five floors inside 3 sigma were re-set to ~4 sigma at item 280; nine other small bands were checked and were already safe. Check the DETECTOR first (item 237), then the sigma — and verify the lowered floor still fails when the band collapses to zero, which is its only stated job.                                                                                                                                                                                                                    | **280**, cf. 237, 255                      |
| **Specializing the `cmpProps` test at compile time** (hoist `COMPARE[op]`, skip the `=` branch)  | **REFUTED BY ITS OWN CONTROL, not by direction.** Built and retracted: the equality path — which goes through `eqProps`, has `cmpProps` undefined and skips the loop entirely — moved **1.28x**, the most of any row, while the mixed chain the change DOES reach moved **1.00x**. Noise dominating at ±25%, which the control itself measures. The specialization is strictly less work per row so the direction is probably right; it is just not demonstrable here. Resolving a 3-10% effect needs `in-process-ab-of-two-builds` (both bundles in one process, alternating on one graph). Item 278's residual stays recorded: selective `>` ~37 ns/vertex against equality's ~29.                                                                                                                                                                                                                                                                                | **281**, cf. 231, 245                      |
| ~~**A CORRELATED product under a LIMIT**~~ (`MATCH (s) MATCH (u) WHERE u.k = s.k … LIMIT n`)     | **CLOSED by item 288 at 204-316x.** Priced at 282, built and retracted at 283, unblocked by 284, closed here. A `Plan::Filter { input: Join { on: [] } }` arm in `pull_capped` pulls BOTH sides once and then walks the right side in adaptive blocks (256, doubling to 65,536) inside a left-major loop, stopping at `cap`. `gt LIMIT 1` 2310.0 → **7.3 us**, `gt LIMIT 4` 2273.0 → **7.3**, `eq LIMIT 1` 1425.0 → **7.0**; five controls flat and row counts identical. **The hash-join shortcut stays CLOSED** — `Plan::Join`'s `on` joins on bound-variable IDENTITY, so a property correlation still needs a new join form, and this does not add one. `eq LIMIT 4` stays at 1.62x and that is inherent, not residual: the answer is one row per left row, so the cap can only fill by visiting every left row. It also FIXED TWO CROSS-ENGINE DIVERGENCES (see §below).                                                                                       | **288**, cf. 273, 275, 282, 283, 284       |
| ~~**The nested-loop streamer for that correlated product**~~ (item 282's design)                 | **RETRACTED at 283 and SUPERSEDED at 288 — the bet was the bug, not the tuning.** 283 streamed the right side FROM THE PLAN inside the left loop, so a cap that did not fill early re-scanned the whole right side per left row: 1,640x where the bet won, 1.9x WORSE on `LIMIT 4`, and 1.7x worse even with a lost-bet gate. Item 288 pulls the right side ONCE before the loop — which the uncapped path already does, since `hash_join` takes two `Batch`es — so there is no bet, no gate, and nothing to tune, and 283's trap row is **1.62x FASTER** instead of 1.9x worse. **Do not re-attempt the streamed-right-side variant** without first beating item 288's floor: it trades a ~245 us right-side pull for a ~7 us one and re-acquires the re-scan unless the blocks are CACHED.                                                                                                                                                                        | **283**, superseded by **288**             |
| **`hash_join` with an EMPTY `on` built a hash index anyway**                                     | **FIXED at item 284, 6.69x.** Its `dense` path needs exactly ONE slot pair, so a CROSS PRODUCT fell to the generic branch: a join key per row on BOTH sides, all funnelled into one `FnvMap` bucket, to rediscover that everything matches. Emitted directly instead — `correlated =, count` 9.382ms → 1.402, the comma spelling 8.371 → 1.446 (the two CONVERGE), projection 5.22x, `>` 3.80x; product-of-counts and single-pattern controls flat, and the corpus's real non-empty-`on` join 1.004. Found only because item 283's retraction located the constant factor. **Mutation then found the row ORDER guarded by nothing** — right-major keeps every row and count and the whole suite passed, and the fuzzers canonicalise row order — so `a_cross_product_emits_rows_left_major` now pins it.                                                                                                                                                            | **284**, cf. 282, 283                      |

### Clean negatives — coverage added, no bug found

Worth knowing so the same ground is not re-probed hopefully:

- **Subquery predicates under `NOT` / `OR` / `NOT (… AND …)`** — 11 seeds, zero divergences (255).
- **`ALL SHORTEST`** and the other selectors — 15/15 on a fixture built with ties (255).
- **`{n}` vs `{n,n}`, `{n,}` vs `+`/`*`, an undirected quantified hop, a quantified hop composed
  with another segment** — 76/76, compared _within_ each engine as well as across (256).

**The pattern across nine priced areas:** the four that found bugs were all **semantics attached to
a quantified path** (which hop a predicate gates, which repetition a `WHERE` belongs to, what a
closing hop costs). The five clean ones were all **syntax and shape**. Price a gap where each engine
_decides_ something independently, not another unspelled form.

---

## 2. Settled semantics — DO NOT RE-FLAG

| question                                                                                         | settled as                                                                                                                                                                                                                                                                                                                                                                                                    | authority                                 |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Prototype-chain keys (`__proto__`, `toString`, `valueOf`) as property names                      | **WON'T FIX** — not real-world input                                                                                                                                                                                                                                                                                                                                                                          | item 1, **user**, re-confirmed 2026-09-16 |
| Row order without `ORDER BY`                                                                     | **Unspecified**, as SQL. Do not sort to fake byte-identity; compare as multisets                                                                                                                                                                                                                                                                                                                              | item 198, **user**                        |
| Cross-type comparison                                                                            | `=` → no match; `<=` → `E_INVALID_VALUE` throw. Postgres-style                                                                                                                                                                                                                                                                                                                                                | **user**, "fine with it"                  |
| NaN                                                                                              | Predicates keep it JS-unordered; sort/min/max use a total order (NaN last, NaN == NaN) so both engines stay byte-identical                                                                                                                                                                                                                                                                                    | settled                                   |
| `null`                                                                                           | A **stored, present value**, distinct from absence. Delete via `.properties(k).drop()` / `REMOVE`, never `SET null`                                                                                                                                                                                                                                                                                           | settled                                   |
| Parallel names across GQL and Gremlin                                                            | **Intentional** — users pick one surface. Not a collision                                                                                                                                                                                                                                                                                                                                                     | settled; do not relitigate                |
| A label / property / `WHERE` on a subpath-group **inner node**                                   | **Both engines refuse, consistently**, and the per-rep `WHERE` spelling expresses the same constraint (verified equal). A shared deliberate limitation with a workaround, not a gap                                                                                                                                                                                                                           | probed 2026-10-08                         |
| `FALSE AND <data exception>`                                                                     | **`AND` short-circuits on FALSE, in WRITTEN ORDER, in both engines.** `OR`/`XOR` stay eager. ISO leaves it open (`US008`, `UA004`), so the choice was made on cost                                                                                                                                                                                                                                            | **user**, 2026-10-08; **item 258**        |
| Conjunct order in a **FILTER** (clause `WHERE`, `FILTER`, `HAVING`, an inline pattern predicate) | **Unobservable, in both engines, so the conjuncts that cannot raise go FIRST.** A filter keeps only a clean TRUE (ISO §14.6), so a conjunct that is not cleanly TRUE settles the row — UNKNOWN included, unlike Kleene `AND`, where only FALSE settles. Spends no ISO latitude: it is the filter's contract, not a reordering of `AND`'s value. A **VALUE** position still keeps written order                | **user**, 2026-10-09; **item 259**        |
| The ordering KEY for that reorder                                                                | **Must be the SAME key in both engines.** A narrower whitelist in one engine is not caution, it is disagreement — restricting TS's to `=`/`<>` while the engine admitted any comparison produced **41 divergences in one 20,000-query run**                                                                                                                                                                   | **item 259**                              |
| `SHORTEST k` (k >= 2) over an **unbounded** quantifier (`*` / `+`)                               | **Faults with `E_RESOURCE_EXHAUSTED` at `limits.trail`, in both engines.** The number of edge-disjoint trails is superexponential and nothing in the pattern bounds it — native used to enumerate them all and **take the process down from a 20-node, 60-edge graph**; TS had been faulting correctly all along. Not a new knob: the same ceiling the BFS selectors (`ANY` / `ALL SHORTEST`) always honoured | **item 373**                              |

---

## 3. Stale claims — recorded once, no longer true

- **`eval_vec`** — gone (see §1).
- **`query-parallelization-and-simd`** — describes the deleted `lenke-core`; the engine is
  single-threaded. Priors may transfer, the numbers do not.
- **Item 197's "left for a decision"** — superseded by item 200's refutation and item 247's
  confirmation. The audit's later summary still lists it as open; it is not.
- **"`compilePredicate` lifts equality conjuncts into `props`"** — it does not; it compiles what it
  is given. Corrected twice before it stuck (items 209 → 210).
- **"The hop budget mirrors the TS matcher exactly"** — was false for `k > 1`; fixed at 254, and
  still false for the lean count walker (see §4).

---

## 4. Open — needs a decision, not a measurement

| question                                                                   | state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The var-length trail budget's shape**                                    | `limits.trail` drives **two** quantities (a per-source hop budget and a global emitted-row cap) and the lean count walker enforces **neither**. Budget EXISTS and stays (user, 2026-10-08); its SHAPE is what is open — context written up in [`../design/trail-budget.md`](../design/trail-budget.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **`{k: null}`**                                                            | **BOTH engines, verified 2026-10-08 — not native-only.** Each returns 2 rows (stored-null **and** absent-key) where `WHERE n.k = null` returns 0 in each. The free ISO artifacts prove it is **not** implementation-defined or -dependent, so one of the two behaviours is wrong; the reduction rule is paywalled prose. Items 180, 210, 257, and the matrix below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **`FALSE AND <data exception>`**                                           | **SETTLED AND SHIPPED 2026-10-08 — item 258.** See §2. The FILTER half followed on 2026-10-09 — item 259, also in §2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Does the static boolean-context check cover INLINE PATTERN predicates?** | Today: TS **no**, the engine **partly** — it applies to whatever lowers to a `Plan::Filter`, which an inline predicate on a quantified-path endpoint (`->*(n WHERE …)`, `ANY SHORTEST`) does and one on a plain node pattern does not. That asymmetry is the registry's only remaining entry (~1 per 120,000 generated queries, `E_INVALID_VALUE` vs an EMPTY result). **Extending TS's walk to cover them was tried and measured WORSE** (1 divergence a run → 7, because the engine answers rows for `(n WHERE CAST(x AS STRING))`). Covering them in BOTH engines would reject queries that answer today, so it is a conformance decision. Item 259. **ITEM 279 WIDENS THE QUESTION:** the same asymmetry also reaches `E_INVALID_VALUE` against a **NON-EMPTY** result — `MATCH (t:T) OPTIONAL MATCH (t)-[:E]->(n WHERE (n.x AND …))` has TS reject and native answer six rows, every one padded with `y: null` because native matched no endpoint. The registry refuses that direction ON PURPOSE (an error against non-empty is the `CALL`-body laziness class), so the fuzzer FAILS rather than declaring it, intermittently: 12 pass / 1 fail on a random seed, `FUZZ_SEED=3668867883`, replaying on HEAD. So the decision also governs whether `bun run fuzz` can be green. Items 259, **279**. |

---

### The `{k: null}` matrix, and the thing it corrects

Measured 2026-10-08 on a three-state fixture — a value, a stored **present** null, and an
**absent** key — in both engines. All ten spellings agree between the engines, so nothing here is
a divergence; it is one shared conformance question.

| spelling                                      | matches                    |
| --------------------------------------------- | -------------------------- |
| `MATCH (n:P {k: null})`                       | stored-null **and** absent |
| `WHERE n.k IS NULL`                           | stored-null **and** absent |
| `WHERE n.k = null`                            | nothing                    |
| `WHERE n.k IS NOT NULL`                       | value                      |
| `WHERE property_exists(n, k)`                 | value **and** stored-null  |
| `WHERE NOT property_exists(n, k)`             | absent                     |
| `WHERE property_exists(n, k) AND n.k IS NULL` | **stored-null alone**      |
| `MATCH (n:P {k: 1})` / `WHERE n.k = 1`        | value (the two agree)      |

Two things follow, and the second corrects how this question has been framed since item 180.

1. **Nothing is inexpressible.** `property_exists(n, k) AND n.k IS NULL` isolates the stored null
   on its own, and `NOT property_exists` isolates the absent key. So whichever way `{k: null}`
   goes, a user who needs the distinction has an exact spelling for it — the inline form is
   convenience, not the only access to the three states.
2. ~~**The 1.16x**~~ — **GONE as an argument entirely, by item 260 (2026-10-09), and the 1.16x
   itself did not reproduce.** This file already said the perf question was separable and that
   item 210's second route (an entry carrying expression-equality semantics) would unblock it
   under either semantics. That route is now **taken**: the `eqProps` loop rejects a null
   right-hand side, which makes a lifted entry mean `n.k = v` rather than `{k: v}`, so a `$param`
   needs no compile-time decision — and `compileNode` now passes an own-var, which it never did,
   so the general scan path lifts at all. **But HEAD's real spelling gap on a 200,000-vertex
   `User` fixture is 7.3%, not 16%**, so the recorded 1.16x was fixture-specific; the lift pays
   **0.944x** on clause `WHERE` with a flat control. Nothing about `{k: null}` is waiting on perf,
   and nothing about perf is waiting on `{k: null}`.

What is genuinely at stake, then, is only: conformance (ISO specifies this and we cannot choose;
the prose direction points at "matches nothing", so the current behaviour is a bet), and the
collision with the project's own rule that **a null is a stored, present value distinct from
absence** — `{k: null}` is the one place in a pattern where that distinction is erased.

## 5. Open — unblocked and priced

- ~~**A multi-value seed only fired for a WHOLE predicate**~~ — **CLOSED by item 264**
  (2026-10-09), at **56-93x**. `WHERE k IN [..] AND other > 5` with only `k` indexed cost **69x**
  the same `IN` alone, because `seed_from_conjuncts` picks one conjunct and `Seed` had no
  multi-value variant. The new rung sits BELOW an indexed eq/range (one selective seek beats a
  union, and that order leaves every existing plan untouched) and ABOVE the unindexed-eq fallback
  (whose "seek" is a column scan). **Mutant C1 survived all 1015 tests before three tests were
  added — the second time in one session that a new planner rung turned out to be unreached by
  `rewrite_fuzz`'s generator.**
- ~~**Neither engine seeds from a same-key `=`-OR-chain**~~ — **CLOSED by item 263** (2026-10-09),
  at **115-269x** in the TS engine. `collectHints` descended only `and`, so `k IN [a,b]` seeded
  (item 184) and `k = a OR k = b` scanned — one of the spelling pairs `CLAUDE.md` names among the
  100-300x seeding gaps. Found by grepping the pattern across engines right after item 261 closed
  it in Rust. A residual stays, measured and recorded: `OR` 33 is **2.68x** the `IN` spelling
  because the surviving rows re-check O(terms) where `IN` is one hashed test — below
  `spelling_probe`'s own 1ms floor, so not yet worth the evaluator rewrite.
  It widened to 10.36x at 33 terms / 27.74x at 100 once item 268 hashed `IN` (an uncaptured win,
  not a regression — the OR spelling never changed), and is now **CLOSED by item 270 at 29.3x**:
  a uniform same-key `=`-chain is lowered to the hashed membership test in `compileExpr`, so the
  two spellings land within 6% at every length. Sound because `uniformEqChain` admits only
  `prop <=> const` operands, none of which can raise — so collapsing them does not conflict with
  the `or` arm's deliberate no-short-circuit rule — and because the equivalence is exact in
  three-valued logic (a null needle → UNKNOWN both ways; a NULL term leaves a hit TRUE and makes
  a miss UNKNOWN, which is what `hasNull` encodes). Applied in `compileExpr` rather than to the
  AST so `collectHints`' own seeding still sees the original `or`.
  **A note on the probe:** `spelling_probe` reported "no group over 2x" throughout, because its
  `OR vs IN` group is **2 terms**, where the ratio really was 1.19x — **a probe group's SIZE is
  part of what it can see.**
- ~~**Native never index-SEEDS from `IN`**~~ — **CLOSED by item 261** (2026-10-09), at **65-75x**,
  and the recorded price was wrong three ways. It was carried as a "residual 3.3x 32→33 cliff"
  needing "a multi-value `Seed` variant plus a physical operator, with row-order/byte-identity
  work". Measured before building: **the cliff is 1.03x** (item 185's membership set already
  flattened it), **an `=`-OR-chain does not multi-seek either** (`IN` 33 and OR 33 cost the same,
  1.00x — so the ≤32 rewrite bought a cheaper evaluator form and no seed), and **no new operator
  was needed** because `Plan::Union { all: true }` already concatenates without deduping, so a
  union tree of the existing `IndexSeek` is the whole change. Row order changes, which is
  unspecified and already true of the single-value seek, so there was no byte-identity work either.
  **Re-price a carried number before building against it.**
- ~~**The REVERSED AND spelling**~~ — **CLOSED by item 259** (2026-10-09). `WHERE <raising> AND
<seekable>` now answers the same in both engines. It did NOT need TS to replicate the seeding or
  native to drop it, which is what this entry assumed and priced as "not perf-neutral": a filter
  keeps only a clean TRUE, so conjunct order is unobservable there and the conjuncts that cannot
  raise simply go first. The entry was also right that nothing guarded it — being an error against
  a NON-EMPTY result, the registry could never have declared it, so closing it was the only
  available route. Items 115, 174, 258, 259.
- ~~**An INLINE `IN` list costs 2.7x the PARAM spelling**~~ — **CLOSED by item 267** (2026-10-09),
  at **11.9x at 500 items**, and the spelling gap is now 1.00x at every length. Item 266 had
  measured the gap correctly (100 items: 15.13ms inline against 5.74ms param, the param spelling
  FLAT across 33→100) and named the wrong cause: not `try_filter_keep` but **the GQL PARSER**,
  which desugared `IN <list literal>` into an OR-chain of ANY length. One `eprintln` settled it —
  for the inline spelling the evaluator's `Expr::In` arm is never reached at all. That also
  explains 266's no-op fold: the parser had already consumed every inline list, so
  `normalize_pred` never saw one. The fix caps the chain at **`IN_CHAIN_MAX = 32`**, deliberately
  the same line `normalize_pred` draws, **and folds a long all-literal list to `Lit(List)`** so
  `in_set` serves it. **Both halves are load-bearing:** capping alone measured **172.98ms at 33
  items against 5.18ms**, because `in_set` declines a non-`Lit` haystack and `eval` then broadcasts
  the list across the batch — item 185's defect re-created by a change meant to fix it. Items 266,
  **267**.
- ~~**The TS engine's `IN` is a linear scan, per row**~~ — **CLOSED by item 268** (2026-10-09), at
  **34.7x** on the inline spelling at 500 items and 10.7x on the `$param` one. Found by grepping
  item 267's pattern across engines: TS had no `in_set` equivalent at all, and `case 'list'` also
  rebuilt an inline haystack with an element closure call PER ROW, so the inline spelling cost
  3.07x the param one at every length. A closed all-literal haystack is now hashed at compile
  time and a `$param` one memoized on its array identity; both curves are flat in list length and
  the two spellings agree within 12%. Whitelist is deliberately the Rust `in_set` one, because
  `Set.has` is SameValueZero and `structuralEq` ends at `===`: they differ on **NaN alone**, so
  NaN elements keep the linear scan. **One honest negative: 0.95x on the param spelling at 8
  items** — a threshold like the Rust side's `IN_CHAIN_MAX` was declined on purpose, since the
  hashed path wins at 32+ on both spellings and at 8 on the inline one, so a threshold would buy
  ~5% on the shortest param lists at the price of a new length boundary.
  **Item 269 then had to fix what 268 broke next door:** the ARRAY-IDENTITY key it cached on
  missed every row for an inline list of params, because `case 'list'` rebuilds that array per
  row — a 2.9x regression on a sibling spelling, found by pricing all three spellings rather than
  by any failure. Re-keyed on a per-execution `execEpoch` (hash only a `closedList` haystack,
  whose value cannot depend on the row), all three spellings now agree within ~14% at every
  length, and the inline-param one is **24.2x faster than it was before 268 ever landed.**
- ~~**TS `SET`'s O(width)**~~ — **CLOSED BY DESIGN.** Item 147 removed one of the three O(K)
  passes; the other two are inherent to the frozen immutable bag (a single-key write must build a
  new object and freeze it, and the freeze is what makes a stray mutation throw). Do not "fix" it
  without replacing that design. Items 147, 148, confirmed 266.
- ~~**Native raised on a capped product whose predicate faults past the cap, where TS returned
  rows**~~ — **FIXED by item 288**, as a side effect rather than a target. Two shapes, both loud
  refusals: `MATCH (s:S) MATCH (u:U) WHERE CAST(u.st AS INTEGER) = s.k … LIMIT 1` and the
  ONE-SIDED `… WHERE CAST(u.st AS INTEGER) >= 0 … LIMIT 1` both threw `E_INVALID_VALUE` in native
  and returned rows in TS, because native built the WHOLE product (and so evaluated the faulting
  row) before paging. The one-sided spelling is the surprise: item 273's `right_pushable` declines
  a predicate that `can_raise`, so a raising one-sided predicate is never pushed into its side and
  lands above the join too. Both agree now, and `LIMIT 4` throws on BOTH for the same structural
  reason item 288's 1.62x has — left row 0 cannot fill a cap of 4, so both scan past the faulting
  row. Found by a hand-written 4-way probe; **its first run answered a different question**,
  because 201 right rows fit inside the arm's first 256-row block.
- ~~**The COMMA spelling of a multi-pattern clause did not push its `WHERE` into a node**~~ —
  **CLOSED by item 285** (2026-10-09), at **15.6x** in the TS engine. `pushWhereIntoNode` declined
  on `clause.patterns.length !== 1`, so `MATCH (a:A), (b:B) WHERE b.k = 7` kept the predicate as a
  clause filter (once per SURVIVING BINDING, and a binding over a product is a `Map` materialized
  per product row) while `MATCH (a:A) MATCH (b:B) WHERE b.k = 7` pushed it into the node (once per
  SCANNED vertex): 145.039 ms against 9.193 ms for the same four rows. Item 121's shape at 160x,
  recurring in the other direction. Only a conjunct reading **exactly one of the clause's own
  pattern variables** moves, which is the correctness condition and not conservatism —
  `visitRemaining` chooses the intra-clause visit order AT RUNTIME (item 122), so a conjunct
  reading two of them would compare against an unbound variable whenever its pattern went first
  and the row would silently vanish. Outer variables are safe for item 128's reason. Permanent
  group in `spelling-probe.ts`: **9.5x spread on HEAD, 1.10x after.**
- ~~**A one-hop count is O(1) only when the start label constrains NOTHING**~~ — **CLOSED by item
  286** (2026-10-09), at **2.6-4.9x and 9058x** where the label's vertices have no edges. Found by
  item 285's probe group on the way in: `MATCH (a:P)-[:E]->(b) RETURN count(*)` read **54.06 ms**
  against the untyped spelling's **0.00 ms**, same answer, once `:P` was genuinely selective —
  four nodes out of 200,000 were enough. The cause was a MISSING RUNG, not an algorithm: the
  unfiltered branch of `buildOneHopCount` went from the O(1) bucket size straight to a per-edge
  walk, while `startOnlyHopCount` (item 129) and its far mirror (137) answer "one end labelled,
  the other free" as a DEGREE SUM over the label bucket — and were reachable only with a
  predicate or an inline constraint, because `startWalkFits` did not count a LABEL as a
  per-vertex constraint. One disjunct in each shared fit rule. `MATCH (a:S)-[:E]->(b)` — four
  vertices, zero edges — went 27.176 ms to 0.003 ms, having scanned 600,000 edges to find none.
  **The `label on start` probe group still flags at ~2100x and that is CORRECT, not outstanding:
  the two members are not equivalent work** (one bucket size against a visit to every `P`), so
  O(|label|) against O(1) cannot converge. It stays as a regression guard on the 54 ms; do not
  quiet it by reverting the fixture.
- ~~**`edgesToByLabel` costs ~1.9x `edgesFromByLabel` to read bucket sizes**~~ — **REFUTED by
  item 287** (2026-10-10), one iteration after item 286 recorded it. It was never an index
  property: **the two are the same structure** (`Map<string, Map<string, Set<Edge>>>`), so a
  1.9x cannot be structural, and the fixture was the variable. `spelling-probe.ts` built every
  edge as `from: v${e % N}`, `to: v${(e * 7919) % N}` — the from-keys inserted in VERTEX CREATION
  ORDER, which is the order the degree-sum walks iterate, and the to-keys in a pseudorandom
  permutation. So one index was walked sequentially and the other jumped around: **item 164's
  mechanism** (29ns a vertex against 135ns), not a cost of either index. Swapping the
  construction FLIPPED which spelling was slow (FROM 15.3/19.1 and TO 31.6/34.2 one way; FROM
  31.7/31.7 and TO 15.6/14.3 the other), and scattering BOTH keys landed all four spellings
  within **1.10x**. The probe's fixture is now symmetric, because the bias advantaged
  from-driven spellings over equivalent to-driven ones in the one harness whose job is comparing
  them — item 220's reversed-arrow member had been judged under it too.
  **Probe numbers recorded before item 287 are not comparable to ones after it:** the symmetric
  fixture is uniformly harder (many queries 0.45-0.66x of their old reading) because the old one
  handed every from-driven walk sequential locality. A residual 1.40x remains between the two
  START-walk directions on the probe's richer P/Q + E/F fixture, below its 2x tolerance and NOT
  attributable to the index — the two far walks agree across both indexes (39.90 TO against
  40.56 FROM).
- **The CORRELATED comma product keeps ~3.4x** against its two-clause twin — **recorded, not a
  bug, and not refuted either.** `MATCH (a:A), (b:B) WHERE b.k = a.k` cannot push onto either
  pattern for the runtime-visit-order reason above. Closing it means PINNING `visitRemaining`'s
  order, which is a different change with its own cost. Deliberately not a member of the item-285
  probe group: a known-divergent pair in a probe that flags divergence makes the probe lie.
- ~~**The count family stopped at THREE segments**~~ — **CLOSED by item 290 at 127.7x** (36082.73
  → 282.60ms at 50,000 nodes of degree 5; 152.45x on the 10,000-node A/B, disjoint ranges).
  `patternCountOf` routed 1, 2 and 3 segments and `return null`ed for four, so a 4-hop `count(*)`
  fell to the general matcher: **a x420 step where the degree predicts x6**, 1154ns a path against
  the 3-hop shortcut's 13.7ns, and **3456.9x off native** — the largest ratio in any harness here.
  The fix is one more nested loop on the same degree product (three hops pays per MIDDLE EDGE,
  four per INTERIOR PATH: 1.25M terms instead of 31.25M paths), as a fourth ARM and deliberately
  NOT an n-segment generalization. Unfiltered only. 12 of 12 correctness mutants caught against a
  **lopsided** fixture — a uniform-degree graph would have let R1, R4 and R5 survive, because a
  degree product that multiplies the wrong factors returns a plausible number.
  **`3 hop, count(d.k)` moved 0.87x on DISJOINT ranges and was NOT a regression:** it cannot reach
  the arm, and in isolation (4 rounds, 9 reps, two shapes per process) it is 1.03x FASTER. The
  multi-case probe ran `4 hop` immediately before it, and on the head side that spent **5.6
  seconds** in the general matcher — warming the exact path the next case used. **A large speedup
  can make its NEIGHBOUR look slower, and disjoint ranges do not save you**, because the
  contamination is systematic rather than noisy. The tell: the "regressed" shape cannot reach the
  change.
  ~~Still open and priced here: anything that DECLINES a count shortcut pays **50-85x**~~ —
  **CLOSED for the INLINE-CONSTRAINT case by item 303 at 33.6-79.8x.** The sweep refused any
  constrained node (`plainNode`), so a five-segment chain with ONE gated position declined the
  whole family: 25.1x / 26.2x / 29.4x / 43.5x / **82.1x** the unconstrained chain at positions 0-4
  (20,000 vertices, degree 3). Now 1.2-1.7x. Each leg carries its landed node's `InlinePred` and
  applies it on the `0 -> w` TRANSITION — once per DISTINCT vertex reached there, not once per
  edge into it — and resolves the endpoint only on that branch, so an ungated pass never pays
  item 194's ~190ns lookup. Item 219's argument, one family along: a position the sweep VISITS has
  a once-per-element place for a gate.
  **The gated LAST position needed no new mechanism and won the most (79.8x):** an ungated end is
  a weighted sum of DEGREES and a degree cannot say which edges land somewhere that passes, which
  is why the degree products refuse an end constraint — but the sweep can just give the last
  position a PASS and sum the surviving way counts. `passes = lastGated ? legs.length : legs.length
  - 1`is the whole change.
Answers agree with native exactly at every position (native still takes the old route, so it is
an independent derivation). Measure with`cd packages/native && bun run bench:gate`.
- **A per-pass MEMO of a failed gate** — **REJECTED at item 303 on its own numbers.** Stamping a
  negative sentinel into the way-count buffer and skipping later edges that find one. (1) Mutation
  proved it is NOT a correctness mechanism — the mutants removing the stamp and removing the test
  BOTH survived, because a rejected vertex is re-tested per edge and still never enters the
  frontier. (2) Its SIGN IS NOT CONSISTENT: on a fixture built to favour it (4,000 vertices,
  degree 24, selective gate) it was **0.87x SLOWER** at the gated last position and 1.27x faster
  at an interior, both disjoint. (3) It put a negative number in a weight array behind a "nothing
  reads it" invariant. An earlier probe had it at 1.12-1.13x, but that probe's own ungated control
  spanned 1.5x across rounds — **a probe that cannot hold its control still is not entitled to a
  13% conclusion.**
- ~~**The same inline gates in NATIVE**~~ — **CLOSED by item 304 at 16.3-63.1x.** 20,000 vertices
  of degree 3, a five-hop chain, three alternated rounds against the unconstrained chain as the
  control: 14.7 / 16.6 / 18.5 / 32.0 / **63.1 ms** at positions 0-4 become 0.90 / 0.90 / 0.90 /
  0.90 / 1.00 ms, i.e. 1.8-2.0x the free chain where it was 29-126x. `(none)` reads 0.50 against
  0.50, so the ungated sweep did not pay for it — the ungated inner loop is kept byte-identical
  rather than folded into the gated one behind a per-edge `Option` test.
  **What it actually found was an equivalent-SPELLING bug of item 125's class, in the planner's
  shadow.** An inline `{k: 1}` is pushed down to the hop that binds the node; a clause
  `WHERE n3.k = 1` is left at the TOP of the chain. The first draft compared a filter's slot
  against the position of the level it sat at, so it served one spelling and declined the other.
  The gate's position is now DERIVED from its predicate's slot: inline 18.8x, clause `WHERE`
  20.4x, flipped `1 = n2.k` 20.6x, all three at 0.90 ms. **Found by INSTRUMENTING which shapes the
  arm reaches** (a temporary `eprintln!` at the point of acceptance over thirty shapes), not by
  reading the plan — the plan dump showed the pushdown for the inline spelling and said nothing
  about the one that was missing.
  A conjunction naming TWO positions SPLITS into two gates rather than declining (mutant N10
  survived until it did), and leaves landing on one position conjoin — one `AND`, two stacked
  `Filter`s, or an inline constraint plus a clause `WHERE` on the same node all mean the same
  thing. `chain_depth` is gone: two peelers that each had to agree about what a `Filter` means was
  the duplication to remove, and the width check is structural rather than a `chain_width` call,
  which sees through an `IsLabeled` filter only.
  Still DECLINED, each asserted by answer rather than by declining: a DISJUNCTION (and the `IN`
  spelling that lowers to the same `Or`, so they decline together), a CORRELATION naming two
  slots, `IS NULL`/`IS NOT NULL` (NOT `has_prop` where null is a stored present value), and a null
  literal in a compare — **`k = null` would answer 0 anyway, but `k <> null` would admit
  EVERYTHING**, which is why that guard is load-bearing. 14 of 15 mutants caught; the survivor is
  N15, the deliberate EQUIVALENT one (remove the `next[j] == 0` transition test and a gate is
  merely re-evaluated per edge), kept in the set so a run proves it can tell "not covered" from
  "cannot differ".
- ~~**The same spelling gap in the TS engine**~~ — **CLOSED by item 305 at 112x.** Same fixture,
  same question at position 2: the clause `WHERE n2.k = 1` went **4708.2 -> 42.0ms** against the
  inline `{k: 1}` spelling's 37.9, and the flipped `1 = n2.k` to 35.4. A clause `WHERE` is now
  SPLIT into conjuncts and each is bucketed by the ONE node variable it reads, then applied at
  that position — the same pushdown item 304 did in native, found there first.
  **The oracle for the whole `long-chain-count.test.ts` file had to be replaced FIRST**, and that
  is the transferable part: its 33 tests compared `count(*)` against the same query plus an
  always-true clause `WHERE a.i >= 0`, chosen in item 298 precisely because a clause predicate
  over four or more segments declined. This item makes the sweep ANSWER that, so the oracle would
  have become the sweep compared against itself — 33 tests passing by agreeing with the thing they
  test. It is now an ENUMERATION (project a column, count the rows), which no count shortcut can
  answer because `detectCountShortcut` requires `count(*)`, and which is what the Rust twin always
  used. **A route-forcing oracle has a lifetime: it ends when you teach the route it relied on
  declining.** The swap was made and all 33 tests re-run GREEN before the feature was written, so
  the two oracles are known to agree.
  Still declined, each asserted by answer: a CORRELATION (`a.i <= f.i`, which needs both ends at
  once), a DISJUNCTION across two positions, and a CONSTANT (`WHERE 1 = 1` reads no name, so there
  is no position to put it at). A presence test IS a gate here, unlike native — a TS gate runs the
  general path's own `satisfies`, so any single-node predicate is expressible.
  9 of 11 mutants caught; **M2 and M6 survive alone and their PAIR is caught**, which is the
  result worth keeping. (See the row below: this item MOVED the cliff to three hops.) M2 buckets every conjunct under the first name seen; `gateWith`'s
  free-variable check then refuses the mis-bucketed gate and the whole pattern DECLINES, so M2
  alone is a slow right answer that no correctness test can catch. M6 removes that check, which
  with correct bucketing can never fire. Together they are a wrong answer. **A guard whose mutant
  survives is not necessarily dead — it may be what turns someone else's bug into a decline**, and
  the way to tell is to mutate both.
  **Its own open question — "did the fourth arm FIX the cliff or MOVE it?" — is answered by item
  298: it moved it to FIVE**, and the row below closes it for every depth.
- ~~**The count family's cliff at FIVE segments**~~ — **CLOSED by item 298 at 719x (5 hops) and
  2603x (6)**, 200 nodes of degree 5, min of 3: 266.03 → 0.37ms and 1353.82 → 0.52ms. Diagnosed
  by the RATE and not the time — a degree product's ns/path FALLS as the path count grows while
  the general matcher's is FLAT, so the cliff is a rate that stops falling (8.7 / 9.9 ns at three
  and four hops, 425.6 at five, 433.2 at six). `longChainCount` is a forward sweep of per-position
  WAY COUNTS, **O(hops x edges) in time and O(vertices) in memory** against O(degree^hops) in
  both, and deliberately the GENERAL case rather than a fifth arm, which would only have moved
  the cliff to six. Labels are carried at every position including the two ends, which the degree
  products cannot do. 14 of 14 mutants caught — **three only after two inequality assertions were
  replaced with exact counts**, because `>= baseline` and `> 0` are intervals the mutant lives in.
  The 2/3/4-segment walks are untouched and the regression control is exactly that: 32 bench rows
  at ≥1.0ms, median 1.019, both >10% rows favouring the new side on workloads it cannot reach.
- ~~**The same cliff in NATIVE, and it was the LARGER one**~~ — **CLOSED by item 299 at 10.4x
  (4 hops) and 139.8x (6)** on the repo's own 200,000-node degree-5 fixture, matched reps and
  three alternated rounds, DISJOINT ranges on both wins and overlapping on both controls
  (67,249.5 → 6,465us and 1,392,055.6 → 9,955us; 1-hop 1.00x and 2-hop 0.98x cannot reach the
  arm). At depth it is **74,121x**: 2223.64 → 0.03ms at 11 hops. Native's `exec` tallies an
  aggregate-over-chain and never materializes a frontier (item 296), so it did not OOM where TS
  did — but tallying is once per PATH, and `try_3hop_product_count` stopped at three hops.
  `try_nhop_sweep_count` is the generalization it stops one hop short of, and **the same
  identity**: that arm's `level1[b]` already IS a way-count vector. Node ids are dense `u32` here,
  so the way counts are a flat ARRAY with no hash — which is exactly the TS sweep's open weak
  point. OUT-only and unfiltered, enforced by `out_chain_depth` rather than assumed. 13 of 15
  mutants caught; both survivors provable (N15 perf-only, N12 equivalent because `delete_node`
  empties `out_adj[i]` and detaches every mirror, so a dead node has no edges in either
  direction). **`query/gql` gained `4-hop` and `6-hop` cases** so a regression cannot hide: the
  6-hop shape is 3.1 billion walks and cost 1.39 SECONDS enumerated.
  **One methodology note worth keeping:** the first reading of those two rows compared the control
  at `BENCH_REPS=3` against the new side at the default 7. A min over fewer samples is ≥ a min
  over more, so an unmatched A/B can only OVERSTATE the win (10.3x/144.0x became 10.4x/139.8x).
  It was small here by luck, not by method.
  **The cross-engine agreement in `probe:depth` is now sweep-against-sweep and so much weaker
  than it was.** The strong independent check is item 298's — the TS sweep against native's
  ENUMERATION at 9.77e9 paths, measured before this arm existed — and it cannot be re-run.
  Measure with `cd packages/native && bun run probe:depth`.
- ~~**Mixed directions in the NATIVE sweep**~~ — **CLOSED by item 302 at 137.7x** on an
  ALTERNATING 7-hop chain (4.13 → 0.03ms), and the cliff is gone rather than moved: forward,
  reversed and alternating are all flat in both engines to eleven hops (9.77e9 paths).
  **The obvious case needed NOTHING, and finding that out first is the lesson.** Item 299
  predicted the REVERSED spelling would fall back to enumeration — an equivalent-spelling bug.
  Measured: a reversed 8-hop chain answers in **0.05ms** against the forward 0.02, because the
  optimizer's `orient` rewrite normalizes it before the peel sees it. The invariant was already
  holding. What `orient` cannot normalize is ALTERNATING arrows, and THAT had the cliff — native
  grew ~5x a hop (0.06 / 0.20 / 0.71 / 4.13ms at 4-7) and was **10x SLOWER than pure TS**, whose
  sweep has carried per-hop directions since item 298. `peel_dir_hops` is a SIBLING of
  `peel_out_hops`, not a generalization: the 3-hop edge product genuinely wants one orientation
  (`level1`/`outdeg3` are both `store.out`). 8 of 9 mutants caught; D7 provably equivalent
  (`chain_depth`'s `Dir::Any` guard is redundant — `peel_dir_hops` refuses the hop itself).
- **The 5% toll this cost the FORWARD chain** — **DIAGNOSED at item 302 and ACCEPTED, with both
  obvious explanations refuted.** The 4-hop and 6-hop `query/gql` rows read 0.95x/0.95x over three
  alternated rounds, disjoint ranges, controls flat. (1) Specializing each pass by direction into
  two monomorphic loops made it WORSE (0.93x/0.92x) — reverted, left in the code with its numbers.
  (2) A variant keeping every structural change but reading `store.out` unconditionally — NO
  direction logic at all — still read 0.95x/0.95x. **So it is the TOLL for editing this module,
  not the feature** ([[pull-alignment-is-load-bearing]] one module along). Accepted: a 5% constant
  against removing an O(degree^hops) cliff. Do not re-attempt the specialization.
- ~~**The gated chain BELOW four hops**~~ — **CLOSED by item 306 at 11.13x (ts) and 19.22x
  (native)** on the new `count 3-hop + end filter` bench row, 200,000 vertices at five edges each,
  three alternated rounds: ts **8391.7 -> 753.7ms**, ffi **274.9 -> 14.3ms**. Items 303/304/305
  MOVED this family's cliff to THREE hops rather than closing it, and only at the END position —
  a degree product answers its last hop as a weighted sum of DEGREES and a degree cannot say which
  of a vertex's edges land somewhere that passes, so an end constraint declines every product arm
  and below four hops nothing else picked it up. The fix is ROUTING (the sweep has carried an end
  constraint since item 303): the floor comes down for a GATED chain only. `count 3-hop +
interior filter` came with it in native (72.7 -> 11.6, **6.27x**) and `count 2-hop + end filter`
  too (57.5 -> 12.1, **4.75x**).
  **THE TWO ENGINES DISAGREE AT TWO HOPS, which is the finding.** The same structural change reads
  1.12 -> 0.71ms in native (1.55x FASTER, taken) and 7.5 -> 28.5ms in TS (**0.26x, 3.8x SLOWER,
  retracted** with its numbers in the code). The tuned two-hop arms are not the same arm in the two
  engines, so one measurement never had a reason to predict the other — and a FLOOR would have
  shipped the TS regression while the native half looked like proof it was fine. Per-depth,
  per-engine rules instead: native takes 4+ always, 3 when any position is gated, 2 only when the
  END is; TS takes 3 only, when the END is gated. **Third time in this family (with item 301), so
  it is the rule and not the finding: the crossover between a sweep and a degree product has to be
  measured per depth, per engine, and per which position carries the constraint.**
  The ungated `count 3-hop` control reads **4.9 against 4.9** on FFI, and `count 2-hop + mid
filter` / `+ start filter` — gated chains the rule deliberately does NOT route — are flat on both
  columns, which is the control that proves the per-position rule rather than merely an unrelated
  row being unmoved. `count 3-hop + end filter` was MISSING from the bench, which is how three
  consecutive items moved a cliff without seeing it; it is a row now.
- **`decode ndjson (5 edges/node)` is the largest ABSOLUTE row in the bench (ts 2784ms against
  native's 766)** — and **item 312 found the recorded target was the wrong operation.** The
  diagnosis carried here and in memory was _"JSON.parse + alloc + freeze, ONE target =
  `addVertex`"_. Decomposed over 200k nodes / 1M edges: `split` 19.5ms (0.7%), `split` +
  `JSON.parse` **546.6ms (19%)**, `addVertex` alone **216.7ms (7.4%)** — and **`addEdge` at ~2.9µs
  an edge, about 85% of the row.** Not wrong that `addVertex` is slow (1.08µs a vertex); wrong
  about which operation the ingest is made of, because a 5:1 fixture is five edge writes per vertex
  write. Linear at 2864/3305/3009/2888 ns per edge over 50k->1M edges, so a constant factor and not
  an algorithmic bug.
  Inside `addEdge`, ablated **alternated three rounds, min of each** (the first pass was
  single-shot against a baseline spanning 2780-3153 and decided nothing): the label index **810ns
  (28%)**, the `@graph/EdgeAdded` emission **573ns (20%)**, `edgesById.set` 282ns (10%), the
  cardinality gate and the property index **0**, the undo closure **~20ns**. The validation prefix
  is 43ns and the pair of `getVertexById` calls that re-resolve endpoints the caller already holds
  is 43ns, so 97% is `new Edge(...)` + `insertEdge`.
  **`recordUndo`'s closure is allocated per edge for nothing outside a transaction** — item 140's
  own lesson at a call site that still has it — and it is worth **20ns, 0.7%**. Not worth the
  guard, which is the kind of certainty worth measuring before acting on. Batching the closures
  into a compact op-record array (asked at 313) buys that 20ns and costs a dispatch switch. The
  transaction case was recorded unmeasured and is now MEASURED (315): a transaction retains **270
  bytes a write** — 54.1 MB per 200k, 270 MB for the million the bench decodes — of which the undo
  closures are **87.5 B/write (32%)**, the buffered events and their token arrays **133.5 (49%)**
  and the touched-vertex set **50.0 (19%)**. Additive to 54.2 of 54.1, byte-identical over three
  rounds. **Open and PRICED, not attempted**: a tagged compact log would capture maybe 55-60 of
  those 87.5 (the operands still have to live somewhere) against a refactor of eight `recordUndo`
  call sites that are each a rollback correctness path.
  **The emission's 500ns — SETTLED at 313, and it is NOT IN THIS ROW.** 312 left it as a measured
  fact with no mechanism (allocate-but-don't-dispatch saves 519ns; dispatch-a-reused-event saves
  ~0; a no-listener early return in `Emitter.emit` **REFUTED** over three alternated rounds,
  {2791, 2965, 2774} against {2830, 2804, 2876}). The early return did nothing because **the
  listener set is never empty**: `Graph`'s constructor subscribes TWO internal listeners to each of
  the sixteen mutation events, and one of them re-emits `@graph/mutate`, which nothing outside one
  test subscribes to. See 313.
  **And this row never paid any of it.** `decode ndjson` wraps its load in
  `disableEvents()`/`enableEvents()` (`serialization/src/ndjson/index.ts:173-201`), so `version`
  after a 240,000-write decode is **0**. The 810ns label index and 282ns `edgesById.set` are in the
  row; **the 573ns emission is not**, and this table overstates the row by that 20%. It is valid
  for `addEdge` as an API call, which is what its probe measured. **A decomposition measured
  through a different entry point than the row is a decomposition of the entry point.**
  `indexEdgeLabel` is **seven hash operations per edge, five string-keyed** (a label bucket, then
  `fromId` -> label -> Set, then `toId` -> label -> Set), which is ~115ns each at a million
  entries. **That makes three independent rows pointing at ONE structural answer** — 310's degree
  product, 311's per-vertex degree reads, and this — all bounded by string-keyed Map operations,
  i.e. item 300's CSR at a priced 7.30x. The INSERT side is the one place not blocked by `edge.to`
  costing a lookup, since `addEdge` already holds both endpoint Vertex objects.
- **Every write through the public API pays a seven-allocation emission cascade to reach nobody —
  1.46x off it (313).** `Graph`'s constructor subscribes **two** listeners to each of the sixteen
  mutation events, so a write with no user listener still runs: `new EmitterEvent` -> `Emitter.emit`
  -> `new Set(2)` -> two dispatches, of which `markMutated` does three array allocations, a closure
  and **a `queueMicrotask` per write**, and `onMutate` builds a `@graph/mutate` wrapper + payload
  for an event **nothing outside one test subscribes to**. Fixed by batching the deferred counter
  work (one microtask per BURST — item 171's short-circuit one level up) and skipping the wrapper
  when `hasListeners` says nobody is there. Priced on the cascade itself, five alternated rounds,
  flat control, with `version` as an equivalence check on every side: **223.2 -> 145.7 ns an emit
  (1.46x)**, of which the batch is 52.8ns and the skip 39.8ns — **both halves earn their place**.
  Rows: 200k `addVertex` **1.17x**, 1M `addEdge` **1.053x** (fully disjoint over five rounds).
  `decode ndjson` **does not move and cannot** — it disables events. No regression on `bench:usage`.
  **The guard's first form was `txDepth === 0 && !hasListeners(...)`; dropping that condition
  SURVIVED mutation**, because `onMutate` never runs while buffering and `commitTransaction` zeroes
  `txDepth` before flushing — unreachable condition, false comment, so the surviving mutant was
  adopted as the code (309's Q9, second occurrence).
  `bench-usage.ts` gained item 307's `BENCH_ONLY` selector: over the whole table the target row
  read **0.738x on ts(-) and 1.569x on ts(+)** while the unreachable native `wasm(-)` column moved
  a median **1.097x**, and the row reads 130.0k isolated against 94.7k in the table.
  `version`/`epoch` — what `@lenke/react` polls — had **no direct test** before this; ten added,
  all passing against the pristine engine too.
- **The rest of that cascade — 2.32x more (314), and the emission is now ~11% of what it cost.**
  The floor came first: the ndjson decode disables events for its whole load, so the same ingest
  loop under `disableEvents()` is the engine with the cascade off — **2345ns an edge against 2783
  before 313 and 2643 after**, so the emission was **~438ns** and ~300ns of it was still there.
  Two parts, priced separately: **`tokensOf` allocated THREE arrays per write** for a topology
  event (`[...labels]`, `Object.keys`, then a spread to join them) where its one hot caller only
  iterated the result — **37.1ns** — and **`Emitter.emit` built a `new Set(...)` snapshot per
  emit** over a listener set that holds the same two functions for a `Graph`'s lifetime, now cached
  per type and invalidated on `on`/`once`/detach — **77.8ns**. Together **164.2 -> 63.7 ns an emit**;
  on the shipped form **145.2 -> 62.6 (2.32x)**, cumulatively **223.2 -> 62.6 (3.57x)** since 312,
  and the 1M-edge loop **2783.9 -> 2393.5 (1.16x)** — leaving **~48ns of the original ~438ns**, near
  enough the events-off floor that the next write-path item should look elsewhere.
  **DECLINED at its ceiling, without being written: an `eventsEnabled()` guard at the sixteen emit
  call sites.** With events off a write still allocates an event and crosses two frames to an early
  return, 1.2M times in the decode row — but deleting those calls OUTRIGHT (an upper bound, not a
  candidate) reads **2345.6 -> 2343.7 (1.001x)**. V8 sinks the allocation and inlines the frames.
  Pricing the ceiling settles a whole family for the cost of one harness.
  **T3 survived mutation and was a real gap**: `once` invalidating on subscribe is only needed for
  `once` on a type already emitted, because its self-detach covers the rest — and the four new
  cache tests had covered that case for `on` and not for `once`.
  `write: append node` **flipped direction between two isolated runs** (117.9k -> 111.7k, then
  113.7k -> 117.6k, native control flat both times): **no regression established, none ruled out
  below ~10%**, and no mechanism for one.
- **A transaction retains 270 bytes a write; one flat token buffer took 16.5% of it (315, 316).**
  Each buffered event carried its reactive tokens in an array hung off the event under a symbol key
  — one array allocation AND one hidden-class transition per buffered write — when **nothing needs
  them grouped by event** (the drain bumps each occurrence once, in any order). Now one flat
  `txTokens` per transaction, the event carries a bare marker, and commit hands the buffer over
  once after the flush: **54.1 -> 45.2 MB per 200,000 writes, 44.5 bytes a write**, byte-identical
  over three alternated rounds, with the non-transaction emit path unchanged in time (63.2 against
  64.9 ns, inside the control's own 74.5/63.2/64.2 spread).
  Four places must agree, which is the whole risk: buffer time pushes, `markMutated` contributes
  nothing for a marked event but still COUNTS the write, commit hands over after the flush, and
  BOTH rollback paths discard — an inner frame to its savepoint mark, a full rollback outright.
  **U7 survived the first mutation run**: dropping the clear on full rollback is invisible until the
  NEXT transaction commits, because nothing is handed to the drain on a rollback at all, so "a
  rolled-back transaction advances nothing" passes with the bug in place. The assertion was in the
  right place and one transaction too early. **U8 looks equivalent and is not** — clearing
  `txTokens` in place when the local commit just took is the same array — and is caught.
  **When the quantity you care about is bytes, measure bytes**: `Bun.gc(true)` + `heapUsed` read
  byte-identical on every round, after a session of 30%-spread timing rows.
- **`traverse 1-hop + filter` is 32x native (48.0ms against 1.5)** — and **item 311 decomposed it:
  the predicate machinery is 9% of the row.** It returns ONE row, so none of it is item 289's
  carrier, and the planner already reaches the right arm (`(a:Person)` is vacuous here, so
  `farWalkFits` routes to the far-side drive that gates each far vertex once and adds its
  in-degree, cheapest-first). 200,000 vertices, 1,000,000 edges, min of 7:
  - `> 1000`, **nothing passes** so no degree lookup runs: **4.39ms** — the whole per-vertex
    machinery, 22ns a vertex.
  - `> -1`, everything passes: 93.11ms. By hand, the in-degree lookups ALONE over 200k vertices:
    35.78ms. So the cost is `index.get(v.id)` then `.get(type).size` — two Map lookups, one
    string-keyed, at **445ns per vertex when all pass and ~1100ns when the passing set is
    strided**, which is cache behaviour, not arithmetic.
  - the whole algorithm BY HAND, no engine: **20.10ms**. So the 32x is ~2.5x of engine overhead
    above a 13x data-layout floor.
    Priced OUT of contention: the BINDING 5.5ms (11%), the `try/catch` in the loop body **0.56ms**
    (folklore), the candidate source 3.8ms and in the unhelpful direction.
    ~~`degreeOfTypes` missing the single-type fast path `bucketSize` has~~ — **REFUTED**, three
    alternated rounds one case per process: control {49.1, 47.4, 45.9} against {49.3, 48.6, 43.3},
    completely interleaved. V8 does not charge for an iterator over a one-element array.
    **The remaining ~2.5x needs a profile, not another hypothesis**, and the 13x floor is the SAME
    CSR target the row below reaches from the other direction — two independent rows pointing at one
    structural change is a better argument for it than either alone.
    In passing: inline `{age: 45}` 6.37ms against the clause `x.age = 45` at 7.30, a 1.15x
    spelling gap on the lifted-equality path — far below this family's historical 4x and 13.3x, but
    the same shape, now measured.
- **`count 3-hop` in TS is 84x native (401.6ms against 4.8)** — the widest cross-engine ratio left
  in `bun run bench`, and **item 310 refuted the two cheap answers to it.**
  1. ~~Route three-segment chains to the SWEEP instead of the degree product~~ — **REFUTED at 10x
     item 301's size.** That verdict was taken at 20,000 vertices and the repo's rule says
     cache-resident and not are different questions, so it was re-measured at 200,000 / 1,000,000
     edges, one case per process, min of 9: ungated **401.6 -> 534.7ms (1.33x WORSE)**, interior
     gated **130.7 -> 433.1 (3.31x WORSE)**. The product makes ONE pass over the edges and
     multiplies two degrees where the sweep makes three — comparing per-edge costs without
     comparing pass counts is comparing the wrong thing. An interior gate WIDENS the gap, because
     the gate shrinks exactly what the product iterates.
  2. ~~Memoize the d-side degree per `c`~~ — **REFUTED by its own control.** Target 394.7 ->
     371.4 (1.063x, DISJOINT over three alternated rounds); `count 3-hop + interior filter`, which
     takes the `needsC` branch and **cannot reach the memo**, 131.9 -> 125.4 (**1.052x, also
     disjoint**). The unreachable control moved as far as the target, so the memo is worth 1.01x at
     most. Item 300's lesson with a sharper instrument: _disjoint ranges are not proof when the
     whole side moves_ becomes **not proof when the change's own unreachable control moves with
     it.**
     **The diagnosis both experiments bought:** the 84x is not one hash per edge, which is why neither
     route touches it. It is spread across the `edgesOfTypes` generator frame (priced at 1.19x on the
     sweep at item 300), the `Edge` property reads, and two hash lookups — ~~and no micro moves a spread
     cost.~~ **That last clause is FALSIFIED by item 324**: removing the FIRST of those three
     components on its own — `edgesOfTypes`' generator frame — moved this row **1.253x** with disjoint
     ranges. A cost spread across three components is still three components, and removing one of them
     removes one of them. "No micro moves it" was a prediction and it was testable for the price of one
     function split. It is the CSR item 300 priced at **7.30x** _(re-priced at item 350: this row is **26x**, not 84x, so the 7.30x no longer holds)_ and declined for needing a dense adjacency the
     TS graph does not expose. So this is a DATA-LAYOUT target with a known ceiling, not an
     unexplained outlier.
     `BENCH_ONLY` now takes a trailing `$` for an exact match, because `count 3-hop` is a substring of
     three other rows and the isolation flag could not isolate the row that needed it.
- ~~**The same reversal in NATIVE**~~ — **CLOSED by item 309 at 3.60x** (`count 3-hop + end
filter` 14.4 -> 4.0ms isolated, min of 9 over three alternated rounds) **and 3.76x** on
  `count 2-hop + end filter` (12.4 -> 3.3), which item 306's rule routes to the sweep precisely
  when the END is gated. 4.0 lands on the start-gated row's own 4.0: after this the two are the
  same shape. Controls flat (ungated 1.02, interior 1.01, start-gated 1.00) and the ts column —
  a free calibrator for a `fastpath.rs` edit — unmoved.
  **The GUARD is the item and it is measured, not chosen.** Native's forward seed is
  `nodes_with_label`, an index bucket, where a reversed seed is a full live-node scan — so an
  unguarded flip LOSES a selective seek: at 200,000 vertices with a 3-hop end gate it is **6.2x
  WORSE at 1% label density and 2.2x worse at 10%**, and only 1.23x better at 100%. So the flip is
  taken only when there is nothing to lose — no base label, or one every LIVE node carries, which
  is then DROPPED rather than demoted (worth more: 12.59 -> 5.23ms, **2.41x**, against the
  unguarded flip's 10.28). With the guard, 1% and 10% are untouched (1.01x, 1.00x) and every
  answer is identical at every density.
  `len() == live_node_count()` rests on an invariant now pinned by its own test: **`delete_node`
  retains the id out of its label buckets**, so a bucket holds only live nodes and
  `|bucket| == |live|` forces `bucket == live`. A first draft used `node_count()` and justified it
  with a coincidence that cannot happen; the live count is sound AND tighter, since the slot count
  stops firing the moment anything is deleted.
  **Four mutants survived the first run and not one was a missing test**, which is the part worth
  re-reading: Q4 edited a branch the guard makes UNREACHABLE (deleted the code — that is the right
  answer to a survivor on dead code); Q9 showed the justifying comment was wrong; Q6's test never
  reached the arm it was named after, because a chain whose ONLY filter is a label is answered
  earlier (`chain_width` sees through an `IsLabeled` filter) — found by instrumenting the arm, and
  fixed by adding an interior property gate so the earlier arms decline. Q7 (invert the flip
  condition) cannot be caught and stays in the set to keep "no test covers this" distinguishable
  from "no test can".
- ~~**An END-gated chain pays for an extra pass AND an unnarrowed seed**~~ — **CLOSED by item 308
  at 3.69x** (`count 3-hop + end filter` 705.0 -> 190.9ms, one case per process, min of 6 over
  three alternated rounds). A gate on the LAST position costs twice: it needs a pass of its own
  (item 303), and every pass before it runs over a frontier nothing has narrowed. A gate on the
  FIRST costs neither. Same chain, same gate, different position, 20,000 vertices of degree 3: ts
  19.2ms at position 0 against 41.7 at the end, native 0.29 against 0.80. So an end-gated chain
  whose start is ungated is **READ BACKWARDS** — a fixed-length chain reversed is the same multiset
  of walks, which is `reversedTwoHop`'s argument with the depth generalized, and the label seek
  survives because `candidateVertexSource` takes whichever end becomes the start.
  **190.9 lands next to the START-gated row's 183.1, which is the check that matters**: after this
  the two are the same shape. Controls chosen to be reachable-but-not-reversed (start-gated 1.01,
  interior 1.00, ungated 1.01), all flat on both columns.
  6 of 6 correctness mutants caught — the reversal is index arithmetic over three parallel
  sequences, so the failure modes are subscripts and each returns a plausible number. R4 (read the
  LABEL from the forward position) is caught by exactly ONE test, the `(a:A)` end-gated case
  written for this item. **R8 inverts the flip CONDITION and CANNOT be caught**: whether to reverse
  is a perf decision, since backwards is the same count, so it stays in the set to keep "no test
  covers this" distinguishable from "no test can".
  ~~**Still open: the same reversal in NATIVE**, priced at 2.5x by the position table and ~3.4x by
  the bench row's own FFI column (14.3 against the start-gated 4.0)~~ — **STALE, CORRECTED BY ITEM
  400: it is BUILT.** `opt.rs`'s `split_chain` reverses at every gate position, and the probe
  PRINTS THE PLAN rather than inferring it (100k nodes x 5, range index on `age`): START gate
  `RangeSeek{label: Some("Person"), age > 88}` + Out/Out/Out at 0.83 ms; **END gate the same seek
  - In/In/In at 0.87**; INTERIOR `In/In/Out` at 1.35 — the backwards-then-forwards split — against
    an ungated control of 2.29 ms with a bare `Scan`. **Parity, not 2.5-3.4x.** The promotion the
    note called missing is visible as `label: Some("Person")` ON THE SEEK, and the guard it asked
    for exists: with an UNLABELLED far end and no index on the key the rewrite DECLINES and keeps
    the labelled bucket (`Scan{label: Some("Person")}`, Out/Out/Out). Its TUNING is not established
    — that case's predicate reads a property no node has, so only the choice is demonstrated.
- ~~**A START-gated THREE-segment chain in TS**~~ — **CLOSED by item 307 at 17.40x** (3214.1 ->
  184.7ms on the new `count 3-hop + start filter` row, one case per process, min of 6 over three
  alternated rounds). Item 306 routed the END at that depth and left the START **enumerating**:
  141.3ms against 16.3 for the same chain unfiltered at 20,000 vertices, where native answered it
  in 0.34 — a **415x cross-engine gap on one position of one depth**, and no bench row was looking
  at it. `inStart` is computed for two segments or fewer and `threeSegmentCount` carries an
  interior predicate only, so the shape fell through every arm.
  **The END or the START, never an interior ALONE**, and that is a measurement not a guess: an
  interior gate at three segments reads 8.1ms against the ungated 16.3, i.e. the gate makes the
  degree product FASTER than its own unfiltered self, because the product iterates the MIDDLE and
  a gate there shrinks what it iterates (item 219). One depth, three positions, three different
  right answers.
  **`count 3-hop + end filter` read 0.82 with DISJOINT ranges and was NOT a regression** — in
  isolation it is 728.1 against 723.7, fully overlapping. Its neighbour `count 3-hop + start
filter` runs immediately before it and spends 3.3 SECONDS in the general matcher on the control
  side against 230ms on the new one, warming the exact path. Same contamination item 290 recorded
  for `3 hop, count(d.k)`: a large speedup can make its NEIGHBOUR look slower, and the tell is
  that the "regressed" row's own ROUTE did not change. **`BENCH_ONLY` is now part of `bun run
bench`** so one-case-per-process is a flag instead of the bespoke script items 290/300/303 each
  wrote by hand.
  Still open and priced at 19.2ms: a REVERSED three-segment route. Reversing the chain would make
  a gated end into a gated start, and item 301 measured the three-segment product at 1.50x the
  sweep unfiltered — so a reversed product might beat what the sweep now does. The two-segment
  case already works that way (`reversedTwoHop`), which is also the DIAGNOSIS item 306 lacked for
  why its two-hop attempt lost: the existing route gates the end once per vertex over a SELECTIVE
  set, where the sweep seeds everything and interns every vertex it reaches.
- ~~**Per-position NODE labels in the NATIVE sweep**~~ — **CLOSED by item 304 at 32.4x**, as a
  side effect: `IsLabeled` is one of the gate's leaf forms, so `(n2:H)` at an interior position
  went 35.60 -> 1.10 ms. Worth recording how nearly this was mis-retired — a post-change reading
  of 1.1 ms with NO control looked like "it was always fast via another arm", and only the
  alternated A/B showed the control at 35.6 ms. The coverage is still hand-written tests plus
  `rewrite_fuzz`; the differential fuzzer generates no chain of this depth
  ([[engine-corpus-nested-fuzzer-gap]]).
- ~~**`longChainCount`'s `Map<string, number>`**~~ — **CLOSED by item 300 at 1.29x (5 hops),
  1.65x (6) and 1.28x (7 reversed)**, all with DISJOINT ranges over three alternated rounds and
  both controls (3- and 4-hop, which route to the degree products) flat at 0.98x/1.04x. A lazy
  dense index — slots interned on first REACH, counts in `Float64Array`s — plus a PER-SLOT
  adjacency cache taken when every leg runs the same way.
  **Three of the four obvious explanations for the cost were WRONG,** which is the part worth
  keeping. The `edgesOfTypes` generator frame is worth 1.11x; `get`-plus-`set` versus `get` is
  worth 1.26x (so "two string hashes an edge", item 298's own guess, was not it); and routing the
  identical dense algorithm through `intern`/`bump`/`widen` HELPERS threw away almost all of its
  win — 1.20x against the inlined 2.11x, i.e.
  [[ts-closure-size-is-load-bearing]] for the fifth time in this file.
  **The micro promised 2.30x and the engine delivered 1.27x, and chasing that gap was the find.**
  Re-running the micro with its per-slot bucket cache removed gave 1.22x, agreeing with the
  engine — the micro had been caching an adjacency lookup it could only cache because all ITS legs
  were `-[:E]->`. So 2.30x was never available; but the cache IS sound when every leg shares a
  direction, and taking it turned 1.27x into 1.29-1.65x. The 6-hop MIXED-direction row declines
  the cache and moves only 1.06x, so the dense rewrite alone is near-neutral in situ and the
  cache is the win it enables.
  Measure with `cd packages/native && bun run bench:chain` — a DIFFERENT instrument from
  `probe:depth`, because depth needs a tiny graph to show the rate and a constant factor needs a
  big one to show itself.
- **The EAGER index over all V, worth a further 1.76x** — **PRICED AND DECLINED at item 300, not
  missed.** Scanning `0..V` and skipping zeros beats tracking a frontier while the frontier is
  SATURATED (201.6ms against the lazy 370.2), and costs O(V) memory and O(V) hashes whatever the
  frontier's real size — so a selective start over a large graph pays for the whole graph.
  Bounded memory is this arm's premise (items 296-298) and taking both regimes means two sweeps,
  i.e. two definitions of one thing. The CSR floor below it (6.56x) needs a dense adjacency the TS
  graph does not expose; NATIVE already has one, which is why its sweep needs no hash at all
  (item 299). Re-open only with a routing rule that does not duplicate the sweep.
- ~~**Routing 3 and 4 segments to the SWEEP instead of their degree products**~~ — **CLOSED by
  item 301, and the hint was HALF WRONG.** A SPLIT verdict, 200,000 vertices at degree 3, three
  alternated rounds, disjoint ranges on both: at FOUR hops the sweep wins **1.91x** (980.2 →
  512.4ms) and at THREE it LOSES **1.50x** (250.1 → 374.9ms). So four and up now sweep, three
  stays on its product, and `fourSegmentCount` was DELETED (110 lines) rather than left
  unreachable — its gates were identical to the sweep's, so the sweep subsumes it exactly. Final
  A/B after the deletion: **1.71x at four hops** (the conservative min-of-min; round 3 was noisy
  on the swept side), 3-hop unmoved with OVERLAPPING ranges, and the 5/6/7-hop rows flat as
  internal controls. The four-hop spelling pair moved 754.8 → 595.2ms.
  **Why it splits, which the asymptotic hint missed:** `threeSegmentCount` pays per MIDDLE EDGE
  and multiplies two degree SIDES — O(E), no frontier, no hashing — which beats three sweep passes
  with a hash an edge. The four-segment one paid per INTERIOR PAIR, O(E x degree), which loses to
  four O(E) passes. **The crossover is exactly where a product stops being linear in the edges.**
  Taking the hint on trust would have made the 3-hop count 1.5x slower.
  **The deletion made the suite STRONGER and that is measured:** item 290's 27
  `four-hop-count.test.ts` tests, written against the degree product before the sweep existed, now
  exercise the sweep — an independent oracle in the strongest sense available. Re-running item
  300's 13 mutants with that coverage, every catch count ROSE (M6 18 → 34, M10 19 → 32, M4 17 → 28) and all 13 are still caught. Deleting a tuned arm normally loses its guards; here it
  transferred them, because both arms answered one question under identical gates — which is what
  was checked BEFORE deleting.
  ONE and TWO segments are not touched and will not be: they carry predicates and inline gates the
  sweep has no route for (items 219-222).
- ~~**`decodeRows`' per-row closure**~~ — **CLOSED by item 289 at 1.10-1.21x** on single-column
  row results, disjoint ranges, for every native query that returns rows (FFI and wasm share
  `graph.ts`). The shaping loop allocated a closure PER ROW (`columns.forEach` inside `rows.map`)
  and re-read `columns` through the outer closure each time; plain nested loops instead.
  **`project 3` is NOT a win — its ranges OVERLAP** — and the isolated stage predicted 6% there
  (4.45 → 2.23ms of 36.41). **A stage timed in isolation on warm, already-parsed data overstates
  its share of the whole:** in situ the loop runs right after a 17ms parse and its real cost there
  is under the noise floor at 40ms. All five mutants caught (column order by 196 tests including
  the differential fuzzer), so NO new tests — the surface was already saturated, the opposite
  finding from items 286 and 288.
- **`bench:usage`'s indexed read rows, where native LOSES 3-5x to pure TS** — **PRICED AND
  ACCOUNTED AT ITEM 291, two routes open and one closed.** Point lookup ts(+) 1.19M ops/s against
  engine(+) 240.8k; 2-hop recommendation 536.8k against 154.9k. **The FFI boundary is INNOCENT** —
  a `vertexCount` round trip is **8ns**, 0.3% of the call — so item 289's bulk-egress finding does
  NOT transfer to small size. The accounting instead: **`gql::parse` of a 57-byte query is 1296ns,
  4.4x the 298ns exec it enables**, `optimize_indexed` adds 330, render 49, JS decode 149, plan
  clone 57. Parse is 43% of the 3005ns call.
  **Why TS wins, exactly:** its `parseCache` keys on the query TEXT because a `Statement` is inert
  and params bind at EXECUTION; `gql::parse_with_params` SUBSTITUTES params during parse (so the
  planner sees literals and still seeds an index), which makes the parsed plan depend on the param
  VALUES. The serving shape is `WHERE u.name = $n` with a different value every call.
  - ~~a text-keyed parse cache~~ — **CLOSED, unsound** while parse substitutes params, and useless
    where the value differs every call.
  - **route the unprepared path through a cached PREPARED statement** — priced at **1.43x**
    (3779 → 2648ns, measured with `$n` varying), reusing `lnk_prepare` + bind-at-execution. The key
    needs a STORE VERSION beside the text: `optimize_indexed` reads the store, and a plan that
    seeks a dropped index is a wrong answer, not a slow one.
  - **the residual is BIGGER than that fix:** prepared is still 2648ns against TS's 840ns, and
    after exec/render/decode/boundary that leaves **~1500ns of FFI plumbing** — the error slot, two
    `catch_unwind` guards, the params JSON round trip, and `takeResult`'s buffer copy per call. Its
    own target, and the larger one.
    Reproduce with `percall_probe` (indexed in `examples/README.md`); do not re-derive from the FFI
    side alone — **decomposing on ONE side of a boundary cannot tell you which side the cost is on**,
    and doing so here made 338ns of engine work read as 1865ns.
    **Item 292 split that residual.** JS-side plumbing is ~411ns (`toArrayBuffer` **123.9ns** is
    the only real item; the slice copy 56.4, `JSON.stringify` of params 46.5, `encode` 26, `ptr`
    9, decode+parse 149). Rust-side a prepared call is ~781ns, and **two of those are avoidable**:
    the "prepared" path **RE-OPTIMIZES every call** (295ns — it skips the parse but not the plan)
    and **marshals a 64-bit handle plus params as a JSON payload** (165ns to `parse_json` in Rust,
    ~47ns to stringify in JS) because it rides the generic `lnk_command(name, input)` dispatcher
    rather than a dedicated entry point like `lnk_query`, which already takes params as a byte
    buffer.
    **CORRECTION (item 293, one commit later): only the JSON marshalling is avoidable that way.**
    Item 292 said the re-optimize could be removed by keying a plan cache on a STORE VERSION. It
    cannot: `bind_params` runs BEFORE `optimize_indexed` by design — `ir.rs` says `Param` is
    "replace[d] with the supplied value before `opt`/`exec` run, so a `Param` reaching evaluation
    is an unbound-parameter error" — so the optimized plan has THAT CALL'S param values baked in
    and is not reusable across calls with different values. A (text, store-version) key would
    serve stale values: a wrong answer, not a slow one. **The design that would remove it is to
    optimize the PARAMETERIZED plan and bind into the optimized one**, and the optimizer has
    partial support for that already (`opt.rs`'s seeding-key match admits `Expr::Param` beside
    `Expr::Lit`, and a comment notes "a parameterized or unmeasurable bound is still seedable").
    But that INVERTS the documented IR contract and hands the optimizer less information — a
    literal bound can be measured against the index, a param cannot — so plan CHOICE can get worse
    where answers are preserved. Its own item, not a cache key.
    So ~212ns of the 2648 is avoidable cheaply (the JSON round trip), not ~460ns.
    **~1456ns stays diffuse** — `catch_unwind` entered twice,
    `out_bytes` + `lnk_free`, `ffi_error::begin()`, bun:ffi's per-ARGUMENT marshalling
    (`vertexCount` takes one argument and costs 8ns; `lnk_command` takes five), and the `String`
    allocations in `prepared_payload`. **That needs a profiler, not another probe.**
- ~~**The frontier guard was REACTIVE and blind to WIDTH**~~ — **CLOSED by item 296** after an OOM
  took a 61 GB box into its 192 GB swapfile (2026-10-10). `limits.intermediate` (50M ROWS) is
  checked by `guard_intermediate(expand(...))` — and Rust evaluates the argument first, so the
  batch is already materialized (`keep`/`nbrs` grown, every input slot gathered, `nbrs`/`eids`
  cloned) before the row count is read. It also counts rows, so it never saw that a 6-hop `MATCH`
  materializes a SEVEN-slot frontier: 62.5M rows x 7 = 437M cells and ~2 GB, while 12.5M rows x 6
  (~1 GB) sails under a 50M-row ceiling entirely.
  **New `limits.intermediate_cells` (200M default, `ConfigId = 6`, native-only like
  `LimitsDictMaxDistinct`)**, checked INSIDE `expand` once per SOURCE ROW so the refusal lands
  while the vectors are still growing; overshoot is bounded by one vertex's degree. CELLS and not
  bytes because `keep` is a `Vec<usize>` (4 bytes on wasm32, 8 on x86-64) — the same portability
  argument `intermediate` makes for rows, and the same one
  `the_ceiling_counts_path_elements_not_just_rows` already made for the shortest-path guard. NOT
  RAM-derived: a query that fails on a small box and passes on a large one is a divergence.
  Screen: 72 cells, **median 0.999**, 96% within ±5% — a per-source-row check in the hottest loop
  in the engine costs nothing measurable.
  **The probe measured NOTHING TWICE before this was right:** `count(*)` and then `count(far.k)`
  both passed every row, because native's `exec` answers an aggregate-over-chain with a TALLY and
  never runs the expansion. Only a bare PROJECTION materializes the frontier. The probe now prints
  whether the optimized plan contains an `Expand`.
- ~~**The TS aggregating projection RETAINS every binding**~~ — **CLOSED by item 297 for
  `count(*)`: a 5-hop count goes from OOM-KILLED under a 4 GB cap to 2,793 ms at 123 MB RSS, and
  the 6-hop query that took the box down to 14,090 ms at 127 MB.** `count(*)` compiles to
  `group.length` and nothing else, so when EVERY aggregate in a projection is `count(*)` a counter
  plus one representative replaces the bindings — O(groups), not O(rows). `having` is excluded
  rather than analysed (it receives the group and may do anything). The twenty-case
  `hasAggregate` walk became `collectAggregates` with both questions expressed over it, so the new
  admission check is not a second copy. The counted bucket is replayed as a **Proxy** reporting the
  real `length` over a length-1 array, which throws on any index past the representative — the lie
  is loud rather than silent.
  **IT IS A MEMORY FIX, NOT A TIME ONE:** 1.00x at 8 groups, 1.03x at 1000, and the 1.16x at N
  groups is NOT claimed (rounds overlap 19.1/13.1/19.0 against 20.6/11.3/11.3). Controls that keep
  their bindings either way read 0.98x (`sum`) and 0.96x (`collect_list`).
  **T10 is an EQUIVALENT mutant, provably:** dropping `!a.distinct` while keeping `a.star` can only
  matter if `count(DISTINCT *)` is expressible, and it is `E_SYNTAX`.
  Still O(rows): `sum`/`min`/`max`/`avg`/`stddev` (foldable, but `avg` needs `(sum, count)` and
  `stddev` the moments, so they need partial state plumbed through `compileAggregate` — and the
  accumulator must fold the array path too, or it becomes a second definition of the semantics)
  and `collect`/`collect_list`/percentiles (genuinely need every value).
  How it was found, since the attribution was the hard part: item 296 showed native TALLIES an
  aggregate-over-chain and never builds the frontier, so the engine that OOM'd had to be the TS
  one — and 3 and 4 hops run in 8 and 13 ms at ~80 MB where 5 is fatal, which is exactly the count
  family's ≤4-segment coverage edge (item 290).
- **DECIDED AND DONE — a graph element casts to NOTHING; the survey found FOUR divergent shapes, not
  one (353).** Item 346 reported `CAST([n, ''] AS STRING)`; item 347 established from ISO's free
  artifacts that this is not a place implementations may choose; the decision came back **refuse**.
  **SURVEYING FIRST FOUND THREE MORE**, and the direct cases are worse than the reported one:
  `CAST(p AS STRING)` gave native **`"0"` — the INTERNAL DENSE ID** against TS's `"a"`;
  `CAST(p AS INTEGER)` gave native **`0`** where TS already **threw**; `CAST(r AS STRING)` native
  `"0"` vs TS `"e1"`; plus the reported nested form. `CAST([1,2] AS STRING)`, `CAST({a:1} AS
STRING)` and `CAST(p.k AS STRING)` already agreed, so nothing legitimate was at risk — and **TS's
  existing numeric refusal gave a phrasing to converge on rather than one to invent.**
  **THE CHANGE**: an element casts to nothing for every target, in both engines, checked BEFORE the
  target table for the same reason the NULL rule is — it is a property of the SOURCE, not the type
  pair. native: `value::cast` gains an element arm, and `Expr::Cast` moves from `col.value_at(i)` to
  `cell_value(&col, i, store)` because **`value_at` on an element column yields the dense id, so the
  element never reached `cast` to be refused** — _item 345's bug in a second place_ (the `Record` arm
  read `value_at` where its sibling read `render_cell`). TS: the same check in `castValue`, plus a
  named `castTargetName` so both engines spell the target identically (`integer`/`float` → **number**).
  Messages byte-identical by construction and asserted AS TEXT in both suites, not just "it throws".
  **⚠️ THE NESTED CASE WAS LEFT OPEN HERE AND IS NOW CLOSED BY 354 — and the reason given for
  leaving it was wrong on both counts.** This entry said _"the engines cannot share a mechanism: TS
  keeps element identity at every depth, native does not"_. Neither half held. TS did **not** keep
  identity at every depth in the way that mattered — its map/record nesting already AGREED with
  native (both render the element map) and only the LIST path diverged, because `str()` renders an
  array with `joinElement` and a record with `JSON.stringify`. And the shared mechanism **already
  existed in the engine**: `sort_local_key_is_element` has refused `order(local)` over elements by
  exactly the dual ref-or-rendered-map test since long before this item. See 354; the surviving
  honest part of this paragraph is that unboxing native's containers is still the architectural
  follow-up, and still parked.
  **Why refusing was right regardless of the prose**: nothing in the free artifacts says the cast
  exists, nobody can have relied on it (the engines never agreed), and a refusal relaxes cleanly to
  whatever the cast table specifies. Picking one engine's answer would have to be un-picked.
- **DECIDED AND DONE — a graph element casts to nothing at ANY DEPTH; the premise used to leave this
  open was itself wrong (354).** The decision on 353's open half came back **error**, and
  implementing it refuted both halves of 353's stated reason. _"TS keeps element identity at every
  depth"_: no — the map/record nesting **already agreed** (`CAST({v: p} AS STRING)` rendered the
  element map in both engines); only the LIST path diverged, because TS's `str()` renders an array
  with `joinElement` (element → external id) and a record with `JSON.stringify` (element → element
  map), so **TS's two container paths disagreed with each other.** _"The engines cannot share a
  mechanism"_: they already did — `exec::aggregation::sort_local_key_is_element` has refused
  `order(local)` over elements by exactly the dual **unboxed-ref OR rendered-element-map** test for
  a long time, and its own comment states the diagnosis (_"checking only the refs found nothing and
  the fault never fired"_). **A scope claim is a measurement**, and this is the fourth time this
  session that checking one inverted the recommendation resting on it (342→343, 343→348, 350→351).
  **SURVEYING FIRST FOUND SEVEN DIVERGENT SHAPES IN THREE FAMILIES**, not the one reported: the list
  literals (`[p]`, `[r]`, `[[p]]`, `[p, '']`), **the path ACCESSORS** (`nodes(p)`, `edges(p)`) and
  **the path VALUE itself** — the last two families being lists of elements by construction rather
  than by a literal, i.e. the shapes a real query actually hits.
  **THE CHANGE**: `value::contains_element`, recursive through lists, records and maps (both KEYS
  and values, since a Gremlin map keys by any value), testing BOTH forms an element arrives in;
  `cast` uses it in place of a top-level 2-tag match, with the same message reused because it is the
  same rule — _a graph element casts to nothing, wherever in the value it sits._ The field-set test
  (`vertex_map_ext_id`/`edge_map_ext_id`) **moved crates** into the value contract, since `cast`
  lives in `lenke-engine-core` and could not reach `exec::render`; the two near-identical copies
  collapsed into one function parameterized by the field set.
  **⚠️ THE OTHER COHERENT ROUTE, recorded because reversing this is cheap**: since the map nesting
  already agreed, the alternative was to make TS's list path match its own map path — render the
  element map in both and refuse NOTHING. Route 1 (refuse) was taken because it is the decision and
  the only one statable in one sentence, but it does cost three previously-AGREEING shapes (`{v: p}`
  and its two nested forms), turning them from "renders the element map" into an error. A refusal
  relaxes cleanly if the paywalled cast table says otherwise; a guessed value would have to be
  un-picked.
  **The predicted false positive is NOT REACHABLE, measured rather than assumed**: native's
  rendered-shape test would wrongly fire on a hand-written `{id, labels, properties}` map, which TS's
  identity test would not share — except a GQL `{…}` literal lowers to a `Value::Record` and the
  shape test keys on `Value::Map`, so within the only surface that HAS `CAST` an element-shaped map
  can only BE a rendered element. Both lookalike rows still render in both engines and are pinned as
  controls, so TS's check stays pure identity and no shape test was added there.
  **TEETH**: 5 behavioural mutants all CAUGHT (list arm, record arm, rendered-vertex test,
  rendered-EDGE test alone, field-set guard) by exactly the new test, plus a behaviour-preserving
  CONTROL mutant that survived as it must; cap proved to kill first (137 and 124).
  **⚠️ A MOVED LINE IS STILL AN UNTESTED LINE** — the `keys.len() != pairs.len()` guard (rejecting a
  duplicate or non-string key whose key SET still matches) survived the whole 1,101-test engine
  suite, because **it had no test in the place it moved FROM either**; the mutant is what said so,
  and it now has a direct unit test.
  **The fuzzer hole is closed, and its own exclusion note had an expiry date**: item 346 deliberately
  kept the cast shapes out, saying they _"would make the fuzzer red for an unrelated reason"_ while
  the divergence was open. Lifted — `genHopProjection` now generates five must-refuse cast shapes
  and two that must keep WORKING, so the block is not purely a refusal check. Verified by disabling
  native's list arm: red in one run, naming the shape.
  **COST: none measurable.** Alternated A/B, min of 7, three rounds, 200k rows: every cast row
  within 1% (`CAST(n.s AS STRING)` 21.9 vs 21.8 ns/row), while the null-control row the change
  cannot reach drifts **6.6% by itself** — the noise floor is several times the effect being
  claimed. Probe deleted.
- **⚠️ OPEN, found incidentally by 354's control rows — the rest of the cast table's MESSAGES
  diverge, and the fuzzer is blind to the class.** `CAST([1,2] AS INTEGER)` → native `cannot cast
list to number` vs TS `cannot cast a list to number`; `CAST({a:1} AS INTEGER)` → native `cannot
cast record to number` vs TS `cannot cast **a map** to number` (a different TYPE NAME, not just an
  article). Both raise `E_INVALID_VALUE`, and the differential fuzzer compares CODES, so nothing
  reaches this. Item 353 made the ELEMENT messages byte-identical by hand; the rest of the table was
  never checked.
- **⚠️ OPEN, same origin — `from` as a bare record-field name.** `RETURN {from: 1}` → native accepts
  it, TS rejects it as a reserved word (_"quote it as a delimited identifier with backticks"_).
  Found because an edge-element lookalike map needs a `from` key. Whether `from` is reserved in that
  position is an ISO BNF question and needs the grammar, not a guess.
- **The 26x row's remaining cost is LOCALITY — 2.9x per-edge degradation from size alone, which
  partly rehabilitates item 300's CSR (352).** Item 351 left the state honest: _"what is left in the
  38 ns an edge is not known… a fresh decomposition is the next step."_ This is it, and it lands
  somewhere neither 350 nor 351 expected.
  **TWO PROFILING TRAPS, both recorded because both cost a round.** `bun --cpu-prof` profiles the
  WHOLE PROCESS: (1) a 200k/1M fixture with 12 queries profiled as 19.5% `indexEdgeLabel`, 15.6%
  `JSON.parse`, 9.2% `getVertexById` — **every top frame is INGEST**, the fixture build swamping the
  region of interest (same family as 339/341: what was measured was not what was claimed); (2)
  shrinking the fixture and running 600 queries gave **5.6 ns/edge against the bench's 38** — a tight
  repeat loop is a **different operating point** (warm steady state) from a min-of-5 harness.
  **THE SWEEP IS THE FINDING** — CLAUDE.md's first rule for a number like this. Same query, same
  code, every size warm so the comparison is across SIZE not JIT state. ns/edge: 100k edges **5.6**,
  250k **8.0**, 500k **14.2**, 1M **16.0** — **2.9x per-edge degradation from size alone.** Nothing
  algorithmic changes; it is the same work per edge costing three times as much because the data no
  longer fits. Native over the same 1M edges is ~1.5 ns/edge and does not show it. (Absolutes are a
  warmer operating point than the bench's 38 ns/edge; the SHAPE is the result and is internal to one
  run.)
  **THIRD CORRECTION IN THIS THREAD, and this one favours the CSR.** 350 declined it (7.30x priced
  against a stale 84x); 351 observed that _"the three-component diagnosis keeps yielding to
  component-sized fixes, which is the opposite of what 'it needs a CSR' predicted."_ That reads
  differently now: the components that yielded — a generator frame (324), a string-keyed adjacency
  lookup (321) — were **interpretation and hashing**, and they are gone. **What is left is
  LOCALITY**, which no component-sized fix can touch and a dense adjacency precisely addresses. So
  item 300's MECHANISM was right even though its NUMBER was priced against a figure that no longer
  holds. **The CSR is no longer declined for the right reason** — it is still the representation
  class item 348 parks, still blocked on a dense integer-indexed adjacency the TS graph does not
  expose, and 2.9x of locality degradation is no promise that a CSR recovers 2.9x; but the next
  person should know the remaining cost is DATA LAYOUT, measured, rather than "three components, two
  left".
  **And the trap that nearly ate the result**: writing the sweep with `cat > file` failed on
  `noclobber` and **the stale probe ran instead**, printing the previous experiment's output —
  caught only because the numbers were visibly the old ones. Exactly the documented failure (_"the
  next command runs anyway and consumes the stale file, so the failure surfaces as a wrong result
  rather than an error"_). Written with the editor tool and a fresh name the second time.
- **`min`/`max` FROM THE RANGE INDEX — 2455x and 2567x — after the path sat DEAD because THREE other
  fast paths claim a bare `Scan` (371).** Item 370 made the extremes exact; this spends them.
  `try_indexed_min_max` reads the `BTreeMap`'s first/last key in O(log n) where a column scan is
  O(live nodes). **The real work was proving the ORDERS agree**: `OrdVal` compares by
  `value::cmp_total` and so does `min`/`max`, but reading two comparators is not evidence, so the
  differential test carries a **mixed-type column** (strings AND numbers, which `Column::Num`'s
  path cannot serve, so only the general aggregate can — where a disagreement would show) and a
  **NaN** computed with `SET n.n = sin(1e400)` because the fixture cannot express one, plus a
  present null, a key nothing carries, a non-vacuous label and `min(DISTINCT …)`.
  **MEASURED**: `min(p.age)` **711.9 → 0.3 µs, 2455x**; `max(p.age)` **718.6 → 0.3, 2567x**;
  **CONTROL `avg(p.age)` 1.0x** (it needs every value, so no ordered index can serve it) and
  **CONTROL `count(*)` 1.0x**. Three rounds: min 2455/2639/2638x, max 2567/2557/2651x.
  **⚠️ THE PATH SHIPPED DEAD, TWICE, AND NO TEST COULD CATCH IT.** The first bench run read **1.0x**
  for both rows while every test passed. **THREE other fast paths can claim `min`/`max` over a bare
  `Scan`** in a 32-entry chain: `try_scan_multi_agg`; the general aggregate; and — the non-obvious
  one that actually caught it — **`try_frontier_prop_agg`, which gates on `chain_width(input)?`, and
  `chain_width` returns `Some(1)` for a bare `Scan`** ("a seek, like a scan, seeds a single-slot
  frontier"). **A plain scan is a trivial frontier**, so a path named for frontiers claims a scan.
  Moving above `try_scan_multi_agg` was NOT enough; the second run still read 1.0x.
  **No test could have caught it**: a differential test comparing answers with and without the index
  passes trivially when BOTH sides take the scan, and the eligibility assertions call the function
  DIRECTLY, proving it is willing rather than reached. The instrument was an `eprintln!` at function
  entry (item 267's "one eprintln settled it", in a new place).
  **So the method's "verify the planner reaches the shape" needs a second half: VERIFY THE DISPATCH
  REACHES THE FUNCTION.** A plan-shape check is necessary and not sufficient when 32 ordered
  candidates can claim the same plan.
  **TEETH**: any-label **CAUGHT**; swap the extremes **CAUGHT**; accept `distinct` **CAUGHT** — and
  note it is caught by the ELIGIBILITY assertion, not a wrong answer, since `min(DISTINCT k) ==
min(k)`: the gate encodes a consistency decision (every sibling declines `distinct`) and the test
  pins the decision rather than a correctness property. Control survived. Two mutants initially
  failed to APPLY because the gate line is shared verbatim with `try_frontier_prop_agg` — which is
  how that path was found.
- **The RANGE index is the THIRD twin with the same emptied-key bug — and here a stale key is a
  WRONG MINIMUM, not an inflated count (370).** Items 367/368 fixed the hash index's delete then set
  path; grepping for the next index-answerable aggregate found it again in `range_remove`, which
  did `bucket.retain(|&x| x != node)` and left the KEY. **In this fix's favour**: both write paths
  route through `range_remove`, so one guard covers both (where 367 and 368 needed two separate
  fixes). **Against it**: a stale hash key only inflated a COUNT, but a stale range key is an
  ORDERED POSITION, so the `BTreeMap`'s first/last keys stop being the live min/max. `range_lookup`
  is safe either way (empty buckets contribute no ids, deleted ids are filtered) — **any reader of
  the KEYS is not**, and `min`/`max` from this index is exactly that reader.
  Shipped with `range_min_max(key)`: the live extremes in O(log n) against the O(live nodes) column
  scan `try_scan_num_agg` does.
  **TEETH**: the test removes the current extreme at each step (the only observable case) — delete
  the min's holder, delete the max's, delete one of two holders of a surviving value (nothing may
  move), then UPDATE the last holder away, which exercises the SET path through the same
  `range_remove` rather than assuming it shares the fix. Mutation-verified with the WRONG-ANSWER
  signature: without the guard the min stays at a **deleted node's value** (`Num(10.0)` instead of
  `Num(50.0)`).
  **⚠️ COST, AND THE COVERAGE GAP THAT HID IT: no write-throughput benchmark creates a RANGE
  index.** `bench:usage` indexes `kind: 'hash'`; range indexes live only in `spelling_probe` and
  `simd_index_probe`. So anything added to the range write path is invisible to the standard
  harnesses (item 356's pattern a third time), which is why this was measured with a dedicated
  probe instead of inherited from the hash result. Worst case — HIGH cardinality, where nearly every
  write empties its bucket so the prune always fires — 200k nodes, three alternated rounds:
  **CONTROL 242/243/241 against NEW 238/235/235 ns/op, DISJOINT, and the pruning is marginally
  FASTER**: dropping the entry keeps the `BTreeMap` smaller so later `get_mut`s are cheaper. It pays
  for itself in a workload that empties buckets.
- **⚠️ OPEN, found incidentally at 370 — a DELETE is ~33µs at 200,000 nodes, and it is O(LABEL
  SIZE).** The same probe's delete column reads **33.2-33.8µs per `delete_node`** on a 200k-node
  label with NO EDGES — three orders of magnitude above the set column's 235ns. `delete_node`
  removes the node from every label bucket and a bucket is a sorted `Vec`, so the removal is a
  memmove over the whole label. **`bench:usage` cannot see it**: its fixture is 20,000 nodes, where
  the same cost is ~5µs and reads as ordinary per-op overhead. Not diagnosed or fixed; recorded with
  its numbers because a delete that scales with the label is a real limit for any churning workload.
- **`count(DISTINCT k)` ANSWERED FROM THE INDEX'S KEY COUNT — 1602x to 17434x (369).** Items 367
  and 368 made the hash index's key count exact and free; this spends it.
  `try_indexed_distinct_count` answers in O(1) where `try_scan_distinct_count` scans every live
  node with a typed-column pass.
  **THE PRECONDITIONS WERE VERIFIED, NOT REASONED.** (1) **NULLs — dissolved**: both
  `count(DISTINCT x)` and the index exclude them (since 368), checked by running a fixture with a
  present null, an absent property and two real values — **both answers are 2.** (2) **The label —
  real, and O(1) to test**: a hash index is ANY-LABEL, so a labelled scan is answerable only when
  the label is **vacuous**, and `nodes_with_label(l).len() == live_node_count()` is exact (label
  buckets ARE pruned on delete) and O(1) (`live_node_count` is `node_count - deleted_count`; the
  O(N) recount is `#[cfg(test)]`). (3) **No other predicate** — the `Plan::Scan` pattern covers it.
  **MEASURED** (`bench_all` `query/seeded` gains a cardinality block, beside the seek row because
  it is the same shape of claim): `count(DISTINCT p.name)` 200k distinct **4184.1 → 0.2 µs,
  17434x**; `count(DISTINCT p.age)` 90 distinct **400.5 → 0.2 µs, 1602x**; **CONTROL `count(*)`
  0.3 → 0.3, 1.0x** — already O(1) from the label bucket, so if it ever shows a speedup the section
  is measuring the fixture.
  **TEETH** — a DIFFERENTIAL test against the path it replaces (same store, same query, with and
  without the index, across a present null, an absent property, a key nothing has, a non-vacuous
  label, a non-distinct count and a grouped count). Mutants: any-label **CAUGHT**,
  ignore-`distinct` **CAUGHT**, ignore-GROUP-BY-keys **SURVIVED (provably equivalent)**,
  behaviour-preserving CONTROL **SURVIVED**.
  **⚠️ TWO OF THE FOUR GATES CANNOT BE REACHED IN A STATE WHERE THEY MATTER, and that is recorded
  rather than papered over**: a non-distinct `count(plain_prop)` is claimed by
  `try_scan_count_prop` EARLIER IN THE CHAIN and a dotted argument lowers to `Expr::Field` (never
  `Expr::Prop`), so the `distinct` mutant was initially NOT caught; and a grouped query's
  `Aggregate` input is `Project { input: Scan }`, never a bare `Scan`, because **GROUP BY takes a
  bound name** so the `LET` always interposes a projection — the `Plan::Scan` pattern declines
  every grouped plan regardless of the `keys` gate (item 288's T10 category). **Both gates stay:
  relying on the ORDER of a 32-entry fast-path chain for CORRECTNESS is what breaks when someone
  reorders it**, and identical gates are what make "the two never disagree about a shape"
  checkable by reading. Pinned by direct assertions on the function, the way
  `try_scan_count_prop` tests its own dotted decline.
- **A NULL was indexed by ONE of the two builders, and item 367's pruning covered ONE of the two
  write paths — both found by a test written to CONFIRM a claim (368).** Item 367's doc comment
  asserted that a stored NULL "counts as a distinct value" and recorded it as a precondition a
  caller must subtract. Checked against `apply_set_prop`, which says the opposite in its own
  comment — _"A NULL is never seek-indexed (`WHERE k = null` matches nothing), so it is excluded
  from both indexes"_ — so the comment was corrected, and **the test written to pin the correction
  FAILED**, surfacing two bugs. **367's claim was wrong about the POLICY and accidentally right
  about the BEHAVIOUR.**
  **BUG 1 — only one of the two index builders knew the policy.** `create_index` indexed every
  present value including NULL; `create_range_index`, the twin builder twenty lines below, already
  does `if !v.is_null()`. **Skipping nulls is the established policy and the hash builder was the
  one place that missed it.** Consequence: **an index's contents depended on WRITE ORDER relative to
  its creation** — a null present at build time got a bucket, a null written afterwards did not. No
  seek could observe it (`index_seek_ids` returns empty for a null value before consulting the index
  at all), but any reader of the buckets could, and 367's distinct count is the first such reader.
  **BUG 2 — item 367 pruned one of the two WRITE paths.** With the builder fixed the test still
  failed: setting the last non-null value to NULL left the count at 1. 367 added the emptied-key
  pruning to `index_drop_node` (delete) and missed `reindex_node` (set) — a node whose indexed value
  CHANGES leaves its old value behind with an empty bucket exactly as a deleted one did.
  **THE PATTERN IS NOT "NODE VERSUS EDGE"** (items 333, 335, 349, 360 were read that way) — it is
  **"this repo has two of most things, and a fix lands on the one you were looking at."** Build and
  update; delete and set; GQL and Gremlin; vertex and edge. One item old and mine, this time.
  **TEETH — the three fixes are guarded INDEPENDENTLY**: build-indexes-nulls CAUGHT by the null
  test; set-keeps-empty-key CAUGHT by the update test; delete-keeps-empty-key (367's fix) CAUGHT by
  the delete tests and the dotted twin; a behaviour-preserving CONTROL SURVIVED. **No test covers
  two of the three**, so each path is pinned by its own assertions rather than by luck.
  **COST**: `bench:usage` `write: property update`, three alternated rounds — indexed
  **300.9/300.2/304.4k against 299.8/301.2/299.6k (overlapping)**, unindexed, where the pruning is
  unreachable, **49.0/49.6/49.0k against 47.7/50.3/50.1k (flat)**. No measurable cost, same as
  367's delete path.
- **Index buckets now drop their emptied KEY, so the distinct-value count is EXACT — and the delete
  cost it was feared to carry is ZERO (367, the user's call).** Item 365 named an O(1) answer for
  `count(DISTINCT k)` over an indexed `k` (the hash index's key count) and declined it as unsound:
  buckets were believed to retain deleted ids, so a value whose holders were all gone would still be
  counted — **wrong, not slow.**
  **DIAGNOSING IT FIRST CHANGED THE SIZE OF THE JOB: the ids were ALREADY pruned.**
  `index_drop_node` has always done `bucket.retain(|&x| x != id)`, so no bucket holds a deleted
  node. What survived was the **empty ENTRY** — the key stayed with a zero-length `Vec`, so
  `map.len()` counted values no live node carries. Three lines, not a storage redesign; and
  `index_bucket_len`'s "may count a few tombstoned ids, which is fine for an estimate" overstates
  what is actually stale.
  **NEW — `index_distinct_count(key)`**: `count(DISTINCT key)` in O(1) against a scan of every row,
  exact over live nodes carrying the property. A node WITHOUT the property is in no bucket (so it
  does not count, matching `count` ignoring absent values); **a stored NULL has its own group key and
  counts as a distinct value**, which is the one thing a caller must handle since ISO/SQL
  `count(DISTINCT x)` excludes nulls.
  **TEETH**: two tests (plus the DOTTED twin — items 333/335/349 were all twin asymmetries), every
  assertion on a value whose holders are ALL deleted, which is the only observable case. Verified by
  MUTATION: removing the `if bucket.is_empty() { … remove }` fails both with exactly the predicted
  values (`Some(3)` against `Some(2)`, `Some(2)` against `Some(1)`). They also pin that pruning did
  not break the LOOKUP — a seek for a pruned value must answer `Some(empty)`, never `None`, since
  `None` means "no index" and would silently route the query to a scan.
  **THE COST, WHICH WAS THE ACTUAL QUESTION**: making every DELETE pay to make a cardinality query
  cheap is the wrong trade if the delete cost is real, so it was measured before the change was
  kept. `bench:usage` `write: append then delete node`, two `.so` builds differing only in the
  pruning, three alternated rounds, ops/s — indexed **195.5/194.0/194.6k against 192.5/197.6/192.0k
  (overlapping)**, and unindexed, where the pruning branch is UNREACHABLE, **204.2/199.8/205.4k
  against 200.4/206.2/205.1k (flat)**. **No measurable cost**, and the unindexed column is a genuine
  null control, so the indexed overlap is a measurement rather than drift.
  **⚠️ NO PERF WIN YET — this is the prerequisite.** The shortcut that would use it is a separate
  item deliberately, because a fast path that is WRONG is worse than one that is slow, and it has
  three preconditions a planner must check: **(1) NULLs** — `count(DISTINCT x)` excludes them, the
  index counts a stored NULL as a value; **(2) the LABEL** — `MATCH (n:Person)` counts over `Person`
  while the index is ANY-LABEL (its own doc says so), so the shortcut needs no label constraint or a
  vacuous one; **(3) no other predicate.**
- **🛑 THE DENSE INTEGER-INDEXED ADJACENCY IS REFUTED — ON DESIGN, NOT ON PERF. Stop pointing at it
  (366, the user's call).** Six items had converged on it (300, 310, 350, 352, 357, 358, surveyed at 365) as the TS engine's one remaining lever, each arriving by a different route and each recording
  it as "parked" rather than closed. **It does not deliver, and the reason is not a number:**
  > _"this would really hurt our ability to get something by an id. That's what the string keyed
  > maps buy us"_
  > **The string-keyed adjacency buys O(1) access BY EXTERNAL ID, and a dense layout does not remove
  > the hash — it RELOCATES it.** Edges store external ids, by items 140/218's deliberate choice, so a
  > dense adjacency would need an ext→dense translation on every hop: exactly the string-keyed lookup
  > the change exists to eliminate, moved one level down. Paying off would require dense ids
  > THROUGHOUT, and then every id-based entry point pays the translation at the boundary — for an
  > API that is id-centric and whose snapshots carry external ids (`encode` emits edge ids, so every
  > reloaded snapshot has them).
  > **SO THE CONVERGENCE OF SIX DECOMPOSITIONS WAS NOT EVIDENCE THE CHANGE WAS RIGHT.** Each item
  > correctly eliminated the component-sized fixes in its own row and correctly named what was left —
  > and then inferred that what was left must be worth doing. **A residue is a description of the
  > cost, not a proposal**; six routes arriving at the same residue says the diagnosis is consistent,
  > not that the implied change is sound. None of the six priced the id-lookup side, because none of
  > them was looking at it: every one was measuring a traversal.
  > **CONSEQUENCE**: the TS engine's per-row floor (26-31 ns/row, item 365) is **accepted**, not
  > pending. Items 300 and 348's "parked, blocked on a dense adjacency the TS graph does not expose"
  > should be read as closed. Future TS work has to beat that floor some other way or be about
  > something else.
- **⚠️ A FRESH HUNT FOR A TS TARGET: two candidates RETRACTED by normalizing, and every remaining
  one is in a parked class — SIX decompositions now converge there (365).** Items 360-364 were all
  native, so this was a deliberate search for a TS target that is NOT the parked dense adjacency.
  There isn't one, and establishing that took two retractions.
  **RETRACTED — the DISTINCT family.** It looked like a clean intra-engine anomaly: on NATIVE
  `count distinct` (0.4ms) is FASTER than `group + aggregate` (1.1ms), as it should be, while on TS
  it is SLOWER (6.2 against 5.2) — an inversion on the same fixture. **Per row it dissolves**:
  `count distinct` **31 ns/row**, `distinct + order by` 29, `group + aggregate` **26**, `top distinct
values` 19. DISTINCT is not anomalous against GROUP; both sit at the TS per-row floor within 1.2x,
  and the 14.98x ratio comes from native doing the same work at **2ns/row** with a vectorized
  typed-column scan. **Item 356's lesson in a third place: the UNIT decides whether a row is an
  outlier.**
  **RETRACTED — `encode graphson`, the same way.** TS encodes GraphSON in 138.1ms against its own
  NDJSON encode's 42.8 (**3.2x**) where native's ratio for the same pair is 1.76x — which reads like
  a TS codec gap. But GraphSON's document is **3.5x the bytes** (410 B/element against 117, item
  356), so 3.2x the time for 3.5x the bytes makes TS's GraphSON encode slightly FASTER per byte than
  its NDJSON encode. (The audit also already flags this row as high-variance, "its own session
  readings span 143-190" — a weak candidate twice over.)
  **WHAT REMAINS is all parked with measurements**: the hop/count family (23-69x) is locality-bound
  (352: 2.9x per-edge degradation from size alone); the decode rows (3.1-3.4 SECONDS) are build-bound
  and **format-independent** (356: a 1.23x spread across five codecs against native's 3.55x), so no
  codec work can touch them and `addEdge` is the only lever — whose label index 357 split and 358
  refuted at the noise floor; the element-render rows (685-1230ms) were parked twice at 348 with
  289's carrier finding.
  **SIX INDEPENDENT DECOMPOSITIONS NOW TERMINATE AT THE SAME DENSE INTEGER-INDEXED ADJACENCY** (310,
  350, 352, 357, 358, 365). **At some point that convergence is itself the finding**: the TS engine's
  remaining per-row cost is its string-keyed, pointer-chasing data layout, and every component-sized
  fix in reach has been taken or refuted.
  **⚠️ THE ONE UNEXPLORED NON-CSR IDEA, NAMED WITH ITS BLOCKER**: `count(DISTINCT k)` over an INDEXED
  `k` is answerable in **O(1) from the index's key count** instead of scanning every row — native's
  hash index is a `HashMap<Vec<u8>, Vec<u32>>` whose `len()` IS the distinct-value count, and TS has
  the same shape. **Neither engine does it.** NOT BUILT because it is unsound as written: index
  buckets retain deleted ids (`index_bucket_len`'s own doc: "it may count a few tombstoned ids, which
  is fine for an estimate"), so a value whose every holder was deleted would still be counted and the
  answer would be **WRONG, not slow**. Exactness needs bucket pruning on delete or a verification
  pass — a storage change with its own price.
- **⚠️ PRICED AND DECLINED — the same wasted-seed pattern grepped elsewhere, found once more, worth
  1.07x not 2.00x. THE COST IS SIZED BY THE SEED'S SHARE OF THE QUERY (364).** Item 363 fixed a
  speculative probe that executed its seed before the gates that reject it (2.00x); this is the grep.
  **Where it is NOT**: the other four probes in `try_run_gremlin_json_inner` gate on plan SHAPE
  (`let Plan::… else { return None }`), which is free — already ablated at 363 at 0-2µs of 115. The
  pattern is not endemic; it is specific to a probe that needs a FRONTIER to decide.
  **Where it is**: `try_stream_varlen_json`, called by BOTH egress paths, does
  `let vl_batch = pull(vl_in, store, false).ok()?;` and only then checks `*slot != endpoint_slot`
  and the `Col::Nodes` shape.
  **PRICED** — a quantified path projecting a NON-endpoint variable
  (`MATCH p = (a:Person)-[:KNOWS]->{1,2}(b) RETURN a.name`), 50k nodes at degree 3, GQL egress,
  probe present against ablated, three alternated rounds of min-of-5: **present 23.62/24.03/23.93 ms
  against ablated 22.68/22.04/22.90 — 1.07x, DISJOINT.** Real, reproducible, and **30x smaller than
  363's for the identical bug.**
  **THE GENERALIZATION IS THE ITEM: the cost of a wasted speculative seed is sized by the seed's
  SHARE of the query.** At 363 the discarded seed was an unindexed scan that WAS the whole query, so
  re-running it doubled the work (exactly 2.00x); here it is the input of a var-length expansion
  that dominates it, so the same bug is 6.7%. **Finding a pattern is not finding its price, and the
  second instance of a 2x bug can be a rounding error.** (Same reason 363's gain on
  `V().out().values(age)` was ~zero: there the discarded seed was a 200k-id `Vec` copy, not an O(N)
  property scan.)
  **DECLINED, with the trigger**: the only cheap pre-check is the static `chain_width(vl_in)`, and
  declining on it would rest on an **unasserted invariant** (that it equals the pulled slot count).
  Getting that wrong yields no wrong answer — it silently loses the STREAMING path, measured at
  ~1.20x on the accepted shape (single round, quoted loosely). 1.07x against a 1.20x downside on a
  mis-set invariant is the wrong trade. **If `chain_width` ever gains a test pinning it to the
  pulled width, this becomes a three-line change.** Recorded beside the `pull` with its numbers.
- **The Gremlin JSON egress scanned TWICE — a speculative probe ran the seed BEFORE the gates that
  reject it. 1.81x, and item 362's own diagnosis was wrong (363).** 362 measured a 1.74x
  cross-language gap on an unindexed point lookup and recorded "it is in the plan or the execution".
  **It was in neither**, and every candidate was eliminated by measurement:
  `spelling_probe` same question both languages **1.02x**; `exec::try_run` on the two optimized
  plans **identical** (15.4/61.7 against 15.6/61.8 µs at 20k/80k); `optimize_indexed` 0.29/0.50µs
  **flat in N**; parse 160ns against ~735ns **flat in N** — so the engine accounts for ~0.8µs of
  CONSTANT difference while a size sweep showed the difference GROWING (3.99 → 13.69 → 57.19µs at
  5k/20k/80k, a steady ~0.7ns per scanned node). Two JS-side discriminators finished it: **`GQL
inlined / GQL param` = 1.00x** (varying the TEXT costs GQL nothing) and **`GRM fixed / GQL param`
  = 1.79x** (a FIXED Gremlin text, a pure cache hit with no parse, is STILL 1.79x) — **so the parse,
  the cache and item 361 are all innocent.**
  **THE MEASUREMENT AND ITS CONTROL**, 80k nodes: `try_run_gql_json` on the GQL plan **56.9µs**;
  `try_run_gremlin_json` on the Gremlin plan **115.1µs (2.00x)**; **CONTROL — the GQL egress fed the
  GREMLIN plan — 57.9µs.** Exactly 2.00x at both sizes is the signature of a scan happening twice,
  and the control proves the PLAN is innocent (its extra `Filter { PropertyExists }`, which
  `values('score')` correctly requires since TinkerPop drops elements lacking the key where GQL
  yields NULL, costs ~1.5%). Ablating the five speculative probes named it in one run: **without
  `try_stream_gremlin_json` → 57.0µs**, the GQL egress's own number; the other four are worth 0-2µs.
  **THE CAUSE — a gate ordered after the work it exists to avoid.** `streaming_chain` does not
  inspect a plan, **it EXECUTES its seed**: on an `IndexSeek` it calls `index_seek_ids`, which for an
  unindexed key scans the label and reads the keyed property of every node. It ran BEFORE both
  `single_hop_no_filter` and the `min_rows` floor, so every Gremlin read reaching this probe and
  then declining paid a full scan for nothing — and the fallback scanned again. **Fix: hoist the
  row-floor check above it.** `cost::estimate` reads only `input` and the store's O(1) counts, and
  **reordering two independent pure early-returns cannot change the result for any input**, only the
  time. GQL unaffected — `try_stream_gremlin_json` has one production caller.
  **MEASURED**: egress 28.5/115.1 → **14.6/57.3µs**; end-to-end through the FFI **1.74x/1.95x of GQL
  → 1.01x/1.00x**; `bench:usage` `gremlin read: point lookup` (-) **30.4k → 55.0k ops/s, 1.81x**;
  the same row indexed **317.2k → 313.9k, FLAT as predicted** — which is the cross-check, since with
  an index the seed is O(1) and there is no wasted scan to remove. **It also inverts the
  comparison**: unindexed Gremlin is now 55.0k against GQL's 47.0k, a Gremlin cache hit being cheaper
  than GQL's parameter binding.
  **No regressions**: every `bench:gremlin` row within noise, answers all "same", GQL serving rows
  unmoved. The near-zero gain on `V().out().values(age)` is consistent — there the discarded seed was
  a 200k-id `Vec` copy where the point lookup's was an O(N) property scan. **The win is sized by how
  expensive the DISCARDED seed was**, not by the query's total.
  **TEETH**: a reorder of two pure guards has no new semantic to mutate, but reachability of the
  streaming path is exactly what it could break silently — and that is already guarded. Forcing the
  gate to always decline fails TWO existing tests
  (`streaming_json_sink_matches_materialized_bytes`, which `expect()`s the `Option`, and
  `streaming_gate_rejects_deep_and_value_filtered_chains`). Run as a mutant to confirm, not assumed.
  **AND THE PROBE GAP THAT LET IT HIDE**: `spelling_probe` had cross-language groups for aggregates
  and projections but **none for a selective property equality** — the commonest serving shape and
  the only one where a seeding or egress difference shows. Added; its verdict for the new group
  ("plans differ but cost matches, 1.02x") was the first clue that the plans were fine and something
  outside them was not.
- **⚠️ THE SERVING BENCH HAD NO GREMLIN ROWS — which is WHY 361's gap survived 43 items — and item
  361 is worth 1.37x END-TO-END, not the 4.7x it measured on the parse (362).** `bench:usage` is the
  serving harness, small operations against a warm graph, exactly where per-call overhead shows.
  **All seventeen of its workloads were GQL.** The Gremlin ABI arm could go without a parse cache
  from item 318 to 361 because nothing looked at the path where that costs anything.
  **`bench:gremlin` cannot substitute, and checking that first mattered**: its rows execute over a
  200k-vertex / 1M-edge graph, so its smallest print as `0.00`-`0.01 ms` and a ~600ns per-call
  saving is far below their resolution. **A benchmark at the wrong SIZE cannot see a per-call effect
  however carefully it is run** — item 356's nodes-only decode rows in a new place. Fixed by ADDING
  rows (356's precedent), so no recorded figure moves; an `Engine` gains an optional `gremlin`
  capability and a workload a `needs` field, and **the pure-TS Gremlin engine prints `-` rather than
  `n/a` because it legitimately has no text entry** — its surface is a fluent builder, which is a
  different surface and not a gap.
  **THE PAIR OF ROWS IS THE POINT, and it follows from 361's own finding**: Gremlin accepts no
  parameters, so a serving workload varying a value must vary its TEXT, making it **all-miss by
  construction**, where a GQL row varying `$n` is a cache hit every time (constant text, bound
  value). So `gremlin read: point lookup` (fresh text per op — the realistic shape) sits beside
  `gremlin read: fixed count` (one text — where a cache helps), and the cache's applicability is
  visible in the standing harness instead of inferred.
  **ITEM 361 MEASURED END-TO-END** (A/B against a `.so` with the cache bypassed at the one FFI call
  site, two rounds, ops/s): `fixed count` **626.1k/618.2k → 842.8k/831.9k, ~1.37x** (and 1.37x
  indexed); `point lookup` **neutral** both columns. **So 361 is worth 1.37x on a serving call, not
  4.7x** — parse is only part of a call. Both halves follow from its parse-level pair (4.71x hit,
  1.02x miss), which is the cross-check that the two measurements are of the same thing.
  **Reporting the function's ratio as the change's value would have overstated it 3.4x.**
  **AND WHAT THE NEW ROWS SHOW THAT NOTHING COULD BEFORE** — the same question in both surface
  languages, indexed: **GQL 365.0k against Gremlin 317.2k, 0.87x**, unremarkable and now visible
  (`CLAUDE.md`'s "equivalent spellings must cost the same" extends naturally to the two LANGUAGES
  and had no instrument). **⚠️ ~~OPEN~~ CLOSED AT 363, AND THIS ENTRY GUESSED WRONG: unindexed it was 53.0k
  against 30.4k — Gremlin 0.57x of GQL.** This row said _"it is in the plan or the execution"_; **it
  was in neither.** Item 363 eliminated both by measurement — the plans cost 1.02x in-process and
  `exec::try_run` on them is identical — and found the Gremlin JSON egress running a speculative
  probe that EXECUTES the seed before the gates that reject it: a full scan discarded, then scanned
  again. Fixed at **1.81x**; the row now reads 55.0k, slightly AHEAD of GQL. **Naming a layer before
  decomposing it is the thing to avoid here** — the parse arithmetic in this entry was right and the
  conclusion drawn past it was not.
- **Gremlin had NO PARSE CACHE — 3.74x to 5.43x on a repeated traversal, and the all-miss path had
  to be fixed before it was shippable (361).** Item 360 found the Gremlin lexer had missed item
  317's fix; this is the same drift one layer up. `lnk_query`'s GQL arm has gone through a parse
  cache since item 318 and **its Gremlin arm called `gremlin::parse` on every call**. Priced before
  building: parse ~735ns + `optimize_indexed` ~390 against `exec::try_run`'s ~325, so **~78% of the
  in-engine work was re-derived every call** — the proportion item 318 cited for GQL (83%) as its
  reason for building the cache. (Checked first because it would have been bigger: the Gremlin arm
  does not call `optimize_indexed` itself, but `exec::run_query` optimizes at its top for BOTH
  languages, so there is no missing-optimization gap.)
  **WHY IT NEEDS NO ADMISSION CHECK, AND WHEN THAT EXPIRES**: the GQL cache verifies every text
  because a GQL plan is not a function of its text alone (a param can be substituted during the
  parse; a now-function folds `$__now` in). `gremlin::parse(&str)` takes nothing but the text, its
  one limit is a compile-time constant, and **the Gremlin ABI arm refuses parameters outright** —
  which is also what makes a clock fold impossible, since `$__now` arrives as a PARAMETER. An
  argument from a signature, so it is recorded with its expiry: **if Gremlin ever accepts parameters
  or grows a parse-time ambient read, this needs the check its sibling has**, and
  `a_gremlin_parse_is_a_function_of_its_text` is what goes red first.
  **⚠️ THE ALL-MISS PATH IS THE ITEM, NOT A FOOTNOTE.** First measurement: hits 4.41x/5.28x/3.49x
  but **a FRESH text every call went 379 → 438 ns, 1.16x WORSE**, near-disjoint. That shape is
  forced here: **Gremlin accepts no parameters, so a client varying a value must emit different TEXT
  every call** (`has('name','name7')` vs `...'name8'`) — a value-varying serving workload is
  all-miss BY CONSTRUCTION, where GQL's equivalent is one cached text with bound params. Shipping a
  cache 1.16x slower on the shape a parameterless language forces you into is a regression dressed
  as a win. Cause: the shared sighting filter answers `hashes.contains(&hash)`, **a linear scan of
  all 64 slots, on every miss**. The Gremlin cache now has its own **direct-indexed** filter
  (`hash % CAP`, one load and one compare); a collision delays one admission, the same tolerance the
  ring already accepts. GQL's filter is untouched — the ring is affordable there for a reason about
  parameters, not about either cache. After: **4.71x / 5.43x / 3.74x** on hits and **1.02x
  (overlapping)** on all-miss, with an unreachable `gql::parse` control flat at 1165-1190ns.
  **TEETH — AND THE CONTROL MUTANT DOING ITS ACTUAL JOB.** The first run reported all five mutants
  CAUGHT **including the control**, which is the only reason it was not read as a clean result:
  every mutant failed the SAME test, one that does not exercise eviction. The suite was broken, by
  me. Cause: the new filter is direct-indexed, so
  `a_single_sighting_does_not_admit_a_gremlin_traversal`'s `seen == 8` got **7 — two of the eight
  texts collide mod 64.** The filter was behaving as designed; the assertion was about the RING's
  internals. Rewritten to pin `note`/`forget` exactly with a SINGLE text (nothing to collide with)
  and to assert the multi-text case on `size`, which no collision can move. Re-run: four caught,
  control survived.
  **A SECOND GAP THE MUTANTS EXPOSED**: `wrong-key` (a lookup ignoring the key, returning any stored
  plan) was initially caught ONLY by the boundedness test, because the correctness test cleared the
  cache per case and used one text — so "any stored plan" was the right one. **A wrong-key cache
  returns a wrong ANSWER; being caught by a bounds test is luck, not coverage.** The correctness
  test now runs all eight shapes INTERLEAVED, three passes, so every call follows a call for a
  different text.
- **The GREMLIN lexer never got item 317's fix — 1.085x to 1.30x on parse, and the twin that
  drifted is a SURFACE LANGUAGE (360).** Item 359's cause was a constant key re-split per row, so
  the method's next step was to grep the pattern elsewhere. **Every other `split('.')` in the Rust
  engine is per-CALL, not per-row** (`create_index`, `drop_vertex_index`, `has_hash_index`,
  `index_lookup`, `index_bucket_len`), so 359 fixed the only per-row instance; the TS engine has no
  `split('.')` at all. The grep found a different drift instead.
  **`gql::lex` pre-sizes both of its growing vectors** with item 317's reasoning in a comment above
  it (317 counted "the char pre-pass reallocating 3 times and the token vector 4 times, 7 of the 19
  allocations the lexer makes" and measured **1297 → 1163 ns, 1.115x**). **`gremlin::lex` and
  `gremlin::math_lex` still opened with a bare `s.chars().collect()` and a bare `Vec::new()`.**
  Items 333, 335 and 349 were all node/edge twins; here the twins are the two SURFACE LANGUAGES,
  which `CLAUDE.md` calls intentionally parallel. **Parallel by design is also parallel for drift.**
  **SETTLED BY COUNT** (`alloc_count_probe` gains three `gremlin::parse` cases — permanent, so the
  Gremlin lexer now has the standing instrument its GQL twin has): `has`+`values` 58B **44 allocs /
  3487 B → 39 / 2535**; two-hop **49 / 3612 → 44 / 2648**; `g.V().count()` **19 / 1400 → 15 / 892**.
  Five allocations and ~27% of the bytes, exactly.
  **THE DIVISOR WAS CHOSEN BY THE COUNT, NOT BY ANALOGY**: GQL reserves `s.len()/4 + 8` tokens, but
  Gremlin is punctuation-dense (`g.V().count()` is 13 bytes and ~9 tokens) so `/4` **under-reserves
  and the vector grows anyway** — two-hop at `/4` is 45 allocs / 3608 B against `/2`'s 44 / 2648.
  Both figures are in the code comment so the divisor is not taken on faith.
  **CLOCK BACKSTOP** (two binaries, alternated, min of 3 rounds of min-of-9): has+values 812 →
  **725 (1.12x)**, two-hop 843 → 777 (1.085x), `g.V().count()` 317 → **243 (1.30x)**, all disjoint,
  with an unreachable `gql::parse` control at 1.03x. **1.12x lands on item 317's 1.115x for the same
  fix on the other lexer** — the cross-check that the twin behaves like its sibling.
  **ON TEETH: a capacity reserve cannot change behaviour, so mutation testing does not apply** — not
  skipped, inapplicable. There is no semantic to break, only a count to verify, which the allocation
  counter did; the guard is the full suite and every byte-identity fuzzer staying green over a file
  on the plan path.
  **⚠️ AND A CORRECTION WORTH KEEPING**: I first reported `index_lookup` as having NO production
  caller, from a `grep` whose output `head` had truncated. It has four (`exec.rs:3553` and three in
  `exec/reverse.rs`). **A `head` on a grep you are about to draw a NEGATIVE conclusion from is the
  same error as a fixture that cannot reach the shape** — the absence was in the pager, not the
  code. Priced anyway and declined: `index_lookup`/`index_bucket_len` build a `Vec<String>` to
  compare a path where `has_hash_index` already does it allocation-free, worth ~2 allocations and
  ~0.5% of a serving call.
  **AND A STALE CARRIED NUMBER RETIRED**: item 291's "`gql::parse` is 1296ns, 43% of the call" no
  longer describes the serving path — re-running `percall_probe` puts
  **`parse_cache::parse_for_run` WARM at 160ns** (items 228/229's caches), against `exec::try_run`
  at 325. Carried numbers go stale in both directions.
- **An unindexed DOTTED-PATH scan re-split its key once per NODE — 2.42x on the native engine, and
  the bench row that found it was comparing two things at once (359).** First native item since 333.
  `bench_all`'s `value/maps` read `scalar age (flat) 368.7` against `map field meta.city 12145.3`,
  inviting "a dotted map-field access costs 33x a scalar read" — but **those two sides differ in TWO
  things**, a NUMERIC range on a flat column against a STRING equality through a nested path.
  **THE MISSING THIRD MEASUREMENT REVERSES THE SMALL AXIS AND ENLARGES THE BIG ONE**: a flat STRING
  equality is **271µs, FASTER than the numeric range's 367** (it lowers to an `IndexSeek` shape where
  the range is a `Filter`), so the un-matched ratio **understated** the nested penalty — **48x
  against the matched flat case, not 33x**. A numeric NESTED path (`p.meta.tier = 1`, 12812µs) costs
  the same as the string one, so it is not the compare; and the scalar query on the MAP graph is
  identical to the flat graph's (367.4 against 367.1), so it is not the map's presence either. The
  plans settle which code runs: B, C and D all lower to `IndexSeek`, differing only in the key, so
  **the 48x is the unindexed `IndexSeek` FALLBACK for a dotted key against the same fallback for a
  flat one** — 1.36 ns/row columnar against 65.6 ns/row nested.
  **THE CAUSE, ONE LINE**: `prop_path` did
  `let path: Vec<String> = dotted_key.split('.').map(String::from).collect();` and was called from
  the fallback's `filter` closure **once per node** — one `Vec` plus two owned `String`s per row,
  **600,000 allocations to scan 200,000 nodes**, each recomputing the same constant. **The split is a
  property of the KEY, not of the node.** Third time in this family: item 331's property write
  allocated its key three times and stored one; 332's staging parser allocated a `String` per JSON
  key to compare against a literal. **A key is constant across a scan; splitting, parsing or owning
  it per row is the recurring bug.**
  **THE FIX**: `prop_path_parts(node, &[&str])` for per-row callers (split once before the
  iterator); `prop_path` delegates and collects `&str` rather than owned `String`s; `resolve_path`
  generic over `S: AsRef<str>` so index-maintenance callers keep their `Vec<String>` paths; plus a
  **one-segment arm** in `resolve_path`, because the general loop must `clone` its input before it
  can rebind in the loop body — an `Arc` bump and drop per row for a value the one-level case never
  owns, and one level is the common shape.
  **MEASURED** (two binaries, alternated, min of 3, 200k nodes): string nested **12001.9 → 4967.5,
  2.42x disjoint**; numeric nested 11732.0 → 4599.5, **2.55x**; `bench_all`'s own row **12145.3 →
  4985.5, 2.44x** with the scalar rows flat. **⚠️ AN HONEST NOTE ON THE CONTROLS**: the flat-string
  row is a clean 1.00x, but the two flat-NUMERIC rows — which the change cannot reach — both moved
  ~1.11x in the new direction. **That is code layout** (precedent recorded: `pull`'s alignment is
  load-bearing, any edit to `exec::pull` moves the filtered-count cluster 1.08-1.24x), so **the noise
  floor here is ~1.11x, not 1.00x**. Reported, not banked. No regressions elsewhere in `bench_all`.
  **TEETH**: four mutants under timeout + a 16G cgroup cap, all CAUGHT (descend the base property as
  a sub-field; one-segment arm → Null; empty-path arm → Null; wrong split separator). **The control
  mutant earns its place twice** — it deletes the new one-segment fast arm so a single field falls
  through to the general loop, and its SURVIVAL is the assertion that the two agree. A control that
  only shows "the suite runs" is worth less than one that proves an equivalence the change depends
  on.
  **AND THE HARNESS IS FIXED SO THE TRAP CANNOT RECUR**: `value/maps` gains the matched
  `string city (flat)` row (item 356's lesson in a different corpus). **14.9x of correctly-matched
  nested-path penalty REMAINS** (4990 against 247) — inherent to a boxed map value against a typed
  column, and a dotted-path INDEX already exists for workloads that need it (`query/seeded` measures
  658x for an indexed equality).
- **⚠️ REFUTED BEFORE BUILT — the inner-container ALLOCATION is not the cost, which kills the
  single-label adjacency representation AND retracts item 357's superadditivity (358).** Item 357
  named a 226ns shared term between the two adjacency maps, two candidate mechanisms, and the
  experiment to separate them. This is that experiment, with the two variants chosen to move the
  candidates in OPPOSITE directions.
  **`shared-outer`** (ONE outer map keyed by vertex id with `{f, t}` inners — one working set, and
  allocation made WORSE at five objects per vertex instead of four): **2821 against the control's
  2757 — WORSE.** The two-large-maps cache story is out; merging the working sets buys nothing.
  **`no-inner-alloc`** (two outer maps kept, inner `Map`+`Set` replaced by shared singletons, so
  **~800,000 allocations become 0** while all 5 keyed `get`s and 3 `Set.add`s remain — and the
  1M-entry shared Sets are priced at ~0 because 357 measured exactly that as not measurable):
  three rounds gave 2498 with a range OVERLAPPING the control, so it got an isolated five-round A/B
  at min-of-five internal reps — control **2618** (2618-2698, 3.1%) against **2490** (2490-2637,
  5.9%). **128ns, 4.9%, with one of five rounds showing NO effect and the null control the change
  cannot reach ranging 5.9% by itself.** At the noise floor.
  **WHAT THIS CLOSES — the tagged single-label inner representation is REFUTED, not just declined.**
  Item 357 called it "the obvious candidate" (store the `Set` directly, promote to a `Map` on a
  second label; halves the allocations and removes a hash level from every adjacency READ) and
  declined it on blast radius — `Vertex.adjFrom`, both engines' `graph-queries`, four algorithms,
  three `shortcuts` helpers. **Its entire motivation was those allocations, and removing ALL of them
  measures at the noise floor.** Refuted before it was built, which is the cheapest form this could
  have taken.
  **AND IT RETRACTS 357's OWN HEADLINE.** 226ns is 8% of a row whose harness repeatability is 3-6%,
  and neither mechanism reproduces. **A superadditivity is a difference of differences, so it
  carries the noise of every term in it** — 357 treated it as a finding because each individual
  ablation was disjoint from the control, but **disjointness of the PARTS says nothing about the
  residue after subtracting them.** A sharper form of item 300's rule (_disjoint ranges are not
  proof when the whole side moves_).
  **WHAT THE 586-684ns ACTUALLY IS: the string-keyed hash work itself** — ~4 keyed `get`s, 2 `set`s
  and 2 `Set.add`s an edge at ~75-100ns each on a 200,000-entry Map, which is item 312's own
  ~115ns-per-operation estimate arriving from a different direction. The only lever is the KEY TYPE:
  item 300's dense integer-indexed adjacency, parked at 348. **This is the FOURTH item to arrive
  there (310, 350, 352, 358)** — at some point that is itself the finding.
- **`addEdge`'s 810ns label index, SPLIT at last — the 1M-element Set is FREE, the two adjacency maps
  are all of it, and they are SUPERADDITIVE (357).** Item 356 left `addEdge` as the only lever on
  pure-TS ingest (the TS decode is format-independent, so the cost is the graph BUILD). Item 312
  priced `indexEdgeLabel` at 810ns of a ~2.9µs edge write and called it "seven hash operations, five
  string-keyed", but never split it across the THREE indexes it maintains — so the figure could not
  be acted on. Ablated one at a time, three alternated rounds, min of each, ns/edge:
  **CONTROL 2760** (2760-2867) · minus `edgesByLabel` **2592, OVERLAPS the control — not measurable,
  ≤4%** · minus `edgesFromByLabel` 2461 (−240, 8.9%, disjoint) · minus `edgesToByLabel` 2483 (−218,
  8.1%, disjoint) · minus BOTH adjacency maps **2076 (−684, 24.8%)** · minus all three 1912 (−848,
  **30.7%**) · minus all three AND the loop 1887 (indistinguishable from the previous row).
  **⚠️ `edgesByLabel` IS NOT MEASURABLE — the index holding a 1,000,000-element `Set`, the biggest
  container in the graph, cannot be distinguished from the control.** Its range overlaps, its
  apparent 109ns is inside the control's own 3.9% repeatability. **A `Set.add` into a million-entry
  Set is essentially free; the cost is in the two indexes with the SMALL inner containers, because
  there are 400,000 of those.** Retracts the intuition that the big container is the expensive one.
  **The per-label loop and the function call are FREE** (1887 against 1912, overlapping) — checked
  because with all three blocks gone `indexEdgeLabel` is an empty function, so the 848 could have
  been an artifact of ablating down to an empty callee. It is real work.
  **⚠️ THE SUPERADDITIVITY IS RETRACTED AT 358.** This item reported 684ns for both adjacency maps
  against 240+218=458 apart — a 226ns shared term — and named two candidate mechanisms. Item 358
  tested both: merging the two maps into one outer map is **WORSE** than the control, and removing
  **all ~800,000 inner allocations** is worth 128ns (4.9%) at the noise floor. Neither reproduces,
  and 226ns is 8% of a row whose harness repeatability is 3-6%. **A superadditivity is a difference
  of differences, so it carries the noise of every term in it**: each individual ablation here was
  disjoint from the control, and disjointness of the PARTS says nothing about the residue after
  subtracting them.
  **AND NOW REFUTED OUTRIGHT (358)** — a tagged single-label inner representation (store the `Set`
  directly, promote to a `Map` on a second label) was "the obvious candidate", declined here on blast
  radius (`Vertex.adjFrom`, both engines' `graph-queries`, four algorithms,
  `shortcuts`' `side`/`bucketSize`/`edgesOfTypes`). Its whole motivation was halving the inner
  allocations, and **removing ALL of them measures at the noise floor**. Priced at ~free, refuted
  before it was built. **Price the mechanism before paying for the representation.**
  **NEW PERMANENT INSTRUMENT — `bun run addedge:cost`** (`packages/native/addedge-cost-probe.ts`).
  The bench's decode rows cannot answer this: they include `JSON.parse` (19%) and they reach
  `@lenke/core` through `@lenke/serialization`, **which resolves to core's built DIST**, so an A/B of
  core's SOURCE is not in effect at all and every edit costs a full build first. It reads source,
  drives the two public writes, takes NODE ingest as the null control, and reproduces both known
  baselines (2743-3052 ns/edge against item 312's ~2.9µs; 898-1015 ns/node against ~1.08µs).
- **⚠️ FIXTURE HOLE + TWO RETRACTIONS — four codec decode rows had ZERO EDGES, and normalizing by
  bytes retracts both targets the un-normalized table suggested (356).** `decode pg-json` /
  `graphson` / `pg-text` / `csv` all took `setup: e.load(nodesDoc)` — **200,000 nodes, NO EDGES** —
  while `decode ndjson (5 edges/node)` three rows above decodes **1,200,000 elements**, and nothing
  said so. **Each codec's entire edge path was unmeasured on all three engines** (endpoint
  resolution, edge-label indexing, the edge property bag): not CLAUDE.md's "one edge per node is
  sparse" but ZERO edges per node, on rows named for a whole-graph decode. Fixed by ADDING an
  edge-bearing twin per format, not repointing the old rows, so recorded figures stay comparable
  (item 341's precedent).
  **RETRACTED — `decode graphson` is not slow.** 339.8ms against every other nodes-only row's ~80 is
  **3.5x document verbosity** (410 B/element against ndjson's 117) **× 1.20x byte rate** (0.230
  against 0.277 MB/ms). 3.5 × 1.2 = 4.2. Nothing to fix.
  **RETRACTED — native's ndjson decode is not slower than its pg-text decode.** Per ELEMENT ndjson
  (387ns) loses to pg-text (282) and csv (311), which looked like a target on the format that
  matters most (ndjson is the snapshot channel and items 328-333 optimized it specifically). **Per
  BYTE ndjson is the FASTEST of the five** at 0.240 MB/ms, 2.8x pg-text's 0.086; its per-element
  disadvantage is entirely 3.8x more bytes per element.
  **THE UNIT DECIDES THE ANSWER: per-byte and per-element rank these five codecs in OPPOSITE
  orders.** Compact formats are slowest per byte and fastest per element — the signature of a
  per-ELEMENT fixed cost (graph build + dispatch) dominating wherever there are few bytes to
  amortize it over. A decode claim must say which unit it is in.
  **AND THE USEFUL RESULT — the TS decode is FORMAT-INDEPENDENT:** 2229-2740 ns/element across five
  formats (**1.23x spread**) where native spans 282-1000 (**3.55x**). Pure-TS ingest is bound by the
  graph BUILD, not any codec, and the number agrees with the known cause — item 312 measured
  `addEdge` at ~2.9µs/edge and at 5:1 five of every six elements is an edge. **So no codec work can
  make pure-TS ingest faster; the only target is `addEdge`**, already the recorded one. A measured
  "where not to look".
  **The widest decode ratios in the bench are now pg-text 9.73x and csv 8.07x** (was 3.82x / 3.05x),
  understated before because those rows carried no edges — which is where native's advantage is
  largest.
  **Probe-methodology note**: the probe that produced the byte counts was itself wrong first time —
  it encoded the EDGE-BEARING graph for all five formats and so compared four of them against a
  document the bench never decodes. **Check which fixture a row actually loads before normalizing
  it.**
- **⚠️ REFUTED BEFORE BUILT — `side()`'s six callers that already hold a Vertex must NOT read the
  adjacency box, because a memo taxes a visited-once element (355).** `side(graph, id, …)` hashes a
  vertex id into a 200,000-entry Map, and **six of its ten call sites already hold the `Vertex`** and
  pass its id, while `Vertex.adjFrom` (item 321's box) is that same bucket already memoized on the
  element. Item 323 refuted reaching the box FROM AN ID (resolve + box, 1.26x worse) but its own
  micro put the vertex-in-hand read at 1.97x, so this looked like free money.
  **MEASURED — 200k vertices / 1M edges, each variant in its OWN PROCESS on a FRESH graph, min of 3
  alternated rounds, ns/iteration, null control flat at 3-11:** vertex in hand today **203.4 first /
  171.3 warm**; vertex in hand via the box **247.0 first / 127.1 warm**. The box is **1.21x WORSE on
  FIRST TOUCH** — it pays the same hash AND the memo write — and 1.35x better warm. **Five of the
  six sites visit each vertex exactly ONCE per query** (the hoisted per-`b` degree reads), so they
  take the cold cost and never reach the warm win: on a freshly loaded graph that is a REGRESSION.
  Only the `c` position under `needsC` is revisited (~in-degree times), where the blend is ~1.21x
  better. **One site, not six.**
  **The generalisable form: a memo helps a REVISITED element and taxes a VISITED-ONCE one, so "the
  caller already holds the object" is not by itself a reason to read a memo on it.** Fifth time in
  one session that checking a scope claim reversed the recommendation resting on it (342→343,
  343→348, 350→351, 353→354, 355).
  **AND THE PROBE'S OWN DEFECT IS THE METHOD NOTE**: the first version ran all five variants in ONE
  process, and every "cold" reading was warm for whichever variant ran later — because `adjFrom`
  memoizes and the per-EDGE cases warm the box for all 200,000 vertices before the per-vertex cases
  are timed. It read as "the box is faster even cold", the opposite of the truth. **A memo makes
  ORDER OF MEASUREMENT part of the two sides of the ratio**; the tell was the cold and warm box
  readings sitting implausibly close.
  **PRICED NOT BUILT — an `Edge` holding a REFERENCE to its endpoint vertices**, the one variant that
  REMOVES the lookup rather than relocating it: **1.32x warm / 1.11x cold** (187.9 against 248.9
  ns/edge) on the hottest read in `count 3-hop` (ts 330.3ms against ffi 4.9, **67.6x**), ~**1.18x**
  on the row. Declined because it needs a NEW INVARIANT — an endpoint ref must never outlive the
  endpoint INSTANCE, where items 140/218 deliberately store the id and both `evict()` and rollback
  replay swap instances for the same id — and 1.18x on one row does not buy that. The same run
  independently **re-refutes item 323** at a new size (`e.to` → box: 301.5 warm against today's
  248.9). The residual gap is still the CSR's (300, 348, 350, 352).
  **UNTRIED, with a trigger — the only shape with no cold penalty and no new invariant**: PEEK the
  box and hash on a miss, never writing it. Warm callers get 127.1, cold callers pay today plus a
  field read. **It cannot be measured on this row** (nothing warms the box on a fresh graph) — it
  needs a MIXED workload (`bench:usage`), where item 321's boxes are already populated.
- **⚠️ REFUTED BEFORE BUILT — `edge.to` is called ZERO times on the 26x row (351).** Item 350 named
  the next candidates as the three-component diagnosis's remaining two, and the obvious one is
  `Edge`'s endpoint resolution: `get to() { return this.#graph!.getVertexById(this.#to)!; }`, a
  string-keyed `Map.get` per access that `shortcuts.ts` itself prices at _"~190ns — item 194"_, and
  exactly item 321's shape (which took 1.207x by caching a reference instead of a string key).
  Everything pointed one way.
  **The arithmetic did not fit.** The row runs 38-40 ms over 1,000,000 edges — **~38 ns an edge in
  total** — and a single 190 ns resolve cannot be inside that. Counted rather than guessed, with a
  temporary counter on both getters and the row's own query over 100,000 edges:
  **`edge.to=0  edge.from=0`.** Neither getter is called once: the hop path already works from
  `toId`/`fromId` and never materializes the far vertex, which `shortcuts.ts:1474` says in a comment
  added for exactly this reason.
  **So the COMPONENT LIST is stale, like the figure was.** Item 350 corrected 84x → 26x and left the
  component diagnosis inherited; it should not have. The endpoint-resolution component is **already
  gone**, and the three-component diagnosis has been carrying a fourth-hand description of a cost
  that no longer exists on this row. What the remaining 38 ns/edge IS is **not known**, and this item
  invents no candidate — a fresh decomposition is the next step, the same move item 329 made for
  native's decode: **a stage list that does not add up is a stage list to redo, and this one had a
  removed stage still in it.**
  **The cheap thing that saved a wasted round**: one temporary counter on two getters, run once. It
  refutes a target that had the code's own 190 ns comment, a measured precedent for exactly the fix,
  a named place in a three-component diagnosis, and a `CLOSED.md` entry pointing at it — four
  reasons to build it, and it is never called. **RULE (item 321 sharpened): check the hot row CALLS
  the function — and when a named cost and the row's total time disagree by 5x, that disagreement IS
  the measurement.** 190 ns an edge inside 38 ns an edge was visible before any code was read.
- **⚠️ STALE FIGURE CORRECTED — the "84x row" is the 26x row, and item 300's CSR re-prices against
  that (350).** `CLOSED.md` names `traverse 1-hop + filter` "the 84x row" in several places and
  records item 300's CSR (a dense adjacency for the TS engine) as "priced at **7.30x** and
  declined". Both are the basis for the largest open TS data-layout change, so they got checked.
  **MEASURED, three runs** (`MATCH (a:Person)-[:KNOWS]->(x) WHERE x.age > 45 RETURN count(*)`, 200k
  nodes at 5 edges/node): ts **40.2 / 38.4 / 40.9 ms** against ffi 1.5 → **26.86x / 25.51x /
  26.94x**. **The gap is ~26x, not 84x** — stable, same fixture, same query, and a ratio inside one
  run is the comparison that survives (item 338).
  **WHAT ACCOUNTS FOR IT, AND WHAT DOES NOT**: item 321's adjacency box (1.207x) and item 324's
  `edgesOfTypes` split (1.253x) are 1.51x together; the gap moved 3.23x. **So 2.14x is unattributed
  and this item does not claim it** — it could be earlier items, or the ffi column moving rather
  than the ts one (1.5 ms is near enough the floor that a native-side change shrinks the ratio
  without TS improving at all). Attributing it needs old absolute numbers, which item 338 just
  established are not comparable across sessions. **What is defensible is the current number, and
  that the old one should stop being quoted.**
  **CONSEQUENCE**: 7.30x was priced against 84x. Against 26x the case is materially weaker, and the
  change is the class item 348 parked twice — a REPRESENTATION change (a dense, integer-indexed
  adjacency the TS graph does not expose, its vertices being string-keyed). Item 321 already called
  itself _"a cheaper intermediate than item 300's CSR"_, and the three-component diagnosis
  (generator frame, `Edge` property reads, two hash lookups) keeps yielding to component-sized
  fixes — the opposite of what "it needs a CSR" predicted, and item 324 already recorded that
  reversal once. **CSR stays declined, now for a measured reason rather than an inherited one**; the
  two remaining components are the next candidates, at component size.
  **AND THE SAME RUN SAYS**: `count 1-hop [shortcut]` is **ts 0.0 ms against ffi 0.5** — pure-TS
  answers from an index while native pays the FFI carrier (289). Same graph, same hop, opposite
  directions: **the TS engine is behind on ENUMERATING and ahead on ANSWERING FROM AN INDEX.**
  No code change. **The point of this file is that a list which lags is the failure it exists to
  prevent — and this time the lag was inside it.**
- **A single-property SET normalized every property it was not changing — 1.39x to 2.66x by width,
  and the EDGE twin's normalization had no tests at all (349).** TS `SET` is recorded as O(property
  width) with three O(K) passes. One is provably unnecessary: `setProperty` commits
  `{ ...previous, [key]: value }` through `normalizeProperties`, a walk of EVERY key calling
  `normalizePropertyValue` to lift a tagged temporal — and it cannot find anything on K-1 of them,
  because **a bag in the box was normalized when stored** and item 335 established (and this item's
  mutants re-check) that a stored bag is frozen and REPLACED, never mutated.
  Split the funnel: `#commitNormalized` takes an already-normalized bag; `#commitProperties` is now
  `#commitNormalized(normalizeProperties(bag))` for bags from outside the graph. Four of five paths
  move to the cheap form — the public setter still normalizes the caller's whole bag, `setProperty`
  lifts its ONE value, `setProperties` does `normalizeProperties(props)` (O(|props|) not O(K)), and
  **a removal introduces nothing so it normalizes nothing**. The invariant is inductive: every path
  normalizes what it adds, so every stored bag is fully normalized.
  **MEASURED** — `bun run delete:width` gained a `set_ns/write` column (a one-key `setProperty` at
  the given width, the shape that matters since an immutable bag means a one-key write rebuilds the
  whole bag). 3 alternated rounds, min: width 4 **145 -> 127** (overlapping), 16 **327 -> 235
  (1.39x)**, 64 **820 -> 308 (2.66x)**, 256 **16,321 -> 7,914 (2.06x)**; 16/64/256 fully disjoint,
  **delete column flat as the control**. 2.66x from one of three passes is more than its share
  because the pass was not one walk but K calls to `normalizePropertyValue`; peaking at 64 rather
  than 256 is consistent, since at 256 the spread and freeze dominate more (the dictionary-mode
  cliff).
  **⚠️ TEETH FOUND A GAP: both EDGE mutants SURVIVED.** Five `Vertex` mutants, one per link in the
  induction — all four correctness ones caught, and the behaviour-preserving fifth (normalize twice)
  correctly survived as the control. Then the same two on `Edge` broke NO test: **`Edge` carries its
  own copy of the whole property funnel and every normalization test drove `Vertex` only.** Third
  time this session the node/edge asymmetry bit (item 340: the edge renderer never got the node
  renderer's batch twin; now: the edge funnel never got the node funnel's tests). **RULE: when a
  change touches `Vertex` and `Edge` together, mutate BOTH — the twins drift because only one of
  them is ever in the fixture.** Added three EDGE normalization tests; both mutants caught now.
  **Still open**: two O(K) passes remain and both are the REPRESENTATION, not the code — the spread
  (the bag is immutable and shared) and `Object.freeze` (K properties each marked). A one-key write
  cannot be O(1) while a property bag is one frozen object; that needs the columnar layout native
  has, which is the TS engine's largest open representation question.
- **PARKED, with a trigger — rung 3's write cost is FREE and its blast radius is FIVE paths, not two
  (348).** Item 343 preferred rung 3 on the grounds that its blast radius was _"`set_prop`/
  `remove_prop`, the two functions items 331 and 335 already worked."_ Both halves checked before
  building; one is better than claimed and one is worse.
  **The write cost is free.** `apply_set_prop` ends in `col.set(node, value)` and `Column::set`
  writes the slot's `present[i]`/`nulls[i]` directly — it already reads and writes exactly the bytes
  that say whether the slot was occupied, so **returning "was previously absent" costs one byte
  compare on a cache line it writes anyway.** Maintenance is one branch plus a push on first set.
  **The blast radius is five paths, two of them the BULK fast paths.** Enumerated:
  `apply_set_prop` (the funnel), `apply_remove_prop`, **`add_node_bulk` (bypasses the funnel by
  design — "the single-pass fast path, no per-property hashmap lookup")**, **`materialize`
  (`store.rs:393`, the `Builder` path — how every test fixture AND the NDJSON decode build a
  store)**, `delete_node`, plus a **re-permute** because adding a new key changes sorted key order
  and shifts every node's mask. The two non-funnel paths are exactly the ones items 330-333 spent
  four items making fast; maintaining a mask there either slows them or needs a wholesale rebuild at
  `end_bulk` — the O(KxN) scan the rung exists to avoid, paid once per load. Defensible, but not
  "two functions". Memory: **8 B/node** for a `Vec<u64>` mask at K≤64 (1.6 MB at 200k) vs 24+8k for
  a per-node `Vec<Arc<str>>` (11.2 MB, ~28% more per-node footprint) — the mask is the right shape
  and brings the K>64 fallback and the re-permute with it.
  **VERDICT: both rungs park.** rung 2 = 1.67x render-only for ~90 `store.rs` sites plus
  `exec.rs`/`exec/distinct.rs` hot paths it does not help; rung 3 = ~2.7x render-only for 5 write
  paths + re-permute + fallback + 8 B/node. Both buy ONE shape — rendering an element from a store
  with many distinct keys. That shape is real (a heterogeneous people-graph is 50-200 keys with a
  handful per element) but **no corpus row measures it and no user has reported it**; every fixture
  here has four keys, which is why items 340-343 had to build the sweep to see it at all.
  **TRIGGER, checkable rather than a feeling: build one of these when a measured workload renders
  elements from a store with more than ~60 distinct property keys.** The sweep in
  `element_render_cost` is there to price it the day it matters.
  **THREE SCOPE CLAIMS, THREE CORRECTIONS — the pattern**: 342 preferred rung 2 for unmeasured
  BREADTH (false, 343); 343 preferred rung 3 for an unenumerated BLAST RADIUS (understated, here);
  and 343's own line already named it — _"the arithmetic has not been wrong once; the framing has
  been wrong three times."_ This is the fourth. Every one was a claim about SCOPE, asserted in a
  sentence and refuted by fifteen minutes of checking, while every MEASUREMENT in the thread held.
  **A scope claim is a measurement. Before preferring A to B on anything but a measured number,
  grep the thing you are calling narrow.**
- **`CAST(<element> AS STRING)` is NOT an implementation choice — the free ISO artifacts close the
  easy escape without settling which engine is right (347).** Item 346's divergence: `CAST([n, '']
AS STRING)` gives `"6,"` in TS (the element's **id**) and the element's whole **map** in native.
  The tempting resolution is "casting a node to a string is outside the standard, so pick one and
  document it as implementation-defined." **That escape is closed.**
  **Syntax is legal**: `<cast operand> ::= <value expression> | <null literal>`, so an element
  variable is accepted; whether the TYPE PAIR is castable is prose.
  **It is not delegated.** `-implementation-defined.xml` lists exactly ONE cast entry — _"The manner
  in which **lax casts** (and supporting type tests) are generated and included in the syntax
  transforms for the dynamic generation of **strict casts**"_ — which delegates the generation
  MECHANISM, not which pairs are castable. `-implementation-dependent.xml` does not mention casts at
  all. **Those two files are the complete enumeration of permitted freedom, and an element-to-string
  cast is in neither** — so two conforming implementations may not disagree and one of ours is
  wrong. `-conditions.xml`: the only cast-specific status is `22018 invalid character value for
cast` (a character value that will not PARSE into the target, not a bad type pair), with
  `22G03`/`22G12 invalid value type` available for a wrongly-typed value — consistent with a bad
  pair being a STATIC rule rather than a data exception.
  **What they do not settle**: which answer is right. Neither engine's behaviour is attested
  anywhere free — TS exposes the external id, native the whole map, and **both are internal
  representations promoted to a contract by accident.**
  **THE DECISION, stated once and deliberately not taken unilaterally**: (1) refuse with `22G03` —
  conservative, relaxable later, and breaks nobody who relied on a behaviour the engines never
  agreed on; (2) the id (TS today, cheaper); (3) the element map (native today, consistent with how
  elements render everywhere else). All three change user-visible behaviour in a shipped engine, and
  the repo already has firm user-set policy on refuse-vs-coerce for cross-type operations.
  **REUSABLE PATTERN, now written into `references.md` beside the artifact table**: when the
  question is _"are we allowed to choose here?"_, the answer is in
  `-implementation-defined.xml`/`-implementation-dependent.xml` and **is usually no**.
  Reliability note: a web search for the type rules returned nothing usable AND asserted it _"found
  no source that uses 'lax' or 'strict' for GQL casts, so I can't confirm those modes exist"_ — they
  do, the quoted sentence is ISO's own. The primary source beat the summary again.
- **Closing the HOLE, not the bug — the differential fuzzer can now generate a container carrying an
  element, and the first thing it found was a SECOND divergence (346).** Item 345 fixed the record
  arm; 344 had named why it survived — the one harness that compares the engines row-for-row could
  not generate the shape. A fix that closes a bug and leaves the hole open is half the job.
  **THE HOLE, EXACTLY**: the generator's expression grammar is entirely scalar (every `genLeaf` is a
  literal, temporal, stored-record path or property read). Records AND lists **were** generated —
  the hole was never "no containers", it was that **no container could ever hold an element**.
  20,000 queries a run and `{v: <vertex>}` was unreachable.
  **⚠️ THE FIRST ATTEMPT FOUND A DIFFERENT BUG.** An element-valued LEAF (so elements reach every
  container) went red within two runs on something else:
  `MATCH (n:T) RETURN CAST([n, ''] AS STRING)` → **ts `"6,"` (element casts to its ID), native
  `"{\"id\":\"6\",\"labels\":[\"T\"],…},"` (its whole MAP)**. A real value divergence, and the
  fuzzer's own message says such a thing is "a bug in one of them" which "no registry entry may
  excuse" — it cannot be parked. **NEW OPEN DIVERGENCE, repro `FUZZ_SEED=4042405702`.** Which engine
  is right is a `CAST` conformance question (ISO does not obviously define a node-to-string cast;
  "both should refuse" is plausible and changes user-visible behaviour), so deciding it inside a
  fuzzer-coverage change would be two decisions in one commit.
  So the element case moved from the expression grammar to **QUERY level**: the existing
  hop-projection family draws a container-with-element a quarter of the time, from eight shapes
  (`{v: a}`, `{v: a, w: b}`, `{v: e}`, `{v: {inner: a}}`, `{v: a, n: a.n}`, `[a]`, `[a, b]`,
  `{v: a}.v`). Elements reach containers without reaching `CAST`, arithmetic or the scalar
  functions. Per the file's own convention this is a CONTENT change to an existing band, so no
  seed's family assignment moves.
  **TEETH, RUN TWICE**: reverting item 345's one-line fix makes the fuzzer red immediately, naming
  the family it was blind to (`{v: e}`, `{v: a}`, `{v: a, n: a.n}`, `{v: {inner: a}}`). Checked
  before the complexity refactor below and again after (10 divergent seeds the second time), because
  **a refactor that quietly stops generating the shape leaves the hole open while looking closed.**
  Green over 13 consecutive runs with the fix in place.
  **A GATE THAT EARNED ITS KEEP**: the inline branch tipped `genQuery` from complexity 35 to 36 and
  `bun run lint` refused it. Two attempts to satisfy it by extracting only the shape list still read
  36 — **a ternary is a decision too** — so the 25% split moved into the helper as well. The gate
  was right: `genQuery` is a 24-band `if` ladder and a sub-choice belongs in a named function.
  **Still open**: the `CAST(<element> AS STRING)` divergence, now the only thing known to be
  reachable by an element-valued leaf. When it is settled the leaf can move into `genLeaf` and
  coverage widens from one family to the whole grammar — the better end state, and this item is the
  half that needs no semantics call.
- **FIXED (345) — the record arm read `value_at` where the list arm reads `render_cell`, one line
  apart in the same `match`.** Item 344 scoped the divergence and stopped at "the next place to look
  is the plan". It was the plan, in the sense that **the plan named the arm**:
  `{n: p}` is `Expr::Record { fields: [("n", Slot(0))] }` — **not `Expr::MapLit`**, which is why
  344's careful reading of `MapLit` and its fused JSON writer found nothing wrong with either. Both
  were innocent. The optimizer changes nothing, so the two arms sit side by side:
  `Expr::List` does `render_cell(c, i, store)` (element map) and `Expr::Record` did `c.value_at(i)`
  (dense id). The `List` arm has always carried the comment saying why — _"A VERTEX/EDGE element
  renders as its element map … consistent with a top-level one"_ — and the `Record` arm never got
  it. **One line, eleven lines from the version that was right.** `resolve_elem` was already
  recursive over `Record`, so nothing else needed touching.
  **VERIFIED ACROSS ENGINES**: all seven shapes byte-identical FFI vs pure-TS, including the three
  that diverged plus `RETURN {a: p.k, n: p}` (a scalar and an element in one record) which had never
  been tested.
  **TWO DRAFTS OF THE TEST WERE WRONG, both the same class of error as the bug**: (1) it
  destructured the value as `Value::Map` and its walk had no `Record` arm — **blind to exactly the
  nesting it existed to check**; (2) rewritten, it forbade any `Num` anywhere, which also forbids a
  legitimate numeric PROPERTY — it failed on the fixture's own `k: 1` INSIDE the element map it was
  looking for. Shipped form follows the single-field nesting to the leaf and requires an element map
  (a `Map` with an `id` key), descending into nothing else.
  **Teeth RUN, not reasoned**: reverting the one-line fix with the test in place turns it red
  (`0 passed; 1 failed`). **A one-line fix does not imply a one-line test.**
  **LESSON**: 344's reading was careful and still looked at the wrong `match` arm for an hour,
  because the surface syntax `{…}` reads as "map literal" while the AST calls it `Record`. **The
  plan dump settled in one line what reading could not, and it was available the whole time — for a
  "which code runs" question, print the plan before reading the code** (item 321 in a different
  costume).
  **Still open**: the differential fuzzer has no generator case for a record carrying an element,
  which is why this survived. The fix closes the bug, not the hole.
- **~~OPEN BUG~~ FIXED AT 345 — an element inside a MAP LITERAL renders as its internal dense id; a silent
  cross-engine divergence found by a 6.7x speedup in the wrong direction (344).** Looking for a
  shippable win among `evaluator.rs`'s per-row `render_cell` loops, step one was item 321's (check a
  measured row reaches the code). One number made no sense: at 200k nodes via ffi, `RETURN p` is
  **232.9 ms** and `RETURN {n: p} AS m` is **34.6 ms** — strictly more work, 6.7x FASTER, and
  indistinguishable from a map literal holding a scalar (32.8). **A speedup in the wrong direction
  is work not being done.**
  `MATCH (p:P) RETURN {n: p} AS m` → native `[{"m":{"n":0}}]`, TS
  `[{"m":{"n":{"id":"a","labels":["P"],"properties":{"k":1}}}}]`. **`0` is the internal DENSE id**,
  where the engine's own `id` field is the EXTERNAL one — a wrong value AND an internal identifier
  leaking into user-visible output, **silently**: a plausible number, no refusal.
  **SCOPE, measured**: `RETURN p`, `RETURN [p]`, `RETURN collect(p)` all CORRECT and agreeing. It is
  the **map literal specifically**, nodes AND edges, at ANY depth (`{n: {inner: p}}` → `{"inner":0}`).
  Lists/collect resolving correctly rules out the generic resolver — `resolve_elem` IS recursive
  over List/Map/Record and works.
  **THREE PATHS RULED OUT BY READING**: `Expr::Slot` evaluates to the slot's own `Col` (a node slot
  stays `Col::Nodes`); `render_cell` turns `Col::Nodes` into the element map; and
  `try_fused_maplit_json`'s non-scalar arm calls `render_cell` too. None explains a bare `0`, so the
  loss is BEFORE egress — **next place to look is the PLAN**, i.e. whether the optimizer rewrites a
  MapLit entry that is a bare element variable into a numeric read. Recorded rather than guessed:
  a blind fix in an unpinned path is how one silent wrong answer becomes two.
  **WHY IT SURVIVED**: the differential fuzzer has **no coverage of a map literal carrying an
  element** — the same nested-shape gap already recorded for quantified groups. The bug and the gap
  are one hole, so the fix should add the generator case.
  **SHIPPED**: `an_element_in_a_map_literal_renders_as_its_element_map`, `#[ignore]`d with the
  reason and asserting the CORRECT behaviour so the fix has its assertion ready (fails for the right
  reason today under `--ignored`; default suite green at 1098/11 ignored). Its check is
  shape-agnostic — no value anywhere under a projected map literal may be a bare number where an
  element was projected — so a partial fix cannot pass it.
  **FOR THE OPEN-DIVERGENCE LIST**: the three native divergences on record are all LOUD REFUSALS.
  This is a fourth and it is SILENT, which is strictly worse.
- **⚠️ CORRECTION TO 342 — packing presence helps NOTHING but the render path, so the recommendation
  inverts (343).** Item 342 preferred rung 2 (pack `Column`'s presence) over the larger rung 3
  (per-node key list) on BREADTH, not magnitude: _"it reaches every other `present_at` caller —
  filters, `count`, `IS NULL`, the seek paths — which this sweep does not measure and therefore
  understates."_ That clause was the entire reason for preferring the smaller win, and it was an
  assertion. Measured now, same method (bitset built outside the timed closure, cross-checked
  against the byte-wise answer for every row first), 200,000 rows, ONE column:
  presence test only **0.5 -> 0.4 ns/row** (noise); **presence test + READ the value 3.3 -> 3.3
  ns/row — identical.** The second is the shape that matters (a filter, a `count`, a scalar
  projection all test then read) and **the value read dominates completely**. Packing's 8x memory
  saving only pays when a row touches K columns, which is the element renderer and nothing else.
  **SO THE RECOMMENDATION INVERTS.** Rung 2: **1.67x** on element render, blast radius `store.rs`
  (~90 `present[i]`/`push` sites) PLUS `exec.rs` and `exec/distinct.rs`, which borrow
  `present: &[bool]` into hot gather/filter paths — the very paths this item shows it does not help.
  Rung 3: **~2.7x**, blast radius `set_prop`/`remove_prop`, the two functions items 331 and 335
  already worked. **Rung 3 is better on every axis** and 342's preference is RETRACTED. Next step is
  pricing rung 3's write-path cost, which is the same question 331/335 answered: a set on an
  EXISTING key must not pay for the index — a `contains`-then-insert on a small per-node structure,
  the shape `bump_epoch` already uses in that file.
  **GENERALISABLE: "it also helps X" is a claim, not a bonus.** A recommendation that prefers a
  smaller MEASURED win on the strength of unmeasured breadth is resting on the unmeasured half. The
  tell was in 342's own sentence — _"which this sweep does not measure"_ — written as a caveat and
  then used as the reason. One sweep, fifteen minutes, conclusion reversed.
  Also the second time in three items that the thing to check was the SAMENESS or the SCOPE of a
  comparison rather than its arithmetic (339's two sides, 341's carrier, this). **The arithmetic has
  not been wrong once; the framing has been wrong three times.**
- **PRICED NOT BUILT — the presence representation: hoisting was 4.9x of the scaling term, packing
  the bits is 2.1x more, and a per-node key list is the only thing left (342).**
  **RE-CONFIRMED at 381, and the attribution is worth having in writing** because `bench_all`'s
  `query/gql` `distinct node` row (125,517us / 198,672 rows = 632 ns/row) reads like a DEDUP
  problem and is not one. Isolated over 200k nodes: `DISTINCT n` 498.7 ns/row against a bare
  `RETURN n` at **481.2 ns/row** — so the dedup is **17.5 ns/row** and the rest is this item's
  element render (item 341 recorded 492 ns/row; today 481). For contrast `DISTINCT n.name` is 32.2
  against `n.name` at 7.0, and three scalars are 28.0. `distinct_by_keep` already has its
  `seen_ids` fast path; there is nothing to fix on the DISTINCT side. Item 341 showed
  native's element renderer has headroom (TS does the same materialization in 213 ns/row against
  native's 492, in-process both sides) and item 340 had located the term: the props loop walks every
  key in the STORE and filters by presence.
  **What the representation IS**: `present: Vec<bool>` + `nulls: Vec<bool>` — a **BYTE per cell per
  vector**, so a 200k-row store with K columns keeps 400 KB x K of presence and rendering one
  element touches two bytes in each of K separate arrays. Obvious enough to be worth measuring
  rather than assuming.
  **THREE VARIANTS, ONE BINARY** (200k nodes, 4 properties each, only the number of OTHER store keys
  varied; the packed variant's bitset is built OUTSIDE the timed closure on purpose, since a
  per-batch build is O(KxN) and the question is what a permanently-packed `Column` is worth on the
  read side). ns/row at 0 / 12 / 60 / 200 extra keys: full **220.6 / 289.5 / 643.5 / 1,791.8**;
  columns hoisted **89.8 / 116.9 / 167.4 / 408.0**; PACKED **90.5 / 102.9 / 145.4 / 244.7**.
  Per store key: full **7.86 ns**, hoisted **1.59** (**4.9x**, already done — `render_nodes` and
  `render_edges` at 340), packed **0.77** (**2.1x more**). At K=0 packed equals hoisted, so packing
  costs nothing when there is nothing to skip. The packed variant is **cross-checked against the
  byte-wise one for 1,000 rows before it is timed** — a fast path that skips work is
  indistinguishable from a fast one in a table of microseconds.
  **THE LADDER, all priced**: (1) hoist the lookup — done; (2) pack presence — 1.67x on a K=200
  render AND it reaches every other `present_at` caller (filters, `count`, `IS NULL`, seeks), which
  this sweep does not measure and so understates; (3) skip absent keys entirely via a per-node key
  list/mask — 0.77 to ~0, taking K=200 toward the 90 ns/row floor, **another ~2.7x and the largest
  single number here**.
  **RECOMMENDATION IS RUNG 2 DESPITE RUNG 3 BEING BIGGER** — _RETRACTED at item 343, which measured
  the breadth claim below and found it false; rung 3 is the better change._ The original argument,
  for maintenance not magnitude: packing
  is one change to a structure that already exists, with NO new invariant to keep in step, and every
  presence reader benefits. A per-node key list is a new index every `set_prop`/`remove_prop` must
  maintain — the write path items 331 and 335 kept deliberately cheap — and it pays off only on
  element projection. Land rung 2 first and rung 3's 2.7x can be judged against a much smaller base.
  **What this does NOT claim**: the pricing is READ-side only. Packing changes the codecs' view of a
  column and every `Vec<bool>` site in `store.rs`, none of which is measured — 1.67x is what the
  render scan would GAIN, not what the change would COST. A target with a number on it, explicitly
  not a plan.
- **The cross-engine bench had no row for the shape that dominates the native corpus — and the TS
  engine turns out not to materialize an element at all (341).** `query/perrow` prices `RETURN p`
  as the most expensive row in `bench_all`, and the only place the two engines are compared had NO
  element-projection row. Four added (lazy + forced-materialization, nodes + edges).
  **THE TS ENGINE DOES NOT BUILD THE MAP.** Checked before reporting, because the first number
  (ts 7.2ms against ffi 209.4 — a 29x inversion) was too good to publish without knowing what each
  side returned. Output is byte-identical (verified directly), but TS returns a **live `Vertex`**:
  `own keys: []`, `has toJSON: function`. It materializes NOTHING — the map is built by whoever
  serializes it, or never. Native builds it eagerly and ships it over the boundary. Same output,
  different time.
  200k nodes: lazy **ts 7.1 / ffi 204.7 / wasm 138.8 ms**; forced **ts 49.6 / 213.7 / 146.1**.
  1M edges: lazy **584.5 / 1346.3 / 932.9**; forced **1086.6 / 1389.1 / 1039.4**.
  **⚠️ I NEARLY REPORTED THE ts-vs-ffi RATIO AS A FINDING. IT IS CLOSED AT ITEM 289** — that gap on
  any row-returning query is the **JSON CARRIER**, not execution, and the same work with ONE row out
  runs 30.8x the other way. My own new `project 3 columns` row reproduces it (ts 12.9 vs ffi 52.1).
  I searched `CLOSED.md` for "element render" and not for the carrier — exactly the guide's _"each
  pass searched something first and searched the wrong store."_ The four rows now point at 289.
  **THE ONLY CARRIER-FREE NUMBER IS THE DIFFERENCE WITHIN EACH PAIR**, since the carrier is
  identical on both sides of it: **TS materialization is 213 ns/row** (49.6 − 7.1 over 200k) and
  **native's in-process render is 492 ns/row** (item 340's isolated harness). So **the native
  renderer is ~2.3x the TypeScript one at the same job**, both measured in-process. That is new and
  it reframes 340: its 1.045x was not nibbling at a floor — a row-store doing the same work in less
  than half the time is evidence of real headroom, and it points at the REPRESENTATION (native walks
  every store key and filters by presence; TS reads a bag it already holds) rather than at the loop.
  **And the laziness is a product difference, not a benchmark artifact**: a consumer reading two
  fields off fifty of a million returned elements pays TS nothing for the other 999,950 and pays
  native for all of them twice — once to render, once to carry. The `[ts lazy]` rows stay for that.
- **The edge renderer never got the batch twin the node renderer has — 1.045x on the corpus's
  biggest row, 1.78x on a heterogeneous store, and the surviving mutant was a silently-wrong row
  (340).** Item 339 named element materialization as next. First move was making the existing
  harness's pieces ADD UP (item 329's rule): `node_result_value` whole **224.9 ns/row** against
  named stages summing to **136.1** — an **88.8 ns (39%) remainder**, which reading the function
  places exactly on the `Vec<Value>` for labels plus two `Arc::new` + two `Vec` for the nested and
  outer maps. The bench's "three `Arc`s by construction" note, confirmed rather than assumed.
  **⚠️ THE SCALING NO FIXTURE IN THE REPO CAN SEE.** The props loop walks `prop_keys_arc()` —
  **every distinct key in the STORE** — and filters by presence, so render cost is **O(store keys),
  not O(element properties)**, and every fixture here has four. New sweep with the node's own
  property count FIXED at 4: **210.0 / 275.0 / 631.9 / 1,807.6 ns/row** at 0 / 12 / 60 / 200 extra
  store keys — **8.6x**, at **7.99 ns per store key per row**, falling to **1.54** with the column
  resolution hoisted. So `store.column(k)` is 81% of the scaling term. A heterogeneous people-graph
  (Person name/email/dob beside Company domain/size/founded) is 50-200 keys with a handful per node
  — the realistic case.
  **And the NODE path already had the fix**: `render_nodes` hoists for a whole batch and both node
  egress sites use it. **The edge path had no batch renderer at all** — both `Col::Edges` arms
  looped `edge_result_value`, which hashes `edge_prop_map(k)` per key per row. Invisible in the
  corpus because `element r`, its 1M-row case, has ONE edge key. Added `render_edges`.
  **MEASURED BOTH WAYS, because one number would have misled.** Query level, 3 alternated rounds,
  min, disjoint: `element r` **357,765 -> 342,484 (1.045x)**; `element p` **flat** — the control
  that makes it legible, since nodes were already batched. Scaling, both variants in ONE binary (no
  cross-build noise, no rounds needed): **1.01x worse at 0 extra keys**, **1.15x at 12**, **1.66x at
  60**, **1.78x at 200**; per-key cost **10.65 -> 5.41 ns**. The 0-key row is in the table rather
  than rounded away. Residual 5.41 ns is `m.get(&eid)` — edge properties are per-key `HashMap`s
  where node properties are columns with a presence bitmap. Next lever here, and a representation
  change rather than a loop.
  **I MADE ITEM 339'S MISTAKE ONE ITEM LATER**: the first draft had the per-edge variant DROP each
  map while the batched one returned a 200,000-element `Vec`, so the batched row read SLOWER at low
  key counts purely because it retained the output. Exactly _a ratio is only as honest as the
  sameness of its two sides_, by the person who had just written it down. Both sides now collect and
  the note is in the harness, not quietly fixed.
  **⚠️ M1 SURVIVED AND IT IS A SILENTLY-WRONG ROW.** Deleting the `u32::MAX` OPTIONAL-MATCH sentinel
  guard broke no test: `optional_match_binds_edge` returns `f.w`, a PROPERTY, so it never reaches
  the edge renderer. Without the guard the renderer builds a map for edge `u32::MAX` — `edge_ext_id`
  has no entry so it mints `"e4294967295"` and `edge_endpoints` falls back to `(0, 0)`, **a
  plausible-looking edge between two real nodes that does not exist.** Added
  `a_missed_optional_edge_renders_null_not_a_map`, which returns `f` itself. M2 (from/to swapped)
  and M3 (labels unsorted) were caught; M4 (un-hoisted lookup) is behaviour-preserving and its
  survival is the control, as at 336/337/339.
  **Still open**: the 88.8 ns/row of `Arc`+`Vec` construction per element (structural), and the
  edge-property representation.
- **The corpus read 69x "CALL overhead" and 92% of it was returning the rows — 4.17x dispatch,
  33.32x projection (339).** Item 338 named this as the largest unexplained RATIO (deliberately a
  ratio: internal to one run, so tenancy cancels). `algo/call` priced `degree` through GQL `CALL` at
  13,870 us against 201 us direct and its own comment claimed _"same units so the ratio is
  honest."_ It was not. `direct` computes degrees into a `Vec` and builds **no row at all**; the
  `CALL` emits **50,000 rows each carrying a NODE ELEMENT**. The ratio priced dispatch PLUS a
  per-row materialization the direct call never performs, and reported the sum as procedure-call
  overhead.
  **SPLIT**, by adding the same procedure through the same engine AGGREGATING instead of projecting:
  `direct` **186.38 us**; `counted` (`… RETURN count(*)`) **777.62 us** = **dispatch 4.17x**;
  `projected` (`… RETURN node, degree`) **25,907.47 us** = **projection 33.32x on top**. So the real
  dispatch-and-plumbing cost of a named CALL is **4.17x, not 69x**.
  **AND THE OTHER FACTOR IS ALREADY IN THE CORPUS TWICE**: 25,907 us / 50,000 rows = **518 ns/row**,
  against item 338's measurement of `query/perrow element p` at **516.5 ns/row** on the same machine
  the same afternoon. Same number — so `algo/call`'s dominant term was re-measuring element
  materialization under a label that pointed the reader at the procedure machinery.
  **THE GENERALISABLE PART, complementing item 338**: 338 argued that absolute numbers do not
  survive a session boundary and ratios are the durable part. This is the complementary failure —
  **a ratio is only as honest as the sameness of its two sides.** `counted/direct` and
  `projected/counted` are sound because each pair differs in exactly ONE thing; `projected/direct`
  differed in two and attributed both to the first. Cheap test: say out loud what each side does,
  and if the sentences differ in more than one clause the ratio needs a third measurement, not an
  explanation.
  **NOW THE LARGEST PER-ROW COST IN THE ENGINE**: element materialization at **~518 ns/row** against
  `scalar p.age` at **1.7 ns/row** in the same group. Dominant in `query/perrow element p` and
  `element r`, in `algo/call`'s projection, and in anything returning a node or an edge rather than
  a value from one. Next target, and unlike the 69x it is a real one.
- **NOT A REGRESSION — the two element-materializing rows read 2x the earlier sweep because of
  machine tenancy, bisected across three commits (338).** A fresh `bench_all` after items 330-337
  showed `query/perrow` `element p` at **249.8 -> 516.5 ns/row** and `element r` at
  **179.9 -> 374.9** — 2.07x and 2.08x, on 100-375 ms rows far too large for noise, and on exactly
  the only two rows in the corpus that allocate a `Value::Node`/`Value::Edge` per row. An obvious
  suspect list, and all of it wrong.
  **Bisected rather than reasoned about**: `query_bench` built at `c4aec4c9` (item 329, BEFORE any
  optimization in this run), `8288aa11` (item 330) and `f793382c` (HEAD), each run twice.
  `element p` **98,109 / 98,727 / 98,748 us** and `element r` **354,968 / 354,863 / 361,128** —
  **all three agree, including the one that predates every change.** The earlier number is simply
  not reproducible on this machine today.
  **What changed is the machine**: `uvicorn` 4.8 GB resident, `clickhouse-server` 1.8 GB, 20 of 61
  GB used, **3.7 GB paged into swap**, load 1.20. The affected rows are the allocation- and
  bandwidth-heavy ones; the small rows (`scalar p.age` 1.7 ns/row, `count(*)` 0.3 us, all of
  `query/plan`) are unchanged — the pattern a memory-bandwidth competitor makes, not a code change.
  **DO NOT CHASE IT.** The bisect is recorded so the next sweep showing 516 ns/row does not restart
  this.
  **THE METHODOLOGICAL POINT**: the guide says to know the noise floor and that <10% needs an
  isolated harness. This is the other end — **a 2x gap between two `bench_all` runs at different
  times can be entirely tenancy.** `bench_all` is a regression sweep for SHAPE (which rows exist,
  which are orders of magnitude apart, which direction a change moves them); its absolute
  microseconds are comparable only **within one session against an alternated control**, which is
  how every flag in 330-337 was measured and why none of them depended on this.
  Corollary: the same sweep shows `value/codec` decode **98.31 -> 64.25 ms** and
  **123.94 -> 84.66** across the same session boundary — the items 330-333 wins, and since the
  machine is now SLOWER they are if anything understated. A cross-session comparison is unreliable
  in magnitude but its SIGN still informs when the tenancy bias points the other way.
  **Target the sweep did surface, as a ratio rather than a time**: `algo/call` prices `degree`
  through GQL `CALL` at **13,870 us against 201 us direct — 69x dispatch overhead**. A ratio
  internal to one run, so tenancy cancels, and the largest unexplained one in the corpus.
- **Item 333's arena concat grew six vectors from empty — 1.03-1.07x back on the threaded decode,
  and the Amdahl pairs DISAGREEING is what found it (337).** Items 330-333 took the decode
  706.72 -> 401.70 ms, so item 329's decomposition is stale; re-deriving it rather than reusing it
  is what surfaced a cost item 333 introduced and nobody measured.
  **THE TELL.** Item 328's `T(n) = P/n + S` fit agreed at all six pairs (P = 347-390). Re-run
  today: **P ranges 76 to 270 ms**, and every pair involving `n=1` reports a much smaller P — the
  signature of a term present ONLY when `threads > 1`, which scales with neither `n` nor `1/n`, so
  a two-parameter model smears it into P. The 8-thread speedup had also fallen from **1.77x to
  1.50x** while the absolute time improved 411.51 -> 268.25. Both true, and reading only the
  absolute number is how it hid: item 333's A/B reported `threads @8` as one row and never looked at
  the ratio between its own columns.
  **THE COST.** `stage_ndjson_threads` concatenates the per-chunk `StagedNdjson`s, and item 333 gave
  each two arenas. All SIX vectors grew from empty unreserved; growing one to N by doubling
  re-copies everything already in it, ~N extra element moves. On the corpus fixture that is 200k
  node records, 1M edge records, a 1.2M label arena and a 2.4M property arena — copied roughly
  twice. **The serial path never does any of it**, which is exactly why it hid inside P. Fixed by
  summing the parts' lengths and `reserve_exact`ing all six, then `append` instead of `extend`.
  **MEASURED**, 3 alternated rounds, min, all three target rows disjoint: `threads @2`
  **359.84 -> 349.39 (1.030x)**, `@4` **306.44 -> 285.29 (1.074x)**, `@8` **261.72 -> 246.20
  (1.063x)**; speedup **1.546x -> 1.630x**. **`threads = 1` is the control the change cannot reach**
  (that path never enters the concat) and is flat, as is the serial `ingest/phases` decode. The
  `recmat_ms` null control drifts +4% again, as at item 331 — this harness's cross-build layout
  noise is ~4%, which is why disjointness across rounds carries the claim.
  **THE RESIDUAL, honestly.** Re-fitting, the pairs STILL disagree (P = 104-313), so the
  parallel-only term is reduced, not removed: what is left is the arena copy itself, which `append`
  does however well reserved. That is the price of item 333's design — one contiguous arena per kind
  is what made the SERIAL decode 1.07-1.26x faster, and is also work only the threaded path does.
  **PRICED, NOT BUILT**: keep per-chunk arenas and put a chunk index in the `Span` so nothing merges
  — a third `u32` per record (`Span` 12 bytes, still smaller than the two `Vec`s it replaced) plus
  an indirection on every arena read in `build_store`. Worth it only if the threaded decode becomes
  the dominant workload; recorded at the concat.
  4 mutants: offsets-read-after-append, chunks-merged-in-reverse and labels-span-not-rebased all
  caught, each by exactly ONE test — `decode_is_byte_identical_across_thread_counts`, the one item
  333 had to fix because its uniform fixture made it blind. **That test has now earned itself
  twice.** M3 (a reservation sized from the wrong field) is behaviour-preserving and its survival is
  the harness's control.
  **METHOD, the generalisable part**: item 328 recorded that an Amdahl fit over an existing sweep
  recovers the serial fraction with no instrumentation. The addition is its failure mode — **when
  the pairs stop agreeing the fit is not noisy, it is telling you the model is missing a term**, and
  WHICH pairs disagree localises it. Here the disagreement concentrated in the `n=1` pairs, which
  pinned the term to the threaded path before any code was read. Free on any sweep that exists.
- **93% of a wide TS delete was enumerating the element's property keys for the reactive token bump
  — 3.00x, after two candidate fixes that did nothing (336).** Item 335 named the per-width cost in
  both delete columns and GUESSED the property de-index. Wrong, killed by one grep:
  `PropertyIndex.remove` iterates the DECLARED indexes, not the element's properties, so with none
  declared it is O(0). The real term is `pushTokens`, which pushes **one token per property key** on
  add/remove because a topology change really does alter the value set of every key the element
  carried. Short-circuiting that loop (diagnostic only): width 256 **6,212 -> 421 ns/node**, so it
  is 93% of the delete and essentially all of the width-dependence.
  **TWO CANDIDATES THAT MEASURED NOTHING**, recorded because each is the obvious next move.
  **`for...in` instead of `Object.keys`**: 6,617 vs 6,212 baseline — slightly worse, so the
  intermediate ARRAY is not the cost. **`pendingTokens` as a `Map<token, times>`** (counts kept
  exact — epoch numbers are observable, `epoch` is public API mirrored from the Rust core — so only
  the container changed, capping it at distinct tokens instead of one entry per write x token, 5.12
  MILLION strings in one microtask window): width 4 **1.13x better**, 16 **1.10x**, 64 **1.21x**,
  256 **1.34x WORSE**. A width-dependent trade with no winner, and it **refutes the assumed
  mechanism** — the cost is NOT the pending array growing unboundedly, because a structure that
  never exceeds 256 entries is slower at width 256.
  **And the lever that needed a semantic decision turned out not to need one.** A `Set` (dedup)
  collapses 5.12M epoch bumps to 256 but changes the counts, so it would be a cross-engine
  semantics call. Measured anyway to put a number on the decision: **6,489 ns/node, no faster than
  the list.** Nothing to decide — the per-token hash in costs what the `Map.set` it saves costs.
  **WHAT IT ACTUALLY IS**: key ENUMERATION over a wide bag, which the engine holds in dictionary
  mode (the 128->256 cliff already recorded for TS `SET`). `Object.keys` and `for...in` are equally
  slow there and neither can be avoided — but it can be done **once per bag instead of once per
  event**. `PropBox` gained `keys?: readonly string[]`, memoized via a `propertyKeys` accessor on
  `Vertex`/`Edge`, cleared at the two sites that assign `bag` (sound by item 335's facts: frozen
  bag, replaced never mutated). **Memoized only above `WIDE_BAG = 64`**, because the memo RETAINS
  the array where the old code threw it away (~8 bytes per property per element) and the payoff is
  entirely at the wide end.
  **MEASURED**, 3 alternated rounds, min: width-256 delete **6,211 -> 2,070 (3.00x)**, in a
  transaction **8,248 -> 4,231 (1.95x)**, widths 4/16/64 flat. **The ADD column is the control that
  proves the mechanism**: the add COMPUTES the memo so it cannot benefit, and it does not — it pays
  ~2.6% to retain the array (~1% with the threshold). Only the second enumeration is saved, which
  is what a memo does. TS `decode ndjson (nodes)` **236.0 -> 229.5ms** and `(5 edges/node)`
  **2,578.5 -> 2,595.3**, both overlapping — no regression below the threshold.
  **⚠️ M1 AND M2 — the memo's invalidation, the entire invariant — SURVIVED**, and **the threshold
  is why**: below `WIDE_BAG` nothing is cached, so a stale memo is unobservable and every narrow
  fixture in the suite is blind to it BY CONSTRUCTION. The two new tests use an 80-property bag,
  add a key AFTER creation, and assert the removal still bumps that key's epoch. M5 (memo never
  written, behaviour-preserving) correctly survives and is the harness's own control.
  Third item running where writing the mutants was the only thing that found the gap, and the
  second where the gap was a FIXTURE rather than a missing test (cf. 333, 335).
  **Still open**: ~2,000 of the 2,444 ns/node at width 256 is the pushes plus the epoch `Map.set`s,
  which the three container experiments say is not reducible by changing the container. The next
  lever would be enumerating neither bag, which needs the epoch contract to stop being per-key — a
  cross-engine semantics question, not a perf one.
- **The transactional delete's property copy was never needed — 1.70x at width 256, and two mutants
  proved the change rested on untested facts (335).** Item 334 removed the capture OUTSIDE a
  transaction, where it was dead; its probe then showed that INSIDE one it is still taken and still
  O(property width) — 15,010 ns/node at width 256 against 6,251 outside — which looked like the
  floor, since a rollback there genuinely might replay. It was not the floor: **the copy was never
  needed.** Three facts, each already documented in a comment: the bag is `Object.freeze`d; every
  write REPLACES `box.bag` rather than mutating the bag; and `addVertex`'s constructor assigns
  through the public setter, which copies defensively. So a reference to the current bag already IS
  a stable snapshot and the replay makes its own copy when it runs. `evict` does not clear `#box`,
  so the bag outlives the vertex. The LABELS stay a copy — `commitElementLabels` replaces the box's
  `Set` but the add/remove-label funnel is a separate path, and a label set is 1-2 entries.
  **MEASURED** (`bun run delete:width`, 3 alternated rounds, min, `del_ns/node`): in-txn width 64
  **1,792 -> 1,292 (1.39x)**, width 256 **13,834 -> 8,117 (1.70x)**; widths 4 and 16 overlapping,
  which is the expected shape (a 4-key spread is nearly free, and within-side noise is ±30% there).
  **The non-transaction column at width 256 is 6,198 vs 6,212 — flat to 0.2%**, the control this
  change cannot reach because item 334 already skipped that capture.
  **⚠️ TWO OF FIVE MUTANTS SURVIVED, both breaking facts this change DEPENDS on, both in files it
  does not touch.** M2 made the constructor alias the bag instead of copying — **the defensive copy
  in `set properties` is the entire reason this change is sound, and removing it broke no test.** It
  had a comment explaining itself and nothing asserting it, which is exactly the state in which a
  later "the setter copies twice, drop one" looks like free money. M5: `rollback reverses edges,
labels, and property removals too` exists, yet a rolled-back edge REMOVAL never had its properties
  checked. Both tests added; all five caught after.
  **RULE: when a change's safety rests on behaviour ELSEWHERE in the codebase, mutate that
  behaviour, not only the lines you edited.** Neither survivor would have been found by mutating
  `removeVertex`. A comment asserting an invariant is not a test of it — three facts documented,
  one guarded.
  **Still open on this path**: a transactional delete is now 8,117 ns/node against 6,212 outside, so
  ~1,900 ns of genuinely transactional work remains (undo-log push, `txTouched`, deferred-check
  bookkeeping) and is no longer dominated by a copy. The per-width cost in BOTH columns — 6,212
  ns/node at width 256 against 273 at width 4 — is the **property de-index**, sub-linear (23x the
  cost for 64x the properties) but far from flat, and a separate real target.
- **The TS engine built an undo closure on every write and threw it away — REFUTED on the write
  path, 1.3-1.9x on DELETE (334).** `Graph.recordUndo(inverse)` is a no-op unless
  `txDepth > 0 && !applyingUndo`, but all **eight** call sites built the closure eagerly, because
  the inverse is taken BY VALUE. The same shape item 331 found in Rust, where `record_change` took
  its `Change` by value. Two of the eight were worse than a closure: `removeVertex` and
  `removeEdge` captured `[...vertex.labels]` and `{ ...vertex.properties }` for a rollback that
  could not happen, which is **O(property width)**. Gated all eight on a private `undoWanted`
  getter (the same condition `recordUndo` tests).
  **Answering the question as asked — batching the undo closures is NOT the fix and would not have
  helped.** Outside a transaction they are not a cost to amortize, they are work with no reader, and
  removing them entirely does nothing measurable. What was worth removing is the per-property copy
  standing next to them.
  **REFUTED on the write path.** `decode ndjson (nodes)` is 200,000 `addVertex` calls (verified —
  `packages/serialization/src/ndjson/index.ts:115` goes through it, so not item 321's mistake).
  Three alternated rounds, each side rebuilt: **242.2 -> 236.6ms, overlapping**; the 5-edge row came
  out NEW-slower; `query: count` control flat. At 1.2µs a vertex, two closure allocations are not
  findable.
  **⚠️ AND `bench:usage` COULD NOT HAVE SAID OTHERWISE.** Its `read: point lookup` row — which this
  change cannot reach — read **685.4k / 911.4k / 1.16M ops/s across three rounds, a 1.7x spread on
  an unreachable control.** So **`bench:usage` cannot settle any question below ~2x**, and rows read
  there as "flat" are not evidence of flatness. The harness does not say this about itself.
  **1.3-1.9x on DELETE, with an in-table control.** The removed copy is O(WIDTH) and every fixture
  in the repo gives a node 3-4 properties, so the claim needed a fixture that varies width — new
  permanent probe `packages/native/delete-width-probe.ts` (`bun run delete:width`), 20k nodes, min
  of 7, `del_ns/node`: width 4 **362 -> 273 (1.33x)**, 16 **518 -> 391 (1.32x)**, 64
  **1334 -> 1031 (1.29x)**, 256 **12,095 -> 6,251 (1.93x)**. **The in-transaction column is a
  control inside the same binary and is flat at every width** (310/327, 670/640, 1798/1512,
  14634/14339) — a rollback can replay there, so the capture is not dead. And the two columns'
  RELATIONSHIP inverts: on CONTROL delete-in-txn and delete-outside cost nearly the same at width
  256 (12,095 vs 14,634) because both copy; on NEW they differ **2.3x**. That is the mechanism's
  signature, not a timing coincidence.
  Also added `write: append then delete node` to `bench:usage`, which **had no delete workload at
  all**. And `delete-width-probe.ts` reads core's SOURCE (lint-disabled with a reason the rule's own
  message names): a build between every edit and every measurement is what made the A/B above cost
  six builds and ten minutes where the width sweep cost seconds, and that cost is why the sweep did
  not already exist.
- **Two arenas and a span instead of two `Vec`s per record — a 50,000-node decode now makes 271
  allocations, and three mutants survived because the fixture was uniform (333).** Item 332 named
  this from the count: the records' own `Vec`s were **616,488 of the 700,036** remaining
  allocations, because Rust's first growth for a 24-to-56-byte element is capacity 4 and a record
  holds one or two. `StagedNdjson` gained `labels` and `props` arenas filled in line order;
  `NodeRec` is `(Cow, Span, Span)` and `EdgeRec` `(Cow, Cow, Option<Cow>, Span, Span)` with
  `Span = (u32, u32)` (64-bit spans would make the record bigger than the `Vec` they replace). The
  parser grew `string_array_into` / `pairs_into`; `binary.rs` got `str_list_into` / `props_into`, so
  both decoders still feed one `build_store`. Also hoisted `build_store`'s per-node `lrefs`/`prefs`
  out of the loop — two allocations per node whose life was one `add_node_bulk` call, **-100,000**.
  **COUNTED across the arc**: nodes+5edges **3,050,033 (330) -> 2,550,034 (331) -> 800,034 (332) ->
  100,072**, i.e. **30.5x fewer**; nodes-only **450,238 -> 271**. What remains is store structure,
  not per-record transit, so the per-record ingest target is CLOSED.
  **MEASURED**, five alternated rounds in both orders, every target range disjoint, null control
  flat: `nodes x1 prop` **1.239x**, `nodes x4 props` **1.071x**, `nodes+5edges` **1.251x**,
  `ingest/ceiling` **1.257x**, `threads @8` **1.140x**, `value/codec flat` **1.091x**,
  `value/codec meta record` **1.142x**. Cumulative 330-333 on `nodes+5edges`: **706.72 -> 401.70 ms,
  1.76x**. `ingest/ceiling` is now 43x the raw-scan floor, down from 78.9x when item 328 opened the
  thread. The SPREAD is the mechanism check: the removed cost is per RECORD, so four properties
  dilute it (1.071x) where one does not (1.239x), and `threads @8` gains less than serial because
  the parse is the half that parallelizes — Amdahl in the expected direction.
  **⚠️ THREE OF FIVE MUTANTS SURVIVED FIRST RUN, and the cause was the FIXTURE.**
  `decode_is_byte_identical_across_thread_counts` compares 2/4/8/16 threads against serial and is
  exactly the test that should catch a dropped span rebasing. It did not: **every node in its
  fixture carried the label `Person` and every edge an EMPTY `properties`.** An unrebased span still
  lands on an identical string when every string is identical, and an empty span cannot be offset
  wrongly at all. This is the fixture failure the repo guide warns about for `examples/` probes,
  found in a UNIT test — where the guide says correctness is supposed to live. Fixed by deriving
  each record's second label and each edge's properties from its index; M4 (the last-wins rewind)
  had no test at all, so `a_repeated_labels_or_properties_key_is_last_wins` was added. All five
  caught after. **RULE: a byte-identity test over a uniform fixture tests the plumbing, not the
  addressing. Any change that makes a record's data reachable BY INDEX rather than by ownership
  needs a fixture where the index is recoverable from the data.** The test had been green for its
  whole life and would have stayed green through a real rebasing bug.
- **The staged records now BORROW the input — 1.21-1.29x on native's decode, and both estimates of
  it were wrong (332).** `NodeRec`/`EdgeRec`/`StagedNdjson`/`Rec` gained a lifetime and hold
  `Cow<'a, str>` for every id, label and property KEY; the `Value`s stay owned. `Cow` and not
  `&'a str` because two cases cannot borrow — a JSON string with an escape, and a numeric id — and
  both already existed as item 330's `string_cow` owned arm, so most of the work was pointing
  `pairs` / `string_array` / `id_as_string` at a function that was already there. **The binary codec
  came too and wanted to**: `Reader<'a>::str` already had `take(n) -> &'a [u8]` and called
  `str::to_string` on the validated slice, and `value()` allocated a `String` only to copy it into a
  `GStr` — the same waste item 330 found on the JSON side. No escapes in that format, so it is a
  plain `&'a str` there.
  **COUNTED**: `alloc_count_probe` reads **2,550,034 -> 800,034 allocations (-68.6%)** at 50k
  nodes / 250k edges; the ≤8-byte classes total **16** where they were 2,250,015. That includes the
  `"type":"node"` allocation item 331 left open.
  **MEASURED**, five alternated rounds in both orders, every target range disjoint, both controls
  flat: `nodes x1 prop` **1.208x**, `nodes x4 props` **1.192x**, `nodes+5edges x2 props` **1.265x**,
  `ingest/ceiling` **1.293x**, `value/codec flat scalars` decode **1.268x**. The controls are
  ENCODE (does not touch the staged records) and `recmat_ms` (a `format!` loop in the example
  binary) — the latter drifted 2-5% at item 331 and is within 0.8% here, so this effect needs no
  noise-floor argument.
  **WHY BOTH ESTIMATES MISSED, which is the transferable part.** 329 said 1.2-1.4x from a micro.
  331 re-priced DOWN to 1.13-1.18x by counting the allocations and multiplying by item 330's
  **in-situ** 5-7ns per allocate-and-free pair — every input measured, still low by 3x.
  **A per-allocation cost is not a constant of the allocator; it is a property of the allocation's
  LIFETIME.** Item 330's were short-lived and LIFO, served off a hot free list at 5-7ns. These ~7M
  are held live across the whole parse and freed in one bulk teardown after 300MB of churn: page
  faults up, cold pointer chase down, **~19ns each**. A count is still the right instrument — it has
  no noise floor — but the rate must come from an allocation with the same lifetime as the ones
  counted.
  4 mutants, all caught (3 / 2 / 44 / 83 failures). The two the change puts real weight on are also
  the two with the fewest failures: **the binary codec's string-length handling is guarded by exactly
  two assertions**, named rather than smoothed over.
  **Was still open and is now DONE at item 333**: the records' `Vec`s (two per node, two per edge,
  the ≤96 and ≤256 buckets) were the largest remaining group — replaced by two arenas and a span,
  worth another 1.07-1.26x. The edge loop's 180ms serial floor and the input-order
  constraint are unchanged (328).
- **A property write allocated its key THREE times and stored one — 1.05x on the decode, 1.09x on
  bulk SET (331).** Item 330 left an instruction to re-price the staged-record borrow against its
  own 5-7ns-per-allocation number before building it. That re-pricing wanted a COUNT (the failure
  mode of the old 1.2-1.4x figure was that it was a micro), so `alloc_count_probe` gained the
  decode — and the count found a better target than the one it was asked to price.
  **The three keys.** `social_ndjson`'s edge has exactly one 1-byte thing in it, the property key
  `w`, and the bulk row showed **three 1-byte allocations per edge**. Widening that key to 2 and
  then 4 bytes moved **all three** into the matching bucket together, so all three are the key. A
  NODE property key allocates once — the decode never reaches the node path's spares, because
  `add_node_bulk` bypasses `set_prop`. Reading them: the `Undo::RestoreEdgeCell` key is already
  behind `undo.is_some()` and free; `edge_props.entry(key.to_string())` allocated on EVERY set
  including the common already-exists one; and `record_change(Change::EdgeProp { key: … })` took the
  `Change` **by value**, so the key was built at the call site and discarded by an `if let
Some(ch) = &mut self.changes` that was `None`.
  **The fix was already in the file, with a comment saying why.** `bump_epoch` does `get_mut`
  first — _"Avoid a String alloc when the token is already tracked (the common case)"_ — and three
  sites had not applied it. Added `record_change_with(impl FnOnce() -> Change)` for the three
  `Change` variants that carry an owned key (4 call sites), and made `apply_set_prop` /
  `set_edge_prop` look up before owning.
  **Counted, not estimated**: `nodes+5edges x2 props` goes **3,050,033 -> 2,550,034 allocations**,
  exactly 2 fewer per edge property write, and the nodes-only row is **unchanged at 450,238** — a
  free control the change cannot reach. Eleven alternated rounds (7 ctl-first, 4 new-first), min of
  each, both target rows **fully disjoint**: decode **661.07 -> 629.03ms (1.051x)**, `SET p.age`
  **35.19 -> 32.39ms (1.086x)**; engine controls `nodes x4 props` flat and `nodes x1 prop` +2%.
  **THE HARNESS'S OWN NULL CONTROL DRIFTS 2-5%, so a 1.05x row is below it.** `recmat_ms` is a
  `format!` loop inside the example binary that never calls the engine, and it reads 2-5% slower in
  the NEW binary **in both orders** — not run-order drift but code layout, since the engine is
  statically linked into the examples (same sensitivity already recorded for `exec::pull`). Hence
  the claim rests on the COUNT; the timing corroborates it by being disjoint across eleven rounds in
  both orders while the null control moves the other way. **Generalisable: when a win is smaller
  than the harness's noise floor, make the instrument a count and let the clock be the backstop.**
  4 mutants, all caught (170 / 74 / 4 / 2 failures). M1 leaves the closure CALLED and discards only
  its result, so it proves the pushed value is load-bearing rather than that something runs. M4's
  **2** failures are the thin spot, named rather than smoothed: the created column's SHAPE is
  guarded by exactly two assertions.
  **Re-pricing result, which was the original question — AND IT WAS WRONG, see item 332**: 73.8% of
  the decode's 3.05M allocations are ≤8 bytes, ~9.0M scaled to the corpus fixture, so the string
  share of item 329's 67.8ms teardown is ~53ms and the staged-record borrow looked like
  **~1.13-1.18x, not 1.2-1.4x**. Item 332 built it and measured **1.21-1.29x**: the count was right
  and the RATE was not, because item 330's 5-7ns was a short-lived LIFO allocation and these are
  long-lived (~19ns). A per-allocation cost depends on lifetime. **Also still open and now cheap**: `"type":"node"` / `"type":"edge"`
  is the 4-byte bucket — one allocation per LINE for a field a node never reads — and it is
  `string_cow`'s exact shape, no lifetime work.
  **Method, recorded because it cost a wrong turn**: differencing SMALL documents does NOT attribute
  a per-line allocation cost; at a few lines the store's own HashMap growth swamps it and
  differences come out negative. Varying ONE field of the fixture at 50k lines does, because the
  bucket that moves by ~50k names itself.
- **The staging parser allocated a `String` per JSON object KEY to compare it against a literal —
  1.05-1.11x on the decode (330).** `JsonParser::string()` already computed the escape-free slice
  and then called `.to_string()` on it. Two callers never needed the `String`: **`record()`
  allocates one per object KEY purely to `match` it against literals and drop it** (4 per node
  line, 6 per edge) and **a string property value** was allocated only to be copied into a `GStr`.
  ~**8M allocate-and-free pairs storing nothing** on the corpus fixture. `string()` keeps its
  signature (`string_cow()?.into_owned()`), so only the two wasteful callers changed; the stored
  `pairs()` key stays owned.
  Three alternated rounds, all ranges disjoint: `nodes+5edges x2 props` **706.72 -> 671.35ms
  (1.053x)**, `nodes x1 prop` **71.53 -> 64.42 (1.110x)**, `ingest/ceiling` **718.07 -> 658.96
  (1.090x)**.
  **ITEM 329's 1.2-1.4x ESTIMATE WAS OVERSTATED, and this says why**: the per-allocation cost is
  **5-7ns, not 25-40** (35ms for ~8M pairs). Same lesson as item 324's hash pricing at 27ns instead
  of 115 — an allocator with a hot free list and short-lived objects is far cheaper than an
  isolated micro suggests.
  **THREE THINGS 329's PLAN GOT WRONG, found by reading before writing**: `record()` does not go
  through `Json` at all (the staging reader is its own, and already moves rather than clones, so
  `json_string`'s clone is on the ffi/schema path); a `Json<'a>` lifetime is a multi-tick refactor
  across **27 sites in three modules**, not a slice; and a JSON string cannot be a plain `&str`
  because escapes must be unescaped into a buffer — hence `Cow`.
  5 mutants: always-borrow and raw-key-compare caught; three equivalent. **M2 was designed as a
  wrong-span mutant and is provably NOT one** — that return is inside `if buf.is_empty()` and `run`
  only advances in the escape arm, so `run == start` there. Two tests added, and only the KEY one
  was a gap: the string-VALUE escape path was already covered by
  `binary_round_trips_escaped_strings`.
  **Still open, and RE-PRICED at item 331**: the records themselves are owned — a COUNT puts the
  borrow at ~1.13-1.18x rather than this item's projected range, worth re-pricing against this item's
  per-allocation number — and reachable with a `Cow` in `NodeRec`/`EdgeRec` WITHOUT the `Json<'a>`
  refactor, since the staging reader never touches `Json`.
- **Where native's 752ms decode goes — and 68ms is freeing records the parse never needed to own
  (329).** The probe item 328 named. Instrumented at the parse/build boundary and every serial
  stage (200k nodes / 1M edges / 115.8 MiB):
  **parse 370.5ms (49%)** and **serial build 381.8ms (51%)** — which puts item 328's Amdahl fit
  (347-390 / 363-382) **within 5% of a direct measurement**, so a `T(n) = P/n + S` fit over an
  existing threads sweep recovers a serial fraction without instrumenting anything.
  Inside the build: **edge loop 179.9ms (24% of the decode)**, `resolve_endpoints` 98.1 (13%, but
  **already parallel above one thread, so NOT a target**), **dropping the staged edges 58.3
  (7.7%)**, node loop 14.7, **dropping the staged nodes 9.5**, `rebuild_csr` 8.8, degrees+reserve
  4.4, `materialize_ext` 4.0, `rebuild_edge_num` 3.8, `end_bulk` 0. The stages first summed 73ms
  short of the measured build and **the gap was the teardown** — timed explicitly at **67.8ms, 9%
  of the decode, spent freeing memory and producing nothing.**
  **PRICED TARGET: borrow the staged records.** `EdgeRec` is
  `(String, String, Option<String>, Vec<String>, Vec<(String, Value)>)`, so a 1M-edge decode makes
  ~5M allocations in the parse and frees them in the build. Teardown **67.8ms measured in situ**;
  the matching build-up **161.3ms in a micro of the same shapes** (213.03 owned against 51.75
  borrowed, 4.12x) — together roughly **1.2-1.4x on the whole decode**, the largest native ingest
  target identified. The in-situ half is firm, the micro half indicative (this repo has seen a
  micro understate 5x at item 119 and overstate to zero at 321/323).
  **Borrowing IS available here, unlike the GQL lexer (294/317)**: the input `&str` outlives the
  whole decode, so `NodeRec<'a>`/`EdgeRec<'a>` with `&'a str` ids/labels/prop-keys is sound, the
  `Value`s stay owned, and the records are only shared immutably across staging workers. Recorded
  at the type definition.
- **Native's NDJSON decode is HALF SERIAL, and its recorded Amdahl bound was 25% optimistic (328).**
  `bench_all` says the decode is the native corpus's largest absolute cost by two orders of
  magnitude — `ingest/ceiling (5 edges/node)`: **raw scan 9.10ms against decode 717.56ms, 78.9x**,
  where the next biggest row is `query/gql project 3` at 5.4ms.
  Split from data ALREADY in the corpus, no new measurement: fitting `T(n) = P/n + S` to
  `ingest/threads` (**729.08 / 555.59 / 460.24 / 411.51 ms** at 1/2/4/8) at **all six pairs** of
  points (item 327's lesson, same day) — **P = 347-390ms parallel parse, S = 363-382ms serial
  build, serial share 50-52%, ceiling 1.91-2.01x.**
  `from_ndjson_threads`' doc comment claimed _"~2.5x @ 8 threads (measured)"_. **Not reachable** at
  today's serial fraction, and the measured 1.77x is **88% of the real bound** rather than 71% of an
  achievable one — which reframes the parallel side as nearly done and the serial build as the
  target. Corrected in place.
  **REFUTED by reading a type, not a benchmark**: removing the ~2.4M per-property `v.clone()` calls
  in the two serial loops (both loops CAN consume — `staged` is destructured by value). `GStr::clone`
  is a **16-byte struct copy** for an inline string (≤12 bytes, which these are) and a relaxed
  atomic increment for a long one — no allocation either way. **Read the clone impl before pricing
  a clone.**
  **Still open, sized**: the ~370ms serial build against a 9.10ms raw-scan floor. Already carries
  bulk mode, `add_node_bulk`, pre-reserved adjacency, parallel endpoint resolution, and a recorded
  refutation of a parallel counting-sort rebuild. The ordering constraint is real (eids in input
  order keep the decode byte-identical at any thread count), so the next move is a decomposition of
  those 370ms into store operations — the probe this corpus lacks — not another attempt to
  parallelize the insert.
- **The adjacency's innermost `Set<Edge>` priced on three axes — PRICED, SIZED, NOT BUILT (326).**
  An edge enters a `(vertex, label)` bucket exactly once, so the Set's dedup is never needed. 1M
  edges across 200,000 buckets of 5:
  **INSERT 45.8 -> 6.4ms (7.13x)**, **ITERATE 3M visits 29.2 -> 4.6ms `for…of` (6.37x) / 3.3ms
  indexed (8.80x)** — both of which hold at EVERY degree, because a Set's hash is flat and it is
  paying for a uniqueness that cannot be violated.
  ~~**REMOVE at degree 5: the ARRAY 9x FASTER**; **at degree 1000: the array 24x WORSE.**~~
  **BOTH REMOVAL FIGURES CORRECTED BY ITEM 327** — they measured LOCALITY, not degree (the degree-5
  case probed 200,000 cold buckets, the degree-1000 case one hot bucket; the tell was `Set.has`
  reading 27ns at degree 5 and 2.5ns at degree 1000, which no hash set does). Re-measured with
  bucket count and probe count held constant: **the crossover is degree ~8**, the high-degree
  penalty is **7.4x not 24x**, and the low-degree advantage is **~1.03x not 9x**.
  **And the verdict improves**: removal happens at most ONCE PER EDGE where iteration happens once
  per edge PER QUERY, so the threshold follows that ratio rather than the crossover — at degree 128
  an array is 2.51x worse on a once-per-edge operation and 6-9x better on a per-query one. The
  counter is degree SKEW (most edges live in high-degree buckets, so a threshold of 8 gives up most
  of the win; 64-128 keeps it). That is a read/write-mix decision on real data, not a measurement.
  Worth ~**1.05x** on `decode ndjson` (three Set adds per edge = ~137ns of item 312's 810ns
  `indexEdgeLabel`) and ~**1.17x** on the gated three-hop rows (~8.2ns an edge-visit over 3M),
  compounding with 324. Real, and not enough to justify a swap that regresses high-degree removal
  24x.
  **The shape that would work is a hybrid** — array up to a threshold, Set above, which is item
  267's own `IN_CHAIN_MAX = 32` pattern with thresholds that are measured here rather than guessed.
  What makes it work rather than a swap is the API, counted not estimated: **21 sites type the
  container as `Set<Edge>`** across `Graph.ts`/`executor.ts`/`shortcuts.ts`/`graph-queries.ts` and
  **12 read `.size`**, so a hybrid must provide `size`/`has`/`delete`/iteration without a wrapper
  whose method calls give back what the container saved (`ts-closure-size-is-load-bearing`).
  **Neither win has a narrow slice**: iterating a Set as an array is not a thing and the insert
  saving IS the `add`. The remaining question is the container's public shape — an API decision, not
  a measurement.
- **Four vertices out of 200,004 cost a spelling 2.8x, and the probe group that should have caught
  it was testing something else (325).** `vacuousLabel` is an EXACT equality (the label's bucket
  against `vertexCount`), and `spelling-probe`'s fixture adds **four `:S` nodes** for an unrelated
  group — so `|P| = N` against `vertexCount = N + 4`, **`:P` is not vacuous**, `effectiveLabel`
  cannot elide it, and the `three hops: a vacuous start label vs none` group has been comparing a
  real label constraint against none. Its 1.87x was correct behaviour; item 324's 2.6x was correct
  behaviour plus a genuine improvement to one member.
  Pointed at a label every vertex carries, the labelled member goes **537.92 -> 190.91ms** and the
  two land within **1.03x**. **NOT A BUG** — eliding a label four vertices lack would change the
  answer — but a CLIFF worth knowing: vacuity is all-or-nothing, so one unlabelled node in a real
  graph defeats the elision for every query anchored on that label, falling from a bucket-size read
  to a per-edge label check. **The elision now has an end-to-end guard it did not have**: pointed at
  `:P` it never fired, so nothing would have noticed it breaking.
  **The obvious fix silenced a deliberate guard.** Giving the `:S` nodes a `:P` restores vacuity
  AND takes `label on start: redundant vs absent` from 3225x to under the 1ms floor — the group
  this file records as "CORRECT, not outstanding… do not quiet it by reverting the fixture", whose
  2100-4160x has the same cause. So the fixture gained a SEPARATE vacuous label (`:Univ`) that only
  the vacuity group uses; `:P` stays non-vacuous on purpose. Both groups now test their own
  premise: **0 answer disagreements, 0 under the floor, one group over 2x (the guard, 3225.6x)**.
  (`:All` was refused first — "`All` is a reserved word and can't be used bare as a label name".
  Correct ISO behaviour, free confirmation that the check works.)
  **REFUTED, via 324's "grep for `yield*`" lesson**: `edgesMatching`'s identical single-label
  `yield* set`, on the general traversal path. **0 calls** across `traverse 1-hop project`,
  `query: distinct over a hop`, `query: 2-hop subquery item` and `count 3-hop` — `expand`'s own
  fast path (item 119) already bypasses it for every caller that matters. Counted before a line was
  written. `candidateVertices`' two sites were already done by item 164 (`candidateVertexSource`).
- **`edgesOfTypes` was a generator delegating to an iterator it could have RETURNED — 1.253x on the
  84x row (324).** Its hot single-type path was `yield* byType.get(types[0]) ?? []`, and a
  `Set<Edge>` is already an `Iterable<Edge>`. Split into a returning fast path for the two
  single-bucket cases plus a generator tail for the multi-bucket case, which dedupes and so
  genuinely wants to be lazy.
  Priced in the sweep's own shape first (200k slots x ~5 edges x 3 passes): **68.7 -> 43.4ms,
  1.58x, 8.4ns an edge** — and the returning version came in at or BELOW the floor of iterating the
  Set with no call at all, so the call is free. In situ, four alternated rounds, one case per
  process, ffi column flat on every line: **`count 3-hop` 397.6 -> 317.4ms (1.253x)**,
  `+ end filter` 198.4 -> 167.8 (**1.182x**), `+ start filter` 192.7 -> 169.8 (**1.135x**), all
  three with DISJOINT ranges; `traverse 1-hop + filter` and `query: distinct over a hop` flat in
  the same harness, which is the predicted control behaviour.
  **The per-edge budget it was picked from**: the gated three-hop rows are ~86ns an edge-visit
  against native's ~1.4 for the SAME algorithm, of which `slotOf.get(farId)` is **27.2ns** and the
  generator frame **8.4ns**. The hash prices far below the ~115-157ns items 321/323 measured for a
  string-keyed Map because `e.toId` returns the same string OBJECT each time and V8 caches a hash
  on a string. **PRICED AND NOT BUILT**: a dense ordinal per vertex stored on the EDGE at insert
  would remove the hash for a ceiling of ~1.44x on one row — a layout change, recorded for its own
  item.
  **It widened a known spelling group and that is stated, not buried**: `three hops: a vacuous
start label vs none` (item 221) went 1.87x -> 2.6x because the UNLABELLED member got **1.36x
  faster** (277.16 -> 203.25) and the labelled one did not. Both spellings should cost the same, so
  this is 221's pre-existing gap becoming more visible — and a LEAD, since the labelled spelling
  evidently does not reach the path that just got faster. 0 answer disagreements.
  5 mutants, 3 caught + 2 equivalent. **Z1 (return the FIRST bucket instead of the requested type)
  is invisible whenever a vertex has only one edge type, which the bench fixture does** — it takes
  a multi-type fixture, and 51 tests have one.
- **Where the adjacency box CANNOT go, and the rule that says which rows it can reach (323).**
  Priced on its own over 200k vertices / 1M edges: `id -> adjacency -> size` **157.3 ns/edge**,
  `id -> Vertex -> box -> size` **198.6 (1.26x WORSE)**, **box with the vertex already held 79.7
  (1.97x better)**, resolving the vertex alone 22.3. **B is worse than A plus D**, because touching
  two large maps per edge thrashes more than either alone.
  **REFUTED: the ungated `count 3-hop` (84x, the widest ratio in the bench).** It reads the d-side
  degree from the edge's stored ID STRING by a measured choice — "the `c` VERTEX has to be resolved
  when anything reads it… the edge's stored ID is all the `d` side needs (items 140, 218)" — and
  `Edge.to` is an uncached `getVertexById`. So acquiring a vertex here IS route B, 1.26x worse.
  Item 310's diagnosis stands with a mechanism: the CSR at 7.30x remains the only lever.
  **REFUTED: the insert path**, where the vertex IS in hand. `addEdge` already resolves both
  endpoints for `assertValidEdge` and discards them, so threading them into `indexEdgeLabel` was
  free — and **the arm was reached exactly as designed, instrumented not assumed: 80,000 box hits
  against 20,000 misses of 100,000 edges.** `decode ndjson (5 edges/node)` isolated, four
  alternated rounds: **2621.0-2756.6ms against 2670.2-2707.7, overlapping and the min slightly
  worse**, ffi column flat. Reverted with the numbers next to `indexEdgeLabel`. A getter doing
  `??=` is not cheaper than a `Map.get` V8 has optimized, and what dominates that function is the
  INNER per-label `Map`/`Set` work the box never touches (item 312: 810ns across seven hashes, of
  which these are two).
  **THE RULE BOTH SHARE: a cache on an element pays when the element is REVISITED and the caller
  ALREADY HOLDS it.** 321's row has both; the 84x row has neither; the insert path has one, and the
  wrong one. Sort the next candidate by those two questions before writing any code.
- **The adjacency box — 1.207x on `traverse 1-hop + filter` (321), and a cheaper intermediate than
  item 300's CSR.** The adjacency is keyed by a vertex's ID **string** at sites that already hold
  the vertex **object**. Priced over 200,000 vertices before building: a string key **59.7ns**, an
  object-keyed `Map` 30.5, a `WeakMap` 43.8, **a cached reference 16.1 (3.7x)** — and **only a
  tenth of the difference is the hash**, the rest is locality. So `Vertex.adjFrom`/`adjTo`, lazily
  cached, **which is item 162's own pattern** (the label box, for the same reason) and inherits its
  invalidation: dropped by `evict` and `set graph`. Sound because the graph's outer entries are only
  ever `set`, never deleted, and `??=` caches only a box that EXISTS so a zero-degree vertex still
  picks up its first edge.
  **The FIRST version measured nothing, because it changed a function the row never calls.** Item
  311 described the line correctly (`index.get(v.id)` then `.get(type).size`) and
  `Graph.outDegree`/`inDegree` have exactly that shape — but `shortcuts.ts` has its own local
  `degreeOfTypes(index.get(v.id), types)` at four sites, and that is what the row runs. Pointing
  those at the box: `traverse 1-hop + filter` **47.9 -> 39.7ms (1.207x)**, ranges disjoint, the ffi
  column flat at 1.5 both sides, **the gap to native 32x -> 26x**. `count 3-hop` is unmoved and
  that is correct — item 310 put its cost in the degree PRODUCT's two hashes per middle edge, a
  different path, still open.
  The two drives select OPPOSITE maps (near `out ? From : To`, far `out ? To : From`), so each
  site's `boxOf` mirrors its own declaration; the edit was made BY LINE with content asserted
  first, because the near declaration's text appears twice and a textual replace hit the wrong one.
  8 tests, 5 mutants, 4 caught + 1 equivalent. **X2 (`set graph` keeps the boxes) survived first —
  the THIRD symmetric-case gap this session**: `set graph` has no internal caller, but
  `label-box.test.ts:155` and `prop-box.test.ts:97` both do `v.graph = g2` for the other two boxes.
  Also: `expect(v.adjFrom).toBeUndefined()` passes when the property does not exist at all, so the
  positive case is asserted too.
- ~~**A TS-vs-native evaluation-order divergence on a raising operand under OPTIONAL MATCH**~~ —
  **CLOSED by item 322**, and it was the ORDERING KEY's fourth mismatch, not a new semantic
  question. `IS UNKNOWN` lowers to `{ kind: 'isTruth', truth: null }`, which `truthCannotRaise`
  had no arm for (`default: false`) while the engine's `can_raise` admits it — so TS kept written
  order and raised where the engine reordered and dropped the row. **The tell was next to it:
  `IS NULL`, which the key DOES admit, agrees on the identical shape.** The comment that left
  `isTruth` out claimed "a conservative omission costs only a missed reorder"; that clause is
  false and this was the bill.
  **The fix was wrong in the OTHER direction first**: admitting all three truth values created two
  NEW divergences (`WHERE <raising> AND (n.n IS TRUE)` answered no rows in TS while the engine
  raised), because the engine admits only the UNKNOWN form. **Being wider in one engine is the
  same mistake as being narrower.** Caught by MEASURING the test's expectations — a first version
  reasoned out six outcomes and got two wrong, because whether the safe conjunct SETTLES the row
  (not cleanly TRUE) decides whether the raising sibling stays essential.
  `isTyped` and `isLabeled` stay out and that is now measured: `IS TYPED` lowers to a cast which
  `can_raise` calls raising, and `IS LABELED` is TRUE here so it settles nothing.
  Fuzz was red ~1 run in 3 and is now **10 consecutive clean runs**. 5 mutants, 3 caught + 1
  equivalent + **Y5 ("ignore the operand") which needed a shape none of the other eleven
  assertions had** — the test written FIRST with a settling sibling second, so that calling it safe
  makes every conjunct safe and the reorder never fires at all.
- ~~**OPEN, pre-existing, reproducible: the same divergence as recorded at 321**~~ `FUZZ_SEED=1630169971` —
  `MATCH (t:T) OPTIONAL MATCH (t)-[:E]->(n WHERE ((CASE … END = split(duration('PT-2.5S'), -1)) AND
(n.s IS UNKNOWN))) RETURN t.n AS x, n.n AS y ORDER BY x, y` gives **ts `err E_INVALID_VALUE`
  against native `ok` with six rows**. Fails identically on the control, twice. The fuzzer's own
  classifier: _"an evaluation-order difference, but no registry entry covers this shape"_ — the
  raise-parity class of items 139/142/144/145, with `split(duration(…), -1)` as the raising
  operand. Makes `bun run fuzz` red roughly **1 run in 3**. Which engine is right is an ISO
  three-valued-logic question and needs the grammar, not a perf change. **Replaying the seed on
  both sides is what told the difference** between a change breaking the differential and main
  already diverging.
- **What the parse cache left behind, and two follow-ups REFUTED (320).** New ledger from
  `percall_probe` (which gained the shipped entry point as a case, warmed so it measures the HIT
  path): the parse layer **1149ns -> 144ns (7.98x)**, so a serving call is **~1790 -> ~785ns
  (2.28x)** against 318's predicted 2.38x ceiling. `optimize_indexed` is now **43% of a serving
  call** (334ns), up from 19%.
  **REFUTED: caching the OPTIMIZED plan** — item 229's TypeScript twin, whose soundness argument is
  a type (`compile(query): Plan` takes NO GRAPH). The Rust analogue fails twice: `optimize_indexed`
  takes the store all the way down, and — the real obstacle — a cached optimized plan must be
  optimized BEFORE binding, while **every seeding site in `opt.rs` matches `Expr::Lit(v)` and
  extracts a concrete `Value`** (`IndexSeek` holds a `Value`, not an `Expr`; `Expr::Param` is a
  non-seedable operand at all four of its sites). Demonstrated in `prepared_parity_probe`:
  bind-then-optimize gives `IndexSeek { key: "name", value: Str("name7") }`, optimize-then-bind
  gives `Filter { Scan { label: "User" } }`. **A full label scan where the live path seeks — the
  100-300x class CLAUDE.md names, with a correct answer, so nothing in the repo would have caught
  it.** Index selection consumes the bound value; this is structural, not a missing feature.
  **REFUTED: the optimizer's fixpoint is spinning.** Instrumented: **exactly one non-changing pass
  per fixpoint, the minimum one can have** (the final pass IS the termination proof). The serving
  query costs 2 whole-tree passes / 1 changing; a plain scan 1/0; a two-hop count 4/3. The 334ns is
  walking a ~60-variant tree once or twice, not looping.
- **The native engine's parse cache — BUILT at 319, `engine(+)` median 1.327x on `bench:usage`.**
  `crate::parse_cache`: a bounded cache of PREPARED plans keyed on query text, item 228's policy
  down to the cap of 64, wired into both GQL arms of `lnk_query`. Point lookup **259.8k -> 363.6k
  (1.400x)**, fan-out 1-3 hops **1.547x**, cycle detection 1.463x, interleaved write+point read
  1.370x — against the `ts` columns in the same process (a control the Rust FFI cannot reach) at
  **1.003x / 1.000x median**. The all-miss rows read 0.959x/0.966x on an instrument whose control
  column spans 0.964-1.181x.
  **The admission filter had to be REBUILT and the bench said so.** Item 228's `HashSet<String>`
  transliterated made the all-miss row **0.883x** and turned three rows into regressions
  (interleaved write+read 0.969x, write+traversal 0.944x) — because in TypeScript the string
  already exists and the cost avoided is GC retention, while **in Rust the allocation IS the cost**
  (an all-miss call paid two `String`s and four hashes to learn nothing). Rebuilt as a fixed ring
  of text HASHES: all-miss **0.986x**, and those three rows became **1.319x / 1.312x** wins.
  **Porting a policy is not porting its reasons.**
  **Admission VERIFIES rather than carving out**: a text is admitted only if its prepared plan,
  bound to the parameters in hand, renders identically to the direct path's, so 318's INSERT
  divergence excludes itself and so does any future one.
  **THE BUG THAT CHECK CANNOT CATCH, found by the GQL conformance differential**: a now-function
  folds `$__now` into the plan **at PARSE time**, so `RETURN current_date AS d` is not a function
  of its text — and the suite's own sighting order defeats the check, calling it FIRST with no
  clock (both parses agree on `Lit(Null)`, so it is admitted with null baked in) and THEN with a
  wired clock. Fixed as a refusal by shape (`gql::text_may_read_clock`, beside
  `current_temporal_kind`, over-reporting by design). **An admission gate that compares one
  parameter set proves nothing about a parameter whose PRESENCE changes the plan** — 318's
  value-dependence sweep was true and did not cover a compile-time input.
  11 tests, 11 mutants, 9 caught and 2 equivalent. **Two tests were fixed because a mutant survived
  them**: a `max_depth` test whose fixture was shallow enough for both ceilings to accept (it now
  asserts the ceilings DISAGREE first), and a filter-occupancy assertion that hard-coded 40 where
  the ring holds `CAP`, so it failed on a tuning value (item 317's V3/V4 principle).
  **An injection-fuzzer failure along the way was MINE, not the design's**: mutant W7 was living in
  the working tree because the mutation harness had been piped into `head -6`, and SIGPIPE killed it
  between applying the mutant and the next restore — so the harness's own final verification never
  ran either. `CLAUDE.md`'s "restore before the next mutant, never only after the loop" was already
  followed; the kill landed inside the window the rule is about. **Never close a mutation harness's
  stdout early** (`tail` is safe, `head` is not), and **`git diff` before trusting the tree**.
- ~~**The native engine has NO parse or plan cache and the TypeScript one has had both since item
  228 — priced at 2.38x, route-verified, NOT BUILT (318).**~~ **CLOSED by 319 (above.)** `lnk_query` (`ffi.rs:628`) calls
  `parse_with_params_limited` + `optimize_indexed` **on every call**; a grep for
  `parse_cache`/`plan_cache` across the crate finds nothing. **This is the cause of a number
  carried since item 291 without one**: `bench:usage` indexed point lookup is **ts 1.20M ops/s
  against the native engine's 239.9k**, and from `percall_probe` a native serving call is parse
  1163ns + optimize 334 + exec ~300 = ~1797, against the prepared path's clone+bind+optimize at
  **456**. **83% of a serving call re-derives a plan from text it has already seen**, and the
  pieces to stop it already exist (`parse_prepared`, `bind::bind_params`, `prepared.rs`).
  **Verified before designed** (`examples/prepared_parity_probe.rs`): a cache must hold a PREPARED
  plan (`$n` stays `Expr::Param`) rather than a direct one (`$n` substituted to a literal during
  the parse), so the question is whether the two optimize to the same thing. **Ten of fourteen
  shapes are the IDENTICAL optimized plan, in a store with AND without an index on the gated
  key** — every seeding shape included (`= $n`, the reversed `$n =`, inline `{k: $n}`, a range, an
  `IN` list, a two-param AND, a param used twice, a two-hop gate, an aggregate gate).
  Three carve-outs, which are the design:
  1. a param in `LIMIT`/`SKIP` — prepared mode REFUSES, so the fallback is automatic;
  2. **a param in an INSERT value — prepared mode ACCEPTS and plans it DIFFERENTLY**:
     `InsertFrom { input: Row, .. InsertNodeExpr }` instead of the literal `Insert { .. InsertNode }`
     path. Same answer, different operator, **so a cache would route every parameterized INSERT off
     the fast path with no wrong answer to give it away.** Needs an explicit carve-out, not an
     error-triggered fallback;
  3. an unbound param's message differs (`E_MISSING_PARAMETER: …` vs a bare `unbound parameter $x`)
     but **the two shipped paths AGREE at the boundary** — `ffi.rs:1116` sets the code itself
     rather than reading it off the message, so this is NOT an existing divergence. A cache inside
     `lnk_query` must set it explicitly, since the direct arm recovers it by `strip_prefix`.
     **Items 228/229 are the trap list, not just precedent**: an admission filter is load-bearing (a
     write-heavy workload sends unique text per call — `bench:usage`'s append row is
     `INSERT (:Event {name: 'ev${i}'})`), and **saturation hides an admission bug** ("single-use texts
     do not grow the cache" is true either way once the cache is at its cap — assert on the filter's
     own `seen` counter).
- **`gql::parse` at ~1300ns for a 57-byte query (43% of a serving call)** — **1.115x taken at 317,
  still open, and 294's "STRUCTURAL rather than allocational" is WITHDRAWN.** It is allocational:
  **50 allocations and 4187 bytes to parse 57 bytes** (a two-hop count: 80 and 7986), counted with
  a counting global allocator in `examples/alloc_count_probe.rs`. 294 priced the two allocation
  sources visible in the source — the `Vec<char>` pre-pass 60ns, the ~12 identifier `String`s
  177ns — and attributed the remaining 82% to a category. **A remainder is not evidence for
  whatever you were going to say about it.**
  Split (a temporary `usize`-returning hook, since `lex` and `Tok` are private): **`lex` 334ns
  (26%), the descent + plan build 1000ns (74%)** — the entry had them as one lump.
  Resolving the allocation histogram to EXACT sizes names them: **12 of exactly 8 bytes inside
  `lex`** (one per identifier — `b[start..i].iter().collect()` reserves the char COUNT as bytes
  and Rust's first grow for a 1-byte element is capacity 8, so already one allocation each);
  **20 in the descent at exact string lengths (1Bx10, 4Bx4, 5-7Bx5)** — identifier clones, of
  which **ten are the one-byte variable name `u`, cloned ten times for a query that mentions it
  three**; and **7 Vec growth reallocations**.
  **SHIPPED: size the two vectors** (both measured growing — 3 for the char pre-pass, 4 for the
  token vector). `gql::parse` **1297 -> 1163 ns (1.115x)**, parse+optimize 1.099x, allocations
  **50 -> 45**, bytes **4187 -> 2779**; on the corpus `query_bench -- plan` reads **1.169x / 1.146x
  / 1.113x** with its `gremlin 2-hop` row — a control the change cannot reach, since the production
  Gremlin path never calls `gql::lex` — moving the OTHER way. All ranges disjoint.
  **294 declined the char-vector line ALONE at 34ns / 2.6%, and that was correct for what it
  measured**: nothing had counted the token vector's four reallocations. **A line priced in
  isolation and declined is not the same fact as the change it belongs to.**
  **DECLINED at its ceiling, 6.3%**: a keyword-classifying lexer. The descent performs **74
  keyword comparisons** for an 18-token query (62 for a 10-token one — mostly fixed), which looks
  like the answer and prices at **84ns** for all 74.
  **Two more suspects eliminated by counting rather than assuming**: `bump()` clones every token it
  consumes, but only **5** carry a String; and `plan.clone()`, the whole output tree re-allocated,
  is 9 allocations and 60ns.
  **STILL OPEN, now with a count**: the descent's **20 identifier clones** and `lex`'s **12**.
  294's `Tok<'a>`/`Ident(&'a str)` route is confirmed from the other side — the 12 are already one
  allocation each, so only borrowing touches them, and it forces the `Vec<char>` indexing out at
  the same time — but it addresses the lexer's 12 only. **The descent's 20 are a separate change,
  into the IR's owned `String` fields, and they are the larger half.**
- ~~**Hoisting `takeResult`'s per-call `new BigUint64Array(1)`**~~ — **REFUTED at item 292 before
  being built: the allocation costs 0.4ns**, below the 4.9ns floor of calling an empty closure,
  because the JIT elides it. It looked free and obvious, which is exactly the case `CLAUDE.md`
  names: _"obviously correct so it must be faster" is not evidence._
- **A cap over a SHARED-VARIABLE join** (`Join { on: [(1, 1)] }`) — **PRICED AT ~1.7x AND NOT
  WORTH BUILDING**, measured at item 289 right after item 288 closed the empty-`on` case. The
  shape is real and the cap does nothing: `MATCH (p:P)-[:KNOWS]->(q) MATCH (r:P)-[:KNOWS]->(q)
RETURN p.k LIMIT 1` costs **2519.6 us** against the uncapped join's 2738.2 — the cap buys 8% —
  because `pull_capped` has no non-empty-`on` arm, falls to `_ => None`, and `streaming_chain`
  has no `Join` arm either. Plan confirmed: `OrderPage { Project { Join { Expand, Expand, on:
[(1, 1)] } } }`.
  **The FLOOR is what kills it.** Capping the SIDES is unsound (the first `cap` output rows can
  need arbitrarily many left rows, since most may not match — the `Expand` argument), and a
  blocked nested loop is asymptotically wrong for an equi-join (O(|L| x |R|) comparisons against
  the hash join's O(|L| + |R|), i.e. 4e10 here). So the only sound bound builds the RIGHT index —
  which needs the whole right `Expand`, measured at **1187.5 us** on its own — and then streams
  the left probing until `cap`. Best case ~1400-1500 us against 2519.6: **~1.7x**, for a new
  row-producing exec path with item 282's full verification budget. Item 288 got 204-316x for the
  same budget because its floor was a 7 us id-vector pull, not a 1187 us expand.
  Re-open only with a design that avoids building the right index at all.
- **`addVertex`** — the single target behind the three `bench:usage` rows TS loses, all a 3.7x
  constant factor (§1). Reopening means arguing with item 203's conclusion, with numbers.
- **The TS query surface above 5x:** item 197's closing line said there was nothing. One case
  is now measured — an UNINDEXED filtered count is ~27ns a vertex against native's ~1.6ns
  (16.7x), and within TS an ORDERING comparison costs **1.64x an equality on the same count**
  (49.9 against 30.5 ns/vertex, the selective spelling so the answer size matches). Cause:
  `directEqProps` lifts only `=` element-locally and everything else reads through the binding
  `Map`. **PRICED AND DEFERRED at item 276, not refuted** — the lift was built and retracted
  because "this predicate is empty" is spread across NINE hand-written presence checks
  (`executor.ts` 1033/1038/1133/1140/1159, `matching.ts` 247/362/608/1395), four of them node
  fast-path gates where missing the new field expands UNFILTERED — a silent superset, the
  mistake `rel-inline-pred.test.ts` exists for. **DONE at item 278**, once item 277's
  `hasPredicate` existed: wiring the field broke THREE tests before the helper and ONE after,
  because extending the helper covers all seven gates at once. Delivered **1.44x** broad /
  1.32x selective / 1.19x on `>=`, i.e. about HALF the predicted 1.64x — a ~1.26x residual
  remains from `compareTruth`'s dispatch and type checks against `structuralEq`'s direct
  path, and `<>` gains nothing (1.01x) because it routes through `structuralEq` like `=`.

---

- **An endpoint LABEL cost a var-length aggregate 2.19x — or the whole query — and the peel that
  fixes it already existed on the count twin (374).** `try_varlen_agg` folds `sum`/`max` during the
  DFS but matched `Plan::VarLength` DIRECTLY, and `(b:Person)` lowers to a `Filter` ABOVE the hop
  (`IsLabeled` on the endpoint slot the fast path already requires), so the fold was taken for
  `(b)` and declined for `(b:Person)`. `peel_endpoint_filter` was already in the same file and
  already called by `try_varlen_count` — applied to the twin that was being looked at and to
  neither other, which is 367/368/370 a fourth time. **The 200k row is the one to remember: the
  labelled spelling did not merely cost more, it hit the trail ROW CAP a fold never reaches and
  raised `E_RESOURCE_EXHAUSTED` where its twin returned an answer** — equivalent spellings
  differing in whether the query can complete, not in cost. **Two implementations were REFUTED
  first and must not be re-attempted**: `until_ok` per reached endpoint (its `IsLabeled` arm is a
  label-string hash plus a binary search over the whole bucket, EVERY endpoint) at **1.83x worse
  than not peeling**, and the same with the bucket hoisted out, still **1.22x worse**. Only the
  tautology-plus-bitset shape the general evaluator already uses (E78) wins. **And the benchmark
  was measuring the wrong thing**: `social_store` labels every node `Person`, so the label is
  VACUOUS and the general path short-circuits it to free — a fold carrying a real test was being
  compared against a filter that costs nothing. CLAUDE.md's same-label-fixture trap arriving as a
  misleading PERF number rather than a hidden wrong answer; the fix needs a MIXED fixture to be
  measured honestly and a mixed fixture to be TESTED at all (every assertion passes with the guard
  deleted on a uniform graph). Still open in the same family: `try_varlen_distinct_count` and
  `try_varlen_distinctby_count` decline their own shapes even unlabelled, and
  `try_frontier_prop_agg` takes `max` but declines `sum`.
- **The aggregate fast-path chain is fully reachable, and the corpus builds no indexes (374).** All
  28 entries instrumented over the ~1,200-case `gql_corpus`: **every entry is CALLED**, so item
  371's shadowing is not chain-wide, but **10 never hit**. Handing each one a query written to its
  own gate separates the causes — four are alive and merely uncovered (`try_indexed_min_max`,
  `try_indexed_distinct_count`, `try_3hop_product_count`, `try_join_product_count`), one is item
  47's documented flattening, and the rest were the var-length family above. **The corpus creates
  no indexes at all**, so the index fast paths from items 369 and 371 are guarded by their unit
  tests alone. Use `tests/gql_corpus` for this question, not a scrape — item 372 took the machine
  down twice running a scraped corpus uncapped, and the curated one runs in 7.15 s under the cap.

- **A bare `Scan` is a trivial frontier, so `try_frontier_prop_agg` was answering scan `min`/`max`
  at 6.4x the columnar fold — 1.66x recovered, and the obvious fix was a net LOSS (375).**
  `try_scan_num_agg` gated on `Sum | Avg`, `try_frontier_prop_agg` on `Min | Max`: **the aggregate
  set was split across two fast paths and each covered only half of it**, so for any one shape one
  half was fast and the other fell through. Fixed by giving the columnar entry `Min | Max` AND
  moving it above the frontier path — **both halves are load-bearing**, since a gate alone stays
  dead below a path that claims the plan (item 371, pre-empted this time instead of discovered by
  an `eprintln`). **DO NOT instead add `Sum` to `try_frontier_prop_agg` while it sits earlier in
  the chain**: that diverts scan `sum` into it, buying 2.5x on hops with a 6.4x regression on
  scans. Chain position is part of the change. Also refuted: sharing ONE loop body between the two
  folds behind an `is_extremum` test taxed the `sum` control **1.09x** — splitting them restored
  parity and made `max` faster still, because the branch cost both folds. **The 1.66x is the
  ceiling, not the 6.4x**: `sum` auto-vectorizes, min/max calls `cmp_num_total` through an
  `Option`; recovering the rest needs a hand-rolled NaN-sorts-last `min`/`max`, declined because
  `-0.0` is where reimplementing the value contract diverges first.
- **`-0.0` vs `0.0` in min/max is a real inter-path difference and an UNOBSERVABLE one — do not
  "fix" it (375).** `cmp_num_total` rates them EQUAL, so every fold keeps whichever it visited
  first, and different paths visit in different orders. A bit-comparing differential test sees the
  disagreement; nothing else can, because the JSON egress renders both as `0` (pinned by
  `json.rs`'s `(-0.0, "0")`, matching `JSON.stringify(-0)`). The value model's "there is no
  negative zero" is kept at the boundary where it is observable, not in the fold. Checked because
  the differential fuzzer DOES generate `-0.0` and that area caused a native-vs-TS divergence once
  before. **Genuinely open, and narrow:** a stored `-0.0` survives the write path (nothing collapses
  it on the way IN) and columnar reads never pass through `num_of`, so the sign would become
  observable through any egress that preserves it.
- **`try_varlen_distinct_count` / `try_varlen_distinctby_count` declining a `{1,2}` trail is
  CORRECT — retracted as a target (375).** `set_reachability_is_exact` permits a `Trail` only at
  `max <= 1`: the BFS computes WALK reachability, and a node reachable only by re-crossing an edge
  belongs to the walk set and not the trail set. That is item 68, found by `fastpath_fuzz` at seed 3249. Item 374 listed these as open gaps; they are not, and "fixing" them re-introduces a
  fuzzer-caught wrong answer.

- **A frontier `sum`/`avg` fast path is REFUTED — the 2.5x is the price of byte-identity, and the
  refutation was already written on the function (376).** `try_frontier_prop_agg`'s own doc says it:
  "MIN/MAX only: they are order-INDEPENDENT, so collapsing the frontier to per-node multiplicity
  (which loses row order) is byte-identical; SUM/AVG would change the summation order, so they stay
  on `try_frontier_aggregate`". Floating-point addition is not associative, so **do not re-price
  frontier `sum` as a target.** What IS available is `count(k)`, because an integer count is
  order-independent — shipped at **2.20x (50k) / 2.68x (200k)** as `try_frontier_count_prop`, any
  column type, folding the `present`-masked multiplicities the same way `try_frontier_count`
  already folds `count(*)`. It ends up faster than `min`/`max` on the same shape: a count touches
  only the `present` mask, never the values.
- **An instrument that covers PART of the dispatch reports absence where it only has no coverage
  (376).** Item 375's dispatch probe called `1hop sum` and `1hop count(prop)` "no fast path; general
  aggregate". Both were wrong: `try_frontier_aggregate` sits in a later `else if` branch OUTSIDE the
  28-entry `or_else` chain that was instrumented, and its `frontier_ids` "is produced in the same row
  order the full batch would have". Item 371's "verify the dispatch reaches the function" needs the
  corollary: **verify the instrument reaches every branch that can answer.** The measured gap was
  order-preserving materialization vs the counts collapse, not fast-path vs none.
- **Chain position is part of the change — hit a THIRD time, in the region item 375 had just
  reordered (376).** 375 moved `try_frontier_prop_agg` ahead of `try_scan_count_prop`, so adding
  `Count` to the frontier path would have stolen bare-scan `count(prop)` from the path built for it.
  The new arm went in as its own entry AFTER the scan twin. Its explicit bare-`Scan` decline is
  **unreachable as the chain stands** and was priced at 25.6 vs 23.8us (50k) / 93.0 vs 93.9us (200k)
  — noise both ways, so the gate is about ownership, not speed. Kept anyway (this region gets
  reordered) and **pinned by a direct assertion**, which is what then caught the mutant that deletes
  it; no behavioural test can, since both paths return the same count.

- **A 5-hop `max` OOM-KILLED the TS engine where native answered in 38 ms, and the TIME was a
  different bug from the MEMORY (377).** Item 297 made `count(*)` O(groups) and recorded what it
  left: the foldable aggregates "need partial state plumbed through `compileAggregate` — and the
  accumulator must fold the array path too". Done here for the three that are PURE left folds —
  `count(arg)`, `min`, `max` — with the array path **defined in terms of** the accumulator, so
  byte-identity is structural. Under a 4 GB cap, 4.86M paths x ~640 bytes a path: TS `count(*)`
  20 ms/156 MB, TS `sum` **killed (137)**, native **38.2 ms**. That is item 373's class with the
  engines swapped, and no differential fuzzer can find either, because the run that would report it
  never finishes. **The lesson worth more than the fix:** removing the retained bindings left the
  1-hop TIME untouched at 534 ms against 538 — a scalar aggregate has ZERO grouping keys, so every
  row was paying `JSON.stringify([].map(...))` to produce the constant `'[]'`. Hoisting that is
  where the speed came from, and it helps even the aggregates that still keep their bindings
  (`sum` 1.21x), which proves the two costs were independent. Min of three, controls (the
  PROJECTION of the same rows, and `count(*)`) flat: scan `min` 1.72x, `max` 1.50x, `sum` 1.49x,
  `count(prop)` 1.46x; 1hop 1.21-1.27x; 5-hop `max` OOM → 3380 ms at 234 MB.
- **DONE for `min`/`max`/`count(arg)`, 5.2-5.9x (418).** `detectHopAggregate` folds ONE foldable
  aggregate over exactly the rows the fused hop projection already walks: 698.8 -> 134.5 ms for
  `MATCH (a:P)-[:E]->(b) RETURN max(b.k)`, three alternated rounds, every control a refused shape
  and flat. It REUSES `detectHopProjection`'s walk via a synthetic one-item projection rather than
  growing a fourth inner loop, because item 159 priced that at 1.6x (a branch) and 1.29x (a shared
  walk) — so it stops at the projection's cost, not at the hand-written floor. **377's 29x headline
  did NOT reproduce: the real gap was 6.4x**, its control running at 18 ns/row where the same
  control now runs at 143, and its 24.5 ms hand-written floor measures 130 ms here. Also refuted in
  passing: the 2.2x "projecting the start costs more than the far end" asymmetry is item 167
  restated — the far-side control's `:P` is VACUOUS, which routes it to the far-driven walk, and
  with a non-vacuous start label the asymmetry REVERSES (near is 1.3-1.4x better).
- **NATIVE: a scan `min`/`max` over a STRING column had no columnar fold — DONE, 14.5x dict / 1.8x
  plain (421).** `try_scan_num_agg` gates on `Column::Num` and declines the rest, so `max(n.s)` was
  5.4-6.0x the numeric fold and **21-23x the `count` over the same column**. `try_scan_str_agg` adds
  a `Str` arm (fold `GStr::cmp`, no row materialization) and a `Dict` arm that compares NO strings
  per row — pass one marks which codes appear, pass two takes the extremum over `dict`, so the cost
  is `dict.len()` comparisons instead of one per row. 200k: 2.378 -> 0.168 ms dict, 2.388 -> 1.420
  plain; 1M: 12.008 -> 0.815 and 12.183 -> 6.875. Placed beside the numeric arm ABOVE
  `try_frontier_prop_agg` for item 375's reason (a bare `Scan` is a trivial frontier, so an arm
  below it is dead). The diagnostic that decided the design: a 97-value dict column and a
  200,000-value plain one cost the SAME before this, which is what no encoding awareness looks like
  from outside. Six mutants, all caught. **Named coverage gap: the differential fuzzer reaches the
  `Str` arm (`genExpr` emits a bare `n.s`) but NOT the `Dict` arm** — its six-node fixture has six
  distinct `s` values and measures `dict=false`, so the dictionary path's cross-engine parity rests
  on the unit test alone.
- **DONE for the fault-free case, 1.96-2.09x (427).** `CProjection.cannotFault` (a structural
  allowlist: bare variable, single-level property read, literal, plus `RETURN *`) licences
  `pagedFaultFreeRows` to skip the BINDINGS and project only the page. 48.6-52.4 -> 25.1-27.2 ms,
  and every variant lands on the **25.6 ms general-stream floor item 426 measured**, so it is the
  whole projection overhead and not a part of it. The faulting shapes are untouched and still
  fault exactly as native does, so byte-identity holds and item 426's conformance question stays
  open and unprejudiced. Extracted to a module-scope helper because the complexity cap objected at
  38/35 — same cap, same answer as item 377.
- **DONE: the n-hop chain sweep now flips for a LABEL, not only a GATE — 4.26x at four hops, 3.09x
  at five (429).** `detectNhopSweepCount` read a chain backwards when its last position was GATED
  (item 308) but was blind to a LABEL there, so `MATCH (x)<-[:E]-…<-(a:P)` seeded every vertex
  where the forward spelling seeded the `:P` bucket. Decided per call by
  `candidateCount(end) < candidateCount(start)` — `hopDrivesFar`'s question, strict so a tie keeps
  the forward reading and so a non-seekable label scores the whole graph. 779.8 -> 183.2 ms and
  911.1 -> 295.2; the reversed spelling now LANDS ON the forward one, which is the claim. Controls
  flat: vacuous end label, no end label, and both of item 308's gated cases.
- **A probe's threshold is a budget for what it interrupts you about, not a claim that everything
  under it is fine (429).** `bun run spelling` reported 0 answer disagreements and one known-guard
  over-2x group — and PRINTED the 1.49x four-hop and 1.27x five-hop asymmetries every run. Also:
  five TS planner changes this session before anyone ran the probe the repo mandates for exactly
  that. Run it after touching the planner, and read the rows, not only the flags.
- **A fixture for a COST-BASED decision has to make the decision fire (429).** The leg-order mutant
  survived three times: equal label counts meant the strict comparison declined, then the label and
  direction sequences it saw were palindromic, and finally — the real reason — every case was a
  3-hop chain, which `try_3hop_product_count` owns. **The sweep starts at FOUR hops.** Fourth
  fixture this session that did not exercise its guard (422, 425, 427), and the first where the
  cause was the query being routed to a different path entirely. **Check which path answers your
  fixture, not just what it asserts.**
- **DONE: the 3-hop chain's end LABEL now routes to the sweep — 11.8x reversed, 3.67x forward, both
  spellings on ~95 ms (430).** `threeSegmentCount` is a degree product and `longChainCount`'s doc
  already said why it cannot help: "the sweep VISITS each one, so there is a once-per-element place
  to test it, which is what the end positions of the degree products lack." Item 306 acted on that
  for a GATE and left the LABEL on the product, which enumerated to test it: 1128.6 -> 96.0 ms
  reversed, 346.3 -> 95.5 forward. `threeSegmentRoute` builds both and chooses per call on whether
  either end narrows the seed; a TIE keeps the product, which is item 301's measured winner for the
  unfiltered shape (250.1 against 374.9). Controls flat: vacuous labels on both ends, item 306's
  gated route, 4 and 5 hops, one hop. Extracted to a helper because the caller tripped complexity
  41/35 AND max-statements 81/80.
- **DONE on the NATIVE side: the 3-hop product now peels a PER-HOP direction — 2.68x all-`in`,
  3.41x mixed (432).** `peel_out_hops` hard-required `Dir::Out`, so a reversed chain declined the
  product and fell to enumerate-and-tally. The reason was a COMMENT — "the 3-hop product's identity
  really does want one orientation, since its `level1`/`outdeg3` arrays are both built from
  `store.out`" — which was an observation about the code mistaken for one about the identity: the
  product's three terms each read a DIFFERENT hop's adjacency, so each may independently be `out`
  or `inc`. 15.6 -> 5.8 ms all-`in`, 14.0 -> 4.1 mixed (a NEW capability — mixed declined the
  product outright before). On the RING layout the reversed 3-hop is now 3.2 against the forward's
  3.1, **symmetric**, so what remains on scatter is item 431's locality and nothing else. Controls
  flat at 2 and 4 hops (the product is 3-hop only) and on all-`out`. `Dir::Both` still declines.
- **AN ORACLE IS A PROPERTY OF THE ENGINE, NOT THE QUERY TEXT (432).** The first mutation run had
  **five of five survive** a test asserting 32 direction combinations agree with `count(*) + 0` —
  which is a different route in TS (620.5 ms against 138.6) and **the same route in native**. An
  `eprintln` at the product's entry showed it firing 8 times per pattern where 4 was expected: the
  test compared the product with itself. `count(d)` fires it too; `count(d.k)` does not. Item 371's
  rule is "verify the dispatch reaches the function" — this is its mirror, **verify the oracle does
  NOT**, and the trace that settles it is three lines.
- **The TS side of item 431 is REFUTED — its product already carried per-hop directions (433).**
  `buildThreeHopCount` has `toAOut`/`midOut`/`fromDOut` and picks `edgesFromByLabel` or
  `edgesToByLabel` per leg, which is exactly the generalization item 432 had to make in Rust;
  `longChainCount`'s doc even dates it ("the pure-TS sweep, which has carried per-hop directions
  since item 298"). So item 431's one asymmetry had **two different causes, one per engine** —
  native was missing a path, TS never was. After 432 both are SYMMETRIC on the ring layout (native
  1.03x, TS 1.14x) and both keep an asymmetry on scatter (native 1.76x, TS ~1.32x), so the residual
  in both is the scattered-`inc`-bucket locality item 431 isolated. 431 is closed.
- **When one engine DECLINES a shape the other accepts, the one that accepts it is the
  specification (433).** Native's comment explained why the 3-hop product could not carry per-hop
  directions while the TS product had carried them since item 298. The session's habit is to fix TS
  and then ask native the same question; here the question should have gone the other way, and
  twelve items passed before anyone looked. Not a second opinion to be confirmed — a reference. `chain-layout-probe` (`bun run probe:layout`) varies ONE thing — where
  each edge points — over two graphs of identical size and degree, and asks both engines through
  one shared edge list. **Not locality:** the layout halves the magnitude (TS 3-hop forward 170.3 ->
  49.3 ms for the identical query, a 3.5x belonging entirely to the data) but the asymmetry survives
  at 1.23x TS / 2.06x native. **Not a TS quirk:** native's ratio is BIGGER, 4.67x (3.3 -> 15.4 ms)
  against TS's 1.70x. **It peaks at THREE hops in both** — 2 hops 1.03x/1.42x, 4 hops 1.28x/1.60x
  (1.00x on the ring), 3 hops 1.70x/4.67x — and three segments is the ONLY depth the degree product
  owns (two has its own walk, four+ is the sweep). Next: the NATIVE product, the bigger ratio.
- **CORRECTION to item 430: there is NO 2-hop asymmetry (431).** 430 reported "1.68x already at two
  hops" from four shapes in one process behind a 1-hop warmup that warms nothing (it has a count
  shortcut). The pair SWAPPED which side was slower between two runs of the same binary
  (40.9/68.6, then 68.8/42.8). Isolated per process it is 1.03x. Fourth occurrence of this
  mechanism this session (420, 421, 423) and the first where it manufactured a DIRECTION rather
  than a magnitude.
- **A probe's SIZE is part of its question (431).** `chain-depth-probe` already swept depth in both
  engines with a reversed spelling and was the obvious host for this — and is the wrong one: 200
  nodes at degree 5 is entirely cache-resident, so it cannot show a locality effect at all. Keeping
  it small is what lets it reach eleven hops; the layout question needed 200,000 and its own file.
- **Three of four routing mutants SURVIVE because both routes are correct (430).** always-sweep,
  always-product and an inverted comparison all leave every test green; only dropping the
  `interiorPred` guard — which LOSES a clause `WHERE` on the way to the sweep — is caught. **A
  cost-based route choice is justified by its measurements and by nothing else**, which is now
  written on the function (and is item 429's division of labour, with the mutants to prove it).
- **The NATIVE paging twin is REFUTED — it already pages lazily (428).** At 1,000,000 nodes a
  shallow `SKIP 100 LIMIT 20` costs **0.001 ms** and a deep `SKIP n-5` costs 2.556, against a
  10.403 ms ceiling for projecting every row — so native pages the input stream, and the deep
  figure is the unavoidable million-row walk. The width-dependence (2.556 one property, 4.884 two)
  is the stream carrying two columns, not projection of skipped rows. `skippage_428` committed.
- **SCOPE CORRECTION to item 427: its 1.96-2.09x is DEEP pages only (428).** All four of its
  targets were `SKIP 199995` out of 200,000. The TS **shallow** page measures 0.2 ms before the
  change and 0.1-0.2 after — `skip`/`take` are lazy generators, so it always stopped after ~120
  bindings. The win is real for offset pagination deep into a large set and for export cursors,
  and costs nothing elsewhere, but a reader of 427's line would wrongly expect `SKIP 100 LIMIT 20`
  to be 2x faster. **A ratio is only as good as the shape it was measured on, and "four shapes"
  sharing a parameter value is one shape.**
- **Walking a row costs native 2.6 ns and TS ~125 ns — 48x, on a third independent shape (428).**
  25.1 ms for 200,000 bindings against 2.556 ms for 1,000,000. Item 377's per-row `Binding`, now
  priced on paging as well as on aggregates and top-k. Not a new target; 377 is bigger than
  anything paging-shaped.
- **A harness reporting a false SURVIVED reads as a missing test (427).** A `$F` inside a
  double-quoted `perl` block was expanded by the shell, so three of six mutants were never written
  to the file and were reported as survivors; one line of output said `Can't open $F`. The mirror
  of item 398 (a false CAUGHT reads as teeth). **Every mutation script now compares the file
  against the pristine copy before believing a verdict** — three lines, and without it a clean
  mutation run means nothing.
- **A `SKIP` projects the rows it SKIPS, in BOTH engines, against the engine's own stated rule
  (426).** `applyProjection`'s generic tail pages the PROJECTED rows, so `RETURN a.u AS s SKIP
199995 LIMIT 5` projects 200,000 to return five: **48.8-51.3 ms against the ORDER BY spelling's
  35.5, so adding an `ORDER BY` makes it 1.45x FASTER.** The ordered path keeps top-k INPUT
  bindings and projects only survivors (item 145). The obvious fix is a BEHAVIOUR change: a skipped
  row's projection can fault, and `skipcast_426` shows `CAST(a.s AS INTEGER) AS x SKIP 1 LIMIT 1`
  faulting on a row it cannot emit while the `ORDER BY` spelling returns 1. **Both engines agree on
  all four spellings** (checked natively, not assumed), so it is a conformance question against the
  rule "project exactly the rows you emit" — the project's call, like item 417, and invisible to a
  differential fuzzer for the same reason. NOT changed. The route that IS available inside the
  current semantics: a conservative cannot-fault check on the projection, which would licence
  skipping bindings; own item.
- **A floor measured on a different PLAN is not a floor (426).** Item 425 priced its remaining gap
  against the `max(a.u)` fold, which since item 420 runs on `detectNodeProjection`'s fused scan —
  a different row-production path from `applyProjection`'s general binding stream. Attribution with
  a CONSTANT sort key (`ORDER BY 1 LIMIT 5`, all ties, heap never evicts) puts **25.6 of the 35.5 ms
  in the general stream plus the loop**, leaving ~10 for key evaluation and 200,000 comparisons. So
  425's "remaining half" is item 377's per-row `Binding`, not the top-k's.
- **DONE: the TS single-key top-k has its own heap, 1.34-1.50x across six shapes (425).** For
  `orderBy.length === 1` — the common spelling — `applyProjection` now uses parallel
  bindings/keys/index arrays with the sort flags destructured once, removing the `map` generator,
  the one-element `keys` array and its per-comparison index reads, and the
  `orderBy[i].descending`/`nullsFirst` loads the generic `cmp` repeated on EVERY comparison.
  `ORDER BY u LIMIT 5` 49.6 -> 37.1 ms, `LIMIT 5000` 1.50x, `DESC` 1.50x, `SKIP 10 LIMIT 5` 1.41x,
  numeric key 1.34x, input-property spelling 1.43x — five alternated rounds at NINE reps (424:
  three is a coin flip here). Controls flat over three rounds including the two-key orders, which
  still run the generic heap. **Still open: 37 ms against the `max` fold's 20.7** over the same
  rows, so about half of 424's 182-ns/row gap remains unattributed.
- **"I wrote the fixture for this guard" is not evidence it exercises the guard; removing the guard
  is (425).** The mutant dropping the top-k's arrival-index tiebreak SURVIVED a fixture built with
  heavy ties for exactly that purpose: with ties and no eviction `up` never swaps, the heap array
  stays in arrival order, and an all-equal comparator leaves a stable sort alone. The tiebreak is
  only observable once evictions have PERMUTED the array (`d = [9,9,9,2,2,2,5,5,2]`, `LIMIT 3`).
  Second time this session (422 was the Dict `present` mask). The eviction-test copy of the same
  tiebreak is provably equivalent and documented as such.
- **REFUTED: removing the TS top-k's per-row allocation. 2.4%, and "it allocates per row" is not by
  itself a cost in this engine (424).** `boundedTopK` builds a `{ v, i }` wrapper for EVERY input
  row — before the test that throws it away — so 200,000 objects are allocated to answer a
  `LIMIT 5`. Parallel arrays instead measured **50.1 -> 48.9 ms, five alternated rounds at nine
  reps**: V8's young-gen bump allocation is near-free and the array indirection costs back most of
  the saving. The same arithmetic prices the other two per-row allocations on that path (the
  `{ b, keys }` wrapper and the `orderBy.map` key array) at ~5%, also under the floor. Rejected and
  recorded ON the function. **The top-k itself is NOT missing** — 50.1 ms against 485.1 unlimited
  is 9.7x, the cost climbs with k, and the alias and input-property spellings agree.
- **A bimodal shape makes a min-of-three A/B a coin flip (424).** The first A/B of the above read
  58.0 -> 86.1 (a 1.48x REGRESSION) and the next three rounds gave pristine 55.3/54.6/95.0 against
  new 91.9/54.0/50.7 — both sides bimodal at ~50 and ~90-95 ms from the same two builds. Nine reps
  collapsed it to 2.4%. The tell is **the two modes appearing on BOTH sides**; `ts-spelling-probe`
  already runs at `SPELL_REPS=9` for this reason.
- **Still open: the TS `ORDER BY … LIMIT n` shape costs 50.1 ms against the `max` fold's 20.7 over
  the same rows (424)**, 145 ns/row, cause NOT identified and NOT allocation. Suspects left: the
  generator layers into `boundedTopK`, the per-row-per-key `{ binding, params, graph }` env object,
  and `compareSort`'s wrapping of `compareValues`. Measure at nine reps.
- **The TS string comparator is REFUTED as a target at 12%, and 421's dictionary trick has NO TS
  twin (423).** `grep -rn dict packages/core/src/` returns nothing — the TS core stores properties
  as frozen JS objects, not columns, so there is no small distinct-value set to fold over and the
  14.5x half of 421 is native-only by construction. What remains is `compareValues`, which for a
  string pair runs ten statically-false type checks before `compareCodePoints`; isolated per
  process, string `max` minus `count(a.s)` over the same rows is **2.3 ms at 200,000 rows — 11
  ns/row, 12% of the query**, and numeric `max` minus `count` is NEGATIVE. Under the repo's own
  10% rule, refuted before any code.
- **A ratio between two cases in ONE process is not a ratio (423).** Item 420 reported its string
  aggregate at 25.8 ms against a numeric 11.1 and explained the gap as the comparator. The same
  binary, isolated per process, gives string 19.2 against numeric 16.2 — and in a full bench reads
  14.9 against 18.0, the opposite ORDERING. Third occurrence this session (420 inflated a control,
  421 flattered a baseline, 423 reversed an ordering) and the first where the figure was then used
  to explain a mechanism. Isolate both sides, or do not draw a mechanism from the gap.
- **The FILTERED-scan string twin is DONE, 4.0-4.3x — and fixing one spelling and not its siblings
  IS the asymmetry (422).** `Some(Column::Num { .. })` appears on twelve lines of `fastpath.rs` /
  `aggregation.rs`, two of them the other spellings of the question 421 made 14.5x faster, so 421
  left ONE question costing three different amounts: scan 0.796 ms, filtered 7.412, hop 14.172 (1M,
  dict). `try_filtered_scan_str_agg` takes the filtered one to 1.865 ms — now FASTER than the
  filtered NUMERIC fold (2.367), because the dictionary does 97 string comparisons where the numeric
  arm does a million `f64` ones. Controls flat including the hop arm across six runs, which is the
  evidence it is untouched.
- **The HOP string min/max is PRICED AND LEFT, not forgotten (422).** `try_frontier_prop_agg` folds
  per-node path MULTIPLICITIES, and item 376's rule for which aggregates may do that has to be
  re-read for a dictionary first. The string gate's share there is only 1.5x (14.172 against the
  numeric 9.372) — most of that cost is the hop — so it is a small prize for the care it needs. A
  filtered scan has no multiplicity, which is why that one was the same fold over a different id
  list and this is not.
- **A fixture built to exercise a guard must be checked against the guard's REMOVAL (422).** The
  mutant dropping the Dict arm's `present` check survived: every absent slot it wrongly read named
  `dict[0]`, already among the survivors, so no answer changed. The leak needs a survivor that is
  ABSENT _and_ a `dict[0]` the filter excludes. Second time in three items a surviving mutant found
  something other than a missing test — 420 refuted a comment, this refuted a fixture.
- **Contamination can flatter a baseline as well as inflate a control (421).** The 1M projection
  control read 1.52x WORSE on disjoint ranges; in its own process both sides measure ~17.8 ms. The
  OLD figure (10.7-12.5) was the wrong one — the three string aggregates ahead of it materialized 1M
  rows each and left a warm allocator arena the projection reused. Item 420 saw the same mechanism
  inflating a control; both directions now say the same thing: **isolate the control before writing
  down a movement.**
- **The SCAN twin is DONE too, 3.1-3.4x (420).** `detectNodeAggregate` folds one foldable aggregate
  over the rows `detectNodeProjection` already scans: `MATCH (a:P) RETURN max(a.k)` 35.2 -> 11.1 ms
  at 200,000 vertices, `min` 3.4x, `count(arg)` 3.1x, filtered 2.4x, unlabelled 2.5x, strings only
  1.6x (that cost is `compareValues`, which both paths pay). **Two refused controls appeared to
  regress — `sum` 1.28x on disjoint ranges — and both were CONTAMINATION.** A DEAD arm (the code
  present but never dispatched) matched OLD, ruling out file layout; running the control in its OWN
  process showed it unchanged (43.0/42.8/44.9 against 42.6/43.8). **A control sharing a process with
  a target that got 3x faster is no longer the same measurement** — the heap and GC state it meets
  changed. New rule for the bench list: when a control moves and the dead arm matches, isolate the
  control before writing down a regression.
- **A surviving mutant can refute a COMMENT as well as a test (420).** Dropping the AST `GROUP BY`
  guard survived, which disproved the comment justifying it: `compileProjection` sets `groupKeys` to
  the compiled GROUP BY EXPRESSIONS whenever any are written (falling back to the non-aggregate
  items only when there are none), so the compiled check already catches every written GROUP BY. The
  same false claim was in 418's `detectHopAggregate`, committed two items earlier with its own
  mutation run; both corrected. The guards stay, because the synthetic projection sets
  `groupBy: undefined` and hides a GROUP BY from every check further down.
- **The TS hop `sum`/`avg` is REFUTED, with a value difference, not deferred (419).** 377 deferred
  them for the `temporalSum`-before-array PRECEDENCE; that is real and is not the blocker. The
  fused walk's far-driven route visits rows in a DIFFERENT order than the general path — measured,
  `[1,1,3,3,5,6,7]` against `[5,3,1,6,7,3,1]` — and a float sum folded in each order returns
  `2.0000000000000000e16` against the engine's `2.0000000000000004e16`. This is item 376's native
  refutation (`try_frontier_prop_agg`: "MIN/MAX only ... SUM/AVG would change the summation order")
  holding on the other engine. The start-driven route's order IS identical, so `sum` would be
  admissible there — declined anyway, because the route is picked at RUN time by `vacuousLabel` and
  testing vacuity from outside to decline is item 411's trap (a run-time decision re-estimated
  elsewhere), and because that order equality is observed, not promised. **The rule: an
  order-dependent aggregate cannot take a fast path that may reorder rows, and every fast path in
  this family may.** 418 is safe by construction rather than by careful guards — its admission set
  is `foldFor`'s, which returns a fold only for `count`/`min`/`max`.
- **The original entry, for the record. Its deferral of `sum`/`avg` to a precedence question is NOT
  why they are out — see 419 above: the TS hop aggregate is ~430 ms against a 14.6 ms projection
  of the same 800,000 rows (377).** NOT the aggregate machinery — `sum` improved by the same proportion
  while never being folded, so the remainder is shared by both paths and upstream: the per-row
  `Binding` (`Map`) construction the projection path avoids by streaming values. Needs a
  frontier-streaming aggregate shortcut (the TS twin of `try_frontier_prop_agg`). **The floor is
  known to be reachable**: the same work by hand is 24.5 ms, and the projection's 18 ns/row BEATS a
  hand-written public-API loop, so the engine's internal traversal is already good. `sum`/`avg` are
  foldable too (`temporalSum` is itself a left fold; `{mode, sawArray}` reproduces the
  `some(isTemporal)`-before-`some(isArray)` precedence, four awkward orderings checked) — own item,
  because that precedence is where a cross-engine divergence would hide.
- **Two TS targets REFUTED before any code, both by this file (377).** The spelling probe's one
  over-2x group is a **deliberate guard** — `:P` is intentionally non-vacuous, and this file already
  says "do not quiet it by reverting the fixture". And `bench:usage`'s `ts(-)` column is at the
  accepted 26-31 ns/row floor (26.3 ns/node measured), not a gap; item 365 settled that, and
  **indexed TS is 2-3.6x FASTER than indexed native** (1.31M vs 362.5k ops/s — a `Map` hit with no
  FFI boundary), which is worth knowing before anyone reads the unindexed column as a defeat.

- **Deep offset pagination costs 499 ms to return TEN rows — and the obvious fix is a 500x
  REGRESSION on the common case (378).** `detectNodeProjection` streams values and declines on
  `distinct || orderBy || skip || limit`, so any paged query falls to the generic per-row `Binding`
  path. Laziness already saves a SHALLOW page (`take` short-circuits: `LIMIT 10` is 0.03 ms,
  `LIMIT 1000` is 0.84 ms, `SKIP 10 LIMIT 10` is 0.03 ms), so the 38x on `LIMIT 999999999` is real
  but unrepresentative. **`SKIP 700000 LIMIT 10` is 499.52 ms** against a 14.72 ms full stream.
  **DO NOT just widen the gate:** the shortcut returns `Row[]` and materializes everything, so
  applying `limit` inside it takes `LIMIT 10` from 0.03 ms to ~15 ms — 500x worse on the shape
  everyone writes, to win 33x on the rare one. A sound fix needs a COST decision (admit it only
  when `skip + limit` is large; crossover ≈ `skip` 24,000 at ~620 ns a row against ~15 ms flat —
  i.e. a cardinality estimate TS does not have) or a LAZY shortcut, which changes its `Row[]`
  contract. Second data point on the same generic path: `RETURN a.k, b.k` is 131 ms against the
  one-column 14.7 ms, because a second slot also leaves the shortcut.
- **Item 377's stated cause is CONFIRMED, and my brief retraction of it was the error (378).** 377
  attributed its remaining ~430 ms to generic per-row `Binding` construction. A probe showing
  `RETURN b.k` at 14.7 ms vs `LIMIT 999999999` at 669 ms looked like a refutation and was recorded
  as one; reading the code, the discriminator is `detectNodeProjection`'s gate, and falling off it
  is precisely "the generic path builds a Binding per row". The probe found the MECHANISM, not a
  contradiction. **A retraction that never happened misleads as much as a wrong cause** — 377's
  entry stands unamended.

- **A 1:1 endpoint move cannot change a COUNT — 15.2x on a bench row, and `IncidentToAdjacentStrategy`
  is REFUTED (379).** `bench_all`'s `outE.outV` at 9111.8us against `out` at 608.6us looked like
  TinkerPop's missing strategy; it is not. **All three of that strategy's pairs are already equal**
  (`out`/`outE().inV()` 100076 vs 100279us as traversals, 116.9 vs 117.0us as counts) because `inV`
  and `otherV` are elided at LOWERING — their plans are byte-identical to the bare `Expand`. The real
  gap is general: an endpoint move after an edge frontier is 1:1, so a bare `count(*)` over one can
  count the move's INPUT. `outV` is the only spelling that reaches exec as a plan node, which is why
  the special case was covered and the argument was not. 1720.9 → 117.9us probe, 9111.8 → 598.9us
  bench row, controls (`out`, `out.out`, `values`) flat and `outE.outV.values` correctly unchanged.
  **THREE gates, none derivable from the rewrite:** `bothV` is 1:TWO (TinkerPop console, self-loop
  fixture: `outE.bothV` = 8 and `bothE.bothV` = 16 over 4 edges — admitting it HALVES the answer);
  `EdgeVertex` DROPS rows whose edge slot holds a non-edge from another union arm, so the elision
  needs an input that provably binds an edge (**a step being 1:1 in TinkerPop does not license
  eliding it over an arbitrary input**); and nothing may read the dropped slot (no grouping keys, all
  aggs bare `count(*)`).
- **It SHIPPED DEAD first: the gate asked `edge_slot + 1` where an `Expand { bind_edge: true }` lays
  out `[source, EDGE, target]` and the relation is `edge_slot + 2` (379).** Clean build, 1,118 tests
  green, benchmark unchanged at 1720.9us. **A rewrite that declines every query is
  indistinguishable from one that is not there** — item 371's dead fast path in a new place, caught
  only by re-measuring. The regression test now asserts the plan IS elided, so that failure mode is
  guarded rather than merely survived.
- **Two measurement errors worth not repeating (379):** sorting the whole `bench_all` log and
  comparing rows across it, then explaining the gap away as cross-fixture when the rows were in the
  SAME section (the comparison was right, the explanation wrong); and probing the traversals WITHOUT
  `.count()`, reading 1.00x, and nearly filing a refutation — the bench rows are counts (`rows=1`)
  and the gap was never in the traversal. **The `all` → `any` mutant SURVIVES and is provably
  equivalent** (no Gremlin shape puts 2+ aggregates over an `EdgeVertex`: `group().by().by(count())`,
  `groupCount()`, `project()`, `fold().count(local)`, `values().sum()` all yield one or none) — the
  category of item 297's T10.

- **REFUTED ON CORRECTNESS, with a 17,000x attached: a sort may NOT be elided under a bare
  `count(*)`, because `order().by(k)` FILTERS (380).** Item 379's rule — a row-count-preserving step
  is elidable under a bare count — generalises to any 1:1 step, and a sort looked like one.
  `order().by('age').count()` is 5097.8us against `count()`'s 0.3us at 100k vertices, on the "total
  rows" query every paginated UI issues beside its page query. **TinkerPop console, 4 vertices of
  which 2 carry `age`: `V.count` = 4 but `V.order.by(age).count` = 2** — the keyless elements are
  DROPPED, exactly as `values()` drops them. A sort is not a permutation, so the rewrite answers 4
  where the answer is 2. **Do not re-attempt from the perf side**; the three gates it needs
  (`skip`/`limit` absent, `fault_on_element`, key shape) are all beside the point. lenke conforms
  (4/2/2, matching), and the semantics are now pinned by a test whose teeth were verified by
  applying the wrong optimization (rc=101) rather than by assertion.
- **Open and CLIFF-SHAPED: the sort elision is sound only when the key is on EVERY live node (380).**
  Then nothing is dropped and the sort really is a permutation. Needs an O(1) store-side
  present-count, and it is item 325's all-or-nothing vacuity cliff — "one unlabelled node in a real
  graph defeats the elision for every query anchored on that label". A 17,000x that evaporates on a
  single missing property is a different proposition from a 17,000x; price it as such.

- **The `map field meta.city` 20x is REAL map-access cost, correctly measured, and closing it is a
  STORAGE feature rather than an optimization (382).** `value/maps` reads
  `string city (flat)` 249.5us against `map field meta.city` 4953.6us over the same 200,000 nodes.
  **Both stores are UNINDEXED** — I first guessed the flat side was seeding an `IndexSeek`, because
  1.25 ns/node looked impossible for a scan, and that was wrong: `Column::Str` is
  DICTIONARY-encoded (`codes[i]` indexes `dict`), so a flat string equality is a vectorizable
  `u32` CODE compare. _A surprisingly fast number can mean a better representation, not a different
  plan._ The map side is 24.8 ns/node and the read is already targeted — `resolve_path`'s
  one-segment arm (item 359) does `record_field` without cloning the map — so the gap is not
  redundancy but representation: a boxed `Record`, a string-keyed field lookup, and a scalar
  `Value` compare against a SIMD code compare. **Closing it means SHREDDING nested fields into
  columns** (Parquet-style), which is a storage change with a snapshot-format consequence, not a
  tick-sized fix. Item 359's note that "a ratio is only as honest as the sameness of its two sides"
  held up: the comparison it built is sound, and the 20x it exposes is the true nested-path penalty.

- **ITEM 372 IS CLOSED: the aggregate dispatch is FULLY reachable — no dead path (383).** 372 asked
  which of the dispatch's entries are unreachable, after item 371 found one that had shipped dead.
  Instrumenting the 28-entry `or_else` chain over the ~1,200-case `gql_corpus` showed every entry
  CALLED (372). **The instrument had a blind spot I recorded at 376** — `try_frontier_aggregate`
  sits in a later `else if`, OUTSIDE the chain, so the probe reported "no fast path" where it simply
  had no coverage. The post-chain dispatch is exactly TWO more named paths plus the general
  fallback, and both are live: `try_frontier_aggregate` (shown at 376) and
  `try_frontier_group_fold`, confirmed here by an `eprintln` at function entry — reached for a
  grouped `max`/`sum` over a 1- and 2-hop frontier and for Gremlin's
  `group().by('city').by(values('age').max())`.
  **Useful boundary while the probe was up:** a grouped `count(*)` does NOT reach `group_fold`,
  because `try_frontier_dict_count` (chain entry 25) claims it first — so `group_fold`'s real
  territory is grouped NON-count aggregates, and `groupCount().by(k)` is dict_count's. Nothing to
  fix; the question is answered rather than parked, and a future "is X dead?" should use the same
  one-`eprintln` check (item 267's lesson, 371's and now 383's) rather than re-instrumenting a
  corpus.

- **RUNG 3 IS PRICED ON THE WRITE SIDE — item 343's blocker dissolves, and a DIFFERENT one takes
  its place (384/385).** 343 closed with "next step is pricing rung 3's write-path cost… a set on an
  EXISTING key must not pay for the index", framing rung 3 as a per-node key LIST whose
  `contains`-then-insert was the open question. **A per-node BITMASK over key ids answers it:** a
  bit test plus a bit set, one flat allocation, no per-node `Vec`. Measured against the real
  `SET p.age` baseline of **182 ns/node** (200k nodes, 36.33 ms, 5.5 Melem/s), at K = 4/12/60/200,
  SEQUENTIAL and RANDOM — both patterns measured because the bit op was never the question, the
  CACHE was: **0.41–0.73 ns/op, 0.2–0.4% of a SET**, with no penalty even at a 4.77 MiB mask, which
  stays L3-resident.
  **THE REAL CONSTRAINT IS THE LAYOUT'S GROWTH, which 343 was not worried about.** Row-major N×K is
  what makes rendering one node cheap (its K bits are contiguous) — and it means a NEW STORE KEY
  changes the stride, so the whole mask is re-laid out. Keys appear as first seen during decode, so
  K climbs 0 → final. Measured over a 200k-node mask growing to K=200: **naive restride per new key
  1932.9 ms = 477% of the 405 ms decode** (199 restrides) against **geometric doubling 29.5 ms =
  7.3%** (8 restrides) — **65.5x**, with identical bits set both ways (9,950,000) as the
  cross-check. **So geometric stride growth is REQUIRED, not an optimization**: without it the
  ingest cost is prohibitive, and column-major would make growth trivial while restoring the
  K-separate-arrays render cost rung 3 exists to remove.
  **A THIRD CONSTRAINT, found by reading the render path rather than by measuring (386).** The mask's
  bit index has to name a column, and the renderer's columns come from `prop_keys_arc()`, which ends
  in `keys.sort()` — they are SORTED positions. So a mask indexed by render position would need
  RE-PERMUTING on every new key that does not sort last, which is strictly worse than 385's
  widening restride. **Rung 3 therefore needs a STABLE key id** (insertion order), separate from
  the sorted order the renderer emits in — and because the property map must keep `prop_keys`
  sorted order to stay byte-identical, each node's few present properties must be reordered from
  stable-id order back to sorted order (a precomputed stable-id -> sorted-position table plus a
  sort of p ~ 4-5 items, not a pass over K). Noted because it is invisible from the pricing and is
  the kind of thing that derails a build half-way: the structure is not "a bitmask over the keys
  the renderer already iterates", it is a bitmask over a key identity that does not yet exist.
  (Related smell in the same area: `prop_keys_cache` is keyed on key COUNT, and its own comment
  already flags a rename that removes one key and adds another.)
  **DESIGN RESOLVED at 387, and it DISSOLVES the constraint above.** The structure should be a
  DERIVED, VERSIONED CACHE rather than a maintained index: build the row-major mask on demand from
  the per-column presence, and invalidate it when the key SET changes. Sorted positions are then
  always current, so **no stable key id is needed** and 386's reordering problem disappears — and
  385's restride analysis becomes moot for this design, since there is no incremental growth, only
  invalidate-and-rebuild. The one-off build, column-major `Vec<bool>` -> row-major bits, 200k nodes,
  cross-checked that the mask carries exactly the columns' presence: **0.5 / 1.3 / 6.4 / 21.7 ms at
  K = 4 / 12 / 60 / 200 — 0.1% / 0.3% / 1.6% / 5.4% of the 405 ms decode**, mask 0.10-4.77 MiB.
  **Invalidate on a WRITE, not on the key count — and the reason is NOT the one 387 gave
  (corrected at 388).** 387 justified this by `prop_keys_cache`'s comment flagging "a rename that
  removed one key and added another"; **that hazard is unreachable** — there is no rename operation
  on property keys and no `props.remove`/`edge_props.remove` anywhere, which is exactly why the node
  cache's own comment can assert that keys "are only ever ADDED… the cache self-invalidates on a
  length mismatch, needing no write-path hook." Count-keying is SOUND there, and the edge twin's
  "bargain" overstates a risk no code can produce.
  **The mask still cannot use a count, for a stronger reason:** `prop_keys_cache` caches key NAMES,
  which change only with the key set; the mask caches PRESENCE, which changes on every `set_prop`
  that gives a node a property it lacked. A count-keyed mask would go stale after an ORDINARY write,
  not merely after a pathological rename. So the shape is: build once, MAINTAIN on write (384's
  ~0.3% bit update), and rebuild only when the key set changes, since that is a stride change.
  `bump_epoch` remains right for the key-set half and still behaves well during ingest: _"if
  self.loading { return; } // deferred; end_bulk() stamps every loaded token"_ — a bulk load stamps
  nothing, no render happens mid-load, and the first render after `end_bulk()` builds the mask once.
  **So the remaining work is: the mask cache with write-maintenance, the build, and the render
  reading set bits instead of probing K columns.**
  **State: rung 3's write side is priced and viable.** Per-write ~0.3%, ingest ~7.3% of decode with
  geometric striding, memory 4.77 MiB at K=200/N=200k plus up to 2x from doubling's slack and a
  transient copy during a restride. The READ win remains 342's: packed is 145.4/244.7 ns/row at
  K=60/200 and rung 3 takes K=200 toward the ~90 ns/row floor. Still NOT BUILT — this prices it.

- **⚠️ RECALIBRATION OF 342 BEFORE BUILDING RUNG 3: the K-slope reproduces but is 2.16 ns/key, and
  the BASELINE it does not touch is 466 ns/row (389).** Four ticks of pricing (384/385/386/387/388)
  had rung 3 ready to build, so the target was re-measured first — 342's numbers predate several
  renderer changes including 340's hoisting. `MATCH (n:P) RETURN n` over 200,000 nodes with 4
  properties, varying only the number of OTHER store keys (carried by a handful of `:Carrier` nodes
  so the columns exist without being present on the rendered rows):
  **466.2 / 505.2 / 599.0 / 898.0 ns/row at 0 / 12 / 60 / 200 extra keys** — a slope of **2.16
  ns/key** (342 recorded 7.86 full, 1.59 hoisted) and **1.93x / 1.28x / 1.08x** available to rung 3
  at K = 200 / 60 / 12.
  **The baseline is NOT presence scanning**, which is the part that redirects the work: the same
  sweep with four cheap NUMBERS instead of a distinct-per-node `name` string (200k dictionary
  entries, an `Arc` clone per read) measured 466.2 against 469.2 — **indistinguishable**, so the 466
  is neither the property values nor the K-scan. It is `Value::Map` construction (two maps and four
  `Arc<str>` key clones per node), `node_ext_id`, and `labels_of_refs` + sort. **342's "toward the
  ~90 ns/row floor" is not reachable from a full element render**; 466 ns/row IS the floor here, and
  342's 220.6 at K=0 suggests it timed the props loop rather than the user-visible shape.
  **So rung 3 is worth building for WIDE schemas and is nearly free of value at K=12** — the common
  case — while the larger prize sits in the baseline it cannot reach. Not a retraction: the slope is
  real, the pricing (384/385/387) stands, and the ladder's rung 3 remains the right way to remove
  the slope. But the headline is "render cost stops scaling with store width", not a 20x.

- **A property KEY was rebuilt per CELL, copying its bytes and heap-allocating past 12 characters —
  1.32x on element render (391).** `Value::Str(Arc::clone(k).into())` ran `GStr::new(&s)`, which
  COPIES, inline to `INLINE_CAP = 12` and a heap allocation with a refcount header above it — per
  node per property, for a key identical across the batch. Hoisted to K key `Value`s cloned per cell
  (`GStr::clone` is one relaxed `fetch_add` for a heap string, a 16-byte copy for an inline one):
  **key length stops mattering**, 445-453 ns/row at 13-40 chars against 436.8 at 12, where before it
  was 465.6 at 12 and 597.1 at 20. FOUR sites take it (`render_nodes`, `render_edges`, two
  `elementMap`/`valueMap` paths in `evaluator.rs`); the two single-element renders are deliberately
  left, having no row loop to hoist out of. `bench_all`: `element p` 513.1 → 468.9 ns/row (1.09x),
  `element r` 337.1 → 331.0, controls flat.
  **THE BENCH CANNOT SHOW THE REAL WIN**: its fixture keys are `name`/`age`/`city`/`dept`, all
  inline, so it reads 1.09x where a realistic schema gets 1.32x. **And my own probe had hidden it
  too** — item 390 measured this loop at 55 ns/property using keys `"a".."d"`, never touching the
  heap path. Item 374's uniform-label fixture mistake in a new place: _a fixture that makes the
  measurement tidy by avoiding the case that matters._
  **How it was found, since four ticks of pricing pointed elsewhere:** 342's ladder said pack
  presence; re-measuring at 389 showed the K-slope is 2.16 ns/key (not 7.86) and the **baseline is
  466 ns/row and not presence**; ablating that baseline at 390 put **47% in the property loop**, 37%
  in two `Value::Map` allocations, 12% in labels and **~0 in the external-id lookup**. Mutants: all
  four key-index errors CAUGHT by the existing suite, behaviour-preserving control SURVIVED.

- **REFUTED — pre-sizing the property vector in `render_nodes` is 1.25x SLOWER (392).** Item 390's
  ablation left two `Value::Map` allocations at 174.2 ns/row, and the obvious suspect was that
  `props` collects from a FILTER, whose `size_hint` lower bound is 0, so `collect` starts empty and
  grows geometrically — four present properties means reallocs at 1, 2 and 4. Measured:
  `Vec::with_capacity(8)` plus a push loop reads **559.3 ns/row against `collect`'s 446.3 at K=0**
  (and 707.5 against 580.6 at K=60) — **1.25x worse**. The reason is over-allocation:
  `with_capacity(8)` claims eight `(Value, Value)` slots unconditionally for a node that typically
  carries four, which is a larger allocation than the geometric growth ever performs. **Do not
  reach for `with_capacity` here**; `collect` is already the better shape. Reverted, baseline
  confirmed back at 444.1.
  So the 174.2 ns/row floor is the two `Arc::new`s and the 3-element outer `vec!` — structural to
  the result shape, not slack in the collection.

- **PRICED, MODEST, NOT BUILT — element render also scales with the store's LABEL count, at 0.80
  ns/label (393).** `labels_of_refs` iterates EVERY label in the store, binary-searches each one's
  id list, then allocates a `Vec` and sorts — per node, per render. The same shape as the property
  key cost item 391 removed, so it was measured the same way: 200,000 nodes, one label each, only
  the number of OTHER store labels varied (carried by nodes that are not rendered).
  **390.6 / 391.3 / 397.6 / 434.6 / 551.0 ns/row at 0 / 4 / 16 / 64 / 200 extra labels** — a slope
  of 0.80 ns/label and **1.41x at L=200, but 1.00-1.02x at the 4-16 a real schema carries**.
  **No free hoist exists here, which is why it is not 391.** The binary searches depend on the node
  id, so unlike the property keys nothing is loop-invariant; removing it needs a forward
  node -> labels cache — new state, on the item-387 pattern. Item 390 measured labels at 57.2
  ns/row on a ONE-label fixture, which is the floor and the common case. Worth building only for a
  schema with scores of labels; recorded with its slope so that judgement can be made from numbers.

- **REFUTED — `etype_name`'s O(T) linear scan is NOT observable; the edge-label cost is the
  ALLOCATION path (395).** Item 394's ablation put 60.2 ns/row (18%) of the edge render in labels,
  and the code looked alarming: `etype_name` does `etype_ids.iter().find(…)` — a LINEAR SCAN over
  every edge type — then clones a `String`, and `edge_labels_of` returns `Vec<String>` which
  `render_edges` copies AGAIN into a `GStr`. Measured on the T axis (100k nodes, degree 5, only the
  number of other edge types varied, carried by edges that are not rendered):
  **339.1 / 336.9 / 328.8 / 333.3 / 340.4 ns/row at 0 / 4 / 16 / 64 / 200 extra types — FLAT.**
  A small cache-resident map walked per row costs less than it reads. **So do not build a reverse
  id -> name index for this**; the 60.2 ns is the `String` clone, the `Vec`, the sort, the second
  copy into `GStr` and the `Value::List`. The fix is item 340's borrow (`labels_of_refs`) applied to
  the edge twin, which never got it — the same "two of most things" pattern as 367/368/370, 374 and 376. Worth ~20-30 ns/row of the 60, so modest; the scan is not worth touching.

- **DONE — the edge twin of item 340's borrowing label accessor, 1.05x on edge render (396).**
  `labels_of_refs` gives the NODE side `Vec<&str>`; the edge side only had `edge_labels_of`, which
  cloned a `String` per label for the caller to copy the bytes again into a `GStr`. Added
  `etype_name_ref` + `edge_labels_of_refs` and moved eight call sites (both renderers, `json_out`,
  the evaluator's `labels(e)`, three `codec.rs` sinks, `binary.rs`); the owned form stays for the
  one caller that needs a `Vec<String>` in a struct field. **322.3 -> 306.6 ns/row (1.05x) and
  346.2 -> 333.4 (1.04x)**, min of three alternated rounds, disjoint ranges, node render and a
  count flat as controls; bench `element r` 328.0. **The length axis I predicted is flat**: the
  saving is one malloc/free per label, not a copy of its bytes, so a 17-character type (above
  `GStr`'s 12-byte inline cap, heap-allocating on both paths) saves LESS, not more. That takes
  13-16 ns of the 60.2 that 394 put in labels; **the rest needs a cached label list** — item 393's
  unbuilt forward node->labels cache in its edge form — and is not available by borrowing.

- **DONE — `edge.from.id` round-trips an id the edge already holds; 1.78x connected components,
  1.67x PageRank, 1.28x NDJSON encode (397).** `from`/`to` resolve through `getVertexById` and
  read back the same string the edge stores. **Item 140 fixed exactly this and applied it to ONE
  call site** (`indexEdgeLabel`); 44 others kept the round trip — every algorithm's CSR loop,
  every serialization encoder, `Edge.toJSON`, the clone paths, `txTouched`, Gremlin
  movement/projection, `inspect`. The accessor itself is **89.7 -> 14.3 ns/edge (6.3x)**, ~37 ns
  per round trip, which is the UPPER BOUND; end to end, alternated min of three at nine reps:
  connected components 20.72 -> 11.64, PageRank 71.75 -> 43.03, NDJSON encode 79.61 -> 62.25, all
  disjoint, `degree` flat as a control. **Betweenness is only 1.04x** — O(V*E) BFS dominates, so a
  CSR-build saving barely shows; do not price an algorithm by its edge count alone.
  Two traps worth carrying forward: the algorithms return a **Promise**, and a probe that forgets
  to await reports three unrelated algorithms at 5.03/5.02/5.06 ms; and `encode ndjson` at three
  reps had OVERLAPPING ranges with one NEW round worse than an OLD one, resolving only at nine.

- **DONE — `[...set]` is 1.79x `Array.from(set)`; 1.44x on an edge render, 1.22x on a vertex
  (398).** Spread takes the engine's fast path for an unmodified `Set` iterator where
  `Array.from` walks the generic iterator protocol (a manual `push` loop is slower than spread);
  the one-element `sort()` is skipped below two labels. Measured three independent runs:
  66.1/63.0/64.7 vs 35.8/35.2/36.2 ns, disjoint. **Report the MEDIAN here, not the min** — round
  3's NEW was a globally fast round in which the CONTROL also dropped, and min-of-three then
  credits the change with the machine's luck.
  **RETRACTED in the same item: "the TS engine renders edges slowly" is false.** `edge.toJSON`
  is 94.7 ns/element against `vertex.toJSON`'s 133.5 — an edge renders CHEAPER. The bench's
  1102 ns/row is traversal and the JSON carrier.
  **And the sorted-labels invariant both `toJSON`s document had NO test**: deleting the sort
  outright SURVIVED the whole suite, as did an off-by-one guard that skips sorting a TWO-label
  element. Now pinned by `tojson-label-order.test.ts`.

- **A TS mutation loop poisons its own next run, and a false CAUGHT reads as teeth (398).**
  `bun run test` restored a **cached build of the PREVIOUS mutant**: after 397's run, a later
  full test run failed ten byte-identity tests with edge endpoints reversed — 397's M2 mutant,
  long after its source was restored — and 398's own control reported CAUGHT in the loop and
  SURVIVED alone. So: rebuild after restoring, and **re-run every verdict isolated before
  believing it, the control first**. A harness that reports false CAUGHTs made two genuinely
  SURVIVED mutants look caught, which nearly signed off an untested invariant as tested.
  `bun run fuzz` passed during the poisoned run because the fuzz runner rebuilds its own inputs.

- **NOT A REGRESSION — the encoders are 1.26-1.60x FASTER after 397+398; the full bench said
  10-25% slower (399).** One `bun run bench` read `encode ndjson` 45.8 -> 57.1, `graphson`
  126.0 -> 142.6, `pg-text` 72.2 -> 87.2. Two tells said not to believe it: the rows moved in
  BOTH directions, and `decode` moved at all, which neither change touches. Settled by an
  alternated A/B, HEAD vs HEAD~2, three rounds, one process per side: ndjson 269.23 -> 190.55
  (1.41x), graphson 490.42 -> 390.17 (1.26x), pg-text 293.19 -> 182.73 (1.60x), disjoint, both
  controls flat. **When the full bench disagrees with a focused A/B, the A/B wins**; the full
  bench's job is catching what the A/B is not looking at, and nothing else moved beyond noise.

- **`git checkout <ref> -- <files>` STAGES, so an A/B script leaves a revert in the index (399).**
  After the OLD side was restored, `git status` read `MM` on ten files — working tree at HEAD,
  index at HEAD~2. A commit then would have shipped a partial revert of 397 and 398 with every
  file on disk looking correct. Every A/B script in this family builds its OLD side that way.
  **Check `git status`, not just file contents, before committing after one has run**; clear it
  with `git reset HEAD -- <dir>` and verify an empty `git diff`.

- **DONE — a point equality on a RANGE-indexed key fell to a COLUMN SCAN; 427x labelled, 960x
  unlabelled (402).** `index_seek_ids` consulted only the hash index and its own comment said the
  rest: "Without an index the seek degrades to a scan". But the range index is a
  `BTreeMap<OrdVal, Vec<u32>>` and **a point probe is a degenerate range**, so the structure that
  answers `k = v` in O(log n) was built and never asked. `range_lookup` gains an `Eq` arm
  (`Included(k), Included(k)`); `index_seek_ids` probes it before falling back, intersecting the
  label by per-candidate binary search as the hash arm does. Sound because the two orders agree
  exactly where the probe is used: `cmp_num_total` ties -0.0 with 0.0 as `equals` does, cross-type
  values differ by `rank()`, null/NaN are refused first. 200k nodes, alternated, three rounds, 200
  probes a sample: **128,154 -> 300 ns** labelled and **263,070 -> 274 ns** unlabelled, with a
  hash-indexed point eq, a range BOUND and `count(*)` all flat. **A missing path, not a speedup**
  — the number is the size of the hole.
  ~~**STILL OPEN, deliberately split out**: the PLANNER half~~ — **CLOSED by item 404 at 906x.**
  `multi_seek_worth_it` now admits `has_hash_index || has_range_index`, and `index_bucket_len`
  falls back to the range bucket so the rung can PRICE what it can execute — without that second
  half the gate opens onto nothing, because above `SEEK_FLOOR_NODES` a `None` price declines
  every arm. `IN` over a selective range key **637,343 -> 703 ns**, the OR-chain spelling within
  3 ns of it, a low-cardinality key 8.7x; four controls flat (`IN` over a HASH key, a single
  `=`, a range bound, `count(*)`). `eq_cand`, the SINGLE-value rung, stays hash-only on purpose:
  widening it moves which conjunct a multi-predicate filter seeds, and a lone `k = v` already
  reaches the probe through the fallback rung.

- **DONE — `IS [NOT] NULL` boxed a whole column to ask a bitset question; 4.62x on a
  partially-present key, 5.50x on an absent one, 2.21x for `IS NULL` (405).** `Expr::IsNull`
  called `eval` and then `is_null_at`, so a partially-present column became `Col::Gen` — 200,000
  boxed `Value`s, 198,000 of them `Value::Null`. `Column`'s `present` bit IS the predicate (a
  stored present-null is `present = false, nulls = true`), `has_value_at` is that bit, and
  **`count(prop)` has read it since item 267** — the mechanism was on the sibling path, the
  fourth time this session (396, 397, 402). Node frontiers only: edge properties are a boxed map
  with no presence bitset.
  **The fully-present row is NOT claimed.** It read 1.17x while a CONTROL the change cannot reach
  (a range predicate) moved **1.10x with disjoint ranges** — code layout, the mechanism
  `pull`'s note records biting the other way. A fully-present column already reached a typed
  `Col::Num` and never boxed, so there was little to win; without that control it would have been
  booked as a small win with a wrong explanation.
  **STILL OPEN, priced**: `k IS NOT NULL` on an indexed key IS the index's id set, so it could
  seed (0.258 against the 0.031 ms an equivalent range spelling reaches). Needs a seed form
  meaning "the whole index" — new IR, and item 264 records `rewrite_fuzz`'s generator missing a
  new rung twice.

- **DONE — the TS engine had NO selectivity gate on an index seek; 5.9x at 60% (409).**
  `collectHints` seeded whenever a hint existed, deliberately ("no selectivity to guess at"), so
  an unselective seek was never declined: **1.96x worse than the scan at 30%, 5.02x at 60%**,
  where native stops at 15.4%. THREE sites choose a seed (`matching.ts:seedVertices`,
  `shortcuts.ts` x2, `hop-projection.ts`) and **the rule already lived in one of them** —
  `hop-projection`'s `SEEK_MARGIN`, since item 173. Now one shared `seekIsWorthIt`.
  **The VALUE came from that existing threshold, not from this item's curve**: its comment
  records a crossover at 16.25% adopted after a measured 3.1x REGRESSION, this item measured
  ~18%, and the two bracket the same point — so the constant is `SEEK_MARGIN`'s 1/8. A wrong
  decline costs the scan; a wrong seek is unbounded.
  After: 30% 1.96 -> 0.90/0.86/0.73, 60% 5.02 -> 0.84/0.91/0.86 (34.37 -> 5.85 ms), the
  selective 1-8% band unchanged, `bench:usage` point lookup still 920.8k vs 2.0k ops/s.
  **Spelling probe discharged** (`CLAUDE.md` requires it after touching the TS planner, and CI
  structurally cannot do it — the gate is a PERF decision, so every spelling still returns
  identical rows whether or not they cost the same). At `SPELL_N=200000 SPELL_REPS=9`:
  **0 groups disagree on the ANSWER**, and the single over-2x group is the pre-existing
  `label on start: redundant vs absent` guard the probe file itself says not to quiet. So the
  gate opened no spelling gap. Two sub-2x asymmetries noted in passing, both already owned by
  items 290/298: four hops forward vs reversed 474.94 vs 721.55 ms (1.52x), five hops 930.05 vs
  851.61 (1.09x the other way).

- **NOT A DIVERGENCE — the engines AGREE on the parked "lazy vs eager" shapes; both differ from
  TinkerPop 3.8.1 (417).** Console version PINNED, modern graph, both engines run on the same
  four shapes: A/B/D all three agree at 6; on **C (`aggregate('x').inject(1).limit(0).cap('x')`)
  TinkerPop gives `[[]]` EMPTY and BOTH engines give 6.**
  Three records corrected: the memory note's "TS -> []" is **stale** (TS returns 6, measured);
  `executor.test.ts:252`'s comment "TinkerPop: 4" is **false** for 3.8.1 (its assertion matches
  the engine — only the claim about the reference is wrong); and my own claim one tick earlier
  that "TinkerPop sides with the TS engine" was wrong, taken from the note instead of a run.
  The note's claim that BRANCH steps share the divergence is also wrong — TinkerPop does not
  empty the `union` form and neither engine does.
  **No behaviour changed**: emptying C is an architectural change, and it is now a conformance
  question against a reference rather than a choice between two internal designs — a decision for
  the project, not a side effect of an optimization pass.
  **`gremlin-fuzz` skips this shape** (`zeroSliceFedByEarlyYield`) as a cross-engine divergence;
  the engines agree, so it is protecting nothing — and **a differential fuzzer is structurally
  blind to a bug both sides share**, which is why the console was worth the ticks.

- **DONE — the TS `neighborAggregate` twin, 1.12x on the DEFAULT direction, after two refuted
  attempts (416).** Shipped: a REUSED BUFFER (415's actual shape) — `both/none` 2343 -> 2083
  (1.12x) and `both/gcn` 2985 -> 2731 (1.09x), both disjoint; single-direction within noise and
  NOT claimed.
  **REFUTED, return the STORED adjacency list instead of copying**: `direction: in` regressed
  **1.20x with disjoint ranges** ([1604-1853] vs [1925-2242]) while `out` — the same branch,
  same contents — improved. Monomorphism at the consumer's iteration is the only candidate
  mechanism and does not explain the asymmetry. **Do not re-try the shared-array route.**
  **REFUTED, fixing only the `gcn` length call**: 1.04x/1.01x with OVERLAPPING ranges. The
  degree pass is a small share of a loop dominated by the fold, so the 1.21x attempt 1 showed
  there was the other change or noise — attributing it would have been wrong.
  **A JIT'd language needs ALTERNATED processes.** The first comparison used two separate `bun`
  invocations and read the single-direction cases as worse; alternating showed noise for `out`
  and a REAL regression for `in`.

- **DONE — `neighborAggregate` allocated a contributor `Vec` per vertex; 1.23x/1.14x/1.07x
  across the dim sweep (415).** **The "vectorize it" target my notes carried is REFUTED by its
  own curve**: 16x the dims costs 4x the time, so the per-dim slope is ~7.7 ns against a ~125 ns
  per-node FIXED cost, and the inner fold is already a tight `f64` slice loop with no boxing.
  The fixed cost was `contributors(v)` allocating and sorting a `Vec` per vertex (twice under
  `gcn`) plus `all_nodes()` being BUILT twice, once only for a length. Gain shrinks with
  dimension, which is the prediction — a vectorization would have sloped the other way.
  Controls (`degree`, `wcc`, `pagerank`, `closeness`) flat.
  **Still open and now priced**: the per-dim cost is the OUTPUT, `Value::List` of one
  `Value::Num` per dimension — 3.2M `Value`s at dim 64 over 50,000 nodes — which is inherent to
  the `Vec<(u32, Value)>` return type. Changing it is a contract change, not a loop change.

- **MATCH THE HARNESS, not just the sample counts (415).** The new numbers were first read
  against `bench_all`'s `algo/neighboragg` section and looked like a **2.2x REGRESSION** at dim
  64; the standalone `algo_bench neighboragg` uses a different fixture, so they are not the same
  question. Re-measuring the baseline on the SAME harness turned the phantom regression into a
  real 1.07x gain. `CLAUDE.md`'s "match sample counts on both sides" has a level above it.

- **VERIFIED — this session's native work carries into WASM; no row regressed (414).** Every
  change in 396/402/404/405/407/412 compiles into the wasm target as well as the `.so`, and the
  CLI is wasm-only, so a win that exists only natively would matter. `bun run build:wasm` first
  (nothing else rebuilds that artifact), then `BENCH_ENGINES=ffi,wasm`, which compares two builds
  of ONE engine so any divergence is attributable to the target rather than the algorithm.
  **All query rows land in 0.60-1.02x (ffi/wasm), i.e. wasm between parity and 1.67x slower** —
  the documented "about a third". The most-changed area is at PARITY or better:
  `project the element + materialize` **1.02x** (wasm marginally faster),
  `project the edge + materialize` 0.94, `traverse 1-hop + filter` 0.95,
  `count 2-hop + start filter` 1.01. The worst ratios (`count 1-hop [shortcut]` 0.60,
  `count 3-hop + start filter` 0.62) are on 0.4-1.0 ms absolutes where fixed overhead dominates,
  not on anything touched. Codec rows vary by direction (`decode graphson` 1.12 wasm-faster,
  `encode pg-text` 0.64 wasm-slower), so read this table PER ROW — a single headline hides both.

- **NOT A GAP — `V().out(T).count()` native 0.59 ms against TS ~0.00 is a STORAGE-POLICY
  difference, not a missing fast path (413).** The last native-slower row in the Gremlin table
  after 412. Native already takes the right algorithm: `try_fused_count` sums adjacency LENGTHS,
  O(sources) and never touching an edge — 0.59 ms over 200,000 sources is ~3 ns each, which IS
  that loop. TS answers in O(1) because `Graph.edgesByLabel` is a per-label `Set<Edge>` it
  maintains **unconditionally**, so `.size` is the answer. Native's equivalent
  (`create_edge_type_index`) is **OPT-IN and off by default**, so the bench fixture has no such
  index and nothing O(1) is available to read.
  **So closing this would mean always maintaining a per-type edge index in native** — a write
  cost on every `addEdge`, which is a deliberate storage decision and not a planner oversight.
  Do not re-open as a query-planning target; it is a config/storage question, and the write-side
  price would have to be measured first.

- **DONE — Gremlin's `E().count()` built and SORTED a million ids to read their length; 303x
  (412).** `Plan::EdgeScan` runs `all_edges()`, which flat-maps `out_adj` into a `Vec<u32>` and
  sorts it; `try_scan_count` had the NODE arms and no edge arm, so `count(*)` fell through to the
  general path. **12.12 -> 0.04 ms**, reproduced twice, with seven controls in the same bench
  table flat. New `live_edge_count` sums out-adjacency lengths = **exactly `all_edges().len()` by
  construction** — `edge_count()` would have been wrong, being the total EVER CREATED, and the
  mutant that used it is caught. `Plan::EdgeScan` is produced only by `gremlin.rs`, so there is
  NO GQL twin (its "every edge" is an `Expand`) — worth stating, because after five sibling-path
  findings the reflex is to assume one.

- **NO TWIN — native cannot have item 410's bug, because it decides seeding at PLAN time (411).**
  `seek_beats_scan` runs inside `optimize_indexed`, so a declined seek is not in the plan and
  `cost::estimate` sees the `Scan` that replaced it; TS decides per call at RUN time, so its
  estimator had to model the decision. **The rule: when a decision moves from plan time to run
  time, every estimate of it becomes a second implementation of it.**
  Incidental, from item 404: `cost.rs`'s `IndexSeek` estimate now goes through the range-index
  fallback in `index_bucket_len`, so for a range-only key it is the EXACT bucket length instead
  of a `live_nodes * EQ_SEL` guess. Its three consumers pick between byte-identical routes
  (fused group, JSON streaming, `stream_output_threshold`), and `bench_all` showed no row moving.

- **A GATE added to a decision silently breaks whatever ESTIMATES that decision (410).** Item
  409's selectivity gate meant an index candidate is no longer a seek that will happen, but
  `estimateSeedFrom` still reported `indexed: true` with the index count — half the size of the
  scan that really runs, with the provenance `orient` trusts to let a seek outvote a constrained
  start (the confusion items 172/173 record). **Found by reading the consumers of a function
  whose meaning had changed**, not by a test (reverting leaves the suite green) and not by a
  measurement. `orient`'s own tests CANNOT cover it — orientation is answer-preserving, and that
  file says so — so the estimate is asserted directly, above the floor, with a selective control.

- **A rule ported WITHOUT its floor flips every small-fixture test, and they are right (409).**
  Taking native's fraction and leaving `SEEK_FLOOR_NODES` behind flipped NINE tests — on a
  fixture of a handful of vertices two matches are 20% of the bucket and the ratio is
  meaningless. Adding the floor fixed eight; the ninth (item 176, "a seek WIDER than the label
  bucket is declined") stayed red because that rule holds at ANY size and the floor was
  swallowing it. Order the checks: reject wider-than-bucket, THEN the floor, THEN the fraction.
  Also: a selectivity test needs a fixture ABOVE the floor or it asserts the rule against the
  floor's early return and passes vacuously.

- **DONE — the seek-vs-scan ceiling is ENCODING-blind; up to 4.00x on a dict column (407).**
  `SEEK_MAX_FRACTION = 0.154` is one number standing in for "how cheap is a scan of this
  column", and that varies: a dict-encoded column's scan is **flat at ~140us** (a `u32` code
  compare) where a raw-f64 scan is **~374us**, so the break-even selectivity is **~3% against
  ~15%**. The planner seeded the whole 3-15% band on dict columns and lost up to 4.00x.
  Fixed with `Store::scan_is_cheap` + `SEEK_MAX_FRACTION_CHEAP_SCAN = 0.031`, applied in
  `seek_beats_scan` AND `multi_seek_worth_it` (which keeps its own copy — the `IN` spelling still
  seeded until both agreed). Also fixed, which the original flag did not point at: equality on a
  dict column (0.398 -> 0.315 ms) and `IN` (0.429 -> 0.301).
  **⚠️ A GLOBAL RETUNE WOULD HAVE BEEN WRONG, and I was one tick from it.** The numeric curve
  breaks even at ~15%, which is exactly where the constant already sits — it is correctly tuned
  for the column kind it was tuned on. Lowering it globally would have regressed numeric range
  seeks across 3-15%, where they win by up to 3.6x. `a_numeric_column_still_seeds_at_the_same_selectivity`
  is the test that now pins that half; `bench_all`'s `p.name = 'name12345'` (high-cardinality, so
  not dict) is the row that would have shown it.

- **NO TWIN — the TS engine does not have item 405's hole, and cannot (406).** 405 was a
  COLUMNAR problem: materializing a `Col` (boxed when partially present) to ask about presence.
  TS compiles `isNull` to a per-row closure over a property bag. Measured, since the tell would be
  shape dependence: **sparse and fully-present cost the SAME 33.6 ns/row**, with an absent key
  slightly WORSE at 42.4 — the opposite of Rust's ordering, where absent was cheapest. A range
  control is 27.7, so the whole null test adds ~6 ns over the per-row `Binding` floor item 377
  named. **Nothing to build until that floor moves.** For calibration: native is now 0.258 ms
  against TS's 6.72 on this shape (26x, was 5.5x) — a gap that widens by design when a columnar
  engine gains a bitset path, not a TS regression.

- **A guard can be load-bearing, untested, and a PANIC rather than a wrong answer (405).**
  Removing the `u32::MAX` OPTIONAL-miss guard from the presence fast path left all 1,122 tests
  green: nothing in the suite sent an optional MISS through `IS NULL`. Unguarded it indexes the
  property column by the sentinel — `index out of bounds: the len is 4 but the index is
4294967295`. **An answer-comparing test cannot see a crash that no test provokes**; only the
  mutant showed it. Now pinned by `an_optional_miss_reaching_is_null_does_not_index_by_the_sentinel`
  (`WHERE` inside `OPTIONAL MATCH` is `E_NOT_IMPLEMENTED`, so the predicate is PROJECTED).

- **A plan-shape test can cover a GATE and miss the PRICING behind it (404).** The rung's choice
  is a PERF decision — every mutant returns the right rows, just by scanning — so the test must
  assert the plan. Reverting the gate was CAUGHT; removing the range fallback from
  `index_bucket_len` **SURVIVED**, because the fixture sat below `SEEK_FLOOR_NODES` (4,096) and
  the pricing loop never ran. A second test over 5,000 nodes catches it. **The fourth fixture
  this session to hide the case that mattered** — uniform labels (374), one-character keys
  (390/391), the wrong index kind (402), and now a node count below a threshold the code reads.

- **A spelling that LOOKS seeded can be a typed column scan (402).** `k = v` on a range-indexed
  key read 0.125 ms against a 0.622 ms scan and the plan said `IndexSeek` — both true, and
  together they say 5x "seek". It was the typed-scan constant factor; the real gap was 427x.
  `IndexSeek` is a SEEK-OR-SCAN operator, so its presence in a plan is not evidence of an index.
  Also recorded: the same probe first read `IN [a,b]` as a seeding gap, which was **the FIXTURE** —
  `age` had a range index and the multi-value rung is an equality rung. Items 263/264/270 hold.

- **OPEN, with the trap named — `NOT (k <= v)` scans where `k > v` seeks, 10.7x (402).** The
  obvious rewrite is WRONG under this engine's NaN rule: with `k = NaN`, `NaN <= v` is false so
  the `NOT` form is TRUE, while `k > v` is FALSE. A range seek would silently drop those rows.
  A correct rewrite is `(k > v) OR isNaN(k)`, which is not a pure seek. Do not "fix" this in one
  line.

- **NO TWIN — the TS engine does not have item 402's hole (403).** Its `PropertyIndex` is ONE
  structure (equality buckets plus a lazily built ordered view), so `kind: 'range'` and
  `kind: 'hash'` both serve a point seek; `IndexKind`'s doc says so and the measurement agrees.
  Flat across a 10x size step — range 563 -> 546 ns (0.97x), hash 882 -> 887 (1.00x) — against an
  unindexed control that scales 16.29x, as a scan must. After 402 the engines AGREE here.

- **A `for`-loop probe charges its FIRST case for JIT warmup, and best-of-N does not save it
  (403).** The same probe first read range at 1763 ns against hash at 882 — a 1.6x gap through
  one structure. Reversing the case order INVERTED it: whichever runs first reads ~1800, whichever
  runs second ~550. Every TS probe in this session has this shape. **Reverse the order and check
  the result survives, or run a discard pass before the first measured case.** A ratio that
  compares a case against ITSELF (here: cost at 20k vs 200k) is immune, which is why the real
  question was answerable from the first run and the spurious one was not.

## 6. Consequences of the AND decision — RESOLVED by item 258, and not as predicted

This section was written before the change and asked three questions. All three are now answered by
measurement, and **two of its three guesses were wrong.** Kept rather than rewritten, because the
wrong guesses are the useful part: each was a plausible inference from "`AND` now short-circuits"
that the engine did not bear out.

| the question §6 asked                                                  | the answer                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Item 190's placement rule — is a subquery conjunct free to reorder? | **No, and the guard is now MORE load-bearing.** `opt.rs`'s `can_raise` declines the US008/UA004 latitude for relocation; short-circuiting makes that a correctness condition rather than a courtesy, because relocating a raising conjunct EARLIER would make it raise where the written order skips it.                  |
| 2. Item 175's divergence — does it become the intended behaviour?      | **No — it is what is LEFT.** The hop seed gate's cheap-conjunct-first ordering is a reordering the TS engine has no seek to match, so it is now one of the two surviving routes in the registry entry.                                                                                                                    |
| 3. The registry entry — delete it?                                     | **NARROWED, not deleted.** _§6 said "it should be **deleted**, not widened"; that was written before measuring and it was wrong._ Traffic on the differential fuzzer at 20,000 queries a run went from **~4 uses to ~1**. Two routes survive, both about ORDER rather than the connective — see the entry's own `reason`. |

**What the change also exposed**, which §6 did not anticipate at all: the two engines had been
agreeing on `WHERE … AND VALUE { … RETURN count(*) }` **by two different routes** — native rejecting
it statically at plan time, TS catching it per row — both as `E_INVALID_VALUE`, so nothing noticed.
Short-circuiting removed TS's route and the agreement with it. Fixed by giving TS's
`definitelyNonBool` the `valueSubquery` arm it never had: **a static reject is order-independent, so
it is the route that survives short-circuiting.**

The generalisable lesson, which is why this stays in `CLOSED.md` rather than only in the audit:
**two engines returning the same error code are not necessarily implementing the same rule.** Any
change that removes one engine's path to an error can reveal that the other's was the only real one.
