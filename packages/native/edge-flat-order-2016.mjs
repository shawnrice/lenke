/**
 * Item 2016 — DOES THE FLAT EDGE ARRAY EMIT THE SAME ROWS IN THE SAME ORDER AS THE BUCKET WALK?
 *
 * **THIS IS THE WHOLE CORRECTNESS ARGUMENT FOR THE FLAT ARM, AND THE SECOND-ASK POLICY MAKES IT
 * SELF-CHECKING.** `edge-filtered-hop-values.ts` takes the flat array only from the SECOND ask on a
 * topology version (item 1889's policy, in its own `'e'` namespace). So within ONE process, with no
 * write between them:
 *
 * ```text
 *     ask 1  ->  the BUCKET walk   (per vertex: adjFrom.get(type), then the Set)
 *     ask 2  ->  the FLAT array    (one linear pass over graph-vertex-order edges)
 * ```
 *
 * The two must agree ELEMENT FOR ELEMENT. Gremlin rows are compared ORDERED against the Rust engine
 * for a single-type step — [[order-is-unspecified]] does NOT cover it — so a reordering here is a
 * cross-engine failure, not an unspecified-order liberty. And a checksum cannot see a reordering
 * (item 1955), which is why this compares positions.
 *
 * A WRITE BETWEEN ASKS RESETS THE POLICY, because the key includes `topologyVersion`. That is
 * asserted too: after a write the next ask must be the BUCKET walk again, and must still agree.
 *
 * FIXTURE SHAPES THAT COULD BREAK THE ORDER, all present below: a vertex with NO edge of the type
 * (an empty bucket the bucket walk skips and the flat build must also skip), a vertex with a
 * MULTI-EDGE bucket (so intra-bucket order matters), a SELF-LOOP, an edge of ANOTHER type
 * interleaved (so the build must filter by type, not position), and a vertex whose edges were added
 * OUT OF id order.
 *
 *     cd packages/native && bun edge-flat-order-2016.mjs
 */
import { Graph } from '@lenke/core';
import {
  count,
  gt,
  has,
  inE,
  inV,
  outE,
  outV,
  toArray,
  traversal,
  V,
  values,
} from '@lenke/gremlin';

const g = new Graph();

// `w` is sparse on purpose: a `values('w')` projection must DROP an edge lacking it, and the flat
// arm and the bucket arm must drop the SAME ones.
for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
  g.addVertex({ id, labels: ['P'], properties: { n: `n-${id}` } });
}

let seq = 0;
const E = (fr, t, props, label) => {
  seq += 1;

  g.addEdge({
    id: `e${String(seq)}`,
    from: g.getVertexById(fr),
    to: g.getVertexById(t),
    labels: [label ?? 'E'],
    properties: props,
  });
};

// `a` gets THREE E edges, added out of target order, so intra-bucket order is observable.
E('a', 'c', { w: 9 });
E('a', 'b', { w: 1 }); // fails the gt(3) gate
E('a', 'f', { w: 7 });
// an F edge interleaved: the build must filter by TYPE, not by insertion position
E('a', 'd', { w: 9 }, 'F');
// `b` has one E edge whose `w` is ABSENT, so a values('w') projection drops it
E('b', 'd', {});
// `c` is a SELF-LOOP
E('c', 'c', { w: 5 });
// `d` has only an F edge, so its E bucket is ABSENT — the walk must skip it
E('d', 'e', { w: 9 }, 'F');
// `e` has two E edges
E('e', 'a', { w: 4 });
E('e', 'b', { w: 9 });
// `f` has NO edge at all.

const SHAPES = {
  'outE.has.inV.values(n)': () => traversal(V(), outE('E'), has('w', gt(3)), inV(), values('n')),
  'outE.has.values(w)': () => traversal(V(), outE('E'), has('w', gt(3)), values('w')),
  'outE.has.inV.count': () => traversal(V(), outE('E'), has('w', gt(3)), inV(), count()),
  'outE.has.count': () => traversal(V(), outE('E'), has('w', gt(3)), count()),
  'outE.has.inV (elements)': () => traversal(V(), outE('E'), has('w', gt(3)), inV()),
  // TWO `has` steps, so the multi-gate loop is exercised on both arms.
  'outE.has.has.inV.values': () =>
    traversal(V(), outE('E'), has('w', gt(3)), has('w', gt(4)), inV(), values('n')),
  // INWARD: `inE` pairs with `outV`, and the flat build reads `adjTo` instead of `adjFrom` — a
  // SECOND cache key and a second traversal order, so a build that ignored `outward` would show
  // here and nowhere above.
  'inE.has.outV.values(n)': () => traversal(V(), inE('E'), has('w', gt(3)), outV(), values('n')),
  'inE.has.values(w)': () => traversal(V(), inE('E'), has('w', gt(3)), values('w')),
  'inE.has.outV.count': () => traversal(V(), inE('E'), has('w', gt(3)), outV(), count()),
};

const render = (t) =>
  JSON.stringify(
    toArray(t, g).map((x) => (x && typeof x === 'object' && 'id' in x ? `V(${String(x.id)})` : x)),
  );

let bad = 0;

console.log(`|V|=${String(g.vertexCount)} |E|=${String(g.edgeCount)}`);
console.log('ask1 = the BUCKET walk, ask2/ask3 = the FLAT array (second-ask policy)\n');

for (const [name, make] of Object.entries(SHAPES)) {
  const a1 = render(make());
  const a2 = render(make());
  const a3 = render(make());
  const ok = a1 === a2 && a2 === a3;

  if (!ok) {
    bad += 1;
  }

  console.log(`${ok ? '  ' : ''} ${name.padEnd(30)} ${ok ? a1 : `${a1}\n     VS  ${a2}`}`);
}

/*
 * AND A WRITE MUST SEND IT BACK TO THE BUCKET WALK, because the policy's key includes
 * `topologyVersion`. If the cache were merely STAMPED with the version rather than keyed on it, this
 * is the assertion that would fail — a stale flat array over a changed topology.
 */
const shape = SHAPES['outE.has.inV.values(n)'];
const before = render(shape());

render(shape()); // arm the flat array
g.addVertex({ id: 'g', labels: ['P'], properties: { n: 'n-g' } });
g.addEdge({
  id: 'eNEW',
  from: g.getVertexById('g'),
  to: g.getVertexById('a'),
  labels: ['E'],
  properties: { w: 9 },
});

const afterBucket = render(shape()); // first ask on the NEW topology -> bucket walk
const afterFlat = render(shape()); // second ask -> flat array, rebuilt

const grew = afterBucket !== before;
const agree = afterBucket === afterFlat;

if (!grew || !agree) {
  bad += 1;
}

console.log(
  `\n${grew ? '  ' : ''} a write CHANGES the answer: ${String(grew)}` +
    `   (if false this fixture cannot test staleness)`,
);
console.log(
  `${agree ? '  ' : ''} after the write, bucket and flat AGREE: ${String(agree)}\n` +
    `     bucket ${afterBucket}\n     flat   ${afterFlat}`,
);

console.log(`\n${String(bad)} DISAGREEMENTS`);
