// Item 1934 — WHAT DOES THE GQL READ DO DIFFERENTLY AFTER A WRITE?
//
// Item 1932 established, with the write timed separately so the two are not conflated:
//
//     gql: insert ALONE  0.10 ms   gql read alone  6.86 ms   gql: insert, read  12.70  -> read ~1.84x
//     grem: insert, read 6.22 against its own 6.47 baseline  -> 0.96x, NOTHING
//
// Same core graph, same write, same hop. So the demotion is in the GQL READ PATH, not in core —
// and the other arms narrowed it: a property write costs 1.26x and an EMPTY write 1.08x (so it is
// STRUCTURAL writes only), and five inserts cost the same as one (ONE invalidation, not per-write
// work).
//
// ⚠️ THE READ QUERY IS IDENTICAL IN BOTH ARMS, which is what makes a frame DIFF meaningful here: a
// frame that appears only in the after-write arm is the demotion itself, not a difference of work.
//
//     ARM=cold|afterWrite bun --cpu-prof readdemote-prof-1934.mjs
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 20000);
const FANOUT = Number(process.env.FANOUT ?? 2);
const ROUNDS = Number(process.env.ROUNDS ?? 30);
const ARM = process.env.ARM ?? 'afterWrite';

const build = () => {
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

  return g;
};

const READ = 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x';

/*
 * ⚠️ ONE GRAPH, MANY ROUNDS — which is sound here ONLY because item 1932 measured that five inserts
 * cost the same as one, i.e. the demotion is ONE invalidation and not per-write work. So repeating
 * `insert; read` on one graph reproduces the demoted read every round without the fixture rebuild
 * a CPU profile cannot exclude. The `cold` arm reads the same graph the same number of times with
 * no write between, so the two arms differ in exactly the write.
 */
const g = build();
const t0 = performance.now();
let rows = 0;

for (let r = 0; r < ROUNDS; r += 1) {
  if (ARM === 'afterWrite') {
    query(g, 'INSERT (:W {n: 1})', {});
  }

  /*
   * 🔑 THE DECISIVE ARM. `hop-projection.ts:3066` takes the FAR-DRIVEN walk only when
   * `startLabel === undefined || vacuousLabel(graph, startLabel)` — i.e. when the start label
   * matches every vertex, so filtering by it is a no-op. This fixture is all `:T`, so it qualifies.
   * `INSERT (:W …)` adds a vertex with a DIFFERENT label, `:T` stops being vacuous, and the
   * planner correctly stops using a walk that is no longer valid.
   *
   * So inserting the SAME label must NOT demote: it leaves `:T` vacuous. If `sameLabel` matches
   * `cold`, the 1.84x is a FIXTURE ARTIFACT of a label-homogeneous graph, not a write cliff.
   */
  if (ARM === 'sameLabel') {
    query(g, 'INSERT (:T {n: 1})', {});
  }

  // And the complement: a graph that ALREADY has a second label, so the start label is
  // non-vacuous from the start and there is nothing for a write to take away.
  if (ARM === 'preMixed' && r === 0) {
    query(g, 'INSERT (:W {n: 1})', {});
  }

  rows = query(g, READ, {}).length;
}

const ms = performance.now() - t0;

console.log(
  `arm=${ARM}  ${ROUNDS} rounds  ${ms.toFixed(2)} ms total  ` +
    `${(ms / ROUNDS).toFixed(2)} ms a round  rows ${rows}`,
);
