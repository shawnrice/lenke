/**
 * THE REACHABILITY RUNG: does a path of the given length exist between these endpoints?
 *
 * `detectReachableShortcut` plus the seven symbols only it reaches.
 *
 * ⚠️ REACHABILITY IS NOT COUNTING, AND `reachQuantifierIsExact` IS WHERE THAT MATTERS. A
 * reachability question can stop at the FIRST witness, so it is bounded by the frontier rather than
 * by the number of paths — but only when the quantifier admits any length in range. An EXACT length
 * (`{3,3}`) cannot stop early at depth 2, because a shorter path is not an answer. Taking the
 * early exit on an exact quantifier is a wrong ANSWER, not a slow one.
 *
 * `needsGeneralMatcher` is the companion refusal: the shapes where no early exit is sound at all.
 */

import type { Graph, Vertex } from '@lenke/core';

import type {
  Clause,
  CountValue,
  Expr,
  LabelExpr,
  PathPattern,
  Projection,
  Quantifier,
  Segment,
} from '../ast.js';
import { matchesLabel } from '../graph-queries.js';
import { outNeighbors, relTypeNames } from './adjacency.js';
import { matchNode, relHasPredicate } from './bindings.js';
import { compileExpr } from './core.js';
import type { CClause, CNode, CReturnItem, CompiledExpr, EvalEnv, Params, Row } from './core.js';
import type { CsrTables } from './csr-cache.js';
import { csrFor, csrIsBuilt } from './csr-cache.js';
import { freePredicateVars, hasSubquery } from './expr-analysis.js';
import { seedVertices } from './matching.js';
import { sortRowsByColumns } from './ordered-rows.js';
import type { ColSort } from './ordered-rows.js';
import { resolveCount, valueKey } from './rows.js';
import type { ReachFn } from './shortcuts.js';
import { refsOnlyVar, sameGroupingExpr } from './shortcuts.js';
import { isNullish } from './values.js';

/**
 * The window the `ReachSpec` may apply itself — NONE when a sort is active (item 1251).
 *
 * ⚠️ `runReach` slices its own output, so with an `ORDER BY` in play it would drop rows BEFORE the
 * order was established and return the wrong ones. `reachSortApplier` does both, in that order, so
 * the spec must be handed no window at all.
 *
 * Its own function because admitting the sort pushed `detectReachableShortcut` to 36 of the 35
 * complexity cap; the cap has been right in this file every time it has pushed back.
 */
export const specWindow = (
  projection: { skip?: CountValue; limit?: CountValue },
  ordered: boolean,
): { skip: CountValue; limit?: CountValue } =>
  ordered ? { skip: 0 } : { skip: projection.skip ?? 0, limit: projection.limit };
/**
 * `ORDER BY` for the REACHABILITY rung, resolved to its own output columns (item 1250).
 *
 * ⚠️ THIS ONE IS NOT A SLOWDOWN, IT IS AN ERROR. `detectReachableShortcut` refused every
 * `ORDER BY`, so an ordered query fell to the general path — which ENUMERATES TRAILS over an
 * UNBOUNDED pattern and dies on the trail budget. 3,000 nodes / 15,000 edges:
 *
 * ```text
 *   MATCH (a:P)-[:T]->*(x) RETURN count(DISTINCT x) AS c            OK     58 ms, 1 row
 *   ... ORDER BY c                                                  THROW  E_RESOURCE_EXHAUSTED
 *   MATCH (a:P)-[:T]->*(x) RETURN DISTINCT x.n AS n                 OK     29 ms, 3000 rows
 *   ... ORDER BY n                                                  THROW  E_RESOURCE_EXHAUSTED
 * ```
 *
 * Two spellings of one question where one ANSWERS and the other FAILS — and on the count form the
 * `ORDER BY` is a no-op, because one row is already in order. That is worse than the cost gaps
 * items 1247 and 1249 fixed: a user who adds a sort to a working query gets an error telling them
 * to "add a tighter bound".
 *
 * EVERY KEY MUST RESOLVE TO AN OUTPUT COLUMN, by name or by BEING that column's expression. The
 * first half is the tally's own argument (item 190): an output column's value is already computed,
 * so nothing is left unevaluated and no raise can be swallowed. The second half is there because
 * `outputColumnSorts` matches names ONLY, and item 1062 measured the asymmetry that creates at
 * 3.8x — here it would be answer-versus-error, which is worse than 3.8x.
 *
 * ⚠️ A WINDOW IS ORDERED FIRST AND SLICED SECOND (item 1251), which is why the caller must keep
 * `skip`/`limit` OUT of the `ReachSpec` whenever a sort is active: `runReach` applies them itself,
 * and a sort layered on top of its output would slice BEFORE ordering and return the WRONG ROWS.
 * Item 1250 declined that case for exactly this reason and left `ORDER BY … LIMIT` — the top-N
 * reachable shape, the most natural query of the family — still THROWING. The slice is resolved
 * here instead, through `resolveCount` against `params`, so a PARAMETERIZED window (`LIMIT $n`)
 * works rather than declining: this runs per QUERY, where params exist, not at compile time.
 */
export const reachSortApplier = (
  ret: Extract<Clause, { kind: 'return' }>,
  cols: readonly CReturnItem[],
  exprs: readonly Expr[],
): ((rows: Row[], params: Params) => Row[]) | null => {
  const keys = ret.projection.orderBy ?? [];

  if (keys.length === 0) {
    return (rows) => rows;
  }

  const names = new Set(cols.map((c) => c.name));

  // Two items sharing one output NAME make a name ambiguous — the same refusal the tally makes.
  if (names.size !== cols.length) {
    return null;
  }

  const out: ColSort[] = [];

  for (const k of keys) {
    const byName = k.expr.kind === 'var' && names.has(k.expr.name) ? k.expr.name : undefined;
    const at = exprs.findIndex((e) => sameGroupingExpr(k.expr, e));
    const col = byName ?? (at >= 0 ? cols[at].name : undefined);

    if (col === undefined) {
      return null;
    }

    out.push({ col, descending: k.descending, nullsFirst: k.nullsFirst });
  }

  // At most one row per REACHED node, which is at most the graph — and far less than the trails
  // the general path was enumerating to answer the same question. The window is applied HERE, so
  // the order is established before anything is dropped.
  const { skip, limit } = ret.projection;

  // ⚠️ THIS ARM RESOLVES ITS OWN BOUNDS (below), so its plan is already numeric and carries no
  // `page`. `params` is passed because the signature requires it — item 1867 made it required so a
  // call site that DOES need the resolution cannot silently skip it — and it is a no-op here.
  return (rows, params) =>
    sortRowsByColumns(
      rows,
      {
        sorts: out,
        skip: resolveCount(skip ?? 0, params) ?? 0,
        limit: resolveCount(limit, params),
      },
      params,
    );
};
/**
 * Reachability shortcut for **unbounded var-length with DISTINCT**:
 * `MATCH (a{..})-[:T]->+(b) RETURN DISTINCT <b…>` (and `->*`, `count(DISTINCT b)`).
 * Trail enumeration is exponential on a connected graph and hits `TRAIL_BUDGET`
 * (a fault), but a DISTINCT result only wants the reachable *set* — multiplicity
 * collapses — which a plain O(V+E) BFS answers. `->+` = reachable via ≥1 hop; `->*`
 * also includes the seed(s). Mirrors the native engine's `varlen_distinct_endpoint_count`
 * so both engines behave identically. Seeds via the compiled start node.
 */
export type ReachSpec = {
  cstart: CNode;
  items: readonly CReturnItem[];
  bVar: string;
  bLabel: LabelExpr | undefined;
  out: boolean;
  types: string[] | undefined;
  minZero: boolean;
  /**
   * A clause `WHERE` reading ONLY the start variable, compiled — applied per SEED (item 1906).
   *
   * ⚠️⚠️ **CARRYING IT IS WHAT MAKES TWO SPELLINGS OF ONE QUESTION COST THE SAME.** The detector
   * used to refuse any clause `WHERE` outright, so `MATCH (a:T {n: $p})-[:E]->{1,3}(b:T)` reached
   * this rung and the equivalent `MATCH (a:T)-[:E]->{1,3}(b:T) WHERE a.n = $p` reached NO rung:
   * **2996.17 ms against 342.45 over 200,000 vertices / 1,000,000 edges, 8.75x, for the same 8
   * rows.** `CLAUDE.md` names that pair first among the index-seeding bugs the old engine had — "a
   * clause `WHERE` vs an inline `{k: $x}`" — and the clause form was also 7.4x SLOWER THAN NOT
   * SEEDING AT ALL, which is audit item 159's "a filter that makes a query slower is a declined
   * fast path, not the cost of filtering".
   *
   * ⚠️ START-ONLY, AND THAT IS A SEMANTIC BOUND RATHER THAN CAUTION. A predicate on the start
   * narrows the SEED SET, which is what this rung can express. One reading the far variable is a
   * filter on the ANSWER — and since the walk dedupes reached vertices rather than enumerating
   * paths, applying it per reached vertex would be a different computation that has to be reasoned
   * about separately. One reading both is not expressible here at all.
   */
  startGate?: { fn: CompiledExpr; variable: string };
  /**
   * The quantifier's upper bound, or `undefined` for an unbounded `->*` / `->+` — item 1848.
   *
   * ⚠️ A BOUND MAKES THE WALK LEVEL-ORDERED, not merely shorter. The unbounded arm is a DFS
   * closure: every vertex expands once and the order it is reached in does not matter, because
   * "reachable at all" has no depth. A BOUNDED quantifier needs "reachable within `max` hops", so
   * the search must expand by LEVEL and stop — a DFS that happened to reach a vertex down a long
   * branch first would mark it seen at the wrong depth and could exclude it.
   */
  maxDepth?: number;
  /**
   * Produce the reached set by an ACYCLIC DFS instead of the BFS (item 2004).
   *
   * ⚠️ Set only for a BOUNDED `MATCH ACYCLIC` — see `admissibleMode`. The BFS arm is untouched and
   * its documented refusal of this mode still stands; this selects a different producer for the
   * same `reached` list, which everything downstream reads identically.
   */
  acyclic?: boolean;
  isCount: boolean;
  /** For `count(DISTINCT <expr>)` with a non-bare arg (e.g. `b.k`): the compiled
   *  arg to evaluate + dedup per reached vertex. Undefined = bare `count(DISTINCT
   *  b)`, whose distinct count is just the reached-set size. */
  countArg?: CompiledExpr;
  skip: CountValue;
  limit?: CountValue;
};
/** BFS the reachable set, then project the endpoint + DISTINCT (or count it). */
/**
 * A seed set this fraction of |V| or more counts as WIDE, and is worth a CSR build on a cold graph.
 *
 * ⚠️ DELIBERATELY GENEROUS (item 2005). Admitting the CSR wrongly costs a build the query partly
 * repays; declining it wrongly forfeits a measured 2.4-2.8x. The regression it exists to prevent was
 * a seed of ~1% of |V|, so the threshold has two orders of magnitude of room.
 */
const SEED_SHARE = 32;

/**
 * The reached set, as `Vertex[]`, for the ACYCLIC mode (item 2004).
 *
 * ⚠️ TWO MARKERS, AND CONFLATING THEM IS A WRONG ANSWER. `answer` accumulates the result across all
 * seeds and is never unwound; `onPath` is the CURRENT path's vertex set and is pushed and popped per
 * step. One set for both would prune a vertex from every later path merely because an earlier path
 * reached it — answering a spanning tree rather than the reachable set. A mutant that substitutes one
 * for the other is in `acyclic-reach-mutants-2004.sh` and is CAUGHT.
 *
 * ⚠️ `onPath[slot] = 0` AFTER the walk rather than `onPath.fill(0)` BEFORE it: the walk unwinds every
 * other mark itself, so only the seed's own slot can persist. The `fill` was O(|V|) per seed, i.e.
 * O(|V|^2) on an unseeded query, and removing it was worth 1.39x — found because the mutant deleting
 * it SURVIVED, which proved it answer-equivalent (item 2004).
 */
const acyclicReached = (
  csr: CsrTables,
  seeds: readonly Vertex[],
  maxLen: number,
  minZero: boolean,
): Vertex[] => {
  const { order, idx, off, nbr } = csr;
  const answer = new Uint8Array(order.length);
  const onPath = new Uint8Array(order.length);
  const reached: Vertex[] = [];
  const walk = (v: number, len: number): void => {
    if (len === maxLen) {
      return;
    }

    const end = off[v + 1];

    for (let k = off[v]; k < end; k += 1) {
      const w = nbr[k];

      if (onPath[w] === 1) {
        continue;
      }

      if (answer[w] === 0) {
        answer[w] = 1;
        reached.push(order[w]);
      }

      onPath[w] = 1;
      walk(w, len + 1);
      onPath[w] = 0;
    }
  };

  for (const sv of seeds) {
    const slot = idx.get(sv)!;

    onPath[slot] = 1;
    walk(slot, 0);
    onPath[slot] = 0;
  }

  return minZero ? withZeroLength(reached, seeds, answer, idx) : reached;
};

/**
 * The reached set over the CSR — the shared BFS for the default mode, `WALK`, `TRAIL` and `SIMPLE`
 * (item 2005).
 *
 * ⚠️⚠️ **IT WALKS SLOTS WITH A `Uint8Array` MARKER, and the arm it replaced keyed a `Set<string>` on
 * `v.id` and called `outNeighbors` — which ALLOCATES a `Vertex[]` — per expanded vertex.** A windowed
 * profile of `DISTINCT TRAIL` at 20,000 vertices (23.88 ms/rep) priced that: `runReach` self 39.9%
 * (9.535 ms/rep) plus `push` 29.5% (7.050), i.e. **69.4% of the row was set production**, while
 * `outNeighbors` was only 0.610 — so the cost was the STRING HASHING, not the allocation.
 *
 * 🔑 THE TELL WAS A SIBLING, NOT A FRAME RANKING. Item 2004's acyclic DFS, which ENUMERATES acyclic
 * paths, outran this BFS that visits each vertex once (35.99 ms against 61.75 on the same shape). A
 * worse algorithm beating a better one is a representation fact.
 */
const csrReached = (
  csr: CsrTables,
  seeds: readonly Vertex[],
  maxDepth: number | undefined,
  minZero: boolean,
): Vertex[] => {
  const { order, idx, off, nbr } = csr;
  const mark = new Uint8Array(order.length);
  const reached: Vertex[] = [];
  const stack: number[] = [];
  const push = (w: number): void => {
    if (mark[w] === 0) {
      mark[w] = 1;
      reached.push(order[w]);
      stack.push(w);
    }
  };

  for (const sv of seeds) {
    const slot = idx.get(sv)!;
    const end = off[slot + 1];

    for (let k = off[slot]; k < end; k += 1) {
      push(nbr[k]);
    }
  }

  if (maxDepth === undefined) {
    while (stack.length > 0) {
      const v = stack.pop()!;
      const end = off[v + 1];

      for (let k = off[v]; k < end; k += 1) {
        push(nbr[k]);
      }
    }
  } else {
    let frontier = stack.splice(0, stack.length);

    for (let depth = 1; depth < maxDepth && frontier.length > 0; depth += 1) {
      const next: number[] = [];

      for (const v of frontier) {
        const end = off[v + 1];

        for (let k = off[v]; k < end; k += 1) {
          const w = nbr[k];

          if (mark[w] === 0) {
            mark[w] = 1;
            reached.push(order[w]);
            next.push(w);
          }
        }
      }

      frontier = next;
    }
  }

  return minZero ? withZeroLength(reached, seeds, mark, idx) : reached;
};

/**
 * The reached set over the per-vertex adjacency — the arm a NARROW SEED on a COLD topology keeps.
 *
 * ⚠️⚠️ **THIS IS THE CODE THAT RAN BEFORE ITEM 2005, KEPT VERBATIM, and the measurement is why.** The
 * CSR walk is faster even cold for a wide seed, because an O(|V| + |E|) build beats hashing a string
 * per reached vertex — but a narrow seed does so little work that the build is pure overhead: a
 * seeded `{1,2}` measured **7.35 ms before and 11.89 after**, a 1.62x REGRESSION, while its warm
 * figure improved. `csrIsBuilt` separates "use the tables" from "pay to make them", so this arm runs
 * only when neither holds — and then it runs exactly what it used to, inheriting none of the other
 * arm's machinery ([[ts-closure-size-is-load-bearing]], and item 583's split for the same reason).
 *
 * ⚠️ [[vary-only-the-projection]]'s closing lesson in a new shape: **benchmark the UNHELPED case,
 * which is usually the common one.** Item 1979 regressed every unindexed seed 1.37-1.72x by reusing a
 * helper that could not decline, and only a control caught it.
 */
const adjReached = (
  graph: Graph,
  seeds: readonly Vertex[],
  out: boolean,
  types: string[] | undefined,
  maxDepth: number | undefined,
  minZero: boolean,
): Vertex[] => {
  const nbrs = (v: Vertex): Vertex[] => outNeighbors(graph, v, out, types);
  const seen = new Set<string>();
  const reached: Vertex[] = [];
  const stack: Vertex[] = [];
  const push = (w: Vertex): void => {
    if (!seen.has(w.id)) {
      seen.add(w.id);
      reached.push(w);
      stack.push(w);
    }
  };

  for (const s of seeds) {
    for (const w of nbrs(s)) {
      push(w);
    }
  }

  if (maxDepth === undefined) {
    while (stack.length > 0) {
      for (const w of nbrs(stack.pop()!)) {
        push(w);
      }
    }
  } else {
    let frontier = stack.splice(0, stack.length);

    for (let depth = 1; depth < maxDepth && frontier.length > 0; depth += 1) {
      const next: Vertex[] = [];

      for (const v of frontier) {
        for (const w of nbrs(v)) {
          if (!seen.has(w.id)) {
            seen.add(w.id);
            reached.push(w);
            next.push(w);
          }
        }
      }

      frontier = next;
    }
  }

  if (minZero) {
    for (const s of seeds) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        reached.push(s);
      }
    }
  }

  return reached;
};

/** `->*` also admits the zero-length path — the seeds themselves, if not already reached. */
const withZeroLength = (
  reached: Vertex[],
  seeds: readonly Vertex[],
  mark: Uint8Array,
  idx: ReadonlyMap<Vertex, number>,
): Vertex[] => {
  for (const sv of seeds) {
    const slot = idx.get(sv)!;

    if (mark[slot] === 0) {
      mark[slot] = 1;
      reached.push(sv);
    }
  }

  return reached;
};

export const runReach = (spec: ReachSpec, graph: Graph, params: Params): Row[] => {
  const { cstart, items, bVar, bLabel, out, types, minZero, isCount } = spec;
  // A `$param` bound resolves here (validated up-front); a literal passes through.
  const skipN = resolveCount(spec.skip, params) ?? 0;
  const limit = resolveCount(spec.limit, params);
  /**
   * The carried clause `WHERE`, as a per-seed test — `() => true` when there is none.
   *
   * ⚠️ ONE BINDING, REUSED, which is every walk in this engine's habit; and the gate runs AFTER
   * `matchNode` so an inline predicate still narrows first. Both are per SEED, not per reached
   * vertex, so neither is in the walk's inner loop.
   */
  const seedGate = ((): ((v: Vertex) => boolean) => {
    const g = spec.startGate;

    if (g === undefined) {
      return () => true;
    }

    const binding = new Map<string, unknown>();
    const env: EvalEnv = { binding, params, graph };

    return (v) => {
      binding.set(g.variable, v);

      return g.fn(env) === true;
    };
  })();

  // Seeds matching the start's label + inline props/WHERE. `seedVertices` only
  // narrows by label/index, so a no-index inline predicate (`{k:0}`) still needs a
  // per-seed check — otherwise we'd seed from the whole label and overcount the
  // reachable set. The native side has no named counterpart to grep for: it seeds
  // from a `Plan::Scan` with the label and leaves the inline predicate as a `Filter`
  // above it, so the narrowing is a plan shape rather than a function.
  // (`reach_seed_vertices` xref:gone.)
  const seeds = [...seedVertices(graph, cstart, new Map(), params)].filter(
    (v) => matchNode(new Map(), cstart, v, params, graph) !== null && seedGate(v),
  );
  /*
   * ⚠️⚠️ **THE WHOLE WALK IS OVER CSR SLOTS WITH A `Uint8Array` MARKER, and item 2005 is the
   * measurement that motivated it.** This arm used to key a `Set<string>` on `v.id` and call
   * `outNeighbors` — which ALLOCATES a `Vertex[]` — once per expanded vertex. A windowed profile of
   * `DISTINCT TRAIL` at 20,000 vertices (23.88 ms/rep) priced that exactly:
   *
   * ```text
   *     runReach [self]        39.9%   9.535 ms/rep
   *     push [self]            29.5%   7.050   <- seen.has(id) / seen.add(id) / reached.push
   *     filter                  7.8%   1.854   <- the bLabel filter
   *     properties/Map/withBinding 15.4%  3.68 <- the projection
   *     outNeighbors            2.6%   0.610
   * ```
   *
   * **69.4% of the row was set production**, and `outNeighbors` was only 0.610 despite the
   * per-vertex allocation — so the cost was the STRING HASHING, not the array.
   *
   * 🔑 THE TELL WAS A SIBLING, NOT A FRAME RANKING. Item 2004's acyclic DFS, which ENUMERATES acyclic
   * paths, outran this BFS that visits each vertex once — 35.99 ms against 61.75 on the same shape.
   * A worse algorithm beating a better one is a representation fact, and it is the same lesson item
   * 2004 learned on its own first arm one item earlier.
   *
   * ⚠️ `csrFor` IS CACHED per (direction, type set) and per `topologyVersion`, which
   * `topology-version.test.ts` states advances SYNCHRONOUSLY so that caching an adjacency structure
   * IS sound. A first ask on a fresh topology pays the build; see the cold measurement in item 2005's
   * entry, which is the thing a many-reps screen would have flattered.
   */
  /*
   * ⚠️⚠️ **THE GATE: TAKE THE CSR UNLESS THAT WOULD PAY FOR A BUILD A NARROW SEED CANNOT REPAY.**
   * Measured PRE/POST, cold and warm, 20,000 vertices, fresh graph per rep, median of 7 x 3 rounds:
   *
   * ```text
   *     shape              PRE cold   POST cold         PRE warm   POST warm
   *     plain {1,2}           31.16        22.4  1.39x     29.40        10.7  2.75x
   *     TRAIL {1,3}           31.97        22.6  1.42x     29.01        11.3  2.57x
   *     plain unbounded       30.84        21.5  1.44x     28.48        11.7  2.43x
   *     seeded {1,2}           7.35         5.4  1.36x      5.46         4.1  1.33x
   * ```
   *
   * ⚠️ UNGATED, that last row read **11.89 cold — a 1.62x REGRESSION.** The CSR walk is faster even
   * cold for a wide seed (an O(|V| + |E|) build beats hashing a string per reached vertex), but a
   * narrow seed does so little work that the build is pure overhead. `csrIsBuilt` separates "use the
   * tables" from "pay to make them", so a cold narrow-seed query keeps `adjReached` while a warm one
   * still gets the tables for free — rather than trading one case for the other.
   *
   * ⚠️ THE ACYCLIC ARM TAKES THEM UNCONDITIONALLY: it has no per-vertex form, and its only
   * alternative is the general matcher, which item 2003 measured at 1405.80 ms against this arm's
   * 28.39. A build is repaid many times over there, so the gate does not apply to it.
   */
  const wide = seeds.length * SEED_SHARE >= graph.verticesById.size;
  const csr =
    spec.acyclic || wide || csrIsBuilt(graph, !out, types) ? csrFor(graph, !out, types) : undefined;
  const produce = (): Vertex[] => {
    if (csr === undefined) {
      return adjReached(graph, seeds, out, types, spec.maxDepth, minZero);
    }

    // `maxDepth ?? 0` is unreachable for the acyclic arm: `admissibleMode` admits it only with a
    // BOUNDED quantifier, so `maxDepth` is always a number there.
    return spec.acyclic
      ? acyclicReached(csr, seeds, spec.maxDepth ?? 0, minZero)
      : csrReached(csr, seeds, spec.maxDepth, minZero);
  };
  const reached = produce();

  const kept = reached.filter((v) => matchesLabel(v, bLabel));

  if (isCount) {
    // Bare `count(DISTINCT b)`: distinct endpoints = the reached set.
    if (spec.countArg === undefined) {
      return [{ [items[0].name]: kept.length }];
    }

    // `count(DISTINCT <expr>)` (e.g. `b.k`): evaluate per reached vertex, skip
    // nulls, dedup values — mirrors the native `varlen_distinct_endpoint_count`.
    const seenVals = new Set<string>();
    let n = 0;

    for (const v of kept) {
      const cell = spec.countArg({ binding: new Map([[bVar, v]]), params, graph });

      if (isNullish(cell)) {
        continue;
      }

      const k = valueKey(cell);

      if (!seenVals.has(k)) {
        seenVals.add(k);
        n += 1;
      }
    }

    return [{ [items[0].name]: n }];
  }

  // DISTINCT rows: project the endpoint per reached vertex, dedup the tuples.
  const seenRows = new Set<string>();
  const rows: Row[] = [];

  for (const v of kept) {
    const env: EvalEnv = { binding: new Map([[bVar, v]]), params, graph };
    const cells = items.map((it) => it.fn(env));
    // Separator-joined (like `rowKeyOf`): without it, two string columns collide
    // (`'as'+'b'` == `'a'+'sb'`) and a genuinely-distinct row is dropped.
    const key = cells.map(valueKey).join('\x01');

    if (!seenRows.has(key)) {
      seenRows.add(key);
      rows.push(Object.fromEntries(items.map((it, i) => [it.name, cells[i]])));
    }
  }

  if (skipN === 0 && limit === undefined) {
    return rows;
  }

  return rows.slice(skipN, limit === undefined ? undefined : skipN + limit);
};
/**
 * If the projection is exactly `count(DISTINCT <expr over only b>)`, return the
 * arg AST — `'bare'` when it is exactly `b` (so distinct endpoints = the reached
 * set), else the sub-expression (e.g. `b.k`) to evaluate + dedup per reached
 * vertex. `null` when it is not a count-distinct over the endpoint. Uses the same
 * `refsOnlyVar` gate as `exec::fastpath::refs_only_slot`, so both engines take the
 * shortcut on the same query (previously TS only accepted a bare `b`, so
 * `count(DISTINCT b.k)` fell through to trail enumeration and faulted where native
 * answered via BFS).
 */
export const reachCount = (proj: Projection, bVar: string): { countArg?: CompiledExpr } | null => {
  const first = proj.items[0]?.expr;

  if (
    proj.items.length !== 1 ||
    first?.kind !== 'func' ||
    first.name !== 'count' ||
    !first.distinct ||
    first.star ||
    first.args.length !== 1 ||
    !refsOnlyVar(first.args[0], bVar)
  ) {
    return null;
  }

  const [arg] = first.args;

  // Bare `count(DISTINCT b)` → no arg (distinct endpoints = reached set); an
  // expression (`b.k`) → compile it to evaluate + dedup per reached vertex.
  return arg.kind === 'var' && arg.name === bVar ? {} : { countArg: compileExpr(arg) };
};
/** A pattern that only the general scalar matcher handles — a path selector
 * (`ANY`/`ALL SHORTEST`), a non-default mode (`SIMPLE`/`ACYCLIC`/`WALK`), or a
 * per-hop edge predicate on a quantified segment. The count/vectorized shortcuts
 * enumerate or count trails without the predicate, which is wrong for any. */
/**
 * Is the BFS an EXACT answer for this quantifier? (item 1252)
 *
 * UNBOUNDED max only — a bounded one has a length constraint this set walk does not track — and a
 * lower bound of at most 1.
 *
 * ⚠️ A LOWER BOUND ABOVE 1 IS UNSOUND FOR THIS BFS, and admitting it was a WRONG ANSWER
 * (item 1252). `ReachSpec` records only `minZero`, so `{2,}` was executed as if it had no
 * lower bound at all — and the BFS computes WALK reachability while the default mode here is
 * TRAIL, which forbids EDGE reuse. One node with one self-loop, `MATCH TRAIL (x)-[:R]->{2,}(y)
 * RETURN count(DISTINCT y)`: a 2-hop trail needs two DISTINCT edges and only one exists, so the
 * answer is 0 — the shortcut said 1, while the BOUNDED spelling `->{2,9}`, which cannot reach
 * this rung, said 0. Its own oracle, disagreeing.
 *
 * Declining sends `{2,}` to enumeration, which THROWS on a cyclic graph. That is the right
 * trade and it is not a new limitation: the native engine declines the identical case through
 * `set_reachability_is_exact` (`Trail => max <= 1`, recorded there from `fastpath_fuzz` seed
 * 3249, item 68) and throws too — so this also CLOSES a cross-engine divergence rather than
 * opening one. A wrong answer is worse than an error.
 *
 * Its own function because the extra condition pushed `detectReachableShortcut` past the 35
 * complexity cap; that cap has pushed back four times in this run and been right every time.
 */
/**
 * May this rung answer the quantifier at all?
 *
 * `min <= 1` is the load-bearing half and always has been: a reachability search can stop at the
 * FIRST witness, which is sound only when any length in range is an answer. At `min = 2` a vertex
 * found at depth 1 might still be reachable at length 2, and a shortest-distance search cannot see
 * that — a wrong ANSWER, not a slow one.
 *
 * ⚠️ A BOUNDED `max` IS ADMITTED SINCE ITEM 1848, where it used to require `max === null`. A
 * bounded quantifier was therefore sent to path ENUMERATION: `-[:E]->{1,3}` with a
 * `RETURN DISTINCT` measured **165.5 ms to return 8 rows**, against 108.0 ms for emitting all
 * 251,910 undeduped rows of the same walk — i.e. the dedupe cost more than the rows it removed.
 * `runReach`'s bounded arm answers it with a depth-capped BFS instead; see its own note for why
 * shortest-distance is exact here.
 *
 * `max === 0` stays refused: it admits only the zero-length path, which is a different question
 * and one `dropVacuousQuantifier` already reshapes.
 *
 * ⚠️⚠️ WHAT `min >= 2` COSTS, MEASURED AT ITEM 1879 — so the next reader sees the price beside the
 * rule rather than discovering it from a profile. At 1,500 vertices / 6,000 edges, returning the
 * SAME 8 rows:
 *
 * ```text
 *   MATCH (a:T)-[:E]->{1,3}(b:T) RETURN DISTINCT b.n    0.8 ms   this rung
 *   MATCH (a:T)-[:E]->{2,3}(b:T) RETURN DISTINCT b.n   45.1      path ENUMERATION — 56x
 * ```
 *
 * That one bound is ~70% of the workload screen's whole `var-length` family (543 ms) and ~21% of its
 * addressable time. **It is still the right refusal**: a length-in-[2,3] TRAIL is not a level-BFS
 * question, because levels permit edge reuse and TRAIL forbids it, and item 1252 measured the wrong
 * answer that admitting it produces. Taking the 45 ms needs bounded-TRAIL reachability, an algorithm
 * — and native declines the identical case (`set_reachability_is_exact`, `Trail => max <= 1`), so a
 * TS-only fix would open a cross-engine divergence this refusal currently closes.
 *
 * ⚠️ UNDER `WALK` THE SAME BOUND *IS* ANSWERABLE CHEAPLY and is nevertheless refused: with no
 * edge-reuse constraint, the union of level frontiers for k in [min, max] (no global visited set) is
 * exact at the same O(max · E) this rung already pays. Item 1879 left it unbuilt because nothing in
 * this corpus writes an explicit `MATCH WALK … {2,3}` — the screen draws default mode and the fuzzer
 * draws none — so it is a 56x on a shape nobody asks. The correctness argument is above if that
 * changes.
 */
export const reachQuantifierIsExact = (q: Quantifier | undefined): boolean =>
  q !== undefined && (q.min ?? 0) <= 1 && (q.max === null || q.max >= 1);
/**
 * ⚠️ `WALK` IS ADMITTED ALONGSIDE THE DEFAULT (item 1255), and `SIMPLE`/`ACYCLIC` are not.
 *
 * This rung answers from a BFS over the reached SET, which is WALK reachability by definition — so
 * `WALK` is the mode it serves most exactly of all, and native says so outright
 * (`set_reachability_is_exact`: `Walk => true`). Refusing it sent an explicit `MATCH WALK` to
 * enumeration, and a WALK over a cyclic graph has INFINITELY many paths, so it THROWS
 * `E_RESOURCE_EXHAUSTED` on a ONE-NODE graph whose answer is plainly 1. Item 1252 measured that and
 * left it open.
 *
 * `ACYCLIC` STAYS REFUSED, and that is measured rather than cautious: on one node with one
 * self-loop, `MATCH ACYCLIC (x)-[:R]->+(y)` is **0** — a self-loop repeats a node — while TRAIL and
 * SIMPLE answer 1 and a BFS would too. So ACYCLIC genuinely diverges from set reachability inside
 * the region `reachQuantifierIsExact` still admits.
 *
 * `SIMPLE` IS NOW ADMITTED TOO (item 1257). Item 1255 left it out for PARITY — native refused it,
 * so admitting it here alone would have answered where native threw. Item 1256 refined native's
 * gate and item 1257 gives SIMPLE the same condition on BOTH sides, so the two move together.
 *
 * Its soundness is TRAIL's argument: strip the cycles from any walk and what remains visits each
 * node at most once, which is a SIMPLE path. The closed case resolves too — a closed walk
 * decomposes into simple cycles, at least one through the source — so reaching the source itself at
 * `min = 1` agrees as well. Checked against a BOUNDED oracle (which enumerates, so it is exact) on
 * nine shapes: self-loop, 2-cycle, 3-cycle, chain, chain with a back-edge, lollipop, two joined
 * cycles, in-tree and diamond, at both `->*` and `->+` — 18 of 18 agreed.
 */
export const needsGeneralMatcher = (p: PathPattern): boolean =>
  (p.selector ?? 'walk') !== 'walk' ||
  !admissibleMode(p) ||
  p.segments.some((s) => s.rel.quantifier !== undefined && relHasPredicate(s.rel));

/**
 * ⚠️⚠️ **`acyclic` IS ADMITTED ONLY WHEN THE QUANTIFIER IS BOUNDED, and it does NOT use the BFS**
 * (item 2004). The refusal documented above stands for the BFS — ACYCLIC genuinely is not set
 * reachability — and item 2003 REFUTED the cheap alternative by measurement: a BFS plus a
 * closed-case correction is UNSOUND, because with the sources restricted a 2-cycle diverges too
 * (over `b->x, x->b` seeded at `b`, SIMPLE reaches `b` by the closed path `b->x->b` while ACYCLIC
 * does not, and `b`'s in-neighbour is `x`, not itself). So `runReach` grows a separate DFS arm that
 * produces the reached set directly, and only the SET production differs — the label filter,
 * projection, DISTINCT, `count(DISTINCT b)`, ordering and windowing below it are mode-agnostic.
 *
 * 🔑 **BOUNDED IS WHAT MAKES IT SAFE WITHOUT A DECLINE, and that is the same argument item 2002's
 * budget got wrong.** This rung CANNOT decline at runtime — `clauses.ts` returns
 * `linear.reachShortcut(graph, params)` directly — so an arm that could blow up would be a hang
 * with no way out. For a BOUNDED quantifier there is no such risk: the general matcher, which is
 * what runs this shape today, enumerates the SAME acyclic path set and allocates a binding per path
 * on top (item 2003's profile: `generatorResume` 20.3%, `withBinding` 5.5%, `projectBinding` 4.8%,
 * `rowKey` 7.9%). The DFS visits that same set with none of it, so it is never the worse choice and
 * needs no ceiling. An UNBOUNDED `->+`/`->*` has no such bound — the longest acyclic path is |V| —
 * so it stays refused and keeps the general matcher, exactly where it is today.
 */
const admissibleMode = (p: PathPattern): boolean => {
  const mode = p.mode ?? 'trail';

  if (mode === 'trail' || mode === 'walk' || mode === 'simple') {
    return true;
  }

  // ⚠️ `max` IS `null` FOR THE UNBOUNDED SPELLING and `undefined` when there is no quantifier at
  // all, so `!= null` is the one test that excludes both — the only place in this file where the
  // loose comparison is the clearer spelling rather than the sloppier one.
  return isAcyclicMode(p) && p.segments.length === 1 && p.segments[0].rel.quantifier?.max != null;
};

/**
 * Is this pattern's mode `acyclic`?
 *
 * ⚠️ A ONE-LINE HELPER BECAUSE A LINT GATE SAID SO, and the gate was right. Written inline in both
 * places — `admissibleMode` and the `ReachSpec` construction — the `?? 'trail'` plus the comparison
 * pushed `detectReachableShortcut` to a complexity of 36 against a cap of 35. Reading the mode in
 * one named place is better anyway: the default spelling (`undefined` meaning `trail`) is a fact
 * about the AST that should be stated once.
 */
export const isAcyclicMode = (p: PathPattern): boolean => (p.mode ?? 'trail') === 'acyclic';
/**
 * ⚠️⚠️ A MULTI-ELEMENT REPETITION UNIT IS ONE SEGMENT, AND REFUSING IT IS A CORRECTNESS
 * CONDITION — item 1873 found this returning WRONG ROWS.
 *
 * `((x)-[:KNOWS]->(m)-[:LIKES]->(y)){1,2}(t)` parses as a SINGLE segment whose hops beyond the
 * first live in `unitRest` (see `Segment`), so the `segments.length !== 1` check above passes it
 * through — and everything below reads only `rel`/`node`, i.e. the unit's FIRST hop. The walk
 * then does a one-hop BFS over `:KNOWS` where each repetition is really `:KNOWS` THEN `:LIKES`:
 *
 *     MATCH ((x)-[:KNOWS]->(m)-[:LIKES]->(y)){1,2}(t) RETURN DISTINCT t.n
 *       TS      1 row   [{"n":4}]
 *       native  3 rows  [{"n":1},{"n":2},{"n":4}]
 *
 * `innerQ` is refused with it: a quantifier on the unit's first inner hop is a NESTED repetition,
 * which this walk has no notion of either.
 *
 * ⚠️ AND THE SINGLE-ELEMENT GROUP IS STILL ADMITTED — `((x)-[:KNOWS]->(m)){1,2}(t)` has an empty
 * `unitRest` and IS one hop per repetition, which is exactly what the walk implements. It passes
 * the matrix test both before and after, so the refusal is scoped to the units that differ.
 */
/**
 * EXTRACTED rather than inlined because `detectReachableShortcut` sits on the complexity gate — it
 * objected at 38 against 35 with this written in place, the same wall items 1834 and 1857 hit.
 */
const isSingleHopUnit = (seg: Segment | undefined): boolean =>
  seg !== undefined && (seg.unitRest?.length ?? 0) === 0 && seg.innerQ === undefined;

/**
 * A clause `WHERE` the reachability rung can CARRY, as a per-seed gate — or `null` to decline, or
 * `undefined` for "there is no clause WHERE" (item 1906).
 *
 * ⚠️⚠️ **CARRYING IT IS WHAT MAKES TWO SPELLINGS OF ONE QUESTION COST THE SAME.** The detector
 * refused any clause `WHERE` outright, so `MATCH (a:T {n: $p})-[:E]->{1,3}(b:T)` reached this rung
 * and the equivalent `MATCH (a:T)-[:E]->{1,3}(b:T) WHERE a.n = $p` reached NO rung: **2996.17 ms
 * against 342.45 over 200,000 vertices / 1,000,000 edges, 8.75x, for the same 8 rows.** `CLAUDE.md`
 * names that pair FIRST among the index-seeding bugs the old engine had — "a clause `WHERE` vs an
 * inline `{k: $x}`" — and the clause form was also 7.4x SLOWER THAN NOT SEEDING AT ALL, which is
 * audit item 159's "a filter that makes a query slower is a declined fast path, not the cost of
 * filtering".
 *
 * ⚠️ START-ONLY, AND THAT IS A SEMANTIC BOUND RATHER THAN CAUTION. A predicate on the start narrows
 * the SEED SET, which is what this rung can express. One reading the far variable is a filter on the
 * ANSWER, and since the walk DEDUPES reached vertices rather than enumerating paths, applying it per
 * reached vertex is a different computation that needs its own reasoning. One reading both is not
 * expressible here at all.
 *
 * ⚠️ A pure function because the mistakes are ANSWER-visible and `detectReachableShortcut` sits on
 * the complexity cap — the same extraction item 1903 made for `walkReadFlags`, for both reasons.
 */
export const carriedStartGate = (
  where: Expr | undefined,
  compiled: CompiledExpr | undefined,
  startVar: string | undefined,
): { fn: CompiledExpr; variable: string } | null | undefined => {
  if (where === undefined) {
    return undefined;
  }

  const vars = freePredicateVars(where);

  // ⚠️ A LOOP-INVARIANT PREDICATE (no free variables) IS NOT CARRIED and declines instead: it is a
  // whole-query gate rather than a seed test, `loopInvariantWhere`'s own case, and the general path
  // answers it without walking at all.
  if (startVar === undefined || vars.size !== 1 || !vars.has(startVar)) {
    return null;
  }

  // A SUBQUERY was a live cross-engine divergence at item 213, and `freePredicateVars` does not
  // descend into one — so its names are invisible to the test above and it must be refused here.
  if (hasSubquery(where)) {
    return null;
  }

  return compiled === undefined ? null : { fn: compiled, variable: startVar };
};

export const detectReachableShortcut = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): ReachFn | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [m, ret] = clauses;
  const [cm, cret] = compiled;

  if (
    m.kind !== 'match' ||
    m.optional ||
    m.patterns.length !== 1 ||
    ret.kind !== 'return' ||
    cm.kind !== 'match' ||
    cret.kind !== 'return'
  ) {
    return null;
  }

  if (m.patterns[0].segments.length !== 1) {
    return null;
  }

  if (!isSingleHopUnit(m.patterns[0].segments[0])) {
    return null;
  }

  // A path selector (`ANY`/`ALL SHORTEST`) or non-default mode (`SIMPLE`/
  // `ACYCLIC`/`WALK`) is handled only by the general matcher — this shortcut
  // counts trails (edge-uniqueness), wrong for either.
  if (needsGeneralMatcher(m.patterns[0])) {
    return null;
  }

  const [{ rel, node }] = m.patterns[0].segments;
  const { quantifier: q } = rel;
  const bVar = node.variable;
  const types = relTypeNames(rel.label);

  // Unbounded (`->+` / `->*`) directed segment, no edge var / props / WHERE, a bare
  // labelled endpoint bound to a variable, a buildable rel type. An `ORDER BY` is resolved below
  // rather than refused here (item 1250) — refusing it sent the query to the general path, which
  // enumerates trails over an unbounded pattern and THROWS on the trail budget.
  if (
    q === undefined ||
    !reachQuantifierIsExact(q) ||
    rel.variable !== undefined ||
    rel.direction === 'both' ||
    (rel.properties?.length ?? 0) > 0 ||
    rel.where !== undefined ||
    bVar === undefined ||
    (node.properties?.length ?? 0) > 0 ||
    node.where !== undefined ||
    types === null
  ) {
    return null;
  }

  /*
   * ⚠️⚠️ A CLAUSE `WHERE` IS CARRIED WHEN IT READS ONLY THE START (item 1906), where it used to be
   * refused outright — see `ReachSpec.startGate` for the 8.75x that cost and why the bound is
   * start-only. The compiled form is `cm.where`, the same expression the general path would
   * evaluate, so there is nothing to keep in step by hand.
   */
  const startGate = carriedStartGate(m.where, cm.where, m.patterns[0].start.variable);

  if (startGate === null) {
    return null;
  }

  const { projection } = ret;
  const count = reachCount(projection, bVar);
  const isRows = projection.distinct && projection.items.every((it) => refsOnlyVar(it.expr, bVar));

  if (count === null && !isRows) {
    return null;
  }

  const ordered = (projection.orderBy?.length ?? 0) > 0;
  const spec: ReachSpec = {
    cstart: cm.patterns[0].start,
    items: cret.projection.items,
    bVar,
    bLabel: node.label,
    out: rel.direction === 'out',
    types: types ?? undefined,
    minZero: q.min === 0,
    startGate,
    maxDepth: q.max ?? undefined,
    acyclic: isAcyclicMode(m.patterns[0]),
    isCount: count !== null,
    countArg: count?.countArg,
    ...specWindow(projection, ordered),
  };

  const applySort = reachSortApplier(
    ret,
    cret.projection.items,
    ret.projection.items.map((it) => it.expr),
  );

  if (applySort === null) {
    return null;
  }

  return (graph, params) => applySort(runReach(spec, graph, params), params);
};
