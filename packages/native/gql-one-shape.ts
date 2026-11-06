/**
 * ONE GQL SHAPE PER PROCESS, for an isolated A/B (item 1618).
 *
 * ⚠️ THE SWEEP IS THE WRONG INSTRUMENT FOR A PER-ROW CHANGE, and CLAUDE.md says why: rows interfere,
 * and item 737 recorded a 1.66x "regression" that an isolated A/B refuted at 25.2 against 24.7. The
 * first reading of item 1618's change in `gql-cliff-finder.ts` showed `hop2/rows` 1.29x BETTER and
 * `page/ordered rows` 2.76x WORSE in the same run — which is exactly the pattern that needs one
 * shape per process before anything is believed.
 *
 *     SHAPE=hop2rows bun gql-one-shape.ts
 *     SHAPE=noderows REPS=25 bun gql-one-shape.ts
 *
 * Prints the per-rep series as well as the summary, because `ts-spelling-probe`'s lesson is that
 * `min`-of-N is the wrong estimator on this path: the general scalar path plateaus high and emits a
 * rare fast rep, so the median of the post-warmup reps is what to compare.
 */
import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 20_000);
const FANOUT = Number(process.env.FANOUT ?? 4);
const REPS = Number(process.env.REPS ?? 14);
const SHAPE = process.env.SHAPE ?? 'hop2rows';

const QUERIES: Record<string, string> = {
  // The target: two hops returning rows, which no rung answers.
  hop2rows: 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN c.k AS k',
  hop2where: 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) WHERE c.k = 5 RETURN c.k AS k',
  // Item 1620: the two filtered twins and their invariant sibling.
  hop2midwhere: 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) WHERE b.k = 5 RETURN c.k AS k',
  hop2startwhere: 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) WHERE a.k = 5 RETURN c.k AS k',
  hop2truewhere: 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) WHERE true RETURN c.k AS k',
  // Item 1622: THREE segments returning rows, which no rung answers — the generic matcher.
  hop3rows: 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P) RETURN d.k AS k',
  hop3multi: 'MATCH (a:P)-[:E|F]->(b:P)-[:E|F]->(c:P)-[:E|F]->(d:P) RETURN d.k AS k',
  hop3both: 'MATCH (a:P)-[:E]-(b:P)-[:E]-(c:P) RETURN c.k AS k',
  // ⚠️ THE SELECTIVE-LABEL CONTROL: `Q` is on a third of the vertices, so the elision must DECLINE
  // and the test must still run. If this moves, the change costs something where it cannot help.
  hop3sel: 'MATCH (a:Q)-[:E]->(b:Q)-[:E]->(c:Q)-[:E]->(d:Q) RETURN d.k AS k',
  hop3mixed: 'MATCH (a:P)-[:E]->(b:Q)-[:E]->(c:P)-[:E]->(d:Q) RETURN d.k AS k',
  varlen: 'MATCH (a:P)-[:E]->{1,2}(b:P) RETURN count(*) AS c',
  // Item 1621: the grouped-hop count, whose rung calls `expand` per edge.
  groupedhop: 'MATCH (a:P)-[:E]->(b:P) RETURN b.k AS k, count(*) AS c',
  groupedhopstart: 'MATCH (a:P)-[:E]->(b:P) RETURN a.k AS k, count(*) AS c',
  groupedhopmulti: 'MATCH (a:P)-[:E|F]->(b:P) RETURN b.k AS k, count(*) AS c',
  groupednode: 'MATCH (n:P) RETURN n.k AS k, count(*) AS c',
  // CONTROLS the change can reach: one hop through the matcher, and a var-length walk.
  hoprows: 'MATCH (a:P)-[:E]->(b:P) RETURN b.k AS k',
  optional: 'MATCH (a:P) WHERE a.k = 5 OPTIONAL MATCH (a)-[:E]->(b:P) RETURN count(*) AS c',
  bothhop: 'MATCH (a:P)-[:E]-(b:P) RETURN count(*) AS c',
  // CONTROLS it cannot reach — no adjacency at all. If these move, the run is noise.
  noderows: 'MATCH (n:P) RETURN n.k AS k',
  orderedrows: 'MATCH (n:P) RETURN n.k AS k ORDER BY k',
  nodecount: 'MATCH (n:P) RETURN count(*) AS c',
};

const q = QUERIES[SHAPE];

if (q === undefined) {
  throw new Error(`unknown SHAPE ${SHAPE}; one of ${Object.keys(QUERIES).join(', ')}`);
}

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  /**
   * ⚠️ `P` ON EVERY VERTEX AND `Q` ON A THIRD — the second label is what makes a SELECTIVE control
   * possible (item 1623). A fixture whose only label is universal can measure a vacuous-label
   * elision's win and nothing about its cost, which is item 1608's confounded-control mistake.
   * `i % 3` against `k = i % 100` keeps the two decorrelated (gcd(3, 100) = 1).
   */
  g.addVertex({
    id: `u${i}`,
    labels: i % 3 === 0 ? ['P', 'Q'] : ['P'],
    properties: { team: `t${i % 50}`, k: i % 100, n: i, s: `s${i % 1000}` },
  });
}

/** ⚠️ Split on the REPEAT INDEX — items 1516/1518; a linear `(a*k+b)%N` makes the graph functional. */
let edges = 0;

for (let k = 0; k < NODES * FANOUT; k += 1) {
  const from = k % NODES;
  const to = (from * 7 + Math.floor(k / NODES) * 2657 + 1) % NODES;

  if (to === from) {
    continue;
  }

  g.addEdge({
    id: `e${k}`,
    from: g.getVertexById(`u${from}`) as Vertex,
    to: g.getVertexById(`u${to}`) as Vertex,
    labels: ['E'],
    properties: { w: k % 7 },
  });
  edges += 1;
}

const targets = new Set<string>();
const degree = new Map<string, number>();

for (const e of g.edges) {
  targets.add(e.to.id);
  degree.set(e.from.id, (degree.get(e.from.id) ?? 0) + 1);
}

if (targets.size < NODES * 0.5 || [...degree.values()].filter((d) => d > 1).length < NODES * 0.5) {
  throw new Error('DEGENERATE FIXTURE — the generator collapsed');
}

const rows = query(g, q).length;
const series: number[] = [];

for (let i = 0; i < REPS; i += 1) {
  const t0 = performance.now();

  query(g, q);
  series.push(performance.now() - t0);
}

// Drop the first three reps as warm-up — visibly the JIT tiering up — and take the MEDIAN of the
// rest (`ts-spelling-probe`'s estimator, after `min` reported a 51.9 against a plateau of ~85).
const tail = series.slice(3).sort((a, b) => a - b);
const median = tail[Math.floor(tail.length / 2)];

console.log(
  JSON.stringify({
    shape: SHAPE,
    nodes: NODES,
    edges,
    rows,
    median_ms: Number(median.toFixed(3)),
    min_ms: Number(Math.min(...series).toFixed(3)),
    ns_per_row: Number(((median * 1e6) / Math.max(rows, 1)).toFixed(1)),
    series: series.map((x) => Number(x.toFixed(2))),
  }),
);
