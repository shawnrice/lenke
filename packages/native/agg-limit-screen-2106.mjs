/*
 * Item 2106 — the vacuous-`LIMIT` screen over the AGGREGATE surface, which items 2104/2105 did not cover.
 *
 * 🔑 THE SCREEN (items 2104 -> 2105, worth 82x then 1521x): a vacuous `LIMIT` cannot change an answer
 * smaller than itself, but it DOES defeat a length-gated rung — so if "as written" is slower than "as
 * written + LIMIT", that rung is LOSING TO DECLINING.
 *
 * ⚠️ AGGREGATES NEED A SECOND ARM, because a `LIMIT` after an aggregate limits the AGGREGATE ROWS (one
 * row for a bare `count(*)`), so it does NOT reach the walk and cannot defeat a length gate. The
 * spelling that does is the HAND-REVERSED pattern — writing the walk from the predicate's own end —
 * which is item 2101's 330x finding used as an instrument rather than a result.
 *
 * ⚠️ BOTH ARMS ASSERT THE SAME ANSWER. Two spellings that disagree are two questions, and the ratio
 * would be meaningless.
 *
 * 🔑 IT ALSO RE-PRICES ITEM 2102'S RECORDED-OPEN "the `count(*)` path falls off at three segments
 * (31x)". That number was measured BEFORE items 2104/2105 changed what the row rungs do, and
 * CLAUDE.md's rule is to verify a heading against the source rather than trust its figure.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const REPS = Number(process.env.REPS ?? 9);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i % 97, tag: `t${i % 2000}` } });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(`v${i}`),
    to: g.getVertexById(`v${(i * 7 + 3 + hop * 13) % NODES}`),
    labels: ['E'],
    properties: {},
  });
}

g.createIndex({ on: 'vertex', kind: 'hash', keys: ['tag'] });

const C = {
  1: ['(a:P)-[:E]->(b:P)', '(b:P)<-[:E]-(a:P)'],
  2: ['(a:P)-[:E]->(m:P)-[:E]->(b:P)', '(b:P)<-[:E]-(m:P)<-[:E]-(a:P)'],
  3: ['(a:P)-[:E]->(m:P)-[:E]->(m2:P)-[:E]->(b:P)', '(b:P)<-[:E]-(m2:P)<-[:E]-(m:P)<-[:E]-(a:P)'],
};

/** Each entry: the RETURN tail, applied to both spellings at every depth. */
const tails = {
  'count(*)': 'RETURN count(*) AS c',
  'count(DISTINCT a.n)': 'RETURN count(DISTINCT a.n) AS c',
  'min(a.n)': 'RETURN min(a.n) AS c',
  'sum(a.n)': 'RETURN sum(a.n) AS c',
  'avg(a.n)': 'RETURN avg(a.n) AS c',
  'grouped count': 'RETURN a.n AS k, count(*) AS c',
  /* ⚠️ `count(collect(…))` is correctly REFUSED as a nested aggregate, so the list is sized instead. */
  'collect(a.n)': 'RETURN size(collect(a.n)) AS c',
  'max(a.n)': 'RETURN max(a.n) AS c',
};

const timeIt = (q) => {
  const series = [];
  let rows = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    rows = query(g, q, { t: 't7' });
    series.push(performance.now() - t0);
  }

  const kept = series.slice(3).sort((a, b) => a - b);

  return { ms: kept[Math.floor(kept.length / 2)], answer: JSON.stringify(rows).slice(0, 60) };
};

console.log(`  NODES=${NODES} FANOUT=${FANOUT}, tag 1/2000, indexed, median of ${REPS}\n`);
console.log(
  `  ${'aggregate'.padEnd(22)} ${'hops'.padStart(4)} ${'as written'.padStart(11)} ${'reversed'.padStart(10)} ${'ratio'.padStart(8)}`,
);

const flagged = [];

for (const [name, tail] of Object.entries(tails)) {
  for (const depth of [1, 2, 3]) {
    const [fwd, rev] = C[depth];
    const a = timeIt(`MATCH ${fwd} WHERE b.tag = $t ${tail}`);
    const b = timeIt(`MATCH ${rev} WHERE b.tag = $t ${tail}`);

    // ⚠️ The two spellings must be ONE question.
    if (a.answer !== b.answer) {
      throw new Error(`${name} @${depth}: spellings disagree — ${a.answer} vs ${b.answer}`);
    }

    const ratio = a.ms / b.ms;
    const flag = ratio > 2 ? '  ⚠️ SEED-SIDE GAP' : '';

    if (ratio > 2) {
      flagged.push(`${name} @${depth} hops: ${ratio.toFixed(1)}x`);
    }

    console.log(
      `  ${name.padEnd(22)} ${String(depth).padStart(4)} ${a.ms.toFixed(2).padStart(11)} ${b.ms.toFixed(2).padStart(10)} ${ratio.toFixed(2).padStart(7)}x${flag}`,
    );
  }
}

console.log(
  `\n  ${flagged.length} flagged${flagged.length > 0 ? `:\n    ${flagged.join('\n    ')}` : ''}`,
);
