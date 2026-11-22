/**
 * WHY IS `max` OVER A HOP 3.4x `sum` OVER THE SAME HOP, WHEN `max` IS THE EASIER AGGREGATE? (item 2402)
 *
 * Item 2401 freed `sum`/`avg` to ride the far-driven walk and the bench row fell 280.2 -> 24.3 ms,
 * which put it AT its floor (item 2157 measured the bare projection of that hop at 19.82 ms). It also
 * left `max` at 82.0 on the identical clause — 4x the same floor, and `max` is IDEMPOTENT, so it may
 * dedup far vertices where `sum` must visit every edge. It should be the cheaper of the two.
 *
 * ⚠️ TWO HYPOTHESES ALREADY REFUTED BY MEASUREMENT, which is why this profiles instead of reasoning:
 *
 *   1. "`max` takes the slower dedup walk."  For a DIRECTED hop `idempotent` only sets `noSelfLoops`;
 *      both spellings call the same `detectHopProjection(..., forceStartDriven)`. And `routes()` says
 *      both compile to `hopAggregate` — same rung, same walk.
 *   2. "`extremumFold`'s `compareValues` per row."  Ablating it to a bare numeric comparison moved the
 *      row from 82.0 to 82.7 — nothing. The general comparator is not the cost.
 *
 * THE ARMS, so each difference isolates one term:
 *
 *   max    the target.
 *   sum    the same clause at its floor, post-2401. A frame heavy in `max` and ABSENT from `sum` is
 *          the thing `max` pays extra for — and both now take the same rung and walk, so whatever it
 *          is lives in the accumulator or in what the walk is asked to materialize.
 *   proj   `RETURN b.k`, the projection floor both aggregates sit on top of.
 *   count  `count(*)`, which takes `countShortcut` instead — present so a frame common to all FOUR is
 *          recognisable as fixture or harness rather than as this question.
 *
 * ⚠️ Run with `node`, not `bun`: this uses `node:inspector`'s Session to WINDOW the profile to the
 * query loop. That is load-bearing — every profile in this package otherwise surfaces the fixture
 * build (`indexEdgeLabel`, `commitElementLabels`, `#commitNormalized`), all closed targets. Starting
 * the profiler after the build makes them structurally absent rather than something to remember to
 * ignore. `@lenke/*` resolve to built dist, so a source edit reaches this probe only after `nx build`.
 *
 *   ARM=max node hopagg-prof-2402.mjs
 */
import { Session } from 'node:inspector';

import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200_000);
const REPS = Number(process.env.REPS ?? 12);
const ARM = process.env.ARM ?? 'max';
const DEG = Number(process.env.DEG ?? 3);
const PROPS = Number(process.env.PROPS ?? 4);

const QUERIES = {
  max: 'MATCH (a:Person)-[:KNOWS]->(b) RETURN max(b.k) AS c',
  sum: 'MATCH (a:Person)-[:KNOWS]->(b) RETURN sum(b.k) AS c',
  proj: 'MATCH (a:Person)-[:KNOWS]->(b) RETURN b.k AS c',
  count: 'MATCH (a:Person)-[:KNOWS]->(b) RETURN count(*) AS c',
  /*
   * ⚠️ THE `age` ARMS EXIST BECAUSE THE BENCH'S OWN ROWS ARE DEGENERATE (item 2402). `graphDoc`
   * carries ONLY `age`, and the bench's `sum over a hop` / `max over a hop` rows aggregate `b.k`,
   * which is absent on every vertex — verified: `sum(b.k)` answers 0 and `max(b.k)` answers null
   * there. So those rows measure an aggregate whose every value is filtered by `nonNull`, and any
   * ratio read off them describes the ABSENT-key path. These arms ask the same question of a column
   * that exists.
   */
  sumage: 'MATCH (a:Person)-[:KNOWS]->(b) RETURN sum(b.age) AS c',
  /*
   * Item 2404's arms. `collect`/`collect_list` were the two names left in `ORDER_SENSITIVE_WALK`
   * after item 2401, so they are still forced start-driven and still refuse the undirected hop.
   * The owner's ruling frees them, and these measure whether that buys anything before the
   * contract moves: "if we can get gains, then it doesn't matter the order they're in".
   *
   * ⚠️ `size(collect(...))` rather than bare `collect(...)`: the bare form returns a 1,000,000
   * element list and the probe would measure the ARRAY RETURN as much as the walk. `size()` keeps
   * the aggregate on the same route while the result stays one number.
   */
  collectage: 'MATCH (a:Person)-[:KNOWS]->(b) RETURN size(collect(b.age)) AS c',
  collectund: 'MATCH (a:Person)-[:KNOWS]-(b) RETURN size(collect(b.age)) AS c',
  maxage: 'MATCH (a:Person)-[:KNOWS]->(b) RETURN max(b.age) AS c',
};
const q = QUERIES[ARM];

if (q === undefined) {
  throw new Error(`ARM must be one of ${Object.keys(QUERIES).join(', ')}`);
}

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  /*
   * ⚠️ PROPS IS LOAD-BEARING FOR THE CROSSOVER, not a detail (item 2402). The endpoint fold's cost is
   * per CANDIDATE VERTEX and independent of property count; the row walk's is per EDGE and scales
   * with it. So a wide fixture makes the walk slow and the fold cross EARLY, and a narrow one pushes
   * the crossover up. `graphDoc` carries ONE property and shows the fold losing 3.33x at degree 5,
   * where this probe's four properties put that degree at break-even.
   */
  g.addVertex({
    id: `v${i}`,
    labels: ['Person'],
    properties: PROPS === 1 ? { age: i % 90 } : { k: i % 97, n: i, age: i % 90, name: `user${i}` },
  });
}

/*
 * Three out-edges per vertex, SPLIT ON THE REPEAT INDEX. `(i * c) % N` is invariant under
 * `i -> i + N`, so with three passes every vertex's three edges would land on the SAME target: the
 * degree counts still look right and the fan-out is fake (items 1516/1518).
 */
let e = 0;

for (let rep = 0; rep < DEG; rep += 1) {
  for (let i = 0; i < N; i += 1) {
    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(`v${i}`),
      to: g.getVertexById(`v${(i * 7919 + rep * 104_729 + 1) % N}`),
      labels: ['KNOWS'],
      properties: { w: e % 13 },
    });
    e += 1;
  }
}

const session = new Session();

session.connect();

const call = (method, params) =>
  new Promise((resolve, reject) => {
    session.post(method, params, (err, res) => (err ? reject(err) : resolve(res)));
  });

// Warm the route and the JIT before the window opens, so tiering-up is not in the profile.
for (let r = 0; r < 3; r += 1) {
  query(g, q, {});
}

await call('Profiler.enable');
await call('Profiler.setSamplingInterval', { interval: 100 });
await call('Profiler.start');

const t0 = performance.now();
let answer = '';

for (let r = 0; r < REPS; r += 1) {
  const rows = query(g, q, {});

  // Consumed, and PRINTED below: an arm whose result is discarded can be optimized away, and the
  // arms must agree on the row count or they are not measuring one question.
  answer = `${rows.length} rows, first=${JSON.stringify(rows[0])}`;
}

const wall = performance.now() - t0;
const { profile } = await call('Profiler.stop');

session.disconnect();

const total = profile.nodes.reduce((acc, n) => acc + (n.hitCount ?? 0), 0);
const byFn = new Map();

for (const node of profile.nodes) {
  const hits = node.hitCount ?? 0;

  if (hits === 0) {
    continue;
  }

  const { functionName, url, lineNumber } = node.callFrame;
  const parts = String(url).split('/');
  const [file] = parts.slice(-1);
  // An explicit length test, not `??`: `functionName` is the EMPTY STRING for an anonymous frame,
  // which is falsy but not nullish.
  const name = functionName.length > 0 ? functionName : '(anonymous)';
  const key = `${name}  ${file}:${lineNumber + 1}`;

  byFn.set(key, (byFn.get(key) ?? 0) + hits);
}

console.log(`ARM=${ARM}  ${q}`);
console.log(
  `${N} vertices, ${e} edges, deg ${DEG}, props ${PROPS}, ${REPS} reps, ${(wall / REPS).toFixed(2)} ms/rep`,
);
console.log(`${answer}\n`);
console.log(`${'self%'.padStart(7)}  ${'hits'.padStart(6)}  frame`);

for (const [key, hits] of [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
  console.log(
    `${((100 * hits) / total).toFixed(2).padStart(6)}%  ${String(hits).padStart(6)}  ${key}`,
  );
}
