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
| **The TS insert path** (`addVertex`/`addEdge`)                                                   | **CLOSED as a constant factor** — 3.7x, and it is `JSON.parse` + alloc + freeze, not a missing path. The recorded "71% is `indexEdgeLabel`" was **withdrawn → 34.1%**. Single remaining target is `addVertex` itself.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 140, 201, **203**                          |
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

| question                                                                                         | settled as                                                                                                                                                                                                                                                                                                                                                                                     | authority                                 |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Prototype-chain keys (`__proto__`, `toString`, `valueOf`) as property names                      | **WON'T FIX** — not real-world input                                                                                                                                                                                                                                                                                                                                                           | item 1, **user**, re-confirmed 2026-09-16 |
| Row order without `ORDER BY`                                                                     | **Unspecified**, as SQL. Do not sort to fake byte-identity; compare as multisets                                                                                                                                                                                                                                                                                                               | item 198, **user**                        |
| Cross-type comparison                                                                            | `=` → no match; `<=` → `E_INVALID_VALUE` throw. Postgres-style                                                                                                                                                                                                                                                                                                                                 | **user**, "fine with it"                  |
| NaN                                                                                              | Predicates keep it JS-unordered; sort/min/max use a total order (NaN last, NaN == NaN) so both engines stay byte-identical                                                                                                                                                                                                                                                                     | settled                                   |
| `null`                                                                                           | A **stored, present value**, distinct from absence. Delete via `.properties(k).drop()` / `REMOVE`, never `SET null`                                                                                                                                                                                                                                                                            | settled                                   |
| Parallel names across GQL and Gremlin                                                            | **Intentional** — users pick one surface. Not a collision                                                                                                                                                                                                                                                                                                                                      | settled; do not relitigate                |
| A label / property / `WHERE` on a subpath-group **inner node**                                   | **Both engines refuse, consistently**, and the per-rep `WHERE` spelling expresses the same constraint (verified equal). A shared deliberate limitation with a workaround, not a gap                                                                                                                                                                                                            | probed 2026-10-08                         |
| `FALSE AND <data exception>`                                                                     | **`AND` short-circuits on FALSE, in WRITTEN ORDER, in both engines.** `OR`/`XOR` stay eager. ISO leaves it open (`US008`, `UA004`), so the choice was made on cost                                                                                                                                                                                                                             | **user**, 2026-10-08; **item 258**        |
| Conjunct order in a **FILTER** (clause `WHERE`, `FILTER`, `HAVING`, an inline pattern predicate) | **Unobservable, in both engines, so the conjuncts that cannot raise go FIRST.** A filter keeps only a clean TRUE (ISO §14.6), so a conjunct that is not cleanly TRUE settles the row — UNKNOWN included, unlike Kleene `AND`, where only FALSE settles. Spends no ISO latitude: it is the filter's contract, not a reordering of `AND`'s value. A **VALUE** position still keeps written order | **user**, 2026-10-09; **item 259**        |
| The ordering KEY for that reorder                                                                | **Must be the SAME key in both engines.** A narrower whitelist in one engine is not caution, it is disagreement — restricting TS's to `=`/`<>` while the engine admitted any comparison produced **41 divergences in one 20,000-query run**                                                                                                                                                    | **item 259**                              |

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
  Still open and priced here: anything that DECLINES a count shortcut pays **50-85x** (the general
  matcher is 727-1154ns a path against 13.7ns), which is one target and not a family of them.
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
