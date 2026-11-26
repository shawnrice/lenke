/**
 * WHICH `aggregate` BODY CARRIES THE FAMILY'S COST? (item 2009)
 *
 * **ITEM 2008 PAID FOR THIS QUESTION.** Items 2003-2006 optimized rows that were real and moved
 * the realistic `var-length` family by NOTHING, because one of its four bounds carried ~600x the
 * others and I had never asked which. One item aimed at that bound moved the family 25.8x. So the
 * first thing to do with a family nomination is split it by body.
 *
 * `aggregate` now reads **9.76 ms/query** for ONE row — second in the re-screen (item 2009) behind
 * `grouped`'s 10.52. It draws eleven bodies spanning depth 1 to depth 4 and five functions, so the
 * average says nothing about where the time is.
 *
 * AND IT PRINTS THE ROW COUNT, because an aggregate returns one row for O(N) work: ns/row is
 * meaningless here and ms/query is the only honest unit (the screen's own footer says so).
 *
 *     bun aggbody-2009.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 5000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 5);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({
    id: String(i + 1),
    labels: ['T'],
    properties: { n: i % 97, x: i % 31, s: `s${String(i % 17)}` },
  });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  // Splits on the repeat index — CLAUDE.md's rule.
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${String(e)}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
    labels: ['E'],
    properties: { w: i % 13 },
  });
}

/* The family's eleven bodies, with `count` and `sum` as the two representative functions. */
const BODIES = {
  'd1 scan count': 'MATCH (n:T) WHERE n.n >= 3 RETURN count(*) AS x',
  'd1 scan sum': 'MATCH (n:T) WHERE n.n >= 3 RETURN sum(n.n) AS x',
  'd1 scan min': 'MATCH (n:T) WHERE n.x < 7 RETURN min(n.n) AS x',
  'd2 hop count': 'MATCH (a:T)-[:E]->(b:T) WHERE b.n >= 3 RETURN count(*) AS x',
  'd2 hop sum': 'MATCH (a:T)-[:E]->(b:T) WHERE b.n >= 3 RETURN sum(b.n) AS x',
  'd3 chain count(*)': 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN count(*) AS x',
  'd4 chain count(*)': 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T)-[:E]->(d:T) RETURN count(*) AS x',
  'd3 chain count(c.n)': 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN count(c.n) AS x',
  'd3 chain sum(c.n)': 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN sum(c.n) AS x',
  'd4 chain sum(d.n)': 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T)-[:E]->(d:T) RETURN sum(d.n) AS x',
  'd1 count(DISTINCT)': 'MATCH (n:T) RETURN count(DISTINCT n.x) AS x',
  'd3 count(DISTINCT)': 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN count(DISTINCT c.n) AS x',
  // THE FLOAT-VALUED FOLD the family carries deliberately: an integer sum in f64 is EXACT whatever
  // the order, so only this spelling can expose the summation-order sensitivity that items 1829/1830
  // refused `sum` over. If the family's cost is HERE, it is on a documented byte-identity refusal and
  // is not an open target at all.
  'd3 sum(c.n * 0.1)': 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN sum(c.n * 0.1) AS x',
  /*
   * ITEM 1830 SAYS `min`/`max`/`count(x)` GOT A RUNG AT TWO AND THREE HOPS. These arms check it
   * against `count(*)`, which is the same pattern with only the PROJECTION changed —
   * [[vary-only-the-projection]]. AND THEY ARE ORDER-INDEPENDENT, so the byte-identity refusal
   * that blocks `sum` (f64 addition is not associative) does NOT apply: a `count`, `min` or `max`
   * folds to the same value in any order, which is why items 1830/1832 could give them rungs when
   * `sum` stays refused.
   */
  'd2 hop count(b.n)': 'MATCH (a:T)-[:E]->(b:T) RETURN count(b.n) AS x',
  'd2 hop min(b.n)': 'MATCH (a:T)-[:E]->(b:T) RETURN min(b.n) AS x',
  'd2 hop max(b.n)': 'MATCH (a:T)-[:E]->(b:T) RETURN max(b.n) AS x',
  'd3 chain min(c.n)': 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN min(c.n) AS x',
  'd3 chain max(c.n)': 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN max(c.n) AS x',
  'd4 chain count(d.n)': 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T)-[:E]->(d:T) RETURN count(d.n) AS x',
  'd4 chain min(d.n)': 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T)-[:E]->(d:T) RETURN min(d.n) AS x',
};

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

console.log(`|V|=${String(NODES)} |E|=${String(g.edgeCount)} median of ${String(REPS)}\n`);
console.log('body                      ms      rows');

const rows = [];

for (const [name, text] of Object.entries(BODIES)) {
  const ts = [];
  let n = 0;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const got = [...query(g, text, {})];

    ts.push(performance.now() - t0);
    n = got.length;
  }

  const ms = med(ts);

  rows.push([name, ms]);
  console.log(`${name.padEnd(24)} ${ms.toFixed(2).padStart(7)} ${String(n).padStart(6)}`);
}

rows.sort((a, b) => b[1] - a[1]);
console.log(
  `\n# dominant body: ${rows[0][0]} at ${rows[0][1].toFixed(2)} ms, ` +
    `${(rows[0][1] / rows[rows.length - 1][1]).toFixed(0)}x the cheapest\n` +
    `# The family draws these ~uniformly, so its ms/query is roughly their MEAN — a body far above\n` +
    `#    the others IS the family's cost, and optimizing any other body cannot move the number.`,
);
