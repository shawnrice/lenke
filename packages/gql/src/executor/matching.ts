// Pattern matching: the nested-loop MATCH driver that grows a partial binding
// one segment at a time (matchNode/matchPath/matchSegment), plus OPTIONAL MATCH,
// var-length expansion, and shortest-path selectors. Extracted from the executor.

import { DEFAULT_CONFIG, Path } from '@lenke/core';
import type { Edge, Graph, IndexableValue, RangeBound, Vertex } from '@lenke/core';
import { ErrorCode, LenkeError } from '@lenke/errors';

import type { PathMode, PathSelector, RelPattern } from '../ast.js';
// Compiled pattern types + binding helpers live in the executor trunk; the value
// back-edges (consistent/withBinding/…) are used lazily inside match closures, so
// this is a safe function-level cycle.
import type {
  Binding,
  CNode,
  CPath,
  CRangeBound,
  CRel,
  CSegment,
  CUnit,
  EvalEnv,
  Params,
} from '../executor.js';
import { consistent, satisfies, unitExposes, unitIsFlat, withBinding } from '../executor.js';
import { candidateCount, candidateVertices, expand, matchesLabel } from '../graph-queries.js';
import { asTruth } from './scalars.js';

// --- matching ----------------------------------------------------------------

export const matchNode = (
  binding: Binding,
  node: CNode,
  vertex: Vertex,
  params: Params,
  graph: Graph,
): Binding | null => {
  if (!matchesLabel(vertex, node.label)) {
    return null;
  }

  if (!consistent(binding, node.variable, vertex)) {
    return null;
  }

  const bound = withBinding(binding, node.variable, vertex);

  if (!satisfies(vertex, node.pred, bound, params, graph)) {
    return null;
  }

  return bound;
};

/** A scalar the property index can seek on (mirrors PropertyIndex's IndexableValue). */
export const isScalar = (v: unknown): v is IndexableValue =>
  v === null ||
  typeof v === 'string' ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && !Number.isNaN(v));

export const EMPTY: ReadonlySet<Vertex> = new Set<Vertex>();

/** Resolve a compiled range bound to concrete scalar endpoints, or null. */
export const evalBound = (bound: CRangeBound, env: EvalEnv): RangeBound | null => {
  const out: RangeBound = {};
  let any = false;

  for (const key of ['gt', 'gte', 'lt', 'lte'] as const) {
    const fn = bound[key];

    if (!fn) {
      continue;
    }

    const v = fn(env);

    if (!isScalar(v)) {
      return null; // a non-scalar endpoint makes the seek meaningless
    }

    out[key] = v;
    any = true;
  }

  return any ? out : null;
};

/** A seekable predicate: its estimated cardinality and a thunk for the set. */
export type SeedCandidate = { count: number; build: () => ReadonlySet<Vertex> };

/**
 * Every index seek a node pattern offers: its ISO equality constraints
 * (`(n {k: v})`) plus the seed hints lifted from WHERE / inline predicates.
 * Each candidate carries a cardinality estimate (computed without touching a
 * set) and a thunk that builds the set only if it's chosen.
 */
export const indexCandidates = function* (
  graph: Graph,
  node: CNode,
  env: EvalEnv,
): Iterable<SeedCandidate> {
  const idx = graph.vertexPropertyIndex;
  const eqCandidate = (key: string, v: unknown): SeedCandidate => ({
    count: idx.countEquals(key, v) ?? 0,
    build: () => idx.equals(key, v) ?? EMPTY,
  });

  for (const { key, value } of node.pred.props) {
    if (idx.isIndexed(key)) {
      const v = value(env);

      if (isScalar(v)) {
        yield eqCandidate(key, v);
      }
    }
  }

  for (const hint of node.seedHints ?? []) {
    if (!idx.isIndexed(hint.key)) {
      continue;
    }

    if (hint.kind === 'eq') {
      const v = hint.value(env);

      if (isScalar(v)) {
        yield eqCandidate(hint.key, v);
      }
    } else if (hint.kind === 'within') {
      const list = hint.values(env);

      if (Array.isArray(list) && list.every(isScalar)) {
        let count = 0;

        for (const item of list) {
          count += idx.countEquals(hint.key, item) ?? 0;
        }

        yield {
          count,
          build: () => {
            const out = new Set<Vertex>();

            for (const item of list) {
              for (const vertex of idx.equals(hint.key, item) ?? EMPTY) {
                out.add(vertex);
              }
            }

            return out;
          },
        };
      }
    } else {
      const bound = evalBound(hint.bound, env);

      if (bound) {
        yield {
          count: idx.countRange(hint.key, bound) ?? 0,
          build: () => idx.range(hint.key, bound) ?? EMPTY,
        };
      }
    }
  }
};

/**
 * Seed candidates for a node pattern. An indexed equality / range / `IN` — from
 * an element-pattern map (`(n:Person {name: 'marko'})`) or a seekable WHERE
 * conjunct (`WHERE n.age > 30`) — seeks the index instead of scanning every
 * vertex. The most selective seek (smallest estimated cardinality) is chosen
 * and materialized; `matchNode` and the residual WHERE re-validate the rest, so
 * the seed only has to be a superset. Falls back to the label-narrowed scan
 * when nothing is indexed.
 */
export const seedVertices = function* (
  graph: Graph,
  node: CNode,
  binding: Binding,
  params: Params,
): Iterable<Vertex> {
  const env: EvalEnv = { binding, params, graph };
  let best: SeedCandidate | undefined;

  for (const candidate of indexCandidates(graph, node, env)) {
    if (!best || candidate.count < best.count) {
      best = candidate;
    }
  }

  if (best) {
    yield* best.build();

    return;
  }

  yield* candidateVertices(graph, node.label);
};

/**
 * The estimated number of seed vertices for starting a pattern at `node`, AND where the number
 * came from.
 *
 * The provenance is the point. An INDEX SEEK (or an already-bound variable) reports a real,
 * narrow count; a LABEL-BUCKET size reports only "how many carry this label", which says nothing
 * about the predicates on that node — an unindexed one contributes nothing at all. Treating the
 * two as interchangeable is what made `orient` reverse away from a selective start (audit items
 * 172 and 173).
 */
type SeedEstimate = { readonly count: number; readonly indexed: boolean };

const estimateSeedFrom = (
  graph: Graph,
  node: CNode,
  binding: Binding,
  params: Params,
): SeedEstimate => {
  // An already-bound variable seeds from exactly one vertex — exact, not a guess.
  if (node.variable && binding.has(node.variable)) {
    return { count: 1, indexed: true };
  }

  const env: EvalEnv = { binding, params, graph };
  let best = Infinity;

  for (const candidate of indexCandidates(graph, node, env)) {
    best = Math.min(best, candidate.count);
  }

  return best === Infinity
    ? { count: candidateCount(graph, node.label), indexed: false }
    : { count: best, indexed: true };
};

/** The estimated number of seed vertices for starting a pattern at `node`. */
export const estimateSeed = (graph: Graph, node: CNode, binding: Binding, params: Params): number =>
  estimateSeedFrom(graph, node, binding, params).count;

/**
 * Does this node carry a constraint beyond its label — an inline property anchor, an inline
 * `WHERE`, or a lifted clause `WHERE`?
 *
 * Such a node is a better seed than its label-bucket size suggests, and by an amount nothing here
 * can estimate: an unindexed predicate is invisible to {@link estimateSeedFrom}.
 */
const isConstrained = (node: CNode, prefilter: unknown): boolean =>
  prefilter !== undefined || node.pred.props.length > 0 || node.pred.where !== undefined;

/**
 * Could this node possibly be reached by an INDEX SEEK?
 *
 * Only `pred.props` and `seedHints` can yield one — those are the two things `indexCandidates`
 * reads — so a node with neither can ONLY ever be estimated from its label bucket. That is
 * knowable from the compiled pattern alone, with no graph work, which is what lets `orient`
 * decide the common case without estimating anything. An inline `WHERE` is deliberately not
 * counted: it cannot be seeked on, only evaluated.
 */
const mightSeek = (node: CNode): boolean =>
  node.pred.props.length > 0 || (node.seedHints?.length ?? 0) > 0;

export const FLIP_DIRECTION: Record<RelPattern['direction'], RelPattern['direction']> = {
  out: 'in',
  in: 'out',
  both: 'both',
};

/**
 * Walk a fixed-length path from its other end: reverse the segment order and
 * flip each relationship's direction. The matched bindings are identical (same
 * edges, same nodes); only the seed side — and thus enumeration order — changes.
 */
export const reversePath = (path: CPath): CPath => {
  const nodes = [path.start, ...path.segments.map((s) => s.node)];
  const segments: CSegment[] = [];

  for (let i = path.segments.length - 1; i >= 0; i--) {
    const seg = path.segments[i];
    segments.push({
      rel: { ...seg.rel, direction: FLIP_DIRECTION[seg.rel.direction] },
      node: nodes[i],
    });
  }

  // Reversing swaps the endpoints but not what the path binds to — nor which outer
  // variables it reads, so both variable sets carry over unchanged.
  return {
    start: nodes[nodes.length - 1],
    segments,
    ...(path.pathVar !== undefined ? { pathVar: path.pathVar } : {}),
    selector: path.selector,
    mode: path.mode,
    binds: path.binds,
    reads: path.reads,
  };
};

/**
 * Pick which end of a fixed-length path to seed from: the side with the smaller
 * estimated seed, so the join starts from the more selective anchor. Patterns
 * with a variable-length segment keep their written orientation (reversing a
 * quantified walk is not handled here).
 */
export const orient = (graph: Graph, pattern: CPath, binding: Binding, params: Params): CPath => {
  if (pattern.segments.length === 0 || pattern.segments.some((s) => s.rel.quantifier)) {
    return pattern;
  }

  const endNode = pattern.segments[pattern.segments.length - 1].node;
  const constrained = isConstrained(pattern.start, pattern.prefilter);

  // Decided with NO graph work: a label bucket may not outvote a constrained start, and a node
  // that cannot seek has nothing but a label bucket to offer. Checking this first matters —
  // asking it after the estimates cost the clause-`WHERE` shape item 172 had just fixed
  // 2.00ms -> 2.33 and the indexed-far-anchor shape 0.11 -> 0.13, both reproducible, because
  // where item 172 short-circuited this paid for two seed estimates.
  if (constrained && !mightSeek(endNode)) {
    return pattern;
  }

  const endEst = estimateSeedFrom(graph, endNode, binding, params);

  // The far end looks cheaper — but a LABEL-BUCKET number is not evidence against a CONSTRAINED
  // start. A start-side constraint (an inline anchor, an inline `WHERE`, or a lifted clause
  // `WHERE`) seeds far more narrowly than its label bucket, and `estimateSeedFrom` cannot say by
  // how much: an unindexed predicate contributes nothing. Reversing also demotes a seed
  // pre-filter to a post-filter, because it can only gate the side it names.
  //
  // So a label bucket may not outvote a constrained start; an INDEX SEEK still may, because that
  // number is real. Measured on a 20,000-user / 200-team / 2,000-resource authz shape, with the
  // pattern `(u:User)-[:MEMBER_OF]->(gr:Team)-[:VIEWER]->(r:Resource)`:
  //
  //   no constraint anywhere                                     3.63ms, 200,000 rows
  //   clause `WHERE u.name = $n`            87.87ms -> 2.00ms (audit item 172)
  //   inline `(u:User {name: $n})`          42.67ms -> see item 173
  //   inline start AND an INDEXED far anchor  0.12ms, and it must STAY there — reversing is
  //                                           right when the far end is a genuine seek
  //
  // The asymmetry is what justifies this without a selectivity estimate: staying put costs the
  // unfiltered plan's scan at worst, while reversing past a selective start expands the whole
  // far side instead of one seed.
  if (constrained && !endEst.indexed) {
    return pattern;
  }

  const startEst = estimateSeedFrom(graph, pattern.start, binding, params);

  return endEst.count < startEst.count ? reversePath(pattern) : pattern;
};

/** Whether `edge` passes a segment's per-hop predicate (inline props / WHERE). The
 *  edge variable is bound so the predicate can name it. `true` when the segment has no
 *  predicate. Lets the shortest BFS expand only over passing edges — a per-hop
 *  predicate is element-local, so the filtered graph is well-defined and BFS's
 *  discover-once shortest invariant still holds. Mirrors native `edge_passes`. */
export const edgePasses = (
  rel: CRel,
  edge: Edge,
  binding: Binding,
  params: Params,
  graph: Graph,
): boolean => {
  if (rel.pred.props.length === 0 && rel.pred.where === undefined) {
    return true;
  }

  return satisfies(edge, rel.pred, withBinding(binding, rel.variable, edge), params, graph);
};

/**
 * `ANY SHORTEST` over a single quantified segment `(start)-[rel q]->(end)`: from
 * the already-matched `seed`, BFS out to one fewest-hop path per reachable
 * endpoint (a vertex is discovered once, keeping its first/shortest predecessor),
 * bind that {@link Path} to the path variable (if named), and yield.
 *
 * Determinism (so native == TS): endpoints are emitted in graph insertion order
 * — the mirror of native's ascending dense-vertex-id order. `q.max` bounds the
 * BFS depth; `q.min ≤ 1` is guaranteed by the parser.
 */
export const shortestWalk = function* (
  graph: Graph,
  pattern: CPath,
  seed: Vertex,
  binding: Binding,
  params: Params,
): Iterable<Binding> {
  const [{ rel, node: endNode }] = pattern.segments;
  const { min, max } = rel.quantifier!;

  // BFS: shortest hop distance + predecessor (vertex, edge) for each vertex.
  const dist = new Map<string, number>([[seed.id, 0]]);
  const pred = new Map<string, { prev: Vertex; edge: Edge }>();
  // A live array iterator: vertices pushed during the walk are visited in turn,
  // giving a FIFO breadth-first order.
  const queue: Vertex[] = [seed];
  // The shortest cycle back to the seed (its first BFS re-arrival). The seed is
  // marked at distance 0 and never re-discovered, so a `+`/`{1,n}` path that
  // closes on it (`(a)-[]->+(a)`, or any endpoint reached via a cycle) would
  // otherwise be missed.
  let seedCycle: { dist: number; prev: Vertex; edge: Edge } | null = null;

  for (const v of queue) {
    const d = dist.get(v.id)!;

    if (max !== null && d >= max) {
      continue; // don't expand past the hop ceiling
    }

    for (const { edge, node: nbr } of expand(graph, v, rel)) {
      if (!edgePasses(rel, edge, binding, params, graph)) {
        continue; // filtered BFS: only expand over predicate-passing edges
      }

      if (nbr.id === seed.id && seedCycle === null) {
        seedCycle = { dist: d + 1, prev: v, edge };
      }

      if (!dist.has(nbr.id)) {
        dist.set(nbr.id, d + 1);
        pred.set(nbr.id, { prev: v, edge });
        queue.push(nbr);
      }
    }
  }

  // When `min ≥ 1` excludes the seed's zero-hop path but a cycle back to it fits
  // the hop ceiling, the seed is an endpoint at the shortest-cycle distance.
  // `min ≤ 1` is guaranteed, so this never double-emits a seed already at dist 0.
  const seedCycleEnd = min >= 1 && seedCycle !== null && (max === null || seedCycle.dist <= max);

  // Endpoints in insertion order (= native's dense-id order).
  for (const end of graph.vertices) {
    const isSeedCycle = end.id === seed.id && seedCycleEnd;
    const d = dist.get(end.id);

    if (!isSeedCycle && (d === undefined || d < min)) {
      continue;
    }

    const matched = matchNode(binding, endNode, end, params, graph);

    if (!matched) {
      continue;
    }

    if (pattern.pathVar === undefined) {
      yield matched;

      continue;
    }

    // Reconstruct the path from the predecessor tree — the shortest path seed…end,
    // or (for the seed-cycle endpoint) the path seed…prev closed by the cycle edge.
    const steps: { edge: Edge; vertex: Vertex }[] = [];
    let cur = isSeedCycle ? seedCycle!.prev : end;

    while (cur.id !== seed.id) {
      const step = pred.get(cur.id)!;
      steps.push({ edge: step.edge, vertex: cur });
      cur = step.prev;
    }

    steps.reverse();

    if (isSeedCycle) {
      steps.push({ edge: seedCycle!.edge, vertex: seed });
    }

    yield withBinding(matched, pattern.pathVar, Path.fromSteps(seed, steps));
  }
};

// `ALL SHORTEST`: every fewest-hop path to each reachable end-matching vertex.
// Like `shortestWalk`, but records ALL shortest predecessors per vertex and
// enumerates the resulting shortest-path DAG (one row per path — ISO per-path
// multiplicity, even without a path variable). Determinism identical to
// `shortestWalk` plus per-endpoint paths in predecessor-recording order, so it
// stays byte-identical with the native `all_shortest_walk`.
export const allShortestWalk = function* (
  graph: Graph,
  pattern: CPath,
  seed: Vertex,
  binding: Binding,
  params: Params,
): Iterable<Binding> {
  const [{ rel, node: endNode }] = pattern.segments;
  const { min, max } = rel.quantifier!;

  const dist = new Map<string, number>([[seed.id, 0]]);
  const preds = new Map<string, { prev: Vertex; edge: Edge }[]>();
  const queue: Vertex[] = [seed];
  let seedCycleDist: number | null = null;
  const seedCycles: { prev: Vertex; edge: Edge }[] = [];

  for (const v of queue) {
    const d = dist.get(v.id)!;

    if (max !== null && d >= max) {
      continue;
    }

    for (const { edge, node: nbr } of expand(graph, v, rel)) {
      if (!edgePasses(rel, edge, binding, params, graph)) {
        continue; // filtered BFS: only expand over predicate-passing edges
      }

      if (nbr.id === seed.id) {
        if (seedCycleDist === null) {
          seedCycleDist = d + 1;
          seedCycles.push({ prev: v, edge });
        } else if (seedCycleDist === d + 1) {
          seedCycles.push({ prev: v, edge });
        }
      }

      const dn = dist.get(nbr.id);

      if (dn === undefined) {
        dist.set(nbr.id, d + 1);
        preds.set(nbr.id, [{ prev: v, edge }]);
        queue.push(nbr);
      } else if (dn === d + 1) {
        preds.get(nbr.id)!.push({ prev: v, edge });
      }
    }
  }

  const seedCycleEnd = min >= 1 && seedCycleDist !== null && (max === null || seedCycleDist <= max);

  // Every shortest path seed…v as a forward `steps` array, via the preds DAG.
  const enumerate = (v: Vertex): { edge: Edge; vertex: Vertex }[][] => {
    if (v.id === seed.id) {
      return [[]];
    }

    const ps = preds.get(v.id);

    if (!ps) {
      return [];
    }

    const out: { edge: Edge; vertex: Vertex }[][] = [];

    for (const { prev, edge } of ps) {
      for (const sub of enumerate(prev)) {
        out.push([...sub, { edge, vertex: v }]);
      }
    }

    return out;
  };

  for (const end of graph.vertices) {
    const isSeedCycle = end.id === seed.id && seedCycleEnd;
    const d = dist.get(end.id);

    if (!isSeedCycle && (d === undefined || d < min)) {
      continue;
    }

    const matched = matchNode(binding, endNode, end, params, graph);

    if (!matched) {
      continue;
    }

    let paths: { edge: Edge; vertex: Vertex }[][];

    if (isSeedCycle) {
      paths = [];

      for (const { prev, edge } of seedCycles) {
        for (const sub of enumerate(prev)) {
          paths.push([...sub, { edge, vertex: seed }]);
        }
      }
    } else {
      paths = enumerate(end);
    }

    for (const steps of paths) {
      yield pattern.pathVar === undefined
        ? matched
        : withBinding(matched, pattern.pathVar, Path.fromSteps(seed, steps));
    }
  }
};

/** A start-seeded path driver: yields each binding extending `binding` from `seed`. */
export type SeedDriver = (
  graph: Graph,
  pattern: CPath,
  seed: Vertex,
  binding: Binding,
  params: Params,
) => Iterable<Binding>;

/** Can a selector pattern reduce to a BFS driver? True when the single var-length
 * segment is a `*`/`+` (min ≤ 1) with no per-hop predicate — the shape the BFS
 * drivers are correct for. Mirrors native `bfs_reducible`. */
export const bfsReducible = (pattern: CPath): boolean => {
  const seg = pattern.segments.length === 1 ? pattern.segments[0] : undefined;
  const q = seg?.rel.quantifier;

  return (
    q !== undefined &&
    q.min <= 1 &&
    seg!.rel.pred.props.length === 0 &&
    seg!.rel.pred.where === undefined
  );
};

/** Pick the start-seeded driver for a selector, or null for the walk / path-var
 * matcher (handled below). `ANY` and `SHORTEST 1 [GROUP]` reduce to the O(V+E)
 * BFS drivers when `bfsReducible` (a shortest path is a valid arbitrary /
 * 1-shortest path); otherwise they enumerate trails. Both engines route
 * identically, so the result stays byte-identical. */
export const pickSeedDriver = (pattern: CPath, selector: PathSelector): SeedDriver | null => {
  if (selector === 'anyShortest') {
    return shortestWalk;
  }

  if (selector === 'allShortest') {
    return allShortestWalk;
  }

  if (selector === 'any') {
    return bfsReducible(pattern) ? shortestWalk : anyWalk;
  }

  if (typeof selector === 'object' && selector.kind === 'shortestK') {
    if (selector.k === 1 && bfsReducible(pattern)) {
      return selector.group ? allShortestWalk : shortestWalk;
    }

    const sel = selector;

    return (graph, pat, seed, binding, params) =>
      shortestKWalk(graph, pat, seed, binding, params, sel);
  }

  return null;
};

/** Yield every binding that extends `binding` by matching `pattern`. */
/**
 * How many seeds a seed filter may reject NOTHING from before it gives up.
 *
 * The filter costs one predicate evaluation per start vertex and saves expanding the vertices
 * it rejects, so a predicate that rejects nothing is pure overhead — measured at 6-8% on a
 * degree-1 fixture where `WHERE a.j = 1` holds for every vertex (1.057x and 1.077x, both
 * after-readings above the before, so not noise). One that has rejected nothing in this many
 * tries is not going to start paying for itself, and the clause `WHERE` is still the authority,
 * so giving up changes no answer.
 */
const PREFILTER_GIVE_UP = 512;

/**
 * The pattern's fault-swallowing seed filter as a per-walk predicate, or `undefined` when there
 * is nothing to apply.
 *
 * `undefined` when the pattern carries no filter, or when the walk seeds from an end the filter
 * was not lifted for — `orient` can flip which end that is, and the predicate is only valid
 * against the end it names.
 *
 * Only a CLEAN non-TRUE rejects a seed. A fault KEEPS it: see `seedPrefilter` in `executor.ts`
 * for why that is the whole design, not a convenience. The clause `WHERE` still decides every
 * row that gets through, which is what makes both the rejection and the give-up answer-neutral.
 */
const seedGate = (
  pattern: CPath,
  oriented: CPath,
  params: Params,
  graph: Graph,
): ((seeded: Binding) => boolean) | undefined => {
  const { prefilter } = pattern;

  if (prefilter === undefined || oriented.start.variable !== prefilter.var) {
    return undefined;
  }

  const { pred } = prefilter;
  let seen = 0;
  let rejected = 0;

  return (seeded: Binding): boolean => {
    if (seen === PREFILTER_GIVE_UP && rejected === 0) {
      return true; // given up — every later seed passes without an evaluation
    }

    seen += 1;

    try {
      if (asTruth(pred({ binding: seeded, params, graph })) === true) {
        return true;
      }
    } catch {
      // Not this filter's business: the clause `WHERE` raises it per row, or the vertex has
      // no rows and nothing raises — which is the behaviour being preserved.
      return true;
    }

    rejected += 1;

    return false;
  };
};

export const matchPattern = function* (
  graph: Graph,
  pattern: CPath,
  binding: Binding,
  params: Params,
): Iterable<Binding> {
  const selector = pattern.selector ?? 'walk';

  // Selectors that seed from the START and yield via a dedicated driver (a BFS
  // one or the trail enumerator). `ANY`/`SHORTEST 1 [GROUP]` reduce to the BFS
  // drivers when the segment is shortest-shaped — see `pickSeedDriver`.
  const seedDriver = pickSeedDriver(pattern, selector);

  if (seedDriver) {
    const seeds: Iterable<Vertex> =
      pattern.start.variable && binding.has(pattern.start.variable)
        ? [binding.get(pattern.start.variable) as Vertex]
        : seedVertices(graph, pattern.start, binding, params);

    const gate = seedGate(pattern, pattern, params, graph);

    for (const seed of seeds) {
      const seeded = matchNode(binding, pattern.start, seed, params, graph);

      if (seeded && (gate === undefined || gate(seeded))) {
        yield* seedDriver(graph, pattern, seed, seeded, params);
      }
    }

    return;
  }

  // Seed from whichever end is more selective, then walk from there — EXCEPT when a
  // path variable is bound. `orient` flips a fixed-length pattern to seed from the
  // selective end, which would reverse the walk; a named path must be materialized in
  // the query's declared direction (byte-identical to native), so seed from the start.
  const path = pattern.pathVar !== undefined ? pattern : orient(graph, pattern, binding, params);

  // Reuse an already-bound vertex if the start variable is known, otherwise
  // seed from an indexed constraint or a label-narrowed scan.
  const seeds: Iterable<Vertex> =
    path.start.variable && binding.has(path.start.variable)
      ? [binding.get(path.start.variable) as Vertex]
      : seedVertices(graph, path.start, binding, params);

  const gate = seedGate(pattern, path, params, graph);

  for (const seed of seeds) {
    const seeded = matchNode(binding, path.start, seed, params, graph);

    if (seeded && (gate === undefined || gate(seeded))) {
      // A bound path variable over a single quantified segment binds each walk as a
      // Path (`allWalk`); over a fixed-length pattern the walk itself is the path, so
      // `walkSegments` accumulates its steps (`pathAcc`) and binds the Path at the end.
      // Otherwise the plain endpoint walk.
      const singleVarlen =
        path.segments.length === 1 && path.segments[0].rel.quantifier !== undefined;

      if (path.pathVar !== undefined && singleVarlen) {
        yield* allWalk(graph, path, seed, seeded, params);
      } else if (path.pathVar !== undefined) {
        yield* walkSegments(graph, path, seed, seeded, params, {
          index: 0,
          pathAcc: { origin: seed, steps: [] },
        });
      } else {
        yield* walkSegments(graph, path, seed, seeded, params);
      }
    }
  }
};

/** Bind the endpoint node and (if named) the walk as a Path, yielding the row.
 * Shared by every trail-enumerating selector (bare `ALL`, `ANY`, `SHORTEST k`). */
export const bindEndAndPath = (
  graph: Graph,
  pattern: CPath,
  walk: TrailEnd,
  binding: Binding,
  params: Params,
): Binding | null => {
  const [{ node: endNode }] = pattern.segments;
  const matched = matchNode(binding, endNode, walk.end, params, graph);

  if (!matched) {
    return null;
  }

  if (pattern.pathVar === undefined) {
    return matched;
  }

  const steps = walk.edges.map((edge, i) => ({ edge, vertex: walk.verts[i + 1] }));

  return withBinding(matched, pattern.pathVar, Path.fromSteps(walk.verts[0], steps));
};

// Bare path binding over a single quantified segment (`p = (a)-[:R]->{m,n}(b)`):
// enumerate every walk under the pattern's mode and bind each as a Path value.
// Mirrors native `all_walk`.
export const allWalk = function* (
  graph: Graph,
  pattern: CPath,
  seed: Vertex,
  binding: Binding,
  params: Params,
): Iterable<Binding> {
  const [{ rel }] = pattern.segments;

  for (const walk of trailEnds(graph, seed, rel, rel.quantifier!, {
    mode: pattern.mode ?? 'trail',
    binding,
    params,
    wantPath: true,
  })) {
    const row = bindEndAndPath(graph, pattern, walk, binding, params);

    if (row) {
      yield row;
    }
  }
};

// Bare `ANY`: one arbitrary path per endpoint — the first walk that reaches each
// distinct endpoint in trail-discovery order. Byte-identical because that order
// is. Mirrors native `any_walk`.
export const anyWalk = function* (
  graph: Graph,
  pattern: CPath,
  seed: Vertex,
  binding: Binding,
  params: Params,
): Iterable<Binding> {
  const [{ rel }] = pattern.segments;
  const seen = new Set<Vertex>();

  for (const walk of trailEnds(graph, seed, rel, rel.quantifier!, {
    mode: pattern.mode ?? 'trail',
    binding,
    params,
    wantPath: pattern.pathVar !== undefined,
  })) {
    // First witness per endpoint only (the endpoint match is per-vertex).
    if (seen.has(walk.end)) {
      continue;
    }

    seen.add(walk.end);

    const row = bindEndAndPath(graph, pattern, walk, binding, params);

    if (row) {
      yield row;
    }
  }
};

// `SHORTEST k [GROUP]`: enumerate every trail, group by endpoint, order each
// endpoint's paths by (length, discovery), then keep the first `k` (plain) or
// every path in the `k` smallest distinct-length groups (`group`). Mirrors native
// `shortest_k_walk`.
export const shortestKWalk = function* (
  graph: Graph,
  pattern: CPath,
  seed: Vertex,
  binding: Binding,
  params: Params,
  sel: { k: number; group: boolean },
): Iterable<Binding> {
  const { k, group } = sel;
  const [{ rel }] = pattern.segments;

  // endpoint -> its trails as { walk, len }, in discovery order.
  const perEnd = new Map<Vertex, { walk: TrailEnd; len: number }[]>();

  for (const walk of trailEnds(graph, seed, rel, rel.quantifier!, {
    mode: pattern.mode ?? 'trail',
    binding,
    params,
    wantPath: true,
  })) {
    const bucket = perEnd.get(walk.end);
    const entry = { walk, len: walk.edges.length };

    if (bucket) {
      bucket.push(entry);
    } else {
      perEnd.set(walk.end, [entry]);
    }
  }

  // Endpoints in graph (insertion/index) order — mirrors native `ends.sort_unstable()`
  // (native ids are the insertion index), the same ordering `allShortestWalk` uses.
  for (const end of graph.vertices) {
    const paths = perEnd.get(end);

    if (!paths) {
      continue;
    }

    // Stable sort by length → shortest first, discovery order within a length.
    paths.sort((a, b) => a.len - b.len);

    let selected: typeof paths;

    if (group) {
      // The k smallest distinct lengths (paths are length-sorted, so equal lengths
      // are contiguous); keep every path at or below the kth.
      const distinct: number[] = [];

      for (const p of paths) {
        if (distinct[distinct.length - 1] !== p.len) {
          distinct.push(p.len);
        }
      }

      const cutoff = distinct.slice(0, k).at(-1);
      selected = cutoff === undefined ? [] : paths.filter((p) => p.len <= cutoff);
    } else {
      selected = paths.slice(0, k);
    }

    for (const { walk } of selected) {
      const row = bindEndAndPath(graph, pattern, walk, binding, params);

      if (row) {
        yield row;
      }
    }
  }
};

/** Recursively extend a binding across the remaining segments of a pattern. */
/** Bind a repetition unit's GROUP variables to the walk's per-repetition value
 *  lists. For a `k`-hop unit repeated `reps` times: each node position `p` (0..=k;
 *  the unit source then each hop's target) and each edge position (each hop's edge)
 *  is exposed as the LIST of that position's value across every repetition
 *  (`verts[rep*k + p]` / `edges[rep*k + p]`). A one-hop unit (`k = 1`) collapses to
 *  `x = verts[..last]`, `y = verts[1..]`, `e = edges`. Mirrors native `bind_group_vars`. */

/** One graph-consuming hop of a matched trail, tagged with its position in the (possibly
 *  nested) repetition pattern. `levels` is the cursor stack outer→inner: one `[rep,
 *  elemAfter]` per active unit, where `elemAfter` is the element the hop advanced PAST
 *  (so the hop's own element is `elemAfter - 1`). Mirrors native `StepRec`. */
export type StepRec = {
  levels: readonly [number, number][];
  source: Vertex;
  edge: Edge;
  target: Vertex;
};

/** Place `val` at `root[idx[0]][idx[1]]…`, growing intermediate lists as needed, and
 *  return the new root. An EMPTY `idx` yields the value itself (a SCALAR — the per-rep
 *  `WHERE` view of an outer-unit variable); a `d`-element tuple nests `d` levels deep.
 *  Mirrors native `Nest` (empty index → `Leaf`). */
export const nestInsert = (root: unknown, idx: readonly number[], val: unknown): unknown => {
  if (idx.length === 0) {
    return val;
  }

  const arr: unknown[] = Array.isArray(root) ? root : [];
  let cur = arr;

  for (let d = 0; d < idx.length - 1; d += 1) {
    const i = idx[d];

    while (cur.length <= i) {
      cur.push([]);
    }

    if (!Array.isArray(cur[i])) {
      cur[i] = [];
    }

    cur = cur[i] as unknown[];
  }

  const last = idx[idx.length - 1];

  while (cur.length <= last) {
    cur.push([]);
  }

  cur[last] = val;

  return arr;
};

/** Assemble one unit's group variables from the structured walk. `treePath` is the
 *  `Sub`-element indices from the top unit down to THIS unit, so `depth = treePath.length`
 *  is its nesting depth (0 = top). A variable is indexed by the rep counters of levels
 *  `0..=depth` — enclosing quantifiers are the outer list dimensions, this unit's own rep
 *  the innermost. Reproduces the old k-stride binding for a flat unit; recurses into each
 *  `Sub`. Mirrors native `bind_unit`. */
export const bindUnit = (
  next: Map<string, unknown>,
  unit: CUnit,
  treePath: readonly number[],
  keyStart: number,
  steps: readonly StepRec[],
): void => {
  const depth = treePath.length;
  const key = (s: StepRec): number[] => s.levels.slice(keyStart, depth + 1).map(([r]) => r);
  const within = (s: StepRec): boolean =>
    s.levels.length > depth && treePath.every((e, j) => s.levels[j][1] === e);

  // `startVar` = each rep-instance's source = its FIRST hop's source (which may sit
  // inside a leading `Sub`, hence `within`, not just direct hops).
  if (unit.startVar !== undefined) {
    let root: unknown = [];
    const seen = new Set<string>();

    for (const s of steps) {
      if (within(s)) {
        const k = key(s);
        const kk = k.join(',');

        if (!seen.has(kk)) {
          seen.add(kk);
          root = nestInsert(root, k, s.source);
        }
      }
    }

    next.set(unit.startVar, root);
  }

  unit.elems.forEach((el, e) => {
    if ('hop' in el) {
      const direct = (s: StepRec): boolean =>
        within(s) && s.levels.length === depth + 1 && s.levels[depth][1] === e + 1;

      if (el.hop.targetVar !== undefined) {
        let root: unknown = [];

        for (const s of steps) {
          if (direct(s)) {
            root = nestInsert(root, key(s), s.target);
          }
        }

        next.set(el.hop.targetVar, root);
      }

      if (el.hop.rel.variable !== undefined) {
        let root: unknown = [];

        for (const s of steps) {
          if (direct(s)) {
            root = nestInsert(root, key(s), s.edge);
          }
        }

        next.set(el.hop.rel.variable, root);
      }
    } else {
      // A `Sub`'s landing = its LAST inner hop's target, per rep-instance (inner steps
      // keep this unit's `elem` pinned at `e`).
      if (el.sub.targetVar !== undefined) {
        const last = new Map<string, { k: number[]; target: Vertex }>();

        for (const s of steps) {
          if (within(s) && s.levels.length > depth + 1 && s.levels[depth][1] === e) {
            const k = key(s);
            last.set(k.join(','), { k, target: s.target });
          }
        }

        let root: unknown = [];

        for (const { k, target } of last.values()) {
          root = nestInsert(root, k, target);
        }

        next.set(el.sub.targetVar, root);
      }

      bindUnit(next, el.sub.unit, [...treePath, e], keyStart, steps);
    }
  });
};

/** The HOT-path binder for a FLAT (all-hop) unit: the walk is `r` reps of a fixed `k`-hop
 *  unit, so the node var at position `p` is `verts[rep·k + p]` and the edge var is
 *  `edges[rep·k + p]`. A direct stride over two flat arrays — no per-hop `StepRec`
 *  allocation (that generality is only needed for nesting). Byte-identical to the
 *  structured binder on a flat unit. Mirrors native `bind_group_vars_flat`. */
export const bindGroupVarsFlat = (
  binding: Binding,
  unit: CUnit,
  verts: readonly Vertex[],
  edges: readonly Edge[],
): Binding => {
  const next = new Map(binding);
  const k = unit.elems.length;
  const reps = k === 0 ? 0 : Math.floor(edges.length / k);

  for (let p = 0; p <= k; p += 1) {
    let varName = unit.startVar;

    if (p > 0) {
      const el = unit.elems[p - 1];
      varName = 'hop' in el ? el.hop.targetVar : undefined;
    }

    if (varName !== undefined) {
      const list: Vertex[] = [];

      for (let rep = 0; rep < reps; rep += 1) {
        list.push(verts[rep * k + p]);
      }

      next.set(varName, list);
    }
  }

  for (let p = 0; p < k; p += 1) {
    const el = unit.elems[p];
    const varName = 'hop' in el ? el.hop.rel.variable : undefined;

    if (varName !== undefined) {
      const list: Edge[] = [];

      for (let rep = 0; rep < reps; rep += 1) {
        list.push(edges[rep * k + p]);
      }

      next.set(varName, list);
    }
  }

  return next;
};

/** Expose a quantified subpath's inner variables as GROUP variables from the structured
 *  walk (the GENERAL path, for NESTED units) — each a (possibly nested) list, one level
 *  per enclosing quantifier. A flat unit takes {@link bindGroupVarsFlat} instead. Mirrors
 *  native `bind_group_vars`. */
export const bindGroupVars = (
  binding: Binding,
  unit: CUnit,
  steps: readonly StepRec[],
): Binding => {
  const next = new Map(binding);
  bindUnit(next, unit, [], 0, steps);

  return next;
};

/** Bind ONE outer rep's variables for the per-repetition `WHERE` (`steps` already filtered
 *  to that rep). `keyStart = 1` drops the outer-rep index, so an outer-unit variable
 *  collapses to a SCALAR and a variable inside a `Sub` becomes a LIST over the inner reps —
 *  the per-rep view the predicate sees (`size(e)`, `x[0]`, …). Mirrors native
 *  `bind_group_vars_perrep`. */
export const bindGroupVarsPerRep = (
  binding: Binding,
  unit: CUnit,
  steps: readonly StepRec[],
): Binding => {
  const next = new Map(binding);
  bindUnit(next, unit, [], 1, steps);

  return next;
};

/** Evaluate a unit's per-repetition `WHERE` at an OUTER-rep completion. `repSteps` are the
 *  completing rep's hops; bind the unit's variables to their per-rep values — a direct
 *  variable is a SCALAR, a variable inside a nested `Sub` is a LIST over the inner reps
 *  (`bindGroupVarsPerRep`) — then test the predicate. Mirrors native `where_ok`. */
export const unitWherePasses = (
  unit: CUnit,
  repSteps: readonly StepRec[],
  env: EvalEnv,
): boolean => {
  if (unit.where === undefined) {
    return true;
  }

  const wb = bindGroupVarsPerRep(env.binding, unit, repSteps);

  return asTruth(unit.where({ ...env, binding: wb })) === true;
};

/** The mark a hop claims under `mode`: its edge (TRAIL) / its target vertex (SIMPLE,
 *  ACYCLIC), or nothing (WALK, or a SIMPLE close back on the seed). */
export const hopMark = (
  mode: PathMode,
  isClose: boolean,
  edge: Edge,
  nbr: Vertex,
): Edge | Vertex | null => {
  if (isClose || mode === 'walk') {
    return null;
  }

  return mode === 'trail' ? edge : nbr;
};

/** Whether this hop repeats an already-marked element under `mode` (edge for TRAIL,
 *  target vertex for SIMPLE/ACYCLIC) — the per-hop restrictor. */
export const hopCollides = (
  mode: PathMode,
  marks: ReadonlySet<Edge | Vertex>,
  edge: Edge,
  nbr: Vertex,
): boolean => {
  if (mode === 'trail') {
    return marks.has(edge);
  }

  if (mode === 'simple' || mode === 'acyclic') {
    return marks.has(nbr);
  }

  return false;
};

// Stable ids for the epsilon-cycle visited-set in `resolve` (a min-0 nested unit can
// loop through the same position without consuming an edge).
export const unitIdMap = new WeakMap<object, number>();
let unitIdNext = 0;
export const unitId = (u: CUnit): number => {
  let id = unitIdMap.get(u);

  if (id === undefined) {
    id = unitIdNext;
    unitIdNext += 1;
    unitIdMap.set(u, id);
  }

  return id;
};

// A loop cursor + a pattern position (a cursor stack, innermost last). TS keeps the
// simple `Cursor[]` form (the native engine's `Flat`/`Deep` split is a hot-path
// optimization; this is the reference impl).
export type Cursor = { unit: CUnit; min: number; max: number | null; rep: number; elem: number };
export type HopMove = { rel: CRel; after: Cursor[] };

/** Follow epsilon moves (enter a sub / close a nested unit / repeat) from `start`,
 *  collecting whether the TOP unit accepts here (`emit`), whether an OUTER rep just
 *  completed (`completedOuter` — the top unit reached its end, the per-rep `WHERE` hook,
 *  true even below `min`), and every graph-consuming hop reachable. A visited set breaks
 *  min-0 epsilon cycles. Mirrors native `resolve`. */
export const resolve = (
  start: Cursor[],
): { emit: boolean; completedOuter: boolean; moves: HopMove[] } => {
  let emit = false;
  let completedOuter = false;
  const moves: HopMove[] = [];
  const work: Cursor[][] = [start];
  const seen = new Set<string>();

  while (work.length > 0) {
    const p = work.pop()!;
    const key = p.map((c) => `${unitId(c.unit)}:${c.rep}:${c.elem}`).join(';');

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    const top = p[p.length - 1];

    if (top.elem < top.unit.elems.length) {
      const el = top.unit.elems[top.elem];

      if ('hop' in el) {
        const after = p.map((c) => ({ ...c }));
        after[after.length - 1].elem += 1;
        moves.push({ rel: el.hop.rel, after });
      } else {
        const enter = p.map((c) => ({ ...c }));
        enter.push({ unit: el.sub.unit, min: el.sub.min, max: el.sub.max, rep: 0, elem: 0 });
        work.push(enter);

        if (el.sub.min === 0) {
          const bypass = p.map((c) => ({ ...c }));
          bypass[bypass.length - 1].elem += 1;
          work.push(bypass);
        }
      }
    } else {
      const rep2 = top.rep + 1;

      // Accept this completion only INSIDE the unit's bounds. The lower bound alone is
      // not enough: the first hop's move is generated unconditionally, so a `{0,0}` (or
      // any max=0) unit would otherwise emit a 1-rep completion (`1 >= 0`) even though
      // its max forbids it. The `again` guard below already stops FURTHER reps, but the
      // first over-max completion must be rejected here too.
      if (rep2 >= top.min && (top.max === null || rep2 <= top.max)) {
        if (p.length === 1) {
          emit = true;
        } else {
          const close = p.map((c) => ({ ...c }));
          close.pop();
          close[close.length - 1].elem += 1;
          work.push(close);
        }
      }

      // The TOP unit at its end (any `rep`, `min` or not) = an outer rep completed.
      if (p.length === 1) {
        completedOuter = true;
      }

      if (top.max === null || rep2 < top.max) {
        const again = p.map((c) => ({ ...c }));
        again[again.length - 1] = { ...again[again.length - 1], rep: rep2, elem: 0 };
        work.push(again);
      }
    }
  }

  return { emit, completedOuter, moves };
};

/**
 * Does this hop carry an inline predicate that `satisfies` would apply?
 *
 * ALL THREE of `CPredicate`'s fields, because `satisfies` checks all three: `props`, then
 * `eqProps`, then `where`. The check this replaces read only `props` and `where`.
 *
 * `eqProps` is unreachable for a REL today — `compileRel` calls `compilePredicate` with no
 * `ownVar`, so `directEqProps` never lifts anything out of an edge's `WHERE` — which is why
 * nothing was wrong. But the omission would have DROPPED an edge predicate silently the moment
 * it did, and passing `ownVar` on a pattern is live work: item 230 added the lifting and left
 * `compileNode` not passing it as an open question. A skipped predicate filter returns a
 * SUPERSET, so no correctness test on a fixture lacking that spelling can see it, and the
 * fuzzer's edge predicates are all `>` / `>=` — never the `=` against a literal that `eqProps`
 * is for. Defensive, and the test that pins it builds the `CRel` by hand for that reason.
 */
export const relHasInlinePred = (rel: CRel): boolean =>
  rel.pred.props.length > 0 ||
  rel.pred.where !== undefined ||
  (rel.pred.eqProps !== undefined && rel.pred.eqProps.length > 0);

/** A hop's out-edges materialized and filtered by its inline predicate. Mirrors native
 *  `expand_filtered`. */
export const expandFilteredArr = (
  graph: Graph,
  v: Vertex,
  rel: CRel,
  binding: Binding,
  params: Params,
): { edge: Edge; node: Vertex }[] => {
  const hasPred = relHasInlinePred(rel);
  const out: { edge: Edge; node: Vertex }[] = [];

  for (const step of expand(graph, v, rel)) {
    if (hasPred) {
      const eb = withBinding(binding, rel.variable, step.edge);

      if (!satisfies(step.edge, rel.pred, eb, params, graph)) {
        continue;
      }
    }

    out.push(step);
  }

  return out;
};

/**
 * The GENERAL repetition matcher: repeat `unit` from `from`, yielding each trail end in
 * [min, max] REPETITIONS. `unit`'s elements are hops OR nested quantified sub-units, so
 * this is ONE matcher for every var-length shape. A single, LAZY, explicit-stack
 * pushdown DFS — one frame per hop of the CURRENT path (O(path length), no d^k buffer).
 * A frame's pattern position is a cursor stack; `resolve` follows the epsilon moves to
 * the reachable hops. TRAIL/SIMPLE/ACYCLIC/WALK restrictors are applied PER HOP. The
 * consumer owns group-variable exposure — this only reconstructs under `wantPath`. A
 * generator suspends on consumer-stop, so the mark set needs no explicit stop cleanup.
 * Mirrors native `reachable_each_unit`.
 */
export const trailEndsUnit = function* (
  graph: Graph,
  from: Vertex,
  unit: CUnit,
  q: NonNullable<CRel['quantifier']>,
  opts: { mode: PathMode; binding: Binding; params: Params; wantPath?: boolean },
): Iterable<TrailEnd> {
  const { mode, binding, params, wantPath = false } = opts;
  const vertexMode = mode === 'simple' || mode === 'acyclic';
  const marks = new Set<Edge | Vertex>();

  if (vertexMode) {
    marks.add(from);
  }

  let steps = 0;
  const hasWhere = unit.where !== undefined;
  // A flat (all-hop) unit binds group vars by the cheap `k`-stride over the flat walk, so
  // it never needs per-hop steps — only a nested unit does.
  const flat = unitIsFlat(unit);

  // The top unit's `min == 0` zero-rep acceptance — the empty walk at the seed.
  if (q.min === 0) {
    yield { end: from, verts: wantPath ? [from] : [], edges: [], steps: [] };
  }

  type Frame = {
    vertex: Vertex;
    moves: HopMove[];
    moveIdx: number;
    edges: { edge: Edge; node: Vertex }[];
    edgeIdx: number;
    entryEdge: Edge | null;
    entryMark: Edge | Vertex | null;
  };

  const seed = resolve([{ unit, min: q.min, max: q.max, rep: 0, elem: 0 }]);
  const stack: Frame[] = [
    {
      vertex: from,
      moves: seed.moves,
      moveIdx: 0,
      edges:
        seed.moves.length > 0
          ? expandFilteredArr(graph, from, seed.moves[0].rel, binding, params)
          : [],
      edgeIdx: 0,
      entryEdge: null,
      entryMark: null,
    },
  ];

  // The structured walk up to (and including) the current hop `(edgeV, nbrV)`. Each frame's
  // taken move stays frozen at the hop that spawned its child while that child is live, so
  // `stack[i].moves[moveIdx].after` is hop `i`'s landing position; the final hop is this
  // one. Mirrors native `rebuild_steps`.
  const buildSteps = (nbrV: Vertex, edgeV: Edge): StepRec[] =>
    stack.map((f, i) => {
      const at = f.moves[f.moveIdx].after;
      const isLast = i + 1 >= stack.length;

      return {
        levels: at.map((c) => [c.rep, c.elem] as [number, number]),
        source: f.vertex,
        edge: isLast ? edgeV : stack[i + 1].entryEdge!,
        target: isLast ? nbrV : stack[i + 1].vertex,
      };
    });

  while (stack.length > 0) {
    const top = stack[stack.length - 1];

    if (top.edgeIdx >= top.edges.length) {
      const nextMove = top.moveIdx + 1;

      if (nextMove < top.moves.length) {
        top.moveIdx = nextMove;
        top.edges = expandFilteredArr(graph, top.vertex, top.moves[nextMove].rel, binding, params);
        top.edgeIdx = 0;
        continue;
      }

      if (top.entryMark !== null) {
        marks.delete(top.entryMark);
      }

      stack.pop();
      continue;
    }

    const { edge, node: nbr } = top.edges[top.edgeIdx];
    top.edgeIdx += 1;
    const { after } = top.moves[top.moveIdx];

    // Does this hop finish the OUTER unit's rep? Only then may a SIMPLE path close on its
    // own start, because a close terminates the path and a path may not stop part-way
    // through a repetition. That question is `resolve`'s `completedOuter`, AFTER the
    // epsilon-closure: the raw position `after` sits at the INNERMOST unit's end, and for a
    // nested unit the closure is what pops the finished inner reps up to the outer end.
    // Testing the raw position instead (`after.length === 1 && at its unit's end`) is true
    // only for a single-level unit, so a nested group closed on nothing and
    // `((x)-[:R]->(y)){1,2}` and `(((x)-[:R]->(y)){1,2}){1,1}` — one outer rep of an inner
    // 1..2, the same question — answered 11 and 6 (audit item 244).
    //
    // Resolved LAZILY, because `nbr === from` is rare and `resolve` allocates: hoisting it
    // above the collide check unconditionally would run it for every rejected hop of every
    // simple/acyclic walk. No admitted hop resolves twice.
    const [{ rep: outerRep }] = after;
    const closeResolved = mode === 'simple' && nbr === from ? resolve(after) : null;
    const isClose = closeResolved?.completedOuter === true;

    if (!isClose && hopCollides(mode, marks, edge, nbr)) {
      continue;
    }

    // Resolve the epsilon-closure: does the top unit ACCEPT here, did an OUTER rep just
    // complete (the per-rep `WHERE` hook), and the onward hops.
    const resolved = closeResolved ?? resolve(after);
    const { completedOuter } = resolved;
    let { emit, moves: nextMoves } = resolved;

    // Per-repetition `WHERE` at each outer-rep completion. On failure, PRUNE only the
    // outer-completion branch: suppress the emit and drop the moves that start the next
    // outer rep, while inner-continue branches (same outer rep) survive. For a linear unit
    // there is no inner branch, so this prunes the whole hop (the old per-rep skip).
    if (
      completedOuter &&
      hasWhere &&
      !unitWherePasses(
        unit,
        buildSteps(nbr, edge).filter((s) => s.levels[0]?.[0] === outerRep),
        { binding, params, graph },
      )
    ) {
      emit = false;
      nextMoves = nextMoves.filter((m) => m.after[0].rep <= outerRep);
    }

    steps += 1;

    if (steps > graph.limits.trail) {
      throw new LenkeError(
        'Variable-length pattern exceeded the trail budget; add a tighter bound',
        { code: ErrorCode.ResourceExhausted },
      );
    }

    const mark = hopMark(mode, isClose, edge, nbr);

    if (mark !== null) {
      marks.add(mark);
    }

    if (emit) {
      if (wantPath) {
        const verts = stack.map((f) => f.vertex);
        verts.push(nbr);

        const edges = stack.map((f) => f.entryEdge).filter((e): e is Edge => e !== null);
        edges.push(edge);

        // Only a NESTED unit needs the structured per-hop steps; a flat unit binds from
        // `verts`/`edges` directly (the hot path — no per-hop allocation).
        yield { end: nbr, verts, edges, steps: flat ? [] : buildSteps(nbr, edge) };
      } else {
        yield { end: nbr, verts: [], edges: [], steps: [] };
      }
    }

    // A SIMPLE close emits but does NOT extend; likewise a position with no onward move.
    if (isClose || nextMoves.length === 0) {
      if (mark !== null) {
        marks.delete(mark);
      }

      continue;
    }

    stack.push({
      vertex: nbr,
      moves: nextMoves,
      moveIdx: 0,
      edges: expandFilteredArr(graph, nbr, nextMoves[0].rel, binding, params),
      edgeIdx: 0,
      entryEdge: edge,
      entryMark: mark,
    });
  }
};

// A `walkSegments` cursor: the current segment `index`, plus (when a path variable is
// bound over a fixed-length pattern) `pathAcc` — the walk so far, i.e. the
// declared-direction origin and each hop's edge+vertex. The terminal binds `pathAcc` as a
// `Path`; a plain endpoint walk leaves it absent.
type WalkCursor = {
  index: number;
  pathAcc?: { origin: Vertex; steps: { edge: Edge; vertex: Vertex }[] };
};

export const walkSegments = function* (
  graph: Graph,
  pattern: CPath,
  from: Vertex,
  binding: Binding,
  params: Params,
  walk: WalkCursor = { index: 0 },
): Iterable<Binding> {
  const { index, pathAcc } = walk;

  if (index >= pattern.segments.length) {
    yield pathAcc !== undefined && pattern.pathVar !== undefined
      ? withBinding(binding, pattern.pathVar, Path.fromSteps(pathAcc.origin, pathAcc.steps))
      : binding;

    return;
  }

  const { rel, node, unit } = pattern.segments[index];

  // Variable-length: enumerate the endpoint of every trail within [min, max]
  // repetitions (one per trail → ISO per-path multiplicity), then continue from
  // each. A parenthesized SUBPATH repeats a `k`-hop unit and exposes its group
  // variables (`trailEndsUnit`); the abbreviated form is the single-edge walk
  // (`trailEnds`, the k=1 fast-path). Both bind/filter each hop's edge.
  if (rel.quantifier) {
    const mode = pattern.mode ?? 'trail';
    const ends = unit
      ? trailEndsUnit(graph, from, unit, rel.quantifier, { mode, binding, params, wantPath: true })
      : trailEnds(graph, from, rel, rel.quantifier, { mode, binding, params, wantPath: false });

    for (const { end, verts, edges, steps } of ends) {
      // A flat unit binds from the flat walk (`verts`/`edges`, the k-stride hot path); a
      // nested unit uses the structured per-hop steps.
      let withGroups = binding;

      if (unit && unitExposes(unit)) {
        withGroups = unitIsFlat(unit)
          ? bindGroupVarsFlat(binding, unit, verts, edges)
          : bindGroupVars(binding, unit, steps);
      }

      const matched = matchNode(withGroups, node, end, params, graph);

      if (matched) {
        // Defensive: a path var never reaches a quantified segment today (the parser
        // rejects a mixed fixed/variable-length named path), but if that changes,
        // append the sub-walk's hops so the accumulated Path stays complete.
        const nextAcc =
          pathAcc &&
          ({
            origin: pathAcc.origin,
            steps: [...pathAcc.steps, ...edges.map((e, i) => ({ edge: e, vertex: verts[i + 1] }))],
          } satisfies typeof pathAcc);

        yield* walkSegments(graph, pattern, end, matched, params, {
          index: index + 1,
          pathAcc: nextAcc,
        });
      }
    }

    return;
  }

  for (const { edge, node: nextVertex } of expand(graph, from, rel)) {
    if (!consistent(binding, rel.variable, edge)) {
      continue;
    }

    const withEdge = withBinding(binding, rel.variable, edge);

    if (!satisfies(edge, rel.pred, withEdge, params, graph)) {
      continue;
    }

    const matched = matchNode(withEdge, node, nextVertex, params, graph);

    if (matched) {
      const nextAcc =
        pathAcc &&
        ({
          origin: pathAcc.origin,
          steps: [...pathAcc.steps, { edge, vertex: nextVertex }],
        } satisfies typeof pathAcc);

      yield* walkSegments(graph, pattern, nextVertex, matched, params, {
        index: index + 1,
        pathAcc: nextAcc,
      });
    }
  }
};

/**
 * Per-expansion cap on trail-traversal steps; a guard against exponential blowup.
 * The DEFAULT only — the live bound is `graph.limits.trail`, which a host can
 * raise or lower per graph (see `GraphLimits`). Kept exported because the
 * shortcut detector reasons about the default when deciding whether a trail
 * enumeration is worth attempting.
 */
export const TRAIL_BUDGET = DEFAULT_CONFIG.limits.trail;

/**
 * Endpoints of every *trail* — a path that traverses each relationship at most
 * once (ISO/IEC 39075 default for a quantified path) — from `from` within
 * [min, max] hops of `rel`. Yielded one per trail, so an endpoint reachable by
 * `k` distinct trails is yielded `k` times (ISO per-path multiplicity); a `min`
 * of 0 includes the zero-length trail (the start node itself).
 *
 * Edge-uniqueness bounds a trail's length to the edge count, so this always
 * terminates even on cycles — but the *number* of trails can be exponential, so
 * a per-expansion step budget throws rather than letting a pathological `*`
 * exhaust memory/time.
 */
export type TrailEnd = {
  end: Vertex;
  verts: readonly Vertex[];
  edges: readonly Edge[];
  steps: readonly StepRec[];
};

export type TrailOpts = {
  mode: PathMode;
  // The binding at the segment's start (outer bound vars stay visible to a per-hop
  // predicate) and the query params. Each hop's edge is bound onto `binding` for
  // the predicate; the binding itself is not mutated.
  binding: Binding;
  params: Params;
  // When true, reconstruct each trail's vertices/edges from the frame stack (a
  // path variable needs the whole walk); otherwise `verts`/`edges` are empty.
  wantPath?: boolean;
};

/**
 * The abbreviated `-[]->{n,m}` form through the GENERAL matcher — a one-hop repetition unit.
 *
 * EXPORTED only so `trailEnds`' fast path can be differentially tested against it: the two must
 * agree on the emission SEQUENCE, not merely on the set of ends, and once the fast path is wired
 * the general one is otherwise unreachable for this shape (audit item 239).
 */
export const trailEndsViaUnit = function* (
  graph: Graph,
  from: Vertex,
  rel: CRel,
  q: NonNullable<CRel['quantifier']>,
  opts: TrailOpts,
): Iterable<TrailEnd> {
  const unit: CUnit = { elems: [{ hop: { rel } }] };

  yield* trailEndsUnit(graph, from, unit, q, {
    mode: opts.mode,
    binding: opts.binding,
    params: opts.params,
    wantPath: opts.wantPath ?? false,
  });
};

export const trailEnds = function* (
  graph: Graph,
  from: Vertex,
  rel: CRel,
  q: NonNullable<CRel['quantifier']>,
  opts: TrailOpts,
): Iterable<TrailEnd> {
  // A single edge is a one-hop repetition unit, and until item 239 this delegated to the general
  // matcher for every case — on the stated grounds that "there is ONE traversal implementation and
  // no hand-tuned twin to drift". That is still the right default and the general path below still
  // answers every shape this one declines. What changed is the measurement: the general matcher
  // costs 7.82us an outer row where a hand-written walk of the same question costs 0.82 — 9.5x,
  // decomposing into ~2.7us of per-EXECUTION setup and ~1.2-2.0us per repetition (audit item 237).
  //
  // The general matcher pays that for generality this shape does not use. Per hop it calls
  // `resolve`, which allocates two arrays and a `Set` and builds a STRING KEY per work item to
  // break min-0 epsilon cycles — and a one-hop unit has no epsilon moves at all, so the visited
  // set can never fire. Per execution it builds a `CUnit` from compile-time data, a cursor stack,
  // a `buildSteps` closure and a seed `resolve`.
  //
  // So: a flat walk for the case with NO path reconstruction, which is the one the serving
  // benchmarks use. `wantPath` keeps the general path, because reconstructing the walk is where
  // the cursor machinery earns itself.
  //
  // THE RULES IT MUST MATCH, read off `resolve` for a one-hop unit rather than reasoned about:
  // every hop completes the top rep (`elem` reaches `elems.length` of 1), so after hop `k` the
  // rep count IS `k` — `emit` iff `k >= min && (max === null || k <= max)`, and a further rep is
  // offered iff `max === null || k < max`. `min === 0` yields the empty walk at the seed first.
  // `completesTop` is therefore always true, which makes `isClose` simply SIMPLE mode returning to
  // the seed. The order within a hop is collision check, budget, mark, emit, descend — the
  // general loop's order, because the emission SEQUENCE is observable and a differential test
  // compares it.
  if (opts.wantPath === true) {
    yield* trailEndsViaUnit(graph, from, rel, q, opts);

    return;
  }

  const { mode, binding, params } = opts;
  const vertexMode = mode === 'simple' || mode === 'acyclic';
  // WALK marks nothing, so it allocates nothing. The other three need the set: `hopCollides` and
  // `hopMark` read EDGES under trail and VERTICES under simple/acyclic.
  const marks: Set<Edge | Vertex> | undefined = mode === 'walk' ? undefined : new Set();

  if (vertexMode) {
    (marks as Set<Edge | Vertex>).add(from);
  }

  if (q.min === 0) {
    yield { end: from, verts: [], edges: [], steps: [] };
  }

  type FlatFrame = {
    edges: { edge: Edge; node: Vertex }[];
    idx: number;
    // The mark this frame's entry hop added, deleted when the frame pops — the general matcher's
    // `entryMark`.
    mark: Edge | Vertex | null;
  };

  let steps = 0;
  const stack: FlatFrame[] = [
    { edges: expandFilteredArr(graph, from, rel, binding, params), idx: 0, mark: null },
  ];

  while (stack.length > 0) {
    const top = stack[stack.length - 1];

    if (top.idx >= top.edges.length) {
      if (top.mark !== null) {
        (marks as Set<Edge | Vertex>).delete(top.mark);
      }

      stack.pop();
      continue;
    }

    const { edge, node: nbr } = top.edges[top.idx];
    top.idx += 1;
    // `stack.length` hops have been taken counting this one: the seed frame is depth 1.
    const rep = stack.length;
    const isClose = mode === 'simple' && nbr === from;

    if (!isClose && marks !== undefined && (mode === 'trail' ? marks.has(edge) : marks.has(nbr))) {
      continue;
    }

    steps += 1;

    if (steps > graph.limits.trail) {
      throw new LenkeError(
        'Variable-length pattern exceeded the trail budget; add a tighter bound',
        { code: ErrorCode.ResourceExhausted },
      );
    }

    // `hopMark`'s rule, spelled out: a SIMPLE close marks nothing (it emits without extending),
    // WALK marks nothing at all, TRAIL marks the EDGE and SIMPLE/ACYCLIC the target VERTEX.
    let mark: Edge | Vertex | null = null;

    if (!isClose && mode !== 'walk') {
      mark = mode === 'trail' ? edge : nbr;
    }

    if (mark !== null) {
      (marks as Set<Edge | Vertex>).add(mark);
    }

    if (rep >= q.min && (q.max === null || rep <= q.max)) {
      yield { end: nbr, verts: [], edges: [], steps: [] };
    }

    // A SIMPLE close emits but does not extend; nor does a rep that has reached `max`.
    if (isClose || !(q.max === null || rep < q.max)) {
      if (mark !== null) {
        (marks as Set<Edge | Vertex>).delete(mark);
      }

      continue;
    }

    stack.push({ edges: expandFilteredArr(graph, nbr, rel, binding, params), idx: 0, mark });
  }
};
