// Item 1964 — the HOP spelling of item 1962's question, which item 1962 left behind.
//
// `node-scan.ts` keeps the node and hop deferred-sort policies in step deliberately, "because a
// route policy differing between the node and hop spellings of one question is this repo's named
// defect class". Item 1962 moved the node side only, so the GQL screen reads:
//
//     HOP order by EXPRESSION   580.60 ms   800,000 rows
//     HOP order by alias        357.66      800,000        1.62x, unchanged by item 1962
//
// THE ARMS, one shape per process, and the third is the one item 1961 had to invent twice:
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
  /*
   * Item 1965: the WINDOWED pair. The GQL screen reads `CONTROL hop windowed alias key` at 411.72
   * ms for TEN rows — dearer than the unwindowed `HOP order by alias`'s 353.17 for 800,000. A
   * `LIMIT 10` cannot cost more than no limit unless it buys nothing, so these ask whether a
   * bounded heap fires on the hop at all. Item 701 took exactly this lever for the node arm
   * ("`sortRowsByColumns` full-sorted every row and sliced, so `ORDER BY a LIMIT 5` over 200,000
   * rows paid an O(n log n) sort to emit five").
   *
   * THE PAIR MUST SHARE ITS PROJECTION. The screen's windowed rows project `b.n + 1 AS c`
   * (computed) while its unwindowed rows project `b.n AS x` (bare), so the screen's own comparison
   * is confounded — it says so at `HOP start-only proj, far key`. These four hold the projection
   * fixed and vary ONLY the window.
   */
  winAlias: 'MATCH (a:T)-[:E]->(b:T) RETURN b.n + 1 AS c ORDER BY c LIMIT 10',
  openAlias: 'MATCH (a:T)-[:E]->(b:T) RETURN b.n + 1 AS c ORDER BY c',
  winExpr: 'MATCH (a:T)-[:E]->(b:T) RETURN b.n + 1 AS c ORDER BY b.n + 1 LIMIT 10',
  openExpr: 'MATCH (a:T)-[:E]->(b:T) RETURN b.n + 1 AS c ORDER BY b.n + 1',
  /*
   * THE CONTROL THE WINDOWED PAIR NEEDS, and without it the pair says nothing. `none` above
   * projects a BARE property; these shapes project a COMPUTED one, so the walk+projection cost is
   * not the same. `sortRowsByColumns`' heap IS wired for `LIMIT 10` over 1,000,000 rows
   * ((0 + 10) * 16 <= 1e6), so if the windowed arm still costs what the unwindowed one does, the
   * sort was never the mass — and this row is what says so.
   */
  noneExpr: 'MATCH (a:T)-[:E]->(b:T) RETURN b.n + 1 AS c',
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
    // THE FIRST COLUMN, not `row.x`: the windowed shapes name theirs `c`, and reading `x` made
    // the checksum `NaN` — a guard that silently stopped guarding. Item 1961's lesson about arms
    // one level down.
    for (const row of got) {
      sum += Number(Object.values(row)[0]);
    }
  }
}

console.log(
  `RESULT\t${SHAPE}\t${med(ts).toFixed(1)}\t${((med(ts) * 1e6) / rows).toFixed(0)} ns/row\t${String(rows)}\t${String(sum)}`,
);
