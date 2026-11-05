/**
 * A DISCARDED `Graph` IS RETAINED IN FULL UNTIL THE MICROTASK QUEUE DRAINS — so a fully synchronous
 * build/compute/discard loop retains every graph it ever built and eventually OOMs.
 *
 * Found by accident: `algo-scaling-bench.mjs` built one fixture per algorithm per size and died at
 * **4,087 MB** with "Ineffective mark-compacts near heap limit". The fixture was measured at ~2.8
 * KB/vertex — 450 MB at the size that failed — so the heap was not the fixtures that were live, it
 * was the ones that should have been dead.
 *
 * A heap snapshot (`node:v8` `writeHeapSnapshot`, then a BFS from the GC roots) gave the retaining
 * path exactly:
 *
 *     (GC roots) -> (Micro tasks) -> system / CallableTask
 *       -> closure 'drainMutations' -> system / Context -> Context
 *       -> [object] Graph -> property 'verticesById' -> Map -> Vertex
 *
 * `Graph` defers its reactive bookkeeping to "one microtask per BURST of writes", and that queued
 * closure captures the graph. Nothing is wrong with the deferral — but the microtask queue only
 * drains when the JS stack unwinds, and `global.gc()` does not unwind it. So in a synchronous run
 * the pending drain pins each graph forever.
 *
 * ⚠️ THIS IS BOUNDED RETENTION, NOT AN UNBOUNDED LEAK, and the distinction is the whole finding:
 * `YIELD=1` (one `await setTimeout(0)` per round) flattens the staircase completely. Async callers
 * — which is every normal embedding — release each graph on the next tick. The exposure is
 * synchronous batch work: a test suite, a bench sweep, a CLI that builds, computes and discards
 * inside one turn.
 *
 *     ARM=full ROUNDS=6 node --expose-gc graph-retention-probe.mjs      # staircase
 *     ARM=full YIELD=1 node --expose-gc graph-retention-probe.mjs       # flat
 *     ARM=empty node --expose-gc graph-retention-probe.mjs              # control: 0.00 MB/round
 *
 * ⚠️ NEEDS `--expose-gc`. Without it `global.gc` is undefined and every reading is whatever V8
 * happened to collect on its own, which is not the question.
 *
 * Measured (N=20,000, per-round growth after two forced GCs):
 *
 *     empty           0.00 MB    <- the control: a graph that is never mutated is never pinned
 *     verticesProps  11.45 MB
 *     full           48.35 MB
 *     full YIELD=1    ~0 MB
 *
 * `empty` landing at exactly 0.00 is what makes the rest trustworthy: the retention tracks MUTATION,
 * not construction.
 */
import { Graph } from '@lenke/core';

const N = Number(process.env.N ?? 20_000);
const ROUNDS = Number(process.env.ROUNDS ?? 6);
const ARM = process.env.ARM ?? 'full';
const YIELD = process.env.YIELD === '1';

if (typeof global.gc !== 'function') {
  throw new Error('run with --expose-gc; without it every reading is V8 incidental collection');
}

const mb = () => process.memoryUsage().heapUsed / 1048576;

const arms = {
  /** The control: constructed, never mutated, so no drain is ever queued. */
  empty: () => new Graph(),
  verticesProps: () => {
    const g = new Graph();

    for (let i = 0; i < N; i += 1) {
      g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97 } });
    }

    return g;
  },
  full: () => {
    const g = new Graph();
    const vs = [];

    for (let i = 0; i < N; i += 1) {
      vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97 } }));
    }

    for (let e = 0; e < N * 2; e += 1) {
      const i = e % N;

      g.addEdge({ id: `e${e}`, from: vs[i], to: vs[(i * 7 + 3) % N], labels: ['E'] });
    }

    return g;
  },
};

if (arms[ARM] === undefined) {
  throw new Error(`unknown ARM ${ARM}; have ${Object.keys(arms).join(',')}`);
}

global.gc();

const base = mb();
const series = [];

for (let r = 0; r < ROUNDS; r += 1) {
  // The graph is held in a slot and the slot is then cleared, rather than in a `let` reassigned to
  // undefined: dropping the ONLY reference is the measurement, and a bare `let` that is written and
  // never read is what `no-unused-vars` rejects. The object itself is trivially collectable.
  const slot = { g: arms[ARM]() };

  slot.g = undefined;

  if (YIELD) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  global.gc();
  global.gc();
  series.push(mb());
}

// First-to-last over the gaps, so the in-flight current graph does not count as growth.
const growth = (series[series.length - 1] - series[0]) / Math.max(1, ROUNDS - 1);

console.log(
  `ARM=${ARM} N=${N} YIELD=${YIELD ? 1 : 0} base=${base.toFixed(1)} MB\n` +
    `series=[${series.map((x) => x.toFixed(1)).join(' ')}] MB\n` +
    `per-round growth=${growth.toFixed(2)} MB`,
);
