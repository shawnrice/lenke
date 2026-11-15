/**
 * WHICH `grouped` BODY CARRIES THE FAMILY'S COST? (item 2011)
 *
 * ⚠️ THE BODY SPLIT FIRST, BEFORE ANY PROFILE. Items 2007 and 2009 both found a family average
 * dominated by ONE body — in 2007's case a bound 600x the others, in 2009's a fold resting on a
 * byte-identity refusal — and item 2008 showed what the split is worth: one item aimed at the right
 * body moved `var-length` 25.8x where four aimed elsewhere moved it by nothing.
 *
 * `grouped` reads **10.52 ms/query for 6.6 rows** — the worst per-row of any family in item 2009's
 * re-screen. It draws seven bodies, so the average says nothing about where the time is.
 *
 * ⚠️ AND IT PRINTS GROUP COUNTS, because a grouped query's cost is O(input) while its OUTPUT is
 * O(groups): a body returning 31 groups from 5,000 vertices and one returning 97 from 25,000 edges
 * are different questions, and ns/row would flatter whichever has fewer groups.
 *
 *     bun groupedbody-2011.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 5000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 5);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 97, x: i % 31 } });
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

/* The family's seven bodies verbatim, plus the ORDER BY form `withOrder` wraps roughly half in. */
const BODIES = {
  'scan count': 'MATCH (n:T) LET g = n.x RETURN g, count(*) AS c GROUP BY g',
  'scan count + WHERE': 'MATCH (n:T) WHERE n.n >= 3 LET g = n.x RETURN g, count(*) AS c GROUP BY g',
  'hop count': 'MATCH (a:T)-[:E]->(b:T) LET g = a.n RETURN g, count(*) AS c GROUP BY g',
  'hop sum': 'MATCH (a:T)-[:E]->(b:T) LET g = a.n RETURN g, sum(b.n) AS c GROUP BY g',
  'hop count by e.w': 'MATCH (a:T)-[e:E]->(b:T) LET g = e.w RETURN g, count(*) AS c GROUP BY g',
  'chain count':
    'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) LET g = a.n RETURN g, count(*) AS c GROUP BY g',
  'scan min': 'MATCH (n:T) LET g = n.x RETURN g, min(n.n) AS c GROUP BY g',
  // The ordered wrappers, which `withOrder` applies to about half the draws.
  'scan count ORDER': 'MATCH (n:T) LET g = n.x RETURN g, count(*) AS c GROUP BY g ORDER BY g, c',
  'chain count ORDER':
    'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) LET g = a.n RETURN g, count(*) AS c GROUP BY g ORDER BY g, c',
};

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

console.log(`|V|=${String(NODES)} |E|=${String(g.edgeCount)} median of ${String(REPS)}\n`);
console.log('body                        ms   groups');

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
  console.log(`${name.padEnd(24)} ${ms.toFixed(2).padStart(7)} ${String(n).padStart(7)}`);
}

rows.sort((a, b) => b[1] - a[1]);
console.log(
  `\n# dominant: ${rows[0][0]} at ${rows[0][1].toFixed(2)} ms, ` +
    `${(rows[0][1] / rows[rows.length - 1][1]).toFixed(0)}x the cheapest\n` +
    `# ⚠️ A body far above the others IS the family's cost; optimizing any other cannot move it.`,
);
