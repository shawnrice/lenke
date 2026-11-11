import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// `x IS TYPED <scalar type>`, one case per CATEGORY, and the reason the category switch has no
// `default` arm any more.
//
// The cross-engine conformance suite (`packages/native/src/gql-conformance.test.ts`) already
// pins INTEGER, FLOAT, STRING, BOOL, LIST, DATE, LOCAL DATETIME, DURATION, NULL and ANY
// byte-for-byte against the Rust engine, which is the test that matters for those. What it does
// NOT reach is the three remaining temporal categories — LOCAL TIME, ZONED TIME, ZONED DATETIME
// — and nothing reached them anywhere, which is what item 1787's census was pointing at. They
// are the arms most worth having: five temporal classes whose `instanceof` tests sit next to
// each other and are the easiest in the file to transpose.
//
// WHY THERE IS NO `default`. `categoryMatches` took a `string` and ended in
// `default: return false`, which nothing could reach: the only producer is the parser's
// `typeTestCategory`, and an unrecognized type NAME is rejected there as a syntax error — it
// never becomes a category at all. Item 1789 closed the AST's `category` to a union and deleted
// the arm, so the switch is exhaustive and a new category is a compile error rather than a
// silent FALSE. The parse-time rejection is the half of that argument which is testable, and it
// is the last test here.

const rows = (q: string): unknown[] => query(new Graph(), q);

const r = (q: string): unknown => (rows(q)[0] as Record<string, unknown>).r;

describe('IS TYPED — one case per temporal category, each against its siblings', () => {
  // Each line asserts the value matches its OWN category and not a neighbouring one. A single
  // positive assertion per category would pass for an `instanceof` chain that tested the wrong
  // class, as long as the classes shared a base.
  test('LOCAL TIME', () => {
    expect(r(`RETURN local_time('13:47:00') IS TYPED LOCAL TIME AS r`)).toBe(true);
    expect(r(`RETURN local_time('13:47:00') IS TYPED ZONED TIME AS r`)).toBe(false);
    expect(r(`RETURN local_time('13:47:00') IS TYPED LOCAL DATETIME AS r`)).toBe(false);
    expect(r(`RETURN local_time('13:47:00') IS TYPED DATE AS r`)).toBe(false);
    expect(r(`RETURN DATE '2020-01-01' IS TYPED LOCAL TIME AS r`)).toBe(false);
  });

  test('ZONED TIME', () => {
    expect(r(`RETURN zoned_time('13:47:00+02:00') IS TYPED ZONED TIME AS r`)).toBe(true);
    expect(r(`RETURN zoned_time('13:47:00+02:00') IS TYPED LOCAL TIME AS r`)).toBe(false);
    expect(r(`RETURN local_time('13:47:00') IS TYPED ZONED TIME AS r`)).toBe(false);
  });

  test('ZONED DATETIME', () => {
    expect(
      r(`RETURN zoned_datetime('2020-01-01T00:00:00+02:00') IS TYPED ZONED DATETIME AS r`),
    ).toBe(true);
    expect(
      r(`RETURN zoned_datetime('2020-01-01T00:00:00+02:00') IS TYPED LOCAL DATETIME AS r`),
    ).toBe(false);
    expect(r(`RETURN DATETIME '2020-01-01T00:00:00' IS TYPED ZONED DATETIME AS r`)).toBe(false);
  });

  test('a temporal is not a number, a string or a list', () => {
    // The non-temporal arms are covered cross-engine; what is NOT is that a temporal falls
    // through all of them. `float` is the dangerous one — a temporal with a numeric
    // representation behind it must not read as a number.
    expect(r(`RETURN DATE '2020-01-01' IS TYPED FLOAT AS r`)).toBe(false);
    expect(r(`RETURN DATE '2020-01-01' IS TYPED INTEGER AS r`)).toBe(false);
    expect(r(`RETURN DATE '2020-01-01' IS TYPED STRING AS r`)).toBe(false);
    expect(r(`RETURN duration('P1D') IS TYPED LIST AS r`)).toBe(false);
    // …and that DURATION does not read as one of the five instants.
    expect(r(`RETURN duration('P1D') IS TYPED LOCAL TIME AS r`)).toBe(false);
    expect(r(`RETURN duration('P1D') IS TYPED DURATION AS r`)).toBe(true);
  });

  test('the ANY and NULL categories, which are not instanceof tests at all', () => {
    // `any` is TRUE for every non-null value and `null` is FALSE for every one of them —
    // `categoryMatches` is only ever called on a NON-null value, the nullability being settled
    // by `valueIsTypedTy` before it. So `null IS TYPED NULL` is true by that outer rule, while
    // `1 IS TYPED NULL` is false by this inner one, and the two must not be conflated.
    expect(r(`RETURN local_time('13:47:00') IS TYPED ANY AS r`)).toBe(true);
    expect(r(`RETURN 1 IS TYPED NULL AS r`)).toBe(false);
    expect(r(`RETURN null IS TYPED NULL AS r`)).toBe(true);
    expect(r(`RETURN null IS TYPED LOCAL TIME AS r`)).toBe(true); // null conforms, nullable
    expect(r(`RETURN null IS TYPED LOCAL TIME NOT NULL AS r`)).toBe(false);
  });
});

describe('an unknown type name is a PARSE error, which is why the switch needs no default', () => {
  test('a bare unknown type name is rejected before execution', () => {
    // This is the testable half of the deleted `default` arm's unreachability: the category
    // never exists, so the switch is never asked about it.
    expect(() => rows(`RETURN 1 IS TYPED WIDGET AS r`)).toThrow();
    expect(() => rows(`RETURN 1 IS TYPED ZONED AS r`)).toThrow();
  });

  test('CONTROL the same shape with a real type name parses and answers', () => {
    // Without this the test above would pass for a parser that rejected `IS TYPED` outright.
    expect(r(`RETURN 1 IS TYPED INTEGER AS r`)).toBe(true);
  });
});
