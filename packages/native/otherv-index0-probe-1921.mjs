// Item 1921 — IS THE `i === 0` GUARD IN `normalizeDirectedOtherV` REACHABLE?
//
// A mutant dropping it SURVIVED, which means either no test reaches it or it is dead. Without the
// guard, an `otherV` at index 0 reads `steps[-1]` — `undefined` — and `EDGE_TO_FAR[undefined.kind]`
// THROWS. So if the case can arise, the guard is load-bearing and needs a test; if it cannot, the
// guard is dead code and CLAUDE.md says to delete it rather than keep an untestable branch.
//
// "PROVE IT IS DEAD BEFORE DELETING IT" is the rule (items 1899/1903 deleted and KEPT one each on
// exactly this test). The pass walks only TOP-LEVEL steps, and `traversal()` always puts a source
// first — but `match.ts` builds plans from step SLICES, so the question is whether such a slice can
// reach `run` with a leading `otherV`.
import { Graph } from '@lenke/core';
import { V, bothE, otherV, out, outE, toArray, traversal } from '@lenke/gremlin';

const g = new Graph();
const a = g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });
const b = g.addVertex({ id: 'b', labels: ['P'], properties: { n: 2 } });

g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: {} });

// 1. Can a traversal be built whose FIRST step is `otherV`? The surface requires a source.
const built = traversal(V(), outE('E'), otherV());

console.log(
  `a built plan's first step: ${built.steps[0].kind}  (steps: ${built.steps.map((s) => s.kind).join(',')})`,
);

// 2. Hand-build a plan object whose steps START with otherV, and push it through the executor.
//    This is the only way the index-0 case could exist, so if the executor accepts it the guard is
//    load-bearing.
const handmade = { ...built, steps: [{ kind: 'otherV' }] };

let verdict = '';

try {
  const rows = toArray(handmade, g);

  verdict = `ACCEPTED, ${rows.length} rows`;
} catch (e) {
  verdict = `threw ${String(e).slice(0, 70)}`;
}

console.log(`a hand-made plan starting with otherV: ${verdict}`);

// 3. And a plan where otherV follows a NON-edge step, which the guard's sibling check covers.
let after = '';

try {
  const rows = toArray(traversal(V(), out('E'), otherV()), g);

  after = `ACCEPTED, ${rows.length} rows`;
} catch (e) {
  after = `threw ${String(e).slice(0, 70)}`;
}

console.log(`V().out(E).otherV() (otherV after a VERTEX step): ${after}`);

// 4. The refused shape, for contrast.
console.log(
  `V().bothE(E).otherV(): ${String(toArray(traversal(V(), bothE('E'), otherV()), g).length)} rows`,
);

console.log(
  '\nIF (2) THREW ON A REACHABLE PATH the guard is load-bearing and needs a test; if the executor\n' +
    '   refuses such a plan for its OWN reasons before the pass runs, the guard is dead and should go.',
);
