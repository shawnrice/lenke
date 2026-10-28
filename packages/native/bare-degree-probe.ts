/**
 * ONE SHAPE PER PROCESS: what does a bare `MATCH (a:L)-[:T]->(b) RETURN count(*)` cost?
 *
 * Item 1067's subject. The degree-sum walk already answers this shape without visiting an edge
 * (item 286), but it carries a label re-check, a `try`/`catch`, a predicate call and two more
 * function calls per vertex that this shape has no use for — and a ladder over its loop body
 * measured those as most of its cost.
 *
 *   cd packages/native && SHAPE=start-labelled bun bare-degree-probe.ts
 *
 * THE FIXTURE'S FOUR EDGE-LESS `:S` VERTICES ARE LOAD-BEARING. Without them `:P` covers every
 * vertex, `vacuousLabel` elides it and the whole family answers from a bucket size in 0.00 ms —
 * the measurement would be of nothing. Four vertices out of 200,004, carrying no edges and
 * changing no answer, are what make the label non-vacuous and send these queries to the walk.
 * (That is also why the spelling probe reports this group at ~5783x: its own fixture has the same
 * four, for an unrelated group.)
 */
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

const N = Number(process.env.BD_N ?? 200_000);
const REPS = Number(process.env.BD_REPS ?? 14);

const SHAPES: Record<string, { q: string; reached: boolean }> = {
  // THE SUBJECTS, one per direction — they are mirror questions and must not diverge.
  'start-labelled': { q: 'MATCH (a:P)-[:E]->(b) RETURN count(*) AS c', reached: true },
  'far-labelled': { q: 'MATCH (a)-[:E]->(b:P) RETURN count(*) AS c', reached: true },
  // The same two with the arrow reversed, which swaps which adjacency index is read.
  'start-labelled-in': { q: 'MATCH (a:P)<-[:E]-(b) RETURN count(*) AS c', reached: true },
  'far-labelled-in': { q: 'MATCH (a)<-[:E]-(b:P) RETURN count(*) AS c', reached: true },

  // CONTROLS.
  // Both ends labelled: neither walk fits (summing out-degrees counts edges to ANY target), so
  // this keeps the per-edge tally and must not move.
  'both-ends': { q: 'MATCH (a:P)-[:E]->(b:P) RETURN count(*) AS c', reached: false },
  // Unlabelled: the O(1) bucket size, which was always free.
  bare: { q: 'MATCH (a)-[:E]->(b) RETURN count(*) AS c', reached: false },
  // A clause WHERE: a real predicate, so the fast path declines and the general walk answers.
  filtered: { q: 'MATCH (a:P)-[:E]->(b) WHERE a.k > 10 RETURN count(*) AS c', reached: false },
  // An INLINE constraint, same reason.
  inline: { q: 'MATCH (a:P {k: 7})-[:E]->(b) RETURN count(*) AS c', reached: false },
  // TWO types: summing per-type bucket sizes needs a types loop, which the fast path refuses.
  'two-types': { q: 'MATCH (a:P)-[:E|F]->(b) RETURN count(*) AS c', reached: false },
  // Not a count at all.
  rows: { q: 'MATCH (a:P)-[:E]->(b) RETURN a.k AS c', reached: false },
};

const name = process.env.SHAPE ?? 'start-labelled';
const shape = SHAPES[name];

if (shape === undefined) {
  console.error(`SHAPE must be one of: ${Object.keys(SHAPES).join(', ')}`);
  process.exit(1);
}

const g = new TsGraph();
const vs = [];

for (let i = 0; i < N; i++) {
  vs.push(g.addVertex({ id: `v${i}`, labels: ['P', 'Univ'], properties: { k: i % 50 } }));
}

for (let i = 0; i < 4; i++) {
  g.addVertex({ id: `s${i}`, labels: ['S', 'Univ'], properties: { k: i } });
}

for (let e = 0; e < N * 3; e++) {
  g.addEdge({
    id: `e${e}`,
    labels: e % 11 === 0 ? ['E', 'F'] : ['E'],
    from: vs[(e * 104729) % N],
    to: vs[(e * 7919) % N],
    properties: { w: e % 5 },
  });
}

const series: number[] = [];

for (let r = 0; r < REPS; r++) {
  const t0 = performance.now();
  const rows = tsQuery(g, shape.q);
  const ms = performance.now() - t0;

  series.push(ms);

  if (r === 0) {
    console.log(`answer=${JSON.stringify(rows)}`);
  }
}

const warm = series.slice(3).sort((a, b) => a - b);

console.log(`series ${series.map((m) => m.toFixed(1)).join(' ')}`);
console.log(
  `${name.padEnd(18)} ${shape.reached ? 'SUBJECT' : 'CONTROL'}  median(reps 4+) ${warm[Math.floor(warm.length / 2)].toFixed(2)} ms   N=${N}`,
);
