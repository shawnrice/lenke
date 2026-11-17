/*
 * Item 2096 — does `bothBuckets`'s PER-CALL 2-TUPLE cost anything?
 *
 * ⚠️ CONTEXT THAT NARROWS THIS. Item 1622 refuted an edge-only ADAPTER around `expand` (it wrapped one
 * generator in another). Item 1802 then took the directed path by the other route — the caller loops
 * `directedBucket`'s `Set` directly — for **1.109x on `hop3rows`, with the `both` family FLAT at
 * 1.011x**. So the undirected path is the one left behind, and it is the corpus's most expensive shape:
 * `hop3rowsboth` is **1944 ms/rep at 200,000 vertices**, 14x the next.
 *
 * 🔑 THE SPECIFIC DIFFERENCE: `directedBucket` returns the `Set` itself; `bothBuckets` returns
 * `[outSet, inSet]` — a fresh array PER CALL, per element, per segment. The profile shows
 * `bothBuckets` at 11.5% with GC at 11.7% beside it, which is what an allocation in a hot loop looks
 * like. ⚠️ But a frame is ATTRIBUTION until a deletion test with a control says otherwise — items 2067,
 * 2077, 2084 and 2090 each refuted a nomination at exactly this point.
 */
import { Graph } from '@lenke/core';

const NODES = Number(process.env.NODES ?? 100000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const REPS = Number(process.env.REPS ?? 11);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 50 } });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(`v${i}`),
    to: g.getVertexById(`v${(i * 7 + 3 + hop * 13) % NODES}`),
    labels: ['E'],
    properties: {},
  });
}

const EMPTY = new Set();
const verts = [...g.vertices];

/*
 * ⚠️ EVERY ARM WALKS BOTH BUCKETS AND SUMS THE SAME THING, so the answers are comparable and an arm
 * that skipped a bucket would be caught by the equality check below rather than looking fast.
 */
const arms = {
  // What the engine does: a fresh 2-tuple per call, destructured by the caller.
  tuple: () => {
    const buckets = (v) => [v.adjFrom?.get('E') ?? EMPTY, v.adjTo?.get('E') ?? EMPTY];
    let n = 0;

    for (const v of verts) {
      const [outs, ins] = buckets(v);

      for (const e of outs) {
        n += e.to === v ? 0 : 1;
      }

      for (const e of ins) {
        n += e.from === v ? 0 : 1;
      }
    }

    return n;
  },
  /*
   * ⚠️ NO TUPLE: two separate accessor calls. This is `directedBucket`'s shape applied twice — the
   * change the engine would actually make, not an ablation.
   */
  twocalls: () => {
    const outOf = (v) => v.adjFrom?.get('E') ?? EMPTY;
    const inOf = (v) => v.adjTo?.get('E') ?? EMPTY;
    let n = 0;

    for (const v of verts) {
      for (const e of outOf(v)) {
        n += e.to === v ? 0 : 1;
      }

      for (const e of inOf(v)) {
        n += e.from === v ? 0 : 1;
      }
    }

    return n;
  },
  // ⚠️ THE FLOOR: no helper at all, the adjacency read inline. Bounds what either arm could reach.
  inline: () => {
    let n = 0;

    for (const v of verts) {
      const outs = v.adjFrom?.get('E');
      const ins = v.adjTo?.get('E');

      if (outs !== undefined) {
        for (const e of outs) {
          n += e.to === v ? 0 : 1;
        }
      }

      if (ins !== undefined) {
        for (const e of ins) {
          n += e.from === v ? 0 : 1;
        }
      }
    }

    return n;
  },
};

const arm = process.env.ARM;

if (!(arm in arms)) {
  throw new Error(`ARM must be one of ${Object.keys(arms).join(', ')} — got ${String(arm)}`);
}

const expected = arms.inline();

arms[arm]();

const series = [];
let got = 0;

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();

  got = arms[arm]();
  series.push(performance.now() - t0);
}

if (got !== expected) {
  throw new Error(`${arm} counted ${got}, expected ${expected} — the arms are not equivalent`);
}

const kept = series.slice(3).sort((a, b) => a - b);

console.log(
  `${arm.padEnd(9)} median=${kept[Math.floor(kept.length / 2)].toFixed(2)} ms  edges=${got}`,
);
