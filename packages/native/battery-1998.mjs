import { Graph } from '@lenke/core';
import {
  V,
  both,
  coalesce,
  id,
  identity,
  in_,
  out,
  toArray,
  traversal,
  values,
} from '@lenke/gremlin';

const g = new Graph();

for (const i of ['a', 'b', 'c', 'd', 'e', 'f']) {
  g.addVertex({ id: i, labels: ['P'], properties: i === 'f' ? {} : { n: i } });
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
E('e6', 'e', 'a', 'F'); // only an F edge
E('e7', 'a', 'f'); // 'f' has NO `n` property  -> `drops`
// 'f' is a SINK for E in the out direction

const SHAPES = {
  'out,in .values': () => traversal(V(), coalesce(out('E'), in_('E')), values('n')),
  'outF,outE .values': () => traversal(V(), coalesce(out('F'), out('E')), values('n')),
  'out,in .id': () => traversal(V(), coalesce(out('E'), in_('E')), id()),
  'out,in  (no proj)': () => traversal(V(), coalesce(out('E'), in_('E'))),
  'both,out .values': () => traversal(V(), coalesce(both('E'), out('E')), values('n')),
  'out,both .values': () => traversal(V(), coalesce(out('F'), both('E')), values('n')),
  'multiEF,outE .values': () => traversal(V(), coalesce(out('E', 'F'), out('E')), values('n')),
  'untyped,outE .values': () => traversal(V(), coalesce(out(), out('E')), values('n')),
  '3 arms .values': () => traversal(V(), coalesce(out('F'), out('E'), identity()), values('n')),
  'arm0 identity .values': () => traversal(V(), coalesce(identity(), out('E')), values('n')),
};

const render = (t) =>
  JSON.stringify(
    toArray(t, g).map((x) => (x && typeof x === 'object' && 'id' in x ? `V(${String(x.id)})` : x)),
  );

/*
 * EACH SHAPE IS ASKED THREE TIMES, and that is the whole point of this battery now. The CSR arm
 * is behind `seenBefore` (item 1889's second-ask policy), so a single ask can only ever exercise the
 * BUCKET path — item 1983 lost a verdict to exactly that. Ask 1 is the bucket walk, asks 2 and 3 the
 * CSR, and all three must agree with each other AND with the general path.
 */
for (const [name, build] of Object.entries(SHAPES)) {
  const one = render(build());
  const two = render(build());
  const three = render(build());
  const stable = one === two && two === three;

  console.log(`${name.padEnd(24)} ${one}${stable ? '' : `   UNSTABLE ask2=${two} ask3=${three}`}`);
}
