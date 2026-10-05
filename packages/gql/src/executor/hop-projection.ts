import type { Graph, Vertex } from '@lenke/core';

import type { Clause, CountValue, Expr, LabelExpr, Projection } from '../ast.js';
import type {
  CClause,
  CNode,
  CompiledExpr,
  CPredicate,
  CProjection,
  CReturnItem,
  EvalEnv,
  Params,
  Row,
} from '../executor.js';
import {
  compileExpr,
  compilePredicate,
  compareSort,
  freePredicateVars,
  projectRow,
  relTypeNames,
  satisfies,
} from '../executor.js';
import {
  candidateCount,
  candidateVertexSource,
  candidateVertices,
  expand,
  matchesLabel,
} from '../graph-queries.js';
import type { Adjacency } from '../graph-queries.js';
import { indexCandidates } from './matching.js';
import { asTruth, isNullish } from './scalars.js';
import {
  pageGroups,
  pageIsEmpty,
  plainNode,
  plainRel,
  sameGroupingExpr,
  vacuousLabel,
  valueSet,
} from './shortcuts.js';

/** Rows for a whole `MATCH … RETURN` query, or `null` if the shape does not fit. */
/**
 * A fast-path row producer, or `null` to DECLINE at execution time and let the general clause
 * loop answer instead. The decline is graph-dependent — whether an index seek exists is not
 * knowable when the closure is built — which is why it lives here rather than in the detector.
 */
export type RowsFn = (graph: Graph, params: Params) => Row[] | null;

/**
 * A fast path that always answers. Kept separate from {@link RowsFn} so the DISTINCT detector
 * carries no decline branch: it has no end to seek and never hands the query back, and a
 * defensive `?? []` at its call site would be an untestable branch — a mutant replacing it is
 * equivalent code, which is how a test suite comes to look like it has teeth it does not.
 */
export type AlwaysRowsFn = (graph: Graph, params: Params) => Row[];

/**
 * `MATCH (a:L)-[:T]->(x) RETURN <expressions over x>` — walk the hop and build each row
 * directly, with no binding copy and no generator stack.
 *
 * ### Why this shape
 *
 * `traverse 1-hop project` is the largest absolute cost in the cross-engine bench for the
 * TypeScript engine: 807.9ms for 1,000,000 rows (806ns a row) against native's 75.7ms. The
 * split says the cost is the ROW PIPELINE, not the data:
 *
 *     RETURN x.name AS n          861ns a row
 *     RETURN 1 AS n               662ns a row   — no property read at all
 *     RETURN x.name, x.age        771ns a row   — two reads, no dearer than one
 *
 * So 77% of it is machinery that a constant projection pays in full. A CPU profile of the
 * same query puts 50.4% in generator/closure bodies, 14.4% in `generatorResume`, **7.2% in
 * the `Map` constructor** and 4.8% in `withBinding` — `withBinding` does `new Map(binding)`,
 * so a 1-hop allocates two binding maps per row before anything is projected.
 *
 * This path removes all of it: ONE binding `Map`, mutated per edge, and a direct `push`.
 * `projectRow` builds a fresh `Row` and never retains the binding, which is what makes
 * reusing one safe.
 *
 * Mirrors native's `try_fused_hop_project`, including its central restriction — there, every
 * projected item must satisfy `refs_only_slot(e, 1)`; here, every item may read only the far
 * variable. That is what lets the binding hold exactly one entry.
 *
 * ### Row ORDER is preserved, not merely permitted
 *
 * Unordered row order is unspecified in this engine (as in SQL without `ORDER BY`), so a
 * different order would not be a bug. It is matched anyway, because a gratuitous reordering
 * would churn every caller and test for nothing: the walk is `candidateVertices(startLabel)`
 * and then the per-vertex type bucket, which is exactly what the general path's
 * `candidateVertices` → `expand` does for a directed single-type hop.
 */
/**
 * Do the projected items read NOTHING but the pattern's two endpoints, and does any read the
 * start?
 *
 * `null` declines. A name that is neither endpoint cannot be served by a walk that binds only
 * those two, and `freePredicateVars` cannot tell a name it does not recognize from one it does —
 * so anything else is refused rather than guessed at. The REL variable is already refused by the
 * caller.
 */
const projectedEndsOnly = (
  items: readonly CReturnItem[] | readonly { expr: Expr }[],
  farVar: string,
  startVar: string | undefined,
): { readsStart: boolean } | null => {
  let readsStart = false;

  for (const item of items) {
    for (const name of freePredicateVars((item as { expr: Expr }).expr)) {
      if (name === startVar) {
        readsStart = true;
        continue;
      }

      if (name !== farVar) {
        return null;
      }
    }
  }

  return { readsStart };
};

/**
 * Can this clause `WHERE` be carried into the fused walk, and does it need the start bound?
 *
 * `null` declines. It is carried only when it reads nothing but the pattern's two endpoints —
 * which are what the walk binds — AND reads the FAR one. A predicate on the START ALONE belongs
 * to item 154's seed pre-filter, which evaluates it once per start VERTEX and skips the
 * expansion entirely; carrying it here would evaluate it once per EDGE. Measured: intercepting
 * that shape cost 4.047 -> 5.228ms, so this is a measured boundary between two fast paths
 * rather than a conservative one.
 */
const carriedWhere = (
  where: Expr | undefined,
  farVar: string,
  startVar: string | undefined,
): { needsStart: boolean } | null => {
  if (where === undefined) {
    return { needsStart: false };
  }

  const vars = [...freePredicateVars(where)];

  for (const name of vars) {
    if (name !== farVar && name !== startVar) {
      return null;
    }
  }

  if (!vars.includes(farVar)) {
    return null;
  }

  // The start is bound only when the predicate actually reads it: the single mutated binding is
  // the allocation this path exists to avoid, so an extra `set` per vertex is not free.
  return { needsStart: startVar !== undefined && vars.includes(startVar) };
};

/**
 * The far node's own inline constraint, compiled — `undefined` when the node is plain, `null`
 * when it must not be carried.
 *
 * CLOSED constraints only, the same rule `inlineOf` applies: every property VALUE must have no
 * free variables and an inline `WHERE` may read nothing but the node's own variable.
 * `(v {k: u.k})` is correlated and would need the start bound per edge — the correlation problem
 * of items 121-123, not this one.
 */
const closedFarPred = (
  node: { properties?: readonly { value: Expr }[]; where?: Expr; variable?: string },
  farVar: string,
): CPredicate | undefined | null => {
  if (plainNode(node as never)) {
    return undefined;
  }

  for (const c of node.properties ?? []) {
    if (freePredicateVars(c.value).size > 0) {
      return null;
    }
  }

  if (node.where !== undefined) {
    for (const name of freePredicateVars(node.where)) {
      if (name !== farVar) {
        return null;
      }
    }
  }

  return compilePredicate(node.properties as never, node.where);
};

export const detectHopProjection = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): RowsFn | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [m, ret] = clauses;
  const [, cret] = compiled;

  if (
    m.kind !== 'match' ||
    m.optional ||
    m.patterns.length !== 1 ||
    ret.kind !== 'return' ||
    cret.kind !== 'return'
  ) {
    return null;
  }

  const [cm] = compiled;

  if (cm.kind !== 'match') {
    return null;
  }

  const [pattern] = m.patterns;

  // No path variable: `p = (a)-[:T]->(x)` has to build a Path per row.
  if (pattern.pathVar !== undefined || pattern.segments.length !== 1) {
    return null;
  }

  const { start } = pattern;
  const [seg] = pattern.segments;
  const { rel, node } = seg;

  // `both` would visit a self-loop from both ends, and a quantifier needs the general
  // matcher.
  //
  // The rel-variable and path-variable checks here (and `pathVar` above) are DEFENSIVE, not
  // load-bearing: the projection guard below already rejects any item that reads a name
  // other than the far variable, so an unread `r` or `p` cannot change a row, and mutation
  // confirms removing either changes no answer. They stay because that redundancy depends
  // on the projection guard keeping its exact shape.
  //
  // A path MODE (`SIMPLE`/`ACYCLIC`/`WALK`/`TRAIL`) is deliberately NOT rejected: this
  // engine applies those restrictors per repetition, so on a single non-quantified hop they
  // are no-ops — measured against the general path including the `ACYCLIC`-with-a-self-loop
  // case, which is the one that could have differed. A path SELECTOR (`ANY SHORTEST`) raises
  // on a non-var-length pattern in both paths.
  if (!plainRel(rel) || rel.direction === 'both' || rel.variable !== undefined) {
    return null;
  }

  if (!plainNode(start)) {
    return null;
  }

  // ONE concrete edge type, so the per-vertex bucket is exact. `relTypeNames` returns
  // `undefined` for an untyped hop and `null` for a shape with no single bucket.
  const types = relTypeNames(rel.label);

  if (types?.length !== 1) {
    return null;
  }

  const [typeName] = types;
  const farVar = node.variable;

  if (farVar === undefined) {
    return null;
  }

  const startLabel = start.label;
  const startVarName = start.variable;

  // `candidateVertices` seeds from the label bucket ONLY for a simple label; for anything
  // else it yields every vertex and leaves the filtering to its caller. Requiring a simple
  // (or absent) label keeps the seed exact without re-deriving that filtering here.
  if (startLabel !== undefined && startLabel.kind !== 'label') {
    return null;
  }

  const proj: CProjection = cret.projection;

  // The five conditions `projectedRows` fast-paths, plus `star`: anything that sorts,
  // dedups, pages or aggregates needs the whole set in hand.
  if (
    proj.star ||
    proj.aggregating ||
    proj.distinct ||
    proj.orderBy.length > 0 ||
    proj.skip !== undefined ||
    proj.limit !== undefined ||
    proj.items.length === 0
  ) {
    return null;
  }

  // A projected item may read EITHER endpoint. Reading the far end alone keeps the binding at
  // one entry; reading the start has it bound once per outer vertex, which is what that guard's
  // own comment said would be needed and cheap. A name that is neither still declines, which is
  // the safety that matters — `freePredicateVars` cannot tell a name it does not recognize from
  // one it does, and the REL variable is already refused above.
  //
  // Refusing the start cost 3.5-4.7x on four shapes, including the very ordinary unfiltered
  // `MATCH (u:L)-[:E]->(v) RETURN u.name`: 20.0ms against 5.7ms for the same query projecting
  // `v.name` instead, with no semantic difference between them (audit item 160).
  const projected = projectedEndsOnly(ret.projection.items, farVar, startVarName);

  if (projected === null) {
    return null;
  }

  const itemsReadStart = projected.readsStart;

  // A clause `WHERE` is CARRIED rather than refused, as long as it reads nothing but the
  // pattern's two endpoints — which are exactly what the walk binds. Refusing it sent the
  // query to the general path, making a FILTERED hop 3x the cost of the same hop UNFILTERED
  // (24.3ms against 8.1ms over 20,000 edges) even though the filter cut 20,000 rows to 207.
  // A filter that makes a query slower is a declined fast path, not the cost of filtering
  // (audit item 159).
  //
  // The predicate is the COMPILED clause `WHERE` the general path uses, not a re-derivation,
  // and it is applied at the same point: once per row, after both endpoints are bound. So the
  // evaluation count and the elements evaluated are unchanged — which is what items 139/142
  // require of a fast path.
  const startVar = startVarName;
  const carried = carriedWhere(m.where, farVar, startVar);

  if (carried === null) {
    return null;
  }

  // The FAR node's own inline constraint — `(v {score: 5})` or `(v WHERE v.score = 5)` — is
  // carried rather than refused. Leaving it out made the two spellings of ONE question differ
  // by 5x once the clause form became fast (2.5ms against 13ms), which is the gap this repo is
  // named after. `satisfies` is the general path's own node check and needs no allocation,
  // because the single mutated binding already holds the far end.
  //
  // CLOSED constraints only, the same rule `inlineOf` applies: every property VALUE must have
  // no free variables and an inline `WHERE` may read nothing but the node's own variable.
  // `(v {score: u.score})` is correlated and would need the start bound per edge — that is the
  // correlation problem of items 121-123, not this one.
  const farPred = closedFarPred(node, farVar);

  if (farPred === null) {
    return null;
  }

  const gate = cm.where;
  // The start is bound when the carried predicate reads it OR a projected item does.
  const needsStart = carried.needsStart || itemsReadStart;

  const out = rel.direction === 'out';
  const farLabel: LabelExpr | undefined = node.label;

  // TWO closures, chosen once at compile time, and the unfiltered one is byte-for-byte what
  // this path was before any filter was carried. The shape of this split was measured three
  // ways, because the hot UNFILTERED hop notices all of them (2.5ms over 20,000 edges):
  //
  //   filter checks folded into the single existing loop   1.6x slower
  //   two MODULE-SCOPE walks taking a spec object          1.29x slower
  //   two closures built per compile (this)                flat
  //
  // The middle one is the interesting failure: `ts-closure-size-is-load-bearing` says to keep a
  // walk at module scope, and that is right about closure SIZE — but a shared module-scope walk
  // is called with every compile's shapes, so its call sites go polymorphic, while a closure
  // built per compile keeps its own. Destructuring the spec into locals did not recover it.
  // Here each returned closure holds ONE loop and its own captured constants, which is what
  // both effects want (audit item 159).
  // The PLAIN walk is for the far-end-only case and is byte-for-byte what it was before any of
  // this; item 159 measured that adding even a branch to its inner loop costs the hot shape
  // 1.6x. A start-reading projection goes to the FILTERED walk instead, which already binds the
  // start per vertex — it pays two always-false predicate checks per edge, which is nothing
  // against the 3.5x it gains.
  if (farPred === undefined && gate === undefined && !needsStart) {
    // The START-driven walk, byte-for-byte what it was: item 159 measured that adding even a
    // branch to this inner loop costs the hot shape 1.6x.
    const startDriven = (graph: Graph, params: Params): Row[] => {
      const rows: Row[] = [];
      // ONE binding, mutated per edge. This is the allocation the profile found.
      const binding = new Map<string, unknown>();
      const index = out ? graph.edgesFromByLabel : graph.edgesToByLabel;

      for (const v of candidateVertices(graph, startLabel)) {
        const bucket = index.get(v.id)?.get(typeName);

        if (bucket === undefined) {
          continue;
        }

        for (const edge of bucket) {
          const far: Vertex = out ? edge.to : edge.from;

          if (farLabel !== undefined && !matchesLabel(far, farLabel)) {
            continue;
          }

          binding.set(farVar, far);
          rows.push(projectRow(proj, binding, params, graph));
        }
      }

      return rows;
    };

    const farDriven = farDrivenHopWalk({ typeName, out, farVar, farLabel, proj });

    // Which walk is chosen is a PER-CALL decision, not a per-row one, so the branch costs the
    // inner loop nothing. The far-driven walk cannot apply a START label — it iterates the far
    // end — so it runs only where no vertex could fail that label.
    return (graph, params) =>
      startLabel === undefined || vacuousLabel(graph, startLabel)
        ? farDriven(graph, params)
        : startDriven(graph, params);
  }

  return filteredHopWalk({
    startLabel,
    typeName,
    out,
    farVar,
    farLabel,
    proj,
    farPred,
    gate,
    startVar: needsStart ? startVar : undefined,
    // The COMPILED far node carries both the inline equalities and the seed hints lifted from
    // the clause `WHERE`, which are the two things `indexCandidates` reads — so one value
    // answers "could the far end seek?" for both spellings.
    cfar: compiledFarNode(cm),
  });
};

/**
 * The FAR-driven hop projection: iterate the far endpoints and emit one row per incident edge,
 * instead of iterating the start endpoints and resolving a far vertex per edge.
 *
 * Two things make it 2.3x (audit item 167), and the second is the larger:
 *
 *   LOCALITY — the start-driven walk reads a far vertex per EDGE, in edge order, which is random
 *   with respect to how vertices sit in memory. Over a 1,000,000-edge fixture that lookup and
 *   its pointer chase cost ~180ns, which is most of the 266ns a row took. Here the far vertices
 *   are walked in creation order.
 *
 *   HOISTING — every item this path admits is a pure function of the far end (the guard refuses
 *   a name that is neither endpoint, and `!needsStart` means no item reads the start), so all of
 *   a far vertex's edges project the SAME cell values. `projectRow` therefore runs once per
 *   VERTEX rather than once per edge — 200,000 times instead of 1,000,000 on that fixture — and
 *   a wider projection costs almost nothing extra.
 *
 * Row ORDER changes, which is why this is allowed at all: an unordered result's order is
 * unspecified in this engine, as in SQL without ORDER BY. A shape with ORDER BY or DISTINCT
 * never reaches here.
 *
 * The rows are built FRESH per edge rather than pushing one shared object N times: callers may
 * treat a row as their own, and aliasing a million of them would be a bug that no measurement
 * would show. Measured over 1,000,000 rows: a shared-object push would be 91ns, a spread copy
 * 126ns, and this key-loop form 116ns.
 */
const farDrivenHopWalk = (w: {
  typeName: string;
  out: boolean;
  farVar: string;
  farLabel: LabelExpr | undefined;
  proj: CProjection;
}): ((graph: Graph, params: Params) => Row[]) => {
  const { typeName, out, farVar, farLabel, proj } = w;

  return (graph, params) => {
    const rows: Row[] = [];
    const binding = new Map<string, unknown>();
    // The OPPOSITE index from the start-driven walk: for an `out` hop the far end is the edge's
    // TARGET, so the far endpoints are the keys of the reverse index.
    const index = out ? graph.edgesToByLabel : graph.edgesFromByLabel;
    let keys: string[] | undefined;

    for (const far of candidateVertexSource(graph, farLabel)) {
      const bucket = index.get(far.id)?.get(typeName);

      if (bucket === undefined) {
        continue;
      }

      if (farLabel !== undefined && !matchesLabel(far, farLabel)) {
        continue;
      }

      binding.set(farVar, far);

      const template = projectRow(proj, binding, params, graph);

      // The column ORDER is observable (it is bytes), and `projectRow` fixes it; taking the keys
      // from its own output and rebuilding in that order is what preserves it.
      keys ??= Object.keys(template);

      const vals = keys.map((k) => template[k]);

      // The edges are never read — only counted — because the projection cannot reach them.
      for (let n = bucket.size; n > 0; n -= 1) {
        const row: Row = {};

        for (let c = 0; c < keys.length; c += 1) {
          row[keys[c]] = vals[c];
        }

        rows.push(row);
      }
    }

    return rows;
  };
};

/**
 * Build the FILTERED hop walk — the far end's own inline predicate and/or the carried clause
 * `WHERE`, applied in that order, which is the order the general path applies them (matching,
 * then filtering), so the rows and the faults are the general path's.
 *
 * A FACTORY at module scope rather than a closure inside `detectHopProjection`, and the
 * distinction is measured. The hot UNFILTERED hop (2.4ms over 20,000 edges) notices all four
 * arrangements tried:
 *
 *   filter checks folded into the one existing loop      1.6x slower
 *   two module-scope walks taking a spec object          1.29x slower
 *   two closures built inside the detect function        1.25x slower
 *   this: unfiltered inline, filtered behind a factory   flat
 *
 * Two effects pull opposite ways and this is where they meet. `ts-closure-size-is-load-bearing`
 * is right that a second hot loop inside the detect function costs the first one — but a SHARED
 * module-scope walk is called with every compile's shapes, so its call sites go polymorphic
 * (destructuring the spec into locals did not recover that). A factory gives each compile its
 * own closure AND keeps the detect function small (audit item 159).
 */
/**
 * How much narrower than the start source a far-end seek must be before this path hands the
 * query to the general one. Measured; see the table in `filteredHopWalk`.
 */
const SEEK_MARGIN = 8;

/**
 * The COMPILED far node of a single-hop pattern. Its own function because the optional chaining
 * counts against `detectHopProjection`'s complexity gate, which it was already at the edge of.
 */
const compiledFarNode = (cm: CClause): CNode | undefined =>
  cm.kind === 'match' ? cm.patterns[0]?.segments[0]?.node : undefined;

const filteredHopWalk = (w: {
  startLabel: LabelExpr | undefined;
  typeName: string;
  out: boolean;
  farVar: string;
  farLabel: LabelExpr | undefined;
  proj: CProjection;
  farPred: CPredicate | undefined;
  gate: CompiledExpr | undefined;
  startVar: string | undefined;
  cfar: CNode | undefined;
}): RowsFn => {
  const { startLabel, typeName, out, farVar, farLabel, proj, farPred, gate, startVar, cfar } = w;

  return (graph, params) => {
    // DECLINE when the FAR end can seek an index, and let the general path answer.
    //
    // `carriedWhere` accepts a clause `WHERE` only if it reads the far variable, so this walk
    // takes precisely the filters it is worst at: a far-reading filter cannot reject a start
    // vertex before expanding it, and the end it constrains — the seekable one — is not the end
    // this walk drives. A filter reading only the START already declines here and reaches the
    // general path's seed, which is why that spelling was fast all along. Measured on 20,000
    // users, `name` indexed (audit item 177):
    //
    //   (u)-[:FOLLOWS]->(x:User) WHERE x.name = $n RETURN u.name     3966.1us  <- this walk
    //   (u)-[:FOLLOWS]->(x:User {name: $n}) RETURN u.name            3531.5us  <- this walk
    //   (x:User {name: $n})<-[:FOLLOWS]-(u) RETURN u.name              35.3us  <- general path
    //   (x:User) WHERE x.name = $n MATCH (u)-[:FOLLOWS]->(x) …         40.7us  <- general path
    //   (u:User)-[:FOLLOWS]->(x) WHERE u.name = $n RETURN x.name       49.6us  <- general path
    //
    // 97x between a query and the SAME query with its arrow flipped. Adding `LIMIT 1` also made
    // it fast (43.3us) for the same reason: the projection guard rejects a paged projection, so
    // the query fell through to the path that seeds.
    //
    // NARROWER BY A MARGIN, and the margin is measured rather than assumed. "Narrower than the
    // source" is the guard `hopSeek` and `buildNodeCount` use, and it is WRONG here: those
    // choose between two walks with the same per-element cost, while this chooses between a walk
    // that builds no rows and a path that builds one per match. The fused walk is FLAT in the
    // filter's selectivity (it visits every edge of the start source either way); the general
    // path costs about 1.2us per matched far vertex. 20,000 users, 40,000 edges, each spelling
    // forced both ways:
    //
    //   far matches   declining   fused walk
    //             2        43.4      3871.8   decline, 89x
    //            10        60.3      3897.0   decline, 65x
    //           100       187.4      3827.5   decline, 20x
    //          1000      1092.7      3970.4   decline, 3.6x
    //         10000     13998.5      4527.5   FUSED, 3.1x
    //
    // So the crossover is near 3,250 of 20,000 and a plain `narrowest < source` guard sends the
    // last row the wrong way — it was written that way first and measured 13430us against the
    // 4272 it replaced, a 3.1x REGRESSION on an indexed-but-unselective filter. Dividing by 8
    // puts the threshold at 2,500 for this source: inside the region where declining still wins
    // by 3.6x, and clear of the one where it loses.
    if (cfar !== undefined) {
      const env: EvalEnv = { binding: new Map<string, unknown>(), params, graph };
      let narrowest = Infinity;

      for (const candidate of indexCandidates(graph, cfar, env)) {
        narrowest = Math.min(narrowest, candidate.count);
      }

      if (narrowest * SEEK_MARGIN < candidateCount(graph, startLabel)) {
        return null;
      }
    }

    const rows: Row[] = [];
    const binding = new Map<string, unknown>();
    const index = out ? graph.edgesFromByLabel : graph.edgesToByLabel;

    for (const v of candidateVertices(graph, startLabel)) {
      const bucket = index.get(v.id)?.get(typeName);

      if (bucket === undefined) {
        continue;
      }

      if (startVar !== undefined) {
        binding.set(startVar, v);
      }

      for (const edge of bucket) {
        const far: Vertex = out ? edge.to : edge.from;

        if (farLabel !== undefined && !matchesLabel(far, farLabel)) {
          continue;
        }

        binding.set(farVar, far);

        if (farPred !== undefined && !satisfies(far, farPred, binding, params, graph)) {
          continue;
        }

        if (gate !== undefined && asTruth(gate({ binding, params, graph })) !== true) {
          continue;
        }

        rows.push(projectRow(proj, binding, params, graph));
      }
    }

    return rows;
  };
};

/**
 * Exactly one DISTINCT item, and nothing that needs the whole set in hand.
 *
 * ONE item is the load-bearing condition: the dedup key is then `valueKey` of that single
 * value, so a duplicate costs neither a row object nor a `rowKey`. With two items the row
 * itself is the key and there is nothing to save.
 */
/**
 * One projected item. Neither `ORDER BY` nor paging is refused here — both are decided together
 * in `sortOf`, which needs the projected expression to judge them, and paging is allowed ONLY
 * alongside an accepted sort (see the note there).
 */
const oneItemProjection = (proj: CProjection): boolean => !proj.star && proj.items.length === 1;

const distinctOneItem = (proj: CProjection): boolean =>
  proj.distinct && !proj.aggregating && oneItemProjection(proj);

/** Is a window present at all? Paging is only ever taken alongside an accepted sort. */
const hasWindow = (proj: CProjection): boolean =>
  proj.skip !== undefined || proj.limit !== undefined;

/**
 * The single `ORDER BY` key this walk can honour, or `'decline'`.
 *
 * Sorting a dedup by its OWN projected value is a sort of the ANSWER — at most as many rows as
 * the walk returns — so doing it afterwards is free, and the general path charged a full
 * materialize-and-sort of every input row for it:
 *
 *     MATCH (n:P) RETURN DISTINCT n.age AS a                 13.90ms
 *     MATCH (n:P) RETURN DISTINCT n.age AS a ORDER BY a     142.64ms   10.3x to sort 90 rows
 *
 * The two orders agree, and that is the whole argument for doing this: when the sort key IS the
 * projected value, every row in a dedup group shares the key, so the general path's
 * sort-then-dedup keeps the same representative (they are identical rows) and emits the groups in
 * key order — which is what dedup-then-sort gives. A sort key the projection does NOT carry is a
 * different question and declines: `RETURN DISTINCT n.age AS x ORDER BY n.name` sorts the INPUT
 * rows by name and dedupes after, which no post-sort of the output can reproduce.
 *
 * The key is accepted when it is the output column by name — which also covers an alias that
 * SHADOWS a pattern variable, since the output column wins there (`MATCH (a:P) RETURN DISTINCT
 * a.age AS a ORDER BY a` sorts by the age) — or when it is structurally the projected expression,
 * the `ORDER BY n.age` spelling of the same thing.
 *
 * Refused, each for its own measured reason:
 *
 *   - **more than one key.** The order cannot differ — the output rows are already distinct in
 *     the first key, so no tie exists for a later key to break — but a later key is still
 *     EVALUATED per row and can RAISE (`ORDER BY a, 1/0` throws), and a walk that never
 *     evaluates it would swallow that. The bound is raise parity.
 *   - **`SKIP`/`LIMIT` WITHOUT an `ORDER BY`.** The general path is LAZY there, and a `LIMIT`
 *     stops it after the first few distinct values: `RETURN DISTINCT n.age AS a LIMIT 5` is
 *     0.05ms against the walk's 13.90ms, because the walk scans the whole bucket. Taking that
 *     would be a ~280x REGRESSION, so an un-ordered window stays with the general path.
 *
 * With an accepted sort, paging IS taken (item 191): neither path can exit early once a sort is
 * in the way, and the general path charged a full materialize-and-sort of every input row for it
 * — `RETURN DISTINCT n.age AS a ORDER BY a LIMIT 5` was 138.83ms against the 14.11ms the same
 * query without the `LIMIT` already costs. The window is applied AFTER the sort, by the tally's
 * own `pageGroups`, and `pageIsEmpty` guards `LIMIT 0`: the general path returns `[]` from
 * `applyProjection` BEFORE projecting anything, so a walk that ran first and sliced after would
 * raise where the query does not — `LET a = 1/(n.n - 10) … LIMIT 0` is `[]` while the same query
 * at `LIMIT 1` raises.
 */
const sortOf = (
  proj: CProjection,
  projection: Projection,
  source: Expr,
): { descending: boolean; nullsFirst: boolean | undefined } | 'decline' | undefined => {
  const keys = projection.orderBy;

  if (keys === undefined || keys.length === 0) {
    // No sort, so no window either — an un-ordered page stays with the lazy general path for
    // the raise-parity reason above. The two decisions live together because they are one rule.
    return hasWindow(proj) ? 'decline' : undefined;
  }

  if (keys.length !== 1) {
    return 'decline';
  }

  const [key] = keys;
  const outName = proj.items[0].name;
  const isOutputColumn = key.expr.kind === 'var' && key.expr.name === outName;

  if (!isOutputColumn && !sameGroupingExpr(key.expr, source)) {
    return 'decline';
  }

  return { descending: key.descending, nullsFirst: key.nullsFirst };
};

/**
 * `RETURN count(DISTINCT <e>)` asks for the SIZE of the dedup the walk already builds, so it is
 * the same question with the rows thrown away — and it went through the general pipeline instead:
 *
 *     MATCH (n:P) RETURN DISTINCT n.age AS x            5.1ms
 *     MATCH (n:P) RETURN count(DISTINCT n.age) AS c    65.8ms     13x
 *     MATCH (a:P)-[:KNOWS]->(f) RETURN count(DISTINCT f.age)   847ms against the walk's 88ms
 *
 * The cost is the PIPELINE, not the aggregate: `count(*)` forced down the same path is 84.3ms
 * with no `map`, no `filter` and no dedup in it at all, which is MORE than the DISTINCT version.
 * So optimizing the fold would have bought nothing and the walk is the whole answer (item 196).
 *
 * Returns the ARGUMENT expression, which is what the walk evaluates — the item's own compiled
 * closure is the aggregate, and folds over a group this path never builds.
 */
const countDistinctArg = (proj: CProjection, projection: Projection): Expr | undefined => {
  if (
    proj.star ||
    proj.distinct ||
    proj.having !== undefined ||
    projection.groupBy !== undefined ||
    proj.items.length !== 1 ||
    proj.orderBy.length !== 0 ||
    proj.skip !== undefined ||
    proj.limit !== undefined
  ) {
    return undefined;
  }

  const e = projection.items[0].expr;

  // `count(DISTINCT e)` exactly: one argument, DISTINCT set, and not the `count(*)` star form —
  // which has its own shortcut and a different answer (it counts rows, not distinct values).
  if (e.kind !== 'func' || e.name !== 'count' || !e.distinct || e.star || e.args.length !== 1) {
    return undefined;
  }

  return e.args[0];
};

/**
 * `RETURN <k> GROUP BY <k>` with no aggregate IS `RETURN DISTINCT <k>` — one row per distinct
 * value of `k`, projecting `k`, in first-seen group order, which is the same first-seen order
 * `DISTINCT` keeps. So it can take the same walk, and it was not:
 *
 *     MATCH (n:P) RETURN DISTINCT n.k AS a               1.12ms
 *     MATCH (n:P) LET a = n.k RETURN a GROUP BY a        6.55ms
 *
 * 5.8x for the spelling ISO pushes you toward, since `GROUP BY` takes a BOUND NAME and a `LET`
 * is the only way to give the key one (audit item 188).
 *
 * Three conditions are load-bearing, not conservative:
 *
 *   - **exactly ONE grouping element.** `RETURN a GROUP BY a, b` yields one row per `(a, b)`
 *     pair, so the projected `a` REPEATS — that is not distinct and must not be rewritten.
 *   - **the projected item IS that element.** `RETURN b GROUP BY a` projects a representative
 *     row's `b`, which is not a dedup of anything.
 *   - **no `HAVING`.** It filters whole groups after aggregation, and the walk has no groups to
 *     filter. (`having` also forces `aggregating` on with no `GROUP BY` at all, which the
 *     one-element requirement already excludes.)
 */
const groupingIsDistinct = (proj: CProjection, projection: Projection): boolean => {
  if (!proj.aggregating || proj.distinct || proj.having !== undefined || !oneItemProjection(proj)) {
    return false;
  }

  const keys = projection.groupBy;

  if (keys?.length !== 1 || proj.items[0].isAgg) {
    return false;
  }

  return sameGroupingExpr(keys[0], projection.items[0].expr);
};

/** The far end named, and the relationship plain and unnamed (nothing to bind per edge). */
const endsNamedAndPlainRel = (
  hop: { rel: { variable?: string }; node: { variable?: string } } | undefined,
): boolean =>
  hop === undefined ||
  (plainRel(hop.rel as never) && hop.rel.variable === undefined && hop.node.variable !== undefined);

/** Does `where` read nothing but `only`? A name it does not recognize counts against it. */
const whereReadsOnly = (where: Expr | undefined, only: string): boolean => {
  if (where === undefined) {
    return true;
  }

  for (const name of freePredicateVars(where)) {
    if (name !== only) {
      return false;
    }
  }

  return true;
};

/**
 * The pieces `detectDistinctProjection` needs, or `null` if the shape does not fit. Split out
 * so the detector stays under the complexity gate — the same split `groupedClauses` has from
 * its own detector, and for the same reason.
 */
type DistinctShape = {
  /** Evaluates the projected value against the walked element. */
  evalFn: CReturnItem['fn'];
  /** The output column, which stays the RETURN item's name even when `evalFn` came from a `LET`. */
  outName: string;
  /** The expression `evalFn` was compiled from — what decides which end the walk visits. */
  source: Expr;
  keyedVar: string;
  onStart: boolean;
  startLabel: LabelExpr | undefined;
  farLabel: LabelExpr | undefined;
  adjacency: Adjacency | undefined;
  gatePred: CPredicate | undefined;
  /** A single `ORDER BY` over the projected value, applied to the walk's own output. */
  sort: { descending: boolean; nullsFirst: boolean | undefined } | undefined;
  /** `SKIP`/`LIMIT`, present only alongside a sort, applied AFTER it. */
  skip: CountValue | undefined;
  limit: CountValue | undefined;
};

/**
 * The lone `LET` of the three-clause form, resolved against its compiled twin — or `null` when
 * the shape is not `MATCH / LET / RETURN` with exactly one bound name.
 */
const soleLet = (
  mid: Clause | undefined,
  cmid: CClause | undefined,
): { var: string; expr: Expr; fn: CReturnItem['fn'] } | null => {
  // ONE item, and that bound is load-bearing rather than merely conservative: a `LET` may bind
  // the SAME name twice (`LET a = n.k, a = 1` is accepted and the LAST definition wins), so
  // resolving a projected name against `items[0]` would evaluate a definition that has been
  // overwritten. Relaxing this returns `n.k`'s values where the answer is `1` — and all 1098
  // gql tests pass while it does, which is why the bound carries this note (audit item 187).
  if (mid?.kind !== 'let' || mid.items.length !== 1 || cmid?.kind !== 'let') {
    return null;
  }

  const [item] = mid.items;
  const [citem] = cmid.items;

  return citem === undefined ? null : { var: item.var, expr: item.expr, fn: citem.expr };
};

/**
 * `MATCH [LET] RETURN` resolved to its three pieces, or `null`. Split out for the same reason
 * `distinctShape` itself was split from its detector: the complexity gate.
 *
 * Two clauses, or three with a single `LET`. `groupedClauses` already accepts both, for the
 * same reason: `GROUP BY` takes a BOUND NAME, so a `LET` is the only way ISO lets you name the
 * key, and a reader who has written one naturally writes the DISTINCT spelling the same way.
 * Measured, 200,000 nodes and 90 distinct values, spellings of ONE question:
 *
 *     RETURN DISTINCT n.age AS a                             11.91ms
 *     LET a = n.age RETURN a, count(*) AS c GROUP BY a        8.61ms
 *     LET a = n.age RETURN DISTINCT a                       108.17ms   <- this one
 *
 * 9.1x across spellings that must cost the same (audit item 187).
 */
const distinctHead = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
  mode: 'rows' | 'count',
): {
  m: Extract<Clause, { kind: 'match' }>;
  proj: CProjection;
  ret: Extract<Clause, { kind: 'return' }>;
  bound: ReturnType<typeof soleLet>;
  countArg: Expr | undefined;
} | null => {
  if (clauses.length !== 2 && clauses.length !== 3) {
    return null;
  }

  const three = clauses.length === 3;
  const [m, mid, last] = clauses;
  const ret = three ? last : mid;
  const cret = compiled[three ? 2 : 1];
  const bound = three ? soleLet(mid, compiled[1]) : null;

  if (three && bound === null) {
    return null;
  }

  if (m.kind !== 'match' || m.optional || m.patterns.length !== 1 || ret?.kind !== 'return') {
    return null;
  }

  if (cret?.kind !== 'return') {
    return null;
  }

  // `count` mode has its own single acceptor; `rows` mode takes either spelling of the same
  // question — an explicit `DISTINCT` over one item, or a `GROUP BY` with no aggregate whose one
  // projected item IS the grouping element.
  const countArg = mode === 'count' ? countDistinctArg(cret.projection, ret.projection) : undefined;

  if (mode === 'count') {
    if (countArg === undefined) {
      return null;
    }
  } else if (
    !(distinctOneItem(cret.projection) || groupingIsDistinct(cret.projection, ret.projection))
  ) {
    return null;
  }

  return { m, proj: cret.projection, ret, bound, countArg };
};

/**
 * What the walk evaluates per element.
 *
 * Under a `LET` it is the bound expression, already compiled. In `count` mode it is the
 * aggregate's ARGUMENT — `item.fn` there is the aggregate closure, which folds over a group this
 * path never builds. Otherwise it is the projected item itself.
 *
 * Its own function because `distinctShape` is at the complexity gate; the three cases are one
 * decision and belong together rather than spread through that function.
 */
/**
 * The expression the walk evaluates against each element, or `null` to decline.
 *
 * In `count` mode the projected item is the AGGREGATE; what reads the element is its argument,
 * and every rule from here on — which end is visited, the gate, the sort — applies to that
 * argument exactly as it would to a bare projection.
 *
 * Under a `LET` the projected item must be EXACTLY the bound name, and then the `LET`'s own
 * expression is the one that reads the element. Anything else declines: a projection mixing the
 * bound name with another read (`RETURN DISTINCT a + n.age`) is not one expression over one end,
 * and a projection that ignores the `LET` entirely keeps going to the general path — which is
 * also what `distinct-projection.test.ts` relies on, since its `viaGeneral` helper forces that
 * path by inserting a dead `LET _z = 1`.
 */
const sourceFor = (
  ret: Extract<Clause, { kind: 'return' }>,
  bound: ReturnType<typeof soleLet>,
  countArg: Expr | undefined,
): Expr | null => {
  const projExpr = countArg ?? ret.projection.items[0].expr;

  if (bound === null) {
    return projExpr;
  }

  return projExpr.kind === 'var' && projExpr.name === bound.var ? bound.expr : null;
};

const evaluatorFor = (
  item: CReturnItem,
  bound: ReturnType<typeof soleLet>,
  countArg: Expr | undefined,
): CReturnItem['fn'] => {
  if (bound !== null) {
    return bound.fn;
  }

  return countArg === undefined ? item.fn : compileExpr(countArg);
};

const distinctShape = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
  mode: 'rows' | 'count' = 'rows',
): DistinctShape | null => {
  const head = distinctHead(clauses, compiled, mode);

  if (head === null) {
    return null;
  }

  const { m, proj, ret, bound, countArg } = head;
  const [pattern] = m.patterns;

  if (pattern.pathVar !== undefined || pattern.segments.length > 1) {
    return null;
  }

  const { start } = pattern;
  const hop = pattern.segments.length === 1 ? pattern.segments[0] : undefined;
  const far = hop?.node;

  if (start.variable === undefined || !endsNamedAndPlainRel(hop)) {
    return null;
  }

  const startVar = start.variable;

  // In `count` mode the projected item is the AGGREGATE; what the walk evaluates is its
  // argument, and every rule below — the `LET` substitution, which end is read, the gate — then
  // applies to that argument exactly as it applies to a bare projection.
  const source = sourceFor(ret, bound, countArg);

  if (source === null) {
    return null;
  }

  const sort = sortOf(proj, ret.projection, source);

  if (sort === 'decline') {
    return null;
  }

  // The projected expression must read exactly ONE end, which is the element the walk
  // evaluates it against. A CONSTANT projection (no reads) dedupes to a single row and is
  // left to the general path rather than reasoned about with an empty binding.
  const reads = freePredicateVars(source);
  const onStart = reads.size === 1 && reads.has(startVar);
  const onFar =
    hop !== undefined && reads.size === 1 && far?.variable !== undefined && reads.has(far.variable);

  if (!onStart && !onFar) {
    return null;
  }

  const keyedVar = onStart ? startVar : (far?.variable as string);
  const keyed = onStart ? start : (far as NonNullable<typeof far>);
  const other = onStart ? far : start;

  // The NON-keyed end is not visited by the evaluation, so it may carry nothing but a label.
  if (other !== undefined && !plainNode(other)) {
    return null;
  }

  if (!plainNode(keyed)) {
    return null;
  }

  // A clause `WHERE` reading only the keyed end is carried; anything else declines.
  const { where } = m;

  if (!whereReadsOnly(where, keyedVar)) {
    return null;
  }

  const gatePred = where === undefined ? undefined : compilePredicate(undefined, where);
  const startLabel = start.label;

  if (startLabel !== undefined && startLabel.kind !== 'label') {
    return null;
  }

  const [item] = proj.items;
  const evalFn = evaluatorFor(item, bound, countArg);

  const adjacency: Adjacency | undefined =
    hop === undefined
      ? undefined
      : { direction: hop.rel.direction, ...(hop.rel.label ? { label: hop.rel.label } : {}) };
  const farLabel = far?.label;

  // The column name comes from the RETURN item either way — the `LET` names a binding, not an
  // output column, so `LET a = n.age RETURN DISTINCT a` yields a column `a` and not `n.age`.
  return {
    evalFn,
    outName: item.name,
    source,
    keyedVar,
    onStart,
    startLabel,
    farLabel,
    adjacency,
    gatePred,
    sort,
    skip: proj.skip,
    limit: proj.limit,
  };
};

/**
 * `MATCH <node or 1-hop> RETURN DISTINCT <one expression over one end>` — dedupe by the
 * projected VALUE while walking, building a row only for each new one.
 *
 * ### Why
 *
 * `DISTINCT` is applied in `applyProjection` AFTER projection: every row is built, then
 * `rowKey`'d, then filtered. So a hop that yields 1,000,000 rows and 90 distinct values built
 * a million row objects and a million row keys to return ninety. Priced against native, which
 * this pass had never compared on the dedup family:
 *
 *     MATCH (a:Person)-[:KNOWS]->(x) RETURN DISTINCT x.age    ts 1153.3ms   native   7.4ms
 *     MATCH (n:Person) RETURN DISTINCT n.age                  ts  215.0ms   native   0.4ms
 *
 * A single projected item is the condition that makes this possible: the dedup key can then be
 * `valueKey` of the one value, so neither the row object nor `rowKey` is needed for a
 * duplicate. With two items the row itself is the key and nothing is saved, so it declines.
 *
 * Order is FIRST-SEEN in both paths — the general one keeps the first occurrence in stream
 * order, and a `Map`'s insertion order gives the same thing provided the walk meets elements
 * in the general path's order, which is `candidateVertices` then `expand` (item 142 had to
 * learn that the hard way, with a 7.4x given back for getting the order wrong).
 *
 * The filter is carried in the same change, per item 141's lesson, when it reads only the same
 * end as the projection.
 */
/** A simple directed single-type hop, resolved once per query. */
type DirectHop = { forward: boolean; type: string };

/**
 * The FAR-driven walk, and when it is allowed.
 *
 * `MATCH (a)-[:T]->(f) RETURN DISTINCT f.k` asks for the distinct `f.k` over every far vertex
 * REACHED. Walking edges costs one endpoint resolution each — ~180ns, measured as the whole of
 * the far-keyed dedup's remaining 284.5ms over a million edges (item 194). Asked from the far
 * end instead, a far vertex is reached exactly when it has at least one in-edge of the type, so
 * the question is one adjacency lookup per FAR VERTEX: 200,000 instead of 1,000,000, with the
 * property read and the dedup once per vertex rather than once per edge.
 *
 * Two conditions, and they are `farWalkFits`'s own (see `shortcuts.ts`), for the same reasons:
 *
 *   - **the START side must be unconstrained.** An in-edge says a far vertex is reached from
 *     SOME source; it cannot say the source matched a label. A vacuous start label — one every
 *     vertex carries — is the case where that distinction does not exist, and it is a RUNTIME
 *     property of the graph, so this is chosen per call exactly as the count walks are.
 *   - **a sort must impose the order.** First-seen order differs between the two walks, and
 *     that order is observable. Under a sort it is not: ties are rows with the same single
 *     projected value, so they are identical rows.
 *
 * What it does NOT need, unlike the counting twin: single-type edges. That twin sums bucket
 * SIZES, so an edge in two buckets would be counted twice; this one only asks whether a bucket
 * exists (audit item 195).
 */
const farDrivenFits = (
  graph: Graph,
  direct: DirectHop | undefined,
  onStart: boolean,
  sorted: boolean,
  startLabel: LabelExpr | undefined,
): boolean =>
  direct !== undefined &&
  !onStart &&
  sorted &&
  (startLabel === undefined || vacuousLabel(graph, startLabel));

/**
 * Module scope, not inline in the returned closure, which is the hot one: this file has
 * measured a 1.17x cost on an UNRELATED shape from growing that closure (item 119). The
 * closure dispatches; the walks live out here.
 */
/**
 * Everything the two walks read off the SHAPE, bundled: it is computed once per query, and one
 * object beats threading eight arguments through both of them.
 */
type WalkPlan = {
  startLabel: LabelExpr | undefined;
  farLabel: LabelExpr | undefined;
  adjacency: Adjacency | undefined;
  direct: DirectHop | undefined;
  needsFar: boolean;
  onStart: boolean;
};

const walkFarSide = (graph: Graph, plan: WalkPlan, take: (el: Vertex) => void): void => {
  const { farLabel } = plan;
  const direct = plan.direct as DirectHop;
  // The MIRROR index of the start-driven walk's: an out-hop's edges arrive at the far vertex,
  // so they are in its IN-adjacency.
  const index = direct.forward ? graph.edgesToByLabel : graph.edgesFromByLabel;

  for (const far of candidateVertexSource(graph, farLabel)) {
    const bucket = index.get(far.id)?.get(direct.type);

    // A present bucket should never be empty — `deIndexEdgeLabel` drops the entry when its set
    // empties — but the size test keeps this path from depending on that invariant holding
    // somewhere else, and it is one property read per vertex.
    if (bucket === undefined || bucket.size === 0) {
      continue;
    }

    take(far);
  }
};

const walkStartSide = (graph: Graph, plan: WalkPlan, take: (el: Vertex) => void): void => {
  const { startLabel, farLabel, adjacency, direct, needsFar, onStart } = plan;

  for (const v of candidateVertices(graph, startLabel)) {
    if (adjacency === undefined) {
      take(v);

      continue;
    }

    if (direct !== undefined) {
      const bucket = (direct.forward ? graph.edgesFromByLabel : graph.edgesToByLabel)
        .get(v.id)
        ?.get(direct.type);

      if (bucket === undefined) {
        continue;
      }

      for (const edge of bucket) {
        // `v` when nothing reads the far end: the endpoint getters are a string-keyed
        // `Map.get` each, which is the ~190ns a far-keyed dedup pays per edge.
        let far = v;

        if (needsFar) {
          far = direct.forward ? edge.to : edge.from;
        }

        if (farLabel !== undefined && !matchesLabel(far, farLabel)) {
          continue;
        }

        take(onStart ? v : far);
      }

      continue;
    }

    for (const step of expand(graph, v, adjacency)) {
      if (farLabel !== undefined && !matchesLabel(step.node, farLabel)) {
        continue;
      }

      take(onStart ? v : step.node);
    }
  }
};

/**
 * `MATCH <node or 1-hop> RETURN count(DISTINCT <one expression over one end>)` — the SIZE of the
 * dedup the walk already builds, counted while walking so no row is ever materialized.
 *
 * Its own closure rather than a flag inside `detectDistinctProjection`'s, which is the hot one
 * (`ts-closure-size-is-load-bearing`); the SHAPE RULE is shared, which is what matters, since
 * two copies of one rule is how the far endpoint ended up on a per-edge tally once before.
 *
 * Two things differ from the rows path and both are answers this engine already gives:
 *
 *   - **NULLs do not count.** `count(DISTINCT n.k)` over `1, null, absent, 2, 1` is 2, where
 *     `RETURN DISTINCT n.k` is three rows including the null. So nulls are dropped before the
 *     set, and `count(DISTINCT n.missing)` is 0 rather than 1.
 *   - **the FAR-driven walk needs no sort.** Item 195 gated it on one because first-seen order
 *     is observable; a count has no order to observe, so only the vacuous-start condition
 *     applies here.
 */
export const detectDistinctCount = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): AlwaysRowsFn | null => {
  const shape = distinctShape(clauses, compiled, 'count');

  if (shape === null) {
    return null;
  }

  const { evalFn, outName, keyedVar, onStart, startLabel, farLabel, adjacency, gatePred } = shape;
  const direct: DirectHop | undefined =
    adjacency !== undefined && adjacency.direction !== 'both' && adjacency.label?.kind === 'label'
      ? { forward: adjacency.direction === 'out', type: adjacency.label.name }
      : undefined;
  const needsFar = !onStart || farLabel !== undefined;
  const plan: WalkPlan = { startLabel, farLabel, adjacency, direct, needsFar, onStart };

  return (graph, params) => {
    const seen = valueSet();
    const binding = new Map<string, unknown>();
    const env = { binding, params, graph };
    let n = 0;
    const take = (el: Vertex): void => {
      binding.set(keyedVar, el);

      if (gatePred !== undefined && !satisfies(el, gatePred, binding, params, graph)) {
        return;
      }

      const value = evalFn(env);

      // A null never counts, and it must not enter the set either — otherwise a later non-null
      // would be the second distinct value where it is the first.
      if (isNullish(value)) {
        return;
      }

      if (seen.add(value)) {
        n += 1;
      }
    };

    // `sorted: true` because a COUNT has no observable order for the far walk to change.
    if (farDrivenFits(graph, direct, onStart, true, startLabel)) {
      walkFarSide(graph, plan, take);
    } else {
      walkStartSide(graph, plan, take);
    }

    return [{ [outName]: n }];
  };
};

export const detectDistinctProjection = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): AlwaysRowsFn | null => {
  const shape = distinctShape(clauses, compiled);

  if (shape === null) {
    return null;
  }

  const { evalFn, outName, keyedVar, onStart, startLabel, farLabel, adjacency, gatePred, sort } =
    shape;
  const { skip, limit } = shape;
  // Both decided ONCE per query, out here rather than per call and certainly not per row: they
  // read the shape only. `expand` is kept for `both`, a type disjunction and an untyped hop.
  const direct: DirectHop | undefined =
    adjacency !== undefined && adjacency.direction !== 'both' && adjacency.label?.kind === 'label'
      ? { forward: adjacency.direction === 'out', type: adjacency.label.name }
      : undefined;
  const needsFar = !onStart || farLabel !== undefined;
  const plan: WalkPlan = { startLabel, farLabel, adjacency, direct, needsFar, onStart };

  return (graph, params) => {
    // `LIMIT 0` emits nothing and must not EVALUATE: the general path returns `[]` from
    // `applyProjection` before projecting anything, and the projected expression can fault
    // (`LET a = 1/(n.n - 10) … LIMIT 0` is `[]` while the same query at `LIMIT 1` raises).
    // Resolved per execution because a bound may be a `$param` — the tally's own rule, and its
    // own helper.
    if (pageIsEmpty(params, limit)) {
      return [];
    }

    // A `valueSet` rather than a `Map<string, Row>`: keying each element's value as a STRING was
    // 40ns of a ~50ns-a-vertex walk — 200,000 strings to find the handful of distinct values the
    // query returns (audit items 192, 193). `add` answers true for a NEW value, so the row is
    // built only then and the output array IS the answer, which also drops the
    // `[...seen.values()]` copy the map needed.
    const seen = valueSet();
    const rows: Row[] = [];
    const binding = new Map<string, unknown>();
    const env = { binding, params, graph };
    const take = (el: Vertex): void => {
      binding.set(keyedVar, el);

      if (gatePred !== undefined && !satisfies(el, gatePred, binding, params, graph)) {
        return;
      }

      const value = evalFn(env);

      if (seen.add(value)) {
        rows.push({ [outName]: value });
      }
    };

    // Which walk answers this? Both live at module scope; the closure only dispatches. The
    // FAR-driven one asks one adjacency lookup per far VERTEX where the start-driven one
    // resolves an endpoint per EDGE — see `farDrivenFits` for the two conditions.
    if (farDrivenFits(graph, direct, onStart, sort !== undefined, startLabel)) {
      walkFarSide(graph, plan, take);
    } else {
      walkStartSide(graph, plan, take);
    }

    if (sort !== undefined) {
      // `compareSort` is the engine's own comparator, the one the general path's `cmp` calls per
      // key — so DESC, the NULLS placement and the engine default all behave identically here.
      // The rows are the ANSWER, so this sorts at most as many rows as it returns.
      rows.sort((a, b) => compareSort(a[outName], b[outName], sort.descending, sort.nullsFirst));
    }

    // AFTER the sort, which is the whole reason an un-ordered window is refused: a page over
    // first-seen order would be a different answer.
    return pageGroups(rows, params, skip, limit);
  };
};
