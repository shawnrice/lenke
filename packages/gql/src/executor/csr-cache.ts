/**
 * THE TOPOLOGY-KEYED ADJACENCY CSR, SHARED BY EVERY ROUTE THAT WALKS A FLATTENED ADJACENCY.
 *
 * Built for the bounded var-length count at item 1676 (3.8x-27.2x) and lifted here at item 1685 so
 * the fixed-depth hop count can use it too. ⚠️ A LEAF MODULE RATHER THAN AN EXPORT FROM ITS ORIGINAL
 * HOME: `var-length-count.ts` imports from `shortcuts.ts`, so having `shortcuts.ts` import the cache
 * back would be a cycle, and `import/no-cycle` is an error here.
 */
import type { Edge, Graph, Vertex } from '@lenke/core';

import { edgesOfTypes } from './adjacency.js';

/** The flattened adjacency the level recurrence reads. Built once, then READ ONLY — every write to
 *  `off`, `nbr`, `order` and `idx` lives in {@link buildCsr}, which is what makes it cacheable. */
export type CsrTables = {
  order: readonly Vertex[];
  idx: ReadonlyMap<Vertex, number>;
  off: Int32Array;
  nbr: Int32Array;
};

/**
 * ONE PASS to number the vertices, then the adjacency FLATTENED into neighbour indices. After this
 * no level consults a Map at all, which is the whole point — see the ablation in the module header.
 *
 * PREALLOCATED to the graph's edge count and filled in ONE pass. Built as a `number[]` with `push`
 * and then `Int32Array.from`, the same CSR cost ~55ms instead of ~20 — boxing, array growth, and
 * then a full copy — which showed up as the whole route reading 58ms flat in depth where the
 * per-level work is 0.3ms. The wanted-type filter can only keep FEWER edges than the graph has, so
 * `edgeCount` is a safe bound and the slack is never touched.
 */
const buildCsr = (graph: Graph, inward: boolean, types: string[] | undefined): CsrTables => {
  // THE ONLY THING DIRECTION CHANGES (item 744): which adjacency box the CSR is built from, and
  // which end of each edge is the neighbour. Everything downstream — the level recurrence, and the
  // depth-3/4 trail correction via `buildTrailMasks` and `buildTrail4Tables` — takes `{off, nbr}`
  // and never consults the graph again, so it inherits the direction for free.
  const edgesOf = (v: Vertex): Iterable<Edge> => {
    const box = inward ? v.adjTo : v.adjFrom;

    return box === undefined ? [] : edgesOfTypes(box, types);
  };
  const order = [...graph.verticesById.values()];
  const idx = new Map<Vertex, number>();

  for (let i = 0; i < order.length; i += 1) {
    idx.set(order[i], i);
  }

  const off = new Int32Array(order.length + 1);
  const nbr = new Int32Array(graph.edgeCount);
  let at = 0;

  for (let i = 0; i < order.length; i += 1) {
    off[i] = at;

    for (const e of edgesOf(order[i])) {
      nbr[at] = idx.get(inward ? e.from : e.to) ?? 0;
      at += 1;
    }
  }

  off[order.length] = at;

  return { order, idx, off, nbr };
};

/**
 * THE CSR, REUSED ACROSS QUERIES (item 1676). Item 1571 instrumented this route and found 86.3% of
 * a bounded var-length count going into a structure that is discarded the moment the query returns,
 * so the second identical query rebuilds it from scratch. The ablation in the module header is why:
 * the build is one level's worth of Map lookups and each level after it is ~0.1 ms.
 *
 * ⚠️ THE KEY IS `graph.topologyVersion`, AND NOTHING ELSE WOULD DO. `graph.version` and
 * `graph.epoch(name)` advance on a DEFERRED, veto-checked step — both read 0 through a sequence of
 * mutations and move only after a task drain — so a cache keyed on either serves a stale structure
 * to the ordinary `g.addEdge(...); query(g, …)` shape. `vertexCount`/`edgeCount` advance eagerly
 * but a delete plus an add leaves both unchanged while the topology differs. `topologyVersion` was
 * built for this (items 1674/1675) and bumps on vertex adds and removes, edge adds and removes, AND
 * edge-LABEL writes — the last because the adjacency boxes are keyed by edge type, so
 * `addLabelToEdge` re-buckets what `types` selects without touching `insertEdge`.
 *
 * ⚠️ AND THE SHAPE IS PART OF THE KEY, because `nbr` is DIRECTION- AND TYPE-FILTERED. Two
 * queries differing only in `-[:E]->` vs `<-[:E]-`, or in the edge types they name, need different
 * neighbour arrays from the same topology.
 *
 * ⚠️ `types` IS NOT SORTED INTO THE KEY, deliberately. Two spellings naming the same types in a
 * different order are semantically equivalent, so sharing an entry is tempting — but `edgesOfTypes`
 * iterates `types` IN ORDER, so the two orders produce `nbr` arrays that differ in position. The
 * count itself is a sum and would survive, but the depth-3/4 trail corrections read `nbr` positionally
 * via `pairMultiplicities`, and f64 sums in a different order are not required to agree bit for bit.
 * Byte-identity is a hard invariant here, so the conservative key is the one that ships.
 *
 * A `WeakMap` so a discarded graph is collectable, and a per-shape `Map` inside it so a workload
 * alternating two directions or two type filters does not thrash a single slot.
 */
const MAX_SHAPES = 8;

const csrCache = new WeakMap<Graph, { tv: number; byShape: Map<string, CsrTables> }>();

export const csrFor = (graph: Graph, inward: boolean, types: string[] | undefined): CsrTables => {
  const tv = graph.topologyVersion;
  let entry = csrCache.get(graph);

  if (entry === undefined || entry.tv !== tv) {
    // A single stale generation is dropped WHOLE rather than per shape: every shape built from the
    // old topology is equally invalid, and keeping the map would leak one entry per shape per write.
    entry = { tv, byShape: new Map() };
    csrCache.set(graph, entry);
  }

  const key = `${inward ? '<' : '>'}${types === undefined ? '*' : types.join('\u0000')}`;
  const hit = entry.byShape.get(key);

  if (hit !== undefined) {
    return hit;
  }

  // ⚠️ CAPPED, BECAUSE THE RETENTION IS NOT SMALL AND NOTHING ELSE BOUNDS IT. Each entry holds
  // `order` (V references), `idx` (a V-entry Map) and two typed arrays sized V+1 and E — on the order
  // of 2 MB for a 50,000-vertex, 150,000-edge graph — and it lives as long as the graph does. A
  // generation is dropped whole on any topology write, so growth needs MANY distinct shapes with no
  // write between them, which is exactly what a report sweeping one query per edge type does. Past
  // the cap the generation is cleared rather than evicted one entry at a time: there is no recency
  // information worth keeping here, every entry costs one rebuild to recover, and a clear cannot
  // degrade into holding the cap's worth of cold entries forever.
  if (entry.byShape.size >= MAX_SHAPES) {
    entry.byShape.clear();
  }

  const built = buildCsr(graph, inward, types);
  entry.byShape.set(key, built);

  return built;
};
