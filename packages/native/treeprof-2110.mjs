/*
 * Item 2110 — the profile behind `pathdep: tree`, the Gremlin screen's largest shape.
 *
 * WHAT NOMINATED IT, and the denominator check that survived. The workload screen at 200,000 / fanout
 * 5, isolated with `ONLY=` so the shape has a process to itself:
 *
 * ```text
 *     pathdep: tree                  681.59 ms   1 row       852 ns/path
 *     sideeffect: store pass-through 239.67      800,000
 *     pathdep: path().by(k)          106.04      800,000     133 ns/path
 * ```
 *
 * `tree()` RETURNS ONE ROW, so the absolute is meaningless on its own — item 2096's headline was 8x
 * row count. Divided by the 800,000 paths both shapes walk, `tree` costs **852 ns/path against `path`'s
 * 133 — 6.4x for the same traversal**. That is the finding worth profiling.
 *
 * THREE CANDIDATES, AND THEY WANT DIFFERENT FIXES:
 *   (a) the per-path TREE INSERT — a nested map walked and extended once per path;
 *   (b) the PATH MATERIALIZATION the tree is built from, which `path().by(k)` also pays (so if this
 *       dominates, the two shapes should be closer than 6.4x and the gap is elsewhere);
 *   (c) the final RENDERING of the nested structure into one row.
 *
 * (c) IS THE ONE A PROFILE CAN MISATTRIBUTE, because it runs once and is cheap per path but may walk
 * the whole structure. `SHAPE=path` is the control — the same walk WITHOUT the tree — and the difference
 * between the two profiles is what (a) plus (c) costs.
 *
 * A read is idempotent, so one graph serves every round and the fixture stays OUT of the profile
 * (item 1933's rule).
 *
 *     bun --cpu-prof --cpu-prof-dir=<dir> treeprof-2110.mjs
 *     SHAPE=path bun --cpu-prof --cpu-prof-dir=<dir> treeprof-2110.mjs    # the CONTROL
 */
import { Graph } from '@lenke/core';
import { out, path, toArray, traversal, tree, V, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const ROUNDS = Number(process.env.ROUNDS ?? 5);
const SHAPE = process.env.SHAPE ?? 'tree';

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i % 97, k: `k${i % 1000}` } });
}

/*
 * THE TARGET IS SPLIT ON THE REPEAT INDEX, not on `k % NODES`. CLAUDE.md's generator rule: `(a*k+b)
 * % N` is invariant under `k -> k + N`, so a loop over `NODES * FANOUT` sends all of one vertex's edges
 * to the SAME target and the graph is functional — every k-hop count becomes `F^k * N` by construction.
 */
let e = 0;

for (let d = 0; d < FANOUT; d += 1) {
  for (let i = 0; i < NODES; i += 1) {
    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(`v${i}`),
      to: g.getVertexById(`v${(i * 7 + 3 + d * 104_729) % NODES}`),
      labels: ['E'],
      properties: {},
    });
    e += 1;
  }
}

/* Count the DISTINCT endpoints before trusting any number from this fixture — CLAUDE.md item 1516. */
const targets = new Set();

for (const edge of g.edgesById.values()) {
  targets.add(edge.to.id);
}

const shapes = {
  /* THE SUBJECT: one row out, 800,000 paths walked. */
  tree: () => traversal(V(), out('E'), tree()),
  /* THE CONTROL: the SAME walk, materializing paths but building no tree. */
  path: () => traversal(V(), out('E'), path()),
  /* A SECOND CONTROL: the walk with NO path machinery at all, to price the walk itself. */
  bare: () => traversal(V(), out('E'), values('n')),
};

const build = shapes[SHAPE];

if (build === undefined) {
  throw new Error(`unknown SHAPE ${SHAPE}; one of ${Object.keys(shapes).join(', ')}`);
}

// The plan is built ONCE, outside the loop — the screen does the same, so compile cost is not timed.
const plan = build();

console.log(
  `  SHAPE=${SHAPE}  vertices=${NODES} edges=${e} distinct targets=${targets.size} (${((100 * targets.size) / NODES).toFixed(1)}%)`,
);

const series = [];
let rows = 0;

for (let r = 0; r < ROUNDS; r += 1) {
  const t0 = performance.now();
  const got = toArray(plan, g);

  series.push(performance.now() - t0);
  rows = Array.isArray(got) ? got.length : 1;
}

const sorted = [...series].sort((a, b) => a - b);

console.log(`  rows=${rows}  median ${sorted[Math.floor(sorted.length / 2)].toFixed(2)} ms`);
console.log(`  per-rep: ${series.map((v) => v.toFixed(1)).join(' ')}`);
console.log(
  `  per PATH (NODES*FANOUT): ${((sorted[Math.floor(sorted.length / 2)] * 1e6) / (NODES * FANOUT)).toFixed(1)} ns`,
);
