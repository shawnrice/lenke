import { describe, expect, test } from 'bun:test';

import { Graph, type LocalDate, parseDateTime } from '@lenke/core';
import { deserialize } from '@lenke/serialization';

import { query } from './index.js';

// Mirrors the Rust `gql::tests` temporal-literal suite: literals parse, compare
// chronologically, drive as-of WHERE filtering, and ORDER BY sorts them.

describe('GQL: temporal literals + comparison', () => {
  test('a DATE literal returns a LocalDate value', () => {
    const rows = query(new Graph(), `RETURN DATE '2020-02-29' AS d`);
    expect((rows[0].d as LocalDate).toJSON()).toEqual({ '@date': '2020-02-29' });
  });

  test('temporal literals compare chronologically', () => {
    const g = new Graph();
    expect(query(g, `RETURN DATE '2020-01-01' < DATE '2020-06-01' AS x`)).toEqual([{ x: true }]);
    expect(query(g, `RETURN DATE '2020-06-01' < DATE '2020-01-01' AS x`)).toEqual([{ x: false }]);
    expect(query(g, `RETURN DATE '2020-01-01' = DATE '2020-01-01' AS x`)).toEqual([{ x: true }]);
    expect(
      query(g, `RETURN TIMESTAMP '2021-06-15T08:30:00.5' >= DATETIME '2021-06-15T08:30:00' AS x`),
    ).toEqual([{ x: true }]);
  });

  test('cross-kind comparison is UNKNOWN (null)', () => {
    expect(
      query(new Graph(), `RETURN DATE '2020-01-01' < DATETIME '2020-01-01T00:00:00' AS x`),
    ).toEqual([{ x: null }]);
  });

  test('as-of WHERE filter (valid-time modeling)', () => {
    const doc = [
      '{"type":"node","id":"1","labels":["Fact"],"properties":{"name":"a","vfrom":{"@date":"2020-01-01"},"vto":{"@date":"2021-01-01"}}}',
      '{"type":"node","id":"2","labels":["Fact"],"properties":{"name":"b","vfrom":{"@date":"2021-01-01"},"vto":{"@date":"2022-01-01"}}}',
    ].join('\n');
    const g = deserialize(doc, 'ndjson', new Graph());
    expect(
      query(
        g,
        `MATCH (f:Fact) WHERE f.vfrom <= DATE '2020-06-01' AND DATE '2020-06-01' < f.vto RETURN f.name`,
      ),
    ).toEqual([{ 'f.name': 'a' }]);
  });

  test('ORDER BY sorts temporals chronologically', () => {
    const rows = query(
      new Graph(),
      `FOR d IN [DATE '2020-06-01', DATE '2020-01-01', DATE '2020-03-01'] RETURN d ORDER BY d`,
    );
    expect(rows.map((r) => (r.d as LocalDate).toJSON()['@date'])).toEqual([
      '2020-01-01',
      '2020-03-01',
      '2020-06-01',
    ]);
  });

  test('a malformed temporal literal is a syntax error', () => {
    expect(() => query(new Graph(), `RETURN DATE '2020-99-99'`)).toThrow();
  });
});

describe('GQL: temporal constructor functions', () => {
  test('date/local_datetime/duration parse strings; bad input → null', () => {
    const g = new Graph();
    expect((query(g, `RETURN date('2020-02-29') AS d`)[0].d as LocalDate).toISOString()).toBe(
      '2020-02-29',
    );
    expect(query(g, `RETURN date('nope') AS d`)).toEqual([{ d: null }]);
    // date(datetime) truncates to the date part.
    expect(
      (
        query(g, `RETURN date(local_datetime('2020-02-29T13:45:00')) AS d`)[0].d as LocalDate
      ).toISOString(),
    ).toBe('2020-02-29');
  });

  test('the function form converts a runtime string (not just a literal)', () => {
    expect(
      query(new Graph(), `FOR s IN ['2019-03-15'] RETURN date(s) < DATE '2020-01-01' AS x`),
    ).toEqual([{ x: true }]);
  });
});

describe('GQL: duration_between', () => {
  test('returns the exact span (days for dates, secs for datetimes)', () => {
    const g = new Graph();
    expect(
      String(query(g, `RETURN duration_between(DATE '2020-01-15', DATE '2020-04-20') AS d`)[0].d),
    ).toBe('P96D');
    expect(
      String(
        query(
          g,
          `RETURN duration_between(DATETIME '2020-01-01T00:00:00', DATETIME '2020-01-01T01:01:01') AS d`,
        )[0].d,
      ),
    ).toBe('PT3661S');
    // cross-kind → null
    expect(
      query(g, `RETURN duration_between(DATE '2020-01-01', DATETIME '2020-01-01T00:00:00') AS d`),
    ).toEqual([{ d: null }]);
  });
});

describe('GQL: current_* read an injected now (the engine never reads a clock)', () => {
  test('current_date/current_timestamp/local_timestamp desugar to the reserved $__now', () => {
    const g = new Graph();
    const now = { __now: parseDateTime('2026-07-12T10:30:45') };
    expect(String(query(g, `RETURN current_timestamp AS d`, now)[0].d)).toBe('2026-07-12T10:30:45');
    expect(String(query(g, `RETURN local_timestamp AS d`, now)[0].d)).toBe('2026-07-12T10:30:45');
    // current_date truncates the injected instant to its date part.
    expect(String(query(g, `RETURN current_date AS d`, now)[0].d)).toBe('2026-07-12');
    // Parenthesized call form is accepted too.
    expect(String(query(g, `RETURN current_timestamp() AS d`, now)[0].d)).toBe('2026-07-12T10:30:45');
    // No injected now → null (the engine stays pure; it never invents a clock).
    expect(query(g, `RETURN current_date AS d`)).toEqual([{ d: null }]);
  });
});

describe('GQL: temporal arithmetic', () => {
  test('month-add clamps; datetime+time; instant−instant; duration ops', () => {
    const g = new Graph();
    const one = (q: string): unknown => query(g, q)[0].d;
    expect(String(one(`RETURN DATE '2020-01-31' + DURATION 'P1M' AS d`))).toBe('2020-02-29');
    expect(String(one(`RETURN DATE '2021-01-31' + DURATION 'P1M' AS d`))).toBe('2021-02-28');
    expect(String(one(`RETURN DATETIME '2020-01-01T10:00:00' + DURATION 'PT1H30M' AS d`))).toBe(
      '2020-01-01T11:30:00',
    );
    expect(String(one(`RETURN DATE '2020-03-18' - DURATION 'P2M3D' AS d`))).toBe('2020-01-15');
    expect(String(one(`RETURN DATE '2020-04-20' - DATE '2020-01-15' AS d`))).toBe('P96D');
    expect(String(one(`RETURN DURATION 'P1M2DT3S' * 3 AS d`))).toBe('P3M6DT9S');
  });
});
