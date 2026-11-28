/*
 * Item 2517: WHY does `out,dedupe,out` retain 5.22 MiB — neither the 0.07 floor nor the 14.55 full
 * chain?
 *
 * Item 2505's deletion sweep left this one row unexplained. Every other disqualified shape dropped to
 * the 1-hop floor because it could not take the multi-hop chain-CSR route; this one sits in between,
 * so "it is disqualified" does not account for it.
 *
 * ## THE HYPOTHESIS, AND THE ONE AXIS THAT SEPARATES IT
 *
 * A mid-chain `dedupe()` must HOLD WHAT IT HAS SEEN — the intermediate vertices — so its cost should
 * be O(DISTINCT INTERMEDIATES), not O(|V|) and not a CSR. If that is what 5.22 MiB is, it is correct
 * and the row needs an explanation rather than a fix.
 *
 * So: hold |V|, the edge count AND the walk shape fixed, and vary ONLY how many DISTINCT vertices the
 * first hop can land on.
 *
 *   - cost grows with DISTINCT  => it is the dedupe set. Correct, explained, no lever.
 *   - cost FLAT in DISTINCT     => it is something else (a CSR, or per-row state) and the hypothesis
 *                                  is refuted.
 *
 * `out,out` (no dedupe) runs at every fixture as the CONTROL: it should stay at the full-chain cost
 * regardless of the distinct count, because a chain CSR is O(|V|) whatever the topology. A control
 * that MOVES with the axis would mean the fixture is changing something else too.
 *
 * ## THE FIXTURE IS EXPLICIT ABOUT DISTINCTNESS, AND ASSERTS IT
 *
 * Targets are `i % distinct`, so the distinct endpoint count is exact by construction — and the probe
 * COUNTS the distinct endpoints and refuses to report if the count is not what was asked for. This
 * repo has been burned twice by a generator whose `(a*k+b) % N` form was invariant under `k -> k+N`
 * and silently collapsed (items 702, 1516/1518), so the count is asserted rather than assumed.
 *
 *     node dedupe-split-2517.mjs
 *     SPLIT_N=200000 node dedupe-split-2517.mjs
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const N = Number(process.env.SPLIT_N ?? 200000);
const STEP = Number(process.env.SPLIT_STEP ?? 8192);
const DISTINCTS = (process.env.SPLIT_DISTINCTS ?? '1,100,10000,200000').split(',').map(Number);

if (process.env.ARM === 'child') {
  const { V, dedupe, out, run, traversal } = await import('@lenke/gremlin');
  const { Graph } = await import('@lenke/core');

  const distinct = Math.min(Number(process.env.DISTINCT), N);
  const graph = new Graph();
  const vs = [];

  for (let i = 0; i < N; i += 1) {
    vs.push(graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97 } }));
  }

  /* `i % distinct` makes the distinct target count EXACT — no modular-collapse surprise. */
  const seen = new Set();

  for (let i = 0; i < N; i += 1) {
    const target = i % distinct;

    seen.add(target);
    graph.addEdge({
      id: `e${i}`,
      from: vs[i],
      to: vs[target],
      labels: ['E'],
      properties: {},
    });
  }

  if (seen.size !== distinct) {
    process.stdout.write(
      `${JSON.stringify({ error: `asked ${distinct} distinct, built ${seen.size}` })}\n`,
    );
    process.exit(1);
  }

  const plans = {
    dedupe: () => traversal(V(), out('E'), dedupe(), out('E')),
    plain: () => traversal(V(), out('E'), out('E')),
  };

  global.gc();
  const base = process.memoryUsage().heapUsed;
  let worst = 0;
  let rows = 0;

  for (const _row of run(plans[process.env.SHAPE](), graph)) {
    rows += 1;

    if (rows % STEP === 0) {
      global.gc();
      const live = process.memoryUsage().heapUsed - base;

      if (live > worst) {
        worst = live;
      }
    }
  }

  global.gc();
  worst = Math.max(worst, process.memoryUsage().heapUsed - base);

  process.stdout.write(
    `${JSON.stringify({ rows, mib: worst / 1024 / 1024, distinct: seen.size })}\n`,
  );
  process.exit(0);
}

const one = (shape, distinct) => {
  const txt = execFileSync(process.execPath, ['--expose-gc', new URL(import.meta.url).pathname], {
    env: { ...process.env, ARM: 'child', SHAPE: shape, DISTINCT: String(distinct) },
    encoding: 'utf8',
    maxBuffer: 1 << 24,
  });

  return JSON.parse(txt.trim().split('\n').pop());
};

console.log(`# Is out,dedupe,out's 5.22 MiB the DEDUPE SET?  |V|=${N}  (one shape per process)`);
console.log(
  '# |V|, edge count and walk shape are FIXED; only the DISTINCT intermediate count varies.',
);
console.log('# grows with distinct => the dedupe set (correct). FLAT => something else.\n');
console.log('  distinct   out,dedupe,out        out,out [CONTROL]     B/distinct');

for (const d of DISTINCTS) {
  const dd = one('dedupe', d);
  const pl = one('plain', d);

  if (dd.error !== undefined || pl.error !== undefined) {
    console.log(`  ${String(d).padStart(8)}   FIXTURE ERROR: ${dd.error ?? pl.error}`);
    continue;
  }

  const cols = [
    String(d).padStart(8),
    `${dd.mib.toFixed(2).padStart(8)} MiB (${String(dd.rows).padStart(7)} rows)`,
    `${pl.mib.toFixed(2).padStart(8)} MiB (${String(pl.rows).padStart(7)} rows)`,
    ((dd.mib * 1024 * 1024) / d).toFixed(1).padStart(10),
  ];

  console.log(`  ${cols.join('  ')}`);
}

console.log(
  '\n  The CONTROL must stay flat in distinct — a chain CSR is O(|V|) whatever the topology.',
);
console.log('  A control that MOVES with the axis means the fixture changed something else too.');
