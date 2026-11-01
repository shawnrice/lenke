/**
 * Is GQL's two-hop count really 1.81x Gremlin's, or is that the DEGREE-1 corner?
 *
 * `surface-parity-probe.ts` flags `two-hop-count` at GQL 18.57 ms against Gremlin 10.26 (three
 * rounds, same answer 199,998) — the largest ABSOLUTE cross-surface gap in the field. But its
 * fixture is a CHAIN: `v0 -> v1 -> v2 -> …`, one edge per node, every in- and out-degree 1.
 *
 * That matters because GQL answers this with a DEGREE PRODUCT — item 1276: "it iterates the MIDDLE
 * once and multiplies two degrees" — which has NOTHING to multiply when every degree is 1. So the
 * chain is the one shape where the product cannot win, and the repo's own rule applies: "one edge
 * per node is sparse — per-edge costs scale with the edge:node ratio, per-node costs do not. A
 * change measured flat at 1:1 and -5% at 5:1."
 *
 * So: the same question at several edge:node ratios, one arm per process. If GQL overtakes Gremlin
 * as degree rises, the flagged 1.81x is a corner rather than a gap, and that is worth knowing
 * BEFORE optimizing it.
 *
 *     SURFACE=gql|grm  DEG=1|2|3|5  N=200000
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { count, hasLabel, out, toArray, traversal, V } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200_000);
const DEG = Number(process.env.DEG ?? 1);
const REPS = Number(process.env.REPS ?? 14);
const SURFACE = process.env.SURFACE ?? 'gql';

const graph = new Graph();
const vs = Array.from({ length: N }, (_, i) =>
  graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { age: i % 90 } }),
);

/**
 * DEG edges out of every vertex, scattered by distinct multipliers so neither endpoint key is
 * correlated with the other — the generator trap item 702 records, where 93% of the edges landed
 * on 7% of the vertices and a 3-hop count was INVARIANT to the distribution, so the answer could
 * not validate the fixture.
 */
const MULT = [7919, 104729, 1299709, 15485863, 32452843];
let e = 0;

for (let d = 0; d < DEG; d++) {
  const m = MULT[d % MULT.length];

  for (let i = 0; i < N; i++) {
    graph.addEdge({
      id: `e${e++}`,
      from: vs[i],
      to: vs[(i * m + d + 1) % N],
      labels: ['E'],
      properties: {},
    });
  }
}

// THE FIXTURE'S OWN STATISTICS, printed because an answer invariant to the distribution cannot
// validate it (item 702). Distinct edge targets is the number that catches a collapsed generator.
const targets = new Set<string>();

for (const edge of graph.edgesById.values()) {
  targets.add(edge.to.id);
}

// SHAPE=plain is the unfiltered product (item 1334's target). SHAPE=filtered carries a MIDDLE
// predicate, which routes to the FILTERED two-hop builder — a different loop that pays the same
// per-vertex `side(graph, b.id, …)` string lookup (item 1335's question).
const SHAPE = process.env.SHAPE ?? 'plain';

const GQL =
  SHAPE === 'filtered'
    ? 'MATCH (a:P)-[:E]->(b)-[:E]->(c) WHERE b.age > 45 RETURN count(*) AS c'
    : 'MATCH (a:P)-[:E]->()-[:E]->(c) RETURN count(*) AS c';
const GRM = traversal(V(), hasLabel('P'), out('E'), out('E'), count());

const series: number[] = [];
let answer = 0;

for (let r = 0; r < REPS; r++) {
  const t0 = performance.now();

  if (SURFACE === 'gql') {
    answer = Number(query(graph, GQL, {})[0]?.c);
  } else {
    answer = Number(toArray(GRM, graph)[0]);
  }

  series.push(performance.now() - t0);
}

// COLD=1 prints the FIRST rep alone as well as the warm median. Item 1334's lever is
// `Vertex.adjFrom`, a lazy memo, so a warm-only reading would credit the memo rather than the
// change — item 1323 is exactly that mistake, a probe warming the field it was measuring.
const [first] = series;
const kept = series.slice(3).sort((a, b) => a - b);

console.log(
  `${SURFACE}\t${SHAPE}\tDEG=${DEG}\tE=${e}\tdistinct-targets=${targets.size}\t` +
    `answer=${answer}\tFIRST ${first.toFixed(4)}\tMEDIAN ${kept[Math.floor(kept.length / 2)].toFixed(4)} ms`,
);
