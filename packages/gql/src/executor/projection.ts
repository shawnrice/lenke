/**
 * PROJECTION: turning a binding table into the rows a RETURN asks for — grouping, aggregating,
 * ordering and paging included.
 *
 * ⚠️ THIS MODULE CLOSES THE LAST IMPORT CYCLE IN THE PACKAGE (item 1666). `clauses.ts` needed
 * exactly `applyProjection` and `projectedRows` from `core.ts`, while `core.ts` needed two back —
 * a 2-against-2 mutual pair, the only one left after the other three were closed by a single symbol
 * each. It took 699 lines to move rather than two, because the pair drags the whole grouping and
 * folding apparatus with it: `buildGroups`, `boundedTopK`, `pagedFaultFreeRows`, `projectBinding`,
 * `rowKey`, and the folded-aggregate views.
 *
 * That size is the honest shape of the thing. The other three cycles were one symbol in the wrong
 * place; this one is a genuine subsystem that was never given a file.
 *
 * ⚠️ `boundedTopK` AND `pagedFaultFreeRows` ARE BOTH HERE BECAUSE PAGING IS NOT A POST-FILTER.
 * A `LIMIT` has to reach the producer or the engine materialises a whole cross product first —
 * measured at 473x for a 4096-row tail cache and 3680x for a cross product under a LIMIT, in BOTH
 * engines. A top-k that is bounded and a paged scan that stops early are the two shapes that
 * carry that, and splitting them from the projection they serve is how a later change reintroduces
 * the eager fill.
 *
 * ⚠️ `rowKey` IS A GROUPING KEY AND MUST NOT BE CONFUSED WITH THE ORDERING ONE. `valueKey` in
 * `rows.ts` is its per-value counterpart and `compareSort` in `values.ts` is the total order; a key
 * only has to be injective, while the order has to agree with the Rust engine byte for byte.
 */

import type { Graph } from '@lenke/core';
import { ErrorCode, LenkeError } from '@lenke/errors';
import { filter, map, skip, take, toArray } from '@lenke/fp';

import type {
  AggFold,
  Binding,
  CProjection,
  CountedGroup,
  EvalEnv,
  FoldedAgg,
  FoldedBucket,
  Params,
  Row,
} from './core.js';
import { mapToRow } from './rows.js';
import { mapToArray, projectRow, resolveCount, valueKey } from './rows.js';
import { asTruth } from './scalars.js';
import { compareSort, compareValues, isNullish } from './values.js';

export const COUNT_FOLD: AggFold = {
  init: () => 0,
  step: (acc) => (acc as number) + 1,
  finish: (acc) => acc,
};
/**
 * `count(DISTINCT x)` as a left fold: the accumulator is the SET OF VALUE KEYS seen (item 1049).
 *
 * `foldFor` refused `distinct` because "DISTINCT needs every value" — true of an O(1) accumulator,
 * and the comment in `stepFolded` says the same from the other side: the array path dedups AFTER
 * its `nonNull` filter, so a fold had nowhere to do it. A Set accumulator has somewhere: it dedups
 * inside `step`. The state is O(distinct) rather than O(1), which is the same order the array path
 * already pays to materialize the group.
 *
 * ORDER-INDEPENDENT, which is the precondition `detectHopAggregate` enforces on anything riding its
 * possibly-far-driven walk: a Set's `size` does not depend on insertion order, unlike `sum`'s last
 * ulp (item 532). That is what makes this reachable where `sum` is not — and item 1048 is where
 * believing otherwise was caught.
 *
 * ONE DEFINITION OF "DISTINCT", and it is `valueKey`. The array path's `distinctByValueKey` and this
 * fold both key by `valueKey`, so value-equal temporals, lists and records collapse identically and
 * neither can drift on what counts as distinct — the condition the {@link AggFold} contract sets.
 * What is expressed twice is only "count them", as a pre-dedup plus `COUNT_FOLD` on one path and a
 * set size on the other, which are the same arithmetic.
 *
 * Nullish values never reach `step`: both paths filter them first (`nonNull` in the array path,
 * `isNullish` in `stepFolded`), and `count(DISTINCT x)` excludes nulls.
 */
export const distinctCountFold: AggFold = {
  init: () => new Set<string>(),
  step: (acc, v) => {
    (acc as Set<string>).add(valueKey(v));

    return acc;
  },
  finish: (acc) => (acc as Set<string>).size,
};
export const extremumFold = (wantMin: boolean): AggFold => ({
  init: () => undefined,
  step: (acc, v) => {
    if (acc === undefined) {
      return v;
    }

    const ord = compareValues(v, acc);

    return (wantMin ? ord < 0 : ord > 0) ? v : acc;
  },
  finish: (acc) => (acc === undefined ? null : acc),
});
export const foldFor = (name: string, star: boolean, distinct: boolean): AggFold | undefined => {
  if (star) {
    return undefined; // count(*) has its own O(groups) path
  }

  // `count(DISTINCT x)` folds since item 1049 — see `distinctCountFold`. Every OTHER distinct
  // aggregate still refuses: `sum`/`avg` are order-sensitive in the last ulp whether or not they
  // dedup first, `collect`'s order IS its answer, and the extremums gain nothing from dedup, so
  // widening this further would be scope without a number behind it.
  if (distinct) {
    return name === 'count' ? distinctCountFold : undefined;
  }

  switch (name) {
    case 'count':
      return COUNT_FOLD;
    case 'min':
      return extremumFold(true);
    case 'max':
      return extremumFold(false);
    default:
      return undefined;
  }
};
export const rowKey = (b: Binding): string =>
  [...b].map(([k, v]) => `${k}=${valueKey(v)}`).join('');
/**
 * Fault on a `GROUP BY` naming something the binding does not carry.
 *
 * Unbound reads as null, which keys every row the same: the query silently
 * returned ONE group holding the first row's values instead of the grouping the
 * reader asked for. `GROUP BY zzz` did it as readily as `GROUP BY <a RETURN
 * alias>` — and the alias is the common way in, because `RETURN n.t AS t … GROUP
 * BY t` reads as if it should work. It cannot: `GROUP BY` sits INSIDE the return
 * body and groups the input bindings, while `ORDER BY` is a separate statement
 * applied after the projection, which is why an alias resolves there. The two
 * clauses differ by design.
 *
 * The native side asks the same question while lowering, in
 * `gql::Parser::project_and_page`, which folds a `GROUP BY` key that is not a visible
 * non-aggregate output item into a hidden grouping key.
 */
export const assertGroupKeysBound = (names: readonly string[], binding: Binding): void => {
  for (const name of names) {
    if (!binding.has(name)) {
      throw new LenkeError(
        `GROUP BY references an unbound variable: ${name}. GROUP BY groups the ` +
          `INPUT bindings, so it cannot see a RETURN alias (ORDER BY, which runs ` +
          `after the projection, can). Bind it first — \`LET ${name} = …\` or ` +
          `\`WITH … AS ${name}\` — or group by the property directly.`,
        { code: ErrorCode.UnknownFunction },
      );
    }
  }
};
/** Build the output binding for one input binding (or aggregate group). */
export const projectBinding = (
  proj: CProjection,
  binding: Binding,
  params: Params,
  graph: Graph,
  group?: readonly Binding[],
): Binding => {
  if (proj.star) {
    return new Map(binding);
  }

  const env: EvalEnv = { binding, params, graph, group };
  const out = new Map<string, unknown>();

  for (const item of proj.items) {
    out.set(item.name, item.fn(env));
  }

  return out;
};
export const projectedRows = (
  proj: CProjection,
  bindings: Iterable<Binding>,
  params: Params,
  graph: Graph,
): Row[] => {
  if (
    proj.aggregating ||
    proj.orderBy.length > 0 ||
    proj.distinct ||
    resolveCount(proj.skip, params) !== undefined ||
    resolveCount(proj.limit, params) !== undefined
  ) {
    return mapToArray(applyProjection(proj, bindings, params, graph), mapToRow);
  }

  return mapToArray(bindings, (b: Binding) => projectRow(proj, b, params, graph));
};
/**
 * The `cap` rows that sort first under `cmp`, in sorted order — an O(n log cap)
 * bounded selection instead of sorting all n rows to keep a small prefix. Streams
 * its input (only `cap` rows are ever held). Ties break by original stream
 * position, so the result is byte-identical to a *stable* full sort + `slice(0,
 * cap)`. Used for `ORDER BY … LIMIT k`.
 */
/**
 * REJECTED, with its numbers (audit item 424): replacing the `{ v, i }` wrapper below with two
 * PARALLEL ARRAYS (`vals`/`idxs`, swapped together, plus a `lessThanRoot` that compares a
 * candidate against the root without building an entry for it) measured **50.1 -> 48.9 ms, 2.4%**,
 * five alternated rounds at nine reps each, 200,000 rows answering `ORDER BY u LIMIT 5`.
 *
 * The wrapper is allocated for EVERY input row, including the overwhelming majority immediately
 * rejected — it is built before the `less(e, heap[0])` test that throws it away — so 200,000
 * objects are allocated to keep five. That is the same per-row allocation item 113 removed from
 * the pass-through projection path, and it bought 2%: V8's young-generation bump allocation is
 * near-free, and the extra array indirection costs back most of what removing it saves. Under the
 * repo's 10% floor, so not taken.
 *
 * The corollary is worth more than the change would have been: **"it allocates per row" is not by
 * itself a cost in this engine.** Two further allocations per row sit on the top-k call site in
 * `applyProjection` (the `{ b, keys }` wrapper and the `orderBy.map` key array), and the same
 * arithmetic prices removing both at roughly 5% — also under the floor. The measured gap on that
 * shape is 50.1 ms against the `max(a.u)` fold's 20.7 over the same rows, and it is NOT allocation.
 *
 * Also, do not measure this shape at three reps: both sides are bimodal at ~50 ms and ~90-95 ms,
 * so min-of-3 picks a mode rather than a cost (the first A/B read 58.0 -> 86.1 and the second
 * 95.0 -> 50.7, from the same two builds). Nine reps settles it, which is what
 * `ts-spelling-probe` already says about this engine.
 */
export const boundedTopK = <T>(
  rows: Iterable<T>,
  cap: number,
  cmp: (a: T, b: T) => number,
): T[] => {
  if (cap <= 0) {
    return [];
  }

  type E = { v: T; i: number };
  const heap: E[] = []; // max-heap by `less`: the root is the worst (largest) kept
  const less = (a: E, b: E): boolean => {
    const c = cmp(a.v, b.v);

    return c !== 0 ? c < 0 : a.i < b.i; // index tiebreak reproduces stable order
  };
  const swap = (x: number, y: number) => {
    const t = heap[x];
    heap[x] = heap[y];
    heap[y] = t;
  };
  const up = (start: number) => {
    let i = start;

    while (i > 0) {
      const p = (i - 1) >> 1;

      if (!less(heap[p], heap[i])) {
        break; // parent already >= child
      }

      swap(i, p);
      i = p;
    }
  };
  const down = (start: number) => {
    let i = start;

    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;

      if (l < heap.length && less(heap[m], heap[l])) {
        m = l;
      }

      if (r < heap.length && less(heap[m], heap[r])) {
        m = r;
      }

      if (m === i) {
        break;
      }

      swap(i, m);
      i = m;
    }
  };

  let idx = 0;

  for (const v of rows) {
    const e = { v, i: idx };
    idx += 1;

    if (heap.length < cap) {
      heap.push(e);
      up(heap.length - 1);
    } else if (less(e, heap[0])) {
      heap[0] = e; // better than the worst kept — evict the root
      down(0);
    }
  }

  heap.sort((a, b) => {
    if (less(a, b)) {
      return -1;
    }

    return less(b, a) ? 1 : 0;
  });

  return heap.map((e) => e.v);
};
/**
 * Paging an UNORDERED stream whose projection cannot raise: skip the BINDINGS, then project only
 * the page. `null` when the shape does not fit, so the caller falls through.
 *
 * `applyProjection`'s generic tail projects every row and pages the PROJECTED ones, which item
 * 426 measured at 48.8-51.3 ms for `RETURN a.u AS s SKIP 199995 LIMIT 5` over 200,000 nodes —
 * MORE than the 35.5 the same query costs WITH an `ORDER BY`, whose top-k already projects only
 * survivors. Adding an `ORDER BY` making a query faster is the spelling asymmetry this repo is
 * named after. This closes it at 1.96-2.09x, landing on the 25.6 ms general-stream floor item 426
 * measured with a constant sort key.
 *
 * `proj.cannotFault` is what keeps this byte-identical rather than a behaviour change: both
 * engines currently DO fault on a skipped row's `CAST` (`skipcast_426` is the evidence, checked
 * natively), and that is a conformance question against the engine's own "project exactly the
 * rows you emit" rule, not something an optimization pass settles. Where the projection could not
 * have raised there is nothing to observe, so the rows and their order are unchanged and native
 * agrees by construction.
 *
 * EXTRACTED from `applyProjection` rather than written inline, because the complexity cap
 * objected at 38 against a limit of 35 — the same cap that was right to object at item 377, and
 * the same answer: the branch's six conditions become one call. The HOT loop is still one loop
 * over `bindings`, and this is called once per query, so neither of item 159's effects applies.
 *
 * Only a positive SKIP. `limitBound` alone already short-circuits through `take` without
 * projecting the tail, and `skipBound === 0` is the pass-through in the caller.
 *
 * The `!proj.aggregating` guard is REDUNDANT and kept, which mutation established rather than my
 * reading it: every aggregate is an `Expr` of kind `func`, which the `cannotFault` allowlist
 * already refuses, so an aggregating projection can never reach here. Dropping the guard leaves
 * all 12 tests green. It stays because the implication runs through `compileProjection`'s
 * allowlist rather than anything local, and a future allowlist entry would otherwise silently
 * admit a shape with no per-input row to page.
 */
export const pagedFaultFreeRows = (
  proj: CProjection,
  bindings: Iterable<Binding>,
  params: Params,
  graph: Graph,
  skipBound: number | undefined,
  limitBound: number | undefined,
): Iterable<Binding> | null => {
  if (
    proj.aggregating ||
    proj.orderBy.length > 0 ||
    proj.distinct ||
    skipBound === undefined ||
    skipBound <= 0 ||
    !proj.cannotFault
  ) {
    return null;
  }

  const afterSkip = skip(skipBound, bindings);

  return map(
    (b: Binding) => projectBinding(proj, b, params, graph),
    limitBound === undefined ? afterSkip : take(limitBound, afterSkip),
  );
};
/**
 * A `Binding[]` stand-in that knows its LENGTH and holds ONE binding.
 *
 * `count(*)` compiles to `group.length` and nothing else, so when every aggregate in a
 * projection is `count(*)` the other `n - 1` bindings are never read and retaining them is what
 * made an aggregating projection O(rows) (item 296: a 5-hop `count(*)` OOM-killed under a 4 GB
 * cap, ~640 bytes a path). This gives the group its size without them.
 *
 * IT IS A LIE, SO IT IS A LOUD ONE. The array is length-1 with the real `length` reported on
 * top, which means an index past 0 would silently read `undefined` — a wrong answer of exactly
 * the kind this engine is least able to detect. The Proxy turns any numeric read past the
 * representative into a thrown error instead, so if a future aggregate reaches for the bindings
 * the failure names the cause rather than returning a plausible number. It is built once per
 * GROUP, never per row, so the Proxy costs nothing that matters.
 *
 * `compileProjection`'s `countedGroups` is what guarantees only `.length` and `[0]` are read;
 * this is the backstop for that guarantee, not a substitute for it.
 */
/**
 * Folded aggregate values ride on the group VIEW under this symbol rather than through a new
 * parameter on `projectBinding`/`Env`. `countedGroupView` already established that the group
 * handed to the aggregates may be a stand-in; this carries the one extra thing a folded group
 * needs, and keeps the change local to the two places that know about streaming.
 */
export const FOLDED = Symbol('lenke.foldedAggregates');
/**
 * A group whose foldable aggregates are already computed: size, representative, values.
 *
 * Keyed by the aggregate's AST node, which is the key `compileAggregate` already looks a
 * pre-folded value up by. Item 1197 exported this for `shortcuts.ts`; item 1198 replaced that use
 * with `foldedAggOnlyView` (a streaming route has no row count to pass without counting rows,
 * which taxed the bare spelling), so it is module-private again.
 */
export const foldedGroupView = (
  rep: Binding,
  n: number,
  folded: ReadonlyMap<object, { readonly v: unknown }>,
): Binding[] =>
  new Proxy<Binding[]>([rep], {
    get(target, prop, recv) {
      if (prop === FOLDED) {
        return folded;
      }

      if (prop === 'length') {
        return n;
      }

      if (typeof prop === 'string' && /^\d+$/.test(prop) && Number(prop) > 0) {
        throw new LenkeError(
          `lenke: a folded group of ${n} was indexed at ${prop}; an aggregate that needs every ` +
            'binding must not be admitted to the streaming path (see `foldFor`)',
          { code: ErrorCode.Unsupported },
        );
      }

      return Reflect.get(target, prop, recv) as unknown;
    },
  });
export const countedGroupView = (rep: Binding, n: number): Binding[] =>
  new Proxy<Binding[]>([rep], {
    get(target, prop, recv) {
      if (prop === 'length') {
        return n;
      }

      if (typeof prop === 'string' && /^\d+$/.test(prop) && Number(prop) > 0) {
        throw new LenkeError(
          `lenke: a counted group of ${n} was indexed at ${prop}; only count(*) may stream a ` +
            'group, so this aggregate needs the bindings retained (see `countedGroups`)',
          { code: ErrorCode.Unsupported },
        );
      }

      return Reflect.get(target, prop, recv) as unknown;
    },
  });
/**
 * Step one binding into its group's accumulators and DISCARD it. Lifted out of
 * `applyProjection` because the complexity cap was right: the grouping loop already carries
 * three bucket shapes, and this one has a loop of its own.
 */
export const stepFolded = (
  folds: Map<string, FoldedBucket>,
  key: string,
  b: Binding,
  foldedAggs: readonly FoldedAgg[],
  params: Params,
  graph: Graph,
): void => {
  let seen = folds.get(key);

  if (seen === undefined) {
    seen = { rep: b, n: 0, accs: foldedAggs.map((a) => a.fold.init()) };
    folds.set(key, seen);
  }

  seen.n += 1;

  for (const [i, a] of foldedAggs.entries()) {
    const v = a.argFn({ binding: b, params, graph });

    // The array path folds over `nonNull` (and would then apply DISTINCT, which is why
    // `foldFor` refuses it), so the streaming step must skip nullish the SAME way — this is
    // the one place the two paths could disagree, and the DISTINCT differential pins it.
    if (!isNullish(v)) {
      seen.accs[i] = a.fold.step(seen.accs[i], v);
    }
  }
};
/** Finish a folded bucket into the group view the rest of `applyProjection` understands. */
export const finishFolded = (
  { rep, n, accs }: FoldedBucket,
  foldedAggs: readonly FoldedAgg[],
): Binding[] => {
  const done = new Map<object, { readonly v: unknown }>();

  for (const [i, a] of foldedAggs.entries()) {
    done.set(a.expr, { v: a.fold.finish(accs[i]) });
  }

  return foldedGroupView(rep, n, done);
};
/**
 * Build the group buckets for an aggregating projection. Extracted from `applyProjection`
 * because the complexity cap was right to object (item 377): this is now THREE bucket shapes
 * — kept bindings, counted groups (item 297) and folded accumulators — and the choice between
 * them, which is more than one function should hold alongside ordering, DISTINCT and paging.
 */
export const buildGroups = (
  proj: CProjection,
  bindings: Iterable<Binding>,
  params: Params,
  graph: Graph,
): Map<string, Binding[]> => {
  const groups = new Map<string, Binding[]>();
  // ONE grouping key is the overwhelmingly common shape, and for it the row key IS the
  // value key: `valueKey` is already type-prefixed and injective, so `JSON.stringify([k])`
  // is injective in exactly the same `k` that `k` itself is — the stringify, the
  // intermediate array and the `.map` closure are pure cost, paid per ROW. Several keys
  // keep the stringify, which stays injective across a boundary a plain join does not: a
  // string cell may contain whatever separator the join picks.
  const soleKey = proj.groupKeys.length === 1 ? proj.groupKeys[0] : undefined;
  // NO grouping keys at all — a scalar aggregate — means every row belongs to one group, so
  // the key is a CONSTANT. It was still being recomputed per row as
  // `JSON.stringify([].map(...))`: an array allocation and a stringify to produce `'[]'`,
  // which is the very literal the empty-group line below already uses. On 800,000 rows that
  // was the whole cost of an ungrouped aggregate — removing the retained bindings (the fix
  // this item started as) left the 1-hop timing untouched at ~534ms, because the memory and
  // the time were two different problems (item 377).
  const constKey = proj.groupKeys.length === 0 ? '[]' : undefined;

  // COUNTED groups keep a size and a representative; kept groups keep every binding. One
  // loop either way, so the grouping key is derived once and the only difference is what the
  // bucket holds.
  const counts = proj.countedGroups ? new Map<string, CountedGroup>() : undefined;
  // FOLDED groups keep one accumulator per aggregate plus a representative. Same shape as
  // `counts`, one slot wider: the bindings are stepped into the accumulators and dropped.
  const { foldedAggs } = proj;
  const folds = foldedAggs ? new Map<string, FoldedBucket>() : undefined;

  for (const b of bindings) {
    assertGroupKeysBound(proj.groupKeyNames, b);

    const key =
      constKey ??
      (soleKey
        ? valueKey(soleKey({ binding: b, params, graph }))
        : JSON.stringify(proj.groupKeys.map((fn) => valueKey(fn({ binding: b, params, graph })))));

    if (folds && foldedAggs) {
      stepFolded(folds, key, b, foldedAggs, params, graph);
      continue;
    }

    if (counts) {
      const seen = counts.get(key);

      if (seen) {
        seen.n += 1;
      } else {
        // The FIRST binding is the representative — the same one `group[0]` would have been,
        // which is what group keys and non-aggregate items read.
        counts.set(key, { rep: b, n: 1 });
      }

      continue;
    }

    const existing = groups.get(key);

    if (existing) {
      existing.push(b);
    } else {
      groups.set(key, [b]);
    }
  }

  // Replay the folded buckets the same way the counted ones are replayed: a representative
  // and a view, with the finished values attached for the aggregate closures to read.
  if (folds && foldedAggs) {
    for (const [key, bucket] of folds) {
      groups.set(key, finishFolded(bucket, foldedAggs));
    }
  }

  // Replay the counted buckets as groups the rest of this function already understands: a
  // representative plus a LENGTH-ONLY view standing in for the bindings.
  if (counts) {
    for (const [key, { rep, n }] of counts) {
      groups.set(key, countedGroupView(rep, n));
    }
  }

  if (groups.size === 0 && proj.groupKeys.length === 0) {
    groups.set('[]', []);
  }

  return groups;
};
export const applyProjection = (
  proj: CProjection,
  bindings: Iterable<Binding>,
  params: Params,
  graph: Graph,
): Iterable<Binding> => {
  const { orderBy } = proj;
  // A `$param` bound resolves here (validated up-front); a literal passes through.
  const skipBound = resolveCount(proj.skip, params);
  const limitBound = resolveCount(proj.limit, params);

  // A zero LIMIT emits no rows, so the projection never runs. The rule the engine
  // already follows for a non-zero LIMIT is "project exactly the rows you emit" —
  // `RETURN 1/(n.n - 7) AS x LIMIT 1` returns the first row rather than faulting on
  // the second, in BOTH engines. LIMIT 0 emits nothing, so it projects nothing;
  // faulting here would make LIMIT 0 the one limit that evaluates discarded rows.
  // (Not a SQL rule: ISO GQL's `<order by and page statement>` is a statement in its
  // own right that may PRECEDE the RETURN, where paging trims the binding table
  // before any projection — this is what that form yields. We implement only the
  // trailing form. Postgres is not the reference and does not agree: it
  // constant-folds `1/0` at plan time and raises even under LIMIT 0.)
  if (limitBound === 0) {
    return [];
  }

  type Keyed = { b: Binding; keys: readonly unknown[] };

  const cmp = (a: Keyed, b: Keyed): number => {
    for (let i = 0; i < orderBy.length; i += 1) {
      const c = compareSort(a.keys[i], b.keys[i], orderBy[i].descending, orderBy[i].nullsFirst);

      if (c !== 0) {
        return c;
      }
    }

    return 0;
  };

  // Top-k: `ORDER BY … LIMIT n` whose sort keys don't read the output. The keys
  // come from the input binding alone, so only the top-k INPUT bindings are kept
  // and just those are projected — the rest are never projected at all. Same five
  // conditions as the Rust `ProjAccum::new` (`topk`), so both engines project
  // exactly the same rows: a projection that would fault on a row outside the
  // top-k does not fault in either. DISTINCT is excluded because dedup keys are
  // built from the projected row, and an aggregate has no per-input row to keep.
  if (
    !proj.aggregating &&
    orderBy.length > 0 &&
    limitBound !== undefined &&
    !proj.distinct &&
    !proj.orderNeedsOutput
  ) {
    const cap = (skipBound ?? 0) + limitBound;

    // ONE sort key is the overwhelmingly common spelling, and it gets its own bounded heap
    // rather than the generic `Keyed` one. What this removes is NOT the allocations (item 424
    // measured those at 2.4% and rejected removing them): it is the `map` generator between
    // `bindings` and the heap's `for…of`, the one-element `keys` array and its index reads, and
    // the `orderBy[i].descending`/`nullsFirst` property loads that the generic `cmp` repeats on
    // every comparison. Item 424 priced the per-row machinery at 182ns against the `max(a.u)`
    // fold's 35ns over the same rows and the same comparator, which is the gap this closes.
    if (orderBy.length === 1) {
      const [{ fn, descending, nullsFirst }] = orderBy;
      // Parallel arrays, at most `cap` long: bindings, their sort keys, and the arrival index
      // the stable-order tiebreak needs.
      const bs: Binding[] = [];
      const ks: unknown[] = [];
      const ix: number[] = [];
      const lessAt = (x: number, y: number): boolean => {
        const c = compareSort(ks[x], ks[y], descending, nullsFirst);

        return c !== 0 ? c < 0 : ix[x] < ix[y];
      };
      const swapAt = (x: number, y: number) => {
        const tb = bs[x];
        bs[x] = bs[y];
        bs[y] = tb;

        const tk = ks[x];
        ks[x] = ks[y];
        ks[y] = tk;

        const ti = ix[x];
        ix[x] = ix[y];
        ix[y] = ti;
      };
      const siftUp = (from: number) => {
        let i = from;

        while (i > 0) {
          const parent = (i - 1) >> 1;

          if (!lessAt(parent, i)) {
            break;
          }

          swapAt(i, parent);
          i = parent;
        }
      };
      const siftDown = (from: number) => {
        let i = from;

        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let m = i;

          if (l < bs.length && lessAt(m, l)) {
            m = l;
          }

          if (r < bs.length && lessAt(m, r)) {
            m = r;
          }

          if (m === i) {
            break;
          }

          swapAt(i, m);
          i = m;
        }
      };
      let n = 0;

      for (const b of bindings) {
        const k = fn({ binding: b, params, graph });
        const i = n;
        n += 1;

        if (bs.length < cap) {
          bs.push(b);
          ks.push(k);
          ix.push(i);
          siftUp(bs.length - 1);
        } else {
          // Beat the worst kept? The comparison is made against the ROOT without storing the
          // candidate anywhere, which is the one place the generic heap had to build an entry.
          //
          // The index tiebreak HERE is provably redundant and kept for symmetry with `lessAt`:
          // it is consulted only when the keys tie, and a candidate always arrives after
          // everything already in the heap, so `i < ix[0]` is false exactly where `c < 0` is.
          // Mutation says so rather than my reading it — dropping it leaves all 25 tests green,
          // while dropping it from `lessAt` (where the heap array has been permuted by
          // evictions and the final sort must still recover arrival order) fails four.
          const c = compareSort(k, ks[0], descending, nullsFirst);

          if (c !== 0 ? c < 0 : i < ix[0]) {
            bs[0] = b;
            ks[0] = k;
            ix[0] = i;
            siftDown(0);
          }
        }
      }

      // Sort a PERMUTATION of the survivors, so the (binding, key, index) triple survives the
      // sort without a wrapper. Same total order as the heap used, index tiebreak included.
      const order = bs.map((_, i) => i);

      order.sort((a, b) => {
        if (lessAt(a, b)) {
          return -1;
        }

        return lessAt(b, a) ? 1 : 0;
      });

      const kept = order.slice(skipBound ?? 0, (skipBound ?? 0) + limitBound);

      return kept.map((i) => projectBinding(proj, bs[i], params, graph));
    }

    const inputKeyed = map(
      (b: Binding) => ({ b, keys: orderBy.map((s) => s.fn({ binding: b, params, graph })) }),
      bindings,
    );
    const top = boundedTopK(inputKeyed, cap, cmp);
    const afterSkip = skipBound ? skip(skipBound, top) : top;

    return map((r: Keyed) => projectBinding(proj, r.b, params, graph), take(limitBound, afterSkip));
  }

  // No ORDER BY, no DISTINCT, no paging, no aggregation: every stage below this
  // is a pass-through, and the `Keyed` round trip is pure overhead — a wrapper
  // object and an empty `keys` array allocated per row, two generator layers to
  // put them on and take them off again. Returning the projection directly is
  // the same rows in the same order, projected just as lazily and faulting on
  // exactly the same ones.
  //
  // Item 98 priced removing ONE of the ~11 layers at 5-8% and retracted it as
  // under the noise floor. This removes two layers AND both allocations, which
  // is why it is worth doing where that was not; the measured number is in item
  // 113.
  if (
    !proj.aggregating &&
    orderBy.length === 0 &&
    !proj.distinct &&
    skipBound === undefined &&
    limitBound === undefined
  ) {
    return map((b: Binding) => projectBinding(proj, b, params, graph), bindings);
  }

  // See `pagedFaultFreeRows` — extracted because the complexity cap objected, exactly as it did
  // at item 377.
  const paged = pagedFaultFreeRows(proj, bindings, params, graph, skipBound, limitBound);

  if (paged !== null) {
    return paged;
  }

  let keyed: Iterable<Keyed>;

  if (proj.aggregating) {
    // Grouping is a barrier — it must see every binding before it can emit. We
    // still fold into per-group buckets with single `push`es (never a spread).
    const groups = buildGroups(proj, bindings, params, graph);
    // ISO HAVING: drop a group whose post-aggregation predicate is not exactly
    // TRUE (three-valued — NULL/false both drop). The aggregates fold over the
    // group array; group keys read the representative binding.
    const { having } = proj;
    const groupList = having
      ? [...groups.values()].filter((group) => {
          const rep = group[0] ?? new Map();

          return asTruth(having({ binding: rep, params, graph, group })) === true;
        })
      : groups.values();

    keyed = map((group: Binding[]) => {
      const rep: Binding = group[0] ?? new Map();
      const projected = projectBinding(proj, rep, params, graph, group);
      // ORDER BY sees the output columns overlaid on the input variables.
      const sortBinding = orderBy.length > 0 ? new Map([...rep, ...projected]) : rep;

      return {
        b: projected,
        keys: orderBy.map((s) => s.fn({ binding: sortBinding, params, graph, group })),
      };
    }, groupList);
  } else {
    // Non-aggregating: a lazy map — rows are projected on demand.
    keyed = map((b: Binding) => {
      const projected = projectBinding(proj, b, params, graph);
      const sortBinding = orderBy.length > 0 ? new Map([...b, ...projected]) : b;

      return {
        b: projected,
        keys: orderBy.map((s) => s.fn({ binding: sortBinding, params, graph })),
      };
    }, bindings);
  }

  if (proj.distinct) {
    const seen = new Set<string>();
    keyed = filter((r: Keyed) => {
      const k = rowKey(r.b);

      if (seen.has(k)) {
        return false;
      }

      seen.add(k);

      return true;
    }, keyed);
  }

  // ORDER BY is the other barrier. With a LIMIT we only need skip+limit rows, so a
  // bounded top-k (O(n log k), never materializing the rest) beats sorting all n;
  // without a LIMIT, sort the whole owned array.
  let ordered: Iterable<Keyed> = keyed;

  if (orderBy.length > 0 && limitBound !== undefined) {
    ordered = boundedTopK(keyed, (skipBound ?? 0) + limitBound, cmp);
  } else if (orderBy.length > 0) {
    const arr = toArray(keyed);
    arr.sort(cmp);
    ordered = arr;
  }

  // SKIP/LIMIT stay lazy — `take` short-circuits, so `LIMIT n` over a huge
  // unordered stream stops after n rows instead of computing them all.
  const start = skipBound ?? 0;
  let sliced: Iterable<Keyed> = start > 0 ? skip(start, ordered) : ordered;

  if (limitBound !== undefined) {
    sliced = take(limitBound, sliced);
  }

  return map((r: Keyed) => r.b, sliced);
};
