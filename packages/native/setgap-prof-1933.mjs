// Item 1933 — WHY IS GQL `SET` 3.42x GREMLIN `property` FOR THE SAME MUTATION?
//
// `write-workload-screen-1932.mjs` at 20,000 vertices, fresh graph per rep:
//
//     gql: set one prop, all rows    13.53 ms   MATCH (n:T) SET n.n = 1
//     gremlin: property all           3.96      V().property('n', 1)
//
// Both set one property on all 20,000 vertices and both were VERIFIED to have changed 20,000 of
// them. [[ts-set-is-o-width]] prices the mechanism — three O(K) passes a write against native's
// O(1) columnar — and this is the first cross-surface measurement of it.
//
// ⚠️ FIRST, ARE THE TWO SIDES DOING THE SAME WORK? `MATCH (n:T)` filters by label and `V()` does
// not, so the GQL side carries a label scan the Gremlin side skips — which if anything makes the
// GQL side's job SMALLER. The `readOnly` arms below price each side's scan WITHOUT the write, so
// the write cost is a difference rather than a whole-query ratio. A whole-query ratio would charge
// the write for whatever the scan costs.
//
// ⚠️ FRESH GRAPH PER REP, build excluded: a write is not idempotent, and `SET n.n = 1` run twice
// has nothing to change the second time (every row already holds 1), so min-of-N over one fixture
// would measure the no-op path.
//
//     SHAPE=gqlSet bun --cpu-prof setgap-prof-1933.mjs
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { property, toArray, traversal, V, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 20000);
const REPS = Number(process.env.REPS ?? 9);
const ONLY = process.env.SHAPE;

const build = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({
      id: String(i + 1),
      labels: ['T'],
      properties: { n: i % 97, k: `s${String(i)}`, w: i % 7 },
    });
  }

  return g;
};

const ARMS = {
  // ——— the pair the screen flagged ———
  gqlSet: (g) => query(g, 'MATCH (n:T) SET n.n = 1', {}),
  gremProperty: (g) => toArray(traversal(V(), property('n', 1)), g),

  // ——— each side's SCAN without the write, so the write is a DIFFERENCE not a ratio ———
  gqlScan: (g) => query(g, 'MATCH (n:T) RETURN n.n AS x', {}),
  gremScan: (g) => toArray(traversal(V(), values('n')), g),

  // ——— does the VALUE matter? setting what is already there vs a change ———
  // ⚠️ `SET n.n = n.n` changes nothing, so if the cost is in the WRITE this is cheap and if it is
  // in the per-row machinery it is not.
  gqlSetSame: (g) => query(g, 'MATCH (n:T) SET n.n = n.n', {}),
  // ——— a NEW key widens the row; an existing key replaces in place ———
  gqlSetNew: (g) => query(g, 'MATCH (n:T) SET n.fresh = 1', {}),
  gremPropertyNew: (g) => toArray(traversal(V(), property('fresh', 1)), g),

  // ——— two properties, to see whether cost is per-WRITE or per-ROW ———
  gqlSetTwo: (g) => query(g, 'MATCH (n:T) SET n.n = 1, n.w = 2', {}),

  /*
   * ⚠️ THE DELETION TEST FOR THE PROFILE'S TOP FRAMES ([[frame-attribution-trap]]). The clean
   * profile puts 22.6% in `deferConstraint` (12.90%) + `runDeferredChecks` (9.71%) on a fixture
   * with NO CONSTRAINTS. Those fire only when `txDepth > 0`, and every GQL write statement
   * auto-commits — i.e. runs in an implicit transaction. So the same host-side mutation INSIDE an
   * explicit transaction should pay that machinery and OUTSIDE one should not, with everything
   * else held identical. A frame is attribution until a control says otherwise.
   */
  hostSetInTx: (g) => {
    let i = 0;

    g.transaction(() => {
      for (const v of g.vertices) {
        v.properties = { ...v.properties, n: 1 };
        i += 1;
      }
    });

    return i;
  },

  // ——— the host-side floor: the same mutation through the core API, no query engine at all ———
  hostSet: (g) => {
    let i = 0;

    for (const v of g.vertices) {
      v.properties = { ...v.properties, n: 1 };
      i += 1;
    }

    return i;
  },
};

const names = Object.keys(ARMS).filter((n) => ONLY === undefined || n.includes(ONLY));
const results = {};

for (const name of names) {
  const fn = ARMS[name];
  const ser = [];
  let err = '';

  for (let r = 0; r < REPS + 2; r += 1) {
    const g = build();
    const t0 = performance.now();

    try {
      fn(g);
    } catch (e) {
      err = String(e).slice(0, 40);
    }

    const ms = performance.now() - t0;

    if (r >= 2) {
      ser.push(ms);
    }
  }

  ser.sort((a, b) => a - b);
  results[name] = ser[ser.length >> 1];
  console.log(
    `${name.padEnd(16)} median ${results[name].toFixed(2)} ms   ` +
      `${((results[name] * 1e6) / NODES).toFixed(0)} ns/row${err === '' ? '' : `  ⚠️ ${err}`}`,
  );
}

if (ONLY === undefined) {
  const gqlWrite = results.gqlSet - results.gqlScan;
  const gremWrite = results.gremProperty - results.gremScan;

  console.log(
    `\nTHE WRITE AS A DIFFERENCE, not a whole-query ratio:\n` +
      `  gql    set ${results.gqlSet.toFixed(2)} - scan ${results.gqlScan.toFixed(2)} = ` +
      `${gqlWrite.toFixed(2)} ms (${((gqlWrite * 1e6) / NODES).toFixed(0)} ns a row)\n` +
      `  gremlin set ${results.gremProperty.toFixed(2)} - scan ${results.gremScan.toFixed(2)} = ` +
      `${gremWrite.toFixed(2)} ms (${((gremWrite * 1e6) / NODES).toFixed(0)} ns a row)\n` +
      `  ratio on the WRITE ALONE: ${(gqlWrite / gremWrite).toFixed(2)}x ` +
      `(the whole-query ratio was ${(results.gqlSet / results.gremProperty).toFixed(2)}x)`,
  );
  console.log(
    `  the host-side floor is ${results.hostSet.toFixed(2)} ms ` +
      `(${((results.hostSet * 1e6) / NODES).toFixed(0)} ns a row) — no query engine at all`,
  );
}
