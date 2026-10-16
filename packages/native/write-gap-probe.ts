// Item 442: the two-engine gap screen, for WRITES.
//
// `engine-gap-probe` (item 434) covers 25 READ shapes and found two correctness divergences there
// — item 435's dropped `ANY SHORTEST` label and item 436's unparseable nested aggregate — and no
// perf candidate. It has never been pointed at a write. `INSERT`, `SET`, `REMOVE`, `DELETE`,
// `DETACH DELETE` and `_MERGE` are a whole family it does not reach.
//
// A write probe needs two things the read one did not:
//
//   - A FRESH GRAPH PER CASE, because a write is not idempotent and a case that mutates would
//     change what the next one measures. Both engines are rebuilt from the same NDJSON per case,
//     so neither can disagree about the starting state.
//   - A VERIFICATION QUERY, because a write's answer is the graph it leaves behind, not the rows
//     it returns. Each case names a read that must agree afterwards — and the agreement check is
//     the part with the track record, not the timing.
//
// The timing is a SCREEN, with the same caveats item 434 records: one process per side, so a 30%
// difference means nothing, and native's row egress (58-94 ns a row) makes any multi-row result
// incomparable. Writes mostly return no rows, which is why they are comparable at all.
import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

import { nativeBackend } from './src/conformance-harness.js';
import { graphFromNdjson } from './src/graph.js';

const N = Number(process.env.PROBE_N ?? 20_000);
const DEG = 2;
const REPS = Number(process.env.PROBE_REPS ?? 3);

const spec = Array.from({ length: N }, (_, i) => ({
  labels: i % 10 === 0 ? ['P', 'Univ'] : ['Univ'],
  props: { k: i % 7, u: `u${String(i).padStart(6, '0')}` },
}));
let x = 12345;
const rnd = (): number => {
  x ^= x << 13;
  x ^= x >>> 7;
  x ^= x << 17;

  return (x >>> 0) % N;
};
const edges: Array<[number, number]> = [];

for (let i = 0; i < N; i++) {
  for (let d = 0; d < DEG; d++) {
    edges.push([i, rnd()]);
  }
}

const ndjson = (() => {
  const lines = spec.map((v, i) =>
    JSON.stringify({ type: 'vertex', id: `v${i}`, labels: v.labels, properties: v.props }),
  );

  for (const [i, [from, to]] of edges.entries()) {
    lines.push(
      JSON.stringify({
        type: 'edge',
        id: `e${i}`,
        from: `v${from}`,
        to: `v${to}`,
        labels: ['E'],
        properties: { w: i % 5 },
      }),
    );
  }

  return `${lines.join('\n')}\n`;
})();

const freshTs = (): Graph => {
  const g = new Graph();
  const ids = spec.map((v) => g.addVertex({ labels: v.labels, properties: v.props }));

  for (const [i, [from, to]] of edges.entries()) {
    g.addEdge({ from: ids[from], to: ids[to], labels: ['E'], properties: { w: i % 5 } });
  }

  return g;
};

/** A write and the read that must agree about what it left behind. */
const cases: Array<[string, string, string]> = [
  [
    'SET one prop',
    'MATCH (a:P) SET a.k = 99',
    'MATCH (a:Univ) WHERE a.k = 99 RETURN count(*) AS c',
  ],
  [
    'SET two props',
    'MATCH (a:P) SET a.k = 99, a.extra = 1',
    'MATCH (a:Univ) WHERE a.extra = 1 RETURN count(*) AS c',
  ],
  ['SET from a prop', 'MATCH (a:P) SET a.k = a.k + 1', 'MATCH (a:P) RETURN sum(a.k) AS c'],
  [
    'SET a new prop',
    'MATCH (a:P) SET a.fresh = a.u',
    'MATCH (a:Univ) WHERE a.fresh IS NOT NULL RETURN count(*) AS c',
  ],
  ['REMOVE a prop', 'MATCH (a:P) REMOVE a.k', 'MATCH (a:P) RETURN count(a.k) AS c'],
  [
    'SET on an edge',
    'MATCH (a:P)-[e:E]->(b) SET e.w = 42',
    'MATCH (a)-[e:E]->(b) WHERE e.w = 42 RETURN count(*) AS c',
  ],
  [
    'INSERT nodes',
    'INSERT (:New {k: 1}), (:New {k: 2}), (:New {k: 3})',
    'MATCH (a:New) RETURN count(*) AS c',
  ],
  [
    'INSERT an edge',
    'MATCH (a:P) INSERT (a)-[:F {w: 1}]->(:Tail)',
    'MATCH (a)-[:F]->(b:Tail) RETURN count(*) AS c',
  ],
  ['DELETE nodes', 'MATCH (a:P) DETACH DELETE a', 'MATCH (a:Univ) RETURN count(*) AS c'],
  ['DELETE edges', 'MATCH (a:P)-[e:E]->(b) DELETE e', 'MATCH (a)-[:E]->(b) RETURN count(*) AS c'],
  [
    '_MERGE existing',
    'MATCH (a:P) _MERGE (a)-[:E]->(a)',
    'MATCH (a)-[:E]->(b) RETURN count(*) AS c',
  ],
];

/**
 * Time ONLY the write. `setup` builds a fresh graph OUTSIDE the clock and `run` performs the
 * write inside it.
 *
 * The first version of this probe timed `setup` and `run` together, and every one of the ten
 * shapes came back between 3.1x and 4.0x — a suspiciously flat band that is the tell: it was
 * measuring graph CONSTRUCTION (20,000 nodes and 40,000 edges, rebuilt per rep), which the write
 * barely moves. An instrument whose rows all agree to within a third is usually measuring
 * something they have in common.
 */
const timed = <G>(setup: () => G, run: (g: G) => void, reps: number): number => {
  let best = Number.POSITIVE_INFINITY;

  for (let r = 0; r < reps; r++) {
    // A fresh graph per rep, because a write is not idempotent: `SET k = 99` on a row that
    // already holds 99 is a different operation the second time.
    const g = setup();
    const t0 = performance.now();

    run(g);

    const t = performance.now() - t0;

    if (t < best) {
      best = t;
    }
  }

  return best;
};

const only = process.env.PROBE_ONLY;

console.log(`${N} nodes, ${N * DEG} edges, fresh graph per case, min of ${REPS} — a SCREEN`);
console.log('shape              ts ms   native ms    nat/ts   verify');

for (const [name, write, verify] of only === undefined
  ? cases
  : cases.filter(([n]) => n.includes(only))) {
  let tsMs = Number.NaN;
  let natMs = Number.NaN;
  let tsAnswer = 'n/a';
  let natAnswer = 'n/a';

  try {
    // Each rep gets its OWN graph: a write is not idempotent, so timing it twice on one graph
    // measures a different operation the second time (`SET k = 99` on a row that already holds
    // 99, for instance).
    tsMs = timed(
      freshTs,
      (g) => {
        tsQuery(g, write);
      },
      REPS,
    );
  } catch (e) {
    tsAnswer = `TS ERROR ${(e as Error).message.slice(0, 40)}`;
  }

  try {
    natMs = timed(
      () => graphFromNdjson(nativeBackend(), ndjson),
      (nat) => {
        nat.query(write);
      },
      REPS,
    );
  } catch (e) {
    natAnswer = `NATIVE ERROR ${(e as Error).message.slice(0, 36)}`;
  }

  // The VERIFY runs once per engine OUTSIDE the clock. It was inside it at first, which for
  // `DETACH DELETE` meant the row counted a write plus a full count over what the write left —
  // and that is the one case where the verify is not negligible.
  try {
    const g = freshTs();

    tsQuery(g, write);
    tsAnswer = JSON.stringify(tsQuery(g, verify));
  } catch (e) {
    tsAnswer = `TS ERROR ${(e as Error).message.slice(0, 40)}`;
  }

  try {
    const nat = graphFromNdjson(nativeBackend(), ndjson);

    nat.query(write);
    natAnswer = JSON.stringify(nat.query(verify));
  } catch (e) {
    natAnswer = `NATIVE ERROR ${(e as Error).message.slice(0, 36)}`;
  }

  const ratio = natMs > 0 ? tsMs / natMs : Number.NaN;
  const agree = tsAnswer === natAnswer ? 'yes' : `NO  ts=${tsAnswer} nat=${natAnswer}`;

  console.log(
    `${name.padEnd(18)}${tsMs.toFixed(1).padStart(7)}${natMs.toFixed(2).padStart(12)}` +
      `${(Number.isFinite(ratio) ? ratio.toFixed(1) : '-').padStart(10)}x   ${agree}`,
  );
}
