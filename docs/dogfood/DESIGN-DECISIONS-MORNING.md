# Design decisions — morning brief (overnight rounds 10–12)

Everything the autonomous run deferred because it needs a **design decision** (a policy,
an API-shape choice, or a delicate change that shouldn't land unattended). Obvious bugs
were already fixed and committed (see each round's findings). Ordered by priority.

Round 12 was interrupted (host OOM on the 10M scale tier) and resumed. Its three
correctness findings — **C1** (crash), **F3** (unique-check timing), **F1** (lone
surrogate) — were triaged with the user and **fixed this session** (commits `8001891`,
`569bf2b`, `6654813`); see `findings/round12.md`. What remains for the morning is the
capacity note **S1** plus the carried-over inbox below.

---

## 🧭 Triage (2026-07-18) — doing NONE of the remaining items now

Every open item below was reviewed against three questions: is it just missing
**user indexing**, does it belong **outside the library**, or is it **already covered
by docs / decided**? Verdict: **none are being taken up.** Each is annotated inline
with its disposition. Summary:

- **User-side (index your keys — `createVertexIndex` already exists):** no-index
  multi-hop cliff, auto-index/PK hint, natural-key addressing. Auto-indexing arbitrary
  properties is a write-amplification / memory anti-pattern, not a feature.
- **Outside the library:** typed query builder (userland DX, same call as ORM CRUD),
  sliding-window aggregation (delegate to DuckDB via the shipped Arrow egress),
  server-enforced CDC scopes (host/auth layer, by design).
- **Already docs / decided:** algorithm memory sizing (in `algorithms.md`), LWW/HLC
  (design note → **recipe, not a built-in**, matching bitemporal).
- **Inherent / mostly done:** cyclic var-length enumeration (exponential output;
  existence/shortest/distinct already BFS — see this session's routing fixes).

**There is no planner / planning stage in the engine**, so any idea that assumed one
(e.g. a "plan warning" for the no-index cliff) has no home and is dropped.

---

## 🆕 Round 13 — deferred items (2026-07-18)

A fresh 4-persona round (RBAC engine, routing/shortest-path, Arrow egress, differential
fuzzer). The surfaces changed this session (var-length, reachability, EXISTS, CALL,
aggregates) held byte-identical across ~58k+ checks. Obvious bugs were **fixed +
committed** (eager var-length enumeration → short-circuiting walker; D1 boolean-vs-number
coercion; D3 `-0`→`"0"`; the `arrowTable` doc); see `findings/round13.md`. These remain
**deferred — each needs a decision, not an obvious fix:**

- **Gremlin element form** (MED). Native Gremlin serializes an element as reference
  `{id,label}` (singular `label`, no properties); native **GQL** and **TS** Gremlin emit
  full `{id,labels[],properties}`. Cross-engine byte-identity break on every
  element-returning traversal. **Recommendation:** align native Gremlin to the full form
  (2 of 3 surfaces already use it; native Gremlin is the outlier) — but it's a Gremlin
  output-contract change with heavy ported-test churn, and there's a TinkerPop argument
  for reference form, so it's a deliberate call.
- **Number→string notation** (D2, MED). `to_string`/`CAST … AS STRING` renders decimal
  in native (Rust Display: `"0.0000000001"`, `"1000000000000000000000"`) vs exponential
  in TS (JS `Number.toString`: `"1e-10"`, `"1e+21"`) at magnitude extremes (|x|<1e-6,
  |x|≥1e21). `js_num` is _named_ for JS parity, so JS notation is arguably canonical —
  but matching JS's exact shortest-round-trip + exponential thresholds in Rust is
  non-trivial. Pick canonical, then align both.
- **List→string null element** (D4, MED). `to_string([1,null,3])` → native `"1,null,3"`
  vs TS `"1,,3"`. Null-first-class policy leans toward `"null"`; pick + align.
- **`power()` precision at extreme exponents** (D5). **DECIDED (user, 2026-07-18):
  won't fix — leave to the platforms.** `power(100,100)` → native `1e+200` vs TS
  `1.0000000000000005e+200`, differing only at extreme exponents where the platforms'
  `pow` (Rust libm vs V8 `Math.pow`) round differently. The numeric model is f64 =
  exactly what JS provides; there's no sense supporting more precision than JS, and
  forcing bit-identity would mean reimplementing one platform's `pow` on the other.
  Accept the platform-level divergence at magnitude extremes.
- **Error-code split** (LOW). Edge variable on a quantified segment (`(a)-[e:R]->*(b)`)
  → native `E_SYNTAX` vs TS `E_UNSUPPORTED`. Both correctly reject; align the code.
- **`shortestPath` algorithm-config `direction`** → **FIXED** `72f08d2`. The
  `direction:'out'|'in'|'both'` config field on the algorithm surface
  (`g.shortestPath({…})` / `CALL shortest_path` / `@lenke/core` free-fn) was accepted but
  silently ignored (BFS/Dijkstra/A\* hardcoded out-adjacency). Now honored like `degree`,
  both engines byte-identical (verified out≠in≠both, weighted+unweighted). This is where
  direction belongs. **Still open:** Dijkstra `target` is still accepted-but-ignored (only
  A\* honors it) — deciding whether `{target}` should return a single row or the full map
  is a separate result-shape call.
- **Non-standard `ShortestPath.direction` Gremlin modulator** → **DONE: reimplemented as
  the conformant `ShortestPath.edges`.** Replaced `.with(ShortestPath.direction,
'out'|'in'|'both')` (a lenke invention) with TinkerPop's `.with(ShortestPath.edges,
Direction.OUT|IN|BOTH)` in both engines — internal representation + execution unchanged,
  so results stay byte-identical; only the API surface conforms. Native parses
  `Direction.*` and rejects a non-`Direction` value; TS gained a runtime `Direction` enum.
- **Reserved-keyword error message** (DX, both engines). `GROUP`/`ON`/`USER`… as a label
  or rel-type gives an opaque `E_SYNTAX`; a "reserved keyword — quote with backticks"
  hint would save real confusion (backtick-quoting works on both engines).
- **Arrow list-column flatten** (doc). A list column flattens to non-JSON text
  (`"[a,b]"`) — documented as lossy, but worth a one-line caveat that it won't
  `JSON.parse` back.

---

## ✅ Fixed this session (was top priority)

- **C1 · native SIGSEGV on a long operator chain** → `8001891` (cap), then
  `7c38102`/`0336257`/`2603bb9` (n-ary AST). First a shared `MAX_CHAIN` bound stopped the
  crash byte-identically. Then — since a stack-tuned cap value is environment-dependent (a
  128 KB musl thread or WASM could crash below it) — the associative operator AST was made
  **n-ary** in both engines, so a long chain is a flat `Vec`, not a chain-deep tree, and
  every walk (both native evaluators, compile, drop, the analysis passes, the TS
  compile-to-closure evaluator) is a loop bounded by real nesting depth. Deep chains now
  _evaluate_ on any stack (proven at 500k terms); `MAX_CHAIN` is demoted to a pure
  anti-resource-abuse bound (default 10k, configurable per graph). Behaviour pinned by a golden regression suite written
  before the refactor; no follow-up needed.
- **F3 · UNIQUE check timing** → `569bf2b`. Removed the GQL executor's eager INSERT/SET
  pre-checks; the core already defers unique/required/type to commit (`runDeferredChecks`),
  so TS now matches native's R-TX deferred semantics.
- **F1 · lone UTF-16 surrogate** → `6654813`. Reject lone/unpaired surrogates with
  `E_INVALID_JSON` at the two TS ingest boundaries (serialization value normalizer + gql
  param validation), matching native serde.

### Defect follow-up (this session)

- **D4 · temporal astronomical overflow** → `ce6c6a3`. `DATE + huge DURATION` silently
  wrapped native's i32 day count to a negative year while TS produced a huge date. Now
  out-of-range date arithmetic yields **null** in both engines (non-representable → null,
  the same policy numeric overflow uses) — keeps the compact date backing, no divergence.
- **BUG A · Gremlin `order().by('<key>')` over `project()`/Map rows** → `982ea0c`. Both
  engines' `eval_by` only projected a key off a vertex/edge; for a Map row it returned the
  whole container → "cannot order an element with an element". Now `by('key')` projects the
  value at that key from a Map / project-row object. Byte-identical.
- **CDC live-tail gap-detection** → `8403c90`. The tail assumed in-order delivery and
  silently skipped a lost/reordered batch. A new optional `from` cursor on the writes
  message lets the client detect a gap/reorder and cold-boot (resync). Back-compat.
- **Computed non-finite policy** — RESOLVED earlier (round-11 value-model fix): `1e308*10`
  now → null in both engines; the `1/0`-throws vs overflow-nulls split is ISO-defensible.
  Removed from the list below.

## ⚠️ Remaining from this round

### S1 · Whole-graph algorithms ~2× the resident graph in peak RSS

The 10M tier (~30M elements) projects to ~37 GB after algorithms and OOM'd the host.
Not a bug, but a capacity fact worth a decision: document a memory-sizing guideline
(≈760 B/element resident, ~2× peak during algorithms), and/or consider streaming/blocked
algorithm variants for graphs that don't fit ~2× in RAM. Relates to "sampled/approximate
betweenness" below.

> **Verdict (2026-07-18): already covered by docs.** The memory-sizing guideline is
> documented in `docs/guides/algorithms.md` ("Memory sizing"). Streaming/blocked
> algorithm variants are pure YAGNI until someone runs a graph that doesn't fit ~2× in
> RAM — revisit on a real demand, not speculatively. **Not taking it up now.**

---

## High priority — carried from rounds 10–11

- **Planner no-index multi-hop cliff** (Ravi R10; re-quantified R12 S-scale). A
  literal-bound anchor without an index seeds from the wrong end: `(me{uid:$id})-[:R]->
()<-[:R]-(peer)-[:R]->(rec)` = 71,000 ms unindexed vs 5.7 ms indexed; 4-hop `WHERE`
  vs inline is ~190× at 6M. Anchor label-scan is ~1.6 ms, so it's join-order/seed
  selection, not seek cost.
  - **Verdict (2026-07-18): user-side (index your lookup keys). Not taking it up.**
    The 71,000 ms case is specifically an _unindexed point-lookup key_ (`{uid:$id}`) —
    an identity lookup every database expects indexed; with the index it's 5.7 ms. A
    join-order heuristic to rescue the no-index case is a large, regression-prone build
    for a user anti-pattern, and lenke **has no planner/planning stage** where such a
    heuristic (or a "plan warning") would even live. Guidance: index your point-lookup
    keys (docs). Reopen only if a cost-based planner is pursued for other reasons.
- **Auto-index / primary-key hint** (Marcus R10). Id-like lookups full-scan until
  `createVertexIndex` (683× speedup when indexed). Auto-index, or a PK declaration?
  - **Verdict (2026-07-18): user-side; API already exists. Not taking it up.**
    `createVertexIndex` is the answer. Auto-indexing arbitrary properties is a
    write-amplification + memory anti-pattern (surprise cost), not a feature. A PK/`@id`
    hint on `defineNode` is at most mild sugar over `createVertexIndex` — deferred.
- ~~**Real Arrow IPC egress**~~ (Marcus R10, task #53) — SHIPPED. Native
  `RustGraph.queryArrowIpc(q, {format})` frames standard Apache Arrow IPC in Rust;
  `toArrowIPC(blob, format)` from `@lenke/native/arrow` transcodes an `ARW1` blob
  (from `queryArrow`) to byte-identical IPC — both from the ARW1 buffers, which are
  already Arrow's physical layout — as stream (default) or file/Feather-v2, what
  DuckDB/Polars/pandas read. Decode an `ARW1` blob back to rows with `decodeArrow`
  (exported from `@lenke/native`). apache-arrow is a dev-only verifier; core stays
  dependency-free. Verified byte-identical native↔JS + reference-decoded through
  apache-arrow (round-13 ArrowPipe, 89 compares). (There is no `arrowTable` export —
  earlier drafts of this note named one; the real surface is the three fns above.)

## Medium — algorithms & query surface

- ~~**Sampled/approximate betweenness**~~ (Marcus) — SHIPPED. A `pivots` config runs
  Brandes from a deterministic evenly-spaced sample of k sources scaled by n/k
  (O(pivots·E)); evenly-spaced (not RNG) so both engines pick the same sources →
  byte-identical. `pivots >= |V|` == exact.
- ~~**labelPropagation resolution/seed knob**~~ (Marcus) — SHIPPED as `seedProperty`:
  a vertex carrying a non-null value for that key is an anchor (pinned to its own
  label), so communities form around seeds instead of collapsing. Byte-identical.
- ~~**Personalized PageRank / random-walk-with-restart**~~ (Ravi) — SHIPPED
  `personalizedPagerank` (@lenke/core fn, RustGraph method, GQL `CALL
personalized_pagerank`): restarts to a `sourceNodes` seed set, byte-identical
  native↔TS; empty/unknown seeds degenerate to global PageRank.
- **SCC + onCycle** — SHIPPED `stronglyConnectedComponents` (iterative Tarjan, min-index
  representative → byte-identical native↔TS; @lenke/core fn, RustGraph method, GQL
  `CALL strongly_connected_components`) and now `onCycle` (per-vertex directed-cycle
  membership: SCC size>1 or self-loop, byte-identical, `CALL on_cycle`).
  - **Simple-cycle ENUMERATION** — **WON'T FIX** (decided). Enumeration output is
    exponential in the worst case (Johnson's is output-sensitive; a dense graph has
    factorially-many simple cycles), so it's an unbounded footgun, and it doesn't fit
    the per-vertex `(node, value)` result shape (it returns a list of paths). The common
    need is already covered: `onCycle` answers "which nodes are cyclic," and `MATCH p =
(a)-[:R]->+(a)` / Gremlin `cyclicPath()` find a cycle through a given vertex. Revisit
    only if a concrete use case needs the complete cycle set — and only bounded (per-SCC,
    `maxCycles`/`maxLength`).
  - The cyclic variable-length **match perf cliff** (~2.5×/hop).
    **Verdict (2026-07-18): inherent + mostly addressed. Not taking it up.** Enumerating
    _all_ cyclic paths is exponential-output by nature (the trail count), so the ~2.5×/hop
    is intrinsic, not a fixable inefficiency. The cases that don't need all paths already
    route to O(V+E) BFS in both engines: **existence** (`EXISTS`), **shortest**
    (`ANY SHORTEST`), and **distinct endpoints** (`count(DISTINCT b)` / `RETURN DISTINCT
b`). This session also (a) reused a trail-mark bitset in the walker (~30% on genuine
    enumeration) and (b) fixed the count/EXISTS→BFS routing byte-identically. What's left
    would only come from a cost-based planner (see the no-index cliff above — also declined).
- ~~**`ANY SHORTEST` can't close on its seed** (R11 B2)~~ — FIXED `ada1782` (BFS now
  tracks the shortest cycle back to the seed; `->+(a)` finds it, both engines).
- **Sliding-window temporal aggregation** (R11). No windowed aggregate primitive.
  **Verdict (2026-07-18): outside the library. Not taking it up.** Window functions
  aren't in ISO GQL, and lenke already ships Arrow IPC egress to DuckDB/Polars precisely
  for this class of analytics — DuckDB has real `OVER (…)` window functions. Delegate
  windowed aggregation there (worth one doc pointer from the egress guide); don't grow a
  non-ISO window syntax in the engine.
- **Duration relational-order policy** (R11) — DECIDED: keep as-is (WAI). `duration <op>
duration` → UNKNOWN is spec-correct (durations aren't totally ordered: a month vs 30
  days is ambiguous), both engines identical, with the documented instant-arithmetic
  workaround; `ORDER BY` still uses a deterministic total order. Not a defect.
- ~~**Computed non-finite policy** (R11 D-inbox)~~ — RESOLVED (see "Defect follow-up").
- ~~**Temporal astronomical overflow** (R11 D4)~~ — FIXED `ce6c6a3` (overflow → null both).

## Medium — Gremlin completeness

- ~~**`order().by(<key>)` over `project()`/Map rows** (R11 BUG A)~~ — FIXED `982ea0c`
  (`by('key')` now projects the value off a Map/project-row in both engines).
- ~~**`shortestPath()` is undirected** (R11)~~ — DONE `fa227b7` (added
  `.with(ShortestPath.direction, 'out'|'in'|'both')`, default 'both'/undirected =
  TinkerPop-conformant; both engines). The undirected default was already conformant, so
  this was a missing option, not a wrong default.
- ~~**Gremlin CF steps**~~ (Ravi) — SHIPPED both engines byte-identical:
  `where(neq('me'))` (predicate-only where vs a step label), `order(local).by(values|
keys, desc)` (Column selector), and `select(Column.keys|values)` (the observable
  reader — a bare Map serializes key-sorted, so the ranked order shows through a
  list-producing step). The full recommendation traversal is now expressible.

## Medium — ORM / typed surface (Lena R10)

- ~~**ORM CRUD on defineNode/Edge.**~~ — **OUT OF SCOPE** (decided). A findUnique/
  update/delete/findMany/count/createMany repository layer is app-layer, not lenke's:
  the engine gives you GQL/Gremlin + `defineNode` validation; a CRUD/repository
  abstraction belongs in the application (or a separate userland package).
- **Typed query builder.** `query()` is string-only; typed rows are a "trust me" cast.
  Expose column types from a prepared Plan, or a builder?
  - **Verdict (2026-07-18): outside the library. Not taking it up.** A Kysely-style
    typed builder is a DX layer over string GQL, not a correctness gap — the same
    reasoning that put ORM CRUD out of scope. It belongs in userland or a separate
    package; string GQL stays the ISO-conformant interface. (`defineNode` already covers
    typed _writes_ via Standard Schema.)
- ~~**Public `quoteIdent` / safe-label helper.**~~ — SHIPPED `quoteIdent` from
  `@lenke/gql`: bare non-reserved names pass through, everything else is backtick-
  quoted with internal backticks doubled (ISO/SQL escape). Both lexers now decode a
  doubled backtick in a delimited identifier, so a backtick-bearing key round-trips.

## Medium — sync / CDC (Kenji R10)

- ~~**`createReconnectingClient` omits the CDC surface**~~ (was the biggest sync gap) —
  FIXED. Widened the reconnect surface to expose `clientId` + `subscribeWrites` +
  `onDisconnect` (which survive reconnect via the manager's internal `replay()`), AND
  added a `clientId` option threaded to the inner client so multiplayer identity /
  origin-skip holds ACROSS a reconnect. `receive`/`replay` stay internal by design
  (the manager owns the transport). Test proves cross-client writes arrive before AND
  after a reconnect (multiplayer + reconnect together).
- ~~**Export `runWrite` from `@lenke/sync`.**~~ — SHIPPED: `runWrite` (the canonical
  CDC write-dispatch) is now re-exported from `@lenke/sync`.
- ~~**CDC live-tail gap-detection**~~ — FIXED `8403c90` (a `from` cursor on the writes
  message trips `resync` on a gap/reorder).
- ~~**Value-level scope / per-room CDC channel.**~~ — SHIPPED (content-derived,
  measured cheap). A host configured with `scopeKey: 'room'` tags every committed
  write with its value-scope — the distinct values of that property across the
  write's touched elements, read natively via `graph.lastWriteScope` off the
  already-collected `tx_touched` set (~13 ns/read, <1% of the write; bench in
  `examples/cdc_extract_bench.rs`). A client `subscribeWrites(onWrites, { scopes:
['42'] })` then receives only its rooms — a many-room app no longer replicates the
  whole graph. Fail-open (an unclassifiable/unscoped write still forwards; scope only
  narrows) and an **optimization, not a security boundary** (client-declared, like
  the existing token routing). Deferred: traversal-resolved scope (scope on a related
  element, not a direct property) + server-enforced scopes from auth.
  - **Verdict (2026-07-18):** server-enforced scopes are **host/auth-layer, by design**
    — the doc already states scope routing is an optimization, not a security boundary,
    and auth is the host's job; not a library item. Traversal-resolved scope is a
    genuine-but-niche feature — **parked** until a concrete use case. Not taking either
    up now.
- **LWW tiebreak recipe / HLC.** `_MERGE … WHERE version < $v` diverges on colliding
  version stamps; no built-in Lamport/HLC or (version, clientId) tiebreak. **Design +
  threat model written** — `docs/design/conflict-resolution.md`: a client-assigned HLC
  is poisonable (skew-to-win + persistent clock-inflation that spreads on receive), so
  the stamp MUST be **host-assigned, bounded-skew-rejected, and advanced only host↔host**
  (clients propose, the host decides).
  - **Verdict (2026-07-18): already covered by the design note → recipe, not a
    built-in. Not taking it up.** This matches the bitemporal call (docs, not a
    built-in). The threat model actually argues _against_ shipping a naive built-in
    (a client-assigned HLC is poisonable), and the host-validation requirements are the
    same whether documented or coded. Reopen only if a first-class host-stamped `_MERGE`
    HLC path is specifically wanted.
- ~~**`RustGraph.store.free()` ergonomics.**~~ — SHIPPED `Store.free()`: deterministic
  imperative disposal (sever subscriptions + free the handle) without `using`;
  `[Symbol.dispose]` delegates to it. Idempotent.

## Lower — misc

- ~~**`mergeNdjson` not parallel**~~ (Marcus) — SHIPPED. `ndjson::append` now parses
  lines with the same rayon fan-out as `decode` (apply stays serial; order preserved →
  byte-identical merge).
- **HAVING** — NOTE: not ISO GQL (ISO uses WITH-pipe filtering). WAI, not a gap;
  listed only to close it out.
- **Natural-key addressing** (R11) — a string `VertexRef` is a vertex UUID, not a
  business key; documented.
  **Verdict (2026-07-18): user-side + already documented. Not taking it up.** A
  "business key → vertex" lookup is just `MATCH (n {bizKey:$k})` over an indexed
  property; the UUID-vs-business-key distinction is already documented. Sugar, not a gap.
- ~~**Bitemporal built-in**~~ — **DECIDED: docs, not a built-in.** A bitemporal helper
  isn't in scope; the pattern is a documented recipe instead — see
  `docs/guides/bitemporal.md` (edge-period AND version-node modelling, the two time
  axes, correction/supersession, point-in-time "as of" queries, the supersession
  pitfalls MegaApp/KnowGraph hit).
