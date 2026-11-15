import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

// Item 1945 — WHY DOES A DEDUPED HOP COST 7.52x ON A REALISTIC GRAPH?
//
// Item 1943's `MIXED=1` diff: `MATCH (a:T)-[:E]->(b:T) RETURN DISTINCT b.n AS x` goes
// **24.89 ms to 187.15** when one isolated off-label vertex makes `T` non-vacuous — the largest
// ratio on the screen, and a gate items 1940/1941 never touched (they fixed the plain hop
// projection and the CSR's far label; a DISTINCT takes its own rung).
//
// 187.15 ms for EIGHT ROWS over 800,000 edge visits.
//
// 🔑 THE CEILING IS A SET INSERT PER ROW, nothing more: walk the edges, test both labels, add the
// property to a `Set`. There is no ordering, no projection to build for rows that collapse, and the
// answer is 8 values. So this prices the engine against that, at both coverages, with the ROUTE
// read off `compileLinear` rather than inferred — because timing cannot tell "declined" from "more
// work".
//
//     bun dedupehop-probe-1945.mjs
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal planner entry point; same exemption `rung-precedence-census.mjs` carries
import { compileLinear } from '../gql/src/executor/rewrites.ts';
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- see above
import { parse } from '../gql/src/parser.ts';

const NODES = Number(process.env.NODES ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 7);

const Q = 'MATCH (a:T)-[:E]->(b:T) RETURN DISTINCT b.n AS x';

const build = (mixed) => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 8 } });
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

  if (mixed) {
    g.addVertex({ id: 'off', labels: ['Z'], properties: { n: 0 } });
  }

  return g;
};

/** The ceiling: one edge pass, both labels tested, a Set of the projected value. */
const handDedupe = (g) => () => {
  const bucket = g.edgesByLabel.get('E');
  const seen = new Set();

  if (bucket !== undefined) {
    for (const edge of bucket) {
      if (edge.from.labels.has('T') && edge.to.labels.has('T')) {
        seen.add(edge.to.properties.n);
      }
    }
  }

  return seen.size;
};

/*
 * ⚠️ EVERY FUNCTION-VALUED FIELD, not a hand-kept name list. My first version listed nine rung names
 * and reported `NONE`, which is indistinguishable from "took the general path" — the list was simply
 * missing this shape's rung. `routes-fired.test.ts`'s helper filters on `typeof === 'function'`
 * precisely so it cannot go stale as `CLinear` grows.
 */
/*
 * 🔑 THE RIGHT CEILING FOR A *DISTINCT*, and my first one was the wrong algorithm. `handDedupe`
 * walks all 1,000,000 edges; the engine's vacuous arm does it in 31.7 ms where that hand loop needs
 * 59.3 — because for `DISTINCT b.n` you only need the distinct FAR VERTICES, and there are 200,000
 * of them, not a million edges.
 *
 * So the reachable shape off the vacuous arm is: iterate far vertices, and for each scan its
 * in-edges only until ONE has a qualifying start label — a DISTINCT needs existence, not a count, so
 * it can SHORT-CIRCUIT. With a broad start label the first in-edge almost always qualifies, making
 * it ~200,000 checks instead of a million.
 */
const handDedupeFarFirst = (g) => () => {
  const seen = new Set();

  for (const far of g.vertices) {
    if (!far.labels.has('T')) {
      continue;
    }

    const byType = far.adjTo;
    const bucket = byType?.get('E');

    if (bucket === undefined) {
      continue;
    }

    for (const edge of bucket) {
      if (edge.from.labels.has('T')) {
        seen.add(far.properties.n);
        break; // ⬅ EXISTENCE, not a count
      }
    }
  }

  return seen.size;
};

const routeOf = (src) => {
  const q = parse(src);
  const linear = q.parts === undefined ? q : q.parts[0];
  const cl = compileLinear(linear);
  const fired = Object.entries(cl)
    .filter(([, v]) => typeof v === 'function')
    .map(([k]) => k)
    .sort();

  return fired.length > 0 ? fired.join(',') : 'NONE (general path)';
};

const time = (fn) => {
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

  return [ser[ser.length >> 1], got];
};

console.log(
  `${NODES} vertices / ${NODES * FANOUT} edges, median of ${REPS}. route is per-COMPILE and\n` +
    'identical in both modes (vacuity is read per EXECUTION), so it is printed once.\n',
);
console.log(`route: ${routeOf(Q)}\n`);
console.log('mode          engine   ns/vis     HAND-edge   HAND-far-first   distinct   agree');
console.log('-'.repeat(80));

for (const mixed of [false, true]) {
  const g = build(mixed);
  const [eng, engRows] = time(() => query(g, Q, {}).length);
  const [hnd, hndRows] = time(handDedupe(g));
  const [far, farRows] = time(handDedupeFarFirst(g));
  const visits = NODES * FANOUT;

  console.log(
    [
      (mixed ? 'MIXED' : 'homogeneous').padEnd(12),
      eng.toFixed(1).padStart(8),
      ((eng * 1e6) / visits).toFixed(0).padStart(8),
      hnd.toFixed(1).padStart(13),
      far.toFixed(1).padStart(16),
      String(engRows).padStart(10),
      String(engRows === hndRows && engRows === farRows).padStart(7),
    ].join(' '),
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
}

console.log(
  '\n⚠️ ns/row is per EDGE VISIT, not per output row — the answer is 8 values either way.',
);
