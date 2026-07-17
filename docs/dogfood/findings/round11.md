# Round 11 findings — integrative + adversarial (autonomous overnight run)

Four personas: one dedicated **cross-engine differential fuzzer** plus three
**integrative multi-subsystem** apps. Goal: after round 10's zero-bug result, push
harder to actually _find_ bugs. Verdict: **zero crashes across the entire round**;
the correctness core held everywhere except six specific edge-case bugs, all now
fixed byte-identical. Code: `.dogfood/round11/<persona>/` (gitignored).

## Persona results

- **FuzzHunter — differential fuzzer** (~320 query/input shapes). Zero crashes. A huge
  surface stayed byte-identical under adversarial pressure: numeric/math, unicode
  incl. surrogate-pair slicing, **float summation-order over a 2000-node 1e16+0.1
  mix**, temporal at normal magnitudes, mutations, codecs. Found 4 divergences (D1–D4).
- **KnowGraph — knowledge-graph / RAG backend** (26k nodes). Integrated typed schema +
  bitemporal validity + algorithms + multi-hop retrieval + as-of retrieval; 5/5 as-of
  assertions pass. Found the weighted-PageRank zero-weight bug (B1).
- **DepGremlin — dependency/supply-chain analyzer** (Gremlin-first, 2925 releases).
  Reachability/impact/hotspots clean & fast; found two Gremlin defects + the
  undocumented frontier-dedup idiom.
- **FraudRing — fraud detection** (285k vertices / 557k edges). **100% recall** on rings,
  mules, sprayers, velocity, identity clusters; transactional feature write-back.

## Cypher-vs-ISO gate (working)

Personas hit many Cypher-isms, all **correctly rejected**: `^` power, `SET += {map}`,
`-[:R*1..3]->` star quantifier, pattern-predicate `WHERE (a)-[:R]->()`, list
comprehensions, `trunc()/collect()/localtime()`, `LOCAL DATETIME '…'` literal. The ISO
forms all work. No Cypher-ism was silently mis-accepted.

## Fixes applied (verified green, byte-identical, committed — not pushed)

- **`74a5814`** (D1, HIGH) native NDJSON **and** pg-json codecs now coerce non-finite
  (±Inf/NaN) floats → null, matching TS + the documented numeric policy (was silently
  storing real `+Inf` from an overflowing literal → corrupt aggregates/filters).
- **`8c72aba`** (B1, HIGH) weighted PageRank treats a zero-total-out-weight node as
  **dangling** instead of dividing by zero (was NaN-poisoning every score to null).
- **`74a5814`** (D2/D3) TS param validation now matches native: `undefined`/function/
  symbol value → `E_MISSING_PARAMETER`; nested object/array → rejected; tagged-temporal
  objects + flat scalar lists still valid.
- **`f02e611`** docs: corrected an invalid `CALL…YIELD…ORDER BY` example in the
  algorithms guide; documented duration-comparison-is-UNKNOWN (use instant arithmetic),
  bare temporal literal prefixes (`DATETIME` not `LOCAL DATETIME`), the Gremlin
  frontier-dedup idiom, `shortestPath` is undirected, the `REPEAT_BUDGET` cap, the
  project/group container-type footgun, and that a string `VertexRef` is a vertex UUID.

## Deferred to the morning design brief

Gremlin BUG A (`order().by(key)` over projections — a _shared_ engine limitation, not
TS drift; needs `by(select(key))` feature), Gremlin `shortestPath` direction option,
SCC/simple-cycle operator, `ANY SHORTEST` can't close on its seed (B2), D4 temporal
astronomical overflow, computed-Inf-vs-div-by-zero policy, duration relational-order
policy, natural-key addressing (business-id vs vertex-UUID), bitemporal + variable-
length composition, `CALL…YIELD` composability, cheap temporal snapshot view, sliding-
window aggregation. See `DESIGN-DECISIONS-MORNING.md`.
