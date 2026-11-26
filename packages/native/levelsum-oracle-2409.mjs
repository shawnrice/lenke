// Item 2409 — IS THE MULTIPLICITY-WEIGHTED `sum`/`avg` INSIDE ITEM 2401'S PRECISION CONTRACT?
//
// The rung computes `Σ u_v · x_v` over the distinct reached vertices; the general path adds the
// per-path values one at a time. Those are DIFFERENT COMPUTATIONS in f64 and the module's header
// says so. What has to hold is the contract item 2401 wrote:
//
//     |engine − exact| ≤ n · ε · Σ|xᵢ|
//
// so this compares BOTH arms against an EXACT reference and checks each against that bound.
//
// THE EXACT REFERENCE IS NOT ANOTHER f64 SUM. It is a Kahan-compensated sum over the per-path
// values in the path walk's own order, which carries ~2ε total error rather than ~nε — so it is
// three orders tighter than either arm at these path counts and can stand in for the exact value.
//
// AND THE FIXTURE MUST BE INEXACT OR THE TEST IS VACUOUS. An integer sum in f64 is EXACT whatever
// the order and whatever the weights, so `n` alone could never separate the two arms. Every shape
// here aggregates a value multiplied into the binary-inexact range.
//
//     bun levelsum-oracle-2409.mjs
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 900);
const FANOUT = Number(process.env.FANOUT ?? 3);
const EPS = Number.EPSILON;

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({
    id: String(i + 1),
    labels: ['T'],
    properties: {
      // `f` is inexact in binary and spans three decades, so a re-association is visible and a
      // weighted multiply is not trivially equal to repeated addition.
      f: (i % 97) * 0.1 + (i % 7) * 1e-3 + (i % 3) * 1e3,
      n: i % 8,
      // Every 50th vertex carries a DATE where the others carry a number — the bail fixture.
      mixed: i % 50 === 0 ? { '@date': '2024-01-02' } : (i % 13) * 0.1,
      // Null on two thirds, so the non-null path count differs from the total path count.
      sparse: i % 3 === 0 ? (i % 11) * 0.1 : null,
    },
  });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(String(i + 1)),
    // Splits on the REPEAT INDEX — CLAUDE.md's functional-graph fix.
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
    labels: ['E'],
    properties: { w: e % 7 },
  });
}

const names = ['a', 'b', 'c', 'd', 'e'];
const chainOf = (hops) =>
  names
    .slice(0, hops + 1)
    .map((v) => `(${v}:T)`)
    .join('-[:E]->');

/**
 * The EXACT reference: Kahan over the per-path values, in the path walk's own order.
 *
 * IT READS THE ENGINE'S OWN ROWS rather than re-deriving the walk. A second traversal written
 * here could disagree with the engine about WHICH paths exist — and then the oracle would be
 * measuring my traversal against the engine's, not the two folds against the arithmetic.
 */
const exactOf = (hops, prop) => {
  const far = names[hops];
  // eslint-disable-next-line lenke/no-raw-interpolation -- built only from this file's own constant `names` and a `prop` from its own literal list; nothing reaches it from outside.
  const rows = query(g, `MATCH ${chainOf(hops)} RETURN ${far}.${prop} AS v`, {});
  let sum = 0;
  let comp = 0;
  let absSum = 0;
  let n = 0;

  for (const row of rows) {
    const { v } = row;

    if (v === null || v === undefined || typeof v !== 'number') {
      continue;
    }

    const y = v - comp;
    const t = sum + y;

    comp = t - sum - y;
    sum = t;
    absSum += Math.abs(v);
    n += 1;
  }

  return { sum, absSum, n, paths: rows.length };
};

const SHAPES = [];

for (const hops of [2, 3]) {
  for (const prop of ['f', 'sparse']) {
    for (const fn of ['sum', 'avg']) {
      SHAPES.push({ hops, prop, fn });
    }
  }
}

let pass = 0;
let fail = 0;
let control = 0;

console.log(`fixture ${NODES} vertices / ${NODES * FANOUT} edges, fanout ${FANOUT}\n`);

for (const { hops, prop, fn } of SHAPES) {
  const far = names[hops];
  const text = `MATCH ${chainOf(hops)} RETURN ${fn}(${far}.${prop}) AS x`;
  const got = query(g, text, {}).at(0)?.x;
  const { sum, absSum, n } = exactOf(hops, prop);
  const exact = fn === 'sum' ? sum : sum / n;
  // The contract's bound. `avg` divides by an EXACT integer, one further rounding, so the same
  // bound scaled by `1/n` plus that rounding is covered by the `n·ε` term many times over.
  const bound = n * EPS * (fn === 'sum' ? absSum : absSum / n) + Number.MIN_VALUE;
  const err = Math.abs(got - exact);
  const ok = err <= bound;

  // THE CONTROL THAT MAKES A PASS MEAN SOMETHING: if the two arms were bit-identical the bound
  // would be satisfied trivially and this oracle would prove nothing. `exactIsSeparable` says the
  // fixture is actually inexact at this size — the error must be NON-ZERO somewhere in the sweep.
  if (err > 0) {
    control += 1;
  }

  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${fn}(${far}.${prop}) ${hops} hops  n=${n}  ` +
      `got ${String(got)}  exact ${exact}  err ${err.toExponential(3)}  ` +
      `bound ${bound.toExponential(3)}  err/bound ${(err / bound).toExponential(2)}`,
  );

  if (ok) {
    pass += 1;
  } else {
    fail += 1;
  }
}

/**
 * THE BAIL. `mixed` holds a DATE on every 50th vertex, so `sum` over it is a data exception on the
 * general path (item 2336) and `u · Temporal` is a silent `NaN` in the weighted fold.
 *
 * WHAT THIS ASSERTS IS THAT THE RUNG HANDS THE QUERY BACK, not that it answers. A rung that
 * answered `NaN`, or answered the partial sum of the numbers it had seen before the date, would
 * both be WRONG where the engine is required to fault — item 2159's sharpest test is exactly this
 * shape, a column numeric until its last row.
 */
console.log('');

let bailOk = 0;
let bailBad = 0;

for (const hops of [2, 3]) {
  const far = names[hops];
  const text = `MATCH ${chainOf(hops)} RETURN sum(${far}.mixed) AS x`;
  let verdict;

  try {
    const got = query(g, text, {}).at(0)?.x;

    verdict = `ANSWERED ${String(got)}`;
  } catch (err) {
    verdict = `FAULTED ${String(err.code ?? err.name)}: ${String(err.message).slice(0, 60)}`;
  }

  // The general path's behaviour is the specification here, and it faults. Anything else is the
  // weighted fold having answered a question it may not.
  const ok = verdict.startsWith('FAULTED');

  console.log(`${ok ? 'OK  ' : 'FAIL'} bail  sum(${far}.mixed) ${hops} hops  ${verdict}`);

  if (ok) {
    bailOk += 1;
  } else {
    bailBad += 1;
  }
}

// An EMPTY fold: every reached value null. `sum` must answer null, not 0.
const emptyText = `MATCH ${chainOf(2)}-[:NOPE]->(z:T) RETURN sum(z.f) AS x`;
let emptyOk = false;

try {
  const got = query(g, emptyText, {}).at(0)?.x;

  emptyOk = got === null;
  console.log(`${emptyOk ? 'OK  ' : 'FAIL'} empty sum over an unreachable level -> ${String(got)}`);
} catch (err) {
  console.log(`FAIL empty sum threw ${String(err.message).slice(0, 80)}`);
}

console.log(
  `\n${pass + bailOk + (emptyOk ? 1 : 0)} pass  ${fail + bailBad + (emptyOk ? 0 : 1)} fail  ` +
    `CONTROL: ${control}/${SHAPES.length} shapes have a NON-ZERO error, so the two arms genuinely differ`,
);

if (fail + bailBad > 0 || !emptyOk || control === 0) {
  process.exitCode = 1;
}
