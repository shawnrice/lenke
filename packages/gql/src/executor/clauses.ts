// Statement execution: the write clauses (INSERT/SET/REMOVE/DELETE, _MERGE),
// per-clause processing that threads bindings through a linear pipeline, and the
// set operators (UNION/EXCEPT/INTERSECT). Extracted from the executor.

import { runAlgorithmSync } from '@lenke/core';
import type { AlgorithmConfig, AlgorithmName, Edge, Graph, Vertex } from '@lenke/core';
import { ErrorCode, LenkeError } from '@lenke/errors';
import { filter, flatMap, map, skip, slice, toArray } from '@lenke/fp';

import type { Query, SetOp, TxControl } from '../ast.js';
import { hasIncidentEdges } from '../graph-queries.js';
// Back-edges into the executor trunk (compiled types + helpers), used lazily.
import type {
  Binding,
  CCallInline,
  CCallNamed,
  CDelete,
  CFor,
  CInsert,
  CInsertNode,
  CLinear,
  CMatch,
  CMerge,
  CPath,
  CProp,
  CRemove,
  CSet,
  CSetItem,
  EvalEnv,
  Params,
  Row,
} from './core.js';
import type { RowsFn } from './hop-projection.js';
import { matchPattern } from './matching.js';
import { boundedTopKeyed } from './ordered-rows.js';
import { applyProjection, projectedRows } from './projection.js';
import { mapToArray, resolveCount, valueKey } from './rows.js';
import { asTruth } from './scalars.js';
import { compareSort, isEdge, isElement, isVertex } from './values.js';

export const evalProps = (
  props: readonly CProp[],
  b: Binding,
  params: Params,
  graph: Graph,
): Record<string, unknown> => {
  const env: EvalEnv = { binding: b, params, graph };
  const out: Record<string, unknown> = {};

  for (const { key, value } of props) {
    out[key] = value(env);
  }

  return out;
};

/**
 * Insert a vertex, using a string `id` property as the element's identity — so
 * `element_id(n)` equals it and serialization round-trips by domain identity
 * instead of a random synthetic id, while `id` is still stored as an ordinary
 * property. A non-string or absent id mints a synthetic one; a duplicate string id
 * throws (ids are unique). Mirrors the native `insert_vertex_with_id`.
 */
export const insertVertexWithId = (
  graph: Graph,
  labels: readonly string[],
  properties: Record<string, unknown>,
): Vertex => {
  const { id } = properties;

  if (typeof id === 'string') {
    if (graph.getVertexById(id) !== null) {
      throw new LenkeError(
        `an element with id '${id}' already exists — a string \`id\` property is the ` +
          `element's unique identity; use _MERGE to upsert, or a fresh id`,
        { code: ErrorCode.ConstraintViolation },
      );
    }

    return graph.addVertex({ id, labels: [...labels], properties });
  }

  return graph.addVertex({ labels: [...labels], properties });
};

/**
 * Insert an edge, using a string `id` property as its external identity — the edge
 * analogue of {@link insertVertexWithId}. Edge ids are unique among edges; a
 * duplicate string id throws. Mirrors native `insert_edge_with_id`.
 */
export const insertEdgeWithId = (
  graph: Graph,
  from: Vertex,
  to: Vertex,
  labels: readonly string[],
  properties: Record<string, unknown>,
): Edge => {
  const { id } = properties;

  if (typeof id === 'string') {
    if (graph.getEdgeById(id) !== null) {
      throw new LenkeError(
        `an element with id '${id}' already exists — a string \`id\` property is the ` +
          `element's unique identity; use _MERGE to upsert, or a fresh id`,
        { code: ErrorCode.ConstraintViolation },
      );
    }

    return graph.addEdge({ id, from, to, labels: [...labels], properties });
  }

  return graph.addEdge({ from, to, labels: [...labels], properties });
};

/** Create a node from a pattern, reusing an already-bound variable. */
export const ensureNode = (
  graph: Graph,
  binding: Map<string, unknown>,
  node: CInsertNode,
  params: Params,
): Vertex => {
  if (node.variable && binding.has(node.variable)) {
    return binding.get(node.variable) as Vertex;
  }

  const properties = evalProps(node.props, binding, params, graph);

  // A plain INSERT that breaks a unique constraint is rejected — but the check is
  // deferred to commit (via `addVertex`'s constraint chokepoint + `runDeferredChecks`),
  // not eager, so a transient duplicate resolved before commit is allowed. This
  // matches the native engine's deferred-check (transaction) semantics; an eager check here
  // wrongly rejected `INSERT` + later `DELETE` of the dup within one transaction
  // `_MERGE` still reconciles instead (docs/design/gql-extensions.md §3).
  const vertex = insertVertexWithId(graph, node.labels, properties);

  if (node.variable) {
    binding.set(node.variable, vertex);
  }

  return vertex;
};

export const runInsert = (
  graph: Graph,
  clause: CInsert,
  binding: Binding,
  params: Params,
): Binding => {
  const out = new Map(binding);

  for (const pattern of clause.patterns) {
    let prev = ensureNode(graph, out, pattern.start, params);

    for (const { rel, node } of pattern.segments) {
      const next = ensureNode(graph, out, node, params);
      const [from, to] = rel.direction === 'in' ? [next, prev] : [prev, next];
      const edge = insertEdgeWithId(
        graph,
        from,
        to,
        rel.labels,
        evalProps(rel.props, out, params, graph),
      );

      if (rel.variable) {
        out.set(rel.variable, edge);
      }

      prev = next;
    }
  }

  return out;
};

/**
 * Infer the conflict key for `_MERGE`: the single unique-constrained key present
 * in the pattern's properties. No applicable constraint → error (can't define
 * "the key"); more than one → ambiguous. See docs/design/gql-extensions.md §2.2.
 */
export const inferMergeKey = (
  graph: Graph,
  labels: readonly string[],
  properties: Record<string, unknown>,
): { label: string; key: string; value: unknown } => {
  const candidates: { label: string; key: string; value: unknown }[] = [];

  for (const label of labels) {
    for (const key of graph.uniqueKeys(label)) {
      if (key in properties) {
        candidates.push({ label, key, value: properties[key] });
      }
    }
  }

  if (candidates.length === 0) {
    throw new LenkeError(
      `_MERGE needs a unique constraint on the pattern's label(s) [${labels.join(', ')}] to define the key — declare one with createUniqueConstraint`,
      { code: ErrorCode.InvalidGraphOp },
    );
  }

  if (candidates.length > 1) {
    throw new LenkeError(
      `_MERGE key is ambiguous: the pattern touches multiple unique constraints (${candidates
        .map((c) => `${c.label}.${c.key}`)
        .join(', ')}) — narrow it to one`,
      { code: ErrorCode.InvalidGraphOp },
    );
  }

  return candidates[0];
};

/** Apply `_ON_CREATE` / `_ON_UPDATE` SET items to the merged `vertex`. */
// Apply `_ON_CREATE` / `_ON_UPDATE` SET items to the node or edge each item's
// variable resolves to in `binding` (mirrors `runSet`).
export const applyMergeSets = (
  graph: Graph,
  items: readonly CSetItem[],
  binding: Binding,
  params: Params,
): void => {
  for (const item of items) {
    const el = binding.get(item.variable);

    if (!isElement(el)) {
      continue;
    }

    if ('label' in item) {
      if (isEdge(el)) {
        graph.addLabelToEdge(item.label, el);
      } else {
        graph.addLabelToVertex(item.label, el);
      }
    } else {
      el.setProperty(item.key, item.value({ binding, params, graph }));
    }
  }
};

// Resolve a `_MERGE` edge endpoint: the vertex matched by its unique-constraint
// key. Throws (InvalidGraphOp) if no key can be inferred or no vertex matches.
export const resolveMergeEndpoint = (
  graph: Graph,
  node: CInsertNode,
  binding: Binding,
  params: Params,
): Vertex => {
  // An endpoint bound by a preceding clause — `MATCH (a), (b) _MERGE (a)-[:R]->(b)`,
  // the natural way to merge an edge between two known vertices — is already a
  // resolved vertex. Use it directly rather than re-inferring a unique key from the
  // (empty) node pattern, which would throw and made the bound-variable form of
  // edge `_MERGE` unusable. Mirrors the native engine's `resolve_merge_endpoint`.
  if (node.variable !== undefined) {
    const bound = binding.get(node.variable);

    if (isVertex(bound)) {
      return bound;
    }
  }

  const properties = evalProps(node.props, binding, params, graph);
  const { label, key, value } = inferMergeKey(graph, node.labels, properties);
  const found = graph.uniqueLookup(label, key, value);

  if (found === undefined) {
    throw new LenkeError(
      `_MERGE: endpoint (:${node.labels.join('&')} {${key}: …}) not found — its key must match an existing vertex`,
      { code: ErrorCode.InvalidGraphOp },
    );
  }

  return found;
};

// `_MERGE` edge form (v1): match both endpoints by key, then upsert the single
// edge between them keyed structurally by (from, to, type). Dispositions apply to
// the edge (which has no key prop, so the default clobbers all its props).
export const runMergeEdge = (
  graph: Graph,
  clause: CMerge,
  binding: Binding,
  params: Params,
): Binding => {
  const out = new Map(binding);
  const [seg] = clause.pattern.segments;
  const startV = resolveMergeEndpoint(graph, clause.pattern.start, out, params);
  const endV = resolveMergeEndpoint(graph, seg.node, out, params);
  const [from, to] = seg.rel.direction === 'in' ? [endV, startV] : [startV, endV];
  const [relType] = seg.rel.labels;

  if (relType === undefined) {
    throw new LenkeError('_MERGE: an edge must carry exactly one type', {
      code: ErrorCode.InvalidGraphOp,
    });
  }

  const edgeProps = evalProps(seg.rel.props, out, params, graph);

  // Bind the resolved endpoints so the dispositions can read them.
  if (clause.pattern.start.variable) {
    out.set(clause.pattern.start.variable, startV);
  }

  if (seg.node.variable) {
    out.set(seg.node.variable, endV);
  }

  const existing = graph.findEdge(from, to, relType);
  let edge: Edge;

  if (existing === undefined) {
    edge = graph.addEdge({ from, to, labels: [relType], properties: edgeProps });

    if (seg.rel.variable) {
      out.set(seg.rel.variable, edge);
    }

    if (clause.onCreate) {
      applyMergeSets(graph, clause.onCreate, out, params);
    }
  } else {
    edge = existing;

    if (seg.rel.variable) {
      out.set(seg.rel.variable, edge);
    }

    const disp = clause.onUpdate;

    if (disp === undefined) {
      // An edge has no key prop → the default clobbers all its props.
      for (const [k, v] of Object.entries(edgeProps)) {
        edge.setProperty(k, v);
      }
    } else if (disp.kind === 'set') {
      const passes =
        disp.where === undefined || asTruth(disp.where({ binding: out, params, graph })) === true;

      if (passes) {
        applyMergeSets(graph, disp.items, out, params);
      }
    }
    // disp.kind === 'nothing' → leave the edge untouched.
  }

  if (seg.rel.variable) {
    out.set(seg.rel.variable, edge);
  }

  return out;
};

// `_MERGE` keyed upsert. Node form: match by the constraint key; on miss insert
// the pattern (key + payload) then `_ON_CREATE`; on hit apply the update
// disposition — default clobbers the non-key payload, `_ON_UPDATE SET … [WHERE]`
// replaces it, `_ON_UPDATE_NOTHING` leaves it. One segment → the edge form above;
// multi-hop compound patterns are deferred (v2).
export const runMerge = (
  graph: Graph,
  clause: CMerge,
  binding: Binding,
  params: Params,
): Binding => {
  if (clause.pattern.segments.length === 1) {
    return runMergeEdge(graph, clause, binding, params);
  }

  if (clause.pattern.segments.length > 1) {
    throw new LenkeError('_MERGE multi-hop compound patterns are not yet supported (v2)', {
      code: ErrorCode.NotImplemented,
    });
  }

  const out = new Map(binding);
  const node = clause.pattern.start;
  const properties = evalProps(node.props, out, params, graph);
  const { label, key, value } = inferMergeKey(graph, node.labels, properties);
  const existing = graph.uniqueLookup(label, key, value);

  let vertex: Vertex;

  if (existing === undefined) {
    vertex = insertVertexWithId(graph, node.labels, properties);

    if (node.variable) {
      out.set(node.variable, vertex);
    }

    if (clause.onCreate) {
      applyMergeSets(graph, clause.onCreate, out, params);
    }
  } else {
    vertex = existing;

    if (node.variable) {
      out.set(node.variable, vertex);
    }

    const disp = clause.onUpdate;

    if (disp === undefined) {
      // Default clobber: write every non-key payload prop to the pattern's value.
      for (const [k, v] of Object.entries(properties)) {
        if (k !== key) {
          vertex.setProperty(k, v);
        }
      }
    } else if (disp.kind === 'set') {
      // An explicit update replaces the default, gated by WHERE if present.
      const passes =
        disp.where === undefined || asTruth(disp.where({ binding: out, params, graph })) === true;

      if (passes) {
        applyMergeSets(graph, disp.items, out, params);
      }
    }
    // disp.kind === 'nothing' → leave the existing element untouched.
  }

  if (node.variable) {
    out.set(node.variable, vertex);
  }

  return out;
};

// Both labels and properties go through the element's index-maintaining
// mutators (`addLabelTo*` / `setProperty`) so the graph's label and property
// value indexes stay consistent — a later MATCH seeds from `vertexPropertyIndex`,
// so a direct `el.properties =` write would leave that index stale (and skip
// mutation events).
export const runSet = (graph: Graph, clause: CSet, binding: Binding, params: Params): void => {
  for (const item of clause.items) {
    const el = binding.get(item.variable);

    if (!isElement(el)) {
      continue;
    }

    if ('label' in item) {
      if (isEdge(el)) {
        graph.addLabelToEdge(item.label, el);
      } else {
        graph.addLabelToVertex(item.label, el);
      }
    } else if (item.key === 'id' && el.id === el.properties.id) {
      // An element keyed by a string `id` has that id as its identity (external id
      // === the `id` property), fixed at creation — re-keying it would break
      // `element_id` / round-trip stability, so reject the SET. A numeric/absent
      // `id` is an ordinary (possibly unique-constrained) property and stays
      // SET-able. Mirrors native `vertex_id_is_identity` / `edge_id_is_identity`.
      throw new LenkeError(
        "cannot SET `id`: a string `id` is the element's identity and is fixed at " +
          'creation — insert a new element with the new id instead',
        { code: ErrorCode.InvalidGraphOp },
      );
    } else {
      const value = item.value({ binding, params, graph });

      // A SET that collides under a unique constraint is rejected via the core
      // property-write chokepoint (`assertUniqueOnSet`), which defers the check to
      // commit inside a transaction. Deferring (rather than an eager check here)
      // lets a transient collision that is reverted before commit succeed, matching
      // the native engine's transaction semantics. Constraints are vertex-only.
      el.setProperty(item.key, value);
    }
  }
};

export const runRemove = (graph: Graph, clause: CRemove, binding: Binding): void => {
  for (const item of clause.items) {
    const el = binding.get(item.variable);

    if (!isElement(el)) {
      continue;
    }

    if ('label' in item) {
      if (isEdge(el)) {
        graph.removeLabelFromEdge(item.label, el);
      } else {
        graph.removeLabelFromVertex(item.label, el);
      }
    } else {
      el.removeProperty(item.key);
    }
  }
};

export const runDelete = (
  graph: Graph,
  clause: CDelete,
  binding: Binding,
  params: Params,
): void => {
  for (const target of clause.targets) {
    const el = target({ binding, params, graph });

    if (isEdge(el)) {
      graph.removeEdge(el);
    } else if (isElement(el)) {
      const vertex = el as Vertex;

      // Plain DELETE must not orphan relationships: deleting a still-connected
      // node is a graph violation unless the user opted into DETACH (which
      // cascades the incident edges).
      if (!clause.detach && hasIncidentEdges(vertex)) {
        throw new LenkeError(
          'Cannot delete a node that still has relationships; use DETACH DELETE',
          { code: ErrorCode.InvalidGraphOp },
        );
      }

      graph.removeVertex(vertex);
    }
  }
};

// --- clause processing -------------------------------------------------------

/**
 * How much it costs to START this pattern, given what is already bound. Lower is
 * better.
 *
 * THIS IS TS-ONLY. It used to claim it mirrored a native `pattern_rank` (xref:gone) in
 * `gql/eval/pathfind.rs` "exactly — the two must agree or the engines emit rows in
 * different orders". Neither half survives: that file and that function do not exist in
 * the crate (nothing there ranks patterns; `cost::estimate` is consulted only for
 * fast-path routing), and row order between the engines is UNSPECIFIED by policy, which
 * is why the conformance harness compares structurally. Found by `bun run xref` at item
 * 614.
 */
const patternRank = (p: CPath, b: Binding): number => {
  const bound = (v?: string) => v !== undefined && b.has(v);

  if (
    bound(p.start.variable) ||
    p.segments.some((s) => bound(s.rel.variable) || bound(s.node.variable))
  ) {
    return 0; // continues an existing binding — no fresh scan at all
  }

  return p.start.label !== undefined || p.start.pred.props.length > 0 ? 1 : 2;
};

/** Position within `remaining` of the next pattern to extend into. */
const pickPattern = (patterns: readonly CPath[], remaining: readonly number[], b: Binding) => {
  let best = 0;
  let bestRank = 3;

  for (let i = 0; i < remaining.length; i++) {
    const rank = patternRank(patterns[remaining[i]], b);

    if (rank < bestRank) {
      bestRank = rank;
      best = i;
    }

    if (rank === 0) {
      break; // can't do better than continuing an existing binding
    }
  }

  return best;
};

/**
 * Extend a binding through the remaining patterns, choosing at each step rather
 * than following the order they were written.
 *
 * `remaining` is copied rather than mutated-and-restored: these are generators,
 * so a shared mutable done-mask would be corrupted the moment a consumer
 * interleaved two of them.
 */
/**
 * How many tail bindings may be cached to avoid re-matching an uncorrelated
 * pattern. Bounded on purpose: `matchClauseBindings` promises to stream, and this
 * is the one place that holds rows. The pathology it fixes is worst when the tail
 * is SMALL and the bucket it scans is LARGE (audit item 121: four tail rows cost
 * 10.6ms because a 20,000-vertex bucket was rescanned per outer row), while a tail
 * big enough to overflow this means a product big enough to be output-bound
 * anyway — so the cap gives up nothing that mattered.
 */
const TAIL_CACHE_CAP = 4096;

/** Do none of `rest`'s patterns bind or read anything `pat` binds? */
const tailIsUncorrelated = (
  patterns: readonly CPath[],
  rest: readonly number[],
  pat: CPath,
): boolean => {
  if (pat.binds.size === 0) {
    return true; // binds nothing, so nothing downstream can depend on it
  }

  for (const i of rest) {
    const r = patterns[i];

    for (const name of pat.binds) {
      if (r.binds.has(name) || r.reads.has(name)) {
        return false;
      }
    }
  }

  return true;
};

/**
 * Yield an uncorrelated tail while RECORDING it, so the cache costs nothing extra
 * to fill and the first row still comes out after one match.
 *
 * The caller's `seen` array is filled as rows pass through, and the return value
 * says whether it is a complete tail (`true`) or overflowed the cap (`false`, and
 * `seen` must be discarded). A consumer that stops early — any `LIMIT` — abandons
 * this generator mid-tail, so neither answer is reached and nothing is cached:
 * incomplete is exactly what an abandoned tail is.
 *
 * This replaces filling the array FIRST and yielding from it afterwards, which
 * made every leading `MATCH … LIMIT n` pay a full `min(bucket, cap)` match pass
 * before its first row — 521x on `LIMIT 1` over a 20,000-vertex bucket, and a
 * live divergence from the engine, which streams (audit item 150).
 */
const recordTail = function* (
  rows: Iterable<Binding>,
  seen: Binding[],
): Generator<Binding, boolean> {
  let complete = true;

  for (const b of rows) {
    if (complete) {
      if (seen.length === TAIL_CACHE_CAP) {
        complete = false;
      } else {
        seen.push(b);
      }
    }

    yield b;
  }

  return complete;
};

/**
 * `outer` extended by `inner` — ONE Map per row, without the intermediate arrays (item 2022).
 *
 * ⚠️⚠️ **THIS LINE WAS 43.5% SELF WITH ANOTHER 21.3% IN THE GARBAGE COLLECTOR** on the GQL surface's
 * largest shape. `visitRemaining`'s uncorrelated-tail product (item 121) already matches the tail
 * ONCE and caches it; what was left was `new Map([...outer, ...inner])` run per output row — two
 * array spreads, each materializing a two-element array per entry, a concat, and then the Map insert
 * that was the only necessary part.
 *
 * Priced in isolation at 2,250,000 rows with the engine's own key shape — an outer binding of one
 * variable, each side adding two more, overlapping on the outer key — every arm checked to produce
 * the SAME key order and values before being timed (`binding-merge-cost-2022.mjs`):
 *
 * ```text
 *     new Map([...outer, ...inner])    461.4 ms   205 ns/row
 *     THIS — copy, then set            257.4      114           1.79x
 *     a pre-sized Map (knows the keys) 220.5       98           the floor for one Map per row
 *     a no-copy VIEW over both maps      3.5        2           ⬅ see the warning below
 * ```
 *
 * ⚠️⚠️ **THE 132x VIEW IS NOT A DEFERRED WIN, IT IS AN UNMEASURED ONE, and the probe flatters it by
 * construction.** That arm reads ONE key per row; the engine's consumers vary — `projectRow` reads
 * a key per output column (where a view would indeed be nearly free), while `RETURN *` copies every
 * entry and `DISTINCT`'s `rowKey` iterates the whole binding, and a view pays per access on both. It
 * also makes every `Binding` consumer depend on a `ReadonlyMap`-shaped class rather than a `Map`.
 * Item 762's lesson in its general form: a micro-benchmark's consumer is not the engine's. Pricing
 * it needs an in-situ A/B with the ITERATING shapes as controls, which is a separate item.
 *
 *
 * ⚠️⚠️ **THE NO-COPY VIEW WAS BUILT, MEASURED IN SITU AND DECLINED (item 2023). Do not rebuild it
 * from the 132x figure above — that number is a probe artifact.** A `ReadonlyMap`-shaped view over
 * the two maps, swapped in at the product's cached-rows site, four alternated rounds, one arm per
 * process, arms named COPY and VIEW:
 *
 * ```text
 *     consumer                              COPY     VIEW
 *     RETURN b.n AS x, d.n AS y  (2 gets)   349.3    176.2   1.98x FASTER
 *     RETURN *                   (iterates) 326.5    841.5   2.58x SLOWER  ⬅ the refusal
 *     RETURN DISTINCT …          (iterates) 778.1    612.9   1.27x faster
 *     … ORDER BY x, y                       967.2    761.9   1.27x faster
 * ```
 *
 * So the idea's real size is **1.98x on its best shape, not 132x** — the probe read one key a row
 * where the engine does more — and it **REGRESSES `RETURN *` by 2.58x**, which is a shape people
 * write. Three further costs the probe could not show:
 *
 *   - NOT A DROP-IN: TypeScript's `ReadonlyMap` requires `MapIterator` (the iterator-helper
 *     protocol), so a generator-backed view needs either casts that must not ship or a narrowing of
 *     the `Binding` type across the whole engine.
 *   - IT MAKES EVERY `binding.get` CALL SITE POLYMORPHIC — two shapes where there was one — a cost
 *     that appears in no probe of this function and would need the whole-screen sweep to bound.
 *   - IT HOLDS REFERENCES, so it is sound only while every matcher yield site builds a FRESH
 *     binding. Inspected, not proved.
 *
 * ⚠️⚠️ **AND REUSING ONE MAP ACROSS THE INNER LOOP WAS ALSO BUILT, PRICED AND DECLINED (item 2024):
 * 3.76x on this frame, with no type or polymorphism cost — refused because its soundness needs every
 * binding RETAINER enumerated across a LAZY engine and a pattern search cannot prove that, while the
 * one unbounded retainer (grouping, for a whole-group aggregate) needs a copy per row that cancels
 * the win. Three retainers found: `recordTail`'s cache (bounded 4096), the top-k heap (bounded by the
 * window), and grouping (unbounded). TAKEN TOGETHER WITH THE VIEW ABOVE, THE PER-ROW ALLOCATION IS
 * CLOSED — two independent attempts, each priced, each refused for a different documented reason. Do
 * not re-derive either from a profile; the numbers are in CLOSED.md at items 2023 and 2024.**
 *
 * Gating the view on the consumer (`!proj.star`) would capture both of its wins and is the only
 * version of EITHER idea worth pricing further — but the matcher does not know the projection, so it needs that plumbed in, and
 * the 2.58x cliff is what a wrong gate costs. Numbers recorded here so that is a decision with
 * evidence rather than an idea with a headline.
 *
 * ⚠️ KEY ORDER IS IDENTICAL AND THAT IS A CONTRACT, not a detail: `visitRemaining` documents the
 * merge order as "outer keys, then `pat`'s, then the tail's — which `RETURN *` projects in", and
 * column order is bytes ([[column-order-is-observable]]). `Map.set` on an EXISTING key keeps that
 * key's original position, so copy-then-set and the spread agree for the overlapping keys too; the
 * probe asserts it rather than arguing it.
 */
const mergeBinding = (outer: Binding, inner: Binding): Binding => {
  const merged = new Map(outer);

  for (const [k, v] of inner) {
    merged.set(k, v);
  }

  return merged;
};

const visitRemaining = function* (
  graph: Graph,
  patterns: readonly CPath[],
  remaining: readonly number[],
  binding: Binding,
  params: Params,
): Iterable<Binding> {
  if (remaining.length === 0) {
    yield binding;

    return;
  }

  const pick = pickPattern(patterns, remaining, binding);
  const rest = remaining.filter((_, i) => i !== pick);
  const pat = patterns[remaining[pick]];

  // An UNCORRELATED tail matches the same rows for every row of `pat`, so match it
  // ONCE and form the product — instead of re-running it per outer row, which made
  // the cost `outer x BUCKET` rather than `outer x tail` and put this 160x behind
  // the native engine (audit item 121).
  //
  // The tail is matched against `binding`, NOT an empty binding: `binding` is fixed
  // for this call, so the tail may still read anything bound at an OUTER level and
  // only `pat`'s own bindings have to be absent from it.
  //
  // Row ORDER is unchanged — the nested loops enumerate exactly what the recursion
  // did, in the same sequence — and so is `pickPattern`'s choice inside the tail,
  // because `patternRank` differs between `binding` and `b` only on whether a
  // pattern continues an existing binding, which uncorrelatedness rules out.
  if (rest.length > 0 && tailIsUncorrelated(patterns, rest, pat)) {
    // The FIRST outer row streams the tail through `recordTail`, so its rows are
    // yielded as they are matched and the cache fills as a by-product; later rows
    // read the filled cache. Collecting the tail up front instead cost a whole
    // tail pass before the first row — which a `LIMIT` then discarded (item 150,
    // the same defect as in `hoistedMatch`).
    const seen: Binding[] = [];
    let complete = false;
    let first = true;

    for (const b of matchPattern(graph, pat, binding, params)) {
      // `t` already carries `binding`; `b` carries `binding` plus `pat`'s own
      // variables. Merging in this order reproduces the recursion's key order
      // exactly — outer keys, then `pat`'s, then the tail's — which `RETURN *`
      // projects in.
      if (first) {
        first = false;

        const tail = recordTail(visitRemaining(graph, patterns, rest, binding, params), seen);
        let next = tail.next();

        while (next.done !== true) {
          yield mergeBinding(b, next.value);
          next = tail.next();
        }

        complete = next.value;
        continue;
      }

      if (complete) {
        for (const t of seen) {
          yield mergeBinding(b, t);
        }

        continue;
      }

      // The tail overflowed the cap, so there is nothing cached to form a product
      // with — recurse for this row, exactly as the uncached path does. The first
      // row's output is already correct and is not revisited.
      yield* visitRemaining(graph, patterns, rest, b, params);
    }

    return;
  }

  for (const b of matchPattern(graph, pat, binding, params)) {
    yield* visitRemaining(graph, patterns, rest, b, params);
  }
};

/**
 * Extend a binding through every pattern of a MATCH clause, then filter WHERE.
 * Fully lazy: bindings flow one at a time to whatever consumes the result, so a
 * clause that expands to millions of them never materializes them.
 *
 * Patterns are visited in the order [`pickPattern`] chooses. Running a pattern
 * whose start is already bound before one that needs a fresh scan is what keeps
 * two spellings of the same query from costing wildly different amounts — see
 * `docs/design/query-ir.md`; the anchored and unanchored spellings measured
 * 121,336x apart at 300k vertices before this existed. Ties keep the written
 * order, so a query whose patterns are equally cheap to start emits rows exactly
 * as it did before.
 */
export const matchClauseBindings = (
  graph: Graph,
  clause: CMatch,
  binding: Binding,
  params: Params,
): Iterable<Binding> => {
  // One pattern is the overwhelmingly common case and has nothing to choose
  // between, so call it DIRECTLY.
  //
  // This used to be `flatMap(b => matchPattern(…), [binding])` — a flatMap over a
  // ONE-element array, whose comment claimed it added "no generator frame per
  // row". It did: `flatMap` is itself a `function*`, so every row's `next()` was
  // threaded through a generator frame that existed only to iterate a single
  // item. A resume in this pipeline costs ~40ns (item 119), so that frame was
  // real money on a million-row traversal.
  const stream: Iterable<Binding> =
    clause.patterns.length === 1
      ? matchPattern(graph, clause.patterns[0], binding, params)
      : visitRemaining(
          graph,
          clause.patterns,
          clause.patterns.map((_, i) => i),
          binding,
          params,
        );

  return clause.where === undefined
    ? stream
    : filter(
        (b: Binding) => asTruth(clause.where!({ binding: b, params, graph })) === true,
        stream,
      );
};

/** OPTIONAL MATCH: the binding's matches, or one null-filled row if there were none. */
const optionalMatch = function* (
  graph: Graph,
  clause: CMatch,
  binding: Binding,
  params: Params,
): Iterable<Binding> {
  let matched = false;

  for (const m of matchClauseBindings(graph, clause, binding, params)) {
    matched = true;

    yield m;
  }

  if (!matched) {
    // No match: keep the row with the pattern's new variables set to null.
    const filled = new Map(binding);

    for (const v of clause.nullVars) {
      if (!filled.has(v)) {
        filled.set(v, null);
      }
    }

    yield filled;
  }
};

/**
 * Per-incoming-binding: stream its matches, or (for OPTIONAL) one null-filled row.
 *
 * A PLAIN MATCH returns the stream directly. This was one generator whose
 * `!matched && clause.optional` tail can only fire for OPTIONAL, so for every
 * other MATCH it was a pure pass-through — `for (const m of …) yield m` — costing
 * a generator frame per row to forward each row unchanged. OPTIONAL keeps its
 * own generator, byte-identical, because it genuinely has to know whether
 * anything matched before it can emit.
 */
export const matchOrOptional = (
  graph: Graph,
  clause: CMatch,
  binding: Binding,
  params: Params,
): Iterable<Binding> =>
  clause.optional
    ? optionalMatch(graph, clause, binding, params)
    : matchClauseBindings(graph, clause, binding, params);

/**
 * A MATCH whose matches cannot depend on the incoming row, matched ONCE.
 *
 * Item 122 fixed this rescan WITHIN a clause (`visitRemaining`); separate MATCH
 * clauses go through here instead and had the same shape — `ns/(outer x bucket)`
 * measured 164 against the fixed path's 41, i.e. still re-running the second
 * clause for every row of the first.
 *
 * TWO conditions, and `reads` alone is NOT enough. An empty `reads` says the
 * clause's matches do not depend on the incoming row's VALUES. But a pattern
 * variable that is ALREADY BOUND is an anchor, not a fresh scan —
 * `MATCH (a:P) MATCH (a)-[:E]->(b)` reads nothing yet is a join — and pattern
 * variables live in `binds`, not `reads`. So each incoming row is also checked for
 * sharing a name with `binds`, and any row that does falls back.
 *
 * OPTIONAL is excluded outright, and that exclusion is a DEFENSIVE belt rather
 * than a load-bearing guard: mutation shows that removing it changes no answer
 * today, because a null-filled variable that is already bound would be caught by
 * the `binds` check first. That equivalence rests on `nullVars` being a subset of
 * `binds` — two sets computed by different functions (`patternVars` and
 * `patternBoundVars`) — so the belt stays. If it ever drifts, a bound variable
 * would be overwritten with null.
 */
const hoistedMatch = function* (
  graph: Graph,
  clause: CMatch,
  bindings: Iterable<Binding>,
  params: Params,
): Iterable<Binding> {
  let cached: Binding[] | undefined;
  // The tail overflowed the cap once, so it will again — remember it rather than
  // re-pulling (and re-discarding) a capful per outer row. The comment on the cap
  // already promised "once, not per outer row"; nothing recorded it.
  let overflowed = false;

  for (const binding of bindings) {
    let shares = false;

    for (const name of clause.binds) {
      if (binding.has(name)) {
        shares = true;
        break;
      }
    }

    if (shares) {
      yield* matchOrOptional(graph, clause, binding, params);
      continue;
    }

    if (cached !== undefined) {
      for (const c of cached) {
        yield mergeBinding(binding, c);
      }

      continue;
    }

    if (overflowed) {
      yield* matchOrOptional(graph, clause, binding, params);
      continue;
    }

    // Matched against an EMPTY binding: `reads` is empty and no name is shared,
    // so nothing in the clause can consult the row. The cache therefore holds
    // only the clause's own variables, which is what makes the merge below
    // reproduce `matchPattern` extending `binding`.
    //
    // The tail streams THROUGH `recordTail` rather than being collected first, so
    // this row's own matches are yielded as they are found and the cache is a free
    // by-product. Filling it first cost a whole match pass before the first row,
    // which a `LIMIT` then threw away — and made TS raise on a candidate the
    // engine never evaluates.
    const seen: Binding[] = [];
    const tail = recordTail(matchOrOptional(graph, clause, new Map(), params), seen);
    // An EMPTY incoming binding — the leading MATCH of a query, which is the common
    // case — has nothing to merge, so the matcher's own binding passes straight
    // through. Copying it instead costs a Map per row and measured 1.93x on a
    // 20,000-row scan. This is the same aliasing the previous overflow path had,
    // which yielded `matchOrOptional` directly; later outer rows still read the
    // cache through a copy below.
    const bare = binding.size === 0;
    let next = tail.next();

    while (next.done !== true) {
      yield bare ? next.value : mergeBinding(binding, next.value);
      next = tail.next();
    }

    if (next.value) {
      cached = seen;
    } else {
      overflowed = true;
    }
  }
};

/** Lazily expand a binding stream through a MATCH — no intermediate array. */
export const runMatch = (
  graph: Graph,
  clause: CMatch,
  bindings: Iterable<Binding>,
  params: Params,
): Iterable<Binding> =>
  clause.optional || clause.reads.size > 0
    ? flatMap((binding: Binding) => matchOrOptional(graph, clause, binding, params), bindings)
    : hoistedMatch(graph, clause, bindings, params);

/**
 * Lazily unwind a list per incoming binding — one row per element (ISO GQL's
 * FOR / UNWIND). A list unwinds its elements; null/undefined yields zero rows;
 * any other scalar unwinds as a one-element list. Matches the Rust engine
 * byte-for-byte. ORDINALITY counts from 1, OFFSET from 0.
 */
/**
 * The built-in procedure catalog: procedure name → its algorithm and non-`node`
 * result column. Output columns are always `[node, <result>]`. Mirrors native
 * `algo::procedure_result_col`, which answers the same question for the same names
 * (there is no `plan.rs` in the crate — that path is from the retired `lenke-core`).
 */
export const PROCEDURES: Record<string, { algo: AlgorithmName; resultColumn: string }> = {
  pagerank: { algo: 'pagerank', resultColumn: 'score' },
  personalized_pagerank: { algo: 'personalizedPagerank', resultColumn: 'score' },
  connected_components: { algo: 'connectedComponents', resultColumn: 'componentId' },
  strongly_connected_components: {
    algo: 'stronglyConnectedComponents',
    resultColumn: 'componentId',
  },
  on_cycle: { algo: 'onCycle', resultColumn: 'onCycle' },
  label_propagation: { algo: 'labelPropagation', resultColumn: 'label' },
  peer_pressure: { algo: 'peerPressure', resultColumn: 'cluster' },
  degree: { algo: 'degree', resultColumn: 'degree' },
  betweenness: { algo: 'betweenness', resultColumn: 'centrality' },
  closeness: { algo: 'closeness', resultColumn: 'centrality' },
  shortest_path: { algo: 'shortestPath', resultColumn: 'distance' },
  neighbor_aggregate: { algo: 'neighborAggregate', resultColumn: 'vector' },
};

export const procedureSpec = (name: string): { algo: AlgorithmName; resultColumn: string } | null =>
  PROCEDURES[name] ?? null;

/**
 * For an unknown procedure name, the canonical snake_case name it most likely
 * meant — matched by ignoring case and `_` separators, so a camelCase spelling
 * (`pageRank`, `connectedComponents`) resolves to its surface name. `null` when
 * nothing plausibly matches.
 *
 * THERE IS NO NATIVE TWIN, and the engines' messages DIFFER — measured at item 614:
 *
 *   CALL pageRank()  ts     -> unknown procedure: pageRank (did you mean 'pagerank'?)
 *                    native -> lenke: query: unknown procedure `pageRank`
 *
 * Both REJECT the same queries, so this is a DX gap and a message-text difference, not a
 * wrong answer — the same class as the open cast-message divergence. The crate's only
 * suggestion machinery is `algo::edit_distance`, used for CALL CONFIG KEYS
 * (`algo::validate_config`), not for procedure names. (`suggest_procedure` xref:gone.)
 */
export const normProcName = (s: string): string => s.replaceAll('_', '').toLowerCase();

export const suggestProcedure = (name: string): string | null => {
  const target = normProcName(name);

  return Object.keys(PROCEDURES).find((n) => normProcName(n) === target) ?? null;
};

/** The accepted `CALL <algo>({...})` config keys and the value type each expects.
 * Order is fixed so the "did you mean" tie-break matches the native engine. */
export const ALGO_CONFIG_TYPES: ReadonlyArray<
  readonly [string, 'string' | 'number' | 'stringList' | 'boolean']
> = [
  ['edgeLabel', 'string'],
  ['direction', 'string'],
  ['weightProperty', 'string'],
  ['dampingFactor', 'number'],
  ['iterations', 'number'],
  ['pivots', 'number'],
  ['seedProperty', 'string'],
  ['source', 'string'],
  ['sourceNodes', 'stringList'],
  ['target', 'string'],
  ['writeProperty', 'string'],
  ['algorithm', 'string'],
  ['heuristicProperty', 'string'],
  ['feature', 'string'],
  ['op', 'string'],
  ['includeSelf', 'boolean'],
  ['norm', 'string'],
];

/** Case-insensitive Levenshtein edit distance — a plain DP over code points,
 * matching the native `edit_distance` so both engines suggest identically. */
export const editDistance = (a: string, b: string): number => {
  const x = Array.from(a.toLowerCase());
  const y = Array.from(b.toLowerCase());
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  const cur = new Array<number>(y.length + 1);

  for (let i = 0; i < x.length; i++) {
    cur[0] = i + 1;

    for (let j = 0; j < y.length; j++) {
      const cost = x[i] === y[j] ? 0 : 1;
      cur[j + 1] = Math.min(prev[j + 1] + 1, cur[j] + 1, prev[j] + cost);
    }

    prev = cur.slice();
  }

  return prev[y.length];
};

/** For an unknown config key, the closest known key within edit distance 2 (else
 * null). Scans in fixed order so ties resolve to the earliest — identical to native. */
export const suggestConfigKey = (name: string): string | null => {
  let best: string | null = null;
  let bestDist = 3;

  for (const [key] of ALGO_CONFIG_TYPES) {
    const d = editDistance(name, key);

    if (d <= 2 && d < bestDist) {
      best = key;
      bestDist = d;
    }
  }

  return best;
};

/** Set one algorithm-config field from a CALL config-map entry. An unknown key
 * (with a "did you mean" hint) or a wrong-typed value is an error — a silently
 * dropped key once hid the `pivots` bug. Mirrors native `algo::validate_config`, which
 *  checks the same key set (`algo::CONFIG_KEYS`) and types, and shares the "did you mean"
 *  via `algo::edit_distance`. */
export const applyAlgoConfig = (cfg: AlgorithmConfig, key: string, v: unknown): void => {
  const spec = ALGO_CONFIG_TYPES.find(([k]) => k === key);

  if (spec === undefined) {
    const s = suggestConfigKey(key);

    throw new LenkeError(
      s ? `unknown config key '${key}' (did you mean '${s}'?)` : `unknown config key '${key}'`,
      { code: ErrorCode.InvalidValue },
    );
  }

  const [, expected] = spec;
  const okByType: Record<typeof expected, boolean> = {
    string: typeof v === 'string',
    number: typeof v === 'number',
    stringList: Array.isArray(v),
    boolean: typeof v === 'boolean',
  };

  if (!okByType[expected]) {
    const label = expected === 'stringList' ? 'a list' : `a ${expected}`;

    throw new LenkeError(`config key '${key}' expects ${label}`, { code: ErrorCode.InvalidValue });
  }

  (cfg as Record<string, unknown>)[key] =
    expected === 'stringList' ? (v as unknown[]).filter((x) => typeof x === 'string') : v;
};

/**
 * `[OPTIONAL] CALL name(config) YIELD …`: run the algorithm once (uncorrelated),
 * then cross-join its rows into the binding stream, binding each yielded column.
 * OPTIONAL keeps the outer row (null-filled) when the procedure yields nothing.
 */
export const runCall = (
  graph: Graph,
  clause: CCallNamed,
  bindings: Iterable<Binding>,
  params: Params,
): Iterable<Binding> => {
  if (!clause.algo) {
    const suggestion = suggestProcedure(clause.procName);
    const msg = suggestion
      ? `unknown procedure: ${clause.procName} (did you mean '${suggestion}'?)`
      : `unknown procedure: ${clause.procName}`;

    throw new LenkeError(msg, { code: ErrorCode.Unsupported });
  }

  const config: AlgorithmConfig = {};
  const scratch: Binding = new Map();

  for (const c of clause.config) {
    applyAlgoConfig(config, c.key, c.value({ binding: scratch, params, graph }));
  }

  const rows = runAlgorithmSync(clause.algo, config, graph) as Array<Record<string, unknown>>;

  // Validate the YIELD columns against what the procedure actually exposes: a
  // vertex handle as `node`, plus its single result column. Anything else is an
  // error — previously an undeclared column (`YIELD nodeId`, or any typo) bound
  // silently to `undefined`, so the query returned rows with that column simply
  // missing. A silent wrong answer, and a divergence: native raises
  // E_INVALID_VALUE here. Checked after the algorithm runs, mirroring native, so a
  // `writeProperty` side effect lands identically on both engines.
  const resultColumn = procedureSpec(clause.procName)?.resultColumn;

  for (const bind of clause.binds) {
    if (bind.column !== 'node' && bind.column !== resultColumn) {
      throw new LenkeError(
        `procedure \`${clause.procName}\` has no output column \`${bind.column}\``,
        { code: ErrorCode.InvalidValue },
      );
    }
  }

  // Materialize the outer bindings first: the call may write a property, and the
  // outer stream must be read against the pre-write graph.
  const outer = toArray(bindings);
  // Resolved ONCE for the clause, not once per bind per row.
  const binds = clause.binds.map((bind) => ({
    var: bind.var,
    column: bind.column,
    isNode: bind.column === 'node',
  }));

  return flatMap((binding: Binding) => {
    if (rows.length === 0 && clause.optional) {
      const b = new Map(binding);

      for (const bind of clause.binds) {
        b.set(bind.var, null);
      }

      return [b];
    }

    // ⚠️ `new Map(binding)` MUST OBTAIN AN ITERATOR AND STEP IT EVEN WHEN `binding` IS EMPTY, so
    // it allocates a Map *and* an iterator per row where a fresh Map allocates one object. Measured
    // over 2,000,000 constructions: `new Map()` 32.8-37.8 ms against `new Map(emptyMap)` 85.8-93.0
    // — **2.5x**. A leading `CALL` (the common shape: `CALL degree() RETURN …`) has exactly one
    // outer binding and it is empty, and a whole-graph procedure returns one row per vertex, so
    // this is paid 200,000 times on a 200,000-vertex graph.
    //
    // Item 1471 profiled `CALL degree() RETURN count(*)` at 200,000 vertices: this callback 30.12%
    // and `(garbage collector)` 23.86%, against ~31% for the procedure itself. Halving the
    // per-row allocation count is aimed at the GC term, not at the callback.
    const copyOuter = binding.size !== 0;

    return rows.map((r) => {
      // `Binding` is a `ReadonlyMap`, so the mutable local is typed as the concrete Map it is.
      const b = copyOuter ? new Map(binding) : new Map<string, unknown>();

      for (const bind of binds) {
        // `node` binds as the live Vertex handle (so it hydrates only when
        // actually returned whole, and `node.name` / further MATCH work);
        // mirrors native's `Val::Node`. Other columns are the raw value.
        //
        // `isNode` is hoisted: which of the two a bind reads is a property of the CLAUSE, and it
        // was re-tested once per bind per row.
        const value = bind.isNode ? graph.verticesById.get(r.node as string) : r[bind.column];

        b.set(bind.var, value);
      }

      return b;
    });
  }, outer);
};

/**
 * `[OPTIONAL] CALL (scope) { … }`: run the nested query once per outer row
 * (correlated / lateral), seeding it with only the imported scope variables, and
 * merge the nested RETURN columns back — duplicating the outer row per nested row.
 * OPTIONAL keeps the outer row (nested columns null-filled) when the subquery is
 * empty; a non-OPTIONAL empty subquery drops the outer row.
 */
/**
 * Clause kinds that cannot change the graph or any side-effect state, so a subquery built only from
 * them answers the same thing however many times it runs.
 *
 * ⚠️ AN ALLOWLIST, because the cost of being wrong is asymmetric: a missed read-only kind loses an
 * optimization, while a missed MUTATING kind would run a write ONCE where ISO runs it per outer row.
 * `insert`, `set`, `remove`, `delete` and `merge` all write; `callNamed` invokes a procedure that
 * may; `for` and `finish` are left out for no reason beyond not having reasoned them through.
 *
 * ⚠️ `CLinear.writes` IS NOT A SUBSTITUTE, though it looks like one. It is `clauses.some(c =>
 * WRITE_CLAUSES.has(c.kind))` over ONE level, and its own doc says pushing it inward would be
 * wrong for the transaction question it exists for — so it reports `false` for a body containing a
 * nested `CALL { INSERT … }`, and `WRITE_CLAUSES` does not list `callNamed` at all. Hoisting on
 * that flag would turn N inserts into one.
 */
const READ_ONLY_CLAUSE_KINDS: ReadonlySet<string> = new Set([
  'match',
  'filter',
  'let',
  'with',
  'page',
  'return',
]);

/** Is every clause in this body read-only, recursing into nested inline CALLs? */
const bodyIsReadOnly = (linear: CLinear): boolean =>
  linear.clauses.every((c) =>
    c.kind === 'callInline'
      ? bodyIsReadOnly(c.body) && c.bodyMore.every((m) => bodyIsReadOnly(m.part))
      : READ_ONLY_CLAUSE_KINDS.has(c.kind),
  );

export const runCallInline = (
  graph: Graph,
  clause: CCallInline,
  bindings: Iterable<Binding>,
  params: Params,
): Iterable<Binding> => {
  /**
   * ⚠️ AN EMPTY SCOPE MAKES THE BODY LOOP-INVARIANT, so it runs ONCE rather than once per outer row
   * (item 1566). `CALL { … }` with no scope list is NON-CORRELATED by ISO design — the subquery
   * cannot see the outer row at all, which is the scope isolation the form exists for — so every
   * iteration computes the identical rows. It is directly observable:
   *
   *     MATCH (n:P) CALL { MATCH (n)-[:E]->(x) RETURN count(*) AS c } RETURN n.n AS nn, c
   *       6 vertices of degree 1  ->  c = 6 for EVERY row     (the inner `n` is a FRESH variable)
   *     MATCH (n:P) CALL (n) { … }  (the correlated form)
   *       the same graph           ->  c = 1 for every row     (the outer `n`)
   *
   * That identical `c` is the invariance. Without the hoist an O(N) body ran N times: measured
   * 1430.9 ms at N=1000 against 0.6 ms for the correlated spelling, and rising linearly per row.
   *
   * ⚠️ READ-ONLY IS REQUIRED, not incidental. `CALL { INSERT … }` with no scope is still run once
   * per outer row by ISO and inserts N times; hoisting it would insert once. Hence the allowlist.
   *
   * ⚠️ AND IT IS COMPUTED LAZILY, inside the closure. An eager computation would run the body even
   * when the outer query produced NO rows, which changes both the cost and when a body fault
   * surfaces.
   */
  const invariant =
    clause.scope.length === 0 &&
    bodyIsReadOnly(clause.body) &&
    clause.bodyMore.every((m) => bodyIsReadOnly(m.part));
  let hoisted: Row[] | undefined;
  /**
   * ⚠️ THE HOISTED ROWS' ENTRIES, MATERIALIZED ONCE — item 1818. The hoist above stops the BODY
   * running per outer row; it does not stop the row-to-binding projection below rebuilding
   * `Object.entries(row)` for each outer row, over row objects that by invariance are the SAME
   * objects every time. Measured on `MATCH (n:P) CALL { MATCH (a:P)-[:E]->(x:P) RETURN count(*) }`
   * at 20,000 outer rows, where the body is already one cached row: the whole shape cost 12.01 ms
   * against a 0.81 ms single-outer-row floor, i.e. ~550 ns an outer row of pure plumbing on a
   * route whose remaining work is one map copy and one `set`.
   *
   * ⚠️ The per-row term was confirmed BODY-INDEPENDENT before this was written, which is what
   * identifies it as plumbing rather than body cost: holding the outer count at 20,000 and making
   * the body cheaper (`MATCH (a:P) RETURN count(*)`) moved it only 12.01 -> 10.71 ms, while holding
   * the body fixed and cutting the outer rows to 207 gave 0.99 ms. See
   * `packages/native/uncorrelated-call-reuse-probe.mjs`, which exists because a TOTAL cannot tell
   * "body ran once, plumbing is expensive" from "body ran per row behind a fast rung", and neither
   * can the profile — a body run once still shows `matchPattern` and `seedVertices` frames, just
   * with a small share of a large total.
   */
  let hoistedPairs: readonly (readonly [string, unknown])[][] | undefined;

  return flatMap((outer: Binding) => {
    let nested: Row[];

    if (invariant && hoisted !== undefined) {
      nested = hoisted;
    } else {
      /**
       * ⚠️ THE SEED MAP IS NOW ALLOCATED ONLY WHEN A SCOPED NAME IS ACTUALLY PRESENT (item 1818).
       * It used to be a `new Map()` per outer row unconditionally, including on the hoisted path
       * where `clause.scope.length === 0` guarantees nothing is ever put in it — an allocation per
       * outer row to hand `undefined` to `runLinearClauses` anyway.
       *
       * `seed === undefined` is EXACTLY the old `seed.size === 0`, so `start` is unchanged: the
       * map is created on the first `set` and only there. That equivalence is the whole reason
       * this is safe, and it also reaches the scoped path whose names are all absent from the
       * outer row — the case item 1661's gate was already written for.
       */
      let seed: Map<string, unknown> | undefined;

      for (const v of clause.scope) {
        if (outer.has(v)) {
          (seed ??= new Map<string, unknown>()).set(v, outer.get(v));
        }
      }

      /**
       * ⚠️ AN EMPTY SEED IS PASSED AS `undefined`, NOT AS AN EMPTY MAP, AND THAT IS THE WHOLE
       * OPTIMIZATION (item 1661). `runLinearClauses` starts from `[initial ?? new Map()]`, so an
       * empty Map and `undefined` are the same start — but its FAST-PATH GATE is
       * `if (initial === undefined)`, because the rungs assume an empty start. Handing it an empty
       * Map therefore disqualified every inline-CALL body from `fastPath` for no reason at all,
       * including bodies with no scope, where there is no imported binding for a rung to be wrong
       * about.
       *
       * The gate is whether a scoped name was actually PRESENT, not `clause.scope.length`: a scope
       * whose names are all absent from the outer row imports nothing, and that row's body
       * deserves the rungs too. Item 1818 turned that gate from `seed.size === 0` into "the map was
       * never created", which is the same condition with the allocation removed.
       *
       * Measured at item 1661: an unscoped `CALL { MATCH … RETURN count(*) }` over 20,000 outer
       * rows went **34.9 -> 9.6 ms, 3.6x**, because the body's one hoisted run now takes the
       * closed-form count rung instead of materialising 39,990 edges. A SCOPED body still takes
       * the general loop and is unaffected — a separate and much harder target, priced in the
       * same item.
       *
       * ⚠️ COMPUTED INSIDE THE `else`, not above the branch. On the hoisted path there is no body
       * run to seed, so computing it there would add work to every outer row after the first and
       * buy nothing — on exactly the shape this change helps least.
       */
      const start = seed;

      nested = runLinearClauses(clause.body, graph, params, start && new Map(start));

      // Fold in any set-op parts (`… UNION/EXCEPT/INTERSECT …`), each run against
      // the same seed, matching the top-level set-op semantics.
      for (const { op, part } of clause.bodyMore) {
        nested = combineRows(
          op,
          nested,
          runLinearClauses(part, graph, params, start && new Map(start)),
        );
      }

      if (invariant) {
        hoisted = nested;
        hoistedPairs = nested.map((row) => Object.entries(row));
      }
    }

    if (nested.length === 0 && clause.optional) {
      const b = new Map(outer);

      for (const col of clause.returnColumns) {
        b.set(col, null);
      }

      return [b];
    }

    /**
     * ⚠️ A SEPARATE TAIL FOR THE HOISTED PATH, rather than one tail that computes its pairs either
     * way (item 1818). Folding the two would put an extra array allocation per outer row on the
     * CORRELATED path, which is the path that does not benefit — and `executor-edits-perturb`
     * records that a new variant costs unrelated shapes up to 16%, so the general tail below is
     * left byte-identical and the new code is reachable only when `hoistedPairs` is set.
     *
     * `hoistedPairs` is non-undefined exactly when `nested === hoisted`, so this emits the same
     * bindings the general tail would: same rows, same insertion order per row (`Object.entries`
     * order, captured once from the same objects), same `new Map(outer)` base.
     */
    if (hoistedPairs !== undefined && nested === hoisted) {
      const out: Binding[] = [];

      for (const pairs of hoistedPairs) {
        const b = new Map(outer);

        for (const [k, val] of pairs) {
          b.set(k, val);
        }

        out.push(b);
      }

      return out;
    }

    return nested.map((row) => {
      const b = new Map(outer);

      for (const [k, val] of Object.entries(row)) {
        b.set(k, val);
      }

      return b;
    });
  }, bindings);
};

export const runFor = (
  graph: Graph,
  clause: CFor,
  bindings: Iterable<Binding>,
  params: Params,
): Iterable<Binding> =>
  flatMap((binding: Binding) => {
    const listv = clause.list({ binding, params, graph });
    let elems: unknown[];

    if (listv === null || listv === undefined) {
      elems = [];
    } else if (Array.isArray(listv)) {
      elems = listv;
    } else {
      elems = [listv];
    }

    return elems.map((elem, i) => {
      const b = new Map(binding);
      b.set(clause.alias, elem);

      if (clause.ordinality) {
        b.set(clause.ordinality.var, clause.ordinality.kind === 'ordinality' ? i + 1 : i);
      }

      return b;
    });
  }, bindings);

export const WRITE_CLAUSES = new Set(['insert', 'merge', 'set', 'remove', 'delete']);

/** Does a query mutate the graph (contain any INSERT/MERGE/SET/REMOVE/DELETE)? */
export const queryHasWrite = (query: Query): boolean =>
  query.parts.some((part) => part.clauses.some((clause) => WRITE_CLAUSES.has(clause.kind)));

/**
 * Execute an ISO GQL transaction-control command (`START TRANSACTION`/`COMMIT`/
 * `ROLLBACK`) by driving the session's transaction frame on the graph. Returns
 * nothing (a write-only shape — no rows/columns). ISO semantics are enforced
 * here, not in the core primitives:
 *  - `START TRANSACTION` while one is already active → `E_INVALID_GRAPH_OP`
 *    (ISO forbids nesting). The graph's tx depth reflects only explicit
 *    transactions here, since a TxControl is not a write and so is never wrapped
 *    in a per-statement auto-commit frame.
 *  - `COMMIT`/`ROLLBACK` with no active transaction → `E_INVALID_GRAPH_OP`. The
 *    depth is checked in the executor so ROLLBACK is symmetric with COMMIT
 *    *without* changing the core `rollbackTransaction`'s idempotent contract.
 *  - The READ ONLY access mode is recorded on the graph (and cleared on
 *    commit/rollback); a subsequent write statement consults it (see `execute`).
 */
export const runTxControl = (tx: TxControl, graph: Graph): void => {
  switch (tx.kind) {
    case 'start':
      if (graph.isTransacting()) {
        throw new LenkeError('START TRANSACTION: a transaction is already active', {
          code: ErrorCode.InvalidGraphOp,
        });
      }

      graph.beginTransaction();
      graph.setTransactionReadOnly(tx.accessMode === 'read only');
      break;
    case 'commit':
      if (!graph.isTransacting()) {
        throw new LenkeError('COMMIT: no active transaction', { code: ErrorCode.InvalidGraphOp });
      }

      try {
        graph.commitTransaction(); // may throw (deferred checks) after rolling back
      } finally {
        graph.setTransactionReadOnly(false);
      }

      break;
    case 'rollback':
      if (!graph.isTransacting()) {
        throw new LenkeError('ROLLBACK: no active transaction', { code: ErrorCode.InvalidGraphOp });
      }

      graph.rollbackTransaction();
      graph.setTransactionReadOnly(false);
      break;
  }
};

/**
 * Run one compiled linear query (clause sequence) to result rows. A statement
 * that writes runs inside one transaction, so a mid-statement fault (e.g. a
 * later row of a multi-row INSERT violating a constraint) rolls the earlier rows
 * back instead of leaving the write half-applied — per-statement atomicity,
 * byte-identical to the native engine's auto-commit frame. Read-only statements
 * skip the frame (no undo/commit overhead).
 */
/**
 * A rung that can only decide at RUN time: call it if present, and pass its answer through only when it
 * did not decline.
 *
 * ⚠️ Hoisted purely to keep the chain under its `complexity` cap (35) — adding item 2151's rung inline
 * took it to 37. 🔑 The two-step `if` reads the same either way; what it must NOT become is a `??`, which
 * would conflate "declined" with "answered `undefined`".
 */
const lateRungRow = (
  rung: ((graph: Graph, params: Params) => Row[] | undefined) | null,
  graph: Graph,
  params: Params,
): Row[] | undefined => (rung === null ? undefined : rung(graph, params));

export const runLinear = (linear: CLinear, graph: Graph, params: Params): Row[] => {
  // ⚠️ READ, NOT COMPUTED (item 1510). `CLinear.writes` is settled by `compileLinear`; this used
  // to be `linear.clauses.some((c) => WRITE_CLAUSES.has(c.kind))` on every call, which is a
  // closure allocation plus a `Set` lookup per clause to re-derive a property of the compiled
  // query. 14.7% of an 82 ns `RETURN 1 AS v`.
  if (!linear.writes) {
    return runLinearClauses(linear, graph, params);
  }

  return graph.transaction(() => runLinearClauses(linear, graph, params));
};

/**
 * The fast-path ladder, in order. Returns `undefined` when every detector declined and the
 * general clause loop must run.
 *
 * Extracted from `runLinearClauses` because adding the eighth rung (`nodeProjection`, audit item
 * 204) took that function to a complexity of 36 against a limit of 35. The ladder is the natural
 * seam: it is a flat sequence of independent "did this detector claim the query?" tests, so
 * pulling it out costs nothing in indirection and leaves `runLinearClauses` to be about the
 * streaming loop.
 *
 * ORDER IS LOAD-BEARING. Each rung is more specific than the ones below it, and two pairs
 * actually depend on that: `distinctProjection` must precede `nodeProjection` (which does not
 * dedupe), and `countShortcut` must precede everything (it never materializes a row at all).
 *
 * ⚠️ DECLINED, WITH ITS NUMBERS (item 1511): gating this whole ladder on a construction-time
 * `CLinear.hasFastPath` ("does ANY of the nineteen rungs exist for this shape?"), so a query no
 * detector claims skips all nineteen `!== null` tests. The ladder is 9.2% of a 78 ns
 * `RETURN 1 AS v`, and the gate works — it just does not pay for itself. One arm per process,
 * median of three runs each:
 *
 * ```text
 *   arm      PRE      POST    ratio
 *   floor   77.8 ns  72.2 ns  1.08x   RETURN 1 AS v        — no rung
 *   param   89.0     81.4     1.09x   RETURN $x AS v       — no rung
 *   one     35.6     36.1     0.99x   RETURN count(*)      — HAS a rung
 *   onerow 106.2    107.4     0.99x   RETURN n.k           — HAS a rung
 *   ten     36.1     36.2     flat
 *   insert 3981     3900      1.02x   a 4 us call cannot see 6 ns
 * ```
 *
 * So: 7-9% on the bare-RETURN family, and ~1% WORSE on `count(*)` and the node projection, which
 * pay one extra property load to reach a rung they were always going to reach. Those are the more
 * central shapes, both margins sit inside the run-to-run bands, and it would add a THIRD scalar
 * field to `CLinear` — each one of which has to be registered in `routes-fired`'s `NON_DETECTORS`
 * (item 1510 learned that by breaking five test files). Not worth it for a win confined to queries
 * with no MATCH.
 *
 * ⚠️ AND THE IN-SWEEP READING OF THAT A/B SAID THE OPPOSITE. Run as one multi-arm process, `one`
 * measured 1.10x FASTER rather than 1% slower — because in the PRE arm this function sees both
 * rung-having and rung-less shapes, and in the POST arm only rung-having ones, so its inline caches
 * are cleaner. Item 762's redistribution trap, and the giveaway was exactly the one it names: a
 * control moving more than the target.
 */
const fastPath = (linear: CLinear, graph: Graph, params: Params): Row[] | undefined => {
  // Direct `count(*)` shortcut (edge-bucket size / degree product) — skips
  // enumerating every match. Only fires for the exact `MATCH … RETURN count(*)`
  // shapes `detectCountShortcut` accepts.
  // Item 573's degree algebra sits ABOVE `countShortcut`, which cannot answer a quantified hop
  // at all (`plainRel` is false for one), so the order is not a priority contest — it is the
  // only rung that matches this shape.
  // ⚠️ THE ONLY RUNG THAT MAY DECLINE AT RUNTIME (item 1399), and the ladder already had the
  // mechanism: this function's contract is "returns `undefined` when every detector declined and
  // the general clause loop must run", so falling through is what the other rungs do by not
  // existing. `varLengthCount` cannot decide at COMPILE time whether a depth-4 trail's endpoint
  // label is vacuous — vacuity is a property of the graph — so it is admitted and declines here
  // when the label really filters. See `depth4Admissible`.
  const varLength = lateRungRow(linear.varLengthCount, graph, params);

  if (varLength !== undefined) {
    return varLength;
  }

  /*
   * ITEM-2151-SHORTEST-COUNT: `ANY SHORTEST`/`ANY` + `count(*)` from the BFS's distance map.
   *
   * 🔑 PLACED HERE, BESIDE `varLengthCount`, because it answers the same KIND of question (a quantified
   * walk's `count(*)`) on a disjoint set of shapes: that rung refuses any selector, this one requires
   * `any`/`anyShortest`. ⚠️ Neither can steal the other's shape, so the order between them is free —
   * written after it only for reading.
   *
   * ⚠️ Without this the shape falls through to the general matcher, where a windowed profile put
   * `withBinding` at 34.4% self against the BFS's own 6.9%: five times the walk's cost spent building a
   * row per endpoint that `count(*)` then discards.
   */
  const shortest = lateRungRow(linear.shortestEndpointCount, graph, params);

  if (shortest !== undefined) {
    return shortest;
  }

  const starCount = chainStarCountOrCountShortcut(linear, graph, params);

  if (starCount !== undefined) {
    return starCount;
  }

  // The OPTIONAL-hop count (item 510). Below the plain one because it is strictly narrower —
  // three clauses with the middle one optional — and never competes with it for a shape.
  /*
   * ⚠️ ABOVE the ungrouped rung (item 2123) and the two cannot compete: `optionalGroupedHopCount` needs
   * a TWO-item projection (`a.k, count(*)`) and `optionalHopCount` a bare `count(*)`, so the shapes are
   * disjoint by construction and either order answers the same queries. It sits here because the
   * narrower gate reads first.
   */
  const optCounts = optionalHopCounts(linear, graph, params);

  if (optCounts !== undefined) {
    return optCounts;
  }

  // A constant `FOR` over a counted query: the base count times the list length (item 515).
  if (linear.forCount) {
    return linear.forCount(graph, params);
  }

  // The `FOR` PROJECTION off the label bucket (item 528). Below `forCount`, which owns the
  // aggregate form — the two are mutually exclusive (this one refuses an aggregating
  // projection), so the order is for reading rather than for correctness.
  if (linear.forProjection) {
    return linear.forProjection(graph, params);
  }

  // The OPTIONAL-hop PROJECTION (item 511) — one row per match, or one null-filled row.
  // The OPTIONAL-hop pair, unordered first (item 1849). `??` keeps the same precedence two `if`s
  // would, in ONE branch: the ordered rung is strictly narrower — it requires a sort — so the two
  // never claim the same shape, and collapsing them keeps this function under the complexity gate
  // that adding a twenty-ninth rung otherwise breaks.
  const optional = linear.optionalHopProjection ?? linear.optionalOrderedProjection;

  if (optional) {
    return optional(graph, params) ?? undefined;
  }

  // Grouped `count(*)` off the label bucket — many rows, so its own hook. See
  // `detectGroupedNodeCount`.
  if (linear.groupCountShortcut) {
    return linear.groupCountShortcut(graph, params);
  }

  // The same over a hop — one pass over the start vertices adding each one's degree to its
  // group, or one pass over the edge bucket. See `detectGroupedHopCount`.
  if (linear.groupHopShortcut) {
    return linear.groupHopShortcut(graph, params);
  }

  // Unbounded var-length + DISTINCT → BFS the reachable set instead of enumerating
  // trails (exponential, hits the trail budget). See `detectReachableShortcut`.
  if (linear.reachShortcut) {
    return linear.reachShortcut(graph, params);
  }

  // A 1-hop projecting only the far endpoint: walk the hop and build rows directly,
  // with one reused binding and no generator stack. See `detectHopProjection`.
  if (linear.hopProjection) {
    // `null` is a DECLINE, not an empty result: the fast path discovered at execution time
    // that the general loop has a better plan (an index seek on the end it does not drive).
    const rows = linear.hopProjection(graph, params);

    if (rows !== null) {
      return rows;
    }
  }

  /**
   * A TWO-segment pattern projecting rows: the nested walk (item 1619). It sits AFTER the one-hop
   * branch for `rung-precedence-decides-speed`'s reason — a rung placed above a narrower one starves
   * it — and the two are disjoint by construction, since `detectHopProjection` requires
   * `segments.length === 1` and this one requires 2. Placing it here also means a one-hop plan pays
   * one extra null check and nothing more, which the controls confirm is flat.
   */
  /**
   * ⚠️ THIS BRANCH IS NOT PINNED BY ANY TEST, and that is true of all twenty-one rungs rather than of
   * this one. `routes-fired.test.ts` asserts that each DETECTOR fires for its shape — which is what
   * catches a compile-time regression — but removing the branch that CONSUMES it is
   * answer-equivalent and the whole suite passes. Item 1619 checked whether row ORDER could
   * distinguish the two paths and it cannot: the rung and the general matcher emit the identical
   * sequence on a five-row fixture, so there is nothing to assert that is not a timing test.
   * `perf-gate-needs-its-own-test`'s remedy is to extract the arithmetic as a pure function, and
   * here there is no arithmetic. Recorded rather than papered over.
   */
  /*
   * ⚠️ FALLS THROUGH ON `null` (item 2104): this rung DECLINES AT EXECUTION TIME when `orient` says
   * the generic matcher would seed from the other end of the pattern. Measured at 59x — a vacuous
   * `LIMIT`, which defeated the rung's length gate, made the query 25.56 ms -> 0.43.
   */
  /*
   * ⚠️⚠️ **ABOVE `hop2Projection` DELIBERATELY, AND THAT IS THE ONLY PRECEDENCE CHANGE HERE (item 2119).**
   * `hop2Projection` claims `RETURN DISTINCT <far>.<k>` over a two-hop chain and costs **517.5 ms where
   * the `count(DISTINCT)` twin costs 18.8 on the same 97 values** — 27x to do strictly less, because the
   * count had the level recurrence and the row spelling did not.
   *
   * 🔑 A NARROW GATE ABOVE A BROAD RUNG is item 1583's own fix shape. ⚠️ The risk item 418 names — a
   * branch ahead of a hot dispatch costing the shape it does NOT claim 1.12x — is why
   * `detectChainDistinctLevels` refuses a second column, an aggregate, `ORDER BY`, `SKIP`, `LIMIT`, and
   * any item reading a variable other than the far one.
   */
  if (linear.chainDistinctLevels) {
    return linear.chainDistinctLevels(graph, params);
  }

  const h2 = declinableRung(linear.hop2Projection, graph, params);

  if (h2 !== undefined) {
    return h2;
  }

  /**
   * THREE OR MORE segments, the same walk one level deeper (item 1814).
   *
   * ⚠️ ITS POSITION IS FOR READING, NOT FOR CORRECTNESS OR COST, and the two rungs cannot compete:
   * `detectChainProjection` requires `segments.length >= 3` and `detectHop2Projection` requires
   * exactly 2, so the shapes are disjoint by construction and either order answers the same
   * queries. It sits here because that is where a reader looks for it. The branch itself is not
   * free — item 418 measured a branch ahead of a hot dispatch costing the shape it does not claim
   * 1.12x — which is why it goes BELOW both hop rungs rather than above them.
   */
  /*
   * ⚠️ FALLS THROUGH ON `null` (item 2105): this rung DECLINES AT EXECUTION TIME when the far node
   * carries a genuine index seek. Measured **934x** — a vacuous `LIMIT`, which defeated the rung's
   * length gate, made a three-hop row projection 2129.12 ms -> 2.28. The largest of the two.
   */
  const chain = declinableRung(linear.chainProjection, graph, params);

  if (chain !== undefined) {
    return chain;
  }

  const reduced = deepWidthReductions(linear, graph, params);

  if (reduced !== undefined) {
    return reduced;
  }

  /**
   * The same two rungs under `ORDER BY <output columns>` — item 1827.
   *
   * ⚠️ DISJOINT FROM EVERY PROJECTION RUNG ABOVE, not merely ordered after them: those gate on
   * `plainRowProjectionIgnoringDistinct`, which refuses an `orderBy`, and these two REQUIRE one. So
   * no ordering between them can starve anything — the lesson item 1825 learned by writing an
   * untestable precedence dependency and having a mutant walk through it.
   *
   * ⚠️ `null` IS A DECLINE, passed through from `sortedRows`: the walk it wraps can hand the query
   * back per call, and answering that with `[]` would be rows missing rather than a slower route.
   */
  if (linear.chainOrderedProjection) {
    const rows = linear.chainOrderedProjection(graph, params);

    if (rows !== null) {
      return rows;
    }
  }

  if (linear.hop2OrderedProjection) {
    const rows = linear.hop2OrderedProjection(graph, params);

    if (rows !== null) {
      return rows;
    }
  }

  const paged = pagedWidthProjections(linear, graph, params);

  if (paged !== undefined) {
    return paged;
  }

  // The same walk under ONE foldable aggregate — `RETURN max(b.k)` — folded as the rows are
  // produced. It delegates to `detectHopProjection`'s walk, so it sits AFTER that branch: the
  // two shapes are disjoint (a projection declines an aggregating one), and placing it FIRST
  // cost the plain hop projection 1.12x on three alternated rounds for nothing but the extra
  // branch ahead of it. See `detectHopAggregate`.
  if (linear.hopAggregate) {
    // `null` is a DECLINE for the same reason it is above: the walk it delegates to can find at
    // execution time that an index seek on the end it does not drive beats it.
    const rows = linear.hopAggregate(graph, params);

    if (rows !== null) {
      return rows;
    }
  }

  // The same walk under TWO OR MORE foldable aggregates — `RETURN count(*), max(b.k)`.
  // Disjoint from the rung above by ARITY, and placed after it for the reason item 418
  // measured: a branch ahead of a hot dispatch costs the shape it does not claim. See
  // `detectMultiHopAggregate`.
  if (linear.multiHopAggregate) {
    const rows = linear.multiHopAggregate(graph, params);

    if (rows !== null) {
      return rows;
    }
  }

  /**
   * The node-scan `DISTINCT` pair, one-column first.
   *
   * `distinctProjection` dedupes by the projected VALUE while walking, so a duplicate costs
   * neither a row object nor a row key (`detectDistinctProjection`). `nodeDistinctProjection`
   * (item 1853) is its MULTI-column sibling, which builds rows and dedupes them with the shared
   * `distinctRows`. The two are DISJOINT by column count, so `??` only decides which is present —
   * it cannot change which shapes are answered. Collapsing them into one branch is what keeps this
   * function under the complexity gate that a thirtieth rung otherwise breaks.
   *
   * No decline branch: both closures always answer (`AlwaysRowsFn`).
   */
  const nodeDistinct = linear.distinctProjection ?? linear.nodeDistinctProjection;

  if (nodeDistinct) {
    return nodeDistinct(graph, params);
  }

  /**
   * One hop under `RETURN DISTINCT <SEVERAL columns>` — item 1825.
   *
   * ⚠️ ITS POSITION IS FOR READING, NOT FOR CORRECTNESS OR COST. `detectHopDistinctProjection`
   * requires TWO OR MORE columns and `distinctProjection` serves exactly one, so the two cannot
   * both accept a shape and either order answers the same queries. That disjointness is deliberate:
   * the first cut accepted one column as well and depended on sitting here, which is the
   * `rung-precedence-decides-speed` dependency — and an UNTESTABLE one, since
   * `routes-fired.test.ts` reports which detectors fired rather than which branch won, and both
   * routes return the same answer.
   */
  if (linear.hopDistinctProjection) {
    // `null` is a DECLINE, not an empty result — the delegated rung can find at execution time that
    // an index seek on the end it does not drive beats it. See `detectHopProjection`.
    const rows = linear.hopDistinctProjection(graph, params);

    if (rows !== null) {
      return rows;
    }
  }

  // `RETURN count(DISTINCT <one expr>)`: the SIZE of that same dedup, counted while walking.
  if (linear.distinctCount) {
    return linear.distinctCount(graph, params);
  }

  // `MATCH (n:L) WHERE <row-local pred> RETURN <row-local items>`: the plainest scan there is,
  // and the last shape in this ladder to get a path. One reused binding for the whole scan,
  // and a row object only for survivors. See `detectNodeProjection`.

  if (linear.nodeProjection) {
    return linear.nodeProjection(graph, params);
  }

  const scanAgg = scanAggregates(linear, graph, params);

  if (scanAgg !== undefined) {
    return scanAgg;
  }

  return undefined;
};

/**
 * The four REDUCING rungs at two and three-plus segments — items 1824, 1830 and 1832.
 *
 * ⚠️ EXTRACTED BECAUSE LINT SAID SO, AND THAT WAS THE RIGHT SIGNAL. Adding these took `runLinear`
 * to a cyclomatic complexity of 37 against a limit of 35 — the rung chain outgrowing its budget
 * one branch at a time, which is exactly the accumulation `executor-edits-perturb` warns about from
 * the other direction. Raising the limit would have hidden it; this keeps the chain readable and
 * leaves the budget meaningful for whoever adds the next rung.
 *
 * ⚠️ ORDER IS PRESERVED EXACTLY, and it has to be: these are called at the point the four branches
 * occupied, in the order they occupied it. They are mutually disjoint by construction (a folded
 * aggregate needs `foldedAggs`; a grouped count needs `countedGroups` with one key), so no ordering
 * between THEM can starve anything — but their position relative to the plain projection rungs
 * above is `rung-precedence-decides-speed` territory and is unchanged.
 *
 * `undefined` means "none of these claimed it", which is distinct from a rung answering with no
 * rows: every one of them is an `AlwaysRowsFn` and returns a `Row[]`.
 */
/**
 * THE SCAN-AND-HOP AGGREGATE GROUP, extracted from `fastPath` — item 1853.
 *
 * ⚠️ EXTRACTED FOR THE COMPLEXITY GATE, exactly as `deepWidthReductions` was at item 1832 and as
 * `fastPath` itself was at item 204: adding a THIRTIETH rung took `fastPath` to 36 against a limit
 * of 35. The four below are a natural group — all of them aggregate over a scan or a hop — and
 * their ORDER IS PRESERVED EXACTLY, which is the only thing that matters: each comment records a
 * measured reason for sitting where it does (items 418, 469), and reordering them would be a
 * silent cost change rather than a compile error.
 *
 * `undefined` means "none of these claimed it", distinct from a rung answering with no rows.
 */
const scanAggregates = (linear: CLinear, graph: Graph, params: Params): Row[] | undefined => {
  // The scan under ONE foldable aggregate — `RETURN max(n.k)` — folded as the rows are produced.
  // It sits AFTER the projection it delegates to, for the reason item 418 measured on the hop
  // twin: a branch placed ahead of a hot dispatch cost the plain projection 1.12x, and the two
  // shapes are disjoint anyway (a projection declines an aggregating one).
  if (linear.nodeAggregate) {
    return linear.nodeAggregate(graph, params);
  }

  // The same scan under TWO OR MORE aggregates — `RETURN sum(n.k), count(*)`. Disjoint from the
  // rung above by ARITY, and placed after it for the reason items 418 and 469 both measured: a
  // branch ahead of a hot dispatch costs the shape it does not claim.
  if (linear.multiNodeAggregate) {
    return linear.multiNodeAggregate(graph, params);
  }

  // A GROUPED scan aggregate the `count(*)` tally cannot take — `RETURN n.k, max(n.j)`. Below the
  // tally (`groupCountShortcut`), which is more specific and cheaper for its own shape.
  if (linear.groupedNodeAggregate) {
    return linear.groupedNodeAggregate(graph, params);
  }

  // The same over a HOP, below the hop tally for the same reason.
  if (linear.groupedHopAggregate) {
    return linear.groupedHopAggregate(graph, params);
  }

  return undefined;
};

/**
 * The two deep projection rungs under a SKIP-ONLY, UNORDERED page — item 1885.
 *
 * ⚠️ EXTRACTED FOR THE COMPLEXITY GATE, as `deepWidthReductions` below it was: written inline,
 * these two branches took `fastPath` to **37 against a limit of 35**. Nothing else changed — the
 * order and the decline contract are the ones that were inline.
 *
 * ⚠️ DISJOINT FROM EVERY PROJECTION RUNG, not merely ordered after them: the base rungs gate on
 * `plainRowProjectionIgnoringDistinct`, which refuses a `skip`, and the ORDERED pair REQUIRES an
 * `orderBy` where `skipOnlyPage` refuses one. So no ordering here can starve anything — the lesson
 * item 1825 learned by writing an untestable precedence dependency and having a mutant walk
 * through it.
 *
 * ⚠️ `null` IS A DECLINE passed through from `pagedRows`, the same contract `sortedRows` has: the
 * walk it wraps can hand the query back per call, and answering that with `[]` would be rows
 * missing rather than a slower route. `undefined` here means "no paged rung claimed this".
 *
 * ⚠️⚠️ EXPORTED FOR ONE TEST, AND THE REASON IS A SURVIVING MUTANT. `fastPath`'s own note above
 * records that the branch CONSUMING a rung is pinned by nothing — "removing the branch that
 * consumes it is answer-equivalent and the whole suite passes" — which is true of all the rungs and
 * was true of this pair: a mutant replacing this call with `undefined` passed 92 tests. The route
 * assertions in `routes-fired.test.ts` pin that the DETECTOR fires, never that anything reads it.
 * [[rewrite-composition-is-not-free]]'s rule is to export the composition or the unwired mutant
 * survives, so `paged-width-consumer.test.ts` calls this directly with a synthetic `CLinear`. The
 * other rungs are left as the note above describes them; this is not a claim that the asymmetry is
 * ideal, only that the hole here is cheap to close and was open.
 */
export const pagedWidthProjections = (
  linear: CLinear,
  graph: Graph,
  params: Params,
): Row[] | undefined => {
  if (linear.chainPagedProjection) {
    const rows = linear.chainPagedProjection(graph, params);

    if (rows !== null) {
      return rows;
    }
  }

  if (linear.hop2PagedProjection) {
    const rows = linear.hop2PagedProjection(graph, params);

    if (rows !== null) {
      return rows;
    }
  }

  return undefined;
};

/**
 * The chain `count(*)` rung and `countShortcut`, in that order (item 2087).
 *
 * ⚠️⚠️ **ABOVE `countShortcut`, AND THE FIRST ATTEMPT PUT IT 357 LINES BELOW.** `count(*)` over a
 * labelled chain fell to `countShortcut`'s per-edge tally — **100.57 ms/rep against 19.15 here, 5.25x**
 * — while `count(c.k)`, the query doing strictly MORE work, took 20.51 because it had a level
 * recurrence. The rung was willing the whole time: placed in `deepWidthReductions`, its gate ACCEPTED
 * the shape (verified by an instrumented build printing each gate's inputs) and that function was
 * never entered, because `countShortcut` answers first. Timing alone cannot tell a DECLINED rung from
 * a STARVED one.
 *
 * 🔑 It is safe above `countShortcut` only because it declines at EXECUTION time when every label is
 * vacuous — the case that rung answers better still (`twoHopUnfilteredCsrCount`, 12.57 ms/rep against
 * this one's ~20). That is `varLengthCount`'s pattern, one rung further up, for its reason.
 *
 * ⚠️ HOISTED OUT OF ITS CALLER because adding the branch took that function to a complexity of 36
 * against a cap of 35 — the fifth time this gate has been hit in this file, and the fix is always a
 * module-scope helper rather than a raised cap.
 */
const chainStarCountOrCountShortcut = (
  linear: CLinear,
  graph: Graph,
  params: Params,
): Row[] | undefined => {
  if (linear.chainStarCount) {
    const rows = linear.chainStarCount(graph, params);

    if (rows !== undefined) {
      return rows;
    }
  }

  if (linear.countShortcut) {
    return linear.countShortcut(graph, params);
  }

  return undefined;
};

/**
 * Ask a rung that can DECLINE AT EXECUTION TIME, collapsing its two-step protocol to one call.
 *
 * ⚠️ **IT EXISTS FOR THE COMPLEXITY CAP, AND THAT IS THE SIXTH TIME.** Items 2104 and 2105 gave three
 * rungs an execution-time decline, and each call site is a nested `if` — which took this function to 36
 * against a cap of 35. `bun run lint` is a gate, so the branch gets hoisted rather than the cap raised.
 *
 * 🔑 THE TWO ABSENCES ARE DIFFERENT AND BOTH MAP TO `undefined`: a rung that is `null` at COMPILE time
 * never claimed the shape, and one that returns `null` at RUN time claimed it and then found a better
 * route in the graph. Neither is an answer, so the caller falls through identically — which is why one
 * helper can serve both and why its return type is `Row[] | undefined` rather than `| null`.
 */
const declinableRung = (rung: RowsFn | null, graph: Graph, params: Params): Row[] | undefined => {
  if (rung === null) {
    return undefined;
  }

  return rung(graph, params) ?? undefined;
};

/**
 * The two OPTIONAL-hop count rungs, asked together (item 2123).
 *
 * ⚠️ **HOISTED FOR THE COMPLEXITY CAP, AND THAT IS THE EIGHTH TIME.** Adding the grouped rung's branch
 * took `fastPath` to 36 against a cap of 35. `bun run lint` is a gate, so the branch moves rather than
 * the cap.
 *
 * 🔑 THE TWO CANNOT COMPETE: the grouped rung needs a TWO-item projection (`a.k, count(*)`) and the
 * ungrouped one a bare `count(*)`, so the shapes are disjoint by construction and either order answers
 * the same queries. The narrower gate is asked first because that is how a reader expects to find it.
 */
const optionalHopCounts = (linear: CLinear, graph: Graph, params: Params): Row[] | undefined => {
  if (linear.optionalGroupedHopCount) {
    return linear.optionalGroupedHopCount(graph, params);
  }

  if (linear.optionalHopCount) {
    return linear.optionalHopCount(graph, params);
  }

  return undefined;
};

const deepWidthReductions = (linear: CLinear, graph: Graph, params: Params): Row[] | undefined => {
  /*
   * ⚠️ ABOVE `chainFoldedAggregate`, WHICH ANSWERS THE SAME SHAPES BY WALKING EVERY PATH. This arm
   * is a level recurrence — O(k·(|V| + |E|)) against O(paths) — and measured 234-1515x on its hand
   * ceiling at depths 3 and 4 (item 2009/2010). It is strictly NARROWER (no carried `WHERE`, no
   * relationship variable, no union types, single-name labels), so everything it declines lands on
   * the rung below exactly as before.
   */
  if (linear.chainFoldLevels) {
    return linear.chainFoldLevels(graph, params);
  }

  // ⚠️ Falls through on `null` — the composed walk's execution-time decline (item 2105).
  if (linear.chainFoldedAggregate) {
    const rows = linear.chainFoldedAggregate(graph, params);

    if (rows !== null) {
      return rows;
    }
  }

  // ⚠️ Falls through on `null` — the composed walk's execution-time decline (item 2104).
  if (linear.hop2FoldedAggregate) {
    const rows = linear.hop2FoldedAggregate(graph, params);

    if (rows !== null) {
      return rows;
    }
  }

  /*
   * ⚠️ ABOVE `chainGroupedCount`, which answers the same shapes by walking every path AND refuses the
   * `LET … GROUP BY` spelling on a clause count (a 2.96x cliff, item 2012). This arm is a backward
   * level recurrence — O(k·(|V| + |E|)) against O(paths) — and takes both spellings. Strictly
   * narrower otherwise, so everything it declines lands below exactly as before.
   */
  if (linear.chainGroupedLevels) {
    return linear.chainGroupedLevels(graph, params);
  }

  // ⚠️ Falls through on `null` — the composed walk's execution-time decline (item 2105).
  if (linear.chainGroupedCount) {
    const rows = linear.chainGroupedCount(graph, params);

    if (rows !== null) {
      return rows;
    }
  }

  // ⚠️ Falls through on `null` — the composed walk's execution-time decline (item 2104).
  if (linear.hop2GroupedCount) {
    const rows = linear.hop2GroupedCount(graph, params);

    if (rows !== null) {
      return rows;
    }
  }

  return undefined;
};

export const runLinearClauses = (
  linear: CLinear,
  graph: Graph,
  params: Params,
  initial?: Binding,
): Row[] => {
  // The fast paths assume an empty start; a seeded (inline-subquery) run skips
  // them and takes the general clause loop.
  if (initial === undefined) {
    const fast = fastPath(linear, graph, params);

    if (fast !== undefined) {
      return fast;
    }
  }

  // Bindings flow as a lazy stream; only barriers (mutations, aggregation,
  // ORDER BY) force materialization — so a streaming read never holds the whole
  // result set in memory.
  let bindings: Iterable<Binding> = [initial ?? new Map()];

  for (const clause of linear.clauses) {
    switch (clause.kind) {
      case 'match':
        bindings = runMatch(graph, clause, bindings, params);
        break;
      case 'for':
        bindings = runFor(graph, clause, bindings, params);
        break;
      case 'callNamed':
        bindings = runCall(graph, clause, bindings, params);
        break;
      case 'callInline':
        bindings = runCallInline(graph, clause, bindings, params);
        break;
      case 'with': {
        const projected = applyProjection(clause.projection, bindings, params, graph);
        bindings =
          clause.where === undefined
            ? projected
            : filter(
                (b: Binding) => asTruth(clause.where!({ binding: b, params, graph })) === true,
                projected,
              );
        break;
      }
      case 'filter':
        // ISO §14.6: drop rows where the condition is not TRUE (three-valued).
        bindings = filter(
          (b: Binding) => asTruth(clause.where({ binding: b, params, graph })) === true,
          bindings,
        );
        break;
      case 'page': {
        // ISO `<order by and page statement>` in statement position: sort and/or
        // slice the working BINDING table. Because this runs before any
        // projection, a later RETURN only ever projects the surviving rows.
        const take = resolveCount(clause.limit, params);

        // A zero LIMIT keeps no rows, so the ORDER BY keys are never evaluated —
        // matching the engine (and the projection's `ORDER BY … LIMIT 0`), which does not
        // fault on the sort keys of rows it will never emit.
        if (take === 0) {
          bindings = [];
          break;
        }

        const start = resolveCount(clause.skip, params) ?? 0;

        if (clause.orderBy.length === 0) {
          // A KEYLESS page keeps the first `skip + limit` rows in ARRIVAL order, so it can stop
          // PULLING at the window's end instead of forcing the whole working table and slicing.
          //
          // Item 869 measured what forcing it cost: `MATCH (n:P) LIMIT 10 RETURN n.k AS c` took
          // **36.68 ms** over 200,000 bindings against **0.04 ms** for `MATCH (n:P) RETURN n.k AS c
          // LIMIT 10` — the same query, the other spelling, 917x. The clause position already
          // took lazily; this one materialized 200,000 `Binding` maps to return ten rows.
          //
          // `slice` is lazy and BREAKS at its end, so the upstream generator chain produces only
          // the window. `toArray` is still applied because `slice`/`skip` return ONE-SHOT
          // generators and a later clause that iterated `bindings` twice would find the second
          // pass empty. That is DEFENSIVE rather than demonstrated: dropping the `toArray` passes
          // all 3,838 TS tests, so no covered path double-iterates, and it may be that none
          // exists. It stays because it costs O(limit) — ten rows for a `LIMIT 10` — which is not
          // worth reasoning about every time a clause is added below.
          bindings = toArray(
            take === undefined ? skip(start, bindings) : slice(start, start + take, bindings),
          );
          break;
        }

        let rows = toArray(bindings);

        {
          // ONE context object for the whole sort, not one per row per key (item 965).
          //
          // The previous spelling allocated `{ binding, params, graph }` inside the `.map`, so a
          // 200,000-row table with one sort key made 200,000 context objects plus 200,000
          // one-element arrays — and this clause evaluates keys for EVERY row, since finding the
          // top K requires seeing them all (item 868). The context is reassigned rather than
          // rebuilt; `params` and `graph` never vary within a page clause.
          //
          // SAFE BECAUSE NOTHING RETAINS IT. A compiled sort key reads `env.binding` during the
          // call and returns a value; it does not store `env`. The single-key specialization
          // below is the same shape as item 934's arity step, for the same reason — the common
          // case should not pay for `.map` over a one-element list.
          const ctx = { binding: undefined as unknown as Binding, params, graph };
          const sortFns = clause.orderBy.map((s) => s.fn);
          // ONE KEY AT A TIME for the bounded selection (item 1064): `boundedTopKeyed` now asks
          // for key `i` of an item rather than for all of them as an array, so a row that loses
          // allocates nothing. The single-key specialization that used to live here existed only
          // to avoid `.map` over a one-element list, and there is no `.map` left to avoid.
          const keyAt = (b: Binding, i: number): unknown => {
            ctx.binding = b;

            return sortFns[i](ctx);
          };
          const keysOf = (b: Binding): readonly unknown[] => sortFns.map((_, i) => keyAt(b, i));

          // A SMALL WINDOW SELECTS RATHER THAN SORTS (item 868), the same lever item 701 applied
          // to the projection's ORDER BY and the same measured `* 16` admission. Without it this
          // clause full-sorted the whole working table to emit a handful of rows: `MATCH (n:P)
          // ORDER BY n.k LIMIT 10` over 200,000 bindings measured 62.4 ms against 9.5 for the
          // CLAUSE-position spelling of the same query, a 6.6x gap between two ways of writing
          // one thing. The native engine had the same defect on this axis in the opposite
          // direction (items 865/866), which is item 843's rule twice over: same gap, different
          // cause, neither engine's version inferable from the other's.
          if (take !== undefined && (start + take) * 16 <= rows.length) {
            rows = boundedTopKeyed(rows, keyAt, clause.orderBy, start + take);
          } else {
            // Key each row once, then a STABLE sort — the same comparator (so the
            // same total order and NULLS FIRST/LAST) as a projection's ORDER BY.
            const keyed = rows.map((b: Binding) => ({ b, keys: keysOf(b) }));

            keyed.sort((x, y) => {
              for (const [i, sortItem] of clause.orderBy.entries()) {
                const c = compareSort(
                  x.keys[i],
                  y.keys[i],
                  sortItem.descending,
                  sortItem.nullsFirst,
                );

                if (c !== 0) {
                  return c;
                }
              }

              return 0;
            });
            rows = keyed.map((r) => r.b);
          }
        }

        rows = rows.slice(start, take === undefined ? undefined : start + take);
        bindings = rows;
        break;
      }
      case 'let':
        // ISO §14.7: bind new vars additively, left-to-right (a later item sees
        // an earlier one via the in-progress binding copy).
        bindings = map((b: Binding) => {
          const nb = new Map(b);

          for (const it of clause.items) {
            nb.set(it.var, it.expr({ binding: nb, params, graph }));
          }

          return nb;
        }, bindings);
        break;
      case 'insert':
        // Mutations must run eagerly and exactly once — force evaluation.
        bindings = mapToArray(bindings, (b: Binding) => runInsert(graph, clause, b, params));
        break;
      case 'merge':
        bindings = mapToArray(bindings, (b: Binding) => runMerge(graph, clause, b, params));
        break;
      case 'set': {
        const arr = toArray(bindings);

        for (const b of arr) {
          runSet(graph, clause, b, params);
        }

        bindings = arr;
        break;
      }
      case 'remove': {
        const arr = toArray(bindings);

        for (const b of arr) {
          runRemove(graph, clause, b);
        }

        bindings = arr;
        break;
      }
      case 'delete': {
        const arr = toArray(bindings);

        for (const b of arr) {
          runDelete(graph, clause, b, params);
        }

        bindings = arr;
        break;
      }
      case 'finish':
        return [];
      case 'return':
        return projectedRows(clause.projection, bindings, params, graph);
    }
  }

  return []; // a write-only query produces no rows
};

// --- set operations ----------------------------------------------------------

/**
 * Stable key for a result row; graph-element columns key by id. Keyed by column
 * POSITION, not name: ISO set operations (`UNION`/`EXCEPT`/`INTERSECT`) compare
 * rows positionally, so differently-aliased parts (`… AS a` vs `… AS b`) are the
 * same row when their values line up — the result adopts the left part's names.
 * The `\x01` separator avoids adjacent-value collisions (`1,2` vs `12`). This
 * matches the Rust engine, which is already positional here. DISTINCT is
 * unaffected: a single query's rows all carry the same columns.
 */
export const rowKeyOf = (row: Row): string => Object.values(row).map(valueKey).join('\x01');

/**
 * ONE-COLUMN KEYING, shared by `distinctRows` and both of `combineRows`' key-set branches
 * (items 1561, 1562).
 *
 * `rowKeyOf` costs two array allocations (`Object.values`, then `.map`), a string build and a
 * string hash per row. For a single column the VALUE can be its own key, and that is 80.3% of
 * `MATCH (n:P) RETURN n.n AS x UNION …`.
 *
 * EQUIVALENCE, which is the whole question. For PRIMITIVES a `Set`'s SameValueZero agrees with
 * `valueKey` exactly:
 *   - `valueKey` maps `-0` and `0` to the same `n0`, and SameValueZero also treats them as one;
 *   - NaN keys as `#NaN` for both, and SameValueZero has NaN equal to itself — and NaN DOES reach a
 *     row here, which item 1561 nearly missed because `JSON.stringify(NaN)` is the string `null`;
 *   - no two DISTINCT primitives share a `valueKey`, and the type prefixes (`n`/`s`/`b`) keep `5`
 *     and `'5'` apart, which raw values do too.
 *
 * ⚠️ TWO KEY SPACES, NOT ONE. Non-primitives still key through `valueKey` (an element keys by
 * `@id`, not by object identity — two row objects can hold different instances for one id). Putting
 * those strings in the SAME set as raw values would let a string COLUMN collide with an element's
 * key: the row `['@v1']` and the row `[<vertex v1>]` are different rows that would both key as
 * `'@v1'`. Separate sets cannot collide.
 */
export type OneColumnKeys = { readonly prims: Set<unknown>; readonly refs: Set<string> };

/**
 * ⚠️ EXPORTED FOR THE FUSED DISTINCT WALKS (item 1843), and the export is the point rather than a
 * convenience. `chain-projection.ts` dedupes INSIDE its walk instead of materializing every row and
 * calling `distinctRows` afterwards — and the one thing it must not do is key rows itself. The two
 * key spaces below are not an implementation detail: items 1561 and 1562 each found a silent answer
 * change in exactly this area, and a second keyer in another file would be the third.
 */
export const newOneColumnKeys = (): OneColumnKeys => ({ prims: new Set(), refs: new Set() });

/**
 * The single column's value, read PER ROW and positionally.
 *
 * ⚠️ NOT by a name taken once from `rows[0]`: ISO set operations compare positionally and the two
 * sides may alias differently (`… AS a` vs `… AS b`), so one name would read `undefined` off the
 * other side and collapse it to a single row. `for…in` takes the first own enumerable key with no
 * allocation; a `Row` is a plain object literal, whose prototype carries no enumerable keys.
 */
const oneColumnValue = (row: Row): unknown => {
  for (const name in row) {
    return (row as unknown as Record<string, unknown>)[name];
  }

  return undefined;
};

/** Add `v` to the key set; `true` when it was NOT already present. */
export const addOneColumnKey = (keys: OneColumnKeys, v: unknown): boolean => {
  if (v !== null && typeof v === 'object') {
    const k = valueKey(v);

    return keys.refs.has(k) ? false : (keys.refs.add(k), true);
  }

  return keys.prims.has(v) ? false : (keys.prims.add(v), true);
};

const hasOneColumnKey = (keys: OneColumnKeys, v: unknown): boolean =>
  v !== null && typeof v === 'object' ? keys.refs.has(valueKey(v)) : keys.prims.has(v);

/**
 * TWO-COLUMN KEYING (item 1886), and it is **built out of the one-column keyer rather than beside
 * it** — the second column goes through `addOneColumnKey` unchanged.
 *
 * ⚠️ THAT REUSE IS THE SAFETY ARGUMENT, not a tidiness one. Items 1561 and 1562 each found a silent
 * ANSWER change in exactly this area, and `newOneColumnKeys`' own note says "a second keyer in
 * another file would be the third". The two key spaces that note describes — primitives by
 * SameValueZero, non-primitives by `valueKey` so an element keys by `@id` rather than object
 * identity — are reproduced here PER POSITION, because a string in column 1 and an element in
 * column 1 must not collide any more than they may in a one-column set: the row `['@v1', x]` and the
 * row `[<vertex v1>, x]` are different rows.
 *
 * ⚠️ WHY NOT ONE `Map` KEYED BY A JOINED STRING — that is exactly what this replaces. `rowKeyOf` is
 * `Object.values(row).map(valueKey).join('\x01')`: two array allocations, two `valueKey` calls, a
 * string build and a string hash **per row**. Measured on the shape item 1825 left open
 * (`distinct2-key-1886.mjs`, 20,000 one-hop rows, 679 distinct pairs, one shape per process, both
 * orders, median of 20 less 3 warm-up):
 *
 * ```text
 *   rows       (1 col, no dedupe)   1.62 / 1.86 ms
 *   twocol     (2 cols, no dedupe)  2.06 / 1.46
 *   distinct2  (2 cols, deduped)    5.76 / 5.18      <- the key is ~3.3-3.7 ms of it
 *   distinct1  (1 col, deduped)     0.55 / 0.51      <- the fused walk, for scale
 * ```
 *
 * A nested `Map` pays one map lookup for the first column and the one-column keyer for the second,
 * allocating one key-pair per DISTINCT first-column value rather than one string per ROW.
 */
export type TwoColumnKeys = {
  readonly prims: Map<unknown, OneColumnKeys>;
  readonly refs: Map<string, OneColumnKeys>;
};

export const newTwoColumnKeys = (): TwoColumnKeys => ({ prims: new Map(), refs: new Map() });

/** The second-column key set for this first-column value, created on first sight. */
const secondColumnKeys = (keys: TwoColumnKeys, a: unknown): OneColumnKeys => {
  if (a !== null && typeof a === 'object') {
    const k = valueKey(a);
    const found = keys.refs.get(k);

    if (found !== undefined) {
      return found;
    }

    const made = newOneColumnKeys();

    keys.refs.set(k, made);

    return made;
  }

  const found = keys.prims.get(a);

  if (found !== undefined) {
    return found;
  }

  const made = newOneColumnKeys();

  keys.prims.set(a, made);

  return made;
};

/** Add the pair; `true` when it was NOT already present. */
export const addTwoColumnKey = (keys: TwoColumnKeys, a: unknown, b: unknown): boolean =>
  addOneColumnKey(secondColumnKeys(keys, a), b);

/**
 * Is the pair present? ⚠️ IT MUST NOT INSERT, which is why it cannot be written in terms of
 * `secondColumnKeys`: that creates the bucket on first sight, and `oneColumnSetOp`'s twin PROBES
 * the right-hand set once per left row. An inserting probe would grow the right set while reading
 * it — harmless for the answer here, but one map allocation per distinct left value for nothing.
 */
const hasTwoColumnKey = (keys: TwoColumnKeys, a: unknown, b: unknown): boolean => {
  const bucket =
    a !== null && typeof a === 'object' ? keys.refs.get(valueKey(a)) : keys.prims.get(a);

  return bucket !== undefined && hasOneColumnKey(bucket, b);
};

/**
 * The first TWO columns' values, read PER ROW and positionally — `oneColumnValue`'s reasoning
 * exactly, including why a name taken once from `rows[0]` will not do (ISO set operations compare
 * positionally and the two sides may alias differently).
 *
 * ⚠️ TWO SEPARATE READERS RATHER THAN ONE FUNCTION RETURNING BOTH, because anything returning both
 * would allocate a pair per row — and the per-row allocation is precisely what this replaces. Each
 * walks `for…in`, which takes own enumerable keys in order with no allocation; a `Row` is a plain
 * object literal, whose prototype carries no enumerable keys.
 */
const firstColumnValue = (row: Row): unknown => {
  for (const name in row) {
    return (row as unknown as Record<string, unknown>)[name];
  }

  return undefined;
};

const secondColumnValue = (row: Row): unknown => {
  let first = true;

  for (const name in row) {
    if (first) {
      first = false;
      continue;
    }

    return (row as unknown as Record<string, unknown>)[name];
  }

  return undefined;
};

/** Is this row set exactly `n` columns wide? Empty answers `false`, declining the fast path. */
const isWidth = (rows: readonly Row[], n: number): boolean =>
  rows.length > 0 && Object.keys(rows[0]).length === n;

/**
 * Is this row set one column wide? Empty answers `false`, which simply declines the fast path.
 */
const isOneColumn = (rows: readonly Row[]): boolean => isWidth(rows, 1);

export const distinctRows = (rows: readonly Row[]): Row[] => {
  /**
   * ⚠️ THE TWO-COLUMN ARM (item 1886). Width is taken from `rows[0]`, which is the same assumption
   * the one-column arm below makes and the same one item 1561 got wrong for `union`'s MIXED-width
   * concatenation — `distinctUnion` is the caller that can hand this mixed widths and it does not
   * come through here. Everything else is one width by construction (a projection) or by ISO
   * (set-operation arity is equal).
   */
  if (isWidth(rows, 2)) {
    const keys = newTwoColumnKeys();
    const out: Row[] = [];

    for (const r of rows) {
      if (addTwoColumnKey(keys, firstColumnValue(r), secondColumnValue(r))) {
        out.push(r);
      }
    }

    return out;
  }

  if (isOneColumn(rows)) {
    const keys = newOneColumnKeys();
    const out: Row[] = [];

    for (const r of rows) {
      if (addOneColumnKey(keys, oneColumnValue(r))) {
        out.push(r);
      }
    }

    return out;
  }

  const seen = new Set<string>();

  return rows.filter((r) => {
    const k = rowKeyOf(r);

    return seen.has(k) ? false : (seen.add(k), true);
  });
};

/**
 * `UNION` (not `ALL`): DISTINCT across both sides WITHOUT materializing their concatenation
 * (item 1564).
 *
 * ⚠️ IT ALSO FIXES A SILENT ANSWER CHANGE I INTRODUCED AT ITEM 1561, and that is the more important
 * half. `distinctRows` decides the one-column fast path from `rows[0]` alone, and `union` was its
 * ONE caller that hands it rows of MIXED WIDTH — `[...left, ...right]`, where ISO-invalid unequal
 * degree is accepted by this engine (item 1563). A one-column left therefore put two-column right
 * rows through a key built from their FIRST COLUMN ONLY:
 *
 *     MATCH (n:P) RETURN n.k AS a UNION MATCH (n:P) RETURN n.k AS a, n.s AS b
 *       pre-1561   4 rows   [{a:1},{a:2},{a:1,b:'a'},{a:2,b:'b'}]   full string keys all differ
 *       post-1561  2 ROWS   [{a:1},{a:2}]                           right side keyed on `a` alone
 *
 * Item 1562 guarded `EXCEPT`/`INTERSECT` against exactly this (their mutant survived and said so);
 * `union` was missed because its mixed widths arrive already concatenated. Requiring BOTH sides to
 * be one column restores the pre-1561 answer and makes the fast path answer-equivalent everywhere.
 *
 * The concatenation removal is the perf half: `[...left, ...right]` copied 400,000 rows per query
 * at `NODES=200000`, and after items 1561/1562 the profile put `combineRows` at 27.9% self with
 * garbage collection at 35.4% — the largest single entry in the shape.
 */
const distinctUnion = (left: readonly Row[], right: readonly Row[]): Row[] => {
  const out: Row[] = [];

  /**
   * ⚠️ THE TWO-COLUMN ARM (item 1886), and BOTH SIDES are checked for exactly the reason the
   * one-column arm below checks both: this is the one caller that can be handed MIXED widths
   * (`union` concatenates sides whose unequal degree this engine accepts, item 1563), and item 1561
   * shipped a silent answer change by keying a two-column right side on its first column alone.
   */
  if (isWidth(left, 2) && isWidth(right, 2)) {
    const keys = newTwoColumnKeys();

    for (const part of [left, right]) {
      for (const r of part) {
        if (addTwoColumnKey(keys, firstColumnValue(r), secondColumnValue(r))) {
          out.push(r);
        }
      }
    }

    return out;
  }

  if (isOneColumn(left) && isOneColumn(right)) {
    const keys = newOneColumnKeys();

    for (const part of [left, right]) {
      for (const r of part) {
        if (addOneColumnKey(keys, oneColumnValue(r))) {
          out.push(r);
        }
      }
    }

    return out;
  }

  const seen = new Set<string>();

  for (const part of [left, right]) {
    for (const r of part) {
      const k = rowKeyOf(r);

      if (!seen.has(k)) {
        seen.add(k);
        out.push(r);
      }
    }
  }

  return out;
};

/**
 * `EXCEPT`/`INTERSECT` over ONE-COLUMN sides, or `undefined` to decline (item 1562).
 *
 * One pass over the right side to build the key set, one over the left that both probes and
 * de-duplicates — so a row's key is computed ONCE rather than the three times the string path
 * needed (right set, left probe, trailing `distinctRows`).
 *
 * ⚠️ BOTH SIDES ARE CHECKED. Set-operation arity is equal, so a one-column left implies a
 * one-column right — but an EMPTY left declines rather than assuming, and checking both means a
 * mismatch that slipped past validation falls to the general path instead of mis-keying.
 */
/**
 * The TWO-COLUMN twin of `oneColumnSetOp` (item 1886) — one pass to build the right key set, one
 * over the left that both probes and de-duplicates, so a row's pair is keyed ONCE rather than the
 * three times the string path needs (right set, left probe, trailing `distinctRows`).
 *
 * ⚠️ BOTH SIDES ARE CHECKED, as in the one-column twin: set-operation arity is equal, so a
 * two-column left implies a two-column right — but an EMPTY right declines rather than assuming,
 * and checking both means a mismatch that slipped past validation falls to the string path instead
 * of mis-keying.
 */
const twoColumnSetOp = (
  left: readonly Row[],
  right: readonly Row[],
  keep: boolean,
): Row[] | undefined => {
  if (!isWidth(left, 2) || (right.length > 0 && !isWidth(right, 2))) {
    return undefined;
  }

  const rightKeys = newTwoColumnKeys();

  for (const r of right) {
    addTwoColumnKey(rightKeys, firstColumnValue(r), secondColumnValue(r));
  }

  const seen = newTwoColumnKeys();
  const out: Row[] = [];

  for (const r of left) {
    const a = firstColumnValue(r);
    const b = secondColumnValue(r);

    // `keep` is INTERSECT; `!keep` is EXCEPT. Dedup folded into the same pass.
    if (hasTwoColumnKey(rightKeys, a, b) === keep && addTwoColumnKey(seen, a, b)) {
      out.push(r);
    }
  }

  return out;
};

const oneColumnSetOp = (
  left: readonly Row[],
  right: readonly Row[],
  keep: boolean,
): Row[] | undefined => {
  if (!isOneColumn(left) || (right.length > 0 && !isOneColumn(right))) {
    return undefined;
  }

  const rightKeys = newOneColumnKeys();

  for (const r of right) {
    addOneColumnKey(rightKeys, oneColumnValue(r));
  }

  const seen = newOneColumnKeys();
  const out: Row[] = [];

  for (const r of left) {
    const v = oneColumnValue(r);

    // `keep` is INTERSECT; `!keep` is EXCEPT. Dedup folded into the same pass.
    if (hasOneColumnKey(rightKeys, v) === keep && addOneColumnKey(seen, v)) {
      out.push(r);
    }
  }

  return out;
};

/** The string-keyed fallbacks, unchanged in behaviour. */
const notInKeysOf = (right: readonly Row[]): ((r: Row) => boolean) => {
  const rightKeys = new Set(right.map(rowKeyOf));

  return (r) => !rightKeys.has(rowKeyOf(r));
};

const inKeysOf = (right: readonly Row[]): ((r: Row) => boolean) => {
  const rightKeys = new Set(right.map(rowKeyOf));

  return (r) => rightKeys.has(rowKeyOf(r));
};

/**
 * Combine two row sets per a set operator.
 *
 * ⚠️ `rightKeys` IS BUILT ONLY WHERE IT IS READ. It used to be the function's first statement, so
 * **every `UNION` and `UNION ALL` paid a full key pass over its right side and discarded it** —
 * neither union branch mentions `rightKeys`. Each discarded key cost a `rowKeyOf`, which allocates
 * an array (`Object.values`), maps `valueKey` over it and joins a string, plus the `Set` holding
 * them all.
 *
 * `UNION ALL` wasted the whole pass. Plain `UNION` wasted it too and then computed the SAME keys a
 * second time inside `distinctRows`. Item 1473 found it with the unpriced-frame screen: `combineRows`
 * had ZERO mentions anywhere in `CLOSED.md` or the audit, at 3.7% of a `UNION ALL` profile with
 * `rowKeyOf` at 2.4% beside it.
 */
export const combineRows = (op: SetOp, left: readonly Row[], right: readonly Row[]): Row[] => {
  switch (op.op) {
    case 'union':
      return op.all ? [...left, ...right] : distinctUnion(left, right);
    case 'except': {
      // EXCEPT/INTERSECT always dedup — only UNION distinguishes ALL (matches the
      // Rust engine: ir.rs "Except/Intersect always dedup; the ALL variants are
      // not distinguished here").
      //
      // ⚠️ TWO `rowKeyOf` PASSES LIVE HERE, which is why item 1561's one-column keying reached
      // `UNION` at 4.01x and `EXCEPT` at only 1.25x: the gain was confined to the trailing
      // `distinctRows` while the right-side set and the per-left-row probe still built strings.
      // Item 1562 keys both the same way.
      return (
        twoColumnSetOp(left, right, false) ??
        oneColumnSetOp(left, right, false) ??
        distinctRows(left.filter(notInKeysOf(right)))
      );
    }
    case 'intersect':
      return (
        // ⚠️ THE TWO-COLUMN TWIN FIRST, and the order cannot matter: the two gate on DISJOINT widths
        // (`isWidth(…, 2)` against `isOneColumn`), so each declines what the other claims. Written
        // in width order for reading.
        twoColumnSetOp(left, right, true) ??
        oneColumnSetOp(left, right, true) ??
        distinctRows(left.filter(inKeysOf(right)))
      );
  }
};
