// Item 1917 — IS THE LABEL-ELISION BLOCKER A REAL WRONG ANSWER, OR ONLY A THEORETICAL ONE?
//
// `effectiveLabel` drops a label test when the label is carried by EVERY vertex, decided per
// execution from `graph.verticesByLabel.get(l).size === vertexCount`. The public setter
// `v.labels = [...]` updates the VERTEX (its `hasLabel` is correct afterwards) but does NOT update
// that index. So after one setter call the index can still report a label as vacuous when it is not.
//
// This asks whether that turns into a wrong ANSWER through the public API today, using the elisions
// that already exist (`hop2-projection.ts`, `chain-projection.ts`) — not the one item 1917 priced
// and did not add.
//
// ⚠️ THE ORACLE IS THE SAME QUESTION ASKED SO THE ELISION CANNOT APPLY. `:U` is carried by exactly
// one vertex, so a pattern written against `U` can never be elided, and `hasLabel` on each vertex is
// the ground truth either way. Both are printed beside the engine's answer.
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = 6;

const build = () => {
  const g = new Graph();

  for (let i = 0; i < N; i += 1) {
    g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i } });
  }

  // A simple chain 1->2->3->4->5->6 so the two-hop pattern has rows.
  for (let i = 0; i < N - 1; i += 1) {
    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById(String(i + 1)),
      to: g.getVertexById(String(i + 2)),
      labels: ['E'],
      properties: {},
    });
  }

  return g;
};

const Q = 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN a.n AS an, b.n AS bn, c.n AS cn';

// 1. The baseline: every vertex is T, so every 2-hop matches. T IS genuinely vacuous here.
{
  const g = build();
  const got = query(g, Q, {});

  console.log(
    `baseline (all T):            ${got.length} rows  T bucket=${g.verticesByLabel.get('T')?.size}`,
  );
}

// 2. Via the SUPPORTED mutator, which maintains the index.
{
  const g = build();

  g.removeLabelFromVertex('T', g.getVertexById('3'));

  const got = query(g, Q, {});
  const truth = [...Array(N - 2).keys()].filter((i) => {
    const vs = [i + 1, i + 2, i + 3].map((k) => g.getVertexById(String(k)));

    return vs.every((v) => v.hasLabel('T'));
  }).length;

  console.log(
    `removeLabelFromVertex('T', v3):  ${got.length} rows   hasLabel truth=${truth}   ` +
      `T bucket=${g.verticesByLabel.get('T')?.size}  ${got.length === truth ? '✅ agrees' : '❌ DISAGREES'}`,
  );
}

// 3. Via the public SETTER, which does not.
{
  const g = build();
  const v3 = g.getVertexById('3');

  v3.labels = ['U'];

  const got = query(g, Q, {});
  const truth = [...Array(N - 2).keys()].filter((i) => {
    const vs = [i + 1, i + 2, i + 3].map((k) => g.getVertexById(String(k)));

    return vs.every((v) => v.hasLabel('T'));
  }).length;

  console.log(
    `v3.labels = ['U']:               ${got.length} rows   hasLabel truth=${truth}   ` +
      `T bucket=${g.verticesByLabel.get('T')?.size}  ${got.length === truth ? '✅ agrees' : '❌ DISAGREES — WRONG ANSWER'}`,
  );
  console.log(
    `  v3.hasLabel('T') = ${String(v3.hasLabel('T'))}  v3.hasLabel('U') = ${String(v3.hasLabel('U'))}`,
  );
  console.log(`  rows: ${JSON.stringify(got)}`);
}
