// Item 1931 — IS THE GREMLIN WALK FLOOR AT ITS OWN CEILING?
//
// After items 1920-1925 the Gremlin screen's top is `tree` at 586.64 (declined at 1925 on a 1.55x
// ceiling), `cyclicPath` at 163.46 (refused at 1923), and then EVERYTHING ELSE within ~1.4x of one
// number:
//
//     hop1: values    V().out('E').values('n')    52.02 ms / 600,000 rows = 87 ns a row
//
// That row is the floor the rest of the surface sits on — `where: neq filter` 74.78,
// `edge: outE.has(w).inV` 73.39, `group: hop groupCount` 69.98, `optional: hop` 48.78,
// `pathdep: outE.inV` 47.64 are all it plus a little. Item 1586 fused it (1.90x) and
// [[gremlin-values-is-the-floor]] records the mechanism: "the reduce is free; the cost is the
// generator chain". So the question that moves the most is whether 87 ns a row IS the floor.
//
// THE HAND ARM USES THE CSR, WHICH IS ITEM 1920'S MISTAKE NOT REPEATED. That item priced a
// fusion against a hand walk over the adjacency `Set`s — the BUCKET arm — while the engine takes
// the CSR arm on the second ask, so its "ceiling" came out 3x BELOW what the engine then achieved.
// Item 1925 measured the same size at 0.36 ms on the CSR against 15.78 on the buckets.
//
// AND THE CSR IS BUILT OUTSIDE THE TIMED LOOP, because the engine memoizes it per
// (graph, topology, shape) and amortizes it across calls — item 1889's second-ask policy.
//
//     bun walkfloor-ceiling-1931.mjs
import { Graph } from '@lenke/core';
import { out, toArray, traversal, V, values } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const REPS = Number(process.env.REPS ?? 9);

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['P'], properties: { n: i % 97, k: `s${String(i)}` } });
}

/*
 * SPLIT ON THE REPEAT INDEX, not on `k` alone. CLAUDE.md's rule: `to = (a*k + b) % N` is
 * INVARIANT under `k -> k + N`, so a loop over `k < N * FANOUT` sends one vertex's whole fanout to
 * the SAME target and the graph comes out FUNCTIONAL while every degree count looks perfect.
 */
for (let e = 0; e < N * FANOUT; e += 1) {
  const i = e % N;
  const hop = Math.floor(e / N);

  g.addEdge({
    id: `e${String(e)}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % N) + 1)),
    labels: hop % 3 === 2 ? ['F'] : ['E'],
    properties: { w: e % 7 },
  });
}

const verts = [];

for (let i = 0; i < N; i += 1) {
  verts.push(g.getVertexById(String(i + 1)));
}

// COUNT THE DISTINCT ENDPOINTS BEFORE TRUSTING ANY NUMBER FROM THIS FIXTURE — CLAUDE.md's rule,
// and the one that caught items 1516/1518 after 800 items of nobody re-checking.
const distinctTargets = new Set();
let eCount = 0;

for (const v of verts) {
  const bucket = v.adjFrom?.get('E');

  if (bucket !== undefined) {
    for (const edge of bucket) {
      distinctTargets.add(edge.to);
      eCount += 1;
    }
  }
}

console.log(
  `fixture: ${N} vertices, ${eCount} E-edges, ${distinctTargets.size} DISTINCT targets ` +
    `(${((100 * distinctTargets.size) / N).toFixed(1)}% of V) — a functional graph would show ~1 per source`,
);

/** The CSR the engine would walk, built the way `chainCsrFor` does. */
const slotOf = new Map(verts.map((v, i) => [v, i]));
const off = new Int32Array(N + 1);

for (let i = 0; i < N; i += 1) {
  off[i + 1] = off[i] + (verts[i].adjFrom?.get('E')?.size ?? 0);
}

const flat = new Int32Array(off[N]);
let w = 0;

for (let i = 0; i < N; i += 1) {
  const bucket = verts[i].adjFrom?.get('E');

  if (bucket !== undefined) {
    for (const edge of bucket) {
      flat[w] = slotOf.get(edge.to) ?? 0;
      w += 1;
    }
  }
}

const ARMS = {
  /*
   * THE ENGINE ON THE SAME FIXTURE, which is the whole point of putting it here. My first run
   * compared the hand arms against the SCREEN's 52.02 ms — a different fixture (FANOUT 4, a
   * different label mix, 600,000 E-edges against this one's 400,000) — and reported 4.67x where
   * the per-row truth was 3.1x. A ceiling is only a ceiling against the same graph.
   */
  engine: () => toArray(traversal(V(), out('E'), values('n')), g).length,
  // THE WALK ALONE: no property read, no array.
  walk: () => {
    let n = 0;

    for (let slot = 0; slot < N; slot += 1) {
      for (let i = off[slot]; i < off[slot + 1]; i += 1) {
        n += flat[i] >= 0 ? 1 : 0;
      }
    }

    return n;
  },
  // + the property read, discarded. The engine's `values` reads `v.properties` (a GETTER) and
  // indexes it, so this reads the same way rather than caching the bag.
  read: () => {
    let n = 0;

    for (let slot = 0; slot < N; slot += 1) {
      for (let i = off[slot]; i < off[slot + 1]; i += 1) {
        const val = verts[flat[i]].properties.n;

        n += val === undefined ? 0 : 1;
      }
    }

    return n;
  },
  // THE CEILING: + pushing into the output array, which is what `values()` must actually produce.
  // This is the most a fused rung could achieve on this shape.
  emit: () => {
    // `vals`, not `out` — `out` is the imported Gremlin STEP in this file.
    const vals = [];

    for (let slot = 0; slot < N; slot += 1) {
      for (let i = off[slot]; i < off[slot + 1]; i += 1) {
        vals.push(verts[flat[i]].properties.n);
      }
    }

    return vals.length;
  },
  // The same, pre-sized — to price the array growth separately from the read.
  emitSized: () => {
    const vals = new Array(off[N]);
    let j = 0;

    for (let slot = 0; slot < N; slot += 1) {
      for (let i = off[slot]; i < off[slot + 1]; i += 1) {
        vals[j] = verts[flat[i]].properties.n;
        j += 1;
      }
    }

    return j;
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
  console.log(
    `${name.padEnd(10)} median ${results[name].toFixed(2)} ms   ${((results[name] * 1e6) / eCount).toFixed(1)} ns/row   result ${got}`,
  );
}

/*
 * THE RATIO IS AGAINST THE `engine` ARM ABOVE, NOT AGAINST THE SCREEN'S NUMBER, and that is a
 * correction to this probe's own first version. It defaulted to the screen's 52.02 ms and reported
 * 4.93x — but the screen's fixture is FANOUT 4 with a different label mix, 600,000 E-edges where
 * this one has 400,000, i.e. 87 ns a row against 48. CLAUDE.md's "match the fixture to the claim",
 * walked into and then caught by putting the engine on the SAME graph. A ceiling is only a ceiling
 * against the same fixture, so there is no `ENGINE_MS` knob any more: the comparison is measured.
 */
console.log(
  `\nthe property READ adds ${(results.read - results.walk).toFixed(2)} ms; ` +
    `EMITTING adds ${(results.emit - results.read).toFixed(2)} ms on top`,
);
console.log(
  'CEILING, NOT A PREDICTION — a real rung also pays its gate and its walk wrapper.\n' +
    `   Engine ${results.engine.toFixed(2)} ms against the hand emit's ${results.emit.toFixed(2)}: ` +
    `${(results.engine / results.emit).toFixed(2)}x, so at most ` +
    `${(results.engine - results.emit).toFixed(2)} ms (` +
    `${(((results.engine - results.emit) * 1e6) / eCount).toFixed(1)} ns a row) is available on the ` +
    'shape the whole surface sits on.',
);
