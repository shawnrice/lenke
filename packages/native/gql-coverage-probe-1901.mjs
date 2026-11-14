/**
 * WHICH SHAPES CAN THE GQL SCREEN EVEN ASK? (item 1901)
 *
 * ⚠️ THIS IS THE STEP BEFORE A SCREEN ROW, not a timing instrument. Item 1898 added nine families
 * the Gremlin screen had never carried and found all five of the surface's biggest shapes among
 * them; the GQL side has never had that sweep (item 1890 applied the SIZE lesson to the GQL grid,
 * not the coverage one). But a candidate row is worthless two ways — it may not PARSE, and it may
 * parse and match NOTHING, which the screen itself warns about ("a family returning ZERO rows at
 * scale is a BROKEN SCREEN, not a fast family").
 *
 * ⚠️ AND THE SYNTAX MUST COME FROM THE ENGINE, NOT FROM MEMORY. ISO-GQL is NOT Cypher, and the
 * candidates below are the shapes an application writes that the 17-family corpus never asks:
 * `CALL` in both ISO forms, `ORDER BY` on an EXPRESSION rather than a bound name, top-k
 * (GROUP BY + ORDER BY + LIMIT), two sequential MATCH clauses, string functions, `ANY SHORTEST` and
 * path accessors, chained `LET`s, map values, `NEXT` composition, and deep paging.
 *
 *     bun gql-coverage-probe-1901.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 400);
const FANOUT = 3;

const N_POOL = [3, 5, 7, 11, 13, 17, 1, 99];
const X_POOL = [-1, 0, 2, 3, 4, 5];
const S_POOL = ['a', 'z', 'm', '', 'nope'];
const DATES = ['1999-12-31', '2024-01-02', '2024-01-03', '2031-11-30'];

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  const properties = {
    n: N_POOL[i % N_POOL.length],
    x: X_POOL[i % X_POOL.length],
    s: S_POOL[i % S_POOL.length],
    nu: i % 3 === 1 ? null : (i % 9) + 1,
    d: { '@date': DATES[i % DATES.length] },
    m: { k: i % 7, j: `q${i % 5}` },
  };

  if (i % 3 === 0) {
    properties.st = `p${i % 11}`;
  }

  g.addVertex({ id: String(i + 1), labels: i % 6 === 2 ? ['T', 'U'] : ['T'], properties });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
    labels: hop % 4 === 3 ? ['F'] : ['E'],
    properties: { w: [1, 2, 3, 4, 5, 7, 9][e % 7] },
  });
}

/** `[label, text, params]` — one candidate screen row each. */
const CANDIDATES = [
  ['order by EXPRESSION', 'MATCH (n:T) RETURN n.n AS x ORDER BY n.n + 1', {}],
  ['order by expr, two terms', 'MATCH (n:T) RETURN n.n AS x ORDER BY n.x * 2, n.n', {}],
  [
    'top-k grouped',
    'MATCH (a:T)-[:E]->(b:T) LET g = b.n RETURN g, count(*) AS c GROUP BY g ORDER BY c DESC LIMIT 3',
    {},
  ],
  [
    'two sequential MATCH',
    'MATCH (a:T) WHERE a.n = $p0 MATCH (a)-[:E]->(b:T) RETURN b.n AS x',
    {
      p0: 3,
    },
  ],
  ['chained LET', 'MATCH (n:T) LET a = n.n + 1 LET b = a * 2 RETURN b AS x', {}],
  ['map value returned', 'MATCH (n:T) RETURN n.m AS x', {}],
  ['map literal built', 'MATCH (n:T) RETURN {a: n.n, b: n.s} AS x', {}],
  ['string fn upper', 'MATCH (n:T) RETURN upper(n.s) AS x', {}],
  ['string fn char_length', 'MATCH (n:T) WHERE char_length(n.s) > 0 RETURN n.s AS x', {}],
  ['string fn trim', 'MATCH (n:T) RETURN trim(n.s) AS x', {}],
  ['deep paging', 'MATCH (n:T) RETURN n.n AS x ORDER BY x OFFSET 300 LIMIT 10', {}],
  [
    'any shortest',
    'MATCH ANY SHORTEST (a:T)-[:E]->{1,3}(b:T) WHERE a.n = $p0 RETURN b.n AS x',
    {
      p0: 3,
    },
  ],
  [
    'path value + edges()',
    'MATCH p = (a:T)-[:E]->{1,2}(b:T) WHERE a.n = $p0 RETURN edges(p) AS x',
    { p0: 3 },
  ],
  [
    'path accessor edges(p)[0]',
    'MATCH p = (a:T)-[:E]->{1,2}(b:T) WHERE a.n = $p0 RETURN edges(p)[0] AS x',
    { p0: 3 },
  ],
  ['NEXT composition', 'MATCH (n:T) WHERE n.n = $p0 RETURN n.n AS x NEXT RETURN x AS y', { p0: 3 }],
  [
    'CALL inline scoped',
    'MATCH (a:T) WHERE a.n = $p0 CALL (a) { MATCH (a)-[:E]->(b:T) RETURN b.n AS bn } RETURN bn AS x',
    { p0: 3 },
  ],
  ['CALL procedure YIELD', 'CALL degree({}) YIELD node, degree RETURN degree AS x', {}],
  ['FILTER after a hop', 'MATCH (a:T)-[:E]->(b:T) FILTER b.n > $p0 RETURN b.n AS x', { p0: 5 }],
  ['WHERE on a map field', 'MATCH (n:T) WHERE n.m.k = $p0 RETURN n.n AS x', { p0: 3 }],
  ['label disjunction', 'MATCH (n:T|U) RETURN n.n AS x', {}],
];

for (const [label, text, params] of CANDIDATES) {
  let verdict;

  try {
    const rows = query(g, text, params);

    verdict = `${String(rows.length).padStart(7)} rows`;

    if (rows.length === 0) {
      verdict += '   ⚠️ PARSES BUT MATCHES NOTHING — unusable as a screen row';
    }
  } catch (err) {
    verdict = `   ✗ ${String(err).split('\n')[0].slice(0, 96)}`;
  }

  console.log(label.padEnd(26), verdict);
}
