/**
 * **IS THE 3.61 ms `ORDER BY + LIMIT` ROW ON THE TOP-K HEAP OR OFF IT? (item 2284)**
 *
 * Top-K is already built (`topKPlan`, item 1064; measured 5.3-6.1x at item 1501), and its admission is a
 * pure function whose crossover was swept: `heapBeatsSort(cap, rows) = cap * 16 <= rows`.
 *
 * **That crossover is itself an ORACLE, so this needs no code edit.** With ~40,000 matching rows:
 *
 *     LIMIT 200     200 * 16 =   3,200 <= 40,000   -> heap ADMITTED
 *     LIMIT 2000   2000 * 16 =  32,000 <= 40,000   -> heap ADMITTED, barely
 *     LIMIT 20000 20000 * 16 = 320,000 >  40,000   -> heap DECLINED, full sort
 *
 * My memory's rule is that timing cannot tell "declined" from "more work" — but here the two arms differ
 * ONLY in a constant the planner reads, and the engine's own sweep says where the route flips. If the cost
 * per DELIVERED row jumps at the flip, the heap is live and doing its job. If the curve is smooth, the
 * shape never reached the heap at all.
 *
 * `allRows` is the control: the same scan and predicate with no ORDER BY at all, so the scan's own cost is
 * visible and the sort term can be read off rather than assumed.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = 60_000;
const ROUNDS = Number(process.env.ROUNDS ?? 9);

const g = new Graph();
const TEAMS = ['core', 'platform', 'data', 'infra'];

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: `p${i}`,
    labels: ['Person'],
    properties: {
      name: `n${String(i).padStart(7, '0')}`,
      team: TEAMS[i % 4],
      seniority: i % 7,
      active: i % 3 !== 0,
    },
  });
}

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const time = (fn) => {
  const ts = [];
  let got = 0;

  for (let r = 0; r < ROUNDS; r += 1) {
    const t = performance.now();

    got = fn();
    ts.push(performance.now() - t);
  }

  return [med(ts), got];
};

const CAPS = [200, 1000, 2000, 5000, 20_000, 40_000];

const [ctrlMs, ctrlRows] = time(
  () => query(g, 'MATCH (p:Person) WHERE p.active = true RETURN count(*) AS c', {})[0].c,
);

console.log(`  N=${N}, matching rows=${ctrlRows}, median of ${ROUNDS}`);
console.log(`  control: same scan + predicate, count(*) only   ${ctrlMs.toFixed(2)} ms`);
console.log(`  heapBeatsSort crossover at cap = rows/16 = ${Math.floor(ctrlRows / 16)}`);
console.log(`    cap     total ms   minus control   ns per DELIVERED row   heap?`);

/*
 * **THE SAME SHAPE WITHOUT THE PREDICATE.** The filtered ladder came out FLAT across a 200x range of
 * `cap`, which says the heap is not paying — and the likeliest reason is not that the heap is bad but that
 * this shape never reaches it: a `WHERE` may route to a broader rung that never calls `topKPlan`. If the
 * UNFILTERED ladder IS cap-sensitive, the predicate is what declines top-K, and that is a findable gap.
 */
const [bareCtrlMs, bareRows] = time(
  () => query(g, 'MATCH (p:Person) RETURN count(*) AS c', {})[0].c,
);

console.log(`\n  UNFILTERED: rows=${bareRows}, control count(*) ${bareCtrlMs.toFixed(2)} ms`);
console.log(`    cap     total ms   minus control   heap?`);

for (const cap of CAPS) {
  const [ms] = time(
    // eslint-disable-next-line lenke/no-raw-interpolation -- the LIMIT LITERAL is the independent variable; a $param window takes a different route (item 1866), which would measure the wrong thing
    () => query(g, `MATCH (p:Person) RETURN p.name AS n ORDER BY n LIMIT ${cap}`, {}).length,
  );

  console.log(
    `    ${String(cap).padEnd(7)} ${ms.toFixed(2).padStart(8)} ${(ms - bareCtrlMs)
      .toFixed(2)
      .padStart(14)}   ${cap * 16 <= bareRows ? 'yes' : 'NO'}`,
  );
}

console.log('');

for (const cap of CAPS) {
  const [ms, rows] = time(
    () =>
      query(
        g,
        // eslint-disable-next-line lenke/no-raw-interpolation -- the LIMIT LITERAL is the independent variable; a $param window takes a different route (item 1866), which would measure the wrong thing
        `MATCH (p:Person) WHERE p.active = true RETURN p.name AS n ORDER BY n LIMIT ${cap}`,
        {},
      ).length,
  );
  const sortTerm = ms - ctrlMs;
  const admitted = cap * 16 <= ctrlRows ? 'yes' : 'NO';

  console.log(
    `    ${String(cap).padEnd(7)} ${ms.toFixed(2).padStart(8)} ${sortTerm
      .toFixed(2)
      .padStart(14)} ${((sortTerm * 1e6) / rows).toFixed(0).padStart(21)}   ${admitted}`,
  );
}
