# Round 10 findings — full, ambitious apps (autonomous overnight run)

Four personas each built a **complete, runnable application** (not a slice) on the
main checkout against current code. Verdict: **the engine is extremely solid — zero
correctness bugs across all four full apps.** Every "failure" traced to a persona's
own code; the constraints/engine correctly rejected mistakes. The round-9 additions
(`defineEdge`, betweenness/closeness centrality, sync `clientId`) all held up under
heavy real use, including an adversarial raw-f64-hex byte-identity check.

Code: `.dogfood/round10/<persona>/` (gitignored scratch).

## Persona results

- **MarcusFull — analytics / feature-store** (105k nodes / 1.1M edges). Full 4-stage
  platform; all 8 algorithms incl. new centrality with `writeProperty`; native FFI
  bulk path; **cross-engine byte-identity verified by comparing raw f64 hex bits —
  bit-identical on 4 algorithms.** Zero bugs. Full algo suite over 100k in ~475ms.
- **LenaFull — typed ORM** (962 LOC). `defineNode` **+ `defineEdge`**, typed CRUD,
  relations, constraints, transactions, atomic migrations. 41/41 assertions, zero
  bugs. App-boundary schema + engine-constraint composition works as documented.
- **RaviRecs — recommendation engine** (50k users / 8k items / 811k interactions).
  Collaborative filtering, personalized ranking, co-occurrence scoring. p50 **19ms**,
  17× personalization lift, R-TX rollback byte-exact over 200 cycles. Zero bugs.
- **KenjiFull — collaborative kanban** (CDC sync). Dozens of concurrent clients,
  26/26 scenarios, deterministic convergence; new `clientId` origin-skip across
  reconnect verified. Zero crashes / wrong results / double-applies.

## Cypher-vs-ISO gate (working as intended)

Personas reached for Cypher-isms that lenke **correctly rejected**: a pattern
comprehension `[ (me)-[:R]->(x) | x.id ]` (Ravi) and `SKIP` (Cypher synonym) —
both non-ISO. The ISO forms (`NOT EXISTS { … }`, `OFFSET`) work. Two frictions that
_looked_ like Cypher turned out to be genuine **ISO conformance gaps** and were
fixed (below).

## Fixes applied (verified green, byte-identical, committed — not pushed)

- **`e6aa6a4`** `LIMIT $param` / `OFFSET $param` — ISO (`nonNegativeIntegerSpecification`
  accepts a dynamic parameter); both engines, byte-identical, eager `E_INVALID_VALUE`
  on a non-integer bound. `SKIP` stays rejected (Cypher).
- **`e6aa6a4`** `WHERE n:Label` — ISO COLON label-test predicate (opengql:2078); the
  `IS [NOT] LABELED` form with full label-expressions was already implemented, only
  the `:` sugar was missing. Reuses the pattern label-expression matcher.
- **`28ae8fc`** `defineNode`/`defineEdge` validation errors now attach `details.issues`
  (Standard-Schema path+message) for field-level handling.
- **`38a3a7a`** docs: ARW1 header widths (u64); `CALL … YIELD node` yields the whole
  vertex element; `~standard.types` carrier needed for inference; reserved-word domain
  nouns (Product/Order/Group/Value/Count/Sum/Path; corrected a stale `key`-is-reserved
  claim); CDC live-tail assumes in-order (FIFO) delivery.

## Deferred to the morning design brief

Planner no-index multi-hop cliff (⚠️ top perf item), auto-index/PK hint, real Arrow
IPC egress, sampled betweenness, personalized PageRank, Gremlin CF steps,
`createReconnectingClient` CDC surface, `runWrite` export, value-level CDC scoping,
LWW tiebreak/HLC recipe, ORM CRUD, typed query builder, `quoteIdent` helper,
`store.free()` ergonomics, LP resolution knob, mergeNdjson parallelism. See
`DESIGN-DECISIONS-MORNING.md`.
