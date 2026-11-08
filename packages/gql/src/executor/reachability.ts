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
} from '../ast.js';
import { matchesLabel } from '../graph-queries.js';
import { outNeighbors, relTypeNames } from './adjacency.js';
import { matchNode, relHasPredicate } from './bindings.js';
import { compileExpr } from './core.js';
import type { CClause, CNode, CReturnItem, CompiledExpr, EvalEnv, Params, Row } from './core.js';
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

  return (rows, params) =>
    sortRowsByColumns(rows, {
      sorts: out,
      skip: resolveCount(skip ?? 0, params) ?? 0,
      limit: resolveCount(limit, params),
    });
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
  isCount: boolean;
  /** For `count(DISTINCT <expr>)` with a non-bare arg (e.g. `b.k`): the compiled
   *  arg to evaluate + dedup per reached vertex. Undefined = bare `count(DISTINCT
   *  b)`, whose distinct count is just the reached-set size. */
  countArg?: CompiledExpr;
  skip: CountValue;
  limit?: CountValue;
};
/** BFS the reachable set, then project the endpoint + DISTINCT (or count it). */
export const runReach = (spec: ReachSpec, graph: Graph, params: Params): Row[] => {
  const { cstart, items, bVar, bLabel, out, types, minZero, isCount } = spec;
  // A `$param` bound resolves here (validated up-front); a literal passes through.
  const skipN = resolveCount(spec.skip, params) ?? 0;
  const limit = resolveCount(spec.limit, params);
  // Seeds matching the start's label + inline props/WHERE. `seedVertices` only
  // narrows by label/index, so a no-index inline predicate (`{k:0}`) still needs a
  // per-seed check — otherwise we'd seed from the whole label and overcount the
  // reachable set. The native side has no named counterpart to grep for: it seeds
  // from a `Plan::Scan` with the label and leaves the inline predicate as a `Filter`
  // above it, so the narrowing is a plan shape rather than a function.
  // (`reach_seed_vertices` xref:gone.)
  const seeds = [...seedVertices(graph, cstart, new Map(), params)].filter(
    (v) => matchNode(new Map(), cstart, v, params, graph) !== null,
  );
  const nbrs = (v: Vertex): Vertex[] => outNeighbors(graph, v, out, types);

  // Forward reachability (≥1 hop) as a DFS closure — each vertex expands once.
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

  while (stack.length > 0) {
    for (const w of nbrs(stack.pop()!)) {
      push(w);
    }
  }

  // `->*` also admits the zero-length path — the seeds themselves.
  if (minZero) {
    for (const s of seeds) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        reached.push(s);
      }
    }
  }

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
export const reachQuantifierIsExact = (q: Quantifier | undefined): boolean =>
  q?.max === null && (q.min ?? 0) <= 1;
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
  !['trail', 'walk', 'simple'].includes(p.mode ?? 'trail') ||
  p.segments.some((s) => s.rel.quantifier !== undefined && relHasPredicate(s.rel));
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
    m.where !== undefined ||
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
