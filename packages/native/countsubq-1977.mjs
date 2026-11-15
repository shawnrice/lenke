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
/** Percent of the graph shape L's seed admits — `score` spans 100 values. */
const SEL = Number(process.env.SEL ?? 10);
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
  /*
   * ⚠️ H AND I ARE THE CONTROLS ITEM 1978 NEEDS, and they answer different questions.
   *
   * H is UNSEEDED, so `perSourceAdmissible` refuses it outright and it runs item 573's rung exactly
   * as it always did. It is the row that must NOT move: [[executor-edits-perturb]] prices a new
   * walk variant at up to 16% on UNRELATED shapes, and this one sits in the same function.
   *
   * I is a BROAD seed (every vertex passes), which is the one that separates the two costs inside
   * B. It pays the same |V| preamble — the two `Float64Array(|V|)`, the `|V|` init pass, the start
   * label's array copy and the per-vertex seed filter — but ALSO the level loop and a 20,000-source
   * sum. If I and B are close, the preamble dominates and the level recurrence was never the cost.
   */
  [
    'H UNSEEDED count  [CONTROL, must not move]',
    'MATCH (u:User)-[:FOLLOWS]->{1,3}(x:User) RETURN count(*) AS spread',
  ],
  /*
   * ⚠️⚠️ J AND K ARE THE SEEK COMPARATOR (item 1979), and they are the cheapest possible proof that
   * the missing index seek is real rather than inferred.
   *
   * Both run the IDENTICAL quantified pattern with the IDENTICAL clause seed. They differ only in
   * the projection, and that routes them to two DIFFERENT rungs:
   *
   *   J  `RETURN DISTINCT b.name`  -> the REACHABILITY rung (item 1906), which seeds through
   *                                   `seedVertices` — the index-aware seeder — at
   *                                   `reachability.ts:231`.
   *   K  `RETURN count(*)`         -> the var-length COUNT rung, which resolves its sources as
   *                                   `[...verticesByLabel.get(startName)].filter(seedPasses)`.
   *
   * So the pair measures ONE difference: seeking the seed against scanning the label's extent for
   * it. If J is flat in |V| and K is linear, the seek is available on this very shape today, one
   * rung over, and the count rung simply does not call it. ⚠️ J does strictly MORE work than K
   * (it materializes and dedupes the reached set where K only counts), so J being FASTER is not a
   * close call — it is the whole finding.
   */
  [
    'J DISTINCT b.name  [REACHABILITY rung, SEEKS]',
    'MATCH (u:User)-[:FOLLOWS]->{1,3}(x:User) WHERE u.name = $n RETURN DISTINCT x.name AS v',
  ],
  [
    'K count(*), same pattern  [COUNT rung, SCANS]',
    'MATCH (u:User)-[:FOLLOWS]->{1,3}(x:User) WHERE u.name = $n RETURN count(*) AS spread',
  ],
  /*
   * ⚠️⚠️ L IS THE CROSSOVER ROW (item 1979). Shape I is `name >= ''`, which matches EVERY vertex —
   * pathological, and it regressed 1.27x when the rung started seeking, because `seedVertices` must
   * price a range candidate and then decline it (`seekIsWorthIt`, break-even ~18%) before falling
   * back to the label scan the rung used to take directly.
   *
   * "Is that 1.27x real on a shape anyone writes?" is a selectivity question, so `SEL` makes
   * selectivity the knob: `score` spans 100 values, so `score < $sel` selects SEL% of the graph.
   * SEL=1 is a narrow seed, SEL=100 is shape I by another spelling. The crossover is where the
   * seek's own gate starts refusing, and it has to be MEASURED rather than reasoned about — item
   * 1939 swept the one gate this repo has of the same kind.
   */
  [
    'L seed at SEL% of the graph  [crossover]',
    'MATCH (u:User)-[:FOLLOWS]->{1,3}(x:User) WHERE u.score < $sel RETURN count(*) AS spread',
  ],
  [
    'I BROAD seed, every vertex passes  [splitter]',
    'MATCH (u:User)-[:FOLLOWS]->{1,3}(x:User) WHERE u.name >= $lo RETURN count(*) AS spread',
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

/*
 * ⚠️ `SHAPE=` SELECTS ONE ROW, and it is not a convenience. CLAUDE.md: "a per-row question needs a
 * per-row instrument" — running the whole sweep per arm lets rows interfere, and item 1979 saw
 * exactly that: control E, a 2-hop fixed chain this change cannot reach, moved 1.21-1.32x between
 * arms while the row under test moved 1.27x the other way. A control moving as far as the subject
 * means the sweep cannot resolve the subject.
 */
const { SHAPE } = process.env;

for (const [name, q] of SHAPES) {
  if (SHAPE !== undefined && !name.startsWith(SHAPE)) {
    continue;
  }

  // ⚠️ THE ANSWER IS PRINTED because a route gap only matters between shapes that AGREE. On a
  // permutation graph A-D must all read 3 and E-F must read 1.
  const probe = tsQuery(tsGraph, q, { n: 'user7', lo: '', sel: SEL });
  /*
   * ⚠️ `?? null` IS LOAD-BEARING: `JSON.stringify(undefined)` returns `undefined`, not a string, so
   * a shape projecting under a different alias crashed the printer instead of reporting itself.
   * And `rows` is shown for a projection, where the first row's value says nothing about the shape.
   */
  const scalar = probe?.[0]?.spread ?? probe?.[0]?.c;
  /*
   * ⚠️ `JSON.stringify` AND NOT `String`: a row value is `unknown`, so `String` stringifies an
   * object as `[object Object]` and the lint is right to refuse it. A shape projecting no scalar
   * (shape J's `DISTINCT x.name`) reports its ROW COUNT instead, because the first row's value says
   * nothing about whether the shape agreed with its siblings.
   */
  const rows = probe === undefined ? 'null' : `${String(probe.length)}r`;
  const answer = scalar === undefined ? rows : JSON.stringify(scalar);
  const ts = measure((i) => void tsQuery(tsGraph, q, { n: `user${String(i)}`, lo: '', sel: SEL }));
  let nat;

  if (nativeGraph !== undefined) {
    nat = measure((i) => void nativeGraph.query(q, { n: `user${String(i)}`, lo: '', sel: SEL }));
  }

  console.log(
    `${name.padEnd(48)} ${answer.padStart(5)} ${f(ts.warm)} ${nat === undefined ? '        -' : f(nat.warm)}   ${nat === undefined ? '    -' : `${(ts.warm / nat.warm).toFixed(2)}x`.padStart(6)}   ${(1e6 / ts.warm).toFixed(2).padStart(8)}`,
  );
}
