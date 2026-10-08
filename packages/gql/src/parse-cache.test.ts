import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { gql, parseCacheStats, query } from './index.js';

// `query()` was `execute(parse(text, …), graph, params)` with no cache, so the same text was
// re-lexed, re-parsed and re-compiled on every call — roughly HALF the cost of a cheap indexed
// query, and the dominant term across the whole `bench:usage` serving surface (audit items 227,
// 228). It is now a bounded LRU of 64 parsed statements with a second-sighting admission filter.
//
//   read: point lookup              75.4k -> 194.2k ops/s   2.58x   (native 240.1k)
//   read: permission check          55.6k -> 132.8k         2.39x   (beats native 111.8k)
//   read: 2-hop recommendation      74.0k -> 172.2k         2.33x   (beats native 158.1k)
//
// THE CACHE IS MODULE-LEVEL AND SHARED ACROSS GRAPHS, which makes the tests below the safety
// property rather than a nicety. Reuse is sound only because a `Statement` is INERT — `execute`
// does not mutate it, parameters bind at execution, and graph state is read at execution — and
// each of those is pinned here, because a cache over an AST that `execute` annotated would return
// stale answers on the second call and every test that runs a query once would still pass.
describe('a cached statement is not a cached ANSWER', () => {
  const g = new Graph();

  for (let i = 0; i < 10; i++) {
    g.addVertex({ id: `u${i}`, labels: ['User'], properties: { k: i % 3 } });
  }

  const Q = 'MATCH (u:User) WHERE u.k = $k RETURN count(*) AS c';

  test('the same text with different params gives different answers', () => {
    // If params were baked into the cached form, the second call would repeat the first.
    expect(query(g, Q, { k: 0 })).toEqual([{ c: 4 }]);
    expect(query(g, Q, { k: 1 })).toEqual([{ c: 3 }]);
    expect(query(g, Q, { k: 0 })).toEqual([{ c: 4 }]);
  });

  test('repeated calls with the SAME params agree', () => {
    // Three calls so the admission filter has promoted the text and the third is a true hit.
    const a = query(g, Q, { k: 2 });

    expect(query(g, Q, { k: 2 })).toEqual(a);
    expect(query(g, Q, { k: 2 })).toEqual(a);
  });

  test('a cached text sees graph mutations made after it was parsed', () => {
    const before = Number(query(g, Q, { k: 0 })[0].c);

    g.addVertex({ id: 'later', labels: ['User'], properties: { k: 0 } });

    expect(Number(query(g, Q, { k: 0 })[0].c)).toBe(before + 1);
  });
});

describe('the cache is shared, so it must not leak one graph into another', () => {
  // The decisive property of a module-level cache: the same TEXT against two different graphs.
  const a = new Graph();
  const b = new Graph();

  a.addVertex({ id: 'a1', labels: ['T'], properties: { n: 1 } });
  a.addVertex({ id: 'a2', labels: ['T'], properties: { n: 2 } });
  b.addVertex({ id: 'b1', labels: ['T'], properties: { n: 9 } });

  const Q = 'MATCH (t:T) RETURN count(*) AS c';

  test('each graph answers for itself, interleaved', () => {
    for (let i = 0; i < 3; i++) {
      expect(query(a, Q)).toEqual([{ c: 2 }]);
      expect(query(b, Q)).toEqual([{ c: 1 }]);
    }
  });

  test('and a projection reads the right grapher values', () => {
    const PROJ = 'MATCH (t:T) RETURN t.n AS n ORDER BY n';

    expect(query(a, PROJ)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(query(b, PROJ)).toEqual([{ n: 9 }]);
    expect(query(a, PROJ)).toEqual([{ n: 1 }, { n: 2 }]);
  });
});

describe('maxOperatorChain is part of the hit condition', () => {
  test('the same text is re-parsed for a graph with a different chain limit', () => {
    // `parse` enforces the chain limit, so the same text is a DIFFERENT parse under a different
    // one. The cache stores the chain and verifies it on a hit; without that check the second
    // graph would silently reuse the first graph's parse and not raise.
    const generous = new Graph({ maxOperatorChain: 64 });
    const strict = new Graph({ maxOperatorChain: 2 });

    for (const g of [generous, strict]) {
      g.addVertex({ id: 'x', labels: ['T'], properties: { k: 1 } });
    }

    // A chain of ORs long enough to exceed the strict limit but not the generous one.
    const chain = Array.from({ length: 8 }, (_, i) => `t.k = ${i}`).join(' OR ');
    const Q = `MATCH (t:T) WHERE ${chain} RETURN count(*) AS c`;

    // Warm the cache on the generous graph FIRST, twice, so the text is promoted.
    expect(query(generous, Q)).toEqual([{ c: 1 }]);
    expect(query(generous, Q)).toEqual([{ c: 1 }]);

    // The strict graph must still refuse it.
    expect(() => query(strict, Q)).toThrow();

    // And the generous graph still works afterwards — the refusal must not have poisoned the entry.
    expect(query(generous, Q)).toEqual([{ c: 1 }]);
  });
});

describe('a failing parse is not remembered as a failure or a success', () => {
  const g = new Graph();

  g.addVertex({ id: 'x', labels: ['T'], properties: {} });

  test('a syntax error throws EVERY time, not just the first', () => {
    const BAD = 'MATCH (t:T) RETURN RETURN';

    for (let i = 0; i < 3; i++) {
      expect(() => query(g, BAD)).toThrow();
    }
  });

  test('and a good query after a bad one still works', () => {
    expect(() => query(g, 'MATCH (t:T) RETURN RETURN')).toThrow();
    expect(query(g, 'MATCH (t:T) RETURN count(*) AS c')).toEqual([{ c: 1 }]);
  });
});

describe('eviction past the cap changes no answer', () => {
  const g = new Graph();

  for (let i = 0; i < 20; i++) {
    g.addVertex({ id: `v${i}`, labels: ['T'], properties: { k: i } });
  }

  test('200 distinct texts, then the first one again', () => {
    // The cap is 64, so this evicts several times over. Each text is run TWICE so the admission
    // filter promotes it and the eviction path is actually exercised.
    const first = 'MATCH (t:T) WHERE t.k = 0 RETURN count(*) AS c';

    expect(query(g, first)).toEqual([{ c: 1 }]);

    for (let i = 1; i < 200; i++) {
      const q = `MATCH (t:T) WHERE t.k = ${i % 20} RETURN count(*) AS c0${i}`;

      query(g, q);
      query(g, q);
    }

    // Whether this hits or was evicted, the answer is the same — that is the whole requirement.
    expect(query(g, first)).toEqual([{ c: 1 }]);
    expect(query(g, first)).toEqual([{ c: 1 }]);
  });

  test('a text used once among many still answers correctly', () => {
    // The admission filter means this one is never cached. It must still be right.
    for (let i = 0; i < 100; i++) {
      // The alias varies with `i`, which is what makes each text distinct — so the result KEY
      // varies too.
      expect(query(g, `MATCH (t:T) WHERE t.k = ${i % 20} RETURN count(*) AS c1${i}`)).toEqual([
        { [`c1${i}`]: 1 },
      ]);
    }
  });
});

describe('the BOUND holds, which no answer-comparing test can see', () => {
  // Mutation made this necessary rather than nice: removing the eviction entirely changes no
  // ANSWER, so every test above passes while the cache grows without limit. A memory leak is
  // invisible to a correctness suite, so the bound needs its own check.
  const g = new Graph();

  g.addVertex({ id: 'x', labels: ['T'], properties: { k: 1 } });

  test('500 distinct texts, each run twice so every one is promoted', () => {
    const { cap } = parseCacheStats();

    for (let i = 0; i < 500; i++) {
      const q = `MATCH (t:T) WHERE t.k = 1 RETURN count(*) AS b${i}`;

      query(g, q);
      query(g, q);

      const { size, seen } = parseCacheStats();

      expect(size).toBeLessThanOrEqual(cap);
      expect(seen).toBeLessThanOrEqual(cap);
    }
  });

  test('and the cache is actually being used, so the bound is not vacuous', () => {
    // A bound of zero would also "hold". Run one text three times and require it to be resident.
    const q = 'MATCH (t:T) RETURN count(*) AS resident';

    query(g, q);
    query(g, q);
    query(g, q);

    expect(parseCacheStats().size).toBeGreaterThan(0);
  });

  test('single-sighting texts land in `seen`, not in the statement cache', () => {
    // Assert on `seen` rather than on `size`. By this point the statement cache is SATURATED at
    // the cap, so "size did not change" is true whether or not the admission filter exists — the
    // saturation hides the distinction, which is how a first-sight mutant survived until this was
    // written. `seen` growing is the filter's only direct observable.
    const before = parseCacheStats();

    for (let i = 0; i < 40; i++) {
      query(g, `MATCH (t:T) WHERE t.k = 1 RETURN count(*) AS once${i}`);
    }

    const after = parseCacheStats();

    expect(after.seen).toBeGreaterThan(0);
    expect(after.size).toBe(before.size);
  });
});

describe('the gql() template form caches on its stable text', () => {
  const g = new Graph();

  g.addVertex({ id: 'p1', labels: ['P'], properties: { name: 'ann' } });
  g.addVertex({ id: 'p2', labels: ['P'], properties: { name: 'bob' } });

  test('different substituted values give different answers', () => {
    // `${}` becomes a `$p0` BINDING, so the text is identical across calls — exactly the shape the
    // cache wants, and exactly the shape that would break if values were spliced into the text.
    const run = gql(g);

    expect(run`MATCH (p:P) WHERE p.name = ${'ann'} RETURN count(*) AS c`).toEqual([{ c: 1 }]);
    expect(run`MATCH (p:P) WHERE p.name = ${'bob'} RETURN count(*) AS c`).toEqual([{ c: 1 }]);
    expect(run`MATCH (p:P) WHERE p.name = ${'nobody'} RETURN count(*) AS c`).toEqual([{ c: 0 }]);
    expect(run`MATCH (p:P) WHERE p.name = ${'ann'} RETURN count(*) AS c`).toEqual([{ c: 1 }]);
  });

  test('the plain-string form of gql() agrees with query()', () => {
    const run = gql(g);
    const Q = 'MATCH (p:P) WHERE p.name = $n RETURN count(*) AS c';

    expect(run(Q, { n: 'bob' })).toEqual(query(g, Q, { n: 'bob' }));
    expect(run(Q, { n: 'ann' })).toEqual(query(g, Q, { n: 'ann' }));
  });
});
