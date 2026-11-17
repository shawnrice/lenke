/*
 * Item 2115 — is the bag's ~110 ms really the PUSHES? Item 2114 said so and the arithmetic says no.
 *
 * ⚠️⚠️ **CHECKING MY OWN CONCLUSION.** Item 2114 measured `hop + values` at 28 ms and
 * `hop + store + values` at 139, and concluded "the BAG is the cost ... ~110 ms to push 600,000 vertex
 * objects into an array, which no fusion removes". 🔑 **110 ms / 600,000 = 185 ns per push.** An array
 * push is single-digit nanoseconds. So either the push is not the cost, or something about THIS push is
 * extraordinary — and that entry asserted the first reading without checking the division.
 *
 * 🔑 FOUR CANDIDATES, each its own arm, all on 600,000 of the ENGINE'S OWN vertex objects:
 *   - `pushPlain`      — push into a plain array. The floor.
 *   - `pushPresized`   — the same with the array pre-sized, to price the growth/doubling.
 *   - `pushViaClosure` — through a closure that also reads a property, as `pick` does: this is the shape
 *     the engine actually has, and the one that can go megamorphic.
 *   - `readOnly`       — the property read with NO push, so the push's own share is a subtraction.
 *
 * ⚠️ THE OBJECTS ARE REAL VERTICES, not plain records. Retention is one of the candidates, so a fixture
 * of `{a: 1}` literals would answer a different question — and item 2084 already recorded that a floor
 * over plain objects hid 25% of a query.
 *
 * ⚠️ AND THE LIST IS BUILT ONCE, OUTSIDE THE TIMED REGION. Item 1933's rule: the fixture stays out.
 */
import { Graph } from '@lenke/core';

const N = Number(process.env.N ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const REPS = Number(process.env.REPS ?? 15);
const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: `v${i}`,
    labels: ['P'],
    properties: i % 5 === 4 ? { other: i } : { n: i % 97 },
  });
}

/*
 * The far vertices a `V().out('E')` walk visits, in walk order — materialized ONCE so every arm pushes
 * the identical object sequence and the traversal is not in the measurement.
 */
const far = [];

for (let d = 0; d < FANOUT; d += 1) {
  for (let i = 0; i < N; i += 1) {
    far.push(g.getVertexById(`v${(i * 7 + 3 + d * 104_729) % N}`));
  }
}

const COUNT = far.length;

/** `pick`'s real shape: a closure over a bucket that pushes and returns a property. */
const makePick = (bucket) => (v) => {
  bucket.push(v);

  return v.properties.n;
};

const arms = {
  /* THE FLOOR: push 600,000 existing objects into a fresh array. */
  pushPlain: () => {
    const bag = [];

    for (let i = 0; i < COUNT; i += 1) {
      bag.push(far[i]);
    }

    return bag.length;
  },
  /* ⚠️ PRE-SIZED, to price the doubling-growth hypothesis on its own. */
  pushPresized: () => {
    const bag = new Array(COUNT);

    for (let i = 0; i < COUNT; i += 1) {
      bag[i] = far[i];
    }

    return bag.length;
  },
  /* 🔑 THROUGH THE CLOSURE, which is what the engine does — push AND read, per element. */
  pushViaClosure: () => {
    const bag = [];
    const pick = makePick(bag);
    let kept = 0;

    for (let i = 0; i < COUNT; i += 1) {
      const value = pick(far[i]);

      if (value !== undefined) {
        kept += 1;
      }
    }

    return kept > 0 ? bag.length : -1;
  },
  /* THE SUBTRACTION ARM: the same property read, NO push. */
  readOnly: () => {
    let kept = 0;

    for (let i = 0; i < COUNT; i += 1) {
      if (far[i].properties.n !== undefined) {
        kept += 1;
      }
    }

    return kept;
  },
};

console.log(`  N=${N} FANOUT=${FANOUT} objects=${COUNT}, median of ${REPS}\n`);

for (const [name, fn] of Object.entries(arms)) {
  const series = [];
  let got = 0;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    got = fn();
    series.push(performance.now() - t0);
  }

  // ⚠️ Every arm must have touched all 600,000, or it is measuring less work.
  if (got !== COUNT && got !== 480_000) {
    throw new Error(`${name}: returned ${got}, expected ${COUNT} or 480000`);
  }

  const kept = series.slice(4).sort((a, b) => a - b);
  const median = kept[Math.floor(kept.length / 2)];

  console.log(
    `  ${name.padEnd(15)} ${median.toFixed(1).padStart(7)} ms   ${((median * 1e6) / COUNT).toFixed(1).padStart(6)} ns/element   (${got})`,
  );
}
