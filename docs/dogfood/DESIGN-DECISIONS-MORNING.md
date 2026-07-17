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
- **Real Arrow IPC egress** (Marcus R10, task #53). ARW1 is in-process-only; no
  Feather/Parquet/IPC handoff to DuckDB/Polars/pandas. Biggest feature-store gap.

## Medium — algorithms & query surface

- **Sampled/approximate betweenness** (Marcus). Exact Brandes O(V·E) is unusable
  whole-graph at 100k+; needs a deterministic approximate variant (byte-identity).
- **labelPropagation resolution/seed knob** (Marcus). Degenerates to one community on
  hubby/scale-free graphs.
- **Personalized PageRank / random-walk-with-restart** (Ravi). Only global PageRank
  exists; seed-set personalized ranking is the graph-native recsys ranker.
- **SCC / simple-cycle operator + cyclic-match perf cliff** (R11). No SCC/simple-cycle
  primitive; cyclic variable-length match is ~2.5×/hop.
- **`ANY SHORTEST` can't close on its seed** (R11 B2). Misses self-cycles; `{m,n}(a)`
  workaround. Real matcher defect, delicate.
- **Sliding-window temporal aggregation** (R11). No windowed aggregate primitive.
- **Duration relational-order policy** (R11). `duration <op> duration` is UNKNOWN
  (three-valued) → silently drops WHERE rows; define when it's unambiguous, or keep
  instant-arithmetic as the sanctioned pattern (documented).
- ~~**Computed non-finite policy** (R11 D-inbox)~~ — RESOLVED (see "Defect follow-up").
- ~~**Temporal astronomical overflow** (R11 D4)~~ — FIXED `ce6c6a3` (overflow → null both).

## Medium — Gremlin completeness

- ~~**`order().by(<key>)` over `project()`/Map rows** (R11 BUG A)~~ — FIXED `982ea0c`
  (`by('key')` now projects the value off a Map/project-row in both engines).
- **`shortestPath()` is undirected** (R11). Add a direction option (documented as a
  footgun for now). — still open (feature-shaped; the wrong default is a correctness trap).
- **Gremlin CF steps** (Ravi). `where(neq('me'))`, `order(local).by(values, desc)`
  unsupported → idiomatic Gremlin collaborative-filtering inexpressible (GQL is fine).

## Medium — ORM / typed surface (Lena R10)

- **ORM CRUD on defineNode/Edge.** Today create/parse-only — no findUnique/update/delete/
  findMany/count/createMany. Repository layer in-scope for lenke, or app-layer?
- **Typed query builder.** `query()` is string-only; typed rows are a "trust me" cast.
  Expose column types from a prepared Plan, or a builder?
- **Public `quoteIdent` / safe-label helper.** Reinforced again in R12 (`at`/`value`).
  Given how many domain nouns are reserved, expose label/identifier escaping from
  `@lenke/gql`. Small API — naming decision.

## Medium — sync / CDC (Kenji R10)

- **`createReconnectingClient` omits the CDC surface** (biggest sync gap). The reconnect
  wrapper `Pick<>`s out subscribeWrites/onDisconnect/pushWrite/replay/clientId/receive →
  can't do multiplayer + reconnect together. Widen the surface?
- **Export `runWrite` from `@lenke/sync`.** Declared in protocol.d.ts:441 (the canonical
  write-dispatch) but not re-exported → hand-rolled ingest reimplements dispatch.
- ~~**CDC live-tail gap-detection**~~ — FIXED `8403c90` (a `from` cursor on the writes
  message trips `resync` on a gap/reorder).
- **Value-level scope / per-room CDC channel.** Interest routing is label-only → a
  many-room app replicates the whole graph per client. Needs a value-keyed write filter.
- **LWW tiebreak recipe / HLC.** `_MERGE … WHERE version < $v` diverges on colliding
  version stamps; no built-in Lamport/HLC or (version, clientId) tiebreak.
- **`RustGraph.store.free()` ergonomics.** Reinforced R12 — replica fleets fire
  GC-leak warnings; no easy deterministic free without `using`.

## Lower — misc

- **`mergeNdjson` not parallel** (Marcus). COPY-FROM path 25% slower than parallel
  `graphFromNdjson`.
- **HAVING** — NOTE: not ISO GQL (ISO uses WITH-pipe filtering). WAI, not a gap;
  listed only to close it out.
- **Natural-key addressing** (R11) — a string `VertexRef` is a vertex UUID, not a
  business key; documented, but a business-id addressing convenience is a possible feature.
- **Bitemporal built-in** — MegaApp (R12) and KnowGraph (R11) both hand-roll bitemporal
  as `ProfileVersion` nodes; correct but easy to get the correction/supersession logic
  wrong. Is a bitemporal helper (or documented recipe) in scope?
