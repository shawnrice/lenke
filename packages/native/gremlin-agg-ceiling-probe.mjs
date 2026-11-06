/**
 * What is the FLOOR for `V().values('k').max()`, and so the ceiling of any fusion? (item 1586)
 *
 * Item 1585 established that Gremlin's terminal aggregates are free — every one costs what
 * `values('k')` alone costs (~2.1 ms over 50,000 vertices) — and that 75.8% of the profile is three
 * generator frames. The obvious next move is to fuse `values(k)` with its terminal into one step.
 *
 * ⚠️ BUT A FUSION IS NOT FREE TO ATTEMPT. `executor-edits-perturb` prices a new walk variant at up
 * to 16% on UNRELATED rows, and item 1573 declined several step shortcuts on exactly that trade. So
 * the thing to know BEFORE building it is how much there is to win, and that is what a hand-written
 * loop over the same data answers. If the loop is 1.9 ms, the fusion can win 0.2 and is not worth
 * the perturbation; if it is 0.3, there is 1.8 on the table.
 *
 * The arms are deliberately a LADDER, so the cost lands on a specific mechanism rather than on
 * "overhead":
 *
 *     rawloop      iterate vertices, read props, reduce        the floor
 *     rawgetter    same, but through the `properties` getter   what the getter costs
 *     rawtyped     same, plus the isVertex/isEdge type tests   what the guards cost
 *     gentwo       the same work across TWO generator yields   what the boundaries cost
 *     gremlin      the real traversal                          the thing being explained
 *
 *     for a in rawloop rawgetter rawtyped gentwo gremlin; do ARM=$a node gremlin-agg-ceiling-probe.mjs; done
 */
import { Graph } from '@lenke/core';
import * as G from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 50_000);
const REPS = Number(process.env.REPS ?? 15);
const ARM = process.env.ARM ?? 'rawloop';

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, n: i } });
}

// Hoisted so the timed loop measures the walk and not a property lookup on the module namespace.
const vertices = g.verticesById;
const plan = G.traversal(G.V(), G.values('k'), G.max());

/** The floor: one pass, no abstraction, reading the property bag once per vertex. */
const rawloop = () => {
  let best;
  let saw = false;

  for (const v of vertices.values()) {
    const props = v.properties;

    if ('k' in props) {
      const x = props.k;

      if (!saw || x > best) {
        best = x;
        saw = true;
      }
    }
  }

  return best;
};

/**
 * The same, but re-reading `v.properties` the way the step does. ⚠️ `properties` is a GETTER
 * (`get properties` showed up at 2.8% in item 1585's profile), so this separates "reading the bag"
 * from "iterating the vertices".
 */
const rawgetter = () => {
  let best;
  let saw = false;

  for (const v of vertices.values()) {
    if ('k' in v.properties) {
      const x = v.properties.k;

      if (!saw || x > best) {
        best = x;
        saw = true;
      }
    }
  }

  return best;
};

/** Plus the type guards `projectValues` applies per element. */
const isVertexish = (x) => x !== null && typeof x === 'object' && 'labels' in x && 'id' in x;
const rawtyped = () => {
  let best;
  let saw = false;

  for (const v of vertices.values()) {
    if (!isVertexish(v)) {
      continue;
    }

    const props = v.properties;

    if ('k' in props) {
      const x = props.k;

      if (!saw || x > best) {
        best = x;
        saw = true;
      }
    }
  }

  return best;
};

/**
 * The same work routed across TWO generator boundaries with a wrapper object per element — the
 * shape of `sourceFromIds` -> `projectValues` -> terminal. This is the arm that prices the
 * mechanism a fusion would remove, WITHOUT touching the engine.
 */
const srcGen = function* () {
  for (const v of vertices.values()) {
    yield { value: v };
  }
};
const valGen = function* (stream) {
  for (const t of stream) {
    const props = t.value.properties;

    if ('k' in props) {
      yield { value: props.k };
    }
  }
};
const gentwo = () => {
  let best;
  let saw = false;

  for (const t of valGen(srcGen())) {
    if (!saw || t.value > best) {
      best = t.value;
      saw = true;
    }
  }

  return best;
};

const ARMS = {
  rawloop,
  rawgetter,
  rawtyped,
  gentwo,
  gremlin: () => {
    const rows = G.toArray(plan, g);

    return Array.isArray(rows) ? rows[0] : rows;
  },
};

const run = ARMS[ARM];

if (run === undefined) {
  throw new Error(`unknown arm ${ARM}; have ${Object.keys(ARMS).join(',')}`);
}

const answer = run();
const s = [];

for (let i = 0; i < REPS; i += 1) {
  const t0 = performance.now();

  run();
  s.push(performance.now() - t0);
}

const kept = s.slice(3).sort((a, b) => a - b);

console.log(
  JSON.stringify({
    arm: ARM,
    answer,
    ms: Number((kept[Math.floor(kept.length / 2)] ?? 0).toFixed(3)),
    series: s.map((x) => Number(x.toFixed(1))),
  }),
);
