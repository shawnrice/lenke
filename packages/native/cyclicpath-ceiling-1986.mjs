// Item 1986 — what IS a one-hop `cyclicPath()` worth? Priced before anything is built.
//
// `V().out(T).cyclicPath()` is the SECOND largest absolute cost on the Gremlin workload screen —
// **200.91 ms for TWO rows** at `NODES=200000` (item 1954's reading), behind only `tree()`.
//
// **AND ITS REFUSAL IS SUPERSEDED, WHICH IS WHY THIS IS BEING PRICED AT ALL.** Item 1923
// declined it with a reason: `cyclicPath` is `simplePath`'s complement, so a rewrite needs
// `where(eq(tag))`, and item 1912's rung explicitly declines `eq`. That still holds for the REWRITE
// route. But item 1923's own entry records a mechanism the refusal never considered, and
// `index.ts`'s note does not carry it:
//
//     a ONE-HOP `cyclicPath` is exactly the SELF-LOOP edges, so it needs no path tracking and no
//     `where(eq(t))` at all.
//
// Verified against the engine on a 3-vertex fixture with a PARALLEL self-loop before writing this:
//
//     V().out(E).cyclicPath()  =>  ["a", "a", "c"]      one row per self-loop EDGE
//     V().in_(E).cyclicPath()  =>  ["a", "a", "c"]      a self-loop sits in both directions
//
// SO THE CEILING IS A SELF-LOOP SCAN, and this prices it two ways, because which one is the
// ceiling depends on something the screen's fixture cannot show: whether the edges of a type are
// reachable as a set (O(|E_T|)) or only through per-vertex adjacency (O(V + E_T)).
//
// THE ANSWERS ARE COMPARED, not just the times — a ceiling that answers something else is not a
// ceiling. Item 600's rule, and the parallel self-loop is in the fixture for exactly that reason.
//
//     bun cyclicpath-ceiling-1986.mjs
//     NODES=200000 bun cyclicpath-ceiling-1986.mjs
import { Graph } from '@lenke/core';
import { cyclicPath, out, toArray, traversal, V } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 7);
const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['P'], properties: { k: i % 97 } });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  // The workload screen's own generator, verbatim — split on the REPEAT INDEX.
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${String(e)}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
    labels: ['E'],
    properties: {},
  });
}

/*
 * A PARALLEL SELF-LOOP IS ADDED DELIBERATELY. The screen's generator produces self-loops only by
 * coincidence (2 of 1,000,000), and a fixture with at most one self-loop per vertex cannot tell a
 * per-EDGE answer from a per-VERTEX one — which is the single thing a self-loop route could get
 * wrong. Two parallel loops at one vertex must yield TWO rows.
 */
g.addEdge({
  id: 'loopA',
  from: g.getVertexById('1'),
  to: g.getVertexById('1'),
  labels: ['E'],
  properties: {},
});
g.addEdge({
  id: 'loopB',
  from: g.getVertexById('1'),
  to: g.getVertexById('1'),
  labels: ['E'],
  properties: {},
});

/** THE ENGINE as it stands — the general path-tracking route. */
const engineArm = () => toArray(traversal(V(), out('E'), cyclicPath()), g).map((v) => v.id);

/**
 * CEILING A: per-vertex adjacency, O(V + |E_T|). Drives the SAME order the engine produces —
 * vertex order, then each vertex's own edges — which is what makes the answers comparable.
 */
const handAdj = () => {
  const rows = [];

  for (const v of g.vertices) {
    const bucket = v.adjFrom?.get('E');

    if (bucket === undefined) {
      continue;
    }

    for (const e of bucket) {
      if (e.to === v) {
        rows.push(e.to.id);
      }
    }
  }

  return rows;
};

/**
 * CEILING B: the type's edge set directly, O(|E_T|), skipping the per-vertex walk entirely. Faster
 * if it exists — and its ORDER is edge-insertion order, NOT vertex order, so it is priced as an
 * upper bound on speed and NOT proposed as the route unless the orders coincide.
 */
const handEdges = () => {
  const rows = [];
  const box = g.edgesByLabel?.get('E');

  if (box === undefined) {
    return undefined;
  }

  for (const e of box) {
    if (e.from === e.to) {
      rows.push(e.to.id);
    }
  }

  return rows;
};

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const time = (fn) => {
  const ts = [];
  let got;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    got = fn();
    ts.push(performance.now() - t0);
  }

  return { ms: med(ts), got };
};

console.log(
  `NODES=${String(NODES)} FANOUT=${String(FANOUT)} |E|=${String(g.edgeCount)} REPS=${String(REPS)} median`,
);

const engine = time(engineArm);
const adj = time(handAdj);
const edges = time(handEdges);

console.log(
  `\nengine  (general)        ${engine.ms.toFixed(2).padStart(8)} ms   rows ${String(engine.got.length)}`,
);
console.log(
  `CEILING A per-vertex     ${adj.ms.toFixed(2).padStart(8)} ms   rows ${String(adj.got.length)}`,
);
console.log(
  edges.got === undefined
    ? 'CEILING B edge set        — no `edgesByLabel` on Graph'
    : `CEILING B edge set       ${edges.ms.toFixed(2).padStart(8)} ms   rows ${String(edges.got.length)}`,
);

// ANSWER FIRST, THEN THE RATIO — a ceiling that answers something else is not a ceiling.
const same = (a, b) =>
  a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);

console.log(`\nengine answer            ${JSON.stringify(engine.got)}`);
console.log(`A agrees with engine     ${String(same(engine.got, adj.got))}`);
const bVerdict = edges.got === undefined ? 'n/a' : String(same(engine.got, edges.got));
// B's order differing is EXPECTED, not a failure — it is why B is a speed bound and not the route.
const bNote =
  edges.got !== undefined && !same(engine.got, edges.got)
    ? '   <- ORDER differs; speed bound only'
    : '';

console.log(`B agrees with engine     ${bVerdict}${bNote}`);

const bRatio =
  edges.got === undefined ? '' : `   ceiling B ratio ${(engine.ms / edges.ms).toFixed(1)}x`;

console.log(`\nceiling A ratio          ${(engine.ms / adj.ms).toFixed(1)}x${bRatio}`);
