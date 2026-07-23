# Round 15 findings — dogfood the shipped R-SCHEMA-REPL + broad differential (3 personas)

Weighted toward hammering this session's new work (schema replication over the CDC log +
cold-boot snapshot via `dumpSchema`/`graphFromSnapshot`), plus a fresh full app and a
schema/GQL differential fuzzer. **Verdict: the R-SCHEMA-REPL work is solid** — it held
byte-identical under adversarial pressure (all 13 op kinds, encrypted round-trips, late-join
backlog replay, apply-first rejection). The divergences found are all in _older_ surfaces
(constraint/index coupling, aggregate semantics over exotic column types) that the new
`dumpSchema` probing happened to expose.

## Personas

- **ReplicaFleet** (`replicafleet/`, ~1086 LOC). Server-authoritative multi-tenant issue
  tracker; schema replication + cold-boot snapshot. **100/100 assertions pass.** All 13
  `SchemaOp` kinds replicate + enforce on replicas; encrypted snapshot round-trips; late
  joiner replays backlog in order; apply-first rejection never logs. Found the
  constraint/index coupling divergence (HIGH) via drop-index probing.
- **KnowledgeApp** (`knowledgeapp/`, ~1990 LOC). Airline route-network knowledge graph;
  GQL breadth + algorithms + Gremlin + R-TX + typed nodes. **502 assertions, 0 divergences,
  0 crashes.** pagerank/closeness/betweenness/degree/label-prop **float64 bit-identical**
  over ~400 nodes; shortest-path tie-breaks identical; Arrow IPC egress equals `.query()`.
  Only behavioral notes (all byte-identical).
- **SchemaFuzz** (`schemafuzz/`, ~13,000 graph pairs). Differential fuzzer: schema
  round-trip, snapshot v3 encode/decode, general GQL. **Schema state agreement (native
  `dumpSchema` vs TS readers) byte-identical across 6,000 randomized declaration scripts**
  (unicode/emoji/quoted/200-char labels); every tamper/truncation/wrong-key snapshot decoded
  to `null` without crashing. Found two aggregate divergences (F1, F2).

## Confirmed byte-identity divergences (all reproduced independently)

- **HIGH · `sum`/`avg` over a mixed numeric+temporal column** — was: native throws
  `E_DATA_EXCEPTION`, TS returns `null`. **FIXED** — TS now scans the whole group
  (`values.some(isTemporal)`, not just the first row) so a temporal anywhere throws, matching
  native. Rationale (user): a temporal in a numeric aggregate is an unrepresentable state →
  throw loudly (consistent with the temporal-overflow-throws decision); filtering is the
  caller's job. Both engines throw `E_DATA_EXCEPTION`. Regression:
  `constraint-conformance.test.ts` (temporal-in-aggregate differential).
- **HIGH · `dropVertexIndex`/`dropEdgeIndex` on a unique-constraint-backing key** — was:
  native kept enforcing (separate internal index), TS silently lost enforcement while still
  reporting the constraint active. **FIXED** — both engines now **reject** the drop with
  `E_INVALID_GRAPH_OP` (an index backing a unique constraint can't be dropped; drop the
  constraint first). Rationale (user): dropping the index would just make enforcement slow;
  refuse it. Wired through all layers (Rust `graph.rs` + FFI/wasm/napi, TS `@lenke/core`).
  Regression: `constraint-conformance.test.ts` (drop-refused differential). Also resolves the
  `dumpSchema`-idempotency-after-index-drop note below (that state is now unreachable).
- **OPEN (pending prior-art decision) · `sum`/`min`/`max` over list-valued columns** —
  `sum([3],[1],[2])`: native `null`, TS `6` (sums elements). `min`: native `[3]`
  (first-scanned, **no comparison**), TS `[1]` (lexicographic). Native min/max over lists is
  under-implemented. Repro: `schemafuzz/repro_agg.ts`, `.dogfood/round15/_verify_agg.ts`.
  **Prior art (SQL/Postgres/DuckDB/Cypher/ISO):** `sum`/`avg` over an array/list → type
  ERROR (nobody element-sums); `min`/`max` → element-wise lexicographic (arrays are ordered).
  So the likely resolution is _both throw for sum/avg_ (matching the #2 principle) and _both
  use lenke's existing total order for min/max_ (TS is already right; native must compare).
  Awaiting the go-ahead.
- **WON'T-FIX (works as designed) · index-listing order** — `vertexIndexes()`/`edgeIndexes()`
  order differs (native sorted, TS insertion-order). Per the order-is-unspecified policy this
  is a set, not an ordered result; compare as a set. No change.

## Byte-identical shared behavior (conformance/design notes, NOT divergences)

- **MED · invalid calendar dates silently roll over** — `DATE '2025-02-29'` → `2025-03-01`,
  `DATE '2025-04-31'` → `2025-05-01`, on **both** engines; yet out-of-range fields (month 13,
  day 32) → `E_SYNTAX` on both. Validation range-checks fields but not day-vs-month/leap-year.
  ISO GQL / Postgres / Neo4j reject `2025-02-29`. Consistent with this session's
  temporal-throw precedent, rejecting would be more coherent — but it's a shared behavior
  change + conformance-corpus update. Repro: `.dogfood/round15/_verify_batch.ts`,
  `knowledgeapp/_probe_dateinv.ts`.
- **RESOLVED · `dumpSchema` non-idempotent after dropping a constraint's auto-index** — you
  could drop a unique constraint's backing index, then a `dump → apply → re-dump` would differ
  (the replay re-created the index), and a snapshot would resurrect it on warm boot. Now moot:
  the drop itself is refused (see the HIGH fix above), so that state is unreachable.
- **LOW · `log(x)` single-arg → `null`** — only 2-arg `LOG(base, value)` computes; `ln`/`log10`/
  `exp` work. Wrong-arity returning `null` rather than an error, byte-identical. Verify vs ISO.
- **LOW · min-cardinality forces atomic node+edge creation** — with `Airport LOCATED_IN out
1..1`, a bare `INSERT (:Airport)` faults (0 < min) under per-statement atomicity; create
  node+edge in one statement or a tx. Correct + byte-identical; worth a doc line.

## Held up under pressure (worth recording)

Float64-bit-identical centrality/pagerank over 400 nodes; deterministic shortest-path
tie-breaking; all 13 `SchemaOp` kinds replicating + enforcing on replicas; encrypted snapshot
round-trips (tamper → `null`); `cardinality max:null` surviving both the CDC-log JSON and the
snapshot; unicode/emoji/quoted predicates replicating + snapshotting verbatim; apply-first
schema rejection never touching the WriteLog. ~13,000 fuzzed pairs with schema state agreement.
