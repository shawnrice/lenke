/**
 * ONE SHAPE PER PROCESS, with the per-rep series printed (item 1034).
 *
 * `edge-index-probe.ts` runs nine shapes in one process and reports a median of six warm reps.
 * That is the wrong instrument for a dispatch change: CLAUDE.md records both halves of why — a
 * two-dist in-process A/B flatters any change that REDISTRIBUTES call sites, and some TS shapes
 * are outright BIMODAL inside one process, so a median of six can land in either mode. Item 1034's
 * first reading had the same query 2.6x FASTER with named ends and 2x SLOWER with anonymous ones,
 * which is one question giving two answers — the instrument, not the engine.
 *
 * So: one shape, chosen by `SHAPE`, in its own process; fourteen reps; the whole series printed;
 * the median of reps 4+ as the summary. The arms that cannot execute a rel lift are controls and
 * are listed as such.
 *
 *   cd packages/native && SHAPE=named-clause bun rel-lift-probe.ts
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { E, count, has, toArray, traversal, values } from '@lenke/gremlin';

const N = Number(process.env.EDGE_N ?? 100_000);
const REPS = Number(process.env.EDGE_REPS ?? 14);

/** Every shape is the SAME count over the same fixture; only the spelling differs.
 *  `reached` says whether a rel lift can execute for it — the controls are the `false` rows. */
const SHAPES: Record<string, { q: string; reached: boolean }> = {
  // The SUBJECT, both spellings of one question. Anonymous ends and named ends must agree.
  'anon-clause': {
    q: 'MATCH ()-[e:PAID]->() WHERE e.amount = 500 RETURN count(*) AS c',
    reached: true,
  },
  'named-clause': {
    q: 'MATCH (a)-[e:PAID]->(b) WHERE e.amount = 500 RETURN count(*) AS c',
    reached: true,
  },
  // A CONTROL since item 1035: `other` is not an indexed key, so the edge seed declines and this
  // arm keeps the type-bucket scan. It is the arm that says the win is the INDEX rather than
  // "edge filters got faster".
  unindexed: {
    q: 'MATCH ()-[e:PAID]->() WHERE e.other = 500 RETURN count(*) AS c',
    reached: false,
  },
  // THE CEILING (item 1035). Gremlin has seeded `edgePropertyIndex` all along, so this arm says
  // what the declared index is worth and neither arm above can beat it.
  gremlin: { q: 'GREMLIN', reached: true },
  // The INLINE spelling. A control for item 1034 (it is an `InlinePred` on the tally, which that
  // item did not touch) and a SUBJECT for item 1035, which reads both spellings' keys — the two
  // are one question and this file's recurring defect is serving only one of them.
  'named-inline': {
    q: 'MATCH (a)-[e:PAID {amount: 500}]->(b) RETURN count(*) AS c',
    reached: true,
  },
  'node-key': { q: 'MATCH (a)-[e:PAID]->(b) WHERE a.n = 7 RETURN count(*) AS c', reached: false },
  // THE PROJECTION SHAPE (item 1037). Item 1035's seed lives in `tallyEdges`, which serves the
  // COUNT walks; `hop-projection.ts` drives per VERTEX (`v.adjFrom`) through `hopSeek` and
  // `edgesOfTypes` and references `edgeSeek` nowhere. Same question, different result shape — the
  // exact split item 1032 found between the count and projection forms of the rel predicate.
  'proj-clause': {
    q: 'MATCH ()-[e:PAID]->() WHERE e.amount = 500 RETURN e.amount AS a',
    reached: false,
  },
  'proj-inline': { q: 'MATCH ()-[e:PAID {amount: 500}]->() RETURN e.amount AS a', reached: false },
  // THE DIAGNOSTIC: the same projection on a value NO edge carries, so it returns ZERO rows. If
  // the cost is the SCAN it is invariant here; if it is row construction it collapses. An answer
  // that is invariant to the property varied cannot validate the fixture, so this arm is the one
  // that says which half of the 9.26 ms is which.
  'proj-zero': {
    q: 'MATCH ()-[e:PAID]->() WHERE e.amount = 99999 RETURN e.amount AS a',
    reached: false,
  },
  // THE CEILING for the projection shape: Gremlin seeds the edge index and then reads the value.
  'proj-gremlin': { q: 'GREMLIN-PROJ', reached: true },
  // THE PROJECTION CONTROL (item 1038): an UNINDEXED edge key, so `edgeSeek` declines and the
  // walk delegates to the scanning twin. The arm that says the win is the INDEX, and the one that
  // would catch a decline routed to the general row pipeline instead of to that twin.
  'proj-unindexed': {
    q: 'MATCH ()-[e:PAID]->() WHERE e.other = 500 RETURN e.other AS a',
    reached: false,
  },
  // THE AGGREGATE SHAPES (item 1047). Items 1035 and 1038 wired `edgeSeek` into `tallyEdges` (the
  // COUNT walks) and `relSeekedHopWalk` (the projection). Grepping the pattern one level on: does
  // an AGGREGATE over the same indexed edge key reach it, or is this the third result shape that
  // has to be served separately?
  'agg-sum': {
    q: 'MATCH ()-[e:PAID]->() WHERE e.amount = 500 RETURN sum(e.amount) AS a',
    reached: false,
  },
  'agg-distinct': {
    q: 'MATCH ()-[e:PAID]->() WHERE e.amount = 500 RETURN count(DISTINCT e.amount) AS a',
    reached: false,
  },
  'agg-group': {
    q: 'MATCH ()-[e:PAID]->() WHERE e.amount = 500 LET k = e.amount RETURN k, count(*) AS a GROUP BY k',
    reached: false,
  },
  // The CONTROL for all three: the same aggregate on an UNINDEXED edge key, so nothing can seed.
  'agg-unindexed': {
    q: 'MATCH ()-[e:PAID]->() WHERE e.other = 500 RETURN sum(e.other) AS a',
    reached: false,
  },
  // THE DECISIVE PAIR with the arm above: an INDEXED key matching ZERO edges. If the aggregate
  // seeded, this would walk an EMPTY set and cost ~nothing; if it scans, it costs what the
  // unindexed zero-match arm costs. Same row count, same work downstream — the only difference is
  // whether the index was reachable.
  'agg-zero': {
    q: 'MATCH ()-[e:PAID]->() WHERE e.amount = 99999 RETURN sum(e.amount) AS a',
    reached: false,
  },
  // THE ORDER-INDEPENDENT aggregates (item 1048). `detectHopAggregate` REFUSES `sum`/`avg`/the
  // stddevs on purpose: its walk may be FAR-DRIVEN, float addition is not associative, and item
  // 532 priced that rather than guessing it. So `sum` above is not a seeding gap at all — it is a
  // documented refusal, and an edge seed (which also reorders) must honour the same rule.
  // `min`/`max`/`count` do not care about arrival order, so they are the shapes a seed may serve.
  'agg-max': {
    q: 'MATCH ()-[e:PAID]->() WHERE e.amount = 500 RETURN max(e.amount) AS a',
    reached: false,
  },
  'agg-min': {
    q: 'MATCH ()-[e:PAID]->() WHERE e.amount = 500 RETURN min(e.amount) AS a',
    reached: false,
  },
  // The zero-match twin of `agg-max`, the same diagnostic item 1047 used: if the route seeded,
  // an empty bucket would cost ~nothing.
  'agg-max-zero': {
    q: 'MATCH ()-[e:PAID]->() WHERE e.amount = 99999 RETURN max(e.amount) AS a',
    reached: false,
  },
  // THE NODE CONTROLS for item 1049. Giving `foldFor` a DISTINCT arm opens `foldedAggs` for every
  // caller, not just the edge path — `routes-fired` caught `nodeAggregate` compiling for the node
  // distinct count where only `distinctCount` did before. `distinctCount` still PRECEDES it at
  // `clauses.ts:1458`, so the route is unchanged; these arms are what says the extra compile costs
  // nothing measurable, rather than my asserting it.
  'node-distinct': {
    q: 'MATCH (v:P) RETURN count(DISTINCT v.n) AS a',
    reached: false,
  },
  // ...and a node count(*) the change cannot reach at all, as the null control for this pair.
  'node-count': { q: 'MATCH (v:P) RETURN count(*) AS a', reached: false },
};

const name = process.env.SHAPE ?? 'named-clause';
const shape = SHAPES[name];

if (shape === undefined) {
  console.log(`unknown SHAPE=${name}; one of ${Object.keys(SHAPES).join(', ')}`);
  process.exit(1);
}

const g = new TsGraph();
const verts: ReturnType<TsGraph['addVertex']>[] = [];

for (let i = 0; i < 200; i++) {
  verts.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i } }));
}

for (let i = 0; i < N; i++) {
  g.addEdge({
    from: verts[i % 200],
    to: verts[(i * 7 + 3) % 200],
    labels: ['PAID'],
    properties: { amount: i % 1_000 },
  });
}

g.createIndex({ on: 'edge', kind: 'hash', keys: ['amount'] });

const series: number[] = [];
let answer: unknown;

for (let r = 0; r < REPS; r++) {
  const t = performance.now();

  if (shape.q === 'GREMLIN-PROJ') {
    answer = toArray(traversal(E(), has('amount', 500), values('amount')), g).length;
  } else if (shape.q === 'GREMLIN') {
    [answer] = toArray(traversal(E(), has('amount', 500), count()), g);
  } else if (name.startsWith('agg-') || name.startsWith('node-')) {
    // An aggregate returns one row (or one per group); take its first cell, whatever it is named.
    const rows = tsQuery(g, shape.q) as Record<string, unknown>[];

    answer = rows.length === 0 ? 'none' : Object.values(rows[0])[0];
  } else if (name.startsWith('proj-')) {
    // A PROJECTION returns rows, so the answer is their count — the same 100 either way, which is
    // what makes it comparable with the count arms above.
    answer = (tsQuery(g, shape.q) as unknown[]).length;
  } else {
    answer = tsQuery(g, shape.q)[0]?.c;
  }

  series.push(performance.now() - t);
}

// Reps 4+ only: the first three are visibly the JIT tiering up, and the MEDIAN rather than the
// min, because the general scalar path plateaus high and emits a rare fast rep that `min` would
// report as the whole story.
const warm = series.slice(3).sort((a, b) => a - b);
const median = warm[Math.floor(warm.length / 2)] ?? 0;

console.log(
  `SHAPE=${name} reached=${shape.reached} answer=${String(answer)} median=${median.toFixed(3)}`,
);
console.log(`  series ${series.map((x) => x.toFixed(1)).join(' ')}`);
