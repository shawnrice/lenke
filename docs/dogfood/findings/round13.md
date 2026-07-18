# Round 13 findings — post-backlog dogfood (4 personas)

Run after the round-10–12 backlog was triaged to closure. Four personas exercised
**new ground plus this session's reachability/DISTINCT/EXISTS work**: an RBAC/ABAC
authorization engine, a routing/shortest-path app, an Arrow-egress analytics pipe,
and a broad differential fuzzer. Verdict: **the surfaces changed this session
(variable-length, reachability shortcuts, EXISTS, CALL, aggregates) held byte-identical
across ~58k+ checks** — every real divergence was elsewhere. Found **1 HIGH + several
smaller byte-identity bugs**; the obvious ones are fixed, the rest deferred to
`DESIGN-DECISIONS-MORNING.md`. Persona scripts under `.dogfood/round13/<persona>/`
(gitignored).

## Persona results

- **AccessGraph — RBAC/ABAC engine** (`access/`). Full model (Users/Groups/Roles/
  Permissions/Resources; nested groups, role-inheritance hierarchy with an intentional
  cycle) + hand-truth fixture + 2 fuzzers (34.5k cross-engine checks). Found the
  **HIGH eager-enumeration bug**. Everything else (cycle detection, transitive
  membership, `count(DISTINCT)`, deny rules, multi-anchor) byte-identical.
- **PathNav — routing / shortest-path** (`path/`). Full Path/shortest surface. The GQL
  Path surface (accessors, cyclic-shortest B2, weighted/unweighted across all four
  surfaces) is byte-identical + matched hand-truth. Found a Gremlin element-form
  divergence + an error-code split + `shortestPath` config footguns (all deferred).
  Also caught that the shared harness `stable()` isn't `toJSON`-aware.
- **ArrowPipe — Arrow IPC egress** (`arrow/`). **Clean.** Native `queryArrowIpc` bytes
  === JS `toArrowIPC` bytes across 89 compares (stream + Feather-v2), and every blob
  reference-decoded through apache-arrow v21 matched the JSON ground truth — nulls,
  unicode/emoji/astral, empty/all-null/12k-row batches, bool validity bitmaps,
  8-byte-boundary string lengths, params. Zero correctness findings; two doc nits.
- **FuzzHunter3 — differential fuzzer** (`fuzz3/`). ~58.8k (graph,query) pairs.
  **Focus areas (var-length, reachability, EXISTS, CALL, aggregates): ZERO real
  divergences.** 6 divergence classes, all in the scalar-expression / value-repr
  surface (D1–D6 below).

## Fixed this round (byte-identity bugs, obvious fix)

- **HIGH · eager var-length enumeration** → `fix(gql): var-length walker
short-circuits`. Native's `reachable()` eagerly collected every trail endpoint into a
  `Vec` before the consumer ran, so `EXISTS` / `NOT EXISTS` / `LIMIT` over a var-length
  pattern on a **dense** graph hit the trail budget and faulted `E_RESOURCE_EXHAUSTED`
  where TS (a lazy generator) short-circuited and returned the correct answer. Made the
  walker lazy: `reachable_each` streams each endpoint to a callback that returns `false`
  to stop. Because the callback can re-enter the walker (a nested quantified segment)
  while the outer marks are live, the reused edge-mark buffer moved from a single `Ctx`
  cell to a small pool (`take_marks`/`return_marks`). Verified on dense cliques incl.
  nested-quantifier EXISTS / cyclic+LIMIT / chained quantifiers.
- **D1 · HIGH — boolean literal coerced to number in vectorized compare** →
  `fix(gql): don't numerically coerce a boolean vs a number`. The per-row comparator
  took the numeric fast path for any non-`Gen` pair, so `WHERE 1 = true` **passed** a
  filter (`1==1`), `0 = false` was `true`, `0 < true` was `true`. The LPG model treats
  boolean-vs-number as cross-type (eq→false, order→null) — which native's own
  const-fold/IN/CASE/property paths and TS already do. Routed mixed Num/Bool to the
  scalar fallback.
- **D3 · `to_string(-0.0)`** → `fix(gql): render negative zero as "0"`. `js_num` used
  Rust's Display (`"-0"`); JS `String(-0)` is `"0"` and the numeric model normalizes
  −0→0. Native diverged from TS; normalized before formatting.
- **Doc · `arrowTable` phantom API** → the roadmap named a `arrowTable(blob)` export
  that never existed; corrected to the real surface (`queryArrowIpc` / `toArrowIPC` /
  `decodeArrow`).

## Not a bug (investigated, dropped)

- **D6 · raw temporal echo shape.** FuzzHunter3 saw native `{"@date":"…"}` vs TS
  `{"days":…,"kind":"date"}`. **Harness artifact, not an engine bug:** the shared
  `stable()` walks `Object.keys()` without calling `toJSON()`, exposing the TS
  temporal object's internals. Under real `JSON.stringify` (which invokes the
  `toJSON()` that emits the tagged form) native and TS are **byte-identical** (verified).
  Same root as PathNav's harness note — future rounds should use a `toJSON`-aware
  comparator (`stableJ`) for element/Path/temporal results.

## Deferred to `DESIGN-DECISIONS-MORNING.md` (need a decision, not an obvious fix)

- **Gremlin element form** (MED): native Gremlin emits reference `{id,label}` while
  native GQL and TS Gremlin emit full `{id,labels[],properties}` — canonical-form choice
  (reference vs full; `label` vs `labels`), heavy ported-test churn to change.
  Recommendation: align native Gremlin to the full form for cross-engine consistency.
- **Error-code split** (LOW): edge variable on a quantified segment → native `E_SYNTAX`
  vs TS `E_UNSUPPORTED` (both correctly reject).
- **D2 number→string notation** (MED): decimal (native, Rust Display) vs exponential
  (TS, JS `Number.toString`) at magnitude extremes (|x|<1e-6, |x|≥1e21). Needs a
  canonical decision, then match JS or match Rust in both.
- **D4 list→string null element** (MED): native `"1,null,3"` vs TS `"1,,3"`.
- **D5 `power()` precision** — **DECIDED (user): won't fix, leave to the platforms**
  (f64 = what JS gives; no sense exceeding JS precision). Differs only at extreme
  exponents (`power(100,100)`: native `1e+200` vs TS `1.0000000000000005e+200`).
- **`shortestPath` _algorithm-config_ footguns** (both engines agree): on the algorithm
  surface (`g.shortestPath({…})` / `CALL shortest_path` / free-fn), `direction` and
  Dijkstra `target` are accepted-but-ignored (the algo BFS/Dijkstra always follow
  out-adjacency; only A\* honors `target`). Separate from the Gremlin `shortestPath()`
  _step_, whose direction works. NB `ShortestPath.direction` is a lenke extension —
  TinkerPop uses `ShortestPath.edges`, not a `direction` key.
- **Reserved-keyword error message** (DX, both engines): `GROUP`/`ON` as labels give an
  opaque `E_SYNTAX` with no "quote with backticks" hint.
- **Arrow list-column flatten** (doc): a list column flattens to non-JSON text
  (`"[a,b]"`) — documented as lossy but worth a caveat.

## Coverage gaps (harness, not engine)

- `_MERGE` upsert semantics need host `createUniqueConstraint`, which the shared harness
  doesn't set up (both engines fault identically without it).
- Gremlin TS-vs-native needs a builder↔string translation layer the harness lacks.
- `stable()` isn't `toJSON`-aware (see D6) — use `stableJ` for element/Path/temporal.
