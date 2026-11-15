/**
 * TWO SPELLINGS OF ONE GROUPED COUNT (item 2012).
 *
 * ⚠️⚠️ `detectChainGroupedCount` requires `clauses.length === 2`, and `LET g = a.n … GROUP BY g`
 * parses as THREE clauses (`match | let | return`). The aliased form `RETURN a.n AS g, count(*)` is
 * two. Both are legal ISO-GQL and mean the same thing — and `GROUP BY` takes a BOUND NAME, so the
 * LET form is the only way to write it explicitly, which is why the realistic corpus uses it.
 *
 * This is the repo's named defect class: two spellings of one question, one of which reaches a rung.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 5000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 5);
const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 97 } });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${String(e)}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
    labels: ['E'],
    properties: {},
  });
}

const PAIRS = {
  'hop  aliased': 'MATCH (a:T)-[:E]->(b:T) RETURN a.n AS g, count(*) AS c',
  'hop  LET+GROUP BY': 'MATCH (a:T)-[:E]->(b:T) LET g = a.n RETURN g, count(*) AS c GROUP BY g',
  'chain aliased': 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN a.n AS g, count(*) AS c',
  'chain LET+GROUP BY':
    'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) LET g = a.n RETURN g, count(*) AS c GROUP BY g',
};

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

console.log(`|V|=${String(NODES)} |E|=${String(g.edgeCount)} median of ${String(REPS)}\n`);
console.log('spelling              ms   groups   first group');

const got = {};

for (const [name, text] of Object.entries(PAIRS)) {
  const ts = [];
  let rows = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    // eslint-disable-next-line lenke/no-raw-interpolation -- `text` is a literal from PAIRS above
    rows = [...query(g, text, {})];
    ts.push(performance.now() - t0);
  }

  const ms = med(ts);

  got[name] = rows;
  console.log(
    `${name.padEnd(20)} ${ms.toFixed(2).padStart(6)} ${String(rows.length).padStart(7)}   ${JSON.stringify(rows[0])}`,
  );
}

const norm = (rows) =>
  JSON.stringify([...rows].map((r) => [r.g, r.c]).sort((a, b) => Number(a[0]) - Number(b[0])));

console.log(
  `\n# hop   spellings agree: ${String(norm(got['hop  aliased']) === norm(got['hop  LET+GROUP BY']))}` +
    `\n# chain spellings agree: ${String(norm(got['chain aliased']) === norm(got['chain LET+GROUP BY']))}` +
    `\n# ⚠️ Agreement is the point: if the two spellings answer the SAME and cost differently, the gap` +
    `\n#    is a routing defect, not a cost of the question.`,
);
