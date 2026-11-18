/**
 * ⚠️⚠️⚠️ **ITEM 2260's "PURE KEY-TYPE EFFECT" IS CONFOUNDED BY CARDINALITY, AND THIS SEPARATES THEM
 * (item 2261).**
 *
 * Item 2260 measured, at a fixed `hopProjection` route, a STRING `ORDER BY` key at 344 ns/row against a
 * NUMERIC one at 197, and called the ~147 ns difference a key-TYPE effect. ⚠️ But the fixture's string
 * property had **9973 distinct values** and its numeric one **97** — so the two sorts differ in TIE DENSITY
 * as well as in type, and a sort's comparison count depends on both.
 *
 * 🔑 **A 2x2 SETTLES IT.** Four properties, each on the same vertices and read through the same route:
 *
 *     nameHi   string, 9973 distinct       kHi   number, 9973 distinct
 *     nameLo   string,   97 distinct       kLo   number,   97 distinct
 *
 * - If **type** is the cause, `nameHi` ≈ `nameLo` > `kHi` ≈ `kLo`.
 * - If **cardinality** is the cause, `nameHi` ≈ `kHi` and `nameLo` ≈ `kLo`.
 * - If both matter, the four separate — and the 2x2 gives each term its own size.
 *
 * ⚠️ Item 2260's own lesson applies: the route is read, not assumed. All four arms are the same query shape
 * with only the key property changed, so `compileLinear` cannot route them differently — but the unsorted
 * control is printed too, because a term that moves it is not the sort's.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 50000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const REPS = Number(process.env.REPS ?? 7);
const HI = 9973;
const LO = 97;

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: `v${i}`,
    labels: ['Person'],
    properties: {
      /* ⚠️ The SAME underlying index drives all four, so the orderings correspond exactly. */
      nameHi: `n${i % HI}`,
      nameLo: `n${i % LO}`,
      kHi: i % HI,
      kLo: i % LO,
    },
  });
}

let e = 0;

for (let d = 0; d < FANOUT; d += 1) {
  for (let i = 0; i < N; i += 1) {
    g.addEdge({
      id: `e${e++}`,
      from: g.getVertexById(`v${i}`)!,
      to: g.getVertexById(`v${(i * 7 + 3 + d * 104_729) % N}`)!,
      labels: ['KNOWS'],
      properties: {},
    });
  }
}

const ARMS: Array<[string, string]> = [
  ['unsorted (control)', 'MATCH (a:Person)-[:KNOWS]->(x) RETURN x.nameHi AS n'],
  ['string  9973 distinct', 'MATCH (a:Person)-[:KNOWS]->(x) RETURN x.nameHi AS n ORDER BY n'],
  ['string    97 distinct', 'MATCH (a:Person)-[:KNOWS]->(x) RETURN x.nameLo AS n ORDER BY n'],
  ['number  9973 distinct', 'MATCH (a:Person)-[:KNOWS]->(x) RETURN x.kHi AS n ORDER BY n'],
  ['number    97 distinct', 'MATCH (a:Person)-[:KNOWS]->(x) RETURN x.kLo AS n ORDER BY n'],
];

const med = (xs: number[]): number => {
  const s = xs.slice().sort((a, b) => a - b);

  return s[Math.floor(s.length / 2)] ?? 0;
};

console.log(`  N=${N} vertices, ${N * FANOUT} edges, REPS=${REPS}\n`);
console.log(`  ${'arm'.padEnd(23)} ${'median'.padStart(9)} ${'ns/row'.padStart(8)}  rows`);

const got = new Map<string, number>();

for (const [name, text] of ARMS) {
  const series: number[] = [];
  let rows = 0;

  for (let r = 0; r < REPS; r += 1) {
    const t = performance.now();
    const n = query(g, text, {}).length;

    series.push(performance.now() - t);
    rows = n;
  }

  const m = med(series.slice(2));

  got.set(name, (m * 1e6) / Math.max(rows, 1));
  console.log(
    `  ${name.padEnd(23)} ${m.toFixed(1).padStart(9)} ${((m * 1e6) / Math.max(rows, 1)).toFixed(0).padStart(8)}  ${rows}`,
  );
}

const sHi = got.get('string  9973 distinct') ?? 0;
const sLo = got.get('string    97 distinct') ?? 0;
const nHi = got.get('number  9973 distinct') ?? 0;
const nLo = got.get('number    97 distinct') ?? 0;

console.log(
  `\n  TYPE effect at HIGH cardinality: ${(sHi - nHi).toFixed(0)} ns/row   at LOW: ${(sLo - nLo).toFixed(0)}`,
);
console.log(
  `  CARDINALITY effect for strings : ${(sHi - sLo).toFixed(0)} ns/row   for numbers: ${(nHi - nLo).toFixed(0)}`,
);

/*
 * 🔑🔑 **AND THE FLOOR: IS THE TYPE EFFECT INTRINSIC TO COMPARING STRINGS?** ~141-166 ns/row over
 * 150,000 rows is ~8.8 ns per comparison (N log2 N ~= 2.55M), which is the right order for a JS string
 * compare against a numeric one. ⚠️ A ratio without a floor is an upper bound (this session's own rule), so
 * the same arrays are sorted by `Array.prototype.sort` with nothing else in the way. **If the floor shows
 * the same type gap, the engine's sort is at it and there is nothing to win.**
 */
const ROWS = N * FANOUT;
const strs = Array.from({ length: ROWS }, (_, i) => `n${i % HI}`);
const nums = Array.from({ length: ROWS }, (_, i) => i % HI);

const floorOf = (make: () => unknown[]): number => {
  const series: number[] = [];

  for (let r = 0; r < REPS; r += 1) {
    const arr = make();
    const t = performance.now();

    /* The engine's comparator is total and type-aware; a bare `<` is the cheapest possible stand-in. */
    arr.sort((x, y) => {
      if (x === y) {
        return 0;
      }

      return (x as never) < (y as never) ? -1 : 1;
    });
    series.push(performance.now() - t);

    if (arr.length !== ROWS) {
      throw new Error('floor lost rows');
    }
  }

  return (med(series.slice(2)) * 1e6) / ROWS;
};

const fs = floorOf(() => strs.slice());
const fn = floorOf(() => nums.slice());

console.log(
  `\n  FLOOR (Array.sort only)  string ${fs.toFixed(0)} ns/row   number ${fn.toFixed(0)}   type effect ${(fs - fn).toFixed(0)}`,
);
console.log(
  `  ENGINE sort-attributable  string ${(sHi - 26).toFixed(0)} ns/row   number ${(nHi - 26).toFixed(0)}   vs floor ${((sHi - 26) / Math.max(fs, 1e-9)).toFixed(2)}x / ${((nHi - 26) / Math.max(fn, 1e-9)).toFixed(2)}x`,
);
