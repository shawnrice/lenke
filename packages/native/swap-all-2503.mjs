/*
 * Item 2503: POSITION-SWAP EVERY BUFFERING ARM in `retained-2457.mjs`.
 *
 * That probe measures its 19 arms in ONE fixed order inside ONE process. Item 2502 swapped two of
 * them and the swap overturned a reading both times — label COUNT turned out to follow the POSITION
 * (whichever arm ran first read 0.23 MiB, the second 0.04) and the bare-walk control turned out to
 * be invalid. Two for two is reason to doubt the rest, not to assume them.
 *
 * ## THE DESIGN
 *
 * Each arm is run TWICE — once FIRST in a fresh process and once SECOND, after the CALIBRATION arm —
 * and the two numbers are compared.
 *
 *   - **The partner is the CALIBRATION arm, not a bare walk.** Calibration holds every row, so its
 *     retention is known a priori and large; item 2502's lesson is that a bare-walk "control" can
 *     cost more than the arm it controls for reasons unrelated to the thing under test, which makes
 *     it useless as a baseline. A known-large partner only has to perturb, not to be subtracted.
 *   - **One pair per PROCESS.** An in-process sweep lets each arm's allocation state shape the
 *     next's, which is the whole effect being measured.
 *   - **The verdict is about STABILITY, not size.** An arm whose number is the same first and second
 *     is measurable; one whose number moves with its position is not, whatever it reads.
 *
 * ## READING IT
 *
 * `first` and `second` are the same arm measured in the two positions. `swing` is the ratio of the
 * larger to the smaller. A `swing` near 1 means the arm can be measured; a large `swing` means the
 * published number for that arm is an artifact of where it sat in the array.
 *
 *     node swap-all-2503.mjs                 # every arm, 100k
 *     SWAP_N=200000 node swap-all-2503.mjs   # the shipped probe's size
 *     SWAP_ONLY=tree,order node swap-all-2503.mjs
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const N = Number(process.env.SWAP_N ?? 100000);
const STEP = Number(process.env.SWAP_STEP ?? 8192);
const ONLY = (process.env.SWAP_ONLY ?? '').split(',').filter(Boolean);
/* A swing above this says the arm's number depends on where it ran. */
const TOL = Number(process.env.SWAP_TOL ?? 1.5);

const ARM_NAMES = [
  'order',
  'fold',
  'dedupe',
  'groupCount',
  'group',
  'aggregate',
  'store',
  'tree',
  'treeby',
  'repeat3',
  'repeatsimple',
  'path1',
  'path3',
  'bare3',
];

if (process.env.ARM === 'child') {
  const {
    V,
    aggregate,
    as_,
    cap,
    dedupe,
    fold,
    group,
    groupCount,
    order,
    out,
    path,
    repeat,
    run,
    select,
    simplePath,
    store,
    traversal,
    tree,
    values,
  } = await import('@lenke/gremlin');
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

  const plans = {
    /* The known quantity: it holds every row, so it must read large wherever it runs. */
    cal: () => traversal(V(), values('k')),
    order: () => traversal(V(), values('k'), order()),
    fold: () => traversal(V(), values('k'), fold()),
    dedupe: () => traversal(V(), values('k'), dedupe()),
    groupCount: () => traversal(V(), values('k'), groupCount()),
    group: () => traversal(V(), values('k'), group()),
    aggregate: () => traversal(V(), values('k'), aggregate('x'), cap('x')),
    store: () => traversal(V(), values('k'), store('x'), cap('x')),
    tree: () => traversal(V(), out('E'), tree()),
    treeby: () => traversal(V(), out('E'), tree().by('k')),
    repeat3: () => traversal(V(), repeat(out('E')).times(3)),
    repeatsimple: () => traversal(V(), repeat(out('E'), simplePath()).times(3)),
    path1: () => traversal(V(), out('E'), path()),
    path3: () => traversal(V(), out('E'), out('E'), out('E'), path()),
    bare3: () => traversal(V(), out('E'), out('E'), out('E')),
    lbl: () => traversal(V(), as_('a'), out('E'), out('E'), out('E'), select('a')),
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

    /*
     * A one-row shape (fold, tree, group, cap) never reaches the row interval, so sample once at the
     * END as well — that is the shipped probe's own "result" reading and without it those arms would
     * all report zero for a reason that has nothing to do with what they hold.
     */
    global.gc();
    const after = process.memoryUsage().heapUsed - base;

    return { rows: c, mib: Math.max(worst, after) / 1024 / 1024 };
  };

  const out2 = {};

  for (const which of (process.env.ORDER ?? '').split(',').filter(Boolean)) {
    out2[which] = peakOf(plans[which]);
  }

  process.stdout.write(`${JSON.stringify(out2)}\n`);
  process.exit(0);
}

const child = (order) => {
  const txt = execFileSync(process.execPath, ['--expose-gc', new URL(import.meta.url).pathname], {
    env: { ...process.env, ARM: 'child', ORDER: order },
    encoding: 'utf8',
    maxBuffer: 1 << 24,
  });

  return JSON.parse(txt.trim().split('\n').pop());
};

const arms = ONLY.length > 0 ? ARM_NAMES.filter((a) => ONLY.includes(a)) : ARM_NAMES;

console.log(`# POSITION SWAP of every buffering arm  N=${N} STEP=${STEP} TOL=${TOL}`);
console.log(
  '# Each arm is measured FIRST in a fresh process, and SECOND after the calibration arm.',
);
console.log('# An arm whose number moves with its POSITION cannot be measured by this sampler.\n');
console.log('  arm             rows    first   second    swing   verdict');

const unstable = [];

for (const arm of arms) {
  const a = child(`${arm},cal`)[arm];
  const b = child(`cal,${arm}`)[arm];
  const hi = Math.max(a.mib, b.mib);
  const lo = Math.min(a.mib, b.mib);
  const swing = hi / Math.max(1e-9, lo);
  const bad = swing > TOL;

  if (bad) {
    unstable.push(arm);
  }

  console.log(
    `  ${arm.padEnd(14)} ${String(a.rows).padStart(6)} ` +
      `${a.mib.toFixed(2).padStart(8)} ${b.mib.toFixed(2).padStart(8)} ` +
      `${swing.toFixed(2).padStart(8)}x   ${bad ? 'POSITION-DEPENDENT' : 'stable'}`,
  );
}

console.log(`\n  ${arms.length - unstable.length} of ${arms.length} arms stable within ${TOL}x.`);

if (unstable.length > 0) {
  console.log(
    `  POSITION-DEPENDENT (their published numbers are artifacts): ${unstable.join(', ')}`,
  );
} else {
  console.log('  Every arm measured the same in both positions.');
}
