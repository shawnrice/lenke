/**
 * WHAT WOULD HOISTING THE PROPERTY BAG INTO ROW SCOPE BUY A WIDE PROJECTION? (item 1897)
 *
 * ⚠️ THIS IS THE MEASUREMENT `propOf`'s OWN NOTE ASKS FOR, verbatim. Item 1740 rejected a one-entry
 * MEMO of the last bound object's bag (flat on the target, and two unreachable CONTROLS got 3-10%
 * WORSE), and then said exactly what it had not settled:
 *
 * > ⚠️ WHAT THIS DOES **NOT** SETTLE. The arm is a CONFOUNDED ceiling, not a clean one: a safe
 * > version would hoist the bag into the projection's own row scope as a LOCAL, where no write can
 * > intervene and there is no module-variable traffic to pay. That remains unmeasured.
 *
 * ⚠️ AND IT NAMES THE INSTRUMENT'S OWN TRAP: "whoever measures it must not use `wideproj` at 300
 * runs: it spreads 18% there (144.9-171.9) and cannot resolve a 5% effect. At 1500 runs it reads
 * 652.8/615.3/617.5/622.7 — 1.3% once the warm-up run is dropped." So this file runs the inner query
 * `RUNS` times per rep (default 1500) and drops the first rep.
 *
 * ⚠️ IT WAS ALSO NOMINATED BY A PROFILE, which is why it is this tick's target rather than a list
 * item: item 1896's two-hop arms left 23 ms unexplained, and profiling the engine against an
 * engine-ish hand walk put **`propOf` at 10.6%** of the engine's samples with nothing matching it on
 * the hand side (plus 2x the GC). `propOf` is one closure call plus a `properties` getter plus an
 * index, per COLUMN per row.
 *
 * The arms, all returning the same rows:
 *
 *   engine     the shipped projection
 *   handCalls  five independent property reads, the shape the engine has: a getter per column
 *   handBag    the bag read ONCE into a local, then five indexes — the hoist in question
 *
 *     for a in engine handCalls handBag; do ARM=$a bun wideproj-bag-ceiling-1897.mjs; done
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 20_000);
const RUNS = Number(process.env.RUNS ?? 1500);
const REPS = Number(process.env.REPS ?? 5);
const ARM = process.env.ARM ?? 'engine';

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: `v${String(i)}`,
    labels: ['P'],
    properties: { a: i % 7, b: i % 11, c: i % 13, d: i % 17, e: `s${String(i % 5)}` },
  });
}

const TEXT = 'MATCH (n:P) RETURN n.a AS a, n.b AS b, n.c AS c, n.d AS d, n.e AS e';

const engine = () => query(g, TEXT).length;

/** The shape the engine has: one `properties` getter per COLUMN per row. */
const handCalls = () => {
  const rows = [];

  for (const n of g.verticesById.values()) {
    rows.push({
      a: n.properties.a ?? null,
      b: n.properties.b ?? null,
      c: n.properties.c ?? null,
      d: n.properties.d ?? null,
      e: n.properties.e ?? null,
    });
  }

  return rows.length;
};

/** The hoist: the bag read ONCE into a row-scope local, then five indexes. */
const handBag = () => {
  const rows = [];

  for (const n of g.verticesById.values()) {
    const bag = n.properties;

    rows.push({
      a: bag.a ?? null,
      b: bag.b ?? null,
      c: bag.c ?? null,
      d: bag.d ?? null,
      e: bag.e ?? null,
    });
  }

  return rows.length;
};

/**
 * The shape a SPECIALIZED projection could reach without codegen: the items as a small array of
 * `{ name, key }`, and one closure-free inner loop per row.
 *
 * ⚠️ IT IS HERE BECAUSE THE FIRST TWO ARMS SETTLED THE QUESTION THIS FILE WAS BUILT FOR and left a
 * bigger one open: the bag hoist is worth NOTHING (the `properties` getter is a memoized
 * private-field read, so five calls cost what one does), while the ENGINE is 3.1x the hand arm. So
 * the lever is not the getter — it is the per-item compiled-expression call.
 */
const SPEC = [
  { name: 'a', key: 'a' },
  { name: 'b', key: 'b' },
  { name: 'c', key: 'c' },
  { name: 'd', key: 'd' },
  { name: 'e', key: 'e' },
];

const handSpec = () => {
  const rows = [];

  for (const n of g.verticesById.values()) {
    const bag = n.properties;
    const row = {};

    for (const item of SPEC) {
      row[item.name] = bag[item.key] ?? null;
    }

    rows.push(row);
  }

  return rows.length;
};

/**
 * The TEMPLATE trick: one object per query with every key present, cloned per row, then filled by
 * the same `{ name, key }` loop.
 *
 * ⚠️ IT IS HERE BECAUSE `handSpec` SAID THE COST IS THE OBJECT SHAPE, NOT THE READS: a computed-key
 * store into a fresh `{}` transitions the hidden class per key per row, where a store into an object
 * that ALREADY has the key is an in-place write. `hop-projection.ts`'s own comment names the
 * problem ("`row[keys[c]] = …` builds each row through computed-key stores, which cannot reuse it")
 * and uses a template for exactly this reason; item 1895 then measured the SPREAD at 1.42x worse
 * than a literal. This arm asks whether template-plus-fill beats fresh-plus-fill.
 */
const TEMPLATE = { a: null, b: null, c: null, d: null, e: null };

const handTemplate = () => {
  const rows = [];

  for (const n of g.verticesById.values()) {
    const bag = n.properties;
    const row = { ...TEMPLATE };

    for (const item of SPEC) {
      row[item.name] = bag[item.key] ?? null;
    }

    rows.push(row);
  }

  return rows.length;
};

const ARMS = { engine, handCalls, handBag, handSpec, handTemplate };
const arm = ARMS[ARM];
const series = [];
let rows = 0;

for (let r = 0; r < REPS + 1; r += 1) {
  const t0 = performance.now();

  for (let i = 0; i < RUNS; i += 1) {
    rows = arm();
  }

  const ms = performance.now() - t0;

  // ⚠️ THE FIRST REP IS DROPPED, not averaged in: `propOf`'s note records that the warm-up run is
  // what takes the spread from 1.3% to something that cannot resolve a 5% effect.
  if (r >= 1) {
    series.push(ms);
  }
}

series.sort((a, b) => a - b);

console.log(
  `${ARM.padEnd(10)} ${series[series.length >> 1].toFixed(1).padStart(8)} ms over ${String(RUNS)} runs  ` +
    `${String(rows).padStart(6)} rows   series ${series.map((x) => x.toFixed(0)).join('/')}`,
);
