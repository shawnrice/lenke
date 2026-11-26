/*
 * Item 2392 — does the EXISTS one-hop count route reach the braced spelling `(b {})`, and which
 * fixture property gates the route at all?
 *
 * The spelling probe's own fixture reads 73 ms on EVERY arm, including the bare one that item 2163
 * measured at 0.90 ms, so the first question is not the braces: it is why the route declines there.
 * This probe varies ONE fixture property at a time against a fixed query set.
 *
 *   bun exists-brace-2392.mjs
 *   NODES=200000 bun exists-brace-2392.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 200_000);
const EDGES = Number(process.env.EDGES ?? NODES * 3);
const REPS = Number(process.env.REPS ?? 9);

/**
 * @param {{ extraLabelSet: boolean, indexed: boolean }} opts
 */
const build = (opts) => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: i % 3 === 0 ? ['P', 'Q', 'Univ'] : ['P', 'Univ'],
      properties: { k: i % 50, s: `s${i % 7}` },
    });
  }

  // The property the spelling probe has and item 2163's fixture does not: a SECOND vertex set
  // under a different label, which makes `:P` selective while `:Univ` stays universal.
  if (opts.extraLabelSet) {
    for (let i = 0; i < Math.max(1, Math.floor(NODES / 100)); i += 1) {
      g.addVertex({ id: `s${i}`, labels: ['S', 'Univ'], properties: { k: i, s: `t${i}` } });
    }
  }

  /*
   * SPLIT ON THE REPEAT INDEX, which the spelling probe's own fixture does NOT — and the first
   * draft of this probe copied it verbatim, which `fixture-branching.test.ts` rejected by name.
   * `(e * 104729) % NODES` is invariant under `e -> e + NODES`, so with `EDGES = 3 * NODES` every
   * vertex got THREE PARALLEL EDGES to one target instead of three distinct ones. The existence
   * count this probe measures cannot tell the difference — "has at least one out-edge" is the same
   * either way — but the general path it is compared against walks those edges, so the fixture
   * belongs in the honest shape regardless.
   */
  for (let e = 0; e < EDGES; e += 1) {
    const rep = Math.floor(e / NODES);
    const i = e % NODES;

    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(`v${(i * 104_729 + rep * 7919) % NODES}`),
      to: g.getVertexById(`v${(i * 7919 + rep * 104_729 + 1) % NODES}`),
      labels: e % 11 === 0 ? ['E', 'F'] : ['E'],
      properties: { w: e % 5, ew: e % 1000 },
    });
  }

  if (opts.indexed) {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['s'] });
    g.createIndex({ on: 'edge', kind: 'hash', keys: ['ew'] });
  }

  return g;
};

/** @type {ReadonlyArray<[string, (label: string) => string]>} */
const QUERIES = [
  [
    'bare           ',
    (L) => `MATCH (a:${L}) WHERE EXISTS { MATCH (a)-[:E]->(b) } RETURN count(*) AS c`,
  ],
  [
    'far braced  {} ',
    (L) => `MATCH (a:${L}) WHERE EXISTS { MATCH (a)-[:E]->(b {}) } RETURN count(*) AS c`,
  ],
  [
    'near braced {} ',
    (L) => `MATCH (a:${L}) WHERE EXISTS { MATCH (a {})-[:E]->(b) } RETURN count(*) AS c`,
  ],
  [
    'both braced {} ',
    (L) => `MATCH (a:${L}) WHERE EXISTS { MATCH (a {})-[:E]->(b {}) } RETURN count(*) AS c`,
  ],
];

/** Median of the post-warmup reps — a min hides a bimodal arm (items 2365-2368). */
const timeOf = (g, src) => {
  /** @type {number[]} */
  const xs = [];
  let answer = '';

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const rows = query(g, src);

    xs.push(performance.now() - t0);
    // Printed on every row: a probe whose arms disagree on the ANSWER is measuring two questions,
    // and the fixture that taught that lesson looked fine until the counts were shown.
    answer = String(rows[0].c);
  }

  const post = xs.slice(3).sort((a, b) => a - b);

  return { ms: post[Math.floor(post.length / 2)], answer };
};

/** @type {ReadonlyArray<[string, { extraLabelSet: boolean, indexed: boolean }]>} */
const CASES = [
  ['item 2163 fixture (one label set)   ', { extraLabelSet: false, indexed: false }],
  ['+ a SECOND label set                ', { extraLabelSet: true, indexed: false }],
  ['+ the probe INDEXES                 ', { extraLabelSet: true, indexed: true }],
];

for (const [name, opts] of CASES) {
  const g = build(opts);

  for (const L of opts.extraLabelSet ? ['P', 'Univ'] : ['P']) {
    const base = [];

    for (const [label, mk] of QUERIES) {
      const { ms, answer } = timeOf(g, mk(L));

      base.push(ms);
      console.log(
        `${name} :${L.padEnd(5)} ${label} ${ms.toFixed(2).padStart(8)} ms   rows=${answer}`,
      );
    }

    const spread = Math.max(...base) / Math.min(...base);

    console.log(`${' '.repeat(name.length)} :${L.padEnd(5)} spread ${spread.toFixed(2)}x\n`);
  }
}
