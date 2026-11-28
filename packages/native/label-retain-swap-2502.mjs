/*
 * Item 2502: is the inversion in `retained-2457.mjs` an ORDER artifact?
 *
 * That probe reports, with `global.gc()` forced at every sample:
 *
 *     3 hops, no labels [ctl]   1.56 MiB
 *     3 hops, 1 live label      0.01 MiB
 *     3 hops, 3 live labels     0.01 MiB
 *     3 hops, no path  [ctl]    1.56 MiB      <- the EXISTING pair, same shape
 *     3 hops + path()           0.01 MiB
 *
 * **A walk that carries labels cannot retain LESS than the same walk without them**, and neither can
 * one that tracks paths. Both pairs are impossible as printed, so one of the two readings is an
 * instrument artifact — and the repo's own rule is that an arm reading below its own control is an
 * instrument bug UNTIL A POSITION SWAP SAYS OTHERWISE. This is that swap.
 *
 * Each order is run in its own child process, because an in-process A/B lets the first arm's
 * allocation state shape the second's (the same reason the TS spelling work insists on one shape
 * per process). ARM=child is the worker.
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const N = Number(process.env.SWAP_N ?? 200000);
const STEP = Number(process.env.SWAP_STEP ?? 16384);

const build = async () => {
  const { Graph } = await import('@lenke/core');
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < N; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97 } }));
  }

  for (let i = 0; i < N; i += 1) {
    g.addEdge({
      id: `e${i}`,
      from: vs[i],
      to: vs[(i + 1) % N],
      labels: ['E'],
      properties: {},
    });
  }

  return g;
};

if (process.env.ARM === 'child') {
  const { V, as_, out, run, select, traversal } = await import('@lenke/gremlin');
  const graph = await build();
  const ORDER = (process.env.ORDER ?? 'ctl-first').split(',');

  /*
   * `ctl` IS NOT A VALID CONTROL FOR `lbl`, AND THAT IS THIS PROBE'S RESULT (item 2502). Both emit a
   * `Vertex` at the same row count — checked before the arms were written — and the bare walk STILL
   * costs ~14.6 MiB that the labelled walk does not, stably in both orders. Something structural
   * differs between the two generator chains beyond the labels, so the pair cannot isolate label
   * retention and its ordering is impossible as printed.
   *
   * `lbl3` is the comparison that IS valid: it goes through the same `select` path as `lbl`, so the
   * two differ ONLY in how many labels are live (one against three).
   */
  const plans = {
    ctl: () => traversal(V(), out('E'), out('E'), out('E')),
    lbl: () => traversal(V(), as_('a'), out('E'), out('E'), out('E'), select('a')),
    lbl3: () =>
      traversal(V(), as_('a'), out('E'), as_('b'), out('E'), as_('c'), out('E'), select('a')),
  };

  const peakOf = (make) => {
    global.gc();
    const base = process.memoryUsage().heapUsed;
    let worst = 0;
    let c = 0;

    for (const _row of run(make(), graph)) {
      c += 1;

      if (c % STEP === 0) {
        global.gc();
        const live = process.memoryUsage().heapUsed - base;

        if (live > worst) {
          worst = live;
        }
      }
    }

    return { rows: c, mib: worst / 1024 / 1024 };
  };

  const out2 = {};

  // Two reps per arm in the given order, so each arm is measured warm in BOTH orders.
  for (const which of ORDER) {
    out2[which] = peakOf(plans[which]);
  }

  process.stdout.write(`${JSON.stringify(out2)}\n`);
  process.exit(0);
}

console.log(`# label-retention POSITION SWAP  N=${N} STEP=${STEP}`);
console.log('# A walk carrying labels cannot retain LESS than the same walk without them.');
console.log('# If the sign follows the ORDER rather than the arm, the sampler is the artifact.\n');

const runOrder = (order) => {
  const txt = execFileSync(process.execPath, ['--expose-gc', new URL(import.meta.url).pathname], {
    env: { ...process.env, ARM: 'child', ORDER: order },
    encoding: 'utf8',
  });

  return JSON.parse(txt.trim().split('\n').pop());
};

for (const order of ['ctl,lbl', 'lbl,ctl', 'lbl,lbl3', 'lbl3,lbl']) {
  const r = runOrder(order);
  const [aName, bName] = order.split(',');
  const a = r[aName];
  const b = r[bName];
  const impossible = aName === 'ctl' || bName === 'ctl';
  const ratio = Math.max(a.mib, b.mib) / Math.max(1e-9, Math.min(a.mib, b.mib));
  let verdict = `ratio ${ratio.toFixed(2)}x`;

  if (impossible) {
    verdict = b.mib >= a.mib ? 'ok' : 'IMPOSSIBLE ORDERING';
  }

  console.log(
    `  order=${order.padEnd(9)}  ${aName} ${a.mib.toFixed(2).padStart(6)} MiB` +
      `   ${bName} ${b.mib.toFixed(2).padStart(6)} MiB   (${a.rows}/${b.rows} rows)   ${verdict}`,
  );
}

console.log(
  '\n  Read the VERDICT column. Same sign in both orders => the reading is about the arms.',
);
console.log('  Sign follows the order => the sampler cannot measure this pair at all.');
