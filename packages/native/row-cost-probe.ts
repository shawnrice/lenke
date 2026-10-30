// WHERE DOES THE TS ENGINE'S PER-ROW COST GO? (item 1294)
//
//   bun run row-cost
//
// Items 1221 and 1276 both attributed the big TS/Rust ratios to a per-row CONSTANT FACTOR — "TS is
// FLAT across a 22x selectivity change, so it scales with NODES: ~19ns per vertex against Rust's
// ~0.5ns" — and neither decomposed it. This does, by adding one layer at a time.
//
// 200,000 vertices, median of warm reps of 14:
//
//     1. Map iteration only                  1.50 ns/v
//     2. + label test (v.labels.has)        24.29        <- the most expensive single operation
//     3. + property read                    11.76
//     4. + property read by VARIABLE key    10.68
//     5. + matches() on that value          10.98
//
// That accounts for `V().has(age,gt).count()` exactly: 2.6ms at 200,000 vertices is 13 ns/v, which
// is 1.5 iteration + ~10 property read + ~1 predicate.
//
// ⚠️ THE PROPERTY READ IS A POINTER CHASE, NOT A SLOW OBJECT. The bag itself is fast; what costs is
// reaching it through `vertex -> box -> bag`, three heap objects per vertex:
//
//     plain object literal, array-held             1.60 ns/v
//     engine `v.properties`, array-held            7.38
//     engine `.properties` HOISTED into an array   1.53   <- the bag is as fast as a literal
//
// So ~5.8 ns a vertex is the indirection. That indirection is the DELIBERATE box design
// (`Graph.elementProperties`, audit items 162/321) — a stable box is what lets a re-write stay off
// the map and what keeps a detached element's throw — so removing it is a storage-layout decision
// and not a micro-fix.
//
// ⚠️ TWO OBVIOUS LEVERS, BOTH REFUTED HERE WITH NUMBERS, so they are not re-derived:
//
// 1. COMPILE `matches()` INTO A CLOSURE, hoisting its 20-way switch on `pred.op` out of the
//    per-value loop. This is the substitution items 1224/1225/1227/1231 made in Rust for 5.28x,
//    1.08x, 5.31x and 8.65-17.6x. Measured on 200,000 values: `matches(pred, v)` 1.11 ns,
//    a monomorphic closure 0.83, the bare loop 0.61. So it halves the dispatch and the dispatch is
//    1.11 of the query's 13 ns — about 2%. Not worth the carrier.
//
// 2. REORDER `get properties` to put the cached-box path first (one check and one hop instead of
//    four checks and two). Mocked both shapes over 200,000 instances, three runs: current
//    6.44/9.22/6.85, reordered 6.54/8.35/6.22 — FLAT, with the rounds disagreeing on the sign.
//    `Vertex.ts` already records the same outcome for bypassing the `id` getter, with the reason:
//    "JSC inlines a getter whose whole body is a private-field read." The branches are not the
//    cost; the pointer chase is.
//
// So the TS constant factor is ~45% indirection, ~8% predicate dispatch and the rest iteration and
// the `Set<string>.has` label probe. The two cheap levers are spent; what is left is layout.

import { Graph } from '@lenke/core';
import { gt, matches } from '@lenke/gremlin';

const N = Number(process.env.PRED_N ?? 200_000);
const g = new Graph();

for (let i = 0; i < N; i++) {
  g.addVertex({ id: `v${i}`, labels: ['Person'], properties: { age: i % 90, name: `n${i}` } });
}

const pred = gt(44);
const time = (label: string, run: () => number): void => {
  const series: number[] = [];
  let n = 0;

  for (let r = 0; r < 14; r++) {
    const t = performance.now();

    n = run();
    series.push(performance.now() - t);
  }

  const warm = series.slice(3).sort((a, b) => a - b);
  const med = warm[Math.floor(warm.length / 2)] ?? 0;

  console.log(
    `  ${label.padEnd(38)} med=${med.toFixed(3)}ms  ns/v=${((med * 1e6) / N).toFixed(2)}  n=${n}`,
  );
};

console.log(`\n# ${N} vertices, median of warm reps of 14\n`);
time('1. Map iteration only', () => {
  let n = 0;

  for (const v of g.verticesById.values()) {
    if (v !== undefined) {
      n++;
    }
  }

  return n;
});
time('2. + label test (v.labels.has)', () => {
  let n = 0;

  for (const v of g.verticesById.values()) {
    if (v.labels.has('Person')) {
      n++;
    }
  }

  return n;
});
time('3. + property read', () => {
  let n = 0;

  for (const v of g.verticesById.values()) {
    if (v.properties.age !== undefined) {
      n++;
    }
  }

  return n;
});
time('4. + property read by VARIABLE key', () => {
  const k = 'age';
  let n = 0;

  for (const v of g.verticesById.values()) {
    if (v.properties[k] !== undefined) {
      n++;
    }
  }

  return n;
});
time('5. + matches() on that value', () => {
  const k = 'age';
  let n = 0;

  for (const v of g.verticesById.values()) {
    if (matches(pred, v.properties[k])) {
      n++;
    }
  }

  return n;
});
