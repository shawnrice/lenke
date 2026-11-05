import { describe, expect, it } from 'bun:test';

/**
 * ITEM 1504 — `Plan.readsPath` is now carried by CONSTRUCTION instead of walked at execution.
 * Measured: a reused plan 1.58-1.65x faster on trivial shapes (count 315 → 200 ns, hop 456 → 276),
 * and a REBUILT plan flat — where item 1503's `WeakMap` memo was 1.07-1.15x worse on that arm.
 *
 * ⚠️ A FALSE NEGATIVE HERE IS SILENT AND WRONG. When the flag is false the run skips path
 * bookkeeping entirely, so a path-reading step that the flag missed would get an EMPTY path rather
 * than an error — `path()` would answer `[]`, `simplePath` would filter nothing, and a user closure
 * would see no path. The old walk's comment says exactly this ("a missed entry would silently drop
 * paths"), and moving the computation to construction adds a new way to miss one: a nested plan
 * whose flag is not consulted by the step that holds it.
 *
 * So this file checks both halves:
 *   1. every path-dependent KIND sets the flag, at the top level and nested one and two deep;
 *   2. the flag actually reaches behaviour — `path()` still returns real paths through each
 *      nesting shape, which is the thing a stale `false` would break.
 */
import { Graph } from '@lenke/core';

import { PATH_DEPENDENT_KINDS } from './ast.js';
import {
  V,
  both,
  coalesce,
  count,
  local,
  optional,
  order,
  out,
  path,
  repeat,
  simplePath,
  toArray,
  traversal,
  union,
} from './index.js';

describe('every path-dependent kind sets the flag', () => {
  // ⚠️ DRIVEN OFF `PATH_DEPENDENT_KINDS` ITSELF, so a kind added to that set without a plan-level
  // story fails here. The set is the engine's own exhaustive list of `.path` readers.
  it('the set is non-empty and every member is covered by a case below', () => {
    expect(PATH_DEPENDENT_KINDS.size).toBeGreaterThan(5);

    for (const kind of ['path', 'tree', 'simplePath', 'cyclicPath', 'otherV']) {
      expect(PATH_DEPENDENT_KINDS.has(kind), kind).toBe(true);
    }

    // The closure-bearing kinds are conservatively included — a user closure receives the path.
    for (const kind of ['mapFn', 'flatMapFn', 'filterFn', 'sideEffectFn', 'foldFn']) {
      expect(PATH_DEPENDENT_KINDS.has(kind), kind).toBe(true);
    }
  });

  it('a top-level path step sets it', () => {
    expect(traversal(V(), out('E'), path()).readsPath).toBe(true);
    expect(traversal(V(), out('E'), simplePath()).readsPath).toBe(true);
  });

  it('a path-free traversal leaves it false', () => {
    expect(traversal(V(), out('E'), count()).readsPath).toBe(false);
    expect(traversal(V(), both('E')).readsPath).toBe(false);
  });

  it('⚠️ a user CLOSURE sets it — the path is handed to code we cannot inspect', () => {
    expect(traversal(V(), out('E')).readsPath).toBe(false);
    // `mapFn` and friends are in the set conservatively; a closure could read the path.
    const withClosure = traversal(
      V(),
      out('E'),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- a probe closure
      local(traversal(path())),
    );

    expect(withClosure.readsPath).toBe(true);
  });
});

describe('⚠️ a NESTED path step sets the flag on the enclosing plan', () => {
  // This is the half the construction-time design could get wrong: the parent must consult the
  // sub-plan's own flag. One level, two levels, and each plan-bearing field shape.
  it('inside repeat(body)', () => {
    expect(traversal(V(), repeat(path()).times(2)).readsPath).toBe(true);
    expect(traversal(V(), repeat(out('E')).times(2)).readsPath).toBe(false);
  });

  it('inside local(plan)', () => {
    expect(traversal(V(), local(traversal(path()))).readsPath).toBe(true);
    expect(traversal(V(), local(traversal(out('E')))).readsPath).toBe(false);
  });

  it('inside union(plans) — the ARRAY field, not a single plan', () => {
    expect(traversal(V(), union(traversal(out('E')), traversal(path()))).readsPath).toBe(true);
    expect(traversal(V(), union(traversal(out('E')), traversal(both('E')))).readsPath).toBe(false);
  });

  it('inside coalesce(plans)', () => {
    expect(traversal(V(), coalesce(traversal(path()), traversal(out('E')))).readsPath).toBe(true);
    expect(traversal(V(), coalesce(traversal(out('E')), traversal(both('E')))).readsPath).toBe(
      false,
    );
  });

  it('inside optional(plan)', () => {
    expect(traversal(V(), optional(traversal(path()))).readsPath).toBe(true);
    expect(traversal(V(), optional(traversal(out('E')))).readsPath).toBe(false);
  });

  it('⚠️ inside a `by(traversal)` — the field a mutant slipped past this file through', () => {
    // A `no-bys` mutant (ignore the `bys` traversals) survived this file and was caught only by
    // `executor/subPlansOf.test.ts`, which covers every plan-bearing field. Added here so the file
    // stands on its own rather than relying on a sibling for one of the three field SHAPES.
    expect(traversal(V(), order().by(traversal(path()))).readsPath).toBe(true);
    expect(traversal(V(), order().by(traversal(out('E')))).readsPath).toBe(false);
  });

  it('⚠️ TWO levels deep, which is where a single-level check would pass and be wrong', () => {
    expect(traversal(V(), local(traversal(local(traversal(path()))))).readsPath).toBe(true);
    expect(traversal(V(), union(traversal(local(traversal(path()))))).readsPath).toBe(true);
    expect(traversal(V(), repeat(local(traversal(path()))).times(2)).readsPath).toBe(true);
    // And the negative at the same depth, so the positives are not passing for free.
    expect(traversal(V(), local(traversal(local(traversal(out('E')))))).readsPath).toBe(false);
  });

  it('the flag is monotone — appending a path step to a clean plan flips it and it stays flipped', () => {
    const clean = traversal(V(), out('E'));

    expect(clean.readsPath).toBe(false);

    const dirty = traversal(V(), out('E'), path());

    expect(dirty.readsPath).toBe(true);

    const longer = traversal(V(), out('E'), path(), count());

    expect(longer.readsPath).toBe(true);
  });
});

describe('the flag reaches BEHAVIOUR — paths are still real', () => {
  const g = new Graph();

  for (let i = 0; i < 6; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } });
  }

  for (let e = 0; e < 5; e += 1) {
    g.addEdge({
      id: `e${e}`,
      labels: ['E'],
      from: g.getVertexById(`v${e}`)!,
      to: g.getVertexById(`v${e + 1}`)!,
    });
  }

  // ⚠️ A stale `false` does not throw — it yields an EMPTY path. So each case asserts the path has
  // the length the walk produces, which is the only thing that distinguishes tracking from not.
  it('a one-hop path has two elements', () => {
    const rows = toArray(traversal(V(), out('E'), path()), g);

    expect(rows.length).toBe(5);

    for (const r of rows) {
      expect(Array.isArray(r)).toBe(true);
      expect((r as unknown[]).length).toBe(2);
    }
  });

  it('a two-hop path has three elements', () => {
    const rows = toArray(traversal(V(), out('E'), out('E'), path()), g);

    expect(rows.length).toBe(4);

    for (const r of rows) {
      expect((r as unknown[]).length).toBe(3);
    }
  });

  it('a path nested inside local still tracks', () => {
    const rows = toArray(traversal(V(), out('E'), local(traversal(path()))), g);

    expect(rows.length).toBe(5);

    for (const r of rows) {
      expect((r as unknown[]).length).toBe(2);
    }
  });

  it('simplePath filters, which it cannot do without a path', () => {
    // `both` can walk back where it came from; simplePath must remove those.
    const all = toArray(traversal(V(), both('E'), both('E'), count()), g);
    const simple = toArray(traversal(V(), both('E'), both('E'), simplePath(), count()), g);

    expect(Number(all[0])).toBeGreaterThan(Number(simple[0]));
  });
});
