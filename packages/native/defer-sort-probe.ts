/**
 * ONE SHAPE PER PROCESS: what does deferring the projection under a windowed sort cost or save?
 *
 * Item 1062's subject. `detectNodeProjection` refused a window whenever any projected item could
 * fault, because it projected every row and sliced — so `RETURN n.k + 1 AS c ORDER BY c LIMIT 10`
 * fell to the general path while the plain-property spelling took the rung. Items 1058/1060/1061
 * located that boundary: the cost is a ROUTE CLIFF, flat in the expression's complexity.
 *
 * The instrument is `rel-lift-probe.ts`'s, for the reasons stated there: one shape per process,
 * fourteen reps, the whole series printed, the median of reps 4+ as the summary. A single shared
 * process would let one shape's dispatch pollute another's, and some TS shapes are bimodal inside
 * one process.
 *
 *   cd packages/native && SHAPE=arith bun defer-sort-probe.ts
 *
 * `reached: false` rows are CONTROLS — shapes this change cannot execute for, which is what says
 * a movement is the change rather than the machine.
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

const N = Number(process.env.DEFER_N ?? 200_000);
const REPS = Number(process.env.DEFER_REPS ?? 14);

const SHAPES: Record<string, { q: string; reached: boolean }> = {
  // THE SUBJECTS: a window, a sort on an output column, and one item that is not a bare property
  // read. Each took the general path before item 1062 and takes the deferred arm after it.
  arith: { q: 'MATCH (n:P) RETURN n.k + 1 AS c ORDER BY c LIMIT 10', reached: true },
  fn: { q: 'MATCH (n:P) RETURN upper(n.s) AS c ORDER BY c LIMIT 10', reached: true },
  // The sort key is PLAIN and is an output column; only the SECOND item disqualifies the
  // projection. Item 1061 measured that one such item refuses the whole thing.
  mixed: { q: 'MATCH (n:P) RETURN n.k AS c, n.k + 1 AS d ORDER BY c LIMIT 10', reached: true },
  // THE SPELLING PAIR. `arith` sorts on the ALIAS and this sorts on the EXPRESSION the alias
  // names. They are one question, and the first cut of item 1062 had them 3.8x apart because it
  // ranked on output columns — `bun run spelling` caught that before it shipped.
  'arith-expr': { q: 'MATCH (n:P) RETURN n.k + 1 AS c ORDER BY n.k + 1 LIMIT 10', reached: true },
  // A key that is not projected at all — admitted since the arm compiles its keys.
  'unprojected-key': { q: 'MATCH (n:P) RETURN n.k + 1 AS c ORDER BY n.s LIMIT 10', reached: true },

  // ITEM 1064's shapes: a windowed sort whose keys are DIRECT property reads, which the plain arm
  // served by projecting every row and letting the heap select.
  'topk-plain': { q: 'MATCH (n:P) RETURN n.k AS c ORDER BY c LIMIT 10', reached: true },
  'topk-two-keys': {
    q: 'MATCH (n:P) RETURN n.s AS d, n.k AS c ORDER BY d, c LIMIT 10',
    reached: true,
  },
  // The STATEMENT-position spelling, whose `boundedTopKeyed` call item 1064 de-boxed as well.
  'stmt-topk': { q: 'MATCH (n:P) ORDER BY n.k LIMIT 10 RETURN n.k AS c', reached: true },
  'stmt-two-keys': { q: 'MATCH (n:P) ORDER BY n.s, n.k LIMIT 10 RETURN n.k AS c', reached: true },
  // ABOVE the `* 16` crossover, where the heap is a slower way to sort everything and both arms
  // sort-and-slice. It must not regress past the one extra array.
  'big-cap': { q: 'MATCH (n:P) RETURN n.k AS c ORDER BY c LIMIT 10000', reached: false },
  'stmt-big-cap': { q: 'MATCH (n:P) ORDER BY n.k LIMIT 10000 RETURN n.k AS c', reached: false },

  // CONTROLS, each for a different reason.
  //
  // `plain` already took the rung — every item is a direct property read, so `outputColumnSorts`
  // admitted the window on the first ask and the deferred arm is never consulted. It is the arm
  // that says what the fast route costs, and it must not move.
  plain: { q: 'MATCH (n:P) RETURN n.k AS c ORDER BY c LIMIT 10', reached: false },
  // No WINDOW, so the fault rule never applied: this shape took the rung before and after.
  nolimit: { q: 'MATCH (n:P) RETURN n.k + 1 AS c ORDER BY c', reached: false },
  // `LIMIT 0` is still refused, and under deferral that guard is load-bearing rather than
  // cosmetic: ranking keys to emit nothing would raise where `applyProjection` returns `[]`.
  limit0: { q: 'MATCH (n:P) RETURN n.k + 1 AS c ORDER BY c LIMIT 0', reached: false },
  // No sort at all — the general path is lazy here and the rung declines, unchanged.
  unsorted: { q: 'MATCH (n:P) RETURN n.k + 1 AS c LIMIT 10', reached: false },
};

const name = process.env.SHAPE ?? 'arith';
const shape = SHAPES[name];

if (shape === undefined) {
  console.error(`SHAPE must be one of: ${Object.keys(SHAPES).join(', ')}`);
  process.exit(1);
}

const g = new TsGraph();

for (let i = 0; i < N; i++) {
  g.addVertex({
    id: `v${i}`,
    labels: ['P'],
    properties: { k: (i * 7919) % N, s: `s${(i * 31) % 1000}` },
  });
}

const series: number[] = [];

for (let r = 0; r < REPS; r++) {
  const t0 = performance.now();
  const rows = tsQuery(g, shape.q);
  const ms = performance.now() - t0;

  series.push(ms);

  if (r === 0) {
    console.log(`rows=${rows.length}`);
  }
}

const warm = series.slice(3).sort((a, b) => a - b);
const median = warm[Math.floor(warm.length / 2)];

console.log(`series ${series.map((m) => m.toFixed(1)).join(' ')}`);
console.log(
  `${name.padEnd(9)} ${shape.reached ? 'SUBJECT' : 'CONTROL'}  median(reps 4+) ${median.toFixed(2)} ms   N=${N}`,
);
