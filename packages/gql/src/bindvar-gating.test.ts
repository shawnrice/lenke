/**
 * `predFor`'s `bindVar` gating (item 803).
 *
 * `inlineHolds` writes `binding.set(bindVar, element)` once per ELEMENT, and `predFor` omits
 * `bindVar` when nothing in the predicate can read it back. These tests pin the three inputs that
 * decide that, because two of them are otherwise only reachable through a query shape:
 *
 *   - a surviving general `where` MUST keep `bindVar` — it reads the binding through `env`;
 *   - a fully-lifted predicate must DROP it — `eqProps`/`cmpProps` read the element directly;
 *   - `closedProps: false` must keep it — the caller is declaring it has NOT proved its `props`
 *     values are closed, so one of them may read the binding.
 *
 * The third is here because a mutation pass found it: every current caller passes `true`, so
 * `(!closedProps && props.length > 0)` is unreachable from a query and a mutant replacing it with
 * `false` survived the whole 2,624-test suite. It is a guard for a caller that does not exist yet,
 * which is exactly the shape item 468 records the cost of — so it gets a direct test rather than
 * being left believed-but-unchecked.
 *
 * The queries below are the end-to-end half: they pin that gating does not change an ANSWER, for
 * the lifting and non-lifting spellings and for an inline constraint.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { predFor } from './executor/shortcuts.ts';
import { query } from './index.ts';

const NEVER = (): unknown => {
  throw new Error('value closure must not be called by predFor');
};

describe('predFor: bindVar is carried only when the predicate can read the binding', () => {
  test('a surviving general `where` KEEPS bindVar', () => {
    expect(predFor({ props: [], where: () => true }, 'n', true)).toEqual({
      pred: { props: [], where: expect.any(Function) },
      bindVar: 'n',
    });
  });

  test('a fully-lifted predicate DROPS bindVar', () => {
    const pred = { props: [], cmpProps: [{ key: 'k', op: '>' as const, value: NEVER }] };

    expect(predFor(pred, 'n', true)).toEqual({ pred });
    expect(predFor(pred, 'n', true).bindVar).toBeUndefined();
  });

  test('lifted `eqProps` alone DROPS bindVar', () => {
    const pred = { props: [], eqProps: [{ key: 'k', value: NEVER }] };

    expect(predFor(pred, 'n', true).bindVar).toBeUndefined();
  });

  test('an EMPTY predicate drops bindVar whatever `closedProps` says', () => {
    expect(predFor({ props: [] }, 'n', false).bindVar).toBeUndefined();
    expect(predFor({ props: [] }, 'n', true).bindVar).toBeUndefined();
  });

  test('UNPROVEN props KEEP bindVar — the guard no current caller reaches', () => {
    const pred = { props: [{ key: 'k', value: NEVER }] };

    expect(predFor(pred, 'n', false)).toEqual({ pred, bindVar: 'n' });
    // The same predicate from a caller that HAS proved its props closed drops it.
    expect(predFor(pred, 'n', true).bindVar).toBeUndefined();
  });

  test('no own variable means no bindVar, whatever the predicate holds', () => {
    expect(predFor({ props: [], where: () => true }, undefined, false).bindVar).toBeUndefined();
    expect(
      predFor({ props: [{ key: 'k', value: NEVER }] }, undefined, false).bindVar,
    ).toBeUndefined();
  });
});

describe('gating does not change an answer', () => {
  const g = new Graph();

  for (let i = 0; i < 60; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 10, s: `s${i % 3}` } });
  }

  const count = (text: string): unknown => query(g, text)[0]?.c;

  test('a clause WHERE that lifts entirely', () => {
    expect(count('MATCH (n:P) WHERE n.k > 6 RETURN count(*) AS c')).toBe(18);
    expect(count("MATCH (n:P) WHERE n.s = 's1' RETURN count(*) AS c")).toBe(20);
  });

  test('a clause WHERE that does NOT lift keeps reading its own variable', () => {
    expect(count('MATCH (n:P) WHERE n.k * 1 > 6 RETURN count(*) AS c')).toBe(18);
    expect(count('MATCH (n:P) WHERE n.k + 1 > 7 RETURN count(*) AS c')).toBe(18);
  });

  test('an inline constraint and an inline WHERE', () => {
    expect(count('MATCH (n:P {k: 2}) RETURN count(*) AS c')).toBe(6);
    expect(count('MATCH (n:P WHERE n.k > 6) RETURN count(*) AS c')).toBe(18);
  });

  test('both spellings of one question agree', () => {
    expect(count('MATCH (n:P WHERE n.k > 6) RETURN count(*) AS c')).toBe(
      count('MATCH (n:P) WHERE n.k > 6 RETURN count(*) AS c'),
    );
  });
});
