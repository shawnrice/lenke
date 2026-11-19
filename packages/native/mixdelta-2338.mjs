/**
 * ✅✅ **WHAT DOES A SHAPE COST WHEN IT SHARES A PROCESS? (item 2338)**
 *
 * Every measurement in items 2312-2337 was taken ONE SHAPE PER PROCESS, which is the right rule for an
 * A/B: item 762 showed a change that redistributes call sites flattering itself, and item 2285 showed the
 * mirror — **an honest 1.13-2.17x erased to 0.97x by two unrelated arms in the same process.**
 *
 * ⚠️ But a real application never runs one shape. It issues a MIX, so every number this stretch produced
 * describes a regime no caller is in. 🔑 **This instrument measures the gap itself**: each shape alone in
 * its own process, then the same shapes interleaved in one, with per-shape timing in both. The DELTA is
 * the finding — a shape that costs materially more in company is a serving problem that isolation cannot
 * see.
 *
 * ⚠️ **THIS IS NOT AN A/B INSTRUMENT AND MUST NOT BE USED AS ONE.** Its whole point is the polluted
 * regime; comparing two engine versions with it would reintroduce exactly the confound the one-shape rule
 * exists to prevent.
 *
 * ⚠️ Each shape does the SAME work in both modes — same fixture, same parameters, same row counts, which
 * are printed so a shape answering differently is visible (item 2317's `rows=0` trap).
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { V, hasLabel, out, toArray, traversal, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 20_000);
const FAN = Number(process.env.FAN ?? 3);
const REPS = Number(process.env.REPS ?? 9);
const MODE = process.env.MODE ?? 'mixed';
const ONLY = process.env.ONLY ?? '';

const graph = new Graph();

for (let i = 0; i < NODES; i += 1) {
  graph.addVertex({
    id: `v${i}`,
    labels: ['N'],
    properties: { k: i % 97, name: `n${i}`, w: i % 1000 },
  });
}

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

graph.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });

const pHop = traversal(V(), hasLabel('N'), out('E'), values('k'));

/*
 * ✅ FIVE SHAPES A SERVING APPLICATION ACTUALLY MIXES: a point lookup, a one-hop traversal in each
 * language, an aggregate and a filtered scan. Each is cheap enough that per-call dispatch matters, which
 * is the regime where sharing a process can hurt.
 */
const SHAPES = {
  lookup: () =>
    query(graph, 'MATCH (n:N) WHERE n.name = $n RETURN n.k AS k', { n: 'n12345' }).length,
  hopGql: () => query(graph, 'MATCH (a:N)-[:E]->(b) RETURN b.k AS k').length,
  hopGrem: () => toArray(pHop, graph).length,
  agg: () => query(graph, 'MATCH (n:N) RETURN max(n.w) AS m').length,
  scan: () => query(graph, 'MATCH (n:N) WHERE n.k = 5 RETURN n.name AS nm').length,
};

const names = ONLY === '' ? Object.keys(SHAPES) : [ONLY];

/* ✅ Warm EVERY shape in both modes, so neither mode measures a cold compile the other paid earlier. */
for (const n of Object.keys(SHAPES)) {
  for (let w = 0; w < 30; w += 1) {
    SHAPES[n]();
  }
}

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/*
 * ⚠️⚠️ **PER-SHAPE INNER CALIBRATION, AND THE FIRST VERSION OF THIS PROBE NEEDED IT (item 2338).** Timing
 * ONE call per rep put `lookup` at 0.002 ms alone and 0.004 mixed — a "2x" that is two ticks of
 * `performance.now()`. 🔑 At ≤0.01 ms the reading IS the clock (items 2302/2303 cost two published numbers
 * to that), and the cheap dispatch-dominated shapes are precisely the ones mixing should hurt, so leaving
 * them at the floor would make the instrument blind where it matters most.
 *
 * ✅ Each shape gets its own inner count, chosen ONCE before either mode runs and reused by both, so the
 * two modes divide by the same number and remain comparable.
 */
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 20);
const inners = {};

for (const n of Object.keys(SHAPES)) {
  let inner = 1;

  for (;;) {
    const t0 = performance.now();

    for (let i = 0; i < inner; i += 1) {
      SHAPES[n]();
    }

    if (performance.now() - t0 >= SAMPLE_MS || inner >= 100_000) {
      break;
    }

    inner *= 2;
  }

  inners[n] = inner;
}

const timeOne = (n) => {
  const fn = SHAPES[n];
  const inner = inners[n];
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    fn();
  }

  return (performance.now() - t0) / inner;
};
const result = {};

if (MODE === 'alone') {
  /* ⚠️ ONE shape, selected by ONLY — the isolated baseline, one per process. */
  const fn = SHAPES[names[0]];
  const ts = [];

  for (let r = 0; r < REPS; r += 1) {
    ts.push(timeOne(names[0]));
  }

  result[names[0]] = { ms: med(ts), rows: fn(), inner: inners[names[0]] };
} else {
  /*
   * 🔑 THE MIX: every shape, interleaved, timed individually inside ONE process. The interleaving is
   * round-robin rather than grouped, because a grouped run would let each shape warm its own sites again
   * and measure something closer to isolation.
   */
  const acc = Object.fromEntries(Object.keys(SHAPES).map((n) => [n, []]));

  for (let r = 0; r < REPS; r += 1) {
    for (const n of Object.keys(SHAPES)) {
      acc[n].push(timeOne(n));
    }
  }

  for (const n of Object.keys(SHAPES)) {
    result[n] = { ms: med(acc[n]), rows: SHAPES[n](), inner: inners[n] };
  }
}

for (const [n, v] of Object.entries(result)) {
  console.log(
    `  MODE=${MODE.padEnd(6)} ${n.padEnd(8)} ${(v.ms * 1000).toFixed(2).padStart(9)} us  inner=${String(v.inner).padStart(6)}  rows=${v.rows}`,
  );
}
