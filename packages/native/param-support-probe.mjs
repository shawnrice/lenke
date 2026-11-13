/**
 * Which PARAMETER spellings do both engines accept?
 *
 * The differential fuzzer passed no parameters at all, so every parameterized form had zero
 * cross-engine coverage — including the `$x = u.k` / `u.k = $x` pair the repo's own
 * equivalent-spellings doctrine is built on, and the inline `{k: $x}` the planner seeks on.
 *
 * Before a generator can emit these it has to know which ones BOTH engines accept: a form one
 * engine rejects is a divergence the fuzzer would report on every draw, which makes the gate red
 * for a known question rather than for a regression — exactly the reasoning this file's neighbour
 * applies to a negative `percentile` fraction.
 *
 * Prints one row per spelling: TS outcome, native outcome, and whether they AGREE.
 */

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './src/conformance-harness.js';
import { graphFromNdjson } from './src/graph.js';

const NDJSON = [
  '{"type":"node","id":"1","labels":["T"],"properties":{"n":3,"s":"a","x":-1,"d":{"@date":"2024-01-02"}}}',
  '{"type":"node","id":"2","labels":["T"],"properties":{"n":7,"s":"z","x":4,"d":{"@date":"1999-12-31"}}}',
  '{"type":"node","id":"3","labels":["T","U"],"properties":{"n":5,"s":"m","x":2,"d":{"@date":"2024-01-03"}}}',
  '{"type":"edge","id":"e1","labels":["E"],"from":"1","to":"2","properties":{"w":2}}',
  '{"type":"edge","id":"e2","labels":["E"],"from":"2","to":"3","properties":{"w":5}}',
].join('\n');

if (!nativeReady) {
  throw new Error('native lib is not built — run `bun run build` first');
}

const backend = nativeBackend();
const nat = graphFromNdjson(backend, NDJSON);
const ts = tsDeserialize(NDJSON, 'ndjson', new Graph());

const CASES = [
  ['param on RHS', 'MATCH (n:T) WHERE n.n = $v RETURN n.s AS x ORDER BY x', { v: 7 }],
  ['param on LHS', 'MATCH (n:T) WHERE $v = n.n RETURN n.s AS x ORDER BY x', { v: 7 }],
  ['inline {k: $v}', 'MATCH (n:T {n: $v}) RETURN n.s AS x ORDER BY x', { v: 7 }],
  [
    'range two params',
    'MATCH (n:T) WHERE n.x >= $lo AND n.x <= $hi RETURN n.n AS x ORDER BY x',
    { lo: 0, hi: 9 },
  ],
  ['string param', 'MATCH (n:T) WHERE n.s = $s RETURN n.n AS x ORDER BY x', { s: 'z' }],
  ['IN list param', 'MATCH (n:T) WHERE n.n IN $ids RETURN n.n AS x ORDER BY x', { ids: [3, 5] }],
  [
    'IN literal w/ param',
    'MATCH (n:T) WHERE n.n IN [$a, $b] RETURN n.n AS x ORDER BY x',
    { a: 3, b: 5 },
  ],
  ['LIMIT $k', 'MATCH (n:T) RETURN n.n AS x ORDER BY x LIMIT $k', { k: 2 }],
  ['SKIP $k', 'MATCH (n:T) RETURN n.n AS x ORDER BY x SKIP $k', { k: 1 }],
  ['param in projection', 'MATCH (n:T) RETURN n.n + $v AS x ORDER BY x', { v: 1 }],
  [
    'edge prop param',
    'MATCH (a:T)-[e:E]->(b) WHERE e.w >= $w RETURN e.w AS x ORDER BY x',
    { w: 2 },
  ],
  [
    'hop + param',
    'MATCH (a:T)-[:E]->(b)-[:E]->(c) WHERE a.n = $v RETURN c.n AS x ORDER BY x',
    { v: 3 },
  ],
  [
    'date param',
    'MATCH (n:T) WHERE n.d >= $from RETURN n.n AS x ORDER BY x',
    { from: { '@date': '2024-01-01' } },
  ],
  ['null param', 'MATCH (n:T) WHERE n.n = $v RETURN n.n AS x ORDER BY x', { v: null }],
  ['bool param', 'MATCH (n:T) WHERE $b RETURN n.n AS x ORDER BY x', { b: true }],
  ['unused param', 'MATCH (n:T) RETURN n.n AS x ORDER BY x', { unused: 1 }],
  ['missing param', 'MATCH (n:T) WHERE n.n = $nope RETURN n.n AS x ORDER BY x', {}],
  ['param inline label', 'MATCH (n:T {s: $s, n: $v}) RETURN n.n AS x ORDER BY x', { s: 'z', v: 7 }],
  [
    'EXISTS + param',
    'MATCH (a:T) WHERE EXISTS { MATCH (a)-[:E]->(b) WHERE b.n = $v } RETURN a.n AS x ORDER BY x',
    { v: 7 },
  ],
  ['LET + param', 'MATCH (n:T) LET g = n.n + $v RETURN g AS x ORDER BY x', { v: 2 }],
];

const run = (fn) => {
  try {
    return { ok: true, json: JSON.stringify(fn()) };
  } catch (e) {
    return { ok: false, json: `ERR ${String(e?.code ?? e?.message ?? e).slice(0, 48)}` };
  }
};

let agree = 0;

for (const [name, text, params] of CASES) {
  const a = run(() => tsQuery(ts, text, params));
  const b = run(() => nat.query(text, params));
  const same = a.ok === b.ok && a.json === b.json;

  if (same) {
    agree += 1;
  }

  console.log(
    `${same ? 'AGREE ' : 'DIFFER'}  ${name.padEnd(20)}  ts=${a.json.slice(0, 34).padEnd(34)}  nat=${b.json.slice(0, 34)}`,
  );
}

console.log(`\n${agree}/${CASES.length} agree`);
