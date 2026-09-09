// Differential fuzzer: generate random GQL queries from a seeded PRNG, run each
// through BOTH engines (the TS @lenke/gql engine and the Rust engine over bun:ffi),
// and assert byte-identical behavior — the same JSON when both succeed, and
// both-error when either errors. Byte-identity is the hard invariant, so any value
// that renders/compares/coerces differently between the two engines is a bug. The
// generator deliberately favors the edge values that have bitten us before (extreme
// magnitudes, -0, NaN/Inf producers, astral/control chars, mixed types, deep
// nesting), and reaches across the whole scalar-function catalogue rather than a
// handful of names — the wider surface is where the coercion bugs live.
//
// Statement shapes are fuzzed too (aggregates, GROUP BY, ORDER BY, WHERE/FILTER,
// LET, FOR, SKIP/LIMIT, edge patterns), because several divergences were not in an
// expression at all but at a clause boundary.
//
// ORDER BY queries always carry `n.n` as a final sort key: row order is otherwise
// unspecified (see the ORDER-BY-less contract), and a tie would make the comparison
// flag a non-bug.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady, resultsEqual } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

const suite = nativeReady ? describe : describe.skip;

// A tiny two-vertex, one-edge graph so property access, record fields, edge
// patterns, and aggregates over rows can all be fuzzed.
const NDJSON = [
  '{"type":"node","id":"1","labels":["T"],"properties":{"n":3,"s":"a","x":-1,"m":{"k":1,"j":"q"}}}',
  '{"type":"node","id":"2","labels":["T"],"properties":{"n":7,"s":"z","x":4,"m":{"k":2,"j":"r"}}}',
  // Vertex 3 carries TWO labels, so `(n:T)` and `(n:U)` must BOTH find it. With
  // every vertex single-labelled, "match any label" and "match the first label"
  // are indistinguishable, and a label bug hides — which is how native's Gremlin
  // `hasLabel` matched only the first label for a long time without any fuzzer
  // noticing.
  '{"type":"node","id":"3","labels":["T","U"],"properties":{"n":5,"s":"m","x":2,"m":{"k":3,"j":"s"}}}',
  '{"type":"edge","id":"e1","labels":["E"],"from":"1","to":"2","properties":{"w":2}}',
  // ...and edge e2 carries TWO types, for the same reason on the edge side. The
  // label indexes bucket an edge under every type it carries, so anything that
  // sums or concatenates buckets — a `[:E|F]` count shortcut, a per-name
  // adjacency walk — sees this edge twice while native sees it once. With every
  // edge single-typed the two are indistinguishable, which is how the TS count
  // shortcut double-counted for a long time with every fuzzer green.
  '{"type":"edge","id":"e2","labels":["E","F"],"from":"2","to":"3","properties":{"w":5}}',
].join('\n');

// --- seeded PRNG (mulberry32) -----------------------------------------------
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;

  return () => {
    a |= 0;
    a = (a + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

// Distinct `FUZZ_SEED`s must explore DISJOINT cases. `SEED + i` did not: seeds 1
// and 2 differ in one case out of four hundred, so running eight seeds was ~1.02x
// the coverage of running one, not 8x. Multiplying by a large odd constant gives
// each base seed its own region while keeping a reported seed reproducible.
const caseSeed = (base: number, i: number): number => base * 1_000_003 + i;

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

// Number literals: normal, signed-zero, extreme magnitudes (exponential threshold),
// safe-integer boundary, and values that stress toString/collation.
const NUMS = [
  '0',
  '1',
  '-1',
  '0.0',
  '-0.0',
  '3.14',
  '-2.5',
  '0.1',
  '0.5',
  '1e21',
  '1e-7',
  '1e100',
  '1e-300',
  // Overflows an f64 to +Infinity — a DISTINCT present value (Model B), not null. Both
  // engines keep it (ordered, comparable, IS-NULL-false), coercing to null only at JSON
  // egress, so it must stay byte-identical through comparisons/aggregates/sort.
  '1e400',
  '123456.789',
  '9007199254740992',
  '2',
  '3',
  '100',
] as const;

// String literals (GQL single-quoted), including astral, BMP-boundary, control,
// and escape chars — the collation / escaping edge space.
const STR_CHARS = ['a', 'Z', '0', ' ', '\\u0041', '\\uE000', '\\n', '\\t', 'ä', '中'] as const;

const genString = (r: () => number): string => {
  const len = Math.floor(r() * 4);
  let s = "'";

  for (let i = 0; i < len; i++) {
    s += pick(r, STR_CHARS);
  }

  // Occasionally splice an astral char (surrogate pair) — the code-point vs
  // code-unit collation trap.
  if (r() < 0.2) {
    s += '😀';
  }

  return `${s}'`;
};

const TEMPORALS = [
  "date('2020-01-01')",
  "date('0001-01-01')",
  "datetime('2020-06-15T08:30:00')",
  "duration('P1Y2M')",
  "duration('P3DT4H')",
  "duration('PT-2.5S')",
  "zoned_datetime('2020-01-01T00:00:00Z')",
  "local_time('08:30:00')",
  "zoned_time('08:30:00+05:30')",
] as const;

// Strings that stress numeric-string coercion: non-finite spellings, radix
// prefixes, whitespace, empty — the exact forms JS Number() and Rust
// str::parse::<f64> disagree on.
const NUM_STRINGS = ["'inf'", "'nan'", "'0x10'", "'  5  '", "''", "'Infinity'", "'1e3'"] as const;

// A leaf: a literal value, a record/field access, or a property reference.
const genLeaf = (r: () => number): string => {
  const p = r();

  if (p < 0.28) {
    return pick(r, NUMS);
  }

  if (p < 0.36) {
    return pick(r, NUM_STRINGS);
  }

  if (p < 0.5) {
    return genString(r);
  }

  if (p < 0.56) {
    return r() < 0.5 ? 'true' : 'false';
  }

  if (p < 0.62) {
    return 'null';
  }

  if (p < 0.74) {
    return pick(r, TEMPORALS);
  }

  if (p < 0.8) {
    // A stored record, and a dotted path into one (including a missing field).
    return r() < 0.5 ? 'n.m' : `n.m.${pick(r, ['k', 'j', 'zz'])}`;
  }

  // property access over the row (n: number, s: string, x: number)
  return `n.${pick(r, ['n', 's', 'x'])}`;
};

const ARITH = ['+', '-', '*', '/', '%'] as const;
const CMP = ['<', '>', '=', '<=', '>=', '<>'] as const;

// The engine's unary scalar catalogue: numeric, string, conversion, and list.
// `power` is deliberately ABSENT from the binary list below — see the note there.
const UNARY_FN = [
  'abs',
  'sqrt',
  'ceil',
  'ceiling',
  'floor',
  'sign',
  'round',
  'exp',
  'ln',
  'log10',
  'sin',
  'cos',
  'tan',
  'cot',
  'asin',
  'acos',
  'atan',
  'sinh',
  'cosh',
  'tanh',
  'degrees',
  'radians',
  'to_string',
  'to_integer',
  'to_float',
  'to_boolean',
  'to_list',
  'size',
  'cardinality',
  'upper',
  'lower',
  'trim',
  'btrim',
  'ltrim',
  'rtrim',
  'char_length',
  'character_length',
  'byte_length',
  'octet_length',
  'reverse',
  'head',
  'last',
  'tail',
  'list_sort',
] as const;

// `power` is excluded on purpose: JS `Math.pow` uses repeated multiplication for
// integer exponents while Rust's `f64::powf` is correctly rounded, so the two
// engines differ in the last ulp (`power(1e-7, 3)` → 9.999999999999997e-22 vs
// 1e-21). That is a known, reported deviation, not something this fuzzer should
// rediscover on every run. Every other math function agrees exactly.
//
// KNOWN ERROR-TIMING DEVIATION (rare, error-vs-value, NOT a wrong answer). It exists
// because the native engine is a columnar OPTIMIZER and pure-TS is a naive row-by-row
// interpreter, so a genuine type error is evaluated over a different row-set:
//   `(NOT <non-bool>) AND (<prop cmp numlit that matches no row>)` — the engine seeds the
//   numeric conjunct via its typed-scan fast path, gets 0 rows, and never evaluates the
//   `NOT` residual (empty batch → no error, the same short-circuit that makes
//   `LIMIT 0 RETURN 1/0` safe) → []. TS evaluates `NOT` per row → throws. `NOT <non-bool>`
//   ALONE throws in both.
// Deferred deliberately: the fix (evaluate the doomed conjunct eagerly) fights the typed-
// scan seed optimization and is disproportionate to the pathological input. Fixing it later
// is non-breaking in the lenient direction (both return []); only newly making it THROW is
// a (malformed-query-only) breaking change. If a fuzzer run surfaces it, it is expected.
// (The sibling paged-out-projection deviation — a fallible `CAST` under `ORDER BY … SKIP`
// reaching the end — was FIXED: `try_late_materialize` now fires when a SKIP drops the
// prefix, so only surviving rows are projected.)
const BINARY_FN = [
  'mod',
  'log',
  'atan2',
  'left',
  'right',
  'split',
  'contains',
  'starts_with',
  'ends_with',
  'nullif',
  'append',
  'list_union',
  'intersection',
  'difference',
  'list_contains',
  'coalesce',
  'duration_between',
] as const;

const TERNARY_FN = ['substring', 'replace'] as const;

// Arity-governed scalar functions shared by both engines. Emitting each with a
// deliberately-varied argument count (0..4) drives the TS arity table and native's
// parse-time arity check into lockstep: a wrong count must be rejected by BOTH, and a
// coincidentally-valid count must still agree on the answer. `power` is absent for the
// same reason it is absent from BINARY_FN — its known last-ulp value deviation would read
// as a false divergence at its valid arity of 2. `range` also needs bounded literal args,
// so it is not drawn here (its own generator branch keeps it bounded).
const ARITY_FN = [
  ...UNARY_FN, // 1-arg, plus round/btrim/ltrim/rtrim (1|2) and list_sort (1..3)
  ...BINARY_FN, // 2-arg, plus coalesce (>=1); note: power is deliberately not in BINARY_FN
  ...TERNARY_FN, // substring (2|3), replace (3)
  'e',
  'pi', // 0-arg
] as const;

// A known scalar function with a deliberately-varied argument count. Most draws land on
// a WRONG count (the divergence being tested); a coincidentally-valid count is fine — it
// just re-exercises the correct-arity path, which must already agree.
const genArityCall = (r: () => number): string => {
  const fn = pick(r, ARITY_FN);
  const argc = Math.floor(r() * 5); // 0..4
  const args: string[] = [];

  for (let i = 0; i < argc; i += 1) {
    args.push(genLeaf(r));
  }

  return `${fn}(${args.join(', ')})`;
};
const CAST_TYPES = ['INTEGER', 'FLOAT', 'STRING', 'BOOLEAN'] as const;
const IS_TESTS = [
  'IS NULL',
  'IS NOT NULL',
  'IS TRUE',
  'IS NOT TRUE',
  'IS FALSE',
  'IS UNKNOWN',
] as const;

const genExpr = (r: () => number, depth: number): string => {
  if (depth <= 0 || r() < 0.32) {
    return genLeaf(r);
  }

  // Wrong-arity probe: a known scalar function called with a varied argument count,
  // nestable anywhere an expression can go (so arity is checked inside arithmetic, a
  // CASE branch, etc. — matching native's eager, reachability-independent rejection).
  if (r() < 0.06) {
    return genArityCall(r);
  }

  const p = r();

  const e = (): string => genExpr(r, depth - 1);

  // Signed-zero probe (deterministic ~4% slice). `cot(±0)` is `±Inf` — the sign bit of a
  // *zero* is the one thing that leaks into the sign of an *infinity*, and that Inf is only
  // observable through a comparison (it collapses to null on RETURN). This is exactly the
  // shape that diverged (native erased the `-0.0` literal, TS kept it) before the "no
  // negative zero" fix. Emitting it on EVERY run — over literal, computed, and
  // property-derived zeros — guards that invariant deterministically instead of hoping the
  // generator stumbles onto `cot(-0.0) < 0` by chance.
  if (p < 0.04) {
    const zero = pick(r, [
      '-0.0',
      '0.0',
      '(-1.0 * 0.0)',
      '(0.0 * n.x)',
      '(0.0 - 0.0)',
      '(n.x - n.x)',
    ]);

    return `(${pick(r, ['-0.0', '0.0'])} ${pick(r, CMP)} cot(${zero}))`;
  }

  if (p < 0.14) {
    return `(${e()} ${pick(r, ARITH)} ${e()})`;
  }

  if (p < 0.24) {
    return `(${e()} ${pick(r, CMP)} ${e()})`;
  }

  if (p < 0.38) {
    return `${pick(r, UNARY_FN)}(${e()})`;
  }

  if (p < 0.5) {
    return `${pick(r, BINARY_FN)}(${e()}, ${e()})`;
  }

  // `range` takes bounded literal arguments: it materializes the whole list
  // eagerly, so a fuzzed `range(0, 1e21)` would hang both engines instead of
  // exploring anything.
  if (p < 0.52) {
    return `range(${pick(r, ['0', '1', '-3'])}, ${pick(r, ['0', '3', '-1', '10'])})`;
  }

  if (p < 0.58) {
    return `${pick(r, TERNARY_FN)}(${e()}, ${e()}, ${e()})`;
  }

  if (p < 0.64) {
    return `[${e()}, ${e()}]`;
  }

  // ISO list indexing — 0-based; a null/negative/non-integer/out-of-range index
  // is null-safe, not an error.
  if (p < 0.7) {
    return `[${e()}, ${e()}][${pick(r, ['0', '1', '2', '-1', 'null', "'a'", '0.5'])}]`;
  }

  if (p < 0.74) {
    return `(${e()} || ${e()})`;
  }

  if (p < 0.78) {
    return `CAST(${e()} AS ${pick(r, CAST_TYPES)})`;
  }

  if (p < 0.82) {
    return `(${e()} ${pick(r, IS_TESTS)})`;
  }

  if (p < 0.86) {
    return `(${e()} ${pick(r, ['AND', 'OR', 'XOR'])} ${e()})`;
  }

  if (p < 0.89) {
    return `(NOT ${e()})`;
  }

  if (p < 0.92) {
    return `(${e()} IN [${e()}, ${e()}])`;
  }

  // Record constructor, half the time with a field access (including a missing one).
  if (p < 0.95) {
    return `{a: ${e()}, b: ${e()}}${r() < 0.5 ? `.${pick(r, ['a', 'b', 'zz'])}` : ''}`;
  }

  if (p < 0.97) {
    return `coalesce(${e()}, ${e()}, ${e()})`;
  }

  return `CASE WHEN (${e()} ${pick(r, CMP)} ${e()}) THEN ${e()} WHEN (${e()} ${pick(r, CMP)} ${e()}) THEN ${e()} ELSE ${e()} END`;
};

const AGG = [
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'collect_list',
  'stddev_pop',
  'stddev_samp',
] as const;

// An inline `CALL (scope) { … }` query. Nothing here generated one before, so the
// whole correlated-subquery surface — the lateral join, OPTIONAL left-outer null-fill,
// `RETURN *`, the per-outer-row `UNION`/`EXCEPT`/`INTERSECT` combine (scope-var AND
// fresh-scan arms), the uncorrelated global set-op, and the scalar-aggregate body — was
// invisible to the fuzzer. Comparison is structural (row multiset), which is the correct
// invariant: intra-group row order in a CALL without ORDER BY is unspecified. The yields
// are plain property refs (not genExpr) so a divergence is attributable to CALL mechanics,
// not to an unrelated scalar-function difference. The fixture gives node 3 no out-edge, so
// the empty-body cases (OPTIONAL null-fill, sum→0, min/max→null) are exercised.
const genCall = (r: () => number): string => {
  const et = (): string => pick(r, ['E', 'F', 'E|F']);
  const opt = r() < 0.35 ? 'OPTIONAL ' : '';
  const k = r();

  // Plain / OPTIONAL correlated lateral join yielding a scalar.
  if (k < 0.22) {
    return `MATCH (a:T) ${opt}CALL (a) { MATCH (a)-[e:${et()}]->(b) RETURN b.n AS bn } RETURN a.n AS an, bn`;
  }

  // `RETURN *` carries the fresh body var back into the outer scope.
  if (k < 0.36) {
    return `MATCH (a:T) ${opt}CALL (a) { MATCH (a)-[:${et()}]->(b) RETURN * } RETURN a.n AS an, b.n AS bn`;
  }

  // A single scalar aggregate body (sum/avg/min/max reduce e.w; count tallies b).
  if (k < 0.56) {
    const agg = pick(r, ['sum', 'avg', 'min', 'max', 'count']);
    const arg = agg === 'count' ? 'b' : 'e.w';

    return `MATCH (a:T) ${opt}CALL (a) { MATCH (a)-[e:${et()}]->(b) RETURN ${agg}(${arg}) AS ag } RETURN a.n AS an, ag`;
  }

  // Set-op body, BOTH arms scope-var-rooted.
  if (k < 0.72) {
    const op = pick(r, ['UNION', 'UNION ALL', 'EXCEPT', 'INTERSECT']);

    return `MATCH (a:T) ${opt}CALL (a) { MATCH (a)-[:${et()}]->(b) RETURN b.n AS x ${op} MATCH (a)-[:${et()}]->(c) RETURN c.n AS x } RETURN a.n AS an, x`;
  }

  // Set-op body with a FRESH-scan arm (correlation on one side only).
  if (k < 0.88) {
    const op = pick(r, ['UNION', 'EXCEPT', 'INTERSECT']);
    const arms = pick(r, [
      `MATCH (m:T) RETURN m.n AS x ${op} MATCH (a)-[:${et()}]->(b) RETURN b.n AS x`,
      `MATCH (a)-[:${et()}]->(b) RETURN b.n AS x ${op} MATCH (m:T) RETURN m.n AS x`,
    ]);

    return `MATCH (a:T) ${opt}CALL (a) { ${arms} } RETURN a.n AS an, x`;
  }

  if (k < 0.94) {
    // Shapes that used to be rejected by native but accepted by TS: an UNCORRELATED
    // OPTIONAL CALL (null-fills the outer row when the global body is empty), a compound
    // label on a correlated-CALL fresh-scan start (`:T&U`), and an aggregating uncorrelated
    // body. The `:U` filter can select nothing, exercising the OPTIONAL null-fill.
    const lbl = pick(r, ['T', 'U', 'T&U', 'T|U', '!U']);

    return pick(r, [
      // Uncorrelated OPTIONAL CALL — empty body ⇒ null-filled yield, non-empty ⇒ cross-join.
      `MATCH (a:T) ${opt}CALL { MATCH (z:${lbl}) RETURN z.n AS zn } RETURN a.n AS an, zn`,
      // Compound label on a CALL fresh-scan start node.
      `MATCH (a:T) CALL (a) { MATCH (q:${lbl}) RETURN q.n AS qn } RETURN a.n AS an, qn`,
      // Aggregating uncorrelated body.
      `MATCH (a:T) CALL { MATCH (z:${lbl}) RETURN count(*) AS c } RETURN a.n AS an, c`,
    ]);
  }

  // Uncorrelated global set-op cross-joined with a single outer row.
  const op = pick(r, ['UNION', 'UNION ALL', 'EXCEPT', 'INTERSECT']);

  return `MATCH (a:T {n: ${pick(r, ['3', '5', '7'])}}) CALL () { MATCH (m:T) RETURN m.n AS x ${op} MATCH (m:U) RETURN m.n AS x } RETURN a.n AS an, x`;
};

// A full query. Every ORDER BY ends with the distinct `n.n` so the row order is
// total — an unordered tie is unspecified, not a divergence.
const genQuery = (r: () => number): string => {
  const p = r();

  // Inline correlated-subquery CALL — the whole surface Phases 0–3 built.
  if (p < 0.12) {
    return genCall(r);
  }

  if (p < 0.2) {
    const distinct = r() < 0.5 ? 'DISTINCT ' : '';

    return `MATCH (n:T) RETURN ${pick(r, AGG)}(${distinct}${genExpr(r, 2)}) AS x`;
  }

  if (p < 0.26) {
    const kind = r() < 0.5 ? 'cont' : 'disc';

    return `MATCH (n:T) RETURN percentile_${kind}(${genExpr(r, 2)}, ${pick(r, ['0', '0.5', '1', '0.25'])}) AS x`;
  }

  // Grouped aggregate — exercises GROUP BY keying over a fuzzed key.
  //
  // The key is bound with `LET`, which is both what ISO requires (a grouping
  // element is a binding-variable reference, so it cannot be a RETURN alias or a
  // bare expression) and what makes this fuzz anything: spelled `RETURN <expr>
  // AS k … GROUP BY k` the key read as null, so EVERY generated query collapsed
  // to one group whatever the expression evaluated to.
  if (p < 0.34) {
    return `MATCH (n:T) LET k = ${genExpr(r, 1)} RETURN k, count(*) AS c GROUP BY k ORDER BY k, c`;
  }

  if (p < 0.42) {
    const dir = pick(r, ['ASC', 'DESC']);
    const nulls = pick(r, ['', ' NULLS FIRST', ' NULLS LAST']);

    return `MATCH (n:T) RETURN ${genExpr(r, 2)} AS x, n.n AS t ORDER BY x ${dir}${nulls}, t`;
  }

  if (p < 0.48) {
    return `MATCH (n:T) WHERE ${genExpr(r, 2)} RETURN n.n AS x ORDER BY x`;
  }

  if (p < 0.54) {
    return `MATCH (n:T) LET v = ${genExpr(r, 2)} RETURN v AS x, n.n AS t ORDER BY t`;
  }

  if (p < 0.6) {
    return `FOR v IN ${genExpr(r, 2)} RETURN v AS x`;
  }

  if (p < 0.64) {
    return `MATCH (n:T) FILTER ${genExpr(r, 2)} RETURN n.n AS x ORDER BY x`;
  }

  if (p < 0.68) {
    return `MATCH (a:T)-[e:E]->(b:T) RETURN ${genExpr(r, 2)} AS x`;
  }

  if (p < 0.685) {
    // The GRAPH functions, over a fixture holding a multi-label node AND a
    // multi-type edge. `labels` is not an ISO GQL function — it is a Cypher
    // inheritance the vendors who ship it define over an ELEMENT (Spanner's
    // `LABELS(GRAPH_ELEMENT)`, Fabric's `labels(node_or_edge)`), so it has to
    // agree across the two engines on edges as well as nodes. Nothing here was
    // fuzzed before: the generator called no graph function at all.
    const shape = pick(r, [
      'MATCH (n:T) RETURN labels(n) AS x, n.n AS t ORDER BY t',
      'MATCH ()-[e]->() RETURN labels(e) AS x ORDER BY x',
      'MATCH ()-[e]->() RETURN type(e) AS x ORDER BY x',
      'MATCH ()-[e]->() RETURN size(labels(e)) AS x ORDER BY x',
      'MATCH (n:T) RETURN property_names(n) AS x, n.n AS t ORDER BY t',
      'MATCH ()-[e]->() RETURN element_id(e) IS NOT NULL AS x ORDER BY x',
      // The set is what `IS LABELED` and a `[:...]` pattern agree with.
      'MATCH ()-[e:E]->() RETURN labels(e) AS x ORDER BY x',
      'MATCH ()-[e:F]->() RETURN labels(e) AS x ORDER BY x',
    ]);

    return shape;
  }

  if (p < 0.69) {
    // A type disjunction over a graph holding a two-type edge: `E`, `F` and
    // `E|F` all select edge e2, and it is ONE edge in every spelling. Routed
    // through both the count shortcuts and plain enumeration.
    const t = pick(r, ['E', 'F', 'E|F', 'F|E', 'E|ABSENT']);
    const shape = pick(r, [
      `MATCH ()-[:${t}]->() RETURN count(*) AS x`,
      `MATCH (a:T)-[:${t}]->(b:T) RETURN count(*) AS x`,
      `MATCH (a)-[:${t}]->(b)-[:${t}]->(c) RETURN count(*) AS x`,
      `MATCH (a)-[e:${t}]->(b) RETURN e.w AS x ORDER BY x`,
    ]);

    return shape;
  }

  if (p < 0.72) {
    const skip = pick(r, ['0', '1', '2']);
    const limit = pick(r, ['0', '1', '2']);

    return `MATCH (n:T) RETURN ${genExpr(r, 2)} AS x, n.n AS t ORDER BY t SKIP ${skip} LIMIT ${limit}`;
  }

  // ISO `<order by and page statement>` in STATEMENT position — paging as a
  // pipeline step BEFORE the RETURN, which sorts/slices the binding table rather
  // than the projected rows. `n.n` is the final sort key so the order is total.
  if (p < 0.78) {
    const dir = pick(r, ['', ' DESC']);
    const page = pick(r, ['', ' OFFSET 1', ' LIMIT 2', ' OFFSET 1 LIMIT 1', ' LIMIT 0']);

    return `MATCH (n:T) ORDER BY ${genExpr(r, 2)}${dir}, n.n${page} RETURN ${genExpr(r, 2)} AS x, n.n AS t`;
  }

  // ISO element-pattern predicate `(n WHERE <pred>)` — the inline WHERE inside a
  // node pattern, equivalent to a trailing WHERE. Native supports it on a PLAIN
  // MATCH node but historically rejected it in several other positions (a continuing
  // MATCH's start, a shortest-path node, a CALL-subquery start, an OPTIONAL MATCH
  // landing node) while the TS engine accepts it — a byte-identity divergence the
  // fuzzer never generated. The filtered node is always `n`, so `genExpr` (which reads
  // `n.*`) builds a predicate over it; a non-boolean predicate is rejected by BOTH
  // engines (the static boolean-context check — or lands in the accepted
  // E_INVALID_VALUE-vs-empty residual), a boolean one must agree to the bit.
  if (p < 0.84) {
    const pred = genExpr(r, 2);

    return pick(r, [
      // A continuing MATCH's start variable (re-referencing the bound `n`).
      `MATCH (n:T) MATCH (n WHERE ${pred})-[:E]->(b:T) RETURN b.n AS x, n.n AS t ORDER BY t, x`,
      // A shortest-path source node.
      `MATCH p = ANY SHORTEST (n:T WHERE ${pred})-[:E]->*(b:T) RETURN path_length(p) AS x, n.n AS t ORDER BY t, x`,
      // A shortest-path endpoint node (`n` is the endpoint here).
      `MATCH p = ANY SHORTEST (a:T)-[:E]->*(n:T WHERE ${pred}) RETURN path_length(p) AS x, n.n AS t ORDER BY t, x`,
      // A CALL-subquery start node (the scoped variable).
      `MATCH (n:T) CALL (n) { MATCH (n WHERE ${pred})-[:E]->(m) RETURN m.n AS mn } RETURN mn AS x ORDER BY x`,
      // An OPTIONAL MATCH LANDING node — the predicate null-fills a source whose
      // neighbours all fail it (rather than dropping the source): an OptionalExpand
      // landing predicate, not a plain filter.
      `MATCH (t:T) OPTIONAL MATCH (t)-[:E]->(n WHERE ${pred}) RETURN t.n AS x, n.n AS y ORDER BY x, y`,
    ]);
  }

  // `IS TYPED <type>` predicate — the closed-RECORD schema form over the stored map `m`
  // (`{k, j}`), plus scalar type tests. All are deterministic per row; `n.n` totalises.
  if (p < 0.87) {
    const ty = pick(r, [
      'RECORD { k :: INT }',
      'RECORD { k :: INT, j :: STRING }',
      'RECORD { k :: STRING }', // a wrong field type ⇒ false
      'INT',
      'RECORD NOT NULL',
    ]);
    const val = pick(r, ['n.m', 'n.n', 'n.s']);

    return `MATCH (n:T) RETURN ${val} IS TYPED ${ty} AS x, n.n AS t ORDER BY t`;
  }

  // A NAMED path variable bound over a quantified subpath group — `path_length`/`nodes`
  // read the path the group walked.
  if (p < 0.88) {
    const q = pick(r, ['{1,2}', '{1,3}', '{2,2}', '+']);
    const acc = pick(r, ['path_length(pp)', 'size(nodes(pp))', 'size(relationships(pp))']);

    return `MATCH pp = (a:T)((x)-[:E]->(m))${q}(b:T) RETURN ${acc} AS x, b.n AS t ORDER BY t, x`;
  }

  // A quantified subpath group whose two hops DISAGREE on direction and/or edge type
  // (`((x)-[d1:t1]->(m)-[d2:t2]->(y)){n,m}`). Native used to reject any non-uniform unit;
  // it now routes to the per-hop nested-group machinery, byte-identical to TS. `count(*)`
  // and the endpoint keep the comparison order-free / totalised.
  if (p < 0.93) {
    const h1 = pick(r, ['-[:E]->', '<-[:E]-', '-[:F]->', '<-[:F]-']);
    const h2 = pick(r, ['-[:E]->', '<-[:E]-', '-[:F]->', '<-[:F]-']);
    const q = pick(r, ['{1,2}', '{1,1}', '{1,3}', '+']);
    const body = `(a:T)((x)${h1}(m)${h2}(y))${q}(b:T)`;

    return pick(r, [
      `MATCH ${body} RETURN count(*) AS x`,
      `MATCH ${body} RETURN b.n AS x, a.n AS t ORDER BY t, x`,
    ]);
  }

  return `MATCH (n:T) RETURN ${genExpr(r, 3)} AS x, n.n AS t ORDER BY t`;
};

const codeOf = (e: unknown): string =>
  (e as { code?: string })?.code ?? (e instanceof Error ? e.name : 'unknown');

type Outcome = { ok: true; json: string } | { ok: false; code: string };

suite('differential fuzz: TS gql engine vs Rust engine', () => {
  const backend = nativeBackend();
  const nativeGraph = graphFromNdjson(backend, NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  const run = (engine: 'ts' | 'native', q: string): Outcome => {
    try {
      const rows = engine === 'ts' ? tsQuery(tsGraph, q) : nativeGraph.query(q);

      return { ok: true, json: JSON.stringify(rows) };
    } catch (e) {
      return { ok: false, code: codeOf(e) };
    }
  };

  // Seed: random each run, so every run explores fresh expressions — fuzzing is
  // discovery, not a fixed corpus (the specific bugs found here are pinned as their
  // own deterministic unit tests, which are the permanent regression guards). Set
  // FUZZ_SEED=<n> to replay a run exactly; the seed is printed on failure so any
  // divergence is reproducible. Property-based-testing convention: random by
  // default, seed on failure (proptest, QuickCheck, fast-check all do this).
  const SEED =
    process.env.FUZZ_SEED !== undefined
      ? Number(process.env.FUZZ_SEED) >>> 0
      : Math.floor(Math.random() * 0x1_0000_0000);
  const ITERATIONS = 20_000;

  test(`${ITERATIONS} random queries render byte-identically across engines`, () => {
    const divergences: string[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      const q = genQuery(mulberry32(caseSeed(SEED, i)));
      const ts = run('ts', q);
      const nat = run('native', q);

      // Both errored → acceptable (both reject the input); a shape divergence is
      // when exactly one succeeds, or both succeed with different JSON.
      if (ts.ok && nat.ok) {
        if (!resultsEqual(ts.json, nat.json)) {
          divergences.push(
            `[seed ${caseSeed(SEED, i)}] ${q}\n    ts:     ${ts.json}\n    native: ${nat.json}`,
          );
        }
      } else if (ts.ok !== nat.ok) {
        // ACCEPTED DIVERGENCE — the schemaless dynamic-operand residual.
        //
        // Both engines run the SAME static (plan-time) boolean-context type check
        // (Postgres-style): a value whose type is statically known to be non-boolean —
        // a literal, arithmetic, a map/list constructor, a non-boolean CAST — is rejected
        // wherever a truth value is required, before execution. That closes the whole
        // family EXCEPT one irreducible case: a DYNAMICALLY-typed operand in a boolean
        // context — a bare property (`n.s`), `NOT n.s`, or a function result whose type we
        // do not classify (`duration('P1D')`) — AND'd with a comparison that a selective
        // seek/filter narrows to zero rows. There the row-dependent `as_truth` reject fires
        // on one engine (which evaluates the operand) but not the other (whose seek
        // eliminated every row first). The engine is schemaless, so this operand's type is
        // unknowable at parse; a perf-neutral fix is impossible without abandoning the seek.
        //
        // It is ALWAYS `E_INVALID_VALUE` on one side vs an EMPTY result on the other —
        // "malformed predicate" vs "no rows", never wrong data — so it is accepted here.
        // Any OTHER one-sided outcome (a non-empty result, or a different error code) is a
        // real divergence and still reported.
        const errsInvalidValue = (o: Outcome): boolean => !o.ok && o.code === 'E_INVALID_VALUE';
        const isEmpty = (o: Outcome): boolean => o.ok && o.json === '[]';
        const acceptedBoolResidual =
          (errsInvalidValue(ts) && isEmpty(nat)) || (errsInvalidValue(nat) && isEmpty(ts));

        if (!acceptedBoolResidual) {
          const tsSide = ts.ok ? `ok ${ts.json}` : `err ${(ts as { code: string }).code}`;
          const natSide = nat.ok ? `ok ${nat.json}` : `err ${(nat as { code: string }).code}`;
          divergences.push(
            `[seed ${caseSeed(SEED, i)}] ${q}\n    ts:     ${tsSide}\n    native: ${natSide}`,
          );
        }
      }

      // Cap the report (raise via FUZZ_MAX_DIV to enumerate the whole landscape
      // during triage — e.g. FUZZ_MAX_DIV=300 for a full divergence survey).
      if (divergences.length >= Number(process.env.FUZZ_MAX_DIV ?? 10)) {
        break;
      }
    }

    const report = divergences.length
      ? `FUZZ_SEED=${SEED} bun test <this file> to reproduce:\n\n${divergences.join('\n\n')}`
      : 'no divergences';
    expect(report).toBe('no divergences');
    // 20 000 queries × two engines is well under a second locally but exceeds Bun's default
    // 5 s test timeout on the slower CI runners (~5.5–6 s) — give this heavy differential fuzz
    // a generous ceiling so it is not a wall-clock flake rather than trimming its coverage.
  }, 30_000);
});
