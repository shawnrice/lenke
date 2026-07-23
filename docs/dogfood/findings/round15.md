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
- **HIGH · `sum`/`min`/`max` over list-valued columns** — was: `sum([3],[1],[2])` native
  `null` / TS `6` (element-sum); `min` native `[3]` (first-scanned) / TS `[1]`. **FIXED**,
  guided by prior art (SQL/Postgres/DuckDB/Cypher/ISO all agree): **`sum`/`avg` over a list →
  throw** `E_DATA_EXCEPTION` (nobody element-sums; that's the Gremlin `Scope.local` job);
  **`min`/`max` → element-wise lexicographic** via the total order, recursing. Both engines
  now agree — and this exposed a _latent_ bug: TS `compareValues` had **no** list branch, so it
  fell through to `x < y` which string-coerces arrays (`[10] < [9]`); native's `cmp_total`
  returned `Equal` for any two lists. Both now compare element-wise (native `cmp_total` + TS
  `compareValues`), so `min`/`max` AND `ORDER BY` over lists are well-defined and identical
  (e.g. `[10]` vs `[9]` → `[9]`/`[10]`, not string order). Regression:
  `constraint-conformance.test.ts` (list-in-aggregate differential). **Gremlin cross-check:**
  native-Gremlin == TS-Gremlin (both throw `E_INVALID_VALUE` for list sum/min/max) — the
  Gremlin frontend keeps its own TinkerPop-flavored semantics (throw, not order), distinct
  from GQL by design; unaffected by this GQL fix (separate code path).
- **WON'T-FIX (works as designed) · index-listing order** — `vertexIndexes()`/`edgeIndexes()`
  order differs (native sorted, TS insertion-order). Per the order-is-unspecified policy this
  is a set, not an ordered result; compare as a set. No change.
- **WON'T-FIX · `power`/`pow`/`^` differ by ≤1 ULP cross-engine** — the pure-TS engine uses
  V8's `Math.pow`/`**`; the native/wasm engines use Rust `powf` (glibc `pow`). They agree to
  the bit almost everywhere but differ by **≤1 ULP** on some inputs: `power(0.7,10)` → native
  `0x3f9ceceb4e8dc4af` / TS `…4ae`; `power(2,-0.5)` → native `0x3fe6a09e667f3bcd` / TS `…bcc`.
  Confirmed identical in GQL (`RETURN power(…)`) and Gremlin `math()` (`pow`/`^`) — same shared
  kernel. **Every other numeric function is byte-identical** (trig/`sqrt`/`exp`/`ln`/`log10`/
  `atan2`/…): a raw-f64-bit differential over 1117+ `math()` pairs found **zero** non-`pow`
  divergences. A true fix needs a shared deterministic pow kernel (e.g. a vendored soft-float
  `pow`), deferred as not worth the cost. Documented at the `Power` kernel in both engines
  (`gql/eval.rs`, `gql/executor.ts`) and in `packages/gql/README.md`.

## Gremlin `math()` extension (this session, follow-up to 6129010)

- **FIXED · bare/juxtaposition function form `sin _` broke byte-identity.** `math('sin _')`
  (a documented TinkerPop form, no parens) faulted with **different error codes** — native
  `E_INVALID_VALUE`, TS `E_UNSUPPORTED` — while `sin(_)` agreed. Two fixes: (1) both engines
  now **parse the bare form** (`sin _` == `sin(_)`, binds tighter than binary ops, chains
  right-assoc `sin cos _` == `sin(cos(_))`, arg is a full unary so `abs -3` works; multi-arg
  `atan2`/`pow`/`log` still require parens); (2) **all `math()` faults now carry ONE code,
  `E_INVALID_VALUE`, on both engines** (the TS parser previously threw plain `Error`/
  `Unsupported`). Differential now compares raw f64 bits for successes **and** error codes for
  failures — zero divergences (except the `pow` ULP note above). The plan path (conformance
  emitter) and the native textual path (`g.gremlin("…math('sin _')…")`) both agree.

## Byte-identical shared behavior (conformance/design notes, NOT divergences)

- **WON'T-CHANGE (works as designed) · invalid calendar dates roll over** — `DATE
'2025-02-29'` → `2025-03-01`, `DATE '2025-04-31'` → `2025-05-01`, on **both** engines; yet
  out-of-range fields (month 13, day 32) → `E_SYNTAX`. These dates are **representable** (a
  real date results), so this is NOT the temporal-arithmetic-overflow case (which throws
  because the result leaves the value model). It's a "which convention" call: legacy JS `Date`
  rolls over (lenke's choice), TC39 Temporal clamps (`overflow: 'constrain'` → Feb 28) or
  rejects (`'reject'`), SQL/Postgres/Neo4j reject. Keeping rollover is **consistent with
  lenke's own date arithmetic** (which also rolls over, only throwing when the result is
  genuinely unrepresentable) — clamping/rejecting _parsing_ while arithmetic rolls over would
  be the inconsistent choice. lenke dates are ultimately JS `Date`-semantics values; overflow
  is a legitimate property, not a bug. Repro: `.dogfood/round15/_verify_batch.ts`.
- **RESOLVED · `dumpSchema` non-idempotent after dropping a constraint's auto-index** — you
  could drop a unique constraint's backing index, then a `dump → apply → re-dump` would differ
  (the replay re-created the index), and a snapshot would resurrect it on warm boot. Now moot:
  the drop itself is refused (see the HIGH fix above), so that state is unreachable.
- **LOW · `log(x)` single-arg → `null`** — **NO-CHANGE (works as designed), documented.**
  Verified vs ISO grammar (`/tmp/opengql_GQL.g4`): `generalLogarithmFunction` is strictly
  two-arg `LOG(base, value)`; natural log is `LN`, base-10 is `LOG10` — there is **no** ISO
  single-arg `log`. But returning `null` here is **not** a `log`-specific bug: lenke uses a
  total-function arity model where a _known_ function with too few args returns `null` (only an
  _unknown name_ throws `UnknownFunction`). Verified byte-identically across siblings —
  `power(2)`, `mod(5)`, `atan2(1)` all → `null` too, and `sqrt(4, 9)` → `2` (extra arg
  ignored). Making `log` alone throw would break that uniformity and single out one binary
  function arbitrarily. Left the behavior unchanged; documented the arity model + the `ln`/
  `log10` pointer in `packages/gql/README.md` (scalar-functions bullet).
- **LOW · min-cardinality forces atomic node+edge creation** — **documented (docs-only, no
  code change).** With `Airport LOCATED_IN out 1..1`, a bare `INSERT (:Airport)` faults
  (0 < min) under per-statement atomicity; create node+edge in one statement or a
  `graph.transaction(…)`. Correct + byte-identical. Doc line added to the Constraints section
  of `packages/core/README.md` (under `createCardinalityConstraint`).

## Held up under pressure (worth recording)

Float64-bit-identical centrality/pagerank over 400 nodes; deterministic shortest-path
tie-breaking; all 13 `SchemaOp` kinds replicating + enforcing on replicas; encrypted snapshot
round-trips (tamper → `null`); `cardinality max:null` surviving both the CDC-log JSON and the
snapshot; unicode/emoji/quoted predicates replicating + snapshotting verbatim; apply-first
schema rejection never touching the WriteLog. ~13,000 fuzzed pairs with schema state agreement.
