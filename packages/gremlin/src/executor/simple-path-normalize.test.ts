import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import {
  V,
  count,
  cyclicPath,
  in_,
  limit,
  out,
  outE,
  inV,
  simplePath,
  toArray,
  traversal,
  values,
} from '../index.js';
import { normalizeDepth1SimplePath } from './index.js';

/**
 * `V().out(T).simplePath()` rewritten to `V().as_(t).out(T).where(neq(t))` — item 1912's already
 * fused shape — because at depth one `simplePath` is "near !== far", the hop minus its self-loops.
 *
 *     pathdep: simplePath   308.81 -> 37.81 ms   <- 8.17x, 599,998 rows
 *
 * THAT LANDS BELOW THE PLAIN HOP'S 50.21, WHICH LOOKS WRONG AND IS NOT: item 1913 measured
 * exactly this fused shape at 38.96 against the hop control's 41.18 and noted it "should always have
 * been below — it reads the same properties minus the self-loops". The rewrite lands on an
 * independently measured number.
 *
 * THE STEP IS A PURE FILTER AND THE ROW SHAPE IS THE PLAIN HOP'S, read off the engine rather than
 * assumed (`pathfam-shape-1923.mjs`): `V().out(E).simplePath()` yields the FAR VERTICES `b, c` where
 * `V().out(E)` yields `b, c, d` and `d` is the self-loop.
 */
const fixture = (): Graph => {
  const g = new Graph();

  for (const id of ['a', 'b', 'c', 'd']) {
    g.addVertex({ id, labels: ['P'], properties: { n: id } });
  }

  const vx = (id: string): Vertex => g.getVertexById(id) as Vertex;

  g.addEdge({ id: 'e1', from: vx('a'), to: vx('b'), labels: ['E'], properties: {} });
  g.addEdge({ id: 'e2', from: vx('b'), to: vx('c'), labels: ['E'], properties: {} });
  // THE SELF-LOOP IS THE WHOLE DISCRIMINATION at depth one: without it `simplePath` and the plain
  // hop agree and every assertion below passes for the wrong reason.
  g.addEdge({ id: 'e3', from: vx('d'), to: vx('d'), labels: ['E'], properties: {} });
  g.addEdge({ id: 'e4', from: vx('a'), to: vx('c'), labels: ['F'], properties: {} });

  return g;
};

const ids = (rows: readonly unknown[]): string[] => rows.map((v) => String((v as Vertex)?.id ?? v));

describe('the depth-1 simplePath rewrite', () => {
  it('rewrites to the tagged neq shape and clears readsPath', () => {
    const p = normalizeDepth1SimplePath(traversal(V(), out('E'), simplePath()));

    expect(p.steps.map((s) => s.kind)).toStrictEqual(['V', 'as', 'out', 'where']);
    // THE WHOLE POINT: the original is path-dependent and so reaches no rung; the rewrite is not.
    expect(p.readsPath).toBe(false);
  });

  /**
   * THE TRAILING `values(k)` FORM IS WHAT THE SCREEN MEASURES, which is item 1912's own lesson —
   * a four-step rung won 17.6x in isolation there and left the screen's rows untouched, because the
   * screen's spellings carry a fifth step. Without this the 8.17x would not have reached the row.
   */
  it('passes a trailing single-key values through', () => {
    const p = normalizeDepth1SimplePath(traversal(V(), out('E'), simplePath(), values('n')));

    expect(p.steps.map((s) => s.kind)).toStrictEqual(['V', 'as', 'out', 'where', 'values']);
    expect(p.readsPath).toBe(false);
  });

  it('refuses every other shape', () => {
    const same = (plan: ReturnType<typeof traversal>): void => {
      // Returned BY IDENTITY, not as an equal copy — a pass that rebuilt every plan pays for nothing.
      expect(normalizeDepth1SimplePath(plan)).toBe(plan);
    };

    // DEPTH TWO IS A DIFFERENT TEST: it needs all THREE elements distinct, not just the ends.
    same(traversal(V(), out('E'), out('E'), simplePath()));
    // `cyclicPath` IS THE COMPLEMENT, so it needs `where(eq(t))` — which item 1912's rung
    // explicitly declines. Rewriting into a shape that then declines would add a step for nothing.
    same(traversal(V(), out('E'), cyclicPath()));
    // `both`/multi-type/untyped: `soleTypeBucket` refuses them and the rung follows it.
    same(traversal(V(), out('E', 'F'), simplePath()));
    same(traversal(V(), out(), simplePath()));
    // An edge step in between makes the path three long, so "near !== far" is not the question.
    same(traversal(V(), outE('E'), inV(), simplePath()));
    // A multi-key or keyless `values` is a different projection shape.
    same(traversal(V(), out('E'), simplePath(), values('n', 'k')));
    same(traversal(V(), out('E'), simplePath(), values()));
    // Anything else trailing.
    same(traversal(V(), out('E'), simplePath(), count()));
    same(traversal(V(), out('E'), simplePath(), limit(9)));
    // `V(id, …)` enumerates a given set rather than the whole graph.
    same(traversal(V('a'), out('E'), simplePath()));

    /*
     * FIVE STEPS AND SIX, WHICH A MUTANT IS WHY — and it is item 1912's own finding repeating
     * in the same module family. Loosening the length gate to `steps.length < 3` SURVIVED every
     * other assertion here: the depth-TWO case it looks like it admits is actually refused by the
     * `tail.kind !== 'simplePath'` check below, because the fourth step is then the second `out`.
     *
     * What the length gate really protects is a plan LONGER than the rewrite can carry: with the
     * mutant, `[V, out, simplePath, values, count]` destructures to the first four and the FIFTH
     * step is silently DROPPED — 599,998 rows where the query asked for one. Item 1912 recorded the
     * identical hole ("nothing reached the case where the fifth step IS a values and a SIXTH is
     * silently dropped — 800,000 rows where the query asked for two").
     */
    same(traversal(V(), out('E'), simplePath(), values('n'), count()));
    same(traversal(V(), out('E'), simplePath(), values('n'), limit(5)));
    same(traversal(V(), out('E'), simplePath(), values('n'), values('n')));
    // And a plan with no simplePath at all.
    same(traversal(V(), out('E'), values('n')));
  });
});

describe('the answer is unchanged', () => {
  it('simplePath is the hop minus its self-loops, spelled out', () => {
    const g = fixture();

    expect(ids(toArray(traversal(V(), out('E')), g))).toStrictEqual(['b', 'c', 'd']);
    expect(ids(toArray(traversal(V(), out('E'), simplePath()), g))).toStrictEqual(['b', 'c']);
    expect(ids(toArray(traversal(V(), out('E'), cyclicPath()), g))).toStrictEqual(['d']);
  });

  /**
   * AND THEY PARTITION THE HOP, which is the arithmetic a wrong filter would break while still
   * returning a plausible count.
   */
  it('simplePath and cyclicPath partition the hop', () => {
    const g = fixture();
    const plain = toArray(traversal(V(), out('E')), g).length;
    const simple = toArray(traversal(V(), out('E'), simplePath()), g).length;
    const cyclic = toArray(traversal(V(), out('E'), cyclicPath()), g).length;

    expect(simple + cyclic).toBe(plain);
  });

  it('agrees with the generic path for every admitted spelling', () => {
    const g = fixture();
    const agree = (steps: readonly unknown[]): void => {
      const fused = toArray(traversal(V(), ...(steps as never[])), g);
      // `limit` above the row count makes the plan one step too long, so the gate refuses.
      const generic = toArray(traversal(V(), ...(steps as never[]), limit(9999)), g);

      expect(ids(fused)).toStrictEqual(ids(generic));
    };

    agree([out('E'), simplePath()]);
    agree([in_('E'), simplePath()]);
    agree([out('F'), simplePath()]);
    agree([out('E'), simplePath(), values('n')]);
    agree([out('NOPE'), simplePath()]);
  });

  it('incoming reads the other end', () => {
    const g = fixture();

    // Reading the three E edges backwards: b<-a gives a, b<-b is the self-loop (dropped), c<-b
    // gives b.
    expect(ids(toArray(traversal(V(), in_('E'), simplePath()), g))).toStrictEqual(['a', 'b']);
  });

  it('and the trailing values projects the far vertex', () => {
    const g = fixture();

    expect(toArray(traversal(V(), out('E'), simplePath(), values('n')), g)).toStrictEqual([
      'b',
      'c',
    ]);
  });

  /** The refused shapes keep answering, with the layout the probe recorded. */
  it('a FIFTH step is never dropped', () => {
    const g = fixture();

    // The answer a mutant that dropped it would get wrong: one row, not two.
    expect(toArray(traversal(V(), out('E'), simplePath(), values('n'), count()), g)).toStrictEqual([
      2,
    ]);
    expect(toArray(traversal(V(), out('E'), simplePath(), values('n'), limit(1)), g)).toStrictEqual(
      ['b'],
    );
  });

  it('the refused shapes are untouched', () => {
    const g = fixture();

    expect(ids(toArray(traversal(V(), out('E'), out('E'), simplePath()), g))).toStrictEqual(['c']);
    expect(ids(toArray(traversal(V(), outE('E'), inV(), simplePath()), g))).toStrictEqual([
      'b',
      'c',
    ]);
    expect(toArray(traversal(V(), out('E'), simplePath(), count()), g)).toStrictEqual([2]);
  });
});
