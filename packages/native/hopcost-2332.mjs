/**
 * **GREMLIN's HOP COST AGAINST GQL's, PER EDGE TRAVERSED (item 2332).**
 *
 * The gremlin spelling probe covers `out(T)` vs `outE(T).inV()` as SPELLINGS — whether they agree — but
 * nothing has compared a Gremlin hop's per-row cost to the GQL twin's. Items 2317-2323 took the Gremlin
 * read surface from 6.6x its GQL twin to parity on a POINT LOOKUP; a hop is the other half of the read
 * surface and is untouched.
 *
 * **THE WORK IS MATCHED, which item 2328's three failures made the standing rule**: both arms traverse
 * the same edges from the same start set and project the same property, so the only difference is the
 * language. The row count is printed so an arm that answers something different is visible immediately
 * (item 2317's `rows=0` trap).
 *
 * `count(*)` arms are deliberately EXCLUDED — items 2286/2303/2309 priced an unfiltered hop count as a
 * CLOSED FORM at ~24 ns, which visits no edge and so cannot measure a hop at all.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { V, hasLabel, out, toArray, traversal, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 20_000);
const FAN = Number(process.env.FAN ?? 3);
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 60);
const ROUNDS = Number(process.env.ROUNDS ?? 7);
const ARM = process.env.ARM ?? 'grem1';

const graph = new Graph();

for (let i = 0; i < NODES; i += 1) {
  graph.addVertex({ id: `v${i}`, labels: ['N'], properties: { k: i % 97 } });
}

/* Item 1633's repeat-index split; the distinct-endpoint count below is the check that it worked. */
const seen = new Set();

for (let j = 0; j < NODES * FAN; j += 1) {
  const to = ((j % NODES) * 104_729 + Math.floor(j / NODES) * 977) % NODES;

  seen.add(to);
  graph.addEdge({
    id: `e${j}`,
    from: graph.getVertexById(`v${j % NODES}`),
    to: graph.getVertexById(`v${to}`),
    labels: ['E'],
    properties: {},
  });
}

if (seen.size < NODES * 0.5) {
  throw new Error(`degenerate fixture: ${seen.size} distinct endpoints of ${NODES}`);
}

/* Hoisted, per the guide and item 2325's 3.96x. */
const p1 = traversal(V(), hasLabel('N'), out('E'), values('k'));
const p2 = traversal(V(), hasLabel('N'), out('E'), out('E'), values('k'));

const ARMS = {
  grem1: () => toArray(p1, graph).length,
  grem2: () => toArray(p2, graph).length,
  gql1: () => query(graph, 'MATCH (a:N)-[:E]->(b) RETURN b.k AS k').length,
  gql2: () => query(graph, 'MATCH (a:N)-[:E]->()-[:E]->(c) RETURN c.k AS k').length,
  /*
   * **DOES THE RETURN's WIDTH CHANGE ANYTHING? (item 2332)** `gql2` names `a` and an anonymous middle
   * node but reads NEITHER — only `c`. If binding is narrowed to what the projection reads, these three
   * arms differ; if GQL binds every named variable regardless, they cost the same and the unread bindings
   * are dead work. Gremlin has `drop-unread-as.test.ts` for exactly this question on its side.
   */
  gql2Start: () => query(graph, 'MATCH (a:N)-[:E]->()-[:E]->(c) RETURN a.k AS k').length,
  gql2Both: () => query(graph, 'MATCH (a:N)-[:E]->()-[:E]->(c) RETURN a.k AS x, c.k AS y').length,
  /* The same traversal with NO named start — if naming `a` is what costs, this is cheaper. */
  gql2Anon: () => query(graph, 'MATCH (:N)-[:E]->()-[:E]->(c) RETURN c.k AS k').length,
};

const arm = ARMS[ARM];

for (let w = 0; w < 10; w += 1) {
  arm();
}

let inner = 1;

for (;;) {
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    arm();
  }

  if (performance.now() - t0 >= SAMPLE_MS || inner >= 20_000) {
    break;
  }

  inner *= 2;
}

const ts = [];

for (let r = 0; r < ROUNDS; r += 1) {
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    arm();
  }

  ts.push((performance.now() - t0) / inner);
}

const sorted = [...ts].sort((a, b) => a - b);
const med = sorted[Math.floor(sorted.length / 2)];
const rows = arm();

console.log(
  `  ARM=${ARM.padEnd(6)} ${(med * 1000).toFixed(0).padStart(7)} us  ${((med * 1_000_000) / rows).toFixed(2).padStart(7)} ns/row  rows=${rows}`,
);
