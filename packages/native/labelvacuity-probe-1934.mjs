// Item 1934 — THE FAR-DRIVEN HOP WALK IS ONLY AVAILABLE TO A LABEL-HOMOGENEOUS GRAPH.
//
// `hop-projection.ts:3066` takes the far-driven walk only when
// `startLabel === undefined || vacuousLabel(graph, startLabel)`, and `vacuousLabel` is
// `verticesByLabel.get(name).size === graph.vertexCount` — so ONE vertex of any other label
// disqualifies it for the WHOLE graph, permanently. Item 167 states the reason: "a start label it
// cannot apply by iteration is only ignorable when no vertex fails it".
//
// AND EVERY READ SCREEN IN THIS REPO IS LABEL-HOMOGENEOUS. `gql-coverage-screen-1901.mjs`
// builds `labels: i % 6 === 2 ? ['T', 'U'] : ['T']` — every vertex carries `T`, so `T` IS vacuous
// and all its reads take the far-driven arm. A real graph (`Person` and `Company`) never does. That
// makes every GQL hop number on that screen measured on an arm a realistic graph cannot reach.
//
// THE GAP IS MEASURABLE WITH EXISTING SYNTAX, no code change needed to price it: on a graph where
// `T` is NOT universal, the UNLABELLED start spelling has no label to disqualify it, so it still
// gets the far-driven walk. `MATCH (a)-[:E]->(b:T)` against `MATCH (a:T)-[:E]->(b:T)` over the same
// graph is therefore far-driven against start-driven, with the answer held identical by
// construction when every edge SOURCE carries T.
//
//     bun labelvacuity-probe-1934.mjs
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 50000);
const FANOUT = Number(process.env.FANOUT ?? 2);
const REPS = Number(process.env.REPS ?? 9);

/**
 * `offLabel` vertices carry `U` INSTEAD of `T`, which is what makes `T` non-vacuous. They are
 * given NO outgoing E-edges, so `MATCH (a)-[:E]->(b:T)` and `MATCH (a:T)-[:E]->(b:T)` return the
 * SAME rows — otherwise the two spellings would be different questions and the ratio meaningless.
 */
const build = (offLabel) => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    const off = i < offLabel;

    g.addVertex({
      id: String(i + 1),
      labels: off ? ['U'] : ['T'],
      properties: { n: i % 97 },
    });
  }

  for (let e = 0; e < (NODES - offLabel) * FANOUT; e += 1) {
    const i = offLabel + (e % (NODES - offLabel));
    const hop = Math.floor(e / (NODES - offLabel));
    const target = offLabel + ((i * 7 + 3 + hop * 2_654_435_761) % (NODES - offLabel));

    g.addEdge({
      id: `e${String(e)}`,
      from: g.getVertexById(String(i + 1)),
      to: g.getVertexById(String(target + 1)),
      labels: ['E'],
      properties: {},
    });
  }

  return g;
};

const time = (g, q) => {
  const ser = [];
  let rows = 0;

  for (let r = 0; r < REPS + 2; r += 1) {
    const t0 = performance.now();

    rows = query(g, q, {}).length;

    const ms = performance.now() - t0;

    if (r >= 2) {
      ser.push(ms);
    }
  }

  ser.sort((a, b) => a - b);

  return [ser[ser.length >> 1], rows];
};

const LABELLED = 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x';
const UNLABELLED = 'MATCH (a)-[:E]->(b:T) RETURN b.n AS x';
/*
 * THE CEILING FOR THE FIX, AND IT IS WRITABLE TODAY. `IS LABELED` is a per-row label test, so
 * this is exactly "far-driven walk + the start label applied per element" — the shape a rewrite
 * would produce. If it lands near UNLABELLED rather than near LABELLED, then the optimization is a
 * PLAN REWRITE (`MATCH (a:T)-…` -> `MATCH (a)-… WHERE a IS LABELED T` when T is non-vacuous) and
 * NOT an edit to the central hop walk — which matters, because [[executor-edits-perturb]] measures
 * a new walk variant costing unrelated rows up to 16%.
 */
const PERROW = 'MATCH (a)-[:E]->(b:T) WHERE a IS LABELED T RETURN b.n AS x';

console.log(`${NODES} vertices, median of ${REPS}. offLabel = vertices carrying U instead of T.\n`);
console.log('offLabel   T vacuous?   a:T (ms)   a (ms)   a+ISLABELED   ratio   rows agree');
console.log('-'.repeat(78));

for (const offLabel of [0, 1, 10, Math.floor(NODES * 0.1)]) {
  const g = build(offLabel);
  const vacuous = offLabel === 0;
  const [lab, rowsA] = time(g, LABELLED);
  const [unl, rowsB] = time(g, UNLABELLED);
  const [per, rowsC] = time(g, PERROW);

  const agree = String(rowsA === rowsB && rowsA === rowsC).padStart(12);
  const cells = [
    String(offLabel).padStart(8),
    String(vacuous).padStart(12),
    lab.toFixed(2).padStart(10),
    unl.toFixed(2).padStart(8),
    per.toFixed(2).padStart(13),
    `${(lab / per).toFixed(2).padStart(7)}x`,
    agree,
  ];

  console.log(cells.join(' '));
}

console.log(
  '\nA ratio is only readable where `rows agree` is true — otherwise the two spellings are\n' +
    '   different questions and the comparison is meaningless.',
);
