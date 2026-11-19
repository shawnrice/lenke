/**
 * ✅✅ **DOES ITEM 2339's SHARING PENALTY REACH THE RUNGS I SHIPPED? (item 2340)**
 *
 * Item 2339 found a second GQL scan-family query costs `hopGql` 1.06-1.14x, by shared-rung polymorphism —
 * and that Gremlin's hop is largely immune because item 2333's `pick` closure is built PER PLAN.
 *
 * 🔑 Items 2320/2321/2322 shipped five Gremlin `drain` conversions, all measured ONE SHAPE PER PROCESS.
 * **If those drains degrade when two shapes share them, the shipped wins are partly offset in a real
 * workload** — which the isolated measurements cannot see.
 *
 * ⚠️ **AND ITEM 2320's DESIGN MAKES A PREDICTION WORTH TESTING AGAINST ITSELF.** It deliberately wrote
 * THREE SIBLING drains — `walkIds`, `walkLabels`, `walkValues` — rather than one with a branch, because
 * item 159 measured an inner-loop branch at 1.6x. ✅ So:
 *
 *   - `values(k)` paired with `id()` or `label()` uses a DIFFERENT sibling drain -> should be mild
 *   - `values(k)` paired with `values(j)` uses the SAME drain with a different key -> the exposed case
 *
 * ✅ If the same-drain pairing is the only one that hurts, the sibling design is doing exactly its job and
 * the only exposure is two value-projections of different keys — which is worth knowing precisely.
 */
import { Graph } from '@lenke/core';
import { V, hasLabel, id, label, toArray, traversal, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 50_000);
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 60);
const REPS = Number(process.env.REPS ?? 9);
const WITH = process.env.WITH ?? '';

const graph = new Graph();

for (let i = 0; i < NODES; i += 1) {
  graph.addVertex({
    id: `v${i}`,
    labels: ['N'],
    properties: { k: i % 97, j: i % 89 },
  });
}

/* ✅ All hoisted, per item 2325's 3.96x. */
const SHAPES = {
  /* 🔑 THE TARGET: the rung item 2320 shipped at 3.86x. */
  valuesK: () => toArray(traversal(V(), hasLabel('N'), values('k')), graph).length,
  /* ⚠️ THE EXPOSED PAIRING: the SAME `walkValues` drain, a different key. */
  valuesJ: () => toArray(traversal(V(), hasLabel('N'), values('j')), graph).length,
  /* ✅ A DIFFERENT sibling drain — item 2320's `walkIds`. */
  ids: () => toArray(traversal(V(), hasLabel('N'), id()), graph).length,
  /* ✅ The third sibling — `walkLabels`. */
  labels: () => toArray(traversal(V(), hasLabel('N'), label()), graph).length,
};

/*
 * ⚠️ HOISTING THE PLANS, NOT THE CLOSURES: each entry rebuilds its `traversal(...)` per call above, which
 * would measure plan construction (item 2325's 3.96x). ✅ Fixed by building each plan ONCE here and
 * re-binding the arms to it.
 */
const plans = {
  valuesK: traversal(V(), hasLabel('N'), values('k')),
  valuesJ: traversal(V(), hasLabel('N'), values('j')),
  ids: traversal(V(), hasLabel('N'), id()),
  labels: traversal(V(), hasLabel('N'), label()),
};

for (const n of Object.keys(SHAPES)) {
  SHAPES[n] = () => toArray(plans[n], graph).length;
}

for (const n of Object.keys(SHAPES)) {
  for (let w = 0; w < 10; w += 1) {
    SHAPES[n]();
  }
}

const inners = {};

for (const n of Object.keys(SHAPES)) {
  let inner = 1;

  for (;;) {
    const t0 = performance.now();

    for (let i = 0; i < inner; i += 1) {
      SHAPES[n]();
    }

    if (performance.now() - t0 >= SAMPLE_MS || inner >= 100_000) {
      break;
    }

    inner *= 2;
  }

  inners[n] = inner;
}

const timeOne = (n) => {
  const fn = SHAPES[n];
  const inner = inners[n];
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    fn();
  }

  return (performance.now() - t0) / inner;
};

const names = WITH === '' ? ['valuesK'] : ['valuesK', WITH];
const acc = [];

for (let r = 0; r < REPS; r += 1) {
  for (const n of names) {
    const t = timeOne(n);

    if (n === 'valuesK') {
      acc.push(t);
    }
  }
}

const med = [...acc].sort((a, b) => a - b)[Math.floor(acc.length / 2)];

console.log(
  `  WITH=${(WITH === '' ? '(alone)' : WITH).padEnd(9)} valuesK ${(med * 1000).toFixed(1).padStart(8)} us  inner=${String(inners.valuesK).padStart(5)}  rows=${SHAPES.valuesK()}`,
);
