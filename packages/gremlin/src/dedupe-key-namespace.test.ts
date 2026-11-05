import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { run } from './executor.js';
import { V, as_, dedupe, identity, inject, match, pipe, union, values } from './steps.js';
import { traversal } from './traversal.js';

/**
 * Item 1478 gave `tupleKey` a single-part fast path (1.10x on `match()`). Mutating it found that
 * **nothing in the suite distinguished an element key from a primitive one**: dropping the `@`
 * namespace from the part key — so a vertex whose id is `"5"` keys as `"5"`, exactly what
 * `JSON.stringify(5)` produces for the NUMBER 5 — survived all 1,258 tests.
 *
 * That prefix is the only thing keeping an element and a primitive apart in every keyed structure:
 * `dedupe()`'s composite set, `match()`'s candidate dedupe, and the multi-label `dedupe(a, b)`
 * tuple. A collision there silently DROPS a row — the right count with the wrong contents.
 *
 * ⚠️ `V()` may only be the FIRST step, so the mixed stream is built with `union(identity(), …)`
 * rather than `union(V(), …)`, which the planner rejects outright.
 */

/** One vertex whose id is the STRING '5' and whose property holds the NUMBER 5. */
const numericId = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: '5', labels: ['P'], properties: { k: 5 } });

  return g;
};

const out = (g: Graph, plan: Parameters<typeof run>[0]): unknown[] => [...run(plan, g)];

describe('an element key cannot collide with a primitive key', () => {
  test('a vertex with id "5" and the number 5 are TWO distinct traversers', () => {
    // Without the `@` namespace both key as "5" and dedupe drops one of them.
    const rows = out(numericId(), traversal(V(), union(identity(), values('k')), dedupe()));

    expect(rows).toHaveLength(2);
  });

  test('both survive, and they are one element and one number — not one of them twice', () => {
    const rows = out(numericId(), traversal(V(), union(identity(), values('k')), dedupe()));
    const kinds = rows
      .map((v) => (typeof v === 'object' && v !== null && 'id' in v ? 'element' : typeof v))
      .sort();

    expect(kinds).toEqual(['element', 'number']);
  });
});

describe("match()'s candidate dedupe is where the namespace is actually REACHABLE", () => {
  /**
   * ⚠️ `dedupe()` NEVER REACHES IT. Its `tupleKey` branch is guarded by an `isComposite` test —
   * arrays, plain objects and temporals — so a vertex is deduped by identity in a plain `Set` and
   * never keyed at all. That is why the dedupe tests above pass under a mutant that strips the
   * namespace, and why finding a killing case meant reading the guard rather than guessing.
   *
   * `match()` keys EVERY candidate through `tupleKey([o.value])` into one `Set<string>`, so an
   * inner traversal yielding both a vertex and a primitive is the reachable collision.
   */
  test('a candidate set mixing a vertex id "5" with the number 5 keeps BOTH branches', () => {
    const rows = out(
      numericId(),
      traversal(V(), match(pipe(as_('a'), union(identity(), values('k')), as_('b')))),
    );

    // One branch binds `b` to the vertex, one to the number. Collapsed to 1 without the prefix.
    expect(rows).toHaveLength(2);
  });
});

describe('…while a genuine repeat still collapses', () => {
  test('the same vertex twice dedupes to one', () => {
    const rows = out(numericId(), traversal(V(), union(identity(), identity()), dedupe()));

    expect(rows).toHaveLength(1);
  });

  test('the same number twice dedupes to one', () => {
    const rows = out(numericId(), traversal(inject(5), inject(5), dedupe()));

    expect(rows).toHaveLength(1);
  });

  test('two different numbers do not dedupe', () => {
    const rows = out(numericId(), traversal(inject(5), inject(6), dedupe()));

    expect(rows).toHaveLength(2);
  });
});
