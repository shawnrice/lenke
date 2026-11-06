/**
 * Multi-hop COUNT, both surfaces (item 1592).
 *
 * `bench:gremlin` shows the widest ts/native ratios in the whole corpus here, and they grow with
 * depth while the 1-hop case is answered in CLOSED FORM:
 *
 *     V().out().count()                 0.0 ms    <- a degree sum, no walk
 *     V().out().out().count()          53         18.5x native
 *     V().out().out().out().count()   239         47x
 *     V().out()x4.count()             231         35x
 *
 * ⚠️ So the question is not "why is a 3-hop count slow" — it is whether the 1-hop shortcut simply
 * stops at depth 1 on one surface while the other carries it deeper. GQL has `two-hop-count`,
 * `three-hop-count` and `four-hop-count` test files, which suggests it does. Item 1590's method
 * says: find the fast side first, then profile it.
 *
 * Answers are asserted equal at every depth, because a count that shortcuts WRONG is the failure
 * mode this family has had before (`two-hop-count-bucket-size`).
 *
 *     node multihop-count-compare.mjs
 *     DEPTH=3 ARM=gql  node --cpu-prof --cpu-prof-dir=DIR multihop-count-compare.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import * as G from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 20_000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const REPS = Number(process.env.REPS ?? 9);
const ARM = process.env.ARM ?? 'both';
const ONLY_DEPTH = process.env.DEPTH === undefined ? undefined : Number(process.env.DEPTH);

const g = new Graph();
const vs = [];

for (let i = 0; i < NODES; i += 1) {
  vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97 } }));
}

// Split on the REPEAT INDEX: `(i * a + b) % N` is invariant under `i -> i + N`, so a flat loop
// would point all of one vertex's edges at the same target and leave the graph FUNCTIONAL — which
// makes every k-hop count exactly `F^k * N` by construction and validates nothing (CLAUDE.md,
// items 1516/1518).
for (let rep = 0; rep < FANOUT; rep += 1) {
  for (let i = 0; i < NODES; i += 1) {
    g.addEdge({
      id: `e${rep}_${i}`,
      from: vs[i],
      to: vs[(i * 7919 + rep * 104_729 + 1) % NODES],
      labels: ['E'],
    });
  }
}

{
  const seen = new Set();
  const outDeg = new Map();

  for (const e of g.edges) {
    seen.add(e.to.id);
    outDeg.set(e.from.id, (outDeg.get(e.from.id) ?? 0) + 1);
  }

  const degs = [...outDeg.values()];
  const branching = degs.filter((d) => d > 1).length;

  // ⚠️ COUNT THE DISTINCT ENDPOINTS AND THE BRANCHING, not just the answer: a k-hop count is
  // `F^k * N` for ANY functional graph, so the answer cannot validate the fixture.
  console.log(
    `fixture: ${NODES} vertices, ${g.edgeCount} edges, ${seen.size} distinct targets, ` +
      `${branching} vertices with out-degree > 1\n`,
  );

  if (seen.size < NODES * 0.5 || branching < NODES * 0.5) {
    throw new Error('fixture is degenerate — a k-hop count off it would prove nothing');
  }
}

const SHAPES = [1, 2, 3, 4].map((depth) => ({
  depth,
  gql: `MATCH (a:P)${'-[:E]->()'.repeat(depth - 1)}-[:E]->(b) RETURN count(*) AS c`,
  grem: G.traversal(G.V(), ...Array.from({ length: depth }, () => G.out('E')), G.count()),
}));

const time = (fn) => {
  const s = [];

  for (let i = 0; i < REPS; i += 1) {
    const t0 = performance.now();

    fn();
    s.push(performance.now() - t0);
  }

  const kept = s.slice(2).sort((a, b) => a - b);

  return kept[Math.floor(kept.length / 2)] ?? 0;
};

for (const { depth, gql, grem } of SHAPES) {
  if (ONLY_DEPTH !== undefined && depth !== ONLY_DEPTH) {
    continue;
  }

  const runGql = () => {
    const rows = query(g, gql);

    return Array.isArray(rows) ? Number(Object.values(rows[0] ?? {})[0]) : null;
  };
  const runGrem = () => {
    const rows = G.toArray(grem, g);

    return Array.isArray(rows) ? Number(rows[0]) : null;
  };

  if (ARM === 'gql') {
    console.log(
      JSON.stringify({ depth, arm: 'gql', answer: runGql(), ms: Number(time(runGql).toFixed(3)) }),
    );
    continue;
  }

  if (ARM === 'grem') {
    console.log(
      JSON.stringify({
        depth,
        arm: 'grem',
        answer: runGrem(),
        ms: Number(time(runGrem).toFixed(3)),
      }),
    );
    continue;
  }

  const a1 = runGql();
  const a2 = runGrem();
  const q = Math.min(time(runGql), time(runGql));
  const r = Math.min(time(runGrem), time(runGrem));

  console.log(
    `depth ${depth}  gql ${q.toFixed(3).padStart(9)}ms  gremlin ${r.toFixed(3).padStart(9)}ms  ` +
      `${(Math.max(q, r) / Math.min(q, r)).toFixed(1)}x ${q > r ? 'GQL' : 'gremlin'} slower  ` +
      `answers ${a1 === a2 ? `agree (${a1})` : `DISAGREE gql=${a1} grem=${a2}`}`,
  );
}
