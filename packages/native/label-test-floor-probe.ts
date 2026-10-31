// WHAT DOES A LIFTED `IS LABELED` COST PER ELEMENT, AGAINST A HAND-WRITTEN FLOOR? (item 1303)
//
//   bun label-test-floor-probe.ts <arm>
//
// Item 1302's cross-surface check found GQL's far-end label 11.9x slower as a clause
// `WHERE b IS LABELED L` than as a pattern label `(b:L)`, and recorded the fixture dependence as
// undiagnosed. Two candidate causes, and they are NOT the same lever:
//
//   1. ROUTE. `bareDegreeSum` (shortcuts.ts) is a closed-form degree sum over a label BUCKET and
//      declines outright when `lifted !== undefined`. The pattern spelling has no clause `WHERE`,
//      so it takes that path; the clause spelling populates `farLifted` and falls to the full
//      `farOnlyHopCount` walk over every vertex. That is a ROUTING gap and worth ~2x on its own
//      (bucket vs full scan) plus whatever the walk's per-candidate overhead is.
//
//   2. PER-ELEMENT COST. On the 200k fixture the far-end clause LABEL measured 200.19 ns/v against
//      the far-end clause PROPERTY's 85.14 — 2.35x for what should be one `Set.has` against one
//      numeric compare. Item 1289 independently measured a SCAN `IS LABELED` at 2.61x a compare
//      and shipped that as a win over the unlifted route, leaving the ratio itself unexplained.
//
// Cause 2 is what this probe isolates, because it is the one a route change would NOT fix and
// because it reaches every shape — scans included, not just hops. The discriminator is a
// hand-written loop doing exactly the work the lifted predicate claims to do: if the engine is at
// the floor then the 2.35x is the cost of a label test and there is nothing here to take; if it is
// far off the floor, the gap is overhead and it is addressable.
//
// SELECTIVITY IS MATCHED BY CONSTRUCTION: `age = i % 90` so `age >= 45` keeps exactly half, and
// `Employee` sits on even `i`, which is also exactly half. Every arm below answers 100000 on a
// 200000-vertex graph, so a differing answer is a broken arm and not a different question.
//
// `Person` is on EVERY vertex deliberately: it is the VACUOUS label, and whether a start label is
// vacuous is the suspected fixture variable behind the 11.9x-vs-1.34x disagreement. `Mgr` is the
// non-vacuous twin (every third vertex), for the arms that need a start label the planner cannot
// drop — the same trap item 1302 hit when `dropVacuousLabels` silently invalidated a measurement.
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.PRED_N ?? 200_000);
const REPS = Number(process.env.PRED_REPS ?? 14);
const arm = process.argv[2] ?? '';
const graph = new Graph();
const ids: string[] = [];

const labelsFor = (i: number): string[] => {
  const out = ['Person'];

  if (i % 2 === 0) {
    out.push('Employee');
  }

  if (i % 3 === 0) {
    out.push('Mgr');
  }

  return out;
};

for (let i = 0; i < N; i++) {
  graph.addVertex({
    id: `v${i}`,
    labels: labelsFor(i),
    properties: { age: i % 90, name: `n${i}` },
  });
  ids.push(`v${i}`);
}

// MULTI-LABEL EDGES AS A FIXTURE KNOB, not as separate arms (item 1303).
//
// Item 1302 recorded two suspects for why the unfolded far-end-label gap reads 11.9x on one fixture
// and 1.34x on the spelling probe's. One is start-label vacuity, which the `vac-`/`nv-` arms vary.
// The other is MULTI-LABEL EDGES — `["E","F"]` on 1 in 11 in that fixture — which is what disables
// the analogous Gremlin fast path through `multiTypeEdgeCount`. The first cut of this probe used
// single-label edges throughout and so could not see that variable at all, which is how a partial
// diagnosis got announced as a whole one.
//
// `PRED_MLEDGE=n` puts a second label on every nth edge; 0 (the default) is the single-label
// fixture. The ARMS do not change, so a gap that moves when only this moves is this.
const ML = Number(process.env.PRED_MLEDGE ?? 0);

for (let i = 0; i < N; i++) {
  graph.addEdge({
    id: `e${i}`,
    from: graph.verticesById.get(ids[i])!,
    to: graph.verticesById.get(ids[(i * 7 + 3) % N])!,
    labels: ML > 0 && i % ML === 0 ? ['T', 'F'] : ['T'],
    properties: {},
  });
}

const q = (src: string) => () => Number(query(graph, src)[0].c);

const ARMS: Record<string, () => number> = {
  // ── SCANS. No hop at all, so the route question does not arise and only per-element cost is
  // left. This is the pair item 1289 measured at 2.61x; it is re-measured here against a floor.
  'scan-prop': q('MATCH (n) WHERE n.age >= 45 RETURN count(*) AS c'),
  'scan-label-clause': q('MATCH (n) WHERE n IS LABELED Employee RETURN count(*) AS c'),
  // The pattern spelling of the same count, answered from `verticesByLabel`. Not a floor for the
  // others — it never visits a vertex — but it is the number a route fix would be chasing.
  'scan-label-pattern': q('MATCH (n:Employee) RETURN count(*) AS c'),

  // ── THE FLOORS. The same traversal order (`graph.vertices` is insertion-ordered) and the same
  // per-element test, with no predicate dispatch, no binding, and no try/catch.
  'floor-prop': () => {
    let n = 0;

    for (const v of graph.vertices) {
      if ((v.properties.age as number) >= 45) {
        n += 1;
      }
    }

    return n;
  },
  'floor-label': () => {
    let n = 0;

    for (const v of graph.vertices) {
      if (v.labels.has('Employee')) {
        n += 1;
      }
    }

    return n;
  },
  // Hoists the `labels` GETTER out of the comparison: if this is much faster than `floor-label`,
  // the getter (and the label box behind it) is the cost rather than the `Set.has`.
  'floor-label-hoisted': () => {
    let n = 0;

    for (const v of graph.vertices) {
      const ls = v.labels;

      if (ls.has('Employee')) {
        n += 1;
      }
    }

    return n;
  },

  // ── THE HOP PAIR, carried over so this probe's fixture can be compared against item 1302's.
  'hop-label-pattern': q('MATCH (a)-[:T]->(b:Employee) RETURN count(*) AS c'),
  'hop-label-clause': q('MATCH (a)-[:T]->(b) WHERE b IS LABELED Employee RETURN count(*) AS c'),
  'hop-prop-clause': q('MATCH (a)-[:T]->(b) WHERE b.age >= 45 RETURN count(*) AS c'),

  // ── THE FIXTURE-DEPENDENCE 2x2 the earlier pass could not resolve, now with a start label the
  // planner CANNOT drop. If the gap closes here and not above, start-label vacuity is the variable.
  'nv-pattern': q('MATCH (a:Mgr)-[:T]->(b:Employee) RETURN count(*) AS c'),
  'nv-clause': q('MATCH (a:Mgr)-[:T]->(b) WHERE b IS LABELED Employee RETURN count(*) AS c'),
  // The vacuous twin of that same pair, as the control for it.
  'vac-pattern': q('MATCH (a:Person)-[:T]->(b:Employee) RETURN count(*) AS c'),
  'vac-clause': q('MATCH (a:Person)-[:T]->(b) WHERE b IS LABELED Employee RETURN count(*) AS c'),

  // ── ITEM 1304: A VACUOUS START LABEL, ALONE. `Person` is on every vertex here, so the label
  // constrains nothing and `vacuousLabel` exists to drop it — yet the spelling probe measures this
  // pair 1545x apart on its own fixture. These arms ask the question on a fixture whose edges are
  // single-label BY DEFAULT, so `PRED_MLEDGE` decides whether `multiTypeEdgeCount` — which gates
  // `bucketSumsAreSound`, the condition guarding the O(1) bucket-sum answer — is what separates
  // them. All three answer the FULL edge count, so a differing answer voids the comparison.
  'vstart-labelled': q('MATCH (a:Person)-[:T]->(b) RETURN count(*) AS c'),
  'vstart-absent': q('MATCH (a)-[:T]->(b) RETURN count(*) AS c'),
  // The NON-vacuous twin: shows whether the fast path is about VACUITY or about any label at all.
  'vstart-real': q('MATCH (a:Mgr)-[:T]->(b) RETURN count(*) AS c'),
};

const run = ARMS[arm];

if (run === undefined) {
  console.log(`arms: ${Object.keys(ARMS).join(' ')}`);
  process.exit(2);
}

const series: number[] = [];
let answer = 0;

for (let r = 0; r < REPS; r++) {
  const t = performance.now();

  answer = run();
  series.push(performance.now() - t);
}

// 14 reps, drop the first three as warm-up, MEDIAN of the rest — CLAUDE.md's estimator for the TS
// per-row path, where `min` reports a rare fast rep and estimates the two arms differently.
const warm = series.slice(3).sort((a, b) => a - b);
const med = warm[Math.floor(warm.length / 2)] ?? 0;

console.log(
  `${arm}\t${med.toFixed(4)}\t${((med * 1e6) / N).toFixed(2)}\t${answer}\t${series
    .map((s) => s.toFixed(2))
    .join(' ')}`,
);
