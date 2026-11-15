// Item 1973 — DOES AN INDEX THE QUERY NEVER USES SLOW A TS READ? And by how much per index?
//
// `bench:usage`'s `read: keyed dedup lookup` reproducibly reports **TS 93-94k against native 166k**,
// the only indexed read where TS loses — while every sibling has TS 2.3-3.4x AHEAD. On a controlled
// fixture with ONE index TS WINS it 1.16x; adding the second index the bench carries (`name`, which
// this query never reads) took TS to 0.27x. So the variable is the NUMBER OF INDEXES, not the query.
//
// 🔑 THIS SWEEPS IT, because "slower with two" and "slower per index" are different findings: the
// first could be one unlucky structure, the second is a scaling defect that an application hits as
// it adds indexes.
//
// ⚠️ ROUNDS ARE HIGH AND THE SERIES IS PRINTED. The TS path on this shape climbs **17x from cold**
// (11.7k -> 204.5k over ten rounds of 200 ops), so a median over few rounds measures the warmup
// rather than the steady state — CLAUDE.md's rule for the TS per-row path. The figure reported is the
// median of the LAST THIRD, with the whole series shown so that choice is checkable.
//
// ⚠️ NATIVE IS THE CONTROL, not a target: if native also degrades per index then the effect is the
// fixture or the harness, not the TS index layer.
//
//     bun indexcount-1973.mjs
import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './src/conformance-harness.js';
import { graphFromNdjson } from './src/graph.js';

const USERS = Number(process.env.USERS ?? 20000);
const ROUNDS = Number(process.env.ROUNDS ?? 24);
const OPS = Number(process.env.OPS ?? 200);
// Keys the query NEVER reads, added one at a time. `score` is always indexed and always used.
const SPARE = ['name', 'tag', 'bucket', 'cohort'];

const lines = [];

for (let i = 0; i < USERS; i += 1) {
  const props = {
    name: `user${String(i)}`,
    score: i % 100,
    /*
     * ⚠️ `ACTIVE_ALL=0` MATCHES THE USAGE BENCH, which sets `active: i % 3 === 0` — true for one
     * user in three, where this probe originally set it true for all. That is the last unexplained
     * difference between the two fixtures after index count and shape pollution were both refuted.
     */
    active: process.env.ACTIVE_ALL === '0' ? i % 3 === 0 : true,
    tag: `t${String(i % 7)}`,
    bucket: i % 13,
    cohort: `c${String(i % 23)}`,
  };

  lines.push(
    `{"type":"node","id":"u${String(i)}","labels":["User"],"properties":${JSON.stringify(props)}}`,
  );
}

/*
 * ⚠️⚠️ `MIXED=1` APPENDS ONE ISOLATED NON-USER VERTEX, and it is the whole experiment now. This
 * probe's fixture is users-only, which makes `User` a VACUOUS label — and
 * [[label-vacuity-gates-fast-paths]] records that the GQL fast paths REQUIRE vacuity (43 gates
 * across 7 files), so a users-only fixture measures an arm no real schema can reach. The usage
 * bench's graph carries Teams and Resources, so its `User` is NOT vacuous. That is the last
 * difference between the two fixtures after index count, shape pollution and `active` selectivity
 * were each refuted.
 *
 * The vertex has NO edges and a different label, so no answer changes — only `vertexCount` and the
 * `User` bucket's share of it. Item 1943's mode, applied to a new shape.
 */
if (process.env.MIXED === '1') {
  lines.push('{"type":"node","id":"off","labels":["Team"],"properties":{"name":"team0"}}');
}

const NDJSON = lines.join('\n');
const Q = 'MATCH (u:User) WHERE u.score = $s AND u.active = true RETURN count(*) AS c';

const f = (x) => `${(x / 1000).toFixed(1)}k`.padStart(9);

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const measure = (run) => {
  const series = [];

  for (let r = 0; r < ROUNDS; r += 1) {
    const t0 = performance.now();

    for (let i = 0; i < OPS; i += 1) {
      run(i % 100);
    }

    series.push((OPS * 1000) / (performance.now() - t0));
  }

  // The last third, so the warmup is excluded rather than averaged in.
  return { warm: med(series.slice(Math.floor((series.length * 2) / 3))), series };
};

console.log(`USERS=${String(USERS)} OPS=${String(OPS)} ROUNDS=${String(ROUNDS)}`);
console.log('# warm = median of the LAST THIRD; ops/sec, higher is better\n');
console.log('spare indexes   ts warm    native warm    ts/native');

for (let spares = 0; spares <= SPARE.length; spares += 1) {
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  tsGraph.createIndex({ on: 'vertex', kind: 'hash', keys: ['score'] });

  for (const key of SPARE.slice(0, spares)) {
    tsGraph.createIndex({ on: 'vertex', kind: 'hash', keys: [key] });
  }

  const ts = measure((s) => void tsQuery(tsGraph, Q, { s }));
  let nat;

  if (nativeReady) {
    const g = graphFromNdjson(nativeBackend(), NDJSON);

    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['score'] });

    for (const key of SPARE.slice(0, spares)) {
      g.createIndex({ on: 'vertex', kind: 'hash', keys: [key] });
    }

    nat = measure((s) => void g.query(Q, { s }));
  }

  console.log(
    `${String(spares).padEnd(15)} ${f(ts.warm)} ${nat === undefined ? '        -' : f(nat.warm)}    ${nat === undefined ? '-' : (ts.warm / nat.warm).toFixed(2)}x`,
  );

  if (spares === 0 || spares === SPARE.length) {
    console.log(`    ts series: ${ts.series.map((x) => (x / 1000).toFixed(0)).join(' ')}`);
  }

  // The microtask drain pins a discarded Graph in full — `graph-pinned-until-microtask-drain`.
  await new Promise((r) => setTimeout(r, 0));
}
