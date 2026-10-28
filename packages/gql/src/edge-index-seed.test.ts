import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import type { CPredicate, EvalEnv } from './executor.js';
import { edgeSeek } from './executor/shortcuts.js';
import { query } from './index.js';

// Item 1035: a declared EDGE property index now seeds a GQL one-hop walk. It had been seeded by
// `@lenke/gremlin` all along and referenced nowhere in `@lenke/gql`, so the same question cost
// 0.025 ms through one surface and 1.0 ms through the other (item 1031).
//
// TWO KINDS OF TEST, AND THE SPLIT IS THE POINT. Seeding is ANSWER-PRESERVING — that is why it is
// allowed at all — so a mutant that simply never seeds returns every correct answer and survives
// any result-based test. `describe('the decision')` therefore calls `edgeSeek` DIRECTLY, which is
// the device items 172/173 used for `hopSeek` and the one `perf-gate-needs-its-own-test` records.
// `describe('the answers')` covers the ways the seed could be WRONG rather than merely unused.

/** A `CPredicate` carrying just the lifted equalities, which is what `edgeSeek` reads. */
const eqOn = (...pairs: [string, unknown][]): CPredicate => ({
  props: [],
  eqProps: pairs.map(([key, v]) => ({ key, value: () => v })),
});

const envOf = (g: Graph): EvalEnv => ({ binding: new Map(), params: {}, graph: g });

/** `n` `T` edges whose `k` cycles over `distinct` values, so one value is `n / distinct` of them. */
const fixture = (n: number, distinct: number, indexed: boolean): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'] });
  const b = g.addVertex({ id: 'b', labels: ['P'] });

  for (let i = 0; i < n; i++) {
    g.addEdge({ id: `e${i}`, from: a, to: b, labels: ['T'], properties: { k: i % distinct } });
  }

  if (indexed) {
    g.createIndex({ on: 'edge', kind: 'hash', keys: ['k'] });
  }

  return g;
};

describe('the decision — edgeSeek (item 1035)', () => {
  test('a SELECTIVE indexed equality seeds', () => {
    const g = fixture(8_000, 1_000, true);
    const seed = edgeSeek(g, undefined, eqOn(['k', 7]), ['T'], envOf(g));

    // 8 of 8,000 edges, so 1/1000 of the bucket — far inside the margin.
    expect(seed?.size).toBe(8);
  });

  test('an UNINDEXED key does not — the arm that says the win is the index', () => {
    const g = fixture(8_000, 1_000, false);

    expect(edgeSeek(g, undefined, eqOn(['k', 7]), ['T'], envOf(g))).toBeUndefined();
  });

  test('an UNSELECTIVE indexed equality does not — a seek wider than 1/8 of the bucket', () => {
    // 2 distinct values, so each is HALF the bucket. Seeking it would materialize 4,000 edges to
    // replace an 8,000-edge walk, which item 409's curve prices as a loss.
    const g = fixture(8_000, 2, true);

    expect(edgeSeek(g, undefined, eqOn(['k', 1]), ['T'], envOf(g))).toBeUndefined();
  });

  test('the NARROWEST of several indexed equalities wins', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'] });
    const b = g.addVertex({ id: 'b', labels: ['P'] });

    for (let i = 0; i < 8_000; i++) {
      g.addEdge({
        id: `e${i}`,
        from: a,
        to: b,
        labels: ['T'],
        properties: { wide: i % 10, narrow: i },
      });
    }

    g.createIndex({ on: 'edge', kind: 'hash', keys: ['wide'] });
    g.createIndex({ on: 'edge', kind: 'hash', keys: ['narrow'] });

    // `wide` is 800 edges and `narrow` is 1. Both are inside the margin, so the choice is visible
    // only in the size — which is exactly what a `count <` comparison mutated to `>` would break.
    const seed = edgeSeek(g, undefined, eqOn(['wide', 3], ['narrow', 11]), ['T'], envOf(g));

    expect(seed?.size).toBe(1);
  });

  test('a NULL value declines, because {k: null} also matches an ABSENT key', () => {
    const g = fixture(8_000, 1_000, true);

    // The index bucket for null holds only edges that STORE one, so seeding it would drop every
    // edge missing the key — a wrong answer, not a slower one.
    expect(edgeSeek(g, undefined, eqOn(['k', null]), ['T'], envOf(g))).toBeUndefined();
  });

  test('NO predicate on the rel declines', () => {
    const g = fixture(8_000, 1_000, true);

    expect(edgeSeek(g, undefined, undefined, ['T'], envOf(g))).toBeUndefined();
  });
});

describe('the answers — a seeded hop returns what the scan returned (item 1035)', () => {
  // BIG ENOUGH TO QUALIFY, and that is the whole reason for the size. The first version of this
  // block used a four-edge fixture, where `count * TALLY_SEEK_MARGIN < bucket` is false and the
  // seed DECLINES — so every assertion below passed without reaching the new code, and the
  // `drop-type-residual` mutant survived. A correctness fixture for a guarded route has to clear
  // the guard, which is checkable: `edgeSeek` is exported and the first test asserts it seeds.
  const g = (() => {
    const graph = new Graph();
    const a = graph.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });
    const b = graph.addVertex({ id: 'b', labels: ['Q'], properties: { n: 2 } });

    // 8,000 `T` edges, `w` cycling over 1,000 values, so `w = 1` is 8 of them.
    for (let i = 0; i < 8_000; i++) {
      graph.addEdge({ id: `t${i}`, from: a, to: b, labels: ['T'], properties: { w: i % 1_000 } });
    }

    // THE TYPE RESIDUAL'S EDGE: `w: 1` on a `U`, so a seed that forgets to re-apply the edge type
    // counts NINE where the scan counts eight. An index bucket is keyed by the property and knows
    // nothing about the label.
    graph.addEdge({ id: 'u1', from: a, to: b, labels: ['U'], properties: { w: 1 } });
    // And one `T` with the key ABSENT, for the null case.
    graph.addEdge({ id: 'tnull', from: a, to: a, labels: ['T'] });
    graph.createIndex({ on: 'edge', kind: 'hash', keys: ['w'] });

    return graph;
  })();
  const cnt = (q: string): unknown => (([...query(g, q)][0] ?? {}) as Record<string, unknown>).c;

  test('the fixture CLEARS THE GUARD — without this the rest proves nothing', () => {
    // 9 edges carry `w = 1` against a `T` bucket of 8,001, so the seed is admitted.
    expect(edgeSeek(g, undefined, eqOn(['w', 1]), ['T'], envOf(g))?.size).toBe(9);
  });

  test('the EDGE TYPE is still applied — the `U` with the same key must not count', () => {
    expect(cnt('MATCH ()-[e:T]->() WHERE e.w = 1 RETURN count(*) AS c')).toBe(8);
    expect(cnt('MATCH ()-[e:T {w: 1}]->() RETURN count(*) AS c')).toBe(8);
    // ...and asking for the `U` finds exactly the other one, so this is a filter and not a floor.
    expect(cnt('MATCH ()-[e:U]->() WHERE e.w = 1 RETURN count(*) AS c')).toBe(1);
  });

  test('an untyped hop counts every label', () => {
    expect(cnt('MATCH ()-[e]->() WHERE e.w = 1 RETURN count(*) AS c')).toBe(9);
  });

  test('an ENDPOINT LABEL is still applied on top of the seed', () => {
    expect(cnt('MATCH (x:P)-[e:T]->(y:Q) WHERE e.w = 1 RETURN count(*) AS c')).toBe(8);
    expect(cnt('MATCH (x:Q)-[e:T]->(y:P) WHERE e.w = 1 RETURN count(*) AS c')).toBe(0);
  });

  test('IS NULL still sees the edge with the key absent', () => {
    expect(cnt('MATCH ()-[e:T]->() WHERE e.w IS NULL RETURN count(*) AS c')).toBe(1);
    expect(cnt('MATCH ()-[e:T {w: null}]->() RETURN count(*) AS c')).toBe(1);
  });

  test('a value NO edge carries answers 0', () => {
    expect(cnt('MATCH ()-[e:T]->() WHERE e.w = 99_999 RETURN count(*) AS c')).toBe(0);
  });

  test('a REVERSED hop is the same edges from the other side', () => {
    expect(cnt('MATCH ()<-[e:T]-() WHERE e.w = 1 RETURN count(*) AS c')).toBe(8);
  });

  test('the two SPELLINGS of one question agree, which is why both are read', () => {
    expect(cnt('MATCH (x)-[e:T]->(y) WHERE e.w = 7 RETURN count(*) AS c')).toBe(8);
    expect(cnt('MATCH (x)-[e:T {w: 7}]->(y) RETURN count(*) AS c')).toBe(8);
  });
});
