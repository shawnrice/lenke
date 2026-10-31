// Does the micro-arm in box-cost-probe.ts describe what the ENGINE actually pays? (companion probe)
//
//   bun box-cost-real.ts <arm>
//
// The micro-arms measure a hand-written loop. The engine does not run that loop: `filterChainCount`
// SEEDS a single-label scan from `verticesByLabel`, so the label test may already be free on the
// very shape the mask would speed up. This checks the three shapes that matter — a label test the
// index can seed, a two-label AND it cannot, and a property filter with no label at all.
import { Graph } from '@lenke/core';
import {
  V,
  both,
  count,
  gt,
  has,
  hasLabel,
  in_,
  out,
  outE,
  toArray,
  traversal,
} from '@lenke/gremlin';

const N = Number(process.env.PRED_N ?? 200_000);
const REPS = Number(process.env.PRED_REPS ?? 14);
const arm = process.argv[2] ?? '';
const graph = new Graph();

/**
 * `Person` on every vertex, `Employee` on every other, `Mgr` on every third.
 *
 * ⚠️ `Mgr` EXISTS BECAUSE `dropVacuousLabels` (item 540) DELETES A `hasLabel` WHOSE BUCKET HOLDS
 * EVERY LIVE ELEMENT. The start-filtered arm was first written as `hasLabel('Person')` on a fixture
 * where every vertex was a `Person`, so the step was removed from the plan and the arm silently
 * measured the BARE shape — the two arms agreeing to within 3% was the giveaway. A start label must
 * be non-vacuous or the arm is not the query it claims.
 */
const labelsFor = (i: number): string[] => {
  const labels = ['Person'];

  if (i % 2 === 0) {
    labels.push('Employee');
  }

  if (i % 3 === 0) {
    labels.push('Mgr');
  }

  return labels;
};

for (let i = 0; i < N; i++) {
  graph.addVertex({
    id: `v${i}`,
    labels: labelsFor(i),
    properties: { age: i % 90, name: `n${i}` },
  });
}

// Edges, so the FAR-END label test can be measured. A frontier reached through a hop is not a
// whole label bucket, so `verticesByLabel` cannot seed it and the test must be made per element —
// which is the one place a label bitmask still has a target after the scan shapes came back free.
const ids = [...graph.verticesById.keys()];

for (let i = 0; i < N; i++) {
  graph.addEdge({
    id: `e${i}`,
    from: graph.verticesById.get(ids[i])!,
    to: graph.verticesById.get(ids[(i * 7 + 3) % N])!,
    labels: ['T'],
    properties: {},
  });
}

const ARMS: Record<string, () => number> = {
  // ⚠️ THE ONE SHAPE THAT PAYS NEW PER-EDGE WORK. `bothFilteredHopCount` walks EDGES via
  // `tallyFarEnds`, which now checks `labelSets.length !== 0` per edge — so a both-sides query with
  // NO far label is where the change can only cost. Measured because "obviously cheap so it must be
  // free" is not evidence in this repo.
  'reg-bothsides-noflabel': () =>
    Number(
      toArray(traversal(V(), hasLabel('Mgr'), out('T'), has('age', gt(44)), count()), graph)[0],
    ),

  'ctl-scan-prop': () => Number(toArray(traversal(V(), has('age', gt(44)), count()), graph)[0]),

  // The hand-written FLOOR for the same work: walk each vertex's `T` adjacency and test the far
  // end's label. This is the comparison that matters — `q-hop` is a closed-form degree SUM that
  // never visits a far end, so it is not the floor for a query that must.
  'loop-hop-label': () => {
    let n = 0;

    for (const v of graph.verticesById.values()) {
      const es = v.adjFrom?.get('T');

      if (es === undefined) {
        continue;
      }

      for (const e of es) {
        if (e.to.labels.has('Employee')) {
          n++;
        }
      }
    }

    return n;
  },

  // Is the gap specific to a LABEL test, or does any far-end filter fall off? `filteredHopCount`
  // serves far-end PROPERTY filters, so this is the discriminating arm.
  'q-hop-prop': () =>
    Number(toArray(traversal(V(), out('T'), has('age', gt(44)), count()), graph)[0]),

  // THE FAMILY: which spellings of a far-end label test fall off, and which are already served.
  'q-hop-label-start': () =>
    Number(
      toArray(traversal(V(), hasLabel('Mgr'), out('T'), hasLabel('Employee'), count()), graph)[0],
    ),
  'q-hop-label-prop': () =>
    Number(
      toArray(
        traversal(V(), out('T'), hasLabel('Employee'), has('age', gt(44)), count()),
        graph,
      )[0],
    ),
  'q-in-label': () =>
    Number(toArray(traversal(V(), in_('T'), hasLabel('Employee'), count()), graph)[0]),
  'q-both-label': () =>
    Number(toArray(traversal(V(), both('T'), hasLabel('Employee'), count()), graph)[0]),
  // `hasLabel` after an EDGE hop filters the EDGE's label, not the far vertex — a different
  // question, and the reason the shared `hasChain` reader must not simply be widened.
  'q-edgehop-label': () =>
    Number(toArray(traversal(V(), outE('T'), hasLabel('T'), count()), graph)[0]),

  // The far-end pair: the delta is what one per-element label test costs where no bucket can seed.
  'ctl-hop': () => Number(toArray(traversal(V(), out('T'), count()), graph)[0]),
  'q-hop-label': () =>
    Number(toArray(traversal(V(), out('T'), hasLabel('Employee'), count()), graph)[0]),
  // Seedable: one label, no property filter.
  'ctl-label1': () => Number(toArray(traversal(V(), hasLabel('Person'), count()), graph)[0]),
  // NOT seedable by a single bucket: two labels ANDed.
  'ctl-label2': () =>
    Number(toArray(traversal(V(), hasLabel('Person'), hasLabel('Employee'), count()), graph)[0]),
  // Property filter, no label — item 1294's row, for calibration against its 13 ns/v.
  'q-prop': () => Number(toArray(traversal(V(), has('age', gt(44)), count()), graph)[0]),
  // The combination: label + property filter.
  'q-both': () =>
    Number(toArray(traversal(V(), hasLabel('Person'), has('age', gt(44)), count()), graph)[0]),
  'q-both2': () =>
    Number(
      toArray(
        traversal(V(), hasLabel('Person'), hasLabel('Employee'), has('age', gt(44)), count()),
        graph,
      )[0],
    ),
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
