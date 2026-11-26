/*
 * Item 2092 — DOES ANY QUERY PATH DO A PER-ROW BY-ID LOOKUP? Counted, not asserted.
 *
 * Item 2091 measured a by-id lookup at **142 ns a call at a million elements** — the Map's cost,
 * not the engine's, but real. A rung doing one PER ROW would pay that on every row, and a static read
 * of the 59 call sites says none does: they are the fixture build, undo/rollback, `Edge`'s cached
 * `??=` (once per edge lifetime), and `hasId`/`V(id)` seeds BOUNDED BY THE QUERY's own id list.
 *
 * A STATIC READ IS NOT A GUARD. This counts the calls a query actually makes, per row it returns,
 * so a future rung that starts resolving ids per row shows up as a ratio near 1 instead of near 0.
 *
 * THE BUILD IS EXCLUDED BY COUNTING ONLY WHILE A QUERY RUNS — the fixture build is by far the
 * heaviest by-id caller (it resolves both endpoints of every edge), and including it would drown the
 * signal. Every profile in items 2083-2090 shows `getVertexById` at 5-16% for exactly that reason.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import {
  both,
  count,
  dedupe,
  hasLabel,
  id as gid,
  out,
  toArray,
  traversal,
  V,
  values,
} from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 20000);
const FANOUT = Number(process.env.FANOUT ?? 3);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i % 97, k: i % 50 } });
}

// One off-label vertex: the realistic (non-vacuous) label mode, so surviving label steps are counted.
g.addVertex({ id: 'vOFF', labels: ['Q'], properties: { n: -1, k: -1 } });

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(`v${i}`),
    to: g.getVertexById(`v${(i * 7 + 3 + hop * 13) % NODES}`),
    labels: ['E'],
    properties: { w: i % 7 },
  });
}

/*
 * The counters. BOTH THE METHOD AND THE RAW MAP are patched: `seedFromIndex` deliberately uses
 * `graph.verticesById.get` rather than `getVertexById` ("the RAW map, not `getVertexById`"), so
 * counting only the method would miss the index-seed path entirely — the one place a per-row
 * resolution could plausibly live.
 */
let counting = false;
const tally = { vertexById: 0, edgeById: 0, rawVertex: 0, rawEdge: 0 };

const wrap = (owner, name, bucket) => {
  const original = owner[name].bind(owner);

  owner[name] = (...args) => {
    if (counting) {
      tally[bucket] += 1;
    }

    return original(...args);
  };
};

wrap(g, 'getVertexById', 'vertexById');
wrap(g, 'getEdgeById', 'edgeById');
wrap(g.verticesById, 'get', 'rawVertex');
wrap(g.edgesById, 'get', 'rawEdge');

const shapes = {
  'gremlin V().values(n)': () => toArray(traversal(V(), values('n')), g).length,
  'gremlin V().hasLabel(P).id()': () => toArray(traversal(V(), hasLabel('P'), gid()), g).length,
  'gremlin V().out(E).values(n)': () => toArray(traversal(V(), out('E'), values('n')), g).length,
  'gremlin V().both(E).dedupe().count()': () =>
    toArray(traversal(V(), both('E'), dedupe(), count()), g).length,
  'gql MATCH (n:P) RETURN n.n': () => query(g, 'MATCH (n:P) RETURN n.n AS x').length,
  'gql one hop rows': () => query(g, 'MATCH (a:P)-[:E]->(b:P) RETURN b.k AS k').length,
  'gql one hop count': () => query(g, 'MATCH (a:P)-[:E]->(b:P) RETURN count(*) AS c').length,
  'gql two hop count': () =>
    query(g, 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN count(*) AS c').length,
  'gql seeded point': () => query(g, 'MATCH (n:P) WHERE n.n = 12 RETURN n.k AS k').length,
};

/*
 * **THE POSITIVE CONTROL, AND WITHOUT IT A ZERO PROVES NOTHING.** Every shape below reads 0, which
 * is indistinguishable from a BROKEN COUNTER. `V(id)` must resolve its id through the graph, so this
 * arm has to count ABOVE zero or the instrument is not watching anything.
 */
counting = true;

const controlRows = toArray(traversal(V('v5'), values('n')), g).length;

counting = false;

const controlCalls = tally.vertexById + tally.edgeById + tally.rawVertex + tally.rawEdge;

if (controlCalls === 0) {
  throw new Error(
    `the POSITIVE CONTROL counted 0 by-id calls for V('v5') — the counter is not wired, so every zero below is meaningless`,
  );
}

console.log(
  `  positive control: V('v5').values(n) -> ${controlRows} row(s), ${controlCalls} by-id call(s) — the counter works\n`,
);

console.log(`  NODES=${NODES} FANOUT=${FANOUT}, counting only while a query runs\n`);
console.log(
  `  ${'shape'.padEnd(38)} ${'rows'.padStart(8)} ${'by-id calls'.padStart(12)} ${'per row'.padStart(9)}`,
);

let worst = 0;

for (const [name, run] of Object.entries(shapes)) {
  for (const k of Object.keys(tally)) {
    tally[k] = 0;
  }

  counting = true;

  const rows = run();

  counting = false;

  const calls = tally.vertexById + tally.edgeById + tally.rawVertex + tally.rawEdge;
  const perRow = rows > 0 ? calls / rows : calls;

  worst = Math.max(worst, perRow);
  console.log(
    `  ${name.padEnd(38)} ${String(rows).padStart(8)} ${String(calls).padStart(12)} ${perRow.toFixed(4).padStart(9)}`,
  );
}

/*
 * THE THRESHOLD IS THE POINT OF THE PROBE. A bounded seed (`hasId`, `V(id)`) is fine — its count
 * comes from the QUERY, not the data — so the guard is per ROW, and 0.01 leaves room for a handful of
 * fixed lookups on a many-row query while catching anything proportional.
 */
const LIMIT = Number(process.env.LIMIT ?? 0.01);

console.log(`\n  worst per-row by-id rate: ${worst.toFixed(4)} (limit ${LIMIT})`);

if (worst > LIMIT) {
  throw new Error(
    `a query path makes ${worst.toFixed(4)} by-id lookups PER ROW — at 142 ns a call (item 2091) that is a per-row cost`,
  );
}

console.log('  OK — no query path resolves ids per row');
