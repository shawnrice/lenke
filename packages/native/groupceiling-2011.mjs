/**
 * WHAT IS THE CEILING FOR A GROUPED HOP / CHAIN COUNT? (item 2011)
 *
 * The body split put the `grouped` family's cost in two places: a 2-hop `chain count` at **55.74 ms**
 * and a 1-hop `hop count` at **18.59**, against scan bodies at 0.09-0.35.
 *
 * 🔑 **NEITHER NEEDS TO VISIT A ROW.** Both group by a property of the START vertex, so every path
 * out of one source lands in that source's own group:
 *
 *   - `MATCH (a)-[:E]->(b) … GROUP BY a.n` — source `a` contributes `degree(a)` to group `a.n`. One
 *     pass over the vertices, reading adjacency SIZES. O(|V|).
 *   - `MATCH (a)-[:E]->(b)-[:E]->(c) … GROUP BY a.n` — source `a` contributes
 *     `sum over b in N(a) of degree(b)`. One pass over the edges. O(|E|).
 *
 * ⚠️ THE CEILING USES ADJACENCY SIZES, NOT A CSR, and that is the honest choice here rather than the
 * faster-looking one: `soleTypeBucket`-style `Map.get` on the type box is what the engine's own
 * grouped rungs read, and item 1999's lesson is that a ceiling must use the structure the cure would
 * use. A CSR would make the ceiling look better and the ratio bigger.
 *
 * ⚠️ ANSWERS CHECKED AGAINST THE ENGINE as sorted (group, count) pairs — a ceiling that answers
 * something else is not a ceiling, and a grouped count is easy to get subtly wrong (the group of a
 * vertex with a missing property, an empty group).
 *
 *     bun groupceiling-2011.mjs
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
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${String(e)}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
    labels: ['E'],
    properties: { w: i % 13 },
  });
}

const degOf = (v) => v.adjFrom?.get('E')?.size ?? 0;

/** `GROUP BY a.n` over a 1-hop pattern: each source adds its own out-degree to its own group. */
const handHop = () => {
  const acc = new Map();

  for (const v of g.vertices) {
    const d = degOf(v);

    if (d === 0) {
      continue;
    }

    const key = v.properties.n;

    acc.set(key, (acc.get(key) ?? 0) + d);
  }

  return [...acc].sort((a, b) => Number(a[0]) - Number(b[0]));
};

/** `GROUP BY a.n` over a 2-hop pattern: each source adds the degree sum of its neighbours. */
const handChain = () => {
  const acc = new Map();

  for (const v of g.vertices) {
    const box = v.adjFrom?.get('E');

    if (box === undefined) {
      continue;
    }

    let n = 0;

    for (const e of box) {
      n += degOf(e.to);
    }

    if (n === 0) {
      continue;
    }

    const key = v.properties.n;

    acc.set(key, (acc.get(key) ?? 0) + n);
  }

  return [...acc].sort((a, b) => Number(a[0]) - Number(b[0]));
};

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const time = (fn) => {
  const ts = [];
  let out;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    out = fn();
    ts.push(performance.now() - t0);
  }

  return { ms: med(ts), out };
};
const engineRows = (text) =>
  [...query(g, text, {})].map((r) => [r.g, r.c]).sort((a, b) => Number(a[0]) - Number(b[0]));

const CASES = [
  [
    'hop   GROUP BY a.n',
    'MATCH (a:T)-[:E]->(b:T) LET g = a.n RETURN g, count(*) AS c GROUP BY g',
    handHop,
  ],
  [
    'chain GROUP BY a.n',
    'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) LET g = a.n RETURN g, count(*) AS c GROUP BY g',
    handChain,
  ],
];

console.log(`|V|=${String(NODES)} |E|=${String(g.edgeCount)} median of ${String(REPS)}\n`);
console.log('case                  engine ms   ceiling ms     ratio   groups   agree');

for (const [name, text, hand] of CASES) {
  // eslint-disable-next-line lenke/no-raw-interpolation -- `text` is a literal from CASES above
  const eng = time(() => engineRows(text));
  const h = time(hand);
  const agree = JSON.stringify(eng.out) === JSON.stringify(h.out);
  const cells = [
    name.padEnd(21),
    eng.ms.toFixed(2).padStart(9),
    h.ms.toFixed(2).padStart(12),
    `${(eng.ms / h.ms).toFixed(1)}x`.padStart(9),
    String(eng.out.length).padStart(8),
    (agree ? 'YES' : 'NO ⚠️').padStart(7),
  ];

  console.log(cells.join(' '));

  if (!agree) {
    console.log(`  engine  ${JSON.stringify(eng.out).slice(0, 110)}`);
    console.log(`  ceiling ${JSON.stringify(h.out).slice(0, 110)}`);
  }
}

console.log(
  "\n# ⚠️ The ceiling reads adjacency SIZES — the structure the engine's own grouped rungs read —\n" +
    '#    rather than a CSR, which would make the ratio look bigger than a cure could deliver.',
);
