/*
 * Item 2063 — IS THERE A TIGHT-LOOP COUNT FOR THE EDGE-FILTERED WALK, OR IS ITS DRAIN ALREADY THE FLOOR?
 *
 * Item 2062's census found exactly three rows reaching `countProjectedWalk`. One got a tight-loop
 * `count()` (1.64x). The other two are the edge-filtered walk — and they are the rows where the
 * GENERATOR arm was 3x WORSE, so their drain is doing something right:
 *
 *     edge: outE.has(w).inV.count    drain 12.67   iterate 37.94
 *     edge: outE.has(w).count        drain 10.89   iterate 38.88
 *
 * ⚠️⚠️ **PRICE BEFORE BUILDING.** A `drain().length` still materializes every row, which is what made
 * the scan row worth 1.64x — but this walk's drain is a tight array fill that item 1893 already
 * measured against a hand walk, and `pick(edge)` may be most of its cost. If the drain is already
 * near the floor there is nothing here, and that is the likely answer for `… .count()` where the
 * projection is the element itself.
 *
 * ⚠️ THE FLOORS MUST ANSWER THE SAME NUMBER as the engine, or they price a different query.
 */
import { Graph } from '@lenke/core';
import { count, gt, has, inV, outE, toArray, traversal, V } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 11);
const W_POOL = [1, 2, 3, 4, 5, 7, 9];

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['T'], properties: { n: i % 97 } });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(`v${i}`),
    // The repeat index is in the expression — CLAUDE.md's fix for the `(a*k+b) % N` degeneracy.
    to: g.getVertexById(`v${(i * 7 + 3 + hop * 2_654_435_761) % NODES}`),
    labels: ['E'],
    properties: { w: W_POOL[e % W_POOL.length] },
  });
}

const edgeCount = traversal(V(), outE('E'), has('w', gt(3)), count());
const inVCount = traversal(V(), outE('E'), has('w', gt(3)), inV(), count());

/** The floor for `outE(E).has(w,gt 3).count()`: count edges passing the test. No projection, no array. */
const handEdgeCount = () => {
  let n = 0;

  for (const v of g.vertices) {
    const bucket = v.adjFrom?.get('E');

    if (bucket === undefined) {
      continue;
    }

    for (const edge of bucket) {
      if (edge.properties.w > 3) {
        n += 1;
      }
    }
  }

  return n;
};

/*
 * ⚠️⚠️ **THE BUCKET FLOOR ABOVE IS NOT A FLOOR — THE ENGINE BEATS IT 0.63x.** `flatDrain` iterates a
 * CONTIGUOUS array of edges (`edgeFlatFor`), losing the 200,000 `adjFrom.get(type)` lookups and the
 * 200,000 `Set` iterators that the hand walk pays. So the comparison that matters uses the SAME
 * layout: a flat array, built ONCE outside the timed region exactly as the engine's is cached by the
 * second-ask policy.
 *
 * 🔑 What a tight-loop count could still save over `flatDrain` is then only two things: the array
 * allocation and its 1,000,000 pushes, and `pick(edge)` where `drops` is false.
 */
const flatEdges = [];

for (const v of g.vertices) {
  const bucket = v.adjFrom?.get('E');

  if (bucket !== undefined) {
    for (const edge of bucket) {
      flatEdges.push(edge);
    }
  }
}

/** The FLAT floor: same layout as `flatDrain`, but counting instead of projecting and pushing. */
const handFlatCount = () => {
  let n = 0;

  for (const edge of flatEdges) {
    if (edge.properties.w > 3) {
      n += 1;
    }
  }

  return n;
};

/** What `flatDrain` itself does: project and push, then read `.length`. */
const handFlatDrain = () => {
  const out = [];

  for (const edge of flatEdges) {
    if (edge.properties.w > 3) {
      out.push(edge);
    }
  }

  return out.length;
};

/*
 * ⚠️ THE `inV()` FLOOR IS THE SAME NUMBER BY A DIFFERENT ROUTE: every surviving edge has exactly one
 * head, so counting heads is counting edges. Stated rather than assumed, because if it were ever
 * false this floor would price a different query — the assertion below is what holds it.
 */
const handInVCount = handEdgeCount;

const engineEdge = () => Number(toArray(edgeCount, g)[0]);
const engineInV = () => Number(toArray(inVCount, g)[0]);

const wantEdge = engineEdge();
const wantInV = engineInV();

if (handFlatCount() !== wantEdge || handFlatDrain() !== wantEdge) {
  throw new Error(
    `flat floors disagree: count ${handFlatCount()}, drain ${handFlatDrain()}, engine ${wantEdge}`,
  );
}

if (handEdgeCount() !== wantEdge || handInVCount() !== wantInV || wantEdge !== wantInV) {
  throw new Error(
    `answers disagree: engine edge ${wantEdge}, engine inV ${wantInV}, hand ${handEdgeCount()}`,
  );
}

const time = (label, fn) => {
  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    fn();
    series.push(performance.now() - t0);
  }

  const plateau = series.slice(3).sort((a, b) => a - b);
  const ms = plateau[Math.floor(plateau.length / 2)];

  console.log(`  ${label.padEnd(26)} ${ms.toFixed(2).padStart(8)} ms`);

  return ms;
};

console.log(`\n  ${NODES} vertices, ${NODES * FANOUT} edges; every arm answers ${wantEdge}\n`);
const eEdge = time('engine outE.has.count', engineEdge);
const eInV = time('engine outE.has.inV.count', engineInV);
const floor = time('HAND bucket floor', handEdgeCount);
const flatCount = time('HAND flat COUNT', handFlatCount);
const flatDrainMs = time('HAND flat drain+length', handFlatDrain);

console.log(
  `\n  engine outE.has.inV.count / bucket floor = ${(eInV / floor).toFixed(2)}x` +
    `\n  ⚠️ THE BUCKET FLOOR IS NOT A FLOOR: the engine is ${(floor / eEdge).toFixed(2)}x FASTER than it,` +
    `\n     because \`flatDrain\` walks a contiguous array where the hand walk walks ${String(NODES)} Sets.` +
    `\n\n  SAME-LAYOUT COMPARISON (both over the pre-built flat array):` +
    `\n    flat drain + length   ${flatDrainMs.toFixed(2)} ms` +
    `\n    flat COUNT            ${flatCount.toFixed(2)} ms   <- ${(flatDrainMs / flatCount).toFixed(2)}x` +
    `\n\n  so a tight-loop count over the flat array is worth ${(flatDrainMs / flatCount).toFixed(2)}x of the` +
    `\n  drain's own work, and the engine row sits at ${eEdge.toFixed(2)} ms against that drain's ${flatDrainMs.toFixed(2)}.\n`,
);
