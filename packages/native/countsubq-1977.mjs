// Item 1977 — DOES `COUNT { MATCH … ->{1,3}(x) }` REACH THE SAME ROUTE AS A TOP-LEVEL
// `RETURN count(*)` OVER THE SAME PATTERN? `bench:usage`'s `analytic: fan-out spread 1-3 hops` is
// the ONE row in that bench where TS loses to native by more than 1.5x without an existing
// explanation (the `keyed dedup` pair is item 1973's vacuity cliff, `append + link` is item 576/577's
// query-text finding, both closed).
//
//     analytic: fan-out spread 1-3 hops    ts 188.1k   engine 313.2k    TS 0.60x
//
// 🔑 THE NOMINATION IS AN ORDERING THAT CANNOT BE RIGHT, not the ratio — the heuristic that produced
// items 748/749. In the same bench, on the SAME anchor and the SAME graph:
//
//     read: 2-hop recommendation   ts 610.5k (1.64 us)   engine 242.6k     TS 2.52x FASTER
//     analytic: fan-out spread     ts 188.1k (5.32 us)   engine 313.2k     TS 0.60x
//
// TS makes the 1-3 hop count **3.2x HARDER** than the 2-hop count; native makes it **1.29x EASIER**.
// One of the two engines has the shapes in the wrong order, and it is not native.
//
// ⚠️⚠️ AND THE WALK CANNOT BE THE COST, WHICH IS WHAT MAKES THIS WORTH MEASURING. The usage bench's
// follow graph is `to = u{(i * 7919) % GRAPH}` with ONE edge per vertex, and 7919 is coprime with
// 20,000 — so the graph is a PERMUTATION: out-degree is exactly 1 everywhere and the graph is a
// union of cycles. `->{1,3}` therefore reaches exactly THREE vertices, whatever the anchor. A
// 3-edge walk cannot cost 5.32 us, so the row is measuring the quantified-subquery machinery's
// FIXED cost per row, not traversal. (This also means the row is NOT a fan-out measurement despite
// its name — noted below.)
//
// ⚠️ `User` IS THE ONLY LABEL in that fixture, so it is VACUOUS and TS is already on its BEST arm
// ([[label-vacuity-gates-fast-paths]]: the GQL fast paths REQUIRE vacuity). `MIXED=1` appends one
// off-label vertex to read the realistic arm too — if the gap widens there, the row understates it.
//
//     bun countsubq-1977.mjs
//     MIXED=1 bun countsubq-1977.mjs
import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './src/conformance-harness.js';
import { graphFromNdjson } from './src/graph.js';

const GRAPH = Number(process.env.GRAPH ?? 20000);
const ROUNDS = Number(process.env.ROUNDS ?? 15);
const OPS = Number(process.env.OPS ?? 400);

const lines = [];

for (let i = 0; i < GRAPH; i += 1) {
  lines.push(
    `{"type":"node","id":"u${String(i)}","labels":["User"],"properties":{"name":"user${String(i)}","score":${String(i % 100)}}}`,
  );
}

for (let i = 0; i < GRAPH; i += 1) {
  // The usage bench's own edge, verbatim: a permutation, so out-degree is exactly 1.
  lines.push(
    `{"type":"edge","id":"f${String(i)}","labels":["FOLLOWS"],"from":"u${String(i)}","to":"u${String((i * 7919) % GRAPH)}","properties":{}}`,
  );
}

if (process.env.MIXED === '1') {
  lines.push('{"type":"node","id":"off","labels":["Team"],"properties":{"name":"team0"}}');
}

const NDJSON = lines.join('\n');

/*
 * The spellings. A and B are the pair that matters: with `u` pinned to ONE vertex by an equality on
 * an indexed key, `COUNT { MATCH (u)-[…]->(x) }` and a top-level `count(*)` over the same pattern
 * return the SAME number, so any cost difference between them is route, not work.
 *
 * ⚠️ C and D drop the FAR label, because `x:User` is a per-element test on a vacuous label and
 * item 1609 ships an elision for exactly that — the pair says whether the elision reaches the
 * subquery form.
 */
const SHAPES = [
  [
    'A COUNT{} subquery, far label   [THE BENCH ROW]',
    'MATCH (u:User) WHERE u.name = $n RETURN COUNT { MATCH (u)-[:FOLLOWS]->{1,3}(x:User) } AS spread',
  ],
  [
    'B top-level count, far label',
    'MATCH (u:User)-[:FOLLOWS]->{1,3}(x:User) WHERE u.name = $n RETURN count(*) AS spread',
  ],
  [
    'C COUNT{} subquery, NO far label',
    'MATCH (u:User) WHERE u.name = $n RETURN COUNT { MATCH (u)-[:FOLLOWS]->{1,3}(x) } AS spread',
  ],
  [
    'D top-level count, NO far label',
    'MATCH (u:User)-[:FOLLOWS]->{1,3}(x) WHERE u.name = $n RETURN count(*) AS spread',
  ],
  [
    'E 2-hop fixed chain  [CONTROL, the fast row]',
    'MATCH (u:User)-[:FOLLOWS]->()-[:FOLLOWS]->(x) WHERE u.name = $n RETURN count(*) AS c',
  ],
  [
    'F COUNT{} subquery, 2-hop FIXED chain',
    'MATCH (u:User) WHERE u.name = $n RETURN COUNT { MATCH (u)-[:FOLLOWS]->()-[:FOLLOWS]->(x) } AS spread',
  ],
  /*
   * ⚠️ G IS ITEM 1906's FAST SPELLING of exactly B — an inline `{name: $n}` instead of a clause
   * `WHERE`. That item's whole finding was the pair costing 2996 vs 342 ms, fixed at 9.25x, and item
   * 1907 then carried the START predicate into the COUNT rung "in all three spellings". So B should
   * already be fast and is not. G says whether the rung is reachable AT ALL on this fixture, which
   * separates a REGRESSION of that fix from a shape that declines it for some other reason.
   */
  [
    'G top-level count, INLINE seed  [1906 fast form]',
    'MATCH (u:User {name: $n})-[:FOLLOWS]->{1,3}(x:User) RETURN count(*) AS spread',
  ],
];

const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

/*
 * ⚠️⚠️ `NOINDEX=1` IS THE DECISIVE ARM, not a convenience. [[rung-precedence-decides-speed]] records
 * that a WILLING fast rung is starved by a BROADER one above it in `runLinear`'s chain, and items
 * 1906/1907's probes created NO INDEX while `bench:usage` indexes `name`. If a shape is fast without
 * the index and slow with it, then CREATING AN INDEX MADE THE QUERY SLOWER — the index is starving
 * the rung rather than serving it, and that is a different defect from a missing seed.
 */
const INDEXED = process.env.NOINDEX !== '1';

if (INDEXED) {
  tsGraph.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });
}

const nativeGraph = nativeReady ? graphFromNdjson(nativeBackend(), NDJSON) : undefined;

if (nativeGraph !== undefined && INDEXED) {
  nativeGraph.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });
}

const f = (x) => `${(x / 1000).toFixed(1)}k`.padStart(9);

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** ops/sec, median of the LAST THIRD so the TS warmup is excluded rather than averaged in. */
const measure = (run) => {
  const series = [];

  for (let r = 0; r < ROUNDS; r += 1) {
    const t0 = performance.now();

    for (let i = 0; i < OPS; i += 1) {
      run(i % GRAPH);
    }

    series.push((OPS * 1000) / (performance.now() - t0));
  }

  return { warm: med(series.slice(Math.floor((series.length * 2) / 3))), series };
};

const vac = tsGraph.verticesByLabel.get('User')?.size === tsGraph.vertexCount;

console.log(
  `GRAPH=${String(GRAPH)} OPS=${String(OPS)} ROUNDS=${String(ROUNDS)} INDEX=${INDEXED ? 'yes' : 'NO'}`,
);
console.log(
  `# VACUITY GUARD: User covers ${String(tsGraph.verticesByLabel.get('User')?.size)} of ${String(tsGraph.vertexCount)} => ${vac ? 'VACUOUS (best TS arm)' : 'NOT vacuous (realistic arm)'}`,
);
console.log('# warm = median of the last third; ops/sec, higher is better\n');
console.log(
  'shape                                            answer    ts warm   native warm   ts/nat      us/op',
);

for (const [name, q] of SHAPES) {
  // ⚠️ THE ANSWER IS PRINTED because a route gap only matters between shapes that AGREE. On a
  // permutation graph A-D must all read 3 and E-F must read 1.
  const answer = JSON.stringify(
    tsQuery(tsGraph, q, { n: 'user7' })?.[0]?.spread ?? tsQuery(tsGraph, q, { n: 'user7' })?.[0]?.c,
  );
  const ts = measure((i) => void tsQuery(tsGraph, q, { n: `user${String(i)}` }));
  let nat;

  if (nativeGraph !== undefined) {
    nat = measure((i) => void nativeGraph.query(q, { n: `user${String(i)}` }));
  }

  console.log(
    `${name.padEnd(48)} ${answer.padStart(5)} ${f(ts.warm)} ${nat === undefined ? '        -' : f(nat.warm)}   ${nat === undefined ? '    -' : `${(ts.warm / nat.warm).toFixed(2)}x`.padStart(6)}   ${(1e6 / ts.warm).toFixed(2).padStart(8)}`,
  );
}
