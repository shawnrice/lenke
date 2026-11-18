/**
 * MULTI-CLAUSE AND SUBQUERY SHAPES, measured against native with PER-SHAPE FLOORS (item 2202).
 *
 * ⚠️⚠️ **WHY A NEW PROBE: both existing screens are SINGLE-CLAUSE.** `native-ref-screen-2161` varies the
 * projection and the predicate over one `MATCH`, and the Gremlin screen varies one step chain. Neither can
 * reach the compositions ISO-GQL actually offers — a second `MATCH`, `OPTIONAL MATCH`, a scoped `CALL`, a
 * nested `EXISTS`, `NEXT`, `LET`, `FILTER` — so nothing in this repo has ever priced them.
 *
 * 🔑 **EVERY SHAPE IS PAIRED WITH ITS OWN SINGLE-CLAUSE FLOOR**, which is the discipline items 2168, 2170,
 * 2175 and 2199 each paid for: a mismatched floor has produced a false nomination FIVE times now. The
 * marginal is what the COMPOSITION costs, not what the underlying scan costs.
 *
 * ⚠️ MIXED labels by default (item 2190): a homogeneous fixture makes every label VACUOUS and unlocks
 * elisions a real schema cannot reach.
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { createFfiEngineBackend } from './src/backend-ffi-engine.js';
import { graphFromNdjson } from './src/graph.js';

const N = Number(process.env.PROBE_N ?? 200_000);
const FANOUT = Number(process.env.PROBE_FANOUT ?? 3);
const REPS = Number(process.env.PROBE_REPS ?? 9);
const MIXED = process.env.MIXED !== '0';

const doc = (() => {
  const lines: string[] = [];

  for (let i = 0; i < N; i += 1) {
    lines.push(
      `{"type":"node","id":"v${i}","labels":${i % 3 === 0 ? '["Person","Admin"]' : '["Person"]'},"properties":{"age":${i % 90},"k":${i % 97},"name":"person${i}"}}`,
    );
  }

  let id = 0;

  /* ⚠️ The repeat index `d` is load-bearing — see items 1516/1518. */
  for (let d = 0; d < FANOUT; d += 1) {
    for (let i = 0; i < N; i += 2) {
      lines.push(
        `{"type":"edge","id":"e${id++}","labels":["KNOWS"],"from":"v${i}","to":"v${(i * 7 + 3 + d * 104_729) % N}","properties":{"w":${i % 7}}}`,
      );
    }
  }

  if (MIXED) {
    lines.push('{"type":"node","id":"offlabel","labels":["NoSuchLabel"],"properties":{}}');
  }

  return lines.join('\n');
})();

const SCAN = 'MATCH (a:Person) RETURN count(*) AS c';
const HOP = 'MATCH (a:Person)-[:KNOWS]->(b) RETURN count(*) AS c';

/** Each row: a name, the query, and the FLOOR query its marginal is measured against. */
const ROWS: ReadonlyArray<readonly [string, string, string]> = [
  ['FLOOR scan', SCAN, SCAN],
  ['FLOOR hop', HOP, HOP],
  ['two MATCH clauses', 'MATCH (a:Person) MATCH (b:Person) RETURN count(*) AS c', SCAN],
  [
    'OPTIONAL MATCH hop',
    'MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) RETURN count(b) AS c',
    HOP,
  ],
  [
    'WHERE EXISTS { hop }',
    'MATCH (a:Person) WHERE EXISTS { MATCH (a)-[:KNOWS]->(b) } RETURN count(*) AS c',
    HOP,
  ],
  [
    'nested EXISTS in EXISTS',
    'MATCH (a:Person) WHERE EXISTS { MATCH (a)-[:KNOWS]->(b) WHERE EXISTS { MATCH (b)-[:KNOWS]->(c) } } RETURN count(*) AS c',
    HOP,
  ],
  [
    'CALL (a) { hop }',
    'MATCH (a:Person) CALL (a) { MATCH (a)-[:KNOWS]->(b) RETURN b } RETURN count(b) AS c',
    HOP,
  ],
  [
    'NEXT composition',
    'MATCH (a:Person) RETURN a NEXT MATCH (a)-[:KNOWS]->(b) RETURN count(*) AS c',
    HOP,
  ],
  ['LET then count', 'MATCH (a:Person) LET x = a.k + 1 RETURN count(x) AS c', SCAN],
  ['FILTER clause', 'MATCH (a:Person) FILTER a.k = 2 RETURN count(*) AS c', SCAN],
  [
    'multi-pattern one MATCH',
    'MATCH (a:Person)-[:KNOWS]->(b), (c:Admin)-[:KNOWS]->(d) RETURN count(*) AS c',
    HOP,
  ],
];

const LIB = new URL(
  `../../crates/lenke-engine/target/release/liblenke_engine.${process.platform === 'darwin' ? 'dylib' : 'so'}`,
  import.meta.url,
).pathname;
const ffi = createFfiEngineBackend(LIB);
const nativeGraph = graphFromNdjson(ffi, doc) as {
  query: (q: string) => unknown;
  free: () => void;
};
const tsGraph = tsDeserialize(doc, 'ndjson', new TsGraph());

/** Median of the post-warmup reps — [[bench-methodology]]: `min` is the wrong estimator on the TS path. */
const time = (fn: () => unknown): { ms: number; out: unknown } => {
  const s: number[] = [];
  let out: unknown;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    out = fn();
    s.push(performance.now() - t0);
  }

  const k = s.slice(3).sort((a, b) => a - b);

  return { ms: k[k.length >> 1], out };
};

const answerOf = (out: unknown): string => {
  const rows = (out as { rows?: unknown[] }).rows ?? (out as unknown[]);

  return JSON.stringify(Array.isArray(rows) ? rows[0] : rows).slice(0, 22);
};

console.log(
  `\n  ${N} nodes / fanout ${FANOUT}, MIXED=${MIXED ? 1 : 0}, median of reps 4-${REPS}\n`,
);
console.log(
  `  ${'shape'.padEnd(26)} ${'ts'.padStart(8)} ${'native'.padStart(8)} ${'ratio'.padStart(7)}  ${'marginal ts/nat'.padStart(17)}`,
);

const measured = ROWS.map(([name, q, floorQ]) => ({
  name,
  q,
  floorQ,
  t: time(() => tsQuery(tsGraph, q)),
  n: time(() => nativeGraph.query(q)),
}));
const byQuery = new Map(measured.map((m) => [m.q, m]));

for (const { name, q, floorQ, t, n } of measured) {
  const isFloor = q === floorQ;
  const f = byQuery.get(floorQ);
  const mTs = t.ms - (f?.t.ms ?? 0);
  const mNat = n.ms - (f?.n.ms ?? 0);
  /* A composition is nominated only when ITS OWN cost is over 3x native's and over 2 ms. */
  const flag = !isFloor && mTs > 2 && mNat > 0.05 && mTs / mNat > 3;

  console.log(
    `  ${name.padEnd(26)} ${t.ms.toFixed(2).padStart(8)} ${n.ms.toFixed(2).padStart(8)} ${`${(t.ms / Math.max(n.ms, 0.001)).toFixed(1)}x`.padStart(7)}  ${(isFloor ? '' : `+${mTs.toFixed(2)} / +${mNat.toFixed(2)}`).padStart(17)}${flag ? '  <-- FLAG' : ''}  ${answerOf(t.out)}`,
  );
}

nativeGraph.free();
