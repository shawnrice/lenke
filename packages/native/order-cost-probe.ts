/**
 * Item 878: where do the 507 ms of a TS `values(age).order()` go?
 *
 * `bun run bench:gremlin` has two rows with the largest ABSOLUTE numbers in the TS column, and
 * they are a pair:
 *
 *   V().out().values(age)          ts 166.8 ms   native 30.57   5.5x
 *   V().out().values(age).order()  ts 507.2      native 77.60   6.5x
 *
 * So `.order()` adds ~340 ms to produce 1,000,000 sorted numbers. A bare
 * `Array.prototype.sort` over a million numbers is the floor that has to be beaten or accepted,
 * and nothing here has measured it — so the 340 could be the sort itself, the comparator, or the
 * boxing around it, and those have very different fixes.
 *
 * The arms separate them, all on the same 1,000,000 values:
 *   rawSort        — a plain JS number array, default sort (lexicographic! the floor, not a peer)
 *   rawSortNum     — the same with a numeric comparator: the honest floor for "sort 1M numbers"
 *   rawSortTotal   — with the engine's own total-order comparator, so NaN handling is included
 *   engineValues   — the traversal WITHOUT order(), i.e. what the pipeline costs by itself
 *   engineOrdered  — the traversal WITH order(): the row being explained
 *
 * `engineOrdered - engineValues` is what `.order()` adds; `rawSortNum` is what it could cost at
 * best. If those two are close the row is at its floor and the target is the pipeline instead.
 */
import { Graph } from '@lenke/core';
import { count, order, out, toArray, traversal, V, values } from '@lenke/gremlin';

const N = Number(process.env.A_N ?? 200_000);
const DEG = Number(process.env.A_DEG ?? 5);
const REPS = 9;
const DROP = 2;

const g = new Graph();
const verts: unknown[] = [];

for (let i = 0; i < N; i += 1) {
  verts.push(g.addVertex({ id: `v${i}`, labels: ['Person'], properties: { age: i % 90 } }));
}

for (let k = 0; k < N * DEG; k += 1) {
  g.addEdge({
    id: `e${k}`,
    labels: ['KNOWS'],
    from: verts[(k * 7919) % N] as never,
    to: verts[(k * 104_729) % N] as never,
    properties: {},
  });
}

// The value sequence the traversal produces, materialized once so the raw-sort arms measure
// sorting and nothing else.
const raw: number[] = [];

for (let k = 0; k < N * DEG; k += 1) {
  raw.push(((k * 104_729) % N) % 90);
}

const cmpNum = (a: number, b: number): number => a - b;
// The engine's total order: NaN last and NaN == NaN, which is what byte-identity requires.
const cmpTotal = (a: number, b: number): number => {
  const an = Number.isNaN(a);
  const bn = Number.isNaN(b);

  if (an && bn) {
    return 0;
  }

  if (an) {
    return 1; // NaN last
  }

  if (bn) {
    return -1;
  }

  if (a < b) {
    return -1;
  }

  return a > b ? 1 : 0;
};

const ARMS: Record<string, () => number> = {
  // The DEFAULT sort, deliberately: it compares numbers as STRINGS, so it is a lower bound on
  // "what does V8 charge to move a million elements" rather than a peer of the arms below. The
  // lint rule asking for a comparator is right in general and wrong for this one arm.
  // eslint-disable-next-line typescript/require-array-sort-compare
  rawSort: () => [...raw].sort().length,
  rawSortNum: () => [...raw].sort(cmpNum).length,
  rawSortTotal: () => [...raw].sort(cmpTotal).length,
  copyOnly: () => [...raw].length,
  engineValues: () => toArray(traversal(V(), out('KNOWS'), values('age')), g).length,
  engineOrdered: () => toArray(traversal(V(), out('KNOWS'), values('age'), order()), g).length,
  engineCount: () => toArray(traversal(V(), out('KNOWS'), count()), g).length,
};

const arm = process.env.A_ARM ?? 'rawSortNum';
const fn = ARMS[arm];

if (fn === undefined) {
  throw new Error(`unknown A_ARM ${arm}; have ${Object.keys(ARMS).join(',')}`);
}

const series: number[] = [];
let sink = 0;

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();

  sink += fn();
  series.push(performance.now() - t0);
}

const plateau = series.slice(DROP).sort(cmpNum);
const median = plateau[Math.floor(plateau.length / 2)];

console.log(`${arm.padEnd(14)} ${median.toFixed(2).padStart(9)} ms  n=${sink > 0 ? 'ok' : 'ZERO'}`);
