import { describe, expect, test } from 'bun:test';

import { createTestSocialGraph } from './fixtures/createTestSocialGraph.js';
import { query } from './index.js';

// Mirrors the Rust engine's `scalar_functions_graph_string_list_conversion` and
// `unknown_function_errors_instead_of_silent_null` (gql/tests.rs) so the two
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

  test('an unknown function is an error, never a silent null', () => {
    expect(() => query(g, `RETURN nope_fn(1) AS x`)).toThrow(/unknown or unimplemented function/);
  });
});
