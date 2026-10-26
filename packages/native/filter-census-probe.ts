/**
 * Item 873: what does a filtered count cost in the TS engine, by value TYPE and by SPELLING?
 *
 * The TS twin of `examples/filtercensus_871.rs`. Items 871 and 872 censused the native filter
 * family by column representation and found two gaps worth 11.2x and 4.51x — a temporal predicate
 * boxing a value per row, and a bare property in boolean context with no typed path. Item 843's
 * rule says whether the TS engine shares either is a MEASUREMENT: the two engines have landed on
 * the same gap from different causes (843), in mirrored directions (868), and in only one of them
 * (870), so neither "it will be there" nor "it cannot be" is worth acting on.
 *
 * The TS engine stores properties per element rather than in typed columns, so the native framing
 * (which REPRESENTATION has a path) does not translate. What does translate is the pair of
 * questions underneath it:
 *
 *   1. Does any value type cost conspicuously more per row than the others?
 *   2. Do equivalent SPELLINGS of one predicate agree? `p.b`, `p.b = true` and `NOT p.b` are one
 *      question written three ways, and natively they spanned 6.6x.
 *
 * Two controls, as item 871 established: `count(*)` reads no property (the floor) and `WHERE true`
 * runs the filter machinery over every row while keeping them all — so agreement with `WHERE true`
 * means the predicate is free and the cost is the scan, and divergence means the predicate is the
 * cost. One shape per process, selected by `A_SHAPE`.
 */
import { Graph, parseDate } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.A_N ?? 200_000);
const REPS = 14;
const DROP = 3;

const SHAPES: Record<string, string> = {
  floor: 'MATCH (p:P) RETURN count(*) AS c',
  whereTrue: 'MATCH (p:P) WHERE true RETURN count(*) AS c',
  numEq: 'MATCH (p:P) WHERE p.num = 7 RETURN count(*) AS c',
  numGt: 'MATCH (p:P) WHERE p.num > 25 RETURN count(*) AS c',
  strEq: "MATCH (p:P) WHERE p.str = 's00007' RETURN count(*) AS c",
  lowEq: "MATCH (p:P) WHERE p.low = 'd7' RETURN count(*) AS c",
  boolEq: 'MATCH (p:P) WHERE p.bul = true RETURN count(*) AS c',
  boolBare: 'MATCH (p:P) WHERE p.bul RETURN count(*) AS c',
  boolNot: 'MATCH (p:P) WHERE NOT p.bul RETURN count(*) AS c',
  boolEqFalse: 'MATCH (p:P) WHERE p.bul = false RETURN count(*) AS c',
  dateEq: "MATCH (p:P) WHERE p.dat = DATE '2024-01-08' RETURN count(*) AS c",
  dateGe: "MATCH (p:P) WHERE p.dat >= DATE '2024-01-08' RETURN count(*) AS c",
  dateNotNull: 'MATCH (p:P) WHERE p.dat IS NOT NULL RETURN count(*) AS c',
  // THE DISCRIMINATOR for the bare-bool gap: is it the count SHORTCUT recognizing an equality
  // and not a bare property, or the predicate evaluation itself? These project a value instead of
  // counting, so no count shortcut can apply to either. If the gap persists the predicate is the
  // cause; if it vanishes the shortcut is.
  boolBareProj: 'MATCH (p:P) WHERE p.bul RETURN p.num AS x',
  boolEqProj: 'MATCH (p:P) WHERE p.bul = true RETURN p.num AS x',
};

const shape = process.env.A_SHAPE ?? 'floor';
const q = SHAPES[shape];

if (q === undefined) {
  throw new Error(`unknown A_SHAPE ${shape}; have ${Object.keys(SHAPES).join(',')}`);
}

const g = new Graph();
const pad = (x: number): string => String(x).padStart(2, '0');

for (let i = 0; i < N; i += 1) {
  const m = i % 50;

  g.addVertex({
    id: `v${i}`,
    labels: ['P'],
    properties: {
      num: m,
      // 8,000 distinct, the high-cardinality string
      str: `s${String(i % 8_000).padStart(5, '0')}`,
      // 50 distinct, the low-cardinality string (a dictionary column natively)
      low: `d${m}`,
      bul: m === 7,
      // 50 distinct dates, same ordinal as `num`. A real TEMPORAL value, not its ISO string:
      // a string here compares against a `DATE` literal as CROSS-TYPE, which is a documented
      // no-match, and the first version of this probe reported 0 rows for every date shape
      // because of exactly that. The row count is printed so the next such mistake is visible.
      dat: parseDate(`2024-01-${pad((m % 28) + 1)}`),
    },
  });
}

const series: number[] = [];
let rows = 0;

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();
  const out = [...query(g, q)];

  series.push(performance.now() - t0);
  const first = out[0] as Record<string, unknown> | undefined;

  rows = first?.c !== undefined ? Number(first.c) : out.length;
}

const plateau = series.slice(DROP).sort((a, b) => a - b);
const median = plateau[Math.floor(plateau.length / 2)];

console.log(
  `${shape.padEnd(12)} ${median.toFixed(3).padStart(9)} ms  ${String(rows).padStart(7)} rows`,
);
