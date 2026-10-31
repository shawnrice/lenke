// PRICING THE TWO BOX LEVERS: a label BITMASK, and a one-hop sequential box array.
//
//   bun box-cost-probe.ts <arm>        # ONE arm per process, see ARMS below
//
// Item 1294 decomposed the TS per-row cost and left two things unpriced, both of them layout:
//
//   * the label test is the single most expensive operation (~22.8 ns/v of its 24.29 cumulative),
//     and it is the box chase PLUS a `Set<string>.has` string hash, per vertex, to answer yes/no.
//     Native already interns labels (`store.rs`, `label_id`), so a mask on the `LabelBox` is a
//     representation gap rather than a new idea.
//   * the property read's ~5.8 ns of indirection was measured only two ways — through the engine
//     (`7.38`) and fully HOISTED into an array of bags (`1.53`). The middle shape was never
//     measured: boxes held in a contiguous array, read as `boxes[i].bag[k]`, which is ONE
//     dependent load instead of two and sequential instead of scattered. That is what a parallel
//     box array would actually cost, and whether it lands near 1.53 or near 7.38 decides whether
//     the lever is worth its delete bookkeeping.
//
// ⚠️ ONE ARM PER PROCESS, because these arms differ exactly in which object shape a load site
// sees. Run together, `v.properties` and `boxes[i].bag` share a polymorphic site and the arm
// measured second is flattered — item 762's trap, where a two-dist in-process A/B moved its
// CONTROLS 1.23-1.56x in the change's favour. The driver alternates arm order across rounds and
// takes the min, which is the repo's estimator for this path (14 reps, drop 3, median).
//
// FIXTURE: every vertex carries `Person`; every other one also carries `Employee`, so the
// two-label arms have something to AND. The label Set is therefore size 1 or 2 rather than item
// 1294's uniform 1, so `label-current` here is NOT directly comparable to that item's 24.29 —
// `label-boxset` is the in-fixture reference point, and every comparison below stays inside this
// fixture.

// oxlint-disable typescript/prefer-for-of -- THE INDEXED LOOP IS THE MEASUREMENT. These arms
// compare `boxes[i].bag[k]` against `v.properties[k]` at 1-11 ns/v; a `for...of` would add the
// iterator protocol to one side of a pair whose whole content is a few nanoseconds, which is the
// arm-is-not-the-code-it-claims failure this probe exists to avoid. `shortcuts.ts` carries the same
// disable with the same kind of reason.
import { Graph } from '@lenke/core';
import { gt, matches } from '@lenke/gremlin';

const N = Number(process.env.PRED_N ?? 200_000);
const REPS = Number(process.env.PRED_REPS ?? 14);
const arm = process.argv[2] ?? '';

const g = new Graph();
/** Every vertex is a `Person`; every other one is also an `Employee`, so the two-label arms have
 *  something to AND. A named function rather than a nested ternary, which the lint gate refuses. */
const labelsFor = (i: number): string[] => (i % 2 === 0 ? ['Person', 'Employee'] : ['Person']);

for (let i = 0; i < N; i++) {
  g.addVertex({
    id: `v${i}`,
    labels: labelsFor(i),
    properties: { age: i % 90, name: `n${i}` },
  });
}

// The three layouts, built once and OUTSIDE the timed region. `bags` is item 1294's hoisted
// ceiling; `boxes` is the shape a parallel box array would have; `lboxes` mirrors `LabelBox`
// (`{set}`) plus the `mask` field this probe is pricing, so the mask arms and the Set arms differ
// only in the operation and not in the object shape they load from.
const PERSON = 1 << 0;
const EMPLOYEE = 1 << 1;
const bags: Record<string, unknown>[] = [];
const boxes: { bag: Record<string, unknown> }[] = [];
const lboxes: { set: Set<string>; mask: number }[] = [];

for (const v of g.verticesById.values()) {
  const box = g.elementProperties.get(v.id);
  const lbox = g.elementLabels.get(v.id);

  if (box === undefined || lbox === undefined) {
    throw new Error(`no box for ${v.id}`);
  }

  bags.push(box.bag);
  boxes.push({ bag: box.bag });

  let mask = 0;

  for (const l of lbox.set) {
    if (l === 'Person') {
      mask |= PERSON;
    } else if (l === 'Employee') {
      mask |= EMPLOYEE;
    }
  }

  lboxes.push({ set: lbox.set, mask });
}

const pred = gt(44);
const k = 'age';

// Each arm returns a count, printed with the timing — an arm whose answer drifts from its twin is
// measuring a different question, which is the check item 1294's own table relies on.
const ARMS: Record<string, () => number> = {
  // CONTROL — reachable by neither lever. If this moves between rounds, the machine is the story.
  iter: () => {
    let n = 0;

    for (const v of g.verticesById.values()) {
      if (v !== undefined) {
        n++;
      }
    }

    return n;
  },

  // SECOND CONTROL — the array-iteration floor. Without this, every array-held arm below is
  // credited with the difference between iterating a 200,000-entry Map and indexing an array,
  // which is a LAYOUT win and not the lever being priced.
  'iter-array': () => {
    let n = 0;

    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i] !== undefined) {
        n++;
      }
    }

    return n;
  },

  // Reaching the label box THROUGH THE VERTEX, without the hash probe: the getter, the `??=`, the
  // `#lbox` load and a `.size` read. This is the part a bitmask does NOT remove while scans stay
  // vertex-driven, so it is the floor for lever 1 taken on its own.
  'label-getter-only': () => {
    let n = 0;

    for (const v of g.verticesById.values()) {
      if (v.labels.size !== 0) {
        n++;
      }
    }

    return n;
  },

  // --- the property read: current, the middle shape, the ceiling ---
  'prop-current': () => {
    let n = 0;

    for (const v of g.verticesById.values()) {
      if (v.properties[k] !== undefined) {
        n++;
      }
    }

    return n;
  },
  'prop-boxarray': () => {
    let n = 0;

    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].bag[k] !== undefined) {
        n++;
      }
    }

    return n;
  },
  'prop-bagarray': () => {
    let n = 0;

    for (let i = 0; i < bags.length; i++) {
      if (bags[i][k] !== undefined) {
        n++;
      }
    }

    return n;
  },

  // --- the label test: current, the Set without the getter, the mask ---
  'label-current': () => {
    let n = 0;

    for (const v of g.verticesById.values()) {
      if (v.labels.has('Person')) {
        n++;
      }
    }

    return n;
  },
  'label-boxset': () => {
    let n = 0;

    for (let i = 0; i < lboxes.length; i++) {
      if (lboxes[i].set.has('Person')) {
        n++;
      }
    }

    return n;
  },
  'label-mask': () => {
    let n = 0;

    for (let i = 0; i < lboxes.length; i++) {
      if ((lboxes[i].mask & PERSON) !== 0) {
        n++;
      }
    }

    return n;
  },

  // --- the two-label AND, which is the case `verticesByLabel` seeding cannot serve ---
  'label2-current': () => {
    let n = 0;

    for (const v of g.verticesById.values()) {
      const s = v.labels;

      if (s.has('Person') && s.has('Employee')) {
        n++;
      }
    }

    return n;
  },
  'label2-mask': () => {
    const both = PERSON | EMPLOYEE;
    let n = 0;

    for (let i = 0; i < lboxes.length; i++) {
      if ((lboxes[i].mask & both) === both) {
        n++;
      }
    }

    return n;
  },

  // --- the whole predicate, end to end: what a scan actually pays, both ways ---
  'scan-current': () => {
    let n = 0;

    for (const v of g.verticesById.values()) {
      if (v.labels.has('Person') && matches(pred, v.properties[k])) {
        n++;
      }
    }

    return n;
  },
  'scan-both': () => {
    let n = 0;

    for (let i = 0; i < boxes.length; i++) {
      if ((lboxes[i].mask & PERSON) !== 0 && matches(pred, boxes[i].bag[k])) {
        n++;
      }
    }

    return n;
  },
};

const run = ARMS[arm];

if (run === undefined) {
  console.log(`arms: ${Object.keys(ARMS).join(' ')}`);
  process.exit(2);
}

const series: number[] = [];
let answer = 0;

for (let r = 0; r < REPS; r++) {
  const t = performance.now();

  answer = run();
  series.push(performance.now() - t);
}

const warm = series.slice(3).sort((a, b) => a - b);
const med = warm[Math.floor(warm.length / 2)] ?? 0;

console.log(
  `${arm}\t${med.toFixed(4)}\t${((med * 1e6) / N).toFixed(2)}\t${answer}\t${series
    .map((s) => s.toFixed(2))
    .join(' ')}`,
);
