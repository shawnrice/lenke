/*
 * Item 2504: WHY does a bare multi-hop walk retain so much more than the same walk ending in
 * `path()`? Items 2502/2503 established the fact and ruled out the instrument; this localizes it.
 *
 * ## WHAT IS ALREADY KNOWN
 *
 *     bare 3 hops            7.03 MiB  (N=100k)      1.56 MiB  (N=200k, shipped probe)
 *     3 hops + path()        0.14 MiB                0.01 MiB
 *     bare 1 hop                   -                 0.03 MiB
 *
 * Stable across two sizes, two partners and both positions (item 2503), so it is a property of the
 * chains. And the compiled plans differ in their ROUTE FLAG, which is the first real clue:
 *
 *     V>out>out>out          readsPath = false
 *     V>out>out>out>path     readsPath = true
 *
 * So the `path()` arm was never "the same walk plus path tracking" — it takes a different route, and
 * comparing the two was invalid from the start. That is enough to retire the pairing, but not enough
 * to say what the bare route actually holds.
 *
 * ## THE TWO HYPOTHESES, AND THE ARMS THAT SEPARATE THEM
 *
 *   A. **Per-hop intermediate retention.** The shipped probe's own numbers hint at it: bare 1 hop is
 *      0.03 MiB and bare 3 hops is 1.56, a 52x jump for two more hops. If each hop materializes
 *      something that outlives it, retention should climb with HOP COUNT.
 *   B. **Yielding element objects.** Both `out` chains emit `Vertex`es; a scalar-emitting tail
 *      (`values('k')`) keeps `readsPath = false` and the same hops while changing only what is
 *      handed to the consumer.
 *
 * The arms below vary hop count 1..4 with and without a scalar tail, so A shows up as a slope in the
 * hop column and B as a gap between the two columns. They are not exclusive and the point is to see
 * which term dominates.
 *
 * One shape per PROCESS (item 2503's rule), and `global.gc()` at every sample — occupancy without a
 * collection counts garbage and inverted this whole family once already (item 2457).
 *
 *     node bare-hop-retain-2504.mjs
 *     SWAP_N=200000 node bare-hop-retain-2504.mjs
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const N = Number(process.env.SWAP_N ?? 100000);
const STEP = Number(process.env.SWAP_STEP ?? 8192);

if (process.env.ARM === 'child') {
  const { V, out, path, run, traversal, values } = await import('@lenke/gremlin');
  const { Graph } = await import('@lenke/core');

  const graph = new Graph();
  const vs = [];

  for (let i = 0; i < N; i += 1) {
    vs.push(graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97 } }));
  }

  for (let i = 0; i < N; i += 1) {
    graph.addEdge({
      id: `e${i}`,
      from: vs[i],
      to: vs[(i + 1) % N],
      labels: ['E'],
      properties: {},
    });
  }

  const hops = (n) => Array.from({ length: n }, () => out('E'));

  const plans = {
    bare1: () => traversal(V(), ...hops(1)),
    bare2: () => traversal(V(), ...hops(2)),
    bare3: () => traversal(V(), ...hops(3)),
    bare4: () => traversal(V(), ...hops(4)),
    val1: () => traversal(V(), ...hops(1), values('k')),
    val2: () => traversal(V(), ...hops(2), values('k')),
    val3: () => traversal(V(), ...hops(3), values('k')),
    val4: () => traversal(V(), ...hops(4), values('k')),
    path1: () => traversal(V(), ...hops(1), path()),
    path3: () => traversal(V(), ...hops(3), path()),
  };

  const make = plans[process.env.SHAPE];

  global.gc();
  const baseHeap = process.memoryUsage().heapUsed;
  let worst = 0;
  let c = 0;

  for (const _row of run(make(), graph)) {
    c += 1;

    if (c % STEP === 0) {
      global.gc();
      const live = process.memoryUsage().heapUsed - baseHeap;

      if (live > worst) {
        worst = live;
      }
    }
  }

  global.gc();
  const after = process.memoryUsage().heapUsed - baseHeap;

  process.stdout.write(
    `${JSON.stringify({ rows: c, mib: Math.max(worst, after) / 1024 / 1024 })}\n`,
  );
  process.exit(0);
}

const one = (shape) => {
  const txt = execFileSync(process.execPath, ['--expose-gc', new URL(import.meta.url).pathname], {
    env: { ...process.env, ARM: 'child', SHAPE: shape },
    encoding: 'utf8',
    maxBuffer: 1 << 24,
  });

  return JSON.parse(txt.trim().split('\n').pop());
};

console.log(
  `# bare-hop retention  N=${N} STEP=${STEP}  (one shape per process, gc at each sample)`,
);
console.log('# HYPOTHESIS A: per-hop retention  => the bare column climbs with hop count.');
console.log(
  '# HYPOTHESIS B: yielding elements  => the bare column sits above the values column.\n',
);
console.log('  hops   bare (Vertex)        values(k) scalar      bare/values');

for (const n of [1, 2, 3, 4]) {
  const b = one(`bare${n}`);
  const v = one(`val${n}`);
  const ratio = b.mib / Math.max(1e-9, v.mib);

  console.log(
    `  ${n}      ${b.mib.toFixed(2).padStart(7)} MiB (${String(b.rows).padStart(7)})` +
      `   ${v.mib.toFixed(2).padStart(7)} MiB (${String(v.rows).padStart(7)})` +
      `   ${ratio.toFixed(2).padStart(8)}x`,
  );
}

const p1 = one('path1');
const p3 = one('path3');

console.log(
  `\n  path() for reference (a DIFFERENT route — readsPath=true):` +
    `  1 hop ${p1.mib.toFixed(2)} MiB, 3 hops ${p3.mib.toFixed(2)} MiB`,
);
console.log('  A slope in the bare column with a flat values column isolates the element yield.');
