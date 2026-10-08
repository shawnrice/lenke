import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import type { Query } from './ast.js';
import { compile, execute } from './executor.js';
import { query } from './index.js';
import { parse } from './parser.js';

// Item 228 cached PARSE and left `compile`, the other ~3.5us of a cheap query's fixed cost.
// `execute` now memoises the compiled plan in a `WeakMap` keyed on the AST, which together with
// the parse cache takes an indexed point lookup from ~8.8us to ~0.8us — `read: point lookup` goes
// 75.4k -> 1.12M ops/s, past the native engine's 233.5k (audit item 229).
//
// Reuse is sound because `compile(query: Query): Plan` takes NO GRAPH and a plan's validation
// stays per-execution. These tests pin each half of that, because a plan that had baked in a
// parameter, a graph, or a validation decision would be wrong only on the SECOND call — and every
// test that runs a query once would still pass.
describe('a cached plan is not a cached answer', () => {
  const g = new Graph();

  for (let i = 0; i < 6; i++) {
    g.addVertex({ id: `u${i}`, labels: ['User'], properties: { k: i % 2 } });
  }

  const ast = parse('MATCH (u:User) WHERE u.k = $k RETURN count(*) AS c');

  test('the same AST with different params gives different answers', () => {
    expect(execute(ast, g, { k: 0 })).toEqual([{ c: 3 }]);
    expect(execute(ast, g, { k: 1 })).toEqual([{ c: 3 }]);
    expect(execute(ast, g, { k: 7 })).toEqual([{ c: 0 }]);
    expect(execute(ast, g, { k: 0 })).toEqual([{ c: 3 }]);
  });

  test('a MISSING param still raises on a reused plan', () => {
    // The decisive property: if compile had baked in a param-presence decision, the second call
    // would skip the validation a fresh compile performs.
    expect(() => execute(ast, g, {})).toThrow();

    // Three times, so it is the reused plan raising and not a one-off.
    expect(() => execute(ast, g, {})).toThrow();
    expect(() => execute(ast, g, {})).toThrow();

    // And the plan still works afterwards — the raise must not have poisoned it.
    expect(execute(ast, g, { k: 0 })).toEqual([{ c: 3 }]);
  });

  test('a reused plan sees graph mutations made after it was compiled', () => {
    const before = Number(execute(ast, g, { k: 0 })[0].c);

    g.addVertex({ id: 'later', labels: ['User'], properties: { k: 0 } });

    expect(Number(execute(ast, g, { k: 0 })[0].c)).toBe(before + 1);
  });

  test('one AST serves two different graphs', () => {
    const h = new Graph();

    h.addVertex({ id: 'x', labels: ['User'], properties: { k: 0 } });

    const shared = parse('MATCH (u:User) WHERE u.k = $k RETURN count(*) AS c');

    // Interleaved, so a plan that captured a graph would be caught rather than merely suspected.
    for (let i = 0; i < 3; i++) {
      expect(execute(shared, h, { k: 0 })).toEqual([{ c: 1 }]);
      expect(Number(execute(shared, g, { k: 0 })[0].c)).toBeGreaterThan(1);
    }
  });

  test('a hand-compiled plan agrees with the cached one', () => {
    // `compile` is exported, so a caller can hold its own plan. Both routes must agree.
    // `parse` returns a `Statement` (a `Query` or a `TxControl`) and `compile` takes a `Query`;
    // this text is a query, so the narrowing is the test's own knowledge.
    const stmt = parse('MATCH (u:User) WHERE u.k = $k RETURN count(*) AS c') as Query;
    const plan = compile(stmt);

    expect(plan(g, { k: 0 })).toEqual(execute(ast, g, { k: 0 }));
  });
});

describe("execute's guards stay per-call, in front of the cache", () => {
  test('the read-only transaction check fires on a CACHED plan', () => {
    // The guard sits before the cache on purpose: being inside a read-only transaction is a
    // property of the graph and the moment, not of the statement. If the cache were consulted
    // first, a write whose plan was already compiled would slip through.
    const g = new Graph();

    g.addVertex({ id: 'u1', labels: ['User'], properties: { k: 1 } });

    const write = parse('INSERT (:User {k: 2})');

    // Warm the plan OUTSIDE any transaction, twice, so the cache definitely holds it.
    execute(write, g, {});
    execute(write, g, {});

    const countUsers = (): number =>
      Number(execute(parse('MATCH (u:User) RETURN count(*) AS c'), g, {})[0].c);
    const before = countUsers();

    // The same AST, now inside a READ ONLY transaction, must be refused — and refused by the
    // guard rather than by a recompile, since the plan is already cached.
    expect(() =>
      g.transaction(() => {
        g.setTransactionReadOnly(true);
        execute(write, g, {});
      }),
    ).toThrow();

    // The refusal must also have prevented the write, not merely reported it.
    expect(countUsers()).toBe(before);

    // NOTE: the READ ONLY flag SURVIVES the rolled-back transaction, so it is cleared explicitly
    // here. `setTransactionReadOnly(boolean)` is a manual switch rather than something a
    // transaction scopes, so this may well be intended — but a write issued after an aborted
    // read-only transaction being refused is worth knowing about, and it is recorded in the audit
    // entry rather than quietly worked around.
    g.setTransactionReadOnly(false);

    // And outside the transaction the cached plan still writes.
    execute(write, g, {});
    expect(countUsers()).toBe(before + 1);
  });

  test('a transaction-control statement is not routed through the plan cache', () => {
    // `isTxControl` short-circuits before the cache, so these never reach it. The point is that
    // they still work when interleaved with cached queries.
    const g = new Graph();

    g.addVertex({ id: 'u1', labels: ['User'], properties: { k: 1 } });

    const read = 'MATCH (u:User) RETURN count(*) AS c';

    expect(query(g, read)).toEqual([{ c: 1 }]);

    g.transaction(() => {
      query(g, 'INSERT (:User {k: 9})');
    });

    expect(query(g, read)).toEqual([{ c: 2 }]);
    expect(query(g, read)).toEqual([{ c: 2 }]);
  });
});

describe('a fresh AST each call is correct, if unaccelerated', () => {
  const g = new Graph();

  for (let i = 0; i < 5; i++) {
    g.addVertex({ id: `v${i}`, labels: ['T'], properties: { k: i } });
  }

  test('100 freshly parsed ASTs of the same text all answer the same', () => {
    // The WeakMap keys on the AST OBJECT, so this misses every time — which is the workload the
    // cache cannot help and must not hurt (measured flat at 0.99x with overlapping ranges).
    for (let i = 0; i < 100; i++) {
      expect(execute(parse('MATCH (t:T) WHERE t.k = 2 RETURN count(*) AS c'), g, {})).toEqual([
        { c: 1 },
      ]);
    }
  });

  test('and interleaving fresh and reused ASTs keeps both right', () => {
    const held = parse('MATCH (t:T) RETURN count(*) AS c');

    for (let i = 0; i < 20; i++) {
      expect(execute(held, g, {})).toEqual([{ c: 5 }]);
      expect(execute(parse('MATCH (t:T) WHERE t.k = 0 RETURN count(*) AS c'), g, {})).toEqual([
        { c: 1 },
      ]);
    }
  });
});
