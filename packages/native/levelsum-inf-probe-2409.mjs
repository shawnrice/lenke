// Item 2409 — IS THE `Number.isFinite` GUARD LOAD-BEARING, OR DID I JUSTIFY IT WITHOUT MEASURING?
//
// Mutant 9 of the battery relaxes the bail from `!Number.isFinite(cell)` to `typeof cell !== 'number'`
// and SURVIVED. Two readings of that:
//
//   (a) a test gap — the guard matters and nothing exercises the case, or
//   (b) the mutant is answer-equivalent and the comment justifying the guard is OVERSTATED.
//
// The comment I shipped claims `u · NaN` and `u · Infinity` "LOOK like the per-path answer and are
// not reliably it once a second non-finite term with the opposite sign is in play". That is a
// prediction. Item 2408 is the item where I wrote a prediction into a doc comment as fact and
// measuring refuted it, so this one gets measured before it stays.
//
//     bun levelsum-inf-probe-2409.mjs
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

/** Fanout 2, so every far vertex carries a multiplicity above 1 and the weight is in play. */
const ringOf = (props) => {
  const g = new Graph();

  for (const [i, p] of props.entries()) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: p });
  }

  for (let i = 0; i < props.length; i += 1) {
    for (const [j, step] of [1, 2].entries()) {
      g.addEdge({
        id: `e${i}-${j}`,
        from: g.getVertexById(`v${i}`),
        to: g.getVertexById(`v${(i + step) % props.length}`),
        labels: ['E'],
        properties: {},
      });
    }
  }

  return g;
};

const Q = 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN sum(c.w) AS x';
const CASES = [
  ['+Inf alone', [{ w: 1.5 }, { w: Number.POSITIVE_INFINITY }, { w: 2.5 }]],
  // THE CASE MY COMMENT NAMES: two non-finite terms with opposite signs.
  ['+Inf and -Inf', [{ w: Number.POSITIVE_INFINITY }, { w: Number.NEGATIVE_INFINITY }, { w: 2.5 }]],
  ['NaN alone', [{ w: 1.5 }, { w: Number.NaN }, { w: 2.5 }]],
  // OVERFLOW BY WEIGHT, which is the one mechanism available to the weighted form and not the other:
  // `fl(u · x)` can reach Infinity where the running per-path total never does.
  ['overflow by weight', [{ w: 1e308 }, { w: -1e308 }, { w: 1 }]],
  ['near-overflow', [{ w: 8e307 }, { w: 8e307 }, { w: -8e307 }]],
  ['weighted overflow, one sign', [{ w: 1e307 }, { w: 1e307 }, { w: 1e307 }]],
];

let differ = 0;

for (const [label, props] of CASES) {
  const g = ringOf(props);
  const fused = query(g, Q, {}).at(0)?.x;
  // eslint-disable-next-line lenke/no-raw-interpolation -- `Q` is a module constant in this file; nothing is interpolated from outside it.
  const general = query(g, `${Q} ORDER BY x`, {}).at(0)?.x;
  const agree = Object.is(fused, general);

  if (!agree) {
    differ += 1;
  }

  console.log(
    `${label.padEnd(28)} fused ${String(fused).padEnd(24)} ` +
      `general ${String(general).padEnd(24)} ${agree ? 'AGREE' : '*** DIFFER ***'}`,
  );
}

const conclusion =
  differ === 0
    ? 'So the guard is NOT observable on any of these and the comment must be demoted.'
    : 'So the guard IS load-bearing and the test must cover the separating case.';

console.log(`\n${differ}/${CASES.length} cases separate the two arms. ${conclusion}`);
