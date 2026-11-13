/**
 * REALISTIC GQL WORKLOAD SHAPES, for the differential fuzzer's second arm.
 *
 * ⚠️ WHY THIS EXISTS. A census of the differential fuzzer's generator (`FUZZ_DUMP`) over 20,000
 * queries said it was skewed badly away from what anyone actually runs against a graph database:
 *
 *     node-only (no edge traversed)   60.8%
 *     1-hop                           22.8%
 *     2-hop                            1.9%
 *     3-hop                            0.3%
 *     3-hop returning ROWS             0.0%
 *     carrying a PARAMETER             0.0%
 *
 * Two of those are holes rather than thin spots. Three-hop ROW queries were generated ZERO times,
 * which is how item 1814 came to record cross-engine coverage for a row rung whose every sampled
 * query was a `count(*)` it declines (item 1816). And parameters were not merely unsampled but
 * STRUCTURALLY UNREACHABLE — the fuzzer's `run` took no params at all, while both engines accept
 * them — so the entire parameterized surface had no byte-identity guard. That surface is not
 * incidental: the planner SEEKS on `$param` (see the native property-index work), and this repo's
 * "equivalent spellings must cost the same" rule is built on the `$x = u.k` / `u.k = $x` pair.
 *
 * ⚠️ WHY IT IS A SECOND ARM AND NOT A REBALANCE OF THE FIRST. The existing generator's band
 * boundaries are load-bearing: roughly twenty coverage floors at the end of the fuzzer are
 * calibrated against the shares those bands produce, and the file's own history records three
 * separate occasions where adding an arm diluted a neighbour's counter and had to be re-measured.
 * Compressing them to make room would drop every floor proportionally and silently. So this arm is
 * ADDITIVE — its own iterations, its own counters, its own floors — and not one existing boundary
 * moves. The whole differential fuzzer costs ~2s for 20,000 queries, so the second arm is cheap.
 *
 * ⚠️ EVERY FAMILY IS CHECKED NON-VACUOUS. A query that matches nothing compares nothing, which is
 * the trap item 51 and item 63 both fell into. `workload-queries.test.ts` asserts that each family
 * returns rows on the fuzzer's fixture, so a family that silently stops matching FAILS rather than
 * passing quietly.
 *
 * ⚠️ ONLY SPELLINGS BOTH ENGINES ACCEPT. `param-support-probe.mjs` priced twenty parameter
 * spellings against both engines before any of this was written; nineteen agree and are used here.
 * The twentieth, `SKIP $k`, is a live divergence — TS's parser restricts `SKIP` to a literal while
 * native accepts a parameter — and is pinned in `workload-queries.test.ts` rather than generated,
 * for the reason the differential fuzzer applies to a negative `percentile` fraction: generating a
 * known-open question makes the gate red for something that is not a regression. The ISO spelling
 * `OFFSET $k`, which both engines accept, is generated in its place.
 */

/** A generated workload query, with the parameters it must be run with. */
export type Workload = {
  /** The family that produced it — the census axis, and what the coverage floors count. */
  readonly family: string;
  readonly text: string;
  readonly params: Record<string, unknown>;
  /**
   * The `ORDER BY` is TOTAL, so the comparison must be IN ORDER rather than as a multiset.
   *
   * ⚠️ STATED BY THE GENERATOR, NOT RE-DERIVED FROM THE TEXT. Item 1040's band generated exactly
   * the right ordered query and was then compared as a multiset anyway, because the harness
   * recognised ordering by sniffing for a sentinel substring the band did not emit — 298 queries
   * that asked the ordered question and 0 that checked it. A generator that knows the answer
   * should say so rather than leave a regex to guess.
   */
  readonly ordered: boolean;
};

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

/**
 * Value pools drawn from the fuzzer's OWN fixture, so a parameterized predicate matches something.
 *
 * The misses are deliberate and bounded: a pool of only-hits never exercises the empty result, and
 * a pool of only-misses is the vacuous-family trap above. `n` carries two values no vertex has.
 */
const N_VALUES = [3, 5, 7, 11, 13, 17, 1, 99] as const;
const X_VALUES = [-1, 0, 2, 3, 4, 5] as const;
const S_VALUES = ['a', 'z', 'm', '', 'nope'] as const;
const W_VALUES = [1, 2, 3, 4, 5, 7, 9] as const;
const DATES = ['1999-12-31', '2024-01-02', '2024-01-03', '2031-11-30'] as const;
const CMP = ['=', '<>', '<', '<=', '>', '>='] as const;
/** `E` and `F` are the fixture's two edge types; the union spelling selects the one two-type edge. */
const TYPES = ['E', 'F', 'E|F'] as const;
/**
 * The node label to anchor on.
 *
 * ⚠️ `T` IS ON EVERY VERTEX, SO THE ENGINE ELIDES IT. That makes `(n:T)` useless for exercising
 * label filtering itself — the same reason the adversarial arm's targeted shapes reach for `U`.
 * `U` is on exactly one vertex, so the filter has to be applied rather than inherited from a
 * seed; the unlabeled spelling is a third route again (no label elision at all).
 */
const LABELS = [':T', ':T', ':U', ''] as const;
/**
 * The property a predicate reads.
 *
 * ⚠️ `nu` IS NULL ON SOME VERTICES AND ABSENT ON OTHERS, which is the realistic case and the one
 * that reaches THREE-VALUED LOGIC: a comparison against a missing or null value is UNKNOWN, the
 * row drops, and an engine that treats UNKNOWN as FALSE agrees with one that treats it correctly
 * on every query where nothing is null. `n` and `x` are present everywhere, so a generator using
 * only those never asks the question. `zz` is carried by no vertex at all.
 *
 * ⚠️ WEIGHTED, NOT UNIFORM, AND THE WEIGHTS ARE THE POINT. `U` is on one vertex of six and `zz`
 * on none, so drawing them uniformly would make roughly half of every scan family's queries
 * EMPTY — and an empty result compares nothing, which is the trap these families exist to avoid.
 * Repeating the dense options halves that cost while keeping the selective and absent ones
 * reachable.
 *
 * The weights are worth less than they look, and the measurement says so: point-lookup's
 * non-empty rate went 36.5% uniform to 38.7% weighted. Most of that family's empties come from
 * its `IS NULL` / `IS NOT NULL` bodies rather than from the pools, so the weighting is a real
 * but small effect — recorded at its measured size rather than at the size it was expected to be.
 * 39% of 1,200 draws is still ~460 non-empty per family per run, far above any floor here.
 */
const SCAN_PROPS = ['n', 'x', 'n', 'x', 'nu', 'zz'] as const;

const date = (v: string): Record<string, string> => ({ '@date': v });

/**
 * Attach an `ORDER BY` — or deliberately NOT, which is half the point of this helper.
 *
 * ⚠️ REALISTIC IS NOT THE SAME AS ROUTED, AND THIS COST A WHOLE DRAFT OF THIS FILE. The first
 * version put an `ORDER BY` on every query it generated, so that the comparison could be made in
 * order. Every family still looked right, every census axis improved, and the `chain-rows` family
 * reached the chain rung it was written for ZERO times — because that rung DECLINES an `ORDER BY`
 * outright and falls to the general matcher. Measured, not reasoned: with a `throw` at the first
 * statement of the rung's sweep, 20,000 of those queries left the fuzzer GREEN, and the same
 * query without its `ORDER BY` threw immediately.
 *
 * That is item 1040's lesson pointing the other way. There, a band generated exactly the right
 * ordered query and the harness compared it as a multiset anyway; here a band generated exactly
 * the right query and the ENGINE sent it somewhere else. A generator that only ever spells a
 * query one way guards only the route that spelling takes, and the fuzzer cannot tell you which
 * route that is — only a deletion test in the route can.
 *
 * So both spellings are drawn. Unordered is compared as a multiset, which is the correct
 * invariant for an unordered result (`order-is-unspecified`) and loses nothing.
 *
 * ⚠️ PAGING ONLY WHEN ORDERED. A `LIMIT` with no `ORDER BY` lets row order decide WHICH rows
 * survive, so two engines that are both correct can return different rows. Generating that would
 * manufacture divergences out of a settled non-question, so `page` is reachable only on the
 * ordered branch.
 */
const withOrder = (
  r: () => number,
  body: string,
  keys: string,
  page = '',
): { text: string; ordered: boolean } =>
  r() < 0.5
    ? { text: `${body} ORDER BY ${keys}${page}`, ordered: true }
    : { text: body, ordered: false };

/**
 * A point lookup by property — the single most common query any application issues.
 *
 * All four spellings of the same question, because this engine's whole "equivalent spellings must
 * cost the same" rule exists for them: the param on the right, the param on the LEFT, the inline
 * `{k: $v}` form the planner seeks on, and the `FILTER` clause. Every index-seeding bug the old
 * engine had was the planner recognising one of these and scanning for another, and each returned
 * the correct answer — so only a differential over all four spellings sees it.
 */
const pointLookup = (r: () => number): Workload => {
  const l = pick(r, LABELS);
  const k = pick(r, SCAN_PROPS);
  const body = pick(r, [
    `MATCH (n${l}) WHERE n.${k} = $p0 RETURN n.n AS x, n.s AS s`,
    `MATCH (n${l}) WHERE $p0 = n.${k} RETURN n.n AS x, n.s AS s`,
    `MATCH (n${l} {${k}: $p0}) RETURN n.n AS x, n.s AS s`,
    `MATCH (n${l}) FILTER n.${k} = $p0 RETURN n.n AS x, n.s AS s`,
    `MATCH (n${l}) WHERE n.${k} IS NULL RETURN n.n AS x, n.s AS s`,
    `MATCH (n${l}) WHERE n.${k} IS NOT NULL RETURN n.n AS x, n.s AS s`,
  ]);

  return { family: 'point-lookup', ...withOrder(r, body, 'x'), params: { p0: pick(r, N_VALUES) } };
};

/** A string lookup — a different column type through the same spellings. */
const stringLookup = (r: () => number): Workload => {
  const body = pick(r, [
    'MATCH (n:T) WHERE n.s = $p0 RETURN n.n AS x',
    'MATCH (n:T {s: $p0}) RETURN n.n AS x',
    'MATCH (n:T) WHERE n.s <> $p0 RETURN n.n AS x',
    'MATCH (n:T) WHERE $p0 = n.s RETURN n.n AS x',
  ]);

  return { family: 'string-lookup', ...withOrder(r, body, 'x'), params: { p0: pick(r, S_VALUES) } };
};

/** A bounded range scan with paging — the "list page N of the filtered rows" shape. */
const rangeScan = (r: () => number): Workload => {
  const l = pick(r, LABELS);
  const k = pick(r, SCAN_PROPS);
  const body = pick(r, [
    `MATCH (n${l}) WHERE n.${k} >= $p0 AND n.${k} <= $p1 RETURN n.n AS x, n.${k} AS xx`,
    `MATCH (n${l}) WHERE n.${k} > $p0 RETURN n.n AS x, n.${k} AS xx`,
    `MATCH (n${l}) WHERE NOT (n.${k} > $p0) RETURN n.n AS x, n.${k} AS xx`,
    `MATCH (n${l}) WHERE n.${k} >= $p0 OR n.n = $p1 RETURN n.n AS x, n.${k} AS xx`,
  ]);
  // OFFSET, not SKIP: both engines accept a parameter after the ISO spelling, and only native
  // accepts one after the Cypher synonym (see the header). Paging rides the ordered branch only.
  const page = pick(r, ['', ' LIMIT $p2', ' OFFSET $p2', ' OFFSET $p2 LIMIT 2', ' LIMIT 3']);

  return {
    family: 'range-scan',
    ...withOrder(r, body, `xx${pick(r, ['', ' DESC'])}, x`, page),
    params: { p0: pick(r, X_VALUES), p1: pick(r, X_VALUES), p2: 1 + Math.floor(r() * 3) },
  };
};

/** `IN $ids` — the batched-lookup shape every ORM emits, as a param list and as a literal list. */
const inList = (r: () => number): Workload => {
  const ids = [pick(r, N_VALUES), pick(r, N_VALUES)];
  const body = pick(r, [
    'MATCH (n:T) WHERE n.n IN $p0 RETURN n.n AS x',
    'MATCH (n:T) WHERE n.n IN [$p1, $p2] RETURN n.n AS x',
    'MATCH (n:T) WHERE NOT (n.n IN $p0) RETURN n.n AS x',
  ]);

  return {
    family: 'in-list',
    ...withOrder(r, body, 'x'),
    params: { p0: ids, p1: ids[0], p2: ids[1] },
  };
};

/** One hop from a parameterized anchor — "who does this node point at". */
const neighbors = (r: () => number): Workload => {
  const t = pick(r, TYPES);
  // The FAR label is the selective position: `(b:U)` is one vertex, so a hop that forgets to
  // apply it over-counts, which is exactly the bug class the adversarial arm's targeted shapes
  // were spelled out for. Drawn independently of the near label so the cross-product is reached.
  const near = pick(r, LABELS);
  const far = pick(r, LABELS);
  const body = pick(r, [
    `MATCH (a${near})-[:${t}]->(b${far}) WHERE a.n = $p0 RETURN b.n AS x`,
    `MATCH (a${near})<-[:${t}]-(b${far}) WHERE a.n = $p0 RETURN b.n AS x`,
    `MATCH (a${near} {n: $p0})-[:${t}]->(b${far}) RETURN b.n AS x`,
    `MATCH (a${near})-[:${t}]-(b${far}) WHERE a.n = $p0 RETURN b.n AS x`,
    `MATCH (a${near})-[:${t}]->(b${far}) RETURN b.n AS x`,
    `MATCH (a${near})-[:${t}]->(b${far}) WHERE b.n > $p0 RETURN b.n AS x`,
  ]);

  return { family: 'neighbors', ...withOrder(r, body, 'x'), params: { p0: pick(r, N_VALUES) } };
};

/**
 * Two, three and four hops RETURNING ROWS — the shape the old generator produced zero of.
 *
 * ⚠️ THREE SPELLING AXES, ALL LOAD-BEARING, AND THE ROUTE DEPENDS ON EVERY ONE:
 *
 *   - FAR-END-ONLY vs INTERIOR read. A far-end-only projection is answered by a batched sweep
 *     that discards the path; reading an interior variable must route to the depth-first
 *     descent. Drawing only one guards only one (item 1816).
 *   - ORDERED vs NOT, via `withOrder`. An `ORDER BY` DECLINES the chain rung outright, so the
 *     ordered spelling measures the general matcher and the bare one measures the rung. The
 *     first draft of this file drew only the ordered spelling and reached the rung zero times.
 *   - SEGMENT COUNT. The rung admits three segments and up, while two hops have had their own
 *     separate rung since item 1619 — adjacent shapes on different code.
 */
const chainRows = (r: () => number): Workload => {
  const t = pick(r, TYPES);
  const body = pick(r, [
    // Two segments — the older hop2 rung.
    `MATCH (a:T)-[:${t}]->(b:T)-[:${t}]->(c:T) RETURN c.n AS x`,
    `MATCH (a:T)-[:${t}]->(b:T)-[:${t}]->(c:T) RETURN a.n AS x, c.n AS y`,
    `MATCH (a:T)-[:${t}]->(b:T)-[:${t}]->(c:T) WHERE a.n = $p0 RETURN c.n AS x`,
    // Three segments, FAR-END-ONLY — the batched sweep.
    `MATCH (a:T)-[:${t}]->(b:T)-[:${t}]->(c:T)-[:${t}]->(d:T) RETURN d.n AS x`,
    `MATCH (a:T)-[:${t}]->(b:T)-[:${t}]->(c:T)-[:${t}]->(d:T) WHERE d.n <> $p0 RETURN d.n AS x`,
    `MATCH (a:T {n: $p0})-[:${t}]->(b:T)-[:${t}]->(c:T)-[:${t}]->(d:T) RETURN d.n AS x`,
    // Three segments, INTERIOR read — must route to the descent instead.
    `MATCH (a:T)-[:${t}]->(b:T)-[:${t}]->(c:T)-[:${t}]->(d:T) RETURN b.n AS x, d.n AS y`,
    `MATCH (a:T)-[:${t}]->(b:T)-[:${t}]->(c:T)-[:${t}]->(d:T) WHERE b.n > $p0 RETURN d.n AS x`,
    `MATCH (a:T)-[:${t}]->(b:T)-[:${t}]->(c:T)-[:${t}]->(d:T) RETURN a.n AS x, c.n AS y`,
    // Four segments — past the depth any hand-written test here covers.
    `MATCH (a:T)-[:${t}]->(b:T)-[:${t}]->(c:T)-[:${t}]->(d:T)-[:${t}]->(f:T) RETURN f.n AS x`,
    `MATCH (a:T)-[:${t}]->(b:T)-[:${t}]->(c:T)-[:${t}]->(d:T)-[:${t}]->(f:T) RETURN c.n AS x, f.n AS y`,
  ]);
  const keys = body.includes(' AS y') ? 'x, y' : 'x';

  return { family: 'chain-rows', ...withOrder(r, body, keys), params: { p0: pick(r, N_VALUES) } };
};

/** A traversal filtered on an EDGE property, returning the edge's own value alongside the ends. */
const edgeFilter = (r: () => number): Workload => {
  const t = pick(r, TYPES);
  const cmp = pick(r, CMP);
  const body = pick(r, [
    `MATCH (a:T)-[e:${t}]->(b:T) WHERE e.w ${cmp} $p0 RETURN a.n AS x, b.n AS y`,
    `MATCH (a:T)-[e:${t}]->(b:T) WHERE e.w ${cmp} $p0 AND a.n > $p1 RETURN e.w AS x, a.n AS y`,
    `MATCH (a:T)-[e:${t} {w: $p0}]->(b:T) RETURN a.n AS x, b.n AS y`,
    `MATCH (a:T)-[e:${t}]->(b:T) WHERE $p0 ${cmp} e.w RETURN a.n AS x, b.n AS y`,
  ]);

  return {
    family: 'edge-filter',
    ...withOrder(r, body, 'x, y'),
    params: { p0: pick(r, W_VALUES), p1: pick(r, N_VALUES) },
  };
};

/**
 * Scalar aggregates over a filtered set — the "dashboard number" query.
 *
 * Always `ordered: true` and never given an `ORDER BY`: a scalar aggregate returns exactly one
 * row, so the in-order and multiset comparisons are the same check and the stricter one is free.
 */
const aggregate = (r: () => number): Workload => {
  const fn = pick(r, ['count', 'sum', 'avg', 'min', 'max']);
  const arg = fn === 'count' ? '*' : 'n.n';
  const text = pick(r, [
    `MATCH (n:T) WHERE n.n >= $p0 RETURN ${fn}(${arg}) AS x`,
    `MATCH (n:T) WHERE n.x < $p1 RETURN ${fn}(${arg}) AS x`,
    `MATCH (a:T)-[:E]->(b:T) WHERE b.n >= $p0 RETURN ${fn === 'count' ? 'count(*)' : `${fn}(b.n)`} AS x`,
    `MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN count(*) AS x`,
    `MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T)-[:E]->(d:T) RETURN count(*) AS x`,
    'MATCH (n:T) RETURN count(DISTINCT n.x) AS x',
  ]);

  return {
    family: 'aggregate',
    text,
    ordered: true,
    params: { p0: pick(r, N_VALUES), p1: pick(r, X_VALUES) },
  };
};

/**
 * A grouped aggregate — "count per category", the second-most-common application query.
 *
 * The key is bound with `LET`, which is what ISO requires (a grouping element is a
 * binding-variable reference, not a RETURN alias) and what makes the fuzz mean anything: spelled
 * as an alias the key reads null and every query collapses to one group.
 */
const grouped = (r: () => number): Workload => {
  const body = pick(r, [
    'MATCH (n:T) LET g = n.x RETURN g, count(*) AS c GROUP BY g',
    'MATCH (n:T) WHERE n.n >= $p0 LET g = n.x RETURN g, count(*) AS c GROUP BY g',
    'MATCH (a:T)-[:E]->(b:T) LET g = a.n RETURN g, count(*) AS c GROUP BY g',
    'MATCH (a:T)-[:E]->(b:T) LET g = a.n RETURN g, sum(b.n) AS c GROUP BY g',
    'MATCH (a:T)-[e:E]->(b:T) LET g = e.w RETURN g, count(*) AS c GROUP BY g',
    'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) LET g = a.n RETURN g, count(*) AS c GROUP BY g',
    'MATCH (n:T) LET g = n.x RETURN g, min(n.n) AS c GROUP BY g',
  ]);

  return { family: 'grouped', ...withOrder(r, body, 'g, c'), params: { p0: pick(r, N_VALUES) } };
};

/** Semi-join and anti-join — "has at least one", "has none", the authorization-shaped query. */
const existence = (r: () => number): Workload => {
  const t = pick(r, TYPES);
  const body = pick(r, [
    `MATCH (a:T) WHERE EXISTS { MATCH (a)-[:${t}]->(b:T) WHERE b.n > $p0 } RETURN a.n AS x`,
    `MATCH (a:T) WHERE NOT EXISTS { MATCH (a)-[:${t}]->(b:T) WHERE b.n > $p0 } RETURN a.n AS x`,
    `MATCH (a:T) WHERE EXISTS { MATCH (a)-[:${t}]->(b:T) } AND a.n <> $p0 RETURN a.n AS x`,
    `MATCH (a:T) WHERE COUNT { MATCH (a)-[:${t}]->(b:T) } > $p1 RETURN a.n AS x`,
    // The two-hop body, which makes the subquery itself a traversal rather than a degree test.
    `MATCH (a:T) WHERE EXISTS { MATCH (a)-[:${t}]->(b:T)-[:${t}]->(c:T) } RETURN a.n AS x`,
  ]);

  return {
    family: 'existence',
    ...withOrder(r, body, 'x'),
    params: { p0: pick(r, N_VALUES), p1: Math.floor(r() * 3) },
  };
};

/** The left join — every row of the anchor, with the hop's columns null where it does not match. */
const optional = (r: () => number): Workload => {
  const t = pick(r, TYPES);
  const body = pick(r, [
    `MATCH (a:T) OPTIONAL MATCH (a)-[:${t}]->(b:T) RETURN a.n AS x, b.n AS y`,
    `MATCH (a:T) WHERE a.n >= $p0 OPTIONAL MATCH (a)-[:${t}]->(b:T) RETURN a.n AS x, b.n AS y`,
    `MATCH (a:T) OPTIONAL MATCH (a)-[e:${t}]->(b:T) RETURN a.n AS x, e.w AS y`,
  ]);

  return { family: 'optional', ...withOrder(r, body, 'x, y'), params: { p0: pick(r, N_VALUES) } };
};

/** DISTINCT over a traversal — "which nodes are reachable", deduped. */
const distinct = (r: () => number): Workload => {
  const t = pick(r, TYPES);
  const body = pick(r, [
    `MATCH (a:T)-[:${t}]->(b:T) RETURN DISTINCT b.n AS x`,
    `MATCH (a:T)-[:${t}]->(b:T)-[:${t}]->(c:T) RETURN DISTINCT c.n AS x`,
    `MATCH (a:T)-[:${t}]->(b:T)-[:${t}]->(c:T)-[:${t}]->(d:T) RETURN DISTINCT d.n AS x`,
    `MATCH (a:T)-[:${t}]->(b:T) WHERE a.n >= $p0 RETURN DISTINCT b.n AS x`,
  ]);

  return { family: 'distinct', ...withOrder(r, body, 'x'), params: { p0: pick(r, N_VALUES) } };
};

/** A multi-pattern MATCH — the comma join, where the second pattern reuses the first's binding. */
const multiPattern = (r: () => number): Workload => {
  const body = pick(r, [
    'MATCH (a:T)-[:E]->(b:T), (b)-[:E]->(c:T) RETURN a.n AS x, c.n AS y',
    'MATCH (a:T)-[:E]->(b:T), (a)-[:E]->(c:T) WHERE b.n <> c.n RETURN b.n AS x, c.n AS y',
    'MATCH (a:T), (b:T) WHERE a.n = $p0 AND b.n > a.n RETURN b.n AS x, a.n AS y',
    'MATCH (a:T)-[:E]->(b:T), (c:T)-[:F]->(d:T) RETURN b.n AS x, d.n AS y',
  ]);

  return {
    family: 'multi-pattern',
    ...withOrder(r, body, 'x, y'),
    params: { p0: pick(r, N_VALUES) },
  };
};

/**
 * A date range — the user's domain is a people-graph over time, so a temporal predicate is a
 * realistic shape rather than an exotic one, and it is passed as a PARAMETER (the form an
 * application uses) as well as compared against a stored date on the far side of a hop.
 */
const temporalRange = (r: () => number): Workload => {
  const cmp = pick(r, CMP);
  const body = pick(r, [
    `MATCH (n:T) WHERE n.d ${cmp} $p0 RETURN n.n AS x`,
    'MATCH (n:T) WHERE n.d >= $p0 AND n.d <= $p1 RETURN n.n AS x',
    `MATCH (a:T)-[:E]->(b:T) WHERE b.d ${cmp} $p0 RETURN a.n AS x, b.n AS y`,
    `MATCH (a:T)-[:E]->(b:T) WHERE a.d ${cmp} b.d RETURN a.n AS x, b.n AS y`,
  ]);

  return {
    family: 'temporal-range',
    ...withOrder(r, body, body.includes(' AS y') ? 'x, y' : 'x'),
    params: { p0: date(pick(r, DATES)), p1: date(pick(r, DATES)) },
  };
};

/** Bounded reachability — the quantified path, returning ROWS as well as a count. */
const varLength = (r: () => number): Workload => {
  const bound = pick(r, ['{1,2}', '{1,3}', '{2,3}', '{1,1}']);
  const body = pick(r, [
    `MATCH (a:T)-[:E]->${bound}(b:T) RETURN DISTINCT b.n AS x`,
    `MATCH (a:T)-[:E]->${bound}(b:T) WHERE a.n = $p0 RETURN DISTINCT b.n AS x`,
    `MATCH TRAIL (a:T)-[:E]->${bound}(b:T) RETURN DISTINCT b.n AS x`,
    `MATCH ACYCLIC (a:T)-[:E]->${bound}(b:T) WHERE a.n = $p0 RETURN DISTINCT b.n AS x`,
  ]);
  const counting = pick(r, [
    `MATCH (a:T)-[:E]->${bound}(b:T) RETURN count(*) AS x`,
    `MATCH TRAIL (a:T)-[:E]->${bound}(b:T) RETURN count(*) AS x`,
    `MATCH ACYCLIC (a:T)-[:E]->${bound}(b:T) WHERE a.n = $p0 RETURN count(*) AS x`,
  ]);

  return r() < 0.3
    ? { family: 'var-length', text: counting, ordered: true, params: { p0: pick(r, N_VALUES) } }
    : { family: 'var-length', ...withOrder(r, body, 'x'), params: { p0: pick(r, N_VALUES) } };
};

/** The projection-only read — no predicate, just columns and an order, over nodes and over a hop. */
const projection = (r: () => number): Workload => {
  const body = pick(r, [
    'MATCH (n:T) RETURN n.n AS x, n.s AS s, n.x AS xx',
    'MATCH (n:T) RETURN n.n AS x',
    'MATCH (a:T)-[e:E]->(b:T) RETURN a.n AS x, e.w AS y',
    'MATCH (n:T) LET v = n.n + $p1 RETURN v AS x',
    'MATCH (n:T) RETURN n.n AS x, n.d AS d',
  ]);
  const page = pick(r, ['', ' LIMIT $p0', ' OFFSET $p0', ' LIMIT 3']);

  return {
    family: 'projection',
    ...withOrder(r, body, body.includes(' AS y') ? 'x, y' : 'x', page),
    params: { p0: 1 + Math.floor(r() * 3), p1: pick(r, N_VALUES) },
  };
};

/** UNION of two reads — one pipeline feeding from two sources, which is its own executor path. */
const union = (r: () => number): Workload => {
  const text = pick(r, [
    'MATCH (n:T) WHERE n.n = $p0 RETURN n.n AS x UNION MATCH (n:T) WHERE n.n = $p1 RETURN n.n AS x',
    'MATCH (n:T) WHERE n.n = $p0 RETURN n.n AS x UNION ALL MATCH (n:T) WHERE n.n = $p1 RETURN n.n AS x',
    'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x UNION MATCH (a:T)-[:F]->(b:T) RETURN b.n AS x',
    'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x UNION ALL MATCH (a:T)-[:F]->(b:T) RETURN b.n AS x',
  ]);

  return {
    family: 'union',
    text,
    // No ORDER BY over the UNION here, so it is compared as a multiset.
    ordered: false,
    params: { p0: pick(r, N_VALUES), p1: pick(r, N_VALUES) },
  };
};
/** The families, each drawn with EQUAL probability — the point of the item is the flat mix. */
export const WORKLOAD_FAMILIES: readonly ((r: () => number) => Workload)[] = [
  pointLookup,
  stringLookup,
  rangeScan,
  inList,
  neighbors,
  chainRows,
  edgeFilter,
  aggregate,
  grouped,
  existence,
  optional,
  distinct,
  multiPattern,
  temporalRange,
  varLength,
  projection,
  union,
];

/**
 * The family names, sorted — the census axis and what the fuzzer's floors are keyed on.
 *
 * Derived from the generators rather than written out a second time, so a family added to the
 * list above cannot be missing here: `() => 0` makes every internal `pick` take its first option,
 * which is enough because a family's name is a constant within its generator. A hand-maintained
 * twin of this list would be one more thing that can silently disagree with the generator, which
 * is the failure mode this whole item is about.
 */
export const WORKLOAD_FAMILY_NAMES: readonly string[] = [
  ...new Set(WORKLOAD_FAMILIES.map((f) => f(() => 0).family)),
].sort();

/**
 * Draw one realistic workload query.
 *
 * ⚠️ UNIFORM OVER FAMILIES, DELIBERATELY. The whole complaint this answers is a generator skewed
 * ~61% onto one shape, so the fix is not a different skew but a flat draw — and a flat draw over
 * the family LIST means adding a family automatically rebalances rather than needing a band
 * boundary moved by hand, which is what made the first generator's shares so hard to change.
 */
export const genWorkload = (r: () => number): Workload => pick(r, WORKLOAD_FAMILIES)(r);
