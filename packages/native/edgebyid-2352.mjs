/**
 * ✅✅ **THE EDGE HALF OF THE O(1)-BY-ID REQUIREMENT, WHICH NOTHING HAS MEASURED (item 2351).**
 *
 * The standing requirement is good O(1) access to get **a vertex or edge** by id. ✅ The vertex half is
 * verified: item 2281 measured `getVertexById` at 46 ns at 160k and flat, and item 2317 measured Gremlin's
 * `V(id)` at 0.21 µs flat across a 16x sweep. ⚠️ **The EDGE half has only ever appeared as a profile frame
 * (`getEdgeById`), never as a measurement** — so half of a stated requirement is unverified.
 *
 * 🔑 Flat in |E| is the whole claim, so the sweep is the instrument: an O(1) lookup is flat, anything
 * keyed by a scan is linear. ⚠️ And the row count is printed because an arm that finds NOTHING is flat
 * too — item 2317's `rows=0` trap, where a miss timed against a hit.
 */
import { Graph } from '@lenke/core';
import { E, V, count, toArray, traversal, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 20_000);
const FAN = Number(process.env.FAN ?? 3);
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 40);
const ROUNDS = Number(process.env.ROUNDS ?? 9);
const ARM = process.env.ARM ?? 'hostEdge';

const graph = new Graph();

for (let i = 0; i < NODES; i += 1) {
  graph.addVertex({ id: `v${i}`, labels: ['N'], properties: { k: i % 97 } });
}

const seen = new Set();

for (let j = 0; j < NODES * FAN; j += 1) {
  const to = ((j % NODES) * 104_729 + Math.floor(j / NODES) * 977) % NODES;

  seen.add(to);
  graph.addEdge({
    id: `e${j}`,
    from: graph.getVertexById(`v${j % NODES}`),
    to: graph.getVertexById(`v${to}`),
    labels: ['E'],
    properties: { w: j % 89 },
  });
}

if (seen.size < NODES * 0.5) {
  throw new Error(`degenerate fixture: ${seen.size} distinct endpoints of ${NODES}`);
}

/*
 * ⚠️ The TARGET id sits in the MIDDLE of insertion order, so neither end of a scan would flatter it. Only
 * the Gremlin arm uses a single id — its plan is hoisted, so the id must be fixed; the host arms vary
 * theirs per iteration (see below), which is why there is no `VERTEX_ID` constant.
 */
const EDGE_ID = `e${((NODES * FAN) / 2) | 0}`;

/* ✅ Hoisted, per item 2325's 3.96x. */
const pEdge = traversal(E(EDGE_ID), values('w'));
/*
 * ⚠️ THE MISSING TWIN (item 2372). Item 2351 recorded "Gremlin's `E(id)` is 3x its `V(id)` (620 ns against
 * item 2317's 210)" — but this probe had NO `gremVertex` arm, so that 3x compared its own measurement
 * against a DIFFERENT probe's, in a different fixture and process. That is the cross-fixture error item
 * 2354 caught on the bench's `sum`/`max` pair, repeated one item earlier and left standing for twenty.
 *
 * `values('k')` because this fixture's VERTICES carry `k` and its EDGES carry `w` — projecting `'w'` from a
 * vertex would yield nothing and time a MISS against a HIT, which is item 2317's own trap.
 */
const VERTEX_ID = `v${(NODES / 2) | 0}`;
const pVertex = traversal(V(VERTEX_ID), values('k'));
/*
 * ⚠️ AND THE PAIR ABOVE HAS A CONFOUND, which these two remove: `pEdge` and `pVertex` differ in the SOURCE
 * (`E` vs `V`) **and** in the PROJECTION (an edge property against a vertex property). A 3x between them
 * cannot be attributed to the by-id lookup while both vary — `vary-only-the-projection`'s rule, applied to
 * its own mirror image. `count()` reads no property at all, so these isolate the SOURCE.
 */
const pEdgeCount = traversal(E(EDGE_ID), count());
const pVertexCount = traversal(V(VERTEX_ID), count());

/*
 * ⚠️⚠️ **THE FIRST VERSION MEASURED 0.3 ns, WHICH IS ABOUT ONE CPU CYCLE — a `Map.get` cannot be that.**
 * The arms were `getEdgeById(EDGE_ID) === null ? 0 : 1` with the result DISCARDED and the id
 * LOOP-INVARIANT, so the JIT was free to hoist the call out of the timing loop or drop it entirely. 🔑
 * **A hoisted call is FLAT BY CONSTRUCTION**, so the "O(1) confirmed" that reading would have supported
 * was circular.
 *
 * ✅ Two changes make it honest: the id VARIES per iteration (so nothing is loop-invariant) and the
 * result is ACCUMULATED into `sink` and printed (so nothing is dead). The ids are precomputed into an
 * array, because building a template string per iteration would measure string concatenation.
 */
let sink = 0;
const EDGE_IDS = Array.from({ length: 1024 }, (_, i) => `e${(i * 37) % (NODES * FAN)}`);
const VERTEX_IDS = Array.from({ length: 1024 }, (_, i) => `v${(i * 37) % NODES}`);
let cursor = 0;

const ARMS = {
  /* ✅ THE HOST FLOOR for the edge half. */
  hostEdge: () => {
    sink += graph.getEdgeById(EDGE_IDS[cursor++ & 1023]) === null ? 0 : 1;

    return sink;
  },
  /* ✅ THE VERTEX FLOOR, as the comparison whose O(1) is already established. */
  hostVertex: () => {
    sink += graph.getVertexById(VERTEX_IDS[cursor++ & 1023]) === null ? 0 : 1;

    return sink;
  },
  /* 🔑 THE GREMLIN SURFACE: `E(id)`, the edge twin of item 2317's `V(id)`. */
  gremEdge: () => toArray(pEdge, graph).length,
  /* 🔑 AND ITS VERTEX TWIN, MEASURED IN THIS PROCESS — the arm item 2351 borrowed instead of running. */
  gremVertex: () => toArray(pVertex, graph).length,
  /* 🔑 SOURCE ONLY, no property read — the pair that attributes the gap. */
  gremEdgeCount: () => toArray(pEdgeCount, graph).length,
  gremVertexCount: () => toArray(pVertexCount, graph).length,
};

/*
 * ⚠️ BOTH GREMLIN ARMS MUST YIELD THE SAME ROW COUNT, or the comparison prices different amounts of work.
 * One edge projecting one property against one vertex projecting one property: 1 and 1.
 */
const gremEdgeRows = toArray(pEdge, graph).length;
const gremVertexRows = toArray(pVertex, graph).length;

if (gremEdgeRows !== 1 || gremVertexRows !== 1) {
  throw new Error(`unfair arms: E(id) yielded ${gremEdgeRows}, V(id) yielded ${gremVertexRows}`);
}

const arm = ARMS[ARM];

for (let w = 0; w < 300; w += 1) {
  arm();
}

let inner = 1;

for (;;) {
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    arm();
  }

  if (performance.now() - t0 >= SAMPLE_MS || inner >= 500_000) {
    break;
  }

  inner *= 2;
}

const ts = [];

for (let r = 0; r < ROUNDS; r += 1) {
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    arm();
  }

  ts.push((performance.now() - t0) / inner);
}

const sorted = [...ts].sort((a, b) => a - b);
const med = sorted[Math.floor(sorted.length / 2)];

console.log(
  `  ARM=${ARM.padEnd(11)} edges=${String(NODES * FAN).padStart(8)} ${(med * 1_000_000).toFixed(1).padStart(8)} ns  rows=${arm()}  sink=${sink}`,
);
