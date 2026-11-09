/**
 * WHAT DOES A WRITE BETWEEN READS COST THE `topologyVersion`-KEYED CSR ARMS?
 *
 * Six arms shipped on that cache this session — items 1676, 1685, 1688, 1689, 1690 and 1692 — and
 * EVERY ONE of their A/Bs measured consecutive reads with no writes in between. That is the warm
 * case. The cache is dropped WHOLE on any topology write (`csrFor` and `chainCsrFor` both discard
 * the generation when `graph.topologyVersion` moves), so a workload that writes between reads
 * rebuilds it every time.
 *
 * The cold figure is already known and it is not small: item 1694 measured the build at ~144 ms on a
 * scattered adjacency layout, against a walk that costs 139 and an arm that costs 23. So ONE write
 * before each read turns a 6x win into a ~1.2x loss, by arithmetic. This probe measures it rather
 * than inferring it, and finds the write RATE at which the arm breaks even — which is the number
 * that decides whether the shipped arms are safe for a serving workload.
 *
 * ⚠️ THE FIXTURE IS SCATTERED, like `bench-gremlin.ts`'s and unlike every probe in items 1691-1693.
 * Item 1694 measured edge insertion order at 2.26x on the same graph, and a grouped build is the
 * best case for the pointer-chasing walk this arm replaces — so a grouped fixture would understate
 * both the win and the rebuild cost.
 *
 * ⚠️ AND THE WRITE IS AN `addEdge`, WHICH IS THE CHEAP CASE FOR THE WRITE ITSELF AND THE WORST CASE
 * FOR THE CACHE: it bumps `topologyVersion` (items 1674/1675) for a few microseconds of work, so
 * essentially all of the measured cost is the rebuild, not the write.
 *
 *   ARM=warm        node csr-invalidation-probe.mjs    reads only — what the A/Bs measured
 *   ARM=write1      one addEdge before EVERY read
 *   ARM=write10     one addEdge before every 10th read
 *   ARM=write100    one addEdge before every 100th read
 */
import { Graph } from '@lenke/core';
import { V, eq, has, id, out, toArray, traversal } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200_000);
const REPS = Number(process.env.REPS ?? 14);
const READS = Number(process.env.READS ?? 20);

const g = new Graph();
const vs = [];

for (let i = 0; i < N; i += 1) {
  vs.push(g.addVertex({ id: `v${i}`, labels: ['Person'], properties: { age: i % 90 } }));
}

// ⚠️ `bench-gremlin.ts`'s own edge expression, including item 1632's repeat-index split. The
// `from` scatter is the point: each vertex's five edges land ~200,000 insertions apart.
let e = 0;

for (let k = 0; k < N * 5; k += 1) {
  const to = ((k % N) * 104_729 + Math.floor(k / N) * 977) % N;

  g.addEdge({
    id: `e${k}`,
    from: vs[(k * 7919) % N],
    to: vs[to],
    labels: ['KNOWS'],
    properties: { w: k % 7 },
  });
  e += 1;
}

const distinct = new Set();

for (const edge of g.edges) {
  distinct.add(edge.to);
}

if (distinct.size < N / 2) {
  throw new Error(`FIXTURE DEGENERATE: ${distinct.size} distinct endpoints`);
}

// Item 1692's shipped arm: a far-filtered hop, drained by `toArray`.
const PLAN = traversal(V(), out('KNOWS'), has('age', eq(30)), id());

let extra = 0;

/** One `addEdge`, which bumps `topologyVersion` and so drops the whole CSR generation. */
const write = () => {
  g.addEdge({
    id: `x${extra}`,
    from: vs[extra % N],
    to: vs[(extra * 31 + 7) % N],
    labels: ['KNOWS'],
    properties: {},
  });
  extra += 1;
};

const ARMS = {
  warm: () => {
    for (let i = 0; i < READS; i += 1) {
      toArray(PLAN, g);
    }
  },
  write1: () => {
    for (let i = 0; i < READS; i += 1) {
      write();
      toArray(PLAN, g);
    }
  },
  write10: () => {
    for (let i = 0; i < READS; i += 1) {
      if (i % 10 === 0) {
        write();
      }

      toArray(PLAN, g);
    }
  },
  write100: () => {
    for (let i = 0; i < READS; i += 1) {
      if (i % 100 === 0) {
        write();
      }

      toArray(PLAN, g);
    }
  },
};

const PICK = process.env.ARM;

if (PICK === undefined || ARMS[PICK] === undefined) {
  throw new Error(`set ARM to one of: ${Object.keys(ARMS).join(', ')}`);
}

// Warm the plan and the cache once, outside the measurement.
toArray(PLAN, g);

const series = [];

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();

  ARMS[PICK]();
  series.push((performance.now() - t0) / READS);
}

/** ⚠️ MEDIAN of the warm reps, per READ: `min` has reversed a verdict's sign in this repo. */
const warm = series.slice(3).sort((a, b) => a - b);

console.log(
  `${PICK.padEnd(10)} ms/read median=${warm[Math.floor(warm.length / 2)].toFixed(2).padStart(8)} edges=${g.edgeCount} series=${series.map((x) => x.toFixed(1)).join(' ')}`,
);
