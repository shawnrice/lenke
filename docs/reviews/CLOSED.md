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
  into a compact op-record array (asked at 313) buys that 20ns and costs a dispatch switch; what is
  **unmeasured** is the transaction case, where the closures are RETAINED until commit, so the
  open question there is resident memory and not time.
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
     sweep at item 300), the `Edge` property reads, and two hash lookups — and no micro moves a spread
     cost. It is the CSR item 300 priced at **7.30x** and declined for needing a dense adjacency the
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
  **Still open: the same reversal in NATIVE**, priced at 2.5x by the position table and ~3.4x by
  the bench row's own FFI column (14.3 against the start-gated 4.0). It needs one thing TS did
  not: native's forward seed is `nodes_with_label`, an index bucket, where a reversed seed is a
  full live-node scan plus a gate — so reversing can LOSE a selective seek. The symmetric fix is to
  promote an `IsLabeled` leaf on the reversed-start position into the new base label and demote the
  old one to a leaf, with both sides of any guard measured.
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
- **`gql::parse` at 1296ns for a 57-byte query (43% of a serving call)** — **OPEN, and item 294
  established it is STRUCTURAL rather than allocational.** The two costs visible in the source
  were priced: the lexer's `Vec<char>` pre-pass is **60ns** (26ns with `with_capacity` — a 34ns
  one-line saving, **2.6% of parse and below end-to-end resolution, so NOT made**), and the ~12
  owned identifier `String`s are **177ns (14%)**. **The other ~1060ns (82%) is the scanning loop,
  the recursive descent and the plan build.** Removing the strings needs `Tok<'a>` with
  `Ident(&'a str)` — a lifetime through `Parser` and every token consumer — and it only pays if
  the `Vec<char>` indexing goes too, since a borrowed token cannot point into a transient char
  vector; they are one change. **Start from a profiler on `lex`/`parse_internal`, not from the
  allocations.** Numbers reproducible in `percall_probe`.
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
