// Item 1951 — THREE hand arms for the filtered hop, because item 1949's ceiling was the wrong one.
//
// Item 1949 priced `MATCH (a:T)-[:E]->(b:T) FILTER b.n > $p0 RETURN b.n AS x` against ONE ceiling:
// a plain edge pass, 73.4 ms. The item-1951 profile says that ceiling is not the best arm available
// and names why: in the HOMOGENEOUS arm the engine runs `farDrivenPredicatedHopWalk`, which
// evaluates the predicate ONCE PER FAR VERTEX and then copies a template `bucket.size` times. One
// isolated off-label vertex makes `T` non-vacuous, `predicatedHopRoute`'s gate drops to the general
// per-edge closure, and the predicate goes from 200,000 evaluations to 1,000,000.
//
// SO THE CANDIDATE ARM IS NOT AN EDGE PASS. Staying FAR-driven keeps two things an edge pass
// throws away:
//   - the predicate stays at once per far vertex, and
//   - a far vertex that FAILS it skips its WHOLE bucket — a short-circuit over edges.
// What it gives up is the template-copy fold, because once a start label can reject an edge the row
// count is no longer `bucket.size`.
//
//     arm A  start-driven, predicate per EDGE          — models what the engine does today
//     arm B  edge pass over `edgesByLabel`             — item 1949's ceiling
//     arm C  far-driven, predicate per FAR VERTEX,     — the candidate
//            start label per edge
//
// COVERAGE IS SWEPT, because arm C is O(V_far + E) whatever the start label excludes while arm A
// iterates the start BUCKET and is sub-linear for a selective label — the same crossover item 1938
// measured at 25x against a boolean gate. |E| and the vertex set are held FIXED across the sweep
// (off-label vertices are ADDED and isolated, never relabelled) so the row count moves only
// through the start test, which every arm applies.
//
//     bun filterceiling-1951.mjs
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 9);
const THRESH = 5;
const Q = 'MATCH (a:T)-[:E]->(b:T) FILTER b.n > $p0 RETURN b.n AS x';

/**
 * `extra` isolated off-label vertices make `T` non-vacuous without touching the edge set; `offStart`
 * instead takes that many of the EDGE-BEARING vertices off `T`, which is what actually moves start
 * coverage. Both are needed: the first is item 1943's realistic mode, the second sweeps the gate.
 */
const build = (offStart) => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    // The off-label vertices are a CONTIGUOUS high block, so the `T` bucket stays dense and the
    // comparison is about coverage rather than about bucket fragmentation.
    const labels = i >= NODES - offStart ? ['Z'] : ['T'];

    g.addVertex({ id: String(i + 1), labels, properties: { n: i % 12 } });
  }

  for (let e = 0; e < NODES * FANOUT; e += 1) {
    const i = e % NODES;
    // Split on the REPEAT INDEX — the generator trap CLAUDE.md records.
    const hop = Math.floor(e / NODES);

    g.addEdge({
      id: `e${String(e)}`,
      from: g.getVertexById(String(i + 1)),
      to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
      labels: ['E'],
      properties: {},
    });
  }

  if (offStart === 0) {
    // Still make `T` non-vacuous, or the engine takes the vacuous route and the comparison is
    // against a different question. ISOLATED, so no answer changes.
    g.addVertex({ id: 'off', labels: ['Z'], properties: { n: 0 } });
  }

  return g;
};

/** ARM A — start-driven, far vertex resolved and predicate evaluated per EDGE. */
const armA = (g) => () => {
  const rows = [];

  for (const v of g.verticesByLabel.get('T') ?? []) {
    const bucket = v.adjFrom?.get('E');

    if (bucket === undefined) {
      continue;
    }

    for (const edge of bucket) {
      const far = edge.to;

      if (!far.labels.has('T')) {
        continue;
      }

      const n = far.properties.n ?? null;

      if (!(n > THRESH)) {
        continue;
      }

      rows.push({ x: n });
    }
  }

  return rows;
};

/** ARM B — one edge pass, both endpoint labels then the predicate (item 1949's ceiling). */
const armB = (g) => () => {
  const rows = [];
  const bucket = g.edgesByLabel.get('E');

  if (bucket !== undefined) {
    for (const edge of bucket) {
      if (!edge.from.labels.has('T')) {
        continue;
      }

      const far = edge.to;

      if (!far.labels.has('T')) {
        continue;
      }

      const n = far.properties.n ?? null;

      if (!(n > THRESH)) {
        continue;
      }

      rows.push({ x: n });
    }
  }

  return rows;
};

/** ARM C — far-driven: predicate ONCE per far vertex, start label per edge, no fold. */
const armC = (g) => () => {
  const rows = [];

  for (const far of g.verticesByLabel.get('T') ?? []) {
    const bucket = far.adjTo?.get('E');

    if (bucket === undefined || bucket.size === 0) {
      continue;
    }

    const n = far.properties.n ?? null;

    // THE SHORT-CIRCUIT an edge pass cannot have: one test skips this vertex's whole bucket.
    if (!(n > THRESH)) {
      continue;
    }

    for (const edge of bucket) {
      if (!edge.from.labels.has('T')) {
        continue;
      }

      rows.push({ x: n });
    }
  }

  return rows;
};

const f = (x) => x.ms.toFixed(1).padStart(7);

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const time = (fn) => {
  const ts = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const rows = fn();

    ts.push(performance.now() - t0);

    if (r === 0) {
      ts.rows = rows.length;
      // A multiset checksum, so an arm that visits the right edges in the wrong nesting still
      // compares equal but a WRONG answer does not.
      let sum = 0;

      for (const row of rows) {
        sum += row.x;
      }

      ts.sum = sum;
    }
  }

  return { ms: med(ts), rows: ts.rows, sum: ts.sum };
};

console.log(
  `NODES=${String(NODES)} FANOUT=${String(FANOUT)} |E|=${String(NODES * FANOUT)} REPS=${String(REPS)} median\n`,
);
console.log('offStart\tcoverage\tengine\t\tA start-drv\tB edge pass\tC far-drv\trows\tagree');

for (const offStart of [0, 2000, 20000, 60000, 100000, 140000, 180000]) {
  const g = build(offStart);
  const coverage = (g.verticesByLabel.get('T')?.size ?? 0) / g.vertexCount;

  const eng = time(() => query(g, Q, { p0: THRESH }));
  const a = time(armA(g));
  const b = time(armB(g));
  const c = time(armC(g));

  const agree =
    a.rows === b.rows &&
    b.rows === c.rows &&
    c.rows === eng.rows &&
    a.sum === b.sum &&
    b.sum === c.sum;

  console.log(
    `${String(offStart).padEnd(8)}\t${coverage.toFixed(3)}\t\t${f(eng)}\t\t${f(a)}\t\t${f(b)}\t\t${f(c)}\t${String(eng.rows)}\t${String(agree)}`,
  );

  // The microtask drain pins a discarded Graph in full — `graph-pinned-until-microtask-drain`.
  await new Promise((r) => setTimeout(r, 0));
}
