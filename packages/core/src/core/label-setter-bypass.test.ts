import { describe, expect, test } from 'bun:test';

import { Graph } from './Graph.js';
import type { Vertex } from './Vertex.js';

/**
 * ⚠️⚠️ `v.labels = [...]` BYPASSES THE GRAPH'S LABEL MAINTENANCE, and three of the four things the
 * supported mutators do are skipped (item 1917). `addLabelToVertex` / `removeLabelFromVertex` each
 * call `indexVertexLabel` / `deIndexVertexLabel`, `emit(...)`, the constraint checks and
 * `recordUndo(...)` before `commitElementLabels`. The setter calls `commitElementLabels` alone — or
 * writes the label box directly, a shortcut its own comment records as taken for speed (a
 * 200,000-element re-write measured 32.0 ms through the funnel against 29.9 ms for the box).
 *
 * The three divergences, measured:
 *
 *     verticesByLabel T after T->U     setter 2 (STALE)   methods 1
 *     events emitted                   setter []          methods ["removed","added"]
 *     labels after a ROLLED BACK tx    setter ["U"]       methods ["T"]
 *
 * ⚠️ THE FIRST IS A REPRODUCIBLE WRONG ANSWER THROUGH THE PUBLIC API, not a theoretical staleness.
 * `effectiveLabel` in the GQL engine drops a label test when the label is carried by EVERY vertex,
 * decided per execution from `verticesByLabel.get(l).size === vertexCount`. After one setter call
 * that read can still say "vacuous" when it is not, so the test is dropped and rows that should not
 * match do. `labelelision-wrongans-1917.mjs` in `packages/native` shows it end to end:
 * `MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T)` over a 6-chain answers **4 rows where the truth is 1**,
 * after `v3.labels = ['U']` — and `v3.hasLabel('T')` is `false` at the time, so the vertex itself is
 * correct and only the index is not.
 *
 * ⚠️ AND THE THIRD IS A TRANSACTION VIOLATION, which is arguably the worse of the two: a label
 * written inside a transaction that then ABORTS is still there afterwards, because the setter never
 * records an undo entry. The undo log is built from closures over the public mutators, and the
 * setter is not one of them.
 *
 * These are `test.failing` rather than fixed here because the fix changes PUBLIC API SEMANTICS —
 * routing the setter through the mutators would start emitting events on a plain assignment and
 * would make the write slower, which is an owner decision rather than a bug fix to be slipped in.
 * ⚠️ `test.failing` INVERTS: when the setter is fixed, these FAIL and must be flipped to `test`.
 * That is the point — the suite tells you the day the gap closes.
 */
const seed = (): { g: Graph; a: Vertex } => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['T'], properties: {} });

  g.addVertex({ id: 'b', labels: ['T'], properties: {} });

  return { g, a };
};

describe('the labels setter against the supported mutators', () => {
  test('the SUPPORTED mutators maintain verticesByLabel — the control for the three below', () => {
    const { g, a } = seed();

    expect(g.verticesByLabel.get('T')?.size).toBe(2);

    g.removeLabelFromVertex('T', a);
    g.addLabelToVertex('U', a);

    expect(g.verticesByLabel.get('T')?.size).toBe(1);
    expect(g.verticesByLabel.get('U')?.size).toBe(1);
    expect(a.hasLabel('T')).toBe(false);
  });

  test('the setter does update the VERTEX, which is why the staleness is easy to miss', () => {
    const { a } = seed();

    a.labels = ['U'];

    // The element is entirely correct — this is not a broken setter, it is an unmaintained index.
    expect(a.hasLabel('U')).toBe(true);
    expect(a.hasLabel('T')).toBe(false);
    expect([...a.labels]).toEqual(['U']);
  });

  test.failing('the setter should maintain verticesByLabel (item 1917)', () => {
    const { g, a } = seed();

    a.labels = ['U'];

    // Reads 2 today: `T` still looks VACUOUS (size === vertexCount) though `a` no longer has it,
    // which is exactly what makes `effectiveLabel` drop a test it must keep.
    expect(g.verticesByLabel.get('T')?.size ?? 0).toBe(1);
    expect(g.verticesByLabel.get('U')?.size ?? 0).toBe(1);
  });

  test.failing('the setter should emit label events (item 1917)', () => {
    const { g, a } = seed();
    const seen: string[] = [];

    g.on('@graph/LabelAddedToVertex', () => seen.push('added'));
    g.on('@graph/LabelRemovedFromVertex', () => seen.push('removed'));

    a.labels = ['U'];

    // Emits nothing today, so an observer cannot see a label change made this way.
    expect(seen.length).toBeGreaterThan(0);
  });

  test.failing('a setter write inside an ABORTED transaction should roll back (item 1917)', () => {
    const { g, a } = seed();

    try {
      g.transaction(() => {
        a.labels = ['U'];

        throw new Error('abort');
      });
    } catch {
      // the abort is the point
    }

    // Reads ['U'] today: the write survives a transaction that threw, because the setter records
    // no undo entry. The supported mutators restore ['T'] here.
    expect([...a.labels]).toEqual(['T']);
  });
});
