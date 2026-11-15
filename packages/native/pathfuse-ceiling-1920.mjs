// Item 1920 — WHAT IS THE CEILING for fusing `V().out(T).path()`?
//
// `path: hop path` is the Gremlin workload screen's TOP row — **124.55 ms for 600,000 rows** against
// the plain hop's 50.65 — and `path()` makes `planReadsPath` TRUE, so every fused walk in the
// package is gated out and it runs the generic traverser pipeline. `pathshape-probe-1920.mjs`
// confirmed the layout is simply `[near, far]` per edge (and `[d, d]` for a self-loop), so a fused
// rung could build it directly, the way items 1912/1914 ride past that guard by claiming the whole
// plan.
//
// ⚠️ PRICE IT BEFORE BUILDING IT. This would be a NEW MODULE — `tagged-hop-values.ts` is built
// around HAVING an `as_` label and a path shape has none — which means a recognizer plus a walk
// written twice over two arms, i.e. the four paths item 1914 showed the obvious tests miss. That is
// an item-sized build, and item 1916 priced a 13.1% profile frame at 0.4% for the cost of one micro.
//
// 🔑 THE QUESTION IS WHETHER THE ARRAY ALLOCATION EATS THE WIN. The fused rung must still allocate
// one 2-element array per row — 600,000 of them — where the plain hop allocates none. So the ceiling
// is not the hop floor; it is the hop floor PLUS that allocation, and if that lands near 124 ms
// there is nothing to take.
//
//     bun pathfuse-ceiling-1920.mjs
import { Graph } from '@lenke/core';

const N = Number(process.env.N ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 4);
const REPS = Number(process.env.REPS ?? 9);

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['P'], properties: { n: i % 8, k: i % 50 } });
}

for (let e = 0; e < N * FANOUT; e += 1) {
  const i = e % N;
  const hop = Math.floor(e / N);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(String(i + 1)),
    // Splits on the REPEAT INDEX — CLAUDE.md's functional-graph fix.
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % N) + 1)),
    labels: hop % 4 === 3 ? ['F'] : ['E'],
    properties: { w: e % 7 },
  });
}

/**
 * The vertices in the engine's own scan order, with their `E` bucket — the same two reads the bucket
 * arm of every fused walk makes (`v.adjFrom.get(type)`, the vertex's CACHED box).
 */
const verts = [];

for (let i = 0; i < N; i += 1) {
  verts.push(g.getVertexById(String(i + 1)));
}

const ARMS = {
  // THE FLOOR: the walk with no row built at all, only a count. What `hop1: count` costs.
  walk: () => {
    let n = 0;

    for (const v of verts) {
      const bucket = v.adjFrom?.get('E');

      if (bucket === undefined) {
        continue;
      }

      for (const e of bucket) {
        n += e.to === undefined ? 0 : 1;
      }
    }

    return n;
  },
  // The walk emitting the FAR vertex into an array — what `hop1: values`-shaped work costs.
  far: () => {
    const out = [];

    for (const v of verts) {
      const bucket = v.adjFrom?.get('E');

      if (bucket === undefined) {
        continue;
      }

      for (const e of bucket) {
        out.push(e.to);
      }
    }

    return out.length;
  },
  // ⚠️ THE CEILING FOR THE FUSION: one 2-element array per row, pushed. This is the most a fused
  // `path()` rung could possibly achieve over this walk.
  pathrow: () => {
    const out = [];

    for (const v of verts) {
      const bucket = v.adjFrom?.get('E');

      if (bucket === undefined) {
        continue;
      }

      for (const e of bucket) {
        out.push([v, e.to]);
      }
    }

    return out.length;
  },
};

const results = {};

for (const [name, fn] of Object.entries(ARMS)) {
  const ser = [];
  let got = 0;

  for (let r = 0; r < REPS + 2; r += 1) {
    const t0 = performance.now();

    got = fn();

    const ms = performance.now() - t0;

    if (r >= 2) {
      ser.push(ms);
    }
  }

  ser.sort((a, b) => a - b);
  results[name] = ser[ser.length >> 1];
  console.log(`${name.padEnd(8)} median ${results[name].toFixed(2)} ms   rows ${got}`);
}

const ENGINE = 124.55;

console.log(
  `\nthe allocation alone costs ${(results.pathrow - results.far).toFixed(2)} ms ` +
    `(pathrow ${results.pathrow.toFixed(2)} vs far ${results.far.toFixed(2)})`,
);
console.log(
  `⚠️ READ AS A CEILING, NOT A PREDICTION: a real rung also pays the gate, the generator or drain,\n` +
    `   and the CSR memo. Against the engine's ${ENGINE} ms for this shape, the hand walk is ` +
    `${(ENGINE / results.pathrow).toFixed(2)}x — so at most ${(ENGINE - results.pathrow).toFixed(2)} ms is available.`,
);
