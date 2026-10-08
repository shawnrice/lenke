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

| lever                                                                          | verdict                                                                                                                                                                                                                                                                                                                                                                                                         | item                                       |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Type-first / inverted adjacency** `Map<type, Map<vertexId, Set<Edge>>>`      | **REFUTED.** Wins the typed lookup 2.2-4.1x, **loses get-by-id 1.4x at three edge types and 4.8x at twenty**; the crossover is between T=1 and T=3 and a people graph has 5-20. The dual-spine variant costs **2.0-2.4x on `indexEdgeLabel`**, the most expensive thing the engine does. Only surviving direction: an **opt-in** index — a feature with an API, not an optimization. **User-confirmed closed.** | 197 priced, **200 refuted**, 247 confirmed |
| **An adjacency "box"/row cache** for `edgesFromByLabel.get(id)`                | **REJECTED — bad trade.** Row lookup is 14ns isolated / 46ns in context; a cached row reads 128ns against 174, dense-array ceiling 97 — **1.35x for a cross-cutting cache needing invalidation on `addEdge`/`removeEdge`**. Re-derived at 246 and corroborated end-to-end at 1.09-1.14x; the rejection stands.                                                                                                  | **172**, 246                               |
| **The var-length walk's per-frame `{edge,node}` allocation**                   | **REFUTED.** Built it; in-process A/B of both bundles read **1.025x, overlapping**, and the control the change cannot reach moved _further_ (0.928x). At ~400ns a path, N nursery objects at a few ns cannot be a measurable share.                                                                                                                                                                             | **245**                                    |
| **`satisfies`' per-call iterator allocation**                                  | **REFUTED.** A ladder attributed **64%** of the gap to it and the fix made it 2.4x cheaper — and the A/B read **1.02x overlapping**. Reverted. A ladder that skips the caller's call site misattributes.                                                                                                                                                                                                        | **241**                                    |
| **Any edit to `exec::pull`'s layout**                                          | **WON'T-GAIN.** Costs the filtered-count cluster **1.08-1.24x and never gains** — that is the toll, not a regression. Widened at 250: the cluster is layout-sensitive **crate-wide**, not just to `pull`.                                                                                                                                                                                                       | **90**, 250                                |
| **Coalescing the per-write microtask**                                         | **REFUTED at 0.4%** of total; the sync loop does not move (2329 vs 2331).                                                                                                                                                                                                                                                                                                                                       | **202**                                    |
| **Reading `this.#id` instead of the `id` getter**                              | **REJECTED.** Flat on every row, rounds disagreeing on the sign — JSC inlines a getter whose body is a private-field read.                                                                                                                                                                                                                                                                                      | 118                                        |
| **A positional column pair instead of `types.get(key)` per cell** (CSV encode) | **REJECTED.** CSV encode has no cheap win; two levers priced.                                                                                                                                                                                                                                                                                                                                                   | 118                                        |
| **The TS insert path** (`addVertex`/`addEdge`)                                 | **CLOSED as a constant factor** — 3.7x, and it is `JSON.parse` + alloc + freeze, not a missing path. The recorded "71% is `indexEdgeLabel`" was **withdrawn → 34.1%**. Single remaining target is `addVertex` itself.                                                                                                                                                                                           | 140, 201, **203**                          |
| **The end-filtered multi-hop reversal**                                        | **WON'T-FIX despite 48.7x.** Native prices it and declines on purpose; the remedy is an **index** (53.6x). Recorded with numbers precisely because a 48.7x in a probe invites a later sweep.                                                                                                                                                                                                                    | **223**                                    |
| **Gremlin `V().out().has().count()` and `V().has().count()`**                  | **SHARED FLOOR, not a Gremlin gap.** `filteredHopCount` already exists and fires. The GQL spelling of the same question costs the same (50.8ms vs 51.9ms), so it is item 200's adjacency-lookup floor — a per-vertex `Map.get` on the id, ~180ns.                                                                                                                                                               | 161, 226, **235**                          |
| **Gremlin `V().out().values(k)`**                                              | **TinkerPop ORDERING GUARANTEE, not overhead.** `hopValuesShortcut` fires at its documented rate; Gremlin groups by the START vertex where GQL groups by the FAR one, so the cheaper shape is not available.                                                                                                                                                                                                    | 170, **235**                               |
| **`scale/sweep`'s `filter_us` as a regression screen**                         | **NOT A SCREEN.** Moves **8-10% for ANY native edit** — proven by a null control that only lengthened an error string. `1hop_us`/`labelcnt_us` in the same table are unaffected.                                                                                                                                                                                                                                | **250**                                    |
| **`eval_vec`'s missing `CExpr` arms (2.7-8.0x)**                               | **STALE — `eval_vec` NO LONGER EXISTS.** Only `examples/README.md` and `examples/support/storage.rs` mention it; it was `lenke-core`, deleted. Do not reach for those figures.                                                                                                                                                                                                                                  | checked 2026-10-08                         |

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

| question                                                                    | settled as                                                                                                                                                                          | authority                                 |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Prototype-chain keys (`__proto__`, `toString`, `valueOf`) as property names | **WON'T FIX** — not real-world input                                                                                                                                                | item 1, **user**, re-confirmed 2026-09-16 |
| Row order without `ORDER BY`                                                | **Unspecified**, as SQL. Do not sort to fake byte-identity; compare as multisets                                                                                                    | item 198, **user**                        |
| Cross-type comparison                                                       | `=` → no match; `<=` → `E_INVALID_VALUE` throw. Postgres-style                                                                                                                      | **user**, "fine with it"                  |
| NaN                                                                         | Predicates keep it JS-unordered; sort/min/max use a total order (NaN last, NaN == NaN) so both engines stay byte-identical                                                          | settled                                   |
| `null`                                                                      | A **stored, present value**, distinct from absence. Delete via `.properties(k).drop()` / `REMOVE`, never `SET null`                                                                 | settled                                   |
| Parallel names across GQL and Gremlin                                       | **Intentional** — users pick one surface. Not a collision                                                                                                                           | settled; do not relitigate                |
| A label / property / `WHERE` on a subpath-group **inner node**              | **Both engines refuse, consistently**, and the per-rep `WHERE` spelling expresses the same constraint (verified equal). A shared deliberate limitation with a workaround, not a gap | probed 2026-10-08                         |

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

| question                                | state                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The var-length trail budget's shape** | `limits.trail` drives **two** quantities (a per-source hop budget and a global emitted-row cap) and the lean count walker enforces **neither**. Budget EXISTS and stays (user, 2026-10-08); its SHAPE is what is open — context written up in [`../design/trail-budget.md`](../design/trail-budget.md).                                                                                            |
| **`{k: null}`**                         | **BOTH engines, verified 2026-10-08 — not native-only.** Each returns 2 rows (stored-null **and** absent-key) where `WHERE n.k = null` returns 0 in each. The free ISO artifacts prove it is **not** implementation-defined or -dependent, so one of the two behaviours is wrong; the reduction rule is paywalled prose. Blocks a measured **1.16x** on every filtered write. Items 180, 210, 257. |
| **`FALSE AND <data exception>`**        | **DECIDED 2026-10-08 (user): take the fastest path — evaluate the `FALSE` and do not evaluate the throwing arm.** Native already does this; TS raises and must change. See §6 for the consequence.                                                                                                                                                                                                 |

---

## 5. Open — unblocked and priced

- **`addVertex`** — the single target behind the three `bench:usage` rows TS loses, all a 3.7x
  constant factor (§1). Reopening means arguing with item 203's conclusion, with numbers.
- Nothing else in the TS **query** surface is above 5x once the adjacency floor is accounted for
  (item 197's closing line, still accurate).

---

## 6. Consequence of the AND decision that must not be missed

Item **190** (`subquery-conjunct-placement`) rests on _"`AND` never short-circuits"_: an
`EXISTS`/`COUNT{}` conjunct must not fold into a node predicate **nor ride a hop seed gate
unordered**, because byte-identity required both sides to be evaluated. Item **175** then made the
hop seed gate _"evaluate cheap conjuncts first"_, and recorded an error-vs-non-empty divergence as
the price.

Short-circuiting `AND` changes the premise both items reasoned from. Whatever lands for the decision
above has to say explicitly what happens to:

1. the item-190 placement rule — is a subquery conjunct now free to be reordered?
2. item 175's recorded divergence — does it become the _intended_ behaviour rather than a price?
3. the divergence-registry entry for the AND chain — it should be **deleted**, not widened.
