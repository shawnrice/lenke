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

| question                                                                                         | settled as                                                                                                                                                                                                                                                                                                                                                                                                                     | authority                                 |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| Prototype-chain keys (`__proto__`, `toString`, `valueOf`) as property names                      | **WON'T FIX** — not real-world input                                                                                                                                                                                                                                                                                                                                                                                           | item 1, **user**, re-confirmed 2026-09-16 |
| Row order without `ORDER BY`                                                                     | **Unspecified**, as SQL. Do not sort to fake byte-identity; compare as multisets                                                                                                                                                                                                                                                                                                                                               | item 198, **user**                        |
| Cross-type comparison                                                                            | `=` → no match; `<=` → `E_INVALID_VALUE` throw. Postgres-style                                                                                                                                                                                                                                                                                                                                                                 | **user**, "fine with it"                  |
| NaN                                                                                              | Predicates keep it JS-unordered; sort/min/max use a total order (NaN last, NaN == NaN) so both engines stay byte-identical                                                                                                                                                                                                                                                                                                     | settled                                   |
| `null`                                                                                           | A **stored, present value**, distinct from absence. Delete via `.properties(k).drop()` / `REMOVE`, never `SET null`                                                                                                                                                                                                                                                                                                            | settled                                   |
| Parallel names across GQL and Gremlin                                                            | **Intentional** — users pick one surface. Not a collision                                                                                                                                                                                                                                                                                                                                                                      | settled; do not relitigate                |
| A label / property / `WHERE` on a subpath-group **inner node**                                   | **Both engines refuse, consistently**, and the per-rep `WHERE` spelling expresses the same constraint (verified equal). A shared deliberate limitation with a workaround, not a gap                                                                                                                                                                                                                                            | probed 2026-10-08                         |
| `FALSE AND <data exception>`                                                                     | **`AND` short-circuits on FALSE, in WRITTEN ORDER, in both engines.** `OR`/`XOR` stay eager. ISO leaves it open (`US008`, `UA004`), so the choice was made on cost                                                                                                                                                                                                                                                             | **user**, 2026-10-08; **item 258**        |
| Conjunct order in a **FILTER** (clause `WHERE`, `FILTER`, `HAVING`, an inline pattern predicate) | **Unobservable, in both engines, so the conjuncts that cannot raise go FIRST.** A filter keeps only a clean TRUE (ISO §14.6), so a conjunct that is not cleanly TRUE settles the row — UNKNOWN included, unlike Kleene `AND`, where only FALSE settles. Spends no ISO latitude: it is the filter's contract, not a reordering of `AND`'s value. A **VALUE** position still keeps written order                                 | **user**, 2026-10-09; **item 259**        |
| The ordering KEY for that reorder                                                                | **Must be the SAME key in both engines.** A narrower whitelist in one engine is not caution, it is disagreement — restricting TS's to `=`/`<>` while the engine admitted any comparison produced **41 divergences in one 20,000-query run**                                                                                                                                                                                    | **item 259**                              |
| `SHORTEST k` (k >= 2) over an **unbounded** quantifier (`*` / `+`)                               | **Faults with `E_RESOURCE_EXHAUSTED` at `limits.trail`, in both engines.** The number of edge-disjoint trails is superexponential and nothing in the pattern bounds it — native used to enumerate them all and **take the process down from a 20-node, 60-edge graph**; TS had been faulting correctly all along. Not a new knob: the same ceiling the BFS selectors (`ANY` / `ALL SHORTEST`) always honoured                  | **item 373**                              |
| Placement of an entry in the aggregate fast-path `or_else` ladder                                | **Prefer DISJOINT gates so the order can be READ, not measured; where they contend, pin it with a direct assertion on the function** (items 369/376/612). An entry below one that claims its shape is dead code that passes every test it has, and the bench row reads 1.0x. "Disjoint by ARITY" was too strong — each entry reads `aggs[0]` then applies a CONTENT gate, so arity is reachable in one aggregate ordering only | **item 612**                              |

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
- **PARSE ERROR FIXED: an aggregate nested in a scalar function (436).** `abs(min(a.k))`,
  `coalesce(max(a.k), 0)`, `size(collect(a.k))` and `abs(count(*))` were all `unknown function`
  errors in native and answers in TS. Cause: the return-item parser asks `peek_agg()`, which looks
  at the item's FIRST token — so `max(a.k) + 1` reached the hoisting path and `abs(min(a.k))` fell
  to the plain-expression branch where `min` is not a scalar function. Hoisting is now on for every
  item and yields an `AggExpr` only when something was hoisted; with no aggregate the item is a
  plain `Key`, unchanged. Two mutants caught, the important one being "always `AggExpr`", which
  would collapse every plain projection into one group.
- **TS has the SAME arithmetic-predicate gap, at 1.91x — and the symmetric fix COMPILES AND IS
  NEVER APPLIED (439).** Same question as item 437, one shape per process, nine reps, selectivity
  fixed: `a.k > 5` 5.21 ms, `a.k + 0 > 5` 9.96 (1.91x), `abs` 2.74x, `coalesce` 2.18x, an AND of
  two comparisons FREE (as in native). Milder than native's 5.7x/21x only because TS's per-row
  floor is 16x higher (~26 ns against 1.65). A `CArithProp` lift on `directEqProps`/`satisfies`
  agreed with a `+ 0` oracle over 2,250 forms and moved NOTHING over three alternated rounds; a
  trace showed **"compiled" 8 times and "applied" ZERO** — these shapes do not consult the compiled
  `CPredicate`. **REVERTED**: a path that is correct, willing and unreachable reads as a fix in the
  diff while the query is answered elsewhere (item 418). **Open: which gate upstream declines**, and
  the next pass starts from a trace rather than a measurement.
- **BUILT: batch the label-bucket sweep — `DETACH DELETE` 5.5-10x (443).** `Store::delete_nodes`
  does the per-node work per node and `retain`s each label bucket ONCE for the batch;
  `delete_node` is now `delete_nodes(&[id])`, so there is one implementation. Per-node cost at
  40,000 nodes 8.43 -> 0.84 us (10.0x); 2,000 deleted 8.669 -> 1.189 ms (7.3x); 10,000 deleted
  43.776 -> 7.974 (5.5x); controls (DELETE edges, SET) flat. In the write screen `DELETE nodes`
  goes native 8.77 -> 1.30 ms, from a 1.5x outlier against TS to 9.4x, in the band with every other
  write. **Only DETACH is batched**: a plain DELETE's relationship check reads the CURRENT graph
  and an earlier detach can legitimately clear a later node's edges, so batching those would reject
  statements the interleaved order accepts — a mutant that does it is caught. Four mutants, all
  caught.
- **CORRECTION to item 442: restricting the sweep to the node's OWN labels would NOT have fixed it
  (443).** A deleted node is a MEMBER of the biggest bucket (`:Univ` holds every node), so its own
  buckets include the whole node set and the `retain` scans just as much. Restricting the SET of
  buckets does nothing when the node belongs to the large one; only removing the REPETITION helps.
  Checking before building is the only reason the named fix was not shipped.
- **PRICED, NOT BUILT: `DETACH DELETE` is O(deleted x TOTAL NODES) natively (442).** Native answers
  every other write in 0.31-0.81 ms at 20,000 nodes and `DETACH DELETE` in **8.77**. Three sweeps,
  each varying ONE thing: edges 8x with the deleted count fixed is **FLAT** (not an edge scan),
  the deleted count 50x is linear at a constant 4.3 us a node, and **the NODE count 8x is LINEAR
  per node (1.29 -> 8.43 us)** — which is the answer. `delete_node` says it in a comment:
  "Remove from every label bucket (no per-node label list yet, so sweep)", a `retain` over EVERY
  bucket per deleted node. **The fix is in the same function**: `labels_of(id)` is already called
  at the top, so removing `id` from just those buckets makes it O(its labels). `detach_442`
  committed — keep all three sweeps, any two are consistent with the wrong explanation.
- **A table whose rows all agree to within a third is usually measuring something they have in
  common (442).** The write probe's first version timed graph CONSTRUCTION with the write and
  returned 3.1-4.0x for all ten shapes; with construction and the verification read both outside
  the clock the band is 1.5-22.4x and the outlier is obvious.
- **`_MERGE` after a `MATCH` is a parse error in native and an answer in TS (442).**
  `MATCH (a:P) _MERGE (a)-[:E]->(a)` gives TS 42,000 and native "expected RETURN, SET, …". Same
  class as item 436. Recorded, not yet investigated.
- **STOPPED after three ticks: the TS arithmetic-predicate lift (441).** Prize was 1.91x on one
  shape; items 439/440/441 produced no measurable change and the loop's rule is to retract what does
  not survive. **Narrowed, for whoever picks it up:** the call sites are THREE not eight
  (`compileNode` executor.ts:4142, `patternCountOf` shortcuts.ts:1999, `nodeWhereOf`
  shortcuts.ts:4328), all with `ownVar=a`; the count shortcut ANSWERS rather than declining; and
  `asArithCompare` DOES match (`kind=arith tail=1 otherConst=true`, returning on the first side) —
  yet `satisfies` still receives `cmp=0 arith=0 where=YES`. Those three facts are unreconciled. Next
  trace: give each `compilePredicate` result an identity and print it at both ends.
- **AN INSTRUMENT AT THE GATE REPORTS WILLINGNESS; ONLY ONE ON THE RESULT REPORTS THE ANSWER
  (441).** Item 440's rung trace printed from inside `if (linear.countShortcut) {`, before calling
  it — so "RUNG countShortcut" meant the closure EXISTED, not that it answered, and most of a tick
  went on the belief that it might be declining. Calling it and printing ANSWERED/DECLINED refuted
  that in one run. Third form of this error after item 376 (an instrument covering part of the
  dispatch) and item 418 (correct, willing, unreachable): **a one-line trace is not automatically a
  good trace.**
- **TRACE FROM THE CONSUMER BACKWARDS, NOT FROM THE CANDIDATE FORWARDS (440).** Item 439
  instrumented the code it had just written (`asArithCompare`), which proved only that its own code
  ran. One line in the CONSUMER is the whole diagnosis: `satisfies` prints `cmp=1 where=no` for
  `a.k > 5` and `cmp=0 where=YES` for `a.k + 0 > 5`. That was available before a single line of the
  lift was written. Two ticks, no win, both spent on an assumption about which call site compiles
  the predicate.
- **Where the TS arithmetic lift actually stands (440).** Rung: `countShortcut` answers all three
  predicate forms, so it is NOT a rung difference. Consumer: `satisfies` IS reached and the plain
  form IS lifted (`cmp=1`). With item 439's `CArithProp` change re-applied, the clause-`WHERE` form
  still arrives `arith=0 where=YES` — so `directEqProps` is not populating it for THIS spelling,
  though the extractor matched 8 times on the inline and projection ones. **`shortcuts.ts` has at
  least eight `compilePredicate` call sites** (304, 409, 1999, 2087, 2805, 4328, 4602, …) and the
  one serving this shape is not the one that matched. Next step is reading, not measuring.
- **Item 371's rule is VERIFY THE DISPATCH REACHES THE FUNCTION — and it comes BEFORE the A/B
  (439).** I measured first, got a null result, then instrumented; the trace is three lines. Items
  418 and 420 checked firing before measuring and this one did not, at a cost of three alternated
  rounds on a change that could not move anything.
- **BUILT: the fused arithmetic filter arm, 5.0x (438).** `try_filter_keep_arith` admits
  `<prop> <arith> <lit> <cmp> <lit>` in all three spellings and evaluates the arithmetic inline in
  the keep pass: `a.k + 0 > 5` 1.932 -> 0.387 ms at 200k and 9.903 -> 1.978 at 1M, landing ON the
  plain comparison (0.299). `abs`/`coalesce`/`CASE` are DECLINED and flat, so nothing was levied on
  the general path. 2,250 forms compared against a `+ 0`-wrapped oracle; four mutants caught.
  **The mutant that ADDS an `is_finite` guard is caught** — the general path's raw-f64 arm does not
  test the result, so an overflow compares as infinity, and the `Expr::Arith` doc's "non-finite
  result yields NULL" describes the per-cell fallback only. A zero literal divisor DECLINES (the
  engine throws) and `lit / a.k` declines outright. **Still open and NOT more arm additions:**
  `abs` 5.9x, `coalesce` 21x, `CASE` 15x — the answer there is fusion, per 437.
- **PRICED, NOT BUILT: one arithmetic node in a filter costs 5.7x, a `coalesce` 21x, at IDENTICAL
  selectivity (437).** `exprpred_437` holds the row count fixed and varies only the predicate's
  shape: `a.k > 5` 0.365 ms, `a.k + 0 > 5` 2.087, `abs(a.k) > 5` 2.169, `coalesce(a.k, 0) > 5`
  7.815, `CASE …` 5.409 — all selecting 90,908 of 200,000, ratios holding at 1M. `a.k > 5 AND
a.k < 100` is FREE (1.05x) and `NOT (a.k <> 1)` is exactly its positive form, because both are in
  `try_filter_keep`'s pattern list. **Two wrong guesses recorded: it is NOT a per-row tree walk
  (`eval` is columnar) and NOT boxing (`Col` is typed, `read_property` returns `Col::Num`, arith has
  a raw-f64 arm).** It is MATERIALIZATION — one column per expression node, four passes and three
  allocations against the fast path's one pass and none. Fix is expression FUSION (or a compiled
  closure, which is what TS does — item 433 again); the deferred "eval-vs-columnar floor" question.
  **Bounded partial for next: add `Compare{Arith{Prop, Lit}, Lit}` to the pattern list**, covering
  `a.k * 2 > 10`. **Constant folding is NOT the answer** — it would erase this probe's numbers and
  buy nothing, since `a.k * 2 > 10` cannot fold soundly over floats.
- **Item 434's perf screen has found TWO correctness divergences and no perf candidate (435, 436).**
  **Comparing answers while you time things costs nothing and has been worth more than the
  timings.** Still unexamined there: CASE, coalesce and arithmetic predicates at the bottom of the
  ratio band (2.3-5.2x), which is a perf question.
- **WRONG ANSWER FIXED: native's `ANY SHORTEST` dropped the endpoint's LABEL (435).**
  `MATCH ANY SHORTEST (a:P)-[:E]->{1,3}(b:P)` returned every reachable node — its answer for
  `(b:P)` was its answer for `(b)` — while the TS engine and the same pattern WITHOUT the selector
  both filtered correctly. The lowering said it: "its label is ignored (as for any landing node in
  this subset)", and `landing_label_filter`, the helper for a node with no `Scan` to carry a seed
  label, was never called. One call. Verified against TS as MULTISETS at 50/200/1000 nodes over
  five shapes. **Found by item 434's perf SCREEN, which compares answers because it costs nothing
  to** — the differential fuzzer generates no quantified paths, a gap already recorded.
- **FIVE fixtures this session looked like they exercised a guard and did not, and the common
  thread is VACUITY (435, and 422/425/427/429).** Four hand-built reproducers for this bug — a
  diamond, a self-loop, a 2-cycle, a triangle — all agreed before the fix, because every node in
  them was `:P`, and a vacuous label is one you can drop for free; three rounds went into hunting a
  size threshold that did not exist. The compound-label mutant then survived `:P|Q`, which matches
  every node in the fixture. **Every label and predicate in a fixture must EXCLUDE something, or it
  tests nothing.**
- **An instrument for that, and a NEGATIVE first answer (434).** `engine-gap-probe`
  (`bun run probe:gap`) times 25 shapes on both engines over one shared edge list and reads the
  ratio: the normal band is 1.5-4x, a native-only shortcut pushes it to 380x, so **native barely
  ahead or behind is the signal**. Three rows came in below the band and all three are the HARNESS.
  Among readable rows the lowest is 13.6x, so this shape set holds no native-missing-path candidate
  of item 432's kind.
- **Native row EGRESS is 58 ns a numeric row and 94 ns a string row — the floor for any multi-row
  native query (434).** Three controls doing the same scan and differing only in rows out:
  `count(a.u)` 0.01 ms, 5,000 numbers 0.33, 5,000 strings 0.48. The scan is 0.01 and the rest is
  crossing FFI and building a JS object per row, which TS never pays. **So compare the engines on
  AGGREGATE shapes or through Arrow, never on row-returning shapes through the object API** — the
  row count sets the result. The probe marks those rows `*`, and rows where both sides are under
  the clock's resolution `~` (`node count` divides 0.0 by 0.00 to a meaningless 0.5x).
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

## 444 — a named-but-unread edge variable cost 3.7x on the TS hop fast path: CLOSED

`MATCH (a:P)-[e:E]->(b) RETURN count(b.k)` measured 4.6ms against 1.25ms for the identical query
spelled `-[:E]->`. `detectHopProjection` refused a named rel outright; it now refuses only one
whose name is MENTIONED in the `RETURN` or the clause `WHERE`. **3.4-4.2x**, and the two spellings
now cost the same, with two structurally-unreachable controls flat.

Three things to not re-derive:

- **The guard was load-bearing, and its own comment said it was not.** It claimed the projection
  guard already rejects any item reading a name other than the far variable. False for a
  SUBQUERY: `freePredicateVars` adds an inner pattern's binding names to its bound set, so an
  inner `-[r:T]->` correlating on an already-bound `r` reports NO free variables.
  `MATCH (p:U)-[r:T]->(q) RETURN COUNT { MATCH (p)-[r:T]->(z) }` must be 1 per row and was `p`'s
  degree. The fix asks "does the name appear anywhere", which is not an analysis and so cannot be
  fooled. Second comment in the audit refuted by running it (item 420 was the first).
- **The clause-`WHERE` half of the guard is defence in depth, not the active guard**, and both the
  code and its test now say so. Mutation survived with it removed, and survived again with
  `carriedWhere`'s neither-endpoint refusal removed too: `rowLocal` is what refuses a subquery
  clause `WHERE` here. It stays only because the projection half proves free-variable analysis
  cannot see this correlation.
- **The TS edge-write gap is mostly NOT the write.** Of a 7 ms `DELETE e`, 5.6 ms is the read that
  binds `e`. Do not price a TS edge write without subtracting its read first.

OPEN, found here and not fixed:

- **A wrong answer**: a correlated rel variable in a COUNT subquery inside a clause `WHERE` makes
  the predicate unsatisfiable at EVERY value — `WHERE COUNT { MATCH (p)-[r:T]->(z) } = n` returns
  nothing for n = 0, 1 and 2, and `IS NULL` is empty too. The same subquery in `RETURN` is correct,
  and the `EXISTS` spelling is correct. Unrelated to the gate above, which declines the shape.
- **Projecting an edge costs 100x projecting a node** on the cross-engine bench: `project the edge`
  607.1 ms lazy / 1018.7 materialized against `project the element` 5.7 / 27.2. Both edge rows read
  the edge, so they decline this fast path.
- **Native has no bound-endpoint `_MERGE`.** `MATCH (a:P) _MERGE (a)-[:E]->(a)` works in TS and is
  a parse error in native, which accepts `_MERGE` only as a leading statement with unique-key-
  resolved endpoints. A row-driven `MergeEdgeFrom` plan, not a parse fix.

## 445 — "projecting an edge costs 100x projecting a node": RETRACTED, and replaced by a real 6.9x

The bench rows behind that claim use different fixtures (`nodesDoc` 200k nodes vs `graphDoc` 1M
edges), so 607.1 ms against 5.7 is 607 ns/row against 28.5 — 21x, not 100x. And the 21x is not
about edges at all. On one fixture with one traversal and 200,000 rows either way,
`RETURN b, r.w` costs 727 ns/row and `RETURN r, r.w` costs 722: **rendering an edge is free**.

What the comparison was really measuring is the ROUTE, and item 444 is what made it a confound —
`RETURN b` with a named `r` reaches the hop fast path only because 444 admitted it, while
`RETURN r` mentions the rel and declines. **A ratio between two queries is a ratio between two
routes until you have shown they take the same one.**

OPEN, and larger than the retracted lead: the hop fast path costs ~105 ns/row against the general
path's ~720-815, **6.9x**, and every one-hop query mentioning its rel variable pays it (`RETURN
r`, `RETURN r.w`, `WHERE r.w < 100`). The fix is to BIND the edge in the walk — `expand` already
yields `{ edge, node }` — and let `projectedEndsOnly`/`carriedWhere` admit the rel variable as a
third legal name. Priced, not built. Instrument: `bun run probe:route`.

## 446 — reading a relationship variable on a one-hop query: 3.1-3.4x, CLOSED for the unfiltered half

The hop fast path now BINDS the edge, so `RETURN r` and `RETURN r.w` are served instead of
declining to the general path. `expand`'s bucket loop already holds the edge, so it is one
`Map.set` per edge. Measured same-fixture, one case per process, min of 9: 632 -> 186, 613 -> 200,
757 -> 239 ns/row. Four controls flat.

Three things to not re-derive:

- **Item 445's 6.9x was not the achievable prize**; 3.4x was. 445 compared the general path to the
  FAR-driven walk, which cannot serve this shape: its 2.3x comes from hoisting `projectRow` to
  once per far VERTEX, valid only because every item it admits is a pure function of the far end.
  An item reading the edge is not. **A fast path's cost is only a ceiling for the shapes it can
  actually take**, and hoisting here is a wrong answer rather than a fast one.
- **Item 444's gate is narrowed, not removed.** It declines a mention the path cannot SEE —
  mentioned AND a subquery present — because `freePredicateVars` is complete over a fragment with
  no subquery, and that completeness is what the binding relies on. Turning that off in the
  unsafe direction is caught by two tests.
- **A guard has two mutation directions and only one is unsafe.** Mutating the subquery guard to
  `true` makes it more conservative and survives, which momentarily reads as a missing test.

OPEN, and now measured rather than described: `filteredHopWalk` binds no edge, so a far predicate,
a carried clause `WHERE`, or a start-reading item still declines when the rel is read —
`WHERE r.w < 100 RETURN b` stays at ~772 ns/row. It is a `spelling-probe` group reporting **2.7x**,
labelled expected-over-threshold with the item number so it is not chased as a regression.
Instrument: `bun run probe:route`.

## 447 — a rel-reading clause `WHERE` on the hop fast path: 2.6x, CLOSED. Item 446's open half is done

`relBoundFilteredHopWalk` binds the start, the far end and then the EDGE, before the far predicate
and the gate. `WHERE r.w < 100 RETURN b` goes 796 -> 310 ns/row; 446's two wins and four other
controls flat. The `spelling-probe` group 446 added at 2.7x now reports 1.31x.

Two things to not re-derive:

- **The suite had no case where a clause `WHERE` reads the rel while the PROJECTION does not**,
  and the half-applied change — `carriedWhere` carrying the predicate, no walk binding the edge —
  returned the EMPTY SET for three mutually exclusive predicates while 2,128 tests passed. Every
  test item 446 wrote projects `r`, which routes through `itemsReadRel` and never exercises the
  `carriedWhere` half of the decision. A far-only projection with a mixed filter is the shape that
  distinguishes them.
- **The start-only decline is kept deliberately.** The start-only walk gates a vertex BEFORE
  reading its adjacency (item 164), where no edge is bound, and it carries bespoke raise-parity
  handling (items 139/142/144/145). Two mutants relaxing that survived, which means answer-
  preserving in the tests — not that the walks are equivalent on faults.

Still OPEN on this path: the far-driven walk cannot serve any rel-reading shape at all, because
its 2.3x is a `projectRow` hoist to once per far VERTEX (item 167). So a rel-reading query over a
graph where the far end enumerates fewer vertices takes the start-driven walk rather than the
cheaper one. Not a gap to close by relaxing the hoist — that would be a wrong answer — but a
reason the ceiling here is ~190 ns/row and not ~110. Instruments: `bun run probe:route`,
`bun run spelling`.

## 448 — porting items 446/447 to native: NOTHING TO PORT, and the apparent native gap is item 289

With egress held equal (every case projecting one scalar, so item 289's carrier cancels), native
measures 59-75 ns/row for an anonymous rel, a named-but-unread rel, a rel READ, a rel-reading
clause `WHERE` and a far-reading clause `WHERE` — flat, all five. **Native pays nothing to name,
read or filter on a relationship variable**, so the 3.4x and 2.6x items 446 and 447 closed on the
TS side have no native twin.

What looks like a native gap is projecting a whole ELEMENT: 931 ns/row for `RETURN b` and 1065 for
`RETURN r`, against ~60 for a property. That is **item 289, already closed** — the JSON carrier,
~80% of it, `queryArrowIpc` being the answer. Confirmed here independently: `count(r.w)` over the
same 200,000 edges is 1.1 ms (5.5 ns an edge) against `RETURN r.w` at 12.0 ms, so a scalar row
costs ~55 ns to carry and an element row ~1010.

Two method notes:

- **`count(b)` and `RETURN b LIMIT 1` are NOT instruments for this.** They read 0.1 ms and 0.007
  ms and look like proof that element rendering is free; both are shortcut-answered with no
  traversal at all. An instrument answered by a fast path measures the fast path.
- **A gap found in one engine is a QUESTION about the other, never a finding.** Items 432/433,
  443 and now 446/447 all had this shape. `ENGINE=native PCASE=… bun run probe:route` makes the
  question one command.

## 449 — `coalesce` and `abs` in a native filter: CLOSED at 25.9x and 5.8x

`try_filter_keep_call` fuses `<scalar fn of one prop> <cmp> <lit>` into the keep pass, the same way
item 438 fused arithmetic. `coalesce(a.k, 0) > 5` goes 38.435 -> 1.466 ms at 1,000,000 nodes
(**25.9x**) and `abs(a.k) > 5` 10.582 -> 1.787 (**5.8x**), both landing on the plain comparison's
cost. Function set is `unary_finite_num_fn` (abs/floor/ceil/ceiling/round/sign) plus `coalesce`
with a literal default.

Item 437's three leads are now two closed and one open: **`CASE` remains at 14.5x / 16.6x**, is
`Expr::Case` rather than `Expr::Call`, and was the control for this change (flat, as required).

Three things to not re-derive:

- **The two families disagree about the absent cell, and that IS the item.** A unary numeric
  function DROPS it (NULL → UNKNOWN); `coalesce` KEEPS it with the default substituted. Verified
  against the general path before writing the arm: `coalesce(a.k, 0) > 5` answers 1 and
  `coalesce(a.k, 99) > 5` answers 2 over the same three nodes. An arm skipping absent rows answers
  1 for both and passes the obvious test.
- **A column absent everywhere must DECLINE, not answer empty.** `coalesce(a.missing, 99) > 5`
  keeps every row (3 of 3). An empty keep-list reads like a correct "nothing matches".
- **The OPTIONAL-miss sentinel is declined for `coalesce` deliberately**, because `WHERE` inside
  `OPTIONAL MATCH` is a parse error, so the shape cannot be measured against the general path and
  either skipping or substituting would be a guess.

Also: `cargo clippy` from the repo root WITHOUT `--manifest-path` exits 101 with "could not find
Cargo.toml" — there is no root workspace. That reads like a lint failure and is not one.

## 450 — a boolean `CASE` in a filter: CLOSED at 24.9x. Item 437's three leads are all closed

`try_filter_keep_case` UNWRAPS `CASE WHEN c THEN true [ELSE false|null] END` in a filter and
delegates the condition back to `try_filter_keep`, evaluating nothing itself. 26.676 -> 1.072 ms at
1,000,000 nodes (**24.9x**); the no-`ELSE` spelling 27.795 -> 1.077 (**25.8x**). Three uncovered
CASE shapes were the controls and stayed flat.

Four things to not re-derive:

- **The ARMS are irrelevant; `Expr::Case`'s OUTPUT is the cost.** Five CASE shapes measured within
  a third of each other (5.2-6.0 ms at 200k), which is item 442's tell for a shared cause: the
  eager path collects `Col::Gen`, N boxed `Value`s. An arm-by-arm fusion like items 438/449 would
  have been the wrong shape of fix, and measuring the family first is what said so.
- **The collapse is sound in a FILTER and nowhere else**, because a filter drops FALSE and UNKNOWN
  identically. In a PROJECTION the same `CASE` yields `false` where `c` yields NULL.
- **`ELSE true` and `THEN false` are the COMPLEMENT, not the condition** — UNKNOWN takes the ELSE.
  Both mutants admitting them are caught.
- **An oracle spelling is part of the claim.** `(<case>) = true` is NOT a neutral wrapper: for a
  non-boolean arm the bare form RAISES while the comparison answers, because `0 = true` is FALSE
  rather than an error. Item 432's lesson from the other direction.

STILL OPEN, both measured and both with instruments:

- **The bare predicate is 1.4x SLOWER than the same predicate wrapped in a CASE** — 0.30 against
  0.21 ms, isolated one case per process over three rounds (`cargo run --example caseinv_450 --
<bare|case|casenoelse|control>`). An equivalent-spelling inversion: the bare form takes a route
  costing more than the keep pass the CASE delegates into. The shared-process table said 1.6x and
  isolation said 1.4x, which is why item 274's rule applies to inversions too.
- **Multi-branch and complement CASE shapes stay at the general path's cost** (~29-34 ms at 1M). A
  multi-branch all-`true` CASE is the sorted MERGE of its conditions' keep-lists and
  `THEN false ELSE true` is the complement; both are correct and neither is written.

## 451 — a filtered `count(*)` with one numeric bound: CLOSED at 3.7x. The inversion was a symptom, not the size of the cause

`try_stream_num_count` ran `bounds.iter().all(…)` — a heap `Vec`, a loop and a runtime `op` match
— ONCE PER SCANNED NODE. Hoisting a single bound into a monomorphic closure gives 1.681 -> 0.460 ms
at 1,000,000 nodes (**3.7x**), 0.30 -> 0.095 at 200,000 (**3.2x**). Four controls flat, the
load-bearing one being the SAME query with two bounds (still the general arm, 1.774 ms, unmoved).

Three things to not re-derive:

- **Item 450's 1.4x inversion was worth 3.7x.** A gap between two spellings bounds NEITHER one's
  distance from the floor: the two differed by the cost of a keep-list as well as by the
  per-element test. Chase the cause, not the gap's size.
- **The plans are identical** — `Project(Aggregate(Filter(Scan)))` for both spellings, differing
  only in the predicate node — so this was never an optimizer route. `PLAN=1 cargo run --example
caseinv_450 -- <case>` prints them. The question was which RUNTIME fast path each predicate
  reaches, which a plan cannot answer.
- **A streaming count with no allocation losing to a path that materializes a 200,000-id batch AND
  a 91,000-entry keep-list is the tell** that per-element cost, not allocation, is deciding.

STILL OPEN: **two bounds cost 3.9x one bound** (1.774 against 0.459 ms at 1M), because the
multi-bound arm still iterates the `Vec` per node. Specializing it means either 36 operator pairs
or getting the bounds onto the stack; neither is written.

## A pre-existing cross-engine divergence: a non-boolean `CASE` inside a boolean `AND`, in an INLINE node `WHERE`

Found by one differential-fuzz run on a random seed during item 451, and verified NOT to be caused
by items 449/450/451. Standalone reproducer (worth more than the seed, which was the QUERY's seed
rather than the run's and replayed clean):

```
MATCH (t:T) OPTIONAL MATCH (t)-[:E]->(n WHERE (CASE WHEN (null <> n.s) THEN date('0001-01-01')
  WHEN (3.14 <> 0) THEN n.nan ELSE zoned_datetime('2020-01-01T00:00:00Z') END
  AND (0.1 IN [0.0, 'A')))) RETURN t.n AS x, n.n AS y ORDER BY x, y
```

Native answers `[{x:1,y:null},{x:2,y:null}]`; TS raises `a boolean is required`. The `CASE` yields
a temporal or a number, which is then an operand of `AND`. **Native's inline-node-`WHERE` path
treats a non-boolean as not-true and rejects the row; TS raises.** Both engines raise for the same
shape in a CLAUSE `WHERE` — item 450's restriction test asserts native raising there — which makes
native's INLINE path the suspect rather than the rule being unclear.

How it was ruled out, in the order memory's `gremlin-fuzz-families` note prescribes — structurally
first: the `CASE` has TWO branches so item 450's arm declines it, and `num_conj_on_slot` returns
`None` for a `Case` so item 451's cannot see it. Then empirically: `git checkout 8ebc6256 --` the
two engine files, rebuild, and the pre-450 engine gives the IDENTICAL answer. Rate: 1 of 4 full
runs, three subsequent differential runs clean.

## 452 — the AND-fault-order divergence, MINIMISED. Same class as items 321/322; the recorded shapes overstate what it needs

Item 451's fuzz failure is this already-recorded class, and item 452 re-derived it before checking
— the declaration lives in `executor.ts`'s `case 'and'` comment ("a filter … whose cheap conjunct
Rust's seek hoisted past a raising sibling"), in `seed-gate-order.test.ts`, and in the entries
above. **"Is this divergence known?" is a `CLOSED.md` question; ask it before diagnosing.**

What is new is the size of the reproducer. Every recorded one is a fuzzer query with an `OPTIONAL
MATCH`, an inline node `WHERE`, a multi-branch `CASE` and a temporal, which implies the class needs
an exotic expression. It needs none of that:

```
MATCH (n:N) WHERE (n.n AND (0.1 IN [0.0, 2])) RETURN n.n AS y
  native []   vs   TS raises "a boolean is required"
```

Two vertices, a plain scan, a clause `WHERE`. The trigger is **a non-boolean first conjunct plus a
sibling whose FALSE is COMPUTED rather than literal**. The boundary, measured:

- `(n.n AND false)` — agrees (both fold/short-circuit the literal).
- `((0.1 IN [0.0, 2]) AND n.n)` — agrees (the FALSE is first in written order, so both stop).
- `(n.n AND (0.1 IN [0.0, 2]))` — diverges, in a clause `WHERE`, an inline node `WHERE`, with and
  without `OPTIONAL MATCH`, and over a plain scan as well as a hop.

Still OPEN and still not a perf change. ISO permits both (`US008`, `UA004`) and the repo has a
dated user decision preferring the cheaper FALSE, so aligning means either deferring faults in TS
until no conjunct settles the row (a `try`/`catch` per conjunct in the hot boolean path) or making
native evaluate in written order (giving up item 175's 267.61ms -> 5.26ms). Item 322's first fix
was wrong in the OTHER direction and created two new divergences: **being wider in one engine is
the same mistake as being narrower.**

## 453 — the two-bound range count: CLOSED at 3.9x. Item 451's open follow-up is done

Four monomorphic arms for `(lo_incl, hi_incl)` take `a.k > 5 AND a.k < 100` from 1.782 to 0.458 ms
at 1,000,000 nodes, landing exactly on the single-bound cost. Both written orders measure the
same. Three controls flat.

Three things to not re-derive:

- **The `Vec` was not the cause.** Pulling the bounds into loop-invariant locals — item 451's
  stated diagnosis — measured ~1.12x and left two bounds at 3.5x one bound. **A fix that is
  directionally right and 9% refutes the cause rather than partly confirming it.** The cause is
  VECTORIZATION: a monomorphic `Fn(f64) -> bool` auto-vectorizes, a pair of `num_pred` matches
  does not.
- **A fast path can cost a shape it never runs.** Written inline, the range arm made the
  THREE-bound shape 1.4x slower (1.978 -> 2.78 ms) although that predicate never enters the
  two-element arm — the function grew and LLVM inlined `scan_visit` differently for the arm that
  follows. Extracting it recovered part (2.20); extracting it AND marking it `#[inline(never)]`
  restored it (1.948). **The `#[inline(never)]` is load-bearing with a measured reason.** Same
  family as `exec::pull`'s layout (item 90/250) and `ts-closure-size-is-load-bearing`.
- **The first run after `cargo build` is not a measurement.** It read 0.685 where three subsequent
  rounds read 0.458 — a 1.5x phantom, nearly written down as 2.6x instead of 3.9x. Min-of-9 inside
  one process does not fix a cold first process.

Not extended to 36 operator pairs: a range is the shape that matters and the rest decline to the
general arm, which keeps the code-size cost off a build that targets wasm. Non-range pairs (two
lower bounds, two equalities, a `<>`) and 3+ bounds stay on the general arm. Instrument:
`cargo run --example caseinv_450 -- <two|tworev|three|bare|control> 1000000 9`.

## 454 — TS's filtered node count: NO CLIFF to port, and the `EvalEnv` hoist is REFUTED

Asking TS the ladder items 451/453 answered for native: 200,000 nodes, same selectivity, one case
per process — no predicate 0.0 ms (O(1) off the bucket), one bound 4.4-6.4, two bounds 5.9-6.4,
two bounds reversed 5.8 (no spelling gap), three bounds 7.1-8.9. **Roughly linear in the conjunct
count**, nothing like native's pre-453 shape where the second bound cost 3.9x the first. Native's
cliff was a lost auto-vectorization; TS pays a closure per conjunct per vertex. Nothing to port.

**REFUTED: hoisting `satisfies`'s `EvalEnv` out of the per-element call.** It allocates
`{ binding, params, graph }` on every call — 200,000 objects to count a filtered label bucket —
and the object is stateless, so `satisfiesIn(element, pred, env)` is trivially sound. Measured
three rounds each side: one bound 4.4/6.4/4.4 against 4.8/5.0/5.3, two bounds 5.9/6.4/6.2 against
6.2/6.2/6.7, three bounds 8.9/7.3/7.1 against 7.2/7.5/7.5. The spread WITHIN each configuration
exceeds any difference between them — V8 escape-analyses an object that never leaves the call.
Reverted; the numbers live in a doc comment on `satisfies`.

**"It allocates per element" is not by itself a cost.** Item 424 rejected the same belief about a
per-row allocation in the top-k path at 2.4%. That is twice; the next instance should be measured
before it is written.

## 455 — `5 <= n.k` vs `n.k >= 5`: NOT a gap. The probe's own flag, and the rule that let it stand

`spelling-probe`'s `range operand order` group has flagged 2.4-2.5x every run and has no item
anywhere. It is an artifact, confirmed three ways: isolated one case per process over three rounds
the two read 4.4-4.6 ms either way (equality likewise, 3.8-4.1); the probe is BIMODAL on it across
five runs — 5.40/13.19, 5.28/5.33, 5.38/13.11, 5.58/13.54, 5.40/5.35, two distinct modes 2.5x
apart, not a spread; and `SPELL_ONLY='range operand order'` gives 4.47/4.44, 4.44/4.40, 4.38/4.42.

**The correction to items 180/181.** Those found the position penalty and fixed it by timing every
spelling in both positions and keeping its better reading, concluding "a spelling that is
genuinely slower is slower from either position". **A per-process deopt is slower from either
position too** — the 13.1 ms readings are already the min across both passes and nine reps. The
rule is necessary and not sufficient; only a separate process is sufficient.

So **any `bun run spelling` flag needs isolated confirmation before it is a claim.** That is now
one command: `SPELL_ONLY=<substring> bun run spelling`, added here. The group keeps its flag and
carries the refutation in a comment — a group deleted for being inconvenient is how a probe stops
being trusted.

## 456 — a three-hop count's interior gate from an INLINE constraint: CLOSED at 18x

`interiorPredOf` read a clause `WHERE` only, so `(b {k: 2})` and `(b WHERE b.k = 2)` fell past the
gated degree product that `WHERE b.k = 2` took: 240.80-246.19 ms against 12.85-15.44, isolated one
group per process. Now 12.36-13.72 for all three spellings. `inlineInteriorGate` builds the same
`{ pred, onB }` from `inlineOf`.

Three things to not re-derive:

- **POSITION B ONLY, and the restriction is measured.** The first version gated `c` through the
  product too and made that shape 1.25x SLOWER — 369 ms on the sweep it had been taking against
  460 on the product — because the walk ITERATES `b` (once per vertex) but meets `c` once per
  middle EDGE (item 222's reasoning). Only the THIRD-position group in the same probe showed it:
  **an argument for a probe keeping neighbours it is not currently investigating.**
- **I guessed the cause twice and a four-line trace ended it in one run.** Both guesses were
  about routes declining; the truth was `interior=false` reaching a different branch. Item 441's
  rule (verify the shape reaches the path BEFORE measuring) is cheap, and skipping it cost a
  written-and-reverted change that measured no difference because its branch is never taken.
- **Four of five mutants survive and none is a gap**: the null control; a second interior gate
  (the product declines what it cannot express, so the route falls through); an OPEN constraint
  (`{k: a.k}` answers the same either way); and the inline gate overriding the clause (EQUIVALENT
  — the clause block runs later, so order already gives it priority). `onB` is the load-bearing
  one, failing seven tests.

`bun run spelling` now has NO genuine gap outstanding: the two groups still over 2x are item 455's
harness artifact and a 0.00 ms degenerate.

## 457 — the gap screen's `coalesce`/`case` rows are the GENERIC SCALAR-CALL PATH, not those functions

Priced natively at 1,000,000 nodes: `count(a.k)` 0.466 ms is the floor; the vectorized arm gives
`round` 4.301 and `abs` 4.824; the generic path gives `coalesce(a.k, 0)` 37.518, `count(CASE …)`
28.396 and **`power(a.k, 2)` 45.193**. The generic pair land together and ~9x above the vectorized
pair, so the per-row overhead is ~33 ns and belongs to the PATH.

**A `coalesce` special case would have been the wrong fix** — it would have moved the gap-screen
row it was chosen from while leaving `power`, `concat`, `substring`, `replace` and every other
non-vectorized scalar exactly where they are. Two diagnoses were needed to get here: first that
the probe's `coalesce(a.missing, a.k)` is the FUNCTION and not the absent column (the present-column
spelling is 37.5), then that `power` is slower still.

What remains per row: boxing each argument through `Col::value_at`, `call_scalar_checked(name, …)`
matching the function NAME as a STRING against dozens of arms, and pushing a boxed `Value` into a
`Col::Gen`. The per-row `Vec` allocation is ALREADY GONE (one reused buffer), so that lever is
spent. The fix shape is to resolve the name to a function pointer once before the row loop.

OPEN with numbers, both from `cargo run --example exprpred_437`:

- **The generic scalar-call path, ~33 ns/row / ~9x**, for every scalar function lacking a
  vectorized arm.
- **A nested arithmetic predicate is 5.4x a flat one** (11.091 vs 2.061 ms, same row count):
  `try_filter_keep_arith` (item 438) admits `Prop op Lit`, and `a.k * 2 + 1` is
  `Arith(Arith(Prop, 2), 1)`.

## 458 — `coalesce` over columns: CLOSED at 8.9x. Half of item 457's target is done; the general half is not

`count(coalesce(a.k, 0))` goes 31.2 -> 3.44 ms at 1,000,000 rows, landing on the vectorized floor
(`count(abs(a.k))` is 4.78). The absent-first-argument spelling goes 37.0 -> 22.0, 1.67x. Four
controls flat (`power`, `sqrt`, `abs`, `count(a.k)`).

**Item 457's warning was right about one half and wrong about the other.** Two wins, and only one
is general:

- **A first argument that cannot be null makes `coalesce` the IDENTITY.** `Col::Num`/`Bool`/`Str`
  have no null representation, so no later argument is reachable. That is the 8.9x, and **no
  general dispatch fix could ever give it** — it is a semantic property, not an overhead.
- **The dispatch resolved once** is the other 1.67x, and that one IS what a general resolver
  would give every non-vectorized function. So item 457's target stands with its size now known:
  the per-row `call_scalar_checked(name, …)` string match is ~15 ns of the ~27 ns fixed overhead,
  with per-argument boxing at ~6 ns each (measured by adding arguments: 2/3/4 args = 31.9/37.7/45.0).

Three things to not re-derive:

- **`Nodes`/`Edges` must be excluded from the identity** — the `u32::MAX` OPTIONAL-miss sentinel
  IS a null there. Untested until mutation said so; needs a fixture with one matching and one
  missing optional hop.
- **Raise parity is the semantic at risk.** `coalesce` stays lazy in the VALUE sense but must
  evaluate every argument column, because the path it replaces does: `coalesce(a.k, 1/0)` raises
  in BOTH engines even though the first argument is non-null everywhere.
- **An empty env var still satisfies `is_ok()`**, so `EXP458= cargo run` left the experimental arm
  ON and the first A/B compared it against itself. Use `env -u`.

OPEN, pre-existing, found here: **`coalesce` over a NODE column renders raw ids natively** where
TS renders the element (`coalesce(z, a)` -> `[2, 1]`). Verified against the previous commit. The
fallback itself is correct in both engines.

## 459 — resolving a scalar function's NAME once: CLOSED at 2.6x. Item 457's general half is done

The generic scalar path matched the function NAME as a STRING per row. Sized first by bypassing
it for `sqrt` alone (32.4 -> 12.5 ms at 1,000,000 rows, boxing and boxed output still in place),
so the dispatch is **~20 ns a row**, not item 457's guessed ~15. `unary_num_fn` resolves all
twenty-one unary numeric functions once; the **fifteen without a vectorized arm** — `sqrt`,
`exp`, `ln`, `log10`, the trig and hyperbolic families, `cot`, `degrees`, `radians` — go
33.95/33.50/32.86 -> 12.93/12.65/12.73. Four controls flat.

Four things to not re-derive:

- **The output stays BOXED deliberately.** These functions can make a NaN or an infinity from a
  finite input; `unary_finite_num_fn`'s arm builds a `Col::Num`, and a stored numeric column is
  all-finite. This arm removes the dispatch and owes no such invariant.
- **`#[inline(never)]` and its own function are load-bearing.** Inline, the arm cost shapes it
  NEVER RUNS — `power` 45.9-47.1 -> 47.8-48.5 and `coalesce` 3.50-3.63 -> 3.78-3.88 — and split,
  the controls return to flat and `sqrt` improves further (14.6 inline vs 12.7 split). Second
  occasion of item 453's layout finding, different file.
- **A non-numeric argument RAISES, it does not become NULL.** `call_scalar_checked` validates a
  named function's non-null arguments (`sqrt('1e300')` throws) where an arithmetic operator would
  propagate. The first version used `num_of` and answered NULL;
  `a_raising_predicate_still_raises_when_it_is_reached` caught it immediately.
- **TWO COPIES OF A BODY MAKE A MUTANT MEANINGLESS.** `unary_finite_num_fn` kept its own `sign`,
  so flipping the NaN guard survived — `s///` hit one copy, the test routed through the other. It
  is now the restriction LIST and delegates for bodies; the mutant is caught.

`degrees` using `to_degrees` (one ULP off, the comment's warning) survives the unit suite and IS
caught by the differential fuzzer — verified by applying it, not assumed.

OPEN, pre-existing, found here: **`cot` at zero diverges between the engines** —
`0.0 <= cot(0.0 * n.x)` and siblings. `FUZZ_SEED=2724363121` replays deterministically and
**fails at HEAD too** (both files reverted and rebuilt). A hand-built three-node fixture did not
reproduce it, so the fuzzer's fixture is part of the shape; the seed is the reproducer.

## 460 — item 459's wrong answer, and the check that would have caught it before the push

Item 459's arm called `f(x)` on the raw `f64` from the column, skipping `num_of`'s -0.0 -> +0.0
collapse. The numeric model has NO negative zero and `num_of`'s comment names the casualty:
`cot(-0)` is -Inf under IEEE and +Inf under the policy. So `0.0 <= cot(0.0 * n.x)` answered FALSE
for negative `x` where TS answers TRUE. **CI went red.** Fixed by routing through
`value::num_of`; the 2.6x is unaffected (12.89-13.04 ms against 12.65-12.93).

**A RUN FAILING IS NOT THE SAME QUERY FAILING.** I replayed the seed against HEAD, saw the run
fail, and wrote "pre-existing, verified". It did fail — on a DIFFERENT query: that seed carries
both the `cot` divergence I had just introduced AND item 452's known `AND`-fault-order residual.
Checking the exit code of a 20,000-query run answers "does this seed fail", which is not the
question. **Run the OFFENDING QUERY against the previous build** — thirty seconds, and it gives
`true, true` at 458 against `false, true` at 459. Item 451 did exactly that and was right; the
difference between the ticks is which thing got compared, not how careful they were.

Two further notes:

- **A regression test that has not failed against the bug it describes is a guess.** The -0
  assertions here were verified by re-introducing the bug (`f(if x == 0.0 { -0.0 } else { x })`),
  which they catch.
- **`git checkout -- <path>` reverts to the INDEX**, which is HEAD — it wiped the fix mid-tick
  after a mutant run. Restore from a saved copy, not from git, when the working tree holds
  uncommitted work.

## 461 — the ±0 class, swept and pinned: NO second instance, and it is no longer luck that finds it

Item 460's fix closed one negative-zero bug. This closes the CLASS.

**Swept** (the "grep the pattern elsewhere" step item 459 skipped): a STORED -0 is harmless,
because the arith filter arm (438) and the count sweeps (451, 453) read raw `f64`s but only
COMPARE, and a comparison cannot see the sign of zero. A COMPUTED -0 reaches exactly two
operations: `cot` (which is `1/tan`) and division — and division RAISES on a computed zero rather
than yielding an infinity, so the class is `cot` alone. `floor`/`ceil`/`round` PRESERVE a -0 into
the next column, which is the route a neighbouring arm could have failed by; checked, and it
agrees after 460. Eleven shapes, nine of them comparable cross-engine, all agreeing.

**Pinned**: `computed_negative_zero_is_collapsed_everywhere_it_can_be_seen`.

**The lesson worth keeping: a bug found by a fuzzer has been found by LUCK, and luck does not
generalise to the arm next door.** The fix closes one instance, the sweep closes the class, the
test keeps it closed. Item 459 did the first, skipped the second, and left the third to chance —
which is how it reached CI.

Also recorded: **dividing by a COMPUTED zero raises** ("division by zero") rather than producing
an infinity. Written here first as an infinity assertion, which failed — the engine's answer is
better than the expectation, and it is what shrinks this class to one function.

## 462 — a nested arithmetic predicate: CLOSED at 5.2x. Item 457's second open target is done

`try_filter_keep_arith` now takes ONE nested level, in all four operand spellings. `a.k * 2 + 1 >
7` goes 12.735/13.505 -> 2.413/2.462/2.478 ms, landing near the one-level cost. Three levels still
decline, deliberately: a `Vec` of steps per row is what item 453 measured as the thing that stops
the loop vectorizing, so the inner step is a second pair of loop-invariant locals and nothing
more.

Two things to not re-derive:

- **The loop had to be SPLIT, and this is the third occasion of that lesson.** One loop with a
  `match inner` in it cost the one-level shape 1.10x (`a.k + 0 > 5`, 1.86-1.89 -> 2.05-2.07,
  three rounds each) although that shape has no inner step. Two loops chosen per call, and the
  one-level rows came back FASTER than baseline (1.86 -> 1.72, and `a.k * 2 > 6` 2.10 -> 1.80) —
  incidental, from hoisting the two `match`es into `arith_step`/`num_pred`. **The same change can
  cost or gain 10% on an untouched shape depending only on where the branch sits** (items 453,
  459, now 462).
- **Item 438's `+ 0` oracle still works, and for a better reason**: the wrap now makes the
  predicate THREE levels, which this arm declines, so `eval` answers. 4,800 differential forms.

Item 457's open list is now empty: the generic scalar-call path (item 459) and this.

## 463 — gap screen after 458/459/462: `varlen distinct` regression REFUTED, CASE-in-aggregate priced at ~55x

The three wins show on the screen: `arith pred` 5.3x -> **26.1x**, `coalesce` 2.6x -> **4.9x**,
`case expr` 2.7x -> 2.3x (barely, which makes it the lead).

**REFUTED: a `varlen distinct` regression.** The screen read native 22.93 ms against 9.54 earlier
in the session, with three of my items having touched the evaluator. Re-measured: 9.62 / 11.53 /
10.93. A single outlier in a probe whose header says it is a SCREEN, 25+ shapes sharing one
process. **A screen's row is a reason to measure, never a measurement** — item 455 applied the
same rule to a spelling-probe flag that DID survive isolation; this one did not.

**OPEN, priced: a CASE in an AGGREGATE ARGUMENT is ~55x the floor.** At 1,000,000 rows
`count(a.k)` is 0.448 and `sum(a.k)` 0.560, while `count(CASE WHEN a.k > 3 THEN 1 ELSE 0 END)` is
26.0, `… THEN a.k ELSE 0 …` 27.0, `sum(CASE …)` 28.0 and `… THEN 1 ELSE null …` 30.2. **All four
within 15% whatever their arms hold** — item 442's tell, and the second time in this family: it
is `Expr::Case` itself, as item 450 found one position over, so an arm-by-arm fusion is again the
wrong shape.

Item 450's arm cannot reach this (it unwraps a boolean CASE used AS a predicate; here the CASE
must produce a value) and item 459's cannot either (a CASE is not a `Call`). The fix shape: the
eager path evaluates every branch's VALUE into a column and calls `value_at` per row per branch;
when the branch values are LITERALS — all four rows above — the selection is between constants
and needs no per-row `value_at`, and with no null among them need not box at all.
`count(CASE WHEN … THEN 1 ELSE null END)` is the ordinary conditional-count idiom.

## 464 — a CASE with LITERAL arms: CLOSED at 2.3-3.0x across five shapes

`case_literal_arms` selects between constants instead of materializing a column per branch.
`count(CASE WHEN a.k > 3 THEN 1 ELSE 0 END)` 26.0 -> 8.7 ms at 1,000,000 rows (**3.0x**), the
`ELSE null` conditional-count idiom 30.2 -> 11.4 (**2.6x**), `sum(CASE …)` 28.0 -> 11.2, the
filter-position `… = 1` spelling 33.4 -> 14.6, and a two-WHEN boolean CASE 28.9 -> 18.0.

Three things to not re-derive:

- **The eager path materializes a FULL COLUMN per branch for a constant** — a million `f64`s to
  represent `1` — and then boxes one `Value` per branch per row to pick between them. With
  literal arms both are avoidable; the only per-row work is deciding WHICH.
- **A `Col::Num` only when every arm is a non-null number.** `Col::Num` has no null
  representation (the rule item 458 relies on from the other side), so a NULL literal forces the
  boxed column. The mutant admitting a null into the numeric path is caught.
- **The PROPERTY-armed twins are the control and they are structurally unreachable** — same
  fixture, same selectivity, same `Expr::Case` machinery, but their THEN is not a literal.
  Neither moved (26.9 -> 27.0, 33.8 -> 33.2).

Semantics are the eager path's and an `Err` lands on the same masked fallback, so an error in an
unreached branch behaves as before. Oracle for the differential half: a property arm computing
the same value (`a.k - a.k + 1` is 1), which declines.

## 465 — item 464 has NO TS twin, and `sum` is 4.6x its own `count` whatever the argument

Asking TS item 464's question: a literal-armed CASE costs 1.5x the floor and a PROPERTY-armed one
costs **the same** 1.5x (15.1-15.7 against 15.5, floor 9.4-10.2 at 200,000 nodes). The
distinction item 464 is built on does not exist in TS. Third time this session the cross-engine
answer is "nothing to port" (items 448, 454, 465).

**What the question turned up: `sum(CASE …)` is not a CASE problem.** `count(n.age)` 9.4-10.2 ms
against **`sum(n.age)` 43.7-48.0**, with `sum(n.age + 0)` 45.1-46.9 and `sum(CASE …)` 46.6-54.6 —
everything built on `sum` lands on the same ~46 ms whatever its argument. Native's `sum` is ~1.25x
its `count`, so this is TS-specific. **Second time this session a shape was blamed for the cost of
the thing around it** (item 457 was the first).

**Cause:** `foldFor` admits `count`/`min`/`max` only, so any projection containing a `sum` has
`foldedAggs === undefined` and the streaming path is disabled entirely — the group materializes.

**Why it is not a free fix, and the exact open question.** That omission is load-bearing: item 419
records "418 is safe by CONSTRUCTION rather than by careful guards — its admission set is
`foldFor`'s", under "an order-dependent aggregate cannot take a fast path that may reorder rows,
and every fast path in this family may". The hop's far-driven route reorders and a float sum then
returns `2.0000000000000000e16` against `2.0000000000000004e16`. The admission set is SHARED, so
adding `sum` re-opens that on the hop.

The SCAN path has no far-driven alternative and may be admissible. **The question is whether its
row order is identical to the general path's BY CONSTRUCTION — same source, no seeded alternative
— rather than by observation**, which is the distinction item 419 drew when it declined the
start-driven route. Worth 4.6x on `sum` if yes; item 419 again if the scan can seed.

## 466 — item 465's question ANSWERED: unfiltered scan order is identical by construction; filtered is item 419's trap

**The scan fast path never seeds.** Its walk is `graph.verticesById.values()` or
`graph.verticesByLabel.get(labelName) ?? []`, iterated directly — no `indexCandidates`, no
`seedVertices`, no `hopSeek`, and so no run-time route choice for item 419's objection to attach
to. **The general path reads the same two containers**: `candidateVertexSource` is
`verticesById.values()` or `verticesByLabel.get(seed)`. For an UNFILTERED scan the two orders are
the same container traversal — "by construction", which is precisely what item 419 asked for and
did not have for the hop.

**The filtered scan is NOT safe.** `seedVertices` lets the general matcher visit in index order
instead of bucket order, decided at RUN time by which indexes exist and how selective they are —
item 419's "observed, not promised" and item 411's trap. A `sum` folded in bucket order against
one folded in index order is `2.0000000000000000e16` vs `2.0000000000000004e16`.

**LICENSED, not yet built: a scan-only, UNFILTERED-only admission of `sum`/`avg`**, worth 4.6x
(`sum(n.age)` 43.7-48.0 ms against `count(n.age)` 9.4-10.2 at 200,000 nodes). NOT by adding to
`foldFor` — that admission set is shared with the hop and is what keeps item 418 safe without
guards — but by `detectNodeAggregate` resolving its own fold for the one shape whose order both
paths share. The guard must hold even if `detectNodeAggregate` later gains a `WHERE`, which is a
test to write rather than a line to add.

## 467 — item 466's licensed `sum` fold is NOT available: `sum` is inherently TWO-PASS

`sum` cannot be a streaming fold in any position, for a reason independent of item 419's
ordering hazard:

```js
if (values.some(isTemporal)) return temporalSum(values);
if (values.some(Array.isArray)) throw nonNumericAgg();
return values.reduce((s, v) => s + numArg(v), 0);
```

A single temporal ANYWHERE changes the operation for every value and a single array ANYWHERE
throws, so the operation is not known until the last value is seen. **Items 465 and 466 both
attributed `foldFor`'s omission entirely to ordering; there are two reasons and I reasoned with
one.** Item 377 named this one ("the `temporalSum`-before-array PRECEDENCE") and item 419 said it
"is not the blocker" — true of the hop's ordering divergence, not of this.

**The available fix is a different shape, and a better one.** The 4.6x is not the fold: it is that
`foldedAggs === undefined` disables streaming, so the general path materializes a GROUP OF
BINDINGS and maps each through `argFn` — item 377's per-row `Binding` `Map`, ~125 ns a row. A sum
needs every VALUE, not every BINDING. So: stream the argument values into an array (one number a
row, no `Map`) and hand it to the SAME collection-wide `sum`. Semantics identical by construction
rather than by replication — the property item 419 demanded and a hand-written fold could not give.

Needs the `switch (name)` block extracted from `compileAggregate`'s closure into `(name, values)`
so both callers run one implementation. Own tick: it touches the general aggregate path.

**Lesson: an item that licenses a fix should read the fix's own implementation, not the one next
to it.** Item 466 read the walk carefully, concluded correctly about order, then estimated the
rest from `COUNT_FOLD`'s shape without reading `sum`.

## 468 — `sum`/`avg` on an unfiltered scan: CLOSED at 3.5x, by streaming VALUES not BINDINGS

`aggregateOverValues` is `compileAggregate`'s `switch (name)` lifted out verbatim; the closure
calls it, and so does a new COLLECTING route in `detectNodeAggregate` for a single `sum`/`avg`
over an UNFILTERED scan. That route streams the argument values — one number a row, no `Binding`
`Map` — instead of materializing a group of bindings. **One implementation, so the routes are
identical by construction**, which is what item 467 said a hand-written fold could not achieve.

`sum(n.age)` 43.7-48.0 -> 12.4-13.7 ms at 200,000 nodes (**3.5x**); `sum(CASE …)` 46.6-54.6 ->
18.4-18.6 (**2.6x**); both `count` controls flat. The `sum` rows were bimodal before (min 43.7,
median 90.8) and are not now.

**Three of six mutants SURVIVE and I could not give them teeth — the unfiltered boundary itself**
(clause `WHERE`, inline constraint, segments). An order divergence needs order-dependent floats
AND a general path that really visits in a different order; the second could not be constructed.
A hash seek over a value every row shares is wider than the bucket so `seekIsWorthIt` declines it
and scans, and a selective filter still finds the index's per-value bucket in insertion order.
The boundary therefore rests on item 466's reasoning, not a demonstration — it stays because
conservative is the safe direction for a silent last-bits hazard, and item 419 is what the other
judgement cost. **A guard whose test could not be written is worth saying so about.**

Two caught: DISTINCT admitted, and the nullish filter dropped. The DISTINCT one SURVIVED until
the fixture gained a duplicate value — without one `sum(DISTINCT a.k)` equals `sum(a.k)` and the
guard is vacuous.

Also: `sum`/`avg` moved out of `node-aggregate.test.ts`'s "REFUSED shapes" list, which named a
routing that is no longer true. **A stale test name is a claim like any other.**

## 469 — TWO aggregates over one scan: CLOSED at 2.7-4.3x (TS). The same step is OPEN in native

Every rung that could claim an aggregating scan refused `proj.items.length !== 1`, so a projection
with two aggregates fell to the general path whole — a `Binding` per row for one row of output.
`detectMultiNodeAggregate` is a new rung below `nodeAggregate`, disjoint by ARITY so the shipped
single-item routes are untouched: one synthetic column per aggregate ARGUMENT through
`detectNodeProjection`, then `foldFor` for `count`/`min`/`max`, collected values into the shared
`aggregateOverValues` for `sum`/`avg` (UNFILTERED only, item 466), and a row counter for
`count(*)`.

At 200,000 nodes: `count(n.age), count(*)` 46.4 -> 10.3, `min, max` 41.2 -> 13.7, `sum, count(*)`
47.6 -> 13.0, `sum, avg` 64.0 -> 15.4. All three single-aggregate controls flat.

**`accs.entries()` was 40-55% of the cost that remained after the route existed** — a `[i, a]`
tuple per accumulator per row. The tell: `min, max` sat at 32.7 ms where two separate `min`s cost
9.8 each, which no accumulator loop can explain. Index loops only in a per-row body; this is the
fourth entry (453, 459, 462, 469) where the hot loop's LAYOUT, not its logic, was the measurement.

**OPEN: native shows the same step** — 0.1 ms for one aggregate against 0.4-0.5 for two, all four
pairs, same fixture. Same question, not yet the same answer.

Mutation: five of eight caught. The survivor is item 468's — `sum`/`avg` under a filter — for the
unchanged reason, so that boundary is now load-bearing twice. Two were EQUIVALENT mutants (a
`continue` whose fall-through reads `row[undefined]` and is skipped anyway; an arity check on a
shape the parser cannot produce) and no test can catch those.

## 470 — native's two-aggregate step: CLOSED at 3.7-4.4x. Same shape as 469, different cause

Item 469 left native's 4-5x open. It is NOT a missing route: an `eprintln` at the entry of
`try_scan_multi_agg` (item 371's technique) shows all four pairs already take its branch-free
one-pass loop. That loop computes `sum`, `cnt`, `min` and `max` UNCONDITIONALLY, so
`count(n.age), count(*)` pays for three quantities it never reads. **The route existed and was
doing work nobody asked for.**

The quantities are now chosen once, before the scan, dispatching to one of four monomorphic
`#[inline(never)]` folds. At 1,000,000 nodes: `count, count(*)` 2.2 -> 0.0 ms, `min, max` 2.2 ->
0.5, `sum, count(*)` 2.2 -> 0.6, `sum, avg` 2.2 -> 0.6; the single-aggregate controls (0.5, 0.6)
never enter this function and did not move. Identical on three rounds.

**Item 448's rule produced its first yes-but-differently**: same shape, same size, different
cause — TS was missing a route, native had one and computed a superset. Porting the TS diagnosis
would have built a second path beside a working one and measured nothing.

Mutation: four of seven caught first run; **two survivors were holes in the test, not equivalent
mutants** (a lone `avg` with no `sum` beside it; `sum` beside `count(*)`, which is the summing
loop's ROW counter). Both now have a case. A specialization multiplies the paths a test must
visit, and a fixture covering two of four loops reads exactly like one covering all four.

Also: **a cached check is not a check.** CI went red on 469 because `bun run check` passed off the
nx cache while CI runs `bunx oxfmt --check .` uncached on a markdown table (fixed in b506de02).

## 471 — two aggregates over DIFFERENT columns: CLOSED at 5.6x / 44x (native). TS never had it

Item 470's arm requires one shared `Num` column; the other case fell to the interleaved loop that
reads every column for every row and decides there. It now runs ONE PASS PER DISTINCT COLUMN,
each the specialized fold from 470 with that column's needs unioned — which subsumes the
same-column case, so there is one code path, not a special case beside a general one.

At 1,000,000 nodes: `sum(age), max(w2)` 5.6 -> 1.0, `count(age), count(w2)` 4.4 -> 0.1; the
same-column pair and the single aggregates flat (0.6, 0.6, 0.5, 0.0). Three rounds identical.
**N passes over one column each beat one pass over N columns** — each is a sequential walk of one
slice with the work known before it starts.

TS does not have this gap (16.8 vs 18.0 at 200,000): item 469's rung already projects one
synthetic column per aggregate argument.

**A 13x "column gap" measured first was my own fixture**: `route-cost-probe` has TWO fixtures, a
`Graph` builder for TS and an NDJSON builder for native, and patching one left the property
absent. `store.column()` returned `None`; an `eprintln` said so in one run. Both fixtures now
carry the arm and a comment.

Mutation: six of seven caught. The `min`/`max` empty guard SURVIVED until a case that reaches
`cnt == 0` INSIDE the arm — an absent column makes the arm DECLINE, so empty-graph assertions
never enter it; it needs a column that exists while holding nothing for the scanned label.
**A test can assert the right answer for the right reason and never visit the code it is aimed
at.**

## 472 — the arity cliff on a HOP: CLOSED at 4.0-4.2x (TS). The native twin is OPEN

Item 469's scan cliff, asked of the hop, where it costs more because the general path
materializes a `Binding` per EDGE. At 200,000 nodes / 1,000,000 edges: `count(*), max(b.age)` 668
-> 155 ms, `min, max` 655 -> 163, `max(b.age)` alone flat at ~153 and `count(*)` flat at 0.0.

`detectMultiHopAggregate` is a rung below `hopAggregate`, disjoint by arity, built like item
469's: one synthetic column per aggregate argument, a fold per item, `count(*)` as a row counter,
index loops only.

**The admission set stays `foldFor`'s** — item 419's rule that only an order-INDEPENDENT
aggregate may ride a walk that can reorder. So `sum`/`avg` are refused HERE while item 468 admits
them on an unfiltered scan: the difference is the far-driven alternative, not the aggregate.

Mutation: six of seven. The survivor was the run-time DECLINE branch (`[]` instead of `null`),
which no fixture reached until one built the graph that provokes a decline — many starts, an
index on the far key, a selective inline constraint. **A run-time decline is reachable only by
building the graph that causes it.**

**OPEN: native shows the same cliff** — `max(b.age)` 2.4 ms against 6.4 and 8.1 for the pairs.

## 473 — two aggregates over one frontier (native): CLOSED at 2.5-2.8x. Item 472's twin, both halves now done

Every frontier aggregate path opens with `aggs.len() != 1`, so a pair fell past all of them to
the general aggregate. `try_frontier_multi_agg` folds them in ONE pass over the frontier's
(vertex, multiplicity) map, admitted by `aggs.len() >= 2` so it is disjoint from every entry
above it by ARITY rather than by placement.

At 200,000 nodes / 1,000,000 edges: `count(*), max(b.age)` 6.4 -> 2.5, `min, max` 8.1 -> 2.9;
single-aggregate controls flat (2.4, 0.5). Three rounds identical.

**`sum`/`avg` are refused, per item 376**: `count` folds multiplicities because order does not
matter to it and `min`/`max` ignore them, but a weighted `sum` adds a value `c` times in an
order the general path does not promise. Same conclusion as item 472's TS half, reached from the
other side.

Mutation: six of seven. Three of the caught ones depend on ONE far end having two in-edges —
without a repeated far end, weighted and unweighted agree and every multiplicity mutant
survives.

**Three ticks running, the survivor has been a guard whose shape the fixture never built**: a
column that exists but holds nothing (471), a run-time decline (472), an argument from the wrong
slot (473). A guard refuses a shape, so a fixture of admitted shapes cannot see it — the refused
shape has to be written down.

## 474 — a GROUPED aggregate beyond the count tally: CLOSED at 6.3x / 11x (TS). Native was already flat

`detectGroupedNodeCount` is a TALLY — two items, one of them `count(*)`, bumping an integer — so
any other aggregate in the projection sent the whole query to the general path. At 200,000
nodes: `n.age AS k, max(n.age)` 53.2 -> 8.0 ms, `n.age AS k, count(*), max(n.age)` 85.8 -> 7.7,
with the tally's own shape flat at 2.6-2.8 (it is claimed by a rung above and cannot be reached
by this change). Native reads 1.0-1.4 for all three, so this was TS-only — asked before the work.

`detectGroupedNodeAggregate` is the tally's shape with an accumulator array per group: one
reused `Binding`, the key as one `propOf`, `foldFor` + `count(*)`, and the filter composed into
ONE gate (item 141's 34%). **`sum`/`avg` are not admitted** — a grouped float sum depends on the
order values reach their group and a filtered scan may seed from an index (419, 466); item 468
is the record of what an untestable guard costs.

Mutation: seven of eight. **One "survivor" was a harness bug**: the gate mutant's pattern also
appears in the tally forty lines up, `replace(…, 1)` hit that copy, and the tally's tests live
in another file. Item 459's lesson, re-paid. **A mutation run's first job is to prove the mutant
landed where it was aimed — `cmp -s` only proves something changed.** Two others needed fixtures
the file lacked: a list-valued group key and a two-key `GROUP BY`.

## 475 — the anonymous hop end: CLOSED. Two spellings of one grouped count were 2.2x apart

`detectGroupedHopCount` declined unless BOTH ends were named, so
`MATCH (:Person)-[:KNOWS]->(b) RETURN b.age, count(*)` cost 735 ms where `(a:Person)` cost 335 —
**the bug class CLAUDE.md names by example**, sitting in the tally since item 142. The name was
only ever used to bind a predicate, and nothing can reference an unnamed end. Both spellings now
take the tally: 314-347 against 330-341, agreeing; the node tally is the control at 2.7-3.1.

Diagnosed by instrumenting the LADDER (a `console.error` per rung) rather than the detector —
and run against `src`, since a probe through `packages/native` reads the BUILT dist.

**The replacement guard I wrote was REDUNDANT and its mutant said so**: the key-end check twenty
lines down already refuses an unnamed keyed end, so the line was deleted rather than kept
untestable. A surviving mutant on a guard you just wrote can mean "redundant" as easily as
"untested", and the two have opposite fixes. The key-end check's own mutant also survives,
reachability-bound: a key naming neither end is rejected by the scoper before the planner sees
it.

Fixture faults the mutants found: `:P` was VACUOUS in the shared fixture (every source has it),
so ignoring the start label changed nothing; and the mutation script now asserts its pattern
appears exactly ONCE, after item 474's mutant landed on the node tally's identical body.

**OPEN: the grouped-hop ARITY gap.** `b.age AS k, max(b.age)` 759 ms against the tally's ~335;
`b.age, count(*), max(b.age)` 895. Native: 5.2 / 9.3 / 9.4.

## 476 — a GROUPED hop aggregate beyond the count tally: CLOSED at 2.1-2.2x (TS)

The last cell of the arity matrix. `detectGroupedHopCount` bumps an integer, so one `max` sent a
grouped hop to the general path — a `Binding` per EDGE. `detectGroupedHopAggregate` walks where
the tally's PER-EDGE arm walks (`candidateVertexSource` + `expand`), so first-seen group order is
the same traversal; it deliberately does NOT reuse `detectHopProjection`, whose far-driven route
may reorder (item 419).

At 200,000 nodes / 1,000,000 edges: `max(b.age)` 759 -> 349 ms, `count(*), max(b.age)` 895 -> 399. The hop tally (335) and the node grouped rung (8.0) are claimed by other rungs and did not
move.

**Three mutants each exposed a VACUOUS fixture** — the keyed/non-keyed swap needs an inline
constraint on an end; the nullish skip needs a far end LACKING the aggregated property; `:F`
excluded nothing because every far end was an `F`. That last is CLAUDE.md's label rule biting for
the second tick running.

**One "survivor" was the mutation script's fault again**: the far-label line is identical in the
tally, the ambiguity check added in 475 said `AMBIGUOUS (2 sites) — not applied`, and I re-ran it
by hand without the check and believed the result. The check works; using it only sometimes does
not.

**OPEN, priced: admitting `direction === 'both'`.** The refusal is inherited from the tally where
a bucket sum would double-count; this rung walks `expand`, which handles both directions, so the
mutant survives with correct answers even on a fixture built to distinguish them. A free win for
the undirected grouped hop, pending a measurement and an order check.

## 477 — the undirected grouped hop: CLOSED at 1.8-1.9x (TS). Native's twin is OPEN

Item 476 left `direction === 'both'` refused and priced. It cost 1849 ms against the directed
shape's 399 (count-only: 1536 against 335) at 200,000 nodes / 1,000,000 edges.

**Sound because the rung never sums buckets** — the tally's reason for refusing — it walks
`expand` per start vertex, the general path's own iterator, so an edge between two matching ends
is met once from each end just as the general path meets it. Backed by the two fixtures that
could break it: an edge whose BOTH ends match, and a SELF-LOOP. The oracle is `SKIP 0`, which
declines the rung while PRESERVING first-seen order — `ORDER BY` would compare sorted rows and
hide a reordering.

After: 871-1010 and 817-889; both directed controls flat (404, 335). Three rounds.

**The vacuity has now moved one field per tick**: start LABEL (475), far LABEL (476), edge TYPE
(477) — the edge-label mutant survived because every edge in the file is a `T`. CLAUDE.md states
the rule about labels; the general form is that anything a fixture holds constant cannot be
tested, and a filter's own field is what a careless fixture holds constant.

**OPEN: native's undirected grouped hop**, 19.3 ms against 9.4 directed.

## 478 — the undirected hop aggregate: CLOSED at 5.9x on a loop-free graph. Native's twin RETRACTED

**Retracted first**: native's undirected grouped hop is NOT a missing path — its ungrouped
undirected count is 2.8 ms against 1.8 directed, sublinear in the 2x edge steps, so 19.3-vs-9.4
is the work. No code written.

TS was the real gap: `count(b.age)` undirected 1450 ms against 150 directed, because the whole
hop family refuses `rel.direction === 'both'` — found with a `console.error` per ladder rung.
An undirected AGGREGATE now runs the existing directed walk TWICE and folds both; the walks are
specialized on `out: boolean` and item 159 priced a branch in their inner loop at 1.6x, so two
passes beat one wider one. Sound only for aggregates: `foldFor`'s set is exactly the folds that
cannot see row order (419).

**A SELF-LOOP made the first version answer `count(*) = 2` where BOTH engines answer 1** —
checked side by side. It sits in `edgesFromByLabel` AND `edgesToByLabel`, so two passes meet it
twice where `expand` yields it once. Fixed by a run-time decline on a new `graph.selfLoopCount`
in `@lenke/core`, maintained beside `multiTypeEdgeCount`.

Loop-free, three rounds: `count(b.age)` 1433.8 -> 234.9, `count(*), max(b.age)` 1514.7 -> 247.8;
directed controls flat. The after-ratio (~1.6x the directed shape) is where native's already is.

**The win is CONDITIONAL: one self-loop anywhere disarms it** — and `route-cost-probe`'s default
fixture has 50 (`k * 96810 ≡ 0 mod 200,000`), so on it the change measures its own decline. The
`PNOLOOP` arm (off by default) is what measures the win. **OPEN, priced:** skip self-loops in
the IN pass so the admission is per-edge, not per-graph.

Also: **a full-repo `bun test packages` is not the gate.** It reported 61 failures, all runner
artefacts — `packages/react` runs under VITEST (22/22 with its own script), the sync and
reactive files are the known run-many flake (176/176, 361/361 isolated).

## 479 — `min`/`max` need no self-loop guard: CLOSED at 5.3-6.2x on the ordinary fixture

Item 478's undirected hop aggregate declined whenever `graph.selfLoopCount !== 0`, which the
probe's own fixture trips (50 loops). **A self-loop only troubles a fold that COUNTS**: `min`
and `max` are idempotent, since the extremum of a multiset ignores multiplicity, so an
all-extremum undirected aggregate is correct over a looped graph. Counts keep the decline.

On the DEFAULT (looped) fixture, three rounds: `max(b.age)` 1464 -> 235 ms, `min, max` 1497 ->
261; directed `max` flat at ~152. **The second control is `count(*), max` on the same looped
graph, which must NOT move — and does not (1498-1598).** A control the change is designed not to
reach beats one it merely happens to miss.

Mutation: four of five (the fifth is a null control). The backing test puts a self-loop AND a
plain edge in one graph and compares every extremum shape against the general path — if
idempotence were the wrong reason, that is where it breaks.

**OPEN:** the count-bearing undirected aggregate on a looped graph (1498 ms). Item 478's
per-edge admission is still the only fix, still unpriced against item 159's 1.6x for touching
the walk inner loops.

## 480 — the undirected hop PROJECTION: CLOSED at 2.0x (754 -> 375 ns a row)

The projection twin of items 478/479, and the bigger row count. `undirectedHopWalk` is its own
module-scope builder reached only for `both`; every other hop walk captures `out: boolean` and
indexes one adjacency map, and item 159 prices a branch in those inner loops at 1.6x.

Row order is observable for a projection, so the walk emits what `expand` does — per START
VERTEX, out-steps then in-steps, skipping the self-loop in the in-pass — which is also why item
478's two-pass trick stays confined to aggregates.

**The honest control is the START-driven directed walk (~330 ns/row), not the far-driven one
(~141)**: an undirected walk cannot be far-driven, because a far end's rows come from two
buckets. Native was already proportional here (60.5 -> 125.7 ms), so this was TS-only.

**A wrong answer I introduced, caught by the decline test**: removing the `both` guard early and
declining LATE let `MATCH (:P)-[r:T]-(z) RETURN r.id` fall into the rel-bound walk with
`out = false` — one row where four are right. The case that caught it asserts that the shapes
this rung does NOT take still answer. A widened guard is exactly how a neighbouring path gets
silently re-routed.

Mutation: five of six (self-loop skip, in-pass endpoint, far label, start label, `both` leaking
into the directed walks).

**OPEN, now available:** the aggregate rungs could use this single undirected walk instead of
two turned ones, retiring item 478's `selfLoopCount` decline for counting folds as well.

## 481 — the looped-graph undirected aggregate: CLOSED at 1.9x by falling back, not declining

Item 479 left the COUNT-bearing undirected aggregate declining on a looped graph; item 480 built
a single undirected walk that handles a loop itself. The two routes are now picked per CALL: two
turned walks when the folds are idempotent or the graph is loop-free (they can each be
FAR-DRIVEN — 118 ns a row against 375), and item 480's walk otherwise instead of declining.

DEFAULT (looped) fixture, three rounds: `count(*), max(b.age)` 1498-1598 -> 766-833;
`count(b.age)` 1505 -> 782. **The idempotent control must KEEP the faster two-walk route on the
same graph — and does (235 -> 235-310)**; the directed control is flat.

**The fallback had NO teeth until one fixture held two things at once**: a self-loop (to force
the fallback) AND an in-edge to a start (so walking only out-edges differs). 479's loop fixture
had no in-edge; 478's in-edge fixture had no loop, and all four mutants survived. _Two
conditions each present somewhere is not the same as both present together_ — a distinct failure
from the single-field vacuity of 475-477.

One survivor is recorded, not chased: dropping the fallback makes the rung DECLINE, which
answers identically. A perf mutant, covered by the measurement.

## 482 — the undirected `count(*)`: CLOSED at 1352 ms -> 0.0

The largest `direction === 'both'` guard left. Over vacuous endpoints an undirected hop count is
`2 * |E_t| - loops(t)`: every edge is met from both ends except a SELF-LOOP, which `expand`
yields once. `loops(t)` is new — `selfLoopsByLabel` beside item 478's `selfLoopCount`.

**The per-type split is the point**: 478 gated on `selfLoopCount === 0` and the probe's own
fixture (50 loops) disarmed it. A graph-wide flag answers "is any loop anywhere", which is
almost never the question.

A `CountOf` closure cannot decline once built, so `both` gets a COMPLETE arm: O(1) over vacuous
endpoints, one pass over the type's edges otherwise (each end tested against the two labels,
multi-type edges deduped). Filtered and inline-constrained undirected counts are refused at
BUILD time, where declining is still possible. Directed twin flat at 0.0; the other-rung
undirected count flat at ~780.

**Two mutants survived, both harness faults, both "an oracle that agrees with the mutant":**

- **A mutant in `@lenke/core` is invisible to a `packages/gql` test** — those import the BUILT
  dist and the loop never rebuilt it. Same trap as `fuzzers-read-built-dists`, one package over.
  Counters now have assertions in a test that imports `./Graph.js` directly.
- **`WHERE true` cannot tell an IGNORED predicate from an applied one**, so the mutant admitting
  a filtered undirected count answered correctly everywhere. Selective filters kill it.

**OPEN, priced:** the undirected TWO-HOP count, 7483 ms against the directed 78 — a different
builder and a much larger row count.

## 483 — an undirected leg in the two-hop count: CLOSED at 22x (7286 -> 333 ms)

Native pays 2.6x for the undirected two-hop where TS paid 95x, so the gap was TS's. The two-hop
count is a degree PRODUCT per middle vertex, and each factor becomes an UNDIRECTED degree:
`out + in` minus self-loops (a loop is in both maps; `expand` yields it once). The subtraction
is gated on `selfLoopsByLabel` holding a wanted type, so an ordinary graph pays one `Map.get`
per query.

**The semantics were checked against BOTH engines before the formula was written**: both answer
6 for `(:P)-[:T]-(x)-[:T]-(y)` over `a-b-c` = `1 + 2^2 + 1`, i.e. WALK semantics, where a
two-hop may return along the edge it arrived on. Without that the product is simply wrong.

Directed twin and the one-hop undirected count both flat.

**The guard I edited was in the WRONG FUNCTION**: `buildFilteredTwoHopCount` and
`buildTwoHopCount` hold the same two `both` lines, and a `replace(…, 1)` asserting only
`old in s` hit the filtered one — a wrong answer (0 where 3 is right), caught by that file's own
decline test. Item 474's lesson, third occurrence. **Source edits now assert the pattern appears
exactly ONCE, the way the mutation script already does.**

Mutation: five of seven. The loop scan's far-LABEL test survived until a fixture held a loop at
a vertex that FAILS the end label. One equivalent (scanning where there is nothing to find), one
null control. Two of my own expectations were wrong and the general-path oracle corrected both.

## 484 — undirected legs in the THREE-hop count: CLOSED at 54x (64.1 s -> 1.17 s)

Item 483 one segment longer: the OUTER legs take `undirectedSide`, the MIDDLE leg walks the
out-bucket then the in-bucket and skips the self-loop the out-pass took. 6076 -> 71 ms at 20,000
nodes; 64,058 -> 1164 at 200,000. Native was 2.7 against 0.4, so the gap was TS's.

**A regression I attributed to my own change was sampling noise, and is RETRACTED.** Wrapping
both cases in one `midLegs` array read 1.06x slower on the directed 3-hop over three rounds a
side (311.0-325.1 against 329.8-359.6, near-disjoint). Three MORE pristine rounds gave 321.7,
368.4, 332.2 — the pristine range is 311-368 and the "regressed" numbers sit inside it.
CLAUDE.md says anything under ~10% needs its own isolated harness; I flagged 6% off three rounds.
The split loops stay (item 159's idiom, free), but the number does not. **A control measured
three times is not a control measured.**

Mutation: five of six. **Three of my own expectations were wrong across 483/484** — a mixed
pattern, a labelled loop, and three hops over a single edge (2, not 1) — each corrected by the
general-path oracle before commit.

## 485 — the DISTINCT walk's anonymous end: CLOSED at 17x. Item 475's bug class, second family

TS read 964 ms against native's 7.2 for `MATCH (:Person)-[:KNOWS]->(b) RETURN DISTINCT b.age` —
but the first question is the SPELLING, and the named `(a:Person)` twin took the walk at 56.
`distinctShape` demanded a named start AND a named far node; nothing can reference an unnamed
end, and the KEYED end is named by the projected expression itself.

Anonymous `DISTINCT` 964 -> 52-58 ms, anonymous `count(DISTINCT)` 703 -> 53, the named spelling
flat at 56-58 (the two now AGREE, which is the claim), the node shape flat, and the undirected
`DISTINCT` 2065 -> 816 as a bonus. A 5.1 ms blip on the node control was noise — checked before
recording, after item 484's retraction.

Mutation: three guards the relaxed helper KEPT had NO fixture — a rel constraint, the non-keyed
end's constraint (vacuous in the shared fixture, since every far end is reachable from both
starts), and a rel VARIABLE. The first two are now caught. **The third is EQUIVALENT and so
names a free widening**: `reads` must be exactly one end's variable, so `-[r:T]->` with nothing
reading `r` would answer the same on the walk. Priced, not taken.

## 486 — a rel VARIABLE nothing reads: CLOSED at 18.6x in the DISTINCT walk

Item 485's equivalent mutant said the refusal was conservative, so it got priced:
`(:Person)-[r:KNOWS]->(b) RETURN DISTINCT b.age` cost 1050 ms against 55 for the same query
without the `r:` — 19x for a name nobody uses. The walk never binds the edge, so an unREAD
variable cannot change an answer; `plainUnnamedRel` admits it when neither the projection, the
clause `WHERE` nor the `LET` names it. 1050 -> 53.5-56.6 ms.

**The control that matters is `RETURN DISTINCT r.w`**, which must STAY on the general path
(1087-1107, unmoved) because the walk has no edge to read.

**The new mentions check is belt-and-braces and the probe proved it**: four mutants on it
survived, so I instrumented — it FIRES on five shapes and every one is also refused by rules
already present (`reads`, `whereReadsOnly`, `sourceFor`). It stays only because the walk cannot
bind an edge and the failure mode would be silent.

**Its doc comment was WRONG before the probe**: it claimed to close item 444's subquery hole, but
`mentionsName` does not look inside a subquery expression — `COUNT { MATCH (a)-[r:T]->(z) }` does
not fire the check at all. A guard's comment is a claim like any other.

## 487 — an unread rel variable in the count PRODUCTS: CLOSED at 29x (two-hop) and 44x (three-hop)

Item 486's question asked of every rung. The one-hop count already admitted a rel variable and
the hop aggregate pays 1.25x (item 446 serves it), but the two-hop count cost 2165 ms against 75
and the three-hop 1276 against 11-20. Both products bind NO edge and run only unfiltered, so a
name nobody reads changes nothing: 2165 -> 73.4 and 1276 -> 19.5-28.8.

**The widening introduced a WRONG ANSWER**: a repeated rel variable (`-[r:T]->(x)-[r:T]->(y)`)
is the SAME edge at both positions, and the product treats its legs as independent — 1 where the
general path says 0. The duplicate-name check listed only NODE variables; rel names are in it
now. Found by a probe written the moment the guard came off. **Three widenings this session,
three latent wrong answers (478's self-loop, 480's rel-bound re-route, this), each found by
asking what else the guard protected.**

Mutation: four of five. `plainRel` in the THREE-hop survived until a three-hop inline-rel case
existed — the only such case covered the two-hop builder.

**A control too small to be a control**: `threehopdir` at 20,000 nodes read 11.3 before and 26.2
after, which looks like 2.3x; at 200,000 it is 321.8-327.0 against an established 311-368.
That 20,000-node figure has ranged 11-26 over the session for unchanged code. Take the control
from the LARGER fixture (item 484 retracted a flag for the same reason).

**STILL OPEN:** the grouped hop count with a rel variable, 314 -> 757 (2.4x).

## 488 — the grouped hop's rel variable: CLOSED at 2.0-2.4x. The unread-rel-variable family is done

Item 487's last open row. The grouped tally and grouped aggregate bind only NODES, so an unread
rel variable is inert: 761 -> 308-314 and 805 -> 393-487, with the no-variable spellings
(322, 359) as controls the change cannot reach.

**The collision hazard was written down BEFORE the widening this time.** `MATCH (x:P)-[x:T]->(b)`
names the start and the rel alike, matches nothing, and answers `[]`; a path that ignored the
name would return rows. Item 487 shipped exactly that class of bug one tick earlier (a repeated
rel name), and 478 the tick before (self-loops) — **three forms of "what a guard refuses is
rarely one thing"**.

Mutation: the collision check and both call sites are caught; **the three READ checks all
survive** — the key must be a property of an END, an aggregate argument must read the KEYED end,
a `WHERE` may read only that end, and an `ORDER BY` on a non-projected column declines earlier.
They stay with the mutation run recorded in the comment, because each covering rule is one
relaxation away from a silent wrong answer (items 469/486 same call; 475 removed a guard whose
redundancy was provable by reading, unlike this one).

## 489 — NATIVE: the last `spelling_probe` cliff, from TWO causes. The probe now reports none

`bun run bench`'s widest row (`count 3-hop`) is closed ground (300/310/324/350: two levers
refuted, 1.25x won, the rest a CSR target) and its egress rows are item 289's JSON carrier —
`CLOSED.md` kept this tick off both. `spelling_probe` had the real finding: one multi-predicate
filter, three spellings, **4.73x** apart (0.097 / 0.097 / 0.020 ms).

1. **An equality on a RANGE-indexed key was not an indexed candidate.** `range_lookup` has
   answered `Eq` since 402 and `index_bucket_len` priced it since 404, but `eq_cand` gated on
   `has_hash_index` — item 404 deferred exactly this, predicting the mechanism ("would change
   which conjunct a multi-predicate filter seeds"). That churn IS the fix: both `WHERE`
   spellings now rank `age` by selectivity and seed it.
2. **Inline properties lowered to a CHAIN of one-comparison filters**, invisible to
   `seed_from_conjuncts`. `node_prop_filters` now emits ONE `Filter` holding an `And` — which is
   what its own doc comment already claimed, true for one property and false for two.

All three spellings: **0.019 ms, identical plan.** `spelling_probe` prints NO PERF CLIFFS.

Mutation: five of six. **Two mutants needed a BIGGER fixture to have teeth**: below
`SEEK_FLOOR_NODES` (4096) the cost gate is inactive, and with one indexed key "most selective"
and "first" always agree — the second test uses 5000 nodes and three keys at 1% / 5% / 20%.

**A harness failure wearing a result's clothes:** all six first reported `no result line`
because two bare test names make CARGO fail ("unexpected argument") — one positional `TESTNAME`,
the rest after `--`. The null control "failing" is the tell. Second time this session the
harness was the finding.

## 490 — verification: both probes clean, two sweeps unmoved. The 3321x TS group is item 325's GUARD

No engine change. `bun run spelling` (SPELL_N=200000, SPELL_REPS=9): **0 answer disagreements**,
one group over 2x — `label on start: redundant vs absent` at 3321.7x, which item 325 records as
CORRECT (`:P` is deliberately non-vacuous; eliding it would change the answer) with the
instruction _"do not quiet it by reverting the fixture"_. The vacuity premise has its own
`:Univ` group and that one is within noise, so the elision still fires where it is sound.
**Third save of the session from reading `CLOSED.md` first** (after `count 3-hop` and the egress
rows).

`spelling_probe` (native): NO PERF CLIFFS, after item 489. `bench:usage`: no anomaly — the
`ts(-)` column is the scan constant factor (an unindexed point lookup IS a 20,000-node scan),
and `ts(+)` beats native on indexed lookups because TS pays no FFI/JSON (item 289 from the other
side).

**A flag that was noise:** `range operand order` read 2.3x on one run and 1.00x on the next. The
probe is bimodal in single runs; a 2.3x there is a reason to RE-RUN, not to open an item. Third
sub-floor flag to dissolve on repetition this session (484, 487, 490).

**PRICED, not taken:** `three hops, THIRD position filtered` is 1.4x apart and therefore NOT
flagged by the 2x threshold — clause `WHERE c.k = 2` 541.30 ms against inline `(c {k: 2})`
385.02. Under a threshold is not absent: item 489's cliff printed for several ticks unread.

## 491 — item 490's priced 1.4x was the INSTRUMENT. RETRACTED, and the probe now carries the caveat

Item 490 priced `three hops, THIRD position filtered` at 541.30 ms (clause `WHERE c.k = 2`)
against 385.02 (inline `(c {k: 2})`). Isolated, one case per process, three rounds, at two
selectivities (1.1% and 14%): **307.8-341.4 / 308.5-319.6 / 310.2-351.0 and 333.2-348.2 against
337.4-341.6** — identical within noise.

Diagnosis before measurement said the same: all three take `countShortcut`, answer identically,
and `compilePredicate` lifts `c.k = 2` into the same `eqProps` path the inline form uses
(`directEqProps`), so no route difference remained to explain a 1.4x.

**The cause is the probe: every group runs in ONE process**, so each member is warmed by the
members before it (item 274), which is why `route-cost-probe` isolates and why this probe only
FLAGS above 2x. It did not flag this group — **the printed times of an UNFLAGGED group were read
as a finding.** `spelling-probe.ts`'s header now records the numbers and the rule: _a flagged
group is a finding; an unflagged group is a question for `route-cost-probe`._

**Fourth sub-threshold flag this session to dissolve on isolation or repetition** (484, 487, 490,
this) — and the first whose wrong reading had already been committed, hence a retraction item
rather than an edit.

## 492 — a correlated one-hop `EXISTS`: CLOSED at 1.28x, after two wrong diagnoses that measured flat

Priced with the ISOLATING instrument (491's lesson): `WHERE EXISTS { MATCH (n)-[:KNOWS]->(x) }`
cost 87.8 ms in TS against **1.2 in native** — 73x for "does this vertex have an out-edge".

**Two diagnoses measured flat before the right one.** Hoisting the per-row guard analysis into a
compile-time shape: 87.8 -> 85.6 (flat). Answering a free endpoint from a bucket SIZE instead of
the `edgesOfTypes` generator: 85.6 -> 87.4 (flat). Then a counter and timer INSIDE the closure:
200,000 calls, 108.7 of 128.5 ms, fast path always taken — ~540 ns for two `Map.get`s, which is
item 194's ~190 ns twice.

**The real component: the adjacency BOX.** `Vertex.adjFrom`/`adjTo` exist so a consumer holding
the vertex stops hashing its id (162, 321), and this closure was hashing anyway. **87.8 ->
66.9-68.8 ms (1.28x)**, three rounds; `COUNT {…}` and the plain hop count flat as controls.

**Only one of three micros was real** — items 300/310's decomposition from the other side. The
two flat ones are kept and labelled flat (they remove provable per-row work below the floor).

Mutation: four of six. One is EQUIVALENT by a store invariant — `deIndexEdgeLabel` deletes an
emptied per-type entry, so `size > 0` and `has` agree; **my comment had claimed the size read was
required**, and it now says what is true. The rel-VARIABLE guard needed a sub-`WHERE` that READS
the edge to have teeth.

**OPEN:** `COUNT { … }` is 93 ms against native's 14.7 — same per-row pipeline, and the box
applies there too.

## 493 — item 492's 1.28x is a WARM number. The `COUNT` twin stays refuted (item 355)

Setting up "apply 492's box to `COUNT { … }`" found item **355, which REFUTED that lever**: the
box is a MEMO — **1.21x worse on FIRST touch**, 1.35x better warm — and five of six `side` sites
visit each vertex once per query, so they pay cold and never warm. _A memo helps a revisited
element and taxes a visited-once one._

A correlated `EXISTS` also visits each vertex once, and `route-cost-probe` reports min-of-9 in
ONE process — a warm box by construction. Measured both ways: **box cold 105.3-126.1, warm
66.9-68.8; hash cold 110.1-230.6, warm 87.9-99.2.** The warm 1.3x is real and reproducible; the
cold comparison is NOT callable (overlapping, and a single rep carries fixture build + JIT — one
hash run read 230.6).

**Item 492 stands with its claim narrowed to WARM.** A one-shot query on a freshly loaded graph
is a real workload and this probe does not measure it (`bench:usage` is where boxes are already
populated).

**`COUNT { … }` (93 ms against native 14.7) NOT taken**: it routes through the exact `side` call
site 355 priced and declined. 355's UNTRIED variant — PEEK the box, hash on a miss, never write —
needs a new `@lenke/core` accessor and a MIXED workload to measure.

## 494 — the `COUNT { … }` degree reads the anchor's box: CLOSED at 1.28x WARM

Item 493's open row, taken without touching `side` (item 355 declined widening it):
`sideOfVertex` is `side`'s body with the box read instead of the id hash, used only by the
ONE-hop degree branch. WARM 93.5-94.0 -> 72.4-73.6 (1.28x); COLD 103.6-125.2 against 109.7-118.1,
**not callable** — 493's cold/warm discipline applied up front. `EXISTS` is the flat control.

**I overwrote an existing test file.** `count-subquery-degree.test.ts` already held **30 tests**
from item 211 covering this exact path; `Write` replaced them with nine redundant ones, and the
only tell was the suite dropping 2631 -> 2610 **with everything still green**. Recovered via `git
checkout HEAD --`; my file dropped as redundant. _A clobbered test file is green by construction
— the tests that would have failed are gone._ The detector was a test COUNT, not a failure.

Mutation against the RESTORED suite: five of six caught (wrong direction, boxed reader dropping
the far label, `countOf` dropping the far label, `countOf` dropping the type, the bound-far-var
run-time check). **Item 211's tests had teeth for a change made twenty items later** — the
argument for not replacing them.

**One mutant was MISAPPLIED and read as a survivor**: `sideOfVertex` is `side`'s body with one
line changed, so a pattern starting at `if (far === undefined)` matched both and the
one-occurrence check passed only because trailing context differed. Items 474, 483, 494: **two
copies of a body is the most reliable way to fool a mutation run here.**

## 495 — the two-hop `COUNT { … }` degree stops re-hashing the middle id: CLOSED at 1.25x

`twoHopSide` resolved the middle vertex (`e.to`, a `Map.get`) and then handed `mid.id` straight to
another `Map.get` — two lookups an edge where one does. With no middle LABEL there is nothing to
resolve the vertex for, so that branch reads the endpoint id the EDGE stores. 382.5-403.8 ->
305.5-322.9 ms at 200,000 vertices / 1,000,000 edges, three alternated rounds, one-hop
`COUNT { … }` flat as the control. Five of six mutants caught by item 211's existing tests.

**REFUTED in the same item: the adjacency box is not a faster hash.** On the LABELLED branch, where
the resolve is owed anyway, swapping `side(graph, mid.id, …)` for item 494's `sideOfVertex(mid, …)`
measured FLAT (369.9/384.4/367.7 against 384.1/364.2/372.0). The middle vertex is the REVISITED
position item 355 named as the one where the memo should pay, and it still bought nothing — so
items 492 and 494 won by doing **one lookup instead of two**, not by the box being cheaper. Do not
price a box swap that does not also remove a lookup.

**Open and priced, for RUST:** native does the whole-graph two-hop count in 2.7 ms and the
per-anchor `COUNT { … }` partition of the same traversal in 75.0 ms (14.6 of it row egress). Same
edge work, 28x apart.

## 496 — the RUST `COUNT { … }` degree: CLOSED at 4.5x (two hops) and 6.0x (three)

Native's evaluator materialized every sub-row of a correlated count and tallied by provenance —
**11-15 ns a sub-row, flat at 1M / 5M / 25M of them**, which is the enumeration and nothing else.
`degree_count_subquery` recognizes a body that is a chain of unfiltered node-only `Expand`s and
answers from the adjacency: the last hop is a `matching_degree`, earlier hops walk. One hop
14.5 -> 11.0 ms (1.31x), two 69.8 -> 15.3 (4.5x), three 272.7 -> 40.4 (6.0x), three alternated
rounds, `EXISTS` and the global hop count flat as controls. A `Filter` in the body (label, inline
property, sub-`WHERE`) declines — items 219/290's rule one level in. Depth cap 3.

**The oracle was itself verified.** Each of 26 assertions runs bare and with a UNIVERSAL `:N`
label that forces a `Filter`, hence the general path; an `eprintln` confirmed the fast path fired
19 of 52 times, i.e. only the bare spellings minus the capped one. _A vacuous declining twin is
worse than no oracle._

Mutation: 4 of 7 caught (both hops' direction, the type set, the `Both` self-loop policy). **Two
survivors are equivalent BY CONSTRUCTION and the argument is in the code**: `extend_chain` carries
`from` forward, so a GQL body is a single chain and the slot-chain check cannot fire; the
anchor-slot check is subsumed by the slot read on the next line.

**OPEN, measured, 151x:** the TS engine caps its degree path at TWO segments
(`degreeCountSubquery` returns `null` above that), so a three-hop `COUNT { … }` costs **6097 ms
against native's 40.4**. The recursion added here is the shape the TS twin needs.

## 497 — the TS three-hop `COUNT { … }`: CLOSED at 10.3x

`degreeCountSubquery` capped at TWO segments, so a three-hop degree fell to the general matcher
and materialized ~25M bindings: 6097 ms against native's 40.4 (151x) after item 496. `threeHopSide`
walks the first hop and hands each landing to `twoHopSide`, so the recursion is one level deep over
already-measured code. 6317.7/6219.9/6150.2 -> 586.0-605.4 ms, three alternated rounds, the two-
and one-hop rungs flat as controls. The cross-engine gap closes to 14.6x. Six of seven mutants
caught, including the cap raised to four.

**The oracle is three independent answers** — the chain, a sub-`WHERE` twin that declines, and the
same pattern as a top-level `MATCH` counted by its ROWS — and the twin was instrumented to confirm
it declines (18 chain hits, exactly the bare spellings). **Two of my hand values were wrong and all
three answers agreed against them.**

_A test named for a decline that no longer happens still passes._ `THREE segments decline` asserted
0 on a fixture with nothing three hops out, so only its name went stale; renamed, not deleted.

## 498 — `VALUE { … RETURN max(x) }` panicked native: FIXED, and a cross-engine divergence closed

Found by PRICING THE ENUM, not by a failing test. Item 436 turned aggregate hoisting on for every
RETURN item; a `VALUE { … }` item parses through that same `expr()`, so the subquery's own `max`
was hoisted into the OUTER aggregate list and indexed a slot the outer batch does not have —
`index out of bounds` in `Batch::slot`, surfacing as `E_INVALID_VALUE: query evaluation panicked`
while the TS engine answered normally. Fix: set the hoisting accumulator aside around the body,
and lower `VALUE { … RETURN <agg>(arg) }` to `Expr::AggSubquery` (the variant `CALL` already uses,
whose empty-group answers already matched TS: `sum` 0, the rest NULL). Native now agrees with TS
on all five aggregates and answers in 22.1-22.3 ms at 200,000 anchors.

**Why nothing caught it:** the GQL corpus has nine `VALUE { … }` cases — `count(*)` and plain
scalars, nothing in between — and the differential fuzzer does not generate the form. The guard
added is a DIFFERENTIAL test, because the corpus is a frozen single-engine snapshot and the
missing statement was that the engines agree.

**A survivor that widened the test:** the hoisting guard's mutant survived, since every shape
written parses via `aggregate_call()`, which does not hoist. The guard is for an aggregate NESTED
in a larger expression (`abs(max(x))`), which reaches `expr()` with hoisting live. With that case
added the mutant dies WITH THE ORIGINAL PANIC.

**Still divergent (recorded in the test):** TS answers `max(DISTINCT x)`, `max(x) + 1` and
`collect(x)` in a `VALUE`; native refuses all three. `DISTINCT` needs a field on
`Expr::AggSubquery`; `collect` is cheapest — `Expr::CollectSubquery` exists.

**OPEN, 8.5x:** `VALUE { … RETURN count(*) }` and `COUNT { … }` converge in native (11.3-16.9 vs
11.3 ms) and do NOT in TS (624.2 vs 73.0). An equivalent-spelling cliff.

## 499 — `VALUE { … RETURN count(*) }` vs `COUNT { … }`: CLOSED, 8.3x

Item 498's open row. The native parser has lowered both ISO spellings to one `CountSubquery` node
since it was written; the TS parser always built a `valueSubquery`, which materializes the matches
per outer row and misses the degree ladder entirely. 691.1/726.8/694.7 -> 78.5-88.7 ms at 200,000
vertices, three alternated rounds, both the `COUNT` spelling and the two-hop form flat as controls.

**The probe group was proven against the bug, not just added after the fix**: `spelling-probe`
flags this pair at 7.3x with the pristine parser and is silent with the fixed one.

Mutation: 1 of 5 caught — the `star` check, which is the load-bearing one (`count(x.n)` is not
`count(*)` when an argument is null). **The other two guards are equivalent BY PARSER
CONSTRUCTION**: `count(DISTINCT *)` is a parse error so `distinct` cannot accompany `star`, and
`max(*)` / `collect(*)` are rejected as needing an argument so nothing else carries `star`. The
pattern guard admits only `VALUE { RETURN count(*) }`, where both paths answer 1.

## 500 — a landing LABEL on the native degree chain: CLOSED at 7.6x / 9.6x

Item 498's two worst cells. A label on the LAST landing is the one filter a degree chain can take
— the hop walks anyway, so the neighbour's membership is a probe into a bucket resolved once per
batch. One hop 185.5-198.9 -> 24.6-24.9 ms (7.6x); two hops with the label on the end 866.8-869.5
-> 86.2-94.7 (9.6x). Controls: the unfiltered degree flat, and a sub-`WHERE` — the filter it must
still refuse — flat at 18 ms.

**`opt` NEVER DESCENDS INTO A CORRELATED SUBQUERY BODY.** The first recognizer matched
`Expr::IsLabeled` and was INERT (202.2 -> 191.3, noise), because GQL's `(x:L)` lowers to
`'L' IN labels(slot)` and `opt::normalize_pred` canonicalizes only top-level plans. So a subquery
body also gets no filter pushdown and **no index seeding** — a larger open target than this item,
needing `rewrite_fuzz` (top-level plans only) extended first.

**This change ATE item 496's oracle.** 496's twin was a universal `:N` label, which a landing
label now routes to the SAME path: the instrumented count went 19 -> 38. The twin is now a
sub-`WHERE`; the `:N` spelling stays as a third way exercising the new branch. _A test can lose
its teeth to a later widening of the thing it tests, and only re-running the instrument says so._

Mutation 4 of 6; the landing-slot check survives because a MIDDLE label lowers to a `Filter`
between the `Expand`s, which the unwind rejects one step earlier.

## 501 — an UNCORRELATED `COUNT { … }` materialized every row to count it: CLOSED at 3.0x

Item 500's "opt never descends into a subquery body" was priced here, and the first diagnosis was
REFUTED: optimizing the body alone moved 68.8 -> 73.3 ms (noise). The real cost was
`Expr::UncorrelatedCount` = `pull(body).rows()` — building 5,000,000 rows to learn how many there
are, where the same query at top level reaches the degree products. Counting INSIDE the plan (an
`Aggregate` holding `count(*)`, then optimized): 62.9-66.5 -> 20.9-21.1 ms, three alternated
rounds, the correlated degree flat as control.

**Both halves ship because either alone is worse**, A/B'd: `counted()` alone still wins the
two-hop (exec's fast paths match the `Aggregate`) but costs the SEEDED equality 18.2 -> 39.9 ms,
because wrapping loses the seek until the wrapped plan is re-optimized. `optimize` is a repair,
not an independent win; that row is FLAT.

**A wrong answer caught by the new test's top-level twin:** reading the count by matching
`Col::Num` fell through to the row tally, so `COUNT { (x:P) }` answered 1 where 3 is right — an
`Aggregate`'s output column is whatever the fold produced. _Read the VALUE, not the
representation._ Running the pristine engine against the same test confirmed the regression was
mine.

Mutation 2 of 4; `distinct: true` on the wrapper is equivalent (DISTINCT applies to an argument,
`count(*)` has none).

**OPEN:** a CORRELATED body is still unoptimized and is a different contract (a `Row` leaf
standing in for the outer row, outer-slot references). `rewrite_fuzz` generates top-level plans
only and needs widening first.

## 502 — OPEN, measured: TS re-runs an uncorrelated subquery body ONCE PER OUTER ROW

`COUNT { MATCH (:Person)-[:KNOWS]->(b) }` with no correlation: **4,102.8 ms at PN=2,000 and
18,620.2 at PN=4,000** (2x the rows, 4.5x the time — quadratic), and it DID NOT FINISH in nine
minutes at PN=200,000, where native answers in 20.9 after item 501. The correlated one-hop degree
on the same fixture is 0.4 ms.

**No fix yet, deliberately.** The fix is a per-EXECUTION memo and TS has nowhere to put one:
`EvalEnv` is allocated PER ROW at every site (`projectRow`; item 454 says the same of
`satisfies`). Threading a cache from a per-execution root is the right build; a `WeakMap` keyed
on the graph is wrong without a mutation counter, and one missed mutation point is a silent wrong
answer. `route-cost-probe` now warns in its case table: price the TS side at `PN<=4000`.

## 503 — the TS uncorrelated subquery memo: CLOSED at ~2100x

Item 502's specified fix, built. PN=4,000: 18,547.7-19,187.3 -> 8.3-10.7 ms; PN=200,000 went from
NOT FINISHING in nine minutes to 585.8 ms. The correlated one-hop degree is the control and is
flat. Memo keyed on `execEpoch` (the per-invocation counter the `in` haystack already uses),
because `planCache` keeps compiled closures across runs — tested with one cached plan over a
graph mutated between three runs.

**Two designs were measured and discarded first.** `freePredicateVars(expr).size === 0` as the
admission test broke **90 tests**: that helper counts a body's OWN pattern variables as bound, so
the correlated `COUNT { (u)-[:T]->(x) }` reads as having no free variables. A run-time scope test
is correct but **cost the correlated path 1.08x** (71.7-73.8 -> 78.8-79.6 ms at 200,000 rows,
disjoint) — the wrapper is a call frame on a path the change should not touch; it was invisible at
PN=4000 (0.6 vs 0.7 ms) and only legible at 200,000. The shipped design marks correlated
subqueries at COMPILE time inside `checkLinearScope`, which already walks every expression with
its enclosing scope, and leaves their closure untouched.

Mutation 3 of 5. **The write guard survives and nothing can currently distinguish it**: clauses
run one at a time, so `MATCH … INSERT … RETURN COUNT { … }` lands every write before the
projection and reads the same count on every row — identical on the pristine build. Kept as
defensive, recorded rather than implied.

## 504 — VERIFICATION: tonight's ten items sweep clean, and `bun run bench`'s column is contaminated

A/B against the pre-session tree, three alternated rounds on the shared bench: `query: subquery
item` 35.4-37.0 -> 31.3-31.5 (1.14x), `query: 2-hop subquery item` 123.3-126.3 -> 103.0-109.6
(1.19x), and `count 3-hop` — the heaviest `shortcuts.ts` consumer, as the control — FLAT at
316-320 both sides. No regression from items 494-503.

**`bun run bench` runs every row in ONE process, so a short row is warmed and perturbed by the
rows before it.** `traverse 1-hop + filter` read 57.6 ms in the sweep against item 321's 39.7,
which looks like a 1.45x regression; isolated with `BENCH_ONLY='…$'` it is 38.7/39.6/40.7. The
counter-example keeps the rule honest: `count 3-hop` reads 321.6 in-sweep against 316.5-325.7
isolated, because a row long enough to dominate its process is unaffected. _A SHORT row in the
shared sweep is a question for an isolating instrument; a long one is a number._

**No new target came out of the cross-engine sweep** — every large ratio is already here (`count
3-hop` 300/310/324/350, `traverse 1-hop + filter` 311/321, `project the edge` 445/446, ingest 312).

**NEW, from `bench:usage`:** the TS engine's UNINDEXED column is 17-73x behind native while its
indexed column WINS — `read: point lookup` 2.1k against 44.3k ops/s, `write: property update` 631
against 46.2k, `interleaved: write + read` 351 against 23.2k. The write rows are widest because
these workloads find their node by `name` first, so an unindexed write pays an unindexed scan.
Per scanned node that is ~24 ns in TS against ~1.1 in native — the object-model constant factor.

## 505 — the anchor-then-traverse spelling: CLOSED (747.9 ms -> 0.0 for the count, 5.4x for a projection)

`MATCH (a:L) MATCH (a)-[:T]->(x)` and `MATCH (a:L)-[:T]->(x)` are one question; native costs the
same for both and TS did not, because every fast-path detector reads ONE `match` clause.
`fuseAnchorThenHop` rewrites the pair into one pattern before anything reads the clause list, so
all fifteen rungs apply unchanged. Two-clause `count(*)` 691-716 ms -> 0.0; two-clause projection
798-816 -> 146-156 ns/row; one-clause projection and the OPTIONAL count (which must NOT fuse) flat
as controls. `spelling-probe` gained the pair and flags 20.2x against the pristine engine.

**OPTIONAL was the lead and was a CONFOUND.** `OPTIONAL MATCH … RETURN count(*)` at 858 ms against
native's 4.6 looks like a left-outer cost; the same two clauses WITHOUT optional cost 747.9, so
OPTIONAL is worth ~1.1x. Item 445's rule again: _a ratio between two queries is a ratio between
two routes until you have shown they take the same one._

**Two mutants survived because they were MASKED BY EACH OTHER'S GUARD** — the start-variable check
hidden by the re-constrained-start check, and the anchor-has-no-segments check hidden by the
start-variable check. Two new cases (a bare-variable cross product, and an anchor binding two
variables) kill both. _A surviving mutant may be protected by a neighbouring guard rather than
untested._

**Open:** a THIRD clause does not chain onto a fused one (instrumented: 11 fusions, exactly the
pairs) — widening the anchor to "a pattern whose LAST node is the shared variable" is unpriced.
**Priced and NOT a target:** the set operators, a 2.2-4.3x constant factor on two scans with no
missing path.

## 506 — a repeated node variable was answered WRONG by every hop fast path: FIXED

`MATCH (a:P)-[:T]->(a)` means one node, so it matches the self-loops. TS read `count(*)` as 4
where native reads 2, and **eight of ten probed shapes diverged** (projection, grouped count,
`max`, reversed, undirected, unlabelled, named rel). The two that agreed were the two that
already declined to the general matcher — which has always been right. Each hop fast path binds
the far node OVER the start without checking the name.

Fix: `repeatsNodeVariable` gates the whole clause list once per compile; a self-join pattern is
handed an empty list, which every detector refuses. **Item 487 fixed this class one rung at a
time for a repeated REL variable, and that is precisely what left this one.** Controls flat
(plain `count(*)` 0.0 ms, plain projection 143-150 ns/row both sides, three alternated rounds).

**Found by accident, which is the lesson.** Item 506's clause-fusion widening routed
`MATCH (a:P) MATCH (a)-[:T]->(a)` into the one-clause spelling and the two stopped agreeing. The
differential fuzzer does not generate a one-hop pattern repeating its endpoint and the corpus has
no such case, so nothing was watching.
`packages/native/src/repeated-node-variable-conformance.test.ts` pins fifteen shapes across both
engines, ANSWERS as well as agreement, with the ordinary hop as the control the gate must not
catch. Mutation 3 of 4, null control clean.

**OPEN (written and measured, deliberately NOT in that commit):** chaining a third clause onto a
fused pair. `MATCH (a:P)-[:T]->(x) MATCH (x)-[:T]->(y) RETURN count(*)` costs **2286.3 ms against
103.4** for the one-clause spelling; native is 2.7 for both.

## 507 — fusion chains: an anchor is any pattern whose LAST node carries the variable. CLOSED at 29.7x

Item 505's open widening. `MATCH (a:P)-[:T]->(x) MATCH (x)-[:T]->(y) RETURN count(*)`
2176.1-2238.2 -> 74.0-74.5 ms, the three-clause form 2152.5-2211.4 -> 73.7-75.9, and both land ON
the one-clause control (74.2-74.4, flat). A one-hop projection is the second control, flat.

**The first guard switched the whole rewrite OFF and every test still passed.** It refused a
pattern whose `selector`/`mode` was not `undefined` — but `parsePathPattern` writes
`selector: 'walk'` and `mode: 'trail'` onto every pattern, so nothing fused at all, including
item 505's shipped case. _A rewrite that declines is only slower, so the suite cannot see it._
The instrumented fusion count did: 11 -> 0 -> 14.

Checked in both engines before relying on it: **the path MODE is not enforced on a FIXED-length
pattern** (`WALK`/`TRAIL`/`SIMPLE` all count the self-loop path that reuses its edge), a SELECTOR
cannot sit on one (parse error), and a var-length hop chains with all four spellings agreeing.

Mutation 2 of 5; `defaultPathShape` survives and is equivalent TODAY for exactly those reasons —
kept because enforcing mode later would make this rewrite a wrong answer without it.

`bun run spelling`'s second flag (`one end labelled…`, 2.2x) was item 504's shared-process
contamination: isolated it is a 1.09x spread.

## 508 — the OPTIONAL landing LABEL was discarded in native: FIXED

`OPTIONAL MATCH (u)-[:T]->(x:Q)` matched every neighbour and returned rows whose `x` is not a
`:Q` (count 4 against TS's 3). The optional lowering bound `node_plain`'s label and label
expression to `_lbl2` / `_v2_le` and used neither, while inline props and an inline `WHERE` did
become the `landing_pred`. Fix: the label goes through `landing_label_filter` into the same
predicate, written first. Pre-existing — confirmed against the pristine build before writing the
fix. Seven shapes now read ALL SAME cross-engine.

Mutation 4 of 5. **The label-EXPRESSION mutant survived the first run**: the suite had only a
bare `:Q`, and `node_plain` returns the compound form separately, so dropping `v2_le` changed
nothing tested. `x:!P` and `x:P|Q` kill it — the third survivor this session caused by a helper
returning two things where the test exercised one.

**OPEN (written and measured, deliberately NOT in that commit):** `try_fused_count` learning
`Plan::OptionalExpand` — `count(*)` as Σ max(degree, 1) — takes `optcount` **4.5 -> 0.6 ms**,
landing on the non-optional twin's 0.5. It needs a guard the plain arm does not: an unknown edge
type is ZERO rows for a plain hop and the SOURCE COUNT for an optional one.

## 509 — `count(*)` over an OPTIONAL hop: CLOSED at 7.6x

Item 508's held-back arm. A left-outer hop yields one row per source either way, so `count(*)` is
Σ max(degree, 1); `try_fused_count` now takes `Plan::OptionalExpand`. 4.6 -> 0.6 ms at 200,000
vertices / 1,000,000 edges, three alternated rounds, landing on the non-optional twin's 0.5. The
optional PROJECTION is the control this arm cannot reach, and is flat.

**A guard the plain arm does not need:** an unknown edge type is ZERO rows for a plain hop and the
SOURCE COUNT for an optional one. The arm inherited the plain early return and answered 0 where 3
is right — caught by this item's own test before it shipped.

**The DEEP arm's floor mutant survived until a case reached it.** `try_fused_count` has two arms
(a per-node count array when ≥2 hops feed the final one, a materialized frontier otherwise) and
every case written fed the optional hop from ONE hop. _Two arms need two cases, and the mutant is
what says which one the test reached._ Declining `count(DISTINCT …)` is conservative, not
load-bearing (the distinct arm's answer coincides) — documented at the guard.

## 510 — the TS OPTIONAL-hop count: CLOSED at 17x

Item 509's twin on the other engine. TS had no rung for the shape (every detector refuses
`optional` on its first check), so a left-outer `count(*)` cost 692-710 ms against native's 0.6.
`detectOptionalHopCount` walks the anchor bucket once summing max(degree, 1): **36.6-42.7 ms**,
three alternated rounds, plain count and a one-hop projection flat as controls. The residual
against native is the object model — 200,000 JS objects at ~185 ns against a CSR read.

**The adjacency box beat its own refutation again.** Each anchor is visited ONCE, which item 355
measured as 1.21x WORSE for the box — A/B'd anyway: box 36.6-42.7 against the id hash 46.4-47.1.
Third time at query scale (492, 494, now this); 355's number is a per-iteration micro.

Oracle: `count(*) + 0` declines the rung, and an instrumented run confirms 9 firings — the bare
spellings only. Mutation 6 of 7. **Admitting `both` survived until the fixture could tell**: the
refusal case used the `S` type, where undirected and in-only coincide at 3; the `T` type gives 4
against 3. _A refusal test proves nothing if the shape it refuses happens to agree._

## 511 — the OPTIONAL-hop PROJECTION: CLOSED at 2.8x

The projection twin of item 510's count rung. 851.6-838.6 -> 296.2-305.3 ns/row at 200,000
vertices / 1,000,000 edges, three alternated rounds; the non-optional two-clause twin and item
510's count are the controls, both flat. Native pays only 1.15x for the same pair, so the gap was
the missing rung.

**It lands at ~2x the non-optional rung, not on it**, and the reason is recorded rather than
chased: this calls `projectRow` per ROW where the tuned hop emitters hoist it per far VERTEX, and
that hoist is only valid when every projected item is a pure function of the far end (item 446) —
a null-filled row is not.

Mutation 5 of 6. **Setting `matched` before the label test survived**: it drops the null row only
for an anchor whose neighbours ALL fail the landing label, and the main fixture has no such
anchor. A two-node graph whose only edge lands on the wrong label kills it. Third survivor this
session that was a FIXTURE COINCIDENCE rather than a missing assertion (505, 510, 511). Oracle:
`SKIP 0` declines the rung; instrumented at 9 firings.

## 512 — a `LET` before the RETURN dropped the query off every rung: CLOSED at 8-11x

`LET` is how this engine names an expression (and the only way to key a `GROUP BY`), but every
node rung reads a TWO-clause shape, so `MATCH … LET … RETURN` fell to the general pipeline:
126.4 ms against 13.7 for the same projection written directly, and 108.3 against 0.0 for a
`count(*)` that never reads the name. Native pays 1.24x for the pair. `inlineTrailingLet`
substitutes the expression into the following projection and drops the clause.
109.6/112.9 -> 13.5/10.0/9.6 ms; the count row to 0.0. Direct projection and the `GROUP BY`
spelling flat as controls. **Both `LET` rows are BIMODAL before the change** (54.7 vs 109.6), so
the claim is the conservative 8-11x.

Shallow by design: an item either IS the variable or does not mention it, so no tree is rewritten
and no nested binder can be entered. `GROUP BY`/`HAVING`/`RETURN *` decline.

**The COLUMN NAME is not the expression's** — an un-aliased `RETURN a` names its column after the
expression, so the first version renamed `a` to `n.k`; caught by `DISTINCT over a LET-bound name`.

**"Cheap and pure" needs TOTAL, and only a faulting expression shows it.** Mutation 5 of 6;
admitting any expression survived against an `abs(n.k)` case (total, so inlining is invisible).
`CAST('abc' AS INTEGER)` and `1 / 0` throw where a dropped LET answers — fourth survivor this
session that was a fixture coincidence (505, 510, 511, 512).

**PRICED, not taken:** `ORDER BY … LIMIT 10` ts 80.0 against native 1.0 (TS has a top-k already;
this is the row pipeline), its hop form 707.8 against 9.3, `FOR x IN [1,2,3]` 160.6 against 4.3,
and the inline `CALL (n) { … }` **996.2 against 6.2** — the widest left.

## 513 — a correlated inline `CALL` is its own `MATCH`: CLOSED (900-1005 ms to 0.0)

Item 512's widest leftover. The body ran once per incoming row through the general matcher:
1005.2/909.1/902.4 ms against native's 6.2 and against 0.0 for the one-pattern spelling.
`inlineCorrelatedCall` rewrites the clause to the equivalent `MATCH`; item 507's fusion then
merges it into the preceding one and the ladder answers it. Plain count and item 512's `LET`
projection flat as controls. **Three rewrites now compose (505/507, 512, 513) and none added an
execution path.**

**The condition whose violation is invisible:** a body may introduce only the names it RETURNS.
`CALL (n) { MATCH (n)-[:T]->(x)-[:S]->(y) RETURN y }` hides `x`, and inlining would leave it
bound — visible only through `RETURN *`, which is the single assertion that catches its mutant.

Mutation 3 of 5. **Inlining an UNCORRELATED call survives and is a genuine EQUIVALENCE** (a body
with no correlation yields the same rows per outer row, so the join IS a cross product); the
guard stays because the execution contract differs — run once and reuse — and changing that is
its own measurement.

## 514 — VERIFICATION: items 505-513 sweep clean, and the shared sweep contaminates BOTH ways

Three harnesses re-run after nine items. Two rows looked adverse against item 504's sweep and
neither is: `query: group + aggregate` 3.9 -> 8.2 in-sweep but **3.5-3.8 isolated**, and
`query: project the element + materialize` 27.4 -> 45.5 in-sweep but **44.0-46.9 isolated BOTH
before and after** (A/B against the pre-505 tree, three alternated rounds: 45.4/44.2/46.3 against
43.5/46.1/47.7).

**So 504's 27.4 was contaminated LOW.** The rule extends: a short row in the shared sweep is
perturbed in both directions, so _comparing two sweeps' numbers for the same row is not a
regression check at all_ — only an isolated A/B is.

**Two independent confirmations**, on harnesses nothing was tuned against: `query_bench`'s
`optional hop` 4534.4 -> 582.7us (7.8x) and `optional hop + miss` 643.5 -> 64.9 (9.9x) from item
509, with `optional hop + landing pred` flat because it declines; `bench:usage` unmoved to better
(point lookup ts(+) 956.0k -> 1.08M ops/s).

## 515 — `count(*)` over a constant `FOR`: CLOSED (76-83 ms to 0.0)

Item 512's last priced row. A constant `FOR` multiplies every incoming row and the general path
built all 600,000 of them. The rung asks `detectCountShortcut` for the base with the `FOR`
removed and multiplies by the list length, so every shape the ladder counts is covered.
78.8/82.7/76.4 -> 0.0 ms, three alternated rounds; a PER-ROW list (which declines) and the plain
node count flat as controls. **The row is BIMODAL** — item 512's batch read 175.1 for it — so the
before is the paired 76-83.

Mutation 4 of 5. **Admitting non-literal ELEMENTS survived**, exactly as item 512's
`cheapPureExpr` did: `[1, n.k]` has length 2 either way. `[1, 1 / 0]` and
`[1, CAST('abc' AS INTEGER)]` kill it — _fifth survivor this session needing a FAULT rather than a
value to distinguish a totality guard._

`PLIST=1` adds the list column to BOTH probe fixtures (item 471's trap); the two copies are now
one `nodeProps(i)` helper.

**PRICED, left:** a per-row list needs Σ length (191.1 against native 15.8), a different walk; the
`FOR` projections are 2.2-2.7x constant factors with no missing path.

## 516 — the `WITH` pipeline: CLOSED at 8-12x, `count(*)` to 0.0

Item 512's `LET` cliff in its other spelling, never measured until now: `WITH n.age AS a RETURN a`
124.0 ms against 13.7 written directly, and `RETURN count(*)` 112.0 against 0.0 (native 17.7 and
0.6). `boundExprs` recognizes either binder and `inlineTrailingLet` substitutes both.
112.6/109.5 -> 0.0 for the count, 115.9/112.7 -> 13.9/10.5/9.6 for the projection; item 512's
`LET` projection and the direct one flat as controls. **Bimodal like 515** (46.0 against 112.6),
so the claim is 8-12x against the common mode.

**`WITH` REPLACES the row where `LET` ADDS a binding**, so a `WITH` may carry several items (a
projection evaluates all of them against the INPUT row) while the `LET` arm takes one.
Generalizing to multiple items BROKE the `LET` arm and an existing test caught it: `LET a = n.k,
b = a` is sequential, so one substitution map rewrote `b` to `a` with `a` unbound and the column
came back `undefined` — `a later LET item may read an earlier one` exists for that.

A `WITH` that filters, dedupes, groups, orders, pages or aggregates is a row boundary and
declines. Mutation 4 of 5 (the fifth is the null control).

**PRICED AND ALREADY FAST:** `SELECT count(*) FROM MATCH …` is 0.0 ms in TS — the ISO `SELECT`
spelling lowers to the same clause list. Measured rather than assumed.

## 517 — the four clause rewrites compose: VERIFIED

`inlineTrailingLet` (512, 516), `inlineCorrelatedCall` (513) and `fuseAnchorThenHop` (505, 507)
all run on every query, and each was only ever tested alone. Nine composed shapes, each asked
composed and written directly, compared as multisets — including the two cases where a rewrite
could hand the next stage a shape it answers wrongly: **fusion can PRODUCE a repeated node
variable** (item 506's gate runs on the rewritten list and still catches it) and the OPTIONAL
rungs' three-clause shape must survive a fusion before it.

**All nine agreed on the first run, which is when a test is most likely vacuous** — the
instrumented counts are what make it evidence: 12 binder inlines, 10 CALL inlines, 26 fusions
across the file. Order affects REACH, not correctness.

**Also checked:** `bench:gremlin`'s two widest ratios are both item 235's — the
`values(age)` ordering guarantee and the shared adjacency floor. No new target on that surface.

## 518 — a per-row `FOR` list: CLOSED at ≥5x (commonly ~32x)

Item 515's companion. `MATCH (n:L) FOR t IN n.tags RETURN count(*)` materialized 600,000 rows to
count them; the rung walks the anchor bucket and sums the lengths, with ISO's unwind semantics as
the arithmetic — a list contributes its LENGTH (empty: 0), NULL or a missing key 0, and any other
scalar 1. 82.9/72.6/83.2 -> 2.5/2.3/16.3 ms, three alternated rounds; the third after-round is an
outlier, so the claim is at least 5x with the common mode ~32x. **It also beats native's 15.8 on
this shape.** The constant `FOR` and the plain node count are the controls, both 0.0.

Mutation 5 of 6; the anchor-variable check is equivalent by construction (with one lone-node
`MATCH` the anchor is the only name in scope, and a pattern with segments is refused earlier).

**One mutant was MISAPPLIED** — the bucket-iteration line is character-identical to item 510's
rung — and the uniqueness assert caught it. Items 474, 483, 494, 518: _two copies of a body is
the most reliable way to fool a mutation run here._

## 519 — the native unwind count: CLOSED at 1.9x (and the constant list to 0.0)

Item 518's twin on the other engine — TS had become FASTER than native on this shape (2.3 against
15.8). `try_fused_count` now takes `Plan::Unwind`: 16.5/16.9/16.5 -> 9.9/8.7/8.5 ms for a per-row
list, and the ROW-INVARIANT `FOR x IN [1,2,3]` 3.3/3.2/3.2 -> 0.0. Plain node count flat.

**My first version made the constant list 3.4x WORSE** — 3.4 ms to 11.6 — by evaluating the list
per input row and building 200,000 identical `Value::List`s to learn one length. The fix mirrors
`unwind_rows`' own `slots_read` check: an invariant list is evaluated ONCE and multiplied. _A fast
path has to mirror the operator's INVARIANCE check, not just its element rule_ — and it was caught
only because the other shape's probe case was in the same measurement pass.

Mutation 4 of 5. Oracle: `count(*) + 0` declines the arm, so the general `unwind_rows` answers the
same question; every case asked both ways. ISO's rule pinned case by case (list → length, empty →
0, NULL/missing → 0, scalar → 1), with `count(t)` checked separately as a different question.

## 520 — items 515-519 sweep clean: VERIFIED on three harnesses

`bun run bench`, `bun run bench:usage` and the Rust `query_bench`, against item 514's recorded
values. Flat-to-better everywhere except two short rows that read UP in the shared sweep
(`count distinct` 2.9 → 3.8, `distinct over a hop` 58.9 → 61.2) and came back at or below 514
once isolated (3.0/3.0/3.2 and 53.6/56.6). Item 514's rule again: a short row in the
shared-process sweep moves in BOTH directions, so a sweep-to-sweep comparison is not a regression
check — only an isolated A/B is.

Both of those rows are also a usable CONTROL for the batch: every rung items 515-519 added
refuses a `DISTINCT` aggregate on its first guard, so the change cannot reach them.

Native: `optional hop` 577.9 (514: 582.7), `+ miss` 64.3 (64.9), `+ landing pred` 10040.0
(10278.0), `EXISTS` 1131.2 (1147.9), `for-in const x3` 15.3 µs. Serving side untouched
(`read: point lookup` ts(+) 1.02M). No engine change.

## 521 — a correlated subquery body's label test: CLOSED at 10.5x

`opt` never descends into a `Plan` nested inside an `Expr`, so a correlated body kept GQL's raw
`'L' IN labels(slot)` — a `Value::List` built and a string hashed per row — where a top-level plan
is canonicalized to `IsLabeled` (bucket membership, no allocation). `COUNT { (x)-[:KNOWS]->(b:Half)
WHERE b.age > 50 }` cost 186.1 ms at 200,000 vertices; the same query written at the top level cost
3.3. `canon_body_labels` runs the one rewrite on the body `correlated_subquery_body` returns, so
`EXISTS` / `COUNT` / `VALUE` all get it from one place.

Before 187.1 / 192.4 / 187.5 → after 18.0 / 18.0 / 17.5, disjoint, three alternated rounds with a
rebuild between each. Net of the 11.3 ms egress floor the body is ~25x. Controls flat: `corrfilt`
17.9 → 18.2, `corrlblonly` 26.0 → 24.6, `corrdeg` 11.3 → 11.4.

Diagnosis before the fix, and it is what ruled out the obvious answers: two property filters cost
22.2 ms and the label alone costs 26.0, so 186.1 is neither the filter count nor the label test as
such — it is the label test on the GENERAL path, which the degree fast path reaches only when
nothing else is in the body.

**The TS engine does not have this bug** — measured, not assumed: `corrlblfilt` 614.4 against
`corrfilt` 669.4, so the label is cheaper there. Nothing to port.

Mutation 4 of 6 (null control clean). Two of the four were caught only after the test read the
PLAN rather than the answer: _a rewrite that is a pure canonicalization cannot be tested by its
answers_, since both spellings agree by construction. The surviving mutant is the `slot <
row_width` guard, redundant today (the exact-endpoint match already refuses outer slots) and kept
as the defense against a future caller mis-counting `row_width`.

STILL OPEN, and separately: the whole correlated-subquery route in the TS engine, ~3 µs an outer
row (34x native on this shape). And a `spelling_probe` group for this pair, which needs a second
label in that fixture.

## 522 — the same label bug in a `CALL` arm: CLOSED at 25x

Item 521 patched `correlated_subquery_body` (`EXISTS` / `COUNT` / `VALUE`). `call_arm` is a SECOND
correlated-body builder and kept the raw `'L' IN labels(slot)`:
`CALL (x) { MATCH (x)-[:KNOWS]->(b:Half) WHERE b.age > 50 RETURN b }` cost 171.4 ms against 8.1
for the same arm unlabelled and 5.6 bare. A wider ratio than 521's because a CALL arm has no
degree fast path to amortize the label test against.

One line on what `call_arm` returns, covering the yielding form, every UNION / EXCEPT / INTERSECT
arm and the scalar-aggregate form that becomes a `CountSubquery` / `AggSubquery` instead.

Before 174.0 / 181.8 / 173.0 → after 6.9 / 7.0 / 6.7, disjoint, three alternated rounds with a
rebuild between each. Controls flat: unlabelled arm 8.1 → 8.0, bare arm 5.6 → 5.5, item 521's
shape unchanged at 17.5.

**The `+ 1` is the subtlety**: a CALL arm's body is provenance-tagged, so its `Plan::Row` leaf
stands for `outer_width + 1` columns. Off by one either way and the endpoint match silently never
fires with every answer still correct — which is what two of the three mutants are.

Mutation 3 of 4 (null control clean), all caught by the PLAN read rather than an answer.

TS measured, not assumed: 21.3 ms labelled against 39.9 unlabelled, so no cliff there. Note what
that means — TS was 8x FASTER than native on this shape before the fix and is 3x slower after.
_A cliff in one engine can hide behind a cross-engine ratio that looks like the usual constant
factor._

## 523 — the other `normalize_pred` rewrites inside a correlated body: REFUTED, no cost

Each paired with the spelling `opt` would have produced, native, 200,000 vertices:
`IN [11, 22, 33]` 20.0 vs the OR chain 20.0; `NOT b.age = 11` 19.4 vs `b.age <> 11` 19.3;
`50 < b.age` 17.6 vs `b.age > 50` 17.9. Every pair within the other's noise.

The `IN` result contradicts that rewrite's own comment (~75x for a nested `IN` over a hop) and
the reason matters: that was a TOP-LEVEL hop, where the filter runs over a wide batch and the
boxed list is re-cloned per row. A correlated body runs per outer row over one vertex's degree.
_A rewrite's value is a property of the batch width it runs at, not of the expression._

So the label test (521, 522) was special because it is the only one of the four whose two
spellings reach DIFFERENT evaluators — bucket membership vs a list build plus a string hash —
rather than the same evaluator with a different tree.

**Gremlin has none of this**, checked structurally: `IsLabeled` appears once in `gremlin.rs`
(where `hasLabel` mints it) and `"labels"` appears nowhere, so no Gremlin correlated body can
carry the raw spelling. Sweep closed: 521, 522, Gremlin, and these three.

OPEN, newly priced: the TS correlated count with a landing WHERE — 745.6 ms against native's
18.2 (41x). `degreeCountSubquery` declines on its first line (`expr.where !== undefined`) and
falls back to materializing bindings per outer row. Its controls are the two rows that DO take
the rung: the bare count 100.6 (native 11.3) and the labelled one 362.3 (24.6).

## 524 — the TS landing-predicate degree count: CLOSED at 1.9x (19x native, was 36x)

`degreeCountSubquery` refused any body with a `WHERE`, so `COUNT { (x)-[:KNOWS]->(b) WHERE
b.age > 50 }` materialized the body's bindings per outer row. `landingPredDegreeCount` walks the
anchor's adjacency box and gates each neighbour; the loop is `sideOfVertexGated` at MODULE scope,
because a walk inside a returned closure is item 268's 4x hazard.

Before 661.6 / 649.2 / 637.3 → after 346.0 / 354.4 / 312.3, disjoint, three alternated rounds with
a rebuild between each. Control (a body with no `WHERE`, which never reaches the new code)
74.6 → 75.4. Still 19x native, so the per-neighbour predicate call is what is left.

**The first after-reading was the UNCHANGED engine**: the probe reads the built dist, so it showed
868.3 against 745.6 and read as a regression. `fuzzers-read-built-dists` applies to every TS
harness, not only the fuzzers.

Mutation 4 of 7 (null control clean). Both survivors explained, one of them changing the code: the
self-join guard is redundant (the call site's `binding.has` already stands the rung down), and the
no-subquery guard protects against a hazard that does not exist — the scratch binding is per
`countOf` CALL, so a nested subquery gets its own. It stays as conservatism and the comment now
says so; widening it is its own measurable change.

NEW, and it generalizes item 514: **`bun run spelling`'s full run needs isolating too.** It flagged
a group the change could not reach at 2.1x where the pristine build flagged none; isolated with
`SPELL_ONLY` that group is 1.04x on BOTH builds. And a LONG `bun run bench` row is not immune to
sweep variance either — `count 3-hop` read 358.6 in-sweep and 324-328 isolated, inside its usual
321-330 band.

## 525 — a WRONG ANSWER in the one-hop EXISTS arm (FIXED), plus 1.11x

`oneHopExists`'s FREE-endpoint arm (item 492) answers from a bucket SIZE without visiting an edge.
`shape.free` is a compile-time fact about the pattern text; boundness is a run-time one, and the
arm never checked it, so an endpoint the outer row had bound was IGNORED:

```text
  MATCH (x), (y) WHERE y.n = 3 AND EXISTS { (x)-[:T]->(y) }   ts: x = a AND d   native: a
  MATCH (x) WHERE EXISTS { (x)-[:T]->(x) }                    ts: every x       native: d
```

`degreeCountSubquery` has carried exactly this check since item 211 and its comment spells out
why; the EXISTS twin never got it. Fixed by gating the free arm on `!binding.has(far.variable)`.
Pinned cross-engine in `bound-exists-endpoint-conformance.test.ts`. **Fourth wrong answer this
loop, fourth found by probing rather than by a failing test** — the differential fuzzer does not
generate an EXISTS whose endpoint the outer row has bound (item 506's blind spot again).

Perf half, CLOSED at 1.11x and the hypothesis REFUTED: a label-only endpoint now tests the label
directly instead of calling `matchNode`, which allocated a binding per edge for a variable
nothing reads. 280.2 / 279.3 / 280.5 → 257.9 / 248.6 / 250.7, disjoint, free arm flat. _The
allocation is 11% of the 2.9x gap between the two arms, not the cause of it_ — the rest is the
edge iteration (items 218, 194). Still 16x native.

**A 5-rep reading nearly retracted it**: at PR=5 the after read 307.5 against 277.6 and looked
like a regression; at PR=7 it is disjoint. The route-cost probe is bimodal the way the spelling
probe is (item 259) — use PR=7 or more for anything under ~1.2x.

Mutation 6 of 7 (null control clean).

## 526 — the differential fuzzer now generates a SELF-ENDPOINT subquery body

The gap items 506 and 525 both hid in: a subquery whose endpoint names the variable the outer row
already bound. `subqueryBody` now draws a self arm (the endpoint is `n`, unlabelled — a bound
variable may not be re-labelled inside a body, and native's rejection of that is correct).

Teeth, in three parts, because a widening is a claim about what a generator can find:

1. the widened fuzzer catches item 525's bug (the free arm ungated) **6 of 6 seeds**;
2. the PRE-widening fuzzer **misses it 0 of 6** — which is what makes (1) a statement about the
   widening rather than about the suite;
3. switching the self arm off (`const self = false`) makes the run RED on the coverage floor, so
   the counter gates rather than decorates.

Floors from NINE seeds of 20,000: generated 41-61 (mean ~49, sigma ~6.1) → `> 22`; non-empty
29-43 (mean ~35, sigma ~4.9) → `> 14`. ~4 sigma below the means, per item 280 — the safety of a
floor is its distance in SIGMA, not a percentage.

STILL OPEN: item 506's own shape is a TOP-LEVEL `MATCH (a:P)-[:T]->(a)`, and the OUTER-pattern
generator still does not produce a repeated endpoint. Different function, next widening.

## 527 — the TOP-LEVEL repeated endpoint is now generated, and the fixture has a self-loop

Item 526 closed the subquery half and named this one: item 506's shape is a top-level
`MATCH (a:T)-[:E]->(a)`. Seven shapes now generate it (one-hop both directions, with/without a
label, with a bound edge variable, with a `WHERE`, and the two two-hop forms returning to the
START and to the MIDDLE).

**The fixture had no self-loop**, which made item 526's arm half a test: with none, `(a)-[:E]->(a)`
is correctly EMPTY, so an OVER-counting fast path is caught but an under-counting one is not — and
item 506's bug was an over-count whose size needs a real self-loop to show. Edge `e7`
(`5 -[:F]-> 5`) is it: on `F` at a leaf of the F chain, so the E cycle the four PATH MODES depend
on is untouched, and safe under every mode paired with an unbounded quantifier.

Teeth, four parts:

1. item 506's bug (the `repeatsNodeVariable` gate forced false) is caught **5 of 5 seeds**;
2. the PRE-527 fuzzer, which already has item 526's subquery arm, **misses it 0 of 5** — so the
   subquery widening was genuinely not enough;
3. removing the WHOLE family fails the coverage floor;
4. removing ONE shape of seven does NOT — recorded, not fixed. The floor is a FAMILY-level gate
   with a ~4 sigma margin; per-shape floors would flake, and a collapse is the failure mode that
   has actually happened (item 280).

Floors RE-measured because a fixture change moves a count (`selfEnd` went 41-61 → 40-57), nine
seeds each: `selfEnd > 22 / > 14`, `selfHop > 18 / > 15`.

Both wrong answers that hid in this family are now reachable from both sides, each backed by a
before/after mutation rather than by the widening's existence.

## 528 — the TS `FOR` projection: CLOSED at 4.0-4.4x, and it now beats native

Items 515 and 518 did the `count(*)` form. A projection must emit the rows, so it LOOKED like the
cost was the walk. The third measurement is what said otherwise: `MATCH (n:Person) RETURN n.age`
with no `FOR` is ts 9.5 against native 11.0, so TS is FASTER without one — the 2.0-2.4x was the
per-element BINDING machinery (`new Map` per element, an array of those per row, a final map walk:
three allocations an element, 162 ns a row against 48), not projection and not element render.

`detectForProjection` walks the label bucket and reuses ONE scratch binding per call, since
`projectRow` returns a fresh `Row` and nothing retains the binding (item 524's trick). The walk is
module-scope, not inline in the closure (item 268).

Prop list 95.2 / 159.7 / 99.9 → 25.2 / 23.7 / 24.0 (~4.0x); constant list 93.2 / 91.5 / 92.2 →
26.2 / 21.1 / 20.6 (~4.4x); the no-`FOR` control flat at 9.8-11.7 → 9.6-10.9. Three alternated
rounds with a rebuild between each, disjoint.

**OPEN on the other side now: native's `FOR` projection**, which these numbers beat (24 and 21
against 50.8 and 40.1).

Mutation 7 of 7 (null control clean). One mutant MISAPPLIED first — the label-bucket line is
character-identical across three rungs in the file, so the pattern matched three times, and the
uniqueness assert is the only reason it read as a misapplication rather than a survivor. Items
474, 483, 494, 518, 528.

## 529 — native's `FOR` projection: RETRACTED, item 528 read the carrier

Item 528's closing sentence named native's `FOR` projection as open because the TS numbers (24 and
21 ms) beat it (50.8 and 40.1). Both native numbers are FFI, with 600,000 rows crossing the
boundary. In process the same query is **14.7 / 14.9 ns/row** (`query_bench` `for-in const
project` 8800.4 / 8944.3 us), against 2.3-4.3 for a one-column plain projection. 67 − 14.8 = 52
ns/row, inside the 58-94 ns/row native egress the probe's own header records (items 428, 434).

So it is the JSON CARRIER, **closed at item 289** — and item 341's entry warns about this exact
mistake in capitals, two lines from where I was reading. _A number that is valid for the
comparison you ran is not valid for the one you mention in the last paragraph:_ item 528's
TS-vs-TS A/B was three alternated rounds on one harness; the ts-against-native remark was not
measured at all.

LEVER NAMED, NOT PRICED: the non-invariant arm of `unwind_rows` calls `value_at(i)`, which hands
back an owned `Value::List` — a `Vec` per input row. Estimated ~18 ns/row from the FFI pair
(85 − 67), through a carrier that is itself ±36 ns/row, so the estimate is weak. It cannot be
measured in process until something has a list property: `query_bench`'s shared `social_store` has
none, and adding one moves every other row in the group off its recorded baseline (item 527's
trap).

Also re-refused by their own records this tick, so nobody prices them again: `nested count :label`
/ `k2 count :label` (within 6% and 14% of the enumeration floor — "there is no prize there"),
`distinct node` (dedup is 17.5 ns/row; the rest is the element-render ladder), and `traverse 1-hop
project + start filter` / `distinct over a reversed hop` (items 207 and 215, both row-returning so
the ts column carries the carrier).

## 530 — the aggregate enum: five of eleven had no scan rung (CLOSED, 2.7-4.3x) + a NATIVE PANIC fixed

Priced all eleven ISO aggregate names against the same scan with the same argument, ts at 200,000
vertices. Six took the rung (`count` 10.9, `max` 11.2, `min` 11.3, `sum` 13.6, `avg` 13.7,
`count(DISTINCT)` 3.0); five did not (`stddev_pop` 50.9, `percentile_cont` 56.8,
`percentile_disc` 64.3, `stddev_samp` 69.9, `collect` 72.4). Native answers all eleven in
0.4-5.6 ms, so the gap was TS-only and up to 64x.

**THREE arity gates in one function and only the third mattered.** Widening the multi-item gate
moved almost nothing (percentile_cont 56.8 → 62.1); `unfilteredScanAgg`, the SINGLE-item gate,
runs ahead of it and admitted only sum/avg; a third `args.length !== 1` further down refused the
two-argument percentiles. _"Grep the pattern elsewhere" applies inside one function as readily as
across a repo._

The fix is a NAME SET, not five folds: every member reaches `aggregateOverValues`, the one shared
implementation the general path calls, so arithmetic and order are identical by construction (a
second `sum` cannot be written correctly — item 467 — and a second `stddev` is a byte-identity
hazard). collect 45.4-60.5 → 11.0-12.5; stddev_samp 50.9-52.4 → 11.8-12.7; percentile_cont
60.5-67.8 → 21.9-22.4. Three alternated rounds, disjoint; the fold path and `count(DISTINCT)`
flat as controls.

### The native panic

`percentile_cont(n.age, 2)` **PANICKED**: `percentile_of` computes `rn = frac * (n - 1)` and
indexes `nums[rn.ceil()]` with nothing clamping `frac`. The `disc` branch survived on its own
`.min(n - 1)`. It surfaces as `query evaluation panicked` — a crash, not an error. Fixed with the
same clamp TS applies when it lowers the literal, at the point of USE so no caller can bypass it.
**Fifth defect this loop found, fifth found by probing rather than a test**: no fuzzer generates a
fraction outside [0, 1] and both engines' percentile tests used in-range values.

OPEN, recorded: a NEGATIVE literal fraction diverges — TS raises (`-1` is a unary-minus
expression, not a literal token) while native clamps to the minimum. ISO does not define it.

Mutation 4 of 5 (both null controls clean). The survivor — the TS non-literal refusal — is
unreachable by construction, since `compileProjection` raises on a malformed percentile before
any rung is consulted.

**Two of my own test expectations were wrong and the twin caught both** (`percentile_disc(x, 0.5)`
is 20 not 30; `stddev_pop(x, 1)` throws in neither engine). And the first twin, `WHERE n.age >= 0`,
was UNKNOWN for a vertex with no `age` and silently dropped a row: _a declining twin that asks a
different question is worse than none, because it reads as a divergence in the code under test._
`WHERE true` is the one that keeps every row while turning `unfilteredScan` off.

## 531 — out-of-range percentile fractions are now generated; the boundary surface is otherwise CLEAN

Item 530's native panic reached main with a percentile arm already in the fuzzer: it picked from
`['0', '0.5', '1', '0.25']`, so the only value that could crash the `cont` branch was the one it
never produced. Added `1.0001`, `1.5`, `2`, `100`.

Teeth, three parts: the widened fuzzer catches the panic **4 of 4 seeds**; the PRE-531 fuzzer
**misses it 0 of 4**; removing the out-of-range values fails the coverage floor. Floors from nine
seeds: generated 156-200 (mean ~180, sigma ~12.6) → `> 128`; non-empty 76-96 (mean ~90, sigma
~7.3) → `> 58`.

No negative fraction, deliberately: `-1` is a unary-minus expression rather than a literal token,
so TS raises and native clamps — the open divergence recorded at item 530. Generating it would
make the gate red for a known question.

**THE CLASS IS SWEPT AND CLEAN.** Every float-to-index conversion in the engine
(`ceil/floor/round/trunc as usize`) is in four places: the two percentile branches (clamped), the
`disc` branch's own `.min(n - 1)`, and `opt.rs`'s seek cap, which derives from the live node count
and not from user input. And fourteen boundary arguments compared row for row across both engines
— `substring` past the end / over-long / zero length, list index 0 / 99 / empty, `head`/`last` of
an empty list, string indexing, `round(±400)`, division by zero, a huge `power`, `log10(0)`,
`sqrt(-1)` — **all fourteen agree**; the only apparent difference is the division-by-zero error
PREFIX, which is message text the fuzzer compares by code.

So the percentile was the one hole, not the first of many — which is the thing neither
"it's isolated" nor "it's widespread" could have told us without the sweep.

## 532 — the HOP aggregate enum: 7 of 11 off the rung, 5 of them CORRECTLY (item 419)

Item 530's enum over a one-hop pattern instead of a scan. ts, 200,000 vertices / 1,000,000 edges:
on the rung `max` 155.8, `min` 152.1, `count(b.age)` 157.1, `count(DISTINCT)` 57.5; off it `sum`
674.2, `collect` 688.5, `stddev_pop` 690.4, `avg` 701.1, `stddev_samp` 715.3, `percentile_disc`
730.0, `percentile_cont` 742.6. Native for scale: `max` 2.4, `sum` 5.5, `percentile_cont` 10.0,
`collect` 41.3 — a ts:native ratio of 17x to 123x.

**FIVE of the seven must stay refused, and that is item 419's recorded rule**: the far-driven walk
may visit rows in a different order from the general path, so only an order-INDEPENDENT aggregate
may ride it. `sum`/`avg` (float addition is not associative — a different order is a different last
ulp, against a hard byte-identity invariant), `collect`/`collect_list` (the order IS the answer)
and the two `stddev`s (one-pass moments, order-sensitive the same way). Widening this rung the way
530 widened the scan would be WRONG, not slow.

_This is why an enum is worth pricing even where it cannot be fixed_: without item 419 those five
rows look exactly like five missing fast paths worth 4.5x each.

OPEN, priced not built: **`percentile_cont` / `percentile_disc` CAN ride it** — they sort their
values, so the answer is order-independent, which is the one property the rule asks for. 742.6 and
730.0 against the rung's 155.8, about 4.7x. The NaN caveat is closed rather than waved past: a
comparator that maps incomparable values to Equal would be order-dependent, but the numeric model
converts a non-finite to `null` on ingest and item 531's probe confirms the expression surface
agrees (`log10(0)`, `sqrt(-1)`, an overflowing `power` all yield null, which the non-null filter
drops). The edit needs an `argFn` that `foldedAggs` does not carry for a non-foldable aggregate,
so the argument must be compiled for the synthetic projection as the SCAN path already does.

## 533 — the percentile HOP rung: CLOSED at 4.0x; and a control that read as a regression and was not

Item 532's one sound half. `percentile_of` sorts its values, so a percentile is ORDER-INDEPENDENT
and may ride the hop walk under item 419's rule; the other four non-foldable names stay refused.

`percentile_cont(b.age, 0.5)` 753.2 / 748.8 / 740.2 → 176.1 / 182.9 / 190.4 ms, disjoint, three
alternated rounds with a rebuild between each. `percentile_disc` 730.0 → 205.7. `sum` — the control
that must STAY refused — 699.6 / 714.1 / 694.4 → 672.3 / 706.6 / 711.0, overlapping.

**THE FOLD CONTROL READ AS A 1.02-1.23x REGRESSION AND IT WAS NOT ONE.** The first version put the
collect branch inside the existing row loop; `max(b.age)` then read 125.7-127.5 before against
129.0-156.8 after, three alternated rounds, non-overlapping at the bottom. Splitting the loop did
not restore the number (158.5), which prompted a SECOND A/B rather than a third fix — and that came
back 141.4 / 160.1 / 146.9 against 179.2 / 161.3 / 125.8, overlapping and non-monotonic. The row is
bimodal **across builds**: 125-180 ms for the same source, and item 532 measured the same pristine
code at 155.8.

_Three alternated rounds can read disjoint by luck on a bimodal row._ Min-of-three is necessary and
not sufficient; what settled this was a second independent A/B after a change that should have
fixed the thing and did not.

Mutation 4 of 5 (null control clean), two of the four only after strengthening the tests. The
surviving NAME check is explained at the guard: admitting `collect` changes no answer on a
four-node fixture, because the walk goes far-driven only under conditions that small a fixture
cannot meet — which is why item 419 is a rule rather than a test.

Harness notes worth reusing: `collect(x) + 0` cannot be a declining twin (arithmetic on a list
raises — use a second projection item); and `percentile_cont(DISTINCT x, 0.5)` over `[10, 10, 20]`
is 15 against the non-DISTINCT 10, while `disc` is 10 either way — so a `disc`-only test cannot
catch a rung that ignores DISTINCT.

`percentileFraction` now lives in `executor.ts` and is shared by the scan rung (530) and this one.

## 534 — items 521-533 sweep clean: VERIFIED, and two apparent regressions were single-run outliers

Thirteen items since item 520's sweep. `query_bench` flat or better on every row (`optional hop`
589.8 against 582.7, `+ miss` 63.7 against 64.9, `+ landing pred` 9957.2 against 10278.0, `EXISTS`
1134.5 against 1147.9, `distinct node` 116176.4 against 117461.9). Both spelling probes clean — run
specifically because 530 and 533 changed which aggregate SPELLINGS reach a rung.

Two rows read up in `bun run bench` and neither survived isolation: `distinct over a reversed hop`
92.2 in-sweep against 62.4 / 59.3 / 59.4 isolated (BELOW its recorded 72.9), and `count 3-hop`
352.4 against 308.7 / 324.9 / 340.3 (inside its 311-342 band). Item 514's rule, fourth observation.

**NEW, and the part worth keeping: `bench:usage` needs a repeat too.** `read: keyed dedup lookup`
ts(+) read 48.6k against item 520's 77.8k — the shape of a real regression on a row the TS rung
edits could plausibly reach — and two further runs gave 72.2k and 77.9k. `engine(+) read: point
lookup` did the same (256.3k, then 360.0k and 359.4k). It is ops/sec from best-of-3 over 250 ms
batches, so _a single reading is not a signal_. Third instrument in this session found to need a
repeat before a number means anything: `bun run bench`'s short rows (514), the spelling probe's
groups (524), and now this.

## 535 — ~~OPEN, PRICED~~ SUPERSEDED by 536-538: a redundant label costs 2.6-7.3x in TS, via a route change at the SECOND conjunct

> **NOTHING HERE IS OPEN (marked at item 583).** The heading said "OPEN, PRICED" and a reader
> grepping for a target lands on it before reaching the three entries that resolve it:
> **536** refuted the GQL half outright (a redundant label costs NOTHING in GQL — 4.41 against
> 4.40 — and the "+37 then +4 route change" was the labelled query running third in a shared
> process); **537** closed the surviving Gremlin half at 4.0x with `filterChainCount`; **538**
> closed the seeding for every terminal at 2.4-2.5x. Read on rather than acting on this.

Started from the one `bench:gremlin` row item 517 left unaccounted (`V().has(age,gt).count()`,
28.3x native) and landed somewhere else. 200,000 vertices all labelled `Person`, TS: gremlin
`V().has().count()` 2.55 ms against `V().hasLabel().has().count()` **18.74** (7.3x); gql
`MATCH (n) WHERE n.age > 44` 4.51 against `MATCH (n:Person) WHERE n.age > 44` **12.58** (2.8x).
Same work both ways — every vertex carries the label.

Two explanations measured and REFUTED: the label bucket is not slower to iterate (2.13 ms against
2.31 for the id map, same age test), and the cost is not per-conjunct.

**It is a ROUTE CHANGE at the second conjunct**: 1 predicate 22.6 ns/row, 2 predicates 59.3
(+37), 3 predicates 63.3 (+4). A redundant label silently turns a one-conjunct query into a
two-conjunct one. The selective-label row confirms rather than infers: `(n:Third)` is also a
second conjunct and also on the slow route, but over a third of the rows — predicted 3.9,
measured 4.72. _A label is not expensive; a second conjunct is, and a label that excludes nothing
pays for one without buying anything._

Located, NOT diagnosed: `buildNodeCount` handles a label plus predicates, so the count rung is not
refusing; the suspect is the clause-`WHERE`-to-inline lifting (`pushWhereIntoNode`,
`inlineOf`/`gateWith`), which may lift one conjunct and decline a conjunction. Confirm before
changing anything.

Note the near-miss: the TS spelling probe's only flagged group is `label on start: redundant vs
absent`, but that is a HOP count where the spellings are genuinely different work (O(1) bucket
size against O(|label|) degree summing) and is recorded as unclosable. **This is a different shape
with the same name** — a node-scan count where the work IS the same — and no group covers it.
Native pays nothing for the tautology: `IsLabeled` short-circuits when a label's bucket length
equals the live node count (item E78).

## 536 — CORRECTION: item 535's GQL claims were contamination; only the Gremlin half survives

Item 535 said its own next job was to confirm the mechanism before changing anything. Confirming
refuted most of it.

Instrumenting `detectCountShortcut` and `buildNodeCount`: all four spellings FIRE the rung and all
four reach the builder with **`preds=1, seeded=false`** — same builder, same tally loop, same
predicate count. No route change, and a label adds no conjunct. A measurement that the code cannot
explain is a measurement to re-take.

One case per process:

- `MATCH (n) WHERE n.age > 44` **4.41** against `MATCH (n:Person) WHERE n.age > 44` **4.40** — a
  redundant label costs NOTHING in GQL. Item 535's 2.8x was the labelled query running third in a
  shared process. `(n:Third)` is 1.25, exactly a third of the rows at the same per-row cost.
- the conjunct ladder is 21.9 / 40.1 / 48.5 / 57.0 ns/row — marginal ~8.4 ns with a ~10 ns one-off
  for the `and` wrapper. **Not** the "+37 then +4 route change at the second conjunct" 535
  described; 1.83x for the second conjunct, uniform after.

STILL OPEN and now the real target: **Gremlin charges 4.4x for a step that filters nothing.**
`V().has(age,gt).count()` 3.37 ms against `V().hasLabel('Person').has(age,gt).count()` **14.77**,
isolated, every vertex carrying `Person` (`V().hasLabel().count()` alone is 0.00 — a bucket size).
+57 ns a row for one extra per-element step, against ~8.4 ns for a marginal GQL conjunct. GQL-only
redundancy is free; the Gremlin pipeline's is not.

**The lesson is about the measurement, not the engine.** I used an ad-hoc in-process `bun -e` loop
after this session had recorded the same trap three times (514, 524, 534). _A min-of-nine inside
one process is not isolation_ — one case per process is the only form that works here, which is
why the route-cost probe is built that way. Fourth instrument, and this time it was mine.

## 537 — a Gremlin filter CHAIN now tallies: CLOSED at 4.0x (and 1.9x for two `has` steps)

Item 536's one surviving finding, diagnosed: it is not about labels. `countShortcut`'s
`vertexStepCount` answers `V()` plus ONE step; two steps reach the `mid.length === 2` arm (the HOP
counts, which decline a filter pair) and the query ran the traverser pipeline at **~40-50 ns a
vertex PER STEP** — item 234's "a traverser allocated per vertex to be filtered and discarded".
A redundant `hasLabel` is expensive only because it is a second step.

Isolated ladder: `V().has().count()` 11.9 ns/vertex, two `has` 31.2, three 40.1,
`hasLabel()+has()` 96.4, `hasLabel()+hasLabel()+has()` 129.1.

`filterChainCount` tallies any chain of `hasLabel`/`has` in any order and length. A single-label
`hasLabel` becomes the SOURCE (its bucket, so O(bucket) not O(V)); a multi-label test stays a
predicate, since a vertex may sit in several buckets. Sound because every admitted step is TOTAL —
`matches` never throws, a label test cannot fault — so order is unobservable and no fault can
appear or disappear (`propertyCount`'s own argument). Inherits its index rule: decline when any
`has` could seed (item 149).

Before 19.33 / 19.38 / 12.97 → after 3.27 / 3.38 / 3.33 (4.0x); two `has` 6.83 / 7.20 / 6.49 →
3.43 / 3.62 / 3.52 (1.9x); the one-step control flat at 2.2-2.4. Three alternated rounds with a
rebuild between each, disjoint.

**`bench:gremlin` had no filter-chain row, which is why a 4-6x gap sat unseen.** Two added, and the
`hasLabel().has()` one is an equivalent-spelling guard too: every vertex on that fixture is a
`Person`, so it asks the same question as `V().has().count()`. They read 6.1 / 6.2 in that harness
against 3.3 / 3.5 isolated — it runs every row in one process.

Mutation 4 of 6 (null control clean). Both survivors are answer-preserving and recorded at the
guard. And the suite had a test asserting this shape DECLINES — _a widening must replace such a
test rather than delete it_: it now asserts the claim and the answer against the pipeline's own,
with a non-zero sibling, because `0` is correct for the first case and a tally that always
answered 0 would pass it.

## 538 — a single-label `hasLabel` SEEDS its bucket: CLOSED at 2.4-2.5x, on every terminal

Item 537's pattern grepped elsewhere: the per-step tax hits every terminal, and a tally cannot help
one that emits rows. Isolated, 200,000 vertices all carrying `Person`: `values('age')` 17.58 ms
against 29.69 with a redundant `hasLabel`; `groupCount` 6.45 against 13.94; `dedupe().count()`
14.15 against 28.01.

**The gap**: `hasLabel` was a `COMMUTING_FILTER` in `index-seed.ts` but never a SOURCE — only
`seedForStep` (the PROPERTY index) produced a candidate, so `V().hasLabel(L)` swept `verticesById`
and filtered per element. GQL has had the bucket as a source all along (`candidateVertexSource`,
three lines), which is why item 536 measured GQL charging nothing for the same redundancy.

`labelSeed` makes a single-label `hasLabel` a candidate (count = bucket size, build = the bucket,
removable = true) competing with the property seeds on selectivity, so a one-match `name` seek still
beats a 200,000-element bucket — item 149's failure avoided. Multi-label declines (the union is
neither a bucket nor a sum). An unknown label seeds EMPTY rather than declining.

ORDER checked BEFORE building: seeding emits the bucket's order, which is not a contract —
TinkerPop leaves `g.V()` unspecified, this repo treats unordered order as WON'T-FIX, and the
cross-engine Gremlin fuzzer compares these as MULTISETS (`deepSort`, skipped only under an explicit
`order()`). The property seeds already reorder the source the same way.

`values` 30.25 / 30.04 / 30.80 → 12.74 / 12.96 / 12.91; `dedupe().count()` 27.00 / 28.29 / 27.75 →
11.21 / 10.62 / 12.24. Three alternated rounds, disjoint. The no-label control is overlapping and
NON-MONOTONIC both ways (9.97-17.63 either side) — item 533's bimodality, so it says nothing
rather than saying it improved. Both targets now beat their unlabelled twins, since the seed
replaces the id-map sweep too.

Mutation **6 of 6 behavioural mutants caught** (null control clean), but three only after the tests
were strengthened: keeping the consumed step, declining a missing label, and never seeding are all
answer-PRESERVING. _A perf-only change needs tests that assert the DECISION_ — step dropped, empty
bucket still seeded, multi-label refused, selective property seek still wins, edge source has no
bucket.

`bench:gremlin` had no row for any of this; three added (537's two plus
`V().hasLabel().has().values(age)`, the row-returning twin this fix reaches).

## 539 — the START-filtered hop count: CLOSED at 6.2x (and 5.0x for a property filter)

The worst spelling cliff this surface had. 100,000 vertices / 500,000 edges, isolated:
`V().out('KNOWS').count()` **0.00 ms** (the edge bucket's size) against
`V().hasLabel('Person').out('KNOWS').count()` **95.34** — every vertex carries `Person`, so the two
ask the same question. `vertexStepCount` answers the bare hop and `filteredHopCount` a filter AFTER
it; a filter BEFORE one had no arm. GQL has had this since item 206.

`startFilteredHopCount` answers Σ the hop-degree of the surviving starts (`adjacentCount`'s
argument restricted to a subset of starts; a COUNT is order-free). `both` refused (a self-loop is
incident twice), multi-type `out(a,b)` guarded as `adjacentCount` guards it, and RAISE PARITY
shapes the source: filters applied in written order with a short circuit, and the label bucket is
the source only when its `hasLabel` is FIRST, where the bucket is exactly that step's survivors.

Before 95.34 / 97.43 / 97.80 → after 15.81 / 14.61 / 15.80 (6.2x); the property-filter form 49.97
/ 48.61 / 49.48 → 10.03 / 10.02 / 9.76 (5.0x). Three alternated rounds, disjoint; the O(1) control
stays 0.00.

**Read the adjacency BOX, not a hash of the id**: the first version used
`graph.edgesFromByLabel.get(v.id)` and measured 22.13 / 16.25 / 12.51 against the box's 16.25 /
1.99 / 10.68 on the three shapes (a string-keyed `Map.get` is ~190 ns, item 194; the GQL twin has
read the box since items 162/321). _The number in that comment was wrong when first written_ — I
put a figure in before measuring and corrected it.

Mutation 5 of 6 (null control clean), two caught only after extending the tests — a decision-only
guard and a wrong-answer case the fixture did not reach. The survivor is answer-preserving
(re-testing the seeded label). The two mutants whose anchors a later narrowing refactor touched
were **re-run against the final text**: _a mutation result recorded against code that no longer
exists is not a result._

Two bench rows added, the first an equivalent-spelling guard against `V().out().count()` directly
above it.

## 540 — a VACUOUS `hasLabel` is dropped from the plan: CLOSED at up to 48x

**The rule items 537-539 were each a special case of.** Every shortcut in `run` matches a plan
PREFIX that starts at the source (`countShortcut` wants `V()` plus one or two steps,
`hopValuesShortcut` exactly `V().out(T).values(k)`, `groupCountShortcut` `V().groupCount()`), so a
leading `hasLabel` is one step too many for ALL of them and drops the whole query onto the
traverser pipeline. The 4x / 2x / 30x those items measured were never about labels — they were
about which shortcut each shape lost.

`V().out().values('age')` 65.24 ms against 134.40 with a vacuous label; `V().out().dedupe().count()`
3.39 against **102.63**. Item 538's seed does remove the step (verified: `seedFromIndex` returns
`steps=["out","values"]`) but runs BELOW the shortcuts, which is what located this.

`dropVacuousLabels` drops a single-label `hasLabel(L)` whose bucket holds every live element — the
plan-level form of native's `IsLabeled` tautology short-circuit (item E78). Before 207.31 / 203.63
/ 218.04 → after 120.36 / 127.56 / 122.33 (1.7x) and 156.80 / 167.91 / 156.82 → 3.28 / 3.29 / 3.27
(**48x**), three alternated rounds, disjoint, no-label control overlapping.

It reaches the earlier rows too: on `bench:gremlin`, `V().hasLabel().has().count()` 5.8 → 2.4,
`V().has().has().count()` 6.2 → 3.5, `V().hasLabel().has().values(age)` 17.4 → 12.1, and
`V().hasLabel().out().count()` **37.4 → 0.0**, identical to the unlabelled row above it.

Mutation: six behavioural mutants, **one caught and five survived**, and the analysis is recorded
at the guard rather than papered over. Only `bucket.size === total` is load-bearing (15 failures
without it). The single-label restriction, the leading-run restriction, the `tracksPath` gate, the
edge-bucket branch and the empty-graph skip are all conservatism — each sound to relax for a stated
reason. _I did not add tests to catch them: they change no answer, and a test written to fail a
harmless mutant asserts an implementation choice as if it were a contract._ The load-bearing
mutant was re-run against the final text after a lint fix moved its anchor.

## 541 — items 537-540 sweep clean: VERIFIED on four harnesses

Four Gremlin items, three in `count-shortcut.ts` and one in `run`'s plan handling.

`bench:gremlin` controls flat (`V().count()` 0.0, `V().out().count()` 0.0, `V().out().values(age)`
282.0 against 279.9, `V().out().has().count()` 50.4 against 52.0, `dedupe().count()` 6.9 against
7.3). `V().hasLabel().out().count()` reads **0.0 — identical to the unlabelled row above it**,
where four items ago the pair was 0.00 against 95.34.

`groupCount` reads 3.1 against item 517's 1.0, and that is NOT this work: it has read 2.8-3.4 on
every sweep since, against native's 2.85-2.93 each time. The 1.0 was one low reading on a row this
harness runs in-process with thirteen others.

`bun run bench` in band (`count 3-hop` 331.5, `subquery item` 26.5). `bench:usage` best-recorded on
two rows (point lookup ts(+) 1.15M, 100 updates 1.07M) and `keyed dedup` back at 79.6k.
`query_bench` flat (`optional hop` 568.8, `+ miss` 63.8, `+ landing pred` 10072.0). `for-in const
project` 9368.9 against a recorded 8585-8944 range — 5% over, on a GQL path no Gremlin change can
reach, so noted not chased.

All seven byte-identity fuzzers 13/13 — the gate that matters most here, since 538 reorders a
traversal's SOURCE and 540 removes a step from its plan.

## 542 — the EDGE source seeds its type bucket: CLOSED at 3.7x on a count, REFUTED on `values`

Item 538's missing half; its own test asserted the limitation. A type's bucket is exactly the edges
carrying it, so a single-label `hasLabel(T)` is removable — the multi-type hazard belongs to
SUMMING buckets (`adjacentCount`), not to reading one.

`E().hasLabel('KNOWS').has(w, gt(3)).count()` before 64.61 / 67.53 / 62.50 → after 17.21 / 16.88 /
17.50 (**3.7x**). `E().hasLabel('KNOWS').values('w')` before 52.09 / 52.82 / 61.73 → after 54.83 /
51.73 / 52.48 — **overlapping both ways, no change**, where a single earlier reading (64.58 →
51.76) had suggested 1.25x. The control (`E().has().count()`) is flat. _Halving the source does not
help that shape and I have no explanation; recorded as measured rather than narrated._

**THE TEST IT REPLACED WAS TESTING NOTHING**: it asked for `hasLabel('knows')` while this fixture's
edge types are `KNOWS`/`CREATED`, so it asserted "no seed" against a label no edge carries — which
could not have seeded whatever the code did. Replacing it rather than deleting it (item 537's rule)
is what surfaced that, because the replacement failed on an empty stream until the case was fixed.
Labels are case-sensitive, as TinkerPop's are.

Mutation 2 of 2 (null control clean): the vertex bucket used for an edge source seeds EMPTY (a
vertex-label map misses on an edge-type name) and the seed reverted.

## 543 — the seeded `values` null result: hoisting REFUTED, one seventh of the gap explained

Item 542 recorded that the edge label seed gave 3.7x on a count and nothing on `values`, and left
it unexplained. Follow-up.

The seed IS firing (`seedFromIndex` returns `steps=["values"]`). The penalty scales with bucket
SPARSITY: `E().values('w')` 101 ns/row; the same with a VACUOUS label (item 540 drops it) 95; seeded
at a 99% bucket **123**; seeded at a 50% bucket **206**. So halving the elements doubles the cost of
each and the total is a wash (51.57 ms for 250,000 rows against 51.88 for 500,000).

**REFUTED**: `seedRest` built its stream as an inline IIFE generator where `sourceFromIds` is a
module-scope one, which is item 268's recorded hazard. Hoisting changed nothing — 206 → 217 ns/row —
so it was REVERTED rather than shipped, because its only justification would have been a number it
did not produce and the comment I had written quoted that number as if it had.

Partially explained: raw iteration of the same elements gives 17 ns for the dense ARRAY (500,000),
**31 for the Set** (250,000) and 20 for the same subset AS AN ARRAY. So `Set` iteration costs ~11 ns
an element over an array and the scattered order ~3 more — **~14 of the ~105 ns/row gap, a seventh.
The remaining ~90 ns is unlocated** and is recorded as such.

RULE WORTH HAVING BEFORE THE NEXT SEED: _a bucket seed trades element COUNT for LOCALITY, and the
benefit is not the ratio of the counts._ It wins when the steps after the source cost more per
element than the access penalty — 542's count form (a `has` plus a tally) wins 3.7x, the `values`
form breaks even.

## 544 — DISTINCT and ORDER BY over a ONE-ROW count: CLOSED (29.78 and 34.53 ms to 0.00)

Item 540's rule has a GQL twin: the ladder matches clause lists and projections, so one extra
PROJECTION CLAUSE drops the whole query. Priced at 200,000 vertices, one case per process:
`RETURN count(*)` 0.00; `LIMIT 1` 0.00 and `SKIP 0` 0.00 (already handled); `LET z = 1` 0.00
(inlined); `WHERE true` 1.79; **`RETURN DISTINCT count(*)` 29.78**; **`ORDER BY c` 34.53**;
`FILTER true` 32.91.

**The argument was already in the file.** `detectCountShortcut` explains why SKIP/LIMIT are not
refused — an un-grouped `count(*)` with one item is exactly ONE row — and refused DISTINCT and
ORDER BY two lines above that comment. One row cannot be deduplicated away from itself or
reordered. Both now 0.00. Neither spelling is contrived (ordering by the count you asked for;
DISTINCT out of habit); `FILTER true` is, and is left alone.

ONE real condition: ORDER BY is admitted only for a sort key that is a plain reference to the
OUTPUT column, because any other expression could FAULT during the sort and a shortcut that skipped
the sort would skip the fault. `ORDER BY 1 / 0` still raises, pinned against the same query without
the ORDER BY as the control.

Checked against native: all four admitted shapes agree, including `ORDER BY c LIMIT 0` → `[]`.
**An unrelated divergence found in passing and verified against the PRISTINE build before being
called pre-existing**: `RETURN count(*) AS c ORDER BY c + 0` answers `[{"c":2}]` in TS and RAISES in
native — the shortcut declines that key either way. Open.

Mutation 2 of 3 (null control clean). The survivor drops the NAME comparison and is equivalent by
construction: an aggregating projection's ORDER BY resolves against the output columns and there is
exactly one here.

## 545 — the one-row identity on FOUR aggregate rungs: CLOSED at up to 4.8x

Item 544's argument, applied to `detectNodeAggregate`, `detectMultiNodeAggregate`,
`detectHopAggregate` and `detectMultiHopAggregate` through one shared `sortsOnOutputOnly`. An
un-grouped aggregate projection is exactly ONE row whatever the aggregate is.

Node rung: `max(n.age)` 12.28 ms, `DISTINCT max(n.age)` **38.02**, `ORDER BY m` **37.06** → 12.14 /
12.32 / 12.58. Hop rung: 90.71, **385.64**, **428.73** → 90.75 / 91.53 / 89.98. Up to 4.8x. Ten
shapes checked against native, all agreeing, including both multi-item forms, a faulting sort key
(both raise) and a GROUPED projection (three rows, right order — so the grouped rungs still
decline).

**THREE IDENTICAL GUARDS, two of which must NOT be patched.** The multi-item node guard's text
appears three times in `shortcuts.ts`; the other two are `detectGroupedNodeAggregate` and
`detectGroupedHopAggregate`, which produce MANY rows where neither clause is an identity. A
by-text edit would have collapsed a grouped result. The uniqueness assert caught it (count 3, not

1. and each replacement is now anchored on the COMMENT above its guard. Items 474, 483, 494, 518,
   528, 545 — and _this is the first time the duplicate was a guard that had to KEEP its old
   behaviour_ rather than one wanting the same change. The test file pins the grouped shapes at three
   rows so a future bulk edit reaching them fails.

Mutation 1 of 3 (null control clean). Both survivors are answer-preserving: dropping the NAME check
is equivalent by construction, and emptying the name set only makes the rungs decline. Only
`kind === 'var'` is load-bearing — the same conclusion item 544 reached about its own copy.

## 546 — the last one-row rungs: CLOSED (98.72 → 0.00); and native never had this cliff

**Native checked first and found nothing**: `max(n.age)` 0.43 ms against `DISTINCT max(n.age)` 0.44
and `ORDER BY m` 0.43; `count(*)` 0.00 against both 0.00. No native twin of items 544-546 to build,
established in four minutes rather than by porting a fix to an engine that did not need it.

`countStarColumn` is the shared admission for the `FOR`-count and OPTIONAL-hop-count rungs and
refused both clauses too. At 200,000 vertices, plain against DISTINCT: constant `FOR` **0.00 →
98.72**; per-row `FOR` 3.08 → **73.61** (24x); OPTIONAL-hop count 29.77 → **397.91** (13x). After:
0.00 / 3.05 / 29.25 against baselines 0.00 / 3.07 / 28.32. The constant-`FOR` row is the sharpest
instance yet — an answer that is pure arithmetic (items 515, 519) cost 98.72 ms because of a clause
that cannot change it. Eight shapes agree with native, including the faulting key (both raise).

Mutation 2 of 4 (null control clean). **The survivor is items 544's and 545's survivor for the
third time** — dropping the COLUMN comparison is equivalent by construction. Three independent
copies, three identical survivors: _the `kind === 'var'` half is the contract and the name half is
documentation._

One mutant MISAPPLIED, caught by the uniqueness assert: the comparison line is character-identical
to item 544's copy in `detectCountShortcut`. Items 474, 483, 494, 518, 528, 545, 546 — and here the
duplicate was a line _I had written two ticks earlier_.

## 547 — items 542-546 sweep clean: VERIFIED on five harnesses

Five items since item 541: two Gremlin, three GQL rungs relaxing guards on seven detectors.

Two rows read up and NEITHER survived isolation: `query: subquery item` 43.2 in-sweep against
**29.3 / 28.8 / 28.4** isolated (its band is 26-32), and the spelling probe's `one end labelled`
group at 2.1x against **1.04x** isolated over two runs — item 524's known group, re-isolated rather
than assumed. _Fifth instrument this session whose full run needs a repeat before a number means
anything._

Everything else flat or better: `count 3-hop` 321.6 (311-342 band), `traverse 1-hop + filter` 40.0
(best recorded), `optional hop` 574.6 / `+ miss` 63.7 / `+ landing pred` 9989.7, `bench:usage`
point lookup ts(+) 1.15M and 100-updates 1.11M (best recorded), `V().hasLabel().out().count()`
still 0.0 and identical to the unlabelled row.

Both spelling probes clean — the TS one matters most here, since items 544-546 made
`RETURN count(*)`, `RETURN DISTINCT count(*)` and `ORDER BY c` ONE route where they were two. Zero
answer disagreements.

## 548 — a trailing `FILTER` folds into the MATCH before it: 3.5-8.6x, and a divergence closed

`FILTER <pred>` is ISO's own clause-level predicate statement (§14.6) and asks exactly what a
clause `WHERE` on the preceding MATCH asks. Only the `WHERE` spelling reached the ladder, because
every detector matches a clause LIST and a `FILTER` is one clause too many — item 540's structural
rule, on the GQL side. 200,000 vertices / 200,000 edges, one case per process:

| query                                                             | before   | after            |
| ----------------------------------------------------------------- | -------- | ---------------- |
| `MATCH (n:Person) FILTER n.age > 44 RETURN count(*)`              | 41.72 ms | **11.33** (3.7x) |
| `MATCH (:Person)-[:KNOWS]->(b) FILTER b.age > 44 RETURN count(*)` | 278.94   | **32.29** (8.6x) |
| `MATCH (n:Person) FILTER n.age > 44 RETURN max(n.age)`            | 43.26    | **12.23** (3.5x) |

against `WHERE` controls that did not move (10.73/11.12, 33.63/32.63, 12.20/12.42) and a
no-predicate control at 0.00 both ways. `inlineTrailingFilter` in `executor.ts`, composed in
`compileLinear` beside the three existing clause rewrites.

**NATIVE NEVER HAD THE CLIFF**, checked before looking for a Rust twin: 0.18/0.20, 0.91/0.88,
0.51/0.51 ms, and `spelling_probe` now reports _identical optimized plan_ for both spellings —
a stronger statement than the timings. No Rust-side work to do.

**NOT ACROSS AN `OPTIONAL MATCH`**, the one refusal that is semantics rather than reach: a clause
`WHERE` there is evaluated INSIDE the optional, so a start with no match still yields its
null-filled row, while a `FILTER` after it drops it. The pair reads 1 and 2 and the test pins both.
(Native rejects `WHERE` inside an `OPTIONAL MATCH` outright, so the two spellings are not even
both available there.)

**A DIVERGENCE CLOSED, not caused.** `WHERE 1 / 0 > 0 FILTER n.n > 9` THREW in TS and answered
`[{c:0}]` in native, because a partitioned clause `WHERE` short-circuits on the FALSE conjunct and
the faulting one is never reached — which is already what BOTH engines do for the `AND` spelling.
Folding makes the `FILTER` spelling the `AND` spelling, so TS now answers native's answer. Verified
against the pristine build before saying so.

Teeth: five mutants under the cap, two caught, control clean. Caught: folding across an `OPTIONAL`,
and folding onto any previous clause. Two survivors, both explained and recorded — the conjoin
ORDER (predicate position, where order is unobservable, item 259) and the `hasAggregate` guard,
which is defensive: with it dropped, `FILTER count(*) > 1` and `FILTER sum(n.n) > 1` answer
identically, so no test distinguishes it; kept by analogy with `inlineTrailingLet`'s same guard.

Three groups added to the TS spelling probe (4.50/4.48, 281.75/285.92, 11.11/8.40 ms) and two to
`spelling_probe.rs`.

## 549 — a vacuous `ORDER BY` / `OFFSET 0` STATEMENT in front of the projection: 126.60 → 0.00 (TS half)

ISO puts `<order by and page statement>` in the `primitiveQueryStatement` position (§14.10), so it
can stand as a pipeline step in FRONT of the projection rather than as paging carried on the
RETURN — and there it put one extra clause ahead of every detector. Item 540's structural rule
again; item 548 was its `FILTER` instance.

| query                                               | TS before | TS after  | native  |
| --------------------------------------------------- | --------- | --------- | ------- |
| `MATCH (n:Person) RETURN count(*)` (control)        | 0.00 ms   | 0.00      | 0.01 ms |
| `MATCH (n:Person) OFFSET 0 RETURN count(*)`         | 83.00     | **0.00**  | 0.57    |
| `MATCH (n:Person) ORDER BY n.age RETURN count(*)`   | 126.60    | **0.00**  | 10.07   |
| `MATCH (n:Person) ORDER BY n.age RETURN max(n.age)` | 194.35    | **15.61** | 10.30   |

`dropVacuousPage` in `executor.ts`, composed in `compileLinear` ahead of the other four rewrites.
**BOTH engines have the cliff** (native 0.01 → 10.07), so the Rust twin is real work and not a
check that finds nothing — tracked as the next item.

Four refusals carry the correctness, each with its own test case and its own caught mutant: a
`LIMIT` or a non-zero `OFFSET` changes WHICH rows reach the projection (`OFFSET 1 RETURN count(*)`
reads 1 against 2); `collect` reads the row ORDER (`[1,2,3]` vs `[3,2,1]`), and `sum`/`avg`/`stddev`
are refused with it because byte-identity pins the summation order; a projection that is not ONE
order-free row makes the sort position observable; and `ORDER BY 1 / 0` RAISES in both engines, so
only a fault-free key (a variable, or one property read — `n.missing` and even `z.n` on a value
answer rather than raise in both engines) may be dropped.

Teeth: six mutants under the cap, **five caught, control clean** — limit allowed, any skip allowed,
the one-row check dropped, the fault check dropped, and `collect`/`sum` admitted as order-free. No
survivors. 38 cross-engine assertions, all agreeing.

Two groups added to the TS spelling probe; the three-member one now reads 0.00/0.00/0.00 and is
"too fast to compare", which is the result.

## 550 — the native twin of 549: a vacuous sort under a scalar aggregate, 10.10 ms → 0.01

Item 549 shipped the TS half and recorded that native had the cliff too. It does, and the fix is
two arms in `opt::apply_local`. 200,000 vertices / 200,000 edges, one case per process, pristine
build against the change:

| query                                                          | before   | after            |
| -------------------------------------------------------------- | -------- | ---------------- |
| `MATCH (n:Person) ORDER BY n.age RETURN count(*)`              | 10.10 ms | **0.01** (1010x) |
| `MATCH (:Person)-[:KNOWS]->(b) ORDER BY b.age RETURN count(*)` | 11.68    | **0.50** (23x)   |
| `MATCH (n:Person) ORDER BY n.age RETURN max(n.age)`            | 10.35    | **0.44** (23x)   |
| `MATCH (n:Person) OFFSET 0 RETURN count(*)`                    | 0.56     | **0.01** (56x)   |

Controls flat and still refused: `collect` 16.97 → 17.03, `ORDER BY … LIMIT 10` 2.11 → 2.08 still
answering 10, the plain count 0.01 both ways.

**A GREMLIN page is never elided**, and an existing test is why — but not for the reason it said.
`a_gremlin_order_by_key_filters_and_so_cannot_be_elided_under_a_count` failed on its STRUCTURAL
assert while its three numeric assertions passed: `order().by('k')` does drop elements lacking `k`,
but that drop is a separate `Filter(PropertyExists)` the lowering emits, which survives any rewrite
of the page. The real reason to decline is the RUNTIME element fault in `exec::order`
(`fault_on_element`), the backstop for a mixed frontier the parser could not classify — eliding
would swallow it. The guard is now `!fault_on_element`, the old test passes unchanged, and its
proxy assert is left as the regression guard it is.

Teeth: seven mutants under the cap, **six caught, control clean, no survivors** — and M2 (the
page-keeps-every-row check dropped) is caught by **`rewrite_fuzz` itself**, three of its tests, which
is the first direct evidence this session that the optimizer fuzzer has teeth for a rule in this
family. `LENKE_OPT_FUZZ_SEEDS=200000` clean.

## 551 — the four order-sensitive hop aggregates ride the START-driven walk: 2.1-2.6x

Item 532 priced seven of eleven hop aggregates off the rung and recorded that five must STAY off
under item 419's rule — the walk may be FAR-DRIVEN, so it can visit rows in a different order than
the general path, and widening the rung "would be WRONG, not slow". **That is right about the
rule and wrong about the conclusion**: the rule is about ONE of the walks.

The hazard is real and reproduces on nine rows, which is worth recording because the old comment
said a small fixture could not show it:

```text
MATCH (a)-[:K]->(b) RETURN b.age AS k    ts [0,0,1,2,2,3,4,5]   native [5,2,3,4,0,0,2,1]
```

No start label, so the far-driven walk fits. Row order without an `ORDER BY` is unspecified (item
198), so that is legal for a projection and fatal for a fold. But with a non-vacuous start label
the same query reads `[5,2,3,4,0,0,2,1]` in BOTH engines — the start-driven walk's order IS the
general path's. So an order-sensitive fold may ride that walk, and `detectHopProjection` now takes
`forceStartDriven` for exactly that.

ts, 200,000 vertices / 200,000 edges, alternated rounds:

| aggregate           | pristine           | after                          |
| ------------------- | ------------------ | ------------------------------ |
| `sum(b.age)`        | 307.28 / 290.36 ms | **124.24 / 132.63** (2.3-2.5x) |
| `avg(b.age)`        | 327.67             | **125.26** (2.6x)              |
| `collect(b.age)`    | 291.70 / 308.78    | **123.93 / 128.89** (2.3-2.5x) |
| `stddev_pop(b.age)` | 268.67             | **125.25** (2.1x)              |

Controls: `max(b.age)` 91.00/101.30 against 87.71/79.01, `percentile_cont` 136.10/109.48 against
108.97/107.75 (the 136.10 was the outlier), `count(*)` 0.01 both ways.

**The UNDIRECTED hop is refused**: two walks emit all out-rows then all in-rows where the general
path interleaves them per start vertex, which is a different order by construction.

Teeth: five mutants under the cap, **four caught, control clean**. The filtered walk's guard
SURVIVED its first run and the diagnosis is the finding — nothing in the first fixture reaches
`hopDrivesFar`. With the guard removed, `collect(a.age)` over 40 `:P` sources and 3 `:R` far
vertices answers the start values grouped by far vertex instead of in start order, a real
divergence from native. A second fixture gives that guard teeth and the mutant is caught.

`traverse 1-hop project + start filter` flagged 115.0-122.1 against a 110.9-114.0 pristine band on
two configurations, then **overlapped on a third alternated round** (111.8 pristine min against
112.3). Hoisting the flag out of the returned closure (the pattern item 119 established in this
file) put `traverse 1-hop project` back on the pristine min.

## 552 — the same admission on the MULTI-aggregate hop rung: 2.5-2.7x

Item 551's widening, applied to `detectMultiHopAggregate`, which required every item to have a
streaming fold and so declined any projection carrying one of the six order-sensitive names. ts,
200,000 vertices / 200,000 edges, one case per process:

| projection                 | before    | after                          |
| -------------------------- | --------- | ------------------------------ |
| `count(*), sum(b.age)`     | 313.32 ms | **126.92 / 130.72** (2.4-2.5x) |
| `sum(b.age), avg(b.age)`   | 360.59    | **137.34 / 138.14** (2.6x)     |
| `collect(b.age), count(*)` | 320.79    | **117.98 / 131.26** (2.4-2.7x) |

Foldable controls flat: `count(*), max(b.age)` 92.75 → 92.4-92.6, `max(b.age), min(b.age)` 101.32 →
99.5-102.6. _The first reading of that second control was 149.49 and did not reproduce over three
repeats_ — a one-off, recorded because it looked exactly like a 1.5x regression on a control.

A new `HopAcc` variant `values` collects the column and finishes through the same
`aggregateOverValues` the general path runs; the two PERCENTILES come along for free on this rung,
since they read no order and need no forcing. The undirected form is refused as in 551.

Teeth: six mutants, **five caught, control clean** — the force turned off, the undirected guard
disabled, the null skip removed, the percentile fraction zeroed, and the extrema flag forced true
(which re-arms the self-loop decline wrongly). One mutant MISAPPLIED and the uniqueness assert
caught it: the undirected guard's text is now character-identical in both rungs. Items 474, 483,
494, 518, 528, 545, 546 and now 552.

`detectMultiHopAggregate` crossed the complexity gate (40 against a limit of 35), so the per-item
admission is extracted to `hopAccFor` — the decision reads nothing from the loop but the column
index.

## 553 — the grouped-scan rung collects the non-foldable aggregates: 8.1-11.5x, and the guard its own comment asked for

`detectGroupedNodeAggregate`'s doc comment named this target and the condition for closing it: _"a
grouped sum over floats depends on the order values reach their group, and a FILTERED scan may seed
from an index … The unfiltered case would be safe by the item-466 argument, but a grouped path that
takes `sum` only when unfiltered is a guard with no test — item 468 recorded how that goes — so it
waits for a shape that can be demonstrated."_

**Here is that shape.** With a range index on `age`:

```text
WHERE n.age >= 5 RETURN n.tag AS k, collect(n.age)    no index  [7,5,9] / [8,6]
                                                      indexed   [5,7,9] / [6,8]
```

The seek visits in INDEX order, so values reach their group differently — and the same predicate
written `n.age + 0 >= 5`, which cannot seed, is unchanged either way, which isolates the cause to
the seed and not the filter. **Both engines give both answers**, so each is a real contract the rung
would have to reproduce and cannot. The UNFILTERED grouped collect is index-independent, which is
the whole argument for admitting it.

ts, 200,000 vertices, one case per process, pristine against the change:

| projection                                | before    | after            |
| ----------------------------------------- | --------- | ---------------- |
| `n.age AS k, sum(n.age)`                  | 105.77 ms | **9.22** (11.5x) |
| `n.age AS k, collect(n.age)`              | 100.84    | **9.73** (10.4x) |
| `n.age AS k, percentile_cont(n.age, 0.5)` | 111.27    | **13.69** (8.1x) |
| `n.age AS k, count(*)` (control)          | 6.42      | 4.04             |
| `n.age AS k, max(n.age)` (control)        | 9.84      | 9.28             |
| `WHERE n.age > 1 … sum(n.age)` (refused)  | 174.67    | 163.75           |

Teeth: six mutants, **four caught, control clean**. One survivor, explained and recorded at the
guard: widening `refsOnlyVar` to cover the collected accumulators cannot be distinguished while the
flag confines them to the SCAN rung, where the key and the aggregate necessarily read the one
variable. It stays because it becomes load-bearing the moment the hop rung is widened.

**NATIVE HAS NO CLIFF in the hop-aggregate enum**, checked for a twin and found none: at 200,000
vertices / 200,000 edges every one of nine aggregates over a one-hop pattern answers in 0.56-8.46
ms (`collect` the top of that range, which is the cost of building a 200,000-element list).

OPEN, priced: the grouped HOP rung, where `b.age AS k, sum(b.age)` costs **472.71 ms** against the
167.82 the grouped count takes. It needs items 551/552's walk FORCING rather than this flag, since
its walk has a far-driven alternative.

## 554 — the grouped-HOP rung too: 2.4-2.5x, a wrong claim corrected, and a DIVERGENCE found

Item 553's call site said this rung needed items 551/552's walk FORCING because "its walk has a
far-driven alternative". **That was wrong** — a guess from item 419's rule rather than a reading of
the loop, which iterates `candidateVertexSource(graph, startLabel)` and expands, with no far-driven
alternative anywhere. Its visit order is the start side's, which is the general path's, so the only
condition is item 553's SEED hazard and the fix is the same flag.

ts, 200,000 vertices / 200,000 edges, one case per process, pristine against the change:

| projection                                | before    | after             |
| ----------------------------------------- | --------- | ----------------- |
| `b.age AS k, sum(b.age)`                  | 461.01 ms | **191.52** (2.4x) |
| `b.age AS k, collect(b.age)`              | 467.25    | **192.49** (2.4x) |
| `b.age AS k, percentile_cont(b.age, 0.5)` | 471.90    | **192.39** (2.5x) |
| `b.age AS k, count(*)` (control)          | 161.12    | 162.10            |
| `b.age AS k, max(b.age)` (control)        | 182.73    | 177.38            |
| `WHERE b.age > 1 … sum(b.age)` (refused)  | 487.81    | 451.26            |

### An OPEN DIVERGENCE, found by probing and pre-existing

Ten `:P` nodes with one `:K` edge each and a range index on `age`:

```text
MATCH (a)-[:K]->(b) WHERE b.age >= 5 RETURN b.tag AS k, collect(b.age) AS m
  no index    ts [7,9,5] / [8,6]    native [7,9,5] / [8,6]    agree
  indexed     ts [5,7,9] / [6,8]    native [7,9,5] / [8,6]    DIVERGE
```

TS seeds the FAR end of a hop from the index and native does not, so the values reach their group
in different orders. **Verified against the pristine build before item 554**, so it is pre-existing;
the same filter on the START end agrees with and without the index, which locates it in the far-end
seed specifically. Not fixed here — the fix is a decision about which engine's seeding is right, not
a rung condition.

Teeth: five mutants, three caught, control clean. M1 (the seed guard dropped) survived its first run
because the only shape where the guard matters is the diverging one, so `agree()` cannot be the
oracle; it is now tested against **the general path in the same engine**, which is the invariant
that applies to a rung, and it is caught. M2 (the flag turned off) is a PERFORMANCE mutant — the
rung simply declines and the general path answers identically, so no test can catch it and none
should. M4 confirms item 553's survivor is now load-bearing, exactly as that entry predicted.

## 555 — two fuzzer coverage floors were chasing the distribution's tail (CI red, no divergence)

CI went red on item 553 and the failure was **not** a byte-identity divergence: the GQL differential
fuzzer's coverage assertion failed with `hopUntypedGenerated` expected `> 28` and received 21-28,
while its NonZero floor of 20 passed — the two counters within a few of each other, which is a thin
seed rather than a lost shape.

**Engine work cannot move either counter.** `tally()` runs on EVERY generated query and reads only
its TEXT, so nothing in items 549-553 could have touched it. Twelve seeds:

```text
hopFilter   102/78  122/98  124/103  125/104  127/104  127/106
            131/107 131/110 133/115  140/115  145/113  167/146
hopUntyped   34/27   37/33   37/33    38/31    39/38    40/35
             40/37   42/38   45/42    46/40    46/43    50/46
```

Minima 102/78 and 34/27 against old floors of 90/80 and 28/20 — `hopFilterNonZero`'s floor was
**above its own observed minimum**, and it duly failed on seed 2718281828 while the first fix was
being verified. Lowered to 60/45 and 20/12, ~40% under the observed minima.

Teeth: two mutants driving each counter to zero by breaking its regex, **both caught**. The floors
still do the job the file says they are for (catching a silent fall to ZERO, items 115, 125) at the
only threshold that matters.

_The lesson is about instruments, not about this fuzzer: a floor set just under a small sample's
minimum will go red on the weather, and a red CI with nothing behind it costs more than the dip it
would have caught._

## 556 — the GQL fuzzer's grouped arm never collected, so the grouped rung was invisible to it

Item 554's divergence is a WITHIN-GROUP order difference, and it had to be found by hand. This asks
why, and the answer is that the generator's grouped arm emitted only `count(*)` — a count cannot
see the order values reach a group, so the whole class was unreachable.

Half of that band now collects. Three choices in it, **each forced by a mutation run against the
engine**, and each one a condition the TS grouped-scan rung imposes:

- the collected property is SPARSE half the time. Collecting the dense `n` meant no null ever
  reached the accumulator, so a mutant that KEPT nulls in a grouped collect survived.
- the key is a direct PROPERTY, not `LET k … GROUP BY k`. The rung requires a property of the
  matched node, so every `LET`-keyed query DECLINED it — the rung was never reached at all.
- NO `ORDER BY`. The rung refuses a projection that sorts or pages (items 190, 199), so the sorted
  spelling declined it too.

With all three, the null-handling mutant is **caught on every seed tried**. _Three rounds of "the
mutant survived, so the arm does not reach what I think it reaches" — a generated shape that
declines the rung it was written for reads exactly like one that takes it._

A mutant that REVERSES the within-group order still survives, and the reason is the fixture: `s`,
`st` and `n` are distinct on all three vertices, so no group ever holds two rows and a reversed
one-element list is the same list. Recorded, not papered over — catching it needs a fixture with a
repeated key.

### RETRACTED in the same tick: an INDEXED fuzzer pass

The memory note after item 554 said the real gap was that the fuzzers never build an index, so no
SEEDED plan is ever compared. I built that pass — a second graph pair with range indexes on `n`/`x`
and a hash index on `s`, the same generator, the same `compareOne` — and then measured whether it
reached anything:

| fixture                                  | queries whose answer differs from the unindexed plan      |
| ---------------------------------------- | --------------------------------------------------------- |
| the 3-vertex `NDJSON`, NaN setup missing | 128/5000 — **all of them the missing NaN, not the index** |
| the 3-vertex `NDJSON`, NaN setup applied | **0**/5000                                                |
| a purpose-built 400-vertex fixture       | **0**/5000                                                |

The first row is the finding: a mutant that removed index creation entirely still scored 128, which
is what said the counter was measuring the wrong difference. With the fixtures actually identical
the index changes NO answer the generator produces — a seek only perturbs the shapes the generator
does not emit (a grouped collect over a FILTERED source). So the pass was 5,000 repetitions of the
pass above it, and it was reverted along with its 400-vertex fixture and the `compareOne`
extraction that existed only to feed it.

_Shipping it would have been a test that proves nothing while looking exactly like one that does —
the failure items 115 and 125 record._ The generator widening above is the half that survived
measurement.

## 557 — a one-hop VALUE-subquery aggregate: 2.0x, and FOUR new divergences found by pricing the enum

`VALUE { MATCH (n)-[:T]->(x) RETURN <agg>(x.k) }` had a rung only for `count(*)` (item 499 lowered
that spelling onto the degree path). Every other aggregate materialized the whole match set per
OUTER ROW — a `Binding` Map per neighbour plus the array holding them. 200,000 vertices / 200,000
edges, one case per process, alternated rounds:

| body                        | pristine        | after                        |
| --------------------------- | --------------- | ---------------------------- |
| `RETURN avg(x.age)`         | 154.73 ms       | **78.82** (2.0x)             |
| `RETURN sum(x.age)`         | 155.16 / 188.64 | **78.53 / 81.34** (2.0-2.3x) |
| `RETURN max(x.age)`         | 161.03 / 165.30 | **81.19 / 80.12** (2.0x)     |
| `RETURN min(x.age)`         | 170.50          | **86.30** (2.0x)             |
| `RETURN count(*)` (control) | 27.07 / 25.57   | 25.90 / 24.46                |

Native answers all of them in 4.7-5.8 ms, so the gap was TS-only.

### FOUR new divergences, found by pricing the enum rather than by a failing test

Native REFUSES four aggregate names inside a correlated subquery body while TS answers them:

```text
VALUE { MATCH (n)-[:T]->(x) RETURN collect(x.n) }        ts [[2,5],[],[5],[]]   native THROWS
VALUE { … RETURN collect_list(x.n) }                     ts same                native THROWS
VALUE { … RETURN stddev_pop(x.n) }                       ts answers             native THROWS
VALUE { … RETURN count(x.n) }                            ts [2,0,1,0]           native THROWS
```

`RETURN Count(…) is not supported in …` — a LOUD refusal, so none can be a wrong answer, but four
shapes where the engines disagree. **All four are excluded from the new rung on purpose**: making
the divergent answer arrive faster is not an improvement, and the test pins both sides so a fix to
either is visible.

Teeth: seven mutants, four caught, control clean. Two survivors explained: the self-loop guard is
redundant because the CALL SITE's bound-landing check catches it (which is what
`degreeCountSubquery` records about its own twin), and admitting the four divergent names is
answer-preserving — the exclusion is a POLICY, not a correctness guard.

_Two mutants needed a better fixture before they had teeth, and the first one is the lesson: with
the bound landing pinned to the `:Q` node, the pair answer (5) and the folded-over-all-neighbours
answer (also 5, because that node holds the maximum) COINCIDE. Pinning it to the smaller neighbour
separates them._

## 558 — an OPTIONAL hop under a null-blind aggregate is just a hop: 3.8-5.2x

An `OPTIONAL MATCH` contributes ONE null-filled row per start with no match. Every aggregate in
this engine drops nullish values before folding, so those rows change nothing — **except**
`count(*)`, which counts rows and therefore counts them. So for an un-grouped projection whose
aggregates all take an argument, `OPTIONAL MATCH … RETURN <agg>(x.k)` is the same question as
`MATCH … RETURN <agg>(x.k)`, and the second has had a rung since item 418.

200,000 vertices / 200,000 edges, one case per process:

| query                                                    | TS before       | TS after             | native  |
| -------------------------------------------------------- | --------------- | -------------------- | ------- |
| `OPTIONAL MATCH (n)-[:T]->(x) RETURN count(*)` (control) | 7.79 ms         | 7.81                 | 0.66 ms |
| `… RETURN count(x)`                                      | 410.12          | **78.84** (5.2x)     | 1.30    |
| `… RETURN max(x.age)`                                    | 457.60 / 475.90 | **91.36** (5.0-5.2x) | 1.52    |
| `… RETURN sum(x.age)`                                    | 494.60          | **131.65** (3.8x)    | —       |

The two measured against native were **315x and 313x** off it; `count(*)` keeps its own rung
(item 546) and does not move.

**The fixture is the test.** Two of the four starts have no out-edge, so the null-filled row exists
and is observable — on a fixture where every start matches, the two forms are indistinguishable and
the rewrite would look correct for the wrong reason. All thirteen probed shapes answer identically
to the PRISTINE build, and each admitted one is also asked without `OPTIONAL` and must match.

Three refusals, each measured rather than argued: `count(*)` reads 5 against the non-optional 3; a
grouped `RETURN n.k, max(x.v)` keeps four groups against two; a projection with no aggregate keeps
five rows against three.

Teeth: five mutants, two caught (a star count admitted, a non-aggregate item admitted), control
clean. Two survivors are redundant guards, kept and recorded: `!proj.star` is implied by
`items.length > 0`, and `groupBy`/`having` by `items.every(hasAggregate)`.

One mutant MISAPPLIED — the guard text is near-identical to item 549's `oneOrderFreeRow`, so the
pattern matched twice. **Tenth time this session** (474, 483, 494, 518, 528, 545, 546, 552, 553,
558).

## 559 — a FILTERED anchor on the optional-hop count: up to 27x, three spellings, and a SECOND value divergence

`detectOptionalHopCount`'s arithmetic is Σ max(1, degree) over the anchors, so a filter changes
WHICH anchors are summed and nothing else — yet it refused `m.where` outright, and `plainNode`
refused the inline spellings with it. 200,000 vertices / 200,000 edges, one case per process:

| query                                                         | before  | after             |
| ------------------------------------------------------------- | ------- | ----------------- |
| `MATCH (n:Person) OPTIONAL MATCH … RETURN count(*)` (control) | 7.65 ms | 10.03             |
| `… WHERE n.age > 60`                                          | 191.17  | **22.50** (8.5x)  |
| `MATCH (n:Person {tag: 'x'}) …`                               | 391.04  | **14.49** (27.0x) |
| `MATCH (n:Person WHERE n.age > 60) …`                         | 214.24  | **22.58** (9.5x)  |

**THREE SPELLINGS OF ONE FILTER**, and the inline property map was the worst — found by pricing the
clause form and then asking whether its siblings were admitted. They were not. All three now agree
with each other and with native, and they compose in written order (the inline gate
short-circuiting a faulting clause `WHERE` is a test, not a comment).

### A SECOND value divergence, found while building a mutant

```text
MATCH (n:P {t: null})       RETURN count(*)   ts 1   native 1   agree
MATCH (n:P) WHERE n.t = n.t RETURN count(*)   ts 1   native 1   agree
MATCH (n:P {t: n.t})        RETURN count(*)   ts 2   native 1   DIVERGE
MATCH (n:P {t: n.missing})  RETURN count(*)   ts 1   native 0   DIVERGE
```

The agreeing rows bracket it: both engines read a LITERAL inline null as IS NULL (item 260) and a
clause-`WHERE` null comparison as UNKNOWN. The divergence is an inline property whose value
EXPRESSION evaluates to null — TS takes the IS NULL route, native the `= null` route. Verified
against the pristine build. **In the dangerous class: different rows, not a refusal**, and the
second such divergence open.

Teeth: six mutants, four caught, control clean. One survivor explained — a clause `WHERE` reading
another variable cannot reach the rung because both engines reject the query first (`variable 'y' is
not defined`). Two mutants needed a second attempt, and the reason is the same both times: the
first discriminator produced the SAME number on both sides of the bug.

## 560 — the same filtered anchor on the FOR count: up to 17x, and the gate is now ONE helper

Item 559's refusal grepped to a sibling: `perRowForCount` (`MATCH (n:L) FOR t IN n.key RETURN
count(*)`) cited the SAME item 510 comment as its reason for refusing a filtered anchor. Its
arithmetic is Σ the list's length over the anchors, so the argument is identical.

200,000 vertices with three tags each, one case per process:

| query                                                        | before  | after            |
| ------------------------------------------------------------ | ------- | ---------------- |
| `MATCH (n:Person) FOR t IN n.tags RETURN count(*)` (control) | 3.70 ms | 4.04             |
| `… WHERE n.age > 60`                                         | 52.75   | **10.46** (5.0x) |
| `MATCH (n:Person {tag: 'x'}) …`                              | 125.56  | **7.36** (17.1x) |
| `MATCH (n:Person WHERE n.age > 60) …`                        | 52.93   | **12.32** (4.3x) |

The inline property map was again the worst of the three.

**The gate is now ONE helper**, `anchorFilterGate`, shared by both rungs. Item 559's copy was two
ticks old and would have been the eleventh duplicated body in this session — the thing that has
fooled a bulk edit ten times. One mutant on the helper (the composition order reversed) is now
caught by TWO tests, one per rung, which is the shared body paying for itself immediately.

A THIRD sibling was priced and left alone: `detectOptionalHopProjection` reads 144.60 ms unfiltered
against 178.58 filtered — 1.2x, because row materialization dominates a projection and there is no
arithmetic to replace the walk with. Not a cliff, so not a target.

Teeth: six mutants, four caught, control clean. The survivor is item 559's explained one, now
stated once on the shared helper: a clause `WHERE` naming another variable cannot reach either rung
because both engines reject the query first.

## 561 — items 548-560 sweep: VERIFIED, and it found a reproducible Gremlin-fuzzer FALSE RED

Thirteen items since item 547's sweep. Seven harnesses plus both spelling probes, the Rust suite and
a deep `rewrite_fuzz`. **Everything in band, nothing isolated needed** — the first sweep this
session with no row to re-measure:

```text
bun run bench      count 3-hop 327.3, traverse 1-hop + start filter 33.2 (best recorded),
                   count 2-hop + end filter 97.1 (best), subquery item 28.1, 2-hop subquery 111.4
bench:usage        point lookup ts(+) 1.29M (best recorded), 100-updates 968.0k, keyed dedup 77.3k
bench:gremlin      all 14 rows "same"; V().hasLabel().out().count() still 0.0
query_bench        optional hop 580.6, + miss 63.6, + landing pred 9825.8, 1-hop 506.1/539.8,
                   for-in const x3 15.5
spelling_probe     Rust: NO PERF CLIFFS. TS: 0 answer disagreements
rewrite_fuzz       LENKE_OPT_FUZZ_SEEDS=200000 clean
cargo test         1167 pass / 0 fail; clippy and cargo fmt exit 0
```

### The finding: `orderOverPaths` compared the FIRST `order(`, not the last

CI went red on item 560 with a Gremlin-fuzzer divergence that **replays** (seed 4026198038):

```text
g.V().label().order().by(desc).path().order().by(desc).fold()
```

Both engines return the same seven paths in different orders. The suite's own rule already says a
path-stream `order()` is unspecified — but `orderOverPaths` took `text.indexOf('order(')`, and with
TWO orders and a `path()` between them the FIRST one sits before the path, so the function answered
false and the suite compared two unspecified orders as a SEQUENCE. `lastIndexOf` is the fix.

**Verified PRE-EXISTING, not caused by items 548-560**: the seed fails identically with the
pre-548 GQL sources restored (`git show 8864f198:` for all four files). It is also NOT the known
1-in-30 residual, which replays clean.

Teeth, because a relaxed comparison is worth nothing if it stops catching things — four mutants on
the native side, over five seeds each:

| mutant                                                | result         |
| ----------------------------------------------------- | -------------- |
| drop a row on a path-order query                      | **caught** 2/5 |
| mangle a value on a path-order query                  | **caught** 1/3 |
| reverse each path's elements, path-order queries only | NOT caught     |
| reverse each path's elements, ANY query               | **caught** 5/5 |

The third and fourth together are the honest account: `deepSort` canonicalizes WITHIN a row as well
as between rows (deliberately — see its own comment), so the 4-9 path-order queries per run lose
their within-path element check. That contract is still covered on every path query WITHOUT an
`order()`, which is the large majority, and the fourth mutant proves it at 5/5.

## 562 — the CALL-with-aggregate-body route: a 24.9x target PRICED, a rewrite RETRACTED, a divergence found

### The target, and it is real

`CALL (n) { MATCH … RETURN <agg> AS c }` yields exactly ONE row per outer row (an un-grouped
aggregate is null or 0 over an empty match, never nothing), so the lateral join neither drops nor
multiplies rows and the call is a per-row SCALAR — precisely a `VALUE {}` subquery, which has rungs
(items 499, 557) where the CALL route has none. 200,000 vertices / 200,000 edges:

| spelling                                              | ms        |
| ----------------------------------------------------- | --------- |
| `CALL (n) { … RETURN count(*) AS c } RETURN sum(c)`   | 760.86    |
| `RETURN sum(COUNT { MATCH (n)-[:KNOWS]->(x) })`       | **30.56** |
| `CALL (n) { … RETURN count(*) AS c } RETURN count(*)` | 691.35    |

**24.9x between two spellings of one question.** The equivalence was verified on six shapes against
native first, including the rows an unmatched start contributes (`c: 0`, `m: null`) — both engines
agree on all six.

### RETRACTED: the rewrite answered 6 where the answer is 2

`inlineAggregateCall` (CALL → `LET c = VALUE {…}`) delivered **760.86 → 68.43 ms, 11.1x**, with the
pass-through control flat at 568.72. Then:

```text
CALL (n) { MATCH (n)-[:T]->(x) RETURN count(*) AS c } RETURN sum(c) AS t, count(*) AS r
  rewritten   {t: 6, r: 3}      WRONG — one node's degree of 2, counted three times
  native      {t: 2, r: 3}
  the HAND-WRITTEN LET spelling  {t: 2, r: 3}   right
```

A one-item outer projection is correct (`RETURN sum(c)` gives 200,000, `RETURN max(m)` gives 2 on
the unit fixture); a TWO-item outer projection is wrong. Reordering the rewrite outside
`inlineTrailingLet` did not fix it, so it is not the inlining — and the hand-written `LET` being
right means the generated clause differs from the parsed one in some way I did not locate.

**Reverted.** A 24.9x win with an unexplained wrong answer is the worst thing this loop could ship,
and the equivalence being sound is exactly what makes the bug worth finding rather than working
around. The repro above is one query.

_Had I only measured the one-item shape, this would have shipped._ Both earlier CALL probes in this
session used a single outer item.

### A FIFTH subquery-body divergence

```text
CALL (n) { MATCH (n)-[:T]->(x) RETURN count(*) AS c, max(x.n) AS m } RETURN n.n, c, m
  ts      [{k:1,c:2,m:2}, {k:2,c:0,m:null}, {k:null,c:0,m:null}]
  native  THROWS "an aggregating RETURN inside …"
```

Two aggregate items in a CALL body. Same family as item 557's four (collect, collect_list,
stddev_pop, count(arg)), same class — a loud refusal on the native side.

## 563 — item 562's CALL rewrite, fixed: a MANUFACTURED subquery node must be marked correlated

Item 562 retracted this rewrite for a wrong answer. The cause generalises beyond it:

**`markIfCorrelated` populates a WeakSet during SCOPE CHECKING, which runs over the PARSED AST.** A
subquery node a REWRITE manufactures is never in it, so `memoizeIfUncorrelated` computed the
per-row scalar ONCE and reused it. The node is correlated by construction — the rewrite fires only
when the call imports outer names — so the fix is one `correlatedSubqueries.add`. **Any future
rewrite that manufactures an `exists`/`countSubquery`/`valueSubquery` node has the same
obligation.**

### The measurement was wrong too, and for the same reason the bug hid

Item 562's figures used ONE edge per node, where Σ(degree) and (first degree × row count) are the
SAME NUMBER — so the memoized answer looked right AND the memoization looked like an 11.1x win. On
200,000 vertices with degree `i % 4` (300,000 edges), alternated rounds:

| query                                                 | pristine           | after               | ratio    |
| ----------------------------------------------------- | ------------------ | ------------------- | -------- |
| `CALL (n) { … RETURN count(*) AS c } RETURN sum(c)`   | 779.58 / 769.30 ms | **491.96 / 510.91** | 1.5x     |
| `CALL (n) { … RETURN max(x.age) AS m } RETURN max(m)` | 779.69 / 801.46    | **268.32 / 387.63** | 2.1-2.9x |
| `RETURN sum(COUNT { … })` (control)                   | 52.45              | 53.75 / 52.06       | —        |

**So the real win is 1.5-2.9x, not 11.1x** — the rest of item 562's headline was the bug. The
control spelling is still ~9x faster, so this closes part of the 24.9x gap and the remainder is
open.

Teeth: six mutants, three caught (the marking dropped — 9 fails, two aggregate items admitted, a
pass-through body admitted), control clean. Two survivors are redundant and recorded: an `OPTIONAL
CALL` over an aggregate body is a no-op (the body always yields its row) and an alias colliding
with a body pattern variable changes nothing (the call hides body variables either way). One
mutant MISAPPLIED — the guard's first line is character-identical to `inlineCorrelatedCall`'s —
the **eleventh** time this session.

## 564 — the rewrite must mirror the PARSER'S normalization too: a further 3.2x on the CALL count

Item 563 landed the CALL→`LET` rewrite at 1.5-2.9x and left a gap to the hand-written spelling.
The gap had one cause, and it is the same lesson as 563 from the other side:

**`parseValueSubquery` turns `VALUE { … RETURN count(*) }` into a `countSubquery` node** — item
499's lowering onto the degree path. A rewrite that manufactures the `valueSubquery` form instead
misses it:

| spelling                                                                 | ms                    |
| ------------------------------------------------------------------------ | --------------------- |
| `CALL (n) { … RETURN count(*) AS c } RETURN sum(c)` as a `valueSubquery` | 504.16 / 498.10       |
| the same, normalized to `countSubquery`                                  | **159.49 / 156.85**   |
| the hand-written `LET c = VALUE { … RETURN count(*) }`                   | 149.91                |
| `RETURN sum(COUNT { … })` (control)                                      | 41.22 / 52.13 / 52.98 |

**3.2x**, and it lands exactly on the hand-written spelling, which is the check that the mirroring
is faithful. The conditions are copied from the parser rather than approximated.

Teeth: four mutants, two caught. `star` needed a fixture with a REACHED property-less neighbour —
without one, `count(x.n)` and the degree are the same number and the mutant survived, which is the
fourth coinciding-fixture trap in this run of ticks. `distinct` is unreachable beside `star`
(`count(DISTINCT *)` is a parse error) and the parser's own comment records the same redundancy for
its copy.

### A SIXTH divergence, and the third in the DANGEROUS class

```text
CALL (n) { MATCH (n)-[:T]->(x) RETURN count(x.n) AS c } RETURN n.n, c
  ts      [{k:1,c:1}, …]   the NON-NULL values
  native  [{k:1,c:2}, …]   the ROWS

MATCH (n:P)-[:T]->(x) RETURN count(x.n)       ts 1   native 1   AGREE
```

The second line is what makes it precise: without the CALL the engines agree, so the divergence
belongs to the CALL-BODY position, not to `count`. Pre-existing (identical on the pre-563 build),
found while giving the `star` condition teeth.

### Also tried and REVERTED in the same tick

Inlining a once-read subquery `LET` into the projection, to close the remaining ~3x to
`sum(COUNT{…})`. It is inert: `inlineTrailingLet`'s `subst` is all-or-nothing — it substitutes only
when an item IS the bound name and refuses any expression MENTIONING it — so `RETURN sum(c)` never
inlines. The apparent 151.90 → 112.21 did not survive an alternated round (110.21 pristine against
161.67 after). Reverted; the blocker is now recorded, and closing it needs a structural
substitution rather than a wider admission.

## 565 — `inlineTrailingLet` substitutes into a FUNCTION ARGUMENT: the CALL route reaches parity

`inlineTrailingLet`'s substitution was ALL-OR-NOTHING — it replaced an item that WAS the bound
name and refused any expression that merely mentioned it. So `LET c = COUNT { … } RETURN sum(c)`,
a name read inside an aggregate and the common shape, never inlined and kept its per-row clause.

Two changes close it: `boundExprs` admits a subquery binding, and `subst` replaces a bound name
appearing as a FUNCTION ARGUMENT. Item 564 tried the first alone and found it INERT — this is why.

200,000 vertices / 300,000 edges, one case per process:

| spelling                                            | before                      | after     |
| --------------------------------------------------- | --------------------------- | --------- |
| `LET c = COUNT { … } RETURN sum(c)`                 | 114.06 / 170.48 / 173.33 ms | **53.46** |
| `CALL (n) { … RETURN count(*) AS c } RETURN sum(c)` | 156.85 / 159.49             | **52.93** |
| `RETURN sum(COUNT { … })` (the target)              | 50.14 / 52.78 / 52.18       | 52.87     |

All three land on ~53 — one question, one cost. **With items 563 and 564 the CALL route is
779 → 53 end to end, 14.7x.**

TWO conditions, both with caught mutants:

- **exactly ONE read** across items and ORDER BY keys. Read twice, the subquery is evaluated twice;
  read ZERO times, the binder's evaluation disappears along with any fault it raises — and a
  faulting zero-read binder DOES throw in both engines today, which is what catches the `> 1`
  mutant.
- **ONE LEVEL**: arguments are replaced where they are BARE NAMES and the result re-checked for a
  surviving mention, so `sum(c + 1)` refuses. Deliberately not an exhaustive walk over a 40-arm
  `Expr` union, where a missed arm would drop the binder with the name still unbound.

Teeth: six mutants, five caught (two only after the faulting zero-read test was added), control
clean. The survivor — not counting ORDER BY reads — can only cause a DOUBLE EVALUATION with the
same answer, so it is cost-only and recorded as such.

## 566 — two enums priced, NO cliff in either: the predicate forms and the scalar functions

Recorded so the next pass does not re-price them. Both are FLAT bands in TS — the gaps to native
are a uniform constant factor, not a missing rung.

### Predicate forms on a scan count (200,000 vertices, one case per process)

```text
n.age = 44            10.49 ms      n.age IS NOT NULL      10.24
n.age >= 44           11.94         n.age IS NULL          11.45
n.age > 44            12.26         n.age <> 44            13.42
n.age IN [1, 2, 3]    15.69         NOT n.age > 44         15.96
n.age > 44 OR …       18.46         n.age > 44 XOR …       18.71
n.tag STARTS WITH 'x' 32.21         n.tag CONTAINS 'x'     32.51
```

A 3.1x spread from the cheapest to the dearest, and the two string predicates are the dear end —
which is predicate dispatch over a string, not a route. Nothing falls off a rung.

### Aggregate arguments on a scan (same fixture)

```text
count(n.age)   14.96 ms     count(abs(n.age))   26.39
max(n.age)     15.88        max(abs(n.age))     32.02      max(n.age + 1)  18.94
sum(n.age)     19.70        sum(abs(n.age))     32.87
```

A computed argument costs 1.7-2x a bare property — and `max(n.age + 1)` at 18.94 against
`max(abs(n.age))` at 32.02 says that is FUNCTION DISPATCH rather than "the rung refuses a computed
argument": arithmetic is nearly free on the same path. A twelve-name sweep of the scalar functions
(`upper`, `trim`, `size`, `left`, `substring`, `floor`, `round`, `sqrt`, `coalesce`, `||`, …) lands
in one 25-50 ms band with no outlier.

### The ceiling, which is the useful part

| query                                         | TS       | native   | ratio |
| --------------------------------------------- | -------- | -------- | ----- |
| `WHERE n.age > 44 RETURN count(*)`            | 12.26 ms | **0.15** | 82x   |
| `WHERE n.tag STARTS WITH 'x' RETURN count(*)` | 32.21    | **0.13** | 248x  |
| `RETURN max(n.age)`                           | 15.88    | **0.43** | 37x   |
| `RETURN count(abs(n.age))`                    | 26.39    | **0.82** | 32x   |
| `RETURN count(substring(n.tag, 0, 1))`        | 50.39    | **1.60** | 31x   |

61 ns a row in TS against 0.75 in native on the filtered count. **That is a DATA-LAYOUT difference,
not overhead** — the TS rung walks vertex objects and evaluates a closure per row, while native
scans a typed column. Item 234 reached the same conclusion from the Gremlin side ("the big ratio
was data layout, not overhead") and withdrew two targets on it.

So: no rung is missing here, and a future pass that sees 248x should read this before pricing it.

## 567 — NATIVE: an OPTIONAL hop's landing LABEL kept the slow spelling — 19.5x

`normalize_pred` turns GQL's `'L' IN labels(slot)` into the canonical `IsLabeled` — the node the
tautology short-circuit and the membership bitset both read. **It ran on `Plan::Filter`'s predicate
and nowhere else.** So an `OPTIONAL MATCH`'s LANDING LABEL kept the raw form, which materializes a
label list per candidate, while the same test as a trailing filter was canonicalized.

`query_bench`, 200,000 vertices / 1,000,000 edges:

| row                                      | before       | after               |
| ---------------------------------------- | ------------ | ------------------- |
| `optional hop + landing label` (new row) | 173,141.9 µs | **8,877.7** (19.5x) |
| `optional hop + landing pred` (control)  | 10,112.6     | 11,381.3            |

and on a 350,000-edge probe, alternated rounds:

| query                                                  | before           | after           |
| ------------------------------------------------------ | ---------------- | --------------- |
| `OPTIONAL MATCH (p)-[:KNOWS]->(q:Person)`              | 46.25 / 58.05 ms | **5.65 / 6.46** |
| `OPTIONAL MATCH (p)-[:KNOWS]->(q:Nope)`                | 44.67 / 45.25    | **2.67 / 2.71** |
| `OPTIONAL MATCH (p)-[:KNOWS]->(q WHERE q.age > 50)`    | 3.82 / 3.67      | 3.67 / 4.34     |
| `OPTIONAL MATCH (p)-[:KNOWS]->(q)`                     | 0.62 / 0.64      | 0.60 / 0.75     |
| `MATCH (p:Person)-[:KNOWS]->(q:Person)` (non-optional) | 0.26             | 0.26            |

**Two spellings of one landing filter differing by 12x**, with the non-optional control showing the
label is free when a plain `Filter` carries it — which is what said the problem was the position
and not the test.

`slot_is_node` needed an `OptionalExpand` arm for this: the landing slot is the one the node
APPENDS, so the predicate is normalized against the rebuilt node rather than its input, and the
bound-edge case puts the landing one slot later.

Teeth: four mutants, two caught, one did not compile, control clean. The `bind_edge` mutant is
answer-preserving (declining to canonicalize is only slower), so the test asserts the PLAN —
`IsLabeled { slot: 2` for the bound-edge spelling — which is what catches it.

_The TS engine has had vacuous-label elision since item 221; this is the same class on the other
engine, found by pricing the native optional-hop enum rather than by porting anything._

## 568 — the quantified-group count: TWO targets priced, NEITHER built (the fuzzer does not cover this shape)

Item 567 fixed one predicate position the native optimizer never normalized. Grepping the other
three found no second instance — `Hop.edge_pred` and `ShortestPath.edge_pred` are over an EDGE
(where canonicalizing a label test would be WRONG, which `slot_is_node`'s own doc warns about), and
a label inside a quantified group is REJECTED by this engine outright (`a label/property/WHERE …`),
so `RepeatGroup.per_rep_pred` has no label test to normalize. **The pattern does not repeat.**

Pricing the quantified group instead, 60,000 vertices / 180,000 edges, one case per process:

| query                                                      | native    | TS         |
| ---------------------------------------------------------- | --------- | ---------- |
| `MATCH (a:P)-[:T]->{1,2}(y) RETURN count(*)` (abbreviated) | 1.07 ms   | 421.35 ms  |
| `MATCH (a:P)((x)-[e:T]->(y)){1,2} RETURN count(*)` (group) | 1.06      | **786.15** |
| `… ((x)-[e:T]->(y) WHERE y.age > 50){1,2} …`               | **34.21** | 672.79     |
| `… ((x)-[e:T]->(y) WHERE e.w > 5){1,2} …`                  | **42.59** | 654.86     |

All four answer identically where the shapes match (719,998 / 171,883 / 159,981).

**TWO targets, both real:**

1. **TS: the group spelling costs 1.87x the abbreviated one** (786.15 against 421.35) for the same
   question. The native optimizer already has the fix — `drop_unread_group_binds` turns a group
   whose per-rep bindings nothing reads into a plain var-length hop — and TS has no equivalent.
2. **NATIVE: a per-rep predicate costs 32-40x the unfiltered count** (1.06 → 34.21 / 42.59),
   because the way-count sweep declines and the general group executor runs. 1.5 ns a row against
   ~200.

**Neither built, and the reason is the same for both: the differential fuzzer generates no
quantified or nested group** (recorded in the engine-corpus note), so the usual net would not catch
a wrong answer here. Both need their own tests first.

> **CORRECTED at item 569 — the sentence above is FALSE.** The fuzzer generates quantified groups
> in quantity, each with a coverage floor. Only NESTED groups are the gap. See item 569's entry
> below; the blocker recorded here did not exist.

The TS one also carries item 444's named trap: "a NAMED but UNMENTIONED variable" cannot be
cleared by free-variable analysis alone, because `freePredicateVars` adds a subquery's own pattern
names to its bound set and so cannot distinguish an inner `-[r:T]->` that CORRELATES on an
already-bound `r` from one that binds it freshly. A group-binding elision inherits that exactly,
and must refuse any query containing a subquery rather than rely on the analysis.

### Item 569 — TS group-binding elision: DONE, 2.10x

`dropUnreadGroupBinds` in `packages/gql/src/executor.ts` turns `((x)-[e:T]->(y)){n,m}` whose
per-rep bindings nothing downstream reads into the plain quantified hop, which is what the native
optimizer's `drop_unread_group_binds` already did. 806/855/816 -> 384/397/386 ms over three
alternated rounds at 60,000 vertices / 180,000 edges, landing at or below the abbreviated
spelling's own 429-475. Target 1 of item 568 is CLOSED; target 2 (native's 32-40x per-rep
predicate) is still OPEN.

**Correction to item 568's recorded blocker.** "The differential fuzzer generates no quantified
or nested group" is FALSE — it generates them in quantity, with a coverage floor on each
(`perRep`, `abbrev`, `simpleGroup`, `groupHopPred`, `innerWhere`). The claim came from a one-line
memory summary whose own note body corrects it. The engine-corpus note's gap is about NESTED
groups specifically.

### A seventh cross-engine divergence — group bindings are NULL in TS clause expressions — OPEN

A quantified group's per-rep binding resolves correctly in a RETURN item and to NULL everywhere
else in TS — a clause `WHERE`, a standalone `FILTER`, an `ORDER BY` key — where native sees the
list. `WHERE size(e) > 1` gives ts 0 rows against native 3; `WHERE e IS NULL` gives ts 6 against
native 0, which is what identifies it as null rather than mismatched. `bindGroupVarsFlat` does
write the lists into the binding Map, so the fault is in clause-level name resolution.

Silent wrong rows — the dangerous VALUE class. Pre-existing (reproduces on HEAD). Pinned in
`packages/native/src/group-bind-elision.test.ts` with BOTH answers so a fix fails the test rather
than passing silently. It is also why item 569's M5 mutant survives: the guard it removes has no
observable until this is fixed.

### An eighth — a subquery rebinding a group-bound name — OPEN, narrower class

`MATCH (a:P)((x)-[e:T]->(y)){1,1} RETURN count(*), COUNT { MATCH (p:P)-[e:T]->(q) }` is
`E_SYNTAX` in native and answers `d=0` in TS (correlating the inner `e` against the outer per-rep
list). Error against rows, not value against value.

### Item 570 — native per-rep-predicate quantified count: DONE, 17.6x

Item 568's second target, CLOSED. A `k = 1` per-repetition `WHERE` reading nothing but the hop
TARGET is a `VarLength::body_filter` spelled differently — `rep_pred_ok`'s mini-scope puts the
target at slot 2, and a body filter is defined as a predicate on the hop target applied at each
landing past the source, pruning. `opt` flattens it (`refs_only_slot(p, 2)` + `remap_slot`), and
`try_varlen_count`'s algebraic branch folds it in as a second mask beside the endpoint one.

34.79/35.09/36.27 -> 1.98/2.01/1.98 ms over three alternated rounds at 60,000 vertices / 180,000
edges. Three controls flat (the edge-reading predicate, which stays refused; the unfiltered count;
SIMPLE mode, which is excluded).

**The diagnosis is the reusable part:** `WHERE true` cost 49.95ms for the SAME answer as the
1.05ms unfiltered query. A predicate that rejects nothing and reads nothing paying the whole
penalty is what proves the cost is the ROUTE. Reach for that control first on any "the filtered
version is slower" question.

**TRAIL/WALK ONLY, and not conservatism.** In SIMPLE mode a hop back to the start is a `Close`
step that emits without passing through `varlen_enter`; the walker gates it with a second
`rep_pred_ok` and has NO body-filter twin, because body filters were Gremlin-only and Gremlin
never sets Simple. Flattening there re-introduced item 242's wrong answer and
`optimizing_preserves_rows_*` caught it at seed 19386. ACYCLIC is safe but excluded deliberately
(the algebra declines for it anyway).

**STILL OPEN:** a per-rep predicate reading the EDGE (mini-scope slot 1) or the rep SOURCE (slot 0) stays on enumeration at ~38ms. An edge predicate is not a function of the landing node, so the
node-mask algebra cannot express it; it would need a per-edge mask, which is a different shape.

### A testing trap worth its own line: the algebraic count is GATED, so small fixtures never reach it

`try_varlen_count`'s closed-form branch runs only when `src.len() * avg_deg.powi(max) >
2 * (nodes + edges)`. A 3-node fixture gives 8.3 against 16 — the algebra does not execute, and
four mutants of its gates survived the entire suite while plan assertions passed. Any test meant
to cover it needs roughly 40 nodes at out-degree 4 (640 against 400). This is the counting twin of
the standing "match the fixture to the claim" rule: here the fixture decides which ROUTE runs, not
just how fast it runs.

### Item 571 — the seventh divergence: CLOSED, and it was four wrong answers rather than one

Item 569's "group bindings are NULL in TS clause expressions" is FIXED, and the cause was one
line in `packages/gql/src/executor.ts`: the MATCH compiler's seed-hint loop — which runs ONLY
when the clause has a WHERE — rebuilt each segment as `{rel, node}` and dropped
`CSegment.unit`. A spread fixes it.

It was worse than 569 recorded. `walkSegments` reads `unit` to choose its WALKER, so TS walked
the ABBREVIATED one-hop pattern instead of the unit and lost the per-repetition filter too:

```
((x)-[:T]->(m)<-[:T]-(y)){1,2}      WHERE a.n > 0    ts 8  nv 2
((x)-[e:T]->(y) WHERE y.n > 1){1,2} WHERE a.n > 0    ts 8  nv 5   per-rep filter LOST
((x)-[:T]->(m)-[:T]->(y)){1,2}      WHERE a.n > 0    ts 8  nv 5
((x)-[e:T]->(y)){1,2}               WHERE size(e)>1  ts 0  nv 4
```

`WHERE a.n > 0` rejects nothing and changed 2 into 8. A `k = 1` unit's COUNT was right by luck —
the abbreviated walk agrees there — which is why 569 saw only the null bindings.

**The fix makes two shapes slower and is still right.** A clause WHERE was an accidental 17x
speedup that returned the wrong answer; the control (the same pattern with no clause WHERE)
always cost ~4.3s, which is what the corrected version now costs. k=1 shapes are unchanged.

### The fuzzer gap that let it through — CLOSED in the same commit

All seven byte-identity fuzzers missed four wrong answers because the differential fuzzer's
quantified-group arm **never emitted a clause `WHERE` after the pattern**, the one position that
runs the broken loop. It had the per-HOP WHERE (in the brackets) and the per-REPETITION WHERE
(after the unit); this third position did not exist. Now generated at 280-329 of 20,000 with
floors at half of measured.

Two traps, both of which the file's own comments had already named:

- **Add it as a MODIFIER, not another `forms` entry.** As its own form it diluted `unanchored` —
  the only spelling reaching native's counting sink — from 1-of-3 to 1-of-5, and `sinkGenerated`
  failed its floor. Adding a form to a `pick` list reduces every other form's rate; when one of
  them feeds a coverage floor, that is a regression in the net itself.
- **Keep it out of `perRepGenerated`.** That detector is "group opener AND contains WHERE" and
  three predicate positions had borrowed the counter already. This is the fourth, excluded via a
  shared `CLAUSE_WHERE` regex subtracted before the per-rep test.

### Still open from item 569

The EIGHTH divergence is untouched: a subquery whose inner pattern rebinds a group-bound name is
`E_SYNTAX` in native and answers `d=0` in TS. Error against rows, the narrower class.

### Item 572 — the rest of the per-rep predicate enum: DONE, 16.9-20.6x

Item 570's remaining positions are CLOSED. At `k = 1` a per-repetition `WHERE` is a function of
exactly one `(source, edge, target)` triple — ONE EDGE TRAVERSAL — and since the degree algebra
only runs for `Dir::Out`, an edge id fixes all three. So one mask indexed by edge id
(`traversal_pass_mask`) carries a target test, an edge test, a source test, and any conjunction.

```
WHERE e.w > 5                 37.94/38.70/37.49 -> 1.80/1.88/1.82   20.6x
WHERE x.age > 50              32.38/32.41/32.77 -> 1.71/1.72/1.73   18.9x
WHERE y.age > 50 AND e.w > 5  44.12/44.30/46.20 -> 2.61/2.64/2.63   16.9x
```

**The `AND` row is why the abstraction is a traversal mask and not a node mask beside an edge
mask**: that predicate does not factor into the two. Reach for the finest thing the predicate is
a function of, not for one mask per operand type.

The algebra was extracted from `try_varlen_count` into `try_degree_algebra`, taking three
independent filters that apply at DIFFERENT positions — `end_pred` (a path's last node), `body`
(every landing, 570), `trav` (one traversal, 572).

**STILL OPEN, and now the biggest in this family: the PATH SOURCE** (mini-scope slot `2k+1`).
`-[e:T WHERE a.age > 50]->{1,2}(y)` parses, lowers to a `k = 1` RepeatGroup and reads slot 3, so
`max_slot <= 2` declines it — correctly, since the anchor varies per path and the mask's
mini-batch has three columns. `query_bench` measures it at 304,725us against the target row's
7,978, a 38x gap. It is a per-SOURCE-ROW filter (the anchor is constant along a path), which is a
different lever.

### A ninth cross-engine divergence — a faulting PER-REP predicate — OPEN, narrower class

```
MATCH (a:Q)((x)-[e:T]->(y) WHERE CAST(e.w AS INTEGER) <= 5){1,2} RETURN count(*)
  ts  ERR E_INVALID_VALUE      native  [{c:1}]
MATCH (a:Q)-[e:T]->(y) WHERE CAST(e.w AS INTEGER) <= 5 …          BOTH raise
```

Native's `rep_pred_ok` ends in `.unwrap_or(false)` — "a false / null / faulting predicate fails
the rep" — so a per-repetition predicate NEVER raises there; TS propagates. The agreeing second
line locates it in the per-rep POSITION rather than in `CAST`. Pre-existing. Error against rows.

### Two testing facts worth keeping

- **A per-rep predicate cannot be made to raise**, so a test that wants a fault must exhibit it
  through a spelling that uses `filter_keep` (the clause `WHERE`), not through the per-rep
  position. And `e.w + 1` on a string is NULL, not an error — a fault test built on it is vacuous.
- **The algebra's gate again.** The cross-engine sweep's first fixture was 6 nodes / 9 edges, where
  `est_paths` is 13.5 against the threshold of 30 — the closed form never ran and 425 clean
  comparisons meant nothing. 60 nodes at out-degree 4 clears it. Same trap as item 570's four
  surviving mutants, two ticks apart.

### Item 573 — the TS var-length count: DONE, ~15x, and the gap was ALGORITHMIC

TS answered `count(*)` over a bounded var-length hop by ENUMERATING; native has used degree
arithmetic since item 64. `varLengthDegreeCount` + `detectVarLengthCount` in
`executor/shortcuts.ts` port it for `max <= 2`, `Dir out`, WALK/TRAIL, with an endpoint label as
the passing-degree test.

```
-[:T]->{1,2}(y)        313.15/295.70/312.02 -> 36.46/31.92/41.78, then 19.73 after the rewrite
((x)-[e:T]->(y)){1,2}  272.11/269.28/256.27 -> 32.66/32.20/31.21
```

**The framing matters.** 237-491x was NOT item 566's data-layout ceiling (82-248x on filtered
scans). 479,998 paths against a V+E of 160,000 is an ALGORITHM difference. Closing it leaves ~30x,
which IS that band — so the ceiling claim survives and this was a separate, missing rung.
Before pricing a big TS/native ratio as "the layout", check whether the two engines are running
the same algorithm.

The GROUP spelling reaches it via item 569's elision, so `bun run spelling`'s item-569 group now
reads 223.80 / 220.11 / 221.11, within 1.02x, against 1131 / 1278 / 1122 when it was added.

**STILL OPEN in TS:** a per-rep predicate (466ms) and an endpoint predicate beyond a bare label
(367ms). Native folds both in as masks (items 570, 572); the TS rung takes neither yet.

### Two traps this item paid for

- **Summing per-label `set.size` double-counts a MULTI-LABEL edge.** It sits in several of a
  vertex's adjacency buckets. `multi-label-edges.test.ts` answered 8 where the walk answers 3 —
  and a 448-query cross-engine sweep with `[:T|U]` cases MISSED it, because that fixture's T and
  U edges were disjoint. Use `edgesOfTypes`, which dedupes through a `Set` and keeps the O(1)
  route; it is also faster than the hand-rolled sum.
- **A guard that declines everything measures exactly like an absent one.** `PathPattern.selector`
  defaults to the string `'walk'`, not `undefined`, so a `!== undefined` guard refuses every
  query. The only symptom was a measurement showing no change whatsoever. An optimization that
  measures as a perfect no-op is more likely unreachable than ineffective — check the guard
  before the arithmetic.

### Item 574 — a Gremlin hop CHAIN count: DONE, 3.8-4.5x, and it closed a divergence

A chain of two or more Gremlin hops before `count()` had no rung — TS ran one traverser per path
where native answers from degrees. `hopChainCount` propagates FRONTIER MULTIPLICITIES (O(k · E),
whatever the path count) and `expandRepeats` turns an eligible `repeat(<one hop>).times(k)` into
its k chained hops as a PRE-PASS, so every existing rung sees a shape it understands.

```
out(T).out(T).count()     93.81/97.39/98.04   -> 24.99/31.65/29.85   3.8x
repeat(out).times(2)     113.76/110.56/100.61 -> 22.48/28.10/25.05   4.5x
repeat(out).times(1)      32.31/29.56/28.39   -> 0.01   (the bucket rung)
repeat(out).times(3)      THREW               -> answers 1,080,000
```

**The `times(3)` row was a DIVERGENCE:** TS raised "repeat() exceeded the trail budget" where
native answers. A budget meant to stop a fan-out materializing rows was bounding a bare COUNT. A
closed form materializes nothing, so it is gone — the Gremlin-side version of native's
`a_group_count_is_not_bounded_by_the_trail_budget`.

**STILL OPEN: the same divergence for `emit()`.** It sums over depths rather than taking the
k-fold product, so the expansion declines it, and at 1,000,000 edges it still raises on the TS
side where native answers.

### TinkerPop 3.7.3 ground truth for `repeat().times(k)`

`repeat(h).times(k)` IS the k-fold chain — no edge or vertex uniqueness. Verified on a 6-vertex
fixture WITH a self-loop and a parallel pair, where a restriction would have shown:
`out1 = times1 = 14`, `out2 = times2 = 33`, `out3 = times3 = 78`, `times2emit = 47 = 14 + 33`,
`both1 = 28`, `both2 = 134`, `mixed = 34`, `in2 = 33`. Both lenke engines match all of them.

**A DEVIATION found doing it:** `repeat(out).times(0).count()` is **14 in TinkerPop** (it runs the
body once) and **6 in both lenke engines** (pass-through). Not a cross-engine divergence; the same
class as item 417's `inject`+`limit(0)`. Pinned at current behaviour.

### An eleventh divergence — a multi-step `repeat()` body is a PARSE ERROR in native

`planToGremlin` emits `repeat(out('T').out('T'))` and native's Gremlin parser answers
"expected RParen"; TS answers 185. Pre-existing, a parser gap rather than a semantics one.

### The per-label bucket sum, AGAIN — read this before writing a degree count

A 146-case sweep found 13 divergences, **every one an `out()` at depth 2 or more**: zero labels
means "every bucket", so a multi-type edge is visited once per label it carries. The guard must be
`labels.length !== 1` — exactly one wanted label is unconditionally safe, zero or several need
`multiTypeEdgeCount === 0`. `out(T,U)` was never among the 13, because the narrow `> 1` guard did
catch that one.

Item 573 shipped the identical bug on the GQL side one tick earlier. **A per-label bucket sum is
only a degree when the wanted set is a single bucket.**

### Measuring several shapes in ONE process can manufacture a regression

Item 574's `emit()` control read 114.56/113.79/108.51 -> 132.63/141.70/127.31 — non-overlapping
bands, consistent over three alternated rounds, and WRONG. Isolated (one shape per process, min
of 9, four rounds) it is 103.43 -> 100.46, flat. The four shapes ahead of it in the process got
faster, which changed the JIT and GC state it ran in. Item 423's rule is exactly this; it is
usually quoted for hiding a win, and here it invented a loss.

### Item 575 — the PATH SOURCE per-rep predicate: DONE, ~42x. THE k=1 ENUM IS CLOSED

The last position item 572 left enumerating. The mini-scope at `k = 1` puts the path source at
slot `2k+1` = 3; it is not a traversal (the anchor varies per path) but it IS constant ALONG a
path, so it admits every repetition from a source or none — a filter on the source ROW.
`try_degree_algebra` gains a third mask, `seed`.

```
-[e:T WHERE a.age > 50]->{1,2}(y)  33.39/33.24/32.64 -> 0.82/0.80/0.78   41.8x
-[e:T WHERE a.age > 50]->{0,2}(y)  32.73/32.54/32.60 -> 0.82/0.77/0.83   42.3x
query_bench row                    304,725us -> 3,035                    100x
```

It is now the CHEAPEST of the three per-rep rows (3,035 against 8,112 and 20,542): a node mask
over 200,000 nodes beats a traversal mask over 350,000 edges, and a seed filter prunes before any
walk.

**A ZERO-LENGTH PATH HAS NO REPETITIONS**, so a per-rep predicate never runs for it and the row is
emitted whatever the predicate says:

```
-[e:T WHERE a.age > 25]->{0,2}(y)   8 = 4 filtered hop paths + 4 zero-length, one per SOURCE
-[e:T WHERE a.age > 25]->{0,0}(y)   4,  the predicate irrelevant
```

The seed mask therefore gates the HOP terms and NOT the `min == 0` term; gating both answers 6 and 2. Found by a probe BEFORE the mask was designed, which is the only reason the first version was
right.

**THE `k = 1` PER-REP ENUM IS NOW CLOSED.** Target node and any traversal conjunction (570, 572),
path source (575). What remains is `k > 1` — a predicate there reads several edges and is not a
traversal question — and the Gremlin `emit` shapes (574).

### A guard written for symmetry was dead, for the second time in this run

`eligible` tested `*k == 1` and so did the branch that consumed it. The mutant survived the whole
suite; the term is removed rather than pinned. Item 570's `body(s)` was the same story. **When a
condition is unkillable, check whether an enclosing branch already guarantees it before building
a fixture for it.**

### Item 576 — `createIndex` built an index on the WRONG ELEMENT: silent 500x, now an error

`Graph.createIndex` validated the index KIND and nothing else. The branch using the target read
`spec.on === 'vertex' ? vertex : edge`, so ANY other value — `'node'`, a typo, a missing field —
took the EDGE arm and built an edge index on a vertex key. Not an ignored call: an index on the
wrong element, which no seek consults.

```
{ on: 'node',   kind: 'hash', keys: ['name'] }    an EDGE index; 1.20M -> 2.3k ops/s, no error
{ on: 'vertex', kind: 'hash', keys: [] }          an index keyed `undefined`
{ on: 'vertex', kind: 'hash', keys: ['a','b'] }   a one-key index, the rest silently dropped
```

All three now throw `E_INVALID_GRAPH_OP`. The last two TYPE-CHECK — core's `IndexSpec` is a loose
`{on; kind; keys: string[]}` where the native package's is a discriminated union — so a fully
typed caller can hit them. **A twelfth cross-engine divergence closed**, and the costly side was
the silent one: native rejects every spec above.

`edge` + `hash` stays accepted: core keeps a property index per side and one structure serves both
seeks, a real core capability native lacks.

**`'node'` is the natural word for a GQL engine** and is what this project's own memory note had
recorded for the API. The vocabulary is `'vertex' | 'edge'`.

### `bench:usage` priced, and `interleaved: append + link` decomposed

TS-indexed usually BEATS native on that bench (FFI dominates a small op: point lookup 1.20M
against 353.4k). Two rows buck it: `append + link` 55.9k against 176.3k, and
`read: keyed dedup lookup` 74.7k against 136.5k.

`append + link` decomposes to ONE cause — properties on the inserted node:

```
lookup (MATCH only)                     1349.4k ops/s
match+set                                407.1k
insert-edge-only                         174.1k
insert-bare+edge (new node, NO props)    156.6k
insert-node+edge (new node WITH props)    49.6k
```

A bare `INSERT (:Entry)` is 471.5k and ONE property takes it to 161.3k (2.9x); a second only to
~146k. A FIXED entry cost for having any properties, not per-property, and `id` is no dearer than
a plain key.

**REFUTED: it is not index maintenance.** With the indexes dropped the gap is identical
(507.8k -> 163.8k against 499.6k -> 165.1k with two). The next target is the property path on
insert, priced at ~2.9x.

> **RETRACTED at item 577 — there is no property cost.** Passed as a PARAMETER, one property reads
> 479.8k against a bare node's 482.7k. The 2.9x was the probe: the bare baseline reused ONE query
> string while every property case interpolated into the TEXT, making them parse+plan cache
> misses. The control is a BARE `INSERT (:Entry)` with a changing comment — 182.2k against 482.7k,
> no properties, same 2.6x. Do not re-attempt "the property path on insert".

### `grep` silently skips a large UTF-8 source file

Chasing this cost a chunk of a tick: `grep -rn 'createIndex' packages/core/src` found NOTHING,
`grep -c` returned 0, and `Graph.ts` (163 KB, 4,413 lines, `file` says "Unicode text, UTF-8") was
being skipped as binary. I concluded the dist was built from sources not in the checkout and went
looking for a second worktree. **Use `grep -a` on this repo's larger prose-heavy sources.** The
rename/refactor note already recorded this and I did not reach for it.

### Item 577 — a changing query TEXT is a parse+plan cache miss worth 2.6-3.0x on a small write

The real finding behind item 576's retracted target. `bench:usage` had four rows interpolating a
changing value into the query text, so every operation missed the plan cache and the row priced
the PARSER as well as the write. On the identical `append + link` statement: **51.1k interpolated
against 151.4k parameterized.**

Three alternated rounds on `write: append node`, one row per process:

```
                       ts(+)                      engine(+)                wasm(+)
interpolated   130.9k / 97.6k / 129.8k    366.6k/359.6k/342.4k    340.1k/330.8k/331.9k
parameterized  442.4k / 442.7k / 384.4k   260.6k/262.2k/255.4k    237.1k/234.0k/232.0k
```

**Parameterizing is NOT uniformly better.** TS gains 3.4-3.9x; **native LOSES 1.37x and wasm
1.42x**, consistently — binding three parameters across the FFI costs native more than re-parsing
a small `INSERT`. So `write: append node` keeps BOTH forms as a pair (one row alone hides
whichever cost it does not pay), while the two rows whose purpose is the write are parameterized.

**OPEN, and now the real TS deficit in that bench:** `read: keyed dedup lookup`, ts(+) 74.7k
against native's 136.5k. It already uses a parameter, so it is not this artifact. Unpriced.

**OPEN, native:** the param-binding cost above — 1.37x on a three-parameter INSERT, with the
interpolated twin as its control.

### A decomposition is only as good as its BASELINE

Item 576's baseline differed from its cases in a second, uncontrolled way (one query string against
many). I had already refuted one hypothesis in that item, which is precisely when the surviving one
deserves the same scepticism — and did not get it. When a decomposition shows a fixed cost that
appears the moment a feature is used, check whether the feature is the only thing that changed.

### Item 578 — `read: keyed dedup lookup` is the CEILING, not a rung: RETRACTED as a target

The index seek IS taken: 93.1k ops/s against a 3.4k scan reference, 27x. 200 matches at 93.1k is
**54ns a row** against item 566's measured TS floor of ~61ns, and native's 136.5k is 37ns. The
1.8x is the data-layout per-row constant that item 566 established, not a missing route. Swapping
the conjuncts changes nothing (88.9k against 90.0k), so no written-order cliff either.

### A TS spelling gap that no instrument was watching — OPEN

```
MATCH (u:User) WHERE u.score = $s AND u.active = true   clause
MATCH (u:User {score: $s}) WHERE u.active = true        inline
```

Three interleaved rounds at 20,000 users: at **1000 matches a seek** clause 21.3/20.8/21.8k
against inline 11.5/14.4/14.7k — **1.41x**, consistent in direction every round. At 20 matches it
is unresolvable (310-608k against 323-480k), which is the evidence that the cost is PER ROW.
**Native has no gap** (inline 145.3k against clause 137.2k).

A first pass measured 1.36x at 200 matches and a second run REVERSED it, with the clause form
moving 1.6x between runs — the bimodality [[ts-spelling-probe]] records. Only interleaved rounds
at a selectivity above that noise resolve it.

### WHY nothing watched it — read this before trusting `spelling-probe` on a seeding question

`spelling-probe` already has the exact pair (item 230's group) and does not flag it, for two
reasons:

- **It creates NO INDEX.** `createIndex` appears ZERO times in the file. No index, no seek, so no
  seek-versus-recheck asymmetry can exist to be found.
- **It binds NO PARAMETERS**, and its own comment delegates the param case to "`bench:usage`'s
  `read: keyed dedup lookup`, which is exactly that mixed shape" — but that was a SINGLE row, not
  a pair, so the delegation pointed at something that was never a comparison.

**Every historical index-seeding bug in this engine was one spelling seeding where another did
not, and the probe built to catch that class cannot see any of it, because it never builds an
index.** `bench:usage` now carries the pair (`read: keyed dedup lookup [inline]`), but at its 200
matches the TS columns swing 3.3x run to run and cannot resolve the gap.

**NEXT INSTRUMENT TARGET: give `spelling-probe` an index and parameter binding.**

### Item 579 — `spelling-probe` can now see SEEKING spellings, and the first thing it saw was a gap

Item 578's instrument gap is closed. The probe takes PARAMETERS (`timed(q, params?)`), creates
indexes on `k` and `s` in a **seek pass that runs after the existing groups** (so their recorded
numbers stay comparable — no second fixture), PRINTS the indexed keys (a seek group that silently
measures a scan looks fine; item 576 is the precedent), and carries five seek groups.

**It flagged on the first run.** `SPELL_N=1000000`, 20,000 matches a seek, three separate
processes via `SPELL_ONLY`:

```
MATCH (n:P) WHERE n.k = $k AND n.s >= ''      1.90 / 1.75 / 1.96 ms
MATCH (n:P {k: $k}) WHERE n.s >= ''           2.91 / 2.33 / 3.13
MATCH (n:P WHERE n.k = $k) WHERE n.s >= ''    5.18 / 2.35 / 5.20
```

**Clause against inline is a consistent 1.3-1.6x**, confirming item 578's 1.41x on a different
fixture and harness. `inline WHERE` is additionally BIMODAL, so the group reads 2.7x in two runs
of three.

**LOCALIZED: the STRING-key twin converges at 1.07x** (8.54/8.77/9.11/8.54ms over four spellings).
So the gap is specific to a numeric seeked key, and the two-pass min rules out the harness.

Three converged negatives worth keeping: **param against literal on the seeked key is 1.07x** (a
param costs essentially nothing, though a literal lifts at compile time and a param cannot), a
projection off the seek 1.04x, an anchored hop 1.04x.

**Limit:** the numeric group needs `SPELL_N=1000000` to clear `FLOOR_MS` (`k` is `i % 50`, so
200,000 vertices give 4,000 matches and ~0.5ms). At the default N the probe lists it under "raise
SPELL_N to measure them" rather than passing silently.

**OPEN: the 1.3-1.6x itself.** An inline `{k: $p}` and an `inline WHERE` seed less well than the
clause form on a numeric key. Now watched by the probe, which is what was missing.

### Item 580 — the seeding gap is NOT a lost seek; target DOWNGRADED to ~1.3x and parked

**REFUTED, and this is the reusable part:** no spelling loses the seek. At 200,000 vertices with
`k` indexed, the scan reference (`MATCH (n:P) WHERE n.s >= ''`, nothing seekable) is **7.09ms**
while every spelling of the seeked question is **1.0-3.5ms**. "One spelling seeds and the other
scans" is what every historical index bug in this engine was, so it is the hypothesis the next
pass will reach for first — and it is wrong here.

**Narrowed:** without a second conjunct the spellings converge (1.20-1.32ms over 20,000 rows). The
gap needs the MIX of an inline seed and a clause conjunct.

**What survives across both instruments** is item 579's numeric-key group with a VACUOUS second
conjunct: clause 1.90/1.75/1.96ms against inline 2.91/2.33/3.13 — a consistent **1.3-1.6x**. The
2.7x headline is the `inline WHERE` member alone, which is bimodal (5.18/2.35/5.20). The
four-spelling group added at 580 converges within 1.65x and does not flag.

**PARKED.** ~1.3x at the edge of the instrument's resolution, with three harnesses agreeing on
nothing but the direction. Watched by `bun run spelling`; not worth chasing against a 2x threshold
it does not reach.

### A hand-rolled probe without a POSITION PASS will mislead you (item 580)

Single runs of an ad-hoc harness (min of 9 reps, one process per case, no reversed pass) against
the same questions in `spelling-probe`:

```
                        ad-hoc single run      probe two-pass min, twice
clause + eq (param)           1.25 ms              1.89 / 1.77
inline + eq (param)           2.32                 2.11 / 2.00
clause + eq (LITERAL)         3.13                 1.77 / 1.73   <- FASTEST, not slowest
both inline {k, s}            1.24                 2.42 / 2.85   <- SLOWEST, not fastest
```

Two of four corners REVERSED. From the first column I had built a 2x2 with opposite winners for
param and literal plus a mechanism story, and none of it survived. `spelling-probe`'s own comment
records a group reported at 1.5-2.1x across two audit items "with no engine cause at all" — which
is why it times every spelling in both positions. **Use the probe (add a group) rather than a new
ad-hoc harness when the effect is under ~2x.**

### Item 581 — TS's top-k pays 4.5x its OWN floor — OPEN, specified, and watched

A fresh enum (`ORDER BY`). The rung EXISTS and is bounded: the full sort is 294ms against 31 for
`LIMIT 1/5/100`, and it is FLAT in k. `aliasDefinition` (145, 213) is what keeps it — it rewrites
`ORDER BY k` to `ORDER BY n.k` so the key reads an input variable and `orderNeedsOutput` stays
false.

**THE FLOOR IS A SHIPPED PATH.** `min(n.k)` does exactly what `ORDER BY k LIMIT 1` must do — read
one property per row, compare, emit one row:

```
RETURN count(n.k)                    ts  8.91 ms   nv 0.11
RETURN min(n.k)                          9.32         0.41
RETURN n.k AS k ORDER BY k LIMIT 1      30.84         0.71
RETURN n.k AS k   (200,000-row proj)     9.33        14.56
```

**TS 3.4x its floor, native 1.7x.** On the cross-engine bench's fixture: 36.1 against 8.1
(**4.5x**) for TS, 1.0 against 0.4 for native.

**Diagnosed:** the top-k does NOT project every row (`orderNeedsOutput` keeps only the top-k input
bindings — item 426 measured that). It runs the GENERAL pipeline, building a binding `Map` per row
and reading the key from it, where `min()` takes the node-aggregate shortcut and builds no binding.

**THE SPEC:** `MATCH (n:L) RETURN <plain cols of n> ORDER BY <plain col of n> [DESC] [SKIP s]
LIMIT k` → scan the label bucket, extract the key per vertex, keep a bounded top-(s+k), project
only the survivors.

**Why not yet:** a new sort rung must reproduce the engine's TOTAL ORDER byte-identically (NaN
last, NaN == NaN for sort/min/max — a deliberate departure from the predicate semantics), plus
DESC, ties and SKIP. Fuzzer-and-mutation work, not tail-of-a-tick work.

`bun run bench` now carries the PAIR (`query: top-k by property` beside `query: min property
[top-k floor]`): a bare top-k row cannot say whether a regression is the rung or the scan beneath
it.

### Take the floor from a SHIPPED fast path, not from theory (item 581)

`min(n.k)` is not an estimate of what reading-and-comparing one property per row ought to cost — it
is that work, done today, by another rung in the same engine. A target anchored that way survives
re-measurement in a way that "~61ns a row times 200,000" does not, and it tells you the win is
reachable because something already reaches it.

> **CORRECTED at 582 — this is only half a rule, and item 426 states the other half: "a floor
> measured on a different PLAN is not a floor."** `min(n.k)` runs on
> `detectNodeProjection`'s FUSED SCAN (since item 420), a different row-production path from
> `applyProjection`'s general binding stream, so the comparison prices the PLAN difference and not
> the top-k. A shipped path is the right place to look for a floor, and it must be on the SAME
> plan to be one.

### Item 582 — item 581 RETRACTED: 424-426 had already done it, and `head -5` is why I missed it

Item 581's whole framing is withdrawn. The prior work:

- **424:** "The top-k itself is NOT missing" — 50.1ms against 485.1 unlimited is 9.7x, cost climbs
  with k, spellings agree. Removing the per-row allocation REFUTED at 2.4%.
- **425:** SHIPPED the single-key bounded heap, 1.34-1.50x over six shapes, five alternated rounds
  at nine reps.
- **426:** the floor error (above) and the ATTRIBUTION — with a constant sort key (all ties, heap
  never evicts), **25.6 of 35.5ms is the general binding stream plus the loop**, so the remainder
  is item 377's per-row `Binding`, not the top-k's.

**Corrected target:** ~2.3x, not 4.5x, and the lever is the general binding stream. Two routes, in
the order the prior work implies: (1) item 377's per-row `Binding`, which pays for far more than
this shape; (2) a fused top-k on a node scan — giving this shape what `detectNodeProjection`
already gives `max()`. Neither attempted.

`bun run bench`'s pair stays, relabelled: it is a top-k against a FUSED-SCAN aggregate, a PLAN
comparison, not a target against its floor.

### NEVER `head` a search of CLOSED.md (item 582)

The search that missed all of the above:

```
grep -rn 'top-k\|topK\|partial sort\|heap' docs/reviews/CLOSED.md | head -5
```

`top-k` has **14 matches** here (lines 47, 3090, 3101, 3115, 3116, 3127, 3133, 3140, 4127, 5472,
7714, 7734, 7746, 7747). `head -5` showed five, and since the pattern also matched `heap`, four
were unrelated table rows; the one top-k line surfaced (47) is about the NATIVE `OrderPage`.
Everything that mattered was below the cut.

**This file is 7,700+ lines and APPEND-ORDERED, so the newest and most relevant entries are at the
BOTTOM — precisely what `head` discards.** Run `grep -c` first; if the count is more than a
handful, read the TAIL of the matches, not the head. Third time this session that recorded work was
re-derived; the first two searched the wrong store, this one searched the right store and truncated
it.

## 583 — CLOSED: a bounded var-length `count(*)` with an ENDPOINT PREDICATE, TS, 6.2-8.7x

Item 573's `varLengthDegreeCount` took an unfiltered endpoint and an endpoint LABEL and declined
any endpoint PREDICATE. It now carries one, in **all three spellings**, as a compiled `InlinePred`
applied per reached endpoint. 40,000 vertices / 120,000 edges, min of 3, three alternated rounds:

| shape                                         | pristine  | after  | min/min  |
| --------------------------------------------- | --------- | ------ | -------- |
| `(y WHERE y.age > 50)`                        | 206.92 ms | 31.87  | **6.5x** |
| `(y) WHERE y.age > 50`                        | 244.92    | 28.01  | **8.7x** |
| `(y {age: 50})`                               | 176.28    | 28.26  | **6.2x** |
| CONTROL unfiltered (on the rung both sides)   | 14.77     | 15.01  | flat     |
| CONTROL per-rep `WHERE` (declines both sides) | 370.10    | 364.94 | flat     |

The three spellings AGREE after (1.14x spread) where they spread 1.39x before — which was the point
rather than a side effect, since items 303/304 record an inline-vs-clause gap of **139x** on the
one-hop version of exactly this.

**Still REFUSED, deliberately:** a gate on the START (a seed filter, which this rung does not
carry — native needed a separate mask at item 575); an unrepresentable gate (`inlineOf`/`gateWith`
returning `null`, e.g. `(y {n: a.n})` — `null` means "cannot carry", NOT "no predicate"); and 573's
own `max > 2`, `SIMPLE`, multi-type-hop and non-plain-start refusals.

**No fault fallback needed**, unlike native's `node_pass_mask` (items 570, 572): that builds a mask
over every node in the store, so an unreached vertex can fault there and not under enumeration.
This applies the predicate per REACHED endpoint, over exactly the set the walk sees.

### At BENCH size: 5.7x, a new watcher pair, and the NEXT lever (item 583)

200,000 vertices / 1,000,000 edges, two alternated rounds: the filtered row went **2446.99 ms to
429.35 (5.7x)**, control flat. `bun run bench` gains the pair `count var-length 1-2 hops` and
`count var-length 1-2 hops + end filter` — item 573 shipped the rung with NO watcher.

**Reading the pair:** both rows are FLAT IN PATH COUNT (189/397 at 3 edges/node against 187/379 at
5, where paths go 2.4M to 6.0M), which is how the table alone shows the rung is taken. I nearly
misread 331.7ms as a decline.

**~~OPEN LEVER, priced~~ WRONG, retracted at 584:** I wrote that TS "enumerates" the last hop and
that precomputing a per-node passing out-degree was the open route. `degreeOf` ALREADY memoizes
exactly that. The 2x is the inner O(E) edge walk which the unfiltered route skips via `set.size`,
and it is irreducible in the forward direction — selectivity does not move it and the predicate is
~15ns. See 584 below for the attribution and for the lever that does exist (inverting through
`adjTo`).

### A 1.10x that was noise, measured twice to find out (item 583)

The unfiltered control read 181.78 against 200.25 and I took it for
[[ts-closure-size-is-load-bearing]], so I split the detector's two arms to put the predicate-free
case back on identical code. Isolated, three alternated rounds each way: one closure gave mins
182.44 / 184.26 (1.01x), split gave 171.92 / 181.37 (1.055x) — **with the pristine side the looser
one the second time.** Both under the ~10% floor, the wide side swapping between runs: noise. The
split is KEPT for its prophylactic value but **it fixed nothing measurable**, and claiming
otherwise would have put a fake mechanism in the record.

### A surviving mutant is first a question about REACHABILITY (item 583)

Six mutants, cap proved to kill first (137 for an allocator bomb, 124 for a bare `while true`).
Two survived: one was a missing test, **one was dead code**.

- **M2** — treating a `null` gate as `undefined` dropped the predicate and read 10 for 1, and
  nothing asserted on it. A real gap; `(y {n: a.n})` and its two twins now pin it.
- **M5** — I had written a `!plainNode(pattern.start)` decline into the detector, and
  `degreeCountShape` already requires exactly that one `||` earlier. The guard could never fire, so
  no test could kill it. **Deleted**, with a comment saying why there is none.

So: when a mutant on a guard survives, ask whether the guard is REACHABLE before writing a test for
it. Four historical wrong-answer bugs needed the generator widened; this one needed the code
narrowed. Deleting it also left `degreeCountShape`'s `node` binding unused, which `bun run lint`
caught at exit 1 — the argument for running the lint gate as its own command.

### 584 — RETRACTING 583's "next lever": the precompute it asked for ALREADY EXISTS

583 recorded, as an open priced lever, that TS "enumerates the last hop" and that native's 1.08x
comes from precomputing a per-node passing out-degree, so "the same precompute in TS is an O(V+E)
route". **`varLengthDegreeCount` already has it.** `degreeOf` memoizes the passing out-degree per
vertex in a `Map<Vertex, number>` — audit item 321's object-keyed memo — so each distinct landing
vertex's out-edges are walked ONCE, not once per path. I prescribed building something I had read
two ticks earlier.

**What the 2x actually is.** 200,000 vertices / 1,000,000 edges, min of 5, one process:

| arm                                    | ms         | what it isolates                                     |
| -------------------------------------- | ---------- | ---------------------------------------------------- |
| unfiltered `{1,2}(y)`                  | **187.87** | `passesIsVacuous`, so the degree is `set.size`: O(V) |
| `{1,2}(y:Q)` label                     | 418.14     | the walk, with a label test                          |
| `(y WHERE y.age >= 0)` TRUE for all    | 446.49     | the walk, predicate never rejects                    |
| `(y WHERE y.age > 60)` ~1/3 pass       | 432.03     | the walk, predicate rejects 2/3                      |
| `(y WHERE y.age > 1000)` FALSE for all | 355.24     | the walk, predicate rejects everything               |
| `(y WHERE y.nope > 0)` missing key     | 350.29     | the walk, null every time                            |
| CONTROL `{1,1}` with the predicate     | 119.12     | the OUTER loop, no `degreeOf` at all                 |
| CONTROL `{1,1}` unfiltered             | 103.95     | the outer loop alone                                 |

Three things fall out, and each kills a candidate:

- **Selectivity is not the cost.** True-for-all 446.49 against false-for-all 355.24 — the arm that
  rejects every vertex is the FASTEST filtered arm and still 1.9x the unfiltered one.
- **The compiled predicate is not the cost.** The `:Q` LABEL arm costs the same 418.14, and the
  one-hop controls price 1,000,000 predicate calls at 119.12 − 103.95 = **15ms**, ~15ns each.
- **So the 2x is the inner O(E) edge walk**, which the unfiltered route skips entirely by reading
  `set.size`. A filtered endpoint must know, per vertex, how many of its out-edges land somewhere
  that passes, and the forward walk pays one edge visit for every edge in the graph.

**That part is irreducible in the forward direction** — which is why the lever as 583 stated it does
not exist. The remaining 100x to native (430 against 4.3) is item 566's layout ceiling: a bitmask
over a contiguous node array and a CSR against `Map<Vertex, number>`, closure dispatch and `Set`
iterators.

### The lever that IS there: accumulate through the IN-adjacency (584, open)

The forward walk is O(E) whatever the predicate does. Accumulating the same quantity BACKWARDS is
not: for each PASSING vertex z, walk z's in-edges and add one to each source's passing out-degree.
That costs O(V) predicate calls plus **O(edges INTO passing vertices)** — so it scales with
selectivity where the forward walk is flat in it. `adjTo` is there (`Map<string, Set<Edge>>`, items
162/321), and the false-for-all arm above says the ceiling: 355.24 → the outer loop's ~190.

**The trade is eager against lazy, and it is why this needs a gate rather than a swap.** `degreeOf`
is DEMAND-DRIVEN: it computes a degree only for vertices actually reached at hop 1, so a narrow
start label can make the forward route cost far less than O(E). Inversion is eager over every
passing vertex's in-edges. The cost comparison is `reached × avg_deg` against `passing × avg_indeg`,
both estimable, and the predicate sweep that gives `passing` is itself only O(V) — 200,000 calls at
~15ns is ~3ms against the 240ms it would be deciding about.

**BUILT at item 585 — see below.** 2.64-2.78x when the test rejects everything, 1.47x at a third,
1.14x on a label, 0.99x where it declines.

## 585 — CLOSED: the second hop accumulated BACKWARDS, TS, 1.14-2.78x by selectivity

The forward walk pays one edge visit per edge IN THE GRAPH, flat in selectivity (584). Accumulating
through the IN-adjacency of PASSING vertices pays one visit per edge into a passing vertex, so the
cost finally tracks the predicate. 200,000 vertices / 1,000,000 edges, three alternated rounds,
min-of-min:

| arm                          | pristine  | after  | ratio                  |
| ---------------------------- | --------- | ------ | ---------------------- |
| missing key (rejects all)    | 333.10 ms | 119.71 | **2.78x**              |
| `age > 1000` (rejects all)   | 376.74    | 142.83 | **2.64x**              |
| `age > 60` (~1/3 pass)       | 409.35    | 278.56 | **1.47x**              |
| `:Q` label (1/3 pass)        | 341.51    | 298.75 | **1.14x**              |
| `age >= 0` (passes ALL)      | 382.94    | 388.23 | 0.99x, gate declines   |
| CONTROL unfiltered, isolated | 189.34    | 176.15 | after wins every round |

Independently on the spelling probe's fixture: the SELECTIVE equality group 404.86-409.52 ->
236.86-250.03 (1.65x), spellings still inside 1.06x.

### A perf gate needs its OWN test, because every mutant of it survives (585)

`invertedHopBudget(vertexCount, edgeCount, srcCount)` is extracted as a pure exported function with
`packages/gql/src/inverted-hop-budget.test.ts`. Both routes return the same count, so mutating the
decision cannot fail a differential test: three mutants (always invert; drop `max >= 2`; invert for
a vacuous test) all passed 11 cases pinned against native, as they were bound to. Against the unit
test, four mutants of the arithmetic are CAUGHT. **Arithmetic no differential test can reach either
gets its own test or has no teeth.** The empty-graph guard's mutant survives and the test says why
(NaN comparisons are all false), rather than pretending it is covered.

### A tie-inclusive comparison, and the margin I got backwards (585)

The sampled pre-check (first 1024 vertices) caps the O(V) sweep's loss on a test that passes
everything: that arm went 0.93x to 0.99x. The FIRST version demanded the projection exceed the
budget by 2x, for prefix-sampling safety — but the budget is capped at the vertex count, so a test
passing everything projects EXACTLY the budget and never twice it. **The check could not fire for
the one case it existed for**: item 583's dead-guard shape again, one tick later, found by writing
the test. Erring tie-inclusive is safe where erring the other way is not — an unrepresentative
prefix skips a win and runs the FORWARD route, which is what the engine did before 585 at all.

### The control the shared process lied about (585)

The unfiltered arm read **0.88x** in the shared probe — a 1.14x regression, if believed — on a route
where `passesIsVacuous` short-circuits the gate before it reads anything. Both one-hop controls read
0.96x in the same run: a side-wide offset on arms the change provably cannot reach. Isolated, one
case per process, three alternated rounds, the after side wins EVERY round (189.34 -> 176.15).
Position in a shared process. The repo had this lesson filed and it still cost a round.

## 586 — CLOSED: the degree algebra reads IN-adjacency, native, 9.4x (and OUT pays 4%)

`try_degree_algebra` was gated on `Dir::Out` since item 64. Pricing the refused variants against
the accepted one at 200,000 vertices / 1,000,000 edges made the pick unambiguous: `in {1,2}` cost
**35.99ms against 3.99 for the IDENTICAL count** (both 5,999,996), while a single IN hop costs
exactly what a single OUT hop does (0.51ms each) — the in-adjacency was never the reason.

|                                                          | pristine    | after       |            |
| -------------------------------------------------------- | ----------- | ----------- | ---------- |
| `in {1,2}`                                               | 35.36 ms    | 3.76        | **9.40x**  |
| `in {1,2}` + end pred                                    | 36.56       | 4.00        | **9.14x**  |
| `out {1,2}` + 4 accepted siblings                        | 3.36-3.93   | 3.59-4.14   | 0.94-0.96x |
| `both` / `{1,3}` / `{3,3}` / SIMPLE / ACYCLIC — CONTROLS |             |             | 1.02-1.07x |
| `out {1,1}` / `in {1,1}` — CONTROLS                      | 0.51 / 0.50 | 0.51 / 0.50 | 1.00x      |

**`Dir::Both` stays refused and is a DIFFERENT SHAPE, not a third branch:** from one node an
undirected edge is traversable two ways, so one edge-indexed traversal mask cannot represent both,
and a self-loop sits in both adjacency lists. `max >= 3` and SIMPLE/ACYCLIC also remain open.

### A total count CANNOT witness a direction bug (586)

Over ALL sources, reversing every path is a bijection between the forward and backward path sets,
so `(a:P)-[:T]->{1,2}(y)` and its `<-[:T]-` twin return the SAME NUMBER whatever the engine does. A
fixture I had built to be asymmetric read `out=232 in=232` and would have passed with the direction
wired backwards. **The source set must be SELECTIVE** — `:Q` on a third gives `out=76 in=79`. Both
the Rust test and the sweep now ASSERT the asymmetry, and that assertion caught two of five mutants.

### The algebra's gate needs degree >= 7 once the source set is selective (586)

The gate is `src.len() * avg_deg^max > 2 * (nodes + edges)`. With the source label on a third and
`edges = d*n` that is `(n/3) * d^2 > 2n(1+d)`, i.e. `d^2 > 6 + 6d` — **`d >= 7` or the algebra
never runs at any n.** Item 572's fixture (400 nodes, degree 4) used the WHOLE graph as sources, so
copying it with a selective label produced a test that passed in 0.16s having never executed the
closed form. Third instance of item 570's trap. The test now recomputes the gate and asserts it.

### FIVE shapes of one branch, and two refuted mechanism stories (586)

The OUT path was not meant to change and costs 4-6%. Isolated probes, four alternated rounds each:

| shape                                          | ratio      |
| ---------------------------------------------- | ---------- |
| closure `\|v\| if inward { inc } else { out }` | 1.144x     |
| the same code through a `macro_rules!`         | 1.105x     |
| `const INWARD` + masks as generic params       | 1.113x     |
| `const INWARD` + masks as `&dyn Fn`            | 1.051x     |
| ... plus `#[inline(always)]` — KEPT            | **1.038x** |

**REFUTED:** (1) "the closure is opaque to the inliner" — the macro expansion changed nothing;
(2) "`&dyn Fn` is a virtual call per edge, so generics reach parity" — generics were WORSE, so the
`&dyn` shape is kept against the obvious reading of the code. The residual ~4% has NO identified
mechanism and sits in [[pull-alignment-is-load-bearing]]'s band. Net: 32ms saved on a 36ms query
against 0.15ms added to a 4ms one. **NOT TRIED:** duplicating the body so OUT is untouched source
— the only shape that could reach 1.000x, rejected because it means two copies of the trail
correction and the zero-length term.

## 587 — CLOSED: a WALK counts by LEVELS at any depth, native, 9.7-23.6x

The algebra was bounded at `max <= 2` by the TRAIL correction (one way to reuse an edge at two
hops, several at three). A WALK forbids nothing, so `u_j(v) = sum over traversals v -> y of
u_{j-1}(y)` with `u_0(v) = passes(v)` counts it in one pass per level, O(max * (V+E)). Specialized
to max = 2 it IS the closed form term for term.

**WALK is the GREMLIN mode** — `repeat()` lowers to `PathMode::Walk` — so this is the common Gremlin
shape, not a niche ISO spelling. 200,000 vertices / 600,000 edges, three alternated rounds:

|                                        | pristine                 | after              |                       |
| -------------------------------------- | ------------------------ | ------------------ | --------------------- |
| WALK `{1,3}` / `{3,3}` / `{0,3}`       | 38.87 / 38.47 / 39.66 ms | 3.97 / 3.47 / 4.10 | **9.7-11.1x**         |
| WALK `{1,4}` / `{4,4}`                 | 104.44 / 105.83          | 5.01 / 4.75        | **20.9-22.3x**        |
| `repeat(out()).times(3)` / `.times(4)` | 38.73 / 103.40           | 3.46 / 4.39        | **11.2x / 23.6x**     |
| depth 8, 2,000 vertices at degree 4    | 627                      | 1                  | **627x**              |
| TRAIL `{1,3}` — CONTROL, still refused | 49.15                    | 51.40              | 0.96x                 |
| depth-2 routes (3 readings) — CONTROLS |                          |                    | 0.97x / 1.01x / 1.03x |

`max <= 2` keeps the closed form BYTE FOR BYTE rather than being folded into the recurrence —
item 586 measured this engine's hot loops charging ~4% for being edited, and the three depth-2
control readings pointing opposite ways is what "no toll" looks like. **TRAIL past 2 stays refused**
and needs its own inclusion-exclusion over edge-reuse shapes.

### The optimizer fuzzer found an INDEX CRASH at 200k seeds, not at the default (587)

`DIAG src id 4294967295 >= u.len() 24` — `u32::MAX` is the NULL sentinel a Nodes column uses, and a
plan whose source slot holds a null node reaches the recurrence. The recurrence indexes `u[s]` per
source per level where the closed form only ever indexed by a NEIGHBOUR id (always real), which is
why the old route never tripped it. **Run the deep sweep, not just the default**, when a change adds
a new indexing pattern over node ids.

Guard mutants: dropping it is CAUGHT by `rewrite_fuzz` at 200k. Two others SURVIVE (ordering vs
`seed_fn`; the zero-length term) because the fuzzer's case had no seed predicate and `min = 1`, and
`OPTIONAL MATCH` feeding a var-length hop is `E_SYNTAX` so there is no surface repro. Kept as
explicitly DEFENSIVE — unlike item 583's dead guard, nothing proves them unreachable.

### A deep WALK count does not terminate, and did not before either (587, OPEN)

`WALK {1,45}` on 2,000 vertices at degree 4 timed out past 60s on BOTH builds, while depth 8
answered on both. A bare `count(*)` DFS-counts paths without materializing rows, so the trail ROW
cap never bounds it. The recurrence uses `checked_add` and falls through to that on overflow, which
is the pre-existing behaviour rather than a new one — the alternative, `wrapping_add`, is a wrong
answer that looks right. **Open: a counting DFS needs its own budget.**

### NEW TS TARGET, priced at 1495x (587)

`bun run bench`'s new `count var-length 1-3 hops [WALK]` reads **ts 8362.9ms against ffi 5.6** — TS
has no depth-3 rung and enumerates. Largest TS/native gap in the bench. The same level recurrence
fits `varLengthDegreeCount`, whose `degreeOf` memo is already its `u_1`.

## 588 — CLOSED: the TS twin of the level recurrence, 13.5-58.7x

Item 587's bench watcher priced the TS side of a depth-3 WALK count at **ts 8362.9ms against ffi
5.6** — TS refused `max > 2` outright and enumerated. Same recurrence now, and specialized to
max = 2 it IS `varLengthDegreeCount` term for term, so only `max >= 3` takes it.

| case                                  | pristine                       | after                 |                   |
| ------------------------------------- | ------------------------------ | --------------------- | ----------------- |
| WALK `{1,3}` / `{3,3}` / `{0,3}`      | 1210.23 / 1048.75 / 1201.42 ms | 60.67 / 54.40 / 44.24 | **19.3-27.2x**    |
| WALK `{1,4}`                          | 3715.81                        | 63.25                 | **58.7x**         |
| WALK `{1,3}` + end label / pred       | 1441.15 / 1327.16              | 97.08 / 69.16         | **14.8x / 19.2x** |
| bench watcher, 200k at degree 5       | 8362.9                         | 619.9                 | **13.5x**         |
| CONTROL TRAIL `{1,3}` — still refused | 1304.90                        | 1300.72               | 1.0x              |
| CONTROL depth-2 closed form, ISOLATED | 34.62                          | 34.60                 | 1.00x             |

A TRAIL is bounded at two in BOTH engines for the same reason, which is what keeps them on one
answer. 7560-query cross-engine sweep over depths 1-6 and five modes: 0 divergent.

### A surviving guard mutant that is NOT dead code (588)

`!spec.isTrail` in the dispatch survives mutation — the detector already refuses `max > 2` for
anything but a walk, and its closures are the only callers. Item 583 deleted a guard in that exact
position. **This one stays:** trail depth is a RECORDED OPEN TARGET, so the detector's bound will be
relaxed, and this is then the only line between a trail and the walk's arithmetic (32 against 28 on
the test fixture). Reachable-after-a-planned-change is a third category beside item 583's
provably-dead and item 587's reachability-unknown.

### Pin the VALUE, not just the engine agreement (588)

I pinned `{1,3}(y {n: 3})` as 10 by copying a neighbouring figure. The TS-vs-native assertion PASSED
— both engines answered 8 — and only the value assertion caught it. Comparing two engines proves
they agree, not that they are right.

### NEXT LEVER on this shape, priced (588, open)

TS is still 115x native here and it is the LAYOUT, not the algorithm: `Map<Vertex, number>` read
once per edge per level (~3.6M lookups at depth 3 on the bench fixture) against native's dense
`Vec<u64>`. Precomputing neighbour INDICES once — one pass of E map lookups into a CSR-like array,
then pure array math per level — prices at roughly a further 3x at depth 3, more as depth grows.

## 589 — CLOSED: the level route reads a flattened CSR, TS, 1.6-3.7x

Item 588 asserted `Map<Vertex, number>` was the remaining cost. **Measured first**, at 60,000
vertices / 180,000 edges: cost linear in depth at 23.83ms/level, of which `Map.get` per edge is
15.71; a CSR built once costs 18.28 and then **0.10ms per level**. The decisive row is that
resolving an index THROUGH a map costs the same 19.5ms — so the indices must be PRECOMPUTED, not
looked up.

| quantifier        | map (588)        | CSR (589)     |                         |
| ----------------- | ---------------- | ------------- | ----------------------- |
| `{1,3}` / `{3,3}` | 63.46 / 61.86 ms | 32.97 / 38.18 | **1.92x / 1.62x**       |
| `{1,4}` / `{1,6}` | 89.16 / 134.25   | 36.03 / 36.14 | **2.47x / 3.71x**       |
| `{1,2}` — CONTROL | 37.37            | 34.48         | 1.08x (noise floor ~8%) |

Now FLAT in depth. Bench watcher 619.9 -> 348.3 (1.78x); TS/native 115x -> 62.8x; **8362.9 -> 348.3
across 587-589, 24x**. `Float64Array` holds what the map held (a JS number IS an f64, same summation
order), so this is layout, not semantics.

### `Int32Array.from(push-built array)` cost 35ms of a 55ms build (589)

The first CSR read 58ms FLAT in depth where the per-level work is 0.3ms — the build was ~55ms, not
the ~20 the micro-benchmark implied, because a `number[]` with `push` then `Int32Array.from` pays
boxing, growth and a full copy. Preallocating to `graph.edgeCount` and filling in ONE pass is the
difference between 1.36x and 1.92x. A wanted-type filter can only keep FEWER edges than the graph
has, so that bound is safe.

### `{3,3}` measured cheaper than `{1,4}`, which is impossible (589)

All cases in one process: `{3,3}` 1.02x against `{1,4}` 2.90x. Depth 4 cannot cost less than depth
3 doing strictly more work — it was JIT warmup landing on whichever case ran first. One case per
process gave a coherent table. **Fourth tick running where a shared process lied**; when a ratio is
incoherent, suspect the harness before the engine.

### The coinciding fixture, eighth and ninth (589)

Two mutants survived, both because the fixture made a wrong formula right: the last-inserted vertex
(`iso`) has no out-edges, so a short final CSR offset drops nothing; and `:P` covers every vertex in
insertion order, so `srcIdx[i] = i` is accidentally correct. A second fixture whose last vertex has
out-edges and whose start label is not an insertion-order prefix catches both.

### A lint exemption with numbers attached (589)

`prefer-for-of` over the source-index array costs 0.97x at `{1,3}` and 0.92x at `{1,6}` — the
penalty scales with depth, so it is the iterator protocol per source per level. Kept as an index
loop behind `oxlint-disable-next-line`. I had written "within noise" into that comment BEFORE
measuring, in the direction that favoured my own change.

## 590 — CLOSED: a two-hop Gremlin count from every vertex is a degree inner product, 6.4-7.1x

`V().out().out().count()` read **ts 351.9ms against native 2.80 (125.8x)**, the largest gap in
`bun run bench:gremlin`. Item 574's `hopChainCount` already CLAIMED the shape — asking
`countShortcut` directly showed `exec ~ shortcut-only`, so the rung was running and **its arithmetic
was the cost**. There was no missing route to build.

Summing over all sources, `count = sum over w of arrivals(w) * departures(w)`, each factor the
degree on whichever side its hop traverses. One pass over vertices, no edge walk.

| case                                             | before             | after         |                       |
| ------------------------------------------------ | ------------------ | ------------- | --------------------- |
| `out/out`, `in/in`                               | 370.76 / 368.79 ms | 57.81 / 57.60 | **6.4x**              |
| `out/in`                                         | 325.38             | 45.64         | **7.13x**             |
| `repeat(out).times(2)`                           | 410.39             | 57.51         | **7.14x**             |
| one hop / three hops / `has`-filtered — CONTROLS |                    |               | 1.00x / 1.03x / 0.97x |

`bench:gremlin` ts/native 125.8x -> **20.3x**; `repeat().times(2)` 85.7x -> 15.3x.

### The attribution said the OBVIOUS fixes were worth nothing (590)

40,000 vertices / 200,000 edges: adjacency walk alone 9.14ms; per-edge target bucket lookup 61.80
(what it did); **per-edge `Map.get` on a memoized degree map 42.07 — only 1.5x**; building item
589's flattened CSR **37.65 to build, so no help at all**; the inner product with both degree passes
**7.73 (8.0x)**. I came in expecting to reapply 589's layout trick. Measuring the candidates first
is what found an algebraic answer instead of a 1.5x one.

**Self-loops and parallel edges need no special case**, which is what makes the identity exact: a
self-loop is one in-edge and one out-edge of the same vertex and contributes to both factors, just
as the walk visits it once in each role.

### Three of four direction pairs can coincide by accident (590)

The first cross-engine fixture read `out/out=130 in/in=130 out/in=192 in/out=130`. `out/out` and
`in/in` must ALWAYS agree (both are `sum(indeg*outdeg)`), but `in/out` matching them was fixture
luck, and a swapped degree side would have passed. Two hubs give 35 / 35 / 73 / 59, and the test
ASSERTS three distinct values. **Third application of item 586's rule: assert that the fixture can
witness the thing being tested.**

Mutants that needed new cases: both label-swap mutants survived because every case used the SAME
label on both hops (`out(T).out(U)`=0 vs `out(U).out(T)`=2 separates them), and defining
`unfiltered` as `!canSeed` survived because a `has` filter is not seedable and the test only had a
`hasLabel` one.

### Still open (590)

TS is 20.3x native on this shape (two bucket reads per vertex against native's dense arrays), and
THREE hops is untouched at 689.75ms — the identity does not generalize, because the middle frontier
is not a degree.

## 591 — CLOSED: read the vertex's own adjacency box, not a hash of its id, 1.26-1.31x

`V().out(T).has(k,pred).count()` was 34.6x native, the largest remaining ratio in
`bench:gremlin`. The vertex-driven inversion was already there (item 168) — what it did was reach
the adjacency through `edgesToByLabel.get(v.id)`, a map keyed on the id STRING, while
`startFilteredHopCount` three functions below has read `v.adjFrom` since it was written. **One rung
in the file had the lesson and its neighbour did not.**

| case                                             | id map          | box             |                       |
| ------------------------------------------------ | --------------- | --------------- | --------------------- |
| `out(T).has(age>44).count()`                     | 52.98 ms        | 41.92           | **1.26x**             |
| `in(T).has(...)` / `has(age>500)`                | 51.96 / 54.24   | 39.59 / 41.89   | **1.31x / 1.29x**     |
| `out(T).values(age)` / `in(T)`                   | 296.30 / 287.14 | 278.06 / 265.12 | **1.07x / 1.08x**     |
| three CONTROLS (incl. the untouched dedupe rung) |                 |                 | 1.00x / 1.00x / 1.01x |

`bench:gremlin`: `out().has().count()` 53.0 -> 42.2 (34.6x -> 27.6x), `out().values(age)` 307.6 ->
273.3 (9.8x -> 8.5x). `distinctHopCount` is left alone deliberately — it iterates the index's
VALUES with no vertex object in hand, so there is no box to read.

### A micro-benchmark over-promised by 1.4x, on the function whose comment warns about it (591)

The probe measured `get(v.id)` + predicate at 32.86ms against `v.adjTo` + predicate at 18.29
(**1.80x**); the real change is **1.26x**. The probe inlined `byType.get(label)?.size` and the
comparison where the shipped code calls `degreeOfTypes` and `matches` — helpers that dominate.
`hop-values.ts` carries this warning verbatim ("over-promised by 1.5x —
harness-must-resemble-caller, again") and I read it while making the change and repeated it anyway.
**The attribution is still what ruled out the algorithm; the RATIO from a probe that skips the
callees is not the ratio you ship.**

### A dedupe control's 0.93x was noise, but it was worth isolating (591)

7% on a rung I did not touch — in a file I DID edit, so layout could plausibly shift it. Five
isolated alternated rounds: 7.01 against 6.97, after winning four of five.

### The coinciding fixture, tenth instance (591)

`hop-values` always reading `adjFrom` is correct for `out`, wrong for `in` — and
`in_('E').values('age')` expects `[10, 10]`, which the mutant ALSO produces: correct, `b` and `c`
are each reached from `a` (age 10); mutated, `a`'s two out-edges each yield `a`'s own age. A fixture
where `a` has an in-neighbour of a different age gives `[40, 10, 10]` against `[10, 10, 40]`, and
the test now asserts out and in DIFFER.

### Still open (591)

The same id-keyed pattern survives at **12 sites in `packages/gql/src/executor/hop-projection.ts`
and one in `executor.ts`** — each needs its own check that a vertex object is in hand, and its own
measurement. `out().has().count()` is still 27.6x native: `degreeOfTypes` plus `matches` per vertex,
~18ms of the remaining 42.

## 592 — CLOSED: the adjacency box at 14 GQL sites, 1.2-1.4x

Item 591 surveyed and left these; all 14 have a vertex object in hand and went through
`index.get(v.id)` (a STRING-keyed map) instead of the vertex's own `adjFrom`/`adjTo`.

**Item 159's warning does NOT forbid this, and reading it correctly is the justification.** It
measured a branch in the INNER (per-EDGE) loop at 1.6x; these lookups are in the OUTER (per-VERTEX)
loop, which is item 591's shape exactly. `distinctHopCount` stays excluded for the real reason: no
vertex object at all.

| case                         | id map       | box         | ratio by run               |
| ---------------------------- | ------------ | ----------- | -------------------------- |
| far-label projection         | 27.6-33.1 ms | 16.6-21.2   | 1.42 / 1.53 / 1.69 / 1.78x |
| reversed projection          | 68.1-74.7    | 47.6-51.1   | 1.40 / 1.43 / 1.46 / 1.46x |
| edge-variable projection     | 172.6-203.4  | 143.4-152.9 | 1.20 / 1.26 / 1.33 / 1.39x |
| plain one-hop projection     | 98.4-113.7   | 76.2-93.2   | 1.21 / 1.22 / 1.25 / 1.34x |
| one-hop `count(*)` — CONTROL | 0.01         | 0.01        | 1.00x every run            |

`bun run bench`: `traverse 1-hop project` 128.7 -> 105.9, `distinct over a hop` 62.0 -> 46.3,
`1-hop project + start filter` 111.8 -> 102.4; the COUNT-shortcut hop rows flat. **14 per-site
mutants, 0 survivors** — the suite already reached every walk.

**Correctness for a layout change: 321 queries byte-identical ORDERED against the previous build**,
so the box yields the same `Set` with the same iteration order. Against native they match as
MULTISETS; they do not match ordered, and that is correct — GQL row order without `ORDER BY` is
unspecified ([[order-is-unspecified]]). My first sweep compared ordered and reported 19 FALSE
divergences.

### Four harness faults, and the rules they earn (592)

1. **The side ORDER was a hidden variable:** `pristine, after` every round meant `after` always ran
   second. Alternate the order per round.
2. **A control that materializes 200,000 rows is not a control.** A no-hop projection read 1.10x,
   1.51x, then **0.58x** on code the change cannot reach — GC-dominated, swinging 5.91-13.62ms.
   This machine's drift on medium-weight TS queries is up to **±50%**, so report RANGES across runs
   and lean on reproducibility, not one min-of-min. The only steady control was a sub-ms count
   shortcut at 1.00x every run.
3. **zsh does NOT word-split an unquoted variable.** `for side in $order` with `order="a b"` ran
   once with a two-word value, the `cp` failed silently, and the run printed plausible numbers that
   measured nothing. A/B drivers are Python now.
4. **Save the AFTER copy in the same breath as the edit.** A `cp` of the pristine copy over the
   working tree, before the after copy existed, lost the whole rewrite — `git diff --stat` empty.
   The mutation rule ("restore before the next mutant") has an A/B twin.

## 593 — REFUTED x3: the native projection row, the Gremlin/GQL projection gap, and the per-vertex hoist

Nothing ships but a recorded refutation. Three candidates, three refusals.

**1. `query: project 3 columns` (native 7x slower than TS) was CLOSED at item 289.** `perrow` gives
the engine side as ~3ms (string 1.42 + scalar 0.485 over 200,000 rows) against 60.5 through FFI, and
`graph.ts` already decomposes it: **48% `JSON.parse`, 33% the crate's render plus the FFI call, 12%
row shaping** — "that 7.3x is the JSON CARRIER, not execution... read `queryArrowIpc`, not the
engine". **What misled me: `percall_probe` says the boundary is "innocent: a `vertexCount` round
trip is 8ns". That is a SCALAR round trip and says nothing about 200,000 rows.**

**2. Native Gremlin `values()` is NOT slower than native GQL projection.** `query_bench -- gremlin`
`values` 1350us against `perrow` `scalar p.age` 485us looked like 2.8x in one engine. But the
Gremlin case is `g.V().values('name').count()` — ONE row out — against a 200,000-row projection,
and a STRING column against a NUMBER (7.1 vs 2.4 ns/row). Normalized it is 6.75 ns/row against 7.1
**while building no rows**. Two fixture mismatches at once; either alone invents the gap.

**3. Hoisting `degreeOfTypes`/`matches`/`filter.*` out of `filteredHopCount`'s per-vertex loop:
1.01 / 1.04 / 1.01 / 1.05x** over four alternated rounds with five controls at 1.00-1.01x. Inside
the noise floor. Reverted with the numbers beside the loop.

### A micro-probe can LOCATE a cost and must not be used to SIZE one (593)

The estimate that sent me at #3: item 591's probe measured an inlined equivalent of the loop at
18.29ms, the row is 42.2ms, so the skipped calls "cost ~24ms". The A/B says ~1-5%. The 24ms is not
in the loop body — the probe is not that code. **Second tick running** that a probe mispriced a
ratio (591's own over-promised 1.80x against a real 1.26x; `hop-values.ts` has carried the warning
since item 170). Item 589's attribution was still decisive for RULING OUT candidates — every ratio
that shipped came from an A/B of the real code.

### The 27.6x row is a layout ceiling, not an open lever (593)

Without an index on the key, every vertex with a matching edge must be tested, and `seedForStep`
already hands the indexed case to the index path — the ORDER is optimal. What remains is a JS
property read plus a predicate dispatch per vertex against native's columnar read: item 566's
ceiling. Recorded so it stops reading as open.

## 594 — ANSWERED: the two-hop `COUNT { }` subquery is a string-keyed lookup per first-hop edge

`query: 2-hop subquery item` is ts 113.5ms against native 6.5 (17.5x) where the one-hop sibling is
6.4x. `degreeCountSubquery`'s own type flagged the gap — "the two-hop side still resolves
mid-vertices by id, which is a different question" — and after items 591/592 it looked like the next
instance of the id-keyed lever.

**It is unreachable, and `Edge` is why: it stores endpoint IDS, and `e.to` is a GETTER calling
`getVertexById`.** No vertex object is in hand at a first-hop landing, so reading "the box" pays the
lookup it would avoid. `twoHopSide`'s unlabelled branch already said so; its labelled branch records
the box read tried and MEASURED FLAT.

**So the 591/592 lever's boundary is sharp: it applies only where a VERTEX OBJECT is already in
hand.** `distinctHopCount` is out because it iterates the index's values; this is out because edges
hold ids.

Measured at 200,000 vertices, degree 5, varying only the anchor set:

| shape                                    | ms                              | first-hop edges     | ns/edge               |
| ---------------------------------------- | ------------------------------- | ------------------- | --------------------- |
| 2-hop, all anchors / ~2/3 / ~1/3 / ~1/10 | 206.97 / 149.20 / 81.66 / 35.80 | 1,000,000 → 100,000 | 207 / 228 / 253 / 358 |
| 1-hop, all anchors                       | 32.64                           | 1,000,000 counted   | **33**                |
| 2-hop, LABELLED middle                   | 138.11                          | 322,220             | 429                   |

Linear in first-hop edges; the **~174 ns/edge** the two-hop pays over the one-hop is item 194's
**~190 ns** string-keyed `Map.get`, reached from a second direction.

**The memo is NOT the fix** (recorded so the 5x revisit count does not tempt anyone): each mid is
visited ~5 times, but a `Map<string, number>` get costs the same ~190 ns as the adjacency get it
replaces, so it saves only the inner per-type read — ~24 ms of 207, under the noise floor.

**The fix is dense vertex indices in the core graph instead of string ids** — the same conclusion
item 289 reached about the JSON carrier from the other end. Architectural, not a rung.

## 595 — CLOSED: cache the edge's resolved ENDPOINTS, 2.4-2.6x

Item 594 found the boundary of items 591/592: an `Edge` stores endpoint IDS, so `e.to` is a getter
calling `getVertexById` (~190ns), and the hot executors resolve an endpoint from an edge at **56
sites**. Caching the resolution on the edge:

| case                                                | before         | after          |               |
| --------------------------------------------------- | -------------- | -------------- | ------------- |
| two-column hop projection                           | 193.70 ms      | 73.24          | **2.64x**     |
| Gremlin `out(K).values(age)`                        | 121.76         | 48.08          | **2.53x**     |
| hop projection + far filter                         | 144.24         | 60.52          | **2.38x**     |
| labelled-middle `COUNT { }` / one-column projection | 127.88 / 71.59 | 104.89 / 62.06 | 1.22x / 1.15x |
| two CONTROLS (no endpoint read)                     |                |                | 0.98x / 1.10x |

Benches agree: `traverse 1-hop project + start filter` 102.4 -> **68.4**, `V().out().values(age)`
273.3 -> **167.7** (ts/native 8.5x -> 5.6x), `2-hop subquery item` 113.5 -> 95.7, ingest flat (it
uses `fromId`/`toId`, item 140). Cost: two references per edge, ~16MB per 1,000,000 edges, and only
for edges whose endpoints are read.

**A cached REFERENCE is a stronger claim than `#box`'s** (a box is a container mutated in place and
cannot go stale). Four paths make it safe: `addVertex` on an existing id RETURNS the existing vertex;
`removeVertex` cascades to incident edges; a rollback re-adds vertex-then-edges as fresh objects;
`set graph` drops the cache.

### THREE REPS INVENTED TWO REGRESSIONS; a NULL CONTROL proved it was the harness (595)

At min-of-3 the one-column projection read **0.82x** and a no-edge control **0.77x**. Both dissolved
at nine reps (1.15x, 0.98x). The deciding instrument was two fields added to `Edge` and **never read
or written** — pure object growth, zero caching: it read **1.40x FASTER** on a node-only projection
and 1.17x faster on another, speedups a dead field cannot cause. That established the swing as the
harness rather than object size or the cache.

**Rule: nine reps on any allocation-heavy row.** Item 592 hit the same failure (a control reading
1.10x, 1.51x, then 0.58x) and replaced the control; raising reps is the better fix, and a null
control is what tells you which it is.

### A mutant found the hazard the soundness argument turns on (595)

Deleting the invalidation from `set graph` **SURVIVED all 4,671 tests across 347 files** — nothing
moved an edge between graphs and then read its endpoints.
`packages/core/src/core/edge-endpoint-cache.test.ts` pins it: populate the cache against one graph,
move the edge to a second graph holding DIFFERENT vertex objects under the SAME ids, assert the new
graph's objects come back. **An id-level assertion would pass against the stale objects** — the test
must read a property.

### The parse cache refused every parameterized INSERT — FIXED (596)

`bench:usage`'s `write: append node [params]` was losing 23% to its interpolated twin (280.4k vs
363.4k op/s) because `parse_cache` refused the text: prepared mode planned `InsertFrom` where the
direct path planned the literal `Insert`, so the admission check never matched and every call
re-parsed and then paid parameter marshalling. Item 318 recorded that divergence as benign and it
was — for correctness. `bind::bind_plan` now re-applies `ir::lower_insert_literal` once the params
are bound. **280.4k -> 326.5k, 1.16x** over three alternated rounds, with all thirteen read and
non-parameterized rows (controls the change cannot reach) at 0.96x-1.02x.

**The fix belongs in `bind`, not `opt`.** The admission check compares UNOPTIMIZED plans, so an
equivalent rewrite in the optimizer runs too late to be seen. `prepared_parity_probe` (which
compares OPTIMIZED plans) reported "SAME plan" while `stats().refused` was still 1 — read the
cache's own counter, not the probe.

**A `Plan::Row` guard mutant survived twice and the reason reclassifies the guard.** Dropping it
would collapse a `MATCH … INSERT` to one insert instead of one per row — but the admission check
compares against the UNBOUND direct parse, so the divergence makes the text REFUSED rather than
mis-planned. The rows stay right; the cache slot is what is lost. **The guard is a perf guard whose
correctness backstop is the admission check**, and a test can only observe it through `stats()`.

**Rule: a surviving guard mutant is a question about what is OBSERVABLE, not only about
reachability.** Reachability was checked twice here (fixture shape, then a plan dump) and was fine
both times; the assertion was comparing two values the mutant moves together.

### "FFI dominates a small op" was the WRONG attribution — the native wrapper was, 1.1-1.32x (597)

Item 319 priced native's loss to pure TS on `bench:usage` serving rows as the FFI boundary. The raw
boundary is **11ns**; the call is 2328ns. Decomposed by stage instead (`compileGql` ->
`backend.queryRows` -> `decodeRows`), ~300ns was JS wrapper work on EVERY call and the 847ns
backend floor was mostly not the boundary either. Two levers:

- **Read the JSON carrier with a bun:ffi `CString`** instead of `toArrayBuffer` + `.slice()` +
  `TextDecoder.decode`: **381.6ns -> 132.8** on a one-row carrier (`toArrayBuffer` alone is
  109.5ns), and it helps a 3.4KB carrier too. `EngineAbi.queryText` is optional; wasm takes the
  byte fallback. **The explicit length is load-bearing** — the crate's buffer is NOT
  NUL-terminated.
- **`stringifyParams`' `JSON.stringify` replacer was UNREACHABLE** and cost 181.2ns against 58.7,
  because a replacer puts the whole serialization on its slow path. `assertParamModel` already
  rejects every bigint that can reach it (and `temporal.ts` contains the token `bigint` zero
  times).

`bench:usage`: 1.1x-1.32x on fifteen rows, with `100 updates in one statement` at 1.04x inside the
floor and not claimed — it is the only row making one FFI call per ~100 counted ops, so a per-call
constant is amortized there. **Cheapest calls gain most**, which is what a per-call constant
predicts.

**When EVERY row moves, the control is the whole measurement — and the first run threw it away.**
The change is native-wrapper-only, so the `ts` column is a control it cannot reach, in the same
processes and rounds. The driver first recorded `ts` as one max across BOTH sides, which cannot
answer whether TS moved too; a uniform gain is then indistinguishable from machine drift. Per side:
ts 0.95x-1.08x centred on 1.01x against the engine's 1.04x-1.32x. That spread also prices this
bench's floor at ~±6%.

**A capability check is a route choice, so it needs the route-choice treatment.** A mutant making
`queryJson` always take the byte fallback is answer-equivalent and SURVIVED all 925 tests. There is
no arithmetic to extract as a pure fn ([[perf-gate-needs-its-own-test]]'s usual remedy), so the
test observes WHICH ROUTE RAN — `buildEngineBackend` over a fake `EngineAbi` that counts calls.
Then CAUGHT.

### The 479ns parameter cost on a serving call — RETRACTED as a target (598)

Item 597 left `backend.queryRows` with one parameter at 1760ns against 1281 without. It decomposes
into five pieces, none above `bench:usage`'s floor: ~130ns JS object + `JSON.stringify`, 67ns
`ndjson::parse_json`, ~60ns `params_from_obj`, ~20ns `encoder.encode`, ~30ns `bind_params`' lookup
table. The remainder is bun:ffi's per-ARGUMENT marshalling (`lnk_query` takes eight arguments;
`vertexCount` takes one), which item 292 already recorded as needing a profiler, not another probe.

**The obvious adjacent lever is ALSO already closed.** `optimize_indexed` runs on every serving call
(~350ns) and TS has had a plan cache since 229 — but item 293 refuted a native one: `bind_params`
runs BEFORE `optimize_indexed`, so an optimized plan has that call's parameter values baked in, and
a `(text, store-version)` key would serve STALE VALUES. A wrong answer, not a slow one.

### `bind_params` built a per-call HashMap — TAKEN, ~30ns, and the bench cannot see it

A heap allocation plus SipHash-1-3 per parameter, for one lookup site. Swept both axes in
`examples/bind_probe.rs`: **no crossover up to 32 params x 16 occurrences** (526.8 -> 153.1ns),
because the map's BUILD cost dominates (386.7ns at 32 params before any lookup). The realistic
shape, one param used once, is **32.2 -> 2.0ns**; `percall_probe`'s `clone + bind_params` row
confirms **147 -> 119** on the real function.

**When the control's spread EXCEEDS the effect, the bench is not an instrument for it.** ~30ns is
~1.5% of a serving call against a ~±6% floor. The three-round run was a REGRESSION check (engine
0.96x-1.08x, worst 0.96x) and in that same run the ts control — untouchable by a Rust change —
spanned 0.82x-1.16x, wider than the engine column. No bench row claimed.

**`.rev()` is load-bearing: a repeated parameter name is LAST-WINS.** `HashMap::collect` gave that
for free; a forward scan is FIRST-wins — same rows, different value. Reachable through the ABI
(`lnk_query` takes params as a raw JSON string and `Json::Obj` is a `Vec` whose parser pushes),
though not through `g.query(text, obj)`. Matches item 333's convention for any repeated JSON key.

**A one-parameter fixture cannot witness a name-blind lookup.** `find(|_| true)` — ignoring the
name entirely — SURVIVED all 1,177 tests, because every bind test supplied one parameter or two
interchangeable ones. Closed by two params whose values are deliberately not interchangeable. Same
shape as item 586's total count that could not witness a direction bug.

### The native serving residual — CLOSED as DIFFUSE, after three refuted attributions (599)

Open since item 291 ("native loses 3-5x to pure TS on every serving row"), with a different
explanation each time it was touched. All three were drawn by SUBTRACTING TWO LARGER MEASUREMENTS:

- **291, the FFI boundary.** Measured across arities through one dlopen: `lnk_abi_version` (0 args)
  **3.7ns**, `lnk_stat` (2 args) 6.5, `lnk_free(null,0)` 12.0.
- **292, per-ARGUMENT marshalling** ("needs a profiler, not another probe"). The slope is ~0-2ns an
  argument and **the 3-arg symbol is FASTER than the 2-arg one** — noise, not a slope.
  `lnk_query`'s 8 args are ~1ns, not ~600.
- **599's own first pass, ~290ns of "wrapper layering".** Subtracted a BYTE-route figure from a
  TEXT-route one. On the matching pair (`backend.queryJson` 614.5 vs the same work inlined 547.6)
  the wrapper is **67ns**.
- **And `optimize_indexed` is ~90-95ns, not ~350** — that came from `parse+optimize` minus `parse`,
  which was capturing the parse's allocation pressure. (The lever was already refuted at 293 on
  correctness grounds; it was never worth 350 either.)

**What is left is diffuse: a trivial call is 614ns, a point lookup ~1280, across a dozen items of
30-150ns with no dominant term** — warm cache hit 145, optimizer ~90, render ~50, JS wrapper 67,
raw call + decode ~160, exec 313 for one row. Going further needs the architectural change items
289 and 594 both independently arrived at (dense vertex indices instead of string ids), not another
rung.

**RULE: do not size a cost by subtracting two larger measurements.** Every wrong number in this
thread came from that, and each time the direct measurement was 3-5x smaller. Companion to item
593's "a micro-probe can LOCATE a cost and must not SIZE one" — a subtraction cannot size one
either. When the quantity you want is a small difference between two large numbers, the difference
is mostly their noise.

### A TRAIL past two hops has a closed form — OPEN TARGET, verified, worth ~30x native / ~70x TS (600)

`count 3-hop` is recorded as a CSR ceiling (489). That is true of the row it names — a FIXED
three-segment chain — and the QUANTIFIED spelling beside it is a different operator with a cliff in
**both** engines:

| spelling               | TS          | native    |
| ---------------------- | ----------- | --------- |
| chain 3-hop (a WALK)   | 10.91 ms    | 0.42      |
| `-[:K]->{3}` (a TRAIL) | **1071.55** | **15.81** |
| `-[:K]->{4}`           | 5765.28     | 80.96     |

The spellings are NOT equivalent — a quantified path is a TRAIL (2,499,936) and a chain is a WALK
(2,500,000) — and **both engines agree on every spelling**, so this is perf, not a divergence.

**The inclusion-exclusion `shortcuts.ts` asks for exists at depth 3 and is O(V+E):**

```
trail3 = walk3 - Σ_{self-loop at a} outdeg(a) - Σ_{self-loop at a} indeg(a)
               - Σ_{e: a->b} |edges b->a| + 2*|self-loops|
```

`walk3` is the level recurrence both engines already have (589 / 587). **Validated two ways:** exact
on the 20,000-vertex fixture (2,500,000 - 20 - 20 - 32 + 8 = 2,499,936, which both engines answer),
and brute-forced against triple enumeration over **400 random graphs admitting self-loops and
parallel edges — 400/400 agree.** Parallel edges are what break a naive version and it survives
them.

**Do not "fix the dispatch".** I came expecting TS's `walkLevelCount` to be missing from the fixed
chain; the chain is the FAST spelling in both engines. Pointing a WALK recurrence at a TRAIL answers
2,500,000 for 2,499,936 — a wrong answer no timing would reveal. **Print the answers beside the
times.**

Depth 4 is measurement only; its terms are not derived.

## 600b — CORRECTION to 600's cost model: the win is ~AVERAGE DEGREE, not unbounded

Item 600 landed the trail-3 closed form with the claim that "every term is O(V+E)" and estimated
"~30x native / ~70x TS". The formula is right — 400/400 against brute force stands — and **the cost
model was wrong**. Correcting it before anything is built on it.

### Which term breaks it

Per source `s`, the four corrections are:

| term   | per-source form            | cost                                |
| ------ | -------------------------- | ----------------------------------- |
| `c01`  | `selfloops(s) * outdeg(s)` | O(V), given an O(E) self-loop tally |
| `c12`  | `Σ_{e: s->b} selfloops(b)` | O(E)                                |
| `c012` | `selfloops(s)`             | O(V)                                |
| `c02`  | `Σ_{e: s->b} m(b, s)`      | **NOT O(V+E) as written**           |

`c02` needs the multiplicity of an ORDERED PAIR, `m(b, s)`, for each edge. `Store`'s adjacency is
in EDGE-INSERTION ORDER — `rebuild_csr` does `csr_out.extend_from_slice(adj)` with no sort — so
there is no binary search to reach for. Probing `b`'s adjacency per edge costs
`Σ_{e: s->b} deg(b)`, which is the **2-WALK COUNT**, not O(V+E).

### So the win is the average degree

With enumeration at `V * deg^3` and the shortcut at `V * deg^2`, the ratio is **`deg`** — not
unbounded. Grounded in item 600's own measurements on the 20,000-vertex degree-5 fixture
(2,500,000 three-walks, 500,000 two-walks):

| engine | enumerates | per path | shortcut's ~500k probes | estimated   |
| ------ | ---------- | -------- | ----------------------- | ----------- |
| native | 15.81 ms   | ~6.3 ns  | ~2-4 ms                 | **~4-6x**   |
| TS     | 1071.55 ms | ~428 ns  | ~25-40 ms               | **~27-43x** |

**TS wins an order of magnitude more than native, and for a reason worth keeping:** its per-path
constant is ~68x its per-probe constant, where native's two constants are close. A shortcut that
trades paths for probes pays off in proportion to how bad the interpreter's per-path cost is. So
this is primarily a TS lever that native also benefits from — the opposite of the usual direction
here, where native gets the algebra first.

It IS recoverable to O(V+E) by radix-sorting each adjacency segment by neighbour (two counting
passes over E, then a binary search per edge), but that is an auxiliary O(E) structure and its own
decision — not something to assume while estimating.

### Why this correction exists at all

Item 599 closed with the rule "do not size a cost by subtracting two larger measurements". This is
the same failure in the other currency: **I asserted a COMPLEXITY instead of measuring a cost.**
"Each case collapses to something countable in O(V+E)" was true of three terms and I generalized it
to the fourth without checking what the fourth needs from the data structure. The estimate that
followed was off by ~6x on native.

**Rule: a complexity claim about a graph algorithm is a claim about the ADJACENCY REPRESENTATION.**
Check what the representation actually offers — sorted? indexed? multiplicity-addressable? — before
costing a term that needs a lookup.

### The depth-3 TRAIL correction, TS — DONE, 40.79x on the DEFAULT spelling (601)

Item 600's formula, built in TS. **`count 3-hop quantified [TRAIL, the default]` 7342.9ms ->
180.0, 40.79x**, and TS goes from 45.9x slower than native on that row to **1.13x**.

**Nothing was watching it.** `parsePathMode` returns `trail` with no mode keyword, so
`-[:KNOWS]->{3}` is a TRAIL; the bench carried only `MATCH WALK … {1,3}`, whose own comment calls
it "the watcher for that route". It watched the route it names. A fixed-depth row for the default
spelling is now in `bench.ts`.

**The control is the `ffi` column at 1.00x on EVERY row** (0.97-1.02x), including the new one
(159.9 -> 159.7): native still enumerates the trail so it cannot move, measured in the same
process, fixture and rounds. Other TS rows 0.96x-1.08x.

**A survivor that was a REACHABILITY question, twice.** T10 (dispatch guard `spec.max === 3` ->
`>= 3`) survived, I added a depth-4 test for it, and it survived THAT too —
`detectVarLengthCount` already refuses `max > 3` for a non-walk, so the dispatch guard is a second
line of defence. The ACTIVE guard is the detector bound: mutating it (T11/T12) is CAUGHT. **The
codebase documents this exact precedent one clause over** (`!spec.isTrail`, "UNREACHABLE TODAY and
kept deliberately"). Check reachability BEFORE writing a test for a survivor.

Eleven of twelve mutants caught. T4 — `e0 == e2` as a boolean instead of a count — is what parallel
edges exist for. The test brute-forces over randomized graphs AND asserts its generator produced
self-loops, parallel edges and reverse edges (>20 trials each); the depth-4 test asserts the trail
and walk answers actually differ (>20 of 120), or its assertion could not distinguish a wrong
answer.

**Native remains OPEN at ~4-8x** (159.9ms on this row against 4.8 for the chain) — its per-path and
per-probe constants are close where TS's differ ~68x, so it is its own item on its own evidence.

### The depth-3 TRAIL correction, RUST — DONE, 11.45x. Both engines now. (602)

`count 3-hop quantified [TRAIL, the default]` **ffi 159.2ms -> 13.9**. With item 601's TS side
(7342.9 -> 185.4), the default spelling of a bounded three-hop count is finally on a rung in both
engines. **The TS column is the control at 0.96x-1.07x** (the trail row itself 0.99x) — between
601 and 602 each engine served as the other's control on the same row.

**Item 600b's estimate was CONSERVATIVE: ~4-8x predicted, 11.45x measured.** It multiplied an
assumed ns-per-probe by the 2-walk count; the probe is cheaper than assumed and only runs for
landings that PASS the endpoint test. An estimate from an assumed constant is worse than a
measurement — same lesson as 599/600b, in the direction that does not look like a mistake.

**THE ORACLE CHANGED — this item costs independence.** While native enumerated, the seven
byte-identity fuzzers checked TS's formula against a DIFFERENT implementation for free. Both
engines now run the same formula, so they prove only that the two AGREE and would pass on a shared
wrong answer. What replaces it: `fastpath_fuzz` (expected aggregate from MATERIALIZED rows, oracle
shares no code), 601's TS brute-force test, and mutants on both sides.

**`fastpath_fuzz` WAS BLIND TO DEPTH 4.** A mutant relaxing the gate to `max >= 3 && is_trail` — so
a depth-4 trail takes the uncorrected recurrence and gets the WALK count — survived, because
`gen_shape` capped `max` at 3 and **never generated depth 4 at all**. Reachability was checked
first (601 paid to learn that order); the gate IS the active guard. `max_cap` is now 4 wherever the
materialized side can afford it (40 nodes x degree 4 = 10,240 rows). Then CAUGHT. **The corpus was
blind to the boundary of the correction it exists to police** — the same failure its own header
documents for another branch.

The chain spelling (a WALK) is still faster in native, 4.8ms against 13.9, which the cost model
predicts: the `e0 == e2` term costs the TWO-WALK count, so a trail is ~avg-degree dearer than a
walk at the same depth. **Depth 4 remains unbuilt in both engines, and the fuzzer can now see it.**

## 603 — item 378's "a second slot leaves the shortcut" is WRONG, and the real gate is 56.51x

Three measurements, no code. Item 378 recorded a target and both halves of it turn out to be
mis-stated; the thing underneath is bigger and has a different cause.

### The stale number, and the wrong mechanism

> Second data point on the same generic path: `RETURN a.k, b.k` is 131 ms against the one-column
> 14.7 ms, because a second slot also leaves the shortcut.

Measured today, 200,000 vertices at degree 1, min of five, under the cgroup cap:

| query                                  | ts ms | native | ratio |
| -------------------------------------- | ----- | ------ | ----- |
| one slot, one column                   | 8.2   | 17.8   | 0.46x |
| hop, near column only                  | 40.0  | 24.7   | 1.62x |
| hop, far column only                   | 41.3  | 17.7   | 2.33x |
| **hop, TWO SLOTS** (`RETURN a.k, b.k`) | 45.2  | 27.1   | 1.67x |
| hop, two cols from the near slot       | 26.7  | 24.3   | 1.10x |

**The 131 ms does not reproduce — it is 45.2** — and at degree 5 (1,000,000 rows) TS BEATS native
on five of eight projection shapes, two slots included (136.6 against 152.6).

**And the mechanism was wrong.** `detectHopProjection` admits all three variables — its own checks
read `name !== farVar && name !== startVar && name !== relVar` — so a second slot does NOT leave
the shortcut. The measurement agrees: two slots is 1.16x near-only, which is one more property read
on the same route, not a fall to a generic path. `detectNodeProjection` declines on
`pattern.segments.length !== 0`, i.e. on ANY hop, which is probably what was read as "a second
slot".

### What actually leaves the shortcut, and what it costs

| query                               | ts ms     | native  | ratio      |
| ----------------------------------- | --------- | ------- | ---------- |
| hop, two slots, no order (shortcut) | 45.2      | 27.1    | 1.67x      |
| **+ `ORDER BY x`** (generic path)   | **453.7** | 35.1    | 12.92x     |
| **+ `SKIP 1`** (generic path)       | **245.3** | 27.8    | 8.82x      |
| **+ `ORDER BY x LIMIT 5`** (top-k)  | **164.3** | **2.9** | **56.51x** |
| the same, ONE SLOT                  | 40.5      | 2.3     | 17.99x     |

**The LIMIT 5 row is the one that matters, because it separates two costs that the bare `ORDER BY`
row conflates.** With a small `LIMIT` the top-k heap replaces the full sort (item 425), so the
sort is gone — and TS still pays 164.3 ms where the unordered shortcut pays 45.2. That residual
~119 ms is the per-row `Binding` on the generic path, which is item 377's cause, correctly
identified. Native does the whole thing in 2.9 ms.

### Why the recorded "DO NOT widen the gate" warning does not cover this

Item 378 warned, correctly, that admitting `limit` into the shortcut would be a 500x regression:
the shortcut returns `Row[]` and materializes, so `LIMIT 10` goes from 0.03 ms to ~15. **That
argument is about LIMIT ALONE, where laziness is the whole win.** With an `ORDER BY` present there
is no laziness to lose — you cannot find the top k without seeing every row, so the query
materializes either way. `ORDER BY` is lumped into the same gate as `skip`/`limit` and has the
opposite property.

### Sizing it HONESTLY, which is where 600b's lesson applies

The achievable win is bounded below by the unordered shortcut plus a top-k over the same keys, so
roughly **164.3 -> ~50 ms, about 3.3x — NOT 56x.** The 56.51x is the TS/native ratio and most of it
is item 566's layout ceiling, which no route change reaches. Recording the bound now, because
item 600b's estimate went wrong in exactly this way: quoting the cross-engine ratio as if it were
the prize.

### Gates

Measurement-and-docs only. `bunx oxfmt --check .` uncached clean. CI green on 602.

**A probe over a generated fixture needs the cap.** The first run of this probe included
`MATCH (a:P), (b:P)` — a 200,000 x 200,000 cross product — and I ran it WITHOUT the cgroup cap.
Bun aborted at 2.9 GB rather than taking the box down, so the only cost was the run, but
[[dogfood-sim-resource-limits]] says exactly this and I did not follow it. The case bought nothing
either: `ORDER BY` and `SKIP` already force the generic path.

## 604 — admitting `ORDER BY` into the projection shortcut: three constraints, all MEASURED

Item 603 located the gate and sized the prize. This derives the admission rule before building it,
because every one of the three constraints below is a place where a wrong rule returns a plausible
answer — or a correct answer with the wrong EXCEPTION behaviour, which no timing shows.

### The prize, bounded against the right reference

| query (200,000 vertices, degree 1)              | ts ms | native | ratio  |
| ----------------------------------------------- | ----- | ------ | ------ |
| hop, one item, NO order (the reference)         | 44.5  | 19.0   | 2.34x  |
| hop, one item, `ORDER BY x LIMIT 5`             | 173.0 | 2.6    | 66.31x |
| hop, one item, `ORDER BY x` (full sort)         | 485.9 | 28.2   | 17.23x |
| node, one item, NO order                        | 7.0   | 17.8   | 0.39x  |
| node, one item, `ORDER BY x LIMIT 5`            | 43.3  | 2.3    | 18.81x |
| hop, TWO items, `ORDER BY` the first, `LIMIT 5` | 157.0 | 3.1    | 51.25x |

The reference is the UNORDERED shortcut on the same shape, not native: a route change can reach the
sort's cost and the per-row `Binding`, and cannot reach item 566's layout ceiling. So the honest
bound is 173.0 -> ~(44.5 + a sort or a top-k), and the full-sort row (485.9) is the larger prize of
the two.

### Constraint 1 — RAISE PARITY, and it decides the whole rule

The ordered general path keeps top-k INPUT bindings and projects only survivors (item 145), so a
shortcut that projects every row then sorts can fault where the query does not. Measured on a
three-vertex fixture whose middle row cannot cast, **both engines agreeing on every case**:

| query                                 | result            |
| ------------------------------------- | ----------------- |
| `RETURN CAST(a.s AS INTEGER) AS x`    | RAISES            |
| `… AS x ORDER BY x LIMIT 1`           | **RAISES**        |
| `… AS x, a.n AS k ORDER BY k LIMIT 1` | **ok, returns 1** |
| `… AS x SKIP 1 LIMIT 1` (no order)    | RAISES            |
| the same two over a HOP               | RAISES / ok       |
| `… AS x ORDER BY x LIMIT 0`           | **ok, `[]`**      |

Row 2 is the licence: sorting on the OUTPUT COLUMN already computes it for every row, so
materialize-then-sort changes nothing. Row 3 is the prohibition: with the sort on a DIFFERENT key,
a second item is never evaluated for discarded rows, and projecting it would raise. Row 6 is a
third rule: `applyProjection` returns `[]` BEFORE projecting at `LIMIT 0`.

So the rule is: **exactly one projected item, exactly one sort key, the key IS that item (an output
column or structurally the projected expression), and `limit !== 0`.** Admitting a second item
needs item 426's deferred "conservative cannot-fault check on the projection" — its own item, and
the `TWO items` row above (51.25x) is what it would unlock.

### Constraint 2 — a bare window stays declined, and the codebase already said why

`sortOf`, the DISTINCT walk's gate (item 191), states the same distinction this item needs:

> **`SKIP`/`LIMIT` WITHOUT an `ORDER BY`.** The general path is LAZY there … Taking that would be a
> ~280x REGRESSION. … With an accepted sort, paging IS taken: **neither path can exit early once a
> sort is in the way.**

That is exactly why item 378's "DO NOT widen the gate" warning does not cover `ORDER BY`, and the
precedent is already in the tree for another route. `projectionIsStreamable` lumps `orderBy` with
`skip`/`limit`; they have opposite laziness properties.

### Constraint 3 — TIE ORDER, which is the one no measurement so far would catch

`farDrivenHopWalk`'s own header says:

> Row ORDER changes, which is why this is allowed at all: an unordered result's order is
> unspecified in this engine … **A shape with ORDER BY or DISTINCT never reaches here.**

Admitting a sort removes that guarantee. Under `ORDER BY` the SORTED order is pinned, but TIES fall
back to arrival order — and the far-driven walk's arrival order differs from the start-driven one's
and from the general path's. Item 425 records that the top-k's arrival-index tiebreak is observable
(and that a mutant removing it survived a fixture built for it, because ties only show once
evictions have permuted the array).

So the implementation must either keep the sort on the START-DRIVEN walk only, or establish that
tie order is unobservable against native. **The conservative choice is the former**, and it is
cheap: the far-driven walk exists for `!needsStart` shapes, which can simply decline the sort.

### Not built this tick, deliberately

Three constraints, two of which only bite on EXCEPTION behaviour and one only on ties — the classes
of bug this repo records as invisible to timing and to a differential fuzzer that compares
multisets. The pattern that worked for items 600 -> 601 (derive and validate, then build with the
constraints already written down) applies, so this is the derivation half.

`compareSort` is the comparator to reuse — exported, and its doc states "the Rust `compare_sort`
matches", so byte-identity depends on not writing a second one.

### Gates

Measurement-and-docs only, both probes run under `timeout … systemd-run -p MemoryMax=16G -p
MemorySwapMax=0`. `bunx oxfmt --check .` uncached clean. CI green on 603.

## 605 — the ordered node projection: 9.51x, and the oracle is a DECLINED SPELLING of the query

Item 604 derived the admission rule and item 603 located the gate. This builds it, and two of the
three constraints came out differently once measured.

### Measured

Three alternated rounds, order reversed per round, `BENCH_ONLY=query:`, a rebuild per side:

| row                                         | ts before | ts after | ratio     | ffi   |
| ------------------------------------------- | --------- | -------- | --------- | ----- |
| **`query: ordered projection [no window]`** | **170.3** | **17.9** | **9.51x** | 1.02x |
| `query: top-k by property` (must DECLINE)   | 33.7      | 34.7     | 0.97x     | 1.00x |
| `query: project 3 columns`                  | 11.7      | 11.5     | 1.02x     | 1.16x |
| `query: distinct over a hop`                | 45.1      | 45.2     | 1.00x     | 0.99x |
| `query: 2-hop subquery item`                | 98.4      | 99.4     | 0.99x     | 1.00x |
| `query: project the edge + materialize`     | 936.1     | 944.3    | 0.99x     | 0.96x |
| `query: group + aggregate`                  | 3.2       | 3.8      | 0.84x     | 1.00x |
| `query: count distinct`                     | 2.9       | 3.2      | 0.91x     | 1.00x |

**The windowed twin is the control the rule itself demands**, and it did not move: `top-k by
property` is the same sort WITH a `LIMIT`, which `outputColumnSorts` must refuse, and 0.97x says it
still goes the old way. The `ffi` column is the second control — a TS change cannot reach it — at
0.96x-1.16x.

**The 0.84x-0.91x rows are 2.9-4.3 ms absolutes and are PROVABLY UNREACHABLE**: `group + aggregate`
and `top groups by count` carry `groupBy`, `count distinct` and `distinct + order by` carry
`distinct`, and both conditions still decline on lines this item did not touch. So they are not a
regression; they are this bench's floor at that size, which turns out to be about ±16% for a 3 ms
row. Worth having measured, since a 0.84x on a row one did not check for reachability is exactly
what a wrong "regression" looks like.

A new row was added because nothing watched the shape: `query: top-k by property` has a window and
is therefore the DECLINED case, so the suite's only ordered projection was one this route cannot
serve.

### Two constraints changed under measurement

**Constraint 3 (tie order) was real, and it moved the scope.** Item 604 worried that
`farDrivenHopWalk` reorders rows and so could reorder TIES once a sort is admitted. Measured over a
60-row fixture with 20 ties per group, **TS and native agree exactly on every ordered spelling** —
so tie order IS pinned between the engines and the hazard is genuine. The conservative dodge does
not work either: the far-driven walk is chosen for `!needsStart`, which is precisely the shape item
603 measured. So this item scopes to `detectNodeProjection`, which has no hop and no walk-order
question at all, and the hop case stays open behind that constraint.

**Constraint 1 (raise parity) came out WIDER than derived.** Item 604's rule was "one item, one
key". `colSortsOf`'s neighbour already carried the better argument — "EVERY key must be an output
column, which is what makes several keys safe here where item 189 had to refuse them: an output
column's value is already computed, so nothing is left unevaluated and no raise can be swallowed."
Combined with the measurement, the rule is simply **no window**: then every row is emitted, so
every item is projected either way, and any number of items and keys are safe. Wider, simpler, and
it needs no top-k — the general path full-sorts too.

`sortGroupRows` is reused rather than reimplemented: it goes through `compareSort`, whose doc states
"the Rust `compare_sort` matches", and a second comparator is the one thing byte-identity cannot
survive. `Array.prototype.sort` is stable, so ties keep the scan's arrival order — the same order
the general path scans in.

### The test's oracle is the engine's own general path

`ORDER BY x` (the output column) is admitted; `ORDER BY a.k` is structurally the same sort but an
EXPRESSION key, so it declines and the general path answers it. The two are the same query by any
reading, so they must agree ROW FOR ROW — which makes the general path the oracle with no second
implementation needed, and is the repo's equivalent-spellings invariant applied to a route rather
than to a cost. Every fixture has far more rows than distinct keys so ties are actually exercised,
and one assertion pins that the two-key order DIFFERS from the one-key order, so a dropped key
cannot pass by luck.

### Teeth: six mutants, and the survivor was a COINCIDENCE

| mutant                                      | result                    |
| ------------------------------------------- | ------------------------- |
| S1 do not sort at all                       | CAUGHT (17 tests)         |
| S2 ignore `DESC`                            | CAUGHT (5)                |
| S3 ignore NULLS placement                   | CAUGHT (1)                |
| S4 keep only the first sort key             | CAUGHT (1)                |
| S5 admit a window with a sort               | CAUGHT (15)               |
| S6 admit a key that is not an output column | **SURVIVED**, then CAUGHT |

**S6 is the one worth keeping.** `ORDER BY a` names the PATTERN VARIABLE — a valid sort, since a
node has an order. Under the mutant this path looks up `row['a']`, finds `undefined` for every row,
calls it all ties and returns SCAN order — which IS insertion order, which is exactly what
`ORDER BY a` ascending returns. **The wrong answer coincides with the right one**, so no ascending
fixture can see it. `DESC` is where they diverge, and the test now builds a fixture whose property
order runs OPPOSITE to insertion order so that neither can stand in for the other. Then CAUGHT.

S4 was first reported as "PATTERN APPEARS 2 TIMES -- skipped": the harness asserts a pattern is
unique, which is why it refused rather than silently mutating `colSortsOf` instead. With a unique
pattern it is caught.

### Gates

Each as its own command: `bun test packages/core packages/gql packages/gremlin
packages/serialization` 3765 pass / 0 fail (the 10 new cases), `bun test packages/native/src` 929
pass / 0 fail, `bun run typecheck` exit 0, `bunx oxlint --type-aware .` exit 0 uncached,
`bunx oxfmt --check .` uncached clean, `bun run fuzz` 13 pass / 0 fail across all seven
byte-identity fuzzers — and those compare ORDERED results here, so they are a cross-engine check on
the tie order this item pins. CI green on 604.

### Still open

The HOP projection, behind constraint 3: `farDrivenHopWalk` must either keep the sort off itself or
establish that its arrival order is unobservable. Item 603 measured that shape at 173.0 ms against
a 44.5 ms unordered reference. And a window WITH a sort stays declined until item 426's
conservative cannot-fault check exists — the two-item windowed shape (51.25x against native) is
what that would unlock.

## 606 — a helper I DUPLICATED one item earlier, and a doc claim that is caller-scoped

No measurable change: a deduplication, and a correction to a comment that would have misled the
next reader as it nearly misled me.

### The duplication

Item 605's `outputColumnSorts` inlined its own "every `ORDER BY` key is a `var` naming an output
column" test. `executor.ts` already exports `sortsOnOutputOnly`, which asks exactly that, is used
by the rungs at items 544/545, and carries its own mutation analysis —
and `hop-projection.ts` was ALREADY importing it two lines from code I was reading. The cost of not
noticing is stated in the tree, next to `plainRowProjection`: "two copies of this list is how one
of them falls behind the other."

It did not compose directly. `sortsOnOutputOnly` takes a `CProjection` because its callers have
one; `detectNodeProjection` has no compiled projection and builds its output names itself while
compiling each item's expression. Rather than contort either side — a fabricated `CProjection` at
the call site, or a second copy of the rule — the predicate is split:

```ts
export const sortsOnOutputNames = (ret, names: ReadonlySet<string>): boolean => …
export const sortsOnOutputOnly = (ret, proj: CProjection): boolean =>
  sortsOnOutputNames(ret, new Set(proj.items.map((it) => it.name)));
```

One rule, one place, both callers.

### The doc claim that is caller-scoped, which is the more useful half

`sortsOnOutputOnly`'s comment records:

> Only the `kind === 'var'` half is load-bearing, and mutation says so: dropping the NAME check, or
> emptying the name set, leaves every answer unchanged. The first is equivalent by construction —
> an aggregating projection's ORDER BY resolves against the OUTPUT columns, so any valid `var` key
> already names one.

**That is true of the AGGREGATING rungs it was written for and FALSE of item 605's caller.** A
non-aggregating projection's `ORDER BY a` can name the PATTERN VARIABLE — a valid sort, since a
node has an order — so the name check decides whether this route takes a query it must not. It is
exactly the mutant that survived item 605's first mutation round, because the broken path returns
scan order and scan order coincides with the ascending answer.

Re-run now that the rule is shared:

| mutant                                     | result              |
| ------------------------------------------ | ------------------- |
| M1 drop the NAME check (inert for 544/545) | **CAUGHT (1 test)** |
| M2 drop the kind check as well             | CAUGHT (19)         |
| M3 admit a window with a sort              | CAUGHT (15)         |

M1 being caught by exactly ONE test is the point: that test is item 605's DESC case, which exists
only because the ascending spelling could not see the bug. So the helper's "not load-bearing" note
is now scoped at its definition and contradicted, for this caller, at the call site — with a test
behind the contradiction rather than an assertion.

**The rule worth carrying: a shared predicate's "mutation says this half is inert" note is a claim
about its CALLERS, not about the predicate.** Adding a caller can make a dead branch live, and the
note will still read as settled. Check it against the new caller rather than inheriting it.

### Gates

Each as its own command: `bun test packages/core packages/gql packages/gremlin
packages/serialization` 3765 pass / 0 fail, `bun test packages/native/src` 929 pass / 0 fail,
`bun run typecheck` exit 0, `bunx oxlint --type-aware .` exit 0 uncached, `bunx oxfmt --check .`
uncached clean, `bun run fuzz` 13 pass / 0 fail. CI green on 605.

### Also priced, not built

The HOP extension of item 605, behind its tie-order constraint. The shapes
`farDrivenHopWalk` DECLINES (`farPred || gate || needsStart`) are the ones the start-driven walk
serves and could take the sort: `needsStart, ORDER BY x` is **459.3 ms against a 37.0 ms unordered
reference**, and the far-predicate variant 423.4 against 50.9. Tie order is SAME between the
engines for all three hop spellings today, so the general path's order is reproducible and the
far-driven walk is the only half that must stay out. Its own header already says so.

## 607 — the HOP half: 5.14x, through a lever the file already had

Item 605 left the hop projection behind its tie-order constraint. This builds it.

### Measured

Three alternated rounds, order reversed per round, `BENCH_ONLY=traverse`, a rebuild per side:

| row                                      | ts before  | ts after  | ratio     | ffi   |
| ---------------------------------------- | ---------- | --------- | --------- | ----- |
| **`traverse 1-hop project + order by`**  | **1136.5** | **221.2** | **5.14x** | 1.03x |
| `traverse 1-hop project` (the REFERENCE) | 99.1       | 98.2      | 1.01x     | 0.86x |
| `traverse 1-hop project + start filter`  | 66.1       | 65.5      | 1.01x     | 1.02x |
| `traverse 1-hop + filter`                | 37.5       | 37.5      | 1.00x     | 1.00x |
| `traverse 1-hop + start filter`          | 35.5       | 35.9      | 0.99x     | 1.00x |

**`traverse 1-hop project` at 1.01x is the control that matters most**, because it is the SAME
query without the sort — and a sort now forces the start-driven walk, so if the flag leaked the
unordered row would lose the far-driven walk's locality (item 167's 2.3x). It did not.

The `ffi` column's 0.86x on that row (61.0 -> 70.7) is a NATIVE figure on a row a TS change cannot
reach — the second control, and incidentally this bench's floor for a 60-70 ms native row, ~±15%.

### No new flag: `forceStartDriven` already existed, for this reason

`detectHopProjection` takes `forceStartDriven`, and its own doc had settled the premise:

> With a non-vacuous start label the same query reads `[5,2,3,4,0,0,2,1]` in both engines, which is
> what says the start-driven walk's order is the general path's. **So an order-sensitive fold may
> ride THIS walk, and only this one.**

A sort is exactly such a consumer, so admitting one sets that flag. `farDrivenHopWalk` keeps its
locality win for every unsorted query and gives it up only where order matters.

The shared pieces moved to `executor/ordered-rows.ts`, because `shortcuts.ts` imports FROM
`hop-projection.ts` — anything both need cannot live in either without a cycle. `sortGroupRows`
delegates to it, so there is still one comparator and one sorter.

### Teeth: three mutants, TWO survived, and both were my fixtures

| mutant                                                   | result                    |
| -------------------------------------------------------- | ------------------------- |
| H1 far-driven walk keeps a sorted query (the constraint) | **SURVIVED**, then CAUGHT |
| H2 do not sort the hop rows at all                       | CAUGHT (9 tests)          |
| H3 admit a bare window into the streaming gate           | **SURVIVED**, then CAUGHT |

**H1 survived because the fixture projected ONLY the sort key.** Every tied row was the same object
(`{t: 0}`), so reordering ties was literally invisible and the assertion could not fail. A second,
unique column (`b.n`) makes each tied row identifiable and its position part of the comparison.
Same coincidence as item 605's S6, and exactly what item 425 recorded: "I wrote the fixture for this
guard is not evidence it exercises the guard." The DESC direction is now asserted too — the sorted
order reverses while ties must still arrive in the general path's order rather than the reverse.

**H3 was not exercised at all**: the laziness test was a NODE query and H3 is the HOP gate. Worth
naming what the mutant does, since "breaks laziness" undersells it — the wrapper SORTS and does not
page, so a shortcut claiming `LIMIT 5` returns every row. Covered now with `LIMIT` and `SKIP`.

Both re-run: CAUGHT, each by exactly the test written for it.

### Two process notes

**I patched the wrong function first.** I read `farDrivenHopWalk`'s header, then matched an
admission test at a line number grepped earlier which belonged to `undirectedHopWalk`. The
uniqueness assertion passed because the pattern WAS unique — just not in the function I believed.
A line number is not a function identity; re-grep inside the function before editing it.

**Lint pushed back twice and was right both times.** Unused imports after the move, and the
detector at complexity 37 against a cap of 35. Not worked around: `hopOrderPlan` and `hopEnds` are
extracted, which is what this file's own comments say was done for `projectionIsStreamable`. A
run-time subtlety came out of it too — `RowsFn` returns `Row[] | null` because a walk can decline
PER CALL, and sorting that would answer a declined walk with an empty result instead of letting the
general path run.

### Gates

Each as its own command: `bun test packages/core packages/gql packages/gremlin
packages/serialization` 3769 pass / 0 fail (14 cases in the new file), `bun test
packages/native/src` 929 pass / 0 fail, `bun run typecheck` exit 0, `bunx oxlint --type-aware .`
exit 0 uncached, `bunx oxfmt --check .` uncached clean, `bun run fuzz` 13 pass / 0 fail across all
seven byte-identity fuzzers — comparing ORDERED results, so a cross-engine check on the tie order
this item turns on. CI green on 606.

### Still open

A window WITH a sort, in both the node and hop paths, until item 426's conservative cannot-fault
check exists. Item 603 measured that shape (`ORDER BY x LIMIT 5` over a hop) at 164.3 ms against
native's 2.9.

## 608 — "grep the pattern elsewhere" pays: the SAME over-broad gate in the Gremlin engine

Items 605/607 found that a materializing GQL shortcut declined an `ORDER BY` it could have served.
The method's own next step is to look for the pattern elsewhere, and it is there.

### Measured

200,000 vertices / 200,000 edges, min of five, under the cgroup cap:

| traversal                                     | ts ms     |
| --------------------------------------------- | --------- |
| `V().out().values('age')` — 3 steps, SHORTCUT | **28.9**  |
| `V().out().values('age').order()` — 4 steps   | **172.5** |
| `V().values('age')`                           | 29.4      |
| `V().values('age').order()`                   | 58.2      |

**The non-hop pair prices the sort itself**: 58.2 - 29.4 = ~29 ms for 200,000 values. So the hop
case SHOULD be ~58 ms (28.9 + the sort) and is 172.5. The extra ~114 ms is the shortcut being
declined — **~3.0x available**, and the reference is the shortcut plus a sort rather than native,
so it is a route gap and not a layout ceiling.

### Why it declines, and the precedent for fixing it

`hopValuesShortcut` opens with `if (steps.length !== 3) return undefined;` — it wants exactly
`V().out(T).values(k)`, so a trailing `order()` makes the plan four steps and declines the whole
query. The file states the consequence in general terms already, for a LEADING step:

> Every shortcut in `run` matches a plan PREFIX that starts at the source … A leading `hasLabel` is
> one step too many for all of them, so it does not merely cost its own per-element test — it drops
> the whole query onto the traverser pipeline.

Item E78's answer there was a plan-level rewrite that DROPS a tautological `hasLabel` so the
shortcut still matches. An `order()` cannot be dropped, so the mechanism to follow is the other one
in the same file: `seedFromIndex` returns a STREAM and the pipeline "appl[ies] only the residual
steps". `hopValuesShortcut` instead returns the final answer, which is why a residual step cannot
compose with it.

### Easier here than in GQL, for two reasons

- **No raise-parity question.** `values(k)` emits SCALARS and drops an element lacking the key, so
  there is no projection that could fault on a row the query never emits — the whole constraint
  that shaped items 604/605.
- **No tie-order question.** The output is scalars, so equal values are INDISTINGUISHABLE and a
  reordering of ties is unobservable by construction. Item 607 had to force the start-driven walk
  precisely because GQL rows carry other columns; that does not arise.

What does need care is `order`'s own semantics — `desc`, `by(...)` modulators, `Scope.local`, and
the runtime fault on ordering raw elements. Those live in `orderStep`/`sortByBys`, so the residual
route gets them for free where a sort inlined into the shortcut would re-derive them. That is the
argument for the stream-plus-residual shape over the quick one.

### Not built this tick

Deliberately, and for the reason items 600 -> 601 and 604 -> 605 both came out better for it: the
implementation is a refactor of how one shortcut returns its result, and the cheap version (sort
inside the shortcut) would duplicate a comparator — the one thing byte-identity cannot survive, and
the mistake item 606 had just finished removing.

### Gates

Measurement-only; probe run under `timeout … systemd-run -p MemoryMax=16G -p MemorySwapMax=0`.
`bunx oxfmt --check .` uncached clean. CI green on 607.

## 609 — the Gremlin residual: 1.12x, and I RETRACT my own 2.2x

Item 608 priced this at ~3.0x from a probe. Built and measured properly it is **1.12x**, and the
retraction is the more useful half of the entry.

### What shipped

`hopValuesShortcut` matched a plan of EXACTLY three steps, so `V().out(T).values(k).order()` was
four and dropped the whole query onto the traverser pipeline. It now returns
`{ values, rest }` — the prefix's values plus the steps left over — and the call site feeds the
residual through the existing loop, exactly as `seedFromIndex` already does in the same file.

Soundness is the argument the shortcut already rested on: the prefix yields the values the general
pipeline would, in the same order, so running the remaining steps over them is the same
computation. Every step keeps its own semantics — `order` keeps `desc`, `by(...)`, `Scope.local`
and its runtime fault on ordering raw elements — which a sort inlined into the shortcut would have
re-derived. Re-deriving a comparator is the one thing byte-identity cannot survive, and item 606
had just finished removing one such duplicate.

The no-residual path is untouched: `rest.length === 0` still returns the values without ever
building a traverser.

### Measured, and why my earlier figure was wrong

Three alternated rounds, order reversed per round, a rebuild per side:

| row                                 | ts before | ts after  | ratio     | native      | answers |
| ----------------------------------- | --------- | --------- | --------- | ----------- | ------- |
| **`V().out().values(age).order()`** | **572.6** | **509.1** | **1.12x** | 79.50/76.02 | same    |
| `V().out().values(age)` (REFERENCE) | 164.8     | 166.5     | 0.99x     | 1.00x       | same    |
| `V().out().out().count()`           | 52.8      | 52.6      | 1.00x     | 1.00x       | same    |
| `V().repeat(out).times(2).count()`  | 52.7      | 52.7      | 1.00x     | 0.99x       | same    |
| `V().out().has().count()`           | 41.6      | 41.6      | 1.00x     | 0.99x       | same    |
| `V().hasLabel().has().values(age)`  | 13.2      | 13.2      | 1.00x     | 1.00x       | same    |
| `V().has().out().count()`           | 25.2      | 22.8      | 1.11x     | 1.00x       | same    |
| `V().has(age,gt).count()`           | 2.3       | 2.6       | 0.88x     | 1.00x       | same    |

**ITEM 608's ~3.0x IS WITHDRAWN.** It came from a probe that (a) compared the before and after code
in DIFFERENT PROCESSES and (b) used a 200,000-edge fixture where `bench:gremlin` has 1,000,000 —
which is why its baseline was 172.5 ms against the bench's 572.6. Two faults at once, and the
process one had already announced itself: an unreachable control in that same probe swung 58.2 ->
73.8 between runs, ~27%, which is larger than several differences I would have been reporting.

**The mechanism is clearer than the ratio.** The walk saving is a roughly CONSTANT ~63 ms while the
sort grows with the result set. At 1,000,000 values the sort is most of the 509 ms, so 63 ms is
1.12x; the same change is worth proportionally more the less there is to sort. A ratio here is only
meaningful against a stated denominator — item 600b's lesson in a new costume.

1.12x IS above this bench's floor for a row that size: the large rows read 0.99x-1.00x (165 ms,
52 ms, 41 ms), so ~1%. The 0.88x-1.11x spread is confined to the 2-4 ms rows and to
`V().has().out().count()`, which this change cannot reach (it is the count shortcut, not
hop-values) — their own floor, not a regression.

**Every row answers `same` on both sides**, which matters more than the ratio for a change that
reroutes execution.

### Teeth: three mutants, TWO survived, and they are different kinds

| mutant                                        | result                    |
| --------------------------------------------- | ------------------------- |
| G1 drop the residual (exact 3-step match)     | **SURVIVED**, then CAUGHT |
| G2 ignore the residual steps at the call site | CAUGHT (1 test)           |
| G3 let a path-tracking plan ride the shortcut | **SURVIVED**, then CAUGHT |

**G1 is an answer-equivalent ROUTE choice** — both routes produce identical values, so no
answer-based test in the package can see it. `perf-gate-needs-its-own-test` again, and item 605's
remedy transfers: assert the FUNCTION'S CONTRACT, not the query's output. The new test calls
`hopValuesShortcut` directly and asserts a 4-step plan is claimed WITH its residual and a 3-step
plan with an empty one.

**G3 is a CORRECTNESS guard with no test, and it predates this item.** `tracksPath` exists because
the walk emits bare values and builds no traverser, so it carries no path — and nothing exercised a
path-reading plan over this shape. `V().out('K').values('age').path()` answers `[a, b, 2]`; a
shortcut that claimed it would answer `[2]`. Now pinned.

**And one of my own tests was vacuous on the first draft**: it ran the SAME traversal twice and
compared the results to each other, asserting nothing. It now compares the ordered result to the
sorted unordered one AND asserts the two differ, so a residual that did nothing fails it.

### Gates

Each as its own command: `bun test packages/gremlin packages/core packages/gql
packages/serialization` 3774 pass / 0 fail (5 new cases), `bun test packages/native/src` 929 pass /
0 fail, `bun run typecheck` exit 0, `bunx oxlint --type-aware .` exit 0 uncached, `bunx oxfmt
--check .` uncached clean, `bun run fuzz` 13 pass / 0 fail across all seven byte-identity fuzzers —
`gremlin-fuzz` compares TS against native over 400 generated plans, which is the cross-engine check
on this reroute. CI green on 608.

## 610 — the cannot-fault check items 426/603/605 all deferred: 1.77x and 1.89x

Three items stopped at the same place. A window with a sort stayed on the general path because
that path keeps top-k INPUT bindings and projects only SURVIVORS, so an item that faults on a
discarded row never raises there (item 604 measured both engines agreeing). Item 426 named the fix
— "a conservative cannot-fault check on the projection … own item". This is it.

### Measured

Three alternated rounds, order reversed per round, `BENCH_ONLY=query:`, a rebuild per side:

| row                                       | ts before | ts after | ratio     | ffi   |
| ----------------------------------------- | --------- | -------- | --------- | ----- |
| **`query: ordered projection + limit`**   | 33.7      | **17.8** | **1.89x** | 1.00x |
| **`query: top-k by property`** (STANDING) | 32.1      | **18.1** | **1.77x** | 1.00x |
| `query: ordered projection [no window]`   | 17.5      | 18.1     | 0.97x     | 1.00x |
| `query: 2-hop subquery item`              | 98.8      | 97.7     | 1.01x     | 1.00x |
| `query: distinct over a hop`              | 44.1      | 45.0     | 0.98x     | 1.01x |
| `query: count distinct`                   | 3.1       | 3.1      | 1.00x     | 1.00x |

`top-k by property` is a row that has been in the suite for a long time, not one added for this
item — it was the DECLINED case at item 605 and is now served. The unwindowed row is unchanged
(605 already admitted it), and `ffi` is flat on both targets.

**TWO FIGURES I AM NOT CLAIMING.** `query: project 3 columns` reads 1.32x — and its FFI column moved
1.17x in the same rounds, which a TS change cannot cause, so that row drifted. And three
`groupBy`/`having` rows printed `inf` because the driver's regex missed them on the before side; a
harness fault, and they are unreachable by this change anyway (`detectNodeProjection` still
declines `groupBy`/`having` on untouched lines).

### Why a full sort is enough — the design question re-derived rather than assumed

My first instinct was that a top-k was needed, since the general path uses one and a full sort
would give the win back. Item 605's own A/B had already answered it: the ordered node projection
lands at **17.9 ms for 200,000 rows**, so the sort is ~10 ms and the general path's cost is the
per-row `Binding`, not the sort. So sort-then-slice suffices — and it avoids re-implementing a
top-k whose tie-breaking would have to match the existing heap's arrival-index order, which item
605 showed is OBSERVABLE between the engines.

### The predicate

`var | prop | lit | param` are total; everything else declines. Deliberately asymmetric: a false
"cannot fault" is a wrong answer, a false "might fault" is only the general path. `prop` is total
because a missing key reads NULL; `arith` divides, `compare` throws on a cross-type `<=`
([[cross-type-comparison-no-error]]), `index`/`field` can miss, a scalar call can reject its
argument. `list`/`record` could recurse into their elements and deliberately do not.

**A PARAMETERIZED WINDOW DECLINES, and the type system is what said so.** `skip`/`limit` are a
`CountValue`, which may be `{ param }` — so `LIMIT $n` would have reached `slice` as an object. It
declines rather than being resolved: the route is decided once at compile time while the value
lives in `params` per call, so resolving it would make a cached plan depend on a binding.

### Teeth: seven mutants, and the two survivors are different kinds

| mutant                                       | result       |
| -------------------------------------------- | ------------ |
| W1 admit a FAULTING item with a window       | CAUGHT (3)   |
| W2 `cannotFault` returns true for everything | CAUGHT (3)   |
| W3 admit `LIMIT 0`                           | **SURVIVED** |
| W4 admit a parameterized window              | CAUGHT (1)   |
| W5 page before the sort (statement order)    | **SURVIVED** |
| W5b page a COPY before sorting               | CAUGHT (8)   |
| W6 ignore `SKIP` (page from 0)               | CAUGHT (4)   |

**W3 SURVIVES AND SHOULD, and my comment was wrong about why.** I had given `LIMIT 0` the
raise-parity argument. It does not need one: with no faulting item admitted, the slice returns `[]`
and so does `applyProjection`, so both paths agree. The clause is a SPEED guard — it avoids sorting
every row to return none. Relabelled as such, because a mislabelled guard is how the next reader
draws the wrong conclusion from a surviving mutant.

**W5 SURVIVED BECAUSE THE MUTANT WAS A NO-OP**, not because the order is unprotected.
`Array.prototype.sort` mutates IN PLACE, so `const sorted = rows.sort(…)` leaves `rows` BEING
`sorted` — slicing "before" slices an already-sorted array. The real form slices a COPY first
(W5b) and is caught by 8 tests. A survivor is a question about the mutant as much as about the
code.

### Two tests, and one of them caught me

`a window DOES ride the sort when no item can fault` is the other side of item 605's declining
test, across five node windows and three hop windows against the declined spelling. A `SKIP 700`
case on a 600-row fixture is asserted DIRECTLY rather than through `agree`, because `agree`'s
non-emptiness guard exists to stop a comparison passing when both sides return nothing — the guard
rejected my case and I kept the guard.

### Gates

Each as its own command: `bun test packages/gql packages/core packages/gremlin
packages/serialization` 3776 pass / 0 fail, `bun test packages/native/src` 929 pass / 0 fail,
`bun run typecheck` exit 0, `bunx oxlint --type-aware .` exit 0 uncached, `bunx oxfmt --check .`
uncached clean, `bun run fuzz` 13 pass / 0 fail across all seven byte-identity fuzzers. CI green
on 609.

## 610b — VERIFIED that the shared predicate reached the hop path, and item 603's figures close

Item 610's cannot-fault check lives in `outputColumnSorts`, which the HOP detector also calls — so
the windowed hop shapes should be served too. "Verify the planner reaches the shape" is a step, not
an inference from a shared helper, so it was measured:

| query (200,000 vertices, degree 1)                        | item 603 | now      |
| --------------------------------------------------------- | -------- | -------- |
| `-[:K]->(b) RETURN b.k AS x ORDER BY x LIMIT 5`           | 173.0 ms | **91.3** |
| `-[:K]->(b) RETURN a.k AS x, b.j AS y ORDER BY x LIMIT 5` | 157.0    | **74.6** |
| `-[:K]->(b) RETURN b.k AS x ORDER BY x` (no window)       | —        | 84.9     |
| CONTROL, bare window `RETURN b.k AS x LIMIT 5`            | —        | **0.1**  |

So the two windowed hop figures item 603 left open are closed at roughly 1.9x-2.1x. **These are
CROSS-PROCESS comparisons against item 603's probe and are reported as such** — item 609's
retraction is the precedent — but the direction and magnitude match the node rows that WERE
A/B'd (1.77x / 1.89x), and the control is decisive on the thing that actually mattered: a bare
window still answers in 0.1 ms, so laziness is intact and `sortOf`'s ~280x regression was not
taken.

**One control was BADLY CHOSEN and is recorded so it is not reused.** A `CAST(b.k AS INTEGER)`
item was meant to show a faulting projection declining — but `b.k` is `k0`…`k999`, which cannot
cast in ANY row, so the general path raises too and the control cannot distinguish the two routes.
The shape that can is item 610's test fixture: a faulting value in a row the ORDERING EXCLUDES.
A control has to be able to come out either way.

## 611 — depth 4's structure, priced before derived: it needs an A^2 entry, so it is ONE LEVEL dearer

Item 600 derived the depth-3 trail correction and said depth 4 "has more terms and is not
claimed". That reads as a quantity problem. It is a KIND problem, and the difference is worth
recording before anyone spends a tick on the algebra.

### Why depth 3 was special

Of its three pair-equality events — `(e0,e1)`, `(e1,e2)`, `(e0,e2)` — only `(e0,e2)` is
NON-ADJACENT, and it spans exactly ONE intermediate edge. That pins a 2-cycle `a -> b -> a`, so the
term is a REVERSE-EDGE MULTIPLICITY: `Σ_{e: a->b} m(b, a)`. Every other term is a self-loop tally
or a degree. That is the whole reason the formula is cheap.

### Depth 4 has a pair that spans TWO

Its non-adjacent pairs are `(e0,e2)`, `(e1,e3)` and `(e0,e3)`. The last spans two intermediate
edges: `e3 == e0` forces the walk to be `a -> b -> ? -> a -> b`, so `e1, e2` are a 2-WALK from `b`
back to `a`. The term is therefore

```text
Σ_{e: a->b}  A²[b][a]
```

— an entry of the squared adjacency matrix, per edge. Verified non-zero in 8 of 8 random graphs
(3-5 vertices, 4-10 edges), computed densely and compared against the walk and trail counts.

### So it is not blocked, it is one level dearer — and that IS the price

`A²[b][a]` is reachable without a matrix product: for each edge `a -> b`, walk `b`'s adjacency and
count edges `k -> a` for each neighbour `k`. Summed, that is the **3-WALK COUNT** — against
enumeration's 4-walk count. So depth 4 buys a factor of the average degree, exactly as depth 3
does against 3-walk enumeration (item 600b). The relationship repeats one level up:

| depth | correction costs | enumeration costs | win         |
| ----- | ---------------- | ----------------- | ----------- |
| 3     | 2-walks          | 3-walks           | ~avg degree |
| 4     | 3-walks          | 4-walks           | ~avg degree |

### Why that is not a reason to build it next

The prize is the same FACTOR as depth 3 but the derivation is much larger: six pair events with
their intersections, against depth 3's three events and four terms. And a wrong term returns a
plausible count — the class of bug this repo records as invisible to timing and caught only by unit
tests and fuzzers. Item 602 did leave `exec::fastpath_fuzz` able to generate depth 4, so the oracle
exists, which is the one prerequisite that was missing.

**Recorded so the next pass starts from the structure rather than re-deriving it**, and so "more
terms" is not mistaken for "a bigger version of the same thing". The measured prize remains large
in absolute terms — TS `-[:K]->{4}` is 5765 ms against native's 80.96 — and the standing bench has
no row for it.

## 611b — depth 4 PRICED PROPERLY: 14 structural terms, and my first collapse was WRONG

Item 611 established that depth 4 needs an `A²` entry. This prices the derivation itself, because
"six pair events" undersells it, and the attempt produced a result worth more than a formula.

### The decomposition is right

Inclusion-exclusion over the six pair-equality events `(e0,e1) … (e2,e3)`, computed numerically
over random graphs admitting self-loops and parallel edges: **300/300 agree** with brute-force
4-trail enumeration. So the shape of the answer is settled.

### But it does not collapse the way depth 3 did

**All 63 non-empty subsets are feasible** — none is jointly impossible, so none drops out. They
reduce to **14 distinct terms**, one per partition of `{e0,e1,e2,e3}` other than the all-distinct
one (Bell(4) = 15, minus one). Depth 3 had FOUR. The net coefficients are the partition lattice's
Möbius function, `∏_blocks (-1)^(|B|-1) (|B|-1)!` — `-6` for all four together, `+2` for a 3+1,
`+1` for 2+2, `-1` for a 2+1+1 — which is a clean statement, and it is the only clean part.

### MY FIRST COLLAPSE WAS WRONG, AND THE VALIDATOR CAUGHT IT ON THE FIRST RUN

Having the right 14 coefficients, I summed them against per-partition counts and got
**39/200 agreement**. The 63-subset form had just agreed 300/300, so the decomposition was not the
problem — the collapse was, almost certainly the direction of the Möbius inversion (whether a
partition's count is over walks coarser or finer than it). Not debugged further, because the
verdict was already in:

**That is the finding.** Depth 4's derivation is 14 terms rather than 4, at least one of them needs
`A²` (item 611), and a plausible-looking collapse of correct coefficients was still wrong on the
first attempt and would have returned plausible counts for a 4-hop trail in production. Against a
payoff of ~average degree — the SAME factor as depth 3, per item 611's table, not a larger one.

### So depth 4 is NOT the next thing to build, and this says why with evidence

Not "more terms" (item 600's phrasing) and not "intractable" (my own first guess at 611, before
the `A²` cost model). It is: **four times the terms, one of them needing a quantity no O(V+E) pass
provides, for the same factor of win, with a derivation that has already produced one wrong answer
under validation.**

Anyone who does take it on should keep the brute-force validator FIRST — it cost minutes and found
the error immediately, which is exactly how item 600's depth-3 formula was landed safely
(400/400 before a line of engine code). `exec::fastpath_fuzz` can now generate depth 4 (item 602),
so the second oracle is in place too.

### Gates

Measurement-and-docs only; no engine change. `bunx oxfmt --check .` uncached clean. CI green
on 611.

## 612 — the aggregate ladder's placement claims: what is pinned, what is prose, and what was TOO STRONG

Read this before adding, moving or re-gating an entry in `exec.rs`'s `Plan::Aggregate` `or_else`
chain.

**The failure mode, because it is silent.** An entry placed below one that already claims its
shape is dead code that still passes every test it has: both paths return the same answer, so no
differential test can see it, and the bench row reads 1.0x. Items **371, 375 and 422** are three
instances; each was found by an `eprintln` at function entry, not by a test.

**The rule, from item 369 and restated in `fastpath.rs`'s header:** prefer DISJOINT gates, so the
order can be read rather than measured; where gates genuinely contend, pin it with a direct
assertion on the function. Items 369, 376 and now 612 do this.

**NARROWED at 612 — "disjoint by arity" is too strong.** The call site justified
`try_frontier_multi_agg`'s position with _"every entry above refuses by arity … disjoint from all
of them for that reason"_. Mutation says otherwise: every upstream entry reads `aggs[0]` and then
applies its own CONTENT gate (`try_frontier_count` wants `count(*)`,
`try_frontier_prop_agg` wants a property argument), so on any one shape all but one of them
decline on content **before arity is ever consulted**. An arity mutant in the others survives.
`count(*), max(b.v)` catches a `try_frontier_count` mutant; only `max(b.v), count(*)` catches a
`try_frontier_prop_agg` one. The disjointness holds — the ATTRIBUTION does not. For most entries
on a given shape the content gate is the load-bearing one.

**And disjointness is symmetric.** Pinning only "the entries above decline a two-agg shape" left a
mutant that drops `try_frontier_multi_agg`'s own `len() >= 2` floor alive, because that assertion
is a statement about _other_ functions. The entry must also refuse the ONE-aggregate shapes owned
by the entries BELOW it. Both directions are now asserted in
`the_single_aggregate_frontier_entries_all_decline_a_two_aggregate_shape`.

**What stays untestable: the ROUTE.** A fast path is answer-equivalent by construction, so nothing
behavioural can tell which entry answered — item 473's note and the perf-gate rule both say so.
The PREMISE is pinned; the route is not, and an `eprintln` at function entry remains the
instrument for "is this arm actually reached".

**Two fixture traps worth knowing**, both of which produced a surviving mutant at 612:

- `try_frontier_count` requires a top-level `IsLabeled` filter, so `-[:E]->(b)` with an
  UNLABELLED endpoint declines on the filter shape and the arity gate is never reached. Use
  `(b:N)`.
- Which upstream entry's arity gate is reachable depends on the aggregate ORDER in the `RETURN`,
  because each reads `aggs[0]`. A test over one ordering covers one entry.

**Refuted here, do not re-attempt:** moving the `Plan::Aggregate` arm's REJECTED-lever
commentary out to `docs/`. It is next to the code it would have changed deliberately (the repo
rule, "several have been re-attempted otherwise"), and it doubles as the record that
`#[inline(never)]` on the whole ladder buys nothing.

**Structural facts, now at the code rather than only in the audit:** `exec`'s thirteen submodule
declarations are one block at the top of `exec.rs` with a one-line map each (they had been
scattered over six places between lines 857 and 5681, `fastpath` declared 4,862 lines deep), and
every submodule has a `//!` header. `fastpath.rs`'s header carries the family table and the
ordering rule. The scalar-aggregate prologue
(`!keys.is_empty() || aggs.len() != 1` then `&aggs[0]`) was **byte-identical in 25 places** and is
now `sole_agg(keys, aggs)?`; measured flat across ~60 `query_bench` rows (0.92-1.09x, both
directions, centred on 1.00x), with `filtered` reported as the known layout toll — it read 1.04x,
0.99x and 0.95x across three invocations of the SAME two binaries.

## 613 — cross-engine citations ROT, and there is now a probe for it

**`bun run xref` (in `packages/native`). Baseline at item 613: 61 unresolved citations across 51
distinct names. SUPERSEDED — item 614 drove it to ZERO and fixed three probe defects that the 61
was hiding; read that section, not this number.**

A comment saying _"Mirrors the native `varlen_distinct_endpoint_count`"_ is the ONLY index from
one engine to the other. Nothing compiles it, nothing tests it, and after a Rust rename a dead
name reads exactly like a live one — so a reader is not told they were misdirected, they simply
fail to find anything. `shortcuts.ts`'s header pointed at `try_count_edges`, `try_count_two_hop`
and `try_reachable_distinct`, **all three gone from the crate**; grepping the pattern elsewhere
found 61 more, `val_eq` alone cited 6 times from 5 files. Two cited Rust TEST names and the module
path `crates/lenke-engine/src/value.rs` are stale too. Most of it is the `lenke-core` →
`lenke-engine` migration's wake.

A PROBE, not a test, for `spelling-probe.ts`'s reason: a snake_case word in a comment is usually a
Rust item but is sometimes a TS-local identifier, a config key or a file stem, so a CI threshold
would be noise and a human has to read the list. A comment naming a dead symbol on purpose ends
with `xref:gone` and is skipped.

## 613 — where a GQL fast path's PRECEDENCE lives, and the lookalike that is not it

**`runLinear`'s `if (linear.…)` chain in `packages/gql/src/executor/clauses.ts` is the sole
authority.** `compileLinear` in `executor.ts` runs all nineteen detectors EAGERLY into a named
object; its field order carries no precedence at all.

It used to read as though it did — 14 of its 19 fields were in ladder order while the first 5 were
not, and it carried a comment claiming `optionalHopCount` "sits above the plain one" when the real
chain correctly places it BELOW `countShortcut` as the strictly narrower shape (item 510). **A list
that resembles the precedence for three quarters of its length is worse than one that plainly does
not.** The literal is now in exact ladder order, with the authority named; keep it that way.

Verified inert before reordering: nothing iterates `CLinear`'s keys, and every detector is a pure
function of `(fast, clauses)`.

The chain's own comments are the model to follow when adding a rung — each says whether its
position is for correctness, for cost (item 418: a branch ahead of a hot dispatch cost the plain
hop projection 1.12x for nothing), or only for reading. Item 612 had to retrofit that standard
onto the Rust ladder.

**REFUTED as a target, do not re-derive:** extracting the
`if (clauses.length !== 2) { return null; } const [m, ret] = clauses;` prologue from
`shortcuts.ts`. It occurs 7 times, plus a start-label guard 6 times — real, but against item 612's
25 BYTE-IDENTICAL occurrences it is a worse ratio, the code diverges immediately after each one,
and [[ts-closure-size-is-load-bearing]] records that layout here is not free.

**And a sampling note for `query: ordered projection`:** both rows carry a ~1.21x intrinsic spread
(20.5/24.0/19.8 and 16.6/16.6/20.1 on one build), so single runs there are bimodal like the
spelling probe's and want nine reps. A single run reading 1.27x against item 610's figure was
measurement, not regression.

## 614 — the xref baseline is ZERO, and the probe now earns that number

**`bun run xref` reports 0 unresolved citations (was 61 / 51 names at item 613). Keep it at 0.**
`--all` reports 2, both correct non-Rust names (`algorithm_run`, an MCP tool; `command_async`, a TS
method). A comment that names a dead symbol on purpose carries **`xref:gone` on the same line as
the name** — nine places now rely on that.

**The probe needed three fixes before 0 meant anything, and the third is the one to remember:**
its CLAIM test was per-LINE, so a doc comment that opens "Mirrors the native …" and names the
symbol three lines down was not checked at all. That hid **fifteen** real dead citations — a
quarter of the total — visible only under the too-noisy `--all`. It now tests the whole contiguous
comment BLOCK. Also: module-qualified names (`value::equals`) were invisible to the name regex
and are now resolved on their last segment, and the haystack includes each Rust file's PATH so a
citation naming an example by stem (`skipcast_426`) resolves.

### SETTLED: seven citations were FALSE PARITY CLAIMS, not just dead names

A dead name costs navigation. A comment asserting the engines do the same thing, where one does not
do it at all, is an unbacked correctness claim. All seven are now corrected in place; three were
settled by measurement rather than by reading:

- **No native counterpart exists** for `bfs_reducible` (Rust enforces the same condition at PARSE,
  in `gql::Parser::shortest_pattern`), `extra_etypes`, or **`any_match_reachable` — which means the
  TS `EXISTS`-over-var-length BFS reachability shortcut is a TS-SIDE WIN THE NATIVE ENGINE LACKS.**
  The `Expr::Exists` arm of `exec::evaluator::eval` fast-paths a bare vertex hop only and nothing in
  `opt` rewrites the var-length case. Unpriced; do not assume parity here.
- **`suggest_procedure`** claimed both engines' "did you mean" faults "read identically". MEASURED:
  TS says `unknown procedure: pageRank (did you mean 'pagerank'?)`, native says
  ``lenke: query: unknown procedure `pageRank` ``. Both REJECT, so it is a DX gap and a
  message-text difference — the same class as the open cast-message divergence, not a wrong answer.
- **`free_predicate_vars`** claimed a mirrored free-variable walk. MEASURED: the behaviour DOES
  match by a different mechanism (native parses a validator predicate in a scope holding only the
  bound variable, so a free name is an ``unknown variable `q` `` parse error). Both accept
  `p.age > 0`, both reject `q.age > 0` and `p.age > 0 AND q.age > 0`. Claim narrowed, not withdrawn.
- **`pattern_rank`** was the strongest and is fully refuted: _"Mirrors native `pattern_rank` in
  `gql/eval/pathfind.rs` exactly — the two must agree or the engines emit rows in different
  orders."_ That file and function do not exist, nothing in the crate ranks patterns, **and row
  order between the engines is unspecified by policy** — which is why `conformance-harness.ts`
  compares structurally. The comment asserted an invariant the project had already abandoned.
- **`unknown_fns` / `run_cquery_body`** (4 sites): native rejects an unknown function EARLIER than
  claimed — at parse, in `gql::Parser::call`. The property being defended holds more strongly.

### SETTLED: bare `ANY` / bare `ALL` — the engines AGREE, and the RUST doc was wrong

`gql::Parser::parse_shortest_selector`'s doc said bare `ANY`/`ALL` without `SHORTEST` "are errors
here". They are not: it returns `None` and `gql::Parser::parse_bare_selector` owns them. Measured on
a two-route fixture (`a→b→c`, `a→d→c`): bare `ANY` 9/9, `ANY SHORTEST` 9/9, bare `ALL` 10/10,
`ALL SHORTEST` 10/10, no selector 10/10. Rust doc corrected.

**FIXTURE TRAP, ninth instance.** The first probe used a 3-node PATH graph and returned **6 for
every variant** — on a path graph "every walk" and "one walk per endpoint" are the same six rows, so
the probe could not have distinguished them whatever the truth was. Before writing a selector
fixture, give some endpoint TWO routes.

(Both engines treating bare `ANY` as ANY SHORTEST is a SHARED behaviour → a conformance question
about the pair against ISO, not a byte-identity one. Not opened.)

### OPEN: citation rot runs BOTH directions and only one has an instrument

`exec/nested.rs` cited `pathfind::StepRec` and `pathfind::bind_unit`, and `gql.rs` cites
`read_type_name` — the TS engine has no `pathfind` module (retired `lenke-core` vocabulary). The
first two are fixed. **`bun run xref` walks TS→Rust only**, so Rust→TS citations have no probe;
these were found by hand while doing something else, which does not repeat.

### REFUTED as a shortcut, do not re-derive

Mechanical resolution by token overlap. Tried first and it is not good enough to trust: it scored
`val_eq` → `eq`/`val` (the real answer is `value::equals`, which shares no token) and offered
plausible-but-wrong candidates elsewhere. **A wrong new citation is worse than a dead one** — it
reads as live and sends the reader somewhere real but unrelated. Each of the 61 was resolved by
reading the crate.

## 615 — edge id lookup: O(E) → O(1) in the native engine, 116x on the write path

**FIXED. `Store::edge_by_ext` was O(E log E) with an allocation per call, and `Plan::EdgeSeed`
built its own ext→edge `HashMap` over every live edge on EVERY pull.** Nodes have always had
`ext_to_node`; edges had no reverse map. The INSERT identity path calls `edge_by_ext` once per
edge carrying an explicit string `id`, so **inserting N such edges into a graph of E was
quadratic** — and `encode` emits edge ids, so every reloaded snapshot takes that path.

|                                      | before           | after               |
| ------------------------------------ | ---------------- | ------------------- |
| INSERT edge w/ explicit id, E=2,000  | 11,870 ns        | 671 ns — **17.7x**  |
| INSERT edge w/ explicit id, E=8,000  | 31,265 ns        | 692 ns — **45.2x**  |
| INSERT edge w/ explicit id, E=32,000 | 101,374 ns       | 871 ns — **116.4x** |
| `g.E(id)`, 200,000 edges             | **7,681,609 ns** | **31 ns**           |

Min-of-3 alternated against a detached pre-fix worktree. **The ratio grows with E** because
before was O(E) and after is O(1), so no single number characterises it. Four control rows
(edge-no-id, node-explicit-id, node-no-props, edge-no-props) sit at **0.96-1.01x**.

**Why `ext_to_edge` is not the invalidated-on-write cache the user ruled out:** `edge_ext` is
immutable after creation (verified: one push site, never rewritten), so **no write invalidates
the map — a write only EXTENDS it.** Delete leaves the entry and liveness is filtered at lookup,
as `node_by_ext` already does for tombstones. The map is `None` until something asks for an edge
by id, so a graph that never does pays one `is_some` branch per `add_edge`. **Ingest is flat:
`nodes+5edges x2 props` decode 0.993x**, min-of-3 alternated. The O(E) build is once per store
on first lookup (≈0.77 ms at E=32,000).

### SETTLED: the TS engine already did this right — a citation can be true of the ANSWER and hide a 116x cost gap

`insertEdgeWithId` checks `graph.getEdgeById(id)`, an O(1) `edgesById` Map maintained on
`addEdge`/`removeEdge`. So this was a **Rust-only** defect in the engine that is otherwise
1.5-4x faster, and TS was the proof the design is cheap on write. Its comment says _"Mirrors
native `insert_edge_with_id`"_ and that was TRUE — of the result. **Item 614 catalogued
citations claiming a parity that did not exist; this is the inverse class it did not name: a
behaviourally accurate citation concealing an asymptotic gap.** A cross-engine comment asserts
the same answer, never the same cost, and nothing measures the difference.

### SETTLED: the seed family had never been priced, and `plan_cost_by_operator` structurally cannot

That harness wraps every case around the same 200,000-row scan; a seed produces ONE row, so
wrapping a scan around it measures the scan. **The unit for a seed is the SEEK.** New
`#[ignore]`d harness `seed_cost_by_entry_point` (two floors — pull overhead, and overhead + one
failed hash probe — because one floor cannot separate the probe from the batch build):

| entry point                           | ns/seek      | note                                                            |
| ------------------------------------- | ------------ | --------------------------------------------------------------- |
| `NodeSeed` empty (pull floor)         | 32.5         |                                                                 |
| `NodeSeed` miss                       | 47.5         | the failed ext hash probe is ~15 ns                             |
| `NodeSeed` 1 id                       | 65.1         |                                                                 |
| `NodeSeed` 64 ids                     | 1003         | **15.7 ns/id** — per-pull overhead dominates a single-id seed   |
| `EdgeSeed` 1 id                       | 53.7         | was 7.68 **ms**                                                 |
| `IndexSeek` unique key, hash          | 104          |                                                                 |
| `IndexSeek` same key, NO index → scan | 252,257      | the hash index is worth **~2,400x** on a point lookup           |
| `RangeSeek` with range index          | 9.94 ns/row  |                                                                 |
| `RangeSeek` NO index → scan           | 276.9 ns/row | **27.8x**, matching the interval-index family's recorded 27-28x |

### FIXTURE TRAP, tenth instance — now about a POLICY in two places

The "lowest eid wins for a duplicate external id" policy lived in both the lazy build and the
incremental insert hook, each with its own `or_insert`. Flipping ONE to last-wins **survived the
entire suite**, because the only fixture with a duplicate edge id comes from NDJSON decode,
which builds the map lazily and so never reaches the incremental copy. Fixed by collapsing it to
one site (`Store::note_edge_ext`). **Two copies of a policy need two mutants, or one site; a
single mutant against one of two copies proves nothing.** The other three mutants (liveness
filter, fallback scan, insert-time maintenance) were caught first time.

That lowest-wins is correct had to be MEASURED, since the write path rejects duplicates and
cannot create the case: NDJSON decode accepts it, and both engines answer `w = 1` (the first).

### OPEN: duplicate external edge ids — the engines disagree on the edge COUNT

Two NDJSON edges sharing `id: "dup"`: native keeps **2** edges, TS keeps **1** (its `edgesById`
`Map.set` collapses the pair). Both agree `g.E('dup')` resolves to the `w=1` edge, so only the
COUNT diverges. Pre-existing, found while fixing the above, and NOT touched — decode semantics
is not a perf decision. See [[cross-engine-divergences-open]].

### Instrument note: a mutation harness must TOUCH what it restores

`shutil.copy2` preserves mtime, so a restored pristine source looks **older than the compiled
test binary**: cargo skips the rebuild and the next run executes **the mutant** while the
harness reports a clean tree. It surfaced as a new test failing in the full suite and passing in
isolation. `shutil.copy` + `os.utime`.

### The `bench_all` screen produced its SIXTH false positive

`query/gql pred AND exists` flagged at 1.161x; **refuted at 0.998x** on the isolated
`query_bench gql` row, min-of-5 alternated, with 34 sibling rows as controls and nothing over
1.081x. Joins 83, 84, 85, 89, 91. It is a screen, not a verdict.

## 616 — `coalesce(values('k')).path()` dropped the value in native; and the fuzzer that found it cannot find the class

**FIXED, a cross-engine WRONG ANSWER.** The all-`values` `coalesce` fast path in `gremlin.rs`
lowers to `Filter + Project(Case)` and `return`ed its plan directly, outrunning
`Parser::maybe_path_record` — so the projected value never entered the Gremlin step-history and
`g.V().coalesce(values('name')).path()` gave `path[v[1]]`.

**TinkerPop 3.7.3 in a real console gives `path[v[1], marko]`** and the TS engine agreed with
TinkerPop, so native was the wrong side. Fix is one line: route the fast path's plan through
`maybe_path_record(p, "values")`, so it records with the same `STEP_SCALAR` tag and the same
slot as the plain `values` step — agreeing with the slow path by construction, not coincidence.

Every sibling was already correct — `union(values)`, `optional(values)`, plain `values`, and
`coalesce` of HOPS all agreed — which is what narrowed it to the fast path. The neighbouring
early `return`s in the branch lowerings are REDUCERS (`count`/`sum`/`fold`), which set
`frontier_from_reducer` because TinkerPop resets the path at a reducing barrier; those are
correctly unrecorded. **An early `return` in a lowering is where a cross-cutting wrapper gets
lost, and this fast path existed for speed — an optimization created the bug.**

**NOT caused by item 615, established by replay not by argument:** `git checkout HEAD~1 --
store.rs exec.rs`, rebuild, same seed → identical divergence. Pre-existing.

### 🛑 SETTLED: `gremlin-fuzz` found this by LUCK — do not read a clean sweep as coverage

`FUZZ_SEED=3183304986` reproduces 100% of the time, so it is not the known residual (whose
defining property is that it [[gremlin-fuzz-families]] _replays clean_). But the generator
produces the shape vanishingly rarely, and that was MEASURED rather than assumed — by running
the sweep against the code with **the fix reverted**, which is the only thing that makes a clean
sweep mean anything:

| sweep            | seeds | traversals | hits  |
| ---------------- | ----- | ---------- | ----- |
| **fix reverted** | 12    | 4,800      | **0** |
| **fix reverted** | 60    | 24,000     | **0** |
| fixed            | 60    | 24,000     | 0     |

**The sweep cannot find the bug it was hunting.** So "60 clean seeds" is NOT evidence that
sibling instances of this class do not exist, and item 616 does not claim it is. Rarer than 1 in
24,000 traversals; CI hit it on a random seed. The rule from `rewrite_fuzz` generalizes beyond
mutants: **a generative sweep whose teeth were never verified is worse than no sweep, because it
is believed.**

The durable guard is a TABLE: `a_branch_step_over_a_value_body_extends_the_path` pins eleven
spellings (one-arm / two-arm / first-arm-absent `coalesce`, `union`, `optional`, plain `values`,
each again behind a hop, plus `coalesce(id())` and `coalesce(label())`), asserting the path
length and that the last element is not a node. Teeth verified: with the fix reverted it fails
on its first case.

### Method note: the narrowing, which is reusable

One fixture decoded from the SAME ndjson into both engines — the fuzz suite's own comment warns
that a fixture built two ways makes drift read as a divergence. Then remove one element of the
traversal at a time. Four controls agreeing (`values` alone, `union`, `optional`, `coalesce` of
hops) is what turned "coalesce + path + fold + a hop diverges" into "the all-values fast path
does not record", which is a one-line fix rather than a hunt.

## 617 — GQL point lookup BY ID: a 7,513x cliff against Gremlin, now 1,258x faster (native)

**FIXED (native). `Plan::NodeSeed` was constructed in exactly ONE place in the crate — the
Gremlin parser.** GQL has `element_id(n)` as a scalar function and nothing that turned a
predicate over it into a seed, so _"give me the element with this id"_ — the most common
serving query there is — was a full label scan with an `element_id` call and a string compare
per node.

Found by adding the pair to `spelling_probe` as a group, which is its charter: `g.V('12345')`
below the timer's resolution against `MATCH (n:Person) WHERE element_id(n) = '12345'` at
**1.803 ms**, same single row, 100,000 nodes — **a 7,513x spread.** Now converged.

End-to-end through the FFI, two `.so` files (the "before" built from a detached worktree at
HEAD), min-of-3×9 alternated:

|                                | before         | after       |           |
| ------------------------------ | -------------- | ----------- | --------- |
| **GQL `element_id(n) = $x`**   | **1775.79 µs** | **1.41 µs** | **1258x** |
| Gremlin `g.V(id)` — control    | 1.76           | 1.70        | 1.03x     |
| GQL indexed property — control | 1.79           | 1.84        | 0.97x     |
| GQL label-scan count — control | 1.11           | 1.12        | 0.99x     |

The seeded lookup is now cheaper than the indexed-property lookup, as a direct `ext_to_node`
probe should be. A bound `$param` reaches it: `bind_params` runs BEFORE `opt`, verified by
dumping `Param("x")` → `Lit(Str("4"))` → `NodeSeed`.

**`Plan::NodeSeed` gained `label: Option<String>`** (as `IndexSeek`/`RangeSeek` always had).
Without it the rewrite drops the `MATCH (n:Person)` constraint and returns a node of the WRONG
label. `exec` applies it via `store.is_labeled` (binary search of the sorted bucket, O(log
|label|)). Gremlin's `g.V(ids)` passes `None`. Also seeded as a CONJUNCT (`Seed::Id`), ranked
above every rung and gated on nothing — at most one row, so nothing can beat it — because
otherwise `… = $x AND n.age > 0` would stay a scan while `… = $x` alone seeded: a new cliff
created by fixing the first.

**Declines, each safe because declining leaves `Filter(Scan)`:** non-`Eq`; a non-`Slot(0)`
argument; a NON-STRING literal (an id IS a string, so `element_id(n) = 5` matches nothing and
seeding `"5"` would **invent a row** — mutation confirms this guard load-bearing); NULL.

### 🛑 `rewrite_fuzz` was STRUCTURALLY BLIND to the new rewrite — widen before trusting green

The generator's only `Expr::Call` is `ln`; it could not emit an `element_id` predicate at all,
so a green `rewrite_fuzz` said **nothing** about this rewrite. Widened with a new predicate
kind (both operand orders; hits, misses, and a numeric literal so the declines generate too),
added to `SEEKABLE_KINDS`. Coverage then: **1 plan in 2,000.**

Diagnosing that found a gap wider than this item:

> **The generator never emitted a filter DIRECTLY over the `Scan`.** `gen_seed` returns a bare
> `Scan` and every filter attaches at the LANDING slot or above, so a slot-0 predicate only
> ever reached the scan by PUSHDOWN — and the `Plan::Scan` arm of `apply` hosts EVERY seed
> rewrite (`IndexSeek`, `RangeSeek`, the multi-seek union, `seed_from_conjuncts`, `NodeSeed`).
> `MATCH (n:L) WHERE <pred on n>` is the commonest real shape and was the one shape absent.

A start-node predicate (`chance(1,3)`, seekable kinds) takes coverage **1 → 17** per 2,000.
Floor set at half the measurement (`n/250`), the convention the neighbouring rows use, and the
comment says plainly that **17 is thin and a count is not teeth.**

### Teeth: 3 of 4 mutants caught; the 4th is unobservable FOR A STRUCTURAL REASON

Caught: accepting a numeric literal; dropping the label in `opt`; dropping it in `exec` — each
by a direct test AND independently by `rewrite_fuzz`'s row oracles, so the 17/2000 reach is
enough teeth for those.

**SURVIVED: removing the `Slot(0)` check.** Not a coverage gap — both call sites are in the
`Plan::Scan` arm where the input width is 1, so `Slot(0)` is the only slot that exists and no
predicate reading another can arrive. **Kept as defensive**, because it is what makes
`id_seek_target` safe to call from a wider position later; its doc now says this, so nobody
deletes it believing it tested or trusts it believing it exercised.

### Instrument notes

- **A stale artifact made the first A/B read 1.09x.** `cargo build --release --tests` does not
  produce the FFI `.so`, and the last `--features capi` build predated the change, so BOTH
  libraries were pre-617. CLAUDE.md warns about the inverse (a bare release build clobbers the
  capi `.so`); the same trap arrives as a MISSING rebuild. The probe now also asserts every
  timed case returned something — a case that silently returns nothing prices as the fastest
  row in the table.
- **The `bench_all` screen flagged SEVEN rows; all seven were noise** (min-of-5 alternated on
  the isolated `query_bench` rows: 1.127x→1.055x, 1.139x→1.000x, 1.500x→0.998x, 0.855x→1.004x;
  **0 over 1.10x**). That takes this screen's false positives in this loop from six to
  thirteen.
- **A `bench_all` absolute number is not comparable to an isolated one**: `max(p.age)` reads
  1347 µs inside `bench_all` and 430 µs isolated — 3.1x, same binary, same case. Item 116's
  caution applies to the SUBJECT, not only the control.

### OPEN: the TS engine has the same cliff and it is WORSE

TS, N=100,000, min-of-9 over 200 ops: GQL `element_id(n) = $x` **4413.55 µs** against its own
Gremlin `g.V(id)` at **2.79 µs** and an indexed property lookup at **1.75 µs** — **2,522x its
own point-lookup control.** The TS planner has no id-seek shortcut either. Next item.

## 618 — TS GQL point lookup by id: 5,240x, and 7,913x for the conjunct form

**FIXED (TS), closing the gap item 617 left open with a number.** The TS seed layer is a
candidate auction (`indexCandidates` yields `SeedCandidate { count, build() }`,
`seedVertices` takes the cheapest), but a clause `WHERE` reaches it only through
`collectHints`, whose `asPropCompare` matches `prop <op> const` — so `element_id(n) = $x`,
whose operand is a `func`, produced no hint at all. New `{ kind: 'id' }` hint, an `asIdCompare`
matcher (either operand order, `=` only), and an `indexCandidates` arm that runs BEFORE the
`isIndexed(hint.key)` gate, because an id hint has no key: **`verticesById` IS its index, so it
needs no `createIndex`.**

Two dists in ONE process (`@lenke/*` resolve to dist, so a src edit is invisible until a
build), verified to differ before either was timed, alternated per round, min-of-3×9:

|                              | before         | after       |           |
| ---------------------------- | -------------- | ----------- | --------- |
| **GQL `element_id(n) = $x`** | **4401.10 µs** | **0.84 µs** | **5240x** |
| **the same as a CONJUNCT**   | **7146.23 µs** | **0.90 µs** | **7913x** |

The conjunct form was WORSE than the plain one before (the extra predicate ran over every
scanned vertex) and is the better of the two after — so this closes a cliff **between two
spellings of one query** as well as the one against Gremlin.

**Controls resolved rather than asserted.** In the full A/B they read 0.78x and 1.13x, which is
noise at 130-860 ns. Re-run with the controls ALONE at 20,000 ops a rep (the subject rows
cannot: at 4.4 ms a call that is an hour), min-of-5 alternated: indexed property 0.951x,
label-scan `count(*)` **1.025x**, and a query with no `WHERE` at all (so `collectHints` never
runs) 1.013x. **Worst control ratio 1.025x.**

### SETTLED: the TS fast path is structurally safer than the native one, and that is why they differ

A TS hint only narrows the SEED — `matchNode` and the residual `WHERE` re-validate every seeded
row — so it may yield a SUPERSET of the true matches but never a subset. Consequences:

- **`Plan::NodeSeed`'s hand-carried `label` (item 617) has no TS analogue**: the label is
  re-checked anyway.
- A non-string comparand would be SOUND to seed on here (re-validation would drop it). It is
  still restricted to a string at the point of use, **deliberately**, so the two engines seed on
  the same shapes — parity of behaviour being worth more than the extra case.

### SETTLED: the two engines' id fast paths are byte-identical BY DIFFERENT MECHANISMS

Native REWRITES the plan into a labelled `Plan::NodeSeed` and DROPS the predicate; TS seeds a
superset and re-validates. They were written independently, and **nothing was comparing them** —
the GQL differential fuzzer's generator emits no `element_id` predicate. Two new cases in
`gql-conformance.test.ts`, 15 queries, pin it: hits in both operand orders, labelled and
unlabelled; the label exclusion; both conjunct orders (including one whose second predicate must
still eliminate the row); a missing id; the non-string and range declines; an id read on the FAR
SIDE of a hop, which neither engine may seed from; and the `$param` form. All byte-identical.

### Teeth: four mutants, all caught — and the signal is a SPY, not a stopwatch

A seed is a route CHOICE, and route choices are answer-equivalent: a version that silently
declined and scanned returns exactly the same rows, so a rows-only test cannot tell them apart
and every mutant survives it. The tests therefore count calls to `Graph.getVertexById` (an own
arrow property, so replaceable) — the seed path calls it, the label scan never does, which makes
"did it seed" a deterministic binary observation rather than a timing comparison.

Caught: `asIdCompare` never matching (3 fail); the string guard dropped (1); `build()` yielding
the empty set (5); the seed resolving the wrong id (5). **The TS tests import `./index.js` —
source, not dist — so no rebuild is needed per mutant, which is what makes mutating the TS side
cheap enough to be routine.**

**FIXTURE TRAP, eleventh instance.** The range-decline test asserted `[]`, which is the correct
answer (`'v10'`..`'v38'` all sort BELOW `'v8'` in string order, and the only id above it carries
the other label) — but an empty expectation passes just as well if the declined path returns
nothing at all. A range that DOES match now follows over the same declined path and must produce
every `P` vertex.

## 619 — ⚠️ PRICED AND NOT BUILT: a GQL point lookup by EDGE id, 1,143x (native) / 9,027x (TS)

The unfinished symmetry of 617/618, which seeded NODES. `MATCH ()-[r:R]->() WHERE
element_id(r) = $x` has **no seed in either engine**. Measured, 20,000 nodes / 100,000 edges,
min-of-7 over 50 ops, both engines in one process:

|                                                 | TS            | native       |
| ----------------------------------------------- | ------------- | ------------ |
| **GQL `element_id(r) = $x`**                    | **28,888 µs** | **2,274 µs** |
| GQL `r.w = $w` — the same walk by edge PROPERTY | 2,449         | 196          |
| Gremlin `g.E(id)` — already O(1) since item 615 | 3.20          | 1.99         |

**TWO separate costs, and they want different fixes:**

1. **No seed** — the O(E) walk. Removing it needs real SLOT SURGERY, not the node-for-node
   swap `id_seek_target` does: an edge pattern binds its ENDPOINTS, so
   `Filter(element_id(edge_slot))(Expand{bind_edge}(Scan))` has to become `EdgeSeed` plus
   `EdgeVertex` work that reproduces the exact slot layout every downstream expression reads.
   `Plan::EdgeSeed` is ready for it — item 615 made it O(1) per id. This is the 1,000x half and
   the risky one.
2. **`element_id` is ~12x an edge-property read over the SAME walk** (2274 against 196 native,
   28888 against 2449 TS — the ratio holds in both engines). The `Expr::Call` arm of
   `exec::evaluator::eval` materializes the id PER ROW: a `GStr` clone and a boxed `Value::Str`
   each, where `r.w` reads a typed column. **This half needs no plan surgery**, and it also
   fixes the FAR-SIDE node case 617 cannot seed (`WHERE element_id(b) = $x` after a hop reads a
   slot the `Scan` does not produce, so it stays a filter — covered by the conformance test
   added at 618, and currently scanning).

**The sound shape for (2) is a symbolic `Expr`, NOT a baked dense id.** Resolving the literal to
a dense id at optimize time and comparing `Slot(n)` numerically works TODAY — both caches in
`parse_cache` hold PARSED plans and `optimize_indexed` runs per call, so an optimized plan is
never reused across stores — **but it makes the optimized plan STORE-DEPENDENT, which would
break silently the day anyone caches one.** An `Expr` carrying the external id and resolving it
ONCE PER BATCH (O(1) through `ext_to_node` / `ext_to_edge`) is store-independent, cacheable, and
gets the same per-row dense compare. Checked rather than assumed: the cache-shape question was
settled by reading `parse_cache`, not inferred from item 229's title.

Numbers are recorded beside both candidate sites (`opt::id_seek_target`'s header and the
`element_id` arm of `exec::evaluator::eval`) so neither is re-derived.

## 619b — half of 619 BUILT: `element_id` filters over borrowed ids, 5.28x / 6.33x

**FIXED (native), the half of 619 that needs no plan surgery.** `try_filter_keep_element_id`
compares `element_id(x) <Eq|Ne> '<lit>'` over a BORROWED `&str` per row instead of letting
`eval` build a `Vec<Value>` of `Value::Str` — a `GStr` clone and a box per row. Two libraries,
alternated, min-of-3×7, 20,000 nodes / 100,000 edges:

|                                            | before     | after     |           |
| ------------------------------------------ | ---------- | --------- | --------- |
| **EDGE id filter**                         | 2106.45 µs | 398.73 µs | **5.28x** |
| **FAR-SIDE node id filter**                | 2041.56 µs | 322.28 µs | **6.33x** |
| edge property `r.w = $w` — control         | 194.27     | 195.38    | 0.99x     |
| NEAR-side node id (617 seeds it) — control | 1.78       | 1.56      | 1.14x     |
| label-scan count — control                 | 1.54       | 1.46      | 1.06x     |

**STILL OPEN: half (1) of 619, the actual seed**, which needs slot surgery because an edge
pattern binds its endpoints. The remaining gap is **2.1x to the edge-property floor** (399
against 195) — a string compare against a raw f64 one over the same walk, which is this half's
honest ceiling.

The far-side node case was not in 619's pricing and is the second shape fixed: `WHERE
element_id(b) = $x` after a hop reads a slot the `Scan` does not produce, so item 617's seed
rewrite correctly declines.

### 🛑 THE FIRST VERSION OF THE TEST NEVER REACHED THE CODE IT TESTED

Two mutants survived, and not because the assertions were weak. **Instrumenting the arm with an
`eprintln!` showed it NEVER FIRES for a `RETURN count(*)` query** — an aggregate over a filtered
hop takes a different route — while the same predicates as a PROJECTION fired 12 times. The test
was therefore comparing the general path against itself for exactly the cases it existed to
cover, and a mutant COERCING a numeric literal to `"3"` passed it.

**"Verify the planner reaches the shape" has a twin at the EXEC layer: verify the FAST PATH
reaches the shape, and INSTRUMENT it rather than infer it — the plan was identical in both
spellings, so a plan dump could not have told the difference.** Rewritten as projections (also
the shape the A/B measures), the coercion mutant is caught.

Second test bug, the fixture trap in my own work: the decline test's fixture had **no edges**, so
its far-side assertion passed whatever the arm did. It now builds edges and asserts the control —
the STRING spelling must find the node, else the zero proves nothing.

### The ORACLE needs its own mutant

`element_id(x) >= 'v' AND element_id(x) <= 'v'` is `= 'v'` under the value contract's total
order, and both conjuncts carry an ORDERING operator the arm declines — so the oracle runs on
`eval` while the subject takes the fast path. One mutant exists purely to guard that: _accept
ordering operators_, under which the oracle joins the subject on the fast path and the
differential compares the fast path with itself. It is caught. **A differential whose oracle
silently joins the subject is the quietest way for this kind of test to stop testing.**

### SETTLED: the `u32::MAX` sentinel check is REDUNDANT (mutation, not assumption)

Deleting it changes no answer: `node_ext_id_ref(u32::MAX)` is out of bounds and returns `None`,
so the next guard drops the row. Kept as documentation of intent, with a doc note saying so, so
the surviving mutant is not later read as a hole. The BEHAVIOUR is pinned either way.

### SETTLED, for the SIBLING arm: the OPTIONAL-miss shape IS reachable

`try_filter_keep_call`'s comment declares its `coalesce`-on-sentinel decline unmeasurable
because _"`WHERE` inside `OPTIONAL MATCH` is rejected by the parser"_. The clause `WHERE` is —
**but the trailing `FILTER` spelling is not**, and it lands a `Filter` directly over the
optional hop: `MATCH (a:N) OPTIONAL MATCH (a)-[:R]->(b) FILTER element_id(b) <> '1'` returns 0
where comparing the sentinel would return 3. That pair of spellings is what `spelling_probe`
tracks under "a trailing FILTER vs a clause WHERE", so **that decline can now be measured.**

### The `bench_all` screen flagged seven and FOUR were the screen's own fault

Four were `query/seeded` **col2, which is `speedup` — a DERIVED RATIO** over an `index_us` of
0.3 µs, at the timer floor. The screen script compares every numeric column as if it were a
time. **A screen should compare TIME columns; a derived ratio is not a measurement.** Of the
rest, two were "faster" and the one real candidate (`query/shortest repeat-group control`,
1.123x) **refuted at 1.018x** on the isolated row. Zero over 1.10x. This screen's false
positives in this loop now number **twenty**.

## 620 — an edge id pins a hop to ONE source node: 160x (178x for the labelled spelling)

**FIXED (native). The half of 619 that "needs slot surgery" needed none.** 619 priced it as
replacing `Filter(element_id)(Expand{bind_edge}(Scan))` with an `EdgeSeed` + `EdgeVertex` chain
that reproduces the `[src, edge, dst]` layout and replicates `expand`'s lineage. **Replace only
the `Scan` instead:** `Plan::EdgeEndpointSeed { ext, source_end, label }` yields the ONE node at
an end of that edge, and the `Expand` and every `Filter` stay where they were.

|                                              | before    | after   |                       |
| -------------------------------------------- | --------- | ------- | --------------------- |
| **EDGE id filter**                           | 411.28 µs | 2.57 µs | **160.15x**           |
| **EDGE id, BOTH ends labelled**              | 603.24 µs | 3.38 µs | **178.21x**           |
| `Dir::Both` — declines                       | 820.68    | 813.57  | 1.01x                 |
| far-side node id (619b)                      | 328.83    | 334.65  | 0.98x                 |
| edge property, near-side node id, label scan | —         | —       | 1.00x / 1.09x / 1.02x |

**Cumulatively 619b + 620: 2274 µs → 2.57, i.e. 885x, now at parity with Gremlin's `g.E(id)`
(1.99 µs)** — the convergence `spelling_probe` wants.

### SETTLED: the safety argument is "narrow a SEED, never a filter"

Because every filter keeps its place, the hop's output is a SUPERSET of the query's rows before
the filters and identical after. Consequences: the slot layout is untouched (so no downstream
slot reference changes meaning), lineage needs no replication (`Expand` still builds it), and a
conjunct that EXCLUDES the pinned edge's source still removes the row — asserted, not claimed.
**This is the TS seed layer's property, which item 618 recorded as the safer of the two designs;
620 is the native engine borrowing it.**

The plan carries the EXTERNAL id and resolves it at exec, so the optimized plan stays
STORE-INDEPENDENT — item 619's recorded hazard is named and not spent. A test re-runs the SAME
optimized plan after deleting the edge and gets zero rows.

### SETTLED: put it BEFORE `apply_local`'s match, not in it

As an arm, the rewrite's correctness depended on ARM ORDER — the position it needs sits directly
above an **unguarded catch-all `bind_edge: true` arm** that matches every bound-edge expand —
and the shape spans THREE plan levels while the arms dispatch on one. Checking before the match
removes both problems. Termination is structural: after the rewrite the hop's input is an
`EdgeEndpointSeed`, which `scan_under` rejects.

### SETTLED: ONE intervening filter is load-bearing, and the cliff proves it

A landing node's LABEL lowers to exactly one `Filter(IsLabeled{slot})` between the hop and the
pin, and filter-merge declines to fuse them (an `element_id` call can raise). Without looking
through it, `MATCH (a:P)-[r:R]->(b:P)` would scan while the unlabelled spelling seeded. Measured:
the labelled form was **603 µs — the SLOWER of the two spellings — and is now 3.38**, within
1.3x of the unlabelled. The same mechanism covers a conjunction, where the pushdown arm fires
first and leaves `Filter(Scan)` as the driver.

**Declines** (each would make the seed a SUBSET and lose rows): `Dir::Both` — a `Both` hop over
a full scan yields the edge from BOTH endpoints, measured as TWO rows; `double_loops`; an `Or`;
`from != 0`; `bind_edge: false`; a non-string comparand.

### 🛑 `rewrite_fuzz` WAS BLIND AGAIN — 0/2000 — one slot over from item 617's

`gen_edge_pred` emitted only edge-PROPERTY comparisons and an `IsLabeled`, so no generated plan
pinned an edge id and **a green `rewrite_fuzz` said nothing about this rewrite.** That item 617's
blindness recurred immediately, in the sibling generator, is why it is a RULE: **widen the
generator and measure the reach before reading green as coverage.**

Widened (both operand orders; usually a real `e<k>` so the seed hits, sometimes a miss, sometimes
a node-shaped id). Reach **0 → 6 per 2,000**, floor at half. **Six is thin and is not treated as
coverage** — the rewrite fires only when the bound-edge hop is the FIRST one. The teeth are
mutation, and at 6/2000 the row oracles caught **all five**: `Both` seeded, `source_end`
inverted, the pin taken from an `Or`, the label dropped, and a pushed-down filter discarded.

Twelve deterministic cases pin the rest, each asserting the OPERATOR then the rows — a route
choice is answer-equivalent, so rows alone cannot distinguish a silent decline from a working
seed.

### The `bench_all` screen flagged three; all three refuted

`query/gremlin dedup out.out` 1.183x → **1.010x** at min-of-5 on the isolated row; one "faster";
one a 0.2 → 0.3 µs timer-floor cell. Zero over 1.10x. **Twenty-three** false positives from this
screen in this loop.

### OPEN: the TS twin is NOT the same shape of problem

TS's GQL edge-id lookup remains **28,888 µs**. Its seed layer takes hints per NODE
(`indexCandidates` is called from `seedVertices`), so pinning a hop by its EDGE id has no hook
there — unlike item 618, where the hint mechanism already existed and only lacked a kind. The
next item, and its design is genuinely open.

## 621 — the TS twin of 620: an edge id pins a hop, 8,054x (and 12,068x for the `in` spelling)

**FIXED (TS).** `collectHints` has always keyed hints by VARIABLE, rel variables included — so
618's `asIdCompare` was already producing an `{kind:'id'}` hint for `element_id(r)`, and
`attach` was already **dropping it**, because it only ever looks up NODE variables. A rel's
pinned id names ONE node the hop can start from; `{kind:'edgeEnd', value, sourceEnd}` carries
it to that node and `indexCandidates` resolves it with two O(1) `Map.get`s.

Two dists in one process, alternated, min-of-3×7, 20,000 nodes / 100,000 edges:

|                                 | before      | after    |                             |
| ------------------------------- | ----------- | -------- | --------------------------- |
| **EDGE id, out hop**            | 29449.63 µs | 3.66 µs  | **8054x**                   |
| **EDGE id, in hop**             | 44427.08 µs | 3.68 µs  | **12068x**                  |
| **EDGE id, both ends labelled** | 7889.67 µs  | 4.93 µs  | **1601x**                   |
| undirected — declines           | 87900.70    | 88553.43 | 0.99x                       |
| edge property, node id (618)    | —           | —        | 0.99x / 1.25x (a ~1 µs row) |

**BOTH ends of a pinned segment are pinned, not just the one the hop drives from.** A pinned
edge names each of its endpoints, so whichever side `orient` starts from is seeded to one node.
Pinning only the near side left `MATCH (a:P)-[r:R]->(b:P)` at **7818 µs against the unlabelled
spelling's 3.00** — measured — because with both ends labelled `orient` starts from the FAR
node. Same class of cliff item 620 closed in the native engine, reached by a different route.

**Declines** (each would make the seed a SUBSET and lose rows): an UNDIRECTED hop — either
endpoint can start the walk, so the edge appears TWICE and pinning one drops a row (the native
twin declines `Dir::Both` for the same reason); and a QUANTIFIED rel, whose variable binds a
LIST of edges so `element_id(r)` is not one edge's id.

### 🛑 THE TESTS WERE VACUOUS AND ONLY INSTRUMENTATION SHOWED IT — the third time in three items

The first version asserted `getEdgeById` was called and the rows were right. All eight passed —
**and a mutant that pinned the WRONG END passed them too.** Instrumenting `build()` showed why:

> **`indexCandidates` is called by `estimateSeedFrom` as well as by `seedVertices`, so a hint
> can be COSTED without ever being used.** The spy proved the hint was considered, not that it
> seeded. On the shapes those tests used, `build()` was NEVER CALLED.

Worse, it is shape-dependent, and the map had to be measured rather than reasoned about:

| shape                                  | builds the seed?                        |
| -------------------------------------- | --------------------------------------- |
| `MATCH ()-[r:R]->() … RETURN r.w`      | YES                                     |
| `MATCH ()<-[r:R]-() … RETURN r.w`      | YES (and picks the other end)           |
| `MATCH (a)-[r:R]->() … RETURN a.k`     | YES                                     |
| `MATCH (a:P)-[r:R]->() … RETURN a.k`   | YES                                     |
| **`MATCH ()-[r:R]->(b) … RETURN b.k`** | **NO — a far-side shortcut answers it** |
| `MATCH (a)-[r:R]->(b) … RETURN a.k`    | **NO**                                  |

Rewritten on BUILDING shapes only, the inverted-end mutant is caught (4 failures). **Item 619b
learned this at the exec layer one item earlier; 621 is the same lesson at the seed layer, and
the common rule is: a spy on an input proves the input was read, not that the path ran —
instrument the OUTPUT (`build()`), and verify per shape.**

### Teeth: 3 of 5, and the two survivors are equivalent mutants

Caught: the pin never fires (by the spy — the rows CANNOT see a missing optimization, so the
two assertion kinds catch different mutants and both are needed); an undirected hop pinned; the
end inverted.

Survived, both recorded in the code rather than left as mysteries:

- **a quantified rel pinned** — the `quantifier` check is REDUNDANT, because `compilePath`
  compiles a variable-binding quantified rel to a `unit` and `unit === undefined` already
  excludes it. Kept because it states the REASON where the `unit` check states a mechanism.
- **`count: 1` unconditionally** — `count` is an ESTIMATE, not a guard: with no edge, `build`
  yields EMPTY either way, so only the candidate choice and `orient`'s estimate differ.

### OPEN

~~`MATCH ()-[r:R]->(b) … RETURN b.k` and friends are answered by a far-side SHORTCUT that
seeds its own way and never consults the pin — so those spellings still scan.~~ **WITHDRAWN at
item 622: measured FALSE.** Those spellings are already seeded, through the shortcut's existing
far-decline, because 621 pins BOTH ends. The note came from a shape map taken on a SIX-NODE
fixture, where the decline's `narrowest * SEEK_MARGIN < candidateCount` gate cannot fire. See
622 for the correction and the lesson.

## 622 — 🛑 REFUTED AND REVERTED: the far-side shortcut did NOT need the pin, and 621's "OPEN" note was wrong

Item 621 closed by naming a follow-up: `MATCH ()-[r:R]->(b) … RETURN b.k` is answered by a
far-side projection shortcut that "seeds its own way and never consults the pin, so those
spellings still scan". **That is false, and the reason it looked true is a fixture too small
for the gate under test.**

Built it anyway — `relBoundFilteredHopWalk` driving from the START node's narrowest index
candidate instead of the label bucket, with the start-label re-check a candidate source needs.
It works: the pin builds for all four far-side shapes and the rows are right. Then measured,
two dists, alternated, min-of-3×7, 20,000 nodes / 100,000 edges:

| case                          | before             | after              |            |
| ----------------------------- | ------------------ | ------------------ | ---------- |
| far-side `RETURN b.k`         | 3.55 µs            | 3.42 µs            | **1.04x**  |
| both named, `RETURN a.k, b.k` | 3.57               | 3.48               | 1.03x      |
| far-side with a far LABEL     | 3.51               | 3.54               | 0.99x      |
| (621's own shapes)            | 3.54 / 4.37 / 3.06 | 3.44 / 4.15 / 3.03 | 1.01-1.05x |
| plain hop, no pin — control   | 5068.32            | 5264.64            | 0.96x      |

**The "before" column is the finding.** 3.55 µs over 100,000 edges is not a scan — those shapes
were ALREADY seeded. Item 621 pins BOTH ends of a segment, so the far node carries a pin too,
and this shortcut has always DECLINED when the far node's candidate beats the start bucket by
`SEEK_MARGIN`. The decline hands the query to the general path, which seeds from the pin. **621
already covered this; 622 re-covered it one layer down for 1.03x.** Reverted.

### Why the gap looked real: a fixture too small for the GATE, not for the answer

The shape map in 621 was taken on a **6-node** fixture. The decline is
`narrowest * SEEK_MARGIN < candidateCount(startLabel)` — `1 * 8 < 6` is FALSE — so on six nodes
the shortcut never declines, runs its own scan, and the pin is never built. Every row is still
correct and the scan of six nodes is instant, so nothing looks wrong. On any graph where the
cost matters the decline fires and the pin IS used.

**This is the fixture trap in a form this log has not recorded before: not a fixture where two
computations coincide, but a fixture BELOW THE THRESHOLD OF THE GATE BEING STUDIED.** The
instrumentation was honest — `build()` really was not called — and the conclusion drawn from it
was still wrong, because the fixture could not reach the branch that calls it. **When
instrumenting a path guarded by a size/selectivity gate, the fixture has to clear that gate**;
`SEEK_MARGIN` is 8 and `SEEK_FLOOR_VERTICES` exists for the same class of reason.

### What stands

- 621's measured wins are unaffected (8,054x / 12,068x / 1,601x) — they were measured at 20,000
  nodes, above the gate.
- **621's OPEN note is withdrawn.** The far-side spellings are seeded, through the far-decline,
  and there is no cliff between them: 3.42-3.55 µs across all of them against 5068 µs for the
  same hop with no pin.
- The change is reverted rather than kept at 1.03x: it adds a second path that can narrow the
  seed, and two mechanisms for one decision is the thing items 615 and 620 each paid for.

## 623 — price the CONTROL-FLOW half of the operator table: 11 variants nothing had ever measured

**MEASURED, no code change.** `plan_cost_by_operator` prices 24 of `Plan`'s 55 variants,
`seed_cost_by_entry_point` prices the entry points, writes and DDL are deliberately out of
both — and what was left over had never been priced at all: the branch, quantified-path,
subquery and whole-graph-algorithm operators. `plan_cost_by_control_flow_operator` prices 11
of them.

**Every case is a COMPILED QUERY, not a hand-built plan, and that is forced rather than
chosen: none of these 11 is constructible by hand in a test today.** Every construction site
in the tree is a compiler or the optimizer, so a hand-built one would be a shape the engine
never runs. The price of compiling is that the optimizer can rewrite the operator away and the
row would then measure something else, so each case names the variant it means to price and a
`shape` column says whether the optimized plan still contains it. **A `MISSING` row is not a
measurement** — and four rows came back MISSING on the first run.

200,000 rows, min-of-5, one edge per node:

| operator                          | ns/row     | xScan     | out rows |
| --------------------------------- | ---------- | --------- | -------- |
| `Scan` (the floor)                | 0.62       | 1.0       | 200000   |
| …+Project                         | 1.69       | 2.7       | 200000   |
| `OptionalScan` (1 hit/row)        | 7.98       | 12.8      | 200000   |
| `OptionalScan` (0 hits/row)       | 9.51       | 15.3      | 200000   |
| `CallInline` (correlated)         | 8.33       | 13.4      | 1        |
| `Branch` (union, 2 arms)          | 8.39       | 13.5      | 400000   |
| `Reconverge` (union + step)       | 14.42      | 23.2      | 400000   |
| `RepeatGroup` {1,1}, list read    | 70.79      | 113.9     | 200000   |
| `RepeatGroup` {1,2}, list read    | 206.23     | 331.9     | 400000   |
| `NestedGroup` {1,2}, 2-elem unit  | 93.72      | 150.8     | 1        |
| **`PerElementBranch` (coalesce)** | **368.41** | **593.0** | 200000   |
| **`PerElementBranch` (choose)**   | **477.67** | **768.8** | 200000   |
| `Subgraph`                        | 855.28     | 1376.6    | 1        |

Small fixture, 2,000 rows, its own floor: `ShortestPath` (ANY, to one node) 3154 ns/row,
`ShortestPathEnum` 5378, `AlgoAnnotate` 82.1 (pageRank) / 41.7 (connectedComponent).

### The finding: two operators that route the same two arms differ by 44x

`union(out('R'), out('R'))` is `Branch` at **8.39 ns/row for 400,000 output rows**.
`coalesce(out('R'), out('R'))` is `PerElementBranch` at **368.41 ns/row for 200,000** — half
the output for 44x the cost per input row, **57x per output row**. `choose` is 477.67.

`Branch` runs its arms WHOLE-STREAM. `per_element_branch_exec` runs TinkerPop's per-traverser
semantics literally: per input row a `gather(&[i])` (a 1-row `Batch`, one `Vec` per column), a
`pull_body` per arm until one produces, a push into a 200,000-element `Vec<Batch>`, and a
final `concat_batches` over all of them. ~350 ns is roughly a thousand cycles to run a hop
that costs 9 ns whole-stream.

**Swept 25k → 200k: 374, 351, 366, 350 ns/row — flat.** So it is a per-row CONSTANT, not a
quadratic in the concat, and the headroom is the whole 350 ns, not a tail. Named as the
target; building it is a separate item, and the arms that may run whole-stream have to be
characterized first (a reducer arm, a lineage-carrying arm and an order-sensitive arm are not
obviously safe).

### Why four rows came back MISSING, which is the harness earning itself

- A `RepeatGroup` whose group LIST is never read **flattens to `VarLength`** (the item-570
  rewrite), so `MATCH (a)-[:R]->{1,2}(t) RETURN t.num` cannot price `RepeatGroup` at all. It is
  kept as a control: 91.25 ns/row flattened against 206.23 with the list read, so the rewrite
  is worth **2.26x** on this fixture.
- A SINGLE-element unit `((x)-[e:R]->(y)){1,1}` lowers to `RepeatGroup`, not `NestedGroup`, and
  then takes the same flattening. A nested group needs a genuinely multi-element unit.

Both are the general trap: **a query-driven pricing harness measures what the optimizer left,
not what you typed**, and without the shape column all four rows would have been published
under the wrong operator's name.

### Two operators deliberately absent

- `IntervalExpand` — the test `Builder` cannot give an edge properties, and the as-of question
  is already `examples/interval_bench.rs`, with a fixture built for it.
- `CallProcedure` — a SOURCE, not a per-row operator; its unit is the call, which is the
  `seed_cost_by_entry_point` shape.

`Subgraph`'s number is held loosely: it produces ONE row by folding every edge, so "per input
row" is the wrong unit for it, and two runs gave 390 and 855 ns/row. It needs its own harness
before anyone acts on it.

## 624 — a branch runs its arms WHOLE-STREAM: coalesce 36.5x, choose 34.6x

**FIXED (native).** Item 623 priced two routers that do the same job against each other:
`union` (`Branch`) runs its arms over the whole frontier at **8.39 ns/row for 400,000 output
rows**; `coalesce` (`PerElementBranch`) runs TinkerPop's per-traverser semantics literally, at
**368.41 ns/row for 200,000** — 44x per input row, 57x per output row, and flat from 25k to
200k, so a per-row constant rather than a tail.

|                                               | before        | after     |           |
| --------------------------------------------- | ------------- | --------- | --------- |
| **`coalesce(out, out)`**                      | 368.41 ns/row | **10.10** | **36.5x** |
| **`choose(has, out, in)`**                    | 477.67        | **13.81** | **34.6x** |
| `union` — the control the change cannot reach | 8.39          | 8.42      | 1.00x     |
| `Scan` — control                              | 0.62          | 0.62      | 1.00x     |

Both now sit beside `Branch` (8.42) and `Reconverge` (13.98), which is where the diagnosis
said they should land.

### The mechanism was already in the tree, one operator over

`CallInline` answers the identical question — run a correlated body over a whole frontier and
still know which outer row each output row belongs to — by appending a provenance COLUMN at
the outer width and reading `sub.slot(ow)` back. That is why it prices at 8.33 ns/row.

A column cannot be reused here: a branch arm is compiled over an input of width `w` and
appends its own slots AT `w`, so a prov column at `w` shifts everything the arm appends and
`out().out()` reads prov as its first hop. **So the sidecar**: `Batch::prov`, beside
`lineage`. It is not a slot, so no index moves; `Batch::gather` is the single funnel every
row-local operator already passes through, so it propagates for free; and an operator that
builds a fresh `Batch` drops it, which is the fall-back signal at no cost.

Three properties make the regrouping exact:

- **Output order is by INPUT ROW, not by arm.** Whole-stream produces all of arm A's rows then
  all of arm B's; the parts are concatenated and gathered through a **stable counting sort on
  prov**, O(rows), so an input row's group keeps its arm's internal order.
- **Widths must agree** across parts, because the per-row concat's handling of a ragged set is
  load-bearing and regrouping must not change it.
- **An error falls BACK rather than propagating.** Running an arm over N rows at once can trip
  `guard_intermediate`'s frontier cap where N one-row runs never would, and that must not turn
  a working query into `E_RESOURCE_EXHAUSTED`.

`Optional` and an `else`-less `choose` still take the per-row path: their fallback is
`source_of`, a WIDTH-1 batch mixed in among arm outputs of another width. **Routed at item
626: the deferral was over-cautious — every Gremlin arm is `Reconverge`-wrapped to width 1, so
the two agree by construction. 35.7x and 22.6x.**

### 🛑 Green tests on a path that never ran — caught by instrumentation, twice in one item

The first build passed all 1191 tests and the number did not move **at all**. The router was
bailing on every call, and the two reasons were each invisible to every test:

1. **Every Gremlin branch arm is wrapped in `Reconverge`** (gremlin.rs collapses each arm to a
   uniform width-1 frontier), which `arm_is_row_local` refused. It is genuinely row-local, but
   it builds a fresh `Batch`, so it needed the sidecar hand-off spelled out.
2. Still nothing. **`expand` gathers its input COLUMN BY COLUMN** and rebuilds with
   `Batch::of`, so it never passes through `Batch::gather` — and its `keep` vector IS the
   provenance mapping, already computed and then dropped on the floor.

Had the green suite and the correct row counts been trusted, this would have shipped as a
no-op with a 36x claim attached.

### Teeth: 7 of 7 — after the first run found a hole in the tests

The two paths are compared in ONE process by flipping a `#[cfg(test)]` `FORCE_PER_ROW` atomic
(a `const false` outside tests), row for row IN ORDER rather than as multisets — a multiset
comparison passes with the regrouping deleted.

First run: **6/7, and the survivor was `_ => true` in the whitelist** — delete the whitelist
entirely and nothing fails. The reason is worth more than the mutant: every "must refuse" case
in the test was a REDUCER (`count()`, `fold()`), and an `Aggregate` builds a fresh `Batch`, so
it drops the sidecar and falls back **anyway**. The reducer rows could not tell a whitelist
from no whitelist. What can is an arm that **gathers**: `dedup`, `limit`, `tail` and `order`
all preserve the sidecar intact while choosing or reordering rows by looking at OTHER rows.
With those four added the mutant dies. **The same shape as 619b, 621 and 622 in a new place: an
assertion satisfied by a SECOND mechanism proves nothing about the one it names.**

Caught: emitting arm-by-arm instead of by input row; every arm over every row; `choose` arms
inverted; the last arm winning instead of the first; and each sidecar hand-off removed (caught
by the fires-test, not by the rows — the rows cannot see a missing optimization).

### Controls

`expand` is the hottest operator in the engine and this adds a field read and an
`Option::map` to it. Pre-624 worktree against the working tree, ALTERNATED, min of 3:

| row                                               | pre  | post |       |
| ------------------------------------------------- | ---- | ---- | ----- |
| `Expand (1:1 hop)`                                | 4.38 | 4.31 | 1.02x |
| `Expand then EdgeVertex`                          | 7.71 | 7.76 | 0.99x |
| `Scan` / `Project (3)` / `Distinct` / `OrderPage` | —    | —    | 1.00x |

All seven byte-identity fuzzers pass, `packages/native` 931 and the TS suites 3793 pass.

### OPEN — answered at 625

The TS engine has its own branch executor and has not been priced for this. Named here, not
claimed: whether it has the same per-row shape is a measurement nobody has taken.
**Taken at item 625: the shape IS the same and the cost is NOT — `coalesce` is 1.37x a plain
hop in TS, against 44x in native. No TS twin of this change.**

## 625 — 🛑 the TS twin of 624 does NOT exist: `coalesce` costs 1.37x a hop there, not 44x

**MEASURED AND DECLINED.** Item 624 closed by naming the TS engine as unpriced, because
`coalesceStep` has literally the same shape as the native per-element router —

```ts
for (const t of stream) { for (const plan of plans) { [...applyPlanToStream(plan, [t], …)] } }
```

— against `unionStep`'s whole-stream `applyPlanToStream(plan, all, …)`. The obvious next move
was the TS twin of 624. **It is not worth making, and the probe says so.**

`packages/native/branch-cost-probe.ts`, 50,000 vertices / 50,000 edges, min of 9, confirmed at
20,000 as well:

| case                                                  | ns/row     | out rows |
| ----------------------------------------------------- | ---------- | -------- |
| `V()` — the floor                                     | 34.26      | 50000    |
| `V().out` — one hop, no branch                        | 320.81     | 50000    |
| `union(out, out)` — the control, already whole-stream | 478.36     | 100000   |
| **`coalesce(out, out)`**                              | **440.46** | 50000    |
| `coalesce(out, in)`                                   | 407.47     | 50000    |
| `choose(has, out, in)`                                | 619.56     | 50000    |
| `coalesce(MISS, out)` — both arms run                 | 684.65     | 50000    |

**`coalesce` is 1.3-1.7x a plain hop (three rounds at 50,000: 1.66, 1.30, 1.36 — the hop row
is the noisy one, ranging 263-325 ns while `coalesce` holds 388-436). The native gap was 44x.**
Per INPUT row `coalesce` is consistently CHEAPER than `union` (0.86-0.92x across the same three
rounds), which is the clearest statement of the result: the per-element router is not the slow
one here.

### Why the same shape is not the same cost

The native gap existed because a COLUMNAR engine pays a `Batch` allocation per row to run
per-row: a `gather(&[i])` builds one `Vec` per column for a single row, and the arm then runs
its whole operator machinery over it. The TS engine is a GENERATOR PIPELINE whose unit
already IS the traverser — a hop is a generator resume per element whether or not a branch is
above it — so there is no whole-stream advantage sitting there to be recovered. `union` is not
cheaper per input row either (478 against `coalesce`'s 440); it simply emits twice the rows.

**This is the inverse of item 622.** There the change was built and the measurement retracted
it. Here the measurement came first and there is nothing to retract — which is the cheaper
order, and the reason the probe was written before the port.

### What the probe did turn up, named rather than claimed

- `choose` costs **1.41x `coalesce`** (619.56 vs 440.46). The difference is `chooseStep`
  running its test through `applyPlanToStream(test, [t], …)` — the full plan dispatch and a
  one-element array per traverser — to answer `has('num', 1)`. Compiling a filter-only test to
  a predicate once is the obvious shape of a fix. It is ~1.4x on one step, far below the rungs
  this loop has been taking, and it is recorded here rather than started.
- `coalesce(MISS, out)` at 684.65 confirms the per-row cost is roughly linear in the arms
  actually RUN, not in the arms present — which is the same peeling behaviour 624 gave native.

The probe stays as `branch-cost-probe.ts` so the next person asking "is the TS branch slow?"
reads a number instead of a shape.

## 626 — `optional()` and an else-less `choose` join the whole-stream router: 35.7x and 22.6x

**FIXED (native).** Item 624 routed `coalesce` and `choose`-with-`else` whole-stream and
DEFERRED the two kinds whose fallback is the SOURCE element rather than an arm, because
`source_of` is a width-1 batch that could mix with wider arm outputs in the concat. Priced at
623's harness they were still on the slow path, so the deferral was worth ending.

|                                               | before        | after     |           |
| --------------------------------------------- | ------------- | --------- | --------- |
| **`optional(out)`**                           | 382.43 ns/row | **10.70** | **35.7x** |
| **`choose(has, out)` — no else**              | 206.95        | **9.16**  | **22.6x** |
| `coalesce` / `choose` with else (624)         | 10.34 / 14.02 | unchanged | —         |
| `union` — the control the change cannot reach | 8.70          | 8.70      | 1.00x     |
| `Scan` — control                              | 0.72          | 0.72      | 1.00x     |

**The deferral was over-cautious, and 624's own instrumentation is what shows why.** Every
Gremlin branch arm is wrapped in a `Reconverge` to a uniform WIDTH-1 frontier — the same fact
that stopped the router firing at all in 624 — and `source_of` is width-1, so the two agree by
construction on exactly the shapes this router serves. The width check already in place keeps
anything else on the per-row path rather than guessing.

`source_part` is the whole-stream twin of `source_of`: the source column of the unserved rows,
width-1, carrying their provenance so the counting sort places them by input row.

### The tests migrated sides without an assertion changing

`optional()` and `choose(has, out)` were already in the differential test as **"must refuse"**
cases. They now take the fast path and the test passes unchanged, because the assertions
compare the two paths rather than encode which one runs. Added the MISS-heavy variants (vertex
3 has no edges, vertex 4 only in-edges), since the source pass-through is the new code and a
miss is the only row that exercises it.

### 🛑 Teeth: 11 of 11, and two of the three rounds it took were FIXTURE problems

- **Round 1 — SKIPPED, not survived.** `source_part reads slot 0` matched **twice**: the
  per-row `source_of` it was modelled on has the same `.get(source_slot).cloned()
.unwrap_or_else(…)` text. The harness's exactly-once assertion refused to apply it. A mutant
  applied in two places tests something other than what it names, and one silently applied in
  the WRONG place is worse than one not applied at all.
- **Round 2 — SURVIVED, a genuine gap.** Re-anchored on the surrounding `seeded.gather(rows)`,
  the mutant passed every test. **Every shape in the test entered the branch on a WIDTH-1
  frontier**, where slot 0 and `source_slot` are the same read. `source_slot` really can be
  non-zero: the `gremlin.rs` call sites pass `from`, the current slot, not a constant.
- **Round 3 — CAUGHT**, after adding five shapes that enter the branch wider:
  `g.V().outE('R').optional(inV())`, its `outV()` twin, the `outE('S')` miss-heavy variant,
  `outE('R').choose(has, inV())` and `out('R').optional(out('S'))`.

Also caught: a miss treated as a hit (no pass-through), the source passing through for EVERY
row, the else-less cond inverted, plus the seven 624 regressions.

**Three times in two items a mutant found the FIXTURE too narrow rather than the code wrong**
— first the arms that `gather` (624), now the frontier wider than one slot. The rule: a mutant
survives when the fixture makes two different things COINCIDE, and the fix is a fixture that
separates them, never a weaker assertion.

## 627 — a COMPOSITE sort key compares in place: 2.70x, and up to 3.73x when the later keys decide

**FIXED (native).** Found by grepping the pattern the whole-stream work had just taught:
`sort_idx` fast-paths a SINGLE `Col::Num` and a SINGLE `Col::Str` and drops everything else
into `row_cmp`, which calls `value_at` **twice per column per comparison** — two `Arc` clones
for a string key, a whole `Value` clone for a `Gen` one — to answer a question about the bytes
they point at. `cmp_cell` answers it from the column.

Measured in ONE binary through `FORCE_BOXED_CMP`, alternated, min of 3, 200,000 rows:

| keys                                   | boxed         | in place |           |
| -------------------------------------- | ------------- | -------- | --------- |
| `num, name`                            | 169.74 ns/row | 62.87    | **2.70x** |
| `grp, num` (low-cardinality first key) | 334.97        | 90.37    | **3.71x** |
| `grp, name, num`                       | 445.49        | 119.29   | **3.73x** |
| `num` — control                        | 47.73         | 47.78    | 1.00x     |
| `name` — control                       | 58.49         | 58.46    | 1.00x     |

The gap widens with how often a LATER key decides, which is the mechanism showing itself. The
controls are 1.00x and structurally must be: `cmp_cell` is reached only from `row_cmp`, which
is reached only from `sort_idx`'s multi-key branch, so a single typed key never goes near it.

**A worktree A/B would have been WRONG here, and briefly was.** The pre-627 build does not
have these cases in its harness, so the two processes ran different case lists and carried
each other's cache and thermal state — it reported `Scan` at 0.85x and `SortLocal` at 0.84x,
for rows the change cannot reach at all. The in-process switch removes the confound entirely:
same binary, same case list, one variable.

### The element arm was DEAD, and the instrumentation is what proved it

The first version had a `Col::Nodes | Col::Edges` arm with a careful `u32::MAX`-sentinel guard.
Instrumenting every `cmp_cell` call over the whole differential fixture: **6961 `Num`, 8767
`Gen`, 2042 `Bool`, 1295 `Str`, and ZERO element columns.** A sort key that resolves to an
element is replaced by its EXTERNAL ID (`element_col_to_ext_id`) before the comparator runs,
or faults under Gremlin's `order()`. The arm could never be entered and its guard could never
be tested, so it is gone; the mutant that ADDS an element fast path survives, which is the
positive evidence for the claim rather than a gap.

### 🛑 A flaky test, and it was mine

One full-suite run failed and three passed. Rather than shrug at a one-off: **`FORCE_PER_ROW`
(624) and `FORCE_BOXED_CMP` (627) were process-global `AtomicBool`s, and `cargo test` runs
tests in PARALLEL THREADS.** The timing test that asserts the whole-stream router fires could
measure its fast side while the differential test had the per-row path forced. Correctness
tests were immune — both paths return the same rows, which is the point — so only the timing
assertion was exposed. Both switches are now `thread_local!`; four consecutive clean full-suite
runs since. **A mechanism added to make two paths comparable became a way for two tests to
interfere; a test-only global in a parallel suite is a shared mutable variable like any other.**

### Teeth: 6 of 7, the survivor equivalent by construction

Caught: `Str` reversed, `Bool` reversed, `partial_cmp` for the total order, `descending` not
applied, an equal key RETURNING instead of falling through to the next, `Gen` wrongly
fast-pathed. Survived: adding an element arm (dead by construction, above).

**The NaN mutant needed two fixture fixes and the second is the sharpest version of this
loop's recurring lesson.** `cmp_num_total` and `partial_cmp` differ only on NaN, and a stored
property can never be one (ingest maps NaN to null) — but a COMPUTED key can, so the fixture
sorts by `power(-1, half)`. That still was not enough: `half` was `i % 5` only after a first
attempt at `i % 3`, the same modulus as the `grp` first key, so inside every `grp` group either
all rows were NaN or none were and **a NaN never met a non-NaN**. Two properties keyed off the
same modulus is the fixture-coincidence trap in its purest form. (The single-key NaN shape
cannot catch it either: one `Col::Num` key takes `sort_idx`'s own pairs path and never calls
the comparator.)

## 628 — the TS sort comparator: a single-key fast path is 1.14-1.26x, and the composite half was built, measured and REVERTED

**PARTLY FIXED (TS), partly refuted.** Item 627's native fix prompted the question; item 625's
discipline answered it with a measurement first. Native after 627 pays **1.32x** for a
composite key, TS paid **2.0-2.8x** — but the cause could not be the same, because TS rows are
plain JS values with nothing to unbox. It is that `sortRowsByColumns`'s comparator runs
O(n log n) times and on every call walked `sorts` through the ITERATOR PROTOCOL and reloaded
`s.col`, `s.descending` and `s.nullsFirst` off the object.

Two dists in ONE process, alternated round by round, min of 25, 50,000 rows. Each sorted case
is read against the no-sort case with the SAME COLUMN COUNT **from the same dist**:

| case                                 | pre           | post   | sort pre | sort post |           |
| ------------------------------------ | ------------- | ------ | -------- | --------- | --------- |
| **1 col, `ORDER BY num`**            | 103.24 ns/row | 87.39  | 80.58    | 63.91     | **1.26x** |
| **1 col, `ORDER BY name`**           | 78.58         | 72.57  | 55.92    | 49.09     | **1.14x** |
| **tiny single-key sort (`LIMIT 5`)** | 105.48        | 90.54  | —        | —         | **1.17x** |
| 2 col, `ORDER BY num, name`          | 209.50        | 200.21 | 178.13   | 169.60    | 1.05x     |
| 2 col, `ORDER BY grp, num`           | 328.76        | 307.64 | 297.39   | 277.03    | 1.07x     |
| 3 col, `ORDER BY grp, name, num`     | 252.45        | 245.04 | 212.46   | 205.51    | 1.03x     |
| tiny COMPOSITE sort — control        | 326.13        | 306.70 | —        | —         | 1.06x     |
| `count(*)`, no sort at all — control | 0.23          | 0.22   | —        | —         | 1.06x     |

**Single-key `ORDER BY` is 1.14-1.26x. The composite rows are 1.03-1.07x against a 1.06x
control, which is to say unchanged.**

### 🛑 The half this item was justified by is the half that did not work

The first version ALSO hoisted the spec out of the multi-key loop into three arrays. It was
built, and the single-run numbers looked like it worked: 247.35 -> 180.23 ns/row, "1.37x".
**Against the pre-change dist alternated in one process it measured 1.00x, then 1.02x.** The
"1.37x" was the pre-change dist never being run — a single-run comparison against a number
taken at a different time, which is precisely what the alternated A/B exists to prevent.

It was reverted rather than kept at 1.00x, and not only for being worthless: the three
`sorts.map(...)` calls run per SORT CALL, so a small result set pays them and never earns
them back. The `tiny composite sort` control is in the table to catch exactly that, and it is
why a small-result row now exists at all.

`compareSort` is untouched throughout. It is the one comparator, byte-identical to the Rust
`compare_sort`, and a second derivation of "which row sorts first" is the one thing
byte-identity cannot survive.

### The instrument needed two fixes before it could be believed

Both were caught before any claim was made, and both are the same class of error as the
worktree confound in 627:

- **A one-column floor charged the sort for the extra columns' PROJECTION.** A composite
  `ORDER BY` also returns more columns; the sort's cost is the difference within a
  column-matched pair, never the ratio to a one-column baseline.
- **Timing case-by-case charged the FIRST case for the JIT tiering up.** The no-sort controls
  came out 71.7, 50.8 then 34.9 ns/row as the column count ROSE — backwards, and pure
  ordering bias. Round-robin with discarded warm-up rounds fixed it; the controls now rise
  with column count as they must.

### Teeth

The path is semantics-preserving by construction (same comparator), so the question is only
whether tests REACH the new branch. Mutated it to ignore `descending`: **26 failures** across
`packages/gql`. Restored, 0.

## 629 — the whole session measured against its baseline: no regression, and a scraping trap the corpus already warned about

**VERIFIED, no engine change.** Items 623-628 shipped six changes, three of them in `exec`'s
hot paths and one adding a field to `Batch` — which every operator in the engine allocates and
gathers. Each item had a control the change could not reach, but **a per-item control only
covers what its author thought of, and INGEST was in none of them.** So the whole session's
engine state was measured against its baseline, `2152b713` (the commit before 623), with both
builds ALTERNATED round by round in one wall-clock window, min of 3.

| row                                   | pre       | post      |       |
| ------------------------------------- | --------- | --------- | ----- |
| `ingest/phases` nodes x1 prop         | 43.58 ms  | 43.30     | 1.01x |
| `ingest/phases` nodes x4 props        | 85.80     | 86.28     | 0.99x |
| `ingest/phases` nodes+5edges x2 props | 397.72    | 396.08    | 1.00x |
| `query/gql` 1-hop                     | 489.00 µs | 487.90    | 1.00x |
| `query/gql` 2-hop                     | 3882.00   | 3840.40   | 1.01x |
| `query/gql` 6-hop                     | 10327.00  | 10319.00  | 1.00x |
| `query/gql` project 3                 | 5308.40   | 5235.20   | 1.01x |
| `query/gql` distinct node             | 117309.30 | 115885.30 | 1.01x |
| `query/gql` cmp prop/prop             | 11934.90  | 11863.40  | 1.01x |
| `query/gql` group by dept             | 373.90    | 376.90    | 0.99x |
| `query/gql` EXISTS                    | 1136.30   | 1158.10   | 0.98x |
| `query/counts` 1-hop                  | 485.00    | 469.60    | 1.03x |

**0.98-1.03x across the board. The `Batch` provenance sidecar is free**, which it had to be
shown to be rather than argued to be: it is `None` on every ordinary pull, but it rides
through every `gather` in the engine.

### 🛑 The first run of this table had a row measuring the wrong thing

`2-hop` came back as **1.68 / 1.74**, against a real 2-hop traversal of ~3900 µs. The label
matched by PREFIX, so it also hit `2-hop + filter` in the `query/plan` section — whose column
is a **ratio**, not a time — and taking the min across matches let the ratio win. That is
exactly what this corpus's own note warns about: it compares derived ratio columns as if they
were times, and the warning was walked into anyway.

`1-hop` had the quieter version: it appears in **two timing sections** (`query/gql` 541 µs and
`query/counts` 486 µs), so the min silently mixed two different shapes. Both now appear as
separate rows above.

The parser is section-qualified, exact-matched on the label, and takes the first occurrence
per run. **The rule is now in `examples/README.md` beside the other before-trusting-a-number
rules**, because the next person to scrape these tables will hit the same thing.

### What this says about the per-item controls

They were right as far as they went — `union` for 624/626, `Expand` for 624, the single-key
sorts for 627, `count(*)` and a tiny sort for 628 — and every one of them held here. But not
one of them touched ingest, and nothing but a sweep against the baseline would have. **A
session of six changes needs a session-level measurement, not six item-level ones.**

## 630 — 🛑 `distinct node`, the biggest row in `query_bench`, is NOT the dedup: it is element rendering, and that is already owned

**DECLINED, with the control that says why added to the corpus.** `distinct node` at **118.4 ms**
is an order of magnitude above every other row in `query/gql`, and it had no control — nothing
in the group separated the DEDUP from the cost of producing ~1,000,000 rows and materializing
198,672 node elements. So the control was added rather than the cause guessed:

| row                               | best_us      | rows        | per OUTPUT row |
| --------------------------------- | ------------ | ----------- | -------------- |
| `distinct node`                   | 118442.9     | 198672      | 596 ns         |
| **`hop node, NO distinct`** (new) | **575116.8** | **1000000** | **575 ns**     |
| `distinct prop`                   | 3002.3       | 8           | —              |

**The dedup is nearly free and DISTINCT makes the query 4.9x FASTER**, because it emits 198,672
rows where the undeduped shape emits a million. Backing out the render at 575 ns/row, the
dedup over 1,000,000 rows costs about **4.2 ms, ~4.2 ns/row** — which agrees with
`plan_cost_by_operator`'s `Distinct` at 3.24-5.59 ns/row, so the two harnesses corroborate.

### What the cost actually is, and why it is not a target

~575 ns per node element, against the 0.62 ns/row the `Scan` that produced the frontier costs.
It is `render_nodes`, and **that loop is already optimized and already measured, in its own
code comments**: items 390 and 391 hoisted the per-node property-key `Value` construction out,
and recorded the length axis — "465.6 ns/row at a 12-char key against 562.1 at 13 and ~595 at
20-40 — +24 ns PER PROPERTY the moment a name stops being inline". The fixture's keys put it
at the top of that range. Item 390's own correction is recorded there too: it measured the
loop at 55 ns/property using keys `"a".."d"` and so never touched the heap path at all.

The architectural alternative is recorded at **item 341**: the pure-TS engine returns live
`Vertex`/`Edge` instances and defers building the `{id, labels, properties}` map to whoever
serializes them, where the native engine has already built it. Deferring it natively means
`Rows` carrying unrendered element refs across the FFI boundary — a real option, and a large
API change, not a loop tweak. Named, not started.

**The lever to take from this is the control, not a rewrite.** A row with no sibling cannot
say which of two costs it is measuring, and this one had been the group's largest number for
long enough to look like a target.

## 631 — a TS write statement stops allocating a binding per rejected candidate: 2.18-2.54x

**FIXED (TS).** Found by pricing the one priority in the brief that was still unpriced — the
graph being MUTABLE, and the standing claim that interleaving a write with a traversal costs
~2.5x. `bun run bench:usage` had two rows whose `MATCH` is character-for-character identical,
on the pure-TS engine with no index:

|                                                     | ops/s | per op   |
| --------------------------------------------------- | ----- | -------- |
| `MATCH (u:User) WHERE u.name = $n RETURN u.score`   | 2.0k  | ~500 µs  |
| `MATCH (u:User) WHERE u.name = $n SET u.score = $v` | 552   | ~1810 µs |

### The diagnosis, which ruled out the obvious answer first

A new probe separated the candidates, and **it is not invalidation**:

|                           | µs/op      |
| ------------------------- | ---------- |
| read only                 | 505.0      |
| write only                | 1591.6     |
| **write matching 0 rows** | **1519.4** |
| write then read           | 2060.5     |
| read then read — control  | 987.2      |

A write that matches ZERO rows costs 1000 µs more than the read, and `write then read` minus
`write only` is 469 µs — an ordinary read — so **a write poisons nothing.** Swept 5k/20k/80k:
the overhead is proportional to N at a constant ~3.0x, so the write path did about three
scans' worth of work where the read did one.

Instrumented, the cause was exact:

|       | `matchNode` calls | bindings allocated | predicate failures |
| ----- | ----------------- | ------------------ | ------------------ |
| read  | **0**             | 0                  | 0                  |
| write | **20000**         | **20000**          | 19999              |

**The read never enters the general matcher at all** — it claims a fast-path rung. The write
does, and `matchNode` called `withBinding` (a fresh `Map`) for every candidate BEFORE testing
the predicate, then threw it away. 20,000 allocations to find one row.

`eqProps` and `cmpProps` read the property off the ELEMENT, and both reach `CPredicate` only
through `directEqProps` → `asPropCompare`, which requires a CLOSED value side — so neither can
read the variable about to be bound. Testing them first rejects a candidate with no allocation.

Two dists in ONE process, alternated, min of 5, 20,000 users:

| case                          | pre       | post   |           |
| ----------------------------- | --------- | ------ | --------- |
| **write, eq predicate**       | 1663.5 µs | 726.7  | **2.29x** |
| **write, cmp predicate**      | 1722.3    | 679.0  | **2.54x** |
| **write, 0 rows matched**     | 1597.6    | 731.8  | **2.18x** |
| read — control                | 579.9     | 586.4  | 0.99x     |
| write, OR — control           | 2368.0    | 2569.0 | 0.92x     |
| write, prop=prop — control    | 1767.3    | 1708.6 | 1.03x     |
| write, fn predicate — control | 3207.0    | 3259.8 | 0.98x     |

### 🛑 Two false regressions, each of which would have shipped as a fact

- **Extracting a shared helper cost the READ path 0.88x.** The first version split
  `satisfies` so both it and the pre-filter could call the element-direct loops. But
  `satisfies` is called per candidate from the hop-projection FAST PATHS too, and splitting it
  put those loops behind a call there. The **null control — the same dist on both sides, 1.02x**
  — is what proved the instrument sound and the regression real. `satisfies` is now byte-
  identical and the pre-filter is a second copy, with its one-directional safety argument
  written beside it.
- **`matchNode` has TEN call sites and is itself hot.** With the guard inside it, a predicate
  that cannot use the pre-filter measured 0.86x reproducibly — the function grew. Moving the
  check into the two seed loops that actually scan left `matchNode` byte-identical AND took
  the win from 1.61x to 2.29x.
- **And a control that was an artifact of the case set.** The fn-predicate row read 0.86 /
  0.87 / 0.85 — tight enough to look real, and it moved twice while I chased it. Adding two
  unrelated cases to the probe made the same row read 0.98x. **A control's reading can depend
  on what else the harness runs**, so a tight-looking ratio across runs of ONE configuration
  is not yet a result.

### 🛑 Teeth: 4 of 5, after the first run found the narrowing test VACUOUS

First run was **2/5, and the survivor was the STUB** — a pre-filter that never rejects, which
is correct and merely slow, so no correctness case can see it. The narrowing test was supposed
to, and it compared the TIME of a liftable predicate against a non-liftable one: those differ
in cost for reasons unrelated to the filter, so the assertion held with the filter off. **A
timing comparison between two DIFFERENT predicates is not evidence about a filter only one of
them uses** — the fourth vacuous test this session, and the comment above it claimed the
coverage it did not have.

Replaced with direct unit tests over hand-built predicates (`CPredicate`'s value side is a
thunk, so one is cheap to write by hand, and a unit test of the gate is immune to what the
surrounding engine costs). Now caught: the stub, the equality test inverted, the null-RHS
guard flipped, the ordering test inverted. The `op` token caught me too — `'gt'` where
`CompareOp` is `'>'` — and the test FAILED rather than passing vacuously.

**Survived, equivalent:** forcing the call-site guard to `true`. The function returns `false`
when neither list is present, so running it unconditionally changes no answer — only the cost
on predicates that cannot use it, which is the thing the guard exists for.

## 632 — an EDGE predicate costs ~2x in its inline spelling, the probe built to catch that was blind to it, and the obvious cause is REFUTED

**INSTRUMENT FIXED; the lever priced and declined.** Found while grepping item 631's pattern
onto the edge side (`edgePasses` has the same per-edge `withBinding`): two spellings of one
edge predicate, **identical answers, ~2x apart.** `bun run spelling` exists precisely to flag
that class and could not see it.

### Why the instrument was blind: a framing inherited from item 125

Item 125 found a 4x gap between a clause `WHERE` and an inline `{k: v}` on a NODE predicate,
and **every group in `spelling-probe.ts` inherited that framing** — the same question about a
RELATIONSHIP was never asked. Three groups added, so it cannot silently return: the param
equality across clause / inline / inline-`WHERE`, the ORDERING twin (`cmpProps` carries those
where `eqProps` cannot, so they can diverge independently), and the PROJECTED form, because
125's gap was on a `count(*)` and a count can take a shortcut a projection cannot.

200,000 vertices / 600,000 edges, min of 9:

| spelling                           |                 |                    |
| ---------------------------------- | --------------- | ------------------ |
| `WHERE r.w = $w`                   | 212.35 ms       | —                  |
| inline `{w: $w}`                   | 353.68          | 1.67x              |
| inline `[r:E WHERE r.w = $w]`      | 355.62          | 1.67x              |
| `WHERE r.w >= $w`                  | 212.42          | —                  |
| **inline `[r:E WHERE r.w >= $w]`** | **448.22**      | **2.1x — flagged** |
| projected, clause vs inline        | 194.86 / 373.44 | 1.92x              |

**An earlier ad-hoc figure of 5.2x is WITHDRAWN.** That fixture made the predicate 1-in-1000
selective where the probe's is 1-in-5; same direction, less than half the magnitude. The
probe's number is the one that counts, because the probe is the regression guard.

### 🛑 The obvious cause, located and REFUTED by measurement

`compilePredicate` lifts a `WHERE` to the element-direct `eqProps`/`cmpProps` only when given
an `ownVar`, and the two call sites were asymmetric:

```ts
pred: compilePredicate(node.properties, node.where, node.variable),   // node: lifts
pred: compilePredicate(rel.properties, rel.where),                    // rel: never lifted
```

The node site even carries the safety argument that would license the rel one — `directEqProps`
checks `pc.variable !== ownVar` per conjunct and declines the whole chain on the first conjunct
reading anything else. So: passed `rel.variable`, and **verified the lifting actually fires** —
`{props:0, where:false, cmp:1}` with it against `{props:0, where:true, cmp:0}` without.

**It is worth 1%: 454.39 ms → 448.22.** The generic evaluator was never the bottleneck. The
~2x is a ROUTE difference — the clause spelling claims a faster hop rung and the inline
spellings do not — so lifting the predicate cannot close it.

Reverted rather than kept at 1.01x, and **the measurement is recorded in place** at the call
site so the asymmetry reads as a decision rather than an omission. Verifying that the lifting
fired is what makes this a refutation rather than a null result: the mechanism worked and the
cost was elsewhere.

### The floor says the clause spelling is already optimal

The probe's first floor row was wrong and is now labelled so: `count(*)` with no predicate
takes the count SHORTCUT and never enumerates an edge, so its 0.03 ns/edge is the shortcut's
cost, not a hop's. With a real floor — a predicate every edge satisfies, so the walk
enumerates and filters but rejects nothing — on 5,000 users x 10 edges:

|                                        | ns/edge    |
| -------------------------------------- | ---------- |
| no pred (SHORTCUT, not a floor)        | 0.03       |
| **vacuous edge pred — the real floor** | **27.05**  |
| selective `>` (clause)                 | 27.51      |
| selective `=` (clause)                 | 22.74      |
| **inline `{w: $v}`**                   | **120.59** |

**The clause spelling sits AT the enumerate-and-filter floor and rejecting edges costs it
nothing; the inline spelling is 4.5x above it.** So there is no per-edge filter cost to win
back — the entire gap is the route the inline spelling takes, which is what makes the OPEN
below a routing question and not a predicate one.

### OPEN — CLOSED at 633

The ~2x is in which hop path each spelling takes. `relHasPredicate` is true for an inline rel
predicate and the fused rungs consult it, which is the shape to check first — but which rung
each spelling claims has NOT been instrumented, and item 622 is the standing reminder of what
a plausible route story is worth before it is. Named, not claimed.

## 633 — an inline rel `WHERE` reaches the one-hop tally: the two spellings now cost the SAME

**FIXED (TS).** Item 632 measured the gap and named the route; this closes it. The guard was
explicit and said it was unfinished:

```ts
// …the rel must still be plain — a rel predicate would need its own treatment.
if (!plainRel(rel)) {
  return null;
}
```

The treatment is to stop needing one. An inline rel `WHERE` reading nothing but its own
variable **IS** a `HopPred` with `relVar` set — exactly what the clause spelling becomes — so
routing it there reuses every arm and every decline already in place (the degree-sum arms
guard on `pred.relVar === undefined` and keep declining untouched).

The result is an **in-run** comparison, which is what makes it immune to the cross-run drift
that has bitten three items this session. Both spellings, one process, min of 9, 200,000
vertices / 600,000 edges:

|             | clause    | inline `WHERE` |           |
| ----------- | --------- | -------------- | --------- |
| `r.w = $w`  | 211.45 ms | 211.75         | **1.00x** |
| `r.w >= $w` | 211.71    | 211.90         | **1.00x** |

Against **448.22 ms before** for the ordering spelling, and the probe now reports **0 groups
over 2x** where it reported 1. The clause spelling is the control the change cannot reach and
it did not move (212.26 → 211.71); inline PROPERTIES are the second control, deliberately
untouched (353.68 → 351.84).

**Inline properties stay out, and the reason is a wrong answer rather than effort.** `{k: v}`
is IS-NULL semantics, not `=`: `{w: null}` matches a stored null **and an absent key** — two
edges in the test fixture — where `WHERE r.w = null` matches none. A `$param`'s value is
unknown at compile time, so a synthesized `compare` would reintroduce item 210's "route two"
divergence as a miscount.

### 🛑 The first version DROPPED a predicate — 3 where the answer is 2

Admission was INFERRED: `relInlineWhereOnly(rel) && pred?.relVar !== undefined`. But a CLAUSE
`WHERE` reading the rel also sets `relVar`, so a query with BOTH predicates was admitted with
only the clause one compiled, and the tally ignored the other. **That is the "silently
IGNORED, which is a wrong answer rather than a slow one" trap this file warns about twice, and
it was reintroduced while reading the warning.**

Fixed with an explicit `relCarried` flag only the caller that compiled the predicate can set,
plus a decline when both predicates are present — which is also precisely the prior behaviour.

### Teeth: 5 of 6, over THREE rounds, and every survivor was a coincidence or inert

- Round 1: **2/6**. Round 2: 3/6. Round 3: **5/6**.
- **The free-variable check** survived round 1 because the correlated case returned 0 either
  way. Its own fixture now has `w` equal to the source's `k` on exactly two edges — an answer
  only reachable by reading `a.k` per edge.
- **The QUANTIFIED guard** survived twice. The `w = 10` pair gave 3 for both `{1,1}` and
  `{1,2}`, because no `w = 10` edge chains and a one-hop tally agrees with a var-length walk
  by accident. With `w >= 5` they diverge — 5 against 9 — and the mutant dies.
- **The PROPERTIES guard** survived twice because the mutant was INERT, not untested:
  `relInlineWhereOnly` requires `r.where !== undefined` regardless, so dropping its properties
  check only bites a rel carrying BOTH (`-[r:E {w: $w} WHERE r.w >= $lo]->`), where the
  `WHERE` is carried and the properties are dropped. That shape is now a case.
- **Survived, equivalent:** reverting admission to the inference. The caller declines when both
  predicates are present, so the guard's strictness is unobservable — defence in depth, with
  the caller's decline as the tested line and `relCarried` as the second.

**A survivor is one of three things — equivalent, inert, or a test gap — and the results table
cannot tell them apart.** The properties mutant read as a gap and was inert; the admission one
reads as a gap and is equivalent. Both needed the mechanism traced, not the count re-read.

### Two of my own expectations were wrong, and the tests failed rather than passing quietly

- `{w: null}` → **2, not 1**: IS-NULL matches the stored null AND the absent key, and the
  first draft forgot the second half — pointed, since that divergence is the whole reason
  properties stay out of the tally.
- quantified `{1,2}` with `w >= 10` → **3, not 4**: the three qualifying edges do not chain.
- And `r.w = a.k` → **0, not 1**: no edge has `w` equal to its source's `k`. The engine was
  right all three times.

Also: the new branch put `patternCountOf` at a complexity of **38 against the limit of 35** —
the same ceiling `inlineInteriorGate` was extracted for — so the synthesis lives in
`relHopPred` for the same reason, recorded there.

## 634 — the native engine has NO edge-spelling gap (measured), and the 125x TS/native ratio beside it is item 566's ceiling, NOT a lever

**VERIFIED, and a target WITHDRAWN before it was started.** Item 633 closed the TS
clause-vs-inline edge-predicate gap; the brief asks for both engines, so the same question went
to native. Two results, and the second is a correction of this loop's own reasoning one tick
earlier.

### Native has no gap, and could not have one

Five spellings over 20,000 vertices / 100,000 edges through the FFI engine, min of 7:

| spelling                      |         |
| ----------------------------- | ------- |
| `WHERE r.w = 2`               | 0.20 ms |
| inline `{w: 2}`               | 0.20    |
| inline `[r:E WHERE r.w = 2]`  | 0.20    |
| `WHERE r.w >= 2`              | 0.21    |
| inline `[r:E WHERE r.w >= 2]` | 0.21    |

Identical answers (20,000 and 60,000, both arithmetically checked against `w = e % 5`). This
confirms the project's structural claim by measurement rather than on faith: both surface
spellings lower to one `ir::Plan` and run one `exec`, so speed is a property of the optimized
plan and two spellings that optimize alike **cannot** differ. **No native work to do**, and no
need to extend the native fixture to find that out — which matters because `Builder::edge`
still cannot give an edge properties, the same obstacle that excluded `IntervalExpand` from
item 623.

### 🛑 The 125x beside it is NOT a missing rung — and quoting it as one is a recorded mistake

On the spelling probe's own fixture (200,000 vertices / 600,000 edges), native against the TS
numbers from item 633:

|                     | native  | TS     |          |
| ------------------- | ------- | ------ | -------- |
| filtered edge count | 1.69 ms | 211.45 | **125x** |
| the `>=` variant    | 1.66    | 211.71 | 128x     |
| projected           | 5.83    | 194.17 | 33x      |

The previous tick named that as the next target. **`CLOSED.md` says otherwise, and it was
checked before anything was built:** item 566 established the data-layout ceiling at
**82-248x on filtered scans**, so 125x sits INSIDE the documented band. Both engines tally the
same way after 633, so the guidance's own test — _"before pricing a big TS/native ratio as 'the
layout', check whether the two engines are running the same algorithm"_ — comes back: same
algorithm, therefore layout, therefore ceiling.

And item 602 records the precise error this would have been: _"The 56.51x is the TS/native
ratio and most of it is item 566's layout ceiling, which no route change reaches. Recording the
bound now, because item 600b's estimate went wrong in exactly this way: quoting the
cross-engine ratio as if it were the prize."_

**So the 125x is withdrawn as a target.** It is the ceiling, already priced, and a route change
cannot reach it. The check cost one grep of the store the project tells you to read first; the
item it averted would have been a day of chasing a constant.

### What this says about the method

The brief's "make BOTH engines faster" is not symmetric, and this is the clean case: the TS
engine had a real 2.1x spelling gap and native had none, because native's architecture rules
the whole class out. **An engine that lowers two spellings to one plan cannot have an
equivalent-spelling bug, so the probe that hunts them is TS-only by construction** — worth
knowing before writing native groups for it.

## 635 — the numeric seek group's 1.3x is the INSTRUMENT, not a spelling gap: REFUTED, and the probe gains a null control so the next reader cannot repeat it

**REFUTED, and a defect fixed in the thing that reported it.** Item 578 left a clause-vs-inline
gap open on a seeked NUMERIC key, and the previous tick had measured it at 1.30/1.33/1.30x
across three separate processes — stable enough to look like a finding. It is not one. At a
size where the harness is actually quiet the three spellings converge, and the 1.3x was a ratio
between ~2ms timings.

### What the chase cost, in the order it went wrong

Every step below was measured, and each one refuted the step before it.

1. **`satisfies` call counts** (200,000 vertices, index on `k`) showed the clause form makes
   **one** call per row carrying both conjuncts and both inline forms make **two**:

   | spelling         | calls / 4000 rows | lists                                 |
   | ---------------- | ----------------- | ------------------------------------- |
   | clause           | 4000              | `eq` + `cmp`, one merged predicate    |
   | inline `{k: $k}` | 8000              | `props` on one call, `cmp` on another |
   | inline-`WHERE`   | 8000              | `eq` on one call, `cmp` on another    |

   That corrected the tick-before hypothesis (a redundant re-check of the seeded equality) and
   replaced it with a better one: a seek-validation call the clause form does not pay.

2. **Dropping the second conjunct** showed the bare inline form is NOT slower (2.08ms against
   the clause's 2.46) — so there is no standing seek-validation tax, and the gap needs the
   second conjunct to appear at all.

3. **Removing the index** made all three converge (0.95-1.01x at ~53ms). Consistent with the
   seek being involved — and the first reading in the whole chase taken at a duration where the
   harness is quiet.

4. **The second index was the trigger.** My repro indexed only `k`; the probe indexes `k` AND
   `s`. Adding it reproduced the gap at **1.40x / 1.39x**, tight across three alternated rounds,
   with the clause spelling flat (2.03 -> 1.94) as the control the change could not reach.

5. **🛑 And then the range-hint mechanism was REFUTED.** The hypothesis was that `n.s >= ''`
   over an indexed `s` builds a seed candidate covering all 1,000,000 rows that the seek can
   only ever discard. Against a third property `t` holding byte-identical data and NOT indexed:

   | second conjunct        | clause | inline | in-WHERE |
   | ---------------------- | ------ | ------ | -------- |
   | `n.s >= ''` (indexed)  | 1.00x  | 1.05x  | 1.11x    |
   | `n.t >= ''` (NO index) | 1.00x  | 1.08x  | 1.13x    |

   Indistinguishable. The indexedness of the second conjunct is not what is being paid for.

6. **🛑 And the 1.40x did not reproduce against its own script** — a second run of the identical
   file gave **1.19x / 1.22x**.

### The instrument was the problem, and raising the reps was never going to fix it

Eight readings, same question:

| fixture                                    | inline    | in-WHERE |
| ------------------------------------------ | --------- | -------- |
| index on `k` only                          | 0.97x     | 0.94x    |
| `k`+`s` indexed, run 1                     | **1.40x** | 1.39x    |
| `k`+`s` indexed, run 2                     | 1.19x     | 1.22x    |
| third property present, indexed conjunct   | 1.05x     | 1.11x    |
| third property present, unindexed conjunct | 1.08x     | 1.13x    |

**And the null control was sitting in the raw output the whole time, unread.** In the run that
produced the 1.40x, the CLAUSE spelling's own three rounds were **1.86 / 4.35 / 1.76 ms** — a
**2.47x self-ratio, larger than the 1.40x gap it was serving as the control for.** The same
case, the same process, nothing varying but the round. Reading only the per-case `min` hid it:
a min-of-N is exactly the statistic that makes a noisy series look settled. Every table in this
item was printed with its rounds visible and I still read the summary column.

The direction is consistent and the magnitude is not, on a query taking ~2ms. That is
CLAUDE.md's _"anything under ~10% needs its own isolated harness"_, and I spent two ticks
re-rolling it hoping it would settle. **The probe's own comment says the gap is a PER-ROW cost,
so the fix is more ROWS, not more REPETITIONS** — and raising the rows has to keep the seek
selective, or all that is measured is a scan.

At 100,000 matches on 5,000,000 vertices — 2% selectivity, so the seek is genuinely taken:

```text
clause      32.72    33.64    32.58   min  32.58  1.00x
inline      34.85    31.54    31.32   min  31.32  0.96x
in-WHERE    36.42    31.62    35.43   min  31.62  0.97x
scan ref   295.31   295.14   296.11  min 295.14  9.06x
```

Rounds agree to 0.3% where they ranged 1.91-4.43 before, the scan reference is **9.06x** slower
so no spelling quietly lost its seek, and **the two inline spellings are marginally FASTER than
the clause one.** There is no gap. An intermediate run at 200,000 matches of 1,000,000 (20%,
past `SEEK_MARGIN`) agreed at 1.00x/1.05x but is the weaker evidence, because at that
selectivity the seek may be declined and a hidden seek-path gap would not show.

### The fix: a null control, because a comment cannot be read at the moment of the mistake

`FLOOR_MS` defaults to 1ms and its doc already makes exactly the right argument — _"a ratio
between two sub-millisecond timings is the clock's resolution, not a measurement"_. The numeric
group runs 1.7-2.4ms, clears that floor, and still means nothing. Raising the constant would be
a guess, and would silently drop groups.

So the probe now carries **one query listed twice**, sharing the numeric group's shape and
params so it sits at the same duration. Its spread is instrument noise by construction, it is
printed on every run next to the groups it prices, and if it reads 1.3x then a group flagged at
1.3x has measured nothing. A null control at a different cost would measure a different noise
floor, which is why it is not a cheap O(1) query.

Verified wired: at the default `SPELL_N` it prints immediately below the numeric group and both
read `too fast` (0.06ms against 0.06/0.07ms), which is the correct behaviour and the point —
**the control is under the floor exactly when the group it prices is**, so it becomes
informative at the same raised size rather than offering a reassuring number at a size where
neither means anything.

### What this says about the method

The brief says "always with a control the change cannot reach", and every tick of this chase
had one — the clause spelling, which stayed flat throughout. **It was not enough, because a
control proves an effect is not global; it says nothing about whether the effect is larger than
the instrument's own variance.** That needs a null control: the same thing measured against
itself. The three ticks here are the price of not having had one, and the probe now has one
permanently.

## 636 — item 578's STRING group is noise too (REFUTED), and the null control now GATES the probe's summary instead of sitting beside it

**REFUTED, and the instrument upgraded.** Item 635 refuted the NUMERIC half of item 578 and
added a null control. This refutes the STRING half using it — in one tick, where the numeric
twin took three — and then makes the control do the work automatically.

### The string group: conjunct order costs nothing

At the probe's default size the group reads 2.5x, and its two SLOW members were the
inline-`WHERE` spelling and the **AND-order-reversed** clause. Order was the interesting one:
the seekable equality is present either way, so a cost difference would mean the seed lifting
is order-sensitive — the named bug class, not noise. Measured at 5,000,000 vertices, 100,000
matches (2% selectivity), min of 9, three alternated rounds:

|                                              | min      |           |
| -------------------------------------------- | -------- | --------- |
| clause, `s` first                            | 28.81 ms | 1.00x     |
| clause, `k` first (same conjuncts, reversed) | 29.47    | 1.02x     |
| inline properties                            | 29.68    | 1.03x     |
| inline `WHERE`                               | 30.91    | 1.07x     |
| **NULL CONTROL** (the first spelling again)  | 29.50    | **1.02x** |
| scan reference (no seekable conjunct)        | 221.57   | 7.69x     |

Every spelling sits between 1.00x and 1.07x against an instrument reading **1.02x**. The scan
reference is 7.69x slower, so no spelling quietly lost its seek and "the gap closed" is not
hiding a fallback. **Conjunct order costs nothing**, and inline-`WHERE`'s 1.07x is barely clear
of the instrument. Both halves of item 578 are now closed.

### The gate: printing the control was not enough, and item 635 is the proof

The control was added one item ago and it still had to be _noticed_. That is exactly the
failure mode item 635 recorded: that item chased a 1.40x for three ticks **with the refuting
number already in its own output** — the control spelling's three rounds were 1.86 / 4.35 /
1.76 ms, a 2.47x SELF-ratio, larger than the gap it was the control for. Reading the per-case
`min` hid it, because a min-of-N is the statistic that makes a noisy series look settled.

A reader reaches the summary with the per-group tables already scrolled away, so the summary is
where the comparison has to happen. It now splits the flagged groups into those **clear of the
null control** and those **not clear — not results**, each with its raw spread and its **net**
ratio (the spread with the instrument's variance divided out).

### Three defects, each found by exercising a branch rather than reasoning about it

All three were in the new code, and none would have been caught by reading it.

- **The heading claimed a gate that had not run.** At the default `SPELL_N` the control is under
  `FLOOR_MS`, so `nullSpread` is `undefined` — and the list still said "clear of the null
  control". A probe asserting the opposite of what it measured, ready to be quoted later. It now
  prints `UNGATED — no null control in this run` and says every ratio may be noise.
- **One decimal made the list self-contradicting.** A group at 1.04x and a control at 1.02x both
  render `1.0x`, so entries appeared _equal_ to the control under a heading saying they cleared
  it. Reachable with the documented `SPELL_TOL=1.5` hunt, not hypothetical. Now two decimals,
  plus the net.
- **The control listed ITSELF as a group "NOT clear of the null control"** at `SPELL_REPS=1` —
  true, circular, and precisely the sort of line that gets quoted back as a finding. The ruler
  is not a thing being measured; it is excluded from both buckets.

### How this was verified, and what that is worth

This is a probe, not engine code, so there is no mutation run to report and claiming one would
be dishonest. What was done instead: **both summary branches were forced to render.** The gated
path needs the control above the floor (`SPELL_FLOOR=0.001`), and the not-clear bucket needs the
control to read _higher_ than some flagged group, which `SPELL_REPS=1` produces because a single
run is bimodal — it demoted 14 groups, with net ratios below 1.00x, and exposed the self-listing
bug. An unexercised print path in an instrument is the same hazard as an untested branch
anywhere else: it is believed.

Gates: oxlint --type-aware 0; tsc --noEmit 0; oxfmt --check 0.

## 637 — an inline rel's PROPERTIES reach the one-hop tally: 8.76x → 0.99x, and the route item 633 refused is not the only one

**FIXED (TS).** The gated probe named this as the biggest genuine gap on its page, and item 633
had already looked at it and declined. The decline was right about its own route and wrong as a
verdict on the target.

### What 633 ruled out, and why it does not rule this out

633 admitted an inline rel `WHERE` by compiling it INTO the single `HopPred`. Properties could
not follow that route: `{w: v}` is IS-NULL semantics rather than `=` — with a null value it
matches a stored null **and an absent key**, where `r.w = null` matches none — and a `$param`'s
value is unknown at compile time, so a synthesized `compare` would reintroduce item 210's
"route two" divergence as a MISCOUNT.

**Nothing is synthesized here.** `relInlineOf` hands the properties to `compilePredicate` and a
new `inRel` applies them per edge through `satisfies` — the general path's own matcher, the
same call `matchRel` makes — so the semantics are not re-derived and cannot drift from it. It
is also an INDEPENDENT gate rather than something folded into `pred`, so a clause `WHERE`
reading the rel and inline properties on that rel are both honoured.

A recorded decline is a decline of a ROUTE. Re-reading what it actually refused is cheaper than
re-deriving the target, and in this case the refusal named its own escape.

### The number, with the clause spelling as the control throughout

200,000 vertices / 600,000 edges, min of 9, six alternated rounds, all spellings in one process:

|                               | before     | after     |                        |
| ----------------------------- | ---------- | --------- | ---------------------- |
| clause `WHERE r.w = $w`       | 23.56 ms   | 22.09     | **the control — flat** |
| inline `{w: $w}`              | **206.45** | **22.81** | 8.76x → **1.03x**      |
| inline `[r:E WHERE r.w = $w]` | 24.47      | 22.31     | 1.01x                  |
| NULL CONTROL                  | —          | 22.10     | 1.00x                  |

Identical answers (120,000 each, asserted in the harness). (The "after" column is a re-measurement of the FINAL code. An earlier run of the same change
read 0.99x before `relHopPred` absorbed the `inRel` computation to clear the complexity cap —
same conclusion, but the figure quoted has to be the one the committed code produces.)

The probe now reports the group
closed and **0 groups disagree on the ANSWER**.

**Six rounds, not three, and that matters:** a newly-routed path's rounds DECREASE for several
iterations as it JITs (28.6 → 20.5 here). At three rounds the series had not settled and the
min was still falling.

### 🛑 The first working version applied the predicate TWICE, and only a control caught it

`relHopPred` folds an inline `WHERE` into `pred`; `relInlineOf` then compiled that same `WHERE`
again into `inRel`. Both were applied, per edge.

**The answer is identical either way, so all 2505 gql tests passed.** The only symptom was the
inline-`WHERE` spelling reading a stable 1.12x — a spelling this change was supposed to leave
alone. Fixed by making the channels mutually exclusive (`carried.carried ? undefined : …`);
nothing is lost, because `relInlineWhereOnly` admits the `WHERE` form only when the rel has no
properties, so a carried rel has nothing for `inRel` to apply. After: 1.01x.

This is the second time in three items that a green suite was no evidence. The control is what
measured it, and the control only worked because it was a spelling the change should not have
been able to reach.

### Teeth: 6 of 7, and the survivor was PREDICTED

Under `timeout` + the 16G cgroup cap, pristine copy under `target/`, restored BEFORE each
mutant, every pattern asserted to appear exactly once:

| mutant                                                                                          |                           |
| ----------------------------------------------------------------------------------------------- | ------------------------- |
| the tally branch stops admitting a rel-only constraint (falls through to the O(1) bucket count) | CAUGHT                    |
| `startWalkFits` stops refusing `inRel`                                                          | CAUGHT                    |
| `farWalkFits` stops refusing `inRel`                                                            | CAUGHT                    |
| the per-edge gate stops being applied                                                           | CAUGHT                    |
| `relInlineOf` stops declining a QUANTIFIED rel                                                  | CAUGHT                    |
| the `both`-direction guard stops refusing `inRel`                                               | CAUGHT                    |
| **the carried/`inRel` exclusivity**                                                             | **SURVIVED — equivalent** |

The survivor was labelled an equivalence probe _before_ the run and behaved as labelled:
applying one predicate twice is answer-equivalent, so **no correctness test can catch it and
7/7 was never available here.** It is guarded by the MEASUREMENT (1.12x → 1.01x), not by a
test, which is the honest description and the reason it is written down — a later reader
finding a 6/7 should not go hunting for the missing case.

The bucket-fallthrough mutant is the one worth noting: that branch's entry condition was the
least obvious edit in the change, and ignoring `inRel` there counts EVERY edge. It was the
mutant most likely to have no coverage, and the tests caught it.

### The tests go where a wrong answer would be SILENT

15 tests. The two that carry the item:

- **`{w: null}` is 2** — the stored null AND the absent key — while `WHERE r.w = null` is **0**.
  That is precisely the divergence 633 refused to risk, pinned now rather than argued.
- **a clause `WHERE` that DISAGREES with the inline properties answers 0.** `{w: 2}` keeps two
  edges and `r.w = 1` keeps a different one; a tally that dropped either predicate would answer
  1 or 2. A conjunction that happens to agree cannot tell those apart, which is why the
  disagreeing pair is the discriminating case.

### Still open

The **projected** edge group remains at 2.98x (net 2.91x). It is a different route — a
projection, not a count — and this item did not touch it. It is now the largest gated flag on
the probe's page.

## 638 — a hop PROJECTION carries the rel's inline constraint: 4.34x → 0.96x, and three guards were invisible for ONE reason

**FIXED (TS).** Item 637 closed the inline rel gap on the one-hop TALLY. The probe's remaining
gated flag was the PROJECTED twin, and it turned out to be a **separate ladder** that refused
both inline spellings independently — item 637's fix did not reach it, and neither did item
633's.

### The precedent was already in the file

`closedFarPred` carries the FAR NODE's inline constraint into this same path, and its comment
is this item's whole argument: leaving it out _"made the two spellings of ONE question differ
by 5x once the clause form became fast"_. The RELATIONSHIP was still in the state the far node
had been in — `plainRel` refused the entire route — so `closedRelPred` is that function's
mirror, plus a quantifier decline.

### The number, with the clause spelling as the control

200,000 vertices / 600,000 edges, min of 9, six alternated rounds, one process:

|                                | before     | after     |                        |
| ------------------------------ | ---------- | --------- | ---------------------- |
| clause `WHERE r.w = $w`        | 53.12 ms   | 50.84     | **the control — flat** |
| inline `{w: $w}`               | **221.07** | **49.05** | 4.34x → **0.96x**      |
| inline `[r:E WHERE r.w = $w]`  | **243.66** | **54.01** | 4.59x → **1.06x**      |
| NULL CONTROL                   | 53.00      | 51.28     | 1.01x                  |
| unfiltered (no edge predicate) | 54.68      | 51.20     | 1.01x                  |

### 🛑 Two hypotheses died before any code was written

- **`relVariableHidden`** looked like the guard, since the route refuses a rel variable the
  projection reads. Refuted: the fast clause form projects `r.w` and IS admitted.
- **Build-then-filter** — that the inline path builds a row per edge and filters after.
  Refuted by a selectivity sweep: the clause path produces FIVE times the rows for +25%
  (56.78 → 71.12 ms), so building every row would cost ~71 ms, not 236.

Then instrumentation settled it rather than reading: tagging every `return null` in
`detectHopProjection` with a counter showed all three inline spellings declining at **one
guard** (`plainRel`) and both clause forms ADMITTED. **That also corrected a correction** — the
tick before, reasoning about `relVariableHidden` had talked this item OUT of its original
framing and into "the clause form is on the general path", which was wrong. The measurements
had already implied the right answer and were overridden by reading guards.

### Teeth: 4 of 7 → 7 of 7, and all three survivors had the SAME cause

Under `timeout` + the 16G cgroup cap, pristine copy under `target/`, restored before each
mutant, each pattern asserted to appear exactly once.

The first run caught the per-edge gate, the unfiltered-walk exclusion, the forced edge-bound
branch and the quantifier decline — and three survived. Tracing each instead of re-reading the
table:

| survivor                                             | verdict                                                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| the UNDIRECTED decline                               | **INERT** — `undirectedHopWalk` declines on `needsStart` anyway, and the test projected `a.k`, so the walk never ran |
| `closedRelPred`'s closed-PROPERTIES check            | **TEST GAP**                                                                                                         |
| `closedRelPred`'s inline-`WHERE` free-variable check | **TEST GAP**                                                                                                         |

**All three for one reason: every test projected the START, which binds it.** A wrongly-admitted
correlation (`{w: a.k}`) then still evaluates correctly, and a walk that declines on
`needsStart` never executes. Projecting only `b.k` removes both effects — nothing forces the
start, so the mutant reads an unbound variable and the undirected walk is actually reached.
Three added tests took the run to 7/7.

**The rule worth carrying: a test that projects the start accidentally binds it, and that hides
every guard whose failure mode is an unbound variable.** Three of seven guards here were
invisible for exactly that, and the mutation table reported two gaps and one inert case
identically.

### What declines, and why it must

- **UNDIRECTED** — `undirectedHopWalk` has no rel-bound form, so the constraint cannot be
  applied there and the route declines rather than dropping it.
- **The UNFILTERED walk** is excluded whenever a rel gate exists; it filters nothing.
- **A QUANTIFIED rel** is a walk, not one hop.
- **A CORRELATED value** needs the start bound per edge — items 121-123's problem, not this one.

### Still open

The **anonymous** inline spelling (`-[:E {w: $w}]->`) measured **3.77x** and is NOT fixed here:
`relBoundFilteredHopWalk` declines when `relVar === undefined`, because it binds the edge to
that name for the gate. Relaxing it is separable — the binding write is only needed when a gate
reads the variable — and it is recorded rather than folded in, so the scope of what was
measured and what was changed stay the same.

## 639 — the ANONYMOUS rel spelling joins the rest: 3.77x → 1.03x, and the mutant I expected to be caught was answer-equivalent

**FIXED (TS).** Item 638 closed the projection gap for a NAMED rel and recorded the anonymous
spelling as still open at **3.77x**, because `relBoundFilteredHopWalk` declined for want of a
variable to bind the edge to. This takes it.

### Why admitting it is sound

Nothing that needs the edge BOUND can reach that walk without a name. `itemsReadRel` and
`carried.needsRel` are both decided from `rel.variable`, so when it is absent neither the
projection nor the clause gate can read the edge — the only thing left is `relPred`, which
`satisfies` applies to the edge OBJECT rather than through the binding.

### The key is hoisted, not branched on

`const relKey = relVar ?? ''` outside the loop, leaving `binding.set(relKey, edge)` exactly as
it was. **A `!== undefined` test inside this loop is precisely what item 159 measured at 1.6x
on the hot shape**, so the anonymous case costs the named one nothing. The empty string cannot
collide with a real binding because a GQL identifier is never empty.

### The number, with the named spellings as controls

|                               | before      | after     |                    |
| ----------------------------- | ----------- | --------- | ------------------ |
| clause `-> r.w`               | 50.95 ms    | 50.93     | **control — flat** |
| clause `-> a.k`               | 56.92       | 56.73     | **control — flat** |
| inline named `-> r.w`         | 49.68 (638) | 47.31     | 0.93x              |
| inline named `-> a.k`         | 53.15 (638) | 53.15     | 1.04x              |
| **inline ANONYMOUS `-> a.k`** | **192.19**  | **52.57** | 3.77x → **1.03x**  |

Every spelling of this question now converges.

### 🛑 Teeth: 8 of 9, and the survivor was one I expected to be CAUGHT

The two new mutants: dropping `binding.set` entirely is **CAUGHT** (the named gate breaks).
Restoring `relVar === undefined ||` to the decline **SURVIVED** — and unlike item 637's
survivor, this one was not predicted.

Traced rather than re-read: with the decline restored, both walks return `null`, the branch
returns `null`, `detectHopProjection` returns `null`, and the query falls to the GENERAL PATH.
**Correct answer, 3.77x slower.** It is a route CHOICE, which is answer-equivalent by
construction, so no correctness test can catch it — this is the shape `perf-gate-needs-its-own-test`
describes, where the usual advice is to extract the arithmetic as a pure function and unit-test
it. There is no arithmetic here, only an admission condition, and no public way to observe
which route ran.

So it is guarded by the MEASUREMENT (3.77x → 1.03x), not by a test, and that is written down
rather than papered over. **Expecting a catch and getting a survivor is the useful half:** it
says the mutant was in a different category than I had classified it, and the category — "a
faster route for an identical answer" — is one where a green suite can never be evidence.

### Tests

Four added for the anonymous shape, including its IS-NULL case (`-[:E {w: null}]->` matching a
stored null AND an absent key) and the composition with a far-node constraint, bringing this
file to 21.

## 640 — UNWIND stops cloning every row's list (1.34x), and the operator turns out to have had NO native correctness test at all

**FIXED (native).** The brief asks for both engines and items 635-639 were all TypeScript, so this
priced the 24 streaming operator variants instead. No `MISSING` rows — but one pair stood out,
and reading it correctly took a second harness.

### The 13.7x headline priced nothing; the SLOPE did

`plan_cost_by_operator` showed `Unwind (2-element CONSTANT list)` at 1067.8 ns against
`Unwind (2-element list)` at 14617.8 — **13.7x at the same output row count**. That ratio is
not evidence: the constant case reads no property AND takes an evaluate-once path, so the two
rows differ in two ways at once.

Adding 1-element cases gives the per-item cost as a difference instead:

|          | 1-element | 2-element | per item           |
| -------- | --------- | --------- | ------------------ |
| CONSTANT | 597.7     | 1108.8    | 511 (2.56 ns/row)  |
| varying  | 10173.1   | 14898.0   | 4725 (23.6 ns/row) |

Two separable costs, where the ratio showed one: ~21 ns per property read inside a list, and a
**fixed ~27 ns/row for any non-constant list** (intercepts 5448 against 87), independent of
item count.

### The shape that matters is a stored list, and the corpus had no bench for it

A literal list cannot vary its LENGTH independently of its item count, so a second harness
(`unwind_cost_by_list_length`) sweeps a list PROPERTY with the output row count pinned at
200,000. `examples/README.md` and the whole corpus have no UNWIND or list coverage, so this
question was genuinely unasked rather than re-derived.

Per INPUT row, with the constant list as the control the change cannot reach (it returns early
on the invariant path):

| len | property list | control |
| --- | ------------- | ------- |
| 1   | 48.5 ns       | 3.4     |
| 4   | 80.1          | 10.4    |
| 16  | 211.4         | 39.0    |
| 64  | 754.6         | 153.6   |

**~11.3 ns per element against the control's ~2.4** — about 9 ns per element of pure copying,
roughly three quarters of the cost at length 64.

### The fix, and why it is a MOVE rather than a cheaper copy

`unwind_rows` evaluated the list into a `Col::Gen` of `Value::List` and then called
`value_at(i)`, which returns an OWNED `Value` — so the `Vec<Value>` that `eval` had just built
was copied a second time for every row. The column is owned here, so each row's list can simply
be MOVED out of it. Nothing is cloned at all.

A typed column (`Num`/`Str`/…) is one scalar per row and keeps the per-row read, split into
`unwind_rows_from_col` so the moving path stays a straight loop.

### 🛑 The first "after" number was 1.62x and that was wrong

The control moved too — 2.40 → 2.00 ns/element — and the control is a path this change cannot
reach. Run-to-run variance proved to be ~10%, so the baseline was re-measured three times. With
the control reading **2.20 on both sides**: 10.68 → 7.96 ns, **1.34x**. The original single-run
baseline of 11.79 was 10% high.

### 🛑🛑 The mutation oracle was BLIND, and what it hid was worse

The first mutation run reported a confident **0/6**. The harness piped `cargo test` into
`tail -30`, so `returncode` was TAIL's — always 0. **That is precisely the trap CLAUDE.md
records for gates** ("piping clippy into grep takes the exit status from grep… that has let
broken lint through twice"), reproduced inside the one script whose entire job is detecting
failure.

Fixing it and then PROVING IT KILLS — the step skipped the first time — exposed the real
problem. A deliberately broken `keep.push(0)` still exited 0:

**`UNWIND` had no correctness coverage in the native engine whatsoever.** Every `Plan::Unwind`
in `exec/tests.rs` sat inside an `#[ignore]`d measurement harness, and the three `unwind`
matches in `tests/gql_corpus.rs` are `catch_unwind`. The operator that MULTIPLIES rows — where
a wrong row index silently re-attributes every output row to the wrong input — was asserted
nowhere. A perf change had landed in a path that could have been broken outright and stayed
green.

Four tests now cover the VARYING path specifically (a constant list returns early, so a
literal-list test would have left the same hole): ragged lengths 2/1/3 with each output row
checked against ITS OWN input node, ordinality restarting per row in both `one_based` settings,
a null list and an empty list contributing no rows while a non-list scalar is a singleton, and
an empty input.

### Teeth: 4 of 6, with BOTH survivors predicted in advance

Under `timeout` + the 16G cgroup cap, pristine copy under `target/`, restored before each
mutant, every pattern asserted to appear exactly once — the ordinal-offset pattern matched 3x
on the first attempt and was correctly reported SKIPPED rather than mutating the wrong site.

| mutant                                             |                           |
| -------------------------------------------------- | ------------------------- |
| the row index stops tracking the input row         | CAUGHT                    |
| the ORDINAL stops being emitted                    | CAUGHT                    |
| the ordinal loses its one-based offset             | CAUGHT                    |
| a NULL list becomes a singleton instead of no rows | CAUGHT                    |
| the `vals.len() == n` guard                        | SURVIVED — **INERT**      |
| the moving path itself                             | SURVIVED — **equivalent** |

Both survivors were labelled equivalence probes BEFORE the run, and the length guard's
inertness was established from `eval`'s own contract rather than inferred from its survival:
`eval` returns a column of exactly `batch.rows()`, and the empty-batch case returns an empty
`Col::Gen` where `0 == n` holds too. So there is no reachable input where the guard changes
behaviour. **It stays** — it is what preserves the old `value_at` behaviour if that contract
ever changes — but it is defence in depth, not a tested line.

The moving path itself is answer-equivalent by construction: falling through to `value_at`
gives identical rows, only slower. Guarded by the MEASUREMENT, not by a test.

### The pattern is at FOUR call sites, not one

`value_at` deep-copying a list is a known cost class: a prior item measured it at **~73 ns a
call** over 599,998 rows and fixed it for `size()`/`cardinality()` with a by-reference arm.
Grepping found two more still paying it:

- **`Expr::Index`** (`evaluator.rs:683`) — clones the WHOLE list to read ONE element, turning an
  O(1) read into O(len) copying. The worst of the four.
- **`Expr::In`** (`:929`) — clones the haystack to scan it.

Both are recorded OPEN rather than folded in here: the measured scope of this item is UNWIND,
and `Expr::Index` deserves its own pricing. With four sites of one pattern, the eventual fix is
probably a by-reference accessor on `Col` rather than a fifth individual patch.

## 641 — indexing one element of a list costs 191x a property read, the obvious fix is REFUTED, and the harness that said otherwise was measuring its own wrapper

**MEASURED + REFUTED. No engine change ships from this item** — only the harness and the
records. Item 640 found `value_at` deep-copying a list at four call sites and recorded
`Expr::Index` as the worst: reading ONE element clones the WHOLE container, so an O(1) read
does O(len) work. This prices it, tries the obvious fix, and rejects it.

### 🛑 The first harness measured nothing, and said "flat"

Built on `PathRecord`, the sweep read **0.62–0.64 ns/row for BOTH the index and the control**
at every length — which looks like a clean refutation of the O(len) prediction. It is not:
0.63 ns/row is exactly `PathRecord`'s own floor in `plan_cost_by_operator`, because it does not
evaluate its `value` eagerly. A plain property read cannot cost 0.63 ns when
`Aggregate GROUP BY num` costs 6 ns/row INCLUDING the grouping.

**The control matching the subject to two decimal places is what gave it away.** Without it the
item would have recorded "`Expr::Index` is fine" and moved on. Rebuilt on `Aggregate`, whose key
IS evaluated per row and whose cost the operator table already prices.

### The cost, with a control that cannot reach the list

100,000 rows, min of 7, grouping on the expression. The control reads a different, scalar
property on the same node:

| len | index `[0]` | plain prop read |
| --- | ----------- | --------------- |
| 1   | 56.5 ns     | 7.3             |
| 8   | 88.2        | 7.5             |
| 64  | **1360.0**  | 7.1             |

**191x at length 64**, and worse than linear. The control is flat at ~7 ns throughout, matching
`GROUP BY num`'s known ~6 — which is how this run is known to be alive where the first was not.

### 🛑 The borrow fix is REFUTED: 2.25x SLOWER in the middle

Replacing `bcol.value_at(i)` with a borrow of `Col::Gen` — the same shape
`size()`/`cardinality()` already uses, and the one that worked for `unwind_rows` in item 640 —
measured, min of three each side:

|        | len 1 | len 8            | len 64 |
| ------ | ----- | ---------------- | ------ |
| before | 56.2  | 88.2             | 1345.4 |
| borrow | 45.3  | **200.0**        | 1249.6 |
|        | 1.24x | **2.25x SLOWER** | 1.08x  |

Non-monotonic, with a large regression in the middle, and the distributions do not overlap on
either side (88–90 against 198–203 at len 8, three runs each). Reverted.

**Measuring only len 64 would have shipped a 2.25x regression as a 1.08x win.** The first check
of this change was exactly that one row.

### The prediction was wrong about WHICH copy dominates

Removing the `value_at` clone bought ~7% at length 64. The bulk is upstream: `eval(base)`
materializes a `Col::Gen` holding a CLONED `Value::List` **per row** before indexing happens at
all — O(rows × len) — and no change at the indexing site can reach it. **That is the real
target and it is open:** a fused read that extracts one element from the stored list without
building the intermediate column.

The numbers and the rejection are recorded in `evaluator.rs` next to the code they would have
changed, per this repo's rule — several rejected optimizations here have been re-attempted
otherwise, and this one looks obviously correct.

### What ships

`index_cost_by_list_length`, the harness. The corpus had no list-indexing bench and the
question was unasked; it now has one that is demonstrably alive, with the control built in.

## 642 — `ORDER BY <a projected item's own expression>` reaches the ordered-column path: 1.94x → 1.00x, and mutation found a wrong-answer gap 12 tests had missed

**FIXED (TS).** The gated probe's remaining flag after item 638, and the audit is what made it
worth doing rather than `CLOSED.md`.

### The store that mattered was the AUDIT, not CLOSED.md

`CLOSED.md` had nothing on this group. The audit had **item 144**, which measured this exact
pair as **FLAT (8.18 against 8.14 ms)** and added it deliberately as the spelling _"that
already works"_, so its COMPUTED sibling's 1.72x could be localised to the substitution.

Since then the two have **swapped**: the computed pair has converged (1.01x) and the plain one
has opened up. The direction says which is which — the ALIAS spelling is the FAST one — so this
is an optimization that reached `ORDER BY <alias>` and never reached the equivalent
`ORDER BY <that expression>`. This repo's named bug class, found by its own instrument.

### The number, with the null control and the computed pair as controls

1,000,000 rows, min of 9, four alternated rounds, all spellings in one process:

|                             | before     | after     |                   |
| --------------------------- | ---------- | --------- | ----------------- |
| plain `ORDER BY c`          | 84.85 ms   | 82.66     | 1.00x             |
| plain `ORDER BY n.k`        | **164.71** | **83.00** | 1.94x → **1.00x** |
| NULL CONTROL                | 84.40      | 82.75     | 1.00x             |
| computed `ORDER BY c`       | 180.50     | 166.25    | 2.01x             |
| computed `ORDER BY n.k + 1` | 178.94     | 166.44    | 2.01x             |

The computed pair still matches ITSELF, which is the check that the change did not reach it.

### Restricted to `prop`, for two reasons that are not caution

- Its shape is flat (`{kind, variable, key}`), so "the same expression" is an **exact**
  comparison rather than a general AST deep-equal that would silently go stale as `Expr` grows.
- A property read **cannot fault** — it yields null for an absent key — so the substitution
  cannot disturb the windowed-sort fault rule of item 610. A computed key could, which is why
  the computed pair is deliberately left on the general path. Its ~2x is item 610's rule
  working, not a second bug.

### 🛑 Mutation found a WRONG ANSWER that twelve tests missed

Dropping the **variable** match from the substitution SURVIVED all twelve original tests,
because **not one of them bound two variables that both carry a `k`**. Without it,
`ORDER BY m.k` resolves to the alias built from `n.k`.

The added case makes the two orders DISAGREE, which is what makes it discriminating rather
than coincidentally passing: `n.k` ascends along the edges while `m.k` descends, so
`MATCH (n:Q)-[:R]->(m:Q) RETURN n.k AS c ORDER BY m.k` is `3, 2, 1` where ordering by `n.k` is
`1, 2, 3`. Caught after.

### Teeth: 3 of 6 — and every survivor has a MECHANISM, not a shrug

| mutant                                        |                                                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| the property KEY match                        | CAUGHT                                                                                                |
| the VARIABLE match                            | CAUGHT (after the case above was added)                                                               |
| the spread — losing `descending`/`nullsFirst` | CAUGHT                                                                                                |
| the `it.alias !== undefined` check            | SURVIVED — **INERT**: `find(...)?.alias` already yields `undefined` for an alias-less item            |
| the `e.kind !== 'prop'` guard                 | SURVIVED — **inert for matching**, because the inner `find` tests `kind === 'prop'` too               |
| the substitution itself                       | SURVIVED — **equivalent**, predicted in advance (both spellings then take the general path and agree) |

### 🛑 And the `prop` guard IS load-bearing — the ORACLE could not see it

Removing it was VERIFIED to fail `tsc`: `TS2339: Property 'variable' does not exist on type
'Expr'` and the same for `key`. So the guard is enforced by the TYPECHECKER, not by a test —
and the mutation oracle was `bun test` over a build that transpiles without typechecking, so it
reported a load-bearing guard as a survivor.

**The reflex on a survivor is "test gap", and here that would have been wrong twice: once
toward inert, once toward a guard a different gate enforces.** A mutation oracle should run the
typecheck as well as the tests; this run's did not.

### Also

`oxlint` caught `sortsOnOutputNames` becoming unused in this module — the inline check replaced
it. It stays exported for `executor.ts`'s other caller.

## 643 — the null control I added in 636 was mis-sized and gated nothing at the documented size: two controls now, and a group is judged against the one nearest ITS cost

**INSTRUMENT FIX, plus one target REFUTED by it.** Item 636 added a null control and gated the
probe's summary on it. This item is the bill for building that gate with ONE control, found by
the gate reporting its own failure.

### Both ways one control bites

- **At the DOCUMENTED `SPELL_N=200000` it did not run at all.** It sits at the numeric seek
  group's shape, ~0.3 ms at that size, under `FLOOR_MS` — so the page printed
  `UNGATED — NOTHING BELOW IS GATED`. The honest heading from item 636 worked exactly as built
  and said that nothing was gated at the size `ts-spelling-probe` tells you to use.
- **At `SPELL_N=1000000` it ran at ~2 ms and was then used to gate a 10 ms group.** The
  `hop, END filtered (item 220)` group read **2.14x** against it. Measured directly at the same
  fixture size: **0.89–1.01x against a 0.97x control — FLAT.** Item 220's own record says 1.30x
  after its fix, so nothing had drifted.

**Item 636's record already contained the rule it broke** — _"a null control at a different cost
measures a different noise floor, which is why it is not a cheap O(1) query"_ — written about
making the control heavy ENOUGH, and then applied as if one control could price a page spanning
0.3 ms to 400 ms.

### 🛑 And the mis-sized gate cost two ticks of chasing

The item-220 flag looked like the same finding as item 642's: a group a prior item had closed,
now reading high. 642's was real (flat → 1.94x, fixed). This one was the instrument. **The two
are indistinguishable from the flag list alone**, which is the argument for the fix rather than
for more care.

### The fix

`nullNear(ms)` picks the control closest to a group's own duration, compared in **LOG space**
because noise here is multiplicative — 1 ms is as far from 10 as 10 is from 100. The summary
prints every control that ran, with its cost, and names which one gated each flag:

```text
NULL CONTROLS — one query against itself, so each is this run's own variance
  at that cost. A group is judged against the one NEAREST its own duration.
    1.01x at 11.2ms
2 group(s) over 2x AND clear of the nearest null control:
  - label on start: redundant vs absent (5705.10x, net 5657.99x vs the 11.2ms control)
  - a product's one-sided predicate (item 285) (2.27x, net 2.25x vs the 11.2ms control)
```

A second control was added at **scan** cost so one of them clears the floor at the documented
size; the seek control stays for the cheap end and is correctly listed under
"not compared" when it is too fast. Naming the control in the output is the part that makes a
future mis-sizing visible instead of silent.

### What this says about the method

A control answers "is this effect global?". It does **not** answer "is this effect larger than
the instrument" unless it is measured at the same cost — and item 636 was written as though it
did. **A control at the wrong magnitude is not a weaker gate, it is a wrong one:** it passed a
flat group through at 2.14x.

## 644 — inline `props` miss the element-direct pre-filter: 50x the predicate evaluations, 1.89x, and the fix is BLOCKED by raise parity

**MEASURED + REFUTED. No engine change ships.** The probe's last gated flag, and the only target
this session that survived every re-measurement — but the fix changes which queries raise, so it
does not ship.

### What it is not

The flag is named _"a product's one-sided predicate: comma vs `MATCH MATCH` (item 285)"_ and
**neither half of that name is the finding.** Item 285's own pair has HELD: comma 222.99 ms
against `MATCH MATCH` 207.54 (0.93x). The drift is in a fourth member added later — inline
properties, at **422.19 ms, 1.89x** — with a null control at 1.00x.

Nor is it about products:

- the ratio barely moves as the left side grows (**1.90x at left=1**, 2.23x at 4, 2.28x at 16),
  and at left=1 there is no product at all;
- on a SINGLE node pattern the same spellings are **0.97x — flat**.

### 🛑 Three mechanisms eliminated by reading, and the fourth found by counting

Reading the code ruled out, in order: the props loop being inherently slow (**the comment
asserts the opposite** — an inline property is "a direct read" while an inline `WHERE` pays a
`Map.set` plus a `Map.get` per read); `patternRank` choosing a worse visit order (both patterns
carry labels, so both rank 1); and `eqProps` being a cheaper loop (it is the same
`value(env)` + `structuralEq(propOf(…))`, plus a null check).

Then counters settled it in ONE run, over 20,000 vertices:

| spelling          | `satisfies` calls | which list    |
| ----------------- | ----------------- | ------------- |
| clause            | **404**           | `eqProps` 400 |
| inline properties | **20004**         | `props` 20000 |
| inline `WHERE`    | **404**           | `eqProps` 400 |

**50x the predicate evaluations.** `rejectedByElementDirect` — item 631's pre-filter, worth
2.18-2.54x there — rejects candidates before a binding is built, and it reads
`eqProps`/`cmpProps` ONLY. Inline `props` are a separate list by design (IS-NULL semantics, and
`props` is what `indexCandidates` seeds from), so they never reach it. That also explains the
flat single-pattern case: there neither spelling gets the pre-filter.

**Two ticks were spent reading before counting, having already said counting was the next step.**
Item 638 was the same mistake; this is its second occurrence.

### 🛑 Why the fix does not ship

The candidate added a `closedProps` list — props whose value expression has no free variables,
because a property value may be CORRELATED (`(b {w: a.k})`) where `eqProps`/`cmpProps` are
closed by construction via `directEqProps` — and tested it with `structuralEq` ONLY, no
`rhs === null` rejection, so `{k: null}` kept its IS-NULL reading and item 210's "route two"
divergence could not recur.

**One test killed it, and it is the right test.**
`MATCH p = (a:P {k: 1}), (p:P {k: 2}) RETURN count(*)` — `p` as a path variable in one pattern
and a NODE variable in the other — RAISES on the general path and **answered 0** with the
change. The pre-filter runs BEFORE the binding is built, so rejecting every candidate skips the
binding that would raise. `product-count.test.ts` states the rule: _"WHICH queries raise is part
of the cross-engine invariant."_

So the lift is sound only where no binding on the rejected path can raise, and that is not a
property this function can see. **Narrowing it to dodge that one query would be guessing at
whether binding has other raise sources — the same guess that produced the IS-NULL divergence
historically.** Reverted; the numbers and the blocker are recorded in `executor.ts` beside the
pre-filter, per this repo's rule, because the change looks obviously correct.

### What would unblock it

A pre-filter that is only consulted where the engine has already established that binding cannot
raise — or detecting the path/node variable collision at compile time, so both spellings raise
before matching. Either is a bigger change than this item, and neither is speculation-free, so
the gap is **OPEN** with a stated reason rather than a vague one.

## 645 — `IN` over a list property pays ~91% of its cost before the scan starts, and the borrow is REFUTED at a SECOND site: the clone COMPACTS

**MEASURED + REFUTED, and this one corrects item 640's framing.** Item 640 named
`value_at`-deep-copies-a-list at four sites and called `Expr::Index` and `Expr::In` open targets.
641 refuted the borrow at `Index`. This refutes it at `In` — the same way — and the two together
say the pattern is **not uniformly a defect**.

### The cost is real, and a control proves where it sits

`hs.value_at(i)` clones the whole haystack per row to scan it. 100,000 rows, min of 7, with the
needle at index 0 as the control — that case exits the scan immediately, so anything it still
pays is paid regardless of scanning:

| len | needle MISSING (full scan) | needle FIRST (exits at 0) |
| --- | -------------------------- | ------------------------- |
| 1   | 47.8 ns                    | 48.6                      |
| 8   | 89.4                       | 79.1                      |
| 64  | **1494.6**                 | **1362.0**                |

**~91% of the length-64 cost is paid before the scan runs anywhere.** Against ~7 ns for a plain
property read (item 641's control).

### 🛑 And borrowing is 2.5x SLOWER in the middle

|        | len 1 | len 8                                       | len 64 |
| ------ | ----- | ------------------------------------------- | ------ |
| now    | 47.8  | **89.4** (min of three: 90.3 / 89.4 / 89.2) | 1494.6 |
| borrow | 36.6  | **229.4**                                   | 1390.2 |
|        | 1.33x | **2.5x SLOWER**                             | 1.08x  |

Hoisting the `Col::Gen` match out of the loop, so there is no per-row `Option`, changed nothing
— 229.4 either way. So the per-row branch is not the cause and the borrow itself is.

### Why, and this is the part worth carrying

**The borrowed version is LINEAR in length** — 36.6 / 229.4 / 1390.2 is ~6x per 8x, which is what
a scan should be. **The baseline is not**: 47.8 / 89.4 / 1494.6 is sublinear then explosive.

So the clone is not pure waste. **It COMPACTS** the list into a fresh contiguous buffer, where
each stored `Value::List`'s `Vec` was allocated at insert time among other allocations. At mid
lengths that locality is worth more than the copy; only at 64 does the copy start to lose, and
then by 1.08x.

### What this says about item 640's four sites

| site                     | what was done                          | result                         |
| ------------------------ | -------------------------------------- | ------------------------------ |
| `size()`/`cardinality()` | borrow (a prior item)                  | shipped, ~73 ns/call           |
| `unwind_rows` (640)      | **MOVE** — keeps the contiguous buffer | **1.34x, shipped**             |
| `Expr::Index` (641)      | borrow                                 | REFUTED, 2.25x slower at len 8 |
| `Expr::In` (645)         | borrow                                 | REFUTED, 2.5x slower at len 8  |

**The one that worked MOVED; both that lost BORROWED.** Item 640's "four sites of one pattern,
so the fix is a by-reference accessor" was too confident — a by-reference accessor is exactly
what measured worse, twice. Any future attempt at these sites should **move or compact, not
borrow**, and must sweep the LENGTH: both refutations look like wins at length 1 and at length
64, and fail only in between.

Recorded in `evaluator.rs` beside the code, per this repo's rule — the change looks obviously
correct and has now been attempted twice.

### What ships

`in_cost_by_list_length`, the harness, with the needle-at-index-0 control built in. The corpus
had no `IN` bench.

## 646 — "indexed writes are FASTER" is a screen false positive, and the 1000x instrument disagreement that chased it was MY UNIT ERROR

**REFUTED, twice over. No engine change.** `bench:usage` read `write: append node` at 86.1k
ops/s unindexed against 134.6k indexed — **1.56x FASTER with indexes**, which is backwards: an
index is work a write has to do. Isolated, that inverts.

### The screen row is refuted

Same two graphs in one process, alternated, min of three rounds, 5,000 inserts a round:

|                   | µs/op | ops/s      |
| ----------------- | ----- | ---------- |
| literal, NO index | 6.21  | 161.1k     |
| literal, indexed  | 8.15  | **122.7k** |
| params, NO index  | 1.27  | 785.4k     |
| params, indexed   | 1.69  | **591.3k** |

**Indexed is ~1.3x SLOWER for both spellings** — the expected direction, and consistent across
the literal and parameterized forms. The screen's inversion does not reproduce. That is a false
positive from a 250 ms best-of-3 screen, in the family this loop has now counted 23 of.

### 🛑 And the "1000x disagreement" was arithmetic, not an engine mystery

The first harness reported **6 ns an insert (168M ops/s)** against `bench:usage`'s 86-554k —
three orders of magnitude — and two ticks went into hypotheses for it:

1. **the write is lazy, applied after the timer closes.** Refuted: spread, bare `void` and
   spread-plus-a-forcing-read all measured the same and all inserted correctly.
2. **the forcing read forces nothing.** True but irrelevant —
   `MATCH (u:User) RETURN count(*)` is an O(1) label-bucket read, the same path that makes the
   probe's `label on start` group read 5082x.

Neither was the cause. **`run()` returned MILLISECONDS per op and the column was labelled
"us per op", then `1000 / m` was printed as "k ops/s" — two unit errors compounding to exactly
1000x.** With the unit corrected the same harness reads 6.21 µs / 161k ops/s, which sits inside
`bench:usage`'s range. **There was never a disagreement; `bench:usage` was right throughout.**

### What this cost and what prevents it

Two ticks, on a contradiction that did not exist, while twice stating the magnitude was
implausible — 6 ns for an object allocation plus a map insert, and 11 ns for a parse the
cache must miss (the query text carries `i`). **The implausibility was noticed and used to
doubt the ENGINE rather than the harness.**

Two cheap habits would have caught it at the first reading, and both are now in the file:

- **Print the unit the number actually has.** The conversion is where it went wrong, so the
  label has to be derived from the arithmetic, not written from intent.
- **Scale the op count.** Total time tracking `OPS` is what finally produced trustworthy
  numbers (24.79 ms at 1k, 122.44 at 10k, 824.41 at 100k) and would have shown the per-op figure
  was off by 1000x at a glance.

A third, already in this repo's guidance and skipped: `query()` throws at CALL time for an
invalid statement, so it is EAGER — one line that rules out the whole lazy-write hypothesis
before any of it was built.

## 647 — the search is exhausted in these families: all three pricing harnesses have NO `MISSING` row, the probe's page is clean, and `Subgraph`'s 78 ms is item 630's rendering cost

**STATE OF THE SEARCH, recorded so the next pass does not re-derive it.** This repo's guidance
warns that "three passes in one session re-derived a closed target", and five candidates this
session were resolved by reading a store rather than by measuring. This is the sixth, plus the
inventory.

### All three pricing harnesses are fully priced

| harness                              | variants                                           | `MISSING`                                                                                                                                     |
| ------------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan_cost_by_operator`              | 24 streaming + the 2 slope cases added at item 640 | none                                                                                                                                          |
| `plan_cost_by_control_flow_operator` | 16                                                 | one, and it is DELIBERATE — `RepeatGroup {1,2} -> VarLength` prices the `opt` flattening and is kept as the control for the two rows below it |
| `seed_cost_by_entry_point`           | 10                                                 | none                                                                                                                                          |

So **"pick the biggest MISSING path" returns nothing** in any of them. Incidental result worth
keeping: an id lookup is 64.06 ns against a unique-index seek's 107.77 — **1.68x cheaper**,
which is the right direction for the standing requirement that id lookups work well.

### The spelling probe's page is clean

After items 638 and 642, and with item 643's per-cost gating, the only groups over 2x are
`label on start` (which `CLOSED.md` records as CORRECT, not outstanding) and the product group,
whose inline-props member item 644 measured at 1.89x and found BLOCKED by raise parity.

### `Subgraph`, the biggest absolute operator cost, is NOT a target

78.18 ms for 200,000 edges — the largest row in the control-flow table by an order of magnitude
— is **~390 ns an edge**, and it is element RENDERING:

- `subgraph_edge_value` per edge plus `node_result_value` per deduped endpoint;
- item 630 priced that class at **~575 ns per node element** and showed it is _"already
  optimized and already measured, in its own code comments"_ (items 390 and 391 hoisted the
  per-node key `Value` construction and recorded the key-LENGTH axis);
- item 341 names the only real lever — deferring rendering so `Rows` carry unrendered element
  refs across the FFI boundary — as _"a real option, and a large API change, not a loop
  tweak."_

At ~390 ns for an edge record plus a deduped vertex record, `Subgraph` sits INSIDE that
established rate, not above it. **The number is large because the work is large.**

### One suspicion checked and refuted on the way

The loop matches `Value::Num(x)` on the edge slot while the frontier is a `Col::Edges`, which
looked like it would `continue` on every row and silently return an EMPTY subgraph — a wrong
answer, not a slow one. `Col::value_at` yields `Value::Num(f64::from(id))` for both `Nodes` and
`Edges`, so the match is correct. Refuted by one read.

### What remains open, with its blocker

- **`Expr::Index`'s O(rows × len) materialization** (item 641): `eval(base)` builds a `Col::Gen`
  of cloned lists before indexing. 191x against a plain property read. Needs a by-reference
  store accessor — `store.prop()` returns an owned `Value` — and item 645 established that
  BORROWS lose at these sites while MOVES win.
- **The inline-props element-direct pre-filter** (item 644): 50x the predicate evaluations,
  1.89x, blocked because the pre-filter runs before binding and skipping it skips a raise.
- **Deferred element rendering** (item 341): the lever behind `Subgraph`, `distinct node` and
  every element-returning shape. A large API change.

All three are real and none is a loop tweak. **The cheap, well-instrumented targets in these
families are done**, and saying so is more useful than manufacturing one.

## 648 — `<node>.<key>[<i>]` stops materializing the list: O(len) → O(1), 39.7x at length 64

**FIXED (native).** The target item 641 named after refuting its own borrow, and the one item 645
said the four `value_at`-clones-a-list sites needed: _"move or compact, not borrow."_ This does
neither — it never builds the copy at all.

### Why the two earlier attempts lost and this one wins

Both refuted attempts removed the SECOND copy and left the dominant one. `eval(base)` materializes
a `Col::Gen` holding a CLONED `Value::List` **per row** — O(rows × len) — before any index
happens, so borrowing at the indexing site could not reach it (item 641: 2.25x SLOWER at length
8). The fused path reads one element straight off the stored list through a new
`store.prop_ref`, so the materialization never occurs.

**And it is not item 645's refuted shape.** That borrowed a list in order to SCAN it and lost
because the clone was also compacting scattered storage into a contiguous buffer. Here exactly
ONE element is read: there is no scan for locality to help, and the copy is pure overhead.

### The number, and the shape of it

100,000 rows, min of three each side. The control is a plain `Prop` read on the same node — it
cannot touch the list, and it does not move:

| len | before     | after    |           | control |
| --- | ---------- | -------- | --------- | ------- |
| 1   | 56.2 ns    | 32.3     | 1.74x     | 7.4     |
| 8   | 89.4       | 32.8     | **2.7x**  | 7.3     |
| 64  | **1345.4** | **33.9** | **39.7x** | 7.3     |

**The win is the COMPLEXITY, not the constant.** After: 32.3 / 32.8 / 33.9 — flat in length,
which is what an O(1) indexed read should be. Before: 56.2 / 89.4 / 1345.4 — superlinear.

### The guard, and why it is a PRE-SCAN

`Expr::Index` is not only list indexing: on a RECORD or a MAP it reads a field by string key. So
the fused path is admitted only for a bare `Prop` base over a node frontier, `ElemKind::Plain`,
and a column where **every** stored value is a list — established by a discriminant check per row
with no allocation, the same device `size()`/`cardinality()` use a few arms up. A column holding
records, maps or scalars costs one pass and then takes the general arm, which stays the single
implementation of every case this does not answer.

### The pattern does NOT exist in the TS engine, and cannot

The method's "grep the pattern elsewhere" step: `packages/gql/src/executor.ts`'s `'index'` arm
evaluates its base to a JS value, and a stored list IS the array — JS hands back a REFERENCE, so
nothing is copied. The O(len) materialization is **native-only by construction**, because
native's columnar `Value` has to be cloned out of the column to become a `Col`.

So there is no TS twin to fix, and nobody should go looking for one.

### 🛑 The tests caught me making item 641's mistake a SECOND time

They were written against `Plan::PathRecord` and read back **0.0 / 1.0 / 2.0 — the ROW INDEX** —
because `PathRecord` does not append the evaluated value as a column. That is exactly why item
641's first harness measured `PathRecord`'s own floor instead of the expression, and the same
plan was reached for again without checking. `Plan::Project` is the one that produces named
output columns. The note is in the test now.

### Teeth: 4 of 6, after mutation found TWO real gaps in one blind spot

Under `timeout` + the 16G cgroup cap, pristine copy under `target/`, restored before each
mutant, every pattern asserted to appear exactly once — two matched 0x on the first attempt
(`cargo fmt` had rewrapped the pre-scan onto one line) and were correctly reported SKIPPED
rather than mutating the wrong site.

| mutant                                                        |                                      |
| ------------------------------------------------------------- | ------------------------------------ |
| the PRE-SCAN stops requiring every value to be a list         | CAUGHT                               |
| the pre-scan stops excluding the `u32::MAX` OPTIONAL sentinel | CAUGHT _(after a case was added)_    |
| the bounds test drops the upper bound                         | CAUGHT                               |
| the bounds test drops the INTEGER check                       | CAUGHT _(after a case was added)_    |
| the `ElemKind::Plain` restriction                             | SURVIVED — **INERT**                 |
| the fused path itself                                         | SURVIVED — **equivalent**, predicted |

**🛑 Both gaps were the same blind spot.** The bad-index assertions lived on the MIXED fixture,
which makes the pre-scan DECLINE — so they exercised the general arm and said nothing about the
fused one. Dropping the integer check survived until they were added to the all-list test
(`0.5 as usize` is 0, so a fractional index returned element 0). And the sentinel exclusion
survived because nothing put an unmatched OPTIONAL node in a slot and then indexed a list
property — without that guard `prop_ref` indexes the column at 4,294,967,295 and **PANICS**.

**A fixture cannot do both jobs: one that ADMITS the fast path cannot test the decline, and one
that DECLINES cannot test the fast path.** That is the inverse of item 638, where every test
projected the START and so accidentally bound it.

The `ElemKind::Plain` survivor is INERT with a reason from the grammar, not a shrug: `gql.rs`
attaches a `Node`/`Edge` kind only when the base is a group-variable `Expr::Slot`, never an
`Expr::Prop`, so `Index { base: Prop, elem: Node }` is not constructible from any query. The
guard stays — if the planner ever did attach it, the fused path would strip the element typing
and a following `.prop` would break.

### The tests are built so a wrong fall-through is LOUD

- **ONE MIXED FIXTURE**, not one per shape: list, record, map, scalar, empty list and absent key
  in the same column, so the pre-scan sees a mixed column and must decline for ALL of them. A
  per-shape fixture would let the fast path answer each in isolation and prove nothing about the
  guard.
- A **STRING** index reading the record's and the map's field — the behaviour the fast path must
  not swallow.
- Out-of-range, negative and non-integer indices, all NULL even for the list.
- **RAGGED lengths** (3 / 1 / 2) on the all-list column, so an off-by-one in the bounds test
  shows as a WRONG VALUE rather than the same value.

## 649 — `IN` over a list property stops materializing too: 10.5x, early exit becomes actually early (62x), and this CORRECTS item 645's generalization

**FIXED (native).** Item 648's technique applied to the one other site whose base is a bare
property, found by the method's "grep the pattern elsewhere" step — on the TECHNIQUE, not the
symptom.

### The result, min of three each side

100,000 rows. The needle-at-index-0 column is the control item 645 built: it exits the scan
immediately, so whatever it still pays is paid regardless of scanning.

| len | MISSING (full scan) |           | FIRST (exits at 0) |         |
| --- | ------------------- | --------- | ------------------ | ------- |
| 1   | 47.8 → 21.8         | 2.2x      | 48.6 → 21.8        | 2.2x    |
| 8   | 89.4 → **37.5**     | 2.4x      | 79.1 → **21.8**    | 3.6x    |
| 64  | 1494.6 → **142.7**  | **10.5x** | 1362.0 → **21.9**  | **62x** |

**The `FIRST` column is the real result.** It is now FLAT at ~22 ns whatever the length, where it
used to pay 1362 ns at length 64 _to exit at index 0_ — the materialization was charged before
the scan could decline. The `MISSING` column still scales with length, as a full scan must.

### 🛑 This corrects item 645's generalization, which was mine

645 refuted BORROWING the evaluated column here (2.5x slower at length 8) and explained it by the
clone COMPACTING: a freshly copied local `Vec` scans faster than one allocated during `eval`
among 100,000 others. That explanation still holds for what it compared — **both sides of 645 paid
the materialization, so it was measuring the second copy only.**

What 645 then concluded was too broad: _"any future attempt here should move or compact, not
borrow."_ **I predicted in advance that this change might therefore LOSE**, since the stored list
is scattered too and here the read IS the scan, so locality should cut against it. It did not:
the materialization dominated by an order of magnitude.

The correct lesson from 641, 645, 648 and 649 together is **do not build the column** — not
"prefer moving to borrowing". Borrowing lost twice only because the thing being borrowed had
already been paid for.

### Correctness: `IN` is three-valued, and that is where it would be silent

TRUE if any element equals the needle; else NULL if the needle or ANY element is null (the
membership cannot be decided); else FALSE. The test pins the ASYMMETRIC cases, because a simpler
fixture passes under several wrong implementations:

- a null element seen BEFORE a match still gives **TRUE** — the match short-circuits;
- a non-match WITH a null element gives **NULL**, not FALSE;
- a clean miss gives FALSE, and an empty list gives FALSE.

Those distinguish "track unknown but let a match win" from "any null poisons the row", which are
the two plausible ways to get this wrong.

The guard is item 648's pre-scan, unchanged in kind: a bare `Prop` haystack over a node frontier
and a column where every stored value is a list, established by a discriminant check per row with
no allocation. Everything else — records, maps, scalars, the `u32::MAX` OPTIONAL sentinel, and
the hashed-set path for a row-invariant literal list — takes the general arm above it, which
stays the single implementation.

### Mutation: two survivors, and ONE of them was answer-equivalent

First run 2/5. Both unexpected survivors traced to a mechanism rather than guessed at from the
count, which is what separated them:

- **dropping the whole pre-scan** survived, and its two halves are not alike. The _list_ half is
  **answer-equivalent**: with `all_lists = true` a non-list haystack falls into
  `let Some(Value::List(items)) = … else { Value::Null }`, which is exactly what the general arm
  returns. The _sentinel_ half is load-bearing and was untested — `store.prop_ref(u32::MAX, …)`
  indexes the column at 4,294,967,295 and PANICS. This is item 648's blind spot recurring at the
  next site: the `IN` test uses an all-list fixture, which cannot exercise the decline.
  `fused_in_over_an_unmatched_optional_node_is_null` now puts an unmatched `OPTIONAL MATCH` node
  in the slot, and asserts the matched node in the SAME row still finds its element — so the
  sentinel row is routed away without disabling the path for everyone.

- **dropping `saw_unknown = needle.is_null()`** survived because the seed is **redundant with the
  in-loop check for every NON-empty list** — the loop sets the flag anyway. It is observable only
  where the loop never runs: a null needle over an EMPTY list. The fixture HAD an empty list; the
  null-needle probe simply never asked about that row. One assertion.

Second run 4/5, the remaining survivor being the equivalence probe labelled as such in advance.

That the pre-scan's list half is equivalent is worth keeping: it is there for the SENTINEL and for
cost (one discriminant pass instead of a per-row branch), not for the answer.
