# Dogfood round 7 — Bianca — ontology reasoning: GQL var-length paths & Gremlin `repeat`

Domain: ontology / description-logic reasoning. Exercised GQL variable-length
relationship patterns (`->*`, `->+`, `->{m,n}`) and the Gremlin
`repeat(...).emit()/.emitBefore()/.until()` family for transitive-closure
reasoning: superclass climbing, type inference, transitive PART_OF, property
inheritance, SUBPROPERTY_OF chains, cycle handling, and forward-chaining
materialization.

Method: a seeded, ~460-class multiple-inheritance ontology (diamonds + one
deliberate SUBCLASS_OF cycle) plus 3003 instances is built once
(`ontology.ts`), and EVERY engine answer is checked against an independent
JS BFS/DFS transitive-closure oracle (`closureProper`/`closureReflexive`/
`descendantsProper`). All queries were actually run with `bun`.

Files: smoke.ts, ontology.ts, reason.ts, cycle_consistency.ts, sweep.ts,
materialize_probes.ts.

Bottom line: **this is a smooth round.** The crown-jewel capability
(variable-length path reasoning in BOTH engines) is byte-correct against the
independent oracle across all 460 classes — 0 mismatches — including diamonds,
cycles, zero-hop `*`, bounded `{m,n}`, and reverse traversal. No wrong-result
divergences surfaced. The friction points below are capability gaps / DX
footguns, not correctness bugs.

---

## FINDING 1 — edge INSERT is non-idempotent; forward-chaining materialization explodes (no edge MERGE/upsert) [MED · DX / MISSING-CAPABILITY, known-ish]

`materialize_probes.ts` section D. Iterating the one-step forward-chain rule to
a fixpoint in a JS loop:

```
MATCH (i:Individual)-[:TYPE]->(c:Class)-[:SUBCLASS_OF]->(p:Class) INSERT (i)-[:TYPE]->(p)
```

INSERT always creates a new edge — it never checks for an existing (i,TYPE,p)
pair — so each round re-derives and re-inserts every already-materialized edge.
Raw TYPE-edge count per round:

```
round 1:  3004 -> 5996        (distinct pairs 5995)
round 4:  23940 -> 50099      (distinct pairs 17200)
round 7:  240600 -> 523677    (distinct pairs 27564)  <- distinct closure reached
round 12: 8,234,414 -> 14,817,441 (distinct pairs 27564)
```

The _distinct-pair_ closure is CORRECT and converges to 27564 by round 7
(`diamondInst` fully-materialized TYPE set == JS reflexive closure -> `true`).
But raw edges grow ~2x/round to 14.8M while the useful set stays at 27.5k. For
the intended use (materialized/forward-chained inference) there is no idempotent
edge write: no edge `MERGE`, no unique-edge constraint, no `INSERT ... ON
CONFLICT`. Aligns with the charter's known gaps (`_MERGE` v1 is single-element;
no in-engine fixpoint). Script's own NOTE (line 94) flags it. Severity is DX:
the naive materialization loop a reasoning user would write silently blows up
memory rather than converging.

## FINDING 2 — GQL var-length patterns have no per-hop / intermediate-node predicate [LOW-MED · MISSING-CAPABILITY, documented-in-script]

`materialize_probes.ts` section B. `WHERE` on a var-length pattern only
constrains the ENDPOINT:

```
MATCH (x:Class {name:'D_bottom'})-[:SUBCLASS_OF]->+(s) WHERE s.name STARTS WITH 'D'
  -> ["D_left","D_top","D_right"]   // filters the bound endpoint s, correctly
```

There is no way to express "stop climbing when you reach a class named D_left"
(a per-hop / intermediate-vertex predicate). The var-length quantifier is a
pure reachability operator; intermediate nodes are not bindable or filterable.
Reasoning tasks that need bounded/guarded traversal (e.g. "ancestors up to but
not through a blocking class") must post-filter or drop to Gremlin
`repeat(...).until(...)`. Real ISO-GQL limitation more than a lenke bug, but
worth a docs note for the ontology use case. `emit()`/`emitBefore()` in Gremlin
cover most of the gap.

## FINDING 3 — script comment miscount, NOT an engine bug (recorded so it isn't re-chased) [INFO · DOCS/SCRIPT]

`materialize_probes.ts:56` asserts "#Individual vertices ... should be unchanged
= 3002 if INSERT reused bound vars"; actual is **3003**. Verified independently:
`buildOntology()` creates 3003 Individuals (3000 `i0..i2999` + `diamondInst` +
`carInst` + `contradiction`), and INSERT-from-MATCH added **zero** vertices
(3003 before -> 3003 after). So INSERT correctly reuses the bound `i`/`p`
vertices; the "3002" constant in the script comment simply forgot the
`contradiction` instance. Engine behavior is correct — no phantom vertex.

---

## Everything that works correctly (verified vs the independent JS closure)

GQL variable-length patterns:

- `->*(s)` reflexive closure — INCLUDES the start at zero hops (`a` in
  `[a,b,c,d]`; `D_bottom` in its own `*` result). (smoke.ts, materialize A)
- `->+(s)` proper closure — excludes start, >=1 hop. (smoke, reason 1/2/4/6)
- `->{1,2}` / `->{0,2}` bounded — exact hop counts (`{0,2}` includes start).
- Zero-hop `*` respects the endpoint LABEL filter: `*(s:Class)` on a Class start
  keeps the start; `*(s:Property)` on a Class start yields `[]` (start dropped
  because it fails the endpoint label). Correct and non-obvious. (materialize A)
- DISTINCT collapses diamond double-paths: raw `+` on `D_bottom` yields `D_top`
  and `Thing` twice (two paths — edge-distinct TRAIL semantics), `DISTINCT`
  gives the clean set. (reason 2)
- Cycle safety: on `Cyc_X -> Cyc_Y -> Cyc_Z -> Cyc_X`, `*`, `+`, `{1,10}`, and
  raw non-distinct `+` all TERMINATE and return `{Cyc_X,Cyc_Y,Cyc_Z}`
  (edge-distinct trail; each edge used once). Matches the cycle-safe JS closure.
  (cycle_consistency)
- WHERE on endpoint (`STARTS WITH`), `RETURN DISTINCT ... AS`, `$param` binding,
  multi-hop comma joins, and INSERT-from-MATCH reusing bound vars — all correct.

Gremlin `repeat`:

- `repeat(out).emit()` (post, excludes level 0) == JS proper closure.
- `repeat(out).emitBefore()` (pre, includes start) == JS reflexive closure.
- Reverse traversal `repeat(in_('SUBCLASS_OF')).emitBefore()` then `in_('TYPE')`
  for descendant/instance inference == JS. (reason 3)
- `repeat(out).emit()` terminates on the cycle (dedupe caps growth).
- `repeat(out).until(cyclicPath()).emit()` + `path()` correctly enumerates the
  member cycles `[Cyc_X,Cyc_Y,Cyc_Z,Cyc_X]` etc. (cycle_consistency)

Consistency reasoning (GQL):

- Cycle detection via self-reachability `(x)-[:SUBCLASS_OF]->+(s) WHERE s.name =
x.name` -> `{Cyc_X,Cyc_Y,Cyc_Z}`.
- Disjointness contradiction (`i` typed to two `DISJOINT_WITH` classes) detected
  via undirected `-[:DISJOINT_WITH]-`, directed + comma-join, AND with
  SUBCLASS closure on both sides -> `["contradiction"]` in all three forms.

**The sweep is the headline:** `sweep.ts` compares GQL `+ DISTINCT` and Gremlin
`repeat(out).emit()` superclass closure against the JS oracle for **all 460
classes**, plus type-inference closure for 39 sampled classes: **0 / 0 / 0
mismatches — ALL SETS MATCH JS CLOSURE.** `reason.ts` = 12 pass / 0 fail.

---

## Contrast with round 6 (Anouk)

Anouk's crown-jewel bug was `repeat(body).until(cond)` post-placement being
while-do instead of do-while, with `loops()` off-by-one. This round's reasoning
queries lean almost entirely on `emit()`/`emitBefore()` and GQL var-length
(which are correct), and the one `until()` use here — `until(cyclicPath())` —
happens to be robust to the placement semantics (cyclicPath can't be true at the
0-length start path, so while-vs-do-while is moot). So round 6's `until()`
divergence is NOT re-triggered by these ontology workloads, and is not
re-reported here.

## Coverage map

| Capability                           | Status                                                    |
| ------------------------------------ | --------------------------------------------------------- |
| GQL `*` reflexive (incl. self)       | Correct (start included at 0-hop, endpoint label honored) |
| GQL `+` proper                       | Correct                                                   |
| GQL `{m,n}` bounded                  | Correct (`{0,n}` includes start)                          |
| GQL DISTINCT over diamond paths      | Correct (trail semantics; DISTINCT collapses)             |
| GQL var-length on cycles             | Correct (edge-distinct trail terminates)                  |
| GQL WHERE / $param / comma-joins     | Correct                                                   |
| GQL intermediate-node predicate      | **Missing** (F2 — endpoint-only WHERE)                    |
| Gremlin emit / emitBefore            | Correct (post / pre placement)                            |
| Gremlin reverse `in_` closure        | Correct                                                   |
| Gremlin repeat on cycle / cyclicPath | Correct                                                   |
| Cross-engine agreement (460-sweep)   | Correct (0 mismatches, GQL == Gremlin == JS)              |
| INSERT-from-MATCH (reuse bound vars) | Correct (no phantom vertices)                             |
| Forward-chain edge idempotency       | **Missing** (F1 — no edge MERGE; raw edges explode)       |
