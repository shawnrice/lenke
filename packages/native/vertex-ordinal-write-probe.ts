/**
 * What would a dense vertex ordinal cost WRITES?
 *
 * The question is item 1356's design fork: the only remaining TS multi-hop lever is giving `Vertex`
 * an internal dense slot, and the first thing to know is the write-side penalty.
 *
 * ⚠️ `bench:usage` CANNOT ANSWER IT. Its write rows are ops/sec over 250 ms batches, best of 3, and
 * a single run of it moved `read: point lookup` +26% and `write: 100 updates in one statement` -34%
 * between two builds that differ only in one integer field — both rows the change cannot plausibly
 * reach by that much. So its run-to-run variance swamps the effect being measured, and this repo's
 * own rule applies: a per-row question needs a per-row instrument.
 *
 * This times the vertex write path directly, with the estimator the TS path requires (14 reps, the
 * first 3 dropped as JIT warm-up, median of the rest).
 *
 *     ARM=bare|props|withEdges   N=200000
 *
 *   bare       `addVertex` with one label and no properties — the thinnest write, where a
 *              per-vertex constant is the largest FRACTION and so the worst case for the ordinal.
 *   props      three properties, the shape real ingest has; `alloc + freeze` dominates here
 *              (recorded: `addVertex` was WITHDRAWN as a target at item 312 at 7.4%).
 *   withEdges  vertices then 5 edges each, so the ordinal's cost is diluted by edge writes it
 *              does not touch at all — the realistic ingest mix.
 */
import { Graph } from '@lenke/core';

const N = Number(process.env.N ?? 200_000);
const REPS = Number(process.env.REPS ?? 14);
const DROP = Number(process.env.DROP ?? 3);
const ARM = process.env.ARM ?? 'bare';

const build = (): number => {
  const g = new Graph();

  if (ARM === 'bare') {
    for (let i = 0; i < N; i++) {
      g.addVertex({ id: `v${i}`, labels: ['P'] });
    }

    return g.vertexCount;
  }

  const vs = Array.from({ length: N }, (_, i) =>
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { age: i % 90, name: `person${i}`, city: `city${i % 8}` },
    }),
  );

  if (ARM === 'withEdges') {
    for (let k = 0; k < N * 5; k++) {
      g.addEdge({
        id: `e${k}`,
        from: vs[(k * 7919) % N],
        to: vs[((k % N) * 104_729 + Math.floor(k / N) * 977) % N],
        labels: ['T'],
      });
    }

    return g.edgeCount;
  }

  return g.vertexCount;
};

const series: number[] = [];
let sink = 0;

for (let r = 0; r < REPS; r++) {
  const t0 = performance.now();

  sink = build();
  series.push(performance.now() - t0);
}

const kept = series.slice(DROP).sort((a, b) => a - b);
const median = kept[Math.floor(kept.length / 2)];
const reps = series.map((x) => x.toFixed(1)).join(' ');

console.log(
  `ARM=${ARM}\tN=${N}\tsink=${sink}
  series ${reps}
  MEDIAN(drop ${DROP}) ${median.toFixed(4)} ms  (${((median * 1e6) / N).toFixed(1)} ns per vertex)`,
);
