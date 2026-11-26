/**
 * What does the TS engine's CORRELATED-SUBQUERY route cost, against the equivalent MATCH that
 * means the same thing? (item 1818)
 *
 * WHY THIS PROBE EXISTS. `runtime-profile-probe.mjs`'s `callinline` shape reads 633 ms engine where
 * every other GQL shape on the screen reads 80-180, and its profile is the GENERAL matcher running
 * once per outer row — `matchPattern` 9.2%, `withBinding` 7.6%, `hoistedMatch` 5.1%, `buildGroups`
 * 5.5%, `walkSegments` 4.2%, under a `runCallInline` closure at 32.6%. CLOSED.md records the same
 * thing from the other end: item 521's closing note leaves "the whole correlated-subquery route in
 * the TS engine, ~3 us an outer row (34x native on this shape)" explicitly OPEN, and item 513
 * closed the NATIVE twin by rewriting a correlated inline `CALL` into its equivalent `MATCH`
 * (`inlineCorrelatedCall`, 900-1005 ms to 0.0).
 *
 * A SHARE IS A NOMINATION; THIS PROBE IS THE PRICE. PROBES.md records four instances of a
 * profile share overstating by ~2.5x, so the number that matters is this one: the same question
 * asked twice, once through `CALL` and once through the `MATCH` it is equivalent to.
 *
 * THE FLOOR MUST BE THE EQUIVALENT QUERY, NOT MERELY A SIMILAR ONE (item 1465's rule, and the
 * reason each pair below carries an `equivalent` key). The two tails are equivalent for DIFFERENT
 * reasons and getting that backwards would price the wrong thing:
 *
 *   - A body ending in ROWS (`RETURN x.k`) emits one row per edge, so the outer row count is the
 *     hop's row count and the floor is the hop itself.
 *   - A body ending in an AGGREGATE (`RETURN count(*)`) emits exactly ONE row per outer row
 *     whatever the body matched, so the floor is the OUTER pattern alone and the hop is invisible
 *     in the answer. Pricing the aggregate form against the hop would report a speedup that is
 *     really a different question.
 *
 * So the probe ASSERTS each pair agrees before reporting a ratio. A pair that disagrees is a wrong
 * floor, not a finding, and it fails loudly rather than printing a number.
 *
 * PROTOCOL (CLAUDE.md's TS per-row rule): 14 reps, drop the first 3 as JIT warm-up, take the MEDIAN
 * of the rest; three rounds with the arm ORDER ALTERNATED; report the min of the per-round medians
 * and the whole per-rep series, because the general scalar path is bimodal and `min`-of-N estimates
 * the two arms differently.
 *
 *     node correlated-call-probe.mjs
 *     NODES=200000 FANOUT=5 node correlated-call-probe.mjs
 *     PAIRS=rows node correlated-call-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 20_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 14);
const WARMUP = Number(process.env.WARMUP ?? 3);
const ROUNDS = Number(process.env.ROUNDS ?? 3);
const ONLY = process.env.PAIRS;

/**
 * The target stride is `(i * 7 + 3 + hop * 2654435761) % NODES`, which is the GQL profile
 * probe's own `sequential` arm — so a number here is comparable with that screen. It splits on the
 * REPEAT INDEX (`hop`), which is the fix CLAUDE.md records for the `(a*k+b) % N` degeneracy: without
 * it one vertex's FANOUT edges all land on the same target and every k-hop count is `F^k * N` by
 * construction.
 */
const build = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { k: i % 97, s: `s${i % 1000}`, n: i },
    });
  }

  for (let e = 0; e < NODES * FANOUT; e += 1) {
    const i = e % NODES;
    const hop = Math.floor(e / NODES);

    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(`v${i}`),
      to: g.getVertexById(`v${(i * 7 + 3 + hop * 2_654_435_761) % NODES}`),
      labels: ['E'],
      properties: { w: e % 13 },
    });
  }

  return g;
};

/**
 * Each pair is ONE question in two spellings. `call` goes through the correlated-subquery route;
 * `equivalent` is the plain query that means the same thing and is the floor.
 */
const PAIRS = {
  /** A body returning ROWS: one row per edge, so the floor is the hop. */
  rows: {
    call: 'MATCH (n:P) CALL { MATCH (n)-[:E]->(x:P) RETURN x.k AS k } RETURN count(*) AS c',
    equivalent: 'MATCH (n:P)-[:E]->(x:P) RETURN count(*) AS c',
  },
  /** The ISO variable-scope spelling of the same thing. */
  scopedrows: {
    call: 'MATCH (n:P) CALL (n) { MATCH (n)-[:E]->(x:P) RETURN x.k AS k } RETURN count(*) AS c',
    equivalent: 'MATCH (n:P)-[:E]->(x:P) RETURN count(*) AS c',
  },
  /**
   * A body ending in an AGGREGATE: exactly one row per outer row whatever the hop matched, so the
   * floor is the OUTER pattern alone. This is the shape `callinline` profiles.
   */
  agg: {
    call: 'MATCH (n:P) CALL { MATCH (n)-[:E]->(x:P) RETURN count(*) AS d } RETURN count(*) AS c',
    equivalent: 'MATCH (n:P) RETURN count(*) AS c',
  },
  /** A body carrying a far-end FILTER, to separate the route's cost from the body's. */
  filtered: {
    call: 'MATCH (n:P) CALL { MATCH (n)-[:E]->(x:P) WHERE x.k > 44 RETURN x.k AS k } RETURN count(*) AS c',
    equivalent: 'MATCH (n:P)-[:E]->(x:P) WHERE x.k > 44 RETURN count(*) AS c',
  },
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;

  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const timeOne = (g, q) => {
  const t0 = performance.now();
  const rows = query(g, q);
  const ms = performance.now() - t0;

  return { ms, answer: JSON.stringify(rows) };
};

/** One arm: REPS timed runs, the first WARMUP dropped, median of the rest. */
const arm = (g, q) => {
  const series = [];
  let answer;

  for (let r = 0; r < REPS; r += 1) {
    const { ms, answer: a } = timeOne(g, q);

    series.push(ms);

    if (r === 0) {
      answer = a;
    } else if (a !== answer) {
      throw new Error(`arm is not deterministic across reps: ${q}`);
    }
  }

  return { series, kept: series.slice(WARMUP), median: median(series.slice(WARMUP)), answer };
};

const g = build();

console.log(
  `# correlated-call-probe NODES=${NODES} FANOUT=${FANOUT} reps=${REPS} drop=${WARMUP} rounds=${ROUNDS}`,
);
console.log(`# vertices=${g.vertexCount} edges=${g.edgeCount}`);

const names = Object.keys(PAIRS).filter((n) => ONLY === undefined || ONLY.split(',').includes(n));

for (const name of names) {
  const { call, equivalent } = PAIRS[name];
  const callMedians = [];
  const floorMedians = [];
  let callAnswer;
  let floorAnswer;
  let failed;

  for (let round = 0; round < ROUNDS; round += 1) {
    // ORDER ALTERNATED between rounds, so neither arm is always the one that warms the other.
    const callFirst = round % 2 === 0;

    let c;
    let f;

    try {
      c = callFirst ? arm(g, call) : undefined;
      f = arm(g, equivalent);
      c = c ?? arm(g, call);
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
      break;
    }

    callMedians.push(c.median);
    floorMedians.push(f.median);
    callAnswer = c.answer;
    floorAnswer = f.answer;

    if (round === 0) {
      console.log(`\n## ${name}`);
      console.log(`   CALL  ${call}`);
      console.log(`   FLOOR ${equivalent}`);
    }

    console.log(
      `   round ${round}  call ${c.median.toFixed(1)}  floor ${f.median.toFixed(1)}` +
        `   call series [${c.kept.map((x) => x.toFixed(1)).join(' ')}]`,
    );
  }

  if (failed !== undefined) {
    console.log(`\n## ${name}\n   DID NOT RUN: ${failed}`);
    continue;
  }

  // THE EQUIVALENCE IS THE WHOLE CLAIM, so it is asserted and not assumed. A pair whose two
  // spellings disagree is a WRONG FLOOR; printing its ratio would price a different question.
  if (callAnswer !== floorAnswer) {
    console.log(
      `   NOT EQUIVALENT — call ${callAnswer} vs floor ${floorAnswer}. ` +
        `This pair prices nothing; fix the floor.`,
    );
    continue;
  }

  const c = Math.min(...callMedians);
  const f = Math.min(...floorMedians);

  console.log(
    `   => call ${c.toFixed(1)} ms  floor ${f.toFixed(1)} ms  ` +
      `RATIO ${(c / f).toFixed(2)}x   answer ${callAnswer.slice(0, 60)}`,
  );
}
