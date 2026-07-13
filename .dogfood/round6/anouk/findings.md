# Dogfood round 6 — Anouk — `@lenke/gremlin` step-vocabulary audit

Graph: canonical TinkerPop "modern" fixture (`createTestTinkerGraph()`), plus a
hand-built 3-cycle for `cyclicPath`. All traversals were actually run with `bun`
and compared to hand-computed TinkerPop output. Native (Rust) parity checked
over `bun:ffi` for the crown-jewel case.

Files: 01-branching.ts 02-path.ts 03-loops.ts 04-aggregation.ts 05-projection.ts
06-mutation.ts 07-predicates-branch.ts 08-until-placement.ts 09-misc.ts
10-native-parity.ts (+ util.ts, probes).

---

## FINDING 1 — repeat(body).until(cond) is while-do, not do-while (post-placement ignored) [HIGH · DIVERGENCE-UNDOCUMENTED / BUG]

TinkerPop: until() AFTER repeat() is do-while — body runs AT LEAST once, THEN
cond checked. until() BEFORE repeat() is while-do. lenke does not distinguish
placement: it ALWAYS checks until BEFORE the body (while-do), so the post-form
emits the start unmoved whenever the start already satisfies the condition.

Root cause acknowledged in a source comment but NOT in GAPS.md (which claims the
TS engine is "gap-free" / "no skipped tests"):
packages/gremlin/src/steps/iteration.ts:43-46 —
"until() placement (BEFORE->do-while vs AFTER->while) is not yet distinguished.
Our until() always behaves as BEFORE-placement (do-while: check before applying
body each iteration)."
(The comment's terminology is inverted: check-before-body is while-do, not do-while.)

Clean repro (value condition, no loops()):
V(marko).repeat(out('KNOWS')).until(hasLabel('PERSON')).values('name')

- TinkerPop: body runs once -> {vadas, josh} both PERSON -> ["josh","vadas"]
- lenke (TS AND native): marko is already PERSON -> emit unmoved -> ["marko"] WRONG

Internal inconsistency (proves the bug with no external oracle): in TinkerPop
times(n) == until(loops().is(n)). In lenke they disagree:
V(marko).repeat(out()).times(2).values('name') -> ["lop","ripple"] (correct 2-hop)
V(marko).repeat(out()).until(loops().is(eq(2))).values('name') -> ["josh","lop","vadas"] (1-hop) WRONG
V(marko).repeat(out()).until(loops().is(eq(1))).values('name') -> ["marko"] (0-hop) WRONG
So loops() is effectively off-by-one in the post-until/emit predicate context: at
the first post-body check lenke reports loops()==2 where TinkerPop reports 1, and
until fires one check too early.

Native byte-identity (10-native-parity.ts, over parse.rs via ffi): native == TS
for every case (both wrong the same way); the times(2) control matches TinkerPop
on both. => SHARED divergence FROM TinkerPop, not a TS-vs-Rust drift.

GAPS.md documents it? No. Worse: crates/lenke-core/src/gremlin/ported_divergences.rs
locks these exact results in as TinkerPop-faithful (see FINDING 6).

---

## FINDING 2 — mid-traversal V() unsupported; breaks addE's own documented example [MED · MISSING-STEP + DOCS]

V() after the first step throws "LenkeError: V can only appear as the first step".
TinkerPop supports a mid-traversal V() (re-scan). The addE source docstring
(packages/gremlin/src/steps/mutation.ts:50) lists as supported:
traversal(V('1'), as\_('a'), V('2'), addE('KNOWS').from('a')) // "tag-form"
Running it verbatim THROWS. Sub-traversal forms work:
addE('KNOWS').to(traversal(V(), has('name','peter'))) // OK
addE('KNOWS').from(traversal(V(),...)).to(traversal(V(),...)) // OK
GAPS.md documents it? No.

---

## FINDING 3 — choose(test).option(...) option-map form missing; 1-arg choose crashes cryptically [LOW-MED · MISSING-STEP + DX]

TinkerPop choose has an option-map form choose(traversal).option(v, tr)...
lenke only implements ternary choose(test, then, else?). Calling choose with a
single arg throws an internal
TypeError: sub is not a function. (In 'sub({ steps: [] })', 'sub' is undefined)
from buildPlan(undefined) — not an arity error. branch(test).option(...) IS
implemented and works, so routing is covered, but the choose-shaped API is a
partial gap with an unhelpful failure. GAPS.md documents it? No.

---

## FINDING 4 — group().by(k).by(count()/reduce) returns per-element lists, not the reduced value [MED · BUG (known-ish); GAPS.md inaccurate]

V().hasLabel('SOFTWARE').group().by('lang').by(count())

- TinkerPop: {java: 2}
- lenke: {java: [1, 1]} WRONG (each traverser contributes count()==1; no reduce)
  groupCount() and group().by(k).by(k2) (list collect) are correct; only the
  reduced value-traversal form is broken. GAPS.md line 78 asserts the TS engine is
  "gap-free ... aggregation" — inaccurate (also reported by Omar). Re-confirmed.

---

## FINDING 5 — propertyMap() list-wraps values; GAPS.md says it returns "flat values" [LOW · DOCS]

V(marko).propertyMap() -> {name: ["marko"], age: [29]} // list-wrapped
V(marko).valueMap() -> {name: "marko", age: 29} // flat
GAPS.md (line 26-27): "propertyMap() returns flat values instead of property
objects." Actual output is list-wrapped, not flat. Behavior is defensible; the
doc description is wrong.

---

## FINDING 6 — ported_divergences.rs mislabels TinkerPop-divergent loops() results as "TinkerPop" [LOW · DOCS]

crates/lenke-core/src/gremlin/ported_divergences.rs:

- module doc: "loops() counts from 1 in the first body pass (TinkerPop)"
- repeat_until_loops_stops_after_first_pass: until(loops().is(eq(2))) -> 1-hop,
  commented "loops()==2 fires one body pass ... (TinkerPop)".
- repeat_emit_loops_predicate_offset: emit(loops().is(gt(1))) emits from the
  1-hop level.
  These pin the FINDING-1 behavior as intentional and label it TinkerPop-faithful.
  It is not TinkerPop. Tests are fine as change-detectors; the "(TinkerPop)"
  annotations are inaccurate and should read "lenke divergence".

---

## FINDING 7 — group/groupCount return a JS Map; naive JSON serialization silently loses data [LOW · DX/DOCS]

toArray(traversal(V(), groupCount().by(label())))[0] is a Map, so
JSON.stringify(result) yields {} rather than {"PERSON":4,...}. Correct in-memory,
but a serialization footgun for a library that leans on JSON/serialize.
valueMap/elementMap return plain objects, compounding the surprise. Worth a
README note.

---

## Everything that works correctly (verified byte-for-byte vs TinkerPop)

- Branching/logic: choose(pred,t,f), choose(traversal-test,t,f), coalesce,
  optional (present + fallback-to-self), union, local, where(traversal), not, and,
  or, is(gt(...)) on count(), branch().option().
- Path: path(), path().by(k), repeat().times(n) (do-while correct), repeat().emit()
  (post), emitBefore() (pre, incl level-0 start), repeat().until(value-cond) when
  the start does NOT satisfy the cond, simplePath, cyclicPath (empty on DAG; finds
  loop on real cycle), tree, shortestPath().with(target,...).
- Aggregation/barrier: fold/unfold, aggregate/store+cap, dedupe(), dedupe().by(k),
  dedupe().by(traversal), groupCount().by(...), group().by(k).by(k2) (list collect),
  global count/sum/min/max/mean, order().by(k, asc/desc), sample(n), barrier(),
  subgraph()+cap(), sideEffect(fn).
- Projection/select: values, valueMap/valueMap(k), elementMap ({id,label,...}),
  propertyMap (list-wrapped), project([...]).by(...), select(a,b).by(k), select(a),
  as\_, match() (correct bindings), constant.
- Mutation: addV+property, property() update, property(k,null) (null-first-class:
  stored, readable as null, has(k) true, in valueMap), .properties(k).drop()
  (removes -> has(k) false), vertex drop(), addE().from(subtraversal).to(subtraversal).
- Predicates/math: gt/gte/lt/lte/eq/neq, between (half-open), within/without,
  inside/outside, startsWith/containing/regex, not(pred), hasNot; math('_ \* 2') and
  math('a + b') with as_-bound operands; tail(n), range(a,b).

## Known-broken confirmed (already in charter's known list — not re-reported as new)

- order(Scope.local) — no-op (folded list stays unsorted).
- project('ab') (bare string) — char-splits into keys a,b.
- group().by(k).by(count()) — per-element list (also FINDING 4).
- sack / OLAP — absent (sack, withSack not exported). Confirmed.
- No fluent g.V() — source is traversal(V(), ...).

---

## Coverage map

| Category        | Works                                                                                                                                  | Broken / wrong                                                | Missing                         | Intentionally divergent (documented)                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------- |
| Branch/logic    | choose(ternary), coalesce, optional, union, local, where, not, and, or, branch.option                                                  | —                                                             | choose().option() map-form (F3) | —                                                    |
| Path/loop       | path, times, emit, emitBefore, simplePath, cyclicPath, tree, shortestPath                                                              | repeat().until() post-placement / loops() (F1)                | —                               | —                                                    |
| Aggregation     | fold/unfold, aggregate/store/cap, dedupe(+by), groupCount, group(list), count/sum/min/max/mean, order(by k), sample, barrier, subgraph | group().by().by(reduce) (F4), order(Scope.local) no-op        | sack/OLAP                       | min/max/sum/mean null-skip; NaN total-order          |
| Projection      | values, valueMap, elementMap, propertyMap, project([]), select+by, match, constant                                                     | project(bare-string) char-split; group/groupCount -> Map (F7) | —                               | valueMap flat / propertyMap list-wrap (F5 doc drift) |
| Mutation        | addV, property, property(null), properties(k).drop(), drop, addE(subtraversal from/to)                                                 | addE tag-form doc example (F2)                                | mid-traversal V() (F2)          | null-first-class                                     |
| Predicates/math | all predicates, math(+as\_), tail, range                                                                                               | —                                                             | —                               | regex native table subset                            |

Crown jewel: FINDING 1 — undocumented, silent wrong-result divergence from
TinkerPop in repeat().until(), byte-identical on TS AND native (not a cross-engine
drift), contradicted by lenke's own times(), contradicting GAPS.md's "gap-free"
claim, and mislabeled as "TinkerPop" in ported_divergences.rs.
