/**
 * Which `count(DISTINCT …)` over a hop reaches the dedup-while-walking rung? (item 1583)
 *
 * `cross-surface-probe` flagged `MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b)` at ~30 ms against
 * Gremlin's `V().hasLabel(P).out(E).dedupe().count()` at 0.55 — 56x, both answering 50,000
 * (item 1581). `detectDistinctCount` exists and is documented for
 * `count(DISTINCT <one expression over one end>)`, so the question is not "is there a rung" but
 * "which spelling misses it".
 *
 * The suspicion this is built to test: the flagged query dedups on the NODE ITSELF, where every
 * shape the rung's doc describes dedups on a PROPERTY of a node. If `b.k` is fast and `b` is slow,
 * the gap is node-identity dedup and not the hop.
 *
 * ⚠️ ONE ARM PER PROCESS (`ARM=`). Items 1578/1579 each produced an impossible in-process reading
 * when arms shared a call site, and item 762's warning applies with full force to a
 * rung-selection question: in a two-arm process the arm routed elsewhere leaves a cleaner
 * dispatch site behind and flatters itself.
 *
 *     for a in nodeid prop uniqprop startnode startprop nodedistinctrows; do
 *       ARM=$a node hop-distinct-probe.mjs; done
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 50_000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const REPS = Number(process.env.REPS ?? 15);
const ARM = process.env.ARM ?? 'nodeid';

const g = new Graph();
const vs = [];

for (let i = 0; i < NODES; i += 1) {
  vs.push(
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { k: i % 97, n: i },
    }),
  );
}

// Split on the REPEAT INDEX: `(i * a + b) % N` is invariant under `i -> i + N`, so a flat loop
// points all of one vertex's edges at the SAME target and the graph comes out functional.
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

  for (const e of g.edges) {
    seen.add(e.to.id);
  }

  // Count the DISTINCT endpoints before trusting any number off this fixture: a generator whose
  // targets collapse makes every k-hop answer `F^k * N` by construction and looks perfect on
  // out-degree alone (CLAUDE.md, items 1516/1518).
  if (seen.size < NODES * 0.5) {
    throw new Error(`fixture is degenerate: ${seen.size} distinct targets of ${NODES}`);
  }
}

const ARMS = {
  /** The flagged shape: dedup on the NODE at the far end. */
  nodeid: 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b) AS c',
  /** The same hop, dedup on a LOW-cardinality property of the far end (97 groups). */
  prop: 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b.k) AS c',
  /** The same hop, dedup on a UNIQUE property, so the set is as large as the node-id one. */
  uniqprop: 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b.n) AS c',
  /** Dedup on the START node instead, which is the other end the rung can key on. */
  startnode: 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT a) AS c',
  startprop: 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT a.n) AS c',
  /** The ROWS spelling of the node-identity question, for comparison with the count. */
  nodedistinctrows: 'MATCH (a:P)-[:E]->(b) RETURN DISTINCT b',
  /** Controls: a plain hop count, and a node-only distinct count. */
  hopcount: 'MATCH (a:P)-[:E]->(b) RETURN count(*) AS c',
  nodeonly: 'MATCH (n:P) RETURN count(DISTINCT n) AS c',
  nodeonlyprop: 'MATCH (n:P) RETURN count(DISTINCT n.n) AS c',
  // ⚠️ THE CONTROLS THAT MATTER MOST for item 1583's change: shapes `hopAggregate` STILL claims.
  // The gate nulls `hopAggregate` only when `distinctCount` accepts, so a non-DISTINCT aggregate
  // over the same hop must be untouched. item 418 measured a branch ahead of a hot dispatch
  // costing the shape it does not claim 1.12x, and these are that shape.
  hopmax: 'MATCH (a:P)-[:E]->(b) RETURN max(b.k) AS m',
  hopmin: 'MATCH (a:P)-[:E]->(b) RETURN min(b.n) AS m',
  hopsum: 'MATCH (a:P)-[:E]->(b) RETURN sum(b.k) AS s',
  hopmulti: 'MATCH (a:P)-[:E]->(b) RETURN count(*) AS c, max(b.k) AS m',
  // A hop projection, the other rung that shares `detectHopProjection`'s walk.
  hopproj: 'MATCH (a:P)-[:E]->(b) RETURN b.k AS k',
};

const text = ARMS[ARM];

if (text === undefined) {
  throw new Error(`unknown arm ${ARM}; have ${Object.keys(ARMS).join(',')}`);
}

const run = () => query(g, text);
const rows = run();
const s = [];

for (let i = 0; i < REPS; i += 1) {
  const t0 = performance.now();

  run();
  s.push(performance.now() - t0);
}

// 15 reps, drop the first three as warm-up, MEDIAN of the rest. `min` reports a rare fast rep off
// the general scalar path, and item 1582 showed a 9-rep median landing on the wrong mode of a
// bimodal series — so the series is printed too.
const kept = s.slice(3).sort((a, b) => a - b);
const scalarOf = (rs) => (rs.length === 1 ? Object.values(rs[0] ?? {})[0] : `${rs.length} rows`);
const answer = Array.isArray(rows) ? scalarOf(rows) : null;

console.log(
  JSON.stringify({
    arm: ARM,
    gql: text,
    answer,
    ms: Number((kept[Math.floor(kept.length / 2)] ?? 0).toFixed(3)),
    series: s.map((x) => Number(x.toFixed(1))),
  }),
);
