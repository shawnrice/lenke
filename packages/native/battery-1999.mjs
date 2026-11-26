// Item 1999 — answer-equivalence battery for the fused `choose(<vertex filter>, hop, hop)` route.
//
// **A ROUTE CHOICE IS ANSWER-EQUIVALENT, so the 2,447-test suite passes either way and this is
// what actually compares the two.** Every shape is asked THREE times, because the CSR arms sit
// behind `seenBefore` (item 1889's second-ask policy): ask 1 takes `chooseWalk`, asks 2-3 take
// `csrBothArms`. A single-ask battery exercises half the module.
//
// COMPARED POSITIONALLY, NOT AS A MULTISET. Gremlin stream order is a TinkerPop contract that
// `gremlin-fuzz`'s `unordered` decision compares ORDERED for a single-type step with no `order()`
// ([[order-is-unspecified]] does not cover it), so a route that reorders is WRONG, not merely
// different — and a checksum cannot see that (item 1955).
//
// HOW TO GET THE ORACLE: disable the rung in `fusedProjectedValues`' chain (`undefined ??` in front
// of `chooseHopValues(effective, graph)`), rebuild, run, keep the output; then re-enable, rebuild,
// run, and diff. Both runs must print `0 UNSTABLE`.
//
//     cd packages/native && bun battery-1999.mjs
import { Graph } from '@lenke/core';
import {
  both,
  choose,
  constant,
  has,
  hasLabel,
  id,
  identity,
  in_,
  out,
  toArray,
  traversal,
  V,
  values,
} from '@lenke/gremlin';

const g = new Graph();

/*
 * THE FIXTURE MUST SPLIT ON THE TEST, AND BOTH SIDES MUST BE NON-EMPTY. A graph where every
 * vertex passes the test exercises only the `then` arm, and the `else` arm — which on the workload
 * screen's own row takes 96 of every 97 vertices — would never run. `n` below is 0 for exactly two
 * vertices, so both arms are live and neither is the whole graph.
 *
 * AND `f` HAS NO `n` AT ALL, which is a THIRD case: the test reads a missing property (so it
 * fails and `f` takes the else arm) AND it is the far end of an edge, so a `values('n')` projection
 * drops the row. `drops` and the test are different mechanisms reading the same absent key.
 */
const VERTS = [
  ['a', 0, ['P']],
  ['b', 7, ['P']],
  ['c', 0, ['P', 'Q']],
  ['d', 3, ['Q']],
  ['e', 9, ['P']],
  ['f', undefined, ['P']],
];

for (const [vid, n, labels] of VERTS) {
  g.addVertex({ id: vid, labels, properties: n === undefined ? {} : { n } });
}

const E = (k, fr, t, l) =>
  g.addEdge({
    id: k,
    from: g.getVertexById(fr),
    to: g.getVertexById(t),
    labels: [l ?? 'E'],
    properties: {},
  });

E('e1', 'a', 'b');
E('e2', 'a', 'b'); // PARALLEL
E('e3', 'b', 'c');
E('e4', 'c', 'c'); // SELF-LOOP
E('e5', 'd', 'a');
E('e6', 'e', 'a', 'F'); // only an F edge: a sink for E in both directions
E('e7', 'a', 'f'); // reaches the vertex with no `n`

const SHAPES = {
  // The screen's own row shape: a `has` test, two opposite single-type hops.
  'has / out,in .values': () =>
    traversal(V(), choose(has('n', 0), out('E'), in_('E')), values('n')),
  'has / out,out .values': () =>
    traversal(V(), choose(has('n', 0), out('E'), out('E')), values('n')),
  // NO ELSE ARM — per TinkerPop the traverser PASSES THROUGH, which is a different answer from
  // an empty arm and the thing `chooseStep`'s own comment had to record against the AST's comment.
  'has / out, (no else)': () => traversal(V(), choose(has('n', 0), out('E')), values('n')),
  'hasLabel / out,in .values': () =>
    traversal(V(), choose(hasLabel('Q'), out('E'), in_('E')), values('n')),
  // Multi-step test: both gates must hold.
  'has+hasLabel / out,in': () =>
    traversal(V(), choose(traversal(hasLabel('Q'), has('n', 0)), out('E'), in_('E')), values('n')),
  'has / out,in .id': () => traversal(V(), choose(has('n', 0), out('E'), in_('E')), id()),
  'has / out,in  (no proj)': () => traversal(V(), choose(has('n', 0), out('E'), in_('E'))),
  // `both` declines the CSR on that arm, so this runs a MIXED walk: one arm CSR, one arm bucket.
  'has / both,in .values': () =>
    traversal(V(), choose(has('n', 0), both('E'), in_('E')), values('n')),
  'has / out,both .values': () =>
    traversal(V(), choose(has('n', 0), out('E'), both('E')), values('n')),
  // Multi-type and untyped arms: both decline the CSR, so the whole walk is buckets.
  'has / outEF,outE .values': () =>
    traversal(V(), choose(has('n', 0), out('E', 'F'), out('E')), values('n')),
  'has / untyped,outE': () => traversal(V(), choose(has('n', 0), out(), out('E')), values('n')),
  // SHAPES THE RUNG MUST DECLINE — here so a gate that wrongly admits one shows up as a diff.
  'HOP TEST (declines)': () => traversal(V(), choose(out('E'), values('n'), constant('none'))),
  'IDENTITY ARM (declines)': () =>
    traversal(V(), choose(has('n', 0), identity(), out('E')), values('n')),
  'TWO-STEP ARM (declines)': () =>
    traversal(V(), choose(has('n', 0), traversal(out('E'), out('E')), in_('E')), values('n')),
};

const render = (t) =>
  JSON.stringify(
    toArray(t, g).map((x) => (x && typeof x === 'object' && 'id' in x ? `V(${String(x.id)})` : x)),
  );

let unstable = 0;

console.log(`|V|=${String(g.vertexCount)} |E|=${String(g.edgeCount)}  three asks each\n`);

for (const [name, make] of Object.entries(SHAPES)) {
  // THREE asks: the CSR arms arm on the second, so asks 2 and 3 take a different walk than ask 1.
  const got = [render(make()), render(make()), render(make())];
  const same = got[0] === got[1] && got[1] === got[2];

  if (!same) {
    unstable += 1;
  }

  console.log(`${same ? '  ' : ''} ${name.padEnd(26)} ${same ? got[0] : got.join('\n     VS  ')}`);
}

console.log(`\n${String(unstable)} UNSTABLE`);
