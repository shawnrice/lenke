/**
 * ⚠️⚠️ **MY OWN CROSS-SURFACE "1.8x" WAS NOT APPLES-TO-APPLES (item 2273).** Item 2271 measured GQL at
 * 3,323 ns/statement and item 2272 Gremlin at 1,851 ns/call, and I read that as GQL being 1.8x slower per
 * statement. ⚠️ **The two arms did DIFFERENT WORK**: the GQL probe scanned 200 vertices and returned 200
 * rows; the Gremlin probe scanned 400 and returned ONE (a `count()`). A ratio across those is meaningless.
 *
 * 🔑 This makes them comparable: the SAME fixture, the SAME predicate, and the SAME single-row output on
 * both surfaces — so the only difference left is the per-statement machinery each surface carries.
 *
 *     gqlReuse    the same TEXT every call            — hits the parse cache (cap 512 since item 2271)
 *     gqlFresh    a VARYING literal, 500 distinct     — the realistic application shape
 *     gremReuse   ONE plan object, called many times
 *     gremFresh   a NEW traversal() per call
 *
 * ⚠️ Both surfaces are asserted to return the same count every call, so an arm cannot read fast by doing
 * less — the trap item 1682 names and item 2272's row-count guard caught in practice.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { V, count, gte, has, hasLabel, toArray, traversal, type Plan } from '@lenke/gremlin';

const N = Number(process.env.N ?? 400);
const CALLS = Number(process.env.CALLS ?? 2000);
const REPS = Number(process.env.REPS ?? 7);
const DISTINCT = Number(process.env.DISTINCT ?? 500);

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['T'], properties: { k: i % 97 } });
}

/* `k >= -(1+i)` matches every vertex for any i >= 0, so every arm counts N and the WORK is identical. */
const gqlText = (i: number): string =>
  `MATCH (n:T) WHERE n.k >= ${-1 - (i % DISTINCT)} RETURN count(*) AS c`;
const gremPlan = (i: number): Plan =>
  traversal(V(), hasLabel('T'), has('k', gte(-1 - (i % DISTINCT))), count());

const GQL_SAME = gqlText(0);
const GQL_TEXTS = Array.from({ length: CALLS }, (_, i) => gqlText(i));
const GREM_SAME = gremPlan(0);

const med = (xs: number[]): number => {
  const s = xs.slice().sort((a, b) => a - b);

  return s[Math.floor(s.length / 2)] ?? 0;
};

const run = (label: string, once: (i: number) => number): void => {
  const series: number[] = [];

  for (let r = 0; r < REPS; r += 1) {
    const t = performance.now();
    let total = 0;

    for (let i = 0; i < CALLS; i += 1) {
      total += once(i);
    }

    series.push(performance.now() - t);

    if (total !== CALLS * N) {
      throw new Error(`${label}: total ${total}, expected ${CALLS * N} — the arms differ in WORK`);
    }
  }

  const m = med(series.slice(2));

  console.log(
    `  ${label.padEnd(11)} ${m.toFixed(1).padStart(7)} ms   ${((m * 1e6) / CALLS).toFixed(0).padStart(7)} ns/statement`,
  );
};

console.log(`  N=${N} vertices, ${CALLS} statements/rep, median of ${REPS}, every arm counts N\n`);

run('gqlReuse', () => Number(query(g, GQL_SAME, {})[0]?.c));
run('gqlFresh', (i) => Number(query(g, GQL_TEXTS[i], {})[0]?.c));
run('gremReuse', () => Number(toArray(GREM_SAME, g)[0]));
run('gremFresh', (i) => Number(toArray(gremPlan(i), g)[0]));
