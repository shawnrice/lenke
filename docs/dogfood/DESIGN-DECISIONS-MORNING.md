# Design decisions — morning brief (overnight rounds 10–12)

Everything the autonomous run deferred because it needs a **design decision** (a policy,
an API-shape choice, or a delicate change that shouldn't land unattended). Obvious bugs
were already fixed and committed (see each round's findings). Ordered by priority.

Round 12 was interrupted (host OOM on the 10M scale tier) and resumed; its four items
(C1, F3, F1, S1) are new this session and sit at the top.

---

## ⚠️ Top priority — new this round

### C1 · Native SIGSEGV on a long operator chain (crash / DoS-class)

A single query — `RETURN true AND true AND … (100k terms)` — **crashes the native
process** (core dump; repro also at 35k terms via napi). Root cause is understood and
localized:

- `parse_and`/`parse_or_xor` (`crates/lenke-core/src/gql/parser.rs`) build the chain
  **iteratively**, so the `descend` recursion guard (`MAX_DEPTH = 128`) never trips —
  it only bounds parser _recursion_ (parens/lists/NOT), which is why those reject
  cleanly. The resulting ~100k-deep left-nested `Expr::And` tree then overflows the
  stack when **evaluated or dropped**.
- TS throws an uncatchable `RangeError` on the same input (survives, but uncoded) — so
  the engines already diverge here.

**Decision needed:** how to bound this byte-identically. Options:

1. **Shared depth cap** — count operator-chain length in the iterative parse loops
   (`and`/`or`/`xor`/comparison/additive/multiplicative/concat) against a limit, return
   `E_SYNTAX "Query nested too deeply"` in _both_ engines (align TS's `RangeError` to
   `E_SYNTAX`). Simple, precedented by the paren guard — but `MAX_DEPTH = 128` is too low
   for machine-generated `AND`/`OR` chains, so it needs its **own, higher cap value**
   (a policy pick).
2. **Iterative eval + custom `Drop`** for left-associative chains — no cap, no new
   rejections, but a bigger Rust change and it doesn't fix the TS `RangeError` (so
   byte-identity would then diverge the _other_ way unless TS is also made iterative).

Recommendation: (1) with a generous dedicated cap (e.g. 10k) + a conformance differential;
it's the byte-identity-preserving choice. Confirm the cap value.

### F3 · UNIQUE constraint check timing — TS eager vs native deferred

Native defers unique checks to **commit** (matching the R-TX deferred-check design);
TS checks them **eagerly** at INSERT/SET. A transaction that transiently duplicates a
unique key and resolves it before commit is accepted by native but rejected by TS
(`E_CONSTRAINT_VIOLATION`). REQUIRED constraints already defer in both engines, so the
target behavior is settled — native is correct. **Decision:** approve moving TS unique
validation out of the eager INSERT/SET path (`packages/gql/src/executor.ts`) into the
commit-time deferred pass (where required already lives), and re-baseline the autocommit
constraint tests that currently pin the eager error. Delicate but well-specified.

### F1 · Lone UTF-16 surrogate — TS accepts, native rejects

TS accepts `"\ud800"` as a string value (NDJSON load + INSERT `$param`); native rejects
`E_INVALID_JSON`. **Decision:** adopt native's stricter policy (reject lone/unpaired
surrogates at every entry point, aligning TS — same shape as the round-11 D2/D3 param
tightening) and pick the error code (`E_INVALID_JSON` vs `E_INVALID_VALUE`). Low-risk
once the policy is stated.

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
- **Computed non-finite policy** (R11 D-inbox). `1.0/0.0` throws `E_DATA_EXCEPTION` but
  `1e308*10.0` silently stores/returns null — reconcile overflow-vs-error for computed
  values across both engines.
- **Temporal astronomical overflow** (R11 D4). `DATE + P10000000Y` wraps to a negative
  year in native (i32 day count) vs f64 in TS — needs a valid-range/overflow policy.

## Medium — Gremlin completeness

- **`order().by(<key>)` over `project()`/Map rows** (R11 BUG A). Shared engine limitation
  (not TS drift); needs a `by(select(key))` feature.
- **`shortestPath()` is undirected** (R11). Add a direction option (documented as a
  footgun for now).
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
- **CDC live-tail gap-detection.** Add a per-message seq check on the live tail that
  trips `resync` on a gap/reorder (reconnect path gap-detects; tail doesn't). FIFO
  assumption is documented; this makes it robust.
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
