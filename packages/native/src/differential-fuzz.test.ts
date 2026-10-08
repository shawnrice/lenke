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

import {
  columnOrderOf,
  nativeBackend,
  nativeReady,
  resultsEqual,
  resultsEqualInOrder,
} from './conformance-harness.js';
import { accept, resetUsage, usageCounts } from './divergence-registry.js';
import { graphFromNdjson } from './graph.js';

/// The quantified-subpath-GROUP counters: the peeled-endpoint form, the unanchored form that
/// reaches native's counting sink, the per-repetition `WHERE`, and a group under an explicit
/// SIMPLE. Lifted out of `tally` because that function sits on the complexity gate and item
/// 244's two new blocks took it from 35 to 37 — the same reason `genQuantifiedGroup` is its own
/// function. Nothing about what is counted changed in the move.
const tallyGroupShapes = (cov: Record<string, number>, q: string, nonEmpty: boolean): void => {
  // The optional path mode sits between `MATCH` and the pattern (item 244), so it is part of
  // the detector — `startsWith('MATCH (a:T)((x)')` counted only the no-mode third of the arm.
  // The optional third `(` is the NESTED sub-group spelling of the same unit: it is still a
  // peeled group count, so counting it here is what keeps the new arm from diluting this floor
  // instead of contributing to it.
  if (
    /^MATCH (?:WALK |TRAIL |SIMPLE |ACYCLIC )?\(a:T\)\(\(\(?x\)/.test(q) &&
    q.includes('(b:U)') &&
    q.includes('RETURN count(*)')
  ) {
    cov.peelGenerated++;

    if (nonEmpty) {
      cov.peelNonZero++;
    }
  }

  // The UNANCHORED group form, which is how native's counting sink is reached. The optional
  // path mode is part of the pattern now (item 244), so it has to be part of the detector:
  // `startsWith('MATCH ((x)')` would have kept matching only the no-mode third of the arm and
  // quietly cut this floor, which is the floor's whole purpose.
  if (
    /^MATCH (?:WALK |TRAIL |SIMPLE |ACYCLIC )?\(\(\(?x\)/.test(q) &&
    q.includes('RETURN count(*)')
  ) {
    cov.sinkGenerated++;

    if (nonEmpty) {
      cov.sinkNonZero++;
    }
  }

  // A GROUP pattern under an explicit SIMPLE, the shape that hid a wrong answer in BOTH
  // engines until item 244. `(` before the mode's pattern and no `]-{`/`]-+` is what tells a
  // group from the abbreviated form. Non-empty matters here beyond the usual reason: a SIMPLE
  // group whose closes are all dropped still returns rows, so the floor that discriminates is
  // the one on queries that actually CLOSE — and the fixture's `3 -> 1` edge is what supplies
  // them.
  if (q.includes('SIMPLE ') && q.includes('((x)') && !/\]-(>?)(\{|\+)/.test(q)) {
    cov.simpleGroupGenerated++;

    if (nonEmpty) {
      cov.simpleGroupNonEmpty++;
    }
  }

  // The PER-REPETITION `WHERE` sits after the unit and may read nodes; a PER-HOP one sits
  // inside the edge brackets and reads one edge. Stripping `[...]` first is what tells them
  // apart — without it, item 248's hop-predicate spellings inflated this counter from 352-422
  // to 486-527 by being counted as per-rep predicates. That is the same over-matching item 246
  // caught in `hopFilter`, found this time by the number moving the WRONG WAY: a counter that
  // RISES when a new spelling is added is as suspicious as one that falls.
  const unbracketed = q.replace(/\[[^\]]*\]/g, '');

  // ...and NOT the nested spelling, whose INNER `WHERE` has its own counter below. `(((x)` is
  // what tells them apart, and `((x)` is a substring of it — so this counter was inflated a
  // THIRD time (352-398 to 494-543) by item 252's arm, after item 248's inflated it via the
  // brackets. Three times is the pattern, not bad luck: a detector written as "contains the
  // group opener AND contains WHERE" matches every `WHERE` anywhere in a group, and each new
  // predicate POSITION borrows this counter until told not to.
  if (
    unbracketed.includes('((x)') &&
    !unbracketed.includes('(((x)') &&
    unbracketed.includes(' WHERE ')
  ) {
    cov.perRepGenerated++;

    if (nonEmpty) {
      cov.perRepNonEmpty++;
    }
  }

  // The PER-HOP predicate on a group hop (item 248), which native refused outright until then.
  // Its own counter, because it is a different code path from the per-rep one on both sides —
  // native lowers it to a per-rep conjunct at mini-scope slot `2p+1`, TS leaves it on the hop.
  if (q.includes('((x)') && /\[[^\]]*(WHERE|\{w:)/.test(q)) {
    cov.groupHopPredGenerated++;

    if (nonEmpty) {
      cov.groupHopPredNonEmpty++;
    }
  }

  // The SUBQUERY-PREDICATE placements (item 255). `EXISTS`/`COUNT`/`VALUE` under a bare
  // predicate and an AND-conjunct were covered; `NOT` and `OR` were generated zero times. The
  // non-empty floor is what matters as always: a `COUNT { … }` in boolean context is a static
  // type error in BOTH engines, so a counter on generation alone would be satisfied by queries
  // that compare two identical refusals.
  if (q.includes('(NOT ') && /(EXISTS|COUNT|VALUE) \{/.test(q)) {
    cov.subNotGenerated++;

    if (nonEmpty) {
      cov.subNotNonEmpty++;
    }
  }

  if (/ OR (EXISTS|COUNT|VALUE) \{/.test(q)) {
    cov.subOrGenerated++;

    if (nonEmpty) {
      cov.subOrNonEmpty++;
    }
  }

  // An INNER unit's own per-rep `WHERE` (items 252/253): a `WHERE` that sits before the INNER
  // group's `)` rather than the outer one. Detected on the nested spelling `(((x)` plus a
  // `WHERE` outside the edge brackets, which is what `unbracketed` already strips.
  if (unbracketed.includes('(((x)') && unbracketed.includes(' WHERE ')) {
    cov.innerWhereGenerated++;

    if (nonEmpty) {
      cov.innerWhereNonEmpty++;
    }
  }
};

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

  tallyGroupShapes(cov, q, nonEmpty);

  // The ABBREVIATED quantified form, which takes a DIFFERENT path from the group form above:
  // `trailEnds` synthesises a one-hop unit where a group builds a multi-hop one. Detected by a
  // quantifier directly after the edge brackets, which the group form never has — its quantifier
  // follows a `)`. Without this counter the arm could silently stop generating and the suite would
  // pass exactly as it does now, which is the failure items 115 and 125 both hit.
  if (/\]-(>?)(\{|\+)/.test(q)) {
    cov.abbrevGenerated++;

    if (nonEmpty) {
      cov.abbrevNonEmpty++;
    }

    // A PATH VARIABLE over it is the only shape that makes the walk reconstruct itself
    // (`wantPath`) rather than yield bare ends, and it is a minority of the arm's forms — so it
    // gets its own floor rather than hiding inside the arm's.
    if (q.includes('MATCH p = ')) {
      cov.abbrevPath++;
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
  // `[^()]*`, not `[^)]*`: the loose class let the UNANCHORED GROUP form in, because
  // `MATCH ((x)-[e1:E]->…` satisfies it with `[^)]*` swallowing `(x`. So this counter had
  // been tallying group queries as one-hop filtered counts — about 35% of its total, which
  // only showed when item 244 put a mode prefix on the group arm and the "drop" turned out
  // to be the pollution leaving. Forbidding a nested paren keeps it to genuine one-hop
  // patterns; the floors below were re-measured against the honest population and say so.
  if (/^MATCH \([ab]?[^()]*\)[-<]/.test(q) && q.includes(' WHERE ') && q.includes('count(*)')) {
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
  // A CYCLE on `E` — 1 -> 2 -> 3 -> 1 — without which the four PATH MODES are
  // INDISTINGUISHABLE. `trail` forbids repeating an edge, `simple`/`acyclic` a vertex, `walk`
  // nothing; on an acyclic fixture none of those restrictors can ever fire, so generating the
  // modes compares nothing. Measured: the mutant that forces WALK mode for the abbreviated
  // quantified form SURVIVED the whole fuzzer before this edge and is caught after it (audit
  // item 238).
  //
  // Safe against a runaway because the abbreviated arm pairs a MODE only with a BOUNDED
  // quantifier; `+` is generated under the default (trail) mode, where the restrictor bounds the
  // walk. An unbounded WALK over this cycle would terminate only on the trail budget, and a
  // resource limit is a poor thing to compare two engines on.
  '{"type":"edge","id":"e6","labels":["E"],"from":"3","to":"1","properties":{"w":7}}',
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
/**
 * A correlated SUBQUERY over the outer `n` — `EXISTS { … }`, `COUNT { … }` or `VALUE { … }`.
 *
 * NOTHING in any of the seven fuzzers generated one of these. `EXISTS {`, `COUNT {` and `VALUE {`
 * appeared zero times across every generator, while audit items 208 through 213 all worked on
 * subquery paths — and item 213 turned out to be a live TS-vs-native DIVERGENCE that reached main
 * because no fuzzer could produce the shape (audit item 214).
 *
 * `inner` is the far variable's name, and `collide` makes it equal the ALIAS the caller will use.
 * That is not a curiosity: item 213's bug needed exactly that collision. `aliasDefinition`
 * substitutes a sort alias with the expression it names, guarded on no FREE name of that
 * expression being an output name — and `freePredicateVars` returns the EMPTY set for a subquery,
 * so the guard could not see the collision, substituted, and the projected output overlaid on the
 * binding then bound the alias to the COUNT VALUE, which the sub-pattern matched against a number.
 */
/**
 * A correlated subquery BODY — `MATCH (n)<dir>(<inner>)[ WHERE … ]`, reading the outer `n`.
 *
 * Factored out of `genSubquery` so the boolean placements (item 255) build their own body
 * rather than reusing one already wrapped in a `COUNT`/`VALUE` that cannot be negated.
 */
const subqueryBody = (r: () => number, inner = 'b'): string => {
  const et = pick(r, ['E', 'F', 'E|F']);
  const dir = r() < 0.5 ? `-[:${et}]->` : `<-[:${et}]-`;
  const label = r() < 0.4 ? `${inner}:T` : inner;
  const where = r() < 0.4 ? ` WHERE ${inner}.n ${pick(r, CMP)} ${pick(r, ['2', '5', '0'])}` : '';

  return `MATCH (n)${dir}(${label})${where}`;
};

const genSubquery = (r: () => number, inner: string): string => {
  const body = subqueryBody(r, inner);
  const k = r();

  if (k < 0.45) {
    return `COUNT { ${body} }`;
  }

  if (k < 0.8) {
    return `EXISTS { ${body} }`;
  }

  // A scalar subquery must deliver at most one row, so its body is bounded — otherwise the
  // generator would spend most of its sample on the cardinality error rather than on the value.
  //
  // `count(*)` and a bare property are the two bodies BOTH engines support. A NAMED aggregate is
  // deliberately not generated, and that is a FEATURE GAP in native rather than a divergence to
  // excuse — found by this generator on its very first seed:
  //
  //     MATCH (n:T) RETURN VALUE { MATCH (n)-[:E]->(x) RETURN max(x.n) } AS v
  //       ts      [{v:2},{v:null}]
  //       native  E_UNKNOWN_FUNCTION: unknown function `max`
  //
  // Native resolves `max` at the TOP level and `count(*)` inside a `VALUE` body, but a named
  // aggregate inside one falls through to the scalar-function table in `gql.rs` and is rejected —
  // so the body is not being lowered as an aggregating projection. The divergence registry cannot
  // cover this and must not: it has no `value` axis, and `accept` refuses a value difference
  // whatever an entry says, which is right — one engine answering and the other raising on a
  // determinate question is a bug in one of them. Generating it every run would make the gate red
  // for a missing feature rather than for a regression, so the shape waits for the feature
  // (audit item 214).
  return r() < 0.5 ? `VALUE { ${body} RETURN count(*) }` : `VALUE { ${body} RETURN ${inner}.n }`;
};

/**
 * `allowSub` gates the SUBQUERY arm, and defaults to false so that with it unset this function is
 * byte-for-byte what it was before item 214 — every existing seed keeps its meaning.
 *
 * It is set only for a clause `WHERE` and a `FILTER`. An INLINE node predicate must not carry one:
 * native rejects a subquery there, which this generator found immediately —
 *
 *     MATCH p = ANY SHORTEST (a:T)-[:E]->*(n:T WHERE (n.n >= 4 AND EXISTS { MATCH (n)-[:E|F]->(b) }))
 *       ts      9 rows
 *       native  E_INVALID_VALUE
 *
 * — a second native FEATURE GAP beside the `VALUE { … RETURN max(…) }` one above, and recorded the
 * same way rather than excused: generating it would make the gate red for a missing feature instead
 * of a regression.
 */
const genPred = (r: () => number, depth: number, allowSub = false): string => {
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
    return `NOT ${genPred(r, depth - 1, allowSub)}`;
  }

  if (p < 0.9) {
    return `(${genPred(r, depth - 1, allowSub)} AND ${genPred(r, depth - 1, allowSub)})`;
  }

  // With `allowSub` unset this returns OR for the whole [0.9, 1) band, exactly as before.
  if (p < 0.96 || !allowSub) {
    return `(${genPred(r, depth - 1, allowSub)} OR ${genPred(r, depth - 1, allowSub)})`;
  }

  // A SUBQUERY predicate. Carved out of the OR fallback's tail rather than given its own band, so
  // every boundary below 0.9 is untouched and existing seeds keep their meaning up to there.
  //
  // Both spellings matter and they take different paths: a bare `EXISTS { … }` and one behind a
  // cheap conjunct, which is what item 175's seed gate orders and items 207/209 reasoned about.
  const sub = genSubquery(r, pick(r, ['b', 'x', 'c']));

  // FOUR placements, not two. `NOT <sub>` and a subquery under `OR` were generated ZERO times
  // (audit item 255) — the wrapper only ever built a bare one or an AND-conjunct — and they are
  // not variations on a theme:
  //
  //   - `NOT EXISTS { … }` is the documented ReBAC DENY pattern (`rebac-authz-on-lenke`), so it
  //     is a shape users are told to write and nothing compared it across the engines.
  //   - A subquery under `OR` is a DIFFERENT placement question from the AND case item 190
  //     fixed. That item's rule was that an EXISTS/COUNT conjunct must not fold into a node
  //     predicate nor ride a hop seed gate, and it leaned on `AND` never short-circuiting. `OR`
  //     has the opposite skew: the cheap side being TRUE makes the subquery unnecessary, so an
  //     engine that evaluates it anyway and one that skips it agree on the value and can differ
  //     on whether it FAULTS.
  //   - `NOT (… AND <sub>)` puts the negation outside a conjunction, which is where a planner
  //     that pushes the negation down has to get De Morgan right.
  // The NOT/OR placements take a BOOLEAN-valued subquery rather than the general one. Measured
  // first: with the general draw they ran 28-46 generated but only 6-15 NON-EMPTY, because
  // `COUNT { … }` and `VALUE { … }` in boolean context are a static type error in both engines
  // — so two of three draws compared two identical refusals and taught nothing the bare
  // placement already covers. `EXISTS { … }` and `COUNT { … } <cmp> 0` are both boolean AND
  // reach different code, so they are the two worth negating.
  const boolSub =
    r() < 0.5 ? `EXISTS { ${subqueryBody(r)} }` : `COUNT { ${subqueryBody(r)} } ${pick(r, CMP)} 0`;

  return pick(r, [
    `(${sub})`,
    `(n.n ${pick(r, CMP)} 4 AND ${sub})`,
    `(NOT ${boolSub})`,
    `(n.n ${pick(r, CMP)} 4 OR ${boolSub})`,
    `(NOT (n.n ${pick(r, CMP)} 4 AND ${boolSub}))`,
  ]);
};

// The ABBREVIATED quantified form — `-[]->{n,m}`, no subpath parens — which nothing here
// produced. The two arms above both emit the GROUP form `((x)…){n,m}`, and the two spellings
// take DIFFERENT code: a group builds a multi-hop unit, while the abbreviated form routes
// through `trailEnds`, which synthesises a one-hop unit of its own. So the group arms covered
// the nested machinery and left the one-hop path — the shape `bench:usage`'s two var-length
// rows actually use — with no cross-engine comparison at all (audit items 237, 238).
//
// ITS BAND IS 1% TAKEN FROM THE GROUP ARM BELOW — 0.88-0.89 here, leaving it 0.89-0.93 — and
// the size was settled by measurement, not by eye. Splitting that arm in HALF was the first
// attempt and the coverage floors caught it: `sinkGenerated` fell below its threshold, which
// is exactly what those floors are for. Routing it through the FALLBACK's 1.5% share was the
// second attempt and gave only ~110 queries of 20,000 — too thin for 6 modes x 5 bounds. 1%
// leaves the group arm at ~80% of its old rate, which its own floors clear comfortably.
//
// THE PATH MODE is generated here and nowhere else in this file. `WALK`/`TRAIL`/`SIMPLE`/
// `ACYCLIC` are contextual keywords before the pattern, the default is TRAIL, and the mode is
// what decides whether `hopCollides`/`hopMark` mark EDGES (trail) or VERTICES (simple/acyclic)
// or nothing (walk) — three different restrictors that had no differential coverage.
//
// A mode is paired only with a BOUNDED quantifier. `WALK` with an unbounded `+` has no
// restrictor to stop it, so on a cyclic fixture it terminates only on the trail budget — a
// resource limit is a poor thing to compare two engines on. `+` therefore appears under the
// default mode, where the trail restrictor bounds it.
//
// Its own function, not inline in the generator: that function is at the complexity gate and
// adding this arm's five `pick`s to it pushed it from 35 to 36. The file already factors
// `genPred`/`genExpr`/`genSubquery` out for the same reason.
/**
 * The quantified-subpath-GROUP arm's body.
 *
 * Lifted out of the generator because that function sits on the complexity gate: adding the
 * abbreviated arm above took it from 35 to 36, and moving this body — whose `end === '(b)'`
 * ternary is a branch of its own — brings it back to 35. Nothing about what it generates
 * changed (audit item 238).
 */
const genQuantifiedGroup = (r: () => number): string => {
  // A PER-HOP edge predicate / inline prop on a group hop. Native REFUSED every one of these
  // until item 248 (`E_NOT_IMPLEMENTED: edge properties / a per-hop WHERE on a subpath group`)
  // while TS answered them, and this arm generated none — so a hand-written probe found the
  // gap, not the fuzzer. A refusal against an answer IS a divergence here, so generating the
  // shape is all the guard needs. Distinct from the per-REPETITION `WHERE` below, which sits
  // after the unit and may read nodes: these sit inside the brackets and read one edge.
  const h1 = pick(r, [
    '-[e1:E]->',
    '<-[e1:E]-',
    '-[e1:F]->',
    '<-[e1:F]-',
    '-[e1:E WHERE e1.w > 2]->',
    '<-[e1:E WHERE e1.w >= 0]-',
    '-[e1:E {w: 2}]->',
  ]);
  const h2 = pick(r, [
    '-[:E]->',
    '<-[:E]-',
    '-[:F]->',
    '<-[:F]-',
    // A SECOND hop's predicate, which is the case that needs each hop addressed to its OWN
    // mini-scope slot (`2p + 1`): a fix that hard-coded slot 1 would answer hop 1 correctly
    // and hop 2 against the wrong edge.
    '-[e2:E WHERE e2.w <> 5]->',
    '-[:E {w: 5}]->',
  ]);
  const q = pick(r, ['{1,2}', '{1,1}', '{1,3}', '+']);
  // THE PATH MODE. Until item 244 this arm generated none at all, so every group pattern
  // ran under the default (TRAIL) and the mode's restrictors had differential coverage on
  // the abbreviated form ONLY. That gap hid two wrong answers at once: native's nested
  // walker had no closing-hop concept and silently dropped every closing repetition, and
  // TS tested for the close on the RAW position, which is true only for a single-level
  // unit — so TS answered `((x)-[:R]->(y)){1,2}` and `(((x)-[:R]->(y)){1,2}){1,1}`, the
  // same question, 11 and 6.
  //
  // Bounded quantifiers only, for the reason the abbreviated arm records: `WALK` with an
  // unbounded `+` has no restrictor, so on a cyclic fixture it stops only on the trail
  // budget, and a resource limit is a poor thing to compare two engines on.
  const mode = q === '+' ? '' : pick(r, ['', '', 'TRAIL ', 'WALK ', 'SIMPLE ', 'ACYCLIC ']);
  // A NESTED sub-group unit, `( ((x)-[e]->(y)){i,j} ){q}`, which `exec/nested.rs` documents
  // as "the 2-level shape the corpus and fuzzer produce" and which NOTHING generated — not
  // this fuzzer, not the corpus. Zero differential coverage, and that is what let TS's close
  // test (which read the RAW cursor position, true only for a single-level unit) answer
  // `((x)-[:R]->(y)){1,2}` and `(((x)-[:R]->(y)){1,2}){1,1}` — the same question — 11 and 6
  // (item 244). Verified by mutation: reinstating that test SURVIVES the fuzzer without this
  // arm and is caught with it.
  //
  // ITS SHARE IS 1 IN 6, settled by measurement in both directions. At 1 in 2 it halved three
  // neighbouring floors at once — `perRep` 573 to 299 (floor 350), `sink` 292 to 135 (200) and
  // `peel` 123 to 54 (75) — because the nested spelling carries no per-repetition `WHERE` and
  // writes `(((x)` where those detectors look for `((x)`. Three failing floors is the system
  // working; lowering them to fit a new arm is not. At 1 in 6 all three clear, and mutation
  // confirms this share still catches the bug it is here for.
  const inner = pick(r, ['', '', '', '', '{1,1}', '{1,2}']);
  // A PER-REPETITION `WHERE`, after the unit and INSIDE the parens (inside the edge
  // brackets is a per-HOP predicate, a different thing). Reads a NODE property and an
  // EDGE property, because those land in different columns of the per-rep mini-batch and
  // exactly that distinction was broken: native built the mini-batch boxed where the
  // single-direction path builds it typed, so any predicate touching a node read NULL and
  // pruned every repetition — a silent wrong answer against TS, on a shape this generator
  // already produced but never filtered (item 51).
  const perRepPick = pick(r, [
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
  // The per-rep `WHERE` stays on the FLAT unit only: one nesting level down, `x` and `e1` are
  // genuinely LISTS in the outer per-rep view rather than scalars, so a predicate reading
  // `x.n` there is a different question (and the flat unit already covers the scalar one).
  // Picked either way so the arm consumes the same number of draws regardless.
  const perRep = inner === '' ? perRepPick : '';
  // The INNER unit's OWN per-repetition `WHERE` — `( ((x)-[e1]->(y) WHERE …){a,b} ){c,d}`.
  // Native refused to PARSE it and TS silently IGNORED it (returning that shape's unfiltered
  // answer) until items 252/253, and nothing generated it. It is a different code path from
  // both the per-hop predicate and the outer per-rep one: native evaluates it at inner-rep
  // completion off `GUnit::per_rep`, TS through `resolve`'s gate.
  const innerWhere = pick(r, ['', '', ' WHERE x.n >= 0', ' WHERE x.n <> 999', ' WHERE e1.w > 2']);
  const unit = inner === '' ? `(x)${h1}(m)${h2}(y)${perRep}` : `((x)${h1}(y)${innerWhere})${inner}`;
  // The endpoint pattern varies, and `U` is the load-bearing one: every vertex in this fixture
  // carries `T`, so `(b:T)` is a filter that excludes nothing — native dropping the endpoint
  // predicate entirely was invisible under it. Only vertex 3 carries `U` (item 63).
  const end = pick(r, ['(b:T)', '(b:U)', '(b:U)', '(b)']);
  const body = `(a:T)(${unit})${q}${end}`;

  // UNANCHORED, kept at its own frequency: a label on either endpoint used to put the count
  // back on the materializing path, so native's counting sink was reached only by this
  // spelling, and until it existed no cross-engine comparison ran through the sink at all
  // (item 61). The sink now applies an endpoint filter itself, so the ANCHORED forms reach it
  // too — by a different route, which is why both spellings stay.
  const unanchored = `MATCH ${mode}(${unit})${q} RETURN count(*) AS x`;
  // With no endpoint pattern there is no `b` to project.
  const forms =
    end === '(b)'
      ? [`MATCH ${mode}${body} RETURN count(*) AS x`, unanchored]
      : [
          `MATCH ${mode}${body} RETURN count(*) AS x`,
          `MATCH ${mode}${body} RETURN b.n AS x, a.n AS t ORDER BY t, x`,
          unanchored,
        ];

  return pick(r, forms);
};

const genAbbrevQuantified = (r: () => number): string => {
  const hop = pick(r, [
    '-[:E]->',
    '<-[:E]-',
    '-[:F]->',
    '<-[:F]-',
    // An edge VARIABLE (a per-hop scalar, not a group list) and a per-HOP predicate inside the
    // brackets — distinct from the group arm's per-REPETITION `WHERE` after the unit.
    '-[e:E]->',
    '-[e:E WHERE e.w > 2]->',
    '<-[e:E WHERE e.w >= 0]-',
  ]);
  const bounded = pick(r, ['{1,1}', '{1,2}', '{1,3}', '{2,2}', '{0,2}']);
  const mode = pick(r, ['', '', 'TRAIL ', 'WALK ', 'SIMPLE ', 'ACYCLIC ']);
  // `(b:U)` is the load-bearing endpoint for the same reason the group arm records: every
  // vertex carries `T`, so `(b:T)` excludes nothing and a dropped endpoint predicate would be
  // invisible under it. Only vertex 3 carries `U`.
  const end = pick(r, ['(b:T)', '(b:U)', '(b:U)', '(b)']);

  return pick(r, [
    `MATCH ${mode}(a:T)${hop}${bounded}${end} RETURN count(*) AS x`,
    // UNBOUNDED, under the default (trail) mode only — see above.
    `MATCH (a:T)${hop}+${end} RETURN count(*) AS x`,
    // A PATH VARIABLE over the abbreviated form, which is the only thing that makes
    // `trailEnds` reconstruct the walk (`wantPath`) rather than yield bare ends. Totalised by
    // the ORDER BY, since several paths share a length.
    `MATCH p = ${mode}(a:T)${hop}${bounded}${end} RETURN size(nodes(p)) AS x ORDER BY x`,
    `MATCH p = (a:T)${hop}${bounded}${end} RETURN size(edges(p)) AS x ORDER BY x`,
    // The ENDPOINT projected rather than counted, so a wrong end is visible where a count
    // would agree.
    `MATCH ${mode}(a:T)${hop}${bounded}${end} RETURN b.n AS x ORDER BY x`,
  ]);
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
    // A `LIMIT` plus a SECOND, independently fallible item is what tells an engine that
    // projects only the EMITTED rows from one that projects them all: the discarded rows'
    // projection can FAULT. `ORDER BY x` sorting by an ALIAS is the shape whose substitution
    // decides that (it is what keeps the top-k over input bindings).
    //
    // Item 145 found this engine RAISING where native returned rows for exactly that query,
    // and nothing here generated it: the band's second item (`n.n`) cannot fault, and it
    // carried no `LIMIT`. Only the CONTENT of this shape changed, not its probability band,
    // so no later boundary moved.
    const paged = r() < 0.5 ? ` LIMIT ${1 + Math.floor(r() * 3)}` : '';
    const fallible = r() < 0.5 ? `${genExpr(r, 2)} AS u, ` : '';

    return `MATCH (n:T) RETURN ${fallible}${genExpr(r, 2)} AS x, n.n AS t ORDER BY x ${dir}${nulls}, t${paged}`;
  }

  if (p < 0.48) {
    const pred = r() < 0.75 ? genPred(r, 2, true) : genExpr(r, 2);

    return `MATCH (n:T) WHERE ${pred} RETURN n.n AS x ORDER BY x`;
  }

  if (p < 0.54) {
    return `MATCH (n:T) LET v = ${genExpr(r, 2)} RETURN v AS x, n.n AS t ORDER BY t`;
  }

  if (p < 0.6) {
    return `FOR v IN ${genExpr(r, 2)} RETURN v AS x`;
  }

  if (p < 0.64) {
    const pred = r() < 0.75 ? genPred(r, 2, true) : genExpr(r, 2);

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
      // TARGETED: `ORDER BY <COMPUTED alias>` with a LIMIT and a SECOND item that faults on
      // exactly the rows the LIMIT DISCARDS. This is the one combination that distinguishes
      // an engine projecting only the emitted rows from one projecting them all, and it was a
      // live divergence — this engine RAISED where native returned rows (TS audit item 145).
      //
      // Every piece is load-bearing and none of it is reachable by the random draw:
      //   - `st` exists ONLY on vertices 1 and 3, so `CAST(n.st AS INTEGER)` faults on those
      //     two and is NULL (not a fault) on the rest. A fallible expression over a property
      //     every vertex carries faults on the emitted rows too, and then BOTH engines raise.
      //   - `0 - n.n` is a COMPUTED alias, so it is the substitution under test; a plain
      //     column was already substituted and shows nothing.
      //   - ascending `x` puts n = 17, 13, 11 first (vertices 6, 5, 4 — no `st`) and leaves
      //     the two faulting rows outside `LIMIT 3`.
      // The random band above now also emits a LIMIT and a second fallible item, but on a
      // six-vertex fixture with `LIMIT 1-3` it reaches this coincidence too rarely to rely
      // on: three seeds did not catch the reverted fix, which is why this is spelled out.
      'MATCH (n:T) RETURN CAST(n.st AS INTEGER) AS u, 0 - n.n AS x, n.n AS t ORDER BY x, t LIMIT 3',
      'MATCH (n:T) RETURN CAST(n.st AS INTEGER) AS u, 0 - n.n AS x, n.n AS t ORDER BY x, t SKIP 1 LIMIT 2',
      // TARGETED: a MATCH predicate that faults on a candidate the LIMIT never needs. The
      // sibling of the two above — there the fault was in the PROJECTION, here it is in the
      // clause itself, which is a different code path (the uncorrelated tail cache) and was
      // its own live divergence: TS filled that cache eagerly, so it evaluated the predicate
      // on candidates past the limit and RAISED where native, which streams, returned a row
      // (TS audit item 150).
      //
      // Why it is spelled out rather than drawn: the fault must land AFTER the candidate that
      // satisfies the limit, and on this fixture only `n` can place it there. `st` exists on
      // vertices 1 and 3, and vertex 1 is FIRST in the bucket, so every `CAST(n.st …)`
      // predicate faults on candidate one — which both engines must evaluate, making it read
      // as agreement (the item-144 mistake). `n.n - 7` is zero on vertex 2 instead, and
      // vertex 1 (n = 3) satisfies `< 0` and fills `LIMIT 1` before vertex 2 is reached.
      //
      // Verified to have teeth by reverting the fix: pre-fix TS raised here while native
      // returned a row. The unlimited spelling is the control — both engines reach vertex 2
      // and both must raise.
      'MATCH (n:T) WHERE 1 / (n.n - 7) < 0 RETURN n.n AS x LIMIT 1',
      'MATCH (n:T) WHERE 1 / (n.n - 7) < 0 RETURN n.n AS x',
      // TARGETED: a PAGED count over a FAULTING predicate. The count shortcuts now answer a
      // SKIP/LIMIT themselves instead of declining it (TS audit item 152), which puts a
      // tally where the general pipeline used to be — so `LIMIT 0`, which must emit nothing
      // WITHOUT evaluating anything, becomes the case that can diverge: a tally that ran and
      // then sliced to empty would raise where the other engine returns no rows.
      //
      // The fault has to be in the clause WHERE, not in a `LET`: an arithmetic `LET` makes
      // the grouped shortcut DECLINE, so the query takes the general path and the assertion
      // is vacuous. Mutation proved that — with the fault in a `LET`, removing the engine's
      // guard changed nothing. The `WHERE` becomes the tally's per-vertex gate.
      //
      // `n.n - 7` is zero on vertex 2, so the predicate faults for both spellings below.
      //
      // THREE shapes, not the seven this started as. Every shape added to this `pick` list
      // dilutes the density of all the others, and seven took `hopFilterNonZero` from its
      // usual ~300 down to 248 against a floor of 250 — the fuzzer failed on COVERAGE, not on
      // a divergence. Lowering a floor to admit new shapes trades a real guard for a new one,
      // so the additions were trimmed instead, to the cases nothing else here reaches: the
      // non-zero-limit spellings are already covered by the `count(*) AS x LIMIT 1` shape
      // above, and an over-long SKIP adds nothing a LIMIT 0 does not already pin.
      'MATCH (n:T) WHERE 1 / (n.n - 7) > 0 RETURN count(*) AS x LIMIT 0',
      'MATCH (n:T) WHERE 1 / (n.n - 7) > 0 RETURN n.n AS g, count(*) AS x LIMIT 0',
      // One paged count WITHOUT a fault, so the window itself is compared: a shortcut that
      // windowed its groups in the wrong order answers this differently.
      'MATCH (n:T) RETURN n.n AS g, count(*) AS x SKIP 1 LIMIT 2',
      // UNTYPED and filtered, unconditionally rather than via the `rel` draw. This is the
      // spelling that was WRONG (item 114), so its density is pinned by its own shapes and a
      // coverage floor instead of being left to a 1-in-4 pick that later shapes dilute.
      // Note the fixture's two-type edge makes `multiTypeEdgeCount > 0`, so these route to
      // the per-edge tally — which is exactly the path that answered 0.
      `MATCH (a:T)-[]->(b) WHERE ${pick(r, ['a.n >= 0', 'a.n > 3', 'b.n > 3'])} RETURN count(*) AS x`,
      `MATCH (a:T)<-[]-(b) WHERE ${pick(r, ['a.n >= 0', 'b.n = 7'])} RETURN count(*) AS x`,
      `MATCH (a)-[e]->(b) WHERE e.w >= 0 RETURN count(*) AS x`,
      // MULTI-PATTERN MATCH — a comma-separated product, which this generator emitted ZERO
      // times before. That is how the per-outer-row rescan of audit item 121 went unnoticed,
      // and the hoist that fixed it lands in the matching core with no fuzzer coverage at all
      // until these shapes exist. The fixture is tiny, so a product is cheap.
      //
      // The pairs matter: an UNCORRELATED product may be hoisted, while a tail that READS the
      // outer pattern (`{n: a.n}`) or SHARES its variable (`(a)-[:E]->`) must not be. A
      // correlation test that is wrong in either direction answers differently on one of these.
      `MATCH (a:T), (b:${pick(r, ['T', 'U'])}) RETURN count(*) AS x`,
      `MATCH (a:T {n: ${pick(r, ['3', '5', '7'])}}), (b:T {n: ${pick(r, ['3', '7'])}}) RETURN count(*) AS x`,
      `MATCH (a:T), (a)-[:${t}]->(b) RETURN count(*) AS x`,
      `MATCH (a:T), (b:U), (d:T) RETURN count(*) AS x`,
      // ...and with ROWS rather than a count, so column order and values are compared too.
      `MATCH (a:T), (b:U) RETURN a.n AS x, b.n AS t ORDER BY x, t`,
      // An INLINE constraint on a hop's FAR endpoint, which this generator also emitted zero
      // times. The count shortcut used to DECLINE these and run the general pipeline; it now
      // carries the constraint into its tally (audit item 125), so a shortcut that applied the
      // predicate to the wrong end — or dropped it, and answered the whole bucket's count —
      // would be invisible without these. The clause-`WHERE` twin is generated above, so the
      // two spellings are compared against native independently.
      // Two of these draw the relationship spelling (sometimes UNTYPED) rather than hard-coding
      // `[:${t}]`, so they feed the `hopUntyped` floor as well as the inline one. Adding four
      // shapes that all used a typed rel diluted every existing share in this arm and pushed
      // `hopUntyped` under its floor — the same dilution item 115 hit, and the reason that
      // spelling has dedicated shapes at all.
      `MATCH (a:T)-${pick(r, [`[:${t}]`, '[]'])}->(b {n: ${pick(r, ['3', '5', '7'])}}) RETURN count(*) AS x`,
      `MATCH (a:T)-[:${t}]->(b:T {n: ${pick(r, ['3', '7'])}}) RETURN count(*) AS x`,
      `MATCH (a:T)<-${pick(r, [`[:${t}]`, '[]'])}-(b {n: ${pick(r, ['3', '5'])}}) RETURN count(*) AS x`,
      `MATCH (a:T)-[:${t}]->(b {s: ${pick(r, ["'a'", "'z'"])}}) RETURN count(*) AS x`,
      // An inline constraint on the START endpoint, which routes to the per-VERTEX walk rather
      // than the edge tally (audit item 129) — a different code path from the far-endpoint
      // shapes above, and one that adds a vertex's whole DEGREE at a time, so an off-by-a-degree
      // would be invisible without it.
      `MATCH (a:T {n: ${pick(r, ['3', '5', '7'])}})-[:${t}]->(b) RETURN count(*) AS x`,
      `MATCH (a:T {n: ${pick(r, ['3', '7'])}})<-[:${t}]-(b) RETURN count(*) AS x`,
      `MATCH (a:T WHERE a.n = ${pick(r, ['3', '5'])})-[:${t}]->(b) RETURN count(*) AS x`,
      // …and with the far side ALSO constrained, which must send it off the per-vertex walk.
      `MATCH (a:T {n: 3})-[:${t}]->(b {n: ${pick(r, ['5', '7'])}}) RETURN count(*) AS x`,
      // DELIBERATELY NOT GENERATED: a tail whose INLINE predicate reads another pattern's
      // variable — `(b:T {n: a.n})` or `(b:T WHERE b.n = a.n)`. TS accepts both; native
      // rejects both with E_SYNTAX while accepting the clause-level `WHERE b.n = a.n`. That
      // is a pre-existing capability gap (no Rust changed when it was found), so generating
      // it would make this suite red on a question about the engines rather than about any
      // change. Written up in audit item 122. CONSEQUENCE: the `reads` half of
      // `tailIsUncorrelated` has NO fuzzer coverage — there is no spelling of pattern-level
      // correlation native will parse — so its only guard is
      // `packages/gql/src/multi-pattern.test.ts`.
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

  if (p < 0.89) {
    return genAbbrevQuantified(r);
  }

  // A quantified subpath group whose two hops DISAGREE on direction and/or edge type
  // (`((x)-[d1:t1]->(m)-[d2:t2]->(y)){n,m}`). Native used to reject any non-uniform unit;
  // it now routes to the per-hop nested-group machinery, byte-identical to TS. `count(*)`
  // and the endpoint keep the comparison order-free / totalised.
  if (p < 0.93) {
    return genQuantifiedGroup(r);
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

  // A SUBQUERY as a projected ITEM, half the time — taken from the generic fallback's share so no
  // band boundary moves.
  //
  // This is the shape item 213's divergence needed and `genPred`'s arm cannot produce: a subquery
  // in a projection item, under an `ORDER BY` on its ALIAS, where the alias may COLLIDE with a
  // variable the subquery binds. `aliasDefinition` substituted the alias with the subquery, the
  // projected output was then overlaid on the binding, and the alias — bound to the subquery's own
  // VALUE — shadowed the pattern variable, so the sub-pattern matched against a number and counted
  // 0 for every row. TS answered unsorted where native sorted.
  //
  // The collision is generated deliberately and often: without it the bug is unreachable, which is
  // exactly why it reached main. `t` is carried as a final sort key for the usual reason (row order
  // is otherwise unspecified), and the window is generated because a wrong sort key under one
  // returns the wrong ROW rather than merely the wrong order.
  if (r() < 0.5) {
    const inner = r() < 0.6 ? 'b' : pick(r, ['x', 'c']);
    // COLLIDE: the alias IS the subquery's far variable.
    const alias = r() < 0.6 ? inner : 'q';
    const dir = pick(r, ['', ' DESC']);
    const paged = r() < 0.3 ? ` LIMIT ${1 + Math.floor(r() * 3)}` : '';

    return `MATCH (n:T) RETURN ${genSubquery(r, inner)} AS ${alias}, n.n AS t ORDER BY ${alias}${dir}, t${paged}`;
  }

  return `MATCH (n:T) RETURN ${genExpr(r, 3)} AS x, n.n AS t ORDER BY t`;
};

const codeOf = (e: unknown): string =>
  (e as { code?: string })?.code ?? (e instanceof Error ? e.name : 'unknown');

/**
 * Does this query's `ORDER BY` impose a TOTAL order, so the row SEQUENCE is comparable?
 *
 * `resultsEqual` sorts the rows away, which is correct for an unordered result and is why no
 * generated shape could ever have caught audit item 213's `ORDER BY`-that-did-not-order. The fix is
 * to compare sequences where the order is total — and only there, because a TIE leaves the sequence
 * unspecified and comparing it would report the engines' free choice as a bug.
 *
 * The file's own convention is what makes this decidable: "Every ORDER BY ends with the distinct
 * `n.n`", projected as `AS t`. So a query that projects `n.n AS t` and whose FINAL sort key is `t`
 * is totally ordered, since `n` ranges over distinct vertices and `n.n` is distinct per vertex.
 * Anything else — `ORDER BY k, c` over a grouped key, a sort over a non-unique expression — is left
 * to the unordered comparison, which is what it was before.
 */
const totallyOrdered = (q: string): boolean =>
  q.includes('n.n AS t') && /ORDER BY .*\bt\b(?: LIMIT \d+)?$/.test(q);

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
      abbrevGenerated: 0,
      abbrevNonEmpty: 0,
      abbrevPath: 0,
      simpleGroupGenerated: 0,
      simpleGroupNonEmpty: 0,
      groupHopPredGenerated: 0,
      groupHopPredNonEmpty: 0,
      innerWhereGenerated: 0,
      innerWhereNonEmpty: 0,
      subNotGenerated: 0,
      subNotNonEmpty: 0,
      subOrGenerated: 0,
      subOrNonEmpty: 0,
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
        // COLUMN order, which `resultsEqual` cannot see because it sorts keys. Checked
        // before the value comparison so a column-order divergence is reported as itself
        // rather than hiding behind an equal-after-canonicalization pass.
        const tsCols = columnOrderOf(ts.json);
        const natCols = columnOrderOf(nat.json);

        if (tsCols !== natCols) {
          divergences.push(
            `[seed ${caseSeed(SEED, i)}] ${q}\n    ts cols:     ${tsCols}` +
              `\n    native cols: ${natCols}` +
              `\n    (column order: fixed by RETURN, so this is a value difference no registry entry may excuse)`,
          );
        }

        const agree = totallyOrdered(q)
          ? resultsEqualInOrder(ts.json, nat.json)
          : resultsEqual(ts.json, nat.json);

        if (!agree && !numericTextTie(ts.json, nat.json)) {
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
        `abbrev=${cov.abbrevGenerated}/${cov.abbrevNonEmpty}/${cov.abbrevPath} ` +
        `simpleGroup=${cov.simpleGroupGenerated}/${cov.simpleGroupNonEmpty} ` +
        `groupHopPred=${cov.groupHopPredGenerated}/${cov.groupHopPredNonEmpty} ` +
        `innerWhere=${cov.innerWhereGenerated}/${cov.innerWhereNonEmpty} ` +
        `subNot=${cov.subNotGenerated}/${cov.subNotNonEmpty} ` +
        `subOr=${cov.subOrGenerated}/${cov.subOrNonEmpty} ` +
        `sink=${cov.sinkGenerated}/${cov.sinkNonZero} peel=${cov.peelGenerated}/${cov.peelNonZero} ` +
        `cross=${cov.crossGenerated}/${cov.crossNonEmpty} ` +
        `cntProp=${cov.cntPropGenerated}/${cov.cntPropNonZero} ` +
        `hopFilter=${cov.hopFilterGenerated}/${cov.hopFilterNonZero} ` +
        `hopUntyped=${cov.hopUntypedGenerated}/${cov.hopUntypedNonZero} ` +
        `page=${cov.pageGenerated}/${cov.pageRows}`,
    );
    expect({
      // RE-MEASURED AND LOWERED at item 244. The group arm gained a NESTED sub-group unit at a
      // 1-in-6 share, and that spelling carries no per-repetition `WHERE` — one nesting level
      // down `x`/`e1` are lists rather than scalars, a different question — so this shape
      // genuinely loses a sixth of the arm. Observed 352-422 generated and 215-243 non-empty
      // over five seeds, against 572-617/304-359 before; `> 350` cleared the minimum by two
      // queries, which is not a floor. Floors ~26% under the observed minimum, the margin the
      // rest of this block uses. The other two neighbours did NOT need lowering: making the
      // `sink` and `peel` detectors recognise the nested spelling put both ABOVE their old
      // rates (sink 283-333 against 288-320, peel 117-145 against 120-151), because the new
      // arm contributes to them rather than diluting them. Lowering a floor is the last
      // resort, after the detector has been checked.
      perRepGenerated: cov.perRepGenerated > 260,
      perRepNonEmpty: cov.perRepNonEmpty > 150,
      // The abbreviated quantified form (audit item 238). MEASURED 190-209 generated, 159-183 of
      // those non-empty and 76-88 carrying a path variable, over seeds 1-3 of 20,000. Floors at
      // roughly half, so a re-balanced band shows up as a FAILURE rather than as silence.
      //
      // Giving this arm its 1% also moved the GROUP arm's shares, and the rule below says to
      // re-measure and say so rather than lower anything: `perRep` went 709-771 to 572-617
      // (floor 350), `sink` 358-400 to 288-320 (200), `peel` 153-185 to 120-151 (75) and
      // `peelNonZero` 34-51 to 25-42 (15). All still clear, none lowered.
      abbrevGenerated: cov.abbrevGenerated > 100,
      abbrevNonEmpty: cov.abbrevNonEmpty > 80,
      abbrevPath: cov.abbrevPath > 35,
      // A GROUP pattern under an explicit SIMPLE (audit item 244) — the shape that hid a wrong
      // answer in BOTH engines. MEASURED over nine seeds of 20,000: 75-126 generated, 57-103 of
      // those non-empty. Floors ~25% under the observed minimum, the margin the rest of this
      // block uses. The non-empty one is what discriminates: a SIMPLE group whose closes are all
      // dropped still returns rows, so what the comparison needs is queries that actually reach a
      // close, which the fixture's `3 -> 1` edge supplies.
      simpleGroupGenerated: cov.simpleGroupGenerated > 55,
      simpleGroupNonEmpty: cov.simpleGroupNonEmpty > 40,
      // A PER-HOP edge predicate on a group hop (item 248) — the shape native refused outright
      // while TS answered it, and which no generator produced. MEASURED 415-454 generated and
      // 261-294 non-empty over four seeds of 20,000; floors ~25% under the minimum. It also
      // guards the SECOND hop's predicate, which is the half that needs each hop addressed to
      // its own mini-scope slot (`2p + 1`) — a fix hard-coding slot 1 answers hop 1 correctly
      // and hop 2 against the wrong edge.
      groupHopPredGenerated: cov.groupHopPredGenerated > 300,
      groupHopPredNonEmpty: cov.groupHopPredNonEmpty > 190,
      // An INNER unit's own per-rep `WHERE` (items 252/253) — native refused to PARSE it and
      // TS silently IGNORED it, each for as long as nothing generated it. MEASURED 142-182
      // generated and 126-161 non-empty over five seeds of 20,000; floors ~25% under the
      // minimum. It is a third predicate POSITION, distinct from the per-hop one (inside the
      // brackets) and the outer per-rep one (after the outer body), and each of the three
      // reaches different code on both sides.
      innerWhereGenerated: cov.innerWhereGenerated > 105,
      innerWhereNonEmpty: cov.innerWhereNonEmpty > 90,
      // The subquery-predicate placements `NOT` and `OR` (item 255), which were generated ZERO
      // times. MEASURED over ELEVEN seeds: subNot 19-42 generated / 16-39 non-empty, subOr
      // 14-21 / 11-20. Floors ~25% under the minima. These are small populations because the
      // band is a tail carve-out, so their job is strictly the one this block's note states —
      // catch a shape falling silently to ZERO — not to resolve a drift of a few percent.
      subNotGenerated: cov.subNotGenerated > 14,
      subNotNonEmpty: cov.subNotNonEmpty > 12,
      subOrGenerated: cov.subOrGenerated > 10,
      subOrNonEmpty: cov.subOrNonEmpty > 8,
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
      // These floors are PER-SHAPE shares of one arm, so they fall whenever the arm gains
      // shapes — adding the inline-endpoint shapes of item 125 dropped `hopUntyped` from
      // 98-120 to 47-81 without anything getting worse. So: when this arm grows, RE-MEASURE
      // these and say so, do not lower them until the suite goes green. Their job is to catch
      // a shape silently falling to ZERO, which is what happened twice (items 115, 125).
      //
      // RE-MEASURED in audit item 169, and the reason is recorded rather than the number just
      // lowered. Two things moved the band down since "429-477 / 293-354, 47-81 / 44-73":
      //
      //   1. Drift. Measured on the PRE-fix build over four runs, the band was already
      //      hopFilter 386-445 / 269-302 and hopUntyped 46-58 / 43-54 — below the recorded
      //      figures, from the arm gaining shapes over items 125-168 exactly as the note above
      //      predicts.
      //   2. Item 169 itself. These counters tally queries that PRODUCE ROWS, and that fix
      //      makes native raise on a non-boolean predicate inside a `CALL`/`EXISTS` body where
      //      it used to return rows. Those queries are now correctly errors, so they leave the
      //      non-empty population. That is the fix working, not coverage being lost.
      //
      // Twelve post-fix observations: hopFilter 376-425 / 248-307, hopUntyped 35-59 / 26-53.
      // `hopFilterNonZero > 250` became unreachable at the low end (248), which is what failed.
      // The floors below sit ~15-25% under the observed minimum, the same margin the old ones
      // had, and their job is unchanged: catch a shape falling silently to ZERO.
      //
      // RE-MEASURED AND LOWERED at item 244, because those figures were never this shape's.
      // The detector's `[^)]*` admitted the UNANCHORED GROUP form (`MATCH ((x)-[e1:E]->…`
      // satisfies it, with the class swallowing `(x`), so roughly 35% of the tally was group
      // queries counted as one-hop filtered counts. Tightening it to `[^()]*` leaves the honest
      // population at 117-158 generated and 108-141 non-zero over nine seeds, so 320/210 were
      // unreachable by the queries this counter is actually for. Floors ~25% under the observed
      // minimum. The LESSON is the counter's, not the floor's: a floor met by the wrong queries
      // reads exactly like a floor met.
      hopFilterGenerated: cov.hopFilterGenerated > 90,
      hopFilterNonZero: cov.hopFilterNonZero > 80,
      hopUntypedGenerated: cov.hopUntypedGenerated > 28,
      hopUntypedNonZero: cov.hopUntypedNonZero > 20,
      // Measured 263-311 generated and 109-128 of those with rows, AFTER this band gave half
      // its width to the count-shortcut family. If a future change narrows it again, this is
      // what says so.
      pageGenerated: cov.pageGenerated > 200,
      pageRows: cov.pageRows > 80,
    }).toEqual({
      perRepGenerated: true,
      perRepNonEmpty: true,
      abbrevGenerated: true,
      abbrevNonEmpty: true,
      abbrevPath: true,
      simpleGroupGenerated: true,
      simpleGroupNonEmpty: true,
      groupHopPredGenerated: true,
      groupHopPredNonEmpty: true,
      innerWhereGenerated: true,
      innerWhereNonEmpty: true,
      subNotGenerated: true,
      subNotNonEmpty: true,
      subOrGenerated: true,
      subOrNonEmpty: true,
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
