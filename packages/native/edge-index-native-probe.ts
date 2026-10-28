/**
 * What would an EDGE property hash index be worth in the RUST engine? (item 1036)
 *
 * Item 1035 gave the TS engine's GQL surface an edge-index seed, 27x, and brought it within 1.4x
 * of the Gremlin spelling of the same question. Grepping the pattern in the other engine:
 * `crates/lenke-engine/src/schema_op.rs` matches `("edge", "interval")` and `("edge", "type")` and
 * nothing else, so `on: 'edge', kind: 'hash'` has NO engine arm — `packages/native/src/graph.ts`
 * says so in as many words, making it a compile error rather than a runtime throw. The Rust engine
 * has no edge property index at all, so item 1035 has nothing to port and this is a FEATURE
 * question, not a planner one.
 *
 * This probe prices it, because a feature is worth building only against a number. Three arms on
 * one fixture, each a count over the same 0.1%-selective edge predicate:
 *
 *   - native, the edge predicate      — what the Rust engine pays today (a scan, by construction)
 *   - ts WITH the edge index          — item 1035's route, the shape a Rust seek would mirror
 *   - native, a VERTEX-key predicate  — THE CONTROL, and the load-bearing arm: the Rust engine
 *     DOES have a vertex hash index, so this is the same question asked where the index exists.
 *     It separates "the edge index is missing" from "native is slow at this shape".
 *
 *   cd packages/native && bun edge-index-native-probe.ts
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

import { createFfiEngineBackend } from './src/backend-ffi-engine.js';
import { graphFromNdjson } from './src/graph.js';

const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'dylib',
  win32: 'dll',
};
const LIB = new URL(
  `../../crates/lenke-engine/target/release/liblenke_engine.${LIB_EXTENSIONS[process.platform] ?? 'so'}`,
  import.meta.url,
).pathname;

const N = Number(process.env.EDGE_N ?? 100_000);
const REPS = Number(process.env.EDGE_REPS ?? 14);
const VERTS = 200;

/** `i`-th edge's endpoints and `amount`, shared so both engines hold the SAME graph. */
const edgeOf = (i: number) => ({
  from: `v${i % VERTS}`,
  to: `v${(i * 7 + 3) % VERTS}`,
  amount: i % 1_000,
});

const ts = new TsGraph();
const tsVerts: ReturnType<TsGraph['addVertex']>[] = [];

for (let i = 0; i < VERTS; i++) {
  tsVerts.push(ts.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i } }));
}

for (let i = 0; i < N; i++) {
  const e = edgeOf(i);

  ts.addEdge({
    from: tsVerts[i % VERTS],
    to: tsVerts[(i * 7 + 3) % VERTS],
    labels: ['PAID'],
    properties: { amount: e.amount },
  });
}

ts.createIndex({ on: 'edge', kind: 'hash', keys: ['amount'] });

// The native graph is built from the SAME generated rows, through NDJSON — the only cold-boot
// path the FFI backend has. Edge ids are included because `encode` emits them, so omitting them
// would skip the external-id path entirely (CLAUDE.md's rule).
const lines: string[] = [];

for (let i = 0; i < VERTS; i++) {
  lines.push(`{"type":"node","id":"v${i}","labels":["P"],"properties":{"n":${i}}}`);
}

for (let i = 0; i < N; i++) {
  const e = edgeOf(i);

  lines.push(
    `{"type":"edge","id":"e${i}","labels":["PAID"],"from":"${e.from}","to":"${e.to}","properties":{"amount":${e.amount}}}`,
  );
}

const nv = graphFromNdjson(createFfiEngineBackend(LIB), new TextEncoder().encode(lines.join('\n')));

nv.createIndex({ on: 'vertex', kind: 'hash', keys: ['n'] });

// The premise, PRINTED: if this ever stops throwing, the Rust engine grew the feature and this
// probe is measuring something else.
try {
  nv.createIndex({ on: 'edge', kind: 'hash', keys: ['amount'] } as never);
  console.log("!! native ACCEPTED an edge hash index — this probe's premise is stale");
} catch (err) {
  console.log(`native edge hash index: REFUSED — ${String(err).slice(0, 90)}`);
}

const time = (label: string, run: () => unknown): void => {
  const series: number[] = [];
  let answer: unknown;

  for (let r = 0; r < REPS; r++) {
    const t = performance.now();

    answer = run();
    series.push(performance.now() - t);
  }

  // Reps 4+, median: the estimator item 1034 settled on for this family.
  const warm = series.slice(3).sort((a, b) => a - b);
  const median = warm[Math.floor(warm.length / 2)] ?? 0;

  console.log(
    `  ${label.padEnd(44)} ${median.toFixed(3).padStart(8)} ms   answer=${String(answer)}`,
  );
  console.log(`    series ${series.map((x) => x.toFixed(2)).join(' ')}`);
};

const EDGE_Q = 'MATCH ()-[e:PAID]->() WHERE e.amount = 500 RETURN count(*) AS c';
const NODE_Q = 'MATCH (a:P {n: 7})-[e:PAID]->() RETURN count(*) AS c';

console.log(`\n# ${N} edges over ${VERTS} vertices, 1,000 distinct amounts, median of reps 4+\n`);
time('native  EDGE predicate (no index exists)', () => nv.query(EDGE_Q)[0]?.c);
time('ts      EDGE predicate + edge index (1035)', () => tsQuery(ts, EDGE_Q)[0]?.c);
time('CONTROL native VERTEX key + vertex index', () => nv.query(NODE_Q)[0]?.c);
time('CONTROL ts     VERTEX key + vertex index', () => tsQuery(ts, NODE_Q)[0]?.c);
nv.free();
