// Item 1964 — the HOP spelling of item 1962's question, which item 1962 left behind.
//
// `node-scan.ts` keeps the node and hop deferred-sort policies in step deliberately, "because a
// route policy differing between the node and hop spellings of one question is this repo's named
// defect class". Item 1962 moved the node side only, so the GQL screen reads:
//
//     HOP order by EXPRESSION   580.60 ms   800,000 rows
//     HOP order by alias        357.66      800,000        1.62x, unchanged by item 1962
//
// 🔑 THE ARMS, one shape per process, and the third is the one item 1961 had to invent twice:
//
//     alias    ORDER BY x        the column arm — projects once, sorts the projected rows
//     expr     ORDER BY b.n + 1  `deferredHopOrder` — walk emits KEY + CARRIER columns, sorts
//                                those, then RE-PROJECTS every row from a rebuilt binding
//     exprId   ORDER BY b.n      the same property, PROJECTED, so `aliasOf` rewrites it to the
//                                column: isolates the ROUTE from the arithmetic
//     none     no ORDER BY       the floor, so the sort's share is readable rather than assumed
//
//     SHAPE=alias|expr|exprId|none bun hopsort-1964.mjs
//     SHAPE=expr bun --cpu-prof hopsort-1964.mjs
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 9);
const SHAPE = process.env.SHAPE ?? 'expr';

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 12, m: (i * 7) % 97 } });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  // Split on the REPEAT INDEX — the generator trap CLAUDE.md records.
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${String(e)}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
    labels: ['E'],
    properties: {},
  });
}

const SHAPES = {
  alias: 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x ORDER BY x',
  expr: 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x ORDER BY b.n + 1',
  exprId: 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x ORDER BY b.n',
  // A key the projection does NOT read, so no rewrite can reach a column — the hop twin of item
  // 1961's `numOther`.
  other: 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x ORDER BY b.m',
  none: 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x',
};
const text = SHAPES[SHAPE] ?? SHAPES.expr;
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const ts = [];
let rows = 0;
let sum = 0;

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();
  const got = query(g, text, { p0: 5 });

  ts.push(performance.now() - t0);

  if (r === 0) {
    rows = got.length;

    // An answer guard, so an arm that visits the right rows in the wrong order still compares and
    // a WRONG answer does not.
    for (const row of got) {
      sum += Number(row.x);
    }
  }
}

console.log(
  `RESULT\t${SHAPE}\t${med(ts).toFixed(1)}\t${((med(ts) * 1e6) / rows).toFixed(0)} ns/row\t${String(rows)}\t${String(sum)}`,
);
