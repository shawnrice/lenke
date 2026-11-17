/**
 * THE SHAPES THE BENCH CORPUS DOES NOT COVER (item 2145).
 *
 * 🔑 Items 2140-2144 each CLOSED a benched row by measurement rather than opening one — the benched TS
 * surface is largely at its documented floors. So this screen asks a different question: **what is not
 * benched at all?** Grepping the three bench files for feature keywords found five with NO row:
 *
 * ```text
 *     OPTIONAL MATCH          none
 *     UNION / EXCEPT / INTERSECT   none
 *     ANY SHORTEST            none
 *     _MERGE                  none
 *     SKIP                    none
 * ```
 *
 * ⚠️⚠️ **AND `OPTIONAL MATCH` IS THE ONE THAT MATTERS MOST, BECAUSE THIS SESSION SHIPPED TWO RUNGS FOR IT
 * AND NEITHER HAS A ROW**: item 2123 (`OPTIONAL MATCH` + `GROUP BY`, 307.8 → 29.0 ms, 10.6x) and item 2124
 * (the FAR-keyed variant, 358.3 → 111.3, 3.22x). 🔑 `bench.ts` itself quotes the rule this breaks — item
 * 1177's *"a win with no row is a win that quietly comes undone"* — and item 1184's rows exist precisely
 * because deleting a chain entry is ANSWER-EQUIVALENT and survives every test and fuzzer.
 *
 * 🔑 Each shape is paired with a REFERENCE it should be compared against, so a number here means something:
 * the same question without the feature, or the cheapest thing that answers it.
 *
 *     cd packages/native && node uncovered-shapes-2145.mjs
 *     N=50000 node uncovered-shapes-2145.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const REPS = Number(process.env.REPS ?? 9);
const WARMUP = Number(process.env.WARMUP ?? 3);

const graph = new Graph();

for (let i = 0; i < N; i += 1) {
  graph.addVertex({
    id: `v${i}`,
    labels: i % 3 === 0 ? ['P', 'Admin'] : ['P'],
    properties: { age: i % 90, name: `person${i}`, k: i % 97 },
  });
}

let edges = 0;

/*
 * ⚠️ HALF THE VERTICES GET NO OUT-EDGE (`i += 2`), which is load-bearing for the OPTIONAL rows: the whole
 * difference between `OPTIONAL MATCH` and a plain `MATCH` is the null-filled row an unmatched anchor
 * contributes, and a fixture where every anchor matches cannot tell the two apart (item 2123 learned this
 * the hard way — its first measurement fixture gave every vertex degree 3 and proved nothing).
 *
 * ⚠️ The repeat index `d` is the second term: `to = (a*k + b) % N` is invariant under `k -> k + N`, so a
 * flat loop sends one vertex's whole fan-out to the SAME target (items 1516/1518).
 */
for (let d = 0; d < FANOUT; d += 1) {
  for (let i = 0; i < N; i += 2) {
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
    `fixture is degenerate: v0 reaches ${sampleTargets.size} targets, want ${FANOUT}`,
  );
}

/** Each row: a name, the query, and the REFERENCE it is compared against. */
const ROWS = [
  // ── OPTIONAL MATCH: items 2123/2124's rungs, which have no bench row ──────────────────────────
  [
    'OPTIONAL + GROUP BY [item 2123]',
    'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b) RETURN a.k AS g, count(*) AS c',
    'MATCH (a:P)-[:E]->(b) RETURN a.k AS g, count(*) AS c',
  ],
  [
    'OPTIONAL + GROUP BY, FAR key [2124]',
    'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b) RETURN b.k AS g, count(*) AS c',
    'MATCH (a:P)-[:E]->(b) RETURN b.k AS g, count(*) AS c',
  ],
  [
    'OPTIONAL plain count',
    'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b) RETURN count(*) AS c',
    'MATCH (a:P)-[:E]->(b) RETURN count(*) AS c',
  ],
  [
    'OPTIONAL rows',
    'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b) RETURN a.k AS x, b.k AS y',
    'MATCH (a:P)-[:E]->(b) RETURN a.k AS x, b.k AS y',
  ],
  // ── Set operations: no row anywhere ───────────────────────────────────────────────────────────
  [
    'UNION of two hops',
    'MATCH (a:P)-[:E]->(b) RETURN b.k AS k UNION MATCH (a:Admin)-[:E]->(b) RETURN b.k AS k',
    'MATCH (a:P)-[:E]->(b) RETURN b.k AS k',
  ],
  [
    'UNION ALL of two hops',
    'MATCH (a:P)-[:E]->(b) RETURN b.k AS k UNION ALL MATCH (a:Admin)-[:E]->(b) RETURN b.k AS k',
    'MATCH (a:P)-[:E]->(b) RETURN b.k AS k',
  ],
  // ── Paging: SKIP has no row ───────────────────────────────────────────────────────────────────
  [
    'SKIP + LIMIT deep into the scan',
    'MATCH (a:P) RETURN a.k AS k ORDER BY k SKIP 100000 LIMIT 10',
    'MATCH (a:P) RETURN a.k AS k ORDER BY k LIMIT 10',
  ],
  // ── EXISTS as a semi-join, benched only in the serving file ───────────────────────────────────
  [
    'EXISTS semi-join',
    'MATCH (a:P) WHERE EXISTS { MATCH (a)-[:E]->(b) } RETURN count(*) AS c',
    'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b) RETURN count(*) AS c',
  ],
];

const timeIt = (q) => {
  const series = [];
  let rows = 0;
  let first = '';

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const got = query(graph, q, {});

    series.push(performance.now() - t0);
    rows = got.length;
    first = JSON.stringify(got[0] ?? null);
  }

  const kept = series.slice(WARMUP).sort((a, b) => a - b);

  return { ms: kept[Math.floor(kept.length / 2)], rows, first, series };
};

console.log(`\n  ${N} vertices / ${edges} edges, median of reps ${WARMUP + 1}-${REPS}\n`);
console.log(
  `  ${'shape'.padEnd(36)} ${'ms'.padStart(9)} ${'reference'.padStart(10)} ${'ratio'.padStart(8)}  rows`,
);

for (const [name, q, ref] of ROWS) {
  const a = timeIt(q);
  const b = timeIt(ref);
  const ratio = a.ms / b.ms;
  /*
   * ⚠️ A RATIO OVER ITS REFERENCE IS A NOMINATION, NOT A RESULT, and it needs a floor: two sub-millisecond
   * readings divide into nonsense (item 2132's `node count` flagged 2.3x on 0.00 against 0.01).
   */
  const flag = ratio > 3 && a.ms > 1 ? `  ⚠️ ${ratio.toFixed(1)}x its reference` : '';

  console.log(
    `  ${name.padEnd(36)} ${a.ms.toFixed(2).padStart(9)} ${b.ms.toFixed(2).padStart(10)} ${`${ratio.toFixed(1)}x`.padStart(8)}  ${a.rows}${flag}`,
  );
}

console.log(
  `\n  ⚠️ A FLAGGED ROW IS A NOMINATION. Confirm with an A/B of the real rung — a micro-probe has\n` +
    `  mispriced this engine four times (items 591, 2125, 2130's first half, 2128/2138).\n`,
);
