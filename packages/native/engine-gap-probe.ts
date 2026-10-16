// Item 434: WHERE DOES ONE ENGINE HAVE A PATH THE OTHER LACKS?
//
// Item 433's lesson was that the TS engine had carried per-hop directions on its 3-hop product
// since item 298 while the Rust one declined them with a comment explaining why it could not —
// and twelve items passed before anyone looked, because the session's habit is to fix TS and then
// ask native the same question. The instrument that would have found it in one run is this: time
// the SAME shape on both engines and look at the RATIO.
//
// `CLAUDE.md` puts the normal band at "the Rust core is 1.5-4x pure-TS depending on workload",
// and a shortcut native has and TS does not pushes it far above that (the 3-hop count ran 50x).
// So the rows worth reading are the ones where the ratio is UNUSUALLY LOW — native barely ahead,
// or behind — because that is where TS has something native does not.
//
// This is a SCREEN, not a measurement. Everything runs in one process, so the TS column carries
// the bimodality item 424 recorded and a 30% difference here means nothing; the ratio has to be
// off by a factor before it is worth isolating. Any row it flags gets its own one-shape-per-
// process run before anything is believed, which is how items 420, 421, 423 and 431 all went
// wrong in the other direction.
import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

import { nativeBackend } from './src/conformance-harness.js';
import { graphFromNdjson } from './src/graph.js';

const N = Number(process.env.PROBE_N ?? 50_000);
const DEG = 3;
const REPS = Number(process.env.PROBE_REPS ?? 5);

// `:P` on a tenth so a label narrows; `k` low-cardinality for grouping; `u` unique for ordering
// and for a selective predicate; `s` a short categorical string.
const spec = Array.from({ length: N }, (_, i) => ({
  labels: i % 10 === 0 ? ['P', 'Univ'] : ['Univ'],
  props: { k: i % 7, u: `u${String(i).padStart(7, '0')}`, s: `c${i % 97}` },
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

const tsGraph = new Graph();
const ids = spec.map((v) => tsGraph.addVertex({ labels: v.labels, properties: v.props }));

for (const [from, to] of edges) {
  tsGraph.addEdge({ from: ids[from], to: ids[to], labels: ['E'], properties: {} });
}

const ndjson = (): string => {
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
        properties: {},
      }),
    );
  }

  return `${lines.join('\n')}\n`;
};

const nat = graphFromNdjson(nativeBackend(), ndjson());

const timed = (run: () => unknown): { ms: number; rows: number; first: string } => {
  let best = Number.POSITIVE_INFINITY;
  let rows = 0;
  let first = '';

  for (let r = 0; r < REPS; r++) {
    const t0 = performance.now();
    const out = run() as unknown[];
    const t = performance.now() - t0;

    rows = out.length;
    first = JSON.stringify(out[0] ?? null);

    if (t < best) {
      best = t;
    }
  }

  return { ms: best, rows, first };
};

const shapes: Array<[string, string]> = [
  ['node count', 'MATCH (a:P) RETURN count(*) AS c'],
  ['1hop count', 'MATCH (a:P)-[:E]->(b) RETURN count(*) AS c'],
  ['1hop filtered', 'MATCH (a:P)-[:E]->(b) WHERE b.k = 2 RETURN count(*) AS c'],
  ['scan max num', 'MATCH (a:P) RETURN max(a.k) AS m'],
  ['scan max str', 'MATCH (a:P) RETURN max(a.s) AS m'],
  ['scan sum', 'MATCH (a:P) RETURN sum(a.k) AS m'],
  ['hop max', 'MATCH (a:P)-[:E]->(b) RETURN max(b.k) AS m'],
  ['scan project', 'MATCH (a:P) RETURN a.u AS u'],
  ['hop project', 'MATCH (a:P)-[:E]->(b) RETURN b.u AS u'],
  ['order limit', 'MATCH (a:P) RETURN a.u AS u ORDER BY u LIMIT 5'],
  ['order desc limit', 'MATCH (a:P) RETURN a.u AS u ORDER BY u DESC LIMIT 5'],
  ['deep skip', `MATCH (a:P) RETURN a.u AS u SKIP ${Math.floor(N / 10) - 5} LIMIT 5`],
  ['distinct', 'MATCH (a:P) RETURN DISTINCT a.k AS k'],
  ['distinct count', 'MATCH (a:P) RETURN count(DISTINCT a.k) AS c'],
  ['grouped count', 'MATCH (a:P) RETURN a.k AS k, count(*) AS c'],
  ['grouped hop count', 'MATCH (a:P)-[:E]->(b) RETURN b.k AS k, count(*) AS c'],
  ['grouped max', 'MATCH (a:P) RETURN a.k AS k, max(a.u) AS m'],
  ['exists', 'MATCH (a:P) WHERE EXISTS { MATCH (a)-[:E]->(b) } RETURN count(*) AS c'],
  ['seek eq', "MATCH (a:Univ) WHERE a.u = 'u0000042' RETURN count(*) AS c"],
  ['range', 'MATCH (a:Univ) WHERE a.k > 5 RETURN count(*) AS c'],
  ['2hop count', 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN count(*) AS c'],
  ['varlen reach', 'MATCH (a:P)-[:E]->{1,2}(b) RETURN count(DISTINCT b) AS c'],
  // --- families the first 22 shapes did not reach (item 435). Every one returns ONE row, so
  // the egress confound below does not apply and the ratio can be read.
  ['undirected hop', 'MATCH (a:P)-[:E]-(b) RETURN count(*) AS c'],
  ['self join', 'MATCH (a:P)-[:E]->(b)<-[:E]-(a) RETURN count(*) AS c'],
  ['varlen 1..3 count', 'MATCH (a:P)-[:E]->{1,3}(b) RETURN count(*) AS c'],
  ['varlen distinct', 'MATCH (a:P)-[:E]->{1,3}(b) RETURN count(DISTINCT b) AS c'],
  ['shortest', 'MATCH ANY SHORTEST (a:P)-[:E]->{1,4}(b:P) RETURN count(*) AS c'],
  [
    'call subquery',
    'MATCH (a:P) CALL (a) { MATCH (a)-[:E]->(b) RETURN count(*) AS n } RETURN sum(n) AS c',
  ],
  ['union', 'MATCH (a:P) RETURN count(*) AS c UNION ALL MATCH (a:Univ) RETURN count(*) AS c'],
  ['case expr', 'MATCH (a:Univ) RETURN count(CASE WHEN a.k > 3 THEN 1 ELSE null END) AS c'],
  ['coalesce', 'MATCH (a:Univ) RETURN count(coalesce(a.missing, a.k)) AS c'],
  ['string fn', "MATCH (a:Univ) WHERE upper(a.s) = 'C42' RETURN count(*) AS c"],
  ['arith pred', 'MATCH (a:Univ) WHERE a.k * 2 + 1 > 7 RETURN count(*) AS c'],
  ['or pred', 'MATCH (a:Univ) WHERE a.k = 1 OR a.k = 5 RETURN count(*) AS c'],
  ['in list', 'MATCH (a:Univ) WHERE a.k IN [1, 5] RETURN count(*) AS c'],
  ['not pred', 'MATCH (a:Univ) WHERE NOT (a.k = 1) RETURN count(*) AS c'],
  ['is null', 'MATCH (a:Univ) WHERE a.missing IS NULL RETURN count(*) AS c'],
  ['two labels', 'MATCH (a:P) MATCH (b:P) WHERE a.k = b.k RETURN count(*) AS c'],
  ['stddev', 'MATCH (a:Univ) RETURN stddev_pop(a.k) AS m'],
  ['percentile', 'MATCH (a:Univ) RETURN percentile_cont(a.k, 0.5) AS m'],
  ['collect size', 'MATCH (a:P) RETURN size(collect(a.k)) AS c'],
  ['having', 'MATCH (a:Univ) LET g = a.k RETURN count(*) AS c GROUP BY g HAVING count(*) > 0'],
  // EGRESS CONTROL. These three do the same SCAN work and differ only in how many rows leave the
  // engine: one, 5,000 numbers, 5,000 strings. Native's row egress crosses the FFI boundary and
  // builds a JS object per row, which TS never pays — so any row-returning shape above is
  // measuring the harness as much as the engine, and the ratio there means nothing.
  ['egress 1 row', 'MATCH (a:P) RETURN count(a.u) AS c'],
  ['egress 5k num', 'MATCH (a:P) RETURN a.k AS k'],
  ['egress 5k str', 'MATCH (a:P) RETURN a.u AS u'],
];
/** `  ` a row whose ratio can be read, `*` multi-row (FFI egress), `~` too fast to compare. */
const flag = (comparable: boolean, measurable: boolean): string => {
  if (comparable) {
    return '  ';
  }

  return measurable ? ' *' : ' ~';
};
const only = process.env.PROBE_ONLY;

console.log(`${N} nodes, ${N * DEG} edges, min of ${REPS} — ONE PROCESS, so this is a SCREEN`);
console.log(
  'shape                 ts ms   native ms    nat/ts     agree' +
    '   (* multi-row: ratio is mostly FFI egress; ~ too fast to compare)',
);

for (const [name, q] of only === undefined ? shapes : shapes.filter(([n]) => n.includes(only))) {
  let ts: ReturnType<typeof timed>;
  let nt: ReturnType<typeof timed>;

  try {
    ts = timed(() => tsQuery(tsGraph, q));
  } catch (e) {
    console.log(`${name.padEnd(20)}  TS ERROR ${(e as Error).message.slice(0, 50)}`);
    continue;
  }

  try {
    nt = timed(() => nat.query(q));
  } catch (e) {
    console.log(`${name.padEnd(20)}  NATIVE ERROR ${(e as Error).message.slice(0, 46)}`);
    continue;
  }

  // `nat/ts` BELOW the 1.5-4x band is the signal: TS has something native does not — but ONLY
  // for a shape that returns ONE row. Native's egress crosses the FFI boundary and builds a JS
  // object per row, measured here at 58 ns a numeric row and 94 ns a string one against a 0.01 ms
  // scan, where TS hands back objects it already had. So a multi-row shape's ratio is mostly the
  // harness and is marked `(egress)` rather than read.
  const ratio = nt.ms > 0 ? ts.ms / nt.ms : Number.POSITIVE_INFINITY;
  // A ratio needs BOTH sides above the clock's resolution. `node count` is a shortcut on both and
  // reads 0.0 against 0.00, which divides to a meaningless 0.5x — presented unmarked, that is a
  // row someone would chase.
  const measurable = ts.ms >= 0.05 && nt.ms >= 0.005;
  const comparable = ts.rows <= 1 && measurable;

  const shown = Number.isFinite(ratio) ? ratio.toFixed(1) : '>>';
  const agree =
    ts.rows === nt.rows && ts.first === nt.first ? 'yes' : `NO (${ts.rows}/${nt.rows} rows)`;

  console.log(
    `${name.padEnd(20)}${ts.ms.toFixed(1).padStart(8)}${nt.ms.toFixed(2).padStart(12)}` +
      `${shown.padStart(10)}x${flag(comparable, measurable)}   ${agree}`,
  );
}
