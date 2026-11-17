/*
 * Item 2118 — `chainFoldLevels` starves `hop2FoldedAggregate`. Is that a loss?
 *
 * 🔑 THE REVIVED CENSUS (item 2117) reported `hop2FoldedAggregate` as **willing somewhere and firing
 * nowhere**, starved by `chainFoldLevels` on `MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN count(DISTINCT c)`.
 *
 * ⚠️⚠️ **THE STAKES ARE A SHIPPED FIX.** `hop2FoldedAggregate` exists because of item 1824: fixing the
 * chain widths left TWO hops at 29.5 ms, *"3.8x the now-fixed depth 3 and 4.9x its own `rows` twin"*,
 * and that item built this rung to remove the inversion. If `chainFoldLevels` now serves the shape
 * WORSE, item 1824's 3.8x has been silently undone by a later rung landing above it.
 *
 * 🔑 A STARVED RUNG IS A CANDIDATE, NOT A FINDING — item 418 measured a branch moved ahead of a hot
 * dispatch costing the shape it does not claim 1.12x, and `rewrites.ts` says each chain position is for
 * correctness, for cost, or only for reading. So this prices both arms instead of assuming.
 *
 * ⚠️ THE SHAPES AROUND IT ARE CONTROLS, because the two rungs disagree only at ONE width. Depth 3 is
 * `chainFoldLevels`'s own shape (it must not move), and the `rows` twin is item 1824's other reference.
 *
 * ARM is read from the env and only labels the output — the actual gating is a source edit, so the
 * label and the build must be checked against each other by the caller (`name-ab-arms-for-what-they-are`).
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const REPS = Number(process.env.REPS ?? 11);
const ARM = process.env.ARM ?? '?';
const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i % 97, k: `k${i % 1000}` } });
}

/*
 * ⚠️ SPLIT ON THE REPEAT INDEX, not `k % NODES` — CLAUDE.md's generator rule. `(a*k+b) % N` is invariant
 * under `k -> k + N`, so a flat loop sends one vertex's whole fanout to a single target and every k-hop
 * count becomes `F^k * N` by construction.
 */
let e = 0;

for (let d = 0; d < FANOUT; d += 1) {
  for (let i = 0; i < NODES; i += 1) {
    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(`v${i}`),
      to: g.getVertexById(`v${(i * 7 + 3 + d * 104_729) % NODES}`),
      labels: ['E'],
      properties: {},
    });
    e += 1;
  }
}

const targets = new Set();

for (const edge of g.edgesById.values()) {
  targets.add(edge.to.id);
}

const shapes = {
  /* 🔑 THE CONTESTED SHAPE: two hops, `count(DISTINCT <far element>)`. */
  'hop2.distinctcount': 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN count(DISTINCT c) AS c',
  /* ⚠️ ITEM 1824's OTHER REFERENCE: the same width, a property rather than the element. */
  'hop2.distinctcountprop': 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN count(DISTINCT c.n) AS c',
  /* ⚠️ CONTROL — depth 3 is `chainFoldLevels`'s own shape and must not move. */
  'hop3.distinctcount': 'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN count(DISTINCT d) AS c',
  /* ⚠️ CONTROL — item 1824's `rows` twin, which neither rung claims. */
  'hop2.distinctrows': 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN DISTINCT c.n AS n',
  /* ⚠️ CONTROL — a plain two-hop count, answered by a different rung entirely. */
  'hop2.count': 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN count(*) AS c',
};

console.log(
  `  ARM=${ARM} NODES=${NODES} FANOUT=${FANOUT} edges=${e} distinct targets=${targets.size}, median of ${REPS}`,
);

const out = [];

for (const [name, q] of Object.entries(shapes)) {
  const series = [];
  let answer = '';

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const rows = query(g, q, {});

    series.push(performance.now() - t0);
    answer = JSON.stringify(rows).slice(0, 24);
  }

  const kept = series.slice(3).sort((a, b) => a - b);

  out.push(`${name}=${kept[Math.floor(kept.length / 2)].toFixed(2)}`);
  // ⚠️ The ANSWER is printed per shape: a route change that altered it is a wrong answer, not a win.
  console.log(
    `    ${name.padEnd(24)} ${kept[Math.floor(kept.length / 2)].toFixed(2).padStart(8)} ms   ${answer}`,
  );
}

console.log(`  ${out.join(' ')}`);
