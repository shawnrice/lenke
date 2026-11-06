/**
 * What does the raw `v.labels =` setter cost, and what would maintaining `verticesByLabel` add?
 * (item 1608)
 *
 * The vacuous-label elision is worth 5.6x on a seeded count, and its only blocker is that the raw
 * setter does not maintain `verticesByLabel` — so a bucket-size vacuity check can be stale. Fixing
 * the setter removes the blocker at every site, but moves cost from the READ path to the WRITE path.
 * "Faster across the board" is therefore a measurement, not a preference:
 *
 *   - how often is a label WRITE on the hot path at all, and what does it cost now;
 *   - what does the elision buy on the two read sites.
 *
 * ⚠️ THE ARMS HERE ARE WRITE SHAPES ONLY. The read side is `two-conjunct-seek-probe.mjs` with
 * `MULTI=1` as its control; this probe exists so the two halves of the trade are measured with the
 * same discipline rather than one measured and one assumed.
 *
 *     node label-setter-cost-probe.mjs
 */
import { Graph } from '@lenke/core';

const NODES = Number(process.env.NODES ?? 20_000);
const REPS = Number(process.env.REPS ?? 40);

const build = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({ id: `u${i}`, labels: ['P'], properties: { k: i % 100 } });
  }

  return g;
};

const ARMS = [
  {
    name: 'v.labels = [same]          (re-write, box cached)',
    run: (g, vs) => {
      for (const v of vs) {
        v.labels = ['P'];
      }
    },
  },
  {
    name: 'v.labels = [different]      (the stale-bucket write)',
    run: (g, vs) => {
      for (const v of vs) {
        v.labels = ['Q'];
      }
    },
  },
  {
    name: 'v.addLabel / removeLabel    (the MAINTAINED API)',
    run: (g, vs) => {
      for (const v of vs) {
        v.addLabel('Q');
        v.removeLabel('Q');
      }
    },
  },
  {
    name: 'v.setProperty               (scale: a property write)',
    run: (g, vs) => {
      for (const v of vs) {
        v.setProperty('k', 1);
      }
    },
  },
];

console.log(`${NODES} vertices, ${REPS} reps over all of them. ns per VERTEX written.\n`);

for (const arm of ARMS) {
  const g = build();
  const vs = [...g.vertices];

  for (let i = 0; i < 3; i += 1) {
    arm.run(g, vs);
  }

  const t0 = performance.now();

  for (let i = 0; i < REPS; i += 1) {
    arm.run(g, vs);
  }

  const ns = ((performance.now() - t0) * 1e6) / (REPS * vs.length);

  console.log(`${arm.name.padEnd(52)} ${ns.toFixed(1).padStart(7)} ns`);
}
