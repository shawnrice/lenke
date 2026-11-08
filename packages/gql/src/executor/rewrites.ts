/**
 * The GQL PLANNER: every rewrite that runs between parsing a linear query and compiling it.
 *
 * ⚠️ THIS CODE SPENT ITS LIFE UNDER THE HEADING `// --- shared bucket/adjacency primitives`, and
 * that mislabel has cost real time (item 1664). It is not shared primitives and it is not
 * adjacency — it is `inlineAggregateCall`, `inlineCorrelatedCall`, `inlineTrailingLet`,
 * `fuseAnchorThenHop`, the `dropUnread*` family and `compileLinear`, i.e. the optimizer, sitting in
 * a file named for execution. Item 1662 lost most of a build to not seeing that `compileLinear`
 * composes these in a specific ORDER and that a rewrite's position in that order decides whether
 * its output reaches a fast-path rung at all: the extension it shipped fired correctly, passed its
 * route assertion, and still delivered 1.44x of an available 11.3x because it ran outside
 * `inlineTrailingLet` instead of inside it.
 *
 * ⚠️ SO THE COMPOSITION IN `compileLinear` IS THE MOST LOAD-BEARING THING HERE. Each rewrite's
 * nesting is a measured choice with a comment saying why, and "answer-equivalent" does NOT mean
 * "order-independent": a rewrite that emits a clause another pass folds must run INSIDE that pass,
 * or the clause stands and a standing `LET` is off every one of the twenty rungs.
 *
 * WHY IT IS A MODULE. Measured before moving it: 23 symbols, 2,005 lines, importing 33 values from
 * `core.ts` and — once `compile` moved to `compile.ts` — exporting NOTHING that `core.ts` reads
 * back. Verified closed: nothing it imports transitively depends on anything it defines, so this
 * layer sits strictly between `core.ts` below and `compile.ts` above.
 */

import type {
  Clause,
  Expr,
  LabelExpr,
  LinearQuery,
  MatchClause,
  NodePattern,
  PathPattern,
  ReturnItem,
  SortItem,
} from '../ast.js';
import { isSyntheticParam } from '../auto-param.js';
import { WRITE_CLAUSES, procedureSpec } from './clauses.js';
import type { CClause, CLinear, CMergeUpdate, CNode, CSeedHint, HintMap } from './core.js';
import {
  boundExprs,
  coalesceRangeHints,
  collectHints,
  compileExpr,
  compileInsertPath,
  compilePath,
  compileProjection,
  compileSetItem,
  correlatedSubqueries,
  dropVacuousQuantifier,
  faultFreeSortKey,
  filterPredicate,
  foldSitesOf,
  matchVarSets,
  noteCountParam,
  oneOrderFreeRow,
  patternNames,
  patternVars,
  pinnableSegment,
  plainGroupNode,
  repeatsNodeVariable,
  seedPrefilter,
  withPin,
} from './core.js';
import { detectCountShortcut } from './count-shortcut.js';
import {
  SUBQUERY_EXPRS,
  andExprOf,
  asLabelTest,
  cannotFault,
  cheapPureExpr,
  conjoin,
  flattenConjuncts,
  freePredicateVars,
  hasSubquery,
} from './expr-analysis.js';
import { detectForCount, detectForProjection } from './for-unwind.js';
import { detectGroupedHopAggregate, detectGroupedHopCount } from './grouped-hop.js';
import {
  detectDistinctCount,
  detectDistinctProjection,
  detectHopAggregate,
  detectHopProjection,
  detectMultiHopAggregate,
  detectOptionalHopProjection,
} from './hop-projection.js';
import { detectHop2Projection } from './hop2-projection.js';
import {
  detectGroupedNodeAggregate,
  detectGroupedNodeCount,
  detectMultiNodeAggregate,
  detectNodeAggregate,
  detectNodeProjection,
} from './node-scan.js';
import { detectOptionalHopCount } from './optional-hop.js';
import { detectReachableShortcut } from './reachability.js';
import { columnName } from './rows.js';
import { collectAggregates, hasAggregate } from './scalars.js';
import { detectVarLengthCount } from './var-length-count.js';

/**
 * Attribute a MULTI-PATTERN clause's `WHERE` conjuncts to the patterns they constrain, so the
 * comma spelling of a question plans like its `MATCH … MATCH …` twin.
 *
 * ### Only a conjunct reading ONE of the clause's own pattern variables moves
 *
 * That restriction is what makes this independent of MATCH ORDER, and the order is genuinely
 * not knowable here: `matchClauseBindings` hands a multi-pattern clause to `visitRemaining`,
 * which picks which pattern to visit next (item 122's uncorrelated-rescan fix). So a conjunct
 * reading TWO of the clause's patterns — `WHERE b.k = a.k` — cannot be pushed onto either: if
 * the other pattern is visited second its variable is unbound, the comparison is UNKNOWN, and
 * the row silently disappears. A conjunct reading ONE pattern plus OUTER variables is safe for
 * the reason the single-pattern case already relies on: outer variables are in the incoming
 * binding before the clause starts, whatever order the patterns are then visited in.
 *
 * So `WHERE b.k = a.k` over two patterns of one clause stays a clause filter and keeps its
 * 3.4x against the two-clause spelling — recorded rather than fixed, because fixing it means
 * pinning the visit order (item 285).
 *
 * A pattern only receives a conjunct if it is a bare single node with a variable, the same
 * precondition the single-pattern path checks: a predicate on a HOP is NOT equivalent in the
 * node position (see `liftHopWhereToSeedFilter`, which exists because moving it changes which
 * queries raise).
 */
const pushWhereAcrossPatterns = (
  clause: Extract<Clause, { kind: 'match' }>,
  where: Expr,
): typeof clause => {
  const conjuncts: readonly Expr[] = where.kind === 'and' ? where.items : [where];
  const own = new Set(patternVars(clause.patterns));
  // Which pattern each conjunct lands on, by index; `undefined` keeps it as the clause filter.
  const landed: (number | undefined)[] = conjuncts.map((c) => {
    if (hasSubquery(c)) {
      return undefined;
    }

    const touched = [...freePredicateVars(c)].filter((n) => own.has(n));

    if (touched.length !== 1) {
      return undefined; // zero (a constant, or only outer reads) or a correlation
    }

    const [name] = touched;
    const i = clause.patterns.findIndex((p) => p.start.variable === name);
    const p = i < 0 ? undefined : clause.patterns[i];

    // Both guards MIRROR the single-pattern path's below (`segments.length > 0 || pathVar !==
    // undefined` declines there). The `segments` one is load-bearing and tested — a predicate
    // on a hop's start is not equivalent to one in the clause, because it changes which
    // queries raise. The `pathVar` one is INHERITED: mutation removed it here (M3) and removed
    // the single-pattern path's copy (M9), and both SURVIVED the whole suite, so no test
    // anywhere observes it. Kept anyway — a guard whose necessity is unproven is not a guard
    // shown to be unnecessary, and the path-value semantics it would open were never the
    // target (item 285).
    return p?.segments.length === 0 && p.pathVar === undefined ? i : undefined;
  });

  if (landed.every((i) => i === undefined)) {
    return clause;
  }

  const patterns = clause.patterns.map((p, i) => {
    const mine = conjuncts.filter((_, ci) => landed[ci] === i);

    if (mine.length === 0) {
      return p;
    }

    const all = p.start.where === undefined ? mine : [p.start.where, ...mine];
    const merged: Expr = all.length === 1 ? all[0] : { kind: 'and', items: all };

    return { ...p, start: { ...p.start, where: merged } };
  });

  const residual = conjoin(conjuncts.filter((_, ci) => landed[ci] === undefined));
  const { where: _dropped, ...rest } = clause;

  return {
    ...rest,
    ...(residual === undefined ? {} : { where: residual }),
    patterns,
  };
};
// NOT the clause-spelling COMPILE cost, and do not attack it as such (item 906).
//
// Item 905 measured planning one predicate at +0.409 us as an inline `{k: 1}`, +1.021 as an inline
// `WHERE` and +1.793 as a clause `WHERE`, and the obvious reading of that last +0.77 is "the clause
// spelling pays for this function". Ablated — `return clause` immediately, which is
// answer-equivalent and only slower at run time — the clause spelling gets **WORSE, 4.434 -> 5.336
// us**. So pushing the predicate into the node is CHEAPER to compile than leaving it a clause
// filter, and this function is part of the mitigation rather than the cost. The residual +0.77 is
// the clause-level handling itself.
const pushWhereIntoNode = (clause: Extract<Clause, { kind: 'match' }>): typeof clause => {
  const { where } = clause;

  if (where === undefined || clause.optional) {
    return clause;
  }

  // A MULTI-PATTERN clause attributes its conjuncts instead, which is where the 15.8x was.
  // This used to decline on `patterns.length !== 1`, so the comma spelling of a question kept
  // its predicate as a clause filter while the `MATCH … MATCH …` spelling pushed it into the
  // node. Measured at 4 x 100,000 on the SAME question and the same 4 rows:
  //
  //   MATCH (a:A) MATCH (b:B) WHERE b.k = 7 RETURN a.k     9.193 ms
  //   MATCH (a:A), (b:B)      WHERE b.k = 7 RETURN a.k   145.039 ms
  //
  // The comment below already explains why: a node predicate is evaluated once per SCANNED
  // vertex, a clause filter once per SURVIVING BINDING — and for a product that is a binding
  // `Map` materialized per product row before anything filters it (item 285).
  if (clause.patterns.length > 1) {
    return pushWhereAcrossPatterns(clause, where);
  }

  const [path] = clause.patterns;
  const name = path.start.variable;

  if (path.segments.length > 0 || name === undefined || path.pathVar !== undefined) {
    return clause;
  }

  // The predicate's free variables are NOT restricted, and that is deliberate.
  // Item 127 required it to be closed; mutation showed that guard was not
  // load-bearing, because `matchNode` evaluates a node predicate against the
  // INCOMING binding, which already holds every earlier clause's variables — so an
  // outer reference resolves in the pattern exactly as it did in the clause
  // filter. Measured on the shape it unlocks (item 128):
  //
  //   MATCH (z:P {k: 3}) MATCH (n:P) WHERE n.j = z.j   2217.1ms -> 1537.7ms
  //
  // both answering 1142857. The evaluation COUNT is unchanged either way: a
  // single-node pattern's bindings are 1:1 with the vertices it scans, so the
  // predicate runs once per vertex per incoming row in both spellings.
  // AND with any predicate the node already carries, so the inline spelling of a
  // query that had both is unchanged.
  //
  // Only the subquery-FREE conjuncts move, and the rest stay as the clause filter.
  // A node predicate is evaluated once per SCANNED vertex; a clause filter once per
  // SURVIVING binding. For an ordinary comparison those are the same count and the
  // merge is free, but a conjunct carrying `EXISTS {…}` / `COUNT {…}` / `VALUE {…}`
  // runs a correlated sub-pattern each time, so pushing it costs one subquery per
  // vertex in the label. A cheap conjunct beside it DOES now gate it: the merged predicate
  // compiles through `filterPredicate`, which exits at the first conjunct that is not cleanly
  // TRUE — so the subquery is reached only for an element the cheap conjunct accepted. (This
  // comment said the opposite until 2026-10-09, and was right when written: the evaluator
  // short-circuited nothing, and `operator-chains.test.ts` pinned that as a byte-identity
  // contract.) What the split still buys is the SEEK, which ordering cannot substitute for.
  // Measured on 20,000 users with a FOLLOWS ring (audit item 174):
  //
  //   MATCH (u:User) WHERE u.name = $n AND EXISTS { (u)-[:FOLLOWS]->{2,4}(u) }   265.48ms
  //   MATCH (u:User {name: $n}) WHERE EXISTS { (u)-[:FOLLOWS]->{2,4}(u) }           2.38ms
  //
  // 111x for one question spelled two ways, which is the bug class this engine is
  // named after. Splitting makes the first spelling plan as the second.
  const conjuncts: readonly Expr[] = where.kind === 'and' ? where.items : [where];
  // MUTATION (item 919): SWAPPING this partition's two destinations — so subquery conjuncts get
  // pushed into the node and cheap ones stay as the clause filter — SURVIVED the whole gql suite,
  // including `subquery-conjunct-split.test.ts`, whose oracle is a faulting subquery body that
  // raises if and only if it was evaluated. That oracle is the strongest one available here, so
  // the survivor is answer-equivalence and not a coverage hole: `gatePredicate` re-gates the
  // subquery downstream. The partition direction is therefore a PERF choice. The same swap in
  // `gatePredicate` itself is CAUGHT, 7 failures.
  //
  // ONE `hasSubquery` walk per conjunct, not two (item 919). This was a `filter` on the negated
  // predicate followed by a `filter` on the predicate, so every conjunct was walked TWICE — and
  // `hasSubquery` is a GENERIC structural walk of the whole AST fragment, which a CPU profile put
  // at the single largest frame of a clause-`WHERE` compile (279.5 ms of a 1743.7 ms run against
  // 29.7 for the inline spelling).
  const pushable: Expr[] = [];
  const kept: Expr[] = [];

  for (const c of conjuncts) {
    (hasSubquery(c) ? kept : pushable).push(c);
  }

  if (pushable.length === 0) {
    return clause;
  }

  const all = path.start.where === undefined ? pushable : [path.start.where, ...pushable];
  const merged: Expr = all.length === 1 ? all[0] : { kind: 'and', items: all };
  const residual = conjoin(kept);
  const { where: _dropped, ...rest } = clause;

  return {
    ...rest,
    ...(residual === undefined ? {} : { where: residual }),
    patterns: [{ ...path, start: { ...path.start, where: merged } }],
  };
};
const compileClause = (rawClause: Clause): CClause => {
  const clause = rawClause.kind === 'match' ? pushWhereIntoNode(rawClause) : rawClause;

  switch (clause.kind) {
    case 'match': {
      const patterns = clause.patterns.map(compilePath);
      // A hop whose clause WHERE constrains only the start: skip the seeds it rejects
      // instead of expanding every one of them and filtering the rows (see `seedPrefilter`).
      const prefilter = seedPrefilter(clause);

      if (prefilter !== undefined) {
        patterns[0] = { ...patterns[0], prefilter };
      }

      // Lift seekable conjuncts of the clause WHERE onto every pattern node by
      // variable — not just the start — so either end of a pattern can be the
      // seed side. `MATCH (a:Person) WHERE a.name = 'marko'` then seeds like the
      // inline `(a:Person {name: 'marko'})` form, and a constraint on the far
      // end lets `orient` start the walk from there.
      if (clause.where) {
        const hints: HintMap = new Map();
        collectHints(clause.where, hints);
        const attach = (node: CNode): CNode => {
          const extra = node.variable ? hints.get(node.variable) : undefined;

          return extra
            ? { ...node, seedHints: coalesceRangeHints([...(node.seedHints ?? []), ...extra]) }
            : node;
        };

        // A REL variable's id hint names ONE node the hop can start from, so it attaches
        // to the node BEFORE the segment rather than to a node of its own. `collectHints`
        // has always keyed hints by variable, rel variables included — `attach` above only
        // ever looks up NODE variables, so until item 621 a pinned edge id was collected and
        // then dropped.
        //
        // Declines, each because the seed would be a SUBSET and LOSE rows rather than a
        // superset — the one direction a seed must never go:
        //   - `both`: either endpoint can start the walk, so pinning one drops the other's
        //     row (the native twin declines `Dir::Both` for the same reason, item 620);
        //   - a QUANTIFIED rel: the variable binds the LIST of a walk's edges, so
        //     `element_id(r)` is not one edge's id at all.
        //
        // BOTH ends of the segment are pinned, not just the one the hop drives from. A
        // pinned edge names each of its endpoints, so whichever side `orient` decides to
        // start the walk from is seeded to one node. Pinning only the near side left
        // `MATCH (a:P)-[r:R]->(b:P)` at 7710 us against the unlabelled spelling's 3.00 —
        // measured — because with both ends labelled `orient` starts from the FAR node,
        // which carried no pin. A cliff between two spellings of one query, and the same
        // one item 620 had to close in the native engine for a different reason.
        const pinFor = (
          relVar: string | undefined,
          direction: string,
          wantSource: boolean,
        ): CSeedHint[] => {
          if (relVar === undefined || (direction !== 'out' && direction !== 'in')) {
            return [];
          }

          // An `out` hop runs source -> target, an `in` hop target -> source.
          const sourceEnd = direction === 'out' ? wantSource : !wantSource;

          // Item 1316 pins an id LIST the same way, and the only reason it needed any code is
          // that this filter DROPPED it. `collectHints` keys hints by variable with rel
          // variables included, so item 1315's `idIn` hint was already being collected for
          // `element_id(r) IN [...]` and then discarded here — the same way a pinned single
          // edge id was collected and dropped before item 621.
          //
          // The declines above carry over untouched: `both` and a quantified rel are refused by
          // the direction check and `pinnableSegment`, before either kind reaches this map.
          //
          // A `flatMap` with narrowing `if`s rather than `filter`+`map`: the old form needed a
          // `(h as { value: CompiledExpr })` cast because `filter` does not narrow the union,
          // and a cast that silently covers two shapes is how the second one gets read off the
          // wrong field.
          return (hints.get(relVar) ?? []).flatMap((h): CSeedHint[] => {
            if (h.kind === 'id') {
              return [{ kind: 'edgeEnd' as const, value: h.value, sourceEnd }];
            }

            if (h.kind === 'idIn') {
              return [{ kind: 'edgeEndIn' as const, values: h.values, sourceEnd }];
            }

            return [];
          });
        };

        for (let i = 0; i < patterns.length; i++) {
          const segs = patterns[i].segments;
          // Segment k starts at the previous node (or the pattern's start for k = 0).
          // `near[k]` pins the node segment k starts FROM, `far[k]` the node it lands ON.
          const near = segs.map((s) =>
            pinnableSegment(s) ? pinFor(s.rel.variable, s.rel.direction, true) : [],
          );
          const far = segs.map((s) =>
            pinnableSegment(s) ? pinFor(s.rel.variable, s.rel.direction, false) : [],
          );

          patterns[i] = {
            ...patterns[i],
            start: withPin(attach(patterns[i].start), near[0] ?? []),
            // SPREAD, not a rebuild. `CSegment` also carries `unit` — the compiled
            // repetition unit a quantified subpath walks — and listing the fields here
            // dropped it, so `walkSegments` never called `bindGroupVars` and every group
            // binding read as NULL. Only when the clause had a WHERE, which is what made it
            // look like a scoping rule rather than a lost field (item 571).
            segments: segs.map((s, k) => ({
              ...s,
              // The node after segment k is BOTH that segment's landing node and the node
              // segment k+1 starts from, so it can carry a pin from either.
              node: withPin(attach(s.node), [...(far[k] ?? []), ...(near[k + 1] ?? [])]),
            })),
          };
        }
      }

      return {
        kind: 'match',
        optional: clause.optional,
        patterns,
        where: clause.where ? filterPredicate(clause.where) : undefined,
        nullVars: clause.optional ? patternVars(clause.patterns) : [],
        ...matchVarSets(clause.patterns, clause.where),
      };
    }
    case 'with':
      return {
        kind: 'with',
        projection: compileProjection(clause.projection),
        where: clause.where ? filterPredicate(clause.where) : undefined,
      };
    case 'filter':
      return { kind: 'filter', where: filterPredicate(clause.where) };
    case 'page':
      // Sort keys are ordinary expressions over the CURRENT scope (the working
      // table), so they compile exactly like a FILTER predicate — no projection,
      // no new variables.
      noteCountParam(clause.skip);
      noteCountParam(clause.limit);

      return {
        kind: 'page',
        orderBy: (clause.orderBy ?? []).map((sortItem) => ({
          fn: compileExpr(sortItem.expr),
          descending: sortItem.descending,
          nullsFirst: sortItem.nullsFirst,
        })),
        skip: clause.skip,
        limit: clause.limit,
      };
    case 'let':
      return {
        kind: 'let',
        items: clause.items.map((it) => ({ var: it.var, expr: compileExpr(it.expr) })),
      };
    case 'for':
      return {
        kind: 'for',
        list: compileExpr(clause.list),
        alias: clause.alias,
        ordinality: clause.ordinality,
      };
    case 'return':
      return { kind: 'return', projection: compileProjection(clause.projection) };
    case 'callNamed': {
      const spec = procedureSpec(clause.name);
      const columns = spec ? ['node', spec.resultColumn] : [];
      const binds = clause.yields
        ? clause.yields.map((y) => ({ column: y.name, var: y.alias ?? y.name }))
        : columns.map((c) => ({ column: c, var: c }));

      return {
        kind: 'callNamed',
        optional: clause.optional,
        procName: clause.name,
        algo: spec?.algo ?? null,
        config: clause.config.map((p) => ({ key: p.key, value: compileExpr(p.value) })),
        binds,
      };
    }
    case 'callInline': {
      // All set-op parts share the same output columns, so the first is
      // authoritative for the OPTIONAL null-fill column names.
      const ret = clause.body.parts[0].clauses.find((c) => c.kind === 'return');
      const returnColumns =
        ret && !ret.projection.star
          ? ret.projection.items.map((i) => i.alias ?? columnName(i.expr))
          : [];

      return {
        kind: 'callInline',
        optional: clause.optional,
        scope: clause.scope,
        body: compileLinear(clause.body.parts[0]),
        bodyMore: clause.body.ops.map((op, i) => ({
          op,
          part: compileLinear(clause.body.parts[i + 1]),
        })),
        returnColumns,
      };
    }
    case 'insert':
      return { kind: 'insert', patterns: clause.patterns.map(compileInsertPath) };
    case 'merge': {
      const { onUpdate } = clause;
      const compileUpdate = (): CMergeUpdate | undefined => {
        if (onUpdate === undefined || onUpdate.kind === 'nothing') {
          return onUpdate;
        }

        return {
          kind: 'set',
          items: onUpdate.items.map(compileSetItem),
          where: onUpdate.where ? compileExpr(onUpdate.where) : undefined,
        };
      };

      return {
        kind: 'merge',
        pattern: compileInsertPath(clause.pattern),
        onCreate: clause.onCreate?.map(compileSetItem),
        onUpdate: compileUpdate(),
      };
    }
    case 'set':
      return { kind: 'set', items: clause.items.map(compileSetItem) };
    case 'remove':
      return { kind: 'remove', items: clause.items };
    case 'delete':
      return { kind: 'delete', detach: clause.detach, targets: clause.targets.map(compileExpr) };
    case 'finish':
      return { kind: 'finish' };
  }
};

// --- shared bucket/adjacency primitives --------------------------------------
// Type-bucket sizing + neighbour expansion used by the general matcher and by the
// count/reachability fast-paths in ./executor/shortcuts.ts. Exported so the
// shortcut detectors can't drift from the trunk's expansion of the same edges.
/**
 * `MATCH … LET a = <expr> RETURN … a …` IS `MATCH … RETURN … <expr> …` — the `LET` inlined into
 * the projection that follows it, so the clause list is two long again and the ladder applies.
 *
 * `LET` is how this engine names an expression, and a `LET` between the `MATCH` and the `RETURN`
 * dropped the query off every node rung — each reads a two-clause shape. Measured at 200,000
 * vertices (audit item 512):
 *
 * ```text
 *   LET a = n.age RETURN a AS k        126.4ms   RETURN n.age AS k      13.7ms   9.2x
 *   LET a = n.age RETURN count(*)      108.3ms   RETURN count(*)         0.0ms
 * ```
 *
 * Native pays 16.2 against 13.1 for the same pair, so this is the TS ladder's shape check and
 * nothing deeper. Two spellings of one question, which is the defect class this repo is named
 * after.
 *
 * The substitution is deliberately SHALLOW — an item either IS the variable or does not mention
 * it — so no expression tree is rewritten and no nested binder (a `CASE`, a `LET … IN`, a
 * subquery) can be entered by mistake. An item that reads the name inside a larger expression
 * declines the whole rewrite rather than being rebuilt.
 *
 * `GROUP BY` and `HAVING` decline outright: `GROUP BY` takes a BOUND NAME, so inlining its key
 * would remove the thing it names (and that spelling is already fast — 4.0ms against the
 * equivalent 5.0). `RETURN *` declines because the `LET` variable is one of the columns.
 */
const inlineTrailingLet = (clauses: readonly Clause[]): readonly Clause[] => {
  if (clauses.length < 3) {
    return clauses;
  }

  const ret = clauses[clauses.length - 1];
  const binder = clauses[clauses.length - 2];
  const bound = boundExprs(binder);

  if (ret.kind !== 'return' || bound === null) {
    return clauses;
  }

  const proj = ret.projection;

  if (proj.star || proj.groupBy !== undefined || proj.having !== undefined) {
    return clauses;
  }

  // A SUBQUERY binding may be inlined only where the projection reads its name EXACTLY ONCE.
  // Inlining a cheap, total expression any number of times costs nothing and can raise nothing; a
  // subquery is neither, so the evaluation COUNT has to come out the same:
  //
  //   - read TWICE and inlined twice, the work doubles;
  //   - read ZERO times, the binding's evaluation disappears and with it any fault it raises.
  //
  // One reference is the only case where substituting changes nothing observable.
  const subqueryBound = [...bound].filter(([, e]) => SUBQUERY_EXPRS.has(e.kind)).map(([n]) => n);

  if (subqueryBound.length > 0) {
    const reads = (e: Expr): number => {
      const free = freePredicateVars(e);

      return subqueryBound.filter((name) => free.has(name)).length;
    };
    const total =
      proj.items.reduce((acc, it) => acc + reads(it.expr), 0) +
      (proj.orderBy ?? []).reduce((acc, o) => acc + reads(o.expr), 0);

    if (total !== 1) {
      return clauses;
    }
  }

  // Exactly a bound name → its expression; a FUNCTION ARGUMENT that is one → substitute it there;
  // mentions one anywhere else → refuse; otherwise unchanged.
  //
  // The function-argument case is item 565, and it is where the common shape lives. `subst` used
  // to be all-or-nothing, so `LET c = COUNT { … } RETURN sum(c)` — a name read inside an
  // aggregate — never inlined and kept the per-row clause. Measured at 200,000 vertices /
  // 300,000 edges, one case per process:
  //
  // ```text
  //   LET c = COUNT { MATCH (n)-[:KNOWS]->(x) } RETURN sum(c)   114.06 / 170.48 / 173.33 ms
  //   RETURN sum(COUNT { MATCH (n)-[:KNOWS]->(x) })              50.14 /  52.78 /  52.18
  // ```
  //
  // ONE LEVEL ONLY, and deliberately: the arguments are replaced where they are BARE NAMES, and
  // the result is then re-checked for any surviving mention. A deeper reference (`sum(c + 1)`)
  // leaves one and refuses, rather than needing an exhaustive walk over a 40-arm `Expr` union
  // where a missed arm would drop the binder with the name still unbound.
  const subst = (e: Expr): Expr | null => {
    if (e.kind === 'var') {
      const sub = bound.get(e.name);

      if (sub !== undefined) {
        return sub;
      }
    }

    const mentions = (x: Expr): boolean => {
      const free = freePredicateVars(x);

      return [...bound.keys()].some((n) => free.has(n));
    };

    if (!mentions(e)) {
      return e;
    }

    if (e.kind !== 'func') {
      return null;
    }

    const args = e.args.map((a) => (a.kind === 'var' ? (bound.get(a.name) ?? a) : a));
    const swapped: Expr = { ...e, args };

    return args.some((a, i) => a !== e.args[i]) && !args.some(mentions) ? swapped : null;
  };
  const items: ReturnItem[] = [];

  for (const it of proj.items) {
    const e = subst(it.expr);

    if (e === null) {
      return clauses;
    }

    // A `LET` names a BINDING, and an un-aliased `RETURN a` takes its COLUMN name from the
    // expression — so substituting without pinning the alias renamed the column from `a` to
    // `n.k`. Caught by `DISTINCT over a LET-bound name`, which exists for exactly that
    // distinction; the rewrite now carries the name it removed.
    items.push(
      e === it.expr
        ? it
        : {
            ...it,
            expr: e,
            alias: it.alias ?? (it.expr.kind === 'var' ? it.expr.name : undefined),
          },
    );
  }

  const sorts: SortItem[] = [];

  for (const o of proj.orderBy ?? []) {
    const e = subst(o.expr);

    if (e === null) {
      return clauses;
    }

    sorts.push({ ...o, expr: e });
  }

  return [
    ...clauses.slice(0, -2),
    {
      ...ret,
      projection: {
        ...proj,
        items,
        orderBy: proj.orderBy === undefined ? undefined : sorts,
      },
    },
  ];
};
/**
 * Hoisted to module scope rather than nested in `inlineAggregateCall`: it captures nothing from
 * that function, so nesting it only rebuilt the closure on every call. Flagged by
 * `unicorn(consistent-function-scoping)` the moment this code moved into its own file — the
 * same condition was present, and unreported, while it sat in the 12,000-line executor.
 */
const asLet = (c: Clause): Clause | null => {
  if (c.kind !== 'callInline' || c.optional || c.scope.length === 0) {
    return null;
  }

  const { parts, ops } = c.body;

  if (parts.length !== 1 || ops.length > 0) {
    return null;
  }

  const inner = parts[0].clauses;

  if (inner.length !== 2) {
    return null;
  }

  const [bm, bret] = inner;

  if (bm.kind !== 'match' || bm.optional || bm.patterns.length !== 1 || bret.kind !== 'return') {
    return null;
  }

  const proj = bret.projection;

  // Paging, ordering, DISTINCT and grouping inside the body all change what the one row is — or
  // whether it is one row at all — so they stay with the general path.
  if (
    proj.star ||
    proj.distinct ||
    proj.groupBy !== undefined ||
    proj.having !== undefined ||
    (proj.orderBy?.length ?? 0) > 0 ||
    proj.skip !== undefined ||
    proj.limit !== undefined ||
    proj.items.length !== 1
  ) {
    return null;
  }

  const [item] = proj.items;
  const { alias } = item;

  // The alias is what the outer query reads the scalar as, so the body must name it — an
  // un-aliased aggregate has no name to bind.
  if (alias === undefined || !hasAggregate(item.expr)) {
    return null;
  }

  // After the rewrite the body's pattern variables are GONE (a `VALUE {}` subquery scopes its
  // own pattern), so none of them may be the name the outer query now reads. An IMPORTED name
  // is fine: that one was the outer's already.
  const imported = new Set(c.scope);

  for (const name of patternNames(bm.patterns[0])) {
    if (!imported.has(name) && name === alias) {
      return null;
    }
  }

  const agg = item.expr;
  // THE PARSER'S OWN NORMALIZATION, mirrored (item 564). `parseValueSubquery` turns
  // `VALUE { … RETURN count(*) }` into a `countSubquery` node — item 499's lowering onto the
  // degree path — and a rewrite that manufactures the `valueSubquery` form instead misses it
  // entirely. Measured at 200,000 vertices / 300,000 edges:
  //
  //   CALL (n) { … RETURN count(*) AS c } RETURN sum(c)   504.16 ms as a valueSubquery
  //   LET c = VALUE { … RETURN count(*) } RETURN sum(c)   151.30     the parsed spelling
  //
  // 3.3x for the same question, because one node kind reaches the degree rung and the other
  // does not. The conditions below are `parseValueSubquery`'s, copied rather than approximated.
  const sub: Extract<Expr, { kind: 'valueSubquery' | 'countSubquery' }> =
    agg.kind === 'func' && agg.name === 'count' && agg.star && !agg.distinct
      ? {
          kind: 'countSubquery',
          patterns: bm.patterns,
          ...(bm.where === undefined ? {} : { where: bm.where }),
        }
      : {
          kind: 'valueSubquery',
          patterns: bm.patterns,
          ...(bm.where === undefined ? {} : { where: bm.where }),
          ret: agg,
        };

  // See the header: scope checking has already run, so this node would otherwise be memoized
  // as uncorrelated.
  correlatedSubqueries.add(sub);

  return { kind: 'let', items: [{ var: alias, expr: sub }] };
};

/**
 * `CALL (n) { MATCH (n)-[:T]->(x) RETURN x }` IS `MATCH (n)-[:T]->(x)` — a correlated inline
 * call whose body is one pattern and a `RETURN` of the names that pattern introduces, rewritten
 * to the plain `MATCH` it is equivalent to.
 *
 * The call runs its body once per incoming row through the general matcher, so
 * `MATCH (n:Person) CALL (n) { MATCH (n)-[:KNOWS]->(x) RETURN x } RETURN count(*)` cost
 * **996.2 ms** at 200,000 vertices / 1,000,000 edges against the native engine's 6.2, and
 * against **0.0** for the same question written as one pattern (audit item 513).
 *
 * Rewriting rather than adding a rung is what makes it cheap: the result is an ordinary `MATCH`
 * clause, which item 507's fusion then merges into the preceding one, after which every rung of
 * the ladder applies. Three rewrites composing (512's `LET`, this, 507's fusion) and no new
 * execution path.
 *
 * What it refuses, and why each would change the answer:
 *
 *   - `OPTIONAL CALL` — a left-outer join keeps the row when the body yields nothing, which a
 *     plain `MATCH` does not;
 *   - an UNCORRELATED call (an empty scope). Its mutant SURVIVES, and the reason is that the
 *     join result coincides: a body with no correlation yields the same rows for every outer
 *     row, so joining them is the cross product a second `MATCH` would produce. The guard stays
 *     because the execution contract does not coincide — the call runs its body ONCE and reuses
 *     it, which may well be the better plan, and turning that into a cross product is a change
 *     with its own number rather than a free one;
 *   - a body with set operators, more than one `MATCH`, or anything but `MATCH … RETURN`;
 *   - a `RETURN` that is not exactly bare variables (an alias, an expression, `*`, `DISTINCT`,
 *     a grouping, an `ORDER BY` or a page) — the call yields COLUMNS, and anything computed is
 *     not the pattern's own binding;
 *   - a body that binds a name it does NOT return. The call hides it; a plain `MATCH` would
 *     leave it bound, which `RETURN *` and any later clause can see. The set equality below is
 *     what enforces that, and it is the one condition whose violation is invisible in the
 *     common shapes.
 */
/**
 * `CALL (n) { MATCH … RETURN <agg> AS c }` → `LET c = VALUE { MATCH … RETURN <agg> }`.
 *
 * An UN-GROUPED aggregate body yields exactly ONE row per outer row — null or 0 over an empty
 * match, never nothing — so the lateral join neither drops nor multiplies rows and the call is a
 * per-row SCALAR. That is precisely a `VALUE {}` subquery, which has rungs (items 499, 557) where
 * the CALL route has none. Measured at 200,000 vertices / 200,000 edges, one case per process:
 *
 * ```text
 *   CALL (n) { MATCH (n)-[:KNOWS]->(x) RETURN count(*) AS c } RETURN sum(c)   760.86 ms
 *   RETURN sum(COUNT { MATCH (n)-[:KNOWS]->(x) })                             30.56
 * ```
 *
 * 24.9x between two spellings of one question.
 *
 * THE MANUFACTURED NODE MUST BE MARKED CORRELATED, and item 562 retracted this whole rewrite for
 * one tick because it was not. `markIfCorrelated` populates a WeakSet during SCOPE CHECKING, which
 * runs over the PARSED AST — so a subquery node a rewrite MANUFACTURES is never in it, and
 * `memoizeIfUncorrelated` then computes the per-row scalar ONCE and reuses it:
 *
 * ```text
 *   CALL (n) { … RETURN count(*) AS c } RETURN sum(c) AS t, count(*) AS r
 *     unmarked  {t: 6, r: 3}      one node's degree of 2, counted three times
 *     marked    {t: 2, r: 3}      native's answer
 * ```
 *
 * The node IS correlated by construction — this rewrite fires only when `c.scope` is non-empty,
 * i.e. the call imports outer names — so the marking is a statement of that fact rather than an
 * analysis. Any future rewrite that manufactures an `exists`/`countSubquery`/`valueSubquery` node
 * has the same obligation.
 *
 * `inlineCorrelatedCall` below handles the OTHER body shape, a pass-through that yields pattern
 * variables, by turning the call into a plain MATCH. That rewrite is wrong here (an aggregate body
 * yields a VALUE, not a binding) and this one is wrong there (a pass-through yields many rows), so
 * they are separate and each refuses the other's shape.
 *
 * ONE aggregate item only. Two of them is a shape the engines DISAGREE about — native rejects
 * `RETURN count(*) AS c, max(x.n) AS m` inside a CALL body ("an aggregating RETURN inside …")
 * while TS answers it — so it stays on the general path rather than becoming a faster divergence
 * (item 557's policy, and the fifth such subquery-body refusal found).
 */
const inlineAggregateCall = (clauses: readonly Clause[]): readonly Clause[] => {
  let changed = false;
  const out = clauses.map((c) => {
    const rewritten = asLet(c);

    if (rewritten === null) {
      return c;
    }

    changed = true;

    return rewritten;
  });

  return changed ? out : clauses;
};
const inlineCorrelatedCall = (clauses: readonly Clause[]): readonly Clause[] => {
  const asMatch = (c: Clause, tail: readonly Clause[]): readonly Clause[] | null => {
    if (c.kind !== 'callInline' || c.optional || c.scope.length === 0) {
      return null;
    }

    const { parts, ops } = c.body;

    if (parts.length !== 1 || ops.length > 0) {
      return null;
    }

    const inner = parts[0].clauses;

    if (inner.length !== 2) {
      return null;
    }

    const [bm, bret] = inner;

    if (bm.kind !== 'match' || bm.optional || bm.patterns.length !== 1 || bret.kind !== 'return') {
      return null;
    }

    const proj = bret.projection;

    if (
      proj.star ||
      proj.distinct ||
      proj.groupBy !== undefined ||
      proj.having !== undefined ||
      (proj.orderBy?.length ?? 0) > 0 ||
      proj.skip !== undefined ||
      proj.limit !== undefined
    ) {
      return null;
    }

    // A PASS-THROUGH yield (`RETURN x`) needs nothing but the MATCH — the pattern already binds
    // that name. A COMPUTED one (`RETURN x.k AS c`) needs a `LET`, and item 1661 priced the
    // difference between having it and not: `CALL (n) { MATCH (n)-[:E]->(x) RETURN x.k AS c }`
    // cost 3136 ns an outer row against 333 for the two clauses this emits, 9.4x, because the
    // CALL route has no rung at all and `[match, let]` lands on the hop projection.
    const plain = new Set<string>();
    const computed: { var: string; expr: Expr }[] = [];
    const aliases = new Set<string>();

    for (const item of proj.items) {
      if (item.expr.kind === 'var' && (item.alias === undefined || item.alias === item.expr.name)) {
        plain.add(item.expr.name);
        continue;
      }

      // `cheapPureExpr` is `prop | var | lit | param`, so this admits `x.k`, `x AS y`, a literal
      // and a parameter. It is doing two jobs: the expression must be TOTAL, because a `LET`
      // evaluates it on every matched row where the body's RETURN did too (the same rows — but a
      // throwing expression inside an OPTIONAL-shaped body would differ, and `optional` is
      // already refused above); and it must be AGGREGATE-FREE, which the four kinds give for
      // nothing. An aggregate here is `inlineAggregateCall`'s shape and a different cardinality.
      if (item.alias === undefined || !cheapPureExpr(item.expr)) {
        return null;
      }

      computed.push({ var: item.alias, expr: item.expr });
      aliases.add(item.alias);
    }

    if (aliases.size !== computed.length) {
      return null;
    }

    const imported = new Set(c.scope);
    const introduced = [...patternNames(bm.patterns[0])].filter((n) => !imported.has(n));

    // A pass-through yield must be a name the PATTERN introduced. Yielding an imported name back
    // out is a no-op the general path can keep.
    for (const n of plain) {
      if (!introduced.includes(n)) {
        return null;
      }
    }

    // An alias becomes a new column on the outer row, so it may not be a name that is already
    // there — imported — nor one the emitted MATCH leaves bound.
    for (const a of aliases) {
      if (imported.has(a) || introduced.includes(a)) {
        return null;
      }
    }

    // ⚠️ THE ESCAPING NAMES ARE THE WHOLE DIFFICULTY, and they are why item 1661 priced this
    // route but did not build it. The body's pattern introduces `x`; the CALL yields only
    // `x.k AS c` and HIDES `x`. The emitted `MATCH` cannot hide it — a plain MATCH binds what it
    // matches — so after the rewrite `x` is live where the call had scoped it away. That is
    // observable: a later `MATCH (x)` would correlate instead of fresh-scanning, a later
    // `LET x = …` would collide, and `RETURN *` would emit a column that is not in the answer.
    //
    // The route item 1661 named — manufacture a projection that DROPS them — needs the set of
    // names bound BEFORE the call, which is a bind-site walker whose failure mode is dropping a
    // LIVE name. Proving the leak UNOBSERVABLE is the other direction, and it is the one this
    // repo already answered: `nameIsUnread` is the predicate `dropUnreadPathVar` (item 1049) and
    // `dropUnreadEdgeVar` were built on, and the question those ask is identical to this one —
    // "is this pattern variable provably unread by everything after the clause". It refuses on
    // any doubt: an unknown clause kind in the tail, a `RETURN *`, a rebinding, a subquery that
    // `freePredicateVars` cannot see into. Reusing it rather than writing a second scanner is
    // the point: two escape analyses of the same question would drift, and the one that drifted
    // would be wrong silently.
    //
    // `where` is passed as `undefined` on purpose. Its role there is the MATCH's own predicate,
    // which those rewrites keep while deleting the variable from the pattern — a reference it
    // must not miss. Here nothing is deleted: the emitted MATCH keeps both the pattern and the
    // `WHERE`, so a reference to `x` inside `bm.where` is still bound and is not an escape.
    const escaping = introduced.filter((n) => !plain.has(n));

    if (escaping.some((n) => !nameIsUnread(n, undefined, tail))) {
      return null;
    }

    const match: Clause = {
      kind: 'match',
      optional: false,
      patterns: bm.patterns,
      where: bm.where,
    };

    return computed.length === 0 ? [match] : [match, { kind: 'let', items: computed }];
  };

  let changed = false;
  const out: Clause[] = [];

  for (const [i, c] of clauses.entries()) {
    const m = asMatch(c, clauses.slice(i + 1));

    if (m === null) {
      out.push(c);
      continue;
    }

    changed = true;
    out.push(...m);
  }

  return changed ? out : clauses;
};
/** The ANCHOR half of `fuseAnchorThenHop`: a lone `MATCH (v …)` binding exactly one node. */
/**
 * Is this pattern's path shape the plain default — every match, no repetition restrictor?
 *
 * A SELECTOR or a non-default MODE describes the WHOLE path, so concatenating two patterns
 * under one of them is a different question: `ANY SHORTEST` over the join is not two
 * independent matches, and `SIMPLE` would forbid repeating a node ACROSS the join where the
 * two-clause form allows it.
 *
 * Compared against the DEFAULTS rather than `undefined`, which is the bug this comment exists
 * for: `parsePathPattern` writes `selector: 'walk'` and `mode: 'trail'` onto every pattern it
 * builds, so an `=== undefined` test refuses everything — fusion silently stopped firing
 * altogether (11 fusions in its own test file to 0) while every test still passed, because a
 * rewrite that declines is only slower. The instrumented count is what caught it.
 *
 * `trail` is the written default and is NOT enforced on a fixed-length pattern in either
 * engine: `MATCH (a:P)-[:T]->(x)-[:T]->(y)` over a self-loop counts the path that reuses that
 * one edge, and so does the two-clause spelling — checked in both engines before relying on it.
 */
const defaultPathShape = (p: PathPattern): boolean =>
  (p.selector === undefined || p.selector === 'walk') &&
  (p.mode === undefined || p.mode === 'trail');
const anchorOf = (c: Clause): (Extract<Clause, { kind: 'match' }> & { v: string }) | undefined => {
  if (c.kind !== 'match' || c.optional || c.patterns.length !== 1) {
    return undefined;
  }

  const [p] = c.patterns;
  // The variable the NEXT clause can attach to is the one at the pattern's far END — its start
  // when the pattern is a lone node, otherwise its last segment's node. Item 505 took only the
  // lone-node case, so a THIRD clause never chained: `MATCH (a:P)-[:T]->(x) MATCH (x)-[:T]->(y)`
  // cost 2286.3ms against 103.4 for the one-clause spelling, and native charges 2.7 for both
  // (item 506).
  const last = p.segments.at(-1);
  const v = last === undefined ? p.start.variable : last.node.variable;

  return p.pathVar === undefined && v !== undefined && defaultPathShape(p)
    ? { ...c, v }
    : undefined;
};
/** The pair half of `fuseAnchorThenHop`: `a` then `b` as one clause, or `undefined`. */
const fuse = (a: Clause, b: Clause): Clause | undefined => {
  const anchor = anchorOf(a);

  if (
    anchor === undefined ||
    b.kind !== 'match' ||
    b.optional ||
    b.patterns.length !== 1 ||
    (anchor.where !== undefined && b.where !== undefined)
  ) {
    return undefined;
  }

  const [hop] = b.patterns;
  const { start } = hop;

  const [anchorPattern] = anchor.patterns;

  if (
    hop.pathVar !== undefined ||
    hop.segments.length === 0 ||
    start.variable !== anchor.v ||
    start.label !== undefined ||
    start.where !== undefined ||
    (start.properties !== undefined && start.properties.length > 0) ||
    // The hop's own selector/mode would come to describe the CONCATENATED path once the
    // anchor contributes segments of its own, so it is only safe to carry over a bare anchor.
    (anchorPattern.segments.length > 0 && !defaultPathShape(hop))
  ) {
    return undefined;
  }

  return {
    kind: 'match',
    optional: false,
    patterns: [
      {
        ...hop,
        start: anchorPattern.start,
        segments: [...anchorPattern.segments, ...hop.segments],
      },
    ],
    where: anchor.where ?? b.where,
  };
};
/**
 * `MATCH (a:L {k: 5})-[:T]->(b)` IS `MATCH (a:L)-[:T]->(b) WHERE a.k = 5` — an inline property on
 * the hop's START lifted into the clause `WHERE`, before anything looks at the clause list
 * (item 778).
 *
 * `plainNode` is `(n.properties?.length ?? 0) === 0 && n.where === undefined`, so an inline
 * property on the START refuses `detectHopProjection` outright while the clause spelling is
 * admitted. Item 777 measured the pair at **8.69 / 8.34 / 8.42 ms against 1.00 / 1.00 / 0.99** over
 * three reads of `MATCH (a:P {k: 5})-[:E]->(b) RETURN b.k` and its clause twin, with equal row
 * counts asserted — **8.4x**, both answers correct. The FAR node has no such problem:
 * `closedFarPred` pushes an inline predicate there into the walk, which is why the mirror pair
 * runs the OTHER way (inline on the end is 1.7x FASTER). So inline predicates were pushed down at
 * one end of the same hop and fatal at the other.
 *
 * A REWRITE rather than a second predicate position in the fast path, which is item 505's shape
 * and for its reason: the rewritten clause is an ordinary pattern, so every rung of the ladder
 * applies to it with no rung knowing this happened.
 *
 * Each refusal below is a case where the lifted form would not mean the same thing:
 *
 *   - **a NULL literal value stays inline.** `{k: null}` is IS NULL (item 260) — it matches a
 *     STORED null — where `a.k = null` is UNKNOWN and matches nothing. This is the one refusal
 *     that changes an answer rather than a plan, and it is the reason this rewrite is narrow.
 *   - **a PARAM value stays inline.** `{k: $p}` cannot be shown non-null at compile time, so it
 *     inherits the hazard above.
 *   - **a start with no VARIABLE stays inline**: `MATCH (:P {k: 5})-…` has no name to write
 *     `?.k = 5` against. (Item 776's synthesized name is for a BINDING nothing reads; a `WHERE`
 *     referencing one would have to be bound before the predicate runs, which is a different
 *     question.)
 *   - **a clause that already carries a `WHERE` stays as it is.** Combining the two needs an
 *     `AND` whose operand order carries the short-circuit contract of items 258/259 — the same
 *     refusal `fuse` makes, for the same reason, and worth its own measurement rather than a
 *     guess here.
 *   - a clause with more than one pattern, or a pattern with no segments (a bare node, which is
 *     already served by the scan rungs and would gain nothing).
 */
/**
 * EXPORTED for its own unit test, per `perf-gate-needs-its-own-test`. The rewrite is
 * answer-equivalent by construction, so no answer test can see it — mutation proved exactly that:
 * restoring the `patterns.length !== 1` refusal left all 3,401 tests green, including route
 * assertions that count vertex pulls. Those were vacuous here because inline props ALREADY seed
 * through `indexCandidates`'s `node.pred.props` path whether they are lifted or not, so the lift
 * is not what enables the seek and a seeding assertion cannot detect its absence.
 */
export const liftStartProps = (clauses: readonly Clause[]): readonly Clause[] =>
  clauses.map((c) => {
    if (c.kind !== 'match' || c.where !== undefined) {
      return c;
    }

    // MULTI-PATTERN CLAUSES LIFT TOO (item 1333). This refusal used to be `patterns.length !== 1`,
    // listed in the header above with no reason beside it — an unmeasured scope limit rather than a
    // decision, and the GQL spelling probe was measuring what it cost. On that probe's fixture,
    // the group alone: `MATCH (a:S), (b:P {k: 7})` read ~24.7 ms against ~11.9 for the inline
    // `WHERE` that means the same thing, and 13.29 after this change — 1.86x, flag cleared, five
    // processes before and eight after.
    //
    // ⚠️ THE MECHANISM IS NOT SEEDING, and the first version of this comment said it was. Inline
    // props ALREADY seed: `indexCandidates` reads `node.pred.props` directly, lifted or not.
    // Mutation proved it — restoring the old refusal left all 3,401 tests green INCLUDING route
    // assertions that count vertex pulls, which is only possible if the seek happens either way.
    // What the lifted form actually saves is NOT YET IDENTIFIED; the measurement is solid and the
    // explanation is open, so anyone extending this should not assume the seed hint is the reason.
    // ⚠️ A CLAUSE BINDING A PATH VARIABLE DOES NOT LIFT, and the suite found this rather than the
    // reasoning: `MATCH p = (a:P {k: 1}), (p:P {k: 2}) RETURN count(*)` must RAISE on the
    // collision between the path variable `p` and the node variable `p`, and it raises only
    // because the product-of-counts shortcut DECLINES and the general path gets there. Adding a
    // `where` routed the shortcut elsewhere and it answered 0 instead — a query that must error
    // returning a row, which is the one kind of regression a performance rewrite must never cause.
    //
    // This is the same hazard item 778 records one case along: "one rung's admission gate is
    // another rung's disqualifier, which is the real hazard in rewriting a clause list and is not
    // visible from the gate being opened."
    if (c.patterns.some((pattern) => pattern.pathVar !== undefined)) {
      return c;
    }

    const conjuncts: Expr[] = [];

    const patterns = c.patterns.map((pattern) => {
      const { start } = pattern;
      const props = start.properties ?? [];
      const name = start.variable;

      if (
        name === undefined ||
        props.length === 0 ||
        // ⚠️ THE BARE-NODE REFUSAL USED TO LIVE HERE AND IT WAS PRICED WRONG (item 1558). Its own
        // comment read "the scan rungs already serve it and the lift gains nothing — measured equal
        // at 3.36 against 3.55 ms", and that equality was an INSTRUMENT ARTIFACT: the three
        // spellings of the group were timed in ONE process, so the clause arm ran second through
        // call sites the inline arm had just made polymorphic (item 762's redistribution shape).
        // One shape per process, three runs each, the inline spelling is 1.37-1.56x SLOWER without
        // the lift and both twins are flat:
        //
        //     config            arm      PRE     POST
        //     indexed, 200k     inline   0.26    0.19   1.37x   clause 0.19 -> 0.19
        //     scan,    200k     inline   3.79    2.43   1.56x   clause 2.56 -> 2.43
        //     scan,    600k     inline  11.81    7.93   1.49x   clause 7.38 -> 7.47
        //
        // The indexed row is the one that had to be checked before taking it: lifting an inline
        // property into a clause `WHERE` could have cost the index SEEK, and it does not — all
        // three spellings converge at 0.19 ms, so the seeder recognizes the lifted form.
        // A QUANTIFIED segment stays inline, and this one was found by the suite rather than
        // reasoned out. Lifting is not free: a clause `WHERE` DISQUALIFIES the unbounded
        // var-length BFS rung, so `MATCH (a:N {k: 1})-[:E]->+(b) RETURN DISTINCT b` stopped
        // taking it and fell to the general path, which then FAULTED on the trail budget —
        // `reachability.test.ts` turned two passes into two errors. One rung's admission gate is
        // another rung's disqualifier, which is the real hazard in rewriting a clause list and
        // is not visible from the gate being opened.
        pattern.segments.some((seg) => seg.rel.quantifier !== undefined) ||
        // A NULL literal means IS NULL and a USER param could BE null — neither lifts (item 260).
        //
        // ⚠️ A SYNTHETIC PARAM DOES LIFT, and not admitting it had silently disabled this whole
        // rewrite (item 1556). Auto-parameterization (item 1502) runs BEFORE the parse, so
        // `MATCH (a:P {k: 5})` reaches here as `{k: $__ap0}` — `kind: 'param'`, not `'lit'` — and
        // the old test refused it. Item 778 built this rewrite and measured the pair converging at
        // 0.95 ms; a later feature turned it off for every inline-literal query, and the GQL
        // spelling probe is what caught it:
        //
        //     MATCH (a:P {k: 5})-[:E]->(b) RETURN b.k         51.44 ms  ->  9.52
        //     MATCH (a:P)-[:E]->(b) WHERE a.k = 5 RETURN b.k   9.47        9.47
        //
        // Sound because `normalizeLiterals` lifts only numbers and strings — `null`, `true` and
        // `false` are refused there, verified rather than assumed — so a synthetic param cannot be
        // the null that item 260 is about. A caller's own `$p` still refuses.
        !props.every(
          (pc) =>
            (pc.value.kind === 'lit' && pc.value.value !== null) ||
            (pc.value.kind === 'param' && isSyntheticParam(pc.value.name)),
        )
      ) {
        return pattern;
      }

      for (const pc of props) {
        conjuncts.push({
          kind: 'compare',
          op: '=',
          left: { kind: 'prop', variable: name, key: pc.key },
          right: pc.value,
        });
      }

      return { ...pattern, start: { ...start, properties: undefined } };
    });

    // Nothing lifted: return the ORIGINAL clause, not a rebuilt one. A rebuilt-but-identical
    // clause would defeat the identity checks the caller's other rewrites rely on.
    if (conjuncts.length === 0) {
      return c;
    }

    return {
      ...c,
      patterns,
      where: conjuncts.length === 1 ? conjuncts[0] : { kind: 'and', items: conjuncts },
    };
  });
const fuseAnchorThenHop = (clauses: readonly Clause[]): readonly Clause[] => {
  const out: Clause[] = [];

  for (const clause of clauses) {
    const prev = out.at(-1);
    const fused = prev === undefined ? undefined : fuse(prev, clause);

    if (fused === undefined) {
      out.push(clause);
    } else {
      out[out.length - 1] = fused;
    }
  }

  return out;
};
/**
 * Make an `OPTIONAL MATCH` non-optional when the projection cannot see the difference.
 *
 * An optional match contributes ONE null-filled row per start with no match. Every aggregate in
 * this engine drops nullish values before folding (the general path's `nonNull`, which
 * `aggregateOverValues` is handed), so those rows change nothing — **except** for `count(*)`,
 * which counts ROWS and therefore counts them. So for an un-grouped projection whose aggregates
 * are all argument-taking, `OPTIONAL MATCH … RETURN <agg>(x.k)` is the same question as
 * `MATCH … RETURN <agg>(x.k)` — and the second has had a rung since item 418.
 *
 * The enum that found this, 200,000 vertices / 200,000 edges, one case per process:
 *
 * ```text
 *                                                              TS        native
 *   MATCH (n:P) OPTIONAL MATCH (n)-[:T]->(x) RETURN count(*)     8.12 ms   0.66 ms
 *   ...RETURN count(x)                                         410.12      1.30
 *   ...RETURN max(x.age)                                       475.90      1.52
 * ```
 *
 * `count(*)` has had the rung since item 546; the other two were 315x and 313x off native because
 * an OPTIONAL match declines every aggregate rung there is.
 *
 * REFUSED, each because the null-filled row IS observable:
 *
 *   - `count(*)` or `RETURN *` — a row counter sees them.
 *   - a GROUPED projection, explicit or implicit. `RETURN n.k, max(x.v)` keeps a group for an
 *     unmatched start (with a null aggregate) where the non-optional form drops it — four groups
 *     against two on the test fixture — and a `GROUP BY` over `x.k` would keep a null KEY.
 *   - a projection with no aggregate at all, which is just the rows (five against three).
 *
 * TWO of those conditions are REDUNDANT today and kept deliberately, which the mutation run made
 * explicit. `!proj.star` is implied by `items.length > 0`, since a bare `RETURN *` projects no
 * items; `groupBy`/`having` are implied by `items.every(hasAggregate)`, since an explicit GROUP BY
 * key has to appear as a non-aggregate item and `RETURN` never sets `having` (only `SELECT` does).
 * Both stay because the implication runs through another part of the projection rather than
 * through anything local — the same reason `detectHopAggregate` keeps its `groupKeys` check.
 */
const unoptionalizeForAggregate = (clauses: readonly Clause[]): readonly Clause[] => {
  if (clauses.length < 2) {
    return clauses;
  }

  const ret = clauses[clauses.length - 1];
  const prev = clauses[clauses.length - 2];

  if (ret?.kind !== 'return' || prev?.kind !== 'match' || !prev.optional) {
    return clauses;
  }

  const proj = ret.projection;
  const nullBlind =
    !proj.star &&
    proj.groupBy === undefined &&
    proj.having === undefined &&
    proj.items.length > 0 &&
    proj.items.every(
      (it) =>
        hasAggregate(it.expr) &&
        // A STAR count is the one aggregate that sees a null-filled row, so one anywhere in the
        // projection — even beside an argument-taking one — refuses the whole rewrite.
        collectAggregates(it.expr).every((a) => !a.star && a.args.length === 1),
    );

  if (!nullBlind) {
    return clauses;
  }

  return [...clauses.slice(0, -2), { ...prev, optional: false }, ret];
};
/**
 * `MATCH (n) WHERE n IS LABELED L` → `MATCH (n:L)` (item 1303).
 *
 * The two are the same question by CONSTRUCTION, not by an equivalence argument: a pattern label
 * is tested with `matchesLabel` and `IS LABELED` with `labelsMatch`, and both are one call to the
 * same `evalLabelExpr` over the same `LabelExpr` and the same label set. `IS LABELED` is also
 * TOTAL on an element — it yields TRUE or FALSE, never UNKNOWN — so there is no three-valued
 * `WHERE` row-drop for the pattern form to lose, and nothing here can raise, so raise parity
 * (items 139-145) is untouched.
 *
 * WHY IT IS WORTH A REWRITE RATHER THAN A NEW RUNG. The clause spelling reaches the general walk
 * and the pattern spelling reaches a bucket, and the spread is not a constant factor:
 *
 * ```text
 *                                                        ns/vertex   answer
 *   MATCH (n:Employee) RETURN count(*)                        0.01   100000   ← bucket SIZE
 *   MATCH (n) WHERE n IS LABELED Employee RETURN count(*)   119.46    100000   ← walks all 200k
 *   a hand-written `v.labels.has('Employee')` loop            22.51   100000   ← the FLOOR
 * ```
 *
 * So the clause spelling is 5.31x off its own floor where the property twin (`n.age >= 45`,
 * selectivity matched by construction) is only 1.93x off its, and the pattern spelling does not
 * visit a vertex at all. On a one-hop count the same pair reads 196.12 against 16.61 (11.8x),
 * because `bareDegreeSum` is a closed-form degree sum over the far label's bucket and declines
 * outright when `farLifted !== undefined` — which the clause spelling always sets.
 *
 * ⚠️ THE 11.8x IS FIXTURE-DEPENDENT AND ITEM 1302'S OPEN QUESTION IS STILL OPEN. Start-label
 * vacuity is ONE variable and it is measured — a 2x2 on one graph, one shape per process, answers
 * identical within each row:
 *
 * ```text
 *                              pattern   clause    ratio   answer
 *   vacuous start (:Person)      18.77   195.73    10.4x   100000
 *   non-vacuous start (:Mgr)     55.91    82.42     1.47x    33333
 * ```
 *
 * With a start label the planner cannot drop, both spellings fail `bareDegreeSum`'s precondition
 * and converge. BUT THAT DOES NOT EXPLAIN THE SPELLING PROBE'S 1.34x, and a first version of this
 * note claimed it did. That fixture labels EVERY vertex `P`, so its `(a:P)` start label is vacuous
 * too and it belongs in the top row, where the gap is 10.4x. So a second variable is doing the
 * work there and the suspect item 1302 recorded — MULTI-LABEL EDGES, `["E","F"]` on 1 in 11, which
 * is what disables the analogous Gremlin path through `multiTypeEdgeCount` — survives untested,
 * because every edge in the 2x2 above is single-label.
 *
 * None of this changes the fold: after it, the clause spelling IS the pattern spelling, so the two
 * converge whatever the fixture does. It changes only what may be claimed about WHY the unfolded
 * gap varies, which is why the number above is reported per-fixture and not as one ratio.
 *
 * Done as a CLAUSE REWRITE and not as a tenth lifted family on purpose. Every rung already handles
 * a pattern label — scans, one/two/three-hop counts, the fused hop projection, the endpoint
 * extremum — so folding reaches all of them at once, where a `labelTests` route would have to be
 * taught to each. It is also why this is cheap to get right: `plainNode` tests `properties` and
 * `where` and NOT `label`, so a folded label cannot make a rung's `plainNode` guard decline.
 *
 * The detector is `asLabelTest`, shared with `liftLabelTest` rather than re-written here, so the
 * `NOT (n IS LABELED L)` spelling folds too and the two cannot drift on what counts as a label
 * test. A negated test folds to a `not` LabelExpr, which `seedLabel` refuses to seed from — so it
 * becomes a plain scan with `matchesLabel` instead of a scan with a lifted predicate, still a gain
 * and never a seek that could hand back a superset.
 */
// EXPORTED for its own assertion, the way `compileLinear`, `predFor` and `selectiveFirst` already
// are, and deliberately not from `index.ts` — the package's public surface is unchanged.
//
// It needs one because a ROUTE assertion is too blunt to see it: `countShortcut` fires for the
// clause spelling as well as the pattern one (it handles a clause `WHERE` through `farLifted`,
// just slowly), so "which detector fired" is IDENTICAL either way and an assertion on that passes
// with the fold disabled. Measured, not assumed — with the fold turned off, five of six route
// twins still passed and only the projection twin failed. The rewrite has to be asserted as a
// rewrite: the label lands on the node and the `WHERE` is gone.
export const foldLabelTestsIntoPatterns = (clauses: readonly Clause[]): readonly Clause[] => {
  // `optional` is excluded, and it is the one exclusion that is about a question rather than a
  // mechanism: moving a filter into an OPTIONAL pattern changes which rows are PRESERVED with
  // nulls, and item 1226's `OPTIONAL MATCH` conformance decision is still open. An optimization
  // must not be the thing that settles it.
  const foldable = clauses.some(
    (clause) => clause?.kind === 'match' && !clause.optional && clause.where !== undefined,
  );

  if (!foldable) {
    return clauses;
  }

  return clauses.map((clause) =>
    clause?.kind === 'match' && !clause.optional && clause.where !== undefined
      ? foldOneMatch(clause)
      : clause,
  );
};
/** Rewrite one `MATCH` clause, or hand it back unchanged when no conjunct folds. */
const foldOneMatch = (clause: MatchClause): MatchClause => {
  const sites = foldSitesOf(clause);

  if (sites.size === 0) {
    return clause;
  }

  const kept: Expr[] = [];
  // The label each site gains, accumulated so that TWO tests on the same variable both land —
  // `WHERE n IS LABELED A AND n IS LABELED B` folds to `(n:A&B)`, which `seedLabel` can still
  // seed from (it takes either side of an `and`).
  const gained = new Map<NodePattern, LabelExpr>();

  for (const conjunct of flattenConjuncts(clause.where!)) {
    const test = asLabelTest(conjunct);
    const site = test?.expr.kind === 'var' ? sites.get(test.expr.name) : undefined;

    if (test === null || site === undefined || site.poisoned) {
      kept.push(conjunct);
      continue;
    }

    const add: LabelExpr = test.negated ? { kind: 'not', expr: test.label } : test.label;
    const already = gained.get(site.node) ?? site.node.label;

    gained.set(site.node, already === undefined ? add : { kind: 'and', left: already, right: add });
  }

  if (gained.size === 0) {
    return clause;
  }

  const relabel = (n: NodePattern): NodePattern => {
    const label = gained.get(n);

    return label === undefined ? n : { ...n, label };
  };

  // `where` is DESTRUCTURED OFF rather than overwritten with `undefined`, so that a clause whose
  // every conjunct folded is structurally identical to the same query written with the label in the
  // pattern — no `where` key at all, not a `where` key holding `undefined`.
  //
  // ⚠️ IT IS NOT A MEASURED WIN, and the first version of this comment claimed it was. With the key
  // present the folded hop read 24.30 ns/v against the pattern spelling's 17.06, which looked like
  // the key costing something; after the change the PATTERN arm — which this cannot touch — read
  // 27.57 against the folded clause's 23.25, so that shape simply bounces ~1.6x run to run and the
  // original gap was inside it. The destructure stays on the argument that the two spellings must
  // become ONE clause object and not two that differ in a key, which is this pass's whole claim.
  const { where: _folded, ...rest } = clause;
  const patterns = clause.patterns.map((pattern) => ({
    ...pattern,
    start: relabel(pattern.start),
    segments: pattern.segments.map((seg) => ({ ...seg, node: relabel(seg.node) })),
  }));

  // Every conjunct folded means the clause has no `WHERE` left at all, which is the state that
  // lets `pred.fn === alwaysTrue` and so lets `bareDegreeSum` take the hop.
  return kept.length === 0 ? { ...rest, patterns } : { ...rest, patterns, where: andExprOf(kept) };
};
const foldPageIntoReturn = (clauses: readonly Clause[]): readonly Clause[] => {
  if (clauses.length < 2) {
    return clauses;
  }

  const page = clauses[clauses.length - 2];
  const ret = clauses[clauses.length - 1];

  if (page?.kind !== 'page' || ret?.kind !== 'return') {
    return clauses;
  }

  const sorts = page.orderBy ?? [];
  const proj = ret.projection;

  if (
    sorts.length === 0 ||
    proj.star ||
    proj.distinct ||
    proj.groupBy !== undefined ||
    proj.having !== undefined ||
    proj.orderBy !== undefined ||
    proj.skip !== undefined ||
    proj.limit !== undefined ||
    proj.items.length === 0 ||
    proj.items.some((it) => hasAggregate(it.expr))
  ) {
    return clauses;
  }

  // 🛑 THE FAULT REFUSAL (item 1056), and it is a WRONG-ANSWER refusal like the aggregation one
  // rather than a cost one. This fold's justification is that "a row-wise projection preserves row
  // identity", so sorting-then-projecting and projecting-then-sorting give the same ordered rows.
  // True of the ORDER — and not of FAULTS. When the page DROPS rows, the unfolded form evaluates
  // the projection only for survivors, where the folded form evaluates it for every row and then
  // pages: so a row the `OFFSET` would have discarded can raise, and the query errors where it
  // should have returned rows.
  //
  // Found by the differential fuzzer at `FUZZ_SEED=3076589914` (items 1054/1055) and CONFIRMED by
  // disabling this fold, which turned all three real divergences into agreement:
  //
  //   MATCH (n:T) WHERE n.n = 3 ORDER BY … OFFSET 1 RETURN <faulting expr> AS x
  //     ts  raises      native  []          <- native is right; the row was skipped
  //
  // Narrow on BOTH conditions, so the measured win survives: with no `skip`/`limit` no row is
  // dropped and the two forms fault identically, and item 969's own 3.72x case
  // (`ORDER BY n.k LIMIT 10 RETURN n.k AS c`) projects a plain property read, which cannot fault.
  if (
    (page.skip !== undefined || page.limit !== undefined) &&
    !proj.items.every((it) => cannotFault(it.expr))
  ) {
    return clauses;
  }

  // The shadowing refusal. A key reading a name this projection introduces would re-resolve to
  // the OUTPUT column once the sort sits on the `RETURN`.
  // An item with no alias still names a column: for a BARE VARIABLE that name is the variable
  // itself, so `RETURN n ORDER BY n` would re-resolve after the fold exactly as an alias would.
  // Anything else un-aliased gets a compound implicit name that cannot collide with a bare
  // identifier key, so it needs no entry here.
  const aliases = new Set(
    proj.items
      .map((it) => it.alias ?? (it.expr.kind === 'var' ? it.expr.name : undefined))
      .filter((a) => a !== undefined),
  );

  for (const sort of sorts) {
    for (const name of freePredicateVars(sort.expr)) {
      if (aliases.has(name)) {
        return clauses;
      }
    }
  }

  return [
    ...clauses.slice(0, clauses.length - 2),
    {
      ...ret,
      projection: { ...proj, orderBy: sorts, skip: page.skip, limit: page.limit },
    },
  ];
};
const dropVacuousPage = (clauses: readonly Clause[]): readonly Clause[] => {
  const out: Clause[] = [];

  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i];

    if (clause === undefined) {
      continue;
    }

    if (clause.kind !== 'page') {
      out.push(clause);
      continue;
    }

    const skipsNothing = clause.skip === undefined || clause.skip === 0;

    if (!skipsNothing || clause.limit !== undefined) {
      out.push(clause);
      continue;
    }

    const sorts = clause.orderBy ?? [];

    if (sorts.length === 0) {
      continue;
    }

    const next = clauses[i + 1];

    if (
      next?.kind !== 'return' ||
      !oneOrderFreeRow(next) ||
      !sorts.every((sort) => faultFreeSortKey(sort.expr))
    ) {
      out.push(clause);
    }
  }

  return out.length === clauses.length ? clauses : out;
};
/**
 * Fold a `FILTER p` back into the `MATCH` before it, as that match's clause `WHERE`.
 *
 * `FILTER <pred>` and a clause `WHERE <pred>` on the preceding MATCH are the same question —
 * both evaluate the predicate once per binding of that match — but only the `WHERE` spelling
 * reaches the ladder, because every detector matches a clause LIST and a `FILTER` is one clause
 * too many. Measured at 200,000 vertices / 200,000 edges, one case per process (item 548):
 *
 * ```text
 *   MATCH (n:Person) WHERE n.age > 44 RETURN count(*)                  4.49 ms
 *   MATCH (n:Person) FILTER n.age > 44 RETURN count(*)                34.59      7.7x
 *   MATCH (:Person)-[:KNOWS]->(b) WHERE b.age > 44 RETURN count(*)    30.57
 *   MATCH (:Person)-[:KNOWS]->(b) FILTER b.age > 44 RETURN count(*)  333.86     10.9x
 *   MATCH (n:Person) WHERE n.age > 44 RETURN max(n.age)                8.43
 *   MATCH (n:Person) FILTER n.age > 44 RETURN max(n.age)              37.61      4.5x
 * ```
 *
 * Same answers throughout. This is the bug class the repo is named after, on a spelling ISO puts
 * in the grammar as a first-class statement.
 *
 * NOT ACROSS AN `OPTIONAL MATCH`, and that is the one condition that is about semantics rather
 * than reach: a clause `WHERE` on an OPTIONAL is evaluated INSIDE it, so a start with no match
 * still yields its null-filled row, while a `FILTER` after it DROPS that row. The two spellings
 * genuinely differ there and the fold would change the answer.
 *
 * The predicate's free variables are deliberately unrestricted, for item 128's reason: a node
 * predicate is evaluated against the INCOMING binding, which already holds every earlier clause's
 * variables, so an outer reference resolves in the pattern exactly as it did in the filter.
 *
 * Written ORDER is preserved — `WHERE w AND f` when the match already had a `WHERE w` — because
 * `AND` short-circuits in written order in both engines (items 258, 259) and the conjunct that
 * was written first must still be the one evaluated first.
 */
const inlineTrailingFilter = (clauses: readonly Clause[]): readonly Clause[] => {
  const out: Clause[] = [];

  for (const clause of clauses) {
    const prev = out[out.length - 1];

    if (
      clause.kind !== 'filter' ||
      prev?.kind !== 'match' ||
      prev.optional ||
      hasAggregate(clause.where)
    ) {
      out.push(clause);
      continue;
    }

    out[out.length - 1] = {
      ...prev,
      where: prev.where === undefined ? clause.where : conjoin([prev.where, clause.where]),
    };
  }

  return out.length === clauses.length ? clauses : out;
};
/**
 * Every expression through which a TAIL of clauses could read a variable, plus every name the tail
 * REBINDS — or `undefined` to refuse outright (item 1569).
 *
 * Items 1567/1568 both required exactly `[match, return]`, and that restriction was expensive: one
 * `LET` between the two re-exposed the whole cost.
 *
 *     MATCH p = (a:P)-[:E]->{1,2}(b:P) LET w = 1 RETURN count(*)   869.6 ms
 *     MATCH p = (a:P)-[:E]->{1,2}(b:P)           RETURN count(*)    10.5 ms     83x
 *
 * ⚠️ AN ALLOWLIST OF CLAUSE KINDS, AND NOT BECAUSE OF LAZINESS — a generic walk for `{kind: 'var'}`
 * nodes would be WRONG here. Several clauses name a variable as a BARE STRING that no expression
 * walk can see:
 *
 *   - `SetItem` and `RemoveItem` are `{ variable: string, … }`;
 *   - a MATCH pattern's `node.variable` / `rel.variable` / `pathVar` are bare strings, so a second
 *     `MATCH` naming the same variable JOINS on it — a read, with no `var` node anywhere;
 *   - `CCallInline.scope` is a `string[]` of imported outer names, likewise a read.
 *
 * So only kinds whose variable reads are entirely `Expr`s are admitted, and everything else refuses.
 * Adding a kind here means checking that claim for it, not just that it "looks read-only".
 *
 * ⚠️ REBINDINGS REFUSE TOO. `LET p = 1` or `WITH 1 AS p` after `MATCH p = …` shadows the pattern's
 * binding, which probably makes dropping it safe — but "probably" is not a basis for a rewrite, and
 * the shapes are rare enough that refusing costs nothing.
 */
const tailReads = (tail: readonly Clause[]): { exprs: Expr[]; bound: Set<string> } | undefined => {
  const exprs: Expr[] = [];
  const bound = new Set<string>();

  for (const c of tail) {
    switch (c.kind) {
      case 'return':
      case 'with': {
        const { projection } = c;

        // `RETURN *` / `WITH *` binds every variable in scope, so nothing can be dropped.
        if (projection.star) {
          return undefined;
        }

        for (const it of projection.items) {
          exprs.push(it.expr);

          if (it.alias !== undefined) {
            bound.add(it.alias);
          }
        }

        for (const o of projection.orderBy ?? []) {
          exprs.push(o.expr);
        }

        exprs.push(...(projection.groupBy ?? []));

        if (projection.having !== undefined) {
          exprs.push(projection.having);
        }

        if (c.kind === 'with' && c.where !== undefined) {
          exprs.push(c.where);
        }

        break;
      }
      case 'filter':
        exprs.push(c.where);
        break;
      case 'let':
        for (const it of c.items) {
          exprs.push(it.expr);
          bound.add(it.var);
        }

        break;
      case 'page':
        for (const o of c.orderBy ?? []) {
          exprs.push(o.expr);
        }

        break;
      default:
        return undefined;
    }
  }

  return { exprs, bound };
};
/**
 * Is `name` provably unread by everything after the MATCH? `false` on any doubt.
 */
const nameIsUnread = (name: string, where: Expr | undefined, tail: readonly Clause[]): boolean => {
  const reads = tailReads(tail);

  if (reads === undefined || reads.bound.has(name)) {
    return false;
  }

  const exprs = where === undefined ? reads.exprs : [...reads.exprs, where];

  // A subquery can reference an outer variable and `freePredicateVars` does not see inside one.
  if (exprs.some(hasSubquery)) {
    return false;
  }

  for (const e of exprs) {
    for (const free of freePredicateVars(e)) {
      if (free === name) {
        return false;
      }
    }
  }

  return true;
};
/**
 * `MATCH p = … RETURN <no mention of p>` drops the PATH VARIABLE, which is worth up to **74x**
 * (item 1567).
 *
 * ⚠️ THE COST IS NOT THE `Path` OBJECTS, IT IS THAT `pathVar` DISQUALIFIES EVERY FAST PATH. Five
 * separate gates refuse outright on `path.pathVar !== undefined` — the typed-hop seed, the two
 * count rungs, the hop projection and `orient` itself (`pattern.pathVar !== undefined ? pattern :
 * orient(...)`, so the planner does not even choose a direction). Binding a path variable nobody
 * reads therefore falls off the whole ladder onto the general matcher:
 *
 *     MATCH p = (a:P)-[:E]->{1,2}(b:P) RETURN count(*) AS c      878.0 ms
 *     MATCH     (a:P)-[:E]->{1,2}(b:P) RETURN count(*) AS c       11.8 ms      74.1x
 *     MATCH p = ANY SHORTEST (a:P)-[:E]->+(b:P) WHERE a.n = 0      57.4 ms
 *     MATCH     ANY SHORTEST (a:P)-[:E]->+(b:P) WHERE a.n = 0      37.6 ms      1.53x
 *
 * A path variable is also the one binding a user adds *speculatively* — written while exploring,
 * then left in place when the projection changes to a count.
 *
 * ⚠️ `RETURN *` READS IT. `Projection.star` binds every variable in scope, `p` included, so a star
 * projection refuses — this is the guard a mutation removes and no other test covers.
 *
 * Deliberately the same narrow shape as {@link dropUnreadGroupBinds} below, and for the same
 * reason: exactly `[match, return]`, one pattern, and NO subquery anywhere in the downstream
 * expressions. A subquery can reference an outer variable, and `freePredicateVars` does not see
 * inside one.
 */
/**
 * EXPORTED FOR ITS OWN TEST. A route choice is answer-equivalent, so the differential suites cannot
 * see a mutant in it — `perf-gate-needs-its-own-test`. The transformation is tested directly, the
 * way `liftStartProps` is.
 */
export const dropUnreadPathVar = (clauses: readonly Clause[]): readonly Clause[] => {
  const [m, ...tail] = clauses;

  if (m?.kind !== 'match' || m.patterns.length !== 1 || tail.length === 0) {
    return clauses;
  }

  const [pattern] = m.patterns;
  const name = pattern?.pathVar;

  if (name === undefined || !nameIsUnread(name, m.where, tail)) {
    return clauses;
  }

  // ⚠️ REBUILD WITHOUT THE KEY, not `pathVar: undefined`. Every gate tests
  // `pathVar !== undefined`, so either spelling works for them — but `compilePattern` spreads
  // `...(pattern.pathVar !== undefined ? { pathVar } : {})`, and leaving an explicit `undefined`
  // here would make the two representations differ for anything comparing pattern shapes.
  const { pathVar: _dropped, ...rest } = pattern;

  return [{ ...m, patterns: [rest] }, ...tail];
};
/**
 * An unread EDGE variable on a QUANTIFIED segment is the same defect as the path variable, and the
 * same size: **71.9x** (item 1568).
 *
 *     MATCH (a:P)-[r:E]->{1,2}(b:P) RETURN count(*) AS c      819.6 ms
 *     MATCH (a:P)-[:E]->{1,2}(b:P)  RETURN count(*) AS c       11.4 ms
 *
 * ⚠️ `dropUnreadGroupBinds` ALREADY DROPS AN UNREAD `rel.variable` — but only on a FUSED HOP shape:
 * it requires `hopFrom !== undefined` and refuses on `nested`/`unitRest`/`innerQ`. A plain
 * quantified hop has `rel.quantifier` set and NO `hopFrom`, so it falls straight through that pass.
 * This covers exactly that gap and nothing else; the fused-hop case stays where it is.
 *
 * ⚠️ HARMLESS ON A SINGLE HOP, so this does not chase it: `-[r:E]->` unread measures 0.2 ms against
 * 0.2 for the absent spelling. The cost appears only where a binding disqualifies the var-length
 * rungs.
 *
 * The refusals mirror `dropUnreadGroupBinds`' own conservatism rather than re-deriving it: a rel
 * carrying properties or an inline `WHERE` is left alone (the predicate is evaluated against the
 * bound edge), and so is any segment with a nested subpath, a multi-element unit, an inner
 * quantifier or a subpath `WHERE` — each of which exposes inner variables this pass does not
 * reason about.
 */
/** EXPORTED FOR ITS OWN TEST, like {@link dropUnreadPathVar} — a route choice is answer-equivalent. */
export const dropUnreadEdgeVar = (clauses: readonly Clause[]): readonly Clause[] => {
  const [m, ...tail] = clauses;

  if (m?.kind !== 'match' || m.patterns.length !== 1 || tail.length === 0) {
    return clauses;
  }

  const [pattern] = m.patterns;

  if (pattern === undefined) {
    return clauses;
  }

  let changed = false;
  const segments = pattern.segments.map((seg) => {
    const { rel, hopFrom, unitRest, innerQ, nested, subpathWhere } = seg;

    if (
      rel.variable === undefined ||
      !nameIsUnread(rel.variable, m.where, tail) ||
      rel.quantifier === undefined ||
      hopFrom !== undefined ||
      nested !== undefined ||
      subpathWhere !== undefined ||
      innerQ !== undefined ||
      (unitRest?.length ?? 0) > 0 ||
      (rel.properties?.length ?? 0) > 0 ||
      rel.where !== undefined
    ) {
      return seg;
    }

    changed = true;

    return { ...seg, rel: { ...rel, variable: undefined } };
  });

  return changed ? [{ ...m, patterns: [{ ...pattern, segments }] }, ...tail] : clauses;
};
const dropUnreadGroupBinds = (clauses: readonly Clause[]): readonly Clause[] => {
  if (clauses.length !== 2) {
    return clauses;
  }

  const [m, ret] = clauses;

  if (m?.kind !== 'match' || m.patterns.length !== 1 || ret?.kind !== 'return') {
    return clauses;
  }

  const [pattern] = m.patterns;

  if (pattern.pathVar !== undefined) {
    return clauses;
  }

  // Every expression anything downstream could read. A subquery ANYWHERE refuses the rewrite.
  const exprs: Expr[] = [
    ...ret.projection.items.map((it) => it.expr),
    ...(ret.projection.orderBy ?? []).map((o) => o.expr),
    ...(ret.projection.groupBy ?? []),
    ...(ret.projection.having === undefined ? [] : [ret.projection.having]),
    ...(m.where === undefined ? [] : [m.where]),
  ];

  if (exprs.some(hasSubquery)) {
    return clauses;
  }

  const mentioned = new Set<string>();

  for (const e of exprs) {
    for (const name of freePredicateVars(e)) {
      mentioned.add(name);
    }
  }

  let changed = false;
  const segments = pattern.segments.map((seg) => {
    const { rel, hopFrom, hopTo, unitRest, innerQ, nested, subpathWhere } = seg;

    if (
      hopFrom === undefined ||
      nested !== undefined ||
      subpathWhere !== undefined ||
      innerQ !== undefined ||
      (unitRest?.length ?? 0) > 0 ||
      !plainGroupNode(hopFrom) ||
      !plainGroupNode(hopTo) ||
      (rel.properties?.length ?? 0) > 0 ||
      rel.where !== undefined
    ) {
      return seg;
    }

    const inner = [hopFrom.variable, hopTo?.variable, rel.variable].filter(
      (n): n is string => n !== undefined,
    );

    if (inner.some((n) => mentioned.has(n))) {
      return seg;
    }

    changed = true;

    const { hopFrom: _f, hopTo: _t, ...rest } = seg;

    return { ...rest, rel: { ...rel, variable: undefined } };
  });

  return changed ? [{ ...m, patterns: [{ ...pattern, segments }] }, ret] : clauses;
};
// EXPORTED for ROUTE ASSERTIONS, and deliberately not from `index.ts` (item 911).
//
// The twenty detectors below are answer-equivalent routes: a query whose shortcut stops firing
// returns the same rows by the general pipeline, so NO correctness test can see the difference.
// Item 910 priced them at 25% of planning the big query and named "a route assertion per detector"
// as the prerequisite for sharing work between them — because the failure mode of that refactor is
// a shape summary that silently stops a shortcut firing.
//
// `routes-fired.test.ts` calls this and reads which fields came back non-null. Exported from this
// module only, the way `predFor`, `selectiveFirst` and `invertedHopBudget` already are for their
// own tests; the package's public surface is unchanged.
export const compileLinear = (linear: LinearQuery): CLinear => {
  // `liftStartProps` runs OUTSIDE `fuseAnchorThenHop` so a FUSED clause gets the lift too: the
  // fused pattern's start is the anchor's, and an anchor written `MATCH (a:P {k: 5})` carries
  // exactly the inline property this lifts (item 778).
  const source = liftStartProps(
    fuseAnchorThenHop(
      // `inlineAggregateCall` runs INSIDE `inlineTrailingLet` so the `LET` it produces is itself
      // inlined when it is the last binding before the RETURN — the two compose into "a CALL with
      // an aggregate body is a projection subquery", which is where the rungs are.
      //
      // ⚠️ `inlineCorrelatedCall` IS INSIDE `inlineTrailingLet` FOR THE SAME REASON, AND IT WAS
      // OUTSIDE UNTIL ITEM 1662 MEASURED WHAT THAT COST. Once that rewrite could emit a `LET` of
      // its own (a computed yield, `RETURN x.k AS c`), running it after the `LET`-folding pass
      // left the `LET` standing, and a standing `LET` is OFF EVERY RUNG — `[match, let, return]`
      // carries none of the twenty, where the folded `[match, return]` carries `hopAggregate`.
      // Measured: the rewrite fired, the route assertion passed, and the arm went 3110 -> 2165
      // ns an outer row against the 330 its hand-written twin reaches. 1.44x of an available
      // 9.4x, with the whole gap in the composition rather than in either rewrite.
      //
      // The twin is the diagnostic worth keeping: `MATCH (n:P) MATCH (n)-[:E]->(x) LET c = x.k
      // RETURN sum(c)` is 4 clauses and still compiles to `[match, return]`, so `inlineTrailingLet`
      // never needed the fused shape — only to run LAST of the three.
      inlineTrailingLet(
        inlineCorrelatedCall(
          inlineAggregateCall(
            inlineTrailingFilter(
              unoptionalizeForAggregate(
                // `foldPageIntoReturn` runs INSIDE `dropVacuousPage` so the vacuous case is
                // removed first and only a page that actually does something is folded — the
                // two would otherwise race to claim the same clause (item 969).
                foldPageIntoReturn(
                  // `foldLabelTestsIntoPatterns` runs FIRST of the three (item 1303): it can empty
                  // a clause's `WHERE` entirely, and the rungs it is aiming at are selected on
                  // `pred.fn === alwaysTrue`, so a later pass must see the clause already folded.
                  dropUnreadGroupBinds(
                    // `dropUnreadPathVar` runs INSIDE `dropUnreadGroupBinds` because that one
                    // REFUSES outright on a pattern carrying a `pathVar` — so stripping an unread
                    // one first is what lets the two compose instead of the first blocking the
                    // second. Both require exactly `[match, return]`, so neither can see a shape
                    // the other created.
                    dropUnreadPathVar(
                      // `dropUnreadEdgeVar` runs INSIDE `dropUnreadPathVar` for the same
                      // composition reason: the path-variable pass refuses on nothing the edge pass
                      // creates, but a pattern can carry BOTH an unread `p` and an unread `r`, and
                      // only this order drops both in one compile. Each is independently narrow
                      // (`[match, return]`, one pattern), so neither can see a shape it did not
                      // expect.
                      dropUnreadEdgeVar(
                        dropVacuousPage(
                          dropVacuousQuantifier(foldLabelTestsIntoPatterns(linear.clauses)),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  const clauses = source.map(compileClause);
  // A pattern repeating a node variable is a SELF-JOIN that the fast paths answer wrongly, so
  // they are not offered the clause list at all — every detector begins by checking its shape
  // and an empty list matches none of them.
  const fast = repeatsNodeVariable(source) ? [] : source;

  // EVERY detector RUNS — this is twenty independent compile-time probes, not a ladder, and
  // the field order below carries no precedence whatsoever. PRECEDENCE LIVES IN ONE PLACE:
  // `runLinear`'s `if (linear.…)` chain in `executor/clauses.ts`, which is lazy and therefore
  // the only thing that decides which rung answers a shape. Read that chain's comments before
  // moving a rung; each one says whether its position is for correctness, for cost (item 418
  // measured a branch ahead of a hot dispatch costing the shape it does not claim 1.12x), or
  // only for reading.
  //
  // The order here is kept IDENTICAL to that chain's anyway, deliberately. It used to differ in
  // its first five entries while matching in the last fourteen, and it carried a comment saying
  // the OPTIONAL-hop count "sits above the plain one" — which described this literal's order and
  // contradicted the chain, where item 510 correctly places it BELOW `countShortcut` as the
  // strictly narrower shape. A list that resembles the precedence for three quarters of its
  // length is worse than one that plainly does not, so this one now matches it exactly.
  // ⚠️ ONE PRECEDENCE DECISION IS TAKEN HERE RATHER THAN IN THE CHAIN, and it is the only one.
  //
  // `count(DISTINCT <one expr over one end>)` over a 1-hop is accepted by BOTH `detectHopAggregate`
  // (which folds it via `distinctCountFold`, materializing nothing but walking every row) and
  // `detectDistinctCount` (which dedupes WHILE walking, and breaks out of a vertex's bucket at the
  // first qualifying edge when the dedup is keyed on the START). `hopAggregate` sits first in
  // `runLinear`'s chain, so it took every such shape and the narrower rung never ran — measured at
  // 50,000 vertices / 150,000 edges (item 1583, `hop-distinct-probe`):
  //
  //     count(DISTINCT b)     29.928ms      count(DISTINCT a)     20.923ms
  //     count(DISTINCT b.k)   22.418        count(DISTINCT a.n)   17.870
  //     count(DISTINCT b.n)   29.230
  //
  // against the node-only twin `MATCH (n:P) RETURN count(DISTINCT n.n)` at 2.599ms, which reaches
  // `distinctCount` because `nodeAggregate` sits BELOW it. Same rung, opposite outcome, decided
  // entirely by which broader detector happened to be listed first.
  //
  // WHY HERE AND NOT BY REORDERING THE CHAIN. Moving the `distinctCount` branch above
  // `hopAggregate` would put a branch ahead of a hot dispatch, which item 418 measured costing the
  // shape it does not claim 1.12x. This decides it ONCE PER QUERY at compile time instead, so the
  // runtime chain is untouched and the plain hop aggregate pays nothing.
  //
  // And the rule is not duplicated: nothing here re-derives what `distinctCount` accepts, it just
  // asks. Two copies of one shape rule is how the far endpoint ended up on a per-edge tally once
  // before (`detectDistinctCount`'s own note).
  const distinctCount = detectDistinctCount(fast, clauses);
  // A cross-end `WHERE` already declines `distinctCount` at compile time — `distinctShape` requires
  // `whereReadsOnly(where, keyedVar)` — so the shapes where `hopAggregate`'s EXECUTION-TIME decline
  // could hand the query to an index seek on the end it does not drive are exactly the shapes where
  // `distinctCount` is null and this gate does nothing.
  const hopAggregate = distinctCount === null ? detectHopAggregate(fast, clauses) : null;

  return {
    clauses,
    varLengthCount: detectVarLengthCount(fast),
    countShortcut: detectCountShortcut(fast, clauses),
    optionalHopCount: detectOptionalHopCount(fast),
    forCount: detectForCount(fast, clauses),
    forProjection: detectForProjection(fast, clauses),
    optionalHopProjection: detectOptionalHopProjection(fast, clauses),
    groupCountShortcut: detectGroupedNodeCount(fast),
    groupHopShortcut: detectGroupedHopCount(fast),
    reachShortcut: detectReachableShortcut(fast, clauses),
    hopProjection: detectHopProjection(fast, clauses),
    hop2Projection: detectHop2Projection(fast, clauses),
    hopAggregate,
    multiHopAggregate: detectMultiHopAggregate(fast, clauses),
    distinctProjection: detectDistinctProjection(fast, clauses),
    distinctCount,
    nodeProjection: detectNodeProjection(fast, clauses),
    nodeAggregate: detectNodeAggregate(fast, clauses),
    multiNodeAggregate: detectMultiNodeAggregate(fast, clauses),
    groupedNodeAggregate: detectGroupedNodeAggregate(fast, clauses),
    groupedHopAggregate: detectGroupedHopAggregate(fast, clauses),
    writes: clauses.some((clause) => WRITE_CLAUSES.has(clause.kind)),
  };
};

// --- write clauses -----------------------------------------------------------
