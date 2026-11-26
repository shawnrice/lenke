/**
 * DOES THE CSR-BACKED REACH ARM REGRESS A **COLD** QUERY? (item 2005)
 *
 * **THE WARM NUMBER CANNOT ANSWER THIS, AND IT IS THE ONE A SCREEN REPORTS.** Item 2005 replaced
 * `runReach`'s `Set<string>`-keyed BFS with a walk over `csrFor`'s slots, worth 2.4-3.2x on the
 * screen's rows. But the old arm needed NO CSR, so the new one makes a FIRST ask on a fresh topology
 * pay a build — and `varlen-body-split-2000.mjs` runs five reps against one graph, so four of its
 * five measurements find the CSR already cached. A many-reps harness flatters exactly this change.
 *
 * THIS IS ITEM 1889'S SECOND-ASK QUESTION, which that item answered with a `seenBefore` gate: a
 * one-shot query must not pay for a structure it will not reuse. So the question here is not "is
 * warm faster" (measured: yes) but "is COLD not slower" — and if it is slower, this arm needs the
 * same gate.
 *
 * A FRESH GRAPH PER REP, and the build is OUTSIDE the timed region. The graph construction is far
 * more expensive than the query, so timing it would bury the difference entirely — which is the
 * `PROBES.md` closed-frames problem in miniature.
 *
 *     bun reach-cold-2005.mjs
 *     NODES=40000 REPS=9 bun reach-cold-2005.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 20_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 7);

const build = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 97 } });
  }

  // Splits on the repeat index — CLAUDE.md's rule, or one vertex's whole fanout lands on one target.
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

  return g;
};

const SHAPES = {
  'plain {1,2}': 'MATCH (a:T)-[:E]->{1,2}(b:T) RETURN DISTINCT b.n AS x',
  'TRAIL {1,3}': 'MATCH TRAIL (a:T)-[:E]->{1,3}(b:T) RETURN DISTINCT b.n AS x',
  'plain unbounded': 'MATCH (a:T)-[:E]->+(b:T) RETURN DISTINCT b.n AS x',
  'seeded {1,2}': 'MATCH (a:T)-[:E]->{1,2}(b:T) WHERE a.n = 3 RETURN DISTINCT b.n AS x',
};

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

console.log(`|V|=${String(NODES)} fanout=${String(FANOUT)} reps=${String(REPS)} median\n`);
console.log('shape              COLD ms   WARM ms   cold/warm   rows');

for (const [name, text] of Object.entries(SHAPES)) {
  const cold = [];
  const warm = [];
  let rows = 0;

  for (let r = 0; r < REPS; r += 1) {
    // A FRESH graph, so the CSR cache (keyed on the graph and its topologyVersion) is empty.
    const g = build();
    const t0 = performance.now();
    const first = [...query(g, text, {})];

    cold.push(performance.now() - t0);
    rows = first.length;

    // The SAME graph again: the CSR is now cached, which is what the screen measures.
    const t1 = performance.now();

    void [...query(g, text, {})];
    warm.push(performance.now() - t1);
  }

  const c = med(cold);
  const w = med(warm);

  console.log(
    `${name.padEnd(18)} ${c.toFixed(2).padStart(7)} ${w.toFixed(2).padStart(9)} ` +
      `${(c / w).toFixed(2).padStart(10)}x ${String(rows).padStart(6)}`,
  );
}
