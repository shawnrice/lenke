// Item 1899 — the DISTINCT far values of a hop, asked three ways over one fixture.
//
// ⚠️ ONE SHAPE PER PROCESS (`SHAPE=gql|gremlin|gremvals`), because item 1871 retracted a flag that
// shared one. ⚠️ AND BOTH GREMLIN SPELLINGS MUST BE MEASURED: item 1899's `byKey` bug (a `By` is a
// tagged object, never the bare string the caller writes) left `dedupe().by(k)` on the generic
// pipeline at 257 ms while `values(k).dedupe()` dropped to 65 on the SAME build. Measuring one
// spelling would have called that a win.
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { V, dedupe, out, toArray, traversal, values } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200000);
const FANOUT = 5;
const REPS = Number(process.env.REPS ?? 7);
const SHAPE = process.env.SHAPE ?? 'gql';
// Eight distinct values over 200,000 vertices, so the answer is 8 rows and the cost is all walk.
const POOL = [3, 5, 7, 11, 13, 17, 1, 99];

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['P'], properties: { n: POOL[i % POOL.length] } });
}

// ⚠️ The repeat index `hop` is in the target, not just `e` — [[bench-methodology]]'s functional-graph
// trap: `(i * 7 + 3) % N` alone gives every one of a vertex's FANOUT edges the SAME target.
for (let e = 0; e < N * FANOUT; e += 1) {
  const i = e % N;
  const hop = Math.floor(e / N);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2654435761) % N) + 1)),
    labels: hop % 4 === 3 ? ['F'] : ['E'],
  });
}

const gqlText = 'MATCH (a:P)-[:E]->(b:P) RETURN DISTINCT b.n AS n';
const gremPlan = traversal(V(), out('E'), dedupe().by('n'), values('n'));
const gremBare = traversal(V(), out('E'), values('n'), dedupe());

const pick = () => {
  if (SHAPE === 'gql') {
    return () => query(g, gqlText).length;
  }

  if (SHAPE === 'gremlin') {
    return () => toArray(gremPlan, g).length;
  }

  return () => toArray(gremBare, g).length;
};

const run = pick();
const ser = [];
let rows = 0;

for (let r = 0; r < REPS + 2; r += 1) {
  const t0 = performance.now();

  rows = run();

  const ms = performance.now() - t0;

  if (r >= 2) {
    ser.push(ms);
  }
}

ser.sort((a, b) => a - b);
console.log(
  SHAPE.padEnd(10),
  ser[ser.length >> 1].toFixed(2).padStart(8),
  'ms',
  String(rows).padStart(6),
  'rows',
  '|',
  ser.map((x) => x.toFixed(1)).join(' '),
);
