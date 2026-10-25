import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { ErrorCode, hasErrorCode } from '@lenke/errors';

import type { Query } from './ast.js';
import { createTestSocialGraph } from './fixtures/createTestSocialGraph.js';
import { compile, parse, query } from './index.js';

// Mirrors the Rust engine's `scalar_fn_*` family in `gql/tests.rs`
// (`scalar_fn_null_and_domain`, `scalar_fn_parse_matches_hand`, `scalar_fn_errors` —
// the last pins that an unknown function is an error, not a silent null) so the two
// engines stay byte-identical on the common ISO scalar/value functions.
const g = createTestSocialGraph();
const one = (q: string): unknown => {
  const rows = query(g, q);

  expect(rows).toHaveLength(1);

  return rows[0].x;
};

describe('GQL: ISO graph / conversion / string-list scalar functions', () => {
  test('graph functions (labels / type / keys are sorted)', () => {
    expect(query(g, `MATCH (n:Person {name:'marko'}) RETURN labels(n) AS x`)[0].x).toEqual([
      'Person',
    ]);
    expect(query(g, `MATCH ()-[r:KNOWS]->() RETURN type(r) AS x LIMIT 1`)[0].x).toBe('KNOWS');
    expect(query(g, `MATCH (n:Person {name:'marko'}) RETURN keys(n) AS x`)[0].x).toEqual([
      'age',
      'name',
    ]);
  });

  test('conversion (null in → null out; whole-string numeric parse)', () => {
    expect(one(`RETURN to_integer('42') AS x`)).toBe(42);
    expect(one(`RETURN to_float('3.5') AS x`)).toBe(3.5);
    expect(one(`RETURN to_string(42) AS x`)).toBe('42');
    // Strict parse — a trailing non-numeric tail is NULL on BOTH engines
    // (Rust `str::parse::<f64>()` rejects it; JS `parseFloat` would wrongly
    // read `12`, so the TS engine gates on the numeric grammar first).
    expect(one(`RETURN to_integer('12abc') AS x`)).toBeNull();
    expect(one(`RETURN to_float('nope') AS x`)).toBeNull();
    expect(one(`RETURN to_string(null) AS x`)).toBeNull();
  });

  test('string / list functions', () => {
    // 1-based start (SQL / ISO GQL convention): positions 1..3 of 'hello'.
    expect(one(`RETURN substring('hello', 1, 3) AS x`)).toBe('hel');
    // start past the end → empty; a start <= 0 shrinks the window from the front.
    expect(one(`RETURN substring('hello', 4) AS x`)).toBe('lo');
    expect(one(`RETURN substring('hello', 0, 3) AS x`)).toBe('he');
    expect(one(`RETURN split('a,b,c', ',') AS x`)).toEqual(['a', 'b', 'c']);
    expect(one(`RETURN replace('a.b.c', '.', '-') AS x`)).toBe('a-b-c');
    expect(one(`RETURN head([1, 2, 3]) AS x`)).toBe(1);
    expect(one(`RETURN last([1, 2, 3]) AS x`)).toBe(3);
    expect(one(`RETURN reverse('abc') AS x`)).toBe('cba');
  });

  test('math: round (half away from zero, optional digits), sign, pi, e', () => {
    expect(one(`RETURN round(2.5) AS x`)).toBe(3);
    expect(one(`RETURN round(-2.5) AS x`)).toBe(-3);
    expect(one(`RETURN round(3.14159, 2) AS x`)).toBe(3.14);
    expect(one(`RETURN round(1234.5678, -2) AS x`)).toBe(1200);
    expect(one(`RETURN sign(-3.7) AS x`)).toBe(-1);
    expect(one(`RETURN sign(0) AS x`)).toBe(0);
    expect(one(`RETURN sign(5) AS x`)).toBe(1);
    expect(one(`RETURN pi() AS x`)).toBe(Math.PI);
    expect(one(`RETURN e() AS x`)).toBe(Math.E);
    expect(one(`RETURN round(null) AS x`)).toBeNull();
  });

  test('infix CONTAINS / STARTS WITH / ENDS WITH predicates', () => {
    expect(one(`RETURN 'Hello World' CONTAINS 'World' AS x`)).toBe(true);
    expect(one(`RETURN 'Hello World' STARTS WITH 'Hello' AS x`)).toBe(true);
    expect(one(`RETURN 'Hello World' ENDS WITH 'World' AS x`)).toBe(true);
    expect(one(`RETURN 'Hello World' CONTAINS 'xyz' AS x`)).toBe(false);
    // as a WHERE filter over the social graph
    const names = query(g, `MATCH (p:Person) WHERE p.name STARTS WITH 'ma' RETURN p.name AS n`).map(
      (r) => r.n,
    );
    expect(names).toEqual(['marko']);
  });

  test('CAST(value AS type) converts strictly, faulting on a failed conversion', () => {
    expect(one(`RETURN CAST('42' AS INTEGER) AS x`)).toBe(42);
    expect(one(`RETURN CAST(3.7 AS INT) AS x`)).toBe(3);
    expect(one(`RETURN CAST('3.5' AS FLOAT) AS x`)).toBe(3.5);
    expect(one(`RETURN CAST(42 AS STRING) AS x`)).toBe('42');
    expect(one(`RETURN CAST('yes' AS BOOL) AS x`)).toBe(true);
    expect(one(`RETURN CAST('on' AS BOOL) AS x`)).toBe(true); // the full SQL spelling set
    expect(one(`RETURN CAST('ab' AS LIST) AS x`)).toEqual(['a', 'b']);
    // A failed CAST is a data exception (ISO GQL), NOT a silent null — unlike the lenient
    // `to_integer`/`to_boolean` function forms.
    expect(() => one(`RETURN CAST('nope' AS INT) AS x`)).toThrow();
    expect(() => one(`RETURN CAST('nope' AS BOOLEAN) AS x`)).toThrow();
    expect(() => one(`RETURN CAST('Infinity' AS INTEGER) AS x`)).toThrow();
    expect(one(`RETURN to_integer('nope') AS x`)).toBeNull();
    expect(one(`RETURN to_boolean('nope') AS x`)).toBeNull();
  });

  // Mirrors the Rust engine's `a_graph_element_casts_to_nothing` (audit item 353).
  test('a graph element casts to NOTHING, for every target', () => {
    // Before this, `string` stringified the element to its EXTERNAL id here while native
    // answered its INTERNAL DENSE ID — four divergent shapes, and neither answer was a
    // documented contract. ISO's free artifacts show this is not a place implementations may
    // choose (item 347), so one engine had to change and a refusal is the conservative
    // direction. The MESSAGE is asserted, not just the throw, because the two engines must
    // produce the same bytes — and note `INTEGER`/`FLOAT` both report "number".
    const msg = (q: string): string => {
      try {
        one(q);
      } catch (e) {
        return (e as Error).message;
      }

      throw new Error(`${q} should have refused`);
    };

    expect(msg(`MATCH (p:Person) RETURN CAST(p AS STRING) AS x`)).toContain(
      'cannot cast a graph element to string',
    );
    expect(msg(`MATCH (p:Person) RETURN CAST(p AS INTEGER) AS x`)).toContain(
      'cannot cast a graph element to number',
    );
    expect(msg(`MATCH (p:Person) RETURN CAST(p AS FLOAT) AS x`)).toContain(
      'cannot cast a graph element to number',
    );
    expect(msg(`MATCH (p:Person) RETURN CAST(p AS BOOLEAN) AS x`)).toContain(
      'cannot cast a graph element to boolean',
    );
    expect(
      hasErrorCode(
        (() => {
          try {
            one(`MATCH (p:Person) RETURN CAST(p AS STRING) AS x`);
          } catch (e) {
            return e;
          }
        })(),
        ErrorCode.InvalidValue,
      ),
    ).toBe(true);
  });

  // Mirrors the Rust engine's `a_nested_graph_element_casts_to_nothing` (audit item 354).
  test('a NESTED graph element casts to nothing, at any depth', () => {
    // The half item 353 left open. Every shape here was a measured divergence before the fix:
    // this engine joined the element's EXTERNAL id into the string while native stringified the
    // whole element MAP (its containers render their items eagerly, so the top-level
    // `isVertex || isEdge` check could not see the element at all).
    //
    // Three families, all three found by surveying rather than by taking the one reported
    // shape: the container literals, the path ACCESSORS, and the path VALUE itself. Both twins
    // at every level — a node/edge asymmetry where only the vertex form is exercised is the
    // recurring hole here.
    const msg = (q: string): string => {
      try {
        query(g, q);
      } catch (e) {
        return (e as Error).message;
      }

      throw new Error(`${q} should have refused`);
    };

    for (const q of [
      `MATCH (p:Person) RETURN CAST([p, ''] AS STRING) AS x`,
      `MATCH ()-[r:KNOWS]->() RETURN CAST([r] AS STRING) AS x`,
      `MATCH (p:Person) RETURN CAST([[p]] AS STRING) AS x`,
      `MATCH (p:Person) RETURN CAST({v: p} AS STRING) AS x`,
      `MATCH (p:Person) RETURN CAST({k: 1, v: p} AS STRING) AS x`,
      `MATCH (p:Person) RETURN CAST([{v: p}] AS STRING) AS x`,
      `MATCH (p:Person) RETURN CAST({v: [p]} AS STRING) AS x`,
      `MATCH q = (:Person)-[:KNOWS]->(:Person) RETURN CAST(nodes(q) AS STRING) AS x`,
      `MATCH q = (:Person)-[:KNOWS]->(:Person) RETURN CAST(edges(q) AS STRING) AS x`,
      `MATCH q = (:Person)-[:KNOWS]->(:Person) RETURN CAST(q AS STRING) AS x`,
    ]) {
      expect(msg(q)).toContain('cannot cast a graph element to string');
    }

    // Every target, so the refusal precedes the whole switch and not just the `string` arm.
    // `[p] AS INTEGER` said "cannot cast a list to number" before — the list was refused and
    // the element never seen, so the engines agreed only by accident of wording.
    expect(msg(`MATCH (p:Person) RETURN CAST([p] AS INTEGER) AS x`)).toContain(
      'cannot cast a graph element to number',
    );
    expect(msg(`MATCH (p:Person) RETURN CAST([p] AS BOOLEAN) AS x`)).toContain(
      'cannot cast a graph element to boolean',
    );
    expect(msg(`MATCH (p:Person) RETURN CAST([p] AS LIST) AS x`)).toContain(
      'cannot cast a graph element to list',
    );

    // CONTROLS: a container of plain values, and a container of an element's PROPERTIES. A
    // `containsElement` that answered `true` unconditionally would pass every assertion above
    // and fail these.
    expect(one(`RETURN CAST([1, 2] AS STRING) AS x`)).toBe('1,2');
    expect(one(`RETURN CAST({a: 1} AS STRING) AS x`)).toBe('{"a":1}');
    expect(one(`MATCH (p:Person {name:'marko'}) RETURN CAST([p.name, p.age] AS STRING) AS x`)).toBe(
      'marko,29',
    );
    // A hand-written map with an element map's exact FIELD SET still casts. Native's nested
    // test is a rendered-SHAPE test keyed on `Value::Map`, and a GQL `{…}` literal lowers to a
    // `Value::Record`, so its known false positive is not reachable from GQL — which is why
    // this engine needs no shape test and the two still agree. Verified across both engines.
    expect(one(`RETURN CAST({id: 'a', labels: ['P'], properties: {k: 1}} AS STRING) AS x`)).toBe(
      '{"id":"a","labels":["P"],"properties":{"k":1}}',
    );

    // And a list containing an element still RENDERS as before: the refusal is confined to
    // CAST, so nothing about normal egress changed.
    const rendered = one(`MATCH (p:Person {name:'marko'}) RETURN [p] AS x`) as unknown[];

    expect(rendered).toHaveLength(1);
    expect((rendered[0] as { id: unknown }).id).toBeDefined();
  });

  test('temporal CAST targets desugar to the temporal constructor functions', () => {
    // `one` returns the raw temporal instance; compare its tagged JSON form.
    const tag = (q: string): unknown => (one(q) as { toJSON(): unknown }).toJSON();

    expect(tag(`RETURN CAST('2020-01-01' AS DATE) AS x`)).toEqual({ '@date': '2020-01-01' });
    expect(tag(`RETURN CAST('2020-01-01T08:30:00' AS DATETIME) AS x`)).toEqual({
      '@datetime': '2020-01-01T08:30:00',
    });
    // A bare date-only string coerces to midnight for a DATETIME target.
    expect(tag(`RETURN CAST('2020-01-01' AS TIMESTAMP) AS x`)).toEqual({
      '@datetime': '2020-01-01T00:00:00',
    });
    expect(tag(`RETURN CAST('2020-01-01T08:30:00' AS LOCAL DATETIME) AS x`)).toEqual({
      '@datetime': '2020-01-01T08:30:00',
    });
    expect(tag(`RETURN CAST('08:30:00' AS LOCAL TIME) AS x`)).toEqual({ '@localtime': '08:30:00' });
    expect(tag(`RETURN CAST('08:30:00+02:00' AS ZONED TIME) AS x`)).toEqual({
      '@zoned_time': '08:30:00+02:00',
    });
    expect(tag(`RETURN CAST('2020-01-01T08:30:00+02:00' AS ZONED DATETIME) AS x`)).toEqual({
      '@zoned_datetime': '2020-01-01T08:30:00+02:00',
    });
    expect(tag(`RETURN CAST('P1Y2M3DT4H' AS DURATION) AS x`)).toEqual({
      '@duration': 'P14M3DT14400S',
    });
    // A non-string operand desugars to the constructor and returns null (lenient).
    expect(one(`RETURN CAST(1 AS DATE) AS x`)).toBeNull();
  });

  test('CAST to an unrepresentable type is a loud syntax error', () => {
    expect(() => query(g, `RETURN CAST(1 AS BYTES) AS x`)).toThrow(/unsupported type/i);
    expect(() => query(g, `RETURN CAST(1 AS RECORD) AS x`)).toThrow(/unsupported type/i);
  });

  test('set-style list functions (dedup first-occurrence; sort reuses ORDER BY)', () => {
    expect(one(`RETURN list_union([1,2,2,3], [3,4,5]) AS x`)).toEqual([1, 2, 3, 4, 5]);
    expect(one(`RETURN intersection([1,2,3,3], [3,3,4,5]) AS x`)).toEqual([3]);
    expect(one(`RETURN difference([1,2,2,3], [3,4,5]) AS x`)).toEqual([1, 2]);
    // ISO GQL: list_contains returns numeric 1 / 0 (not a boolean).
    expect(one(`RETURN list_contains([1,2,3], 2) AS x`)).toBe(1);
    expect(one(`RETURN list_contains([1,2,3], 9) AS x`)).toBe(0);
    expect(one(`RETURN list_sort([3,1,4,1,5]) AS x`)).toEqual([1, 1, 3, 4, 5]);
    expect(one(`RETURN list_sort([3,1,2], 'desc') AS x`)).toEqual([3, 2, 1]);
    // null placement follows ORDER BY (default: nulls last on asc).
    expect(one(`RETURN list_sort([3,1,null,2]) AS x`)).toEqual([1, 2, 3, null]);
    expect(one(`RETURN list_sort([3,1,null,2], 'asc', 'first') AS x`)).toEqual([null, 1, 2, 3]);
  });

  test('an unknown function is an error, never a silent null', () => {
    // A typo'd/unknown function name is `UnknownFunction`, distinct from a
    // recognized-but-unimplemented feature — so a caller can tell them apart.
    expect(() => query(g, `RETURN nope_fn(1) AS x`)).toThrow(/unknown or unimplemented function/);

    try {
      query(g, `RETURN nope_fn(1) AS x`);

      throw new Error('expected a throw');
    } catch (e) {
      expect(hasErrorCode(e, ErrorCode.UnknownFunction)).toBe(true);
    }
  });

  test('an unknown function faults EAGERLY — even over empty input, a dead branch, or at compile', () => {
    // The name is resolved at COMPILE time (before any row runs), so an unknown
    // function faults identically whether the result set is empty or not, and even
    // when the call sits in a never-taken branch. A lazy per-row fault would
    // silently return `[]` over zero rows. Matches the Rust engine, which rejects an
    // unknown name at PARSE in `gql::Parser::call` — earlier still.
    const codeOf = (fn: () => unknown): unknown => {
      try {
        fn();
      } catch (e) {
        return (e as { code?: unknown }).code;
      }

      throw new Error('expected a throw, got a normal return');
    };

    // Zero-row result still faults (the bug: this used to return []).
    expect(codeOf(() => query(g, `MATCH (n) WHERE false RETURN nope_fn(n) AS x`))).toBe(
      ErrorCode.UnknownFunction,
    );

    // A never-taken CASE branch: name resolution is reachability-independent.
    expect(codeOf(() => query(g, `RETURN CASE WHEN false THEN bogus_fn(1) ELSE 1 END AS x`))).toBe(
      ErrorCode.UnknownFunction,
    );

    // `compile(parse(...))` throws immediately — before the plan is ever run.
    expect(codeOf(() => compile(parse(`RETURN nope_fn(1) AS x`) as Query))).toBe(
      ErrorCode.UnknownFunction,
    );
  });
});

describe('typed results (opt-in row-shape generic)', () => {
  test('query<R> returns R[] — no per-field cast, and the values are correct', () => {
    // Compile-time: `name` is `string` (not `unknown`), so this assigns without a
    // cast. Runtime: the value is right. A regression in the generic breaks tsc.
    const rows = query<{ name: string }>(g, `MATCH (p:Person) RETURN p.name AS name`);
    const names: string[] = rows.map((r) => r.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => typeof n === 'string')).toBe(true);
  });
});

// Regressions found by the cross-engine differential fuzzer
// (packages/native/src/differential-fuzz.test.ts). Each pins a case where this
// engine disagreed with the Rust engine; the fuzzer is randomized, so these
// deterministic tests are the permanent guards.
describe('GQL: byte-identity regressions from the differential fuzzer', () => {
  const g2 = createTestSocialGraph();
  const val = (q: string): unknown => query(g2, q)[0].x;

  test('slicing a surrogate PAIR in half yields U+FFFD, like native from_utf16_lossy', () => {
    // Item 768 gave `sanitizeSurrogates` a fast path that returns any string with NO surrogate
    // code unit unchanged, and mutation then showed the function had NO test at all: making it
    // never sanitize passed all 2,587 tests AND the seven byte-identity fuzzers, which
    // generate no non-ASCII strings (item 765 found the same blind spot for char_length).
    //
    // `😀` is one astral character, two UTF-16 units. Slicing between them leaves a LONE
    // surrogate, which this engine replaces with U+FFFD so the result matches what native's
    // UTF-8 strings can represent — a documented cross-engine deviation from JS `slice`.
    expect(val(`RETURN substring('a\u{1F600}b', 2, 1) AS x`)).toBe('\uFFFD');
    expect(val(`RETURN left('a\u{1F600}b', 2) AS x`)).toBe('a\uFFFD');
    expect(val(`RETURN right('a\u{1F600}b', 2) AS x`)).toBe('\uFFFDb');
    // A string with no surrogate at all is returned unchanged — the fast path's own case.
    expect(val(`RETURN substring('abcdef', 2, 3) AS x`)).toBe('bcd');
    // An INTACT pair survives: the guard sends it down the slow path and it re-encodes.
    expect(val(`RETURN substring('a\u{1F600}b', 2, 2) AS x`)).toBe('\u{1F600}');
  });

  test('split with an EMPTY delimiter yields one UTF-16 unit per element, lossily', () => {
    // Item 773 routed `split` through the specialized two-argument string closure, which calls
    // `splitScalar` rather than `String.prototype.split`. Mutation showed why that matters and
    // that nothing pinned it: `split: (s, sub) => s.split(sub)` passed all 2,590 tests.
    //
    // The two differ ONLY on a surrogate pair. JS `'a😀b'.split('')` keeps the two lone
    // surrogates; this engine replaces each with U+FFFD, because native's UTF-8 strings cannot
    // carry one — the same documented deviation `sanitizeSurrogates` exists for (item 768).
    expect(val(`RETURN split('ab', '') AS x`)).toEqual(['a', 'b']);
    expect(val(`RETURN split('a\u{1F600}b', '') AS x`)).toEqual(['a', '\uFFFD', '\uFFFD', 'b']);
    // A non-empty delimiter is the ordinary path, and the arguments are not interchangeable.
    expect(val(`RETURN split('a-b', '-') AS x`)).toEqual(['a', 'b']);
    expect(val(`RETURN split('-', 'a-b') AS x`)).toEqual(['-']);
  });

  test('a string predicate type-checks BOTH arguments before the null short-circuit', () => {
    // Item 769 specialized these three, and the order of the two checks is the contract:
    // `assertScalarArgTypes` validates both POSITIONS before `callStringPredicateFn`
    // short-circuits on a nullish argument. So a null beside a NUMBER is a data exception,
    // while a null beside a STRING is null.
    //
    // Mutation found nothing pinned this: moving the nullish check first — one branch cheaper
    // and the way it reads most naturally — passed all 2,589 tests and all seven fuzzers while
    // turning the first two cases below into nulls.
    expect(() => val(`RETURN starts_with(null, 5) AS x`)).toThrow(
      'starts_with() requires a string (a number is not coerced)',
    );
    expect(() => val(`RETURN starts_with(5, null) AS x`)).toThrow(
      'starts_with() requires a string (a number is not coerced)',
    );
    expect(val(`RETURN starts_with(null, 'a') AS x`)).toBeNull();
    expect(val(`RETURN contains('abc', null) AS x`)).toBeNull();
    expect(val(`RETURN ends_with('abc', 'bc') AS x`)).toBe(true);
    expect(val(`RETURN starts_with('abc', 'bc') AS x`)).toBe(false);
  });

  test('replace takes a MULTI-CHARACTER search, advancing by its whole length', () => {
    // Item 768 replaced `split(search).join(repl)` with an `indexOf` loop, and mutation showed
    // no test used a search longer than one character: advancing by 1 instead of
    // `search.length` passed everything.
    expect(val(`RETURN replace('aXYbXYc', 'XY', 'Z') AS x`)).toBe('aZbZc');
    // Overlapping candidates: 'aaa' with 'aa' matches ONCE, at 0, leaving the trailing 'a'.
    expect(val(`RETURN replace('aaa', 'aa', 'b') AS x`)).toBe('ba');
    // The tail after the last match is kept.
    expect(val(`RETURN replace('xAy', 'A', 'B') AS x`)).toBe('xBy');
  });

  test('coalesce returns the first NON-NULL argument, and NULL when there is none', () => {
    // Item 764 replaced `args.find((x) => !isNullish(x))` with a loop, and mutation found that
    // coalesce's VALUE behaviour had no unit test at all — only arity tests. Two wrong-answer
    // mutants (returning `args[0]` regardless of null, and falling out as `undefined` instead
    // of `null`) both passed all 2,586 tests and were caught only by the byte-identity
    // fuzzers. The fuzzers are the right backstop, but they localize nothing.
    expect(val(`RETURN coalesce(null, 5) AS x`)).toBe(5);
    expect(val(`RETURN coalesce(1, 2) AS x`)).toBe(1);
    // NULL and not `undefined`: both render as null at JSON egress, so only an in-engine
    // assertion tells them apart.
    expect(val(`RETURN coalesce(null, null) AS x`)).toBeNull();
  });

  test('a value stringifies like the native engine, not like String(v)', () => {
    // A record is a `Map` subclass, so `String(v)` gave "[object Map]"; an element
    // and a path have debug `toString`s. All of them render through `str` now.
    expect(val(`RETURN to_string({b: 2, a: 1}) AS x`)).toBe('{"a":1,"b":2}');
    expect(val(`RETURN CAST({a: 1} AS STRING) AS x`)).toBe('{"a":1}');
    // upper()/char_length()/|| of a non-string (here a record) NO LONGER coerce — they
    // are type errors now (strict typing), matching the native engine — the explicit
    // to_string()/CAST above are the only stringification path.
    expect(() => val(`RETURN upper({a: 'q'}) AS x`)).toThrow();
    expect(() => val(`RETURN char_length({a: 1}) AS x`)).toThrow();
    // The MESSAGE, not just the throw. It is a cross-engine contract — native's
    // `call_scalar_checked` raises the same text — and item 761 put a second copy of it in
    // the specialized one-argument string path before noticing that nothing pinned it. Both
    // paths are asserted here: `upper` is specialized at compile time, `replace` is not
    // (three string positions), and both must read identically.
    expect(() => val(`RETURN upper(1) AS x`)).toThrow(
      'upper() requires a string (a number is not coerced)',
    );
    expect(() => val(`RETURN replace(1, 'a', 'b') AS x`)).toThrow(
      'replace() requires a string (a number is not coerced)',
    );
    expect(() => val(`RETURN ({a: 1} || 'x') AS x`)).toThrow();
    // A record nested in a list goes through `str` too — `Array.join` would have
    // re-entered `String` and reproduced "[object Map]".
    expect(val(`RETURN to_string([{a: 1}]) AS x`)).toBe('{"a":1}');
    // A temporal inside a record keeps its tagged serialized form.
    expect(val(`RETURN to_string({a: date('2020-01-01')}) AS x`)).toBe(
      '{"a":{"@date":"2020-01-01"}}',
    );
    // An element stringifies to its id (what `element_id` returns).
    expect(val(`MATCH (n:Person {name:'marko'}) RETURN to_string(n) AS x`)).toBe(
      val(`MATCH (n:Person {name:'marko'}) RETURN element_id(n) AS x`),
    );
    // A list joins with ',', rendering a null element as the empty string.
    expect(val(`RETURN to_string([1, null, 3]) AS x`)).toBe('1,,3');
  });

  test('right() truncates its length and rejects NaN', () => {
    // `slice(len - n)` with a fractional n moved the START index, taking one char
    // too many; with NaN it became `slice(0)` — the whole string.
    expect(val(`RETURN right('abcdef', 2.9) AS x`)).toBe('ef');
    // A NON-numeric length is now a type error (strict typing), not a coerced-to-NaN
    // empty string — the number position of right() is not JS-coerced.
    expect(() => val(`RETURN right('abcdef', 'nan') AS x`)).toThrow();
    expect(() => val(`RETURN right('abcdef', 'inf') AS x`)).toThrow();
    // The ordinary cases are unchanged.
    expect(val(`RETURN right('abcdef', 3) AS x`)).toBe('def');
    expect(val(`RETURN right('abcdef', 0) AS x`)).toBe('');
    expect(val(`RETURN right('abcdef', 99) AS x`)).toBe('abcdef');
    expect(val(`RETURN right('abcdef', null) AS x`)).toBe(null);
  });

  test('nullif compares by value, not by reference', () => {
    // `a === b` is false for two equal temporals/lists/records (distinct objects),
    // so nullif returned the value where the native `value::equals` returned null.
    expect(val(`RETURN nullif(date('2020-01-01'), date('2020-01-01')) AS x`)).toBe(null);
    expect(val(`RETURN nullif(duration('P1Y2M'), duration('P1Y2M')) AS x`)).toBe(null);
    expect(val(`RETURN nullif([1, 2], [1, 2]) AS x`)).toBe(null);
    expect(val(`RETURN nullif({a: 1}, {a: 1}) AS x`)).toBe(null);
    // Unequal operands still yield the first value.
    expect(val(`RETURN nullif([1, 2], [1, 3]) AS x`)).toEqual([1, 2]);
    expect(val(`RETURN nullif(1, 2) AS x`)).toBe(1);
  });

  test('the conversion functions accept only numbers and strings', () => {
    // They used to convert by stringifying, so a one-element list ("[0]" → "0")
    // or an element (whose `str` is its id) came back as a number.
    expect(val(`RETURN to_integer([0]) AS x`)).toBe(null);
    expect(val(`RETURN to_float([1.5]) AS x`)).toBe(null);
    expect(val(`RETURN to_boolean([true]) AS x`)).toBe(null);
    expect(val(`MATCH (n:Person {name:'marko'}) RETURN to_integer(n) AS x`)).toBe(null);
    expect(val(`MATCH (n:Person {name:'marko'}) RETURN to_boolean(n) AS x`)).toBe(null);
    // The supported conversions are unchanged.
    expect(val(`RETURN to_integer('42') AS x`)).toBe(42);
    expect(val(`RETURN to_integer(3.9) AS x`)).toBe(3);
    expect(val(`RETURN to_float('1.5') AS x`)).toBe(1.5);
    expect(val(`RETURN to_boolean('true') AS x`)).toBe(true);
    // Only 'true'/'false' convert — 'yes'/'no'/'1'/'0' are not booleans (→ null),
    // matching the native engine (no JS-style coercion).
    expect(val(`RETURN to_boolean('yes') AS x`)).toBe(null);
    expect(val(`RETURN to_boolean('0') AS x`)).toBe(null);
  });

  test('a numeric string that overflows to Infinity is not a number', () => {
    // '1e1000' passes the finite-numeric grammar but parses to Infinity. JSON
    // renders both Infinity and null as `null`, so only a null test sees it.
    expect(val(`RETURN (to_float('1e1000') IS NULL) AS x`)).toBe(true);
    expect(val(`RETURN (to_integer('1e1000') IS NULL) AS x`)).toBe(true);
    expect(val(`RETURN (to_float('-1e1000') IS NULL) AS x`)).toBe(true);
    expect(val(`RETURN (to_float('1e300') IS NULL) AS x`)).toBe(false);
  });

  test('a non-finite number converts to null, not "NaN"/[null]', () => {
    // log10(-1) and asin(2) are NaN (kept as a live value, only nulled at egress).
    // The conversion functions treat a non-finite number as an invalid input → null,
    // matching the native engine (NOT JS `String(NaN)` = "NaN" or a `[null]` singleton).
    expect(val(`RETURN to_string(log10(-1)) AS x`)).toBe(null);
    expect(val(`RETURN to_string(asin(2)) AS x`)).toBe(null);
    expect(val(`RETURN to_list(log10(-1)) AS x`)).toBe(null);
    expect(val(`RETURN to_list(asin(2)) AS x`)).toBe(null);
    // to_integer of a non-finite number is null too (its integer branch checks
    // finiteness). This reads as null at RETURN but, unlike a raw NaN, also yields
    // ZERO rows through FOR..IN, matching the engine.
    expect(val(`RETURN to_integer(log10(-1)) AS x`)).toBe(null);
    expect(query(g, `FOR v IN to_integer(log10(-1)) RETURN v AS x`)).toEqual([]);
    // Finite values are unaffected.
    expect(val(`RETURN to_string(5.5) AS x`)).toBe('5.5');
    expect(val(`RETURN to_list(5) AS x`)).toEqual([5]);
    expect(val(`RETURN to_integer(3.9) AS x`)).toBe(3);
  });

  test('percentile requires numeric values, not coerced strings', () => {
    // A non-numeric value is a data exception now (strict typing) — no string is coerced,
    // not even a numeric-looking one, matching the native percentile / sum / avg.
    expect(() => val(`RETURN percentile_cont('0x10', 0.5) AS x`)).toThrow();
    expect(() => val(`RETURN percentile_cont('5', 0.5) AS x`)).toThrow();
    // Numbers still work.
    expect(val(`RETURN percentile_cont(3, 0.5) AS x`)).toBe(3);
    expect(val(`RETURN percentile_disc(3, 0.5) AS x`)).toBe(3);
  });

  test('range is bounded, and terminates past the float-step stall', () => {
    // A GQL list is materialized, so an unbounded range is an OOM kill rather than a
    // query error — and `i += 1` is a NO-OP once i reaches 2^53, so the old
    // comparison-driven loop never terminated for a large enough end.
    expect(val(`RETURN size(range(0, 999999)) AS x`)).toBe(1_000_000);
    expect(() => query(g2, `RETURN size(range(0, 1000000)) AS x`)).toThrow();
    expect(() => query(g2, `RETURN size(range(0, 1e21)) AS x`)).toThrow();
    expect(
      hasErrorCode(
        (() => {
          try {
            query(g2, `RETURN size(range(0, 1e21)) AS x`);
          } catch (e) {
            return e;
          }
        })(),
        ErrorCode.ResourceExhausted,
      ),
    ).toBe(true);
    // A wide step brings a wide span back under the budget.
    expect(val(`RETURN size(range(0, 1000000, 2)) AS x`)).toBe(500_001);
    // The 2^53 stall: 3 elements, and it terminates.
    expect(
      val(`RETURN size(range(to_float('9007199254740992'), to_float('9007199254740994'))) AS x`),
    ).toBe(3);
    // Ordinary semantics are unchanged.
    expect(val(`RETURN range(0, 5) AS x`)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(val(`RETURN range(5, 0, -1) AS x`)).toEqual([5, 4, 3, 2, 1, 0]);
    expect(val(`RETURN range(0, 10, 3) AS x`)).toEqual([0, 3, 6, 9]);
    expect(val(`RETURN range(0, 0) AS x`)).toEqual([0]);
    expect(val(`RETURN range(5, 0) AS x`)).toEqual([]);
    expect(val(`RETURN range(0, 10, 0) AS x`)).toBe(null);
  });

  test('compound kinds sort by distinct rank: list < record', () => {
    // The total order gives every kind a distinct rank — Num < Str < Bool < Temporal
    // < List < Record < Map < Null (value.rs `rank`) — so a list sorts BEFORE a record
    // (they are NOT a tie), byte-identical to the native engine. Same-kind pairs then
    // compare structurally. The old TS fallback compared JS string coercions ("1,2" vs
    // "[object Map]") and invented an order; both engines now agree on the rank order.
    expect(val(`RETURN list_sort([{a: 1}, [1, 2]]) AS x`)).toEqual(
      val(`RETURN [[1, 2], {a: 1}] AS x`),
    );
    expect(val(`RETURN list_sort([[1, 2], {a: 1}]) AS x`)).toEqual(
      val(`RETURN [[1, 2], {a: 1}] AS x`),
    );
    // The groups and the within-group orders are unaffected.
    expect(
      val(`RETURN list_sort([[1, 2], date('2020-01-01'), {a: 1}, true, 'z', 3]) AS x`),
    ).toEqual(val(`RETURN [3, 'z', true, date('2020-01-01'), [1, 2], {a: 1}] AS x`));
    expect(val(`RETURN list_sort([[3], [1], [2]]) AS x`)).toEqual(
      val(`RETURN [[1], [2], [3]] AS x`),
    );
    expect(val(`RETURN list_sort([{b: 1}, {a: 1}]) AS x`)).toEqual(
      val(`RETURN [{a: 1}, {b: 1}] AS x`),
    );
  });

  test('stddev over non-numeric values is a data exception, like sum/avg', () => {
    // A non-numeric value is NOT coerced — stddev faults (strict typing), matching the
    // native engine's stddev / sum / avg.
    expect(() => val(`MATCH (p:Person) RETURN stddev_pop(p.name) AS x`)).toThrow();
    expect(() => val(`MATCH (p:Person) RETURN stddev_samp(p.name) AS x`)).toThrow();
  });
});

describe('GQL: clause-level conditions use three-valued truth', () => {
  const g3 = createTestSocialGraph();

  test('a non-boolean WHERE / FILTER condition is a type error, not truthiness', () => {
    // Strict typing: a number/string condition is NOT coerced to truthy — it faults,
    // matching the native engine and SQL/ISO-GQL. Only a boolean (or null → UNKNOWN) is a
    // valid condition. (Previously `WHERE 1` kept every row via JS `Boolean(v)` truthiness.)
    expect(() => query(g3, `MATCH (p:Person) WHERE 1 RETURN p.name AS x`)).toThrow();
    expect(() => query(g3, `MATCH (p:Person) FILTER 1 RETURN p.name AS x`)).toThrow();
    expect(() => query(g3, `MATCH (p:Person) WHERE 'abc' RETURN p.name AS x`)).toThrow();
    expect(() => query(g3, `MATCH (p:Person) WHERE 0 RETURN p.name AS x`)).toThrow();
    expect(() => query(g3, `MATCH (p:Person) WHERE '' RETURN p.name AS x`)).toThrow();
    // A NULL condition is UNKNOWN (three-valued), not an error — it drops every row.
    expect(query(g3, `MATCH (p:Person) WHERE null RETURN p.name AS x`)).toHaveLength(0);
    // And an ordinary boolean predicate is unaffected.
    expect(query(g3, `MATCH (p:Person) WHERE p.name = 'marko' RETURN p.name AS x`)).toHaveLength(1);
  });
});

describe('GQL: ORDER BY + LIMIT projects only the emitted rows', () => {
  const g5 = createTestSocialGraph();

  test('a sort key that does not read the output enables the top-k', () => {
    // Only the top-k INPUT bindings are kept, and just those are projected — so a
    // projection that would fault on a row outside the top-k never runs. Mirrors
    // the native `ProjAccum` top-k mode (same five conditions).
    const ages = query(g5, `MATCH (p:Person) RETURN p.age AS a ORDER BY p.age`).map((r) => r.a);

    expect(ages.length).toBeGreaterThan(1);
    expect(query(g5, `MATCH (p:Person) RETURN p.age AS a ORDER BY p.age LIMIT 2`)).toEqual([
      { a: ages[0] },
      { a: ages[1] },
    ]);
    // Descending, SKIP, and a limit past the end all still work.
    expect(query(g5, `MATCH (p:Person) RETURN p.age AS a ORDER BY p.age DESC LIMIT 1`)).toEqual([
      { a: ages.at(-1) },
    ]);
    expect(query(g5, `MATCH (p:Person) RETURN p.age AS a ORDER BY p.age SKIP 1 LIMIT 1`)).toEqual([
      { a: ages[1] },
    ]);
    expect(query(g5, `MATCH (p:Person) RETURN p.age AS a ORDER BY p.age LIMIT 99`)).toHaveLength(
      ages.length,
    );
  });

  test('a sort key that READS the output disables it', () => {
    // The sort key is the projected column, so every row must be projected to
    // sort at all. Same for an alias of an input column, and for DISTINCT (whose
    // dedup key is built from the projected row).
    const byAlias = query(g5, `MATCH (p:Person) RETURN p.age AS a ORDER BY a LIMIT 2`);
    const byInput = query(g5, `MATCH (p:Person) RETURN p.age AS a ORDER BY p.age LIMIT 2`);

    expect(byAlias).toEqual(byInput);
    expect(
      query(g5, `MATCH (p:Person) RETURN DISTINCT p.age AS a ORDER BY p.age LIMIT 2`).length,
    ).toBeLessThanOrEqual(2);
  });
});

describe('GQL: a zero LIMIT returns no rows without projecting', () => {
  const g4 = createTestSocialGraph();

  test('LIMIT 0 never evaluates a faulting projection', () => {
    // The same rule the engine already follows for a non-zero LIMIT ("project
    // exactly the rows you emit"). Whether this faulted used to depend on the
    // presence of ORDER BY.
    expect(query(g4, `MATCH (p:Person) RETURN 1/0 AS x LIMIT 0`)).toHaveLength(0);
    expect(
      query(g4, `MATCH (p:Person) RETURN 1/0 AS x, p.name AS t ORDER BY t LIMIT 0`),
    ).toHaveLength(0);
    expect(query(g4, `MATCH (p:Person) RETURN DISTINCT 1/0 AS x LIMIT 0`)).toHaveLength(0);
    expect(query(g4, `MATCH (p:Person) RETURN sum(1/0) AS x LIMIT 0`)).toHaveLength(0);
    expect(query(g4, `MATCH (p:Person) WITH 1/0 AS x LIMIT 0 RETURN x`)).toHaveLength(0);
  });

  test('a non-zero LIMIT still projects (and still faults)', () => {
    expect(query(g4, `MATCH (p:Person) RETURN p.name AS x ORDER BY x LIMIT 1`)).toHaveLength(1);
    expect(() => query(g4, `MATCH (p:Person) RETURN 1/0 AS x LIMIT 1`)).toThrow();
    // Only a zero LIMIT short-circuits — SKIP past the end still evaluates.
    expect(() => query(g4, `MATCH (p:Person) RETURN 1/0 AS x SKIP 99`)).toThrow();
  });
});

describe('GQL: graph settings are constructor-only', () => {
  test('the range ceiling is set at construction', () => {
    // Settings are host policy, fixed for the graph's life — there is no runtime
    // mutator, so a query can never move its own ceiling.
    const dflt = new Graph();
    const raised = new Graph({ limits: { range: 5_000_000 } });
    const lowered = new Graph({ limits: { range: 10 } });

    expect(dflt.limits.range).toBe(1_000_000);
    expect(() => query(dflt, `RETURN size(range(0, 1000000)) AS x`)).toThrow();
    expect(query(raised, `RETURN size(range(0, 1000000)) AS x`)[0].x).toBe(1_000_001);
    expect(() => query(lowered, `RETURN size(range(0, 20)) AS x`)).toThrow();
    expect(query(lowered, `RETURN size(range(0, 5)) AS x`)[0].x).toBe(6);
  });

  test('the operator-chain ceiling is the same setting under two names', () => {
    const chain = `RETURN ${Array.from({ length: 30 }, (_, i) => i).join(' + ')} AS x`;

    expect(query(new Graph(), chain)[0].x).toBe(435);
    expect(new Graph({ limits: { operatorChain: 5 } }).maxOperatorChain).toBe(5);
    expect(new Graph({ maxOperatorChain: 5 }).limits.operatorChain).toBe(5);
    expect(() => query(new Graph({ limits: { operatorChain: 5 } }), chain)).toThrow();
    expect(() => query(new Graph({ maxOperatorChain: 5 }), chain)).toThrow();
  });

  test('unnamed settings keep their defaults, and a bad ceiling is rejected', () => {
    expect(new Graph({ limits: { trail: 50 } }).config).toEqual({
      limits: { range: 1_000_000, trail: 50, intermediate: 50_000_000, operatorChain: 1_024 },
      clock: null,
      parallelism: 1,
    });

    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => new Graph({ limits: { range: bad } })).toThrow();
    }
  });

  test('the clock is the one runtime-settable member', () => {
    // A host dependency rather than a resource bound: settable at construction OR
    // later, and clearing it with null is part of the contract.
    const clock = (): never => null as never;

    expect(new Graph({ clock }).config.clock).toBe(clock);
    expect(new Graph().setClock(clock).clock).toBe(clock);
    expect(new Graph({ clock }).setClock(null).config.clock).toBe(null);
    // No general runtime mutator.
    expect('configure' in new Graph()).toBe(false);
  });
});

// Item 790 routed the ONE-ARGUMENT trim family through `unaryStrCall`, gated on `args.length === 1`
// because `assertScalarArgTypes` skips an `undefined` argument and the positional check therefore
// reduces to "position 0 is a string" at that arity only. The TWO-argument forms must keep
// `callTrim`, char set and all.
//
// Dropping that arity test returns a WRONG ANSWER — the char set is ignored and whitespace is
// trimmed instead, and a NULL char set stops propagating — with the whole 2,608-test suite GREEN.
// The only trim coverage that existed was the one-argument forms (`gql.test.ts`), so nothing
// looked at the second argument at all.
describe('the two-argument trim forms keep their character set (item 790)', () => {
  test('a char set trims exactly those characters, not whitespace', () => {
    // The tab and newline survive: they are not in the set, and the 2-arg form is NOT a
    // whitespace trim. This is the assertion the arity test exists for.
    expect(one("RETURN btrim('\tmix\n ', ' a') AS x")).toBe('\tmix\n');
    expect(one("RETURN btrim('  pad  ', ' ') AS x")).toBe('pad');
    expect(one("RETURN ltrim('aab', 'a') AS x")).toBe('b');
    expect(one("RETURN rtrim('baa', 'a') AS x")).toBe('b');
    // CODE POINTS, not UTF-16 units — `multiTrim` iterates `Array.from`, matching Rust's
    // `chars()`, and that is a cross-engine contract.
    expect(one("RETURN btrim('  naïve ßé  ', 'é ') AS x")).toBe('naïve ß');
  });

  test('a NULL char set propagates null, where the one-argument form trims whitespace', () => {
    // The pair is the point: same function, same input, different arity, different answer.
    expect(one("RETURN btrim('  pad  ', null) AS x")).toBe(null);
    expect(one("RETURN ltrim('  pad  ', null) AS x")).toBe(null);
    expect(one("RETURN rtrim('  pad  ', null) AS x")).toBe(null);
    expect(one("RETURN btrim('  pad  ') AS x")).toBe('pad');
  });

  test('the one-argument forms trim whitespace, each at its own end', () => {
    // The specialized path itself, so a wrong `TRIM_1` entry is caught here rather than by the
    // two tests above.
    expect(one("RETURN trim('  pad  ') AS x")).toBe('pad');
    expect(one("RETURN btrim('  pad  ') AS x")).toBe('pad');
    expect(one("RETURN ltrim('  pad  ') AS x")).toBe('pad  ');
    expect(one("RETURN rtrim('  pad  ') AS x")).toBe('  pad');
    expect(one("RETURN trim('\t\n pad \n\t') AS x")).toBe('pad');
    expect(one('RETURN trim(null) AS x')).toBe(null);
  });
});

// Item 791 made an all-BMP character set scan UTF-16 UNITS instead of code points, which removed
// three allocations a row (4.0-4.4x). The equivalence rests on one fact: when the set holds no
// surrogate code unit, a surrogate half can never match, so the scan cannot split a pair.
//
// A set that DOES hold a surrogate must therefore fall through to the code-point path, and
// mutating that gate away returns MOJIBAKE while the whole suite stays green: `btrim('😁x😁',
// '😀')` answers a LONE LOW SURROGATE, because U+1F601 and U+1F600 share the high surrogate
// 0xD83D. That subject is the only thing that catches it — a first version of the probe used only
// 😀 against a 😀 set, where the unit scan happens to agree.
describe('a trim character set with an astral character keeps code-point semantics (item 791)', () => {
  const SMILE = '\u{1F600}'; // 😀  D83D DE00
  const GRIN = '\u{1F601}'; // 😁  D83D DE01 — the SAME high surrogate

  test('an astral char set does not split a different pair that shares its high surrogate', () => {
    // THE MUTANT KILLER. `GRIN` is not in the set, so nothing is trimmed and the pair survives
    // whole. A unit-wise scan would eat the shared high surrogate and leave `\uDE01`.
    expect(one(`RETURN btrim('${GRIN}x${GRIN}', '${SMILE}') AS x`)).toBe(`${GRIN}x${GRIN}`);
    expect(one(`RETURN ltrim('${GRIN} pad', '${SMILE}') AS x`)).toBe(`${GRIN} pad`);
    expect(one(`RETURN rtrim('pad ${GRIN}', '${SMILE}') AS x`)).toBe(`pad ${GRIN}`);
  });

  test('an astral char set still trims its OWN character', () => {
    // The fallback must remain correct, not merely safe.
    expect(one(`RETURN btrim('${SMILE}pad${SMILE}', '${SMILE}') AS x`)).toBe('pad');
    expect(one(`RETURN btrim('  ${SMILE}pad${SMILE}  ', ' ${SMILE}') AS x`)).toBe('pad');
    expect(one(`RETURN btrim('${SMILE}${SMILE}', '${SMILE}') AS x`)).toBe('');
  });

  test('a BMP char set leaves astral characters in the subject intact', () => {
    // The fast path itself: the set has no surrogate, so the scan stops at the pair rather than
    // entering it.
    expect(one(`RETURN btrim('  ${SMILE}pad${SMILE}  ', ' ') AS x`)).toBe(`${SMILE}pad${SMILE}`);
    expect(one(`RETURN btrim(' ${SMILE} ', ' ') AS x`)).toBe(SMILE);
    // A BMP NON-ASCII set member, which is one UTF-16 unit and so takes the fast path too.
    expect(one("RETURN btrim('  naïve ßé  ', 'é ') AS x")).toBe('naïve ß');
  });
});
