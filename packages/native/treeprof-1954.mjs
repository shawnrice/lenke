// Item 1954 — `V().out('E').tree()` is the Gremlin screen's largest absolute cost by 3.4x.
//
// At NODES=200000 FANOUT=5 the screen reads:
//
//     680.08 ms      1 row   pathdep: tree
//     200.91         2       pathdep: cyclicPath
//     114.67    800000       pathdep: path().by(k)      <- the same 800,000 paths, 6x cheaper
//
// A tree over 800,000 two-element paths is real work, but SIX TIMES its own `path()` twin on the
// same traversal is a ratio worth a profile rather than an assumption. A read is idempotent, so one
// graph serves every round and the fixture stays OUT of the profile (item 1933's rule).
//
//     bun --cpu-prof --cpu-prof-dir=<dir> treeprof-1954.mjs
//     SHAPE=path bun ... treeprof-1954.mjs      # the twin, as a control
import { Graph } from '@lenke/core';
import { out, path, toArray, traversal, tree, V, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const ROUNDS = Number(process.env.ROUNDS ?? 7);
const SHAPE = process.env.SHAPE ?? 'tree';

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 12 } });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  // Split on the REPEAT INDEX — the generator trap CLAUDE.md records.
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${String(e)}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
    labels: ['E'],
    properties: {},
  });
}

const BUILD = {
  tree: () => traversal(V(), out('E'), tree()),
  path: () => traversal(V(), out('E'), path().by('n')),
  values: () => traversal(V(), out('E'), values('n')),
};

const build = BUILD[SHAPE] ?? BUILD.tree;
let n = 0;
const t0 = performance.now();

for (let r = 0; r < ROUNDS; r += 1) {
  n = toArray(build(), g).length;
}

const ms = performance.now() - t0;

console.log(
  `${SHAPE}\t${String(ROUNDS)} rounds\t${(ms / ROUNDS).toFixed(1)} ms/round\t${String(n)} results`,
);
