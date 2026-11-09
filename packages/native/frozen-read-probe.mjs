/**
 * DOES A FROZEN PROPERTY BAG COST ANYTHING TO *READ*? (item 1734)
 *
 * Item 1733 measured `Object.freeze` at ~35 ns of a ~112 ns property write and explained the gap
 * against item 861's isolated ~13 ns like this: "freezing does not only cost the call -- `setProperty`
 * then makes three `this.properties` reads against a FROZEN object, and a microbench that freezes and
 * discards never pays for those."
 *
 * ⚠️ THAT IS A MECHANISM CLAIM AND IT WAS ASSERTED, NOT MEASURED. It is now written into a comment in
 * `Vertex.ts` and into `CLOSED.md`, and the lazy-freeze design rests on it: if reads are penalized,
 * deferring the freeze helps the READ paths too (GQL and Gremlin both read properties through the
 * same getter); if they are not, the ~35 ns is the freeze CALL alone and the explanation is wrong.
 *
 * This probe reads and never writes, so the freeze call itself is outside the measured loop entirely
 * -- the fixture is built, every bag is frozen or not by the arm, and then only reads are timed.
 * Run through `commit-ablate-driver.sh`'s arms (base = frozen, nofreeze = not), one arm per build.
 *
 *     SHAPE=raw    v.properties.a          -- the getter plus one named read
 *     SHAPE=gql    MATCH (v:P) WHERE ...   -- the real ISO-GQL surface
 *     SHAPE=keys   Object.keys(bag).length -- the shape V8 is most likely to treat differently
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const VERTS = Number(process.env.VERTS ?? 200_000);
const REPS = Number(process.env.REPS ?? 9);
const DROP = Number(process.env.DROP ?? 3);
const ARM = process.env.ARM ?? 'base';
const SHAPE = process.env.SHAPE ?? 'raw';

const g = new Graph();

for (let i = 0; i < VERTS; i += 1) {
  g.addVertex({
    id: `v${i}`,
    labels: ['P'],
    properties: { a: i, b: `s${i}`, c: i % 2 === 0, d: i * 0.5 },
  });
}

const handles = [];

for (let i = 0; i < VERTS; i += 1) {
  handles.push(g.getVertexById(`v${i}`));
}

// Confirm the arm really is what it claims, from the DATA rather than from the build: a frozen bag
// refuses a write. This is the per-run twin of the driver's dist assertion.
const probeBag = handles[0].properties;
let bagIsFrozen;

try {
  // eslint-disable-next-line no-underscore-dangle
  Object.defineProperty(probeBag, '__arm_probe__', { value: 1 });
  bagIsFrozen = false;
} catch {
  bagIsFrozen = true;
}

const shapes = {
  raw: () => {
    let s = 0;

    for (let i = 0; i < VERTS; i += 1) {
      s += handles[i].properties.a;
    }

    return s;
  },
  keys: () => {
    let s = 0;

    for (let i = 0; i < VERTS; i += 1) {
      s += Object.keys(handles[i].properties).length;
    }

    return s;
  },
  gql: () => {
    const rows = query(g, 'MATCH (v:P) WHERE v.a > 100 RETURN count(*) AS c');

    return rows[0]?.c ?? -1;
  },
};

const run = shapes[SHAPE];

if (run === undefined) {
  throw new Error(`unknown SHAPE ${SHAPE}; have ${Object.keys(shapes).join(',')}`);
}

const series = [];
let answer;

for (let r = 0; r < REPS; r += 1) {
  const t = performance.now();

  answer = run();
  series.push(performance.now() - t);
}

const kept = series.slice(DROP).sort((a, b) => a - b);
const median = kept[Math.floor(kept.length / 2)];

console.log(
  JSON.stringify({
    arm: ARM,
    shape: SHAPE,
    bagIsFrozen,
    verts: VERTS,
    answer,
    nsPerRead: Number(((median * 1e6) / VERTS).toFixed(2)),
    medianMs: Number(median.toFixed(2)),
    series: series.map((x) => Number(x.toFixed(2))),
  }),
);
