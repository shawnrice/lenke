/**
 * THE SAME QUESTION IN BOTH SURFACE LANGUAGES: where do the two TS engines disagree on cost? (item 2132)
 *
 * 🔑 THIS COMPARISON HAS PRODUCED A WIN TWO TICKS RUNNING, which is why it becomes an instrument rather
 * than a thing I remember to try:
 *
 *   - item 2130: Gremlin's filtered chain count had no CSR route where GQL's did — **801x** at three hops.
 *   - item 2131: GQL memoized its unfiltered degree product and Gremlin recomputed it — **>100x**.
 *
 * ⚠️ **THE TWO ARE SEPARATE TS IMPLEMENTATIONS.** There is no shared IR on this side — that is the Rust
 * engine's property, not this one's — so a gap here is a real missing route in one of them, not a
 * lowering artifact. 🔑 And because each is a faithful answer to the same question, **whichever side is
 * faster is a measured FLOOR for the other**: the cheaper engine proves the work can be done for that.
 *
 * ⚠️⚠️ **STEADY STATE, NOT MIN-OF-N, AND THE SERIES IS PRINTED.** Both engines warm up over roughly two
 * reps — GQL read 82.5 then 204 then 0.3 on one shape, Gremlin 80.6 then 150.6 then 14 — so a `min` over
 * all reps reports the warm-up on one side and the steady state on the other, and a `median` over all of
 * them reports neither. Item 2131 found a 30x gap only because the series was printed. Here: 9 reps, drop
 * the first 3, median the rest, and `SERIES=1` shows every reading.
 *
 * ⚠️ **THE ANSWERS ARE COMPARED, NOT ASSUMED.** A pair whose answers differ is not a cost finding at all —
 * it is either a fixture mistake or a conformance divergence, and the row says `ANSWER MISMATCH` rather
 * than a ratio. (Row ORDER is unspecified without an explicit sort, so only counts and sorted scalars are
 * compared here.)
 *
 *     cd packages/native && node cross-language-2132.mjs
 *     N=50000 SERIES=1 node cross-language-2132.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import {
  V,
  count,
  dedupe,
  gt,
  has,
  hasLabel,
  in_,
  out,
  toArray,
  traversal,
  values,
} from '@lenke/gremlin';

const N = Number(process.env.N ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 9);
const WARMUP = Number(process.env.WARMUP ?? 3);
const SHOW_SERIES = process.env.SERIES === '1';

const graph = new Graph();

for (let i = 0; i < N; i += 1) {
  graph.addVertex({
    id: `v${i}`,
    labels: i % 3 === 0 ? ['P', 'Admin'] : ['P'],
    properties: { age: i % 90, name: `p${i}` },
  });
}

let edges = 0;

/*
 * ⚠️ SPLIT ON THE REPEAT INDEX `d`. `to = (a*k + b) % N` is invariant under `k -> k + N`, so a flat
 * `for (k = 0; k < N*FANOUT; k++)` loop sends one vertex's whole fan-out to the SAME target: out-degree,
 * in-degree and isolated counts all look perfect and the graph is FUNCTIONAL, so every k-hop count is
 * `F^k · N` by construction (items 1516/1518). The assertion below is what proves it is not.
 */
for (let d = 0; d < FANOUT; d += 1) {
  for (let i = 0; i < N; i += 1) {
    graph.addEdge({
      id: `e${edges}`,
      from: graph.getVertexById(`v${i}`),
      to: graph.getVertexById(`v${(i * 7 + 3 + d * 104_729) % N}`),
      labels: ['E'],
      properties: {},
    });
    edges += 1;
  }
}

const sampleTargets = new Set();

for (const edge of graph.getVertexById('v0').adjFrom?.get('E') ?? []) {
  sampleTargets.add(edge.to.id);
}

if (sampleTargets.size !== FANOUT) {
  throw new Error(
    `fixture is degenerate: v0 reaches ${sampleTargets.size} distinct targets, want ${FANOUT}`,
  );
}

/**
 * Each pair is one QUESTION with a GQL spelling and a Gremlin spelling, plus how to reduce each side's
 * result to something comparable. 🔑 `scalar` pulls one number; `sortedValues` makes a row bag
 * order-independent, since row order is unspecified without an explicit sort.
 */
const scalar = (key) => (rows) => (rows.length === 0 ? null : rows[0][key]);
const first = (rows) => (rows.length === 0 ? null : rows[0]);
/** Module scope: hoisted so it is not rebuilt per call, and so the lint is satisfied honestly. */
const ascending = (a, b) => {
  if (a < b) {
    return -1;
  }

  return a > b ? 1 : 0;
};
const sortedValues = (rows) => {
  const flat = rows.map((r) => (typeof r === 'object' && r !== null ? Object.values(r)[0] : r));

  /*
   * ⚠️ An explicit comparator: the default sort is lexicographic, which would order 10 before 9 and make
   * two engines look like they disagree when they do not.
   */
  return `${flat.length}:${[...flat].sort(ascending).slice(0, 4).join(',')}`;
};

const PAIRS = [
  {
    name: 'node count',
    gql: ['MATCH (a:P) RETURN count(*) AS n', scalar('n')],
    grm: [traversal(V(), count()), first],
  },
  {
    name: 'node count, filtered',
    gql: ['MATCH (a:P) WHERE a.age > 44 RETURN count(*) AS n', scalar('n')],
    grm: [traversal(V(), has('age', gt(44)), count()), first],
  },
  {
    name: '1-hop count',
    gql: ['MATCH (a:P)-[:E]->(b) RETURN count(*) AS n', scalar('n')],
    grm: [traversal(V(), out('E'), count()), first],
  },
  {
    name: '1-hop count, far filter',
    gql: ['MATCH (a:P)-[:E]->(b) WHERE b.age > 44 RETURN count(*) AS n', scalar('n')],
    grm: [traversal(V(), out('E'), has('age', gt(44)), count()), first],
  },
  {
    name: '2-hop count',
    gql: ['MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN count(*) AS n', scalar('n')],
    grm: [traversal(V(), out('E'), out('E'), count()), first],
  },
  {
    name: '2-hop count, far filter',
    gql: ['MATCH (a:P)-[:E]->(b)-[:E]->(c) WHERE c.age > 44 RETURN count(*) AS n', scalar('n')],
    grm: [traversal(V(), out('E'), out('E'), has('age', gt(44)), count()), first],
  },
  {
    name: '3-hop count',
    gql: ['MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN count(*) AS n', scalar('n')],
    grm: [traversal(V(), out('E'), out('E'), out('E'), count()), first],
  },
  {
    name: 'in-hop count',
    gql: ['MATCH (a:P)<-[:E]-(b) RETURN count(*) AS n', scalar('n')],
    grm: [traversal(V(), in_('E'), count()), first],
  },
  {
    name: 'label + filter count',
    gql: ['MATCH (a:Admin) WHERE a.age > 44 RETURN count(*) AS n', scalar('n')],
    grm: [traversal(V(), hasLabel('Admin'), has('age', gt(44)), count()), first],
  },
  {
    name: 'distinct far count',
    gql: ['MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b) AS n', scalar('n')],
    grm: [traversal(V(), out('E'), dedupe(), count()), first],
  },
  {
    name: 'property projection',
    gql: ['MATCH (a:P) RETURN a.age AS k', sortedValues],
    grm: [traversal(V(), values('age')), sortedValues],
  },
  {
    name: '1-hop projection',
    gql: ['MATCH (a:P)-[:E]->(b) RETURN b.age AS k', sortedValues],
    grm: [traversal(V(), out('E'), values('age')), sortedValues],
  },
  {
    name: '1-hop projection, filtered',
    gql: ['MATCH (a:P)-[:E]->(b) WHERE b.age > 85 RETURN b.age AS k', sortedValues],
    grm: [traversal(V(), out('E'), has('age', gt(85)), values('age')), sortedValues],
  },
];

/*
 * The loser must cost at least this much for a ratio to be a nomination. 🔑 Below it the two readings are
 * timer noise — `performance.now()` resolution plus loop overhead — and dividing them means nothing.
 */
const FLOOR_MS = Number(process.env.XL_FLOOR ?? 1);

/** Median of the post-warm-up reps, with the whole series kept for printing. */
const timeIt = (run, reduce) => {
  const series = [];
  let answer;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const rows = run();

    series.push(performance.now() - t0);
    answer = reduce(rows);
  }

  const kept = series.slice(WARMUP).sort((a, b) => a - b);

  return { ms: kept[Math.floor(kept.length / 2)], series, answer };
};

console.log(`\n  ${N} vertices / ${edges} edges, median of reps ${WARMUP + 1}-${REPS}\n`);
console.log(
  `  ${'question'.padEnd(26)} ${'GQL'.padStart(9)} ${'Gremlin'.padStart(9)}  ${'ratio'.padStart(10)}  answers`,
);

for (const pair of PAIRS) {
  const [gqlText, gqlReduce] = pair.gql;
  const [grmPlan, grmReduce] = pair.grm;
  const g = timeIt(() => query(graph, gqlText, {}), gqlReduce);
  const m = timeIt(() => toArray(grmPlan, graph), grmReduce);
  const agree = String(g.answer) === String(m.answer);
  /*
   * ⚠️ THE SLOWER SIDE IS THE ONE WITH A MISSING ROUTE, so the ratio is written as "how many times the
   * loser costs the winner" with the loser named. A bare GQL/Gremlin ratio hides which way to read it.
   */
  const ratio = g.ms > m.ms ? g.ms / m.ms : m.ms / g.ms;
  const loser = g.ms > m.ms ? 'GQL' : 'GRM';
  /*
   * ⚠️⚠️ **A RATIO NEEDS A FLOOR OR IT CRIES WOLF ON SUB-MILLISECOND ROWS.** `node count` read 0.00 against
   * 0.01 and flagged 2.3x — a ratio between two readings that are both essentially zero. 🔑 Same guard the
   * vacuous screen needed at item 2127: a row is a candidate only when the ratio is large AND the loser
   * costs enough to be worth winning. `FLOOR_MS` is one timer tick's worth of margin.
   */
  let flag = '';

  if (!agree) {
    flag = '  ⚠️⚠️ ANSWER MISMATCH';
  } else if (ratio > 2 && Math.max(g.ms, m.ms) > FLOOR_MS) {
    flag = `  ⚠️ ${loser} is ${ratio.toFixed(1)}x`;
  }

  console.log(
    `  ${pair.name.padEnd(26)} ${g.ms.toFixed(2).padStart(9)} ${m.ms.toFixed(2).padStart(9)}  ${`${ratio.toFixed(1)}x ${loser}`.padStart(10)}  ${agree ? 'same' : `${String(g.answer).slice(0, 18)} / ${String(m.answer).slice(0, 18)}`}${flag}`,
  );

  if (SHOW_SERIES) {
    console.log(`      GQL [${g.series.map((x) => x.toFixed(1)).join(' ')}]`);
    console.log(`      GRM [${m.series.map((x) => x.toFixed(1)).join(' ')}]`);
  }
}

console.log(
  `\n  ⚠️ A FLAGGED ROW IS A NOMINATION, NOT A RESULT. Confirm it with an A/B of the real rung — a\n` +
    `  micro-probe has mispriced this engine's loops three times (items 591, 2125, and 2130's first half).\n`,
);
