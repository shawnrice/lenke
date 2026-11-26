// Item 1922 — `V().out(T).tree()` is the Gremlin surface's largest shape by 4x: **1294.12 ms for ONE
// ROW** at 200,000 vertices / 800,000 edges, where the plain hop over the same edges is 50.21.
//
// THE SUSPECT IS THE KEY, NOT THE TREE. `treeStep` keys every level by
// `JSON.stringify(node.toJSON())` — the canonical `{id, labels, properties}` rendering that is the
// documented byte-identity contract with the Rust engine. For 600,000 paths of length two that is
// **1,200,000 canonical serializations**, and the same vertex recurs constantly: there are only
// 200,000 distinct ones, each appearing as a near end and as several far ends.
//
// SO THE QUESTION IS WHETHER A PER-ELEMENT MEMO COLLAPSES THEM, and the arms below measure the
// parts separately rather than assuming: the tree of 600,000 paths, the same walk with no tree, and
// the raw cost of the key function over the same elements with and without a memo.
//
//     SHAPE=tree|path|hop|treeby bun --cpu-prof tree-prof-1922.mjs
//
// ONE SHAPE PER PROCESS, and profile at a high REPS or the profile is the fixture build.
import { Graph } from '@lenke/core';
import { V, out, path, toArray, traversal, tree, values } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 4);
const REPS = Number(process.env.REPS ?? 7);
const SHAPE = process.env.SHAPE ?? 'tree';

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['P'], properties: { n: i % 8, k: i % 50 } });
}

for (let e = 0; e < N * FANOUT; e += 1) {
  const i = e % N;
  const hop = Math.floor(e / N);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(String(i + 1)),
    // Splits on the REPEAT INDEX — CLAUDE.md's functional-graph fix.
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % N) + 1)),
    labels: hop % 4 === 3 ? ['F'] : ['E'],
    properties: { w: e % 7 },
  });
}

const SHAPES = {
  // THE TARGET: one row, a nested map of 600,000 two-element paths.
  tree: traversal(V(), out('E'), tree()),
  // THE FLOOR THAT ISOLATES THE KEY: `path()` builds the SAME 600,000 two-element paths and does
  // NOT serialize anything (item 1920 fused it to 8.40 ms). So `tree - path` is the tree machinery
  // plus the keys, with the walk and the path construction already paid.
  path: traversal(V(), out('E'), path()),
  // The walk with no path and no tree at all.
  hop: traversal(V(), out('E'), values('n')),
  // A `by(k)` MODULATOR SKIPS `treeKey` ENTIRELY — it stringifies the modulator value instead. If
  // this is far cheaper than the bare `tree()`, the canonical-JSON key IS the cost, measured rather
  // than reasoned about.
  treeby: traversal(V(), out('E'), tree().by('k')),
};

const plan = SHAPES[SHAPE];
const ser = [];
let rows = 0;

for (let r = 0; r < REPS + 2; r += 1) {
  const t0 = performance.now();
  const out_ = toArray(plan, g);
  const ms = performance.now() - t0;

  rows = out_.length;

  if (r >= 2) {
    ser.push(ms);
  }
}

ser.sort((a, b) => a - b);

console.log(
  `${SHAPE.padEnd(7)} N=${N} reps=${REPS}  median ${ser[ser.length >> 1].toFixed(2)} ms  ` +
    `min ${ser[0].toFixed(2)}  rows ${rows}`,
);
console.log(`  series ${ser.map((x) => x.toFixed(1)).join(' ')}`);
