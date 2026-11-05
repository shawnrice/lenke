import { ErrorCode, LenkeError } from '@lenke/errors';

import type { Edge } from '../core/Edge.js';
import type { Graph } from '../core/Graph.js';
import type { Vertex } from '../core/Vertex.js';
import { type AlgorithmGen, defineAlgorithm, YIELD_EVERY } from './async.js';
import type { AlgorithmConfig, AlgorithmRow } from './types.js';

/** A neighbour-aggregation result row: `{ node, vector }` (the aggregated vector).
 * The column is `vector` (not `aggregate`, which is a reserved GQL word). */
export type NeighborAggregateRow = AlgorithmRow<'vector', number[]>;

type Op = 'mean' | 'sum' | 'max' | 'min';

/** Read a vertex's feature as a numeric vector, or `null` if absent / not a list of
 * numbers (such a vertex contributes nothing). Mirrors the feature read inside
 * `algo::neighbor_aggregate`, which is inline there rather than a named helper. */
const readVec = (vertex: Vertex, key: string): number[] | null => {
  const raw = vertex.getProperty(key);

  if (!Array.isArray(raw)) {
    return null;
  }

  const out: number[] = [];

  for (const x of raw) {
    if (typeof x !== 'number') {
      return null; // a non-numeric element → not a feature vector
    }

    out.push(x);
  }

  return out;
};

/** Fold one contributor vector into `acc` under `op`, scaled by `coef` (edge weight ×
 * normalization; 1 unweighted). `started` marks whether `acc` holds a real value yet (the
 * identity for max/min is the first contributor). `max`/`min` ignore `coef` (scale-
 * independent; a weight/norm is rejected at the call site). Mirrors native `fold`. */
const fold = (op: Op, acc: number[], vec: number[], started: boolean, coef: number): void => {
  for (let i = 0; i < acc.length; i++) {
    if (op === 'sum' || op === 'mean') {
      acc[i] += coef * vec[i];
    } else if (!started) {
      acc[i] = vec[i];
    } else if (op === 'max') {
      acc[i] = Math.max(acc[i], vec[i]);
    } else {
      acc[i] = Math.min(acc[i], vec[i]);
    }
  }
};

/** Validate `op` (raw so the message shows the offending value, not `never`). */
const resolveOp = (raw: string): Op => {
  if (raw !== 'mean' && raw !== 'sum' && raw !== 'max' && raw !== 'min') {
    throw new LenkeError(`neighborAggregate \`op\` must be one of mean|sum|max|min, got '${raw}'`, {
      code: ErrorCode.InvalidValue,
    });
  }

  return raw;
};

/** Validate `direction` into `[wantOut, wantIn]`. */
const resolveDirs = (raw: string): [boolean, boolean] => {
  if (raw !== 'out' && raw !== 'in' && raw !== 'both') {
    throw new LenkeError(
      `neighborAggregate \`direction\` must be one of out|in|both, got '${raw}'`,
      { code: ErrorCode.InvalidValue },
    );
  }

  return [raw === 'out' || raw === 'both', raw === 'in' || raw === 'both'];
};

/** Validate `norm` into a GCN flag. */
const resolveGcn = (raw: string): boolean => {
  if (raw !== 'none' && raw !== 'gcn') {
    throw new LenkeError(`neighborAggregate \`norm\` must be one of none|gcn, got '${raw}'`, {
      code: ErrorCode.InvalidValue,
    });
  }

  return raw === 'gcn';
};

/** Per-edge weights by edge-insertion index (= native eidx); a missing / non-numeric
 * value is 0, mirroring native `edge_weights`. */
const buildEdgeWeights = (graph: Graph, key: string): number[] => {
  const out: number[] = [];

  for (const edge of graph.edges) {
    const w = edge.getProperty(key);
    out.push(typeof w === 'number' ? w : 0);
  }

  return out;
};

/** Every vertex's feature vector, plus the shared dimension `d`; a length mismatch faults.
 * Iterated in insertion (= dense-id) order.
 *
 * Indexed by DENSE VERTEX INDEX rather than keyed by external id: the hot loop reads one feature
 * per contributor, so this is the difference between an array index and a string hash per edge. */
const buildFeatures = (
  graph: Graph,
  feature: string,
): { feats: (number[] | null)[]; d: number } => {
  const feats: (number[] | null)[] = [];
  let dim: number | undefined;

  for (const vertex of graph.vertices) {
    const vec = readVec(vertex, feature);

    feats.push(vec);

    if (vec !== null && dim === undefined) {
      dim = vec.length;
    } else if (vec !== null && dim !== vec.length) {
      throw new LenkeError(
        `neighborAggregate feature vectors must all have the same length; found ${dim} and ${vec.length}`,
        { code: ErrorCode.InvalidValue },
      );
    }
  }

  return { feats, d: dim ?? 0 };
};

/**
 * One direction's adjacency as a flat CSR: `nbr[off[i] .. off[i+1])` are vertex i's neighbour
 * indices and `eidx[...]` their edge-insertion indices, **ascending**, because the fill pass walks
 * `graph.edges` in order.
 */
type Adj = { off: Int32Array; nbr: Int32Array; eidx: Int32Array };

/**
 * Per-vertex out/in adjacency in edge-insertion (= native eidx) order, as two flat CSRs over dense
 * vertex indices.
 *
 * ⚠️ IT REPLACES A `Map<string, {eidx, nbr}[]>` THAT BOXED ONE OBJECT PER EDGE PER DIRECTION — 2·E
 * short-lived objects plus an array per vertex per direction. Item 1469 profiled
 * `neighborAggregate` with `(garbage collector)` at **11.81%**, the highest share in the twelve, and
 * that allocation is where it came from. Counting first costs a second pass over the edges and buys
 * all of it back.
 *
 * ⚠️ THIS IS NOT THE ROUTE ITEM 416 REFUTED. That one returned the STORED adjacency list to the
 * consumer instead of copying into a reusable buffer, and regressed `direction: in` by 1.20x; the
 * reusable buffer it kept is still here in spirit — nothing per-vertex is allocated at all now.
 * What changes is the REPRESENTATION, which 416 never varied.
 *
 * `eidx` is the index over **every** edge, not only the type-matching ones, because `edgeWeights` is
 * built over every edge and indexed by it. The counter therefore advances outside the filter.
 */
const buildAdjacency = (
  graph: Graph,
  edgeLabel: string | undefined,
  index: Map<string, number>,
  n: number,
): { outAdj: Adj; inAdj: Adj } => {
  const typeOk = (edge: Edge): boolean => edgeLabel === undefined || edge.labels.has(edgeLabel);
  const outOff = new Int32Array(n + 1);
  const inOff = new Int32Array(n + 1);
  let m = 0;

  for (const edge of graph.edges) {
    if (typeOk(edge)) {
      outOff[index.get(edge.fromId)! + 1] += 1;
      inOff[index.get(edge.toId)! + 1] += 1;
      m += 1;
    }
  }

  for (let i = 0; i < n; i++) {
    outOff[i + 1] += outOff[i];
    inOff[i + 1] += inOff[i];
  }

  const outAdj: Adj = { off: outOff, nbr: new Int32Array(m), eidx: new Int32Array(m) };
  const inAdj: Adj = { off: inOff, nbr: new Int32Array(m), eidx: new Int32Array(m) };
  // Write cursors, so the fill can walk the edges once in order. Copies, because `off` itself is
  // the result and advancing it in place would leave every slice start one slice too far along.
  const outAt = outOff.slice(0, n);
  const inAt = inOff.slice(0, n);
  let eidx = 0;

  for (const edge of graph.edges) {
    if (typeOk(edge)) {
      const from = index.get(edge.fromId)!;
      const to = index.get(edge.toId)!;
      const o = outAt[from];
      const w = inAt[to];

      outAdj.nbr[o] = to;
      outAdj.eidx[o] = eidx;
      outAt[from] = o + 1;
      inAdj.nbr[w] = from;
      inAdj.eidx[w] = eidx;
      inAt[to] = w + 1;
    }

    eidx += 1;
  }

  return { outAdj, inAdj };
};

/**
 * How many contributors `v` has, WITHOUT building the list — the `gcn` degree pass wants only this
 * number, and gathering it allocated, copied and sorted once per vertex to read a length off it
 * (audit item 416).
 *
 * The self-loop rule is restated rather than shared with the merge below, because the two
 * disagreeing silently is the failure mode: a `both`-direction self-loop counts ONCE.
 */
const contributorCount = (
  i: number,
  outAdj: Adj,
  inAdj: Adj,
  wantOut: boolean,
  wantIn: boolean,
): number => {
  let n = wantOut ? outAdj.off[i + 1] - outAdj.off[i] : 0;

  if (wantIn) {
    for (let q = inAdj.off[i]; q < inAdj.off[i + 1]; q++) {
      if (!(wantOut && inAdj.nbr[q] === i)) {
        n += 1;
      }
    }
  }

  return n;
};

/**
 * Everything the per-vertex accumulation reads, built ONCE outside the vertex loop. It exists so
 * `accumulate` can be a plain function rather than ten more branches inside `computeGen` (which the
 * complexity bound rejects at 39) — and being built once, it costs no per-vertex allocation.
 */
type Ctx = {
  op: Op;
  outAdj: Adj;
  inAdj: Adj;
  feats: (number[] | null)[];
  deg: Float64Array;
  edgeWeights: number[];
  wantOut: boolean;
  wantIn: boolean;
  gcn: boolean;
  weighted: boolean;
  includeSelf: boolean;
};

/**
 * Fold vertex `i`'s contributors into `acc` and return the coefficient sum (`mean`'s divisor).
 *
 * Self first when included, with GCN factor 1/deg_i (= 1/sqrt(deg_i·deg_i)); then neighbours in
 * edge-index order, each scaled by edge weight × GCN factor.
 *
 * ⚠️ A MERGE, NOT A SORT. Both CSR slices are already ascending in `eidx` (the fill pass walks
 * `graph.edges` in order), so interleaving them by `eidx` reproduces exactly what sorting the
 * concatenation produced. That order is the canonical, engine-independent accumulation order, and
 * under `sum`/`mean` it is also the FLOAT SUMMATION ORDER — so permuting it changes the result
 * bytes, not merely the row. A mutant replacing this merge with a plain concatenation left the
 * contributor multiset identical and passed every other test in the suite; the cancellation fixture
 * in `neighbor-aggregate-csr.test.ts` is what pins it.
 *
 * Ties cannot arise: one `eidx` reaches the same vertex from both directions only for a self-loop,
 * and the rule below drops the in-copy of one whenever `wantOut`.
 */
const accumulate = (ctx: Ctx, i: number, acc: number[]): number => {
  const { op, outAdj, inAdj, feats, deg, edgeWeights, wantOut, wantIn, gcn, weighted } = ctx;
  let coefSum = 0;
  let started = false;

  if (ctx.includeSelf) {
    const sv = feats[i];

    if (sv !== null) {
      const coef = gcn ? 1 / deg[i] : 1;

      fold(op, acc, sv, started, coef);
      started = true;
      coefSum += coef;
    }
  }

  let p = wantOut ? outAdj.off[i] : 0;
  const pe = wantOut ? outAdj.off[i + 1] : 0;
  let q = wantIn ? inAdj.off[i] : 0;
  const qe = wantIn ? inAdj.off[i + 1] : 0;

  while (p < pe || q < qe) {
    const takeOut = q >= qe || (p < pe && outAdj.eidx[p] <= inAdj.eidx[q]);
    let eidx: number;
    let nbrIdx: number;

    if (takeOut) {
      eidx = outAdj.eidx[p];
      nbrIdx = outAdj.nbr[p];
      p += 1;
    } else {
      eidx = inAdj.eidx[q];
      nbrIdx = inAdj.nbr[q];
      q += 1;

      // A `both`-direction self-loop counts once: its out-copy was taken above.
      if (wantOut && nbrIdx === i) {
        continue;
      }
    }

    const nv = feats[nbrIdx];

    if (nv !== null) {
      const w = weighted ? edgeWeights[eidx] : 1;
      const nf = gcn ? 1 / Math.sqrt(deg[i] * deg[nbrIdx]) : 1;
      const coef = w * nf;

      fold(op, acc, nv, started, coef);
      started = true;
      coefSum += coef;
    }
  }

  return coefSum;
};

export const computeGen = function* (
  config: AlgorithmConfig,
  graph: Graph,
): AlgorithmGen<NeighborAggregateRow> {
  const { feature, edgeLabel, direction = 'both', writeProperty, weightProperty } = config;

  if (feature === undefined) {
    throw new LenkeError('neighborAggregate requires a `feature` property', {
      code: ErrorCode.InvalidValue,
    });
  }

  const op = resolveOp(config.op ?? 'mean');
  const [wantOut, wantIn] = resolveDirs(direction);
  const includeSelf = config.includeSelf ?? false;
  const gcn = resolveGcn(config.norm ?? 'none');
  // A weight or `gcn` norm SCALES contributors — meaningless for order/scale-independent
  // max/min. Reject loudly rather than silently ignore. Mirrors native.
  const weighted = weightProperty !== undefined;

  if ((weighted || gcn) && (op === 'max' || op === 'min')) {
    throw new LenkeError(
      'neighborAggregate `weightProperty`/`norm` apply only to op=sum|mean (max/min are scale-independent)',
      { code: ErrorCode.InvalidValue },
    );
  }

  const { feats, d } = buildFeatures(graph, feature);
  // Dense vertex index in insertion (= native dense-id) order, so the adjacency, features and GCN
  // degrees are all plain arrays rather than string-keyed Maps.
  const index = new Map<string, number>();
  const vertices: Vertex[] = [];

  for (const vertex of graph.vertices) {
    index.set(vertex.id, vertices.length);
    vertices.push(vertex);
  }

  const n = vertices.length;
  const { outAdj, inAdj } = buildAdjacency(graph, edgeLabel, index, n);
  const edgeWeights = weighted ? buildEdgeWeights(graph, weightProperty) : [];

  // GCN degree per vertex: contributor count under the configured direction/etype (+ the
  // self-loop when includeSelf), floored at 1. Mirrors native `deg`.
  const deg = new Float64Array(gcn ? n : 0);

  if (gcn) {
    for (let i = 0; i < n; i++) {
      deg[i] = Math.max(
        contributorCount(i, outAdj, inAdj, wantOut, wantIn) + (includeSelf ? 1 : 0),
        1,
      );
    }
  }

  const rows: NeighborAggregateRow[] = [];
  let sinceYield = 0;

  const ctx: Ctx = {
    op,
    outAdj,
    inAdj,
    feats,
    deg,
    edgeWeights,
    wantOut,
    wantIn,
    gcn,
    weighted,
    includeSelf,
  };

  for (let i = 0; i < n; i++) {
    const vertex = vertices[i];
    const acc = new Array<number>(d).fill(0);
    const coefSum = accumulate(ctx, i, acc);

    if (op === 'mean' && coefSum !== 0) {
      for (let k = 0; k < d; k++) {
        acc[k] /= coefSum;
      }
    }

    if (writeProperty !== undefined) {
      vertex.setProperty(writeProperty, acc);
    }

    rows.push({ node: vertex.id, vector: acc });

    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0;

      yield;
    }
  }

  return rows;
};

/**
 * Vectorized neighbour aggregation — for each vertex, aggregate its neighbours'
 * list-valued `feature` vectors element-wise over the whole block (`op` = mean /
 * sum / max / min), by `direction`, optionally including the vertex's own vector.
 * Byte-identical to native `neighborAggregate`: contributors fold in ascending
 * edge-index order (self first when included). Data-last dual-form.
 */
export const neighborAggregate = defineAlgorithm(computeGen);
