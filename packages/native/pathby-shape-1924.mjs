import { Graph } from '@lenke/core';
import { V, out, path, toArray, traversal, values } from '@lenke/gremlin';

const g = new Graph();
g.addVertex({ id: 'a', labels: ['P'], properties: { n: 'a', opt: 1 } });
g.addVertex({ id: 'b', labels: ['P'], properties: { n: 'b' } }); // NO `opt`
g.addVertex({ id: 'c', labels: ['P'], properties: { n: 'c', opt: null } }); // STORED NULL
const vx = (i) => g.getVertexById(i);
g.addEdge({ id: 'e1', from: vx('a'), to: vx('b'), labels: ['E'], properties: {} });
g.addEdge({ id: 'e2', from: vx('a'), to: vx('c'), labels: ['E'], properties: {} });

/**
 * NOT `JSON.stringify`, which renders `undefined` INSIDE AN ARRAY AS `null` and hid the real
 * value in the first version of this probe. `evalBy` returns NO_VALUE for an absent key and `byOr`
 * maps that to `undefined` — so the row holds `undefined`, not `null`, and a fusion building `null`
 * would be a wrong answer that JSON comparison could never see.
 */
const render = (v) =>
  Array.isArray(v)
    ? `[${v.map((x) => (x === undefined ? 'undefined' : JSON.stringify(x))).join(', ')}]`
    : String(v);

const show = (name, plan) => {
  const got = toArray(plan, g);
  console.log(`${name.padEnd(36)} ${got.length} rows  ${got.map(render).join('  ')}`);
};

show('path().by(n)', traversal(V(), out('E'), path().by('n')));
show('path().by(opt)  [b absent, c null]', traversal(V(), out('E'), path().by('opt')));
show('values(opt) for contrast', traversal(V(), out('E'), values('opt')));
show('path().by(n).by(opt)  TWO bys', traversal(V(), out('E'), path().by('n').by('opt')));
// An INHERITED name: `evalBy` uses Object.hasOwn, so this must NOT leak a prototype function.
show('path().by(toString)', traversal(V(), out('E'), path().by('toString')));
