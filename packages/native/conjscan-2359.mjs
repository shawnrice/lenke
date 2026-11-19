/**
 * Why does the serving bench's UNINDEXED `analytic: cycle detection 2-4 hops` cost 4x its own unindexed
 * point lookup, when native's costs the same? (item 2359)
 *
 * `bun run bench:usage` reads, on the ts(-) column, 1.2k ops/sec for cycle detection against 4.7k for a
 * point lookup — while native is flat at 45.0k and 55.8k. The ~13x everywhere is the known
 * object-vs-columnar scan ceiling; TS's own 3.9x spread across shapes is not explained by it.
 *
 * The two bench queries differ in where the subquery sits:
 *
 *     fan-out:  MATCH (u:User) WHERE u.name = $n RETURN COUNT { MATCH (u)-[:FOLLOWS]->{1,3}(x:User) }
 *     cycle:    MATCH (u:User) WHERE u.name = $n AND EXISTS { MATCH (u)-[:FOLLOWS]->{2,4}(u) } RETURN ...
 *
 * So the hypothesis is NOT that the subquery is expensive but that a COMPOUND `WHERE` declines whatever
 * rung a bare comparison takes, dropping the scan onto the general evaluator.
 *
 * THE DECISIVE CONTROL is arm `cheapAnd`: a conjunction whose second conjunct is trivially cheap
 * (`u.score >= 0`, true for every row). If it is as slow as the EXISTS arm, the cost is the conjunction
 * declining a rung and the subquery is innocent. If it is as fast as the bare arm, the conjunction is fine
 * and the subquery really is the cost.
 *
 * Arms are run in both orders across rounds, because a conjunct order change is exactly what
 * `conjunct-order-chosen-for-speed` says the engine is allowed to make per engine.
 *
 * Every arm prints its row count: a shape that returns 0 rows has not done the work being timed, which is
 * how item 2317 timed a MISS against a HIT.
 */
import { Graph } from '@lenke/core';
import * as gql from '@lenke/gql';

const USERS = Number(process.env.USERS ?? 20_000);
const FAN = Number(process.env.FAN ?? 3);
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 400);
const REPS = Number(process.env.REPS ?? 9);

const graph = new Graph();

for (let i = 0; i < USERS; i += 1) {
  graph.addVertex({
    id: `u${i}`,
    labels: ['User'],
    properties: { name: `user${i}`, score: i % 1000, tier: 'a' },
  });
}

/*
 * Repeat-index split, so one vertex's FAN edges do not all land on the same target (item 1518).
 *
 * One edge per vertex is a short BACK-edge (`from - 2`), which gives the graph real 2-4 hop cycles. Without
 * them the EXISTS arm returns 0 rows and times a cycle search that always FAILS — a different amount of
 * work from the bench's, and the row count is what reveals it.
 */
for (let j = 0; j < USERS * FAN; j += 1) {
  const from = j % USERS;
  const rep = Math.floor(j / USERS);
  const to = rep === 0 ? (from + USERS - 2) % USERS : (from * 7 + rep * 104_729 + 1) % USERS;
  const a = graph.getVertexById(`u${from}`);
  const b = graph.getVertexById(`u${to}`);

  if (a === null || b === null) {
    throw new Error('fixture: missing endpoint');
  }

  graph.addEdge({ id: `f${j}`, from: a, to: b, labels: ['FOLLOWS'], properties: {} });
}

/* NO INDEX. The indexed arm is at parity with native already; the unindexed route is what is under test. */

const ARMS = [
  { key: 'bare', q: 'MATCH (u:User) WHERE u.name = $n RETURN u.name AS n' },
  {
    key: 'cheapAnd',
    q: 'MATCH (u:User) WHERE u.name = $n AND u.score >= 0 RETURN u.name AS n',
  },
  {
    /*
     * THE DISTINGUISHING ARM. If a conjunction merely DECLINES a specialized single-comparison rung, a
     * third conjunct is free (the general evaluator short-circuits on the false leading one). If instead
     * the scan evaluates every conjunct for every row, a third costs another ~12 ns/row. Linear growth
     * means no short-circuit; flat means a rung decline.
     */
    key: 'cheapAnd3',
    q: 'MATCH (u:User) WHERE u.name = $n AND u.score >= 0 AND u.score < 100000 RETURN u.name AS n',
  },
  {
    /*
     * THE CARRIER ARM (item 2360). Two conjuncts on ONE property. If the 2.11x is about ARITY, this is
     * as slow as `cheapAnd`. If it is about the gate spanning several property CARRIERS -- item 1600's
     * `specializeSingleProp` resolves the single-carrier case to one closure, while generic
     * `inlineHolds` re-dispatches over twelve carriers per element -- this stays near `bare`.
     */
    key: 'oneCarrier',
    q: "MATCH (u:User) WHERE u.name = $n AND u.name <> 'zzz' RETURN u.name AS n",
  },
  {
    /*
     * THE ALL-`=` ARM (item 2362). `eqProps` -- added at item 224 and extended at item 230 from one
     * comparison to an all-`=` AND-chain -- compiles `<var>.<key> = <non-null literal>` conjuncts to read
     * the ELEMENT directly. Both slow arms above carry a NON-`=` second conjunct (`>=`, `<>`) and so fall
     * outside it. If that is the mechanism, this arm sits near `bare` despite having two conjuncts.
     */
    key: 'twoEq',
    q: "MATCH (u:User) WHERE u.name = $n AND u.tier = 'a' RETURN u.name AS n",
  },
  {
    key: 'cheapAndRev',
    q: 'MATCH (u:User) WHERE u.score >= 0 AND u.name = $n RETURN u.name AS n',
  },
  {
    key: 'existsAnd',
    q: 'MATCH (u:User) WHERE u.name = $n AND EXISTS { MATCH (u)-[:FOLLOWS]->{2,4}(u) } RETURN u.name AS n',
  },
  {
    key: 'fanoutRet',
    q: 'MATCH (u:User) WHERE u.name = $n RETURN COUNT { MATCH (u)-[:FOLLOWS]->{1,3}(x:User) } AS spread',
  },
];

/** Warm, then double an inner count until one sample fills SAMPLE_MS, and report per CALL. */
const timePerCall = (fn) => {
  for (let w = 0; w < 300; w += 1) {
    fn(w);
  }

  let inner = 1;

  for (;;) {
    const t0 = performance.now();

    for (let k = 0; k < inner; k += 1) {
      fn(k);
    }

    const dt = performance.now() - t0;

    if (dt >= SAMPLE_MS) {
      break;
    }

    inner *= 2;
  }

  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    for (let k = 0; k < inner; k += 1) {
      fn(k);
    }

    series.push(((performance.now() - t0) * 1000) / inner);
  }

  series.sort((x, y) => x - y);

  return { us: series[Math.floor(series.length / 2)], inner, series };
};

/*
 * ONE ARM PER PROCESS. The first version of this probe ran all five in one process and its own unchanged
 * control moved 3x by position — `bare` read 229.9 us running first and 694.5 us running last. Five query
 * shapes through one evaluator leave the dispatch sites polymorphic, and whichever arm goes first gets the
 * clean ones. Every ratio from that version was an artifact.
 */
const only = process.env.ARM;
const order = only === undefined ? ARMS : ARMS.filter((a) => a.key === only);

if (order.length === 0) {
  throw new Error(`no such arm: ${String(only)}`);
}

const out = new Map();

for (const arm of order) {
  let rows = -1;
  /*
   * WHERE the matching vertex SITS IN THE SCAN, which is the item 2361 question. If a single-conjunct
   * `WHERE` lets the scan STOP at the match (a sole equality key plus an exactness verdict) while a
   * conjunction forces a full walk, then `first` is nearly free, `last` costs a full scan, and `cycle`
   * lands halfway on average -- which is exactly the 2x item 2360 measured.
   */
  const POS = process.env.POS ?? 'cycle';
  const pick = (k) => {
    if (POS === 'first') {
      return 0;
    }

    if (POS === 'last') {
      return USERS - 1;
    }

    if (POS === 'mid') {
      return USERS >> 1;
    }

    return k % USERS;
  };
  const fn = (k) => {
    const res = gql.query(graph, arm.q, { n: `user${pick(k)}` });

    rows = res.length;
  };
  const got = timePerCall(fn);

  out.set(arm.key, got);
  console.log(
    `  ${arm.key.padEnd(12)} ${got.us.toFixed(1).padStart(9)} us/call   rows=${rows}  inner=${got.inner}` +
      `   series=[${got.series.map((x) => x.toFixed(0)).join(' ')}]`,
  );
}
