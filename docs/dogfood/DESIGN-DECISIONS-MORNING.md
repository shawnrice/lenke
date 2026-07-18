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

---

## High priority — carried from rounds 10–11

- **Planner no-index multi-hop cliff** (Ravi R10; re-quantified R12 S-scale). A
  literal-bound anchor without an index seeds from the wrong end: `(me{uid:$id})-[:R]->
()<-[:R]-(peer)-[:R]->(rec)` = 71,000 ms unindexed vs 5.7 ms indexed; 4-hop `WHERE`
  vs inline is ~190× at 6M. Anchor label-scan is ~1.6 ms, so it's join-order/seed
  selection, not seek cost. A join-order heuristic change (or at least a plan warning)
  — risks regressions, needs profiling. Top perf item.
- **Auto-index / primary-key hint** (Marcus R10). Id-like lookups full-scan until
  `createVertexIndex` (683× speedup when indexed). Auto-index, or a PK declaration?
- ~~**Real Arrow IPC egress**~~ (Marcus R10, task #53) — SHIPPED `@lenke/native/arrow`:
  `toArrowIPC(blob)` / `arrowTable(blob)` reconstruct a real apache-arrow Table from
  the ARW1 buffers (which already are Arrow's physical layout) and emit standard
  flatbuffer-framed IPC (stream default, or file/Feather-v2) — what DuckDB/Polars/
  pandas read. apache-arrow is an optional peer dep on that subpath only; core stays
  dependency-free. Verified by round-tripping both layouts through apache-arrow.

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
  membership: SCC size>1 or self-loop, byte-identical, `CALL on_cycle`). Simple-cycle
  ENUMERATION + the cyclic-match perf cliff (~2.5×/hop) still open.
- ~~**`ANY SHORTEST` can't close on its seed** (R11 B2)~~ — FIXED `ada1782` (BFS now
  tracks the shortest cycle back to the seed; `->+(a)` finds it, both engines).
- **Sliding-window temporal aggregation** (R11). No windowed aggregate primitive.
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
- **LWW tiebreak recipe / HLC.** `_MERGE … WHERE version < $v` diverges on colliding
  version stamps; no built-in Lamport/HLC or (version, clientId) tiebreak.
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
  business key; documented, but a business-id addressing convenience is a possible feature.
- ~~**Bitemporal built-in**~~ — **DECIDED: docs, not a built-in.** A bitemporal helper
  isn't in scope; the pattern is a documented recipe instead — see
  `docs/guides/bitemporal.md` (edge-period AND version-node modelling, the two time
  axes, correction/supersession, point-in-time "as of" queries, the supersession
  pitfalls MegaApp/KnowGraph hit).
