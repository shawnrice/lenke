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
import { accept, resetUsage, usageCounts } from './divergence-registry.js';
import { graphFromNdjson } from './graph.js';

/// Coverage tallies for the shapes this fuzzer is supposed to keep generating. Kept out of the
/// fuzz loop itself so that loop stays under the complexity gate; the floors it feeds are asserted
/// at the end of the run.
const tally = (
  cov: Record<string, number>,
  q: string,
  ts: { ok: boolean; json?: string },
): void => {
  const nonEmpty = ts.ok && ts.json !== '[]' && ts.json !== '[{"x":0}]';

  // `((x)` identifies a quantified subpath group (only two arms emit it, and only this one adds
  // a `WHERE`). Matching a bare `) WHERE` instead over-counts by a factor of four, since an
  // ordinary `MATCH (n:T) WHERE …` looks the same.
  if (q.includes(' WHERE ') || q.includes(' FILTER ')) {
    cov.predGenerated++;

    if (ts.ok && ts.json !== '[]') {
      cov.predRows++;
    }
  }

  // The CROSS-SLOT property comparison arm, the only coverage for the typed prop-vs-prop masks.
  // Non-empty matters as much as generated: a comparison that matches nothing compares nothing.
  if (q.startsWith('MATCH (a:T)-[:E]->(b:T)')) {
    cov.crossGenerated++;

    if (nonEmpty) {
      cov.crossNonEmpty++;
    }
  }

  // `count(<property>)`. NON-ZERO is the floor that matters: a count whose answer is 0 cannot
  // tell a present cell from an absent one, and a third of the drawn keys (`zz`, and `st`/`nan`
  // on the vertices that lack them) count nothing by construction.
  if (/RETURN count\(((DISTINCT )?[abn]\.)/.test(q)) {
    cov.cntPropGenerated++;

    // `nonEmpty` already excludes `[{"x":0}]`, which IS a zero count under this alias.
    if (nonEmpty) {
      cov.cntPropNonZero++;
    }
  }

  if (q.startsWith('MATCH (a:T)((x)') && q.includes('(b:U)') && q.includes('RETURN count(*)')) {
    cov.peelGenerated++;

    if (nonEmpty) {
      cov.peelNonZero++;
    }
  }

  if (q.startsWith('MATCH ((x)') && q.includes('RETURN count(*)')) {
    cov.sinkGenerated++;

    if (nonEmpty) {
      cov.sinkNonZero++;
    }
  }

  if (q.includes('((x)') && q.includes(' WHERE ')) {
    cov.perRepGenerated++;

    if (nonEmpty) {
      cov.perRepNonEmpty++;
    }
  }

  // TRAILING SKIP/LIMIT over an ORDER BY. Counted because the count-shortcut family above was
  // widened at this band's expense (0.03 of the space to 0.015, the only band that paid), and a
  // band with no counter is a band whose coverage can be halved again by the next person without
  // anything noticing. `[{"x":0}]` is a legitimate answer here, so GENERATED is the floor that
  // means something; `LIMIT 0` emits nothing by design.
  if (/ SKIP \d+ LIMIT \d+$/.test(q)) {
    cov.pageGenerated++;

    if (ts.ok && ts.json !== '[]') {
      cov.pageRows++;
    }
  }

  // The FILTERED count-shortcut ladder: a one-hop `count(*)` carrying a `WHERE`. This whole
  // half of the ladder was generated ZERO times until TS audit item 114 — a count never
  // carried a predicate here — which is how a filtered count over an untyped `-[]->` answered
  // 0 for two commits with this fuzzer green. The non-zero floor is what matters: a filtered
  // count that matches nothing agrees with a broken one trivially.
  if (/^MATCH \([ab]?[^)]*\)[-<]/.test(q) && q.includes(' WHERE ') && q.includes('count(*)')) {
    cov.hopFilterGenerated++;

    if (nonEmpty) {
      cov.hopFilterNonZero++;
    }

    // An UNTYPED relationship specifically — the spelling that was wrong. `[]` and `[e]`
    // reach the shortcut with `types === undefined`, which no other arm produces.
    if (/-\[e?\]-/.test(q)) {
      cov.hopUntypedGenerated++;

      if (nonEmpty) {
        cov.hopUntypedNonZero++;
      }
    }
  }
};

const suite = nativeReady ? describe : describe.skip;

// A tiny two-vertex, one-edge graph so property access, record fields, edge
// patterns, and aggregates over rows can all be fuzzed.
const NDJSON = [
  '{"type":"node","id":"1","labels":["T"],"properties":{"n":3,"s":"a","x":-1,"st":"p","m":{"k":1,"j":"q"}}}',
  '{"type":"node","id":"2","labels":["T"],"properties":{"n":7,"s":"z","x":4,"m":{"k":2,"j":"r"}}}',
  // Vertex 3 carries TWO labels, so `(n:T)` and `(n:U)` must BOTH find it. With
  // every vertex single-labelled, "match any label" and "match the first label"
  // are indistinguishable, and a label bug hides — which is how native's Gremlin
  // `hasLabel` matched only the first label for a long time without any fuzzer
  // noticing.
  '{"type":"node","id":"3","labels":["T","U"],"properties":{"n":5,"s":"m","x":2,"st":"w","m":{"k":3,"j":"s"}}}',
  '{"type":"edge","id":"e1","labels":["E"],"from":"1","to":"2","properties":{"w":2}}',
  // ...and edge e2 carries TWO types, for the same reason on the edge side. The
  // label indexes bucket an edge under every type it carries, so anything that
  // sums or concatenates buckets — a `[:E|F]` count shortcut, a per-name
  // adjacency walk — sees this edge twice while native sees it once. With every
  // edge single-typed the two are indistinguishable, which is how the TS count
  // shortcut double-counted for a long time with every fuzzer green.
  '{"type":"edge","id":"e2","labels":["E","F"],"from":"2","to":"3","properties":{"w":5}}',
  // `st` is a SPARSE STRING, on vertices 1 and 3 only. `nan` plays that role for numbers, and
  // without a string twin the "absent on EITHER side is UNKNOWN" rule of the typed prop-vs-prop
  // string comparison had no coverage at all: a mutant returning FALSE instead of UNKNOWN for an
  // absent right-hand side passed the whole suite, because every other string property here is
  // present on every vertex.
  // A SECOND in-edge into vertex 3. Without it no vertex has two distinct in-edges, and in
  // Trail mode a unit whose second hop is REVERSED (`(x)-[:E]->(m)<-[:E]-(y)`) then has
  // nowhere to go — it matched 0 rows for every quantifier. Measured: 4 of the 16
  // direction-pair combinations below matched anything before this edge, 8 after, and the
  // forward-then-reverse pair specifically went from 0 rows to 2. Coverage of those shapes
  // was therefore vacuous, which is how a per-rep filter over one stayed broken (item 51).
  '{"type":"edge","id":"e3","labels":["E"],"from":"1","to":"3","properties":{"w":9}}',
  // STORED STRING VALUES that differ from the ASCII ones above in the ways string handling can
  // go wrong. `genString` already emits a '😀' LITERAL, so surrogate pairs were covered on one
  // side of a comparison and never on the other: no stored value had one. Vertex 4's `s` is a
  // surrogate pair (2 UTF-16 units, 4 bytes — the one class where a UTF-16 length differs from a
  // byte length, which `size()` and `substring()` both depend on), vertex 5's is EMPTY, and
  // vertex 6's is long enough to cross any short-string threshold. Edges keep them reachable
  // from a traversal rather than only from a scan.
  '{"type":"node","id":"4","labels":["T"],"properties":{"n":11,"s":"😀","x":0,"m":{"k":4,"j":"t"}}}',
  '{"type":"node","id":"5","labels":["T"],"properties":{"n":13,"s":"","x":3,"m":{"k":5,"j":"u"}}}',
  '{"type":"node","id":"6","labels":["T"],"properties":{"n":17,"s":"qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq","x":5,"m":{"k":6,"j":"v"}}}',
  '{"type":"edge","id":"e4","labels":["E"],"from":"3","to":"4","properties":{"w":1}}',
  '{"type":"edge","id":"e5","labels":["F"],"from":"4","to":"5","properties":{"w":3}}',
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
  // `nan` is present on two of the vertices and ABSENT on the rest, so a predicate over it is
  // three-valued as well as NaN-valued.
  return `n.${pick(r, ['n', 's', 'x', 'n', 's', 'x', 'nan'])}`;
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
/// A BOOLEAN-typed expression, for a PREDICATE position.
///
/// `genExpr` is type-agnostic, so in a `WHERE` / `FILTER` / inline-`(n WHERE …)` position it
/// mostly produces something non-boolean, which both engines reject at parse (the static
/// boolean-context check). Measured per generator arm: those three arms errored about 75% of the
/// time and returned actual ROWS only 2-7% of the time, so they were comparing error codes far
/// more than they were comparing predicate evaluation over data. A comparison here can still
/// error — a cross-type `<=` is a data exception by policy — so the error path stays covered,
/// and the callers keep a share of raw `genExpr` deliberately so the boolean-context rejection
/// itself does not lose coverage.
const genPred = (r: () => number, depth: number): string => {
  const p = r();

  // A ROW-DEPENDENT, TYPE-CONSISTENT comparison. Both halves matter. Row-dependent, because
  // a predicate over constants is all-or-nothing and tells the oracle almost nothing about
  // predicate evaluation; type-consistent, because a cross-type comparison is a data exception
  // by policy, so mixing types spends the sample on the error path instead.
  if (depth <= 0 || p < 0.5) {
    const op = pick(r, CMP);

    return pick(r, [
      `(n.n ${op} ${pick(r, ['3', '5', '7', '0', '4.5', '-1'])})`,
      `(n.x ${op} ${pick(r, ['-1', '2', '4', '0'])})`,
      `(n.n ${op} n.x)`,
      `(n.s ${op} ${pick(r, ["'a'", "'m'", "'z'", "'q'"])})`,
      `(n.m.k ${op} ${pick(r, ['1', '2', '3'])})`,
      // `nan` is the stored-NaN property, present on two vertices and absent on the rest. It
      // belongs in THIS list and not only in `genLeaf`: the bug this exists for needs a bare
      // `NOT (<prop> <ordering op> <literal>)` as the filter predicate, which is the shape the
      // arm above produces and `genExpr` almost never does. Adding the VALUE without adding it
      // where the SHAPE is built left the suite green — the value and the shape never met.
      `(n.nan ${op} ${pick(r, ['3', '0', '-1'])})`,
      // PROPERTY against PROPERTY, which `typed_num_prop_mask` / `typed_str_prop_mask` serve
      // without boxing either side. `n.n ${op} n.x` above already covers the dense numeric case;
      // these cover what it does not. `nan` is present on only two of the vertices, so it is the
      // shape that exercises the "absent on EITHER side is UNKNOWN" rule the typed path must
      // reproduce, and `n.s ${op} n.s` is what routes a STRING comparison through it at all.
      `(n.nan ${op} n.n)`,
      `(n.s ${op} n.s)`,
      `(n.st ${op} n.s)`,
      // A key NO vertex carries. The typed masks answer it as every row UNKNOWN without touching
      // a column, which is a SEMANTIC claim — and every key above exists, so nothing here tested
      // it. A mutant answering FALSE instead of UNKNOWN passed the whole suite (item 74).
      `(n.zz ${op} ${pick(r, ['3', "'a'"])})`,
      `(n.zz ${op} n.n)`,
    ]);
  }

  if (p < 0.62) {
    return `(${genExpr(r, 1)} ${pick(r, CMP)} ${genExpr(r, 1)})`;
  }

  if (p < 0.7) {
    return `(${genExpr(r, 1)} ${pick(r, IS_TESTS)})`;
  }

  if (p < 0.78) {
    return `NOT ${genPred(r, depth - 1)}`;
  }

  if (p < 0.9) {
    return `(${genPred(r, depth - 1)} AND ${genPred(r, depth - 1)})`;
  }

  return `(${genPred(r, depth - 1)} OR ${genPred(r, depth - 1)})`;
};

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
    const pred = r() < 0.75 ? genPred(r, 2) : genExpr(r, 2);

    return `MATCH (n:T) WHERE ${pred} RETURN n.n AS x ORDER BY x`;
  }

  if (p < 0.54) {
    return `MATCH (n:T) LET v = ${genExpr(r, 2)} RETURN v AS x, n.n AS t ORDER BY t`;
  }

  if (p < 0.6) {
    return `FOR v IN ${genExpr(r, 2)} RETURN v AS x`;
  }

  if (p < 0.64) {
    const pred = r() < 0.75 ? genPred(r, 2) : genExpr(r, 2);

    return `MATCH (n:T) FILTER ${pred} RETURN n.n AS x ORDER BY x`;
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

  if (p < 0.705) {
    // A type disjunction over a graph holding a two-type edge: `E`, `F` and
    // `E|F` all select edge e2, and it is ONE edge in every spelling. Routed
    // through both the count shortcuts and plain enumeration.
    const t = pick(r, ['E', 'F', 'E|F', 'F|E', 'E|ABSENT']);

    // The count-shortcut ladder, spelled out. Every relationship this family drew
    // used to be TYPED, no count ever carried a `WHERE`, and the direction was
    // always `->` — so the whole FILTERED half of the ladder (the per-edge tally
    // and the per-vertex start-only path) was generated zero times, and an
    // UNTYPED relationship never at all. That is how `MATCH (a:T)-[]->(b) WHERE
    // <anything> RETURN count(*)` answered 0 for two commits with this fuzzer
    // green (TS audit item 114).
    //
    // The pieces are drawn independently so the cross-product is reached: the
    // shortcut is chosen on the relationship spelling, the endpoint labels AND
    // which slots the predicate reads, and a bug needs a particular combination
    // (a far-endpoint label with a start-only predicate, say).
    const rel = pick(r, [`[:${t}]`, `[e:${t}]`, '[]', '[e]']);
    const dir = pick(r, ['out', 'in']);
    const left = pick(r, ['(a:T)', '(a:U)', '(a)']);
    const right = pick(r, ['(b:T)', '(b:U)', '(b)']);
    const hop = dir === 'out' ? `${left}-${rel}->${right}` : `${left}<-${rel}-${right}`;
    // Predicates over the start slot, the far slot, the edge, and both ends at
    // once. `a.zz` is a key no vertex carries, so the comparison is NULL and the
    // row drops — the three-valued arm. The edge predicates only apply when the
    // relationship was spelled with a variable.
    const preds = rel.includes('e')
      ? ['a.n > 3', 'b.n > 3', 'e.w > 3', 'a.n > 3 AND b.n < 9', 'a.zz > 1', 'e.w >= 0']
      : ['a.n > 3', 'b.n > 3', 'a.n > 3 AND b.n < 9', 'a.zz > 1', 'a.n >= 0', 'b.n = 7'];
    const shape = pick(r, [
      `MATCH ()-[:${t}]->() RETURN count(*) AS x`,
      `MATCH (a:T)-[:${t}]->(b:T) RETURN count(*) AS x`,
      `MATCH (a)-[:${t}]->(b)-[:${t}]->(c) RETURN count(*) AS x`,
      `MATCH (a)-[e:${t}]->(b) RETURN e.w AS x ORDER BY x`,
      `MATCH ${hop} RETURN count(*) AS x`,
      `MATCH ${hop} WHERE ${pick(r, preds)} RETURN count(*) AS x`,
      // The same question with the paging the shortcut must NOT answer past, and
      // a grouped count — the other two rungs of the ladder.
      `MATCH ${hop} WHERE ${pick(r, preds)} RETURN count(*) AS x LIMIT 1`,
      `MATCH ${hop} WHERE ${pick(r, preds)} RETURN count(*) AS x ORDER BY x`,
      // TARGETED, because the random cross-product reaches these too rarely to rely on —
      // both were mutants that survived this family once it existed (TS audit item 115).
      //
      // A NON-VACUOUS far label (`U` is on vertex 3 only; `T` is on every vertex, so the
      // engine elides it) paired with a predicate reading ONLY the start slot. That is the
      // one combination where a per-vertex shortcut can add a whole degree without ever
      // looking at the far endpoint. `>= 0` holds for every vertex, which is what makes the
      // over-count visible: with a selective predicate the right and wrong answers coincide
      // on this fixture.
      `MATCH (a:T)-[:${t}]->(b:U) WHERE ${pick(r, ['a.n >= 0', 'a.n > 3', 'a.x < 9'])} RETURN count(*) AS x`,
      `MATCH (a:T)<-[:${t}]-(b:U) WHERE ${pick(r, ['a.n >= 0', 'a.n > 3'])} RETURN count(*) AS x`,
      // A start vertex with DEGREE > 1 on the queried type (vertex 1 has two `E` out-edges)
      // and an unconstrained far end. This is what distinguishes adding a vertex's degree
      // from adding one per matching vertex — with every degree 1 the two are identical.
      `MATCH (a:T)-[:${t}]->(b) WHERE ${pick(r, ['a.n >= 0', 'a.n > 3'])} RETURN count(*) AS x`,
      // A NON-VACUOUS start label. `U` is on vertex 3 alone, so the per-vertex walk has to
      // apply the label itself rather than inherit it from a seed; `T` is on every vertex
      // and is elided, which makes it useless for this. Both directions, because vertex 3
      // has in-edges and no out-edges — so one direction counts and the other is 0.
      `MATCH (a:U)-[:${t}]->(b) WHERE a.n >= 0 RETURN count(*) AS x`,
      `MATCH (a:U)<-[:${t}]-(b) WHERE a.n >= 0 RETURN count(*) AS x`,
      // UNTYPED and filtered, unconditionally rather than via the `rel` draw. This is the
      // spelling that was WRONG (item 114), so its density is pinned by its own shapes and a
      // coverage floor instead of being left to a 1-in-4 pick that later shapes dilute.
      // Note the fixture's two-type edge makes `multiTypeEdgeCount > 0`, so these route to
      // the per-edge tally — which is exactly the path that answered 0.
      `MATCH (a:T)-[]->(b) WHERE ${pick(r, ['a.n >= 0', 'a.n > 3', 'b.n > 3'])} RETURN count(*) AS x`,
      `MATCH (a:T)<-[]-(b) WHERE ${pick(r, ['a.n >= 0', 'b.n = 7'])} RETURN count(*) AS x`,
      `MATCH (a)-[e]->(b) WHERE e.w >= 0 RETURN count(*) AS x`,
      // DELIBERATELY NOT GENERATED: a non-boolean predicate over an edge type carrying no
      // edges (`MATCH (a:T)-[:ABSENT]->(b) WHERE a.n RETURN count(*)`). It is the only shape
      // that could catch a shortcut evaluating a predicate for an element the general path
      // never visits — and it also hits an UNSETTLED divergence: native raises
      // `E_INVALID_VALUE` while TS answers 0, even though both agree when the empty match
      // comes from an absent node LABEL instead. Generating it would make this suite red on
      // a question about engine semantics rather than about any change. Written up with the
      // repro table in TS audit item 115; the mutant it would catch is covered by
      // `count-shortcut.test.ts` instead.
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
    const pred = r() < 0.75 ? genPred(r, 2) : genExpr(r, 2);

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
    // The RENDERED elements, not only their count. `size(nodes(pp))` reads a LENGTH, so a bug in
    // how a path element is turned into its element map is invisible to it — and invisible to
    // rewrite_fuzz too, which compares raw against optimized through the same renderer. Verified:
    // making `path_node_values` drop its first element survives rewrite_fuzz entirely. Projecting
    // the elements themselves is the only oracle that reads them, since the TS engine renders
    // independently. Element-map key order is deterministic on both sides (labels sorted,
    // properties in already-sorted `prop_keys()` order), so this cannot report a false
    // difference from map ordering.
    // `edges(pp)`, NOT `relationships(pp)`: the accessor is spelled `edges` in this dialect
    // (`gql.rs` maps "edges" to `PathPart::Relationships`), and `relationships()` is an unknown
    // FUNCTION. Both engines rejected it identically, so the pre-existing
    // `size(relationships(pp))` entry and the `relationships(pp)` one added in item 58 were both
    // VACUOUS — an arm that looks like coverage, errors on both sides, and compares nothing.
    const acc = pick(r, [
      'path_length(pp)',
      'size(nodes(pp))',
      'size(edges(pp))',
      'nodes(pp)',
      'edges(pp)',
      'elements(pp)',
    ]);

    return `MATCH pp = (a:T)((x)-[:E]->(m))${q}(b:T) RETURN ${acc} AS x, b.n AS t ORDER BY t, x`;
  }

  // A quantified subpath group whose two hops DISAGREE on direction and/or edge type
  // (`((x)-[d1:t1]->(m)-[d2:t2]->(y)){n,m}`). Native used to reject any non-uniform unit;
  // it now routes to the per-hop nested-group machinery, byte-identical to TS. `count(*)`
  // and the endpoint keep the comparison order-free / totalised.
  if (p < 0.93) {
    const h1 = pick(r, ['-[e1:E]->', '<-[e1:E]-', '-[e1:F]->', '<-[e1:F]-']);
    const h2 = pick(r, ['-[:E]->', '<-[:E]-', '-[:F]->', '<-[:F]-']);
    const q = pick(r, ['{1,2}', '{1,1}', '{1,3}', '+']);
    // A PER-REPETITION `WHERE`, after the unit and INSIDE the parens (inside the edge
    // brackets is a per-HOP predicate, a different thing). Reads a NODE property and an
    // EDGE property, because those land in different columns of the per-rep mini-batch and
    // exactly that distinction was broken: native built the mini-batch boxed where the
    // single-direction path builds it typed, so any predicate touching a node read NULL and
    // pruned every repetition — a silent wrong answer against TS, on a shape this generator
    // already produced but never filtered (item 51).
    const perRep = pick(r, [
      '',
      '',
      ' WHERE x.n >= 0',
      ' WHERE x.n <> 999',
      ' WHERE e1.w >= 0',
      ' WHERE e1.w > 2',
      ' WHERE m.n <> x.n',
      ' WHERE x.n + e1.w > 4',
    ]);
    // The endpoint pattern varies, and `U` is the load-bearing one: every vertex in this fixture
    // carries `T`, so `(b:T)` is a filter that excludes nothing — native dropping the endpoint
    // predicate entirely was invisible under it. Only vertex 3 carries `U` (item 63).
    const end = pick(r, ['(b:T)', '(b:U)', '(b:U)', '(b)']);
    const body = `(a:T)((x)${h1}(m)${h2}(y)${perRep})${q}${end}`;

    // UNANCHORED, kept at its own frequency: a label on either endpoint used to put the count
    // back on the materializing path, so native's counting sink was reached only by this
    // spelling, and until it existed no cross-engine comparison ran through the sink at all
    // (item 61). The sink now applies an endpoint filter itself, so the ANCHORED forms reach it
    // too — by a different route, which is why both spellings stay.
    const unanchored = `MATCH ((x)${h1}(m)${h2}(y)${perRep})${q} RETURN count(*) AS x`;
    // With no endpoint pattern there is no `b` to project.
    const forms =
      end === '(b)'
        ? [`MATCH ${body} RETURN count(*) AS x`, unanchored]
        : [
            `MATCH ${body} RETURN count(*) AS x`,
            `MATCH ${body} RETURN b.n AS x, a.n AS t ORDER BY t, x`,
            unanchored,
          ];

    return pick(r, forms);
  }

  // CROSS-SLOT property comparison over a hop — `WHERE a.k <op> b.k` across two bound
  // variables, which is the shape the typed prop-vs-prop masks are for and which nothing here
  // produced. Every `genPred` arm reads ONE variable, so a same-slot comparison was the most it
  // could reach, while the masks resolve each side's slot independently — a wrong slot is a wrong
  // answer. `nan` is in the key list because it is present on only two vertices, which drives the
  // absent-on-either-side rule. Placed last, above the fallback, so it takes no other arm's band.
  if (p < 0.96) {
    const op = pick(r, CMP);
    const k = pick(r, ['n', 'x', 's', 'nan', 'st', 'zz']);
    const k2 = pick(r, ['n', 'x', 's', 'nan', 'st', 'zz']);

    return pick(r, [
      `MATCH (a:T)-[:E]->(b:T) WHERE (a.${k} ${op} b.${k}) RETURN a.n AS x, b.n AS t ORDER BY t, x`,
      `MATCH (a:T)-[:E]->(b:T) WHERE (a.${k} ${op} b.${k2}) RETURN b.n AS x, a.n AS t ORDER BY t, x`,
      `MATCH (a:T)-[:E]->(b:T) RETURN (a.${k} ${op} b.${k2}) AS x, a.n AS t, b.n AS u ORDER BY t, u, x`,
    ]);
  }

  // `count(<property>)` — which NO fuzzer generated, in either engine: this one only ever
  // emitted `count(*)`, and `rewrite_fuzz` builds `Count` with `arg: None` while its
  // property-argument aggregates are Sum/Min/Max/Avg. So the whole "count the non-null values
  // of a key" question was uncovered, and it has its own fast path.
  //
  // The key list is the point rather than the shape. `n`/`s` are on every vertex, `st` and
  // `nan` on two of three, and `zz` on none — so the three outcomes a count must distinguish
  // (a value, an absent cell, a key with no column at all) are all drawn. A `LET`-bound
  // grouped form comes too, because the grouped fold is a different code path from the scalar
  // one and only the scalar one has a shortcut.
  //
  // Placed last, above the fallback, so it takes no other arm's band.
  if (p < 0.985) {
    const k = pick(r, ['n', 'x', 's', 'nan', 'st', 'zz', 'm.k']);

    return pick(r, [
      `MATCH (n:T) RETURN count(n.${k}) AS x`,
      `MATCH (n:T) RETURN count(DISTINCT n.${k}) AS x`,
      `MATCH (n:T) WHERE n.n > 3 RETURN count(n.${k}) AS x`,
      `MATCH (n:T) LET g = n.s RETURN g, count(n.${k}) AS x GROUP BY g ORDER BY g, x`,
      `MATCH (a:T)-[:E]->(b:T) RETURN count(b.${k}) AS x`,
    ]);
  }

  return `MATCH (n:T) RETURN ${genExpr(r, 3)} AS x, n.n AS t ORDER BY t`;
};

const codeOf = (e: unknown): string =>
  (e as { code?: string })?.code ?? (e instanceof Error ? e.name : 'unknown');

type Outcome = { ok: true; json: string } | { ok: false; code: string };

/// ACCEPTED DIVERGENCE — the float-to-text tie.
///
/// `CAST(x AS STRING)` (and `||`, and `to_string`) routes through `json_fmt::js_number`, which
/// places the decimal point exactly per ECMA-262 but takes its DIGITS from Rust's `{:e}`. When an
/// f64's exact value sits exactly halfway between two equally SHORT decimals, both round-trip and
/// the two runtimes break the tie differently: ECMA-262 says "if there are two such possible
/// values of s, choose the one that is even", while Rust rounds up. The first case found was
/// `CAST((9007199254740992 * 0.1) AS STRING)`, whose exact value is …099.25 — TS renders
/// …099.2, native …099.3, from the IDENTICAL bits (`430999999999999a`).
///
/// Why it is accepted rather than fixed: telling a true tie from "very close to the midpoint"
/// needs exact decimal arithmetic on the f64's dyadic value, which f64 cannot do and which the
/// zero-dependency rule rules out importing. Guessing wrong would change output that is currently
/// correct, which is worse than a rendering difference.
///
/// The acceptance is deliberately narrow: a difference is excused ONLY where every differing
/// piece is a numeric STRING and both spellings parse to the same f64 — the two texts denote one
/// number. Any other difference, including a numeric string that denotes a DIFFERENT number, is
/// still reported. `float_text_tie.test.ts` pins the known case so a change in either engine's
/// formatting is noticed rather than silently absorbed here.
const renumber = (v: unknown): unknown => {
  if (typeof v === 'string' && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v)) {
    const n = Number(v);

    return Number.isFinite(n) ? `#${String(n)}` : v;
  }

  if (Array.isArray(v)) {
    return v.map(renumber);
  }

  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};

    for (const k of Object.keys(v).sort()) {
      out[k] = renumber((v as Record<string, unknown>)[k]);
    }

    return out;
  }

  return v;
};

const numericTextTie = (a: string, b: string): boolean => {
  try {
    return JSON.stringify(renumber(JSON.parse(a))) === JSON.stringify(renumber(JSON.parse(b)));
  } catch {
    return false;
  }
};

suite('differential fuzz: TS gql engine vs Rust engine', () => {
  const backend = nativeBackend();
  const nativeGraph = graphFromNdjson(backend, NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  // A STORED NaN, which the NDJSON fixture cannot express: ingest coerces NaN and the
  // infinities to null, so the only way to get one into a property is to COMPUTE it with
  // `SET`. That asymmetry is itself worth knowing — it is why a stored NaN looked impossible
  // and is not.
  //
  // Without this, the whole NaN family was invisible to this fuzzer: item 53's bug (the
  // planner negating an ordering comparison) was caught only because the query could produce a
  // NaN from a literal call, and item 55's (the executor's copy of the same mistake, reached
  // only when the NaN arrives from a PROPERTY) could not be caught here at all — reverting that
  // fix left this suite green.
  for (const q of [
    'MATCH (n:T) WHERE n.n = 3 SET n.nan = sin(1e400) RETURN count(*) AS c',
    'MATCH (n:T) WHERE n.n = 7 SET n.nan = ln(-1) RETURN count(*) AS c',
  ]) {
    tsQuery(tsGraph, q);
    nativeGraph.query(q);
  }

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
    // Coverage counters for the per-repetition `WHERE` over a quantified group. Both are
    // needed: the first says the shape is GENERATED, the second that it MATCHES SOMETHING.
    // Generation alone is not coverage — before the fixture gained a second in-edge into
    // vertex 3, the forward-then-reverse unit was generated and returned 0 rows every time,
    // so a wrong answer over it agreed with a wrong answer trivially (item 51).
    const cov = {
      perRepGenerated: 0,
      perRepNonEmpty: 0,
      predGenerated: 0,
      predRows: 0,
      sinkGenerated: 0,
      sinkNonZero: 0,
      peelGenerated: 0,
      peelNonZero: 0,
      crossGenerated: 0,
      crossNonEmpty: 0,
      cntPropGenerated: 0,
      cntPropNonZero: 0,
      hopFilterGenerated: 0,
      hopFilterNonZero: 0,
      hopUntypedGenerated: 0,
      hopUntypedNonZero: 0,
      pageGenerated: 0,
      pageRows: 0,
    };
    // The same GENERATION-IS-NOT-COVERAGE guard for PREDICATE arms. `genExpr` is
    // type-agnostic, so a `WHERE` / `FILTER` / inline-`(n WHERE …)` position used to be filled
    // with something non-boolean about 75% of the time and both engines rejected it at parse.
    // Measured per arm before `genPred` existed: 4-7% of those queries returned ROWS. After:
    // 46-49%. The floor keeps a future generator change from quietly returning them to
    // comparing error codes instead of predicate evaluation over data.
    // And the same guard for the UNANCHORED nested-group count — the only spelling that
    // reaches native's non-materializing counting sink. `startsWith` is what distinguishes it:
    // every other group query this generator emits opens with `MATCH (a:T)((x)` or
    // `MATCH pp = `, and those lower with a `Filter` above the group, which the sink declines.
    // And for the sink reached through an ENDPOINT FILTER it applies itself. The non-zero
    // counter is the load-bearing one here for a second reason: a filter that excludes nothing
    // cannot show that the predicate is applied at all, and `(b:T)` over this fixture is exactly
    // that — every vertex carries `T`. `(b:U)` is the selective one, and dropping the predicate
    // was invisible until the generator drew it (item 63).

    resetUsage();

    for (let i = 0; i < ITERATIONS; i++) {
      const q = genQuery(mulberry32(caseSeed(SEED, i)));
      const ts = run('ts', q);
      const nat = run('native', q);

      tally(cov, q, ts);

      // Both errored → acceptable (both reject the input); a shape divergence is
      // when exactly one succeeds, or both succeed with different JSON.
      if (ts.ok && nat.ok) {
        if (!resultsEqual(ts.json, nat.json) && !numericTextTie(ts.json, nat.json)) {
          // Routed through the registry like the one-sided case, so an `order` or
          // `float-reduction` entry would apply here if one is ever declared. With none, this
          // classifies and is reported exactly as before.
          const verdict = accept({ query: q, ts, native: nat });

          if (!verdict.accepted) {
            divergences.push(
              `[seed ${caseSeed(SEED, i)}] ${q}\n    ts:     ${ts.json}\n    native: ${nat.json}` +
                `\n    (${verdict.observed}: ${verdict.why})`,
            );
          }
        }
      } else if (ts.ok !== nat.ok) {
        // A DECLARED divergence, or a real one. `divergence-registry.ts` holds the list and
        // the rules — notably that a VALUE difference is refused whatever the list says, so
        // this cannot be used to turn a wrong answer green. The schemaless
        // boolean-context/dynamic-operand residual that used to be an `if` here with a long
        // comment is now an entry in that file, where it is narrow (an `E_INVALID_VALUE`
        // against an EMPTY result, never against rows) and its usage is counted.
        const verdict = accept({ query: q, ts, native: nat });

        if (!verdict.accepted) {
          const tsSide = ts.ok ? `ok ${ts.json}` : `err ${(ts as { code: string }).code}`;
          const natSide = nat.ok ? `ok ${nat.json}` : `err ${(nat as { code: string }).code}`;
          divergences.push(
            `[seed ${caseSeed(SEED, i)}] ${q}\n    ts:     ${tsSide}\n    native: ${natSide}` +
              `\n    (${verdict.observed}: ${verdict.why})`,
          );
        }
      }

      // Cap the report (raise via FUZZ_MAX_DIV to enumerate the whole landscape
      // during triage — e.g. FUZZ_MAX_DIV=300 for a full divergence survey).
      if (divergences.length >= Number(process.env.FUZZ_MAX_DIV ?? 10)) {
        break;
      }
    }

    // How often each DECLARED divergence was used. Visible on every run, because a declared
    // divergence whose frequency moves is worth noticing, and one that drops to zero has
    // outlived the behaviour it describes (see `unused` in the registry).
    const declared = [...usageCounts().entries()]
      .map(([id, n]) => `${id}=${n}`)
      .sort()
      .join(' ');
    console.log(`DECLARED ${declared === '' ? 'none used' : declared}`);

    const report = divergences.length
      ? `FUZZ_SEED=${SEED} bun test <this file> to reproduce:\n\n${divergences.join('\n\n')}`
      : 'no divergences';
    expect(report).toBe('no divergences');
    // FLOORS on the per-rep coverage, at roughly half what was measured when it was added
    // (measured 725-769 generated and 358-368 of those non-empty, of 20,000). They guard the same
    // thing rewrite_fuzz's density floors guard: a generator drifting away from a shape it is
    // supposed to cover, which is invisible from the outside because a suite that never
    // generates a shape passes exactly like one that does. The non-empty floor is the one
    // that matters most — generating a query that matches nothing compares nothing.
    console.log(
      `PRED generated=${cov.predGenerated} rows=${cov.predRows} ` +
        `perRep=${cov.perRepGenerated}/${cov.perRepNonEmpty} ` +
        `sink=${cov.sinkGenerated}/${cov.sinkNonZero} peel=${cov.peelGenerated}/${cov.peelNonZero} ` +
        `cross=${cov.crossGenerated}/${cov.crossNonEmpty} ` +
        `cntProp=${cov.cntPropGenerated}/${cov.cntPropNonZero} ` +
        `hopFilter=${cov.hopFilterGenerated}/${cov.hopFilterNonZero} ` +
        `hopUntyped=${cov.hopUntypedGenerated}/${cov.hopUntypedNonZero} ` +
        `page=${cov.pageGenerated}/${cov.pageRows}`,
    );
    expect({
      perRepGenerated: cov.perRepGenerated > 350,
      perRepNonEmpty: cov.perRepNonEmpty > 175,
      predGenerated: cov.predGenerated > 2_000,
      predRows: cov.predRows > 1_000,
      sinkGenerated: cov.sinkGenerated > 200,
      sinkNonZero: cov.sinkNonZero > 100,
      // Measured 150-186 generated and 30-44 of those non-zero, of 20,000.
      peelGenerated: cov.peelGenerated > 75,
      peelNonZero: cov.peelNonZero > 15,
      // Measured 560-620 generated and 300-360 of those non-empty, of 20,000.
      crossGenerated: cov.crossGenerated > 250,
      crossNonEmpty: cov.crossNonEmpty > 120,
      // Measured 410-433 generated and 359-376 of those non-zero, of 20,000.
      cntPropGenerated: cov.cntPropGenerated > 200,
      cntPropNonZero: cov.cntPropNonZero > 150,
      // Measured over five seeds, of 20,000: 521-576 generated, 381-440 of those non-zero.
      hopFilterGenerated: cov.hopFilterGenerated > 400,
      hopFilterNonZero: cov.hopFilterNonZero > 300,
      // The untyped spelling has its own shapes precisely so this floor can be meaningful:
      // when it rode on a 1-in-4 relationship draw it measured 40/19 and ANY later shape
      // added to this arm diluted it below the floor. Measured 98-120 generated, 91-108
      // non-zero.
      hopUntypedGenerated: cov.hopUntypedGenerated > 70,
      hopUntypedNonZero: cov.hopUntypedNonZero > 60,
      // Measured 263-311 generated and 109-128 of those with rows, AFTER this band gave half
      // its width to the count-shortcut family. If a future change narrows it again, this is
      // what says so.
      pageGenerated: cov.pageGenerated > 200,
      pageRows: cov.pageRows > 80,
    }).toEqual({
      perRepGenerated: true,
      perRepNonEmpty: true,
      predGenerated: true,
      predRows: true,
      sinkGenerated: true,
      sinkNonZero: true,
      peelGenerated: true,
      peelNonZero: true,
      crossGenerated: true,
      crossNonEmpty: true,
      cntPropGenerated: true,
      cntPropNonZero: true,
      hopFilterGenerated: true,
      hopFilterNonZero: true,
      hopUntypedGenerated: true,
      hopUntypedNonZero: true,
      pageGenerated: true,
      pageRows: true,
    });
    // 20 000 queries × two engines is well under a second locally but exceeds Bun's default
    // 5 s test timeout on the slower CI runners (~5.5–6 s) — give this heavy differential fuzz
    // a generous ceiling so it is not a wall-clock flake rather than trimming its coverage.
  }, 30_000);
});
