/**
 * Item 899: WHERE do the ~50 ns a row go that make a TS nested read 3.4x a flat one?
 *
 * Items 897 and 898 measured the gap (15.3 ms against 4.99 over 200,000 rows) and item 898 ruled
 * out `recordGet`, the record lookup itself, by refuting a one-probe version of it at 0.96x. The
 * remaining candidates were `propOf`'s `?.properties?.[key]` chain, the extra closure dispatch for
 * the nested `'field'` arm, and whatever `addVertex` does to normalize a nested object into a
 * `LenkeRecord`.
 *
 * THIS LADDER USES ONLY QUERIES. No engine code is modified and no arm is deliberately wrong —
 * each rung reads one stage more than the rung below it, so the differences are the stages:
 *
 *   scalarProp    `p.tier = 'NYC'`        read a flat scalar property, compare it
 *   recordProp    `p.meta = 'NYC'`        read a RECORD-valued property, compare it. Same read
 *                                         machinery, same comparison shape, NO field step. Matches
 *                                         nothing (a record never equals a string) — which is the
 *                                         point: the per-row work happened anyway.
 *   nestedField   `p.meta.other = 'NYC'`  the same record read PLUS the field projection
 *
 *   recordProp - scalarProp  = what reading a RECORD-valued property costs over a scalar one
 *   nestedField - recordProp = what the field step costs
 *
 * A fourth rung, `scalarPropNull` (`p.nosuch = 'NYC'`), is the control for the zero-match shape:
 * `recordProp` also matches nothing, so if matching nothing is itself cheap or expensive that must
 * not be read as a record cost.
 *
 * Every arm asserts its OWN expected row count, because two of them legitimately match zero and a
 * zero-row arm is otherwise indistinguishable from a broken fixture (item 897 lost a 200,000-node
 * graph to a silent `${...}` expansion and only the count caught it).
 *
 * ONE PROCESS, ONE GRAPH — item 897's rule: the arms must share a heap, because the graph carries
 * both flat and nested copies of the value and building it is most of the allocation.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.A_N ?? 200_000);
const REPS = 9;
const ROUNDS = 3;
const CITIES = ['NYC', 'LDN', 'TYO', 'BER'];
const MATCHING = Math.floor(N / CITIES.length);

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  const city = CITIES[i % CITIES.length];

  g.addVertex({
    id: `v${i}`,
    labels: ['P'],
    properties: { tier: city, meta: { other: city, pad: city } },
  });
}

// [label, query, expected count]
const CASES: ReadonlyArray<readonly [string, string, number]> = [
  ['scalarProp', "MATCH (p:P) WHERE p.tier = 'NYC' RETURN count(*) AS c", MATCHING],
  ['recordProp', "MATCH (p:P) WHERE p.meta = 'NYC' RETURN count(*) AS c", 0],
  ['nestedField', "MATCH (p:P) WHERE p.meta.other = 'NYC' RETURN count(*) AS c", MATCHING],
  ['scalarPropNull', "MATCH (p:P) WHERE p.nosuch = 'NYC' RETURN count(*) AS c", 0],
];

const best: Record<string, number[]> = {};

for (let round = 0; round < ROUNDS; round += 1) {
  const order = round % 2 === 1 ? [...CASES].reverse() : CASES;

  for (const [name, q, expect] of order) {
    const series: number[] = [];

    for (let r = 0; r < REPS; r += 1) {
      const t0 = performance.now();
      const rows = [...query(g, q)];

      series.push(performance.now() - t0);

      const c = Number((rows[0] as Record<string, unknown>)?.c ?? -1);

      if (c !== expect) {
        throw new Error(`FIXTURE/QUERY WRONG for ${name}: count=${c}, expected ${expect}`);
      }
    }

    series.sort((a, b) => a - b);
    (best[name] ??= []).push(series[0]);
  }
}

const ms = (k: string): number => Math.min(...best[k]);
const perRow = (x: number): string => ((x * 1e6) / N).toFixed(1);

console.log(
  `# item 899 — the TS nested read, by stage (N=${N}, min of ${ROUNDS} alternated rounds)\n`,
);

for (const [name, , expect] of CASES) {
  console.log(
    `${name.padEnd(16)} ${ms(name).toFixed(2).padStart(7)} ms  ${perRow(ms(name)).padStart(6)} ns/row  (c=${expect})  rounds: ${best[name].map((x) => x.toFixed(2)).join(' ')}`,
  );
}

console.log('\nSTAGES:');
console.log(
  `  reading a RECORD-valued property over a scalar one   ${(ms('recordProp') - ms('scalarProp')).toFixed(2).padStart(7)} ms  ${perRow(ms('recordProp') - ms('scalarProp')).padStart(6)} ns/row`,
);
console.log(
  `  the FIELD step on top of that read                   ${(ms('nestedField') - ms('recordProp')).toFixed(2).padStart(7)} ms  ${perRow(ms('nestedField') - ms('recordProp')).padStart(6)} ns/row`,
);
console.log(
  `  total nested over flat                               ${(ms('nestedField') - ms('scalarProp')).toFixed(2).padStart(7)} ms  ${perRow(ms('nestedField') - ms('scalarProp')).padStart(6)} ns/row`,
);
console.log(
  `  CONTROL, a zero-match scalar vs a matching one       ${(ms('scalarPropNull') - ms('scalarProp')).toFixed(2).padStart(7)} ms  (so "matches nothing" is not what recordProp measures)`,
);

// ---------------------------------------------------------------------------------------------
// WHAT IS INSIDE THE FIELD STEP? Two candidate causes, both priced here rather than argued.
//
// `LenkeRecord extends Map`, and a SUBCLASSED Map can lose an engine's Map fast path — a real JS
// engine behaviour and the obvious suspect. It is not the cause. What IS large is Map-versus-plain
// -object: a `Map.get` costs ~6.8x a plain property read, which prices the representation choice.
//
// Varying keys and a live sink, because a constant-input micro-benchmark folds away and measures
// nothing (item 889 timed `'score'.toLowerCase()` at 0.27 ns for exactly that reason).
class SubMap extends Map<string, unknown> {}

const MK = ['other', 'pad'];
const plainMaps: Array<Map<string, unknown>> = [];
const subMaps: Array<SubMap> = [];
const plainObjs: Array<Record<string, string>> = [];

for (let i = 0; i < N; i += 1) {
  const entries: Array<[string, unknown]> = [
    ['other', `v${i % 4}`],
    ['pad', 'p'],
  ];

  plainMaps.push(new Map(entries));
  subMaps.push(new SubMap(entries));
  plainObjs.push({ other: `v${i % 4}`, pad: 'p' });
}

const MICRO: Record<string, () => number> = {
  'plain Map.get': () => {
    let sink = 0;

    for (let i = 0; i < N; i += 1) {
      sink += String(plainMaps[i].get(MK[i & 1])).length;
    }

    return sink;
  },
  'Map SUBCLASS .get': () => {
    let sink = 0;

    for (let i = 0; i < N; i += 1) {
      sink += String(subMaps[i].get(MK[i & 1])).length;
    }

    return sink;
  },
  'plain object [k]': () => {
    let sink = 0;

    for (let i = 0; i < N; i += 1) {
      sink += plainObjs[i][MK[i & 1]].length;
    }

    return sink;
  },
  'subclass has+get': () => {
    let sink = 0;

    for (let i = 0; i < N; i += 1) {
      const k = MK[i & 1];

      sink += subMaps[i].has(k) ? String(subMaps[i].get(k)).length : 0;
    }

    return sink;
  },
};

const microBest: Record<string, number> = {};

for (let round = 0; round < ROUNDS; round += 1) {
  for (const [name, fn] of Object.entries(MICRO)) {
    let b = Infinity;

    for (let r = 0; r < REPS; r += 1) {
      const t0 = performance.now();
      const sink = fn();
      const d = performance.now() - t0;

      if (sink === 0) {
        throw new Error(`micro arm ${name} did nothing`);
      }

      b = Math.min(b, d);
    }

    microBest[name] = microBest[name] === undefined ? b : Math.min(microBest[name], b);
  }
}

console.log('\nINSIDE THE FIELD STEP — a record read, by representation:');

for (const [name, v] of Object.entries(microBest)) {
  console.log(
    `  ${name.padEnd(20)} ${v.toFixed(2).padStart(7)} ms  ${perRow(v).padStart(6)} ns/read`,
  );
}
