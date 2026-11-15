// Item 1916 — WHAT IS THE CEILING for removing `flatAdj`'s per-visit bucket copy?
//
// `flatAdj`'s fast arm does `Array.from(bucket)` for EVERY vertex visited at EVERY depth of a
// var-length walk, because the DFS frame needs indexed access (`adj.edges[top.idx]`). A `Set`
// iterator held in the frame would need none. The profile of `MATCH (a:T)-[:E]->{2,2}(b:T) WHERE
// a.n = $p0` puts `Array.from` at **13.1%** and `flatAdj` at 5.2%; an existing note in
// `var-length-count.ts` independently records `flatAdj` at **36.6%** on a declined depth-4 shape.
//
// ⚠️ PRICE IT BEFORE BUILDING IT, because this area has already resisted: the comment above
// `flatAdj` records a previous change measured at ~1.04x against a BIMODAL before-arm and
// withdrawn, and item 735's ablation found the walk is only ~20% of depth-5 enumeration with ~80%
// downstream of the yield. Item 1893's method — a hand arm's number is the whole decision.
//
// THE ARMS, over the same Sets, same visit counts, same degree distribution as the real walk:
//   copy     Array.from(bucket) then index it            — what the engine does now
//   iter     hold the Set's iterator and call next()      — what the change would do
//   forof    for…of over the Set                          — the floor if the frame weren't needed
//
//     bun flatadj-ceiling-1916.mjs
import { Graph } from '@lenke/core';

const N = Number(process.env.N ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 9);

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 8 } });
}

for (let e = 0; e < N * FANOUT; e += 1) {
  const i = e % N;
  const hop = Math.floor(e / N);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % N) + 1)),
    labels: hop % 4 === 3 ? ['F'] : ['E'],
    properties: { w: e % 7 },
  });
}

/**
 * ⚠️ THE VISIT LIST IS THE REAL ONE, not a uniform sample. The walk visits the 25,000 seeds
 * (`a.n = 3`) at depth 0 and each of their E-neighbours at depth 1, so the bucket sizes it copies
 * follow the fixture's actual out-degree distribution. Building the list from the graph rather than
 * assuming it is what keeps this a ceiling for the real shape.
 */
const visits = [];

for (let i = 0; i < N; i += 1) {
  const v = g.getVertexById(String(i + 1));

  if (v.properties.n !== 3) {
    continue;
  }

  visits.push(v);

  const b0 = g.edgesFromByLabel.get(v.id)?.get('E');

  if (b0 !== undefined) {
    for (const e of b0) {
      visits.push(e.to);
    }
  }
}

const buckets = visits.map((v) => g.edgesFromByLabel.get(v.id)?.get('E'));
const degrees = buckets.map((b) => b?.size ?? 0);
const total = degrees.reduce((a, b) => a + b, 0);

console.log(
  `visits=${visits.length}  edges walked=${total}  mean degree=${(total / visits.length).toFixed(2)}`,
);

// A sink the optimizer cannot discard.
let sink = 0;

const ARMS = {
  copy: () => {
    for (const bucket of buckets) {
      const edges = bucket === undefined ? [] : Array.from(bucket);

      // THE INDEXED READ IS THE MEASUREMENT: it mirrors `adj.edges[top.idx]` in `trailEnds`' DFS
      // frame, and a `for…of` here would measure the `forof` arm instead, collapsing the comparison.
      // eslint-disable-next-line typescript/prefer-for-of -- see above; the indexed read is the arm
      for (let i = 0; i < edges.length; i += 1) {
        sink += edges[i].to === undefined ? 0 : 1;
      }
    }
  },
  iter: () => {
    for (const bucket of buckets) {
      if (bucket === undefined) {
        continue;
      }

      const it = bucket[Symbol.iterator]();

      for (let n = it.next(); n.done !== true; n = it.next()) {
        sink += n.value.to === undefined ? 0 : 1;
      }
    }
  },
  forof: () => {
    for (const bucket of buckets) {
      if (bucket === undefined) {
        continue;
      }

      for (const e of bucket) {
        sink += e.to === undefined ? 0 : 1;
      }
    }
  },
};

const results = {};

for (const [name, fn] of Object.entries(ARMS)) {
  const ser = [];

  for (let r = 0; r < REPS + 2; r += 1) {
    const t0 = performance.now();

    fn();

    const ms = performance.now() - t0;

    if (r >= 2) {
      ser.push(ms);
    }
  }

  ser.sort((a, b) => a - b);
  results[name] = ser[ser.length >> 1];
  console.log(
    `${name.padEnd(6)} median ${results[name].toFixed(3)} ms   series ${ser.map((x) => x.toFixed(2)).join(' ')}`,
  );
}

const saved = results.copy - results.iter;

console.log(
  `\nsink=${sink}  (ignore)\n` +
    `the copy costs ${saved.toFixed(3)} ms per walk over the iterator ` +
    `(${(results.copy / results.iter).toFixed(2)}x on this slice alone)`,
);
console.log(
  `⚠️ READ THIS AS A CEILING, NOT A PREDICTION: the real walk also pays the DFS frame, the mark set,\n` +
    `   the per-row yield object and everything downstream of it. Against the measured 513.78 ms of\n` +
    `   MATCH (a:T)-[:E]->{2,2}(b:T) WHERE a.n = $p0, this slice is ` +
    `${((saved / 513.78) * 100).toFixed(1)}% of the row.`,
);
