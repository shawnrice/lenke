// Item 1942 — WHAT IS LEFT ON `MATCH (a:T)-[:E]->(b:T)` WITH BOTH LABELS NON-VACUOUS?
//
// FIRST, A CORRECTION TO MY OWN FOLLOW-UP NOTE AT ITEM 1941. It proposed "a single CSR arm
// testing whichever labels are broad — both ends, not one". That is NOT POSSIBLE, and item 1937
// already established why: the CSR arm COUNTS adjacency (`off[slot + 1] - off[slot]`) and never
// visits an edge, so it cannot test a START label at all. I conflated the counting arm with an
// edge-iterating one for the second time.
//
// SO THE ROUTE MAP IS ALREADY COMPLETE, and that is worth stating plainly:
//
//     start label        far label         arm
//     vacuous/absent     vacuous/absent    CSR, counting                (fastest)
//     vacuous/absent     broad non-vac     CSR + per-slot far test      (item 1941)
//     broad non-vac      anything          EDGE-driven, both tested     (item 1940)
//     selective          anything          start-driven (bucket)        (correctly declined)
//
// A start label that excludes anybody forces edge iteration. There is no fifth arm to add.
//
// So the only question left is whether the EDGE-DRIVEN arm is at its own hand ceiling. Item 1936
// measured that hand shape at 34 ns a row; this asks what the arm now costs against it, on one
// fixture, with the `a` spelling as a control the change cannot reach.
//
//     bun edgearm-residual-1942.mjs
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 50000);
const FANOUT = Number(process.env.FANOUT ?? 2);
const REPS = Number(process.env.REPS ?? 15);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 97 } });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${String(e)}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
    labels: ['E'],
    properties: {},
  });
}

// ONE off-label vertex, with no edges, so every spelling answers the same rows. Coverage 0.99998 —
// above the gate, so `a:T` takes the edge-driven arm and `a` takes the CSR arm.
g.addVertex({ id: 'off', labels: ['U'], properties: { n: 0 } });

const handEdgeDriven = () => {
  const bucket = g.edgesByLabel.get('E');
  const rows = [];

  if (bucket !== undefined) {
    for (const edge of bucket) {
      if (edge.from.labels.has('T') && edge.to.labels.has('T')) {
        rows.push({ x: edge.to.properties.n });
      }
    }
  }

  return rows.length;
};

/*
 * THE SPLIT. The arm calls `matchesLabel(v, labelExpr)` TWICE PER EDGE — a function call that
 * switches on a `LabelExpr`'s `kind` — where the hand loop does `labels.has('T')` directly. These
 * two arms differ in ONLY that, so the gap between them is the dispatch and the rest of the
 * residual is `binding.set` + `projectRow`.
 */
const asExpr = { kind: 'label', name: 'T' };
/*
 * ONE CASE ONLY. A second (`or`) arm would make the switch more realistic, but every spelling of
 * it trips `prefer-nullish-coalescing` on a BOOLEAN disjunction, where `??` is semantically wrong.
 * What is being isolated is the CALL plus the switch on `kind` — the per-edge indirection the
 * engine pays and the direct `labels.has` arm does not — and one case measures that.
 */
const matchesLabelLike = (v, expr) => {
  switch (expr.kind) {
    case 'label':
      return v.labels.has(expr.name);
    default:
      return false;
  }
};

const handWithDispatch = () => {
  const bucket = g.edgesByLabel.get('E');
  const rows = [];

  if (bucket !== undefined) {
    for (const edge of bucket) {
      if (matchesLabelLike(edge.from, asExpr) && matchesLabelLike(edge.to, asExpr)) {
        rows.push({ x: edge.to.properties.n });
      }
    }
  }

  return rows.length;
};

const ARMS = {
  'engine a:T (edge-driven)': () => query(g, 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x', {}).length,
  'engine a (CSR + far test)': () => query(g, 'MATCH (a)-[:E]->(b:T) RETURN b.n AS x', {}).length,
  'HAND edge-driven': handEdgeDriven,
  'HAND + LabelExpr dispatch': handWithDispatch,
};

const results = {};

for (const [name, fn] of Object.entries(ARMS)) {
  const ser = [];
  let got = 0;

  for (let r = 0; r < REPS + 2; r += 1) {
    const t0 = performance.now();

    got = fn();

    const ms = performance.now() - t0;

    if (r >= 2) {
      ser.push(ms);
    }
  }

  ser.sort((a, b) => a - b);
  results[name] = ser[ser.length >> 1];
  console.log(
    `${name.padEnd(26)} median ${results[name].toFixed(2).padStart(7)} ms   ` +
      `${((results[name] * 1e6) / got).toFixed(0).padStart(4)} ns a row   rows ${String(got)}`,
  );
}

console.log(
  `\nthe edge-driven arm is ${(results['engine a:T (edge-driven)'] / results['HAND edge-driven']).toFixed(2)}x its hand shape.\n` +
    `the CSR arm does the SAME ROWS in ${results['engine a (CSR + far test)'].toFixed(2)} ms, because counting\n` +
    'adjacency beats visiting every edge — but it cannot test a START label, so that is a floor the\n' +
    'labelled spelling cannot reach, not a gap to close.',
);
