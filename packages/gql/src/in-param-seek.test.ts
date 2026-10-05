import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// `collectHints` handled `IN` but demanded a literal LIST node, so `WHERE k IN [$a, $b]` seeded an
// index while `WHERE k IN $names` did not — and the param form is the one applications write,
// because binding the list is what keeps values out of the query text. That left the bench row
// `write: 100 updates in one statement` reading the same indexed and unindexed in both engines,
// which is item 149's signature for an index doing nothing. CLAUDE.md names this very pair as one
// of four examples of this engine's bug class. Measured on 20,000 users, `name` indexed, 100
// names (audit item 184):
//
//   WHERE u.name IN $names RETURN count(*)      4751.3us, 0 hits  ->    79.1us, 100 hits   60x
//   WHERE u.name IN $names SET u.score = $v     5747.1us, 0 hits  ->   210.4us             27x
//   CONTROL WHERE u.name = $one (one value)       40.1us, 1 hit   ->    40.1us             flat
//
// There is no crossover to guard: the un-seeked alternative evaluates the whole list PER VERTEX,
// so it is O(vertices x list) while the seek is linear. At 10,000 of a 20,000 bucket the seek
// still won 2.66x (130.2 against 345.7ms), and at the full bucket the two were level.
//
// Two kinds of assertion. Seeding is answer-preserving, so every case is checked on BOTH an
// indexed and an unindexed graph — which is to say the seeked plan against the scanning one. And
// the CHOICE has no result-based witness, so index hits are counted.

/**
 * `n0`/`n7` share `k = 'a'` so a deduping seed set is exercised; `n5` STORES null and `n6` has no
 * `k` at all, which are different things under this engine's null policy; `x0` carries `k = 'a'`
 * but the wrong label, so a seek by VALUE must still be label-filtered.
 */
const fixture = (indexed: boolean): Graph => {
  const g = new Graph();

  (['a', 'b', 'c', 'd', 'e'] as const).forEach((v, i) =>
    g.addVertex({ id: `n${i}`, labels: ['N'], properties: { k: v, n: i } }),
  );
  g.addVertex({ id: 'n5', labels: ['N'], properties: { k: null, n: 5 } });
  g.addVertex({ id: 'n6', labels: ['N'], properties: { n: 6 } });
  g.addVertex({ id: 'n7', labels: ['N'], properties: { k: 'a', n: 7 } });
  g.addVertex({ id: 'x0', labels: ['Other'], properties: { k: 'a', n: 8 } });

  if (indexed) {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });
  }

  return g;
};

/** Assert the answer, and that the seeking and scanning plans agree on it. */
const both = (q: string, params: Record<string, unknown>, expected: unknown): void => {
  const sorted = (rows: unknown[]) => JSON.stringify(rows.map((r) => JSON.stringify(r)).sort());

  expect(sorted(query(fixture(false), q, params))).toBe(JSON.stringify(expected));
  expect(sorted(query(fixture(true), q, params))).toBe(JSON.stringify(expected));
};

/** How many times the query asked the property index for a set — the witness for a seek. */
const hits = (q: string, params: Record<string, unknown>): number => {
  const g = fixture(true);
  const idx = g.vertexPropertyIndex as unknown as {
    equals: (key: string, value: unknown) => unknown;
  };
  const real = idx.equals.bind(idx);
  let calls = 0;

  idx.equals = (key: string, value: unknown) => {
    calls += 1;

    return real(key, value);
  };

  query(g, q, params);

  return calls;
};

const COUNT = 'MATCH (u:N) WHERE u.k IN $l RETURN count(*) AS c';
const one = (c: number) => [JSON.stringify({ c })];

describe('an IN-list bound as a param seeds the index (item 184)', () => {
  test('the answer is unchanged, and duplicates in the list do not double-count', () => {
    // `a` matches n0 and n7, `b` matches n1.
    both(COUNT, { l: ['a', 'b'] }, one(3));
    both(COUNT, { l: ['a', 'a', 'b'] }, one(3));
  });

  test('an EMPTY list matches nothing', () => {
    both(COUNT, { l: [] }, one(0));
  });

  test('null in the list matches neither a STORED null nor an absent key', () => {
    // ISO three-valued `IN`: a null comparison is UNKNOWN, never TRUE. `n5` stores null and `n6`
    // has no `k`; neither is matched, and `a` still matches its two.
    both(COUNT, { l: ['a', null] }, one(2));
    both(COUNT, { l: [null] }, one(0));
  });

  test('cross-type values in the list match only their own type', () => {
    both(COUNT, { l: ['a', 1, true] }, one(2));
  });

  test('NOT IN is left alone', () => {
    // The hint is only sound as a NECESSARY condition; a negated `IN` is the opposite, so it must
    // not seed — and it must still answer correctly.
    //
    // The SYNTAX matters here. `NOT (u.k IN $l)` parses to a `not` wrapper that `collectHints`
    // never descends into, so it exercises nothing: a mutant dropping the `!where.negated` guard
    // survived against that spelling. `u.k NOT IN $l` is the one that reaches the `in` case with
    // `negated` set, and it is what catches it — seeding there would return 0 instead of 4.
    //
    // FOUR, not six: `n5` stores null and `n6` has no `k`, and `null NOT IN ['a']` is UNKNOWN
    // under three-valued logic, so neither is kept.
    both('MATCH (u:N) WHERE u.k NOT IN $l RETURN count(*) AS c', { l: ['a'] }, one(4));
    expect(hits('MATCH (u:N) WHERE u.k NOT IN $l RETURN count(*) AS c', { l: ['a'] })).toBe(0);
    // The wrapper spelling answers the same, through the ordinary predicate.
    both('MATCH (u:N) WHERE NOT (u.k IN $l) RETURN count(*) AS c', { l: ['a'] }, one(4));
  });

  test('a CORRELATED list answers correctly, from either clause shape', () => {
    // `u.k IN m.list` reads another pattern's variable. The hint's values are compiled and
    // resolved per execution against the binding, so correlation is not unsound here — but it is
    // not what `closedList` admits either, and these pin the ANSWER so a future relaxation
    // cannot change it quietly.
    const g = (indexed: boolean): Graph => {
      const h = fixture(indexed);

      h.addVertex({ id: 'm0', labels: ['L'], properties: { list: ['a', 'b'] } });

      return h;
    };
    const run = (q: string, indexed: boolean) => JSON.stringify(query(g(indexed), q)[0]);

    for (const q of [
      'MATCH (m:L) MATCH (u:N) WHERE u.k IN m.list RETURN count(*) AS c',
      'MATCH (m:L), (u:N) WHERE u.k IN m.list RETURN count(*) AS c',
    ]) {
      expect(run(q, true)).toBe(run(q, false));
      expect(run(q, false)).toBe(JSON.stringify({ c: 3 }));
    }
  });

  test('a SELF-referencing list answers correctly', () => {
    // `u.k IN u.list` cannot be resolved before `u` is chosen, so it must not seed.
    const g = (indexed: boolean): Graph => {
      const h = fixture(indexed);

      h.addVertex({ id: 'n8', labels: ['N'], properties: { k: 'z', list: ['z'], n: 9 } });

      return h;
    };
    const q = 'MATCH (u:N) WHERE u.k IN u.list RETURN count(*) AS c';

    expect(JSON.stringify(query(g(true), q)[0])).toBe(JSON.stringify(query(g(false), q)[0]));
  });

  test('a non-property LEFT operand answers correctly', () => {
    // `'a' IN $l` is a constant predicate over every row; there is no key to seed on.
    both("MATCH (u:N) WHERE 'a' IN $l RETURN count(*) AS c", { l: ['a'] }, one(8));
    both("MATCH (u:N) WHERE 'a' IN $l RETURN count(*) AS c", { l: ['z'] }, one(0));
  });

  test('a param bound to a NON-ARRAY declines the seek and still answers', () => {
    // `indexCandidates` resolves the values per execution and yields nothing unless they are an
    // array of scalars, so the scan stands rather than anything being mis-seeded.
    both(COUNT, { l: 'a' }, one(0));
    expect(hits(COUNT, { l: 'a' })).toBe(0);
    both(COUNT, { l: 42 }, one(0));
  });

  test('a seeked vertex of the WRONG LABEL is rejected', () => {
    // `x0` carries `k = 'a'` and is an `Other`. The seek returns it BY VALUE.
    both(COUNT, { l: ['a'] }, one(2));
    both('MATCH (u:Other) WHERE u.k IN $l RETURN count(*) AS c', { l: ['a'] }, one(1));
  });

  test('another conjunct beside the IN still filters', () => {
    // The seek is a SUPERSET; the predicate re-validates. n0 and n7 match `a`, and n7 fails n < 7.
    both('MATCH (u:N) WHERE u.k IN $l AND u.n < 7 RETURN count(*) AS c', { l: ['a', 'b'] }, one(2));
  });

  test('a projection, not just a count, agrees', () => {
    both('MATCH (u:N) WHERE u.k IN $l RETURN u.n AS r', { l: ['a', 'b'] }, [
      JSON.stringify({ r: 0 }),
      JSON.stringify({ r: 1 }),
      JSON.stringify({ r: 7 }),
    ]);
  });

  test('a SET through the same filter writes the same rows', () => {
    const run = (indexed: boolean): number => {
      const g = fixture(indexed);

      query(g, 'MATCH (u:N) WHERE u.k IN $l SET u.n = 99', { l: ['a'] });

      return (query(g, 'MATCH (u:N) WHERE u.n = 99 RETURN count(*) AS c')[0] as { c: number }).c;
    };

    expect(run(false)).toBe(2);
    expect(run(true)).toBe(2);
  });

  // The witness: seeding changes no row, so a mutant that stops seeding passes every test above.
  test('a param list SEEKS, once per value', () => {
    expect(hits(COUNT, { l: ['a', 'b'] })).toBeGreaterThan(0);
    // One `equals` per distinct value asked for, which is what makes it O(list) not O(vertices).
    expect(hits(COUNT, { l: ['a', 'b', 'c'] })).toBeGreaterThan(hits(COUNT, { l: ['a'] }));
  });

  test('the literal spellings still seek, as they did before', () => {
    expect(hits("MATCH (u:N) WHERE u.k IN ['a', 'b'] RETURN count(*) AS c", {})).toBeGreaterThan(0);
    expect(
      hits('MATCH (u:N) WHERE u.k IN [$a, $b] RETURN count(*) AS c', { a: 'a', b: 'b' }),
    ).toBeGreaterThan(0);
    both("MATCH (u:N) WHERE u.k IN ['a', 'b'] RETURN count(*) AS c", {}, one(3));
    both('MATCH (u:N) WHERE u.k IN [$a, $b] RETURN count(*) AS c', { a: 'a', b: 'b' }, one(3));
  });

  test('CONTROL an unindexed key does not seek', () => {
    expect(hits('MATCH (u:N) WHERE u.n IN $l RETURN count(*) AS c', { l: [0, 1] })).toBe(0);
    both('MATCH (u:N) WHERE u.n IN $l RETURN count(*) AS c', { l: [0, 1] }, one(2));
  });
});
