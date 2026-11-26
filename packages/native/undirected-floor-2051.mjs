/*
 * Item 2051 — WHAT IS THE FLOOR FOR AN UNDIRECTED MULTI-HOP CHAIN?
 *
 * Item 2050 measured `(a:P)-[:E]-(b:P)-[:E]-(c:P)-[:E]-(d:P) RETURN d.k` at **0.838 us a row**
 * against the directed twin's 0.295 — 2.84x — and diagnosed it: the directed chain rides the fused
 * `sweepBlock`, the undirected one falls to `matchPattern`/`walkSegments`/`walkBothSegment`, the
 * general pattern matcher. **Before building an undirected arm, this asks what one could reach.**
 *
 * **THE HAND ARM MUST REPRODUCE THE ROW ORDER, not just the multiset.** `hop-projection.ts` records
 * that `expand` emits, PER START VERTEX, the out-steps then the in-steps, skipping a self-loop in the
 * in-pass because a loop is indexed under BOTH maps — and that row order is OBSERVABLE for a
 * projection, which is why item 478's two-pass trick is confined to aggregates. A floor arm that
 * emitted a different order would be measuring a cheaper question (item 2016's rule: a floor arm must
 * take the same ROUTE, not merely touch the same data).
 *
 * SO THE SEQUENCES ARE COMPARED ELEMENT BY ELEMENT. If they diverge, the floor is void and the
 * probe says so rather than printing a ratio.
 *
 *     bun undirected-floor-2051.mjs
 *     NODES=50000 REPS=5 bun undirected-floor-2051.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 20_000);
const REPS = Number(process.env.REPS ?? 7);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, s: `s${i % 1000}`, n: i } });
}

for (let e = 0; e < NODES; e += 1) {
  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(`v${e}`),
    to: g.getVertexById(`v${(e * 7 + 3) % NODES}`),
    labels: ['E'],
    properties: { w: e % 13 },
  });
}

const DIRECTED = 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P) RETURN d.k AS k';
const UNDIRECTED = 'MATCH (a:P)-[:E]-(b:P)-[:E]-(c:P)-[:E]-(d:P) RETURN d.k AS k';

/**
 * The hand UNDIRECTED chain, in the engine's own emission order: per vertex, the out-edges then the
 * in-edges, and a self-loop is skipped in the in-pass because it appears in both maps.
 */
/*
 * MODULE SCOPE, not a closure inside the walk — [[ts-closure-size-is-load-bearing]]: a walk defined
 * INSIDE a returned closure gave unrelated queries a new slow mode (4x) in this repo, and the lint
 * rule that flagged it here is pointing at the same thing. It captures nothing, so hoisting is free.
 */
const bothStep = (v, sink) => {
  const fromBucket = v.adjFrom?.get('E');

  if (fromBucket !== undefined) {
    for (const edge of fromBucket) {
      sink(edge.to);
    }
  }

  const toBucket = v.adjTo?.get('E');

  if (toBucket !== undefined) {
    for (const edge of toBucket) {
      // A self-loop is indexed under BOTH maps; the in-pass skips it so it is not emitted twice.
      if (edge.from.id !== edge.to.id) {
        sink(edge.from);
      }
    }
  }
};

const handUndirected = () => {
  const out = [];

  for (const a of g.vertices) {
    if (!a.labels.has('P')) {
      continue;
    }

    bothStep(a, (b) => {
      if (!b.labels.has('P')) {
        return;
      }

      bothStep(b, (c) => {
        if (!c.labels.has('P')) {
          return;
        }

        bothStep(c, (d) => {
          if (d.labels.has('P')) {
            out.push(d.properties.k);
          }
        });
      });
    });
  }

  return out;
};

const engine = (text) => [...query(g, text)].map((r) => r.k);

/*
 * EQUIVALENCE FIRST, AND AS A SEQUENCE. A ratio against an arm that answers a different question
 * is worse than no number at all.
 */
const want = engine(UNDIRECTED);
const got = handUndirected();
const same = want.length === got.length && want.every((v, i) => v === got[i]);

console.log(`\n  ${NODES} vertices, ${NODES} edges; undirected rows ${want.length}`);
console.log(`  hand arm reproduces the engine's SEQUENCE: ${same}`);

if (!same) {
  const at = want.findIndex((v, i) => v !== got[i]);

  console.log(
    `  FIRST DIVERGENCE at index ${at}: engine ${String(want[at])} vs hand ${String(got[at])}`,
  );
  console.log('  THE FLOOR IS VOID — a different order is a different question.');
  process.exit(1);
}

const time = (label, fn, rows) => {
  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    fn();
    series.push(performance.now() - t0);
  }

  // Median of the plateau: the first reps are visibly V8 tiering up (items 2043-2045).
  const plateau = series.slice(2).sort((a, b) => a - b);
  const ms = plateau[Math.floor(plateau.length / 2)];

  console.log(
    `  ${label.padEnd(22)} ${ms.toFixed(1).padStart(8)} ms   ${((ms * 1000) / rows).toFixed(3)} us/row`,
  );

  return ms;
};

console.log('');
const dRows = engine(DIRECTED).length;
const eng = time('engine undirected', () => engine(UNDIRECTED), want.length);
const hand = time('HAND undirected', () => handUndirected(), want.length);
const dir = time('engine directed', () => engine(DIRECTED), dRows);

/*
 * BOTH RATIOS STATED THE SAME WAY ROUND, because my first version printed "the directed route is
 * 0.34x cheaper", which is the reciprocal and reads as the opposite of what it means. A ratio label
 * that has to be mentally inverted is a wrong-answer generator in a probe nobody re-derives.
 */
const perRow = (ms, rows) => (ms * 1000) / rows;

console.log(
  `\n  engine undirected / HAND undirected      ${(eng / hand).toFixed(2)}x   <- the headroom` +
    `\n  engine undirected / engine directed      ${(perRow(eng, want.length) / perRow(dir, dRows)).toFixed(2)}x per row` +
    `\n  engine directed  / HAND undirected       ${(perRow(dir, dRows) / perRow(hand, want.length)).toFixed(2)}x per row   <- the ACCEPTED residual` +
    `\n`,
);
